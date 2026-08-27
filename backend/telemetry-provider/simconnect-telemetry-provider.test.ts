// simconnect-telemetry-provider.test.js
// Frame Contract Validation Tests
//
// PURPOSE:
// Ensure SimConnect-only provider produces frames with correct structure
// and units according to the telemetry frame contract.

const { makeSpoilersObj } = require('../aircraft/spoilers');
const eventBus = require('../core/event-bus');
const test = require('node:test');
const {
  AIRCRAFT_INTEGRATION_DERIVED_LIGHT_SIMVARS,
  STANDARD_LIGHT_FALLBACK_SUBSCRIPTIONS,
} = require('./simconnect-telemetry-provider');
const aircraftIntegrationCatalog = require('../aircraft/aircraft-integrations');
const { deepStrictEqual } = require('node:assert');
const { 
  REQUIRED_DISPLAY_FIELDS,
  REQUIRED_SOURCE_FIELDS,
  CONVERSION_CONSTANTS,
  validateFrame,
} = require('./frame-contract');

// ═══════════════════════════════════════════════════════════════════════════
// FRAME CONTRACT (imported from frame-contract.js - single source of truth)
// These are the EXACT fields simbridge-core.js destructures from the frame.
// If a field is missing or wrong type, downstream code will break.
// ═══════════════════════════════════════════════════════════════════════════
const REQUIRED_TOP_LEVEL_FIELDS = [
  // From contract (source fields)
  ...Object.keys(REQUIRED_SOURCE_FIELDS),
  // Additional frame fields not in contract's source fields
  'display',       // object
  'paused',        // boolean
  'inMenu',        // boolean
  'surface',       // string
  'gearHandle',    // number (0 or 1)
  'gearDownLocked',// number (0 or 1)
  'gearLeft',      // number (0-100 percent, SimConnect native)
  'gearRight',     // number (0-100 percent, SimConnect native)
  'gearNose',      // number (0-100 percent, SimConnect native)
  'lights',        // object
  'flaps',         // number (0-100 percent, SimConnect native)
  'spoilers',      // object
  'pitch',         // number|null (radians)
  'bank',          // number|null (radians)
  'attitudeValid', // boolean
  'attitudeDebug', // object
  'windSpeed',     // number (knots)
  'windDir',       // number (degrees)
  'magvar',        // number (degrees)
  'alt_msl',       // number (feet)
  'brake',         // number (0-32767)
];

// Use contract's display fields
const DISPLAY_FIELDS = Object.keys(REQUIRED_DISPLAY_FIELDS);

const REQUIRED_LIGHTS_FIELDS = [
  'nav',     // boolean
  'beacon',  // boolean
  'landing', // boolean
  'taxi',    // boolean
  'strobe',  // boolean
];

const REQUIRED_SPOILERS_FIELDS = [
  'percent',  // number (0-100)
  'fraction', // number (0-1)
  'state',    // string ('STOWED'|'ARMED'|'EXTENDED')
];

test('standard light fallback reads LIGHT STATES through the independent gauge path', () => {
  assertEqual(STANDARD_LIGHT_FALLBACK_SUBSCRIPTIONS.length, 1, 'one standard light fallback subscription');
  assertEqual(STANDARD_LIGHT_FALLBACK_SUBSCRIPTIONS[0].key, 'standard_light_states', 'stable fallback key');
  assertEqual(STANDARD_LIGHT_FALLBACK_SUBSCRIPTIONS[0].expression, '(A:LIGHT STATES)', 'gauge light mask expression');
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Utilities
// ═══════════════════════════════════════════════════════════════════════════

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}

function assertType(value, type, msg) {
  const actualType = value === null ? 'null' : typeof value;
  if (actualType !== type && !(type === 'number|null' && (actualType === 'number' || actualType === 'null'))) {
    throw new Error(`${msg}: expected type ${type}, got ${actualType}`);
  }
}

function assertHasFields(obj, fields, prefix) {
  for (const field of fields) {
    if (!(field in obj)) {
      throw new Error(`${prefix} missing required field: ${field}`);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════════════
// Generate SimConnect Frame (simulates our provider output)
// ═══════════════════════════════════════════════════════════════════════════

function createSimConnectFrame() {
  // Simulate SimConnect data 
  // SimConnect gives VS in fps (feet per second), not fpm!
  const iasKts = 150;
  const vsFps = -11.667;  // -700 fpm / 60 = -11.667 fps
  const vsFpm = vsFps * CONVERSION_CONSTANTS.FPS_TO_FPM;  // Convert back to fpm for display
  const raFt = 1200;
  const gs = 150;
  
  // Convert to source units (frame contract)
  const vsMs = vsFps * CONVERSION_CONSTANTS.FPS_TO_MS;  // fps to m/s
  const raM = raFt * CONVERSION_CONSTANTS.FT_TO_M;       // ft to m
  const spoilersObj = makeSpoilersObj(0);
  
  return {
    // Source units (frame contract: m/s, meters, knots)
    // IAS non-raw: store knots directly per frame contract
    ias: iasKts,
    vs: vsMs,
    ra: raM,
    wow: false,
    
    // Display units
    display: {
      iasKts,
      vsFpm,
      raFt,
      gsKts: gs,
    },
    
    // Sim state
    paused: false,
    inMenu: false,
    
    // Surface
    surface: 'AIR',
    
    // Gear: 0-100 percent (SimConnect native)
    gearHandle: 1,
    gearDownLocked: 1,
    gearLeft: 100,
    gearRight: 100,
    gearNose: 100,
    
    // Config
    lights: {
      nav: true,
      beacon: true,
      landing: true,
      taxi: true,
      strobe: true,
      logo: false,
    },
    // Flaps: 0-100 percent (SimConnect native)
    flaps: 50,
    spoilers: spoilersObj,
    
    // Attitude
    pitch: 0,
    bank: 0,
    attitudeValid: true,
    attitudeDebug: {
      pitchSource: 'simconnect',
      bankSource: 'simconnect',
      pitchDegPrimary: 0,
      bankDegPrimary: 0,
    },
    
    // Navigation
    gs,
    windSpeed: 10,
    windDir: 270,
    heading: 0,
    magvar: 0,
    
    // GPS
    lat: null,
    lon: null,
    gpsSource: 'simconnect',
    
    // MSL altitude
    alt_msl: 3000,
    
    // Brake
    brake: 0,
    
    // Engines
    engines: null,
    
    // Throttle
    throttle: {
      eng1Pct: 70,
      eng2Pct: 70,
      eng3Pct: null,
      eng4Pct: null,
      source: 'simconnect',
    },
    
    // G-Force
    gforce: 1.0,
    
    // SimConnect state
    simconnect: {
      available: true,
      connected: true,
      inFlightContext: true,
      lat: null,
      lon: null,
    },
    
    // FDM (optional)
    fdm: {
      tasKts: null,
      aileronPct: null,
      elevatorPct: null,
      rudderPct: null,
      oatC: 15,
      tatC: null,
      pressureMb: null,
      eng1N1: 85,
      eng2N1: 85,
      eng3N1: null,
      eng4N1: null,
      eng1N2: null,
      eng2N2: null,
      eng3N2: null,
      eng4N2: null,
      eng1EgtC: null,
      eng2EgtC: null,
      eng3EgtC: null,
      eng4EgtC: null,
      eng1FfPph: null,
      eng2FfPph: null,
      eng3FfPph: null,
      eng4FfPph: null,
      fuelTotalGal: null,
      fuelTotalWeightLbs: null,
      fuelWeightPerGal: null,
      apMaster: null,
      apAltHold: null,
      apHdgHold: null,
      apNavHold: null,
      apApprHold: null,
      apVsHold: null,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS (node:test)
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const providerCode = fs.readFileSync(path.join(__dirname, 'simconnect-telemetry-provider.js'), 'utf8');
const {
  buildSimConnectFdmData,
} = require('./simconnect-frame-builder.js') as {
  buildSimConnectFdmData: (data: Record<string, any>, boolOrNull: (value: unknown) => boolean | null) => Record<string, any>;
};
const {
  SimConnectTelemetryProvider,
  _coerceSimConnectBool,
  _buildAircraftChangedPayload,
  _simConnectUnitString,
  _usesInt32SimConnectData,
  RUST_AIRCRAFT_TITLE_KEY,
  SIMCONNECT_CHUNK_SIZE,
  RUST_SIMVARS_MAX_VARS,
  SIMCONNECT_VARS,
  classifyOverspeedType,
  computeMenuState,
} = require('./simconnect-telemetry-provider');

test('Frame contract validations (Tests 1-8)', () => {
  const scFrame = createSimConnectFrame();
  assertHasFields(scFrame, REQUIRED_TOP_LEVEL_FIELDS, 'SimConnect frame');
  assertHasFields(scFrame.display, DISPLAY_FIELDS, 'SimConnect frame.display');
  assertHasFields(scFrame.lights, REQUIRED_LIGHTS_FIELDS, 'SimConnect frame.lights');
  assertHasFields(scFrame.spoilers, REQUIRED_SPOILERS_FIELDS, 'SimConnect frame.spoilers');

  const contractResult = validateFrame(scFrame);
  if (!contractResult.valid) {
    throw new Error(`Frame contract validation failed: ${contractResult.errors.join(', ')}`);
  }

  const iasKts = 150;
  const vsFps = -11.667;
  const vsFpm = vsFps * CONVERSION_CONSTANTS.FPS_TO_FPM;
  const raFt = 1200;

  assertEqual(scFrame.ias, iasKts, 'IAS in knots');

  const expectedVsMs = vsFps * CONVERSION_CONSTANTS.FPS_TO_MS;
  if (Math.abs(scFrame.vs - expectedVsMs) > 0.01) {
    throw new Error(`VS conversion wrong: expected ${expectedVsMs}, got ${scFrame.vs}`);
  }

  const expectedRaM = raFt * CONVERSION_CONSTANTS.FT_TO_M;
  if (Math.abs(scFrame.ra - expectedRaM) > 0.001) {
    throw new Error(`RA conversion wrong: expected ${expectedRaM}, got ${scFrame.ra}`);
  }

  assertEqual(scFrame.display.iasKts, 150, 'display.iasKts');
  if (Math.abs(scFrame.display.vsFpm - vsFpm) > 1) {
    throw new Error(`display.vsFpm wrong: expected ${vsFpm}, got ${scFrame.display.vsFpm}`);
  }
  assertEqual(scFrame.display.raFt, 1200, 'display.raFt');
  assertEqual(scFrame.display.gsKts, 150, 'display.gsKts');

  assertType(scFrame.ias, 'number', 'ias');
  assertType(scFrame.vs, 'number', 'vs');
  assertType(scFrame.ra, 'number', 'ra');
  assertType(scFrame.wow, 'boolean', 'wow');
  assertType(scFrame.paused, 'boolean', 'paused');
  assertType(scFrame.surface, 'string', 'surface');
  assertType(scFrame.gearDownLocked, 'number', 'gearDownLocked');
  assertType(scFrame.flaps, 'number', 'flaps');
  assertType(scFrame.gs, 'number', 'gs');
  assertType(scFrame.windSpeed, 'number', 'windSpeed');
  assertType(scFrame.windDir, 'number', 'windDir');
  assertType(scFrame.heading, 'number', 'heading');
  assertType(scFrame.alt_msl, 'number', 'alt_msl');
});

test('Two-definition & FDM regressions (Tests 9-19)', () => {
  const CHUNK_SIZE = SIMCONNECT_CHUNK_SIZE;
  const SPLIT_INDEX = 4 * CHUNK_SIZE;
  const varNames = SIMCONNECT_VARS.map((entry) => entry.name);

  if (SPLIT_INDEX < 70 || SPLIT_INDEX > 90) {
    throw new Error(`Split index ${SPLIT_INDEX} is outside reasonable range (70-90)`);
  }
  if (SPLIT_INDEX >= varNames.length) {
    throw new Error(`Split index ${SPLIT_INDEX} >= total vars ${varNames.length}`);
  }

  const v1Critical = ['ias', 'vs', 'ra', 'wow', 'flaps', 'spoilers', 'gearHandle', 'gearLeft', 'gearRight', 'gearNose'];
  for (const varName of v1Critical) {
    const idx = varNames.indexOf(varName);
    if (idx === -1) {
      throw new Error(`V1 Critical variable '${varName}' not found in SIMCONNECT_VARS`);
    }
    if (idx >= SPLIT_INDEX) {
      throw new Error(`V1 Critical variable '${varName}' at index ${idx} is in Definition 2 (should be < ${SPLIT_INDEX})`);
    }
  }

  const fdmEssentials = ['gforce', 'aoa', 'mach', 'tas', 'sideslip'];
  for (const varName of fdmEssentials) {
    const idx = varNames.indexOf(varName);
    if (idx === -1) {
      throw new Error(`FDM Essential variable '${varName}' not found in SIMCONNECT_VARS`);
    }
    if (idx >= SPLIT_INDEX) {
      throw new Error(`FDM Essential variable '${varName}' at index ${idx} is in Definition 2 (should be < ${SPLIT_INDEX})`);
    }
  }

  const assistVars = ['unlimitedFuel', 'crashFlag', 'crashSequence', 'assistLanding', 'assistTakeoff', 'aiControls', 'aiAutotrim', 'aiDelegated', 'aiAntistall', 'slewActive'];
  for (const varName of assistVars) {
    const idx = varNames.indexOf(varName);
    if (idx === -1) {
      throw new Error(`Assist variable '${varName}' not found in SIMCONNECT_VARS`);
    }
  }

  const modernFuelVars = ['fuelTotalGalEx1', 'fuelTotalWeightLbsEx1'];
  for (const varName of modernFuelVars) {
    if (!varNames.includes(varName)) {
      throw new Error(`MSFS 2024 fuel variable '${varName}' not found in SIMCONNECT_VARS`);
    }
  }

  const restoredForRustCapProbe = [
    'accelLateral',
    'eng1N2',
    'eng2N2',
    'eng3N2',
    'eng4N2',
    'cabinAltRateFps',
    'cabinDeltaPPsf',
    'gsNeedle',
    'locNeedle',
    'navHasGlideSlope',
    'navHasLocalizer',
    'navSignal',
  ];
  for (const varName of restoredForRustCapProbe) {
    if (!varNames.includes(varName)) {
      throw new Error(`Restored Rust cap probe variable '${varName}' not found in SIMCONNECT_VARS`);
    }
  }
  if (RUST_SIMVARS_MAX_VARS !== SIMCONNECT_VARS.length) {
    throw new Error(`Rust SimVars should default to full restored list (${SIMCONNECT_VARS.length}), got ${RUST_SIMVARS_MAX_VARS}`);
  }

  const fdmFieldsExpectedByCsv = [
    'gForce',
    'gForceLateral',
    'gForceLongitudinal',
    'pitchRateRadS',
    'rollRateRadS',
    'yawRateRadS',
    'yokeXPct',
    'yokeYPct',
    'aoaDeg',
    'sideslipDeg',
    'mach',
    'tasKts',
    'fuelTotalGal',
    'fuelTotalPct',
    'fuelTotalWeightLbs',
    'fuelWeightPerGal',
    'precipRateMm',
    'precipState',
    'inCloud',
    'densityAltFt',
    'eng1N2',
    'eng4N2',
    'cabinAltRateFpm',
    'cabinDeltaPPsi',
    'nav1GsiRaw',
    'nav1CdiRaw',
    'nav1HasGlideSlope',
    'nav1HasLocalizer',
    'nav1Signal',
    'gsDeviationDots',
    'locDeviationDots',
  ];
  const builtFdm = buildSimConnectFdmData({}, _coerceSimConnectBool);
  for (const field of fdmFieldsExpectedByCsv) {
    if (!(field in builtFdm)) {
      throw new Error(`FDM field '${field}' not found in normalized SimConnect FDM payload`);
    }
  }

  const seen = new Set();
  const duplicates = [];
  for (const name of varNames) {
    if (seen.has(name)) duplicates.push(name);
    seen.add(name);
  }
  if (duplicates.length > 0) {
    throw new Error(`Duplicate variable names found: ${duplicates.join(', ')}`);
  }

  const gforceIdx = varNames.indexOf('gforce');
  const firstAssistIdx = varNames.indexOf('unlimitedFuel');
  if (gforceIdx === -1) throw new Error('gforce not found');
  if (firstAssistIdx === -1) throw new Error('unlimitedFuel not found');
  if (gforceIdx >= firstAssistIdx) {
    throw new Error(`gforce (${gforceIdx}) should come before unlimitedFuel (${firstAssistIdx})`);
  }

  const aoaIdx = varNames.indexOf('aoa');
  const machIdx = varNames.indexOf('mach');
  if (aoaIdx > 35) {
    throw new Error(`AOA at index ${aoaIdx} is too late (should be <= 35)`);
  }
  if (machIdx > 40) {
    throw new Error(`Mach at index ${machIdx} is too late (should be <= 40)`);
  }

  const cabinAltIdx = varNames.indexOf('cabinAltFt');
  if (cabinAltIdx === -1) throw new Error('cabinAltFt not found');
  if (cabinAltIdx > 45) {
    throw new Error(`Cabin altitude at index ${cabinAltIdx} is too late (should be <= 45 for reduced Rust SimVar caps)`);
  }

  const convectiveWeatherVars = ['precipRateMm', 'precipState', 'inCloud', 'densityAlt'];
  for (const varName of convectiveWeatherVars) {
    if (!varNames.includes(varName)) {
      throw new Error(`Convective weather variable '${varName}' not found in SIMCONNECT_VARS`);
    }
  }

  function testAssistNullHandling(unlimitedFuelRaw) {
    return unlimitedFuelRaw != null ? Boolean(unlimitedFuelRaw) : null;
  }
  assertEqual(testAssistNullHandling(1), true, 'unlimitedFuel=1 → true');
  assertEqual(testAssistNullHandling(0), false, 'unlimitedFuel=0 → false');
  assertEqual(testAssistNullHandling(null), null, 'unlimitedFuel=null → null');
  assertEqual(testAssistNullHandling(undefined), null, 'unlimitedFuel=undefined → null');

  const badPatterns = [
    /unlimitedFuel:\s*Boolean\(d\.unlimitedFuel\)/,
    /crashDetection:\s*Boolean\(d\.crashDetection\)/,
    /assistLanding:\s*Boolean\(d\.assistLanding\)/,
  ];
  for (const pattern of badPatterns) {
    if (pattern.test(providerCode)) {
      throw new Error('Found dangerous Boolean(d.xxx) pattern - use explicit null check instead');
    }
  }

  const def1Size = SPLIT_INDEX;
  const def2Size = varNames.length - SPLIT_INDEX;
  const SC_SOFT_LIMIT = 85;
  const SC_HARD_LIMIT = 80;
  if (def1Size > SC_SOFT_LIMIT) {
    throw new Error(`Definition 1 has ${def1Size} vars, exceeds practical ~${SC_SOFT_LIMIT} limit`);
  }
  if (def2Size > SC_HARD_LIMIT) {
    throw new Error(`Definition 2 has ${def2Size} vars, exceeds hard ~${SC_HARD_LIMIT} limit`);
  }
});

test('SimConnect scalar unit helpers keep bool, enum, and mask paths typed correctly', () => {
  assertEqual(_coerceSimConnectBool(true), true, 'true bool remains true');
  assertEqual(_coerceSimConnectBool(false), false, 'false bool remains false');
  assertEqual(_coerceSimConnectBool(1), true, 'numeric 1 bool is true');
  assertEqual(_coerceSimConnectBool(-1), true, 'non-zero numeric bool is true');
  assertEqual(_coerceSimConnectBool(0), false, 'numeric 0 bool is false');
  assertEqual(_coerceSimConnectBool('true'), true, 'string true bool is true');
  assertEqual(_coerceSimConnectBool('0'), false, 'string zero bool is false');
  assertEqual(_coerceSimConnectBool('not-a-bool'), null, 'unparseable bool stays null');

  assertEqual(_usesInt32SimConnectData('bool'), true, 'bool uses INT32');
  assertEqual(_usesInt32SimConnectData('enum'), true, 'enum uses INT32');
  assertEqual(_usesInt32SimConnectData('mask'), true, 'mask uses INT32');
  assertEqual(_usesInt32SimConnectData('knots'), false, 'floating units do not use INT32');

  assertEqual(_simConnectUnitString('bool'), 'Bool', 'bool unit string');
  assertEqual(_simConnectUnitString('enum'), 'Enum', 'enum unit string');
  assertEqual(_simConnectUnitString('mask'), 'Mask', 'mask unit string');
  assertEqual(_simConnectUnitString('knots'), 'knots', 'normal unit string');
});

test('Rust SimVar migration subscribes to TITLE as a Rust-only string readback', () => {
  const provider = new SimConnectTelemetryProvider();
  const subscriptions = provider._buildRustSimvarSubscriptions();
  const titleSubscription = subscriptions.find((item) => item.key === RUST_AIRCRAFT_TITLE_KEY);

  if (!titleSubscription) {
    throw new Error('Rust aircraft TITLE subscription missing');
  }
  assertEqual(titleSubscription.expression, 'TITLE', 'TITLE expression');
  assertEqual(titleSubscription.unit, '', 'TITLE string SimVar must register with an empty unit');
  assertEqual(titleSubscription.dataType, 'string256', 'TITLE data type');
  assertEqual(SIMCONNECT_VARS.some((item) => item.name === RUST_AIRCRAFT_TITLE_KEY), false, 'TITLE is not part of numeric SIMCONNECT_VARS');
});

test('Rust SimVar migration isolates optional diagnostics and enrichment from core definitions', () => {
  const provider = new SimConnectTelemetryProvider();
  const subscriptions = provider._buildRustSimvarSubscriptions();
  const diagnosticKeys = [
    'altCalibrated',
    'altPlane',
    'aircraftAgl',
    'aircraftAboveObstacles',
    'planeAgl',
    'planeAglMinusCg',
    'kohlsmanSettingMb',
    'kohlsmanTunedMb',
    'kohlsmanStd',
    'touchdownBankDeg',
    'touchdownHeadingMagDeg',
    'touchdownHeadingTrueDeg',
    'touchdownLatRad',
    'touchdownLonRad',
    'touchdownNormalVelocityFps',
    'touchdownPitchDeg',
  ];

  for (const key of diagnosticKeys) {
    const subscription = subscriptions.find((item) => item.key === key);
    assertEqual(subscription?.isolated, true, `${key} must have its own SimConnect definition`);
  }
  assertEqual(
    subscriptions.find((item) => item.key === 'cabinAltFt')?.isolated,
    false,
    'core cabin altitude remains in a shared definition',
  );
});

test('Rust SimVar TITLE snapshot updates aircraft display name without numeric telemetry', () => {
  const provider = new SimConnectTelemetryProvider();
  provider._handleRustSimvarSnapshot({
    values: {
      [RUST_AIRCRAFT_TITLE_KEY]: '  Fenix A320 CFM  ',
    },
    updatedAt: '2026-06-10T00:00:00Z',
  });

  assertEqual(provider._lastDetectedAircraftDisplayName, 'Fenix A320 CFM', 'Rust TITLE display name');
  assertEqual(provider._rustSimvarUpdatedAt, '2026-06-10T00:00:00Z', 'Rust title-only snapshot timestamp');
  assertEqual(Object.prototype.hasOwnProperty.call(provider._data, RUST_AIRCRAFT_TITLE_KEY), false, 'TITLE not copied into numeric frame data');
});

test('SimConnect provider preserves missing G-force and wind telemetry as unknown', async () => {
  const provider = new SimConnectTelemetryProvider();
  provider._data = {};

  const frame = await provider.nextFrame();

  assertEqual(frame.gforce, null, 'missing G FORCE must stay unknown');
  assertEqual(frame.fdm.gForce, null, 'normalized missing G FORCE must stay unknown');
  assertEqual(frame.windSpeed, null, 'missing wind speed must stay unknown');
  assertEqual(frame.windDir, null, 'missing wind direction must stay unknown');
  assertEqual(frame.gearConfigurationAvailable, false, 'missing gear channels must stay unavailable');
  assertEqual(frame.gearDownLocked, null, 'missing gear channels must not be invented as retracted');
  assertEqual(frame.flapsConfigurationAvailable, false, 'missing flap channels must stay unavailable');
});

test('SimConnect frame preserves the independent spoilers-armed readback', async () => {
  const provider = new SimConnectTelemetryProvider();
  provider._data = { spoilers: 0, spoilersArmed: 1 };

  const frame = await provider.nextFrame();

  assertEqual(frame.spoilers.armed, true, 'SPOILERS ARMED remains available beside normalized lever state');
  assertEqual(frame.spoilers.state, 'ARMED', 'the shared spoiler state remains consistent with the armed flag');
});

test('SimConnect frame keeps missing spoilers-armed telemetry unavailable', async () => {
  const provider = new SimConnectTelemetryProvider();
  provider._data = { spoilers: 0 };

  const frame = await provider.nextFrame();

  assertEqual(frame.spoilers.armed, null, 'missing SPOILERS ARMED must not be presented as disarmed');
  assertEqual(frame.spoilers.state, 'STOWED', 'surface deployment state can still use the known handle position');
});

test('MSFS Facilities probe warms the nearest local airport once SimConnect is live', async () => {
  const provider = new SimConnectTelemetryProvider();
  const requested = [];
  provider._rustSimvarBridge = {
    getSnapshot() {
      return { status: 'running' };
    },
  };
  provider._msfsFacilitiesGeometryProvider = {
    probeAirport(icao) {
      requested.push(icao);
      return Promise.resolve({ ok: true, icao, runways: [{ runway: '35' }] });
    },
    getDiagnosticSnapshot() {
      return {
        requestApi: true,
        bridgeStatus: 'running',
        cacheAirportCount: 0,
        cacheRunwayCount: 0,
        cachedIcaos: [],
        pendingIcaos: [],
        lastOutcome: null,
      };
    },
  };
  provider._data = {
    lat: -35.307,
    lon: 149.194,
  };

  await provider._runMsfsFacilitiesProbeTick('test');

  assertEqual(requested.includes('YSCB'), true, 'Facilities probe should request the nearest local airport ICAO');
});

test('MSFS Facilities probe passes a bounded diagnostic timeout', async () => {
  const provider = new SimConnectTelemetryProvider();
  let seenTimeoutMs = null;
  provider._rustSimvarBridge = {
    getSnapshot() {
      return { status: 'running' };
    },
  };
  provider._msfsFacilitiesGeometryProvider = {
    probeAirport(_icao, options) {
      seenTimeoutMs = options?.timeoutMs ?? null;
      return Promise.resolve({ ok: true, icao: 'YSCB', runways: [{ runway: '35' }] });
    },
    getDiagnosticSnapshot() {
      return {
        requestApi: true,
        bridgeStatus: 'running',
        cacheAirportCount: 0,
        cacheRunwayCount: 0,
        cachedIcaos: [],
        pendingIcaos: [],
        lastOutcome: null,
      };
    },
  };
  provider._data = {
    lat: -35.307,
    lon: 149.194,
  };

  await provider._runMsfsFacilitiesProbeTick('test');

  assertEqual(seenTimeoutMs, provider._getMsfsFacilitiesProbeTimeoutMs(), 'Facilities probe should use the diagnostic timeout');
});

test('MSFS Facilities probe backs off after a failed request', async () => {
  const provider = new SimConnectTelemetryProvider();
  let requestCount = 0;
  let lastOutcome = null;
  provider._rustSimvarBridge = {
    getSnapshot() {
      return { status: 'running' };
    },
  };
  provider._msfsFacilitiesGeometryProvider = {
    probeAirport() {
      requestCount += 1;
      lastOutcome = { ok: false, icao: 'YSCB', error: 'timeout' };
      return Promise.resolve(lastOutcome);
    },
    getDiagnosticSnapshot() {
      return {
        requestApi: true,
        bridgeStatus: 'running',
        cacheAirportCount: 0,
        cacheRunwayCount: 0,
        cachedIcaos: [],
        pendingIcaos: [],
        lastOutcome,
      };
    },
  };
  provider._data = {
    lat: -35.307,
    lon: 149.194,
  };

  await provider._runMsfsFacilitiesProbeTick('test');

  assertEqual(requestCount, 1, 'failed probe should issue one Facilities request');
  assertEqual(provider._msfsFacilitiesProbeConsecutiveFailures, 1, 'failed probe should increment failure count');
  if (!(provider._msfsFacilitiesProbePausedUntilMs > Date.now())) {
    throw new Error('failed probe should pause future diagnostic requests');
  }

  await provider._runMsfsFacilitiesProbeTick('test');

  assertEqual(requestCount, 1, 'backoff should prevent an immediate second Facilities request');
});

test('MSFS Facilities probe waits for a live bridge before requesting airports', () => {
  const provider = new SimConnectTelemetryProvider();
  let requestCount = 0;
  provider._rustSimvarBridge = {
    getSnapshot() {
      return { status: 'stopped' };
    },
  };
  provider._msfsFacilitiesGeometryProvider = {
    prefetchAirport() {
      requestCount += 1;
    },
    getDiagnosticSnapshot() {
      return {
        requestApi: true,
        bridgeStatus: 'stopped',
        cacheAirportCount: 0,
        cacheRunwayCount: 0,
      };
    },
  };
  provider._data = {
    lat: -35.307,
    lon: 149.194,
  };

  provider._runMsfsFacilitiesProbeTick('test');

  assertEqual(requestCount, 0, 'Facilities probe should not request while the bridge is stopped');
});

test('MSFS Facilities probe timer is cleared on stop', () => {
  const provider = new SimConnectTelemetryProvider();
  provider._msfsFacilitiesProbeTimer = setInterval(() => {}, 10000);
  provider._stopMsfsFacilitiesProbe();

  assertEqual(provider._msfsFacilitiesProbeTimer, null, 'probe timer should be cleared');
});

test('MSFS Facilities safe probe wrapper contains synchronous probe failures', () => {
  const provider = new SimConnectTelemetryProvider();
  provider._runMsfsFacilitiesProbeTick = () => {
    throw new Error('probe boom');
  };

  assertEqual(provider._safeRunMsfsFacilitiesProbeTick('test'), null, 'safe probe should fail closed');
});

test('aircraftChanged payload keeps config paths and display names explicit', () => {
  const payload = _buildAircraftChangedPayload({
    aircraftConfigPath: ' SimObjects\\Airplanes\\NEW\\aircraft.cfg ',
    displayName: ' New Aircraft ',
    previousAircraftConfigPath: ' SimObjects\\Airplanes\\OLD\\aircraft.cfg ',
    previousDisplayName: ' Old Aircraft ',
    reason: 'SystemState:AircraftLoaded',
    timestamp: '2026-06-10T00:00:00.000Z',
  });

  assertEqual(payload.title, 'SimObjects\\Airplanes\\NEW\\aircraft.cfg', 'legacy title should prefer cfg path');
  assertEqual(payload.displayName, 'New Aircraft', 'displayName should be trimmed');
  assertEqual(payload.aircraftConfigPath, 'SimObjects\\Airplanes\\NEW\\aircraft.cfg', 'explicit aircraftConfigPath');
  assertEqual(payload.previousTitle, 'SimObjects\\Airplanes\\OLD\\aircraft.cfg', 'legacy previousTitle should prefer cfg path');
  assertEqual(payload.previousDisplayName, 'Old Aircraft', 'explicit previousDisplayName');
  assertEqual(payload.previousAircraftConfigPath, 'SimObjects\\Airplanes\\OLD\\aircraft.cfg', 'explicit previousAircraftConfigPath');
});

test('aircraftChanged TITLE-only fallback marks config paths unavailable', () => {
  const payload = _buildAircraftChangedPayload({
    displayName: ' New Aircraft ',
    previousDisplayName: ' Old Aircraft ',
    reason: 'RustSimvar:TITLE',
    timestamp: '2026-06-10T00:00:00.000Z',
  });

  assertEqual(payload.title, 'New Aircraft', 'legacy title falls back to display name');
  assertEqual(payload.previousTitle, 'Old Aircraft', 'legacy previousTitle falls back to previous display name');
  assertEqual(payload.displayName, 'New Aircraft', 'explicit displayName');
  assertEqual(payload.previousDisplayName, 'Old Aircraft', 'explicit previousDisplayName');
  assertEqual(payload.aircraftConfigPath, null, 'TITLE-only fallback has no cfg path');
  assertEqual(payload.previousAircraftConfigPath, null, 'TITLE-only fallback has no previous cfg path');
});

test('executeAircraftControlAction rejects unsafe named-var payloads before the sidecar call', async () => {
  const provider = new SimConnectTelemetryProvider();
  const profileOptions = {
    profileKey: 'bundled/msfs/generic',
    profileRevision: 17,
  };
  provider._getActiveAircraftControlProfileGeneration = () => ({ ...profileOptions });
  let setNamedVarCalls = 0;
  provider._ensureControlWriteBridge = async () => ({
    getSnapshot() {
      return { source: 'mock-sidecar' };
    },
    async setNamedVar() {
      setNamedVarCalls += 1;
      return { ok: true };
    },
  });

  const hugeValue = await provider.executeAircraftControlAction({
    type: 'lvar',
    name: 'L:SAFE_TEST_VAR',
    unit: 'Number',
    value: 1_000_001,
  }, profileOptions);

  assertEqual(hugeValue.ok, false, 'huge named-var value should be rejected');
  assertEqual(hugeValue.code, 'invalid_value', 'huge named-var code');
  assertEqual(setNamedVarCalls, 0, 'huge value should not reach bridge');

  const unsafeName = await provider.executeAircraftControlAction({
    type: 'lvar',
    name: 'L:BAD;Remove-Item',
    unit: 'Number',
    value: 1,
  }, profileOptions);

  assertEqual(unsafeName.ok, false, 'unsafe named-var name should be rejected');
  assertEqual(unsafeName.code, 'invalid_action', 'unsafe name code');
  assertEqual(setNamedVarCalls, 0, 'unsafe name should not reach bridge');
});

test('executeAircraftControlAction rejects a profile change while awaiting the control bridge', async () => {
  const provider = new SimConnectTelemetryProvider();
  const requestedGeneration = {
    profileKey: 'bundled/msfs/generic',
    profileRevision: 23,
  };
  let activeGeneration = { ...requestedGeneration };
  let releaseBridge = () => {};
  let signalBridgeWait = () => {};
  const bridgeGate = new Promise<void>((resolve) => {
    releaseBridge = resolve;
  });
  const bridgeWaitStarted = new Promise<void>((resolve) => {
    signalBridgeWait = resolve;
  });
  let sendEventCalls = 0;
  provider._getActiveAircraftControlProfileGeneration = () => ({ ...activeGeneration });
  provider._ensureControlWriteBridge = async () => {
    signalBridgeWait();
    await bridgeGate;
    return {
      getSnapshot() {
        return { source: 'mock-sidecar' };
      },
      async sendEvent() {
        sendEventCalls += 1;
        return { ok: true };
      },
    };
  };

  const pendingResult = provider.executeAircraftControlAction({
    type: 'key-event',
    name: 'BEACON_LIGHTS_ON',
  }, requestedGeneration);
  await bridgeWaitStarted;
  activeGeneration = {
    profileKey: requestedGeneration.profileKey,
    profileRevision: requestedGeneration.profileRevision + 1,
  };
  releaseBridge();

  const result = await pendingResult;
  assertEqual(result.ok, false, 'stale profile generation should fail closed');
  assertEqual(result.code, 'stale_profile', 'stale profile generation code');
  assertEqual(result.backendSource, 'mock-sidecar', 'stale result identifies the ready bridge');
  assertEqual(sendEventCalls, 0, 'stale request must not reach the native bridge');
});

test('executeAircraftControlAction dispatches when the post-bridge profile generation still matches', async () => {
  const provider = new SimConnectTelemetryProvider();
  const profileOptions = {
    profileKey: 'bundled/msfs/generic',
    profileRevision: 29,
  };
  const sendEventCalls = [];
  provider._getActiveAircraftControlProfileGeneration = () => ({ ...profileOptions });
  provider._ensureControlWriteBridge = async () => ({
    getSnapshot() {
      return { source: 'mock-sidecar' };
    },
    async sendEvent(name, value, parameters) {
      sendEventCalls.push({ name, value, parameters });
      return { ok: true };
    },
  });

  const result = await provider.executeAircraftControlAction({
    type: 'key-event',
    name: 'HEADING_BUG_SET',
    value: 275,
    parameters: [0],
  }, profileOptions);

  assertEqual(result.ok, true, 'matching profile generation should dispatch');
  assertDeepEqual(sendEventCalls, [{
    name: 'HEADING_BUG_SET',
    value: 275,
    parameters: [0],
  }], 'matching multi-parameter request should reach the native bridge once');
});

test('executeAircraftControlAction rejects key events that exceed the native five-parameter contract', async () => {
  const provider = new SimConnectTelemetryProvider();
  const profileOptions = {
    profileKey: 'bundled/msfs/generic',
    profileRevision: 30,
  };
  let sendEventCalls = 0;
  provider._getActiveAircraftControlProfileGeneration = () => ({ ...profileOptions });
  provider._ensureControlWriteBridge = async () => ({
    getSnapshot() {
      return { source: 'mock-sidecar' };
    },
    async sendEvent() {
      sendEventCalls += 1;
      return { ok: true };
    },
  });

  const result = await provider.executeAircraftControlAction({
    type: 'key-event',
    name: 'HEADING_BUG_SET',
    value: 275,
    parameters: [0, 1, 2, 3, 4],
  }, profileOptions);

  assertEqual(result.ok, false, 'too many additional event parameters should fail closed');
  assertEqual(result.code, 'invalid_value', 'oversized event parameter payload code');
  assertEqual(sendEventCalls, 0, 'invalid event parameters must not reach the native bridge');
});

test('TriStar AFCS pulses serialize physical controls and enforce a profile-scoped cooldown', async () => {
  const provider = new SimConnectTelemetryProvider();
  const tristarOptions = {
    profileKey: 'bundled/msfs/inibuilds-tristar',
    profileRevision: 31,
  };
  let activeGeneration = { ...tristarOptions };
  let releaseFirstEvent = () => {};
  let signalFirstEvent = () => {};
  const firstEventGate = new Promise<void>((resolve) => {
    releaseFirstEvent = resolve;
  });
  const firstEventStarted = new Promise<void>((resolve) => {
    signalFirstEvent = resolve;
  });
  const events: string[] = [];
  provider._getActiveAircraftControlProfileGeneration = () => ({ ...activeGeneration });
  provider._ensureControlWriteBridge = async () => ({
    getSnapshot() {
      return { source: 'mock-sidecar' };
    },
    async sendEvent(name) {
      events.push(name);
      if (events.length === 1) {
        signalFirstEvent();
        await firstEventGate;
      }
      return { ok: true };
    },
  });

  const firstMaster = provider.executeAircraftControlAction({
    type: 'key-event',
    name: 'AP_MASTER',
  }, tristarOptions);
  await firstEventStarted;

  const concurrentDisconnect = await provider.executeAircraftControlAction({
    type: 'key-event',
    name: 'AUTOPILOT_OFF',
  }, tristarOptions);
  assertEqual(concurrentDisconnect.ok, false, 'AP disconnect must not race AP A');
  assertEqual(concurrentDisconnect.code, 'action_in_flight', 'shared physical AP group rejects concurrent pulse');
  assertEqual(concurrentDisconnect.executionStarted, undefined, 'an in-flight guard fails before native dispatch');
  assertEqual(events.length, 1, 'concurrent shared-group request never reaches SimConnect');

  releaseFirstEvent();
  assertEqual((await firstMaster).ok, true, 'first AP A pulse should complete');

  const duplicateMaster = await provider.executeAircraftControlAction({
    type: 'key-event',
    name: 'AP_MASTER',
  }, tristarOptions);
  assertEqual(duplicateMaster.ok, false, 'rapid duplicate AP A pulse must fail closed');
  assertEqual(duplicateMaster.code, 'action_cooldown', 'rapid duplicate reports cooldown');
  assertEqual(duplicateMaster.executionStarted, undefined, 'a cooldown rejection does not claim an aircraft write');
  assertEqual(events.length, 1, 'cooldown request never reaches SimConnect');

  const distinctHeading = await provider.executeAircraftControlAction({
    type: 'key-event',
    name: 'AP_HDG_HOLD',
  }, tristarOptions);
  assertEqual(distinctHeading.ok, true, 'a distinct AFCS physical button keeps its own group');
  assertEqual(events.length, 2, 'distinct AFCS pulse reaches SimConnect once');

  const otherProfileOptions = {
    profileKey: 'bundled/msfs/fenix-a320',
    profileRevision: 32,
  };
  activeGeneration = { ...otherProfileOptions };
  const otherFirst = await provider.executeAircraftControlAction({
    type: 'key-event',
    name: 'AP_MASTER',
  }, otherProfileOptions);
  const otherSecond = await provider.executeAircraftControlAction({
    type: 'key-event',
    name: 'AP_MASTER',
  }, otherProfileOptions);
  assertEqual(otherFirst.ok, true, 'other profiles retain their existing AP behavior');
  assertEqual(otherSecond.ok, true, 'TriStar cooldown does not leak into other profiles');
  assertEqual(events.length, 4, 'both non-TriStar calls reach SimConnect');
});

const FBW_A32NX_PROFILE_KEY = 'bundled/msfs/fbw-a32nx';
const FBW_A32NX_PROFILE_REVISION = 19;
const FBW_A32NX_ADAPTER_ID = 'fbw-a32nx';

function stubFbwA32nxStrobeFields(provider) {
  const fields = {
    'lights.strobeActive': {
      id: 'lights.strobeActive',
      source: { type: 'lvar', key: 'fbw_strobe_active' },
      decode: { type: 'boolean', trueValues: [1], falseValues: [0] },
    },
    'lights.strobeAuto': {
      id: 'lights.strobeAuto',
      source: { type: 'lvar', key: 'fbw_strobe_auto' },
      decode: { type: 'boolean', trueValues: [1], falseValues: [0] },
    },
    'systems.apuStart': {
      id: 'systems.apuStart',
      source: { type: 'lvar', key: 'fbw_apu_start' },
      decode: { type: 'boolean', trueValues: [1], falseValues: [0] },
    },
    'systems.engineBleed1': {
      id: 'systems.engineBleed1',
      source: { type: 'lvar', key: 'fbw_engine_bleed_1' },
      decode: { type: 'boolean', trueValues: [1], falseValues: [0] },
    },
    'propulsion.throttleLever1Angle': {
      id: 'propulsion.throttleLever1Angle',
      source: { type: 'lvar', key: 'fbw_throttle_1' },
      decode: { type: 'number', precision: 2 },
    },
    'propulsion.throttleLever2Angle': {
      id: 'propulsion.throttleLever2Angle',
      source: { type: 'lvar', key: 'fbw_throttle_2' },
      decode: { type: 'number', precision: 2 },
    },
    'lights.beacon': {
      id: 'lights.beacon',
      source: { type: 'simvar', name: 'LIGHT BEACON', path: 'lights.beacon' },
      decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
    },
    'lights.wing': {
      id: 'lights.wing',
      source: { type: 'simvar', name: 'LIGHT WING', path: 'lights.wing' },
      decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
    },
    'lights.nav': {
      id: 'lights.nav',
      source: { type: 'simvar', name: 'LIGHT NAV', path: 'lights.nav' },
      decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
    },
    'lights.logo': {
      id: 'lights.logo',
      source: { type: 'simvar', name: 'LIGHT LOGO', path: 'lights.logo' },
      decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
    },
  };
  provider._getActiveAircraftIntegrationConfig = (profileKey, adapterId, profileRevision) => (
    profileKey === FBW_A32NX_PROFILE_KEY
    && adapterId === FBW_A32NX_ADAPTER_ID
    && profileRevision === FBW_A32NX_PROFILE_REVISION
      ? { profileKey, integrationId: adapterId, profileRevision }
      : null
  );
  provider._getAircraftIntegrationFieldConfig = (profileKey, adapterId, fieldId, profileRevision) => (
    profileKey === FBW_A32NX_PROFILE_KEY
    && adapterId === FBW_A32NX_ADAPTER_ID
    && profileRevision === FBW_A32NX_PROFILE_REVISION
      ? fields[fieldId] || null
      : null
  );
}

const FENIX_A320_PROFILE_KEY = 'bundled/msfs/fenix-a320';
const FENIX_A320_PROFILE_REVISION = 23;
const FENIX_A32X_ADAPTER_ID = 'fenix-a32x';

function fenixA320IntegrationOptions(actionId, value = undefined) {
  return {
    profileKey: FENIX_A320_PROFILE_KEY,
    profileRevision: FENIX_A320_PROFILE_REVISION,
    request: { actionId, ...(value === undefined ? {} : { value }) },
  };
}

function stubFenixA320IntegrationFields(provider) {
  const fields = {
    'lights.beacon': {
      id: 'lights.beacon',
      source: { type: 'lvar', key: 'fenix_beacon' },
      decode: { type: 'boolean', trueValues: [1], falseValues: [0] },
    },
    'flightGuidance.ap1': {
      id: 'flightGuidance.ap1',
      source: { type: 'lvar', key: 'fenix_ap1' },
      decode: { type: 'boolean', trueValues: [1], falseValues: [0] },
    },
    'flightGuidance.speedValue': {
      id: 'flightGuidance.speedValue',
      source: { type: 'lvar', key: 'fenix_speed' },
      decode: { type: 'number', precision: 2 },
    },
    'flightGuidance.speedManaged': {
      id: 'flightGuidance.speedManaged',
      source: { type: 'lvar', key: 'fenix_speed_managed' },
      decode: { type: 'boolean', trueValues: [1], falseValues: [0] },
    },
    'flightGuidance.headingDeg': {
      id: 'flightGuidance.headingDeg',
      source: { type: 'lvar', key: 'fenix_heading' },
      decode: { type: 'number', precision: 0 },
    },
    'flightGuidance.altitudeFt': {
      id: 'flightGuidance.altitudeFt',
      source: { type: 'lvar', key: 'fenix_altitude' },
      decode: { type: 'number', precision: 0 },
    },
    'flightGuidance.altitudeIncrementMode': {
      id: 'flightGuidance.altitudeIncrementMode',
      source: { type: 'lvar', key: 'fenix_altitude_scale' },
      decode: { type: 'enum', values: { 0: 'thousand', 1: 'hundred' } },
    },
    'propulsion.throttleLever1Position': {
      id: 'propulsion.throttleLever1Position',
      source: { type: 'lvar', key: 'fenix_throttle_left' },
      decode: { type: 'number', precision: 2 },
    },
    'propulsion.throttleLever2Position': {
      id: 'propulsion.throttleLever2Position',
      source: { type: 'lvar', key: 'fenix_throttle_right' },
      decode: { type: 'number', precision: 2 },
    },
  };
  provider._getActiveAircraftIntegrationConfig = (profileKey, adapterId, profileRevision) => (
    profileKey === FENIX_A320_PROFILE_KEY
    && adapterId === FENIX_A32X_ADAPTER_ID
    && profileRevision === FENIX_A320_PROFILE_REVISION
      ? { profileKey, integrationId: adapterId, profileRevision }
      : null
  );
  provider._getAircraftIntegrationFieldConfig = (profileKey, adapterId, fieldId, profileRevision) => (
    profileKey === FENIX_A320_PROFILE_KEY
    && adapterId === FENIX_A32X_ADAPTER_ID
    && profileRevision === FENIX_A320_PROFILE_REVISION
      ? fields[fieldId] || null
      : null
  );
}

function assertDeepEqual(actual, expected, msg) {
  deepStrictEqual(actual, expected, msg);
}

const INIBUILDS_TRISTAR_PROFILE_KEY = 'bundled/msfs/inibuilds-tristar';
const INIBUILDS_TRISTAR_PROFILE_REVISION = 31;
const INIBUILDS_TRISTAR_ADAPTER_ID = 'inibuilds-tristar';

function tristarIntegrationOptions(actionId, value = undefined) {
  return {
    profileKey: INIBUILDS_TRISTAR_PROFILE_KEY,
    profileRevision: INIBUILDS_TRISTAR_PROFILE_REVISION,
    request: { actionId, ...(value === undefined ? {} : { value }) },
  };
}

function stubTriStarIntegrationFields(provider) {
  const fields = {
    'lights.beacon': {
      id: 'lights.beacon',
      source: { type: 'simvar', name: 'LIGHT BEACON', path: 'lights.beacon' },
      decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
    },
    'lights.logo': {
      id: 'lights.logo',
      source: { type: 'simvar', name: 'LIGHT LOGO', path: 'lights.logo' },
      decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
    },
  };
  provider._getActiveAircraftIntegrationConfig = (profileKey, adapterId, profileRevision) => (
    profileKey === INIBUILDS_TRISTAR_PROFILE_KEY
    && adapterId === INIBUILDS_TRISTAR_ADAPTER_ID
    && profileRevision === INIBUILDS_TRISTAR_PROFILE_REVISION
      ? { profileKey, integrationId: adapterId, profileRevision }
      : null
  );
  provider._getAircraftIntegrationFieldConfig = (profileKey, adapterId, fieldId, profileRevision) => (
    profileKey === INIBUILDS_TRISTAR_PROFILE_KEY
    && adapterId === INIBUILDS_TRISTAR_ADAPTER_ID
    && profileRevision === INIBUILDS_TRISTAR_PROFILE_REVISION
      ? fields[fieldId] || null
      : null
  );
}

const INIBUILDS_A330_PROFILE_KEY = 'bundled/msfs/inibuilds-a330';
const INIBUILDS_A330_PROFILE_REVISION = 37;
const INIBUILDS_A330_ADAPTER_ID = 'inibuilds-a330';
const FBW_A380X_PROFILE_KEY = 'bundled/msfs/fbw-a380x';
const FBW_A380X_PROFILE_REVISION = 41;
const FBW_A380X_ADAPTER_ID = 'fbw-a380x';
const MICROSOFT_INIBUILDS_A320_PROFILE_KEY = 'bundled/msfs/inibuilds-a320neo-v2';
const MICROSOFT_INIBUILDS_A321_PROFILE_KEY = 'bundled/msfs/inibuilds-a321lr';
const MICROSOFT_INIBUILDS_A32X_PROFILE_REVISION = 43;
const MICROSOFT_INIBUILDS_A32X_ADAPTER_ID = 'microsoft-inibuilds-a32x';
const MICROSOFT_737_MAX_8_PROFILE_KEY = 'bundled/msfs/microsoft-737-max-8';
const MICROSOFT_737_MAX_8_PROFILE_REVISION = 47;
const MICROSOFT_737_MAX_8_ADAPTER_ID = 'microsoft-737-max-8';

function inibuildsA330IntegrationOptions(actionId, value = undefined) {
  return {
    profileKey: INIBUILDS_A330_PROFILE_KEY,
    profileRevision: INIBUILDS_A330_PROFILE_REVISION,
    request: { actionId, ...(value === undefined ? {} : { value }) },
  };
}

function stubIniBuildsA330IntegrationFields(provider, fields) {
  provider._getActiveAircraftIntegrationConfig = (profileKey, adapterId, profileRevision) => (
    profileKey === INIBUILDS_A330_PROFILE_KEY
    && adapterId === INIBUILDS_A330_ADAPTER_ID
    && profileRevision === INIBUILDS_A330_PROFILE_REVISION
      ? { profileKey, integrationId: adapterId, profileRevision }
      : null
  );
  provider._getAircraftIntegrationFieldConfig = (profileKey, adapterId, fieldId, profileRevision) => (
    profileKey === INIBUILDS_A330_PROFILE_KEY
    && adapterId === INIBUILDS_A330_ADAPTER_ID
    && profileRevision === INIBUILDS_A330_PROFILE_REVISION
      ? fields[fieldId] || null
      : null
  );
}

function fbwA380xIntegrationOptions(actionId, value = undefined) {
  return {
    profileKey: FBW_A380X_PROFILE_KEY,
    profileRevision: FBW_A380X_PROFILE_REVISION,
    request: { actionId, ...(value === undefined ? {} : { value }) },
  };
}

function stubFbwA380xIntegrationFields(provider, fields) {
  provider._getActiveAircraftIntegrationConfig = (profileKey, adapterId, profileRevision) => (
    profileKey === FBW_A380X_PROFILE_KEY
    && adapterId === FBW_A380X_ADAPTER_ID
    && profileRevision === FBW_A380X_PROFILE_REVISION
      ? { profileKey, integrationId: adapterId, profileRevision }
      : null
  );
  provider._getAircraftIntegrationFieldConfig = (profileKey, adapterId, fieldId, profileRevision) => (
    profileKey === FBW_A380X_PROFILE_KEY
    && adapterId === FBW_A380X_ADAPTER_ID
    && profileRevision === FBW_A380X_PROFILE_REVISION
      ? fields[fieldId] || null
      : null
  );
}

function microsoftIniBuildsA32xIntegrationOptions(profileKey, actionId, value = undefined) {
  return {
    profileKey,
    profileRevision: MICROSOFT_INIBUILDS_A32X_PROFILE_REVISION,
    request: { actionId, ...(value === undefined ? {} : { value }) },
  };
}

function stubMicrosoftIniBuildsA32xIntegrationFields(provider, profileKey, fields) {
  provider._getActiveAircraftIntegrationConfig = (requestedProfileKey, adapterId, profileRevision) => (
    requestedProfileKey === profileKey
    && adapterId === MICROSOFT_INIBUILDS_A32X_ADAPTER_ID
    && profileRevision === MICROSOFT_INIBUILDS_A32X_PROFILE_REVISION
      ? { profileKey, integrationId: adapterId, profileRevision }
      : null
  );
  provider._getAircraftIntegrationFieldConfig = (
    requestedProfileKey,
    adapterId,
    fieldId,
    profileRevision,
  ) => (
    requestedProfileKey === profileKey
    && adapterId === MICROSOFT_INIBUILDS_A32X_ADAPTER_ID
    && profileRevision === MICROSOFT_INIBUILDS_A32X_PROFILE_REVISION
      ? fields[fieldId] || null
      : null
  );
}

function microsoft737Max8IntegrationOptions(actionId, value = undefined) {
  return {
    profileKey: MICROSOFT_737_MAX_8_PROFILE_KEY,
    profileRevision: MICROSOFT_737_MAX_8_PROFILE_REVISION,
    request: { actionId, ...(value === undefined ? {} : { value }) },
  };
}

function stubMicrosoft737Max8IntegrationFields(provider, fields) {
  provider._getActiveAircraftIntegrationConfig = (profileKey, adapterId, profileRevision) => (
    profileKey === MICROSOFT_737_MAX_8_PROFILE_KEY
    && adapterId === MICROSOFT_737_MAX_8_ADAPTER_ID
    && profileRevision === MICROSOFT_737_MAX_8_PROFILE_REVISION
      ? { profileKey, integrationId: adapterId, profileRevision }
      : null
  );
  provider._getAircraftIntegrationFieldConfig = (profileKey, adapterId, fieldId, profileRevision) => (
    profileKey === MICROSOFT_737_MAX_8_PROFILE_KEY
    && adapterId === MICROSOFT_737_MAX_8_ADAPTER_ID
    && profileRevision === MICROSOFT_737_MAX_8_PROFILE_REVISION
      ? fields[fieldId] || null
      : null
  );
}

test('iniBuilds A330 typed FCU target forwards the managed index and requires exact newer readback', async () => {
  const provider = new SimConnectTelemetryProvider();
  const rustSnapshot: any = {
    status: 'running',
    updatedAt: new Date().toISOString(),
  };
  const events = [];
  provider._data = { apHdgTargetDeg: 180 };
  provider._rustSimvarSnapshotSequence = 4;
  provider._rustSimvarBridge = { getSnapshot: () => rustSnapshot };
  const bridge = {
    _started: true,
    getSnapshot: () => ({ source: 'mock-sidecar' }),
    async setNamedVar() {
      return { ok: true };
    },
    async sendEvent(name, value, parameters) {
      events.push({ name, value, parameters });
      provider._data.apHdgTargetDeg = value;
      provider._rustSimvarSnapshotSequence += 1;
      rustSnapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  stubIniBuildsA330IntegrationFields(provider, {
    'flightGuidance.headingDeg': {
      id: 'flightGuidance.headingDeg',
      source: {
        type: 'simvar',
        name: 'AUTOPILOT HEADING LOCK DIR',
        path: 'fdm.apHdgTargetDeg',
      },
      decode: { type: 'number', precision: 0 },
    },
  });

  const action = {
    type: 'aircraft-integration',
    name: INIBUILDS_A330_ADAPTER_ID,
    verification: 'untested',
  };
  const result = await provider.executeAircraftControlAction(
    action,
    inibuildsA330IntegrationOptions('flightGuidance.heading.set', 273),
  );
  assertEqual(result.ok, true, 'typed A330 heading target should confirm');
  assertEqual(result.confirmedValue, 273, 'confirmation uses the exact requested heading');
  assertDeepEqual(events, [{
    name: 'HEADING_BUG_SET',
    value: 273,
    parameters: [0],
  }], 'the validated heading and fixed managed index dispatch once');

  const invalid = await provider.executeAircraftControlAction(
    action,
    inibuildsA330IntegrationOptions('flightGuidance.heading.set', 360),
  );
  assertEqual(invalid.ok, false, 'out-of-domain A330 heading should fail closed');
  assertEqual(invalid.code, 'invalid_value', 'invalid typed target retains its validation code');
  assertEqual(events.length, 1, 'invalid input never reaches SimConnect');
});

test('iniBuilds A330 light targets always dispatch despite a satisfied output readback', async () => {
  const provider = new SimConnectTelemetryProvider();
  const events = [];
  const bridge = {
    _started: true,
    getSnapshot: () => ({ source: 'mock-sidecar' }),
    async setNamedVar() {
      return { ok: true };
    },
    async sendEvent(name, value, parameters) {
      events.push({ name, value, parameters });
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  stubIniBuildsA330IntegrationFields(provider, {});
  provider._captureAircraftIntegrationReadback = () => ({
    observed: false,
    sequence: 7,
    fresh: true,
    sourceId: 'simvar:lightStates',
  });
  provider._waitForAircraftIntegrationReadback = async () => ({
    confirmed: true,
    observed: false,
    sequence: 8,
    fresh: true,
    sequenceAdvanced: true,
  });

  const result = await provider.executeAircraftControlAction({
    type: 'aircraft-integration',
    name: INIBUILDS_A330_ADAPTER_ID,
    verification: 'untested',
  }, inibuildsA330IntegrationOptions('lights.beacon.off'));

  assertEqual(result.ok, true, 'newer output readback should confirm the requested light state');
  assertEqual(result.noOp, undefined, 'output state alone must not suppress selector reconciliation');
  assertDeepEqual(events, [{
    name: 'BEACON_LIGHTS_SET',
    value: 0,
    parameters: [0],
  }], 'the deterministic light event dispatches exactly once');
});

test('FBW A380X altitude target writes and confirms the documented slot-three value only', async () => {
  const provider = new SimConnectTelemetryProvider();
  const snapshot: any = {
    source: 'mock-sidecar',
    profileId: FBW_A380X_PROFILE_KEY,
    values: { a380_altitude_slot_3: 12000 },
    snapshotSequence: 5,
    updatedAt: new Date().toISOString(),
  };
  const events = [];
  const bridge = {
    _started: true,
    getSnapshot: () => snapshot,
    async setNamedVar() {
      return { ok: true };
    },
    async sendEvent(name, value, parameters) {
      events.push({ name, value, parameters });
      snapshot.values.a380_altitude_slot_3 = value;
      snapshot.snapshotSequence += 1;
      snapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  stubFbwA380xIntegrationFields(provider, {
    'flightGuidance.altitudeFt': {
      id: 'flightGuidance.altitudeFt',
      source: { type: 'lvar', key: 'a380_altitude_slot_3' },
      decode: { type: 'number', precision: 0 },
    },
  });

  const action = {
    type: 'aircraft-integration',
    name: FBW_A380X_ADAPTER_ID,
    verification: 'untested',
  };
  const result = await provider.executeAircraftControlAction(
    action,
    fbwA380xIntegrationOptions('flightGuidance.altitude.set', 12300),
  );
  assertEqual(result.ok, true, 'A380X altitude should confirm against a fresh slot-three readback');
  assertEqual(result.confirmedValue, 12300, 'A380X altitude confirmation retains the exact requested target');
  assertDeepEqual(events, [{
    name: 'AP_ALT_VAR_SET_ENGLISH',
    value: 12300,
    parameters: [3],
  }], 'A380X altitude dispatch owns the fixed slot-three parameter');

  const invalid = await provider.executeAircraftControlAction(
    action,
    fbwA380xIntegrationOptions('flightGuidance.altitude.set', 12350),
  );
  assertEqual(invalid.ok, false, 'off-step A380X altitude targets fail closed');
  assertEqual(invalid.code, 'invalid_value', 'off-step altitude retains its validation error');
  assertEqual(events.length, 1, 'invalid A380X targets never reach SimConnect');
});

test('FBW A380X AP1 targets guard the vendor toggle with fresh logical readback', async () => {
  const provider = new SimConnectTelemetryProvider();
  const snapshot: any = {
    source: 'mock-sidecar',
    profileId: FBW_A380X_PROFILE_KEY,
    values: { a380_ap1: 0 },
    snapshotSequence: 9,
    updatedAt: new Date().toISOString(),
  };
  const events = [];
  const bridge = {
    _started: true,
    getSnapshot: () => snapshot,
    async setNamedVar() {
      return { ok: true };
    },
    async sendEvent(name, value, parameters) {
      events.push({ name, value, parameters });
      if (name === 'A32NX.FCU_AP_1_PUSH') {
        snapshot.values.a380_ap1 = snapshot.values.a380_ap1 ? 0 : 1;
      }
      snapshot.snapshotSequence += 1;
      snapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  stubFbwA380xIntegrationFields(provider, {
    'flightGuidance.ap1': {
      id: 'flightGuidance.ap1',
      source: { type: 'lvar', key: 'a380_ap1' },
      decode: { type: 'boolean', trueValues: [1], falseValues: [0] },
    },
  });

  const action = {
    type: 'aircraft-integration',
    name: FBW_A380X_ADAPTER_ID,
    verification: 'untested',
  };
  const alreadyOff = await provider.executeAircraftControlAction(
    action,
    fbwA380xIntegrationOptions('flightGuidance.ap1.off'),
  );
  assertEqual(alreadyOff.ok, true, 'fresh same-state AP1 OFF should succeed');
  assertEqual(alreadyOff.noOp, true, 'same-state AP1 OFF should be an explicit no-op');
  assertEqual(alreadyOff.idempotent, true, 'same-state AP1 OFF should retain idempotent diagnostics');
  assertEqual(events.length, 0, 'same-state AP1 OFF must not dispatch the vendor toggle event');

  const turnOn = await provider.executeAircraftControlAction(
    action,
    fbwA380xIntegrationOptions('flightGuidance.ap1.on'),
  );
  assertEqual(turnOn.ok, true, 'a newer A380X AP1 logical state should confirm the vendor AP1 push');
  assertEqual(turnOn.confirmedValue, true, 'AP1 confirmation should use the decoded A380X AP1 state');
  assertDeepEqual(events, [{
    name: 'A32NX.FCU_AP_1_PUSH',
    value: 0,
    parameters: [],
  }], 'A380X AP1 ON dispatches the vendor-documented toggle event exactly once');

  // The compact action owns AP1 only. It does not expose an independent AP2
  // channel and must not imply control over AP2.
  assertEqual(Object.prototype.hasOwnProperty.call(snapshot.values, 'a380_ap2'), false,
    'direct AP1 coverage must not fabricate an independent AP2 control channel');
});

for (const profileKey of [
  MICROSOFT_INIBUILDS_A320_PROFILE_KEY,
  MICROSOFT_INIBUILDS_A321_PROFILE_KEY,
]) {
  test(`${profileKey} typed heading target dispatches once and requires exact newer readback`, async () => {
    const provider = new SimConnectTelemetryProvider();
    const rustSnapshot: any = {
      status: 'running',
      updatedAt: new Date().toISOString(),
    };
    const events = [];
    provider._data = { apHdgTargetDeg: 180 };
    provider._rustSimvarSnapshotSequence = 2;
    provider._rustSimvarBridge = { getSnapshot: () => rustSnapshot };
    const bridge = {
      _started: true,
      getSnapshot: () => ({ source: 'mock-sidecar' }),
      async setNamedVar() {
        return { ok: true };
      },
      async sendEvent(name, value, parameters) {
        events.push({ name, value, parameters });
        provider._data.apHdgTargetDeg = value;
        provider._rustSimvarSnapshotSequence += 1;
        rustSnapshot.updatedAt = new Date().toISOString();
        return { ok: true };
      },
    };
    provider._lvarBridge = bridge;
    provider._ensureControlWriteBridge = async () => bridge;
    stubMicrosoftIniBuildsA32xIntegrationFields(provider, profileKey, {
      'fcu.headingDeg': {
        id: 'fcu.headingDeg',
        source: {
          type: 'simvar',
          name: 'AUTOPILOT HEADING LOCK DIR',
          path: 'fdm.apHdgTargetDeg',
        },
        decode: { type: 'number', precision: 0 },
      },
    });

    const action = {
      type: 'aircraft-integration',
      name: MICROSOFT_INIBUILDS_A32X_ADAPTER_ID,
      verification: 'untested',
    };
    const result = await provider.executeAircraftControlAction(
      action,
      microsoftIniBuildsA32xIntegrationOptions(profileKey, 'flightGuidance.heading.set', 271),
    );
    assertEqual(result.ok, true, `${profileKey} heading should confirm`);
    assertEqual(result.confirmedValue, 271, 'heading confirmation retains the exact target');
    assertDeepEqual(events, [{ name: 'HEADING_BUG_SET', value: 271, parameters: [0] }],
      'shared adapter dispatches one standard heading event');

    const invalid = await provider.executeAircraftControlAction(
      action,
      microsoftIniBuildsA32xIntegrationOptions(profileKey, 'flightGuidance.heading.set', 360),
    );
    assertEqual(invalid.ok, false, 'out-of-range shared A32x heading fails closed');
    assertEqual(invalid.code, 'invalid_value', 'invalid shared heading retains its validation code');
    assertEqual(events.length, 1, 'invalid shared heading never reaches SimConnect');
  });
}

for (const profileKey of [
  MICROSOFT_INIBUILDS_A320_PROFILE_KEY,
  MICROSOFT_INIBUILDS_A321_PROFILE_KEY,
]) {
  test(`${profileKey} fixed light intent dispatches despite a satisfied lamp output`, async () => {
    const provider = new SimConnectTelemetryProvider();
    const events = [];
    const bridge = {
      _started: true,
      getSnapshot: () => ({ source: 'mock-sidecar' }),
      async setNamedVar() {
        return { ok: true };
      },
      async sendEvent(name, value, parameters) {
        events.push({ name, value, parameters });
        return { ok: true };
      },
    };
    provider._lvarBridge = bridge;
    provider._ensureControlWriteBridge = async () => bridge;
    stubMicrosoftIniBuildsA32xIntegrationFields(provider, profileKey, {});

    const baseline = {
      observed: true,
      sequence: 14,
      fresh: true,
      sourceId: 'simvar:lightStates',
    };
    let confirmationCalls = 0;
    provider._captureAircraftIntegrationReadback = () => baseline;
    provider._waitForAircraftIntegrationReadback = async (_bridge, _readback, context, captured) => {
      confirmationCalls += 1;
      assertEqual(context.profileKey, profileKey, 'light confirmation stays on the requested family profile');
      assertEqual(captured, baseline, 'light confirmation retains the satisfied pre-dispatch baseline');
      return {
        confirmed: true,
        observed: true,
        sequence: 15,
        fresh: true,
        sequenceAdvanced: true,
      };
    };

    const result = await provider.executeAircraftControlAction({
      type: 'aircraft-integration',
      name: MICROSOFT_INIBUILDS_A32X_ADAPTER_ID,
      verification: 'untested',
    }, microsoftIniBuildsA32xIntegrationOptions(profileKey, 'lights.nav.on'));

    assertEqual(result.ok, true, 'a newer matching lamp output should confirm fixed NAV light ON');
    assertEqual(result.noOp, undefined,
      'skipIfSatisfied false must prevent a satisfied lamp output from suppressing selector reconciliation');
    assertEqual(result.confirmedValue, true, 'the newer logical lamp output confirms the fixed intent');
    assertEqual(confirmationCalls, 1, 'the dispatched light intent waits for one newer readback confirmation');
    assertDeepEqual(events, [{
      name: 'NAV_LIGHTS_SET',
      value: 1,
      parameters: [0],
    }], 'the shared A32x fixed NAV light intent dispatches exactly once');
  });
}

test('Microsoft 737 MAX 8 typed MCP target dispatches once and requires exact newer readback', async () => {
  const provider = new SimConnectTelemetryProvider();
  const rustSnapshot: any = {
    status: 'running',
    updatedAt: new Date().toISOString(),
  };
  const events = [];
  provider._data = { apAltTargetFt: 12000 };
  provider._rustSimvarSnapshotSequence = 6;
  provider._rustSimvarBridge = { getSnapshot: () => rustSnapshot };
  const bridge = {
    _started: true,
    getSnapshot: () => ({ source: 'mock-sidecar' }),
    async setNamedVar() {
      return { ok: true };
    },
    async sendEvent(name, value, parameters) {
      events.push({ name, value, parameters });
      provider._data.apAltTargetFt = value;
      provider._rustSimvarSnapshotSequence += 1;
      rustSnapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  stubMicrosoft737Max8IntegrationFields(provider, {
    'mcp.altitudeFt': {
      id: 'mcp.altitudeFt',
      source: {
        type: 'simvar',
        name: 'AUTOPILOT ALTITUDE LOCK VAR',
        path: 'fdm.apAltTargetFt',
      },
      decode: { type: 'number', precision: 0 },
    },
  });

  const action = {
    type: 'aircraft-integration',
    name: MICROSOFT_737_MAX_8_ADAPTER_ID,
    verification: 'untested',
  };
  const result = await provider.executeAircraftControlAction(
    action,
    microsoft737Max8IntegrationOptions('flightGuidance.altitude.set', 12300),
  );
  assertEqual(result.ok, true, 'a fresh exact MAX altitude target should confirm');
  assertEqual(result.confirmedValue, 12300, 'MAX altitude confirmation retains the exact requested target');
  assertDeepEqual(events, [{
    name: 'AP_ALT_VAR_SET_ENGLISH',
    value: 12300,
    parameters: [0],
  }], 'the bounded MAX altitude target dispatches exactly once');

  const invalid = await provider.executeAircraftControlAction(
    action,
    microsoft737Max8IntegrationOptions('flightGuidance.altitude.set', 12350),
  );
  assertEqual(invalid.ok, false, 'off-step MAX altitude targets fail closed');
  assertEqual(invalid.code, 'invalid_value', 'off-step MAX altitude retains its validation code');
  assertEqual(events.length, 1, 'invalid MAX targets never reach SimConnect');
});

test('Microsoft 737 MAX 8 NAV light dispatches despite satisfied output and requires newer confirmation', async () => {
  const provider = new SimConnectTelemetryProvider();
  const events = [];
  const bridge = {
    _started: true,
    getSnapshot: () => ({ source: 'mock-sidecar' }),
    async setNamedVar() {
      return { ok: true };
    },
    async sendEvent(name, value, parameters) {
      events.push({ name, value, parameters });
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  stubMicrosoft737Max8IntegrationFields(provider, {});

  const baseline = {
    observed: true,
    sequence: 18,
    fresh: true,
    sourceId: 'simvar:lightStates',
  };
  let confirmationCalls = 0;
  provider._captureAircraftIntegrationReadback = () => baseline;
  provider._waitForAircraftIntegrationReadback = async (_bridge, _readback, context, captured) => {
    confirmationCalls += 1;
    assertEqual(context.profileKey, MICROSOFT_737_MAX_8_PROFILE_KEY,
      'MAX light confirmation remains bound to the exact bundled profile');
    assertEqual(captured, baseline, 'MAX light confirmation retains the satisfied pre-dispatch baseline');
    return {
      confirmed: true,
      observed: true,
      sequence: 19,
      fresh: true,
      sequenceAdvanced: true,
    };
  };

  const result = await provider.executeAircraftControlAction({
    type: 'aircraft-integration',
    name: MICROSOFT_737_MAX_8_ADAPTER_ID,
    verification: 'untested',
  }, microsoft737Max8IntegrationOptions('lights.nav.on'));

  assertEqual(result.ok, true, 'a newer matching MAX lamp output should confirm fixed NAV light ON');
  assertEqual(result.noOp, undefined,
    'skipIfSatisfied false must not suppress the MAX NAV light selector reconciliation');
  assertEqual(result.confirmedValue, true, 'the newer MAX lamp output confirms the fixed intent');
  assertEqual(confirmationCalls, 1, 'the MAX light intent waits for one newer confirmation');
  assertDeepEqual(events, [{
    name: 'NAV_LIGHTS_SET',
    value: 1,
    parameters: [0],
  }], 'the fixed MAX NAV light intent dispatches exactly once');
});

test('Microsoft 737 MAX 8 FLC targets no-op on same state and confirm standard events with newer readback', async () => {
  const provider = new SimConnectTelemetryProvider();
  const rustSnapshot: any = {
    status: 'running',
    updatedAt: new Date().toISOString(),
  };
  const events = [];
  provider._data = { apFlcHold: false };
  provider._rustSimvarSnapshotSequence = 11;
  provider._rustSimvarBridge = { getSnapshot: () => rustSnapshot };
  const bridge = {
    _started: true,
    getSnapshot: () => ({ source: 'mock-sidecar' }),
    async setNamedVar() {
      return { ok: true };
    },
    async sendEvent(name, value, parameters) {
      events.push({ name, value, parameters });
      if (name === 'FLIGHT_LEVEL_CHANGE_ON') provider._data.apFlcHold = true;
      if (name === 'FLIGHT_LEVEL_CHANGE_OFF') provider._data.apFlcHold = false;
      provider._rustSimvarSnapshotSequence += 1;
      rustSnapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  stubMicrosoft737Max8IntegrationFields(provider, {
    'afds.levelChange': {
      id: 'afds.levelChange',
      source: {
        type: 'simvar',
        name: 'AUTOPILOT FLIGHT LEVEL CHANGE',
        path: 'fdm.apFlcHold',
      },
      decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
    },
  });

  const action = {
    type: 'aircraft-integration',
    name: MICROSOFT_737_MAX_8_ADAPTER_ID,
    verification: 'untested',
  };
  const alreadyOff = await provider.executeAircraftControlAction(
    action,
    microsoft737Max8IntegrationOptions('flightGuidance.flightLevelChange.off'),
  );
  assertEqual(alreadyOff.ok, true, 'fresh same-state MAX FLC OFF should succeed');
  assertEqual(alreadyOff.noOp, true, 'same-state MAX FLC OFF should be an explicit no-op');
  assertEqual(alreadyOff.idempotent, true, 'same-state MAX FLC OFF retains idempotent diagnostics');
  assertEqual(events.length, 0, 'same-state MAX FLC OFF must not dispatch');

  const turnOn = await provider.executeAircraftControlAction(
    action,
    microsoft737Max8IntegrationOptions('flightGuidance.flightLevelChange.on'),
  );
  assertEqual(turnOn.ok, true, 'a newer MAX FLC state should confirm standard FLC ON');
  assertEqual(turnOn.confirmedValue, true, 'MAX FLC ON confirmation uses decoded standard state');

  // Exercise the opposite fixed target as a separate settled request without
  // adding wall-clock delay to the test.
  provider._aircraftIntegrationActionLastAttemptAt.clear();
  const turnOff = await provider.executeAircraftControlAction(
    action,
    microsoft737Max8IntegrationOptions('flightGuidance.flightLevelChange.off'),
  );
  assertEqual(turnOff.ok, true, 'a newer MAX FLC state should confirm standard FLC OFF');
  assertEqual(turnOff.confirmedValue, false, 'MAX FLC OFF confirmation uses decoded standard state');
  assertDeepEqual(events, [{
    name: 'FLIGHT_LEVEL_CHANGE_ON',
    value: 0,
    parameters: [],
  }, {
    name: 'FLIGHT_LEVEL_CHANGE_OFF',
    value: 0,
    parameters: [],
  }], 'unsatisfied MAX FLC targets dispatch each standard event exactly once');
});

test('Microsoft 737 MAX 8 toggle-only FD and A/T targets stay bound to exact events and newer readbacks', async () => {
  for (const {
    actionPrefix,
    dataKey,
    eventName,
    fieldId,
    path,
    simvarName,
  } of [
    {
      actionPrefix: 'flightGuidance.flightDirector',
      dataKey: 'apFdActive',
      eventName: 'TOGGLE_FLIGHT_DIRECTOR',
      fieldId: 'afds.flightDirector',
      path: 'fdm.apFdActive',
      simvarName: 'AUTOPILOT FLIGHT DIRECTOR ACTIVE',
    },
    {
      actionPrefix: 'flightGuidance.autothrottleArmed',
      dataKey: 'athrArmed',
      eventName: 'AUTO_THROTTLE_ARM',
      fieldId: 'afds.autothrottleArmed',
      path: 'fdm.athrArmed',
      simvarName: 'AUTOPILOT THROTTLE ARM',
    },
  ]) {
    const provider = new SimConnectTelemetryProvider();
    const rustSnapshot: any = {
      status: 'running',
      updatedAt: new Date().toISOString(),
    };
    const events = [];
    provider._data = { [dataKey]: false };
    provider._rustSimvarSnapshotSequence = 21;
    provider._rustSimvarBridge = { getSnapshot: () => rustSnapshot };
    const bridge = {
      _started: true,
      getSnapshot: () => ({ source: 'mock-sidecar' }),
      async setNamedVar() {
        return { ok: true };
      },
      async sendEvent(name, value, parameters) {
        events.push({ name, value, parameters });
        assertEqual(name, eventName, `${actionPrefix} must remain bound to its documented toggle event`);
        provider._data[dataKey] = !provider._data[dataKey];
        provider._rustSimvarSnapshotSequence += 1;
        rustSnapshot.updatedAt = new Date().toISOString();
        return { ok: true };
      },
    };
    provider._lvarBridge = bridge;
    provider._ensureControlWriteBridge = async () => bridge;
    stubMicrosoft737Max8IntegrationFields(provider, {
      [fieldId]: {
        id: fieldId,
        source: {
          type: 'simvar',
          name: simvarName,
          path,
        },
        decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
      },
    });

    const action = {
      type: 'aircraft-integration',
      name: MICROSOFT_737_MAX_8_ADAPTER_ID,
      verification: 'untested',
    };
    const alreadyOff = await provider.executeAircraftControlAction(
      action,
      microsoft737Max8IntegrationOptions(`${actionPrefix}.off`),
    );
    assertEqual(alreadyOff.ok, true, `${actionPrefix} fresh same-state OFF should succeed`);
    assertEqual(alreadyOff.noOp, true, `${actionPrefix} same-state OFF should be an explicit no-op`);
    assertEqual(events.length, 0, `${actionPrefix} same-state OFF must not fire its toggle event`);

    const turnOn = await provider.executeAircraftControlAction(
      action,
      microsoft737Max8IntegrationOptions(`${actionPrefix}.on`),
    );
    assertEqual(turnOn.ok, true, `${actionPrefix} ON should confirm from newer exact-profile readback`);
    assertEqual(turnOn.confirmedValue, true, `${actionPrefix} ON should confirm the requested target`);
    assertDeepEqual(events, [{ name: eventName, value: 0, parameters: [] }],
      `${actionPrefix} ON should dispatch its documented toggle exactly once`);

    provider._aircraftIntegrationActionLastAttemptAt.clear();
    const alreadyOn = await provider.executeAircraftControlAction(
      action,
      microsoft737Max8IntegrationOptions(`${actionPrefix}.on`),
    );
    assertEqual(alreadyOn.ok, true, `${actionPrefix} fresh same-state ON should succeed`);
    assertEqual(alreadyOn.noOp, true, `${actionPrefix} same-state ON should be an explicit no-op`);
    assertEqual(events.length, 1, `${actionPrefix} same-state ON must not fire its toggle event`);

    provider._aircraftIntegrationActionLastAttemptAt.clear();
    const turnOff = await provider.executeAircraftControlAction(
      action,
      microsoft737Max8IntegrationOptions(`${actionPrefix}.off`),
    );
    assertEqual(turnOff.ok, true, `${actionPrefix} OFF should confirm from newer exact-profile readback`);
    assertEqual(turnOff.confirmedValue, false, `${actionPrefix} OFF should confirm the requested target`);
    assertDeepEqual(events, [
      { name: eventName, value: 0, parameters: [] },
      { name: eventName, value: 0, parameters: [] },
    ], `${actionPrefix} differing targets should each dispatch one toggle and no more`);
  }
});

test('initial LVAR bridge start establishes provider subscriptions only once', async (t) => {
  const provider = new SimConnectTelemetryProvider();
  const reloadReasons: string[] = [];
  const bridge = {
    _started: false,
    isEnabled() {
      return true;
    },
    async start() {
      this._started = true;
    },
    stop() {
      this._started = false;
    },
  };
  provider._lvarBridge = bridge;
  provider._reloadLvarSubscriptions = (reason) => reloadReasons.push(String(reason));
  t.after(() => provider.stop());

  await provider._initLvarBridge();
  await provider._initLvarBridge();

  assertEqual(reloadReasons.length, 1, 'initial bridge start should load subscriptions once');
  assertEqual(reloadReasons[0], 'provider-start', 'initial subscription load reason');
});

test('TriStar light actions require fresh readback, confirm once, and preserve toggle idempotence', async () => {
  const integrationAction = {
    type: 'aircraft-integration',
    name: INIBUILDS_TRISTAR_ADAPTER_ID,
    verification: 'untested',
  };

  const provider = new SimConnectTelemetryProvider();
  const snapshot: any = {
    source: 'mock-sidecar',
    profileId: INIBUILDS_TRISTAR_PROFILE_KEY,
    values: { standard_light_states: 0 },
    snapshotSequence: 1,
    updatedAt: new Date().toISOString(),
  };
  const events = [];
  const bridge = {
    _started: true,
    getSnapshot: () => snapshot,
    async setNamedVar() {
      return { ok: true };
    },
    async sendEvent(name, value) {
      events.push({ name, value });
      snapshot.values.standard_light_states = 1 << 1;
      snapshot.snapshotSequence += 1;
      snapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  stubTriStarIntegrationFields(provider);

  const beaconOn = await provider.executeAircraftControlAction(
    integrationAction,
    tristarIntegrationOptions('lights.beacon.setOn'),
  );
  assertEqual(beaconOn.ok, true, 'fresh deterministic light action should confirm');
  assertEqual(beaconOn.confirmedValue, true, 'beacon readback confirms ON');
  assertEqual(events.length, 1, 'deterministic light event executes exactly once');
  assertEqual(events[0].name, 'BEACON_LIGHTS_ON', 'adapter owns the documented beacon ON event');
  assertEqual(events[0].value, 0, 'adapter owns the fixed bounded event payload');

  const satisfiedProvider = new SimConnectTelemetryProvider();
  const satisfiedSnapshot: any = {
    source: 'mock-sidecar',
    profileId: INIBUILDS_TRISTAR_PROFILE_KEY,
    values: { standard_light_states: 1 << 8 },
    snapshotSequence: 7,
    updatedAt: new Date().toISOString(),
  };
  let toggleCalls = 0;
  const satisfiedBridge = {
    _started: true,
    getSnapshot: () => satisfiedSnapshot,
    async setNamedVar() {
      return { ok: true };
    },
    async sendEvent() {
      toggleCalls += 1;
      return { ok: true };
    },
  };
  satisfiedProvider._lvarBridge = satisfiedBridge;
  satisfiedProvider._ensureControlWriteBridge = async () => satisfiedBridge;
  stubTriStarIntegrationFields(satisfiedProvider);
  const logoAlreadyOn = await satisfiedProvider.executeAircraftControlAction(
    integrationAction,
    tristarIntegrationOptions('lights.logo.setOn'),
  );
  assertEqual(logoAlreadyOn.ok, true, 'already-satisfied logo intent should succeed');
  assertEqual(logoAlreadyOn.idempotent, true, 'toggle-backed logo intent is an idempotent no-op');
  assertEqual(logoAlreadyOn.noOp, true, 'same-state logo intent reports no native write');
  assertEqual(toggleCalls, 0, 'same-state logo intent must not fire TOGGLE_LOGO_LIGHTS');

  const staleProvider = new SimConnectTelemetryProvider();
  const staleSnapshot = {
    source: 'mock-sidecar',
    profileId: INIBUILDS_TRISTAR_PROFILE_KEY,
    values: { standard_light_states: 0 },
    snapshotSequence: 3,
    updatedAt: '2020-01-01T00:00:00.000Z',
  };
  let staleDispatches = 0;
  const staleBridge = {
    _started: true,
    getSnapshot: () => staleSnapshot,
    async setNamedVar() {
      return { ok: true };
    },
    async sendEvent() {
      staleDispatches += 1;
      return { ok: true };
    },
  };
  staleProvider._lvarBridge = staleBridge;
  staleProvider._ensureControlWriteBridge = async () => staleBridge;
  stubTriStarIntegrationFields(staleProvider);
  const staleResult = await staleProvider.executeAircraftControlAction(
    integrationAction,
    tristarIntegrationOptions('lights.beacon.setOn'),
  );
  assertEqual(staleResult.ok, false, 'stale light output must fail closed');
  assertEqual(staleResult.code, 'aircraft_integration_readback_unavailable', 'stale preflight code');
  assertEqual(staleResult.executionStarted, undefined, 'stale readback preflight does not imply dispatch');
  assertEqual(staleDispatches, 0, 'stale preflight cannot dispatch a light event');
});

test('TriStar selector step completes on transport acknowledgement without inventing readback', async () => {
  const integrationAction = {
    type: 'aircraft-integration',
    name: INIBUILDS_TRISTAR_ADAPTER_ID,
    verification: 'untested',
  };
  const buildSelectorProvider = (accepted = true) => {
    const provider = new SimConnectTelemetryProvider();
    const bridgeSnapshot = {
      source: 'mock-sidecar',
      profileId: INIBUILDS_TRISTAR_PROFILE_KEY,
      values: {},
      snapshotSequence: 1,
      updatedAt: new Date().toISOString(),
    };
    const events = [];
    const bridge = {
      _started: true,
      getSnapshot: () => bridgeSnapshot,
      async setNamedVar() {
        return { ok: true };
      },
      async sendEvent(name, value) {
        events.push({ name, value });
        return accepted ? { ok: true } : { ok: false, error: 'Rejected for test.' };
      },
    };
    provider._lvarBridge = bridge;
    provider._ensureControlWriteBridge = async () => bridge;
    stubTriStarIntegrationFields(provider);
    return { provider, bridge, events };
  };

  const accepted = buildSelectorProvider();
  const acceptedResult = await accepted.provider.executeAircraftControlAction(
    integrationAction,
    tristarIntegrationOptions('afcs.heading.increase'),
  );
  assertEqual(acceptedResult.ok, true, 'accepted selector event should complete');
  assertEqual(acceptedResult.transportAcknowledged, true, 'result should identify acknowledgement-only completion');
  assertEqual(acceptedResult.confirmedValue, undefined, 'selector result must not invent a cockpit value');
  assertEqual(accepted.events.length, 1, 'selector event dispatches exactly once');
  assertEqual(accepted.events[0].name, 'HEADING_BUG_INC', 'adapter owns the documented heading event');
  assertEqual(accepted.events[0].value, 0, 'selector event payload is fixed');

  const rejected = buildSelectorProvider(false);
  const rejectedResult = await rejected.provider.executeAircraftControlAction(
    integrationAction,
    tristarIntegrationOptions('afcs.heading.increase'),
  );
  assertEqual(rejectedResult.ok, false, 'a rejected selector event should fail');
  assertEqual(rejectedResult.code, 'simconnect_sequence_execution_failed', 'transport rejection should retain its exact failure code');
  assertEqual(rejectedResult.executionStarted, true, 'a native transport rejection follows a dispatch attempt');
  assertEqual(rejected.events.length, 1, 'a rejected selector event is never retried');
});

test('FBW strobe uses a native coordinated sequence and confirms actual light output', async () => {
  const provider = new SimConnectTelemetryProvider();
  const snapshot: any = {
    source: 'mock-sidecar',
    profileId: FBW_A32NX_PROFILE_KEY,
    values: { fbw_strobe_active: 0, fbw_strobe_auto: 0 },
    snapshotSequence: 1,
    updatedAt: new Date().toISOString(),
  };
  const operations = [];
  const bridge = {
    _started: true,
    getSnapshot: () => snapshot,
    async setNamedVar(operation) {
      operations.push({ ...operation });
      if (operation.name === 'L:STROBE_0_AUTO') {
        snapshot.values.fbw_strobe_auto = Number(operation.value);
      }
      snapshot.snapshotSequence += 1;
      snapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
    async sendEvent(name, value) {
      operations.push({ name, value });
      snapshot.values.fbw_strobe_active = Number(value);
      snapshot.snapshotSequence += 1;
      snapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  stubFbwA32nxStrobeFields(provider);

  const capabilities = provider.getAircraftControlCapabilities();
  assertEqual(capabilities.integrationTransports['simconnect-sequence'], true, 'live sidecar exposes native sequence transport');
  assertEqual(capabilities.integrationTransports['mobiflight-calculator'], false, 'corrected FBW strobe does not require MobiFlight');

  const result = await provider.executeAircraftControlAction({
    type: 'aircraft-integration',
    name: FBW_A32NX_ADAPTER_ID,
    verification: 'untested',
  }, {
    profileKey: FBW_A32NX_PROFILE_KEY,
    profileRevision: FBW_A32NX_PROFILE_REVISION,
    request: { actionId: 'lights.strobe.on' },
  });

  assertEqual(result.ok, true, 'coordinated strobe sequence should confirm');
  assertEqual(result.confirmedValue, true, 'confirmation must use actual light output');
  assertEqual(operations.length, 3, 'selector, AUTO flag, and real event execute exactly once');
  assertEqual(operations[0].name, 'L:LIGHTING_STROBE_0', 'selector position is first');
  assertEqual(operations[1].name, 'L:STROBE_0_AUTO', 'AUTO mode flag is second');
  assertEqual(operations[2].name, 'STROBES_SET', 'actual light event is last');
});

test('coordinated aircraft sequence supports bounded SimVar writes and delays', async () => {
  const provider = new SimConnectTelemetryProvider();
  const writes = [];
  const bridge = {
    async sendEvent() {
      return { ok: true };
    },
    async setNamedVar(operation) {
      writes.push(operation);
      return { ok: true };
    },
  };

  const result = await provider._executeAircraftIntegrationSimConnectSequence(bridge, [
    { type: 'simvar', name: 'CIRCUIT SWITCH ON:18', unit: 'Bool', value: 0 },
    { type: 'delay', milliseconds: 1 },
    { type: 'simvar', name: 'CIRCUIT SWITCH ON:18', unit: 'Bool', value: 1 },
  ]);

  assertEqual(result.ok, true, 'bounded delayed SimVar sequence should execute');
  assertEqual(writes.length, 2, 'the delay must not create an extra native write');
  assertEqual(writes[0].name, 'CIRCUIT SWITCH ON:18', 'the writable SimVar name stays adapter-owned');
  assertEqual(writes[0].dataType, 'bool', 'boolean circuit writes use the native bool data type');
  assertEqual(writes[1].value, 1, 'the post-delay target is dispatched last');
});

test('coordinated aircraft sequence forwards at most four trusted secondary event parameters', async () => {
  const provider = new SimConnectTelemetryProvider();
  const events = [];
  const bridge = {
    async sendEvent(name, value, parameters) {
      events.push({ name, value, parameters });
      return { ok: true };
    },
    async setNamedVar() {
      return { ok: true };
    },
  };

  const accepted = await provider._executeAircraftIntegrationSimConnectSequence(bridge, [{
    type: 'event',
    name: 'HEADING_BUG_SET',
    value: 275,
    parameters: [0],
  }]);
  assertEqual(accepted.ok, true, 'one fixed managed-index parameter should execute');
  assertDeepEqual(events, [{
    name: 'HEADING_BUG_SET',
    value: 275,
    parameters: [0],
  }], 'the native bridge receives the adapter-owned secondary parameter');

  const rejected = await provider._executeAircraftIntegrationSimConnectSequence(bridge, [{
    type: 'event',
    name: 'HEADING_BUG_SET',
    value: 275,
    parameters: [0, 1, 2, 3, 4],
  }]);
  assertEqual(rejected.ok, false, 'five secondary parameters exceed the native contract');
  assertEqual(events.length, 1, 'an oversized parameter list never reaches the bridge');
});

test('delayed aircraft sequence aborts before its final write when the profile changes', async () => {
  const provider = new SimConnectTelemetryProvider();
  const writes = [];
  let generationChecks = 0;
  provider._getActiveAircraftIntegrationConfig = () => {
    generationChecks += 1;
    return generationChecks < 3 ? {} : null;
  };
  const bridge = {
    async sendEvent() {
      return { ok: true };
    },
    async setNamedVar(operation) {
      writes.push(operation);
      return { ok: true };
    },
  };

  const result = await provider._executeAircraftIntegrationSimConnectSequence(
    bridge,
    [
      { type: 'lvar', name: 'L:LANDING_2_RETRACTED', unit: 'Number', value: 0 },
      { type: 'delay', milliseconds: 1 },
      { type: 'simvar', name: 'CIRCUIT SWITCH ON:18', unit: 'Bool', value: 1 },
    ],
    {
      profileKey: FBW_A32NX_PROFILE_KEY,
      profileRevision: FBW_A32NX_PROFILE_REVISION,
      adapterId: FBW_A32NX_ADAPTER_ID,
    },
  );

  assertEqual(result.ok, false, 'profile change must abort a delayed sequence');
  assertEqual(/profile changed/.test(result.error), true, 'abort should explain the stale aircraft generation');
  assertEqual(result.executionStarted, true, 'the completed pre-delay write makes aircraft state uncertain');
  assertEqual(writes.length, 1, 'the final circuit write must not reach a different aircraft');
  assertEqual(writes[0].name, 'L:LANDING_2_RETRACTED', 'only the pre-delay write is accepted');
});

test('FBW strobe selector movement cannot confirm while actual light output stays off', async () => {
  const provider = new SimConnectTelemetryProvider();
  const snapshot: any = {
    source: 'mock-sidecar',
    profileId: FBW_A32NX_PROFILE_KEY,
    values: { fbw_strobe_active: 0, fbw_strobe_auto: 0 },
    snapshotSequence: 1,
    updatedAt: new Date().toISOString(),
  };
  let operationCalls = 0;
  const bridge = {
    _started: true,
    getSnapshot: () => snapshot,
    async setNamedVar() {
      operationCalls += 1;
      snapshot.snapshotSequence += 1;
      snapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
    async sendEvent() {
      operationCalls += 1;
      snapshot.snapshotSequence += 1;
      snapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  stubFbwA32nxStrobeFields(provider);
  provider._waitForAircraftIntegrationReadback = async (_bridge, readback, context) => {
    const sample = provider._captureAircraftIntegrationReadback(bridge, readback, context);
    return {
      confirmed: false,
      observed: sample.observed,
      sequenceAdvanced: true,
    };
  };

  const result = await provider.executeAircraftControlAction({
    type: 'aircraft-integration',
    name: FBW_A32NX_ADAPTER_ID,
    verification: 'untested',
  }, {
    profileKey: FBW_A32NX_PROFILE_KEY,
    profileRevision: FBW_A32NX_PROFILE_REVISION,
    request: { actionId: 'lights.strobe.on' },
  });

  assertEqual(result.ok, false, 'cosmetic selector movement must not be success');
  assertEqual(result.code, 'aircraft_integration_readback_timeout', 'actual-output confirmation failure');
  assertEqual(result.executionStarted, true, 'readback timeout follows native sequence dispatch');
  assertEqual(result.readbackAdvanced, true, 'failure distinguishes a newer mismatching state');
  assertEqual(result.expectedValue, true, 'failure reports the requested logical state');
  assertEqual(result.baselineValue, false, 'failure reports the pre-command state');
  assertEqual(result.observedValue, false, 'failure reports the unchanged real light state');
  assertEqual(
    result.error.includes('A newer aircraft state arrived'),
    true,
    'failure explains that transport/readback advanced but the logical value did not match',
  );
  assertEqual(operationCalls, 3, 'failed confirmation never retries the sequence');
});

test('all writable integration SimVar readbacks have an exact or derived runtime source', () => {
  const exactSimvars = new Set(SIMCONNECT_VARS.map((definition) => definition.simvar));
  const failures = [];
  const audited = [];

  for (const [exportName, integrationValue] of Object.entries(aircraftIntegrationCatalog)) {
    if (!exportName.endsWith('_INTEGRATION') || !integrationValue || typeof integrationValue !== 'object') continue;
    const integration: any = integrationValue;
    for (const action of Object.values(integration.actions || {}) as any[]) {
      for (const route of action?.routes || []) {
        const fieldId = route?.readback?.fieldId;
        const field = typeof fieldId === 'string' ? integration.fields?.[fieldId] : null;
        for (const source of field?.sources || []) {
          if (source?.route?.type !== 'simvar') continue;
          const simvarName = source.route.name;
          audited.push(`${integration.id}:${action.id}:${fieldId}:${simvarName}`);
          if (
            !exactSimvars.has(simvarName)
            && !Object.prototype.hasOwnProperty.call(
              AIRCRAFT_INTEGRATION_DERIVED_LIGHT_SIMVARS,
              simvarName,
            )
          ) {
            failures.push(`${integration.id}:${action.id}:${fieldId}:${simvarName}`);
          }
        }
      }
    }
  }

  assertEqual(audited.length > 0, true, 'inventory should include writable SimVar confirmations');
  assertEqual(failures.length, 0, `unresolvable writable SimVar confirmations: ${failures.join(', ')}`);
});

test('FBW standard light actions prefer fresh gauge LIGHT STATES and confirm a newer mask', async () => {
  const cases = [
    ['lights.beacon.on', 'BEACON_SET', 1 << 1],
    ['lights.wing.on', 'WING_SET', 1 << 7],
    ['lights.nav.on', 'NAV_LIGHTS_SET', 1 << 0],
    ['lights.logo.on', 'LOGO_LIGHTS_SET', 1 << 8],
  ];

  for (const [actionId, expectedEvent, bit] of cases) {
    const provider = new SimConnectTelemetryProvider();
    const snapshot: any = {
      source: 'mock-sidecar',
      profileId: FBW_A32NX_PROFILE_KEY,
      values: { standard_light_states: 0 },
      snapshotSequence: 1,
      updatedAt: new Date().toISOString(),
    };
    const events = [];
    const bridge = {
      getSnapshot: () => snapshot,
      async sendEvent(name, value) {
        events.push({ name, value });
        snapshot.values.standard_light_states = bit;
        snapshot.snapshotSequence += 1;
        snapshot.updatedAt = new Date().toISOString();
        return { ok: true };
      },
      async setNamedVar() {
        return { ok: true };
      },
    };
    // Deliberately disagree with the gauge path. The broadcast UI also
    // prefers the gauge mask, so preflight must not incorrectly no-op here.
    provider._data = { lightStates: bit };
    provider._lvarBridge = bridge;
    provider._ensureControlWriteBridge = async () => bridge;
    stubFbwA32nxStrobeFields(provider);

    const result = await provider.executeAircraftControlAction({
      type: 'aircraft-integration',
      name: FBW_A32NX_ADAPTER_ID,
      verification: 'untested',
    }, {
      profileKey: FBW_A32NX_PROFILE_KEY,
      profileRevision: FBW_A32NX_PROFILE_REVISION,
      request: { actionId },
    });

    assertEqual(result.ok, true, `${actionId} should confirm from the shared light mask`);
    assertEqual(result.confirmedValue, true, `${actionId} confirmed logical value`);
    assertEqual(events.length, 1, `${actionId} should dispatch exactly once`);
    assertEqual(events[0].name, expectedEvent, `${actionId} fixed event`);
    assertEqual(events[0].value, 1, `${actionId} fixed ON payload`);
  }
});

test('derived light confirmation falls back to native LIGHT STATES without crossing snapshot sources', async () => {
  const provider = new SimConnectTelemetryProvider();
  const rustSnapshot: any = {
    status: 'running',
    updatedAt: new Date().toISOString(),
  };
  const lvarSnapshot: any = {
    profileId: FBW_A32NX_PROFILE_KEY,
    values: {},
    snapshotSequence: 4,
    updatedAt: new Date().toISOString(),
  };
  const bridge = { getSnapshot: () => lvarSnapshot };
  provider._data = { lightStates: 0 };
  provider._rustSimvarSnapshotSequence = 8;
  provider._rustSimvarBridge = { getSnapshot: () => rustSnapshot };
  stubFbwA32nxStrobeFields(provider);

  const readback = { fieldId: 'lights.beacon', expectedValue: true, timeoutMs: 1 };
  const context = {
    profileKey: FBW_A32NX_PROFILE_KEY,
    adapterId: FBW_A32NX_ADAPTER_ID,
    profileRevision: FBW_A32NX_PROFILE_REVISION,
  };
  const baseline = provider._captureAircraftIntegrationReadback(bridge, readback, context);
  assertEqual(baseline.observed, false, 'native mask should provide the fallback baseline');
  assertEqual(baseline.fresh, true, 'fresh Rust generation should make the fallback usable');

  // A different readback transport appearing after dispatch must not compare
  // its unrelated sequence number with the Rust baseline.
  provider._data.lightStates = 1 << 1;
  provider._rustSimvarSnapshotSequence += 1;
  rustSnapshot.updatedAt = new Date().toISOString();
  lvarSnapshot.values.standard_light_states = 1 << 1;
  lvarSnapshot.snapshotSequence = 99;
  lvarSnapshot.updatedAt = new Date().toISOString();
  const switched = await provider._waitForAircraftIntegrationReadback(
    bridge,
    readback,
    context,
    baseline,
  );
  assertEqual(switched.confirmed, false, 'confirmation must remain on the baseline snapshot source');
  assertEqual(switched.sequenceAdvanced, false, 'unrelated source sequence must not count as advancement');
});

test('FBW fixed LVAR actions confirm once and same-target toggle actions are safe no-ops', async () => {
  const provider = new SimConnectTelemetryProvider();
  const snapshot: any = {
    source: 'mock-sidecar',
    profileId: FBW_A32NX_PROFILE_KEY,
    values: {
      fbw_apu_start: 0,
      fbw_engine_bleed_1: 1,
    },
    snapshotSequence: 1,
    updatedAt: new Date().toISOString(),
  };
  const writes = [];
  const events = [];
  const bridge = {
    _started: true,
    getSnapshot: () => snapshot,
    async setNamedVar(operation) {
      writes.push({ ...operation });
      if (operation.name === 'L:A32NX_OVHD_APU_START_PB_IS_ON') {
        snapshot.values.fbw_apu_start = Number(operation.value);
      }
      snapshot.snapshotSequence += 1;
      snapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
    async sendEvent(name, value) {
      events.push({ name, value });
      if (name === 'ENGINE_BLEED_AIR_SOURCE_TOGGLE' && value === 1) {
        snapshot.values.fbw_engine_bleed_1 = snapshot.values.fbw_engine_bleed_1 ? 0 : 1;
      }
      snapshot.snapshotSequence += 1;
      snapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  stubFbwA32nxStrobeFields(provider);

  const action = {
    type: 'aircraft-integration',
    name: FBW_A32NX_ADAPTER_ID,
    verification: 'untested',
  };
  const execute = (actionId) => provider.executeAircraftControlAction(action, {
    profileKey: FBW_A32NX_PROFILE_KEY,
    profileRevision: FBW_A32NX_PROFILE_REVISION,
    request: { actionId },
  });

  const apuStart = await execute('systems.apuStart.start');
  assertEqual(apuStart.ok, true, 'documented fixed APU LVAR should confirm');
  assertEqual(apuStart.transportMode, 'direct-lvar', 'bounded direct route reports its diagnostic mode');
  assertEqual(writes.length, 1, 'fixed LVAR dispatches once');
  assertEqual(writes[0].name, 'L:A32NX_OVHD_APU_START_PB_IS_ON', 'trusted adapter owns the exact APU target');

  const alreadyOn = await execute('systems.engineBleed1.on');
  assertEqual(alreadyOn.ok, true, 'already-satisfied toggle target should succeed');
  assertEqual(alreadyOn.idempotent, true, 'same-state toggle target is reported as an idempotent no-op');
  assertEqual(events.length, 0, 'same-state target must not fire the toggle event');

  const turnOff = await execute('systems.engineBleed1.off');
  assertEqual(turnOff.ok, true, 'changed toggle target should dispatch and confirm');
  assertEqual(turnOff.confirmedValue, false, 'engine bleed readback should confirm OFF');
  assertEqual(events.length, 1, 'changed target dispatches exactly once');
  assertEqual(events[0].name, 'ENGINE_BLEED_AIR_SOURCE_TOGGLE', 'adapter owns the documented event');
  assertEqual(events[0].value, 1, 'engine index remains fixed and bounded');
});

test('coordinated aircraft sequence resolves typed percentages into trusted LVAR values', () => {
  const provider = new SimConnectTelemetryProvider();
  const route = {
    operations: [{
      type: 'lvar',
      name: 'L:CA_AFDS_FLOOD_LIGHT_CONTROL',
      unit: 'Number',
      inputValue: { source: 'input', scale: 3, round: 'nearest' },
    }],
  };
  const action = {
    input: { type: 'number', min: 0, max: 100, step: 1 },
  };

  const resolved = provider._resolveAircraftIntegrationSimConnectOperations(route, action, 42);
  assertEqual(resolved.ok, true, 'a whole percentage should resolve');
  assertDeepEqual(resolved.operations, [{
    type: 'lvar',
    name: 'L:CA_AFDS_FLOOD_LIGHT_CONTROL',
    unit: 'Number',
    value: 126,
    inputValue: undefined,
  }], 'the adapter-owned 0..300 conversion should be applied before native dispatch');

  const invalid = provider._resolveAircraftIntegrationSimConnectOperations(route, action, 42.5);
  assertEqual(invalid.ok, false, 'off-step percentages must fail before native dispatch');
  assertEqual(invalid.operations.length, 0, 'an invalid logical input must resolve no operations');
});

function buildFbwA32nxThrottleProvider(initialValues) {
  const provider = new SimConnectTelemetryProvider();
  const snapshot: any = {
    source: 'mock-sidecar',
    profileId: FBW_A32NX_PROFILE_KEY,
    values: { ...initialValues },
    snapshotSequence: 1,
    updatedAt: new Date().toISOString(),
    mobiflight: {
      state: 'connected',
      connected: true,
      available: true,
      error: null,
    },
  };
  const codes = [];
  const bridge = {
    _started: true,
    getSnapshot: () => snapshot,
    async executeMobiFlightCode(code) {
      codes.push(code);
      snapshot.values.fbw_throttle_1 = 35;
      snapshot.values.fbw_throttle_2 = 35;
      snapshot.snapshotSequence += 1;
      snapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  stubFbwA32nxStrobeFields(provider);
  return { codes, provider, snapshot };
}

test('FlyByWire A32NX virtual throttle uses calibrated detent code and confirms both TLAs', async () => {
  const throttle = buildFbwA32nxThrottleProvider({
    fbw_throttle_1: 12.4,
    fbw_throttle_2: 13.1,
  });
  const action = {
    type: 'aircraft-integration',
    name: FBW_A32NX_ADAPTER_ID,
    verification: 'untested',
  };
  const result = await throttle.provider.executeAircraftControlAction(action, {
    profileKey: FBW_A32NX_PROFILE_KEY,
    profileRevision: FBW_A32NX_PROFILE_REVISION,
    request: { actionId: 'propulsion.throttle.flexMct' },
  });

  assertEqual(result.ok, true, 'both newer A32NX TLA readbacks should confirm FLX/MCT');
  assertEqual(result.transportMode, 'mobiflight', 'calibrated FlyByWire detents use the calculator route');
  assertDeepEqual(result.confirmedValues, {
    'propulsion.throttleLever1Angle': 35,
    'propulsion.throttleLever2Angle': 35,
  }, 'success reports both independently confirmed TLAs');
  assertEqual(throttle.codes.length, 1, 'one tap emits one coordinated calibrated expression');
  assertEqual(/A32NX_THROTTLE_MAPPING_FLEXMCT_LOW:1/.test(throttle.codes[0]), true,
    'the expression reads the first calibrated FLX/MCT lower bound');
  assertEqual(/A32NX_THROTTLE_MAPPING_FLEXMCT_HIGH:2/.test(throttle.codes[0]), true,
    'the expression reads the second calibrated FLX/MCT upper bound');
  assertEqual(/THROTTLE1_AXIS_SET_EX1/.test(throttle.codes[0]), true,
    'the expression owns the documented first-axis event');
  assertEqual(/THROTTLE2_AXIS_SET_EX1/.test(throttle.codes[0]), true,
    'the expression owns the documented second-axis event');

  const satisfied = buildFbwA32nxThrottleProvider({
    fbw_throttle_1: 35,
    fbw_throttle_2: 35,
  });
  const noOp = await satisfied.provider.executeAircraftControlAction(action, {
    profileKey: FBW_A32NX_PROFILE_KEY,
    profileRevision: FBW_A32NX_PROFILE_REVISION,
    request: { actionId: 'propulsion.throttle.flexMct' },
  });
  assertEqual(noOp.ok, true, 'an already-aligned FlyByWire detent should succeed');
  assertEqual(noOp.noOp, true, 'same-detent A32NX requests are idempotent no-ops');
  assertEqual(satisfied.codes.length, 0, 'same-detent requests emit no calculator expression');
});

test('FlyByWire A380X virtual throttle coordinates and confirms all four calibrated axes', async () => {
  const provider = new SimConnectTelemetryProvider();
  const snapshot: any = {
    source: 'mock-sidecar',
    profileId: FBW_A380X_PROFILE_KEY,
    values: {
      fbw_a380_throttle_1: 11,
      fbw_a380_throttle_2: 12,
      fbw_a380_throttle_3: 13,
      fbw_a380_throttle_4: 14,
    },
    snapshotSequence: 1,
    updatedAt: new Date().toISOString(),
    mobiflight: {
      state: 'connected',
      connected: true,
      available: true,
      error: null,
    },
  };
  const codes = [];
  const bridge = {
    _started: true,
    getSnapshot: () => snapshot,
    async executeMobiFlightCode(code) {
      codes.push(code);
      for (let index = 1; index <= 4; index += 1) {
        snapshot.values[`fbw_a380_throttle_${index}`] = 45;
      }
      snapshot.snapshotSequence += 1;
      snapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  stubFbwA380xIntegrationFields(provider, Object.fromEntries(
    Array.from({ length: 4 }, (_, offset) => {
      const index = offset + 1;
      const fieldId = `propulsion.throttleLever${index}Angle`;
      return [fieldId, {
        id: fieldId,
        source: { type: 'lvar', key: `fbw_a380_throttle_${index}` },
        decode: { type: 'number', precision: 2 },
      }];
    }),
  ));

  const result = await provider.executeAircraftControlAction({
    type: 'aircraft-integration',
    name: FBW_A380X_ADAPTER_ID,
    verification: 'untested',
  }, fbwA380xIntegrationOptions('propulsion.throttle.toga'));

  assertEqual(result.ok, true, 'all four newer A380X TLA readbacks should confirm TOGA');
  assertDeepEqual(result.confirmedValues, {
    'propulsion.throttleLever1Angle': 45,
    'propulsion.throttleLever2Angle': 45,
    'propulsion.throttleLever3Angle': 45,
    'propulsion.throttleLever4Angle': 45,
  }, 'success reports all four independently confirmed TLAs');
  assertEqual(codes.length, 1, 'one tap emits one coordinated four-axis expression');
  assertEqual(/A32NX_THROTTLE_MAPPING_TOGA_HIGH:4/.test(codes[0]), true,
    'the expression reads the fourth calibrated TOGA window');
  assertEqual(/THROTTLE4_AXIS_SET_EX1/.test(codes[0]), true,
    'the expression owns the documented fourth-axis event');
});

function buildFenixFcuProvider(initialValues, executeCode) {
  const provider = new SimConnectTelemetryProvider();
  const snapshot: any = {
    source: 'mock-sidecar',
    profileId: FENIX_A320_PROFILE_KEY,
    values: { ...initialValues },
    snapshotSequence: 1,
    updatedAt: new Date().toISOString(),
    mobiflight: {
      state: 'connected',
      connected: true,
      available: true,
      error: null,
    },
  };
  const codes = [];
  const bridge = {
    _started: true,
    getSnapshot: () => snapshot,
    async executeMobiFlightCode(code) {
      codes.push(code);
      return executeCode
        ? executeCode({ code, codes, provider, snapshot })
        : { ok: true };
    },
    async setNamedVar() {
      throw new Error('Fenix FCU actions must never fall through to direct LVAR writes.');
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  stubFenixA320IntegrationFields(provider);
  return { bridge, codes, provider, snapshot };
}

function buildFenixThrottleProvider(initialValues) {
  const provider = new SimConnectTelemetryProvider();
  const snapshot: any = {
    source: 'mock-sidecar',
    profileId: FENIX_A320_PROFILE_KEY,
    values: { ...initialValues },
    snapshotSequence: 1,
    updatedAt: new Date().toISOString(),
  };
  const writes = [];
  const bridge = {
    _started: true,
    getSnapshot: () => snapshot,
    async sendEvent() {
      throw new Error('fixed Fenix throttle detents must not emit key events');
    },
    async setNamedVar(request) {
      writes.push(request);
      if (request.name === 'L:A_FC_THROTTLE_LEFT_INPUT') {
        snapshot.values.fenix_throttle_left = request.value;
      } else if (request.name === 'L:A_FC_THROTTLE_RIGHT_INPUT') {
        snapshot.values.fenix_throttle_right = request.value;
      }
      snapshot.snapshotSequence += 1;
      snapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  stubFenixA320IntegrationFields(provider);
  return { bridge, provider, snapshot, writes };
}

test('Fenix virtual throttle sends one fixed detent to both levers and confirms both readbacks', async () => {
  const throttle = buildFenixThrottleProvider({
    fenix_throttle_left: 2.42,
    fenix_throttle_right: 2.57,
  });
  const action = {
    type: 'aircraft-integration',
    name: FENIX_A32X_ADAPTER_ID,
    verification: 'untested',
  };
  const result = await throttle.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('propulsion.throttle.flexMct'),
  );

  assertEqual(result.ok, true, 'both newer Fenix lever readbacks should confirm FLX/MCT');
  assertEqual(result.transportMode, 'simconnect-sequence', 'paired lever writes stay coordinated');
  assertDeepEqual(result.confirmedValues, {
    'propulsion.throttleLever1Position': 4,
    'propulsion.throttleLever2Position': 4,
  }, 'success reports both independently confirmed lever values');
  assertDeepEqual(throttle.writes.map((write) => ({
    name: write.name,
    unit: write.unit,
    value: write.value,
  })), [
    { name: 'L:A_FC_THROTTLE_LEFT_INPUT', unit: 'Number', value: 4 },
    { name: 'L:A_FC_THROTTLE_RIGHT_INPUT', unit: 'Number', value: 4 },
  ], 'one tap writes the same fixed detent once to each Fenix lever');

  const satisfied = buildFenixThrottleProvider({
    fenix_throttle_left: 3,
    fenix_throttle_right: 3,
  });
  const noOp = await satisfied.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('propulsion.throttle.climb'),
  );
  assertEqual(noOp.ok, true, 'an already-aligned CLB request should succeed');
  assertEqual(noOp.noOp, true, 'an already-aligned detent is an idempotent no-op');
  assertEqual(satisfied.writes.length, 0, 'same-detent requests emit no lever writes');

  const splitConfirmation = buildFenixThrottleProvider({
    fenix_throttle_left: 2.4,
    fenix_throttle_right: 2.6,
  });
  const waitForReadback = splitConfirmation.provider
    ._waitForAircraftIntegrationReadback
    .bind(splitConfirmation.provider);
  splitConfirmation.provider._waitForAircraftIntegrationReadback = async (
    bridge,
    readback,
    context,
    baseline,
  ) => {
    if (readback.fieldId === 'propulsion.throttleLever2Position') {
      return {
        confirmed: false,
        observed: 4.5,
        sequence: Number(baseline.sequence) + 1,
        fresh: true,
        sourceId: baseline.sourceId,
        sequenceAdvanced: true,
      };
    }
    return waitForReadback(bridge, readback, context, baseline);
  };
  const splitResult = await splitConfirmation.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('propulsion.throttle.toga'),
  );
  assertEqual(splitResult.ok, false, 'one failed lever confirmation must fail the paired action');
  assertEqual(splitResult.code, 'aircraft_integration_readback_timeout', 'split lever state stays explicit');
  assertEqual(splitResult.observedValue, 4.5, 'the failed right-lever value remains diagnostic');
});

test('Fenix FCU momentary targets emit one press/release pair and same-state requests are no-ops', async () => {
  const pulseCode = '(L:S_FCU_AP1, Number) ++ (>L:S_FCU_AP1, Number)';
  const changed = buildFenixFcuProvider({ fenix_ap1: 0 }, ({ codes, snapshot }) => {
    if (codes.length === 2) {
      snapshot.values.fenix_ap1 = 1;
      snapshot.snapshotSequence += 1;
      snapshot.updatedAt = new Date().toISOString();
    }
    return { ok: true };
  });
  const action = {
    type: 'aircraft-integration',
    name: FENIX_A32X_ADAPTER_ID,
    verification: 'untested',
  };
  const result = await changed.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('flightGuidance.ap1.on'),
  );
  assertEqual(result.ok, true, 'newer AP1 state should confirm the momentary target');
  assertEqual(JSON.stringify(changed.codes), JSON.stringify([pulseCode, pulseCode]), 'press and release use the audited counter increment');

  const satisfied = buildFenixFcuProvider({ fenix_ap1: 1 }, () => {
    throw new Error('same-state AP1 target must not dispatch');
  });
  const noOp = await satisfied.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('flightGuidance.ap1.on'),
  );
  assertEqual(noOp.ok, true, 'same-state AP1 target should succeed');
  assertEqual(noOp.noOp, true, 'same-state AP1 target is an explicit no-op');
  assertEqual(satisfied.codes.length, 0, 'same-state AP1 target emits no pulse');

  const releaseFailure = buildFenixFcuProvider({ fenix_ap1: 0 }, ({ codes }) => (
    codes.length === 2 ? { ok: false, error: 'release rejected' } : { ok: true }
  ));
  const failed = await releaseFailure.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('flightGuidance.ap1.on'),
  );
  assertEqual(failed.ok, false, 'release failure must remain explicit');
  assertEqual(failed.code, 'mobiflight_execution_failed', 'release failure maps through MobiFlight diagnostics');
  assertEqual(releaseFailure.codes.length, 2, 'failed release is never retried or followed by fallback');
});

test('Fenix FCU pulse best-effort releases after an aircraft generation change', async () => {
  const provider = new SimConnectTelemetryProvider();
  let active = true;
  const codes = [];
  provider._getActiveAircraftIntegrationConfig = () => (active ? {} : null);
  const code = '(L:S_FCU_AP1, Number) ++ (>L:S_FCU_AP1, Number)';
  const result = await provider._executeAircraftIntegrationMobiFlightRoute(
    {
      async executeMobiFlightCode(value) {
        codes.push(value);
        if (codes.length === 1) active = false;
        return { ok: true };
      },
    },
    {
      mode: 'pulse',
      pressCode: code,
      releaseCode: code,
      delayMs: 1,
    },
    {},
    undefined,
    { observed: false },
    { profileKey: FENIX_A320_PROFILE_KEY, adapterId: FENIX_A32X_ADAPTER_ID, profileRevision: 1 },
  );
  assertEqual(result.ok, false, 'generation change after press must report stale');
  assertEqual(result.code, 'stale_profile', 'generation failure stays distinguishable');
  assertEqual(JSON.stringify(codes), JSON.stringify([code, code]), 'accepted press still gets one best-effort release');

  const changedDuringReleaseProvider = new SimConnectTelemetryProvider();
  let releaseActive = true;
  let releaseCalls = 0;
  changedDuringReleaseProvider._getActiveAircraftIntegrationConfig = () => (
    releaseActive ? {} : null
  );
  const changedDuringRelease = await changedDuringReleaseProvider._executeAircraftIntegrationMobiFlightRoute(
    {
      async executeMobiFlightCode() {
        releaseCalls += 1;
        if (releaseCalls === 2) releaseActive = false;
        return { ok: true };
      },
    },
    { mode: 'pulse', pressCode: code, releaseCode: code, delayMs: 1 },
    {},
    undefined,
    { observed: false },
    { profileKey: FENIX_A320_PROFILE_KEY, adapterId: FENIX_A32X_ADAPTER_ID, profileRevision: 1 },
  );
  assertEqual(changedDuringRelease.ok, false, 'generation change while release awaits acknowledgement must report stale');
  assertEqual(changedDuringRelease.code, 'stale_profile', 'post-release generation failure stays distinguishable');
  assertEqual(releaseCalls, 2, 'generation change during release emits no extra calculator command');

  const failedProvider = new SimConnectTelemetryProvider();
  let failedActive = true;
  let failedCalls = 0;
  failedProvider._getActiveAircraftIntegrationConfig = () => (failedActive ? {} : null);
  const failedRelease = await failedProvider._executeAircraftIntegrationMobiFlightRoute(
    {
      async executeMobiFlightCode() {
        failedCalls += 1;
        if (failedCalls === 1) {
          failedActive = false;
          return { ok: true };
        }
        return { ok: false, error: 'release rejected after profile change' };
      },
    },
    { mode: 'pulse', pressCode: code, releaseCode: code, delayMs: 1 },
    {},
    undefined,
    { observed: false },
    { profileKey: FENIX_A320_PROFILE_KEY, adapterId: FENIX_A32X_ADAPTER_ID, profileRevision: 1 },
  );
  assertEqual(failedRelease.ok, false, 'failed best-effort release must remain explicit');
  assertEqual(failedRelease.error, 'release rejected after profile change', 'release failure must not be masked as stale');
  assertEqual(failedCalls, 2, 'combined stale/failure path still attempts exactly one release');
});

test('Fenix FCU numeric targets use bounded shortest-path calculator steps and exact readback', async () => {
  const increaseSpeed = '(L:E_FCU_SPEED, Number) ++ (>L:E_FCU_SPEED, Number)';
  const action = {
    type: 'aircraft-integration',
    name: FENIX_A32X_ADAPTER_ID,
    verification: 'untested',
  };

  const satisfiedSpeed = buildFenixFcuProvider({ fenix_speed: 250 }, () => {
    throw new Error('same-target speed must not dispatch');
  });
  const speedNoOp = await satisfiedSpeed.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('flightGuidance.speed.set', 250),
  );
  assertEqual(speedNoOp.ok, true, 'same-target speed should succeed');
  assertEqual(speedNoOp.idempotent, true, 'same-target speed is reported as idempotent');
  assertEqual(speedNoOp.noOp, true, 'same-target speed is an explicit no-op');
  assertEqual(satisfiedSpeed.codes.length, 0, 'same-target speed emits no calculator step');

  // Preconditions protect physical dispatch, not a target that is already
  // satisfied. A same-target altitude request must remain a true no-op even
  // if the pilot has since changed the 100/1000 selector.
  const satisfiedAltitude = buildFenixFcuProvider({
    fenix_altitude: 10000,
    fenix_altitude_scale: 0,
  }, () => {
    throw new Error('same-target altitude must not dispatch');
  });
  const altitudeNoOp = await satisfiedAltitude.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('flightGuidance.altitudeHundred.set', 10000),
  );
  assertEqual(altitudeNoOp.ok, true, 'same-target altitude should succeed without a rotary write');
  assertEqual(altitudeNoOp.noOp, true, 'same-target altitude is an explicit no-op');
  assertEqual(satisfiedAltitude.codes.length, 0, 'same-target altitude bypasses an irrelevant step precondition');

  const speed = buildFenixFcuProvider({ fenix_speed: 250 }, ({ snapshot }) => {
    snapshot.values.fenix_speed += 1;
    snapshot.snapshotSequence += 1;
    snapshot.updatedAt = new Date().toISOString();
    return { ok: true };
  });
  const speedResult = await speed.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('flightGuidance.speed.set', 253),
  );
  assertEqual(speedResult.ok, true, 'three trusted speed increments should confirm');
  assertEqual(speedResult.confirmedValue, 253, 'numeric confirmation requires the exact target');
  assertEqual(JSON.stringify(speed.codes), JSON.stringify([increaseSpeed, increaseSpeed, increaseSpeed]), 'speed uses an exact bounded step count');

  const decreaseSpeed = '(L:E_FCU_SPEED, Number) -- (>L:E_FCU_SPEED, Number)';
  const descendingSpeed = buildFenixFcuProvider({ fenix_speed: 253 }, ({ snapshot }) => {
    snapshot.values.fenix_speed -= 1;
    snapshot.snapshotSequence += 1;
    snapshot.updatedAt = new Date().toISOString();
    return { ok: true };
  });
  const descendingResult = await descendingSpeed.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('flightGuidance.speed.set', 250),
  );
  assertEqual(descendingResult.ok, true, 'three trusted speed decrements should confirm');
  assertEqual(
    JSON.stringify(descendingSpeed.codes),
    JSON.stringify([decreaseSpeed, decreaseSpeed, decreaseSpeed]),
    'descending speed uses the exact decrement count',
  );

  const increaseHeading = '(L:E_FCU_HEADING, Number) ++ (>L:E_FCU_HEADING, Number)';
  const heading = buildFenixFcuProvider({ fenix_heading: 359 }, ({ snapshot }) => {
    snapshot.values.fenix_heading = (snapshot.values.fenix_heading + 1) % 360;
    snapshot.snapshotSequence += 1;
    snapshot.updatedAt = new Date().toISOString();
    return { ok: true };
  });
  const headingResult = await heading.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('flightGuidance.heading.set', 1),
  );
  assertEqual(headingResult.ok, true, 'circular heading target should confirm');
  assertEqual(JSON.stringify(heading.codes), JSON.stringify([increaseHeading, increaseHeading]), '359 to 1 takes the two-step circular path');
});

test('Fenix FCU numeric targets pace every relative step against exact aircraft progress', async () => {
  const action = {
    type: 'aircraft-integration',
    name: FENIX_A32X_ADAPTER_ID,
    verification: 'untested',
  };

  const periodicProvider = new SimConnectTelemetryProvider();
  const periodicSamples = [
    {
      observed: 250,
      sequence: 2,
      fresh: true,
      sourceId: 'lvar:fenix_speed',
    },
    {
      observed: 251,
      sequence: 3,
      fresh: true,
      sourceId: 'lvar:fenix_speed',
    },
  ];
  let periodicCaptureCount = 0;
  periodicProvider._captureAircraftIntegrationReadback = () => periodicSamples[
    Math.min(periodicCaptureCount++, periodicSamples.length - 1)
  ];
  const periodicProgress = await periodicProvider._waitForAircraftIntegrationReadback(
    {},
    {
      fieldId: 'flightGuidance.speedValue',
      confirmation: 'changed',
      timeoutMs: 200,
    },
    {},
    {
      observed: 250,
      sequence: 1,
      fresh: true,
      sourceId: 'lvar:fenix_speed',
    },
  );
  assertEqual(periodicProgress.confirmed, true, 'a newer periodic snapshot with the same value must not confirm progress');
  assertEqual(periodicProgress.observed, 251, 'confirmation waits for an actual one-detent value change');
  assertEqual(periodicCaptureCount, 2, 'the unchanged periodic snapshot is sampled before exact progress');

  let dispatchedBeforePreviousProgress = false;
  const paced = buildFenixFcuProvider({ fenix_speed: 250 }, ({ codes, snapshot }) => {
    const callNumber = codes.length;
    if (callNumber > 1 && snapshot.values.fenix_speed !== 249 + callNumber) {
      dispatchedBeforePreviousProgress = true;
    }
    setTimeout(() => {
      snapshot.values.fenix_speed += 1;
      snapshot.snapshotSequence += 1;
      snapshot.updatedAt = new Date().toISOString();
    }, 70);
    return { ok: true };
  });
  const pacedResult = await paced.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('flightGuidance.speed.set', 253),
  );
  assertEqual(pacedResult.ok, true, 'delayed one-detent readbacks should reach the absolute target');
  assertEqual(dispatchedBeforePreviousProgress, false, 'no later command may precede exact progress from the prior detent');
  assertEqual(paced.codes.length, 3, 'the paced route still emits the required three detents');

  const noProgress = buildFenixFcuProvider({ fenix_speed: 250 }, () => ({ ok: true }));
  const generationContext = {
    profileKey: FENIX_A320_PROFILE_KEY,
    adapterId: FENIX_A32X_ADAPTER_ID,
    profileRevision: FENIX_A320_PROFILE_REVISION,
  };
  const baseline = noProgress.provider._captureAircraftIntegrationReadback(
    noProgress.bridge,
    { fieldId: 'flightGuidance.speedValue' },
    generationContext,
  );
  const stopped = await noProgress.provider._executeAircraftIntegrationMobiFlightRoute(
    noProgress.bridge,
    {
      mode: 'step-to-target',
      decreaseCode: '(L:E_FCU_SPEED, Number) -- (>L:E_FCU_SPEED, Number)',
      increaseCode: '(L:E_FCU_SPEED, Number) ++ (>L:E_FCU_SPEED, Number)',
      maxSteps: 500,
      readback: { fieldId: 'flightGuidance.speedValue', timeoutMs: 1 },
    },
    { input: { type: 'number', min: 100, max: 399, step: 1 } },
    253,
    baseline,
    generationContext,
  );
  assertEqual(stopped.ok, false, 'an accepted transport write without aircraft progress must fail closed');
  assertEqual(stopped.code, 'aircraft_integration_selector_readback_timeout', 'missing progress remains distinguishable');
  assertEqual(noProgress.codes.length, 1, 'missing progress stops after one relative command instead of sending the full burst');

  const drifted = buildFenixFcuProvider({ fenix_speed: 250 }, ({ snapshot }) => {
    snapshot.values.fenix_speed += 2;
    snapshot.snapshotSequence += 1;
    snapshot.updatedAt = new Date().toISOString();
    return { ok: true };
  });
  const driftResult = await drifted.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('flightGuidance.speed.set', 253),
  );
  assertEqual(driftResult.ok, false, 'unexpected multi-detent movement must fail closed');
  assertEqual(driftResult.code, 'aircraft_integration_selector_drift', 'unexpected movement remains distinguishable');
  assertEqual(drifted.codes.length, 1, 'unexpected movement stops before any corrective or additional command');

  const deadlineProvider = new SimConnectTelemetryProvider();
  const deadlineCodes = [];
  const originalDateNow = Date.now;
  let fakeNow = 1_000;
  Date.now = () => fakeNow;
  deadlineProvider._waitForAircraftIntegrationReadback = async () => {
    fakeNow = 181_000;
    return {
      confirmed: true,
      observed: 251,
      sequence: 2,
      fresh: true,
      sourceId: 'lvar:fenix_speed',
      sequenceAdvanced: true,
    };
  };
  let deadlineResult;
  try {
    deadlineResult = await deadlineProvider._executeAircraftIntegrationMobiFlightRoute(
      {
        async executeMobiFlightCode(code) {
          deadlineCodes.push(code);
          return { ok: true };
        },
      },
      {
        mode: 'step-to-target',
        decreaseCode: '(L:E_FCU_SPEED, Number) -- (>L:E_FCU_SPEED, Number)',
        increaseCode: '(L:E_FCU_SPEED, Number) ++ (>L:E_FCU_SPEED, Number)',
        maxSteps: 500,
        readback: { fieldId: 'flightGuidance.speedValue', timeoutMs: 3000 },
      },
      { input: { type: 'number', min: 100, max: 399, step: 1 } },
      252,
      {
        observed: 250,
        sequence: 1,
        fresh: true,
        sourceId: 'lvar:fenix_speed',
      },
    );
  } finally {
    Date.now = originalDateNow;
  }
  assertEqual(deadlineResult.ok, false, 'an expired total deadline must stop the target sequence');
  assertEqual(deadlineResult.code, 'aircraft_integration_selector_readback_timeout', 'deadline expiry remains distinguishable');
  assertEqual(deadlineCodes.length, 1, 'deadline expiry is checked before another unobserved relative step');

  const finalDeadlineProvider = new SimConnectTelemetryProvider();
  const finalDeadlineCodes = [];
  fakeNow = 1_000;
  Date.now = () => fakeNow;
  finalDeadlineProvider._waitForAircraftIntegrationReadback = async () => {
    fakeNow = 181_001;
    return {
      confirmed: true,
      observed: 251,
      sequence: 2,
      fresh: true,
      sourceId: 'lvar:fenix_speed',
      sequenceAdvanced: true,
    };
  };
  let finalDeadlineResult;
  try {
    finalDeadlineResult = await finalDeadlineProvider._executeAircraftIntegrationMobiFlightRoute(
      {
        async executeMobiFlightCode(code) {
          finalDeadlineCodes.push(code);
          return { ok: true };
        },
      },
      {
        mode: 'step-to-target',
        decreaseCode: '(L:E_FCU_SPEED, Number) -- (>L:E_FCU_SPEED, Number)',
        increaseCode: '(L:E_FCU_SPEED, Number) ++ (>L:E_FCU_SPEED, Number)',
        maxSteps: 500,
        readback: { fieldId: 'flightGuidance.speedValue', timeoutMs: 3000 },
      },
      { input: { type: 'number', min: 100, max: 399, step: 1 } },
      251,
      {
        observed: 250,
        sequence: 1,
        fresh: true,
        sourceId: 'lvar:fenix_speed',
      },
    );
  } finally {
    Date.now = originalDateNow;
  }
  assertEqual(finalDeadlineResult.ok, false, 'a final target readback after the deadline must not report success');
  assertEqual(finalDeadlineResult.code, 'aircraft_integration_selector_readback_timeout', 'late final progress reports the sequence deadline');
  assertEqual(finalDeadlineCodes.length, 1, 'late final progress never authorizes another relative step');
});

test('Fenix FCU managed and numeric actions share one physical-knob in-flight guard', async () => {
  let releaseStep;
  const target = buildFenixFcuProvider({
    fenix_speed: 250,
    fenix_speed_managed: 0,
  }, ({ snapshot }) => new Promise((resolve) => {
    releaseStep = () => {
      snapshot.values.fenix_speed = 251;
      snapshot.snapshotSequence += 1;
      snapshot.updatedAt = new Date().toISOString();
      resolve({ ok: true });
    };
  }));
  const action = {
    type: 'aircraft-integration',
    name: FENIX_A32X_ADAPTER_ID,
    verification: 'untested',
  };
  const stepping = target.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('flightGuidance.speed.set', 251),
  );
  while (typeof releaseStep !== 'function') {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const managed = await target.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('flightGuidance.speedManaged.on'),
  );
  assertEqual(managed.ok, false, 'managed push must not race an in-flight speed rotation');
  assertEqual(managed.code, 'action_in_progress', 'shared physical knob reports one in-flight group');
  assertEqual(target.codes.length, 1, 'blocked managed push emits no second calculator command');
  releaseStep();
  const completed = await stepping;
  assertEqual(completed.ok, true, 'original numeric target should still confirm');
});

test('Fenix FCU stepped targets fail closed on mode drift, failed ack, and unsupported baselines', async () => {
  const action = {
    type: 'aircraft-integration',
    name: FENIX_A32X_ADAPTER_ID,
    verification: 'untested',
  };
  const altitude = buildFenixFcuProvider({
    fenix_altitude: 10000,
    fenix_altitude_scale: 1,
  }, ({ codes, snapshot }) => {
    snapshot.values.fenix_altitude += 100;
    snapshot.snapshotSequence += 1;
    snapshot.updatedAt = new Date().toISOString();
    if (codes.length === 1) snapshot.values.fenix_altitude_scale = 0;
    return { ok: true };
  });
  const modeDrift = await altitude.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('flightGuidance.altitudeHundred.set', 10300),
  );
  assertEqual(modeDrift.ok, false, 'altitude scale drift must abort a target burst');
  assertEqual(modeDrift.code, 'aircraft_integration_precondition_failed', 'scale drift reports its precondition');
  assertEqual(altitude.codes.length, 1, 'no second altitude step is sent after scale drift');

  const wrongScale = buildFenixFcuProvider({
    fenix_altitude: 10000,
    fenix_altitude_scale: 0,
  }, () => {
    throw new Error('wrong altitude scale must fail before dispatch');
  });
  const mismatch = await wrongScale.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('flightGuidance.altitudeHundred.set', 10100),
  );
  assertEqual(mismatch.ok, false, 'wrong initial altitude scale must fail closed');
  assertEqual(mismatch.code, 'aircraft_integration_precondition_failed', 'wrong scale reports its precondition');
  assertEqual(wrongScale.codes.length, 0, 'wrong initial altitude scale emits no calculator step');

  const failedAck = buildFenixFcuProvider({ fenix_speed: 250 }, ({ codes, snapshot }) => {
    if (codes.length === 2) return { ok: false, error: 'step rejected' };
    snapshot.values.fenix_speed += 1;
    snapshot.snapshotSequence += 1;
    snapshot.updatedAt = new Date().toISOString();
    return { ok: true };
  });
  const ackResult = await failedAck.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('flightGuidance.speed.set', 253),
  );
  assertEqual(ackResult.ok, false, 'failed selector step must abort the target');
  assertEqual(ackResult.code, 'mobiflight_execution_failed', 'failed step maps through MobiFlight diagnostics');
  assertEqual(failedAck.codes.length, 2, 'failed selector step is never retried');

  const machBaseline = buildFenixFcuProvider({ fenix_speed: 0.82 }, () => {
    throw new Error('Mach-mode baseline must fail before dispatch');
  });
  const unsupported = await machBaseline.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('flightGuidance.speed.set', 250),
  );
  assertEqual(unsupported.ok, false, 'off-domain speed baseline must fail closed');
  assertEqual(unsupported.code, 'aircraft_integration_selector_mode_unsupported', 'Mach mode is distinguishable');
  assertEqual(machBaseline.codes.length, 0, 'off-domain baseline emits no calculator step');

  const staleBaseline = buildFenixFcuProvider({ fenix_speed: 250 }, () => {
    throw new Error('stale selector baseline must fail before dispatch');
  });
  staleBaseline.snapshot.updatedAt = new Date(Date.now() - 10_000).toISOString();
  const stale = await staleBaseline.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('flightGuidance.speed.set', 251),
  );
  assertEqual(stale.ok, false, 'stale selector baseline must fail closed');
  assertEqual(stale.code, 'aircraft_integration_readback_unavailable', 'stale baseline uses the preflight error');
  assertEqual(staleBaseline.codes.length, 0, 'stale baseline emits no calculator step');

  const changedGeneration = buildFenixFcuProvider({ fenix_speed: 250 }, ({ codes, provider }) => {
    if (codes.length === 1) provider._getActiveAircraftIntegrationConfig = () => null;
    return { ok: true };
  });
  const staleDuringSteps = await changedGeneration.provider.executeAircraftControlAction(
    action,
    fenixA320IntegrationOptions('flightGuidance.speed.set', 253),
  );
  assertEqual(staleDuringSteps.ok, false, 'profile change must stop a long selector target');
  assertEqual(staleDuringSteps.code, 'stale_profile', 'profile change remains distinguishable');
  assertEqual(changedGeneration.codes.length, 1, 'no second step reaches a different aircraft generation');

  const provider = new SimConnectTelemetryProvider();
  const bounded = await provider._executeAircraftIntegrationMobiFlightRoute(
    { async executeMobiFlightCode() { throw new Error('501-step route must not dispatch'); } },
    {
      mode: 'step-to-target',
      decreaseCode: 'DEC',
      increaseCode: 'INC',
      maxSteps: 500,
    },
    { input: { type: 'number', min: 0, max: 501, step: 1 } },
    501,
    { observed: 0 },
  );
  assertEqual(bounded.ok, false, 'runtime must retain the 500-step hard cap');
  assertEqual(bounded.code, 'aircraft_integration_selector_mode_unsupported', 'overlong target is rejected');
});

test('Fenix direct LVAR route is available only as the guarded MobiFlight fallback', async () => {
  const provider = new SimConnectTelemetryProvider();
  const snapshot: any = {
    source: 'mock-sidecar',
    profileId: FENIX_A320_PROFILE_KEY,
    values: { fenix_beacon: 0 },
    snapshotSequence: 1,
    updatedAt: new Date().toISOString(),
    mobiflight: {
      state: 'missing',
      connected: false,
      available: false,
      error: null,
    },
  };
  const writes = [];
  const bridge = {
    _started: true,
    getSnapshot: () => snapshot,
    async setNamedVar(operation) {
      writes.push({ ...operation });
      snapshot.values.fenix_beacon = Number(operation.value);
      snapshot.snapshotSequence += 1;
      snapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  stubFenixA320IntegrationFields(provider);

  const capabilities = provider.getAircraftControlCapabilities();
  assertEqual(capabilities.integrationTransports.lvar, true, 'live native sidecar exposes direct LVAR integration writes');
  assertEqual(capabilities.integrationTransports['mobiflight-calculator'], false, 'missing Event Module does not advertise calculator execution');

  const result = await provider.executeAircraftControlAction({
    type: 'aircraft-integration',
    name: FENIX_A32X_ADAPTER_ID,
    verification: 'untested',
  }, fenixA320IntegrationOptions('lights.beacon.on'));

  assertEqual(result.ok, true, 'direct LVAR fallback should retain guarded confirmation');
  assertEqual(result.transportMode, 'direct-lvar', 'result should expose only the bounded diagnostic mode');
  assertEqual(result.confirmedValue, true, 'newer decoded logical readback should confirm the fallback write');
  assertEqual(writes.length, 1, 'fallback must dispatch exactly once');
  assertEqual(writes[0].name, 'L:S_OH_EXT_LT_BEACON', 'trusted adapter owns the exact direct LVAR target');
  assertEqual(writes[0].unit, 'Number', 'direct route preserves the adapter unit');
  assertEqual(writes[0].value, 1, 'direct route preserves the adapter detent');
  assertEqual(writes[0].dataType, 'float64', 'SimConnect LVAR writes must use the documented FLOAT64 representation');
});

test('healthy MobiFlight remains preferred and a failed dispatch never falls through to direct LVAR', async () => {
  function buildProvider(mobiflightResult) {
    const provider = new SimConnectTelemetryProvider();
    const snapshot: any = {
      source: 'mock-sidecar',
      profileId: FENIX_A320_PROFILE_KEY,
      values: { fenix_beacon: 0 },
      snapshotSequence: 1,
      updatedAt: new Date().toISOString(),
      mobiflight: {
        state: 'connected',
        connected: true,
        available: true,
        error: null,
      },
    };
    let mobiflightCalls = 0;
    let directLvarCalls = 0;
    const bridge = {
      _started: true,
      getSnapshot: () => snapshot,
      async executeMobiFlightCode() {
        mobiflightCalls += 1;
        if (mobiflightResult.ok === true) {
          snapshot.values.fenix_beacon = 1;
          snapshot.snapshotSequence += 1;
          snapshot.updatedAt = new Date().toISOString();
        }
        return mobiflightResult;
      },
      async setNamedVar() {
        directLvarCalls += 1;
        return { ok: true };
      },
    };
    provider._lvarBridge = bridge;
    provider._ensureControlWriteBridge = async () => bridge;
    stubFenixA320IntegrationFields(provider);
    return {
      provider,
      getMobiflightCalls: () => mobiflightCalls,
      getDirectLvarCalls: () => directLvarCalls,
    };
  }

  const healthy = buildProvider({ ok: true });
  const success = await healthy.provider.executeAircraftControlAction({
    type: 'aircraft-integration',
    name: FENIX_A32X_ADAPTER_ID,
    verification: 'untested',
  }, fenixA320IntegrationOptions('lights.beacon.on'));
  assertEqual(success.ok, true, 'healthy MobiFlight route should continue to execute');
  assertEqual(success.transportMode, 'mobiflight', 'primary transport should be visible in diagnostics');
  assertEqual(healthy.getMobiflightCalls(), 1, 'preferred MobiFlight route dispatches once');
  assertEqual(healthy.getDirectLvarCalls(), 0, 'direct fallback must not run while MobiFlight is healthy');

  const failing = buildProvider({ ok: false, error: 'calculator rejected command' });
  const failure = await failing.provider.executeAircraftControlAction({
    type: 'aircraft-integration',
    name: FENIX_A32X_ADAPTER_ID,
    verification: 'untested',
  }, fenixA320IntegrationOptions('lights.beacon.on'));
  assertEqual(failure.ok, false, 'failed preferred dispatch should report failure');
  assertEqual(failure.code, 'mobiflight_execution_failed', 'preferred transport failure should remain explicit');
  assertEqual(failing.getMobiflightCalls(), 1, 'failed preferred route is never retried');
  assertEqual(failing.getDirectLvarCalls(), 0, 'one command must never fall through after a MobiFlight dispatch');
});

test('aircraft change telemetry reset clears stale numeric state and restarts warmup', () => {
  const provider = new SimConnectTelemetryProvider();
  provider._data = { ias: 145, altMsl: 5000 };
  provider._rustSimvarData = { ias: 145 };
  provider._rustSimvarUpdatedAt = '2026-06-10T00:00:00.000Z';
  provider._sampleCount = 42;
  provider._overspeedActive = true;
  provider._stallActive = true;
  provider._fuelExhausted = true;

  provider._resetTelemetryForAircraftChange('test');

  assertEqual(Object.keys(provider._data).length, 0, 'live SimConnect data should be cleared');
  assertEqual(Object.keys(provider._rustSimvarData).length, 0, 'Rust SimVar cache should be cleared');
  assertEqual(provider._rustSimvarUpdatedAt, null, 'Rust SimVar timestamp should be cleared');
  assertEqual(provider._sampleCount, 0, 'warning warmup sample count should restart');
  assertEqual(provider._overspeedActive, false, 'overspeed state should reset');
  assertEqual(provider._stallActive, false, 'stall state should reset');
  assertEqual(provider._fuelExhausted, false, 'fuel exhaustion state should reset');
});

test('nextFrame exposes SimConnect warmup state on the returned frame', async () => {
  const provider = new SimConnectTelemetryProvider();
  provider._connected = true;
  provider._available = true;
  provider._data = {
    ias: 140,
    vs: -10,
    ra: 1200,
    gs: 140,
    wow: false,
    userInput: 1,
    paused: false,
  };

  const warmupFrame = await provider.nextFrame();
  assertEqual(warmupFrame.simconnect.warmup, true, 'first frame should be marked as warmup');
  assertEqual(warmupFrame.simconnect.warmupSampleCount, 1, 'first frame warmup sample count');
  assertEqual(warmupFrame.simconnect.warmupSampleLimit, provider._WARNING_WARMUP_SAMPLES, 'warmup sample limit');

  provider._sampleCount = provider._WARNING_WARMUP_SAMPLES;
  const postWarmupFrame = await provider.nextFrame();
  assertEqual(postWarmupFrame.simconnect.warmup, false, 'frame after warmup limit should not be marked warmup');
});

test('fuel exhaustion checks available fuel before EX1 all-fuel totals', async () => {
  const provider = new SimConnectTelemetryProvider();
  provider._connected = true;
  provider._available = true;
  provider._sampleCount = provider._WARNING_WARMUP_SAMPLES;
  provider._data = {
    ias: 140,
    vs: -10,
    ra: 1200,
    gs: 140,
    wow: false,
    userInput: 1,
    paused: false,
    fuelTotalGal: 50,
    fuelTotalGalEx1: 500,
    eng1Combustion: 0,
    eng2Combustion: 0,
  };

  const events = [];
  const unsubscribe = eventBus.on('sim:fuelExhausted', (payload) => {
    events.push(payload);
  });

  try {
    await provider.nextFrame();
  } finally {
    unsubscribe();
  }

  assertEqual(events.length, 1, 'available-fuel starvation should still emit when EX1 includes unusable fuel');
  assertEqual(events[0].fuelGal, 50, 'fuel exhaustion payload should report the available-fuel total');
});

test('nextFrame marks Rust SimConnect disconnected when snapshots go stale', async () => {
  const provider = new SimConnectTelemetryProvider();
  provider._connected = true;
  provider._available = true;
  provider._rustSimvarBridge = {
    getSnapshot() {
      return {
        updatedAt: new Date(Date.now() - 20_000).toISOString(),
        status: 'running',
        values: { ias: 140 },
        subscriptions: [],
      };
    },
  };
  provider._rustSimvarUpdatedAt = new Date(Date.now() - 20_000).toISOString();
  provider._data = {
    ias: 140,
    vs: -10,
    ra: 1200,
    gs: 140,
    wow: false,
    userInput: 1,
    paused: false,
  };

  const frame = await provider.nextFrame();
  assertEqual(frame.simconnect.connected, false, 'stale Rust snapshots should force disconnected frame state');
  assertEqual(provider.isConnected(), false, 'provider connected state should be cleared');
});

test('nextFrame tolerates short Rust SimConnect snapshot gaps during Facilities requests', async () => {
  const provider = new SimConnectTelemetryProvider();
  provider._connected = true;
  provider._available = true;
  provider._rustSimvarBridge = {
    getSnapshot() {
      return {
        updatedAt: new Date(Date.now() - 7_000).toISOString(),
        status: 'running',
        values: { ias: 140 },
        subscriptions: [],
      };
    },
  };
  provider._rustSimvarUpdatedAt = new Date(Date.now() - 7_000).toISOString();
  provider._data = {
    ias: 140,
    vs: -10,
    ra: 1200,
    gs: 140,
    wow: false,
    userInput: 1,
    paused: false,
  };

  const frame = await provider.nextFrame();
  assertEqual(frame.simconnect.connected, true, 'short Rust snapshot gaps should not force disconnected frame state');
  assertEqual(provider.isConnected(), true, 'provider connected state should survive a short snapshot gap');
});

test('Rust AircraftLoaded ignores stale previous TITLE snapshot before delayed emit', async () => {
  const provider = new SimConnectTelemetryProvider();
  provider._lastDetectedAircraftTitle = 'SimObjects\\Airplanes\\OLD\\aircraft.cfg';
  provider._lastDetectedAircraftDisplayName = 'Old Aircraft';

  const events = [];
  const unsubscribe = eventBus.on('simconnect:aircraftChanged', (payload) => {
    events.push(payload);
  });

  try {
    provider._handleRustSystemState({
      name: 'AircraftLoaded',
      string: 'SimObjects\\Airplanes\\NEW\\aircraft.cfg',
      timestampIso: '2026-06-10T00:00:00.000Z',
    });

    provider._handleRustSimvarSnapshot({
      values: {
        [RUST_AIRCRAFT_TITLE_KEY]: 'Old Aircraft',
      },
      updatedAt: '2026-06-10T00:00:00.100Z',
    });

    assertEqual(provider._lastDetectedAircraftDisplayName, null, 'stale old TITLE should not repopulate display name');

    provider._handleRustSimvarSnapshot({
      values: {
        [RUST_AIRCRAFT_TITLE_KEY]: 'New Aircraft',
      },
      updatedAt: '2026-06-10T00:00:00.200Z',
    });

    assertEqual(provider._lastDetectedAircraftDisplayName, 'New Aircraft', 'new TITLE should populate display name');

    await sleep(550);

    assertEqual(events.length, 1, 'exactly one aircraftChanged event');
    assertEqual(events[0].title, 'SimObjects\\Airplanes\\NEW\\aircraft.cfg', 'event title should remain the AircraftLoaded cfg path');
    assertEqual(events[0].displayName, 'New Aircraft', 'event displayName should use the new TITLE');
    assertEqual(events[0].previousTitle, 'SimObjects\\Airplanes\\OLD\\aircraft.cfg', 'previousTitle should remain the previous cfg path');
    assertEqual(events[0].aircraftConfigPath, 'SimObjects\\Airplanes\\NEW\\aircraft.cfg', 'explicit aircraftConfigPath');
    assertEqual(events[0].previousAircraftConfigPath, 'SimObjects\\Airplanes\\OLD\\aircraft.cfg', 'explicit previousAircraftConfigPath');
    assertEqual(events[0].previousDisplayName, 'Old Aircraft', 'explicit previousDisplayName');
  } finally {
    unsubscribe();
    if (provider._rustAircraftChangedTimer) {
      clearTimeout(provider._rustAircraftChangedTimer);
      provider._rustAircraftChangedTimer = null;
    }
    provider._clearRustTitleFallbackTimer();
  }
});

test('Rust AircraftLoaded restores config-path identity after a same-aircraft TITLE fallback', async () => {
  const provider = new SimConnectTelemetryProvider();
  const configPath = 'Community\\example-aircraft\\SimObjects\\Airplanes\\Example Airliner\\aircraft.cfg';
  provider._lastDetectedAircraftTitle = configPath;
  provider._lastDetectedAircraftDisplayName = 'Example Airliner';

  const events = [];
  const unsubscribe = eventBus.on('simconnect:aircraftChanged', (payload) => {
    events.push(payload);
  });

  try {
    provider._handleRustAircraftTitleReadback(
      'Example Airliner Livery',
      '2026-07-22T00:00:00.000Z',
    );

    await sleep(1050);

    assertEqual(events.length, 1, 'TITLE-only fallback should emit once while cfg identity is unconfirmed');
    assertEqual(events[0].aircraftConfigPath, null, 'unconfirmed fallback should not guess a cfg path');

    provider._handleRustSystemState({
      name: 'AircraftLoaded',
      string: configPath,
      timestampIso: '2026-07-22T00:00:02.000Z',
    });

    assertEqual(events.length, 2, 'same-path AircraftLoaded response should repair the identity');
    assertEqual(events[1].displayName, 'Example Airliner Livery', 'repair should retain the current livery title');
    assertEqual(events[1].aircraftConfigPath, configPath, 'repair should restore the aircraft cfg path');
    assertEqual(events[1].previousAircraftConfigPath, configPath, 'same-path repair should not look like an aircraft swap');
    assertEqual(provider._rustTitleFallbackNeedsPathConfirmation, false, 'repair should clear the pending confirmation');
  } finally {
    unsubscribe();
    if (provider._rustAircraftChangedTimer) {
      clearTimeout(provider._rustAircraftChangedTimer);
      provider._rustAircraftChangedTimer = null;
    }
    provider._clearRustTitleFallbackTimer();
  }
});

test('spoiler armed state regression', () => {
  const spoilersStowed = makeSpoilersObj(0, { scale: 'percent', armed: false });
  assertEqual(spoilersStowed.state, 'STOWED', 'spoilers 0% not armed should be STOWED');
  assertEqual(spoilersStowed.percent, 0, 'spoilers 0% percent should be 0');

  const spoilersArmed = makeSpoilersObj(0, { scale: 'percent', armed: true });
  assertEqual(spoilersArmed.state, 'ARMED', 'spoilers 0% with armed=true should be ARMED');
  assertEqual(spoilersArmed.percent, 0, 'spoilers armed percent should be 0');

  const spoilersExtended = makeSpoilersObj(50, { scale: 'percent', armed: true });
  assertEqual(spoilersExtended.state, 'EXTENDED', 'spoilers 50% should be EXTENDED regardless of armed flag');
  assertEqual(spoilersExtended.percent, 50, 'spoilers 50% percent should be 50');
});

test('VFE vs VMO overspeed classification', () => {
  assertEqual(classifyOverspeedType(350, 0), 'vmo', 'Flaps 0%, barber 350 kts → VMO');
  assertEqual(classifyOverspeedType(250, 0), 'vmo', 'Flaps 0%, barber 250 kts → VMO (low barber but no flaps)');
  assertEqual(classifyOverspeedType(330, 3), 'vmo', 'Flaps 3%, barber 330 kts → VMO (minimal flaps)');
  assertEqual(classifyOverspeedType(null, 0), 'vmo', 'Flaps 0%, no barber data → VMO (default)');

  assertEqual(classifyOverspeedType(235, 30), 'vfe', 'Flaps 30%, barber 235 kts → VFE (A320 Flaps 1+F)');
  assertEqual(classifyOverspeedType(200, 50), 'vfe', 'Flaps 50%, barber 200 kts → VFE (typical approach)');
  assertEqual(classifyOverspeedType(185, 100), 'vfe', 'Flaps 100%, barber 185 kts → VFE (full flaps)');
  assertEqual(classifyOverspeedType(150, 40), 'vfe', 'Flaps 40%, barber 150 kts → VFE (GA/turboprop)');
  assertEqual(classifyOverspeedType(265, 10), 'vmo', 'Flaps 10%, barber 265 kts → VMO (small-flap ambiguous)');

  assertEqual(classifyOverspeedType(320, 25), 'vfe', 'Flaps 25%, barber 320 kts → VFE (flaps deployed)');
  assertEqual(classifyOverspeedType(340, 40), 'vfe', 'Flaps 40%, barber 340 kts → VFE (flaps significantly out)');
  assertEqual(classifyOverspeedType(340, 8), 'vmo', 'Flaps 8%, barber 340 kts → VMO (minimal flaps, high limit)');
  assertEqual(classifyOverspeedType(320, 15), 'vmo', 'Flaps 15%, barber 320 kts → VMO (partial flaps, high limit)');
  assertEqual(classifyOverspeedType(226, 8), 'vmo', 'King Air-style low VMO with small flaps → VMO (avoid false VFE)');
  assertEqual(classifyOverspeedType(250, 10), 'vmo', 'ATR-style low VMO with small flaps → VMO (avoid false VFE)');

  assertEqual(classifyOverspeedType(null, 30), 'vmo', 'Flaps 30%, no barber data → VMO (default)');
  assertEqual(classifyOverspeedType(undefined, 50), 'vmo', 'Flaps 50%, undefined barber → VMO (default)');

  assertEqual(classifyOverspeedType(255, 8), 'vmo', '777 Flaps 1 overspeed → VMO (small-flap ambiguous)');
  assertEqual(classifyOverspeedType(235, 25), 'vfe', '777 Flaps 5 overspeed → VFE');
  assertEqual(classifyOverspeedType(330, 0), 'vmo', '777 clean overspeed → VMO');
  assertEqual(classifyOverspeedType(230, 15), 'vmo', 'A320 Flaps 1 overspeed → VMO (small-flap ambiguous)');
  assertEqual(classifyOverspeedType(200, 35), 'vfe', 'A320 Flaps 2 overspeed → VFE');
  assertEqual(classifyOverspeedType(185, 100), 'vfe', 'A320 Flaps FULL overspeed → VFE');
  assertEqual(classifyOverspeedType(120, 40), 'vfe', 'Cessna flaps overspeed → VFE');
  assertEqual(classifyOverspeedType(150, 0), 'vmo', 'Cessna clean overspeed → VMO');
});

// ═══════════════════════════════════════════════════════════════════════════
// Menu / In-Flight Detection (computeMenuState)
// ═══════════════════════════════════════════════════════════════════════════

// Baseline: all signals say "in flight"
const IN_FLIGHT_BASELINE = {
  systemSim: 1,            // SystemState('Sim') = flying
  simRunningRaw: true,     // SimStart received
  cameraState: 2,          // cockpit camera
  crashFlag: false,
  crashSequence: 0,
  userInput: true,
  paused: false,
};

test('computeMenuState: normal in-flight returns not-in-menu', () => {
  const r = computeMenuState(IN_FLIGHT_BASELINE);
  assertEqual(r.effectiveInMenu, false, 'effectiveInMenu');
  assertEqual(r.inFlightContext, true, 'inFlightContext');
  assertEqual(r.simRunning, true, 'simRunning');
});

test('computeMenuState: SystemState Sim=0 (main menu)', () => {
  const r = computeMenuState({ ...IN_FLIGHT_BASELINE, systemSim: 0 });
  assertEqual(r.effectiveInMenu, true, 'menu when Sim=0');
  assertEqual(r.inFlightContext, false, 'no flight context in menu');
});

test('computeMenuState: SimStop event (simRunning=false)', () => {
  const r = computeMenuState({ ...IN_FLIGHT_BASELINE, simRunningRaw: false });
  assertEqual(r.effectiveInMenu, true, 'menu when sim stopped');
  assertEqual(r.inFlightContext, false, 'no flight context when sim stopped');
  assertEqual(r.simRunning, false, 'simRunning reflects event');
});

test('computeMenuState: camera not user-controlled (cameraState > 6)', () => {
  const r = computeMenuState({ ...IN_FLIGHT_BASELINE, cameraState: 10 });
  assertEqual(r.effectiveInMenu, true, 'menu when camera state > 6');
  assertEqual(r.inFlightContext, false, 'no flight context in replay camera');
});

test('computeMenuState: crash flag active', () => {
  const r = computeMenuState({ ...IN_FLIGHT_BASELINE, crashFlag: true });
  assertEqual(r.effectiveInMenu, true, 'menu when crashed');
  assertEqual(r.inFlightContext, false, 'no flight context during crash');
});

test('computeMenuState: crash flag as numeric 1', () => {
  const r = computeMenuState({ ...IN_FLIGHT_BASELINE, crashFlag: 1 });
  assertEqual(r.effectiveInMenu, true, 'crashFlag=1 counts as crash');
});

test('computeMenuState: crash flag as documented enum code', () => {
  const r = computeMenuState({ ...IN_FLIGHT_BASELINE, crashFlag: 4 });
  assertEqual(r.effectiveInMenu, true, 'non-zero crashFlag enum counts as crash');
  assertEqual(r.crashFlagActive, true, 'non-zero crashFlag enum is active');
});

test('computeMenuState: crash sequence > 0', () => {
  const r = computeMenuState({ ...IN_FLIGHT_BASELINE, crashFlag: false, crashSequence: 3 });
  assertEqual(r.effectiveInMenu, true, 'menu during crash sequence');
  assertEqual(r.inFlightContext, false, 'no flight context during crash sequence');
});

test('computeMenuState: user input disabled (loading screen)', () => {
  const r = computeMenuState({ ...IN_FLIGHT_BASELINE, userInput: false });
  assertEqual(r.inFlightContext, false, 'no flight context without user input');
});

test('computeMenuState: sim paused', () => {
  const r = computeMenuState({ ...IN_FLIGHT_BASELINE, paused: true });
  assertEqual(r.effectiveInMenu, false, 'paused is NOT menu');
  assertEqual(r.inFlightContext, false, 'paused blocks flight context');
});

test('computeMenuState: no SystemState yet, fallback to userInput', () => {
  // Before SystemState arrives, systemSim is null/undefined
  const menu = computeMenuState({ ...IN_FLIGHT_BASELINE, systemSim: null, userInput: false });
  assertEqual(menu.effectiveInMenu, true, 'fallback: userInput=false → menu');

  const flying = computeMenuState({ ...IN_FLIGHT_BASELINE, systemSim: null, userInput: true });
  assertEqual(flying.effectiveInMenu, false, 'fallback: userInput=true → not menu');
  assertEqual(flying.inFlightContext, true, 'fallback: full flight context');
});

test('computeMenuState: no simRunning event, derives from systemSim', () => {
  const r = computeMenuState({ ...IN_FLIGHT_BASELINE, simRunningRaw: null, systemSim: 1 });
  assertEqual(r.simRunning, true, 'derives simRunning from Sim=1');

  const r2 = computeMenuState({ ...IN_FLIGHT_BASELINE, simRunningRaw: null, systemSim: 0 });
  assertEqual(r2.simRunning, false, 'derives simRunning from Sim=0');
});

test('computeMenuState: no signals at all (fresh connect)', () => {
  const r = computeMenuState({
    systemSim: null,
    simRunningRaw: null,
    cameraState: null,
    crashFlag: null,
    crashSequence: null,
    userInput: null,
    paused: null,
  });
  // No SystemState yet, userInput not false → base not menu
  // Camera null → assume user control
  // simRunning null → not false → no menu override
  assertEqual(r.effectiveInMenu, false, 'fresh connect defaults to not-menu');
  assertEqual(r.simRunning, null, 'simRunning unknown');
});

test('computeMenuState: multiple menu signals combine (OR logic)', () => {
  // SystemState says flying but camera is in replay mode
  const r = computeMenuState({ ...IN_FLIGHT_BASELINE, systemSim: 1, cameraState: 15 });
  assertEqual(r.effectiveInMenu, true, 'camera override even when Sim=1');

  // SystemState says flying but sim crashed
  const r2 = computeMenuState({ ...IN_FLIGHT_BASELINE, systemSim: 1, crashFlag: true });
  assertEqual(r2.effectiveInMenu, true, 'crash override even when Sim=1');
});

test('SimConnectTelemetryProvider stop awaits all sidecar bridge shutdowns', async () => {
  const provider = new SimConnectTelemetryProvider();
  const stopCalls = [];
  const releases: Array<() => void> = [];
  const makeBridge = (name: string) => ({
    stop() {
      stopCalls.push(name);
      return new Promise<void>((resolve) => releases.push(resolve));
    },
  });
  provider._lvarBridge = makeBridge('lvar');
  provider._sdkBridge = makeBridge('sdk');
  provider._rustSimvarBridge = makeBridge('rust-simvars');

  let settled = false;
  const stopPromise = provider.stop().then(() => {
    settled = true;
  });
  await Promise.resolve();

  assertEqual(stopCalls.join(','), 'lvar,sdk,rust-simvars', 'all bridge stops should start together');
  assertEqual(settled, false, 'provider stop must remain pending while bridges are stopping');
  assertEqual(provider._lvarBridge !== null, true, 'LVAR bridge remains tracked until its stop confirms exit');
  assertEqual(provider._sdkBridge !== null, true, 'SDK bridge remains tracked until its stop confirms exit');
  assertEqual(provider._rustSimvarBridge !== null, true, 'Rust SimVar bridge remains tracked until its stop confirms exit');

  releases[0]();
  releases[1]();
  await Promise.resolve();
  assertEqual(settled, false, 'provider stop must wait for the last bridge');
  releases[2]();
  await stopPromise;
  assertEqual(settled, true, 'provider stop resolves after every bridge stops');
  assertEqual(provider._lvarBridge, null, 'LVAR bridge clears after confirmed stop');
  assertEqual(provider._sdkBridge, null, 'SDK bridge clears after confirmed stop');
  assertEqual(provider._rustSimvarBridge, null, 'Rust SimVar bridge clears after confirmed stop');
});

test('SimConnectTelemetryProvider stop preserves failed bridges and rejects after all attempts settle', async () => {
  const provider = new SimConnectTelemetryProvider();
  const stopCalls = [];
  let releaseSdkStop;
  let releaseRustStop;
  const failedLvarBridge = {
    stop() {
      stopCalls.push('lvar');
      return Promise.reject(new Error('lvar process remained alive'));
    },
  };
  const sdkBridge = {
    stop() {
      stopCalls.push('sdk');
      return new Promise<void>((resolve) => { releaseSdkStop = resolve; });
    },
  };
  const rustBridge = {
    stop() {
      stopCalls.push('rust-simvars');
      return new Promise<void>((resolve) => { releaseRustStop = resolve; });
    },
  };
  provider._lvarBridge = failedLvarBridge;
  provider._sdkBridge = sdkBridge;
  provider._rustSimvarBridge = rustBridge;

  let stopError = null;
  let settled = false;
  const stopPromise = provider.stop()
    .catch((error) => { stopError = error; })
    .then(() => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();

  assertEqual(stopCalls.sort().join(','), 'lvar,rust-simvars,sdk', 'all bridge stops start despite one rejection');
  assertEqual(settled, false, 'provider waits for every stop attempt before rejecting');
  releaseSdkStop();
  releaseRustStop();
  await stopPromise;

  assertEqual(stopError instanceof AggregateError, true, 'provider reports failed bridge stops as an aggregate error');
  assertEqual(
    String(stopError?.message || '').includes('failed to stop'),
    true,
    'provider stop error describes the failed shutdown',
  );
  assertEqual(provider._lvarBridge, failedLvarBridge, 'failed LVAR bridge remains tracked for retry or final tree cleanup');
  assertEqual(provider._sdkBridge, null, 'successfully stopped SDK bridge clears');
  assertEqual(provider._rustSimvarBridge, null, 'successfully stopped Rust bridge clears');
});

test('SimConnectTelemetryProvider stop neutralizes an LVAR init that completes after shutdown begins', async () => {
  const provider = new SimConnectTelemetryProvider();
  let releaseStart;
  let signalStartEntered;
  let signalStopEntered;
  const startEntered = new Promise<void>((resolve) => { signalStartEntered = resolve; });
  const stopEntered = new Promise<void>((resolve) => { signalStopEntered = resolve; });
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  let startCalls = 0;
  let stopCalls = 0;
  const bridge = {
    _started: false,
    _proc: null,
    isEnabled() { return true; },
    async start() {
      startCalls += 1;
      signalStartEntered();
      await startGate;
      this._started = true;
      this._proc = { exitCode: null, signalCode: null };
    },
    async stop() {
      stopCalls += 1;
      signalStopEntered();
      this._started = false;
      this._proc = null;
    },
  };
  provider._lvarBridge = bridge;
  provider._reloadLvarSubscriptions = () => {};

  const initPromise = provider._initLvarBridge();
  await startEntered;
  const stopPromise = provider.stop();
  await stopEntered;

  const rejectedControl = await provider.executeAircraftControlAction({
    type: 'key-event',
    name: 'TEST_EVENT',
  });
  assertEqual(rejectedControl.code, 'provider_stopping', 'shutdown rejects control ensures before they can restart LVAR');

  releaseStart();
  await Promise.all([initPromise, stopPromise]);

  assertEqual(startCalls, 1, 'the already-entered initializer runs only once');
  assertEqual(stopCalls >= 2, true, 'the stale initializer reaps the child it published after the first stop');
  assertEqual(bridge._started, false, 'late LVAR child is no longer started');
  assertEqual(bridge._proc, null, 'late LVAR child process is reaped');
  assertEqual(provider._lvarBridge, null, 'provider clears the bridge only after stale init is neutralized');
});

test('SimConnectTelemetryProvider serializes concurrent SDK replacement requests', async () => {
  const provider = new SimConnectTelemetryProvider();
  const { SdkBridge } = require('./sdk-bridge');
  const originalStart = SdkBridge.prototype.start;
  const originalStop = SdkBridge.prototype.stop;
  const originalConnect = SdkBridge.prototype.connect;
  let releasePriorStop;
  let signalPriorStopEntered;
  const priorStopEntered = new Promise<void>((resolve) => { signalPriorStopEntered = resolve; });
  const priorStopGate = new Promise<void>((resolve) => { releasePriorStop = resolve; });
  let priorStopCalls = 0;
  let replacementStarts = 0;
  const priorBridge = {
    _adapter: { id: 'prior-adapter' },
    _started: true,
    async stop() {
      priorStopCalls += 1;
      signalPriorStopEntered();
      await priorStopGate;
      this._started = false;
    },
  };
  provider._sdkBridge = priorBridge;
  provider._resolveActiveSdkProfile = () => ({
    adapter: { id: 'replacement-adapter', displayName: 'Replacement SDK' },
    profileSdk: { target: { aircraft: 'test' } },
  });

  SdkBridge.prototype.start = async function startReplacement() {
    replacementStarts += 1;
    this._started = true;
    this._proc = { exitCode: null, signalCode: null };
  };
  SdkBridge.prototype.stop = async function stopReplacement() {
    this._started = false;
    this._proc = null;
  };
  SdkBridge.prototype.connect = function connectReplacement() {};

  try {
    const first = provider._initSdkBridge();
    await priorStopEntered;
    const second = provider._initSdkBridge();
    releasePriorStop();
    await Promise.all([first, second]);

    assertEqual(priorStopCalls, 1, 'concurrent SDK requests share the prior bridge stop');
    assertEqual(replacementStarts, 1, 'only one replacement SDK sidecar starts');
    assertEqual(provider._sdkBridge?._adapter?.id, 'replacement-adapter', 'one current replacement remains tracked');
    await provider.stop();
  } finally {
    SdkBridge.prototype.start = originalStart;
    SdkBridge.prototype.stop = originalStop;
    SdkBridge.prototype.connect = originalConnect;
    if (provider._sdkAircraftListener) {
      eventBus.off('simconnect:aircraftChanged', provider._sdkAircraftListener);
      provider._sdkAircraftListener = null;
    }
  }
});

test('SimConnectTelemetryProvider never clears a bridge that remains live after fulfilled stops', async () => {
  const provider = new SimConnectTelemetryProvider();
  let stopCalls = 0;
  const liveBridge = {
    _started: true,
    _proc: { exitCode: null, signalCode: null },
    async stop() {
      stopCalls += 1;
      // Adversarial bridge: claims success while retaining a live child.
    },
  };
  provider._lvarBridge = liveBridge;

  let stopError = null;
  await provider.stop().catch((error) => { stopError = error; });

  assertEqual(stopCalls, 2, 'provider performs a final stop attempt after detecting a live fulfilled bridge');
  assertEqual(stopError instanceof AggregateError, true, 'live-after-success invariant is reported');
  assertEqual(provider._lvarBridge, liveBridge, 'live bridge reference is preserved for final tree cleanup');
});

test('SimConnectTelemetryProvider contains optional bridge start failures but rejects mandatory Rust startup', async () => {
  const provider = new SimConnectTelemetryProvider();
  const failure = new Error('asynchronous spawn failure');
  let lvarStarts = 0;
  let sdkStarts = 0;
  let rustStarts = 0;

  provider._lvarBridge = {
    _started: false,
    isEnabled() { return true; },
    async start() {
      lvarStarts += 1;
      throw failure;
    },
  };
  await provider._initLvarBridge();

  provider._resolveActiveSdkProfile = () => ({
    adapter: { id: 'optional-sdk', displayName: 'Optional SDK' },
    profileSdk: { target: {} },
  });
  provider._sdkBridge = {
    _adapter: { id: 'optional-sdk' },
    _started: false,
    async start() {
      sdkStarts += 1;
      throw failure;
    },
  };
  await provider._initSdkBridge();

  provider._rustSimvarBridge = {
    async start() {
      rustStarts += 1;
      throw failure;
    },
  };
  let rustFailure = null;
  await provider._initRustSimvarBridge().catch((error) => { rustFailure = error; });

  assertEqual(lvarStarts, 1, 'optional LVAR start is attempted once');
  assertEqual(sdkStarts, 1, 'optional SDK start is attempted once');
  assertEqual(rustStarts, 1, 'mandatory Rust start is attempted once');
  assertEqual(rustFailure, failure, 'mandatory Rust start failure propagates');
  assertEqual(provider._available, false, 'mandatory Rust start failure marks the provider unavailable');

  if (provider._sdkAircraftListener) {
    eventBus.off('simconnect:aircraftChanged', provider._sdkAircraftListener);
    provider._sdkAircraftListener = null;
  }
});

test('SimConnectTelemetryProvider preserves a prior SDK bridge that stays live after a fulfilled stop', async () => {
  const provider = new SimConnectTelemetryProvider();
  let stopCalls = 0;
  const priorBridge = {
    _adapter: { id: 'prior-adapter' },
    _started: true,
    _proc: { exitCode: null, signalCode: null },
    async stop() {
      stopCalls += 1;
      // Adversarial bridge: resolves without terminating its child.
    },
  };
  provider._sdkBridge = priorBridge;
  provider._resolveActiveSdkProfile = () => ({
    adapter: { id: 'replacement-adapter' },
    profileSdk: { target: {} },
  });

  let replacementError = null;
  await provider._initSdkBridge().catch((error) => { replacementError = error; });

  assertEqual(stopCalls, 1, 'replacement attempts to stop the prior SDK bridge once');
  assertEqual(
    String(replacementError?.message || '').includes('remained live'),
    true,
    'replacement reports a prior bridge that falsely claims to have stopped',
  );
  assertEqual(provider._sdkBridge, priorBridge, 'live prior SDK bridge remains tracked');

  if (provider._sdkAircraftListener) {
    eventBus.off('simconnect:aircraftChanged', provider._sdkAircraftListener);
    provider._sdkAircraftListener = null;
  }
});

test('SimConnectTelemetryProvider refuses SDK bridge replacement when the prior stop fails', async () => {
  const provider = new SimConnectTelemetryProvider();
  let rejectPriorStop;
  let stopCalls = 0;
  const priorBridge = {
    _adapter: { id: 'prior-adapter' },
    stop() {
      stopCalls += 1;
      return new Promise<void>((_resolve, reject) => { rejectPriorStop = reject; });
    },
  };
  provider._sdkBridge = priorBridge;
  provider._resolveActiveSdkProfile = () => ({
    adapter: { id: 'replacement-adapter' },
    profileSdk: { target: {} },
  });

  let replacementError = null;
  let settled = false;
  const replacementPromise = provider._initSdkBridge()
    .catch((error) => { replacementError = error; })
    .then(() => { settled = true; });
  await Promise.resolve();

  assertEqual(stopCalls, 1, 'replacement starts by stopping the prior bridge');
  assertEqual(settled, false, 'replacement waits for the prior stop result');
  assertEqual(provider._sdkBridge, priorBridge, 'prior bridge remains installed while its stop is pending');

  rejectPriorStop(new Error('prior SDK sidecar remained alive'));
  await replacementPromise;

  assertEqual(
    String(replacementError?.message || '').includes('remained alive'),
    true,
    'replacement propagates the prior stop failure',
  );
  assertEqual(provider._sdkBridge, priorBridge, 'failed prior bridge is not replaced or lost');

  if (provider._sdkAircraftListener) {
    eventBus.off('simconnect:aircraftChanged', provider._sdkAircraftListener);
    provider._sdkAircraftListener = null;
  }
});

export {};
