/**
 * messages.ts
 *
 * TypeScript interfaces for every WebSocket message payload broadcast by the
 * Flight Fabric backend. This is the canonical type contract for external
 * consumers of the API: the mobile app, telemetry-client, OBS strip overlays,
 * and external integrations.
 *
 * Each interface corresponds to one MSG constant in enums.ts and one
 * broadcast({}) call in the backend. The `type` field is the wire string that
 * identifies the message on the WebSocket connection.
 *
 * Keeping this file accurate:
 *   - When a backend broadcast shape changes, update the matching interface here.
 *   - When adding a new interface with a backend broadcast, also register a field
 *     parity test in tests/scripts/test-package-drift.js (see the comment above the
 *     "Autopilot, controls, environment, and fuel" section below for an example).
 *   - Run `npm run typecheck` in this package after changes to confirm no errors.
 */

import type { EnvelopeStatus, Phase } from './enums';

// ============================================================================
// Base message interface
// ============================================================================

export interface BaseMessage {
  type: string;
}

// ============================================================================
// Scalar stream messages
// ============================================================================

/** Indicated airspeed in knots */
export interface IASMessage extends BaseMessage {
  type: 'ias';
  value: number;
}

/** Vertical speed in feet per minute */
export interface VSMessage extends BaseMessage {
  type: 'vs';
  value: number;
}

/** Independent altitude and barometer diagnostics */
export interface AltitudeMessage extends BaseMessage {
  type: 'altitude';
  /** Legacy pilot-adjustable indicated altitude. */
  msl: number;
  indicated: number | null;
  calibrated: number | null;
  plane: number | null;
  ra: number;
  aircraftAgl: number | null;
  aircraftAboveObstacles: number | null;
  planeAgl: number | null;
  planeAglMinusCg: number | null;
  pressureAlt: number | null;
  kohlsmanSettingMb: number | null;
  kohlsmanTunedMb: number | null;
  kohlsmanStd: boolean | null;
}

/** IAS trend (knots delta per poll) */
export interface IASTrendMessage extends BaseMessage {
  type: 'iast';
  value: number;
}

/** Crosswind component (+ = right, - = left) */
export interface CrosswindMessage extends BaseMessage {
  type: 'xwind';
  value: number;
}

/** Flight phase */
export interface PhaseMessage extends BaseMessage {
  type: 'phase';
  value: Phase;
}

/** Envelope status (observational) */
export interface EnvelopeStatusMessage extends BaseMessage {
  type: 'envelopeStatus';
  value: EnvelopeStatus;
}

// ============================================================================
// Stability scoring
// ============================================================================

export interface StabilityBreakdown {
  speed_ok?: number | null;
  speed_trend_ok?: number | null;
  vs_ok?: number | null;
  glidepath_ok?: number | null;
  glidepath_below_ok?: number | null;
  glidepath_above_ok?: number | null;
  pitch_ok?: number | null;
  bank_ok?: number | null;
  lateral_offset_ok?: number | null;
  thrust_ok?: number | null;
  thrust_not_idle_ok?: number | null;
  thrust_stable_ok?: number | null;
  config_ok?: number;
  flaps_ok?: number;
  spoilers_ok?: number;
  gear_ok?: number;
}

/** Detail explaining why a stability criterion scored a certain percentage */
export interface StabilityBreakdownDetail {
  status: 'ok' | 'failed';
  message: string;
  failedCount?: number;
  worstValue?: number | string | null;
  threshold?: number | string;
  unit?: string;
}

/** Breakdown details keyed by criterion name */
export interface StabilityBreakdownDetails {
  [key: string]: StabilityBreakdownDetail;
}

/** Real-time stability score (disabled by default) */
export interface StabilityScoreMessage extends BaseMessage {
  type: 'stabilityScore';
  score: number | null;
  breakdown: StabilityBreakdown | null;
}

/** Ultimate stability score (emitted once on touchdown) */
export interface UltimateStabilityScoreMessage extends BaseMessage {
  type: 'ultimateStabilityScore';
  score: number | null;
  breakdown: StabilityBreakdown | null;
  samples: number;
  gateStable: boolean | null;
  gateFailures: string[];
  scoringContext: Record<string, unknown> | null;
  approachProfile: unknown[];
  /** Preferred name: Facilities/airport runway elevation datum. */
  runwayReferenceElevFt?: number | null;
  /** Geometry provider that supplied the reference, when known. */
  runwayReferenceElevationSource?: string | null;
  /** Whether the provider supplied a runway or airport reference. */
  runwayReferenceElevationKind?: 'runway' | 'airport' | string | null;
  /** Backward-compatible alias for runwayReferenceElevFt. */
  thresholdElevFt: number | null;
  runwayHdg: number | null;
  runwayWidthFt: number | null;
  runwayLengthFt: number | null;
  runwayThreshold: { lat: number; lon: number } | null;
  runwayId: string | null;
  glidepathAngle: { angleDeg: number; source: string } | null;
}

/** Variable Rate Encoding sampling diagnostics for the active flight CSV logger */
export interface VreSamplingMessage extends BaseMessage {
  type: 'vreSampling';
  active: boolean;
  band: 'BASELINE' | 'ELEVATED' | 'HIGH_FIDELITY' | 'ULTRA_FIDELITY';
  /** Evaluator-requested rate before applying the telemetry poll ceiling. */
  targetRateHz?: number;
  /** Fresh-sample rate after telemetry polling and the 10 Hz CSV safety ceiling. */
  effectiveRateHz?: number;
  /** Backward-compatible alias for effectiveRateHz. */
  rateHz: number;
  shouldSample: boolean;
  reason: string;
  escalationReasons: number;
  phase: string | null;
  raFt: number | null;
  vsFpm: number | null;
  /** Effective minimum interval between fresh CSV samples. */
  intervalMs: number;
  timeSinceLastSampleMs: number | null;
  nextSampleInMs: number | null;
  ultraFidelityDisabled: boolean;
  ultraFidelityTimeRemaining: number;
  ultraFidelitySamplesRemaining: number;
  event: string | null;
  timestamp_ms: number;
  timestamp_utc: string;
}

// ============================================================================
// Structured data messages
// ============================================================================

export interface LightsData {
  nav: boolean;
  beacon: boolean;
  landing: boolean;
  taxi: boolean;
  strobe: boolean;
  logo?: boolean;
  wing?: boolean;
  /** Runway turnoff lights; SDK path, null when unavailable */
  turnoff?: boolean | null;
  /** Panel lights; SDK path, null when unavailable */
  panel?: boolean | null;
  /** Recognition lights; SDK path, null when unavailable */
  recog?: boolean | null;
  /** Cabin lights; SDK path, null when unavailable */
  cabin?: boolean | null;
  /** False when lights are suppressed (unreliable SimVar or no authoritative source connected) */
  available?: boolean;
}

export interface LightsMessage extends BaseMessage {
  type: 'lights';
  data: LightsData;
}

export interface GearData {
  /** Left gear position normalized 0.0–1.0 (0=up, 1=down, fractional during transit) */
  left: number;
  right: number;
  nose: number;
  locked: boolean;
  parkingBrake: boolean;
  /** Broadcast-time derived summary state */
  gearState?: 'DOWN' | 'UP' | 'TRANSIT';
  /** True on the tick the gearState transitioned */
  changed?: boolean;
  /** True on the tick the parkingBrake state changed */
  parkingBrakeChanged?: boolean;
}

export interface GearMessage extends BaseMessage {
  type: 'gear';
  data: GearData;
}

export interface FlapsData {
  notch?: number | null;
  label?: string | null;
  percent?: number | null;
  fraction?: number | null;
  inTransit?: boolean;
  /** Always null; reserved for future use */
  direction?: null;
  /** Present on profile, percent, and LVAR paths; absent on angle-generic path */
  currentNotch?: number;
  /** Present on profile, percent, and LVAR paths; absent on angle-generic path */
  targetNotch?: number;
  source?: 'profile' | 'angle-generic' | 'percent' | 'lvar';
}

export interface FlapsMessage extends BaseMessage {
  type: 'flaps';
  value: FlapsData;
}

export interface SpoilersData {
  /** Null when suppressed (unreliable SimVar or no authoritative source connected) */
  percent: number | null;
  fraction: number | null;
  state: 'STOWED' | 'ARMED' | 'EXTENDED' | null;
  /** False when suppressed */
  available?: boolean;
  /** Override source when a higher-trust provider is connected */
  _source?: 'lvar' | 'sdk';
}

export interface SpoilersMessage extends BaseMessage {
  type: 'spoilers';
  value: SpoilersData;
}

export interface EnginesData {
  count: number;
  source: 'sdk' | 'throttle' | 'simconnect' | 'n1' | 'xplane';
  eng1: number | null;
  eng2: number | null;
  eng3: number | null;
  eng4: number | null;
  eng1Text: string;
  eng2Text: string;
  eng3Text: string;
  eng4Text: string;
}

export interface EnginesMessage extends BaseMessage {
  type: 'engines';
  data: EnginesData;
}

// ============================================================================
// Landing
// ============================================================================

export interface TouchdownDistance {
  distanceFt: number | null;
  grade: string | null;
  tdzAchieved: boolean;
  runway?: string;
}

/**
 * Landing event payload (partial — the full broadcast payload has 60+ fields).
 * See backend/landing/landing-runner.js buildLandingPayload() for the full shape.
 */
export interface LandingMessage extends BaseMessage {
  type: 'landing';
  /** Touchdown vertical speed in fpm (negative = descent) */
  vs_fpm: number;
  grade: 'PERFECT' | 'GOOD' | 'FIRM' | 'HARD' | 'VERY HARD';
  _ui_color: 'lime' | 'deepskyblue' | 'gold' | 'orange' | 'red';
  gforce: number | null;
  ias_kts?: number | null;
  gs_kts?: number | null;
  icao?: string | null;
  runway?: string | null;
  xwind_kts?: number | null;
  touchdown_distance_ft?: number | null;
  runway_occupancy_s?: number | null;
  bounce_count?: number;
  ultimate_stability_score?: number | null;
}

// ============================================================================
// Context messages
// ============================================================================

export interface RunwayContextMessage extends BaseMessage {
  type: 'runwayContext';
  icao: string | null;
  runway: string | null;
  approachType: 'ILS' | 'VISUAL' | null;
}

export interface SafetyAccident {
  date: string;
  location: string;
  type: string;
  aircraft: string;
  injuries: string;
  cause: string;
  ntsb_no: string;
}

export interface SafetyReport {
  date: string;
  synopsis: string;
  acn: string;
}

export interface SafetyDataMessage extends BaseMessage {
  type: 'safetyData';
  icao: string;
  accidents: SafetyAccident[];
  reports: SafetyReport[];
  summary: string;
}

// ============================================================================
// Attitude & position
// ============================================================================

export interface AttitudeMessage extends BaseMessage {
  type: 'attitude';
  valid: boolean;
  pitchDeg: number | null;
  bankDeg: number | null;
  pitchRad?: number;
  bankRad?: number;
  pitchSource?: string;
  bankSource?: string;
  pitchRaw?: number;
  bankRaw?: number;
  pitchDegPrimary?: number;
  bankDegPrimary?: number;
  pitchModePrimary?: string;
  bankModePrimary?: string;
}

export interface SurfaceData {
  /** Raw SimConnect surface index */
  raw?: number | null;
  class: 'PAVED' | 'UNPAVED' | 'WATER' | 'UNKNOWN';
  name: string | null;
  runwayLike: boolean;
  onGround: boolean;
  valid: boolean;
}

export interface SurfaceMessage extends BaseMessage {
  type: 'surface';
  value: SurfaceData;
}

export interface PositionMessage extends BaseMessage {
  type: 'position';
  lat: number;
  lon: number;
  /** Heading in degrees; null when unavailable */
  hdg: number | null;
}

// ============================================================================
// Events & beats
// ============================================================================

export interface CalloutMessage extends BaseMessage {
  type: 'callout';
  altitude: number;
}

// ============================================================================
// Time & lifecycle
// ============================================================================

export interface FlightTimeMessage extends BaseMessage {
  type: 'flightTime';
  startedAt: string;
  now: string;
  elapsedMs: number;
  elapsedSec: number;
  elapsedHms: string;
}

export interface FlightStartedMessage extends BaseMessage {
  type: 'flightStarted';
  timestamp: string;
}

export interface FlightEndedMessage extends BaseMessage {
  type: 'flightEnded';
  timestamp: string;
}

// ============================================================================
// Aircraft profile
// ============================================================================

export interface AircraftProfileData {
  id: string;
  name: string;
  namespace: string;
  simulator?: string;
  _profileKey?: string | null;
  _qualifiedId?: string | null;
  profileRevision?: number | null;
  aircraftSpecificTemplateId?: string | null;
  aircraftTitle?: string;
  visualSupport?: 'full' | 'partial' | 'basic' | 'none';
  /** Throttle lever behaviour for the aircraft. 'detent' = fixed detents where lever position doesn't directly reflect thrust. */
  throttleType?: 'detent' | 'servo' | 'continuous';
}

export interface AircraftControlCapabilities {
  surface: Record<string, boolean>;
  autopilot: Record<string, boolean>;
  aircraftSpecific: Record<string, boolean>;
}

/**
 * Provenance summary for quality indicators in UI.
 * This is a bump-into point for post-V1 work on profile quality indicators.
 */
export interface ProvenanceSummary {
  verificationStatus: 'unverified' | 'partial' | 'verified' | 'certified';
  dataQuality: {
    flaps?: 'unknown' | 'estimated' | 'documented' | 'verified';
    gear?: 'unknown' | 'estimated' | 'documented' | 'verified';
    spoilers?: 'unknown' | 'estimated' | 'documented' | 'verified';
    lights?: 'unknown' | 'estimated' | 'documented' | 'verified';
    stability?: 'unknown' | 'estimated' | 'documented' | 'verified';
    performance?: 'unknown' | 'estimated' | 'documented' | 'verified';
    [key: string]: 'unknown' | 'estimated' | 'documented' | 'verified' | undefined;
  };
  sourceCount: number;
  hasOfficialSource: boolean;
  lastVerified: string | null;
  knownIssues: string[];
}

export interface AircraftProfileMessage extends BaseMessage {
  type: 'aircraftProfile';
  profile: AircraftProfileData;
  controlCapabilities?: AircraftControlCapabilities;
  /** Provenance summary for UI quality indicators (null if profile has no provenance) */
  provenance: ProvenanceSummary | null;
  previousTitle?: string;
  source: 'auto-detect' | 'manual' | 'reconnect';
}

export type AircraftSpecificPrimitive = string | number | boolean;
export type AircraftSpecificSourceStatus =
  | 'connected'
  | 'stale'
  | 'disconnected'
  | 'disabled'
  | 'paused'
  | 'error'
  | 'unsupported'
  | 'awaiting-values';

export interface AircraftSpecificStateMessage extends BaseMessage {
  type: 'aircraftSpecificState';
  profileKey: string;
  profileRevision: number;
  templateId: string;
  available: boolean;
  sourceStatus: {
    overall: AircraftSpecificSourceStatus;
    sources: Record<string, AircraftSpecificSourceStatus>;
  };
  values: Record<string, AircraftSpecificPrimitive>;
  unavailable: string[];
  actionCapabilities: Record<string, boolean>;
  updatedAt: string;
}

// ============================================================================
// Signal reliability (for UI greying)
// ============================================================================

/**
 * Signal reliability level for UI display.
 * - 'authoritative': Known-good source for this aircraft (e.g., aircraft-specific LVAR)
 * - 'generic': SimConnect default (works but not aircraft-specific)
 * - 'unavailable': Cannot be read for this aircraft
 */
export type SignalReliabilityLevel = 'authoritative' | 'generic' | 'unavailable';

/**
 * Map of signal names to their reliability levels.
 * Signals not listed default to 'generic'.
 */
export interface SignalReliabilityMap {
  ias?: SignalReliabilityLevel;
  vs?: SignalReliabilityLevel;
  ra?: SignalReliabilityLevel;
  heading?: SignalReliabilityLevel;
  flapsNotch?: SignalReliabilityLevel;
  flapsFraction?: SignalReliabilityLevel;
  spoilersPercent?: SignalReliabilityLevel;
  spoilersArmed?: SignalReliabilityLevel;
  gearPosition?: SignalReliabilityLevel;
  n1?: SignalReliabilityLevel;
  autobrake?: SignalReliabilityLevel;
  vref?: SignalReliabilityLevel;
  stabilityScore?: SignalReliabilityLevel;
  [key: string]: SignalReliabilityLevel | undefined;
}

/**
 * Emitted on aircraft change to inform frontend which signals are reliable.
 * Frontend should grey out or hide signals with 'unavailable' or 'generic' reliability.
 */
export interface SignalReliabilityMessage extends BaseMessage {
  type: 'signalReliability';
  signals: SignalReliabilityMap;
  profileId: string;
  source: 'profile' | 'runtime';
}

// ============================================================================
// Autopilot, controls, environment, and fuel
//
// When adding a new interface below that has a corresponding broadcast({}) in
// the backend, register a field parity test in tests/scripts/test-package-drift.js.
//
// Example — if you add this interface:
//
//   export interface WeatherMessage extends BaseMessage {
//     type: 'weather';
//     oatC: number;
//     windKts: number;
//     windHdg: number;
//   }
//
// ...and the backend emits it via (e.g. backend/events/broadcasters.js):
//
//   broadcast({ type: MSG.WEATHER, oatC: w.oatC, windKts: w.windKts, windHdg: w.windHdg });
//
// ...then add to the "Interface field parity" section of test-package-drift.js:
//
//   test('WeatherMessage fields match sendWeather broadcast object (bidirectional)', () => {
//     const runtimeFields = getBroadcastFieldsByType(BROADCASTERS_JS, 'MSG.WEATHER');
//     assert(runtimeFields !== null, 'could not find MSG.WEATHER broadcast');
//     const tsFields = getInterfaceFields(MESSAGES_TS, 'WeatherMessage');
//     assertSetsEqual(runtimeFields, tsFields, 'WeatherMessage');
//   });
//
// ============================================================================

/** Autopilot MCP state broadcast once per telemetry frame when connected */
export interface AutopilotMessage extends BaseMessage {
  type: 'autopilot';
  master: boolean | null;
  fdActive: boolean | null;
  athrArmed: boolean | null;
  athrActive: boolean | null;
  hdgHold: boolean | null;
  navHold: boolean | null;
  lnavHold: boolean | null;
  locHold: boolean | null;
  altHold: boolean | null;
  vsHold: boolean | null;
  vnavHold: boolean | null;
  lvlChgHold: boolean | null;
  expedHold: boolean | null;
  apprHold: boolean | null;
  spdHold: boolean | null;
  hdgTarget: number | null;
  altTarget: number | null;
  vsTarget: number | null;
  spdTarget: number | null;
  machTarget: number | null;
  apReliable: boolean;
  athrReliable: boolean;
  reliabilityReason: string;
}

/** Heading in magnetic and true degrees */
export interface HeadingMessage extends BaseMessage {
  type: 'heading';
  mag: number | null;
  /** True heading in degrees. Access as msg['true'] due to reserved word. */
  'true': number | null;
}

/** Ground speed in knots */
export interface GSMessage extends BaseMessage {
  type: 'gs';
  value: number;
}

/** Pilot control input positions (yoke/sidestick + rudder) */
export interface ControlsMessage extends BaseMessage {
  type: 'controls';
  yokeX: number | null;
  yokeY: number | null;
  rudderPedalPct: number | null;
}

/** Cabin pressurization and outside air temperature */
export interface EnvironmentMessage extends BaseMessage {
  type: 'environment';
  cabinAltFt: number | null;
  cabinAltRateFpm: number | null;
  cabinAltTargetFt: number | null;
  oatC: number | null;
}

/** Total fuel in US gallons */
export interface FuelMessage extends BaseMessage {
  type: 'fuel';
  totalGal: number;
}

// ============================================================================
// Lifecycle and recording
// ============================================================================

/** Simulator and connection state broadcast on each telemetry poll */
export interface SimStateMessage extends BaseMessage {
  type: 'simState';
  inMenu: boolean;
  isGlobeView: boolean;
  inFlightContext: boolean;
  simconnectConnected: boolean;
  lifecycleState: string;
}

/**
 * Flight CSV recording status notification.
 * The `status` field discriminates the payload shape.
 */
export interface FlightRecordingMessage extends BaseMessage {
  type: 'flightRecording';
  status: 'recording' | 'finalizing' | 'stopped' | 'failed' | 'error';
  fileName?: string;
  filePath?: string;
  flightId?: string;
  recordingSessionId?: string;
  rowsWritten?: number;
  rowCount?: number;
  endReason?: string;
  error?: string;
}

/** Emitted when the active aircraft title changes */
export interface AircraftChangedMessage extends BaseMessage {
  type: 'aircraftChanged';
  previousTitle: string | null;
  newTitle: string;
}

// ============================================================================
// Safety events
// ============================================================================

/** Overspeed alert (VMO/VFE exceedance) */
export interface OverspeedMessage extends BaseMessage {
  type: 'overspeed';
  timestamp: string;
  active: boolean;
  ias: number | null;
  overspeedType: 'vfe' | 'vmo' | null;
  barberPoleKts: number | null;
  flapsPercent: number | null;
}

/** Stall warning (AOA-triggered) */
export interface StallMessage extends BaseMessage {
  type: 'stall';
  timestamp: string;
  active: boolean;
  ias: number | null;
}

/** Fuel exhaustion alert */
export interface FuelExhaustedMessage extends BaseMessage {
  type: 'fuelExhausted';
  timestamp: string;
  fuelGal: number | null;
  exhausted: boolean;
}

/** Cabin altitude warning (pressurization loss) */
export interface CabinAltitudeWarningMessage extends BaseMessage {
  type: 'cabinAltitudeWarning';
  timestamp: string;
  cabinAltFt: number;
  severity: 'warning' | 'critical' | null;
  active: boolean;
}

/** Disk space warning for the flight recording system */
export interface DiskWarningMessage extends BaseMessage {
  type: 'diskWarning';
  level: 'warning' | 'critical';
  message: string;
  filePath?: string;
  rowsWritten?: number;
  freeDiskGb?: number;
  minFreeGb?: number;
}

export type FlightViolationMetricValue = number | string | boolean | null;

/** Flight rule violation, including confidence-based risk events */
export interface FlightViolationMessage extends BaseMessage {
  type: 'flightViolation';
  event: 'start' | 'end';
  rule_id: string;
  label: string;
  severity: 'warning' | 'critical';
  counts_as_upset: boolean;
  metrics: Record<string, FlightViolationMetricValue>;
  timestamp_ms: number;
  timestamp_utc: string;
}

// ============================================================================
// Notifications
// ============================================================================

/** Cabin announcement phase change (boarding, safety demo, etc.) */
export interface CabinAnnouncementMessage extends BaseMessage {
  type: 'cabinAnnouncement';
  phase: string;
  style: string;
}

// ============================================================================
// Debug messages
// ============================================================================

export interface DebugEntry {
  ts: string;
  section: string;
  message: string;
  data?: unknown;
}

export interface DebugMessage extends BaseMessage {
  type: 'debug';
  entry: DebugEntry;
}

export interface ThrottleMessage extends BaseMessage {
  type: 'throttle';
  value: number;
}

export interface RatesMessage extends BaseMessage {
  type: 'rates';
  pitchRate: number;
  rollRate: number;
  yawRate: number;
}

// ============================================================================
// System
// ============================================================================

export interface ConnectedMessage extends BaseMessage {
  type: 'connected';
  version?: string;
}

// ============================================================================
// Union type of all messages
// ============================================================================

export type TelemetryMessage =
  | IASMessage
  | VSMessage
  | AltitudeMessage
  | IASTrendMessage
  | CrosswindMessage
  | PhaseMessage
  | EnvelopeStatusMessage
  | StabilityScoreMessage
  | UltimateStabilityScoreMessage
  | VreSamplingMessage
  | LightsMessage
  | GearMessage
  | FlapsMessage
  | SpoilersMessage
  | EnginesMessage
  | LandingMessage
  | RunwayContextMessage
  | SafetyDataMessage
  | AttitudeMessage
  | SurfaceMessage
  | PositionMessage
  | CalloutMessage
  | FlightTimeMessage
  | FlightStartedMessage
  | FlightEndedMessage
  | AircraftProfileMessage
  | AircraftSpecificStateMessage
  | SignalReliabilityMessage
  | DebugMessage
  | ThrottleMessage
  | RatesMessage
  | ConnectedMessage
  | AutopilotMessage
  | HeadingMessage
  | GSMessage
  | ControlsMessage
  | EnvironmentMessage
  | FuelMessage
  | SimStateMessage
  | FlightRecordingMessage
  | AircraftChangedMessage
  | OverspeedMessage
  | StallMessage
  | FuelExhaustedMessage
  | CabinAltitudeWarningMessage
  | DiskWarningMessage
  | FlightViolationMessage
  | CabinAnnouncementMessage;
