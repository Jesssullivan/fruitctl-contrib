# macOS permissions

Install the Fruitctl runtime and agent adapter with the [installation guide](install.md).
The target owner enables [Apple Screen Sharing](https://support.apple.com/guide/mac-help/mh11848/mac)
and supplies access through the controller's credential provider. This VNC route
does not capture the controller's local screen or require Fruitctl Host.

The optional Fruitctl Host adds target-side capture and the purple human
indicator. It remains outside public runtime payloads and automatic installation.
The Host steps below are an onboarding specification for a separately delivered,
qualified Host release; they do not make the current preview a Host installer.
The source targets Apple silicon macOS 15 or later. Check the
[compatibility matrix](compatibility.md) before selecting a released combination.

## Which machine needs permission?

| Component | What to configure |
| --- | --- |
| Agent adapter or Linux SSH bridge | Install the matching adapter; keep credentials on the Darwin controller. |
| Darwin VNC controller | Configure the target profile and [secret providers](secrets.md). It receives target pixels over VNC. |
| Target's Apple Screen Sharing | The target owner enables the service and chooses permitted users. |
| Optional Fruitctl Host on the target | The target user enables capture and grants that app Screen Capture and Accessibility access. |

The Host source supplies images, an Accessibility snapshot, element actions and
an indicator. It has no local input service and posts no synthetic events. The
Accessibility grant serves two purposes: reading the tree for `ax_snapshot`, and
`click_element` / `focus_element`, which ask one element from the latest snapshot
to perform `AXPress` or set `AXFocused`. Those element actions run only under the
controller's activity lease and stop when the human Stop latch is set. When an
element cannot perform the action, the controller sends one VNC click at the
element's centre through its ordinary input path. The Accessibility grant is
expected on a standard Host install (D10). Without it, capture still works, and
`ax_snapshot`, `click_element` and `focus_element` fail with the typed code
`accessibility_permission_required`. The Host requests no event-posting, input
monitoring, microphone or Full Disk Access policy. VNC input remains with the
controller and the target's Screen Sharing service.

## Unmanaged target: attended Host setup

Once a qualified Host artifact is available, the target user completes these
steps in their logged-in desktop session:

1. Install the exact signed app bundle from the Host release. Keep its bytes and
   identity intact, and launch the app normally in the target's desktop session.
2. Choose **Fruitctl → Enable capture**. If macOS requests access, enable that
   exact app in **System Settings → Privacy & Security → Screen & System Audio
   Recording**. Follow Apple's requested **Quit & Reopen** step when shown.
   [Apple's recording access guide](https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac)
   describes the user's setting; its title does not mean Fruitctl captures audio.
3. Enable that same app in **System Settings → Privacy & Security →
   Accessibility**. The Host never prompts for it. `FruitctlHost --doctor` and
   Host health report `accessibility_trusted` for the running process.
4. Start one attended capture through the configured Host attachment. A later
   direct-capture alert can require a separate choice even when the ordinary
   recording preflight is true. If access is declined or a prompt remains
   unresolved, end the attempt and return when the user is ready; do not repeat
   prompts or report capture success from preflight alone.
5. Confirm the chosen display produces complete images, the purple indication
   stays visible locally and absent from agent images, and **Fruitctl → Stop
   agent control** ends control and clears the indication. Record the exact
   release and macOS version before treating that route as qualified.

The app's capture choice and macOS permission are separate. **Disable capture**
withdraws the app's opt-in. The user can revoke macOS access in the same Privacy
settings. Stop remains in force through reconnect and wake for that running
Host session; restarting the app resets Stop, while capture opt-in, macOS
consent and a fresh controller lease remain required.

Launch the app bundle through the normal desktop application mechanism. Running
its internal executable from an SSH shell can change the privacy-responsible
process and does not establish access for the resident app. See Apple's
[responsibility-tracking guidance](https://developer.apple.com/forums/thread/125438).

## Managed target: let the user grant access

Apple's [PPPC schema](https://raw.githubusercontent.com/apple/device-management/release/mdm/profiles/com.apple.TCC.configuration-profile-policy.yaml)
requires the device channel of user-approved MDM and excludes manual profile
installation and User Enrollment. For Screen Capture, PPPC cannot grant access.
`AllowStandardUserToSetSystemService` lets a standard user make the permission
choice. The user still completes the attended setup above.

The [standard-user PPPC example](permissions/fruitctl-standard-user.mobileconfig.example)
contains only that Screen Capture policy. It is a template with unresolved
identity and profile fields, not a ready-to-deploy grant. An MDM administrator
prepares it for the exact signed Host release. Read the delivered bundle's
signing identity and designated requirement without launching it:

```sh
codesign --display --verbose=4 '/absolute/path/to/FruitctlHost.app'
codesign --display --requirements - '/absolute/path/to/FruitctlHost.app'
```

Then complete the profile and attended setup:

1. Verify the release's checksum, signature, bundle ID and Developer ID team.
   The Host source uses `com.xoxd.fruitctl.host`; confirm the delivered app matches.
2. Replace every `REPLACE_WITH_` field. Copy the actual requirement expression,
   excluding the output prefix `designated =>`, into `CodeRequirement`, preserving
   its constraints and XML-escaping special characters. Match its team constraint
   to the verified release team; do not derive a weaker rule from the bundle ID.
   Assign organization-specific profile identifiers and two distinct UUIDs.
3. Validate the completed profile through the MDM owner's normal process and
   deliver it through the device channel.
4. Have the target user enable capture, make the recording choice and complete
   the attended capture/Stop check. Profile delivery is not evidence that
   permission or capture succeeded.

The example has one `ScreenCapture` entry using `Authorization`; it does not
include `Allowed` or any other service. It does not yet carry the expected
Accessibility entry, so the target user grants Accessibility during the
attended setup above. Additional input services belong to a
separately justified input component, not this observation-only Host.

Apple's [Restrictions schema](https://raw.githubusercontent.com/apple/device-management/release/mdm/profiles/com.apple.applicationaccess.yaml)
also defines `forceBypassScreenCaptureAlert` from macOS 15.1. It is an MDM
presentation policy, unavailable through manual installation or User Enrollment.
It is omitted from this least-permission example and does not supply Screen
Capture access. A management owner may evaluate it separately for a qualified
capture route; no unmanaged equivalent is supplied here.

## Signing, updates and diagnosis

Developer ID signing and [notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
establish artifact identity and distribution checks. They do not grant Screen
Capture consent. Keep the bundle ID, verified team and compatible designated
requirement stable across releases, and check each new artifact against the
deployed policy. Apple's [code-signing guidance](https://developer.apple.com/library/archive/technotes/tn2206/_index.html)
explains how a designated requirement identifies code; each subsystem makes its
own policy decision. Existing consent surviving an update must be observed on
the supported macOS version, not assumed from signature validity.

`fruitctl doctor` reports installed runtime and adapter configuration. Its
`configured` result does not test the target connection, Host consent or screen
capture. `fruitctl doctor --macos` adds the target preflight below. For a
separately installed resident Host, distinguish these results:

| Observation | What it establishes |
| --- | --- |
| Release checksum and signature match | The artifact matches the selected release. |
| Host capture enabled | The app's local capture opt-in is on. |
| Host health reports `screen_capture_permission: true` | Ordinary permission preflight was true for that running process at that sample. |
| Fresh complete images from the configured display | The tested capture route worked for that episode. |
| Simultaneous human view, agent images and local Stop | Evidence for indicator exclusion and Stop behavior on the tested route. |

A true preflight does not rule out a prompt. On PZM (2026-10-17), macOS showed a Screen Recording
re-confirmation prompt on the first live capture even though health reported
`screen_capture_permission: true`. Attend the first Host-route capture on each target.

Capture refusals retain a matched request UUID, stable reason and, for supported
Apple framework failures, a bounded phase/domain/code diagnostic. Those values
can help locate a failure without exposing raw Apple error text or private
paths. A code alone is not permission status. A retired input lane remains
unavailable after a refusal; repair the known cause and establish a fresh
session rather than replaying uncertain actions.

## Target preflight

`fruitctl doctor --macos` checks the target over SSH. It writes a
`targetPreflight` object into doctor's JSON and exits 1 on any typed failure.

```sh
fruitctl doctor --macos --target PROFILE
fruitctl doctor --macos --target-ssh USER@HOST
```

It reaches the target in one of two ways:

- Through the profile's `hostHelper.sshHost`.
- Through `--target-ssh`, which raw VNC profiles need because they do not
  record an SSH host.

The SSH session runs one fixed script with no TTY, no forwarding and no agent
connection. The script does the following:

- Reads `sw_vers` and the console owner.
- Reads the Screen Sharing launchd override and filtered service state.
- Reads the Remote Management activation marker and four named
  `com.apple.RemoteManagement` keys.
- Reads the `naprivs` privileges of the profile's VNC account
  (`vnc.username`). The name is sent only if it is a plain macOS short name;
  otherwise per-user privileges are reported `unknown`.
- Reads the console session from the root IORegistry, including the console
  session's own Secure Input holder.
- Reads `pmset` settings and assertions, and the display list.
- Reads the Host bundle's identifier and version in the console user's
  `~/Applications` (found through `dscl`) and in `/Applications`.
- Reads the Host's rows in the system TCC.db, which decides Screen Recording
  and Accessibility. Per-user TCC databases are not read.
- Lists running processes and keeps, on the target, only the exact names of
  other remote desktop hosts.
- Reads the console user's [target profile](target-profile.md) settings and
  input sources with `defaults read`, only when the SSH account is the console
  user.

It does not:

- read the environment or logs;
- show prompts or launch apps;
- change services or settings.

| Result | Meaning |
| --- | --- |
| `os.supported` | macOS 26.6.1 or later, or any macOS 27 release ([compatibility](compatibility.md#macos-target-support)) |
| `screenSharing.mode` | `remote_management`, `screen_sharing`, `off` or `unknown` |
| `screenSharing.remoteManagementPrefs` | `VNCLegacyConnectionsEnabled`, `ARD_AllLocalUsers`, `ARD_AllLocalUsersPrivs` and `ScreenSharingReqPermEnabled` as read, `absent`, or `unknown` ([target profile](target-profile.md#remote-management-rfb-control)) |
| `failures` | Typed codes; the target is not usable as sampled |
| `targetProfile` | Each [target profile](target-profile.md) setting as `ready`, `deviation` or `unknown`, plus the input source |
| `session.remoteInputOwners` | Other remote desktop hosts found on the target, or `unknown` |
| `warnings` | Deviations from the Fruitctl-ready target profile |
| `unknowns` | Facts the probes could not establish |

The session and Host warnings are listed below. The
[target profile](target-profile.md) lists each settings warning, such as
`stage_manager_enabled` or `smart_quotes_enabled`, with the reason it matters.

| Warning | Condition |
| --- | --- |
| `legacy_vnc_password_enabled` | The legacy VNC password is on (CVE-2026-43760, CVE-2026-43665). |
| `remote_management_vnc_control_disabled` | Remote Management is on and `VNCLegacyConnectionsEnabled` is 0. Third-party RFB input was observed dropped in this configuration; causality is not isolated ([target profile](target-profile.md#remote-management-rfb-control)). |
| `all_local_users_control_not_granted`, `all_local_users_observe_only` | `ARD_AllLocalUsersPrivs` lacks the Control and Observe bit (0x02) or has the Observe-only bit (0x100). With access for all local users on, this is the `remote_control_not_permitted` or `observe_only` failure instead. |
| `secure_input_held` | Another process holds Secure Input; typed input may be refused. |
| `screen_sharing_input_recent` | A Screen Sharing client sent input recently. This may be Fruitctl's own session; otherwise another client is active, and each Mac should have only one input owner. |
| `remote_input_owner_other` | Another remote desktop host (for example Chrome Remote Desktop, TeamViewer or Parsec) is running, holds a power assertion or sent input. The finding's `owner` names it. Each Mac should have one input owner. |
| `input_source_mismatch` | The selected input source differs from the profile's `inputSource`. |
| `additional_gui_sessions` | GUI sessions exist off the console. |
| `display_sleep_enabled` | The display sleeps. |
| `no_online_display` | No display is online. |
| `host_not_installed` | The Host is not installed. Only the raw VNC route is available, with no indicator. |
| `host_installed_raw_route` | The Host is installed, but the profile still uses the raw route. Configure `hostHelper` to make the Host the default. |
| `host_screen_recording_not_granted` | The Host has no Screen Recording grant. |
| `host_accessibility_not_granted` | The Host has no Accessibility grant. |
| `host_grants_unverified` | The SSH session could not read the system TCC.db. |

The Host route with Screen Recording and Accessibility granted is the standard
macOS install. Raw VNC with no grants is the degraded fallback. The Host uses
Accessibility for `ax_snapshot`, `click_element` and `focus_element`. Without the
grant those actions fail with `accessibility_permission_required` while capture
continues. The raw route refuses all three with `unsupported_on_route`.

Reading TCC.db needs Full Disk Access for the SSH session. Doctor does not
need it, and it is optional. Without it, both grants read as `unknown`;
doctor never reports them as missing, and it never requests or grants access.

**Caution:** macOS grants this only through Remote Login's "Allow full disk
access for remote users" setting. That setting gives every SSH session for
every allowed user Full Disk Access, not just doctor. Turn it on only if the
target's SSH access is already trusted at that level. Leaving it off is a
supported configuration.

When doctor cannot establish a fact, it lists it in `unknowns` instead of
reporting a pass. That includes an unreadable Screen Sharing override, an
absent or unreadable Remote Management marker, a missing IOConsoleUsers list
(screen lock and Secure Input), RFB control under Remote Management that
cannot be judged (`remote_management_vnc_control_unverified`), a console user
home that cannot be checked for the Host, an unreadable process list
(`remote_input_owner_unverified`), and target profile settings that were not
read (`target_profile_unverified`, `input_source_unverified`).

macOS 27 delivers managed grants through Declarative Device Management. The
TCC.db layout on 27 has not been sampled yet.

Every MCP tool result carries `route` (`host` or `raw`) and `indicator`
(`present`, `absent` or `unknown`) in its structured output, and `health`
also prints them as text:

- The raw VNC route always reports `indicator: absent`.
- The Host route reports `present` only while its activity receipt confirms
  the overlay. Otherwise it reports `unknown`.
- A broker that predates these labels reports both values as `unknown`.

A failed result also carries `error` as one object, `{code, message, data}`,
beside the same labels. A native typed failure keeps its JSON-RPC `code` and
`data` (for example `-32010` `stale_screen` with `data.reason`, `-32011` for an
input refusal such as `hold_outside_batch`, or `-32012` for an unmet
`wait_for_stable` or queue expectation). A local refusal made
before anything ran keeps its string code: `unsupported_action`,
`unsupported_on_route` (the Host route refuses raw-pixel observations) or
`unsupported_expectation` (a reserved queue expectation). A Linux relay or
broker-socket failure keeps its string code too: `bridge_lost`,
`bridge_protocol` or `bridge_unconfirmed` (work may have been in flight), any
other `bridge_*` code or `broker_unavailable` (not delivered). Any other transport
or local failure carries `message` only. A failed `action_queue` adds `completed`
and `failedIndex` and puts its first failure in the same `error` object. A
failure never attests the overlay, so the Host route reports `indicator:
unknown` on every error.

## Persistent Content Capture: operator request checklist

Apple's [Persistent Content Capture entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture)
is a separate VNC capability available from macOS 14.4. Apple requires permission
before adding it to the app's Xcode profile. Fruitctl has a prepared request
draft, with no submission or approval established. The public preview includes
neither this entitlement nor a signed Host distribution.

The developer-program owner can use this checklist to finish the request:

1. Confirm the team, explicit Host App ID, program membership and submitting
   Account Holder. Read the actual capability's eligibility and terms; do not
   assume a particular enterprise program or permitted distribution channel.
   Apple's [capability request process](https://developer.apple.com/help/account/capabilities/capability-requests)
   requires the Account Holder role and describes team submission.
2. Prepare the VNC rationale: the proposed Host captures a user-configured target
   display for authorized agent sessions while excluding its locally visible
   activity indicator; input stays on VNC. Describe user opt-in, local Stop,
   lease expiry and session/display-change revocation. Separate implemented
   design from physically qualified behavior. Use synthetic demonstration data,
   not private desktops, credentials or agent conversations.
3. Submit through Apple's [Persistent Content Capture request form](https://developer.apple.com/contact/request/persistent-content-capture/).
   Ask for the exact Developer ID distribution eligibility, profile instructions
   and remaining user-consent requirements. Record the actual response privately;
   this guide does not establish those terms or promise prompt-free access.
4. If approved, follow the assigned conditions for a new producer-built Host
   artifact. Verify the entitlement, authorized profile, team and designated
   requirement together, then sign, notarize and qualify that exact release.
   Apple's [managed-capability provisioning guide](https://developer.apple.com/help/account/reference/provisioning-with-managed-capabilities/)
   explains profile inclusion and distribution-specific eligibility. Consumers
   never add an entitlement to or re-sign an existing released binary.

Publishing this guide, an example or a request draft does not establish Apple
approval, MDM deployment, retained consent after an upgrade, or physical Host
acceptance. Those remain separately recorded release outcomes.
