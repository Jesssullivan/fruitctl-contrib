import AppKit
import QuartzCore

private final class HostOverlayPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class HostRenderer {
    static let message = "Machine under FuzzyBot spell, courtesy xoxd.ai)"
    private var panels: [HostOverlayPanel] = []
    private var artwork: [CALayer] = []
    private(set) var isVisible = false

    /// Panels stay ordered out until both filtered capture and a lease exist.
    /// No sharingType flags are used: exclusion belongs to our SCK filter.
    func rebuild() {
        hide()
        for panel in panels { panel.close() }
        panels.removeAll(); artwork.removeAll()
        for screen in NSScreen.screens {
            let panel = HostOverlayPanel(contentRect: screen.frame,
                styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false,
                screen: screen)
            panel.title = "Fruitctl activity indicator"
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = false
            panel.ignoresMouseEvents = true
            panel.hidesOnDeactivate = false
            panel.isReleasedWhenClosed = false
            panel.level = .statusBar
            panel.collectionBehavior = [.canJoinAllSpaces, .canJoinAllApplications,
                                        .stationary, .ignoresCycle]
            panel.setFrame(screen.frame, display: false)
            let view = NSView(frame: CGRect(origin: .zero, size: screen.frame.size))
            view.wantsLayer = true
            let root = CALayer()
            root.frame = view.bounds
            root.masksToBounds = true
            view.layer = root
            panel.contentView = view
            let content = makeArtwork(size: screen.frame.size, scale: screen.backingScaleFactor)
            root.addSublayer(content)
            artwork.append(content); panels.append(panel)
        }
    }

    /// Window numbers of the click-through indicator panels, the only own
    /// windows the input route may look through (#157 review).
    var panelWindowNumbers: Set<Int> { Set(panels.map(\.windowNumber)) }

    var hasAllDisplayPanels: Bool { !panels.isEmpty && panels.count == NSScreen.screens.count }

    var hasAnyVisiblePanels: Bool { panels.contains { $0.isVisible } }

    var hasVisibleDisplayPanels: Bool {
        isVisible && hasAllDisplayPanels && panels.allSatisfy { $0.isVisible }
    }

    func show() -> Bool {
        guard hasAllDisplayPanels else { return false }
        updateMotion()
        for panel in panels { panel.orderFrontRegardless() }
        isVisible = panels.allSatisfy { $0.isVisible }
        if !isVisible { hide() }
        return isVisible
    }

    func hide() {
        for panel in panels { panel.orderOut(nil) }
        isVisible = false
    }

    func updateMotion() {
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        for layer in artwork {
            layer.removeAnimation(forKey: "heartbeat")
            layer.opacity = reduceMotion ? 0.8 : 1
            guard !reduceMotion else { continue }
            let pulse = CAKeyframeAnimation(keyPath: "opacity")
            pulse.values = [0.48, 0.62, 1.0, 0.54, 0.86, 0.60, 0.48]
            pulse.keyTimes = [0.0, 0.10, 0.18, 0.27, 0.36, 0.48, 1.0]
            pulse.duration = 60.0 / 72.0
            pulse.repeatCount = .infinity
            pulse.calculationMode = .linear
            layer.add(pulse, forKey: "heartbeat")
        }
    }

    private func makeArtwork(size: CGSize, scale: CGFloat) -> CALayer {
        let content = CALayer()
        content.frame = CGRect(origin: .zero, size: size)
        let purple = NSColor(srgbRed: 75.0 / 255, green: 0, blue: 130.0 / 255, alpha: 1)
        let feather = min(160, max(80, min(size.width, size.height) * 0.13))
        let colors = [0.94, 0.72, 0.24, 0.035, 0.0].map {
            purple.withAlphaComponent($0).cgColor
        }
        func edge(_ frame: CGRect, from: CGPoint, to: CGPoint) {
            let gradient = CAGradientLayer()
            gradient.frame = frame
            gradient.colors = colors
            gradient.locations = [0, 0.10, 0.42, 0.76, 1]
            gradient.startPoint = from; gradient.endPoint = to
            content.addSublayer(gradient)
        }
        edge(CGRect(x: 0, y: 0, width: feather, height: size.height),
             from: CGPoint(x: 0, y: 0.5), to: CGPoint(x: 1, y: 0.5))
        edge(CGRect(x: size.width - feather, y: 0, width: feather, height: size.height),
             from: CGPoint(x: 1, y: 0.5), to: CGPoint(x: 0, y: 0.5))
        edge(CGRect(x: 0, y: 0, width: size.width, height: feather),
             from: CGPoint(x: 0.5, y: 0), to: CGPoint(x: 0.5, y: 1))
        edge(CGRect(x: 0, y: size.height - feather, width: size.width, height: feather),
             from: CGPoint(x: 0.5, y: 1), to: CGPoint(x: 0.5, y: 0))
        let label = CATextLayer()
        let fontSize = min(26, max(16, size.width / 70))
        label.frame = CGRect(x: 30, y: (size.height - fontSize * 2.5) / 2,
                             width: max(0, size.width - 60), height: fontSize * 2.5)
        label.string = Self.message
        label.font = NSFont.systemFont(ofSize: fontSize, weight: .semibold)
        label.fontSize = fontSize
        label.alignmentMode = .center
        label.isWrapped = true
        label.contentsScale = scale
        label.foregroundColor = NSColor.white.withAlphaComponent(0.96).cgColor
        label.shadowColor = purple.cgColor
        label.shadowOpacity = 1
        label.shadowRadius = 18
        label.shadowOffset = .zero
        content.addSublayer(label)
        return content
    }
}
