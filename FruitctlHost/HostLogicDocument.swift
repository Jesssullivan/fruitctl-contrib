import AppKit
import ApplicationServices
import Foundation

enum HostLogicDocumentReason: String, Equatable {
    case matched, unsupported, missing, ambiguous
    case identityChanged = "identity_changed", staleRef = "stale_ref"
    case windowUnavailable = "window_unavailable", invalidDocumentURL = "invalid_document_url"
}

enum HostLogicDocumentRead: Equatable {
    case document(String)
    case unqualified(HostLogicDocumentReason)
}

extension HostAXNode {
    func logicDocument(expectedPID: pid_t, expired: () -> Bool) -> HostLogicDocumentRead {
        .unqualified(.unsupported)
    }
}

struct HostLogicDocumentRequest: Equatable {
    let processID: pid_t
    let birthMicroseconds: Int64
    let generation: UInt64
    let ref: String

    static func parse(_ params: [String: HostValue]) throws -> Self {
        guard let pid = params["expected_pid"]?.integer, pid > 0, pid <= Int(Int32.max),
              let birth = params["expected_birth_us"]?.integer, birth > 0,
              birth <= 9_007_199_254_740_991,
              let generation = params["generation"]?.unsigned, generation > 0,
              let ref = params["ref"]?.string, HostAXActionRequest.validRef(ref) else {
            throw HostLeaseError.invalidParameters
        }
        return Self(processID: pid_t(pid), birthMicroseconds: Int64(birth), generation: generation, ref: ref)
    }

    func target(in snapshot: HostAXGeneration?, session: String, displayGeneration: UInt64,
                geometry: HostDisplayGeometry) -> HostAXRetainedElement? {
        guard let snapshot, snapshot.number == generation, snapshot.sessionID == session,
              snapshot.displayGeneration == displayGeneration, snapshot.geometry == geometry,
              let target = snapshot.elements[ref], target.processID == processID,
              target.bundleID == HostLogicProcessBinding.bundleIdentifier,
              target.role == "AXWindow" else { return nil }
        return target
    }
}

struct HostLogicProcessBinding: Equatable {
    static let bundleIdentifier = "com.apple.logic10"
    static let bundlePath = "/Applications/Logic Pro.app"
    static let executablePath = bundlePath + "/Contents/MacOS/Logic Pro"
    let processID: pid_t
    let birthMicroseconds: Int64?
    let bundleID: String?
    let executable: String?
    let bundle: String?

    /// Read on the main actor before and after the awaited AX read. A missing
    /// LaunchServices birth stays unknown; PID or title alone is insufficient.
    @MainActor static func current() -> [Self] {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).filter {
            !$0.isTerminated
        }.map { app in
            let birth: Int64?
            if let date = app.launchDate {
                let value = date.timeIntervalSince1970 * 1_000_000
                birth = value.isFinite && value > 0 && value < 9_007_199_254_740_991
                    ? Int64(value.rounded(.down)) : nil
            } else { birth = nil }
            let executable = app.executableURL?.standardizedFileURL
            let bundle = app.bundleURL?.standardizedFileURL
            return Self(processID: app.processIdentifier, birthMicroseconds: birth, bundleID: app.bundleIdentifier,
                executable: executable?.resolvingSymlinksInPath() == executable ? executable?.path : nil,
                bundle: bundle?.resolvingSymlinksInPath() == bundle ? bundle?.path : nil)
        }
    }

    static func failure(_ applications: [Self], request: HostLogicDocumentRequest) -> HostLogicDocumentReason? {
        guard !applications.isEmpty else { return .missing }
        guard applications.count == 1 else { return .ambiguous }
        let app = applications[0]
        guard app.processID == request.processID, app.birthMicroseconds == request.birthMicroseconds,
              app.bundleID == bundleIdentifier, app.bundle == bundlePath,
              app.executable == executablePath else { return .identityChanged }
        return nil
    }
}

enum HostLogicDocumentObservation {
    static let maximumURLBytes = 4_096
    static let budgetNanoseconds: UInt64 = 200_000_000

    /// Pure over injected reads. The production adapter supplies only the
    /// fixed AX window identity, current main/focused refs and AXDocument.
    static func readWindow(expired: () -> Bool, identity: () -> HostLogicDocumentReason?,
                           currentWindow: () -> HostLogicDocumentReason?,
                           document: () -> HostLogicDocumentRead) -> HostLogicDocumentRead {
        guard !expired() else { return .unqualified(.windowUnavailable) }
        if let reason = identity() { return .unqualified(reason) }
        if let reason = currentWindow() { return .unqualified(reason) }
        guard !expired() else { return .unqualified(.windowUnavailable) }
        let read = document()
        if let reason = currentWindow() { return .unqualified(reason) }
        if let reason = identity() { return .unqualified(reason) }
        guard !expired() else { return .unqualified(.windowUnavailable) }
        let repeated = document()
        if let reason = currentWindow() { return .unqualified(reason) }
        if let reason = identity() { return .unqualified(reason) }
        guard !expired() else { return .unqualified(.windowUnavailable) }
        return repeated == read ? read : .unqualified(.ambiguous)
    }

    static func validDocumentURL(_ text: String) -> Bool {
        guard text.hasPrefix("file:///"), !text.contains("\\"), text.utf8.count <= maximumURLBytes,
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let decoded = text.removingPercentEncoding,
              !decoded.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let components = URLComponents(string: text), components.scheme == "file",
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.host == nil || components.host == "",
              components.path.hasPrefix("/"), components.path != "/",
              let url = components.url, url.isFileURL else { return false }
        return true
    }

    static func response(_ request: HostLogicDocumentRequest, reason: HostLogicDocumentReason,
                         document: String? = nil) -> [String: HostValue] {
        let observed = reason == .matched ? document.flatMap { validDocumentURL($0) ? $0 : nil } : nil
        let effectiveReason = reason == .matched && observed == nil ? HostLogicDocumentReason.invalidDocumentURL : reason
        var value: [String: HostValue] = ["schema": .string("fruitctl.logic-document.v1"),
            "qualified": .boolean(effectiveReason == .matched), "reason": .string(effectiveReason.rawValue),
            "pid": .integer(Int64(request.processID)), "birth_us": .integer(request.birthMicroseconds),
            "generation": .integer(Int64(clamping: request.generation)), "ref": .string(request.ref),
            "reopen_authorized": .boolean(false)]
        if let observed { value["document_url"] = .string(observed) }
        return ["logic_document": .object(value)]
    }

    static func finish(_ request: HostLogicDocumentRequest, before: [HostLogicProcessBinding],
                       after: [HostLogicProcessBinding], read: HostLogicDocumentRead) -> [String: HostValue] {
        if let reason = HostLogicProcessBinding.failure(before, request: request) {
            return response(request, reason: reason)
        }
        guard before == after else { return response(request, reason: .identityChanged) }
        if let reason = HostLogicProcessBinding.failure(after, request: request) {
            return response(request, reason: reason)
        }
        switch read {
        case let .unqualified(reason): return response(request, reason: reason)
        case let .document(url):
            return validDocumentURL(url) ? response(request, reason: .matched, document: url)
                : response(request, reason: .invalidDocumentURL)
        }
    }
}

extension HostSystemAXNode {
    /// Observe this retained AXWindow, never a title-derived or newly chosen
    /// window. Every available main/focused window must be this exact object.
    func logicDocument(expectedPID: pid_t, expired: () -> Bool) -> HostLogicDocumentRead {
        func identity() -> HostLogicDocumentReason? {
            guard !expired() else { return .windowUnavailable }
            var owner: pid_t = 0
            guard AXUIElementGetPid(element, &owner) == .success, owner == expectedPID else {
                return .identityChanged
            }
            var role: AnyObject?
            guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role) == .success,
                  role as? String == "AXWindow" else { return .windowUnavailable }
            return expired() ? .windowUnavailable : nil
        }
        let application = AXUIElementCreateApplication(expectedPID)
        guard AXUIElementSetMessagingTimeout(application, HostSystemAccessibilityProvider.messagingTimeoutSeconds) == .success,
              AXUIElementSetMessagingTimeout(element, HostSystemAccessibilityProvider.messagingTimeoutSeconds) == .success else {
            return .unqualified(.windowUnavailable)
        }
        func currentWindow() -> HostLogicDocumentReason? {
            var found = 0, unsupported = 0
            for name in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
                guard !expired() else { return .windowUnavailable }
                var value: AnyObject?
                let result = AXUIElementCopyAttributeValue(application, name as CFString, &value)
                if result == .attributeUnsupported || result == .notImplemented { unsupported += 1; continue }
                if result == .noValue { continue }
                guard result == .success, let value,
                      CFGetTypeID(value) == AXUIElementGetTypeID() else { return .windowUnavailable }
                guard CFEqual(value, element) else { return .ambiguous }
                found += 1
            }
            guard !expired() else { return .windowUnavailable }
            return found > 0 ? nil : unsupported == 2 ? .unsupported : .missing
        }
        return HostLogicDocumentObservation.readWindow(expired: expired, identity: identity, currentWindow: currentWindow) {
            var value: AnyObject?
            let result = AXUIElementCopyAttributeValue(element, kAXDocumentAttribute as CFString, &value)
            switch result {
            case .attributeUnsupported, .notImplemented: return .unqualified(.unsupported)
            case .noValue: return .unqualified(.missing)
            case .success:
                if let value, CFGetTypeID(value) == CFStringGetTypeID(), let text = value as? String {
                    return text.isEmpty ? .unqualified(.missing) : .document(text)
                }
                return .unqualified(.invalidDocumentURL)
            default: return .unqualified(.windowUnavailable)
            }
        }
    }
}
