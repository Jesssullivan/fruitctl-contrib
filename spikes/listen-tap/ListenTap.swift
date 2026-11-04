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
//       [--out PATH | --stdout] [--mute] [--start-bar N] [--bpm X]
//       Creates a private stereo-mixdown tap on the process and a private
//       aggregate device that holds only the tap. It writes a one-line JSON
//       header, then interleaved float32 PCM. Statistics go to stderr as JSON.
//
// The capture header matches analysis/listen_server.py in legalab (TIN-7844).

import AudioToolbox
import CoreAudio
import Darwin
import Foundation

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

final class Capture {
    let frames: Int
    let channels: Int
    var samples: UnsafeMutablePointer<Float>
    var written = 0
    var callbacks = 0
    var firstInputHost: UInt64 = 0
    var firstNowHost: UInt64 = 0
    var lastNowHost: UInt64 = 0
    var maxAgeNs: Double = 0
    var sumAgeNs: Double = 0
    var maxCallbackFrames = 0
    var peak: Float = 0
    var nonInterleaved = false
    var firstNonzeroFrame = -1

    init(frames: Int, channels: Int) {
        self.frames = frames
        self.channels = channels
        samples = .allocate(capacity: frames * channels)
        samples.initialize(repeating: 0, count: frames * channels)
    }
}

func runCapture(target: [AudioObjectID], targetLabel: String, seconds: Double, outPath: String?,
                toStdout: Bool, mute: Bool, startBar: Int?, bpm: Double?) throws {
    let t0 = mach_absolute_time()
    let cpu0 = cpuSeconds()
    DispatchQueue.global().asyncAfter(deadline: .now() + seconds + 10) {
        emit(["event": "watchdog", "message": "capture did not finish; a permission request may be pending"])
        exit(3)
    }
    let description = CATapDescription(stereoMixdownOfProcesses: target)
    description.uuid = UUID()
    description.isPrivate = true
    description.name = "listen-tap-spike-\(getpid())"
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

    let aggregateUID = "listen-tap-spike-" + UUID().uuidString
    let aggregate: [String: Any] = [
        kAudioAggregateDeviceNameKey: "listen-tap-spike",
        kAudioAggregateDeviceUIDKey: aggregateUID,
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
    let capture = Capture(frames: Int(seconds * rate), channels: channels)
    capture.nonInterleaved = (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
    let bufferFrames = readScalar(device, kAudioDevicePropertyBufferFrameSize, kAudioObjectPropertyScopeGlobal, UInt32(0)) ?? 0
    let done = DispatchSemaphore(value: 0)
    var procID: AudioDeviceIOProcID?
    try check(AudioDeviceCreateIOProcIDWithBlock(&procID, device, nil) { now, input, inTime, _, _ in
        // Real-time thread: no allocation, no locks, no I/O.
        let c = capture
        c.callbacks += 1
        let nowHost = now.pointee.mHostTime
        if c.firstNowHost == 0 { c.firstNowHost = nowHost; c.firstInputHost = inTime.pointee.mHostTime }
        c.lastNowHost = nowHost
        let age = hostNs(nowHost &- inTime.pointee.mHostTime)
        if nowHost >= inTime.pointee.mHostTime {
            c.maxAgeNs = max(c.maxAgeNs, age)
            c.sumAgeNs += age
        }
        let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        guard list.count > 0 else { return }
        var n = 0
        if c.nonInterleaved {
            n = Int(list[0].mDataByteSize) / MemoryLayout<Float>.size
            n = min(n, c.frames - c.written)
            for (ch, buffer) in list.enumerated() where ch < c.channels {
                guard let src = buffer.mData?.assumingMemoryBound(to: Float.self) else { continue }
                for i in 0..<n { c.samples[(c.written + i) * c.channels + ch] = src[i] }
            }
        } else {
            let buffer = list[0]
            n = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size / c.channels
            n = min(n, c.frames - c.written)
            if let src = buffer.mData?.assumingMemoryBound(to: Float.self) {
                (c.samples + c.written * c.channels).update(from: src, count: n * c.channels)
            }
        }
        c.maxCallbackFrames = max(c.maxCallbackFrames, n)
        for i in 0..<(n * c.channels) {
            let v = abs(c.samples[c.written * c.channels + i])
            if v > c.peak { c.peak = v }
            if c.firstNonzeroFrame < 0 && v > 0 { c.firstNonzeroFrame = c.written + i / c.channels }
        }
        c.written += n
        if c.written >= c.frames { done.signal() }
    }, "create capture IO proc")
    try check(AudioDeviceStart(device, procID), "start private aggregate device")
    let tStart = mach_absolute_time()
    let finished = done.wait(timeout: .now() + seconds + 3) == .success
    let tDone = mach_absolute_time()
    AudioDeviceStop(device, procID)
    if let procID { AudioDeviceDestroyIOProcID(device, procID) }

    let header: [String: Any] = [
        "magic": "LSTN1", "sample_rate": rate, "channels": channels, "format": "f32le",
        "frames": capture.written, "start_bar": startBar ?? 1, "bpm": bpm ?? 308.0, "offset_s": 0.0,
        "first_input_host_ns": hostNs(capture.firstInputHost), "target": targetLabel,
    ]
    let headerData = try JSONSerialization.data(withJSONObject: header, options: [.sortedKeys])
    let pcm = Data(bytesNoCopy: capture.samples, count: capture.written * channels * MemoryLayout<Float>.size,
                   deallocator: .none)
    let tWrite0 = mach_absolute_time()
    if toStdout {
        FileHandle.standardOutput.write(headerData + "\n".data(using: .utf8)!)
        FileHandle.standardOutput.write(pcm)
    } else if let outPath {
        try (headerData + "\n".data(using: .utf8)! + pcm).write(to: URL(fileURLWithPath: outPath))
    }
    let tWrite1 = mach_absolute_time()
    let ms = { (a: UInt64, b: UInt64) in hostNs(b &- a) / 1e6 }
    let cbs = max(1, capture.callbacks)
    emit([
        "event": "capture-done", "finished": finished, "target": targetLabel, "mute": mute,
        "rate": rate, "channels": channels, "nonInterleaved": capture.nonInterleaved,
        "formatFlags": format.mFormatFlags, "bitsPerChannel": format.mBitsPerChannel,
        "framesWritten": capture.written, "callbacks": capture.callbacks,
        "bufferFrames": bufferFrames, "maxCallbackFrames": capture.maxCallbackFrames,
        "peak": capture.peak, "allZero": capture.peak == 0, "firstNonzeroFrame": capture.firstNonzeroFrame,
        "createTapMs": ms(t0, tTap), "createAggregateMs": ms(tTap, tAggregate), "startDeviceMs": ms(tAggregate, tStart),
        "startToFirstCallbackMs": hostNs(capture.firstNowHost &- tStart) / 1e6,
        "captureWallMs": ms(tStart, tDone),
        "inputAgeMeanMs": capture.sumAgeNs / Double(cbs) / 1e6, "inputAgeMaxMs": capture.maxAgeNs / 1e6,
        "firstInputHostNs": hostNs(capture.firstInputHost), "writeMs": ms(tWrite0, tWrite1),
        "cpuSeconds": cpuSeconds() - cpu0, "maxRSSMB": maxRSSMegabytes(),
    ])
}

// MARK: - main

func value(_ args: [String], _ flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    return args[i + 1]
}

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
        if args.contains("--self") {
            // Silent plumbing test: this process plays nothing, so the tap
            // carries digital silence by construction.
            target = [try processObject(pid: getpid())]
            label = "self:\(getpid())"
        } else if let pid = value(args, "--pid").flatMap({ pid_t($0) }) {
            target = [try processObject(pid: pid)]
            label = "pid:\(pid)"
        } else if let bundle = value(args, "--bundle-id") {
            target = processObjects(bundleID: bundle)
            label = "bundle:\(bundle)"
        }
        guard !target.isEmpty else { throw SpikeError("no Core Audio process object for the target") }
        try runCapture(target: target, targetLabel: label, seconds: seconds, outPath: value(args, "--out"),
                       toStdout: args.contains("--stdout"), mute: args.contains("--mute"),
                       startBar: value(args, "--start-bar").flatMap { Int($0) },
                       bpm: value(args, "--bpm").flatMap { Double($0) })
    default:
        throw SpikeError("usage: listen-tap devices | processes | tone ... | capture ...")
    }
} catch {
    emit(["event": "error", "message": "\(error)"])
    exit(2)
}
