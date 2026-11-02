// SPDX-License-Identifier: MIT
// A protocol-level stand-in for one resident FruitctlHost reached over SSH.
// It models the lease, AX generation and input replies the broker reads; it
// is not a Host, a desktop or a qualification of either.
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { deflateSync } from 'node:zlib';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, content) {
  const type = Buffer.from(name);
  const value = Buffer.alloc(content.length + 12);
  value.writeUInt32BE(content.length, 0);
  type.copy(value, 4); content.copy(value, 8);
  value.writeUInt32BE(crc32(Buffer.concat([type, content])), content.length + 8);
  return value;
}
export function png(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))])
    .toString('base64');
}

export const GEOMETRY = Object.freeze({ pixel_width: 512, pixel_height: 256, point_width: 256, point_height: 128,
  scale: 2 });
export const hostBinding = () => ({ sshHost: 'configured-target',
  command: ['/Applications/FruitctlHost.app/Contents/MacOS/FruitctlHost', '--stdio'], displayId: 42 });
export const hostOnlyProfile = (extra = {}) => ({ transport: 'host-only', targetId: 'configured-native-target',
  hostHelper: hostBinding(), ...extra });
export const snapshot = (overrides = {}) => ({ schema: 'fruitctl.ax-snapshot.v1',
  coordinate_space: 'framebuffer_pixels', framebuffer: { ...GEOMETRY }, depth: 6, focused_app: true,
  menu_extras: false, truncated: false, node_count: 2, generation: 4,
  applications: [{ pid: 77, ref: 'ax:77:0', bundle_id: 'com.example.app', name: 'Example' }],
  nodes: [{ ref: 'ax:77:0', parent: null, depth: 0, role: 'AXApplication', frame: null },
    { ref: 'ax:77:0.0', parent: 'ax:77:0', depth: 1, role: 'AXButton', label: 'OK',
      frame: { x: 20, y: 40, width: 60, height: 80 } }], ...overrides });
export const refusal = (request, message) => ({ id: request.id, success: false,
  error: { code: -32000, message } });

/** One attachment. `alter(request, response, state)` may rewrite a reply
 * (or return null to drop it); `releaseOn(request)` ends the lease with that
 * request, as a Host that predates #159 did on an AX refusal. */
export function mockHost({ alter, releaseOn, capabilities = [], health = {}, shared } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null; child.kills = [];
  const lease = shared ?? { owner: undefined };
  // The Host ends a connection's lease when that attachment goes away.
  const detach = () => { if (lease.attachment === child) { lease.owner = undefined; lease.attachment = undefined; } };
  child.kill = signal => {
    child.kills.push(signal);
    child.signalCode = signal;
    if (!lease.keepOnDetach) detach();
    queueMicrotask(() => { child.emit('exit', null, signal); child.emit('close', null, signal); });
    return true;
  };
  const requests = [];
  const state = () => ({ instance_id: 'resident-test-app', capture_backend: 'owned_sck', capture_enabled: true,
    screen_capture_permission: true, raw_vnc_exclusion: false, display_id: 42, displayGeneration: 7,
    renewal_interval_ms: 500, input_permit_ms: 1000, maximum_round_trip_ms: 500, request_pipelining: true,
    accessibility_trusted: true, human_stop_latched: false, display_geometry: { ...GEOMETRY },
    capabilities: ['capture', 'begin_activity', 'renew_activity', 'release_activity', 'ax_snapshot', 'ax_action',
      ...capabilities],
    capture_ready: Boolean(lease.owner), overlay_ready: Boolean(lease.owner), ready: Boolean(lease.owner),
    ui_heartbeat_age_ms: lease.owner ? 0 : null, lease_remaining_ms: lease.owner ? 3000 : 0,
    ...health, ...(lease.owner || {}) });
  const answer = request => {
    if (request.action === 'begin_activity' || request.action === 'renew_activity') {
      lease.owner = { session_id: request.params.session_id, sequence: request.params.sequence,
        challenge: request.params.challenge };
      lease.attachment = child;
    } else if (request.action === 'release_activity') lease.owner = undefined;
    if (releaseOn?.(request)) lease.owner = undefined;
    let result = state();
    if (request.action === 'capture') result = { ...result, image: png(512, 256), mimeType: 'image/png',
      nativeWidth: 512, nativeHeight: 256, scaledWidth: 512, scaledHeight: 256,
      display_bounds: { x: 0, y: 0, width: 256, height: 128 }, pixels_per_point_x: 2, pixels_per_point_y: 2,
      cursor_included: true };
    if (request.action === 'ax_snapshot') result = { ...result, ax_snapshot: snapshot() };
    if (request.action === 'ax_action') result = { ...result, ax_action: { ref: request.params.ref,
      action: request.params.action, generation: request.params.generation, path: 'ax_press', surface: 'window',
      role: 'AXButton', ax_result: 'performed', verified: true } };
    let response = { id: request.id, success: true, result };
    if (alter) response = alter(request, response, lease);
    if (response === null) return;
    queueMicrotask(() => child.stdout.write(JSON.stringify(response) + '\n'));
  };
  child.stdin = new Writable({ write(bytes, encoding, callback) {
    for (const line of bytes.toString().split('\n').filter(Boolean)) {
      const request = JSON.parse(line);
      requests.push(request);
      answer(request);
    }
    callback();
  } });
  // EOF from the broker ends this attachment.
  child.stdin.on('finish', () => { if (!lease.keepOnDetach) detach(); });
  return { child, requests, lease, state };
}

/** Successive SSH attachments to one resident Host share its lease. */
export function hostSequence(options = {}) {
  const shared = { owner: undefined };
  const attachments = [];
  return { attachments, shared, spawnImpl(command, args) {
    const index = attachments.length;
    const host = mockHost({ ...(typeof options === 'function' ? options(index) : options), shared });
    host.args = args;
    attachments.push(host);
    return host.child;
  } };
}
