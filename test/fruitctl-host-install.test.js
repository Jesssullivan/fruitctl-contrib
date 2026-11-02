import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync, crc32 } from 'node:zlib';
import { install, doctor, rollback, uninstall, resolveHostRelease, inspectHostZip } from '../lib/install/native.mjs';
import { sha256 } from '../lib/install/release.mjs';

const HOST = 'FruitctlHost.app', ID = 'com.xoxd.fruitctl.host', TEAM = 'ABCDEFGHIJ';
const CERT = Buffer.from('Synthetic public certificate fixture; never a private key');
const CERT_SHA = createHash('sha1').update(CERT).digest('hex').toUpperCase();
const REQUIREMENT = `identifier "${ID}" and anchor apple generic and certificate leaf[subject.OU] = "${TEAM}"`;
const QUALIFICATION = 'structural-only; no Apple authentication, public install, privacy permission or runtime qualification';

// Ordinary independently serialized ZIP fixtures, with central/local headers,
// UNIX modes, compression and the platform zlib CRC implementation.
function zip(entries, { prefix = Buffer.alloc(0), gap = Buffer.alloc(0) } = {}) {
  const local = [prefix], central = []; let offset = prefix.length;
  for (const entry of entries) {
    const filename = Buffer.from(entry.name), data = entry.data || Buffer.alloc(0), packed = deflateRawSync(data), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(entry.flags || 0, 6); header.writeUInt16LE(8, 8); header.writeUInt32LE(entry.flags & 8 ? 0 : crc, 14); header.writeUInt32LE(entry.flags & 8 ? 0 : packed.length, 18); header.writeUInt32LE(entry.flags & 8 ? 0 : data.length, 22); header.writeUInt16LE(filename.length, 26);
    const row = Buffer.alloc(46); row.writeUInt32LE(0x02014b50); row.writeUInt16LE(0x0314, 4); row.writeUInt16LE(20, 6); row.writeUInt16LE(entry.flags || 0, 8); row.writeUInt16LE(8, 10); row.writeUInt32LE(crc, 16); row.writeUInt32LE(packed.length, 20); row.writeUInt32LE(data.length, 24); row.writeUInt16LE(filename.length, 28); row.writeUInt32LE(((entry.mode || (entry.name.endsWith('/') ? 0o040755 : 0o100644)) << 16) >>> 0, 38); row.writeUInt32LE(offset, 42);
    const descriptor = Buffer.alloc(entry.flags & 8 ? entry.unsignedDescriptor ? 12 : 16 : 0);
    if (descriptor.length) { const start = descriptor.length === 16 ? 4 : 0; if (start) descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, start); descriptor.writeUInt32LE(packed.length, start + 4); descriptor.writeUInt32LE(data.length, start + 8); }
    local.push(header, filename, packed, descriptor); central.push(row, filename); offset += header.length + filename.length + packed.length + descriptor.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset + gap.length, 16);
  return Buffer.concat([...local, gap, directory, end]);
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-host-install-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); await fs.mkdir(home, { mode: 0o700 });
  const f = { root, home, appPath: path.join(home, 'Applications', HOST), archives: new Map(), calls: [], running: false, failure: null };
  f.dependencies = {
    // Explicit test-only injection. Production has no environment/CLI bypass.
    runtime: { platform: 'darwin', arch: 'arm64', uid: process.getuid(), home, nodeVersion: '24.21.0' },
    isRunning: async () => f.running,
    run: async (binary, args, limits) => {
      f.calls.push({ binary, args, limits });
      if (f.failure === args[0] || f.failure === binary) throw new Error('Synthetic numeric failure');
      if (binary === '/usr/bin/ditto') {
        if (args[0] === '-x') {
          const release = f.archives.get(sha256(await fs.readFile(args[2]))); assert.ok(release);
          const app = path.join(args[3], HOST); await fs.mkdir(app, { mode: 0o755 });
          for (const [name, file] of Object.entries(release.payloads)) { const dest = path.join(app, name); await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o755 }); await fs.writeFile(dest, file.data, { mode: file.mode }); await fs.chmod(dest, file.mode); }
        } else await fs.cp(args[0], args[1], { recursive: true });
      }
      if (binary === '/usr/bin/codesign' && args.some(arg => arg.startsWith('--extract-certificates'))) {
        // codesign's optional long-option argument must be attached with '=';
        // a separate prefix becomes another positional application argument.
        assert.equal(args.length, 3); assert.equal(args[0], '--display');
        assert.ok(args[1].startsWith('--extract-certificates='));
        const prefix = args[1].slice('--extract-certificates='.length);
        assert.ok(path.isAbsolute(prefix)); assert.equal(path.basename(args[2]), HOST);
        await fs.writeFile(prefix + '0', CERT, { mode: 0o600 });
      }
      if (binary === '/usr/bin/codesign' && args.includes('--verbose=4')) return { stdout: '', stderr: `Identifier=${f.actualID || ID}\nTeamIdentifier=${f.actualTeam || TEAM}\nflags=0x10000(runtime)\nTimestamp=Oct 11, 2026\n` };
      if (binary === '/usr/bin/codesign' && args.includes('-r-')) return { stdout: `designated => ${f.actualRequirement || REQUIREMENT}\n`, stderr: '' };
      if (binary === '/usr/libexec/PlistBuddy') return { stdout: ID + '\n', stderr: '' };
      if (binary === '/usr/sbin/spctl') return { stdout: '', stderr: `${args.at(-1)}: accepted\nsource=Notarized Developer ID\n` };
      return { stdout: '', stderr: '' };
    },
  };
  return f;
}

async function release(f, version = 'v0.1.0-private.1', change = () => {}) {
  const root = await fs.mkdtemp(path.join(f.root, 'release-'));
  const payloads = {
    'Contents/Info.plist': { data: Buffer.from(`fixture plist ${ID}`), mode: 0o644 },
    'Contents/MacOS/FruitctlHost': { data: Buffer.from('Synthetic inert Host ' + version), mode: 0o755 },
    'Contents/_CodeSignature/CodeResources': { data: Buffer.from('signature resources'), mode: 0o644 },
    'Contents/CodeResources': { data: Buffer.from('stapled ticket fixture'), mode: 0o644 },
  };
  const files = Object.fromEntries(Object.entries(payloads).map(([name, file]) => [name, { sha256: sha256(file.data), bytes: file.data.length }]));
  const directories = [HOST, HOST + '/Contents', HOST + '/Contents/MacOS', HOST + '/Contents/_CodeSignature', '__MACOSX', '__MACOSX/' + HOST, '__MACOSX/' + HOST + '/Contents'];
  const metadata = Buffer.alloc(26); metadata.writeUInt32BE(0x00051607); metadata.writeUInt32BE(0x00020000, 4);
  const sidecarName = '__MACOSX/' + HOST + '/Contents/._Info.plist';
  const entries = [...directories.map(name => ({ name: name + '/', mode: (name.startsWith('__MACOSX') ? 0o040775 : 0o040755) })), ...Object.entries(payloads).map(([name, file]) => ({ name: HOST + '/' + name, data: file.data, mode: 0o100000 | file.mode })), { name: sidecarName, data: metadata, mode: 0o100644 }];
  const archive = zip(entries), archiveName = 'Host-distribution.zip', base = `https://github.com/xoxd-ai/fruitctl/releases/download/${version}/`;
  const signature = { identifier: ID, teamIdentifier: TEAM, certificateSha1: CERT_SHA, hardenedRuntime: true, timestamp: 'Oct 11, 2026' };
  const requirement = { expression: REQUIREMENT, sha256: sha256(Buffer.from(REQUIREMENT)) };
  const row = {
    component: HOST, archive: archiveName, submissionArchive: 'Host-submission.zip', sourceArchive: 'Host-source.tar.gz', binary: files['Contents/MacOS/FruitctlHost'],
    archiveMap: { payloads: files, AppleDoubleSidecars: [{ name: sidecarName, bytes: metadata.length, sha256: sha256(metadata) }], directories: directories.sort() },
    identityEvidence: { designatedRequirement: { status: 'recorded', ...requirement }, signedEntitlements: { status: 'not-recorded' } },
    receipts: {
      sign: { originalSha256: '1'.repeat(64), value: { status: 'passed', appName: HOST, signature, buildReceiptSha256: '5'.repeat(64) } },
      staple: { originalSha256: '2'.repeat(64), value: { status: 'passed', appName: HOST, files, signature, buildReceiptSha256: '5'.repeat(64), signReceiptSha256: '1'.repeat(64), notarizationReceiptSha256: '3'.repeat(64) } },
      archive: { originalSha256: '4'.repeat(64) },
      notary: { originalSha256: '3'.repeat(64), value: { archiveReceiptSha256: '4'.repeat(64), submittedArchiveSha256: '6'.repeat(64), apple: { status: 'Accepted', id: '279a03c9-894e-48f9-8772-d9aef1412493' } } },
      distribution: { value: { status: 'passed', appName: HOST, actualPostStapleFiles: files, archiveSha256: sha256(archive), archiveBytes: archive.length, reextractedTicketValidated: true, gatekeeperNumericExit: 0, designatedRequirement: requirement, submissionId: '279a03c9-894e-48f9-8772-d9aef1412493', signReceiptSha256: '1'.repeat(64), stapleReceiptSha256: '2'.repeat(64), acceptedNotarizationReceiptSha256: '3'.repeat(64), submittedArchiveSha256: '6'.repeat(64), submissionArchiveReceiptSha256: '4'.repeat(64) } },
    },
  };
  const evidence = { schemaVersion: 1, kind: 'fruitctl-native-release-evidence', verificationScope: QUALIFICATION, components: [row] };
  const evidenceBytes = Buffer.from(JSON.stringify(evidence));
  const manifest = { schema: 'fruitctl.release.v1', repository: 'xoxd-ai/fruitctl', mode: 'native-only', version, qualification: QUALIFICATION, nativeEvidence: 'native-evidence.json', assets: [
    { kind: 'native', component: HOST, os: 'darwin', arch: 'arm64', name: archiveName, url: base + archiveName, sha256: sha256(archive) },
    { kind: 'evidence', name: 'native-evidence.json', url: base + 'native-evidence.json', sha256: sha256(evidenceBytes) },
    { kind: 'source', name: 'Host-source.tar.gz', url: base + 'Host-source.tar.gz', sha256: '7'.repeat(64) },
  ] };
  const r = { version, archive, manifest, evidence, row, entries, payloads, files, root };
  change(r);
  const finalEvidence = Buffer.from(JSON.stringify(r.evidence)); r.manifest.assets.find(row => row.name === 'native-evidence.json').sha256 = sha256(finalEvidence);
  const manifestBytes = Buffer.from(JSON.stringify(r.manifest));
  const archivePath = path.join(root, archiveName), manifestPath = path.join(root, 'fruitctl-release.json'), evidencePath = path.join(root, 'native-evidence.json');
  await fs.writeFile(archivePath, r.archive); await fs.writeFile(manifestPath, manifestBytes); await fs.writeFile(evidencePath, finalEvidence);
  r.offline = { archivePath, manifestPath, evidencePath, manifestSha256: sha256(manifestBytes) };
  f.archives.set(sha256(r.archive), r); return r;
}
const options = (f, r, rest = {}) => ({ version: r.version, offline: r.offline, appPath: f.appPath, ...rest });
const executable = f => path.join(f.appPath, 'Contents/MacOS/FruitctlHost');

test('a real stable app lifecycle preserves modes, rolls back actual two versions, and retains caches on removal', async t => {
  const f = await fixture(t), a = await release(f), b = await release(f, 'v0.1.0-private.2');
  assert.equal((await install(options(f, a), f.dependencies)).status, 'installed');
  assert.equal((await fs.lstat(f.appPath)).isSymbolicLink(), false);
  assert.equal((await fs.stat(executable(f))).mode & 0o777, 0o755);
  assert.equal((await doctor({ appPath: f.appPath }, f.dependencies)).status, 'installed');
  assert.equal((await install(options(f, a), f.dependencies)).status, 'unchanged');
  await install(options(f, b), f.dependencies);
  assert.equal((await rollback({ appPath: f.appPath }, f.dependencies)).version, a.version);
  assert.deepEqual(await fs.readFile(executable(f)), a.payloads['Contents/MacOS/FruitctlHost'].data);
  assert.equal((await rollback({ appPath: f.appPath }, f.dependencies)).version, b.version);
  assert.equal((await uninstall({ appPath: f.appPath }, f.dependencies)).status, 'removed');
  assert.equal((await doctor({ appPath: f.appPath }, f.dependencies)).status, 'not-installed');
  const state = path.join(path.dirname(f.appPath), '.FruitctlHost.fruitctl-install');
  assert.equal((await fs.readdir(state)).filter(name => name.startsWith('cache-')).length, 2);
  await install(options(f, a), f.dependencies);
  const installed = JSON.parse(await fs.readFile(path.join(state, 'current.json')));
  assert.deepEqual(installed.verification.signedEntitlements, { status: 'not-recorded' });
  assert.ok(f.calls.every(call => call.limits.timeout <= 20_000 && call.limits.maxBuffer <= 1024 * 1024));
  const allowedTools = new Set(['/usr/bin/ditto', '/usr/bin/codesign', '/usr/libexec/PlistBuddy', '/usr/bin/xcrun', '/usr/sbin/spctl']);
  assert.deepEqual(new Set(f.calls.map(call => call.binary)), allowedTools);
  for (const { binary, args } of f.calls) {
    assert.ok(allowedTools.has(binary), 'Only fixed extraction and read-only Apple checks are allowed');
    if (binary === '/usr/bin/codesign') {
      assert.ok(['--display', '--verify'].includes(args[0]));
      assert.ok(args.every(arg => !['--sign', '-s', '--force', '-f', '--remove-signature'].includes(arg)));
      if (args.some(arg => arg.startsWith('--extract-certificates'))) {
        assert.equal(args.length, 3); assert.ok(args[1].startsWith('--extract-certificates='));
      }
    } else if (binary === '/usr/bin/ditto') {
      assert.ok(args[0] === '-x' ? args.length === 4 && args[1] === '-k' && args.slice(2).every(path.isAbsolute) : args.length === 2 && args.every(path.isAbsolute));
    } else if (binary === '/usr/libexec/PlistBuddy') assert.deepEqual(args.slice(0, 2), ['-c', 'Print :CFBundleIdentifier']);
    else if (binary === '/usr/bin/xcrun') assert.deepEqual(args.slice(0, 2), ['stapler', 'validate']);
    else if (binary === '/usr/sbin/spctl') assert.deepEqual(args.slice(0, 4), ['--assess', '--type', 'execute', '--verbose=4']);
  }
});

// A reboot or remount renumbers st_dev, and macOS attribute writes move the
// bundle root's ctime. Rewrite the stored receipt and cache trees the way such
// a restart leaves them.
async function remounted(f) {
  const state = path.join(path.dirname(f.appPath), '.FruitctlHost.fruitctl-install'), receiptPath = path.join(state, 'current.json');
  const shift = tree => { for (const identity of Object.values(tree.identities)) identity.device = String(BigInt(identity.device) + 7n); tree.identities[''].ctimeNs = String(BigInt(tree.identities[''].ctimeNs) + 1n); };
  const receipt = JSON.parse(await fs.readFile(receiptPath)); shift(receipt.tree); await fs.writeFile(receiptPath, JSON.stringify(receipt) + '\n');
  const entryPath = path.join(state, 'cache-' + receipt.cacheKey, 'entry.json');
  await fs.chmod(entryPath, 0o600); const entry = JSON.parse(await fs.readFile(entryPath)); shift(entry.tree);
  await fs.writeFile(entryPath, JSON.stringify(entry) + '\n'); await fs.chmod(entryPath, 0o400);
}

test('a post-reboot device and root ctime change keeps the install upgradable and rollback intact', async t => {
  const f = await fixture(t), a = await release(f), b = await release(f, 'v0.1.0-private.2');
  await install(options(f, a), f.dependencies); await remounted(f);
  assert.equal((await doctor({ appPath: f.appPath }, f.dependencies)).status, 'installed');
  assert.equal((await install(options(f, b), f.dependencies)).status, 'installed');
  assert.deepEqual(await fs.readFile(executable(f)), b.payloads['Contents/MacOS/FruitctlHost'].data);
  await remounted(f);
  assert.equal((await rollback({ appPath: f.appPath }, f.dependencies)).version, a.version);
  assert.deepEqual(await fs.readFile(executable(f)), a.payloads['Contents/MacOS/FruitctlHost'].data);
});

test('after a remount a same-size content change is still drift and is not replaced', async t => {
  const f = await fixture(t), a = await release(f), b = await release(f, 'v0.1.0-private.2');
  await install(options(f, a), f.dependencies); await remounted(f);
  const bytes = await fs.readFile(executable(f)); bytes[0] ^= 1; await fs.writeFile(executable(f), bytes);
  assert.equal((await doctor({ appPath: f.appPath }, f.dependencies)).status, 'drift');
  await assert.rejects(install(options(f, b), f.dependencies), /Installed Host drift/);
  assert.deepEqual(await fs.readFile(executable(f)), bytes);
});

test('after a remount a mode change is still drift and is not replaced', async t => {
  const f = await fixture(t), a = await release(f), b = await release(f, 'v0.1.0-private.2');
  await install(options(f, a), f.dependencies); await remounted(f);
  await fs.chmod(executable(f), 0o700);
  assert.equal((await doctor({ appPath: f.appPath }, f.dependencies)).status, 'drift');
  await assert.rejects(install(options(f, b), f.dependencies), /Installed Host drift/);
  assert.equal((await fs.stat(executable(f))).mode & 0o777, 0o700);
});

test('certificate extraction attaches its optional prefix and verifies the extracted public leaf', async t => {
  const f = await fixture(t), r = await release(f);
  const result = await install(options(f, r), f.dependencies);
  const extractions = f.calls.filter(call => call.binary === '/usr/bin/codesign' && call.args.some(arg => arg.startsWith('--extract-certificates')));
  assert.equal(extractions.length, 2); // Verified download cache and real-path staged copy.
  for (const { args } of extractions) {
    assert.equal(args.length, 3); assert.equal(args[0], '--display');
    assert.match(args[1], /^--extract-certificates=\//); assert.equal(path.basename(args[2]), HOST);
  }
  assert.equal(result.verification.certificateSha1, CERT_SHA);
});

test('dry-run performs no network or writes; production refuses Linux, wrong Node and root contexts', async t => {
  const f = await fixture(t), before = await fs.readdir(f.home);
  const dependencies = { ...f.dependencies, fetchImpl: () => { throw new Error('Must not fetch'); } };
  for (const command of [install, rollback, uninstall]) assert.equal((await command({ version: 'v1.0.0', appPath: f.appPath, dryRun: true }, dependencies)).status, 'planned');
  assert.deepEqual(await fs.readdir(f.home), before); assert.equal(f.calls.length, 0);
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.getuid() === 0) await assert.rejects(install({ version: 'v1.0.0', dryRun: true }), /Apple Silicon Darwin|ordinary user/);
  await assert.rejects(install({ version: 'latest', dryRun: true }, dependencies), /exact release tag/);
  await assert.rejects(install({ version: 'v1.0.0', dryRun: true }, { ...dependencies, runtime: { ...dependencies.runtime, nodeVersion: '22.0.0' } }), /Node.js 24/);
});

test('selection refuses runtime, submission, controller, duplicate component and unpinned offline inputs', async t => {
  const f = await fixture(t);
  for (const [label, change] of [
    ['runtime', r => { r.manifest.mode = 'runtime'; }],
    ['controller', r => { r.manifest.assets[0].component = 'claude-kvm-daemon'; }],
    ['submission', r => { r.row.archive = r.row.submissionArchive; }],
    ['duplicate component', r => { r.evidence.components.push(r.row); }],
    ['wrong repository', r => { r.manifest.repository = 'foreign/fruitctl'; }],
    ['foreign URL', r => { r.manifest.assets[0].url = 'https://example.com/Host.zip'; }],
    ['missing both hash links', r => { delete r.row.receipts.sign.originalSha256; delete r.row.receipts.distribution.value.signReceiptSha256; }],
    ['missing source asset', r => { r.manifest.assets = r.manifest.assets.filter(asset => asset.kind !== 'source'); }],
  ]) await t.test(label, async () => { const r = await release(f, 'v1.0.0', change); await assert.rejects(resolveHostRelease(options(f, r), f.dependencies)); });
  const r = await release(f); await assert.rejects(resolveHostRelease({ ...options(f, r), offline: { ...r.offline, manifestSha256: null } }, f.dependencies), /explicitly pinned/);
  await fs.appendFile(r.offline.archivePath, 'changed'); await assert.rejects(install(options(f, r), f.dependencies), /ZIP SHA-256/);
  assert.equal(f.calls.length, 0); assert.equal(await fs.stat(f.appPath).catch(() => null), null);
});

test('online resolution authenticates GitHub manifest digest before downloading selected distribution', async t => {
  const f = await fixture(t), r = await release(f), base = `https://github.com/xoxd-ai/fruitctl/releases/download/${r.version}/`;
  const requests = [], replies = new Map([
    [`https://api.github.com/repos/xoxd-ai/fruitctl/releases/tags/${r.version}`, Buffer.from(JSON.stringify({ tag_name: r.version, draft: false, assets: [{ name: 'fruitctl-release.json', digest: 'sha256:' + r.offline.manifestSha256, browser_download_url: base + 'fruitctl-release.json' }] }))],
    [base + 'fruitctl-release.json', await fs.readFile(r.offline.manifestPath)],
    [base + 'native-evidence.json', await fs.readFile(r.offline.evidencePath)], [base + 'Host-distribution.zip', r.archive],
  ]);
  const fetchImpl = async (url, request) => { requests.push(url); assert.ok(request.signal); return new Response(replies.get(url), { status: replies.has(url) ? 200 : 404 }); };
  assert.equal((await resolveHostRelease({ version: r.version }, { fetchImpl })).archiveSha256, sha256(r.archive));
  assert.equal(requests.length, 4); assert.ok(!requests.some(url => url.includes('submission')));
  replies.set(base + 'fruitctl-release.json', Buffer.from('{}')); requests.length = 0;
  await assert.rejects(resolveHostRelease({ version: r.version }, { fetchImpl }), /manifest SHA-256/); assert.equal(requests.length, 2);
});

test('complete ZIP authentication rejects path escapes, symlinks, duplicates, bad modes, inline metadata and content drift', async t => {
  const f = await fixture(t), r = await release(f);
  assert.doesNotThrow(() => inspectHostZip(r.archive, r.files, r.row.archiveMap));
  for (const [label, change] of [
    ['escape', entries => { entries.push({ name: '../outside', data: Buffer.from('x') }); }],
    ['link', entries => { entries.find(row => row.name.endsWith('/Info.plist')).mode = 0o120777; }],
    ['duplicate', entries => { entries.push(entries.find(row => row.name.endsWith('/Info.plist'))); }],
    ['nonexecutable', entries => { entries.find(row => row.name.endsWith('/FruitctlHost')).mode = 0o100644; }],
    ['inline AppleDouble', entries => { entries.at(-1).name = HOST + '/Contents/._Info.plist'; }],
    ['payload content', entries => { entries.find(row => row.name.endsWith('/Info.plist')).data = Buffer.from('changed'); }],
    ['encrypted', entries => { entries.at(-1).flags = 1; }],
  ]) await t.test(label, () => { const entries = r.entries.map(row => ({ ...row })); change(entries); assert.throws(() => inspectHostZip(zip(entries), r.files, r.row.archiveMap)); });
  for (const unsignedDescriptor of [false, true]) {
    const entries = r.entries.map(row => ({ ...row, flags: 8, unsignedDescriptor }));
    assert.doesNotThrow(() => inspectHostZip(zip(entries), r.files, r.row.archiveMap));
  }
  assert.throws(() => inspectHostZip(zip(r.entries, { prefix: Buffer.from('hidden prefix') }), r.files, r.row.archiveMap), /gaps/);
  assert.throws(() => inspectHostZip(zip(r.entries, { gap: Buffer.from('hidden local record') }), r.files, r.row.archiveMap), /local inventory/);
  const descriptorZip = zip(r.entries.map(row => ({ ...row, flags: 8 })));
  const centralStart = descriptorZip.readUInt32LE(descriptorZip.length - 6); descriptorZip[centralStart - 12] ^= 1;
  assert.throws(() => inspectHostZip(descriptorZip, r.files, r.row.archiveMap), /data descriptor/);
});

test('identity, requirement, certificate, ticket and Gatekeeper failures leave an existing app intact', async t => {
  const f = await fixture(t), a = await release(f), b = await release(f, 'v0.1.0-private.2'); await install(options(f, a), f.dependencies);
  const before = await fs.readFile(executable(f));
  for (const [key, value] of [['actualTeam', 'XXXXXXXXXX'], ['actualID', 'foreign.host'], ['actualRequirement', 'identifier "foreign.host"'], ['failure', '/usr/bin/xcrun'], ['failure', '/usr/sbin/spctl']]) {
    f[key] = value; await assert.rejects(install(options(f, b), f.dependencies)); delete f[key];
    assert.deepEqual(await fs.readFile(executable(f)), before); assert.equal((await doctor({ appPath: f.appPath }, f.dependencies)).status, 'installed');
  }
  const badCertificate = { ...f.dependencies, run: async (binary, args, limits) => { const result = await f.dependencies.run(binary, args, limits); const extraction = args.find(arg => arg.startsWith('--extract-certificates=')); if (extraction) await fs.writeFile(extraction.slice('--extract-certificates='.length) + '0', 'wrong certificate'); return result; } };
  await assert.rejects(install(options(f, b), badCertificate), /signing certificate/); assert.deepEqual(await fs.readFile(executable(f)), before);
});

test('foreign app, aliases, live selected app, file drift, cache drift and lock cannot be adopted', async t => {
  const f = await fixture(t), r = await release(f);
  await fs.mkdir(path.dirname(f.appPath), { mode: 0o700 }); await fs.mkdir(f.appPath);
  await assert.rejects(install(options(f, r), f.dependencies), /Foreign Host/); await fs.rmdir(f.appPath);
  await fs.symlink(f.home, f.appPath); await assert.rejects(install(options(f, r), f.dependencies), /Foreign Host/); await fs.unlink(f.appPath);
  await install(options(f, r), f.dependencies);
  f.running = true; await assert.rejects(uninstall({ appPath: f.appPath }, f.dependencies), /running/); f.running = false;
  await fs.appendFile(executable(f), 'drift'); assert.equal((await doctor({ appPath: f.appPath }, f.dependencies)).status, 'drift');
  await assert.rejects(uninstall({ appPath: f.appPath }, f.dependencies), /drift/);
});

test('failed update recovers prior bytes and receipt; mutated prior/new copies are retained without adoption', async t => {
  const f = await fixture(t), a = await release(f), b = await release(f, 'v0.1.0-private.2'); await install(options(f, a), f.dependencies);
  const failed = { ...f.dependencies, beforeCommit: async () => { throw new Error('Synthetic commit failure'); } };
  await assert.rejects(install(options(f, b), failed), /Synthetic commit failure/);
  assert.deepEqual(await fs.readFile(executable(f)), a.payloads['Contents/MacOS/FruitctlHost'].data); assert.equal((await doctor({ appPath: f.appPath }, f.dependencies)).status, 'installed');
  const state = path.join(path.dirname(f.appPath), '.FruitctlHost.fruitctl-install');
  assert.equal((await fs.readdir(state)).filter(name => name.startsWith('transaction-')).length, 0);
  const corruptPrior = { ...f.dependencies, beforeCommit: async () => {
    const transaction = (await fs.readdir(state)).find(name => name.startsWith('transaction-'));
    await fs.appendFile(path.join(state, transaction, 'previous.app/Contents/MacOS/FruitctlHost'), 'drift'); throw new Error('Fault after prior drift');
  } };
  await assert.rejects(install(options(f, b), corruptPrior), /recovery unconfirmed.*Prior Host changed/);
  assert.equal((await doctor({ appPath: f.appPath }, f.dependencies)).status, 'drift');
  assert.equal((await fs.readdir(state)).filter(name => name.startsWith('transaction-')).length, 1);
});

test('same-byte foreign tree swaps are retained rather than adopted during failed update recovery', async t => {
  for (const selected of ['prior', 'new']) await t.test(selected, async t => {
    const f = await fixture(t), a = await release(f), b = await release(f, 'v0.1.0-private.2'); await install(options(f, a), f.dependencies);
    const state = path.join(path.dirname(f.appPath), '.FruitctlHost.fruitctl-install');
    let changedPath, retainedPath, originalInode;
    const swapped = { ...f.dependencies, beforeCommit: async () => {
      const transaction = path.join(state, (await fs.readdir(state)).find(name => name.startsWith('transaction-')));
      changedPath = selected === 'prior' ? path.join(transaction, 'previous.app') : f.appPath;
      retainedPath = path.join(transaction, selected + '-original.app');
      originalInode = (await fs.lstat(changedPath, { bigint: true })).ino;
      await fs.rename(changedPath, retainedPath); await fs.cp(retainedPath, changedPath, { recursive: true });
      assert.notEqual((await fs.lstat(changedPath, { bigint: true })).ino, originalInode);
      assert.deepEqual(await fs.readFile(path.join(changedPath, 'Contents/MacOS/FruitctlHost')), await fs.readFile(path.join(retainedPath, 'Contents/MacOS/FruitctlHost')));
      throw new Error('Fault after same-byte root swap');
    } };
    await assert.rejects(install(options(f, b), swapped), selected === 'prior' ? /recovery unconfirmed.*Prior Host changed/ : /recovery unconfirmed.*Changed new Host/);
    assert.equal((await fs.lstat(retainedPath, { bigint: true })).ino, originalInode);
    assert.equal((await doctor({ appPath: f.appPath }, f.dependencies)).status, 'drift');
    assert.equal((await fs.readdir(state)).filter(name => name.startsWith('transaction-')).length, 1);
    assert.deepEqual(await fs.readFile(path.join(changedPath, 'Contents/MacOS/FruitctlHost')), (selected === 'prior' ? a : b).payloads['Contents/MacOS/FruitctlHost'].data);
  });
});

test('immutable same-version release changes, private state/cache symlinks and held locks are refused', async t => {
  const f = await fixture(t), a = await release(f); await install(options(f, a), f.dependencies);
  const altered = await release(f, a.version, r => { r.manifest.assets.push({ kind: 'source', name: 'extra.tar.gz', url: `https://github.com/xoxd-ai/fruitctl/releases/download/${a.version}/extra.tar.gz`, sha256: 'a'.repeat(64) }); });
  await assert.rejects(install(options(f, altered), f.dependencies), /Immutable Host release version changed/);
  const state = path.join(path.dirname(f.appPath), '.FruitctlHost.fruitctl-install');
  await fs.writeFile(path.join(state, 'lock'), 'held', { mode: 0o600 }); await assert.rejects(install(options(f, a), f.dependencies), /holds the lock/); await fs.unlink(path.join(state, 'lock'));
  const receipt = JSON.parse(await fs.readFile(path.join(state, 'current.json'))), cached = path.join(state, 'cache-' + receipt.cacheKey), moved = cached + '-retained';
  await fs.rename(cached, moved); await fs.symlink(moved, cached);
  assert.equal((await doctor({ appPath: f.appPath }, f.dependencies)).status, 'drift');
  await assert.rejects(install(options(f, a), f.dependencies), /cache .*directory/);
});

test('a foreign receipt replacement during commit is not overwritten or adopted in recovery', async t => {
  const f = await fixture(t), a = await release(f), b = await release(f, 'v0.1.0-private.2'); await install(options(f, a), f.dependencies);
  const state = path.join(path.dirname(f.appPath), '.FruitctlHost.fruitctl-install'), receiptPath = path.join(state, 'current.json');
  const foreign = Buffer.from('{"foreign":"do not overwrite"}\n');
  const changed = { ...f.dependencies, beforeCommit: async () => { await fs.writeFile(receiptPath, foreign); } };
  await assert.rejects(install(options(f, b), changed), /receipt changed.*recovery unconfirmed/);
  assert.deepEqual(await fs.readFile(receiptPath), foreign);
  assert.equal((await fs.readdir(state)).filter(name => name.startsWith('transaction-')).length, 1);
});

test('failed initial commit with changed installed bytes retains recovery artifacts and reports drift', async t => {
  const f = await fixture(t), r = await release(f);
  const changed = { ...f.dependencies, beforeCommit: async () => { await fs.appendFile(executable(f), 'concurrent changed bytes'); throw new Error('Commit fault'); } };
  await assert.rejects(install(options(f, r), changed), /recovery unconfirmed.*Changed new Host/);
  assert.equal((await doctor({ appPath: f.appPath }, f.dependencies)).status, 'drift');
  const state = path.join(path.dirname(f.appPath), '.FruitctlHost.fruitctl-install');
  assert.equal((await fs.readdir(state)).filter(name => name.startsWith('transaction-')).length, 1);
  assert.match(await fs.readFile(executable(f), 'utf8'), /concurrent changed bytes/);
});
