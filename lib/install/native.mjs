// SPDX-License-Identifier: MIT
// Independent file-only Host installation. No launch, TCC or capture qualification.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, TextDecoder } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import { sha256, validateVersion, repository, releaseSchema } from './release.mjs';

const execute = promisify(execFile), decoder = new TextDecoder('utf-8', { fatal: true });
const HOST = 'FruitctlHost.app', ID = 'com.xoxd.fruitctl.host';
const MAX_JSON = 32 * 1024 * 1024, MAX_ZIP = 128 * 1024 * 1024, MAX_EXPANDED = 256 * 1024 * 1024;
const QUALIFICATION = 'file-only Host installation; no launch, privacy permission, consent retention or capture qualification';
const STRUCTURAL = 'structural-only; no Apple authentication, public install, privacy permission or runtime qualification';
const token = () => randomBytes(12).toString('hex');
const require = (condition, message) => { if (!condition) throw new Error(message); };
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const absent = file => fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const tuple = s => ({ device: String(s.dev), inode: String(s.ino), uid: Number(s.uid), mode: Number(s.mode & 0o7777n), bytes: String(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs), nlink: String(s.nlink) });
const json = bytes => JSON.parse(decoder.decode(bytes));
// A stored receipt outlives the mount that recorded it. A reboot or remount
// renumbers st_dev, and macOS attribute writes (TCC, provenance) move st_ctime
// without changing bytes. Checks against a stored tree drop exactly these two
// fields. Contents, sizes, modes, owner, inode, link count and mtime stay bound.
// Same-run checks keep the full tuple.
const VOLATILE_IDENTITY = new Set(['device', 'ctimeNs']);
const durableTree = value => object(value) && object(value.identities)
  ? { ...value, identities: Object.fromEntries(Object.entries(value.identities).map(([key, identity]) => [key, object(identity) ? Object.fromEntries(Object.entries(identity).filter(([field]) => !VOLATILE_IDENTITY.has(field))) : identity])) }
  : value;
const sameDurableTree = (actual, expected) => same(durableTree(actual), durableTree(expected));
function name(value) {
  require(typeof value === 'string' && value.length > 0 && !/[\\\x00-\x1f\x7f]/.test(value) && !value.startsWith('/') && !value.endsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe native path');
  return value;
}
function descriptor(value) { return object(value) && hex(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= MAX_EXPANDED; }
function fileMap(value) {
  require(object(value) && Object.keys(value).length > 0 && Object.keys(value).length <= 4096, 'Invalid complete Host payload map');
  for (const [key, entry] of Object.entries(value)) { name(key); require(descriptor(entry), 'Invalid Host payload descriptor'); }
  return value;
}
function sorted(value) { return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)); }

async function readFile(file, bound, uid, privateFile = false) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    require(before.isFile() && before.nlink === 1n && before.size <= BigInt(bound) && (uid === undefined || Number(before.uid) === uid), 'Expected bounded owned regular file');
    if (privateFile) require((before.mode & 0o777n) === 0o600n || (before.mode & 0o777n) === 0o400n, 'Private Host installer file has unsafe mode');
    const bytes = await handle.readFile();
    require(same(tuple(before), tuple(await handle.stat({ bigint: true }))) && same(tuple(before), tuple(await fs.lstat(file, { bigint: true }))), 'Host input changed during read');
    return bytes;
  } finally { await handle.close(); }
}

async function fetchBytes(url, fetchImpl, bound) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'fruitctl-host-installer' }, signal: AbortSignal.timeout(60_000) });
  require(response.ok && (!response.url || response.url.startsWith('https://')), 'Native release download failed');
  require(!response.headers?.get('content-length') || Number(response.headers.get('content-length')) <= bound, 'Native release response exceeds bound');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; require(size <= bound, 'Native release response exceeds bound'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}

export async function resolveHostRelease(options, dependencies = {}) {
  const version = validateVersion(options.version), base = `https://github.com/${repository}/releases/download/${version}/`;
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch, offline = options.offline;
  let bytes, digest;
  if (offline) {
    require(hex(offline.manifestSha256), 'Offline Host input requires an explicitly pinned manifest SHA-256');
    bytes = await readFile(offline.manifestPath, MAX_JSON); digest = offline.manifestSha256;
  } else {
    const metadata = json(await fetchBytes(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(version)}`, fetchImpl, 4 * 1024 * 1024));
    require(metadata.tag_name === version && metadata.draft === false, 'Native release tag mismatch or draft');
    const rows = metadata.assets?.filter(row => row.name === 'fruitctl-release.json');
    require(rows?.length === 1 && /^sha256:[a-f0-9]{64}$/.test(rows[0].digest || '') && rows[0].browser_download_url === base + 'fruitctl-release.json', 'Native release requires a unique GitHub-digested canonical manifest');
    digest = rows[0].digest.slice(7); bytes = await fetchBytes(base + 'fruitctl-release.json', fetchImpl, MAX_JSON);
  }
  require(sha256(bytes) === digest, 'Native manifest SHA-256 mismatch');
  const manifest = json(bytes);
  require(manifest.schema === releaseSchema && manifest.mode === 'native-only' && manifest.repository === repository && manifest.version === version && manifest.qualification === STRUCTURAL && manifest.nativeEvidence === 'native-evidence.json' && Array.isArray(manifest.assets), 'Expected exact native-only release identity');
  const names = new Set();
  for (const asset of manifest.assets) {
    require(/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(asset.name || '') && !names.has(asset.name) && hex(asset.sha256) && asset.url === base + asset.name && ['native', 'source', 'evidence'].includes(asset.kind), 'Invalid native release asset');
    names.add(asset.name);
  }
  const hosts = manifest.assets.filter(asset => asset.kind === 'native' && asset.component === HOST && asset.os === 'darwin' && asset.arch === 'arm64');
  const evidenceAssets = manifest.assets.filter(asset => asset.kind === 'evidence' && asset.name === manifest.nativeEvidence);
  require(hosts.length === 1 && evidenceAssets.length === 1, 'No unique Darwin ARM64 Host distribution and evidence');
  const asset = hosts[0], evidenceAsset = evidenceAssets[0];
  const evidenceBytes = offline ? await readFile(offline.evidencePath, MAX_JSON) : await fetchBytes(evidenceAsset.url, fetchImpl, MAX_JSON);
  require(sha256(evidenceBytes) === evidenceAsset.sha256, 'Native evidence SHA-256 mismatch');
  const evidence = json(evidenceBytes), rows = evidence.components?.filter(row => row.component === HOST);
  require(evidence.schemaVersion === 1 && evidence.kind === 'fruitctl-native-release-evidence' && evidence.verificationScope === STRUCTURAL && rows?.length === 1, 'Invalid unique Host evidence');
  const row = rows[0], receipts = row.receipts, distribution = receipts?.distribution?.value, sign = receipts?.sign?.value, staple = receipts?.staple?.value, notary = receipts?.notary?.value;
  require(object(sign) && object(staple) && object(notary) && ['sign', 'staple', 'notary', 'archive'].every(key => hex(receipts?.[key]?.originalSha256)), 'Concrete Host receipt hash links required');
  require(hex(sign.buildReceiptSha256) && staple.buildReceiptSha256 === sign.buildReceiptSha256 && notary.archiveReceiptSha256 === receipts.archive.originalSha256 && hex(notary.submittedArchiveSha256) && distribution?.submittedArchiveSha256 === notary.submittedArchiveSha256 && distribution.submissionArchiveReceiptSha256 === receipts.archive.originalSha256, 'Host build/submission hash links differ');
  require(typeof row.sourceArchive === 'string' && manifest.assets.filter(asset => asset.kind === 'source' && asset.name === row.sourceArchive).length === 1, 'Host corresponding-source asset is absent or ambiguous');
  const files = fileMap(distribution?.actualPostStapleFiles), signature = sign?.signature, requirement = row.identityEvidence?.designatedRequirement;
  require(row.archive === asset.name && row.archive !== row.submissionArchive && distribution?.status === 'passed' && distribution.appName === HOST && distribution.archiveSha256 === asset.sha256 && Number.isSafeInteger(distribution.archiveBytes) && distribution.archiveBytes <= MAX_ZIP && distribution.reextractedTicketValidated === true && distribution.gatekeeperNumericExit === 0, 'Host distribution chain differs');
  require(sign.status === 'passed' && sign.appName === HOST && staple?.status === 'passed' && staple.appName === HOST && same(sorted(staple.files), sorted(files)) && same(staple.signature, signature) && notary?.apple?.status === 'Accepted' && distribution.submissionId === notary.apple.id && distribution.signReceiptSha256 === receipts.sign.originalSha256 && distribution.stapleReceiptSha256 === receipts.staple.originalSha256 && distribution.acceptedNotarizationReceiptSha256 === receipts.notary.originalSha256 && staple.signReceiptSha256 === receipts.sign.originalSha256 && staple.notarizationReceiptSha256 === receipts.notary.originalSha256, 'Host sign/staple/notary chain differs');
  require(signature.identifier === ID && signature.hardenedRuntime === true && /^[A-Z0-9]{10}$/.test(signature.teamIdentifier || '') && /^[A-F0-9]{40}$/.test(signature.certificateSha1 || '') && typeof signature.timestamp === 'string' && signature.timestamp.length > 0, 'Invalid expected Host signing identity');
  require(requirement?.status === 'recorded' && typeof requirement.expression === 'string' && Buffer.byteLength(requirement.expression) <= 16384 && sha256(Buffer.from(requirement.expression)) === requirement.sha256 && same(distribution.designatedRequirement, { expression: requirement.expression, sha256: requirement.sha256 }) && requirement.expression.includes(`identifier "${ID}"`) && requirement.expression.includes(signature.teamIdentifier), 'Host designated requirement must be recorded and bound');
  require(object(row.archiveMap) && same(sorted(row.archiveMap.payloads), sorted(files)) && descriptor(row.binary) && same(row.binary, files['Contents/MacOS/FruitctlHost']), 'Host complete payload/binary map differs');
  const archive = offline ? await readFile(offline.archivePath, MAX_ZIP) : await fetchBytes(asset.url, fetchImpl, MAX_ZIP);
  require(sha256(archive) === asset.sha256 && archive.length === distribution.archiveBytes, 'Host ZIP SHA-256 or length mismatch');
  const inventory = inspectHostZip(archive, files, row.archiveMap);
  return { version, manifestSha256: digest, evidenceSha256: evidenceAsset.sha256, archiveSha256: asset.sha256, archive, files, inventory, signature, requirement: requirement.expression, signedEntitlements: { status: 'not-recorded' }, sourceArchive: row.sourceArchive };
}

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
function appleDouble(data) {
  require(data.length >= 26 && data.length <= 1024 * 1024 && data.readUInt32BE(0) === 0x00051607 && data.readUInt32BE(4) === 0x00020000, 'Invalid AppleDouble metadata');
  const count = data.readUInt16BE(24), ids = new Set(), ranges = [];
  require(count <= 32 && 26 + count * 12 <= data.length, 'Invalid AppleDouble table');
  for (let offset = 26; offset < 26 + count * 12; offset += 12) {
    const id = data.readUInt32BE(offset), start = data.readUInt32BE(offset + 4), size = data.readUInt32BE(offset + 8);
    require(!ids.has(id) && start >= 26 + count * 12 && start + size <= data.length && !ranges.some(([a, n]) => size && n && start < a + n && a < start + size), 'Invalid AppleDouble range');
    ids.add(id); ranges.push([start, size]);
  }
}
function zipExtras(bytes, start, length) {
  const end = start + length; require(end <= bytes.length, 'Truncated ZIP extra fields');
  while (start < end) {
    require(start + 4 <= end, 'Truncated ZIP extra field');
    const id = bytes.readUInt16LE(start), size = bytes.readUInt16LE(start + 2);
    // The reviewed ditto archive uses only Unix timestamp fields. Refuse
    // alternate Unicode paths, ZIP64 and unknown extractor-specific semantics.
    require(id === 0x5855 && [8, 12].includes(size) && start + 4 + size <= end, 'Unsupported ZIP extra field');
    start += 4 + size;
  }
}

// Parse and authenticate every member before allowing the system extractor to run.
export function inspectHostZip(bytes, expected, recorded) {
  fileMap(expected); require(Buffer.isBuffer(bytes) && bytes.length <= MAX_ZIP, 'Host ZIP exceeds bound');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  require(end >= 0, 'Invalid ZIP end record');
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16), length = bytes.readUInt32LE(end + 12);
  require(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0 && bytes.readUInt16LE(end + 8) === count && count > 0 && count <= 4096 && start + length === end, 'ZIP multi-disk/ZIP64 or inventory bound refused');
  const names = new Set(), ranges = [], payloads = {}, modes = {}, directories = [], directoryModes = {}, sidecars = [];
  let offset = start, total = 0;
  for (let i = 0; i < count; i++) {
    require(offset + 46 <= end && bytes.readUInt32LE(offset) === 0x02014b50, 'Invalid ZIP central header');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), crc = bytes.readUInt32LE(offset + 16), compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const nl = bytes.readUInt16LE(offset + 28), el = bytes.readUInt16LE(offset + 30), cl = bytes.readUInt16LE(offset + 32), mode = bytes.readUInt32LE(offset + 38) >>> 16, local = bytes.readUInt32LE(offset + 42);
    require(offset + 46 + nl + el + cl <= end && bytes.readUInt16LE(offset + 34) === 0 && !(flags & ~0x0808) && [0, 8].includes(method), 'ZIP encryption/flags/compression refused');
    zipExtras(bytes, offset + 46 + nl, el);
    const raw = bytes.subarray(offset + 46, offset + 46 + nl), filename = decoder.decode(raw), directory = filename.endsWith('/'), key = name(directory ? filename.slice(0, -1) : filename);
    const type = mode & 0o170000, permissions = mode & 0o7777;
    require(!names.has(key) && (directory ? [0, 0o040000].includes(type) : [0, 0o100000].includes(type)), 'Duplicate ZIP member or link/device/type refused');
    require([0o400, 0o444, 0o600, 0o644, 0o700, 0o755].includes(permissions) || directory && [0, 0o500].includes(permissions) || directory && key.startsWith('__MACOSX') && permissions === 0o775, 'Unsafe ZIP mode');
    names.add(key); total += size; require(total <= MAX_EXPANDED && (directory ? size === 0 : size <= MAX_EXPANDED), 'ZIP expanded size exceeds bound');
    require(local + 30 <= start && bytes.readUInt32LE(local) === 0x04034b50 && bytes.readUInt16LE(local + 6) === flags && bytes.readUInt16LE(local + 8) === method, 'ZIP local header differs');
    const lnl = bytes.readUInt16LE(local + 26), lel = bytes.readUInt16LE(local + 28), dataStart = local + 30 + lnl + lel, dataEnd = dataStart + compressed;
    zipExtras(bytes, local + 30 + lnl, lel);
    require(dataEnd <= start && raw.equals(bytes.subarray(local + 30, local + 30 + lnl)) && !ranges.some(([a, b]) => local < b && a < dataEnd), 'ZIP local path/range differs');
    if (!(flags & 8)) require(bytes.readUInt32LE(local + 14) === crc && bytes.readUInt32LE(local + 18) === compressed && bytes.readUInt32LE(local + 22) === size, 'ZIP local length/CRC differs');
    let recordEnd = dataEnd;
    if (flags & 8) {
      const signed = dataEnd + 4 <= start && bytes.readUInt32LE(dataEnd) === 0x08074b50, descriptor = dataEnd + (signed ? 4 : 0);
      recordEnd = descriptor + 12;
      require(recordEnd <= start && bytes.readUInt32LE(descriptor) === crc && bytes.readUInt32LE(descriptor + 4) === compressed && bytes.readUInt32LE(descriptor + 8) === size, 'ZIP data descriptor differs');
    }
    ranges.push([local, recordEnd]);
    const packed = bytes.subarray(dataStart, dataEnd), data = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, size) });
    require(data.length === size && crc32(data) === crc, 'ZIP member CRC or length differs');
    if (directory) { directories.push(key); if (key === HOST || key.startsWith(HOST + '/')) directoryModes[key === HOST ? '' : key.slice(HOST.length + 1)] = permissions; }
    else if (key.startsWith('__MACOSX/')) {
      require(path.posix.basename(key).startsWith('._'), 'Unexpected ZIP metadata'); appleDouble(data);
      sidecars.push({ name: filename, bytes: size, sha256: sha256(data) });
    } else {
      require(key.startsWith(HOST + '/'), 'Unexpected ZIP payload root');
      const relative = key.slice(HOST.length + 1); require(Object.hasOwn(expected, relative), 'Unexpected Host ZIP payload');
      payloads[relative] = { bytes: size, sha256: sha256(data) }; modes[relative] = permissions;
    }
    offset += 46 + nl + el + cl;
  }
  ranges.sort(([a], [b]) => a - b); let covered = 0;
  for (const [a, b] of ranges) { require(a === covered && b >= a, 'ZIP hidden local records or gaps refused'); covered = b; }
  require(covered === start, 'ZIP local inventory is incomplete');
  require(offset === end && same(sorted(payloads), sorted(expected)) && modes['Contents/MacOS/FruitctlHost'] & 0o100, 'ZIP differs from complete executable Host payload map');
  for (const row of sidecars) { const parts = row.name.split('/'); parts.shift(); parts[parts.length - 1] = parts.at(-1).slice(2); require(names.has(parts.join('/')), 'AppleDouble sidecar lacks counterpart'); }
  const ancestors = new Set();
  for (const key of names) if (!directories.includes(key)) { let parent = path.posix.dirname(key); while (parent !== '.') { ancestors.add(parent); parent = path.posix.dirname(parent); } }
  require(directories.every(key => ancestors.has(key)), 'Unexpected empty ZIP directory');
  const map = { payloads: sorted(payloads), AppleDoubleSidecars: sidecars.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0), directories: directories.sort() };
  require(object(recorded) && same(sorted(recorded.payloads), map.payloads) && same(recorded.AppleDoubleSidecars, map.AppleDoubleSidecars) && same(recorded.directories, map.directories), 'ZIP differs from complete release archive map');
  return { ...map, modes: sorted(modes), directoryModes: sorted(directoryModes) };
}

async function run(ctx, binary, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('DYLD_') || ['DEVELOPER_DIR', 'SDKROOT', 'TOOLCHAINS'].includes(key)) delete env[key];
  try { return await (ctx.dependencies.run || execute)(binary, args, { timeout: 20_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL', env }); }
  catch { throw new Error(`Host installer check failed: ${path.basename(binary)} ${args[0]}; prior installation retained`); }
}
async function running(ctx) {
  if (ctx.dependencies.isRunning) require(!await ctx.dependencies.isRunning(ctx.appPath), 'FruitctlHost is running; quit it locally before installation changes');
  else {
    const executable = path.join(ctx.appPath, 'Contents/MacOS/FruitctlHost');
    if (!await absent(executable)) return;
    let result;
    try { result = await (ctx.dependencies.run || execute)('/usr/sbin/lsof', ['-n', '-P', '-F', 'pu', '--', executable], { timeout: 20_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' }); }
    catch (error) { if (error.code === 1 && !error.stdout && !error.stderr) return; throw new Error('Could not determine whether the selected Host executable is in use'); }
    require(!result.stderr && /^(?:p\d+\nu\d+\n)*$/.test(result.stdout), 'Unrecognized selected Host process observation');
    require(!result.stdout, 'Selected FruitctlHost executable is in use; quit it locally before installation changes');
  }
}
async function authenticate(ctx, app, identity) {
  await run(ctx, '/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const display = await run(ctx, '/usr/bin/codesign', ['--display', '--verbose=4', app]);
  const text = display.stdout + '\n' + display.stderr;
  require(text.split('\n').includes(`Identifier=${ID}`) && text.split('\n').includes(`TeamIdentifier=${identity.signature.teamIdentifier}`) && /flags=.*\bruntime\b/.test(text) && /^Timestamp=.+$/m.test(text), 'Actual Host signing identity/runtime/timestamp differs');
  const plist = await run(ctx, '/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(app, 'Contents/Info.plist')]);
  require(plist.stdout.trim() === ID, 'Actual Host bundle identifier differs');
  const dr = await run(ctx, '/usr/bin/codesign', ['--display', '-r-', app]);
  const expressions = (dr.stdout + '\n' + dr.stderr).split('\n').filter(line => line.startsWith('designated => ')).map(line => line.slice(14));
  require(expressions.length === 1 && expressions[0] === identity.requirement, 'Actual Host designated requirement differs');
  await run(ctx, '/usr/bin/codesign', ['--verify', '--strict', '-R', '=' + identity.requirement, app]);
  const certRoot = await fs.mkdtemp(path.join(ctx.statePath, 'certificate-'));
  try {
    await run(ctx, '/usr/bin/codesign', ['--display', '--extract-certificates=' + path.join(certRoot, 'cert'), app]);
    const leaf = await readFile(path.join(certRoot, 'cert0'), 512 * 1024, ctx.uid);
    require(createHash('sha1').update(leaf).digest('hex').toUpperCase() === identity.signature.certificateSha1, 'Actual Host signing certificate differs');
  } finally { await fs.rm(certRoot, { recursive: true, force: true }); }
  await run(ctx, '/usr/bin/xcrun', ['stapler', 'validate', app]);
  const assessment = await run(ctx, '/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
  require(/(?:^|\n).*: accepted(?:\n|$)/.test(assessment.stdout + '\n' + assessment.stderr) && /source=Notarized Developer ID/.test(assessment.stdout + '\n' + assessment.stderr), 'Actual Host Gatekeeper disposition is not Notarized Developer ID');
  return { strictSignature: true, identifier: ID, team: identity.signature.teamIdentifier, certificateSha1: identity.signature.certificateSha1, designatedRequirement: identity.requirement, ticketValidated: true, gatekeeper: 'accepted; Notarized Developer ID', signedEntitlements: { status: 'not-recorded' } };
}

async function ancestors(file) {
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split('/').filter(Boolean)) { current = path.join(current, part); const s = await fs.lstat(current); require(s.isDirectory() && !s.isSymbolicLink(), 'Host installation ancestor must be a real directory'); }
}
async function context(options, dependencies) {
  const actual = { platform: process.platform, arch: process.arch, uid: process.getuid?.(), home: os.homedir(), nodeVersion: process.versions.node };
  const runtime = dependencies.runtime || actual;
  require(runtime.nodeVersion.split('.')[0] === '24', 'Host installer requires Node.js 24');
  require(runtime.platform === 'darwin' && runtime.arch === 'arm64' && Number.isInteger(runtime.uid) && runtime.uid >= 0 && (dependencies.runtime || runtime.uid > 0), 'Host installation requires Apple Silicon Darwin and an ordinary user');
  const home = await fs.realpath(runtime.home), appPath = options.appPath ?? path.join(home, 'Applications', HOST);
  require(typeof appPath === 'string' && path.isAbsolute(appPath) && path.normalize(appPath) === appPath && path.basename(appPath) === HOST && !/[\x00-\x1f\x7f\\]/.test(appPath), 'Host app path must be a canonical absolute FruitctlHost.app path');
  const parent = path.dirname(appPath), statePath = path.join(parent, '.FruitctlHost.fruitctl-install');
  return { options, dependencies, uid: runtime.uid, home, appPath, parent, statePath, receiptPath: path.join(statePath, 'current.json'), qualification: QUALIFICATION };
}
async function parent(ctx, create = false) {
  if (!await absent(ctx.parent) && create && ctx.parent === path.join(ctx.home, 'Applications')) {
    await ancestors(ctx.home); require((await fs.lstat(ctx.home)).uid === ctx.uid, 'Host home is not owned by this user');
    await fs.mkdir(ctx.parent, { mode: 0o700 });
  }
  await ancestors(ctx.parent);
  const s = await fs.lstat(ctx.parent, { bigint: true });
  require(Number(s.uid) === ctx.uid && !(s.mode & 0o022n), 'Host app parent must be owned and not group/world writable');
  const key = { device: String(s.dev), inode: String(s.ino), uid: Number(s.uid), mode: Number(s.mode & 0o7777n) };
  if (ctx.parentIdentity) require(same(key, ctx.parentIdentity), 'Host app parent identity changed'); else ctx.parentIdentity = key;
}
async function state(ctx, create = false) {
  await parent(ctx, create);
  if (!await absent(ctx.statePath)) {
    if (!create) return false;
    await fs.mkdir(ctx.statePath, { mode: 0o700 });
    const owner = { schema: 'fruitctl.host-owner.v1', id: token(), appPath: ctx.appPath, uid: ctx.uid };
    await fs.writeFile(path.join(ctx.statePath, 'owner.json'), JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 });
  }
  const s = await fs.lstat(ctx.statePath, { bigint: true });
  require(s.isDirectory() && Number(s.uid) === ctx.uid && (s.mode & 0o777n) === 0o700n, 'Host state is not a private owned real directory');
  const key = { device: String(s.dev), inode: String(s.ino) };
  if (ctx.stateIdentity) require(same(ctx.stateIdentity, key), 'Host installer state identity changed'); else ctx.stateIdentity = key;
  const bytes = await readFile(path.join(ctx.statePath, 'owner.json'), 4096, ctx.uid, true), owner = json(bytes);
  require(owner.schema === 'fruitctl.host-owner.v1' && owner.appPath === ctx.appPath && owner.uid === ctx.uid && /^[a-f0-9]{24}$/.test(owner.id), 'Foreign Host installer state');
  if (ctx.ownerSha256) require(sha256(bytes) === ctx.ownerSha256, 'Host state owner changed'); else ctx.ownerSha256 = sha256(bytes);
  ctx.owner = owner; return true;
}
async function guard(ctx) { require(await state(ctx), 'Host installer state disappeared'); }
async function locked(ctx, action) {
  await state(ctx, true);
  const lockPath = path.join(ctx.statePath, 'lock'); let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another Host installation holds the lock; no stale lock is removed automatically'); throw error; }
  const identity = tuple(await lock.stat({ bigint: true }));
  try { return await action(); }
  finally {
    await lock.close(); await guard(ctx);
    require(same(tuple(await fs.lstat(lockPath, { bigint: true })), identity), 'Host installer lock changed; retained for reconciliation');
    await fs.unlink(lockPath);
  }
}
async function tree(ctx, root) {
  const files = {}, directories = {}, identities = {}; let count = 0, total = 0;
  async function visit(file, relative) {
    const s = await fs.lstat(file, { bigint: true });
    require(Number(s.uid) === ctx.uid && !s.isSymbolicLink(), 'Host tree has foreign ownership or a symlink');
    require(++count <= 4096, 'Host tree exceeds entry bound');
    identities[relative] = tuple(s);
    if (s.isDirectory()) { directories[relative] = Number(s.mode & 0o7777n); for (const entry of (await fs.readdir(file)).sort()) { name(entry); require(!entry.includes('/'), 'Invalid Host filename'); await visit(path.join(file, entry), relative ? relative + '/' + entry : entry); } }
    else {
      require(s.isFile() && s.nlink === 1n && s.size <= BigInt(MAX_EXPANDED), 'Host tree contains a nonregular/hardlinked/oversized file');
      total += Number(s.size); require(total <= MAX_EXPANDED, 'Host tree exceeds byte bound');
      const bytes = await readFile(file, MAX_EXPANDED, ctx.uid);
      files[relative] = { bytes: bytes.length, sha256: sha256(bytes), mode: Number(s.mode & 0o7777n) };
    }
    require(same(tuple(s), tuple(await fs.lstat(file, { bigint: true }))), 'Host tree changed during inspection');
  }
  await visit(root, ''); return { files: sorted(files), directories: sorted(directories), identities: sorted(identities) };
}
function payload(tree) { return Object.fromEntries(Object.entries(tree.files).map(([key, entry]) => [key, { bytes: entry.bytes, sha256: entry.sha256 }])); }
function sameRenamedTree(actual, expected) {
  // Same-run only: our rename changes only the root's ctime, not its inode or
  // any leaf identity.
  const identities = { ...actual.identities, '': { ...actual.identities[''], ctimeNs: expected.identities[''].ctimeNs } };
  return same({ ...actual, identities }, expected);
}
// A tree read back after rename against a stored receipt tree.
const sameStoredTree = sameDurableTree;
async function current(ctx) {
  const app = await absent(ctx.appPath), receiptStat = await absent(ctx.receiptPath);
  if (!receiptStat) { require(!app, 'Foreign Host app exists without this installer receipt'); return null; }
  const receipt = json(await readFile(ctx.receiptPath, 4 * 1024 * 1024, ctx.uid, true));
  require(receipt.schema === 'fruitctl.host-install.v1' && receipt.ownerId === ctx.owner.id && receipt.appPath === ctx.appPath && /^[a-f0-9]{64}$/.test(receipt.cacheKey) && object(receipt.tree), 'Invalid Host install receipt');
  require(app && app.isDirectory() && sameDurableTree(await tree(ctx, ctx.appPath), receipt.tree), 'Installed Host drift; refusing mutation');
  const selected = await cache(ctx, receipt.cacheKey);
  require(selected.entry.version === receipt.version && selected.entry.manifestSha256 === receipt.manifestSha256 && selected.entry.archiveSha256 === receipt.archiveSha256 && same(selected.entry.tree.files, receipt.tree.files) && same(selected.entry.tree.directories, receipt.tree.directories), 'Host receipt/cache identity differs');
  return receipt;
}
async function atomicJson(ctx, file, value, expectedPin) {
  await guard(ctx); const tmp = path.join(ctx.statePath, 'receipt-' + token());
  try { await fs.writeFile(tmp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); await guard(ctx); await checkReceipt(ctx, expectedPin); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }); }
}
async function receiptPin(ctx) {
  if (!await absent(ctx.receiptPath)) return null;
  const bytes = await readFile(ctx.receiptPath, 4 * 1024 * 1024, ctx.uid, true);
  return { sha256: sha256(bytes), identity: tuple(await fs.lstat(ctx.receiptPath, { bigint: true })) };
}
async function checkReceipt(ctx, expected) { require(same(await receiptPin(ctx), expected), 'Host receipt changed; refusing replacement or recovery adoption'); }
async function cache(ctx, key) {
  require(hex(key), 'Invalid Host cache key');
  const root = path.join(ctx.statePath, 'cache-' + key), stat = await fs.lstat(root);
  require(stat.isDirectory() && stat.uid === ctx.uid && (stat.mode & 0o777) === 0o700, 'Host cache must be a private owned real directory');
  const entry = json(await readFile(path.join(root, 'entry.json'), 4 * 1024 * 1024, ctx.uid, true));
  require(entry.cacheKey === key && entry.schema === 'fruitctl.host-cache.v1' && hex(entry.archiveSha256) && hex(entry.manifestSha256) && hex(entry.evidenceSha256) && sha256(Buffer.from(entry.version + '\n' + entry.archiveSha256)) === key, 'Invalid Host cache receipt');
  validateVersion(entry.version);
  require(sameDurableTree(await tree(ctx, path.join(root, HOST)), entry.tree), 'Cached Host drift; refusing reuse');
  return { root, entry };
}
async function prepare(ctx, release) {
  const key = sha256(Buffer.from(release.version + '\n' + release.archiveSha256)), root = path.join(ctx.statePath, 'cache-' + key);
  const priorCaches = (await fs.readdir(ctx.statePath)).filter(name => /^cache-[a-f0-9]{64}$/.test(name));
  require(priorCaches.length < 64 || priorCaches.includes('cache-' + key), 'Host cache version limit reached; no caches are removed automatically');
  for (const prior of priorCaches) {
    const stat = await fs.lstat(path.join(ctx.statePath, prior));
    require(stat.isDirectory() && stat.uid === ctx.uid && (stat.mode & 0o777) === 0o700, 'Foreign Host cache directory');
    const entry = json(await readFile(path.join(ctx.statePath, prior, 'entry.json'), 4 * 1024 * 1024, ctx.uid, true));
    require(entry.schema === 'fruitctl.host-cache.v1', 'Invalid prior Host cache receipt');
    if (entry.version === release.version) require(prior === 'cache-' + key && entry.manifestSha256 === release.manifestSha256 && entry.evidenceSha256 === release.evidenceSha256, 'Immutable Host release version changed');
  }
  if (await absent(root)) {
    const found = await cache(ctx, key);
    require(found.entry.archiveSha256 === release.archiveSha256 && found.entry.manifestSha256 === release.manifestSha256 && found.entry.evidenceSha256 === release.evidenceSha256, 'Immutable Host cache conflicts with selected release');
    return found;
  }
  const work = await fs.mkdtemp(path.join(ctx.statePath, 'download-')); let moved = false, rootCreated = false;
  try {
    const zip = path.join(work, 'Host.zip'), extracted = path.join(work, 'extracted');
    await fs.writeFile(zip, release.archive, { flag: 'wx', mode: 0o400 }); await fs.mkdir(extracted, { mode: 0o700 });
    await run(ctx, '/usr/bin/ditto', ['-x', '-k', zip, extracted]);
    require(same((await fs.readdir(extracted)).sort(), [HOST]), 'Extractor produced unexpected top-level files');
    const app = path.join(extracted, HOST), before = await tree(ctx, app);
    require(same(payload(before), sorted(release.files)) && Object.entries(before.files).every(([key, value]) => value.mode === release.inventory.modes[key]), 'Extracted Host files or modes differ');
    const expectedDirectories = new Set(['']);
    for (const file of Object.keys(release.files)) { let directory = path.posix.dirname(file); while (directory !== '.') { expectedDirectories.add(directory); directory = path.posix.dirname(directory); } }
    require(same(Object.keys(before.directories).sort(), [...expectedDirectories].sort()) && Object.entries(release.inventory.directoryModes).every(([key, mode]) => before.directories[key] === mode), 'Extracted Host directory map or modes differ');
    const verification = await authenticate(ctx, app, release);
    require(same(before, await tree(ctx, app)), 'Host changed during Apple verification');
    await guard(ctx); await fs.mkdir(root, { mode: 0o700 }); rootCreated = true; await guard(ctx); await fs.rename(app, path.join(root, HOST));
    const entry = { schema: 'fruitctl.host-cache.v1', cacheKey: key, version: release.version, manifestSha256: release.manifestSha256, evidenceSha256: release.evidenceSha256, archiveSha256: release.archiveSha256, signature: release.signature, requirement: release.requirement, sourceArchive: release.sourceArchive, verification, tree: await tree(ctx, path.join(root, HOST)) };
    await fs.writeFile(path.join(root, 'entry.json'), JSON.stringify(entry) + '\n', { flag: 'wx', mode: 0o400 }); moved = true;
    return { root, entry };
  } finally { await guard(ctx); await fs.rm(work, { recursive: true, force: true }); if (!moved && rootCreated) await fs.rm(root, { recursive: true, force: true }); }
}
async function replace(ctx, selected, previous, action) {
  const work = await fs.mkdtemp(path.join(ctx.statePath, 'transaction-')), next = path.join(work, HOST), prior = path.join(work, 'previous.app');
  let oldMoved = false, newMoved = false, committed = false, recovered = false, recoveryUnconfirmed = false, staged, installedTree;
  const oldBytes = previous ? await readFile(ctx.receiptPath, 4 * 1024 * 1024, ctx.uid, true) : null;
  const oldPin = await receiptPin(ctx);
  require(previous ? same(json(oldBytes), previous) && oldPin !== null : oldPin === null, 'Host receipt changed before transaction');
  try {
    await run(ctx, '/usr/bin/ditto', [path.join(selected.root, HOST), next]);
    staged = await tree(ctx, next);
    require(same(staged.files, selected.entry.tree.files) && same(staged.directories, selected.entry.tree.directories), 'Staged Host copy differs');
    const verification = await authenticate(ctx, next, selected.entry);
    require(same(staged, await tree(ctx, next)), 'Host staged copy changed during verification');
    await guard(ctx); require(same(await current(ctx), previous), 'Current Host receipt changed'); await running(ctx);
    if (previous) { await fs.rename(ctx.appPath, prior); oldMoved = true; }
    await guard(ctx); require(!await absent(ctx.appPath), 'Host app appeared during replacement'); await fs.rename(next, ctx.appPath); newMoved = true;
    const installed = await tree(ctx, ctx.appPath);
    require(sameRenamedTree(installed, staged), 'Installed Host differs from staged bytes or identity');
    installedTree = installed;
    await ctx.dependencies.beforeCommit?.();
    require(same(installedTree, await tree(ctx, ctx.appPath)), 'New Host changed before receipt commit');
    const receipt = { schema: 'fruitctl.host-install.v1', ownerId: ctx.owner.id, appPath: ctx.appPath, cacheKey: selected.entry.cacheKey, version: selected.entry.version, previousCacheKey: previous?.cacheKey ?? null, manifestSha256: selected.entry.manifestSha256, archiveSha256: selected.entry.archiveSha256, tree: installedTree, verification, qualification: QUALIFICATION };
    await atomicJson(ctx, ctx.receiptPath, receipt, oldPin); committed = true;
    return { action, status: 'installed', appPath: ctx.appPath, version: receipt.version, previousVersionAvailable: !!receipt.previousCacheKey, verification, qualification: QUALIFICATION };
  } catch (error) {
    if (!committed) {
      try {
        await guard(ctx); await checkReceipt(ctx, oldPin);
        if (newMoved) { const installed = await tree(ctx, ctx.appPath); require(installedTree ? same(installed, installedTree) : sameRenamedTree(installed, staged), 'Changed new Host retained for reconciliation'); await fs.rename(ctx.appPath, next); }
        if (oldMoved) {
          const restored = await tree(ctx, prior);
          require(sameStoredTree(restored, previous.tree), 'Prior Host changed; refusing recovery adoption');
          require(!await absent(ctx.appPath), 'Foreign Host prevents recovery'); await fs.rename(prior, ctx.appPath);
        }
        if (oldBytes) { const old = json(oldBytes), restored = await tree(ctx, ctx.appPath); require(sameStoredTree(restored, old.tree), 'Restored Host differs from prior receipt'); old.tree = restored; await atomicJson(ctx, ctx.receiptPath, old, oldPin); }
        recovered = true;
      } catch (recovery) { error.message += `; recovery unconfirmed: ${recovery.message}; retained ${work}`; recoveryUnconfirmed = true; }
    }
    throw error;
  } finally { if (!recoveryUnconfirmed && (committed || recovered || !oldMoved && !newMoved)) { await guard(ctx); await fs.rm(work, { recursive: true, force: true }); } }
}

export async function install(options = {}, dependencies = {}) {
  const ctx = await context(options, dependencies); validateVersion(options.version);
  if (options.dryRun) return { action: 'install', status: 'planned', version: options.version, appPath: ctx.appPath, statePath: ctx.statePath, qualification: QUALIFICATION };
  await parent(ctx, true); await running(ctx);
  require(!await absent(ctx.appPath) || await absent(ctx.statePath), 'Foreign Host app exists without installer state');
  const release = await resolveHostRelease(options, dependencies);
  return locked(ctx, async () => {
    const previous = await current(ctx), selected = await prepare(ctx, release);
    if (previous?.cacheKey === selected.entry.cacheKey) return { action: 'install', status: 'unchanged', version: previous.version, appPath: ctx.appPath, qualification: QUALIFICATION };
    return replace(ctx, selected, previous, 'install');
  });
}
export async function doctor(options = {}, dependencies = {}) {
  const ctx = await context(options, dependencies);
  try {
    if (!await absent(ctx.parent)) return { action: 'doctor', status: 'not-installed', appPath: ctx.appPath, qualification: QUALIFICATION };
    if (!await state(ctx)) { require(!await absent(ctx.appPath), 'Foreign Host app exists without installer state'); return { action: 'doctor', status: 'not-installed', appPath: ctx.appPath, qualification: QUALIFICATION }; }
    const receipt = await current(ctx); if (!receipt) return { action: 'doctor', status: 'not-installed', appPath: ctx.appPath, qualification: QUALIFICATION };
    const selected = await cache(ctx, receipt.cacheKey);
    require(selected.entry.version === receipt.version && selected.entry.manifestSha256 === receipt.manifestSha256 && selected.entry.archiveSha256 === receipt.archiveSha256 && same(selected.entry.tree.files, receipt.tree.files), 'Host receipt/cache identity differs');
    return { action: 'doctor', status: 'installed', version: receipt.version, appPath: ctx.appPath, qualification: QUALIFICATION, appleAuthentication: 'recorded at installation; not repeated by doctor', signedEntitlements: { status: 'not-recorded' } };
  } catch (error) { return { action: 'doctor', status: 'drift', appPath: ctx.appPath, reason: error.message, qualification: QUALIFICATION }; }
}
export async function rollback(options = {}, dependencies = {}) {
  const ctx = await context(options, dependencies);
  if (options.dryRun) return { action: 'rollback', status: 'planned', appPath: ctx.appPath, statePath: ctx.statePath, qualification: QUALIFICATION };
  require(await state(ctx), 'No owned Host installation'); await running(ctx);
  return locked(ctx, async () => { const previous = await current(ctx); require(previous?.previousCacheKey, 'No previous verified Host version'); return replace(ctx, await cache(ctx, previous.previousCacheKey), previous, 'rollback'); });
}
export async function uninstall(options = {}, dependencies = {}) {
  const ctx = await context(options, dependencies);
  if (options.dryRun) return { action: 'uninstall', status: 'planned', appPath: ctx.appPath, statePath: ctx.statePath, qualification: QUALIFICATION };
  if (!await absent(ctx.parent) || !await state(ctx)) { require(!await absent(ctx.appPath), 'Foreign Host app exists without installer state'); return { action: 'uninstall', status: 'not-installed', appPath: ctx.appPath, qualification: QUALIFICATION }; }
  await running(ctx);
  return locked(ctx, async () => {
    const receipt = await current(ctx); if (!receipt) return { action: 'uninstall', status: 'not-installed', appPath: ctx.appPath, qualification: QUALIFICATION };
    const oldPin = await receiptPin(ctx);
    const moved = path.join(ctx.statePath, 'removed-' + token()), history = path.join(ctx.statePath, 'removed-' + token() + '.json');
    await guard(ctx); await running(ctx); require(same(await current(ctx), receipt), 'Host changed before removal');
    await fs.rename(ctx.appPath, moved);
    try { await guard(ctx); await checkReceipt(ctx, oldPin); await fs.rename(ctx.receiptPath, history); }
    catch (error) { await checkReceipt(ctx, oldPin); const restored = await tree(ctx, moved); require(sameStoredTree(restored, receipt.tree), 'Prior Host changed; retained for uninstall recovery'); require(!await absent(ctx.appPath), 'Foreign Host prevents uninstall recovery'); await fs.rename(moved, ctx.appPath); const returned = await tree(ctx, ctx.appPath); require(sameStoredTree(returned, receipt.tree), 'Restored Host differs from prior receipt'); receipt.tree = returned; await atomicJson(ctx, ctx.receiptPath, receipt, oldPin); throw error; }
    const snapshot = await tree(ctx, moved); require(sameStoredTree(snapshot, receipt.tree), 'Removed Host changed; retained for reconciliation');
    await fs.rm(moved, { recursive: true });
    return { action: 'uninstall', status: 'removed', appPath: ctx.appPath, retainedVerifiedCaches: true, qualification: QUALIFICATION };
  });
}
