// SPDX-License-Identifier: MIT
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import net from 'node:net';
import { credentialSpec, secretRefs } from './secrets.mjs';

export function defaultConfigPath(env = process.env) {
  if (env.FRUITCTL_CONFIG_PATH) return env.FRUITCTL_CONFIG_PATH;
  const base = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'fruitctl')
    : path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'fruitctl');
  return path.join(base, 'config.json');
}

export function defaultSocketPath(env = process.env) {
  if (env.FRUITCTL_SOCKET_PATH) return env.FRUITCTL_SOCKET_PATH;
  const base = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'fruitctl', 'run')
    : path.join(env.XDG_RUNTIME_DIR || path.join(os.homedir(), '.local', 'state'), 'fruitctl');
  return path.join(base, process.platform === 'darwin' ? 'broker.sock' : 'relay.sock');
}

// Broker-owned durable state (the D11 journal). Never the socket's runtime dir.
export function defaultStateDir(env = process.env) {
  if (env.FRUITCTL_STATE_DIR) return env.FRUITCTL_STATE_DIR;
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'fruitctl', 'state')
    : path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'fruitctl');
}

export async function prepareSocket(socketPath) {
  if (!path.isAbsolute(socketPath)) throw new Error('Socket path must be absolute');
  const parent = path.dirname(socketPath);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await fs.lstat(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory() ||
      parentStat.uid !== process.getuid() || (parentStat.mode & 0o077)) {
    throw new Error('Socket directory must be user-owned with mode 0700');
  }
  let existing;
  try { existing = await fs.lstat(socketPath); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!existing.isSocket() || existing.uid !== process.getuid()) {
    throw new Error('Refusing to replace an unowned socket path');
  }
  const live = await new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false);
      else reject(error);
    });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Socket probe timed out')); });
  });
  if (live) throw new Error('A Fruitctl service already owns this socket');
  const current = await fs.lstat(socketPath).catch(() => null);
  if (current?.ino === existing.ino && current.uid === process.getuid()) await fs.unlink(socketPath);
}

// D12: an optional declared input source per target, as a HIToolbox source ID
// (com.apple.keylayout.US) or layout name. ASCII only, matching the Home
// Manager option.
const INPUT_SOURCE = /^[A-Za-z0-9][A-Za-z0-9._ ()\/+-]{0,127}$/;
export function validInputSource(value) {
  return typeof value === 'string' && INPUT_SOURCE.test(value);
}

// Sources whose unmodified keys type printable ASCII exactly as the US
// keymap does, so RFB keysyms map one-to-one. Anything else declared is not
// US-compatible; an undeclared source keeps the historical US assumption.
export const US_COMPATIBLE_INPUT_SOURCES = Object.freeze(['com.apple.keylayout.US',
  'com.apple.keylayout.ABC', 'com.apple.keylayout.USExtended', 'U.S.', 'US', 'ABC']);
export function usCompatibleInputSource(value) {
  return value === undefined || US_COMPATIBLE_INPUT_SOURCES.includes(value);
}

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const optionalBoolean = value => value === undefined || typeof value === 'boolean';
const optionalInteger = (value, min, max) => value === undefined ||
  (Number.isInteger(value) && value >= min && value <= max);

/** D8/D29 profile fields: `input.pasteUnmappable` and `clipboard`
 * ({read, maxBytes, ttlMs, extended}). Unknown keys are refused so a typo
 * cannot silently leave a policy at its default. */
function validTextPolicy(profile) {
  const { input, clipboard } = profile;
  if (input !== undefined && (!isObject(input) || Object.keys(input).some(key => key !== 'pasteUnmappable') ||
      !optionalBoolean(input.pasteUnmappable))) return false;
  if (clipboard === undefined) return true;
  return isObject(clipboard) &&
    Object.keys(clipboard).every(key => ['read', 'maxBytes', 'ttlMs', 'extended'].includes(key)) &&
    optionalBoolean(clipboard.read) && optionalBoolean(clipboard.extended) &&
    optionalInteger(clipboard.maxBytes, 1, 1024 * 1024) &&
    optionalInteger(clipboard.ttlMs, 1000, 86400000) &&
    (clipboard.ttlMs === undefined || clipboard.read === true);
}

/** An explicit credential-free Host route never has a VNC configuration. */
// #157: an operator-configured Host input policy, or none. The executor
// normalizes the same shape; this rejects a bad profile at load.
function validHostInput(policy) {
  if (policy === undefined) return;
  const keys = ['applications', 'operatorInput', 'operatorIdleMs'];
  const bundle = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
      Object.keys(policy).some(key => !keys.includes(key)) || !Array.isArray(policy.applications) ||
      !policy.applications.length || policy.applications.length > 16 ||
      policy.applications.some(app => typeof app !== 'string' || app.length > 255 || !bundle.test(app)) ||
      new Set(policy.applications).size !== policy.applications.length ||
      (policy.operatorInput !== undefined && !['yield', 'assert'].includes(policy.operatorInput)) ||
      (policy.operatorIdleMs !== undefined && (!Number.isSafeInteger(policy.operatorIdleMs) ||
        policy.operatorIdleMs < 0 || policy.operatorIdleMs > 10000))) {
    throw new Error('Invalid Host-only hostInput policy');
  }
}

export function validateTargetTransport(profile) {
  if (profile.transport === undefined) {
    if (profile.hostInput !== undefined) throw new Error('hostInput requires the Host-only transport');
    return false;
  }
  if (profile.transport !== 'host-only') throw new Error('Invalid target transport');
  if (typeof profile.targetId !== 'string' || !profile.targetId || !profile.hostHelper) {
    throw new Error('Host-only transport requires an explicit targetId and Host binding');
  }
  for (const key of ['vnc', 'daemonPath', 'credential', 'credentialFile', 'secrets', 'input', 'clipboard']) {
    if (Object.hasOwn(profile, key)) throw new Error(`Host-only transport forbids ${key}`);
  }
  if (profile.hostHelper.mapping !== undefined) throw new Error('Host-only transport forbids VNC mapping');
  validHostInput(profile.hostInput);
  return true;
}

export async function loadConfig(configPath) {
  const stat = await fs.stat(configPath);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid Fruitctl config size');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  if (config.schema !== 'fruitctl.config.v1' || !config.targets ||
      typeof config.targets !== 'object' || Array.isArray(config.targets)) {
    throw new Error('Expected fruitctl.config.v1 with target profiles');
  }
  for (const [name, profile] of Object.entries(config.targets)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name) || !profile ||
        typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Invalid target profile');
    if (profile.inputSource !== undefined && !validInputSource(profile.inputSource)) {
      throw new Error('Invalid target profile inputSource');
    }
    // D16/D36: provider declarations validate at load; nothing is read here.
    credentialSpec(profile, name);
    secretRefs(profile, name);
    if (!validTextPolicy(profile)) throw new Error('Invalid target profile input or clipboard policy');
    if (profile.hostHelperFile !== undefined) {
      if (profile.hostHelper !== undefined || typeof profile.hostHelperFile !== 'string' ||
          !path.isAbsolute(profile.hostHelperFile) || typeof profile.targetId !== 'string' || !profile.targetId) {
        throw new Error('Host binding requires one absolute file and an explicit targetId');
      }
      const parent = await fs.lstat(path.dirname(profile.hostHelperFile));
      if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077)) {
        throw new Error('Host binding directory must be private and user-owned');
      }
      const file = await fs.open(profile.hostHelperFile,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 65536) {
          throw new Error('Host binding must be a private user-owned regular file under 65537 bytes');
        }
        const binding = JSON.parse(await file.readFile('utf8'));
        if (!isObject(binding) || binding.schema !== 'fruitctl.host-binding.v1' ||
            binding.targetId !== profile.targetId ||
            Object.keys(binding).some(key => !['schema', 'targetId', 'hostHelper'].includes(key))) {
          throw new Error('Host binding target identity or schema mismatch');
        }
        const { normalizeHostHelperConfiguration } = await import('./host-helper.mjs');
        profile.hostHelper = normalizeHostHelperConfiguration(binding.hostHelper);
      } finally { await file.close(); }
    }
    validateTargetTransport(profile);
  }
  return config;
}
