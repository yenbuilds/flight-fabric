// Centralized time source for deterministic replay and testing.
//
// ARCHITECTURAL FIX: Decouples core logic from wall-clock time.
// All modules should use this instead of Date.now() directly.
//
// Usage:
//   const time = require('./time-source');
//   const now = time.now();        // milliseconds
//   const iso = time.nowIso();     // ISO string
//
// For testing/replay:
//   time.setTimeSource(() => fakeMs, () => fakeIso);
//   time.resetTimeSource();  // restore wall clock

export type TimeContext = {
  nowEpochMs: number;
  nowIso: string;
  flightStartEpochMs: number | null;
  flightStartIso: string;
};

export type FixedSourceController = {
  advance: (ms: number) => void;
  set: (ms: number) => void;
  get: () => number;
};

let currentNow: () => number = () => Date.now();
let currentNowIso: () => string = () => new Date().toISOString();

/**
 * Get current time in milliseconds.
 */
export function now(): number {
  return currentNow();
}

/**
 * Get current time as ISO string.
 */
export function nowIso(): string {
  return currentNowIso();
}

/**
 * Create a time context object for passing to functions.
 * Bundles epochMs, iso, and optional flight start info.
 */
export function createContext(flightStartEpochMs: number | null = null, flightStartIso = ''): TimeContext {
  const epochMs = now();
  return {
    nowEpochMs: epochMs,
    nowIso: nowIso(),
    flightStartEpochMs,
    flightStartIso,
  };
}

/**
 * Replace the time source for testing or replay.
 */
export function setTimeSource(nowFn: () => number, isoFn?: () => string): void {
  if (typeof nowFn !== 'function') {
    throw new Error('[time-source] nowFn must be a function');
  }

  currentNow = nowFn;
  currentNowIso = typeof isoFn === 'function' ? isoFn : () => new Date(nowFn()).toISOString();
}

/**
 * Create a fixed time source for testing.
 */
export function createFixedSource(fixedMs = Date.now()): FixedSourceController {
  let current = fixedMs;

  const source: FixedSourceController = {
    advance: (ms) => {
      current += ms;
    },
    set: (ms) => {
      current = ms;
    },
    get: () => current,
  };

  setTimeSource(() => current, () => new Date(current).toISOString());

  return source;
}

/**
 * Reset to wall-clock time.
 */
export function resetTimeSource(): void {
  currentNow = () => Date.now();
  currentNowIso = () => new Date().toISOString();
}
