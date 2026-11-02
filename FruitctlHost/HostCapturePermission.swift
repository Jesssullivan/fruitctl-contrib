import Foundation

enum HostCaptureError: String, Error {
    case notEnabled = "capture_not_enabled"
    case permissionRequired = "screen_capture_permission_required"
    case displayUnavailable = "configured_display_unavailable"
    case selfApplicationUnavailable = "own_application_exclusion_unavailable"
    case incompleteImage = "incomplete_capture"
    case captureFailed = "capture_failed"
    case imageEncodingFailed = "image_encoding_failed"
    /// A target-scoped capture found none of its applications running (#163).
    case targetUnavailable = "capture_target_unavailable"
}

enum HostCapturePhase: String, Encodable, Equatable {
    case shareableContent = "shareable_content"
    case captureImage = "capture_image"
}

/// Symbols identify domains compared against Apple's runtime constants, rather
/// than reflecting an arbitrary NSError domain or any localized error text.
enum HostAppleErrorDomain: String, Encodable, Equatable {
    case screenCaptureKit = "SCStreamErrorDomain"
    case cocoa = "NSCocoaErrorDomain"
    case posix = "NSPOSIXErrorDomain"
    case osStatus = "NSOSStatusErrorDomain"
}

struct HostCaptureDiagnostic: Encodable, Equatable {
    let schema = "fruitctl.host-capture-error.v1"
    let phase: HostCapturePhase
    let appleDomain: HostAppleErrorDomain?
    let appleCode: Int32?

    enum CodingKeys: String, CodingKey {
        case schema, phase
        case appleDomain = "apple_domain"
        case appleCode = "apple_code"
    }

    init(error: NSError, phase: HostCapturePhase, screenCaptureErrorDomain: String) {
        self.phase = phase
        let domain: HostAppleErrorDomain?
        switch error.domain {
        case screenCaptureErrorDomain: domain = .screenCaptureKit
        case NSCocoaErrorDomain: domain = .cocoa
        case NSPOSIXErrorDomain: domain = .posix
        case NSOSStatusErrorDomain: domain = .osStatus
        default: domain = nil
        }
        appleDomain = domain
        appleCode = domain == nil ? nil : Int32(exactly: error.code)
    }
}

/// Preserve only bounded diagnostic values. The original NSError, userInfo and
/// underlying errors are neither retained nor included in the protocol.
struct HostCaptureFailure: Error {
    let diagnostic: HostCaptureDiagnostic
    var reason: HostCaptureError { .captureFailed }

    static func preserving(_ error: Error, phase: HostCapturePhase,
                           screenCaptureErrorDomain: String) -> Error {
        if error is HostCaptureError || error is HostCaptureFailure { return error }
        return HostCaptureFailure(diagnostic: HostCaptureDiagnostic(error: error as NSError,
            phase: phase, screenCaptureErrorDomain: screenCaptureErrorDomain))
    }
}

/// Ordinary Screen Recording preflight is one prerequisite, not proof that
/// direct capture will avoid another Apple consent dialog. Requesting consent
/// is a separate operation used only by explicit startup/local human actions.
@MainActor
final class HostCapturePermission {
    private let preflight: () -> Bool
    private let request: () -> Bool

    init(preflight: @escaping () -> Bool, request: @escaping () -> Bool) {
        self.preflight = preflight; self.request = request
    }

    var isGranted: Bool { preflight() }

    func requireCapture(enabled: Bool) throws {
        guard enabled else { throw HostCaptureError.notEnabled }
        guard isGranted else { throw HostCaptureError.permissionRequired }
    }

    @discardableResult
    func requestFromHuman() -> Bool { request() }

    /// Both framework acquisition awaits use this seam. A returned frame or
    /// shareable-content list cannot certify a withdrawn grant or opt-out.
    func withCaptureAuthorization<T>(enabled: () -> Bool,
                                     operation: () async throws -> T) async throws -> T {
        try requireCapture(enabled: enabled())
        let value = try await operation()
        try requireCapture(enabled: enabled())
        return value
    }
}
