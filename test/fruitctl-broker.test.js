// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker, TargetLane } from '../lib/broker/server.mjs';
import { BrokerExecutor } from '../lib/broker/client.mjs';
import { attachMux, createRelay, sshArguments } from '../lib/broker/relay.mjs';
import { readFrames } from '../lib/broker/protocol.mjs';
import { prepareSocket, loadConfig } from '../lib/broker/paths.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-test-'));
  await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, socketPath: path.join(directory, 'broker.sock') };
}

test('broker retains one control owner across atomic batches and releases before handoff', async t => {
  const { socketPath } = await fixture(t);
  const order = [];
  let spawns = 0;
  const broker = await createBroker({ socketPath, config: { targets: { desktop: {} } }, factory: async () => {
    spawns++;
    return { async execute(actions, { onResponse }) {
      const responses = [];
      for (const action of actions) {
        order.push(action.value);
        await delay(3);
        const response = { id: action.value, result: { detail: action.value } };
        responses.push(response); onResponse?.(response);
      }
      return responses;
    }, async close() {} };
  } });
  t.after(() => broker.close());
  const a = new BrokerExecutor({ socketPath, target: 'desktop' });
  const b = new BrokerExecutor({ socketPath, target: 'desktop' });
  t.after(async () => { await a.close(); await b.close(); });
  await Promise.all([a.opened, b.opened]);
  const progress = [];
  const first = a.execute([{ action: 'wait', value: 'a1' }, { action: 'wait', value: 'a2' }],
    { onResponse: response => progress.push(response.result.detail) });
  await assert.rejects(b.execute([{ action: 'wait', value: 'b1' }]), /another session/);
  await first;
  await a.execute([{ action: 'wait', value: 'a3' }]);
  await a.release();
  await b.execute([{ action: 'wait', value: 'b1' }]);
  assert.equal(spawns, 2);
  assert.deepEqual(order, ['a1', 'a2', 'a3', 'b1']);
  assert.deepEqual(progress, ['a1', 'a2']);
});

test('cancellation retains acknowledged progress and never replays uncertain input', async t => {
  const { socketPath } = await fixture(t);
  let calls = 0;
  let closes = 0;
  const broker = await createBroker({ socketPath, config: { targets: { desktop: {} } }, factory: async () => ({
    async execute(actions, { signal, onResponse }) {
      calls++;
      onResponse?.({ id: 'first', result: { detail: 'acknowledged' } });
      await delay(1000, undefined, { signal });
      return [];
    }, async close() { closes++; }
  }) });
  t.after(() => broker.close());
  const client = new BrokerExecutor({ socketPath, target: 'desktop' });
  t.after(() => client.close());
  await client.opened;
  const controller = new AbortController();
  const request = client.execute([{ action: 'click' }], { signal: controller.signal,
    onResponse: () => controller.abort(new Error('operator cancellation')) });
  await assert.rejects(request, error => error.responses.length === 1 && /operator/.test(error.message));
  await delay(30);
  assert.equal(calls, 1);
  assert.equal(closes, 1);
});

test('unknown target profiles cannot create native children', async t => {
  const { socketPath } = await fixture(t);
  let spawns = 0;
  const broker = await createBroker({ socketPath, config: { targets: { desktop: {} } }, factory: () => { spawns++; } });
  t.after(() => broker.close());
  const client = new BrokerExecutor({ socketPath, target: 'unconfigured' });
  t.after(() => client.close());
  await assert.rejects(client.opened, /Unknown/);
  assert.equal(spawns, 0);
});

test('relay multiplexes logical clients through one SSH child', async t => {
  const { socketPath, directory } = await fixture(t);
  const broker = await createBroker({ socketPath, config: { targets: { desktop: {} } }, factory: async () => ({
    async execute(actions) { return actions.map(action => ({ result: { detail: action.action } })); },
    async close() {}
  }) });
  t.after(() => broker.close());
  let sshSpawns = 0;
  let attachment;
  const relay = await createRelay({ socketPath: path.join(directory, 'relay.sock'), bridge: 'test@darwin',
    spawnSSH: () => {
      sshSpawns++;
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { attachment?.close(); child.stdout.end(); queueMicrotask(() => child.emit('close', 0, null)); };
      attachMux({ input: child.stdin, output: child.stdout, socketPath }).then(value => { attachment = value; });
      return child;
    } });
  t.after(() => relay.close());
  for (let i = 0; i < 10; i++) {
    const client = new BrokerExecutor({ socketPath: path.join(directory, 'relay.sock'), target: 'desktop' });
    await client.opened;
    const response = await client.execute([{ action: 'health' }]);
    assert.equal(response[0].result.detail, 'health');
    await client.release();
    await client.close();
  }
  assert.equal(sshSpawns, 1);
});

test('protocol preserves split Unicode and rejects oversized frames', () => {
  const stream = new PassThrough();
  const values = [];
  let failure;
  readFrames(stream, value => values.push(value), error => { failure = error; }, 100);
  const value = Buffer.from(JSON.stringify({ text: 'purple 🟣' }) + '\n');
  stream.write(value.subarray(0, value.length - 4));
  stream.write(value.subarray(value.length - 4));
  assert.equal(values[0].text, 'purple 🟣');
  stream.write(Buffer.alloc(101, 120));
  assert.match(failure.message, /oversized/);
});

test('queue expiry cannot dispatch timed-out actions', async () => {
  const inputs = [];
  const lane = new TargetLane({}, async () => ({
    async execute(actions) { inputs.push(actions[0].action); await delay(30); return []; }, async close() {}
  }));
  const first = lane.execute([{ action: 'first' }]);
  const expired = lane.execute([{ action: 'expired' }], { timeoutMs: 5 });
  const rejected = assert.rejects(expired, /deadline/);
  await first;
  await rejected;
  assert.deepEqual(inputs, ['first']);
  await lane.close();
});

test('socket preparation refuses a live service and arbitrary files', async t => {
  const { socketPath, directory } = await fixture(t);
  const broker = await createBroker({ socketPath, config: { targets: {} } });
  t.after(() => broker.close());
  await assert.rejects(prepareSocket(socketPath), /already owns/);
  const file = path.join(directory, 'regular-file');
  await fs.writeFile(file, 'keep');
  await assert.rejects(prepareSocket(file), /Refusing/);
  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
});

test('SSH command quotes configured paths and rejects option-like hosts', () => {
  assert.throws(() => sshArguments({ bridge: '-oProxyCommand=unsafe' }), /explicit/);
  const args = sshArguments({ bridge: 'operator@darwin', remoteCommand: '/Users/operator/My Apps/fruitctl',
    remoteSocket: "/Users/operator/run/it's.sock" });
  assert.match(args.at(-1), /'\/Users\/operator\/My Apps\/fruitctl'/);
  assert.match(args.at(-1), /'\\''/);
});

test('config rejects malformed target inventory', async t => {
  const { directory } = await fixture(t);
  const config = path.join(directory, 'config.json');
  await fs.writeFile(config, JSON.stringify({ schema: 'fruitctl.config.v1', targets: [] }));
  await assert.rejects(loadConfig(config), /target profiles/);
});

test('private Host binding resolves before lane creation and refuses identity or custody drift', async t => {
  const { directory } = await fixture(t);
  const configPath = path.join(directory, 'config.json');
  const bindingPath = path.join(directory, 'host-binding.json');
  const helper = { sshHost: 'fixture-target', command: ['/Applications/FruitctlHost.app/Contents/MacOS/FruitctlHost', '--stdio'],
    displayId: 1 };
  const document = { schema: 'fruitctl.config.v1', targets: {
    desktop: { targetId: 'fixture-desktop', hostHelperFile: bindingPath }
  } };
  const binding = { schema: 'fruitctl.host-binding.v1', targetId: 'fixture-desktop', hostHelper: helper };
  const write = async value => fs.writeFile(bindingPath, JSON.stringify(value), { mode: 0o600 });
  await fs.writeFile(configPath, JSON.stringify(document));
  await write(binding);
  assert.deepEqual((await loadConfig(configPath)).targets.desktop.hostHelper, helper);
  await write({ ...binding, targetId: 'another-desktop' });
  await assert.rejects(loadConfig(configPath), /identity or schema/);
  await write({ ...binding, targets: { injected: {} } });
  await assert.rejects(loadConfig(configPath), /identity or schema/);
  await write({ ...binding, hostHelper: { ...helper, command: ['/usr/bin/open', '--stdio'] } });
  await assert.rejects(loadConfig(configPath), /Invalid host-helper/);
  await write(binding);
  await fs.chmod(bindingPath, 0o644);
  await assert.rejects(loadConfig(configPath), /private user-owned regular file/);
  await fs.chmod(bindingPath, 0o600);
  await fs.chmod(directory, 0o755);
  await assert.rejects(loadConfig(configPath), /directory must be private/);
  await fs.chmod(directory, 0o700);
  const original = path.join(directory, 'original.json');
  await fs.rename(bindingPath, original);
  await fs.symlink(original, bindingPath);
  await assert.rejects(loadConfig(configPath));
  await fs.unlink(bindingPath);
  await assert.rejects(loadConfig(configPath), { code: 'ENOENT' });
  await write(binding);
  document.targets.desktop.hostHelper = helper;
  await fs.writeFile(configPath, JSON.stringify(document));
  await assert.rejects(loadConfig(configPath), /one absolute file/);
});
