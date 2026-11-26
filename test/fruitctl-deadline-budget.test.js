// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker, TargetLane } from '../lib/broker/server.mjs';
import { BrokerExecutor } from '../lib/broker/client.mjs';
import { McpSession } from '../lib/mcp/server.js';

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

for (const phase of ['startup', 'operation']) {
  test(`${phase} retirement reports unconfirmed through broker and MCP before outer timeout`, { timeout: 5000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'db-'));
    await fs.chmod(directory, 0o700);
    const finishWork = deferred(), finishCleanup = deferred();
    let starts = 0, executions = 0, forcedCloses = 0, progress;
    const executor = {
      async execute(_actions, { onResponse }) {
        executions++;
        progress = onResponse;
        onResponse({ result: { detail: 'completed prefix' } });
        await finishWork.promise; // Deliberately ignores cancellation.
        return [{ result: { detail: 'late success' } }];
      },
      async release() { await finishCleanup.promise; },
      async close(options) {
        if (options?.graceful === false) forcedCloses++;
        if (phase === 'startup') await finishCleanup.promise;
      },
    };
    const broker = await createBroker({ socketPath: path.join(directory, 's'),
      config: { targets: { fixture: {} } },
      factory: async (_profile, { onExecutor }) => {
        starts++;
        onExecutor(executor);
        if (phase === 'startup') await finishWork.promise;
        return executor;
      } });
    const client = new BrokerExecutor({ socketPath: path.join(directory, 's'), target: 'fixture' });
    const lane = broker.lanes.get('fixture');
    t.after(async () => {
      finishWork.resolve(); finishCleanup.resolve();
      await client.close();
      if (lane.cleanupFailure) await assert.rejects(broker.close(), /unconfirmed/);
      else await broker.close();
      await fs.rm(directory, { recursive: true });
    });
    await client.opened;
    const session = new McpSession(client, { timeoutMs: 400 });
    const began = performance.now();
    let failure;
    await assert.rejects(session.execute([{ action: 'wait' }]), error => {
      failure = error;
      return error.code === 'release_unconfirmed' && /cleanup|release.*unconfirmed/i.test(error.message);
    });
    assert.doesNotMatch(failure.message, /Tool request timed out|Operation deadline exceeded/);
    assert.equal(starts, 1);
    assert.equal(executions, phase === 'operation' ? 1 : 0);
    assert.equal(client.pending.size, 0);
    const sticky = lane.cleanupFailure;
    assert.ok(sticky);
    assert.throws(() => lane.acquire('successor'), error => error === sticky);
    if (phase === 'operation') {
      assert.equal(forcedCloses, 1);
      assert.deepEqual(failure.responses, [{ result: { detail: 'completed prefix' } }]);
      progress({ result: { detail: 'late progress' } });
      assert.equal(failure.responses.length, 1);
    }
    finishWork.resolve(); finishCleanup.resolve();
    await delay(0);
    assert.equal(lane.cleanupFailure, sticky);
    assert.throws(() => lane.acquire('successor'), error => error === sticky);
    t.diagnostic(JSON.stringify({ phase, totalMs: 400, observedMs: performance.now() - began,
      errorCode: failure.code, executions, starts }));
  });
}

test('queued expiry returns promptly without retiring or interrupting the prior operation', { timeout: 3000 }, async t => {
  const entered = deferred(), finish = deferred();
  const dispatched = [];
  let priorSignal, closes = 0;
  const lane = new TargetLane({}, async () => ({
    async execute(actions, { signal }) {
      dispatched.push(actions[0].action);
      priorSignal = signal;
      entered.resolve();
      await finish.promise;
      return [{ result: { detail: 'confirmed prior result' } }];
    },
    async close() { closes++; },
  }));
  lane.acquire('owner');
  t.after(async () => { finish.resolve(); await lane.tail; await lane.close(); });
  const prior = lane.execute([{ action: 'prior' }], { timeoutMs: 1000 });
  await entered.promise;
  await assert.rejects(lane.execute([{ action: 'expired queued input' }], { timeoutMs: 20 }), /deadline/);
  assert.equal(priorSignal.aborted, false);
  assert.equal(closes, 0);
  assert.equal(lane.waiting, 2, 'expired queued task still occupies the serial tail and capacity');
  finish.resolve();
  assert.equal((await prior)[0].result.detail, 'confirmed prior result');
  await lane.tail;
  assert.deepEqual(dispatched, ['prior']);
  assert.equal(closes, 0, 'never-started input does not retire the prior executor');
  await lane.release('owner');
  lane.acquire('successor');
  assert.equal(closes, 1);
});

test('uncooperative execution cancellation retires once and seals late progress and success', { timeout: 3000 }, async t => {
  const entered = deferred(), finishWork = deferred(), retiring = deferred(), finishRelease = deferred();
  let progress, starts = 0, releases = 0;
  const received = [];
  const lane = new TargetLane({}, async () => {
    starts++;
    return {
      async execute(_actions, { onResponse }) {
        progress = onResponse;
        onResponse({ result: { detail: 'before cancellation' } });
        entered.resolve();
        await finishWork.promise;
        onResponse({ result: { detail: 'after retirement' } });
        return [{ result: { detail: 'late canceled success' } }];
      },
      async release() { releases++; retiring.resolve(); await finishRelease.promise; },
      async close() {},
    };
  });
  lane.acquire('owner');
  t.after(async () => { finishRelease.resolve(); finishWork.resolve(); await lane.tail; await lane.close(); });
  const controller = new AbortController();
  const reason = new Error('owned cancellation');
  const request = lane.execute([{ action: 'wait' }], { signal: controller.signal, timeoutMs: 1000,
    onResponse: response => received.push(response) });
  const rejected = assert.rejects(request, error => error === reason);
  await entered.promise;
  controller.abort(reason);
  await retiring.promise;
  assert.throws(() => lane.acquire('successor'), /releasing/);
  progress({ result: { detail: 'during retirement' } });
  finishRelease.resolve();
  await rejected;
  assert.equal(lane.executor, null);
  assert.equal(lane.cleanupFailure, undefined);
  finishWork.resolve();
  await delay(0);
  assert.deepEqual(received, [{ result: { detail: 'before cancellation' } }]);
  assert.equal(releases, 1);
  assert.equal(starts, 1);
  await lane.release('owner');
  lane.acquire('successor');
});

test('queued broker RPC expiry does not release healthy prior input before serial completion', { timeout: 3000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dq-'));
  await fs.chmod(directory, 0o700);
  const entered = deferred(), finish = deferred(), closed = deferred();
  const dispatched = [];
  let priorSignal, closes = 0;
  const broker = await createBroker({ socketPath: path.join(directory, 's'),
    config: { targets: { fixture: {} } }, factory: async () => ({
      async execute(actions, { signal }) {
        priorSignal = signal;
        dispatched.push(actions[0].action);
        entered.resolve();
        await finish.promise;
        return [{ result: { detail: 'prior completed' } }];
      },
      async close() { closes++; closed.resolve(); },
    }) });
  const client = new BrokerExecutor({ socketPath: path.join(directory, 's'), target: 'fixture' });
  t.after(async () => { finish.resolve(); await client.close(); await broker.close(); await fs.rm(directory, { recursive: true }); });
  await client.opened;
  const prior = client.execute([{ action: 'prior' }], { timeoutMs: 1000 });
  await entered.promise;
  await assert.rejects(client.execute([{ action: 'expired' }], { timeoutMs: 20 }), /deadline/);
  assert.equal(priorSignal.aborted, false);
  assert.equal(closes, 0);
  assert.equal(broker.lanes.get('fixture').waiting, 2);
  finish.resolve();
  assert.equal((await prior)[0].result.detail, 'prior completed');
  await closed.promise;
  assert.deepEqual(dispatched, ['prior']);
  assert.equal(closes, 1);
});

test('very short lane budgets retain positive work and finite retirement without a new deadline', async t => {
  t.mock.method(performance, 'now', () => 1000);
  for (const timeoutMs of [0.25, 1, 10, 40]) {
    let startupDeadline, workBudget, releaseBudget;
    const lane = new TargetLane({}, async (_profile, { deadline }) => {
      startupDeadline = deadline;
      return {
        async execute(_actions, { timeoutMs: remaining }) { workBudget = remaining; throw new Error('owned short-budget failure'); },
        async release({ timeoutMs: remaining }) { releaseBudget = remaining; },
        async close() {},
      };
    });
    await assert.rejects(lane.execute([{ action: 'wait' }], { timeoutMs }), /owned short-budget failure/);
    assert.ok(workBudget > 0 && workBudget < timeoutMs);
    assert.equal(startupDeadline, 1000 + workBudget);
    assert.ok(releaseBudget > 0 && releaseBudget <= timeoutMs - workBudget);
    assert.equal(lane.cleanupFailure, undefined);
    assert.equal(lane.executor, null);
    await lane.close();
  }
});

test('MCP deducts elapsed dispatch time and refuses a release that resolves after its original deadline', async t => {
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  let workBudget, releaseBudget, releaseSignal, lateProgress = false;
  const session = new McpSession({
    async execute(_actions, { timeoutMs, onResponse }) {
      workBudget = timeoutMs;
      if (lateProgress) {
        now += 21;
        onResponse({ result: { detail: 'after the original MCP deadline' } });
      }
      return [{ result: {} }];
    },
    async release({ timeoutMs, signal }) { releaseBudget = timeoutMs; releaseSignal = signal; now += 21; },
  }, { timeoutMs: 20 });
  const work = session.execute([{ action: 'wait' }]);
  now += 5; // Before MCP's deferred executor invocation.
  await work;
  assert.ok(workBudget > 0 && workBudget < 15, 'dispatch time and return reserve both consume the same original deadline');
  lateProgress = true;
  await assert.rejects(session.execute([{ action: 'wait' }]), error => {
    assert.deepEqual(error.responses, [], 'a delayed timer cannot admit late progress as completed input');
    return /Tool request timed out after 20ms/.test(error.message);
  });
  await assert.rejects(session.release(), /Ownership release timed out after 20ms/);
  assert.ok(releaseBudget > 0 && releaseBudget < 20);
  assert.equal(releaseSignal.aborted, true);
});

test('startup cleanup that resolves beyond its reserved cutoff remains unconfirmed', async t => {
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  let closes = 0;
  const lane = new TargetLane({}, async (_profile, { onExecutor }) => {
    onExecutor({ async close() { closes++; now += 25; } });
    throw new Error('owned startup failure');
  });
  await assert.rejects(lane.execute([{ action: 'wait' }], { timeoutMs: 20 }),
    error => error.code === 'release_unconfirmed' && /startup cleanup is unconfirmed/.test(error.message));
  assert.equal(closes, 1);
  assert.ok(lane.startup, 'late confirmation does not erase recorded startup ownership');
  assert.throws(() => lane.acquire('successor'), /unconfirmed/);
  await assert.rejects(lane.close(), /unconfirmed/);
});

test('a shorter concurrent release refuses late confirmation before its timer callback', async t => {
  let now = 1000, releases = 0;
  t.mock.method(performance, 'now', () => now);
  const releasing = deferred(), finish = deferred();
  const lane = new TargetLane({});
  lane.executor = {
    async release() { releases++; releasing.resolve(); await finish.promise; },
    async close() {},
  };
  lane.acquire('owner');
  const first = lane.release('owner', { timeoutMs: 100 });
  const firstRejected = assert.rejects(first, error => error.code === 'release_unconfirmed');
  await releasing.promise;
  const second = lane.release('owner', { timeoutMs: 20 });
  const secondRejected = assert.rejects(second, error => error.code === 'release_unconfirmed');
  now += 25;
  finish.resolve();
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(releases, 1, 'a second caller shortens retirement without replaying it');
  assert.equal(lane.owner, 'owner');
  assert.notEqual(lane.executor, null);
  assert.throws(() => lane.acquire('successor'), /unconfirmed/);
  await assert.rejects(lane.close(), /unconfirmed/);
});

for (const kind of ['execute', 'release']) {
  test(`broker ${kind} refuses a late result before a delayed timer callback`, async t => {
    let now = 1000;
    t.mock.method(performance, 'now', () => now);
    const emitted = deferred();
    const frames = [];
    const client = Object.create(BrokerExecutor.prototype);
    // TIN-8604: one broker connection is one channel; nothing reconnects here.
    Object.assign(client, { reconnect: false, channel: { pending: new Map(), opened: Promise.resolve(), closed: false,
      rejectOpen() {}, socket: { writableLength: 0, write(line) { frames.push(JSON.parse(line)); emitted.resolve(); }, destroy() {} } } });
    const request = kind === 'execute' ? client.execute([{ action: 'wait' }], { timeoutMs: 20 }) : client.release({ timeoutMs: 20 });
    const rejected = assert.rejects(request, kind === 'release' ? /release unconfirmed.*deadline/i : /deadline/);
    now += 5; // Opening consumed five milliseconds, not a new request budget.
    await emitted.promise;
    assert.ok(frames[0].timeoutMs > 0 && frames[0].timeoutMs < 15);
    now = 1021;
    client.receive({ v: 1, kind: 'result', id: frames[0].id, responses: [] });
    await rejected;
    assert.equal(client.pending.size, 0);
    assert.equal(frames.filter(frame => frame.kind === 'cancel').length, 1);
    if (kind === 'release') assert.equal(client.closed, true);
    else await client.close();
  });
}
