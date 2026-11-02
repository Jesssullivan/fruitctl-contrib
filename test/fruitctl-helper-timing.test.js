// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHelperTimingDiagnostics } from '../lib/broker/helper-timing.mjs';

const flushed = () => new Promise(resolve => setImmediate(resolve));

test('helper timing records only bounded sanitized metadata', async () => {
  const records = [];
  const timing = createHelperTimingDiagnostics({ now: () => 42, write: record => records.push(record), maxRecords: 3 });
  timing.request('send', { id: '00000000-0000-4000-8000-000000000001', action: 'private-parameter-value',
    sentAt: 40, timeoutMs: 500, context: { operation_id: 'private-display-value', enqueued_ms: 39 },
    status: 'private-credential-value', params: { password: 'private-credential-value' },
    reply: { image: 'private-image-value' } });
  timing.phase('release_health');
  timing.phase('released');
  timing.phase('release_failed');
  await flushed();
  assert.equal(records.length, 3);
  assert.equal(records[0].action, 'unknown');
  assert.equal(records[0].enqueued_ms, 40);
  assert.equal(records[0].deadline_ms, 540);
  assert.equal(records[2].truncated, true);
  assert.doesNotMatch(JSON.stringify(records), /private-/);
});

test('helper timing identifies queue time and effective stall deadline without changing the hard cap', async () => {
  let now = 10;
  const records = [];
  const timing = createHelperTimingDiagnostics({ now: () => now, write: record => records.push(record) });
  const context = timing.enqueue('capture');
  now = 25;
  timing.request('armed', { id: '00000000-0000-4000-8000-000000000001', action: 'capture',
    sentAt: 25, timeoutMs: 20000, stallMs: 3000, deadlineAt: 3025, context });
  await flushed();
  assert.equal(records[0].event, 'queued');
  assert.equal(records[1].operation_id, records[0].operation_id);
  assert.equal(records[1].enqueued_ms, 10);
  assert.equal(records[1].sent_ms, 25);
  assert.equal(records[1].deadline_ms, 3025);
  assert.equal(records[1].hard_deadline_ms, 20025);
});

test('helper timing ignores sink failures and refuses invalid record bounds', async () => {
  const timing = createHelperTimingDiagnostics({ write() { throw new Error('diagnostic disk unavailable'); } });
  assert.doesNotThrow(() => timing.enqueue('renew_activity'));
  assert.doesNotThrow(() => timing.phase('release_failed'));
  assert.throws(() => createHelperTimingDiagnostics({ maxRecords: 1025 }), /record bound/);
  await flushed();
});

test('helper timing defers sink delivery and retains capture-time timestamps', async () => {
  let now = 10, returned = false;
  const records = [];
  const timing = createHelperTimingDiagnostics({ now: () => now, write(record) {
    assert.equal(returned, true);
    records.push(record);
  } });
  timing.enqueue('renew_activity');
  assert.equal(records.length, 0);
  now = 99; returned = true;
  await flushed();
  assert.equal(records.length, 1);
  assert.equal(records[0].at_ms, 10);
});
