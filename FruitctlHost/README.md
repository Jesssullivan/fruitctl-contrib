# Fruitctl Host source

This optional macOS 15+ Apple silicon app renders the purple human indicator
and captures its configured display through ScreenCaptureKit. The existing
LibVNC client and input writer remain on the controlling Darwin seat; the
target continues to serve Apple Screen Sharing. This app has no input service.
With the Accessibility grant it also returns a read-only Accessibility snapshot.

The indicator is allowed only for the owned ScreenCaptureKit observation path.
Each capture excludes the complete running Fruitctl Host application, identified
by process ID and bundle ID, so its border and centered text belong outside
that capture. Ordinary VNC viewers and native Apple Screen Sharing capture
have no exclusion guarantee. `raw_vnc_exclusion` is always `false`. No private
capture APIs, window-sharing exclusion assumptions, pixel masking, or temporary
indicator hiding are used.

The source is an implementation candidate. A successful compile and offline
lease tests do not qualify live exclusion, Retina mapping, fullscreen behavior,
TCC behavior, or crash cleanup. Those remain attended acceptance gates.

## Build and offline checks

Run the shared receipt-producing build rail on the designated Darwin ARM64
build host, with an exclusive output directory:

```sh
./scripts/build-host.sh --output-dir /absolute/task-owned/new-build --jobs 2 \
  --reuse-inputs /absolute/task-owned/verified-native-dependency-build
```

The wrapper selects only `FruitctlHost` and `FruitctlHostTests`. The shared rail
checks its pinned dependency carrier, records exact source and output hashes,
and rejects source changes during a build. Omit `--reuse-inputs` only when that
rail must regenerate the reviewed dependencies. The app itself links Apple
frameworks and has no LibVNC or OpenSSL code dependency. Source builds are
unsigned; release signing is a separate artifact step. These checks perform
no GUI launch or live capture, and do not grant screen-recording permission.

### Explicit developer launch tool

The source-only [LaunchServices utility](../scripts/qualification/README.md)
provides one explicit no-argument launch from an operator-bound private runtime
request, without recompiling installation paths or previous PIDs. It is not
included in runtime releases and neither the broker nor installer invokes it.
Its build runs only pure request/completion checks; actual launch remains a
separate attended action with caller-owned artifact/signature, kernel identity
and app-health checks. A timeout or rejected callback is unknown and never
automatically retried. This utility does not change capture opt-in or TCC.

## Startup and permissions

The product app identity is `com.xoxd.fruitctl.host`. Release signing and
notarization apply to the complete bundle; they do not grant screen recording.
Capture is disabled on a fresh install. An attended launch may select
`--enable-capture`, optionally `--display-id <configured-display-id>` or
`--display-uuid <display-uuid>` (not both). The UUID is resolved with
`CGDisplayCreateUUIDFromDisplayID` over the online display list at launch and
again after every display reconfiguration, so it survives display-ID changes.
An absent UUID exits with `configured_display_unavailable` instead of falling
back to the main display; one that disappears later binds no display and fails
closed. `--doctor` lists each online display's ID, UUID and geometry. This
explicit choice persists in the app's preferences before any OS consent request,
so macOS Quit & Reopen can drop startup arguments without losing the choice.
`--disable-capture` persists the opposite choice. A screen-recording grant alone
never enables capture. Only an attended
`--enable-capture --request-screen-capture` launch may request startup permission.
`--help`, `--doctor`, and `--stdio` never initialize AppKit application UI or
request permission. The app cannot silently enable Screen Sharing or TCC.

The resident app provides a standard menu bar item with **Stop agent control**,
**Allow agent control**, **Enable capture**, **Disable capture**, and
**Arm one idle reference export (60s)**, and **Quit Fruitctl Host**.
The local Enable capture action persists opt-in and may
request OS consent; Disable capture persists opt-out, clears the current lease,
hides panels, and prevents begin/capture. Neither action clears human stop or
creates a lease. IPC cannot enable capture, grant permission, or change these
preferences. Stop immediately invalidates
the app's lease, hides panels, and latches begin/renew/capture/AX snapshot/AX action unavailable. Only
the local menu's Allow action clears that latch; IPC and session/display wake
events cannot clear it. Allow establishes no lease and does not override other
readiness checks. The latch lasts for the resident process lifetime; restarting
the app is a new attended launch. The menu uses AppKit and requests no
Accessibility permission; `ax_snapshot`, `ax_action` and `ax_verify` only use a
grant the user made in System Settings.

The persistent capture choice and process-local human stop latch are distinct.
After any restart, a controller still needs a fresh lease and complete excluded
capture; retaining opt-in does not restore an old lease or input permit.

When the app and controlling broker are responsive, human stop makes the next
renewal fail and the broker's local input permit expires within one second.
This is no guarantee that a frozen broker or UI halts an already emitted remote
input instantly. These timing and stop-menu usability claims require the
attended run below; process-crash and hung-UI cases remain distinct.

`FruitctlHost.app/Contents/MacOS/FruitctlHost --stdio` is an attach shim for an
already running, same-user Aqua instance. It does not launch the app. Neo starts
the shim over its established SSH path. It forwards NDJSON to the app's private
Unix socket at `~/Library/Application Support/Fruitctl/run/host.sock`.
The runtime directory is mode 0700; the socket is 0600, same-user peers only.
An existing live listener is never taken over. Restart may remove only a socket
whose owner and inode remain unchanged after its local connection is refused.
There is no TCP listener, launch-agent installation, or process cleanup policy.

## Attach protocol

Requests use `{"action":"...","params":{...},"id":"request-id"}`; `method`
also accepts the legacy action field. IDs are strings or integers. Responses
are `{"id":"request-id","success":true,"result":{...}}`, or
`{"id":"request-id","success":false,"error":{"code":-32000,"message":"..."}}`.
Each request is one newline-terminated UTF-8 JSON record, at most 65,536 bytes.
Each connection is serialized, and at most eight same-user connections attach.

| Action | Parameters and behavior |
| --- | --- |
| `health` | Read-only capability/readiness and permission preflight; starts no capture. |
| `begin_activity` | `session_id`, positive integer `sequence`, `challenge`; optional `display_id` must match startup configuration, and `capture_backend` must be `owned_sck`. Reserves this connection's lease, verifies one complete excluded-app screenshot, then shows the indicator and acknowledges. |
| `renew_activity` | Same session/connection, strictly increasing `sequence`, fresh `challenge`; requires recent main-thread heartbeat and capture/UI readiness. |
| `release_activity` | `session_id`; releases only this connection's activity and hides the indicator. |
| `capture` / `screenshot` | `session_id`, optional `max_dimension` (256–4096; default 1280), same configured display. Requires a live ready lease. Returns a complete PNG with image and display mapping metadata. |
| `ax_snapshot` | `session_id`, optional `depth` (1–12; default 6) and boolean `focused_app` (default `true`: frontmost application only; `false`: every regular visible application). Requires the same live ready lease as capture and the Accessibility grant. Reads the live tree off the main thread within a 200 ms budget, breadth first, at most 1,500 nodes and 200 children per element. Returns readiness plus `ax_snapshot`. |
| `ax_action` | `session_id`, `generation` (from the latest `ax_snapshot` of this lease), `ref`, `action` (`press` or `focus`), optional boolean `vnc_fallback`. Requires the same live ready lease, the Accessibility grant and no other capture or AX work in flight. Reads the element off the main thread, re-checks the lease, Stop latch and display, then makes exactly one AX call on the main thread: `AXPress` (or `AXShowMenu` for a menu-bar item without it) or `AXFocused` (or `AXRaise` for a window). It then polls the element for up to 250 ms in total. Returns readiness plus `ax_action`. |
| `ax_verify` | `session_id`, `generation`, `ref`, `action`, matching the one `ax_action` that returned `vnc_click_required`. Consumes that record and polls the element against its pre-click state. Returns readiness plus `ax_verify: {ref, action, generation, verified}`. |
| `export_idle_reference` | `instance_id` must match the resident app; `reference_id` must match the transient local-menu arm reported by `health`. Optional display/backend must match configuration. Consumes the arm once and exports one full-native PNG plus a hashed private receipt while naturally idle. Creates no lease, readiness or input observation. |

Unknown actions, including OCR, diff, ordinary baseline and custom input, fail explicitly
with `unsupported_host_action`. The seat's observation layer may derive supported
observations from returned PNGs; this app does not advertise those operations.
Other attached sessions cannot acquire, renew, release, or capture this lease.

Acknowledgements bind `instance_id`, `session_id`, `sequence`, `challenge`,
`displayGeneration`, `display_id`, `capture_backend`, `ready`, `capture_ready`,
`overlay_ready`, `ui_heartbeat_age_ms`, and `lease_remaining_ms`. Capture additionally
returns `image` (base64 PNG), `mimeType`, `nativeWidth`, `nativeHeight`,
`scaledWidth`, `scaledHeight`, `display_bounds`, `pixels_per_point_x/y`, and
`cursor_included`, plus the display mode's `pixel_width`, `pixel_height`,
`point_width`, `point_height` and `scale` (pixels per point). Capture size is the
mode's pixel framebuffer; `CGDisplayPixelsWide/High` report points on HiDPI and
are not used. Bounds use the Core Graphics global display coordinate space.
Health and every acknowledgement also report `display_uuid`, `display_geometry`
(the same five mode fields, or null) and `accessibility_trusted` from
`AXIsProcessTrusted`. An optional `display_uuid` request parameter must match the
bound display.

`ax_snapshot` returns `{schema: "fruitctl.ax-snapshot.v1", coordinate_space:
"framebuffer_pixels", framebuffer, depth, focused_app, applications, nodes,
node_count, truncated}`. Each node has `ref`, `parent`, `depth`, `role` and,
when present, `subrole`, `label` (title or description), `value` and `frame`.
Frames are the element's visible part on the configured display in framebuffer
pixels, or null when it has none. Refs such as `ax:<pid>:0.2.1` are structural
paths within one snapshot. The snapshot also reports `generation` and
`menu_extras`; with `menu_extras: true` the extras menu bar is the first child
of each application read. Secure text fields report `value_redacted: true` and
never a value. Text is bounded to 256 characters. Every call reads live state,
and the snapshot authorizes no input. Missing trust fails with
`accessibility_permission_required`; no candidate application fails with
`accessibility_application_unavailable`.

The Host keeps only the latest successful snapshot of the current lease as the
generation `ax_action` resolves refs against. Each ref keeps its element handle,
so it acts on the same element object or fails, never on a successor at the
same position. A lease end, release, Stop, display change or newer snapshot
discards the generation. `ax_action` fails with typed messages:

- `stale_ref`: a different generation, session, display generation or
  geometry; an unknown ref; or the element was destroyed.
- `ax_unreachable`: the element's owner did not answer, or it is hosted by a
  system remote view service (an out-of-process, non-regular Apple process) and
  cannot act.
- `ax_action_unsupported`: no AX action applies and a VNC click is not safe. A
  click is not safe when `vnc_fallback` is false, the element is a container, or
  it has no visible frame.
- `human_consent_required`: the snapshot application or the element's live
  owner is a consent, authorization or system dialog process
  (UserNotificationCenter, universalAccessAuthWarn, SecurityAgent,
  CoreServicesUIAgent, SoftwareUpdateNotificationManager). A human answers
  those; this holds even when the broker's desktop-state sentinel is off or
  read nothing.

When the element definitely cannot act (no applicable action, or
`kAXErrorActionUnsupported` / `kAXErrorAttributeUnsupported`) and a click is
safe, `ax_action` returns `path: "vnc_click_required"` with `fallback_point` in
framebuffer pixels. A timeout or generic failure is `ax_result:
"indeterminate"` and is verified, never clicked. The result names `path`,
`surface` (nearest sheet, popover, menu, menu bar, menu extra, Control Center,
window or application), `role`, `subrole` and `verified`. Element values are
compared on the Host and never returned.
A display-change notification invalidates the lease, advances generation, and
rebuilds all display panels. A capture with changed/incomplete geometry fails.
`activity_eligible` reports the current owned console-session and awake-display
preflight; `ready` also requires that preflight and visible panels on all displays.
Panel visibility is an AppKit state check, not proof that another system surface
cannot occlude a panel. Physical qualification still supplies that evidence.
`human_stop_latched` reports the local human stop latch.

## Locally armed idle reference diagnostic

The local menu arms one export for 60 seconds. The arm is process-local and never
survives restart. It requires explicit capture opt-in, ordinary Screen Recording
preflight, the owned awake console session, no lease/capture/readiness, and no
visible indicator panel, including a partially visible display set. IPC cannot
arm the diagnostic, request ordinary consent, enable capture or clear Stop.
ScreenCaptureKit itself can still present an Apple direct-capture consent alert;
ordinary preflight=true does not establish that every consent episode is resolved.

The export uses the same running app, fixed display, entire-own-app exclusion,
native source pixels, cursor and PNG encoding path as activity capture. It never
hides an active indicator, excludes another app/system window, masks pixels, or
changes a failed capture result. Its native dimensions may exceed ordinary
`max_dimension`; compare pixel references only when active frames have identical
native/scaled geometry and color conversion. An idle reference is a diagnostic
scene, never an active-agent frame or a cold activity acceptance result. Taking
one first warms subsequent capture; record that fact.

One export writes `reference.png` and `receipt.json` to a fresh directory under
`~/Library/Application Support/Fruitctl/qualification/`. Directories are 0700,
files 0600 and same-user owned; paths are fixed by the app, never supplied through
IPC. Symlink components, unsafe existing modes, extended allow ACL entries
(including inherited grants) and incomplete/scaled PNGs fail without repair.
ACL metadata is read from each opened descriptor; verified absence and deny-only
ACLs are accepted, while unreadable or unknown metadata fails closed. Files are
exclusive; the receipt is written last and binds the
PNG hash, filter/geometry, instance, display generation, capture timing and
`classification:idle_reference`, `input_observation:false`, `ready:false`.
The response provides private paths and both hashes, not image pixels. A partial
write stays private and is not a completed receipt. Failed acquisition consumes
the arm; there is no automatic retry.

Stop, Disable, display/session/sleep transitions and the exporting attachment's
disconnect revoke an in-flight diagnostic. Returning to the prior session or
choosing Allow/Enable cannot revive it. Other attachments cannot cancel its
owner by merely disconnecting. The original connection UUID and receiving peer
are checked before persistence; pending replies observe a closed receiving peer
without waiting for capture completion. Intentional stdin EOF/`SHUT_WR` still
allows its outstanding reply. This does not promise atomic rollback if a peer
closes after the final check during synchronous file writing. Ordinary permission and capture intent are
rechecked after framework awaits and before export/readiness completion. These
checks do not identify an unobserved grant withdrawal-and-return or qualify a
direct-picker alert. The injected offline faults exercise admission and
revocation without AppKit UI, ScreenCaptureKit or the real preferences/TCC store.
The 60 second arm is checked immediately before capture as well as at completion;
slow admission cannot start a capture after that deadline.

No native idle-reference files have been captured for this implementation yet.
The optional Host remains outside the public installation/release payload until
its separately attended qualification passes.

## Timing contract

Target leases expire 3,000 ms after the latest accepted renewal, using local
`ContinuousClock`. A 100 ms main-run-loop timer expires leases and pulses UI
readiness; accepted renewals require a UI heartbeat no older than 250 ms. EOF,
release, capture failure, display change, user-session resignation, and screen
or system sleep revoke activity and hide panels. There is no idle capture loop.
Fresh begin/renew/capture requests remain unavailable while an independent
session, screen-sleep, or system-sleep hold is active. Matching activation/wake
notifications clear only their own hold; they never restore a lease. Every
activity operation also checks public console-session ownership and drawable
displays, covering an inactive launch whose resignation notification preceded
observer registration. No private screen-lock notifications or TCC bypasses are
used; lock-screen behavior remains an attended qualification case.

The helper-backed broker challenges every 500 ms during activity and rejects
renewal and release acknowledgements whose round trip exceeds 500 ms. Three
requests have other deadlines:

- The first `health` also pays SSH connection setup: 5 s.
- `begin_activity` takes an excluded-app snapshot and shows the indicator
  before it answers: 2 s. Its permit still starts at the send, so a begin
  that leaves less of it than the first heartbeat needs is followed at once
  by a renewal. A begin answered after its whole 1 s window admits the owner
  with input refused until that renewal arms it.
- `capture` and `ax_snapshot` carry an encoded image or tree. The reply must
  start within 3 s and keep arriving with no gap over 3 s, up to 20 s. Only
  that reply's own bytes count, so a stalled reply cannot be kept alive by
  renewals.

A Host whose health reports `reply_parts: true` is asked for
`reply_part_bytes` (64 KiB). It sends the image as consecutive
`{"id","part":{"index","data"}}` lines, then the reply with `image_parts`, so a
renewal reply can pass between parts on a slow link. The broker rejoins the
parts and validates the image exactly as before. Parts change framing, not the
image encoding.

The native writer
starts its own monotonic challenge deadline before helper renewal, validates
session and VNC/display bindings, and admits no new input event more than
1,000 ms after that native challenge. No remote timestamp extends this deadline;
expiry is terminal for the owned episode, with one exception. A Host that answers
one request at a time cannot renew while it encodes a capture. A permit that
expires during that observation lapses instead: input stays refused, and only a
renewal sent after the lapse can re-arm it, within 1 s or the episode ends. A
batch that has sent `mouse_down` never lapses; expiry retires it, releasing the hold. A
Host whose health reports `request_pipelining: true` keeps renewing beside a
capture, and for it any expiry stays terminal. Held-state neutralization may follow
expiry, and an already blocked native send remains outside the responsive-writer
proof. Uncertain input is never replayed. The 250 ms input-chunk and 2-second
action values are design targets; current source allows longer actions under the
operation deadline and does not enforce those two maxima for every action.

With an operating main run loop, the target's 3-second expiry plus inspection
and hide budgets is designed to clear a lost lease within 3.75 seconds. A process
crash relies on macOS removing its windows and still needs attended validation.
A hung AppKit main thread cannot supply a fresh acknowledgment, so the controller must stop
new input; this source makes no 5-second visual-clear claim for a hung UI thread.

## Attended acceptance gates

1. Establish the signed bundle's screen-recording permission in the logged-in
   Aqua session; verify capture-disabled, denied, and withdrawn permission fail
   without invisible input. Keep the first installer independent of this feature.
2. On each supported macOS build, compare a changing underlying desktop with
   the indicator continuously visible. Confirm complete PNGs exclude all app
   panels and retain underlying corner and center markers; never hide the overlay
   for the test. Record an ordinary VNC frame separately as outside the contract.
3. Confirm no focus change or interception of clicks, typing, scrolling, drag,
   Mission Control, fullscreen Spaces, or Stage Manager. Confirm all connected
   displays show the exact text and purple 72 BPM pulse; Reduce Motion stays static.
4. Qualify PNG-to-VNC coordinate mapping on Retina and non-Retina displays,
   scaled resolutions, rotated displays, and nonzero/negative display origins.
   Changing configured display or display generation cancels before input.
5. Disconnect SSH, release ownership, sleep/lock/switch user, remove a display,
   withdraw capture permission, and terminate only the owned app. Measure no new
   Neo writes after its 1-second permit expiry and no visible overlay after 5 seconds
   for disconnect/process-crash cases. Record hung-UI behavior separately.
6. Exercise stale/reordered acknowledgements, competing attach connections,
   malformed and oversized records, capture failure, blocked output, and partial
   input. Assert no takeover, auto replay, or success from incomplete pixels.

Use [the bounded qualification run](ATTENDED-QUALIFICATION.md) to record exact
artifact/version bindings, observations, latency samples, and pass/fail evidence.

Primary references: Apple's [application exclusion filter](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(display:excludingapplications:exceptingwindows:)),
[ScreenCaptureKit capture](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos),
[legacy window-sharing warning](https://developer.apple.com/documentation/appkit/nswindow/sharingtype-swift.enum/none),
[floating overlay behavior](https://developer.apple.com/documentation/appkit/nswindow/collectionbehavior-swift.struct/canjoinallapplications),
[ContinuousClock](https://developer.apple.com/documentation/swift/continuousclock),
[current GUI session](https://developer.apple.com/documentation/coregraphics/cgsessioncopycurrentdictionary()),
[session resignation](https://developer.apple.com/documentation/appkit/nsworkspace/sessiondidresignactivenotification),
and [sleeping display drawability](https://developer.apple.com/documentation/coregraphics/cgdisplayisasleep(_:)).
