// SPDX-License-Identifier: MIT
// TIN-8604: after its relay connection drops, the broker client opens a new
// connection on the next execute, once, and never replays work that may have
// reached the broker. A reconnected client is a new broker session: no lease,
// and input waits for a new screenshot.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker } from '../lib/broker/server.mjs';
import { BrokerExecutor } from '../lib/broker/client.mjs';
import { McpSession } from '../lib/mcp/server.js';
import { readFrames, writeFrame } from '../lib/broker/protocol.mjs';

const TEST_TIMEOUT = { timeout: 20000 };

async function directory(t) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-reconnect-'));
  await fs.chmod(created, 0o700);
  t.after(() => fs.rm(created, { recursive: true, force: true }));
  return created;
}

async function waitUntil(predicate, message, timeoutMs = 2000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) assert.fail(message);
    await delay(2);
  }
}

// A relay double that speaks the broker protocol itself. Each accepted
// connection records its frames; the test answers or drops it.
async function fakeRelay(t, socketPath, { answer = true } = {}) {
  const connections = [];
  const server = net.createServer(socket => {
    const connection = { socket, frames: [] };
    connections.push(connection);
    readFrames(socket, frame => {
      connection.frames.push(frame);
      if (!answer) return;
      if (frame.kind === 'open') writeFrame(socket, { v: 1, kind: 'opened', clientId: `c${connections.length}` });
      if (frame.kind === 'execute' && !connection.hold) {
        writeFrame(socket, { v: 1, kind: 'result', id: frame.id,
          responses: frame.actions.map(action => ({ result: { detail: action.action } })) });
      }
    }, () => socket.destroy());
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const close = () => new Promise(resolve => {
    for (const { socket } of connections) socket.destroy();
    server.close(resolve);
  });
  t.after(close);
  return { connections, close };
}

const executes = connection => connection.frames.filter(frame => frame.kind === 'execute');

test('a dropped connection reconnects on the next call, once, as a new session', TEST_TIMEOUT, async t => {
  const socketPath = path.join(await directory(t), 'relay.sock');
  const relay = await fakeRelay(t, socketPath);
  const executor = new BrokerExecutor({ socketPath, target: 'desktop' });
  t.after(() => executor.close());
  await executor.opened;
  assert.equal((await executor.execute([{ action: 'health' }]))[0].result.detail, 'health');

  relay.connections[0].socket.destroy();
  await waitUntil(() => executor.closed, 'the client sees the drop');
  assert.equal(relay.connections.length, 1, 'nothing reconnects in the background');
  await delay(50);
  assert.equal(relay.connections.length, 1, 'still nothing without a call');

  const after = await executor.execute([{ action: 'screenshot' }]);
  assert.equal(after[0].result.detail, 'screenshot');
  assert.equal(relay.connections.length, 2, 'one new connection');
  assert.deepEqual(relay.connections[1].frames.map(frame => frame.kind), ['open', 'execute']);
  assert.equal(relay.connections[1].frames[0].profile, 'desktop');
  assert.equal(executor.generation, 2);
});

test('a call in flight when the link drops fails as uncertain and is not replayed', TEST_TIMEOUT, async t => {
  const socketPath = path.join(await directory(t), 'relay.sock');
  const relay = await fakeRelay(t, socketPath);
  const executor = new BrokerExecutor({ socketPath, target: 'desktop' });
  t.after(() => executor.close());
  await executor.opened;
  relay.connections[0].hold = true;
  const running = executor.execute([{ action: 'left_click', x: 10, y: 20 }], { timeoutMs: 5000 });
  await waitUntil(() => executes(relay.connections[0]).length === 1, 'execute reached the relay');
  // The relay's own typed loss, then its close, as relay.mjs sends it.
  writeFrame(relay.connections[0].socket, { v: 1, kind: 'error', error: { code: 'bridge_lost',
    message: 'Fruitctl SSH bridge lost; input was not replayed and in-flight execution is uncertain' } });
  relay.connections[0].socket.end();
  await assert.rejects(running, error => error.code === 'bridge_lost' && /uncertain/.test(error.message));

  const next = await executor.execute([{ action: 'screenshot' }]);
  assert.equal(next[0].result.detail, 'screenshot');
  assert.equal(relay.connections.length, 2);
  assert.deepEqual(executes(relay.connections[1]).map(frame => frame.actions[0].action), ['screenshot'],
    'the new connection carries only the new call, never the uncertain click');
  assert.equal(executes(relay.connections[0]).length, 1);
});

test('a raw socket close in flight keeps the untyped uncertain failure', TEST_TIMEOUT, async t => {
  const socketPath = path.join(await directory(t), 'relay.sock');
  const relay = await fakeRelay(t, socketPath);
  const executor = new BrokerExecutor({ socketPath, target: 'desktop' });
  t.after(() => executor.close());
  await executor.opened;
  relay.connections[0].hold = true;
  const running = executor.execute([{ action: 'key_tap', key: 'return' }], { timeoutMs: 5000 });
  await waitUntil(() => executes(relay.connections[0]).length === 1, 'execute reached the relay');
  relay.connections[0].socket.destroy();
  await assert.rejects(running, error => error.code === undefined && /uncertain/.test(error.message));
  await executor.execute([{ action: 'health' }]);
  assert.deepEqual(executes(relay.connections[1]).map(frame => frame.actions[0].action), ['health']);
});

test('a relay that is down fails each call as broker_unavailable with one attempt and no loop', TEST_TIMEOUT, async t => {
  const socketPath = path.join(await directory(t), 'relay.sock');
  const relay = await fakeRelay(t, socketPath);
  const executor = new BrokerExecutor({ socketPath, target: 'desktop', reconnectTimeoutMs: 500 });
  t.after(() => executor.close());
  await executor.opened;
  await relay.close();
  await waitUntil(() => executor.closed, 'the client sees the relay go');

  for (let call = 1; call <= 3; call++) {
    const started = performance.now();
    await assert.rejects(executor.execute([{ action: 'health' }], { timeoutMs: 5000 }),
      error => error.code === 'broker_unavailable');
    assert.ok(performance.now() - started < 1000, 'the attempt is bounded');
    assert.equal(executor.generation, 1 + call, 'exactly one attempt per call');
  }
  await delay(100);
  assert.equal(executor.generation, 4, 'no attempt happens between calls');

  // The relay comes back: the next call reaches it.
  const back = await fakeRelay(t, socketPath);
  assert.equal((await executor.execute([{ action: 'health' }]))[0].result.detail, 'health');
  assert.equal(back.connections.length, 1);
});

test('a relay that refuses while its bridge reconnects fails the call as not delivered', TEST_TIMEOUT, async t => {
  const socketPath = path.join(await directory(t), 'relay.sock');
  const relay = await fakeRelay(t, socketPath);
  const executor = new BrokerExecutor({ socketPath, target: 'desktop' });
  t.after(() => executor.close());
  await executor.opened;
  relay.connections[0].socket.destroy();
  await waitUntil(() => executor.closed, 'drop seen');
  // The relay is up but its bridge is not: it answers a new client at once.
  await relay.close();
  const connections = [];
  const server = net.createServer(socket => {
    connections.push(socket);
    readFrames(socket, () => {}, () => socket.destroy());
    writeFrame(socket, { v: 1, kind: 'error', error: { code: 'bridge_unreachable', reason: 'reconnecting',
      message: 'Fruitctl SSH bridge unreachable; the request was not delivered' } });
    socket.end();
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => { for (const socket of connections) socket.destroy(); server.close(resolve); }));
  await assert.rejects(executor.execute([{ action: 'left_click', x: 1, y: 1 }]),
    error => error.code === 'bridge_unreachable' && /not delivered/.test(error.message));
  assert.equal(connections.length, 1);
  await delay(50);
  assert.equal(connections.length, 1, 'no retry loop');
});

test('release and reconcile never reconnect after a drop', TEST_TIMEOUT, async t => {
  const socketPath = path.join(await directory(t), 'relay.sock');
  const relay = await fakeRelay(t, socketPath);
  const executor = new BrokerExecutor({ socketPath, target: 'desktop' });
  t.after(() => executor.close());
  await executor.opened;
  writeFrame(relay.connections[0].socket, { v: 1, kind: 'error', error: { code: 'bridge_lost', message: 'lost' } });
  relay.connections[0].socket.end();
  await waitUntil(() => executor.closed, 'drop seen');
  await assert.rejects(executor.release(), error => error.code === 'bridge_lost',
    'a new session cannot prove the old lease was released');
  await assert.rejects(executor.reconcile(), error => error.code === 'bridge_lost');
  assert.equal(relay.connections.length, 1);
});

for (const code of ['bridge_unconfirmed', 'release_unconfirmed']) {
  test(`${code} keeps the session failed for the operator`, TEST_TIMEOUT, async t => {
    const socketPath = path.join(await directory(t), 'relay.sock');
    const relay = await fakeRelay(t, socketPath);
    const executor = new BrokerExecutor({ socketPath, target: 'desktop' });
    t.after(() => executor.close());
    await executor.opened;
    if (code === 'bridge_unconfirmed') {
      writeFrame(relay.connections[0].socket, { v: 1, kind: 'error', error: { code, message: 'unconfirmed' } });
      relay.connections[0].socket.end();
    } else {
      relay.connections[0].hold = true;
      // A release the broker never answers latches release_unconfirmed.
      await assert.rejects(executor.release({ timeoutMs: 50 }), error => error.code === code);
    }
    await waitUntil(() => executor.closed, 'failed');
    await assert.rejects(executor.execute([{ action: 'health' }]), error => error.code === code);
    await delay(20);
    assert.equal(relay.connections.length, 1, 'no new connection');
  });
}

test('a protocol violation, an unknown profile and an explicit close never reconnect', TEST_TIMEOUT, async t => {
  const socketPath = path.join(await directory(t), 'relay.sock');
  const relay = await fakeRelay(t, socketPath);

  const violated = new BrokerExecutor({ socketPath, target: 'desktop' });
  t.after(() => violated.close());
  await violated.opened;
  writeFrame(relay.connections[0].socket, { v: 2, kind: 'opened' });
  await waitUntil(() => violated.closed, 'violation seen');
  await assert.rejects(violated.execute([{ action: 'health' }]), /closed/);

  const closed = new BrokerExecutor({ socketPath, target: 'desktop' });
  await closed.opened;
  await closed.close();
  await assert.rejects(closed.execute([{ action: 'health' }]), /closed/);
  assert.equal(relay.connections.length, 2);

  const brokerSocket = path.join(path.dirname(socketPath), 'broker.sock');
  const broker = await createBroker({ socketPath: brokerSocket, config: { targets: { desktop: {} } },
    factory: async () => assert.fail('no executor for an unknown profile') });
  t.after(() => broker.close());
  const unknown = new BrokerExecutor({ socketPath: brokerSocket, target: 'unconfigured' });
  t.after(() => unknown.close());
  await assert.rejects(unknown.opened, /Unknown/);
  await assert.rejects(unknown.execute([{ action: 'health' }]), /Unknown|closed/);
  assert.equal(unknown.generation, 1);
});

// The real broker binds a lease to one connection. A proxy stands in for the
// relay so the test can drop the client side while the broker stays up.
test('after a reconnect the broker gives a new session: no lease, input waits for a screenshot', TEST_TIMEOUT, async t => {
  const root = await directory(t);
  const brokerSocket = path.join(root, 'broker.sock');
  const relaySocket = path.join(root, 'relay.sock');
  const executors = [];
  const broker = await createBroker({ socketPath: brokerSocket, config: { targets: { desktop: {} } },
    factory: async () => {
      // As the native daemon does: a new executor has no observation, and
      // input is refused until a screenshot succeeds.
      const state = { observed: false, closed: false, input: [] };
      executors.push(state);
      return {
        async execute(actions) {
          return actions.map(action => {
            if (action.action === 'screenshot') { state.observed = true; return { result: { detail: 'screenshot' } }; }
            if (action.action === 'health') return { result: { detail: 'health' } };
            if (!state.observed) {
              return { error: { code: -32011, message: 'Input refused until a screenshot succeeds' } };
            }
            state.input.push(action.action);
            return { result: { detail: action.action } };
          });
        },
        async close() { state.closed = true; },
      };
    } });
  t.after(() => broker.close());
  const pipes = [];
  const proxy = net.createServer(client => {
    const upstream = net.connect(brokerSocket);
    pipes.push({ client, upstream });
    client.pipe(upstream).pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  await new Promise(resolve => proxy.listen(relaySocket, resolve));
  t.after(() => new Promise(resolve => {
    for (const { client, upstream } of pipes) { client.destroy(); upstream.destroy(); }
    proxy.close(resolve);
  }));

  const executor = new BrokerExecutor({ socketPath: relaySocket, target: 'desktop' });
  t.after(() => executor.close());
  await executor.opened;
  const session = new McpSession(executor);
  await executor.execute([{ action: 'screenshot' }]);
  assert.equal((await executor.execute([{ action: 'left_click', x: 5, y: 5 }]))[0].result.detail, 'left_click');
  await session.command({ action: 'health' });

  pipes[0].client.destroy();
  await waitUntil(() => executor.closed, 'drop seen');
  await waitUntil(() => executors[0].closed, 'the broker releases the dropped lease and closes its executor');

  const refused = await executor.execute([{ action: 'left_click', x: 5, y: 5 }]);
  assert.equal(refused[0].error.code, -32011, 'input after reconnect waits for a screenshot');
  assert.equal(executors.length, 2, 'the new session has a new executor');
  assert.deepEqual(executors[1].input, []);
  await executor.execute([{ action: 'screenshot' }]);
  assert.equal((await executor.execute([{ action: 'left_click', x: 6, y: 6 }]))[0].result.detail, 'left_click');
  assert.deepEqual(executors[0].input, ['left_click'], 'the first click was never replayed');
  assert.deepEqual(executors[1].input, ['left_click']);
});

test('the MCP session drops display and capability metadata from an earlier connection', TEST_TIMEOUT, async t => {
  const socketPath = path.join(await directory(t), 'relay.sock');
  const relay = await fakeRelay(t, socketPath, { answer: false });
  const executor = new BrokerExecutor({ socketPath, target: 'desktop' });
  t.after(() => executor.close());
  await waitUntil(() => relay.connections.length === 1 && relay.connections[0].frames.length === 1, 'open');
  writeFrame(relay.connections[0].socket, { v: 1, kind: 'opened', clientId: 'a' });
  await executor.opened;
  const session = new McpSession(executor);
  session.display = { width: 100, height: 50 };
  session.capabilities = { actions: ['left_click'] };
  relay.connections[0].socket.destroy();
  await waitUntil(() => executor.closed, 'drop seen');
  const call = session.command({ action: 'health' });
  await waitUntil(() => relay.connections.length === 2 && relay.connections[1].frames.length === 1, 'reopen');
  writeFrame(relay.connections[1].socket, { v: 1, kind: 'opened', clientId: 'b' });
  await waitUntil(() => relay.connections[1].frames.length === 2, 'execute');
  const { id } = relay.connections[1].frames[1];
  writeFrame(relay.connections[1].socket, { v: 1, kind: 'result', id, responses: [{ result: { detail: 'health' } }] });
  await call;
  assert.deepEqual(session.display, { width: null, height: null });
  assert.equal(session.capabilities, undefined);
  assert.equal(session.generation, 2);
});
