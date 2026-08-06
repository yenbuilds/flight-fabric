/**
 * VRE Evaluator - Variable Rate Encoding for Telemetry Capture
 * 
 * ════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Physics-driven, event-escalated sampling with hard caps.
 * 
 * Sample faster only when aircraft dynamics demand it.
 * Reality drives the rate. Flight phase may bias, but never override physics.
 * 
 * This evaluator performs no smoothing, interpolation, or predictive filling.
 * ════════════════════════════════════════════════════════════════════════════
 * 
 * SAMPLING TARGET BANDS (hard bounded):
 *   BASELINE       1 Hz target   - Cruise, taxi, steady-state
 *   ELEVATED       5 Hz target   - Maneuvers, config changes
 *   HIGH_FIDELITY  10 Hz target  - Landing, flare, hard dynamics
 *   ULTRA_FIDELITY 10 Hz target  - Flare classification (RA < 50 ft)
 *
 * The evaluator is called once per fresh telemetry tick. Runtime integration
 * caps the effective CSV rate at that poll cadence and an independent 10 Hz
 * runtime ceiling; it never synthesizes, repeats, or catches up frames.
 * 
 * ESCALATION TRIGGERS:
 *   - Vertical speed magnitude or delta
 *   - Vertical acceleration (Z-axis emphasis)
 *   - Pitch / roll / yaw rate
 *   - Rapid radio altitude change
 *   - Ground proximity + descent rate
 *   - High-speed ground roll
 *   - Configuration transitions (gear, flaps, spoilers, reversers)
 * 
 * Invariants:
 *   - Max evaluator target and runtime CSV rate of 10 Hz
 *   - Escalation reason persistence
 *   - Hysteresis windows
 *   - Deterministic rate logic
 *   - Zero sim-thread blocking
 * ════════════════════════════════════════════════════════════════════════════
 */

'use strict';

const config = require('../core/config') as ConfigModule;
const timeSource = require('../core/time-source') as TimeSourceModule;

type ConfigModule = {
  vre?: {
    ultraFidelityEnable?: boolean;
  };
};

type TimeSourceModule = {
  now: () => number;
};

// ═══════════════════════════════════════════════════════════════════════════
// Sampling Bands (Hard Bounded)
// ═══════════════════════════════════════════════════════════════════════════

const BAND = Object.freeze({
  BASELINE: 'BASELINE',
  ELEVATED: 'ELEVATED',
  HIGH_FIDELITY: 'HIGH_FIDELITY',
  ULTRA_FIDELITY: 'ULTRA_FIDELITY',
} as const);

type BandName = typeof BAND[keyof typeof BAND];

type VreOptions = {
  timeNow?: () => number;
};

type VreFrame = {
  vs?: number | null;
  ra?: number | null;
  gForce?: number | null;
  pitchRate?: number | null;
  rollRate?: number | null;
  yawRate?: number | null;
  gearDown?: boolean | null;
  gearDownLocked?: boolean | null;
  flapsNotch?: string | number | null;
  spoilerState?: string | null;
  wow?: boolean | null;
  onGround?: boolean | null;
  pitch?: number | null;
  bank?: number | null;
  gs?: number | null;
  groundSpeed?: number | null;
  phase?: string | null;
};

type VreEvaluationResult = {
  shouldSample: boolean;
  band: BandName;
  rateHz: number;
  escalationReasons: number;
  escalationString: string;
};

type VreState = {
  band: BandName;
  rateHz: number;
  escalationReasons: number;
  escalationString: string;
  lastEvalTs: number | null;
  lastSampleTs: number | null;
  lastEscalationTs: number;
  ultraFidelityTotalMs: number;
  ultraFidelityDisabled: boolean;
  ultraFidelityTimeRemaining: number;
  ultraFidelitySampleCount: number;
  ultraFidelitySamplesRemaining: number;
  ultraFidelityConsecutiveEvals: number;
};

type VreEvaluator = {
  evaluate: (frame: VreFrame) => VreEvaluationResult;
  reset: () => void;
  getState: () => VreState;
  forceSample: () => void;
  _setTimeForTest: (ts: number | null) => void;
  BAND: typeof BAND;
  BAND_RATES: typeof BAND_RATES;
  ESCALATION: typeof ESCALATION;
};

const BAND_RATES: Record<BandName, number> = Object.freeze({
  [BAND.BASELINE]: 1,       // 1 Hz target
  [BAND.ELEVATED]: 5,       // 5 Hz target
  [BAND.HIGH_FIDELITY]: 10, // 10 Hz target
  [BAND.ULTRA_FIDELITY]: 10, // 10 Hz target - flare classification
});

const BAND_INTERVALS_MS: Record<BandName, number> = Object.freeze({
  [BAND.BASELINE]: 1000,    // 1000ms target interval (1 Hz)
  [BAND.ELEVATED]: 200,     // 200ms target interval (5 Hz)
  [BAND.HIGH_FIDELITY]: 100,// 100ms target interval (10 Hz)
  [BAND.ULTRA_FIDELITY]: 100,// 100ms target interval (10 Hz)
});

const BAND_PRIORITY: Record<BandName, number> = Object.freeze({
  [BAND.BASELINE]: 0,
  [BAND.ELEVATED]: 1,
  [BAND.HIGH_FIDELITY]: 2,
  [BAND.ULTRA_FIDELITY]: 3,
});

function raiseTargetBand(current: BandName, candidate: BandName): BandName {
  return BAND_PRIORITY[candidate] > BAND_PRIORITY[current] ? candidate : current;
}

function decayBandOneStep(current: BandName, floor: BandName = BAND.BASELINE): BandName {
  let next = current;
  if (current === BAND.ULTRA_FIDELITY) {
    next = BAND.HIGH_FIDELITY;
  } else if (current === BAND.HIGH_FIDELITY) {
    next = BAND.ELEVATED;
  } else if (current === BAND.ELEVATED) {
    next = BAND.BASELINE;
  }

  return BAND_PRIORITY[next] < BAND_PRIORITY[floor] ? floor : next;
}

function finiteNumberOrDefault(value: unknown, fallback: number): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }
  return fallback;
}

function finiteNumberOrNull(value: unknown): number | null {
  const numeric = finiteNumberOrDefault(value, NaN);
  return Number.isFinite(numeric) ? numeric : null;
}

function firstFiniteNumberOrDefault(fallback: number, ...values: unknown[]): number {
  for (const value of values) {
    const numeric = finiteNumberOrDefault(value, NaN);
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
}

function booleanOrNull(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return null;
}

function firstBooleanOrNull(...values: unknown[]): boolean | null {
  for (const value of values) {
    const normalized = booleanOrNull(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function stateTokenOrNull(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Escalation Reasons (Bitmask for combining multiple triggers)
// ═══════════════════════════════════════════════════════════════════════════

const ESCALATION = Object.freeze({
  NONE: 0,
  INTERVAL: 1 << 0,           // Regular interval sample (baseline)
  VS_MAGNITUDE: 1 << 1,       // High vertical speed
  VS_DELTA: 1 << 2,           // Rapid VS change
  ACCEL_Z: 1 << 3,            // Vertical acceleration
  PITCH_RATE: 1 << 4,         // Pitch rate
  ROLL_RATE: 1 << 5,          // Roll rate
  YAW_RATE: 1 << 6,           // Yaw rate
  RA_DELTA: 1 << 7,           // Rapid radio altitude change
  GROUND_PROXIMITY: 1 << 8,   // Low RA + descending
  GEAR_TRANSITION: 1 << 9,    // Gear state change
  FLAPS_TRANSITION: 1 << 10,  // Flaps state change
  SPOILERS_TRANSITION: 1 << 11, // Spoilers state change
  REVERSERS_TRANSITION: 1 << 12, // Reversers state change
  TOUCHDOWN: 1 << 13,         // WOW transition
  FLARE_ZONE: 1 << 14,        // RA < 50 ft (ultra-fidelity flare capture)
  GROUND_ROLL: 1 << 15,       // WOW + fast ground roll
});

/**
 * Convert escalation bitmask to human-readable string.
 * @param {number} mask - Escalation bitmask
 * @returns {string} Comma-separated list of reasons
 */
function escalationToString(mask: number): string {
  if (mask === 0 || mask === ESCALATION.NONE) return 'none';
  if (mask === ESCALATION.INTERVAL) return 'interval';
  
  const reasons = [];
  if (mask & ESCALATION.VS_MAGNITUDE) reasons.push('vs_magnitude');
  if (mask & ESCALATION.VS_DELTA) reasons.push('vs_delta');
  if (mask & ESCALATION.ACCEL_Z) reasons.push('accel_z');
  if (mask & ESCALATION.PITCH_RATE) reasons.push('pitch_rate');
  if (mask & ESCALATION.ROLL_RATE) reasons.push('roll_rate');
  if (mask & ESCALATION.YAW_RATE) reasons.push('yaw_rate');
  if (mask & ESCALATION.RA_DELTA) reasons.push('ra_delta');
  if (mask & ESCALATION.GROUND_PROXIMITY) reasons.push('ground_proximity');
  if (mask & ESCALATION.GEAR_TRANSITION) reasons.push('gear_transition');
  if (mask & ESCALATION.FLAPS_TRANSITION) reasons.push('flaps_transition');
  if (mask & ESCALATION.SPOILERS_TRANSITION) reasons.push('spoilers_transition');
  if (mask & ESCALATION.REVERSERS_TRANSITION) reasons.push('reversers_transition');
  if (mask & ESCALATION.TOUCHDOWN) reasons.push('touchdown');
  if (mask & ESCALATION.FLARE_ZONE) reasons.push('flare_zone');
  if (mask & ESCALATION.GROUND_ROLL) reasons.push('ground_roll');
  
  return reasons.length > 0 ? reasons.join(',') : 'interval';
}

// ═══════════════════════════════════════════════════════════════════════════
// Escalation Thresholds
// ═══════════════════════════════════════════════════════════════════════════

const THRESHOLDS = Object.freeze({
  // Vertical speed (fpm)
  VS_ELEVATED: 1000,          // |VS| > 1000 fpm → ELEVATED
  VS_HIGH_FIDELITY: 1500,     // |VS| > 1500 fpm → HIGH_FIDELITY
  VS_DELTA_ELEVATED: 300,     // |ΔVS| > 300 fpm/sec → ELEVATED
  VS_DELTA_HIGH_FIDELITY: 600,// |ΔVS| > 600 fpm/sec → HIGH_FIDELITY
  
  // Acceleration (G)
  ACCEL_Z_ELEVATED: 0.15,     // |ΔG| > 0.15 G → ELEVATED
  ACCEL_Z_HIGH_FIDELITY: 0.3, // |ΔG| > 0.3 G → HIGH_FIDELITY
  
  // Angular rates (deg/sec)
  PITCH_RATE_ELEVATED: 3,     // |pitch rate| > 3 deg/s → ELEVATED
  PITCH_RATE_HIGH_FIDELITY: 6,// |pitch rate| > 6 deg/s → HIGH_FIDELITY
  ROLL_RATE_ELEVATED: 5,      // |roll rate| > 5 deg/s → ELEVATED
  ROLL_RATE_HIGH_FIDELITY: 15,// |roll rate| > 15 deg/s → HIGH_FIDELITY
  YAW_RATE_ELEVATED: 3,       // |yaw rate| > 3 deg/s → ELEVATED
  YAW_RATE_HIGH_FIDELITY: 8,  // |yaw rate| > 8 deg/s → HIGH_FIDELITY
  
  // Radio altitude (ft)
  RA_DELTA_ELEVATED: 50,      // |ΔRA| > 50 ft/sec → ELEVATED
  RA_DELTA_HIGH_FIDELITY: 100,// |ΔRA| > 100 ft/sec → HIGH_FIDELITY
  RA_DELTA_MAX_RA: 2500,      // Ignore terrain-driven RA swings above radio-altimeter range
  VS_CLIMB_MAX_RA: 2500,      // Positive VS alone above this RA is normal climb, not sample-worthy

  // Ground proximity
  GROUND_PROXIMITY_RA: 500,   // RA < 500 ft AND descending → escalate
  GROUND_PROXIMITY_FLARE_RA: 50, // RA < 50 ft → ULTRA_FIDELITY

  // Ground roll
  GROUND_ROLL_ELEVATED_GS: 30, // WOW + GS > 30 kt -> ELEVATED until clear of high-speed ground roll
  
  // Ultra-fidelity flare zone
  ULTRA_FIDELITY_RA: 50,      // RA < 50 ft → ULTRA_FIDELITY (10 Hz target)
  ULTRA_FIDELITY_PITCH_RATE: 2, // |pitch rate| > 2 deg/s in flare → ULTRA_FIDELITY
  
  // Safety limits that prevent unbounded high-rate recording.
  ULTRA_FIDELITY_MAX_DURATION_MS: 60000, // Hard limit: 60s max ULTRA_FIDELITY per session
  ULTRA_FIDELITY_GROUND_SPEED_DISABLE: 30, // Disable ULTRA_FIDELITY when GS < 30 kts on ground
  ULTRA_FIDELITY_EXIT_RA: 100,     // Disable ULTRA_FIDELITY if RA climbs above 100 ft (go-around)
  ULTRA_FIDELITY_MAX_SAMPLES: 600, // Hard cap: 60s at the 10 Hz CSV ceiling
  ULTRA_FIDELITY_STUCK_THRESHOLD: 100, // Emergency: force decay if stuck for 100+ consecutive evals
});

// ═══════════════════════════════════════════════════════════════════════════
// Hysteresis & Decay Configuration (Structural Invariant)
// ═══════════════════════════════════════════════════════════════════════════

const HYSTERESIS = Object.freeze({
  // Minimum hold time at escalated rate (prevents micro-spikes)
  HOLD_MS: 2000,              // Hold escalated rate for at least 2 seconds
  
  // Decay requires sustained calm
  DECAY_CALM_MS: 3000,        // Require 3s of calm before decay
  
  // Decay is stepwise, never instant
  // ULTRA_FIDELITY → HIGH_FIDELITY → ELEVATED → BASELINE
  DECAY_STEP_MS: 1000,        // 1s between decay steps
});

const HIGH_FIDELITY_NON_VS_TRIGGERS = Object.freeze(
  ESCALATION.ACCEL_Z |
  ESCALATION.PITCH_RATE |
  ESCALATION.ROLL_RATE |
  ESCALATION.YAW_RATE |
  ESCALATION.RA_DELTA |
  ESCALATION.GEAR_TRANSITION |
  ESCALATION.SPOILERS_TRANSITION |
  ESCALATION.REVERSERS_TRANSITION |
  ESCALATION.TOUCHDOWN |
  ESCALATION.GROUND_PROXIMITY |
  ESCALATION.FLARE_ZONE
);

const HIGH_FIDELITY_VS_TRIGGERS = Object.freeze(
  ESCALATION.VS_MAGNITUDE |
  ESCALATION.VS_DELTA
);

// ═══════════════════════════════════════════════════════════════════════════
// Factory: Create VRE Evaluator Instance
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a VRE evaluator instance.
 * Factory pattern enables deterministic testing with injected time source.
 * 
 * @param {Object} options
 * @param {function(): number} [options.timeNow] - Time source (default: timeSource.now)
 * @returns {Object} VRE evaluator instance
 */
function createVreEvaluator(options: VreOptions = {}): VreEvaluator {
  // Allow time override for replay testing
  let overrideTime: number | null = null;
  const getNow = (): number => (overrideTime !== null ? overrideTime : (options.timeNow || (() => timeSource.now()))());
  
  // ─────────────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────────────
  
  let currentBand: BandName = BAND.BASELINE;
  let lastEvalTs: number | null = null;
  let lastSampleTs: number | null = null;  // null = never sampled (first sample always taken)
  let lastEscalationTs = 0;
  let lastDecayTs = 0;
  let escalationReasons: number = ESCALATION.NONE;
  
  // Previous frame values for delta computation
  let prevVs: number | null = null;
  let prevRa: number | null = null;
  let prevGForce: number | null = null;
  let prevGearDown: boolean | null = null;
  let prevFlapsNotch: string | null = null;
  let prevSpoilerState: string | null = null;
  let prevWow: boolean | null = null;
  
  // Track when calm started (for decay hysteresis)
  let calmSinceTs: number | null = null;
  
  // ULTRA_FIDELITY safety tracking (prevent disk space exhaustion)
  let ultraFidelityStartTs: number | null = null;  // When ULTRA_FIDELITY first activated
  let ultraFidelityTotalMs = 0;     // Cumulative time in ULTRA_FIDELITY
  let ultraFidelityHardDisabled = false; // Config/cap safety lockout, reset on flight start.
  let ultraFidelityTransientDisabled = false; // Re-arms after touchdown/go-around recovery.
  let ultraFidelitySampleCount = 0; // Total samples recorded in ULTRA_FIDELITY
  let ultraFidelityConsecutiveEvals = 0; // Consecutive evals in ULTRA_FIDELITY (stuck detection)
  
  // ─────────────────────────────────────────────────────────────────────────
  // Core Evaluation
  // ─────────────────────────────────────────────────────────────────────────
  
  /**
   * Evaluate current frame and determine if a sample should be logged.
   * 
   * @param {Object} frame - Telemetry frame
   * @param {number} frame.vs - Vertical speed (fpm)
   * @param {number} frame.ra - Radio altitude (ft)
   * @param {number} [frame.gForce] - G-force
   * @param {number} [frame.pitchRate] - Pitch rate (deg/s)
   * @param {number} [frame.rollRate] - Roll rate (deg/s)  
   * @param {number} [frame.yawRate] - Yaw rate (deg/s)
   * @param {boolean} [frame.gearDown] - Gear down state
   * @param {string} [frame.flapsNotch] - Flaps position
   * @param {string} [frame.spoilerState] - Spoiler state
   * @param {boolean} [frame.wow] - Weight on wheels
   * @param {number} [frame.pitch] - Pitch angle (deg)
   * @param {number} [frame.bank] - Bank angle (deg)
   * @param {string} [frame.phase] - Flight phase (optional override)
   * @returns {Object} { shouldSample, band, rateHz, escalationReasons, escalationString }
   */
  function evaluate(frame: VreFrame): VreEvaluationResult {
    const now = getNow();
    const dtMs = lastEvalTs !== null ? Math.max(0, now - lastEvalTs) : 0;
    const dtSec = dtMs / 1000;
    
    // Reset escalation reasons for this evaluation
    let newEscalation: number = ESCALATION.NONE;
    let targetBand: BandName = BAND.BASELINE;
    
    // Phase is informational and does not override physics-based escalation.
    // Approach and landing dynamics trigger HIGH_FIDELITY through vertical
    // speed, pitch rate, radio altitude, and the other rules below.
    
    // ───────────────────────────────────────────────────────────────────────
    // Evaluate escalation triggers
    // ───────────────────────────────────────────────────────────────────────
    
    const vs = finiteNumberOrDefault(frame.vs, 0);
    const ra = finiteNumberOrDefault(frame.ra, 10000);
    const gForce = finiteNumberOrNull(frame.gForce);
    const pitchRate = finiteNumberOrDefault(frame.pitchRate, 0);
    const rollRate = finiteNumberOrDefault(frame.rollRate, 0);
    const yawRate = finiteNumberOrDefault(frame.yawRate, 0);
    const gearDown = firstBooleanOrNull(frame.gearDown, frame.gearDownLocked);
    const flapsNotch = stateTokenOrNull(frame.flapsNotch);
    const spoilerState = stateTokenOrNull(frame.spoilerState);
    const wow = firstBooleanOrNull(frame.wow, frame.onGround) ?? false;
    const _pitch = finiteNumberOrDefault(frame.pitch, 0);
    const _bank = finiteNumberOrDefault(frame.bank, 0);
    const groundSpeed = firstFiniteNumberOrDefault(0, frame.gs, frame.groundSpeed);
    
    // Limit 0: configuration can disable ULTRA_FIDELITY entirely.
    const ultraFidelityEnabled = config.vre?.ultraFidelityEnable ?? true;
    if (!ultraFidelityEnabled) {
      ultraFidelityHardDisabled = true;
    }

    if (
      ultraFidelityTransientDisabled
      && currentBand !== BAND.ULTRA_FIDELITY
      && !wow
      && ra > THRESHOLDS.ULTRA_FIDELITY_EXIT_RA
    ) {
      ultraFidelityTransientDisabled = false;
      ultraFidelityStartTs = null;
    }
    // ═══════════════════════════════════════════════════════════════════════
    // ULTRA_FIDELITY safety limits
    // ═══════════════════════════════════════════════════════════════════════
    // Prevent disk space exhaustion from prolonged Ultra capture.
    
    // Track ULTRA_FIDELITY cumulative time
    if (currentBand === BAND.ULTRA_FIDELITY && dtMs > 0) {
      ultraFidelityTotalMs += dtMs;
      ultraFidelityConsecutiveEvals++;
    } else {
      ultraFidelityConsecutiveEvals = 0; // Reset stuck counter
    }
    
    // Track sample count
    if (currentBand === BAND.ULTRA_FIDELITY && lastSampleTs !== null) {
      // Count an eligible Ultra sampling opportunity. The runtime invokes this
      // evaluator no more than once per fresh telemetry tick.
      const timeSinceLastSample = now - lastSampleTs;
      if (timeSinceLastSample >= BAND_INTERVALS_MS[BAND.ULTRA_FIDELITY]) {
        ultraFidelitySampleCount++;
      }
    }
    
    // Limit 1: maximum capture duration.
    if (ultraFidelityTotalMs >= THRESHOLDS.ULTRA_FIDELITY_MAX_DURATION_MS) {
      ultraFidelityHardDisabled = true;
    }
    
    // Limit 1b: maximum sample count.
    if (ultraFidelitySampleCount >= THRESHOLDS.ULTRA_FIDELITY_MAX_SAMPLES) {
      ultraFidelityHardDisabled = true;
    }
    
    // Limit 1c: consecutive-evaluation guard.
    if (ultraFidelityConsecutiveEvals >= THRESHOLDS.ULTRA_FIDELITY_STUCK_THRESHOLD) {
      ultraFidelityHardDisabled = true;
    }
    
    // Limit 2: weight-on-wheels at low ground speed.
    if (wow && groundSpeed < THRESHOLDS.ULTRA_FIDELITY_GROUND_SPEED_DISABLE) {
      ultraFidelityTransientDisabled = true;
    }
    
    // Limit 3: completed touchdown indicated by low RA and weight-on-wheels.
    if (wow && ra < THRESHOLDS.ULTRA_FIDELITY_RA) {
      ultraFidelityTransientDisabled = true;
    }
        // Limit 4: go-around indicated by RA climbing above the exit threshold.
    // If ULTRA_FIDELITY was active and RA climbs above 100 ft → pilot went around
    if (currentBand === BAND.ULTRA_FIDELITY && ra > THRESHOLDS.ULTRA_FIDELITY_EXIT_RA) {
      ultraFidelityTransientDisabled = true;
    }
    
    // Limit 5: positive vertical speed in the flare zone.
    // If in flare zone but climbing rapidly → abort landing
    if (currentBand === BAND.ULTRA_FIDELITY && vs > 200 && ra < 200) {
      ultraFidelityTransientDisabled = true;
    }
        // ═══════════════════════════════════════════════════════════════════════
    
    const ultraFidelityDisabled = ultraFidelityHardDisabled || ultraFidelityTransientDisabled;

    // VS magnitude. Descent remains interesting across the flight, but steady
    // high-altitude climb is usually smooth and should not hold 5 Hz by itself.
    const vsAbs = Math.abs(vs);
    const steadyHighAltitudeClimb = !wow && vs > 0 && ra > THRESHOLDS.VS_CLIMB_MAX_RA;
    if (!steadyHighAltitudeClimb) {
      if (vsAbs > THRESHOLDS.VS_HIGH_FIDELITY) {
        newEscalation |= ESCALATION.VS_MAGNITUDE;
        targetBand = raiseTargetBand(targetBand, BAND.HIGH_FIDELITY);
      } else if (vsAbs > THRESHOLDS.VS_ELEVATED) {
        newEscalation |= ESCALATION.VS_MAGNITUDE;
        targetBand = raiseTargetBand(targetBand, BAND.ELEVATED);
      }
    }
    
    // VS delta (rate of change)
    if (prevVs !== null && dtSec > 0) {
      const vsDelta = Math.abs(vs - prevVs) / dtSec; // fpm per second
      if (vsDelta > THRESHOLDS.VS_DELTA_HIGH_FIDELITY) {
        newEscalation |= ESCALATION.VS_DELTA;
        targetBand = raiseTargetBand(targetBand, BAND.HIGH_FIDELITY);
      } else if (vsDelta > THRESHOLDS.VS_DELTA_ELEVATED) {
        newEscalation |= ESCALATION.VS_DELTA;
        targetBand = raiseTargetBand(targetBand, BAND.ELEVATED);
      }
    }
    
    // Vertical acceleration (G delta)
    if (gForce !== null && prevGForce !== null && dtSec > 0) {
      const gDelta = Math.abs(gForce - prevGForce);
      if (gDelta > THRESHOLDS.ACCEL_Z_HIGH_FIDELITY) {
        newEscalation |= ESCALATION.ACCEL_Z;
        targetBand = raiseTargetBand(targetBand, BAND.HIGH_FIDELITY);
      } else if (gDelta > THRESHOLDS.ACCEL_Z_ELEVATED) {
        newEscalation |= ESCALATION.ACCEL_Z;
        targetBand = raiseTargetBand(targetBand, BAND.ELEVATED);
      }
    }
    
    // Pitch rate
    const pitchRateAbs = Math.abs(pitchRate);
    if (pitchRateAbs > THRESHOLDS.PITCH_RATE_HIGH_FIDELITY) {
      newEscalation |= ESCALATION.PITCH_RATE;
      targetBand = raiseTargetBand(targetBand, BAND.HIGH_FIDELITY);
    } else if (pitchRateAbs > THRESHOLDS.PITCH_RATE_ELEVATED) {
      newEscalation |= ESCALATION.PITCH_RATE;
      targetBand = raiseTargetBand(targetBand, BAND.ELEVATED);
    }
    
    // Roll rate
    const rollRateAbs = Math.abs(rollRate);
    if (rollRateAbs > THRESHOLDS.ROLL_RATE_HIGH_FIDELITY) {
      newEscalation |= ESCALATION.ROLL_RATE;
      targetBand = raiseTargetBand(targetBand, BAND.HIGH_FIDELITY);
    } else if (rollRateAbs > THRESHOLDS.ROLL_RATE_ELEVATED) {
      newEscalation |= ESCALATION.ROLL_RATE;
      targetBand = raiseTargetBand(targetBand, BAND.ELEVATED);
    }
    
    // Yaw rate
    const yawRateAbs = Math.abs(yawRate);
    if (yawRateAbs > THRESHOLDS.YAW_RATE_HIGH_FIDELITY) {
      newEscalation |= ESCALATION.YAW_RATE;
      targetBand = raiseTargetBand(targetBand, BAND.HIGH_FIDELITY);
    } else if (yawRateAbs > THRESHOLDS.YAW_RATE_ELEVATED) {
      newEscalation |= ESCALATION.YAW_RATE;
      targetBand = raiseTargetBand(targetBand, BAND.ELEVATED);
    }
    
    // RA delta (rapid low-altitude height change).  At cruise, radio altitude
    // follows terrain relief and can jump thousands of feet without the aircraft
    // doing anything sample-worthy, so only use it in the RA operating region.
    if (
      prevRa !== null &&
      dtSec > 0 &&
      prevRa <= THRESHOLDS.RA_DELTA_MAX_RA &&
      ra <= THRESHOLDS.RA_DELTA_MAX_RA
    ) {
      const raDelta = Math.abs(ra - prevRa) / dtSec; // ft per second
      if (raDelta > THRESHOLDS.RA_DELTA_HIGH_FIDELITY) {
        newEscalation |= ESCALATION.RA_DELTA;
        targetBand = raiseTargetBand(targetBand, BAND.HIGH_FIDELITY);
      } else if (raDelta > THRESHOLDS.RA_DELTA_ELEVATED) {
        newEscalation |= ESCALATION.RA_DELTA;
        targetBand = raiseTargetBand(targetBand, BAND.ELEVATED);
      }
    }
    
    // ULTRA_FIDELITY: Flare zone (RA < 50 ft)
    // Preserve an explicit flare band without exceeding the global 10 Hz cap.
    // Captures flare/touchdown context at the maximum safe CSV cadence.
    //
    // Enter this band only while all safety limits permit it.
    if (!ultraFidelityDisabled) {
      // Flare zone: RA < 50 ft AND NOT on ground
      if (ra < THRESHOLDS.ULTRA_FIDELITY_RA && !wow) {
        newEscalation |= ESCALATION.FLARE_ZONE;
        targetBand = raiseTargetBand(targetBand, BAND.ULTRA_FIDELITY);
        // Track start time for duration limit
        if (ultraFidelityStartTs === null) {
          ultraFidelityStartTs = now;
        }
      }
      // Also trigger ULTRA_FIDELITY on flare pitch rate (pilot initiating flare)
      else if (ra < 100 && Math.abs(pitchRate) > THRESHOLDS.ULTRA_FIDELITY_PITCH_RATE && vs < 0 && !wow) {
        newEscalation |= ESCALATION.FLARE_ZONE | ESCALATION.PITCH_RATE;
        targetBand = raiseTargetBand(targetBand, BAND.ULTRA_FIDELITY);
        if (ultraFidelityStartTs === null) {
          ultraFidelityStartTs = now;
        }
      }
    }
    
    // Ground proximity (low RA + descending) - HIGH_FIDELITY or ELEVATED.
    // Only airborne frames qualify; on-ground VS noise at RA ~= 10 ft is common
    // after touchdown and should not keep parked aircraft at high rate.
    if (!wow && ra < THRESHOLDS.GROUND_PROXIMITY_FLARE_RA && vs < 0) {
      newEscalation |= ESCALATION.GROUND_PROXIMITY;
      targetBand = raiseTargetBand(targetBand, BAND.HIGH_FIDELITY);
    } else if (!wow && ra < THRESHOLDS.GROUND_PROXIMITY_RA && vs < -200) {
      newEscalation |= ESCALATION.GROUND_PROXIMITY;
      targetBand = raiseTargetBand(targetBand, BAND.ELEVATED);
    }

    // High-speed ground roll needs denser telemetry than taxi/parked, but does
    // not need flare capture rates once the aircraft is weight-on-wheels.
    if (wow && groundSpeed > THRESHOLDS.GROUND_ROLL_ELEVATED_GS) {
      newEscalation |= ESCALATION.GROUND_ROLL;
      targetBand = raiseTargetBand(targetBand, BAND.ELEVATED);
    }
    
    // Configuration transitions
    if (gearDown !== null && prevGearDown !== null && gearDown !== prevGearDown) {
      newEscalation |= ESCALATION.GEAR_TRANSITION;
      targetBand = raiseTargetBand(targetBand, BAND.HIGH_FIDELITY);
    }
    
    if (flapsNotch !== null && prevFlapsNotch !== null && flapsNotch !== prevFlapsNotch) {
      newEscalation |= ESCALATION.FLAPS_TRANSITION;
      targetBand = raiseTargetBand(targetBand, BAND.ELEVATED);
    }
    
    if (spoilerState !== null && prevSpoilerState !== null && spoilerState !== prevSpoilerState) {
      newEscalation |= ESCALATION.SPOILERS_TRANSITION;
      targetBand = raiseTargetBand(targetBand, BAND.ELEVATED);
    }
    
    // Touchdown detection (WOW transition)
    if (prevWow !== null && wow && !prevWow) {
      newEscalation |= ESCALATION.TOUCHDOWN;
      targetBand = raiseTargetBand(targetBand, BAND.HIGH_FIDELITY);
    }

    // Anti-spam guard: avoid sustained 10Hz in high-altitude climb/cruise from VS-only triggers.
    // Keep HIGH_FIDELITY for low-altitude work and for hard non-VS dynamics.
    if (targetBand === BAND.HIGH_FIDELITY) {
      const aboveProximityZone = ra > THRESHOLDS.GROUND_PROXIMITY_RA;
      const onlyVsDriven =
        (newEscalation & HIGH_FIDELITY_VS_TRIGGERS) !== 0 &&
        (newEscalation & HIGH_FIDELITY_NON_VS_TRIGGERS) === 0;

      if (!wow && aboveProximityZone && onlyVsDriven) {
        targetBand = BAND.ELEVATED;
      }
    }
    
    // ───────────────────────────────────────────────────────────────────────
    // Hysteresis: Apply hold and decay logic
    // ───────────────────────────────────────────────────────────────────────
    
    const hasEscalation = newEscalation !== ESCALATION.NONE;
    
    // Leave ULTRA_FIDELITY immediately when any safety limit activates.
    if (ultraFidelityDisabled && currentBand === BAND.ULTRA_FIDELITY) {
      currentBand = BAND.HIGH_FIDELITY; // Emergency step down
      lastDecayTs = now;
    }
    
    if (hasEscalation) {
      const targetPriority = BAND_PRIORITY[targetBand];
      const currentPriority = BAND_PRIORITY[currentBand];

      if (targetPriority >= currentPriority) {
        // Equal-or-higher priority escalation keeps the current band active, or
        // upgrades immediately when physics demands more fidelity.
        currentBand = targetBand;
        lastEscalationTs = now;
        lastDecayTs = now;
        calmSinceTs = null; // Reset calm timer
      } else {
        // A lower-priority trigger is still meaningful. Let prior high-rate
        // capture decay stepwise, but do not fall below the active trigger band.
        const timeSinceEscalation = now - lastEscalationTs;
        if (timeSinceEscalation >= HYSTERESIS.HOLD_MS) {
          const timeSinceDecay = now - lastDecayTs;
          if (timeSinceDecay >= HYSTERESIS.DECAY_STEP_MS) {
            currentBand = decayBandOneStep(currentBand, targetBand);
            lastDecayTs = now;
          }
        }

        if (currentBand === targetBand) {
          lastEscalationTs = now;
          calmSinceTs = null;
        } else if (calmSinceTs === null) {
          calmSinceTs = now;
        }
      }
      escalationReasons = newEscalation;
    } else {
      const heldEscalationReasons = escalationReasons;
      // No escalation - check for decay
      const timeSinceEscalation = now - lastEscalationTs;
      
      // Start calm timer if not already running
      if (calmSinceTs === null) {
        calmSinceTs = now;
      }
      
      const calmDuration = now - calmSinceTs;
      
      // Only decay after hold period AND sustained calm
      if (timeSinceEscalation >= HYSTERESIS.HOLD_MS && calmDuration >= HYSTERESIS.DECAY_CALM_MS) {
        const timeSinceDecay = now - lastDecayTs;
        
        if (timeSinceDecay >= HYSTERESIS.DECAY_STEP_MS) {
          // Stepwise decay: ULTRA_FIDELITY → HIGH_FIDELITY → ELEVATED → BASELINE
          if (currentBand === BAND.ULTRA_FIDELITY) {
            currentBand = BAND.HIGH_FIDELITY;
            lastDecayTs = now;
          } else if (currentBand === BAND.HIGH_FIDELITY) {
            currentBand = BAND.ELEVATED;
            lastDecayTs = now;
          } else if (currentBand === BAND.ELEVATED) {
            currentBand = BAND.BASELINE;
            lastDecayTs = now;
          }
        }
      }
      
      // Preserve the last escalation reason while hysteresis keeps the band
      // above baseline. CSV rows should explain why high-rate sampling is still
      // active instead of reporting those held samples as plain interval rows.
      escalationReasons = currentBand === BAND.BASELINE
        ? ESCALATION.INTERVAL
        : (heldEscalationReasons !== ESCALATION.NONE && heldEscalationReasons !== ESCALATION.INTERVAL
          ? heldEscalationReasons
          : ESCALATION.INTERVAL);
    }
    
    // ───────────────────────────────────────────────────────────────────────
    // Determine if sample should be taken
    // ───────────────────────────────────────────────────────────────────────
    
    const requiredIntervalMs = BAND_INTERVALS_MS[currentBand];
    const timeSinceLastSample = lastSampleTs !== null ? (now - lastSampleTs) : Infinity;
    // First sample (lastSampleTs === null) is always taken
    const shouldSample = lastSampleTs === null || timeSinceLastSample >= requiredIntervalMs;
    
    // ───────────────────────────────────────────────────────────────────────
    // Update previous values for next evaluation
    // ───────────────────────────────────────────────────────────────────────
    
    prevVs = vs;
    prevRa = ra;
    // Do not bridge a missing-data gap with a fabricated 1 G sample. G delta
    // becomes meaningful again after two consecutive measured values.
    prevGForce = gForce;
    if (gearDown !== null) prevGearDown = gearDown;
    if (flapsNotch !== null) prevFlapsNotch = flapsNotch;
    if (spoilerState !== null) prevSpoilerState = spoilerState;
    prevWow = wow;
    
    // Record sample timestamp if sampling
    if (shouldSample) {
      lastSampleTs = now;
    }

    lastEvalTs = now;
    
    return {
      shouldSample,
      band: currentBand,
      rateHz: BAND_RATES[currentBand],
      escalationReasons,
      escalationString: escalationToString(escalationReasons),
    };
  }
  
  /**
   * Reset evaluator state (e.g., on flight start).
   */
  function reset(): void {
    currentBand = BAND.BASELINE;
    lastEvalTs = null;
    lastSampleTs = null;
    lastEscalationTs = 0;
    lastDecayTs = 0;
    escalationReasons = ESCALATION.NONE;
    prevVs = null;
    prevRa = null;
    prevGForce = null;
    prevGearDown = null;
    prevFlapsNotch = null;
    prevSpoilerState = null;
    prevWow = null;
    calmSinceTs = null;
    
    // Reset ULTRA_FIDELITY safety tracking
    ultraFidelityStartTs = null;
    ultraFidelityTotalMs = 0;
    ultraFidelityHardDisabled = false;
    ultraFidelityTransientDisabled = false;
    ultraFidelitySampleCount = 0;
    ultraFidelityConsecutiveEvals = 0;
  }
  
  /**
   * Get current state (for diagnostics).
   */
  function getState(): VreState {
    const ultraFidelityDisabled = ultraFidelityHardDisabled || ultraFidelityTransientDisabled;
    return {
      band: currentBand,
      rateHz: BAND_RATES[currentBand],
      escalationReasons,
      escalationString: escalationToString(escalationReasons),
      lastEvalTs,
      lastSampleTs,
      lastEscalationTs,
      // ULTRA_FIDELITY safety diagnostics
      ultraFidelityTotalMs,
      ultraFidelityDisabled,
      ultraFidelityTimeRemaining: ultraFidelityDisabled ? 0 : 
        (THRESHOLDS.ULTRA_FIDELITY_MAX_DURATION_MS - ultraFidelityTotalMs),
      ultraFidelitySampleCount,
      ultraFidelitySamplesRemaining: ultraFidelityDisabled ? 0 :
        (THRESHOLDS.ULTRA_FIDELITY_MAX_SAMPLES - ultraFidelitySampleCount),
      ultraFidelityConsecutiveEvals,
    };
  }
  
  /**
   * Force a sample (for mandatory events like touchdown).
   * Updates lastSampleTs so interval logic remains correct.
   */
  function forceSample(): void {
    lastSampleTs = getNow();
  }
  
  return {
    evaluate,
    reset,
    getState,
    forceSample,
    // Test helper: set time for replay testing
    _setTimeForTest: (ts: number | null): void => { overrideTime = ts; },
    // Expose constants for external use
    BAND,
    BAND_RATES,
    ESCALATION,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Module Exports
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  createVreEvaluator,
  BAND,
  BAND_RATES,
  BAND_INTERVALS_MS,
  ESCALATION,
  THRESHOLDS,
  HYSTERESIS,
  escalationToString,
};

export {};
