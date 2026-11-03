// SPDX-License-Identifier: MIT
// #182: a window refusal names the refusing window; #178: a screen-edge
// refusal is a typed per-call error. Mock SSH Host only; no desktop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFactory } from '../lib/broker/server.mjs';
import { windowRefusalDetail } from '../lib/broker/host-helper.mjs';
import { TYPED_REFUSAL_CODES } from '../lib/mcp/capabilities.js';
import { hostOnlyProfile, hostSequence } from './host-mock.mjs';

const LOGIC = 'com.apple.logic10';
const detail = (extra = {}) => ({ schema: 'fruitctl.host-window-refusal.v1', owner_pid: 524, owner_name: 'cmux',
  owner_bundle_id: 'com.cmuxterm.app', owner_code_id: null, window_server: false, layer: 0,
  bounds: { x: 10, y: 20, width: 300, height: 201 }, parent_owner_pid: null, frontmost_pid: 529, ...extra });

async function executorFor(answer) {
  const hosts = hostSequence({ capabilities: ['input', 'capture_scope'],
    health: { input_enabled: true, input_post_permission: true, operator_input_monitor: 'event_tap' },
    alter(request, response) {
      if (request.action !== 'input' || !response.success) return response;
      const custom = answer(request);
      if (custom?.success === false) return custom;
      response.result.input = { kind: request.params.kind, posted_events: 3, completed: true,
        operator_input: request.params.operator_input, operator_input_events: 0, released_events: 0,
        operator_input_monitor: 'event_tap', target_bundle_id: request.params.target.bundle_id, ...custom };
      return response;
    } });
  const executor = await nativeFactory(hostOnlyProfile({ hostInput: { applications: [LOGIC] } }),
    { hostSpawn: hosts.spawnImpl });
  return executor;
}
const refuse = (request, message, data) => ({ id: request.id, success: false,
  error: { code: -32000, message, ...(data === undefined ? {} : { data }) } });

test('the detail is sanitized to its declared fields', () => {
  const window = windowRefusalDetail(detail());
  assert.deepEqual(Object.keys(window).sort(), ['bounds', 'frontmost_pid', 'layer', 'owner_bundle_id', 'owner_code_id',
    'owner_name', 'owner_pid', 'parent_owner_pid', 'window_server']);
  assert.equal(window.schema, undefined);
  for (const bad of [detail({ schema: 'other' }), detail({ title: 'Secret doc' }), detail({ owner_name: 'a\u0007' }),
    detail({ owner_bundle_id: '../x' }), detail({ bounds: { x: 1, y: 2, width: 3 } }), detail({ layer: 1.5 }),
    detail({ window_server: 'no' }), detail({ owner_name: 'x'.repeat(65) }), null, []]) {
    assert.equal(windowRefusalDetail(bad), undefined, JSON.stringify(bad));
  }
});

test('a window refusal before the first event carries the window', async () => {
  const executor = await executorFor(request => refuse(request, 'input_window_mismatch', detail()));
  try {
    const responses = await executor.execute([{ action: 'mouse_click', x: 10, y: 10 }, { action: 'screenshot' }]);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].error.data.code, 'input_window_mismatch');
    assert.equal(responses[0].error.data.window.owner_name, 'cmux');
    assert.equal(responses[0].error.data.window.frontmost_pid, 529);
    assert.equal(executor.failed, undefined);
  } finally { await executor.close(); }
  // A malformed detail is dropped; the typed refusal stays.
  const loose = await executorFor(request => refuse(request, 'input_window_mismatch', detail({ title: 'Secret' })));
  try {
    const [response] = await loose.execute([{ action: 'mouse_click', x: 10, y: 10 }]);
    assert.equal(response.error.data.code, 'input_window_mismatch');
    assert.equal(response.error.data.window, undefined);
  } finally { await loose.close(); }
});

test('a window check that stops an action reports the window with the count', async () => {
  const { schema: _schema, ...stop } = detail({ window_server: true, owner_name: 'Window Server' });
  const executor = await executorFor(() => ({ posted_events: 1, completed: false, stop_reason: 'input_window_mismatch',
    stop_detail: { schema: 'fruitctl.host-window-refusal.v1', ...stop } }));
  try {
    const [response] = await executor.execute([{ action: 'mouse_click', x: 10, y: 10 }]);
    assert.equal(response.error.data.code, 'input_interrupted');
    assert.equal(response.error.data.reason, 'input_window_mismatch');
    assert.equal(response.error.data.window.owner_name, 'Window Server');
    assert.equal(response.error.data.posted_events, 1);
  } finally { await executor.close(); }
  const forged = await executorFor(() => ({ posted_events: 1, completed: false, stop_reason: 'input_window_mismatch',
    stop_detail: { schema: 'fruitctl.host-window-refusal.v1', title: 'x' } }));
  try {
    await assert.rejects(forged.execute([{ action: 'mouse_click', x: 10, y: 10 }]), /Invalid host-helper input receipt/);
  } finally { await forged.close(); }
});

test('a screen-edge refusal is a typed per-call error that keeps the lane', async () => {
  assert.ok(TYPED_REFUSAL_CODES.includes('input_screen_edge'));
  const executor = await executorFor(request => refuse(request, 'input_screen_edge'));
  try {
    const responses = await executor.execute([{ action: 'mouse_click', x: 511, y: 255 }, { action: 'screenshot' }]);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].error.data.code, 'input_screen_edge');
    assert.equal(executor.failed, undefined);
  } finally { await executor.close(); }
});
