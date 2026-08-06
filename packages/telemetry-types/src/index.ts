/**
 * @flight-fabric/telemetry-types
 *
 * TypeScript type definitions for Flight Fabric telemetry WebSocket messages.
 * Zero-runtime package - exports only types and constants.
 */

// Enums and constants
export {
  MSG,
  PHASE,
  ENVELOPE_STATUS,
  type MessageType,
  type Phase,
  type EnvelopeStatus,
} from './enums';

// Message types
export type {
  BaseMessage,
  // Scalar streams
  IASMessage,
  VSMessage,
  AltitudeMessage,
  IASTrendMessage,
  CrosswindMessage,
  PhaseMessage,
  EnvelopeStatusMessage,
  // Stability
  StabilityBreakdown,
  StabilityBreakdownDetail,
  StabilityBreakdownDetails,
  StabilityScoreMessage,
  UltimateStabilityScoreMessage,
  // Structured data
  LightsData,
  LightsMessage,
  GearData,
  GearMessage,
  FlapsData,
  FlapsMessage,
  SpoilersData,
  SpoilersMessage,
  EnginesData,
  EnginesMessage,
  // Landing
  TouchdownDistance,
  LandingMessage,
  // Context
  RunwayContextMessage,
  SafetyAccident,
  SafetyReport,
  SafetyDataMessage,
  // Attitude & position
  AttitudeMessage,
  SurfaceData,
  SurfaceMessage,
  PositionMessage,
  // Events
  CalloutMessage,
  // Time & lifecycle
  FlightTimeMessage,
  FlightStartedMessage,
  FlightEndedMessage,
  // Aircraft profile
  AircraftControlCapabilities,
  AircraftProfileData,
  AircraftProfileMessage,
  AircraftSpecificPrimitive,
  AircraftSpecificSourceStatus,
  AircraftSpecificStateMessage,
  // Signal reliability
  SignalReliabilityLevel,
  SignalReliabilityMap,
  SignalReliabilityMessage,
  // Debug
  DebugEntry,
  DebugMessage,
  ThrottleMessage,
  RatesMessage,
  // System
  ConnectedMessage,
  // Union
  TelemetryMessage,
} from './messages';

// State
export { type TelemetryState, createInitialState } from './state';

// Commands (client → server)
export type {
  BaseCommand,
  TelemetryCommand,
} from './commands';
