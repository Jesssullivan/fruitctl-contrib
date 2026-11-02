// SPDX-License-Identifier: MIT
// #159: pre-act Host refusals are per-call errors, and a failed Host-only
// lane proves its own release instead of latching the broker. Mock SSH only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeFactory, TargetLane, createBroker } from '../lib/broker/server.mjs';
import { BrokerExecutor } from '../lib/broker/client.mjs';
import { McpSession } from '../lib/mcp/server.js';
import { hostOnlyProfile, hostSequence, refusal } from './host-mock.mjs';

const PRE_ACT = ['stale_ref', 'ax_unreachable', 'ax_action_unsupported', 'human_consent_required'];

async function executorFor(options) {
  const hosts = hostSequence(options);
  const executor = await nativeFactory(hostOnlyProfile(), { hostSpawn: hosts.spawnImpl });
  return { executor, hosts, host: hosts.attachments[0] };
}

test('a pre-act AX refusal ends the batch as a per-call error and keeps the lane and lease', async () => {
  for (const reason of PRE_ACT) {
    let refuse = true;
    const { executor, host } = await executorFor({ alter(request, response) {
      return request.action === 'ax_action' && refuse ? refusal(request, reason) : response;
    } });
    try {
      await executor.execute([{ action: 'ax_snapshot' }]);
      const responses = await executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' },
        { action: 'screenshot' }]);
      assert.equal(responses.length, 1, reason);
      assert.equal(responses[0].error.data.code, reason);
      assert.match(responses[0].error.message, new RegExp(reason));
      if (reason === 'human_consent_required') assert.equal(responses[0].error.data.reason, reason);
      assert.equal(executor.failed, undefined);
      // The lease state was read inside the helper queue, then the batch stopped.
      const actions = host.requests.map(request => request.action);
      assert.equal(actions[actions.indexOf('ax_action') + 1], 'health');
      assert.equal(actions.includes('capture'), false);
      assert.equal(executor.activityActive, true);
      refuse = false;
      const [pressed] = await executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]);
      assert.equal(pressed.result.ax_action.path, 'ax_press');
      assert.equal(host.requests.filter(request => request.action === 'begin_activity').length, 1);
    } finally { await executor.close(); }
  }
});

test('MCP reports a per-call AX refusal with its typed code and the session continues', async () => {
  let refuse = true;
  const { executor } = await executorFor({ alter(request, response) {
    return request.action === 'ax_action' && refuse ? refusal(request, 'ax_action_unsupported') : response;
  } });
  try {
    const session = new McpSession(executor);
    await session.command({ action: 'ax_snapshot' });
    // An older client accepts only integer codes: the wire reply must pass it.
    const { validateResponse } = await import('../lib/mcp/protocol.js');
    const legacy = (await import('zod')).z.object({ error: (await import('zod')).z.object({
      code: (await import('zod')).z.number().int(), message: (await import('zod')).z.string() }).passthrough() });
    await executor.execute([{ action: 'ax_snapshot' }]);
    const [wire] = await executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]);
    assert.equal(legacy.safeParse(wire).success, true);
    assert.equal(validateResponse(wire).error.code, 'ax_action_unsupported');
    await session.command({ action: 'ax_snapshot' });
    const refused = await session.command({ action: 'click_element', ref: 'ax:77:0.0' });
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent.error.code, 'ax_action_unsupported');
    const queued = await session.queue({ actions: [{ action: 'wait', ms: 50 }] });
    assert.equal(queued.isError, undefined);
    refuse = false;
    const pressed = await session.command({ action: 'click_element', ref: 'ax:77:0.0' });
    assert.equal(pressed.isError, undefined);
    assert.equal(executor.failed, undefined);
  } finally { await executor.close(); }
});

test('a Host that released its lease with the refusal is begun again by the next batch', async () => {
  const { executor, host } = await executorFor({
    releaseOn: request => request.action === 'ax_action',
    alter: (request, response) => request.action === 'ax_action' ? refusal(request, 'ax_action_unsupported') : response,
  });
  try {
    await executor.execute([{ action: 'ax_snapshot' }]);
    const [refused] = await executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]);
    assert.equal(refused.error.data.code, 'ax_action_unsupported');
    assert.equal(executor.failed, undefined);
    assert.equal(executor.activityActive, false);
    // Refs of the ended lease are gone on both sides.
    await assert.rejects(executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]),
      error => error.code === 'stale_ref');
    // No heartbeat renews the ended lease; the next batch begins a new one.
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(executor.failed, undefined);
    const before = host.requests.filter(request => request.action === 'begin_activity').length;
    await executor.execute([{ action: 'screenshot' }]);
    assert.equal(host.requests.filter(request => request.action === 'begin_activity').length, before + 1);
  } finally { await executor.close(); }
});

test('an unconfirmed lease state after a refusal still retires the executor', async () => {
  const { executor } = await executorFor({ alter(request, response, lease) {
    if (request.action === 'ax_action') return refusal(request, 'ax_action_unsupported');
    // Health names a different session: neither retained nor released.
    if (request.action === 'health' && lease.owner) {
      response.result.session_id = 'another-session';
    }
    return response;
  } });
  try {
    await executor.execute([{ action: 'ax_snapshot' }]);
    await assert.rejects(executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]),
      /lease state after a refusal is unconfirmed/);
    assert.ok(executor.failed);
  } finally { await executor.close(); }
});

test('a forged or unrecognized refusal reason is not a per-call error', async () => {
  const { executor } = await executorFor({ alter(request, response) {
    return request.action === 'ax_action' ? refusal(request, 'ax_action_unsupported; extra') : response;
  } });
  try {
    await executor.execute([{ action: 'ax_snapshot' }]);
    await assert.rejects(executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]),
      error => error.code === undefined && /Host helper refused request/.test(error.message));
    assert.ok(executor.failed);
  } finally { await executor.close(); }
});

function laneFor(hosts) {
  return new TargetLane(hostOnlyProfile(), (profile, options) =>
    nativeFactory(profile, { ...options, hostSpawn: hosts.spawnImpl }), { retirementMs: 2000 });
}

test('a failed Host-only lane proves release from a fresh attachment and serves the next owner', async () => {
  let fail = true;
  const hosts = hostSequence({ alter(request, response) {
    return request.action === 'capture' && fail ? refusal(request, 'capture_failed') : response;
  } });
  const lane = laneFor(hosts);
  try {
    lane.acquire('first');
    await assert.rejects(lane.execute([{ action: 'screenshot' }]), /capture_failed/);
    await lane.release('first');
    assert.equal(lane.cleanupFailure, undefined);
    // The probe sent health only and its own child exited.
    assert.deepEqual(hosts.attachments[1].requests.map(request => request.action), ['health']);
    assert.ok(hosts.attachments.slice(0, 2).every(host => host.child.signalCode !== null));
    fail = false;
    lane.acquire('second');
    const [shot] = await lane.execute([{ action: 'screenshot' }]);
    assert.equal(shot.result.scaledWidth, 512);
    assert.equal(hosts.attachments.length, 3);
  } finally { await lane.close().catch(() => {}); }
});

test('release stays latched while the Host reports another session, then reconcile clears it', async () => {
  const hosts = hostSequence(index => ({ alter(request, response, lease) {
    if (index === 0 && request.action === 'capture') return refusal(request, 'capture_failed');
    // The first probe sees a lease this broker never held.
    if (index === 1 && request.action === 'health') Object.assign(response.result, { session_id: 'other',
      ready: true, overlay_ready: true, capture_ready: true, lease_remaining_ms: 2000 });
    return response;
  } }));
  const lane = laneFor(hosts);
  try {
    lane.acquire('first');
    await assert.rejects(lane.execute([{ action: 'screenshot' }]));
    await assert.rejects(lane.release('first'), error => error.code === 'release_unconfirmed');
    assert.ok(lane.cleanupFailure);
    assert.throws(() => lane.acquire('second'), /release is unconfirmed/);
    const receipt = await lane.reconcile();
    assert.equal(receipt.reconciled, true);
    assert.equal(receipt.host.lease_remaining_ms, 0);
    assert.deepEqual(receipt.first_cause, { phase: 'host_helper', reason: 'helper_refused' });
    assert.equal(lane.cleanupFailure, undefined);
    lane.acquire('second');
    await lane.execute([{ action: 'health' }]);
  } finally { await lane.close().catch(() => {}); }
});

test('reconcile refuses a lane that is not Host-only and reports an unlatched lane', async () => {
  const lane = new TargetLane({}, async () => ({ async execute() { throw new Error('native failure'); },
    async release() { throw new Error('release failed'); }, async close() {} }), { retirementMs: 200 });
  assert.deepEqual(await lane.reconcile(), { reconciled: false, latched: false });
  lane.acquire('owner');
  await assert.rejects(lane.execute([{ action: 'health' }]));
  await assert.rejects(lane.release('owner'));
  await assert.rejects(lane.reconcile(), error => error.code === 'reconcile_unsupported');
  assert.ok(lane.cleanupFailure);
  await lane.close().catch(() => {});
});

test('fruitctl reconcile reaches the broker over its socket and returns the receipt', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-reconcile-'));
  await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const hosts = hostSequence(index => ({ alter(request, response) {
    if (index === 0 && request.action === 'capture') return refusal(request, 'capture_failed');
    if (index === 1 && request.action === 'health') Object.assign(response.result, { session_id: 'other',
      ready: true, overlay_ready: true, capture_ready: true, lease_remaining_ms: 2000 });
    return response;
  } }));
  const socketPath = path.join(directory, 'broker.sock');
  const broker = await createBroker({ socketPath, config: { targets: { neo: hostOnlyProfile() } },
    factory: (profile, options) => nativeFactory(profile, { ...options, hostSpawn: hosts.spawnImpl }) });
  t.after(() => broker.close().catch(() => {}));
  const client = new BrokerExecutor({ socketPath, target: 'neo' });
  t.after(() => client.close());
  await client.opened;
  const session = new McpSession(client);
  const failed = await session.command({ action: 'screenshot' });
  assert.equal(failed.isError, true);
  // The server releases the failed owner after its error reply.
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(broker.lanes.get('neo').cleanupFailure);
  const operator = new BrokerExecutor({ socketPath, target: 'neo' });
  t.after(() => operator.close());
  await operator.opened;
  const receipt = await operator.reconcile();
  assert.equal(receipt.reconciled, true);
  assert.equal(broker.lanes.get('neo').cleanupFailure, undefined);
  const again = await operator.reconcile();
  assert.deepEqual(again, { reconciled: false, latched: false });
});
