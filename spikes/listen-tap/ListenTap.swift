// Spike: capture one process's audio through a Core Audio process tap.
//
// TIN-5509. Not a product surface. It builds with swiftc on a Darwin arm64
// host, takes no install and changes no default device. A pending audio
// capture permission request blocks AudioDeviceCreateIOProcIDWithBlock with no
// timeout (observed on macOS 26.7.1), so a watchdog ends the process ten
// seconds after the requested span. The tap and the private aggregate device
// end with the process. The tone mode is untested.
//
//   listen-tap devices
//       Read-only list of HAL devices.
//   listen-tap processes
//       Read-only list of Core Audio process objects.
//   listen-tap tone --device-uid UID [--dbfs -60] [--seconds 4] [--lead 1]
//       Plays a quiet sine with click bursts to one device. It refuses any
//       device whose transport is not virtual and any level above -60 dBFS.
//   listen-tap capture (--self | --pid N | --bundle-id ID) --seconds S
//       [--out PATH | --stdout] [--mute] --source-kind test-audio|logic
//       [--source-bundle-id ID] [--bar-map FILE | --start-bar N --tempo-milli-bpm M]
//       [--offset-us N] [--target-first N --target-last N] [--pre-roll N] [--tail N]
//       [--dry-header]   print the header only: no tap, no device IO
//       [--uid-hmac-key-file PATH]   per-host secret for outputDevice.uidHmac
//       (default ~/.config/legalab/listen-uid-hmac.key; refused if missing)
//       Creates a private stereo-mixdown tap on the process and a private
//       aggregate device that holds only the tap. Version 0.2 streams: the IO
//       proc copies each callback into a lock-free ring, and a writer thread
//       sends a ListenStreamHeaderV1 line at the first callback, then each
//       callback's interleaved float32 frames as they arrive. Statistics go to
//       stderr as JSON.
//
// The header follows schemas/v1/listen_stream_header.schema.json in legalab
// (TIN-7920). analysis/listen_server.py reads it (TIN-7844, TIN-7926).

import AudioToolbox
import CoreAudio
import CryptoKit
import Darwin
import Foundation
import Synchronization

// MARK: - small helpers

struct SpikeError: Error, CustomStringConvertible {
    let description: String
    init(_ text: String) { description = text }
}

func check(_ status: OSStatus, _ what: String) throws {
    if status != noErr {
        throw SpikeError("\(what) failed with OSStatus \(status) (\(fourCC(status)))")
    }
}

func fourCC(_ status: OSStatus) -> String {
    let value = UInt32(bitPattern: status)
    let bytes = [24, 16, 8, 0].map { UInt8((value >> UInt32($0)) & 0xFF) }
    if bytes.allSatisfy({ $0 >= 32 && $0 < 127 }) {
        return String(bytes: bytes, encoding: .ascii) ?? "?"
    }
    return "\(status)"
}

func address(_ selector: AudioObjectPropertySelector,
             _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func readScalar<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
                   _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, _ zero: T) -> T? {
    var addr = address(selector, scope)
    var value = zero
    var size = UInt32(MemoryLayout<T>.size)
    let status = AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value)
    return status == noErr ? value : nil
}

func readString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var addr = address(selector)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let status = AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value)
    guard status == noErr, let text = value?.takeRetainedValue() else { return nil }
    return text as String
}

func readIDs(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> [AudioObjectID] {
    var addr = address(selector)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func channelCount(_ device: AudioObjectID, _ scope: AudioObjectPropertyScope) -> Int {
    var addr = address(kAudioDevicePropertyStreamConfiguration, scope)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(device, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 16)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, raw) == noErr else { return 0 }
    let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func transportName(_ code: UInt32) -> String {
    switch code {
    case kAudioDeviceTransportTypeBuiltIn: return "builtin"
    case kAudioDeviceTransportTypeAggregate: return "aggregate"
    case kAudioDeviceTransportTypeVirtual: return "virtual"
    case kAudioDeviceTransportTypeUSB: return "usb"
    case kAudioDeviceTransportTypeFireWire: return "firewire"
    case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "bluetooth"
    case kAudioDeviceTransportTypeHDMI: return "hdmi"
    case kAudioDeviceTransportTypeDisplayPort: return "displayport"
    case kAudioDeviceTransportTypeAirPlay: return "airplay"
    case kAudioDeviceTransportTypePCI: return "pci"
    case kAudioDeviceTransportTypeThunderbolt: return "thunderbolt"
    case 0: return "unknown"
    default: return fourCC(OSStatus(bitPattern: code))
    }
}

let timebase: mach_timebase_info_data_t = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return info
}()

func hostNs(_ ticks: UInt64) -> Double { Double(ticks) * Double(timebase.numer) / Double(timebase.denom) }

func emit(_ object: [String: Any], to handle: FileHandle = .standardError) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
        handle.write(data)
        handle.write("\n".data(using: .utf8)!)
    }
}

func cpuSeconds() -> Double {
    var usage = rusage()
    getrusage(RUSAGE_SELF, &usage)
    let user = Double(usage.ru_utime.tv_sec) + Double(usage.ru_utime.tv_usec) / 1e6
    let system = Double(usage.ru_stime.tv_sec) + Double(usage.ru_stime.tv_usec) / 1e6
    return user + system
}

func maxRSSMegabytes() -> Double {
    var usage = rusage()
    getrusage(RUSAGE_SELF, &usage)
    return Double(usage.ru_maxrss) / 1_048_576.0  // bytes on Darwin
}

// MARK: - read-only listings

func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioObjectID {
    readScalar(AudioObjectID(kAudioObjectSystemObject), selector, kAudioObjectPropertyScopeGlobal, AudioObjectID(0)) ?? 0
}

func listDevices() {
    let system = AudioObjectID(kAudioObjectSystemObject)
    let defOut = defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
    let defSys = defaultDevice(kAudioHardwarePropertyDefaultSystemOutputDevice)
    for device in readIDs(system, kAudioHardwarePropertyDevices) {
        let transport = readScalar(device, kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal, UInt32(0)) ?? 0
        let rate = readScalar(device, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, Float64(0)) ?? 0
        let hidden = readScalar(device, kAudioDevicePropertyIsHidden, kAudioObjectPropertyScopeGlobal, UInt32(0)) ?? 0
        let alive = readScalar(device, kAudioDevicePropertyDeviceIsAlive, kAudioObjectPropertyScopeGlobal, UInt32(0)) ?? 0
        let running = readScalar(device, kAudioDevicePropertyDeviceIsRunningSomewhere, kAudioObjectPropertyScopeGlobal, UInt32(0)) ?? 0
        var row: [String: Any] = [
            "id": device, "name": readString(device, kAudioObjectPropertyName) ?? "",
            "uid": readString(device, kAudioDevicePropertyDeviceUID) ?? "",
            "transport": transportName(transport), "rate": rate,
            "in": channelCount(device, kAudioObjectPropertyScopeInput),
            "out": channelCount(device, kAudioObjectPropertyScopeOutput),
            "hidden": hidden != 0, "alive": alive != 0, "runningSomewhere": running != 0,
            "defaultOutput": device == defOut, "defaultSystemOutput": device == defSys,
        ]
        if transport == kAudioDeviceTransportTypeAggregate {
            row["subdevices"] = readIDs(device, kAudioAggregateDevicePropertyActiveSubDeviceList)
                .map { readString($0, kAudioObjectPropertyName) ?? "\($0)" }
        }
        emit(row, to: .standardOutput)
    }
}

func listProcesses() {
    let system = AudioObjectID(kAudioObjectSystemObject)
    for process in readIDs(system, kAudioHardwarePropertyProcessObjectList) {
        let pid = readScalar(process, kAudioProcessPropertyPID, kAudioObjectPropertyScopeGlobal, pid_t(0)) ?? 0
        let output = readScalar(process, kAudioProcessPropertyIsRunningOutput, kAudioObjectPropertyScopeGlobal, UInt32(0)) ?? 0
        emit(["object": process, "pid": pid, "bundleID": readString(process, kAudioProcessPropertyBundleID) ?? "",
              "runningOutput": output != 0], to: .standardOutput)
    }
}

func processObject(pid: pid_t) throws -> AudioObjectID {
    var addr = address(kAudioHardwarePropertyTranslatePIDToProcessObject)
    var qualifier = pid
    var object = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr,
                                         UInt32(MemoryLayout<pid_t>.size), &qualifier, &size, &object),
              "translate PID \(pid)")
    if object == kAudioObjectUnknown { throw SpikeError("PID \(pid) has no Core Audio process object yet") }
    return object
}

func processObjects(bundleID: String) -> [AudioObjectID] {
    readIDs(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList)
        .filter { readString($0, kAudioProcessPropertyBundleID) == bundleID }
}

// MARK: - tone (refuses anything but a virtual device)

func runTone(deviceUID: String, dbfs: Double, seconds: Double, lead: Double) throws {
    guard dbfs <= -60 else { throw SpikeError("tone refuses levels above -60 dBFS") }
    var addr = address(kAudioHardwarePropertyTranslateUIDToDevice)
    var cfUID = deviceUID as CFString
    var device = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    try withUnsafePointer(to: &cfUID) { pointer in
        try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr,
                                             UInt32(MemoryLayout<CFString>.size), pointer, &size, &device),
                  "translate device UID")
    }
    guard device != kAudioObjectUnknown else { throw SpikeError("no device with UID \(deviceUID)") }
    let transport = readScalar(device, kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal, UInt32(0)) ?? 0
    guard transport == kAudioDeviceTransportTypeVirtual else {
        throw SpikeError("tone refuses device transport \(transportName(transport)); only a virtual device is allowed")
    }
    let rate = readScalar(device, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, Float64(48000)) ?? 48000
    let amp = Float(pow(10.0, dbfs / 20.0))
    let leadFrames = Int64(lead * rate)
    let endFrames = Int64((lead + seconds) * rate)
    // A 1 kHz sine with a 5 ms 3 kHz burst on every 308 BPM quarter, so a
    // capture can measure onset timing.
    let beatFrames = Int64(rate * 60.0 / 308.0)
    let burstFrames = Int64(rate * 0.005)
    var frame: Int64 = 0
    var firstOnsetHost: UInt64 = 0
    var procID: AudioDeviceIOProcID?
    let done = DispatchSemaphore(value: 0)
    try check(AudioDeviceCreateIOProcIDWithBlock(&procID, device, nil) { _, _, _, output, outTime in
        let list = UnsafeMutableAudioBufferListPointer(output)
        let frames = Int(list[0].mDataByteSize) / MemoryLayout<Float>.size / max(1, Int(list[0].mNumberChannels))
        for buffer in list {
            guard let base = buffer.mData?.assumingMemoryBound(to: Float.self) else { continue }
            let ch = Int(buffer.mNumberChannels)
            for i in 0..<frames {
                let f = frame + Int64(i)
                var v: Float = 0
                if f >= leadFrames && f < endFrames {
                    let local = f - leadFrames
                    v = amp * 0.5 * Float(sin(2.0 * Double.pi * 1000.0 * Double(f) / rate))
                    if local % beatFrames < burstFrames {
                        v += amp * 0.5 * Float(sin(2.0 * Double.pi * 3000.0 * Double(f) / rate))
                    }
                }
                for c in 0..<ch { base[i * ch + c] = v }
            }
        }
        if firstOnsetHost == 0 && frame + Int64(frames) > leadFrames {
            let offset = Double(leadFrames - frame) / rate
            firstOnsetHost = outTime.pointee.mHostTime + UInt64(max(0, offset) * 1e9 * Double(timebase.denom) / Double(timebase.numer))
        }
        frame += Int64(frames)
        if frame >= endFrames + Int64(rate * 0.2) { done.signal() }
    }, "create tone IO proc")
    try check(AudioDeviceStart(device, procID), "start tone device")
    emit(["event": "tone-started", "pid": getpid(), "device": deviceUID, "rate": rate, "dbfs": dbfs])
    _ = done.wait(timeout: .now() + lead + seconds + 2)
    AudioDeviceStop(device, procID)
    if let procID { AudioDeviceDestroyIOProcID(device, procID) }
    emit(["event": "tone-done", "firstOnsetHostNs": hostNs(firstOnsetHost), "beatMs": 60000.0 / 308.0])
}

// MARK: - capture

/// Single-producer, single-consumer float ring. The IO proc writes, the writer
/// thread reads. Indices count floats ever written or read.
final class Ring: @unchecked Sendable {
    let capacity: Int
    let buf: UnsafeMutablePointer<Float>
    let head = Atomic<Int>(0)
    let tail = Atomic<Int>(0)
    let overruns = Atomic<Int>(0)

    init(capacity: Int) {
        self.capacity = capacity
        buf = .allocate(capacity: capacity)
        buf.initialize(repeating: 0, count: capacity)
    }

    /// Real-time safe: no allocation, no lock. Drops the block on overrun.
    func write(_ src: UnsafePointer<Float>, _ count: Int) {
        let h = head.load(ordering: .relaxed)
        let t = tail.load(ordering: .acquiring)
        if h - t + count > capacity {
            overruns.wrappingAdd(1, ordering: .relaxed)
            return
        }
        let at = h % capacity
        let first = min(count, capacity - at)
        (buf + at).update(from: src, count: first)
        if first < count { buf.update(from: src + first, count: count - first) }
        head.store(h + count, ordering: .releasing)
    }

    func read(into dst: UnsafeMutablePointer<Float>, max: Int) -> Int {
        let t = tail.load(ordering: .relaxed)
        let h = head.load(ordering: .acquiring)
        let n = min(h - t, max)
        if n <= 0 { return 0 }
        let at = t % capacity
        let first = min(n, capacity - at)
        dst.update(from: buf + at, count: first)
        if first < n { (dst + first).update(from: buf, count: n - first) }
        tail.store(t + n, ordering: .releasing)
        return n
    }

    var fill: Int { head.load(ordering: .acquiring) - tail.load(ordering: .acquiring) }
}

final class Capture: @unchecked Sendable {
    let frames: Int
    let channels: Int
    let ring: Ring
    let scratch: UnsafeMutablePointer<Float>
    let scratchFrames = 8192
    let firstInputHost = Atomic<Int>(0)
    let framesSeen = Atomic<Int>(0)
    let done = Atomic<Bool>(false)
    var callbacks = 0
    var maxAgeNs: Double = 0
    var sumAgeNs: Double = 0
    var maxCallbackFrames = 0
    var peak: Float = 0
    var nonInterleaved = false
    var firstNonzeroFrame = -1

    init(frames: Int, channels: Int, ringSeconds: Double, rate: Double) {
        self.frames = frames
        self.channels = channels
        ring = Ring(capacity: Int(ringSeconds * rate) * channels)
        scratch = .allocate(capacity: scratchFrames * channels)
        scratch.initialize(repeating: 0, count: scratchFrames * channels)
    }
}

struct StreamOptions {
    var uidKeyPath = NSString(string: "~/.config/legalab/listen-uid-hmac.key").expandingTildeInPath
    var sourceKind = "test-audio"
    var sourceBundleID = "unknown"
    var barMap: [String: Any]? = nil
    var startBar = 1
    var tempoMilliBpm = 308_000
    var offsetUs = 0
    var targetFirst: Int? = nil
    var targetLast: Int? = nil
    var preRoll = 0
    var tail = 0
}

func captureID() -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "UTC")
    f.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
    let hex = String(format: "%08x", UInt32.random(in: 0...UInt32.max))
    return "cap-\(f.string(from: Date()))-\(hex)"
}

/// HMAC-SHA256 of the device UID, keyed by a per-host secret outside Git, as
/// ListenStreamHeaderV1 outputDevice.uidHmac requires: a plain hash of a
/// guessable UID would be a stable device identifier.
func uidHmacHex(_ uid: String, keyPath: String) throws -> String {
    guard let key = FileManager.default.contents(atPath: keyPath), key.count >= 16 else {
        throw SpikeError("no per-host UID key of 16 bytes or more at \(keyPath)")
    }
    let mac = HMAC<SHA256>.authenticationCode(for: Data(uid.utf8), using: SymmetricKey(data: key))
    return mac.map { String(format: "%02x", $0) }.joined()
}

/// The process each source kind must name (legalab tools/legalab_listen.py).
let bundleBySourceKind = ["logic": "com.apple.logic10", "test-audio": "com.apple.afplay"]

/// write(2) until done; false on a closed pipe or another error.
func writeAll(_ fd: Int32, _ base: UnsafeRawPointer, _ bytes: Int) -> Bool {
    var off = 0
    while off < bytes {
        let n = Darwin.write(fd, base + off, bytes - off)
        if n < 0 {
            if errno == EINTR { continue }
            return false
        }
        off += n
    }
    return true
}

/// ListenStreamHeaderV1 without firstInputHostTimeUs, which the writer adds
/// at the first callback. Every number is a whole unit.
func streamHeader(rate: Double, channels: Int, mute: Bool, options: StreamOptions,
                  outUID: String, outRate: Double, outChannels: Int) throws -> [String: Any] {
    let pairs = max(1, outChannels / 2)
    let gain = Int((2000.0 * log10(Double(pairs))).rounded())
    let barMap: [String: Any] = options.barMap ?? [
        "schemaVersion": "legalab.listen-bar-map/v1", "contractType": "ListenBarMapV1",
        "id": "constant-\(options.tempoMilliBpm)-bar-\(options.startBar)", "source": "constant-tempo",
        "meter": ["beatsPerBar": 4, "beatUnit": 4], "tempoMilliBpm": options.tempoMilliBpm,
        "startBar": options.startBar, "downbeatsUs": [Int](), "projectDataSha256Prefix": NSNull(),
    ]
    let mapStart = (barMap["startBar"] as? Int) ?? options.startBar
    let first = options.targetFirst ?? (mapStart + options.preRoll)
    let last = options.targetLast ?? first
    return [
        "schemaVersion": "legalab.listen-stream-header/v1", "contractType": "ListenStreamHeaderV1",
        "magic": "LSTN1", "sampleFormat": "f32le", "sampleRateHz": Int(rate), "channels": channels,
        "captureId": captureID(),
        "source": ["kind": options.sourceKind, "bundleId": options.sourceBundleID, "tapMute": mute ? "muted" : "unmuted"],
        "tap": ["mode": channels == 1 ? "mono-mixdown" : "stereo-mixdown", "aggregate": "tap-only"],
        "outputDevice": ["uidHmac": "hmac-sha256/" + (try uidHmacHex(outUID, keyPath: options.uidKeyPath)),
                         "sampleRateHz": Int(outRate), "outputChannels": outChannels],
        "alignment": ["method": "none", "offsetUs": options.offsetUs, "calibrationOffsetUs": NSNull(),
                      "calibrationJitterUs": NSNull(), "sppHostTimeUs": NSNull()],
        "levelCalibration": ["state": "inferred", "gainDbHundredths": gain,
                             "basis": "20 log10 of \(pairs) stereo output pairs. Inferred from the 2026-11-04 content test, not measured."],
        "barMap": barMap, "targetBars": ["first": first, "last": last],
        "preRollBars": options.preRoll, "tailBars": options.tail,
    ]
}

func runCapture(target: [AudioObjectID], targetLabel: String, seconds: Double, outPath: String?,
                toStdout: Bool, mute: Bool, options: StreamOptions, dryHeader: Bool = false) throws {
    let t0 = mach_absolute_time()
    let cpu0 = cpuSeconds()
    // A pending audio capture permission request blocks IO proc creation with
    // no timeout, so end the process well after the requested span.
    DispatchQueue.global().asyncAfter(deadline: .now() + seconds + 10) {
        emit(["event": "watchdog", "message": "capture did not finish; a permission request may be pending"])
        exit(3)
    }
    // Test audio is muted at the tap so it never reaches the output; Logic is never muted.
    if options.sourceKind == "test-audio" && !mute { throw SpikeError("test-audio needs --mute") }
    if options.sourceKind == "logic" && mute { throw SpikeError("a logic source is never muted") }
    guard let wanted = bundleBySourceKind[options.sourceKind], options.sourceBundleID == wanted else {
        throw SpikeError("a \(options.sourceKind) source names \(bundleBySourceKind[options.sourceKind] ?? "a known bundle")")
    }
    signal(SIGPIPE, SIG_IGN)

    let outDevice = defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
    let outUID = readString(outDevice, kAudioDevicePropertyDeviceUID) ?? ""
    let outRate = readScalar(outDevice, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, Float64(0)) ?? 0
    let outChannels = channelCount(outDevice, kAudioObjectPropertyScopeOutput)
    if dryHeader {
        // Read-only: the header a capture would send, with no tap and no device IO.
        var h = try streamHeader(rate: outRate, channels: 2, mute: mute, options: options,
                             outUID: outUID, outRate: outRate, outChannels: outChannels)
        h["firstInputHostTimeUs"] = Int(hostNs(mach_absolute_time()) / 1000)
        let data = try JSONSerialization.data(withJSONObject: h, options: [.sortedKeys])
        FileHandle.standardOutput.write(data + Data([0x0A]))
        return
    }

    let description = CATapDescription(stereoMixdownOfProcesses: target)
    description.uuid = UUID()
    description.isPrivate = true
    description.name = "listen-tap-stream-\(getpid())"
    description.muteBehavior = mute ? .muted : .unmuted
    var tap = AudioObjectID(kAudioObjectUnknown)
    try check(AudioHardwareCreateProcessTap(description, &tap), "create process tap")
    defer { AudioHardwareDestroyProcessTap(tap) }
    let tapUID = readString(tap, kAudioTapPropertyUID) ?? description.uuid.uuidString
    var format = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    var formatAddr = address(kAudioTapPropertyFormat)
    try check(AudioObjectGetPropertyData(tap, &formatAddr, 0, nil, &size, &format), "read tap format")
    let tTap = mach_absolute_time()

    let aggregate: [String: Any] = [
        kAudioAggregateDeviceNameKey: "listen-tap-stream",
        kAudioAggregateDeviceUIDKey: "listen-tap-stream-" + UUID().uuidString,
        kAudioAggregateDeviceIsPrivateKey: true,
        kAudioAggregateDeviceIsStackedKey: false,
        kAudioAggregateDeviceTapAutoStartKey: true,
        kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapUID, kAudioSubTapDriftCompensationKey: true]],
    ]
    var device = AudioObjectID(kAudioObjectUnknown)
    try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &device), "create private aggregate device")
    defer { AudioHardwareDestroyAggregateDevice(device) }
    let tAggregate = mach_absolute_time()

    let rate = format.mSampleRate
    let channels = Int(max(1, format.mChannelsPerFrame))
    let capture = Capture(frames: Int(seconds * rate), channels: channels, ringSeconds: 4, rate: rate)
    capture.nonInterleaved = (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
    let bufferFrames = readScalar(device, kAudioDevicePropertyBufferFrameSize, kAudioObjectPropertyScopeGlobal, UInt32(0)) ?? 0

    var header = try streamHeader(rate: rate, channels: channels, mute: mute, options: options,
                              outUID: outUID, outRate: outRate, outChannels: outChannels)
    let id = header["captureId"] as! String
    let gain = (header["levelCalibration"] as! [String: Any])["gainDbHundredths"] as! Int

    let fd: Int32
    if toStdout {
        fd = STDOUT_FILENO
    } else if let outPath {
        fd = open(outPath, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
        if fd < 0 { throw SpikeError("cannot open \(outPath)") }
    } else {
        fd = open("/dev/null", O_WRONLY)
    }

    // Writer thread: header at the first callback, then frames as they come.
    var writes = 0
    var bytesOut = 0
    var maxFillFrames = 0
    var writeFailed = false
    var headerHostNs: Double = 0
    let writerDone = DispatchSemaphore(value: 0)
    let writer = Thread {
        let chunk = UnsafeMutablePointer<Float>.allocate(capacity: 4096 * channels)
        defer { chunk.deallocate() }
        while capture.firstInputHost.load(ordering: .acquiring) == 0 && !capture.done.load(ordering: .acquiring) {
            usleep(500)
        }
        let firstHost = UInt64(capture.firstInputHost.load(ordering: .acquiring))
        if firstHost == 0 {  // no callback ever came: send nothing, so the reader sees EOF
            writerDone.signal()
            return
        }
        header["firstInputHostTimeUs"] = Int(hostNs(firstHost) / 1000)
        if let data = try? JSONSerialization.data(withJSONObject: header, options: [.sortedKeys]) {
            let line = data + Data([0x0A])
            writeFailed = !line.withUnsafeBytes { writeAll(fd, $0.baseAddress!, line.count) }
            headerHostNs = hostNs(mach_absolute_time())
        }
        while !writeFailed {
            maxFillFrames = max(maxFillFrames, capture.ring.fill / channels)
            let n = capture.ring.read(into: chunk, max: 4096 * channels)
            if n > 0 {
                if !writeAll(fd, chunk, n * MemoryLayout<Float>.size) { writeFailed = true; break }
                writes += 1
                bytesOut += n * MemoryLayout<Float>.size
                continue
            }
            if capture.done.load(ordering: .acquiring) && capture.ring.fill == 0 { break }
            usleep(1000)
        }
        writerDone.signal()
    }
    writer.qualityOfService = .userInteractive
    writer.start()

    let finished = DispatchSemaphore(value: 0)
    var procID: AudioDeviceIOProcID?
    try check(AudioDeviceCreateIOProcIDWithBlock(&procID, device, nil) { now, input, inTime, _, _ in
        // Real-time thread: no allocation, no locks, no I/O.
        let c = capture
        if c.done.load(ordering: .relaxed) { return }
        c.callbacks += 1
        let nowHost = now.pointee.mHostTime
        if nowHost >= inTime.pointee.mHostTime {
            let age = hostNs(nowHost - inTime.pointee.mHostTime)
            c.maxAgeNs = max(c.maxAgeNs, age)
            c.sumAgeNs += age
        }
        let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        guard list.count > 0 else { return }
        let seen = c.framesSeen.load(ordering: .relaxed)
        var n = 0
        var src: UnsafePointer<Float>?
        if c.nonInterleaved {
            n = min(Int(list[0].mDataByteSize) / MemoryLayout<Float>.size, c.scratchFrames, c.frames - seen)
            for (ch, buffer) in list.enumerated() where ch < c.channels {
                guard let p = buffer.mData?.assumingMemoryBound(to: Float.self) else { continue }
                for i in 0..<n { c.scratch[i * c.channels + ch] = p[i] }
            }
            src = UnsafePointer(c.scratch)
        } else {
            n = min(Int(list[0].mDataByteSize) / MemoryLayout<Float>.size / c.channels, c.frames - seen)
            src = list[0].mData.map { UnsafePointer($0.assumingMemoryBound(to: Float.self)) }
        }
        guard let src, n > 0 else { return }
        for i in 0..<(n * c.channels) {
            let v = abs(src[i])
            if v > c.peak { c.peak = v }
            if c.firstNonzeroFrame < 0 && v > 0 { c.firstNonzeroFrame = seen + i / c.channels }
        }
        c.maxCallbackFrames = max(c.maxCallbackFrames, n)
        c.ring.write(src, n * c.channels)
        if seen == 0 { c.firstInputHost.store(Int(inTime.pointee.mHostTime), ordering: .releasing) }
        c.framesSeen.store(seen + n, ordering: .relaxed)
        if seen + n >= c.frames {
            c.done.store(true, ordering: .releasing)
            finished.signal()
        }
    }, "create capture IO proc")
    try check(AudioDeviceStart(device, procID), "start private aggregate device")
    let tStart = mach_absolute_time()
    let ok = finished.wait(timeout: .now() + seconds + 3) == .success
    let tDone = mach_absolute_time()
    AudioDeviceStop(device, procID)
    if let procID { AudioDeviceDestroyIOProcID(device, procID) }
    capture.done.store(true, ordering: .releasing)
    _ = writerDone.wait(timeout: .now() + 5)
    let tWriter = mach_absolute_time()
    if fd != STDOUT_FILENO { close(fd) }

    let ms = { (a: UInt64, b: UInt64) in hostNs(b &- a) / 1e6 }
    let cbs = max(1, capture.callbacks)
    let firstHost = UInt64(capture.firstInputHost.load(ordering: .acquiring))
    emit([
        "event": "capture-done", "version": "0.2", "captureId": id, "finished": ok, "target": targetLabel,
        "mute": mute, "rate": rate, "channels": channels, "nonInterleaved": capture.nonInterleaved,
        "framesSeen": capture.framesSeen.load(ordering: .acquiring), "callbacks": capture.callbacks,
        "bufferFrames": bufferFrames, "maxCallbackFrames": capture.maxCallbackFrames,
        "peak": capture.peak, "allZero": capture.peak == 0, "firstNonzeroFrame": capture.firstNonzeroFrame,
        "ringOverruns": capture.ring.overruns.load(ordering: .relaxed), "maxRingFillFrames": maxFillFrames,
        "writes": writes, "bytesOut": bytesOut, "writeFailed": writeFailed,
        "headerAfterFirstInputMs": firstHost > 0 ? (headerHostNs - hostNs(firstHost)) / 1e6 : -1,
        "createTapMs": ms(t0, tTap), "createAggregateMs": ms(tTap, tAggregate), "startDeviceMs": ms(tAggregate, tStart),
        "captureWallMs": ms(tStart, tDone), "writerDrainMs": ms(tDone, tWriter),
        "inputAgeMeanMs": capture.sumAgeNs / Double(cbs) / 1e6, "inputAgeMaxMs": capture.maxAgeNs / 1e6,
        "outputChannels": outChannels, "levelGainDbHundredths": gain,
        "cpuSeconds": cpuSeconds() - cpu0, "maxRSSMB": maxRSSMegabytes(),
    ])
    if writeFailed { throw SpikeError("stream write failed") }
}

// MARK: - main

func value(_ args: [String], _ flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func intValue(_ args: [String], _ flag: String) -> Int? { value(args, flag).flatMap { Int($0) } }

let args = Array(CommandLine.arguments.dropFirst())
do {
    switch args.first {
    case "devices": listDevices()
    case "processes": listProcesses()
    case "tone":
        guard let uid = value(args, "--device-uid") else { throw SpikeError("tone needs --device-uid") }
        try runTone(deviceUID: uid, dbfs: Double(value(args, "--dbfs") ?? "-60") ?? -60,
                    seconds: Double(value(args, "--seconds") ?? "4") ?? 4, lead: Double(value(args, "--lead") ?? "1") ?? 1)
    case "capture":
        let seconds = Double(value(args, "--seconds") ?? "") ?? 0
        guard seconds > 0, seconds <= 30 else { throw SpikeError("capture needs --seconds between 0 and 30") }
        var target: [AudioObjectID] = []
        var label = ""
        var bundle = "unknown"
        if args.contains("--self") {
            target = [try processObject(pid: getpid())]
            label = "self:\(getpid())"
            bundle = Bundle.main.bundleIdentifier ?? "listen-tap"
        } else if let pid = value(args, "--pid").flatMap({ pid_t($0) }) {
            let object = try processObject(pid: pid)
            target = [object]
            label = "pid:\(pid)"
            bundle = readString(object, kAudioProcessPropertyBundleID).flatMap { $0.isEmpty ? nil : $0 } ?? "pid-\(pid)"
        } else if let id = value(args, "--bundle-id") {
            target = processObjects(bundleID: id)
            label = "bundle:\(id)"
            bundle = id
        }
        guard !target.isEmpty else { throw SpikeError("no Core Audio process object for the target") }
        var options = StreamOptions()
        options.sourceKind = value(args, "--source-kind") ?? "test-audio"
        options.sourceBundleID = value(args, "--source-bundle-id") ?? bundleBySourceKind[options.sourceKind] ?? bundle
        if let key = value(args, "--uid-hmac-key-file") { options.uidKeyPath = key }
        if let path = value(args, "--bar-map") {
            let data = try Data(contentsOf: URL(fileURLWithPath: path))
            options.barMap = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        }
        options.startBar = intValue(args, "--start-bar") ?? 1
        options.tempoMilliBpm = intValue(args, "--tempo-milli-bpm") ?? 308_000
        options.offsetUs = intValue(args, "--offset-us") ?? 0
        options.targetFirst = intValue(args, "--target-first")
        options.targetLast = intValue(args, "--target-last")
        options.preRoll = intValue(args, "--pre-roll") ?? 0
        options.tail = intValue(args, "--tail") ?? 0
        try runCapture(target: target, targetLabel: label, seconds: seconds, outPath: value(args, "--out"),
                       toStdout: args.contains("--stdout"), mute: args.contains("--mute"), options: options,
                       dryHeader: args.contains("--dry-header"))
    default:
        throw SpikeError("usage: listen-tap devices | processes | tone ... | capture ...")
    }
} catch {
    emit(["event": "error", "message": "\(error)"])
    exit(2)
}
