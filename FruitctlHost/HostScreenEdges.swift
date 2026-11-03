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
    /// The Dock's edge. It is forbidden whether or not the Dock hides.
    var dockEdge: Edge?

    /// `wvous-<corner>-corner` values 0 and 1 mean no action; any other value,
    /// or one that cannot be read, is active. An absent bottom-right key is
    /// macOS's default Quick Note corner. The Dock's edge is forbidden even
    /// when the Dock stays shown: a full-screen window still reveals it there.
    static func from(cornerActions: [Corner: Int?], dockOrientation: String?) -> HostScreenEdges {
        var corners: Set<Corner> = []
        for corner in Corner.allCases {
            switch cornerActions[corner] {
            case .some(.some(let action)): if action > 1 { corners.insert(corner) }
            case .some(.none): corners.insert(corner)
            case .none: if corner == .bottomRight { corners.insert(corner) }
            }
        }
        return HostScreenEdges(corners: corners, dockEdge: Edge(rawValue: dockOrientation ?? "bottom") ?? .bottom)
    }

    /// Reads the current user's `com.apple.dock` preferences.
    static func read() -> HostScreenEdges {
        let domain = "com.apple.dock" as CFString
        _ = CFPreferencesAppSynchronize(domain)
        var actions: [Corner: Int?] = [:]
        for corner in Corner.allCases {
            guard let value = CFPreferencesCopyAppValue("wvous-\(corner.rawValue)-corner" as CFString, domain) else {
                continue
            }
            actions[corner] = .some((value as? NSNumber)?.intValue)
        }
        return from(cornerActions: actions,
                    dockOrientation: CFPreferencesCopyAppValue("orientation" as CFString, domain) as? String)
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
