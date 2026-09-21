// touchdown-shake.ts
// Touchdown camera-shake profile and player.
//
// DISABLED (2026-09-18). Neither transport produced a visible effect in the
// sim, so the feature is switched off at the source: the provider refuses to
// start a shake, the core neither subscribes to landings nor honours the
// Test Shake message, and the debug modal has no button. The profile and
// runner stay here, fully unit-tested, for when the transport is understood.
// Flip TOUCHDOWN_SHAKE_DISABLED to false to bring it back; the guard tests in
// test-dry-guards.js will insist the button and the docs come back with it.
//
// The profile is a pure function of time so it can be unit-tested without a
// simulator. It models what a pilot's head does when the mains touch:
//
//   1. Strut compression: the seat stops moving down, the head keeps going.
//      A sharp downward drop, a softer rebound, then one or two smaller
//      bounces (dy, with a matching nose-down pitch nod and a tiny forward
//      lurch).
//   2. Rumble: the airframe rings for a moment. Several incommensurate sine
//      components (11-23 Hz) on bank, pitch, heading and position, with an
//      exponential decay.
//   3. Lateral wobble: a slow (~1.7 Hz) damped roll, sign chosen per landing.
//
// Everything scales with the touchdown vertical speed and a user intensity
// multiplier, starts at exactly zero, and fades to exactly zero at the end so
// the transport is never left holding a residual offset.
//
// Two transports exist (see simconnect-telemetry-provider.ts):
//   - 'eyepoint'   writes STRUCT EYEPOINT DYNAMIC OFFSET / ANGLE. This is the
//                  simulator's own head-movement overlay: additive on top of
//                  whatever the user's camera is doing, and it never takes
//                  ownership of the camera.
//   - 'camera6dof' calls SimConnect_CameraSetRelative6DOF. Positions the
//                  camera relative to the DEFAULT eyepoint, so it snaps the
//                  user's own camera adjustments and holds an override until
//                  the sim releases it. Kept as a fallback only.

export type TouchdownShakeMethod = 'eyepoint' | 'camera6dof';

const TOUCHDOWN_SHAKE_METHODS: readonly TouchdownShakeMethod[] = Object.freeze([
  'eyepoint',
  'camera6dof',
]);

const DEFAULT_TOUCHDOWN_SHAKE_METHOD: TouchdownShakeMethod = 'eyepoint';
const DEFAULT_TOUCHDOWN_SHAKE_INTENSITY = 1;
const MIN_TOUCHDOWN_SHAKE_INTENSITY = 0.1;
const MAX_TOUCHDOWN_SHAKE_INTENSITY = 3;

// The smallest descent rate that produces a shake. Matches the landing
// detector's default touchdown minimum so greasers still get a soft bump.
export const MIN_TOUCHDOWN_SHAKE_VS_FPM = 50;

// Hard ceilings, well inside the sidecar's own bounds (2 m / 15 deg).
const MAX_SAMPLE_OFFSET_METERS = 0.25;
const MAX_SAMPLE_ANGLE_DEGREES = 6;

const DEFAULT_TICK_MS = 16;
const DEFAULT_SETTLE_ZERO_DELAY_MS = 60;

export type ShakeSample = {
  /** Degrees. Positive = nose down (camera looks further down). */
  pitch: number;
  /** Degrees. Positive = right wing down. */
  bank: number;
  /** Degrees. Positive = nose right. */
  heading: number;
  /** Metres, lateral. Positive = right. */
  dx: number;
  /** Metres, vertical. Positive = up. */
  dy: number;
  /** Metres, longitudinal. Positive = forward. */
  dz: number;
};

export const ZERO_SHAKE_SAMPLE: Readonly<ShakeSample> = Object.freeze({
  pitch: 0,
  bank: 0,
  heading: 0,
  dx: 0,
  dy: 0,
  dz: 0,
});

export type TouchdownShakeProfile = {
  vsFpm: number;
  /** 0..1, derived from touchdown vertical speed. */
  severity: number;
  intensity: number;
  seed: number;
  durationMs: number;
  /** Largest downward camera drop in metres (positive number). */
  peakDropMeters: number;
  /** Largest nose-down pitch in degrees (positive number). */
  peakPitchDegrees: number;
  sample(tSeconds: number): ShakeSample;
};

export type BuildTouchdownShakeProfileOptions = {
  intensity?: number;
  /** Seeds the rumble phases and wobble direction. Random when omitted. */
  seed?: number;
};

export function normalizeTouchdownShakeMethod(
  raw: unknown,
  fallback: TouchdownShakeMethod = DEFAULT_TOUCHDOWN_SHAKE_METHOD,
): TouchdownShakeMethod {
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim().toLowerCase();
  return (TOUCHDOWN_SHAKE_METHODS as readonly string[]).includes(value)
    ? (value as TouchdownShakeMethod)
    : fallback;
}

export function normalizeTouchdownShakeIntensity(
  raw: unknown,
  fallback: number = DEFAULT_TOUCHDOWN_SHAKE_INTENSITY,
): number {
  const value = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
  if (!Number.isFinite(value)) return fallback;
  return clamp(value, MIN_TOUCHDOWN_SHAKE_INTENSITY, MAX_TOUCHDOWN_SHAKE_INTENSITY);
}

/**
 * Map touchdown vertical speed to a 0..1 severity. -100 fpm is a greaser
 * (~0.16), -400 fpm a normal airline landing (~0.48), -1000 fpm and beyond a
 * hard landing (1.0).
 */
export function touchdownShakeSeverity(vsFpm: number): number {
  const descent = Math.abs(vsFpm);
  if (!Number.isFinite(descent)) return 0;
  return clamp(Math.pow(descent / 1000, 0.8), 0.1, 1);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** A single-hump impulse that rises from 0, peaks at exactly 1 when t === tau, then decays. */
function pulse(t: number, tau: number): number {
  if (t <= 0) return 0;
  const x = t / tau;
  return x * Math.exp(1 - x);
}

/** Deterministic 0..1 generator (mulberry32) so a seed reproduces a shake exactly. */
function createRandom(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildTouchdownShakeProfile(
  vsFpm: number,
  options: BuildTouchdownShakeProfileOptions = {},
): TouchdownShakeProfile {
  const intensity = normalizeTouchdownShakeIntensity(options.intensity);
  const seed = Number.isFinite(options.seed)
    ? (Number(options.seed) >>> 0)
    : (Math.floor(Math.random() * 0xffffffff) >>> 0);
  const severity = touchdownShakeSeverity(vsFpm);
  // Round first so durationMs / 1000 is exactly the instant the profile is zero.
  const durationMs = Math.round((0.95 + 0.85 * severity) * 1000);
  const durationSec = durationMs / 1000;

  const random = createRandom(seed);
  const phase = [0, 0, 0, 0, 0, 0, 0].map(() => random() * Math.PI * 2);
  const wobbleSign = random() < 0.5 ? -1 : 1;

  // Compression jolt (metres, degrees).
  const dropAmp = intensity * (0.012 + 0.058 * severity);
  const nodAmp = intensity * (0.35 + 1.65 * severity);
  const lurchAmp = intensity * (0.003 + 0.012 * severity);

  // Rumble.
  const rumbleTau = 0.22 + 0.33 * severity;
  const rumbleBankAmp = intensity * (0.12 + 0.45 * severity);
  const rumblePitchAmp = intensity * (0.08 + 0.3 * severity);
  const rumbleHeadingAmp = intensity * (0.05 + 0.18 * severity);
  const rumbleDyAmp = intensity * (0.002 + 0.007 * severity);
  const rumbleDxAmp = intensity * (0.0015 + 0.005 * severity);

  // Lateral wobble.
  const wobbleAmp = intensity * (0.2 + 0.7 * severity);

  const fadeSec = 0.18;

  const sample = (tSeconds: number): ShakeSample => {
    const t = Number(tSeconds);
    if (!Number.isFinite(t) || t <= 0 || t >= durationSec) return { ...ZERO_SHAKE_SAMPLE };

    const fade = clamp((durationSec - t) / fadeSec, 0, 1);
    const onset = clamp(t / 0.03, 0, 1);

    // 1. Strut compression: drop, rebound, settle.
    const jolt = pulse(t, 0.07)
      - 0.5 * pulse(t - 0.17, 0.08)
      + 0.2 * pulse(t - 0.36, 0.09)
      - 0.08 * pulse(t - 0.56, 0.1);
    const nod = pulse(t, 0.09)
      - 0.45 * pulse(t - 0.2, 0.1)
      + 0.15 * pulse(t - 0.42, 0.12);
    const lurch = pulse(t, 0.1) - 0.3 * pulse(t - 0.3, 0.12);

    // 2. Rumble.
    const env = onset * Math.exp(-t / rumbleTau);
    const twoPi = Math.PI * 2;
    const rumbleBank = rumbleBankAmp * env
      * (0.6 * Math.sin(twoPi * 12.5 * t + phase[0]) + 0.4 * Math.sin(twoPi * 19 * t + phase[1]));
    const rumblePitch = rumblePitchAmp * env
      * (0.6 * Math.sin(twoPi * 15.5 * t + phase[2]) + 0.4 * Math.sin(twoPi * 23 * t + phase[3]));
    const rumbleHeading = rumbleHeadingAmp * env * Math.sin(twoPi * 10.5 * t + phase[4]);
    const rumbleDy = rumbleDyAmp * env * Math.sin(twoPi * 14 * t + phase[5]);
    const rumbleDx = rumbleDxAmp * env * Math.sin(twoPi * 11 * t + phase[6]);

    // 3. Lateral wobble.
    const wobble = wobbleSign * wobbleAmp * Math.exp(-4.5 * t) * Math.sin(twoPi * 1.7 * t);

    return {
      pitch: clamp((nodAmp * nod + rumblePitch) * fade, -MAX_SAMPLE_ANGLE_DEGREES, MAX_SAMPLE_ANGLE_DEGREES),
      bank: clamp((wobble + rumbleBank) * fade, -MAX_SAMPLE_ANGLE_DEGREES, MAX_SAMPLE_ANGLE_DEGREES),
      heading: clamp(rumbleHeading * fade, -MAX_SAMPLE_ANGLE_DEGREES, MAX_SAMPLE_ANGLE_DEGREES),
      dx: clamp(rumbleDx * fade, -MAX_SAMPLE_OFFSET_METERS, MAX_SAMPLE_OFFSET_METERS),
      dy: clamp((-dropAmp * jolt + rumbleDy) * fade, -MAX_SAMPLE_OFFSET_METERS, MAX_SAMPLE_OFFSET_METERS),
      dz: clamp(lurchAmp * lurch * fade, -MAX_SAMPLE_OFFSET_METERS, MAX_SAMPLE_OFFSET_METERS),
    };
  };

  return {
    vsFpm,
    severity,
    intensity,
    seed,
    durationMs,
    peakDropMeters: dropAmp,
    peakPitchDegrees: nodAmp,
    sample,
  };
}

export type ShakeTransport = {
  send(sample: ShakeSample): void;
};

export const TOUCHDOWN_SHAKE_DISABLED = true;

export type TouchdownShakeRunner = {
  readonly active: boolean;
  /** True after the shake finished while its trailing settle write is still pending. */
  readonly settling: boolean;
  cancel(): void;
};

type TimerHandle = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | { unref?: () => void } | number;

export type RunTouchdownShakeOptions = {
  tickMs?: number;
  /** A second zero write shortly after the last one, in case a frame was dropped. */
  settleZeroDelayMs?: number;
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => TimerHandle;
  clearIntervalFn?: (handle: TimerHandle) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
  onComplete?: (reason: 'finished' | 'cancelled') => void;
};

function unrefTimer(handle: TimerHandle): void {
  try {
    (handle as { unref?: () => void })?.unref?.();
  } catch {}
}

/**
 * Play a profile through a transport on wall-clock time. The transport always
 * receives a zero sample last, both on natural completion and on cancel, and a
 * second zero shortly after completion.
 */
export function runTouchdownShake(
  profile: TouchdownShakeProfile,
  transport: ShakeTransport,
  options: RunTouchdownShakeOptions = {},
): TouchdownShakeRunner {
  const tickMs = Number.isFinite(options.tickMs) && Number(options.tickMs) > 0 ? Number(options.tickMs) : DEFAULT_TICK_MS;
  const settleZeroDelayMs = Number.isFinite(options.settleZeroDelayMs)
    ? Math.max(0, Number(options.settleZeroDelayMs))
    : DEFAULT_SETTLE_ZERO_DELAY_MS;
  const now = options.now || Date.now;
  const setIntervalFn = options.setIntervalFn || ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = options.clearIntervalFn || ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const setTimeoutFn = options.setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = options.clearTimeoutFn || ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let active = true;
  let interval: TimerHandle | null = null;
  let settleTimer: TimerHandle | null = null;
  const durationSec = profile.durationMs / 1000;
  const startedAt = now();

  const sendSafe = (sample: ShakeSample) => {
    try {
      transport.send(sample);
    } catch {}
  };

  const clearTimers = () => {
    if (interval != null) {
      clearIntervalFn(interval);
      interval = null;
    }
    if (settleTimer != null) {
      clearTimeoutFn(settleTimer);
      settleTimer = null;
    }
  };

  let completed = false;
  const complete = (reason: 'finished' | 'cancelled') => {
    if (completed) return;
    completed = true;
    try {
      options.onComplete?.(reason);
    } catch {}
  };

  // A finished shake still owns one trailing zero write. Completion is
  // reported only once that write has gone out (or been dropped by cancel),
  // so whoever tracks the active runner can always reach and cancel it; a
  // bounce or a second Test Shake inside the settle window must not get a
  // stray zero frame from the previous shake.
  const finish = (reason: 'finished' | 'cancelled') => {
    if (!active) return;
    active = false;
    clearTimers();
    sendSafe({ ...ZERO_SHAKE_SAMPLE });
    if (reason === 'finished' && settleZeroDelayMs > 0) {
      settleTimer = setTimeoutFn(() => {
        settleTimer = null;
        sendSafe({ ...ZERO_SHAKE_SAMPLE });
        complete('finished');
      }, settleZeroDelayMs);
      unrefTimer(settleTimer);
      return;
    }
    complete(reason);
  };

  // Establish the overlay at zero before the first non-zero frame.
  sendSafe({ ...ZERO_SHAKE_SAMPLE });

  interval = setIntervalFn(() => {
    if (!active) return;
    const t = (now() - startedAt) / 1000;
    if (t >= durationSec) {
      finish('finished');
      return;
    }
    sendSafe(profile.sample(t));
  }, tickMs);
  unrefTimer(interval);

  return {
    get active() {
      return active;
    },
    get settling() {
      return !active && settleTimer != null;
    },
    cancel() {
      if (active) {
        finish('cancelled');
        return;
      }
      // Finished but not yet settled: drop the trailing write. The shake
      // itself did finish, so that is what gets reported.
      if (settleTimer != null) {
        clearTimers();
        complete('finished');
      }
    },
  };
}
