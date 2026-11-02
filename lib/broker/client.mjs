// SPDX-License-Identifier: MIT
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFrames, writeFrame, MAX_REQUEST_BYTES } from './protocol.mjs';
import { ResponseBudget, responseMetadata } from '../mcp/protocol.js';
import { replyBudget } from '../deadlines.mjs';
import { presentationLabels, unattestedLabels, desktopRefusalData } from '../mcp/capabilities.js';

const typedError = (message, code) =>
  Object.assign(new Error(message), typeof code === 'string' && code.length <= 64 ? { code } : {});

export class BrokerExecutor {
  constructor({ socketPath, target, connectTimeoutMs = 5000 }) {
    this.pending = new Map();
    this.closed = false;
    // Route labels come from the broker's frames; none means an older broker.
    this.presentation = presentationLabels();
    this.socket = net.connect(socketPath);
    this.opened = new Promise((resolve, reject) => {
      this.resolveOpen = resolve;
      this.rejectOpen = reject;
    });
    // Prevent rejected connection promises becoming unhandled before execute.
    this.opened.catch(() => {});
    this.openTimer = setTimeout(() => this.fail(new Error('Fruitctl broker connection timed out')), connectTimeoutMs);
    this.socket.once('connect', () => {
      this.connected = true;
      try { writeFrame(this.socket, { v: 1, kind: 'open', profile: target }); }
      catch (error) { this.fail(error); }
    });
    // Only a socket that never connected proves nothing was delivered; an
    // error on a connected socket leaves in-flight execution uncertain.
    this.socket.once('error', () => this.fail(this.connected
      ? new Error('Fruitctl broker disconnected; execution is uncertain')
      : typedError('Fruitctl broker unavailable; start the configured user service', 'broker_unavailable')));
    this.socket.once('close', () => this.fail(new Error('Fruitctl broker disconnected; execution is uncertain')));
    readFrames(this.socket, frame => this.receive(frame), error => this.fail(error));
  }
  receive(frame) {
    if (frame.v !== 1) return this.fail(new Error('Invalid broker protocol version'));
    if (frame.kind === 'opened') {
      if (frame.presentation !== undefined) this.presentation = presentationLabels(frame.presentation);
      clearTimeout(this.openTimer);
      this.resolveOpen();
      return;
    }
    // A frame without an id refuses the whole session: an unknown profile, or
    // a relay's typed bridge failure. Its string code stays with the error.
    if (!frame.id) return this.fail(typedError(frame.error?.message || 'Broker rejected target', frame.error?.code));
    const request = this.pending.get(frame.id);
    // Labels from a late frame for an abandoned request cannot revive them.
    if (!request) return;
    if (performance.now() >= request.deadline) return request.abort();
    if (frame.presentation !== undefined) {
      this.presentation = frame.kind === 'progress' || frame.kind === 'result'
        ? presentationLabels(frame.presentation) : unattestedLabels(frame.presentation);
    }
    if (frame.kind === 'progress') {
      if (!frame.response || typeof frame.response !== 'object') return this.fail(new Error('Invalid broker progress'));
      request.budget.add(frame.response);
      request.responses.push(responseMetadata(frame.response));
      request.onResponse?.(frame.response);
      return;
    }
    if (Array.isArray(frame.responses)) {
      const budget = new ResponseBudget({ maxResponses: request.maxResponses });
      for (const response of frame.responses) budget.add(response);
    }
    this.pending.delete(frame.id);
    request.cleanup();
    if (frame.kind === 'result' && Array.isArray(frame.responses)) request.resolve(frame.responses);
    else {
      const error = new Error(frame.error?.message || 'Broker request failed');
      error.code = frame.error?.code;
      const data = desktopRefusalData(frame.error);
      if (data) error.data = data;
      // An interrupted lane may have no final response list even though this
      // request already admitted progress. Keep that prefix, without appending
      // or overriding any nonempty final response payload.
      error.responses = Array.isArray(frame.responses) && frame.responses.length
        ? frame.responses : [...request.responses];
      request.reject(error);
    }
  }
  // A closed executor keeps its first typed cause (for example a relay's
  // bridge_lost), so a later call is told why, not only that it is closed.
  closedError() {
    const cause = this.failure;
    return typeof cause?.code === 'string' ? typedError(cause.message, cause.code) : new Error('Broker executor closed');
  }
  fail(error) {
    this.failure ??= error;
    // A lost or failed broker channel attests no route and no indicator.
    this.presentation = presentationLabels();
    clearTimeout(this.openTimer);
    this.rejectOpen(error);
    for (const request of this.pending.values()) {
      request.cleanup();
      const failure = typedError(error.message, error.code);
      failure.responses = [...request.responses];
      request.reject(failure);
    }
    this.pending.clear();
    this.socket.destroy();
    this.closed = true;
  }
  async waitOpen({ signal, timeoutMs }) {
    if (signal?.aborted) throw signal.reason || new Error('Operation cancelled');
    let timer;
    let abort;
    try {
      await Promise.race([this.opened, new Promise((_, reject) => {
        abort = () => reject(signal.reason || new Error('Operation cancelled'));
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new Error('Operation deadline exceeded')), timeoutMs);
      })]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  async execute(actions, { signal, timeoutMs = 30000, onResponse } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid operation deadline');
    const deadline = performance.now() + Math.min(30000, timeoutMs);
    await this.waitOpen({ signal, timeoutMs: deadline - performance.now() });
    timeoutMs = deadline - performance.now();
    if (timeoutMs <= 0) throw new Error('Operation deadline exceeded');
    if (this.closed) throw this.closedError();
    if (signal?.aborted) throw signal.reason || new Error('Operation cancelled');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (!this.pending.has(id)) return;
        const responses = [...(this.pending.get(id)?.responses || [])];
        this.pending.delete(id);
        cleanup();
        try { writeFrame(this.socket, { v: 1, kind: 'cancel', id }); } catch {}
        // The broker retires uncertain work; no overlay is attested after it.
        this.presentation = presentationLabels();
        const error = new Error(signal?.reason?.message || 'Operation deadline exceeded');
        error.responses = responses;
        reject(error);
      };
      const timer = setTimeout(abort, timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup, deadline, abort, responses: [], onResponse,
        maxResponses: Math.max(1, Math.min(256, actions?.length || 1)),
        budget: new ResponseBudget({ maxResponses: Math.max(1, Math.min(256, actions?.length || 1)) }) });
      try { writeFrame(this.socket, { v: 1, kind: 'execute', id, actions,
        timeoutMs: replyBudget(timeoutMs) }, MAX_REQUEST_BYTES); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }
  async release({ signal, timeoutMs = 30000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid operation deadline');
    const deadline = performance.now() + Math.min(30000, timeoutMs);
    await this.waitOpen({ signal, timeoutMs: deadline - performance.now() });
    timeoutMs = deadline - performance.now();
    if (timeoutMs <= 0) throw new Error('Operation deadline exceeded');
    if (this.closed) throw this.closedError();
    if (signal?.aborted) throw signal.reason || new Error('Operation cancelled');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        cleanup();
        try { writeFrame(this.socket, { v: 1, kind: 'cancel', id }); } catch {}
        const error = new Error(`Target release unconfirmed: ${signal?.reason?.message || 'Operation deadline exceeded'}`);
        error.code = 'release_unconfirmed';
        this.fail(error);
        reject(error);
      };
      const timer = setTimeout(abort, timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, deadline, abort, responses: [], maxResponses: 1,
        budget: new ResponseBudget({ maxResponses: 1 }), cleanup });
      try { writeFrame(this.socket, { v: 1, kind: 'release', id, timeoutMs: replyBudget(timeoutMs) }); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }
  /** #159: ask the broker to prove and clear a latched release of this
   * target. Resolves to its receipt; a refusal rejects with its code. */
  async reconcile({ signal, timeoutMs = 15000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid operation deadline');
    const deadline = performance.now() + Math.min(30000, timeoutMs);
    await this.waitOpen({ signal, timeoutMs: deadline - performance.now() });
    timeoutMs = deadline - performance.now();
    if (timeoutMs <= 0) throw new Error('Operation deadline exceeded');
    if (this.closed) throw this.closedError();
    const id = randomUUID();
    const responses = await new Promise((resolve, reject) => {
      const abort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        cleanup();
        try { writeFrame(this.socket, { v: 1, kind: 'cancel', id }); } catch {}
        reject(new Error(signal?.reason?.message || 'Operation deadline exceeded'));
      };
      const timer = setTimeout(abort, timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, deadline, abort, responses: [], maxResponses: 1,
        budget: new ResponseBudget({ maxResponses: 1 }), cleanup });
      try { writeFrame(this.socket, { v: 1, kind: 'reconcile', id, timeoutMs: replyBudget(timeoutMs) }); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
    return responses[0]?.result?.reconcile;
  }
  async close() {
    if (!this.closed) {
      try { writeFrame(this.socket, { v: 1, kind: 'close' }); } catch {}
      this.fail(new Error('MCP client closed'));
    }
  }
}
