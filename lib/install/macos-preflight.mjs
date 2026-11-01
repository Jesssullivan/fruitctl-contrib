// SPDX-License-Identifier: MIT
// Read-only macOS target preflight for `fruitctl doctor --macos`.
//
// One fixed POSIX script runs over SSH on the Darwin target and prints
// delimited sections. Every section is interpreted by a pure parser below, so
// fixtures cover the policy offline. The script reads only named keys,
// filtered service state and a process list filtered on the target to exact
// remote-desktop names: no environment, credentials, TCC prompts, GUI
// launches, service or setting changes, or Apple log scans.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { loadConfig, validInputSource } from '../broker/paths.mjs';

export const PREFLIGHT_SCHEMA = 'fruitctl.macos-preflight.v1';
export const HOST_BUNDLE_ID = 'com.xoxd.fruitctl.host';
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 30000;
// Same character set as the host-helper sshHost validator (bracketed IPv6
// allowed), plus the relay's leading underscore. A leading '-' is refused, and
// the destination is passed after `--` as one argv entry, never through a shell.
const SSH_DESTINATION = /^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]{0,255}$/;
// macOS short account names; anything else (spaces, quotes, leading '-') is
// not passed to the target and its privileges are reported unknown.
const ACCOUNT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

// D9: macOS 26 and 27 only. CVE-2026-65400 (screensharingd SRP pre-auth
// bypass, CISA KEV) bypasses every Screen Sharing authentication mode.
const SCREEN_SHARING_ADVISORY = 'CVE-2026-65400';
export const SUPPORTED_MACOS = Object.freeze({
  26: Object.freeze({ floor: '26.6.1', source: 'https://support.apple.com/en-us/148170' }),
  27: Object.freeze({ floor: '27.0', source: 'https://support.apple.com/en-us/149035' }),
});

// From the kickstart privilege table shipped on macOS 26.7.1.
export const ARD_PRIVILEGES = Object.freeze({ controlObserve: 0x2, observeOnly: 0x100 });

// D14: one input owner per Mac. Exact executable basenames of other remote
// desktop hosts, never substrings. Apple's CoreParsec also runs a `parsecd`,
// so Parsec counts only from inside Parsec.app; an assertion holder carries no
// path and cannot name Parsec.
export const REMOTE_INPUT_OWNERS = Object.freeze([
  { owner: 'Chrome Remote Desktop', names: ['remoting_me2me_host', 'ChromeRemoteDesktopHost'] },
  { owner: 'TeamViewer', names: ['TeamViewer', 'TeamViewer_Service', 'TeamViewer_Desktop'] },
  { owner: 'AnyDesk', names: ['AnyDesk'] },
  { owner: 'Parsec', names: ['parsecd'], appPath: '/Parsec.app/' },
  { owner: 'Splashtop', names: ['Splashtop Streamer', 'SRStreamer', 'SRServiceAgent'] },
  { owner: 'RustDesk', names: ['RustDesk', 'rustdesk'] },
  { owner: 'Jump Desktop', names: ['Jump Desktop Connect'] },
  { owner: 'Sunshine', names: ['Sunshine', 'sunshine'] },
].map(entry => Object.freeze({ ...entry, names: Object.freeze(entry.names) })));
const OWNER_NAMES = REMOTE_INPUT_OWNERS.flatMap(entry => entry.names);

// D12 Fruitctl-ready target profile: the console user's preference keys read
// on the target, grouped by domain. `byhost` keys are read with -currentHost.
const PROFILE_KEYS = Object.freeze([
  ['user', 'com.apple.WindowManager', ['GloballyEnabled', 'EnableStandardClickToShowDesktop']],
  ['user', 'com.apple.dock', ['mru-spaces', 'wvous-tl-corner', 'wvous-tr-corner', 'wvous-bl-corner', 'wvous-br-corner']],
  ['user', 'NSGlobalDomain', ['_HIHideMenuBar', 'AppleMenuBarVisibleInFullscreen', 'AppleInterfaceStyle',
    'AppleInterfaceStyleSwitchesAutomatically', 'ApplePressAndHoldEnabled', 'NSAutomaticQuoteSubstitutionEnabled',
    'NSAutomaticDashSubstitutionEnabled', 'NSAutomaticSpellingCorrectionEnabled', 'NSAutomaticCapitalizationEnabled',
    'NSAutomaticPeriodSubstitutionEnabled', 'CGDisableCursorLocationMagnification']],
  ['user', 'com.apple.universalaccess', ['reduceTransparency']],
  ['byhost', 'com.apple.coreservices.useractivityd', ['ActivityAdvertisingAllowed', 'ActivityReceivingAllowed']],
]);

const SECTIONS = ['sw_vers', 'arch', 'console', 'screensharing_override', 'screensharing_service',
  'remote_management_marker', 'remote_management_prefs', 'vnc_naprivs', 'ioreg_console',
  'secure_input_process', 'pmset_assertions', 'pmset_settings', 'displays', 'host_app', 'tcc',
  'remote_input_processes', 'target_profile', 'input_sources'];

export function usableAccountName(value) {
  return typeof value === 'string' && ACCOUNT_NAME.test(value) ? value : undefined;
}

// Read-only shell fragments shared by doctor's probe and the broker's
// desktop-state sentinel (lib/broker/desktop-state.mjs). Each section is
// framed by begin/end markers that parseProbeOutput reads.
export const PROBE_PRELUDE = String.raw`PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH; LC_ALL=C; export LC_ALL
begin() { printf '\n@@fruitctl-probe %s@@\n' "$1"; }
end() { printf '\n@@fruitctl-status %s %s@@\n' "$1" "$2"; }
`;
// Sets $console_user (empty unless a plain short name) and $ssh_user.
export const PROBE_CONSOLE = String.raw`console_user=$(stat -f%Su /dev/console 2>/dev/null)
case "$console_user" in ''|-*|*[!A-Za-z0-9._-]*) console_user= ;; esac
begin console; printf '%s\n' "$console_user"; end console 0
ssh_user=$(id -un 2>/dev/null)
`;
// IOConsoleUsers/IOConsoleLocked, and the Secure Input holder named there.
export const PROBE_SESSION = String.raw`console_ioreg=$(ioreg -w 0 -d 1 -k IOConsoleUsers 2>/dev/null | grep -E '"IOConsole(Users|Locked)" = ')
begin ioreg_console; printf '%s\n' "$console_ioreg"; end ioreg_console 0
begin secure_input_process
printf '%s\n' "$console_ioreg" | grep -o '"kCGSSessionSecureInputPID"=[0-9][0-9]*' | sed 's/.*=//' | head -n 8 | while read -r pid; do
  printf 'pid=%s|%s\n' "$pid" "$(ps -o comm= -p "$pid" 2>/dev/null)"
done
end secure_input_process 0
`;
export const PROBE_ASSERTIONS = String.raw`begin pmset_assertions; pmset -g assertions 2>/dev/null; end pmset_assertions $?
`;
// D14 other remote-input owners: only exact basenames leave the target.
export const PROBE_REMOTE_INPUT = String.raw`begin remote_input_processes
if processes=$(ps -axww -o comm= 2>/dev/null); then
  printf 'read=ok\n'
  printf '%s\n' "$processes" | grep -E '(^|/)(${OWNER_NAMES.join('|')})$' | sort -u | head -n 32
else printf 'read=failed\n'; fi
end remote_input_processes 0
`;

const PROBE_BODY = String.raw`case "$vnc_user" in ''|-*|*[!A-Za-z0-9._-]*) vnc_user= ;; esac
begin sw_vers; sw_vers 2>/dev/null; end sw_vers $?
begin arch; uname -m 2>/dev/null; end arch $?
${PROBE_CONSOLE}console_home=
case "$console_user" in ''|root) ;; *) console_home=$(dscl . -read "/Users/$console_user" NFSHomeDirectory 2>/dev/null | sed -n 's/^NFSHomeDirectory: //p' | head -n 1) ;; esac
case "$console_home" in /*) ;; *) console_home= ;; esac
begin screensharing_override
if disabled_services=$(launchctl print-disabled system 2>/dev/null); then
  printf 'read=ok\n'; printf '%s\n' "$disabled_services" | grep -F '"com.apple.screensharing"'
else printf 'read=failed\n'; fi
end screensharing_override 0
begin screensharing_service; launchctl print system/com.apple.screensharing 2>/dev/null | grep -E "^$(printf '\t')(state|runs|last exit code) = "; end screensharing_service $?
begin remote_management_marker
marker="/Library/Application Support/Apple/Remote Desktop/RemoteManagement.launchd"
if [ ! -e "$marker" ]; then printf 'absent\n'
elif marker_value=$(head -c 64 "$marker" 2>/dev/null); then printf 'value=%s\n' "$marker_value"
else printf 'unreadable\n'; fi
end remote_management_marker 0
begin remote_management_prefs
ard_prefs=/Library/Preferences/com.apple.RemoteManagement
if defaults read "$ard_prefs" >/dev/null 2>&1; then printf 'read=ok\n'; else printf 'read=failed\n'; fi
for key in ARD_AllLocalUsers ARD_AllLocalUsersPrivs VNCLegacyConnectionsEnabled ScreenSharingReqPermEnabled; do
  if value=$(defaults read "$ard_prefs" "$key" 2>/dev/null); then printf '%s=%s\n' "$key" "$value"
  else printf '%s=absent\n' "$key"; fi
done
end remote_management_prefs 0
begin vnc_naprivs
if [ -z "$vnc_user" ]; then printf 'user=unset\n'
elif record=$(dscl . -read "/Users/$vnc_user" naprivs 2>/dev/null) && [ -n "$record" ]; then printf '%s\n' "$record"
else printf 'naprivs=unreadable\n'; fi
end vnc_naprivs 0
${PROBE_SESSION}${PROBE_ASSERTIONS}begin pmset_settings; pmset -g 2>/dev/null; end pmset_settings $?
begin displays
system_profiler -detailLevel mini SPDisplaysDataType 2>/dev/null | sed -n 's/^        \([^ ].*\):$/display=\1/p; s/^ *Online: /online=/p; s/^ *Virtual Device: /virtual=/p'
end displays $?
begin host_app
for scope in user system; do
  if [ "$scope" = system ]; then app=/Applications/FruitctlHost.app; parent=/Applications
  elif [ -n "$console_home" ]; then app="$console_home/Applications/FruitctlHost.app"; parent="$console_home/Applications"
  else printf 'user|unknown\n'; continue; fi
  if [ -d "$app" ]; then
    printf '%s|present|%s|%s\n' "$scope" "$(defaults read "$app/Contents/Info" CFBundleIdentifier 2>/dev/null)" "$(defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null)"
  elif [ -e "$parent" ] && [ ! -x "$parent" ]; then printf '%s|unknown\n' "$scope"
  elif [ "$scope" = user ] && [ ! -x "$console_home" ]; then printf 'user|unknown\n'
  else printf '%s|absent\n' "$scope"; fi
done
end host_app 0
begin tcc
if rows=$(sqlite3 -readonly "/Library/Application Support/com.apple.TCC/TCC.db" "select service, auth_value from access where client = '${HOST_BUNDLE_ID}' and service in ('kTCCServiceScreenCapture', 'kTCCServiceAccessibility')" 2>/dev/null); then
  printf 'system|readable\n'
  printf '%s\n' "$rows" | sed -n 's/^\(kTCCService[A-Za-z]*\)|\(-\{0,1\}[0-9][0-9]*\)$/system|row|\1|\2/p'
else printf 'system|unreadable\n'; fi
end tcc 0
${PROBE_REMOTE_INPUT}if [ -z "$console_user" ] || [ "$console_user" = root ]; then profile_scope=no_console_user
elif [ "$ssh_user" = "$console_user" ]; then profile_scope=console_user
else profile_scope=other_user; fi
pref_domain() {
  where=$1; domain=$2; shift 2
  flag=; if [ "$where" = byhost ]; then flag=-currentHost; fi
  if defaults $flag read "$domain" >/dev/null 2>&1; then readable=1; else readable=0; fi
  for key in "$@"; do
    if value=$(defaults $flag read "$domain" "$key" 2>/dev/null); then
      printf '%s|%s|%s|value|%s\n' "$where" "$domain" "$key" "$(printf '%s\n' "$value" | head -n 1 | tr -cd 'A-Za-z0-9._ -' | cut -c 1-64)"
    elif [ "$readable" = 1 ]; then printf '%s|%s|%s|absent\n' "$where" "$domain" "$key"
    else printf '%s|%s|%s|unreadable\n' "$where" "$domain" "$key"; fi
  done
}
begin target_profile
printf 'scope=%s\n' "$profile_scope"
if [ "$profile_scope" = console_user ]; then
${PROFILE_KEYS.map(([where, domain, keys]) => `  pref_domain ${where} ${domain} ${keys.join(' ')}`).join('\n')}
fi
end target_profile 0
begin input_sources
printf 'scope=%s\n' "$profile_scope"
if [ "$profile_scope" = console_user ]; then
  if value=$(defaults read com.apple.HIToolbox AppleCurrentKeyboardLayoutInputSourceID 2>/dev/null); then
    printf 'current|%s\n' "$(printf '%s\n' "$value" | head -n 1 | cut -c 1-128)"
  else printf 'current|unreadable\n'; fi
  for key in AppleSelectedInputSources AppleEnabledInputSources; do
    if value=$(defaults read com.apple.HIToolbox "$key" 2>/dev/null); then
      printf '%s|read\n' "$key"
      printf '%s\n' "$value" | grep -E '^[[:space:]]*([(){}],?|"?(InputSourceKind|Input Mode|Bundle ID|KeyboardLayout Name)"? = [^;]{1,160};)[[:space:]]*$' | head -n 256 | sed "s/^[[:space:]]*/$key|/"
    else printf '%s|unreadable\n' "$key"; fi
  done
fi
end input_sources 0
`;

/** The fixed script sent on the SSH session's stdin to `/bin/sh -s`. The only
 * variable input is a VNC account name that matched ACCOUNT_NAME; it is
 * single-quoted (the pattern admits no quote) and re-filtered remotely. */
export function probeScript({ vncUser } = {}) {
  const name = usableAccountName(vncUser) ?? '';
  return `vnc_user='${name}'\n${PROBE_PRELUDE}${PROBE_BODY}`;
}
export const PROBE_SCRIPT = probeScript();

const finding = (code, message, detail) => Object.freeze({ code, message, ...detail });

/** Split probe stdout into named sections. A marker counts only on its own
 * line; section names outside `names` and malformed status values are ignored. */
export function parseProbeOutput(text, names = SECTIONS) {
  const sections = new Map();
  if (typeof text !== 'string') return sections;
  let current = null;
  let lines = [];
  for (const line of text.split('\n')) {
    const begin = /^@@fruitctl-probe ([a-z_]+)@@$/.exec(line);
    const end = /^@@fruitctl-status ([a-z_]+) ([0-9]{1,3})@@$/.exec(line);
    if (begin && names.includes(begin[1])) { current = begin[1]; lines = []; continue; }
    if (end && current === end[1]) {
      while (lines.length && lines.at(-1) === '') lines.pop();
      while (lines.length && lines[0] === '') lines.shift();
      sections.set(current, { output: lines.join('\n'), status: Number(end[2]) });
      current = null;
      continue;
    }
    if (current) lines.push(line);
  }
  return sections;
}

function parseVersion(value) {
  if (typeof value !== 'string' || !/^[0-9]{1,3}(\.[0-9]{1,3}){0,2}$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function compareVersions(left, right) {
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

/** `sw_vers` output: ProductName, ProductVersion, optional ProductVersionExtra
 * (Rapid Security Response) and BuildVersion. Malformed output returns null. */
export function parseSwVers(text) {
  if (typeof text !== 'string') return null;
  const fields = {};
  for (const line of text.split('\n')) {
    const match = /^(ProductName|ProductVersion|ProductVersionExtra|BuildVersion):\s*(.*?)\s*$/.exec(line);
    if (match) fields[match[1]] = match[2];
  }
  const version = parseVersion(fields.ProductVersion);
  if (!fields.ProductName || !version || !/^[0-9A-Za-z]{1,16}$/.test(fields.BuildVersion || '')) return null;
  return { productName: fields.ProductName, productVersion: fields.ProductVersion,
    ...(fields.ProductVersionExtra ? { productVersionExtra: fields.ProductVersionExtra } : {}),
    buildVersion: fields.BuildVersion, version };
}

/** D9 policy: 26 at or above 26.6.1, or any 27 release. */
export function evaluateMacosVersion(parsed) {
  if (!parsed) {
    return { supported: false, failure: finding('macos_version_unknown',
      'sw_vers output was missing or malformed; the macOS 26/27 floor cannot be verified') };
  }
  const [major] = parsed.version;
  const policy = parsed.productName === 'macOS' ? SUPPORTED_MACOS[major] : undefined;
  const os = { productName: parsed.productName, version: parsed.productVersion, build: parsed.buildVersion,
    ...(parsed.productVersionExtra ? { versionExtra: parsed.productVersionExtra } : {}), major };
  if (!policy) {
    return { ...os, supported: false, failure: finding('macos_unsupported',
      `macOS ${parsed.productVersion} is unsupported; Fruitctl supports macOS 26 and 27 only`) };
  }
  const floor = { version: policy.floor, advisory: SCREEN_SHARING_ADVISORY, source: policy.source };
  if (compareVersions(parsed.version, parseVersion(policy.floor)) < 0) {
    return { ...os, supported: false, floor, failure: finding('macos_below_patch_floor',
      `macOS ${parsed.productVersion} is below ${policy.floor}, which fixes ${SCREEN_SHARING_ADVISORY} (Screen Sharing pre-authentication bypass)`) };
  }
  return { ...os, supported: true, floor };
}

/** `launchctl print-disabled system` line for com.apple.screensharing. After a
 * successful read, an absent override leaves the shipped default, disabled.
 * A failed or missing read is unknown, never "disabled". */
export function parseScreenSharingOverride(text) {
  const value = String(text || '');
  if (!/^read=ok$/m.test(value)) return 'unknown';
  const match = /"com\.apple\.screensharing"\s*=>\s*(enabled|disabled|true|false)\b/.exec(value);
  if (!match) return 'disabled';
  return match[1] === 'enabled' || match[1] === 'false' ? 'enabled' : 'disabled';
}

export function parseLaunchdService(text) {
  const result = {};
  for (const line of String(text || '').split('\n')) {
    const match = /^\t(state|runs|last exit code) = (.{1,64})$/.exec(line);
    if (match) result[match[1] === 'last exit code' ? 'lastExit' : match[1]] = match[2].trim();
  }
  if (result.runs !== undefined) result.runs = /^[0-9]+$/.test(result.runs) ? Number(result.runs) : undefined;
  return result;
}

/** kickstart -activate writes `enabled` to RemoteManagement.launchd. Only an
 * explicit `disabled` value means off; an absent, unreadable or unrecognized
 * marker is unknown (whether Settings rewrites it is unverified). */
export function parseRemoteManagementMarker(section) {
  const value = section?.status === 0 ? section.output.trim() : '';
  if (value === 'value=enabled') return { state: 'on' };
  if (value === 'value=disabled') return { state: 'off' };
  return { state: 'unknown', reason: value === 'absent' ? 'absent' : value === 'unreadable' ? 'unreadable'
    : value.startsWith('value=') ? 'unrecognized' : 'not_probed' };
}

function int32(value) {
  if (typeof value !== 'string' || !/^-?[0-9]{1,10}$/.test(value.trim())) return undefined;
  const number = Number(value.trim());
  if (number < -2147483648 || number > 4294967295) return undefined;
  return number >>> 0;
}

const REMOTE_MANAGEMENT_KEYS = Object.freeze(['VNCLegacyConnectionsEnabled', 'ARD_AllLocalUsers',
  'ARD_AllLocalUsersPrivs', 'ScreenSharingReqPermEnabled']);

/** `key=value` lines from per-key `defaults read`; values are 0/1 or integers. */
export function parseRemoteManagementPrefs(text) {
  const prefs = {};
  for (const line of String(text || '').split('\n')) {
    const match = /^(ARD_AllLocalUsers|ARD_AllLocalUsersPrivs|VNCLegacyConnectionsEnabled|ScreenSharingReqPermEnabled)=(.*)$/.exec(line);
    if (!match) continue;
    const value = int32(match[2]);
    if (value === undefined) continue;
    prefs[match[1]] = match[1] === 'ARD_AllLocalUsersPrivs' ? value : value !== 0;
  }
  return prefs;
}

/** Report every com.apple.RemoteManagement key as read: a boolean or the
 * privilege integer, `absent` only after the domain itself was read
 * (`read=ok` and `<key>=absent`), and otherwise `unknown`. */
export function describeRemoteManagementPrefs(text) {
  const value = String(text || '');
  const domainRead = /^read=ok$/m.test(value);
  const prefs = parseRemoteManagementPrefs(value);
  return Object.fromEntries(REMOTE_MANAGEMENT_KEYS.map(key => [key, prefs[key] ?? (domainRead &&
    new RegExp(`^${key}=absent$`, 'm').test(value) ? 'absent' : 'unknown')]));
}

/** RFB control by third-party viewers under Remote Management. On PZM
 * (2026-10-16) input from third-party RFB clients was observed dropped with
 * Remote Management on and VNCLegacyConnectionsEnabled 0; the test was
 * confounded by the post-auth input-ignore window, so this is a warning. */
export function evaluateVncControl({ mode, prefs }) {
  const legacy = prefs.VNCLegacyConnectionsEnabled;
  if (mode === 'off' || mode === 'screen_sharing') return { vncControl: 'not_applicable' };
  if (legacy === true) return { vncControl: 'enabled' };
  if (mode === 'remote_management' && legacy === false) {
    return { vncControl: 'disabled', warning: finding('remote_management_vnc_control_disabled',
      'Remote Management is on with VNCLegacyConnectionsEnabled 0. Input from third-party RFB clients was observed ' +
      'dropped in this configuration on PZM. Causality is not isolated: a ~2.5 s post-auth input-ignore window, now ' +
      "handled by the controller's --input-settle-ms, confounded the test") };
  }
  return { vncControl: 'unknown', unknown: finding('remote_management_vnc_control_unverified',
    mode === 'remote_management'
      ? 'VNCLegacyConnectionsEnabled was not readable, so third-party RFB control under Remote Management is unknown'
      : 'Whether Remote Management is on is unknown, so third-party RFB control under it is unknown') };
}

/** ARD_AllLocalUsersPrivs needs the Control and Observe bit (0x02) and must
 * not carry Observe only (0x100). Already a failure when access for all local
 * users is on (evaluateObserveOnly); otherwise a warning about the stored
 * value. Unreadable is unknown, never ready. */
export function evaluateAllLocalUsersPrivileges({ remoteManagement, prefs }) {
  const privileges = prefs.ARD_AllLocalUsersPrivs;
  if (typeof privileges !== 'number') return { state: 'unknown', warnings: [] };
  const control = Boolean(privileges & ARD_PRIVILEGES.controlObserve);
  const observeOnly = Boolean(privileges & ARD_PRIVILEGES.observeOnly);
  const state = control && !observeOnly ? 'control' : 'restricted';
  const reported = remoteManagement !== 'off' && prefs.ARD_AllLocalUsers === true;
  const warnings = [];
  if (remoteManagement !== 'off' && !reported) {
    const hex = `0x${privileges.toString(16)}`;
    if (!control) {
      warnings.push(finding('all_local_users_control_not_granted',
        `ARD_AllLocalUsersPrivs ${hex} lacks the Control and Observe bit (0x02); input would be dropped for any user it covers`));
    }
    if (observeOnly) {
      warnings.push(finding('all_local_users_observe_only',
        `ARD_AllLocalUsersPrivs ${hex} has the Observe-only bit (0x100); input would be dropped for any user it covers`));
    }
  }
  return { state, warnings };
}

/** `dscl . -read /Users/<vnc user> naprivs` for the configured VNC account. */
export function parseNaprivs(text) {
  const value = String(text || '');
  if (/^user=unset$/m.test(value)) return { state: 'unset' };
  const match = /^naprivs:\s*(-?[0-9]{1,10})\s*$/m.exec(value);
  const privileges = match ? int32(match[1]) : undefined;
  return privileges === undefined ? { state: 'unreadable' } : { state: 'read', privileges };
}

/** Observe-only comes from Remote Management privileges. Input is governed by
 * the VNC authentication account, so per-user privileges are read for that
 * account only. Readable privileges are judged unless Remote Management is
 * explicitly off; under plain Screen Sharing the viewer chooses. */
export function evaluateObserveOnly({ remoteManagement, prefs, vncPrivileges }) {
  if (remoteManagement === 'off') return { observeOnly: 'unknown', reason: 'viewer_choice' };
  const privileges = prefs.ARD_AllLocalUsers === true ? prefs.ARD_AllLocalUsersPrivs
    : vncPrivileges?.state === 'read' ? vncPrivileges.privileges : undefined;
  if (privileges === undefined) {
    return { observeOnly: 'unknown', reason: prefs.ARD_AllLocalUsers === true ? 'unreadable'
      : vncPrivileges?.state === 'unset' ? 'vnc_user_unknown' : 'unreadable' };
  }
  if (!(privileges & ARD_PRIVILEGES.controlObserve)) {
    return { observeOnly: true, failure: finding('remote_control_not_permitted',
      'Remote Management grants no Control and Observe privilege to the target user') };
  }
  if (privileges & ARD_PRIVILEGES.observeOnly) {
    return { observeOnly: true, failure: finding('observe_only',
      'Remote Management restricts the target user to Observe only; input would be dropped') };
  }
  return { observeOnly: false };
}

function ioregBool(text, key) {
  const match = new RegExp(`"${key}"=(Yes|No)\\b`).exec(text);
  return match ? match[1] === 'Yes' : undefined;
}

/** Root IORegistry IOConsoleUsers and IOConsoleLocked properties. */
export function parseConsoleSessions(text) {
  const value = String(text || '');
  const locked = /"IOConsoleLocked" = (Yes|No)\b/.exec(value);
  const users = /"IOConsoleUsers" = \((.*)\)\s*$/m.exec(value);
  const sessions = [];
  if (users) {
    for (const entry of users[1].match(/\{[^{}]*\}/g) || []) {
      const pid = /"kCGSSessionSecureInputPID"=([0-9]{1,10})\b/.exec(entry);
      sessions.push({ onConsole: ioregBool(entry, 'kCGSSessionOnConsoleKey'),
        loginDone: ioregBool(entry, 'kCGSessionLoginDoneKey'),
        screenLocked: ioregBool(entry, 'CGSSessionScreenIsLocked'),
        ...(pid ? { secureInputPid: Number(pid[1]) } : {}) });
    }
  }
  return { known: Boolean(users), locked: locked ? locked[1] === 'Yes' : undefined, sessions };
}

/** `pid=<n>|<ps -o comm=>` lines for every SecureInput PID in IOConsoleUsers.
 * `comm` is the executable path without arguments; only a bounded basename is
 * kept. The caller picks the on-console session's own PID. */
export function parseSecureInputProcesses(text) {
  const names = new Map();
  for (const line of String(text || '').split('\n')) {
    const match = /^pid=([0-9]{1,10})\|(.{0,1024})$/.exec(line.trim());
    if (!match) continue;
    const name = match[2].split('/').filter(Boolean).at(-1)?.slice(0, 64);
    names.set(Number(match[1]), name || undefined);
  }
  return names;
}

/** `pmset -g assertions`: system-wide counters plus owning-process names. */
export function parsePmsetAssertions(text) {
  const counters = {};
  let screenSharingActivity = false;
  for (const line of String(text || '').split('\n')) {
    const counter = /^ {3}([A-Za-z]+)\s+([0-9]+)\s*$/.exec(line);
    if (counter) counters[counter[1]] = Number(counter[2]);
    const owner = /^ {3}pid [0-9]+\(([^)]{1,64})\): \[/.exec(line);
    // Remote input reaches WindowServer as an IOHID tickle naming the
    // Screen Sharing agent; the daemons may also own assertions directly.
    if (owner && (/^(screensharingd|ScreensharingAgent)$/.test(owner[1]) ||
        /\bprocess:(ScreensharingAgent|screensharingd)\b/.test(line))) screenSharingActivity = true;
  }
  const known = Object.keys(counters).length > 0;
  return { known,
    displaySleepPrevented: known ? (counters.PreventUserIdleDisplaySleep || 0) + (counters.InternalPreventDisplaySleep || 0) > 0 : undefined,
    screenSharingActivity: known ? screenSharingActivity : undefined };
}

/** `pmset -g` live settings; `displaysleep 0` means never. */
export function parsePmsetSettings(text) {
  const match = /^ displaysleep\s+([0-9]+)\b/m.exec(text || '');
  return { displaySleepMinutes: match ? Number(match[1]) : undefined };
}

/** Filtered `system_profiler SPDisplaysDataType` lines. High Performance
 * sessions replace physical displays with "Screen Sharing Virtual Display". */
export function parseDisplays(section) {
  if (!section || section.status !== 0) return { known: false };
  const displays = [];
  for (const line of section.output.split('\n')) {
    const name = /^display=(.{1,128})$/.exec(line);
    if (name) { displays.push({ name: name[1], online: undefined, virtual: false }); continue; }
    const last = displays.at(-1);
    if (!last) continue;
    if (line === 'online=Yes' || line === 'online=No') last.online = line === 'online=Yes';
    if (line === 'virtual=Yes') last.virtual = true;
  }
  return { known: true, count: displays.length,
    online: displays.filter(display => display.online !== false).length,
    screenSharingVirtual: displays.some(display => /Screen Sharing Virtual Display/i.test(display.name)) };
}

/** `<scope>|present|<bundle>|<version>`, `<scope>|absent` or `<scope>|unknown`
 * for the console user's ~/Applications and /Applications. */
export function parseHostApp(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const present = /^(user|system)\|present\|([A-Za-z0-9.-]{0,128})\|([A-Za-z0-9.+-]{0,64})$/.exec(line);
    if (present) { rows.push({ location: present[1], state: 'present', bundleId: present[2] || undefined, version: present[3] || undefined }); continue; }
    const other = /^(user|system)\|(absent|unknown)$/.exec(line);
    if (other) rows.push({ location: other[1], state: other[2] });
  }
  const host = rows.find(row => row.state === 'present' && row.bundleId === HOST_BUNDLE_ID);
  if (host) return { installed: true, location: host.location, ...(host.version ? { version: host.version } : {}) };
  const foreign = rows.some(row => row.state === 'present');
  // Both locations must have been checked before "not installed" is claimed.
  const checked = ['user', 'system'].every(location => rows.some(row => row.location === location && row.state !== 'unknown'));
  if (!checked) return { installed: 'unknown', ...(foreign ? { foreignBundle: true } : {}) };
  return { installed: false, ...(foreign ? { foreignBundle: true } : {}) };
}

const TCC_SERVICES = { kTCCServiceScreenCapture: 'screenRecording', kTCCServiceAccessibility: 'accessibility' };

/** Host rows from the system TCC.db, which owns Screen Capture and
 * Accessibility; per-user databases do not decide these services and are not
 * read. Reading needs Full Disk Access for the SSH session; an unreadable
 * database is unknown, never "not granted". */
export function parseTcc(text) {
  let readable = false;
  const grants = {};
  for (const line of String(text || '').split('\n')) {
    if (line === 'system|readable') readable = true;
    const row = /^system\|row\|(kTCCService[A-Za-z]+)\|(-?[0-9]{1,3})$/.exec(line);
    if (row && TCC_SERVICES[row[1]]) {
      const value = row[2] === '2' ? 'granted' : row[2] === '0' ? 'denied' : 'limited';
      // Any denial in the authoritative database wins over another row.
      if (grants[TCC_SERVICES[row[1]]] !== 'denied') grants[TCC_SERVICES[row[1]]] = value;
    }
  }
  const result = { source: readable ? 'tcc' : 'unreadable' };
  for (const name of Object.values(TCC_SERVICES)) {
    result[name] = readable ? grants[name] ?? 'not_recorded' : 'unknown';
  }
  return result;
}

/** `pmset -g assertions` owning-process names, and the process named by a
 * WindowServer input tickle (`process:<name>"`). Neither carries a path. */
export function parseAssertionHolders(text) {
  const holders = new Set();
  const input = new Set();
  for (const line of String(text || '').split('\n')) {
    const owner = /^ {3}pid [0-9]+\(([^)]{1,64})\): \[/.exec(line);
    if (owner) holders.add(owner[1]);
    const tickle = owner && /\bprocess:([^"]{1,64})"/.exec(line);
    if (tickle) input.add(tickle[1]);
  }
  return { holders, input };
}

/** Filtered `ps -axww -o comm=` paths. Without a tty, macOS ps truncates the
 * last column to 79 characters unless -ww is given, which would cut the Chrome
 * Remote Desktop host path before its basename. Only exact basenames in
 * REMOTE_INPUT_OWNERS count; the full process list never leaves the target. */
export function parseRemoteInputProcesses(section) {
  const lines = section?.status === 0 ? section.output.split('\n') : [];
  if (lines[0] !== 'read=ok') return { known: false, processes: [] };
  const processes = [];
  for (const line of lines.slice(1)) {
    if (!line || line.length > 1024) continue;
    const name = line.split('/').filter(Boolean).at(-1);
    const entry = REMOTE_INPUT_OWNERS.find(item => item.names.includes(name) && (!item.appPath || line.includes(item.appPath)));
    if (entry) processes.push({ owner: entry.owner, process: name });
  }
  return { known: true, processes };
}

/** D14 competing input owners from running processes and assertion holders.
 * Without a readable process list, an empty result is unknown, not clear. */
export function evaluateRemoteInputOwners({ processes, holders: { holders, input }, assertionsKnown }) {
  const owners = new Map();
  const add = (owner, process, evidence) => {
    const row = owners.get(owner) ?? { owner, processes: new Set(), evidence: new Set() };
    row.processes.add(process);
    row.evidence.add(evidence);
    owners.set(owner, row);
  };
  for (const item of processes.processes) add(item.owner, item.process, 'process');
  for (const [names, evidence] of [[holders, 'assertion'], [input, 'input']]) {
    for (const name of names) {
      const entry = REMOTE_INPUT_OWNERS.find(item => !item.appPath && item.names.includes(name));
      if (entry) add(entry.owner, name, evidence);
    }
  }
  const list = [...owners.values()].map(row => ({ owner: row.owner, processes: [...row.processes].sort(),
    evidence: ['process', 'assertion', 'input'].filter(kind => row.evidence.has(kind)) }));
  if (!processes.known && !list.length) return { owners: 'unknown', complete: false };
  return { owners: list, complete: processes.known && assertionsKnown };
}

/** `<where>|<domain>|<key>|value|<v>`, `...|absent` or `...|unreadable` lines.
 * Absent means the domain was readable and the key unset (the macOS default);
 * an unreadable domain stays unknown. */
export function parseTargetProfile(section) {
  const lines = section?.status === 0 ? section.output.split('\n') : [];
  const scope = /^scope=(console_user|other_user|no_console_user)$/.exec(lines[0] || '')?.[1] ?? 'unknown';
  const values = new Map();
  for (const line of lines.slice(1)) {
    const match = /^(user|byhost)\|([A-Za-z0-9._]{1,64})\|([A-Za-z0-9_-]{1,64})\|(value\|[A-Za-z0-9._ -]{0,64}|absent|unreadable)$/.exec(line);
    if (!match) continue;
    const [state, value] = match[4].split('|');
    values.set(match[3], state === 'value' ? { state, value } : { state });
  }
  return { scope, values };
}

function preferenceBool(entry, macosDefault) {
  if (entry?.state === 'absent') return macosDefault;
  if (entry?.state !== 'value') return undefined;
  if (/^(1|true|YES)$/i.test(entry.value)) return true;
  if (/^(0|false|NO)$/i.test(entry.value)) return false;
  return undefined;
}

function preferenceInt(entry, macosDefault) {
  if (entry?.state === 'absent') return macosDefault;
  return entry?.state === 'value' && /^-?[0-9]{1,6}$/.test(entry.value) ? Number(entry.value) : undefined;
}

const HOT_CORNERS = Object.freeze([['tl', 'top-left', 1], ['tr', 'top-right', 1], ['bl', 'bottom-left', 1],
  ['br', 'bottom-right', 14]]);

// Each profile check returns true (deviation), false (ready) or undefined
// (unknown). A deviation is a warning with the setting's stable code.
const boolSetting = (key, macosDefault, deviatesWhen) => values => {
  const value = preferenceBool(values.get(key), macosDefault);
  return value === undefined ? undefined : value === deviatesWhen;
};
export const TARGET_PROFILE = Object.freeze([
  { setting: 'stageManager', code: 'stage_manager_enabled', check: boolSetting('GloballyEnabled', false, true),
    message: 'Stage Manager is on; it moves and shrinks windows between actions' },
  { setting: 'spacesAutoRearrange', code: 'spaces_auto_rearrange_enabled', check: boolSetting('mru-spaces', true, true),
    message: 'Spaces are rearranged by most recent use; Space order changes between observations' },
  { setting: 'hotCorners', code: 'hot_corner_enabled', check: values => {
    const corners = HOT_CORNERS.map(([id, , macosDefault]) => preferenceInt(values.get(`wvous-${id}-corner`), macosDefault));
    if (corners.some(value => value !== undefined && value > 1)) return true;
    return corners.includes(undefined) ? undefined : false;
  }, message: values => `Hot Corners are assigned (${HOT_CORNERS.filter(([id, , macosDefault]) =>
    preferenceInt(values.get(`wvous-${id}-corner`), macosDefault) > 1).map(([, name]) => name).join(', ')}); a pointer move into a corner triggers an action` },
  { setting: 'clickWallpaperToShowDesktop', code: 'click_wallpaper_reveals_desktop',
    check: boolSetting('EnableStandardClickToShowDesktop', true, true),
    message: 'Clicking the wallpaper reveals the desktop; a click on empty space hides every window' },
  { setting: 'menuBarAutoHide', code: 'menu_bar_auto_hides', check: values => {
    const hide = preferenceBool(values.get('_HIHideMenuBar'), false);
    const fullscreen = preferenceBool(values.get('AppleMenuBarVisibleInFullscreen'), false);
    if (hide === true || fullscreen === false) return true;
    return hide === undefined || fullscreen === undefined ? undefined : false;
  }, message: 'The menu bar hides automatically; menus are not on screen to observe or click' },
  { setting: 'reduceTransparency', code: 'reduce_transparency_off', check: boolSetting('reduceTransparency', false, false),
    message: 'Reduce Transparency is off; translucent surfaces change with what is behind them' },
  { setting: 'pressAndHold', code: 'press_and_hold_enabled', check: boolSetting('ApplePressAndHoldEnabled', true, true),
    message: 'Press-and-hold shows the accent picker instead of repeating keys' },
  { setting: 'smartQuotes', code: 'smart_quotes_enabled', check: boolSetting('NSAutomaticQuoteSubstitutionEnabled', true, true),
    message: 'Smart quotes are on; typed straight quotes may be replaced' },
  { setting: 'smartDashes', code: 'smart_dashes_enabled', check: boolSetting('NSAutomaticDashSubstitutionEnabled', true, true),
    message: 'Smart dashes are on; typed hyphens may be replaced' },
  { setting: 'autocorrect', code: 'autocorrect_enabled', check: boolSetting('NSAutomaticSpellingCorrectionEnabled', true, true),
    message: 'Automatic spelling correction is on; typed text may be changed' },
  { setting: 'autoCapitalization', code: 'auto_capitalization_enabled', check: boolSetting('NSAutomaticCapitalizationEnabled', true, true),
    message: 'Automatic capitalisation is on; typed text may be changed' },
  { setting: 'autoPeriod', code: 'auto_period_enabled', check: boolSetting('NSAutomaticPeriodSubstitutionEnabled', true, true),
    message: 'Double-space period substitution is on; typed text may be changed' },
  { setting: 'shakeToLocate', code: 'shake_to_locate_enabled', check: boolSetting('CGDisableCursorLocationMagnification', false, false),
    message: 'Shake to locate is on; fast pointer moves enlarge the cursor in captures' },
  { setting: 'handoff', code: 'handoff_enabled', check: values => {
    const advertise = preferenceBool(values.get('ActivityAdvertisingAllowed'), true);
    const receive = preferenceBool(values.get('ActivityReceivingAllowed'), true);
    if (advertise === true || receive === true) return true;
    return advertise === undefined || receive === undefined ? undefined : false;
  }, message: 'Handoff is on; nearby devices can add Dock items and share the clipboard' },
].map(Object.freeze));

/** Light, Dark or automatic appearance; informational only. */
function profileAppearance(values) {
  const automatic = preferenceBool(values.get('AppleInterfaceStyleSwitchesAutomatically'), false);
  const style = values.get('AppleInterfaceStyle');
  if (automatic === true) return 'auto';
  if (automatic === undefined || !style || style.state === 'unreadable') return 'unknown';
  if (style.state === 'absent') return 'light';
  return style.value === 'Dark' ? 'dark' : 'unknown';
}

export function evaluateTargetProfile(profile) {
  const settings = {};
  const warnings = [];
  const unknown = [];
  for (const item of TARGET_PROFILE) {
    const deviates = profile.scope === 'console_user' ? item.check(profile.values) : undefined;
    settings[item.setting] = deviates === undefined ? 'unknown' : deviates ? 'deviation' : 'ready';
    if (deviates === undefined) unknown.push(item.setting);
    else if (deviates) {
      warnings.push(finding(item.code, typeof item.message === 'function' ? item.message(profile.values) : item.message,
        { setting: item.setting }));
    }
  }
  const appearance = profile.scope === 'console_user' ? profileAppearance(profile.values) : 'unknown';
  return { scope: profile.scope, settings, appearance, warnings, unknown };
}

function plistString(value) {
  const decoded = value.replace(/\\U([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return /^[^\u0000-\u001f\u007f";|]{1,128}$/u.test(decoded) ? decoded : undefined;
}

/** HIToolbox input sources: the current keyboard layout ID and the filtered
 * old-style plist arrays of selected and enabled sources. */
export function parseInputSources(section) {
  const lines = section?.status === 0 ? section.output.split('\n') : [];
  const scope = /^scope=(console_user|other_user|no_console_user)$/.exec(lines[0] || '')?.[1] ?? 'unknown';
  const result = { scope, current: undefined, selected: undefined, enabled: undefined };
  const lists = { AppleSelectedInputSources: 'selected', AppleEnabledInputSources: 'enabled' };
  let entry = null;
  for (const line of lines.slice(1)) {
    const current = /^current\|(.{1,128})$/.exec(line);
    if (current) { if (current[1] !== 'unreadable') result.current = plistString(current[1].trim()); continue; }
    const match = /^(AppleSelectedInputSources|AppleEnabledInputSources)\|(.*)$/.exec(line);
    if (!match) continue;
    const list = lists[match[1]];
    const body = match[2].trim();
    if (body === 'read') { result[list] = []; continue; }
    if (!result[list]) continue;
    if (body === '{') { entry = {}; continue; }
    if (/^\},?$/.test(body)) {
      if (entry) result[list].push(entry);
      entry = null;
      continue;
    }
    const field = /^"?(InputSourceKind|Input Mode|Bundle ID|KeyboardLayout Name)"? = "?(.*?)"?;$/.exec(body);
    const value = field ? plistString(field[2]) : undefined;
    if (entry && value !== undefined) {
      entry[{ InputSourceKind: 'kind', 'Input Mode': 'inputMode', 'Bundle ID': 'bundleId', 'KeyboardLayout Name': 'name' }[field[1]]] = value;
    }
  }
  const summarize = sources => sources?.slice(0, 32).map(source => ({ ...(source.kind ? { kind: source.kind } : {}),
    ...(source.inputMode ?? source.bundleId ? { id: source.inputMode ?? source.bundleId } : {}),
    ...(source.name ? { name: source.name } : {}) }));
  return { scope, current: result.current, selected: summarize(result.selected), enabled: summarize(result.enabled) };
}

/** The active source is a selected input method when there is one (its
 * current layout only underlies it), otherwise the current keyboard layout.
 * The character palette is not a keyboard source. A declared profile
 * inputSource matches any active ID or layout name. */
export function evaluateInputSource(parsed, declared) {
  const active = (parsed.selected ?? []).filter(source => source.kind !== 'Non Keyboard Input Method');
  const methods = active.filter(source => source.kind && source.kind !== 'Keyboard Layout');
  const identifiers = [...new Set((methods.length ? methods.flatMap(source => [source.id, source.name])
    : [parsed.current, ...active.flatMap(source => [source.id, source.name])]).filter(Boolean))];
  const known = parsed.scope === 'console_user' && identifiers.length > 0;
  const matches = !declared ? 'not_declared' : !known ? 'unknown' : identifiers.includes(declared);
  return { current: parsed.current ?? 'unknown', selected: known ? active : 'unknown',
    enabled: parsed.scope === 'console_user' && parsed.enabled ? parsed.enabled : 'unknown',
    declared: declared ?? null, matches, identifiers };
}

const sectionText = (sections, name) => sections.get(name)?.output ?? '';

/** Console owner, screen lock and Secure Input from the console, ioreg_console
 * and secure_input_process sections. Shared with the desktop-state sentinel.
 * Without a parsed IOConsoleUsers list neither the lock nor Secure Input is
 * known; that is recorded, never treated as a pass. */
export function consoleLockState(sections) {
  const consoleUser = sectionText(sections, 'console').trim();
  const consoleState = !consoleUser ? 'unknown' : consoleUser === 'root' ? 'loginwindow' : 'user';
  const consoleSessions = parseConsoleSessions(sectionText(sections, 'ioreg_console'));
  const onConsole = consoleSessions.sessions.find(session => session.onConsole === true);
  const locked = consoleSessions.locked === true || onConsole?.screenLocked === true
    ? true : consoleSessions.known && consoleSessions.locked !== undefined ? false : 'unknown';
  const secureNames = parseSecureInputProcesses(sectionText(sections, 'secure_input_process'));
  const securePid = onConsole?.secureInputPid;
  const secureInput = !consoleSessions.known ? 'unknown'
    : securePid === undefined ? { held: false }
      : { held: true, ...(secureNames.get(securePid) ? { process: secureNames.get(securePid) } : {}) };
  return { consoleState, consoleSessions, onConsole, locked, secureInput };
}

/** Pure policy over parsed sections. `route` is the configured profile route
 * when known ('host' | 'raw'), otherwise 'unknown'. */
export function evaluatePreflight(sections, { route = 'unknown', inputSource } = {}) {
  const failures = [];
  const warnings = [];
  const unknowns = [];

  const os = evaluateMacosVersion(sections.get('sw_vers')?.status === 0
    ? parseSwVers(sectionText(sections, 'sw_vers')) : null);
  if (os.failure) failures.push(os.failure);
  const { failure: _osFailure, ...osResult } = os;
  const architecture = /^(arm64|x86_64)$/.exec(sectionText(sections, 'arch').trim())?.[1];

  // A missing section means the probe did not run, not that the service is off.
  const service = sections.has('screensharing_override')
    ? parseScreenSharingOverride(sectionText(sections, 'screensharing_override')) : 'unknown';
  const serviceState = parseLaunchdService(sectionText(sections, 'screensharing_service'));
  const marker = parseRemoteManagementMarker(sections.get('remote_management_marker'));
  const remoteManagement = marker.state;
  const prefs = parseRemoteManagementPrefs(sectionText(sections, 'remote_management_prefs'));
  const mode = service === 'disabled' ? 'off' : service === 'unknown' ? 'unknown'
    : remoteManagement === 'on' ? 'remote_management'
      : remoteManagement === 'off' ? 'screen_sharing' : 'unknown';
  if (mode === 'off') {
    failures.push(finding('screen_sharing_disabled',
      'Neither Screen Sharing nor Remote Management is enabled (com.apple.screensharing is disabled)'));
  }
  if (service === 'unknown') {
    unknowns.push(finding('screen_sharing_unverified', 'The Screen Sharing launchd override could not be read'));
  } else if (mode === 'unknown') {
    unknowns.push(finding('remote_management_unverified',
      `The Remote Management activation marker is ${marker.reason}; Remote Management versus plain Screen Sharing is unknown`));
  }
  const observe = evaluateObserveOnly({ remoteManagement, prefs,
    vncPrivileges: parseNaprivs(sectionText(sections, 'vnc_naprivs')) });
  if (observe.failure) failures.push(observe.failure);
  if (observe.observeOnly === 'unknown') {
    unknowns.push(finding('observe_only_unverified', {
      viewer_choice: 'Plain Screen Sharing leaves observe or control to the viewer; verify with an input probe',
      vnc_user_unknown: 'The VNC account is not known or not a plain short name, so its Remote Management privileges were not read',
      unreadable: 'Remote Management privileges for the VNC account were not readable',
    }[observe.reason]));
  }
  if (prefs.VNCLegacyConnectionsEnabled === true) {
    warnings.push(finding('legacy_vnc_password_enabled',
      'The legacy VNC password is enabled; disable it (CVE-2026-43760, CVE-2026-43665)'));
  }
  const vncControl = evaluateVncControl({ mode, prefs });
  if (vncControl.warning) warnings.push(vncControl.warning);
  if (vncControl.unknown) unknowns.push(vncControl.unknown);
  const allLocalUsers = evaluateAllLocalUsersPrivileges({ remoteManagement, prefs });
  warnings.push(...allLocalUsers.warnings);

  const displays = parseDisplays(sections.get('displays'));
  let highPerformance = 'unknown';
  if (displays.known) {
    highPerformance = displays.screenSharingVirtual ? true : 'not_detected';
    if (displays.screenSharingVirtual) {
      failures.push(finding('high_performance_session',
        'A High Performance Screen Sharing session is active (Screen Sharing Virtual Display present); Fruitctl does not support it'));
    }
    if (displays.online === 0) warnings.push(finding('no_online_display', 'No online display was reported'));
  } else unknowns.push(finding('displays_unverified', 'Display configuration was not readable'));
  unknowns.push(finding('curtain_unverified',
    'Curtain mode has no passive host-side signal; it is reported unknown'));

  const { consoleState, consoleSessions, onConsole, locked, secureInput } = consoleLockState(sections);
  if (consoleState === 'loginwindow') {
    failures.push(finding('no_console_session', 'The console is at the login window; no user session is on screen'));
  } else if (consoleState === 'unknown') unknowns.push(finding('console_unverified', 'The console owner was not readable'));
  if (locked === true) failures.push(finding('screen_locked', 'The console session screen is locked'));
  if (!consoleSessions.known) {
    unknowns.push(finding('console_session_unverified',
      'IOConsoleUsers was missing or unparseable; screen lock and Secure Input are unknown'));
  } else if (locked === 'unknown') {
    unknowns.push(finding('screen_lock_unverified', 'IOConsoleLocked was not reported; screen lock is unknown'));
  }
  const additionalSessions = consoleSessions.sessions.filter(session => session.onConsole === false).length;
  if (additionalSessions) {
    warnings.push(finding('additional_gui_sessions',
      `${additionalSessions} GUI session(s) are off console (fast user switching or a virtual Screen Sharing session)`));
  }
  if (secureInput.held) {
    warnings.push(finding('secure_input_held',
      `Secure keyboard entry is held by ${secureInput.process || `pid ${onConsole.secureInputPid}`}; typed input may be refused`));
  }
  const assertions = parsePmsetAssertions(sectionText(sections, 'pmset_assertions'));
  const { displaySleepMinutes } = parsePmsetSettings(sectionText(sections, 'pmset_settings'));
  if (assertions.screenSharingActivity) {
    warnings.push(finding('screen_sharing_input_recent',
      'A Screen Sharing client sent input recently. It may be Fruitctl\'s own session; otherwise confirm no other input owner is active on this Mac'));
  }
  if (displaySleepMinutes > 0 && assertions.displaySleepPrevented !== true) {
    warnings.push(finding('display_sleep_enabled',
      `The display sleeps after ${displaySleepMinutes} minute(s); captures may go black`));
  }

  const host = parseHostApp(sectionText(sections, 'host_app'));
  const grants = parseTcc(sectionText(sections, 'tcc'));
  if (host.installed === 'unknown') {
    unknowns.push(finding('host_install_unverified',
      "The console user's Applications folder could not be checked; Host installation is unknown"));
  } else if (!host.installed) {
    warnings.push(finding('host_not_installed',
      'FruitctlHost is not installed; only the raw VNC route is available, without the indicator or grants'));
  } else {
    if (route === 'raw') {
      warnings.push(finding('host_installed_raw_route',
        'FruitctlHost is installed but this profile uses the raw VNC route; configure hostHelper to make the Host route the default'));
    }
    for (const [name, label] of [['screenRecording', 'Screen Recording'], ['accessibility', 'Accessibility']]) {
      if (grants[name] === 'unknown') continue;
      if (grants[name] !== 'granted') {
        warnings.push(finding(`host_${name === 'screenRecording' ? 'screen_recording' : 'accessibility'}_not_granted`,
          `FruitctlHost has no ${label} grant (${grants[name]})`));
      }
    }
    if (grants.source !== 'tcc') {
      warnings.push(finding('host_grants_unverified',
        'Host grants could not be read: the SSH session lacks Full Disk Access to TCC.db'));
    }
  }

  const remoteInput = evaluateRemoteInputOwners({
    processes: parseRemoteInputProcesses(sections.get('remote_input_processes')),
    holders: parseAssertionHolders(sectionText(sections, 'pmset_assertions')), assertionsKnown: assertions.known });
  for (const row of Array.isArray(remoteInput.owners) ? remoteInput.owners : []) {
    const seen = row.evidence.map(kind => ({ process: 'running', assertion: 'holding a power assertion',
      input: 'sending input' })[kind]).join(', ');
    warnings.push(finding('remote_input_owner_other',
      `${row.owner} is ${seen} on this Mac (${row.processes.join(', ')}); it can move the pointer or type while Fruitctl acts. Keep one input owner per Mac`,
      { owner: row.owner }));
  }
  if (!remoteInput.complete) {
    unknowns.push(finding('remote_input_owner_unverified',
      'The running-process or power-assertion list was not readable; other remote-input owners may be present'));
  }

  const profile = evaluateTargetProfile(parseTargetProfile(sections.get('target_profile')));
  warnings.push(...profile.warnings);
  if (profile.unknown.length) {
    unknowns.push(finding('target_profile_unverified', {
      other_user: "The SSH account is not the console user, so the console user's settings were not read",
      no_console_user: 'No user owns the console, so no user settings were read',
      unknown: 'The target profile settings were not probed',
    }[profile.scope] ?? `These target profile settings were unreadable: ${profile.unknown.join(', ')}`));
  }

  const declaredInputSource = validInputSource(inputSource) ? inputSource : undefined;
  const { identifiers, ...source } = evaluateInputSource(parseInputSources(sections.get('input_sources')), declaredInputSource);
  if (source.matches === false) {
    warnings.push(finding('input_source_mismatch',
      `The selected input source is ${identifiers.join(' / ')}; this profile declares ${declaredInputSource}. Typed characters may differ`));
  } else if (source.matches === 'unknown') {
    unknowns.push(finding('input_source_unverified',
      `The selected input source could not be read; the profile declares ${declaredInputSource}`));
  }

  const status = failures.length ? 'fail' : warnings.length ? 'warn' : 'pass';
  return { schema: PREFLIGHT_SCHEMA, status, route,
    os: { ...osResult, ...(architecture ? { architecture } : {}) },
    screenSharing: { service, ...(serviceState.state ? { serviceState: serviceState.state } : {}),
      remoteManagement, mode, observeOnly: observe.observeOnly, highPerformance, curtain: 'unknown',
      legacyVncPassword: prefs.VNCLegacyConnectionsEnabled ?? 'unknown',
      remoteManagementPrefs: describeRemoteManagementPrefs(sectionText(sections, 'remote_management_prefs')),
      vncControl: vncControl.vncControl, allLocalUsersPrivileges: allLocalUsers.state },
    session: { console: consoleState, locked, additionalSessions,
      secureInput,
      displays: displays.known ? { count: displays.count, online: displays.online } : 'unknown',
      displaySleepMinutes: displaySleepMinutes ?? 'unknown',
      displaySleepPrevented: assertions.displaySleepPrevented ?? 'unknown',
      screenSharingActivity: assertions.screenSharingActivity ?? 'unknown',
      remoteInputOwners: remoteInput.owners },
    host: { ...host, grants },
    targetProfile: { scope: profile.scope, settings: profile.settings, appearance: profile.appearance,
      inputSource: source },
    failures, warnings, unknowns,
    qualification: 'Read-only SSH probes at one sample time; typed results describe that sample, not runtime capture or input behavior' };
}

export function validateSshDestination(destination) {
  if (typeof destination !== 'string' || !SSH_DESTINATION.test(destination)) {
    throw new Error('Target SSH destination must be an explicit host or user@host');
  }
  return destination;
}

export function sshProbeArguments(destination, { connectTimeoutSeconds = 10 } = {}) {
  return ['-T', '-oBatchMode=yes', `-oConnectTimeout=${connectTimeoutSeconds}`, '-oForwardAgent=no', '-oForwardX11=no',
    '-oClearAllForwardings=yes', '-oControlMaster=no', '-oControlPath=none', '-oControlPersist=no',
    '-oRequestTTY=no', '--', validateSshDestination(destination), '/bin/sh -s'];
}

/** Run the fixed script over SSH. Remote stderr is discarded; stdout is
 * bounded. A timeout or oversize output terminates only this owned child.
 * `script` replaces doctor's script with another fixed one (the sentinel's). */
export function runProbe(destination, { vncUser, spawnImpl = spawn, timeoutMs = PROBE_TIMEOUT_MS,
  script = probeScript({ vncUser }), connectTimeoutSeconds } = {}) {
  const args = sshProbeArguments(destination, connectTimeoutSeconds ? { connectTimeoutSeconds } : {});
  const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  return new Promise((resolve, reject) => {
    const child = spawnImpl('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (child.exitCode == null && child.signalCode == null) { try { child.kill('SIGKILL'); } catch {} }
        reject(error);
      } else resolve(value);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('Target preflight timed out'),
      { code: 'preflight_timeout' })), timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        finish(Object.assign(new Error('Target preflight output exceeded its limit'), { code: 'preflight_output_limit' }));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on('data', () => {});
    child.stdin.on('error', () => {});
    child.once('error', () => finish(Object.assign(new Error('Target preflight SSH could not start'),
      { code: 'preflight_unreachable' })));
    child.once('close', code => {
      if (code === 255) {
        finish(Object.assign(new Error('Target preflight SSH connection failed'), { code: 'preflight_unreachable' }));
      } else finish(null, Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(script);
  });
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BRIDGE_TIMEOUT_MS = PROBE_TIMEOUT_MS + 15000;
const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

/** Resolve the probe destination from an explicit flag or the operator's
 * target profile. Tool arguments never reach this; it is CLI-only.
 *
 * A Linux seat declares profile names only; its Darwin bridge owns the
 * profile. An explicit `bridge`, or `environmentBridge` on Linux, runs the
 * probe there without opening controller-private binding files locally.
 * Otherwise `environmentBridge` when neither
 * --target-ssh nor a local profile names a destination, runs the probe there
 * through this seat's SSH configuration for that alias. */
export async function resolvePreflightTarget({ targetSsh, configPath, target = 'default',
  bridge, environmentBridge, remoteCommand } = {}) {
  let profile;
  const remote = bridge ?? (process.platform !== 'darwin' && !targetSsh ? environmentBridge : undefined);
  if (!remote && configPath) {
    let present = true;
    try { await fs.access(configPath); } catch { present = false; }
    if (present) profile = (await loadConfig(configPath)).targets[target];
    if (present && !profile && !targetSsh && !bridge) throw new Error(`Unknown target profile: ${target}`);
  }
  const via = remote ?? (!targetSsh && !profile ? environmentBridge : undefined);
  if (via) {
    if (!PROFILE_NAME.test(target)) throw new Error('Target profile must be a profile identifier');
    const command = remoteCommand ?? 'fruitctl';
    if (command !== 'fruitctl' && (!command.startsWith('/') || /[\0\n\r]/.test(command))) {
      throw new Error('Bridge remote command must be fruitctl or an absolute executable path');
    }
    return { bridge: validateSshDestination(via), remoteCommand: command, target,
      ...(targetSsh ? { targetSsh: validateSshDestination(targetSsh) } : {}) };
  }
  const route = profile ? (profile.hostHelper ? 'host' : 'raw') : 'unknown';
  const destination = targetSsh ?? profile?.hostHelper?.sshHost;
  if (!destination) {
    throw new Error('Target preflight needs --target-ssh USER@HOST, or a profile with hostHelper.sshHost');
  }
  // The VNC authentication account governs input; its name is never secret.
  const vncUser = typeof profile?.vnc?.username === 'string' && profile.vnc.username ? profile.vnc.username : undefined;
  // loadConfig has validated a declared inputSource; it is never secret.
  const inputSource = profile?.inputSource;
  return { destination: validateSshDestination(destination), route, ...(vncUser ? { vncUser } : {}),
    ...(inputSource ? { inputSource } : {}) };
}

export function bridgedDoctorArguments({ bridge, remoteCommand = 'fruitctl', target, targetSsh }) {
  const command = [remoteCommand, 'doctor', '--macos', '--target', target,
    ...(targetSsh ? ['--target-ssh', targetSsh] : [])];
  return ['-T', '-oBatchMode=yes', '-oConnectTimeout=10', '-oForwardAgent=no', '-oForwardX11=no',
    '-oClearAllForwardings=yes', '-oControlMaster=no', '-oControlPath=none', '-oControlPersist=no',
    '-oRequestTTY=no', '--', validateSshDestination(bridge), command.map(shellQuote).join(' ')];
}

const bridgeFailure = (bridge, code, message) => ({ schema: PREFLIGHT_SCHEMA, status: 'fail', route: 'unknown',
  via: 'bridge', bridge, failures: [finding(code, message)], warnings: [], unknowns: [],
  qualification: 'No target facts were collected' });

/** Run `doctor --macos` on the Darwin bridge, which resolves the profile and
 * its target SSH alias from its own configuration. Only the returned
 * targetPreflight is kept; remote stderr is discarded, stdout is bounded. */
export function bridgedPreflight({ bridge, remoteCommand, target, targetSsh },
  { spawnImpl = spawn, timeoutMs = BRIDGE_TIMEOUT_MS } = {}) {
  const args = bridgedDoctorArguments({ bridge, remoteCommand, target, targetSsh });
  const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  return new Promise(resolve => {
    const child = spawnImpl('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode == null && child.signalCode == null) { try { child.kill('SIGKILL'); } catch {} }
      resolve(value);
    };
    const timer = setTimeout(() => finish(bridgeFailure(bridge, 'preflight_timeout',
      'Bridged target preflight timed out')), timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        finish(bridgeFailure(bridge, 'preflight_output_limit', 'Bridged target preflight output exceeded its limit'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on('data', () => {});
    child.once('error', () => finish(bridgeFailure(bridge, 'preflight_bridge_unreachable',
      'Bridged target preflight SSH could not start')));
    child.once('close', code => {
      if (code === 255) {
        finish(bridgeFailure(bridge, 'preflight_bridge_unreachable', 'SSH to the Darwin bridge failed'));
        return;
      }
      if (code === 127) {
        finish(bridgeFailure(bridge, 'preflight_bridge_command_missing', 'Fruitctl was not found at the bridge remote command'));
        return;
      }
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { result = undefined; }
      const remote = result?.targetPreflight;
      if (remote?.schema !== PREFLIGHT_SCHEMA || typeof remote.status !== 'string') {
        finish(bridgeFailure(bridge, 'preflight_bridge_refused',
          'The bridge returned no target preflight; run fruitctl doctor --macos on the bridge for its typed error'));
        return;
      }
      finish({ ...remote, via: 'bridge', bridge });
    });
  });
}

export async function macosPreflight({ destination, route = 'unknown', vncUser, inputSource, probe = runProbe } = {}) {
  let output;
  try { output = await probe(destination, { vncUser }); }
  catch (error) {
    const failure = finding(error.code || 'preflight_unreachable', error.message || 'Target preflight failed');
    return { schema: PREFLIGHT_SCHEMA, status: 'fail', route, failures: [failure], warnings: [], unknowns: [],
      qualification: 'No target facts were collected' };
  }
  return evaluatePreflight(parseProbeOutput(output), { route, inputSource });
}
