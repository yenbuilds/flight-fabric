/**
 * enums.ts
 *
 * Runtime constants for the Flight Fabric WebSocket protocol:
 *
 *   MSG             — wire type strings for every backend broadcast message.
 *                     Mirrors backend/core/message-types.ts. Both files must
 *                     be updated together when a message type is added or renamed.
 *
 *   PHASE           — flight phase identifiers (TAXI, TAKEOFF, CRUISE, APPROACH, etc.).
 *
 *   ENVELOPE_STATUS — stability envelope assessment values
 *                     (IN_ENVELOPE, OUT_OF_ENVELOPE, NOT_APPLICABLE).
 */

import phaseRegistry from '../../../shared/flight-phases';
import type { PhaseMap } from '../../../shared/flight-phases';

/**
 * WebSocket message type constants.
 * Canonical registry — mirrors backend/core/message-types.ts MSG.
 * Keep in sync with the backend when adding or removing message types.
 */
export const MSG = {
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

  // Pilot control inputs
  CONTROLS: 'controls',

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

  // Runway context (during approach)
  RUNWAY_CONTEXT: 'runwayContext',
  AIRPORT_LOOKUP_RESULT: 'airportLookupResult',
  DESTINATION_TARGET: 'destinationTarget',
  DESTINATION_TARGET_ERROR: 'destinationTargetError',
  ORIGIN_TARGET: 'originTarget',
  ORIGIN_TARGET_ERROR: 'originTargetError',

  // Aircraft warnings
  OVERSPEED: 'overspeed',
  STALL: 'stall',
  FUEL_EXHAUSTED: 'fuelExhausted',
  CABIN_ALTITUDE_WARNING: 'cabinAltitudeWarning',

  // Data source status
  DATA_SOURCES: 'dataSources',

  // Flight recording
  FLIGHT_RECORDING: 'flightRecording',
  RECORDING_STARTED: 'recordingStarted',
  RECORDING_STATE: 'recordingState',
  RECORDING_STOPPED: 'recordingStopped',
  START_FLIGHT_RESULT: 'startFlightResult',
  END_FLIGHT_RESULT: 'endFlightResult',
  FLIGHT_STATUS: 'flightStatus',

  // Environment (cabin pressure, temperature)
  ENVIRONMENT: 'environment',

  // Autopilot state
  AUTOPILOT: 'autopilot',

  // Disk space warnings
  DISK_WARNING: 'diskWarning',

  // Update notifications
  UPDATE_AVAILABLE: 'updateAvailable',

  // Timeline / logbook
  TIMELINE: 'timeline',
  TIMELINE_ERROR: 'timelineError',
  TIMELINE_LIST: 'timelineList',
  TIMELINE_LIST_ERROR: 'timelineListError',
  FLIGHT_ANALYSIS_RESCORE_RESULT: 'flightAnalysisRescoreResult',
  DELETE_FLIGHT_CSV_RESULT: 'deleteFlightCsvResult',
  LOGBOOK: 'logbook',
  HISTORY_INDEX_STATUS: 'historyIndexStatus',

  // Aircraft profile management
  PROFILE_EXPORTED: 'profileExported',
  PROFILE_LIST: 'profileList',
  PROFILE_ERROR: 'profileError',
  AIRCRAFT_COMMAND_RESULT: 'aircraftCommandResult',
  AIRCRAFT_CONTROL_RESULT: 'aircraftControlResult',
  AUTHORIZATION_SCOPE: 'authorizationScope',

  // UI display preferences (relayed to all clients so overlays stay in sync)
  FUEL_UNIT: 'fuelUnit',
  SHOW_BRANDING: 'showBranding',

  // Active SimBrief OFP relay
  FLIGHT_PLAN: 'flightPlan',

  // Persisted app settings
  APP_SETTINGS: 'appSettings',
  APP_SETTINGS_SAVED: 'appSettingsSaved',

  LVAR_DEBUG_WATCH_ACK: 'lvarDebugWatchAck',
  TEST_SHAKE_ACK: 'testShakeAck',

  // Safety data (historical accidents and reports for approach airport)
  SAFETY_DATA: 'safetyData',
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

/**
 * Flight phase values.
 */
export const PHASE = phaseRegistry.PHASES as PhaseMap;

export type Phase = (typeof PHASE)[keyof typeof PHASE];

/**
 * Envelope status values.
 */
export const ENVELOPE_STATUS = {
  IN_ENVELOPE: 'IN_ENVELOPE',
  OUT_OF_ENVELOPE: 'OUT_OF_ENVELOPE',
  NOT_APPLICABLE: '--',
} as const;

export type EnvelopeStatus = (typeof ENVELOPE_STATUS)[keyof typeof ENVELOPE_STATUS];
