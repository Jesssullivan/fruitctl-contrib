// SPDX-License-Identifier: MIT
// #177: the Host activity ends soon after the agent's last request, and at
// once when the agent's connection closes. #180: modifier-drags and fine drag
// offsets on the Host route. Mock SSH Host only; no desktop.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker, nativeFactory } from '../lib/broker/server.mjs';
import { validateTargetTransport } from '../lib/broker/paths.mjs';
import { HostHelperExecutor } from '../lib/broker/host-helper.mjs';
import { isPreAdmissionRefusal, requireNativeActions } from '../lib/mcp/capabilities.js';
import { readFrames, writeFrame } from '../lib/broker/protocol.mjs';
import { validateActionParameters } from '../tools/index.js';
import { hostBinding, hostOnlyProfile, hostSequence } from './host-mock.mjs';

const LOGIC = 'com.apple.logic10';
const count = (host, action) => host.requests.filter(request => request.action === action).length;

async function executorFor({ idle = 60, alter, profile = hostOnlyProfile({ hostInput: { applications: [LOGIC] } }) } = {}) {
  const hosts = hostSequence({ capabilities: ['input', 'capture_scope'],
    health: { input_enabled: true, input_post_permission: true, operator_input_monitor: 'event_tap' },
    alter(request, response) {
      if (request.action === 'input' && response.success) {
        response.result.input = { kind: request.params.kind, posted_events: 3, completed: true,
          operator_input: request.params.operator_input, operator_input_events: 0, released_events: 0,
          operator_input_monitor: 'event_tap', target_bundle_id: request.params.target.bundle_id };
      }
      return alter ? alter(request, response) : response;
    } });
  const executor = await nativeFactory(profile, { hostSpawn: hosts.spawnImpl,
    ...(idle === undefined ? {} : { hostActivityIdleMs: idle }) });
  return { executor, host: hosts.attachments[0], hosts };
}

test('the Host activity ends after the idle period and begins again on the next request', async () => {
  const { executor, host } = await executorFor({ idle: 60 });
  try {
    await executor.execute([{ action: 'ax_snapshot' }]);
    assert.equal(executor.presentation.indicator, 'present');
    assert.equal(executor.axRefs.size, 2);
    await delay(250);
    assert.equal(count(host, 'release_activity'), 1);
    assert.equal(executor.idleReleases, 1);
    assert.equal(executor.presentation.indicator, 'unknown');
    // The Host discarded its element refs with the lease; so does the broker.
    assert.equal(executor.axRefs.size, 0);
    await assert.rejects(executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]),
      error => isPreAdmissionRefusal(error) && error.code === 'stale_ref');
    const begins = count(host, 'begin_activity');
    await executor.execute([{ action: 'screenshot' }]);
    assert.equal(count(host, 'begin_activity'), begins + 1);
    assert.equal(executor.presentation.indicator, 'present');
    assert.equal(executor.failed, undefined);
  } finally { await executor.close(); }
});

test('requests inside the idle period keep one activity', async () => {
  const { executor, host } = await executorFor({ idle: 150 });
  try {
    for (let index = 0; index < 4; index++) {
      await executor.execute([{ action: 'wait', ms: 50 }]);
      await delay(40);
    }
    assert.equal(count(host, 'release_activity'), 0);
    assert.equal(count(host, 'begin_activity'), 1);
  } finally { await executor.close(); }
});

test('a health-only batch neither begins an activity nor arms the release', async () => {
  const { executor, host } = await executorFor({ idle: 30 });
  try {
    await executor.execute([{ action: 'health' }]);
    await delay(120);
    assert.equal(count(host, 'begin_activity'), 0);
    assert.equal(count(host, 'release_activity'), 0);
  } finally { await executor.close(); }
});

test('idle 0 keeps the activity until the lane releases', async () => {
  const { executor, host } = await executorFor({ idle: 0 });
  try {
    await executor.execute([{ action: 'screenshot' }]);
    await delay(150);
    assert.equal(count(host, 'release_activity'), 0);
    assert.equal(executor.presentation.indicator, 'present');
  } finally { await executor.close(); }
});

test('an unconfirmed idle release fails the executor', async () => {
  const { executor } = await executorFor({ idle: 40, alter(request, response) {
    if (request.action === 'release_activity') response.result.lease_remaining_ms = 2000;
    return response;
  } });
  try {
    await executor.execute([{ action: 'screenshot' }]);
    await delay(200);
    assert.ok(executor.failed);
    await assert.rejects(executor.execute([{ action: 'screenshot' }]));
  } finally { await executor.close().catch(() => {}); }
});

test('the default is 10 s on the Host-only route and off on a VNC route; profiles validate it', () => {
  const executor = new HostHelperExecutor({ nativeExecutor: {}, hostHelper: hostBinding(), hostOnly: true });
  assert.equal(executor.activityIdleMs, 10000);
  assert.equal(new HostHelperExecutor({ nativeExecutor: {}, hostHelper: hostBinding() }).activityIdleMs, 0);
  assert.throws(() => new HostHelperExecutor({ nativeExecutor: {}, hostHelper: hostBinding(), activityIdleMs: 5000 }),
    /activity idle period/);
  for (const value of [0, 1000, 600000]) {
    assert.equal(validateTargetTransport(hostOnlyProfile({ hostActivityIdleMs: value })), true);
  }
  for (const value of [-1, 1, 999, 600001, 1.5, '10000']) {
    assert.throws(() => validateTargetTransport(hostOnlyProfile({ hostActivityIdleMs: value })), /hostActivityIdleMs/);
  }
  assert.throws(() => validateTargetTransport({ hostActivityIdleMs: 1000 }), /requires the Host-only transport/);
});

test('closing the agent connection releases the lane at once', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-idle-'));
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, 'broker.sock');
  const closes = [];
  const broker = await createBroker({ socketPath, config: { targets: { desktop: {} } }, leaseMs: 60000,
    factory: async () => ({
      async execute(actions) { return actions.map(() => ({ result: { detail: 'OK' } })); },
      async close() { closes.push(Date.now()); },
    }) });
  const socket = net.connect(socketPath);
  try {
    await new Promise((resolve, reject) => {
      readFrames(socket, frame => {
        if (frame.kind === 'opened') writeFrame(socket, { v: 1, kind: 'execute', id: 'one', actions: [{ action: 'wait' }] });
        if (frame.kind === 'result') resolve();
      }, reject);
      socket.once('error', reject);
      socket.once('connect', () => writeFrame(socket, { v: 1, kind: 'open', profile: 'desktop' }));
    });
    assert.equal(broker.status().targets.desktop.owned, true);
    socket.destroy();
    for (let index = 0; index < 50 && closes.length === 0; index++) await delay(10);
    assert.equal(closes.length, 1, 'the executor and its Host activity are released without waiting for the lease');
    assert.equal(broker.status().targets.desktop.owned, false);
  } finally {
    socket.destroy();
    await broker.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a modifier-drag and a fine drag reach the Host on the Host route only', async () => {
  const { executor, host } = await executorFor({ idle: 0 });
  try {
    await executor.execute([{ action: 'mouse_drag', x: 100, y: 50, toX: 100, toY: 60, modifiers: ['shift'] }]);
    await executor.execute([{ action: 'mouse_drag', x: 100, y: 50, fine_dy: -1 }]);
    await executor.execute([{ action: 'mouse_drag', x: 100, y: 50, fine_dx: 3, fine_dy: 2, modifiers: ['shift'] }]);
    const drags = host.requests.filter(request => request.action === 'input').map(request => request.params);
    assert.deepEqual(drags[0].modifiers, ['shift']);
    // The mock display maps screenshot pixels one to one onto framebuffer pixels.
    assert.deepEqual([drags[1].x, drags[1].y, drags[1].to_x, drags[1].to_y], [100, 50, 100, 49]);
    assert.deepEqual([drags[2].to_x, drags[2].to_y, drags[2].modifiers], [103, 52, ['shift']]);
    for (const bad of [{ fine_dx: 65 }, { fine_dy: 1, toX: 1, toY: 1 }, { fine_dx: -200 }, { fine_dy: 1.5 },
      { fine_dx: 0, fine_dy: 0 }, { fine_dy: 1, modifiers: ['cmd'] }, { fine_dy: 1, modifiers: ['shift', 'alt'] }]) {
      await assert.rejects(executor.execute([{ action: 'mouse_drag', x: 100, y: 50, ...bad }]),
        error => isPreAdmissionRefusal(error) && error.code === 'invalid_input', JSON.stringify(bad));
    }
    await assert.rejects(executor.execute([{ action: 'mouse_drag', x: 0, y: 0, fine_dx: -1 }]),
      error => isPreAdmissionRefusal(error) && error.code === 'invalid_input');
  } finally { await executor.close(); }
  // The VNC daemon accepts modifiers only on mouse_click.
  for (const action of [{ action: 'mouse_drag', x: 1, y: 1, toX: 2, toY: 2, modifiers: ['shift'] },
    { action: 'mouse_drag', x: 1, y: 1, fine_dx: 1 }]) {
    assert.throws(() => requireNativeActions([action], { known: false, actions: [] }),
      error => error.code === 'unsupported_on_route');
  }
});

test('the MCP schema takes modifiers and fine offsets on mouse_drag', () => {
  assert.doesNotThrow(() => validateActionParameters({ action: 'mouse_drag', x: 1, y: 1, toX: 2, toY: 2,
    modifiers: ['shift'] }));
  assert.doesNotThrow(() => validateActionParameters({ action: 'mouse_drag', x: 1, y: 1, fine_dy: -1 }));
  assert.throws(() => validateActionParameters({ action: 'mouse_drag', x: 1, y: 1 }), /Missing toX/);
  assert.throws(() => validateActionParameters({ action: 'mouse_drag', x: 1, y: 1, toX: 2, toY: 2, fine_dx: 1 }),
    /not both/);
  assert.throws(() => validateActionParameters({ action: 'mouse_move', x: 1, y: 1, fine_dx: 1 }), /only to mouse_drag/);
  assert.throws(() => validateActionParameters({ action: 'scroll', x: 1, y: 1, direction: 'up', modifiers: ['shift'] }),
    /mouse_click and mouse_drag/);
});

test('a refused request re-arms the idle period, and health checks do not hold it', async () => {
  const { executor, host } = await executorFor({ idle: 80 });
  try {
    await executor.execute([{ action: 'screenshot' }]);
    await assert.rejects(executor.execute([{ action: 'mouse_drag', x: 1, y: 1, fine_dx: 99 }]),
      error => isPreAdmissionRefusal(error));
    for (let index = 0; index < 4; index++) {
      await executor.execute([{ action: 'health' }]);
      await delay(30);
    }
    await delay(150);
    assert.equal(count(host, 'release_activity'), 1);
  } finally { await executor.close().catch(() => {}); }
});

test('a request during an unanswered release is refused before admission; the deadline fails the executor', async () => {
  let drop = true;
  const { executor } = await executorFor({ idle: 30, alter(request, response) {
    return request.action === 'release_activity' && drop ? null : response;
  } });
  try {
    await executor.execute([{ action: 'ax_snapshot' }]);
    await delay(80);
    // The release committed: refs are gone before its reply.
    await assert.rejects(executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]),
      error => isPreAdmissionRefusal(error) && error.code === 'stale_ref');
    await delay(2300);
    assert.ok(executor.failed, 'an unconfirmed release still fails closed');
    drop = false;
  } finally { await executor.close().catch(() => {}); }
});

test('another session on the Host after an idle release is a per-call host_busy, and release still proves itself', async () => {
  let busy = false;
  const { executor, host } = await executorFor({ idle: 40, alter(request, response) {
    if (request.action === 'begin_activity' && busy) {
      return { id: request.id, success: false, error: { code: -32000, message: 'host_busy' } };
    }
    if (request.action === 'health' && busy) {
      Object.assign(response.result, { session_id: 'another-session', ready: true, overlay_ready: true,
        capture_ready: true, lease_remaining_ms: 2500 });
    }
    return response;
  } });
  try {
    await executor.execute([{ action: 'screenshot' }]);
    await delay(150);
    assert.equal(count(host, 'release_activity'), 1);
    busy = true;
    const responses = await executor.execute([{ action: 'screenshot' }, { action: 'screenshot' }]);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].error.data.code, 'host_busy');
    assert.equal(executor.failed, undefined);
    await executor.release();
    assert.equal(executor.failed, undefined);
  } finally { await executor.close().catch(() => {}); }
});
