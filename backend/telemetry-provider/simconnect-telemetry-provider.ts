// telemetry-provider/simconnect-telemetry-provider.js
// SimConnect-only telemetry provider (generic, vendor-agnostic)
//
// PURPOSE:
// - Works out-of-the-box with MSFS 2020 and MSFS 2024
// - Provides all core landing metrics via Rust sidecar SimVar snapshots
// - Optional LVAR sidecar enrichments handled separately
//
// ARCHITECTURE:
// - Receives generic SimVars through the Rust SimConnect sidecar
// - Returns NormalizedFrame with standard telemetry fields
// - Can be selected via --simconnect flag
//
// ═══════════════════════════════════════════════════════════════════════════
// DATA FLOW CONTRACT
//
// This table documents the complete transformation chain for each critical field:
//   SDK → SimConnect → this._data → nextFrame() → frame → simbridge-core
//
// SDK units are defined by the official MSFS SimVar documentation:
// https://docs.flightsimulator.com/html/Programming_Tools/SimVars/
//
// | Field | SDK Native Unit | this._data | frame.{source} | frame.display.{} | Consumer Uses |
// |-------|-----------------|------------|----------------|------------------|---------------|
// | VS    | feet/sec (fps)  | fps        | vs (m/s)       | vsFpm (fpm)      | display.vsFpm |
// | RA    | feet            | feet       | ra (meters)    | raFt (feet)      | display.raFt  |
// | IAS   | knots           | knots      | ias (knots)    | iasKts (knots)   | display.iasKts|
// | GS    | knots           | knots      | gs (knots)     | gsKts (knots)    | display.gsKts |
//
// CONVERSION FORMULAS (nextFrame):
//   vsMs  = vsFps × 0.3048       (fps → m/s)
//   vsFpm = vsFps × 60           (fps → fpm)
//   raM   = raFt × 0.3048        (ft → m)
// NOTE: `frame.ias` and `frame.display.iasKts` are in knots. All telemetry
// providers must emit values in standard units (knots, feet, degrees, etc.).
//
// ═══════════════════════════════════════════════════════════════════════════
const Debug = require('../core/debug');
const eventBus = require('../core/event-bus');
const profileLoader = require('../aircraft/aircraft-profile-loader');
const userSettings = require('../core/user-settings') as { settings: AnyRecord };
const { getPmdg737SdkEulaAcceptance } = require('../../shared/pmdg-737-sdk-authorization.js') as {
  getPmdg737SdkEulaAcceptance: (settings: AnyRecord) => { accepted: boolean };
};
const { getPmdg777SdkEulaAcceptance } = require('../../shared/pmdg-777-sdk-authorization.js') as {
  getPmdg777SdkEulaAcceptance: (settings: AnyRecord) => { accepted: boolean };
};
const {
  defaultAircraftIntegrationRegistry,
  normalizeAircraftIntegrationActionInput,
} = require('../aircraft/aircraft-integrations') as {
  defaultAircraftIntegrationRegistry: AnyRecord;
  normalizeAircraftIntegrationActionInput: (
    action: AnyRecord | null | undefined,
    value: unknown,
  ) => Readonly<{ ok: true; value?: number } | { ok: false; error: string }>;
};
const { decodeAircraftSpecificValue } = require('../aircraft/aircraft-specific-state.js') as {
  decodeAircraftSpecificValue: (
    rawValue: unknown,
    decoder: AnyRecord | null | undefined,
  ) => string | number | boolean | undefined;
};
const config = require('../core/config');
const { getProfileEngineCount } = require('../core/simbridge-core-utils') as {
  getProfileEngineCount: (profile: any) => number | null;
};
const { LvarSidecarBridge } = require('./lvar-sidecar-bridge');
const { RustSimvarBridge } = require('./rust-simvar-bridge.js') as {
  RustSimvarBridge: new (options?: any) => any;
};
const { createMsfsFacilitiesGeometryProvider } = require('../landing/msfs-facilities-geometry-provider.js') as {
  createMsfsFacilitiesGeometryProvider: (bridge: any, options?: any) => AnyRecord;
};
const { findNearbyAirport, registerAirportGeometryProvider } = require('../landing/airport-geometry-service.js') as {
  findNearbyAirport: (lat: number, lon: number, radiusNm?: number, context?: AnyRecord) => AnyRecord | null;
  registerAirportGeometryProvider: (provider: AnyRecord) => void;
};
const { SdkBridge } = require('./sdk-bridge.js') as {
  SdkBridge: new (adapter: any) => any;
};
const sdkRegistry = require('./sdk-registry.js') as {
  SDK_SOURCE_TYPE: string;
  resolveProfileSdkConfig: (dataSource: AnyRecord | null | undefined) => {
    adapter: {
      id: string;
      displayName: string;
      categories: string[];
      noDataHint?: string;
      describeTarget?: (target: AnyRecord | null | undefined) => string | null;
    };
    profileSdk: {
      target: AnyRecord;
    };
  } | null;
};
const { makeSpoilersObj } = require('../aircraft/spoilers');
const { decodeLights } = require('../utils/helpers');
const { encodeFrequencyBcd16Mhz } = require('../utils/radio-frequency');
const { NAV_RADIO_FIELDS, captureNavRadios } = require('./nav-radio-state');
const {
  captureLightMaskSample,
  captureGenericLightReadback,
  describeGenericLightReadback,
} = require('./generic-control-diagnostics');
const {
  FT_TO_M,
  FPS_TO_FPM,
} = require('../utils/units');
const {
  simConnectUnitString,
  usesInt32SimConnectData,
} = require('./simconnect-units.js') as {
  simConnectUnitString: (unit: string) => string;
  usesInt32SimConnectData: (unit: string) => boolean;
};
const {
  buildSimConnectAssists,
  buildSimConnectFdmData,
  buildSimConnectSimTime,
  buildSimConnectTouchdownData,
  buildSimConnectWarnings,
} = require('./simconnect-frame-builder.js') as {
  buildSimConnectAssists: (data: AnyRecord, boolOrNull: (value: unknown) => boolean | null) => AnyRecord;
  buildSimConnectFdmData: (data: AnyRecord, boolOrNull: (value: unknown) => boolean | null) => AnyRecord;
  buildSimConnectSimTime: (data: AnyRecord, secToHms: (seconds: unknown) => string | null) => AnyRecord;
  buildSimConnectTouchdownData: (data: AnyRecord) => AnyRecord;
  buildSimConnectWarnings: (data: AnyRecord, boolOrNull: (value: unknown) => boolean | null) => AnyRecord;
};

type AnyRecord = Record<string, any>;

type SimConnectVarDefinition = {
  name: string;
  simvar: string;
  unit: string;
  isolated?: boolean;
};

const CONTROL_ACTION_NAME_RE = /^[A-Za-z0-9 _./:#+%()-]+$/;
const CONTROL_UNIT_RE = /^[A-Za-z0-9 _./:+%()-]+$/;
const MAX_CONTROL_ACTION_NAME_LENGTH = 160;
const MAX_CONTROL_UNIT_LENGTH = 48;
const MAX_CONTROL_NUMERIC_ABS = 1_000_000;
const MAX_KEY_EVENT_VALUE_ABS = 1_000_000;
const MAX_SDK_EVENT_VALUE = 0xffffffff;
const GENERIC_CONTROL_OBSERVATION_MS = 1500;
const AIRCRAFT_INTEGRATION_READBACK_POLL_MS = 50;
const AIRCRAFT_INTEGRATION_READBACK_FRESH_MS = 2000;
const AIRCRAFT_INTEGRATION_SEQUENCE_DELAY_POLL_MS = 250;
const MAX_AIRCRAFT_INTEGRATION_SEQUENCE_DELAY_MS = 10_000;
const AIRCRAFT_INTEGRATION_CALCULATOR_DELAY_POLL_MS = 25;
const MAX_AIRCRAFT_INTEGRATION_CALCULATOR_PULSE_DELAY_MS = 1_000;
const MAX_AIRCRAFT_INTEGRATION_CALCULATOR_TARGET_DURATION_MS = 180_000;
const MAX_AIRCRAFT_INTEGRATION_CALCULATOR_TARGET_STEPS = 500;
const INIBUILDS_TRISTAR_PROFILE_KEY = 'bundled/msfs/inibuilds-tristar';
const INIBUILDS_TRISTAR_AFCS_PULSE_COOLDOWN_MS = 600;
const INIBUILDS_TRISTAR_AFCS_PULSE_GROUPS: Readonly<Record<string, string>> = Object.freeze({
  AP_AIRSPEED_HOLD: 'autothrottle',
  AP_VS_HOLD: 'verticalSpeedHold',
  AP_ALT_HOLD: 'altitudeHold',
  AP_MACH_HOLD: 'machHold',
  AP_HDG_HOLD: 'headingHold',
  TOGGLE_FLIGHT_DIRECTOR: 'flightDirector',
  AP_MASTER: 'apMaster',
  AUTOPILOT_OFF: 'apMaster',
  AP_APR_HOLD: 'app',
  AP_LOC_HOLD: 'loc',
  AP_NAV1_HOLD: 'nav1',
  TOGGLE_WATER_RUDDER: 'ins',
  AP_BC_HOLD: 'backcourse',
});
const AIRCRAFT_INTEGRATION_DERIVED_LIGHT_SIMVARS: Readonly<Record<string, string>> = Object.freeze({
  'LIGHT BEACON': 'beacon',
  'LIGHT LANDING': 'landing',
  'LIGHT LOGO': 'logo',
  'LIGHT NAV': 'nav',
  'LIGHT STROBE': 'strobe',
  'LIGHT TAXI': 'taxi',
  'LIGHT TAXI:2': 'turnoff',
  'LIGHT WING': 'wing',
});
const PMDG_737_INTEGRATION_ID = 'pmdg-737';
const PMDG_777_INTEGRATION_ID = 'pmdg-777';

function finiteTelemetryNumber(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isValidLatLon(lat: number | null, lon: number | null): boolean {
  return lat !== null
    && lon !== null
    && Math.abs(lat) <= 90
    && Math.abs(lon) <= 180
    && !(Math.abs(lat) < 0.000001 && Math.abs(lon) < 0.000001);
}

function formatFacilitiesProbeOutcome(outcome: AnyRecord | null | undefined): string {
  if (!outcome || typeof outcome !== 'object') return 'none';
  const ok = outcome.ok === true ? 'ok' : 'fail';
  const icao = typeof outcome.icao === 'string' && outcome.icao ? outcome.icao : 'unknown';
  const count = Number.isFinite(outcome.runwayCount)
    ? Number(outcome.runwayCount)
    : Array.isArray(outcome.runways)
      ? outcome.runways.length
      : null;
  const runwayCount = count !== null ? ` runways=${count}` : '';
  const error = typeof outcome.error === 'string' && outcome.error ? ` error=${outcome.error}` : '';
  return `${ok}:${icao}${runwayCount}${error}`;
}

function compactIcaoList(value: unknown): string {
  return Array.isArray(value) && value.length > 0 ? value.join('|') : 'none';
}

function hasMeaningfulSdkValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((item) => hasMeaningfulSdkValue(item));
  if (typeof value === 'object') return Object.values(value).some((item) => hasMeaningfulSdkValue(item));
  return false;
}

function formatAircraftControlReadbackValue(value: unknown): string {
  if (value === null || value === undefined) return 'unavailable';
  if (typeof value === 'string') return value.trim() ? value.trim() : 'empty';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return 'unavailable';
}

function withAircraftControlExecutionStarted(result: unknown): AnyRecord {
  const fields = result && typeof result === 'object'
    ? result as AnyRecord
    : { ok: false };
  return { ...fields, executionStarted: true };
}

const SAFE_SDK_PATH_SEGMENT_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RESERVED_SDK_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function readOwnSdkPath(root: unknown, pathValue: unknown): unknown {
  if (!root || typeof root !== 'object' || typeof pathValue !== 'string') return undefined;
  const segments = pathValue.split('.');
  if (
    segments.length === 0
    || segments.some((segment) => (
      !SAFE_SDK_PATH_SEGMENT_RE.test(segment)
      || RESERVED_SDK_PATH_SEGMENTS.has(segment)
    ))
  ) return undefined;

  let current: unknown = root;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = (current as AnyRecord)[segment];
  }
  return current;
}

function coerceSimConnectBool(value: unknown): boolean | null {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value !== 0 : null;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? numeric !== 0 : null;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// SimConnect Variable Definitions
// 
// Units follow the official MSFS SDK documentation and must remain explicit.
// Source: https://docs.flightsimulator.com/html/Programming_Tools/SimVars/
//
// Each variable's native unit is documented inline. SimConnect may or may not
// honor unit conversion requests - always verify against SDK docs first.
//
// ORDERING: Variables are ordered by priority. SimConnect has a limit on how
// many variables can be read in a single data definition (~50-60). The most
// most important variables come first so they are read before exhaustion.
// ═══════════════════════════════════════════════════════════════════════════
const SIMCONNECT_VARS: SimConnectVarDefinition[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // Priority 1: core landing metrics, navigation, and attitude
  // Core functionality depends on these fields.
  // ═══════════════════════════════════════════════════════════════════════════
  
  // SDK: "AIRSPEED INDICATED - Indicated airspeed. Unit: Knots"
  { name: 'ias', simvar: 'AIRSPEED INDICATED', unit: 'knots' },
  // SDK: "VERTICAL SPEED - The current indicated vertical speed. Unit: Feet per second"
  // The SDK native unit is feet per second; downstream code converts to feet per minute.
  { name: 'vs', simvar: 'VERTICAL SPEED', unit: 'feet per second' },
  // SDK: "RADIO HEIGHT - Radar altitude. Unit: Feet"
  { name: 'ra', simvar: 'RADIO HEIGHT', unit: 'feet' },
  { name: 'wow', simvar: 'SIM ON GROUND', unit: 'bool' },
  // SDK: "FLAPS HANDLE PERCENT - Percent flap handle extended. 0-100."
  { name: 'flaps', simvar: 'FLAPS HANDLE PERCENT', unit: 'percent' },
  // SDK: "FLAPS HANDLE INDEX - Index of current flap position (0-N based on aircraft config)"
  { name: 'flapsIndex', simvar: 'FLAPS HANDLE INDEX', unit: 'number' },
  // SDK: "TRAILING EDGE FLAPS LEFT ANGLE - Actual physical deflection of the left trailing edge flap. Unit: Radians (requested as degrees)"
  // Used as zero-config display for generic aircraft: always shows real degrees regardless of handle travel mapping.
  { name: 'flapsAngleDeg', simvar: 'TRAILING EDGE FLAPS LEFT ANGLE', unit: 'degrees' },
  { name: 'spoilers', simvar: 'SPOILERS HANDLE POSITION', unit: 'percent' },
  // SDK: "SPOILERS ARMED - True if spoilers are armed. Bool."
  { name: 'spoilersArmed', simvar: 'SPOILERS ARMED', unit: 'bool' },
  // Actual spoiler panel positions (includes roll spoiler deflection during turns)
  // Used to filter out roll spoiler activity: if L/R differ significantly, it's roll not speedbrake
  { name: 'spoilersLeft', simvar: 'SPOILERS LEFT POSITION', unit: 'percent' },
  { name: 'spoilersRight', simvar: 'SPOILERS RIGHT POSITION', unit: 'percent' },
  { name: 'gearHandle', simvar: 'GEAR HANDLE POSITION', unit: 'bool' },
  { name: 'gearNose', simvar: 'GEAR CENTER POSITION', unit: 'percent' },
  { name: 'gearLeft', simvar: 'GEAR LEFT POSITION', unit: 'percent' },
  { name: 'gearRight', simvar: 'GEAR RIGHT POSITION', unit: 'percent' },
  
  // Navigation
  { name: 'gs', simvar: 'GROUND VELOCITY', unit: 'knots' },
  { name: 'heading', simvar: 'PLANE HEADING DEGREES TRUE', unit: 'degrees' },
  { name: 'headingMag', simvar: 'PLANE HEADING DEGREES MAGNETIC', unit: 'degrees' },
  { name: 'magvar', simvar: 'MAGVAR', unit: 'degrees' },
  { name: 'lat', simvar: 'PLANE LATITUDE', unit: 'degrees' },
  { name: 'lon', simvar: 'PLANE LONGITUDE', unit: 'degrees' },
  // Keep the legacy cockpit indication in the latency-sensitive navigation set.
  // Additional altitude diagnostics are placed after the core FDM variables so
  // they cannot displace attitude/aerodynamic data from the first definition.
  { name: 'altMsl', simvar: 'INDICATED ALTITUDE', unit: 'feet' },
  
  // Attitude
  { name: 'pitch', simvar: 'PLANE PITCH DEGREES', unit: 'degrees' },
  { name: 'bank', simvar: 'PLANE BANK DEGREES', unit: 'degrees' },
  
  // Environment (basic)
  { name: 'windSpeed', simvar: 'AMBIENT WIND VELOCITY', unit: 'knots' },
  { name: 'windDir', simvar: 'AMBIENT WIND DIRECTION', unit: 'degrees' },
  { name: 'oat', simvar: 'AMBIENT TEMPERATURE', unit: 'celsius' },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // PRIORITY 2: FDM ESSENTIALS (flight data monitoring - critical for analysis)
  // These are essential for proper flight data recording and analysis
  // ═══════════════════════════════════════════════════════════════════════════
  
  // G-Force (for landing grade)
  { name: 'gforce', simvar: 'G FORCE', unit: 'GForce' },
  
  // Aircraft design speeds (for ICAO category inference when profile is unknown)
  // SDK: "DESIGN SPEED VS0 - Stall speed with flaps fully extended. Native unit: kias"
  // Derived from full_flaps_stall_speed in [REFERENCE SPEEDS] of flightmodel.cfg
  // Vref = 1.3 × VS0 determines ICAO approach category (A-E)
  { name: 'designSpeedVs0Kts', simvar: 'DESIGN SPEED VS0', unit: 'knots' },
  // SDK: "DESIGN SPEED VS1 - Stall speed with flaps fully retracted. Native unit: kias"
  // Derived from flaps_up_stall_speed in [REFERENCE SPEEDS] of flightmodel.cfg
  { name: 'designSpeedVs1Kts', simvar: 'DESIGN SPEED VS1', unit: 'knots' },
  
  // Aerodynamics (essential for FDM)
  // SDK: "INCIDENCE ALPHA - Angle of attack. Native unit: Radians"
  // We request degrees for convenience; SimConnect converts automatically
  { name: 'aoa', simvar: 'INCIDENCE ALPHA', unit: 'degrees' },
  // SDK: "INCIDENCE BETA - Sideslip angle. Native unit: Radians"
  { name: 'sideslip', simvar: 'INCIDENCE BETA', unit: 'degrees' },
  
  // Body-axis acceleration (for braking/energy management and convective/turbulence analysis)
  // SDK: "ACCELERATION BODY X - Acceleration relative to aircraft X axis. Unit: Feet per second squared"
  // SDK: "ACCELERATION BODY Z - Acceleration relative to aircraft Z axis. Unit: Feet per second squared"
  { name: 'accelLateral', simvar: 'ACCELERATION BODY X', unit: 'feet per second squared' },
  { name: 'accelLongitudinal', simvar: 'ACCELERATION BODY Z', unit: 'feet per second squared' },
  
  // Angular Rates (for PIO detection, stability analysis, turbulence severity)
  // SDK docs say "feet per second" for individual vars but STRUCT BODY ROTATION VELOCITY
  // correctly says "radians per second". Request radians for correct interpretation.
  // X = pitch rate, Y = roll rate, Z = yaw rate
  { name: 'rotVelBodyX', simvar: 'ROTATION VELOCITY BODY X', unit: 'radians per second' },
  { name: 'rotVelBodyY', simvar: 'ROTATION VELOCITY BODY Y', unit: 'radians per second' },
  { name: 'rotVelBodyZ', simvar: 'ROTATION VELOCITY BODY Z', unit: 'radians per second' },
  
  // Pilot Input Position (for input vs response correlation, student technique analysis)
  // SimConnect 'position' unit returns -1.0 to +1.0 (normalized), NOT the raw gauge -16384..+16384.
  // Source: P3D/MSFS SimConnect SDK "Aircraft Controls Variables":
  //   YOKE X POSITION [-1.0: Fully Left, 1.0: Fully Right]
  //   YOKE Y POSITION [-1.0: Fully In, 1.0: Fully Out]
  //   RUDDER PEDAL POSITION [-1.0: Left Fully In, 1.0: Right Fully In]
  { name: 'yokeX', simvar: 'YOKE X POSITION', unit: 'position' },
  { name: 'yokeY', simvar: 'YOKE Y POSITION', unit: 'position' },
  
  // SDK: "AIRSPEED TRUE - True airspeed. Unit: Knots"
  { name: 'tas', simvar: 'AIRSPEED TRUE', unit: 'knots' },
  // SDK: "AIRSPEED MACH - Mach number"
  { name: 'mach', simvar: 'AIRSPEED MACH', unit: 'mach' },

  // Radio display/readback support through standard MSFS SimVars.
  { name: 'nav1ActiveMhz', simvar: 'NAV ACTIVE FREQUENCY:1', unit: 'MHz' },
  { name: 'nav1StandbyMhz', simvar: 'NAV STANDBY FREQUENCY:1', unit: 'MHz' },
  { name: 'nav2ActiveMhz', simvar: 'NAV ACTIVE FREQUENCY:2', unit: 'MHz' },
  { name: 'nav2StandbyMhz', simvar: 'NAV STANDBY FREQUENCY:2', unit: 'MHz' },

  // Compact environment display and cabin-altitude warning source. Keep this
  // before the optional/restored probe block so reduced SimVar caps do not trim it.
  { name: 'cabinAltFt', simvar: 'PRESSURIZATION CABIN ALTITUDE', unit: 'feet' },

  // SDK: installed receiver, independent of reception/power. Keep optional
  // availability probes after priority telemetry and isolate their definitions.
  { name: 'nav1Available', simvar: 'NAV AVAILABLE:1', unit: 'bool', isolated: true },
  { name: 'nav2Available', simvar: 'NAV AVAILABLE:2', unit: 'bool', isolated: true },

  // Additional altitude/barometer channels. These deliberately follow all
  // core FDM essentials and the compact cabin display set so expanding this
  // diagnostic set cannot increase their latency under reduced SimVar caps.
  // Diagnostic/optional channels are isolated at the SimConnect definition
  // level. Some simulator builds reject individual documented SimVars
  // asynchronously; isolation prevents one rejection from blanking adjacent
  // core telemetry such as Mach, NAV radios, and cabin altitude.
  { name: 'altCalibrated', simvar: 'INDICATED ALTITUDE CALIBRATED', unit: 'feet', isolated: true },
  { name: 'altPlane', simvar: 'PLANE ALTITUDE', unit: 'feet', isolated: true },
  { name: 'aircraftAgl', simvar: 'AIRCRAFT AGL', unit: 'feet', isolated: true },
  { name: 'aircraftAboveObstacles', simvar: 'AIRCRAFT ALTITUDE ABOVE OBSTACLES', unit: 'feet', isolated: true },
  { name: 'planeAgl', simvar: 'PLANE ALT ABOVE GROUND', unit: 'feet', isolated: true },
  { name: 'planeAglMinusCg', simvar: 'PLANE ALT ABOVE GROUND MINUS CG', unit: 'feet', isolated: true },
  { name: 'kohlsmanSettingMb', simvar: 'KOHLSMAN SETTING MB:1', unit: 'millibars', isolated: true },
  { name: 'kohlsmanTunedMb', simvar: 'KOHLSMAN SETTING MB EX1:1', unit: 'millibars', isolated: true },
  { name: 'kohlsmanStd', simvar: 'KOHLSMAN SETTING STD:1', unit: 'bool', isolated: true },

  // MSFS last-touchdown snapshot. These are optional enrichment fields; keep
  // them after core FDM essentials so they do not displace AOA/Mach priority.
  { name: 'touchdownBankDeg', simvar: 'PLANE TOUCHDOWN BANK DEGREES', unit: 'degrees', isolated: true },
  { name: 'touchdownHeadingMagDeg', simvar: 'PLANE TOUCHDOWN HEADING DEGREES MAGNETIC', unit: 'degrees', isolated: true },
  { name: 'touchdownHeadingTrueDeg', simvar: 'PLANE TOUCHDOWN HEADING DEGREES TRUE', unit: 'degrees', isolated: true },
  { name: 'touchdownLatRad', simvar: 'PLANE TOUCHDOWN LATITUDE', unit: 'radians', isolated: true },
  { name: 'touchdownLonRad', simvar: 'PLANE TOUCHDOWN LONGITUDE', unit: 'radians', isolated: true },
  { name: 'touchdownNormalVelocityFps', simvar: 'PLANE TOUCHDOWN NORMAL VELOCITY', unit: 'feet per second', isolated: true },
  { name: 'touchdownPitchDeg', simvar: 'PLANE TOUCHDOWN PITCH DEGREES', unit: 'degrees', isolated: true },
  
  // Engines (primary - N1, throttle)
  { name: 'eng1N1', simvar: 'TURB ENG N1:1', unit: 'percent' },
  { name: 'eng2N1', simvar: 'TURB ENG N1:2', unit: 'percent' },
  { name: 'thr1', simvar: 'GENERAL ENG THROTTLE LEVER POSITION:1', unit: 'percent' },
  { name: 'thr2', simvar: 'GENERAL ENG THROTTLE LEVER POSITION:2', unit: 'percent' },
  
  // Engine combustion (universal - works for piston, jet, turboprop)
  // SDK: "ENG COMBUSTION:index - True if the indexed engine is running, false otherwise"
  { name: 'eng1Combustion', simvar: 'ENG COMBUSTION:1', unit: 'bool' },
  { name: 'eng2Combustion', simvar: 'ENG COMBUSTION:2', unit: 'bool' },
  { name: 'eng3Combustion', simvar: 'ENG COMBUSTION:3', unit: 'bool' },
  { name: 'eng4Combustion', simvar: 'ENG COMBUSTION:4', unit: 'bool' },
  
  // Fuel
  { name: 'fuelTotalGal', simvar: 'FUEL TOTAL QUANTITY', unit: 'gallons' },
  // MSFS 2024 SDK: EX1 includes unusable fuel for both legacy [FUEL] and
  // modular [FUEL_SYSTEM] aircraft. If unsupported, the sidecar skips it and
  // the frame builder falls back to the legacy total above.
  { name: 'fuelTotalGalEx1', simvar: 'FUEL TOTAL QUANTITY EX1', unit: 'gallons' },
  // SDK: FUEL SELECTED QUANTITY PERCENT:index returns total fuel percentage
  // when the index is higher than the number of selectors or on modern fuel systems.
  { name: 'fuelTotalPct', simvar: 'FUEL SELECTED QUANTITY PERCENT:99', unit: 'percent over 100' },
  { name: 'fuelTotalWeightLbs', simvar: 'FUEL TOTAL QUANTITY WEIGHT', unit: 'pounds' },
  { name: 'fuelTotalWeightLbsEx1', simvar: 'FUEL TOTAL QUANTITY WEIGHT EX1', unit: 'pounds' },
  { name: 'fuelWeightPerGal', simvar: 'FUEL WEIGHT PER GALLON', unit: 'pounds' },
  
  // Weight & Balance
  { name: 'totalWeight', simvar: 'TOTAL WEIGHT', unit: 'pounds' },
  
  // Brakes (moved up from PRIORITY 4 - critical for gear state)
  // SDK: "BRAKE PARKING POSITION - Gets the parking brake position - either on (true) or off (false). Unit: Bool"
  { name: 'parkingBrake', simvar: 'BRAKE PARKING POSITION', unit: 'bool' },
  
  // Sim state
  { name: 'paused', simvar: 'SIM DISABLED', unit: 'bool' },
  { name: 'userInput', simvar: 'USER INPUT ENABLED', unit: 'bool' },
  { name: 'cameraState', simvar: 'CAMERA STATE', unit: 'number' },
  // SDK enum: 0=None, non-zero values identify crash cause. Keep the code, then treat any non-zero as active.
  { name: 'crashFlag', simvar: 'CRASH FLAG', unit: 'enum' },
  { name: 'crashSequence', simvar: 'CRASH SEQUENCE', unit: 'enum' },
  
  // Sim time
  { name: 'absoluteTimeSec', simvar: 'ABSOLUTE TIME', unit: 'seconds' },
  { name: 'zuluTimeSec', simvar: 'ZULU TIME', unit: 'seconds' },
  { name: 'zuluDayOfWeek', simvar: 'ZULU DAY OF WEEK', unit: 'number' },
  { name: 'zuluDayOfMonth', simvar: 'ZULU DAY OF MONTH', unit: 'number' },
  { name: 'zuluMonthOfYear', simvar: 'ZULU MONTH OF YEAR', unit: 'number' },
  { name: 'zuluDayOfYear', simvar: 'ZULU DAY OF YEAR', unit: 'number' },
  { name: 'zuluYear', simvar: 'ZULU YEAR', unit: 'number' },
  { name: 'zuluSunriseTimeSec', simvar: 'ZULU SUNRISE TIME', unit: 'seconds' },
  { name: 'zuluSunsetTimeSec', simvar: 'ZULU SUNSET TIME', unit: 'seconds' },
  { name: 'localTimeSec', simvar: 'LOCAL TIME', unit: 'seconds' },
  { name: 'localDayOfWeek', simvar: 'LOCAL DAY OF WEEK', unit: 'number' },
  { name: 'localDayOfMonth', simvar: 'LOCAL DAY OF MONTH', unit: 'number' },
  { name: 'localMonthOfYear', simvar: 'LOCAL MONTH OF YEAR', unit: 'number' },
  { name: 'localDayOfYear', simvar: 'LOCAL DAY OF YEAR', unit: 'number' },
  { name: 'localYear', simvar: 'LOCAL YEAR', unit: 'number' },
  { name: 'timeZoneOffsetSec', simvar: 'TIME ZONE OFFSET', unit: 'seconds' },
  { name: 'timeOfDay', simvar: 'TIME OF DAY', unit: 'enum' },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // PRIORITY 3: SIMULATOR-ASSISTANCE STATE
  // ═══════════════════════════════════════════════════════════════════════════
  
  { name: 'unlimitedFuel', simvar: 'UNLIMITED FUEL', unit: 'bool' },
  { name: 'assistLanding', simvar: 'ASSISTANCE LANDING ENABLED', unit: 'bool' },
  { name: 'assistTakeoff', simvar: 'ASSISTANCE TAKEOFF ENABLED', unit: 'bool' },
  { name: 'aiControls', simvar: 'AI CONTROLS', unit: 'bool' },
  { name: 'aiAutotrim', simvar: 'AI AUTOTRIM ACTIVE', unit: 'bool' },
  { name: 'aiDelegated', simvar: 'DELEGATE CONTROLS TO AI', unit: 'bool' },
  { name: 'aiAntistall', simvar: 'AI ANTISTALL STATE', unit: 'enum' },  // 0=Active, 1=Stabilizing, 2=Inactive
  { name: 'realismPercent', simvar: 'REALISM', unit: 'number' },  // General realism 0-100
  { name: 'slewActive', simvar: 'IS SLEW ACTIVE', unit: 'bool' },
  { name: 'pressureAlt', simvar: 'PRESSURE ALTITUDE', unit: 'feet' },  // STD-normalised altitude (unaffected by baro setting changes)
  // NOTE: Taxi ribbons detection NOT AVAILABLE in MSFS 2024
  // The SimVar 'ASSISTANCE NAVIGATION GUIDES ENABLED' doesn't exist in MSFS 2024 SDK
  // 'FLY ASSISTANT RIBBONS ACTIVE' and 'FLY ASSISTANT TAXI RIBBONS ACTIVE' are marked Obsolete
  // See: https://docs.flightsimulator.com/msfs2024/html/6_Programming_APIs/SimVars/Aircraft_SimVars/Aircraft_AutopilotAssistant_Variables.htm
  
  // Aircraft warnings (for overspeed/stall detection)
  { name: 'overspeedWarning', simvar: 'OVERSPEED WARNING', unit: 'bool' },  // SDK: "Overspeed warning state"
  { name: 'stallWarning', simvar: 'STALL WARNING', unit: 'bool' },  // SDK: "Stall warning state"
  
  // Barber pole (dynamic redline) - for VFE vs VMO overspeed classification
  // SDK: "AIRSPEED BARBER POLE - Redline airspeed (dynamic on some aircraft). Unit: Knots"
  // On properly modeled aircraft, this changes based on flap/gear configuration (VFE)
  { name: 'barberPoleKts', simvar: 'AIRSPEED BARBER POLE', unit: 'knots' },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // PRIORITY 4: EXTENDED FDM (nice-to-have, may not be read if exhausted)
  // ═══════════════════════════════════════════════════════════════════════════
  
  // Lights - use LIGHT STATES bitmask (more reliable than individual LIGHT * vars)
  // SDK: Bitmask with standard SimConnect light state definitions
  { name: 'lightStates', simvar: 'LIGHT STATES', unit: 'mask' },
  
  // Surface type and runway detection
  { name: 'surfaceType', simvar: 'SURFACE TYPE', unit: 'enum' },
  // SDK: "ON ANY RUNWAY - Whether or not the plane is currently on a runway. Bool"
  // More reliable than SURFACE TYPE inference for runway excursion detection
  { name: 'onAnyRunway', simvar: 'ON ANY RUNWAY', unit: 'bool' },
  
  // Additional engines
  { name: 'eng3N1', simvar: 'TURB ENG N1:3', unit: 'percent' },
  { name: 'eng4N1', simvar: 'TURB ENG N1:4', unit: 'percent' },
  { name: 'eng1N2', simvar: 'TURB ENG N2:1', unit: 'percent' },
  { name: 'eng2N2', simvar: 'TURB ENG N2:2', unit: 'percent' },
  { name: 'eng3N2', simvar: 'TURB ENG N2:3', unit: 'percent' },
  { name: 'eng4N2', simvar: 'TURB ENG N2:4', unit: 'percent' },
  { name: 'thr3', simvar: 'GENERAL ENG THROTTLE LEVER POSITION:3', unit: 'percent' },
  { name: 'thr4', simvar: 'GENERAL ENG THROTTLE LEVER POSITION:4', unit: 'percent' },
  
  // Rudder pedal input (swapped in for CG PERCENT to stay at 98-var limit)
  // CG PERCENT removed: display-only, not used in scoring/detection.
  { name: 'rudderPedal', simvar: 'RUDDER PEDAL POSITION', unit: 'position' },
  
  // Environment (expanded)
  { name: 'tat', simvar: 'TOTAL AIR TEMPERATURE', unit: 'celsius' },
  { name: 'pressureMb', simvar: 'AMBIENT PRESSURE', unit: 'millibars' },
  
  // Pressurization (native SimConnect - works on all aircraft)
  // SDK: https://docs.flightsimulator.com/html/Programming_Tools/SimVars/Aircraft_SimVars/Aircraft_System_Variables.htm
  // NOTE: cabinAltFt is kept earlier with the core display probes; these extra
  // pressurization values may be trimmed by reduced SimVar caps.
  { name: 'cabinAltRateFps', simvar: 'PRESSURIZATION CABIN ALTITUDE RATE', unit: 'feet per second' },
  { name: 'cabinDeltaPPsf', simvar: 'PRESSURIZATION PRESSURE DIFFERENTIAL', unit: 'pounds per square foot' },

  // ILS deviations are included in the Rust SimVar set. Frame normalization
  // maps the native values to dots.
  { name: 'gsNeedle', simvar: 'NAV GSI:1', unit: 'number' },
  { name: 'locNeedle', simvar: 'NAV CDI:1', unit: 'number' },
  { name: 'navHasGlideSlope', simvar: 'NAV HAS GLIDE SLOPE:1', unit: 'bool' },
  { name: 'navHasLocalizer', simvar: 'NAV HAS LOCALIZER:1', unit: 'bool' },
  { name: 'navSignal', simvar: 'NAV SIGNAL:1', unit: 'number' },
  
  // Weather (for live weather detection heuristic)
  // SDK: "AMBIENT VISIBILITY - Ambient visibility (only measures ambient particle visibility - related to ambient density). Unit: Meters"
  { name: 'visibilityM', simvar: 'AMBIENT VISIBILITY', unit: 'meters' },
  // SDK: "SEA LEVEL PRESSURE - Barometric pressure at sea level. Unit: Millibars"
  { name: 'seaLevelPressureMb', simvar: 'SEA LEVEL PRESSURE', unit: 'millibars' },
  // First-priority convective-risk weather probes. Downstream code treats them
  // as nullable diagnostics because MSFS weather SimVars can be source-specific.
  { name: 'precipRateMm', simvar: 'AMBIENT PRECIP RATE', unit: 'millimeters of water' },
  { name: 'precipState', simvar: 'AMBIENT PRECIP STATE', unit: 'mask' },
  { name: 'inCloud', simvar: 'AMBIENT IN CLOUD', unit: 'bool' },
  { name: 'densityAlt', simvar: 'DENSITY ALTITUDE', unit: 'feet' },
  
  // Autopilot
  { name: 'apMaster', simvar: 'AUTOPILOT MASTER', unit: 'bool' },
  { name: 'apAltHold', simvar: 'AUTOPILOT ALTITUDE LOCK', unit: 'bool' },
  { name: 'apHdgHold', simvar: 'AUTOPILOT HEADING LOCK', unit: 'bool' },
  { name: 'apNavHold', simvar: 'AUTOPILOT NAV1 LOCK', unit: 'bool' },
  { name: 'apApprHold', simvar: 'AUTOPILOT APPROACH HOLD', unit: 'bool' },
  { name: 'apVsHold', simvar: 'AUTOPILOT VERTICAL HOLD', unit: 'bool' },
  { name: 'apFlcHold', simvar: 'AUTOPILOT FLIGHT LEVEL CHANGE', unit: 'bool' },
  { name: 'apSpeedHold', simvar: 'AUTOPILOT AIRSPEED HOLD', unit: 'bool' },
  { name: 'apFdActive', simvar: 'AUTOPILOT FLIGHT DIRECTOR ACTIVE', unit: 'bool' },
  { name: 'athrActive', simvar: 'AUTOTHROTTLE ACTIVE', unit: 'bool' },
  // SDK: Aircraft Autopilot/Assistant SimVars
  // https://docs.flightsimulator.com/html/Programming_Tools/SimVars/Aircraft_SimVars/Aircraft_AutopilotAssistant_Variables.htm
  { name: 'apAltTargetFt', simvar: 'AUTOPILOT ALTITUDE LOCK VAR', unit: 'feet' },
  { name: 'apHdgTargetDeg', simvar: 'AUTOPILOT HEADING LOCK DIR', unit: 'degrees' },
  { name: 'apVsTargetFpm', simvar: 'AUTOPILOT VERTICAL HOLD VAR', unit: 'feet per minute' },
  { name: 'apSpeedTargetKts', simvar: 'AUTOPILOT AIRSPEED HOLD VAR', unit: 'knots' },
  // Unit is documented as "Number" (Mach), but we request in 'mach' to match AIRSPEED MACH usage.
  { name: 'apMachTarget', simvar: 'AUTOPILOT MACH HOLD VAR', unit: 'mach' },
  // Note: This is the SimVar name in the SDK (not "AUTOTHROTTLE ARM")
  { name: 'athrArmed', simvar: 'AUTOPILOT THROTTLE ARM', unit: 'bool' },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // STILL OMITTED FROM THE BASE LIST:
  // These are display-only vars and non-core probes. They will return null but
  // should not break scoring/detection.
  //
  // Restored for Rust SimVars cap testing: lateral acceleration, N2, cabin
  // altitude rate/differential pressure, and ILS needles.
  //
  // Engine gauges (12 vars): eng1-4 EGT, eng1-4 FF, eng1-4 Rev
  // Turboprop (6 vars): eng1-2 ITT, prop1-2 RPM, prop1-2 Beta
  // Piston (4 vars): eng1-2 MP, eng1-2 RPM
  // Control surfaces (3 vars): aileron/elevator/rudder position
  // Trim (3 vars): aileron/elevator/rudder trim
  // Cabin (2 vars): target, dump switch
  // Weather display extras beyond the restored convective-risk probes
  // Slew (1 var): slewAllowed  (removed; slewActive covers active use; pressureAlt added for sparkline baro-spike fix)
  // Misc (2 vars): barberPoleMach, machMaxOperate
  //
  // Frontend will show null for omitted display-only gauges.
  // Per target aircraft philosophy: focus on jet and airliner operations. N1 is critical (kept).
  // If needed: restore when MSFS limit increases or implement dynamic loading.
  // ═══════════════════════════════════════════════════════════════════════════
];

// Some complex aircraft expose the standard LIGHT STATES value
// correctly to the gauge/calculator API while returning zero through a native
// SimConnect data definition. Keep one independent read on the LVAR sidecar so
// the shared light fallback does not silently turn every light off when that
// native-path mismatch occurs.
const STANDARD_LIGHT_FALLBACK_SUBSCRIPTIONS = Object.freeze([
  Object.freeze({
    key: 'standard_light_states',
    expression: '(A:LIGHT STATES)',
    sourcePath: 'runtime.standard-light-fallback',
  }),
]);

// ═══════════════════════════════════════════════════════════════════════════
// SIMCONNECT VARIABLE LIMIT
//
// Configurable chunk size for Rust sidecar SimVar subscription batches.
const SIMCONNECT_CHUNK_SIZE = config.simconnect.chunkSize;

const RUST_SIMVARS_MAX_VARS = config.simconnect.rustMaxVars || SIMCONNECT_VARS.length;
const RUST_AIRCRAFT_TITLE_KEY = 'aircraftTitle';
const RUST_AIRCRAFT_TITLE_READBACK_DELAY_MS = 500;
const RUST_TITLE_FALLBACK_CHANGE_DELAY_MS = 1000;
const RUST_SIMVAR_STALE_DISCONNECT_MS = Math.max(
  3000,
  Number(config.simconnect?.rustStaleDisconnectMs || 12000),
);
const RUST_AIRCRAFT_TITLE_SUBSCRIPTION = Object.freeze({
  key: RUST_AIRCRAFT_TITLE_KEY,
  expression: 'TITLE',
  unit: '',
  dataType: 'string256',
});

function nonEmptyTrimmedString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function buildAircraftChangedPayload({
  aircraftConfigPath = null,
  displayName = null,
  previousAircraftConfigPath = null,
  previousDisplayName = null,
  reason = null,
  timestamp = null,
} = {}) {
  const normalizedConfigPath = nonEmptyTrimmedString(aircraftConfigPath);
  const normalizedDisplayName = nonEmptyTrimmedString(displayName);
  const normalizedPreviousConfigPath = nonEmptyTrimmedString(previousAircraftConfigPath);
  const normalizedPreviousDisplayName = nonEmptyTrimmedString(previousDisplayName);

  return {
    // Backward-compatible aliases. Prefer the explicit fields below in new code.
    title: normalizedConfigPath || normalizedDisplayName,
    previousTitle: normalizedPreviousConfigPath || normalizedPreviousDisplayName,
    displayName: normalizedDisplayName,
    previousDisplayName: normalizedPreviousDisplayName,
    aircraftConfigPath: normalizedConfigPath,
    previousAircraftConfigPath: normalizedPreviousConfigPath,
    reason: nonEmptyTrimmedString(reason),
    timestamp: nonEmptyTrimmedString(timestamp) || new Date().toISOString(),
  };
}

class SimConnectTelemetryProvider {
  [key: string]: any;

  constructor() {
    this._connected = false;
    this._available = false;
    
    // Telemetry data storage
    this._data = {};
    this._rustSimvarSnapshotSequence = 0;
    this._rustLightStatesUpdatedAt = null;
    this._rustLightStatesSequence = 0;
    this._rustNavRadioSamples = {};
    this._rustControlReadbackNotBeforeMs = 0;
    
    // Overspeed/stall warning state
    this._overspeedActive = false;
    this._stallActive = false;
    
    // Fuel exhaustion state
    this._fuelExhausted = false;  // True when fuel drops below threshold
    
    // Warmup counter for warning detection
    // Prevents false positives during flight initialization/resume when telemetry may be invalid
    this._sampleCount = 0;
    this._WARNING_WARMUP_SAMPLES = 30;  // ~3 seconds at 100ms poll rate
    
    // Exception rate-limiting (avoid log spam in menu state)
    this._lastExceptionLogMs = 0;
    this._exceptionCount = 0;
    
    // Track inFlightContext to suppress warnings from invalid menu-state data.
    this._inFlightContext = false;
    
    // SimConnect system state cache (RequestSystemState)
    // sim: 1=user controlling aircraft, 0=user navigating UI/menu
    // dialogMode: 1=dialog active, 0=no dialog
    this._systemState = {
      sim: null,
      dialogMode: null,
      updatedAtMs: 0,
    };

    // SimConnect system event cache (SimStart/SimStop)
    this._simRunning = null;

    // Broadcast callback
    this._onBroadcast = null;

    // Init work captures a lifecycle generation. Stop advances it so an
    // already-awaiting initializer cannot publish or abandon a new sidecar.
    this._lifecycleGeneration = 0;
    this._stopping = false;
    this._providerStartPromise = null;
    this._providerStopPromise = null;
    this._lvarInitPromise = null;
    this._rustSimvarInitPromise = null;
    this._sdkInitPromise = null;
    this._sdkInitRequestSequence = 0;

    this._lastDetectedAircraftTitle = null;
    this._lastDetectedAircraftDisplayName = null; // TITLE simvar (human-readable name from aircraft.cfg)

    // Optional LVAR sidecar bridge (disabled by default via config)
    this._lvarBridge = null;
    this._lvarConfig = { enabled: false, profileId: 'generic', subscriptions: [] };
    this._debugLvarSubscriptions = [];
    this._lvarAircraftListener = null;
    this._lastDataSourceSignature = null;
    this._aircraftIntegrationActionLastAttemptAt = new Map();
    this._aircraftIntegrationActionsInFlight = new Set();
    this._profileKeyEventLastAttemptAt = new Map();
    this._profileKeyEventsInFlight = new Set();

    // Rust SimVar bridge is the primary MSFS generic telemetry path.
    this._rustSimvarBridge = null;
    this._msfsFacilitiesGeometryProvider = null;
    this._msfsFacilitiesProbeTimer = null;
    this._msfsFacilitiesProbePausedUntilMs = 0;
    this._msfsFacilitiesProbeConsecutiveFailures = 0;
    this._rustSimvarData = {};
    this._rustSimvarUpdatedAt = null;
    this._rustSimvarStaleDisconnectLogged = false;
    this._rustAircraftChangedTimer = null;
    this._rustTitleFallbackTimer = null;
    this._rustTitleFallbackNeedsPathConfirmation = false;
    this._rustIgnoredAircraftLoadedDisplayName = null;

    // Optional SDK bridge (started when the active profile defines dataSource.sdk)
    this._sdkBridge = null;
    this._sdkAircraftListener = null;
    
    this.capabilities = {
      isMock: false,
      enableLandingRunner: true,
    };
  }

  setBroadcast(fn) {
    this._onBroadcast = fn;
  }

  _canInitialize(generation = this._lifecycleGeneration) {
    return !this._stopping && generation === this._lifecycleGeneration;
  }

  _bridgeMayBeLive(bridge) {
    if (!bridge) return false;
    if (bridge._started === true) return true;
    const child = bridge._proc;
    if (!child) return false;
    return child.exitCode == null && child.signalCode == null;
  }

  getAircraftControlCapabilities() {
    const mobiflight = this._getMobiFlightHealth(this._lvarBridge);
    const sdkSnapshot = this._sdkBridge?.getSnapshot?.() || null;
    const sdkConnected = this._sdkBridge?.isDataConnected?.() === true
      && sdkSnapshot?.adapterId === 'clientdata-manifest'
      && (
        typeof this._lvarBridge?.sendSdkEvent === 'function'
        || typeof this._lvarBridge?.sendEvent === 'function'
      );
    const simconnectSequenceConnected = this._bridgeMayBeLive(this._lvarBridge)
      && typeof this._lvarBridge?.sendEvent === 'function'
      && typeof this._lvarBridge?.setNamedVar === 'function';
    const directLvarConnected = this._bridgeMayBeLive(this._lvarBridge)
      && typeof this._lvarBridge?.setNamedVar === 'function';
    const integrationTransports = {
      'mobiflight-calculator': mobiflight.connected,
      lvar: directLvarConnected,
      sdk: sdkConnected,
      'simconnect-sequence': simconnectSequenceConnected,
    };
    const actionTypes = [
      'key-event',
      'lvar',
      'simvar',
    ];
    if (Object.values(integrationTransports).some(Boolean)) {
      actionTypes.push('aircraft-integration');
    }
    return {
      simulator: 'msfs',
      actionTypes,
      integrationTransports,
      mobiflight,
    };
  }

  async executeAircraftControlAction(action, options = {}) {
    if (!action || typeof action !== 'object') {
      return {
        ok: false,
        code: 'invalid_action',
        error: 'Invalid aircraft control action.',
      };
    }

    if (this._stopping) {
      return {
        ok: false,
        code: 'provider_stopping',
        error: 'MSFS control writes are unavailable while the telemetry provider is stopping.',
      };
    }

    const bridge = await this._ensureControlWriteBridge();
    if (!bridge) {
      return {
        ok: false,
        code: 'sidecar_unavailable',
        error: 'MSFS control writes require the SimConnect sidecar bridge.',
      };
    }

    const backendSource = bridge.getSnapshot?.().source || null;
    const writesThroughGenericProfile = action.type === 'key-event'
      || action.type === 'simvar'
      || action.type === 'lvar';
    if (writesThroughGenericProfile) {
      const profileGenerationError = this._validateAircraftControlProfileGeneration(options);
      if (profileGenerationError) {
        return {
          ...profileGenerationError,
          backendSource,
        };
      }
    }

    try {
      switch (action.type) {
        case 'key-event':
          return this._executeKeyEventAction(bridge, action, backendSource, options);
        case 'simvar':
        case 'lvar':
          return this._executeNamedVarAction(bridge, action, backendSource);
        case 'input-event':
          return this._executeInputEventAction(action, backendSource);
        case 'aircraft-integration':
          return this._executeAircraftIntegrationAction(bridge, action, backendSource, options);
        case 'html-event':
          return {
            ok: false,
            code: 'unsupported_action',
            error: 'HTML event actions are not implemented for external MSFS control writes yet.',
            backendSource,
          };
        default:
          return {
            ok: false,
            code: 'unsupported_action',
            error: `Unsupported MSFS control action type: ${action.type || 'unknown'}`,
            backendSource,
          };
      }
    } catch (err) {
      return {
        ok: false,
        code: 'action_failed',
        error: err && err.message ? err.message : 'Failed to execute aircraft control action.',
        backendSource,
      };
    }
  }

  async start() {
    if (this._providerStopPromise) {
      await this._providerStopPromise;
    }
    if (this._providerStartPromise) {
      await this._providerStartPromise;
      return;
    }

    this._stopping = false;
    const generation = this._lifecycleGeneration + 1;
    this._lifecycleGeneration = generation;
    const startPromise = this._startRustPrimary(generation);
    this._providerStartPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this._providerStartPromise === startPromise) {
        this._providerStartPromise = null;
      }
    }
  }

  async _initSdkBridge() {
    const generation = this._lifecycleGeneration;
    if (!this._canInitialize(generation)) return;

    this._sdkInitRequestSequence += 1;
    if (this._sdkInitPromise) {
      await this._sdkInitPromise;
      return;
    }

    const initPromise = (async () => {
      try {
        while (this._canInitialize(generation)) {
          const requestSequence = this._sdkInitRequestSequence;
          await this._initSdkBridgeOnce(generation);
          if (requestSequence === this._sdkInitRequestSequence) break;
        }
      } finally {
        // Clear before the shared promise resolves. A later request therefore
        // starts a fresh serialized drain rather than attaching to stale work.
        this._sdkInitPromise = null;
      }
    })();
    this._sdkInitPromise = initPromise;
    await initPromise;
  }

  async _initSdkBridgeOnce(generation) {
    if (!this._canInitialize(generation)) return;

    // Always register the aircraft listener so SDK-backed aircraft loaded later
    // in the session can create/connect the bridge on first need.
    if (!this._sdkAircraftListener) {
      this._sdkAircraftListener = () => {
        this._initSdkBridge().catch(() => {});
      };
      eventBus.on('simconnect:aircraftChanged', this._sdkAircraftListener);
    }

    const resolvedSdk = this._resolveActiveSdkProfile();
    if (!resolvedSdk) {
      if (this._canInitialize(generation)) {
        this._sdkBridge?.connect(null);
        this._broadcastDataSourcesIfLvarStatusChanged();
      }
      return;
    }

    if (!this._sdkBridge || this._sdkBridge?._adapter?.id !== resolvedSdk.adapter.id) {
      const previousBridge = this._sdkBridge;
      if (previousBridge) {
        await previousBridge.stop();
        if (!this._canInitialize(generation)) return;
        if (this._bridgeMayBeLive(previousBridge)) {
          throw new Error('Prior SDK sidecar remained live after stop resolved');
        }
        if (this._sdkBridge === previousBridge) {
          this._sdkBridge = null;
        }
      }
      if (!this._canInitialize(generation)) return;
      this._sdkBridge = new SdkBridge(resolvedSdk.adapter);
    }

    const bridge = this._sdkBridge;
    if (!bridge._started) {
      try {
        await bridge.start();
      } catch (err) {
        Debug.log('simconnect-telemetry', 'sdk_bridge_start_failed', {
          adapterId: resolvedSdk.adapter.id,
          error: err?.message || String(err),
        });
        return;
      }
    }

    if (!this._canInitialize(generation) || this._sdkBridge !== bridge) {
      await bridge.stop();
      return;
    }

    bridge.connect(resolvedSdk.profileSdk.target);
    this._broadcastDataSourcesIfLvarStatusChanged();
  }

  async _initLvarBridge() {
    const generation = this._lifecycleGeneration;
    if (!this._canInitialize(generation)) return;
    if (this._lvarInitPromise) {
      await this._lvarInitPromise;
      return;
    }

    const initPromise = this._initLvarBridgeOnce(generation);
    this._lvarInitPromise = initPromise;
    try {
      await initPromise;
    } finally {
      if (this._lvarInitPromise === initPromise) {
        this._lvarInitPromise = null;
      }
    }
  }

  async _initLvarBridgeOnce(generation) {
    if (!this._canInitialize(generation)) return;
    if (!this._lvarBridge) {
      this._lvarBridge = new LvarSidecarBridge();
    }

    const bridge = this._lvarBridge;
    if (!bridge.isEnabled()) {
      return;
    }

    // Control writes also call this as an idempotent ensure. Only a real
    // start/restart attempt is a subscription boundary; reloading an already
    // running bridge here would clear the fresh snapshot needed for preflight.
    const wasStarted = Boolean(bridge._started);

    try {
      await bridge.start();
    } catch (err) {
      Debug.log('simconnect-telemetry', 'lvar_sidecar_start_failed', { error: err?.message || String(err) });
      return;
    }

    if (!this._canInitialize(generation) || this._lvarBridge !== bridge) {
      await bridge.stop();
      return;
    }

    if (!wasStarted) {
      this._reloadLvarSubscriptions('provider-start');
    }

    // NOTE: No warmup heartbeat for CameraSetRelative6DOF.
    // Sending pitch=0 periodically (even as a "keep-alive") permanently holds MSFS
    // in camera override mode, which locks the user's camera until the SimConnect
    // session ends. The shake animation sends a final pitch=0 itself at the end of
    // each animation, after which MSFS naturally releases the override when no
    // further updates arrive. Cold-path calls work without a warmup.

    if (!this._lvarAircraftListener) {
      this._lvarAircraftListener = () => {
        this._reloadLvarSubscriptions('aircraft-changed');
      };
      eventBus.on('simconnect:aircraftChanged', this._lvarAircraftListener);
    }
  }

  async _startRustPrimary(generation = this._lifecycleGeneration) {
    if (!this._canInitialize(generation)) return;
    console.log('[SimConnectTelemetry] Starting Rust-primary SimConnect provider...');
    this._available = true;
    this._connected = false;
    this._sampleCount = 0;

    await this._initRustSimvarBridge(generation);
    if (!this._canInitialize(generation)) return;
    await this._initLvarBridge();
    if (!this._canInitialize(generation)) return;
    await this._initSdkBridge();
  }

  async _initRustSimvarBridge(generation = this._lifecycleGeneration) {
    if (!this._canInitialize(generation)) return;
    if (this._rustSimvarInitPromise) {
      await this._rustSimvarInitPromise;
      return;
    }

    const initPromise = this._initRustSimvarBridgeOnce(generation);
    this._rustSimvarInitPromise = initPromise;
    try {
      await initPromise;
    } finally {
      if (this._rustSimvarInitPromise === initPromise) {
        this._rustSimvarInitPromise = null;
      }
    }
  }

  async _initRustSimvarBridgeOnce(generation) {
    if (!this._canInitialize(generation)) return;
    if (!this._rustSimvarBridge) {
      this._rustSimvarBridge = new RustSimvarBridge({
        enabled: true,
        chunkSize: SIMCONNECT_CHUNK_SIZE,
        pollIntervalMs: config.poll?.rateMs || 200,
        onSnapshot: (snapshot) => this._handleRustSimvarSnapshot(snapshot),
        onStatus: (snapshot) => this._handleRustSimvarStatus(snapshot),
        onSystemState: (message) => this._handleRustSystemState(message),
        onSystemEvent: (message) => this._handleRustSystemEvent(message),
        onLifecycle: (message) => this._handleRustLifecycle(message),
        onException: (message) => this._handleRustException(message),
      });
    }

    const bridge = this._rustSimvarBridge;

    try {
      await bridge.start();
      if (!this._canInitialize(generation) || this._rustSimvarBridge !== bridge) {
        await bridge.stop();
        return;
      }
      const startupSnapshot = bridge.getSnapshot?.() || null;
      if (startupSnapshot?.status === 'error') {
        throw new Error(startupSnapshot.error || 'Rust SimVar bridge failed to start');
      }
      const subscriptions = this._buildRustSimvarSubscriptions();
      bridge.setSimVars(subscriptions);
      this._registerMsfsFacilitiesGeometryProvider();
      console.log(`[RustSimVars] primary mode enabled with ${subscriptions.length} subscriptions`);
    } catch (err) {
      Debug.log('simconnect-telemetry', 'rust_simvar_bridge_start_failed', {
        error: err?.message || String(err),
      });
      this._available = false;
      throw err;
    }
  }

  _buildRustSimvarSubscriptions() {
    const effectiveCount = Math.min(RUST_SIMVARS_MAX_VARS, SIMCONNECT_VARS.length);
    const subscriptions = SIMCONNECT_VARS.slice(0, effectiveCount).map((item) => {
      const isInt = usesInt32SimConnectData(item.unit);
      return {
        key: item.name,
        expression: item.simvar,
        unit: simConnectUnitString(item.unit),
        dataType: isInt ? 'int32' : 'float64',
        isolated: item.isolated === true,
      };
    });
    return [
      ...subscriptions,
      { ...RUST_AIRCRAFT_TITLE_SUBSCRIPTION },
    ];
  }

  _handleRustSimvarSnapshot(snapshot) {
    this._rustSimvarSnapshotSequence += 1;
    const values = snapshot?.values && typeof snapshot.values === 'object'
      ? snapshot.values
      : {};
    const updates = {};
    const aircraftTitle = this._coerceRustAircraftTitle(values[RUST_AIRCRAFT_TITLE_KEY]);
    if (aircraftTitle) {
      this._handleRustAircraftTitleReadback(aircraftTitle, snapshot?.updatedAt || null);
    }

    for (const varDef of SIMCONNECT_VARS) {
      if (!Object.prototype.hasOwnProperty.call(values, varDef.name)) continue;
      const value = this._coerceRustSimvarValue(varDef, values[varDef.name]);
      if (NAV_RADIO_FIELDS.has(varDef.name)) {
        const fieldUpdatedAt = snapshot?.valueUpdatedAt?.[varDef.name];
        this._rustNavRadioSamples[varDef.name] = { value,
          updatedAt: typeof fieldUpdatedAt === 'string' && Date.parse(fieldUpdatedAt) >= this._rustControlReadbackNotBeforeMs
            ? fieldUpdatedAt : null };
        if (value == null) {
          delete this._data[varDef.name];
          delete this._rustSimvarData[varDef.name];
        }
      }
      if (varDef.name === 'lightStates') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
          delete this._data.lightStates;
          delete this._rustSimvarData.lightStates;
          this._rustLightStatesUpdatedAt = null;
          continue;
        }
        const sampleUpdatedAt = snapshot?.valueUpdatedAt
          ? snapshot.valueUpdatedAt.lightStates || null : snapshot?.updatedAt || null;
        const lightUpdatedAt = typeof sampleUpdatedAt === 'string' && Date.parse(sampleUpdatedAt) >= this._rustControlReadbackNotBeforeMs
          ? sampleUpdatedAt : null;
        if (lightUpdatedAt !== this._rustLightStatesUpdatedAt) this._rustLightStatesSequence += 1;
        this._rustLightStatesUpdatedAt = lightUpdatedAt;
      }
      if (value == null) continue;
      updates[varDef.name] = value;
    }

    if (Object.keys(updates).length === 0) {
      if (aircraftTitle) this._rustSimvarUpdatedAt = snapshot?.updatedAt || null;
      return;
    }

    this._rustSimvarData = {
      ...this._rustSimvarData,
      ...updates,
    };
    this._rustSimvarUpdatedAt = snapshot?.updatedAt || null;
    Object.assign(this._data, updates);
  }

  _handleRustSimvarStatus(snapshot) {
    const status = snapshot?.status || 'unknown';
    if (status === 'connected' || status === 'running') {
      if (!this._connected) {
        console.log('[SimConnectTelemetry] Rust SimConnect session connected');
      }
      this._connected = true;
      this._available = true;
      this._rustSimvarStaleDisconnectLogged = false;
      return;
    }

    if (status === 'disconnected' || status === 'stopped' || status === 'error') {
      this._connected = false;
    }
  }

  _handleRustSystemState(message) {
    const name = typeof message?.name === 'string' ? message.name : '';
    const integer = Number.isFinite(message?.integer) ? Number(message.integer) : null;

    if (name === 'Sim') {
      this._systemState.sim = (integer === 0 || integer === 1) ? integer : null;
      this._systemState.updatedAtMs = Date.now();
      return;
    }

    if (name === 'DialogMode') {
      this._systemState.dialogMode = (integer === 0 || integer === 1) ? integer : null;
      this._systemState.updatedAtMs = Date.now();
      return;
    }

    if (name !== 'AircraftLoaded') return;
    const title = typeof message?.string === 'string' ? message.string.trim() : '';
    if (!title) return;

    if (title === this._lastDetectedAircraftTitle) {
      // A TITLE-only fallback can run while MSFS is finishing a livery load for
      // the same aircraft.cfg. Once AircraftLoaded confirms that the cached path
      // is still current, re-emit the complete identity so vendor-safe config
      // path matching can restore the aircraft profile instead of leaving the
      // generic fallback active indefinitely.
      if (this._rustTitleFallbackTimer || this._rustTitleFallbackNeedsPathConfirmation) {
        this._clearRustTitleFallbackTimer();
        this._rustTitleFallbackNeedsPathConfirmation = false;
        eventBus.emit('simconnect:aircraftChanged', buildAircraftChangedPayload({
          aircraftConfigPath: title,
          displayName: this._lastDetectedAircraftDisplayName || null,
          previousAircraftConfigPath: title,
          reason: 'RustSystemState:AircraftLoadedIdentityConfirmed',
          timestamp: message?.timestampIso || new Date().toISOString(),
        }));
      }
      return;
    }

    this._resetTelemetryForAircraftChange('RustSystemState:AircraftLoaded');

    const previousTitle = this._lastDetectedAircraftTitle;
    const previousDisplayName = this._lastDetectedAircraftDisplayName || null;
    this._lastDetectedAircraftTitle = title;
    this._lastDetectedAircraftDisplayName = null;
    this._rustTitleFallbackNeedsPathConfirmation = false;
    this._rustIgnoredAircraftLoadedDisplayName = previousDisplayName;
    this._clearRustTitleFallbackTimer();
    Debug.log('simconnect-telemetry', 'rustSystemState:AircraftLoaded', {
      title,
      previousTitle,
    });
    this._emitRustAircraftChangedAfterTitleReadback({
      title,
      previousTitle,
      previousDisplayName,
      timestamp: message?.timestampIso || new Date().toISOString(),
    });
  }

  _handleRustSystemEvent(message) {
    const name = typeof message?.name === 'string' ? message.name : '';
    if (name === 'SimStart') {
      this._simRunning = true;
      Debug.log('simconnect-telemetry', 'Rust system event SimStart');
    } else if (name === 'SimStop') {
      this._simRunning = false;
      Debug.log('simconnect-telemetry', 'Rust system event SimStop');
    }
  }

  _handleRustLifecycle(message) {
    const event = typeof message?.event === 'string' ? message.event : '';
    if (event !== 'quit') return;
    this._connected = false;
    Debug.log('simconnect-telemetry', 'rust_quit', { timestamp: new Date().toISOString() });

    if (config.simconnect.exitOnClose) {
      process.emit('SIGTERM');
    }
  }

  _handleRustException(message) {
    this._exceptionCount++;
    const now = Date.now();
    const shouldLog = (now - this._lastExceptionLogMs) >= 5000;
    if (shouldLog) {
      const count = this._exceptionCount;
      this._exceptionCount = 0;
      this._lastExceptionLogMs = now;
      console.warn(`[SimConnectTelemetry] Rust SimConnect exceptions: ${count} in last period (last: code ${message?.exception}, sendID=${message?.sendId ?? 'n/a'})`);
    }
    Debug.log('simconnect-telemetry', 'rust_exception', {
      exception: message?.exception,
      sendId: message?.sendId,
    });
  }

  _coerceRustSimvarValue(varDef, rawValue) {
    if (rawValue == null) return null;
    if (varDef.unit === 'bool') {
      return coerceSimConnectBool(rawValue);
    }
    if (typeof rawValue === 'number') {
      return Number.isFinite(rawValue) ? rawValue : null;
    }
    const numeric = Number(rawValue);
    return Number.isFinite(numeric) ? numeric : null;
  }

  _coerceRustAircraftTitle(rawValue) {
    return typeof rawValue === 'string' ? rawValue.trim() : '';
  }

  _resetTelemetryForAircraftChange(reason) {
    this._rustControlReadbackNotBeforeMs = Date.now();
    this._data = {};
    this._rustSimvarData = {};
    this._rustSimvarUpdatedAt = null;
    this._rustSimvarSnapshotSequence = 0;
    this._rustLightStatesUpdatedAt = null;
    this._rustLightStatesSequence = 0;
    this._rustNavRadioSamples = {};
    this._sampleCount = 0;
    this._debuggedNullVars = null;
    this._overspeedActive = false;
    this._stallActive = false;
    this._fuelExhausted = false;
    Debug.log('simconnect-telemetry', 'telemetry reset for aircraft change', {
      reason: reason || 'aircraftChanged',
    });
  }

  _handleRustAircraftTitleReadback(title, timestamp) {
    if (!title || title === this._lastDetectedAircraftDisplayName) return;
    if (
      this._rustAircraftChangedTimer &&
      this._rustIgnoredAircraftLoadedDisplayName &&
      title === this._rustIgnoredAircraftLoadedDisplayName
    ) {
      Debug.log('simconnect-telemetry', 'Ignoring stale Rust TITLE simvar from previous aircraft', { title });
      return;
    }
    const previousDisplayName = this._lastDetectedAircraftDisplayName || null;
    this._lastDetectedAircraftDisplayName = title;
    Debug.log('simconnect-telemetry', 'Rust TITLE simvar received', { title });

    if (!previousDisplayName || this._rustAircraftChangedTimer) return;
    this._scheduleRustTitleFallbackAircraftChanged({
      title,
      previousTitle: previousDisplayName,
      timestamp,
    });
  }

  _emitRustAircraftChangedAfterTitleReadback({ title, previousTitle, previousDisplayName, timestamp }) {
    if (this._rustAircraftChangedTimer) {
      clearTimeout(this._rustAircraftChangedTimer);
      this._rustAircraftChangedTimer = null;
    }

    this._rustAircraftChangedTimer = setTimeout(() => {
      this._rustAircraftChangedTimer = null;
      this._rustIgnoredAircraftLoadedDisplayName = null;
      eventBus.emit('simconnect:aircraftChanged', buildAircraftChangedPayload({
        aircraftConfigPath: title,
        displayName: this._lastDetectedAircraftDisplayName || null,
        previousAircraftConfigPath: previousTitle,
        previousDisplayName,
        reason: 'RustSystemState:AircraftLoaded',
        timestamp: timestamp || new Date().toISOString(),
      }));
    }, RUST_AIRCRAFT_TITLE_READBACK_DELAY_MS);
    try { this._rustAircraftChangedTimer.unref?.(); } catch {}
  }

  _scheduleRustTitleFallbackAircraftChanged({ title, previousTitle, timestamp }) {
    this._clearRustTitleFallbackTimer();
    this._rustTitleFallbackTimer = setTimeout(() => {
      this._rustTitleFallbackTimer = null;
      this._rustTitleFallbackNeedsPathConfirmation = true;
      eventBus.emit('simconnect:aircraftChanged', buildAircraftChangedPayload({
        displayName: title,
        previousDisplayName: previousTitle,
        reason: 'RustSimvar:TITLE',
        timestamp: timestamp || new Date().toISOString(),
      }));
    }, RUST_TITLE_FALLBACK_CHANGE_DELAY_MS);
    try { this._rustTitleFallbackTimer.unref?.(); } catch {}
  }

  _clearRustTitleFallbackTimer() {
    if (!this._rustTitleFallbackTimer) return;
    clearTimeout(this._rustTitleFallbackTimer);
    this._rustTitleFallbackTimer = null;
  }

  async _ensureControlWriteBridge() {
    const generation = this._lifecycleGeneration;
    if (!this._canInitialize(generation)) return null;
    await this._initLvarBridge();
    if (
      !this._canInitialize(generation)
      || !this._lvarBridge
      || !this._lvarBridge._started
    ) {
      return null;
    }
    return this._lvarBridge;
  }

  _extractActionScalar(action, defaultValue = undefined) {
    if (!action || typeof action !== 'object') return defaultValue;
    if (Object.prototype.hasOwnProperty.call(action, 'value')) {
      return action.value;
    }
    if (Array.isArray(action.parameters) && action.parameters.length > 0) {
      return action.parameters[0];
    }
    return defaultValue;
  }

  _normalizeActionNumber(rawValue) {
    if (rawValue === true) return 1;
    if (rawValue === false) return 0;
    const value = Number(rawValue);
    return Number.isFinite(value) && Math.abs(value) <= MAX_CONTROL_NUMERIC_ABS ? value : null;
  }

  _registerMsfsFacilitiesGeometryProvider() {
    if (!this._rustSimvarBridge || this._msfsFacilitiesGeometryProvider) return;
    if (config.simconnect?.facilitiesEnable !== true) {
      console.log('[MSFS Facilities] live geometry provider disabled; using bundled fallback geometry');
      return;
    }
    try {
      this._msfsFacilitiesGeometryProvider = createMsfsFacilitiesGeometryProvider(this._rustSimvarBridge);
      registerAirportGeometryProvider(this._msfsFacilitiesGeometryProvider);
      console.log('[MSFS Facilities] geometry provider registered (Rust SimVars bridge)');
      this._startMsfsFacilitiesProbe();
    } catch (err) {
      Debug.log('simconnect-telemetry', 'msfs_facilities_provider_register_failed', {
        error: err?.message || String(err),
      });
    }
  }

  _startMsfsFacilitiesProbe() {
    if (config.simconnect?.facilitiesProbeEnable === false) return;
    if (this._msfsFacilitiesProbeTimer) return;
    const intervalMs = Math.max(1000, Number(config.simconnect?.facilitiesProbeIntervalMs || 10000));
    const timeoutMs = this._getMsfsFacilitiesProbeTimeoutMs();
    const backoffMs = this._getMsfsFacilitiesProbeFailureBackoffMs();
    this._msfsFacilitiesProbeTimer = setInterval(() => {
      this._safeRunMsfsFacilitiesProbeTick('interval');
    }, intervalMs);
    try { this._msfsFacilitiesProbeTimer.unref?.(); } catch {}
    console.log(`[MSFS Facilities] diagnostic probe enabled interval=${intervalMs}ms timeout=${timeoutMs}ms failureBackoff=${backoffMs}ms`);
    this._safeRunMsfsFacilitiesProbeTick('startup');
  }

  _stopMsfsFacilitiesProbe() {
    if (!this._msfsFacilitiesProbeTimer) return;
    clearInterval(this._msfsFacilitiesProbeTimer);
    this._msfsFacilitiesProbeTimer = null;
    this._msfsFacilitiesProbePausedUntilMs = 0;
    this._msfsFacilitiesProbeConsecutiveFailures = 0;
  }

  _getMsfsFacilitiesProbeTimeoutMs() {
    return Math.max(500, Math.min(4000, Number(config.simconnect?.facilitiesProbeTimeoutMs || 1500)));
  }

  _getMsfsFacilitiesProbeFailureBackoffMs() {
    return Math.max(10000, Number(config.simconnect?.facilitiesProbeFailureBackoffMs || 60000));
  }

  _recordMsfsFacilitiesProbeSuccess() {
    this._msfsFacilitiesProbeConsecutiveFailures = 0;
    this._msfsFacilitiesProbePausedUntilMs = 0;
  }

  _recordMsfsFacilitiesProbeFailure() {
    const failures = Math.max(0, Number(this._msfsFacilitiesProbeConsecutiveFailures || 0)) + 1;
    const maxFailures = Math.max(1, Number(config.simconnect?.facilitiesProbeMaxFailures || 3));
    const baseBackoffMs = this._getMsfsFacilitiesProbeFailureBackoffMs();
    const backoffMs = failures >= maxFailures ? baseBackoffMs * 5 : baseBackoffMs;
    this._msfsFacilitiesProbeConsecutiveFailures = failures;
    this._msfsFacilitiesProbePausedUntilMs = Date.now() + backoffMs;
    return { failures, backoffMs };
  }

  _updateMsfsFacilitiesProbeBackoff(probeResult) {
    if (!probeResult || typeof probeResult !== 'object') return '';
    if (probeResult.ok === true) {
      this._recordMsfsFacilitiesProbeSuccess();
      return ' failures=0';
    }
    if (probeResult.ok !== false || probeResult.error === 'pending') return '';
    const backoff = this._recordMsfsFacilitiesProbeFailure();
    return ` failures=${backoff.failures} nextProbeInMs=${backoff.backoffMs}`;
  }

  _safeRunMsfsFacilitiesProbeTick(reason = 'interval') {
    try {
      const result = this._runMsfsFacilitiesProbeTick(reason);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => {
          console.warn(`[MSFS Facilities] probe ${reason}: failed error=${err?.message || String(err)}`);
        });
      }
      return result;
    } catch (err) {
      console.warn(`[MSFS Facilities] probe ${reason}: failed error=${err?.message || String(err)}`);
      return null;
    }
  }

  _runMsfsFacilitiesProbeTick(reason = 'interval') {
    const provider = this._msfsFacilitiesGeometryProvider;
    if (!provider || typeof provider !== 'object') return null;
    const diagnostics = typeof provider.getDiagnosticSnapshot === 'function'
      ? provider.getDiagnosticSnapshot()
      : {};
    const bridgeSnapshot = this._rustSimvarBridge?.getSnapshot?.() || {};
    const bridgeStatus = typeof diagnostics.bridgeStatus === 'string' && diagnostics.bridgeStatus
      ? diagnostics.bridgeStatus
      : (typeof bridgeSnapshot.status === 'string' && bridgeSnapshot.status ? bridgeSnapshot.status : 'unknown');
    const requestApi = diagnostics.requestApi === true ? 'yes' : 'no';
    const liveBridge = bridgeStatus === 'connected' || bridgeStatus === 'running';
    const cacheSummary = `cacheAirports=${Number(diagnostics.cacheAirportCount || 0)} cacheRunways=${Number(diagnostics.cacheRunwayCount || 0)}`;

    if (!liveBridge) {
      console.log(`[MSFS Facilities] probe ${reason}: bridge=${bridgeStatus} requestApi=${requestApi} ${cacheSummary} waiting=simconnect`);
      return null;
    }

    const lat = finiteTelemetryNumber(this._data?.lat);
    const lon = finiteTelemetryNumber(this._data?.lon);
    if (!isValidLatLon(lat, lon)) {
      console.log(`[MSFS Facilities] probe ${reason}: bridge=${bridgeStatus} requestApi=${requestApi} ${cacheSummary} waiting=position`);
      return null;
    }

    const radiusNm = Math.max(1, Number(config.simconnect?.facilitiesProbeRadiusNm || 12));
    const target = findNearbyAirport(lat!, lon!, radiusNm, { simulator: 'msfs', offline: true });
    const icao = typeof target?.icao === 'string' && target.icao.trim()
      ? target.icao.trim().toUpperCase()
      : null;
    if (!icao) {
      console.log(`[MSFS Facilities] probe ${reason}: bridge=${bridgeStatus} requestApi=${requestApi} pos=${lat!.toFixed(4)},${lon!.toFixed(4)} target=none radiusNm=${radiusNm}`);
      return null;
    }

    const pauseRemainingMs = Math.max(0, Math.round(Number(this._msfsFacilitiesProbePausedUntilMs || 0) - Date.now()));
    if (pauseRemainingMs > 0) {
      console.log(
        `[MSFS Facilities] probe ${reason}: bridge=${bridgeStatus} requestApi=${requestApi} target=${icao}`
        + ` distanceNm=${Number.isFinite(target?.distanceNm) ? Number(target.distanceNm).toFixed(2) : 'n/a'}`
        + ` paused backoffMs=${pauseRemainingMs}`
        + ` failures=${Number(this._msfsFacilitiesProbeConsecutiveFailures || 0)} ${cacheSummary}`,
      );
      return null;
    }

    const timeoutMs = this._getMsfsFacilitiesProbeTimeoutMs();
    const probePromise = typeof provider.probeAirport === 'function'
      ? provider.probeAirport(icao, { timeoutMs })
      : Promise.resolve(null);
    if (typeof provider.probeAirport !== 'function' && typeof provider.prefetchAirport === 'function') {
      provider.prefetchAirport(icao);
    }
    return Promise.resolve(probePromise)
      .then((probeResult) => {
        const nextDiagnostics = typeof provider.getDiagnosticSnapshot === 'function'
          ? provider.getDiagnosticSnapshot()
          : diagnostics;
        const outcome = probeResult || nextDiagnostics.lastOutcome;
        const backoffSuffix = this._updateMsfsFacilitiesProbeBackoff(outcome);
        console.log(
          `[MSFS Facilities] probe ${reason}: bridge=${bridgeStatus} requestApi=${requestApi} target=${icao}`
          + ` distanceNm=${Number.isFinite(target?.distanceNm) ? Number(target.distanceNm).toFixed(2) : 'n/a'}`
          + ` timeoutMs=${timeoutMs}`
          + ` result=${formatFacilitiesProbeOutcome(outcome)}`
          + ` cacheAirports=${Number(nextDiagnostics.cacheAirportCount || 0)}`
          + ` cacheRunways=${Number(nextDiagnostics.cacheRunwayCount || 0)}`
          + ` cached=${compactIcaoList(nextDiagnostics.cachedIcaos)}`
          + ` pending=${compactIcaoList(nextDiagnostics.pendingIcaos)}`
          + ` last=${formatFacilitiesProbeOutcome(nextDiagnostics.lastOutcome)}`
          + backoffSuffix,
        );
        return probeResult;
      })
      .catch((err) => {
        const backoff = this._recordMsfsFacilitiesProbeFailure();
        console.warn(
          `[MSFS Facilities] probe ${reason}: target=${icao} failed error=${err?.message || String(err)}`
          + ` failures=${backoff.failures} nextProbeInMs=${backoff.backoffMs}`,
        );
        return null;
      });
  }

  _isSafeControlToken(value, maxLength, pattern) {
    return typeof value === 'string'
      && value.length > 0
      && value.length <= maxLength
      && pattern.test(value);
  }

  _buildSidecarResult(ack, backendSource, fallbackError) {
    if (ack && ack.ok === true) {
      return {
        ok: true,
        backendSource,
        executionStarted: true,
      };
    }

    return {
      ok: false,
      code: 'action_failed',
      error: ack && typeof ack.error === 'string' && ack.error
        ? ack.error
        : fallbackError,
      backendSource,
      executionStarted: true,
    };
  }

  _getMobiFlightHealth(bridge) {
    const snapshot = bridge?.getSnapshot?.() || {};
    const rawHealth = snapshot.mobiflight && typeof snapshot.mobiflight === 'object'
      ? snapshot.mobiflight
      : {};
    const state = typeof rawHealth.state === 'string' && rawHealth.state.trim()
      ? rawHealth.state.trim().toLowerCase()
      : (typeof snapshot.mobiflightStatus === 'string' && snapshot.mobiflightStatus.trim()
          ? snapshot.mobiflightStatus.trim().toLowerCase()
          : 'disabled');
    const connected = typeof rawHealth.connected === 'boolean'
      ? rawHealth.connected
      : state === 'connected';
    const available = typeof rawHealth.available === 'boolean'
      ? rawHealth.available
      : connected;
    const error = typeof rawHealth.error === 'string' && rawHealth.error.trim()
      ? rawHealth.error.trim()
      : (typeof snapshot.mobiflightError === 'string' && snapshot.mobiflightError.trim()
          ? snapshot.mobiflightError.trim()
          : null);
    return {
      state,
      connected: connected && available,
      available,
      error,
    };
  }

  _buildMobiFlightUnavailableResult(health, backendSource) {
    if (health.state === 'missing') {
      return {
        ok: false,
        code: 'mobiflight_module_missing',
        error: 'MobiFlight WASM is not installed or could not be found in the simulator.',
        backendSource,
      };
    }
    if (health.state === 'disabled') {
      return {
        ok: false,
        code: 'mobiflight_module_disabled',
        error: 'MobiFlight WASM is disabled. Enable it in MSFS 2024 My Library, then restart the simulator.',
        backendSource,
      };
    }
    return {
      ok: false,
      code: 'mobiflight_unavailable',
      error: health.error || `MobiFlight WASM is not ready (${health.state || 'unknown'}).`,
      backendSource,
    };
  }

  _mapMobiFlightAckFailure(ack, backendSource) {
    const rawError = ack && typeof ack.error === 'string' ? ack.error.trim() : '';
    if (
      ack?.code === 'stale_profile'
      || ack?.code === 'aircraft_integration_precondition_failed'
      || ack?.code === 'aircraft_integration_selector_drift'
      || ack?.code === 'aircraft_integration_selector_readback_timeout'
      || ack?.code === 'aircraft_integration_selector_mode_unsupported'
      || ack?.code === 'untrusted_aircraft_integration_route'
    ) {
      return {
        ok: false,
        code: ack.code,
        error: rawError || 'The trusted aircraft calculator route could not be completed safely.',
        backendSource,
      };
    }
    const normalizedError = rawError.toLowerCase();
    if (normalizedError.includes('disabled')) {
      return this._buildMobiFlightUnavailableResult({ state: 'disabled' }, backendSource);
    }
    if (normalizedError.includes('missing') || normalizedError.includes('not_found') || normalizedError.includes('not found')) {
      return this._buildMobiFlightUnavailableResult({ state: 'missing' }, backendSource);
    }
    return {
      ok: false,
      code: 'mobiflight_execution_failed',
      error: rawError || 'MobiFlight WASM did not accept the aircraft control preset.',
      backendSource,
    };
  }

  _getAircraftIntegrationTransportCapabilities(bridge) {
    const sdkSnapshot = this._sdkBridge?.getSnapshot?.() || null;
    return {
      'mobiflight-calculator': this._getMobiFlightHealth(bridge).connected,
      lvar: typeof bridge?.setNamedVar === 'function',
      sdk: this._sdkBridge?.isDataConnected?.() === true
        && sdkSnapshot?.adapterId === 'clientdata-manifest'
        && (typeof bridge?.sendSdkEvent === 'function' || typeof bridge?.sendEvent === 'function'),
      'simconnect-sequence': typeof bridge?.sendEvent === 'function'
        && typeof bridge?.setNamedVar === 'function',
    };
  }

  _getActiveAircraftControlProfileGeneration() {
    return {
      profileKey: profileLoader.getActiveProfileId?.() || null,
      profileRevision: profileLoader.getActiveProfileRevision?.() ?? null,
    };
  }

  _validateAircraftControlProfileGeneration(options: AnyRecord = {}) {
    const expectedProfileKey = typeof options.profileKey === 'string'
      ? options.profileKey
      : '';
    const expectedProfileRevision = options.profileRevision;
    if (
      !expectedProfileKey
      || !Number.isSafeInteger(expectedProfileRevision)
      || expectedProfileRevision < 0
    ) {
      return {
        ok: false,
        code: 'profile_token_required',
        error: 'Aircraft control writes require the current aircraft profile token.',
      };
    }

    const activeGeneration = this._getActiveAircraftControlProfileGeneration();
    if (
      activeGeneration.profileKey !== expectedProfileKey
      || activeGeneration.profileRevision !== expectedProfileRevision
    ) {
      return {
        ok: false,
        code: 'stale_profile',
        error: 'Aircraft profile changed before this control request could be executed.',
      };
    }
    return null;
  }

  _getActiveAircraftIntegrationConfig(profileKey, adapterId, profileRevision) {
    const aircraftSpecificConfig = profileLoader.getAircraftSpecificConfig?.();
    if (
      !aircraftSpecificConfig
      || aircraftSpecificConfig.profileKey !== profileKey
      || aircraftSpecificConfig.integrationId !== adapterId
      || !Number.isSafeInteger(profileRevision)
      || aircraftSpecificConfig.profileRevision !== profileRevision
    ) {
      return null;
    }
    return aircraftSpecificConfig;
  }

  _getAircraftIntegrationFieldConfig(profileKey, adapterId, fieldId, profileRevision) {
    const aircraftSpecificConfig = this._getActiveAircraftIntegrationConfig(
      profileKey,
      adapterId,
      profileRevision,
    );
    if (!aircraftSpecificConfig || !Array.isArray(aircraftSpecificConfig.confirmationFields)) {
      return null;
    }
    return aircraftSpecificConfig.confirmationFields.find((field) => field?.id === fieldId) || null;
  }

  _captureAircraftIntegrationDerivedLightReadback(bridge, field, context: AnyRecord = {}) {
    const simvarName = typeof field?.source?.name === 'string' ? field.source.name : '';
    const lightKey = AIRCRAFT_INTEGRATION_DERIVED_LIGHT_SIMVARS[simvarName];
    if (!lightKey || field?.source?.path !== `lights.${lightKey}`) return null;

    const decodeObserved = (rawMask) => {
      if (typeof rawMask !== 'number' || !Number.isFinite(rawMask) || rawMask < 0) return null;
      const rawValue = decodeLights(Math.trunc(rawMask))[lightKey];
      const decodedValue = decodeAircraftSpecificValue(rawValue, field?.decode);
      return decodedValue === undefined ? null : decodedValue;
    };
    const captureAge = (updatedAt) => {
      const updatedAtMs = typeof updatedAt === 'string' && updatedAt
        ? Date.parse(updatedAt)
        : Number.NaN;
      return {
        ageMs: Date.now() - updatedAtMs,
        updatedAtMs,
      };
    };

    // The LVAR sidecar always carries an independent gauge/calculator read of
    // the standard LIGHT STATES mask. Prefer it because complex aircraft can
    // publish a correct gauge value while their native SimConnect definition
    // remains zero. This is also the mask used by the broadcast light overlay.
    const lvarSnapshot = bridge?.getSnapshot?.() || {};
    const gaugeMask = lvarSnapshot.values && typeof lvarSnapshot.values === 'object'
      ? lvarSnapshot.values.standard_light_states
      : undefined;
    const gaugeObserved = decodeObserved(gaugeMask);
    if (gaugeObserved != null) {
      const sequence = Number.isSafeInteger(lvarSnapshot.snapshotSequence)
        && lvarSnapshot.snapshotSequence > 0
        ? Number(lvarSnapshot.snapshotSequence)
        : null;
      const { ageMs, updatedAtMs } = captureAge(lvarSnapshot.updatedAt);
      const fresh = lvarSnapshot.profileId === context.profileKey
        && sequence != null
        && Number.isFinite(updatedAtMs)
        && ageMs >= -5000
        && ageMs <= AIRCRAFT_INTEGRATION_READBACK_FRESH_MS;
      return {
        observed: gaugeObserved,
        sequence,
        updatedAtMs,
        fresh,
        sourceId: 'lvar:standard_light_states',
      };
    }

    // The primary Rust subscription intentionally carries the combined mask,
    // not eight duplicate individual LIGHT * SimVars. Decode that mask when
    // the independent gauge path has not produced a usable value.
    const nativeObserved = decodeObserved(this._data?.lightStates);
    const rustSnapshot = this._rustSimvarBridge?.getSnapshot?.() || {};
    const sequence = Number.isSafeInteger(this._rustSimvarSnapshotSequence)
      && this._rustSimvarSnapshotSequence > 0
      ? this._rustSimvarSnapshotSequence
      : null;
    const { ageMs, updatedAtMs } = captureAge(rustSnapshot.updatedAt);
    const fresh = (rustSnapshot.status === 'running' || rustSnapshot.status === 'connected')
      && sequence != null
      && Number.isFinite(updatedAtMs)
      && ageMs >= -5000
      && ageMs <= AIRCRAFT_INTEGRATION_READBACK_FRESH_MS;
    return {
      observed: nativeObserved,
      sequence,
      updatedAtMs,
      fresh,
      sourceId: 'simvar:lightStates',
    };
  }

  _captureAircraftIntegrationReadback(bridge, readback, context: AnyRecord = {}) {
    const field = this._getAircraftIntegrationFieldConfig(
      context.profileKey,
      context.adapterId,
      readback?.fieldId,
      context.profileRevision,
    );
    if (field?.source?.type === 'sdk') {
      const snapshot = this._sdkBridge?.getSnapshot?.() || {};
      const rawValue = readOwnSdkPath(snapshot.normalized, field.source.path);
      const decodedValue = decodeAircraftSpecificValue(rawValue, field?.decode);
      const observed = decodedValue === undefined ? null : decodedValue;
      const sequence = Number.isSafeInteger(snapshot.snapshotSequence) && snapshot.snapshotSequence >= 0
        ? Number(snapshot.snapshotSequence)
        : null;
      const updatedAtMs = typeof snapshot.updatedAt === 'string' && snapshot.updatedAt
        ? Date.parse(snapshot.updatedAt)
        : Number.NaN;
      const adapterMatches = !field.source.adapterId || snapshot.adapterId === field.source.adapterId;
      // ClientData SDK sources are event-driven state snapshots. With ON_SET + CHANGED,
      // silence means the published state has not changed; it does not make the
      // last value stale. SdkBridge clears the values/sequence and leaves the
      // running state whenever the process, target, or SimConnect connection
      // changes, so status + adapter + sequence form the generation boundary.
      const fresh = adapterMatches
        && snapshot.status === 'running'
        && sequence != null
        && sequence > 0;
      return { observed, sequence, updatedAtMs, fresh, sourceId: `sdk:${field.source.path}` };
    }

    if (field?.source?.type === 'simvar') {
      const derivedLightReadback = this._captureAircraftIntegrationDerivedLightReadback(
        bridge,
        field,
        context,
      );
      if (derivedLightReadback) return derivedLightReadback;

      const simvarName = typeof field.source.name === 'string' ? field.source.name : '';
      const definition = SIMCONNECT_VARS.find((candidate) => candidate.simvar === simvarName);
      const rawValue = definition ? this._data?.[definition.name] : undefined;
      const decodedValue = decodeAircraftSpecificValue(rawValue, field?.decode);
      const observed = decodedValue === undefined ? null : decodedValue;
      const snapshot = this._rustSimvarBridge?.getSnapshot?.() || {};
      const updatedAtMs = typeof snapshot.updatedAt === 'string' && snapshot.updatedAt
        ? Date.parse(snapshot.updatedAt)
        : Number.NaN;
      const ageMs = Date.now() - updatedAtMs;
      const sequence = Number.isSafeInteger(this._rustSimvarSnapshotSequence)
        && this._rustSimvarSnapshotSequence > 0
        ? this._rustSimvarSnapshotSequence
        : null;
      const fresh = (snapshot.status === 'running' || snapshot.status === 'connected')
        && sequence != null
        && Number.isFinite(updatedAtMs)
        && ageMs >= -5000
        && ageMs <= AIRCRAFT_INTEGRATION_READBACK_FRESH_MS;
      return {
        observed,
        sequence,
        updatedAtMs,
        fresh,
        sourceId: definition ? `simvar:${definition.name}` : 'simvar:unavailable',
      };
    }

    const snapshot = bridge?.getSnapshot?.() || {};
    const values = snapshot.values;
    const runtimeKey = field?.source?.type === 'lvar' && typeof field.source.key === 'string'
      ? field.source.key
      : null;
    const rawValue = runtimeKey && values && typeof values === 'object'
      ? values[runtimeKey]
      : undefined;
    const decodedValue = decodeAircraftSpecificValue(rawValue, field?.decode);
    const observed = decodedValue === undefined ? null : decodedValue;
    const sequence = Number.isSafeInteger(snapshot.snapshotSequence) && snapshot.snapshotSequence >= 0
      ? Number(snapshot.snapshotSequence)
      : null;
    const updatedAtMs = typeof snapshot.updatedAt === 'string' && snapshot.updatedAt
      ? Date.parse(snapshot.updatedAt)
      : Number.NaN;
    const ageMs = Date.now() - updatedAtMs;
    const profileMatches = snapshot.profileId === context.profileKey;
    const fresh = profileMatches
      && sequence != null
      && sequence > 0
      && Number.isFinite(updatedAtMs)
      && ageMs >= -5000
      && ageMs <= AIRCRAFT_INTEGRATION_READBACK_FRESH_MS;
    return {
      observed,
      sequence,
      updatedAtMs,
      fresh,
      sourceId: runtimeKey ? `lvar:${runtimeKey}` : 'lvar:unavailable',
    };
  }

  async _waitForAircraftIntegrationReadback(bridge, readback, context, baseline) {
    const timeoutMs = Number.isFinite(readback?.timeoutMs)
      ? Math.max(0, Number(readback.timeoutMs))
      : 1500;
    const expected = readback?.expectedValue;
    const deadline = Date.now() + timeoutMs;
    let sample = this._captureAircraftIntegrationReadback(bridge, readback, context);
    const sameSource = () => typeof baseline?.sourceId !== 'string'
      || sample.sourceId === baseline.sourceId;
    const isConfirmed = () => sample.fresh
      && sameSource()
      && sample.sequence != null
      && baseline?.sequence != null
      && sample.sequence > baseline.sequence
      && (readback?.confirmation === 'changed'
        ? !Object.is(sample.observed, baseline.observed)
        : Object.is(sample.observed, expected));
    while (!isConfirmed() && Date.now() < deadline) {
      const remainingMs = Math.max(1, deadline - Date.now());
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(AIRCRAFT_INTEGRATION_READBACK_POLL_MS, remainingMs),
      ));
      sample = this._captureAircraftIntegrationReadback(bridge, readback, context);
    }
    return {
      confirmed: isConfirmed(),
      observed: sample.observed,
      sequence: sample.sequence,
      fresh: sample.fresh,
      sourceId: sample.sourceId,
      sequenceAdvanced: (
        sameSource()
        && sample.sequence != null
        && baseline?.sequence != null
        && sample.sequence > baseline.sequence
      ),
    };
  }

  async _executeAircraftIntegrationSimConnectSequence(
    bridge,
    operations: readonly AnyRecord[],
    generationContext: AnyRecord = {},
  ) {
    const totalDelayMs = operations.reduce(
      (total, operation) => total + (operation?.type === 'delay' ? Number(operation.milliseconds) : 0),
      0,
    );
    if (
      operations.length === 0
      || operations.length > 8
      || !Number.isFinite(totalDelayMs)
      || totalDelayMs < 0
      || totalDelayMs > MAX_AIRCRAFT_INTEGRATION_SEQUENCE_DELAY_MS
      || typeof bridge?.sendEvent !== 'function'
      || typeof bridge?.setNamedVar !== 'function'
    ) {
      return {
        ok: false,
        error: 'The trusted SimConnect control sequence is unavailable or malformed.',
      };
    }

    const hasGenerationContext = typeof generationContext.profileKey === 'string'
      && generationContext.profileKey
      && typeof generationContext.adapterId === 'string'
      && generationContext.adapterId
      && Number.isSafeInteger(generationContext.profileRevision);
    const generationIsActive = () => !hasGenerationContext || (
      !this._stopping
      && Boolean(this._getActiveAircraftIntegrationConfig(
        generationContext.profileKey,
        generationContext.adapterId,
        generationContext.profileRevision,
      ))
    );
    let executionStarted = false;
    const withExecutionState = (result: AnyRecord) => (
      executionStarted ? withAircraftControlExecutionStarted(result) : result
    );

    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      if (!generationIsActive()) {
        return withExecutionState({
          ok: false,
          error: 'The aircraft profile changed before the coordinated control sequence completed.',
        });
      }
      let ack;
      if (operation?.type === 'event') {
        const eventName = typeof operation.name === 'string' ? operation.name.trim() : '';
        const eventValue = Number(operation.value);
        const eventParameters = Array.isArray(operation.parameters)
          ? operation.parameters.map((parameter) => Number(parameter))
          : [];
        if (
          !this._isSafeControlToken(eventName, MAX_CONTROL_ACTION_NAME_LENGTH, CONTROL_ACTION_NAME_RE)
          || !Number.isFinite(eventValue)
          || Math.abs(eventValue) > MAX_KEY_EVENT_VALUE_ABS
          || eventParameters.length > 4
          || eventParameters.some((parameter) => (
            !Number.isFinite(parameter) || Math.abs(parameter) > MAX_KEY_EVENT_VALUE_ABS
          ))
        ) {
          return withExecutionState({ ok: false, error: 'A trusted SimConnect event operation failed validation.' });
        }
        ack = await bridge.sendEvent(eventName, eventValue, eventParameters);
        executionStarted = true;
      } else if (operation?.type === 'lvar') {
        const varName = typeof operation.name === 'string' ? operation.name.trim() : '';
        const unit = typeof operation.unit === 'string' ? operation.unit.trim() : '';
        const numericValue = typeof operation.value === 'boolean'
          ? (operation.value ? 1 : 0)
          : Number(operation.value);
        if (
          !varName.startsWith('L:')
          || !this._isSafeControlToken(varName, MAX_CONTROL_ACTION_NAME_LENGTH, CONTROL_ACTION_NAME_RE)
          || !this._isSafeControlToken(unit, MAX_CONTROL_UNIT_LENGTH, CONTROL_UNIT_RE)
          || !Number.isFinite(numericValue)
          || Math.abs(numericValue) > MAX_CONTROL_NUMERIC_ABS
        ) {
          return withExecutionState({ ok: false, error: 'A trusted LVAR sequence operation failed validation.' });
        }
        ack = await bridge.setNamedVar({
          name: varName,
          unit,
          value: numericValue,
          dataType: /bool/i.test(unit) || typeof operation.value === 'boolean' ? 'bool' : 'float64',
        });
        executionStarted = true;
      } else if (operation?.type === 'simvar') {
        const varName = typeof operation.name === 'string' ? operation.name.trim() : '';
        const unit = typeof operation.unit === 'string' ? operation.unit.trim() : '';
        const numericValue = typeof operation.value === 'boolean'
          ? (operation.value ? 1 : 0)
          : Number(operation.value);
        if (
          !varName
          || /^(?:A|L):/i.test(varName)
          || !this._isSafeControlToken(varName, MAX_CONTROL_ACTION_NAME_LENGTH, CONTROL_ACTION_NAME_RE)
          || !this._isSafeControlToken(unit, MAX_CONTROL_UNIT_LENGTH, CONTROL_UNIT_RE)
          || !Number.isFinite(numericValue)
          || Math.abs(numericValue) > MAX_CONTROL_NUMERIC_ABS
        ) {
          return withExecutionState({ ok: false, error: 'A trusted SimVar sequence operation failed validation.' });
        }
        ack = await bridge.setNamedVar({
          name: varName,
          unit,
          value: numericValue,
          dataType: /bool/i.test(unit) || typeof operation.value === 'boolean' ? 'bool' : 'float64',
        });
        executionStarted = true;
      } else if (operation?.type === 'delay') {
        const milliseconds = Number(operation.milliseconds);
        if (
          !Number.isSafeInteger(milliseconds)
          || milliseconds < 1
          || milliseconds > MAX_AIRCRAFT_INTEGRATION_SEQUENCE_DELAY_MS
        ) {
          return withExecutionState({ ok: false, error: 'A trusted SimConnect sequence delay failed validation.' });
        }
        const deadline = Date.now() + milliseconds;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(
            resolve,
            Math.min(AIRCRAFT_INTEGRATION_SEQUENCE_DELAY_POLL_MS, Math.max(1, deadline - Date.now())),
          ));
          if (!generationIsActive()) {
            return withExecutionState({
              ok: false,
              error: 'The aircraft profile changed before the coordinated control sequence completed.',
            });
          }
        }
        ack = { ok: true };
      } else {
        return withExecutionState({ ok: false, error: 'A trusted SimConnect sequence contains an unknown operation.' });
      }

      if (!ack || ack.ok !== true) {
        return withExecutionState({
          ok: false,
          error: typeof ack?.error === 'string' && ack.error.trim()
            ? ack.error.trim()
            : `SimConnect sequence operation ${index + 1} was not accepted.`,
        });
      }
    }

    return withExecutionState({ ok: true });
  }

  _resolveAircraftIntegrationSimConnectOperations(route: AnyRecord, action: AnyRecord, rawInput: unknown) {
    const inputResult = normalizeAircraftIntegrationActionInput(action, rawInput);
    if (inputResult.ok === false) {
      return { ok: false, error: inputResult.error, operations: [] };
    }

    const operations = Array.isArray(route?.operations) ? route.operations : [];
    const resolvedOperations: AnyRecord[] = [];
    for (const operation of operations) {
      if (
        (operation?.type !== 'event' && operation?.type !== 'lvar')
        || operation?.inputValue?.source !== 'input'
      ) {
        resolvedOperations.push(operation);
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(inputResult, 'value')) {
        return {
          ok: false,
          error: 'The trusted SimConnect input operation is missing its logical value.',
          operations: [],
        };
      }

      let value;
      if (operation.type === 'event' && operation.inputValue.encoding === 'frequency-bcd16') {
        value = encodeFrequencyBcd16Mhz(inputResult.value);
      } else {
        const scale = operation.inputValue.scale === undefined
          ? 1
          : Number(operation.inputValue.scale);
        const offset = operation.inputValue.offset === undefined
          ? 0
          : Number(operation.inputValue.offset);
        value = Number(inputResult.value) * scale + offset;
        if (operation.inputValue.round === 'nearest') value = Math.round(value);
      }
      if (
        typeof value !== 'number'
        || !Number.isFinite(value)
        || Math.abs(value) > MAX_KEY_EVENT_VALUE_ABS
      ) {
        return {
          ok: false,
          error: 'The trusted SimConnect input is outside the numeric payload format.',
          operations: [],
        };
      }
      resolvedOperations.push({
        ...operation,
        value,
        inputValue: undefined,
      });
    }

    return { ok: true, operations: resolvedOperations };
  }

  async _executeAircraftIntegrationMobiFlightRoute(
    bridge,
    route: AnyRecord,
    action: AnyRecord,
    targetValue: unknown,
    baselineReadback: AnyRecord,
    generationContext: AnyRecord = {},
  ) {
    const isCalculatorCode = (value: unknown) => (
      typeof value === 'string' && /^[\x20-\x7e]{1,4096}$/.test(value)
    );
    if (typeof bridge?.executeMobiFlightCode !== 'function') {
      return { ok: false, error: 'The MobiFlight calculator writer is unavailable.' };
    }

    const hasGenerationContext = typeof generationContext.profileKey === 'string'
      && generationContext.profileKey
      && typeof generationContext.adapterId === 'string'
      && generationContext.adapterId
      && Number.isSafeInteger(generationContext.profileRevision);
    const generationIsActive = () => !hasGenerationContext || (
      !this._stopping
      && Boolean(this._getActiveAircraftIntegrationConfig(
        generationContext.profileKey,
        generationContext.adapterId,
        generationContext.profileRevision,
      ))
    );
    const staleProfileResult = () => ({
      ok: false,
      code: 'stale_profile',
      error: 'The aircraft profile changed before the calculator control sequence completed.',
    });
    const capturePrecondition = () => {
      if (!route?.precondition) return { ok: true };
      const sample = this._captureAircraftIntegrationReadback(
        bridge,
        { fieldId: route.precondition.fieldId },
        generationContext,
      );
      if (!sample.fresh || sample.observed == null) {
        return {
          ok: false,
          code: 'aircraft_integration_precondition_failed',
          error: `A fresh ${route.precondition.fieldId} readback is required before this selector can move.`,
        };
      }
      if (!Object.is(sample.observed, route.precondition.expectedValue)) {
        return {
          ok: false,
          code: 'aircraft_integration_precondition_failed',
          error: `The selector requires ${route.precondition.fieldId} to be ${formatAircraftControlReadbackValue(route.precondition.expectedValue)}, but it is ${formatAircraftControlReadbackValue(sample.observed)}.`,
        };
      }
      return { ok: true };
    };

    const mode = route?.mode === undefined ? 'single' : route.mode;
    if (mode === 'single') {
      if (!isCalculatorCode(route?.code) || !generationIsActive()) {
        return !generationIsActive()
          ? staleProfileResult()
          : { ok: false, code: 'untrusted_aircraft_integration_route', error: 'The calculator command is malformed.' };
      }
      const ack = await bridge.executeMobiFlightCode(route.code);
      return withAircraftControlExecutionStarted(ack);
    }

    if (mode === 'pulse') {
      if (
        !isCalculatorCode(route?.pressCode)
        || !isCalculatorCode(route?.releaseCode)
        || !Number.isSafeInteger(route?.delayMs)
        || route.delayMs < 1
        || route.delayMs > MAX_AIRCRAFT_INTEGRATION_CALCULATOR_PULSE_DELAY_MS
      ) {
        return {
          ok: false,
          code: 'untrusted_aircraft_integration_route',
          error: 'The calculator pulse is malformed.',
        };
      }
      if (!generationIsActive()) return staleProfileResult();
      const pressAck = await bridge.executeMobiFlightCode(route.pressCode);
      if (!pressAck || pressAck.ok !== true) {
        return withAircraftControlExecutionStarted(pressAck);
      }

      // Once the press was accepted, always make one best-effort release on
      // this same bridge. A profile change must prevent new dispatches, but it
      // must not strand an aircraft-shipped momentary counter in its pressed
      // (odd) state.
      let generationChangedAfterPress = false;
      const deadline = Date.now() + route.delayMs;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(
          resolve,
          Math.min(
            AIRCRAFT_INTEGRATION_CALCULATOR_DELAY_POLL_MS,
            Math.max(1, deadline - Date.now()),
          ),
        ));
        if (!generationIsActive()) generationChangedAfterPress = true;
      }
      if (!generationIsActive()) generationChangedAfterPress = true;
      const releaseAck = await bridge.executeMobiFlightCode(route.releaseCode);
      if (!releaseAck || releaseAck.ok !== true) {
        return withAircraftControlExecutionStarted(releaseAck);
      }
      if (generationChangedAfterPress || !generationIsActive()) {
        return withAircraftControlExecutionStarted(staleProfileResult());
      }
      return withAircraftControlExecutionStarted(releaseAck);
    }

    if (mode !== 'step-to-target') {
      return {
        ok: false,
        code: 'untrusted_aircraft_integration_route',
        error: 'The calculator route mode is not trusted.',
      };
    }
    const input = action?.input;
    const baselineValue = Number(baselineReadback?.observed);
    const target = Number(targetValue);
    const maxSteps = Number(route?.maxSteps);
    if (
      !input
      || input.type !== 'number'
      || !isCalculatorCode(route?.decreaseCode)
      || !isCalculatorCode(route?.increaseCode)
      || !Number.isSafeInteger(maxSteps)
      || maxSteps < 1
      || maxSteps > MAX_AIRCRAFT_INTEGRATION_CALCULATOR_TARGET_STEPS
      || !Number.isFinite(baselineValue)
      || !Number.isFinite(target)
      || baselineValue < input.min
      || baselineValue > input.max
    ) {
      return {
        ok: false,
        code: 'aircraft_integration_selector_mode_unsupported',
        error: 'The fresh selector readback is outside the trusted target domain.',
      };
    }

    const baselinePosition = (baselineValue - input.min) / input.step;
    const targetPosition = (target - input.min) / input.step;
    if (
      Math.abs(baselinePosition - Math.round(baselinePosition)) > 1e-7
      || Math.abs(targetPosition - Math.round(targetPosition)) > 1e-7
    ) {
      return {
        ok: false,
        code: 'aircraft_integration_selector_mode_unsupported',
        error: 'The fresh selector readback does not align with the trusted target increments.',
      };
    }

    const positionCount = route.circular === true
      ? Math.round((input.max - input.min) / input.step) + 1
      : null;
    const requestedPosition = Math.round(targetPosition);
    const resolveMovement = (observedValue: unknown) => {
      const numericValue = Number(observedValue);
      const position = (numericValue - input.min) / input.step;
      if (
        !Number.isFinite(numericValue)
        || numericValue < input.min
        || numericValue > input.max
        || Math.abs(position - Math.round(position)) > 1e-7
      ) {
        return null;
      }

      const currentPosition = Math.round(position);
      if (positionCount != null) {
        const increaseSteps = (
          requestedPosition - currentPosition + positionCount
        ) % positionCount;
        const decreaseSteps = (
          currentPosition - requestedPosition + positionCount
        ) % positionCount;
        const increasing = increaseSteps <= decreaseSteps;
        const remainingSteps = increasing ? increaseSteps : decreaseSteps;
        const nextPosition = increasing
          ? (currentPosition + 1) % positionCount
          : (currentPosition - 1 + positionCount) % positionCount;
        return {
          code: increasing ? route.increaseCode : route.decreaseCode,
          expectedValue: input.min + (nextPosition * input.step),
          remainingSteps,
        };
      }

      const signedSteps = requestedPosition - currentPosition;
      return {
        code: signedSteps >= 0 ? route.increaseCode : route.decreaseCode,
        expectedValue: input.min + (
          (currentPosition + (signedSteps >= 0 ? 1 : -1)) * input.step
        ),
        remainingSteps: Math.abs(signedSteps),
      };
    };

    const initialMovement = resolveMovement(baselineValue);
    if (!initialMovement) {
      return {
        ok: false,
        code: 'aircraft_integration_selector_mode_unsupported',
        error: 'The fresh selector readback is outside the trusted target domain.',
      };
    }
    if (
      initialMovement.remainingSteps > maxSteps
      || initialMovement.remainingSteps > MAX_AIRCRAFT_INTEGRATION_CALCULATOR_TARGET_STEPS
    ) {
      return {
        ok: false,
        code: 'aircraft_integration_selector_mode_unsupported',
        error: `The requested selector movement requires ${initialMovement.remainingSteps} steps, above the trusted ${maxSteps}-step limit.`,
      };
    }

    // MobiFlight's command acknowledgement confirms only that SimConnect
    // accepted the ClientData write. It does not prove that the aircraft
    // consumed one rotary detent. Pace every relative command against the
    // authoritative selector readback so an absolute target can never become
    // an unchecked burst of relative movement.
    let currentReadback = baselineReadback;
    let dispatchedSteps = 0;
    const withDispatchedState = (result: AnyRecord) => (
      dispatchedSteps > 0 ? withAircraftControlExecutionStarted(result) : result
    );
    const targetDeadline = Date.now() + MAX_AIRCRAFT_INTEGRATION_CALCULATOR_TARGET_DURATION_MS;
    while (true) {
      const movement = resolveMovement(currentReadback?.observed);
      if (!movement) {
        return withDispatchedState({
          ok: false,
          code: 'aircraft_integration_selector_drift',
          error: 'The selector left its trusted target domain; no further rotary steps were sent.',
        });
      }
      if (movement.remainingSteps === 0) return withDispatchedState({ ok: true });
      if (
        dispatchedSteps >= maxSteps
        || dispatchedSteps >= MAX_AIRCRAFT_INTEGRATION_CALCULATOR_TARGET_STEPS
      ) {
        return withDispatchedState({
          ok: false,
          code: 'aircraft_integration_selector_mode_unsupported',
          error: `The selector did not reach its target within the trusted ${maxSteps}-step limit.`,
        });
      }
      if (Date.now() >= targetDeadline) {
        return withDispatchedState({
          ok: false,
          code: 'aircraft_integration_selector_readback_timeout',
          error: 'The selector did not reach its target within the trusted sequence duration; no further steps were sent.',
        });
      }
      if (!generationIsActive()) return withDispatchedState(staleProfileResult());
      const precondition = capturePrecondition();
      if (!precondition.ok) return withDispatchedState(precondition);
      const ack = await bridge.executeMobiFlightCode(movement.code);
      dispatchedSteps += 1;
      if (!ack || ack.ok !== true) return withDispatchedState(ack || { ok: false });
      if (!generationIsActive()) return withDispatchedState(staleProfileResult());

      const remainingDurationMs = targetDeadline - Date.now();
      if (remainingDurationMs <= 0) {
        return withDispatchedState({
          ok: false,
          code: 'aircraft_integration_selector_readback_timeout',
          error: 'The selector did not reach its target within the trusted sequence duration; no further steps were sent.',
        });
      }
      const perStepTimeoutMs = Number.isFinite(route.readback?.timeoutMs)
        ? Math.max(0, Number(route.readback.timeoutMs))
        : 1500;

      const progress = await this._waitForAircraftIntegrationReadback(
        bridge,
        {
          ...route.readback,
          confirmation: 'changed',
          timeoutMs: Math.min(perStepTimeoutMs, remainingDurationMs),
        },
        generationContext,
        currentReadback,
      );
      if (!generationIsActive()) return withDispatchedState(staleProfileResult());
      if (Date.now() >= targetDeadline) {
        return withDispatchedState({
          ok: false,
          code: 'aircraft_integration_selector_readback_timeout',
          error: 'The selector did not reach its target within the trusted sequence duration; no further steps were sent.',
        });
      }
      if (!progress.confirmed) {
        return withDispatchedState({
          ok: false,
          code: 'aircraft_integration_selector_readback_timeout',
          error: `The aircraft did not confirm rotary progress from ${formatAircraftControlReadbackValue(currentReadback.observed)}; no further steps were sent.`,
        });
      }
      if (!Object.is(progress.observed, movement.expectedValue)) {
        return withDispatchedState({
          ok: false,
          code: 'aircraft_integration_selector_drift',
          error: `One rotary step should have moved the selector to ${formatAircraftControlReadbackValue(movement.expectedValue)}, but the aircraft reported ${formatAircraftControlReadbackValue(progress.observed)}; no further steps were sent.`,
        });
      }
      currentReadback = progress;
    }
  }

  async _executeAircraftIntegrationLvar(bridge, route: AnyRecord) {
    const varName = typeof route?.lvar === 'string' ? route.lvar.trim() : '';
    const unit = typeof route?.unit === 'string' ? route.unit.trim() : '';
    const numericValue = typeof route?.value === 'boolean'
      ? (route.value ? 1 : 0)
      : Number(route?.value);
    if (
      typeof bridge?.setNamedVar !== 'function'
      || !varName.startsWith('L:')
      || !this._isSafeControlToken(varName, MAX_CONTROL_ACTION_NAME_LENGTH, CONTROL_ACTION_NAME_RE)
      || !this._isSafeControlToken(unit, MAX_CONTROL_UNIT_LENGTH, CONTROL_UNIT_RE)
      || !Number.isFinite(numericValue)
      || Math.abs(numericValue) > MAX_CONTROL_NUMERIC_ABS
    ) {
      return {
        ok: false,
        error: 'The trusted direct LVAR control is unavailable or malformed.',
      };
    }

    const ack = await bridge.setNamedVar({
      name: varName,
      unit,
      value: numericValue,
      // Microsoft documents SimConnect LVAR values as FLOAT64, including
      // logical/detent values represented numerically.
      dataType: 'float64',
    });
    return withAircraftControlExecutionStarted(ack);
  }

  _resolveAircraftIntegrationSdkValues(route: AnyRecord, action: AnyRecord, rawInput: unknown) {
    const inputResult = normalizeAircraftIntegrationActionInput(action, rawInput);
    if (inputResult.ok === false) {
      return { ok: false, error: inputResult.error, values: [] };
    }

    let values: unknown[];
    if (route?.inputValue?.source === 'input') {
      if (!Object.prototype.hasOwnProperty.call(inputResult, 'value')) {
        return { ok: false, error: 'The trusted SDK input route is missing its logical value.', values: [] };
      }
      const scale = route.inputValue.scale === undefined ? 1 : Number(route.inputValue.scale);
      const offset = route.inputValue.offset === undefined ? 0 : Number(route.inputValue.offset);
      let value = Number(inputResult.value) * scale + offset;
      if (route.inputValue.round === 'nearest') value = Math.round(value);
      values = [value];
    } else if (Array.isArray(route?.values)) {
      values = [...route.values];
    } else {
      values = [route?.value];
    }

    const numericValues = values.map((value) => Number(value));
    if (
      numericValues.length === 0
      || numericValues.length > 4
      || numericValues.some((value) => (
        !Number.isSafeInteger(value)
        || value < 0
        || value > MAX_SDK_EVENT_VALUE
      ))
    ) {
      return { ok: false, error: 'The trusted SDK event values are outside the DWORD payload format.', values: [] };
    }
    return {
      ok: true,
      inputValue: inputResult.value,
      values: numericValues,
    };
  }

  async _executeAircraftIntegrationSdkValues(bridge, command: string, values: readonly number[]) {
    const sendSdkEvent = typeof bridge?.sendSdkEvent === 'function'
      ? bridge.sendSdkEvent.bind(bridge)
      : bridge?.sendEvent?.bind(bridge);
    if (typeof sendSdkEvent !== 'function') {
      return { ok: false, error: 'The SDK event writer is unavailable.' };
    }
    const sendIds: number[] = [];
    for (const value of values) {
      const ack = await sendSdkEvent(command, value);
      if (!ack || ack.ok !== true) return withAircraftControlExecutionStarted(ack);
      const sendId = Number(ack.sendId);
      if (Number.isSafeInteger(sendId) && sendId >= 0) {
        sendIds.push(sendId);
      }
    }
    return { ok: true, sendIds, executionStarted: true };
  }

  async _executeAircraftIntegrationAction(bridge, action, backendSource, options: AnyRecord = {}) {
    const profileKey = typeof options.profileKey === 'string' ? options.profileKey : '';
    const adapterId = typeof action?.name === 'string' ? action.name : '';
    const actionId = options.request?.actionId || options.request?.target;
    if (!this._getActiveAircraftIntegrationConfig(profileKey, adapterId, options.profileRevision)) {
      return {
        ok: false,
        code: 'untrusted_aircraft_integration',
        error: 'The requested aircraft integration does not match the active profile generation.',
        backendSource,
      };
    }
    const integration = defaultAircraftIntegrationRegistry.resolveIntegration(adapterId, { profileKey });
    const integrationAction = defaultAircraftIntegrationRegistry.resolveAction({
      adapterId,
      profileKey,
      actionId,
    });
    if (!integration || !integrationAction) {
      return {
        ok: false,
        code: 'untrusted_aircraft_integration',
        error: 'The requested aircraft integration is not trusted for the active profile and logical action.',
        backendSource,
      };
    }

    const transportCapabilities = this._getAircraftIntegrationTransportCapabilities(bridge);
    const supportedTransports = Object.entries(transportCapabilities)
      .filter(([, supported]) => supported === true)
      .map(([transport]) => transport);
    const selection = defaultAircraftIntegrationRegistry.selectActionRoute({
      adapterId,
      profileKey: options.profileKey,
      actionId,
    }, supportedTransports);
    if (!selection) {
      const hasMobiFlightRoute = integrationAction.routes?.some(
        (candidate) => candidate?.transport === 'mobiflight-calculator',
      );
      if (hasMobiFlightRoute) {
        return this._buildMobiFlightUnavailableResult(this._getMobiFlightHealth(bridge), backendSource);
      }
      return {
        ok: false,
        code: 'aircraft_integration_transport_unavailable',
        error: 'No supported write transport is currently available for this aircraft integration action.',
        backendSource,
      };
    }

    const route = defaultAircraftIntegrationRegistry.resolveActionRoute({
      adapterId,
      profileKey,
      actionId,
      routeId: selection.routeId,
    });
    if (!route || route.transport !== selection.transport) {
      return {
        ok: false,
        code: 'untrusted_aircraft_integration_route',
        error: 'The selected aircraft integration route could not be revalidated.',
        backendSource,
      };
    }


    const inputResult = normalizeAircraftIntegrationActionInput(
      integrationAction,
      options.request?.value,
    );
    if (inputResult.ok === false) {
      return {
        ok: false,
        code: 'invalid_value',
        error: inputResult.error,
        backendSource,
      };
    }

    const transportAcknowledged = route.transport === 'simconnect-sequence'
      && route.confirmation === 'transport-acknowledged';
    const routeReadbacks = Array.isArray(route.readbacks)
      ? route.readbacks
      : (route.readback ? [route.readback] : []);
    const resolvedReadbacks = routeReadbacks.map((routeReadback) => {
      if (routeReadback.expectedInput !== true) return routeReadback;
      const { expectedInput: _expectedInput, ...readback } = routeReadback;
      return { ...readback, expectedValue: inputResult.value };
    });
    if (resolvedReadbacks.length === 0 && !transportAcknowledged) {
      return {
        ok: false,
        code: 'untrusted_aircraft_integration_route',
        error: 'The selected aircraft integration route has no confirmation contract.',
        backendSource,
      };
    }
    let resolvedSdkValues: readonly number[] = [];
    let resolvedSequenceOperations: readonly AnyRecord[] = [];

    if (
      route.transport !== 'mobiflight-calculator'
      && route.transport !== 'lvar'
      && route.transport !== 'sdk'
      && route.transport !== 'simconnect-sequence'
    ) {
      return {
        ok: false,
        code: 'aircraft_integration_transport_unimplemented',
        error: `Aircraft integration transport ${route.transport} is not implemented by this provider.`,
        backendSource,
      };
    }

    if (route.transport === 'mobiflight-calculator') {
      const health = this._getMobiFlightHealth(bridge);
      if (!health.connected) {
        return this._buildMobiFlightUnavailableResult(health, backendSource);
      }
      if (typeof bridge.executeMobiFlightCode !== 'function') {
        return {
          ok: false,
          code: 'mobiflight_transport_unavailable',
          error: 'The active SimConnect sidecar does not support MobiFlight WASM commands.',
          backendSource,
        };
      }
    } else if (route.transport === 'lvar') {
      if (typeof bridge.setNamedVar !== 'function') {
        return {
          ok: false,
          code: 'direct_lvar_transport_unavailable',
          error: 'The active SimConnect sidecar cannot execute direct LVAR controls.',
          backendSource,
        };
      }
    } else if (route.transport === 'sdk') {
      const sdkSnapshot = this._sdkBridge?.getSnapshot?.() || null;
      if (
        this._sdkBridge?.isDataConnected?.() !== true
        || sdkSnapshot?.adapterId !== route.adapter
        || (typeof bridge.sendSdkEvent !== 'function' && typeof bridge.sendEvent !== 'function')
      ) {
        return {
          ok: false,
          code: 'sdk_transport_unavailable',
          error: 'The active SDK data and control transports are not both ready.',
          backendSource,
        };
      }
      const sdkValues = this._resolveAircraftIntegrationSdkValues(
        route,
        integrationAction,
        options.request?.value,
      );
      if (!/^#[0-9]{5}$/.test(route.command) || !sdkValues.ok) {
        return {
          ok: false,
          code: 'untrusted_aircraft_integration_route',
          error: 'The selected SDK event route is outside the trusted event payload format.',
          backendSource,
        };
      }
      resolvedSdkValues = sdkValues.values;
    } else {
      if (typeof bridge.sendEvent !== 'function' || typeof bridge.setNamedVar !== 'function') {
        return {
          ok: false,
          code: 'simconnect_sequence_transport_unavailable',
          error: 'The active SimConnect sidecar cannot execute coordinated simulator controls.',
          backendSource,
        };
      }
      const sequenceOperations = this._resolveAircraftIntegrationSimConnectOperations(
        route,
        integrationAction,
        options.request?.value,
      );
      if (!sequenceOperations.ok) {
        return {
          ok: false,
          code: 'untrusted_aircraft_integration_route',
          error: sequenceOperations.error,
          backendSource,
        };
      }
      resolvedSequenceOperations = sequenceOperations.operations;
    }

    const readbackContext = {
      profileKey,
      adapterId,
      profileRevision: options.profileRevision,
    };
    if (route.transport === 'simconnect-sequence' && route.precondition) {
      const precondition = this._captureAircraftIntegrationReadback(
        bridge,
        route.precondition,
        readbackContext,
      );
      if (!precondition.fresh || precondition.observed == null) {
        return {
          ok: false,
          code: 'aircraft_integration_precondition_unavailable',
          error: `A fresh ${route.precondition.fieldId} readback is required before this custom event can be written.`,
          backendSource,
        };
      }
      if (!Object.is(precondition.observed, route.precondition.expectedValue)) {
        return {
          ok: false,
          code: 'aircraft_integration_precondition_failed',
          error: `This custom event requires ${route.precondition.fieldId} to be ${formatAircraftControlReadbackValue(route.precondition.expectedValue)}, but the aircraft reported ${formatAircraftControlReadbackValue(precondition.observed)}.`,
          backendSource,
        };
      }
    }
    const baselineReadbacks = resolvedReadbacks.map((readback) => (
      this._captureAircraftIntegrationReadback(
        bridge,
        readback,
        readbackContext,
      )
    ));
    const baselineReadback = baselineReadbacks[0] || { fresh: true, observed: undefined };
    const unavailableReadbackIndex = baselineReadbacks.findIndex(
      (baseline) => !baseline.fresh || baseline.observed == null,
    );
    if (unavailableReadbackIndex >= 0) {
      const unavailableFieldId = resolvedReadbacks[unavailableReadbackIndex]?.fieldId;
      return {
        ok: false,
        code: 'aircraft_integration_readback_unavailable',
        error: resolvedReadbacks.length > 1 && unavailableFieldId
          ? `A fresh ${unavailableFieldId} readback is required before this control can be written.`
          : 'A fresh aircraft control readback is required before this control can be written.',
        backendSource,
      };
    }

    const guardKey = `${profileKey}:${adapterId}:${integrationAction.guard.groupId}`;
    if (this._aircraftIntegrationActionsInFlight.has(guardKey)) {
      return {
        ok: false,
        code: 'action_in_progress',
        error: 'This aircraft control action is already waiting for simulator confirmation.',
        backendSource,
      };
    }

    const now = Date.now();
    const lastAttemptAt = Number(this._aircraftIntegrationActionLastAttemptAt.get(guardKey) || 0);
    if (lastAttemptAt > 0 && now - lastAttemptAt < integrationAction.guard.cooldownMs) {
      return {
        ok: false,
        code: 'action_cooldown',
        error: 'This aircraft control action was requested too recently. Wait for the current state to settle.',
        backendSource,
      };
    }

    // Fixed-target integration actions are idempotent. If a fresh logical
    // readback already reports the requested state, no native write is
    // necessary. This is especially important for aircraft interfaces that
    // expose a toggle-only SimConnect event: the adapter can safely offer
    // explicit ON/OFF intents because a same-state request never fires the
    // toggle. Keep this behind the group ordering/cooldown guards because an
    // earlier in-flight command may be about to invalidate the cached value.
    // Relative readback routes use `confirmation: changed` and still dispatch.
    // Documentation-backed momentary routes can instead complete on transport
    // acknowledgement without claiming that the aircraft state is known.
    if (
      resolvedReadbacks.length > 0
      && integrationAction.guard.skipIfSatisfied !== false
      && resolvedReadbacks.every((readback, index) => (
        readback.confirmation !== 'changed'
        && Object.prototype.hasOwnProperty.call(readback, 'expectedValue')
        && Object.is(baselineReadbacks[index]?.observed, readback.expectedValue)
      ))
    ) {
      const confirmedValues = Object.fromEntries(resolvedReadbacks.map((readback, index) => [
        readback.fieldId,
        baselineReadbacks[index]?.observed,
      ]));
      return {
        ok: true,
        code: 'executed',
        backendSource,
        integrationId: integration.id,
        actionId: integrationAction.id,
        routeId: route.id,
        transportMode: route.transport === 'lvar'
          ? 'direct-lvar'
          : (route.transport === 'mobiflight-calculator' ? 'mobiflight' : route.transport),
        ...(resolvedReadbacks.length === 1
          ? { confirmedValue: baselineReadback.observed }
          : { confirmedValues }),
        idempotent: true,
        noOp: true,
      };
    }

    this._aircraftIntegrationActionLastAttemptAt.set(guardKey, now);
    this._aircraftIntegrationActionsInFlight.add(guardKey);
    try {
      const dispatchedAtMs = Date.now();
      const ack: AnyRecord = route.transport === 'sdk'
        ? await this._executeAircraftIntegrationSdkValues(
          bridge,
          route.command,
          resolvedSdkValues,
        )
        : route.transport === 'simconnect-sequence'
          ? await this._executeAircraftIntegrationSimConnectSequence(
            bridge,
            resolvedSequenceOperations,
            readbackContext,
          )
          : route.transport === 'lvar'
            ? await this._executeAircraftIntegrationLvar(bridge, route)
            : await this._executeAircraftIntegrationMobiFlightRoute(
              bridge,
              route,
              integrationAction,
              inputResult.value,
              baselineReadback,
              readbackContext,
            );
      const executionState = ack?.executionStarted === true
        ? { executionStarted: true }
        : {};
      if (!ack || ack.ok !== true) {
        if (route.transport === 'mobiflight-calculator') {
          return {
            ...this._mapMobiFlightAckFailure(ack, backendSource),
            ...executionState,
          };
        }
        if (route.transport === 'simconnect-sequence') {
          return {
            ok: false,
            code: 'simconnect_sequence_execution_failed',
            error: typeof ack?.error === 'string' && ack.error.trim()
              ? ack.error.trim()
              : 'The SimConnect sidecar did not complete the coordinated aircraft control sequence.',
            backendSource,
            ...executionState,
          };
        }
        if (route.transport === 'lvar') {
          return {
            ok: false,
            code: 'direct_lvar_execution_failed',
            error: typeof ack?.error === 'string' && ack.error.trim()
              ? ack.error.trim()
              : 'The SimConnect sidecar did not accept the direct LVAR control.',
            backendSource,
            transportMode: 'direct-lvar',
            ...executionState,
          };
        }
        return {
          ok: false,
          code: 'sdk_execution_failed',
          error: typeof ack?.error === 'string' && ack.error.trim()
            ? ack.error.trim()
            : 'The SimConnect sidecar did not accept the SDK event.',
          backendSource,
          ...executionState,
        };
      }

      if (transportAcknowledged) {
        return {
          ok: true,
          code: 'executed',
          backendSource,
          integrationId: integration.id,
          actionId: integrationAction.id,
          routeId: route.id,
          transportMode: route.transport,
          transportAcknowledged: true,
        };
      }

      const confirmations = await Promise.all(resolvedReadbacks.map((readback, index) => (
        this._waitForAircraftIntegrationReadback(
          bridge,
          readback,
          readbackContext,
          baselineReadbacks[index],
        )
      )));
      const failedConfirmationIndex = confirmations.findIndex(
        (candidate) => !candidate.confirmed,
      );
      if (failedConfirmationIndex >= 0) {
        const failedReadback = resolvedReadbacks[failedConfirmationIndex];
        const failedBaseline = baselineReadbacks[failedConfirmationIndex];
        const confirmation = confirmations[failedConfirmationIndex];
        const expectedValue = failedReadback?.confirmation === 'changed'
          ? undefined
          : failedReadback?.expectedValue;
        const sequenceAdvanced = confirmation.sequenceAdvanced === true;
        const simConnectException = (
          route.transport === 'sdk'
          && typeof bridge.findRecentSimConnectException === 'function'
        )
          ? bridge.findRecentSimConnectException(ack.sendIds || [], dispatchedAtMs)
          : null;
        const readbackDetail = failedReadback?.confirmation === 'changed'
          ? (
              sequenceAdvanced
                ? `A newer aircraft state arrived, but ${failedReadback.fieldId} remained ${formatAircraftControlReadbackValue(confirmation.observed)} instead of changing from ${formatAircraftControlReadbackValue(failedBaseline.observed)}.`
                : `The aircraft published no newer control state; ${failedReadback.fieldId} remained ${formatAircraftControlReadbackValue(failedBaseline.observed)}.`
            )
          : (
              sequenceAdvanced
                ? `A newer aircraft state arrived, but ${failedReadback.fieldId} was ${formatAircraftControlReadbackValue(confirmation.observed)} instead of ${formatAircraftControlReadbackValue(expectedValue)}.`
                : `The aircraft published no newer control state; ${failedReadback.fieldId} remained ${formatAircraftControlReadbackValue(failedBaseline.observed)} instead of ${formatAircraftControlReadbackValue(expectedValue)}.`
            );
        const operationalHint = (
          integration.id === PMDG_777_INTEGRATION_ID
          && integrationAction.id.startsWith('controls.parkingBrake.')
        )
          ? ' PMDG Realistic parking-brake mode can require both toe brakes to be held before the lever accepts SET; releasing may be controlled by pedal input.'
          : '';
        return {
          ok: false,
          code: simConnectException
            ? 'aircraft_integration_simconnect_exception'
            : 'aircraft_integration_readback_timeout',
          error: simConnectException
            ? `SimConnect rejected command ${route.command} after its initial acknowledgement (exception ${formatAircraftControlReadbackValue(simConnectException.exception)}, packet ${simConnectException.sendId}). ${readbackDetail}${operationalHint}`
            : `The transport accepted the command, but readback did not confirm it within ${failedReadback.timeoutMs} ms. ${readbackDetail}${operationalHint}`,
          backendSource,
          integrationId: integration.id,
          actionId: integrationAction.id,
          routeId: route.id,
          transportMode: route.transport === 'lvar'
            ? 'direct-lvar'
            : (route.transport === 'mobiflight-calculator' ? 'mobiflight' : route.transport),
          expectedValue,
          baselineValue: failedBaseline.observed,
          observedValue: confirmation.observed,
          readbackAdvanced: sequenceAdvanced,
          sdkCommand: route.transport === 'sdk' ? route.command : undefined,
          sdkPayloads: route.transport === 'sdk' ? resolvedSdkValues : undefined,
          simConnectException: simConnectException || undefined,
          ...executionState,
        };
      }

      const confirmedValues = Object.fromEntries(resolvedReadbacks.map((readback, index) => [
        readback.fieldId,
        confirmations[index]?.observed,
      ]));
      return {
        ok: true,
        code: 'executed',
        backendSource,
        integrationId: integration.id,
        actionId: integrationAction.id,
        routeId: route.id,
        transportMode: route.transport === 'lvar'
          ? 'direct-lvar'
          : (route.transport === 'mobiflight-calculator' ? 'mobiflight' : route.transport),
        ...(resolvedReadbacks.length === 1
          ? { confirmedValue: confirmations[0]?.observed }
          : { confirmedValues }),
      };
    } finally {
      this._aircraftIntegrationActionsInFlight.delete(guardKey);
    }
  }

  _captureGenericControlReadback(bridge, eventName, options) {
    return captureGenericLightReadback({
      eventName,
      profileKey: options.profileKey,
      nativeMask: this._data?.lightStates,
      nativeSnapshot: {
        ...this._rustSimvarBridge?.getSnapshot?.(),
        updatedAt: this._rustLightStatesUpdatedAt,
      },
      nativeSequence: this._rustLightStatesSequence,
      gaugeSnapshot: bridge?.getSnapshot?.() || {},
      notBeforeMs: this._rustControlReadbackNotBeforeMs,
      nowMs: Date.now(),
    });
  }

  _captureNavRadioState() {
    return captureNavRadios(this._rustNavRadioSamples, this._rustSimvarBridge?.getSnapshot?.()?.status);
  }

  async _executeGenericKeyEvent(bridge, eventName, eventValue, eventParameters, backendSource, options) {
    const before = this._captureGenericControlReadback(bridge, eventName, options);
    const dispatchedAtMs = Date.now();
    const diagnostics: AnyRecord = {
      version: 1,
      requestId: options.request?.requestId || null,
      profileKey: options.profileKey,
      profileRevision: options.profileRevision,
      eventName,
      value: eventValue,
      parameters: eventParameters,
      dispatchedAt: new Date(dispatchedAtMs).toISOString(),
      native: null,
      sendIds: [],
      acknowledged: false,
      ...(options.request?.control === 'radios' ? { navRadiosBefore: this._captureNavRadioState() } : {}),
    };
    let ack;
    let failure: AnyRecord | null = null;
    try {
      ack = await bridge.sendEvent(eventName, eventValue, eventParameters);
      diagnostics.native = ack?.transport || null;
      diagnostics.sendIds = [...new Set([...(Array.isArray(ack?.sendIds) ? ack.sendIds : []), ack?.sendId]
        .filter((id) => Number.isSafeInteger(id) && id >= 0))];
      diagnostics.acknowledged = ack?.ok === true;
      if (ack?.ok !== true) {
        failure = this._buildSidecarResult(ack, backendSource, `Failed to send key event ${eventName}.`);
      } else {
        // Observe for a fixed, bounded window even when a light already matches.
        // A native acknowledgement or matching output is not cockpit confirmation.
        // Never retry the command or dispatch a different route from this loop.
        const deadline = Date.now() + GENERIC_CONTROL_OBSERVATION_MS;
        while (true) {
          const exception = bridge.findRecentSimConnectException?.(diagnostics.sendIds, dispatchedAtMs);
          if (exception) {
            diagnostics.exception = exception;
            failure = {
              ok: false, code: 'simconnect_exception',
              error: `SimConnect rejected ${eventName} after dispatch (exception ${exception.exception}, packet ${exception.sendId}).`,
            };
            break;
          }
          failure = this._validateAircraftControlProfileGeneration(options);
          if (failure) {
            failure.error = 'Aircraft profile changed after dispatch; aircraft state is unconfirmed.';
            break;
          }
          if (this._stopping || ['stopped', 'disconnected', 'error'].includes(bridge.getSnapshot?.().status)) {
            failure = { ok: false, code: 'observation_interrupted', error: 'The simulator connection ended after dispatch; aircraft state is unconfirmed.' };
            break;
          }
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) break;
          await new Promise((resolve) => setTimeout(resolve, Math.min(50, remainingMs)));
        }
      }
    } catch (error) {
      failure = { ok: false, code: 'action_failed', error: error?.message || 'The sidecar command failed.' };
    }
    diagnostics.readback = describeGenericLightReadback(before,
      this._captureGenericControlReadback(bridge, eventName, options), eventValue, dispatchedAtMs);
    diagnostics.elapsedMs = Date.now() - dispatchedAtMs;
    if (options.request?.control === 'radios') diagnostics.navRadiosAfter = this._captureNavRadioState();
    diagnostics.outcome = failure?.code || 'sent_unconfirmed';
    if (failure) diagnostics.error = failure.error;
    // One bounded record per command is available in backend logs even when
    // optional debug broadcasting is disabled in the packaged application.
    console.info(`[AircraftControl] ${JSON.stringify(diagnostics)}`);
    Debug.log('aircraft-control', 'generic_command_diagnostics', diagnostics);
    return {
      ...(failure || { ok: true, code: 'sent_unconfirmed' }),
      backendSource,
      executionStarted: true,
      diagnostics,
    };
  }

  async _executeKeyEventAction(bridge, action, backendSource, options: AnyRecord = {}) {
    const eventName = typeof action.name === 'string' ? action.name.trim() : '';
    if (!eventName) {
      return { ok: false, code: 'invalid_action', error: 'Key-event action is missing a name.', backendSource };
    }
    if (!this._isSafeControlToken(eventName, MAX_CONTROL_ACTION_NAME_LENGTH, CONTROL_ACTION_NAME_RE)) {
      return { ok: false, code: 'invalid_action', error: 'Key-event action name is outside the safe control payload format.', backendSource };
    }

    const rawParameters = Array.isArray(action.parameters) ? action.parameters : [];
    const hasExplicitValue = Object.prototype.hasOwnProperty.call(action, 'value');
    const eventValue = this._normalizeActionNumber(
      hasExplicitValue ? action.value : (rawParameters[0] ?? 0),
    );
    if (eventValue == null) {
      return { ok: false, code: 'invalid_value', error: 'Key-event action value is outside the safe control payload format.', backendSource };
    }
    if (eventValue != null && Math.abs(eventValue) > MAX_KEY_EVENT_VALUE_ABS) {
      return { ok: false, code: 'invalid_value', error: 'Key-event action value is outside the safe control payload range.', backendSource };
    }

    const eventParameters = (hasExplicitValue ? rawParameters : rawParameters.slice(1))
      .map((parameter) => this._normalizeActionNumber(parameter));
    if (
      eventParameters.length > 4
      || eventParameters.some((parameter) => parameter == null || Math.abs(parameter) > MAX_KEY_EVENT_VALUE_ABS)
    ) {
      return { ok: false, code: 'invalid_value', error: 'Key-event action parameters are outside the safe control payload format.', backendSource };
    }

    const profileKey = typeof options?.profileKey === 'string' ? options.profileKey.trim() : '';
    if (options.resolvedBy === 'generic') {
      if (options.request?.control === 'radios') {
        const radio = this._captureNavRadioState()[options.request.target];
        if (radio?.installed !== true || radio.standbyMhz == null
          || (options.request.operation === 'swap' && radio.activeMhz == null)) {
          return {
            ok: false, code: 'radio_unavailable', backendSource,
            error: radio?.installed === false ? 'This NAV radio is not installed.' : 'Fresh NAV radio readback is required before tuning or swapping.',
          };
        }
      }
      return this._executeGenericKeyEvent(bridge, eventName, eventValue, eventParameters, backendSource, options);
    }
    const pulseGroup = profileKey === INIBUILDS_TRISTAR_PROFILE_KEY
      ? INIBUILDS_TRISTAR_AFCS_PULSE_GROUPS[eventName]
      : null;
    if (!pulseGroup) {
      const ack = await bridge.sendEvent(eventName, eventValue, eventParameters);
      return this._buildSidecarResult(ack, backendSource, `Failed to send key event ${eventName}.`);
    }

    // iniBuilds documents these AFCS inputs as momentary buttons without a
    // reliable mode-state readback. Keep their short physical-button guard at
    // the provider boundary so rapid websocket/API requests cannot double-fire
    // a toggle. AP A and AP DISC intentionally share the same physical group.
    const guardKey = `${profileKey}:${pulseGroup}`;
    if (this._profileKeyEventsInFlight.has(guardKey)) {
      return {
        ok: false,
        code: 'action_in_flight',
        error: 'The TriStar AFCS control is already being sent.',
        backendSource,
      };
    }
    const now = Date.now();
    const lastAttemptAt = Number(this._profileKeyEventLastAttemptAt.get(guardKey) || 0);
    if (lastAttemptAt > 0 && now - lastAttemptAt < INIBUILDS_TRISTAR_AFCS_PULSE_COOLDOWN_MS) {
      return {
        ok: false,
        code: 'action_cooldown',
        error: 'Wait briefly before sending the TriStar AFCS control again.',
        retryAfterMs: INIBUILDS_TRISTAR_AFCS_PULSE_COOLDOWN_MS - (now - lastAttemptAt),
        backendSource,
      };
    }

    this._profileKeyEventLastAttemptAt.set(guardKey, now);
    this._profileKeyEventsInFlight.add(guardKey);
    try {
      const ack = await bridge.sendEvent(eventName, eventValue, eventParameters);
      return this._buildSidecarResult(ack, backendSource, `Failed to send key event ${eventName}.`);
    } finally {
      this._profileKeyEventsInFlight.delete(guardKey);
    }
  }

  async _executeNamedVarAction(bridge, action, backendSource) {
    const varName = typeof action.name === 'string' ? action.name.trim() : '';
    if (!varName) {
      return { ok: false, code: 'invalid_action', error: 'Variable action is missing a name.', backendSource };
    }
    if (!this._isSafeControlToken(varName, MAX_CONTROL_ACTION_NAME_LENGTH, CONTROL_ACTION_NAME_RE)) {
      return { ok: false, code: 'invalid_action', error: 'Variable action name is outside the safe control payload format.', backendSource };
    }

    const rawValue = this._extractActionScalar(action);
    const numericValue = this._normalizeActionNumber(rawValue);
    if (numericValue == null) {
      return {
        ok: false,
        code: 'invalid_value',
        error: `A numeric value is required to write ${varName}.`,
        backendSource,
      };
    }

    const unit = typeof action.unit === 'string' && action.unit.trim()
      ? action.unit.trim()
      : 'Number';
    if (!this._isSafeControlToken(unit, MAX_CONTROL_UNIT_LENGTH, CONTROL_UNIT_RE)) {
      return { ok: false, code: 'invalid_action', error: 'Variable action unit is outside the safe control payload format.', backendSource };
    }
    const dataType = /bool/i.test(unit) || rawValue === true || rawValue === false
      ? 'bool'
      : 'float64';
    const ack = await bridge.setNamedVar({
      name: varName,
      unit,
      value: numericValue,
      dataType,
    });
    return this._buildSidecarResult(ack, backendSource, `Failed to set variable ${varName}.`);
  }

  async _executeInputEventAction(action, backendSource) {
    const eventName = typeof action.name === 'string' ? action.name.trim() : '';
    if (!eventName) {
      return { ok: false, code: 'invalid_action', error: 'Input-event action is missing a name.', backendSource };
    }

    return {
      ok: false,
      code: 'unsupported_action',
      error: `Input-event actions are not supported by the Rust sidecar runtime yet (${eventName}).`,
      backendSource,
    };
  }

  _reloadLvarSubscriptions(reason = 'unknown') {
    this._lvarConfig = profileLoader.getLvarConfig();
    this._applyLvarSubscriptions(reason);
  }

  _normalizeDebugLvarSubscriptions(rawSubscriptions = []) {
    if (!Array.isArray(rawSubscriptions)) return [];

    const MAX_DEBUG_LVAR_SUBSCRIPTIONS = 48;
    const normalized = [];
    const seenExpressions = new Set();
    const seenKeys = new Set();

    const normalizeExpression = (value) => {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;

      if (trimmed.startsWith('(')) {
        const singleDatum = trimmed.match(/^\(\s*([LA]:[^,\)]+)\s*(?:,\s*[^\)]+)?\)$/i);
        if (!singleDatum) return null;
        return `(${singleDatum[1].trim()})`;
      }

      if (/^[LA]:/i.test(trimmed)) {
        return `(${trimmed})`;
      }

      return `(L:${trimmed})`;
    };

    const buildKey = (expression, index) => {
      const base = String(expression || '')
        .replace(/[()]/g, '')
        .replace(/^[LA]:/i, '')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase()
        .slice(0, 40) || `watch_${index + 1}`;

      let candidate = `debug_${base}`;
      let suffix = 2;
      while (seenKeys.has(candidate)) {
        candidate = `debug_${base}_${suffix++}`;
      }
      seenKeys.add(candidate);
      return candidate;
    };

    for (const item of rawSubscriptions.slice(0, MAX_DEBUG_LVAR_SUBSCRIPTIONS)) {
      const rawExpression = typeof item === 'string'
        ? item
        : (item && typeof item === 'object' ? item.expression : null);
      const expression = normalizeExpression(rawExpression);
      if (!expression || seenExpressions.has(expression)) continue;
      seenExpressions.add(expression);

      normalized.push({
        key: buildKey(expression, normalized.length),
        expression,
        sourcePath: 'debug.watch',
      });
    }

    return normalized;
  }

  _applyLvarSubscriptions(reason = 'unknown') {
    const profileSubscriptions = Array.isArray(this._lvarConfig?.subscriptions)
      ? this._lvarConfig.subscriptions
      : [];
    const debugSubscriptions = Array.isArray(this._debugLvarSubscriptions)
      ? this._debugLvarSubscriptions
      : [];
    const mergedSubscriptions = [
      ...profileSubscriptions,
      ...STANDARD_LIGHT_FALLBACK_SUBSCRIPTIONS,
      ...debugSubscriptions,
    ];

    if (this._lvarBridge) {
      this._lvarBridge.setSubscriptions(mergedSubscriptions, this._lvarConfig.profileId);
    }

    console.log(
      `[LVAR] profile=${this._lvarConfig.profileId || 'generic'} ` +
      `profileSubscriptions=${profileSubscriptions.length} debugSubscriptions=${debugSubscriptions.length} ` +
      `standardFallbackSubscriptions=${STANDARD_LIGHT_FALLBACK_SUBSCRIPTIONS.length} ` +
      `total=${mergedSubscriptions.length} reason=${reason}`
    );

    Debug.log('simconnect-telemetry', 'lvar_subscriptions_reloaded', {
      reason,
      profileId: this._lvarConfig.profileId,
      profileCount: profileSubscriptions.length,
      standardFallbackCount: STANDARD_LIGHT_FALLBACK_SUBSCRIPTIONS.length,
      debugCount: debugSubscriptions.length,
      count: mergedSubscriptions.length,
    });
  }

  setDebugLvarSubscriptions(rawSubscriptions = []) {
    this._debugLvarSubscriptions = this._normalizeDebugLvarSubscriptions(rawSubscriptions);
    this._applyLvarSubscriptions('debug-watch-changed');
    this._broadcastDataSourcesIfLvarStatusChanged();
    return [...this._debugLvarSubscriptions];
  }

  _buildLvarSecondarySource() {
    const bridgeSnapshot = this._lvarBridge?.getSnapshot?.() || null;
    const enabled = this._lvarBridge
      ? this._lvarBridge.isEnabled()
      : (config.lvarSidecar?.enable === true || config.lvarSidecar?.autoEnable === true);
    if (!enabled) return null;

    const status = bridgeSnapshot?.status || 'starting';
    // Count keys that currently have a non-null value. The 'running' status
    // alone isn't proof values are flowing — `subscriptions_updated` only
    // means SimConnect accepted the registrations. We treat the bridge as
    // truly "connected" only when at least one LVAR has produced a value.
    const bridgeValues = bridgeSnapshot?.values && typeof bridgeSnapshot.values === 'object'
      ? bridgeSnapshot.values
      : {};
    const liveValueCount = Object.values(bridgeValues).filter((v) => v != null).length;
    const hasLiveValues = liveValueCount > 0;
    const bridgeConnected = hasLiveValues && (
      status === 'running' || status === 'ready' || status === 'connected' || status === 'subscriptions_updated'
    );
    const connected = this._connected && bridgeConnected;
    const profileSubscriptions = Array.isArray(this._lvarConfig?.subscriptions)
      ? this._lvarConfig.subscriptions
      : [];
    const debugSubscriptions = Array.isArray(this._debugLvarSubscriptions)
      ? this._debugLvarSubscriptions
      : [];
    const profileCount = profileSubscriptions.length;
    const debugCount = debugSubscriptions.length;
    const count = profileCount + debugCount;

    const userStatus = (() => {
      if (!this._connected) return 'Disconnected';
      if (status === 'error') return 'Error';
      if (status === 'disabled' || status === 'stopped' || status === 'disconnected') return 'Disconnected';
      // Only call it Running when we've actually received at least one value.
      if (status === 'running' && hasLiveValues) return 'Running';
      // Subscriptions registered but no values yet → honest "Awaiting values".
      if (status === 'running' || status === 'subscriptions_updated') return 'Awaiting values';
      if (status === 'connecting') return 'Connecting';
      if (status === 'ready' || status === 'connected' || status === 'starting') return 'Connecting';
      return 'Unknown';
    })();

    const detail = (() => {
      const librarySuffix = bridgeSnapshot?.librarySpec ? ` · DLL: ${bridgeSnapshot.librarySpec}` : '';
      if (userStatus === 'Running') return `Profile: ${profileCount}${debugCount ? ` · Debug: ${debugCount}` : ''} · ${liveValueCount} live${librarySuffix}`;
      if (userStatus === 'Awaiting values') return `Profile: ${profileCount}${debugCount ? ` · Debug: ${debugCount}` : ''} · awaiting values${librarySuffix}`;
      if (!this._connected) return 'SimConnect disconnected';
      if (bridgeSnapshot?.error) return String(bridgeSnapshot.error).slice(0, 120);
      if (bridgeSnapshot?.librarySpec) return `DLL: ${bridgeSnapshot.librarySpec}`;
      return null;
    })();

    const buildPreviewItems = (subscriptions, limit = 8) => {
      const items = [];
      const prioritized = [];
      const fallback = [];

      for (const sub of subscriptions) {
        if (!sub || typeof sub.key !== 'string') continue;
        const rawValue = values[sub.key];
        if (rawValue != null) prioritized.push(sub);
        else fallback.push(sub);
      }

      for (const sub of [...prioritized, ...fallback].slice(0, limit)) {
        const rawValue = values[sub.key];
        let value = null;
        if (typeof rawValue === 'number') {
          value = Number.isFinite(rawValue) ? (Math.round(rawValue * 10) / 10) : null;
        } else if (typeof rawValue === 'boolean') {
          value = rawValue ? 1 : 0;
        } else if (typeof rawValue === 'string') {
          value = rawValue.slice(0, 48);
        }

        items.push({
          key: sub.key,
          expression: typeof sub.expression === 'string' ? sub.expression : null,
          value,
          live: rawValue != null,
          sourcePath: sub.sourcePath || null,
        });
      }

      return items;
    };

    const preview = [];
    const values = bridgeSnapshot?.values && typeof bridgeSnapshot.values === 'object'
      ? bridgeSnapshot.values
      : {};
    preview.push(...buildPreviewItems(profileSubscriptions, 8));
    const debugWatchItems = buildPreviewItems(debugSubscriptions, 48);

    const description = detail
      ? `${userStatus} · ${detail}`
      : userStatus;

    return {
      type: 'lvar-sidecar',
      name: 'LVAR Sidecar',
      connected,
      status,
      error: bridgeSnapshot?.error || null,
      librarySpec: bridgeSnapshot?.librarySpec || null,
      description,
      categories: count > 0 ? ['lvars'] : [],
      preview,
      profileSubscriptionCount: profileCount,
      debugWatch: {
        count: debugCount,
        items: debugWatchItems,
      },
    };
  }

  _resolveActiveSdkProfile() {
    const activeProfile = profileLoader.getActiveProfile?.() || null;
    if (
      activeProfile?.integration?.aircraftSpecific?.adapter === PMDG_737_INTEGRATION_ID
      && !getPmdg737SdkEulaAcceptance(userSettings.settings).accepted
    ) {
      return null;
    }
    if (
      activeProfile?.integration?.aircraftSpecific?.adapter === PMDG_777_INTEGRATION_ID
      && !getPmdg777SdkEulaAcceptance(userSettings.settings).accepted
    ) {
      return null;
    }
    return sdkRegistry.resolveProfileSdkConfig(activeProfile?.dataSource);
  }

  _buildSdkSecondarySource() {
    const resolvedSdk = this._resolveActiveSdkProfile();
    if (!resolvedSdk) return null;

    const snap = this._sdkBridge?.getSnapshot?.() || null;
    const status = snap?.status || 'disabled';
    const rawValues = snap?.raw && typeof snap.raw === 'object'
      ? snap.raw
      : (snap?.values && typeof snap.values === 'object' ? snap.values : {});
    const normalizedValues = snap?.normalized && typeof snap.normalized === 'object'
      ? snap.normalized
      : {};
    const hasData = hasMeaningfulSdkValue(rawValues) || hasMeaningfulSdkValue(normalizedValues);
    const connected = this._connected && hasData && (
      status === 'running' || status === 'connected' || status === 'subscribed'
    );
    const targetLabel = resolvedSdk.adapter.describeTarget?.(resolvedSdk.profileSdk.target) || null;
    const liveLabel = targetLabel || resolvedSdk.adapter.displayName;
    const noDataHint = resolvedSdk.adapter.noDataHint || 'No data';

    const userStatus = (() => {
      if (!this._connected) return 'SimConnect disconnected';
      if (status === 'disabled') return 'Disabled';
      if (status === 'connecting')  return 'Connecting…';
      if (status === 'ready' || status === 'subscribed') return 'Subscribed — waiting for data';
      if (status === 'running') return connected ? `Live (${liveLabel})` : noDataHint;
      if (status === 'error') return `Error: ${snap?.error || 'unknown'}`;
      return status;
    })();

    const description = snap?.librarySpec
      ? `${userStatus} · DLL: ${snap.librarySpec}`
      : userStatus;

    return {
      type: sdkRegistry.SDK_SOURCE_TYPE,
      name: targetLabel ? `${resolvedSdk.adapter.displayName} (${targetLabel})` : resolvedSdk.adapter.displayName,
      connected,
      status,
      error: snap?.error || null,
      librarySpec: snap?.librarySpec || null,
      description,
      categories: Array.isArray(snap?.categories) && snap.categories.length > 0
        ? snap.categories
        : resolvedSdk.adapter.categories,
      adapterId: resolvedSdk.adapter.id,
      preview: [],
    };
  }

  getSecondaryDataSources() {
    const sources = [];
    const lvarSource = this._buildLvarSecondarySource();
    if (lvarSource) sources.push(lvarSource);
    const sdkSource = this._buildSdkSecondarySource();
    if (sdkSource) sources.push(sdkSource);
    return sources;
  }

  getPrimaryDataSource() {
    return this._buildRustSimvarSource();
  }

  _buildRustSimvarSource() {
    const snapshot = this._rustSimvarBridge?.getSnapshot?.() || null;
    const status = snapshot?.status || 'starting';
    const values = snapshot?.values && typeof snapshot.values === 'object'
      ? snapshot.values
      : {};
    const liveValueCount = Object.values(values).filter((value) => value != null).length;
    const connected = Boolean(this._connected && liveValueCount > 0 && (status === 'running' || status === 'simvars_updated'));
    const librarySuffix = snapshot?.librarySpec ? ` - DLL: ${snapshot.librarySpec}` : '';
    const description = status === 'running'
      ? `primary - ${liveValueCount} live${librarySuffix}`
      : `primary - ${status}${snapshot?.error ? ` - ${String(snapshot.error).slice(0, 120)}` : librarySuffix}`;

    return {
      type: 'rust-simvars',
      name: 'SimVars',
      connected,
      status,
      error: snapshot?.error || null,
      librarySpec: snapshot?.librarySpec || null,
      description,
      categories: ['simvars'],
      mode: 'primary',
      subscriptionCount: Array.isArray(snapshot?.subscriptions) ? snapshot.subscriptions.length : 0,
      liveValueCount,
    };
  }

  _broadcastDataSourcesIfLvarStatusChanged() {
    if (typeof this._onBroadcast !== 'function') return;

    const primary = this.getPrimaryDataSource();
    const sources = this.getSecondaryDataSources();
    const allSources = [primary, ...sources];
    const signature = `${this._connected}:${this._lvarConfig?.profileId || 'generic'}:${allSources.map((source) => `${source.type}:${source.connected}:${source.description}:${(source.preview || []).map((p) => `${p.key}=${p.value}`).join('|')}`).join('||')}`;

    if (signature === this._lastDataSourceSignature) return;
    this._lastDataSourceSignature = signature;

    try {
      this._onBroadcast({
        type: 'dataSources',
        primary,
        secondary: sources,
        sources: allSources,
      });
    } catch {}
  }

  _refreshRustConnectionFreshness() {
    if (!this._connected || !this._rustSimvarBridge) return;

    const updatedAt = this._rustSimvarUpdatedAt || this._rustSimvarBridge.getSnapshot?.()?.updatedAt || null;
    const updatedAtMs = typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
    if (!Number.isFinite(updatedAtMs)) return;

    const ageMs = Date.now() - updatedAtMs;
    if (ageMs < RUST_SIMVAR_STALE_DISCONNECT_MS) return;

    this._connected = false;
    if (!this._rustSimvarStaleDisconnectLogged) {
      this._rustSimvarStaleDisconnectLogged = true;
      Debug.log('simconnect-telemetry', 'rust_simvars_stale_disconnect', {
        ageMs,
        staleDisconnectMs: RUST_SIMVAR_STALE_DISCONNECT_MS,
        updatedAt,
      });
      console.warn(`[SimConnectTelemetry] Rust SimConnect snapshots stale for ${Math.round(ageMs)}ms; marking simulator disconnected`);
    }
  }

  async nextFrame() {
    this._refreshRustConnectionFreshness();

    const d = this._data;
    const boolOrNull = coerceSimConnectBool;
    
    // One-time log of sim time values for debugging
    if (!this._simTimeLogged && (d.zuluTimeSec != null || d.localTimeSec != null)) {
      this._simTimeLogged = true;
      console.log(`[SimConnectTelemetry] SimTime values: zuluTimeSec=${d.zuluTimeSec}, localTimeSec=${d.localTimeSec}`);
    }
    
    // VS comes in feet per second from SimConnect (SDK default)
    // Convert to m/s for frame contract AND fpm for display
    const vsFps = d.vs ?? 0;
    const vsMs = vsFps * FT_TO_M;     // fps to m/s (1 fps = 0.3048 m/s, same as ft→m)
    const vsFpm = vsFps * FPS_TO_FPM; // fps to fpm (1 fps = 60 fpm)
    
    // RA comes in feet, convert to meters for frame contract
    // Negative or implausibly large RA values indicate invalid menu-state data.
    // Clamp them to zero before downstream processing.
    const raRaw = d.ra ?? 0;
    const raFt = (raRaw < 0 || raRaw > 100000) ? 0 : raRaw;
    const raM = raFt * FT_TO_M;
    
    // IAS comes in knots per SDK and frame contract; use knots directly
    const iasKts = d.ias ?? 0;
    
    const spoilersPct = d.spoilers ?? 0;
    const isArmed = boolOrNull(d.spoilersArmed);
    const spoilersObj = {
      ...makeSpoilersObj(spoilersPct, { scale: 'percent', armed: isArmed === true }),
      armed: isArmed,
      _source: 'simconnect',
    };
    
    // Build lights object from LIGHT STATES bitmask (standard SimConnect format)
    const nativeLightSample = captureLightMaskSample({
      source: 'simvar:lightStates', raw: d.lightStates,
      snapshot: { ...this._rustSimvarBridge?.getSnapshot?.(), updatedAt: this._rustLightStatesUpdatedAt },
      sequence: this._rustLightStatesSequence, nowMs: Date.now(),
    });
    const lights = { ...decodeLights(nativeLightSample.mask ?? 0), available: nativeLightSample.fresh };
    
    // WOW (weight on wheels)
    const wow = d.wow ?? false;
    const systemDialogMode = this._systemState.dialogMode;
    const menuState = computeMenuState({
      systemSim: this._systemState.sim,
      simRunningRaw: this._simRunning,
      cameraState: d.cameraState,
      crashFlag: d.crashFlag,
      crashSequence: d.crashSequence,
      userInput: d.userInput,
      paused: d.paused,
    });
    const { effectiveInMenu, inFlightContext, simRunning, systemSim, hasSystemSimState, cameraState, cameraUserControl, crashFlagActive, crashSequenceValue, crashActive } = menuState;
    
    // Attitude
    // NOTE: For historical compatibility, downstream code expects a specific sign convention.
    // SimConnect returns the standard aviation convention; we negate here to preserve downstream expectations.
    const pitchDeg = -(d.pitch ?? 0);
    const bankDeg = -(d.bank ?? 0);
    const DEG2RAD = Math.PI / 180;
    
    const gearConfigurationAvailable = [d.gearNose, d.gearLeft, d.gearRight]
      .every((value) => typeof value === 'number' && Number.isFinite(value));
    const gearNose = gearConfigurationAvailable ? d.gearNose : 0;
    const gearLeft = gearConfigurationAvailable ? d.gearLeft : 0;
    const gearRight = gearConfigurationAvailable ? d.gearRight : 0;
    const gearHandle = d.gearHandle ? 1 : 0;  // Boolean: 1 = down, 0 = up
    const gearDownLocked = gearConfigurationAvailable
      ? ((gearNose >= 99 && gearLeft >= 99 && gearRight >= 99) ? 1 : 0)
      : null;
    const flapsConfigurationAvailable = [d.flaps, d.flapsIndex, d.flapsAngleDeg]
      .some((value) => typeof value === 'number' && Number.isFinite(value));
    
    // Build frame with source and display units
    const frame = {
      // Source units (frame contract: m/s, meters, knots)
      // IAS is provided in knots per frame contract
      ias: iasKts,
      vs: vsMs,
      ra: raM,
      wow,
      
      // Display units (fpm, feet, knots) - these are what simbridge-core uses
      display: {
        iasKts,
        vsFpm, // Converted from fps: vsFps * 60
        raFt,
        gsKts: d.gs ?? 0,
      },
      
      // Sim state
      // SIM DISABLED = true when sim is paused or loading
      // inMenu prefers SimConnect SystemState('Sim') when available:
      //   Sim=0 => UI/menu, Sim=1 => user controlling aircraft
      // Fallback remains USER INPUT ENABLED for resilience.
      paused: d.paused ?? false,
      inMenu: effectiveInMenu,
      
      // Surface (pass onAnyRunway for accurate runway detection)
      surface: this._decodeSurfaceType(d.surfaceType, wow, d.onAnyRunway),
      
      // Gear
      gearHandle,
      gearDownLocked,
      gearConfigurationAvailable,
      gearLeft,
      gearRight,
      gearNose,
      
      // Config
      lights,
      navRadios: {
        ...this._getActiveAircraftControlProfileGeneration(),
        radios: this._captureNavRadioState(),
      },
      flaps: d.flaps ?? 0,          // SimConnect FLAPS HANDLE PERCENT: 0-100 (primary source)
      flapsIndex: d.flapsIndex ?? null,    // SimConnect FLAPS HANDLE INDEX: 0-N
      flapsAngleDeg: d.flapsAngleDeg ?? null,  // TRAILING EDGE FLAPS LEFT ANGLE: actual degrees
      flapsConfigurationAvailable,
      spoilers: spoilersObj,
      
      // Attitude
      pitch: pitchDeg * DEG2RAD,
      bank: bankDeg * DEG2RAD,
      attitudeValid: true,
      attitudeDebug: {
        pitchSource: 'simconnect',
        bankSource: 'simconnect',
        pitchDegPrimary: pitchDeg,
        bankDegPrimary: bankDeg,
      },
      
      // Navigation
      gs: d.gs ?? 0,
      windSpeed: typeof d.windSpeed === 'number' && Number.isFinite(d.windSpeed) ? d.windSpeed : null,
      windDir: typeof d.windDir === 'number' && Number.isFinite(d.windDir) ? d.windDir : null,
      heading: d.heading ?? 0,
      magvar: d.magvar ?? 0,
      
      // GPS
      lat: d.lat ?? null,
      lon: d.lon ?? null,
      gpsSource: 'simconnect',
      
      // MSL altitude (standard field name)
      alt_msl: d.altMsl ?? 0,
      
      // Design speeds (for ICAO category inference when profile doesn't specify)
      // VS0: Stall speed in landing configuration; native unit is KIAS.
      // VS1: Stall speed in clean configuration - native unit is kias
      designSpeedVs0Kts: d.designSpeedVs0Kts ?? null,
      designSpeedVs1Kts: d.designSpeedVs1Kts ?? null,
      
      // Parking brake is a Bool SimVar; frame.brake stays numeric for shared gear/brake helpers.
      brake: coerceSimConnectBool(d.parkingBrake) === true ? 1 : 0,
      
      // Engines
      engines: this._buildEnginesData(d),
      
      // Throttle
      throttle: this._buildThrottleData(d),
      
      // G-Force (for landing grade)
      gforce: typeof d.gforce === 'number' && Number.isFinite(d.gforce) ? d.gforce : null,
      
      // SimConnect state
      simconnect: {
        available: this._available,
        connected: this._connected,
        inFlightContext,
        simRunning,
        systemSim,
        dialogMode: systemDialogMode,
        systemStateAvailable: hasSystemSimState,
        cameraState,
        cameraUserControl,
        crashFlag: crashFlagActive,
        crashSequence: crashSequenceValue,
        crashActive,
        rustSimvars: (() => {
          const snap = this._rustSimvarBridge?.getSnapshot?.() || null;
          return {
            mode: 'primary',
            status: snap?.status || 'disabled',
            updatedAt: snap?.updatedAt || null,
            liveValueCount: snap?.values && typeof snap.values === 'object'
              ? Object.values(snap.values).filter((value) => value != null).length
              : 0,
            subscriptionCount: snap?.subscriptions?.length || 0,
            maxVars: RUST_SIMVARS_MAX_VARS,
            error: snap?.error || null,
          };
        })(),
        lat: d.lat,
        lon: d.lon,
        hdgTrueDeg: d.heading ?? null,
        hdgMagDeg: d.headingMag ?? null,
        touchdown: buildSimConnectTouchdownData(d),
        // Human-readable aircraft name (TITLE simvar), falling back to the config
        // file path from AircraftLoaded. Consumed by simbridge-core → CSV 'aircraft' column.
        aircraftLoadedName: this._lastDetectedAircraftDisplayName || this._lastDetectedAircraftTitle || null,
      },
      
      // FDM (Flight Data Monitoring) - populated with SimConnect data where available
      fdm: buildSimConnectFdmData(d, boolOrNull),

      // Simulator virtual world time (cockpit clock, not real wall time)
      simTime: buildSimConnectSimTime(d, this._secToHms.bind(this)),

      // SIMULATOR-ASSISTANCE STATE
      assists: buildSimConnectAssists(d, boolOrNull),

      // AIRCRAFT WARNINGS
      warnings: buildSimConnectWarnings(d, boolOrNull),

      // LVAR bridge metadata
      // Runtime values are intentionally empty until sidecar integration is added.
      lvars: (() => {
        const lvarConfig = this._lvarConfig || profileLoader.getLvarConfig();
        const bridgeSnapshot = this._lvarBridge?.getSnapshot?.() || null;
        const values = { ...(bridgeSnapshot?.values || {}) };
        if (Object.prototype.hasOwnProperty.call(values, 'standard_light_states')) {
          const sample = captureLightMaskSample({
            source: 'lvar:standard_light_states', raw: values.standard_light_states,
            snapshot: bridgeSnapshot, sequence: bridgeSnapshot.snapshotSequence,
            profileMatches: bridgeSnapshot.profileId === lvarConfig.profileId,
            fieldKey: 'standard_light_states', notBeforeMs: this._rustControlReadbackNotBeforeMs,
            nowMs: Date.now(),
          });
          if (!sample.fresh) delete values.standard_light_states;
        }
        return {
          enabled: lvarConfig.enabled,
          profileId: lvarConfig.profileId,
          source: bridgeSnapshot?.source || 'profile-config',
          status: bridgeSnapshot?.status || (config.lvarSidecar?.enable ? 'starting' : 'disabled'),
          subscriptions: lvarConfig.subscriptions,
          values,
          updatedAt: bridgeSnapshot?.updatedAt || null,
          error: bridgeSnapshot?.error || null,
        };
      })(),

      // SDK bridge data — populated when dataSource.sdk is configured and the active
      // adapter has a live sidecar connection.
      sdk: (() => {
        const resolvedSdk = this._resolveActiveSdkProfile();
        const sdkSnap = this._sdkBridge?.getSnapshot?.() || null;
        return {
          source: sdkRegistry.SDK_SOURCE_TYPE,
          adapterId: sdkSnap?.adapterId || resolvedSdk?.adapter?.id || null,
          adapterName: sdkSnap?.adapterName || resolvedSdk?.adapter?.displayName || null,
          providerSource: sdkSnap?.transportSource || null,
          status: sdkSnap?.status || 'disabled',
          aircraft: sdkSnap?.aircraft || null,
          target: sdkSnap?.target || resolvedSdk?.profileSdk?.target || null,
          normalized: sdkSnap?.normalized || {},
          raw: sdkSnap?.raw || {},
          values: sdkSnap?.values || sdkSnap?.raw || {},
          snapshotSequence: sdkSnap?.snapshotSequence || 0,
          updatedAt: sdkSnap?.updatedAt || null,
          error: sdkSnap?.error || null,
        };
      })(),
    };

    this._broadcastDataSourcesIfLvarStatusChanged();
    
    // ═══════════════════════════════════════════════════════════════════════
    // SAMPLE COUNTER & WARMUP
    // Track samples since connection for warning detection warmup period.
    // During warmup, telemetry may be invalid/transitioning (resume, load, etc.)
    // ═══════════════════════════════════════════════════════════════════════
    this._sampleCount++;
    const isWarmupPeriod = this._sampleCount <= this._WARNING_WARMUP_SAMPLES;
    if (frame.simconnect && typeof frame.simconnect === 'object') {
      const simconnectFrameState = frame.simconnect as Record<string, any>;
      simconnectFrameState.warmup = isWarmupPeriod;
      simconnectFrameState.warmupSampleCount = this._sampleCount;
      simconnectFrameState.warmupSampleLimit = this._WARNING_WARMUP_SAMPLES;
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // OVERSPEED / STALL WARNING DETECTION
    // These SimVars reflect the aircraft's warning state (barber pole exceeded, etc.)
    // 
    // VFE vs VMO classification:
    // - If flaps are deployed AND barber pole < clean VMO → VFE (flap overspeed)
    // - Otherwise → VMO/MMO (aircraft overspeed)
    //
    // MENU GATE: Only process when inFlightContext is true to avoid false positives
    // from invalid SimVar data when in menu or no aircraft is loaded.
    // Additional sanity checks: IAS must be realistic (<600kts), skip warmup period.
    // ═══════════════════════════════════════════════════════════════════════
    const overspeed = d.overspeedWarning ?? false;
    const stall = d.stallWarning ?? false;
    const barberPoleKts = d.barberPoleKts ?? null;
    const barberPoleMach = d.barberPoleMach ?? null;
    const flapsPercent = d.flaps ?? 0;  // 0-100, 0 = retracted (FLAPS HANDLE PERCENT)
    
    // DATA VALIDITY CHECK: Multiple conditions must pass to trust warning SimVars
    // Menu state can return invalid data that passes individual checks, so use
    // multiple heuristics together:
    // - inFlightContext: sim not paused and user input enabled
    // - IAS realistic: <600 knots rejects implausible values
    // - Not warmup period: the first three seconds can contain transient values
    // - RA realistic: must be in reasonable range
    // - Barber pole realistic: no aircraft has VMO < 100kts (even slowest GA is ~120kts)
    // - GS > 0: must be moving (menu often shows IAS > 0 but GS = 0)
    this._inFlightContext = inFlightContext;
    const raRawCheck = d.ra ?? 0;
    const gsCheck = d.gs ?? 0;
    const barberPoleValid = barberPoleKts == null || barberPoleKts >= 100; // No aircraft has VMO < 100kts
    const dataLooksValid = inFlightContext && 
                           iasKts < 600 && 
                           iasKts > 0 &&
                           gsCheck > 0 &&
                           !isWarmupPeriod &&
                           raRawCheck > -1000 && raRawCheck < 100000 &&
                           barberPoleValid;
    
    // Overspeed warning state change - only emit when data is valid
    if (overspeed && !this._overspeedActive && dataLooksValid) {
      const overspeedType = classifyOverspeedType(barberPoleKts, flapsPercent);
      const typeLabel = overspeedType === 'vfe' ? 'FLAP OVERSPEED (VFE)' : 'OVERSPEED (VMO/MMO)';
      console.log(`\n⚠️  ${typeLabel} WARNING ACTIVE\n`);
      Debug.log('warnings', `${typeLabel} triggered at IAS=${iasKts?.toFixed(0) ?? '?'}kts, barberPole=${barberPoleKts?.toFixed(0) ?? '?'}kts, flaps=${flapsPercent?.toFixed(0) ?? '?'}%`);
      eventBus.emit('sim:overspeed', {
        timestamp: new Date().toISOString(),
        ias: iasKts,
        active: true,
        overspeedType,
        barberPoleKts,
        barberPoleMach,
        flapsPercent,
      });
    } else if (!overspeed && this._overspeedActive) {
      Debug.log('warnings', 'Overspeed warning cleared');
      eventBus.emit('sim:overspeed', {
        timestamp: new Date().toISOString(),
        ias: iasKts,
        active: false,
        overspeedType: null,
        barberPoleKts,
        barberPoleMach,
        flapsPercent,
      });
    }
    // Track state only when data is valid to prevent menu-state false positives.
    if (dataLooksValid) {
      this._overspeedActive = overspeed;
    }
    
    // Stall warning state change (only when data looks valid)
    if (stall && !this._stallActive && dataLooksValid) {
      console.log('\n⚠️  STALL WARNING ACTIVE\n');
      Debug.log('warnings', `Stall warning triggered at IAS=${iasKts?.toFixed(0) ?? '?'}kts`);
      eventBus.emit('sim:stall', {
        timestamp: new Date().toISOString(),
        ias: iasKts,
        active: true,
      });
    } else if (!stall && this._stallActive) {
      Debug.log('warnings', 'Stall warning cleared');
      eventBus.emit('sim:stall', {
        timestamp: new Date().toISOString(),
        ias: iasKts,
        active: false,
      });
    }
    // Track state only when data is valid to prevent menu-state false positives.
    if (dataLooksValid) {
      this._stallActive = stall;
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // CABIN ALTITUDE WARNING DETECTION
    // Monitors cabin pressure altitude for hypoxia risk.
    // Thresholds based on FAR 91.211 (oxygen requirements):
    //   - 10,000 ft: Crew needs supplemental O2 after 30 min
    //   - 14,000 ft: All occupants need O2; rapid onset of hypoxia symptoms
    // ═══════════════════════════════════════════════════════════════════════
    const cabinAltFt = d.cabinAltFt ?? null;
    const CABIN_ALT_WARNING_FT  = config.violationThresholds.cabinAltitudeWarningFt;
    const CABIN_ALT_CRITICAL_FT = config.violationThresholds.cabinAltitudeCriticalFt;
    
    // Only check while airborne
    if (!wow && cabinAltFt != null) {
      const cabinWarning = cabinAltFt >= CABIN_ALT_WARNING_FT;
      const cabinCritical = cabinAltFt >= CABIN_ALT_CRITICAL_FT;
      const severity = cabinCritical ? 'critical' : (cabinWarning ? 'warning' : null);
      
      // Cabin warning state change
      if (cabinWarning && !this._cabinAltWarningActive) {
        console.log(`\n⚠️  CABIN ALTITUDE WARNING: ${Math.round(cabinAltFt)} ft${cabinCritical ? ' (CRITICAL)' : ''}\n`);
        Debug.log('warnings', `Cabin altitude warning at ${Math.round(cabinAltFt)} ft`);
        eventBus.emit('sim:cabinAltitude', {
          timestamp: new Date().toISOString(),
          cabinAltFt: Math.round(cabinAltFt),
          severity,
          active: true,
        });
      } else if (!cabinWarning && this._cabinAltWarningActive) {
        Debug.log('warnings', 'Cabin altitude warning cleared');
        eventBus.emit('sim:cabinAltitude', {
          timestamp: new Date().toISOString(),
          cabinAltFt: Math.round(cabinAltFt),
          severity: null,
          active: false,
        });
      } else if (cabinWarning && this._cabinAltWarningActive) {
        // Update severity if it changed (warning → critical or vice versa)
        const prevSeverity = this._cabinAltSeverity;
        if (severity !== prevSeverity) {
          Debug.log('warnings', `Cabin altitude severity changed: ${prevSeverity} → ${severity}`);
          eventBus.emit('sim:cabinAltitude', {
            timestamp: new Date().toISOString(),
            cabinAltFt: Math.round(cabinAltFt),
            severity,
            active: true,
          });
        }
      }
      this._cabinAltWarningActive = cabinWarning;
      this._cabinAltSeverity = severity;
    } else if (wow && this._cabinAltWarningActive) {
      // Clear warning when landing
      this._cabinAltWarningActive = false;
      this._cabinAltSeverity = null;
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // FUEL EXHAUSTION DETECTION
    // Triggers on either:
    //   1. Total fuel < 1 gallon (true exhaustion), OR
    //   2. Fuel < 100 gal AND all engines NOT combusting AND airborne (unusable fuel)
    // The second condition catches aircraft with unusable fuel reserves that show
    // on the gauge but can't reach the engines.
    // Uses ENG COMBUSTION which works for ALL engine types (piston, jet, turboprop)
    //
    // FAIL-SAFE: If ENG COMBUSTION SimVars are unavailable (null), we can only
    // detect true exhaustion (fuel < 1 gal). We do NOT trigger "unusable fuel"
    // warnings if we can't confirm engine state - that would cause false positives.
    //
    // MENU GATE: Only check fuel exhaustion when in active flight context.
    // Menu aircraft switches can momentarily show 0 fuel, causing false positives.
    // ═══════════════════════════════════════════════════════════════════════
    // Exhaustion/flameout detection should prefer the legacy available-fuel
    // total. MSFS 2024 EX1 intentionally includes unusable fuel, which is good
    // for display/history totals but can hide fuel-starvation conditions here.
    const fuelGal = d.fuelTotalGal ?? d.fuelTotalGalEx1 ?? null;
    const eng1Running = d.eng1Combustion;  // Keep as null if unavailable
    const eng2Running = d.eng2Combustion;
    const eng3Running = d.eng3Combustion;
    const eng4Running = d.eng4Combustion;
    
    // Check if we have valid combustion data (at least one engine reports non-null)
    const hasCombustionData = eng1Running != null || eng2Running != null || 
                               eng3Running != null || eng4Running != null;
    const anyEngineRunning = Boolean(eng1Running || eng2Running || eng3Running || eng4Running);
    const isAirborne = !wow;
    
    const FUEL_EMPTY_GAL = 1.0;           // True exhaustion threshold
    const FUEL_LOW_GAL = 100.0;           // Low fuel threshold for flameout check
    
    // True exhaustion: fuel gauge reads < 1 gal (always triggers)
    const isTrueExhaustion = fuelGal != null && fuelGal < FUEL_EMPTY_GAL;
    
    // Unusable fuel flameout: ONLY if we have valid combustion data
    // Fail-safe: if combustion SimVars unavailable, skip this check entirely
    const isUnusableFuelFlameout = hasCombustionData && 
                                    fuelGal != null && fuelGal < FUEL_LOW_GAL && 
                                    !anyEngineRunning && isAirborne;
    
    // MENU GATE: Only process fuel exhaustion when in active flight context
    // Menu aircraft switches can momentarily show 0 fuel, causing false positives
    // Also skip during warmup period (data is transitioning after connection/aircraft load)
    // Note: isWarmupPeriod is already computed earlier in this function
    const fuelLooksInvalid = fuelGal === 0 || fuelGal === null;  // Exact 0 is suspicious (menu transition)
    
    // Debug: log when fuel exhaustion would have triggered but was suppressed
    if ((isTrueExhaustion || isUnusableFuelFlameout) && !this._fuelExhausted) {
      if (!inFlightContext || isWarmupPeriod || fuelLooksInvalid) {
        const reason = !inFlightContext ? 'menu/paused' : isWarmupPeriod ? 'warmup' : 'invalid data';
        Debug.log('fuel', `Fuel exhaustion SUPPRESSED (${reason}) - fuel=${fuelGal}, inFlightContext=${inFlightContext}, warmup=${isWarmupPeriod}`);
      }
    }
    
    if (!inFlightContext || isWarmupPeriod) {
      // Reset fuel exhaustion state when not in flight context (menu, paused, etc.)
      if (this._fuelExhausted) {
        Debug.log('fuel', `Fuel exhaustion state reset (${!inFlightContext ? 'not in flight context' : 'warmup period'})`);
        this._fuelExhausted = false;
      }
    } else if (fuelLooksInvalid) {
      // Skip - fuel data looks invalid (likely menu transition)
      // Don't reset state, just don't trigger new warnings
    } else if ((isTrueExhaustion || isUnusableFuelFlameout) && !this._fuelExhausted) {
      // Fuel exhaustion detected
      const reason = isTrueExhaustion ? 'empty' : 'unusable';
      console.log(`\n⛽ FUEL EXHAUSTED (${reason})\n`);
      Debug.log('fuel', `Fuel exhausted (${reason}) - ${fuelGal?.toFixed(1) ?? '?'} gal remaining, engines running: ${anyEngineRunning}`);
      eventBus.emit('sim:fuelExhausted', {
        timestamp: new Date().toISOString(),
        fuelGal,
        anyEngineRunning,
        reason,
        exhausted: true,
      });
      this._fuelExhausted = true;
    } else if (this._fuelExhausted && (fuelGal >= FUEL_LOW_GAL || anyEngineRunning)) {
      // Reset if: refueled past 100 gal OR an engine restarted (air restart/relight)
      Debug.log('fuel', `Fuel exhaustion cleared - ${fuelGal?.toFixed(1) ?? '?'} gal, engines running: ${anyEngineRunning}`);
      this._fuelExhausted = false;
    }
    
    return frame;
  }

  _decodeSurfaceType(type, wow, onAnyRunway) {
    // SimConnect SURFACE_TYPE enum
    const types = {
      0: 'CONCRETE',
      1: 'GRASS',
      2: 'WATER',
      3: 'GRASS_BUMPY',
      4: 'ASPHALT',
      5: 'SHORT_GRASS',
      6: 'LONG_GRASS',
      7: 'HARD_TURF',
      8: 'SNOW',
      9: 'ICE',
      10: 'URBAN',
      11: 'FOREST',
      12: 'DIRT',
      13: 'CORAL',
      14: 'GRAVEL',
      15: 'OIL_TREATED',
      16: 'STEEL_MATS',
      17: 'BITUMINOUS',
      18: 'BRICK',
      19: 'MACADAM',
      20: 'PLANKS',
      21: 'SAND',
      22: 'SHALE',
      23: 'TARMAC',
      24: 'WRIGHT_FLYER_TRACK',
    };
    
    // Paved surfaces that could be runway-like
    const PAVED = new Set([0, 4, 15, 16, 17, 18, 19, 22, 23]);
    const UNPAVED = new Set([1, 3, 5, 6, 7, 12, 13, 14, 20, 21]);
    
    const code = Number.isFinite(type) ? (type | 0) : null;
    const name = code !== null ? (types[code] ?? 'UNKNOWN') : null;
    
    // ON ANY RUNWAY from SimConnect is the authoritative source for runway detection
    // when available - it knows the actual runway geometry, not just surface type
    const onRunway = typeof onAnyRunway === 'boolean' ? onAnyRunway : null;
    
    if (!wow) {
      return {
        raw: code,
        name,
        class: 'UNKNOWN',
        runwayLike: false,
        onRunway: false,  // Can't be on runway if not on ground
        onGround: false,
        valid: false,
      };
    }
    
    // Determine surface class
    let surfaceClass = 'UNKNOWN';
    let runwayLikeFromSurface = false;
    
    if (code !== null && PAVED.has(code)) {
      surfaceClass = 'PAVED';
      runwayLikeFromSurface = true;
    } else if (code !== null && UNPAVED.has(code)) {
      surfaceClass = 'UNPAVED';
    } else if (code === 2) {
      surfaceClass = 'WATER';
    }
    
    // runwayLike: prefer SimConnect ON ANY RUNWAY if available, fallback to surface inference
    // ON ANY RUNWAY is more accurate because taxiways are also paved but aren't runways
    const runwayLike = onRunway !== null ? onRunway : runwayLikeFromSurface;
    
    return {
      raw: code,
      name,
      class: surfaceClass,
      runwayLike,
      onRunway,  // Explicit SimConnect value (null if not available)
      onGround: true,
      valid: surfaceClass !== 'UNKNOWN',
    };
  }

  _buildEnginesData(d) {
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v ?? 0));
    const fmtPct = (v) => Number.isFinite(v) ? `${Math.round(v)}%` : '--';
    const profileEngineCount = getProfileEngineCount(profileLoader.getActiveProfile?.()) || null;
    
    // Use SimConnect N1 data
    const eng1N1 = d.eng1N1;
    const eng2N1 = d.eng2N1;
    const eng3N1 = d.eng3N1;
    const eng4N1 = d.eng4N1;
    const n1Values = [eng1N1, eng2N1, eng3N1, eng4N1];
    const source = 'simconnect_n1';
    
    // Count active engines
    let count = profileEngineCount || 0;
    if (count === 0) {
      for (let i = 1; i <= n1Values.length; i++) {
        const val = n1Values[i - 1];
        if (val > 0) count = i;
      }
    }
    
    if (count === 0) return null;
    
    return {
      count,
      source,
      eng1: clamp(eng1N1, 0, 110),
      eng2: clamp(eng2N1, 0, 110),
      eng3: count >= 3 ? clamp(eng3N1, 0, 110) : null,
      eng4: count >= 4 ? clamp(eng4N1, 0, 110) : null,
      eng1Text: fmtPct(eng1N1),
      eng2Text: fmtPct(eng2N1),
      eng3Text: count >= 3 ? fmtPct(eng3N1) : '--',
      eng4Text: count >= 4 ? fmtPct(eng4N1) : '--',
    };
  }

  _buildThrottleData(d) {
    return {
      eng1Pct: d.thr1 ?? 0,
      eng2Pct: d.thr2 ?? 0,
      eng3Pct: d.thr3 ?? null,
      eng4Pct: d.thr4 ?? null,
      source: 'simconnect',
    };
  }

  /**
   * Convert seconds-since-midnight to HH:MM:SS format
   * @param {number|null} sec - Seconds since midnight (0-86399)
   * @returns {string|null} - Formatted time string "HH:MM:SS" or null if invalid
   */
  _secToHms(sec) {
    if (sec == null || !Number.isFinite(sec) || sec < 0) return null;
    const hours = Math.floor(sec / 3600) % 24;
    const minutes = Math.floor((sec % 3600) / 60);
    const seconds = Math.floor(sec % 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  async stop() {
    if (this._providerStopPromise) {
      await this._providerStopPromise;
      return;
    }

    this._stopping = true;
    this._lifecycleGeneration += 1;
    this._sdkInitRequestSequence += 1;
    const stopPromise = this._stopOnce();
    this._providerStopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this._providerStopPromise === stopPromise) {
        this._providerStopPromise = null;
      }
    }
  }

  async _stopOnce() {
    if (this._lvarAircraftListener) {
      eventBus.off('simconnect:aircraftChanged', this._lvarAircraftListener);
      this._lvarAircraftListener = null;
    }

    if (this._sdkAircraftListener) {
      eventBus.off('simconnect:aircraftChanged', this._sdkAircraftListener);
      this._sdkAircraftListener = null;
    }

    this._stopMsfsFacilitiesProbe();
    this._msfsFacilitiesGeometryProvider = null;

    if (this._shakeTimers) { this._shakeTimers.forEach(t => clearTimeout(t)); this._shakeTimers = []; }
    if (this._cameraHeartbeatTimer) { clearInterval(this._cameraHeartbeatTimer); this._cameraHeartbeatTimer = null; }
    if (this._rustAircraftChangedTimer) { clearTimeout(this._rustAircraftChangedTimer); this._rustAircraftChangedTimer = null; }
    this._rustIgnoredAircraftLoadedDisplayName = null;
    this._clearRustTitleFallbackTimer();
    this._rustTitleFallbackNeedsPathConfirmation = false;
    this._connected = false;

    const collectBridges = () => [
      this._lvarBridge && typeof this._lvarBridge.stop === 'function'
        ? { field: '_lvarBridge', label: 'LVAR sidecar', bridge: this._lvarBridge }
        : null,
      this._sdkBridge && typeof this._sdkBridge.stop === 'function'
        ? { field: '_sdkBridge', label: 'SDK sidecar', bridge: this._sdkBridge }
        : null,
      this._rustSimvarBridge && typeof this._rustSimvarBridge.stop === 'function'
        ? { field: '_rustSimvarBridge', label: 'Rust SimVar sidecar', bridge: this._rustSimvarBridge }
        : null,
    ].filter(Boolean);

    const entriesByBridge = new Map();
    const outcomes = new Map();
    const rememberEntries = (entries) => {
      for (const entry of entries) entriesByBridge.set(entry.bridge, entry);
    };
    const stopEntry = async (entry) => {
      try {
        await entry.bridge.stop();
        outcomes.set(entry.bridge, { status: 'fulfilled' });
      } catch (reason) {
        outcomes.set(entry.bridge, { status: 'rejected', reason });
      }
    };

    const initialEntries = collectBridges();
    rememberEntries(initialEntries);
    const initializationPromises = Array.from(new Set([
      this._providerStartPromise,
      this._lvarInitPromise,
      this._sdkInitPromise,
      this._rustSimvarInitPromise,
    ].filter(Boolean)));

    const initializationResultsPromise = Promise.allSettled(initializationPromises);
    await Promise.all([
      Promise.all(initialEntries.map((entry) => stopEntry(entry))),
      initializationResultsPromise,
    ]);
    const initializationResults = await initializationResultsPromise;

    // A stale initializer is required to reap anything it managed to spawn.
    // Verify that invariant and make one final stop attempt for any new or
    // restarted bridge before deciding which references are safe to clear.
    const currentEntries = collectBridges();
    rememberEntries(currentEntries);
    const followupEntries = Array.from(entriesByBridge.values()).filter((entry) => {
      const outcome = outcomes.get(entry.bridge);
      return !outcome || (outcome.status === 'fulfilled' && this._bridgeMayBeLive(entry.bridge));
    });
    await Promise.all(followupEntries.map((entry) => stopEntry(entry)));

    const failures = [];
    initializationResults.forEach((result) => {
      if (result.status !== 'rejected') return;
      const reason = result.reason instanceof Error
        ? result.reason
        : new Error(String(result.reason || 'unknown initialization failure'));
      failures.push(new Error(`Sidecar initialization: ${reason.message}`, { cause: reason }));
    });

    for (const [bridge, outcome] of outcomes.entries()) {
      const entry = entriesByBridge.get(bridge);
      if (outcome.status === 'rejected') {
        const reason = outcome.reason instanceof Error
          ? outcome.reason
          : new Error(String(outcome.reason || 'unknown stop failure'));
        failures.push(new Error(`${entry.label}: ${reason.message}`, { cause: reason }));
        continue;
      }
      if (this._bridgeMayBeLive(bridge)) {
        failures.push(new Error(`${entry.label}: bridge remained live after stop resolved`));
      }
    }

    for (const entry of collectBridges()) {
      const outcome = outcomes.get(entry.bridge);
      if (
        outcome?.status === 'fulfilled'
        && !this._bridgeMayBeLive(entry.bridge)
        && this[entry.field] === entry.bridge
      ) {
        this[entry.field] = null;
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more SimConnect sidecars failed to stop');
    }

    console.log('[SimConnectTelemetry] Stopped');
  }

  isAvailable() {
    return this._available;
  }

  isConnected() {
    return this._connected;
  }

  // ─── Touchdown camera shake ───────────────────────────────────────────────
  // Uses CameraSetRelative6DOF via the SimConnect DLL path (lvar-sidecar).
  // Sets an absolute pitch offset from the default eyepoint — pitch=0 is neutral.
  // Sine-based damped oscillation: smooth onset (no first-frame snap), peaks at
  // ~125 ms, then decays. Amplitude scales with V/S; ~700 ms total duration.
  //
  // @param {number} vsFpm  Vertical speed at touchdown in fpm (negative = descent)
  triggerTouchdownShake(vsFpm) {
    console.log(`[TouchdownShake] triggerTouchdownShake called: vsFpm=${vsFpm}, connected=${this._connected}`);

    const lvarBridgeAvailable = this._lvarBridge &&
      typeof this._lvarBridge.sendEvent === 'function' &&
      this._lvarBridge._started &&
      this._lvarBridge._proc &&
      !this._lvarBridge._proc.killed;

    if (!lvarBridgeAvailable) {
      console.warn('[TouchdownShake] Aborting: LVAR sidecar path unavailable');
      return;
    }
    if (typeof vsFpm !== 'number' || vsFpm > -100) {
      console.warn(`[TouchdownShake] Aborting: vsFpm guard failed (vsFpm=${vsFpm}, must be number <= -100)`);
      return;
    }

    console.log(`[TouchdownShake] lvarBridge available=${lvarBridgeAvailable}`);

    // Scale to V/S severity: N = 1–5
    const N  = Math.max(1, Math.min(5, Math.round(Math.abs(vsFpm) / 200)));

    console.log(`[TouchdownShake] Shake: N=${N} vsFpm=${vsFpm}`);

    // Cancel any in-progress shake
    if (this._shakeTimers) this._shakeTimers.forEach(t => { clearTimeout(t); clearInterval(t); });
    this._shakeTimers = [];

    if (lvarBridgeAvailable) {
      // ── TOUCHDOWN SHAKE via CameraSetRelative6DOF ──────────────────────────────
      // CameraSetRelative6DOF sets an absolute offset from the default eyepoint.
      //
      // Sine-based damped oscillation — pitch(t) = -A · e^(−decay·t) · sin(2π·freq·t)
      // Starts at 0 (no first-frame snap), peaks at t=1/(4·freq)≈125ms, decays to zero.
      // Timing uses Date.now() so setInterval jitter doesn't corrupt the curve shape.
      // -300 fpm → ~0.5°  -600 fpm → ~1°  -900 fpm → ~1.5°  -1200+ fpm → ~2° (max)
      const amplitude  = Math.min(2.0, Math.max(0.3, Math.abs(vsFpm) / 600));
      const decay      = 5.0;   // settle speed (higher = faster)
      const freq       = 2.0;   // bounces per second
      const TICK_MS    = 33;    // ~30 fps
      const DURATION_MS = 700;

      const shake = (pitch) =>
        this._lvarBridge.sendCameraShake({ pitch, bank: 0, heading: 0, dx: 0, dy: 0, dz: 0 });

      // Reset any residual offset from a cancelled shake
      shake(0);

      const shakeStart = Date.now();
      const iv = setInterval(() => {
        const t = (Date.now() - shakeStart) / 1000;
        const pitch = -amplitude * Math.exp(-decay * t) * Math.sin(2 * Math.PI * freq * t);
        shake(pitch);
        if (Date.now() - shakeStart >= DURATION_MS) {
          clearInterval(iv);
          shake(0);
          this._shakeTimers = this._shakeTimers.filter(x => x !== iv);
        }
      }, TICK_MS);
      this._shakeTimers.push(iv);
      console.log(`[TouchdownShake] shake amplitude=${amplitude.toFixed(2)}° vsFpm=${vsFpm}`);
    } else {
      // lvar-sidecar not available — camera shake requires the DLL path, no fallback
      console.warn('[TouchdownShake] lvarBridge not available — camera shake skipped');
    }
  }
}

/**
 * Classify overspeed type: 'vfe' (flap limit) or 'vmo' (aircraft limit)
 * 
 * Conservative heuristic:
 * - Little/no flap deployment is generic aircraft overspeed (VMO/MMO).
 * - Substantial flap deployment is flap overspeed (VFE).
 * - Small flap deployment is intentionally generic. Low-VMO turboprops/GA
 *   aircraft can have barber-pole limits below 280 kt clean, so barber pole
 *   alone is not enough evidence for a confident VFE label.
 * 
 * @param {number|null} barberPoleKts - Current barber pole (redline) speed in knots
 * @param {number} flapsPercent - Flaps position 0-100 (0 = retracted)
 * @returns {'vfe'|'vmo'} - 'vfe' for flap overspeed, 'vmo' for aircraft overspeed
 */
function classifyOverspeedType(barberPoleKts, flapsPercent) {
  // If no barber pole data, can't classify - default to VMO
  if (barberPoleKts == null) return 'vmo';

  const flapsPct = Number.isFinite(Number(flapsPercent)) ? Number(flapsPercent) : 0;

  // If flaps are retracted/minimally out, it's VMO/MMO.
  if (flapsPct < 5) return 'vmo';

  // Small flap deployment is ambiguous across aircraft. Be conservative:
  // a generic overspeed label is safer than a false FLAP OVERSPEED label.
  if (flapsPct <= 20) return 'vmo';

  // Substantial flap deployment is enough evidence for a VFE label.
  if (flapsPct > 20) return 'vfe';

  return 'vmo';
}

/**
 * Compute effective menu state from raw SimConnect signals.
 * Pure function — all inputs explicit, no side effects.
 *
 * @param {Object} params
 * @param {number|null|undefined} params.systemSim - SystemState('Sim'): 0=menu, 1=flying
 * @param {boolean|null|undefined} params.simRunningRaw - SimStart/SimStop event state
 * @param {number|null|undefined} params.cameraState - CAMERA STATE simvar (<=6 = user-controlled)
 * @param {boolean|number|null|undefined} params.crashFlag - CRASH FLAG enum; any non-zero code means active crash
 * @param {number|null|undefined} params.crashSequence - CRASH SEQUENCE simvar
 * @param {boolean|null|undefined} params.userInput - USER INPUT ENABLED simvar
 * @param {boolean|null|undefined} params.paused - SIM DISABLED simvar
 * @returns {{ effectiveInMenu: boolean, inFlightContext: boolean, simRunning: boolean|null }}
 */
function computeMenuState({ systemSim, simRunningRaw, cameraState, crashFlag, crashSequence, userInput, paused }) {
  const hasSystemSimState = systemSim === 0 || systemSim === 1;
  const simRunning = (typeof simRunningRaw === 'boolean') ? simRunningRaw : (hasSystemSimState ? systemSim === 1 : null);
  const camState = Number.isFinite(cameraState) ? cameraState : null;
  const cameraUserControl = camState == null ? true : camState <= 6;
  const crashFlagCode = typeof crashFlag === 'number' && Number.isFinite(crashFlag) ? crashFlag : null;
  const crashFlagActive = crashFlag === true || (crashFlagCode !== null && crashFlagCode > 0);
  const crashSequenceValue = Number.isFinite(crashSequence) ? crashSequence : 0;
  const crashActive = crashFlagActive || crashSequenceValue > 0;
  const inMenuBySystemState = systemSim === 0;
  const inFlightBySystemState = systemSim === 1;
  const fallbackInMenu = userInput === false;
  const baseInMenu = hasSystemSimState ? inMenuBySystemState : fallbackInMenu;
  const effectiveInMenu = baseInMenu || cameraUserControl === false || crashActive || simRunning === false;
  const inFlightContext = !paused && userInput !== false && cameraUserControl === true && crashActive === false && simRunning !== false && (hasSystemSimState ? inFlightBySystemState : true);
  return { effectiveInMenu, inFlightContext, simRunning, systemSim, hasSystemSimState, cameraState: camState, cameraUserControl, crashFlagActive, crashSequenceValue, crashActive };
}

module.exports = {
  AIRCRAFT_INTEGRATION_DERIVED_LIGHT_SIMVARS,
  SimConnectTelemetryProvider,
  SIMCONNECT_CHUNK_SIZE,
  RUST_SIMVARS_MAX_VARS,
  SIMCONNECT_VARS,
  STANDARD_LIGHT_FALLBACK_SUBSCRIPTIONS,
  RUST_AIRCRAFT_TITLE_KEY,
  _coerceSimConnectBool: coerceSimConnectBool,
  _simConnectUnitString: simConnectUnitString,
  _usesInt32SimConnectData: usesInt32SimConnectData,
  _buildAircraftChangedPayload: buildAircraftChangedPayload,
  classifyOverspeedType,
  computeMenuState,
};

export {};
