// Centralized flight lifecycle logic for simbridge-core.
//
// This module is the single source of truth for lifecycle states,
// in-flight context, flight-start eligibility, and supporting motion helpers.

const Debug = require('../core/debug.js') as {
  log: (scope: string, message: string, extra?: Record<string, unknown>) => void;
};

export const LifecycleState = Object.freeze({
  IDLE: 'IDLE',
  CONNECTED: 'CONNECTED',
  IN_MENU: 'IN_MENU',
  WARMUP: 'WARMUP',
  READY: 'READY',
  ACTIVE: 'ACTIVE',
  COOLDOWN: 'COOLDOWN',
} as const);

export type LifecycleStateValue = (typeof LifecycleState)[keyof typeof LifecycleState];

export type InFlightContextResult = {
  inFlightContext: boolean;
  reason: string;
};

export type ComputeInFlightContextParams = {
  simconnectConnected: boolean;
  simRunning?: boolean | null;
  userInputEnabled?: boolean | null;
  aircraftLoadedName?: string | null;
  paused?: boolean;
};

export type EligibilityResult = {
  eligible: boolean;
  state: LifecycleStateValue;
  blockers: string[];
  checks: Record<string, unknown>;
};

export type CheckFlightStartEligibilityParams = {
  flightActive?: boolean;
  lastFlightEndMs?: number | null;
  nowEpochMs?: number;
  simconnectConnected?: boolean;
  inFlightContext?: boolean;
  altMslFt?: number | null;
  iasKnots?: number | null;
  gsKnots?: number | null;
  raFeet?: number | null;
  wow?: boolean;
  slewActive?: boolean;
  motionDetected?: boolean;
  activeFieldCount?: number;
  cooldownMs?: number;
  maxAltMslFt?: number;
  minIasKts?: number;
  minGsKts?: number;
  minRaFt?: number;
  requireCount?: number;
  requireMovement?: boolean;
  requireTelemetryActivity?: boolean;
  minActiveFields?: number;
  blockOnSlew?: boolean;
};

export type ManualAutoStartSuppressionState = {
  active: boolean;
  sinceMs: number | null;
  aircraftTitle: string | null;
  parkedResetSinceMs: number | null;
  contextResetSinceMs: number | null;
};

export type UpdateManualAutoStartSuppressionParams = {
  suppression?: ManualAutoStartSuppressionState | null;
  nowEpochMs?: number;
  simconnectConnected?: boolean;
  inFlightContext?: boolean;
  aircraftTitle?: string | null;
  phase?: string | null;
  wow?: boolean;
  iasKnots?: number | null;
  gsKnots?: number | null;
  anyEngineRunning?: boolean | null;
  maxEnginePct?: number | null;
  parkedResetDwellMs?: number;
  contextResetDwellMs?: number;
  stoppedGsKts?: number;
  stoppedIasKts?: number;
  engineOffMaxPct?: number;
};

export type UpdateManualAutoStartSuppressionResult = {
  suppression: ManualAutoStartSuppressionState;
  suppressed: boolean;
  cleared: boolean;
  clearReason: string | null;
  blockers: string[];
};

export type MotionBaseline = {
  ts: number;
  ias: number;
  gs: number;
} | null;

export type MotionDebug = {
  ageMs: number;
  baseline: Exclude<MotionBaseline, null>;
  now: Exclude<MotionBaseline, null>;
  dIas: number;
  dGs: number;
} | null;

export type UpdateMotionDetectorParams = {
  flightActive: boolean;
  requireMovement: boolean;
  windowMs: number;
  minIasDeltaKts: number;
  minGsDeltaKts: number;
  nowEpochMs: number;
  iasKnots?: number | null;
  gs?: number | null;
  baseline?: MotionBaseline;
};

export type UpdateMotionDetectorResult = {
  telemetryValidForMotion: boolean;
  baseline: MotionBaseline;
  motionOverWindow: boolean;
  motionDebug: MotionDebug;
};

export type ActiveFlightEndGuardState = {
  lastSimconnectConnectedMs: number | null;
  simconnectDisconnectedSinceMs: number | null;
  simStoppedSinceMs: number | null;
  pendingReason: string | null;
};

export type UpdateActiveFlightEndGuardParams = {
  state?: Partial<ActiveFlightEndGuardState> | null;
  flightActive?: boolean;
  nowEpochMs?: number;
  simconnectConnected?: boolean;
  simRunning?: boolean | null;
  disconnectGraceMs?: number;
  simStoppedGraceMs?: number;
};

export type UpdateActiveFlightEndGuardResult = {
  state: ActiveFlightEndGuardState;
  pendingReasonStarted: string | null;
  pendingElapsedMs: number | null;
  endReason: string | null;
  endElapsedMs: number | null;
};

export type BuildFlightStartReasonParams = {
  flightId?: string | null;
  frame?: Record<string, unknown> | null;
  gs?: number | null;
  iasKnots?: number | null;
  wow?: boolean;
  raFeet?: number | null;
  engineLevels?: number[] | null;
  maxEngine?: number | null;
  requireMovement?: boolean;
  movementOk?: boolean;
  airStartOk?: boolean;
  airStartChecks?: Record<string, unknown> | null;
  motionOverWindow?: boolean;
  windowMs?: number;
  motionDebug?: MotionDebug;
  requireTelemetryActivity?: boolean;
  activeFieldCount?: number;
  minActiveFields?: number;
  telemetryActivityOk?: boolean;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteMsOrNull(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function normalizeActiveFlightEndGuardState(
  state?: Partial<ActiveFlightEndGuardState> | null,
): ActiveFlightEndGuardState {
  return {
    lastSimconnectConnectedMs: finiteMsOrNull(state?.lastSimconnectConnectedMs),
    simconnectDisconnectedSinceMs: finiteMsOrNull(state?.simconnectDisconnectedSinceMs),
    simStoppedSinceMs: finiteMsOrNull(state?.simStoppedSinceMs),
    pendingReason: typeof state?.pendingReason === 'string' && state.pendingReason
      ? state.pendingReason
      : null,
  };
}

function createInactiveManualAutoStartSuppression(): ManualAutoStartSuppressionState {
  return {
    active: false,
    sinceMs: null,
    aircraftTitle: null,
    parkedResetSinceMs: null,
    contextResetSinceMs: null,
  };
}

function normalizeAircraftTitle(value: unknown): string | null {
  const title = typeof value === 'string' ? value.trim() : '';
  return title || null;
}

export function computeInFlightContext({
  simconnectConnected,
  simRunning,
  userInputEnabled,
  aircraftLoadedName,
  paused = false,
}: ComputeInFlightContextParams): InFlightContextResult {
  if (!simconnectConnected) {
    return { inFlightContext: false, reason: 'simconnect_disconnected' };
  }
  if (simRunning === false) {
    return { inFlightContext: false, reason: 'sim_not_running' };
  }
  if (!aircraftLoadedName) {
    return { inFlightContext: false, reason: 'no_aircraft_loaded' };
  }
  if (userInputEnabled === false) {
    return { inFlightContext: false, reason: 'user_input_disabled' };
  }
  if (paused) {
    return { inFlightContext: false, reason: 'sim_paused' };
  }
  return { inFlightContext: true, reason: 'ok' };
}

export function updateActiveFlightEndGuard({
  state = null,
  flightActive = false,
  nowEpochMs = 0,
  simconnectConnected = false,
  simRunning = null,
  disconnectGraceMs = 5000,
  simStoppedGraceMs = disconnectGraceMs,
}: UpdateActiveFlightEndGuardParams): UpdateActiveFlightEndGuardResult {
  const current = normalizeActiveFlightEndGuardState(state);
  const now = isFiniteNumber(nowEpochMs) ? nowEpochMs : 0;
  const disconnectGrace = Math.max(0, isFiniteNumber(disconnectGraceMs) ? disconnectGraceMs : 0);
  const stoppedGrace = Math.max(0, isFiniteNumber(simStoppedGraceMs) ? simStoppedGraceMs : disconnectGrace);
  const connected = simconnectConnected === true;
  const stoppedWhileConnected = connected && simRunning === false;

  if (!flightActive) {
    return {
      state: {
        lastSimconnectConnectedMs: connected && !stoppedWhileConnected
          ? now
          : current.lastSimconnectConnectedMs,
        simconnectDisconnectedSinceMs: null,
        simStoppedSinceMs: null,
        pendingReason: null,
      },
      pendingReasonStarted: null,
      pendingElapsedMs: null,
      endReason: null,
      endElapsedMs: null,
    };
  }

  if (connected && !stoppedWhileConnected) {
    return {
      state: {
        lastSimconnectConnectedMs: now,
        simconnectDisconnectedSinceMs: null,
        simStoppedSinceMs: null,
        pendingReason: null,
      },
      pendingReasonStarted: null,
      pendingElapsedMs: null,
      endReason: null,
      endElapsedMs: null,
    };
  }

  if (!connected) {
    const sinceMs = current.simconnectDisconnectedSinceMs
      ?? current.lastSimconnectConnectedMs
      ?? now;
    const elapsedMs = Math.max(0, now - sinceMs);
    const endReason = elapsedMs >= disconnectGrace
      ? `simconnect_disconnect:${Math.round(elapsedMs / 1000)}s`
      : null;
    const pendingReason = endReason ? null : 'simconnect_disconnect';

    return {
      state: {
        lastSimconnectConnectedMs: current.lastSimconnectConnectedMs,
        simconnectDisconnectedSinceMs: sinceMs,
        simStoppedSinceMs: null,
        pendingReason,
      },
      pendingReasonStarted: pendingReason && current.pendingReason !== pendingReason
        ? pendingReason
        : null,
      pendingElapsedMs: endReason ? null : elapsedMs,
      endReason,
      endElapsedMs: endReason ? elapsedMs : null,
    };
  }

  const sinceMs = current.simStoppedSinceMs ?? now;
  const elapsedMs = Math.max(0, now - sinceMs);
  const endReason = elapsedMs >= stoppedGrace
    ? `sim_stopped:${Math.round(elapsedMs / 1000)}s`
    : null;
  const pendingReason = endReason ? null : 'sim_stopped';

  return {
    state: {
      lastSimconnectConnectedMs: current.lastSimconnectConnectedMs,
      simconnectDisconnectedSinceMs: null,
      simStoppedSinceMs: sinceMs,
      pendingReason,
    },
    pendingReasonStarted: pendingReason && current.pendingReason !== pendingReason
      ? pendingReason
      : null,
    pendingElapsedMs: endReason ? null : elapsedMs,
    endReason,
    endElapsedMs: endReason ? elapsedMs : null,
  };
}

export function updateManualAutoStartSuppression({
  suppression = null,
  nowEpochMs = 0,
  simconnectConnected = false,
  inFlightContext = false,
  aircraftTitle = null,
  phase = null,
  wow = true,
  iasKnots = null,
  gsKnots = null,
  anyEngineRunning = null,
  maxEnginePct = null,
  parkedResetDwellMs = 30000,
  contextResetDwellMs = 5000,
  stoppedGsKts = 1,
  stoppedIasKts = 5,
  engineOffMaxPct = 1,
}: UpdateManualAutoStartSuppressionParams): UpdateManualAutoStartSuppressionResult {
  if (!suppression?.active) {
    return {
      suppression: createInactiveManualAutoStartSuppression(),
      suppressed: false,
      cleared: false,
      clearReason: null,
      blockers: [],
    };
  }

  const current: ManualAutoStartSuppressionState = {
    active: true,
    sinceMs: isFiniteNumber(suppression.sinceMs) ? suppression.sinceMs : nowEpochMs,
    aircraftTitle: normalizeAircraftTitle(suppression.aircraftTitle),
    parkedResetSinceMs: isFiniteNumber(suppression.parkedResetSinceMs) ? suppression.parkedResetSinceMs : null,
    contextResetSinceMs: isFiniteNumber(suppression.contextResetSinceMs) ? suppression.contextResetSinceMs : null,
  };
  const title = normalizeAircraftTitle(aircraftTitle);
  const blockers: string[] = ['manual_stop_auto_start_suppressed'];

  if (current.aircraftTitle && title && title !== current.aircraftTitle) {
    return {
      suppression: createInactiveManualAutoStartSuppression(),
      suppressed: false,
      cleared: true,
      clearReason: 'aircraft_changed',
      blockers: [],
    };
  }

  const contextResetCandidate = simconnectConnected !== true || inFlightContext !== true;
  if (contextResetCandidate) {
    current.contextResetSinceMs = current.contextResetSinceMs ?? nowEpochMs;
    const contextResetElapsedMs = Math.max(0, nowEpochMs - current.contextResetSinceMs);
    if (contextResetElapsedMs >= contextResetDwellMs) {
      return {
        suppression: createInactiveManualAutoStartSuppression(),
        suppressed: false,
        cleared: true,
        clearReason: 'context_reset',
        blockers: [],
      };
    }
    blockers.push(`context_reset_pending:${Math.ceil((contextResetDwellMs - contextResetElapsedMs) / 1000)}s`);
  } else {
    current.contextResetSinceMs = null;
  }

  const iasStopped = isFiniteNumber(iasKnots) && Math.abs(iasKnots) <= stoppedIasKts;
  const gsStopped = isFiniteNumber(gsKnots) && Math.abs(gsKnots) <= stoppedGsKts;
  const engineOff = anyEngineRunning === false
    || (isFiniteNumber(maxEnginePct) && maxEnginePct <= engineOffMaxPct);
  const parkedResetCandidate = phase === 'PARKED' && wow === true && iasStopped && gsStopped && engineOff;

  if (parkedResetCandidate) {
    current.parkedResetSinceMs = current.parkedResetSinceMs ?? nowEpochMs;
    const parkedResetElapsedMs = Math.max(0, nowEpochMs - current.parkedResetSinceMs);
    if (parkedResetElapsedMs >= parkedResetDwellMs) {
      return {
        suppression: createInactiveManualAutoStartSuppression(),
        suppressed: false,
        cleared: true,
        clearReason: 'parked_engines_off',
        blockers: [],
      };
    }
    blockers.push(`parked_reset_pending:${Math.ceil((parkedResetDwellMs - parkedResetElapsedMs) / 1000)}s`);
  } else {
    current.parkedResetSinceMs = null;
  }

  return {
    suppression: current,
    suppressed: true,
    cleared: false,
    clearReason: null,
    blockers,
  };
}

export function checkFlightStartEligibility({
  flightActive = false,
  lastFlightEndMs = null,
  nowEpochMs = 0,
  simconnectConnected = false,
  inFlightContext = false,
  altMslFt = null,
  iasKnots = null,
  gsKnots = null,
  raFeet = null,
  wow = true,
  slewActive = false,
  motionDetected = false,
  activeFieldCount = 0,
  cooldownMs = 30000,
  maxAltMslFt = 60000,
  minIasKts = 30,
  minGsKts = 5,
  minRaFt = 50,
  requireCount = 2,
  requireMovement = true,
  requireTelemetryActivity = true,
  minActiveFields = 5,
  blockOnSlew = true,
}: CheckFlightStartEligibilityParams): EligibilityResult {
  const blockers: string[] = [];
  const checks: Record<string, unknown> = {};

  if (flightActive) {
    return {
      eligible: false,
      state: LifecycleState.ACTIVE,
      blockers: ['already_active'],
      checks: { flightActive: true },
    };
  }

  const cooldownElapsed = !lastFlightEndMs || (nowEpochMs - lastFlightEndMs) >= cooldownMs;
  checks.cooldownElapsed = cooldownElapsed;
  if (!cooldownElapsed) {
    const remainingMs = cooldownMs - (nowEpochMs - lastFlightEndMs);
    blockers.push(`cooldown:${Math.round(remainingMs / 1000)}s_remaining`);
    return {
      eligible: false,
      state: LifecycleState.COOLDOWN,
      blockers,
      checks,
    };
  }

  checks.simconnectConnected = simconnectConnected;
  if (!simconnectConnected) {
    blockers.push('simconnect_disconnected');
    return {
      eligible: false,
      state: LifecycleState.IDLE,
      blockers,
      checks,
    };
  }

  const isGlobeView = isFiniteNumber(altMslFt) && altMslFt > maxAltMslFt;
  checks.isGlobeView = isGlobeView;
  if (isGlobeView) {
    blockers.push(`globe_view:alt=${Math.round(altMslFt)}ft`);
    return {
      eligible: false,
      state: LifecycleState.IN_MENU,
      blockers,
      checks,
    };
  }

  checks.inFlightContext = inFlightContext;
  if (!inFlightContext) {
    blockers.push('in_menu_or_paused');
    return {
      eligible: false,
      state: LifecycleState.IN_MENU,
      blockers,
      checks,
    };
  }

  checks.slewActive = slewActive;
  if (blockOnSlew && slewActive) {
    blockers.push('slew_mode_active');
  }

  checks.activeFieldCount = activeFieldCount;
  checks.minActiveFields = minActiveFields;
  const telemetryActivityOk = !requireTelemetryActivity || activeFieldCount >= minActiveFields;
  checks.telemetryActivityOk = telemetryActivityOk;
  if (!telemetryActivityOk) {
    blockers.push(`telemetry_inactive:${activeFieldCount}/${minActiveFields}_fields`);
  }

  const iasOk = isFiniteNumber(iasKnots) && iasKnots >= minIasKts;
  const gsOk = isFiniteNumber(gsKnots) && gsKnots >= minGsKts;
  const raOk = isFiniteNumber(raFeet) && raFeet >= minRaFt;
  const airStartChecks = { iasOk, gsOk, raOk };
  const airStartCount = [iasOk, gsOk, raOk].filter(Boolean).length;
  const airStartOk = !wow && gsOk && airStartCount >= requireCount;
  checks.airStart = { ...airStartChecks, count: airStartCount, required: requireCount, ok: airStartOk };

  const movementOk = !requireMovement || (motionDetected && inFlightContext);
  checks.movement = { required: requireMovement, detected: motionDetected, ok: movementOk };

  const startConditionMet = movementOk || airStartOk;
  checks.startConditionMet = startConditionMet;

  if (!startConditionMet) {
    if (requireMovement && !motionDetected) {
      blockers.push('waiting_for_movement');
    }
    if (!airStartOk && !wow) {
      blockers.push(`airborne_but_insufficient:${airStartCount}/${requireCount}_checks`);
    }
    if (wow && !motionDetected) {
      blockers.push('on_ground_no_movement');
    }
  }

  const eligible = startConditionMet && telemetryActivityOk && !(blockOnSlew && slewActive);

  return {
    eligible,
    state: LifecycleState.READY,
    blockers,
    checks,
  };
}

let lastLoggedState: string | null = null;
let lastLoggedBlockers: string | null = null;

export function logStateTransition(state: string, blockers: string[] = [], verbose = false): void {
  const blockersKey = blockers.slice().sort().join(',');
  const stateChanged = state !== lastLoggedState;
  const blockersChanged = blockersKey !== lastLoggedBlockers;

  if (stateChanged || (verbose && blockersChanged)) {
    const arrow = lastLoggedState ? `${lastLoggedState} -> ${state}` : `-> ${state}`;
    const blockerStr = blockers.length > 0 ? ` [${blockers.join(', ')}]` : '';

    Debug.log('lifecycle', arrow + blockerStr, {
      previousState: lastLoggedState,
      currentState: state,
      blockers,
    });

    if (stateChanged) {
      console.log(`[lifecycle] ${arrow}${blockerStr}`);
    }

    lastLoggedState = state;
    lastLoggedBlockers = blockersKey;
  }
}

export function resetStateLogger(): void {
  lastLoggedState = null;
  lastLoggedBlockers = null;
}

export function updateMotionDetector({
  flightActive,
  requireMovement,
  windowMs,
  minIasDeltaKts: _minIasDeltaKts,
  minGsDeltaKts,
  nowEpochMs,
  iasKnots = null,
  gs = null,
  baseline = null,
}: UpdateMotionDetectorParams): UpdateMotionDetectorResult {
  const hasIas = isFiniteNumber(iasKnots);
  const hasGs = isFiniteNumber(gs);
  const telemetryValidForMotion = hasGs;

  let motionOverWindow = false;
  let motionDebug: MotionDebug = null;
  let nextBaseline = baseline;

  if (!flightActive && requireMovement && windowMs > 0 && telemetryValidForMotion) {
    const snap = {
      ts: nowEpochMs,
      ias: Math.round((hasIas ? iasKnots : 0) * 10) / 10,
      gs: Math.round((hasGs ? gs : 0) * 10) / 10,
    };

    if (!nextBaseline) {
      nextBaseline = snap;
    } else {
      const ageMs = snap.ts - nextBaseline.ts;
      const dIas = snap.ias - nextBaseline.ias;
      const dGs = snap.gs - nextBaseline.gs;

      const sustainedGroundMovement = snap.gs >= minGsDeltaKts;
      motionOverWindow = ageMs >= windowMs && (
        Math.abs(dGs) >= minGsDeltaKts
        || sustainedGroundMovement
      );
      motionDebug = { ageMs, baseline: nextBaseline, now: snap, dIas, dGs };

      if (ageMs >= windowMs) {
        nextBaseline = snap;
      }
    }
  } else if (!flightActive) {
    nextBaseline = telemetryValidForMotion ? nextBaseline : null;
  }

  return {
    telemetryValidForMotion,
    baseline: nextBaseline,
    motionOverWindow,
    motionDebug,
  };
}

export function buildFlightStartReason({
  flightId = null,
  frame = null,
  gs = null,
  iasKnots = null,
  wow = false,
  raFeet = null,
  engineLevels = null,
  maxEngine = null,
  requireMovement = false,
  movementOk = false,
  airStartOk = false,
  airStartChecks = null,
  motionOverWindow = false,
  windowMs = 0,
  motionDebug = null,
  requireTelemetryActivity = false,
  activeFieldCount = 0,
  minActiveFields = 0,
  telemetryActivityOk = false,
}: BuildFlightStartReasonParams): Record<string, unknown> {
  const simconnect = frame && typeof frame === 'object'
    ? (frame as { simconnect?: Record<string, unknown> }).simconnect
    : null;
  const sc = simconnect && typeof simconnect === 'object' ? simconnect : null;

  return {
    flightId,
    source: 'simconnect+telemetry',
    simconnect: sc
      ? {
          available: !!sc.available,
          connected: !!sc.connected,
          inFlightContext: !!sc.inFlightContext,
          inFlightContextAt: typeof sc.inFlightContextAt === 'string' ? sc.inFlightContextAt : null,
          inFlightContextSource: typeof sc.inFlightContextSource === 'string' ? sc.inFlightContextSource : null,
          lastEvent: typeof sc.lastEvent === 'string' ? sc.lastEvent : null,
          lastEventAt: typeof sc.lastEventAt === 'string' ? sc.lastEventAt : null,
        }
      : null,
    movementRequired: requireMovement,
    movementOk,
    airStartOk: !!airStartOk,
    airStartChecks: airStartChecks || null,
    motionOverWindow,
    movementWindowMs: windowMs,
    movementDeltas: motionDebug,
    movement: {
      gs_kts: isFiniteNumber(gs) ? gs : null,
      ias_kts: isFiniteNumber(iasKnots) ? iasKnots : null,
      wow: !!wow,
    },
    engines: {
      levels: engineLevels,
      max: maxEngine,
    },
    ra_ft: isFiniteNumber(raFeet) ? raFeet : null,
    telemetryActivity: {
      required: requireTelemetryActivity,
      activeFieldCount,
      minActiveFields,
      ok: telemetryActivityOk,
    },
  };
}
