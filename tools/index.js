// SPDX-License-Identifier: MIT
/**
 *  █████╗ ██████╗  █████╗ ███████╗
 * ██╔══██╗██╔══██╗██╔══██╗██╔════╝
 * ███████║██████╔╝███████║███████╗
 * ██╔══██║██╔══██╗██╔══██║╚════██║
 * ██║  ██║██║  ██║██║  ██║███████║
 * ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝
 *
 * Copyright (c) 2026 Rıza Emre ARAS <r.emrearas@proton.me>
 *
 * This file is part of Claude KVM.
 * Released under the MIT License — see LICENSE for details.
 */

import { z } from 'zod';

// Display-specific bounds belong to the executor's current geometry. Keeping
// this schema stable lets MCP clients retain it across resize and configure.
const coordinate = () => z.number().int().min(0).max(0x7fffffff);
const button = () => z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default left)');
const MODIFIERS = ['shift', 'rshift', 'ctrl', 'rctrl', 'alt', 'option', 'ralt', 'cmd', 'command', 'rcmd'];
const MODIFIER_ALIASES = { option: 'alt', command: 'cmd' };
const modifiers = () => z.array(z.enum(MODIFIERS)).min(1).max(MODIFIERS.length).optional()
  .describe('mouse_click only: modifier keys held around the click (e.g. ["shift"] or ["cmd"])');
const durationMs = () => z.number().int().min(1).max(10000).optional()
  .describe('hold_key duration in ms; the key is released before the call returns');

// D27: a mouse hold lives only inside the one action_queue batch that opens
// it and is force-released at batch end or abort. JSON-RPC -32011 is the
// typed input refusal the native controller also returns.
export const BATCH_ONLY_ACTIONS = new Set(['mouse_down', 'mouse_up']);
export const INPUT_REFUSED_CODE = -32011;

export function inputRefusal(reason, message) {
  return Object.assign(new Error(message), { code: INPUT_REFUSED_CODE, data: { reason } });
}
const extent = () => z.number().int().min(1).max(0x7fffffff);
// A rectangle in the current scaled display space.
const rect = () => z.object({ x: coordinate(), y: coordinate(), width: extent(), height: extent() });
const MAX_REGIONS = 16;
const regions = () => z.array(rect()).min(1).max(MAX_REGIONS)
  .describe('Compare only these scaled-space rectangles (default: the whole display)');
const ignore = () => z.array(rect()).max(MAX_REGIONS)
  .describe('Scaled-space rectangles excluded from comparison (clocks, cursors, spinners)');
const stableMs = () => z.number().int().min(50).max(10000);
// D16: the name of a secret the operator allowlisted for this target.
const SECRET_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const secretRef = () => z.string().regex(SECRET_NAME).optional()
  .describe('type_secret: operator-allowlisted secret name (never the secret itself)');
// An element ref from ax_snapshot. The two forms are disjoint (a secret name
// has no colon), and each action accepts only its own.
const AX_ELEMENT_REF = /^ax:[0-9]{1,10}:0(\.[0-9]{1,3}){0,12}$/;
const commandRef = () => z.string()
  .regex(/^(?:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}|ax:[0-9]{1,10}:0(?:\.[0-9]{1,3}){0,12})$/).optional()
  .describe('type_secret: operator-allowlisted secret name (never the secret itself); ' +
    'click_element / focus_element: an element ref from the latest ax_snapshot');

export function validateActionParameters(input) {
  const required = {
    mouse_click: ['x', 'y'], mouse_double_click: ['x', 'y'], triple_click: ['x', 'y'],
    mouse_move: ['x', 'y'], hover: ['x', 'y'],
    mouse_drag: ['x', 'y', 'toX', 'toY'], scroll: ['x', 'y', 'direction'],
    nudge: ['dx', 'dy'], key_tap: ['key'], key_type: ['text'], paste: ['text'], type_secret: ['ref'],
    hold_key: ['key', 'duration_ms'], mouse_down: ['x', 'y'],
    zoom: ['x', 'y', 'width', 'height'], wait_for_stable: ['stable_ms', 'timeout_ms'],
    expect_change: ['x', 'y', 'width', 'height'],
    click_element: ['ref'], focus_element: ['ref'],
  }[input.action] || [];
  for (const field of required) {
    if (input[field] === undefined) throw new Error(`Missing ${field} for ${input.action}`);
  }
  if (input.ref !== undefined && (input.action === 'click_element' || input.action === 'focus_element') &&
      !AX_ELEMENT_REF.test(input.ref)) {
    throw new Error(`${input.action} takes an element ref from ax_snapshot`);
  }
  if (input.action === 'type_secret' && input.ref !== undefined && !SECRET_NAME.test(input.ref)) {
    throw new Error('type_secret takes an allowlisted secret name');
  }
  // D16: a secret is named, never sent. The broker resolves the ref.
  if (input.action === 'type_secret') {
    if (input.text !== undefined) throw new Error('type_secret takes a ref, never text');
    if ((input.x === undefined) !== (input.y === undefined)) throw new Error('type_secret takes both x and y or neither');
  }
  if (input.action === 'wait_for_stable' && input.stable_ms > input.timeout_ms) {
    throw new Error('stable_ms must not exceed timeout_ms for wait_for_stable');
  }
  if (input.action === 'key_combo' && input.key === undefined &&
      (!Array.isArray(input.keys) || input.keys.length === 0)) {
    throw new Error('Missing key or nonempty keys for key_combo');
  }
  if (input.action === 'mouse_up' && (input.x === undefined) !== (input.y === undefined)) {
    throw new Error('mouse_up takes both x and y or neither');
  }
  if (input.format !== undefined && input.action !== 'screenshot') {
    throw new Error(`format applies only to screenshot, not ${input.action}`);
  }
  if (input.modifiers !== undefined && input.action !== 'mouse_click') {
    throw new Error(`modifiers apply only to mouse_click, not ${input.action}`);
  }
  // Aliases name one key; the native controller refuses a repeated keysym.
  const keys = (input.modifiers || []).map(name => MODIFIER_ALIASES[name] || name);
  if (new Set(keys).size !== keys.length) throw new Error('modifiers must name distinct keys');
}

/** Whole-batch hold check before admission: every mouse_up releases a button
 * pressed earlier in the same batch, and no button is pressed twice. */
export function validateActionBatch(actions) {
  const held = new Set();
  for (const action of actions) {
    if (!BATCH_ONLY_ACTIONS.has(action.action)) continue;
    const name = action.button || 'left';
    if (action.action === 'mouse_down') {
      if (held.has(name)) throw inputRefusal('button_already_held', `Mouse button ${name} is already held in this batch`);
      held.add(name);
    } else {
      if (!held.has(name)) throw inputRefusal('button_not_held', `Mouse button ${name} is not held in this batch`);
      held.delete(name);
    }
  }
}

/**
 * Build the stable vnc_command tool definition. Display bounds are validated
 * against the executor's current geometry rather than cached in the schema.
 */
export function vncCommandTool() {
  return {
    name: 'vnc_command',
    description: [
      'Control the configured remote desktop via VNC.',
      'Coordinates use the current scaled display space returned by screenshot or health.',
      'Display dimensions may change after configure, reconnect or resize.',
      '',
      'ACTIONS:',
      '  screenshot     {format?}                → full screen (Host route: JPEG, or png)',
      '  cursor_crop                             → crop around cursor with crosshair',
      '  diff_check     {regions?, ignore?}      → changed ratio + boxes since baseline (replaces it)',
      '  set_baseline                            → save current screen for diff comparison',
      '  zoom           {x, y, width, height, max_dimension?} → fresh native-resolution PNG of a region',
      '  wait_for_stable {stable_ms, timeout_ms, regions?, ignore?} → fresh captures until unchanged',
      '  mouse_click    {x, y, button?, modifiers?} → click (left|right|middle), e.g. modifiers ["shift"]',
      '  mouse_double_click {x, y}               → double click',
      '  triple_click   {x, y}                   → triple click (e.g. select a line)',
      '  mouse_move     {x, y}                   → move cursor',
      '  hover          {x, y}                   → move cursor + settle wait',
      '  nudge          {dx, dy}                 → relative cursor move',
      '  mouse_drag     {x, y, toX, toY, button?} → drag from start to end (left|right|middle)',
      '  scroll         {x, y, direction, amount?} → scroll (up|down|left|right)',
      '  cursor_position                         → fruitctl-tracked pointer position (not the server cursor)',
      '  mouse_down / mouse_up                   → action_queue only (refused here); see action_queue',
      '  key_tap        {key}                    → single key press (enter|escape|tab|space|...)',
      '  key_combo      {key} or {keys:[...]}    → modifier combo (e.g. "cmd+c" or ["cmd","shift","3"])',
      '  hold_key       {key, duration_ms}       → hold one key, released before the call returns',
      '  key_type       {text}                   → type text; with input.pasteUnmappable, untypable text is pasted',
      '  paste          {text}                   → paste text via clipboard',
      '  type_secret    {ref, x?, y?}            → type an operator-allowlisted secret by name',
      '                                            (clicks x,y first); the value is never returned',
      '  clipboard_read                          → target clipboard text, when the profile enables it',
      '  detect_elements                         → OCR text detection with bounding boxes',
      '  ax_snapshot    {depth?, focused_app?, menu_extras?} → Host route only: live Accessibility',
      '                                            tree with role/label/value/frame and element refs',
      '  click_element  {ref}                    → Host route only: AXPress a ref from the latest',
      '                                            ax_snapshot; result names the path and verified',
      '  focus_element  {ref}                    → Host route only: focus a ref (AXFocused)',
      '  configure      {<params>}               → set timing/display params at runtime',
      '  configure      {reset: true}            → reset all params to defaults',
      '  get_timing                              → get current timing + display params',
      '  wait           {ms?}                    → pause (default 500ms)',
      '  health                                  → connection status + display info',
      '  shutdown                                → graceful daemon exit',
      '',
      'Use screenshot → analyze → act → verify pattern.',
      'Observations are always fresh captures; a capture failure is a typed stale_screen error.',
    ].join('\n'),
    inputSchema: {
      action: z.enum([
        'screenshot', 'cursor_crop', 'diff_check', 'set_baseline', 'zoom', 'wait_for_stable',
        'mouse_click', 'mouse_double_click', 'mouse_move', 'hover', 'nudge',
        'mouse_drag', 'scroll',
        'key_tap', 'key_combo', 'key_type', 'paste', 'type_secret', 'clipboard_read',
        'detect_elements', 'ax_snapshot', 'click_element', 'focus_element',
        'configure', 'get_timing',
        'wait', 'health', 'shutdown',
        'triple_click', 'cursor_position', 'hold_key', 'mouse_down', 'mouse_up',
      ]).describe('The action to perform'),
      x: coordinate().optional().describe('X coordinate in the current scaled display'),
      y: coordinate().optional().describe('Y coordinate in the current scaled display'),
      toX: coordinate().optional().describe('Drag target X'),
      toY: coordinate().optional().describe('Drag target Y'),
      dx: z.number().int().min(-50).max(50).optional().describe('Relative X offset (nudge)'),
      dy: z.number().int().min(-50).max(50).optional().describe('Relative Y offset (nudge)'),
      button: button(),
      modifiers: modifiers(),
      duration_ms: durationMs(),
      key: z.string().optional().describe('Key name or combo string (e.g. "cmd+c")'),
      keys: z.array(z.string()).optional().describe('Array of key names for combo (e.g. ["cmd","shift","3"])'),
      text: z.string().optional().describe('Text to type or paste'),
      ref: commandRef(),
      direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Scroll direction'),
      amount: z.number().int().min(1).max(20).optional().describe('Scroll amount (default 3)'),
      ms: z.number().int().min(50).max(10000).optional().describe('Wait duration in ms (default 500)'),
      width: extent().optional().describe('Zoom region width in the current scaled display'),
      height: extent().optional().describe('Zoom region height in the current scaled display'),
      regions: regions().optional(),
      ignore: ignore().optional(),
      stable_ms: stableMs().optional().describe('wait_for_stable: unchanged duration required'),
      timeout_ms: z.number().int().min(100).max(20000).optional()
        .describe('wait_for_stable: give up with a typed stable_timeout error after this long'),
      depth: z.number().int().min(1).max(12).optional().describe('ax_snapshot levels below each application (default 6)'),
      focused_app: z.boolean().optional().describe('ax_snapshot: frontmost application only (default true)'),
      menu_extras: z.boolean().optional()
        .describe('ax_snapshot: also read menu-bar extras, Control Center and their open menus (default false)'),
      format: z.enum(['jpeg', 'png']).optional()
        .describe('screenshot on the Host route: jpeg (default) or png for lossless evidence'),
      // Configure params (runtime timing/display adjustment)
      reset: z.boolean().optional().describe('Reset all params to defaults'),
      max_dimension: z.number().int().min(320).max(3840).optional()
        .describe('Max screenshot dimension (configure), or longest zoom image side (zoom, default 1280)'),
      cursor_crop_radius: z.number().int().min(50).max(500).optional().describe('Cursor crop radius'),
      click_hold_ms: z.number().int().min(1).max(500).optional().describe('Click hold duration'),
      double_click_gap_ms: z.number().int().min(1).max(500).optional().describe('Double-click gap'),
      hover_settle_ms: z.number().int().min(1).max(2000).optional().describe('Hover settle wait'),
      drag_position_ms: z.number().int().min(1).max(500).optional().describe('Pre-drag position wait'),
      drag_press_ms: z.number().int().min(1).max(500).optional().describe('Drag press hold'),
      drag_step_ms: z.number().int().min(1).max(100).optional().describe('Between interpolation pts'),
      drag_settle_ms: z.number().int().min(1).max(500).optional().describe('Settle before release'),
      drag_pixels_per_step: z.number().min(1).max(100).optional().describe('Point density per pixel'),
      drag_min_steps: z.number().int().min(1).max(100).optional().describe('Min interpolation steps'),
      scroll_press_ms: z.number().int().min(1).max(200).optional().describe('Scroll press-release gap'),
      scroll_tick_ms: z.number().int().min(1).max(200).optional().describe('Inter-tick delay'),
      key_hold_ms: z.number().int().min(1).max(500).optional().describe('Key hold duration'),
      combo_mod_ms: z.number().int().min(1).max(200).optional().describe('Modifier settle delay'),
      type_key_ms: z.number().int().min(1).max(200).optional().describe('Key hold during typing'),
      type_inter_key_ms: z.number().int().min(1).max(200).optional().describe('Inter-character delay'),
      type_shift_ms: z.number().int().min(1).max(200).optional().describe('Shift key settle'),
      paste_settle_ms: z.number().int().min(1).max(500).optional().describe('Post-clipboard write wait'),
      paste_restore_ms: z.number().int().min(1).max(2000).optional()
        .describe('Routed key_type paste: wait after Cmd+V before restoring the clipboard'),
    },
  };
}

/** Default bound for each action_queue step expectation. */
export const EXPECT_TIMEOUT_MS = 3000;
/** Expectation kinds the schema reserves but no backend evaluates yet. */
export const RESERVED_EXPECTATIONS = Object.freeze(['ax_exists', 'ocr_contains']);

/**
 * Build the stable action_queue tool definition.
 * Executes multiple VNC actions in sequence, returns text-only results.
 */
export function actionQueueTool() {
  const queueAction = z.object({
    action: z.enum([
      'mouse_click', 'mouse_double_click', 'mouse_move', 'hover', 'nudge',
      'mouse_drag', 'scroll',
      'key_tap', 'key_combo', 'key_type', 'paste', 'type_secret',
      'set_baseline', 'diff_check', 'wait_for_stable',
      'wait',
      'triple_click', 'cursor_position', 'hold_key', 'mouse_down', 'mouse_up',
    ]).describe('The action to perform'),
    x: coordinate().optional().describe('X coordinate in the current scaled display'),
    y: coordinate().optional().describe('Y coordinate in the current scaled display'),
    toX: coordinate().optional().describe('Drag target X'),
    toY: coordinate().optional().describe('Drag target Y'),
    dx: z.number().int().min(-50).max(50).optional().describe('Relative X offset (nudge)'),
    dy: z.number().int().min(-50).max(50).optional().describe('Relative Y offset (nudge)'),
    button: button(),
    modifiers: modifiers(),
    duration_ms: durationMs(),
    key: z.string().optional().describe('Key name or combo string (e.g. "ctrl+c")'),
    keys: z.array(z.string()).optional().describe('Array of key names for combo'),
    text: z.string().optional().describe('Text to type or paste'),
    ref: secretRef(),
    direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Scroll direction'),
    amount: z.number().int().min(1).max(20).optional().describe('Scroll amount (default 3)'),
    ms: z.number().int().min(50).max(10000).optional().describe('Wait duration in ms (default 500)'),
    regions: regions().optional(),
    ignore: ignore().optional(),
    stable_ms: stableMs().optional().describe('wait_for_stable: unchanged duration required'),
    timeout_ms: z.number().int().min(100).max(20000).optional().describe('wait_for_stable: timeout'),
    expect: z.object({
      change_in: rect().optional()
        .describe('Fail the step unless this scaled rectangle differs from its pre-step frame'),
      stable_ms: stableMs().optional().describe('Then wait until the screen is unchanged this long'),
      timeout_ms: z.number().int().min(100).max(10000).optional()
        .describe(`Bound for each expectation (default ${EXPECT_TIMEOUT_MS})`),
      ax_exists: z.unknown().optional().describe('Reserved; refused as unsupported'),
      ocr_contains: z.unknown().optional().describe('Reserved; refused as unsupported'),
    }).optional().describe('Checked with fresh captures after the step; a failure stops the batch'),
  });

  return {
    name: 'action_queue',
    description: [
      'Execute multiple VNC actions in sequence. Returns text results only (no screenshots).',
      'The batch has one 30-second deadline and stops on first error.',
      'Use for batching confident action sequences.',
      'A step may carry expect {change_in?: {x,y,width,height}, stable_ms?, timeout_ms?}, checked with',
      'fresh captures after the step; an unmet expectation stops the batch with error code -32012.',
      '',
      'Mouse holds: mouse_down {x, y, button?} presses a button that stays held',
      'across later actions in this batch (mouse_move then drags) until',
      'mouse_up {x?, y?, button?}. Any hold still live is force-released at',
      'batch end or abort; holds never span two calls.',
      '',
      'Examples:',
      '  Navigate: [click(640,91), ctrl+a, paste("url"), return]',
      '  Scroll:   [click(640,400), pagedown, pagedown, pagedown]',
      '  Type:     [click(300,200), key_type("hello"), tab, key_type("world")]',
      '  Hold:     [mouse_down(100,100), mouse_move(200,140), wait(200), mouse_up]',
    ].join('\n'),
    inputSchema: {
      actions: z.array(queueAction).min(1).max(20).describe('Ordered actions to execute sequentially'),
    },
  };
}

/**
 * Control tools (task lifecycle).
 */
export function controlTools() {
  return [
    {
      name: 'task_complete',
      description: 'Mark the task as successfully completed. Provide a brief summary.',
      inputSchema: {
        summary: z.string().describe('What was accomplished'),
      },
    },
    {
      name: 'task_failed',
      description: 'Mark the task as failed. Explain why.',
      inputSchema: {
        reason: z.string().describe('Why the task could not be completed'),
      },
    },
  ];
}
