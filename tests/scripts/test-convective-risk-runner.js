#!/usr/bin/env node
/**
 * test-convective-risk-runner.js
 *
 * Unit tests for backend/flight-violations/convective-risk-runner.js
 *
 * Run: node tests/scripts/test-convective-risk-runner.js
 */

'use strict';

const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const {
  createConvectiveRiskRunner,
} = require(resolveBackendRuntimeFile('flight-violations', 'convective-risk-runner.js'));
const eventBus = require(resolveBackendRuntimeFile('core', 'event-bus.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  eventBus.removeAllListeners('convectiveRisk:start');
  eventBus.removeAllListeners('convectiveRisk:end');
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`    ${e.message}`);
  } finally {
    eventBus.removeAllListeners('convectiveRisk:start');
    eventBus.removeAllListeners('convectiveRisk:end');
  }
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg} Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(val, msg = '') {
  if (!val) throw new Error(msg || 'Expected truthy');
}

function makeBroadcastSpy() {
  const calls = [];
  const broadcast = (payload) => calls.push(payload);
  return { broadcast, calls };
}

function makeConvectiveEventSpy() {
  const starts = [];
  const ends = [];
  eventBus.on('convectiveRisk:start', payload => starts.push(payload));
  eventBus.on('convectiveRisk:end', payload => ends.push(payload));
  return { starts, ends };
}

function makeCsvWriterSpy() {
  const events = [];
  return {
    events,
    writer: {
      isRecording: () => true,
      writeEvent: (eventType, payload) => events.push({ eventType, payload }),
    },
  };
}

function makeTimeCtx(nowEpochMs) {
  return { nowEpochMs, nowIso: new Date(nowEpochMs).toISOString() };
}

function degToRad(value) {
  return value * Math.PI / 180;
}

function makeFrame(overrides = {}) {
  const {
    gForce = 1,
    iasKts = 250,
    vsFpm = 0,
    pitchRateDeg = 0,
    rollRateDeg = 0,
    yawRateDeg = 0,
    pitchDeg = 0,
    bankDeg = 0,
    gForceLateral = null,
    gForceLongitudinal = null,
    precipRateMm = null,
    precipState = null,
    inCloud = null,
    densityAltFt = null,
    wow = false,
  } = overrides;

  return {
    wow,
    gforce: gForce,
    ias: iasKts,
    vs: vsFpm,
    display: {
      iasKts,
      vsFpm,
      pitchDeg,
      bankDeg,
    },
    fdm: {
      gForce,
      gForceLateral,
      gForceLongitudinal,
      pitchRateRadS: degToRad(pitchRateDeg),
      rollRateRadS: degToRad(rollRateDeg),
      yawRateRadS: degToRad(yawRateDeg),
      precipRateMm,
      precipState,
      inCloud,
      densityAltFt,
    },
  };
}

function deliberateSteepTurnWeatherSample(i) {
  const sample = severeConvectiveSample(i);
  sample.frame.display.bankDeg = i % 2 === 0 ? 32 : 30;
  sample.frame.display.pitchDeg = 4;
  return sample;
}

function verticalReversalOnlySample(i) {
  const vsFpm = i % 2 === 0 ? 760 : -720;
  return {
    frame: makeFrame({
      gForce: 1.02,
      gForceLateral: 0.02,
      gForceLongitudinal: 0.02,
      iasKts: 250,
      vsFpm,
      pitchRateDeg: 1,
      rollRateDeg: 1,
      yawRateDeg: 0,
      precipRateMm: 0,
      precipState: 0,
      inCloud: false,
      densityAltFt: 35000,
    }),
    iasKts: 250,
    vsFpm,
    pitchRateDeg: 1,
    rollRateDeg: 1,
  };
}

function feedRunner(runner, broadcast, startMs, count, sampleFactory, ctx = {}) {
  for (let i = 0; i < count; i++) {
    const now = startMs + i * 1000;
    const sample = sampleFactory(i, now);
    runner.update(sample.frame, broadcast, makeTimeCtx(now), {
      phase: 'CRUISE',
      iasKts: sample.iasKts,
      vsFpm: sample.vsFpm,
      pitchRateDeg: sample.pitchRateDeg,
      bankRateDeg: sample.rollRateDeg,
      ...ctx,
    });
  }
}

function severeConvectiveSample(i) {
  const gForce = i % 2 === 0 ? 1.56 : 0.62;
  const iasKts = 244 + (i % 6) * 7;
  const vsFpm = i % 2 === 0 ? 980 : -940;
  const pitchRateDeg = i % 3 === 0 ? 15 : -13;
  const rollRateDeg = i % 2 === 0 ? 22 : -18;
  const yawRateDeg = 7;

  return {
    frame: makeFrame({
      gForce,
      iasKts,
      vsFpm,
      pitchRateDeg,
      rollRateDeg,
      yawRateDeg,
      precipRateMm: 2.8,
      precipState: 4,
      inCloud: true,
      densityAltFt: 37150,
    }),
    iasKts,
    vsFpm,
    pitchRateDeg,
    rollRateDeg,
  };
}

function smoothCruiseSample() {
  return {
    frame: makeFrame({
      gForce: 1.01,
      iasKts: 250,
      vsFpm: 0,
      pitchRateDeg: 0.2,
      rollRateDeg: 0.1,
      yawRateDeg: 0,
      precipRateMm: 0,
      precipState: 0,
      inCloud: false,
      densityAltFt: 35000,
    }),
    iasKts: 250,
    vsFpm: 0,
    pitchRateDeg: 0.2,
    rollRateDeg: 0.1,
  };
}

function smoothStrongWeatherSample() {
  return {
    frame: makeFrame({
      gForce: 1,
      iasKts: 250,
      vsFpm: 0,
      pitchRateDeg: 0.2,
      rollRateDeg: 0.1,
      yawRateDeg: 0,
      precipRateMm: 2.8,
      precipState: 4,
      inCloud: true,
      densityAltFt: 35000,
    }),
    iasKts: 250,
    vsFpm: 0,
    pitchRateDeg: 0.2,
    rollRateDeg: 0.1,
  };
}

function smoothLightRainSample() {
  return {
    frame: makeFrame({
      gForce: 1,
      iasKts: 250,
      vsFpm: 0,
      pitchRateDeg: 0.2,
      rollRateDeg: 0.1,
      yawRateDeg: 0,
      precipRateMm: 0.1,
      precipState: 4,
      inCloud: true,
      densityAltFt: 35000,
    }),
    iasKts: 250,
    vsFpm: 0,
    pitchRateDeg: 0.2,
    rollRateDeg: 0.1,
  };
}

function dryDepartureClimbSample(i) {
  const iasKts = 165 + Math.min(i, 55) * 1.4;
  const vsFpm = 1900 + (i % 2 === 0 ? -850 : 850);
  const gForce = i % 9 === 0 ? 1.225 : 1.02;
  const pitchRateDeg = 3.5;
  const rollRateDeg = i % 7 === 0 ? 15 : 4;
  const yawRateDeg = 4;

  return {
    frame: makeFrame({
      gForce,
      iasKts,
      vsFpm,
      pitchRateDeg,
      rollRateDeg,
      yawRateDeg,
      precipRateMm: 0,
      precipState: 4,
      inCloud: false,
      densityAltFt: 12000,
    }),
    iasKts,
    vsFpm,
    pitchRateDeg,
    rollRateDeg,
  };
}

function normalApproachSample(i) {
  const iasKts = 230 - Math.min(i, 60) * 1.4;
  const vsFpm = -1650 + (i % 3) * 90;
  const pitchRateDeg = i % 6 === 0 ? 2.5 : 0.6;
  const rollRateDeg = i % 10 === 0 ? 10 : 2;

  return {
    frame: makeFrame({
      gForce: 1.03,
      gForceLateral: 0.04,
      gForceLongitudinal: -0.05,
      iasKts,
      vsFpm,
      pitchRateDeg,
      rollRateDeg,
      yawRateDeg: 2,
      precipRateMm: 0,
      precipState: 0,
      inCloud: false,
      densityAltFt: 8000,
    }),
    iasKts,
    vsFpm,
    pitchRateDeg,
    rollRateDeg,
  };
}

function multiAxisApproachSample(i) {
  const lateral = i % 2 === 0 ? 0.34 : -0.22;
  const longitudinal = i % 3 === 0 ? -0.31 : 0.18;
  const gForce = i % 2 === 0 ? 1.34 : 0.76;
  const iasKts = 155 + (i % 5) * 2;
  const vsFpm = i % 2 === 0 ? -900 : -1550;
  const pitchRateDeg = i % 3 === 0 ? 9 : -7;
  const rollRateDeg = i % 2 === 0 ? 14 : -11;

  return {
    frame: makeFrame({
      gForce,
      gForceLateral: lateral,
      gForceLongitudinal: longitudinal,
      iasKts,
      vsFpm,
      pitchRateDeg,
      rollRateDeg,
      yawRateDeg: 6,
      precipRateMm: 1.1,
      precipState: 2,
      inCloud: true,
      densityAltFt: 5000,
    }),
    iasKts,
    vsFpm,
    pitchRateDeg,
    rollRateDeg,
  };
}

console.log('\n=== ConvectiveRiskRunner Tests ===\n');

test('createConvectiveRiskRunner returns update, reset, and evaluateSamples functions', () => {
  const runner = createConvectiveRiskRunner();
  assertTrue(typeof runner.update === 'function', 'should have update()');
  assertTrue(typeof runner.reset === 'function', 'should have reset()');
  assertTrue(typeof runner.evaluateSamples === 'function', 'should have evaluateSamples()');
});

test('smooth cruise does not emit convective exposure events', () => {
  const runner = createConvectiveRiskRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const events = makeConvectiveEventSpy();

  feedRunner(runner, broadcast, 1000, 60, smoothCruiseSample);

  const starts = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  assertEqual(starts.length, 0, 'smooth cruise should not trigger convective exposure');
  assertEqual(events.starts.length, 0, 'smooth cruise should not trigger an internal diagnostic');
});

test('a brief motion spike cannot satisfy the sustained-duration gate', () => {
  const runner = createConvectiveRiskRunner();
  const { broadcast } = makeBroadcastSpy();
  const events = makeConvectiveEventSpy();

  feedRunner(runner, broadcast, 5_000, 40, (i) => ({
    frame: makeFrame({
      gForce: i === 0 ? 1.56 : 1,
      iasKts: 250,
      vsFpm: 0,
      precipRateMm: null,
      precipState: null,
      inCloud: null,
    }),
    iasKts: 250,
    vsFpm: 0,
    pitchRateDeg: 0,
    rollRateDeg: 0,
  }));

  const summary = runner.evaluateSamples();
  assertTrue(summary.loadExcursionPeakG > 0.5, 'fixture should retain the spike in the metrics window');
  assertEqual(events.starts.length, 0, 'an expired spike must not keep the 30-second candidate armed');
});

test('partial cloud-only weather data does not veto sustained motion detection', () => {
  const runner = createConvectiveRiskRunner();
  const { broadcast } = makeBroadcastSpy();
  const events = makeConvectiveEventSpy();

  feedRunner(runner, broadcast, 50_000, 36, (i) => {
    const sample = severeConvectiveSample(i);
    sample.frame.fdm.precipRateMm = null;
    sample.frame.fdm.precipState = null;
    sample.frame.fdm.inCloud = true;
    return sample;
  });

  assertEqual(events.starts.length, 1, 'missing precipitation probes should use the motion-only fallback');
  assertEqual(events.starts[0].metrics.confidence_level, 'LOW', 'partial weather must not inflate confidence');
});

test('dry departure climb kinematics do not emit convective exposure events', () => {
  const runner = createConvectiveRiskRunner();
  const { broadcast, calls } = makeBroadcastSpy();

  for (let i = 0; i < 70; i++) {
    const now = 20_000 + i * 1000;
    const sample = dryDepartureClimbSample(i);
    runner.update(sample.frame, broadcast, makeTimeCtx(now), {
      phase: i < 18 ? 'TAKEOFF' : 'CLIMB',
      iasKts: sample.iasKts,
      vsFpm: sample.vsFpm,
      pitchRateDeg: sample.pitchRateDeg,
      bankRateDeg: sample.rollRateDeg,
    });
  }

  const starts = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  const summary = runner.evaluateSamples();
  assertEqual(starts.length, 0, 'normal dry departure/climb should not trigger convective exposure');
  assertEqual(summary.precipRatio, 0, 'zero precip rate should override precip state for convective weather');
  assertEqual(summary.weatherAligned, false, 'dry departure should not be weather-aligned');
  assertTrue(summary.score < 0.45, `dry departure score should stay below arm threshold, got ${summary.score}`);
});

test('dry short-pattern maneuvering does not emit convective exposure from motion alone', () => {
  const runner = createConvectiveRiskRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const events = makeConvectiveEventSpy();

  feedRunner(runner, broadcast, 42_000, 70, (i) => {
    const sample = severeConvectiveSample(i);
    sample.frame.fdm.precipRateMm = 0;
    sample.frame.fdm.precipState = 2;
    sample.frame.fdm.inCloud = i >= 20 && i < 38;
    return sample;
  }, { phase: 'CLIMB' });

  const starts = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  const summary = runner.evaluateSamples();
  assertEqual(starts.length, 0, 'dry maneuvering with weather probes available should not trigger convective exposure');
  assertEqual(events.starts.length, 0, 'known-dry precipitation must continue to veto convective motion');
  assertTrue(summary.motionScore >= 0.7, `fixture should still have severe motion score, got ${summary.motionScore}`);
  assertEqual(summary.precipRatio, 0, 'zero precip rate should override precip state');
  assertEqual(summary.weatherAligned, false, 'cloud-only evidence without precip should not align convective weather');
});

test('precip state is only a fallback when precip rate is unavailable', () => {
  const runner = createConvectiveRiskRunner();
  const { broadcast } = makeBroadcastSpy();

  feedRunner(runner, broadcast, 30_000, 10, () => ({
    frame: makeFrame({
      gForce: 1,
      iasKts: 250,
      vsFpm: 0,
      precipRateMm: 0,
      precipState: 2,
      inCloud: false,
    }),
    iasKts: 250,
    vsFpm: 0,
    pitchRateDeg: 0,
    rollRateDeg: 0,
  }));

  const drySummary = runner.evaluateSamples();
  assertEqual(drySummary.precipRatio, 0, 'known zero precip rate should mean no convective precip');
  assertEqual(drySummary.weatherScore, 0, 'known zero precip rate should not score as convective weather');

  runner.reset();
  feedRunner(runner, broadcast, 50_000, 10, () => ({
    frame: makeFrame({
      gForce: 1,
      iasKts: 250,
      vsFpm: 0,
      precipRateMm: null,
      precipState: 4,
      inCloud: false,
    }),
    iasKts: 250,
    vsFpm: 0,
    pitchRateDeg: 0,
    rollRateDeg: 0,
  }));

  const fallbackSummary = runner.evaluateSamples();
  assertEqual(fallbackSummary.precipRatio, 1, 'precip state should remain a fallback when rate is unavailable');
  assertEqual(fallbackSummary.weatherAligned, true, 'fallback precip state should still align weather');

  runner.reset();
  feedRunner(runner, broadcast, 70_000, 10, () => ({
    frame: makeFrame({
      gForce: 1,
      iasKts: 250,
      vsFpm: 0,
      precipRateMm: null,
      precipState: 2,
      inCloud: false,
    }),
    iasKts: 250,
    vsFpm: 0,
    pitchRateDeg: 0,
    rollRateDeg: 0,
  }));

  const msfsNoneSummary = runner.evaluateSamples();
  assertEqual(msfsNoneSummary.precipRatio, 0, 'MSFS 2024 precip state 2 means none when rate is unavailable');
});

test('malformed weather probes fall back to low-confidence motion evidence', () => {
  const runner = createConvectiveRiskRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const events = makeConvectiveEventSpy();

  feedRunner(runner, broadcast, 60_000, 36, (i) => {
    const sample = severeConvectiveSample(i);
    sample.frame.fdm.precipRateMm = 1.5573409094156677e+252;
    sample.frame.fdm.precipState = 1610612736;
    sample.frame.fdm.inCloud = null;
    return sample;
  });

  const starts = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  const summary = runner.evaluateSamples();
  assertEqual(starts.length, 0, 'convective diagnostics should not broadcast low-confidence proxy events');
  assertEqual(events.starts.length, 1, 'unusable weather probes should be treated as unavailable');
  assertEqual(summary.confidenceLevel, 'LOW', 'malformed weather must not create high confidence');
  assertEqual(summary.precipRateMaxMm, null, 'malformed precip rate should be ignored');
  assertEqual(summary.precipRatio, null, 'malformed precip state should be ignored');
  assertEqual(summary.weatherAligned, false, 'malformed weather should not align the convective event');
});

test('sustained strong weather scores internally without aircraft response', () => {
  const runner = createConvectiveRiskRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const events = makeConvectiveEventSpy();

  feedRunner(runner, broadcast, 65_000, 36, smoothStrongWeatherSample);

  const starts = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  const summary = runner.evaluateSamples();
  assertEqual(starts.length, 0, 'weather-only convective diagnostics should not broadcast flight violations');
  assertEqual(events.starts.length, 1, 'sustained strong weather should emit an internal low-risk diagnostic');
  assertEqual(summary.riskLevel, 'LOW', 'weather-only exposure should be capped at low risk');
  assertTrue(summary.motionScore < 0.01, `weather-only sample should not rely on aircraft motion, got ${summary.motionScore}`);
  assertTrue(summary.weatherScore >= 0.6, `expected strong weather score, got ${summary.weatherScore}`);
  assertTrue(summary.score >= 0.25, 'score should reach the low-risk floor internally');
  assertTrue(summary.score < 0.45, 'weather-only floor should not become medium risk');
});

test('smooth light rain in cloud does not emit weather-only convective exposure', () => {
  const runner = createConvectiveRiskRunner();
  const { broadcast, calls } = makeBroadcastSpy();

  feedRunner(runner, broadcast, 72_000, 60, smoothLightRainSample);

  const starts = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  const summary = runner.evaluateSamples();
  assertEqual(starts.length, 0, 'light rain in cloud should not trigger a weather-only event');
  assertTrue(summary.weatherAligned, 'light rain should still be recorded as weather-aligned evidence');
  assertEqual(summary.riskLevel, null, 'light rain without motion should remain below low risk');
});

test('normal descent and approach profile changes do not emit convective exposure events', () => {
  const runner = createConvectiveRiskRunner();
  const { broadcast, calls } = makeBroadcastSpy();

  for (let i = 0; i < 70; i++) {
    const now = 80_000 + i * 1000;
    const sample = normalApproachSample(i);
    runner.update(sample.frame, broadcast, makeTimeCtx(now), {
      phase: i < 25 ? 'DESCENT' : 'APPROACH',
      iasKts: sample.iasKts,
      vsFpm: sample.vsFpm,
      pitchRateDeg: sample.pitchRateDeg,
      bankRateDeg: sample.rollRateDeg,
    });
  }

  const starts = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  const summary = runner.evaluateSamples();
  assertEqual(starts.length, 0, 'normal descent/approach profile changes should not trigger convective exposure');
  assertTrue(summary.score < 0.45, `normal descent/approach score should stay below arm threshold, got ${summary.score}`);
});

test('sustained multi-axis acceleration during approach scores internally', () => {
  const runner = createConvectiveRiskRunner();
  const { broadcast, calls } = makeBroadcastSpy();

  feedRunner(runner, broadcast, 180_000, 36, multiAxisApproachSample, { phase: 'APPROACH' });

  const starts = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  const summary = runner.evaluateSamples();
  assertEqual(starts.length, 0, 'sustained multi-axis diagnostics should not broadcast flight violations');
  assertTrue(summary.axisGPeak >= 0.3, `expected axis g peak to contribute, got ${summary.axisGPeak}`);
  assertTrue(summary.axisJerkPeakGps >= 0.5, `expected axis jerk peak to contribute, got ${summary.axisJerkPeakGps}`);
  assertEqual(summary.riskLevel, 'HIGH', 'multi-axis approach response should carry high risk internally');
  assertEqual(summary.confidenceLevel, 'HIGH', 'weather-corroborated multi-axis response should carry high confidence internally');
});

test('deliberate steep-bank maneuvering discounts motion severity before release-visible risk', () => {
  const runner = createConvectiveRiskRunner();
  const { broadcast, calls } = makeBroadcastSpy();

  feedRunner(runner, broadcast, 185_000, 36, deliberateSteepTurnWeatherSample);

  const starts = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  const summary = runner.evaluateSamples();
  assertEqual(summary.maneuverSuppressed, true, 'steep-bank samples should mark the window as maneuver-suppressed');
  assertTrue(summary.maneuverSampleRatio >= 0.6, `expected sustained maneuver ratio, got ${summary.maneuverSampleRatio}`);
  assertTrue(summary.bankPeakDeg > 25, `expected bank peak above suppression threshold, got ${summary.bankPeakDeg}`);
  assertTrue(summary.motionScore < 0.45, `maneuver-discounted motion score should stay below arm threshold, got ${summary.motionScore}`);
  assertEqual(starts.length, 0, 'maneuver-discounted convective diagnostics should not broadcast flight violations');
  assertEqual(summary.riskLevel, 'LOW', 'maneuver-discounted diagnostics should be capped at low risk internally');
});

test('vertical reversals are supporting evidence but do not trigger without weather or load response', () => {
  const runner = createConvectiveRiskRunner();
  const { broadcast, calls } = makeBroadcastSpy();

  feedRunner(runner, broadcast, 190_000, 36, verticalReversalOnlySample);

  const starts = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  const summary = runner.evaluateSamples();
  assertEqual(starts.length, 0, 'vertical-speed reversals alone should not trigger a release-visible event');
  assertTrue(summary.verticalReversalCount >= 10, `expected repeated vertical reversals, got ${summary.verticalReversalCount}`);
  assertTrue(summary.verticalSpeedActivityScore > 0, 'vertical reversal activity should be captured as supporting evidence');
  assertTrue(summary.score < 0.25, `supporting evidence alone should stay below low risk, got ${summary.score}`);
});

test('sustained aircraft response with aligned weather stays diagnostic-only', () => {
  const runner = createConvectiveRiskRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const { events, writer } = makeCsvWriterSpy();
  const diagnosticEvents = makeConvectiveEventSpy();

  feedRunner(runner, broadcast, 10_000, 36, severeConvectiveSample, { flightCsvWriter: writer });

  const starts = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  const summary = runner.evaluateSamples();
  assertEqual(starts.length, 0, 'sustained severe convective diagnostics should not broadcast flight violations');
  assertEqual(diagnosticEvents.starts.length, 1, 'sustained severe evidence should emit one internal diagnostic');
  assertEqual(summary.riskLevel, 'HIGH', 'diagnostic summary should still carry HIGH risk');
  assertEqual(summary.confidenceLevel, 'HIGH', 'diagnostic summary should still carry HIGH confidence');
  assertEqual(summary.weatherDataAvailable, true, 'weather indicators should be marked available internally');
  assertEqual(summary.weatherAligned, true, 'weather indicators should be marked aligned internally');
  assertTrue(summary.score >= 0.7, 'internal score should be HIGH risk');
  assertTrue(summary.loadExcursionPeakG >= 0.5, 'load excursion should be captured');

  assertEqual(events.length, 0, 'convective diagnostics should not write CSV violation rows');
});

test('convective diagnostic state clears after sustained quiet dwell without visible rows', () => {
  const runner = createConvectiveRiskRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const { events, writer } = makeCsvWriterSpy();
  const diagnosticEvents = makeConvectiveEventSpy();

  feedRunner(runner, broadcast, 100_000, 36, severeConvectiveSample, { flightCsvWriter: writer });
  feedRunner(runner, broadcast, 136_000, 60, smoothCruiseSample, { flightCsvWriter: writer });

  const ends = calls.filter(c => c.type === 'flightViolation' && c.event === 'end');
  assertEqual(ends.length, 0, 'convective diagnostic clear should not broadcast flight violations');
  assertEqual(diagnosticEvents.starts.length, 1, 'fixture should start one internal diagnostic');
  assertEqual(diagnosticEvents.ends.length, 1, 'quiet current evidence should end the internal diagnostic');
  assertEqual(events.length, 0, 'convective diagnostic clear should not write CSV violation rows');
});

test('motion-only severe signature is explicitly low confidence when weather probes are absent', () => {
  const runner = createConvectiveRiskRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const events = makeConvectiveEventSpy();

  feedRunner(runner, broadcast, 250_000, 36, (i) => {
    const sample = severeConvectiveSample(i);
    sample.frame.fdm.precipRateMm = null;
    sample.frame.fdm.precipState = null;
    sample.frame.fdm.inCloud = null;
    return sample;
  });

  const starts = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  const summary = runner.evaluateSamples();
  assertEqual(starts.length, 0, 'motion-only convective diagnostics should not broadcast flight violations');
  assertEqual(events.starts.length, 1, 'sustained motion-only evidence should emit an internal diagnostic');
  assertEqual(summary.confidenceLevel, 'LOW', 'motion-only proxy should be low confidence internally');
  assertEqual(summary.weatherDataAvailable, false, 'weather availability should be false internally');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
