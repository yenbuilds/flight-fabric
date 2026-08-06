#!/usr/bin/env node

'use strict';

const {
  buildEnginesBroadcastData,
  buildVreEnrichedFrame,
  computeHeadingAndMagvar,
  computeSimStateMenuFlag,
  createRunwayContextDetector,
  deriveApproachConfigurationState,
  isVreCsvSampleDue,
  MAX_VRE_CSV_SAMPLE_RATE_HZ,
  resolveLandingGeometryScoringInputs,
  resolveVreSamplingRate,
  resolveAircraftSpecificTemplateId,
} = require('./simbridge-core-utils');

type AnyRecord = Record<string, any>;

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}: ${e.message}`);
    failed++;
  }
}

function buildBaseArgs(overrides: AnyRecord = {}): AnyRecord {
  return {
    frame: {
      wow: false,
      lat: 47.45,
      lon: -122.31,
      gforce: 1.05,
      assists: null,
      simconnect: { simVersion: 'MSFS' },
      ...overrides.frame,
    },
    userId: 'user-1',
    sessionId: 'session-1',
    nowEpochMs: 1_700_000_000_000,
    timestampIso: '2026-05-17T00:00:00.000Z',
    flightId: 'flight-1',
    flightStartIso: '2026-05-17T00:00:00.000Z',
    flightStartEpochMs: 1_700_000_000_000,
    sampleRateHz: 4,
    escalationReason: 'steady',
    phase: 'APPROACH',
    stability: 'stable',
    iasKnots: 145,
    gs: 150,
    vsFeetPerMin: -600,
    altMslFt: 2500,
    raFeet: 800,
    xwind: 12,
    trend: -1.5,
    headingData: { hdgTrueDeg: 165, hdgMagDeg: 170, magvarDeg: -5 },
    pitchDeg: 2,
    bankDeg: 1,
    maxPitchBankDeg: 90,
    windSpeed: 18,
    windDir: 210,
    gearDownLocked: true,
    flapsNotch: '30',
    flaps: { percent: 75, notch: '30' },
    flapsSource: 'profile',
    spoilerPct: 0,
    spoilerState: 'STOWED',
    spoilerSource: 'simconnect',
    spoilerAvailable: true,
    brakePct: 0,
    thr1Pct: 55,
    thr2Pct: 55,
    thr3Pct: null,
    thr4Pct: null,
    profileId: 'test-profile',
    signalReliability: 'good',
    dataSource: 'simconnect',
    aircraftName: 'Test Aircraft',
    fdm: {
      tasKts: 152,
      pitchRateRadS: 0.01,
      rollRateRadS: 0.02,
      yawRateRadS: 0.03,
      yokeXPct: 5,
      yokeYPct: -3,
      rudderPedalPct: 2,
      aileronPct: 1,
      elevatorPct: -1,
      rudderPct: 2,
      elevTrimPct: 3,
      eng1N1: 92,
      eng2N1: 93,
      eng1N2: 88,
      eng2N2: 89,
      eng1EgtC: 650,
      eng2EgtC: 655,
      eng1FfPph: 5100,
      eng2FfPph: 5150,
      fuelTotalGal: 4200,
      fuelTotalPct: 61,
      fuelTotalWeightLbs: 28140,
      fuelWeightPerGal: 6.7,
      grossWeightLbs: 132000,
      cgPct: 24.5,
      apMaster: true,
      apAltHold: true,
      apHdgHold: false,
      apNavHold: true,
      apApprHold: false,
      apVsHold: false,
      apFdActive: true,
      apLvlChgHold: true,
      apSpeedHold: true,
      apAltTargetFt: 3000,
      apHdgTargetDeg: 180,
      apVsTargetFpm: -700,
      apSpeedTargetKts: 145,
      apMachTarget: 0.78,
      athrActive: true,
      athrArmed: true,
      oatC: 6,
      tatC: 8,
      pressureMb: 1008.5,
      seaLevelPressureMb: 1013.2,
      visibilityM: 8000,
      precipRateMm: 1.25,
      precipState: 2,
      inCloud: true,
      surfaceCondition: 1,
      densityAltFt: 3200,
      cabinAltFt: 7000,
      cabinAltRateFpm: 200,
      cabinDeltaPPsi: 7.8,
      cabinAltTargetFt: 6500,
      cabinDumpSwitch: false,
      ...overrides.fdm,
    },
    autopilotReliability: {
      apReliable: true,
      athrReliable: true,
      reason: 'simconnect-only',
      ...overrides.autopilotReliability,
    },
    elapsedMs: 30_000,
    ...overrides,
  };
}

console.log('\nresolveAircraftSpecificTemplateId');

test('resolves an adapter-owned aircraft-specific template without legacy presentation data', () => {
  const profile = {
    integration: {
      aircraftSpecific: { adapter: 'test-adapter' },
    },
  };

  assert(
    resolveAircraftSpecificTemplateId({ templateId: ' test-adapter ' }, profile) === 'test-adapter',
    'expected the effective adapter template to be normalized and returned',
  );
});

test('falls back to the legacy profile-owned template and handles generic profiles', () => {
  const profile = {
    integration: {
      presentation: {
        aircraftSpecific: { template: ' legacy-template ' },
      },
    },
  };

  assert(
    resolveAircraftSpecificTemplateId(null, profile) === 'legacy-template',
    'expected legacy template fallback to remain compatible',
  );
  assert(resolveAircraftSpecificTemplateId(null, null) === null, 'expected no template for generic profiles');
});

console.log('\ncomputeSimStateMenuFlag');

test('does not report menu state when simulator is disconnected', () => {
  const inMenu = computeSimStateMenuFlag({
    simconnectConnected: false,
    providerInMenu: true,
    lifecycleInMenu: true,
    simSystemInMenu: true,
    dialogInMenu: true,
    simconnectGateOk: false,
    isGlobeView: true,
  });

  assert(inMenu === false, 'disconnected simulator must not be classified as in-menu');
});

test('does not treat parked/no-flight context as menu by itself', () => {
  const inMenu = computeSimStateMenuFlag({
    simconnectConnected: true,
    providerInMenu: false,
    lifecycleInMenu: false,
    simSystemInMenu: false,
    dialogInMenu: false,
    simconnectGateOk: false,
    isGlobeView: false,
  });

  assert(inMenu === false, 'connected parked aircraft must not be classified as in-menu only because flight context is false');
});

test('reports menu state for connected explicit menu blockers', () => {
  const explicitBlockers = [
    { providerInMenu: true },
    { lifecycleInMenu: true },
    { simSystemInMenu: true },
    { dialogInMenu: true },
    { isGlobeView: true },
  ];

  for (const blocker of explicitBlockers) {
    const inMenu = computeSimStateMenuFlag({
      simconnectConnected: true,
      providerInMenu: false,
      lifecycleInMenu: false,
      simSystemInMenu: false,
      dialogInMenu: false,
      simconnectGateOk: true,
      isGlobeView: false,
      ...blocker,
    });

    assert(inMenu === true, `expected blocker ${Object.keys(blocker)[0]} to report in-menu`);
  }
});

console.log('\ncomputeHeadingAndMagvar');

test('derives true heading from magnetic heading and magvar', () => {
  const headingData = computeHeadingAndMagvar({
    sc: {
      hdgMagDeg: 267,
      magvarDeg: 14,
    },
  });

  assert(headingData.hdgTrueDeg === 253, `expected true heading 253, got ${headingData.hdgTrueDeg}`);
  assert(headingData.hdgMagDeg === 267, `expected magnetic heading 267, got ${headingData.hdgMagDeg}`);
  assert(headingData.magvarDeg === 14, `expected magvar 14, got ${headingData.magvarDeg}`);
});

test('derives magnetic heading from true heading and magvar', () => {
  const headingData = computeHeadingAndMagvar({
    sc: {
      hdgTrueDeg: 253,
      magvarDeg: 14,
    },
  });

  assert(headingData.hdgTrueDeg === 253, `expected true heading 253, got ${headingData.hdgTrueDeg}`);
  assert(headingData.hdgMagDeg === 267, `expected magnetic heading 267, got ${headingData.hdgMagDeg}`);
  assert(headingData.magvarDeg === 14, `expected magvar 14, got ${headingData.magvarDeg}`);
});

console.log('\ncreateRunwayContextDetector');

test('caches runway context during approach and clears after returning to ground', () => {
  let runwayLookups = 0;
  const detectAirportRunway = createRunwayContextDetector({
    approachPhases: new Set(['APPROACH']),
    groundPhases: new Set(['TAXI', 'PARKED']),
    landingPhase: 'LANDING',
    findRunwayByPosition() {
      runwayLookups++;
      return { icao: 'KSEA', runway: '16L' };
    },
    findNearbyAirport() {
      throw new Error('airport lookup should not run when runway matches');
    },
  });

  const approach = detectAirportRunway(47.45, -122.31, 160, 'APPROACH');
  const firstGroundTick = detectAirportRunway(47.45, -122.31, 160, 'TAXI');
  const secondGroundTick = detectAirportRunway(47.45, -122.31, 160, 'TAXI');

  assert(runwayLookups === 1, 'expected one runway lookup while cached');
  assert(approach.runway === '16L', 'expected approach runway context');
  assert(firstGroundTick.runway === '16L', 'expected cached runway on first ground tick');
  assert(secondGroundTick.runway === null, 'expected cache cleared after ground tick');
});

test('runway context cache is separated by geometry lookup context', () => {
  let runwayLookups = 0;
  const seenSimulators: string[] = [];
  const detectAirportRunway = createRunwayContextDetector({
    approachPhases: new Set(['APPROACH']),
    groundPhases: new Set(['TAXI']),
    landingPhase: 'LANDING',
    findRunwayByPosition(_lat, _lon, _radiusNm, _headingDeg, context) {
      runwayLookups++;
      const simulator = context && typeof context.simulator === 'string' ? context.simulator : 'generic';
      seenSimulators.push(simulator);
      return { icao: 'KSEA', runway: simulator === 'msfs' ? '16R' : '16L' };
    },
    findNearbyAirport() {
      throw new Error('airport lookup should not run when runway matches');
    },
  });

  const xplane = detectAirportRunway(47.45, -122.31, 160, 'APPROACH', { simulator: 'xplane' });
  const msfs = detectAirportRunway(47.45, -122.31, 160, 'APPROACH', { simulator: 'msfs' });

  assert(runwayLookups === 2, 'expected a new lookup when simulator context changes');
  assert(seenSimulators.join(',') === 'xplane,msfs', 'expected context to be forwarded to geometry lookup');
  assert(xplane.runway === '16L', 'expected first lookup result');
  assert(msfs.runway === '16R', 'expected context-specific lookup result');
});

test('retries airport-only approach cache until a runway is found', () => {
  let runwayLookups = 0;
  const detectAirportRunway = createRunwayContextDetector({
    approachPhases: new Set(['APPROACH']),
    groundPhases: new Set(['TAXI']),
    landingPhase: 'LANDING',
    findRunwayByPosition() {
      runwayLookups++;
      return runwayLookups === 2 ? { icao: 'KSEA', runway: '16C' } : null;
    },
    findNearbyAirport() {
      return { icao: 'KSEA' };
    },
  });

  const airportOnly = detectAirportRunway(47.45, -122.31, 160, 'APPROACH');
  const runwayMatch = detectAirportRunway(47.45, -122.31, 160, 'APPROACH');

  assert(runwayLookups === 2, 'expected retry when cache has airport but no runway');
  assert(airportOnly.icao === 'KSEA' && airportOnly.runway === null, 'expected airport-only context first');
  assert(runwayMatch.icao === 'KSEA' && runwayMatch.runway === '16C', 'expected runway context after retry');
});

test('skips runway lookup for invalid approach coordinates', () => {
  let runwayLookups = 0;
  const detectAirportRunway = createRunwayContextDetector({
    approachPhases: new Set(['APPROACH']),
    groundPhases: new Set(['TAXI']),
    landingPhase: 'LANDING',
    findRunwayByPosition() {
      runwayLookups++;
      return { icao: 'KSEA', runway: '16L' };
    },
    findNearbyAirport() {
      return { icao: 'KSEA' };
    },
  });

  const result = detectAirportRunway(null, -122.31, 160, 'APPROACH');

  assert(runwayLookups === 0, 'expected no runway lookup for invalid coordinates');
  assert(result.icao === null && result.runway === null, 'expected empty runway context');
});

console.log('\nresolveLandingGeometryScoringInputs');

test('maps the canonical final landing geometry into retrospective scoring inputs', () => {
  const result = resolveLandingGeometryScoringInputs({
    icao: ' YSCB ',
    runway: ' 35 ',
    runway_reference_elev_ft: 1886,
    runway_reference_elevation_source: 'ourairports',
    runway_reference_elevation_kind: 'airport',
    runway_heading_true_deg: 359.7,
    runway_width_ft: 148,
    runway_length_ft: 8803,
    runway_threshold_lat: -35.314,
    runway_threshold_lon: 149.194,
  });

  assert(result.thresholdElevFt === 1886, 'expected runway reference elevation');
  assert(result.runwayReferenceElevationSource === 'ourairports', 'expected elevation source');
  assert(result.runwayReferenceElevationKind === 'airport', 'expected elevation kind');
  assert(result.runwayHdg === 359.7, 'expected true runway heading');
  assert(result.runwayWidthFt === 148, 'expected plausible runway width');
  assert(result.runwayLengthFt === 8803, 'expected plausible runway length');
  assert(result.runwayThreshold?.lat === -35.314, 'expected threshold latitude');
  assert(result.runwayThreshold?.lon === 149.194, 'expected threshold longitude');
  assert(result.runwayId === '35', 'expected trimmed runway id');
  assert(result.airportIcao === 'YSCB', 'expected trimmed airport ICAO');
});

console.log('\nresolveVreSamplingRate');

test('keeps a 10 Hz target at the default telemetry poll cadence', () => {
  const rate = resolveVreSamplingRate(10, 100);

  assert(rate.targetRateHz === 10, 'expected the 10 Hz evaluator target to be preserved');
  assert(rate.effectiveRateHz === 10, 'expected default polling to produce at most 10 fresh samples per second');
  assert(rate.intervalMs === 100, 'expected the effective interval to match the 100 ms poll');
});

test('enforces the hard CSV ceiling even with an excessive target and faster polling', () => {
  const rate = resolveVreSamplingRate(100, 1);

  assert(MAX_VRE_CSV_SAMPLE_RATE_HZ === 10, 'expected the absolute VRE CSV ceiling to remain 10 Hz');
  assert(rate.targetRateHz === 100, 'expected diagnostics to preserve an excessive requested target');
  assert(rate.effectiveRateHz === 10, 'expected the runtime safety ceiling to cap fresh samples at 10 Hz');
  assert(rate.intervalMs === 100, 'expected the runtime safety ceiling to require at least 100 ms');
});

test('independent write admission gate enforces the resolved interval', () => {
  assert(isVreCsvSampleDue(0, null, 100) === true, 'expected the first CSV sample attempt to be admitted');
  assert(isVreCsvSampleDue(50, 0, 100) === false, 'expected a second attempt at 50 ms to be rejected');
  assert(isVreCsvSampleDue(100, 0, 100) === true, 'expected a second attempt at 100 ms to be admitted');
  assert(isVreCsvSampleDue(Number.NaN, 0, 100) === false, 'expected an invalid clock to fail closed');
});

test('retains slower targets and respects a slower telemetry poll', () => {
  const elevated = resolveVreSamplingRate(5, 100);
  const pollLimited = resolveVreSamplingRate(10, 250);

  assert(elevated.effectiveRateHz === 5 && elevated.intervalMs === 200, 'expected a 5 Hz target to remain unchanged');
  assert(pollLimited.effectiveRateHz === 4 && pollLimited.intervalMs === 250, 'expected a slower poll to cap a 10 Hz target');
});

test('uses safe defaults for invalid sampling inputs', () => {
  const rate = resolveVreSamplingRate(Number.NaN, Number.NaN);

  assert(rate.targetRateHz === 1, 'expected an invalid target to fall back to baseline');
  assert(rate.effectiveRateHz === 1, 'expected safe defaults to resolve to 1 Hz');
  assert(rate.intervalMs === 1000, 'expected safe defaults to resolve to a 1000 ms interval');
});

console.log('\nbuildVreEnrichedFrame');

test('preserves reliable automation and weather fields', () => {
  const row = buildVreEnrichedFrame(buildBaseArgs());

  assert(row.apMaster === true, 'expected apMaster true');
  assert(row.sampleRateHz === 4, 'expected the resolved VRE rate to survive recording enrichment');
  assert(row.apFdActive === true, 'expected apFdActive true');
  assert(row.apFlcHold === true, 'expected apFlcHold true');
  assert(row.apSpeedHold === true, 'expected apSpeedHold true');
  assert(row.apMachTarget === 0.78, 'expected apMachTarget 0.78');
  assert(row.athrActive === true, 'expected athrActive true');
  assert(row.athrArmed === true, 'expected athrArmed true');
  assert(row.apReliable === true, 'expected apReliable true');
  assert(row.athrReliable === true, 'expected athrReliable true');
  assert(row.apReliabilityReason === 'simconnect-only', 'expected reliability reason');
  assert(row.seaLevelPressureMb === 1013.2, 'expected seaLevelPressureMb 1013.2');
  assert(row.precipRateMm === 1.25, 'expected precipRateMm 1.25');
  assert(row.precipState === 2, 'expected precipState 2');
  assert(row.inCloud === true, 'expected inCloud true');
  assert(row.surfaceCondition === 1, 'expected surfaceCondition 1');
  assert(row.fuelTotalWeightLbs === 28140, 'expected fuelTotalWeightLbs 28140');
  assert(row.fuelWeightPerGal === 6.7, 'expected fuelWeightPerGal 6.7');
  assert(row.flapsSource === 'profile', 'expected flap provenance to survive recording enrichment');
  assert(row.spoilerSource === 'simconnect', 'expected spoiler provenance to survive recording enrichment');
  assert(row.spoilerAvailable === true, 'expected spoiler availability to survive recording enrichment');
});

test('preserves explicit altitude and barometer diagnostics for CSV recording', () => {
  const row = buildVreEnrichedFrame(buildBaseArgs({
    fdm: {
      altIndicatedFt: 2500,
      altCalibratedFt: 2340,
      altPlaneFt: 2337,
      aircraftAglFt: 810,
      aircraftAboveObstaclesFt: 770,
      planeAglFt: 770,
      planeAglMinusCgFt: 763,
      pressureAltFt: 2615,
      kohlsmanSettingMb: 1013.25,
      kohlsmanTunedMb: 1007.8,
      kohlsmanStd: true,
    },
  }));

  assert(row.altIndicatedFt === 2500, 'expected explicit indicated altitude');
  assert(row.altCalibratedFt === 2340, 'expected calibrated altitude');
  assert(row.altPlaneFt === 2337, 'expected plane altitude diagnostic');
  assert(row.aircraftAglFt === 810, 'expected terrain AGL diagnostic');
  assert(row.aircraftAboveObstaclesFt === 770, 'expected obstacle-relative diagnostic');
  assert(row.planeAglFt === 770, 'expected plane AGL diagnostic');
  assert(row.planeAglMinusCgFt === 763, 'expected CG-adjusted AGL diagnostic');
  assert(row.pressureAltFt === 2615, 'expected pressure altitude diagnostic');
  assert(row.kohlsmanSettingMb === 1013.25, 'expected effective barometer');
  assert(row.kohlsmanTunedMb === 1007.8, 'expected tuned barometer');
  assert(row.kohlsmanStd === true, 'expected STD mode');
});

test('preserves sim pause and menu flags for CSV samples', () => {
  const row = buildVreEnrichedFrame(buildBaseArgs({
    frame: { paused: true, inMenu: true },
  }));

  assert(row.paused === true, 'expected paused true');
  assert(row.inMenu === true, 'expected inMenu true');
});

test('suppresses unreliable AP and ATHR values while keeping reliability metadata', () => {
  const row = buildVreEnrichedFrame(buildBaseArgs({
    autopilotReliability: {
      apReliable: false,
      athrReliable: false,
      reason: 'lvar-sidecar-absent:test-sdk-aircraft',
    },
  }));

  assert(row.apMaster === null, 'expected apMaster null');
  assert(row.apAltHold === null, 'expected apAltHold null');
  assert(row.apFdActive === null, 'expected apFdActive null');
  assert(row.apFlcHold === null, 'expected apFlcHold null');
  assert(row.apSpeedHold === null, 'expected apSpeedHold null');
  assert(row.apMachTarget === null, 'expected apMachTarget null');
  assert(row.athrActive === null, 'expected athrActive null');
  assert(row.athrArmed === null, 'expected athrArmed null');
  assert(row.apReliable === false, 'expected apReliable false');
  assert(row.athrReliable === false, 'expected athrReliable false');
  assert(row.apReliabilityReason === 'lvar-sidecar-absent:test-sdk-aircraft', 'expected failure reason');
  assert(row.fdm.apMaster === null, 'expected nested fdm.apMaster null');
  assert(row.fdm.apMachTarget === null, 'expected nested fdm.apMachTarget null');
  assert(row.fdm.athrActive === null, 'expected nested fdm.athrActive null');
  assert(row.precipRateMm === 1.25, 'expected weather data preserved');
});

test('buildEnginesBroadcastData passes through X-Plane engines without throttle data', () => {
  const engines = {
    count: 2,
    source: 'xplane',
    eng1: 0,
    eng2: 1,
    eng1Text: '0%',
    eng2Text: '1%',
  };

  const result = buildEnginesBroadcastData({ engines, throttle: null });

  assert(result === engines, 'expected direct X-Plane engine payload to be reused');
});

test('approach configuration preserves unavailable gear and flap telemetry', () => {
  assert(
    deriveApproachConfigurationState({
      gearDownLocked: 0,
      gearConfigurationAvailable: false,
      flaps: { notch: 0, percent: 0 },
      flapsConfigurationAvailable: false,
    }) === null,
    'provider defaults must not invent a clean/retracted configuration',
  );
  assert(
    deriveApproachConfigurationState({
      gearDownLocked: 0,
      gearConfigurationAvailable: true,
      flaps: { notch: 0, percent: 0 },
      flapsConfigurationAvailable: true,
    }) === false,
    'known retracted configuration should remain false',
  );
  assert(
    deriveApproachConfigurationState({
      gearDownLocked: 0,
      gearConfigurationAvailable: true,
      flaps: { notch: 5, percent: 20 },
      flapsConfigurationAvailable: true,
    }) === true,
    'known flap extension should establish landing intent',
  );
  assert(
    deriveApproachConfigurationState({
      gearDownLocked: null,
      gearConfigurationAvailable: false,
      flaps: { notch: 5, percent: null, source: 'lvar' },
      flapsConfigurationAvailable: false,
    }) === true,
    'a resolved profile LVAR should remain available when generic flap channels are absent',
  );
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) process.exit(1);

export {};
