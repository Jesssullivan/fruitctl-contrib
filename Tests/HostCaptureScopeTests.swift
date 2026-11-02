import XCTest

/// #163: which applications a capture keeps. Pure; no ScreenCaptureKit.
final class HostCaptureScopeTests: XCTestCase {
    private let running: [(processID: pid_t, bundleID: String?)] = [(10, "com.xoxd.fruitctl.host"),
        (529, "com.apple.logic10"), (40, "com.apple.MobileSMS"), (41, "com.apple.mail"), (524, "com.cmuxterm.app"),
        (54346, "com.apple.appkit.xpc.openAndSavePanelService"), (77, nil)]

    func testParseAcceptsOneScope() throws {
        XCTAssertEqual(try HostCaptureScope.parse([:]), .display)
        XCTAssertEqual(try HostCaptureScope.parse(["include_bundle_ids": .array([.string("com.apple.logic10")])]).include,
                       ["com.apple.logic10"])
        for invalid: [String: HostValue] in [["include_bundle_ids": .array([])],
            ["include_bundle_ids": .array([.string("../x")])], ["exclude_bundle_ids": .string("com.apple.mail")],
            ["include_bundle_ids": .array([.string("a.b")]), "exclude_bundle_ids": .array([.string("c.d")])],
            ["include_bundle_ids": .array([.string("a.b"), .string("a.b")])]] {
            XCTAssertThrowsError(try HostCaptureScope.parse(invalid), "\(invalid)")
        }
    }

    func testTargetScopeKeepsOnlyTheTargetAndItsPanelService() throws {
        let scope = try HostCaptureScope.parse(["include_bundle_ids": .array([.string("com.apple.logic10")])])
        XCTAssertEqual(try scope.plan(running: running, ownProcessID: 10), .including(processIDs: [529, 54346]))
        XCTAssertEqual(scope.filterName, "including_target_applications")
        let absent = try HostCaptureScope.parse(["include_bundle_ids": .array([.string("com.example.none")])])
        XCTAssertThrowsError(try absent.plan(running: running, ownProcessID: 10)) {
            XCTAssertEqual($0 as? HostCaptureError, .targetUnavailable)
        }
        // A target scope never includes this Host, even when named.
        let own = try HostCaptureScope.parse(["include_bundle_ids": .array([.string("com.xoxd.fruitctl.host")])])
        XCTAssertThrowsError(try own.plan(running: running, ownProcessID: 10))
    }

    func testDisplayScopeAlwaysExcludesThisHostAndPrivateApplications() throws {
        XCTAssertEqual(try HostCaptureScope.display.plan(running: running, ownProcessID: 10),
                       .excluding(processIDs: [10, 40, 41]))
        let extra = try HostCaptureScope.parse(["exclude_bundle_ids": .array([.string("com.cmuxterm.app")])])
        XCTAssertEqual(try extra.plan(running: running, ownProcessID: 10), .excluding(processIDs: [10, 40, 41, 524]))
    }
}
