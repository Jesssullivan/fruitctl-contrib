import ApplicationServices
import CoreGraphics
import Foundation

/// Typed refusals for click_element / focus_element. None of them is raised
/// after an Accessibility call that may have acted.
enum HostAXActionError: String, Error {
    /// The ref is not in the latest snapshot generation of this activity, or
    /// its element no longer exists.
    case staleRef = "stale_ref"
    /// A system remote view service (or an unresponsive owner) refused or did
    /// not answer; the Host never guesses a coordinate for it.
    case unreachable = "ax_unreachable"
    /// No Accessibility action applies and no safe VNC fallback point exists.
    case unsupported = "ax_action_unsupported"
    /// A consent, authorization or system dialog owns the element; a human
    /// answers it. The broker's desktop-state code for the same condition.
    case consentDialog = "human_consent_required"
}

enum HostAXActionKind: String { case press, focus }

/// The single Accessibility call an action makes. Raw values are AX names.
enum HostAXOperation: String {
    case press = "AXPress", showMenu = "AXShowMenu", raise = "AXRaise", focus = "AXFocused"

    var path: String {
        switch self {
        case .press: return "ax_press"
        case .showMenu: return "ax_show_menu"
        case .raise: return "ax_raise"
        case .focus: return "ax_focus"
        }
    }
}

enum HostAXPerformResult: Equatable {
    /// The element accepted the call.
    case performed
    /// The element definitely did not act (unsupported action or attribute).
    case unsupported
    /// The call may have acted (timeout, busy owner, generic failure). Never
    /// retried and never followed by a VNC click.
    case indeterminate
    case invalid
    case permissionRequired

    init(_ status: AXError) {
        switch status {
        case .success: self = .performed
        case .actionUnsupported, .attributeUnsupported, .notImplemented, .illegalArgument, .noValue:
            self = .unsupported
        case .invalidUIElement: self = .invalid
        case .apiDisabled: self = .permissionRequired
        default: self = .indeterminate
        }
    }
}

/// One live read of an element. Values are compared on the Host only.
struct HostAXLiveState: Equatable {
    var role: String?
    var subrole: String?
    var label: String?
    var value: String?
    var frame: CGRect?
    var actions: [String] = []
    var focusSettable = false
    var focused: Bool?
    var main: Bool?
    var selected: Bool?
    var expanded: Bool?
    var enabled: Bool?
    var childCount: Int?
    var ownerProcessID: pid_t?
}

enum HostAXLiveRead: Equatable {
    case live(HostAXLiveState)
    /// The element was destroyed.
    case invalid
    /// The owner did not answer within the messaging timeout.
    case unresponsive
}

/// A reported ref's element handle and the recorded identity of its path.
struct HostAXRetainedElement: @unchecked Sendable {
    let node: HostAXNode
    let parent: String?
    let processID: pid_t
    let bundleID: String?
    let role: String?
    let subrole: String?
}

struct HostAXSnapshotBuild: @unchecked Sendable {
    let value: [String: HostValue]
    let elements: [String: HostAXRetainedElement]
}

struct HostAXActionRequest: Equatable {
    static let maximumRefLength = 64
    let generation: UInt64
    let ref: String
    let kind: HostAXActionKind
    /// The broker can click the element's centre through its qualified input
    /// mapping. Without it an unsupported AX action is a typed refusal.
    let vncFallback: Bool

    static func parse(_ params: [String: HostValue]) throws -> HostAXActionRequest {
        guard let generation = params["generation"]?.unsigned, generation > 0,
              let ref = params["ref"]?.string, validRef(ref),
              let name = params["action"]?.string, let kind = HostAXActionKind(rawValue: name) else {
            throw HostLeaseError.invalidParameters
        }
        var fallback = false
        if let value = params["vnc_fallback"] {
            guard case .boolean(let allowed) = value else { throw HostLeaseError.invalidParameters }
            fallback = allowed
        }
        return HostAXActionRequest(generation: generation, ref: ref, kind: kind, vncFallback: fallback)
    }

    static func validRef(_ ref: String) -> Bool {
        ref.hasPrefix("ax:") && ref.utf8.count <= maximumRefLength
            && ref.utf8.dropFirst(3).allSatisfy { ($0 >= 48 && $0 <= 57) || $0 == 46 || $0 == 58 }
    }
}

enum HostAXSurface: String {
    case controlCenter = "control_center", menuExtra = "menu_extra", menu, menuBar = "menu_bar"
    case popover, sheet, window, application

    static func of(role: String?, subrole: String?) -> HostAXSurface? {
        if subrole == "AXMenuExtra" { return .menuExtra }
        switch role {
        case "AXSheet": return .sheet
        case "AXPopover": return .popover
        case "AXMenu", "AXMenuItem": return .menu
        case "AXMenuBar", "AXMenuBarItem": return .menuBar
        case "AXWindow": return .window
        default: return nil
        }
    }
}

/// The latest successful snapshot of one activity. Refs resolve only here;
/// a newer snapshot, a lease change, Stop or a display change discards it.
struct HostAXGeneration {
    let number: UInt64
    let sessionID: String
    let displayGeneration: UInt64
    let geometry: HostDisplayGeometry
    let elements: [String: HostAXRetainedElement]

    func resolve(_ request: HostAXActionRequest, sessionID: String, displayGeneration: UInt64,
                 geometry current: HostDisplayGeometry?) throws -> HostAXRetainedElement {
        guard request.generation == number, sessionID == self.sessionID,
              displayGeneration == self.displayGeneration, current == geometry,
              let element = elements[request.ref] else { throw HostAXActionError.staleRef }
        return element
    }

    /// The nearest enclosing transient or window surface, from recorded roles.
    func surface(of ref: String) -> HostAXSurface {
        var cursor: String? = ref
        var found = HostAXSurface.application
        var steps = 0
        while let current = cursor, let element = elements[current], steps <= HostAXRequest.maximumDepth {
            if let match = HostAXSurface.of(role: element.role, subrole: element.subrole) { found = match; break }
            cursor = element.parent
            steps += 1
        }
        if elements[ref]?.bundleID == "com.apple.controlcenter", found != .menuExtra { return .controlCenter }
        return found
    }
}

enum HostAXPlan: Equatable {
    case perform(HostAXOperation)
    /// Framebuffer pixel centre of the element's live visible frame.
    case vncClick(x: Int, y: Int)
}

enum HostAXActionPlanner {
    /// Pre-read, the one AX call and verification fit inside the broker's
    /// 500 ms helper round trip.
    static let budgetNanoseconds: UInt64 = 250_000_000
    static let pollNanoseconds: UInt64 = 25_000_000

    /// Clicking the centre of a container would press whatever child is there.
    static let containerRoles: Set<String> = ["AXApplication", "AXWindow", "AXSheet", "AXPopover", "AXDrawer",
        "AXGroup", "AXScrollArea", "AXSplitGroup", "AXLayoutArea", "AXList", "AXOutline", "AXTable",
        "AXBrowser", "AXToolbar", "AXTabGroup", "AXMenuBar", "AXMenu", "AXGrid", "AXWebArea", "AXUnknown"]

    /// Executables that draw consent, authorization and system dialogs, the
    /// same set the broker's desktop-state sentinel watches. No element they
    /// own is pressed, focused or clicked, even when the sentinel is off or
    /// could not read the desktop.
    static let consentDialogOwners: Set<String> = ["UserNotificationCenter", "universalAccessAuthWarn",
        "SecurityAgent", "CoreServicesUIAgent", "SoftwareUpdateNotificationManager"]

    /// Refuses before any Accessibility call when the snapshot application
    /// or the element's live owner is a dialog owner.
    static func refuseConsentDialog(ownerExecutables: [String?]) throws {
        if ownerExecutables.contains(where: { $0.map(consentDialogOwners.contains) ?? false }) {
            throw HostAXActionError.consentDialog
        }
    }

    static func operation(for kind: HostAXActionKind, state: HostAXLiveState,
                          surface: HostAXSurface) -> HostAXOperation? {
        switch kind {
        case .press:
            if state.actions.contains("AXPress") { return .press }
            // Some status items expose only the menu action.
            if surface == .menuExtra || surface == .menuBar, state.actions.contains("AXShowMenu") {
                return .showMenu
            }
            return nil
        case .focus:
            if state.focusSettable { return .focus }
            if state.role == "AXWindow", state.actions.contains("AXRaise") { return .raise }
            return nil
        }
    }

    /// Only for an element AX has not acted on.
    static func vncClick(state: HostAXLiveState, geometry: HostDisplayGeometry, remoteViewService: Bool,
                         allowed: Bool) throws -> HostAXPlan {
        if remoteViewService { throw HostAXActionError.unreachable }
        guard allowed, let role = state.role, !containerRoles.contains(role), let frame = state.frame,
              let pixels = geometry.pixelRect(forGlobalPoints: frame) else {
            throw HostAXActionError.unsupported
        }
        return .vncClick(x: pixels.x + pixels.width / 2, y: pixels.y + pixels.height / 2)
    }

    static func plan(_ kind: HostAXActionKind, state: HostAXLiveState, surface: HostAXSurface,
                     geometry: HostDisplayGeometry, remoteViewService: Bool, vncFallback: Bool) throws -> HostAXPlan {
        if let operation = operation(for: kind, state: state, surface: surface) { return .perform(operation) }
        return try vncClick(state: state, geometry: geometry, remoteViewService: remoteViewService,
                            allowed: vncFallback)
    }
}

enum HostAXVerifier {
    /// What a press is expected to change. Frame and role are excluded: a
    /// press that only repaints is not evidence.
    private struct Fingerprint: Equatable {
        let label: String?, value: String?, focused: Bool?, main: Bool?
        let selected: Bool?, expanded: Bool?, enabled: Bool?, childCount: Int?
        init(_ state: HostAXLiveState) {
            label = state.label; value = state.value; focused = state.focused; main = state.main
            selected = state.selected; expanded = state.expanded; enabled = state.enabled
            childCount = state.childCount
        }
    }

    /// focus: the element (or a raised window) reports focus. press: its state
    /// changed or it was destroyed (a sheet or menu closed). An unresponsive
    /// owner verifies nothing.
    static func satisfied(_ kind: HostAXActionKind, operation: HostAXOperation?, before: HostAXLiveState,
                          after: HostAXLiveRead) -> Bool {
        switch after {
        case .unresponsive: return false
        case .invalid: return kind == .press
        case .live(let state):
            switch kind {
            case .focus: return state.focused == true || (operation == .raise && state.main == true)
            case .press: return Fingerprint(state) != Fingerprint(before)
            }
        }
    }

    /// Reads until satisfied or expired; at least one read always happens.
    static func poll(_ kind: HostAXActionKind, operation: HostAXOperation?, before: HostAXLiveState,
                     read: () -> HostAXLiveRead, expired: () -> Bool, pause: () -> Void) -> Bool {
        while true {
            if satisfied(kind, operation: operation, before: before, after: read()) { return true }
            if expired() { return false }
            pause()
        }
    }
}

/// The before-state of a VNC fallback click, consumed by one ax_verify.
struct HostAXPendingVerification {
    let generation: UInt64
    let ref: String
    let kind: HostAXActionKind
    let before: HostAXLiveState

    func matches(_ request: HostAXActionRequest) -> Bool {
        request.generation == generation && request.ref == ref && request.kind == kind
    }
}

struct HostAXActionOutcome {
    let request: HostAXActionRequest
    let surface: HostAXSurface
    let state: HostAXLiveState
    /// ax_press, ax_show_menu, ax_focus, ax_raise, or vnc_click_required.
    let path: String
    let axResult: HostAXPerformResult?
    let verified: Bool?
    let point: (x: Int, y: Int)?

    var metadata: [String: HostValue] {
        var result: [String: HostValue] = [
            "ref": .string(request.ref), "action": .string(request.kind.rawValue),
            "generation": .integer(Int64(clamping: request.generation)), "path": .string(path),
            "surface": .string(surface.rawValue),
            "role": .string(HostAccessibilitySnapshot.bounded(state.role ?? "AXUnknown"))]
        if let subrole = state.subrole { result["subrole"] = .string(HostAccessibilitySnapshot.bounded(subrole)) }
        if let axResult {
            result["ax_result"] = .string(axResult == .performed ? "performed" : "indeterminate")
        }
        if let verified { result["verified"] = .boolean(verified) }
        if let point {
            result["fallback_point"] = .object(["x": .integer(Int64(point.x)), "y": .integer(Int64(point.y))])
        }
        return result
    }
}
