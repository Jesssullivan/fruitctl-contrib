// SPDX-License-Identifier: MIT
// Computer-use alias layer: offline only; a fake broker socket stands in for
// the Darwin broker. No desktop, Host or VNC server is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFrames, writeFrame } from '../lib/broker/protocol.mjs';
import { BrokerExecutor } from '../lib/broker/client.mjs';
import { createMcpServer, McpSession } from '../lib/mcp/server.js';
import { RAW_PRESENTATION, advertisedCapabilities, nativeCapabilities } from '../lib/mcp/capabilities.js';
import { vncCommandTool, validateActionParameters } from '../tools/index.js';
import { translateComputerAction, admitComputerPlan, translateKey, extendedActions,
  BASELINE_ACTIONS, ComputerAliasError, MAX_ALIAS_STEPS } from '../tools/computer-alias.js';

const steps = (input) => translateComputerAction(input).steps;
const refusal = (fn, code, action) => assert.throws(fn, (error) =>
  error instanceof ComputerAliasError && error.code === code && (action === undefined || error.action === action));
const HOST_PRESENT = Object.freeze({ route: 'host', indicator: 'present' });
const known = (...actions) => nativeCapabilities([...BASELINE_ACTIONS, ...actions]);
const PNG = Buffer.from('fresh pixels').toString('base64');

// A fake executor answers each action from a handler and records the batches.
function fakeExecutor({ capabilities, presentation = RAW_PRESENTATION, handle } = {}) {
  const batches = [];
  return {
    batches, presentation, ...(capabilities ? { capabilities } : {}),
    async execute(actions) {
      batches.push(actions.map(action => ({ ...action })));
      const responses = [];
      for (const action of actions) {
        const response = handle?.(action) ?? (action.action === 'screenshot'
          ? { result: { detail: 'OK', image: PNG, scaledWidth: 1280, scaledHeight: 800 } }
          : { result: { detail: 'OK' } });
        responses.push(response);
        if (response.error) break;
      }
      return responses;
    },
    async release() {},
  };
}

test('baseline actions are the vnc_command surface older backends shipped', () => {
  const surface = new Set(vncCommandTool().inputSchema.action.options);
  for (const action of BASELINE_ACTIONS) assert.ok(surface.has(action), `${action} is not a vnc_command action`);
  // Newer methods stay outside the baseline: only advertised metadata enables them.
  assert.deepEqual([...surface].filter(action => !BASELINE_ACTIONS.has(action)).sort(),
    ['activate_app', 'ax_snapshot', 'click_element', 'clipboard_read', 'cursor_position', 'focus_element', 'hold_key', 'mouse_down',
      'mouse_up', 'triple_click', 'type_secret', 'wait_for_stable', 'zoom']);
});

test('Anthropic actions translate to Fruitctl actions with scaled coordinates', () => {
  assert.deepEqual(steps({ action: 'screenshot' }), [{ action: 'screenshot' }]);
  assert.deepEqual(steps({ action: 'left_click', coordinate: [10, 20] }), [{ action: 'mouse_click', x: 10, y: 20, button: 'left' }]);
  assert.deepEqual(steps({ action: 'right_click', coordinate: [1, 2] }), [{ action: 'mouse_click', x: 1, y: 2, button: 'right' }]);
  assert.deepEqual(steps({ action: 'middle_click', coordinate: [1, 2] }), [{ action: 'mouse_click', x: 1, y: 2, button: 'middle' }]);
  assert.deepEqual(steps({ action: 'double_click', coordinate: [3, 4] }), [{ action: 'mouse_double_click', x: 3, y: 4 }]);
  assert.deepEqual(steps({ action: 'triple_click', coordinate: [3, 4] }), [{ action: 'triple_click', x: 3, y: 4 }]);
  assert.deepEqual(steps({ action: 'mouse_move', coordinate: [5, 6] }), [{ action: 'mouse_move', x: 5, y: 6 }]);
  assert.deepEqual(steps({ action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [30, 40] }),
    [{ action: 'mouse_drag', x: 1, y: 2, toX: 30, toY: 40 }]);
  assert.deepEqual(steps({ action: 'type', text: 'Hello\n' }), [{ action: 'key_type', text: 'Hello\n' }]);
  assert.deepEqual(steps({ action: 'scroll', coordinate: [7, 8], scroll_direction: 'down', scroll_amount: 5 }),
    [{ action: 'scroll', x: 7, y: 8, direction: 'down', amount: 5 }]);
  assert.deepEqual(steps({ action: 'scroll', coordinate: [7, 8], scroll_direction: 'left' }),
    [{ action: 'scroll', x: 7, y: 8, direction: 'left', amount: 3 }]);
  assert.deepEqual(steps({ action: 'cursor_position' }), [{ action: 'cursor_position' }]);
  assert.deepEqual(steps({ action: 'zoom', region: [0, 0, 100, 50] }), [{ action: 'zoom', x: 0, y: 0, width: 100, height: 50 }]);
  assert.deepEqual(steps({ action: 'wait' }), [{ action: 'wait' }]);
  assert.deepEqual(steps({ action: 'wait', duration: 2 }), [{ action: 'wait', ms: 2000 }]);
  // hold_key and click modifiers use the native methods (#101), which release
  // within the same call; no key is ever left held between steps.
  assert.deepEqual(steps({ action: 'hold_key', text: 'shift', duration: 0.5 }),
    [{ action: 'hold_key', key: 'shift', duration_ms: 500 }]);
  assert.deepEqual(steps({ action: 'hold_key', text: 'Return', duration: 10 }),
    [{ action: 'hold_key', key: 'return', duration_ms: 10000 }]);
  assert.deepEqual(steps({ action: 'left_click', coordinate: [1, 1], text: 'ctrl+shift' }),
    [{ action: 'mouse_click', x: 1, y: 1, button: 'left', modifiers: ['ctrl', 'shift'] }]);
  assert.deepEqual(steps({ action: 'right_click', coordinate: [2, 3], text: 'super' }),
    [{ action: 'mouse_click', x: 2, y: 3, button: 'right', modifiers: ['cmd'] }]);
  assert.deepEqual(steps({ action: 'middle_click', coordinate: [2, 3], text: 'Alt_R' }),
    [{ action: 'mouse_click', x: 2, y: 3, button: 'middle', modifiers: ['ralt'] }]);
  assert.equal(translateComputerAction({ action: 'left_click', coordinate: [1, 1], text: 'shift' }).label,
    'left_click with modifiers');
  assert.equal(translateComputerAction({ action: 'left_click', coordinate: [1, 1] }).label, undefined);
});

test('translated hold_key and modifier clicks pass the native parameter rules', () => {
  for (const input of [{ action: 'hold_key', text: 'cmd', duration: 1 },
    { action: 'left_click', coordinate: [4, 5], text: 'ctrl+alt+shift+cmd' },
    { action: 'right_click', coordinate: [4, 5], text: 'Shift_R+Control_R' }]) {
    for (const step of steps(input)) assert.doesNotThrow(() => validateActionParameters(step), JSON.stringify(input));
  }
});

test('Anthropic xdotool key strings become Fruitctl taps, combos and sequences', () => {
  assert.deepEqual(steps({ action: 'key', text: 'Return' }), [{ action: 'key_tap', key: 'return' }]);
  assert.deepEqual(steps({ action: 'key', text: 'ctrl+s' }), [{ action: 'key_combo', keys: ['ctrl', 's'] }]);
  assert.deepEqual(steps({ action: 'key', text: 'super+space' }), [{ action: 'key_combo', keys: ['cmd', 'space'] }]);
  assert.deepEqual(steps({ action: 'key', text: 'ctrl+a BackSpace' }),
    [{ action: 'key_combo', keys: ['ctrl', 'a'] }, { action: 'key_tap', key: 'backspace' }]);
  assert.deepEqual(steps({ action: 'key', text: 'cmd++' }), [{ action: 'key_combo', keys: ['cmd', '+'] }]);
  assert.deepEqual(steps({ action: 'key', text: 'ctrl+plus' }), [{ action: 'key_combo', keys: ['ctrl', '+'] }]);
  assert.deepEqual(steps({ action: 'key', text: 'Page_Down' }), [{ action: 'key_tap', key: 'pagedown' }]);
  assert.deepEqual(steps({ action: 'key', text: 'alt+F4' }), [{ action: 'key_combo', keys: ['alt', 'f4'] }]);
  assert.deepEqual(steps({ action: 'key', text: 'shift+Tab' }), [{ action: 'key_combo', keys: ['shift', 'tab'] }]);
  for (const name of ['KP_Enter', 'Escape', 'Up', 'Delete', 'Home', 'Super_L', 'Control_R', 'Alt_R', 'minus']) {
    assert.doesNotThrow(() => translateKey(name, 'key'), name);
  }
  refusal(() => steps({ action: 'key', text: 'XF86AudioMute' }), 'unsupported_key', 'key');
  refusal(() => steps({ action: 'key', text: 'ctrl+' }), 'invalid_arguments', 'key');
  refusal(() => steps({ action: 'key', text: Array(MAX_ALIAS_STEPS + 1).fill('a').join(' ') }), 'invalid_arguments', 'key');
});

test('every translated key name resolves in KeySymbols.swift', async () => {
  const swift = await fs.readFile(new URL('../ClaudeKVM-Daemon/Input/KeySymbols.swift', import.meta.url), 'utf8');
  const resolver = swift.slice(swift.indexOf('func namedKeyToKeysym'), swift.indexOf('func charToKeysym'));
  const names = new Set([...resolver.matchAll(/case ((?:"[^"]+"(?:,\s*)?)+):/g)]
    .flatMap(match => [...match[1].matchAll(/"([^"]+)"/g)].map(name => name[1])));
  assert.ok(names.has('cmd') && names.has('pagedown') && names.has('f12'));
  const inputs = ['ctrl', 'Control_R', 'shift', 'Shift_R', 'alt', 'Alt_R', 'option', 'super', 'Super_R', 'meta',
    'win', 'cmd', 'Return', 'KP_Enter', 'Escape', 'Tab', 'space', 'BackSpace', 'Delete', 'Insert', 'Home', 'End',
    'Prior', 'Next', 'Page_Up', 'Page_Down', 'Up', 'Down', 'Left', 'Right', 'ArrowLeft', 'Caps_Lock', 'Num_Lock',
    'Scroll_Lock', 'Print', 'Pause', 'Menu', 'F1', 'F12', 'minus', 'grave', 'bracketleft', 'a', 'Z', '7', '/'];
  for (const input of inputs) {
    const mapped = translateKey(input, 'key');
    assert.ok(names.has(mapped) || [...mapped].length === 1, `${input} -> ${mapped} must resolve in Swift`);
  }
});

test('OpenAI computer_call actions translate to Fruitctl actions', () => {
  const openai = (action) => steps({ action });
  assert.deepEqual(openai({ type: 'screenshot' }), [{ action: 'screenshot' }]);
  assert.deepEqual(openai({ type: 'click', button: 'left', x: 10, y: 20 }), [{ action: 'mouse_click', x: 10, y: 20, button: 'left' }]);
  assert.deepEqual(openai({ type: 'click', x: 1, y: 2 }), [{ action: 'mouse_click', x: 1, y: 2, button: 'left' }]);
  assert.deepEqual(openai({ type: 'click', button: 'wheel', x: 1, y: 2 }), [{ action: 'mouse_click', x: 1, y: 2, button: 'middle' }]);
  assert.deepEqual(openai({ type: 'click', button: 'right', x: 1, y: 2 }), [{ action: 'mouse_click', x: 1, y: 2, button: 'right' }]);
  assert.deepEqual(openai({ type: 'double_click', x: 3, y: 4 }), [{ action: 'mouse_double_click', x: 3, y: 4 }]);
  assert.deepEqual(openai({ type: 'move', x: 5, y: 6 }), [{ action: 'mouse_move', x: 5, y: 6 }]);
  assert.deepEqual(openai({ type: 'drag', path: [{ x: 1, y: 2 }, { x: 9, y: 8 }] }),
    [{ action: 'mouse_drag', x: 1, y: 2, toX: 9, toY: 8 }]);
  assert.deepEqual(openai({ type: 'drag', path: [{ x: 1, y: 2 }, { x: 5, y: 5 }, { x: 9, y: 8 }] }), [
    { action: 'mouse_move', x: 1, y: 2 }, { action: 'mouse_down', x: 1, y: 2, button: 'left' },
    { action: 'mouse_move', x: 5, y: 5 }, { action: 'mouse_move', x: 9, y: 8 },
    { action: 'mouse_up', x: 9, y: 8, button: 'left' },
  ]);
  assert.deepEqual(openai({ type: 'keypress', keys: ['CTRL', 'A'] }), [{ action: 'key_combo', keys: ['ctrl', 'a'] }]);
  assert.deepEqual(openai({ type: 'keypress', keys: ['ENTER'] }), [{ action: 'key_tap', key: 'return' }]);
  assert.deepEqual(openai({ type: 'keypress', keys: ['META', 'SHIFT', '4'] }), [{ action: 'key_combo', keys: ['cmd', 'shift', '4'] }]);
  assert.deepEqual(openai({ type: 'type', text: 'hi' }), [{ action: 'key_type', text: 'hi' }]);
  assert.deepEqual(openai({ type: 'scroll', x: 10, y: 10, scroll_x: 0, scroll_y: 300 }),
    [{ action: 'scroll', x: 10, y: 10, direction: 'down', amount: 3 }]);
  assert.deepEqual(openai({ type: 'scroll', x: 10, y: 10, scroll_x: -40, scroll_y: -5000 }), [
    { action: 'scroll', x: 10, y: 10, direction: 'up', amount: 20 },
    { action: 'scroll', x: 10, y: 10, direction: 'left', amount: 1 },
  ]);
  assert.deepEqual(openai({ type: 'wait' }), [{ action: 'wait' }]);
  assert.equal(translateComputerAction({ action: { type: 'drag', path: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] } }).label,
    'drag with a multi-point path');
});

test('malformed and unknown alias actions are typed refusals before execution', () => {
  refusal(() => steps({ action: 'left_click' }), 'invalid_arguments', 'left_click');
  refusal(() => steps({ action: 'left_click', coordinate: [-1, 2] }), 'invalid_arguments', 'left_click');
  refusal(() => steps({ action: 'left_click', coordinate: [1.5, 2] }), 'invalid_arguments', 'left_click');
  refusal(() => steps({ action: 'left_click_drag', coordinate: [1, 2] }), 'invalid_arguments', 'left_click_drag');
  refusal(() => steps({ action: 'scroll', coordinate: [1, 2], scroll_direction: 'sideways' }), 'invalid_arguments', 'scroll');
  refusal(() => steps({ action: 'scroll', coordinate: [1, 2], scroll_direction: 'up', scroll_amount: 50 }), 'invalid_arguments', 'scroll');
  refusal(() => steps({ action: 'wait', duration: 30 }), 'invalid_arguments', 'wait');
  refusal(() => steps({ action: 'hold_key', text: 'shift' }), 'invalid_arguments', 'hold_key');
  refusal(() => steps({ action: 'hold_key', text: 'ctrl+shift', duration: 1 }), 'unsupported_action', 'hold_key');
  refusal(() => steps({ action: 'left_click', coordinate: [1, 1], text: 'ctrl+a' }), 'invalid_arguments', 'left_click');
  refusal(() => steps({ action: 'left_click', coordinate: [1, 1], text: 'cmd+super' }), 'invalid_arguments', 'left_click');
  for (const input of [{ action: 'double_click', coordinate: [1, 1], text: 'shift' },
    { action: 'triple_click', coordinate: [1, 1], text: 'cmd' },
    { action: 'scroll', coordinate: [1, 1], scroll_direction: 'down', text: 'shift' }]) {
    assert.throws(() => steps(input), (error) => error instanceof ComputerAliasError &&
      error.code === 'unsupported_action' && error.action === input.action &&
      error.message.includes(`${input.action} with modifiers`));
  }
  refusal(() => steps({ action: 'type' }), 'invalid_arguments', 'type');
  refusal(() => steps({ action: 'zoom', region: [10, 10, 5, 20] }), 'invalid_arguments', 'zoom');
  refusal(() => steps({ action: 'teleport' }), 'unsupported_action', 'teleport');
  refusal(() => steps({ action: { type: 'click', button: 'back', x: 1, y: 1 } }), 'unsupported_action', 'click');
  refusal(() => steps({ action: { type: 'click', x: 1 } }), 'invalid_arguments', 'click');
  refusal(() => steps({ action: { type: 'drag', path: [{ x: 1, y: 1 }] } }), 'invalid_arguments', 'drag');
  refusal(() => steps({ action: { type: 'keypress', keys: [] } }), 'invalid_arguments', 'keypress');
  refusal(() => steps({ action: { type: 'scroll', x: 1, y: 1 } }), 'invalid_arguments', 'scroll');
  refusal(() => steps({ action: { type: 'hover' } }), 'unsupported_action', 'hover');
  refusal(() => steps({}), 'invalid_arguments');
  refusal(() => steps({ action: ['screenshot'] }), 'invalid_arguments');
});

test('D27: a mouse hold never spans tool calls, even when mouse_down is advertised', () => {
  for (const action of ['left_mouse_down', 'left_mouse_up']) {
    refusal(() => admitComputerPlan(translateComputerAction({ action }), known('mouse_down', 'mouse_up')),
      'unsupported_action', action);
  }
});

test('capability admission refuses unadvertised actions and lights them up when advertised', () => {
  const extended = [
    [{ action: 'triple_click', coordinate: [1, 1] }, ['triple_click'], 'triple_click'],
    [{ action: 'hold_key', text: 'shift', duration: 1 }, ['hold_key'], 'hold_key'],
    [{ action: 'cursor_position' }, ['cursor_position'], 'cursor_position'],
    [{ action: 'zoom', region: [0, 0, 10, 10] }, ['zoom'], 'zoom'],
    // An older controller ignores `modifiers` and would click unmodified, so a
    // modifier click needs the input-parity controller that advertises hold_key.
    [{ action: 'left_click', coordinate: [1, 1], text: 'shift' }, ['hold_key'], 'left_click with modifiers'],
    [{ action: { type: 'drag', path: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] } }, ['mouse_down', 'mouse_up'],
      'drag with a multi-point path'],
  ];
  for (const [input, needs, label] of extended) {
    const plan = translateComputerAction(input);
    assert.deepEqual(extendedActions(plan), needs);
    for (const capabilities of [undefined, nativeCapabilities(), known()]) {
      assert.throws(() => admitComputerPlan(plan, capabilities), (error) => error.code === 'unsupported_action' &&
        error.message.includes(`computer action ${label}:`) && error.message.includes(needs.join(', ')));
    }
    assert.equal(admitComputerPlan(plan, known(...needs)), plan);
  }
  // Baseline actions pass with unknown metadata; a known list is authoritative.
  const click = translateComputerAction({ action: 'left_click', coordinate: [1, 1] });
  assert.equal(admitComputerPlan(click, undefined), click);
  assert.equal(admitComputerPlan(click, nativeCapabilities()), click);
  assert.throws(() => admitComputerPlan(click, nativeCapabilities(['screenshot', 'health', 'wait'])),
    /computer action left_click: backend does not advertise mouse_click/);
});

test('capability metadata parsing accepts health and host-helper shapes only', () => {
  assert.deepEqual(advertisedCapabilities({ known: true, actions: ['zoom'] }), { known: true, actions: ['zoom'] });
  assert.deepEqual(advertisedCapabilities({ backend: 'owned_sck', known: true, actions: ['screenshot'], native: {} }),
    { known: true, actions: ['screenshot'] });
  assert.deepEqual(advertisedCapabilities({ known: false, actions: [] }), { known: false, actions: [] });
  for (const value of [undefined, null, [], 'zoom', { known: 'yes' }, { known: true, actions: ['Bad Name'] },
    { known: true, actions: ['zoom', 'zoom'] }]) {
    assert.equal(advertisedCapabilities(value), undefined);
  }
});

async function connect(t, executor) {
  const { server, session } = createMcpServer({ executor });
  const client = new Client({ name: 'offline-computer-alias', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, session, computer: (arguments_) => client.callTool({ name: 'computer', arguments: arguments_ }) };
}

test('the computer tool registers after the original four and executes translated actions', async t => {
  const executor = fakeExecutor({ presentation: HOST_PRESENT });
  const { client, computer } = await connect(t, executor);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name), ['vnc_command', 'action_queue', 'task_complete', 'task_failed', 'computer']);
  assert.match(tools[4].description, /Anthropic computer tool/);
  assert.match(tools[4].description, /unsupported_action/);

  const shot = await computer({ action: 'screenshot' });
  assert.notEqual(shot.isError, true);
  assert.ok(shot.content.some(block => block.type === 'image' && block.data === PNG));
  assert.deepEqual(shot.structuredContent, { detail: 'OK', scaledWidth: 1280, scaledHeight: 800, ...HOST_PRESENT,
    alias: { shape: 'anthropic', action: 'screenshot', actions: ['screenshot'] } });

  const clicked = await computer({ action: { type: 'click', button: 'right', x: 40, y: 50 } });
  assert.notEqual(clicked.isError, true);
  assert.deepEqual(clicked.structuredContent, { detail: 'OK', ...HOST_PRESENT,
    alias: { shape: 'openai', action: 'click', actions: ['mouse_click'] } });

  const keys = await computer({ action: 'key', text: 'cmd+a Delete' });
  assert.notEqual(keys.isError, true);
  assert.equal(keys.content[0].text, 'key:\n[1] key_combo: OK\n[2] key_tap: OK');
  assert.deepEqual(keys.structuredContent, { completed: 2, ...HOST_PRESENT,
    alias: { shape: 'anthropic', action: 'key', actions: ['key_combo', 'key_tap'] } });
  assert.deepEqual(executor.batches, [
    [{ action: 'screenshot' }],
    [{ action: 'mouse_click', x: 40, y: 50, button: 'right' }],
    [{ action: 'key_combo', keys: ['cmd', 'a'] }, { action: 'key_tap', key: 'delete' }],
  ]);
});

test('refusals are typed, never reach the executor and cannot attest the indicator', async t => {
  const executor = fakeExecutor({ presentation: HOST_PRESENT, capabilities: known() });
  const { computer } = await connect(t, executor);
  for (const [input, code, action] of [
    [{ action: 'triple_click', coordinate: [1, 1] }, 'unsupported_action', 'triple_click'],
    [{ action: 'left_mouse_down' }, 'unsupported_action', 'left_mouse_down'],
    [{ action: { type: 'click', button: 'forward', x: 1, y: 1 } }, 'unsupported_action', 'click'],
    [{ action: 'left_click' }, 'invalid_arguments', 'left_click'],
    [{ action: 'key', text: 'Hyper_L' }, 'unsupported_key', 'key'],
  ]) {
    const result = await computer(input);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, new RegExp(`^Error: .*${action}`));
    assert.equal(result.structuredContent.code, code);
    assert.equal(result.structuredContent.alias.action, action.split(' ')[0]);
    assert.deepEqual({ route: result.structuredContent.route, indicator: result.structuredContent.indicator },
      { route: 'host', indicator: 'unknown' });
  }
  const refused = await computer({ action: 'zoom', region: [0, 0, 4, 4] });
  assert.deepEqual(refused.structuredContent.alias, { shape: 'anthropic', action: 'zoom', missing: ['zoom'] });
  assert.deepEqual(executor.batches, []);
});

test('advertised extended actions light up without an alias change', async t => {
  const executor = fakeExecutor({ capabilities: known('triple_click', 'cursor_position', 'hold_key'),
    handle: action => action.action === 'cursor_position' ? { result: { x: 12, y: 34 } } : undefined });
  const { computer } = await connect(t, executor);
  const triple = await computer({ action: 'triple_click', coordinate: [5, 6] });
  assert.notEqual(triple.isError, true);
  const cursor = await computer({ action: 'cursor_position' });
  assert.ok(cursor.content.some(block => block.text === 'cursor: (12, 34)'));
  assert.equal(cursor.structuredContent.x, 12);
  const held = await computer({ action: 'hold_key', text: 'shift', duration: 0.1 });
  assert.notEqual(held.isError, true);
  assert.deepEqual(held.structuredContent, { detail: 'OK', ...RAW_PRESENTATION,
    alias: { shape: 'anthropic', action: 'hold_key', actions: ['hold_key'] } });
  const modified = await computer({ action: 'left_click', coordinate: [7, 8], text: 'cmd' });
  assert.notEqual(modified.isError, true);
  assert.deepEqual(executor.batches, [
    [{ action: 'triple_click', x: 5, y: 6 }], [{ action: 'cursor_position' }],
    [{ action: 'hold_key', key: 'shift', duration_ms: 100 }],
    [{ action: 'mouse_click', x: 7, y: 8, button: 'left', modifiers: ['cmd'] }]]);
});

test('a failing step reports progress, the failed index and a typed code', async t => {
  const executor = fakeExecutor({ presentation: HOST_PRESENT,
    handle: action => action.key === 'f12' ? { error: { code: -32001, message: 'Missing or unknown key' } } : undefined });
  const { computer } = await connect(t, executor);
  const result = await computer({ action: 'key', text: 'Tab a' });
  assert.notEqual(result.isError, true);
  const failed = await computer({ action: { type: 'keypress', keys: ['F12'] } });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.code, -32001);
  assert.equal(failed.structuredContent.indicator, 'unknown');

  executor.execute = async (actions) => {
    const error = new Error('Action unavailable on native backend');
    error.code = 'unsupported_action';
    error.responses = [{ result: { detail: 'OK' } }];
    throw error;
  };
  const partial = await computer({ action: 'key', text: 'Tab Return' });
  assert.equal(partial.isError, true);
  assert.equal(partial.content[0].text, 'key:\n[1] key_tap: OK\n[2] key_tap: ERROR — Action unavailable on native backend');
  assert.deepEqual(partial.structuredContent, { completed: 1, failedIndex: 2, code: 'unsupported_action',
    route: 'host', indicator: 'unknown', alias: { shape: 'anthropic', action: 'key', actions: ['key_tap', 'key_tap'] } });
  const single = await computer({ action: 'mouse_move', coordinate: [1, 1] });
  assert.deepEqual(single.structuredContent, { error: 'Action unavailable on native backend', code: 'unsupported_action',
    alias: { shape: 'anthropic', action: 'mouse_move', actions: ['mouse_move'] }, route: 'host', indicator: 'unknown' });
});

test('a vnc_command health advertisement is reused instead of probing', async t => {
  const executor = fakeExecutor({ handle: action => action.action === 'health'
    ? { result: { detail: 'OK', capabilities: { known: true, actions: [...BASELINE_ACTIONS, 'zoom'] } } } : undefined });
  const { client, session, computer } = await connect(t, executor);
  assert.equal(session.capabilities, undefined);
  await client.callTool({ name: 'vnc_command', arguments: { action: 'health' } });
  assert.deepEqual(session.capabilities.actions.at(-1), 'zoom');
  const zoomed = await computer({ action: 'zoom', region: [0, 0, 8, 8] });
  assert.notEqual(zoomed.isError, true);
  assert.deepEqual(executor.batches.map(batch => batch[0].action), ['health', 'zoom']);
});

// A fake Darwin broker speaking the real frame protocol to BrokerExecutor,
// which exposes no capability metadata of its own.
async function fakeBroker(t, respond) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fca-'));
  const socketPath = path.join(directory, 'broker.sock');
  const executed = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    readFrames(socket, frame => {
      if (frame.kind === 'open') writeFrame(socket, { v: 1, kind: 'opened', presentation: HOST_PRESENT });
      if (frame.kind === 'execute') {
        executed.push(frame.actions.map(action => action.action));
        const responses = frame.actions.map(respond);
        writeFrame(socket, { v: 1, kind: 'result', id: frame.id, responses, presentation: HOST_PRESENT });
      }
    }, () => socket.destroy());
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const executor = new BrokerExecutor({ socketPath, target: 'host' });
  t.after(async () => {
    await executor.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await executor.opened;
  return { executor, executed };
}

test('through a broker, one health probe learns capabilities before an extended action', async t => {
  const { executor, executed } = await fakeBroker(t, action => action.action === 'health'
    ? { result: { detail: 'OK', capabilities: { backend: 'owned_sck', known: true,
      actions: [...BASELINE_ACTIONS, 'mouse_down', 'mouse_up'] } } }
    : { result: { detail: 'OK' } });
  const session = new McpSession(executor);
  assert.equal(executor.capabilities, undefined);
  const plain = await session.computer({ action: 'left_click', coordinate: [1, 1] });
  assert.notEqual(plain.isError, true);
  assert.deepEqual(executed, [['mouse_click']]);
  const drag = await session.computer({ action: { type: 'drag', path: [{ x: 1, y: 1 }, { x: 4, y: 4 }, { x: 9, y: 9 }] } });
  assert.notEqual(drag.isError, true);
  assert.deepEqual(drag.structuredContent.alias.actions, ['mouse_move', 'mouse_down', 'mouse_move', 'mouse_move', 'mouse_up']);
  assert.deepEqual(drag.structuredContent.indicator, 'present');
  const triple = await session.computer({ action: 'triple_click', coordinate: [1, 1] });
  assert.equal(triple.structuredContent.code, 'unsupported_action');
  // The probe ran once; the refused triple click sent nothing.
  assert.deepEqual(executed, [['mouse_click'], ['health'],
    ['mouse_move', 'mouse_down', 'mouse_move', 'mouse_move', 'mouse_up']]);
});

test('through an older broker, unknown metadata keeps extended actions refused', async t => {
  const { executor, executed } = await fakeBroker(t, action => action.action === 'health'
    ? { result: { detail: 'OK', capabilities: { known: false, actions: [] } } } : { result: { detail: 'OK' } });
  const session = new McpSession(executor);
  for (let i = 0; i < 2; i++) {
    const refused = await session.computer({ action: 'cursor_position' });
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent.code, 'unsupported_action');
    assert.equal(refused.structuredContent.route, 'host');
  }
  assert.deepEqual(executed, [['health']]);
});

test('a capability probe and its batch share one tool deadline', async () => {
  const budgets = [];
  const executor = {
    presentation: RAW_PRESENTATION,
    async execute(actions, { timeoutMs }) {
      budgets.push(timeoutMs);
      if (actions[0].action !== 'health') return actions.map(() => ({ result: { detail: 'OK' } }));
      await new Promise(resolve => setTimeout(resolve, 80));
      return [{ result: { detail: 'OK', capabilities: { known: true, actions: [...BASELINE_ACTIONS, 'zoom'] } } }];
    },
  };
  const session = new McpSession(executor, { timeoutMs: 1000 });
  const zoomed = await session.computer({ action: 'zoom', region: [0, 0, 8, 8] });
  assert.notEqual(zoomed.isError, true);
  assert.equal(budgets.length, 2);
  // The batch gets what the probe left, not a fresh 1000ms deadline.
  // (Each budget already has replyBudget's return margin removed.)
  assert.ok(budgets[1] < budgets[0] - 40, `batch budget ${budgets[1]} must exclude the probe`);

  // A probe that exhausts the deadline leaves nothing for input.
  const slow = { ...executor, async execute(actions, { signal }) {
    budgets.push(actions[0].action);
    if (actions[0].action !== 'health') return actions.map(() => ({ result: { detail: 'OK' } }));
    await new Promise(resolve => setTimeout(resolve, 60));
    return [{ result: { detail: 'OK' } }];
  } };
  budgets.length = 0;
  const late = new McpSession(slow, { timeoutMs: 50 });
  const refused = await late.computer({ action: 'zoom', region: [0, 0, 8, 8] });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /timed out after 50ms/);
  assert.deepEqual(budgets, ['health']);
});
