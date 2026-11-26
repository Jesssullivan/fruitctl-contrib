// SPDX-License-Identifier: MIT
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFrames, writeFrame, MAX_REQUEST_BYTES } from './protocol.mjs';
import { ResponseBudget, responseMetadata } from '../mcp/protocol.js';
import { replyBudget } from '../deadlines.mjs';
import { presentationLabels, unattestedLabels, desktopRefusalData } from '../mcp/capabilities.js';

const typedError = (message, code) =>
  Object.assign(new Error(message), typeof code === 'string' && code.length <= 64 ? { code } : {});

// TIN-8604: a later call may open a new connection only after a transport
// loss. These codes need the operator first: an unconfirmed release or SSH
// exit may leave earlier input live, and an invalid bridge frame is a framing
// or version fault that a new connection would meet again. The session stays
// failed.
const STICKY_CODES = new Set(['release_unconfirmed', 'bridge_unconfirmed', 'bridge_protocol']);
const TRANSPORT_CODE = /^(bridge_[a-z_]+|broker_unavailable)$/;
const transportLoss = Symbol('fruitctl.transportLoss');
const lost = error => Object.assign(error, { [transportLoss]: true });

export class BrokerExecutor {
  constructor({ socketPath, target, connectTimeoutMs = 5000, reconnectTimeoutMs = 3000, reconnect = true }) {
    this.socketPath = socketPath;
    this.target = target;
    this.connectTimeoutMs = connectTimeoutMs;
    this.reconnectTimeoutMs = reconnectTimeoutMs;
    this.reconnect = reconnect;
    this.generation = 0;
    this.ended = false;
    this.connect(connectTimeoutMs);
  }
  // One connection is one broker session: its own client id, lease and
  // pending requests. Nothing moves from one connection to the next.
  connect(connectTimeoutMs) {
    const channel = { pending: new Map(), closed: false, connected: false, answered: false, failure: undefined,
      generation: ++this.generation };
    this.channel = channel;
    // Route labels come from the broker's frames; none means an older broker.
    this.presentation = presentationLabels();
    channel.socket = net.connect(this.socketPath);
    channel.opened = new Promise((resolve, reject) => {
      channel.resolveOpen = resolve;
      channel.rejectOpen = reject;
    });
    // Prevent rejected connection promises becoming unhandled before execute.
    channel.opened.catch(() => {});
    channel.openTimer = setTimeout(() => this.fail(lost(typedError(
      'Fruitctl broker connection timed out before the session opened; the request was not delivered',
      'broker_unavailable')), channel), connectTimeoutMs);
    channel.socket.once('connect', () => {
      channel.connected = true;
      try { writeFrame(channel.socket, { v: 1, kind: 'open', profile: this.target }); }
      catch (error) { this.fail(lost(error), channel); }
    });
    // Requests are written only after `opened`, so a connection that ends
    // before it proves nothing was delivered. After `opened`, an error or a
    // close leaves in-flight execution uncertain.
    const ended = () => lost(!channel.connected
      ? typedError('Fruitctl broker unavailable; start the configured user service', 'broker_unavailable')
      : !channel.answered
        ? typedError('Fruitctl broker closed the connection before the session opened; the request was not delivered',
          'broker_unavailable')
        : new Error('Fruitctl broker disconnected; execution is uncertain'));
    channel.socket.once('error', () => this.fail(ended(), channel));
    channel.socket.once('close', () => this.fail(ended(), channel));
    readFrames(channel.socket, frame => this.receive(frame, channel), error => this.fail(error, channel));
    return channel;
  }
  get socket() { return this.channel.socket; }
  get opened() { return this.channel.opened; }
  get pending() { return this.channel.pending; }
  get closed() { return this.channel.closed; }
  get failure() { return this.channel.failure; }
  receive(frame, channel = this.channel) {
    if (channel.closed) return;
    if (frame.v !== 1) return this.fail(new Error('Invalid broker protocol version'), channel);
    if (frame.kind === 'opened') {
      channel.answered = true;
      if (frame.presentation !== undefined && channel === this.channel) this.presentation = presentationLabels(frame.presentation);
      clearTimeout(channel.openTimer);
      channel.resolveOpen();
      return;
    }
    // A frame without an id refuses the whole session: an unknown profile, or
    // a relay's typed bridge failure. Its string code stays with the error.
    if (!frame.id) {
      const refusal = typedError(frame.error?.message || 'Broker rejected target', frame.error?.code);
      return this.fail(TRANSPORT_CODE.test(refusal.code ?? '') ? lost(refusal) : refusal, channel);
    }
    const request = channel.pending.get(frame.id);
    // Labels from a late frame for an abandoned request cannot revive them.
    if (!request) return;
    if (performance.now() >= request.deadline) return request.abort();
    if (frame.presentation !== undefined && channel === this.channel) {
      this.presentation = frame.kind === 'progress' || frame.kind === 'result'
        ? presentationLabels(frame.presentation) : unattestedLabels(frame.presentation);
    }
    if (frame.kind === 'progress') {
      if (!frame.response || typeof frame.response !== 'object') return this.fail(new Error('Invalid broker progress'), channel);
      request.budget.add(frame.response);
      request.responses.push(responseMetadata(frame.response));
      request.onResponse?.(frame.response);
      return;
    }
    if (Array.isArray(frame.responses)) {
      const budget = new ResponseBudget({ maxResponses: request.maxResponses });
      for (const response of frame.responses) budget.add(response);
    }
    channel.pending.delete(frame.id);
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
  closedError(channel = this.channel) {
    const cause = channel.failure;
    return typeof cause?.code === 'string' ? typedError(cause.message, cause.code) : new Error('Broker executor closed');
  }
  /** TIN-8604: whether the next execute may open a new connection. Only a
   * transport loss qualifies; a protocol violation, an unknown profile, an
   * unconfirmed release or exit, and an explicit close stay failed. */
  mayReconnect(channel = this.channel) {
    const cause = channel.failure;
    return this.reconnect && !this.ended && channel.closed && cause?.[transportLoss] === true &&
      !STICKY_CODES.has(cause.code);
  }
  fail(error, channel = this.channel) {
    if (channel.closed) return;
    channel.failure ??= error;
    // A lost or failed broker channel attests no route and no indicator.
    if (channel === this.channel) this.presentation = presentationLabels();
    clearTimeout(channel.openTimer);
    channel.rejectOpen(error);
    // Requests in flight fail with the loss and are never sent again.
    for (const request of channel.pending.values()) {
      request.cleanup();
      const failure = typedError(error.message, error.code);
      failure.responses = [...request.responses];
      request.reject(failure);
    }
    channel.pending.clear();
    channel.socket.destroy();
    channel.closed = true;
  }
  async waitOpen({ signal, timeoutMs, channel = this.channel }) {
    if (signal?.aborted) throw signal.reason || new Error('Operation cancelled');
    let timer;
    let abort;
    try {
      await Promise.race([channel.opened, new Promise((_, reject) => {
        abort = () => reject(signal.reason || new Error('Operation cancelled'));
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new Error('Operation deadline exceeded')), timeoutMs);
      })]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  /** TIN-8604: the connection a new execute uses. After a transport loss it
   * makes one bounded attempt at a new connection, and only here: no timer,
   * no background retry, no replay. The new connection is a new broker
   * session, so it holds no lease and input waits for a new screenshot. A
   * failed attempt fails this call with its own code; the next call may try
   * once more. */
  async openChannel({ signal, deadline, reconnect }) {
    let channel = this.channel;
    if (reconnect && this.mayReconnect(channel)) {
      if (signal?.aborted) throw signal.reason || new Error('Operation cancelled');
      channel = this.connect(Math.max(1, Math.min(this.reconnectTimeoutMs, deadline - performance.now())));
    }
    await this.waitOpen({ signal, timeoutMs: deadline - performance.now(), channel });
    if (deadline - performance.now() <= 0) throw new Error('Operation deadline exceeded');
    if (channel.closed) throw this.closedError(channel);
    if (signal?.aborted) throw signal.reason || new Error('Operation cancelled');
    return channel;
  }
  async execute(actions, { signal, timeoutMs = 30000, onResponse } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid operation deadline');
    const deadline = performance.now() + Math.min(30000, timeoutMs);
    const channel = await this.openChannel({ signal, deadline, reconnect: true });
    timeoutMs = deadline - performance.now();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (!channel.pending.has(id)) return;
        const responses = [...(channel.pending.get(id)?.responses || [])];
        channel.pending.delete(id);
        cleanup();
        try { writeFrame(channel.socket, { v: 1, kind: 'cancel', id }); } catch {}
        // The broker retires uncertain work; no overlay is attested after it.
        if (channel === this.channel) this.presentation = presentationLabels();
        const error = new Error(signal?.reason?.message || 'Operation deadline exceeded');
        error.responses = responses;
        reject(error);
      };
      const timer = setTimeout(abort, timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      signal?.addEventListener('abort', abort, { once: true });
      channel.pending.set(id, { resolve, reject, cleanup, deadline, abort, responses: [], onResponse,
        maxResponses: Math.max(1, Math.min(256, actions?.length || 1)),
        budget: new ResponseBudget({ maxResponses: Math.max(1, Math.min(256, actions?.length || 1)) }) });
      try { writeFrame(channel.socket, { v: 1, kind: 'execute', id, actions,
        timeoutMs: replyBudget(timeoutMs) }, MAX_REQUEST_BYTES); }
      catch (error) { channel.pending.delete(id); cleanup(); reject(error); }
    });
  }
  // Release never opens a new connection: the broker already released a
  // dropped connection's lease itself, and a new session cannot prove that
  // release, so a release after a loss reports the loss.
  async release({ signal, timeoutMs = 30000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid operation deadline');
    const deadline = performance.now() + Math.min(30000, timeoutMs);
    const channel = await this.openChannel({ signal, deadline, reconnect: false });
    timeoutMs = deadline - performance.now();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (!channel.pending.has(id)) return;
        channel.pending.delete(id);
        cleanup();
        try { writeFrame(channel.socket, { v: 1, kind: 'cancel', id }); } catch {}
        const error = new Error(`Target release unconfirmed: ${signal?.reason?.message || 'Operation deadline exceeded'}`);
        error.code = 'release_unconfirmed';
        this.fail(error, channel);
        reject(error);
      };
      const timer = setTimeout(abort, timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      signal?.addEventListener('abort', abort, { once: true });
      channel.pending.set(id, { resolve, reject, deadline, abort, responses: [], maxResponses: 1,
        budget: new ResponseBudget({ maxResponses: 1 }), cleanup });
      try { writeFrame(channel.socket, { v: 1, kind: 'release', id, timeoutMs: replyBudget(timeoutMs) }); }
      catch (error) { channel.pending.delete(id); cleanup(); reject(error); }
    });
  }
  /** #159: ask the broker to prove and clear a latched release of this
   * target. Resolves to its receipt; a refusal rejects with its code. */
  async reconcile({ signal, timeoutMs = 15000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid operation deadline');
    const deadline = performance.now() + Math.min(30000, timeoutMs);
    const channel = await this.openChannel({ signal, deadline, reconnect: false });
    timeoutMs = deadline - performance.now();
    const id = randomUUID();
    const responses = await new Promise((resolve, reject) => {
      const abort = () => {
        if (!channel.pending.has(id)) return;
        channel.pending.delete(id);
        cleanup();
        try { writeFrame(channel.socket, { v: 1, kind: 'cancel', id }); } catch {}
        reject(new Error(signal?.reason?.message || 'Operation deadline exceeded'));
      };
      const timer = setTimeout(abort, timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      signal?.addEventListener('abort', abort, { once: true });
      channel.pending.set(id, { resolve, reject, deadline, abort, responses: [], maxResponses: 1,
        budget: new ResponseBudget({ maxResponses: 1 }), cleanup });
      try { writeFrame(channel.socket, { v: 1, kind: 'reconcile', id, timeoutMs: replyBudget(timeoutMs) }); }
      catch (error) { channel.pending.delete(id); cleanup(); reject(error); }
    });
    return responses[0]?.result?.reconcile;
  }
  async close() {
    this.ended = true;
    const channel = this.channel;
    if (!channel.closed) {
      try { writeFrame(channel.socket, { v: 1, kind: 'close' }); } catch {}
      this.fail(new Error('MCP client closed'), channel);
    }
  }
}
