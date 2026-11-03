import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Darwin

struct HostOptions {
    var captureChoice: Bool?
    /// Local agent-input opt-in (#157); off unless an attended launch or
    /// the local menu enables it.
    var inputChoice: Bool?
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
            case "--enable-input", "--disable-input":
                guard options.inputChoice == nil else { throw HostLeaseError.invalidParameters }
                options.inputChoice = arguments[index] == "--enable-input"
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
        guard options.mode == .application || (options.captureChoice == nil && options.inputChoice == nil
                                                && !options.requestPermission),
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
    private var inputInProgress = false
    /// The running input action, so Stop and Quit release what it holds.
    private var activeInputSession: HostInputSession?
    /// The local Fruitctl menu is open: the operator is reaching for Stop.
    private var humanMenuOpen = false
    private var agentIdle = HostAgentIdleClock()
    private let inputPreferences: HostInputPreferences
    private let inputPoster = HostSystemInputPoster()
    private lazy var inputMonitor = HostOperatorInputMonitor(clock: { [clock] in clock.milliseconds() })
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
    private var enableInputMenuItem: NSMenuItem?
    private var disableInputMenuItem: NSMenuItem?
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
            return HostReferenceCapture(png: image.encoded, metadata: image.geometryMetadata)
        }, connectionLive: { [weak self] connection in
            self?.server?.connectionIsLive(connection) == true
        }, persist: { image, receipt in
            try HostReferenceStore(root: HostReferenceStore.defaultRoot).save(image, receipt: receipt)
        })

    init(options: HostOptions) {
        self.options = options
        let preferences = HostCapturePreferences(startupChoice: options.captureChoice)
        capturePreferences = preferences
        inputPreferences = HostInputPreferences(startupChoice: options.inputChoice)
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
        if inputPreferences.isEnabled { inputMonitor.start() }
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
        activeInputSession?.releaseHeld()
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
        let enableInput = NSMenuItem(title: "Enable agent input", action: #selector(enableInput(_:)),
                                     keyEquivalent: "")
        enableInput.target = self
        let disableInput = NSMenuItem(title: "Disable agent input", action: #selector(disableInput(_:)),
                                      keyEquivalent: "")
        disableInput.target = self
        let reference = NSMenuItem(title: "Arm one idle reference export (60s)",
                                   action: #selector(armIdleReference(_:)), keyEquivalent: "")
        reference.target = self
        let referenceStatus = NSMenuItem(title: "Reference not armed", action: nil, keyEquivalent: "")
        referenceStatus.isEnabled = false
        let identity = NSMenuItem(title: "Host instance " + String(instanceID.prefix(8)), action: nil,
                                  keyEquivalent: "")
        identity.isEnabled = false
        menu.addItem(stop); menu.addItem(allow); menu.addItem(.separator())
        menu.addItem(enable); menu.addItem(disable); menu.addItem(enableInput); menu.addItem(disableInput)
        menu.addItem(reference); menu.addItem(referenceStatus)
        menu.addItem(.separator()); menu.addItem(identity); menu.addItem(quit)
        item.menu = menu
        statusItem = item; stopMenuItem = stop; allowMenuItem = allow
        enableCaptureMenuItem = enable; disableCaptureMenuItem = disable
        enableInputMenuItem = enableInput; disableInputMenuItem = disableInput
        idleReferenceMenuItem = reference; idleReferenceStatusMenuItem = referenceStatus
        updateHumanControl()
    }

    private func updateHumanControl() {
        stopMenuItem?.isEnabled = availability.humanAllowed
        allowMenuItem?.isEnabled = !availability.humanAllowed
        enableCaptureMenuItem?.isEnabled = !capturePreferences.isEnabled
        disableCaptureMenuItem?.isEnabled = capturePreferences.isEnabled
        enableInputMenuItem?.isEnabled = !inputPreferences.isEnabled
        disableInputMenuItem?.isEnabled = inputPreferences.isEnabled
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

    func menuWillOpen(_ menu: NSMenu) {
        humanMenuOpen = true
        updateHumanControl()
    }

    func menuDidClose(_ menu: NSMenu) { humanMenuOpen = false }

    @objc private func stopAgentControl(_ sender: Any?) {
        // Raw, nonthrowing entry observation only. Diagnostic validation and
        // attachment must follow the existing revocation and UI invalidation.
        let entryHostTime = HostCoreMediaClock.sample()
        let invokedAt = clock.milliseconds()
        availability.apply(.humanStopped)
        lease.stopFromHuman(instanceID: instanceID, processID: getpid(), displayID: capture.displayID,
                            displayGeneration: generation, now: invokedAt)
        let eventID = lease.lastHumanStopEvent?.eventID
        // Release any button or key an input action holds, synchronously.
        // The action's own stop reports it; this count is diagnostic only.
        _ = activeInputSession?.releaseHeld()
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

    @objc private func enableInput(_ sender: Any?) {
        // Opt-in alone creates no lease and posts nothing; it requests no
        // Accessibility prompt. A controller still needs a fresh activity.
        inputPreferences.setEnabled(true)
        inputMonitor.start()
        updateHumanControl()
    }

    @objc private func disableInput(_ sender: Any?) {
        // An action in flight re-checks this before its next event.
        inputPreferences.setEnabled(false)
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
        if agentIdle.cut(lease.active, at: now) {
            lease.invalidate(); clearActivityUI()
        }
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

    /// Absent means PNG, as before D38, so an older broker is unchanged.
    private func imageFormat(_ request: HostRequest) throws -> HostImageFormat {
        guard let value = request.params["format"] else { return .png }
        guard let name = value.string, let format = HostImageFormat(rawValue: name) else {
            throw HostLeaseError.invalidParameters
        }
        return format
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

    /// #177: the idle clock moves only for the lease owner's own successful
    /// agent requests, never for a refused request or another connection, and
    /// never for a heartbeat. The broker marks the renewals an agent batch
    /// sends with `agent_request: true`.
    static let agentRequestActions: Set<String> = ["begin_activity", "capture", "screenshot", "ax_snapshot",
                                                   "ax_action", "ax_verify", "input", "ax_value"]

    private func handle(_ request: HostRequest, connectionID: UUID) async -> HostResponse {
        let response = await handleRequest(request, connectionID: connectionID)
        let agentRenewal = request.action == "renew_activity" && request.params["agent_request"] == .boolean(true)
        if response.success, Self.agentRequestActions.contains(request.action) || agentRenewal,
           lease.active?.connectionID == connectionID {
            agentIdle.noteRequest(at: clock.milliseconds())
        }
        return response
    }

    private func handleRequest(_ request: HostRequest, connectionID: UUID) async -> HostResponse {
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
                                                 "ax_snapshot", "ax_action", "input", "capture_scope",
                                                 "ax_value"].map { .string($0) })
                // #157: input posts CGEvents only under the local opt-in,
                // the Accessibility grant and a live, indicated lease.
                status["input_service"] = .boolean(inputPreferences.isEnabled && HostSystemInputPoster.permitted)
                status["input_enabled"] = .boolean(inputPreferences.isEnabled)
                status["input_post_permission"] = .boolean(HostSystemInputPoster.permitted)
                status["operator_input_monitor"] = .string(inputMonitor.mode)
                status["secure_input"] = .boolean(IsSecureEventInputEnabled())
                // Requests on one connection are answered as each completes.
                status["request_pipelining"] = .boolean(true)
                // #177: the Host's own bound on an activity with no agent request.
                status["agent_idle_release_ms"] = .integer(Int64(HostAgentIdleClock.limitMilliseconds))
                status["agent_idle_releases"] = .integer(Int64(agentIdle.releases))
                // Capture and AX replies may be split with reply_part_bytes.
                status["reply_parts"] = .boolean(true)
                status["image_formats"] = .array([HostImageFormat.png, .jpeg].map { .string($0.rawValue) })
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
                // #177: before the snapshot below, so tick() never cuts this
                // lease on an older lease's clock.
                agentIdle.begin(at: now)
                captureInProgress = true
                defer { captureInProgress = false }
                do {
                    // A complete excluded-app image must succeed before UI is shown.
                    let snapshot = try await capture.snapshot(maximumDimension: 256)
                    let snapshotAt = clock.milliseconds()
                    let current = try lease.requireOwner(sessionID: session, connectionID: connectionID,
                        displayGeneration: generation, now: snapshotAt)
                    try requireAvailable()
                    try permission.requireCapture(enabled: capture.enabled)
                    captureReady = true
                    overlayReady = renderer.show()
                    guard overlayReady else { throw HostLeaseError.notReady }
                    let acknowledgedAt = clock.milliseconds()
                    lastUIHeartbeat = acknowledgedAt
                    var stages = snapshot.stageMilliseconds
                    stages["overlay_show"] = Int64(clamping: acknowledgedAt - snapshotAt)
                    return .ok(request, readiness(now: acknowledgedAt, activity: current)
                        .merging(["host_stage_ms": .object(stages.mapValues { .integer($0) })]) { _, value in value })
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
                if agentIdle.wasCut(sessionID: request.params["session_id"]?.string, connectionID: connectionID) {
                    throw HostLeaseError.agentIdleReleased
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
                let format = try imageFormat(request)
                let scope = try HostCaptureScope.parse(request.params)
                let session = try request.requiredString("session_id")
                _ = try lease.requireOwner(sessionID: session, connectionID: connectionID,
                                            displayGeneration: generation, now: now)
                guard HostLeaseState.isReady(now: now, uiHeartbeatAt: lastUIHeartbeat,
                    captureReady: captureReady, overlayReady: overlayReady && renderer.hasVisibleDisplayPanels),
                    !captureInProgress, !axSnapshotInProgress, !axActionInProgress, !inputInProgress,
                    !idleReference.isExporting else {
                    throw HostLeaseError.notReady
                }
                captureInProgress = true
                defer { captureInProgress = false }
                do {
                    let image = try await capture.snapshot(maximumDimension: size, format: format, scope: scope)
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
                } catch HostCaptureError.targetUnavailable {
                    // No target window is running; nothing was captured (#163).
                    throw HostCaptureError.targetUnavailable
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
                    !captureInProgress, !axSnapshotInProgress, !axActionInProgress, !inputInProgress,
                    !idleReference.isExporting else {
                    throw HostLeaseError.notReady
                }
                guard accessibility.isTrusted() else { throw HostAccessibilityError.permissionRequired }
                let displayID = capture.displayID
                guard let geometry = HostDisplayGeometry.current(displayID) else {
                    throw HostCaptureError.displayUnavailable
                }
                // #158: a subtree root is resolved before any traversal. These
                // refusals act on nothing, so the lease stays.
                let applications: [HostAXApplication]
                switch axRequest.root {
                case .applications:
                    applications = accessibility.applications(focusedOnly: axRequest.focusedApplicationOnly,
                                                              menuExtras: axRequest.menuExtras, excluding: getpid())
                case .ref(let ref):
                    guard let latest = axGeneration, latest.sessionID == session,
                          latest.displayGeneration == generation, latest.geometry == geometry,
                          let element = latest.elements[ref] else { throw HostAXActionError.staleRef }
                    applications = [HostAXApplication(processID: element.processID, bundleID: element.bundleID,
                                                      name: nil, root: element.node, rootRef: ref)]
                case .focusedWindow, .menu:
                    guard let root = accessibility.subtreeRoot(axRequest.root, excluding: getpid()) else {
                        throw HostAccessibilityError.rootUnavailable
                    }
                    applications = [root]
                }
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
                            geometry: geometry, generation: number, maximumNodes: axRequest.maximumNodes) {
                            DispatchTime.now().uptimeNanoseconds >= deadline }
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
            case "input":
                return .ok(request, try await hostInput(request, connectionID: connectionID))
            case "ax_value":
                return .ok(request, try await axValue(request, connectionID: connectionID))
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
        } catch let error as HostInputError {
            return .failure(id: request.id, message: error.rawValue)
        } catch let refusal as HostInputRefusal {
            return .failure(id: request.id, message: refusal.error.rawValue, detail: refusal.detail)
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
        guard !captureInProgress, !axSnapshotInProgress, !axActionInProgress, !inputInProgress,
                    !idleReference.isExporting else {
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
        } catch let refusal as HostAXActionError {
            // Every typed refusal is raised before an Accessibility call that
            // may have acted, so the lease and generation stay. The broker
            // reports a per-call error instead of retiring the lane (#159).
            throw refusal
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
        guard !captureInProgress, !axSnapshotInProgress, !axActionInProgress, !inputInProgress,
                    !idleReference.isExporting else {
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

    /// #157: one pointer or keyboard action, or one activation, posted as
    /// CGEvents by this process. Each event is preceded by the lease check
    /// (Stop, display, indicator heartbeat, grant, opt-in) and the gate
    /// (secure input, frontmost target, window owner, consent dialogs,
    /// operator input), all on the main actor. Refusals before the first
    /// event keep the lease; a stop after it releases what it pressed and
    /// reports `completed: false` with the count it posted.
    private func hostInput(_ request: HostRequest, connectionID: UUID) async throws -> [String: HostValue] {
        try validateDisplay(request)
        try requireAvailable()
        let input = try HostInputRequest.parse(request.params)
        let session = try request.requiredString("session_id")
        let displayID = capture.displayID
        guard let geometry = HostDisplayGeometry.current(displayID) else { throw HostCaptureError.displayUnavailable }
        _ = try requireAXOwner(session: session, connectionID: connectionID, displayID: displayID, geometry: geometry)
        guard inputPreferences.isEnabled else { throw HostInputError.disabled }
        guard HostSystemInputPoster.permitted else { throw HostInputError.permissionRequired }
        guard !captureInProgress, !axSnapshotInProgress, !axActionInProgress, !inputInProgress,
              !idleReference.isExporting else { throw HostLeaseError.notReady }
        let steps = try HostInputPlanner.plan(input, geometry: geometry)
        // #178: hot corners and the auto-hidden Dock edge, read fresh each time.
        try HostScreenEdges.read().check(steps, display: geometry.bounds)
        inputMonitor.start()
        inputInProgress = true
        defer { inputInProgress = false }
        let leaseCheck: HostInputSession.Check = { [unowned self] in
            _ = try self.requireAXOwner(session: session, connectionID: connectionID, displayID: displayID,
                                        geometry: geometry)
            guard self.inputPreferences.isEnabled else { throw HostInputError.disabled }
            // A controller that gave up (EOF, timeout) gets no further events.
            guard self.server?.connectionIsLive(connectionID) == true else { throw HostLeaseError.expired }
            // The operator opened the Fruitctl menu, most likely for Stop.
            guard !self.humanMenuOpen else { throw HostInputError.operatorInput }
        }
        let read: @MainActor (CGPoint?, Bool) -> HostInputEnvironment = { [unowned self] point, start in
            HostSystemInputEnvironment.read(point: point, start: start, keyboard: !input.kind.pointer,
                wantsTitle: input.target.windowTitle != nil,
                executable: { self.accessibility.executableName(processID: $0) },
                monitor: self.inputMonitor, now: self.clock.milliseconds(), ownPanels: self.renderer.panelWindowNumbers)
        }
        let pause: (UInt64) async -> Void = { milliseconds in
            try? await Task.sleep(nanoseconds: milliseconds * 1_000_000)
        }
        do {
            let outcome: HostInputSession.Outcome
            if input.kind == .activate {
                outcome = try await activate(input, lease: leaseCheck, read: read, pause: pause)
            } else {
                let runner = HostInputSession(poster: inputPoster, environment: read, monitor: inputMonitor,
                    now: { [clock] in clock.milliseconds() }, sleep: pause, targetFrontmost: {
                        NSWorkspace.shared.frontmostApplication?.bundleIdentifier == input.target.bundleID })
                activeInputSession = runner
                defer { activeInputSession = nil }
                outcome = try await runner.run(input, steps: steps, lease: leaseCheck)
            }
            let frontmost = NSWorkspace.shared.frontmostApplication.map {
                HostInputProcess(processID: $0.processIdentifier, bundleID: $0.bundleIdentifier, executable: nil)
            }
            let current: HostActivityLease
            do {
                current = try requireAXOwner(session: session, connectionID: connectionID, displayID: displayID,
                                             geometry: geometry)
            } catch {
                // The lease ended mid-action (Stop, expiry, display change).
                // Report what was posted; the controller retires its lane.
                if lease.release(connectionID: connectionID, sessionID: session) { clearActivityUI() }
                return ["instance_id": .string(instanceID), "session_id": .string(session), "lease_lost": .boolean(true),
                        "input": .object(outcome.metadata(input, frontmost: frontmost, monitor: inputMonitor.mode))]
            }
            return readiness(now: clock.milliseconds(), activity: current).merging(["input": .object(
                outcome.metadata(input, frontmost: frontmost, monitor: inputMonitor.mode))]) { _, value in value }
        } catch let refusal as HostInputError {
            // Raised before the first event: nothing was posted.
            throw refusal
        } catch let refusal as HostInputRefusal {
            throw refusal
        } catch let refusal as HostAXActionError {
            throw refusal
        } catch {
            if lease.release(connectionID: connectionID, sessionID: session) { clearActivityUI() }
            throw error
        }
    }

    /// #161: sets one element's AXValue, or steps it with AXIncrement or
    /// AXDecrement, then reads the value back. It is input: it needs the local
    /// opt-in, a live indicated lease, no secure input, the target frontmost
    /// and, under `yield`, an idle operator. The element must be a value
    /// control owned by the target or its AU hosting process (#172). Refusals
    /// before the first AX call keep the lease; a later stop reports how many
    /// steps ran. Nothing is retried.
    private func axValue(_ request: HostRequest, connectionID: UUID) async throws -> [String: HostValue] {
        try validateDisplay(request)
        try requireAvailable()
        let valueRequest = try HostAXValueRequest.parse(request.params)
        let session = try request.requiredString("session_id")
        let displayID = capture.displayID
        guard let geometry = HostDisplayGeometry.current(displayID) else { throw HostCaptureError.displayUnavailable }
        _ = try requireAXOwner(session: session, connectionID: connectionID, displayID: displayID, geometry: geometry)
        guard inputPreferences.isEnabled else { throw HostInputError.disabled }
        guard !captureInProgress, !axSnapshotInProgress, !axActionInProgress, !inputInProgress,
              !idleReference.isExporting else { throw HostLeaseError.notReady }
        guard let snapshot = axGeneration else { throw HostAXActionError.staleRef }
        let target = try snapshot.resolve(generation: valueRequest.generation, ref: valueRequest.ref,
                                          sessionID: session, displayGeneration: generation, geometry: geometry)
        inputMonitor.start()
        axActionInProgress = true
        defer { axActionInProgress = false }
        let node = target.node
        let runner = HostAXValueRunner(request: valueRequest, node: node, snapshotProcessID: target.processID,
            lease: { [unowned self] in
                _ = try self.requireAXOwner(session: session, connectionID: connectionID, displayID: displayID,
                                            geometry: geometry)
                guard self.inputPreferences.isEnabled else { throw HostInputError.disabled }
                guard self.server?.connectionIsLive(connectionID) == true else { throw HostLeaseError.expired }
                guard !self.humanMenuOpen else { throw HostInputError.operatorInput }
            },
            environment: { [unowned self] in
                HostSystemInputEnvironment.read(point: nil, start: true, keyboard: false, wantsTitle: false,
                    executable: { self.accessibility.executableName(processID: $0) }, monitor: self.inputMonitor,
                    now: self.clock.milliseconds(), ownPanels: [])
            },
            describe: { [unowned self] pid in
                guard let pid else { return nil }
                let process = HostInputProcess(processID: pid,
                    bundleID: NSRunningApplication(processIdentifier: pid)?.bundleIdentifier,
                    executable: self.accessibility.executableName(processID: pid))
                return pid == target.processID ? process : HostProcessIdentity.describe(process)
            },
            now: { [clock] in clock.milliseconds() },
            liveState: { await Task.detached(priority: .userInitiated) { node.liveState() }.value },
            verify: { previous, budget in
                let operation = valueRequest.operation, requested = valueRequest.value
                let deadline = DispatchTime.now().uptimeNanoseconds + budget
                return await Task.detached(priority: .userInitiated) {
                    HostAXValueVerifier.poll(operation, requested: requested, before: previous,
                        read: { node.liveState() }, expired: { DispatchTime.now().uptimeNanoseconds >= deadline },
                        pause: { usleep(useconds_t(HostAXActionPlanner.pollNanoseconds / 1_000)) })
                }.value
            })
        do {
            var outcome = try await runner.run()
            var current: HostActivityLease?
            if !outcome.leaseLost {
                current = try? requireAXOwner(session: session, connectionID: connectionID, displayID: displayID,
                                              geometry: geometry)
            }
            guard let current else {
                // The lease ended after an AX call (Stop, expiry, display
                // change). Report what ran; the controller retires its lane.
                outcome.leaseLost = true
                if outcome.stopReason == nil { outcome.stopReason = "lease_lost" }
                if lease.release(connectionID: connectionID, sessionID: session) { clearActivityUI() }
                return ["instance_id": .string(instanceID), "session_id": .string(session),
                        "lease_lost": .boolean(true), "ax_value": .object(outcome.metadata)]
            }
            return readiness(now: clock.milliseconds(), activity: current)
                .merging(["ax_value": .object(outcome.metadata)]) { _, value in value }
        } catch let refusal as HostInputError {
            // Raised before the first AX call that could change the element.
            throw refusal
        } catch let refusal as HostAXActionError {
            throw refusal
        } catch {
            if lease.release(connectionID: connectionID, sessionID: session) { clearActivityUI() }
            throw error
        }
    }

    /// Makes the one running regular application with the target bundle ID
    /// frontmost, through AXFrontmost (the Accessibility grant), then
    /// NSRunningApplication. Posts no event; polls for up to 500 ms.
    private func activate(_ input: HostInputRequest, lease: HostInputSession.Check,
                          read: @MainActor (CGPoint?, Bool) -> HostInputEnvironment,
                          pause: (UInt64) async -> Void) async throws -> HostInputSession.Outcome {
        try lease()
        try HostInputGate.check(input, read(nil, true), start: true, pointerCheck: false)
        let candidates = NSWorkspace.shared.runningApplications.filter {
            $0.bundleIdentifier == input.target.bundleID && $0.activationPolicy == .regular && !$0.isTerminated
                && (input.target.processID == nil || $0.processIdentifier == input.target.processID)
        }
        guard candidates.count == 1, let target = candidates.first else { throw HostInputError.targetMismatch }
        var outcome = HostInputSession.Outcome()
        let frontmost = { NSWorkspace.shared.frontmostApplication?.processIdentifier == target.processIdentifier }
        if !frontmost() {
            let element = AXUIElementCreateApplication(target.processIdentifier)
            if AXUIElementSetAttributeValue(element, kAXFrontmostAttribute as CFString, kCFBooleanTrue) != .success {
                _ = target.activate(options: [.activateAllWindows])
            }
        }
        for _ in 0..<20 where !frontmost() {
            await pause(25)
            try lease()
        }
        outcome.completed = frontmost()
        if !outcome.completed { outcome.stopReason = "activation_unconfirmed" }
        return outcome
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
                                    [--enable-input | --disable-input]
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
                Raw VNC exclusion is unsupported. With the local input opt-in (--enable-input or
                the menu) and the Accessibility grant, the Host posts pointer and keyboard events
                for one lease-holding controller, only while its indicator is shown.
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
