// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto';
import { HostHelperExecutor } from './host-helper.mjs';
import { nativeCapabilities, preAdmissionRefusal } from '../mcp/capabilities.js';

// This local adapter owns no VNC connection, credential provider or input
// process. Host capture uses its validated display size; only wait is local.
class HostOnlyObserver {
  capabilities = nativeCapabilities(['health', 'wait']);
  bindHealth(health) {
    const geometry = health.display_geometry;
    if (!geometry || !['pixel_width', 'pixel_height'].every(key =>
      Number.isInteger(geometry[key]) && geometry[key] > 0 && geometry[key] <= 16384) || geometry.pixel_width * geometry.pixel_height > 33554432) {
      throw new Error('Host-only display geometry unavailable');
    }
    if (!['point_width', 'point_height'].every(key => Number.isFinite(geometry[key]) && geometry[key] > 0) ||
        !Number.isFinite(geometry.scale) || geometry.scale < 1 || geometry.scale > 8 ||
        geometry.pixel_width / geometry.point_width !== geometry.scale ||
        geometry.pixel_height / geometry.point_height !== geometry.scale) {
      throw new Error('Host-only display geometry unavailable');
    }
    const size = { width: geometry.pixel_width, height: geometry.pixel_height, scale: geometry.scale };
    if (this.geometry && Object.keys(size).some(key => size[key] !== this.geometry[key])) {
      throw new Error('Host-only display geometry changed');
    }
    this.geometry = Object.freeze(size);
    const ratio = Math.min(1, 2048 / Math.max(size.width, size.height));
    this.display = Object.freeze({ width: Math.max(1, Math.round(size.width * ratio)),
      height: Math.max(1, Math.round(size.height * ratio)) });
  }
  assertFrame(width, height, scaleX, scaleY) {
    if (width !== this.geometry.width || height !== this.geometry.height ||
        scaleX !== this.geometry.scale || scaleY !== this.geometry.scale) {
      throw new Error('Host-only observation geometry changed');
    }
  }
  async execute(actions, { signal } = {}) {
    if (actions.length !== 1 || actions[0].action !== 'wait') {
      throw preAdmissionRefusal('VNC actions are forbidden on the Host-only transport', 'unsupported_on_route');
    }
    const ms = actions[0].ms ?? 1000;
    if (signal?.aborted) throw signal.reason;
    await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
      signal?.addEventListener('abort', abort, { once: true });
    });
    return [{ id: randomUUID(), result: { detail: `Waited ${ms} milliseconds` } }];
  }
  async release() {}
  async close() {}
}

export async function createHostOnlyExecutor({ hostHelper, hostInput, signal, deadline, onExecutor, ...options }) {
  let executor;
  try {
    if (signal?.aborted || performance.now() >= deadline) throw signal?.reason || new Error('Operation deadline exceeded');
    executor = new HostHelperExecutor({ ...options, nativeExecutor: new HostOnlyObserver(), hostHelper, hostInput,
      hostOnly: true });
    onExecutor?.(executor);
    return await executor.ready();
  } catch (error) {
    if (executor) await executor.close();
    throw error;
  }
}
