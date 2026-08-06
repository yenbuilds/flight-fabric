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
    name: 'BEACON_LIGHTS_ON',
  }, profileOptions);

  assertEqual(result.ok, true, 'matching profile generation should dispatch');
  assertEqual(sendEventCalls, 1, 'matching request should reach the native bridge once');
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
