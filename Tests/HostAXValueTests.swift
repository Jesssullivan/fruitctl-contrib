import CoreGraphics
import XCTest

/// Pure checks of ax_value (#161): parsing, the gate, value typing and
/// readback. No Accessibility call reaches the desktop.
final class HostAXValueTests: XCTestCase {
    private let target: HostValue = .object(["bundle_id": .string("com.apple.logic10")])

    private func request(_ fields: [String: HostValue]) throws -> HostAXValueRequest {
        try HostAXValueRequest.parse(["generation": .integer(4), "ref": .string("ax:64374:0.0.11.0.1.0.2"),
                                      "target": target].merging(fields) { _, new in new })
    }

    private func environment(front: pid_t = 64374, bundle: String = "com.apple.logic10") -> HostInputEnvironment {
        var value = HostInputEnvironment(secureInput: false)
        value.frontmost = HostInputProcess(processID: front, bundleID: bundle, executable: "Logic Pro")
        value.operatorInputAge = 5_000
        return value
    }

    private func slider(_ value: String = "18") -> HostAXLiveState {
        var state = HostAXLiveState()
        state.role = "AXSlider"
        state.value = value
        state.valueSettable = true
        state.enabled = true
        state.actions = ["AXIncrement", "AXDecrement"]
        state.ownerProcessID = 64374
        return state
    }

    private let logic = HostInputProcess(processID: 64374, bundleID: "com.apple.logic10", executable: "Logic Pro")

    func testParseTakesOneValueOrStepsAndTheTarget() throws {
        let set = try request(["operation": .string("set"), "value": .integer(40)])
        XCTAssertEqual(set.value, .number(40))
        XCTAssertEqual(set.steps, 1)
        XCTAssertEqual(try request(["operation": .string("set"), "value": .string("4:1")]).value, .text("4:1"))
        XCTAssertEqual(try request(["operation": .string("set"), "value": .number(-12.5)]).value, .number(-12.5))
        let up = try request(["operation": .string("increment"), "steps": .integer(10)])
        XCTAssertEqual(up.steps, 10)
        XCTAssertNil(up.value)
        XCTAssertEqual(try request(["operation": .string("decrement")]).steps, 1)
        for invalid: [String: HostValue] in [
            ["operation": .string("set")],
            ["operation": .string("set"), "value": .boolean(true)],
            ["operation": .string("set"), "value": .string("bell\u{07}")],
            ["operation": .string("set"), "value": .string("\u{202E}04")],
            ["operation": .string("set"), "value": .string(String(repeating: "a", count: 257))],
            ["operation": .string("set"), "value": .integer(1), "steps": .integer(2)],
            ["operation": .string("increment"), "value": .integer(1)],
            ["operation": .string("increment"), "steps": .integer(0)],
            ["operation": .string("decrement"), "steps": .integer(11)],
            ["operation": .string("press"), "value": .integer(1)],
            ["operation": .string("set"), "value": .integer(1), "ref": .string("ax:64374:1")],
            ["operation": .string("set"), "value": .integer(1), "generation": .integer(0)],
            ["operation": .string("set"), "value": .integer(1), "operator_input": .string("ignore")],
            ["operation": .string("set"), "value": .integer(1),
             "target": .object(["bundle_id": .string("com.apple.logic10"), "window_title": .string("Bass Synth")])],
            ["operation": .string("set"), "value": .integer(1), "target": .null],
        ] {
            XCTAssertThrowsError(try request(invalid), "\(invalid)")
        }
    }

    func testValuesAreTypedLikeTheElementsCurrentValue() {
        XCTAssertEqual((HostAXValueInput.number(40).axValue(numeric: true) as? NSNumber)?.int64Value, 40)
        XCTAssertEqual(String(cString: (HostAXValueInput.number(40).axValue(numeric: true) as! NSNumber).objCType), "q")
        XCTAssertEqual((HostAXValueInput.number(2.5).axValue(numeric: true) as? NSNumber)?.doubleValue, 2.5)
        XCTAssertEqual(HostAXValueInput.number(40).axValue(numeric: false) as? String, "40")
        XCTAssertEqual((HostAXValueInput.text(" 35 ").axValue(numeric: true) as? NSNumber)?.int64Value, 35)
        XCTAssertNil(HostAXValueInput.text("4:1").axValue(numeric: true))
        XCTAssertNil(HostAXValueInput.text("nan").axValue(numeric: true))
        XCTAssertEqual(HostAXValueInput.text("Orch").axValue(numeric: false) as? String, "Orch")
        XCTAssertTrue(HostAXValueInput.number(40).matches("40"))
        XCTAssertTrue(HostAXValueInput.text("35").matches("35.0"))
        XCTAssertTrue(HostAXValueInput.text("Orch").matches("Orch"))
        XCTAssertFalse(HostAXValueInput.number(40).matches("41"))
        XCTAssertFalse(HostAXValueInput.text("Orch").matches("orch"))
        XCTAssertFalse(HostAXValueInput.number(1).matches(nil))
    }

    func testTheGateAdmitsTheTargetAndItsPluginHostsOnly() throws {
        let set = try request(["operation": .string("set"), "value": .integer(40)])
        func check(_ owner: HostInputProcess?, state: HostAXLiveState? = nil, environment value: HostInputEnvironment? = nil,
                   snapshot: pid_t = 64374, input: HostAXValueRequest? = nil) throws -> HostAXValueOwner {
            try HostAXValueGate.check(input ?? set, environment: value ?? environment(), snapshotProcessID: snapshot,
                                      owner: owner, state: state ?? slider(), start: true)
        }
        func refused(_ code: String, line: UInt = #line, _ body: () throws -> HostAXValueOwner) {
            XCTAssertThrowsError(try body(), line: line) { error in
                XCTAssertEqual((error as? HostInputError)?.rawValue ?? (error as? HostAXActionError)?.rawValue, code,
                               line: line)
            }
        }
        XCTAssertEqual(try check(logic), .target)
        var service = HostInputProcess(processID: 95123, bundleID: nil, executable: "AUHostingServiceXPC_arrow")
        service.appleCodeIdentifier = "com.apple.audio.AUHostingService.arm64e"
        service.parentProcessID = 1
        XCTAssertEqual(try check(service), .auHostingService)
        var child = HostInputProcess(processID: 700, bundleID: nil, executable: "PluginHost")
        child.parentProcessID = 64374
        XCTAssertEqual(try check(child), .targetChild)
        var unrelated = HostInputProcess(processID: 524, bundleID: "com.cmuxterm.app", executable: "cmux")
        unrelated.parentProcessID = 1
        refused("input_target_mismatch") { try check(unrelated) }
        var unsigned = service
        unsigned.appleCodeIdentifier = nil
        refused("input_target_mismatch") { try check(unsigned) }
        refused("ax_unreachable") { try check(nil) }
        // The ref must come from the frontmost target's own snapshot.
        refused("input_target_mismatch") { try check(logic, snapshot: 524) }
        refused("input_target_mismatch") { try check(logic, environment: environment(bundle: "com.cmuxterm.app")) }
        let pinned = try request(["operation": .string("set"), "value": .integer(40),
            "target": .object(["bundle_id": .string("com.apple.logic10"), "pid": .integer(1)])])
        refused("input_target_mismatch") { try check(logic, input: pinned) }
        var secure = environment()
        secure.secureInput = true
        refused("secure_input_active") { try check(logic, environment: secure) }
        var password = slider()
        password.role = "AXTextField"
        password.subrole = "AXSecureTextField"
        refused("secure_input_active") { try check(logic, state: password) }
        var button = slider()
        button.role = "AXButton"
        refused("ax_action_unsupported") { try check(logic, state: button) }
        var fixed = slider()
        fixed.valueSettable = false
        refused("ax_action_unsupported") { try check(logic, state: fixed) }
        var disabled = slider()
        disabled.enabled = false
        refused("ax_action_unsupported") { try check(logic, state: disabled) }
        var noSteps = slider()
        noSteps.actions = []
        let up = try request(["operation": .string("increment"), "steps": .integer(3)])
        refused("ax_action_unsupported") { try check(logic, state: noSteps, input: up) }
        XCTAssertEqual(try check(logic, state: fixed, input: up), .target)
        var dialog = environment()
        dialog.frontmost = HostInputProcess(processID: 64374, bundleID: "com.apple.logic10", executable: "SecurityAgent")
        refused("human_consent_required") { try check(logic, environment: dialog) }
        var busy = environment()
        busy.operatorInputAge = 200
        refused("operator_input_detected") { try check(logic, environment: busy) }
        let asserting = try request(["operation": .string("set"), "value": .integer(40),
                                     "operator_input": .string("assert")])
        XCTAssertEqual(try check(logic, environment: busy, input: asserting), .target)
        // Later steps are not held to the idle time; the handler checks
        // operator input since the action started instead.
        XCTAssertEqual(try HostAXValueGate.check(set, environment: busy, snapshotProcessID: 64374, owner: logic,
                                                 state: slider(), start: false), .target)
    }

    func testReadbackVerifiesTheRequestedValueOrDirection() {
        func live(_ value: String?) -> HostAXLiveRead {
            var state = slider()
            state.value = value
            return .live(state)
        }
        XCTAssertTrue(HostAXValueVerifier.satisfied(.set, requested: .number(40), before: "18", after: live("40")))
        XCTAssertFalse(HostAXValueVerifier.satisfied(.set, requested: .number(40), before: "18", after: live("39")))
        XCTAssertFalse(HostAXValueVerifier.satisfied(.set, requested: .number(40), before: "18", after: .invalid))
        XCTAssertFalse(HostAXValueVerifier.satisfied(.set, requested: .number(40), before: "18", after: .unresponsive))
        XCTAssertTrue(HostAXValueVerifier.satisfied(.increment, requested: nil, before: "18", after: live("19")))
        XCTAssertFalse(HostAXValueVerifier.satisfied(.increment, requested: nil, before: "18", after: live("17")))
        XCTAssertFalse(HostAXValueVerifier.satisfied(.increment, requested: nil, before: "18", after: live("18")))
        XCTAssertTrue(HostAXValueVerifier.satisfied(.decrement, requested: nil, before: "18", after: live("17")))
        XCTAssertTrue(HostAXValueVerifier.satisfied(.increment, requested: nil, before: "Off", after: live("On")))
        var reads = 0
        let polled = HostAXValueVerifier.poll(.set, requested: .number(40), before: "18", read: {
            reads += 1
            return live(reads < 3 ? "18" : "40")
        }, expired: { false }, pause: {})
        XCTAssertTrue(polled.verified)
        XCTAssertEqual(reads, 3)
        let expired = HostAXValueVerifier.poll(.set, requested: .number(40), before: "18", read: { live("18") },
                                               expired: { true }, pause: {})
        XCTAssertFalse(expired.verified)
        XCTAssertEqual(expired.last, live("18"))
    }

    func testOutcomeMetadataNamesWhatRanAndTheReadback() throws {
        let up = try request(["operation": .string("increment"), "steps": .integer(3)])
        var outcome = HostAXValueOutcome(request: up, owner: .auHostingService, role: "AXSlider", before: "18")
        outcome.after = "20"
        outcome.performed = 2
        outcome.axResult = .performed
        outcome.stopReason = "operator_input_detected"
        let metadata = outcome.metadata
        XCTAssertEqual(metadata["owner"], .string("au_hosting_service"))
        XCTAssertEqual(metadata["value_before"], .string("18"))
        XCTAssertEqual(metadata["value_after"], .string("20"))
        XCTAssertEqual(metadata["steps"], .integer(3))
        XCTAssertEqual(metadata["steps_performed"], .integer(2))
        XCTAssertEqual(metadata["verified"], .boolean(false))
        XCTAssertEqual(metadata["stop_reason"], .string("operator_input_detected"))
        XCTAssertEqual(metadata["target_bundle_id"], .string("com.apple.logic10"))
        let set = try request(["operation": .string("set"), "value": .integer(40)])
        XCTAssertEqual(HostAXValueOutcome(request: set, owner: .target, role: nil, before: nil).metadata["value_before"],
                       .null)
    }

    func testANodeWithoutSetValueRefusesIt() {
        final class PressOnly: HostAXNode {
            func attributes() -> HostAXAttributes { HostAXAttributes() }
            func children(limit: Int) -> [HostAXNode] { [] }
            func liveState() -> HostAXLiveRead { .invalid }
            func perform(_ operation: HostAXOperation) -> HostAXPerformResult { .performed }
        }
        XCTAssertEqual(PressOnly().setValue(.number(1)), .unsupported)
        XCTAssertEqual(HostAXOperation.increment.path, "ax_increment")
        XCTAssertEqual(HostAXOperation.decrement.rawValue, "AXDecrement")
    }
}
