import Foundation

/// These are local deadlines, not timestamps exchanged between machines.
enum HostLeasePolicy {
    static let durationMilliseconds: UInt64 = 3_000
    static let renewalIntervalMilliseconds: UInt64 = 500
    static let uiHeartbeatMaximumAgeMilliseconds: UInt64 = 250
    static let inputPermitMilliseconds: UInt64 = 1_000
    static let maximumChallengeRoundTripMilliseconds: UInt64 = 500
}

enum HostLeaseError: String, Error {
    case invalidParameters = "invalid_lease_parameters"
    case busy = "host_busy"
    case expired = "lease_expired"
    case wrongOwner = "lease_owner_mismatch"
    case staleSequence = "stale_sequence"
    case notReady = "helper_not_ready"
    case displayChanged = "display_generation_changed"
    /// The Host ended this lease because its owner sent no agent request (#177).
    case agentIdleReleased = "agent_idle_released"
}

/// #177: the Host's own bound on an activity whose owner sends no agent
/// request. A broker that keeps renewing for an agent that stopped is cut off
/// at `limitMilliseconds`, above the broker's own 600 s maximum. The cut owner's
/// next renewal is refused by name, not as a lapsed lease (#185).
struct HostAgentIdleClock {
    static let limitMilliseconds: UInt64 = 660_000
    private var lastRequestAt: UInt64?
    private var cutOwner: (sessionID: String, connectionID: UUID)?
    private(set) var releases = 0

    /// A new lease starts its own clock, so it is never cut on an older lease's.
    mutating func begin(at now: UInt64) {
        lastRequestAt = now
        cutOwner = nil
    }

    mutating func noteRequest(at now: UInt64) { lastRequestAt = now }

    /// True when the active lease has gone the whole limit without an agent
    /// request. The caller then ends the lease.
    mutating func cut(_ lease: HostActivityLease?, at now: UInt64) -> Bool {
        guard let lease, let last = lastRequestAt, now >= last &+ Self.limitMilliseconds else { return false }
        lastRequestAt = nil
        cutOwner = (lease.sessionID, lease.connectionID)
        releases += 1
        return true
    }

    func wasCut(sessionID: String?, connectionID: UUID) -> Bool {
        cutOwner?.sessionID == sessionID && cutOwner?.connectionID == connectionID
    }
}

/// Notifications latch independent holds. Waking the system does not silently
/// reactivate a switched-out user session or a still-sleeping display.
struct HostAvailabilityState {
    enum Event {
        case sessionResigned, sessionActivated, screensSlept, screensWoke, systemSlept, systemWoke
        case humanStopped, humanResumed
    }
    private(set) var sessionActive = true
    private(set) var screensAwake = true
    private(set) var systemAwake = true
    private(set) var humanAllowed = true
    /// Every notification is an episode boundary, including return/wake.
    /// A pending idle reference cannot survive an away-and-back transition.
    private(set) var revision = UUID()

    mutating func apply(_ event: Event) {
        revision = UUID()
        switch event {
        case .sessionResigned: sessionActive = false
        case .sessionActivated: sessionActive = true
        case .screensSlept: screensAwake = false
        case .screensWoke: screensAwake = true
        case .systemSlept: systemAwake = false
        case .systemWoke: systemAwake = true
        case .humanStopped: humanAllowed = false
        case .humanResumed: humanAllowed = true
        }
    }

    func allowsActivity(onConsole: Bool, ownedSession: Bool, displaysDrawable: Bool) -> Bool {
        humanAllowed && sessionActive && screensAwake && systemAwake
            && onConsole && ownedSession && displaysDrawable
    }
}

struct HostActivityLease: Equatable {
    let sessionID: String
    let connectionID: UUID
    let displayGeneration: UInt64
    var sequence: UInt64
    var challenge: String
    var expiresAtMilliseconds: UInt64
}

/// One process-local observation of a local Stop invocation, retained after
/// its lease is revoked. This is diagnostic evidence, never a readiness or
/// physical-clear acknowledgment. It deliberately omits the lease challenge
/// and connection identifier.
struct HostHumanStopEvent: Equatable {
    struct Activity: Equatable {
        let sessionID: String
        let displayGeneration: UInt64
        let sequence: UInt64
        let remainingMilliseconds: UInt64

        var metadata: [String: HostValue] {
            ["session_id": .string(sessionID),
             "displayGeneration": .integer(Int64(clamping: displayGeneration)),
             "sequence": .integer(Int64(clamping: sequence)),
             "lease_remaining_ms": .integer(Int64(clamping: remainingMilliseconds))]
        }
    }

    let eventID: UUID
    let eventNumber: Int64
    let instanceID: String
    let processID: Int32
    let displayID: UInt32
    let displayGeneration: UInt64
    let invokedAtMilliseconds: UInt64
    let activity: Activity?
    var coreMediaStopBracket: HostCoreMediaStopBracket? = nil

    var metadata: [String: HostValue] {
        ["schema": .string("fruitctl.human-stop.v1"),
         "event_id": .string(eventID.uuidString), "event_number": .integer(eventNumber),
         "instance_id": .string(instanceID), "process_id": .integer(Int64(processID)),
         "display_id": .integer(Int64(displayID)),
         "displayGeneration": .integer(Int64(clamping: displayGeneration)),
         "clock_basis": .string("host_instance_milliseconds"),
         "invoked_monotonic_ms": .integer(Int64(clamping: invokedAtMilliseconds)),
         "active_lease_at_stop": .boolean(activity != nil),
         "active_lease": activity.map { .object($0.metadata) } ?? .null,
         "core_media_stop_bracket": coreMediaStopBracket?.metadata ?? .null]
    }
}

/// Value-only state machine. The AppKit controller calls it on the main actor;
/// tests use an explicit clock and never start capture, sockets, or desktop UI.
struct HostLeaseState {
    enum UIHeartbeatDecision { case awaitingInitialCapture, recordVisibleHeartbeat, invalidate }
    private(set) var active: HostActivityLease?
    private(set) var lastHumanStopEvent: HostHumanStopEvent?
    private var humanStopEventCount: Int64 = 0

    /// Initial capture yields the main actor before panels may be shown. The
    /// timer must not cancel that bounded acquisition just because the panels
    /// are still hidden. It also must never certify a heartbeat while waiting.
    static func uiHeartbeatDecision(activityEligible: Bool, captureInProgress: Bool,
                                    captureReady: Bool, overlayReady: Bool,
                                    visiblePanels: Bool) -> UIHeartbeatDecision {
        guard activityEligible else { return .invalidate }
        if captureReady && overlayReady && visiblePanels { return .recordVisibleHeartbeat }
        if captureInProgress && !captureReady && !overlayReady && !visiblePanels {
            return .awaitingInitialCapture
        }
        return .invalidate
    }

    static func validToken(_ token: String) -> Bool {
        !token.isEmpty && token.utf8.count <= 256 && token.unicodeScalars.allSatisfy {
            $0.value >= 33 && $0.value <= 126
        }
    }

    @discardableResult
    mutating func expire(at now: UInt64) -> Bool {
        guard let lease = active, now >= lease.expiresAtMilliseconds else { return false }
        active = nil
        return true
    }

    mutating func begin(sessionID: String, connectionID: UUID, sequence: UInt64,
                        challenge: String, displayGeneration: UInt64, now: UInt64) throws {
        expire(at: now)
        guard Self.validToken(sessionID), Self.validToken(challenge), sequence > 0,
              now <= UInt64.max - HostLeasePolicy.durationMilliseconds else {
            throw HostLeaseError.invalidParameters
        }
        guard active == nil else { throw HostLeaseError.busy }
        active = HostActivityLease(sessionID: sessionID, connectionID: connectionID,
                                  displayGeneration: displayGeneration, sequence: sequence,
                                  challenge: challenge,
                                  expiresAtMilliseconds: now + HostLeasePolicy.durationMilliseconds)
    }

    func requireOwner(sessionID: String, connectionID: UUID,
                      displayGeneration: UInt64, now: UInt64) throws -> HostActivityLease {
        guard let lease = active, now < lease.expiresAtMilliseconds else {
            throw HostLeaseError.expired
        }
        guard lease.sessionID == sessionID, lease.connectionID == connectionID else {
            throw HostLeaseError.wrongOwner
        }
        guard lease.displayGeneration == displayGeneration else { throw HostLeaseError.displayChanged }
        return lease
    }

    mutating func renew(sessionID: String, connectionID: UUID, sequence: UInt64,
                        challenge: String, displayGeneration: UInt64, now: UInt64,
                        uiHeartbeatAt: UInt64?, captureReady: Bool, overlayReady: Bool) throws {
        var lease = try requireOwner(sessionID: sessionID, connectionID: connectionID,
                                     displayGeneration: displayGeneration, now: now)
        guard Self.validToken(challenge), sequence > lease.sequence,
              now <= UInt64.max - HostLeasePolicy.durationMilliseconds else {
            throw HostLeaseError.staleSequence
        }
        guard Self.isReady(now: now, uiHeartbeatAt: uiHeartbeatAt,
                           captureReady: captureReady, overlayReady: overlayReady) else {
            throw HostLeaseError.notReady
        }
        lease.sequence = sequence
        lease.challenge = challenge
        lease.expiresAtMilliseconds = now + HostLeasePolicy.durationMilliseconds
        active = lease
    }

    @discardableResult
    mutating func release(connectionID: UUID, sessionID: String? = nil) -> Bool {
        guard let lease = active, lease.connectionID == connectionID,
              sessionID == nil || sessionID == lease.sessionID else { return false }
        active = nil
        return true
    }

    mutating func invalidate() { active = nil }

    /// Only the local AppKit Stop handler calls this transition. Revoke before
    /// constructing diagnostics; ordinary release/invalidation cannot create
    /// a human event. Expired or mismatched-generation leases are not evidence
    /// of an active Stop, even if the timer has not cleared them yet.
    mutating func stopFromHuman(instanceID: String, processID: Int32, displayID: UInt32,
                                displayGeneration: UInt64, now: UInt64) {
        let prior = active
        active = nil
        let activity: HostHumanStopEvent.Activity?
        if let prior, now < prior.expiresAtMilliseconds,
           prior.displayGeneration == displayGeneration {
            activity = HostHumanStopEvent.Activity(sessionID: prior.sessionID,
                displayGeneration: prior.displayGeneration, sequence: prior.sequence,
                remainingMilliseconds: prior.expiresAtMilliseconds - now)
        } else { activity = nil }
        // A bounded diagnostic count never wraps. The UUID remains unique
        // even at saturation; there is no unbounded event history or disk log.
        if humanStopEventCount < Int64.max { humanStopEventCount += 1 }
        lastHumanStopEvent = HostHumanStopEvent(eventID: UUID(), eventNumber: humanStopEventCount,
            instanceID: instanceID, processID: processID, displayID: displayID,
            displayGeneration: displayGeneration, invokedAtMilliseconds: now, activity: activity)
    }

    /// Attach only after the synchronous local transition and UI invalidation.
    /// Never replace an event or its first bracket, or attach to a successor
    /// activity. Invalid times do not throw, restore a lease or change readiness.
    @discardableResult
    mutating func attachHumanStopClockBracket(_ bracket: HostCoreMediaStopBracket,
                                              eventID: UUID) -> Bool {
        guard active == nil, var event = lastHumanStopEvent,
              event.eventID == eventID, event.coreMediaStopBracket == nil else { return false }
        event.coreMediaStopBracket = bracket
        lastHumanStopEvent = event
        return true
    }

    static func heartbeatAge(now: UInt64, uiHeartbeatAt: UInt64?) -> UInt64? {
        guard let heartbeat = uiHeartbeatAt, now >= heartbeat else { return nil }
        return now - heartbeat
    }

    static func isReady(now: UInt64, uiHeartbeatAt: UInt64?,
                        captureReady: Bool, overlayReady: Bool) -> Bool {
        guard captureReady, overlayReady,
              let age = heartbeatAge(now: now, uiHeartbeatAt: uiHeartbeatAt) else { return false }
        return age <= HostLeasePolicy.uiHeartbeatMaximumAgeMilliseconds
    }
}
