// Central event bus for decoupling emission from transport.

const Debug = require('./debug.js') as typeof import('./debug');

export type EventHandler = (payload: unknown) => void;

const listeners = new Map<string, Set<EventHandler>>();
let debugEnabled = false;

export function setDebug(enabled: boolean): void {
  debugEnabled = !!enabled;
}

export function emit(event: string, payload: unknown): void {
  if (debugEnabled) {
    Debug.log('event-bus', `emit: ${event}`, payload);
  }

  const handlers = listeners.get(event);
  if (!handlers || handlers.size === 0) return;

  for (const handler of handlers) {
    try {
      handler(payload);
    } catch (error) {
      const err = error as Error;
      console.error(`[event-bus] Handler error for '${event}':`, err.message || err);
    }
  }
}

export function on(event: string, handler: EventHandler): () => void {
  if (typeof handler !== 'function') {
    throw new Error('[event-bus] handler must be a function');
  }

  if (!listeners.has(event)) {
    listeners.set(event, new Set());
  }

  listeners.get(event)!.add(handler);
  return () => off(event, handler);
}

export function once(event: string, handler: EventHandler): () => void {
  const wrapper: EventHandler = (payload) => {
    off(event, wrapper);
    handler(payload);
  };
  return on(event, wrapper);
}

export function off(event: string, handler: EventHandler): void {
  const handlers = listeners.get(event);
  if (handlers) {
    handlers.delete(handler);
  }
}

export function removeAllListeners(event?: string): void {
  if (event) {
    listeners.delete(event);
  } else {
    listeners.clear();
  }
}

export function listenerCount(event: string): number {
  const handlers = listeners.get(event);
  return handlers ? handlers.size : 0;
}

export function eventNames(): string[] {
  return Array.from(listeners.keys());
}

// ============================================================================
// STANDARD EVENT NAMES (documentation / type hints)
// ============================================================================
// Telemetry streams (high frequency, per-poll):
//   telemetry:{wsType} - mirrored automatically by ws-broadcaster for every
//                        backend WebSocket payload with a `type` field
//   telemetry:frame     - normalized full telemetry frame
//   telemetry:vs        - { value: number }
//   telemetry:ias       - { value: number }
//   telemetry:altitude  - { msl: number, ra: number }
//   telemetry:phase     - { value: string }
//   telemetry:profile   - profile activation payload
//   telemetry:gear      - { data: object }
//   telemetry:flaps     - { value: object }
//   telemetry:spoilers  - { value: object }
//   telemetry:throttle  - { value: object }
//   telemetry:engines   - { data: object }
//   telemetry:lights    - { data: object }
//   telemetry:attitude  - { pitchDeg, bankDeg, valid }
//   telemetry:position  - { lat, lon, hdg }
//   telemetry:surface   - { value: object }
//   telemetry:xwind     - { value: number|null }
//   telemetry:iast      - { value: number }
//   telemetry:healthWarning - provider health warning
//   telemetry:limitChanged  - provider telemetry limit changed
//
// Flight lifecycle:
//   flight:started      - { flightId, reason, timestamp }
//   flight:ended        - { flightId, timestamp }
//   flight:time         - { startedAt, now, elapsedMs, elapsedSec, elapsedHms }
//   simconnect:aircraftChanged - {
//     title, previousTitle,                  // legacy aliases
//     aircraftConfigPath, previousAircraftConfigPath,
//     displayName, previousDisplayName,
//     xplane, previousXplane,                // { acfPath, acfFileName, id } when sourced from X-Plane
//   }
//   simconnect:dataReaderExhausted - SimConnect reader exhaustion warning
//
// Landing events:
//   landing:touchdown   - { vs_fpm, grade, gforce, ... }
//   landing:early       - early touchdown payload for immediate effects
//   landing:final       - { vs_fpm, grade, gforce, runwayExcursion, ... }
//
// Phase events:
//   phase:changed       - { from, to, timestamp }
//   phase:goAround      - { altitude, aircraft }
//
// Stability events:
//   stability:score     - { score, breakdown }
//   stability:ultimate  - { score, breakdown, samples, gateStable }
//
// Simulator warnings:
//   sim:overspeed       - { active, ias, overspeedType, ... }
//   sim:stall           - { active, ias, ... }
//   sim:fuelExhausted   - fuel exhausted warning payload
//   sim:cabinAltitude   - cabin altitude warning payload
//
// Profiles, storage, and violations:
//   profile:fallback    - profile fallback selected
//   flightViolation:start - in-flight violation started
//   flightViolation:end   - in-flight violation ended
//   convectiveRisk:start  - convective exposure likelihood started
//   convectiveRisk:end    - convective exposure likelihood ended
//   storage:diskExhausted - CSV writer disk exhaustion warning
//
// Beat events (UI animation cues):
//   beat:*              - { event, detail }
