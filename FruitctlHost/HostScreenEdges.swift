import CoreGraphics
import Foundation

/// #178: places on the display where the system acts on a pointer before the
/// target does. A hot corner fires its action (Quick Note, Mission Control,
/// Lock Screen and others) when the pointer reaches it, and an auto-hidden
/// Dock slides out at its edge. Host input never moves the pointer there.
struct HostScreenEdges: Equatable {
    enum Corner: String, CaseIterable { case topLeft = "tl", topRight = "tr", bottomLeft = "bl", bottomRight = "br" }
    enum Edge: String { case left, bottom, right }

    /// A hot corner fires within a few points of the corner.
    static let cornerExtent: CGFloat = 12
    /// The auto-hidden Dock reveals at the edge itself.
    static let dockExtent: CGFloat = 4
    static let none = HostScreenEdges(corners: [], dockEdge: nil)

    var corners: Set<Corner>
    /// The auto-hidden Dock's edge; nil when the Dock stays shown.
    var dockEdge: Edge?

    /// `wvous-<corner>-corner` values 0 and 1 mean no action. An unreadable
    /// orientation is the default, bottom.
    static func from(cornerActions: [Corner: Int], dockAutohide: Bool, dockOrientation: String?) -> HostScreenEdges {
        HostScreenEdges(corners: Set(cornerActions.filter { $0.value > 1 }.keys),
                        dockEdge: dockAutohide ? Edge(rawValue: dockOrientation ?? "bottom") ?? .bottom : nil)
    }

    /// Reads the current user's `com.apple.dock` preferences.
    static func read() -> HostScreenEdges {
        let domain = "com.apple.dock" as CFString
        func value(_ key: String) -> Any? { CFPreferencesCopyAppValue(key as CFString, domain) }
        var actions: [Corner: Int] = [:]
        for corner in Corner.allCases {
            actions[corner] = (value("wvous-\(corner.rawValue)-corner") as? NSNumber)?.intValue ?? 0
        }
        return from(cornerActions: actions, dockAutohide: (value("autohide") as? NSNumber)?.boolValue ?? false,
                    dockOrientation: value("orientation") as? String)
    }

    /// Rectangles in global points on `display` that the pointer must avoid.
    func forbiddenRects(on display: CGRect) -> [CGRect] {
        let c = Self.cornerExtent, d = Self.dockExtent
        var rects: [CGRect] = []
        for corner in corners {
            let x = corner == .topLeft || corner == .bottomLeft ? display.minX : display.maxX - c
            let y = corner == .topLeft || corner == .topRight ? display.minY : display.maxY - c
            rects.append(CGRect(x: x, y: y, width: c, height: c))
        }
        switch dockEdge {
        case .left?: rects.append(CGRect(x: display.minX, y: display.minY, width: d, height: display.height))
        case .right?: rects.append(CGRect(x: display.maxX - d, y: display.minY, width: d, height: display.height))
        case .bottom?: rects.append(CGRect(x: display.minX, y: display.maxY - d, width: display.width, height: d))
        case nil: break
        }
        return rects
    }

    /// Refuses a plan if any pointer position in it, including every point
    /// of a drag, falls in a forbidden rectangle. Nothing has been posted.
    func check(_ steps: [HostInputStep], display: CGRect) throws {
        let rects = forbiddenRects(on: display)
        guard !rects.isEmpty else { return }
        for step in steps {
            let point: CGPoint
            switch step {
            case .move(let at): point = at
            case .button(_, _, let at, _, _): point = at
            case .drag(_, let at, _): point = at
            case .scroll(_, _, let at): point = at
            case .key, .text, .pause: continue
            }
            if rects.contains(where: { $0.contains(point) }) { throw HostInputError.screenEdge }
        }
    }
}
