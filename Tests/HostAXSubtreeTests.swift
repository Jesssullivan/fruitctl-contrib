import CoreGraphics
import XCTest

/// #158: subtree roots, the per-call node cap and AXShowMenu planning.
private final class TreeNode: HostAXNode {
    let values: HostAXAttributes
    let nested: [TreeNode]
    init(_ role: String, label: String? = nil, children: [TreeNode] = []) {
        values = HostAXAttributes(role: role, label: label, frame: CGRect(x: 1, y: 1, width: 10, height: 10))
        nested = children
    }
    func attributes() -> HostAXAttributes { values }
    func children(limit: Int) -> [HostAXNode] { Array(nested.prefix(limit)) }
    func liveState() -> HostAXLiveRead { .invalid }
    func perform(_ operation: HostAXOperation) -> HostAXPerformResult { .unsupported }
}

final class HostAXSubtreeTests: XCTestCase {
    private let geometry = HostDisplayGeometry.compute(modePixelWidth: 512, modePixelHeight: 256,
        bounds: CGRect(x: 0, y: 0, width: 256, height: 128))!

    func testRootAndNodeCapParse() throws {
        XCTAssertEqual(try HostAXRequest.parse([:]).root, .applications)
        XCTAssertEqual(try HostAXRequest.parse(["root": .string("menu")]).root, .menu)
        XCTAssertEqual(try HostAXRequest.parse(["root": .string("focused_window")]).root, .focusedWindow)
        XCTAssertEqual(try HostAXRequest.parse(["root": .string("ax:529:0.0.8.1.34")]).root, .ref("ax:529:0.0.8.1.34"))
        XCTAssertEqual(try HostAXRequest.parse(["max_nodes": .integer(200)]).maximumNodes, 200)
        for invalid: [String: HostValue] in [["root": .string("window")], ["root": .string("ax:1:0;x")],
            ["root": .string("menu"), "menu_extras": .boolean(true)], ["max_nodes": .integer(0)],
            ["max_nodes": .integer(1_501)], ["root": .integer(3)]] {
            XCTAssertThrowsError(try HostAXRequest.parse(invalid), "\(invalid)")
        }
        // A deep subtree path still fits the ref bound.
        let deep = "ax:529:0" + String(repeating: ".123", count: 24)
        XCTAssertTrue(HostAXActionRequest.validRef(deep))
        XCTAssertFalse(HostAXActionRequest.validRef("ax:529:0" + String(repeating: ".123", count: 40)))
    }

    func testSubtreeRefsExtendTheRootPathAndRespectTheCap() throws {
        let menu = TreeNode("AXMenu", children: [TreeNode("AXMenuItem", label: "Compressor",
            children: [TreeNode("AXMenu", children: [TreeNode("AXMenuItem", label: "Mono"),
                                                     TreeNode("AXMenuItem", label: "Stereo")])]),
            TreeNode("AXMenuItem", label: "Dynamics")])
        let root = HostAXApplication(processID: 529, bundleID: "com.apple.logic10", name: nil, root: menu,
                                     rootRef: "ax:529:0.0.8.1.34")
        let request = try HostAXRequest.parse(["root": .string("menu"), "depth": .integer(4)])
        let build = try HostAccessibilitySnapshot.buildRetained(applications: [root], request: request,
                                                                geometry: geometry, generation: 9) { false }
        guard case .object(let snapshot)? = build.value["ax_snapshot"], case .array(let nodes)? = snapshot["nodes"] else {
            return XCTFail("no snapshot")
        }
        let refs = nodes.compactMap { node -> String? in
            if case .object(let fields) = node { return fields["ref"]?.string }; return nil
        }
        XCTAssertEqual(refs, ["ax:529:0.0.8.1.34", "ax:529:0.0.8.1.34.0", "ax:529:0.0.8.1.34.1",
                              "ax:529:0.0.8.1.34.0.0", "ax:529:0.0.8.1.34.0.0.0", "ax:529:0.0.8.1.34.0.0.1"])
        XCTAssertEqual(snapshot["root"], .string("menu"))
        guard case .object(let first) = nodes[0] else { return XCTFail("no root") }
        XCTAssertEqual(first["parent"], .null)
        XCTAssertEqual(first["depth"], .integer(0))
        XCTAssertNotNil(build.elements["ax:529:0.0.8.1.34.0.0.1"])
        let capped = try HostAccessibilitySnapshot.buildRetained(applications: [root],
            request: try HostAXRequest.parse(["root": .string("menu"), "max_nodes": .integer(3)]),
            geometry: geometry, generation: 10, maximumNodes: 3) { false }
        guard case .object(let small)? = capped.value["ax_snapshot"] else { return XCTFail("no snapshot") }
        XCTAssertEqual(small["node_count"], .integer(3))
        XCTAssertEqual(small["truncated"], .boolean(true))
        XCTAssertEqual(small["max_nodes"], .integer(3))
    }

    func testShowMenuUsesOnlyAXShowMenuAndNeverFallsBackToAClick() throws {
        var state = HostAXLiveState(role: "AXMenuItem", label: "Compressor",
                                    frame: CGRect(x: 10, y: 10, width: 40, height: 20), actions: ["AXPress"])
        XCTAssertNil(HostAXActionPlanner.operation(for: .showMenu, state: state, surface: .menu))
        XCTAssertThrowsError(try HostAXActionPlanner.plan(.showMenu, state: state, surface: .menu,
            geometry: geometry, remoteViewService: false, vncFallback: true)) {
            XCTAssertEqual($0 as? HostAXActionError, .unsupported)
        }
        state.actions = ["AXPress", "AXShowMenu"]
        XCTAssertEqual(try HostAXActionPlanner.plan(.showMenu, state: state, surface: .menu, geometry: geometry,
                                                    remoteViewService: false, vncFallback: false), .perform(.showMenu))
        let opened = HostAXLiveState(role: "AXMenuItem", label: "Compressor", expanded: true)
        XCTAssertTrue(HostAXVerifier.satisfied(.showMenu, operation: .showMenu, before: state, after: .live(opened)))
    }
}
