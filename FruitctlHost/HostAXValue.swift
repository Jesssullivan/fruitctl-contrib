import ApplicationServices
import CoreGraphics
import Foundation

/// #161: the value an agent asks an element to take: text or a finite number.
enum HostAXValueInput: Equatable {
    case text(String), number(Double)

    static let maximumTextUTF8 = 256

    /// The value to set: a number for an element whose current value is a
    /// number, text otherwise. Text that does not parse as a finite number
    /// is not set on a numeric element.
    func axValue(numeric: Bool) -> CFTypeRef? {
        switch self {
        case .number(let number):
            guard number.isFinite else { return nil }
            return numeric ? Self.cfNumber(number) : Self.format(number) as CFString
        case .text(let text):
            guard numeric else { return text as CFString }
            guard let number = Double(text.trimmingCharacters(in: .whitespaces)), number.isFinite else { return nil }
            return Self.cfNumber(number)
        }
    }

    /// A whole number is set as an integer; Logic's sliders hold integers.
    static func cfNumber(_ value: Double) -> NSNumber {
        if value.rounded() == value, abs(value) < 9_007_199_254_740_992 { return NSNumber(value: Int64(value)) }
        return NSNumber(value: value)
    }

    static func format(_ value: Double) -> String {
        value.rounded() == value && abs(value) < 1e15 ? String(Int64(value)) : String(value)
    }

    /// Readback. Text matches exactly, or as the same finite number; a
    /// number matches within a relative 1e-6.
    func matches(_ read: String?) -> Bool {
        guard let read else { return false }
        switch self {
        case .text(let text):
            if read == text { return true }
            guard let wanted = Double(text.trimmingCharacters(in: .whitespaces)), let got = Double(read) else {
                return false
            }
            return Self.close(wanted, got)
        case .number(let number):
            guard let got = Double(read) else { return false }
            return Self.close(number, got)
        }
    }

    static func close(_ first: Double, _ second: Double) -> Bool {
        first.isFinite && second.isFinite && abs(first - second) <= max(1e-9, 1e-6 * max(abs(first), abs(second)))
    }
}

enum HostAXValueOperation: String {
    case set, increment, decrement

    var axOperation: HostAXOperation? {
        switch self {
        case .set: return nil
        case .increment: return .increment
        case .decrement: return .decrement
        }
    }
}

/// One `ax_value` request (#161): set an element's AXValue, or step it with
/// AXIncrement or AXDecrement, for the profile's input application.
struct HostAXValueRequest: Equatable {
    static let maximumSteps = 10
    let generation: UInt64
    let ref: String
    let operation: HostAXValueOperation
    let value: HostAXValueInput?
    let steps: Int
    let target: HostInputTarget
    let policy: HostOperatorInputPolicy
    let operatorIdleMilliseconds: UInt64

    static func parse(_ params: [String: HostValue]) throws -> HostAXValueRequest {
        let invalid = HostLeaseError.invalidParameters
        guard let generation = params["generation"]?.unsigned, generation > 0,
              let ref = params["ref"]?.string, HostAXActionRequest.validRef(ref),
              let name = params["operation"]?.string, let operation = HostAXValueOperation(rawValue: name) else {
            throw invalid
        }
        var value: HostAXValueInput?
        var steps = 1
        if operation == .set {
            switch params["value"] {
            case .string(let text)?:
                guard text.utf8.count <= HostAXValueInput.maximumTextUTF8,
                      // No control characters, no bidirectional overrides.
                      text.unicodeScalars.allSatisfy({ scalar in
                          !(scalar.value < 0x20 || (0x7F...0x9F).contains(scalar.value)
                              || (0x202A...0x202E).contains(scalar.value) || (0x2066...0x2069).contains(scalar.value))
                      }) else { throw invalid }
                value = .text(text)
            case .integer(let number)?:
                guard number > -9_007_199_254_740_992, number < 9_007_199_254_740_992 else { throw invalid }
                value = .number(Double(number))
            case .number(let number)?:
                guard number.isFinite else { throw invalid }
                value = .number(number)
            default: throw invalid
            }
            guard params["steps"] == nil else { throw invalid }
        } else {
            guard params["value"] == nil else { throw invalid }
            if let item = params["steps"] {
                guard let number = item.integer, (1...maximumSteps).contains(number) else { throw invalid }
                steps = number
            }
        }
        let target = try HostInputTarget.parse(params["target"], allowsTitle: false)
        let (policy, idle) = try HostInputRequest.parsePolicy(params)
        return HostAXValueRequest(generation: generation, ref: ref, operation: operation, value: value, steps: steps,
                                  target: target, policy: policy, operatorIdleMilliseconds: idle)
    }
}

/// The process that owns the element an `ax_value` request changes.
enum HostAXValueOwner: String {
    case target
    /// An Apple-signed AudioToolbox AU hosting service (#172).
    case auHostingService = "au_hosting_service"
    /// A child process of the target application.
    case targetChild = "target_child"
}

enum HostAXValueGate {
    /// Value controls only. Buttons, menus and checkboxes stay with
    /// click_element; secure text is never set.
    static let roles: Set<String> = ["AXSlider", "AXTextField", "AXIncrementor", "AXComboBox"]

    /// Decided before each Accessibility call that can change the element.
    /// `snapshotProcessID` is the application whose snapshot named the ref.
    static func check(_ request: HostAXValueRequest, environment: HostInputEnvironment, snapshotProcessID: pid_t,
                      owner: HostInputProcess?, state: HostAXLiveState, start: Bool) throws -> HostAXValueOwner {
        if environment.secureInput { throw HostInputError.secureInput }
        let executables = [environment.frontmost?.executable, owner?.executable].compactMap { $0 }
        if executables.contains(where: HostAXActionPlanner.consentDialogOwners.contains) {
            throw HostAXActionError.consentDialog
        }
        guard let frontmost = environment.frontmost, frontmost.bundleID == request.target.bundleID,
              request.target.processID.map({ $0 == frontmost.processID }) ?? true,
              snapshotProcessID == frontmost.processID else { throw HostInputError.targetMismatch }
        guard let owner else { throw HostAXActionError.unreachable }
        let kind: HostAXValueOwner
        if owner.processID == frontmost.processID {
            kind = .target
        } else if owner.appleCodeIdentifier.map(HostPluginHosting.auHostingServices.contains) == true {
            kind = .auHostingService
        } else if owner.parentProcessID == frontmost.processID {
            kind = .targetChild
        } else {
            throw HostInputError.targetMismatch
        }
        if state.role == "AXSecureTextField" || state.subrole == "AXSecureTextField" {
            throw HostInputError.secureInput
        }
        guard let role = state.role, roles.contains(role), state.enabled != false else {
            throw HostAXActionError.unsupported
        }
        switch request.operation {
        case .set: guard state.valueSettable else { throw HostAXActionError.unsupported }
        case .increment, .decrement:
            guard let name = request.operation.axOperation?.rawValue, state.actions.contains(name) else {
                throw HostAXActionError.unsupported
            }
        }
        if start, request.policy == .yield, let age = environment.operatorInputAge,
           age < request.operatorIdleMilliseconds {
            throw HostInputError.operatorInput
        }
        return kind
    }
}

enum HostAXValueVerifier {
    /// One set has 250 ms to read back; each step has 120 ms, so ten steps
    /// stay inside the broker's 2.4 s round trip.
    static let setBudgetNanoseconds: UInt64 = 250_000_000
    static let stepBudgetNanoseconds: UInt64 = 120_000_000

    /// set: the element reads the requested value. A step: the value changed,
    /// and a numeric value moved the way that was asked.
    static func satisfied(_ operation: HostAXValueOperation, requested: HostAXValueInput?, before: String?,
                          after: HostAXLiveRead) -> Bool {
        guard case .live(let state) = after else { return false }
        switch operation {
        case .set: return requested?.matches(state.value) ?? false
        case .increment, .decrement:
            guard let value = state.value, value != before else { return false }
            if let old = before.flatMap(Double.init), let new = Double(value) {
                return operation == .increment ? new > old : new < old
            }
            return true
        }
    }

    /// Reads until satisfied or expired; returns the last read.
    static func poll(_ operation: HostAXValueOperation, requested: HostAXValueInput?, before: String?,
                     read: () -> HostAXLiveRead, expired: () -> Bool,
                     pause: () -> Void) -> (verified: Bool, last: HostAXLiveRead) {
        while true {
            let last = read()
            if satisfied(operation, requested: requested, before: before, after: last) { return (true, last) }
            if expired() { return (false, last) }
            pause()
        }
    }
}

struct HostAXValueOutcome {
    let request: HostAXValueRequest
    let owner: HostAXValueOwner
    let role: String?
    let before: String?
    var after: String?
    var performed = 0
    var verified = false
    var axResult: HostAXPerformResult?
    var stopReason: String?

    var metadata: [String: HostValue] {
        func text(_ value: String?) -> HostValue { value.map { .string(HostAccessibilitySnapshot.bounded($0)) } ?? .null }
        var result: [String: HostValue] = [
            "ref": .string(request.ref), "generation": .integer(Int64(clamping: request.generation)),
            "operation": .string(request.operation.rawValue), "owner": .string(owner.rawValue),
            "role": .string(HostAccessibilitySnapshot.bounded(role ?? "AXUnknown")),
            "value_before": text(before), "value_after": text(after),
            "steps": .integer(Int64(request.operation == .set ? 1 : request.steps)),
            "steps_performed": .integer(Int64(performed)), "verified": .boolean(verified),
            "target_bundle_id": .string(request.target.bundleID)]
        if let axResult { result["ax_result"] = .string(axResult == .performed ? "performed" : "indeterminate") }
        if let stopReason { result["stop_reason"] = .string(stopReason) }
        return result
    }
}
