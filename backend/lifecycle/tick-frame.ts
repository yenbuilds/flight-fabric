// Canonical telemetry value for one core processing cycle.
//
// The provider frame is copied before it is frozen, so consumers cannot alter
// each other's view of the cycle and provider-owned data remains untouched.

const { performance } = require('node:perf_hooks') as typeof import('node:perf_hooks');
const timeSource = require('../core/time-source.js') as typeof import('../core/time-source');

export type ClockLike = {
  now: () => number;
};

export type FreezeFn = <T>(obj: T) => T;

export type TickFrameMeta = Readonly<{
  sequence: number;
  timestampMs: number;
  timestampIso: string;
  actualDeltaMs: number | null;
}>;

export type TickFrame = Readonly<Record<string, unknown> & {
  meta: TickFrameMeta;

  // Compatibility aliases retained for existing consumers.
  tickNumber: number;
  timestampMs: number;
  timestampIso: string;
  pollRateMs: number;
  deltaSec: number;
}>;

export type TickFrameFactory = {
  create: (rawFrame: Record<string, unknown>) => TickFrame;
  getTickCount: () => number;
  reset: () => void;
};

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clonePlainTelemetry<T>(obj: T): T {
  function cloneValue(value: unknown, ancestors: Set<object>): unknown {
    if (
      value === null
      || value === undefined
      || typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
    ) {
      return value;
    }
    if (typeof value !== 'object') {
      throw new TypeError(`[tick-frame] telemetry contains unsupported ${typeof value} data`);
    }
    if (ancestors.has(value)) {
      throw new TypeError('[tick-frame] telemetry must not contain circular references');
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(value);

    if (Array.isArray(value)) {
      return value.map((entry) => cloneValue(entry, nextAncestors));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      const typeName = prototype?.constructor?.name || 'non-plain object';
      throw new TypeError(`[tick-frame] telemetry contains unsupported ${typeName} data`);
    }

    const result: Record<string, unknown> = prototype === null ? Object.create(null) : {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: cloneValue(entry, nextAncestors),
        writable: true,
      });
    }
    return result;
  }

  return cloneValue(obj, new Set()) as T;
}

export function defaultFreeze<T>(obj: T): T {
  const seen = new WeakSet<object>();

  function freezeValue(value: unknown): void {
    if (!value || typeof value !== 'object') return;

    const objectValue = value as object;
    if (seen.has(objectValue)) return;
    seen.add(objectValue);

    for (const key of Reflect.ownKeys(objectValue)) {
      freezeValue((objectValue as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(objectValue);
  }

  freezeValue(obj);
  return obj;
}

export function createTickFrame(
  rawFrame: Record<string, unknown>,
  options: {
    tickNumber?: number;
    nowEpochMs?: number;
    pollRateMs?: number;
    actualDeltaMs?: number | null;
    freeze?: FreezeFn;
  } = {},
): TickFrame {
  const {
    tickNumber = 0,
    nowEpochMs = timeSource.now(),
    pollRateMs = 100,
    actualDeltaMs = null,
    freeze = defaultFreeze,
  } = options;

  const targetPeriodMs = Math.max(1, finiteOrNull(pollRateMs) ?? 100);
  const measuredDeltaMs = finiteOrNull(actualDeltaMs);
  const timestampIso = new Date(nowEpochMs).toISOString();
  const meta: TickFrameMeta = {
    sequence: tickNumber,
    timestampMs: nowEpochMs,
    timestampIso,
    actualDeltaMs: measuredDeltaMs === null ? null : Math.max(0, measuredDeltaMs),
  };

  const tickFrame = {
    // Telemetry is copied and spread first so it cannot replace core metadata.
    ...clonePlainTelemetry(rawFrame),
    meta,
    tickNumber: meta.sequence,
    timestampMs: meta.timestampMs,
    timestampIso: meta.timestampIso,
    pollRateMs: targetPeriodMs,
    deltaSec: targetPeriodMs / 1000,
  };

  return freeze(tickFrame) as TickFrame;
}

export function createTickFrameFactory(options: {
  timeSource?: ClockLike;
  monotonicTimeSource?: ClockLike;
  pollRateMs?: number;
  freeze?: FreezeFn;
} = {}): TickFrameFactory {
  const {
    timeSource: wallClock = timeSource,
    monotonicTimeSource: monotonicClock = performance,
    pollRateMs = 100,
    freeze = defaultFreeze,
  } = options;

  let tickCounter = 0;
  let previousMonotonicMs: number | null = null;

  return {
    create(rawFrame: Record<string, unknown>) {
      const nowEpochMs = wallClock.now();
      const nowMonotonicMs = monotonicClock.now();
      const actualDeltaMs = previousMonotonicMs === null
        ? null
        : Math.max(0, nowMonotonicMs - previousMonotonicMs);
      const frame = createTickFrame(rawFrame, {
        tickNumber: tickCounter,
        nowEpochMs,
        pollRateMs,
        actualDeltaMs,
        freeze,
      });
      previousMonotonicMs = nowMonotonicMs;
      tickCounter += 1;
      return frame;
    },

    getTickCount() {
      return tickCounter;
    },

    reset() {
      tickCounter = 0;
      previousMonotonicMs = null;
    },
  };
}
