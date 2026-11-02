import Carbon.HIToolbox
import CoreGraphics
import XCTest

/// Pure checks of the #157 input route: parsing, planning, the gate and the
/// step runner with a fake poster. No event is posted to the desktop.
@MainActor
final class HostInputTests: XCTestCase {
    private let geometry = HostDisplayGeometry(pixelWidth: 512, pixelHeight: 256,
                                               bounds: CGRect(x: 100, y: 0, width: 256, height: 128))
    private let target: HostValue = .object(["bundle_id": .string("com.apple.logic10")])

    private func request(_ fields: [String: HostValue]) throws -> HostInputRequest {
        try HostInputRequest.parse(fields.merging(["target": target]) { new, _ in new })
    }

    private func environment(front: pid_t = 529, bundle: String? = "com.apple.logic10",
                             window: HostInputProcess? = HostInputProcess(processID: 529, bundleID: "com.apple.logic10",
                                                                          executable: "Logic Pro X"),
                             secure: Bool = false) -> HostInputEnvironment {
        var value = HostInputEnvironment(secureInput: secure)
        value.frontmost = HostInputProcess(processID: front, bundleID: bundle, executable: "Logic Pro X")
        value.windowOwner = window
        value.windowLayer = 0
        return value
    }

    func testParseRequiresTargetAndKindFields() throws {
        XCTAssertNoThrow(try request(["kind": .string("click"), "x": .integer(10), "y": .integer(20)]))
        for invalid: [String: HostValue] in [
            ["kind": .string("click"), "x": .integer(10)],
            ["kind": .string("click"), "x": .integer(-1), "y": .integer(0)],
            ["kind": .string("key"), "keys": .array([.string("cmd")])],
            ["kind": .string("key"), "keys": .array([.string("s"), .string("cmd")])],
            ["kind": .string("key"), "keys": .array([.string("cmd"), .string("command"), .string("s")])],
            ["kind": .string("type"), "text": .string(String(repeating: "a", count: 65))],
            ["kind": .string("type"), "text": .string("bell\u{07}")],
            ["kind": .string("type"), "text": .string("x"), "x": .integer(1), "y": .integer(1)],
            ["kind": .string("scroll"), "x": .integer(1), "y": .integer(1), "direction": .string("in")],
            ["kind": .string("click"), "x": .integer(1), "y": .integer(1),
             "modifiers": .array([.string("cmd"), .string("cmd")])],
            ["kind": .string("move"), "x": .integer(1), "y": .integer(1), "button": .string("right")],
            ["kind": .string("click"), "x": .integer(1), "y": .integer(1), "operator_input": .string("ignore")],
        ] {
            XCTAssertThrowsError(try request(invalid), "\(invalid)")
        }
        XCTAssertThrowsError(try HostInputRequest.parse(["kind": .string("click"), "x": .integer(1), "y": .integer(1)]))
        XCTAssertThrowsError(try HostInputRequest.parse(["kind": .string("click"), "x": .integer(1), "y": .integer(1),
            "target": .object(["bundle_id": .string("../evil")])]))
        XCTAssertThrowsError(try HostInputRequest.parse(["kind": .string("click"), "x": .integer(1), "y": .integer(1),
            "target": .object(["bundle_id": .string("com.apple.logic10"), "extra": .integer(1)])]))
    }

    func testPixelsMapToGlobalPointCentres() {
        XCTAssertEqual(geometry.globalPoint(pixelX: 0, pixelY: 0), CGPoint(x: 100.25, y: 0.25))
        XCTAssertEqual(geometry.globalPoint(pixelX: 511, pixelY: 255), CGPoint(x: 355.75, y: 127.75))
        XCTAssertNil(geometry.globalPoint(pixelX: 512, pixelY: 0))
        XCTAssertThrowsError(try HostInputPlanner.plan(request(["kind": .string("click"), "x": .integer(600),
                                                                "y": .integer(1)]), geometry: geometry))
    }

    func testCommandClickHoldsTheModifierAroundTheClick() throws {
        let steps = try HostInputPlanner.plan(request(["kind": .string("click"), "x": .integer(2), "y": .integer(2),
            "modifiers": .array([.string("cmd")])]), geometry: geometry).filter { $0.posts > 0 }
        let at = CGPoint(x: 101.25, y: 1.25)
        XCTAssertEqual(steps, [.move(at),
            .key(CGKeyCode(kVK_Command), down: true, modifier: true, flags: .maskCommand),
            .button(.left, down: true, at: at, clicks: 1, flags: .maskCommand),
            .button(.left, down: false, at: at, clicks: 1, flags: .maskCommand),
            .key(CGKeyCode(kVK_Command), down: false, modifier: true, flags: [])])
    }

    func testDoubleTripleAndRightClicksCarryClickState() throws {
        let double = try HostInputPlanner.plan(request(["kind": .string("double_click"), "x": .integer(2),
            "y": .integer(2), "button": .string("right")]), geometry: geometry)
        let presses = double.compactMap { step -> (Bool, Int64)? in
            if case .button(.right, let down, _, let clicks, _) = step { return (down, clicks) }; return nil
        }
        XCTAssertEqual(presses.map { $0.1 }, [1, 1, 2, 2])
        XCTAssertEqual(presses.map { $0.0 }, [true, false, true, false])
        let triple = try HostInputPlanner.plan(request(["kind": .string("triple_click"), "x": .integer(2),
            "y": .integer(2)]), geometry: geometry)
        XCTAssertEqual(triple.filter { if case .button(_, true, _, _, _) = $0 { return true }; return false }.count, 3)
    }

    func testDragPressesMovesAndReleasesAtTheEnd() throws {
        let steps = try HostInputPlanner.plan(request(["kind": .string("drag"), "x": .integer(0), "y": .integer(0),
            "to_x": .integer(400), "to_y": .integer(0)]), geometry: geometry).filter { $0.posts > 0 }
        XCTAssertEqual(steps.first, .move(CGPoint(x: 100.25, y: 0.25)))
        XCTAssertEqual(steps[1], .button(.left, down: true, at: CGPoint(x: 100.25, y: 0.25), clicks: 1, flags: []))
        XCTAssertEqual(steps.last, .button(.left, down: false, at: CGPoint(x: 300.25, y: 0.25), clicks: 1, flags: []))
        XCTAssertEqual(steps.dropLast().last, .drag(.left, CGPoint(x: 300.25, y: 0.25), flags: []))
        XCTAssertEqual(steps.filter { if case .drag = $0 { return true }; return false }.count, 20)
    }

    func testScrollTicksOneLinePerEventInTheRequestedDirection() throws {
        let up = try HostInputPlanner.plan(request(["kind": .string("scroll"), "x": .integer(4), "y": .integer(4),
            "direction": .string("up"), "amount": .integer(4)]), geometry: geometry)
        let ticks = up.compactMap { step -> Int32? in if case .scroll(let dy, 0, _) = step { return dy }; return nil }
        XCTAssertEqual(ticks, [1, 1, 1, 1])
        let right = try HostInputPlanner.plan(request(["kind": .string("scroll"), "x": .integer(4), "y": .integer(4),
            "direction": .string("right")]), geometry: geometry)
        XCTAssertEqual(right.compactMap { step -> Int32? in if case .scroll(0, let dx, _) = step { return dx }; return nil },
                       [-1, -1, -1])
    }

    func testKeyCombosUsePositionalCodesAndShiftedCharactersAddShift() throws {
        let save = try HostInputPlanner.plan(request(["kind": .string("key"),
            "keys": .array([.string("cmd"), .string("s")])]), geometry: geometry).filter { $0.posts > 0 }
        XCTAssertEqual(save, [.key(CGKeyCode(kVK_Command), down: true, modifier: true, flags: .maskCommand),
            .key(CGKeyCode(kVK_ANSI_S), down: true, modifier: false, flags: .maskCommand),
            .key(CGKeyCode(kVK_ANSI_S), down: false, modifier: false, flags: .maskCommand),
            .key(CGKeyCode(kVK_Command), down: false, modifier: true, flags: [])])
        let question = try HostInputPlanner.plan(request(["kind": .string("key"), "keys": .array([.string("?")])]),
                                                 geometry: geometry).filter { $0.posts > 0 }
        XCTAssertEqual(question.first, .key(CGKeyCode(kVK_Shift), down: true, modifier: true, flags: .maskShift))
        XCTAssertEqual(question[1], .key(CGKeyCode(kVK_ANSI_Slash), down: true, modifier: false, flags: .maskShift))
        let both = try HostInputPlanner.plan(request(["kind": .string("key"),
            "keys": .array([.string("shift"), .string("rshift"), .string("a")])]), geometry: geometry)
            .filter { $0.posts > 0 }
        // Releasing left Shift keeps the flag while right Shift is held.
        XCTAssertEqual(both[4], .key(CGKeyCode(kVK_RightShift), down: false, modifier: true, flags: .maskShift))
        XCTAssertEqual(both[5], .key(CGKeyCode(kVK_Shift), down: false, modifier: true, flags: []))
    }

    func testTypingSendsUnicodeTextAndKeysForNewlineAndTab() throws {
        let steps = try HostInputPlanner.plan(request(["kind": .string("type"), "text": .string("é\n🎸\t")]),
                                              geometry: geometry).filter { $0.posts > 0 }
        XCTAssertEqual(steps, [.text("é"),
            .key(CGKeyCode(kVK_Return), down: true, modifier: false, flags: []),
            .key(CGKeyCode(kVK_Return), down: false, modifier: false, flags: []), .text("🎸"),
            .key(CGKeyCode(kVK_Tab), down: true, modifier: false, flags: []),
            .key(CGKeyCode(kVK_Tab), down: false, modifier: false, flags: [])])
    }

    func testGateRefusesSecureInputMismatchedTargetsAndConsentOwners() throws {
        let click = try request(["kind": .string("click"), "x": .integer(1), "y": .integer(1)])
        XCTAssertNoThrow(try HostInputGate.check(click, environment(), start: true, pointerCheck: true))
        func refused(_ value: HostInputEnvironment, _ code: String, _ input: HostInputRequest? = nil,
                     line: UInt = #line) {
            XCTAssertThrowsError(try HostInputGate.check(input ?? click, value, start: true, pointerCheck: true),
                                 line: line) { error in
                XCTAssertEqual((error as? HostInputError)?.rawValue ?? (error as? HostAXActionError)?.rawValue, code,
                               line: line)
            }
        }
        refused(environment(secure: true), "secure_input_active")
        refused(environment(bundle: "com.cmuxterm.app"), "input_target_mismatch")
        refused(environment(window: HostInputProcess(processID: 524, bundleID: "com.cmuxterm.app", executable: "cmux")),
                "input_window_mismatch")
        refused(environment(window: nil), "input_window_mismatch")
        refused(environment(window: HostInputProcess(processID: 90, bundleID: nil, executable: "SecurityAgent")),
                "human_consent_required")
        let pinned = try request(["kind": .string("click"), "x": .integer(1), "y": .integer(1),
            "target": .object(["bundle_id": .string("com.apple.logic10"), "pid": .integer(64374)])])
        refused(environment(), "input_target_mismatch", pinned)
        // The out-of-process Save panel and the menu bar act for the target.
        XCTAssertNoThrow(try HostInputGate.check(click, environment(window: HostInputProcess(processID: 54346,
            bundleID: "com.apple.appkit.xpc.openAndSavePanelService", executable: "openAndSavePanelService")),
            start: true, pointerCheck: true))
        var menu = environment(window: HostInputProcess(processID: 300, bundleID: nil, executable: nil))
        menu.windowOwnerName = "Window Server"
        menu.windowLayer = Int(CGWindowLevelForKey(.mainMenuWindow))
        XCTAssertNoThrow(try HostInputGate.check(click, menu, start: true, pointerCheck: true))
        menu.windowLayer = 25
        refused(menu, "input_window_mismatch")
    }

    func testKeyboardGateChecksFocusTitleAndOperatorInput() throws {
        let typing = try request(["kind": .string("type"), "text": .string("Mobile")])
        var value = environment(window: nil)
        XCTAssertNoThrow(try HostInputGate.check(typing, value, start: true, pointerCheck: false))
        value.focusSecure = true
        XCTAssertThrowsError(try HostInputGate.check(typing, value, start: true, pointerCheck: false))
        value.focusSecure = false
        value.focusOwner = HostInputProcess(processID: 524, bundleID: "com.cmuxterm.app", executable: "cmux")
        XCTAssertThrowsError(try HostInputGate.check(typing, value, start: true, pointerCheck: false))
        value.focusOwner = HostInputProcess(processID: 54346,
            bundleID: "com.apple.appkit.xpc.openAndSavePanelService", executable: nil)
        XCTAssertNoThrow(try HostInputGate.check(typing, value, start: true, pointerCheck: false))
        let titled = try request(["kind": .string("key"), "keys": .array([.string("cmd"), .string("s")]),
            "target": .object(["bundle_id": .string("com.apple.logic10"), "window_title": .string("Song - Tracks")])])
        value.focusedWindowTitle = "Other - Tracks"
        XCTAssertThrowsError(try HostInputGate.check(titled, value, start: true, pointerCheck: false))
        value.focusedWindowTitle = "Song - Tracks"
        XCTAssertNoThrow(try HostInputGate.check(titled, value, start: true, pointerCheck: false))
        value.operatorInputAge = 200
        XCTAssertThrowsError(try HostInputGate.check(typing, value, start: true, pointerCheck: false)) {
            XCTAssertEqual($0 as? HostInputError, .operatorInput)
        }
        let asserting = try request(["kind": .string("type"), "text": .string("x"), "operator_input": .string("assert")])
        XCTAssertNoThrow(try HostInputGate.check(asserting, value, start: true, pointerCheck: false))
        let activate = try request(["kind": .string("activate")])
        XCTAssertThrowsError(try HostInputGate.check(activate, value, start: true, pointerCheck: false))
        value.operatorInputAge = 5_000
        value.frontmost = HostInputProcess(processID: 524, bundleID: "com.cmuxterm.app", executable: "cmux")
        XCTAssertNoThrow(try HostInputGate.check(activate, value, start: true, pointerCheck: false))
    }

    func testTimeAttributionSeparatesOwnPostsFromOperatorEvents() {
        XCTAssertNil(HostOperatorInputAttribution.foreignEventAt(lastEventAt: nil, ownPostAt: 100))
        XCTAssertEqual(HostOperatorInputAttribution.foreignEventAt(lastEventAt: 900, ownPostAt: nil), 900)
        XCTAssertNil(HostOperatorInputAttribution.foreignEventAt(lastEventAt: 1_030, ownPostAt: 1_000))
        XCTAssertEqual(HostOperatorInputAttribution.foreignEventAt(lastEventAt: 1_200, ownPostAt: 1_000), 1_200)
        // A table that never records Host posts still names operator events.
        XCTAssertEqual(HostOperatorInputAttribution.foreignEventAt(lastEventAt: 500, ownPostAt: 1_000), 500)
    }

    // MARK: Step runner

    private final class Poster: HostInputPoster {
        var posted: [HostInputStep] = []
        func post(_ step: HostInputStep) -> Bool { posted.append(step); return true }
    }
    private final class Monitor: HostOperatorInputMonitoring {
        var foreign = 0
        var mode: String { "test" }
        func notePosted(at milliseconds: UInt64) {}
        func foreignInputCount(since milliseconds: UInt64) -> Int { foreign }
        func operatorInputAge(now: UInt64) -> UInt64? { nil }
    }

    private func runner(_ poster: Poster, _ monitor: Monitor, environment: @escaping @MainActor (CGPoint?, Bool) ->
                        HostInputEnvironment, onSleep: @escaping () -> Void = {}) -> HostInputSession {
        var clock: UInt64 = 1_000
        return HostInputSession(poster: poster, environment: environment, monitor: monitor,
                                now: { clock += 50; return clock }, sleep: { _ in onSleep() })
    }

    func testRunnerPostsEveryStepAndReportsCompletion() async throws {
        let poster = Poster(), monitor = Monitor()
        let input = try request(["kind": .string("click"), "x": .integer(2), "y": .integer(2)])
        let steps = try HostInputPlanner.plan(input, geometry: geometry)
        let outcome = try await runner(poster, monitor, environment: { _, _ in self.environment() })
            .run(input, steps: steps, lease: {})
        XCTAssertTrue(outcome.completed)
        XCTAssertEqual(outcome.posted, 3)
        XCTAssertEqual(poster.posted.count, 3)
    }

    func testRefusalBeforeTheFirstEventPostsNothing() async throws {
        let poster = Poster()
        let input = try request(["kind": .string("click"), "x": .integer(2), "y": .integer(2)])
        let steps = try HostInputPlanner.plan(input, geometry: geometry)
        do {
            _ = try await runner(poster, Monitor(), environment: { _, _ in self.environment(secure: true) })
                .run(input, steps: steps, lease: {})
            XCTFail("expected a refusal")
        } catch { XCTAssertEqual(error as? HostInputError, .secureInput) }
        XCTAssertTrue(poster.posted.isEmpty)
    }

    func testStopMidDragReleasesTheHeldButton() async throws {
        let poster = Poster()
        let input = try request(["kind": .string("drag"), "x": .integer(0), "y": .integer(0),
                                 "to_x": .integer(100), "to_y": .integer(0)])
        let steps = try HostInputPlanner.plan(input, geometry: geometry)
        var checks = 0
        let outcome = try await runner(poster, Monitor(), environment: { _, _ in self.environment() })
            .run(input, steps: steps, lease: {
                checks += 1
                // Stop arrives after the press and two drag events.
                if checks > 5 { throw HostLeaseError.expired }
            })
        XCTAssertFalse(outcome.completed)
        XCTAssertEqual(outcome.stopReason, "lease_lost")
        XCTAssertEqual(outcome.released, 1)
        guard case .button(.left, false, _, _, _) = poster.posted.last else {
            return XCTFail("the held button must be released last")
        }
        XCTAssertFalse(poster.posted.contains(.button(.left, down: false, at: CGPoint(x: 125.25, y: 0.25), clicks: 1,
                                                      flags: [])))
    }

    func testSecureInputMidTypingStopsAndReleasesModifiers() async throws {
        let poster = Poster()
        let input = try request(["kind": .string("key"), "keys": .array([.string("cmd"), .string("shift"),
                                                                         .string("s")])])
        let steps = try HostInputPlanner.plan(input, geometry: geometry)
        var reads = 0
        let outcome = try await runner(poster, Monitor(), environment: { _, _ in
            reads += 1
            return self.environment(secure: reads > 2)
        }).run(input, steps: steps, lease: {})
        XCTAssertEqual(outcome.stopReason, "secure_input_active")
        XCTAssertEqual(outcome.posted, 2)
        XCTAssertEqual(Array(poster.posted.suffix(2)), [
            .key(CGKeyCode(kVK_Shift), down: false, modifier: true, flags: []),
            .key(CGKeyCode(kVK_Command), down: false, modifier: true, flags: [])])
    }

    func testOperatorInputStopsYieldAndIsCountedUnderAssert() async throws {
        for policy in ["yield", "assert"] {
            let poster = Poster(), monitor = Monitor()
            let input = try request(["kind": .string("type"), "text": .string("abcdef"),
                                     "operator_input": .string(policy)])
            let steps = try HostInputPlanner.plan(input, geometry: geometry)
            var pauses = 0
            let outcome = try await runner(poster, monitor, environment: { _, _ in self.environment(window: nil) },
                                           onSleep: { pauses += 1; if pauses == 2 { monitor.foreign = 1 } })
                .run(input, steps: steps, lease: {})
            XCTAssertEqual(outcome.operatorEvents, 1, policy)
            if policy == "yield" {
                XCTAssertEqual(outcome.stopReason, "operator_input_detected")
                XCTAssertFalse(outcome.completed)
                XCTAssertEqual(outcome.posted, 4)
            } else {
                XCTAssertTrue(outcome.completed)
                XCTAssertEqual(outcome.posted, 12)
            }
        }
    }

    func testTargetChangeMidClickStopsBeforeThePress() async throws {
        let poster = Poster()
        let input = try request(["kind": .string("double_click"), "x": .integer(2), "y": .integer(2)])
        let steps = try HostInputPlanner.plan(input, geometry: geometry)
        var reads = 0
        let outcome = try await runner(poster, Monitor(), environment: { _, _ in
            reads += 1
            return reads > 3 ? self.environment(bundle: "com.cmuxterm.app") : self.environment()
        }).run(input, steps: steps, lease: {})
        XCTAssertEqual(outcome.stopReason, "input_target_mismatch")
        XCTAssertFalse(outcome.completed)
        // The first click finished; nothing is held, so nothing is released.
        XCTAssertEqual(outcome.released, 0)
        XCTAssertEqual(poster.posted.filter { if case .button(_, true, _, _, _) = $0 { return true }; return false }
                        .count, 1)
    }
}
