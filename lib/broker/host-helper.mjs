// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { crc32, inflate } from 'node:zlib';
import { promisify } from 'node:util';
import { NdjsonParser, ResponseBudget, responseMetadata } from '../mcp/protocol.js';
import { retirementDeadline } from '../deadlines.mjs';
// Host element actions are not VNC input; they have their own route below.
import { nativeCapabilities, preAdmissionRefusal, VNC_INPUT_ACTIONS as INPUT_ACTIONS, clipboardReadRefusal,
  CLIPBOARD_UNAVAILABLE_CODE, HUMAN_CONSENT_REQUIRED_CODE } from '../mcp/capabilities.js';

// Reads of native input state, meaningful only once input mapping is qualified.
const MAPPED_READ_ACTIONS = new Set(['cursor_position']);
const HOLD_ACTIONS = new Set(['mouse_down', 'mouse_up']);
// Native reads that need neither pixels nor the input mapping (D8). The
// native executor applies the target's clipboard policy and redaction.
const NATIVE_READ_ACTIONS = new Set(['clipboard_read']);
// Observations computed from raw VNC pixels. The Host route answers screenshot
// from its own ScreenCaptureKit image and never falls back to VNC pixels for
// these, so it refuses them before admission as unsupported_on_route.
const RAW_OBSERVATION_ACTIONS = new Set(['cursor_crop', 'diff_check', 'set_baseline', 'detect_elements',
  'zoom', 'wait_for_stable', 'expect_baseline', 'expect_change']);
// Served by the Host itself rather than the native VNC executor.
const HOST_ACTIONS = new Set(['screenshot', 'ax_snapshot', 'click_element', 'focus_element']);
// Ref-addressed element actions and the Host's AX action kind for each.
const AX_ELEMENT_ACTIONS = new Map([['click_element', 'press'], ['focus_element', 'focus']]);
const AX_PATHS = { press: new Set(['ax_press', 'ax_show_menu']), focus: new Set(['ax_focus', 'ax_raise']) };
const AX_FALLBACK_PATH = 'vnc_click_required';
const AX_SURFACES = new Set(['control_center', 'menu_extra', 'menu', 'menu_bar', 'popover', 'sheet', 'window',
  'application']);
const HELPER_TIMEOUT_MS = 500;
// The first request also pays SSH connection setup and the remote exec,
// measured at 0.5-0.9 s over a tailnet; warm round trips take milliseconds.
const HELPER_CONNECT_TIMEOUT_MS = 5000;
// begin_activity takes an excluded-app snapshot and shows the overlay before
// it answers: 490-535 ms on PZM, before any link latency.
const HELPER_BEGIN_TIMEOUT_MS = 2000;
// An observation carries a freshly encoded PNG: 1-3.5 s at 1080p over SSH,
// and longer on a slow link. Its first byte must arrive within the stall
// window (the Host finishes or drops a request within 2.5 s), and the reply
// must keep arriving with no gap longer than that, up to the hard cap.
const HELPER_OBSERVATION_STALL_MS = 3000;
const HELPER_OBSERVATION_TIMEOUT_MS = 20000;
// Asked of a Host that reports reply_parts, so a renewal reply can travel
// between the parts of a large image on a slow link.
const HELPER_REPLY_PART_BYTES = 65536;
const RENEW_INTERVAL_MS = 500;
const INPUT_PERMIT_MS = 1000;
const MAX_LEASE_MS = 3000;
const NATIVE_PERMIT_PROTOCOL = 'fruitctl.native-input-permit.v1';
const NATIVE_GEOMETRY_FIELDS = ['nativeWidth', 'nativeHeight', 'scaledWidth', 'scaledHeight',
  'connectionGeneration', 'allocation'];
const MAX_IMAGE_BYTES = 48 * 1024 * 1024;
const CAPTURE_REASONS = new Set(['capture_not_enabled', 'screen_capture_permission_required',
  'configured_display_unavailable', 'own_application_exclusion_unavailable',
  'incomplete_capture', 'capture_failed', 'image_encoding_failed']);
// Host refusals an agent can act on keep their reason as the error code. An
// element owned by a consent or system dialog is refused by the Host with the
// desktop-state sentinel's own code, even when the sentinel read nothing.
const AX_TYPED_REASONS = new Set(['accessibility_permission_required', 'stale_ref', 'ax_unreachable',
  'ax_action_unsupported', HUMAN_CONSENT_REQUIRED_CODE]);
const REFUSAL_REASONS = new Set([...CAPTURE_REASONS, ...AX_TYPED_REASONS, 'accessibility_application_unavailable']);
const CAPTURE_PHASES = new Set(['shareable_content', 'capture_image']);
const APPLE_ERROR_DOMAINS = new Set(['SCStreamErrorDomain', 'NSCocoaErrorDomain',
  'NSPOSIXErrorDomain', 'NSOSStatusErrorDomain']);
const CAPTURE_DIAGNOSTIC_FIELDS = new Set(['schema', 'phase', 'apple_domain', 'apple_code']);
const sanitizedRefusals = new WeakMap();
const inflateAsync = promisify(inflate);
const integer = (value, minimum = 1) => Number.isSafeInteger(value) && value >= minimum;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const sameBounds = (left, right) => object(left) && object(right) &&
  ['x', 'y', 'width', 'height'].every(key => Number.isFinite(left[key]) && left[key] === right[key]);
// The Host canonicalizes CoreGraphics display UUIDs to uppercase.
const DISPLAY_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const validScale = value => Number.isFinite(value) && value >= 1 && value <= 8;
const AX_SCHEMA = 'fruitctl.ax-snapshot.v1';
const AX_MAX_NODES = 1500;
const AX_MAX_DEPTH = 12;
const AX_REF = /^ax:[0-9]{1,10}:0(\.[0-9]{1,3}){0,12}$/;
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

// Only locally constructed, pending-matched refusals and the broker's own
// fixed failure strings can accompany a broker cleanup failure. Keep the
// validated text separate from mutable Error fields.
export function hostHelperRefusalMessage(error) {
  return sanitizedRefusals.get(error);
}

// A failure this module detected itself, such as a missed deadline or a lost
// transport. Its text is a literal from this file, never remote content.
function localFailure(message) {
  const error = new Error(message);
  sanitizedRefusals.set(error, message);
  return error;
}

function helperRefusal(error, requestId) {
  const prefix = 'Host helper refused request';
  // Correlation comes only from our locally generated, pending-matched UUID.
  // Neither remote free text nor an arbitrary error object crosses this seam.
  if (!REFUSAL_REASONS.has(error.message) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    return new Error(prefix);
  }
  const parts = [`${prefix}: ${error.message}`];
  const data = error.data;
  if (object(data) && data.schema === 'fruitctl.host-capture-error.v1' &&
      CAPTURE_PHASES.has(data.phase) && Object.keys(data).length <= 4 &&
      Object.keys(data).every(key => CAPTURE_DIAGNOSTIC_FIELDS.has(key)) &&
      (!Object.hasOwn(data, 'apple_domain') || APPLE_ERROR_DOMAINS.has(data.apple_domain)) &&
      (!Object.hasOwn(data, 'apple_code') ||
        (Object.hasOwn(data, 'apple_domain') && Number.isInteger(data.apple_code) &&
          data.apple_code >= -2147483648 && data.apple_code <= 2147483647))) {
    parts.push(`phase=${data.phase}`);
    if (Object.hasOwn(data, 'apple_domain')) parts.push(`apple_domain=${data.apple_domain}`);
    if (Object.hasOwn(data, 'apple_code')) parts.push(`apple_code=${data.apple_code}`);
  }
  parts.push(`request=${requestId}`);
  const message = parts.join('; ');
  const refusal = new Error(message.length <= 320 ? message : prefix);
  // A typed code never exempts the lane from retirement; only local
  // pre-admission refusals carry that brand.
  if (AX_TYPED_REASONS.has(error.message)) refusal.code = error.message;
  if (error.message === HUMAN_CONSENT_REQUIRED_CODE) refusal.data = { reason: HUMAN_CONSENT_REQUIRED_CODE };
  sanitizedRefusals.set(refusal, refusal.message);
  return refusal;
}

// A display is named by its ID, its CoreGraphics UUID, or both. The UUID
// survives display-ID changes across reconnects; the Host resolves it.
function normalizeConfiguration(config) {
  if (!object(config) || typeof config.sshHost !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.@:[\]-]{0,255}$/.test(config.sshHost) ||
      !Array.isArray(config.command) || config.command.length !== 2 ||
      typeof config.command[0] !== 'string' || !config.command[0].startsWith('/') ||
      !config.command[0].endsWith('/FruitctlHost') ||
      /[\x00-\x1f\x7f]/.test(config.command[0]) || config.command[1] !== '--stdio' ||
      (config.displayId !== undefined && !integer(config.displayId)) ||
      (config.displayUuid !== undefined && (typeof config.displayUuid !== 'string' ||
        !DISPLAY_UUID.test(config.displayUuid.toUpperCase()))) ||
      (config.displayId === undefined && config.displayUuid === undefined)) {
    throw new Error('Invalid host-helper configuration');
  }
  const normalized = structuredClone(config);
  if (normalized.displayUuid !== undefined) normalized.displayUuid = normalized.displayUuid.toUpperCase();
  if (normalized.mapping !== undefined) {
    const mapping = normalized.mapping;
    if (object(mapping) && typeof mapping.displayUuid === 'string') {
      mapping.displayUuid = mapping.displayUuid.toUpperCase();
    }
    if (!object(mapping) || typeof mapping.qualificationReceipt !== 'string' ||
        !mapping.qualificationReceipt.trim() || mapping.displayId !== normalized.displayId ||
        mapping.displayUuid !== normalized.displayUuid ||
        (mapping.scale !== undefined && !validScale(mapping.scale)) ||
        !['nativeWidth', 'nativeHeight', 'scaledWidth', 'scaledHeight'].every(key => integer(mapping[key])) ||
        !sameBounds(mapping.displayBounds, mapping.displayBounds) ||
        mapping.displayBounds.width <= 0 || mapping.displayBounds.height <= 0) {
      throw new Error('Invalid qualified host-helper mapping');
    }
  }
  return normalized;
}

/** The executable's --stdio mode only attaches to a resident same-user app.
 * No opener, bootstrap, service restart, remote shell script, or GUI launch. */
class HelperChannel {
  constructor(config, spawnImpl, onFailure, now) {
    this.pending = new Map();
    this.onFailure = onFailure;
    this.now = now;
    const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    this.child = spawnImpl('ssh', ['-T', '-oBatchMode=yes', '-oForwardAgent=no',
      '-oClearAllForwardings=yes', '-oControlMaster=no', '-oControlPath=none', '-oControlPersist=no',
      '--', config.sshHost, config.command.map(shellQuote).join(' ')],
    { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.childClosed = new Promise(resolve => this.child.once('close', resolve));
    const parser = new NdjsonParser(message => this.receive(message),
      { maxFrameBytes: MAX_IMAGE_BYTES * 2 });
    this.parser = parser;
    this.child.stdout.on('data', chunk => {
      try {
        parser.push(chunk);
        // Only bytes of a reply still in transit count as progress. Another
        // request's complete small reply does not extend a stalled one.
        if (parser.bytes) for (const pending of this.pending.values()) pending.progress?.();
        // Large capture frames should not pin their high-water backing buffer
        // throughout the idle broker lifetime after the image is consumed.
        if (!parser.bytes && parser.buffer.length > 65536) parser.buffer = Buffer.alloc(0);
      } catch { this.fail(localFailure('Invalid host-helper protocol')); }
    });
    this.child.stdout.once('end', () => {
      try { parser.end(); } catch { /* the transport is rejected either way */ }
      this.fail(localFailure('Host-helper transport ended'));
    });
    // Never relay arbitrary remote stderr or protocol values into receipts.
    this.child.stderr?.on('data', () => {});
    this.child.stdin.on('error', () => this.fail(localFailure('Host-helper input failed')));
    this.child.once('error', () => this.fail(localFailure('Host-helper transport failed')));
    this.child.once('exit', () => this.fail(localFailure('Host-helper transport exited')));
  }

  receive(message) {
    if (this.failed || this.closed) return false;
    if (object(message) && message.part !== undefined) return this.receivePart(message);
    if (!object(message) || typeof message.id !== 'string' || !this.pending.has(message.id) ||
        typeof message.success !== 'boolean' ||
        (message.success ? !object(message.result) || message.error !== undefined : !object(message.error))) {
      throw new Error('Invalid host-helper response');
    }
    const pending = this.pending.get(message.id);
    const parts = pending.parts;
    if (parts && (parts.data.length || message.result?.image_parts !== undefined)) {
      // A split reply names exactly the parts received, and only they hold
      // the image. Validation of the joined image is unchanged.
      if (!message.success || message.result.image !== undefined ||
          message.result.image_parts !== parts.data.length) throw new Error('Invalid host-helper response');
      const { image_parts: _count, ...result } = message.result;
      message.result = { ...result, image: parts.data.join('') };
    } else if (message.result?.image_parts !== undefined) throw new Error('Invalid host-helper response');
    this.pending.delete(message.id);
    pending.finish(message.success ? null : helperRefusal(message.error, message.id), message.result);
  }

  receivePart(message) {
    const pending = typeof message.id === 'string' ? this.pending.get(message.id) : undefined;
    const parts = pending?.parts;
    const part = message.part;
    if (!parts || Object.keys(message).length !== 2 || !object(part) || Object.keys(part).length !== 2 ||
        part.index !== parts.data.length || typeof part.data !== 'string' || !part.data.length ||
        part.data.length > parts.bytes || parts.size + part.data.length > MAX_IMAGE_BYTES * 4 / 3 + 4 ||
        // No more parts than the largest image needs at the requested size,
        // so a Host cannot hold the reply as millions of tiny strings.
        parts.data.length >= Math.ceil((MAX_IMAGE_BYTES * 4 / 3 + 4) / parts.bytes)) {
      throw new Error('Invalid host-helper response');
    }
    parts.data.push(part.data);
    parts.size += part.data.length;
    pending.progress?.();
    return true;
  }

  // With stallMs, timeoutMs is a hard cap and the deadline follows arriving
  // bytes: no gap may exceed stallMs. partBytes accepts a split image reply.
  request(action, params, { signal, timeoutMs = HELPER_TIMEOUT_MS, stallMs, partBytes } = {}) {
    if (this.failed || this.closed) return Promise.reject(this.failed || new Error('Host-helper channel closed'));
    if (signal?.aborted) return Promise.reject(new Error('Host-helper request cancelled'));
    const id = randomUUID();
    const sentAt = this.now();
    if (partBytes !== undefined) params = { ...params, reply_part_bytes: partBytes };
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, result) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve({ result, sentAt, roundTripMs: this.now() - sentAt });
      };
      const abort = () => this.fail(new Error('Host-helper request cancelled'));
      const expire = () => this.fail(localFailure('Host-helper receipt deadline exceeded'));
      const arm = from => {
        clearTimeout(timer);
        const wait = stallMs === undefined ? timeoutMs : Math.min(stallMs, sentAt + timeoutMs - from);
        timer = setTimeout(expire, Math.max(0, wait));
      };
      this.pending.set(id, { finish,
        ...(stallMs === undefined ? {} : { progress: () => arm(this.now()) }),
        ...(partBytes === undefined ? {} : { parts: { bytes: partBytes, data: [], size: 0 } }) });
      signal?.addEventListener('abort', abort, { once: true });
      arm(sentAt);
      this.child.stdin.write(JSON.stringify({ action, params, id }) + '\n', error => {
        if (error) this.fail(localFailure('Host-helper input failed'));
      });
    });
  }

  fail(error) {
    if (this.failed || this.closed) return;
    this.failed = error;
    for (const pending of this.pending.values()) pending.finish(error);
    this.pending.clear();
    this.onFailure(error);
    void this.close().catch(() => {});
  }

  close({ signal, timeoutMs = 1250, deadline } = {}) {
    let cutoff;
    try {
      const now = this.now();
      cutoff = Math.min(now + 1250, retirementDeadline({ timeoutMs, deadline, now }));
    } catch (error) { return Promise.reject(error); }
    this.closeDeadline = Math.min(this.closeDeadline ?? Infinity, cutoff);
    const alive = () => this.child.exitCode === null && this.child.signalCode === null;
    if (!this.closing) {
      this.closed = true;
      this.parser?.stop();
      for (const pending of this.pending.values()) pending.finish(new Error('Host-helper channel closed'));
      this.pending.clear();
      const listeners = [];
      const failure = Object.assign(new Error('Host-helper owned SSH exit unconfirmed'), { code: 'release_unconfirmed' });
      this.forceClose = () => {
        if (alive() && !this.closeKillSent) {
          this.closeKillSent = true;
          try { this.child.kill('SIGKILL'); } catch { /* A signal is not exit proof. */ }
        }
      };
      const interrupted = new Promise((_, reject) => {
        this.abortClose = () => { this.forceClose(); reject(failure); };
      });
      this.observeCloseSignal = observed => {
        if (!observed) return;
        const abort = this.abortClose;
        listeners.push([observed, abort]);
        observed.addEventListener('abort', abort, { once: true });
        if (observed.aborted) abort();
      };
      const actualClosure = this.childClosed.then(() => {
        if (this.now() >= this.closeDeadline) throw failure;
      });
      this.closing = Promise.race([actualClosure, interrupted]).finally(() => {
        clearTimeout(this.forceCloseTimer); clearTimeout(this.closeTimer);
        for (const [observed, abort] of listeners) observed.removeEventListener('abort', abort);
        this.observeCloseSignal = null;
      });
      // Keep the actual childClosed promise and sticky closing result even
      // when a caller's shorter inherited cutoff cannot confirm exit.
      this.closing.catch(() => {});
      this.child.stdin.end();
      if (alive()) { try { this.child.kill('SIGTERM'); } catch { /* Await real close. */ } }
    }
    this.observeCloseSignal?.(signal);
    if (this.observeCloseSignal) {
      clearTimeout(this.forceCloseTimer); clearTimeout(this.closeTimer);
      const remaining = this.closeDeadline - this.now();
      if (remaining <= 0) this.abortClose();
      else {
        this.forceCloseTimer = setTimeout(this.forceClose, Math.min(250, remaining * 3 / 4));
        this.closeTimer = setTimeout(this.abortClose, remaining);
      }
    }
    return this.closing;
  }
}

function validateHealth(result, config) {
  if (!object(result) || typeof result.instance_id !== 'string' || !result.instance_id ||
      result.capture_backend !== 'owned_sck' || result.raw_vnc_exclusion !== false ||
      !integer(result.display_id) ||
      (config.displayId !== undefined && result.display_id !== config.displayId) ||
      (config.displayUuid !== undefined && result.display_uuid !== config.displayUuid) ||
      !integer(result.displayGeneration, 0) ||
      result.capture_enabled !== true || result.screen_capture_permission !== true ||
      result.renewal_interval_ms !== RENEW_INTERVAL_MS || result.input_permit_ms !== INPUT_PERMIT_MS ||
      result.maximum_round_trip_ms !== HELPER_TIMEOUT_MS) throw new Error('Host-helper health binding failed');
  return result;
}

// `matches` names the activity sequence and challenge this receipt may echo.
function validateReady(receipt, owner, matches, { refreshPermit = true, roundTripMs = HELPER_TIMEOUT_MS,
  lapsed = false } = {}) {
  // A delayed renewal must not revive an expired input owner. Check at the
  // acknowledgement boundary as well as in the independent watchdog. Only a
  // permit lapsed under an observation is exempt; see permitExpired.
  if (!lapsed) owner.assertPermit();
  const result = receipt.result;
  if (!object(result) || receipt.roundTripMs > roundTripMs ||
      result.instance_id !== owner.instanceId || result.session_id !== owner.sessionId ||
      !matches(result.sequence, result.challenge) ||
      result.display_id !== owner.displayId || result.displayGeneration !== owner.generation ||
      (owner.config.displayUuid !== undefined && result.display_uuid !== owner.config.displayUuid) ||
      result.capture_backend !== 'owned_sck' || result.raw_vnc_exclusion !== false ||
      result.capture_enabled !== true || result.capture_ready !== true ||
      result.overlay_ready !== true || result.ready !== true ||
      !integer(result.ui_heartbeat_age_ms, 0) || result.ui_heartbeat_age_ms > 250 ||
      !integer(result.lease_remaining_ms) || result.lease_remaining_ms > MAX_LEASE_MS ||
      result.renewal_interval_ms !== RENEW_INTERVAL_MS || result.input_permit_ms !== INPUT_PERMIT_MS ||
      result.maximum_round_trip_ms !== HELPER_TIMEOUT_MS) throw new Error('Host-helper activity receipt mismatch');
  owner.observeAccessibility(result);
  if (refreshPermit) owner.refreshPermit(Math.min(receipt.sentAt + INPUT_PERMIT_MS,
    receipt.sentAt + result.lease_remaining_ms));
  return result;
}

function validateNativePermit(response, binding, challenge, granted = false) {
  const result = response?.result;
  if (response?.error || !object(result) ||
      !Object.keys(binding).every(key => result[key] === binding[key]) ||
      typeof result.challenge !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.challenge) ||
      (challenge !== undefined && result.challenge !== challenge) ||
      result.native_permit_protocol !== NATIVE_PERMIT_PROTOCOL ||
      result.input_permit_ms !== INPUT_PERMIT_MS || result.maximum_round_trip_ms !== HELPER_TIMEOUT_MS ||
      !integer(result.native_permit_remaining_ms) || result.native_permit_remaining_ms > INPUT_PERMIT_MS) {
    throw new Error(`Native independent input-permit ${granted ? 'grant' : 'challenge'} unavailable or unconfirmed`);
  }
  return result;
}

// Validate a complete decoded PNG before passing it to an agent. Node's native
// CRC and asynchronous bounded inflater keep large images off the JS heartbeat
// loop. The host encoder supplies pixels; no hiding or masking occurs here.
// D38: a JPEG frame keeps every geometry check; its structure is walked to
// the scan, the frame header must name the scaled size, and it must end with
// EOI. Entropy-coded pixels are not decoded here.
function validateJpeg(jpeg, width, height) {
  if (jpeg.length > MAX_IMAGE_BYTES || jpeg.length < 32 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 ||
      jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) throw new Error('Invalid host-helper JPEG');
  let offset = 2;
  let frame = false;
  for (let segments = 0; segments < 4096 && offset + 4 <= jpeg.length; segments++) {
    if (jpeg[offset] !== 0xff) break;
    const marker = jpeg[offset + 1];
    if (marker === 0xff) { offset++; continue; }
    // No standalone marker belongs before the scan.
    if (marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) break;
    const length = jpeg.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > jpeg.length) break;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const components = jpeg[offset + 9];
      // Huffman baseline, extended or progressive, 8-bit, gray or YCbCr.
      if (frame || marker > 0xc2 || length !== 8 + 3 * components || jpeg[offset + 4] !== 8 ||
          ![1, 3].includes(components) || jpeg.readUInt16BE(offset + 5) !== height ||
          jpeg.readUInt16BE(offset + 7) !== width) break;
      frame = true;
    }
    if (marker === 0xda) {
      if (frame && offset + 2 + length < jpeg.length - 2) return;
      break;
    }
    offset += 2 + length;
  }
  throw new Error('Invalid host-helper JPEG');
}

async function validateImage(result, maximumDimension, mimeType = 'image/png') {
  if (result.mimeType !== mimeType || typeof result.image !== 'string' ||
      !result.image.length || result.image.length > MAX_IMAGE_BYTES * 4 / 3 + 4 ||
      result.image.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.image) ||
      !['nativeWidth', 'nativeHeight', 'scaledWidth', 'scaledHeight'].every(key => integer(result[key])) ||
      result.nativeWidth > 16384 || result.nativeHeight > 16384 ||
      result.nativeWidth * result.nativeHeight > 33554432 ||
      result.scaledWidth > result.nativeWidth || result.scaledHeight > result.nativeHeight ||
      !sameBounds(result.display_bounds, result.display_bounds) ||
      result.display_bounds.width <= 0 || result.display_bounds.height <= 0 ||
      result.pixels_per_point_x !== result.nativeWidth / result.display_bounds.width ||
      result.pixels_per_point_y !== result.nativeHeight / result.display_bounds.height ||
      result.cursor_included !== true ||
      // Hosts that report mode geometry must agree with the capture: pixels
      // are the mode's pixel framebuffer and scale is pixels per point.
      (result.scale !== undefined && (!validScale(result.scale) ||
        result.scale !== result.pixels_per_point_x || result.pixel_width !== result.nativeWidth ||
        result.pixel_height !== result.nativeHeight))) throw new Error('Invalid host-helper capture geometry');
  const ratio = Math.min(1, maximumDimension / Math.max(result.nativeWidth, result.nativeHeight));
  if (result.scaledWidth !== Math.max(1, Math.round(result.nativeWidth * ratio)) ||
      result.scaledHeight !== Math.max(1, Math.round(result.nativeHeight * ratio))) {
    throw new Error('Host-helper capture scaling mismatch');
  }
  if (mimeType === 'image/jpeg') {
    validateJpeg(Buffer.from(result.image, 'base64'), result.scaledWidth, result.scaledHeight);
    return;
  }
  const png = Buffer.from(result.image, 'base64');
  if (png.length > MAX_IMAGE_BYTES || png.length < 45 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('Invalid host-helper PNG');
  }
  let offset = 8;
  const compressed = [];
  let channels;
  let colorType;
  let hasPalette = false;
  let dataEnded = false;
  let chunks = 0;
  while (offset + 12 <= png.length) {
    // ImageIO emits a small chunk set; bound adversarial tiny-chunk work as
    // well as byte and pixel allocations on the shared broker thread.
    if (++chunks > 4096) break;
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length || length > MAX_IMAGE_BYTES) break;
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) ||
        (/^[A-Z]/.test(type) && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type))) break;
    if (crc32(png.subarray(offset + 4, offset + 8 + length)) !== png.readUInt32BE(offset + 8 + length)) break;
    if (offset === 8 && (type !== 'IHDR' || length !== 13 ||
        png.readUInt32BE(offset + 8) !== result.scaledWidth ||
        png.readUInt32BE(offset + 12) !== result.scaledHeight)) break;
    if (type === 'IHDR') {
      if (offset !== 8 || png[offset + 16] !== 8 ||
          ![0, 2, 3, 4, 6].includes(png[offset + 17]) ||
          png[offset + 18] !== 0 || png[offset + 19] !== 0 || png[offset + 20] !== 0) break;
      colorType = png[offset + 17];
      channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    }
    if (type === 'PLTE') {
      if (hasPalette || compressed.length || !length || length > 768 || length % 3 ||
          [0, 4].includes(colorType)) break;
      hasPalette = true;
    }
    if (type === 'IDAT') {
      if (dataEnded || (colorType === 3 && !hasPalette)) break;
      compressed.push(png.subarray(offset + 8, offset + 8 + length));
    } else if (compressed.length) dataEnded = true;
    if (type === 'IEND') {
      if (length === 0 && end === png.length && compressed.length && channels) {
        const rowBytes = result.scaledWidth * channels + 1;
        const expectedBytes = rowBytes * result.scaledHeight;
        let pixels;
        try { pixels = await inflateAsync(Buffer.concat(compressed), { maxOutputLength: expectedBytes }); }
        catch { throw new Error('Incomplete or corrupt host-helper PNG pixels'); }
        if (pixels.length !== expectedBytes) throw new Error('Incomplete host-helper PNG pixels');
        for (let row = 0; row < result.scaledHeight; row++) {
          if (pixels[row * rowBytes] > 4) throw new Error('Invalid host-helper PNG scanline');
        }
        return;
      }
      break;
    }
    offset = end;
  }
  throw new Error('Incomplete or corrupt host-helper PNG');
}

const pixelRect = (value, width, height) => object(value) && Object.keys(value).length === 4 &&
  ['x', 'y'].every(key => integer(value[key], 0)) && ['width', 'height'].every(key => integer(value[key])) &&
  value.x + value.width <= width && value.y + value.height <= height;
const boundedText = value => value === undefined || (typeof value === 'string' && value.length <= 256);

// Validate the Host's AX snapshot and add each frame in the agent's scaled
// display space. Frames stay framebuffer pixels; display_frame is derived.
function validateSnapshot(snapshot, display) {
  const framebuffer = snapshot?.framebuffer;
  if (!object(snapshot) || snapshot.schema !== AX_SCHEMA || snapshot.coordinate_space !== 'framebuffer_pixels' ||
      !object(framebuffer) || !integer(framebuffer.pixel_width) || !integer(framebuffer.pixel_height) ||
      framebuffer.pixel_width > 16384 || framebuffer.pixel_height > 16384 || !validScale(framebuffer.scale) ||
      !integer(snapshot.depth) || snapshot.depth > AX_MAX_DEPTH || typeof snapshot.truncated !== 'boolean' ||
      typeof snapshot.focused_app !== 'boolean' || !Array.isArray(snapshot.applications) ||
      snapshot.applications.length > 256 || !snapshot.applications.every(application => object(application) &&
        integer(application.pid) && typeof application.ref === 'string' && AX_REF.test(application.ref) &&
        (application.bundle_id === null || boundedText(application.bundle_id)) &&
        (application.name === null || boundedText(application.name))) ||
      !Array.isArray(snapshot.nodes) || (snapshot.generation !== undefined && !integer(snapshot.generation)) ||
      snapshot.nodes.length > AX_MAX_NODES || snapshot.node_count !== snapshot.nodes.length) {
    throw new Error('Invalid host-helper AX snapshot');
  }
  const refs = new Set();
  for (const node of snapshot.nodes) {
    if (!object(node) || typeof node.ref !== 'string' || !AX_REF.test(node.ref) || refs.has(node.ref) ||
        (node.parent !== null && !refs.has(node.parent)) || !integer(node.depth, 0) ||
        node.depth > snapshot.depth || typeof node.role !== 'string' || !node.role || node.role.length > 256 ||
        !boundedText(node.subrole) || !boundedText(node.label) || !boundedText(node.value) ||
        (node.value_redacted !== undefined && (node.value_redacted !== true || node.value !== undefined)) ||
        (node.frame !== null && !pixelRect(node.frame, framebuffer.pixel_width, framebuffer.pixel_height))) {
      throw new Error('Invalid host-helper AX snapshot node');
    }
    refs.add(node.ref);
  }
  // The same uniform ratio capture() requests, so display_frame lands in the
  // Host screenshot's coordinates even when the VNC aspect differs.
  const scaled = integer(display?.width) && integer(display?.height);
  const ratio = scaled ? Math.min(1, Math.max(display.width, display.height) /
    Math.max(framebuffer.pixel_width, framebuffer.pixel_height)) : 0;
  const screenshot = { width: Math.max(1, Math.round(framebuffer.pixel_width * ratio)),
    height: Math.max(1, Math.round(framebuffer.pixel_height * ratio)) };
  return { ...snapshot, ...(scaled ? { display: screenshot } : {}),
    nodes: snapshot.nodes.map(node => (!scaled || node.frame === null ? node : { ...node, display_frame: {
      x: Math.floor(node.frame.x * ratio), y: Math.floor(node.frame.y * ratio),
      width: Math.max(1, Math.round(node.frame.width * ratio)), height: Math.max(1, Math.round(node.frame.height * ratio)),
    } })) };
}

const boundedLabel = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

// The Host's receipt for one element action. It must name the request it
// answers; a fallback carries only a framebuffer point, never a verdict.
function validateAxOutcome(outcome, ref, kind, generation, framebuffer) {
  const fallback = outcome?.path === AX_FALLBACK_PATH;
  if (!object(outcome) || outcome.ref !== ref || outcome.action !== kind || outcome.generation !== generation ||
      !(fallback || AX_PATHS[kind].has(outcome.path)) || !AX_SURFACES.has(outcome.surface) ||
      !boundedLabel(outcome.role) || (outcome.subrole !== undefined && !boundedLabel(outcome.subrole)) ||
      (fallback
        ? outcome.verified !== undefined || outcome.ax_result !== undefined || !object(outcome.fallback_point) ||
          !integer(outcome.fallback_point.x, 0) || !integer(outcome.fallback_point.y, 0) ||
          outcome.fallback_point.x >= framebuffer.pixel_width || outcome.fallback_point.y >= framebuffer.pixel_height
        : typeof outcome.verified !== 'boolean' || !['performed', 'indeterminate'].includes(outcome.ax_result) ||
          outcome.fallback_point !== undefined)) {
    throw new Error('Invalid host-helper AX action receipt');
  }
  return outcome;
}

/** Optional target-side capture wraps, rather than replaces, the owned VNC
 * input executor. An unqualified mapping permits observations but no input. */
export class HostHelperExecutor {
  constructor({ nativeExecutor, hostHelper, spawnImpl = spawn, now = () => performance.now(),
    responseBudgetFactory = () => new ResponseBudget() }) {
    this.config = normalizeConfiguration(hostHelper);
    this.native = nativeExecutor;
    this.now = now;
    this.responseBudgetFactory = responseBudgetFactory;
    // A UUID-only profile learns the resolved ID from validated health.
    this.displayId = this.config.displayId;
    this.helperActions = Object.freeze([]);
    this.sessionId = randomUUID();
    this.sequence = 0;
    this.tail = Promise.resolve();
    this.helperTail = Promise.resolve();
    this.observationTail = Promise.resolve();
    this.observing = 0;
    // Challenges sent per activity sequence, so a capture that overlapped a
    // renewal can name either one. Bounded to the most recent sequences.
    this.issued = new Map();
    this.channel = new HelperChannel(this.config, spawnImpl, error => this.fail(error), now);
  }

  get display() { return this.native.display; }

  // The Host route attests its indicator only through a validated activity
  // receipt (overlay_ready) whose input permit is still current.
  get presentation() {
    const live = this.activityActive === true && !this.failed && !this.releasing && !this.released &&
      Number.isFinite(this.permitUntil) && this.now() < this.permitUntil;
    return Object.freeze({ route: 'host', indicator: live ? 'present' : 'unknown' });
  }

  get capabilities() {
    const native = this.native.capabilities ?? nativeCapabilities();
    const actions = ['screenshot', 'health', 'wait'];
    // Only an advertising native backend with the target's policy enabled.
    if (native.known && native.actions.includes('clipboard_read') && this.native.textPolicy?.clipboardRead === true) {
      actions.push('clipboard_read');
    }
    if (this.helperActions.includes('ax_snapshot')) actions.push('ax_snapshot');
    if (this.helperActions.includes('ax_action')) actions.push(...AX_ELEMENT_ACTIONS.keys());
    if (this.config.mapping) actions.push(...INPUT_ACTIONS, ...MAPPED_READ_ACTIONS);
    // Actions describe this wrapper's routes. Unknown native metadata remains
    // explicit; a route or qualified mapping does not prove runtime support.
    return Object.freeze({ backend: 'owned_sck', known: native.known,
      actions: Object.freeze(actions.filter(action => HOST_ACTIONS.has(action) ||
        (!native.known || (native.actions.includes(action) &&
          (!INPUT_ACTIONS.has(action) || this.supportsNativeMapping(native)))))),
      native, inputMappingQualified: Boolean(this.config.mapping) });
  }

  supportsNativeMapping(native) {
    return ['health', 'adopt_observation', 'begin_input_permit', 'grant_input_permit']
      .every(action => native.actions.includes(action));
  }

  preflight(actions) {
    if (this.failed) throw this.failed;
    const native = this.native.capabilities ?? nativeCapabilities();
    for (const action of actions) {
      if ((INPUT_ACTIONS.has(action.action) || MAPPED_READ_ACTIONS.has(action.action)) && !this.config.mapping) {
        throw preAdmissionRefusal('Host-helper input mapping is not qualified');
      }
      if (NATIVE_READ_ACTIONS.has(action.action) && this.native.textPolicy?.clipboardRead !== true) {
        throw clipboardReadRefusal();
      }
      if (RAW_OBSERVATION_ACTIONS.has(action.action)) {
        throw preAdmissionRefusal('Action unavailable on the Host route: it observes raw VNC pixels',
          'unsupported_on_route');
      }
      if (!['screenshot', 'health', 'wait', 'ax_snapshot'].includes(action.action) && !INPUT_ACTIONS.has(action.action) &&
          !MAPPED_READ_ACTIONS.has(action.action) && !NATIVE_READ_ACTIONS.has(action.action) &&
          !AX_ELEMENT_ACTIONS.has(action.action)) {
        throw preAdmissionRefusal('Action unavailable with owned host-helper capture');
      }
      if (action.action === 'ax_snapshot') {
        if (!this.helperActions.includes('ax_snapshot')) {
          throw preAdmissionRefusal('ax_snapshot unavailable; this FruitctlHost predates it');
        }
        if (action.depth !== undefined && (!integer(action.depth) || action.depth > AX_MAX_DEPTH)) {
          throw preAdmissionRefusal('Invalid ax_snapshot depth');
        }
        if (action.focused_app !== undefined && typeof action.focused_app !== 'boolean') {
          throw preAdmissionRefusal('Invalid ax_snapshot focused_app');
        }
        if (action.menu_extras !== undefined && typeof action.menu_extras !== 'boolean') {
          throw preAdmissionRefusal('Invalid ax_snapshot menu_extras');
        }
        this.requireAccessibility();
      }
      if (AX_ELEMENT_ACTIONS.has(action.action)) {
        if (!this.helperActions.includes('ax_action')) {
          throw preAdmissionRefusal(`${action.action} unavailable; this FruitctlHost predates it`);
        }
        if (typeof action.ref !== 'string' || !AX_REF.test(action.ref)) {
          throw preAdmissionRefusal(`Invalid ${action.action} ref`);
        }
        this.requireAccessibility();
        // Refs resolve only against this executor's latest snapshot. A ref
        // from an older snapshot, another lane or a retired executor never
        // reaches the Host.
        if (this.axGeneration === undefined || !this.axRefs.has(action.ref)) {
          throw preAdmissionRefusal(`${action.ref} is not in the latest ax_snapshot; take a new snapshot`,
            'stale_ref');
        }
      }
      // D15/D16: a secret is never typed, and no element is pressed or
      // focused, while the human Stop is latched. A Stop during a live lease
      // fails the executor; this covers a Host whose last validated receipt
      // already reported the latch.
      if ((action.action === 'type_secret' || AX_ELEMENT_ACTIONS.has(action.action)) &&
          this.humanStopLatched === true) {
        const refusal = preAdmissionRefusal(`The human Stop is latched on FruitctlHost; ${action.action} refused`);
        refusal.code = 'human_stop_latched';
        throw refusal;
      }
      if (action.action === 'wait' && action.ms !== undefined &&
          (!integer(action.ms, 50) || action.ms > 10000)) {
        throw preAdmissionRefusal('Invalid host-helper wait duration');
      }
      if (!HOST_ACTIONS.has(action.action) && native.known &&
          (!native.actions.includes(action.action) ||
            (INPUT_ACTIONS.has(action.action) && !this.supportsNativeMapping(native)))) {
        throw preAdmissionRefusal('Action unavailable on native backend');
      }
    }
    if (native.known && actions.some(action => HOLD_ACTIONS.has(action.action)) &&
        !native.actions.includes('release_holds')) {
      throw preAdmissionRefusal('Action unavailable on native backend');
    }
  }

  async ready() {
    const { result } = await this.channel.request('health', { ...this.displayParams,
      capture_backend: 'owned_sck' }, { timeoutMs: HELPER_CONNECT_TIMEOUT_MS });
    const health = validateHealth(result, this.config);
    // A Host that answers requests concurrently can renew beside a capture.
    this.pipelined = health.request_pipelining === true;
    this.replyParts = health.reply_parts === true;
    this.imageFormats = Array.isArray(health.image_formats) ? health.image_formats : [];
    this.instanceId = health.instance_id;
    this.generation = health.displayGeneration;
    this.displayId = health.display_id;
    this.observeAccessibility(health);
    // Older Hosts report no capability list; they offer only capture.
    this.helperActions = Object.freeze(Array.isArray(health.capabilities) && health.capabilities.length <= 32 &&
      health.capabilities.every(action => typeof action === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(action))
      ? [...health.capabilities] : []);
    this.helperReleased = true; // This connection has not acquired activity.
    return this;
  }

  fail(error, closeOptions) {
    if (this.failed) return;
    this.failed = error;
    clearInterval(this.heartbeat);
    clearTimeout(this.permitTimer);
    clearTimeout(this.lapseTimer);
    this.activeController?.abort(error);
    this.releaseController?.abort(error);
    // Invalidating synchronously prevents any successor input from being sent.
    if (!this.nativeClosing) {
      try { this.nativeClosing = Promise.resolve(this.native.close({ graceful: false, ...closeOptions })); }
      catch (closeError) { this.nativeClosing = Promise.reject(closeError); }
      this.nativeClosing.catch(() => {});
    }
    this.helperClosing ??= this.channel?.close(closeOptions);
  }

  // D10 expects the grant. The last validated Host receipt said it is
  // missing, so refuse before admission instead of retiring the lane.
  requireAccessibility() {
    if (this.accessibilityTrusted === false) {
      const refusal = preAdmissionRefusal('FruitctlHost lacks the Accessibility grant');
      refusal.code = 'accessibility_permission_required';
      throw refusal;
    }
  }

  observeAccessibility(result) {
    if (typeof result.accessibility_trusted === 'boolean') this.accessibilityTrusted = result.accessibility_trusted;
    if (typeof result.human_stop_latched === 'boolean') this.humanStopLatched = result.human_stop_latched;
  }

  // Requests name the learned display ID and, when configured, the UUID the
  // Host re-checks on every call.
  get displayParams() {
    return { display_id: this.displayId,
      ...(this.config.displayUuid === undefined ? {} : { display_uuid: this.config.displayUuid }) };
  }

  assertPermit() {
    if (this.activityActive && (this.permitLapsedAt !== undefined || !Number.isFinite(this.permitUntil) ||
        this.now() >= this.permitUntil)) {
      throw localFailure('Host-helper input permit expired');
    }
  }

  // A Host that answers one request at a time cannot renew while it encodes
  // a capture. A permit that expires then lapses rather than retiring the
  // owner: input stays refused, and only a renewal sent after the lapse can
  // re-arm it. Any other expiry retires the owner, including one after this
  // batch has sent mouse_down: retirement releases the hold, and a lapse
  // would leave the button pressed for the rest of the capture.
  permitExpired() {
    if (this.observing > 0 && !this.pipelined && !this.holdPressed) {
      this.permitLapsedAt ??= this.now();
      return;
    }
    this.fail(localFailure('Host-helper input permit expired'));
  }

  refreshPermit(until) {
    if (!Number.isFinite(until) || this.now() >= until) throw localFailure('Host-helper input permit expired');
    this.permitUntil = until;
    clearTimeout(this.permitTimer);
    this.permitTimer = setTimeout(() => {
      if (!this.activityActive || this.failed) return;
      try {
        if (this.now() >= this.permitUntil) this.permitExpired();
        else this.refreshPermit(this.permitUntil);
      } catch (error) { this.fail(error); }
    }, Math.max(1, until - this.now()));
  }

  helperOperation(operation) {
    const task = this.helperTail.then(() => {
      if (this.failed) throw this.failed;
      return operation();
    });
    this.helperTail = task.catch(() => {});
    return task;
  }

  // A serial Host keeps observations in the lease order. A pipelining Host
  // takes them on their own queue so renewals continue during the encode.
  observation(operation) {
    const observed = async () => {
      this.observing++;
      try { return await operation(); }
      finally {
        this.observing--;
        if (!this.observing && this.permitLapsedAt !== undefined && !this.failed) {
          // The renewal queued behind this observation re-arms promptly.
          clearTimeout(this.lapseTimer);
          this.lapseTimer = setTimeout(() => {
            if (this.permitLapsedAt !== undefined) this.fail(localFailure('Host-helper input permit expired'));
          }, RENEW_INTERVAL_MS + HELPER_TIMEOUT_MS);
        }
      }
    };
    if (!this.pipelined) return this.helperOperation(observed);
    const task = this.observationTail.then(() => {
      if (this.failed) throw this.failed;
      return observed();
    });
    this.observationTail = task.catch(() => {});
    return task;
  }

  issuedSince(first, sequence, challenge) {
    return integer(sequence) && sequence >= first && sequence <= this.sequence &&
      this.issued.get(sequence) === challenge;
  }

  activity(action, signal) {
    const budget = action === 'begin_activity' ? HELPER_BEGIN_TIMEOUT_MS : HELPER_TIMEOUT_MS;
    return this.helperOperation(async () => {
      const lapsedAt = this.permitLapsedAt;
      if (lapsedAt === undefined) this.assertPermit();
      const sequence = ++this.sequence;
      let challenge = randomUUID();
      let binding;
      let nativeStartedAt;
      if (this.nativeBinding && !this.nativeReleasing) {
        if (typeof this.native.inputPermitControl !== 'function') {
          throw new Error('Native independent input-permit protocol unavailable');
        }
        binding = { instance_id: this.instanceId, session_id: this.sessionId,
          display_id: this.displayId, displayGeneration: this.generation,
          ...this.nativeBinding, sequence };
        nativeStartedAt = this.now();
        const response = await this.native.inputPermitControl('begin_input_permit', binding,
          { signal, timeoutMs: budget });
        challenge = validateNativePermit(response, binding).challenge;
        if (lapsedAt === undefined) this.assertPermit();
      }
      this.issued.set(sequence, challenge);
      this.issued.delete(sequence - 16);
      const receipt = await this.channel.request(action, { session_id: this.sessionId,
        sequence, challenge, ...this.displayParams, capture_backend: 'owned_sck' }, { signal, timeoutMs: budget });
      // A lapsed permit re-arms only from a renewal sent after the lapse.
      if (lapsedAt !== undefined && receipt.sentAt < lapsedAt) {
        throw localFailure('Host-helper input permit expired');
      }
      const beginning = action === 'begin_activity';
      const result = validateReady(receipt, this, (echoed, echoedChallenge) =>
        echoed === sequence && echoedChallenge === challenge,
      { refreshPermit: !binding && !beginning, roundTripMs: budget, lapsed: lapsedAt !== undefined });
      // Start at our earlier local send boundary. No clock from either
      // remote process can extend the native-created authorization window.
      let until = beginning && !binding
        ? Math.min(receipt.sentAt + INPUT_PERMIT_MS, receipt.sentAt + result.lease_remaining_ms) : undefined;
      if (binding) {
        const remaining = budget - (this.now() - nativeStartedAt);
        if (remaining <= 0) throw new Error('Native input-permit grant deadline exceeded');
        const response = await this.native.inputPermitControl('grant_input_permit', {
          ...binding, challenge, lease_remaining_ms: result.lease_remaining_ms,
        }, { signal, timeoutMs: remaining });
        validateNativePermit(response, binding, challenge, true);
        if (lapsedAt === undefined) this.assertPermit();
        until = Math.min(nativeStartedAt + INPUT_PERMIT_MS, nativeStartedAt + result.lease_remaining_ms);
      }
      this.activityActive = true;
      if (beginning && until !== undefined && this.now() >= until) {
        // A begin that answers within its budget but after the permit window
        // admits the owner with input refused: only the renewal ensureActivity
        // sends next can arm it, and without one the owner retires.
        this.permitUntil = until;
        this.permitLapsedAt = this.now();
        clearTimeout(this.lapseTimer);
        this.lapseTimer = setTimeout(() => {
          if (this.permitLapsedAt !== undefined) this.fail(localFailure('Host-helper input permit expired'));
        }, RENEW_INTERVAL_MS + HELPER_TIMEOUT_MS);
      } else {
        if (until !== undefined) this.refreshPermit(until);
        this.permitLapsedAt = undefined;
        clearTimeout(this.lapseTimer);
      }
      this.lastSequence = result.sequence;
      this.lastChallenge = result.challenge;
    });
  }

  async ensureActivity(signal) {
    if (this.activityActive) { this.assertPermit(); return; }
    const startedAt = this.now();
    await this.activity('begin_activity', signal);
    const beginMs = this.now() - startedAt;
    this.helperReleased = false;
    // The broker's ownership lease covers thinking gaps between commands.
    // Renewal belongs to that owner rather than a completed call's signal.
    this.heartbeat = setInterval(() => {
      if (this.renewing || this.failed) return;
      this.renewing = true;
      this.activity('renew_activity').catch(error => this.fail(error))
        .finally(() => { this.renewing = false; });
    }, RENEW_INTERVAL_MS);
    // The first heartbeat is answered a renewal interval and a round trip
    // from now. A begin slow enough to leave less permit than that (0.5 s of
    // Host work plus link latency on a remote Mac) renews at once instead.
    if (this.permitLapsedAt !== undefined || this.permitUntil - this.now() < RENEW_INTERVAL_MS + beginMs) {
      await this.activity('renew_activity', signal);
    }
  }

  async releaseActivity(signal) {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    if (this.helperReleased) return;
    const receipt = await this.helperOperation(() => this.channel.request('release_activity',
      { session_id: this.sessionId }, { signal }));
    if (receipt.result.instance_id !== this.instanceId ||
        receipt.result.display_id !== this.displayId ||
        receipt.result.displayGeneration !== this.generation || receipt.result.ready !== false ||
        receipt.result.lease_remaining_ms !== 0) throw new Error('Host-helper release receipt mismatch');
    this.helperReleased = true;
    this.activityActive = false;
    clearTimeout(this.permitTimer);
  }

  // An observation receipt reports the lease the Host held when it finished,
  // which may be a renewal sent while it ran. It never refreshes the permit.
  observationReceipt(receipt, first) {
    return validateReady(receipt, this, (sequence, challenge) => this.issuedSince(first, sequence, challenge),
      { refreshPermit: false, roundTripMs: HELPER_OBSERVATION_TIMEOUT_MS, lapsed: true });
  }

  // Pixels are returned only under a live owner: the Host's own receipt at
  // completion, and either a current permit or one lapsed under this read.
  assertObserver() {
    if (this.failed) throw this.failed;
    if (this.permitLapsedAt === undefined) this.assertPermit();
  }

  // D38: JPEG for model-facing frames, PNG when asked for lossless pixels.
  // A Host without image_formats returns PNG only.
  capture(signal, format = 'jpeg') {
    return this.observation(async () => {
      const first = this.lastSequence;
      // The agent-facing size: the native executor's scaled framebuffer.
      const maximumDimension = Math.max(this.native.display.width, this.native.display.height);
      const encoded = this.imageFormats.includes(format) ? format : 'png';
      const receipt = await this.channel.request('capture', { session_id: this.sessionId,
        ...this.displayParams, capture_backend: 'owned_sck', max_dimension: maximumDimension,
        ...(this.imageFormats.includes(format) ? { format } : {}) }, { signal, timeoutMs: HELPER_OBSERVATION_TIMEOUT_MS,
        stallMs: HELPER_OBSERVATION_STALL_MS,
        ...(this.replyParts ? { partBytes: HELPER_REPLY_PART_BYTES } : {}) });
      const result = this.observationReceipt(receipt, first);
      await validateImage(result, maximumDimension, encoded === 'jpeg' ? 'image/jpeg' : 'image/png');
      this.assertObserver();
      return result;
    });
  }

  // Observation only: a live AX read under the same activity lease as
  // capture. It never seeds input authorization or a cached frame.
  axSnapshot(action, signal) {
    return this.observation(async () => {
      const first = this.lastSequence;
      const receipt = await this.channel.request('ax_snapshot', { session_id: this.sessionId,
        ...this.displayParams, capture_backend: 'owned_sck',
        ...(action.depth === undefined ? {} : { depth: action.depth }),
        ...(action.focused_app === undefined ? {} : { focused_app: action.focused_app }),
        ...(action.menu_extras === undefined ? {} : { menu_extras: action.menu_extras }) },
      { signal, timeoutMs: HELPER_OBSERVATION_TIMEOUT_MS, stallMs: HELPER_OBSERVATION_STALL_MS });
      const result = this.observationReceipt(receipt, first);
      const snapshot = validateSnapshot(result.ax_snapshot, this.native.display);
      this.assertObserver();
      // The Host replaced its generation; so does this executor. A Host
      // without element actions reports none and leaves no refs.
      this.axGeneration = snapshot.generation;
      this.axRefs = new Set(snapshot.generation === undefined ? [] : snapshot.nodes.map(node => node.ref));
      this.axFramebuffer = snapshot.framebuffer;
      return { detail: `ax_snapshot: ${snapshot.node_count} nodes${snapshot.truncated ? ' (truncated)' : ''}`,
        ax_snapshot: snapshot };
    });
  }

  axHostRequest(name, params, signal) {
    return this.helperOperation(async () => {
      const sequence = this.lastSequence;
      const challenge = this.lastChallenge;
      const receipt = await this.channel.request(name, { session_id: this.sessionId, ...this.displayParams,
        capture_backend: 'owned_sck', ...params }, { signal });
      const result = validateReady(receipt, this, (echoed, echoedChallenge) =>
        echoed === sequence && echoedChallenge === challenge, { refreshPermit: false });
      this.assertPermit();
      return result;
    });
  }

  // A VNC click needs the qualified mapping and a native backend that can
  // click under the independent input permit.
  get axVncFallback() {
    const native = this.native.capabilities ?? nativeCapabilities();
    return Boolean(this.config.mapping) &&
      (!native.known || (native.actions.includes('mouse_click') && this.supportsNativeMapping(native)));
  }

  /** click_element / focus_element. The Host performs AXPress / AXFocused
   * (or AXShowMenu / AXRaise) and verifies it. Only when the element
   * definitely did not act does it return a framebuffer point; that point is
   * clicked through the ordinary input path (mapping check, input-settle gate,
   * native permit) and the Host then verifies the click. */
  async axElement(action, signal, deadline, scoped) {
    const kind = AX_ELEMENT_ACTIONS.get(action.action);
    const generation = this.axGeneration;
    const framebuffer = this.axFramebuffer;
    const fallback = this.axVncFallback;
    const acted = await this.axHostRequest('ax_action', { generation, ref: action.ref, action: kind,
      vnc_fallback: fallback }, signal);
    const outcome = validateAxOutcome(acted.ax_action, action.ref, kind, generation, framebuffer);
    const { ref, path, surface, role, subrole, verified, ax_result: axResult } = outcome;
    const report = (record) => ({ id: randomUUID(), result: {
      detail: `${action.action} ${ref}: ${record.path}, verified ${record.verified}`,
      ax_action: { ref, action: action.action, surface, role, ...(subrole === undefined ? {} : { subrole }),
        ...record } } });
    if (path !== AX_FALLBACK_PATH) return report({ path, verified, ax_result: axResult });
    const mapping = this.config.mapping;
    if (!fallback || framebuffer.pixel_width !== mapping.nativeWidth ||
        framebuffer.pixel_height !== mapping.nativeHeight) {
      throw new Error('Host-helper AX fallback outside the qualified mapping');
    }
    const point = {
      x: Math.min(mapping.scaledWidth - 1, Math.floor(outcome.fallback_point.x * mapping.scaledWidth / mapping.nativeWidth)),
      y: Math.min(mapping.scaledHeight - 1, Math.floor(outcome.fallback_point.y * mapping.scaledHeight / mapping.nativeHeight)),
    };
    await this.verifyMapping(signal, Math.max(1, deadline - this.now()), scoped.holdScope);
    this.assertPermit();
    if (this.failed) throw this.failed;
    const [clicked] = await this.native.execute([{ action: 'mouse_click', x: point.x, y: point.y }],
      { signal, timeoutMs: Math.max(1, deadline - this.now()), ...scoped });
    if (!clicked || clicked.error) return clicked;
    const checked = await this.axHostRequest('ax_verify', { generation, ref, action: kind }, signal);
    const receipt = checked.ax_verify;
    if (!object(receipt) || receipt.ref !== ref || receipt.action !== kind || receipt.generation !== generation ||
        typeof receipt.verified !== 'boolean') throw new Error('Invalid host-helper AX verification receipt');
    return report({ path: 'vnc_click', verified: receipt.verified, point });
  }

  // The native controller holds input for its settle time after ServerInit
  // (Apple ignores early input). Wait here, before adoption and the native
  // permit, so the short permit lease is never spent waiting. A wait that
  // cannot finish before the operation deadline fails as input_not_ready.
  async awaitInputSettle(health, signal, deadline) {
    const remaining = health.input_settle_remaining_ms;
    if (health.input_ready !== false || !Number.isSafeInteger(remaining) || remaining <= 0) return;
    if (this.now() + remaining >= deadline) {
      throw Object.assign(new Error(`Input not ready: the server ignores input for ${remaining} ms more after connecting`),
        { code: -32013, data: { reason: 'input_not_ready', remaining_ms: remaining } });
    }
    if (signal?.aborted) throw signal.reason;
    await new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, remaining);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async verifyMapping(signal, timeoutMs, holdScope) {
    const deadline = this.now() + timeoutMs;
    const mapping = this.config.mapping;
    if (!mapping) throw new Error('Host-helper input mapping is not qualified');
    const capture = await this.capture(signal);
    if (this.permitLapsedAt !== undefined) await this.activity('renew_activity', signal);
    if (!['nativeWidth', 'nativeHeight', 'scaledWidth', 'scaledHeight'].every(key => capture[key] === mapping[key]) ||
        (mapping.displayId !== undefined && capture.display_id !== mapping.displayId) ||
        (mapping.displayUuid !== undefined && capture.display_uuid !== mapping.displayUuid) ||
        // A qualified scale binds the HiDPI mode; a mode change with equal
        // pixel sizes but different points cannot reuse the mapping.
        (mapping.scale !== undefined && capture.scale !== mapping.scale) ||
        !sameBounds(capture.display_bounds, mapping.displayBounds)) {
      throw new Error('Host-helper qualified mapping changed');
    }
    const [health] = await this.native.execute([{ action: 'health' }], { signal, timeoutMs, holdScope });
    if (health?.error || !object(health?.result) ||
        !['nativeWidth', 'nativeHeight', 'scaledWidth', 'scaledHeight'].every(key => health.result[key] === mapping[key]) ||
        this.native.display.width !== mapping.scaledWidth || this.native.display.height !== mapping.scaledHeight) {
      throw new Error('Host-helper and VNC geometry mismatch');
    }
    const fields = NATIVE_GEOMETRY_FIELDS;
    if (!fields.every(key => integer(health.result[key]))) {
      throw new Error('Native observation allocation binding unavailable');
    }
    const binding = Object.fromEntries(fields.map(key => [key, health.result[key]]));
    if (this.nativeBinding && !fields.every(key => this.nativeBinding[key] === binding[key])) {
      throw new Error('Native input-permit allocation binding changed');
    }
    await this.awaitInputSettle(health.result, signal, deadline);
    // This private native seam adopts the independently qualified SCK
    // observation. It is never accepted from public MCP tool parameters and
    // never takes/discards a raw VNC screenshot to seed input authorization.
    const [adopted] = await this.native.execute([{ action: 'adopt_observation', ...binding }],
      { signal, timeoutMs, holdScope });
    if (adopted?.error || !object(adopted?.result) ||
        !fields.every(key => adopted.result[key] === binding[key])) {
      throw new Error('Native external-observation adoption unconfirmed');
    }
    this.nativeBinding ??= binding;
    // Fresh ready acknowledgement after mapping work; no old permit is reused.
    await this.activity('renew_activity', signal);
  }

  execute(actions, { signal, timeoutMs = 30000, onResponse } = {}) {
    if (this.releasing || this.released) return Promise.reject(new Error('Host-helper executor is releasing'));
    if (!Array.isArray(actions) || !actions.length || actions.length > 256 ||
        actions.some(action => !object(action))) {
      return Promise.reject(new Error('Invalid host-helper action batch'));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
      return Promise.reject(new Error('Invalid host-helper operation deadline'));
    }
    try { this.preflight(actions); }
    catch (error) { return Promise.reject(error); }
    const deadline = this.now() + timeoutMs;
    const controller = new AbortController();
    const responses = [];
    const responseBudget = this.responseBudgetFactory();
    const abort = () => controller.abort(new Error('Host-helper operation cancelled'));
    if (signal?.aborted) return Promise.reject(new Error('Host-helper operation cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Host-helper operation deadline exceeded')), timeoutMs);
    let rejectCancellation;
    const cancellation = new Promise((resolve, reject) => { rejectCancellation = reject; });
    const cancelled = () => {
      const error = controller.signal.reason || new Error('Host-helper operation cancelled');
      error.responses = responses.map(responseMetadata);
      rejectCancellation(error);
    };
    controller.signal.addEventListener('abort', cancelled, { once: true });
    // D27: this wrapper splits one batch into native calls, so it owns the
    // batch's hold scope: every native call carries it, then release_holds.
    const holdScope = actions.some(action => HOLD_ACTIONS.has(action.action)) ? randomUUID() : undefined;
    const scoped = holdScope === undefined ? {} : { holdScope };
    const task = this.tail.then(async () => {
      if (this.failed) throw this.failed;
      if (controller.signal.aborted) throw controller.signal.reason;
      this.preflight(actions);
      this.activeController = controller;
      const onAbort = () => this.fail(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      try {
        // Capability discovery through health does not acquire the overlay or
        // input permit. Other admitted work retains its existing lease rules.
        if (actions.some(action => action.action !== 'health')) await this.ensureActivity(controller.signal);
        for (const action of actions) {
          if (this.failed || controller.signal.aborted) throw this.failed || controller.signal.reason;
          this.assertPermit();
          const remaining = deadline - this.now();
          if (remaining <= 0) throw new Error('Host-helper operation deadline exceeded');
          let response;
          if (action.action === 'screenshot') {
            await this.activity('renew_activity', controller.signal);
            response = { id: randomUUID(), result: await this.capture(controller.signal, action.format) };
            if (this.permitLapsedAt !== undefined) await this.activity('renew_activity', controller.signal);
          } else if (action.action === 'ax_snapshot') {
            await this.activity('renew_activity', controller.signal);
            response = { id: randomUUID(), result: await this.axSnapshot(action, controller.signal) };
            if (this.permitLapsedAt !== undefined) await this.activity('renew_activity', controller.signal);
          } else if (AX_ELEMENT_ACTIONS.has(action.action)) {
            await this.activity('renew_activity', controller.signal);
            response = await this.axElement(action, controller.signal, deadline, scoped);
          } else if (action.action === 'health') {
            const [health] = await this.native.execute([action], { signal: controller.signal, timeoutMs: remaining,
              ...scoped });
            response = health.error ? health : { ...health, result: { ...health.result,
              capabilities: this.capabilities, hostHelper: {
              captureBackend: 'owned_sck', displayId: this.displayId,
              ...(this.config.displayUuid === undefined ? {} : { displayUuid: this.config.displayUuid }),
              displayGeneration: this.generation, inputMappingQualified: Boolean(this.config.mapping) } } };
          } else if (INPUT_ACTIONS.has(action.action)) {
            await this.verifyMapping(controller.signal, remaining, holdScope);
            // D16: a fresh Host renewal immediately before a secret, so a
            // lease or Stop that says no fails here, before any keystroke.
            if (action.action === 'type_secret') await this.activity('renew_activity', controller.signal);
            this.assertPermit();
            if (this.failed) throw this.failed;
            if (action.action === 'mouse_down') this.holdPressed = true;
            [response] = await this.native.execute([action], { signal: controller.signal,
              timeoutMs: Math.max(1, deadline - this.now()), ...scoped });
          } else if (MAPPED_READ_ACTIONS.has(action.action) || NATIVE_READ_ACTIONS.has(action.action)) {
            [response] = await this.native.execute([action], { signal: controller.signal, timeoutMs: remaining,
              ...scoped });
          } else if (action.action === 'wait' &&
              (action.ms === undefined || (integer(action.ms, 50) && action.ms <= 10000))) {
            [response] = await this.native.execute([action], { signal: controller.signal, timeoutMs: remaining,
              ...scoped });
          } else {
            throw new Error('Action unavailable with owned host-helper capture');
          }
          if (this.failed || controller.signal.aborted) throw this.failed || controller.signal.reason;
          this.assertPermit();
          responseBudget.add(response);
          responses.push(response);
          onResponse?.(responseMetadata(response));
          // An unknown clipboard is an answer, not a native failure: end the
          // batch there without retiring the Host route.
          if (response.error && NATIVE_READ_ACTIONS.has(action.action) &&
              response.error.code === CLIPBOARD_UNAVAILABLE_CODE) break;
          if (response.error) throw new Error('Native operation failed');
        }
        if (holdScope) {
          // Batch end releases any live hold. A failure path instead retires
          // the native controller, whose shutdown releases held input.
          const remaining = deadline - this.now();
          if (remaining <= 0) throw new Error('Host-helper operation deadline exceeded');
          const [released] = await this.native.execute([{ action: 'release_holds' }],
            { signal: controller.signal, timeoutMs: remaining, holdScope });
          if (released?.error) throw new Error('Batch-scoped mouse hold release unconfirmed');
        }
        return responses;
      } catch (error) {
        this.fail(error);
        error.responses = responses.map(responseMetadata);
        throw error;
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
        this.activeController = undefined;
        this.holdPressed = false;
      }
    });
    this.tail = task.catch(() => {});
    return Promise.race([task, cancellation]).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', cancelled);
    });
  }

  release({ signal, timeoutMs = 30000 } = {}) {
    if (this.releasing) return this.releasing;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
      return Promise.reject(new Error('Invalid host-helper release deadline'));
    }
    const deadline = this.now() + timeoutMs;
    const controller = new AbortController();
    this.releaseController = controller;
    const abort = () => controller.abort(new Error('Host-helper release cancelled'));
    const interrupted = new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        this.fail(controller.signal.reason, { deadline, signal: controller.signal });
        reject(controller.signal.reason);
      }, { once: true });
    });
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Host-helper release deadline exceeded')), timeoutMs);
    if (signal?.aborted) abort();
    const releaseTask = (async () => {
      try {
        await this.tail;
        if (this.failed || controller.signal.aborted) throw this.failed || controller.signal.reason;
        if (typeof this.native.release !== 'function') throw new Error('Native clean release is unavailable');
        // Keep the resident indication alive while native shutdown confirms
        // held-state release, but finish any permit control already in flight
        // before the native executor starts refusing successor requests.
        this.nativeReleasing = true;
        await Promise.all([this.helperTail, this.observationTail]);
        if (this.failed || controller.signal.aborted) throw this.failed || controller.signal.reason;
        await this.native.release({ signal: controller.signal,
          timeoutMs: Math.max(1, deadline - this.now()) });
        if (this.failed || controller.signal.aborted) throw this.failed || controller.signal.reason;
        await this.releaseActivity(controller.signal);
        const { result } = await this.helperOperation(() => this.channel.request('health', {
          ...this.displayParams, capture_backend: 'owned_sck' }, { signal: controller.signal }));
        validateHealth(result, this.config);
        if (result.instance_id !== this.instanceId || result.displayGeneration !== this.generation ||
            result.display_id !== this.displayId ||
            result.ready !== false || result.overlay_ready !== false || result.capture_ready !== false ||
            result.lease_remaining_ms !== 0) throw new Error('Host-helper overlay release unconfirmed');
        await this.channel.close({ deadline, signal: controller.signal });
        if (this.failed || controller.signal.aborted) throw this.failed || controller.signal.reason;
        this.released = true;
      } catch (error) { this.fail(error, { deadline, signal: controller.signal }); throw error; }
    })();
    this.releasing = Promise.race([releaseTask, interrupted]).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.releaseController = undefined;
    });
    return this.releasing;
  }

  async close({ signal, timeoutMs, deadline } = {}) {
    const inherited = Object.fromEntries(Object.entries({ signal, timeoutMs, deadline })
      .filter(([, value]) => value !== undefined));
    const options = Object.keys(inherited).length ? inherited : undefined;
    if (this.released) { await this.channel.close(options); return; }
    if (this.failed && options) {
      // Shorten already-started owned retirement without replacing its
      // original nativeClosing/helperClosing tracking or clearing failure.
      try { this.nativeClosingUpdate = Promise.resolve(this.native.close({ graceful: false, ...options })); }
      catch (error) { this.nativeClosingUpdate = Promise.reject(error); }
      this.nativeClosingUpdate.catch(() => {});
      this.channel.close(options).catch(() => {});
    }
    this.fail(new Error('Host-helper executor closed'), options);
    await Promise.all([this.nativeClosing, this.helperClosing, this.nativeClosingUpdate]);
  }
}

export async function createHostHelperExecutor(options) {
  let executor;
  try {
    executor = new HostHelperExecutor(options);
    return await executor.ready();
  } catch (error) {
    if (executor) await executor.close();
    else await options.nativeExecutor.close({ graceful: false });
    throw error;
  }
}
