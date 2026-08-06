'use strict';

const assert = require('node:assert/strict');

const {
  buildSimConnectAssists,
  buildSimConnectFdmData,
  buildSimConnectSimTime,
  buildSimConnectTouchdownData,
  buildSimConnectWarnings,
} = require('./simconnect-frame-builder.js') as {
  buildSimConnectAssists: (data: Record<string, any>, boolOrNull: (value: unknown) => boolean | null) => Record<string, any>;
  buildSimConnectFdmData: (data: Record<string, any>, boolOrNull: (value: unknown) => boolean | null) => Record<string, any>;
  buildSimConnectSimTime: (data: Record<string, any>, secToHms: (seconds: unknown) => string | null) => Record<string, any>;
  buildSimConnectTouchdownData: (data: Record<string, any>) => Record<string, any>;
  buildSimConnectWarnings: (data: Record<string, any>, boolOrNull: (value: unknown) => boolean | null) => Record<string, any>;
};

function boolOrNull(value: unknown): boolean | null {
  return value == null ? null : Boolean(value);
}

function simBoolOrNull(value: unknown): boolean | null {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric !== 0 : null;
}

let passed = 0;

function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

test('buildSimConnectFdmData preserves conversion-heavy telemetry fields', () => {
  const fdm = buildSimConnectFdmData({
    cabinAltRateFps: 12,
    cabinDeltaPPsf: 288,
    eng1Egt: 1000,
    eng1Itt: 900,
    prop1Beta: Math.PI / 2,
    yokeX: 0.5,
    gsNeedle: 119,
    locNeedle: -127,
    navHasGlideSlope: 1,
    navHasLocalizer: 1,
    navSignal: 98,
    nav1ActiveMhz: 110.3,
    nav1StandbyMhz: 113.9,
    nav2ActiveMhz: 115.5,
    nav2StandbyMhz: 117.95,
    eng1Combustion: 1,
    accelLateral: 32.174,
    accelLongitudinal: -16.087,
    rotVelBodyX: 0.11,
    fuelTotalGal: 420,
    fuelTotalGalEx1: 421,
    fuelTotalPct: 0.63,
    fuelTotalWeightLbs: 2814,
    fuelTotalWeightLbsEx1: 2820.7,
    fuelWeightPerGal: 6.7,
    precipRateMm: 1.25,
    precipState: 4,
    inCloud: 1,
    densityAlt: 36750,
    altMsl: 4321.4,
    altCalibrated: 4012.6,
    altPlane: 4008.2,
    aircraftAgl: 590.2,
    aircraftAboveObstacles: 551.8,
    planeAgl: 551.7,
    planeAglMinusCg: 545.4,
    pressureAlt: 4388.6,
    kohlsmanSettingMb: 1013.25,
    kohlsmanTunedMb: 1002.37,
    kohlsmanStd: 1,
  }, boolOrNull);

  assert.equal(fdm.cabinAltRateFpm, 720);
  assert.equal(fdm.cabinDeltaPPsi, 2);
  assert.ok(Math.abs(fdm.eng1EgtC - 282.40555555555557) < 0.0001);
  assert.ok(Math.abs(fdm.eng1IttC - 226.85) < 0.0001);
  assert.equal(fdm.prop1BetaDeg, 90);
  assert.equal(fdm.yokeXPct, 50);
  assert.equal(fdm.nav1GsiRaw, 119);
  assert.equal(fdm.nav1CdiRaw, -127);
  assert.equal(fdm.nav1HasGlideSlope, true);
  assert.equal(fdm.nav1HasLocalizer, true);
  assert.equal(fdm.nav1Signal, 98);
  assert.equal(fdm.nav1ActiveMhz, 110.3);
  assert.equal(fdm.nav1StandbyMhz, 113.9);
  assert.equal(fdm.nav2ActiveMhz, 115.5);
  assert.equal(fdm.nav2StandbyMhz, 117.95);
  assert.equal(fdm.gsDeviationDots, 2.5);
  assert.equal(fdm.locDeviationDots, -2.5);
  assert.equal(fdm.eng1Running, 1);
  assert.equal(fdm.anyEngineRunning, true);
  assert.equal(fdm.gForceLateral, 1);
  assert.equal(fdm.gForceLongitudinal, -0.5);
  assert.equal(fdm.pitchRateRadS, 0.11);
  assert.equal(fdm.fuelTotalGal, 421);
  assert.equal(fdm.fuelTotalPct, 63);
  assert.equal(fdm.fuelTotalWeightLbs, 2820.7);
  assert.equal(fdm.fuelWeightPerGal, 6.7);
  assert.equal(fdm.precipRateMm, 1.25);
  assert.equal(fdm.precipState, 4);
  assert.equal(fdm.inCloud, true);
  assert.equal(fdm.densityAltFt, 36750);
  assert.equal(fdm.altIndicatedFt, 4321.4);
  assert.equal(fdm.altCalibratedFt, 4012.6);
  assert.equal(fdm.altPlaneFt, 4008.2);
  assert.equal(fdm.aircraftAglFt, 590.2);
  assert.equal(fdm.aircraftAboveObstaclesFt, 551.8);
  assert.equal(fdm.planeAglFt, 551.7);
  assert.equal(fdm.planeAglMinusCgFt, 545.4);
  assert.equal(fdm.pressureAltFt, 4388.6);
  assert.equal(fdm.kohlsmanSettingMb, 1013.25);
  assert.equal(fdm.kohlsmanTunedMb, 1002.37);
  assert.equal(fdm.kohlsmanStd, true);
});

test('buildSimConnectFdmData falls back to legacy fuel totals when EX1 is unavailable', () => {
  const fdm = buildSimConnectFdmData({
    fuelTotalGal: 420,
    fuelTotalWeightLbs: 2814,
  }, boolOrNull);

  assert.equal(fdm.fuelTotalGal, 420);
  assert.equal(fdm.fuelTotalWeightLbs, 2814);
});

test('buildSimConnectFdmData sanitizes malformed weather probes', () => {
  const fdm = buildSimConnectFdmData({
    seaLevelPressureMb: 0,
    visibilityM: 1027,
    precipRateMm: 1.5573409094156677e+252,
    precipState: 1610612736,
  }, boolOrNull);

  assert.equal(fdm.seaLevelPressureMb, null);
  assert.equal(fdm.visibilityM, 1027);
  assert.equal(fdm.precipRateMm, null);
  assert.equal(fdm.precipState, null);
});

test('buildSimConnectFdmData rejects impossible NAV needle deflections', () => {
  const fdm = buildSimConnectFdmData({
    gsNeedle: -128,
    locNeedle: 7169,
  }, boolOrNull);

  assert.equal(fdm.gsDeviationDots, null);
  assert.equal(fdm.locDeviationDots, null);
});

test('buildSimConnectFdmData accepts already-normalized fuel percentage from mocks', () => {
  const fdm = buildSimConnectFdmData({ fuelTotalPct: 54 }, boolOrNull);
  assert.equal(fdm.fuelTotalPct, 54);
});

test('buildSimConnectSimTime delegates time formatting without owning display policy', () => {
  const calls: unknown[] = [];
  const simTime = buildSimConnectSimTime({
    zuluTimeSec: 3661,
    localTimeSec: 7322,
    zuluYear: 2026,
    zuluMonthOfYear: 6,
    zuluDayOfMonth: 7,
    zuluDayOfYear: 158,
    zuluDayOfWeek: 0,
    localYear: 2026,
    localMonthOfYear: 6,
    localDayOfMonth: 7,
    localDayOfYear: 158,
    localDayOfWeek: 6,
    timeZoneOffsetSec: 36000,
    absoluteTimeSec: 63884999161,
    timeOfDay: 3,
    zuluSunriseTimeSec: 21000,
    zuluSunsetTimeSec: 69000,
  }, (seconds) => {
    calls.push(seconds);
    return `fmt:${seconds}`;
  });

  assert.deepEqual(calls, [3661, 7322]);
  assert.deepEqual(simTime, {
    zuluSec: 3661,
    localSec: 7322,
    zuluHms: 'fmt:3661',
    localHms: 'fmt:7322',
    zuluDate: '2026-06-07',
    localDate: '2026-06-07',
    zuluIso: '2026-06-07T01:01:01Z',
    localIso: '2026-06-07T02:02:02',
    zuluYear: 2026,
    zuluMonth: 6,
    zuluDay: 7,
    zuluDayOfYear: 158,
    zuluDayOfWeek: 0,
    localYear: 2026,
    localMonth: 6,
    localDay: 7,
    localDayOfYear: 158,
    localDayOfWeek: 6,
    timezoneOffsetSec: 36000,
    absoluteSec: 63884999161,
    timeOfDay: 3,
    zuluSunriseSec: 21000,
    zuluSunsetSec: 69000,
    source: 'simconnect',
    valid: true,
  });
});

test('buildSimConnectTouchdownData normalizes MSFS last-touchdown fields', () => {
  const touchdown = buildSimConnectTouchdownData({
    touchdownBankDeg: -2.5,
    touchdownHeadingMagDeg: 268,
    touchdownHeadingTrueDeg: 279,
    touchdownLatRad: Math.PI / 6,
    touchdownLonRad: Math.PI / 3,
    touchdownNormalVelocityFps: 8,
    touchdownPitchDeg: -4.1,
  });

  assert.equal(touchdown.source, 'msfs_last_touchdown');
  assert.equal(touchdown.bankDeg, 2.5);
  assert.equal(touchdown.headingMagDeg, 268);
  assert.equal(touchdown.headingTrueDeg, 279);
  assert.ok(Math.abs(touchdown.latDeg - 30) < 0.0001);
  assert.ok(Math.abs(touchdown.lonDeg - 60) < 0.0001);
  assert.equal(touchdown.normalVelocityFps, 8);
  assert.equal(touchdown.normalVelocityFpm, 480);
  assert.equal(touchdown.pitchDeg, 4.1);
});

test('buildSimConnectAssists and warnings keep composite assist semantics explicit', () => {
  const assists = buildSimConnectAssists({
    unlimitedFuel: 0,
    assistLanding: 1,
    assistTakeoff: 0,
    aiControls: 0,
    aiAutotrim: 0,
    aiDelegated: 0,
    aiAntistall: 1,
    slewActive: 0,
    realismPercent: 75,
  }, boolOrNull);
  const warnings = buildSimConnectWarnings({
    overspeedWarning: 1,
    stallWarning: 0,
  }, boolOrNull);

  assert.equal(assists.landingAssist, true);
  assert.equal(assists.aiAntistallActive, true);
  assert.equal(assists.anyAssistActive, true);
  assert.equal(assists.fullRealism, false);
  assert.equal(assists.realismPercent, 75);

  const antistallOnly = buildSimConnectAssists({
    unlimitedFuel: 0,
    assistLanding: 0,
    assistTakeoff: 0,
    aiControls: 0,
    aiAutotrim: 0,
    aiDelegated: 0,
    aiAntistall: 0,
    slewActive: 0,
    realismPercent: 100,
  }, boolOrNull);
  assert.equal(antistallOnly.aiAntistallActive, true);
  assert.equal(antistallOnly.anyAssistActive, false);
  assert.equal(antistallOnly.fullRealism, true);

  const partialProbe = buildSimConnectAssists({
    aiControls: 1,
  }, boolOrNull);
  assert.equal(partialProbe.aiControls, true);
  assert.equal(partialProbe.anyAssistActive, true);
  assert.equal(partialProbe.fullRealism, false);

  const normalizedStrings = buildSimConnectAssists({
    unlimitedFuel: '0',
    assistLanding: '0',
    assistTakeoff: '0',
    aiControls: '0',
    aiAutotrim: '0',
    aiDelegated: '0',
    aiAntistall: '2',
    slewActive: '0',
  }, simBoolOrNull);
  assert.equal(normalizedStrings.unlimitedFuel, false);
  assert.equal(normalizedStrings.aiAntistall, 2);
  assert.equal(normalizedStrings.aiAntistallActive, false);
  assert.equal(normalizedStrings.anyAssistActive, false);
  assert.equal(normalizedStrings.fullRealism, true);

  assert.deepEqual(warnings, {
    overspeed: true,
    stall: false,
  });
});

console.log(`PASS simconnect-frame-builder ${passed}`);

export {};
