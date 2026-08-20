#!/usr/bin/env node
/**
 * test-simbridge-core-utils.js
 *
 * Unit tests for simbridge-core-utils.js, focusing on:
 *  - mergeFdmData: verifies the 9 fields that were missing before the fix
 *    (mach, aoaDeg, sideslipDeg, trackTrueDeg, gForceLateral,
 *     gForceLongitudinal, elevTrimPct, gsDeviationDots, locDeviationDots)
 *    are now passed through from frameFdm and that scFdm values take
 *    precedence over frameFdm values.
 *  - buildVreEnrichedFrame: verifies that the above fields are sourced from
 *    the correct locations (frame.fdm for the 6 frame-level fields;
 *    fdm parameter for elevTrimPct; frame.ilsGsDeviation /
 *    frame.ilsLocDeviation for the deviation paths).
 *
 * Run: node tests/scripts/test-simbridge-core-utils.js
 */

'use strict';

const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const {
  advanceDebouncedChangeState,
  buildEnginesBroadcastData,
  buildVreEnrichedFrame,
  buildVreEvaluationFrame,
  computeBrakePct,
  computeGearBroadcastState,
  deriveOverallSignalReliability,
  extractThrottlePercents,
  getProfileEngineCount,
  mergeFdmData,
  normalizePitchBankDegrees,
  resetGoAroundScoringState,
  shouldCollectCurrentApproachSample,
  shouldResetCurrentApproachScorerForParked,
  shouldStartCurrentApproachScorer,
} = require(resolveBackendRuntimeFile('core', 'simbridge-core-utils.js'));
const {
  snapshotStabilityScoringInputs,
  resolveRecordedStabilityScoringInputs,
} = require(resolveBackendRuntimeFile('core', 'simbridge-core.js'));

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal base objects reused across tests
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal frameFdm that sets only the 9 previously-missing fields. */
function makeFrameFdm(overrides = {}) {
  return {
    mach: 0.82,
    aoaDeg: 3.1,
    sideslipDeg: -0.4,
    trackTrueDeg: 275.0,
    gForceLateral: 0.02,
    gForceLongitudinal: -0.1,
    elevTrimPct: 2.5,
    gsDeviationDots: -0.3,
    locDeviationDots: 0.1,
    // Other fields that mergeFdmData expects (set to null/false so prefer() returns undefined)
    tasKts: null, aileronPct: null, elevatorPct: null, rudderPct: null,
    yokeXPct: null, yokeYPct: null, rudderPedalPct: null,
    pitchRateRadS: null, rollRateRadS: null, yawRateRadS: null,
    oatC: null, tatC: null, pressureMb: null, seaLevelPressureMb: null,
    visibilityM: null, precipRateMm: null, precipState: null,
    inCloud: null, surfaceCondition: null, densityAltFt: null,
    cabinAltFt: null, cabinAltRateFpm: null, cabinDeltaPPsi: null,
    cabinAltTargetFt: null, cabinDumpSwitch: null,
    eng1N1: null, eng2N1: null, eng3N1: null, eng4N1: null,
    eng1N2: null, eng2N2: null, eng3N2: null, eng4N2: null,
    eng1EgtC: null, eng2EgtC: null, eng3EgtC: null, eng4EgtC: null,
    eng1FfPph: null, eng2FfPph: null, eng3FfPph: null, eng4FfPph: null,
    fuelTotalGal: null, grossWeightLbs: null, cgPct: null,
    apMaster: null, apAltHold: null, apHdgHold: null, apNavHold: null,
    apApprHold: null, apVsHold: null, apFlcHold: null, apSpeedHold: null,
    apFdActive: null, athrActive: null, athrArmed: null,
    apAltTargetFt: null, apHdgTargetDeg: null, apVsTargetFpm: null,
    apSpeedTargetKts: null, apMachTarget: null,
    ...overrides,
  };
}

/**
 * Build a minimal enriched frame.  frameFdmFields are placed in frame.fdm;
 * mergedFdmFields are passed as the pre-merged fdm parameter.
 */
function makeEnriched({ frameFdmFields = {}, mergedFdmFields = {}, frameFields = {} } = {}) {
  const frame = {
    wow: false, lat: 51.47, lon: -0.45, gforce: 1.0,
    fdm: frameFdmFields,
    surface: { raw: 1, name: 'Asphalt', class: 'hard', runwayLike: true, onRunway: false, onGround: true, valid: true },
    simTime: { zuluSec: 43200, localSec: 39600 },
    simconnect: { simVersion: '12.0.0' },
    assists: { slewActive: false, anyAssistActive: false },
    ...frameFields,
  };

  const fdm = mergeFdmData(makeFrameFdm(mergedFdmFields), {});

  return buildVreEnrichedFrame({
    frame, fdm,
    userId: 'u1', sessionId: 's1',
    nowEpochMs: 1700000000000,
    timestampIso: '2024-01-01T00:00:00.000Z',
    flightId: 'f1',
    flightStartIso: '2024-01-01T00:00:00.000Z',
    flightStartEpochMs: 1699996400000,
    sampleRateHz: 2,
    escalationReason: null,
    phase: 'CRUISE',
    stability: 'STABLE',
    iasKnots: 250, gs: 255, vsFeetPerMin: 0,
    altMslFt: 35000, raFeet: 35000, xwind: 5, trend: 0,
    headingData: { hdgTrueDeg: 275, hdgMagDeg: 268, magvarDeg: 7 },
    pitchDeg: 2.5, bankDeg: 0, maxPitchBankDeg: 90,
    windSpeed: 30, windDir: 270, gearDownLocked: false,
    flapsNotch: 0, flaps: 0, spoilerPct: null, spoilerState: null,
    brakePct: null, thr1Pct: 75, thr2Pct: 75, thr3Pct: null, thr4Pct: null,
    profileId: 'generic', signalReliability: 'generic',
    dataSource: 'simconnect', aircraftName: 'Test Aircraft',
    elapsedMs: 3600000,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. mergeFdmData: new fields pass through from frameFdm
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nmergeFdmData: new fields pass through from frameFdm');

test('mach: passes through from frameFdm', () => {
  const result = mergeFdmData(makeFrameFdm({ mach: 0.79 }), {});
  assert(result.mach === 0.79, `expected 0.79, got ${result.mach}`);
});
test('aoaDeg: passes through from frameFdm', () => {
  const result = mergeFdmData(makeFrameFdm({ aoaDeg: 5.5 }), {});
  assert(result.aoaDeg === 5.5, `expected 5.5, got ${result.aoaDeg}`);
});
test('sideslipDeg: passes through from frameFdm', () => {
  const result = mergeFdmData(makeFrameFdm({ sideslipDeg: -2.1 }), {});
  assert(result.sideslipDeg === -2.1, `expected -2.1, got ${result.sideslipDeg}`);
});
test('trackTrueDeg: passes through from frameFdm', () => {
  const result = mergeFdmData(makeFrameFdm({ trackTrueDeg: 180.0 }), {});
  assert(result.trackTrueDeg === 180.0, `expected 180.0, got ${result.trackTrueDeg}`);
});
test('gForceLateral: passes through from frameFdm', () => {
  const result = mergeFdmData(makeFrameFdm({ gForceLateral: 0.05 }), {});
  assert(result.gForceLateral === 0.05, `expected 0.05, got ${result.gForceLateral}`);
});
test('gForceLongitudinal: passes through from frameFdm', () => {
  const result = mergeFdmData(makeFrameFdm({ gForceLongitudinal: -0.12 }), {});
  assert(result.gForceLongitudinal === -0.12, `expected -0.12, got ${result.gForceLongitudinal}`);
});
test('elevTrimPct: passes through from frameFdm', () => {
  const result = mergeFdmData(makeFrameFdm({ elevTrimPct: 4.0 }), {});
  assert(result.elevTrimPct === 4.0, `expected 4.0, got ${result.elevTrimPct}`);
});
test('gsDeviationDots: passes through from frameFdm', () => {
  const result = mergeFdmData(makeFrameFdm({ gsDeviationDots: -0.75 }), {});
  assert(result.gsDeviationDots === -0.75, `expected -0.75, got ${result.gsDeviationDots}`);
});
test('locDeviationDots: passes through from frameFdm', () => {
  const result = mergeFdmData(makeFrameFdm({ locDeviationDots: 0.33 }), {});
  assert(result.locDeviationDots === 0.33, `expected 0.33, got ${result.locDeviationDots}`);
});
test('nav1 validity fields: pass through from frameFdm', () => {
  const result = mergeFdmData(makeFrameFdm({
    nav1GsiRaw: 119,
    nav1CdiRaw: -127,
    nav1HasGlideSlope: true,
    nav1HasLocalizer: false,
    nav1Signal: 98,
  }), {});
  assert(result.nav1GsiRaw === 119, `expected nav1GsiRaw 119, got ${result.nav1GsiRaw}`);
  assert(result.nav1CdiRaw === -127, `expected nav1CdiRaw -127, got ${result.nav1CdiRaw}`);
  assert(result.nav1HasGlideSlope === true, `expected nav1HasGlideSlope true, got ${result.nav1HasGlideSlope}`);
  assert(result.nav1HasLocalizer === false, `expected nav1HasLocalizer false, got ${result.nav1HasLocalizer}`);
  assert(result.nav1Signal === 98, `expected nav1Signal 98, got ${result.nav1Signal}`);
});

console.log('\nmergeFdmData: scFdm values take precedence over frameFdm');

test('mach: scFdm overrides frameFdm', () => {
  const sc = { fdm: { mach: 0.85 } };
  const result = mergeFdmData(makeFrameFdm({ mach: 0.79 }), sc);
  assert(result.mach === 0.85, `expected 0.85 (scFdm), got ${result.mach}`);
});
test('aoaDeg: scFdm overrides frameFdm', () => {
  const sc = { fdm: { aoaDeg: 7.0 } };
  const result = mergeFdmData(makeFrameFdm({ aoaDeg: 3.1 }), sc);
  assert(result.aoaDeg === 7.0, `expected 7.0 (scFdm), got ${result.aoaDeg}`);
});

console.log('\nmergeFdmData: null frameFdm yields null fields (no crash)');

test('null frameFdm does not throw', () => {
  const result = mergeFdmData(null, {});
  assert(result !== null, 'expected non-null result');
  assert(result.mach == null, `expected null mach, got ${result.mach}`);
  assert(result.aoaDeg == null, `expected null aoaDeg, got ${result.aoaDeg}`);
  assert(result.gsDeviationDots == null, `expected null gsDeviationDots, got ${result.gsDeviationDots}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. buildVreEnrichedFrame: frame.fdm-sourced fields
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nbuildVreEnrichedFrame: fields sourced from frame.fdm');

test('mach: populated from frame.fdm.mach', () => {
  const ef = makeEnriched({ frameFdmFields: { mach: 0.78 } });
  assert(ef.mach === 0.78, `expected 0.78, got ${ef.mach}`);
});
test('mach: undefined when frame.fdm.mach absent', () => {
  const ef = makeEnriched({ frameFdmFields: {} });
  assert(ef.mach === undefined, `expected undefined, got ${ef.mach}`);
});
test('aoa: populated from frame.fdm.aoaDeg (not frame.aoa)', () => {
  const ef = makeEnriched({ frameFdmFields: { aoaDeg: 6.1 } });
  assert(ef.aoa === 6.1, `expected 6.1, got ${ef.aoa}`);
});
test('aoa: top-level frame.aoa is NOT used', () => {
  // The legacy top-level frame.aoa path must no longer be read.
  const frame = {
    wow: false, lat: 0, lon: 0, gforce: 1.0,
    aoa: 99.9, // stale top-level — should be ignored
    fdm: {},
    surface: { raw: 1, name: 'Asphalt', class: 'hard' },
    simTime: { zuluSec: 0, localSec: 0 },
    simconnect: {},
    assists: { slewActive: false, anyAssistActive: false },
  };
  const fdm = mergeFdmData(makeFrameFdm(), {});
  const ef = buildVreEnrichedFrame({
    frame, fdm,
    userId: 'u1', sessionId: 's1',
    nowEpochMs: 1700000000000,
    timestampIso: '2024-01-01T00:00:00.000Z',
    flightId: 'f1', flightStartIso: '2024-01-01T00:00:00.000Z',
    flightStartEpochMs: 1699996400000, sampleRateHz: 2, escalationReason: null,
    phase: 'CRUISE', stability: 'STABLE', iasKnots: 250, gs: 255, vsFeetPerMin: 0,
    altMslFt: 35000, raFeet: 35000, xwind: 5, trend: 0,
    headingData: { hdgTrueDeg: 275, hdgMagDeg: 268, magvarDeg: 7 },
    pitchDeg: 2.5, bankDeg: 0, maxPitchBankDeg: 90,
    windSpeed: 30, windDir: 270, gearDownLocked: false,
    flapsNotch: 0, flaps: 0, spoilerPct: null, spoilerState: null,
    brakePct: null, thr1Pct: 75, thr2Pct: 75, thr3Pct: null, thr4Pct: null,
    profileId: 'generic', signalReliability: 'generic',
    dataSource: 'simconnect', aircraftName: 'Test Aircraft', elapsedMs: 3600000,
  });
  // frame.fdm is empty, so ef.aoa must be undefined, not 99.9
  assert(ef.aoa === undefined, `expected undefined (frame.aoa must not be read), got ${ef.aoa}`);
});
test('sideslip: populated from frame.fdm.sideslipDeg', () => {
  const ef = makeEnriched({ frameFdmFields: { sideslipDeg: -2.5 } });
  assert(ef.sideslip === -2.5, `expected -2.5, got ${ef.sideslip}`);
});
test('trackTrue: populated from frame.fdm.trackTrueDeg', () => {
  const ef = makeEnriched({ frameFdmFields: { trackTrueDeg: 183.0 } });
  assert(ef.trackTrue === 183.0, `expected 183.0, got ${ef.trackTrue}`);
});
test('gForceLateral: populated from frame.fdm.gForceLateral', () => {
  const ef = makeEnriched({ frameFdmFields: { gForceLateral: 0.07 } });
  assert(ef.gForceLateral === 0.07, `expected 0.07, got ${ef.gForceLateral}`);
});
test('gForceLongitudinal: populated from frame.fdm.gForceLongitudinal', () => {
  const ef = makeEnriched({ frameFdmFields: { gForceLongitudinal: -0.15 } });
  assert(ef.gForceLongitudinal === -0.15, `expected -0.15, got ${ef.gForceLongitudinal}`);
});

test('surface booleans are preserved for CSV sample rows', () => {
  const row = makeEnriched({
    frameFdmFields: {},
  });
  assert(row.surfaceRaw === 1, `surfaceRaw mismatch: ${row.surfaceRaw}`);
  assert(row.surfaceName === 'Asphalt', `surfaceName mismatch: ${row.surfaceName}`);
  assert(row.surfaceClass === 'hard', `surfaceClass mismatch: ${row.surfaceClass}`);
  assert(row.surfaceRunwayLike === true, `surfaceRunwayLike mismatch: ${row.surfaceRunwayLike}`);
  assert(row.surfaceOnRunway === false, `surfaceOnRunway mismatch: ${row.surfaceOnRunway}`);
  assert(row.surfaceOnGround === true, `surfaceOnGround mismatch: ${row.surfaceOnGround}`);
  assert(row.surfaceValid === true, `surfaceValid mismatch: ${row.surfaceValid}`);
});

test('sim pause and menu flags are preserved for CSV sample rows', () => {
  const row = makeEnriched({
    frameFields: { paused: true, inMenu: true },
  });
  assert(row.paused === true, `paused mismatch: ${row.paused}`);
  assert(row.inMenu === true, `inMenu mismatch: ${row.inMenu}`);
});

console.log('\nbuildVreEnrichedFrame: elevTrimPct from merged fdm parameter');

test('elevTrimPct: populated from merged fdm.elevTrimPct', () => {
  const ef = makeEnriched({ mergedFdmFields: { elevTrimPct: 3.2 } });
  assert(ef.elevTrimPct === 3.2, `expected 3.2, got ${ef.elevTrimPct}`);
});
test('elevTrimPct: frame.trim.elevator is NOT the source on enriched frame', () => {
  // The legacy frame.trim.elevator path is not used by buildVreEnrichedFrame;
  // it must no longer be read directly. elevTrimPct now comes from fdm.elevTrimPct.
  const frame = {
    wow: false, lat: 0, lon: 0, gforce: 1.0,
    trim: { elevator: 88.8 }, // stale top-level path — must not be used
    fdm: {},
    surface: { raw: 1, name: 'Asphalt', class: 'hard' },
    simTime: { zuluSec: 0, localSec: 0 },
    simconnect: {},
    assists: { slewActive: false, anyAssistActive: false },
  };
  const fdm = mergeFdmData(makeFrameFdm({ elevTrimPct: null }), {});
  const ef = buildVreEnrichedFrame({
    frame, fdm,
    userId: 'u1', sessionId: 's1',
    nowEpochMs: 1700000000000,
    timestampIso: '2024-01-01T00:00:00.000Z',
    flightId: 'f1', flightStartIso: '2024-01-01T00:00:00.000Z',
    flightStartEpochMs: 1699996400000, sampleRateHz: 2, escalationReason: null,
    phase: 'CRUISE', stability: 'STABLE', iasKnots: 250, gs: 255, vsFeetPerMin: 0,
    altMslFt: 35000, raFeet: 35000, xwind: 5, trend: 0,
    headingData: { hdgTrueDeg: 275, hdgMagDeg: 268, magvarDeg: 7 },
    pitchDeg: 2.5, bankDeg: 0, maxPitchBankDeg: 90,
    windSpeed: 30, windDir: 270, gearDownLocked: false,
    flapsNotch: 0, flaps: 0, spoilerPct: null, spoilerState: null,
    brakePct: null, thr1Pct: 75, thr2Pct: 75, thr3Pct: null, thr4Pct: null,
    profileId: 'generic', signalReliability: 'generic',
    dataSource: 'simconnect', aircraftName: 'Test Aircraft', elapsedMs: 3600000,
  });
  // fdm.elevTrimPct is null, so ef.elevTrimPct must be null (not 88.8 from frame.trim.elevator)
  assert(ef.elevTrimPct == null, `expected null (frame.trim.elevator must not be read), got ${ef.elevTrimPct}`);
});

console.log('\nbuildVreEnrichedFrame: ILS deviation paths');

test('gsDeviation: populated from frame.ilsGsDeviation (WASM sidecar path)', () => {
  const frame = {
    wow: false, lat: 0, lon: 0, gforce: 1.0,
    ilsGsDeviation: 0.4,
    fdm: {},
    surface: { raw: 1, name: 'Asphalt', class: 'hard' },
    simTime: { zuluSec: 0, localSec: 0 },
    simconnect: {},
    assists: { slewActive: false, anyAssistActive: false },
  };
  const fdm = mergeFdmData(makeFrameFdm(), {});
  const ef = buildVreEnrichedFrame({
    frame, fdm,
    userId: 'u1', sessionId: 's1',
    nowEpochMs: 1700000000000,
    timestampIso: '2024-01-01T00:00:00.000Z',
    flightId: 'f1', flightStartIso: '2024-01-01T00:00:00.000Z',
    flightStartEpochMs: 1699996400000, sampleRateHz: 2, escalationReason: null,
    phase: 'APPROACH', stability: 'STABLE', iasKnots: 145, gs: 148, vsFeetPerMin: -700,
    altMslFt: 2000, raFeet: 1900, xwind: 5, trend: -1,
    headingData: { hdgTrueDeg: 270, hdgMagDeg: 265, magvarDeg: 5 },
    pitchDeg: -3, bankDeg: 0, maxPitchBankDeg: 90,
    windSpeed: 12, windDir: 270, gearDownLocked: true,
    flapsNotch: 3, flaps: 75, spoilerPct: 0, spoilerState: 'ARMED',
    brakePct: 0, thr1Pct: 55, thr2Pct: 55, thr3Pct: null, thr4Pct: null,
    profileId: 'generic', signalReliability: 'generic',
    dataSource: 'simconnect', aircraftName: 'Test Aircraft', elapsedMs: 100000,
  });
  assert(ef.gsDeviation === 0.4, `expected 0.4, got ${ef.gsDeviation}`);
});
test('locDeviation: populated from frame.ilsLocDeviation (WASM sidecar path)', () => {
  const frame = {
    wow: false, lat: 0, lon: 0, gforce: 1.0,
    ilsLocDeviation: -0.2,
    fdm: {},
    surface: { raw: 1, name: 'Asphalt', class: 'hard' },
    simTime: { zuluSec: 0, localSec: 0 },
    simconnect: {},
    assists: { slewActive: false, anyAssistActive: false },
  };
  const fdm = mergeFdmData(makeFrameFdm(), {});
  const ef = buildVreEnrichedFrame({
    frame, fdm,
    userId: 'u1', sessionId: 's1',
    nowEpochMs: 1700000000000,
    timestampIso: '2024-01-01T00:00:00.000Z',
    flightId: 'f1', flightStartIso: '2024-01-01T00:00:00.000Z',
    flightStartEpochMs: 1699996400000, sampleRateHz: 2, escalationReason: null,
    phase: 'APPROACH', stability: 'STABLE', iasKnots: 145, gs: 148, vsFeetPerMin: -700,
    altMslFt: 2000, raFeet: 1900, xwind: 5, trend: -1,
    headingData: { hdgTrueDeg: 270, hdgMagDeg: 265, magvarDeg: 5 },
    pitchDeg: -3, bankDeg: 0, maxPitchBankDeg: 90,
    windSpeed: 12, windDir: 270, gearDownLocked: true,
    flapsNotch: 3, flaps: 75, spoilerPct: 0, spoilerState: 'ARMED',
    brakePct: 0, thr1Pct: 55, thr2Pct: 55, thr3Pct: null, thr4Pct: null,
    profileId: 'generic', signalReliability: 'generic',
    dataSource: 'simconnect', aircraftName: 'Test Aircraft', elapsedMs: 100000,
  });
  assert(ef.locDeviation === -0.2, `expected -0.2, got ${ef.locDeviation}`);
});
test('gsDeviation: undefined when neither ilsGsDeviation nor fdm.gsDeviationDots present', () => {
  const ef = makeEnriched({ frameFdmFields: {}, mergedFdmFields: { gsDeviationDots: null } });
  assert(ef.gsDeviation === undefined, `expected undefined, got ${ef.gsDeviation}`);
});

console.log('\nsimbridge core tick helper extraction');

test('buildEnginesBroadcastData: passes through direct engines payload when throttle is absent', () => {
  const engines = { count: 2, source: 'sdk', eng1: 88, eng2: 89 };
  const result = buildEnginesBroadcastData({
    engines,
  });
  assert(result === engines, 'expected direct engines object to be reused');
});

test('getProfileEngineCount: reads normalized and legacy profile engine counts', () => {
  const normalized = getProfileEngineCount({ aircraft: { engines: { count: 2 } } });
  assert(normalized === 2, `expected normalized aircraft engine count, got ${normalized}`);
  const legacy = getProfileEngineCount({ engines: { count: '4' } });
  assert(legacy === 4, `expected legacy engine count string to normalize, got ${legacy}`);
  const invalid = getProfileEngineCount({ aircraft: { engines: { count: 8 } } });
  assert(invalid === null, `expected out-of-range engine count to be ignored, got ${invalid}`);
});

test('buildEnginesBroadcastData: caps direct engine payloads to the active profile count', () => {
  const result = buildEnginesBroadcastData({
    throttle: { eng1Pct: 0, eng2Pct: 0, eng3Pct: 0, eng4Pct: 0 },
    engines: {
      count: 4,
      source: 'simconnect_n1',
      eng1: 0,
      eng2: 0,
      eng3: 0,
      eng4: 0,
      eng1Text: '0%',
      eng2Text: '0%',
      eng3Text: '0%',
      eng4Text: '0%',
    },
  }, { profile: { aircraft: { engines: { count: 2 } } } });

  assert(result.count === 2, `expected profile-capped 2 engines, got ${result.count}`);
  assert(result.eng1 === 0, 'expected first engine value to be preserved');
  assert(result.eng2 === 0, 'expected second engine value to be preserved');
  assert(result.eng3 === null, 'expected third engine to be hidden');
  assert(result.eng4Text === '--', 'expected fourth engine text to be suppressed');
});

test('buildEnginesBroadcastData: prefers merged N1 values over throttle fallback', () => {
  const result = buildEnginesBroadcastData({
    throttle: { eng1Pct: 70, eng2Pct: 71 },
    simconnect: { fdm: { eng1N1: 91.2, eng2N1: 92.4 } },
  });
  assert(result.source === 'n1', `expected n1 source, got ${result.source}`);
  assert(result.count === 2, `expected 2 engines, got ${result.count}`);
  assert(result.eng1 === 91.2, `expected eng1 N1 91.2, got ${result.eng1}`);
  assert(result.eng2Text === '92%', `expected rounded text 92%, got ${result.eng2Text}`);
});

test('buildEnginesBroadcastData: falls back to throttle values and engine count', () => {
  const result = buildEnginesBroadcastData({
    throttle: { eng1Pct: 55.1, eng2Pct: 56.2, eng3Pct: null, eng4Pct: null },
    fdm: {},
  });
  assert(result.source === 'throttle', `expected throttle source, got ${result.source}`);
  assert(result.count === 2, `expected 2 engines, got ${result.count}`);
  assert(result.eng1Text === '55%', `expected rounded text 55%, got ${result.eng1Text}`);
});

test('buildEnginesBroadcastData: profile count prevents idle N1 zeroes from becoming four engines', () => {
  const result = buildEnginesBroadcastData({
    throttle: { eng1Pct: 0, eng2Pct: 0, eng3Pct: 0, eng4Pct: 0 },
    simconnect: { fdm: { eng1N1: 0, eng2N1: 0, eng3N1: 0, eng4N1: 0 } },
  }, { profile: { aircraft: { engines: { count: 2 } } } });

  assert(result.source === 'n1', `expected n1 source, got ${result.source}`);
  assert(result.count === 2, `expected profile-capped 2 engines, got ${result.count}`);
  assert(result.eng1Text === '0%', `expected first engine idle text, got ${result.eng1Text}`);
  assert(result.eng2Text === '0%', `expected second engine idle text, got ${result.eng2Text}`);
  assert(result.eng3 === null, 'expected third engine value to be hidden');
  assert(result.eng4Text === '--', 'expected fourth engine text to be hidden');
});

test('buildEnginesBroadcastData: returns null without throttle or engine values', () => {
  assert(buildEnginesBroadcastData({}) === null, 'expected null when throttle is absent');
  assert(buildEnginesBroadcastData({ throttle: {} }) === null, 'expected null with no usable engine values');
});

test('computeGearBroadcastState: derives down/up/transit and changed flags', () => {
  const down = computeGearBroadcastState({
    gear: { nose: 1, left: 1, right: 1, parkingBrake: true },
    previousGearState: undefined,
    previousParkingBrake: undefined,
  });
  assert(down.payload.gearState === 'DOWN', `expected DOWN, got ${down.payload.gearState}`);
  assert(down.payload.changed === true, 'expected first gear state to be changed');
  assert(down.payload.parkingBrakeChanged === true, 'expected first parking brake state to be changed');

  const unchanged = computeGearBroadcastState({
    gear: { nose: 1, left: 1, right: 1, parkingBrake: true },
    previousGearState: down.nextGearState,
    previousParkingBrake: down.nextParkingBrake,
  });
  assert(unchanged.payload.changed === false, 'expected unchanged gear state');
  assert(unchanged.payload.parkingBrakeChanged === false, 'expected unchanged parking brake state');

  const transit = computeGearBroadcastState({
    gear: { nose: 0.5, left: 1, right: 1, parkingBrake: true },
    previousGearState: down.nextGearState,
    previousParkingBrake: down.nextParkingBrake,
  });
  assert(transit.payload.gearState === 'TRANSIT', `expected TRANSIT, got ${transit.payload.gearState}`);
  assert(transit.payload.changed === true, 'expected gear transition to be changed');

  const handleFallback = computeGearBroadcastState({
    gear: { nose: 0, left: 0, right: 0, parkingBrake: false },
    gearHandleDown: 1,
    previousGearState: 'UP',
    previousParkingBrake: false,
  });
  assert(handleFallback.payload.gearState === 'DOWN', `expected handle-down fallback to report DOWN, got ${handleFallback.payload.gearState}`);
  assert(handleFallback.payload.changed === true, 'expected handle-down fallback to flag a state change');
});

test('advanceDebouncedChangeState: requires consecutive ticks before committing a change', () => {
  const first = advanceDebouncedChangeState({
    value: 'ARMED',
    lastValue: 'RETRACTED',
    pendingValue: undefined,
    pendingTicks: 0,
    requiredTicks: 2,
  });
  assert(first.changed === false, 'expected first pending tick to stay uncommitted');
  assert(first.nextLastValue === 'RETRACTED', `expected last value to stay RETRACTED, got ${first.nextLastValue}`);
  assert(first.nextPendingValue === 'ARMED', `expected pending ARMED, got ${first.nextPendingValue}`);
  assert(first.nextPendingTicks === 1, `expected one pending tick, got ${first.nextPendingTicks}`);

  const second = advanceDebouncedChangeState({
    value: 'ARMED',
    lastValue: first.nextLastValue,
    pendingValue: first.nextPendingValue,
    pendingTicks: first.nextPendingTicks,
    requiredTicks: 2,
  });
  assert(second.changed === true, 'expected second consecutive tick to commit');
  assert(second.nextLastValue === 'ARMED', `expected committed ARMED, got ${second.nextLastValue}`);
  assert(second.nextPendingValue === undefined, 'expected pending value reset after commit');

  const reset = advanceDebouncedChangeState({
    value: 'ARMED',
    lastValue: second.nextLastValue,
    pendingValue: 'RETRACTED',
    pendingTicks: 1,
    requiredTicks: 2,
  });
  assert(reset.changed === false, 'expected matching last value to avoid change');
  assert(reset.nextPendingValue === undefined, 'expected pending reset when value matches last');
  assert(reset.nextPendingTicks === 0, `expected pending ticks reset, got ${reset.nextPendingTicks}`);
});

test('buildVreEvaluationFrame: normalizes VRE evaluator input shape', () => {
  const result = buildVreEvaluationFrame({
    frame: { fdm: { yawRateRadS: Math.PI / 2 } },
    vsFeetPerMin: -650,
    raFeet: 450,
    pitchRateDeg: 1.5,
    bankRateDeg: -2.5,
    gs: 140,
    gearDownLocked: true,
    flapsNotch: 3,
    spoilerState: 'ARMED',
    wow: false,
    pitch: -0.05,
    bank: 0.1,
    phase: 'APPROACH',
  });
  assert(result.vs === -650, `expected vs -650, got ${result.vs}`);
  assert(result.gForce === null, `expected missing gForce to remain null, got ${result.gForce}`);
  assert(Math.abs(result.yawRate - 90) < 0.0001, `expected yaw rate 90 deg/s, got ${result.yawRate}`);
  assert(result.wow === false, `expected wow false, got ${result.wow}`);
  assert(result.phase === 'APPROACH', `expected APPROACH phase, got ${result.phase}`);
});

test('deriveOverallSignalReliability: reports the least reliable key signal', () => {
  const result = deriveOverallSignalReliability({
    ias: 'authoritative',
    vs: 'generic',
    ra: 'unavailable',
    heading: 'authoritative',
    flapsNotch: 'authoritative',
  });
  assert(result === 'unavailable', `expected unavailable, got ${result}`);
});

test('normalizePitchBankDegrees: converts radians and preserves degree-like values', () => {
  const radians = normalizePitchBankDegrees({ pitch: Math.PI / 6, bank: -Math.PI / 4 });
  assert(Math.abs(radians.pitchDeg - 30) < 0.0001, `expected pitch 30 deg, got ${radians.pitchDeg}`);
  assert(Math.abs(radians.bankDeg + 45) < 0.0001, `expected bank -45 deg, got ${radians.bankDeg}`);

  const degrees = normalizePitchBankDegrees({ pitch: 12, bank: -18 });
  assert(degrees.pitchDeg === 12, `expected pitch 12 deg, got ${degrees.pitchDeg}`);
  assert(degrees.bankDeg === -18, `expected bank -18 deg, got ${degrees.bankDeg}`);
});

test('extractThrottlePercents and computeBrakePct: derive CSV scalar fields', () => {
  const throttle = extractThrottlePercents({
    eng1Pct: 63,
    eng2Pct: 64,
    eng3Pct: Number.NaN,
    eng4Pct: '65',
  });
  assert(throttle.thr1Pct === 63, `expected thr1 63, got ${throttle.thr1Pct}`);
  assert(throttle.thr2Pct === 64, `expected thr2 64, got ${throttle.thr2Pct}`);
  assert(throttle.thr3Pct === null, `expected thr3 null, got ${throttle.thr3Pct}`);
  assert(throttle.thr4Pct === null, `expected thr4 null, got ${throttle.thr4Pct}`);

  assert(computeBrakePct({ brake: 0 }) === null, 'expected zero brake to remain null');
  assert(computeBrakePct({ brake: 0.5 }) === 50, 'expected normalized brake to scale to percent');
  assert(Math.abs(computeBrakePct({ brake: 16383.5 }) - 50) < 0.0001, 'expected raw brake to scale to percent');
});

console.log('\nCurrent approach stability sample gate');

test('go-around reset clears every attempt-scoped scorer and returns a fresh approach scorer', () => {
  const calls = [];
  const freshScorer = { id: 'second-attempt' };
  const result = resetGoAroundScoringState({
    resetStability: () => calls.push('stability'),
    landingRunner: { reset: () => calls.push('landing') },
    createCurrentApproachScorer: () => {
      calls.push('approach');
      return freshScorer;
    },
  });

  assert(calls.join(',') === 'stability,landing,approach', `unexpected reset order: ${calls.join(',')}`);
  assert(result === freshScorer, 'expected the fresh current-approach scorer to be returned');
});

test('collects descending approach samples below the scoring ceiling', () => {
  assert(shouldCollectCurrentApproachSample({
    phase: 'APPROACH',
    raFt: 900,
    vsFpm: -650,
  }) === true, 'expected descending APPROACH below ceiling to collect');
});

test('does not collect go-around climb samples after reset', () => {
  assert(shouldCollectCurrentApproachSample({
    phase: 'GO_AROUND',
    raFt: 450,
    vsFpm: 1200,
  }) === false, 'expected GO_AROUND climb sample to be ignored');
});

test('collects level and climbing samples inside an active approach phase', () => {
  assert(shouldCollectCurrentApproachSample({
    phase: 'CLIMB',
    raFt: 700,
    vsFpm: -200,
  }) === false, 'expected CLIMB phase to be ignored');
  assert(shouldCollectCurrentApproachSample({
    phase: 'APPROACH',
    raFt: 700,
    vsFpm: 0,
  }) === true, 'expected level APPROACH sample to be retained for stability scoring');
  assert(shouldCollectCurrentApproachSample({
    phase: 'APPROACH',
    raFt: 600,
    vsFpm: 350,
  }) === true, 'expected climbing APPROACH sample to be retained for stability scoring');
});

test('freezes approach collection throughout rollout and rejects on-ground frames', () => {
  assert(shouldCollectCurrentApproachSample({
    phase: 'LANDING',
    raFt: 20,
    vsFpm: -300,
    onGround: false,
    rolloutActive: true,
  }) === false, 'expected an airborne bounce during rollout to stay out of the approach buffer');
  assert(shouldCollectCurrentApproachSample({
    phase: 'LANDING',
    raFt: 5,
    vsFpm: -100,
    onGround: true,
    rolloutActive: false,
  }) === false, 'expected an on-ground touchdown frame to stay out of the approach buffer');
});

test('does not collect samples above the current approach ceiling', () => {
  assert(shouldCollectCurrentApproachSample({
    phase: 'DESCENT',
    raFt: 1800,
    vsFpm: -800,
  }) === false, 'expected sample above ceiling to be ignored');
});

test('does not collect otherwise eligible approach samples during telemetry warmup', () => {
  assert(shouldCollectCurrentApproachSample({
    phase: 'APPROACH',
    raFt: 900,
    vsFpm: -650,
    warmup: true,
  }) === false, 'expected warmup sample to be ignored');
});

test('collects above the default ceiling when profile criteria raise the collection ceiling', () => {
  assert(shouldCollectCurrentApproachSample({
    phase: 'DESCENT',
    raFt: 1800,
    vsFpm: -800,
    collectionCeilingFt: 2500,
  }) === true, 'expected raised collection ceiling to follow active stability gate');
});

test('starts a fresh current-approach scorer when a later approach becomes eligible after scoring', () => {
  assert(shouldStartCurrentApproachScorer({
    flightActive: true,
    eligible: true,
    scorerPresent: false,
    hasScored: false,
  }) === true, 'missing scorer should be re-created for an eligible in-flight approach');

  assert(shouldStartCurrentApproachScorer({
    flightActive: true,
    eligible: true,
    scorerPresent: true,
    hasScored: true,
  }) === true, 'consumed scorer should be replaced for the next eligible approach');
});

test('does not start current-approach scorer outside an eligible active approach', () => {
  assert(shouldStartCurrentApproachScorer({
    flightActive: false,
    eligible: true,
    scorerPresent: false,
    hasScored: false,
  }) === false, 'inactive flight should not create a scorer');

  assert(shouldStartCurrentApproachScorer({
    flightActive: true,
    eligible: false,
    scorerPresent: false,
    hasScored: false,
  }) === false, 'ineligible sample should not create a scorer');

  assert(shouldStartCurrentApproachScorer({
    flightActive: true,
    eligible: true,
    scorerPresent: true,
    hasScored: false,
  }) === false, 'active unscored scorer should be reused');
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
test('does not reset a populated current-approach scorer during parked rollout delay', () => {
  assert(shouldResetCurrentApproachScorerForParked({
    phase: 'PARKED',
    scorerPresent: true,
    hasScored: false,
    sampleCount: 125,
  }) === false, 'populated unscored approach scorer should survive PARKED before landing:final');

  assert(shouldResetCurrentApproachScorerForParked({
    phase: 'PARKED',
    scorerPresent: true,
    hasScored: false,
    sampleCount: 0,
  }) === true, 'empty parked scorer can be reset');

  assert(shouldResetCurrentApproachScorerForParked({
    phase: 'PARKED',
    scorerPresent: true,
    hasScored: true,
    sampleCount: 125,
  }) === true, 'scored parked scorer can be reset');
});

test('approach stability profile, policy, and criteria are immutable snapshots', () => {
  const profile = {
    id: 'test-ga',
    name: 'Test GA',
    aircraft: { category: 'A', engines: { count: 2 } },
    signalReliability: { stabilityScore: 'profile' },
  };
  const commonCriteria = { gateRaFt: 1000, speedPlusKts: 10, passPct: 80 };
  const profileCriteria = { gateRaFt: 500, speedPlusKts: 4 };
  const snapshot = snapshotStabilityScoringInputs({ profile, commonCriteria, profileCriteria });

  profile.id = 'changed-after-capture';
  profile.aircraft.category = 'D';
  profile.aircraft.engines.count = 4;
  commonCriteria.passPct = 1;
  profileCriteria.speedPlusKts = 99;

  assert(snapshot.profile.id === 'test-ga', 'captured profile identity must not follow later active-profile mutation');
  assert(snapshot.profile.aircraft.category === 'A', 'captured aircraft category must remain attempt-scoped');
  assert(snapshot.engineCount === 2, 'fallback engine count must remain paired with the captured scorer profile');
  assert(snapshot.policy.id === 'ga-profile-v3', 'captured GA policy must remain explicit');
  assert(snapshot.policy.profileCriteriaApplied === true, 'GA profile criteria should be captured as applied');
  assert(snapshot.criteria.gateRaFt === 500, 'captured profile gate must remain unchanged');
  assert(snapshot.criteria.speedPlusKts === 4, 'captured profile speed band must remain unchanged');
  assert(snapshot.criteria.passPct === 80, 'captured common criteria must remain unchanged');
  assert(Object.isFrozen(snapshot), 'scoring-input snapshot should be frozen');
  assert(Object.isFrozen(snapshot.profile), 'profile snapshot should be frozen');
  assert(Object.isFrozen(snapshot.policy), 'policy snapshot should be frozen');
  assert(Object.isFrozen(snapshot.criteria), 'criteria snapshot should be frozen');
});

test('recorded-profile stability fallback never consults the currently selected aircraft', () => {
  let activeProfileReads = 0;
  const loadCalls = [];
  const profiles = {
    'recorded-a380': {
      id: 'recorded-a380',
      name: 'Recorded A380',
      aircraft: { category: 'D', engines: { count: 4 } },
      signalReliability: { stabilityScore: 'profile' },
    },
    generic: {
      id: 'generic',
      name: 'Generic Aircraft',
      aircraft: { category: 'C', engines: { count: 2 } },
      signalReliability: { stabilityScore: 'generic' },
    },
  };
  const fakeLoader = {
    getActiveProfile() {
      activeProfileReads += 1;
      return profiles.generic;
    },
    loadProfile(id) {
      loadCalls.push(id);
      return profiles[id] || null;
    },
    getStabilityScoringCriteria(profile) {
      return profile?.id === 'recorded-a380' ? { speedPlusKts: 3 } : null;
    },
  };

  const recorded = resolveRecordedStabilityScoringInputs('recorded-a380', {
    profileLoaderApi: fakeLoader,
    commonCriteria: { gateRaFt: 1000, speedPlusKts: 10 },
  });
  assert(recorded.profile.id === 'recorded-a380', 'explicit recorded profile must win over selected generic profile');
  assert(recorded.engineCount === 4, 'recorded scorer snapshot must retain its fallback engine count');
  assert(recorded.policy.id === 'transport-v3', 'recorded transport policy should be captured');
  assert(recorded.criteria.speedPlusKts === 10, 'transport policy should retain the common criteria');
  assert(activeProfileReads === 0, 'recorded-profile resolution must not read active profile state');
  assert(loadCalls.length === 1 && loadCalls[0] === 'recorded-a380', 'recorded profile should resolve directly');

  loadCalls.length = 0;
  const missing = resolveRecordedStabilityScoringInputs('retired-profile', {
    profileLoaderApi: fakeLoader,
    commonCriteria: { gateRaFt: 1000 },
  });
  assert(missing.profile.id === 'generic', 'unresolvable live profile should fail safe to explicit generic data');
  assert(activeProfileReads === 0, 'generic fallback must still avoid active profile state');
  assert(loadCalls.join(',') === 'retired-profile,generic', 'fallback should be deterministic and explicit');
});

console.log('\n════════════════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`✓ All ${passed} simbridge-core-utils tests passed`);
  process.exit(0);
} else {
  console.log(`✗ ${failed} failed, ${passed} passed`);
  process.exit(1);
}
