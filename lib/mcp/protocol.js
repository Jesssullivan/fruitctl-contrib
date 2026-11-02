// SPDX-License-Identifier: MIT
import { z } from 'zod';

export const MAX_RESPONSE_FRAME_BYTES = 96 * 1024 * 1024;
export const MAX_REQUEST_FRAME_BYTES = 1024 * 1024;
// Leave room for the transport envelope around a complete result array.
export const MAX_BATCH_RESPONSE_BYTES = MAX_RESPONSE_FRAME_BYTES - MAX_REQUEST_FRAME_BYTES;
export const MAX_BATCH_RESPONSES = 256;

function stringBytes(value) {
  let bytes = Buffer.byteLength(value) + 2;
  for (const match of value.matchAll(/["\\\u0000-\u001f\ud800-\udfff]/g)) {
    const code = match[0].charCodeAt(0);
    if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(match.index + 1) >= 0xdc00 &&
        value.charCodeAt(match.index + 1) <= 0xdfff) continue;
    if (code >= 0xdc00 && code <= 0xdfff && value.charCodeAt(match.index - 1) >= 0xd800 &&
        value.charCodeAt(match.index - 1) <= 0xdbff) continue;
    if (code >= 0xd800) bytes += 3; // unpaired surrogate becomes six ASCII bytes
    else if (code < 32 && ![8, 9, 10, 12, 13].includes(code)) bytes += 5;
    else bytes++;
  }
  return bytes;
}

// Count without allocating a second base64 image or a complete JSON envelope.
// These values cross a JSON wire; cycles and non-JSON values fail explicitly.
function jsonBytes(value, remaining, ancestors = new Set(), depth = 0) {
  let bytes;
  if (value === null) bytes = 4;
  else if (typeof value === 'string') bytes = stringBytes(value);
  else if (typeof value === 'boolean') bytes = value ? 4 : 5;
  else if (typeof value === 'number') bytes = Number.isFinite(value) ? String(value).length : 4;
  else if (typeof value === 'object') {
    if (depth > 64 || ancestors.has(value)) throw new Error('Invalid response JSON structure');
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) throw new Error('Invalid response JSON value');
    ancestors.add(value);
    bytes = 2;
    let count = 0;
    const array = Array.isArray(value);
    for (const [key, member] of array ? value.entries() : Object.entries(value)) {
      if (!array && member === undefined) continue;
      if (count++) bytes++;
      if (!array) bytes += stringBytes(key) + 1;
      bytes += jsonBytes(array && member === undefined ? null : member,
        remaining - bytes, ancestors, depth + 1);
      if (bytes > remaining) break;
    }
    ancestors.delete(value);
  } else throw new Error('Invalid response JSON value');
  return bytes;
}

export class ResponseBudget {
  constructor({ maxBytes = MAX_BATCH_RESPONSE_BYTES, maxResponses = MAX_BATCH_RESPONSES } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 2 ||
        !Number.isSafeInteger(maxResponses) || maxResponses < 1) {
      throw new Error('Invalid batch response budget');
    }
    this.maxBytes = maxBytes;
    this.maxResponses = maxResponses;
    this.bytes = 2;
    this.count = 0;
  }

  add(response) {
    if (this.count >= this.maxResponses) throw new Error('Batch response count exceeds limit');
    const separator = this.count ? 1 : 0;
    const remaining = this.maxBytes - this.bytes - separator;
    const bytes = jsonBytes(response, remaining);
    if (bytes > remaining) throw new Error('Batch response exceeds byte limit');
    this.bytes += bytes + separator;
    this.count++;
    return response;
  }
}

export function responseMetadata(response) {
  if (!response.result || response.result.image === undefined) return response;
  const { image: _image, ...result } = response.result;
  return { ...response, result };
}

/** Byte-bounded framing decodes only complete UTF-8 frames, including when a
 * code point straddles stream chunks. Malformed payloads never enter logs. */
export class NdjsonParser {
  constructor(onMessage, { maxFrameBytes = MAX_RESPONSE_FRAME_BYTES } = {}) {
    this.onMessage = onMessage;
    this.maxFrameBytes = maxFrameBytes;
    this.buffer = Buffer.alloc(0);
    this.bytes = 0;
    this.stopped = false;
    this.decoder = new TextDecoder('utf-8', { fatal: true });
  }

  push(chunk) {
    if (this.stopped) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const end = newline === -1 ? bytes.length : newline;
      const part = bytes.subarray(offset, end);
      const length = this.bytes + part.length;
      if (length > this.maxFrameBytes) {
        this.stop();
        throw new Error('Daemon protocol frame exceeds byte limit');
      }
      if (length > this.buffer.length) {
        const capacity = Math.min(this.maxFrameBytes,
          Math.max(length, this.buffer.length * 2, 65536));
        const larger = Buffer.allocUnsafe(capacity);
        this.buffer.copy(larger, 0, 0, this.bytes);
        this.buffer = larger;
      }
      part.copy(this.buffer, this.bytes);
      this.bytes = length;
      if (newline === -1) return;
      const frame = this.buffer.subarray(0, this.bytes);
      this.bytes = 0;
      let value;
      try {
        const line = this.decoder.decode(frame).trim();
        if (!line) { offset = newline + 1; continue; }
        value = JSON.parse(line);
      } catch {
        this.stop();
        throw new Error('Invalid daemon protocol frame');
      }
      if (this.onMessage(value) === false) { this.stop(); return; }
      offset = newline + 1;
    }
  }

  end() {
    const partial = this.bytes;
    this.stop();
    if (partial) throw new Error('Incomplete daemon protocol frame');
  }

  stop() {
    this.stopped = true;
    this.buffer = Buffer.alloc(0);
    this.bytes = 0;
  }
}

const integer = z.number().int().min(0).max(0x7fffffff);
const dimensions = integer.min(1);
const resultSchema = z.object({
  detail: z.string().optional(), image: z.string().optional(),
  x: integer.optional(), y: integer.optional(),
  scaledWidth: dimensions.optional(), scaledHeight: dimensions.optional(),
  timing: z.record(z.string(), z.number().finite()).optional(),
  elements: z.array(z.object({
    text: z.string(), x: integer, y: integer, w: integer, h: integer,
    confidence: z.number().finite(),
  }).passthrough()).optional(),
}).passthrough().refine((result) =>
  (result.scaledWidth === undefined) === (result.scaledHeight === undefined),
'Display dimensions must be paired');

const responseSchema = z.object({
  id: z.union([z.string(), z.number().int()]).optional(),
  result: resultSchema.optional(),
  // Native JSON-RPC codes are integers; a broker or Host per-call refusal
  // (#159) carries its registered string code.
  error: z.object({ code: z.union([z.number().int(), z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)]),
    message: z.string() }).passthrough().optional(),
}).passthrough().refine((response) =>
  (response.result !== undefined) !== (response.error !== undefined),
'Expected exactly one result or error');

export function validateResponse(value) {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid daemon response shape');
  return parsed.data;
}

export function encodeRequest(value) {
  const line = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(line) > MAX_REQUEST_FRAME_BYTES) {
    throw new Error('Daemon request exceeds byte limit');
  }
  return line;
}
