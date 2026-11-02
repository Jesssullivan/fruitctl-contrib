// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Offline checks for the attended freshness probe runner (TIN-5509). A fake
// controller speaks the native NDJSON protocol, reads the credential frame on
// descriptor 3 and writes [RFB-WIRE] lines. No VNC server, native binary or
// desktop is involved, and every schedule is shortened (non-qualifying).
const probe = new URL('./fruitctl-freshness-probe.py', import.meta.url).pathname;
const SECRET = 'offline-probe-secret-0f3c';
const USERNAME = 'offline-probe-user';

const fakeDaemon = String.raw`#!/usr/bin/env python3
import base64, hashlib, json, os, struct, sys, time, zlib
started = time.monotonic()
argv = sys.argv[1:]
if argv[-2:] != ["--password-fd", "3"] or "--rfb-wire-ledger" not in argv or "VNC_PASSWORD" in os.environ:
    sys.exit(4)
mode = argv[argv.index("--rfb-request-mode") + 1]
length = struct.unpack("!I", os.read(3, 4))[0]
if hashlib.sha256(os.read(3, length)).hexdigest() != os.environ["FAKE_CREDENTIAL_SHA256"]:
    sys.exit(3)
scene = os.environ.get("FAKE_SCENE", "static")
# Connection index across controller processes, for the pixel scenes.
connection = 0
if os.environ.get("FAKE_STATE"):
    try:
        connection = int(open(os.environ["FAKE_STATE"]).read())
    except OSError:
        pass
    open(os.environ["FAKE_STATE"], "w").write(str(connection + 1))
def png(marks):
    # 96x53 RGB, filter 0, black except the marked pixels.
    rows = [bytearray(96 * 3) for _ in range(53)]
    for (x, y), value in marks.items():
        rows[y][x * 3:x * 3 + 3] = bytes([value]) * 3
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    data = zlib.compress(b"".join(b"\0" + bytes(row) for row in rows))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 96, 53, 8, 2, 0, 0, 0)) +
            chunk(b"IDAT", data) + chunk(b"IEND", b""))
def pixels():
    # The menu-bar band is x 70-89, y 0-5. "fade": the indicator is mid-fade
    # for 1.5 s after each connection. "band": the second connection's
    # indicator differs for good. "outside": it also differs outside the band.
    marks = {(80, 2): 255}
    if scene == "fade" and time.monotonic() - started < 1.5:
        marks[(80, 2)] = 128
    if scene in ("band", "outside") and connection == 1:
        marks[(80, 2)] = 64
    if scene == "outside" and connection == 1:
        marks[(10, 30)] = 200
    return png(marks)
def out(message):
    sys.stdout.write(json.dumps(message) + "\n"); sys.stdout.flush()
def wire(incremental, origin):
    sys.stderr.write("[RFB-WIRE] ms=1 dir=c2s type=3 incremental=%d length=10 origin=%s\n" % (incremental, origin))
    sys.stderr.flush()
wire(0, "libvnc-init")
out({"method": "vnc_state", "params": {"state": "connected (96x53)"}})
out({"method": "ready", "params": {"scaledWidth": 96, "scaledHeight": 53}})
count = 0
for line in sys.stdin:
    request = json.loads(line)
    if request["method"] == "health":
        out({"id": request["id"], "result": {"detail": "connected (96x53)", "connectionGeneration": 1, "allocation": 1}})
        continue
    if request["method"] != "screenshot":
        sys.exit(9)  # Observation only: anything else is a runner defect.
    count += 1
    if scene != "missingwire":
        wire(0, "bridge")
    if scene == "extrawire":
        wire(0, "bridge")
    if scene == "malformed-stdout":
        sys.stdout.write("{bad}\n"); sys.stdout.flush(); sys.exit(0)
    if scene == "truncated-stdout":
        sys.stdout.write('{"id":'); sys.stdout.flush(); sys.exit(0)
    if scene == "oversized-stderr":
        sys.stderr.write("x" * 65537 + "\n"); sys.stderr.flush()
    if scene == "stale":
        out({"id": request["id"], "error": {"code": -32010,
             "message": "No fresh complete framebuffer update within 5 seconds",
             "data": {"reason": "server_silent", "diagnostics": {"request_gate_leaks": 0, "unanswered_full_requests": 1}}}})
        continue
    if mode == "stream":
        wire(1, "libvnc-rearm")
    if scene == "leak":
        sys.stderr.write("[VNC t] Request gate reopened by the server; closed again\n"); sys.stderr.flush()
    if scene in ("fade", "band", "outside"):
        body = pixels()
    else:
        body = b"\x89PNG\r\n\x1a\n" + (b"frame%d" % count if scene == "changing" else b"static")
    out({"id": request["id"], "result": {"image": base64.b64encode(body).decode(), "scaledWidth": 96,
         "scaledHeight": 53, "connectionGeneration": 1, "allocation": 1,
         "provenance": {"source": "in_session", "request_mode": mode,
                        "requests": {"full": 1, "incremental": 1 if mode == "stream" else 0}}}})
if scene == "tailwire":
    # An unassigned final wire request, including an unterminated stderr tail.
    sys.stderr.write("[RFB-WIRE] ms=1 dir=c2s type=3 incremental=0 length=10 origin=bridge")
    sys.stderr.flush()
`;

const SHORT = ['--gap-seconds', '0', '--idle-seconds', '0', '--long-idle-seconds', '0',
  '--warm-captures', '2', '--idle-captures', '1', '--long-idle-captures', '1',
  '--ctl-captures', '2', '--eq-captures', '2', '--eq-gap-seconds', '0', '--eq-settle-seconds', '0'];

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), 'fp-'));
  const daemon = path.join(dir, 'claude-kvm-daemon');
  writeFileSync(daemon, fakeDaemon, { mode: 0o755 });
  const bytes = readFileSync(daemon);
  const receipt = path.join(dir, 'build-receipt.json');
  writeFileSync(receipt, JSON.stringify({ status: 'passed', sourceRevision: 'a'.repeat(40),
    unstrippedUnsignedArtifacts: { 'claude-kvm-daemon': {
      sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length } } }));
  return { dir, daemon, receipt };
}

function runProbe(args, { env = {}, input = '' } = {}) {
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || tmpdir(),
    VNC_HOST: '127.0.0.1', VNC_PORT: '15900', VNC_USERNAME: USERNAME, VNC_PASSWORD: SECRET,
    FAKE_CREDENTIAL_SHA256: createHash('sha256').update(SECRET).digest('hex'), ...env };
  const result = spawnSync('python3', ['-I', '-B', probe, ...args], {
    env: environment, input, encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 20 });
  assert.equal(result.error, undefined);
  return result;
}

function outputFiles(dir) {
  return readdirSync(dir).map(name => readFileSync(path.join(dir, name), 'utf8'));
}

function receiptOf(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'freshness-probe-receipt.json'), 'utf8'));
}

test('dry run prints schedule and argv, verifies the build receipt and never prints the credential', () => {
  const w = workspace();
  try {
    const result = runProbe(['--probe', 'P1', '--daemon', w.daemon, '--build-receipt', w.receipt, '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /build receipt verified; sourceRevision a{40}/);
    assert.match(result.stdout, /--rfb-request-mode on-demand --rfb-wire-ledger --no-reconnect -v --password-fd 3$/m);
    assert.match(result.stdout, /schedule \(17 captures, at least 1890 s of waiting\)/);
    assert.equal((result.stdout.match(/ warm /g) || []).length, 10);
    assert.equal((result.stdout.match(/ idle /g) || []).length, 5);
    assert.equal((result.stdout.match(/ long-idle /g) || []).length, 2);
    assert.match(result.stdout, /credential: <redacted>/);
    assert.ok(!result.stdout.includes(SECRET) && !result.stderr.includes(SECRET));
    const p0 = runProbe(['--probe', 'P0', '--daemon', w.daemon, '--dry-run']);
    assert.match(p0.stdout, /--rfb-request-mode stream /);
    assert.match(p0.stdout, /schedule \(15 captures, at least 690 s of waiting\)/);
    const ctl = runProbe(['--probe', 'P-ctl', '--daemon', w.daemon, '--dry-run']);
    assert.equal(ctl.status, 2);
    assert.match(ctl.stderr, /needs --mode/);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('artifact and credential refusals happen before any connection', () => {
  const w = workspace();
  try {
    writeFileSync(w.receipt, JSON.stringify({ status: 'passed', unstrippedUnsignedArtifacts: {
      'claude-kvm-daemon': { sha256: '0'.repeat(64), bytes: 1 } } }));
    const mismatch = runProbe(['--probe', 'P0', '--daemon', w.daemon, '--build-receipt', w.receipt, '--dry-run']);
    assert.equal(mismatch.status, 2);
    assert.match(mismatch.stderr, /REFUSED: daemon does not match the build receipt/);

    chmodSync(w.daemon, 0o644);
    const out = path.join(w.dir, 'out');
    const noExec = runProbe(['--probe', 'P0', '--daemon', w.daemon, '--output-dir', out, ...SHORT]);
    assert.equal(noExec.status, 2);
    assert.match(noExec.stderr, /upload-artifact drops the exec bit.*chmod 0755/);
    assert.throws(() => readdirSync(out), /ENOENT/);
    chmodSync(w.daemon, 0o755);

    const secret = path.join(w.dir, 'credential');
    writeFileSync(secret, `${SECRET}\n`, { mode: 0o644 });
    const config = path.join(w.dir, 'config.json');
    writeFileSync(config, JSON.stringify({ schema: 'fruitctl.config.v1', targets: { pzm: {
      vnc: { host: '127.0.0.1', port: 15900, username: USERNAME, requestMode: 'stream' }, credentialFile: secret } } }));
    const env = { VNC_PASSWORD: '' };
    const open = runProbe(['--probe', 'P1', '--daemon', w.daemon, '--profile', 'pzm', '--config', config, '--dry-run'], { env });
    assert.equal(open.status, 2);
    assert.match(open.stderr, /private file/);
    chmodSync(secret, 0o600);
    const profile = runProbe(['--probe', 'P1', '--daemon', w.daemon, '--profile', 'pzm', '--config', config, '--dry-run'], { env });
    assert.equal(profile.status, 0, profile.stderr);
    assert.match(profile.stdout, /target from profile:pzm/);
    assert.match(profile.stdout, /profile requestMode 'stream' is overridden/);
    assert.ok(!profile.stdout.includes(SECRET));

    const missing = runProbe(['--probe', 'P0', '--daemon', w.daemon, '--dry-run'], { env: { VNC_PASSWORD: undefined } });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /no credential/);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('P0 and P1 pass against a fresh fake controller and keep only hashes', () => {
  const w = workspace();
  try {
    for (const [arm, mode] of [['P0', 'stream'], ['P1', 'on-demand']]) {
      const out = path.join(w.dir, arm);
      const result = runProbe(['--probe', arm, '--daemon', w.daemon, '--build-receipt', w.receipt,
        '--output-dir', out, ...SHORT]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const receipt = receiptOf(out);
      assert.equal(receipt.mode, mode);
      assert.deepEqual(receipt.verdict, { result: 'PASS', reasons: [], qualifying: false });
      assert.equal(receipt.sourceRevision, 'a'.repeat(40));
      assert.equal(receipt.captures.length, arm === 'P0' ? 3 : 4);
      for (const capture of receipt.captures) {
        assert.equal(capture.ok, true);
        assert.match(capture.sha256, /^[0-9a-f]{64}$/);
        assert.equal(capture.ledger.fullRequests, 1);
        assert.equal(capture.provenance.request_mode, mode);
        assert.ok(capture.latency_ms < 5000);
      }
      assert.equal(receipt.sessions[0].exitCode, 0);
      assert.equal(receipt.sessions[0].ledger.inputLines, 0);
      assert.ok(receipt.argv.includes('<redacted>'));
      assert.ok(readdirSync(out).includes('rfb-wire-ledger.s0.txt'));
      assert.ok(!readdirSync(out).some(name => name.endsWith('.png')), 'no image without --save-images');
      for (const text of outputFiles(out)) assert.ok(!text.includes(SECRET) && !text.includes(USERNAME));
    }
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

const delayedLedger = String.raw`
import importlib.util, json, os, pathlib, sys, threading, time
spec = importlib.util.spec_from_file_location('owned_probe', pathlib.Path(sys.argv[1]))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
class DelayedLedgerSession(probe.DaemonSession):
    def __init__(self, *args, **kwargs):
        self.allow_stderr = threading.Event()
        self.screenshots = 0
        super().__init__(*args, **kwargs)
    # Reproduce a scheduler pause of the former independent stderr reader.
    # A coordinated reader cannot pause stderr independently of its replies.
    def _stderr(self):
        if not self.allow_stderr.wait(5):
            raise RuntimeError('fixture never reached its second screenshot')
        super()._stderr()
    def rpc(self, method, timeout):
        if method == 'screenshot':
            self.screenshots += 1
            if self.screenshots == 2:
                self.allow_stderr.set()
        return super().rpc(method, timeout)
output = pathlib.Path(sys.argv[3]); output.mkdir()
argv = [sys.argv[2], '--rfb-request-mode', 'on-demand', '--rfb-wire-ledger', '--password-fd', '3']
session = DelayedLedgerSession(0, argv, b'owned-repro-fixture', time.monotonic, output, 2)
records = []
try:
    session.await_ready()
    for index in range(2):
        records.append(probe.observe(session, index, {'phase': 'warm', 'session': 0, 'waitSeconds': 0},
            0, {'capture_timeout': 2, 'save_images': False}, output))
finally:
    session.allow_stderr.set()
    session.close()
probe.attribute_ledger(records, [session])
print(json.dumps({'fullRequests': [r['ledger']['fullRequests'] for r in records],
                  'wireTotal': probe.summarize_ledger(session.ledger)['fullBridge'],
                  'ok': [r['ok'] for r in records], 'exit': session.process.returncode}))
`;

test('a paused stderr reader cannot move one warm request into the next capture', () => {
  const w = workspace();
  try {
    const result = spawnSync('python3', ['-I', '-B', '-c', delayedLedger, probe, w.daemon,
      path.join(w.dir, 'delayed')], { encoding: 'utf8', timeout: 10000,
      env: { PATH: process.env.PATH,
        FAKE_CREDENTIAL_SHA256: createHash('sha256').update('owned-repro-fixture').digest('hex') } });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.ok, [true, true]);
    assert.equal(report.wireTotal, 2);
    assert.equal(report.exit, 0);
    assert.deepEqual(report.fullRequests, [1, 1]);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('wire attribution independently refuses missing, extra and trailing requests', () => {
  const w = workspace();
  try {
    for (const [scene, requests] of [['missingwire', 0], ['extrawire', 2], ['tailwire', 1]]) {
      const out = path.join(w.dir, scene);
      const result = runProbe(['--probe', 'P1', '--daemon', w.daemon, '--output-dir', out, ...SHORT],
        { env: { FAKE_SCENE: scene } });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const receipt = receiptOf(out);
      assert.equal(receipt.verdict.result, 'FAIL');
      assert.deepEqual(receipt.captures.map(capture => capture.ledger.fullRequests), Array(4).fill(requests));
      assert.ok(receipt.captures.every(capture => capture.provenance.requests.full === 1),
        'independent wire evidence must disagree with the unchanged self-reported count');
      assert.equal(receipt.sessions[0].exitCode, 0);
      if (scene === 'tailwire') {
        assert.equal(receipt.sessions[0].ledger.fullBridge, 5);
        assert.match(receipt.verdict.reasons[0], /5 full wire requests, 4 assigned/);
      }
    }
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('the coordinated reader refuses malformed and incomplete stdout and oversized stderr', () => {
  const w = workspace();
  try {
    for (const scene of ['malformed-stdout', 'truncated-stdout', 'oversized-stderr']) {
      const result = runProbe(['--probe', 'P1', '--daemon', w.daemon, '--output-dir', path.join(w.dir, scene),
        ...SHORT], { env: { FAKE_SCENE: scene } });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const receipt = receiptOf(path.join(w.dir, scene));
      assert.equal(receipt.verdict.result, 'FAIL');
      assert.ok(receipt.captures.some(capture => !capture.ok));
    }
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('typed stale_screen and gate leaks are probe failures, not crashes', () => {
  const w = workspace();
  try {
    const stale = path.join(w.dir, 'stale');
    const result = runProbe(['--probe', 'P1', '--daemon', w.daemon, '--output-dir', stale, ...SHORT],
      { env: { FAKE_SCENE: 'stale' } });
    assert.equal(result.status, 1, result.stderr);
    const receipt = receiptOf(stale);
    assert.equal(receipt.verdict.result, 'FAIL');
    assert.ok(receipt.captures.every(c => !c.ok && c.reason === 'stale_screen:server_silent'));
    assert.equal(receipt.captures[0].errorCode, -32010);
    assert.equal(receipt.captures[0].diagnostics.request_gate_leaks, 0);
    assert.equal(receipt.sessions[0].exitCode, 0);

    const leak = path.join(w.dir, 'leak');
    runProbe(['--probe', 'P1', '--daemon', w.daemon, '--output-dir', leak, ...SHORT], { env: { FAKE_SCENE: 'leak' } });
    assert.ok(receiptOf(leak).verdict.reasons.includes('request_gate_leaks == 4, expected 0'));
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('P-ctl needs each capture to change; P-eq compares against a new connection', () => {
  const w = workspace();
  try {
    const changing = path.join(w.dir, 'ctl-changing');
    const pass = runProbe(['--probe', 'P-ctl', '--mode', 'on-demand', '--daemon', w.daemon, '--output-dir', changing,
      ...SHORT], { env: { FAKE_SCENE: 'changing' }, input: '\n\n' });
    assert.equal(pass.status, 0, pass.stdout);
    assert.equal((pass.stdout.match(/Change the screen by hand/g) || []).length, 2);
    const still = path.join(w.dir, 'ctl-static');
    const fail = runProbe(['--probe', 'P-ctl', '--mode', 'stream', '--daemon', w.daemon, '--output-dir', still,
      ...SHORT], { input: '\n\n' });
    assert.equal(fail.status, 1);
    assert.match(receiptOf(still).verdict.reasons[0], /byte-identical/);
    const closed = path.join(w.dir, 'ctl-closed');
    const eof = runProbe(['--probe', 'P-ctl', '--mode', 'stream', '--daemon', w.daemon, '--output-dir', closed, ...SHORT]);
    assert.equal(eof.status, 1);
    assert.ok(receiptOf(closed).verdict.reasons.some(reason => reason.includes('operator prompt closed')));

    const eq = path.join(w.dir, 'eq');
    const same = runProbe(['--probe', 'P-eq', '--mode', 'on-demand', '--daemon', w.daemon, '--output-dir', eq,
      '--save-images', ...SHORT]);
    assert.equal(same.status, 0, same.stdout);
    const receipt = receiptOf(eq);
    assert.deepEqual(receipt.captures.map(c => c.session), [0, 0, 1, 1]);
    assert.deepEqual(receipt.captures.map(c => c.phase), ['eq-static', 'eq-static', 'eq-new-connection',
      'eq-new-connection-settled']);
    assert.equal(receipt.eqComparison.decidedBy, 'settled-sha256');
    assert.equal(receipt.sessions.length, 2);
    assert.equal(readdirSync(eq).filter(name => name.endsWith('.png')).length, 4);
    const moving = path.join(w.dir, 'eq-moving');
    runProbe(['--probe', 'P-eq', '--mode', 'stream', '--daemon', w.daemon, '--output-dir', moving, ...SHORT],
      { env: { FAKE_SCENE: 'changing' } });
    assert.ok(receiptOf(moving).verdict.reasons.some(reason => reason.includes('not static')));
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('P-eq settles each new connection and can ignore a status-menu band', () => {
  const w = workspace();
  try {
    const eqRun = (name, scene, extra = []) => {
      const out = path.join(w.dir, name);
      const result = runProbe(['--probe', 'P-eq', '--mode', 'on-demand', '--daemon', w.daemon, '--output-dir', out,
        ...SHORT, ...extra], { env: { FAKE_SCENE: scene, FAKE_STATE: path.join(w.dir, `${name}.state`) } });
      return { result, receipt: receiptOf(out), out };
    };
    // The immediate frame catches the indicator mid-fade; the settled one matches.
    const fade = eqRun('fade', 'fade', ['--eq-settle-seconds', '2.5']);
    assert.equal(fade.result.status, 0, fade.result.stdout);
    const fc = fade.receipt.eqComparison;
    assert.equal(fc.decidedBy, 'settled-sha256');
    assert.equal(fc.equal, true);
    assert.equal(fc.immediate.sha256Equal, false);
    assert.equal(fc.settled.sha256Equal, true);
    assert.notEqual(fc.immediate.sha256, fc.settled.sha256);
    // Pixels stay in memory: the differing pixel is located, nothing is saved.
    assert.deepEqual(fc.immediate.pixels, { equal: false, diffBox: [80, 2, 81, 3], imageSize: [96, 53] });
    assert.equal(fade.receipt.schedule.eq_settle_seconds, 2.5);
    assert.equal(fade.receipt.schedule.conformsToDesign, false);
    assert.equal(fade.receipt.eqComparison.static, true);
    assert.ok(!readdirSync(fade.out).some(name => name.endsWith('.png')));
    assert.match(fade.result.stdout, /P-eq decided by settled-sha256/);

    // A lasting indicator difference fails on hashes, passes outside the band.
    const band = eqRun('band', 'band');
    assert.equal(band.result.status, 1);
    assert.match(band.receipt.verdict.reasons[0], /differs from the settled capture of a new connection \(decided by settled-sha256\)/);
    const ignored = eqRun('band-ignored', 'band', ['--eq-ignore-rect', '70,0,20,6']);
    assert.equal(ignored.result.status, 0, ignored.result.stdout);
    const ic = ignored.receipt.eqComparison;
    assert.deepEqual(ic.ignoreRect, [70, 0, 20, 6]);
    assert.equal(ic.decidedBy, 'settled-pixels-outside-ignore-rect');
    assert.deepEqual(ic.settled.pixels, { equal: true, diffBox: [80, 2, 81, 3], imageSize: [96, 53],
      ignoreBoxPixels: [70, 0, 90, 6] });
    assert.deepEqual(ignored.receipt.schedule.eq_ignore_rect, [70, 0, 20, 6]);
    const outside = eqRun('outside', 'outside', ['--eq-ignore-rect', '70,0,20,6']);
    assert.equal(outside.result.status, 1);
    assert.equal(outside.receipt.eqComparison.decidedBy, 'settled-pixels-outside-ignore-rect');
    assert.deepEqual(outside.receipt.eqComparison.settled.pixels.diffBox, [10, 2, 81, 31]);

    const settle = runProbe(['--probe', 'P-eq', '--mode', 'stream', '--daemon', w.daemon, '--dry-run']);
    assert.match(settle.stdout, /schedule \(5 captures, at least 12 s of waiting\)/);
    assert.match(settle.stdout, /eq-new-connection-settled\s+wait 4 s/);
    assert.match(settle.stdout, /no ignore band \(sha256 equality only\)/);
    for (const bad of ['1,2,3', '1,2,0,4', '-1,0,2,2', 'a,b,c,d']) {
      const refused = runProbe(['--probe', 'P-eq', '--mode', 'stream', '--daemon', w.daemon, '--dry-run',
        '--eq-ignore-rect', bad]);
      assert.equal(refused.status, 2, bad);
      assert.match(refused.stderr, /--eq-ignore-rect/);
    }
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

// The stdlib-only PNG decoder against small generated PNGs, every filter type.
const pngUnit = String.raw`
import importlib.util, json, pathlib, struct, sys, zlib
spec = importlib.util.spec_from_file_location('owned_freshness_probe', pathlib.Path(sys.argv[1]))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else b if pb <= pc else c
def encode(width, height, channels, rows, filters, chunks=1):
    stride = width * channels
    out, previous = b"", bytes(stride)
    for y, row in enumerate(rows):
        kind = filters[y % len(filters)]
        line = bytearray()
        for i in range(stride):
            left = row[i - channels] if i >= channels else 0
            up = previous[i]
            corner = previous[i - channels] if i >= channels else 0
            predictor = [0, left, up, (left + up) >> 1, paeth(left, up, corner)][kind]
            line.append((row[i] - predictor) & 0xFF)
        out += bytes([kind]) + bytes(line)
        previous = row
    data = zlib.compress(out)
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    color = 2 if channels == 3 else 6
    size = len(data) // chunks + 1
    idat = b"".join(chunk(b"IDAT", data[i:i + size]) for i in range(0, len(data), size))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, color, 0, 0, 0)) +
            chunk(b"tEXt", b"Comment\x00offline") + idat + chunk(b"IEND", b""))
results = {}
for channels in (3, 4):
    width, height = 7, 6
    rows = [bytes(((x * 37 + y * 91 + c * 53) ^ (x * y)) & 0xFF for x in range(width) for c in range(channels))
            for y in range(height)]
    for filters in ([0], [1], [2], [3], [4], [0, 1, 2, 3, 4, 4]):
        decoded = probe.decode_png(encode(width, height, channels, rows, filters, chunks=3))
        results["%d-%s" % (channels, filters)] = decoded == (width, height, channels, rows)
base = [bytes(4 * 3) for _ in range(4)]
changed = [bytearray(row) for row in base]
changed[1][2 * 3] = 9
changed = [bytes(row) for row in changed]
a = probe.decode_png(encode(4, 4, 3, base, [0]))
b = probe.decode_png(encode(4, 4, 3, changed, [4]))
results["same"] = probe.compare_pixels(a, a, None)
results["differs"] = probe.compare_pixels(a, b, None)
results["ignored"] = probe.compare_pixels(a, b, [2, 0, 3, 2])
results["column"] = probe.compare_pixels(a, b, [1, 0, 2, 4])
results["rect"] = probe.pixel_rect([1037, 1, 145, 20], 2560, 1440, 1280, 720)
results["clamped"] = probe.pixel_rect([90, 50, 20, 20], 96, 53)
errors = []
good = encode(2, 2, 3, [bytes(6), bytes(6)], [0])
for label, data in (("signature", b"GIF89a"), ("truncated", good[:-6]),
                    ("crc", good[:30] + bytes([good[30] ^ 1]) + good[31:]), ("valid", good)):
    try:
        probe.decode_png(data)
        errors.append([label, "decoded"])
    except ValueError as error:
        errors.append([label, str(error)])
def chunk(kind, body):
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
def raw_png(color, idat):
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, color, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(idat)) + chunk(b"IEND", b""))
for label, data in (("gray", raw_png(0, bytes(6))), ("badfilter", raw_png(2, b"\x05" + bytes(6) + b"\x00" + bytes(6))),
                    ("short", raw_png(2, bytes(7)))):
    try:
        probe.decode_png(data)
        errors.append([label, "decoded"])
    except ValueError as error:
        errors.append([label, str(error)])
results["errors"] = errors
print(json.dumps(results))
`;

test('PNG decoder handles RGB and RGBA with filter types 0-4 and compares outside a band', () => {
  const result = spawnSync('python3', ['-I', '-S', '-B', '-c', pngUnit, probe], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const r = JSON.parse(result.stdout);
  for (const channels of [3, 4]) {
    for (const filters of ['[0]', '[1]', '[2]', '[3]', '[4]', '[0, 1, 2, 3, 4, 4]']) {
      assert.equal(r[`${channels}-${filters}`], true, `${channels} channels, filters ${filters}`);
    }
  }
  assert.deepEqual(r.same, { equal: true, diffBox: null });
  assert.deepEqual(r.differs, { equal: false, diffBox: [2, 1, 3, 2] });
  assert.deepEqual(r.ignored, { equal: true, diffBox: [2, 1, 3, 2] });
  assert.deepEqual(r.column, { equal: false, diffBox: [2, 1, 3, 2] });
  // The PZM band at 1280x720 scaled, on a 2560x1440 capture.
  assert.deepEqual(r.rect, [2074, 2, 2364, 42]);
  assert.deepEqual(r.clamped, [90, 50, 96, 53]);
  const errors = Object.fromEntries(r.errors);
  assert.equal(errors.signature, 'not a PNG');
  assert.equal(errors.truncated, 'truncated PNG chunk');
  assert.equal(errors.crc, 'PNG chunk CRC mismatch');
  assert.equal(errors.valid, 'decoded');
  assert.match(errors.gray, /unsupported PNG: depth 8, color type 0/);
  assert.equal(errors.badfilter, 'invalid PNG filter type 5');
  assert.equal(errors.short, 'PNG image data has the wrong length');
});

// Unit-level verdict rules and the observation-only method gate.
const verdicts = String.raw`
import importlib.util, json, pathlib, sys, types
spec = importlib.util.spec_from_file_location('owned_freshness_probe', pathlib.Path(sys.argv[1]))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
def capture(step, **fields):
    record = {"step": step, "phase": "warm", "session": 0, "ok": True, "latency_ms": 100.0, "sha256": "a" * 64,
              "reason": None, "connectionGeneration": 1, "healthBefore": {"state": "connected", "connectionGeneration": 1},
              "provenance": {"requests": {"full": 1}}, "ledger": {"fullRequests": 1}}
    record.update(fields)
    return record
session = {"index": 0, "ledger": {"inputLines": 0}, "gateLeaks": {"max": 0}, "failure": None}
results = {}
results["clean"] = probe.evaluate("P0", "stream", [capture(0), capture(1)], [session])
results["slow"] = probe.evaluate("P0", "stream", [capture(0, latency_ms=5000.0)], [session])
results["twoFull"] = probe.evaluate("P0", "stream", [capture(0, ledger={"fullRequests": 2})], [session])
results["provenance"] = probe.evaluate("P0", "stream", [capture(0, provenance={"requests": {"full": 2}})], [session])
results["input"] = probe.evaluate("P0", "stream", [capture(0)], [dict(session, ledger={"inputLines": 1})])
results["reconnected"] = probe.evaluate("P1", "on-demand", [capture(0), capture(1, connectionGeneration=2)], [session])
results["incremental"] = probe.evaluate("P1", "on-demand", [capture(0)],
                                        [dict(session, ledger={"inputLines": 0, "incrementalRearm": 1})])
eq_static = [capture(0, phase="eq-static"), capture(1, phase="eq-static")]
results["eqNoSettled"] = probe.evaluate("P-eq", "stream", eq_static + [capture(2, phase="eq-new-connection", session=1)],
                                        [session])
results["eqImmediateOnlyDiffers"] = probe.evaluate("P-eq", "stream", eq_static + [
    capture(2, phase="eq-new-connection", session=1, sha256="b" * 64),
    capture(3, phase="eq-new-connection-settled", session=1)], [session])
try:
    probe.DaemonSession.rpc(types.SimpleNamespace(broken=None), "key_tap", 1)
    results["gate"] = "sent"
except AssertionError as error:
    results["gate"] = str(error)
print(json.dumps(results))
`;

test('verdict rules and the method gate', () => {
  const result = spawnSync('python3', ['-I', '-S', '-B', '-c', verdicts, probe], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const r = JSON.parse(result.stdout);
  assert.deepEqual(r.clean, ['PASS', []]);
  assert.match(r.slow[1][0], /took 5000.0 ms/);
  assert.match(r.twoFull[1][0], /wire ledger shows 2 full requests/);
  assert.match(r.provenance[1][0], /provenance shows 2 full requests/);
  assert.match(r.input[1][0], /input appeared on the wire ledger/);
  assert.match(r.reconnected[1][0], /connection did not survive: generations/);
  assert.match(r.incremental[1][0], /on-demand mode wrote 1 incremental requests/);
  assert.match(r.gate, /observation-only runner refused to send 'key_tap'/);
  assert.deepEqual(r.eqNoSettled[1], ['no settled capture from a new connection']);
  // Only the settled capture decides; a mid-fade immediate frame is recorded, not judged.
  assert.deepEqual(r.eqImmediateOnlyDiffers, ['PASS', []]);
});
