/**
 * @flight-fabric/telemetry-client
 *
 * WebSocket client for Flight Fabric telemetry.
 */

export { TelemetryClient } from './client';
export type {
  TelemetryClientOptions,
  TelemetryListener,
  MessageListener,
} from './client';

// Re-export React components and hooks for consumers that don't support subpath exports
export {
  TelemetryContext,
  useTelemetryClient,
  TelemetryProvider,
  useTelemetry,
  useTelemetrySelector,
  usePhase,
  useIsPhase,
  useApproach,
  useAircraftSystems,
  usePositionAttitude,
  useLastLanding,
  useFlightTime,
  useConnectionStatus,
  useMessageSubscription,
} from './react';

export type {
  TelemetryProviderProps,
} from './react';

// Re-export types for convenience
export type {
  TelemetryState,
  TelemetryMessage,
  TelemetryCommand,
  Phase,
  EnvelopeStatus,
} from '@flight-fabric/telemetry-types';

export {
  MSG,
  PHASE,
  ENVELOPE_STATUS,
  createInitialState,
} from '@flight-fabric/telemetry-types';
