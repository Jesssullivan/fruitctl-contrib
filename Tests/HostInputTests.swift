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
        value.focusOwner = HostInputProcess(processID: front, bundleID: bundle, executable: "Logic Pro X")
        value.focusIsText = true
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
        let steps = try HostInputPlanner.plan(request(["kind": .string("type"), "text": .string("é🎸\t")]),
                                              geometry: geometry).filter { $0.posts > 0 }
        XCTAssertEqual(steps, [.text("é"), .text("🎸"),
            .key(CGKeyCode(kVK_Tab), down: true, modifier: false, flags: []),
            .key(CGKeyCode(kVK_Tab), down: false, modifier: false, flags: [])])
        let line = try HostInputPlanner.plan(request(["kind": .string("type"), "text": .string("ok\n")]),
                                             geometry: geometry).filter { $0.posts > 0 }
        XCTAssertEqual(line.last, .key(CGKeyCode(kVK_Return), down: false, modifier: false, flags: []))
        // A newline or tab can move focus, so only the last character may be one.
        for text in ["a\nb", "user\tsecret", "x\u{202E}y", "x\u{85}y"] {
            XCTAssertThrowsError(try request(["kind": .string("type"), "text": .string(text)]), text)
        }
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
        menu.windowOwnerIsWindowServer = true
        menu.windowLayer = Int(CGWindowLevelForKey(.mainMenuWindow))
        XCTAssertNoThrow(try HostInputGate.check(click, menu, start: true, pointerCheck: true))
        // An application that names itself "Window Server" is not the menu bar.
        menu.windowOwnerIsWindowServer = false
        refused(menu, "input_window_mismatch")
        menu.windowOwnerIsWindowServer = true
        menu.windowLayer = 25
        refused(menu, "input_window_mismatch")
    }

    func testKeyboardGateChecksFocusTitleAndOperatorInput() throws {
        let typing = try request(["kind": .string("type"), "text": .string("Mobile")])
        var value = environment(window: nil)
        value.focusIsText = false
        XCTAssertThrowsError(try HostInputGate.check(typing, value, start: true, pointerCheck: false)) {
            XCTAssertEqual($0 as? HostInputError, .focusUnavailable)
        }
        value.focusIsText = true
        XCTAssertNoThrow(try HostInputGate.check(typing, value, start: true, pointerCheck: false))
        value.focusSecure = true
        XCTAssertThrowsError(try HostInputGate.check(typing, value, start: true, pointerCheck: false))
        value.focusSecure = false
        value.focusOwner = HostInputProcess(processID: 524, bundleID: "com.cmuxterm.app", executable: "cmux")
        XCTAssertThrowsError(try HostInputGate.check(typing, value, start: true, pointerCheck: false))
        value.focusOwner = HostInputProcess(processID: 54346,
            bundleID: "com.apple.appkit.xpc.openAndSavePanelService", executable: nil)
        XCTAssertNoThrow(try HostInputGate.check(typing, value, start: true, pointerCheck: false))
        value.monitorMode = "event_tap_pointer"
        XCTAssertThrowsError(try HostInputGate.check(typing, value, start: true, pointerCheck: false)) {
            XCTAssertEqual($0 as? HostInputError, .monitorUnavailable)
        }
        value.monitorMode = "event_tap"
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
        let activate = try request(["kind": .string("activate"), "operator_input": .string("assert")])
        // Activation yields to recent operator input even under assert.
        XCTAssertThrowsError(try HostInputGate.check(activate, value, start: true, pointerCheck: false))
        value.operatorInputAge = 1_500
        XCTAssertThrowsError(try HostInputGate.check(activate, value, start: true, pointerCheck: false))
        value.operatorInputAge = 5_000
        value.frontmost = HostInputProcess(processID: 524, bundleID: "com.cmuxterm.app", executable: "cmux")
        XCTAssertNoThrow(try HostInputGate.check(activate, value, start: true, pointerCheck: false))
    }

    func testSystemShortcutsAndTheAppleMenuAreRefused() throws {
        for keys in [["cmd", "tab"], ["command", "space"], ["ctrl", "cmd", "q"], ["cmd", "option", "escape"],
                     ["rcmd", "shift", "q"], ["ctrl", "f2"], ["ctrl", "right"], ["cmd", "shift", "tab"], ["cmd", "f5"]] {
            let combo = try request(["kind": .string("key"), "keys": .array(keys.map { .string($0) })])
            XCTAssertThrowsError(try HostInputGate.check(combo, environment(window: nil), start: true,
                                                         pointerCheck: false), "\(keys)") {
                XCTAssertEqual($0 as? HostInputError, .systemShortcut)
            }
        }
        let save = try request(["kind": .string("key"), "keys": .array([.string("cmd"), .string("s")])])
        XCTAssertNoThrow(try HostInputGate.check(save, environment(window: nil), start: true, pointerCheck: false))
        let click = try request(["kind": .string("click"), "x": .integer(1), "y": .integer(1)])
        var menu = environment(window: HostInputProcess(processID: 300, bundleID: nil, executable: nil))
        menu.windowOwnerName = "Window Server"
        menu.windowOwnerIsWindowServer = true
        menu.windowLayer = Int(CGWindowLevelForKey(.mainMenuWindow))
        // An unreadable Apple menu frame refuses the menu bar.
        XCTAssertThrowsError(try HostInputGate.check(click, menu, start: true, pointerCheck: true,
                                                     point: CGPoint(x: 160, y: 10)))
        menu.appleMenuFrame = CGRect(x: 100, y: 0, width: 30, height: 24)
        XCTAssertThrowsError(try HostInputGate.check(click, menu, start: true, pointerCheck: true,
                                                     point: CGPoint(x: 110, y: 10)))
        XCTAssertNoThrow(try HostInputGate.check(click, menu, start: true, pointerCheck: true,
                                                 point: CGPoint(x: 160, y: 10)))
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
        func notePosted(_ kinds: [CGEventType], at milliseconds: UInt64) {}
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
        // A drag in progress is cancelled: Escape, back to the press point, release there.
        XCTAssertEqual(outcome.released, 4)
        let origin = CGPoint(x: 100.25, y: 0.25)
        XCTAssertEqual(Array(poster.posted.suffix(4)), [
            .key(CGKeyCode(kVK_Escape), down: true, modifier: false, flags: []),
            .key(CGKeyCode(kVK_Escape), down: false, modifier: false, flags: []),
            .drag(.left, origin, flags: []), .button(.left, down: false, at: origin, clicks: 1, flags: [])])
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

    func testDragOntoAnotherAppIsRefusedBeforeThePress() async throws {
        let poster = Poster()
        let input = try request(["kind": .string("drag"), "x": .integer(0), "y": .integer(0),
                                 "to_x": .integer(400), "to_y": .integer(0)])
        let steps = try HostInputPlanner.plan(input, geometry: geometry)
        let finder = HostInputProcess(processID: 400, bundleID: "com.apple.finder", executable: "Finder")
        do {
            _ = try await runner(poster, Monitor(), environment: { point, _ in
                (point?.x ?? 0) > 200 ? self.environment(window: finder) : self.environment()
            }).run(input, steps: steps, lease: {})
            XCTFail("expected a refusal")
        } catch { XCTAssertEqual((error as? HostInputRefusal)?.error, .windowMismatch) }
        XCTAssertTrue(poster.posted.isEmpty)
    }

    func testReleaseHeldFreesButtonsAndKeysWithoutMoving() async throws {
        let poster = Poster()
        let input = try request(["kind": .string("key"), "keys": .array([.string("cmd"), .string("s")])])
        let steps = try HostInputPlanner.plan(input, geometry: geometry)
        var session: HostInputSession?
        var pauses = 0
        session = runner(poster, Monitor(), environment: { _, _ in self.environment(window: nil) }, onSleep: {
            pauses += 1
            // Stop arrives while Command is held: release it at once.
            if pauses == 1 { XCTAssertEqual(session?.releaseHeld(), 1) }
        })
        _ = try await session!.run(input, steps: steps, lease: {})
        XCTAssertTrue(poster.posted.contains(.key(CGKeyCode(kVK_Command), down: false, modifier: true, flags: [])))
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

    // #172: the software cursor and plug-in host windows.
    private let cursorLayer = Int(CGWindowLevelForKey(.cursorWindow))
    private let windowServerPID: pid_t = 185
    private func isWindowServer(_ pid: pid_t) -> Bool { pid == windowServerPID }

    private func logicWindows(cursorAt pointer: CGPoint) -> [HostWindowInfo] {
        [HostWindowInfo(processID: 185, number: 3, ownerName: "Window Server", layer: cursorLayer,
                        bounds: CGRect(x: pointer.x - 5, y: pointer.y - 5, width: 28, height: 40)),
         HostWindowInfo(processID: 185, number: 4213, ownerName: "Window Server", name: "StatusIndicator",
                        layer: cursorLayer, bounds: CGRect(x: 1610, y: 1, width: 28, height: 28)),
         HostWindowInfo(processID: 34968, number: 5529, ownerName: "Fruitctl Host", layer: 25,
                        bounds: CGRect(x: 0, y: 0, width: 1637, height: 1024)),
         HostWindowInfo(processID: 64374, number: 5757, ownerName: "Logic Pro", layer: 3,
                        bounds: CGRect(x: 639, y: 285, width: 538, height: 996)),
         HostWindowInfo(processID: 64374, number: 3514, ownerName: "Logic Pro", layer: 0,
                        bounds: CGRect(x: 0, y: 30, width: 1637, height: 994))]
    }

    private func pick(_ point: CGPoint, _ windows: [HostWindowInfo], pointer: CGPoint?, panels: Set<Int> = [5529],
                      namesReadable: Bool = true) -> (top: HostWindowInfo?, parent: HostWindowInfo?) {
        HostInputWindowList.under(point, in: windows, pointer: pointer, ownProcess: 34968, ownPanels: panels,
                                  namesReadable: namesReadable, isWindowServer: isWindowServer)
    }

    func testTheSoftwareCursorWindowIsLookedThroughAtThePointer() {
        let ratio = CGPoint(x: 922, y: 497)
        let windows = logicWindows(cursorAt: ratio)
        XCTAssertEqual(pick(ratio, windows, pointer: ratio).top?.number, 5757)
        // The status indicator shares the cursor level but is named: it stays.
        XCTAssertEqual(pick(CGPoint(x: 1620, y: 10), windows, pointer: ratio).top?.number, 4213)
        // A cursor-level window away from the pointer is not the cursor.
        XCTAssertEqual(pick(ratio, windows, pointer: CGPoint(x: 10, y: 900)).top?.number, 3)
        // Without readable names no window is looked through.
        XCTAssertEqual(pick(ratio, windows, pointer: ratio, namesReadable: false).top?.number, 3)
        // A process that calls itself "Window Server" is never looked through.
        var spoof = windows
        spoof[0] = HostWindowInfo(processID: 524, number: 9, ownerName: "Window Server", layer: cursorLayer,
                                  bounds: windows[0].bounds)
        XCTAssertEqual(pick(ratio, spoof, pointer: ratio).top?.processID, 524)
        // Nor is a cursor-level window larger than any cursor.
        var large = windows
        large[0] = HostWindowInfo(processID: 185, number: 3, ownerName: "Window Server", layer: cursorLayer,
                                  bounds: CGRect(x: 0, y: 0, width: 1637, height: 1024))
        XCTAssertEqual(pick(ratio, large, pointer: ratio).top?.number, 3)
        // The Host's own windows other than its indicator panels stay.
        XCTAssertEqual(pick(ratio, windows, pointer: ratio, panels: []).top?.number, 5529)
        // Window list entries without an owner or bounds are skipped.
        XCTAssertNil(HostWindowInfo([kCGWindowOwnerName as String: "Logic Pro"]))
    }

    func testAPluginViewsParentIsTheWindowDirectlyBelowThatContainsIt() {
        let point = CGPoint(x: 700, y: 400)
        let view = HostWindowInfo(processID: 95123, number: 7000, ownerName: "AUHostingServiceXPC_arrow", layer: 3,
                                  bounds: CGRect(x: 650, y: 320, width: 400, height: 300))
        let plugin = HostWindowInfo(processID: 64374, number: 5757, ownerName: "Logic Pro", layer: 3,
                                    bounds: CGRect(x: 639, y: 285, width: 538, height: 996))
        let main = HostWindowInfo(processID: 64374, number: 3514, ownerName: "Logic Pro", layer: 0,
                                  bounds: CGRect(x: 0, y: 30, width: 1637, height: 994))
        let other = HostWindowInfo(processID: 700, number: 8000, ownerName: "GarageBand", layer: 3,
                                   bounds: CGRect(x: 600, y: 300, width: 600, height: 400))
        XCTAssertEqual(pick(point, [view, plugin, main], pointer: nil).parent?.number, 5757)
        // A window elsewhere on screen ordered between them does not separate them.
        let elsewhere = HostWindowInfo(processID: 524, number: 9000, ownerName: "cmux", layer: 3,
                                       bounds: CGRect(x: 1300, y: 600, width: 200, height: 200))
        XCTAssertEqual(pick(point, [view, elsewhere, plugin, main], pointer: nil).parent?.number, 5757)
        // Another host's plug-in window directly below: its parent is not Logic.
        XCTAssertEqual(pick(point, [view, other, plugin, main], pointer: nil).parent?.processID, 700)
        // Logic's main window covers the point but is at another layer.
        XCTAssertNil(pick(point, [view, main], pointer: nil).parent)
        // A window directly below that does not contain the view is no parent.
        let small = HostWindowInfo(processID: 64374, number: 5758, ownerName: "Logic Pro", layer: 3,
                                   bounds: CGRect(x: 690, y: 390, width: 50, height: 50))
        XCTAssertNil(pick(point, [view, small, main], pointer: nil).parent)
    }

    func testAClickInAPluginWindowCompletesWhenTheCursorWindowAppears() async throws {
        // neo, 2026-11-03: the start check passed, then the button-down
        // check after the move saw the cursor window (input_window_mismatch
        // after 1 event).
        let poster = Poster()
        let input = try request(["kind": .string("double_click"), "x": .integer(2), "y": .integer(2)])
        let steps = try HostInputPlanner.plan(input, geometry: geometry)
        var reads = 0
        let outcome = try await runner(poster, Monitor(), environment: { point, start in
            reads += 1
            guard let point else { return self.environment(front: 64374, window: nil) }
            // Before the move the pointer is elsewhere; after it, the cursor
            // window sits on the point.
            let pointer = start ? CGPoint(x: 1500, y: 900) : point
            let windows = [
                HostWindowInfo(processID: 185, number: 3, ownerName: "Window Server", layer: self.cursorLayer,
                               bounds: CGRect(x: pointer.x - 5, y: pointer.y - 5, width: 28, height: 40)),
                HostWindowInfo(processID: 64374, number: 5757, ownerName: "Logic Pro", layer: 3,
                               bounds: CGRect(x: 0, y: 0, width: 2000, height: 2000))]
            let found = self.pick(point, windows, pointer: pointer)
            var value = self.environment(front: 64374, window: found.top.map {
                HostInputProcess(processID: $0.processID, bundleID: nil, executable: $0.ownerName) })
            value.windowOwnerName = found.top?.ownerName
            value.windowLayer = found.top?.layer
            value.windowParentOwnerPID = found.parent?.processID
            return value
        }).run(input, steps: steps, lease: {})
        XCTAssertTrue(outcome.completed, outcome.stopReason ?? "")
        XCTAssertGreaterThan(reads, 2)
    }

    func testAPluginHostWindowActsForTheTargetOnlyOverTheTargetsWindow() throws {
        let click = try request(["kind": .string("click"), "x": .integer(1), "y": .integer(1)])
        func check(_ owner: HostInputProcess, parent: pid_t?) throws {
            var value = environment(window: owner)
            value.frontmost = HostInputProcess(processID: 529, bundleID: "com.apple.logic10", executable: "Logic Pro X",
                                               bundlePath: "/Applications/Logic Pro.app")
            value.windowParentOwnerPID = parent
            try HostInputGate.check(click, value, start: true, pointerCheck: true)
        }
        var service = HostInputProcess(processID: 95123, bundleID: nil, executable: "AUHostingServiceXPC_arrow")
        service.parentProcessID = 1
        service.appleCodeIdentifier = "com.apple.audio.AUHostingService.arm64e"
        XCTAssertNoThrow(try check(service, parent: 529))
        // Over another application's window, or with no containing parent.
        XCTAssertThrowsError(try check(service, parent: 524)) { XCTAssertEqual($0 as? HostInputError, .windowMismatch) }
        XCTAssertThrowsError(try check(service, parent: nil)) { XCTAssertEqual($0 as? HostInputError, .windowMismatch) }
        // The same name without a valid Apple signature is not the service.
        var unsigned = service
        unsigned.appleCodeIdentifier = nil
        XCTAssertThrowsError(try check(unsigned, parent: 529))
        // Another Apple-signed process is not enumerated.
        var other = service
        other.appleCodeIdentifier = "com.apple.controlcenter"
        XCTAssertThrowsError(try check(other, parent: 529))
        // A helper of the target: a child, not a regular app, inside its bundle.
        var helper = HostInputProcess(processID: 700, bundleID: nil, executable: "PluginHost")
        helper.parentProcessID = 529
        helper.regularApplication = false
        helper.executablePath = "/Applications/Logic Pro.app/Contents/XPCServices/PluginHost.xpc/Contents/MacOS/PluginHost"
        XCTAssertNoThrow(try check(helper, parent: 529))
        XCTAssertThrowsError(try check(helper, parent: 524))
        var outside = helper
        outside.executablePath = "/usr/bin/osascript"
        XCTAssertThrowsError(try check(outside, parent: 529))
        var prefix = helper
        prefix.executablePath = "/Applications/Logic Pro.app Evil/x"
        XCTAssertThrowsError(try check(prefix, parent: 529))
        var regular = helper
        regular.regularApplication = true
        XCTAssertThrowsError(try check(regular, parent: 529))
        var unknown = helper
        unknown.regularApplication = nil
        XCTAssertThrowsError(try check(unknown, parent: 529))
        var orphan = helper
        orphan.parentProcessID = 1
        XCTAssertThrowsError(try check(orphan, parent: 529))
        // A consent dialog owner is refused whatever lies beneath it.
        let agent = HostInputProcess(processID: 90, bundleID: nil, executable: "SecurityAgent",
                                 appleCodeIdentifier: "com.apple.audio.AUHostingService.arm64e")
        XCTAssertThrowsError(try check(agent, parent: 529)) {
            XCTAssertEqual(($0 as? HostAXActionError)?.rawValue, "human_consent_required")
        }
        XCTAssertFalse(HostPluginHosting.serves(service, target: service))
    }

    // #178: hot corners and the auto-hidden Dock edge.
    func testScreenEdgesReadDockPreferences() {
        let edges = HostScreenEdges.from(cornerActions: [.topLeft: 0, .topRight: 1, .bottomLeft: 5, .bottomRight: 14],
                                         dockAutohide: true, dockOrientation: "left")
        XCTAssertEqual(edges.corners, [.bottomLeft, .bottomRight])
        XCTAssertEqual(edges.dockEdge, .left)
        XCTAssertNil(HostScreenEdges.from(cornerActions: [:], dockAutohide: false, dockOrientation: "left").dockEdge)
        XCTAssertEqual(HostScreenEdges.from(cornerActions: [:], dockAutohide: true, dockOrientation: nil).dockEdge, .bottom)
        let rects = edges.forbiddenRects(on: CGRect(x: 0, y: 0, width: 1637, height: 1024))
        XCTAssertTrue(rects.contains(CGRect(x: 1625, y: 1012, width: 12, height: 12)))
        XCTAssertTrue(rects.contains(CGRect(x: 0, y: 0, width: 4, height: 1024)))
    }

    func testThePointerNeverReachesAnActiveCornerOrTheDockEdge() throws {
        let edges = HostScreenEdges(corners: [.bottomRight], dockEdge: .left)
        // The test display is 256 by 128 points at x 100; pixel (511, 255) is its bottom-right corner.
        let corner = try HostInputPlanner.plan(request(["kind": .string("click"), "x": .integer(511), "y": .integer(255)]),
                                               geometry: geometry)
        XCTAssertThrowsError(try edges.check(corner, display: geometry.bounds)) {
            XCTAssertEqual($0 as? HostInputError, .screenEdge)
        }
        let dock = try HostInputPlanner.plan(request(["kind": .string("move"), "x": .integer(2), "y": .integer(100)]),
                                             geometry: geometry)
        XCTAssertThrowsError(try edges.check(dock, display: geometry.bounds))
        // A drag that passes through the corner on its way is refused too.
        // From point (325.25, 127.75) to (355.75, 115.25): the end is just above
        // the corner square, but the path crosses it.
        let drag = try HostInputPlanner.plan(request(["kind": .string("drag"), "x": .integer(450), "y": .integer(255),
            "to_x": .integer(511), "to_y": .integer(230)]), geometry: geometry)
        XCTAssertThrowsError(try edges.check(drag, display: geometry.bounds))
        let endOnly = try HostInputPlanner.plan(request(["kind": .string("click"), "x": .integer(511), "y": .integer(230)]),
                                                geometry: geometry)
        XCTAssertNoThrow(try edges.check(endOnly, display: geometry.bounds))
        let inside = try HostInputPlanner.plan(request(["kind": .string("click"), "x": .integer(200), "y": .integer(100)]),
                                               geometry: geometry)
        XCTAssertNoThrow(try edges.check(inside, display: geometry.bounds))
        XCTAssertNoThrow(try HostScreenEdges.none.check(corner, display: geometry.bounds))
        let keys = try HostInputPlanner.plan(request(["kind": .string("key"), "keys": .array([.string("escape")])]),
                                             geometry: geometry)
        XCTAssertNoThrow(try edges.check(keys, display: geometry.bounds))
    }

    // #179: focus held by the target's AU hosting process.
    func testPluginFocusTakesKeysAndShortNumbers() throws {
        var service = HostInputProcess(processID: 15776, bundleID: nil, executable: "AUHostingServiceXPC_arrow")
        service.appleCodeIdentifier = "com.apple.audio.AUHostingService.arm64e"
        var value = environment(window: nil)
        value.focusOwner = service
        value.focusIsText = false
        let tune = try request(["kind": .string("type"), "text": .string("-0.22")])
        XCTAssertNoThrow(try HostInputGate.check(tune, value, start: true, pointerCheck: false))
        let words = try request(["kind": .string("type"), "text": .string("abc")])
        XCTAssertThrowsError(try HostInputGate.check(words, value, start: true, pointerCheck: false)) {
            XCTAssertEqual($0 as? HostInputError, .focusUnavailable)
        }
        let selectAll = try request(["kind": .string("key"), "keys": .array([.string("cmd"), .string("a")])])
        XCTAssertNoThrow(try HostInputGate.check(selectAll, value, start: true, pointerCheck: false))
        // An unrelated process holding focus is still refused.
        value.focusOwner = HostInputProcess(processID: 524, bundleID: "com.cmuxterm.app", executable: "cmux")
        XCTAssertThrowsError(try HostInputGate.check(selectAll, value, start: true, pointerCheck: false)) {
            XCTAssertEqual($0 as? HostInputError, .targetMismatch)
        }
        // Inside the target's own process an unreadable focus still refuses typing.
        value.focusOwner = HostInputProcess(processID: 529, bundleID: "com.apple.logic10", executable: "Logic Pro X")
        XCTAssertThrowsError(try HostInputGate.check(tune, value, start: true, pointerCheck: false))
        XCTAssertTrue(HostInputGate.numericEntry("+12,5"))
        for bad in ["", "1e3", "12345678901234567", "1\n", " 1"] { XCTAssertFalse(HostInputGate.numericEntry(bad), bad) }
    }

    // #182: the refusing window travels with the refusal.
    func testAWindowRefusalNamesTheWindow() async throws {
        let poster = Poster()
        let input = try request(["kind": .string("click"), "x": .integer(2), "y": .integer(2)])
        let steps = try HostInputPlanner.plan(input, geometry: geometry)
        var cmux = HostInputProcess(processID: 524, bundleID: "com.cmuxterm.app", executable: "cmux")
        cmux.appleCodeIdentifier = nil
        var value = environment(window: cmux)
        value.windowOwnerName = "cmux"
        value.windowLayer = 0
        value.windowBounds = CGRect(x: 10.4, y: 20, width: 300, height: 200.6)
        do {
            _ = try await runner(poster, Monitor(), environment: { _, _ in value }).run(input, steps: steps, lease: {})
            XCTFail("expected a refusal")
        } catch let refusal as HostInputRefusal {
            XCTAssertEqual(refusal.error, .windowMismatch)
            XCTAssertEqual(refusal.detail["schema"], .string("fruitctl.host-window-refusal.v1"))
            XCTAssertEqual(refusal.detail["owner_pid"], .integer(524))
            XCTAssertEqual(refusal.detail["owner_name"], .string("cmux"))
            XCTAssertEqual(refusal.detail["owner_bundle_id"], .string("com.cmuxterm.app"))
            XCTAssertEqual(refusal.detail["layer"], .integer(0))
            XCTAssertEqual(refusal.detail["bounds"], .object(["x": .integer(10), "y": .integer(20),
                                                             "width": .integer(300), "height": .integer(201)]))
            XCTAssertEqual(refusal.detail["frontmost_pid"], .integer(529))
        }
        XCTAssertTrue(poster.posted.isEmpty)
        // A window check that stops an action after the move reports it too.
        var reads = 0
        let outcome = try await runner(poster, Monitor(), environment: { _, _ in
            reads += 1
            return reads > 1 ? value : self.environment()
        }).run(input, steps: steps, lease: {})
        XCTAssertEqual(outcome.stopReason, "input_window_mismatch")
        XCTAssertEqual(outcome.stopDetail?["owner_name"], .string("cmux"))
        let metadata = outcome.metadata(input, frontmost: nil, monitor: "event_tap")
        XCTAssertNotNil(metadata["stop_detail"])
        // On the wire the detail is the error's data; a capture diagnostic is unchanged.
        let line = try HostResponse.failure(id: .string("r1"), message: "input_window_mismatch",
                                            detail: refusal(value)).line()
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: line) as? [String: Any])
        let error = try XCTUnwrap(json["error"] as? [String: Any])
        XCTAssertEqual((error["data"] as? [String: Any])?["owner_pid"] as? Int, 524)
        let plain = try JSONSerialization.jsonObject(with: HostResponse.failure(id: .string("r2"), message: "x").line())
        XCTAssertNil(((plain as? [String: Any])?["error"] as? [String: Any])?["data"])
    }

    private func refusal(_ value: HostInputEnvironment) -> [String: HostValue] { HostInputGate.windowDetail(value) }

    func testAnInterruptedModifierDragLiftsKeysBeforeEscape() async throws {
        let poster = Poster()
        let input = try request(["kind": .string("drag"), "x": .integer(10), "y": .integer(10),
            "to_x": .integer(200), "to_y": .integer(100), "modifiers": .array([.string("cmd"), .string("alt")])])
        let steps = try HostInputPlanner.plan(input, geometry: geometry)
        var session: HostInputSession?
        var pauses = 0
        session = runner(poster, Monitor(), environment: { _, _ in self.environment() }, onSleep: {
            pauses += 1
            // Stop lands while the drag is moving.
            if pauses == 6 { _ = session?.releaseHeld() }
        })
        _ = try? await session!.run(input, steps: steps, lease: {})
        let escape = try XCTUnwrap(poster.posted.firstIndex(of: .key(CGKeyCode(kVK_Escape), down: true, modifier: false,
                                                                     flags: [])))
        // Both held modifiers (Cmd and Option) are up before the Escape.
        let upsBefore = poster.posted[..<escape].filter {
            if case .key(_, false, true, _) = $0 { return true }; return false
        }.count
        XCTAssertEqual(upsBefore, 2)
    }
}
