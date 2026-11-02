// SPDX-License-Identifier: MIT
// #157 broker side of the Host input route: policy, coordinate mapping,
// chunking, typed refusals and readback. Mock SSH Host only; no desktop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFactory } from '../lib/broker/server.mjs';
import { validateTargetTransport } from '../lib/broker/paths.mjs';
import { McpSession } from '../lib/mcp/server.js';
import { isPreAdmissionRefusal } from '../lib/mcp/capabilities.js';
import { hostOnlyProfile, hostSequence, refusal } from './host-mock.mjs';

const LOGIC = 'com.apple.logic10';
const policy = (extra = {}) => ({ applications: [LOGIC], ...extra });

function inputHost({ health = {}, answer, capabilities = ['input'] } = {}) {
  return hostSequence({ capabilities, health: { input_enabled: true, input_post_permission: true,
    operator_input_monitor: 'event_tap', ...health }, alter(request, response) {
    if (request.action !== 'input' || !response.success) return response;
    const custom = answer?.(request);
    if (custom && custom.success === false) return custom;
    response.result.input = { kind: request.params.kind, posted_events: 3, completed: true,
      operator_input: request.params.operator_input, operator_input_events: 0, released_events: 0,
      operator_input_monitor: 'event_tap', target_bundle_id: request.params.target.bundle_id, ...custom };
    return response;
  } });
}

async function executorFor(options = {}, profile = hostOnlyProfile({ hostInput: policy() })) {
  const hosts = inputHost(options);
  const executor = await nativeFactory(profile, { hostSpawn: hosts.spawnImpl });
  return { executor, host: hosts.attachments[0] };
}

const inputs = host => host.requests.filter(request => request.action === 'input').map(request => request.params);

test('profiles accept hostInput only on Host-only targets and validate it', () => {
  assert.equal(validateTargetTransport(hostOnlyProfile({ hostInput: policy({ operatorInput: 'assert' }) })), true);
  for (const bad of [{}, { applications: [] }, { applications: ['../x'] }, { applications: [LOGIC, LOGIC] },
    policy({ operatorInput: 'ignore' }), policy({ operatorIdleMs: -1 }), policy({ extra: true })]) {
    assert.throws(() => validateTargetTransport(hostOnlyProfile({ hostInput: bad })), /hostInput/);
  }
  assert.throws(() => validateTargetTransport({ hostInput: policy() }), /requires the Host-only transport/);
});

test('input actions appear only with an operator policy and a Host that offers input', async () => {
  for (const [profile, capabilities, expected] of [[hostOnlyProfile({ hostInput: policy() }), ['input'], true],
    [hostOnlyProfile(), ['input'], false], [hostOnlyProfile({ hostInput: policy() }), [], false]]) {
    const { executor } = await executorFor({ capabilities }, profile);
    try {
      assert.equal(executor.capabilities.actions.includes('mouse_click'), expected);
      assert.equal(executor.capabilities.actions.includes('activate_app'), expected);
      if (!expected) {
        await assert.rejects(executor.execute([{ action: 'mouse_click', x: 1, y: 1 }]),
          error => isPreAdmissionRefusal(error) && error.code === 'unsupported_on_route');
      }
      // Never on this route: holds, paste, secrets and clipboard.
      for (const action of ['type_secret', 'paste', 'mouse_down', 'hold_key', 'clipboard_read']) {
        await assert.rejects(executor.execute([{ action, ref: 'x', text: 'x', x: 1, y: 1 }]),
          error => isPreAdmissionRefusal(error));
      }
    } finally { await executor.close(); }
  }
});

test('screenshot coordinates map to framebuffer pixel centres with button and modifiers', async () => {
  const { executor, host } = await executorFor();
  try {
    // The mock display is 512 x 256 pixels and the agent sees 512 x 256.
    const [clicked] = await executor.execute([{ action: 'mouse_click', x: 10, y: 20, button: 'right',
      modifiers: ['cmd', 'shift'] }]);
    const [sent] = inputs(host);
    assert.deepEqual(sent, { session_id: sent.session_id, display_id: 42, capture_backend: 'owned_sck',
      kind: 'click', target: { bundle_id: LOGIC }, operator_input: 'yield', operator_idle_ms: 1000,
      x: 10, y: 20, button: 'right', modifiers: ['cmd', 'shift'] });
    assert.equal(clicked.result.host_input.posted_events, 3);
    assert.equal(clicked.result.host_input.readback, true);
    assert.match(clicked.result.image, /^iVBOR/);
    // The readback follows the input on the same lease.
    const actions = host.requests.map(request => request.action);
    assert.equal(actions[actions.indexOf('input') + 2], 'capture');
    await executor.execute([{ action: 'mouse_drag', x: 0, y: 0, toX: 511, toY: 255 },
      { action: 'scroll', x: 5, y: 5, direction: 'down' }, { action: 'key_combo', key: 'cmd+s' },
      { action: 'key_tap', key: 'escape' }, { action: 'activate_app' }]);
    const [, drag, scroll, combo, tap, activate] = inputs(host);
    assert.deepEqual([drag.x, drag.y, drag.to_x, drag.to_y], [0, 0, 511, 255]);
    assert.deepEqual([scroll.kind, scroll.direction, scroll.amount], ['scroll', 'down', 3]);
    assert.deepEqual([combo.kind, combo.keys], ['key', ['cmd', 's']]);
    assert.deepEqual(tap.keys, ['escape']);
    assert.equal(activate.kind, 'activate');
    assert.equal(activate.x, undefined);
  } finally { await executor.close(); }
});

test('key_type text is chunked without splitting characters and CR becomes newline', async () => {
  const { executor, host } = await executorFor();
  try {
    const text = '🎸'.repeat(40) + 'a\r\nb';
    const [typed] = await executor.execute([{ action: 'key_type', text }]);
    const chunks = inputs(host).map(params => params.text);
    // A newline ends its request; the Host re-checks focus before 'b'.
    assert.deepEqual(chunks, ['🎸'.repeat(32), '🎸'.repeat(8) + 'a\n', 'b']);
    assert.equal(typed.result.host_input.posted_events, 9);
    // Chunks also stay within the Host's UTF-16 budget.
    const before = inputs(host).length;
    await executor.execute([{ action: 'key_type', text: '👩‍👩‍👧'.repeat(32) }]);
    assert.ok(inputs(host).slice(before).every(params => params.text.length <= 200));
    await assert.rejects(executor.execute([{ action: 'key_type', text: 'a' + '\u0301'.repeat(80) }]),
      error => isPreAdmissionRefusal(error) && error.code === 'invalid_input');
    // A ZWJ sequence is one grapheme and is never split across requests.
    const family = '👩‍👩‍👧';
    await executor.execute([{ action: 'key_type', text: 'x'.repeat(31) + family + 'y' }]);
    assert.deepEqual(inputs(host).slice(-2).map(params => params.text), ['x'.repeat(31) + family, 'y']);
    assert.equal(host.requests.filter(request => request.action === 'capture').length, 3);
  } finally { await executor.close(); }
});

test('a lease that ends mid-action retires the lane with the posted count', async () => {
  const hosts = inputHost();
  hosts.attachments.length = 0;
  const executor = await nativeFactory(hostOnlyProfile({ hostInput: policy() }), { hostSpawn(command, args) {
    const child = hosts.spawnImpl(command, args);
    const host = hosts.attachments.at(-1);
    const write = child.stdout.write.bind(child.stdout);
    child.stdout.write = line => {
      const reply = JSON.parse(line);
      if (host.requests.find(request => request.id === reply.id)?.action === 'input') {
        return write(JSON.stringify({ id: reply.id, success: true, result: { instance_id: 'resident-test-app',
          session_id: reply.result.session_id, lease_lost: true,
          input: { kind: 'drag', posted_events: 5, completed: false, stop_reason: 'lease_lost' } } }) + '\n');
      }
      return write(line);
    };
    return child;
  } });
  try {
    await assert.rejects(executor.execute([{ action: 'mouse_drag', x: 0, y: 0, toX: 9, toY: 9 }]),
      /lease ended after 5 events/);
    assert.ok(executor.failed);
  } finally { await executor.close(); }
});

test('policy and shape refusals happen before admission and send no input', async () => {
  const { executor, host } = await executorFor({}, hostOnlyProfile({ hostInput: policy({
    applications: [LOGIC, 'com.apple.finder'] }) }));
  try {
    const refused = code => error => isPreAdmissionRefusal(error) && error.code === code;
    // Two applications: the action must name one of them.
    await assert.rejects(executor.execute([{ action: 'mouse_click', x: 1, y: 1 }]), refused('input_target_not_allowed'));
    await assert.rejects(executor.execute([{ action: 'mouse_click', x: 1, y: 1, app: 'com.apple.Terminal' }]),
      refused('input_target_not_allowed'));
    await assert.rejects(executor.execute([{ action: 'mouse_click', x: 512, y: 1, app: LOGIC }]), refused('invalid_input'));
    await assert.rejects(executor.execute([{ action: 'key_type', text: 'bell\u0007', app: LOGIC }]),
      refused('invalid_input'));
    await assert.rejects(executor.execute([{ action: 'key_combo', key: 's+cmd', app: LOGIC }]), refused('invalid_input'));
    executor.humanStopLatched = true;
    await assert.rejects(executor.execute([{ action: 'mouse_click', x: 1, y: 1, app: LOGIC }]),
      refused('human_stop_latched'));
    executor.humanStopLatched = false;
    executor.inputEnabled = false;
    await assert.rejects(executor.execute([{ action: 'key_tap', key: 'a', app: LOGIC }]), refused('input_disabled'));
    assert.deepEqual(inputs(host), []);
    executor.inputEnabled = true;
    await executor.execute([{ action: 'key_tap', key: 'a', app: 'com.apple.finder' }]);
    assert.equal(inputs(host)[0].target.bundle_id, 'com.apple.finder');
  } finally { await executor.close(); }
});

test('a Host refusal before the first event is a per-call error that keeps the lane', async () => {
  for (const reason of ['secure_input_active', 'input_target_mismatch', 'input_window_mismatch',
    'operator_input_detected', 'input_disabled', 'human_consent_required']) {
    let refuse = true;
    const { executor, host } = await executorFor({ answer: request => refuse ? refusal(request, reason) : undefined });
    try {
      const responses = await executor.execute([{ action: 'mouse_click', x: 1, y: 1 }, { action: 'screenshot' }]);
      assert.equal(responses.length, 1);
      assert.equal(responses[0].error.code, reason);
      assert.equal(executor.failed, undefined);
      assert.equal(host.requests.some(request => request.action === 'capture'), false);
      refuse = false;
      const [ok] = await executor.execute([{ action: 'mouse_click', x: 1, y: 1 }]);
      assert.equal(ok.result.host_input.posted_events, 3);
    } finally { await executor.close(); }
  }
});

test('a stop after some events reports input_interrupted with the count and never replays', async () => {
  let chunk = 0;
  const { executor, host } = await executorFor({ answer: () => ++chunk === 2
    ? { posted_events: 4, completed: false, stop_reason: 'operator_input_detected', released_events: 1,
      operator_input_events: 1 } : undefined });
  try {
    const [stopped] = await executor.execute([{ action: 'key_type', text: 'x'.repeat(70) }]);
    assert.equal(stopped.error.code, 'input_interrupted');
    const { readback, ...data } = stopped.error.data;
    assert.deepEqual(data, { reason: 'operator_input_detected', posted_events: 7, released_events: 1 });
    // The third chunk is never sent; the partial input is read back.
    assert.match(readback.image, /^iVBOR/);
    assert.equal(inputs(host).length, 2);
    assert.equal(host.requests.filter(request => request.action === 'capture').length, 1);
    assert.equal(executor.failed, undefined);
  } finally { await executor.close(); }
});

test('a malformed input receipt retires the executor', async () => {
  const { executor } = await executorFor({ answer: () => ({ kind: 'drag' }) });
  try {
    await assert.rejects(executor.execute([{ action: 'mouse_click', x: 1, y: 1 }]), /Invalid host-helper input receipt/);
    assert.ok(executor.failed);
  } finally { await executor.close(); }
});

test('MCP vnc_command returns the readback image and typed input refusals', async () => {
  const { executor } = await executorFor({ answer: request =>
    request.params.kind === 'key' ? refusal(request, 'secure_input_active') : undefined });
  try {
    const session = new McpSession(executor);
    const clicked = await session.command({ action: 'mouse_click', x: 3, y: 4 });
    assert.equal(clicked.isError, undefined);
    assert.ok(clicked.content.some(block => block.type === 'image'));
    const refusedKey = await session.command({ action: 'key_tap', key: 'a' });
    assert.equal(refusedKey.isError, true);
    assert.equal(refusedKey.structuredContent.error.code, "secure_input_active");
  } finally { await executor.close(); }
});

test('MCP shows the readback image of an interrupted input beside its typed error', async () => {
  const { executor } = await executorFor({ answer: () => ({ posted_events: 2, completed: false,
    stop_reason: 'input_target_mismatch' }) });
  try {
    const result = await new McpSession(executor).command({ action: 'mouse_double_click', x: 3, y: 4 });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'input_interrupted');
    assert.equal(result.structuredContent.error.data.readback.image, undefined);
    assert.ok(result.content.some(block => block.type === 'image'));
  } finally { await executor.close(); }
});
