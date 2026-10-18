import AppKit
import ScreenCaptureKit
import CoreGraphics
import CoreVideo
import CoreMedia
import Darwin
import ImageIO
import UniformTypeIdentifiers

/// D38: model-facing frames are JPEG; PNG stays available for lossless
/// evidence. Both encode the same owned, complete pixels.
enum HostImageFormat: String, Sendable {
    case png, jpeg
    static let jpegQuality = 0.85
    var mimeType: String { self == .png ? "image/png" : "image/jpeg" }
    var typeIdentifier: CFString { (self == .png ? UTType.png : UTType.jpeg).identifier as CFString }
}

struct HostCapturedImage {
    let encoded: Data
    let format: HostImageFormat
    let nativeWidth: Int
    let nativeHeight: Int
    let scaledWidth: Int
    let scaledHeight: Int
    let displayID: CGDirectDisplayID
    let geometry: HostDisplayGeometry
    var bounds: CGRect { geometry.bounds }
    let excludedPID: pid_t
    let excludedBundleID: String
    let nativeFrameTiming: HostNativeFrameTiming
    /// Host-side milliseconds per stage, to place capture latency: window
    /// enumeration, ScreenCaptureKit, the owned copy, and scale plus encode;
    /// `encoded_bytes` is the delivered image size.
    var stageMilliseconds: [String: Int64] = [:]

    var geometryMetadata: [String: HostValue] {
        ["mimeType": .string(format.mimeType),
         "nativeWidth": .integer(Int64(nativeWidth)), "nativeHeight": .integer(Int64(nativeHeight)),
         "scaledWidth": .integer(Int64(scaledWidth)), "scaledHeight": .integer(Int64(scaledHeight)),
         "display_id": .integer(Int64(displayID)),
         "display_bounds": .object(["x": .number(Double(bounds.origin.x)), "y": .number(Double(bounds.origin.y)),
                                    "width": .number(Double(bounds.width)), "height": .number(Double(bounds.height))]),
         "pixels_per_point_x": .number(Double(nativeWidth) / Double(bounds.width)),
         "pixels_per_point_y": .number(Double(nativeHeight) / Double(bounds.height)),
         "pixel_width": .integer(Int64(geometry.pixelWidth)), "pixel_height": .integer(Int64(geometry.pixelHeight)),
         "point_width": .number(geometry.pointWidth), "point_height": .number(geometry.pointHeight),
         "scale": .number(geometry.scale),
         "cursor_included": .boolean(true),
         "capture_filter": .string("excluding_entire_own_application"),
         "native_capture_resolution": .string("best"),
         "native_pixel_format": .string("BGRA32"),
         "excluded_application_pid": .integer(Int64(excludedPID)),
         "excluded_application_bundle_id": .string(excludedBundleID),
         "native_frame_timing": nativeFrameTiming.metadata,
         "host_stage_ms": .object(stageMilliseconds.mapValues { .integer($0) })]
    }

    var metadata: [String: HostValue] {
        geometryMetadata.merging(["image": .string(encoded.base64EncodedString())]) { _, value in value }
    }
}

/// Only value data leaves the image-processing worker. Its mutable graphics
/// context, destination and encoded buffer are private to that one operation.
struct HostProcessedImage: Sendable {
    let encoded: Data
    let scaledWidth: Int
    let scaledHeight: Int
}

enum HostImageEncoder {
    static func encode(_ image: CGImage, maximumDimension: Int,
                       format: HostImageFormat = .png) throws -> HostProcessedImage {
        // A detached worker thread has no run loop to drain ImageIO and
        // CoreGraphics temporaries; drain them with each frame.
        try autoreleasepool { try encodeFrame(image, maximumDimension: maximumDimension, format: format) }
    }

    private static func encodeFrame(_ image: CGImage, maximumDimension: Int,
                                    format: HostImageFormat) throws -> HostProcessedImage {
        try Task.checkCancellation()
        let width = image.width, height = image.height
        guard maximumDimension > 0, width > 0, height > 0,
              width <= 16_384, height <= 16_384, width <= 33_554_432 / height else {
            throw HostCaptureError.incompleteImage
        }
        let ratio = min(1, Double(maximumDimension) / Double(max(width, height)))
        let scaledWidth = max(1, Int((Double(width) * ratio).rounded()))
        let scaledHeight = max(1, Int((Double(height) * ratio).rounded()))
        let output: CGImage
        if ratio == 1 { output = image }
        else {
            guard let context = CGContext(data: nil, width: scaledWidth, height: scaledHeight,
                bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
                throw HostCaptureError.imageEncodingFailed
            }
            context.interpolationQuality = .high
            context.draw(image, in: CGRect(x: 0, y: 0, width: scaledWidth, height: scaledHeight))
            guard let resized = context.makeImage() else { throw HostCaptureError.imageEncodingFailed }
            output = resized
        }
        try Task.checkCancellation()
        let encoded = NSMutableData()
        guard let encoder = CGImageDestinationCreateWithData(encoded, format.typeIdentifier, 1, nil)
        else { throw HostCaptureError.imageEncodingFailed }
        let properties = format == .jpeg
            ? [kCGImageDestinationLossyCompressionQuality as String: HostImageFormat.jpegQuality] as CFDictionary : nil
        CGImageDestinationAddImage(encoder, output, properties)
        try Task.checkCancellation()
        guard CGImageDestinationFinalize(encoder) else { throw HostCaptureError.imageEncodingFailed }
        try Task.checkCancellation()
        return HostProcessedImage(encoded: encoded as Data, scaledWidth: scaledWidth, scaledHeight: scaledHeight)
    }
}

/// CGImage is immutable and Sendable. Only the image created from our owned
/// copied sample crosses this boundary, never the ScreenCaptureKit surface.
@MainActor
final class HostImageProcessor {
    typealias Operation = @Sendable (CGImage, Int, HostImageFormat) async throws -> HostProcessedImage
    private let operation: Operation
    private var worker: Task<HostProcessedImage, Error>?
    var isProcessing: Bool { worker != nil }

    init(operation: @escaping Operation = { image, maximumDimension, format in
        try HostImageEncoder.encode(image, maximumDimension: maximumDimension, format: format)
    }) {
        self.operation = operation
    }

    func process(_ image: CGImage, maximumDimension: Int, format: HostImageFormat = .png,
                 validate: @MainActor () throws -> Void = {}) async throws -> HostProcessedImage {
        try Task.checkCancellation()
        guard worker == nil else { throw HostLeaseError.busy }
        guard maximumDimension > 0 else { throw HostCaptureError.incompleteImage }
        let task = Task.detached(priority: Task.currentPriority) { [operation] in
            try Task.checkCancellation()
            let result = try await operation(image, maximumDimension, format)
            try Task.checkCancellation()
            return result
        }
        worker = task
        // Parent cancellation cannot interrupt a synchronous ImageIO call.
        // Keep the worker owned, and refuse successors, until it really ends.
        defer { worker = nil }
        let result = try await withTaskCancellationHandler(operation: {
            try await task.value
        }, onCancel: {
            task.cancel()
        })
        try Task.checkCancellation()
        try validate()
        try Task.checkCancellation()
        return result
    }
}

/// Captures only the explicitly selected display, excluding this entire app.
/// Each screenshot gets a fresh filter; native VNC capture is a separate path.
@MainActor
final class HostCapture {
    private let preferences: HostCapturePreferences
    private let permission: HostCapturePermission
    private let imageProcessor = HostImageProcessor()
    var enabled: Bool { preferences.isEnabled }
    /// Changes only through rebind after a display reconfiguration resolves a
    /// configured display UUID to a new ID. An in-flight capture keeps its own.
    private(set) var displayID: CGDirectDisplayID

    init(preferences: HostCapturePreferences, permission: HostCapturePermission,
         displayID: CGDirectDisplayID) {
        self.preferences = preferences; self.permission = permission; self.displayID = displayID
    }

    func rebind(displayID: CGDirectDisplayID) { self.displayID = displayID }

    func snapshot(maximumDimension: Int, format: HostImageFormat = .png) async throws -> HostCapturedImage {
        guard maximumDimension > 0 else { throw HostCaptureError.incompleteImage }
        try permission.requireCapture(enabled: enabled)
        let displayID = self.displayID
        let clock = ContinuousClock()
        var stageStart = clock.now
        var stages: [String: Int64] = [:]
        func stage(_ name: String) {
            let now = clock.now
            let elapsed = stageStart.duration(to: now).components
            stages[name] = elapsed.seconds * 1_000 + elapsed.attoseconds / 1_000_000_000_000_000
            stageStart = now
        }
        let content: SCShareableContent
        do {
            content = try await permission.withCaptureAuthorization(enabled: { self.enabled }) {
                try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            }
        } catch let error as HostCaptureError { throw error }
        catch {
            throw HostCaptureFailure.preserving(error, phase: .shareableContent,
                                              screenCaptureErrorDomain: SCStreamErrorDomain)
        }
        stage("shareable_content")
        guard let display = content.displays.first(where: { $0.displayID == displayID }),
              CGDisplayIsActive(displayID) != 0 else { throw HostCaptureError.displayUnavailable }
        guard let ownApp = content.applications.first(where: {
            $0.processID == getpid() && $0.bundleIdentifier == Bundle.main.bundleIdentifier
        }) else { throw HostCaptureError.selfApplicationUnavailable }
        // Pixel sizes come from the display mode: CGDisplayPixelsWide/High
        // report points on HiDPI. compute(...) bounds the source allocation
        // independently of requested output scaling.
        guard let geometry = HostDisplayGeometry.current(displayID) else {
            throw HostCaptureError.incompleteImage
        }
        let width = geometry.pixelWidth, height = geometry.pixelHeight
        let filter = SCContentFilter(display: display, excludingApplications: [ownApp],
                                     exceptingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.showsCursor = true
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.scalesToFit = false
        configuration.captureResolution = .best
        let sampled: (CMSampleBuffer, CMTime, CMTime)
        do {
            sampled = try await permission.withCaptureAuthorization(enabled: { self.enabled }) {
                try Task.checkCancellation()
                let requestedAt = HostCoreMediaClock.sample()
                let sample = try await SCScreenshotManager.captureSampleBuffer(contentFilter: filter,
                                                                             configuration: configuration)
                let completedAt = HostCoreMediaClock.sample()
                try Task.checkCancellation()
                return (sample, requestedAt, completedAt)
            }
        } catch let error as HostCaptureError { throw error }
        catch {
            throw HostCaptureFailure.preserving(error, phase: .captureImage,
                                              screenCaptureErrorDomain: SCStreamErrorDomain)
        }
        stage("capture")
        let captured = try HostCapturedSample.read(sampled.0, width: width, height: height,
            requestHostTime: sampled.1, completionHostTime: sampled.2)
        stage("copy")
        let image = captured.image
        guard image.width == width, image.height == height, self.displayID == displayID,
              HostDisplayGeometry.current(displayID) == geometry else {
            throw HostCaptureError.incompleteImage
        }
        let processed = try await imageProcessor.process(image, maximumDimension: maximumDimension,
                                                         format: format) {
            try self.permission.requireCapture(enabled: self.enabled)
            guard self.displayID == displayID, CGDisplayIsActive(displayID) != 0,
                  HostDisplayGeometry.current(displayID) == geometry else {
                throw HostCaptureError.incompleteImage
            }
        }
        try Task.checkCancellation()
        stage("encode")
        stages["encoded_bytes"] = Int64(processed.encoded.count)
        return HostCapturedImage(encoded: processed.encoded, format: format, nativeWidth: width, nativeHeight: height,
            scaledWidth: processed.scaledWidth, scaledHeight: processed.scaledHeight,
            displayID: displayID, geometry: geometry,
            excludedPID: ownApp.processID, excludedBundleID: ownApp.bundleIdentifier,
            nativeFrameTiming: captured.timing, stageMilliseconds: stages)
    }
}

extension HostCapturePermission {
    static func system() -> HostCapturePermission {
        HostCapturePermission(preflight: { CGPreflightScreenCaptureAccess() },
                              request: { CGRequestScreenCaptureAccess() })
    }
}
