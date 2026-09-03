import type { PhaseMap } from '../../shared/flight-phases';

'use strict';

type AnnouncementPhase =
  | PhaseMap['TAXI']
  | PhaseMap['CLIMB']
  | PhaseMap['CRUISE']
  | PhaseMap['DESCENT']
  | PhaseMap['APPROACH']
  | PhaseMap['TAXI_IN'];

type EventBusLike = {
  on: (eventName: string, listener: (payload?: unknown) => void) => (() => void) | void;
};

type CabinAnnouncementsConfig = {
  enabled?: boolean;
  style?: string;
  startupGraceMs?: number;
};

type CabinAnnouncementsSettings = {
  cabinAnnouncements?: CabinAnnouncementsConfig | null;
};

type AnnouncementMessage = {
  type: string;
  phase: string;
  style: string;
};

type StartCabinAnnouncementsOptions = {
  eventBus: EventBusLike;
  broadcast: (message: AnnouncementMessage) => void;
  config: CabinAnnouncementsSettings;
  initialPhase?: unknown;
  initialTelemetryFrame?: TelemetryFrame;
  timeNow?: () => number;
  setTimer?: (listener: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

type CabinAnnouncementsHandle = {
  reconfigure: (_config: CabinAnnouncementsSettings) => {
    style: string;
    startupGraceMs: number;
  };
  stop: () => void;
};

type PhaseMessage = {
  value?: unknown;
};

type TelemetryFrame = {
  alt_msl?: unknown;
  display?: {
    raFt?: unknown;
  };
  inMenu?: unknown;
  on_ground?: unknown;
  onGround?: unknown;
  ra?: unknown;
  raFt?: unknown;
  ra_ft?: unknown;
  radioAltitudeFt?: unknown;
  simconnect?: {
    connected?: unknown;
    inFlightContext?: unknown;
  };
  wow?: unknown;
};

const { MSG } = require('../core/message-types') as {
  MSG: {
    CABIN_ANNOUNCEMENT: string;
  };
};
const { PHASES } = require('../lifecycle/phases') as { PHASES: PhaseMap };

const ANNOUNCEMENT_PHASE_VALUES: readonly AnnouncementPhase[] = [
  PHASES.TAXI,
  PHASES.CLIMB,
  PHASES.CRUISE,
  PHASES.DESCENT,
  PHASES.APPROACH,
  PHASES.TAXI_IN,
];

const ANNOUNCEMENT_PHASES = new Set<AnnouncementPhase>(ANNOUNCEMENT_PHASE_VALUES);
const AIRBORNE_ANNOUNCEMENT_PHASES = new Set<AnnouncementPhase>([
  PHASES.CLIMB,
  PHASES.CRUISE,
  PHASES.DESCENT,
  PHASES.APPROACH,
]);

const ALT_10K_ABOVE_FT = 10_200;
const ALT_10K_BELOW_FT = 9_800;
const AIRBORNE_RA_FT = 50;
const CLIMB_ANNOUNCEMENT_MIN_RA_FT = 1_000;

const PHASE_DWELL_MS: Partial<Record<AnnouncementPhase, number>> = {
  [PHASES.TAXI]: 5_000,
  [PHASES.CLIMB]: 30_000,
  [PHASES.CRUISE]: 120_000,
  [PHASES.DESCENT]: 180_000,
  [PHASES.APPROACH]: 0,
  [PHASES.TAXI_IN]: 0,
};

const DEFAULT_PHASE_STARTUP_GRACE_MS = 5_000;

function isAnnouncementPhase(value: unknown): value is AnnouncementPhase {
  return typeof value === 'string' && ANNOUNCEMENT_PHASES.has(value as AnnouncementPhase);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return null;
}

function getFrameGroundState(frame: TelemetryFrame | undefined): boolean | null {
  if (!frame) return null;
  return (
    booleanOrNull(frame.wow)
    ?? booleanOrNull(frame.onGround)
    ?? booleanOrNull(frame.on_ground)
    ?? null
  );
}

function getFrameRadioAltitudeFeet(frame: TelemetryFrame | undefined): number | null {
  if (!frame) return null;
  return (
    finiteNumber(frame.raFt)
    ?? finiteNumber(frame.ra_ft)
    ?? finiteNumber(frame.radioAltitudeFt)
    ?? finiteNumber(frame.display?.raFt)
    ?? null
  );
}

function isFrameBlockedBySimContext(frame: TelemetryFrame | undefined): boolean {
  if (!frame) return true;
  if (booleanOrNull(frame.inMenu) === true) return true;

  const simconnect = frame.simconnect;
  if (!simconnect || typeof simconnect !== 'object') return false;
  if (booleanOrNull(simconnect.connected) === false) return true;
  if (booleanOrNull(simconnect.inFlightContext) === false) return true;
  return false;
}

function startCabinAnnouncements({
  eventBus,
  broadcast,
  config,
  initialPhase,
  initialTelemetryFrame,
  timeNow = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: StartCabinAnnouncementsOptions): CabinAnnouncementsHandle | void {
  const cabinConfig = config.cabinAnnouncements;

  if (!cabinConfig || !cabinConfig.enabled) {
    return;
  }

  let style = cabinConfig.style || 'standard';
  let startupGraceMs = Math.max(
    0,
    typeof cabinConfig.startupGraceMs === 'number' && Number.isFinite(cabinConfig.startupGraceMs)
      ? cabinConfig.startupGraceMs
      : DEFAULT_PHASE_STARTUP_GRACE_MS,
  );

  const announced = new Set<string>();

  let previousPhase: string | null = null;
  let phaseBaselineEstablished = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingPhase: AnnouncementPhase | null = null;
  let pendingGraceTimer: ReturnType<typeof setTimeout> | null = null;
  let eligiblePhase: AnnouncementPhase | null = null;
  let dwellSatisfiedPhase: AnnouncementPhase | null = null;
  let allowFirstPhaseAfterGrace = false;
  let suppressPhaseAnnouncementsUntilMs = timeNow() + startupGraceMs;
  let altitudeState: 'below' | 'above' | null = null;
  let hasTelemetryFrame = false;
  let lastFrameOnGround: boolean | null = null;
  let lastFrameRaFt: number | null = null;
  let hasBeenAirborne = false;
  let flightLifecycleState: 'unknown' | 'active' | 'inactive' = 'unknown';
  let taxiAnnouncedWhileAwaitingFlightStart = false;
  const unsubs: Array<(() => void) | void> = [];

  function subscribe(eventName: string, listener: (payload?: unknown) => void): void {
    unsubs.push(eventBus.on(eventName, listener));
  }

  function cancelPending(): void {
    if (pendingTimer !== null) {
      clearTimer(pendingTimer);
      pendingTimer = null;
    }
    pendingPhase = null;
    dwellSatisfiedPhase = null;
  }

  function cancelGraceEvaluation(): void {
    if (pendingGraceTimer !== null) {
      clearTimer(pendingGraceTimer);
      pendingGraceTimer = null;
    }
  }

  function cancelAllTimers(): void {
    cancelPending();
    cancelGraceEvaluation();
  }

  function resetPhaseGate({ allowFirstPhase = false }: { allowFirstPhase?: boolean } = {}): void {
    cancelAllTimers();
    previousPhase = null;
    phaseBaselineEstablished = false;
    eligiblePhase = null;
    allowFirstPhaseAfterGrace = allowFirstPhase;
    suppressPhaseAnnouncementsUntilMs = timeNow() + startupGraceMs;
  }

  function resetFlightContext({ preserveLatestFrame = false }: { preserveLatestFrame?: boolean } = {}): void {
    if (preserveLatestFrame) {
      hasBeenAirborne = false;
      return;
    }
    hasTelemetryFrame = false;
    lastFrameOnGround = null;
    lastFrameRaFt = null;
    hasBeenAirborne = false;
  }

  function isLatestFrameAirborne(): boolean {
    if (lastFrameOnGround === false) {
      return lastFrameRaFt === null || lastFrameRaFt > AIRBORNE_RA_FT;
    }
    return lastFrameOnGround === null && lastFrameRaFt !== null && lastFrameRaFt > AIRBORNE_RA_FT;
  }

  function updateFlightContext(frame: TelemetryFrame | undefined): void {
    if (!frame) return;
    if (isFrameBlockedBySimContext(frame)) {
      resetFlightContext();
      return;
    }

    hasTelemetryFrame = true;
    lastFrameOnGround = getFrameGroundState(frame);
    lastFrameRaFt = getFrameRadioAltitudeFeet(frame);

    if (isLatestFrameAirborne()) {
      hasBeenAirborne = true;
    }
  }

  function getPhaseAnnouncementBlockReason(
    phase: AnnouncementPhase,
    { finalCheck = false }: { finalCheck?: boolean } = {},
  ): string | null {
    if (!hasTelemetryFrame) return 'telemetry frame not available';

    if (phase === PHASES.TAXI) {
      if (hasBeenAirborne) return 'aircraft has already been airborne';
      if (hasTelemetryFrame && isLatestFrameAirborne()) return 'latest telemetry is airborne';
      if (finalCheck && lastFrameOnGround !== true) return 'latest telemetry is not confirmed on-ground';
    }

    if (AIRBORNE_ANNOUNCEMENT_PHASES.has(phase)) {
      if (hasTelemetryFrame && lastFrameOnGround === true) return 'latest telemetry is still on the ground';
      if (finalCheck && hasTelemetryFrame && !hasBeenAirborne) return 'airborne telemetry has not been observed';
      if (finalCheck && !isLatestFrameAirborne()) return 'latest telemetry is not confirmed airborne';
    }

    if (phase === PHASES.CLIMB) {
      if (
        finalCheck
        && lastFrameRaFt !== null
        && lastFrameRaFt < CLIMB_ANNOUNCEMENT_MIN_RA_FT
      ) {
        return `radio altitude below ${CLIMB_ANNOUNCEMENT_MIN_RA_FT} ft`;
      }
    }

    if (phase === PHASES.TAXI_IN) {
      if (hasTelemetryFrame && isLatestFrameAirborne()) return 'latest telemetry is airborne';
      if (finalCheck && !hasBeenAirborne) return 'aircraft has not been airborne';
      if (finalCheck && lastFrameOnGround !== true) return 'latest telemetry is not confirmed on-ground';
    }

    return null;
  }

  function scheduleGraceEvaluation(phase: AnnouncementPhase): void {
    eligiblePhase = phase;
    cancelGraceEvaluation();

    const delayMs = Math.max(0, suppressPhaseAnnouncementsUntilMs - timeNow());
    pendingGraceTimer = setTimer(() => {
      pendingGraceTimer = null;
      if (previousPhase !== phase || eligiblePhase !== phase) {
        return;
      }
      maybeQueuePhaseAnnouncement(phase);
    }, delayMs);
  }

  function maybeCarryPhaseThroughGrace(phase: AnnouncementPhase): boolean {
    if (phase !== PHASES.TAXI) {
      eligiblePhase = null;
      cancelGraceEvaluation();
      return false;
    }
    scheduleGraceEvaluation(phase);
    return true;
  }

  function maybeQueuePhaseAnnouncement(phase: AnnouncementPhase): void {
    if (announced.has(phase)) {
      eligiblePhase = null;
      return;
    }

    if (timeNow() < suppressPhaseAnnouncementsUntilMs) {
      maybeCarryPhaseThroughGrace(phase);
      return;
    }

    // Keep a legitimate post-grace transition eligible for re-evaluation. A
    // phase event can race the first usable frame, and a dwell can expire on a
    // transiently invalid frame. Telemetry updates should be able to complete
    // either case without requiring another phase transition.
    eligiblePhase = phase;

    const dwell = PHASE_DWELL_MS[phase] ?? 0;
    const dwellSatisfied = dwell <= 0 || dwellSatisfiedPhase === phase;
    const blockReason = getPhaseAnnouncementBlockReason(phase, { finalCheck: dwellSatisfied });
    if (blockReason) {
      console.log(`[cabin-announcements] Announcement suppressed for ${phase}: ${blockReason}.`);
      return;
    }

    if (dwellSatisfied) {
      eligiblePhase = null;
      dwellSatisfiedPhase = null;
      announced.add(phase);
      if (phase === PHASES.TAXI && flightLifecycleState !== 'active') {
        taxiAnnouncedWhileAwaitingFlightStart = true;
      }
      broadcast({ type: MSG.CABIN_ANNOUNCEMENT, phase, style });
      console.log(
        `[cabin-announcements] Announcement fired immediately for phase: ${phase} (pack: ${style})`,
      );
      return;
    }

    if (pendingTimer !== null && pendingPhase === phase) {
      return;
    }

    cancelPending();
    console.log(
      `[cabin-announcements] Dwell timer started - waiting ${dwell / 1000}s to confirm phase: ${phase}`,
    );
    const capturedPhase = phase;
    pendingPhase = phase;
    pendingTimer = setTimer(() => {
      pendingTimer = null;
      pendingPhase = null;
      if (previousPhase !== capturedPhase) {
        return;
      }
      if (announced.has(capturedPhase)) {
        eligiblePhase = null;
        return;
      }
      dwellSatisfiedPhase = capturedPhase;
      const timerBlockReason = getPhaseAnnouncementBlockReason(capturedPhase, { finalCheck: true });
      if (timerBlockReason) {
        console.log(
          `[cabin-announcements] Announcement suppressed after dwell for `
          + `${capturedPhase}: ${timerBlockReason}.`,
        );
        return;
      }
      eligiblePhase = null;
      dwellSatisfiedPhase = null;
      announced.add(capturedPhase);
      if (capturedPhase === PHASES.TAXI && flightLifecycleState !== 'active') {
        taxiAnnouncedWhileAwaitingFlightStart = true;
      }
      broadcast({ type: MSG.CABIN_ANNOUNCEMENT, phase: capturedPhase, style });
      console.log(
        `[cabin-announcements] Announcement fired after ${dwell / 1000}s dwell: `
        + `${capturedPhase} (pack: ${style})`,
      );
    }, dwell);
  }

  // Seeding is local to this runtime instance. It establishes the same
  // baseline that an already-running listener would have without rebroadcasting
  // global events or treating the current phase as a new announcement.
  updateFlightContext(initialTelemetryFrame);
  if (typeof initialPhase === 'string' && initialPhase) {
    previousPhase = initialPhase;
    phaseBaselineEstablished = true;
    console.log(`[cabin-announcements] Initial phase baseline seeded: ${initialPhase}`);
  }

  subscribe('flight:started', () => {
    // The production tick can publish the first TAXI phase immediately before
    // the lifecycle gate emits flight:started. Preserve that phase across the
    // per-flight reset so its grace/dwell timers are re-armed instead of being
    // cancelled until a later phase transition that may never arrive.
    const phaseAtFlightStart = previousPhase;
    const preservePreflightTaxi = phaseAtFlightStart === PHASES.TAXI
      && taxiAnnouncedWhileAwaitingFlightStart;
    announced.clear();
    taxiAnnouncedWhileAwaitingFlightStart = false;
    flightLifecycleState = 'active';
    resetPhaseGate({ allowFirstPhase: true });
    resetFlightContext({ preserveLatestFrame: true });
    altitudeState = null;
    if (phaseAtFlightStart === PHASES.TAXI) {
      previousPhase = phaseAtFlightStart;
      phaseBaselineEstablished = true;
      allowFirstPhaseAfterGrace = false;
      // A manual or delayed lifecycle start can arrive after the TAXI clip has
      // already completed. Keep that one announcement marked across the reset
      // instead of scheduling the same safety audio for a second playback.
      if (preservePreflightTaxi) {
        announced.add(PHASES.TAXI);
      } else {
        maybeQueuePhaseAnnouncement(phaseAtFlightStart);
      }
    }
    console.log('[cabin-announcements] Flight started - announcement queue reset.');
  });

  subscribe('flight:ended', () => {
    // The existing announcement set stays intact until the next start so
    // post-flight phase noise cannot replay earlier clips. This separate marker
    // lets that next start distinguish stale prior-flight TAXI state from a
    // clip that genuinely played while waiting for the new lifecycle to begin.
    flightLifecycleState = 'inactive';
    taxiAnnouncedWhileAwaitingFlightStart = false;
  });

  subscribe('simconnect:aircraftChanged', () => {
    announced.clear();
    taxiAnnouncedWhileAwaitingFlightStart = false;
    flightLifecycleState = 'unknown';
    resetPhaseGate();
    resetFlightContext();
    altitudeState = null;
    console.log('[cabin-announcements] Aircraft changed - full state reset.');
  });

  subscribe('telemetry:phase', (payload?: unknown) => {
    const phase = (payload as PhaseMessage | undefined)?.value;
    console.log(
      `[cabin-announcements] telemetry:phase received: ${String(phase)} `
      + `(prevPhase=${previousPhase}, announced=${[...announced].join(',') || 'none'})`,
    );

    if (typeof phase !== 'string' || !phase) {
      return;
    }

    if (!phaseBaselineEstablished) {
      previousPhase = phase;
      phaseBaselineEstablished = true;
      console.log(`[cabin-announcements] Phase baseline established: ${phase}`);
      if (allowFirstPhaseAfterGrace && isAnnouncementPhase(phase)) {
        maybeQueuePhaseAnnouncement(phase);
      }
      allowFirstPhaseAfterGrace = false;
      return;
    }

    if (timeNow() < suppressPhaseAnnouncementsUntilMs) {
      if (phase !== previousPhase) {
        cancelPending();
      }
      previousPhase = phase;
      if (isAnnouncementPhase(phase)) {
        maybeCarryPhaseThroughGrace(phase);
      }
      console.log(`[cabin-announcements] Phase update suppressed during startup grace: ${phase}`);
      return;
    }

    if (phase === previousPhase) {
      if (isAnnouncementPhase(phase)) {
        maybeQueuePhaseAnnouncement(phase);
      }
      return;
    }
    previousPhase = phase;
    eligiblePhase = null;
    cancelGraceEvaluation();

    cancelPending();

    if (!isAnnouncementPhase(phase)) {
      return;
    }
    maybeQueuePhaseAnnouncement(phase);
  });

  subscribe('telemetry:frame', (payload?: unknown) => {
    const frame = payload as TelemetryFrame | undefined;
    updateFlightContext(frame);

    if (isFrameBlockedBySimContext(frame)) {
      altitudeState = null;
      cancelAllTimers();
      resetFlightContext();
      resetPhaseGate();
      return;
    }

    if (
      eligiblePhase !== null
      && previousPhase === eligiblePhase
      && timeNow() >= suppressPhaseAnnouncementsUntilMs
    ) {
      maybeQueuePhaseAnnouncement(eligiblePhase);
    }

    const altitude = frame?.alt_msl;
    const altitudeFeet = typeof altitude === 'number' && Number.isFinite(altitude) ? altitude : null;
    if (altitudeFeet === null) {
      return;
    }

    if (
      altitudeState === null
      || timeNow() < suppressPhaseAnnouncementsUntilMs
      || getFrameGroundState(frame) === true
      || !isLatestFrameAirborne()
    ) {
      altitudeState = altitudeFeet > 10_000 ? 'above' : 'below';
      return;
    }

    if (
      altitudeState === 'below'
      && altitudeFeet >= ALT_10K_ABOVE_FT
      && !announced.has('ABOVE_10K')
    ) {
      altitudeState = 'above';
      announced.add('ABOVE_10K');
      broadcast({ type: MSG.CABIN_ANNOUNCEMENT, phase: 'ABOVE_10K', style });
      console.log(
        `[cabin-announcements] Altitude announcement fired: ABOVE_10K (${Math.round(altitudeFeet)} ft)`,
      );
    } else if (
      altitudeState === 'above'
      && altitudeFeet <= ALT_10K_BELOW_FT
      && !announced.has('BELOW_10K')
    ) {
      altitudeState = 'below';
      announced.add('BELOW_10K');
      broadcast({ type: MSG.CABIN_ANNOUNCEMENT, phase: 'BELOW_10K', style });
      console.log(
        `[cabin-announcements] Altitude announcement fired: BELOW_10K (${Math.round(altitudeFeet)} ft)`,
      );
    }
  });

  console.log(
    `[cabin-announcements] Enabled (pack: ${style}, startupGraceMs: ${startupGraceMs}).`,
  );

  return {
    reconfigure(nextConfig: CabinAnnouncementsSettings) {
      const nextCabinConfig = nextConfig.cabinAnnouncements;
      style = nextCabinConfig?.style || 'standard';
      startupGraceMs = Math.max(
        0,
        typeof nextCabinConfig?.startupGraceMs === 'number'
          && Number.isFinite(nextCabinConfig.startupGraceMs)
          ? nextCabinConfig.startupGraceMs
          : DEFAULT_PHASE_STARTUP_GRACE_MS,
      );
      console.log(
        `[cabin-announcements] Reconfigured (pack: ${style}, startupGraceMs: ${startupGraceMs}).`,
      );
      return { style, startupGraceMs };
    },

    stop() {
      cancelAllTimers();
      for (const unsub of unsubs) {
        try {
          if (typeof unsub === 'function') unsub();
        } catch {}
      }
      unsubs.length = 0;
    },
  };
}

module.exports = { startCabinAnnouncements };

export {};
