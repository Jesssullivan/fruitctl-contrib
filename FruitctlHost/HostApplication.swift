import AppKit
import ApplicationServices
import CoreGraphics
import Darwin

struct HostOptions {
    var captureChoice: Bool?
    var displayID: CGDirectDisplayID?
    /// Canonical display UUID; resolved against the online display list at
    /// launch and again after every display reconfiguration.
    var displayUUID: String?
    var requestPermission = false
    var mode: Mode = .application
    enum Mode { case application, stdio, doctor, help }

    static func parse(_ arguments: [String]) throws -> HostOptions {
        var options = HostOptions()
        var index = 0
        while index < arguments.count {
            switch arguments[index] {
            case "--help", "-h": options.mode = .help
            case "--stdio":
                guard options.mode == .application else { throw HostLeaseError.invalidParameters }
                options.mode = .stdio
            case "--doctor":
                guard options.mode == .application else { throw HostLeaseError.invalidParameters }
                options.mode = .doctor
            case "--enable-capture", "--disable-capture":
                guard options.captureChoice == nil else { throw HostLeaseError.invalidParameters }
                options.captureChoice = arguments[index] == "--enable-capture"
            case "--request-screen-capture": options.requestPermission = true
            case "--display-id":
                index += 1
                guard options.displayID == nil, options.displayUUID == nil,
                      index < arguments.count, let id = UInt32(arguments[index]), id > 0 else {
                    throw HostLeaseError.invalidParameters
                }
                options.displayID = id
            case "--display-uuid":
                index += 1
                guard options.displayID == nil, options.displayUUID == nil, index < arguments.count,
                      let uuid = HostDisplayIdentity.canonical(arguments[index]) else {
                    throw HostLeaseError.invalidParameters
                }
                options.displayUUID = uuid
            default: throw HostLeaseError.invalidParameters
            }
            index += 1
        }
        guard options.mode == .application || (options.captureChoice == nil && !options.requestPermission),
              !options.requestPermission || options.captureChoice == true else {
            throw HostLeaseError.invalidParameters
        }
        return options
    }
}

@MainActor
final class HostApplicationController: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let options: HostOptions
    private let clock = HostClock()
    private let renderer = HostRenderer()
    private let capture: HostCapture
    private let capturePreferences: HostCapturePreferences
    private let permission: HostCapturePermission
    private let accessibility: HostAccessibilityProvider
    private let instanceID = UUID().uuidString
    private var lease = HostLeaseState()
    private var availability = HostAvailabilityState()
    private var generation: UInt64 = 1
    private var captureReady = false
    private var overlayReady = false
    private var lastUIHeartbeat: UInt64?
    private var captureInProgress = false
    private var axSnapshotInProgress = false
    private var axActionInProgress = false
    /// The latest successful AX snapshot of the current activity; refs in
    /// click_element/focus_element resolve only against it.
    private var axGeneration: HostAXGeneration?
    private var axGenerationCounter: UInt64 = 0
    private var axPendingVerification: HostAXPendingVerification?
    /// UUID of the display capture is bound to; nil when it has none or the
    /// configured UUID is no longer online.
    private var boundDisplayUUID: String?
    private var timer: Timer?
    private var notifications: [NSObjectProtocol] = []
    private var signalSources: [DispatchSourceSignal] = []
    private var server: HostSocketServer?
    private var statusItem: NSStatusItem?
    private var stopMenuItem: NSMenuItem?
    private var allowMenuItem: NSMenuItem?
    private var enableCaptureMenuItem: NSMenuItem?
    private var disableCaptureMenuItem: NSMenuItem?
    private var idleReferenceMenuItem: NSMenuItem?
    private var idleReferenceStatusMenuItem: NSMenuItem?
    private lazy var idleReference = HostIdleReferenceCoordinator(
        permission: permission, clock: { [weak self] in self?.clock.milliseconds() ?? UInt64.max },
        conditions: { [unowned self] in self.idleReferenceConditions },
        capture: { [weak self] in
            guard let self else { throw HostIdleReferenceError.lifecycleChanged }
            // Native source axes are bounded at 16,384 by the shared capture
            // path. This internal size requests ratio1 without exposing a new
            // unbounded max_dimension to ordinary IPC observations.
            let image = try await self.capture.snapshot(maximumDimension: 16_384)
            return HostReferenceCapture(png: image.png, metadata: image.geometryMetadata)
        }, connectionLive: { [weak self] connection in
            self?.server?.connectionIsLive(connection) == true
        }, persist: { image, receipt in
            try HostReferenceStore(root: HostReferenceStore.defaultRoot).save(image, receipt: receipt)
        })

    init(options: HostOptions) {
        self.options = options
        let preferences = HostCapturePreferences(startupChoice: options.captureChoice)
        capturePreferences = preferences
        let authorization = HostCapturePermission.system()
        permission = authorization
        let displayID = options.displayID ?? CGMainDisplayID()
        capture = HostCapture(preferences: preferences, permission: authorization, displayID: displayID)
        accessibility = HostSystemAccessibilityProvider()
        boundDisplayUUID = HostDisplayIdentity.uuid(of: displayID)
        super.init()
    }

    /// A configured UUID is re-resolved after every reconfiguration. When it
    /// is no longer online the capture binds to no display and fails closed.
    private func rebindConfiguredDisplay() {
        guard let configured = options.displayUUID else {
            boundDisplayUUID = HostDisplayIdentity.uuid(of: capture.displayID); return
        }
        // Display ID 0 is CoreGraphics' null display: never active or shareable.
        let resolved = HostDisplayIdentity.resolveOnline(configured) ?? 0
        capture.rebind(displayID: resolved)
        boundDisplayUUID = resolved == 0 ? nil : configured
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)
        installHumanControl()
        renderer.rebuild()
        if options.requestPermission && !permission.isGranted {
            // This flag is an explicit, attended opt-in. Stdio/doctor never ask.
            _ = permission.requestFromHuman()
            updateHumanControl()
        }
        let endpoint = HostSocketServer(handler: { [weak self] request, connection, reply in
            Task { @MainActor in
                guard let self else {
                    reply(.failure(id: request.id, message: "helper_stopping")); return
                }
                reply(await self.handle(request, connectionID: connection))
            }
        }, disconnected: { [weak self] connection in
            Task { @MainActor in self?.disconnected(connection) }
        })
        do { try endpoint.start(); server = endpoint }
        catch {
            Self.writeError("FruitctlHost: private IPC unavailable; no activity can start.\n")
            NSApplication.shared.terminate(nil)
            return
        }
        timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            // Timer fires on the main run loop, so it cannot certify a stuck UI.
            MainActor.assumeIsolated { self?.tick() }
        }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
        observeDisplayAndSession()
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { NSApplication.shared.terminate(nil) }
            source.resume(); signalSources.append(source)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        invalidateActivity(reason: .hostStopping)
        server?.stop(); server = nil
        for observer in notifications {
            NotificationCenter.default.removeObserver(observer)
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        notifications.removeAll()
        for source in signalSources { source.cancel() }
        signalSources.removeAll()
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
        statusItem = nil
    }

    private func installHumanControl() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "Fruitctl"
        item.button?.toolTip = "Fruitctl agent control"
        item.button?.setAccessibilityLabel("Fruitctl agent control")
        let menu = NSMenu(title: "Fruitctl agent control")
        menu.autoenablesItems = false
        menu.delegate = self
        let stop = NSMenuItem(title: "Stop agent control", action: #selector(stopAgentControl(_:)),
                              keyEquivalent: "")
        stop.target = self
        let allow = NSMenuItem(title: "Allow agent control", action: #selector(allowAgentControl(_:)),
                               keyEquivalent: "")
        allow.target = self
        let quit = NSMenuItem(title: "Quit Fruitctl Host", action: #selector(quitHost(_:)),
                              keyEquivalent: "")
        quit.target = self
        let enable = NSMenuItem(title: "Enable capture", action: #selector(enableCapture(_:)),
                                keyEquivalent: "")
        enable.target = self
        let disable = NSMenuItem(title: "Disable capture", action: #selector(disableCapture(_:)),
                                 keyEquivalent: "")
        disable.target = self
        let reference = NSMenuItem(title: "Arm one idle reference export (60s)",
                                   action: #selector(armIdleReference(_:)), keyEquivalent: "")
        reference.target = self
        let referenceStatus = NSMenuItem(title: "Reference not armed", action: nil, keyEquivalent: "")
        referenceStatus.isEnabled = false
        let identity = NSMenuItem(title: "Host instance " + String(instanceID.prefix(8)), action: nil,
                                  keyEquivalent: "")
        identity.isEnabled = false
        menu.addItem(stop); menu.addItem(allow); menu.addItem(.separator())
        menu.addItem(enable); menu.addItem(disable); menu.addItem(reference); menu.addItem(referenceStatus)
        menu.addItem(.separator()); menu.addItem(identity); menu.addItem(quit)
        item.menu = menu
        statusItem = item; stopMenuItem = stop; allowMenuItem = allow
        enableCaptureMenuItem = enable; disableCaptureMenuItem = disable
        idleReferenceMenuItem = reference; idleReferenceStatusMenuItem = referenceStatus
        updateHumanControl()
    }

    private func updateHumanControl() {
        stopMenuItem?.isEnabled = availability.humanAllowed
        allowMenuItem?.isEnabled = !availability.humanAllowed
        enableCaptureMenuItem?.isEnabled = !capturePreferences.isEnabled
        disableCaptureMenuItem?.isEnabled = capturePreferences.isEnabled
        idleReferenceMenuItem?.isEnabled = capturePreferences.isEnabled && permission.isGranted
            && idleReferenceConditions.isIdle && !idleReference.isExporting
        updateIdleReferencePresentation()
    }

    private func updateIdleReferencePresentation() {
        let status = idleReference.status
        idleReferenceStatusMenuItem?.title = status.message
        statusItem?.button?.title = !availability.humanAllowed ? "Fruitctl · Stopped"
            : status.state == .armed ? "Fruitctl · Reference \(status.remainingSeconds)s" : "Fruitctl"
        let description = status.message + " · Host instance " + String(instanceID.prefix(8))
        statusItem?.button?.toolTip = description
        statusItem?.button?.setAccessibilityLabel(description)
    }

    func menuWillOpen(_ menu: NSMenu) { updateHumanControl() }

    @objc private func stopAgentControl(_ sender: Any?) {
        // Raw, nonthrowing entry observation only. Diagnostic validation and
        // attachment must follow the existing revocation and UI invalidation.
        let entryHostTime = HostCoreMediaClock.sample()
        let invokedAt = clock.milliseconds()
        availability.apply(.humanStopped)
        lease.stopFromHuman(instanceID: instanceID, processID: getpid(), displayID: capture.displayID,
                            displayGeneration: generation, now: invokedAt)
        let eventID = lease.lastHumanStopEvent?.eventID
        invalidateActivity(reason: .humanStopped)
        updateHumanControl()
        let completionHostTime = HostCoreMediaClock.sample()
        if let eventID {
            lease.attachHumanStopClockBracket(HostCoreMediaStopBracket(
                entryHostTime: entryHostTime, completionHostTime: completionHostTime), eventID: eventID)
        }
    }

    @objc private func allowAgentControl(_ sender: Any?) {
        availability.apply(.humanResumed)
        // Allowing creates no lease and bypasses none of the session/display
        // checks. A controller must start an entirely new activity.
        invalidateActivity(reason: .humanResumed)
        updateHumanControl()
    }

    @objc private func quitHost(_ sender: Any?) {
        stopAgentControl(sender)
        NSApplication.shared.terminate(nil)
    }

    @objc private func enableCapture(_ sender: Any?) {
        // Persist before asking: macOS Quit & Reopen drops custom launch args.
        capturePreferences.setEnabled(true)
        invalidateActivity(reason: .captureEnabled)
        updateHumanControl()
        if !permission.isGranted { _ = permission.requestFromHuman() }
        updateHumanControl()
    }

    @objc private func disableCapture(_ sender: Any?) {
        capturePreferences.setEnabled(false)
        invalidateActivity(reason: .captureDisabled)
        updateHumanControl()
    }

    @objc private func armIdleReference(_ sender: Any?) {
        do {
            _ = try idleReference.armFromHuman()
        } catch {
            // This diagnostic never requests permission, enables capture,
            // hides panels, or clears the human Stop latch.
            // The coordinator retains a bounded rejection reason for both
            // the visible menu status and the read-only health snapshot.
        }
        updateHumanControl()
    }

    private func observeDisplayAndSession() {
        notifications.append(NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.generation &+= 1
                self.invalidateActivity(reason: .displayChanged)
                self.rebindConfiguredDisplay()
                self.renderer.rebuild()
            }
        })
        let workspace = NSWorkspace.shared.notificationCenter
        let transitions: [(Notification.Name, HostAvailabilityState.Event)] = [
            (NSWorkspace.sessionDidResignActiveNotification, .sessionResigned),
            (NSWorkspace.sessionDidBecomeActiveNotification, .sessionActivated),
            (NSWorkspace.screensDidSleepNotification, .screensSlept),
            (NSWorkspace.screensDidWakeNotification, .screensWoke),
            (NSWorkspace.willSleepNotification, .systemSlept),
            (NSWorkspace.didWakeNotification, .systemWoke)
        ]
        for (name, event) in transitions {
            notifications.append(workspace.addObserver(forName: name, object: nil, queue: .main) {
                [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.availability.apply(event)
                    // Every transition requires a fresh activity/capture; wake
                    // never restores an expired lease or an old input permit.
                    let reason: HostIdleReferenceReason
                    switch event {
                    case .sessionResigned, .sessionActivated: reason = .sessionChanged
                    case .screensSlept, .screensWoke: reason = .screenSleepChanged
                    case .systemSlept, .systemWoke: reason = .systemSleepChanged
                    default: reason = .lifecycleChanged
                    }
                    self.invalidateActivity(reason: reason)
                }
            })
        }
        notifications.append(workspace.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.renderer.updateMotion() }
        })
    }

    private func tick() {
        let now = clock.milliseconds()
        if lease.expire(at: now) { clearActivityUI() }
        if lease.active != nil || idleReference.armedID != nil || idleReference.isExporting {
            if !activityEligible { invalidateActivity(reason: .activityUnavailable) }
            else if !capture.enabled { invalidateActivity(reason: .captureDisabled) }
            else if !permission.isGranted { invalidateActivity(reason: .permissionUnavailable) }
        }
        if lease.active != nil {
            switch HostLeaseState.uiHeartbeatDecision(activityEligible: activityEligible,
                captureInProgress: captureInProgress, captureReady: captureReady,
                overlayReady: overlayReady, visiblePanels: renderer.hasVisibleDisplayPanels) {
            case .awaitingInitialCapture:
                // expire(at:) above still enforces the original 3-second lease.
                // No UI heartbeat or ready permit exists before excluded capture.
                break
            case .recordVisibleHeartbeat: lastUIHeartbeat = now
            case .invalidate: invalidateActivity(reason: .uiUnavailable)
            }
        }
        // Update the existing local menu; this reads no permission API and
        // never renews the stored 60-second human choice.
        updateIdleReferencePresentation()
    }

    private var activityEligible: Bool {
        // The inactive-launch notification can precede didFinishLaunching, so
        // notifications alone cannot establish the initial GUI session state.
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        let onConsole = session[kCGSessionOnConsoleKey] as? Bool == true
        let ownedSession = (session[kCGSessionUserIDKey] as? NSNumber)?.uint32Value == getuid()
        let screens = NSScreen.screens
        let drawable = !screens.isEmpty && screens.allSatisfy { screen in
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
            else { return false }
            let display = CGDirectDisplayID(number.uint32Value)
            return CGDisplayIsActive(display) != 0 && CGDisplayIsAsleep(display) == 0
        } && CGDisplayIsActive(capture.displayID) != 0 && CGDisplayIsAsleep(capture.displayID) == 0
        return availability.allowsActivity(onConsole: onConsole, ownedSession: ownedSession,
                                            displaysDrawable: drawable)
    }

    private var idleReferenceConditions: HostIdleReferenceConditions {
        HostIdleReferenceConditions(captureEnabled: capture.enabled, activityEligible: activityEligible,
            activeLease: lease.active != nil, captureReady: captureReady, overlayReady: overlayReady,
            anyVisiblePanel: renderer.hasAnyVisiblePanels, otherCaptureInProgress: captureInProgress,
            lifecycleRevision: availability.revision, displayGeneration: generation)
    }

    private func requireAvailable() throws {
        guard activityEligible else {
            invalidateActivity(reason: .activityUnavailable); throw HostLeaseError.notReady
        }
    }

    private func disconnected(_ connectionID: UUID) {
        idleReference.disconnected(connectionID)
        if lease.release(connectionID: connectionID) { clearActivityUI() }
    }

    private func invalidateActivity(reason: HostIdleReferenceReason = .lifecycleChanged) {
        idleReference.invalidate(reason: reason)
        lease.invalidate(); clearActivityUI()
    }

    private func clearActivityUI() {
        renderer.hide()
        captureReady = false; overlayReady = false; lastUIHeartbeat = nil
        // Lease end, Stop, release and display change all discard element refs.
        axGeneration = nil; axPendingVerification = nil
    }

    /// Ready lease owner on an unchanged display with nothing else in flight.
    /// Runs before and again after every awaited AX step, so Stop (D15), a
    /// lost lease (D14) or a display change between them wins.
    private func requireAXOwner(session: String, connectionID: UUID, displayID: CGDirectDisplayID,
                                geometry: HostDisplayGeometry) throws -> HostActivityLease {
        let checkedAt = clock.milliseconds()
        let current = try lease.requireOwner(sessionID: session, connectionID: connectionID,
                                             displayGeneration: generation, now: checkedAt)
        try requireAvailable()
        guard accessibility.isTrusted() else { throw HostAccessibilityError.permissionRequired }
        guard capture.displayID == displayID, HostDisplayGeometry.current(displayID) == geometry else {
            throw HostLeaseError.displayChanged
        }
        guard HostLeaseState.isReady(now: checkedAt, uiHeartbeatAt: lastUIHeartbeat, captureReady: captureReady,
                                     overlayReady: overlayReady && renderer.hasVisibleDisplayPanels) else {
            throw HostLeaseError.notReady
        }
        return current
    }

    private func validateDisplay(_ request: HostRequest) throws {
        if let display = request.params["display_id"] {
            guard display.unsigned == UInt64(capture.displayID) else {
                throw HostCaptureError.displayUnavailable
            }
        }
        if let uuid = request.params["display_uuid"] {
            guard let text = uuid.string, let wanted = HostDisplayIdentity.canonical(text),
                  wanted == boundDisplayUUID else { throw HostCaptureError.displayUnavailable }
        }
        if let mode = request.params["capture_backend"] {
            guard mode.string == "owned_sck" else { throw HostLeaseError.invalidParameters }
        }
    }

    private func maximumDimension(_ request: HostRequest) throws -> Int {
        guard let value = request.params["max_dimension"] else { return 1_280 }
        guard let size = value.integer, (256...4_096).contains(size) else {
            throw HostLeaseError.invalidParameters
        }
        return size
    }

    private func readiness(now: UInt64, activity: HostActivityLease? = nil) -> [String: HostValue] {
        let age = HostLeaseState.heartbeatAge(now: now, uiHeartbeatAt: lastUIHeartbeat)
        let current = activity ?? lease.active
        var result: [String: HostValue] = [
            "instance_id": .string(instanceID), "capture_backend": .string("owned_sck"),
            "capture_enabled": .boolean(capture.enabled), "capture_ready": .boolean(captureReady),
            "overlay_ready": .boolean(overlayReady && renderer.hasVisibleDisplayPanels),
            "activity_eligible": .boolean(activityEligible),
            "human_stop_latched": .boolean(!availability.humanAllowed),
            "ready": .boolean(current != nil && activityEligible && HostLeaseState.isReady(now: now,
                uiHeartbeatAt: lastUIHeartbeat, captureReady: captureReady,
                overlayReady: overlayReady && renderer.hasVisibleDisplayPanels)),
            "raw_vnc_exclusion": .boolean(false), "display_id": .integer(Int64(capture.displayID)),
            "display_uuid": boundDisplayUUID.map { .string($0) } ?? .null,
            "display_geometry": HostDisplayGeometry.current(capture.displayID).map { .object($0.metadata) } ?? .null,
            "accessibility_trusted": .boolean(accessibility.isTrusted()),
            "displayGeneration": .integer(Int64(clamping: generation)),
            "ui_heartbeat_age_ms": age.map { .integer(Int64(clamping: $0)) } ?? .null,
            "lease_remaining_ms": .integer(Int64(clamping: current.map {
                $0.expiresAtMilliseconds > now ? $0.expiresAtMilliseconds - now : 0
            } ?? 0)),
            "renewal_interval_ms": .integer(Int64(HostLeasePolicy.renewalIntervalMilliseconds)),
            "input_permit_ms": .integer(Int64(HostLeasePolicy.inputPermitMilliseconds)),
            "maximum_round_trip_ms": .integer(Int64(HostLeasePolicy.maximumChallengeRoundTripMilliseconds))
        ]
        if let current {
            result["session_id"] = .string(current.sessionID)
            result["sequence"] = .integer(Int64(clamping: current.sequence))
            result["challenge"] = .string(current.challenge)
        }
        return result
    }

    private func handle(_ request: HostRequest, connectionID: UUID) async -> HostResponse {
        let now = clock.milliseconds()
        if lease.expire(at: now) { clearActivityUI() }
        // A health reply reports the same permission sample that guarded its
        // Arm. Capture/export still perform their own independent checks.
        let healthPermissionGranted: Bool? = request.action == "health" ? permission.isGranted : nil
        if (lease.active != nil || idleReference.armedID != nil || idleReference.isExporting)
            && !(healthPermissionGranted ?? permission.isGranted) {
            invalidateActivity(reason: .permissionUnavailable)
        }
        do {
            switch request.action {
            case "health":
                var status = readiness(now: now)
                // These process-relative diagnostics survive a disconnected
                // controller, but cannot authorize activity or clear Stop.
                status["observed_monotonic_ms"] = .integer(Int64(clamping: now))
                status["last_human_stop_event"] = lease.lastHumanStopEvent.map {
                    .object($0.metadata)
                } ?? .null
                status["screen_capture_permission"] = .boolean(healthPermissionGranted ?? false)
                let referenceStatus = idleReference.status
                status["idle_reference_armed_id"] = referenceStatus.armedID.map { .string($0) } ?? .null
                status["idle_reference_status"] = .object(referenceStatus.metadata)
                status["instance_label"] = .string(String(instanceID.prefix(8)))
                status["idle_reference_exporting"] = .boolean(idleReference.isExporting)
                status["capabilities"] = .array(["capture", "begin_activity", "renew_activity",
                                                 "release_activity", "export_idle_reference",
                                                 "ax_snapshot", "ax_action"].map { .string($0) })
                status["input_service"] = .boolean(false)
                return .ok(request, status)
            case "begin_activity":
                try validateDisplay(request)
                try requireAvailable()
                guard capture.enabled else { throw HostCaptureError.notEnabled }
                guard !captureInProgress, !idleReference.isExporting else { throw HostLeaseError.busy }
                idleReference.invalidate(reason: .activityRequested)
                let session = try request.requiredString("session_id")
                let sequence = try request.requiredSequence()
                let challenge = try request.requiredString("challenge")
                try lease.begin(sessionID: session, connectionID: connectionID, sequence: sequence,
                                challenge: challenge, displayGeneration: generation, now: now)
                captureInProgress = true
                defer { captureInProgress = false }
                do {
                    // A complete excluded-app image must succeed before UI is shown.
                    _ = try await capture.snapshot(maximumDimension: 256)
                    let acknowledgedAt = clock.milliseconds()
                    let current = try lease.requireOwner(sessionID: session, connectionID: connectionID,
                        displayGeneration: generation, now: acknowledgedAt)
                    try requireAvailable()
                    try permission.requireCapture(enabled: capture.enabled)
                    captureReady = true
                    overlayReady = renderer.show()
                    guard overlayReady else { throw HostLeaseError.notReady }
                    lastUIHeartbeat = acknowledgedAt
                    return .ok(request, readiness(now: acknowledgedAt, activity: current))
                } catch {
                    if lease.release(connectionID: connectionID, sessionID: session) { clearActivityUI() }
                    throw error
                }
            case "renew_activity":
                try validateDisplay(request)
                try requireAvailable()
                guard permission.isGranted else {
                    // Permission withdrawal must revoke readiness before a new
                    // seat permit can be granted, even between screenshots.
                    if lease.release(connectionID: connectionID,
                                     sessionID: request.params["session_id"]?.string) { clearActivityUI() }
                    throw HostCaptureError.permissionRequired
                }
                try lease.renew(sessionID: request.requiredString("session_id"), connectionID: connectionID,
                    sequence: request.requiredSequence(), challenge: request.requiredString("challenge"),
                    displayGeneration: generation, now: now, uiHeartbeatAt: lastUIHeartbeat,
                    captureReady: captureReady, overlayReady: overlayReady && renderer.hasVisibleDisplayPanels)
                return .ok(request, readiness(now: now))
            case "release_activity":
                let session = try request.requiredString("session_id")
                _ = try lease.requireOwner(sessionID: session, connectionID: connectionID,
                                            displayGeneration: generation, now: now)
                lease.release(connectionID: connectionID, sessionID: session)
                clearActivityUI()
                return .ok(request, readiness(now: now))
            case "capture", "screenshot":
                try validateDisplay(request)
                try requireAvailable()
                let size = try maximumDimension(request)
                let session = try request.requiredString("session_id")
                _ = try lease.requireOwner(sessionID: session, connectionID: connectionID,
                                            displayGeneration: generation, now: now)
                guard HostLeaseState.isReady(now: now, uiHeartbeatAt: lastUIHeartbeat,
                    captureReady: captureReady, overlayReady: overlayReady && renderer.hasVisibleDisplayPanels),
                    !captureInProgress, !axSnapshotInProgress, !axActionInProgress, !idleReference.isExporting else {
                    throw HostLeaseError.notReady
                }
                captureInProgress = true
                defer { captureInProgress = false }
                do {
                    let image = try await capture.snapshot(maximumDimension: size)
                    let completedAt = clock.milliseconds()
                    let current = try lease.requireOwner(sessionID: session, connectionID: connectionID,
                        displayGeneration: generation, now: completedAt)
                    try requireAvailable()
                    try permission.requireCapture(enabled: capture.enabled)
                    guard HostLeaseState.isReady(now: completedAt, uiHeartbeatAt: lastUIHeartbeat,
                        captureReady: captureReady, overlayReady: overlayReady && renderer.hasVisibleDisplayPanels) else {
                        throw HostLeaseError.notReady
                    }
                    return .ok(request, readiness(now: completedAt, activity: current)
                        .merging(image.metadata) { _, imageValue in imageValue })
                } catch {
                    if lease.release(connectionID: connectionID, sessionID: session) { clearActivityUI() }
                    throw error
                }
            case "ax_snapshot":
                // Observation only, under the same activity lease as capture.
                // Every call reads live Accessibility state; nothing is cached.
                try validateDisplay(request)
                try requireAvailable()
                let axRequest = try HostAXRequest.parse(request.params)
                let session = try request.requiredString("session_id")
                _ = try lease.requireOwner(sessionID: session, connectionID: connectionID,
                                            displayGeneration: generation, now: now)
                guard HostLeaseState.isReady(now: now, uiHeartbeatAt: lastUIHeartbeat,
                    captureReady: captureReady, overlayReady: overlayReady && renderer.hasVisibleDisplayPanels),
                    !captureInProgress, !axSnapshotInProgress, !axActionInProgress, !idleReference.isExporting else {
                    throw HostLeaseError.notReady
                }
                guard accessibility.isTrusted() else { throw HostAccessibilityError.permissionRequired }
                let displayID = capture.displayID
                guard let geometry = HostDisplayGeometry.current(displayID) else {
                    throw HostCaptureError.displayUnavailable
                }
                let applications = accessibility.applications(focusedOnly: axRequest.focusedApplicationOnly,
                                                              menuExtras: axRequest.menuExtras, excluding: getpid())
                guard !applications.isEmpty else { throw HostAccessibilityError.applicationUnavailable }
                axSnapshotInProgress = true
                defer { axSnapshotInProgress = false }
                do {
                    // Synchronous AX IPC runs off the main actor so Stop, the
                    // UI heartbeat and display notifications stay responsive.
                    let deadline = DispatchTime.now().uptimeNanoseconds
                        + HostAccessibilitySnapshot.budgetNanoseconds
                    let number = axGenerationCounter &+ 1
                    let built = try await Task.detached(priority: .userInitiated) {
                        try HostAccessibilitySnapshot.buildRetained(applications: applications, request: axRequest,
                            geometry: geometry, generation: number) { DispatchTime.now().uptimeNanoseconds >= deadline }
                    }.value
                    let completedAt = clock.milliseconds()
                    let current = try lease.requireOwner(sessionID: session, connectionID: connectionID,
                        displayGeneration: generation, now: completedAt)
                    try requireAvailable()
                    guard accessibility.isTrusted() else { throw HostAccessibilityError.permissionRequired }
                    guard capture.displayID == displayID, HostDisplayGeometry.current(displayID) == geometry else {
                        throw HostLeaseError.displayChanged
                    }
                    guard HostLeaseState.isReady(now: completedAt, uiHeartbeatAt: lastUIHeartbeat,
                        captureReady: captureReady, overlayReady: overlayReady && renderer.hasVisibleDisplayPanels) else {
                        throw HostLeaseError.notReady
                    }
                    axGenerationCounter = number
                    axGeneration = HostAXGeneration(number: number, sessionID: session,
                        displayGeneration: generation, geometry: geometry, elements: built.elements)
                    axPendingVerification = nil
                    return .ok(request, readiness(now: completedAt, activity: current)
                        .merging(built.value) { _, value in value })
                } catch {
                    if lease.release(connectionID: connectionID, sessionID: session) { clearActivityUI() }
                    throw error
                }
            case "ax_action":
                return .ok(request, try await axAction(request, connectionID: connectionID))
            case "ax_verify":
                return .ok(request, try await axVerify(request, connectionID: connectionID))
            case "export_idle_reference":
                try validateDisplay(request)
                guard try request.requiredString("instance_id") == instanceID else {
                    throw HostIdleReferenceError.lifecycleChanged
                }
                let referenceID = try request.requiredString("reference_id")
                let exported = try await idleReference.export(armedID: referenceID,
                    connectionID: connectionID, binding: [
                    "instance_id": .string(instanceID), "capture_backend": .string("owned_sck"),
                    "displayGeneration": .integer(Int64(clamping: generation)),
                    "human_stop_latched": .boolean(!availability.humanAllowed),
                    "capture_enabled": .boolean(capture.enabled), "raw_vnc_exclusion": .boolean(false)
                ])
                updateHumanControl()
                return .ok(request, exported.metadata)
            default:
                return .failure(id: request.id, code: -32601, message: "unsupported_host_action")
            }
        } catch let error as HostLeaseError {
            return .failure(id: request.id, message: error.rawValue)
        } catch let error as HostCaptureFailure {
            return .failure(id: request.id, message: error.reason.rawValue, data: error.diagnostic)
        } catch let error as HostCaptureError {
            return .failure(id: request.id, message: error.rawValue)
        } catch let error as HostIdleReferenceError {
            return .failure(id: request.id, message: error.rawValue)
        } catch let error as HostAccessibilityError {
            return .failure(id: request.id, message: error.rawValue)
        } catch let error as HostAXActionError {
            return .failure(id: request.id, message: error.rawValue)
        } catch {
            return .failure(id: request.id, message: "host_action_failed")
        }
    }

    /// click_element / focus_element. Reads the element off the main actor,
    /// re-checks the lease and Stop, then makes exactly one AX call on the main
    /// actor so Stop cannot interleave between the check and the call. An
    /// unsupported action returns a framebuffer point for the broker's VNC
    /// click instead; an indeterminate one is never retried or clicked.
    private func axAction(_ request: HostRequest, connectionID: UUID) async throws -> [String: HostValue] {
        try validateDisplay(request)
        try requireAvailable()
        let axRequest = try HostAXActionRequest.parse(request.params)
        let session = try request.requiredString("session_id")
        let displayID = capture.displayID
        guard let geometry = HostDisplayGeometry.current(displayID) else { throw HostCaptureError.displayUnavailable }
        _ = try requireAXOwner(session: session, connectionID: connectionID, displayID: displayID, geometry: geometry)
        guard !captureInProgress, !axSnapshotInProgress, !axActionInProgress, !idleReference.isExporting else {
            throw HostLeaseError.notReady
        }
        guard let snapshot = axGeneration else { throw HostAXActionError.staleRef }
        let target = try snapshot.resolve(axRequest, sessionID: session, displayGeneration: generation,
                                          geometry: geometry)
        let surface = snapshot.surface(of: axRequest.ref)
        axActionInProgress = true
        defer { axActionInProgress = false }
        do {
            let deadline = DispatchTime.now().uptimeNanoseconds + HostAXActionPlanner.budgetNanoseconds
            let node = target.node
            let read = await Task.detached(priority: .userInitiated) { node.liveState() }.value
            let state: HostAXLiveState
            switch read {
            case .invalid: throw HostAXActionError.staleRef
            case .unresponsive: throw HostAXActionError.unreachable
            case .live(let live): state = live
            }
            // A human answers consent dialogs (D16). Refused before any
            // AX call or click, whatever the desktop-state sentinel read.
            try HostAXActionPlanner.refuseConsentDialog(ownerExecutables:
                ([target.processID] + (state.ownerProcessID.map { [$0] } ?? [])).map {
                    accessibility.executableName(processID: $0)
                })
            let remote = state.ownerProcessID.map {
                $0 != target.processID && accessibility.isSystemRemoteViewService(processID: $0)
            } ?? false
            let plan = try HostAXActionPlanner.plan(axRequest.kind, state: state, surface: surface,
                geometry: geometry, remoteViewService: remote, vncFallback: axRequest.vncFallback)
            _ = try requireAXOwner(session: session, connectionID: connectionID, displayID: displayID,
                                   geometry: geometry)
            let outcome: HostAXActionOutcome
            func fallback(_ x: Int, _ y: Int) -> HostAXActionOutcome {
                axPendingVerification = HostAXPendingVerification(generation: axRequest.generation,
                    ref: axRequest.ref, kind: axRequest.kind, before: state)
                return HostAXActionOutcome(request: axRequest, surface: surface, state: state,
                    path: "vnc_click_required", axResult: nil, verified: nil, point: (x, y))
            }
            switch plan {
            case .vncClick(let x, let y):
                outcome = fallback(x, y)
            case .perform(let operation):
                switch node.perform(operation) {
                case .invalid: throw HostAXActionError.staleRef
                case .permissionRequired: throw HostAccessibilityError.permissionRequired
                case .unsupported:
                    // The element refused before acting: the same rules as
                    // planning decide whether a VNC click is safe.
                    guard case .vncClick(let x, let y) = try HostAXActionPlanner.vncClick(state: state,
                        geometry: geometry, remoteViewService: remote, allowed: axRequest.vncFallback) else {
                        throw HostAXActionError.unsupported
                    }
                    outcome = fallback(x, y)
                case let result:
                    let kind = axRequest.kind
                    let verified = await Task.detached(priority: .userInitiated) {
                        HostAXVerifier.poll(kind, operation: operation, before: state, read: { node.liveState() },
                            expired: { DispatchTime.now().uptimeNanoseconds >= deadline },
                            pause: { usleep(useconds_t(HostAXActionPlanner.pollNanoseconds / 1_000)) })
                    }.value
                    outcome = HostAXActionOutcome(request: axRequest, surface: surface, state: state,
                        path: operation.path, axResult: result, verified: verified, point: nil)
                }
            }
            let current = try requireAXOwner(session: session, connectionID: connectionID, displayID: displayID,
                                              geometry: geometry)
            return readiness(now: clock.milliseconds(), activity: current)
                .merging(["ax_action": .object(outcome.metadata)]) { _, value in value }
        } catch {
            if lease.release(connectionID: connectionID, sessionID: session) { clearActivityUI() }
            throw error
        }
    }

    /// Verifies the broker's VNC fallback click against the before-state that
    /// ax_action recorded. Consumes that record; it cannot be replayed.
    private func axVerify(_ request: HostRequest, connectionID: UUID) async throws -> [String: HostValue] {
        try validateDisplay(request)
        try requireAvailable()
        let axRequest = try HostAXActionRequest.parse(request.params)
        let session = try request.requiredString("session_id")
        let displayID = capture.displayID
        guard let geometry = HostDisplayGeometry.current(displayID) else { throw HostCaptureError.displayUnavailable }
        _ = try requireAXOwner(session: session, connectionID: connectionID, displayID: displayID, geometry: geometry)
        guard !captureInProgress, !axSnapshotInProgress, !axActionInProgress, !idleReference.isExporting else {
            throw HostLeaseError.notReady
        }
        guard let pending = axPendingVerification, pending.matches(axRequest) else {
            throw HostLeaseError.invalidParameters
        }
        axPendingVerification = nil
        guard let snapshot = axGeneration else { throw HostAXActionError.staleRef }
        let node = try snapshot.resolve(axRequest, sessionID: session, displayGeneration: generation,
                                        geometry: geometry).node
        axActionInProgress = true
        defer { axActionInProgress = false }
        do {
            let deadline = DispatchTime.now().uptimeNanoseconds + HostAXActionPlanner.budgetNanoseconds
            let kind = axRequest.kind
            let before = pending.before
            let verified = await Task.detached(priority: .userInitiated) {
                HostAXVerifier.poll(kind, operation: nil, before: before, read: { node.liveState() },
                    expired: { DispatchTime.now().uptimeNanoseconds >= deadline },
                    pause: { usleep(useconds_t(HostAXActionPlanner.pollNanoseconds / 1_000)) })
            }.value
            let current = try requireAXOwner(session: session, connectionID: connectionID, displayID: displayID,
                                              geometry: geometry)
            return readiness(now: clock.milliseconds(), activity: current).merging(["ax_verify": .object([
                "ref": .string(axRequest.ref), "action": .string(kind.rawValue),
                "generation": .integer(Int64(clamping: axRequest.generation)), "verified": .boolean(verified)])
            ]) { _, value in value }
        } catch {
            if lease.release(connectionID: connectionID, sessionID: session) { clearActivityUI() }
            throw error
        }
    }

    static func writeError(_ message: String) {
        try? FileHandle.standardError.write(contentsOf: Data(message.utf8))
    }
}

@main
struct FruitctlHostMain {
    @MainActor
    static func main() {
        // Broken SSH/pipe output must become a transport failure, not leave a
        // half-attached helper. This changes signals only in this process.
        signal(SIGPIPE, SIG_IGN)
        do {
            let options = try HostOptions.parse(Array(CommandLine.arguments.dropFirst()))
            switch options.mode {
            case .help:
                print("""
                FruitctlHost — optional macOS human activity indicator and owned SCK capture
                Usage: FruitctlHost [--enable-capture | --disable-capture] [--request-screen-capture]
                                    [--display-id ID | --display-uuid UUID]
                       FruitctlHost --stdio
                       FruitctlHost --doctor
                --stdio attaches to an already running same-user Aqua app; it never launches UI.
                --display-uuid survives display-ID changes; an absent UUID fails with
                configured_display_unavailable. --doctor lists online display UUIDs.
                Capture starts disabled on fresh installs; explicit operator opt-in persists.
                The local menu can enable/disable capture; IPC cannot change the opt-in.
                Permission requests require the explicit
                --enable-capture --request-screen-capture attended application flags.
                Raw VNC exclusion is unsupported. Input stays on the controlling Darwin seat;
                the Host performs only single Accessibility element actions under a lease.
                """)
            case .doctor:
                var info = stat()
                let path = HostIPC.socketPath
                let socketPresent = lstat(path, &info) == 0 && info.st_uid == getuid()
                    && info.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK) && info.st_mode & 0o077 == 0
                let report: [String: HostValue] = [
                    "socket_present": .boolean(socketPresent), "raw_vnc_exclusion": .boolean(false),
                    "screen_capture_permission": .boolean(CGPreflightScreenCaptureAccess()),
                    "accessibility_trusted": .boolean(AXIsProcessTrusted()),
                    "displays": .array(HostDisplayIdentity.onlineDisplays().map { display in
                        .object(["display_id": .integer(Int64(display)),
                                 "display_uuid": HostDisplayIdentity.uuid(of: display).map { .string($0) } ?? .null,
                                 "main": .boolean(CGDisplayIsMain(display) != 0),
                                 "geometry": HostDisplayGeometry.current(display).map { .object($0.metadata) } ?? .null])
                    }),
                    "bundle_id": .string(Bundle.main.bundleIdentifier ?? "unbundled"),
                    "gui_started": .boolean(false), "capture_started": .boolean(false)
                ]
                try FileHandle.standardOutput.write(contentsOf:
                    HostResponse(id: nil, success: true, result: report, error: nil).line())
            case .stdio:
                try HostIPC.attachStdio()
            case .application:
                var options = options
                if let uuid = options.displayUUID {
                    // Typed launch failure: never fall back to the main display.
                    guard let display = HostDisplayIdentity.resolveOnline(uuid) else {
                        HostApplicationController.writeError(
                            "FruitctlHost: configured_display_unavailable (display UUID not online).\n")
                        exit(3)
                    }
                    options.displayID = display
                }
                let app = NSApplication.shared
                let controller = HostApplicationController(options: options)
                app.delegate = controller
                withExtendedLifetime(controller) { app.run() }
            }
        } catch {
            HostApplicationController.writeError("FruitctlHost: unavailable or invalid invocation. Use --help.\n")
            exit(1)
        }
    }
}
