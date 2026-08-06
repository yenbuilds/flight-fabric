import type { PhaseMap, PhaseValue } from '../../shared/flight-phases';

'use strict';

type DetectFlightPhaseModule = {
  detectFlightPhase: (input: {
    ias?: unknown;
    gs?: unknown;
    wow?: unknown;
    vs?: unknown;
    ra?: unknown;
    altMsl?: unknown;
  }) => PhaseValue;
  getEffectivePhaseThresholds: () => {
    parked_max_kts?: number;
    takeoff_roll_min_ias_kts?: number;
    takeoff_min_vs_fpm?: number;
  };
};

type PhasesModule = {
  PHASES: PhaseMap;
  GROUND_PHASES: Set<PhaseValue>;
};

type DebugModule = {
  log: (section: string, message: string, data?: unknown) => void;
  twarn: (prefix: string, ...args: unknown[]) => void;
};

type ConfigModule = {
  debug: { enable: boolean };
  phase: {
    holdSamples: number;
    groundHoldSamples: number;
    minDwellMs: number;
    descentConfirmMs: number;
    climbConfirmMs: number;
    cruiseToClimbConfirmMs: number;
    cruiseConfirmMs: number;
    descentToCruiseConfirmMs: number;
    descentToCruiseMaxDropFt: number;
    takeoffGatingEnable: boolean;
    takeoffGatingWindowMs: number;
    takeoffGatingRaFtMax: number;
    minFlightTimeForCruiseMs: number;
  };
  poll: {
    intervalMs: number;
  };
};

type TimeSourceModule = {
  now: () => number;
};

type EventBusModule = {
  emit: (event: string, payload: unknown) => void;
};

type MessageTypesModule = {
  MSG: {
    PHASE: string;
  };
};

type TransitionContext = {
  wow: boolean;
  withinGating: boolean;
  taxiInEligible: boolean;
};

type UpdatePhaseParams = {
  iasKts: number;
  wow: boolean | number;
  vsFpm: number;
  raFt: number;
  gsKts?: number;
  altMslFt?: number;
  approachConfigured?: boolean | null;
  aircraftName?: string;
  onRunway?: boolean | null;
};

type BroadcastFn = (payload: Record<string, unknown>) => void;

type PhaseRunnerStateSnapshot = {
  flightPhase: PhaseValue;
  candidatePhase: PhaseValue;
  candidateCount: number;
  candidateSinceTs: number;
  prevWow: boolean | undefined;
  gatingSamplesRemaining: number;
  taxiInEligible: boolean;
  lastChangeTs: number;
  goAroundRecordedThisApproach: boolean;
  lastAircraftName: string | null;
  takeoffTs: number;
  lastTouchdownTs: number;
  minGsDuringLastWow: number;
  descentEntryAltMsl: number | null;
  recentApproachLikeTs: number;
  recentApproachLikePhase: PhaseValue | null;
};

type PhaseRunner = {
  updatePhase: (params: UpdatePhaseParams, broadcast: BroadcastFn) => {
    phase: PhaseValue;
    changed: boolean;
  };
  getPhase: () => PhaseValue;
  reset: () => void;
  getState: () => PhaseRunnerStateSnapshot;
};

type CreatePhaseRunnerOptions = {
  timeNow?: () => number;
};

const { detectFlightPhase, getEffectivePhaseThresholds } = require('./phase') as DetectFlightPhaseModule;
const { PHASES, GROUND_PHASES } = require('./phases') as PhasesModule;
const Debug = require('../core/debug') as DebugModule;
const { twarn } = Debug;
const config = require('../core/config') as ConfigModule;
const timeSource = require('../core/time-source') as TimeSourceModule;
const eventBus = require('../core/event-bus') as EventBusModule;
const { MSG } = require('../core/message-types') as MessageTypesModule;

const CONSOLE_DEBUG = config.debug.enable;
const HOLD_SAMPLES = config.phase.holdSamples;
const GROUND_HOLD_SAMPLES = config.phase.groundHoldSamples;
const MIN_DWELL_MS = config.phase.minDwellMs;
const DESCENT_CONFIRM_MS = config.phase.descentConfirmMs;
const CLIMB_CONFIRM_MS = config.phase.climbConfirmMs;
const CRUISE_TO_CLIMB_CONFIRM_MS = config.phase.cruiseToClimbConfirmMs;
const CRUISE_CONFIRM_MS = config.phase.cruiseConfirmMs;
const DESCENT_TO_CRUISE_CONFIRM_MS = config.phase.descentToCruiseConfirmMs;
const DESCENT_TO_CRUISE_MAX_DROP_FT = config.phase.descentToCruiseMaxDropFt;
const GATING_ENABLE = config.phase.takeoffGatingEnable;
const GATING_WINDOW_MS = config.phase.takeoffGatingWindowMs;
const POLL_INTERVAL_MS = config.poll.intervalMs;
const GATING_SAMPLES_MAX = Math.ceil(GATING_WINDOW_MS / POLL_INTERVAL_MS);
const GATING_RA_FT_MAX = config.phase.takeoffGatingRaFtMax;
const MIN_FLIGHT_TIME_FOR_CRUISE_MS = config.phase.minFlightTimeForCruiseMs;

const ALLOWED_TRANSITIONS: Readonly<Record<PhaseValue, Set<PhaseValue>>> = Object.freeze({
  [PHASES.UNKNOWN]: new Set([
    PHASES.UNKNOWN,
    PHASES.PARKED,
    PHASES.TAXI,
    PHASES.TAKEOFF,
    PHASES.CLIMB,
    PHASES.CRUISE,
    PHASES.DESCENT,
    PHASES.APPROACH,
    PHASES.LANDING,
  ]),
  [PHASES.PARKED]: new Set([PHASES.PARKED, PHASES.TAXI]),
  [PHASES.TAXI]: new Set([PHASES.TAXI, PHASES.PARKED, PHASES.TAKEOFF]),
  [PHASES.TAXI_IN]: new Set([PHASES.TAXI_IN, PHASES.TAXI, PHASES.PARKED]),
  [PHASES.TAKEOFF]: new Set([PHASES.TAKEOFF, PHASES.CLIMB, PHASES.CRUISE, PHASES.TAXI]),
  [PHASES.CLIMB]: new Set([PHASES.CLIMB, PHASES.CRUISE, PHASES.DESCENT, PHASES.APPROACH]),
  [PHASES.CRUISE]: new Set([PHASES.CRUISE, PHASES.CLIMB, PHASES.DESCENT]),
  [PHASES.DESCENT]: new Set([PHASES.DESCENT, PHASES.CRUISE, PHASES.APPROACH, PHASES.CLIMB]),
  [PHASES.APPROACH]: new Set([
    PHASES.APPROACH,
    PHASES.LANDING,
    PHASES.DESCENT,
    PHASES.CLIMB,
    PHASES.GO_AROUND,
  ]),
  [PHASES.GO_AROUND]: new Set([PHASES.GO_AROUND, PHASES.CLIMB]),
  [PHASES.LANDING]: new Set([
    PHASES.LANDING,
    PHASES.TAXI_IN,
    PHASES.TAXI,
    PHASES.CLIMB,
    PHASES.GO_AROUND,
    PHASES.TAKEOFF,
  ]),
});

const AIRBORNE_PHASES = new Set<PhaseValue>([
  PHASES.CLIMB,
  PHASES.CRUISE,
  PHASES.DESCENT,
  PHASES.APPROACH,
  PHASES.GO_AROUND,
]);

const TOUCHDOWN_AIRBORNE_PHASES = new Set<PhaseValue>([
  PHASES.CLIMB,
  PHASES.CRUISE,
  PHASES.DESCENT,
  PHASES.APPROACH,
  PHASES.GO_AROUND,
  PHASES.LANDING,
]);

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAllowedTransition(
  from: PhaseValue,
  to: PhaseValue,
  { wow, withinGating, taxiInEligible }: TransitionContext,
): boolean {
  if (!to || to === from) return true;

  if (
    !wow
    && (from === PHASES.PARKED || from === PHASES.TAXI)
    && (to === PHASES.TAKEOFF || AIRBORNE_PHASES.has(to))
  ) {
    return true;
  }

  if (to === PHASES.TAKEOFF) {
    const fromGround = from === PHASES.TAXI || from === PHASES.PARKED || from === PHASES.UNKNOWN;
    if (!fromGround && !withinGating) return false;
  }

  if (
    wow
    && (
      to === PHASES.CLIMB
      || to === PHASES.CRUISE
      || to === PHASES.DESCENT
      || to === PHASES.APPROACH
      || to === PHASES.GO_AROUND
    )
  ) {
    return false;
  }

  if (wow && AIRBORNE_PHASES.has(from) && GROUND_PHASES.has(to)) {
    return true;
  }

  if (from === PHASES.TAXI && to === PHASES.TAXI_IN && taxiInEligible) {
    return true;
  }

  const allowed = ALLOWED_TRANSITIONS[from] || ALLOWED_TRANSITIONS[PHASES.UNKNOWN];
  return allowed.has(to);
}

function createPhaseRunner(options: CreatePhaseRunnerOptions = {}): PhaseRunner {
  const getNow = options.timeNow || (() => timeSource.now());

  let flightPhase: PhaseValue = PHASES.UNKNOWN;
  let candidatePhase: PhaseValue = PHASES.UNKNOWN;
  let candidateCount = 0;
  let candidateSinceTs = 0;
  let prevWow: boolean | undefined;
  let gatingSamplesRemaining = 0;
  let taxiInEligible = false;
  let lastChangeTs = 0;
  let lastBlockedKey = '';
  let lastBlockedTs = 0;
  let lastPhaseLogTs = 0;
  let goAroundRecordedThisApproach = false;
  let takeoffTs = 0;
  let lastAircraftName: string | null = null;
  let lastTouchdownTs = 0;
  let wasAirborneBeforeTouchdown = false;
  let minGsDuringCurrentWow = Number.POSITIVE_INFINITY;
  let minGsDuringLastWow = Number.POSITIVE_INFINITY;
  let runwayStatusDuringCurrentWow: boolean | null = null;
  let runwayStatusDuringLastWow: boolean | null = null;
  let descentEntryAltMsl: number | null = null;
  let recentApproachLikeTs = 0;
  let recentApproachLikePhase: PhaseValue | null = null;
  let lastApproachConfigurationTs = 0;
  let recentConfiguredApproachTs = 0;

  const TOUCH_AND_GO_WINDOW_MS = 30000;
  const BOUNCE_GS_THRESHOLD_KTS = 80;
  const GO_AROUND_ARM_RA_FT = 4000;
  const GO_AROUND_ARM_DESCENT_FPM = 300;
  const GO_AROUND_ARM_WINDOW_MS = 120000;
  const APPROACH_CONFIGURATION_FRESH_MS = Math.max(1000, POLL_INTERVAL_MS * 5);
  const GO_AROUND_ARMING_PHASES = new Set<PhaseValue>([
    PHASES.DESCENT,
    PHASES.APPROACH,
    PHASES.LANDING,
  ]);

  function getPhase(): PhaseValue {
    return flightPhase;
  }

  function reset(): void {
    flightPhase = PHASES.UNKNOWN;
    candidatePhase = PHASES.UNKNOWN;
    candidateCount = 0;
    candidateSinceTs = 0;
    prevWow = undefined;
    gatingSamplesRemaining = 0;
    taxiInEligible = false;
    lastChangeTs = 0;
    lastBlockedKey = '';
    lastBlockedTs = 0;
    lastPhaseLogTs = 0;
    goAroundRecordedThisApproach = false;
    lastAircraftName = null;
    takeoffTs = 0;
    lastTouchdownTs = 0;
    wasAirborneBeforeTouchdown = false;
    minGsDuringCurrentWow = Number.POSITIVE_INFINITY;
    minGsDuringLastWow = Number.POSITIVE_INFINITY;
    runwayStatusDuringCurrentWow = null;
    runwayStatusDuringLastWow = null;
    descentEntryAltMsl = null;
    recentApproachLikeTs = 0;
    recentApproachLikePhase = null;
    lastApproachConfigurationTs = 0;
    recentConfiguredApproachTs = 0;
  }

  function getState(): PhaseRunnerStateSnapshot {
    return {
      flightPhase,
      candidatePhase,
      candidateCount,
      candidateSinceTs,
      prevWow,
      gatingSamplesRemaining,
      taxiInEligible,
      lastChangeTs,
      goAroundRecordedThisApproach,
      lastAircraftName,
      takeoffTs,
      lastTouchdownTs,
      minGsDuringLastWow,
      descentEntryAltMsl,
      recentApproachLikeTs,
      recentApproachLikePhase,
    };
  }

  function updatePhase(
    params: UpdatePhaseParams,
    broadcast: BroadcastFn,
  ): { phase: PhaseValue; changed: boolean } {
    const {
      iasKts,
      wow,
      vsFpm,
      raFt,
      gsKts,
      altMslFt,
      approachConfigured,
      aircraftName,
      onRunway,
    } = params;

    if (aircraftName) lastAircraftName = aircraftName;

    const iasAvailable = typeof iasKts === 'number' && Number.isFinite(iasKts) && iasKts >= 0;
    const iasKnots = iasAvailable ? iasKts : 0;
    const vsFpmValue = typeof vsFpm === 'number' && Number.isFinite(vsFpm) ? vsFpm : 0;
    const raFtValue = typeof raFt === 'number' && Number.isFinite(raFt) ? raFt : 0;
    const gsAvailable = typeof gsKts === 'number' && Number.isFinite(gsKts) && gsKts >= 0;
    const gs = gsAvailable ? gsKts : 0;
    const altMsl = typeof altMslFt === 'number' && Number.isFinite(altMslFt) ? altMslFt : null;
    const wowSpeedKts = gsAvailable ? gs : null;
    const onRunwayValue = typeof onRunway === 'boolean' ? onRunway : null;
    const approachConfiguredValue = typeof approachConfigured === 'boolean'
      ? approachConfigured
      : null;
    const phaseThresholds = getEffectivePhaseThresholds();
    const takeoffGateMinGsKts = Math.max(
      phaseThresholds.parked_max_kts ?? 2,
      phaseThresholds.takeoff_roll_min_ias_kts ?? 30,
    );
    const takeoffGateMinVsFpm = phaseThresholds.takeoff_min_vs_fpm ?? 400;

    const nowWow = Boolean(wow);
    if (typeof prevWow === 'undefined') prevWow = nowWow;

    if (nowWow && onRunwayValue !== null) {
      runwayStatusDuringCurrentWow = onRunwayValue;
    }

    if (prevWow === false && nowWow === true) {
      taxiInEligible = true;
      lastTouchdownTs = getNow();
      minGsDuringCurrentWow = wowSpeedKts ?? Number.POSITIVE_INFINITY;
      runwayStatusDuringCurrentWow = onRunwayValue;
      wasAirborneBeforeTouchdown = TOUCHDOWN_AIRBORNE_PHASES.has(flightPhase);
    }

    if (nowWow && wowSpeedKts !== null) {
      minGsDuringCurrentWow = Math.min(minGsDuringCurrentWow, wowSpeedKts);
    }

    if (GATING_ENABLE && prevWow === true && !nowWow) {
      minGsDuringLastWow = minGsDuringCurrentWow;
      minGsDuringCurrentWow = Number.POSITIVE_INFINITY;
      runwayStatusDuringLastWow = runwayStatusDuringCurrentWow;
      runwayStatusDuringCurrentWow = null;
      if (!wasAirborneBeforeTouchdown) {
        gatingSamplesRemaining = GATING_SAMPLES_MAX;
      }
    }
    prevWow = nowWow;

    const now = getNow();
    if (approachConfiguredValue !== null) {
      lastApproachConfigurationTs = now;
    }
    let measured = detectFlightPhase({
      ias: iasKnots,
      gs: gsAvailable ? gs : undefined,
      wow,
      vs: vsFpmValue,
      ra: raFtValue,
      altMsl,
    });

    if (
      !nowWow
      && raFtValue > 0
      && raFtValue <= GO_AROUND_ARM_RA_FT
      && vsFpmValue <= -GO_AROUND_ARM_DESCENT_FPM
      && GO_AROUND_ARMING_PHASES.has(flightPhase)
    ) {
      recentApproachLikeTs = now;
      recentApproachLikePhase = flightPhase;
    }

    if (
      approachConfiguredValue === true
      && (
        flightPhase === PHASES.APPROACH
        || flightPhase === PHASES.LANDING
        || (
          !nowWow
          && raFtValue > 0
          && raFtValue <= GO_AROUND_ARM_RA_FT
          && vsFpmValue <= -GO_AROUND_ARM_DESCENT_FPM
          && GO_AROUND_ARMING_PHASES.has(flightPhase)
        )
      )
    ) {
      // Configuration may be completed while level at an MDA or while the
      // phase detector is still confirming APPROACH. Do not require an active
      // descent once the FSM already has approach/landing context.
      recentConfiguredApproachTs = now;
    }

    const withinGating = gatingSamplesRemaining > 0;
    if (gatingSamplesRemaining > 0) gatingSamplesRemaining--;

    if (GATING_ENABLE && !wow) {
      if (
        withinGating
        && runwayStatusDuringLastWow !== false
        && gsAvailable
        && gs >= takeoffGateMinGsKts
        && vsFpmValue > takeoffGateMinVsFpm
        && (typeof raFtValue !== 'number' || raFtValue <= GATING_RA_FT_MAX)
      ) {
        measured = PHASES.TAKEOFF;
      }
    }

    const fromGroundBeforeTakeoff = (
      flightPhase === PHASES.UNKNOWN
      || flightPhase === PHASES.PARKED
      || flightPhase === PHASES.TAXI
    );
    if (
      measured === PHASES.TAKEOFF
      && !nowWow
      && fromGroundBeforeTakeoff
      && runwayStatusDuringLastWow === false
      && raFtValue <= GATING_RA_FT_MAX
    ) {
      measured = flightPhase === PHASES.UNKNOWN ? PHASES.TAXI : flightPhase;
      Debug.log('phase', 'TAKEOFF suppressed: last ground roll was not on runway', {
        phase: flightPhase,
        on_runway: onRunwayValue,
        last_wow_on_runway: runwayStatusDuringLastWow,
        ra_ft: raFtValue,
        gs_kts: gsAvailable ? gs : null,
      });
    }

    if (
      measured === PHASES.LANDING
      && nowWow
      && onRunwayValue === false
      && !TOUCHDOWN_AIRBORNE_PHASES.has(flightPhase)
    ) {
      measured = PHASES.TAXI;
      Debug.log('phase', 'LANDING suppressed: ground roll is not on runway', {
        phase: flightPhase,
        on_runway: onRunwayValue,
        ra_ft: raFtValue,
        gs_kts: gsAvailable ? gs : null,
      });
    }

    if (measured === PHASES.TAXI_IN && !taxiInEligible && flightPhase !== PHASES.TAXI_IN) {
      measured = PHASES.TAXI;
    }

    let desired = isAllowedTransition(flightPhase, measured, {
      wow: Boolean(wow),
      withinGating,
      taxiInEligible,
    })
      ? measured
      : flightPhase;

    const EMERGENCY_RA_FT = 500;
    if (flightPhase === PHASES.CRUISE && !wow && raFtValue < EMERGENCY_RA_FT && raFtValue > 0) {
      const emergencyPhase = PHASES.APPROACH;
      if (desired === PHASES.CRUISE) {
        desired = emergencyPhase;
        Debug.log('phase', 'Emergency altitude override: CRUISE at low RA', {
          ra_ft: raFtValue,
          vs_fpm: vsFpmValue,
          forced_phase: emergencyPhase,
        });
      }
    }

    if (desired === flightPhase && measured !== flightPhase) {
      const key = `${flightPhase}->${measured}`;
      if (key !== lastBlockedKey || (now - lastBlockedTs) > 5000) {
        lastBlockedKey = key;
        lastBlockedTs = now;
        if (CONSOLE_DEBUG) {
          twarn('[phase]', 'FSM blocked measured transition', {
            from: flightPhase,
            to: measured,
            wow: Boolean(wow),
            ias_kts: iasKnots,
            vs_fpm: vsFpmValue,
            ra_ft: raFtValue,
            gs_kts: gs,
            on_runway: onRunwayValue,
            last_wow_on_runway: runwayStatusDuringLastWow,
            within_takeoff_gating: withinGating,
          });
        }
        try {
          Debug.log('phase', 'FSM blocked measured transition', {
            from: flightPhase,
            to: measured,
            wow: Boolean(wow),
            ias_kts: iasKnots,
            vs_fpm: vsFpmValue,
            ra_ft: raFtValue,
            gs_kts: gs,
            on_runway: onRunwayValue,
            last_wow_on_runway: runwayStatusDuringLastWow,
            within_takeoff_gating: withinGating,
          });
        } catch (error) {
          Debug.log('phase', 'debug log error', { error: toErrorMessage(error) });
        }
      }
    }

    if (
      desired === PHASES.DESCENT
      && flightPhase !== PHASES.DESCENT
      && descentEntryAltMsl === null
    ) {
      descentEntryAltMsl = altMsl;
    }

    if (desired !== candidatePhase) {
      if (
        candidatePhase === PHASES.DESCENT
        && desired !== PHASES.DESCENT
        && flightPhase !== PHASES.DESCENT
      ) {
        descentEntryAltMsl = null;
      }
      candidatePhase = desired;
      candidateCount = 1;
      candidateSinceTs = now;
    } else {
      candidateCount++;
    }

    const isGroundTransition = (
      flightPhase === PHASES.PARKED && candidatePhase === PHASES.TAXI
    ) || (
      flightPhase === PHASES.TAXI && candidatePhase === PHASES.PARKED
    );
    const requiredSamples = isGroundTransition ? GROUND_HOLD_SAMPLES : HOLD_SAMPLES;

    let changed = false;
    if (candidatePhase !== flightPhase && candidateCount >= requiredSamples) {
      const nowTs = now;
      const timeSinceChange = lastChangeTs ? nowTs - lastChangeTs : Number.POSITIVE_INFINITY;
      const isFirst = flightPhase === PHASES.UNKNOWN;
      const skipDwell = isFirst || candidatePhase === PHASES.TAKEOFF || isGroundTransition;

      if (skipDwell || timeSinceChange >= MIN_DWELL_MS) {
        let requiredConfirmMs = 0;
        if (candidatePhase === PHASES.DESCENT) {
          requiredConfirmMs = DESCENT_CONFIRM_MS;
        } else if (candidatePhase === PHASES.CLIMB && flightPhase === PHASES.CRUISE) {
          requiredConfirmMs = CRUISE_TO_CLIMB_CONFIRM_MS;
        } else if (candidatePhase === PHASES.CLIMB && flightPhase !== PHASES.TAKEOFF) {
          requiredConfirmMs = CLIMB_CONFIRM_MS;
        } else if (candidatePhase === PHASES.CRUISE && flightPhase === PHASES.CLIMB) {
          requiredConfirmMs = CRUISE_CONFIRM_MS;
        } else if (candidatePhase === PHASES.CRUISE && flightPhase === PHASES.DESCENT) {
          requiredConfirmMs = DESCENT_TO_CRUISE_CONFIRM_MS;
          if (DESCENT_TO_CRUISE_MAX_DROP_FT > 0 && descentEntryAltMsl !== null && altMsl !== null) {
            const dropFt = descentEntryAltMsl - altMsl;
            if (dropFt > DESCENT_TO_CRUISE_MAX_DROP_FT) {
              Debug.log('phase', 'DESCENT->CRUISE blocked: descent too deep', {
                descentEntryAltMsl,
                currentAltMsl: altMsl,
                dropFt,
                maxDropFt: DESCENT_TO_CRUISE_MAX_DROP_FT,
              });
              return { phase: flightPhase, changed: false };
            }
          }
        }

        if (requiredConfirmMs > 0) {
          const sustainedMs = nowTs - (candidateSinceTs ?? nowTs);
          if (sustainedMs < Math.max(0, requiredConfirmMs)) {
            return { phase: flightPhase, changed: false };
          }
        }

        if (candidatePhase === PHASES.CRUISE && takeoffTs > 0 && MIN_FLIGHT_TIME_FOR_CRUISE_MS > 0) {
          const timeSinceTakeoff = nowTs - takeoffTs;
          if (timeSinceTakeoff < MIN_FLIGHT_TIME_FOR_CRUISE_MS) {
            Debug.log('phase', 'CRUISE blocked: too soon after takeoff', {
              timeSinceTakeoff_ms: timeSinceTakeoff,
              required_ms: MIN_FLIGHT_TIME_FOR_CRUISE_MS,
              remaining_ms: MIN_FLIGHT_TIME_FOR_CRUISE_MS - timeSinceTakeoff,
            });
            return { phase: flightPhase, changed: false };
          }
        }

        const previousPhase = flightPhase;
        const recentApproachContextAge = recentApproachLikeTs > 0
          ? nowTs - recentApproachLikeTs
          : Number.POSITIVE_INFINITY;
        const hasRecentApproachContext = recentApproachContextAge >= 0
          && recentApproachContextAge <= GO_AROUND_ARM_WINDOW_MS;
        const recentConfiguredApproachAge = recentConfiguredApproachTs > 0
          ? nowTs - recentConfiguredApproachTs
          : Number.POSITIVE_INFINITY;
        const hasRecentConfiguredApproach = recentConfiguredApproachAge >= 0
          && recentConfiguredApproachAge <= GO_AROUND_ARM_WINDOW_MS;
        const approachConfigurationAge = lastApproachConfigurationTs > 0
          ? nowTs - lastApproachConfigurationTs
          : Number.POSITIVE_INFINITY;
        const hasRecentApproachConfigurationData = approachConfigurationAge >= 0
          && approachConfigurationAge <= APPROACH_CONFIGURATION_FRESH_MS;
        const hasGoAroundPhaseShape = candidatePhase === PHASES.CLIMB && (
          previousPhase === PHASES.APPROACH
          || previousPhase === PHASES.LANDING
          || (
            previousPhase === PHASES.DESCENT
            && hasRecentApproachContext
            && recentApproachLikePhase !== null
            && GO_AROUND_ARMING_PHASES.has(recentApproachLikePhase)
          )
        );
        // Radio altitude follows the terrain beneath the aircraft. Over hills it can
        // therefore make an ordinary en-route descent look like an approach, and a
        // subsequent climb look like a go-around. When configuration telemetry is
        // available, require evidence that landing configuration (gear or flaps) was
        // present during the recent approach context. A prior LANDING phase
        // remains definitive, and installations without configuration telemetry
        // retain the legacy phase-only behavior.
        const hasLandingIntent = previousPhase === PHASES.LANDING
          || !hasRecentApproachConfigurationData
          || hasRecentConfiguredApproach;
        const isGoAround = hasGoAroundPhaseShape && hasLandingIntent;

        if (hasGoAroundPhaseShape && !hasLandingIntent) {
          Debug.log('phase', 'Go-around suppressed: no recent landing-configuration evidence', {
            previousPhase,
            ra_ft: raFtValue,
            ias_kts: iasKnots,
            vs_fpm: vsFpmValue,
            approach_configured: approachConfiguredValue,
            approach_configuration_age_ms: Number.isFinite(approachConfigurationAge)
              ? approachConfigurationAge
              : null,
            recent_configured_approach_age_ms: Number.isFinite(recentConfiguredApproachAge)
              ? recentConfiguredApproachAge
              : null,
          });
        }

        const timeSinceTouchdown = lastTouchdownTs > 0
          ? nowTs - lastTouchdownTs
          : Number.POSITIVE_INFINITY;
        const withinTimeWindow = timeSinceTouchdown >= 0 && timeSinceTouchdown < TOUCH_AND_GO_WINDOW_MS;
        const gsDataAvailable = minGsDuringLastWow < Number.POSITIVE_INFINITY;
        const aircraftSlowedDown = gsDataAvailable && minGsDuringLastWow < BOUNCE_GS_THRESHOLD_KTS;
        const isTouchAndGo = withinTimeWindow && aircraftSlowedDown;
        const shouldEnterGoAroundPhase = isGoAround && !isTouchAndGo && !goAroundRecordedThisApproach;
        const nextPhase = shouldEnterGoAroundPhase ? PHASES.GO_AROUND : candidatePhase;

        flightPhase = nextPhase;
        lastChangeTs = nowTs;
        changed = true;

        if (flightPhase !== PHASES.DESCENT) {
          descentEntryAltMsl = null;
        }

        if (isGoAround && !goAroundRecordedThisApproach) {
          if (isTouchAndGo) {
            Debug.log('phase', 'Go-around suppressed (touch-and-go)', {
              previousPhase,
              timeSinceTouchdown_ms: timeSinceTouchdown,
              threshold_ms: TOUCH_AND_GO_WINDOW_MS,
              minGsDuringLastWow_kts: minGsDuringLastWow,
              bounce_gs_threshold_kts: BOUNCE_GS_THRESHOLD_KTS,
            });
          } else {
            goAroundRecordedThisApproach = true;

            const goAroundPayload = {
              aircraft: lastAircraftName || 'Unknown',
              altitude_ft: raFtValue,
              ias_kts: iasKnots,
              vs_fpm: vsFpmValue,
              previous_phase: previousPhase,
              armed_from_phase: recentApproachLikePhase,
            };

            try {
              eventBus.emit('phase:goAround', goAroundPayload);
              Debug.log('phase', 'Go-around event emitted', goAroundPayload);
            } catch (error) {
              Debug.log('phase', 'Failed to emit go-around event', { error: toErrorMessage(error) });
            }
          }
        }

        if (candidatePhase === PHASES.APPROACH) {
          goAroundRecordedThisApproach = false;
        }

        if (previousPhase === PHASES.GO_AROUND && flightPhase === PHASES.CLIMB) {
          goAroundRecordedThisApproach = false;
        }

        if (
          flightPhase === PHASES.PARKED
          || flightPhase === PHASES.TAKEOFF
          || flightPhase === PHASES.CRUISE
          || flightPhase === PHASES.GO_AROUND
        ) {
          recentApproachLikeTs = 0;
          recentApproachLikePhase = null;
          recentConfiguredApproachTs = 0;
        }

        if (flightPhase === PHASES.PARKED || flightPhase === PHASES.TAKEOFF) {
          taxiInEligible = false;
        }

        if (flightPhase === PHASES.TAKEOFF && previousPhase !== PHASES.TAKEOFF) {
          takeoffTs = nowTs;
          Debug.log('phase', 'Takeoff timestamp set for cruise lockout', {
            takeoffTs,
            lockout_ms: MIN_FLIGHT_TIME_FOR_CRUISE_MS,
          });
        }
        if (flightPhase === PHASES.PARKED) {
          takeoffTs = 0;
        }

        try {
          broadcast({ type: MSG.PHASE, value: flightPhase });
        } catch (error) {
          Debug.log('phase', 'broadcast error', { error: toErrorMessage(error) });
        }

        if (CONSOLE_DEBUG) {
          if (!lastPhaseLogTs || (nowTs - lastPhaseLogTs) > 250) {
            lastPhaseLogTs = nowTs;
            console.log('[phase] Phase changed', {
              phase: flightPhase,
              measured,
              ias_kts: iasKnots,
              vs_fpm: vsFpmValue,
              ra_ft: raFtValue,
              gs_kts: gs,
              on_runway: onRunwayValue,
            });
          }
        }

        try {
          Debug.log('phase', 'Phase changed', {
            phase: flightPhase,
            measured,
            ias_kts: iasKnots,
            vs_fpm: vsFpmValue,
            ra_ft: raFtValue,
            gs_kts: gs,
            on_runway: onRunwayValue,
          });
        } catch {}
      }
    }

    return { phase: flightPhase, changed };
  }

  return {
    updatePhase,
    getPhase,
    reset,
    getState,
  };
}

const defaultInstance = createPhaseRunner();

module.exports = {
  createPhaseRunner,
  updatePhase: defaultInstance.updatePhase,
  getPhase: defaultInstance.getPhase,
  resetPhaseRunner: defaultInstance.reset,
  PHASES,
  ALLOWED_TRANSITIONS,
};

export {};
