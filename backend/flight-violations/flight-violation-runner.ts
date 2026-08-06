import type { ViolationRuleId, ViolationRuleMap } from '../../shared/violation-rules';

'use strict';

type Severity = 'warning' | 'critical';

type RuleId = ViolationRuleId;

type ConfigModule = {
  violationThresholds: {
    upsetHysteresisDeg: number;
    upsetMinDurationMs: number;
    gForceHysteresis: number;
    gForceAdvisoryG: number;
    gForceHighG: number;
    gForceNegativeG: number;
    approachOverspeedBufferKts: number;
    approachOverspeedHysteresisKts: number;
    approachOverspeedMinDurationMs: number;
  };
};

type EventBusModule = {
  emit: (event: string, payload: unknown) => void;
};

type TimelineModule = {
  startViolation: (ruleId: string, severity: Severity, metrics: ViolationMetrics) => void;
  endViolation: (ruleId: string, scoreImpact: number | null) => void;
  VIOLATION_RULE: ViolationRuleMap;
};

type MessageTypesModule = {
  MSG: {
    FLIGHT_VIOLATION: string;
  };
};

type PhasesModule = {
  PHASES: {
    APPROACH: string;
  };
  GROUND_PHASES: Set<string>;
};

type BroadcastFn = (payload: Record<string, unknown>) => void;

type DisplayFrame = {
  pitchDeg?: number;
  bankDeg?: number;
  iasKts?: number;
  vsFpm?: number;
  raFt?: number;
};

type FdmFrame = {
  gForce?: number;
};

type TelemetryFrame = {
  display?: DisplayFrame | null;
  pitch?: number | null;
  bank?: number | null;
  gforce?: number | null;
  gForce?: number | null;
  ias?: number | null;
  vs?: number | null;
  ra?: number | null;
  wow?: unknown;
  fdm?: FdmFrame | null;
};

type TimeContext = {
  nowEpochMs: number;
  nowIso: string;
};

type FlightCsvWriter = {
  isRecording: () => boolean;
  writeEvent: (eventType: string, payload: Record<string, unknown>) => void;
};

type UpdateContext = {
  phase?: string | null;
  flightCsvWriter?: FlightCsvWriter | null;
  warmup?: boolean | null;
};

type ViolationMetrics = {
  pitchDeg?: number | null;
  bankDeg?: number | null;
  gForce?: number | null;
  iasKts?: number | null;
  maxApproachKts?: number | null;
  approachOverspeedLimitKts?: number | null;
  approachOverspeedBufferKts?: number | null;
  approachOverspeedExcessKts?: number | null;
  spoilerPct?: number | null;
  spoilerState?: string | null;
  raFt?: number | null;
  vsFpm?: number | null;
  durationMs?: number;
};

type RuleMetadata = {
  countsAsUpset?: boolean;
};

type RuleState = {
  active: boolean;
  startMs: number | null;
  announced: boolean;
};

type AttitudeRule = {
  id: RuleId;
  label: string;
  severity: Severity;
  minDurationMs?: number;
  countsAsUpset?: boolean;
  check: (pitchDeg: number, bankDeg: number) => boolean;
  clear: (pitchDeg: number, bankDeg: number) => boolean;
  checkG?: never;
  clearG?: never;
};

type GForceRule = {
  id: RuleId;
  label: string;
  severity: Severity;
  minDurationMs?: number;
  countsAsUpset?: boolean;
  checkG: (gForce: number) => boolean;
  clearG: (gForce: number) => boolean;
  check?: never;
  clear?: never;
};

type FrameRule = {
  id: RuleId;
  label: string;
  severity: Severity;
  minDurationMs?: number;
  countsAsUpset?: boolean;
  checkFrame: (frame: TelemetryFrame, phase: string | null) => boolean;
  clearFrame: (frame: TelemetryFrame, phase: string | null) => boolean;
  metricsFrame: (frame: TelemetryFrame) => ViolationMetrics;
  check?: never;
  clear?: never;
  checkG?: never;
  clearG?: never;
};

type RuleDefinition = AttitudeRule | GForceRule | FrameRule;
type PhaseThresholds = {
  approach_max_ra_ft: number;
  approach_min_vs_fpm: number;
  max_approach_kts: number;
};
type PhaseModule = {
  getEffectivePhaseThresholds: () => PhaseThresholds;
};

const config = require('../core/config') as ConfigModule;
const eventBus = require('../core/event-bus') as EventBusModule;
const timeline = require('../events/timeline-events') as TimelineModule;
const { MSG } = require('../core/message-types') as MessageTypesModule;
const { PHASES, GROUND_PHASES } = require('../lifecycle/phases') as PhasesModule;
const { getEffectivePhaseThresholds } = require('../lifecycle/phase') as PhaseModule;
const { VIOLATION_RULE } = timeline;

const SUPPRESSED_PHASES = GROUND_PHASES;
const HYSTERESIS_DEG = config.violationThresholds.upsetHysteresisDeg;
const MIN_VIOLATION_DURATION_MS = config.violationThresholds.upsetMinDurationMs;
const G_HYSTERESIS = config.violationThresholds.gForceHysteresis;
const GFORCE_HIGH_G = Number.isFinite(config.violationThresholds.gForceHighG)
  ? config.violationThresholds.gForceHighG
  : 2.5;
const GFORCE_NEGATIVE_G = Number.isFinite(config.violationThresholds.gForceNegativeG)
  ? config.violationThresholds.gForceNegativeG
  : -0.3;
const CONFIGURED_GFORCE_ADVISORY_G = Number.isFinite(config.violationThresholds.gForceAdvisoryG)
  ? config.violationThresholds.gForceAdvisoryG
  : 1.8;
const GFORCE_ADVISORY_G = Math.max(
  1,
  Math.min(CONFIGURED_GFORCE_ADVISORY_G, GFORCE_HIGH_G - G_HYSTERESIS),
);
const APPROACH_OVERSPEED_BUFFER_KTS = Math.max(
  0,
  Number.isFinite(config.violationThresholds.approachOverspeedBufferKts)
    ? config.violationThresholds.approachOverspeedBufferKts
    : 20,
);
const APPROACH_OVERSPEED_HYSTERESIS_KTS = Math.max(
  0,
  Number.isFinite(config.violationThresholds.approachOverspeedHysteresisKts)
    ? config.violationThresholds.approachOverspeedHysteresisKts
    : 10,
);
const APPROACH_OVERSPEED_MIN_DURATION_MS = Math.max(
  0,
  Number.isFinite(config.violationThresholds.approachOverspeedMinDurationMs)
    ? config.violationThresholds.approachOverspeedMinDurationMs
    : 2000,
);

const UPSET_RULE = Object.freeze({
  PITCH_NOSE_UP: VIOLATION_RULE.UPSET_PITCH_NOSE_UP,
  PITCH_NOSE_DOWN: VIOLATION_RULE.UPSET_PITCH_NOSE_DOWN,
  BANK: VIOLATION_RULE.UPSET_BANK,
  GFORCE_HIGH: VIOLATION_RULE.GFORCE_HIGH,
  GFORCE_NEGATIVE: VIOLATION_RULE.GFORCE_NEGATIVE,
} as const);

const LOAD_FACTOR_RULE = Object.freeze({
  ADVISORY: VIOLATION_RULE.LOAD_FACTOR_ADVISORY,
} as const);

const APPROACH_SPEED_RULE = Object.freeze({
  APPROACH_OVERSPEED: VIOLATION_RULE.APPROACH_OVERSPEED,
} as const);

function countsAsUpset(rule: RuleMetadata): boolean {
  return rule.countsAsUpset !== false;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function currentIasKts(frame: TelemetryFrame): number | null {
  const displayIas = finiteNumberOrNull(frame.display?.iasKts);
  if (displayIas !== null) return displayIas;
  return finiteNumberOrNull(frame.ias);
}

function currentVsFpm(frame: TelemetryFrame): number | null {
  const displayVs = finiteNumberOrNull(frame.display?.vsFpm);
  if (displayVs !== null) return displayVs;
  return finiteNumberOrNull(frame.vs);
}

function currentRaFt(frame: TelemetryFrame): number | null {
  const displayRa = finiteNumberOrNull(frame.display?.raFt);
  if (displayRa !== null) return displayRa;
  return finiteNumberOrNull(frame.ra);
}

function getApproachOverspeedMetrics(frame: TelemetryFrame): ViolationMetrics | null {
  const iasKts = currentIasKts(frame);
  const vsFpm = currentVsFpm(frame);
  const raFt = currentRaFt(frame);
  if (iasKts === null || vsFpm === null || raFt === null || iasKts < 0) {
    return null;
  }

  const thresholds = getEffectivePhaseThresholds();
  const maxApproachKts = finiteNumberOrNull(thresholds.max_approach_kts);
  const approachMaxRaFt = finiteNumberOrNull(thresholds.approach_max_ra_ft);
  const approachMinVsFpm = finiteNumberOrNull(thresholds.approach_min_vs_fpm);
  if (
    maxApproachKts === null
    || maxApproachKts <= 0
    || approachMaxRaFt === null
    || approachMinVsFpm === null
  ) {
    return null;
  }

  const inApproachGate = raFt <= approachMaxRaFt && vsFpm < -approachMinVsFpm;
  if (!inApproachGate) {
    return null;
  }

  const approachOverspeedLimitKts = maxApproachKts + APPROACH_OVERSPEED_BUFFER_KTS;
  return {
    iasKts,
    maxApproachKts,
    approachOverspeedLimitKts,
    approachOverspeedBufferKts: APPROACH_OVERSPEED_BUFFER_KTS,
    approachOverspeedExcessKts: Math.max(0, iasKts - approachOverspeedLimitKts),
    raFt,
    vsFpm,
  };
}

function isApproachOverspeed(frame: TelemetryFrame, phase: string | null): boolean {
  if (phase !== PHASES.APPROACH) {
    return false;
  }
  const metrics = getApproachOverspeedMetrics(frame);
  return (
    metrics !== null
    && metrics.iasKts != null
    && metrics.approachOverspeedLimitKts != null
    && metrics.iasKts > metrics.approachOverspeedLimitKts
  );
}

function isApproachOverspeedCleared(frame: TelemetryFrame, phase: string | null): boolean {
  if (phase !== PHASES.APPROACH) {
    return true;
  }
  const metrics = getApproachOverspeedMetrics(frame);
  if (metrics === null) return true;
  const clearLimit = (metrics.approachOverspeedLimitKts ?? 0) - APPROACH_OVERSPEED_HYSTERESIS_KTS;
  return (metrics.iasKts ?? 0) < Math.max(metrics.maxApproachKts ?? 0, clearLimit);
}

const RULES: RuleDefinition[] = [
  {
    id: UPSET_RULE.PITCH_NOSE_UP,
    label: 'Pitch upset (nose-up > 25 deg)',
    severity: 'critical',
    check: (pitchDeg) => pitchDeg > 25,
    clear: (pitchDeg) => pitchDeg < (25 - HYSTERESIS_DEG),
  },
  {
    id: UPSET_RULE.PITCH_NOSE_DOWN,
    label: 'Pitch upset (nose-down > 10 deg)',
    severity: 'critical',
    check: (pitchDeg) => pitchDeg < -10,
    clear: (pitchDeg) => pitchDeg > -(10 - HYSTERESIS_DEG),
  },
  {
    id: UPSET_RULE.BANK,
    label: 'Bank upset (> 45 deg)',
    severity: 'critical',
    check: (_pitchDeg, bankDeg) => Math.abs(bankDeg) > 45,
    clear: (_pitchDeg, bankDeg) => Math.abs(bankDeg) < (45 - HYSTERESIS_DEG),
  },
  {
    id: LOAD_FACTOR_RULE.ADVISORY,
    label: `Load factor advisory (> ${GFORCE_ADVISORY_G} g)`,
    severity: 'warning',
    countsAsUpset: false,
    checkG: (gForce) => gForce > GFORCE_ADVISORY_G && gForce <= GFORCE_HIGH_G,
    clearG: (gForce) => gForce < (GFORCE_ADVISORY_G - G_HYSTERESIS) || gForce > GFORCE_HIGH_G,
  },
  {
    id: UPSET_RULE.GFORCE_HIGH,
    label: `High load factor (> ${GFORCE_HIGH_G} g)`,
    severity: 'warning',
    checkG: (gForce) => gForce > GFORCE_HIGH_G,
    clearG: (gForce) => gForce < (GFORCE_HIGH_G - G_HYSTERESIS),
  },
  {
    id: UPSET_RULE.GFORCE_NEGATIVE,
    label: `Negative G (< ${GFORCE_NEGATIVE_G} g)`,
    severity: 'warning',
    checkG: (gForce) => gForce < GFORCE_NEGATIVE_G,
    clearG: (gForce) => gForce > (GFORCE_NEGATIVE_G + G_HYSTERESIS),
  },
  {
    id: APPROACH_SPEED_RULE.APPROACH_OVERSPEED,
    label: `Approach overspeed (> max approach + ${APPROACH_OVERSPEED_BUFFER_KTS} kt)`,
    severity: 'warning',
    minDurationMs: APPROACH_OVERSPEED_MIN_DURATION_MS,
    checkFrame: isApproachOverspeed,
    clearFrame: isApproachOverspeedCleared,
    metricsFrame: (frame) => getApproachOverspeedMetrics(frame) || {},
  },
];

function createFlightViolationRunner(): {
  update: (
    frame: TelemetryFrame,
    broadcast: BroadcastFn,
    timeCtx: TimeContext,
    ctx?: UpdateContext,
  ) => void;
  reset: () => void;
} {
  const state = {} as Record<RuleId, RuleState>;
  for (const rule of RULES) {
    state[rule.id] = { active: false, startMs: null, announced: false };
  }

  let flightCsvWriter: FlightCsvWriter | null = null;

  function pitchDeg(frame: TelemetryFrame): number | null {
    if (frame.display && typeof frame.display.pitchDeg === 'number') {
      return frame.display.pitchDeg;
    }
    if (typeof frame.pitch === 'number') {
      return frame.pitch * (180 / Math.PI);
    }
    return null;
  }

  function bankDeg(frame: TelemetryFrame): number | null {
    if (frame.display && typeof frame.display.bankDeg === 'number') {
      return frame.display.bankDeg;
    }
    if (typeof frame.bank === 'number') {
      return frame.bank * (180 / Math.PI);
    }
    return null;
  }

  function isOnGround(frame: TelemetryFrame): boolean {
    return Boolean(frame.wow);
  }

  function gForceCurrent(frame: TelemetryFrame): number | null {
    if (frame.fdm && typeof frame.fdm.gForce === 'number') {
      return frame.fdm.gForce;
    }
    if (typeof frame.gForce === 'number') {
      return frame.gForce;
    }
    if (typeof frame.gforce === 'number') {
      return frame.gforce;
    }
    return null;
  }

  function isPhaseSuppressed(phase: string | null | undefined): boolean {
    return !phase || SUPPRESSED_PHASES.has(phase);
  }

  function onViolationStart(
    rule: RuleDefinition,
    metrics: ViolationMetrics,
    broadcast: BroadcastFn,
    nowMs: number,
    nowIso: string,
  ): void {
    const payload = {
      type: MSG.FLIGHT_VIOLATION,
      event: 'start',
      rule_id: rule.id,
      label: rule.label,
      severity: rule.severity,
      counts_as_upset: countsAsUpset(rule),
      metrics,
      timestamp_ms: nowMs,
      timestamp_utc: nowIso,
    };

    broadcast(payload);
    eventBus.emit('flightViolation:start', payload);
    timeline.startViolation(rule.id, rule.severity, metrics);

    if (flightCsvWriter && flightCsvWriter.isRecording()) {
      flightCsvWriter.writeEvent('FLIGHT_VIOLATION_START', {
        event_id: `${rule.id}-${nowMs}`,
        rule_id: rule.id,
        label: rule.label,
        severity: rule.severity,
        counts_as_upset: countsAsUpset(rule),
        pitch_deg: metrics.pitchDeg ?? null,
        bank_deg: metrics.bankDeg ?? null,
        gforce: metrics.gForce ?? null,
        ias_kts: metrics.iasKts ?? null,
        ra: metrics.raFt ?? null,
        ra_ft: metrics.raFt ?? null,
        vs: metrics.vsFpm ?? null,
        vs_fpm: metrics.vsFpm ?? null,
        spoilerPct: metrics.spoilerPct ?? null,
        spoilerState: metrics.spoilerState ?? null,
        max_approach_kts: metrics.maxApproachKts ?? null,
        approach_overspeed_limit_kts: metrics.approachOverspeedLimitKts ?? null,
        approach_overspeed_buffer_kts: metrics.approachOverspeedBufferKts ?? null,
        approach_overspeed_excess_kts: metrics.approachOverspeedExcessKts ?? null,
        timestamp_ms: nowMs,
        timestamp_utc: nowIso,
      });
    }

    if (metrics.iasKts != null) {
      console.log(
        `[APPROACH SPEED] ${rule.label} | ias=${metrics.iasKts.toFixed(0)}kt limit=${metrics.approachOverspeedLimitKts?.toFixed(0)}kt`,
      );
    } else if (metrics.gForce != null) {
      const prefix = countsAsUpset(rule) ? 'UPSET' : 'LOAD FACTOR';
      console.log(`[${prefix}] ${rule.label} | g=${metrics.gForce.toFixed(2)}g`);
    } else {
      console.log(
        `[UPSET] ${rule.label} | `
        + `pitch=${metrics.pitchDeg?.toFixed(1)}deg bank=${metrics.bankDeg?.toFixed(1)}deg`,
      );
    }
  }

  function onViolationEnd(
    rule: RuleDefinition,
    metrics: ViolationMetrics,
    broadcast: BroadcastFn,
    nowMs: number,
    nowIso: string,
  ): void {
    const payload = {
      type: MSG.FLIGHT_VIOLATION,
      event: 'end',
      rule_id: rule.id,
      label: rule.label,
      severity: rule.severity,
      counts_as_upset: countsAsUpset(rule),
      metrics,
      timestamp_ms: nowMs,
      timestamp_utc: nowIso,
    };

    broadcast(payload);
    eventBus.emit('flightViolation:end', payload);
    timeline.endViolation(rule.id, null);

    if (flightCsvWriter && flightCsvWriter.isRecording()) {
      flightCsvWriter.writeEvent('FLIGHT_VIOLATION_END', {
        event_id: `${rule.id}-end-${nowMs}`,
        rule_id: rule.id,
        label: rule.label,
        severity: rule.severity,
        counts_as_upset: countsAsUpset(rule),
        pitch_deg: metrics.pitchDeg ?? null,
        bank_deg: metrics.bankDeg ?? null,
        gforce: metrics.gForce ?? null,
        ias_kts: metrics.iasKts ?? null,
        ra: metrics.raFt ?? null,
        ra_ft: metrics.raFt ?? null,
        vs: metrics.vsFpm ?? null,
        vs_fpm: metrics.vsFpm ?? null,
        spoilerPct: metrics.spoilerPct ?? null,
        spoilerState: metrics.spoilerState ?? null,
        max_approach_kts: metrics.maxApproachKts ?? null,
        approach_overspeed_limit_kts: metrics.approachOverspeedLimitKts ?? null,
        approach_overspeed_buffer_kts: metrics.approachOverspeedBufferKts ?? null,
        approach_overspeed_excess_kts: metrics.approachOverspeedExcessKts ?? null,
        duration_ms: metrics.durationMs,
        timestamp_ms: nowMs,
        timestamp_utc: nowIso,
      });
    }

    const prefix = rule.id === APPROACH_SPEED_RULE.APPROACH_OVERSPEED
      ? 'APPROACH SPEED CLEAR'
      : (countsAsUpset(rule) ? 'UPSET CLEAR' : 'LOAD FACTOR CLEAR');
    console.log(`[${prefix}] ${rule.label} (duration: ${((metrics.durationMs || 0) / 1000).toFixed(1)}s)`);
  }

  function clearAllViolations(
    broadcast: BroadcastFn,
    nowMs: number,
    nowIso: string,
  ): void {
    for (const rule of RULES) {
      const ruleState = state[rule.id];
      if (ruleState.active && ruleState.announced) {
        const durationMs = ruleState.startMs == null ? 0 : nowMs - ruleState.startMs;
        const metrics = 'checkG' in rule
          ? { gForce: null, durationMs }
          : ('checkFrame' in rule
            ? { durationMs }
            : { pitchDeg: null, bankDeg: null, durationMs });
        onViolationEnd(rule, metrics, broadcast, nowMs, nowIso);
      }

      ruleState.active = false;
      ruleState.startMs = null;
      ruleState.announced = false;
    }
  }

  function resetRuleStates(): void {
    for (const rule of RULES) {
      state[rule.id] = { active: false, startMs: null, announced: false };
    }
  }

  function update(
    frame: TelemetryFrame,
    broadcast: BroadcastFn,
    timeCtx: TimeContext,
    ctx: UpdateContext = {},
  ): void {
    const { nowEpochMs, nowIso } = timeCtx;
    const phase = ctx.phase || null;

    if (ctx.flightCsvWriter && !flightCsvWriter) {
      flightCsvWriter = ctx.flightCsvWriter;
    }

    if (ctx.warmup === true) {
      resetRuleStates();
      return;
    }

    if (isOnGround(frame) || isPhaseSuppressed(phase)) {
      clearAllViolations(broadcast, nowEpochMs, nowIso);
      return;
    }

    const pitch = pitchDeg(frame);
    const bank = bankDeg(frame);
    const gForce = gForceCurrent(frame);

    for (const rule of RULES) {
      const ruleState = state[rule.id];
      const isGRule = 'checkG' in rule;
      const isFrameRule = 'checkFrame' in rule;

      if (!isGRule && !isFrameRule && (pitch === null || bank === null)) continue;
      if (isGRule && gForce === null) continue;

      const isActive = isGRule
        ? (rule as GForceRule).checkG(gForce as number)
        : (isFrameRule
          ? (rule as FrameRule).checkFrame(frame, phase)
          : (rule as AttitudeRule).check(pitch as number, bank as number));
      const isCleared = isGRule
        ? (rule as GForceRule).clearG(gForce as number)
        : (isFrameRule
          ? (rule as FrameRule).clearFrame(frame, phase)
          : (rule as AttitudeRule).clear(pitch as number, bank as number));

      if (!ruleState.active) {
        if (isActive) {
          ruleState.active = true;
          ruleState.startMs = nowEpochMs;
          ruleState.announced = false;
        }
        continue;
      }

      if (
        !ruleState.announced
        && ruleState.startMs !== null
        && (nowEpochMs - ruleState.startMs) >= (rule.minDurationMs ?? MIN_VIOLATION_DURATION_MS)
        && (!isFrameRule || isActive)
      ) {
        ruleState.announced = true;
        const metrics = isGRule
          ? { gForce }
          : (isFrameRule
            ? (rule as FrameRule).metricsFrame(frame)
            : { pitchDeg: pitch, bankDeg: bank });
        onViolationStart(rule, metrics, broadcast, nowEpochMs, nowIso);
      }

      if (isCleared) {
        const durationMs = ruleState.startMs == null ? 0 : nowEpochMs - ruleState.startMs;
        const wasAnnounced = ruleState.announced;
        ruleState.active = false;
        ruleState.startMs = null;
        ruleState.announced = false;

        if (wasAnnounced) {
          const metrics = isGRule
            ? { gForce, durationMs }
            : (isFrameRule
              ? { ...(rule as FrameRule).metricsFrame(frame), durationMs }
              : { pitchDeg: pitch, bankDeg: bank, durationMs });
          onViolationEnd(rule, metrics, broadcast, nowEpochMs, nowIso);
        }
      }
    }
  }

  function reset(): void {
    resetRuleStates();
    flightCsvWriter = null;
  }

  return { update, reset };
}

module.exports = {
  createFlightViolationRunner,
  UPSET_RULE,
  LOAD_FACTOR_RULE,
  APPROACH_SPEED_RULE,
};

export {};
