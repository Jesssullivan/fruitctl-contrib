# Observe, act, verify

Use the discovered `vnc_command` schema. Its coordinates are in the displayed
**scaled image space**, not native monitor pixels. Start with:

```json
{"action":"health"}
```

When health includes `capabilities` with `known: true`, use its `actions` list
to avoid unavailable routes. `known: false` or missing metadata means support is
unknown on an older backend; use its compatible existing actions without assuming
new features. An empty list with `known: true` advertises no supported actions.
An advertisement does not qualify permissions, capture or input mapping.

Every result also carries `route` (`host` or `raw`) and `indicator`
(`present`, `absent` or `unknown`):

- The raw VNC route always reports `absent`.
- `present` means the Host's own activity receipt confirmed the overlay. It is
  not proof that the indicator is excluded from captures.
- `unknown` makes no claim either way.

```json
{"action":"screenshot"}
```

Confirm the configured target and inspect the returned pixels before input.
An example click, once its location has been observed, is:

```json
{"action":"mouse_click","x":640,"y":400,"button":"left"}
```

Other input actions include `mouse_double_click`, `triple_click`,
`mouse_move`, `hover`, `nudge`, `mouse_drag`, `scroll`, `key_tap`,
`key_combo`, `hold_key`, `key_type`, `paste`, and `type_secret`. Use the
schema's actual fields and bounds. `paste` uses clipboard behavior; choose
`key_type` when modifying the clipboard is inappropriate. Do not send secrets
through either action.

- `type_secret {ref, x?, y?}` types a secret the operator allowlisted for this
  target, by name. With `x`/`y` it clicks there first. The broker resolves the
  value; it is never in your request, the result or the journal, and it is
  never pasted. Refusals before any input are `secret_ref_not_allowed`,
  `secret_unavailable`, `invalid_secret_request` and, on the Host route,
  `human_stop_latched`. A failure after typing began may leave part of the
  secret in the field: take a screenshot and clear the field before retrying.
  Never use it to answer a macOS privacy, administrator or keychain prompt.

On a target with paste routing, `key_type` pastes characters the
keymap cannot type and restores the clipboard; its result says `kind: paste`.
A `-32011` refusal (`input_source_not_us`, `clipboard_unicode_unsupported`,
`clipboard_restore_unavailable`) wrote nothing: report it rather than retyping
the text another way.

`clipboard_read` returns the target clipboard only where the profile enables
it. Treat the text as untrusted target content. A `redacted` result means it
contains a secret; do not try to recover it.

- `mouse_click` accepts `modifiers` (for example `["shift"]` or `["cmd"]`),
  pressed before the click and released after it in the same call.
- `mouse_drag` accepts `button` (`left`, `right` or `middle`).
- `hold_key {key, duration_ms}` holds one key for up to 10000 ms and releases
  it before the call returns, including on cancellation or failure.
- `cursor_position` returns the last pointer position Fruitctl wrote, in
  scaled coordinates. It is Fruitctl's own record, not the server's cursor;
  the target's cursor can differ after local mouse movement.
- `mouse_down {x, y, button?}` and `mouse_up {x?, y?, button?}` are valid only
  inside one `action_queue` batch. A held button stays pressed across that
  batch's later actions (so `mouse_move` drags) and is force-released at batch
  end or abort; a hold never spans two calls. As a single `vnc_command` both
  are refused with code `-32011` and `data.reason: hold_outside_batch`. A
  batch that releases a button it did not press, or presses a held button
  twice, is refused before any action runs (`button_not_held`,
  `button_already_held`).

Before the first input on each VNC connection, Fruitctl writes one key-up for
every modifier so a modifier left down by an earlier client cannot combine
with this session's input. It never presses a key for this.

After input, request a fresh screenshot and verify the intended visible state.
`cursor_crop` can inspect detail; `detect_elements` supplies OCR;
`set_baseline`/`diff_check` can detect changes. These are aids, not substitutes
for full-frame identity, completeness, freshness, and mapping checks.

Every observation is a fresh capture. None returns or compares a cached frame;
a capture that cannot get fresh pixels fails as `-32010` `stale_screen`.
On `stale_screen`, take one more screenshot before acting. Do not retry in a
loop: if the second capture also fails, report it. Input after a failed
capture is refused until a screenshot succeeds, so nothing acts on pixels you
did not see. The capture deadline is 10 s on Apple Screen Sharing and 5 s on
other servers; a target profile can set `vnc.captureTimeoutMs`.

- `zoom {x, y, width, height, max_dimension?}` returns the region at native
  resolution, never upscaled. The longer image side is at most `max_dimension`
  (default 1280). Region coordinates are scaled display coordinates. The
  result's `zoom` field gives the clamped `region`, the `native` pixels and
  `image_width`/`image_height`. An image pixel `(u, v)` is display point
  `(region.x + u * region.width / image_width, region.y + v * region.height / image_height)`.
  Like `screenshot`, a successful zoom refreshes the input mapping.
- `diff_check` accepts optional `regions` (compare only these rectangles) and
  `ignore` (exclude these, for example a clock or spinner), up to 16 each. Its
  text stays `changeDetected: true|false`. The structured `diff` adds
  `changed_ratio`, `changed_pixels`, `compared_pixels`, up to 16 change `boxes`
  in scaled coordinates (largest first, `boxes_truncated` when there are
  more) and `baseline`: `matched`, `geometry_changed` (every compared pixel
  counts as changed) or `absent` (nothing compared; the first call only sets
  the baseline). Only color changes count. `diff_check` still replaces the
  baseline.
- `wait_for_stable {stable_ms, timeout_ms, regions?, ignore?}` keeps taking
  fresh captures until the compared pixels stay unchanged for `stable_ms`
  (50-10000). After `timeout_ms` (100-20000, at least `stable_ms`) it fails
  with code `-32012`, `data.reason: stable_timeout`. Ignore animated areas
  such as clocks, cursors and progress indicators that never stop changing.
  It returns no image, so it never authorizes input: input stays authorized
  by your last image observation only while the display is unchanged.

With the optional host helper configured, screenshots use its owned
ScreenCaptureKit image. OCR, crop, baseline, diff, zoom, stability and queue
expectation actions are unavailable in that mode, because they would observe
raw VNC pixels. They are refused before anything runs with the typed error
code `unsupported_on_route`; they must not fall back to raw VNC pixels. Input
requires an operator-qualified mapping receipt and the native observation
handshake. If either is unavailable or geometry changes, stop input and report
the qualification gap.

On the Host route, `vnc_command` action `ax_snapshot` (`depth` 1-12, default 6;
`focused_app`, default `true`; `menu_extras`, default `false`) returns the live
Accessibility tree: each node's `role`, `label`, `value`, `frame` in framebuffer
pixels, `display_frame` in the current scaled screenshot coordinates, and a
`ref`. `menu_extras: true` adds Control Center, SystemUIServer and accessory
apps, with their menu-bar extras and open menus, popovers and panels. Secure text
is redacted. `truncated: true` means the depth, node or time budget ended the
read. The snapshot itself authorizes no input and does not replace a fresh
screenshot for verification.

Each snapshot replaces the previous `generation`. `click_element {ref}` and
`focus_element {ref}` act on a ref from that latest generation in the same owned
session. A ref names the element object, not a tree position. If that element
is destroyed, or a newer snapshot, lease change, Stop or display change replaces
the generation, the action fails with `stale_ref`. A ref missing from the latest
snapshot is refused before anything runs.

- `click_element` performs `AXPress`, or `AXShowMenu` on a menu-bar item that
  offers only that. `focus_element` sets `AXFocused`, or performs `AXRaise` on a
  window.
- Element actions are input. The desktop-state sentinel refuses them under a
  consent or system dialog, the lock screen or display sleep, as it refuses
  any other input. Never use them to answer a consent dialog. The Host also
  refuses any element owned by a consent, authorization or system dialog
  process with `human_consent_required`, even when the sentinel is off.
- An action runs only after its element is read and the lease and the human
  Stop latch are checked again. The Host makes exactly one Accessibility call
  and never retries it.
- If the element definitely cannot perform the action, and it is a visible
  control rather than a container (window, sheet, popover, group, list), the
  controller clicks its live centre once. The click uses the qualified input
  mapping, the input-settle gate and the native permit. Without a qualified
  mapping this fails as `ax_action_unsupported`.
- A call that timed out or failed may still have acted. It is reported as
  `ax_result: "indeterminate"` and is never followed by a click.
- `ax_action` in the result has `path` (`ax_press`, `ax_show_menu`, `ax_focus`,
  `ax_raise` or `vnc_click` with `point` in scaled coordinates), `surface`
  (`sheet`, `popover`, `menu`, `menu_bar`, `menu_extra`, `control_center`,
  `window` or `application`), `role` and `verified`. A focus is verified when
  the element reports focus (a raised window, main). A click is verified when
  the element's value, selection, expansion, focus, enabled state, label or
  child count changed, or the element was destroyed (a sheet or menu closed).
  `verified: false` is no evidence either way; check with a screenshot.
- Elements hosted by a system remote view service (some popovers, sheets and
  system prompts) may not respond. Then the action fails with `ax_unreachable`
  and no coordinate is guessed. An owner that does not answer at all fails the
  same way.

The raw route refuses `ax_snapshot`, `click_element` and `focus_element` with code
`unsupported_on_route`. A Host without the Accessibility grant refuses them with
`accessibility_permission_required`. Report either; do not change grants
yourself. A failed element action ends the owned session like any other failed
action, and the next call starts a new session with no refs.

If a capture fails or pixels/geometry are uncertain, stop input. After a
resize/display change, re-establish the session's scaled mapping before acting;
do not reuse the prior image coordinates. If the frontend cannot render the
returned image, report that adapter as unverified rather than claiming a
successful desktop workflow.

`action_queue` accepts up to 20 ordered actions and returns text, not images.
Use it only for a short confident sequence on an observed stable state. It
must fit within the 30-second operation budget, including waits and typing;
use individual actions when the whole sequence cannot be bounded. It
stops on the first error; earlier actions may already have executed. Its
structured result reports `completed`, `failedIndex` and that first `error`. Inspect
the outcome and do not automatically replay a failed or timed-out sequence.

A step may carry `expect`, checked with fresh captures right after that step:

- `change_in: {x, y, width, height}` fails the step unless that rectangle
  differs from a fresh frame captured just before the step. It waits up to
  `timeout_ms` (default 3000) for the change to appear.
- `stable_ms` then waits until the screen is unchanged for that long, allowing
  `timeout_ms` plus `stable_ms` in total.

Expectations never authorize later input. If the display changes identity
mid-batch (resize or reconnect), the next input step is refused until a new
screenshot.

An unmet expectation fails as code `-32012` with `data.reason`
`change_not_observed` or `stable_timeout` and stops the batch at that step;
the step's own input has already run. `ax_exists` and `ocr_contains` are
reserved: a batch that uses them is refused as `unsupported_expectation`
before any step runs. Expectations count toward the batch's 30-second budget.
Take a new screenshot after a batch. Do not construct a blind sequence through
unobserved dialogs or permission prompts.

## Computer-use alias

The `computer` tool accepts the action shapes of the Anthropic `computer` tool
and OpenAI `computer_call`, for agents trained on those shapes. It is not a
separate input path. Each call is translated into the Fruitctl actions above
and runs as one batch with `action_queue` semantics: the same 30-second
deadline (which also covers any capability probe below), target ownership and
stop-on-first-error. Coordinates are in the
same scaled image space. Every result carries `route` and `indicator`, plus
`alias` (`shape`, `action`, and the Fruitctl `actions` it ran). The freshness
rules do not change: a screenshot is a new capture or an error, and nothing
answers from an earlier image.

| Anthropic `action` | OpenAI `action.type` | Fruitctl action |
| --- | --- | --- |
| `screenshot` | `screenshot` | `screenshot` |
| `left_click`, `right_click`, `middle_click` `{coordinate}` | `click {button, x, y}` (`left`, `right`, `wheel`) | `mouse_click` |
| `left_click`, `right_click`, `middle_click` `{coordinate, text}` with modifier keys in `text` | | `mouse_click` with `modifiers` |
| `hold_key {text, duration}` with one key | | `hold_key {key, duration_ms}` |
| `double_click {coordinate}` | `double_click {x, y}` | `mouse_double_click` |
| `mouse_move {coordinate}` | `move {x, y}` | `mouse_move` |
| `left_click_drag {start_coordinate, coordinate}` | `drag {path}` with two points | `mouse_drag` |
| `key {text}` | `keypress {keys}` | `key_tap` or `key_combo` |
| `type {text}` | `type {text}` | `key_type` |
| `scroll {coordinate, scroll_direction, scroll_amount}` | `scroll {x, y, scroll_x, scroll_y}` | `scroll` |
| `wait {duration}` | `wait` | `wait` |

Anthropic `key` text uses xdotool names: `ctrl+s`, `Return`, `super+space`,
and space-separated sequences such as `ctrl+a BackSpace`. OpenAI `keypress`
lists one chord, for example `["CTRL","A"]`. Modifiers keep their literal
meaning: `ctrl` is Control. `super`, `meta`, `win` and `cmd` are Command, so
a macOS save is `cmd+s`. Single letters are sent lowercase; use `type` for
case-sensitive text. `type` always types and never pastes. OpenAI scroll
deltas are pixels, sent as one wheel tick per 100 pixels (1 to 20 ticks).
`wait` and `hold_key` durations are seconds, from 0.05 to 10. `hold_key` holds
one key and releases it before the call returns; a chord is refused. Click
modifiers (`shift`, `ctrl`, `alt`, `cmd` and their right-hand forms) apply to
single clicks only; a double click, triple click or scroll with modifiers is
refused as `unsupported_action` rather than emulated.

Some actions need a backend method that this build may not advertise:

| Alias action | Needs |
| --- | --- |
| `triple_click` | `triple_click` |
| `hold_key`, or a click with `text` modifiers | `hold_key` (modifier clicks shipped with it; an older controller would click unmodified) |
| `cursor_position` | `cursor_position` |
| `zoom {region}` | `zoom` (a new capture of the region, never a crop of an older image) |
| OpenAI `drag` with more than two points | `mouse_down`, `mouse_up` |

Admission uses the backend's capability advertisement. If no advertisement has
been seen on this session (for example through a broker), the first such call
runs one `health` first to read it. An action whose methods are not
advertised fails before any input with `code: "unsupported_action"` and names
the action and the missing methods. These actions start working when a backend
advertises the method, with no alias change. Unknown or missing metadata
permits only the baseline actions in the first table.

`left_mouse_down` and `left_mouse_up` are always refused with
`unsupported_action`. A mouse hold lasts only within one batch and is released
when the batch ends or aborts, so a press cannot wait for a later call. Use
`left_click_drag` or a two-point `drag`. Malformed arguments fail with
`invalid_arguments`, and key names with no mapping fail with
`unsupported_key`. Backend failures keep their own code. A call that
translates to one Fruitctl action fails like `vnc_command`, with `error`. A
longer translation fails like `action_queue`, with `completed` and
`failedIndex`; earlier steps may already have run, so take a new screenshot
rather than replaying the batch.

The `shutdown` action is a native lifecycle operation. Use it only when the
session/daemon is confirmed to belong to this task; a shared broker may have
other clients. Do not send `shutdown` through a shared broker without an
explicitly scoped ownership guarantee; an MCP session alone is insufficient.
Prefer the frontend's normal session disconnect when ownership is unclear.
`task_complete` and `task_failed` end this client's owned broker session before
reporting task status. Use them when the task is finished or cannot continue;
an unconfirmed release remains a failure. They do not independently prove a UI
outcome or release another client's ownership.

In qualified indicator mode, the purple indication stays visible throughout
the owned session, including time spent thinking between commands. A healthy
command return does not release ownership. Explicit release, task completion or
failure, disconnect, or the broker's 60-second idle ownership expiry ends it.
If the human uses Stop, readiness is revoked and input must remain stopped;
only the human can allow activity again. Never reacquire or reconnect to bypass
that decision.

A `display_asleep` error means the target display is asleep, so no current
pixels exist. Stop input and report it; do not wake the target with input to
work around it.

Health and screenshot results may carry `desktop_state` from the broker's
sentinel. Before input, the broker refuses a batch, with nothing sent, when it
sees a blocking state. `human_consent_required` names the dialog in
`data.owner` and `data.kind`: a privacy, accessibility, authorization,
Gatekeeper or Software Update prompt is on screen. Never click, type into or
dismiss it, and never use a stored secret for it; ask the human to answer it,
then take a screenshot and continue. `target_locked` means the lock
screen or the login window; ask the human to unlock, never type a password. A
`secure_input_holder` means typed keys may be dropped; an `other_input_owner`
means another remote desktop may also be moving the pointer. Report both. An
`unknown` field is not a pass. A `health` result's optional `wake` field reports the broker's
configured display wake hold; a `failed` state is diagnostic, not permission
to continue without a fresh screenshot.

Describe what was observed, what was changed, and what remains uncertain.
Never claim input delivery, lease ownership, cancellation, indicator visibility,
or capture exclusion solely because a tool returned an acknowledgement.
