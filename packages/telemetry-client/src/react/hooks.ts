/**
 * hooks.ts
 *
 * React hooks for consuming Flight Fabric telemetry inside React components.
 * All hooks require a TelemetryClient to be provided via TelemetryProvider
 * (from context.ts) higher in the component tree.
 *
 * Primary hooks:
 *   useTelemetry()              — full TelemetryState; re-renders on every update
 *   useTelemetrySelector(fn)    — derived value; re-renders only when result changes
 *   useLandingHistory()         — recent landing events
 *   useFlightPhase()            — current flight phase string
 */

import { useState, useEffect, useRef } from 'react';
import type {
  TelemetryState,
  TelemetryMessage,
  Phase,
  LandingMessage,
} from '@flight-fabric/telemetry-types';
import { PHASE } from '@flight-fabric/telemetry-types';
import { useTelemetryClient } from './context';

/**
 * Hook to access the full telemetry state.
 * Re-renders on every state update.
 */
export function useTelemetry(): TelemetryState {
  const client = useTelemetryClient();
  const [state, setState] = useState(() => client.getState());

  useEffect(() => {
    return client.subscribe(setState);
  }, [client]);

  return state;
}

/**
 * Hook to access a specific slice of telemetry state.
 * Only re-renders when the selected value changes.
 */
export function useTelemetrySelector<T>(
  selector: (state: TelemetryState) => T,
  equalityFn: (a: T, b: T) => boolean = Object.is
): T {
  const client = useTelemetryClient();
  const [value, setValue] = useState(() => selector(client.getState()));
  const selectorRef = useRef(selector);
  const equalityFnRef = useRef(equalityFn);

  // Update refs on each render
  selectorRef.current = selector;
  equalityFnRef.current = equalityFn;

  useEffect(() => {
    return client.subscribe((state) => {
      const newValue = selectorRef.current(state);
      setValue((prev) => {
        if (equalityFnRef.current(prev, newValue)) {
          return prev;
        }
        return newValue;
      });
    });
  }, [client]);

  return value;
}

/**
 * Hook to access the current flight phase.
 */
export function usePhase(): Phase | null {
  return useTelemetrySelector((state) => state.phase);
}

/**
 * Hook to check if in a specific phase or phases.
 */
export function useIsPhase(...phases: Phase[]): boolean {
  const phase = usePhase();
  return phase !== null && phases.includes(phase);
}

/**
 * Hook for approach-related state (phase is APPROACH or LANDING).
 */
export function useApproach() {
  return useTelemetrySelector(
    (state) => ({
      isApproaching:
        state.phase === PHASE.APPROACH || state.phase === PHASE.LANDING,
      phase: state.phase,
      altitude: state.altitude,
      ias: state.ias,
      vs: state.vs,
      runwayContext: state.runwayContext,
      stabilityScore: state.stabilityScore,
      stabilityBreakdown: state.stabilityBreakdown,
      envelopeStatus: state.envelopeStatus,
    }),
    shallowEqual
  );
}

/**
 * Hook for aircraft systems state.
 */
export function useAircraftSystems() {
  return useTelemetrySelector(
    (state) => ({
      lights: state.lights,
      gear: state.gear,
      flaps: state.flaps,
      spoilers: state.spoilers,
      engines: state.engines,
    }),
    shallowEqual
  );
}

/**
 * Hook for position and attitude.
 */
export function usePositionAttitude() {
  return useTelemetrySelector(
    (state) => ({
      position: state.position,
      attitude: state.attitude,
      surface: state.surface,
    }),
    shallowEqual
  );
}

/**
 * Hook for the most recent landing.
 */
export function useLastLanding(): LandingMessage | null {
  return useTelemetrySelector((state) => state.lastLanding);
}

/**
 * Hook for flight time.
 */
export function useFlightTime() {
  return useTelemetrySelector((state) => state.flightTime, shallowEqual);
}

/**
 * Hook for connection status.
 */
export function useConnectionStatus() {
  return useTelemetrySelector(
    (state) => ({
      connected: state.connected,
      lastMessageAt: state.lastMessageAt,
    }),
    shallowEqual
  );
}

/**
 * Hook for subscribing to specific message types.
 * Useful for events that don't update state (beats, callouts, crew responses).
 */
export function useMessageSubscription<T extends TelemetryMessage>(
  messageType: string,
  handler: (message: T) => void
): void {
  const client = useTelemetryClient();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    return client.subscribeToMessages((msg) => {
      if (msg.type === messageType) {
        handlerRef.current(msg as T);
      }
    });
  }, [client, messageType]);
}

// ============================================================================
// Utilities
// ============================================================================

function shallowEqual<T>(a: T, b: T): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (a === null || b === null) return false;

  const keysA = Object.keys(a) as Array<keyof T>;
  const keysB = Object.keys(b) as Array<keyof T>;

  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }

  return true;
}
