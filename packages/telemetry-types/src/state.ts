/**
 * state.ts
 *
 * TelemetryState — the accumulated snapshot that the TelemetryClient maintains
 * and delivers to subscribers. Each field is populated by the corresponding
 * incoming WebSocket message and starts as null until that message has been
 * received at least once.
 *
 * Also exports createInitialState(), which returns a fresh zeroed-out snapshot
 * used on client construction and after a clean reconnect.
 */

import type { Phase, EnvelopeStatus } from './enums';
import type {
  LightsData,
  GearData,
  FlapsData,
  SpoilersData,
  EnginesData,
  SurfaceData,
  StabilityBreakdown,
  LandingMessage,
  SafetyAccident,
  SafetyReport,
  AircraftProfileData,
} from './messages';

/**
 * Normalized telemetry state shape.
 * This is what the TelemetryClient maintains and exposes to consumers.
 */
export interface TelemetryState {
  // Connection status
  connected: boolean;
  lastMessageAt: number | null;

  // Scalar telemetry
  ias: number | null;
  vs: number | null;
  altitude: {
    msl: number | null;
    ra: number | null;
  };
  iasTrend: number | null;
  crosswind: number | null;

  // Flight state
  phase: Phase | null;
  envelopeStatus: EnvelopeStatus | null;

  // Stability scoring
  stabilityScore: number | null;
  stabilityBreakdown: StabilityBreakdown | null;
  ultimateStabilityScore: number | null;
  ultimateStabilityBreakdown: StabilityBreakdown | null;
  ultimateStabilitySamples: number | null;

  // Aircraft systems
  lights: LightsData | null;
  gear: GearData | null;
  flaps: FlapsData | null;
  spoilers: SpoilersData | null;
  engines: EnginesData | null;

  // Attitude
  attitude: {
    pitch: number | null;
    bank: number | null;
  };

  // Position
  position: {
    lat: number | null;
    lon: number | null;
    hdgTrue: number | null;
    hdgMag: number | null;
  };

  // Surface
  surface: SurfaceData | null;

  // Context
  runwayContext: {
    icao: string | null;
    runway: string | null;
    approachType: 'ILS' | 'VISUAL' | null;
  };

  // Safety data (for approach airport)
  safetyData: {
    icao: string | null;
    accidents: SafetyAccident[];
    reports: SafetyReport[];
    summary: string | null;
  } | null;

  // Flight time
  flightTime: {
    startedAt: string | null;
    elapsedMs: number;
    elapsedSec: number;
    elapsedHms: string;
  };

  // Aircraft profile
  aircraftProfile: AircraftProfileData | null;

  // Landing (most recent)
  lastLanding: LandingMessage | null;
}

/**
 * Initial/empty state factory.
 */
export function createInitialState(): TelemetryState {
  return {
    connected: false,
    lastMessageAt: null,

    ias: null,
    vs: null,
    altitude: { msl: null, ra: null },
    iasTrend: null,
    crosswind: null,

    phase: null,
    envelopeStatus: null,

    stabilityScore: null,
    stabilityBreakdown: null,
    ultimateStabilityScore: null,
    ultimateStabilityBreakdown: null,
    ultimateStabilitySamples: null,

    lights: null,
    gear: null,
    flaps: null,
    spoilers: null,
    engines: null,

    attitude: { pitch: null, bank: null },
    position: { lat: null, lon: null, hdgTrue: null, hdgMag: null },
    surface: null,

    runwayContext: { icao: null, runway: null, approachType: null },
    safetyData: null,

    flightTime: {
      startedAt: null,
      elapsedMs: 0,
      elapsedSec: 0,
      elapsedHms: '00:00:00',
    },

    aircraftProfile: null,
    lastLanding: null,
  };
}
