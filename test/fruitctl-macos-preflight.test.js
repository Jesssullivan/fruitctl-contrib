// SPDX-License-Identifier: MIT
// Offline `doctor --macos` checks. Fixtures are redacted read-only samples
// from two macOS 26.7.1 hosts plus synthetic variants; no SSH is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  PROBE_SCRIPT, probeScript, usableAccountName, HOST_BUNDLE_ID, parseProbeOutput, parseSwVers, evaluateMacosVersion, evaluatePreflight,
  parseScreenSharingOverride, parseRemoteManagementPrefs, parseNaprivs, evaluateObserveOnly,
  parseRemoteManagementMarker, parseConsoleSessions, parseSecureInputProcesses, parsePmsetAssertions, parsePmsetSettings,
  parseDisplays, parseHostApp, parseTcc, sshProbeArguments, validateSshDestination, runProbe,
  resolvePreflightTarget, macosPreflight, bridgedPreflight, REMOTE_INPUT_OWNERS, TARGET_PROFILE, parseAssertionHolders,
  parseRemoteInputProcesses, evaluateRemoteInputOwners, parseTargetProfile, evaluateTargetProfile,
  parseInputSources, evaluateInputSource, describeRemoteManagementPrefs, evaluateVncControl,
  evaluateAllLocalUsersPrivileges,
} from '../lib/install/macos-preflight.mjs';
import { loadConfig } from '../lib/broker/paths.mjs';
import { doctor } from '../lib/install/index.mjs';

const run = promisify(execFile);
const fixtures = new URL('./fixtures/macos-preflight/', import.meta.url);
const fixture = name => fs.readFile(new URL(name, fixtures), 'utf8');
const cliPath = fileURLToPath(new URL('../bin/fruitctl.mjs', import.meta.url));
const codes = list => list.map(item => item.code);
// The redacted base sample has no Host installed; new checks are read past it.
const without = (list, code = 'host_not_installed') => list.filter(item => item.code !== code);

function render(sections) {
  return Object.entries(sections).map(([name, { output, status = 0 }]) =>
    `@@fruitctl-probe ${name}@@\n${output}\n@@fruitctl-status ${name} ${status}@@\n`).join('\n');
}

// The redacted laptop sample predates the D12/D14 sections; the synthetic
// ready profile fills them so other checks start from a clean target.
async function baseSections() {
  return Object.fromEntries(parseProbeOutput(await fixture('laptop-26.7.1-tcc-readable.txt') +
    await fixture('target-profile-ready.txt')));
}

async function evaluateWith(overrides, options) {
  const sections = { ...await baseSections(), ...overrides };
  return evaluatePreflight(parseProbeOutput(render(sections)), options);
}

const swVers = version => ({ output: `ProductName:\t\tmacOS\nProductVersion:\t\t${version}\nBuildVersion:\t\t25A100` });

test('sw_vers samples enforce macOS 26.6.1+ and every 27 release', () => {
  const cases = [
    ['26.5', 'macos_below_patch_floor'], ['26.6', 'macos_below_patch_floor'], ['26.6.1', null],
    ['26.7.1', null], ['27', null], ['27.0.1', null], ['27.1', null],
    ['15.7', 'macos_unsupported'], ['15.7.9', 'macos_unsupported'], ['14.8.9', 'macos_unsupported'],
    ['25.0', 'macos_unsupported'], ['28.0', 'macos_unsupported'],
  ];
  for (const [version, failure] of cases) {
    const result = evaluateMacosVersion(parseSwVers(swVers(version).output));
    assert.equal(result.failure?.code ?? null, failure, version);
    assert.equal(result.supported, failure === null, version);
  }
  const floor = evaluateMacosVersion(parseSwVers(swVers('26.6.1').output)).floor;
  assert.deepEqual(floor, { version: '26.6.1', advisory: 'CVE-2026-65400', source: 'https://support.apple.com/en-us/148170' });
  assert.equal(evaluateMacosVersion(parseSwVers(swVers('27.1').output)).floor.source, 'https://support.apple.com/en-us/149035');
});

test('malformed, legacy-named and Rapid Security Response sw_vers output stay typed', () => {
  for (const text of ['', 'ProductName: macOS\n', 'ProductName: macOS\nProductVersion: twenty-six\nBuildVersion: 25A1',
    'ProductName: macOS\nProductVersion: 26.6.1\nBuildVersion: 25A1; rm -rf', 'garbage\n\u0000']) {
    assert.equal(parseSwVers(text), null, JSON.stringify(text));
    assert.equal(evaluateMacosVersion(parseSwVers(text)).failure.code, 'macos_version_unknown');
  }
  const legacy = parseSwVers('ProductName:\tMac OS X\nProductVersion:\t10.15.7\nBuildVersion:\t19H15');
  assert.equal(evaluateMacosVersion(legacy).failure.code, 'macos_unsupported');
  const rsr = parseSwVers('ProductName:\tmacOS\nProductVersion:\t26.6\nProductVersionExtra:\t(a)\nBuildVersion:\t25G5a');
  const result = evaluateMacosVersion(rsr);
  assert.equal(result.versionExtra, '(a)');
  // A Rapid Security Response does not name the fixed CVE; the floor stands.
  assert.equal(result.failure.code, 'macos_below_patch_floor');
});

test('redacted Remote Management bench sample reports warnings, not failures', async () => {
  const result = evaluatePreflight(parseProbeOutput(await fixture('bench-26.7.1-remote-management.txt')), { route: 'raw' });
  assert.equal(result.status, 'warn');
  assert.deepEqual(result.failures, []);
  // The bench was driven through Chrome Remote Desktop while sampled.
  assert.deepEqual(codes(result.warnings), ['legacy_vnc_password_enabled', 'secure_input_held', 'host_not_installed',
    'remote_input_owner_other']);
  assert.deepEqual(result.os, { productName: 'macOS', version: '26.7.1', build: '25G313', major: 26, supported: true,
    floor: { version: '26.6.1', advisory: 'CVE-2026-65400', source: 'https://support.apple.com/en-us/148170' }, architecture: 'arm64' });
  assert.deepEqual(result.screenSharing, { service: 'enabled', serviceState: 'not running', remoteManagement: 'on',
    mode: 'remote_management', observeOnly: false, highPerformance: 'not_detected', curtain: 'unknown', legacyVncPassword: true,
    // The bench sample predates the read=ok line; every key it printed was read.
    remoteManagementPrefs: { VNCLegacyConnectionsEnabled: true, ARD_AllLocalUsers: true, ARD_AllLocalUsersPrivs: 0x400000ff,
      ScreenSharingReqPermEnabled: true }, vncControl: 'enabled', allLocalUsersPrivileges: 'control' });
  assert.deepEqual(result.session.secureInput, { held: true, process: 'Example Secure App' });
  assert.deepEqual(result.host, { installed: false, grants: { source: 'unreadable', screenRecording: 'unknown', accessibility: 'unknown' } });
  // These samples predate the process and profile sections: unknown, not ready.
  assert.deepEqual(codes(result.unknowns), ['curtain_unverified', 'remote_input_owner_unverified', 'target_profile_unverified']);
  assert.equal(result.targetProfile.settings.stageManager, 'unknown');
  assert.equal(result.targetProfile.inputSource.matches, 'not_declared');
});

test('redacted laptop sample reads TCC and leaves the VNC account privileges unknown', async () => {
  const result = evaluatePreflight(parseProbeOutput(await fixture('laptop-26.7.1-tcc-readable.txt')));
  assert.equal(result.status, 'warn');
  assert.deepEqual(codes(result.warnings), ['host_not_installed']);
  assert.equal(result.screenSharing.observeOnly, 'unknown');
  assert.match(result.unknowns[0].message, /VNC account were not readable/);
  assert.equal(result.screenSharing.legacyVncPassword, 'unknown');
  assert.equal(result.session.displaySleepPrevented, false);
  assert.equal(result.session.displaySleepMinutes, 0);
  assert.equal(result.session.screenSharingActivity, false);
  assert.deepEqual(result.session.secureInput, { held: false });
  assert.deepEqual(result.host.grants, { source: 'tcc', screenRecording: 'not_recorded', accessibility: 'not_recorded' });
  assert.deepEqual(codes(result.unknowns), ['observe_only_unverified', 'remote_management_vnc_control_unverified',
    'curtain_unverified', 'remote_input_owner_unverified', 'target_profile_unverified']);
  assert.deepEqual(result.session.remoteInputOwners, 'unknown');
  // An empty section is unknown for every key, never absent or ready.
  assert.equal(result.screenSharing.vncControl, 'unknown');
  assert.equal(result.screenSharing.allLocalUsersPrivileges, 'unknown');
  assert.deepEqual(result.screenSharing.remoteManagementPrefs, { VNCLegacyConnectionsEnabled: 'unknown',
    ARD_AllLocalUsers: 'unknown', ARD_AllLocalUsersPrivs: 'unknown', ScreenSharingReqPermEnabled: 'unknown' });
});

test('live Screen Sharing input sample warns and says it may be Fruitctl itself', async () => {
  const sample = await fixture('pmset-assertions-screensharing-input.txt');
  assert.equal(parsePmsetAssertions(sample).screenSharingActivity, true);
  const result = await evaluateWith({ pmset_assertions: { output: sample } });
  const warning = result.warnings.find(item => item.code === 'screen_sharing_input_recent');
  assert.match(warning.message, /may be Fruitctl's own session/);
});

test('Apple remote modes fail typed: disabled, observe only, no control and High Performance', async () => {
  assert.equal(parseScreenSharingOverride('read=ok'), 'disabled');
  assert.equal(parseScreenSharingOverride('read=ok\n\t"com.apple.screensharing" => false'), 'enabled');
  assert.equal(parseScreenSharingOverride('read=ok\n\t"com.apple.screensharing" => disabled'), 'disabled');
  const disabled = await evaluateWith({ screensharing_override: { output: 'read=ok\n\t\t"com.apple.screensharing" => disabled' } });
  assert.equal(disabled.screenSharing.mode, 'off');
  assert.deepEqual(codes(disabled.failures), ['screen_sharing_disabled']);
  const plain = await evaluateWith({ remote_management_marker: { output: 'value=disabled' } });
  assert.equal(plain.screenSharing.mode, 'screen_sharing');
  assert.equal(plain.screenSharing.observeOnly, 'unknown');
  assert.match(plain.unknowns[0].message, /input probe/);

  const allUsers = privileges => ({ remote_management_prefs: { output: `ARD_AllLocalUsers=1\nARD_AllLocalUsersPrivs=${privileges}` } });
  assert.deepEqual(codes((await evaluateWith(allUsers(0x400001ff))).failures), ['observe_only']);
  assert.deepEqual(codes((await evaluateWith(allUsers(0x40000001))).failures), ['remote_control_not_permitted']);
  // kickstart writes signed values; 0xC00000FF is full control with access.
  assert.equal((await evaluateWith(allUsers(-1073741569))).screenSharing.observeOnly, false);
  assert.deepEqual(parseNaprivs('naprivs: -1073741569'), { state: 'read', privileges: 0xC00000FF });
  assert.deepEqual(parseNaprivs('naprivs=unreadable'), { state: 'unreadable' });
  assert.deepEqual(parseNaprivs(''), { state: 'unreadable' });
  assert.deepEqual(parseNaprivs('user=unset'), { state: 'unset' });
  assert.deepEqual(parseRemoteManagementPrefs('ARD_AllLocalUsers=yes\nVNCLegacyConnectionsEnabled=0\nOther=1'),
    { VNCLegacyConnectionsEnabled: false });

  const hp = await evaluateWith({ displays: { output: 'display=Screen Sharing Virtual Display\nonline=Yes\nvirtual=Yes' } });
  assert.equal(hp.screenSharing.highPerformance, true);
  assert.deepEqual(codes(hp.failures), ['high_performance_session']);
  const unreadable = await evaluateWith({ displays: { output: '', status: 1 } });
  assert.equal(unreadable.screenSharing.highPerformance, 'unknown');
  assert.ok(codes(unreadable.unknowns).includes('displays_unverified'));
  assert.deepEqual(parseDisplays({ status: 0, output: 'display=Panel\nonline=No' }),
    { known: true, count: 1, online: 0, screenSharingVirtual: false });
});

test('Remote Management with VNCLegacyConnectionsEnabled 0 warns about third-party RFB control', async () => {
  const sample = parseProbeOutput(await fixture('remote-management-vnc-control-disabled.txt')).get('remote_management_prefs');
  const result = await evaluateWith({ remote_management_prefs: sample });
  assert.equal(result.screenSharing.mode, 'remote_management');
  assert.deepEqual(codes(without(result.warnings)), ['remote_management_vnc_control_disabled']);
  assert.deepEqual(result.failures, []);
  const warning = result.warnings.find(item => item.code === 'remote_management_vnc_control_disabled');
  assert.match(warning.message, /observed dropped in this configuration on PZM/);
  assert.match(warning.message, /Causality is not isolated: a ~2\.5 s post-auth input-ignore window, now handled by the controller's --input-settle-ms, confounded the test/);
  assert.deepEqual(result.screenSharing.remoteManagementPrefs, { VNCLegacyConnectionsEnabled: false, ARD_AllLocalUsers: true,
    ARD_AllLocalUsersPrivs: 0xC00000FF, ScreenSharingReqPermEnabled: 'absent' });
  assert.equal(result.screenSharing.vncControl, 'disabled');
  assert.equal(result.screenSharing.allLocalUsersPrivileges, 'control');
  assert.equal(result.screenSharing.legacyVncPassword, false);

  // Plain Screen Sharing and Screen Sharing off do not apply the Remote Management check.
  const plain = await evaluateWith({ remote_management_prefs: sample, remote_management_marker: { output: 'value=disabled' } });
  assert.equal(plain.screenSharing.mode, 'screen_sharing');
  assert.equal(plain.screenSharing.vncControl, 'not_applicable');
  assert.ok(!codes(plain.warnings).includes('remote_management_vnc_control_disabled'));
  assert.deepEqual(evaluateVncControl({ mode: 'off', prefs: { VNCLegacyConnectionsEnabled: false } }), { vncControl: 'not_applicable' });
  // An unknown mode or an unreadable key is unknown, never a pass.
  const unsure = await evaluateWith({ remote_management_prefs: sample, remote_management_marker: { output: 'absent' } });
  assert.equal(unsure.screenSharing.vncControl, 'unknown');
  assert.ok(codes(unsure.unknowns).includes('remote_management_vnc_control_unverified'));
  assert.ok(!codes(unsure.warnings).includes('remote_management_vnc_control_disabled'));
  for (const output of ['read=failed\nVNCLegacyConnectionsEnabled=absent', 'read=ok\nVNCLegacyConnectionsEnabled=absent', '']) {
    const unread = await evaluateWith({ remote_management_prefs: { output } });
    assert.equal(unread.screenSharing.vncControl, 'unknown', output);
    const unknown = unread.unknowns.find(item => item.code === 'remote_management_vnc_control_unverified');
    assert.match(unknown.message, /VNCLegacyConnectionsEnabled was not readable/, output);
  }
  assert.deepEqual(describeRemoteManagementPrefs('read=failed\nVNCLegacyConnectionsEnabled=absent\nARD_AllLocalUsers=1'),
    { VNCLegacyConnectionsEnabled: 'unknown', ARD_AllLocalUsers: true, ARD_AllLocalUsersPrivs: 'unknown', ScreenSharingReqPermEnabled: 'unknown' });
  assert.deepEqual(describeRemoteManagementPrefs('read=ok\nVNCLegacyConnectionsEnabled=absent\nARD_AllLocalUsersPrivs=junk'),
    { VNCLegacyConnectionsEnabled: 'absent', ARD_AllLocalUsers: 'unknown', ARD_AllLocalUsersPrivs: 'unknown', ScreenSharingReqPermEnabled: 'unknown' });
  // Legacy VNC on is the existing password warning, not this one.
  const legacy = await evaluateWith({ remote_management_prefs: { output: 'read=ok\nVNCLegacyConnectionsEnabled=1' } });
  assert.equal(legacy.screenSharing.vncControl, 'enabled');
  assert.deepEqual(codes(without(legacy.warnings)), ['legacy_vnc_password_enabled']);
});

test('ARD_AllLocalUsersPrivs without control, or with observe only, warns; unreadable stays unknown', async () => {
  const privs = (value, allUsers = 0) => ({ remote_management_prefs: { output:
    `read=ok\nARD_AllLocalUsers=${allUsers}\nARD_AllLocalUsersPrivs=${value}\nVNCLegacyConnectionsEnabled=1` } });
  const noControl = await evaluateWith(privs(0x40000001));
  assert.deepEqual(codes(without(noControl.warnings)), ['legacy_vnc_password_enabled', 'all_local_users_control_not_granted']);
  assert.match(without(noControl.warnings).at(-1).message, /0x40000001 lacks the Control and Observe bit \(0x02\)/);
  assert.equal(noControl.screenSharing.allLocalUsersPrivileges, 'restricted');
  const observe = await evaluateWith(privs(0x40000102));
  assert.deepEqual(codes(without(observe.warnings)), ['legacy_vnc_password_enabled', 'all_local_users_observe_only']);
  assert.match(without(observe.warnings).at(-1).message, /0x40000102 has the Observe-only bit \(0x100\)/);
  const both = await evaluateWith(privs(0x101));
  assert.deepEqual(codes(without(both.warnings)).slice(1), ['all_local_users_control_not_granted', 'all_local_users_observe_only']);
  const ready = await evaluateWith(privs(-1073741569));
  assert.deepEqual(codes(without(ready.warnings)), ['legacy_vnc_password_enabled']);
  assert.equal(ready.screenSharing.allLocalUsersPrivileges, 'control');
  // With access for all local users on, the same value is already a failure.
  const applied = await evaluateWith(privs(0x40000102, 1));
  assert.deepEqual(codes(applied.failures), ['observe_only']);
  assert.ok(!codes(applied.warnings).includes('all_local_users_observe_only'));
  // Unreadable or absent privileges are unknown, never control.
  for (const value of ['absent', 'junk']) {
    const unread = await evaluateWith(privs(value));
    assert.equal(unread.screenSharing.allLocalUsersPrivileges, 'unknown', value);
    assert.ok(!codes(unread.warnings).some(code => code.startsWith('all_local_users_')), value);
  }
  assert.deepEqual(evaluateAllLocalUsersPrivileges({ remoteManagement: 'off', prefs: { ARD_AllLocalUsersPrivs: 0x100 } }),
    { state: 'restricted', warnings: [] });
});

test('the Remote Management prefs probe separates set, absent and unreadable keys', () => {
  const lines = PROBE_SCRIPT.split('\n');
  const start = lines.indexOf('begin remote_management_prefs');
  const body = lines.slice(start + 1, lines.indexOf('end remote_management_prefs 0')).join('\n');
  const run = stub => spawnSync('/bin/sh', ['-c', `${stub}\n${body}`]).stdout.toString();
  const readable = run(`defaults() {
  case "$*" in
    'read /Library/Preferences/com.apple.RemoteManagement') return 0 ;;
    'read /Library/Preferences/com.apple.RemoteManagement VNCLegacyConnectionsEnabled') printf '0\\n' ;;
    'read /Library/Preferences/com.apple.RemoteManagement ARD_AllLocalUsersPrivs') printf -- '-1073741569\\n' ;;
    *) return 1 ;;
  esac
}`);
  assert.equal(readable, ['read=ok', 'ARD_AllLocalUsers=absent', 'ARD_AllLocalUsersPrivs=-1073741569',
    'VNCLegacyConnectionsEnabled=0', 'ScreenSharingReqPermEnabled=absent', ''].join('\n'));
  assert.deepEqual(describeRemoteManagementPrefs(readable), { VNCLegacyConnectionsEnabled: false, ARD_AllLocalUsers: 'absent',
    ARD_AllLocalUsersPrivs: 0xC00000FF, ScreenSharingReqPermEnabled: 'absent' });
  const unreadable = run('defaults() { return 1; }');
  assert.match(unreadable, /^read=failed\n/);
  assert.equal(Object.values(describeRemoteManagementPrefs(unreadable)).every(value => value === 'unknown'), true);
});

test('regression: a failed print-disabled read is unverified, not disabled', async () => {
  for (const output of ['read=failed', '']) {
    assert.equal(parseScreenSharingOverride(output), 'unknown');
    const result = await evaluateWith({ screensharing_override: { output } });
    assert.equal(result.screenSharing.mode, 'unknown');
    assert.ok(!codes(result.failures).includes('screen_sharing_disabled'));
    assert.ok(codes(result.unknowns).includes('screen_sharing_unverified'));
  }
});

test('regression: an absent or unreadable marker is unknown and readable privileges are still judged', async () => {
  for (const [output, reason] of [['absent', 'absent'], ['unreadable', 'unreadable'], ['value=maybe', 'unrecognized']]) {
    assert.deepEqual(parseRemoteManagementMarker({ status: 0, output }), { state: 'unknown', reason });
    const result = await evaluateWith({ remote_management_marker: { output },
      remote_management_prefs: { output: `ARD_AllLocalUsers=1\nARD_AllLocalUsersPrivs=${0x40000102}` } });
    assert.equal(result.screenSharing.remoteManagement, 'unknown');
    assert.equal(result.screenSharing.mode, 'unknown');
    assert.ok(codes(result.unknowns).includes('remote_management_unverified'));
    assert.deepEqual(codes(result.failures), ['observe_only'], output);
  }
  assert.deepEqual(parseRemoteManagementMarker(undefined), { state: 'unknown', reason: 'not_probed' });
  // Only an explicit off marker defers observe-only to the viewer.
  assert.deepEqual(evaluateObserveOnly({ remoteManagement: 'off',
    prefs: { ARD_AllLocalUsers: true, ARD_AllLocalUsersPrivs: 0x102 } }), { observeOnly: 'unknown', reason: 'viewer_choice' });
});

test('regression: per-user observe-only is judged for the configured VNC account only', async () => {
  const perUser = await evaluateWith({ vnc_naprivs: { output: 'naprivs: 258' } });
  assert.deepEqual(codes(perUser.failures), ['observe_only']);
  const unset = await evaluateWith({ vnc_naprivs: { output: 'user=unset' } });
  assert.equal(unset.screenSharing.observeOnly, 'unknown');
  assert.match(unset.unknowns.find(item => item.code === 'observe_only_unverified').message, /VNC account is not known/);
  // The console user's privileges are no longer read at all.
  assert.doesNotMatch(PROBE_SCRIPT, /console_naprivs|"\/Users\/\$console_user" naprivs/);
  assert.equal(probeScript({ vncUser: 'operator' }).split('\n')[0], "vnc_user='operator'");
  for (const unsafe of ["x'; id; '", 'Jess Sullivan', '-oops', '$(id)', '', undefined, 7, 'a'.repeat(65)]) {
    assert.equal(probeScript({ vncUser: unsafe }).split('\n')[0], "vnc_user=''", String(unsafe));
    assert.equal(usableAccountName(unsafe), undefined);
  }
  // The remote side re-filters the name before dscl sees it.
  const shell = spawnSync('/bin/sh', ['-c', "vnc_user='-x'; case \"$vnc_user\" in ''|-*|*[!A-Za-z0-9._-]*) vnc_user= ;; esac; printf '%s' \"$vnc_user\""]);
  assert.equal(shell.stdout.toString(), '');
});

test('session state: login window and lock fail; extra sessions, secure input and sleep warn', async () => {
  const login = await evaluateWith({ console: { output: 'root' } });
  assert.deepEqual(codes(login.failures), ['no_console_session']);
  const lockedText = '      "IOConsoleLocked" = Yes\n      "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSessionLoginDoneKey"=Yes})';
  assert.deepEqual(codes((await evaluateWith({ ioreg_console: { output: lockedText } })).failures), ['screen_locked']);
  const two = '      "IOConsoleLocked" = No\n      "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionSecureInputPID"=77},{"kCGSSessionOnConsoleKey"=No,"CGSSessionScreenIsLocked"=Yes})';
  const sessions = parseConsoleSessions(two);
  assert.deepEqual(sessions, { known: true, locked: false, sessions: [
    { onConsole: true, loginDone: undefined, screenLocked: undefined, secureInputPid: 77 },
    { onConsole: false, loginDone: undefined, screenLocked: true }] });
  const extra = await evaluateWith({ ioreg_console: { output: two }, secure_input_process: { output: 'pid=77|/usr/bin/held' } });
  assert.deepEqual(codes(extra.failures), []);
  assert.ok(codes(extra.warnings).includes('additional_gui_sessions'));
  assert.equal(extra.session.locked, false);
  assert.deepEqual(extra.session.secureInput, { held: true, process: 'held' });

  assert.deepEqual([...parseSecureInputProcesses('pid=12|/Applications/A b.app/Contents/MacOS/A b\npid=13|\npid=x|name')],
    [[12, 'A b'], [13, undefined]]);
  const sleepy = await evaluateWith({ pmset_settings: { output: ' displaysleep         10' },
    pmset_assertions: { output: 'Assertion status system-wide:\n   PreventUserIdleDisplaySleep    0' } });
  assert.ok(codes(sleepy.warnings).includes('display_sleep_enabled'));
  assert.equal(parsePmsetSettings(' displaysleep         0').displaySleepMinutes, 0);
  const daemon = parsePmsetAssertions('Assertion status system-wide:\n   UserIsActive 1\nListed by owning process:\n   pid 9(screensharingd): [0x1] 00:00:01 UserIsActive named: "remote"');
  assert.equal(daemon.screenSharingActivity, true);
  assert.deepEqual(parsePmsetAssertions(''), { known: false, displaySleepPrevented: undefined, screenSharingActivity: undefined });
});

test('regression: missing or unparseable IOConsoleUsers is recorded unknown, never a pass', async () => {
  for (const output of ['', 'garbage', '      "IOConsoleLocked" = No']) {
    const result = await evaluateWith({ ioreg_console: { output } });
    assert.equal(result.session.locked, 'unknown', output);
    assert.equal(result.session.secureInput, 'unknown', output);
    assert.ok(codes(result.unknowns).includes('console_session_unverified'), output);
    assert.ok(!codes(result.warnings).includes('secure_input_held'));
  }
  const noLock = await evaluateWith({ ioreg_console: { output: '      "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes})' } });
  assert.equal(noLock.session.locked, 'unknown');
  assert.ok(codes(noLock.unknowns).includes('screen_lock_unverified'));
  assert.deepEqual(noLock.session.secureInput, { held: false });
});

test('regression: Secure Input uses the console session PID, not the last one listed', async () => {
  const ioreg = '      "IOConsoleLocked" = No\n      "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionSecureInputPID"=11},{"kCGSSessionOnConsoleKey"=No,"kCGSSessionSecureInputPID"=22})';
  const result = await evaluateWith({ ioreg_console: { output: ioreg },
    secure_input_process: { output: 'pid=11|/usr/bin/console-app\npid=22|/usr/bin/background-app' } });
  assert.deepEqual(result.session.secureInput, { held: true, process: 'console-app' });
  const background = '      "IOConsoleLocked" = No\n      "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes},{"kCGSSessionOnConsoleKey"=No,"kCGSSessionSecureInputPID"=22})';
  const other = await evaluateWith({ ioreg_console: { output: background }, secure_input_process: { output: 'pid=22|/usr/bin/background-app' } });
  assert.deepEqual(other.session.secureInput, { held: false });
  assert.match(PROBE_SCRIPT, /grep -o '"kCGSSessionSecureInputPID"=\[0-9\]\[0-9\]\*'/);
});

test('Host install, D7 default route and D10 grants produce the documented warnings', async () => {
  const installed = { host_app: { output: `user|present|${HOST_BUNDLE_ID}|0.1.0\nsystem|absent` } };
  const granted = { tcc: { output: 'system|readable\nsystem|row|kTCCServiceScreenCapture|2\nsystem|row|kTCCServiceAccessibility|2' } };
  const clean = await evaluateWith({ ...installed, ...granted }, { route: 'host' });
  assert.deepEqual(clean.warnings, []);
  assert.equal(clean.status, 'pass');
  assert.deepEqual(clean.host, { installed: true, location: 'user', version: '0.1.0',
    grants: { source: 'tcc', screenRecording: 'granted', accessibility: 'granted' } });
  assert.deepEqual(codes((await evaluateWith({ ...installed, ...granted }, { route: 'raw' })).warnings), ['host_installed_raw_route']);
  const denied = await evaluateWith({ ...installed, tcc: { output: 'system|readable\nsystem|row|kTCCServiceAccessibility|0' } }, { route: 'host' });
  assert.deepEqual(codes(denied.warnings), ['host_screen_recording_not_granted', 'host_accessibility_not_granted']);
  const unreadable = await evaluateWith({ ...installed, tcc: { output: 'system|unreadable' } }, { route: 'host' });
  assert.deepEqual(codes(unreadable.warnings), ['host_grants_unverified']);
  assert.deepEqual(parseHostApp('user|present|com.example.other|1.0\nsystem|absent'), { installed: false, foreignBundle: true });
  assert.deepEqual(parseHostApp('user|absent\nsystem|present|com.xoxd.fruitctl.host|'), { installed: true, location: 'system' });
});

test('regression: the system TCC database wins and user databases are not consulted', async () => {
  assert.deepEqual(parseTcc('system|readable\nsystem|row|kTCCServiceScreenCapture|0\nuser|row|kTCCServiceScreenCapture|2'),
    { source: 'tcc', screenRecording: 'denied', accessibility: 'not_recorded' });
  assert.deepEqual(parseTcc('system|readable\nsystem|row|kTCCServiceScreenCapture|2\nsystem|row|kTCCServiceScreenCapture|0'),
    { source: 'tcc', screenRecording: 'denied', accessibility: 'not_recorded' });
  // A user-database grant cannot stand in for an unreadable system database.
  assert.deepEqual(parseTcc('system|unreadable\nuser|readable\nuser|row|kTCCServiceScreenCapture|2'),
    { source: 'unreadable', screenRecording: 'unknown', accessibility: 'unknown' });
  assert.doesNotMatch(PROBE_SCRIPT, /Library\/Application Support\/com\.apple\.TCC\/TCC\.db.*\$HOME|\$HOME\/Library/);
});

test("regression: Host lookup uses the console user's home and reports unknown when it cannot", async () => {
  assert.match(PROBE_SCRIPT, /dscl \. -read "\/Users\/\$console_user" NFSHomeDirectory/);
  assert.doesNotMatch(PROBE_SCRIPT, /\$HOME\/Applications/);
  for (const output of ['user|unknown\nsystem|absent', 'system|absent', '']) {
    assert.equal(parseHostApp(output).installed, 'unknown', output);
    const result = await evaluateWith({ host_app: { output } });
    assert.ok(codes(result.unknowns).includes('host_install_unverified'));
    assert.ok(!codes(result.warnings).includes('host_not_installed'));
  }
  assert.deepEqual(parseHostApp('user|absent\nsystem|absent'), { installed: false });
});

test('D14: competing remote-input owners match exact names, never substrings or Apple parsecd', async () => {
  const sections = parseProbeOutput(await fixture('remote-input-processes.txt'));
  const parsed = parseRemoteInputProcesses(sections.get('remote_input_processes'));
  assert.deepEqual(parsed, { known: true, processes: [{ owner: 'Parsec', process: 'parsecd' },
    { owner: 'TeamViewer', process: 'TeamViewer_Service' }, { owner: 'Jump Desktop', process: 'Jump Desktop Connect' }] });
  const result = await evaluateWith({ remote_input_processes: sections.get('remote_input_processes') });
  assert.deepEqual(without(result.warnings).map(item => [item.code, item.owner]), [['remote_input_owner_other', 'Parsec'],
    ['remote_input_owner_other', 'TeamViewer'], ['remote_input_owner_other', 'Jump Desktop']]);
  assert.match(without(result.warnings)[0].message, /^Parsec is running on this Mac \(parsecd\).*one input owner per Mac/);
  assert.ok(!codes(result.unknowns).includes('remote_input_owner_unverified'));

  // Apple's CoreParsec daemon alone is not Parsec, and a path-less assertion
  // holder named parsecd cannot name Parsec either.
  const apple = await evaluateWith({ remote_input_processes: { output: 'read=ok\n/System/Library/PrivateFrameworks/CoreParsec.framework/parsecd' },
    pmset_assertions: { output: 'Assertion status system-wide:\n   UserIsActive 1\nListed by owning process:\n   pid 9(parsecd): [0x1] 00:00:01 UserIsActive named: "x"' } });
  assert.deepEqual(apple.session.remoteInputOwners, []);
  assert.deepEqual(without(apple.warnings), []);

  // Assertion holders and WindowServer input tickles count without a process list.
  const holders = parseAssertionHolders(await fixture('bench-26.7.1-remote-management.txt'));
  assert.ok(holders.holders.has('remoting_me2me_host') && holders.input.has('remoting_me2me_host'));
  const bench = evaluatePreflight(parseProbeOutput(await fixture('bench-26.7.1-remote-management.txt')));
  assert.deepEqual(bench.session.remoteInputOwners, [{ owner: 'Chrome Remote Desktop', processes: ['remoting_me2me_host'],
    evidence: ['assertion', 'input'] }]);
  assert.match(bench.warnings.find(item => item.code === 'remote_input_owner_other').message,
    /Chrome Remote Desktop is holding a power assertion, sending input on this Mac/);
  assert.ok(codes(bench.unknowns).includes('remote_input_owner_unverified'));

  for (const output of ['read=failed', '']) {
    const unknown = await evaluateWith({ remote_input_processes: { output } });
    assert.equal(unknown.session.remoteInputOwners, 'unknown');
    assert.ok(codes(unknown.unknowns).includes('remote_input_owner_unverified'));
  }
  assert.deepEqual(evaluateRemoteInputOwners({ processes: { known: true, processes: [] },
    holders: { holders: new Set(['AnyDesk', 'AnyDeskUpdater']), input: new Set() }, assertionsKnown: true }),
  { owners: [{ owner: 'AnyDesk', processes: ['AnyDesk'], evidence: ['assertion'] }], complete: true });
});

test('D14: the remote grep keeps only exact owner basenames and filters on the target', () => {
  // Untruncated paths: without -ww, macOS ps over SSH cuts comm at 79 columns,
  // before the basename of /Library/PrivilegedHelperTools/ChromeRemoteDesktopHost.app/.../remoting_me2me_host.
  assert.match(PROBE_SCRIPT, /^if processes=\$\(ps -axww -o comm= 2>\/dev\/null\); then$/m);
  const line = PROBE_SCRIPT.split('\n').find(item => item.includes('"$processes" | grep -E'));
  for (const name of REMOTE_INPUT_OWNERS.flatMap(entry => entry.names)) assert.ok(line.includes(`|${name}|`) || line.includes(`(${name}|`) || line.includes(`|${name})`), name);
  const processes = ['/Applications/AnyDesk.app/Contents/MacOS/AnyDesk', '/Applications/AnyDeskUpdater.app/Contents/MacOS/AnyDeskUpdater',
    '/usr/local/bin/sunshine-helper', '/usr/local/bin/sunshine', '/Applications/TeamViewer.app/Contents/Helpers/TeamViewerHelper',
    '/System/Library/PrivateFrameworks/CoreParsec.framework/parsecd', '/sbin/launchd', 'RustDesk', 'xRustDesk'].join('\n');
  const shell = spawnSync('/bin/sh', ['-c', `processes=$1\n${line}`, 'sh', processes], { env: { ...process.env, LC_ALL: 'C' } });
  assert.equal(shell.stdout.toString(), ['/Applications/AnyDesk.app/Contents/MacOS/AnyDesk',
    '/System/Library/PrivateFrameworks/CoreParsec.framework/parsecd', '/usr/local/bin/sunshine', 'RustDesk', ''].join('\n'));
});

test('D12: a ready target passes and macOS defaults warn with stable codes', async () => {
  const ready = parseProbeOutput(await fixture('target-profile-ready.txt'));
  const clean = evaluateTargetProfile(parseTargetProfile(ready.get('target_profile')));
  assert.deepEqual(clean.warnings, []);
  assert.deepEqual(clean.unknown, []);
  assert.ok(Object.values(clean.settings).every(state => state === 'ready'));
  assert.equal(clean.appearance, 'light');

  const defaults = parseProbeOutput(await fixture('target-profile-macos-defaults.txt'));
  const result = await evaluateWith({ target_profile: defaults.get('target_profile') });
  assert.deepEqual(codes(without(result.warnings)), ['spaces_auto_rearrange_enabled', 'hot_corner_enabled',
    'click_wallpaper_reveals_desktop', 'menu_bar_auto_hides', 'reduce_transparency_off', 'press_and_hold_enabled',
    'smart_quotes_enabled', 'smart_dashes_enabled', 'autocorrect_enabled', 'auto_capitalization_enabled',
    'auto_period_enabled', 'shake_to_locate_enabled']);
  assert.match(result.warnings.find(item => item.code === 'hot_corner_enabled').message, /\(bottom-right\)/);
  assert.equal(result.warnings.find(item => item.code === 'hot_corner_enabled').setting, 'hotCorners');
  // An unreadable ByHost domain is unknown, never ready.
  assert.equal(result.targetProfile.settings.handoff, 'unknown');
  assert.equal(result.targetProfile.settings.stageManager, 'ready');
  assert.equal(result.targetProfile.appearance, 'dark');
  assert.match(result.unknowns.find(item => item.code === 'target_profile_unverified').message, /unreadable: handoff$/);
  assert.deepEqual(TARGET_PROFILE.map(item => item.code).sort(), [...new Set(TARGET_PROFILE.map(item => item.code))].sort());

  const stage = await evaluateWith({ target_profile: { output: 'scope=console_user\nuser|com.apple.WindowManager|GloballyEnabled|value|1' } });
  assert.ok(codes(stage.warnings).includes('stage_manager_enabled'));
  // A key the probe did not report is unknown; an unset key in a readable
  // domain is the macOS default (Handoff on).
  assert.equal(stage.targetProfile.settings.handoff, 'unknown');
  const handoff = evaluateTargetProfile(parseTargetProfile({ status: 0, output: 'scope=console_user\n' +
    'byhost|com.apple.coreservices.useractivityd|ActivityAdvertisingAllowed|absent\nbyhost|com.apple.coreservices.useractivityd|ActivityReceivingAllowed|value|0' }));
  assert.deepEqual(codes(handoff.warnings), ['handoff_enabled']);
  const hidden = evaluateTargetProfile(parseTargetProfile({ status: 0,
    output: 'scope=console_user\nuser|NSGlobalDomain|_HIHideMenuBar|value|1\nuser|NSGlobalDomain|AppleMenuBarVisibleInFullscreen|value|1' }));
  assert.equal(hidden.settings.menuBarAutoHide, 'deviation');
  const garbled = evaluateTargetProfile(parseTargetProfile({ status: 0,
    output: 'scope=console_user\nuser|com.apple.dock|mru-spaces|value|maybe\nuser|com.apple.dock|mru-spaces;id|value|0' }));
  assert.equal(garbled.settings.spacesAutoRearrange, 'unknown');
  const auto = evaluateTargetProfile(parseTargetProfile({ status: 0,
    output: 'scope=console_user\nuser|NSGlobalDomain|AppleInterfaceStyleSwitchesAutomatically|value|1' }));
  assert.equal(auto.appearance, 'auto');
});

test('D12: another SSH account or no console user leaves every profile setting unknown', async () => {
  for (const [scope, pattern] of [['other_user', /not the console user/], ['no_console_user', /No user owns the console/]]) {
    const result = await evaluateWith({ target_profile: { output: `scope=${scope}\nuser|com.apple.dock|mru-spaces|value|1` },
      input_sources: { output: `scope=${scope}\ncurrent|com.apple.keylayout.US` } }, { inputSource: 'com.apple.keylayout.US' });
    assert.ok(Object.values(result.targetProfile.settings).every(state => state === 'unknown'), scope);
    assert.equal(result.targetProfile.appearance, 'unknown');
    assert.match(result.unknowns.find(item => item.code === 'target_profile_unverified').message, pattern);
    assert.equal(result.targetProfile.inputSource.matches, 'unknown');
    assert.ok(codes(result.unknowns).includes('input_source_unverified'));
    assert.ok(!codes(result.warnings).includes('spaces_auto_rearrange_enabled'));
  }
  const missing = await evaluateWith({ target_profile: { output: '', status: 1 } });
  assert.match(missing.unknowns.find(item => item.code === 'target_profile_unverified').message, /not probed/);
  // The probe reads the console user's own preferences only as that user.
  assert.match(PROBE_SCRIPT, /elif \[ "\$ssh_user" = "\$console_user" \]; then profile_scope=console_user/);
  assert.match(PROBE_SCRIPT, /pref_domain byhost com\.apple\.coreservices\.useractivityd ActivityAdvertisingAllowed ActivityReceivingAllowed/);
});

test('D12: pref_domain separates set, unset and unreadable keys', () => {
  const lines = PROBE_SCRIPT.split('\n');
  const start = lines.indexOf('pref_domain() {');
  const body = lines.slice(start, lines.indexOf('}', start) + 1).join('\n');
  const stub = `defaults() {
  case "$*" in
    'read com.apple.dock') return 0 ;;
    'read com.apple.dock mru-spaces') printf '0\\n' ;;
    'read com.apple.dock wvous-br-corner') printf '14; id\\n2\\n' ;;
    '-currentHost read com.apple.coreservices.useractivityd'*) return 1 ;;
    *) return 1 ;;
  esac
}`;
  const shell = spawnSync('/bin/sh', ['-c', `${stub}\n${body}\npref_domain user com.apple.dock mru-spaces wvous-br-corner wvous-tl-corner\npref_domain byhost com.apple.coreservices.useractivityd ActivityAdvertisingAllowed`]);
  assert.equal(shell.stdout.toString(), ['user|com.apple.dock|mru-spaces|value|0', 'user|com.apple.dock|wvous-br-corner|value|14 id',
    'user|com.apple.dock|wvous-tl-corner|absent', 'byhost|com.apple.coreservices.useractivityd|ActivityAdvertisingAllowed|unreadable', ''].join('\n'));
  // `14 id` is not an integer: the corner is unknown, not ready.
  const parsed = parseTargetProfile({ status: 0, output: `scope=console_user\n${shell.stdout}` });
  assert.deepEqual(parsed.values.get('wvous-br-corner'), { state: 'value', value: '14 id' });
  assert.equal(evaluateTargetProfile(parsed).settings.hotCorners, 'unknown');
});

test('D12: the selected input source is reported and checked against the declared one', async () => {
  const ready = parseProbeOutput(await fixture('target-profile-ready.txt'));
  const parsed = parseInputSources(ready.get('input_sources'));
  assert.deepEqual(parsed, { scope: 'console_user', current: 'com.apple.keylayout.US',
    selected: [{ kind: 'Keyboard Layout', name: 'U.S.' }, { kind: 'Non Keyboard Input Method', id: 'com.apple.CharacterPaletteIM' }],
    enabled: [{ kind: 'Keyboard Layout', name: 'U.S.' }] });
  for (const declared of ['com.apple.keylayout.US', 'U.S.']) {
    const result = await evaluateWith({}, { inputSource: declared });
    assert.equal(result.targetProfile.inputSource.matches, true, declared);
    assert.deepEqual(without(result.warnings), []);
  }
  const undeclared = await evaluateWith({});
  assert.deepEqual(undeclared.targetProfile.inputSource, { current: 'com.apple.keylayout.US',
    selected: [{ kind: 'Keyboard Layout', name: 'U.S.' }], enabled: [{ kind: 'Keyboard Layout', name: 'U.S.' }],
    declared: null, matches: 'not_declared' });
  const wrong = await evaluateWith({}, { inputSource: 'com.apple.keylayout.British' });
  assert.deepEqual(codes(without(wrong.warnings)), ['input_source_mismatch']);
  assert.match(without(wrong.warnings)[0].message, /selected input source is com\.apple\.keylayout\.US \/ U\.S\.; this profile declares com\.apple\.keylayout\.British/);
  // An invalid declared value is ignored rather than echoed.
  assert.equal((await evaluateWith({}, { inputSource: 'x"; id' })).targetProfile.inputSource.matches, 'not_declared');

  // A selected input method is the active source; its underlying layout is not.
  const japanese = { output: ['scope=console_user', 'current|com.apple.keylayout.ABC', 'AppleSelectedInputSources|read',
    'AppleSelectedInputSources|(', 'AppleSelectedInputSources|{', 'AppleSelectedInputSources|"Bundle ID" = "com.apple.inputmethod.Kotoeri.RomajiTyping";',
    'AppleSelectedInputSources|"Input Mode" = "com.apple.inputmethod.Japanese";', 'AppleSelectedInputSources|InputSourceKind = "Input Mode";',
    'AppleSelectedInputSources|}', 'AppleSelectedInputSources|)', 'AppleEnabledInputSources|unreadable'].join('\n') };
  const method = await evaluateWith({ input_sources: japanese }, { inputSource: 'com.apple.keylayout.ABC' });
  assert.deepEqual(codes(without(method.warnings)), ['input_source_mismatch']);
  assert.equal(method.targetProfile.inputSource.enabled, 'unknown');
  assert.deepEqual(without((await evaluateWith({ input_sources: japanese }, { inputSource: 'com.apple.inputmethod.Japanese' })).warnings), []);

  // Old-style plist escapes decode; control characters and quotes are dropped.
  const escaped = parseInputSources({ status: 0, output: ['scope=console_user', 'current|unreadable', 'AppleSelectedInputSources|read',
    'AppleSelectedInputSources|{', 'AppleSelectedInputSources|"KeyboardLayout Name" = "U.S. International \\U2013 PC";',
    'AppleSelectedInputSources|InputSourceKind = "Keyboard Layout";', 'AppleSelectedInputSources|}'].join('\n') });
  assert.deepEqual(escaped.selected, [{ kind: 'Keyboard Layout', name: 'U.S. International – PC' }]);
  assert.equal(escaped.current, undefined);

  const unreadable = await evaluateWith({ input_sources: { output: 'scope=console_user\ncurrent|unreadable\nAppleSelectedInputSources|unreadable' } },
    { inputSource: 'com.apple.keylayout.US' });
  assert.equal(unreadable.targetProfile.inputSource.matches, 'unknown');
  assert.ok(codes(unreadable.unknowns).includes('input_source_unverified'));
  assert.ok(!codes(unreadable.warnings).includes('input_source_mismatch'));
});

test('the input-source filter keeps only structure and the four named fields', () => {
  const line = PROBE_SCRIPT.split('\n').find(item => item.includes('InputSourceKind|Input Mode'));
  const value = ['(', '        {', '        InputSourceKind = "Keyboard Layout";', '        "KeyboardLayout ID" = 0;',
    '        "KeyboardLayout Name" = "U.S.";', '    },', '        {', '        "Bundle ID" = "com.apple.CharacterPaletteIM";',
    '        InputSourceKind = "Non Keyboard Input Method";', '        "tsmPrivate" = "secret";', '    }', ')'].join('\n');
  const shell = spawnSync('/bin/sh', ['-c', `key=AppleSelectedInputSources\nvalue=$1\n${line}`, 'sh', value]);
  const output = shell.stdout.toString();
  assert.doesNotMatch(output, /KeyboardLayout ID|tsmPrivate|secret/);
  assert.deepEqual(parseInputSources({ status: 0, output: `scope=console_user\nAppleSelectedInputSources|read\n${output}` }).selected,
    [{ kind: 'Keyboard Layout', name: 'U.S.' }, { kind: 'Non Keyboard Input Method', id: 'com.apple.CharacterPaletteIM' }]);
});

test('the whole probe runs against stubbed macOS commands and parses back', () => {
  // Shell functions shadow the commands even after the script resets PATH.
  const stubs = `sw_vers() { printf 'ProductName:\\tmacOS\\nProductVersion:\\t26.7.1\\nBuildVersion:\\t25G313\\n'; }
uname() { printf 'arm64\\n'; }
stat() { printf 'operator\\n'; }
id() { printf 'operator\\n'; }
dscl() { return 1; }
launchctl() { return 1; }
ioreg() { return 1; }
pmset() { return 1; }
system_profiler() { return 1; }
sqlite3() { return 1; }
ps() { printf '/sbin/launchd\\n/Applications/Parsec.app/Contents/MacOS/parsecd\\n/System/Library/PrivateFrameworks/CoreParsec.framework/parsecd\\n'; }
defaults() {
  case "$*" in
    'read com.apple.dock'|'read NSGlobalDomain') return 0 ;;
    'read com.apple.dock mru-spaces') printf '1\\n' ;;
    'read NSGlobalDomain AppleInterfaceStyle') printf 'Dark\\n' ;;
    'read com.apple.HIToolbox AppleCurrentKeyboardLayoutInputSourceID') printf 'com.apple.keylayout.US\\n' ;;
    *) return 1 ;;
  esac
}`;
  const shell = spawnSync('/bin/sh', ['-c', `${stubs}\n${probeScript({ vncUser: 'operator' })}`], { env: { ...process.env, LC_ALL: 'C' } });
  const sections = parseProbeOutput(shell.stdout.toString());
  for (const name of ['remote_input_processes', 'target_profile', 'input_sources']) assert.ok(sections.has(name), name);
  const result = evaluatePreflight(sections, { inputSource: 'com.apple.keylayout.US' });
  assert.deepEqual(result.session.remoteInputOwners, [{ owner: 'Parsec', processes: ['parsecd'], evidence: ['process'] }]);
  assert.equal(result.targetProfile.scope, 'console_user');
  assert.equal(result.targetProfile.settings.spacesAutoRearrange, 'deviation');
  assert.equal(result.targetProfile.settings.stageManager, 'unknown');
  assert.equal(result.targetProfile.appearance, 'dark');
  assert.equal(result.targetProfile.inputSource.matches, true);
  const other = spawnSync('/bin/sh', ['-c', `${stubs}\nid() { printf 'admin\\n'; }\n${PROBE_SCRIPT}`]);
  const otherSections = parseProbeOutput(other.stdout.toString());
  assert.equal(otherSections.get('target_profile').output, 'scope=other_user');
  assert.equal(otherSections.get('input_sources').output, 'scope=other_user');
});

test('profile inputSource is optional, validated and passed to doctor', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-input-source-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  const write = profile => fs.writeFile(configPath, JSON.stringify({ schema: 'fruitctl.config.v1', targets: { desktop: profile } }));
  await write({ hostHelper: { sshHost: 'operator@target.example' }, inputSource: 'com.apple.keylayout.US' });
  assert.deepEqual(await resolvePreflightTarget({ configPath, target: 'desktop' }),
    { destination: 'operator@target.example', route: 'host', inputSource: 'com.apple.keylayout.US' });
  for (const bad of ['', '-x', 'a"b', 'x'.repeat(129), 7, 'line\nbreak']) {
    await write({ inputSource: bad });
    await assert.rejects(loadConfig(configPath), /inputSource/, JSON.stringify(bad));
  }
  const home = await fs.mkdtemp(path.join(directory, 'home-'));
  const sample = render(Object.fromEntries(parseProbeOutput(await fixture('laptop-26.7.1-tcc-readable.txt') + await fixture('target-profile-ready.txt'))));
  const result = await doctor({ home, macos: { destination: 'target.example', route: 'raw', inputSource: 'com.apple.keylayout.German' } },
    { preflightProbe: async () => sample });
  assert.ok(codes(result.targetPreflight.warnings).includes('input_source_mismatch'));
});

test('section framing ignores inline, unknown, unterminated and missing sections', async () => {
  const sections = parseProbeOutput('x @@fruitctl-probe sw_vers@@\n@@fruitctl-probe secret@@\nvalue\n@@fruitctl-status secret 0@@\n' +
    '@@fruitctl-probe arch@@\narm64\n@@fruitctl-status arch 0@@\n@@fruitctl-probe console@@\noperator\n');
  assert.deepEqual([...sections.keys()], ['arch']);
  assert.equal(parseProbeOutput(undefined).size, 0);
  const empty = evaluatePreflight(new Map());
  assert.equal(empty.status, 'fail');
  assert.deepEqual(codes(empty.failures), ['macos_version_unknown']);
  assert.equal(empty.screenSharing.mode, 'unknown');
  for (const code of ['screen_sharing_unverified', 'console_unverified', 'console_session_unverified', 'host_install_unverified']) {
    assert.ok(codes(empty.unknowns).includes(code), code);
  }
  assert.equal(empty.session.locked, 'unknown');
  assert.equal(empty.session.secureInput, 'unknown');
});

test('the fixed probe script parses and stays read-only', () => {
  const syntax = spawnSync('/bin/sh', ['-n'], { input: PROBE_SCRIPT });
  assert.equal(syntax.status, 0, syntax.stderr?.toString());
  for (const forbidden of [/\bkickstart\b/, /\bosascript\b/, /\btccutil\b/, /\bopen\s/, /\blog (show|stream)\b/,
    /\bdefaults (write|delete)\b/, /\bsudo\b/, /\blaunchctl (load|unload|bootstrap|bootout|kickstart|enable|disable|kill)\b/,
    /\bpmset -a\b/, /\brm\b/, /\bkill\b/, /\benv\b/, /\bprintenv\b/]) {
    assert.doesNotMatch(PROBE_SCRIPT, forbidden);
  }
  // Every launchd service dump is filtered on the target before it is sent.
  for (const line of PROBE_SCRIPT.split('\n').filter(line => /launchctl print /.test(line))) {
    assert.match(line, /launchctl print [^|]+\| grep /);
  }
  assert.ok(PROBE_SCRIPT.includes(`client = '${HOST_BUNDLE_ID}'`));
});

test('SSH destinations are explicit and options disable forwarding, TTY and multiplexing', () => {
  for (const bad of ['', '-oProxyCommand=sh', 'a b', 'host;id', 'x'.repeat(300), undefined]) {
    assert.throws(() => validateSshDestination(bad), /explicit host/);
  }
  // Bracketed IPv6 matches the host-helper validator; it is one argv entry.
  for (const good of ['target.example', 'operator@target.example', 'operator@[fd7a:115c::1]', '_svc@10.0.0.2']) {
    assert.equal(validateSshDestination(good), good);
  }
  const args = sshProbeArguments('operator@target.example');
  assert.deepEqual(args.slice(-3), ['--', 'operator@target.example', '/bin/sh -s']);
  for (const option of ['-oBatchMode=yes', '-oForwardAgent=no', '-oClearAllForwardings=yes', '-oControlMaster=no',
    '-oControlPath=none', '-oRequestTTY=no', '-T']) assert.ok(args.includes(option), option);
});

function fakeSpawn({ stdout = '', code = 0, hang = false } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kills = [];
    child.kill = signal => { child.kills.push(signal); child.signalCode = signal; setImmediate(() => child.emit('close', null)); };
    let input = '';
    child.stdin.on('data', chunk => { input += chunk; });
    child.stdin.on('finish', () => {
      calls.push({ command, args, options, input, child });
      if (hang) return;
      child.stderr.write('remote private diagnostic');
      child.stdout.end(stdout);
      child.exitCode = code;
      setImmediate(() => child.emit('close', code));
    });
    return child;
  };
  return { spawnImpl, calls };
}

test('probe runner sends the script on stdin with a minimal environment and bounded output', async t => {
  process.env.FRUITCTL_TEST_PRIVATE = 'must-not-pass';
  t.after(() => { delete process.env.FRUITCTL_TEST_PRIVATE; });
  const ok = fakeSpawn({ stdout: 'facts' });
  assert.equal(await runProbe('target.example', { spawnImpl: ok.spawnImpl }), 'facts');
  assert.equal(ok.calls[0].command, 'ssh');
  assert.equal(ok.calls[0].input, PROBE_SCRIPT);
  const named = fakeSpawn({ stdout: 'facts' });
  await runProbe('target.example', { spawnImpl: named.spawnImpl, vncUser: 'operator' });
  assert.equal(named.calls[0].input, probeScript({ vncUser: 'operator' }));
  assert.equal(ok.calls[0].options.env.FRUITCTL_TEST_PRIVATE, undefined);
  assert.ok(Object.keys(ok.calls[0].options.env).every(key => ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK'].includes(key)));

  await assert.rejects(runProbe('target.example', { spawnImpl: fakeSpawn({ code: 255 }).spawnImpl }),
    error => error.code === 'preflight_unreachable');
  await assert.rejects(runProbe('target.example', { spawnImpl: fakeSpawn({ stdout: 'x'.repeat(1024 * 1024 + 1) }).spawnImpl }),
    error => error.code === 'preflight_output_limit');
  const hung = fakeSpawn({ hang: true });
  await assert.rejects(runProbe('target.example', { spawnImpl: hung.spawnImpl, timeoutMs: 20 }),
    error => error.code === 'preflight_timeout');
  assert.deepEqual(hung.calls[0].child.kills, ['SIGKILL']);
  assert.throws(() => runProbe('-oProxyCommand=sh', { spawnImpl: ok.spawnImpl }), /explicit host/);

  const failed = await macosPreflight({ destination: 'target.example', route: 'raw',
    probe: async () => { throw Object.assign(new Error('Target preflight timed out'), { code: 'preflight_timeout' }); } });
  assert.equal(failed.status, 'fail');
  assert.deepEqual(codes(failed.failures), ['preflight_timeout']);
});

test('target resolution uses the operator profile or an explicit flag, never tool arguments', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-preflight-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ schema: 'fruitctl.config.v1', targets: {
    host: { hostHelper: { sshHost: 'operator@target.example' } },
    raw: { vnc: { host: '127.0.0.1', port: 5900, username: 'operator' } } } }));
  assert.deepEqual(await resolvePreflightTarget({ configPath, target: 'host' }),
    { destination: 'operator@target.example', route: 'host' });
  await assert.rejects(resolvePreflightTarget({ configPath, target: 'raw' }), /--target-ssh/);
  assert.deepEqual(await resolvePreflightTarget({ configPath, target: 'raw', targetSsh: 'target.example' }),
    { destination: 'target.example', route: 'raw', vncUser: 'operator' });
  await assert.rejects(resolvePreflightTarget({ configPath, target: 'missing' }), /Unknown target profile/);
  assert.deepEqual(await resolvePreflightTarget({ configPath: path.join(directory, 'absent.json'), targetSsh: 'target.example' }),
    { destination: 'target.example', route: 'unknown' });
  await assert.rejects(resolvePreflightTarget({ configPath, target: 'raw', targetSsh: 'a b' }), /explicit host/);
});

test('doctor attaches the preflight once and keeps installer results unchanged', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-preflight-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let probes = 0;
  const sample = await fixture('bench-26.7.1-remote-management.txt');
  const result = await doctor({ home, macos: { destination: 'target.example', route: 'raw', vncUser: 'operator' } },
    { preflightProbe: async (destination, options) => {
      probes++; assert.equal(destination, 'target.example'); assert.equal(options.vncUser, 'operator'); return sample;
    } });
  assert.equal(probes, 1);
  assert.equal(result.status, 'not-installed');
  assert.equal(result.targetPreflight.status, 'warn');
  assert.equal(result.targetPreflight.route, 'raw');
  const plain = await doctor({ home });
  assert.equal(plain.targetPreflight, undefined);
});

test('CLI scopes --macos to doctor and validates the destination before any SSH', async () => {
  await assert.rejects(run(process.execPath, [cliPath, 'install', '--macos']), error => /--macos is supported only by doctor/.test(error.stderr));
  await assert.rejects(run(process.execPath, [cliPath, 'doctor', '--target-ssh', 'target.example']), error => /requires doctor --macos/.test(error.stderr));
  await assert.rejects(run(process.execPath, [cliPath, 'doctor', '--macos', '--target-ssh=-oProxyCommand=sh',
    '--config', '/nonexistent/fruitctl.json']), error => error.code === 1 && /explicit host/.test(error.stderr));
  const { stdout } = await run(process.execPath, [cliPath, '--help']);
  assert.match(stdout, /doctor --macos/);
});

function bridgeSpawn({ stdout = '', code = 0 } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    calls.push({ command, args, options });
    setImmediate(() => {
      child.stderr.end('remote private diagnostic');
      child.stdout.end(stdout);
      child.exitCode = code;
      setImmediate(() => child.emit('close', code));
    });
    return child;
  };
  return { spawnImpl, calls };
}

test('a Linux seat routes doctor --macos through its Darwin bridge, which owns the profile', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-preflight-bridge-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const absent = path.join(directory, 'absent.json');
  const remoteProfile = path.join(directory, 'remote-profile.json');
  await fs.writeFile(remoteProfile, JSON.stringify({ schema: 'fruitctl.config.v1', targets: {
    pzm: { targetId: 'fixture-pzm', hostHelperFile: '/Users/controller/private/absent-binding.json' }
  } }));
  assert.deepEqual(await resolvePreflightTarget({ configPath: remoteProfile, target: 'pzm', bridge: 'neo' }),
    { bridge: 'neo', remoteCommand: 'fruitctl', target: 'pzm' });
  if (process.platform !== 'darwin') {
    assert.deepEqual(await resolvePreflightTarget({ configPath: remoteProfile, target: 'pzm', environmentBridge: 'neo' }),
      { bridge: 'neo', remoteCommand: 'fruitctl', target: 'pzm' });
  }
  assert.deepEqual(await resolvePreflightTarget({ configPath: absent, target: 'pzm', environmentBridge: 'neo' }),
    { bridge: 'neo', remoteCommand: 'fruitctl', target: 'pzm' });
  assert.deepEqual(await resolvePreflightTarget({ configPath: absent, target: 'pzm', targetSsh: 'pzm', environmentBridge: 'neo' }),
    { destination: 'pzm', route: 'unknown' }, 'an explicit --target-ssh stays a direct probe from this seat');
  assert.deepEqual(await resolvePreflightTarget({ configPath: absent, target: 'pzm', targetSsh: 'pzm', bridge: 'operator@neo',
    remoteCommand: '/nix/store/x/bin/fruitctl' }),
  { bridge: 'operator@neo', remoteCommand: '/nix/store/x/bin/fruitctl', target: 'pzm', targetSsh: 'pzm' });
  await assert.rejects(resolvePreflightTarget({ configPath: absent, target: 'pzm', bridge: 'neo', remoteCommand: 'fruitctl; id' }),
    /absolute executable/);
  await assert.rejects(resolvePreflightTarget({ configPath: absent, target: "pzm'; id", bridge: 'neo' }), /profile identifier/);
  await assert.rejects(resolvePreflightTarget({ configPath: absent, target: 'pzm', bridge: '-oProxyCommand=sh' }), /explicit host/);

  const remote = { schema: 'fruitctl.macos-preflight.v1', status: 'warn', route: 'raw', failures: [],
    warnings: [{ code: 'input_source_mismatch', message: 'fixture' }], unknowns: [] };
  const ok = bridgeSpawn({ stdout: JSON.stringify({ status: 'drift', targetPreflight: remote }), code: 1 });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-preflight-bridge-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const result = await doctor({ home, macos: { bridge: 'operator@neo', remoteCommand: '/nix/store/x/bin/fruitctl',
    target: 'pzm', targetSsh: 'pzm' } }, { bridgeSpawn: ok.spawnImpl });
  assert.equal(result.status, 'not-installed', 'the local installer result is unchanged');
  assert.deepEqual(result.targetPreflight, { ...remote, via: 'bridge', bridge: 'operator@neo' });
  assert.equal(ok.calls.length, 1);
  const { command, args, options } = ok.calls[0];
  assert.equal(command, 'ssh');
  assert.equal(args.at(-2), 'operator@neo');
  assert.equal(args.at(-1), "'/nix/store/x/bin/fruitctl' 'doctor' '--macos' '--target' 'pzm' '--target-ssh' 'pzm'");
  assert.ok(args.includes('-oBatchMode=yes') && args.includes('--'));
  assert.equal(options.stdio[0], 'ignore');
  assert.ok(Object.keys(options.env).every(key => ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK'].includes(key)));
  assert.ok(!JSON.stringify(result).includes('remote private diagnostic'));

  const outcomes = [[{ code: 255 }, 'preflight_bridge_unreachable'], [{ code: 127 }, 'preflight_bridge_command_missing'],
    [{ code: 1, stdout: 'Fruitctl: Unknown target profile: pzm' }, 'preflight_bridge_refused'],
    [{ code: 0, stdout: JSON.stringify({ status: 'configured' }) }, 'preflight_bridge_refused']];
  for (const [fixture, code] of outcomes) {
    const failed = await bridgedPreflight({ bridge: 'neo', target: 'pzm' }, { spawnImpl: bridgeSpawn(fixture).spawnImpl });
    assert.equal(failed.status, 'fail');
    assert.equal(failed.via, 'bridge');
    assert.deepEqual(codes(failed.failures), [code]);
  }
});
