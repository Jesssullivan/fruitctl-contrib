import AppKit
import ApplicationServices
import Foundation

enum HostAccessibilityError: String, Error {
    case permissionRequired = "accessibility_permission_required"
    case applicationUnavailable = "accessibility_application_unavailable"
}

/// The bounded request accepted from IPC. depth counts levels below each
/// application element; the application itself is depth 0.
struct HostAXRequest: Equatable {
    static let defaultDepth = 6
    static let maximumDepth = 12
    let depth: Int
    let focusedApplicationOnly: Bool
    /// Adds menu-bar extras (Control Center, SystemUIServer, accessory apps)
    /// and their open menus, popovers and panels as further roots.
    var menuExtras = false

    static func parse(_ params: [String: HostValue]) throws -> HostAXRequest {
        var depth = defaultDepth
        if let value = params["depth"] {
            guard let requested = value.integer, (1...maximumDepth).contains(requested) else {
                throw HostLeaseError.invalidParameters
            }
            depth = requested
        }
        var focused = true
        if let value = params["focused_app"] {
            guard case .boolean(let requested) = value else { throw HostLeaseError.invalidParameters }
            focused = requested
        }
        var extras = false
        if let value = params["menu_extras"] {
            guard case .boolean(let requested) = value else { throw HostLeaseError.invalidParameters }
            extras = requested
        }
        return HostAXRequest(depth: depth, focusedApplicationOnly: focused, menuExtras: extras)
    }
}

/// Attribute values read from one element. frame is in global display points
/// (top-left origin), exactly as the Accessibility API reports it.
struct HostAXAttributes: Equatable {
    var role: String?
    var subrole: String?
    var label: String?
    var value: String?
    var frame: CGRect?

    /// Secure text never leaves the host, even as a length.
    var isSecure: Bool { role == "AXSecureTextField" || subrole == "AXSecureTextField" }
}

/// One element handle. Children are fetched lazily so traversal can stop at
/// its depth, node and time budgets without reading the rest of the tree.
/// A handle names one element object, not a tree position: once that element
/// is destroyed every read reports invalid rather than a successor.
protocol HostAXNode {
    func attributes() -> HostAXAttributes
    func children(limit: Int) -> [HostAXNode]
    /// The state an action is planned and verified against. Never prompts.
    func liveState() -> HostAXLiveRead
    /// Exactly one Accessibility call; no synthetic events are posted.
    func perform(_ operation: HostAXOperation) -> HostAXPerformResult
}

struct HostAXApplication {
    let processID: pid_t
    let bundleID: String?
    let name: String?
    let root: HostAXNode
}

/// Real provider: AXUIElement. Tests supply a fake provider and nodes.
protocol HostAccessibilityProvider {
    /// AXIsProcessTrusted for the real provider. Never prompts.
    func isTrusted() -> Bool
    /// Called on the main actor; traversal of the returned roots may run elsewhere.
    func applications(focusedOnly: Bool, menuExtras: Bool, excluding processID: pid_t) -> [HostAXApplication]
    /// True for an out-of-process element's owner that is a system view
    /// service rather than a regular app: its remote views may refuse actions.
    func isSystemRemoteViewService(processID: pid_t) -> Bool
    /// The process's executable name, or nil when it cannot be read.
    func executableName(processID: pid_t) -> String?
}

/// Builds the bounded, framebuffer-mapped snapshot. Pure over the provider's
/// nodes; it never caches a tree and never returns a previous snapshot.
enum HostAccessibilitySnapshot {
    static let schema = "fruitctl.ax-snapshot.v1"
    static let maximumNodes = 1_500
    static let maximumChildren = 200
    static let maximumText = 256
    /// Traversal budget. The broker's helper round trip is 500 ms, so the
    /// snapshot stops early and reports truncated instead of overrunning it.
    static let budgetNanoseconds: UInt64 = 200_000_000

    static func build(applications: [HostAXApplication], request: HostAXRequest,
                      geometry: HostDisplayGeometry, maximumNodes: Int = HostAccessibilitySnapshot.maximumNodes,
                      expired: () -> Bool) throws -> [String: HostValue] {
        try buildRetained(applications: applications, request: request, geometry: geometry,
                          maximumNodes: maximumNodes, expired: expired).value
    }

    /// The snapshot plus a handle for every reported ref. The Host keeps only
    /// the latest successful build as the generation actions resolve against.
    static func buildRetained(applications: [HostAXApplication], request: HostAXRequest,
                              geometry: HostDisplayGeometry, generation: UInt64? = nil,
                              maximumNodes: Int = HostAccessibilitySnapshot.maximumNodes,
                              expired: () -> Bool) throws -> HostAXSnapshotBuild {
        var nodes: [HostValue] = []
        var roots: [HostValue] = []
        var elements: [String: HostAXRetainedElement] = [:]
        var truncated = false
        // Breadth first: every window's top levels are reported before any
        // one subtree can consume the whole node budget.
        var queue: [(node: HostAXNode, ref: String, parent: String?, depth: Int, owner: Int)] = []
        for (owner, application) in applications.enumerated() {
            let ref = "ax:\(application.processID):0"
            roots.append(.object([
                "pid": .integer(Int64(application.processID)), "ref": .string(ref),
                "bundle_id": application.bundleID.map { .string(bounded($0)) } ?? .null,
                "name": application.name.map { .string(bounded($0)) } ?? .null]))
            queue.append((application.root, ref, nil, 0, owner))
        }
        var index = 0
        while index < queue.count {
            try Task.checkCancellation()
            guard nodes.count < maximumNodes, !expired() else { truncated = true; break }
            let entry = queue[index]
            index += 1
            let attributes = entry.node.attributes()
            nodes.append(.object(record(attributes, ref: entry.ref, parent: entry.parent,
                                        depth: entry.depth, geometry: geometry)))
            let application = applications[entry.owner]
            elements[entry.ref] = HostAXRetainedElement(node: entry.node, parent: entry.parent,
                processID: application.processID, bundleID: application.bundleID,
                role: attributes.role, subrole: attributes.subrole)
            guard entry.depth < request.depth else { continue }
            let children = entry.node.children(limit: maximumChildren + 1)
            if children.count > maximumChildren { truncated = true }
            for (offset, child) in children.prefix(maximumChildren).enumerated() {
                queue.append((child, entry.ref + "." + String(offset), entry.ref, entry.depth + 1, entry.owner))
            }
        }
        var snapshot: [String: HostValue] = [
            "schema": .string(schema), "coordinate_space": .string("framebuffer_pixels"),
            "framebuffer": .object(geometry.metadata), "depth": .integer(Int64(request.depth)),
            "focused_app": .boolean(request.focusedApplicationOnly),
            "menu_extras": .boolean(request.menuExtras),
            "applications": .array(roots), "nodes": .array(nodes),
            "node_count": .integer(Int64(nodes.count)), "truncated": .boolean(truncated)]
        if let generation { snapshot["generation"] = .integer(Int64(clamping: generation)) }
        return HostAXSnapshotBuild(value: ["ax_snapshot": .object(snapshot)], elements: elements)
    }

    static func record(_ attributes: HostAXAttributes, ref: String, parent: String?, depth: Int,
                       geometry: HostDisplayGeometry) -> [String: HostValue] {
        var result: [String: HostValue] = ["ref": .string(ref), "parent": parent.map { .string($0) } ?? .null,
                                           "depth": .integer(Int64(depth)),
                                           "role": .string(bounded(attributes.role.flatMap {
                                               $0.isEmpty ? nil : $0 } ?? "AXUnknown"))]
        if let subrole = attributes.subrole { result["subrole"] = .string(bounded(subrole)) }
        if let label = attributes.label, !label.isEmpty { result["label"] = .string(bounded(label)) }
        if attributes.isSecure {
            result["value_redacted"] = .boolean(true)
        } else if let value = attributes.value, !value.isEmpty {
            result["value"] = .string(bounded(value))
        }
        if let frame = attributes.frame, let pixels = geometry.pixelRect(forGlobalPoints: frame) {
            result["frame"] = .object(["x": .integer(Int64(pixels.x)), "y": .integer(Int64(pixels.y)),
                                       "width": .integer(Int64(pixels.width)),
                                       "height": .integer(Int64(pixels.height))])
        } else {
            result["frame"] = .null
        }
        return result
    }

    /// Bounds UTF-16 length (the broker's string length) on a character
    /// boundary, so truncation never splits a surrogate pair or a grapheme.
    static func bounded(_ text: String) -> String {
        guard text.utf16.count > maximumText else { return text }
        var length = 0
        var end = text.startIndex
        for character in text {
            length += character.utf16.count
            guard length <= maximumText else { break }
            end = text.index(after: end)
        }
        return String(text[..<end])
    }
}

/// AXUIElement is an immutable CF reference to a remote element; reads are
/// synchronous IPC bounded by the process-wide messaging timeout.
struct HostSystemAXNode: HostAXNode, @unchecked Sendable {
    let element: AXUIElement
    /// Application roots read for menu extras list the extras menu bar first.
    /// It is an attribute of the application, not one of its children.
    var includesExtrasMenuBar = false

    static let identityAttributes = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute,
                                     kAXDescriptionAttribute, kAXPositionAttribute, kAXSizeAttribute]

    /// One IPC for identity and geometry; the value is read in a second call
    /// only after the role proves the element is not a secure text field.
    func attributes() -> HostAXAttributes {
        var result = HostAXAttributes()
        var copied: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(element, Self.identityAttributes as CFArray,
                                                     AXCopyMultipleAttributeOptions(rawValue: 0),
                                                     &copied) == .success,
              let values = copied as? [AnyObject], values.count == Self.identityAttributes.count else {
            return result
        }
        result.role = values[0] as? String
        result.subrole = values[1] as? String
        result.label = (values[2] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? values[3] as? String
        if let origin = Self.axValue(values[4], type: .cgPoint, as: CGPoint.zero),
           let size = Self.axValue(values[5], type: .cgSize, as: CGSize.zero) {
            result.frame = CGRect(origin: origin, size: size)
        }
        if !result.isSecure { result.value = valueText() }
        return result
    }

    func children(limit: Int) -> [HostAXNode] {
        var result: [HostAXNode] = []
        if includesExtrasMenuBar, limit > 0 {
            var extras: AnyObject?
            if AXUIElementCopyAttributeValue(element, "AXExtrasMenuBar" as CFString, &extras) == .success,
               let extras, CFGetTypeID(extras) == AXUIElementGetTypeID() {
                result.append(HostSystemAXNode(element: extras as! AXUIElement))
            }
        }
        var values: CFArray?
        guard limit > result.count, AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0,
                                                                   limit - result.count, &values) == .success,
              let items = values as? [AnyObject] else { return result }
        return result + items.compactMap { item -> HostAXNode? in
            guard CFGetTypeID(item) == AXUIElementGetTypeID() else { return nil }
            return HostSystemAXNode(element: item as! AXUIElement)
        }
    }

    static let liveAttributes = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                                 kAXPositionAttribute, kAXSizeAttribute, "AXFocused", "AXMain", "AXSelected",
                                 "AXExpanded", "AXEnabled"]

    /// One multi-attribute IPC plus action names, focus settability, child
    /// count and owner. Secure text values are never read.
    func liveState() -> HostAXLiveRead {
        var copied: CFArray?
        switch AXUIElementCopyMultipleAttributeValues(element, Self.liveAttributes as CFArray,
                                                      AXCopyMultipleAttributeOptions(rawValue: 0), &copied) {
        case .success: break
        case .invalidUIElement: return .invalid
        default: return .unresponsive
        }
        guard let values = copied as? [AnyObject], values.count == Self.liveAttributes.count else {
            return .unresponsive
        }
        var state = HostAXLiveState()
        state.role = values[0] as? String
        state.subrole = values[1] as? String
        state.label = (values[2] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? values[3] as? String
        if let origin = Self.axValue(values[4], type: .cgPoint, as: CGPoint.zero),
           let size = Self.axValue(values[5], type: .cgSize, as: CGSize.zero) {
            state.frame = CGRect(origin: origin, size: size)
        }
        state.focused = Self.boolean(values[6])
        state.main = Self.boolean(values[7])
        state.selected = Self.boolean(values[8])
        state.expanded = Self.boolean(values[9])
        state.enabled = Self.boolean(values[10])
        let secure = state.role == "AXSecureTextField" || state.subrole == "AXSecureTextField"
        if !secure { state.value = valueText() }
        var count: CFIndex = 0
        if AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count) == .success {
            state.childCount = count
        }
        var names: CFArray?
        if AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] {
            state.actions = list
        }
        var settable: DarwinBoolean = false
        if AXUIElementIsAttributeSettable(element, "AXFocused" as CFString, &settable) == .success {
            state.focusSettable = settable.boolValue
        }
        var owner: pid_t = 0
        if AXUIElementGetPid(element, &owner) == .success, owner > 0 { state.ownerProcessID = owner }
        return .live(state)
    }

    func perform(_ operation: HostAXOperation) -> HostAXPerformResult {
        switch operation {
        case .focus:
            return HostAXPerformResult(AXUIElementSetAttributeValue(element, "AXFocused" as CFString, kCFBooleanTrue))
        case .press, .showMenu, .raise:
            return HostAXPerformResult(AXUIElementPerformAction(element, operation.rawValue as CFString))
        }
    }

    private static func boolean(_ value: AnyObject) -> Bool? {
        guard CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
        return (value as? NSNumber)?.boolValue
    }

    private func valueText() -> String? {
        var copied: AnyObject?
        guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &copied) == .success,
              let value = copied else { return nil }
        if let text = value as? String { return text }
        if CFGetTypeID(value) == CFNumberGetTypeID() || CFGetTypeID(value) == CFBooleanGetTypeID(),
           let number = value as? NSNumber { return number.stringValue }
        return nil
    }

    /// Failed attributes arrive as AXValue of type axError and map to nil.
    private static func axValue<T>(_ value: AnyObject, type: AXValueType, as initial: T) -> T? {
        guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        let axValue = value as! AXValue
        var result = initial
        guard AXValueGetType(axValue) == type, AXValueGetValue(axValue, type, &result) else { return nil }
        return result
    }
}

final class HostSystemAccessibilityProvider: HostAccessibilityProvider {
    /// Per-request messaging timeout. An unresponsive application cannot hold
    /// the snapshot past its budget.
    static let messagingTimeoutSeconds: Float = 0.05

    init() {
        _ = AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), Self.messagingTimeoutSeconds)
    }

    func isTrusted() -> Bool { AXIsProcessTrusted() }

    /// System processes that own menu-bar extras and the Control Center panel.
    static let systemMenuExtraOwners: Set<String> = ["com.apple.controlcenter", "com.apple.systemuiserver"]

    func applications(focusedOnly: Bool, menuExtras: Bool, excluding processID: pid_t) -> [HostAXApplication] {
        var candidates: [NSRunningApplication]
        if focusedOnly {
            candidates = NSWorkspace.shared.frontmostApplication.map { [$0] } ?? []
        } else {
            candidates = NSWorkspace.shared.runningApplications.filter {
                $0.activationPolicy == .regular && !$0.isHidden
            }
        }
        if menuExtras {
            var seen = Set(candidates.map(\.processIdentifier))
            for application in NSWorkspace.shared.runningApplications where
                application.activationPolicy == .accessory
                    || Self.systemMenuExtraOwners.contains(application.bundleIdentifier ?? "") {
                if seen.insert(application.processIdentifier).inserted { candidates.append(application) }
            }
        }
        return candidates.filter { $0.processIdentifier != processID && !$0.isTerminated }.map {
            HostAXApplication(processID: $0.processIdentifier, bundleID: $0.bundleIdentifier,
                              name: $0.localizedName,
                              root: HostSystemAXNode(element: AXUIElementCreateApplication($0.processIdentifier),
                                                     includesExtrasMenuBar: menuExtras))
        }
    }

    /// An XPC view service is not a registered app; a non-regular Apple
    /// process hosting another app's element is a system remote view service.
    func isSystemRemoteViewService(processID: pid_t) -> Bool {
        guard let application = NSRunningApplication(processIdentifier: processID) else { return true }
        guard application.activationPolicy != .regular else { return false }
        let bundle = application.bundleIdentifier ?? ""
        return bundle.isEmpty || bundle.hasPrefix("com.apple.")
    }

    func executableName(processID: pid_t) -> String? {
        if let name = NSRunningApplication(processIdentifier: processID)?.executableURL?.lastPathComponent {
            return name
        }
        // A view service is not a registered app; read its path directly.
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(processID, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        return buffer.withUnsafeBufferPointer { URL(fileURLWithPath: String(cString: $0.baseAddress!)).lastPathComponent }
    }
}
