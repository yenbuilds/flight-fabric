/**
 * React hooks for Flight Fabric telemetry.
 */

export { TelemetryContext, useTelemetryClient } from './context';
export { TelemetryProvider, type TelemetryProviderProps } from './provider';
export {
  // Core hooks
  useTelemetry,
  useTelemetrySelector,
  usePhase,
  useIsPhase,
  // Domain hooks
  useApproach,
  useAircraftSystems,
  usePositionAttitude,
  useLastLanding,
  useFlightTime,
  useConnectionStatus,
  // Event hooks
  useMessageSubscription,
} from './hooks';

// Re-export types
export type {
  TelemetryState,
  TelemetryMessage,
  Phase,
} from '@flight-fabric/telemetry-types';

export { PHASE, MSG } from '@flight-fabric/telemetry-types';
