import CoreGraphics
import Foundation
import XCTest

private struct DocumentWindowNode: HostAXNode {
    func attributes() -> HostAXAttributes { .init(role: "AXWindow") }
    func children(limit: Int) -> [HostAXNode] { [] }
    func liveState() -> HostAXLiveRead { .invalid }
    func perform(_ operation: HostAXOperation) -> HostAXPerformResult { .unsupported }
}

final class HostLogicDocumentTests: XCTestCase {
    private let request = HostLogicDocumentRequest(processID: 77, birthMicroseconds: 1_700_000_000_123_456,
        generation: 3, ref: "ax:77:0.1")
    private let geometry = HostDisplayGeometry.compute(modePixelWidth: 1920, modePixelHeight: 1080,
        bounds: CGRect(x: 0, y: 0, width: 1920, height: 1080))!

    private func binding(pid: pid_t = 77, birth: Int64? = 1_700_000_000_123_456,
                         executable: String? = HostLogicProcessBinding.executablePath) -> HostLogicProcessBinding {
        .init(processID: pid, birthMicroseconds: birth, bundleID: HostLogicProcessBinding.bundleIdentifier,
            executable: executable, bundle: HostLogicProcessBinding.bundlePath)
    }

    private func result(before: [HostLogicProcessBinding]? = nil, after: [HostLogicProcessBinding]? = nil,
                        read: HostLogicDocumentRead = .document("file:///Volumes/Media/Band%20Practice.logicx")) -> [String: HostValue] {
        HostLogicDocumentObservation.finish(request, before: before ?? [binding()], after: after ?? [binding()], read: read)
    }

    func testRequestRequiresTypedExpectedProcessBirthGenerationAndRef() throws {
        let params: [String: HostValue] = ["expected_pid": .integer(77), "expected_birth_us": .integer(request.birthMicroseconds),
            "generation": .integer(3), "ref": .string(request.ref)]
        XCTAssertEqual(try HostLogicDocumentRequest.parse(params), request)
        for (key, value) in [("expected_pid", HostValue.integer(0)), ("expected_pid", .integer(Int64(Int32.max) + 1)),
                             ("expected_birth_us", .integer(0)), ("expected_birth_us", .integer(9_007_199_254_740_992)),
                             ("generation", .integer(0)), ("ref", .string("window-title")), ("expected_pid", .string("77"))] {
            var changed = params; changed[key] = value
            XCTAssertThrowsError(try HostLogicDocumentRequest.parse(changed))
        }
    }

    func testRetainedReferenceRequiresCurrentGenerationWindowAndActualSnapshotOwner() {
        let target = HostAXRetainedElement(node: DocumentWindowNode(), parent: "ax:77:0", processID: 77,
            bundleID: HostLogicProcessBinding.bundleIdentifier, role: "AXWindow", subrole: nil)
        func snapshot(_ target: HostAXRetainedElement, number: UInt64 = 3) -> HostAXGeneration {
            .init(number: number, sessionID: "session", displayGeneration: 4, geometry: geometry,
                  elements: [request.ref: target])
        }
        XCTAssertNotNil(request.target(in: snapshot(target), session: "session", displayGeneration: 4, geometry: geometry))
        XCTAssertNil(request.target(in: snapshot(target, number: 2), session: "session", displayGeneration: 4, geometry: geometry))
        XCTAssertNil(request.target(in: snapshot(target), session: "other", displayGeneration: 4, geometry: geometry))
        XCTAssertNil(request.target(in: snapshot(target), session: "session", displayGeneration: 5, geometry: geometry))
        let foreign = HostAXRetainedElement(node: target.node, parent: target.parent, processID: 88,
            bundleID: target.bundleID, role: target.role, subrole: nil)
        XCTAssertNil(request.target(in: snapshot(foreign), session: "session", displayGeneration: 4, geometry: geometry))
        let nonwindow = HostAXRetainedElement(node: target.node, parent: target.parent, processID: 77,
            bundleID: target.bundleID, role: "AXTextField", subrole: nil)
        XCTAssertNil(request.target(in: snapshot(nonwindow), session: "session", displayGeneration: 4, geometry: geometry))
    }

    func testObservedWindowDocumentNeverGrantsReopenAuthority() {
        XCTAssertEqual(result(), HostLogicDocumentObservation.response(request, reason: .matched,
            document: "file:///Volumes/Media/Band%20Practice.logicx"))
        guard case let .object(value)? = result()["logic_document"] else { return XCTFail("missing observation") }
        XCTAssertEqual(value["qualified"], .boolean(true)); XCTAssertEqual(value["reopen_authorized"], .boolean(false))
    }

    func testMatchedWithoutValidDocumentCannotBecomeQualified() {
        let documents: [String?] = [nil, "", "not-a-file-url"]
        for document in documents {
            XCTAssertEqual(HostLogicDocumentObservation.response(request, reason: .matched, document: document),
                HostLogicDocumentObservation.response(request, reason: .invalidDocumentURL))
        }
        XCTAssertEqual(result(read: .unqualified(.matched)), HostLogicDocumentObservation.response(request, reason: .invalidDocumentURL))
    }

    func testMissingBirthDifferentExecutableAndProcessReplacementRemainUnqualified() {
        for before in [[], [binding(birth: nil)], [binding(executable: "/tmp/Logic Pro")], [binding(), binding(pid: 88)]] {
            guard case let .object(value)? = result(before: before)["logic_document"] else { return XCTFail() }
            XCTAssertEqual(value["qualified"], .boolean(false)); XCTAssertNil(value["document_url"])
        }
        XCTAssertEqual(result(after: [binding(birth: 1_700_000_000_123_457)]),
            HostLogicDocumentObservation.response(request, reason: .identityChanged))
        XCTAssertEqual(result(after: []), HostLogicDocumentObservation.response(request, reason: .identityChanged))
    }

    func testWindowAndOwnerIdentityAreReadBeforeAndAfterDocument() {
        var calls: [String] = []
        let read = HostLogicDocumentObservation.readWindow(expired: { false }, identity: {
            calls.append("identity"); return nil
        }, currentWindow: {
            calls.append("current"); return nil
        }, document: {
            calls.append("document"); return .document("file:///one.logicx")
        })
        XCTAssertEqual(read, .document("file:///one.logicx"))
        XCTAssertEqual(calls, ["identity", "current", "document", "current", "identity", "document", "current", "identity"])
    }

    func testCurrentWindowChangeAndOwnerChangeDuringReadDiscardDocument() {
        var windows = 0
        let changedWindow = HostLogicDocumentObservation.readWindow(expired: { false }, identity: { nil }, currentWindow: {
            windows += 1; return windows == 1 ? nil : .ambiguous
        }, document: { .document("file:///one.logicx") })
        XCTAssertEqual(changedWindow, .unqualified(.ambiguous))
        var identities = 0
        let changedOwner = HostLogicDocumentObservation.readWindow(expired: { false }, identity: {
            identities += 1; return identities == 1 ? nil : .identityChanged
        }, currentWindow: { nil }, document: { .document("file:///one.logicx") })
        XCTAssertEqual(changedOwner, .unqualified(.identityChanged))
    }

    func testUnsupportedMissingAndExpiredReadsNeverAcquireDocumentFromTitle() {
        for reason in [HostLogicDocumentReason.unsupported, .missing, .windowUnavailable, .ambiguous] {
            XCTAssertEqual(result(read: .unqualified(reason)), HostLogicDocumentObservation.response(request, reason: reason))
        }
        var reads = 0
        XCTAssertEqual(HostLogicDocumentObservation.readWindow(expired: { true }, identity: { nil }, currentWindow: { nil },
            document: { reads += 1; return .document("file:///one.logicx") }), .unqualified(.windowUnavailable))
        XCTAssertEqual(reads, 0)
        XCTAssertEqual(DocumentWindowNode().logicDocument(expectedPID: 77, expired: { false }), .unqualified(.unsupported))
    }

    func testDocumentChangeWithinTheSameCurrentWindowIsUnqualified() {
        for successor in [HostLogicDocumentRead.document("file:///two.logicx"), .unqualified(.missing)] {
            var reads = 0
            let observed = HostLogicDocumentObservation.readWindow(expired: { false }, identity: { nil }, currentWindow: { nil }) {
                reads += 1
                return reads == 1 ? .document("file:///one.logicx") : successor
            }
            XCTAssertEqual(observed, .unqualified(.ambiguous))
            XCTAssertEqual(reads, 2)
        }
    }

    func testDocumentURLIsCompleteLocalFileURLWithoutControlsOrNormalizationFallback() {
        XCTAssertTrue(HostLogicDocumentObservation.validDocumentURL("file:///Volumes/Media/Band%20Practice.logicx"))
        for invalid in ["", "Band Practice", "/tmp/one.logicx", "https://example.invalid/one.logicx", "file://host/one.logicx",
                        "file://localhost/one.logicx", "file:/one.logicx", "file:///", "file:///one.logicx?x=1", "file:///one.logicx#x",
                        "file://user:password@host/one.logicx", "file:///one\\two.logicx", "file:///one%00.logicx",
                        "file:///one%0A.logicx", "file:///one%GG.logicx", "file:///one%FF.logicx", "file:///one\n.logicx",
                        "file:///" + String(repeating: "a", count: 4096)] {
            XCTAssertFalse(HostLogicDocumentObservation.validDocumentURL(invalid), invalid)
            XCTAssertEqual(result(read: .document(invalid)), HostLogicDocumentObservation.response(request, reason: .invalidDocumentURL))
        }
    }
}
