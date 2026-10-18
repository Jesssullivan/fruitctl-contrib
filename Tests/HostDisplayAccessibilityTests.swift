import Foundation
import XCTest
import CoreGraphics

private final class FakeAXNode: HostAXNode {
    let values: HostAXAttributes
    let nested: [FakeAXNode]
    private(set) var childReads = 0
    private(set) var attributeReads = 0

    init(_ role: String, label: String? = nil, value: String? = nil, subrole: String? = nil,
         frame: CGRect? = nil, children: [FakeAXNode] = []) {
        values = HostAXAttributes(role: role, subrole: subrole, label: label, value: value, frame: frame)
        nested = children
    }

    func attributes() -> HostAXAttributes { attributeReads += 1; return values }
    func children(limit: Int) -> [HostAXNode] { childReads += 1; return Array(nested.prefix(limit)) }
    func liveState() -> HostAXLiveRead { .invalid }
    func perform(_ operation: HostAXOperation) -> HostAXPerformResult { .unsupported }
}

private struct FakeAccessibilityProvider: HostAccessibilityProvider {
    var trusted: Bool
    var focused: [HostAXApplication]
    var all: [HostAXApplication]
    func isTrusted() -> Bool { trusted }
    func applications(focusedOnly: Bool, menuExtras: Bool, excluding processID: pid_t) -> [HostAXApplication] {
        (focusedOnly ? focused : all).filter { $0.processID != processID }
    }
    func isSystemRemoteViewService(processID: pid_t) -> Bool { false }
    func executableName(processID: pid_t) -> String? { nil }
}

final class HostDisplayAccessibilityTests: XCTestCase {
    private let retina = HostDisplayGeometry.compute(modePixelWidth: 3024, modePixelHeight: 1964,
        bounds: CGRect(x: 0, y: 0, width: 1512, height: 982))!

    private func object(_ value: HostValue?) -> [String: HostValue]? {
        if case .object(let item) = value { return item }
        return nil
    }

    private func array(_ value: HostValue?) -> [HostValue] {
        if case .array(let items) = value { return items }
        return []
    }

    private func snapshot(_ applications: [HostAXApplication], depth: Int = 6, maximumNodes: Int = 1_500,
                          expired: @escaping () -> Bool = { false }) throws -> [String: HostValue] {
        let result = try HostAccessibilitySnapshot.build(applications: applications,
            request: HostAXRequest(depth: depth, focusedApplicationOnly: true), geometry: retina,
            maximumNodes: maximumNodes, expired: expired)
        return try XCTUnwrap(object(result["ax_snapshot"]))
    }

    // MARK: Display geometry

    func testHiDPIModeReportsPixelSizeAndScaleSeparatelyFromPoints() {
        XCTAssertEqual(retina.pixelWidth, 3024)
        XCTAssertEqual(retina.pixelHeight, 1964)
        XCTAssertEqual(retina.pointWidth, 1512)
        XCTAssertEqual(retina.pointHeight, 982)
        XCTAssertEqual(retina.scale, 2)
        XCTAssertEqual(retina.metadata["scale"], .number(2))
        XCTAssertEqual(retina.metadata["pixel_width"], .integer(3024))
        XCTAssertEqual(retina.metadata["point_width"], .number(1512))
        let standard = HostDisplayGeometry.compute(modePixelWidth: 1920, modePixelHeight: 1080,
            bounds: CGRect(x: -1920, y: 0, width: 1920, height: 1080))
        XCTAssertEqual(standard?.scale, 1)
    }

    func testInvalidOrAnisotropicOrOversizedGeometryIsUnavailable() {
        let bounds = CGRect(x: 0, y: 0, width: 1512, height: 982)
        XCTAssertNil(HostDisplayGeometry.compute(modePixelWidth: 0, modePixelHeight: 1964, bounds: bounds))
        XCTAssertNil(HostDisplayGeometry.compute(modePixelWidth: 3024, modePixelHeight: 982, bounds: bounds))
        XCTAssertNil(HostDisplayGeometry.compute(modePixelWidth: 32_768, modePixelHeight: 16_384,
                                                 bounds: CGRect(x: 0, y: 0, width: 16_384, height: 8_192)))
        XCTAssertNil(HostDisplayGeometry.compute(modePixelWidth: 3024, modePixelHeight: 1964, bounds: .null))
        XCTAssertNil(HostDisplayGeometry.compute(modePixelWidth: 3024, modePixelHeight: 1964,
                                                 bounds: CGRect(x: 0, y: 0, width: 0, height: 982)))
    }

    func testGlobalPointFramesMapToClippedFramebufferPixels() {
        let secondary = HostDisplayGeometry.compute(modePixelWidth: 3840, modePixelHeight: 2160,
            bounds: CGRect(x: -1920, y: 0, width: 1920, height: 1080))!
        let inside = secondary.pixelRect(forGlobalPoints: CGRect(x: -1900, y: 10, width: 100.5, height: 20))
        XCTAssertEqual(inside?.x, 40); XCTAssertEqual(inside?.y, 20)
        XCTAssertEqual(inside?.width, 201); XCTAssertEqual(inside?.height, 40)
        let clipped = secondary.pixelRect(forGlobalPoints: CGRect(x: -10, y: 1070, width: 100, height: 100))
        XCTAssertEqual(clipped?.x, 3820); XCTAssertEqual(clipped?.y, 2140)
        XCTAssertEqual(clipped?.width, 20); XCTAssertEqual(clipped?.height, 20)
        XCTAssertNil(secondary.pixelRect(forGlobalPoints: CGRect(x: 0, y: 0, width: 100, height: 100)))
        XCTAssertNil(secondary.pixelRect(forGlobalPoints: .infinite))
    }

    func testDisplayUUIDResolvesOnlyOneOnlineMatchAndNeverGuesses() {
        let uuids: [CGDirectDisplayID: String] = [1: "37D8832A-2D66-02CA-B9F7-8F30A301B230",
                                                  5: "9a1b2c3d-0000-4000-8000-00000000abcd"]
        let lookup: (CGDirectDisplayID) -> String? = { uuids[$0] }
        XCTAssertEqual(HostDisplayIdentity.resolve("9A1B2C3D-0000-4000-8000-00000000ABCD",
                                                   online: [1, 5], uuidOf: lookup), 5)
        XCTAssertEqual(HostDisplayIdentity.resolve("37d8832a-2d66-02ca-b9f7-8f30a301b230",
                                                   online: [1, 5], uuidOf: lookup), 1)
        XCTAssertNil(HostDisplayIdentity.resolve("37D8832A-2D66-02CA-B9F7-8F30A301B230",
                                                 online: [5], uuidOf: lookup))
        XCTAssertNil(HostDisplayIdentity.resolve("not-a-uuid", online: [1, 5], uuidOf: lookup))
        XCTAssertNil(HostDisplayIdentity.resolve("37D8832A-2D66-02CA-B9F7-8F30A301B230", online: [1, 2],
                                                 uuidOf: { _ in "37D8832A-2D66-02CA-B9F7-8F30A301B230" }))
        XCTAssertEqual(HostDisplayIdentity.canonical("9a1b2c3d-0000-4000-8000-00000000abcd"),
                       "9A1B2C3D-0000-4000-8000-00000000ABCD")
    }

    // MARK: Accessibility snapshot

    func testRequestParsingBoundsDepthAndFocusedApplication() throws {
        XCTAssertEqual(try HostAXRequest.parse([:]), HostAXRequest(depth: 6, focusedApplicationOnly: true))
        XCTAssertEqual(try HostAXRequest.parse(["depth": .integer(2), "focused_app": .boolean(false)]),
                       HostAXRequest(depth: 2, focusedApplicationOnly: false))
        XCTAssertEqual(try HostAXRequest.parse(["menu_extras": .boolean(true)]).menuExtras, true)
        for invalid: [String: HostValue] in [["depth": .integer(0)], ["depth": .integer(13)],
                                              ["depth": .string("3")], ["focused_app": .string("true")],
                                              ["menu_extras": .integer(1)]] {
            XCTAssertThrowsError(try HostAXRequest.parse(invalid))
        }
    }

    func testSnapshotMapsFramesToPixelsWithStableRefsAndRedactsSecureText() throws {
        let password = FakeAXNode("AXTextField", label: "Password", value: "fixture-redacted-text", subrole: "AXSecureTextField",
                                  frame: CGRect(x: 100, y: 200, width: 50, height: 10))
        let button = FakeAXNode("AXButton", label: "OK", frame: CGRect(x: 10, y: 20, width: 30, height: 40))
        let window = FakeAXNode("AXWindow", label: "Login", frame: CGRect(x: 0, y: 0, width: 400, height: 300),
                                children: [button, password])
        let app = FakeAXNode("AXApplication", label: "Example", children: [window])
        let result = try snapshot([HostAXApplication(processID: 77, bundleID: "com.example.app",
                                                     name: "Example", root: app)])
        XCTAssertEqual(result["schema"], .string("fruitctl.ax-snapshot.v1"))
        XCTAssertEqual(result["coordinate_space"], .string("framebuffer_pixels"))
        XCTAssertEqual(object(result["framebuffer"])?["scale"], .number(2))
        XCTAssertEqual(result["truncated"], .boolean(false))
        let nodes = array(result["nodes"]).compactMap(object)
        XCTAssertEqual(nodes.map { $0["ref"] }, [.string("ax:77:0"), .string("ax:77:0.0"),
                                                 .string("ax:77:0.0.0"), .string("ax:77:0.0.1")])
        XCTAssertEqual(nodes[2]["parent"], .string("ax:77:0.0"))
        XCTAssertEqual(nodes[2]["label"], .string("OK"))
        XCTAssertEqual(object(nodes[2]["frame"]), ["x": .integer(20), "y": .integer(40),
                                                   "width": .integer(60), "height": .integer(80)])
        XCTAssertEqual(nodes[0]["frame"], .null)
        XCTAssertNil(nodes[3]["value"])
        XCTAssertEqual(nodes[3]["value_redacted"], .boolean(true))
        XCTAssertFalse(String(describing: result).contains("fixture-redacted-text"))
        // A second snapshot of the same tree yields the same refs: nothing is
        // cached, and refs depend only on structure.
        let again = array(try snapshot([HostAXApplication(processID: 77, bundleID: nil, name: nil, root: app)])["nodes"])
            .compactMap(object).map { $0["ref"] }
        XCTAssertEqual(again, nodes.map { $0["ref"] })
        XCTAssertEqual(app.attributeReads, 2)
    }

    func testDepthNodeAndTimeBudgetsTruncateWithoutReadingFurther() throws {
        let leaf = FakeAXNode("AXStaticText", value: "deep")
        let middle = FakeAXNode("AXGroup", children: [leaf])
        let app = FakeAXNode("AXApplication", children: [middle, FakeAXNode("AXGroup")])
        let shallow = try snapshot([HostAXApplication(processID: 1, bundleID: nil, name: nil, root: app)], depth: 1)
        XCTAssertEqual(array(shallow["nodes"]).count, 3)
        XCTAssertEqual(middle.childReads, 0)
        XCTAssertEqual(leaf.attributeReads, 0)

        let capped = try snapshot([HostAXApplication(processID: 1, bundleID: nil, name: nil, root: app)],
                                  maximumNodes: 2)
        XCTAssertEqual(array(capped["nodes"]).count, 2)
        XCTAssertEqual(capped["truncated"], .boolean(true))

        var reads = 0
        let timed = try snapshot([HostAXApplication(processID: 1, bundleID: nil, name: nil, root: app)]) {
            reads += 1; return reads > 1
        }
        XCTAssertEqual(array(timed["nodes"]).count, 1)
        XCTAssertEqual(timed["truncated"], .boolean(true))
    }

    func testBreadthFirstOrderReportsEveryApplicationRootBeforeDescendants() throws {
        let first = FakeAXNode("AXApplication", children: [FakeAXNode("AXWindow")])
        let second = FakeAXNode("AXApplication", children: [FakeAXNode("AXWindow")])
        let result = try snapshot([HostAXApplication(processID: 10, bundleID: nil, name: nil, root: first),
                                   HostAXApplication(processID: 20, bundleID: nil, name: nil, root: second)])
        XCTAssertEqual(array(result["nodes"]).compactMap(object).map { $0["ref"] },
                       [.string("ax:10:0"), .string("ax:20:0"), .string("ax:10:0.0"), .string("ax:20:0.0")])
        XCTAssertEqual(array(result["applications"]).count, 2)
    }

    func testLongTextIsBoundedAndProviderSelectionExcludesOwnProcess() throws {
        let long = String(repeating: "x", count: 1_000)
        let app = FakeAXNode("AXApplication", label: long, value: long)
        let node = try XCTUnwrap(array(try snapshot([HostAXApplication(processID: 3, bundleID: nil, name: nil,
                                                                       root: app)])["nodes"]).first.flatMap(object))
        XCTAssertEqual(node["label"], .string(String(repeating: "x", count: 256)))
        XCTAssertEqual(node["value"], .string(String(repeating: "x", count: 256)))
        let wide = HostAccessibilitySnapshot.bounded(String(repeating: "\u{1F600}", count: 200))
        XCTAssertEqual(wide.utf16.count, 256)
        XCTAssertEqual(wide, String(repeating: "\u{1F600}", count: 128))
        XCTAssertEqual(HostAccessibilitySnapshot.bounded("x" + String(repeating: "\u{1F600}", count: 200)).utf16.count, 255)

        let own = HostAXApplication(processID: 9, bundleID: nil, name: nil, root: FakeAXNode("AXApplication"))
        let other = HostAXApplication(processID: 4, bundleID: nil, name: nil, root: FakeAXNode("AXApplication"))
        let provider = FakeAccessibilityProvider(trusted: false, focused: [own], all: [own, other])
        XCTAssertFalse(provider.isTrusted())
        XCTAssertTrue(provider.applications(focusedOnly: true, menuExtras: false, excluding: 9).isEmpty)
        XCTAssertEqual(provider.applications(focusedOnly: false, menuExtras: false, excluding: 9).map(\.processID), [4])
    }

    func testCancelledTraversalReturnsNoSnapshot() async throws {
        let app = FakeAXNode("AXApplication", children: [FakeAXNode("AXWindow")])
        let geometry = retina
        let task = Task.detached { () throws -> [String: HostValue] in
            withUnsafeCurrentTask { $0?.cancel() }
            return try HostAccessibilitySnapshot.build(
                applications: [HostAXApplication(processID: 1, bundleID: nil, name: nil, root: app)],
                request: HostAXRequest(depth: 2, focusedApplicationOnly: true), geometry: geometry) { false }
        }
        do { _ = try await task.value; XCTFail("cancelled traversal returned a snapshot") }
        catch is CancellationError {}
    }
}
