// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto';

const ACTIONS = new Set(['health', 'begin_activity', 'renew_activity', 'release_activity',
  'capture', 'ax_snapshot', 'ax_action', 'export_idle_reference']);
const PHASES = new Set(['running', 'release_enter', 'await_execution', 'await_helpers',
  'native_release', 'release_activity', 'release_health', 'close_channel', 'released', 'release_failed']);
const EVENTS = new Set(['send', 'armed', 'receipt', 'rejected', 'deadline']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opt-in, bounded timing metadata. Never receives request params or replies. */
export function createHelperTimingDiagnostics({ now = () => performance.now(),
  write = record => process.stderr.write(JSON.stringify(record) + '\n'), maxRecords = 1024 } = {}) {
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 1024) {
    throw new Error('Invalid helper timing record bound');
  }
  let count = 0, phase = 'running', scheduled = false;
  const pending = [];
  const flush = () => {
    scheduled = false;
    const records = pending.splice(0, 16);
    // Sink I/O runs outside request send, timer arm and failure transitions.
    for (const record of records) {
      try { write(record); } catch { /* Keep the existing control result. */ }
    }
    if (pending.length) schedule();
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(flush).unref();
  };
  const actionName = action => ACTIONS.has(action) ? action : 'unknown';
  const emit = (event, fields = {}) => {
    if (count >= maxRecords) return;
    const record = { schema: 'fruitctl.host-helper-timing.v1', event,
      at_ms: now(), phase, ...fields };
    if (++count === maxRecords) record.truncated = true;
    pending.push(Object.freeze(record));
    schedule();
  };
  return Object.freeze({
    enqueue(action) {
      if (count >= maxRecords) return undefined;
      const context = Object.freeze({ operation_id: randomUUID(), enqueued_ms: now(), action: actionName(action) });
      emit('queued', context);
      return context;
    },
    request(event, { id, action, sentAt, timeoutMs, stallMs, context, status, deadlineAt } = {}) {
      if (!EVENTS.has(event) || !UUID.test(id ?? '') ||
          ![sentAt, timeoutMs, sentAt + timeoutMs].every(Number.isFinite)) return;
      const queued = UUID.test(context?.operation_id ?? '') && Number.isFinite(context?.enqueued_ms);
      emit(event, { ...(queued ? { operation_id: context.operation_id } : {}), request_id: id,
        action: actionName(action), enqueued_ms: queued ? context.enqueued_ms : sentAt,
        sent_ms: sentAt, deadline_ms: Number.isFinite(deadlineAt) ? deadlineAt : sentAt + timeoutMs,
        hard_deadline_ms: sentAt + timeoutMs, timeout_ms: timeoutMs,
        ...(Number.isFinite(stallMs) ? { stall_ms: stallMs } : {}),
        ...(['ok', 'error', 'deadline'].includes(status) ? { status } : {}) });
    },
    phase(value) {
      phase = PHASES.has(value) ? value : 'running';
      emit('release_phase');
    },
  });
}
