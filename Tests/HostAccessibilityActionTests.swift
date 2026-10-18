import ApplicationServices
import CoreGraphics
import Foundation
import XCTest

/// A fake element whose live reads come from a script and whose one AX call
/// is recorded. The last scripted read repeats.
private final class ScriptedAXNode: HostAXNode {
    let recorded: HostAXAttributes
    let nested: [ScriptedAXNode]
    var reads: [HostAXLiveRead]
    var result: HostAXPerformResult
    private(set) var performed: [HostAXOperation] = []
    private(set) var liveReads = 0

    init(_ role: String, subrole: String? = nil, children: [ScriptedAXNode] = [],
         reads: [HostAXLiveRead] = [.invalid], result: HostAXPerformResult = .performed) {
        recorded = HostAXAttributes(role: role, subrole: subrole)
        nested = children
        self.reads = reads
        self.result = result
    }

    func attributes() -> HostAXAttributes { recorded }
    func children(limit: Int) -> [HostAXNode] { Array(nested.prefix(limit)) }
    func liveState() -> HostAXLiveRead {
        defer { liveReads += 1 }
        return reads[min(liveReads, reads.count - 1)]
    }
    func perform(_ operation: HostAXOperation) -> HostAXPerformResult { performed.append(operation); return result }
}

final class HostAccessibilityActionTests: XCTestCase {
    private let retina = HostDisplayGeometry.compute(modePixelWidth: 3024, modePixelHeight: 1964,
        bounds: CGRect(x: 0, y: 0, width: 1512, height: 982))!

    private func state(_ role: String, actions: [String] = [], focusSettable: Bool = false,
                       frame: CGRect? = CGRect(x: 10, y: 20, width: 30, height: 40)) -> HostAXLiveState {
        var live = HostAXLiveState()
        live.role = role; live.actions = actions; live.focusSettable = focusSettable; live.frame = frame
        return live
    }

    /// Builds a retained generation through the real snapshot builder.
    private func generation(_ applications: [HostAXApplication], number: UInt64 = 3,
                            session: String = "session-a", display: UInt64 = 7) throws -> HostAXGeneration {
        let built = try HostAccessibilitySnapshot.buildRetained(applications: applications,
            request: HostAXRequest(depth: 6, focusedApplicationOnly: true), geometry: retina,
            generation: number) { false }
        return HostAXGeneration(number: number, sessionID: session, displayGeneration: display,
                                geometry: retina, elements: built.elements)
    }

    private func request(_ ref: String, _ kind: HostAXActionKind = .press, generation: UInt64 = 3,
                         fallback: Bool = true) -> HostAXActionRequest {
        HostAXActionRequest(generation: generation, ref: ref, kind: kind, vncFallback: fallback)
    }

    // MARK: Request and generation

    func testRequestParsingRequiresGenerationRefAndKnownAction() throws {
        XCTAssertEqual(try HostAXActionRequest.parse(["generation": .integer(4), "ref": .string("ax:77:0.1.2"),
                                                      "action": .string("focus"), "vnc_fallback": .boolean(true)]),
                       HostAXActionRequest(generation: 4, ref: "ax:77:0.1.2", kind: .focus, vncFallback: true))
        XCTAssertEqual(try HostAXActionRequest.parse(["generation": .integer(1), "ref": .string("ax:1:0"),
                                                      "action": .string("press")]).vncFallback, false)
        let valid: [String: HostValue] = ["generation": .integer(1), "ref": .string("ax:1:0"), "action": .string("press")]
        for (key, value) in [("generation", HostValue.integer(0)), ("generation", .string("1")),
                             ("ref", .string("ax:1:0;rm")), ("ref", .string("1:0")),
                             ("ref", .string("ax:" + String(repeating: "1", count: 80))),
                             ("action", .string("click")), ("vnc_fallback", .string("yes"))] {
            var params = valid
            params[key] = value
            XCTAssertThrowsError(try HostAXActionRequest.parse(params), "\(key)=\(value)")
        }
    }

    func testRefsResolveOnlyInTheirOwnGenerationSessionDisplayAndGeometry() throws {
        let button = ScriptedAXNode("AXButton")
        let app = ScriptedAXNode("AXApplication", children: [ScriptedAXNode("AXWindow", children: [button])])
        let current = try generation([HostAXApplication(processID: 77, bundleID: "com.example", name: nil, root: app)])
        let resolved = try current.resolve(request("ax:77:0.0.0"), sessionID: "session-a", displayGeneration: 7,
                                           geometry: retina)
        XCTAssertTrue(resolved.node as AnyObject === button)
        XCTAssertEqual(resolved.parent, "ax:77:0.0")
        XCTAssertEqual(resolved.processID, 77)

        let other = HostDisplayGeometry.compute(modePixelWidth: 1920, modePixelHeight: 1080,
                                                bounds: CGRect(x: 0, y: 0, width: 1920, height: 1080))
        let stale: [(HostAXActionRequest, String, UInt64, HostDisplayGeometry?)] = [
            (request("ax:77:0.0.0", generation: 2), "session-a", 7, retina),
            (request("ax:77:0.0.9"), "session-a", 7, retina),
            (request("ax:77:0.0.0"), "session-b", 7, retina),
            (request("ax:77:0.0.0"), "session-a", 8, retina),
            (request("ax:77:0.0.0"), "session-a", 7, other),
            (request("ax:77:0.0.0"), "session-a", 7, nil)]
        for (candidate, session, display, geometry) in stale {
            XCTAssertThrowsError(try current.resolve(candidate, sessionID: session, displayGeneration: display,
                                                     geometry: geometry)) {
                XCTAssertEqual($0 as? HostAXActionError, .staleRef)
            }
        }
    }

    func testSnapshotReportsItsGeneration() throws {
        let built = try HostAccessibilitySnapshot.buildRetained(
            applications: [HostAXApplication(processID: 5, bundleID: nil, name: nil, root: ScriptedAXNode("AXApplication"))],
            request: HostAXRequest(depth: 2, focusedApplicationOnly: true, menuExtras: true), geometry: retina,
            generation: 9) { false }
        guard case .object(let snapshot) = built.value["ax_snapshot"] else { return XCTFail("no snapshot") }
        XCTAssertEqual(snapshot["generation"], .integer(9))
        XCTAssertEqual(snapshot["menu_extras"], .boolean(true))
        XCTAssertEqual(Array(built.elements.keys), ["ax:5:0"])
    }

    // MARK: Surfaces

    func testSurfaceFollowsTheNearestRecordedSubrole() throws {
        let sheetButton = ScriptedAXNode("AXButton")
        let sheet = ScriptedAXNode("AXSheet", children: [sheetButton])
        let window = ScriptedAXNode("AXWindow", children: [sheet, ScriptedAXNode("AXButton")])
        let popover = ScriptedAXNode("AXPopover", children: [ScriptedAXNode("AXCheckBox")])
        let item = ScriptedAXNode("AXMenuItem")
        let extra = ScriptedAXNode("AXMenuBarItem", subrole: "AXMenuExtra",
                                   children: [ScriptedAXNode("AXMenu", children: [item])])
        let extras = ScriptedAXNode("AXMenuBar", children: [extra])
        let app = ScriptedAXNode("AXApplication", children: [window, popover, extras])
        let center = ScriptedAXNode("AXApplication", children: [
            ScriptedAXNode("AXMenuBar", children: [ScriptedAXNode("AXMenuBarItem", subrole: "AXMenuExtra")]),
            ScriptedAXNode("AXWindow", children: [ScriptedAXNode("AXCheckBox")])])
        let snapshot = try generation([
            HostAXApplication(processID: 10, bundleID: "com.example", name: nil, root: app),
            HostAXApplication(processID: 20, bundleID: "com.apple.controlcenter", name: nil, root: center)])
        XCTAssertEqual(snapshot.surface(of: "ax:10:0.0.0.0"), .sheet)
        XCTAssertEqual(snapshot.surface(of: "ax:10:0.0.1"), .window)
        XCTAssertEqual(snapshot.surface(of: "ax:10:0.1.0"), .popover)
        XCTAssertEqual(snapshot.surface(of: "ax:10:0.2.0"), .menuExtra)
        XCTAssertEqual(snapshot.surface(of: "ax:10:0.2.0.0.0"), .menu)
        XCTAssertEqual(snapshot.surface(of: "ax:10:0"), .application)
        XCTAssertEqual(snapshot.surface(of: "ax:20:0.0.0"), .menuExtra)
        XCTAssertEqual(snapshot.surface(of: "ax:20:0.1.0"), .controlCenter)
    }

    // MARK: Planning

    func testAccessibilityActionsArePreferredOverAVNCClick() throws {
        XCTAssertEqual(try HostAXActionPlanner.plan(.press, state: state("AXButton", actions: ["AXShowMenu", "AXPress"]),
            surface: .window, geometry: retina, remoteViewService: false, vncFallback: true), .perform(.press))
        XCTAssertEqual(try HostAXActionPlanner.plan(.press, state: state("AXMenuBarItem", actions: ["AXShowMenu"]),
            surface: .menuExtra, geometry: retina, remoteViewService: false, vncFallback: true), .perform(.showMenu))
        XCTAssertEqual(try HostAXActionPlanner.plan(.focus, state: state("AXTextField", focusSettable: true),
            surface: .sheet, geometry: retina, remoteViewService: false, vncFallback: true), .perform(.focus))
        XCTAssertEqual(try HostAXActionPlanner.plan(.focus, state: state("AXWindow", actions: ["AXRaise"]),
            surface: .window, geometry: retina, remoteViewService: true, vncFallback: false), .perform(.raise))
        // AXShowMenu outside a menu bar is not a press.
        XCTAssertEqual(try HostAXActionPlanner.plan(.press, state: state("AXImage", actions: ["AXShowMenu"]),
            surface: .window, geometry: retina, remoteViewService: false, vncFallback: true),
            .vncClick(x: 50, y: 80))
    }

    func testVNCFallbackOnlyForAMappedLeafOfAReachableOwner() {
        func refusal(_ live: HostAXLiveState, remote: Bool = false, allowed: Bool = true) -> HostAXActionError? {
            do {
                _ = try HostAXActionPlanner.plan(.press, state: live, surface: .window, geometry: retina,
                                                 remoteViewService: remote, vncFallback: allowed)
                return nil
            } catch { return error as? HostAXActionError }
        }
        // Points (10,20,30,40) on a 2x display: pixels (20,40,60,80), centre (50,80).
        XCTAssertNil(refusal(state("AXStaticText")))
        XCTAssertEqual(refusal(state("AXStaticText"), remote: true), .unreachable)
        XCTAssertEqual(refusal(state("AXStaticText"), allowed: false), .unsupported)
        XCTAssertEqual(refusal(state("AXGroup")), .unsupported)
        XCTAssertEqual(refusal(state("AXSheet")), .unsupported)
        XCTAssertEqual(refusal(state("AXStaticText", frame: nil)), .unsupported)
        XCTAssertEqual(refusal(state("AXStaticText", frame: CGRect(x: 5_000, y: 0, width: 10, height: 10))),
                       .unsupported)
        var unknown = state("AXButton")
        unknown.role = nil
        XCTAssertEqual(refusal(unknown), .unsupported)
        // A partly visible element is clicked at the centre of its visible part.
        XCTAssertEqual(try HostAXActionPlanner.vncClick(state: state("AXButton",
            frame: CGRect(x: 1_500, y: 0, width: 100, height: 10)), geometry: retina, remoteViewService: false,
            allowed: true), .vncClick(x: 3_012, y: 10))
    }

    func testElementsOwnedByConsentDialogsAreRefused() {
        // The snapshot application or the element's live owner may be the dialog process.
        for owners: [String?] in [["UserNotificationCenter"], ["Safari", "SecurityAgent"],
                                  [nil, "universalAccessAuthWarn"], ["CoreServicesUIAgent", nil]] {
            XCTAssertThrowsError(try HostAXActionPlanner.refuseConsentDialog(ownerExecutables: owners),
                                 "\(owners)") { XCTAssertEqual($0 as? HostAXActionError, .consentDialog) }
        }
        XCTAssertNoThrow(try HostAXActionPlanner.refuseConsentDialog(ownerExecutables: ["Safari", nil]))
        XCTAssertNoThrow(try HostAXActionPlanner.refuseConsentDialog(ownerExecutables: ["ControlCenter"]))
        // The broker keeps this wire reason as the sentinel's typed code.
        XCTAssertEqual(HostAXActionError.consentDialog.rawValue, "human_consent_required")
    }

    func testAXErrorsSeparateDefiniteRefusalFromPossibleAction() {
        XCTAssertEqual(HostAXPerformResult(.success), .performed)
        for status: AXError in [.actionUnsupported, .attributeUnsupported, .notImplemented, .illegalArgument, .noValue] {
            XCTAssertEqual(HostAXPerformResult(status), .unsupported, "\(status.rawValue)")
        }
        // A timed-out or failed call may still have acted: never a fallback click.
        for status: AXError in [.cannotComplete, .failure] {
            XCTAssertEqual(HostAXPerformResult(status), .indeterminate, "\(status.rawValue)")
        }
        XCTAssertEqual(HostAXPerformResult(.invalidUIElement), .invalid)
        XCTAssertEqual(HostAXPerformResult(.apiDisabled), .permissionRequired)
    }

    // MARK: Verification

    func testVerificationNeedsFocusOrAnObservedStateChange() {
        var before = state("AXCheckBox")
        before.value = "0"; before.focused = false; before.childCount = 0
        var toggled = before; toggled.value = "1"
        var opened = before; opened.childCount = 1
        var moved = before; moved.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
        var focused = before; focused.focused = true
        XCTAssertTrue(HostAXVerifier.satisfied(.press, operation: .press, before: before, after: .live(toggled)))
        XCTAssertTrue(HostAXVerifier.satisfied(.press, operation: .showMenu, before: before, after: .live(opened)))
        XCTAssertTrue(HostAXVerifier.satisfied(.press, operation: .press, before: before, after: .invalid))
        XCTAssertFalse(HostAXVerifier.satisfied(.press, operation: .press, before: before, after: .live(before)))
        XCTAssertFalse(HostAXVerifier.satisfied(.press, operation: .press, before: before, after: .live(moved)))
        XCTAssertFalse(HostAXVerifier.satisfied(.press, operation: .press, before: before, after: .unresponsive))
        XCTAssertTrue(HostAXVerifier.satisfied(.focus, operation: .focus, before: before, after: .live(focused)))
        XCTAssertFalse(HostAXVerifier.satisfied(.focus, operation: .focus, before: before, after: .live(toggled)))
        XCTAssertFalse(HostAXVerifier.satisfied(.focus, operation: nil, before: before, after: .invalid))
        var raised = before; raised.main = true
        XCTAssertTrue(HostAXVerifier.satisfied(.focus, operation: .raise, before: before, after: .live(raised)))
        XCTAssertFalse(HostAXVerifier.satisfied(.focus, operation: .focus, before: before, after: .live(raised)))
    }

    func testPollingStopsAtTheFirstChangeOrAtExpiryAfterOneRead() {
        var before = state("AXButton")
        before.value = "idle"
        var after = before; after.value = "busy"
        let node = ScriptedAXNode("AXButton", reads: [.live(before), .live(before), .live(after), .live(before)])
        var pauses = 0
        XCTAssertTrue(HostAXVerifier.poll(.press, operation: .press, before: before, read: { node.liveState() },
                                          expired: { false }, pause: { pauses += 1 }))
        XCTAssertEqual(node.liveReads, 3)
        XCTAssertEqual(pauses, 2)

        let unchanged = ScriptedAXNode("AXButton", reads: [.live(before)])
        XCTAssertFalse(HostAXVerifier.poll(.press, operation: .press, before: before, read: { unchanged.liveState() },
                                           expired: { true }, pause: { XCTFail("paused after expiry") }))
        XCTAssertEqual(unchanged.liveReads, 1)
    }

    func testOutcomeNamesThePathAndNeverCarriesTheElementValue() {
        var live = state("AXTextField")
        live.value = "fixture-private-text"
        live.subrole = "AXSearchField"
        let ax = HostAXActionOutcome(request: request("ax:3:0.1", .focus), surface: .popover, state: live,
            path: HostAXOperation.focus.path, axResult: .indeterminate, verified: true, point: nil).metadata
        XCTAssertEqual(ax["path"], .string("ax_focus"))
        XCTAssertEqual(ax["ax_result"], .string("indeterminate"))
        XCTAssertEqual(ax["verified"], .boolean(true))
        XCTAssertEqual(ax["surface"], .string("popover"))
        XCTAssertEqual(ax["subrole"], .string("AXSearchField"))
        XCTAssertNil(ax["fallback_point"])
        let fallback = HostAXActionOutcome(request: request("ax:3:0.1"), surface: .window, state: live,
            path: "vnc_click_required", axResult: nil, verified: nil, point: (50, 80)).metadata
        XCTAssertEqual(fallback["fallback_point"], .object(["x": .integer(50), "y": .integer(80)]))
        XCTAssertNil(fallback["verified"])
        XCTAssertFalse(String(describing: [ax, fallback]).contains("fixture-private-text"))
    }
}
