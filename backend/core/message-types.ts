// message-types.js
// Centralized message type constants for WebSocket broadcasts.
// Prevents typos and enables autocomplete/refactoring.
//
// Usage:
//   const { MSG } = require('./message-types');
//   broadcast({ type: MSG.IAS, value: 123 });

const { PHASES } = require('../lifecycle/phases.js') as {
  PHASES: Readonly<Record<string, string>>;
};

/**
 * WebSocket message types for telemetry broadcasts.
 * @readonly
 * @enum {string}
 */
const MSG = Object.freeze({
  // Scalar streams
  IAS: 'ias',
  VS: 'vs',
  GS: 'gs',
  ALTITUDE: 'altitude',
  HEADING: 'heading',
  IAS_TREND: 'iast',
  CROSSWIND: 'xwind',
  THROTTLE: 'throttle',
  RATES: 'rates',
  FUEL: 'fuel',
  PHASE: 'phase',
  // Note: 'envelopeStatus' is observational (describes current state) not prescriptive.
  // Values: IN_ENVELOPE (within criteria), OUT_OF_ENVELOPE (outside), '--' (not applicable)
  ENVELOPE_STATUS: 'envelopeStatus',
  STABILITY_SCORE: 'stabilityScore',
  ULTIMATE_STABILITY_SCORE: 'ultimateStabilityScore',
  VRE_SAMPLING: 'vreSampling',

  // Structured data
  LIGHTS: 'lights',
  NAV_RADIOS: 'navRadios',
  GEAR: 'gear',
  FLAPS: 'flaps',
  SPOILERS: 'spoilers',
  ENGINES: 'engines',
  LANDING: 'landing',
  FLIGHT_SUMMARY: 'flightSummary',
  FLIGHT_VIOLATION: 'flightViolation',

  // Attitude & position
  ATTITUDE: 'attitude',
  SURFACE: 'surface',
  POSITION: 'position',

  // Pilot control inputs (yoke/sidestick and rudder pedals)
  CONTROLS: 'controls', // { yokeX: +/-1, yokeY: +/-1, rudderPedalPct: +/-100 }

  // Events & beats
  CALLOUT: 'callout',
  CABIN_ANNOUNCEMENT: 'cabinAnnouncement',

  // Time & lifecycle
  FLIGHT_TIME: 'flightTime',
  FLIGHT_STARTED: 'flightStarted',
  FLIGHT_ENDED: 'flightEnded',
  AIRCRAFT_CHANGED: 'aircraftChanged',
  SIM_STATE: 'simState',

  // Debug
  DEBUG: 'debug',

  // System
  CONNECTED: 'connected',
  AIRCRAFT_PROFILE: 'aircraftProfile',
  AIRCRAFT_SPECIFIC_STATE: 'aircraftSpecificState',
  ASSISTS: 'assists',

  // Signal reliability (emitted on aircraft change)
  SIGNAL_RELIABILITY: 'signalReliability',

  // Runway context and airport data (during approach)
  RUNWAY_CONTEXT: 'runwayContext',
  AIRPORT_LOOKUP_RESULT: 'airportLookupResult',
  SAFETY_DATA: 'safetyData', // Airport safety record (accidents, incident reports)
  DESTINATION_TARGET: 'destinationTarget',
  DESTINATION_TARGET_ERROR: 'destinationTargetError',
  ORIGIN_TARGET: 'originTarget',
  ORIGIN_TARGET_ERROR: 'originTargetError',

  // Aircraft warnings (overspeed, stall, fuel, cabin pressure)
  OVERSPEED: 'overspeed',
  STALL: 'stall',
  FUEL_EXHAUSTED: 'fuelExhausted',
  CABIN_ALTITUDE_WARNING: 'cabinAltitudeWarning',

  // Data source status (which telemetry sources are active)
  DATA_SOURCES: 'dataSources',

  // Flight recording status (V1 CSV logging)
  FLIGHT_RECORDING: 'flightRecording',
  RECORDING_STARTED: 'recordingStarted',
  RECORDING_STATE: 'recordingState',
  RECORDING_STOPPED: 'recordingStopped',
  START_FLIGHT_RESULT: 'startFlightResult',
  END_FLIGHT_RESULT: 'endFlightResult',
  FLIGHT_STATUS: 'flightStatus',

  // Environment data (cabin pressurization, temperature)
  ENVIRONMENT: 'environment',

  // Autopilot state (MCP settings, engaged modes)
  AUTOPILOT: 'autopilot',

  // Disk space warnings (low disk, disk exhausted)
  DISK_WARNING: 'diskWarning',

  // Update available notification
  UPDATE_AVAILABLE: 'updateAvailable',

  // Timeline/logbook and flight history requests.
  TIMELINE: 'timeline',
  TIMELINE_ERROR: 'timelineError',
  TIMELINE_LIST: 'timelineList',
  TIMELINE_LIST_ERROR: 'timelineListError',
  FLIGHT_ANALYSIS_RESCORE_RESULT: 'flightAnalysisRescoreResult',
  DELETE_FLIGHT_CSV_RESULT: 'deleteFlightCsvResult',
  LOGBOOK: 'logbook',
  HISTORY_INDEX_STATUS: 'historyIndexStatus',

  // Aircraft profile management.
  PROFILE_EXPORTED: 'profileExported',
  PROFILE_LIST: 'profileList',
  PROFILE_ERROR: 'profileError',
  AIRCRAFT_COMMAND_RESULT: 'aircraftCommandResult',
  AIRCRAFT_CONTROL_RESULT: 'aircraftControlResult',
  AUTHORIZATION_SCOPE: 'authorizationScope',

  // UI display preferences (client->server relay; replayed on requestState)
  // Relayed to all connected clients so OBS strip overlays stay in sync.
  FUEL_UNIT: 'fuelUnit', // { unit: 'gal'|'lbs'|'kg' }
  SHOW_BRANDING: 'showBranding', // { show: boolean }

  // Active SimBrief OFP (client->server relay; replayed on requestState).
  // Sent by the main UI when the user fetches a new flight plan.
  // Relayed to all connected clients (strip overlays, mobile) so the
  // active OFP is always available without requiring a re-fetch.
  FLIGHT_PLAN: 'flightPlan', // { username, origin, destination, ... }

  // Persisted UI-configurable app settings.
  APP_SETTINGS: 'appSettings',
  APP_SETTINGS_SAVED: 'appSettingsSaved',

  LVAR_DEBUG_WATCH_ACK: 'lvarDebugWatchAck',
  TEST_SHAKE_ACK: 'testShakeAck',
});

/**
 * Flight phase values.
 * @readonly
 * @enum {string}
 */
const PHASE = PHASES;

/**
 * Envelope status values.
 * Describes whether aircraft is within stabilized approach envelope.
 * Note: Observational (describes state), not prescriptive (doesn't tell pilot what to do).
 * @readonly
 * @enum {string}
 */
const ENVELOPE_STATUS = Object.freeze({
  IN_ENVELOPE: 'IN_ENVELOPE',
  OUT_OF_ENVELOPE: 'OUT_OF_ENVELOPE',
  NOT_APPLICABLE: '--',
});

const messageTypes = {
  MSG,
  PHASE,
  ENVELOPE_STATUS,
};

module.exports = messageTypes;

export {};
