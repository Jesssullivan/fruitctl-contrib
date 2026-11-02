#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Attended observation-only freshness probe against a real VNC target (TIN-5509).

Drives an already-built native controller exactly as the broker does: target
host, port and username become argv, and the credential travels as one
length-prefixed frame on descriptor 3, never in argv, environment or files.
The runner sends only ``screenshot`` and ``health``. It never clicks, types or
presses keys. One JSON receipt records hashes, timings, provenance and wire
ledger counts. No image is kept unless ``--save-images`` is given.

Arms (see test/fruitctl-freshness-probe.md):
  P0     stream mode; warm captures at short gaps, then captures after idle gaps
  P1     on-demand mode; P0 plus captures after long idle gaps
  P-ctl  chosen mode; the operator changes the screen before each capture
  P-eq   chosen mode; static screen, last capture vs a brand-new connection
         after it settles (optionally ignoring a status-menu band)
"""

import argparse
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import selectors
import stat
import struct
import subprocess
import sys
import threading
import time
import zlib


PROBES = ("P0", "P1", "P-ctl", "P-eq")
MODES = ("stream", "on-demand")
FIXED_MODES = {"P0": "stream", "P1": "on-demand"}
# Observation only. Every other daemon method is refused before it is written.
ALLOWED_METHODS = frozenset({"screenshot", "health"})
STALE_SCREEN_CODE = -32010
LATENCY_LIMIT_MS = 5000
MAX_CREDENTIAL_BYTES = 4096
MAX_LINE = 64 * 1024 * 1024
MAX_STDERR_LINE = 64 * 1024
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
GATE_LEAK_LOG = "Request gate reopened by the server"
RECEIPT_NAME = "freshness-probe-receipt.json"
# Design minimums from the TIN-5509 probe table. Shorter schedules still run
# (offline tests use them) but the receipt marks them non-qualifying.
DESIGN = {"gap_seconds": 10, "warm_captures": 10, "idle_seconds": 120, "idle_captures": 5,
          "long_idle_seconds": 600, "long_idle_captures": 1, "ctl_captures": 3, "eq_captures": 2,
          "eq_settle_seconds": 4}
# macOS fades its "Screen Sharing active" menu-bar indicator in about 1-2 s
# after a viewer connects, so a new connection's first frame can catch it
# mid-fade. P-eq compares only after this settle time (2026-10-16, PZM).
EQ_SETTLE_SECONDS = 4
MAX_PNG_PIXELS = 64 * 1024 * 1024
WIRE_LINE = re.compile(r"^\[RFB-WIRE\] ms=(\d+) dir=c2s type=(\d+|input) incremental=([01-]) length=(\d+|-) "
                       r"origin=(bridge|libvnc-init|libvnc-rearm|suppressed)(?: kinds=([0-7](?:,[0-7])*))?$")
DIAGNOSTIC_KEYS = ("unanswered_full_requests", "unanswered_incremental_requests", "auto_rearm_observed",
                   "request_gate_leaks", "finished_updates", "connection_generation", "phase")


class ProbeRefusal(Exception):
    """A precondition failed; nothing was connected."""


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


# ── PNG pixels (stdlib only: zlib + struct) ─────────────────────────────


def decode_png(data):
    """Decode an 8-bit, non-interlaced RGB or RGBA PNG to (width, height, channels, rows).

    The standard library has no PNG decoder. This handles exactly what the
    controller emits; any other format raises ValueError rather than guessing.
    """
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError("not a PNG")
    position, header, idat = len(PNG_SIGNATURE), None, []
    while True:
        if position + 12 > len(data):
            raise ValueError("truncated PNG chunk")
        length, kind = struct.unpack(">I4s", data[position:position + 8])
        body = data[position + 8:position + 8 + length]
        crc = data[position + 8 + length:position + 12 + length]
        if len(body) != length or len(crc) != 4:
            raise ValueError("truncated PNG chunk")
        if zlib.crc32(kind + body) & 0xFFFFFFFF != struct.unpack(">I", crc)[0]:
            raise ValueError("PNG chunk CRC mismatch")
        position += 12 + length
        if kind == b"IHDR":
            if length != 13:
                raise ValueError("invalid IHDR")
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            break
    if header is None:
        raise ValueError("PNG has no IHDR")
    width, height, depth, color, compression, filtering, interlace = header
    if depth != 8 or color not in (2, 6) or compression or filtering or interlace:
        raise ValueError("unsupported PNG: depth %d, color type %d, interlace %d" % (depth, color, interlace))
    if not width or not height or width * height > MAX_PNG_PIXELS:
        raise ValueError("unsupported PNG size %dx%d" % (width, height))
    channels = 3 if color == 2 else 4
    stride = width * channels
    expected = height * (stride + 1)
    inflater = zlib.decompressobj()
    raw = inflater.decompress(b"".join(idat), expected + 1)
    if len(raw) != expected:
        raise ValueError("PNG image data has the wrong length")
    rows, previous = [], bytearray(stride)
    for y in range(height):
        offset = y * (stride + 1)
        kind = raw[offset]
        line = bytearray(raw[offset + 1:offset + 1 + stride])
        if kind == 1:  # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif kind == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + previous[i]) & 0xFF
        elif kind == 3:  # Average
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xFF
        elif kind == 4:  # Paeth
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = previous[i]
                c = previous[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 0xFF
        elif kind != 0:
            raise ValueError("invalid PNG filter type %d" % kind)
        rows.append(bytes(line))
        previous = line
    return width, height, channels, rows


def parse_rect(text):
    """``x,y,w,h`` in scaled screenshot coordinates; w and h must be positive."""
    parts = text.split(",")
    if len(parts) != 4 or not all(part.strip().isdigit() for part in parts):
        raise ValueError("expected x,y,w,h as non-negative integers")
    x, y, w, h = (int(part) for part in parts)
    if not w or not h:
        raise ValueError("width and height must be positive")
    return [x, y, w, h]


def pixel_rect(rect, image_width, image_height, scaled_width=None, scaled_height=None):
    """Map a scaled-coordinate rect onto image pixels, rounding outward and clamping."""
    sx = image_width / scaled_width if scaled_width else 1.0
    sy = image_height / scaled_height if scaled_height else 1.0
    x, y, w, h = rect
    x0, y0 = max(0, int(math.floor(x * sx))), max(0, int(math.floor(y * sy)))
    x1, y1 = min(image_width, int(math.ceil((x + w) * sx))), min(image_height, int(math.ceil((y + h) * sy)))
    return [x0, y0, max(x0, x1), max(y0, y1)]


def compare_pixels(left, right, ignore=None):
    """Compare two decoded PNGs pixel by pixel.

    ``ignore`` is [x0, y0, x1, y1) in image pixels. Returns whether the images
    match outside it (everywhere without one), plus the bounding box [x0, y0, x1, y1] of every differing
    pixel (inside the band too), or None when nothing differs.
    """
    width, height, channels, rows = left
    if (width, height, channels) != right[:3]:
        return {"equal": False, "reason": "image size or format differs", "diffBox": None}
    other = right[3]
    box = None
    outside = True
    for y in range(height):
        a, b = rows[y], other[y]
        if a == b:
            continue
        first = next(i for i in range(len(a)) if a[i] != b[i]) // channels
        last = next(i for i in range(len(a) - 1, -1, -1) if a[i] != b[i]) // channels
        box = [first, y, last + 1, y + 1] if box is None else [
            min(box[0], first), box[1], max(box[2], last + 1), y + 1]
        if outside:
            if ignore is None or not ignore[1] <= y < ignore[3]:
                outside = False
            else:
                x0, x1 = ignore[0] * channels, ignore[2] * channels
                if a[:x0] != b[:x0] or a[x1:] != b[x1:]:
                    outside = False
    return {"equal": outside, "diffBox": box}


# ── Artifact ────────────────────────────────────────────────────────────


def check_artifact(daemon, build_receipt=None):
    """Hash the daemon and, with a build receipt, refuse any sha/size mismatch."""
    try:
        info = os.lstat(daemon)
    except FileNotFoundError:
        raise ProbeRefusal("daemon not found: %s" % daemon)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ProbeRefusal("daemon must be a regular file, not a symlink: %s" % daemon)
    artifact = {"path": str(daemon), "sha256": sha256_file(daemon), "bytes": info.st_size,
                "executable": os.access(daemon, os.X_OK), "buildReceipt": None}
    if build_receipt is not None:
        raw = Path(build_receipt).read_bytes()
        try:
            receipt = json.loads(raw)
        except ValueError:
            raise ProbeRefusal("build receipt is not JSON: %s" % build_receipt)
        expected = (receipt.get("unstrippedUnsignedArtifacts") or {}).get("claude-kvm-daemon")
        if not isinstance(expected, dict):
            raise ProbeRefusal("build receipt lacks unstrippedUnsignedArtifacts[\"claude-kvm-daemon\"]")
        if receipt.get("status") != "passed":
            raise ProbeRefusal("build receipt status is %r, not passed" % receipt.get("status"))
        if expected.get("sha256") != artifact["sha256"] or expected.get("bytes") != artifact["bytes"]:
            raise ProbeRefusal("daemon does not match the build receipt: expected sha256 %s (%s bytes), "
                               "found %s (%s bytes)" % (expected.get("sha256"), expected.get("bytes"),
                                                        artifact["sha256"], artifact["bytes"]))
        artifact["buildReceipt"] = {"sha256": sha256_bytes(raw), "status": receipt.get("status"),
                                    "sourceRevision": receipt.get("sourceRevision"),
                                    "sourceTreeSha256": receipt.get("sourceTreeSha256"), "verified": True}
    return artifact


def exec_bit_message(daemon):
    return ("daemon is not executable. actions/upload-artifact drops the exec bit; after the sha256 "
            "check passes, run:  chmod 0755 '%s'" % daemon)


# ── Target and credential (environment or profile; never printed) ────────


def default_config_path(env):
    """Mirror lib/broker/paths.mjs defaultConfigPath."""
    if env.get("FRUITCTL_CONFIG_PATH"):
        return Path(env["FRUITCTL_CONFIG_PATH"])
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "fruitctl" / "config.json"
    base = Path(env["XDG_CONFIG_HOME"]) if env.get("XDG_CONFIG_HOME") else Path.home() / ".config"
    return base / "fruitctl" / "config.json"


def credential_bytes(value):
    """Mirror tools/credential-transport.js takeCredential."""
    if not isinstance(value, str) or not value or "\0" in value:
        raise ProbeRefusal("a nonempty VNC credential of at most 4096 UTF-8 bytes is required")
    try:
        data = value.encode("utf-8")
    except UnicodeEncodeError:
        raise ProbeRefusal("VNC credential encoding is invalid")
    if len(data) > MAX_CREDENTIAL_BYTES:
        raise ProbeRefusal("a nonempty VNC credential of at most 4096 UTF-8 bytes is required")
    return data


def resolve_target(profile, config, env):
    """Return (target, credential). Profile mirrors lib/broker/server.mjs nativeFactory."""
    if profile:
        path = Path(config) if config else default_config_path(env)
        try:
            if path.stat().st_size > 1024 * 1024:
                raise ProbeRefusal("invalid Fruitctl config size")
            document = json.loads(path.read_text())
        except (OSError, ValueError) as error:
            raise ProbeRefusal("cannot read Fruitctl config %s: %s" % (path, type(error).__name__))
        if document.get("schema") != "fruitctl.config.v1" or not isinstance(document.get("targets"), dict):
            raise ProbeRefusal("expected fruitctl.config.v1 with target profiles")
        entry = document["targets"].get(profile)
        if not isinstance(entry, dict):
            raise ProbeRefusal("profile %r not found in %s" % (profile, path))
        vnc = entry.get("vnc")
        credential = entry.get("credential")
        if isinstance(credential, dict) and credential.get("provider") != "file":
            raise ProbeRefusal("the probe reads file credentials only; export VNC_PASSWORD from the "
                               "profile's provider instead of --profile")
        credential_file = credential.get("path") if isinstance(credential, dict) else entry.get("credentialFile")
        if not isinstance(vnc, dict) or not isinstance(credential_file, str) or not credential_file:
            raise ProbeRefusal("target lacks a VNC credential provider")
        host, port, username = vnc.get("host"), vnc.get("port"), vnc.get("username", "")
        if (not isinstance(host, str) or not host or type(port) is not int or not 1 <= port <= 65535
                or not isinstance(username, str)):
            raise ProbeRefusal("invalid VNC profile")
        secret = Path(credential_file)
        try:
            info = secret.stat()
        except OSError:
            raise ProbeRefusal("credential provider is unreadable")
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_CREDENTIAL_BYTES + 1 or info.st_mode & 0o077:
            raise ProbeRefusal("credential provider must be a private file of at most 4097 bytes")
        try:
            value = secret.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            raise ProbeRefusal("credential provider is unreadable")
        value = re.sub(r"\r?\n$", "", value)
        target = {"source": "profile:" + profile, "host": host, "port": port, "username": username,
                  "profileRequestMode": vnc.get("requestMode")}
        return target, credential_bytes(value)
    if "VNC_PASSWORD" not in env:
        raise ProbeRefusal("no credential: set VNC_HOST/VNC_PORT/VNC_USERNAME/VNC_PASSWORD "
                           "or pass --profile NAME")
    host = env.get("VNC_HOST") or "127.0.0.1"
    port_text = env.get("VNC_PORT") or "5900"
    if not port_text.isdigit() or not 1 <= int(port_text) <= 65535:
        raise ProbeRefusal("invalid VNC_PORT")
    target = {"source": "environment", "host": host, "port": int(port_text),
              "username": env.get("VNC_USERNAME") or "", "profileRequestMode": None}
    return target, credential_bytes(env["VNC_PASSWORD"])


def daemon_argv(daemon, target, mode, connect_timeout=None):
    """lib/mcp/native.js argv order; the descriptor flag is appended last."""
    argv = [str(daemon), "--host", target["host"], "--port", str(target["port"])]
    if target["username"]:
        argv += ["--username", target["username"]]
    argv += ["--rfb-request-mode", mode, "--rfb-wire-ledger", "--no-reconnect", "-v"]
    if connect_timeout is not None:
        argv += ["--connect-timeout", str(connect_timeout)]
    return argv + ["--password-fd", "3"]


def redacted_argv(argv):
    """The credential never enters argv; the username is still kept out of receipts."""
    result = list(argv)
    for index, value in enumerate(result[:-1]):
        if value == "--username":
            result[index + 1] = "<redacted>"
    return result


# ── Schedule ────────────────────────────────────────────────────────────


def build_schedule(probe, options):
    """Ordered steps: {phase, session, waitSeconds, prompt}."""
    steps = []

    def add(phase, wait, session=0, prompt=False):
        steps.append({"phase": phase, "session": session, "waitSeconds": wait, "prompt": prompt})

    if probe in ("P0", "P1"):
        for index in range(options["warm_captures"]):
            add("warm", 0 if index == 0 else options["gap_seconds"])
        for _ in range(options["idle_captures"]):
            add("idle", options["idle_seconds"])
        if probe == "P1":
            for _ in range(options["long_idle_captures"]):
                add("long-idle", options["long_idle_seconds"])
    elif probe == "P-ctl":
        add("ctl-baseline", 0)
        for _ in range(options["ctl_captures"]):
            add("ctl", 0, prompt=True)
    else:
        # Each connection's first frame can catch the menu-bar indicator mid-fade,
        # so the first in-session capture and the compared one wait the settle time.
        for index in range(options["eq_captures"]):
            add("eq-static", options["eq_settle_seconds"] if index == 0 else options["eq_gap_seconds"])
        add("eq-new-connection", 0, session=1)
        add("eq-new-connection-settled", options["eq_settle_seconds"], session=1)
    return steps


def conforms_to_design(probe, options):
    keys = {"P0": ("gap_seconds", "warm_captures", "idle_seconds", "idle_captures"),
            "P1": ("gap_seconds", "warm_captures", "idle_seconds", "idle_captures",
                   "long_idle_seconds", "long_idle_captures"),
            "P-ctl": ("ctl_captures",), "P-eq": ("eq_captures", "eq_settle_seconds")}[probe]
    return all(options[key] >= DESIGN[key] for key in keys)


# ── Ledger ──────────────────────────────────────────────────────────────


def parse_wire_line(line):
    match = WIRE_LINE.match(line)
    if not match:
        return None
    coalesced = match.group(2) == "input"
    return {"ms": int(match.group(1)), "type": "input" if coalesced else int(match.group(2)),
            "incremental": match.group(3), "origin": match.group(5)}


def summarize_ledger(entries):
    requests = [e for e in entries if e["type"] == 3]
    return {
        "lines": len(entries),
        "fullBridge": sum(1 for e in requests if e["incremental"] == "0" and e["origin"] == "bridge"),
        "fullLibvncInit": sum(1 for e in requests if e["incremental"] == "0" and e["origin"] == "libvnc-init"),
        "incrementalBridge": sum(1 for e in requests if e["incremental"] == "1" and e["origin"] == "bridge"),
        "incrementalRearm": sum(1 for e in requests if e["incremental"] == "1" and e["origin"] == "libvnc-rearm"),
        "suppressed": sum(1 for e in requests if e["origin"] == "suppressed"),
        "inputLines": sum(1 for e in entries if e["type"] == "input"),
        "otherTypes": sum(1 for e in entries if e["type"] not in (3, "input")),
    }


# ── Daemon session ──────────────────────────────────────────────────────


class DaemonSession:
    """One owned controller process. Only screenshot and health are ever sent."""

    # Preserves descriptor 3 without preexec_fn; argv[2:] is the daemon argv.
    BOOTSTRAP = ("import os,sys; fd=int(sys.argv[1]); os.dup2(fd,3); os.set_inheritable(3,True); "
                 "os.close(fd) if fd!=3 else None; os.execv(sys.argv[2],sys.argv[2:])")

    def __init__(self, index, argv, credential, clock, output_dir, ready_timeout, origin=0.0):
        self.index = index
        self.clock = clock
        self.origin = origin  # Receipt times are seconds since the run started.
        self.messages = queue.Queue()
        self.notifications = []
        self.ledger = []
        self.last_ledger_position = 0
        self.gate_leak_logs = 0
        self.stderr_lines = 0
        self.identifier = 0
        self.broken = None
        self.closing = False
        self.ledger_file = open(output_dir / ("rfb-wire-ledger.s%d.txt" % index), "w", encoding="utf-8")
        self.stderr_file = open(output_dir / ("daemon-stderr.s%d.txt" % index), "w", encoding="utf-8")
        for handle in (self.ledger_file, self.stderr_file):
            os.chmod(handle.name, 0o600)
        env = dict(os.environ)
        env.pop("VNC_PASSWORD", None)
        env.pop("CLAUDE_KVM_DAEMON_PARAMETERS", None)
        read_fd, write_fd = os.pipe()
        self.process = None
        self.readers = []
        try:
            self.process = subprocess.Popen([sys.executable, "-I", "-S", "-c", self.BOOTSTRAP, str(read_fd), *argv],
                                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                            env=env, pass_fds=(read_fd,))
            os.close(read_fd)
            read_fd = None
            frame = struct.pack("!I", len(credential)) + credential
            os.write(write_fd, frame)
        except Exception:
            self.ledger_file.close()
            self.stderr_file.close()
            raise
        finally:
            if read_fd is not None:
                os.close(read_fd)
            os.close(write_fd)
        self.readers = [threading.Thread(target=self._outputs, daemon=True)]
        for reader in self.readers:
            reader.start()
        self.ready = None
        self.ready_timeout = ready_timeout

    def await_ready(self):
        try:
            self.ready = self._await_ready(self.ready_timeout)
        except Exception as error:
            self.broken = str(error)[:160]
            raise

    def _record_stderr(self, raw):
        line = raw.decode("utf-8", errors="replace").rstrip("\n")
        if line.startswith("[RFB-WIRE]"):
            self.ledger_file.write(line + "\n")
            entry = parse_wire_line(line)
            if entry is not None:
                entry["arrived"] = self.clock()
                self.ledger.append(entry)
        else:
            self.stderr_lines += 1
            if GATE_LEAK_LOG in line:
                self.gate_leak_logs += 1
            if self.stderr_lines <= 20000:
                self.stderr_file.write(line + "\n")

    def _outputs(self):
        # Native wire writes precede the corresponding stdout response.
        # One reader drains that causal stderr prefix before publishing it.
        # The pipes remain separate, so image JSON cannot interleave with logs.
        streams = {"stdout": self.process.stdout, "stderr": self.process.stderr}
        buffers = {name: bytearray() for name in streams}
        active = set(streams)
        with selectors.DefaultSelector() as selector:
            for name, stream in streams.items():
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, name)

            def publish(message):
                self.messages.put((self.clock(), message, len(self.ledger)))

            def consume(name):
                if name not in active:
                    return
                buffer = buffers[name]
                limit = MAX_LINE if name == "stdout" else MAX_STDERR_LINE
                while True:
                    try:
                        chunk = os.read(streams[name].fileno(), 65536)
                    except BlockingIOError:
                        return
                    if not chunk:
                        active.remove(name)
                        selector.unregister(streams[name])
                        if buffer:
                            if name == "stdout":
                                raise ValueError("unbounded or incomplete NDJSON")
                            self._record_stderr(bytes(buffer))
                            buffer.clear()
                        if name == "stdout":
                            consume("stderr")
                            publish(EOFError("daemon output ended"))
                        return
                    buffer.extend(chunk)
                    while True:
                        end = buffer.find(b"\n")
                        if end < 0:
                            break
                        if end + 1 > limit:
                            raise ValueError("unbounded %s line" % name)
                        raw = bytes(buffer[:end + 1])
                        del buffer[:end + 1]
                        if name == "stderr":
                            self._record_stderr(raw)
                        else:
                            consume("stderr")
                            publish(json.loads(raw))
                    if len(buffer) >= limit:
                        raise ValueError("unbounded %s line" % name)

            try:
                while active:
                    for key, _ in selector.select():
                        consume(key.data)
            except Exception as error:
                publish(error)

    def _note(self, arrived, message):
        if message.get("method") == "vnc_state":
            state = (message.get("params") or {}).get("state")
            self.notifications.append({"t": round(arrived - self.origin, 3), "state": str(state)[:120]})

    def _await_ready(self, timeout):
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("daemon ready timed out after %d s" % timeout)
            try:
                arrived, message, ledger_position = self.messages.get(timeout=remaining)
            except queue.Empty:
                continue
            if isinstance(message, Exception):
                raise RuntimeError("daemon exited before ready (exit %s)" % self.process.poll())
            if message.get("method") == "ready":
                params = message.get("params") or {}
                return {"t": round(arrived - self.origin, 3), "scaledWidth": params.get("scaledWidth"),
                        "scaledHeight": params.get("scaledHeight")}
            self._note(arrived, message)

    def rpc(self, method, timeout):
        if method not in ALLOWED_METHODS:
            raise AssertionError("observation-only runner refused to send %r" % method)
        if self.broken:
            raise RuntimeError(self.broken)
        self.identifier += 1
        request = json.dumps({"method": method, "id": self.identifier}, separators=(",", ":")).encode() + b"\n"
        try:
            self.process.stdin.write(request)
            self.process.stdin.flush()
        except OSError:
            self.broken = "daemon_exited"
            raise RuntimeError(self.broken)
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.broken = "runner_timeout"
                raise TimeoutError(self.broken)
            try:
                arrived, message, ledger_position = self.messages.get(timeout=remaining)
            except queue.Empty:
                continue
            if isinstance(message, Exception):
                self.broken = "daemon_exited"
                raise RuntimeError(self.broken)
            if message.get("id") == self.identifier:
                self.last_ledger_position = ledger_position
                return message
            self._note(arrived, message)

    def drain(self):
        while True:
            try:
                arrived, message, _ = self.messages.get_nowait()
            except queue.Empty:
                return
            if isinstance(message, Exception):
                if not self.closing:
                    self.broken = self.broken or "daemon_exited"
                continue
            self._note(arrived, message)

    def alive(self):
        return self.process.poll() is None

    def close(self):
        if self.process is None:
            return None
        self.drain()  # Anything that arrived before this runner chose to stop.
        self.closing = True
        if self.process.poll() is None:
            try:
                self.process.stdin.close()  # EOF ends the owned daemon's command loop.
            except OSError:
                pass
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.process.terminate()  # This exact owned child only.
                try:
                    self.process.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=3)
        for reader in self.readers:
            reader.join(timeout=3)
        self.drain()
        self.ledger_file.close()
        self.stderr_file.close()
        return self.process.returncode


def observe(session, step_index, step, start_clock, options, output_dir, images=None):
    """One health read plus one screenshot. Never any input.

    ``images`` (step -> PNG bytes) keeps pixels in memory for the P-eq
    comparison only; they reach disk only with ``--save-images``.
    """
    record = {"step": step_index, "phase": step["phase"], "session": session.index,
              "waitBeforeSeconds": step["waitSeconds"], "t": None, "latency_ms": None, "sha256": None,
              "ok": False, "reason": None, "provenance": None, "healthBefore": None}
    try:
        health = session.rpc("health", options["capture_timeout"])
        result = health.get("result") or {}
        record["healthBefore"] = {"state": str(result.get("detail"))[:120],
                                  "connectionGeneration": result.get("connectionGeneration"),
                                  "allocation": result.get("allocation")}
    except Exception as error:
        record["healthBefore"] = {"error": str(error)[:120]}
    ledger_start = session.last_ledger_position
    start = session.clock()
    record["t"] = round(start - start_clock, 3)
    try:
        response = session.rpc("screenshot", options["capture_timeout"])
    except Exception as error:
        record["latency_ms"] = round((session.clock() - start) * 1000, 3)
        record["reason"] = str(error)[:120]
        record["ledgerWindow"] = (ledger_start, session.last_ledger_position)
        return record
    end = session.clock()
    record["latency_ms"] = round((end - start) * 1000, 3)
    record["ledgerWindow"] = (ledger_start, session.last_ledger_position)
    error = response.get("error")
    if error:
        record["errorCode"] = error.get("code")
        data = error.get("data") if isinstance(error.get("data"), dict) else {}
        if error.get("code") == STALE_SCREEN_CODE:
            record["reason"] = "stale_screen:%s" % data.get("reason")
            diagnostics = data.get("diagnostics") if isinstance(data.get("diagnostics"), dict) else {}
            record["diagnostics"] = {key: diagnostics.get(key) for key in DIAGNOSTIC_KEYS if key in diagnostics}
        else:
            record["reason"] = "error:%s" % error.get("code")
            record["errorMessage"] = str(error.get("message"))[:160]
        return record
    result = response.get("result") or {}
    try:
        png = base64.b64decode(result.get("image") or "", validate=True)
    except (ValueError, TypeError):
        png = b""
    if not png.startswith(PNG_SIGNATURE):
        record["reason"] = "no_png"
        return record
    record.update(ok=True, sha256=sha256_bytes(png), imageBytes=len(png), provenance=result.get("provenance"),
                  connectionGeneration=result.get("connectionGeneration"), allocation=result.get("allocation"),
                  scaledWidth=result.get("scaledWidth"), scaledHeight=result.get("scaledHeight"))
    if images is not None:
        images[step_index] = png
    if options["save_images"]:
        path = output_dir / ("capture-s%d-%02d.png" % (session.index, step_index))
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(png)
    return record


def attribute_ledger(captures, sessions):
    """Count independently parsed wire entries between matched response prefixes.

    The health reply fixes the starting prefix. The screenshot reply fixes
    its end after the reader has drained already-written stderr. Local reader
    arrival times and rounded daemon milliseconds cannot move an entry.
    """
    by_index = {session.index: session for session in sessions}
    for record in captures:
        session = by_index.get(record["session"])
        window = record.pop("ledgerWindow", None)
        if session is None or window is None:
            continue
        start, end = window
        if not (type(start) is int and type(end) is int and 0 <= start <= end <= len(session.ledger)):
            continue
        inside = [entry for entry in session.ledger[start:end] if entry["type"] == 3]
        record["ledger"] = {
            "entryStart": start, "entryEnd": end,
            "fullRequests": sum(1 for e in inside if e["incremental"] == "0" and e["origin"] == "bridge"),
            "incrementalRequests": sum(1 for e in inside if e["incremental"] == "1" and e["origin"] != "suppressed"),
            "suppressed": sum(1 for e in inside if e["origin"] == "suppressed")}


# ── Verdict ─────────────────────────────────────────────────────────────


def _pixel_check(reference, candidate, images, ignore_rect):
    """Pixel comparison of two captures, or None when pixels are unavailable."""
    if images is None or reference["step"] not in images or candidate["step"] not in images:
        return None
    try:
        left, right = decode_png(images[reference["step"]]), decode_png(images[candidate["step"]])
    except (ValueError, zlib.error) as error:
        return {"equal": False, "reason": "png_decode:%s" % str(error)[:80], "diffBox": None}
    ignore = None
    if ignore_rect is not None:
        ignore = pixel_rect(ignore_rect, left[0], left[1], reference.get("scaledWidth"), reference.get("scaledHeight"))
    result = compare_pixels(left, right, ignore)
    result["imageSize"] = [left[0], left[1]]
    if ignore is not None:
        result["ignoreBoxPixels"] = ignore
    return result


def eq_comparison(captures, images=None, ignore_rect=None):
    """P-eq: the last static in-session capture against the new connection.

    The settled new-connection capture decides. Byte-identical PNGs decide by
    sha256. Otherwise, with ``ignore_rect`` and pixels in memory, pixel
    equality outside the band decides. The immediate capture is recorded only.
    """
    static = [r for r in captures if r["session"] == 0 and r["phase"] == "eq-static"]
    reference = static[-1] if static else None
    result = {"ignoreRect": ignore_rect, "reference": None, "immediate": None, "settled": None,
              "decidedBy": None, "equal": None, "static": None, "staticDecidedBy": None}
    if reference is not None:
        result["reference"] = {"step": reference["step"], "sha256": reference["sha256"]}
    for phase, key in (("eq-new-connection", "immediate"), ("eq-new-connection-settled", "settled")):
        record = next((r for r in captures if r["phase"] == phase), None)
        if record is None:
            continue
        entry = {"step": record["step"], "sha256": record["sha256"], "ok": record["ok"],
                 "sha256Equal": None, "pixels": None}
        if reference is not None and reference["ok"] and record["ok"]:
            entry["sha256Equal"] = reference["sha256"] == record["sha256"]
            if not entry["sha256Equal"]:
                entry["pixels"] = _pixel_check(reference, record, images, ignore_rect)
        result[key] = entry
    settled = result["settled"]
    if settled is not None and settled["sha256Equal"] is not None:
        if settled["sha256Equal"]:
            result.update(decidedBy="settled-sha256", equal=True)
        elif settled["pixels"] is not None and ignore_rect is not None:
            result.update(decidedBy="settled-pixels-outside-ignore-rect", equal=settled["pixels"]["equal"])
        else:
            result.update(decidedBy="settled-sha256", equal=False)
    good = [r for r in static if r["ok"]]
    if len(good) > 1:
        if len({r["sha256"] for r in good}) == 1:
            result.update(static=True, staticDecidedBy="sha256")
        elif ignore_rect is not None and images is not None:
            checks = [_pixel_check(good[0], r, images, ignore_rect) for r in good[1:]
                      if r["sha256"] != good[0]["sha256"]]
            result.update(static=all(c is not None and c["equal"] for c in checks),
                          staticDecidedBy="pixels-outside-ignore-rect")
        else:
            result.update(static=False, staticDecidedBy="sha256")
    return result


def evaluate(probe, mode, captures, sessions, eq=None):
    """Pure verdict. ``sessions``: [{index, ledger, gateLeaks, exitCode, failure, notifications}].

    ``eq`` is a precomputed ``eq_comparison``; without one, P-eq compares hashes only.
    """
    reasons = []
    if not captures:
        reasons.append("no capture was recorded")
    for record in captures:
        label = "capture %d (%s)" % (record["step"], record["phase"])
        if not record["ok"]:
            reasons.append("%s failed: %s" % (label, record.get("reason")))
        elif record["latency_ms"] is None or record["latency_ms"] >= LATENCY_LIMIT_MS:
            reasons.append("%s took %s ms (limit < %d)" % (label, record["latency_ms"], LATENCY_LIMIT_MS))
    for session in sessions:
        if session.get("failure"):
            label = "run" if session["index"] < 0 else "session %d" % session["index"]
            reasons.append("%s: %s" % (label, session["failure"]))
        ledger = session.get("ledger") or {}
        if ledger.get("inputLines"):
            reasons.append("session %d: input appeared on the wire ledger" % session["index"])
        total = ledger.get("fullBridge")
        counts = [(r.get("ledger") or {}).get("fullRequests") for r in captures
                  if r["session"] == session["index"]]
        assigned = sum(value for value in counts if type(value) is int)
        if type(total) is int and total != assigned:
            reasons.append("session %d: %d full wire requests, %d assigned to capture response prefixes"
                           % (session["index"], total, assigned))
    if probe in ("P0", "P1"):
        for record in captures:
            if not record["ok"]:
                continue
            label = "capture %d (%s)" % (record["step"], record["phase"])
            full = (record.get("ledger") or {}).get("fullRequests")
            if full != 1:
                reasons.append("%s: wire ledger shows %s full requests, expected exactly 1" % (label, full))
            requested = ((record.get("provenance") or {}).get("requests") or {}).get("full")
            if requested is not None and requested != 1:
                reasons.append("%s: provenance shows %s full requests, expected exactly 1" % (label, requested))
    if probe == "P1":
        session = sessions[0] if sessions else {}
        generations = {r.get("connectionGeneration") for r in captures if r["ok"]}
        generations |= {(r.get("healthBefore") or {}).get("connectionGeneration") for r in captures
                        if (r.get("healthBefore") or {}).get("connectionGeneration") is not None}
        if len(generations) > 1:
            reasons.append("connection did not survive: generations %s" % sorted(generations, key=str))
        lost = [r for r in captures if not str((r.get("healthBefore") or {}).get("state", "")).startswith("connected")]
        if lost:
            reasons.append("connection did not survive: health before capture %s was not connected"
                           % ", ".join(str(r["step"]) for r in lost))
        if session.get("exitedEarly"):
            reasons.append("connection did not survive: daemon exited before the schedule finished")
        leaks = session.get("gateLeaks", {}).get("max")
        if leaks != 0:
            reasons.append("request_gate_leaks == %s, expected 0" % leaks)
        ledger = session.get("ledger") or {}
        incremental = ledger.get("incrementalBridge", 0) + ledger.get("incrementalRearm", 0)
        if mode == "on-demand" and incremental:
            reasons.append("on-demand mode wrote %d incremental requests" % incremental)
    if probe == "P-ctl":
        for previous, record in zip(captures, captures[1:]):
            if previous["ok"] and record["ok"] and previous["sha256"] == record["sha256"]:
                reasons.append("capture %d is byte-identical to capture %d after a manual change"
                               % (record["step"], previous["step"]))
    if probe == "P-eq":
        eq = eq if eq is not None else eq_comparison(captures)
        if eq["immediate"] is None:
            reasons.append("no capture from a new connection")
        elif eq["settled"] is None:
            reasons.append("no settled capture from a new connection")
        elif eq["equal"] is False:
            reasons.append("last in-session capture differs from the settled capture of a new connection "
                           "(decided by %s)" % eq["decidedBy"])
        if eq["static"] is False:
            reasons.append("screen was not static across the in-session captures (inconclusive; decided by %s)"
                           % eq["staticDecidedBy"])
    return ("PASS" if not reasons else "FAIL"), reasons


# ── Runner ──────────────────────────────────────────────────────────────


def options_from(args):
    return {key: getattr(args, key) for key in (
        "gap_seconds", "warm_captures", "idle_seconds", "idle_captures", "long_idle_seconds",
        "long_idle_captures", "ctl_captures", "eq_captures", "eq_gap_seconds", "eq_settle_seconds",
        "eq_ignore_rect", "capture_timeout", "ready_timeout", "save_images")}


def print_plan(probe, mode, steps, argv, target, artifact, options):
    total = sum(step["waitSeconds"] for step in steps)
    print("Freshness probe %s, mode %s (dry run: nothing connects)" % (probe, mode))
    print("daemon sha256 %s (%d bytes)%s" % (artifact["sha256"], artifact["bytes"],
                                            "" if artifact["executable"] else "  NOT EXECUTABLE"))
    if artifact["buildReceipt"]:
        print("build receipt verified; sourceRevision %s" % artifact["buildReceipt"]["sourceRevision"])
    else:
        print("no build receipt supplied: daemon provenance is unverified")
    if not artifact["executable"]:
        print("warning: " + exec_bit_message(artifact["path"]))
    print("target from %s; credential: <redacted>, delivered as one frame on descriptor 3" % target["source"])
    if target.get("profileRequestMode") not in (None, mode):
        print("note: profile requestMode %r is overridden by this arm" % target["profileRequestMode"])
    print("argv: " + " ".join(argv))
    print("schedule (%d captures, at least %d s of waiting%s):" % (
        len(steps), total, ", plus operator prompts" if any(s["prompt"] for s in steps) else ""))
    elapsed = 0
    for index, step in enumerate(steps):
        elapsed += step["waitSeconds"]
        print("  %2d  +%5ds  session %d  %-18s %s" % (
            index, elapsed, step["session"], step["phase"],
            "operator changes the screen, then Enter" if step["prompt"] else
            ("wait %d s" % step["waitSeconds"] if step["waitSeconds"] else "")))
    if probe == "P-eq":
        print("P-eq compares the last in-session capture with the new connection's capture taken %s s after it "
              "connects; %s" % (options["eq_settle_seconds"], "pixels inside the scaled band x,y,w,h=%s are ignored"
                                % ",".join(str(v) for v in options["eq_ignore_rect"])
                                if options["eq_ignore_rect"] else "no ignore band (sha256 equality only)"))
    print("methods sent: health, screenshot only (never click, type or key)")
    if not conforms_to_design(probe, options):
        print("warning: schedule is shorter than the TIN-5509 design; the receipt will be non-qualifying")


def wait_watching(seconds, session):
    deadline = time.monotonic() + seconds
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not session.alive():
            return
        time.sleep(min(1.0, remaining))


def run(args):
    if args.probe in FIXED_MODES:
        mode = FIXED_MODES[args.probe]
        if args.mode not in (None, mode):
            raise ProbeRefusal("%s runs in %s mode only" % (args.probe, mode))
    else:
        if args.mode is None:
            raise ProbeRefusal("%s needs --mode stream|on-demand (the passing arm)" % args.probe)
        mode = args.mode
    options = options_from(args)
    artifact = check_artifact(args.daemon, args.build_receipt)
    target, credential = resolve_target(args.profile, args.config, os.environ)
    argv = daemon_argv(args.daemon, target, mode, args.connect_timeout)
    steps = build_schedule(args.probe, options)
    if args.dry_run:
        print_plan(args.probe, mode, steps, argv, target, artifact, options)
        return 0
    if not artifact["executable"]:
        raise ProbeRefusal(exec_bit_message(artifact["path"]))
    if args.output_dir is None:
        raise ProbeRefusal("--output-dir is required unless --dry-run")
    output_dir = args.output_dir
    try:
        output_dir.mkdir(mode=0o700, parents=False)
    except FileExistsError:
        raise ProbeRefusal("output directory must be new: %s" % output_dir)
    except FileNotFoundError:
        raise ProbeRefusal("output directory parent does not exist: %s" % output_dir.parent)

    clock = time.monotonic
    start_clock = clock()
    receipt = {"schema": "fruitctl.freshness-probe.v1", "probe": args.probe, "mode": mode,
               "startedAtUnix": int(time.time()), "daemon": {k: artifact[k] for k in ("sha256", "bytes")},
               "buildReceipt": artifact["buildReceipt"],
               "sourceRevision": (artifact["buildReceipt"] or {}).get("sourceRevision"),
               "target": {"source": target["source"], "host": target["host"], "port": target["port"],
                          "usernameSupplied": bool(target["username"]),
                          "profileRequestMode": target.get("profileRequestMode")},
               "argv": redacted_argv(argv), "schedule": {**{k: options[k] for k in DESIGN},
                                                         "eq_gap_seconds": options["eq_gap_seconds"],
                                                         "eq_ignore_rect": options["eq_ignore_rect"],
                                                         "conformsToDesign": conforms_to_design(args.probe, options)},
               "methodsAllowed": sorted(ALLOWED_METHODS), "imagesSaved": options["save_images"],
               "claimedScope": "attended observation-only probe; hashes, timings and counters only",
               "captures": [], "sessions": []}
    print("Freshness probe %s (%s). Observation only: health and screenshot." % (args.probe, mode), flush=True)
    print("Attended setup: one console owner, no other viewers, menu-bar clock hidden, nothing animating.",
          flush=True)
    sessions, records, interrupted = [], [], None
    images = {} if args.probe == "P-eq" else None  # In memory only, for the P-eq pixel comparison.
    session = None
    try:
        for index, step in enumerate(steps):
            if session is None or session.index != step["session"]:
                if session is not None:
                    session.close()
                print("[%7.1fs] connecting session %d" % (clock() - start_clock, step["session"]), flush=True)
                session = DaemonSession(step["session"], argv, credential, clock, output_dir, options["ready_timeout"],
                                        start_clock)
                sessions.append(session)
                session.await_ready()
            if step["waitSeconds"]:
                print("[%7.1fs] %s: idle %d s" % (clock() - start_clock, step["phase"], step["waitSeconds"]),
                      flush=True)
                wait_watching(step["waitSeconds"], session)
            if step["prompt"]:
                print("[%7.1fs] Change the screen by hand now (open/close/move a window), then press Enter."
                      % (clock() - start_clock), flush=True)
                if not sys.stdin.readline():
                    raise KeyboardInterrupt("operator prompt closed")
            record = observe(session, index, step, start_clock, options, output_dir, images)
            records.append(record)
            print("[%7.1fs] %-18s %s  %8.1f ms  %s" % (
                record["t"], step["phase"], "ok  " if record["ok"] else "FAIL", record["latency_ms"] or 0,
                record["sha256"][:16] if record["ok"] else record["reason"]), flush=True)
            if session.broken or not session.alive():
                break
    except KeyboardInterrupt as error:
        interrupted = "interrupted by operator" + (": %s" % error if str(error) else "")
    except (TimeoutError, RuntimeError, OSError) as error:
        interrupted = str(error)[:160]
    finally:
        ran_to_end = len(records) == len(steps) and interrupted is None
        exited_early = {}
        for each in sessions:
            exited_early[each.index] = not each.alive()
            each.close()
    session_reports = []
    for each in sessions:
        diag_leaks = [r.get("diagnostics", {}).get("request_gate_leaks") for r in records
                      if r["session"] == each.index and r.get("diagnostics")]
        diag_leaks = [value for value in diag_leaks if isinstance(value, int)]
        leaks = {"verboseLog": each.gate_leak_logs, "staleDiagnosticsMax": max(diag_leaks) if diag_leaks else None}
        leaks["max"] = max([each.gate_leak_logs] + diag_leaks)
        session_reports.append({"index": each.index, "ready": each.ready, "exitCode": each.process.returncode,
                                "exitedEarly": exited_early.get(each.index, False) and not ran_to_end,
                                "failure": each.broken, "notifications": each.notifications[-50:],
                                "ledger": summarize_ledger(each.ledger), "gateLeaks": leaks,
                                "ledgerFile": "rfb-wire-ledger.s%d.txt" % each.index,
                                "stderrFile": "daemon-stderr.s%d.txt" % each.index})
    attribute_ledger(records, sessions)
    if interrupted:
        session_reports.append({"index": -1, "failure": interrupted})
    elif not ran_to_end:
        session_reports.append({"index": -1, "failure": "schedule stopped after %d of %d captures"
                                % (len(records), len(steps))})
    eq = eq_comparison(records, images, options["eq_ignore_rect"]) if args.probe == "P-eq" else None
    verdict, reasons = evaluate(args.probe, mode, records, session_reports, eq)
    if eq is not None:
        receipt["eqComparison"] = eq
    receipt.update(captures=records, sessions=[s for s in session_reports if s["index"] >= 0],
                   finishedAtUnix=int(time.time()),
                   verdict={"result": verdict, "reasons": reasons,
                            "qualifying": receipt["schedule"]["conformsToDesign"]})
    path = output_dir / RECEIPT_NAME
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print("%s %s (%s)%s" % (args.probe, verdict, mode,
                            "" if receipt["schedule"]["conformsToDesign"] else " NON-QUALIFYING SCHEDULE"))
    if eq is not None and eq["decidedBy"]:
        print("  P-eq decided by %s" % eq["decidedBy"])
    for reason in reasons:
        print("  - " + reason)
    print("receipt: %s" % path)
    return 0 if verdict == "PASS" else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--probe", required=True, choices=PROBES)
    parser.add_argument("--mode", choices=MODES, help="request mode; required for P-ctl and P-eq")
    parser.add_argument("--daemon", type=Path, required=True, help="already-built claude-kvm-daemon")
    parser.add_argument("--build-receipt", type=Path, help="build-receipt.json; verifies daemon sha256/size")
    parser.add_argument("--profile", help="target profile in the Fruitctl config (else VNC_* environment)")
    parser.add_argument("--config", type=Path, help="Fruitctl config path (default: the broker default)")
    parser.add_argument("--output-dir", type=Path, help="new receipt directory")
    parser.add_argument("--connect-timeout", type=int, help="daemon --connect-timeout (1-120 s)")
    parser.add_argument("--gap-seconds", type=float, default=10)
    parser.add_argument("--warm-captures", type=int, default=10)
    parser.add_argument("--idle-seconds", type=float, default=120)
    parser.add_argument("--idle-captures", type=int, default=5)
    parser.add_argument("--long-idle-seconds", type=float, default=600)
    parser.add_argument("--long-idle-captures", type=int, default=2)
    parser.add_argument("--ctl-captures", type=int, default=5)
    parser.add_argument("--eq-captures", type=int, default=3)
    parser.add_argument("--eq-gap-seconds", type=float, default=2)
    parser.add_argument("--eq-settle-seconds", type=float, default=EQ_SETTLE_SECONDS,
                        help="P-eq: wait after each connection before its compared capture (menu-bar indicator fade)")
    parser.add_argument("--eq-ignore-rect", metavar="X,Y,W,H",
                        help="P-eq: compare pixels outside this band, in scaled screenshot coordinates")
    parser.add_argument("--capture-timeout", type=float, default=30, help="runner-side RPC timeout")
    parser.add_argument("--ready-timeout", type=float, default=60, help="wait for the daemon ready event")
    parser.add_argument("--save-images", action="store_true", help="also keep PNGs (receipts are SHA-only)")
    parser.add_argument("--dry-run", action="store_true", help="print the schedule and argv; connect nothing")
    args = parser.parse_args(argv)
    for name in ("gap_seconds", "idle_seconds", "long_idle_seconds", "eq_gap_seconds", "eq_settle_seconds"):
        if getattr(args, name) < 0:
            parser.error("--%s must be >= 0" % name.replace("_", "-"))
    for name in ("warm_captures", "idle_captures", "long_idle_captures", "ctl_captures", "eq_captures"):
        if getattr(args, name) < 1:
            parser.error("--%s must be >= 1" % name.replace("_", "-"))
    if args.connect_timeout is not None and not 1 <= args.connect_timeout <= 120:
        parser.error("--connect-timeout must be 1-120")
    if args.eq_ignore_rect is not None:
        try:
            args.eq_ignore_rect = parse_rect(args.eq_ignore_rect)
        except ValueError as error:
            parser.error("--eq-ignore-rect: %s" % error)
    try:
        return run(args)
    except ProbeRefusal as refusal:
        print("REFUSED: %s" % refusal, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
