// SPDX-License-Identifier: MIT
// #163 broker side: target-window-only capture by default for a Host input
// target, a display scope with exclusions, and fail-closed old Hosts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFactory } from '../lib/broker/server.mjs';
import { validateTargetTransport } from '../lib/broker/paths.mjs';
import { normalizeHostCapturePolicy } from '../lib/broker/host-helper.mjs';
import { isPreAdmissionRefusal } from '../lib/mcp/capabilities.js';
import { hostOnlyProfile, hostSequence, refusal } from './host-mock.mjs';

const LOGIC = 'com.apple.logic10';

const inputReply = (request, response) => {
  if (request.action === 'input' && response.success) response.result.input = { kind: request.params.kind,
    posted_events: 1, completed: true, operator_input_events: 0, released_events: 0,
    target_bundle_id: request.params.target.bundle_id };
  return response;
};

async function executorFor(profile, { capabilities = ['input', 'capture_scope'], alter = inputReply } = {}) {
  const hosts = hostSequence({ capabilities, alter, health: { input_enabled: true, input_post_permission: true,
    operator_input_monitor: 'event_tap' } });
  const executor = await nativeFactory(profile, { hostSpawn: hosts.spawnImpl });
  return { executor, host: hosts.attachments[0] };
}
const captures = host => host.requests.filter(request => request.action === 'capture').map(request => request.params);

test('policies normalize to a target scope by default for a Host input target', () => {
  assert.deepEqual(normalizeHostCapturePolicy(undefined, { applications: [LOGIC] }),
    { scope: 'target', applications: [LOGIC] });
  assert.deepEqual(normalizeHostCapturePolicy(undefined, undefined), { scope: 'display' });
  assert.deepEqual(normalizeHostCapturePolicy({ scope: 'display', exclude: ['com.cmuxterm.app'] }),
    { scope: 'display', exclude: ['com.cmuxterm.app'] });
  for (const bad of [{ scope: 'window' }, { scope: 'target' }, { scope: 'display', applications: [LOGIC] },
    { exclude: ['x.y'] }, { applications: ['../x'] }, { other: 1 }]) {
    assert.throws(() => normalizeHostCapturePolicy(bad), /hostCapture/);
    if (!(bad.scope === 'target' && !bad.applications)) {
      assert.throws(() => validateTargetTransport(hostOnlyProfile({ hostCapture: bad })), /hostCapture/);
    }
  }
  assert.throws(() => validateTargetTransport({ hostCapture: { scope: 'display' } }), /Host-only/);
});

test('captures for a Host input target keep only its windows, readback included', async () => {
  const { executor, host } = await executorFor(hostOnlyProfile({ hostInput: { applications: [LOGIC] } }));
  try {
    await executor.execute([{ action: 'screenshot' }]);
    await executor.execute([{ action: 'mouse_click', x: 1, y: 1 }]);
    assert.ok(captures(host).length >= 2);
    assert.ok(captures(host).every(params => params.include_bundle_ids?.[0] === LOGIC &&
      params.exclude_bundle_ids === undefined));
  } finally { await executor.close(); }
});

test('a display scope sends its exclusions; the Host adds its private list itself', async () => {
  const { executor, host } = await executorFor(hostOnlyProfile({ hostCapture: { scope: 'display',
    exclude: ['com.cmuxterm.app'] } }), { capabilities: [] });
  try {
    await executor.execute([{ action: 'screenshot' }]);
    assert.deepEqual(captures(host)[0].exclude_bundle_ids, ['com.cmuxterm.app']);
    assert.equal(captures(host)[0].include_bundle_ids, undefined);
  } finally { await executor.close(); }
});

test('a target scope fails closed on a Host without capture_scope', async () => {
  const { executor, host } = await executorFor(hostOnlyProfile({ hostCapture: { applications: [LOGIC] } }),
    { capabilities: [] });
  try {
    await assert.rejects(executor.execute([{ action: 'screenshot' }]),
      error => isPreAdmissionRefusal(error) && error.code === 'capture_scope_unsupported');
    assert.deepEqual(captures(host), []);
  } finally { await executor.close(); }
});

test('a target that is not running is a per-call error that keeps the lane', async () => {
  let refuse = true;
  const { executor } = await executorFor(hostOnlyProfile({ hostCapture: { applications: [LOGIC] } }), {
    alter: (request, response) => request.action === 'capture' && refuse
      ? refusal(request, 'capture_target_unavailable') : response });
  try {
    const responses = await executor.execute([{ action: 'screenshot' }, { action: 'ax_snapshot' }]);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].error.data.code, 'capture_target_unavailable');
    assert.equal(executor.failed, undefined);
    refuse = false;
    const [shot] = await executor.execute([{ action: 'screenshot' }]);
    assert.match(shot.result.image, /^iVBOR/);
  } finally { await executor.close(); }
});
