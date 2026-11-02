import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation

/// Typed refusals of the Host input route (#157). Every one is raised before
/// the request posts its first event, so the lease is kept. An action that
/// stops after posting is a completed reply with `completed: false`.
enum HostInputError: String, Error {
    /// The local "Enable agent input" opt-in is off. IPC cannot change it.
    case disabled = "input_disabled"
    /// This process may not post events (Accessibility not granted).
    case permissionRequired = "input_permission_required"
    /// Secure event input is on, or the focused element is a secure field.
    case secureInput = "secure_input_active"
    /// The frontmost application, process or window is not the target.
    case targetMismatch = "input_target_mismatch"
    /// The window under the pointer belongs to another process.
    case windowMismatch = "input_window_mismatch"
    /// Operator input arrived within the yield window.
    case operatorInput = "operator_input_detected"
}

enum HostInputKind: String, CaseIterable {
    case click, doubleClick = "double_click", tripleClick = "triple_click", move, drag, scroll, key, type
    /// Makes the target application frontmost. It posts no event.
    case activate

    var pointer: Bool { ![.key, .type, .activate].contains(self) }
    var clickCount: Int64? {
        switch self {
        case .click: return 1
        case .doubleClick: return 2
        case .tripleClick: return 3
        default: return nil
        }
    }
}

enum HostMouseButton: String {
    case left, right, middle
    var cg: CGMouseButton { self == .left ? .left : self == .right ? .right : .center }
    var downType: CGEventType { self == .left ? .leftMouseDown : self == .right ? .rightMouseDown : .otherMouseDown }
    var upType: CGEventType { self == .left ? .leftMouseUp : self == .right ? .rightMouseUp : .otherMouseUp }
    var dragType: CGEventType {
        self == .left ? .leftMouseDragged : self == .right ? .rightMouseDragged : .otherMouseDragged
    }
}

/// What the operator chose for their own input during an agent action.
/// `yield` refuses or stops the action; `assert` keeps going and reports it.
enum HostOperatorInputPolicy: String { case yield, assert }

/// The application, process and window the agent expects to receive input.
struct HostInputTarget: Equatable {
    static let maximumBundleLength = 255
    let bundleID: String
    let processID: pid_t?
    let windowTitle: String?

    static func validBundle(_ text: String) -> Bool {
        !text.isEmpty && text.utf8.count <= maximumBundleLength && text.utf8.allSatisfy {
            ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 46 || $0 == 45
        } && !text.hasPrefix(".") && !text.hasSuffix(".")
    }
}

/// Key names follow the VNC route's names (KeySymbols.swift) and map to ANSI
/// virtual key codes. Single printable ASCII characters map as on a US
/// keyboard; key commands are positional, so `cmd+s` is the S key.
enum HostKeyMap {
    struct Key: Equatable { let code: CGKeyCode; let shift: Bool }
    struct Modifier: Equatable { let code: CGKeyCode; let flag: CGEventFlags }

    static func modifier(_ name: String) -> Modifier? {
        switch name.lowercased() {
        case "shift", "lshift": return Modifier(code: CGKeyCode(kVK_Shift), flag: .maskShift)
        case "rshift": return Modifier(code: CGKeyCode(kVK_RightShift), flag: .maskShift)
        case "ctrl", "control": return Modifier(code: CGKeyCode(kVK_Control), flag: .maskControl)
        case "rctrl": return Modifier(code: CGKeyCode(kVK_RightControl), flag: .maskControl)
        case "alt", "option", "opt": return Modifier(code: CGKeyCode(kVK_Option), flag: .maskAlternate)
        case "ralt": return Modifier(code: CGKeyCode(kVK_RightOption), flag: .maskAlternate)
        case "cmd", "command", "meta", "super": return Modifier(code: CGKeyCode(kVK_Command), flag: .maskCommand)
        case "rcmd": return Modifier(code: CGKeyCode(kVK_RightCommand), flag: .maskCommand)
        default: return nil
        }
    }

    static let named: [String: Int] = [
        "tab": kVK_Tab, "return": kVK_Return, "enter": kVK_Return, "ret": kVK_Return,
        "escape": kVK_Escape, "esc": kVK_Escape, "backspace": kVK_Delete,
        "delete": kVK_ForwardDelete, "del": kVK_ForwardDelete,
        "home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp, "pgup": kVK_PageUp,
        "pagedown": kVK_PageDown, "pgdn": kVK_PageDown, "pgdown": kVK_PageDown,
        "up": kVK_UpArrow, "arrowup": kVK_UpArrow, "down": kVK_DownArrow, "arrowdown": kVK_DownArrow,
        "left": kVK_LeftArrow, "arrowleft": kVK_LeftArrow, "right": kVK_RightArrow, "arrowright": kVK_RightArrow,
        "space": kVK_Space, "spc": kVK_Space, "help": kVK_Help, "insert": kVK_Help, "ins": kVK_Help,
        "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6,
        "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
        "f13": kVK_F13, "f14": kVK_F14, "f15": kVK_F15, "f16": kVK_F16, "f17": kVK_F17, "f18": kVK_F18,
        "f19": kVK_F19, "f20": kVK_F20,
    ]

    /// Unshifted and shifted US ANSI characters on the same key.
    static let characters: [Character: (Int, Bool)] = {
        var table: [Character: (Int, Bool)] = [:]
        let letters: [(Character, Int)] = [("a", kVK_ANSI_A), ("b", kVK_ANSI_B), ("c", kVK_ANSI_C),
            ("d", kVK_ANSI_D), ("e", kVK_ANSI_E), ("f", kVK_ANSI_F), ("g", kVK_ANSI_G), ("h", kVK_ANSI_H),
            ("i", kVK_ANSI_I), ("j", kVK_ANSI_J), ("k", kVK_ANSI_K), ("l", kVK_ANSI_L), ("m", kVK_ANSI_M),
            ("n", kVK_ANSI_N), ("o", kVK_ANSI_O), ("p", kVK_ANSI_P), ("q", kVK_ANSI_Q), ("r", kVK_ANSI_R),
            ("s", kVK_ANSI_S), ("t", kVK_ANSI_T), ("u", kVK_ANSI_U), ("v", kVK_ANSI_V), ("w", kVK_ANSI_W),
            ("x", kVK_ANSI_X), ("y", kVK_ANSI_Y), ("z", kVK_ANSI_Z)]
        for (letter, code) in letters {
            table[letter] = (code, false)
            table[Character(letter.uppercased())] = (code, true)
        }
        let pairs: [(Character, Character, Int)] = [("1", "!", kVK_ANSI_1), ("2", "@", kVK_ANSI_2),
            ("3", "#", kVK_ANSI_3), ("4", "$", kVK_ANSI_4), ("5", "%", kVK_ANSI_5), ("6", "^", kVK_ANSI_6),
            ("7", "&", kVK_ANSI_7), ("8", "*", kVK_ANSI_8), ("9", "(", kVK_ANSI_9), ("0", ")", kVK_ANSI_0),
            ("-", "_", kVK_ANSI_Minus), ("=", "+", kVK_ANSI_Equal), ("[", "{", kVK_ANSI_LeftBracket),
            ("]", "}", kVK_ANSI_RightBracket), ("\\", "|", kVK_ANSI_Backslash), (";", ":", kVK_ANSI_Semicolon),
            ("'", "\"", kVK_ANSI_Quote), (",", "<", kVK_ANSI_Comma), (".", ">", kVK_ANSI_Period),
            ("/", "?", kVK_ANSI_Slash), ("`", "~", kVK_ANSI_Grave)]
        for (plain, shifted, code) in pairs {
            table[plain] = (code, false)
            table[shifted] = (code, true)
        }
        return table
    }()

    static func key(_ name: String) -> Key? {
        if let code = named[name.lowercased()] { return Key(code: CGKeyCode(code), shift: false) }
        guard name.count == 1, let character = name.first, let (code, shift) = characters[character] else {
            return nil
        }
        return Key(code: CGKeyCode(code), shift: shift)
    }
}

/// One validated input request. Coordinates are framebuffer pixels of the
/// configured display, the same space as `ax_snapshot` frames.
struct HostInputRequest: Equatable {
    static let maximumTextCharacters = 64
    static let maximumTextUTF16 = 256
    static let maximumScrollAmount = 20
    static let defaultOperatorIdleMilliseconds: UInt64 = 1_000

    let kind: HostInputKind
    let x: Int?, y: Int?, toX: Int?, toY: Int?
    let button: HostMouseButton
    let modifiers: [HostKeyMap.Modifier]
    let scrollDX: Int32, scrollDY: Int32
    let keys: [String]
    let text: String?
    let target: HostInputTarget
    let policy: HostOperatorInputPolicy
    let operatorIdleMilliseconds: UInt64

    static func parse(_ params: [String: HostValue]) throws -> HostInputRequest {
        let invalid = HostLeaseError.invalidParameters
        guard let kindName = params["kind"]?.string, let kind = HostInputKind(rawValue: kindName) else { throw invalid }
        func coordinate(_ name: String) throws -> Int? {
            guard let value = params[name] else { return nil }
            guard let number = value.integer, number >= 0, number <= 16_384 else { throw invalid }
            return number
        }
        let x = try coordinate("x"), y = try coordinate("y")
        let toX = try coordinate("to_x"), toY = try coordinate("to_y")
        if kind.pointer { guard x != nil, y != nil else { throw invalid } } else {
            // key, type and activate take no pointer position.
            guard x == nil, y == nil else { throw invalid }
        }
        if kind == .drag { guard toX != nil, toY != nil else { throw invalid } } else {
            guard toX == nil, toY == nil else { throw invalid }
        }
        var button = HostMouseButton.left
        if let value = params["button"] {
            guard kind.clickCount != nil || kind == .drag, let name = value.string,
                  let parsed = HostMouseButton(rawValue: name) else { throw invalid }
            button = parsed
        }
        var modifiers: [HostKeyMap.Modifier] = []
        if let value = params["modifiers"] {
            guard kind.clickCount != nil || kind == .drag, case .array(let names) = value,
                  !names.isEmpty, names.count <= 4 else { throw invalid }
            for item in names {
                guard let name = item.string, let modifier = HostKeyMap.modifier(name),
                      !modifiers.contains(where: { $0.code == modifier.code }) else { throw invalid }
                modifiers.append(modifier)
            }
        }
        var dx: Int32 = 0, dy: Int32 = 0
        if kind == .scroll {
            guard let direction = params["direction"]?.string else { throw invalid }
            var amount = 3
            if let value = params["amount"] {
                guard let number = value.integer, (1...maximumScrollAmount).contains(number) else { throw invalid }
                amount = number
            }
            // A positive line count scrolls content up (wheel away from the user).
            switch direction {
            case "up": dy = Int32(amount)
            case "down": dy = -Int32(amount)
            case "left": dx = Int32(amount)
            case "right": dx = -Int32(amount)
            default: throw invalid
            }
        } else if params["direction"] != nil || params["amount"] != nil { throw invalid }
        var keys: [String] = []
        if kind == .key {
            guard case .array(let names) = params["keys"] ?? .null, !names.isEmpty, names.count <= 6 else {
                throw invalid
            }
            keys = try names.map { item in
                guard let name = item.string, name.utf8.count <= 32 else { throw invalid }
                return name
            }
            // Modifiers first, then exactly one key.
            guard HostKeyMap.key(keys.last!) != nil,
                  keys.dropLast().allSatisfy({ HostKeyMap.modifier($0) != nil }),
                  Set(keys.dropLast().map { HostKeyMap.modifier($0)!.code }).count == keys.count - 1 else {
                throw invalid
            }
        } else if params["keys"] != nil { throw invalid }
        var text: String?
        if kind == .type {
            guard let value = params["text"]?.string, !value.isEmpty,
                  value.count <= maximumTextCharacters, value.utf16.count <= maximumTextUTF16,
                  // No control characters other than newline and tab.
                  value.unicodeScalars.allSatisfy({ $0 == "\n" || $0 == "\t" || !($0.value < 0x20 || $0.value == 0x7F) })
            else { throw invalid }
            text = value
        } else if params["text"] != nil { throw invalid }
        guard case .object(let target) = params["target"] ?? .null,
              let bundle = target["bundle_id"]?.string, HostInputTarget.validBundle(bundle) else { throw invalid }
        var pid: pid_t?
        if let value = target["pid"] {
            guard let number = value.integer, number > 0, number <= Int(Int32.max) else { throw invalid }
            pid = pid_t(number)
        }
        var title: String?
        if let value = target["window_title"] {
            guard let text = value.string, !text.isEmpty, text.utf16.count <= 256 else { throw invalid }
            title = text
        }
        guard Set(target.keys).isSubset(of: ["bundle_id", "pid", "window_title"]) else { throw invalid }
        var policy = HostOperatorInputPolicy.yield
        if let value = params["operator_input"] {
            guard let name = value.string, let parsed = HostOperatorInputPolicy(rawValue: name) else { throw invalid }
            policy = parsed
        }
        var idle = defaultOperatorIdleMilliseconds
        if let value = params["operator_idle_ms"] {
            guard let number = value.integer, (0...10_000).contains(number) else { throw invalid }
            idle = UInt64(number)
        }
        return HostInputRequest(kind: kind, x: x, y: y, toX: toX, toY: toY, button: button, modifiers: modifiers,
                                scrollDX: dx, scrollDY: dy, keys: keys, text: text,
                                target: HostInputTarget(bundleID: bundle, processID: pid, windowTitle: title),
                                policy: policy, operatorIdleMilliseconds: idle)
    }
}

extension HostDisplayGeometry {
    /// The global point at the centre of one framebuffer pixel, or nil
    /// outside this display. The inverse of pixelRect(forGlobalPoints:).
    func globalPoint(pixelX: Int, pixelY: Int) -> CGPoint? {
        guard (0..<pixelWidth).contains(pixelX), (0..<pixelHeight).contains(pixelY) else { return nil }
        return CGPoint(x: Double(bounds.minX) + (Double(pixelX) + 0.5) / scale,
                       y: Double(bounds.minY) + (Double(pixelY) + 0.5) / scale)
    }
}

/// One event, or a pause, with the modifier flags it carries.
enum HostInputStep: Equatable {
    case move(CGPoint)
    case button(HostMouseButton, down: Bool, at: CGPoint, clicks: Int64, flags: CGEventFlags)
    case drag(HostMouseButton, CGPoint, flags: CGEventFlags)
    case scroll(dy: Int32, dx: Int32, at: CGPoint)
    case key(CGKeyCode, down: Bool, modifier: Bool, flags: CGEventFlags)
    /// A key down and up pair carrying this text, independent of layout.
    case text(String)
    case pause(milliseconds: UInt64)

    var posts: Int { if case .pause = self { return 0 }; if case .text = self { return 2 }; return 1 }
}

/// Pure planner: request plus geometry to an exact step list.
enum HostInputPlanner {
    /// The Host must answer within 2.5 s; one action stays well inside it.
    static let maximumDurationMilliseconds: UInt64 = 1_600
    static let clickHold: UInt64 = 40, settle: UInt64 = 15, multiClickGap: UInt64 = 60
    static let modifierSettle: UInt64 = 10, keyHold: UInt64 = 25, typeGap: UInt64 = 6
    static let dragPress: UInt64 = 50, dragStep: UInt64 = 8, scrollTick: UInt64 = 16

    static func plan(_ request: HostInputRequest, geometry: HostDisplayGeometry) throws -> [HostInputStep] {
        let invalid = HostLeaseError.invalidParameters
        func point(_ x: Int?, _ y: Int?) throws -> CGPoint {
            guard let x, let y, let point = geometry.globalPoint(pixelX: x, pixelY: y) else { throw invalid }
            return point
        }
        var steps: [HostInputStep] = []
        // Flags are the union of the modifiers still held, so releasing left
        // Shift keeps the flag while right Shift is down.
        var held: [HostKeyMap.Modifier] = []
        var flags: CGEventFlags { held.reduce(into: CGEventFlags()) { $0.insert($1.flag) } }
        func press(_ modifiers: [HostKeyMap.Modifier]) {
            for modifier in modifiers {
                held.append(modifier)
                steps.append(.key(modifier.code, down: true, modifier: true, flags: flags))
                steps.append(.pause(milliseconds: modifierSettle))
            }
        }
        func lift(_ modifiers: [HostKeyMap.Modifier]) {
            for modifier in modifiers.reversed() {
                held.removeAll { $0.code == modifier.code }
                steps.append(.key(modifier.code, down: false, modifier: true, flags: flags))
                steps.append(.pause(milliseconds: modifierSettle))
            }
        }
        switch request.kind {
        case .click, .doubleClick, .tripleClick:
            let at = try point(request.x, request.y)
            steps.append(.move(at)); steps.append(.pause(milliseconds: settle))
            press(request.modifiers)
            for click in 1...request.kind.clickCount! {
                if click > 1 { steps.append(.pause(milliseconds: multiClickGap)) }
                steps.append(.button(request.button, down: true, at: at, clicks: click, flags: flags))
                steps.append(.pause(milliseconds: clickHold))
                steps.append(.button(request.button, down: false, at: at, clicks: click, flags: flags))
            }
            lift(request.modifiers)
        case .move:
            steps.append(.move(try point(request.x, request.y)))
        case .drag:
            let from = try point(request.x, request.y), to = try point(request.toX, request.toY)
            steps.append(.move(from)); steps.append(.pause(milliseconds: settle))
            press(request.modifiers)
            steps.append(.button(request.button, down: true, at: from, clicks: 1, flags: flags))
            steps.append(.pause(milliseconds: dragPress))
            let distance = hypot(Double(to.x - from.x), Double(to.y - from.y)) * geometry.scale
            let count = max(10, min(60, Int((distance / 20).rounded(.up))))
            for index in 1...count {
                let ratio = Double(index) / Double(count)
                steps.append(.drag(request.button, CGPoint(x: Double(from.x) + Double(to.x - from.x) * ratio,
                                                           y: Double(from.y) + Double(to.y - from.y) * ratio),
                                   flags: flags))
                steps.append(.pause(milliseconds: dragStep))
            }
            steps.append(.pause(milliseconds: settle))
            steps.append(.button(request.button, down: false, at: to, clicks: 1, flags: flags))
            lift(request.modifiers)
        case .scroll:
            let at = try point(request.x, request.y)
            steps.append(.move(at)); steps.append(.pause(milliseconds: settle))
            let ticks = max(abs(request.scrollDY), abs(request.scrollDX))
            for _ in 0..<ticks {
                steps.append(.scroll(dy: request.scrollDY.signum(), dx: request.scrollDX.signum(), at: at))
                steps.append(.pause(milliseconds: scrollTick))
            }
        case .key:
            let modifiers = request.keys.dropLast().map { HostKeyMap.modifier($0)! }
            guard let key = HostKeyMap.key(request.keys.last!) else { throw invalid }
            // A shifted character names its own Shift unless one is held.
            let shift = key.shift && !modifiers.contains { $0.flag == .maskShift }
                ? [HostKeyMap.modifier("shift")!] : []
            press(Array(modifiers) + shift)
            steps.append(.key(key.code, down: true, modifier: false, flags: flags))
            steps.append(.pause(milliseconds: keyHold))
            steps.append(.key(key.code, down: false, modifier: false, flags: flags))
            steps.append(.pause(milliseconds: modifierSettle))
            lift(Array(modifiers) + shift)
        case .activate:
            break
        case .type:
            for character in request.text! {
                switch character {
                case "\n":
                    steps.append(.key(CGKeyCode(kVK_Return), down: true, modifier: false, flags: []))
                    steps.append(.key(CGKeyCode(kVK_Return), down: false, modifier: false, flags: []))
                case "\t":
                    steps.append(.key(CGKeyCode(kVK_Tab), down: true, modifier: false, flags: []))
                    steps.append(.key(CGKeyCode(kVK_Tab), down: false, modifier: false, flags: []))
                default: steps.append(.text(String(character)))
                }
                steps.append(.pause(milliseconds: typeGap))
            }
        }
        guard duration(steps) <= maximumDurationMilliseconds else { throw invalid }
        return steps
    }

    static func duration(_ steps: [HostInputStep]) -> UInt64 {
        steps.reduce(0) { total, step in
            if case .pause(let milliseconds) = step { return total + milliseconds }
            return total + 1
        }
    }
}

/// A process as the gate sees it.
struct HostInputProcess: Equatable {
    let processID: pid_t
    let bundleID: String?
    let executable: String?
}

/// One read of the desktop the gate decides against. Readers that cannot
/// tell report nil, never a guess.
struct HostInputEnvironment: Equatable {
    var secureInput: Bool
    var frontmost: HostInputProcess?
    /// The topmost on-screen window under the pointer, this app's own
    /// click-through indicator panels excluded.
    var windowOwner: HostInputProcess?
    var windowOwnerName: String?
    var windowLayer: Int?
    /// The focused element's owner and whether it is a secure text field.
    var focusOwner: HostInputProcess?
    var focusSecure: Bool = false
    var focusedWindowTitle: String?
    /// Milliseconds since the latest input event this Host did not post.
    var operatorInputAge: UInt64?
}

enum HostInputGate {
    /// Out-of-process panels that act for the frontmost application (#160).
    static let panelServices: Set<String> = ["com.apple.appkit.xpc.openAndSavePanelService"]
    /// The global menu bar shows the frontmost application's menus.
    static let menuBarLayer = Int(CGWindowLevelForKey(.mainMenuWindow))
    /// kCGWindowOwnerName of the menu bar window.
    static let windowServer = "Window Server"

    /// `start` decides before the first event; later steps re-check only
    /// what can change mid-action without the pointer moving to a new owner.
    static func check(_ request: HostInputRequest, _ environment: HostInputEnvironment, start: Bool,
                      pointerCheck: Bool) throws {
        if environment.secureInput { throw HostInputError.secureInput }
        let owners = [environment.frontmost, pointerCheck ? environment.windowOwner : nil,
                      request.kind.pointer ? nil : environment.focusOwner].compactMap { $0?.executable }
        if owners.contains(where: HostAXActionPlanner.consentDialogOwners.contains) {
            throw HostAXActionError.consentDialog
        }
        if request.kind == .activate {
            // Activation changes focus; it still yields to the operator.
            if request.policy == .yield, let age = environment.operatorInputAge,
               age < request.operatorIdleMilliseconds { throw HostInputError.operatorInput }
            return
        }
        guard let frontmost = environment.frontmost, frontmost.bundleID == request.target.bundleID,
              request.target.processID.map({ $0 == frontmost.processID }) ?? true else {
            throw HostInputError.targetMismatch
        }
        if pointerCheck {
            guard let owner = environment.windowOwner else { throw HostInputError.windowMismatch }
            let acting = owner.processID == frontmost.processID
                || owner.bundleID.map(panelServices.contains) == true
                || (environment.windowOwnerName == windowServer && environment.windowLayer == menuBarLayer)
            guard acting else { throw HostInputError.windowMismatch }
        }
        if start, !request.kind.pointer {
            if environment.focusSecure { throw HostInputError.secureInput }
            // An unreadable focus is allowed; a readable one must act for the target.
            if let owner = environment.focusOwner, owner.processID != frontmost.processID,
               owner.bundleID.map(panelServices.contains) != true {
                throw HostInputError.targetMismatch
            }
        }
        if start, let title = request.target.windowTitle, environment.focusedWindowTitle != title {
            throw HostInputError.targetMismatch
        }
        if start, request.policy == .yield, let age = environment.operatorInputAge,
           age < request.operatorIdleMilliseconds {
            throw HostInputError.operatorInput
        }
    }
}

/// Attributes the latest input event of a kind to this Host or to the
/// operator, from times only. Exact attribution comes from an event tap
/// that reads this Host's tag. Without one, an event within `tolerance` of
/// the Host's own latest post is the Host's. Operator input just before a
/// Host post of the same kind can be masked; the tap has no such gap.
enum HostOperatorInputAttribution {
    static let tolerance: UInt64 = 60

    static func foreignEventAt(lastEventAt: UInt64?, ownPostAt: UInt64?) -> UInt64? {
        guard let last = lastEventAt else { return nil }
        guard let own = ownPostAt else { return last }
        let gap = last > own ? last - own : own - last
        return gap <= tolerance ? nil : last
    }
}

/// Executes a plan one step at a time on the main actor. Each step first
/// re-checks the lease (Stop, display, readiness) and the gate, so Stop or a
/// focus change between two events wins. On any stop it releases what it
/// pressed and reports how far it got; it never retries.
@MainActor
final class HostInputSession {
    struct Outcome: Equatable {
        var posted = 0
        var completed = false
        var stopReason: String?
        var operatorEvents = 0
        var released = 0
    }

    typealias Check = @MainActor () throws -> Void
    /// The operator monitor is sampled at most this often within an action;
    /// every sample costs WindowServer calls when no event tap is present.
    static let operatorSampleMilliseconds: UInt64 = 40
    private let poster: HostInputPoster
    /// (pointer to check, start) -> one read. Focus, title and operator age
    /// are read only at start; later steps read secure input, frontmost and,
    /// for a button press, the window under the pointer.
    private let environment: @MainActor (_ point: CGPoint?, _ start: Bool) -> HostInputEnvironment
    private let monitor: HostOperatorInputMonitoring
    private let sleep: (UInt64) async -> Void
    private let now: () -> UInt64

    init(poster: HostInputPoster, environment: @escaping @MainActor (CGPoint?, Bool) -> HostInputEnvironment,
         monitor: HostOperatorInputMonitoring, now: @escaping () -> UInt64,
         sleep: @escaping (UInt64) async -> Void) {
        self.poster = poster; self.environment = environment; self.monitor = monitor
        self.now = now; self.sleep = sleep
    }

    func run(_ request: HostInputRequest, steps: [HostInputStep], lease: Check) async throws -> Outcome {
        let firstPoint = steps.lazy.compactMap { step -> CGPoint? in
            if case .move(let point) = step { return point }; return nil
        }.first
        // Refusals before the first event keep the lease (typed errors).
        try lease()
        try HostInputGate.check(request, environment(firstPoint, true), start: true, pointerCheck: firstPoint != nil)
        let started = now()
        var sampledAt: UInt64?
        var outcome = Outcome()
        var heldButtons: [HostMouseButton: CGPoint] = [:]
        var heldKeys: [(code: CGKeyCode, modifier: Bool)] = []
        func stop(_ reason: String) {
            outcome.stopReason = reason
            // Release in reverse: buttons first at their last point, then keys.
            for (button, point) in heldButtons {
                if poster.post(.button(button, down: false, at: point, clicks: 1, flags: [])) { outcome.released += 1 }
            }
            for key in heldKeys.reversed() {
                if poster.post(.key(key.code, down: false, modifier: key.modifier, flags: [])) { outcome.released += 1 }
            }
            heldButtons.removeAll(); heldKeys.removeAll()
            monitor.notePosted(at: now())
        }
        for (index, step) in steps.enumerated() {
            if case .pause(let milliseconds) = step { await sleep(milliseconds); continue }
            do {
                try lease()
                if index > 0 {
                    // A click re-checks the owner where it lands; a drag's
                    // later points may cross windows by design.
                    var pointer: CGPoint?
                    if case .button(_, true, let at, _, _) = step, heldButtons.isEmpty { pointer = at }
                    try HostInputGate.check(request, environment(pointer, false), start: false,
                                            pointerCheck: pointer != nil)
                }
            } catch let error as HostInputError {
                stop(error.rawValue); return outcome
            } catch let error as HostAXActionError {
                stop(error.rawValue); return outcome
            } catch {
                stop("lease_lost"); return outcome
            }
            let sampleNow = now()
            if sampledAt.map({ sampleNow >= $0 + Self.operatorSampleMilliseconds }) ?? true {
                sampledAt = sampleNow
                let foreign = monitor.foreignInputCount(since: started)
                if foreign > outcome.operatorEvents {
                    outcome.operatorEvents = foreign
                    if request.policy == .yield { stop(HostInputError.operatorInput.rawValue); return outcome }
                }
            }
            guard poster.post(step) else { stop("post_failed"); return outcome }
            outcome.posted += step.posts
            monitor.notePosted(at: now())
            switch step {
            case .button(let button, true, let at, _, _): heldButtons[button] = at
            case .button(let button, false, _, _, _): heldButtons[button] = nil
            case .drag(let button, let at, _): heldButtons[button] = at
            case .key(let code, true, let modifier, _): heldKeys.append((code, modifier))
            case .key(let code, false, _, _): heldKeys.removeAll { $0.code == code }
            default: break
            }
        }
        outcome.completed = true
        return outcome
    }
}

protocol HostInputPoster {
    /// Posts one event. False when the event could not be created.
    @MainActor func post(_ step: HostInputStep) -> Bool
}

protocol HostOperatorInputMonitoring: AnyObject {
    @MainActor func notePosted(at milliseconds: UInt64)
    /// Operator input events observed since the given Host time.
    @MainActor func foreignInputCount(since milliseconds: UInt64) -> Int
    /// Milliseconds since the latest operator input, or nil when none is known.
    @MainActor func operatorInputAge(now: UInt64) -> UInt64?
    var mode: String { get }
}

/// CGEvent poster. Events come from a private source, carry this Host's tag
/// in eventSourceUserData and enter at the HID tap like device input.
final class HostSystemInputPoster: HostInputPoster {
    /// "FRUITCTL" in ASCII; the operator monitor skips events with it.
    static let tag: Int64 = 0x4652_5549_5443_544C
    private let source = CGEventSource(stateID: .privateState)

    @MainActor func post(_ step: HostInputStep) -> Bool {
        let event: CGEvent?
        switch step {
        case .pause: return true
        case .move(let point):
            event = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point,
                            mouseButton: .left)
        case .button(let button, let down, let point, let clicks, let flags):
            event = CGEvent(mouseEventSource: source, mouseType: down ? button.downType : button.upType,
                            mouseCursorPosition: point, mouseButton: button.cg)
            event?.setIntegerValueField(.mouseEventClickState, value: clicks)
            event?.flags = flags
        case .drag(let button, let point, let flags):
            event = CGEvent(mouseEventSource: source, mouseType: button.dragType, mouseCursorPosition: point,
                            mouseButton: button.cg)
            event?.flags = flags
        case .scroll(let dy, let dx, let point):
            event = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx,
                            wheel3: 0)
            event?.location = point
        case .key(let code, let down, let modifier, let flags):
            event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
            if modifier { event?.type = .flagsChanged }
            event?.flags = flags
        case .text(let text):
            let units = Array(text.utf16)
            for down in [true, false] {
                guard let key = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { return false }
                key.flags = []
                units.withUnsafeBufferPointer { key.keyboardSetUnicodeString(stringLength: units.count,
                                                                             unicodeString: $0.baseAddress) }
                key.setIntegerValueField(.eventSourceUserData, value: Self.tag)
                key.post(tap: .cghidEventTap)
            }
            return true
        }
        guard let event else { return false }
        event.setIntegerValueField(.eventSourceUserData, value: Self.tag)
        event.post(tap: .cghidEventTap)
        return true
    }

    /// Posting needs the Accessibility grant; this never prompts.
    static var permitted: Bool { CGPreflightPostEventAccess() }
}

/// Operator input from a listen-only session event tap when macOS allows
/// one, else from per-kind event times (HostOperatorInputAttribution).
final class HostOperatorInputMonitor: HostOperatorInputMonitoring, @unchecked Sendable {
    static let kinds: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
        .otherMouseDown, .otherMouseUp, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel,
        .keyDown, .keyUp, .flagsChanged]
    private let clock: () -> UInt64
    private let lock = NSLock()
    private var foreign: [UInt64] = []
    private var ownPostAt: UInt64?
    private var tap: CFMachPort?
    private var tapThread: Thread?
    private(set) var mode = "event_times"

    init(clock: @escaping () -> UInt64) { self.clock = clock }

    /// Starts the tap on its own thread. Without permission the tap is nil
    /// and the time-based attribution stays in use.
    func start() {
        guard tap == nil else { return }
        let mask = Self.kinds.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
            options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, refcon in
                if let refcon {
                    let monitor = Unmanaged<HostOperatorInputMonitor>.fromOpaque(refcon).takeUnretainedValue()
                    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                        if let tap = monitor.tap { CGEvent.tapEnable(tap: tap, enable: true) }
                    } else if event.getIntegerValueField(.eventSourceUserData) != HostSystemInputPoster.tag {
                        monitor.recordForeign()
                    }
                }
                return Unmanaged.passUnretained(event)
            }, userInfo: refcon) else { return }
        tap = port
        // Keyboard events reach a listen-only tap only with Input Monitoring.
        mode = CGPreflightListenEventAccess() ? "event_tap" : "event_tap_pointer"
        let thread = Thread {
            guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0) else { return }
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
            CGEvent.tapEnable(tap: port, enable: true)
            CFRunLoopRun()
        }
        thread.name = "FruitctlHost operator input"
        thread.qualityOfService = .userInitiated
        tapThread = thread
        thread.start()
    }

    private func recordForeign() {
        let at = clock()
        lock.lock(); defer { lock.unlock() }
        foreign.append(at)
        if foreign.count > 256 { foreign.removeFirst(foreign.count - 256) }
    }

    @MainActor func notePosted(at milliseconds: UInt64) {
        lock.lock(); ownPostAt = milliseconds; lock.unlock()
    }

    /// Time-based attribution for the kinds a tap does not cover.
    private func timedForeign(now: UInt64) -> UInt64? {
        let keyboard: [CGEventType] = [.keyDown, .keyUp, .flagsChanged]
        let kinds: [CGEventType] = mode == "event_tap" ? [] : mode == "event_tap_pointer" ? keyboard : Self.kinds
        lock.lock(); let own = ownPostAt; lock.unlock()
        var latest: UInt64?
        for kind in kinds {
            // The combined session table covers device input and every
            // posting process, remote-control clients included.
            let seconds = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: kind)
            guard seconds.isFinite, seconds >= 0, seconds < 86_400 else { continue }
            let elapsed = UInt64(seconds * 1_000)
            guard elapsed <= now else { continue }
            if let at = HostOperatorInputAttribution.foreignEventAt(lastEventAt: now - elapsed, ownPostAt: own) {
                latest = max(latest ?? 0, at)
            }
        }
        return latest
    }

    @MainActor func foreignInputCount(since milliseconds: UInt64) -> Int {
        lock.lock()
        var count = foreign.filter { $0 >= milliseconds }.count
        lock.unlock()
        if let at = timedForeign(now: clock()), at >= milliseconds { count += 1 }
        return count
    }

    @MainActor func operatorInputAge(now: UInt64) -> UInt64? {
        lock.lock(); let tapped = foreign.last; lock.unlock()
        let latest = [tapped, timedForeign(now: now)].compactMap { $0 }.max()
        return latest.map { now >= $0 ? now - $0 : 0 }
    }
}

/// Reads the desktop for the gate. Every read is local and bounded by the
/// process-wide AX messaging timeout; nothing is cached between steps.
@MainActor
enum HostSystemInputEnvironment {
    static func read(point: CGPoint?, start: Bool, keyboard: Bool, wantsTitle: Bool,
                     executable: (pid_t) -> String?, monitor: HostOperatorInputMonitoring,
                     now: UInt64) -> HostInputEnvironment {
        func process(_ pid: pid_t) -> HostInputProcess {
            HostInputProcess(processID: pid, bundleID: NSRunningApplication(processIdentifier: pid)?.bundleIdentifier,
                             executable: executable(pid))
        }
        var environment = HostInputEnvironment(secureInput: IsSecureEventInputEnabled())
        if let front = NSWorkspace.shared.frontmostApplication {
            environment.frontmost = HostInputProcess(processID: front.processIdentifier,
                bundleID: front.bundleIdentifier, executable: executable(front.processIdentifier))
        }
        if let point, let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                                 kCGNullWindowID) as? [[String: Any]] {
            for window in windows {
                guard let pid = (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                      pid != getpid(),
                      let boundsInfo = window[kCGWindowBounds as String] as? NSDictionary,
                      let bounds = CGRect(dictionaryRepresentation: boundsInfo as CFDictionary),
                      bounds.contains(point),
                      ((window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0 else { continue }
                environment.windowOwner = process(pid)
                environment.windowOwnerName = window[kCGWindowOwnerName as String] as? String
                environment.windowLayer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue
                break
            }
        }
        if start, keyboard {
            var focused: AnyObject?
            if AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as CFString,
                                             &focused) == .success, let focused,
               CFGetTypeID(focused) == AXUIElementGetTypeID() {
                let element = focused as! AXUIElement
                var pid: pid_t = 0
                if AXUIElementGetPid(element, &pid) == .success, pid > 0 { environment.focusOwner = process(pid) }
                var role: AnyObject?, subrole: AnyObject?
                _ = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
                _ = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subrole)
                environment.focusSecure = (role as? String) == "AXSecureTextField"
                    || (subrole as? String) == "AXSecureTextField"
            }
        }
        if start, wantsTitle, let front = environment.frontmost {
            var window: AnyObject?
            if AXUIElementCopyAttributeValue(AXUIElementCreateApplication(front.processID),
                                             kAXFocusedWindowAttribute as CFString, &window) == .success,
               let window, CFGetTypeID(window) == AXUIElementGetTypeID() {
                var title: AnyObject?
                if AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString,
                                                 &title) == .success {
                    environment.focusedWindowTitle = title as? String
                }
            }
        }
        if start { environment.operatorInputAge = monitor.operatorInputAge(now: now) }
        return environment
    }
}

/// Persists the operator's local choice to allow agent input. Only startup
/// arguments and the local menu write it; IPC has no mutation path.
final class HostInputPreferences {
    private static let optInKey = "fruitctl.input.explicitOptIn.v1"
    private let defaults: UserDefaults
    private(set) var isEnabled: Bool

    init(defaults: UserDefaults = .standard, startupChoice: Bool? = nil) {
        self.defaults = defaults
        if let startupChoice {
            isEnabled = startupChoice
            defaults.set(startupChoice, forKey: Self.optInKey)
        } else {
            isEnabled = defaults.bool(forKey: Self.optInKey)
        }
    }

    func setEnabled(_ enabled: Bool) {
        isEnabled = enabled
        defaults.set(enabled, forKey: Self.optInKey)
    }
}

extension HostInputSession.Outcome {
    func metadata(_ request: HostInputRequest, frontmost: HostInputProcess?, monitor: String) -> [String: HostValue] {
        var result: [String: HostValue] = [
            "kind": .string(request.kind.rawValue), "posted_events": .integer(Int64(posted)),
            "completed": .boolean(completed), "operator_input": .string(request.policy.rawValue),
            "operator_input_events": .integer(Int64(operatorEvents)), "operator_input_monitor": .string(monitor),
            "released_events": .integer(Int64(released)), "target_bundle_id": .string(request.target.bundleID)]
        if let stopReason { result["stop_reason"] = .string(stopReason) }
        if let frontmost {
            result["frontmost_pid"] = .integer(Int64(frontmost.processID))
            result["frontmost_bundle_id"] = frontmost.bundleID.map { .string($0) } ?? .null
        }
        return result
    }
}
