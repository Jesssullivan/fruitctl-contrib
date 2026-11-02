// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32, deflateSync } from 'node:zlib';
import { createHostHelperExecutor, hostHelperFailureCause } from '../lib/broker/host-helper.mjs';
import { createNativeExecutor } from '../lib/mcp/native.js';
import { vncCommandTool, actionQueueTool } from '../tools/index.js';

const protocol = 'fruitctl.native-input-permit.v1';
const geometry = { nativeWidth: 16, nativeHeight: 8, scaledWidth: 8, scaledHeight: 4,
  connectionGeneration: 3, allocation: 9 };
const bounds = { x: 0, y: 0, width: 8, height: 4 };
const binding = { instance_id: 'owned-resident-fixture', session_id: 'owned-session-fixture',
  display_id: 42, displayGeneration: 7, ...geometry, sequence: 1 };

function png() {
  const chunk = (type, content) => {
    const bytes = Buffer.alloc(content.length + 12);
    bytes.writeUInt32BE(content.length); bytes.write(type, 4); content.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8); header.writeUInt32BE(4, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(33 * 4))),
    chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

// Owned protocol simulators only: no VNC socket, display, GUI, provider or real
// credential. The native fixture's action and permit timers are independent.
const nativeSource = `
const fs = require('node:fs');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const now = () => performance.now();
const record = (event, extra = {}) => fs.appendFileSync(process.env.FRUITCTL_PERMIT_EVENTS,
  JSON.stringify({ event, pid: process.pid, ppid: process.ppid, ...extra }) + '\\n');
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const geometry = ${JSON.stringify(geometry)};
const protocol = ${JSON.stringify(protocol)};
const mode = process.env.FRUITCTL_PERMIT_MODE;
let pending, current, terminal = false, timer, healthCount = 0, active;
const fail = (request, message) => {
  terminal = true; clearTimeout(timer);
  record('native-permit-terminal', { message });
  emit({ id: request.id, error: { code: -32000, message } });
};
const expire = () => {
  // Node truncates fractional timer delays; admission still uses the actual
  // monotonic deadline, as the native watchdog does.
  const remaining = current.until - now();
  if (remaining > 0) { timer = setTimeout(expire, Math.max(1, remaining)); return; }
  terminal = true; record('native-expired');
  if (active) { clearInterval(active.tick); emit({ id: active.id, error: { code: -32000, message: 'Native input permit expired' } }); active = undefined; }
};
const receipt = item => ({ ...item.binding, challenge: item.challenge,
  native_permit_protocol: protocol, input_permit_ms: 1000, maximum_round_trip_ms: 500,
  native_permit_remaining_ms: Math.max(1, Math.ceil((current?.until || item.start + 1000) - now())) });
async function handle(request) {
  record('native-request', { method: request.method, params: request.params });
  const params = request.params || {};
  if (request.method === 'shutdown') { emit({ id: request.id, result: { detail: 'OK' } }); process.exit(0); }
  if (request.method === 'health') {
    healthCount++;
    emit({ id: request.id, result: { ...geometry, ...(mode === 'changed-allocation' && healthCount > 1 ? { allocation: 10 } : {}) } }); return;
  }
  if (request.method === 'adopt_observation') { emit({ id: request.id, result: params }); return; }
  if (request.method === 'begin_input_permit') {
    if (mode === 'old-native') { emit({ id: request.id, error: { code: -32601, message: 'Unknown method' } }); return; }
    if (terminal || (current && now() >= current.until)) { fail(request, 'Native input permit expired'); return; }
    if (current && (params.sequence <= current.binding.sequence ||
        Object.keys(current.binding).some(key => key !== 'sequence' && params[key] !== current.binding[key]))) {
      fail(request, 'Native permit binding or sequence changed'); return;
    }
    pending = { binding: params, start: now(), challenge: randomUUID() };
    if (mode === 'late-begin' || mode === 'too-late-begin') {
      setTimeout(() => { emit({ id: request.id, result: receipt(pending) });
        emit({ method: 'ready', params: { scaledWidth: 8, scaledHeight: 4 } }); record('native-late-ack'); }, mode === 'too-late-begin' ? 550 : 120);
      return;
    }
    emit({ id: request.id, result: receipt(pending) }); return;
  }
  if (request.method === 'grant_input_permit') {
    if (terminal || !pending || params.challenge !== pending.challenge || now() - pending.start > 500 ||
        Object.keys(pending.binding).some(key => params[key] !== pending.binding[key]) ||
        (current && now() >= current.until)) { fail(request, 'Native permit expired or replayed'); return; }
    current = { ...pending, until: Math.min(pending.start + 1000, pending.start + params.lease_remaining_ms) };
    const issued = pending; pending = undefined;
    clearTimeout(timer); timer = setTimeout(expire, Math.max(1, current.until - now()));
    let result = receipt(issued);
    if (mode.startsWith('bad-grant:')) {
      const key = mode.slice('bad-grant:'.length);
      result[key] = key === 'native_permit_remaining_ms' ? 0 :
        typeof result[key] === 'number' ? result[key] + 1 : 'wrong-binding';
    }
    if (mode === 'late-grant') { setTimeout(() => emit({ id: request.id, result }), 550); return; }
    emit({ id: request.id, result }); return;
  }
  if (request.method === 'wait') { setTimeout(() => emit({ id: request.id, result: { detail: 'OK' } }), 180); return; }
  if (request.method === 'screenshot') { record('forbidden-raw-capture'); process.exit(71); }
  if (request.method === 'key_type') {
    if (terminal || !current || now() >= current.until) { fail(request, 'Native input permit expired'); return; }
    record('native-input-start');
    active = { id: request.id, tick: setInterval(() => {
      if (terminal || now() >= current.until) { expire(); return; }
      record('native-input-event');
    }, 40) };
    setTimeout(() => { if (!active) return; clearInterval(active.tick); active = undefined;
      record('native-input-end'); emit({ id: request.id, result: { detail: 'OK' } }); }, 1250); return;
  }
  if (terminal || !current || now() >= current.until) { fail(request, 'Native input permit expired'); return; }
  record('native-input-event'); emit({ id: request.id, result: { detail: 'OK' } });
}
async function main() {
  let credential = Buffer.alloc(0);
  for await (const bytes of fs.createReadStream(null, { fd: 3 })) credential = Buffer.concat([credential, bytes]);
  if (credential.readUInt32BE(0) !== credential.length - 4 || Object.hasOwn(process.env, 'VNC_PASSWORD')) process.exit(70);
  credential.fill(0); record('native-started');
  if (mode === 'late-begin' || mode === 'too-late-begin') process.on('SIGTERM', () => { record('native-owned-term'); setTimeout(() => process.exit(0), 200); });
  emit({ method: 'ready', params: { scaledWidth: 8, scaledHeight: 4 } });
  for await (const line of readline.createInterface({ input: process.stdin })) handle(JSON.parse(line)).catch(() => process.exit(70));
}
main().catch(() => process.exit(70));
`;

const helperSource = `
const fs = require('node:fs');
const readline = require('node:readline');
const record = request => fs.appendFileSync(process.env.FRUITCTL_PERMIT_EVENTS,
  JSON.stringify({ event: 'helper-request', pid: process.pid, ppid: process.ppid, ...request }) + '\\n');
let owner;
for (const key of ['VNC_PASSWORD', 'GH_TOKEN', 'GITHUB_TOKEN']) if (Object.hasOwn(process.env, key)) process.exit(70);
record({ action: 'fixture-started' });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); record(request);
  if (['begin_activity', 'renew_activity'].includes(request.action)) owner = {
    session_id: request.params.session_id, sequence: request.params.sequence, challenge: request.params.challenge };
  if (request.action === 'release_activity') owner = undefined;
  let result = { instance_id: 'owned-resident-fixture', display_id: 42, displayGeneration: 7,
    capture_backend: 'owned_sck', raw_vnc_exclusion: false, capture_enabled: true, screen_capture_permission: true,
    capture_ready: Boolean(owner), overlay_ready: Boolean(owner), ready: Boolean(owner),
    ui_heartbeat_age_ms: owner ? 0 : null, lease_remaining_ms: owner ? 3000 : 0,
    input_permit_ms: 1000, maximum_round_trip_ms: 500, renewal_interval_ms: 500, ...(owner || {}) };
  if (request.action === 'capture') result = { ...result, ...${JSON.stringify(geometry)},
    display_bounds: ${JSON.stringify(bounds)}, pixels_per_point_x: 2, pixels_per_point_y: 2,
    cursor_included: true, image: process.env.FRUITCTL_PERMIT_PNG, mimeType: 'image/png' };
  if (process.env.FRUITCTL_HELPER_MODE === 'wrong-echo' && request.action === 'renew_activity') result.challenge = 'wrong-echo';
  if (process.env.FRUITCTL_HELPER_MODE === 'short-lease' && request.action === 'renew_activity') result.lease_remaining_ms = 100;
  const wait = process.env.FRUITCTL_HELPER_MODE === 'slow-renew' && request.action === 'renew_activity' ? 550 : 0;
  setTimeout(() => process.stdout.write(JSON.stringify({ id: request.id, success: true, result }) + '\\n'), wait);
});
`;

async function waitUntil(predicate, message, timeoutMs = 2000) {
  const deadline = performance.now() + timeoutMs;
  while (!await predicate()) {
    if (performance.now() >= deadline) assert.fail(message);
    await delay(5);
  }
}

async function fixture(t, mode = 'normal', helperMode = 'normal') {
  const scratch = process.env.TMPDIR;
  assert.ok(scratch && path.isAbsolute(scratch), 'owned TMPDIR is required');
  const parent = await fs.lstat(scratch);
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid());
  const directory = await fs.mkdtemp(path.join(scratch, 'p-'));
  await fs.chmod(directory, 0o700);
  const daemonPath = path.join(directory, 'native.cjs');
  const helperPath = path.join(directory, 'helper.cjs');
  const eventsPath = path.join(directory, 'events.jsonl');
  await fs.writeFile(daemonPath, `#!${process.execPath}\n${nativeSource}`, { mode: 0o700, flag: 'wx' });
  await fs.writeFile(helperPath, helperSource, { mode: 0o600, flag: 'wx' });
  await fs.writeFile(eventsPath, '', { mode: 0o600, flag: 'wx' });
  const native = await createNativeExecutor({ daemonPath, emitDiagnostics: false, env: {
    VNC_PASSWORD: 'owned-synthetic-permit-fixture', FRUITCTL_PERMIT_EVENTS: eventsPath, FRUITCTL_PERMIT_MODE: mode,
  } });
  let helper, executor;
  const events = async () => (await fs.readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const host = async () => {
    // Process launch is fixture setup, outside the resident helper's strict
    // receipt budget. The channel still exercises real Node pipes and timers.
    const helperEnv = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    helper = spawn(process.execPath, [helperPath], { stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...helperEnv, FRUITCTL_PERMIT_EVENTS: eventsPath,
        FRUITCTL_PERMIT_PNG: png(), FRUITCTL_HELPER_MODE: helperMode } });
    await waitUntil(async () => (await events()).some(event => event.action === 'fixture-started'),
      'owned helper fixture did not start');
    executor = await createHostHelperExecutor({ nativeExecutor: native,
      hostHelper: { sshHost: 'owned-synthetic-target',
        command: ['/owned/FruitctlHost', '--stdio'], displayId: 42,
        mapping: { qualificationReceipt: 'owned-synthetic-geometry', displayId: 42, ...geometry, displayBounds: bounds } },
      spawnImpl(command, args, options) {
        assert.equal(command, 'ssh'); assert.equal(args.at(-2), 'owned-synthetic-target');
        assert.deepEqual(options.env, helperEnv);
        return helper;
      } });
    return executor;
  };
  t.after(async () => {
    if (executor) await executor.close();
    else await native.close({ graceful: false });
    if (helper && helper.exitCode === null && helper.signalCode === null) {
      const closed = new Promise(resolve => helper.once('close', resolve));
      helper.kill('SIGTERM'); await closed;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  await waitUntil(async () => (await events()).some(event => event.event === 'native-started'), 'owned native fixture did not start');
  if (process.platform === 'linux') {
    const pid = native.child.pid;
    const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
    assert.match(status, new RegExp(`^PPid:\\s+${process.pid}$`, 'm'));
    assert.match(status, new RegExp(`^Uid:\\s+${process.getuid()}\\s`, 'm'));
    assert.equal(await fs.readlink(`/proc/${pid}/exe`), await fs.realpath(process.execPath));
    assert.ok((await fs.readFile(`/proc/${pid}/cmdline`)).toString().split('\0').includes(daemonPath));
    t.diagnostic(JSON.stringify({ event: 'owned-native-proof', pid, ppid: process.pid,
      uid: process.getuid(), executable: await fs.realpath(process.execPath), fixture: daemonPath }));
  }
  return { native, host, events, helper: () => helper };
}

test('private native permit controls bypass an active execute tail and bound allowed methods', async t => {
  const { native, events } = await fixture(t);
  const active = native.execute([{ action: 'wait' }]);
  await waitUntil(async () => (await events()).some(event => event.method === 'wait'), 'wait did not start');
  const begun = await native.inputPermitControl('begin_input_permit', binding);
  const granted = await native.inputPermitControl('grant_input_permit', { ...binding,
    challenge: begun.result.challenge, lease_remaining_ms: 3000 });
  assert.equal(granted.result.native_permit_protocol, protocol);
  assert.deepEqual((await events()).filter(event => event.event === 'native-request').map(event => event.method),
    ['wait', 'begin_input_permit', 'grant_input_permit']);
  await assert.rejects(native.inputPermitControl('key_tap', binding), /Invalid.*control/);
  await assert.rejects(native.inputPermitControl('begin_input_permit', binding, { timeoutMs: 501 }), /deadline/);
  await active;
});

test('private native permit methods remain unavailable through public MCP action validation', () => {
  for (const action of ['begin_input_permit', 'grant_input_permit']) {
    assert.equal(vncCommandTool().inputSchema.action.safeParse(action).success, false);
    assert.equal(actionQueueTool().inputSchema.actions.safeParse([{ action, ...binding }]).success, false);
  }
});

test('helper native challenges renew during a long input, bind the full allocation and never use raw capture', async t => {
  const owned = await fixture(t);
  const executor = await owned.host();
  await executor.execute([{ action: 'key_type', text: 'synthetic-only' }], { timeoutMs: 2500 });
  const events = await owned.events();
  const start = events.findIndex(event => event.event === 'native-input-start');
  const end = events.findIndex(event => event.event === 'native-input-end');
  const renewals = events.slice(start + 1, end).filter(event => event.method === 'grant_input_permit');
  assert.ok(renewals.length >= 2, 'renewals must not wait for the active input response');
  const begins = events.filter(event => event.method === 'begin_input_permit');
  const grants = events.filter(event => event.method === 'grant_input_permit');
  assert.equal(begins.length, grants.length);
  const challenges = new Set();
  for (let index = 0; index < begins.length; index++) {
    const begin = begins[index].params;
    const grant = grants[index].params;
    for (const key of Object.keys(geometry)) assert.equal(begin[key], geometry[key]);
    assert.equal(begin.instance_id, 'owned-resident-fixture');
    assert.equal(begin.display_id, 42); assert.equal(begin.displayGeneration, 7);
    assert.equal(grant.sequence, begin.sequence); assert.equal(grant.lease_remaining_ms, 3000);
    const echoed = events.find(event => event.event === 'helper-request' &&
      event.action === 'renew_activity' && event.params.sequence === begin.sequence);
    assert.equal(echoed.params.challenge, grant.challenge);
    assert.equal(echoed.params.session_id, begin.session_id);
    assert.ok(!challenges.has(grant.challenge)); challenges.add(grant.challenge);
    if (index) assert.ok(begin.sequence > begins[index - 1].params.sequence);
  }
  assert.ok(!events.some(event => event.event === 'native-expired' || event.event === 'forbidden-raw-capture'));
  await executor.release({ timeoutMs: 1000 });
  assert.equal(executor.released, true);
  assert.equal(owned.native.shutdownAcknowledged, true);
  assert.equal(owned.native.child.exitCode, 0);
});

for (const mode of ['old-native', 'late-grant']) {
  test(`${mode} refuses helper input terminally without raw fallback or replay`, async t => {
    const owned = await fixture(t, mode);
    const executor = await owned.host();
    await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }]), /permit.*unavailable|permit.*deadline/i);
    const before = (await owned.events()).filter(event => event.event === 'native-request').length;
    await assert.rejects(executor.execute([{ action: 'key_tap', key: 'tab' }]), /permit.*unavailable|permit.*deadline/i);
    assert.equal((await owned.events()).filter(event => event.event === 'native-request').length, before);
    assert.ok(!(await owned.events()).some(event => event.event === 'native-input-event' || event.event === 'forbidden-raw-capture'));
    assert.ok(executor.failed);
  });
}

for (const field of [...Object.keys(binding), 'challenge', 'native_permit_protocol', 'input_permit_ms',
  'maximum_round_trip_ms', 'native_permit_remaining_ms']) {
  test(`a mismatched native grant ${field} closes the owned executor before input`, async t => {
    const owned = await fixture(t, `bad-grant:${field}`);
    const executor = await owned.host();
    await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }]), /grant.*unconfirmed/);
    assert.ok(!(await owned.events()).some(event => event.event === 'native-input-event'));
    assert.equal(executor.failed.message, 'Native independent input-permit grant unavailable or unconfirmed');
  });
}

for (const helperMode of ['wrong-echo', 'slow-renew']) {
  test(`helper ${helperMode} cannot grant native input or revive a failed caller`, async t => {
    const owned = await fixture(t, 'normal', helperMode);
    const executor = await owned.host();
    await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }]), /receipt.*mismatch|receipt.*deadline/);
    assert.ok(!(await owned.events()).some(event => event.method === 'grant_input_permit' || event.event === 'native-input-event'));
    await assert.rejects(executor.execute([{ action: 'key_tap', key: 'tab' }]), /receipt.*mismatch|receipt.*deadline/);
  });
}

test('changed adopted native allocation refuses successor input and never replays the first action', async t => {
  const owned = await fixture(t, 'changed-allocation');
  const executor = await owned.host();
  await executor.execute([{ action: 'key_tap', key: 'enter' }]);
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'tab' }]), /allocation binding changed/);
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'tab' }]), /allocation binding changed/);
  assert.equal((await owned.events()).filter(event => event.event === 'native-input-event').length, 1);
});

test('timed-out private control ignores its late acknowledgement and ready frame', async t => {
  const owned = await fixture(t, 'late-begin');
  await assert.rejects(owned.native.inputPermitControl('begin_input_permit', binding, { timeoutMs: 40 }), /deadline/);
  await waitUntil(async () => (await owned.events()).some(event => event.event === 'native-late-ack'), 'owned fixture did not emit its late acknowledgement');
  assert.equal(owned.native.isReady, false); assert.equal(owned.native.terminal, true);
  await assert.rejects(owned.native.execute([{ action: 'key_tap', key: 'enter' }]), /Daemon not ready/);
  await owned.native.closed;
  assert.equal(owned.native.pending.size, 0);
});

test('an aborted private control stays terminal after its late native acknowledgement', async t => {
  const owned = await fixture(t, 'late-begin');
  const controller = new AbortController();
  const pending = owned.native.inputPermitControl('begin_input_permit', binding, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled/);
  await waitUntil(async () => (await owned.events()).some(event => event.method === 'begin_input_permit'), 'private control did not start');
  controller.abort();
  await rejected;
  await waitUntil(async () => (await owned.events()).some(event => event.event === 'native-late-ack'), 'owned fixture did not emit its late acknowledgement');
  assert.equal(owned.native.isReady, false); assert.equal(owned.native.terminal, true);
  await assert.rejects(owned.native.execute([{ action: 'key_tap', key: 'enter' }]), /Daemon not ready/);
});

test('a native grant acknowledgement cannot revive an expired local helper owner', async t => {
  const owned = await fixture(t);
  const executor = await owned.host();
  const control = owned.native.inputPermitControl.bind(owned.native);
  const now = executor.now;
  let suspendedMs = 0;
  executor.now = () => now() + suspendedMs;
  owned.native.inputPermitControl = async (...args) => {
    const response = await control(...args);
    if (args[0] === 'grant_input_permit') suspendedMs += 1001;
    return response;
  };
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }]), /permit expired/);
  assert.ok((await owned.events()).some(event => event.method === 'grant_input_permit'));
  assert.ok(!(await owned.events()).some(event => event.event === 'native-input-event'));
  const requests = (await owned.events()).filter(event => event.event === 'native-request').length;
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'tab' }]), /permit expired/);
  assert.equal((await owned.events()).filter(event => event.event === 'native-request').length, requests);
});

test('a shorter helper lease bounds native authorization and cancels active input', async t => {
  const owned = await fixture(t, 'normal', 'short-lease');
  const executor = await owned.host();
  const permitExpired = error => {
    // Either independent expiry guard can finish first. A native refusal is
    // wrapped by the helper; require its structured permit error, not merely
    // the generic wrapper message.
    if (error.message === 'Native operation failed') {
      assert.equal(error.responses?.length, 1);
      assert.deepEqual(error.responses[0].error, {
        code: -32000, message: 'Native input permit expired',
      });
    } else assert.match(error.message, /permit expired|Daemon not ready/);
    return true;
  };
  await assert.rejects(executor.execute([{ action: 'key_type', text: 'synthetic-only' }]), permitExpired);
  await executor.close();
  await owned.native.closed;
  assert.ok(executor.failed);
  assert.equal(owned.native.terminal, true);
  assert.equal(owned.native.pending.size, 0);
  assert.ok(owned.native.child.exitCode !== null || owned.native.child.signalCode !== null);
  assert.ok(owned.helper().exitCode !== null || owned.helper().signalCode !== null);
  const events = await owned.events();
  const grant = events.find(event => event.method === 'grant_input_permit');
  assert.equal(grant.params.lease_remaining_ms, 100);
  assert.ok(events.some(event => event.event === 'native-input-start'));
  assert.ok(!events.some(event => event.event === 'native-input-end' || event.event === 'forbidden-raw-capture'));
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'tab' }]), permitExpired);
  assert.deepEqual(await owned.events(), events, 'terminal ownership must dispatch no successor request');
});

test('expired native permit rejects a fresh challenge and old grant without successor input', async t => {
  const { native, events } = await fixture(t);
  const begun = await native.inputPermitControl('begin_input_permit', binding);
  await native.inputPermitControl('grant_input_permit', { ...binding,
    challenge: begun.result.challenge, lease_remaining_ms: 50 });
  await waitUntil(async () => (await events()).some(event => event.event === 'native-expired'), 'native expiry did not run');
  const next = await native.inputPermitControl('begin_input_permit', { ...binding, sequence: 2 });
  assert.match(next.error.message, /expired/);
  const replay = await native.inputPermitControl('grant_input_permit', { ...binding,
    challenge: begun.result.challenge, lease_remaining_ms: 3000 });
  assert.match(replay.error.message, /expired|replayed/);
  assert.ok(!(await events()).some(event => event.event === 'native-input-event'));
});


test('the actual bounded native control deadline keeps its first cause after a late ACK', async t => {
  const owned = await fixture(t, 'too-late-begin');
  const executor = await owned.host();
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }]), /deadline/);
  assert.deepEqual(hostHelperFailureCause(executor.failed), { phase: 'native_permit_begin', reason: 'deadline' });
  await waitUntil(async () => (await owned.events()).some(event => event.event === 'native-late-ack'), 'late ACK fixture did not answer');
  assert.equal(owned.native.isReady, false);
  assert.equal(owned.native.terminal, true);
  assert.equal((await owned.events()).some(event => event.event === 'native-input-event'), false);
  const before = (await owned.events()).length;
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'tab' }]), /deadline/);
  assert.equal((await owned.events()).length, before);
});
