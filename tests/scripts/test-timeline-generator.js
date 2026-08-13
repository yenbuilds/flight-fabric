#!/usr/bin/env node
/**
 * test-timeline-generator.js
 *
 * Tests for timeline-generator internals:
 *   1. toFiniteNumber() — CSV string → number conversion
 *   2. csvRowToStabilityFrame() — CSV row → stability frame reconstruction
 *
 * These are critical because csvRowToStabilityFrame() is the ONLY path that
 * reconstructs telemetry from persisted CSV for replay and approach profile
 * generation. A bug here silently corrupts all historical flight analysis.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { getRepoScratchPath } = require('./repo-scratch');
const { VIOLATION_RULE } = require('../../shared/violation-rules.js');

const tmpRoot = getRepoScratchPath('timeline-generator-appdata');
const tempHome = path.join(tmpRoot, 'Home');
const tempAppData = path.join(tmpRoot, 'AppData', 'Roaming');
fs.mkdirSync(tempHome, { recursive: true });
fs.mkdirSync(tempAppData, { recursive: true });
process.env.APPDATA = tempAppData;
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
process.env.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS = '1';
delete process.env.OneDrive;
delete process.env.ONEDRIVE;
delete process.env.OneDriveConsumer;
delete process.env.OneDriveCommercial;

const timelineGeneratorPath = resolveBackendRuntimeFile('events', 'timeline-generator.js');
const timelineTouchdownPath = resolveBackendRuntimeFile('events', 'timeline-touchdown.js');
const runwayDatabasePath = resolveBackendRuntimeFile('landing', 'runway-database.js');
const profileLoader = require(resolveBackendRuntimeFile('aircraft', 'aircraft-profile-loader.js'));
const {
  CURRENT_ANALYSIS_RESCORE_CONTRACT,
  _toFiniteNumber: toFiniteNumber,
  _csvRowToStabilityFrame: csvRowToStabilityFrame,
  _downsampleApproachProfile: downsampleApproachProfile,
  _generateTimelineFromRows: generateTimelineFromRows,
  _quickPeekCSV: quickPeekCSV,
  getFlightLogsDir,
  listCSVFlights,
} =
  require(timelineGeneratorPath);

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
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

function approx(a, b, tol = 0.001) {
  return Math.abs(a - b) <= tol;
}

async function withMockRunway(runwayData, fn) {
  const previousTimelineGenerator = require.cache[timelineGeneratorPath];
  const previousTimelineTouchdown = require.cache[timelineTouchdownPath];
  const previousRunwayDatabase = require.cache[runwayDatabasePath];

  delete require.cache[timelineGeneratorPath];
  delete require.cache[timelineTouchdownPath];
  require.cache[runwayDatabasePath] = {
    id: runwayDatabasePath,
    filename: runwayDatabasePath,
    loaded: true,
    exports: {
      findRunwayByPosition: () => runwayData,
    },
  };

  try {
    const timelineGenerator = require(timelineGeneratorPath);
    return await fn(timelineGenerator);
  } finally {
    delete require.cache[timelineGeneratorPath];
    if (previousTimelineGenerator) require.cache[timelineGeneratorPath] = previousTimelineGenerator;

    delete require.cache[timelineTouchdownPath];
    if (previousTimelineTouchdown) require.cache[timelineTouchdownPath] = previousTimelineTouchdown;

    delete require.cache[runwayDatabasePath];
    if (previousRunwayDatabase) require.cache[runwayDatabasePath] = previousRunwayDatabase;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. toFiniteNumber
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ntoFiniteNumber');
// NOTE: In production, values reaching toFiniteNumber have already been
// through parseValue(), which converts CSV '' → null and numeric strings →
// numbers. Tests below reflect the actual call convention.
test('numeric value passes through', () => assert(toFiniteNumber(250.3) === 250.3, 'expected 250.3'));
test('integer value passes through', () => assert(toFiniteNumber(35000) === 35000, 'expected 35000'));
test('zero passes through', () => assert(toFiniteNumber(0) === 0, 'expected 0'));
test('negative value passes through', () => assert(toFiniteNumber(-850.7) === -850.7, 'expected -850.7'));
test('numeric string coerced (direct call safety)', () => assert(toFiniteNumber('250.3') === 250.3, 'expected 250.3'));
test('null → null (parseValue converts CSV "" to null)', () => assert(toFiniteNumber(null) === null, 'expected null'));
test('undefined → null', () => assert(toFiniteNumber(undefined) === null, 'expected null'));
test('NaN (number) → null', () => assert(toFiniteNumber(NaN) === null, 'expected null'));
test('"NaN" string → null', () => assert(toFiniteNumber('NaN') === null, 'expected null'));
test('Infinity → null', () => assert(toFiniteNumber(Infinity) === null, 'expected null'));
test('-Infinity → null', () => assert(toFiniteNumber(-Infinity) === null, 'expected null'));
test('"abc" string → null', () => assert(toFiniteNumber('abc') === null, 'expected null'));

// ─────────────────────────────────────────────────────────────────────────────
// 2. csvRowToStabilityFrame — basic field extraction
// ─────────────────────────────────────────────────────────────────────────────

test('flight listing converts CSV coordinates before deriving airport route labels', () => {
  const logsDir = getFlightLogsDir();
  const csvPath = path.join(logsDir, '2026-07-22T00-00-00_to-YSCB.csv');
  const headers = [
    'record_type',
    'timestamp_utc',
    'ts',
    'flight_elapsed_ms',
    'aircraft',
    'lat_deg',
    'lon_deg',
    'ias_kts',
    'vs_fpm',
    'ra_ft',
  ];
  const startTs = Date.parse('2026-07-22T00:00:00.000Z');
  const rows = Array.from({ length: 6 }, (_, index) => {
    const departure = index < 3;
    return [
      'SAMPLE',
      new Date(startTs + index * 1000).toISOString(),
      startTs + index * 1000,
      index * 1000,
      'Route Test',
      departure ? -37.6706 : -35.3072,
      departure ? 144.8462 : 149.1912,
      140,
      -500,
      500,
    ];
  });

  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(',')), ''].join('\n'), 'utf8');

  try {
    const peek = quickPeekCSV(csvPath);
    assert(typeof peek.firstCoordRow?.lat_deg === 'number', 'first latitude should be normalized to a number');
    assert(typeof peek.firstCoordRow?.lon_deg === 'number', 'first longitude should be normalized to a number');

    const flights = listCSVFlights({ allowedCsvPaths: [csvPath] });
    assert(flights.length === 1, `expected one listed flight, got ${flights.length}`);
    assert(
      flights[0].displayRouteLabel === 'YMML \u2192 YSCB',
      `expected YMML to YSCB, got ${flights[0].displayRouteLabel}`,
    );
  } finally {
    fs.rmSync(csvPath, { force: true });
  }
});

console.log('\ncsvRowToStabilityFrame: basic fields');

// In production, rows have already been processed by parseValue():
//   CSV string ''   → null
//   CSV string '0'  → 0   (number)
//   CSV string '1'  → 1   (number)
//   CSV string '60.0' → 60 (number)
// We simulate that here by using numbers/null directly.
const baseRow = {
  ra_ft: 250.0,
  alt_msl_ft: 35000.0,
  alt_calibrated_ft: 34980.0,
  alt_plane_ft: 34975.0,
  pressure_alt_ft: 36100.0,
  aircraft_agl_ft: 34100.0,
  aircraft_above_obstacles_ft: 34050.0,
  plane_agl_ft: 34050.0,
  plane_agl_minus_cg_ft: 34042.0,
  ias_kts: 250.3,
  vs_fpm: -850.7,
  gs_kts: 252.0,
  gear_down_locked: 0,
  flaps_pct: 20.0,
  flaps_notch: 2,
  spoiler_pct: 0.0,
  spoiler_state: 'ARMED',
  pitch_deg: -3.5,
  bank_deg: 1.2,
  hdg_true_deg: 180.0,
  thr1_pct: 60.0,
  thr2_pct: 60.0,
  thr3_pct: null,   // not present on 2-engine aircraft
  thr4_pct: null,   // not present on 2-engine aircraft
  on_ground: 0,
  lat_deg: 51.4700,
  lon_deg: -0.4543,
};

const frame = csvRowToStabilityFrame(baseRow, 100);

test('raFt extracted', () => assert(approx(frame.raFt, 250.0), `got ${frame.raFt}`));
test('altMslFt extracted', () => assert(approx(frame.altMslFt, 35000.0), `got ${frame.altMslFt}`));
test('altCalibratedFt extracted', () => assert(approx(frame.altCalibratedFt, 34980.0), `got ${frame.altCalibratedFt}`));
test('altPlaneFt extracted', () => assert(approx(frame.altPlaneFt, 34975.0), `got ${frame.altPlaneFt}`));
test('pressureAltFt extracted', () => assert(approx(frame.pressureAltFt, 36100.0), `got ${frame.pressureAltFt}`));
test('terrain-relative altitude diagnostics extracted', () => {
  assert(approx(frame.aircraftAglFt, 34100.0), `aircraftAglFt=${frame.aircraftAglFt}`);
  assert(approx(frame.aircraftAboveObstaclesFt, 34050.0), `aircraftAboveObstaclesFt=${frame.aircraftAboveObstaclesFt}`);
  assert(approx(frame.planeAglFt, 34050.0), `planeAglFt=${frame.planeAglFt}`);
  assert(approx(frame.planeAglMinusCgFt, 34042.0), `planeAglMinusCgFt=${frame.planeAglMinusCgFt}`);
});
test('iasKts extracted', () => assert(approx(frame.iasKts, 250.3), `got ${frame.iasKts}`));
test('vsFpm extracted', () => assert(approx(frame.vsFpm, -850.7), `got ${frame.vsFpm}`));
test('gsKts extracted', () => assert(approx(frame.gsKts, 252.0), `got ${frame.gsKts}`));
test('gearDownLocked extracted (0 → 0)', () => assert(frame.gearDownLocked === 0, `got ${frame.gearDownLocked}`));
test('flapsPercent extracted', () => assert(approx(frame.flapsPercent, 20.0), `got ${frame.flapsPercent}`));
test('flapsNotch extracted', () => assert(frame.flapsNotch === 2, `got ${frame.flapsNotch}`));
test('spoilersPercent extracted', () => assert(approx(frame.spoilersPercent, 0.0), `got ${frame.spoilersPercent}`));
test('spoilersState extracted', () => assert(frame.spoilersState === 'ARMED', `got ${frame.spoilersState}`));
test('pitchDeg extracted', () => assert(approx(frame.pitchDeg, -3.5), `got ${frame.pitchDeg}`));
test('bankDeg extracted', () => assert(approx(frame.bankDeg, 1.2), `got ${frame.bankDeg}`));
test('headingDeg extracted', () => assert(approx(frame.headingDeg, 180.0), `got ${frame.headingDeg}`));
test('onGround 0 -> false', () => assert(!frame.onGround, `got ${frame.onGround}`));
test('sim_paused true -> paused true', () => {
  const f = csvRowToStabilityFrame({ ...baseRow, sim_paused: true }, 100);
  assert(f.paused === true, `expected paused true, got ${f.paused}`);
});
test('sim_in_menu true -> inMenu true', () => {
  const f = csvRowToStabilityFrame({ ...baseRow, sim_in_menu: true }, 100);
  assert(f.inMenu === true, `expected inMenu true, got ${f.inMenu}`);
});
test('latDeg propagated', () => assert(approx(frame.latDeg, 51.47), `got ${frame.latDeg}`));
test('lonDeg propagated', () => assert(approx(frame.lonDeg, -0.4543), `got ${frame.lonDeg}`));
test('dtMs passed through', () => assert(frame.dtMs === 100, `got ${frame.dtMs}`));

test('recorded approach profile locks calibrated altitude instead of replaying a cockpit jump', () => {
  const indicated = [1200, 600, 850, 300, 20];
  const calibrated = [1200, 900, 600, 300, 20];
  const samples = calibrated.map((altCalibratedFt, index) => ({
    raFt: altCalibratedFt,
    altMslFt: indicated[index],
    altCalibratedFt,
    tMs: index * 1000,
  }));
  const profile = downsampleApproachProfile(samples, 120);
  assert(profile.every(point => point.profileAltitudeSource === 'calibrated'), 'source should be calibrated for every point');
  assert(
    profile.every((point, index) => point.profileAltMslFt === calibrated[index]),
    'selected profile values should follow calibrated altitude through the indicated correction',
  );
});

test('recorded approach profile prefers plane altitude for geometric geometry', () => {
  const plane = [1200, 900, 600, 300, 20];
  const calibrated = [1200, 650, 850, 300, 20];
  const samples = plane.map((altPlaneFt, index) => ({
    raFt: altPlaneFt,
    altMslFt: calibrated[index],
    altCalibratedFt: calibrated[index],
    altPlaneFt,
    tMs: index * 1000,
  }));
  const profile = downsampleApproachProfile(samples, 120);
  assert(profile.every(point => point.profileAltitudeSource === 'plane'), 'source should be plane for every point');
  assert(profile.every((point, index) => point.profileAltitudeFt === plane[index]));
  assert(profile.every((point, index) => point.profileAltMslFt === plane[index]), 'legacy alias should carry plane altitude');
});

test('recorded approach profile honors the runway-aware source locked by scoring', () => {
  const calibrated = [1200, 900, 600, 300, 20];
  const samples = calibrated.map((altCalibratedFt, index) => ({
    raFt: altCalibratedFt,
    altMslFt: altCalibratedFt,
    altCalibratedFt,
    // This source has generic coverage but never reaches the operational gate.
    altPlaneFt: 2200 - index * 100,
    tMs: index * 1000,
    absMs: 1700000000000 + index * 1000,
  }));
  const profile = downsampleApproachProfile(samples, 120, 'calibrated');
  assert(profile.every(point => point.profileAltitudeSource === 'calibrated'), 'locked scoring source should win');
  assert(profile.every((point, index) => point.profileAltitudeFt === calibrated[index]));
  assert(profile.every((point, index) => Number.isFinite(point.absMs)), 'replay timestamps should be preserved');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Thrust averaging across multiple engines
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ncsvRowToStabilityFrame: thrust averaging');

test('2-engine aircraft: averages thr1+thr2 only', () => {
  const row2eng = { ...baseRow, thr1_pct: 60.0, thr2_pct: 70.0, thr3_pct: null, thr4_pct: null };
  const f = csvRowToStabilityFrame(row2eng, 100);
  assert(approx(f.thrustPct, 65.0), `expected 65.0, got ${f.thrustPct}`);
});

test('3-engine aircraft: averages thr1+thr2+thr3 only', () => {
  const row3eng = { ...baseRow, thr1_pct: 60.0, thr2_pct: 60.0, thr3_pct: 60.0, thr4_pct: null };
  const f = csvRowToStabilityFrame(row3eng, 100);
  assert(approx(f.thrustPct, 60.0), `expected 60.0, got ${f.thrustPct}`);
});

test('3-engine aircraft with asymmetric thrust: correct average', () => {
  const row3eng = { ...baseRow, thr1_pct: 70.0, thr2_pct: 80.0, thr3_pct: 90.0, thr4_pct: null };
  const f = csvRowToStabilityFrame(row3eng, 100);
  // (70 + 80 + 90) / 3 = 80
  assert(approx(f.thrustPct, 80.0), `expected 80.0, got ${f.thrustPct}`);
});

test('4-engine aircraft: averages all four', () => {
  const row4eng = { ...baseRow, thr1_pct: 50.0, thr2_pct: 60.0, thr3_pct: 70.0, thr4_pct: 80.0 };
  const f = csvRowToStabilityFrame(row4eng, 100);
  // (50 + 60 + 70 + 80) / 4 = 65
  assert(approx(f.thrustPct, 65.0), `expected 65.0, got ${f.thrustPct}`);
});

test('all throttles absent → thrust null', () => {
  const noThrust = { ...baseRow, thr1_pct: null, thr2_pct: null, thr3_pct: null, thr4_pct: null };
  const f = csvRowToStabilityFrame(noThrust, 100);
  assert(f.thrustPct === null, `expected null, got ${f.thrustPct}`);
});

test('single working engine → thrust equals that engine', () => {
  const row1eng = { ...baseRow, thr1_pct: 75.0, thr2_pct: null, thr3_pct: null, thr4_pct: null };
  const f = csvRowToStabilityFrame(row1eng, 100);
  assert(approx(f.thrustPct, 75.0), `expected 75.0, got ${f.thrustPct}`);
});

test('NaN throttle value excluded from average', () => {
  // In production, NaN string → parseValue → NaN (number) → toFiniteNumber(NaN) → null
  const row2eng = { ...baseRow, thr1_pct: NaN, thr2_pct: 60.0, thr3_pct: null, thr4_pct: null };
  const f = csvRowToStabilityFrame(row2eng, 100);
  assert(approx(f.thrustPct, 60.0), `expected 60.0, got ${f.thrustPct}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Edge cases
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ncsvRowToStabilityFrame: edge cases');

test('empty spoiler_state → null (falsy check)', () => {
  const row = { ...baseRow, spoiler_state: '' };
  const f = csvRowToStabilityFrame(row, 100);
  assert(f.spoilersState === null, `expected null, got ${f.spoilersState}`);
});

test('on_ground "1" → truthy', () => {
  const row = { ...baseRow, on_ground: 1 };
  const f = csvRowToStabilityFrame(row, 100);
  assert(f.onGround === true || f.onGround, `expected truthy, got ${f.onGround}`);
});

test('on_ground "0" → falsy', () => {
  const row = { ...baseRow, on_ground: 0 };
  const f = csvRowToStabilityFrame(row, 100);
  assert(!f.onGround, `expected falsy, got ${f.onGround}`);
});

test('missing lat/lon → null values', () => {
  const row = { ...baseRow, lat_deg: null, lon_deg: null };
  const f = csvRowToStabilityFrame(row, 100);
  assert(f.latDeg === null, `latDeg expected null, got ${f.latDeg}`);
  assert(f.lonDeg === null, `lonDeg expected null, got ${f.lonDeg}`);
});

test('missing ra → null', () => {
  const row = { ...baseRow, ra_ft: null };
  const f = csvRowToStabilityFrame(row, 100);
  assert(f.raFt === null, `expected null, got ${f.raFt}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Timeline track thinning
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ngenerateTimelineFromRows: track thinning');

test('high-frequency moving samples produce timed breadcrumb track points', () => {
  const baseTs = 1700000400000;
  const rows = Array.from({ length: 101 }, (_, index) => ({
    flight_id: 'track-thinning',
    timestamp_utc: new Date(baseTs + index * 100).toISOString(),
    ts: baseTs + index * 100,
    flight_elapsed_ms: index * 100,
    record_type: 'SAMPLE',
    phase: 'CRUISE',
    lat_deg: 40 + index * 0.001,
    lon_deg: -70 - index * 0.001,
    ra_ft: 5000,
    on_ground: false,
    ias_kts: 250,
    vs_fpm: 0,
    gs_kts: 450,
    hdg_true_deg: 90,
    alt_msl_ft: 12000,
    aircraft: 'Track Test',
  }));

  const result = generateTimelineFromRows('track-thinning.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);
  assert(result.timeline.track.length === 6, `expected 6 timed track points, got ${result.timeline.track.length}`);
  assert(result.timeline.track[0].timestampMs === baseTs, 'expected first track point to be retained');
  assert(result.timeline.track.at(-1).timestampMs === baseTs + 10000, 'expected final track point to be retained');
});

test('profile-backed flap detent changes appear as reliable configuration events', () => {
  const baseTs = 1700000450000;
  const flapNotches = [0, 1, 1, 3, 3, 2, 2];
  const rows = flapNotches.map((flapsNotch, index) => ({
    flight_id: 'flap-timeline',
    timestamp_utc: new Date(baseTs + index * 1000).toISOString(),
    ts: baseTs + index * 1000,
    flight_elapsed_ms: index * 1000,
    record_type: 'SAMPLE',
    phase: index < 2 ? 'PARKED' : 'TAXI',
    lat_deg: -33.94 + index * 0.0001,
    lon_deg: 151.17,
    ra_ft: 0,
    on_ground: true,
    ias_kts: index * 3,
    vs_fpm: 0,
    gs_kts: index * 3,
    hdg_true_deg: 340,
    alt_msl_ft: 20,
    aircraft: 'FlyByWire A32NX',
    // Recordings persist the bare profile id, so exercise the real replay lookup.
    aircraft_profile_id: 'fbw-a32nx',
    flaps_notch: flapsNotch,
    flaps_pct: flapsNotch * 25,
    flaps_source: 'lvar',
  }));

  const result = generateTimelineFromRows('flap-timeline.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);
  const flapEvents = result.timeline.events.filter((event) =>
    event.type === 'configuration_event' && event.eventType === 'flaps_changed');

  assert(flapEvents.length === 3, `expected 3 flap changes, got ${flapEvents.length}`);
  assert(flapEvents[0].label === 'Flaps extended to 1/1+F', `unexpected first label ${flapEvents[0].label}`);
  assert(flapEvents[0].summary === 'UP -> 1/1+F', `unexpected first summary ${flapEvents[0].summary}`);
  assert(flapEvents[1].summary === '1/1+F -> 3', `unexpected second summary ${flapEvents[1].summary}`);
  assert(flapEvents[2].label === 'Flaps retracted to 2', `unexpected final label ${flapEvents[2].label}`);
  assert(flapEvents[2].summary === '3 -> 2', `unexpected final summary ${flapEvents[2].summary}`);
  assert(flapEvents.every((event) => event.confidence === 'profile-confirmed'), 'expected profile-backed confidence');
  assert(flapEvents[0].timestampMs === baseTs + 1000, 'confirmed change should retain its first-observed timestamp');
});

test('legacy recordings infer flap events only from configured documented LVAR profiles', () => {
  const baseTs = 1700000455000;
  const rows = [0, 1, 1].map((flapsNotch, index) => ({
    flight_id: 'legacy-flap-timeline',
    timestamp_utc: new Date(baseTs + index * 1000).toISOString(),
    ts: baseTs + index * 1000,
    flight_elapsed_ms: index * 1000,
    record_type: 'SAMPLE',
    phase: 'TAXI',
    on_ground: true,
    aircraft_profile_id: 'fbw-a32nx',
    flaps_notch: flapsNotch,
  }));

  const result = generateTimelineFromRows('legacy-flap-timeline.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);
  const flapEvents = result.timeline.events.filter((event) => event.type === 'configuration_event');
  assert(flapEvents.length === 1, `expected one legacy flap event, got ${flapEvents.length}`);
  assert(flapEvents[0].source === 'profile-inferred', `expected legacy source marker, got ${flapEvents[0].source}`);
});

test('transient flap detent chatter does not create timeline events', () => {
  const baseTs = 1700000458000;
  const rows = [0, 1, 0, 0].map((flapsNotch, index) => ({
    flight_id: 'flap-chatter',
    timestamp_utc: new Date(baseTs + index * 250).toISOString(),
    ts: baseTs + index * 250,
    flight_elapsed_ms: index * 250,
    record_type: 'SAMPLE',
    phase: 'TAXI',
    on_ground: true,
    aircraft_profile_id: 'fbw-a32nx',
    flaps_notch: flapsNotch,
    flaps_source: 'lvar',
  }));

  const result = generateTimelineFromRows('flap-chatter.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);
  assert(!result.timeline.events.some((event) => event.type === 'configuration_event'), 'single-sample detent chatter should stay hidden');
});

test('unsettled generic flap percentages do not create intermediate configuration events', () => {
  const baseTs = 1700000460000;
  const rows = [0, 12, 37].map((flapsNotch, index) => ({
    flight_id: 'generic-flap-timeline',
    timestamp_utc: new Date(baseTs + index * 1000).toISOString(),
    ts: baseTs + index * 1000,
    flight_elapsed_ms: index * 1000,
    record_type: 'SAMPLE',
    phase: 'TAXI',
    on_ground: true,
    aircraft_profile_id: 'bundled/msfs/generic',
    flaps_notch: flapsNotch,
    flaps_pct: flapsNotch,
    flaps_source: 'percent',
  }));

  const result = generateTimelineFromRows('generic-flap-timeline.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);
  assert(!result.timeline.events.some((event) => event.type === 'configuration_event'), 'unsettled generic flap movement should stay hidden');
});

test('settled generic flap percentages create one destination event', () => {
  const baseTs = 1700000462000;
  const samples = [
    { offsetMs: 0, percent: 0 },
    { offsetMs: 250, percent: 18 },
    { offsetMs: 500, percent: 37 },
    { offsetMs: 1000, percent: 37.2 },
    { offsetMs: 1500, percent: 37.1 },
  ];
  const rows = samples.map(({ offsetMs, percent }) => ({
    flight_id: 'generic-percent-flap-timeline',
    timestamp_utc: new Date(baseTs + offsetMs).toISOString(),
    ts: baseTs + offsetMs,
    flight_elapsed_ms: offsetMs,
    record_type: 'SAMPLE',
    phase: 'TAXI',
    on_ground: true,
    aircraft_profile_id: 'generic',
    flaps_notch: percent,
    flaps_pct: percent,
    flaps_source: 'percent',
  }));

  const result = generateTimelineFromRows('generic-percent-flap-timeline.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);
  const flapEvents = result.timeline.events.filter((event) => event.type === 'configuration_event');
  assert(flapEvents.length === 1, `expected one settled percent event, got ${flapEvents.length}`);
  assert(flapEvents[0].label === 'Flaps extended to 37%', `unexpected percent label ${flapEvents[0].label}`);
  assert(flapEvents[0].summary === 'UP -> 37%', `unexpected percent summary ${flapEvents[0].summary}`);
  assert(flapEvents[0].context.value_type === 'percent', 'expected percent value type');
  assert(flapEvents[0].confidence === 'simconnect', 'percent fallback should not claim profile-confirmed provenance');
});

test('documented third-party profile detents create flap events from profile mapping', () => {
  const baseTs = 1700000465000;
  const rows = [0, 5, 5].map((flapsNotch, index) => ({
    flight_id: 'ifly-flap-timeline',
    timestamp_utc: new Date(baseTs + index * 1000).toISOString(),
    ts: baseTs + index * 1000,
    flight_elapsed_ms: index * 1000,
    record_type: 'SAMPLE',
    phase: 'TAXI',
    on_ground: true,
    aircraft_profile_id: 'ifly-737-max-8',
    flaps_notch: flapsNotch,
    flaps_source: 'profile',
  }));

  const result = generateTimelineFromRows('ifly-flap-timeline.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);
  const flapEvents = result.timeline.events.filter((event) => event.type === 'configuration_event');
  assert(flapEvents.length === 1, `expected one iFly flap event, got ${flapEvents.length}`);
  assert(flapEvents[0].label === 'Flaps extended to 5', `unexpected iFly label ${flapEvents[0].label}`);
  assert(flapEvents[0].source === 'profile', `expected recorded profile source, got ${flapEvents[0].source}`);
});

test('estimated third-party detents fall back to settled flap percentages', () => {
  const baseTs = 1700000470000;
  const rows = [0, 25, 25].map((flapsPercent, index) => ({
    flight_id: 'a310-flap-timeline',
    timestamp_utc: new Date(baseTs + index * 1000).toISOString(),
    ts: baseTs + index * 1000,
    flight_elapsed_ms: index * 1000,
    record_type: 'SAMPLE',
    phase: 'TAXI',
    on_ground: true,
    aircraft_profile_id: 'inibuilds-a310',
    flaps_notch: index === 0 ? 0 : 1,
    flaps_pct: flapsPercent,
    flaps_source: 'profile',
  }));

  const result = generateTimelineFromRows('a310-flap-timeline.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);
  const flapEvents = result.timeline.events.filter((event) => event.type === 'configuration_event');
  assert(flapEvents.length === 1, `expected one A310 percent fallback event, got ${flapEvents.length}`);
  assert(flapEvents[0].label === 'Flaps extended to 25%', `unexpected A310 fallback label ${flapEvents[0].label}`);
  assert(flapEvents[0].context.value_type === 'percent', 'estimated A310 detent should be labeled as a percent fallback');
});

test('rapid lever travel settles to one final flap event instead of intermediate spam', () => {
  const baseTs = 1700000475000;
  const samples = [
    { offsetMs: 0, notch: 0 },
    { offsetMs: 100, notch: 1 },
    { offsetMs: 300, notch: 1 },
    { offsetMs: 400, notch: 2 },
    { offsetMs: 700, notch: 2 },
    { offsetMs: 950, notch: 2 },
  ];
  const rows = samples.map(({ offsetMs, notch }) => ({
    flight_id: 'settled-flap-timeline',
    timestamp_utc: new Date(baseTs + offsetMs).toISOString(),
    ts: baseTs + offsetMs,
    flight_elapsed_ms: offsetMs,
    record_type: 'SAMPLE',
    phase: 'TAXI',
    on_ground: true,
    aircraft_profile_id: 'fbw-a32nx',
    flaps_notch: notch,
    flaps_source: 'lvar',
  }));

  const result = generateTimelineFromRows('settled-flap-timeline.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);
  const flapEvents = result.timeline.events.filter((event) => event.type === 'configuration_event');
  assert(flapEvents.length === 1, `expected one settled flap event, got ${flapEvents.length}`);
  assert(flapEvents[0].summary === 'UP -> 2', `expected final detent only, got ${flapEvents[0].summary}`);
  assert(flapEvents[0].timestampMs === baseTs + 400, 'settled event should retain first observation of the final detent');
});

function makeSpoilerTimelineRows(baseTs, samples, overrides = {}) {
  return samples.map(({ offsetMs, percent, state = percent > 0 ? 'EXTENDED' : 'STOWED' }) => ({
    flight_id: 'spoiler-timeline',
    timestamp_utc: new Date(baseTs + offsetMs).toISOString(),
    ts: baseTs + offsetMs,
    flight_elapsed_ms: offsetMs,
    record_type: 'SAMPLE',
    phase: 'DESCENT',
    on_ground: false,
    aircraft_profile_id: 'generic',
    spoiler_pct: percent,
    spoiler_state: state,
    spoiler_source: 'simconnect',
    spoiler_available: true,
    ...overrides,
  }));
}

test('spoiler telemetry never creates timeline configuration events', () => {
  const baseTs = 1700000480000;
  const rows = makeSpoilerTimelineRows(baseTs, [
    { offsetMs: 0, percent: 0 },
    { offsetMs: 100, percent: 18 },
    { offsetMs: 300, percent: 42 },
    { offsetMs: 500, percent: 68 },
    { offsetMs: 1200, percent: 69 },
    { offsetMs: 2100, percent: 68 },
  ]);

  const result = generateTimelineFromRows('spoiler-timeline.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);
  const spoilerEvents = result.timeline.events.filter((event) =>
    event.type === 'configuration_event' && event.eventType === 'spoilers_changed');

  assert(spoilerEvents.length === 0, `expected no spoiler change indications, got ${spoilerEvents.length}`);
});

function makeApproachDeviationRow(baseTs, index, overrides = {}) {
  return {
    flight_id: 'localizer-relevance',
    timestamp_utc: new Date(baseTs + index * 1000).toISOString(),
    ts: baseTs + index * 1000,
    flight_elapsed_ms: index * 1000,
    record_type: 'SAMPLE',
    phase: 'APPROACH',
    lat_deg: 40 + index * 0.001,
    lon_deg: -70 - index * 0.001,
    ra_ft: 900 - index * 100,
    on_ground: false,
    ias_kts: 140,
    vs_fpm: -700,
    gs_kts: 140,
    hdg_true_deg: 90,
    alt_msl_ft: 1500 - index * 100,
    bank_deg: 2,
    loc_deviation_dots: 2.4,
    gs_deviation_dots: null,
    aircraft: 'A320',
    ...overrides,
  };
}

test('non-localizer approaches ignore stale loc deviation dots', () => {
  const baseTs = 1700000500000;
  const rows = [
    makeApproachDeviationRow(baseTs, 0, { approach_type: 'VISUAL' }),
    makeApproachDeviationRow(baseTs, 1, { approach_type: 'RNAV' }),
    makeApproachDeviationRow(baseTs, 2, { approach_type: '' }),
  ];

  const result = generateTimelineFromRows('visual-stale-localizer.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);

  const localizerEvents = result.timeline.events.filter((event) =>
    event.type === 'violation_start' && event.ruleId === 'LOCALIZER');
  assert(localizerEvents.length === 0, `expected no LOCALIZER events, got ${localizerEvents.length}`);
});

test('ILS approaches still emit localizer deviation warnings', () => {
  const baseTs = 1700000600000;
  const rows = [
    makeApproachDeviationRow(baseTs, 0, { approach_type: 'ILS', loc_deviation_dots: 2.4 }),
    makeApproachDeviationRow(baseTs, 1, { approach_type: 'ILS', loc_deviation_dots: 0.2 }),
  ];

  const result = generateTimelineFromRows('ils-localizer-warning.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);

  const localizerStart = result.timeline.events.find((event) =>
    event.type === 'violation_start' && event.ruleId === 'LOCALIZER');
  assert(localizerStart, 'expected LOCALIZER violation_start');
  assert(localizerStart.severity === 'warning', `expected warning severity, got ${localizerStart.severity}`);
  assert(localizerStart.context.approach_type === 'ILS', `expected context approach_type ILS, got ${localizerStart.context.approach_type}`);
});

test('valid NAV localizer context emits localizer warning without approach type', () => {
  const baseTs = 1700000650000;
  const rows = [
    makeApproachDeviationRow(baseTs, 0, {
      approach_type: '',
      nav1_has_localizer: true,
      nav1_signal: 92,
      loc_deviation_dots: -1.4,
    }),
    makeApproachDeviationRow(baseTs, 1, {
      approach_type: '',
      nav1_has_localizer: true,
      nav1_signal: 92,
      loc_deviation_dots: -0.2,
    }),
  ];

  const result = generateTimelineFromRows('nav-valid-localizer.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);

  const localizerStart = result.timeline.events.find((event) =>
    event.type === 'violation_start' && event.ruleId === 'LOCALIZER');
  assert(localizerStart, 'expected LOCALIZER violation_start from nav validity fields');
  assert(localizerStart.context.nav1_has_localizer === true, 'expected nav1_has_localizer context true');
});

test('invalid NAV glideslope context suppresses glideslope warning', () => {
  const baseTs = 1700000660000;
  const rows = [
    makeApproachDeviationRow(baseTs, 0, {
      approach_type: 'ILS',
      nav1_has_glideslope: false,
      nav1_signal: 92,
      gs_deviation_dots: -2.0,
      loc_deviation_dots: 0.2,
    }),
    makeApproachDeviationRow(baseTs, 1, {
      approach_type: 'ILS',
      nav1_has_glideslope: false,
      nav1_signal: 92,
      gs_deviation_dots: -0.2,
      loc_deviation_dots: 0.2,
    }),
  ];

  const result = generateTimelineFromRows('nav-invalid-glideslope.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);

  const glideslopeStart = result.timeline.events.find((event) =>
    event.type === 'violation_start' && event.ruleId === 'GLIDESLOPE');
  assert(!glideslopeStart, 'expected no GLIDESLOPE violation_start when nav1_has_glideslope is false');
});

test('undocumented NAV GSI polarity does not change glideslope severity', () => {
  const baseTs = 1700000670000;
  for (const deviation of [-1.6, 1.6]) {
    const rows = [
      makeApproachDeviationRow(baseTs, 0, {
        approach_type: 'ILS',
        nav1_has_glideslope: true,
        nav1_signal: 92,
        gs_deviation_dots: deviation,
      }),
      makeApproachDeviationRow(baseTs, 1, {
        approach_type: 'ILS',
        nav1_has_glideslope: true,
        nav1_signal: 92,
        gs_deviation_dots: 0.2,
      }),
    ];
    const result = generateTimelineFromRows(`nav-gsi-${deviation}.csv`, rows);
    const start = result.timeline.events.find((event) =>
      event.type === 'violation_start' && event.ruleId === 'GLIDESLOPE');
    assert(start, `expected GLIDESLOPE start for ${deviation} dots`);
    assert(start.severity === 'caution', `expected symmetric caution severity, got ${start.severity}`);
    assert(start.context.direction == null, 'raw NAV GSI sign must not be labelled above/below');
  }
});

test('ILS approaches ignore impossible localizer and glideslope dots', () => {
  const baseTs = 1700000700000;
  const rows = [
    makeApproachDeviationRow(baseTs, 0, {
      approach_type: 'ILS',
      gs_deviation_dots: 141.14,
      loc_deviation_dots: 141.14,
    }),
    makeApproachDeviationRow(baseTs, 1, {
      approach_type: 'ILS',
      gs_deviation_dots: 0.2,
      loc_deviation_dots: 0.2,
    }),
  ];

  const result = generateTimelineFromRows('ils-impossible-needles.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);

  const needleEvents = result.timeline.events.filter((event) =>
    event.type === 'violation_start' && (event.ruleId === 'LOCALIZER' || event.ruleId === 'GLIDESLOPE'));
  assert(needleEvents.length === 0, `expected no ILS needle events, got ${needleEvents.length}`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('marginal high-sink excursions shorter than three seconds stay out of the timeline', () => {
  const baseTs = 1700000705000;
  const samples = [
    { offsetMs: 0, vsFpm: -1000.2 },
    { offsetMs: 1000, vsFpm: -1033.7 },
    { offsetMs: 2000, vsFpm: -1010 },
    { offsetMs: 2500, vsFpm: -989.2 },
  ];
  const rows = samples.map(({ offsetMs, vsFpm }, index) => makeApproachDeviationRow(baseTs, index, {
    timestamp_utc: new Date(baseTs + offsetMs).toISOString(),
    ts: baseTs + offsetMs,
    flight_elapsed_ms: offsetMs,
    vs_fpm: vsFpm,
    approach_type: 'ILS',
    nav1_has_glideslope: true,
    nav1_signal: 90,
    gs_deviation_dots: 0,
    loc_deviation_dots: 0,
  }));

  const result = generateTimelineFromRows('high-sink-marginal.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);
  const highSinkEvents = result.timeline.events.filter((event) =>
    event.ruleId === VIOLATION_RULE.HIGH_SINK_RATE);
  assert(highSinkEvents.length === 0, `expected no marginal high-sink events, got ${highSinkEvents.length}`);
});

test('sustained high sink retains onset, peak, duration, and clear hysteresis', () => {
  const baseTs = 1700000710000;
  const samples = [
    { offsetMs: 0, vsFpm: -1010 },
    { offsetMs: 1000, vsFpm: -1200 },
    { offsetMs: 2000, vsFpm: -1350 },
    { offsetMs: 3000, vsFpm: -1250 },
    { offsetMs: 4000, vsFpm: -950 },
    { offsetMs: 5000, vsFpm: -880 },
  ];
  const rows = samples.map(({ offsetMs, vsFpm }, index) => makeApproachDeviationRow(baseTs, index, {
    timestamp_utc: new Date(baseTs + offsetMs).toISOString(),
    ts: baseTs + offsetMs,
    flight_elapsed_ms: offsetMs,
    vs_fpm: vsFpm,
    approach_type: 'ILS',
    nav1_has_glideslope: true,
    nav1_signal: 90,
    gs_deviation_dots: 0,
    loc_deviation_dots: 0,
  }));

  const result = generateTimelineFromRows('high-sink-sustained.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);
  const highSinkEvents = result.timeline.events.filter((event) =>
    event.ruleId === VIOLATION_RULE.HIGH_SINK_RATE);
  assert(highSinkEvents.length === 2, `expected one high-sink episode pair, got ${highSinkEvents.length}`);

  const start = highSinkEvents.find((event) => event.type === 'violation_start');
  const end = highSinkEvents.find((event) => event.type === 'violation_end');
  assert(start.timestampMs === baseTs, 'confirmed high sink should retain the first threshold-breach timestamp');
  assert(start.context.value === -1010, `expected onset value -1010, got ${start.context.value}`);
  assert(start.context.peak_sink_rate_fpm === -1350,
    `expected peak -1350, got ${start.context.peak_sink_rate_fpm}`);
  assert(start.context.duration_ms === 5000, `expected final duration 5000, got ${start.context.duration_ms}`);
  assert(start.context.threshold_exceedance_duration_ms === 3000,
    `expected threshold exceedance duration 3000, got ${start.context.threshold_exceedance_duration_ms}`);
  assert(end.timestampMs === baseTs + 5000, 'V/S above -1000 but below -900 should not clear the episode');
  assert(end.context.clear_threshold_fpm === -900,
    `expected -900 clear threshold, got ${end.context.clear_threshold_fpm}`);
});

test('replay never derives speedbrake violations from spoiler telemetry', () => {
  const baseTs = 1700000720000;
  const rows = [
    makeApproachDeviationRow(baseTs, 0, { spoiler_pct: 76, spoiler_state: 'EXTENDED', loc_deviation_dots: 0 }),
    makeApproachDeviationRow(baseTs, 1, { spoiler_pct: 76, spoiler_state: 'EXTENDED', loc_deviation_dots: 0 }),
    makeApproachDeviationRow(baseTs, 2, { spoiler_pct: 0, spoiler_state: 'STOWED', loc_deviation_dots: 0 }),
  ];

  const result = generateTimelineFromRows('speedbrake-deployed.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);
  const speedbrakeEvents = result.timeline.events.filter((event) =>
    event.ruleId === VIOLATION_RULE.SPEEDBRAKE_DEPLOYED_IN_FLIGHT);
  assert(speedbrakeEvents.length === 0, `expected no speedbrake violations, got ${speedbrakeEvents.length}`);
});

test('recorded legacy speedbrake violation rows are suppressed', () => {
  const baseTs = 1700000725000;
  const rows = [
    makeApproachDeviationRow(baseTs, 0, { spoiler_pct: 0, spoiler_state: 'STOWED' }),
    makeApproachDeviationRow(baseTs, 1, {
      record_type: 'FLIGHT_VIOLATION_START',
      phase: 'FLIGHT_VIOLATION_START',
      rule_id: VIOLATION_RULE.SPEEDBRAKE_DEPLOYED_IN_FLIGHT,
      label: 'Speedbrake deployed in flight (> 25%)',
      severity: 'warning',
      spoiler_pct: 34,
      spoiler_state: 'EXTENDED',
    }),
    makeApproachDeviationRow(baseTs, 2, {
      record_type: 'FLIGHT_VIOLATION_END',
      phase: 'FLIGHT_VIOLATION_END',
      rule_id: VIOLATION_RULE.SPEEDBRAKE_DEPLOYED_IN_FLIGHT,
      label: 'Speedbrake deployed in flight (> 25%)',
      severity: 'warning',
      spoiler_pct: 0,
      spoiler_state: 'STOWED',
    }),
  ];

  const result = generateTimelineFromRows('legacy-speedbrake-events.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);
  const speedbrakeEvents = result.timeline.events.filter((event) =>
    event.ruleId === VIOLATION_RULE.SPEEDBRAKE_DEPLOYED_IN_FLIGHT);
  assert(speedbrakeEvents.length === 0, `expected legacy speedbrake rows to be hidden, got ${speedbrakeEvents.length}`);
});

test('speedbrake telemetry stays out of landing flight summaries', () => {
  const baseTs = 1700000730000;
  const rows = [
    makeApproachDeviationRow(baseTs, 0, {
      spoiler_pct: 76,
      spoiler_state: 'EXTENDED',
      loc_deviation_dots: 0,
      ra_ft: 900,
      vs_fpm: -700,
    }),
    makeApproachDeviationRow(baseTs, 1, {
      spoiler_pct: 76,
      spoiler_state: 'EXTENDED',
      loc_deviation_dots: 0,
      ra_ft: 500,
      vs_fpm: -650,
    }),
    makeApproachDeviationRow(baseTs, 2, {
      spoiler_pct: 76,
      spoiler_state: 'EXTENDED',
      loc_deviation_dots: 0,
      ra_ft: 5,
      on_ground: true,
      ias_kts: 130,
      vs_fpm: -450,
    }),
  ];

  const result = generateTimelineFromRows('speedbrake-summary.csv', rows);
  assert(result.success === true, `expected success, got ${result.error}`);
  const landing = result.timeline.events.find((event) => event.type === 'landing');
  assert(landing, 'expected landing event');
  const summaryViolation = landing.flightSummary?.violations?.find((violation) =>
    violation.rule_id === VIOLATION_RULE.SPEEDBRAKE_DEPLOYED_IN_FLIGHT);
  assert(!summaryViolation, 'speedbrake telemetry should not create a landing summary violation');
});

test('quickPeekCSV counts large variable-width SAMPLE rows exactly', () => {
  const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'quick-peek-'));
  const csvPath = path.join(tmpDir, 'quick-peek.csv');
  const headers = ['record_type', 'sample_index', 'lat_deg', 'lon_deg', 'aircraft', 'notes'];
  const rows = [];
  let sampleRows = 0;

  for (let i = 0; i < 2600; i++) {
    const recordType = i % 700 === 0 ? 'LANDING' : 'SAMPLE';
    if (recordType === 'SAMPLE') sampleRows++;
    const notes = `"${'x'.repeat((i % 37) + 5)}"`;
    rows.push([recordType, i, -33.9, 151.1, 'Count Test', notes].join(','));
  }

  fs.writeFileSync(csvPath, [headers.join(','), ...rows].join('\n'), 'utf8');

  try {
    const result = quickPeekCSV(csvPath);
    assert(result.rowCount === rows.length, `expected exact rowCount ${rows.length}, got ${result.rowCount}`);
    assert(result.sampleCount === sampleRows, `expected exact sampleCount ${sampleRows}, got ${result.sampleCount}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('quickPeekCSV excludes an unterminated final row from current recording metadata', () => {
  const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'quick-peek-torn-tail-'));
  const csvPath = path.join(tmpDir, 'quick-peek-torn-tail.csv');
  const startIso = '2026-07-20T00:00:00.000Z';
  const startMs = Date.parse(startIso);
  const headers = [
    'record_type',
    'sample_index',
    'schema_version',
    'recording_session_id',
    'flight_id',
    'flight_start_iso',
    'flight_elapsed_ms',
    'timestamp_monotonic',
    'ts',
    'timestamp_utc',
    'lat_deg',
    'lon_deg',
    'aircraft',
  ];
  const row = (recordType, index, elapsed, lat, lon) => [
    recordType,
    index,
    3,
    'quick-peek-session',
    'quick-peek-flight',
    startIso,
    elapsed,
    elapsed,
    startMs + elapsed,
    new Date(startMs + elapsed).toISOString(),
    lat,
    lon,
    recordType === 'RECORDING_MANIFEST' ? '' : 'Committed Aircraft',
  ].join(',');
  fs.writeFileSync(csvPath, [
    headers.join(','),
    row('RECORDING_MANIFEST', 0, 0, '', ''),
    row('SAMPLE', 1, 100, -33.9, 151.1),
    row('SAMPLE', 2, 200, -34.0, 151.2),
    row('SAMPLE', 3, 300, -35.0, 152.0),
  ].join('\n'), 'utf8');

  try {
    const result = quickPeekCSV(csvPath);
    assert(result.rowCount === 3, `expected manifest + 2 committed rows, got ${result.rowCount}`);
    assert(result.sampleCount === 2, `expected 2 committed samples, got ${result.sampleCount}`);
    assert(Number(result.lastRow.ts) === startMs + 200, 'last metadata row must be committed');
    assert(Number(result.lastCoordRow.lon_deg) === 151.2, 'last coordinate must exclude the torn tail');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('quickPeekCSV preserves UTF-8 metadata split across its read boundary', () => {
  const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'quick-peek-utf8-boundary-'));
  const csvPath = path.join(tmpDir, 'quick-peek-utf8-boundary.csv');
  const headers = ['record_type', 'sample_index', 'lat_deg', 'lon_deg', 'aircraft', 'notes'];
  const header = `${headers.join(',')}\n`;
  const rowPrefix = 'SAMPLE,0,-33.9,151.1,';
  const splitOffset = (64 * 1024) - 1;
  const paddingLength = splitOffset - Buffer.byteLength(header + rowPrefix, 'utf8');
  assert(paddingLength > 0, 'test fixture must reach the scanner read boundary');
  const aircraft = `${'A'.repeat(paddingLength)}é`;
  fs.writeFileSync(csvPath, `${header}${rowPrefix}${aircraft},boundary\n`, 'utf8');

  try {
    const result = quickPeekCSV(csvPath);
    assert(result.rowCount === 1, `expected one row, got ${result.rowCount}`);
    assert(result.firstRow?.aircraft === aircraft, 'split UTF-8 aircraft metadata must round-trip exactly');
    assert(!String(result.firstRow?.aircraft || '').includes('\uFFFD'), 'metadata must not contain replacement characters');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('quickPeekCSV quarantines a partial-width legacy EOF tail', () => {
  const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'quick-peek-legacy-partial-tail-'));
  const csvPath = path.join(tmpDir, 'quick-peek-legacy-partial-tail.csv');
  const headers = 'record_type,sample_index,lat_deg,lon_deg,aircraft,notes';
  const committed = 'SAMPLE,0,-33.9,151.1,Committed Aircraft,ok';
  fs.writeFileSync(csvPath, `${headers}\n${committed}\nSAMPLE,1,-34.0`, 'utf8');

  try {
    const result = quickPeekCSV(csvPath);
    assert(result.rowCount === 1, `expected one committed row, got ${result.rowCount}`);
    assert(result.sampleCount === 1, `expected one committed sample, got ${result.sampleCount}`);
    assert(result.lastRow?.aircraft === 'Committed Aircraft', 'partial legacy tail must not replace metadata');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('quickPeekCSV quarantines an unterminated quoted legacy EOF tail', () => {
  const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'quick-peek-legacy-quoted-tail-'));
  const csvPath = path.join(tmpDir, 'quick-peek-legacy-quoted-tail.csv');
  const headers = 'record_type,sample_index,lat_deg,lon_deg,aircraft,notes';
  const committed = 'SAMPLE,0,-33.9,151.1,Committed Aircraft,ok';
  fs.writeFileSync(csvPath, `${headers}\n${committed}\nSAMPLE,1,-34.0,151.2,"Unfinished aircraft,notes`, 'utf8');

  try {
    const result = quickPeekCSV(csvPath);
    assert(result.rowCount === 1, `expected one committed row, got ${result.rowCount}`);
    assert(result.sampleCount === 1, `expected one committed sample, got ${result.sampleCount}`);
    assert(result.lastRow?.aircraft === 'Committed Aircraft', 'unterminated legacy tail must not replace metadata');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('quickPeekCSV accepts a complete legacy EOF row without a delimiter', () => {
  const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'quick-peek-legacy-complete-tail-'));
  const csvPath = path.join(tmpDir, 'quick-peek-legacy-complete-tail.csv');
  const headers = 'record_type,sample_index,lat_deg,lon_deg,aircraft,notes';
  const first = 'SAMPLE,0,-33.9,151.1,First Aircraft,ok';
  const completeTail = 'SAMPLE,1,-34.0,151.2,"Legacy Éclair",complete';
  fs.writeFileSync(csvPath, `${headers}\n${first}\n${completeTail}`, 'utf8');

  try {
    const result = quickPeekCSV(csvPath);
    assert(result.rowCount === 2, `expected both legacy rows, got ${result.rowCount}`);
    assert(result.sampleCount === 2, `expected both legacy samples, got ${result.sampleCount}`);
    assert(result.lastRow?.aircraft === 'Legacy Éclair', 'complete legacy EOF metadata must be preserved');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function writeMinimalTimelineCsv(csvPath, flightId = '') {
  const baseTs = 1700000200000;
  const headers = [
    'flight_id',
    'timestamp_utc',
    'ts',
    'flight_elapsed_ms',
    'record_type',
    'phase',
    'lat_deg',
    'lon_deg',
    'ra_ft',
    'on_ground',
    'ias_kts',
    'vs_fpm',
    'gs_kts',
    'hdg_true_deg',
    'alt_msl_ft',
    'aircraft',
  ];
  const rows = [
    [flightId, new Date(baseTs).toISOString(), baseTs, 0, 'SAMPLE', 'APPROACH', 37.0, -122.0, 1000, 'false', 145, -600, 145, 360, 1700, 'A320'],
  ];
  fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');
}

function createCanonicalBundleFixture(rootDir, bundleName) {
  const bundleDir = path.join(rootDir, bundleName);
  fs.mkdirSync(bundleDir, { recursive: true });
  return {
    bundleDir,
    csvPath: path.join(bundleDir, 'telemetry.csv'),
    automationPath: path.join(bundleDir, 'automation.jsonl'),
    timelinePath: path.join(bundleDir, 'timeline.json'),
  };
}

async function runAsyncTests() {
  console.log('\ntimeline CSV path casing');

  await testAsync('generateFromCSV rejects a manifest-first CSV with no recording session identity', async () => {
    const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'manifest-session-downgrade-'));
    const csvPath = path.join(tmpDir, 'manifest-session-downgrade.csv');
    const startIso = '2026-07-20T00:00:00.000Z';
    const startMs = Date.parse(startIso);
    const headers = [
      'record_type',
      'schema_version',
      'sample_index',
      'flight_id',
      'flight_start_iso',
      'flight_elapsed_ms',
      'timestamp_monotonic',
      'ts',
      'timestamp_utc',
    ];
    const manifest = [
      'RECORDING_MANIFEST',
      3,
      0,
      'manifest-session-downgrade',
      startIso,
      0,
      0,
      startMs,
      startIso,
    ];
    fs.writeFileSync(csvPath, `${headers.join(',')}\n${manifest.join(',')}\n`, 'utf8');

    try {
      const result = await require(timelineGeneratorPath).generateFromCSV(csvPath);
      assert(result.success === false, 'manifest-first CSV without a session must fail closed');
      assert(/recording_session_id/.test(result.error || ''), `unexpected downgrade error: ${result.error}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('generateAndSave writes the canonical timeline beside telemetry', async () => {
    const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'uppercase-save-'));
    const fixture = createCanonicalBundleFixture(tmpDir, 'uppercase-flight');
    const csvPath = fixture.csvPath;
    writeMinimalTimelineCsv(csvPath);

    try {
      const timelineGenerator = require(timelineGeneratorPath);
      const result = await timelineGenerator.generateAndSave(csvPath);
      assert(result.success === true, `expected success, got ${result.error}`);
      assert(path.basename(result.filePath) === 'timeline.json', `unexpected timeline path ${result.filePath}`);
      assert(fs.existsSync(fixture.timelinePath), 'expected canonical timeline sidecar');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('generateMissing scans canonical recording bundles', async () => {
    const logsRoot = path.join(tempHome, 'Documents', 'Flight Fabric');
    const logsDir = path.join(logsRoot, 'Flight Logs');
    fs.rmSync(logsRoot, { recursive: true, force: true });
    fs.mkdirSync(logsDir, { recursive: true });
    const fixture = createCanonicalBundleFixture(logsDir, 'missing-case');
    writeMinimalTimelineCsv(fixture.csvPath);

    const timelineGenerator = require(timelineGeneratorPath);
    const result = await timelineGenerator.generateMissing();
    assert(result.generated === 1, `expected one generated timeline, got ${JSON.stringify(result)}`);
    assert(fs.existsSync(fixture.timelinePath), 'expected canonical timeline sidecar');

    const current = await timelineGenerator.generateMissing();
    assert(current.generated === 0 && current.skipped === 1, `expected current timeline to be reused, got ${JSON.stringify(current)}`);

    const staleTimeline = JSON.parse(fs.readFileSync(fixture.timelinePath, 'utf8'));
    staleTimeline.analysisRescore.contract = {
      ...staleTimeline.analysisRescore.contract,
      version: CURRENT_ANALYSIS_RESCORE_CONTRACT.version - 1,
    };
    fs.writeFileSync(fixture.timelinePath, `${JSON.stringify(staleTimeline)}\n`, 'utf8');

    const regenerated = await timelineGenerator.generateMissing();
    assert(regenerated.generated === 1 && regenerated.skipped === 0, `expected stale timeline regeneration, got ${JSON.stringify(regenerated)}`);
    const refreshedTimeline = JSON.parse(fs.readFileSync(fixture.timelinePath, 'utf8'));
    assert(
      JSON.stringify(refreshedTimeline.analysisRescore?.contract) === JSON.stringify(CURRENT_ANALYSIS_RESCORE_CONTRACT),
      'regenerated timeline must carry the current landing-analysis contract',
    );
  });

  console.log('\ngenerateFromCSV: touchdown scoring');

  await testAsync('recorded FLIGHT_VIOLATION rows appear in reconstructed logbook timeline', async () => {
    const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'recorded-violations-'));
    const csvPath = path.join(tmpDir, 'recorded-violations.csv');
    const baseTs = 1700000300000;
    const headers = [
      'flight_id',
      'flight_start_iso',
      'timestamp_utc',
      'ts',
      'timestamp_ms',
      'flight_elapsed_ms',
      'record_type',
      'phase',
      'lat_deg',
      'lon_deg',
      'ra_ft',
      'on_ground',
      'ias_kts',
      'vs_fpm',
      'gs_kts',
      'hdg_true_deg',
      'alt_msl_ft',
      'aircraft',
      'rule_id',
      'label',
      'severity',
      'pitch_deg',
      'bank_deg',
      'gforce',
      'duration_ms',
    ];
    const rows = [
      ['violation-replay', new Date(baseTs).toISOString(), new Date(baseTs).toISOString(), baseTs, '', 0, 'SAMPLE', 'CRUISE', 40.0000, -70.0000, 5000, 'false', 250, 0, 450, 90, 12000, 'TriStar', '', '', '', '', '', '', ''],
      ['violation-replay', '', '', '', baseTs + 1000, '', 'FLIGHT_VIOLATION_START', 'FLIGHT_VIOLATION_START', 40.0100, -70.0100, 5000, 'false', 250, 0, 450, 90, 12000, 'TriStar', VIOLATION_RULE.UPSET_BANK, 'Bank upset (> 45 deg)', 'critical', 1.5, 60, 1.1, ''],
      ['violation-replay', '', '', '', baseTs + 2600, '', 'FLIGHT_VIOLATION_END', 'FLIGHT_VIOLATION_END', 40.0200, -70.0200, 5000, 'false', 250, 0, 450, 90, 12000, 'TriStar', VIOLATION_RULE.UPSET_BANK, 'Bank upset (> 45 deg)', 'critical', 1.0, 40, 1.0, 1600],
    ];
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');

    try {
      const timelineGenerator = require(timelineGeneratorPath);
      const result = await timelineGenerator.generateFromCSV(csvPath);
      assert(result.success === true, `expected success, got ${result.error}`);

      const start = result.timeline.events.find((event) =>
        event.type === 'violation_start' && event.ruleId === VIOLATION_RULE.UPSET_BANK);
      const end = result.timeline.events.find((event) =>
        event.type === 'violation_end' && event.ruleId === VIOLATION_RULE.UPSET_BANK);

      assert(start, 'expected upset_bank violation_start in timeline');
      assert(end, 'expected upset_bank violation_end in timeline');
      assert(start.timestampMs === baseTs + 1000, `expected start timestamp_ms, got ${start.timestampMs}`);
      assert(start.elapsedMs === 1000, `expected start elapsed from timestamp_ms fallback, got ${start.elapsedMs}`);
      assert(start.label === 'Bank upset (> 45 deg)', `expected label, got ${start.label}`);
      assert(start.severity === 'critical', `expected critical severity, got ${start.severity}`);
      assert(start.context.bank_deg === 60, `expected start bank_deg 60, got ${start.context.bank_deg}`);
      assert(start.context.pitch_deg === 1.5, `expected start pitch_deg 1.5, got ${start.context.pitch_deg}`);
      assert(start.context.gforce === 1.1, `expected start gforce 1.1, got ${start.context.gforce}`);
      assert(end.context.duration_ms === 1600, `expected duration 1600, got ${end.context.duration_ms}`);
      assert(end.context.bank_deg === 40, `expected end bank_deg 40, got ${end.context.bank_deg}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('automation sidecar events appear in reconstructed logbook timeline', async () => {
    const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'automation-sidecar-'));
    const fixture = createCanonicalBundleFixture(tmpDir, 'automation-sidecar');
    const csvPath = fixture.csvPath;
    const sidecarPath = fixture.automationPath;
    const baseTs = 1700000400000;
    const headers = [
      'flight_id',
      'flight_start_iso',
      'timestamp_utc',
      'ts',
      'flight_elapsed_ms',
      'record_type',
      'phase',
      'lat_deg',
      'lon_deg',
      'ra_ft',
      'on_ground',
      'ias_kts',
      'vs_fpm',
      'gs_kts',
      'hdg_true_deg',
      'alt_msl_ft',
      'aircraft',
    ];
    const rows = [
      ['automation-test', new Date(baseTs).toISOString(), new Date(baseTs).toISOString(), baseTs, 0, 'SAMPLE', 'APPROACH', 37.0000, -122.0000, 700, 'false', 145, -700, 145, 360, 1400, 'A320'],
      ['automation-test', new Date(baseTs).toISOString(), new Date(baseTs + 1000).toISOString(), baseTs + 1000, 1000, 'SAMPLE', 'APPROACH', 37.0010, -122.0000, 420, 'false', 145, -650, 145, 360, 1120, 'A320'],
      ['automation-test', new Date(baseTs).toISOString(), new Date(baseTs + 2000).toISOString(), baseTs + 2000, 2000, 'SAMPLE', 'APPROACH', 37.0020, -122.0000, 200, 'false', 142, -600, 142, 360, 900, 'A320'],
    ];
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');
    fs.writeFileSync(sidecarPath, [
      JSON.stringify({
        schemaVersion: 1,
        seq: 1,
        type: 'automation_event',
        timeMs: baseTs + 500,
        timestampIso: new Date(baseTs + 500).toISOString(),
        flightElapsedMs: 500,
        flightId: 'automation-test',
        flightStartIso: new Date(baseTs).toISOString(),
        eventType: 'selected_altitude_changed',
        field: 'selectedAltitudeFt',
        previous: 29000,
        current: 29300,
        confidence: 'simconnect',
        source: 'simconnect',
        dataSource: 'msfs',
      }),
      JSON.stringify({
        schemaVersion: 1,
        seq: 2,
        type: 'automation_event',
        timeMs: baseTs + 750,
        timestampIso: new Date(baseTs + 750).toISOString(),
        flightElapsedMs: 750,
        flightId: 'automation-test',
        flightStartIso: new Date(baseTs).toISOString(),
        eventType: 'lateral_mode_changed',
        field: 'lateralMode',
        previous: 'LNAV',
        current: null,
        confidence: 'profile-confirmed',
        source: 'lvar',
        dataSource: 'msfs',
      }),
      JSON.stringify({
        schemaVersion: 1,
        seq: 3,
        type: 'automation_event',
        timeMs: baseTs + 1000,
        timestampIso: new Date(baseTs + 1000).toISOString(),
        flightElapsedMs: 1000,
        flightId: 'automation-test',
        flightStartIso: new Date(baseTs).toISOString(),
        eventType: 'ap_disengaged',
        field: 'apMaster',
        previous: true,
        current: false,
        confidence: 'simconnect',
        source: 'simconnect',
        dataSource: 'msfs',
      }),
    ].join('\n') + '\n', 'utf8');

    try {
      const timelineGenerator = require(timelineGeneratorPath);
      const result = await timelineGenerator.generateFromCSV(csvPath);
      assert(result.success === true, `expected success, got ${result.error}`);

      const event = result.timeline.events.find((item) => item.type === 'automation_event');
      assert(event, 'expected automation event');
      assert(event.label === 'AP disconnected', `unexpected automation label ${event.label}`);
      assert(event.summary.includes('RA 420 ft'), `expected RA summary, got ${event.summary}`);
      assert(!event.summary.includes('phase APPROACH'), `phase should stay out of automation summary, got ${event.summary}`);
      assert(event.context.ra_ft === 420, `expected nearest RA 420, got ${event.context.ra_ft}`);
      assert(event.context.phase === 'APPROACH', `expected structured phase context, got ${event.context.phase}`);
      assert(event.confidence === 'simconnect', `expected simconnect confidence, got ${event.confidence}`);
      assert(event.lat === 37.001, `expected nearest latitude, got ${event.lat}`);
      assert(result.timeline.automationSummary.eventCount === 1, 'expected automation summary event count');
      assert(!result.timeline.events.some((item) => item.eventType === 'selected_altitude_changed'), 'selector dial changes should stay out of timeline events');
      assert(!result.timeline.events.some((item) => item.eventType === 'lateral_mode_changed'), 'unknown mode drops should stay out of timeline events');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('automation replay shows A/T ARM changes and hides active-state transitions', async () => {
    const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'automation-athr-arm-'));
    const fixture = createCanonicalBundleFixture(tmpDir, 'automation-athr-arm');
    const csvPath = fixture.csvPath;
    const sidecarPath = fixture.automationPath;
    const baseTs = 1700000460000;
    const headers = [
      'flight_id',
      'flight_start_iso',
      'timestamp_utc',
      'ts',
      'flight_elapsed_ms',
      'record_type',
      'phase',
      'lat_deg',
      'lon_deg',
      'ra_ft',
      'on_ground',
      'ias_kts',
      'vs_fpm',
      'gs_kts',
      'hdg_true_deg',
      'alt_msl_ft',
      'aircraft',
    ];
    const rows = [
      ['automation-athr-arm', new Date(baseTs).toISOString(), new Date(baseTs).toISOString(), baseTs, 0, 'SAMPLE', 'CRUISE', 37.0000, -122.0000, 30000, 'false', 280, 0, 440, 360, 33000, 'Generic Test'],
      ['automation-athr-arm', new Date(baseTs).toISOString(), new Date(baseTs + 1000).toISOString(), baseTs + 1000, 1000, 'SAMPLE', 'DESCENT', 37.0100, -122.0000, 29000, 'false', 280, -1500, 440, 360, 32000, 'Generic Test'],
      ['automation-athr-arm', new Date(baseTs).toISOString(), new Date(baseTs + 2000).toISOString(), baseTs + 2000, 2000, 'SAMPLE', 'DESCENT', 37.0200, -122.0000, 28000, 'false', 275, -1500, 435, 360, 31000, 'Generic Test'],
      ['automation-athr-arm', new Date(baseTs).toISOString(), new Date(baseTs + 3000).toISOString(), baseTs + 3000, 3000, 'SAMPLE', 'DESCENT', 37.0300, -122.0000, 27000, 'false', 270, -1500, 430, 360, 30000, 'Generic Test'],
    ];
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');
    fs.writeFileSync(sidecarPath, [
      JSON.stringify({
        schemaVersion: 1,
        seq: 1,
        type: 'automation_checkpoint',
        reason: 'first_snapshot',
        timeMs: baseTs,
        timestampIso: new Date(baseTs).toISOString(),
        flightElapsedMs: 0,
        flightId: 'automation-athr-arm',
        flightStartIso: new Date(baseTs).toISOString(),
        aircraftProfileId: 'generic',
        source: 'simconnect',
        dataSource: 'msfs',
        athrReliable: true,
        reliabilityReason: 'simconnect-only',
        state: {
          athrArmed: false,
          athrActive: true,
        },
      }),
      JSON.stringify({
        schemaVersion: 1,
        seq: 2,
        type: 'automation_delta',
        timeMs: baseTs + 1000,
        timestampIso: new Date(baseTs + 1000).toISOString(),
        flightElapsedMs: 1000,
        flightId: 'automation-athr-arm',
        flightStartIso: new Date(baseTs).toISOString(),
        aircraftProfileId: 'generic',
        source: 'simconnect',
        dataSource: 'msfs',
        athrReliable: true,
        reliabilityReason: 'simconnect-only',
        rawChanged: {
          simconnect: {
            athrActive: false,
          },
        },
        stateChanged: {
          athrActive: false,
        },
      }),
      JSON.stringify({
        schemaVersion: 1,
        seq: 3,
        type: 'automation_event',
        timeMs: baseTs + 1000,
        timestampIso: new Date(baseTs + 1000).toISOString(),
        flightElapsedMs: 1000,
        flightId: 'automation-athr-arm',
        flightStartIso: new Date(baseTs).toISOString(),
        aircraftProfileId: 'generic',
        eventType: 'athr_disengaged',
        field: 'athrActive',
        previous: true,
        current: false,
        confidence: 'simconnect',
        source: 'simconnect',
        dataSource: 'msfs',
      }),
      JSON.stringify({
        schemaVersion: 1,
        seq: 4,
        type: 'automation_delta',
        timeMs: baseTs + 2000,
        timestampIso: new Date(baseTs + 2000).toISOString(),
        flightElapsedMs: 2000,
        flightId: 'automation-athr-arm',
        flightStartIso: new Date(baseTs).toISOString(),
        aircraftProfileId: 'generic',
        source: 'simconnect',
        dataSource: 'msfs',
        athrReliable: true,
        reliabilityReason: 'simconnect-only',
        stateChanged: {
          athrArmed: true,
        },
      }),
      JSON.stringify({
        schemaVersion: 1,
        seq: 5,
        type: 'automation_delta',
        timeMs: baseTs + 3000,
        timestampIso: new Date(baseTs + 3000).toISOString(),
        flightElapsedMs: 3000,
        flightId: 'automation-athr-arm',
        flightStartIso: new Date(baseTs).toISOString(),
        aircraftProfileId: 'generic',
        source: 'simconnect',
        dataSource: 'msfs',
        athrReliable: true,
        reliabilityReason: 'simconnect-only',
        stateChanged: {
          athrArmed: false,
        },
      }),
    ].join('\n') + '\n', 'utf8');

    try {
      const timelineGenerator = require(timelineGeneratorPath);
      const result = await timelineGenerator.generateFromCSV(csvPath);
      assert(result.success === true, `expected success, got ${result.error}`);

      const automationEvents = result.timeline.events.filter((item) => item.type === 'automation_event');
      assert(automationEvents.length === 2, `expected 2 A/T ARM events, got ${automationEvents.length}`);
      assert(
        automationEvents.some((item) => (
          item.eventType === 'athr_armed'
          && item.field === 'athrArmed'
          && item.label === 'A/T armed'
          && item.previous === false
          && item.current === true
        )),
        'A/T ARM on should be reconstructed from existing delta rows',
      );
      assert(
        automationEvents.some((item) => (
          item.eventType === 'athr_disarmed'
          && item.field === 'athrArmed'
          && item.label === 'A/T disarmed'
          && item.previous === true
          && item.current === false
        )),
        'A/T ARM off should be reconstructed from existing delta rows',
      );
      assert(
        !automationEvents.some((item) => item.field === 'athrActive'),
        'active/servo transitions must stay out of the user-facing timeline',
      );
      assert(result.timeline.automationSummary.eventCount === 2, 'automation summary should count only visible ARM events');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('automation replay uses SAMPLE rows for nearest telemetry context', async () => {
    const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'automation-sample-context-'));
    const fixture = createCanonicalBundleFixture(tmpDir, 'automation-sample-context');
    const csvPath = fixture.csvPath;
    const sidecarPath = fixture.automationPath;
    const baseTs = 1700000440000;
    const headers = [
      'flight_id',
      'flight_start_iso',
      'timestamp_utc',
      'ts',
      'flight_elapsed_ms',
      'record_type',
      'phase',
      'lat_deg',
      'lon_deg',
      'ra_ft',
      'on_ground',
      'ias_kts',
      'vs_fpm',
      'gs_kts',
      'hdg_true_deg',
      'alt_msl_ft',
      'aircraft',
    ];
    const rows = [
      ['automation-sample-context', new Date(baseTs).toISOString(), new Date(baseTs).toISOString(), baseTs, 0, 'SAMPLE', 'APPROACH', 37.0000, -122.0000, 900, 'false', 145, -700, 145, 360, 1600, 'A320'],
      ['automation-sample-context', new Date(baseTs).toISOString(), new Date(baseTs + 750).toISOString(), baseTs + 750, 750, 'GO_AROUND', 'GO_AROUND', 37.0050, -122.0050, 100, 'false', 145, 1200, 145, 360, 1100, 'A320'],
      ['automation-sample-context', new Date(baseTs).toISOString(), new Date(baseTs + 1000).toISOString(), baseTs + 1000, 1000, 'SAMPLE', 'APPROACH', 37.0100, -122.0000, 800, 'false', 145, -650, 145, 360, 1500, 'A320'],
    ];
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');
    fs.writeFileSync(sidecarPath, [
      JSON.stringify({
        schemaVersion: 1,
        seq: 1,
        type: 'automation_event',
        timeMs: baseTs + 750,
        timestampIso: new Date(baseTs + 750).toISOString(),
        flightElapsedMs: 750,
        flightId: 'automation-sample-context',
        flightStartIso: new Date(baseTs).toISOString(),
        eventType: 'ap_disengaged',
        field: 'apMaster',
        previous: true,
        current: false,
        confidence: 'simconnect',
        source: 'simconnect',
        dataSource: 'msfs',
      }),
    ].join('\n') + '\n', 'utf8');

    try {
      const timelineGenerator = require(timelineGeneratorPath);
      const result = await timelineGenerator.generateFromCSV(csvPath);
      assert(result.success === true, `expected success, got ${result.error}`);

      const event = result.timeline.events.find((item) => item.type === 'automation_event');
      assert(event, 'expected automation event');
      assert(event.context.ra_ft === 800, `expected nearest SAMPLE RA 800, got ${event.context.ra_ft}`);
      assert(event.context.phase === 'APPROACH', `expected nearest SAMPLE phase APPROACH, got ${event.context.phase}`);
      assert(event.lat === 37.01, `expected nearest SAMPLE latitude, got ${event.lat}`);
      assert(event.summary.includes('RA 800 ft'), `expected SAMPLE RA summary, got ${event.summary}`);
      assert(!event.summary.includes('GO_AROUND'), `event-row phase should stay out of summary, got ${event.summary}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('automation replay keeps profile AP disconnects corroborated by SimConnect raw state', async () => {
    const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'automation-corroborated-'));
    const fixture = createCanonicalBundleFixture(tmpDir, 'automation-corroborated');
    const csvPath = fixture.csvPath;
    const sidecarPath = fixture.automationPath;
    const baseTs = 1700000180000;
    const headers = [
      'flight_id',
      'flight_start_iso',
      'timestamp_utc',
      'ts',
      'timestamp_ms',
      'flight_elapsed_ms',
      'record_type',
      'phase',
      'lat_deg',
      'lon_deg',
      'ra_ft',
      'on_ground',
      'ias_kts',
      'vs_fpm',
      'gs_kts',
      'hdg_true_deg',
      'alt_msl_ft',
      'aircraft',
    ];
    const rows = [
      ['automation-corroborated', new Date(baseTs).toISOString(), new Date(baseTs).toISOString(), baseTs, baseTs, 0, 'SAMPLE', 'CLIMB', 37.0000, -122.0000, 8000, 'false', 250, 1500, 260, 360, 10000, 'A320'],
      ['automation-corroborated', new Date(baseTs).toISOString(), new Date(baseTs + 1000).toISOString(), baseTs + 1000, baseTs + 1000, 1000, 'SAMPLE', 'CLIMB', 37.0100, -122.0000, 8500, 'false', 260, 1200, 270, 360, 11000, 'A320'],
    ];
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');
    fs.writeFileSync(sidecarPath, [
      JSON.stringify({
        schemaVersion: 1,
        seq: 1,
        type: 'automation_event',
        timeMs: baseTs,
        timestampIso: new Date(baseTs).toISOString(),
        flightElapsedMs: 0,
        flightId: 'automation-corroborated',
        flightStartIso: new Date(baseTs).toISOString(),
        eventType: 'ap_engaged',
        field: 'apMaster',
        previous: false,
        current: true,
        confidence: 'profile-confirmed',
        source: 'lvar',
        dataSource: 'msfs',
      }),
      JSON.stringify({
        schemaVersion: 1,
        seq: 2,
        type: 'automation_delta',
        timeMs: baseTs + 1000,
        timestampIso: new Date(baseTs + 1000).toISOString(),
        flightElapsedMs: 1000,
        flightId: 'automation-corroborated',
        flightStartIso: new Date(baseTs).toISOString(),
        rawChanged: {
          simconnect: {
            apMaster: false,
          },
        },
        stateChanged: {
          apMaster: false,
        },
        confidenceChanged: {},
      }),
      JSON.stringify({
        schemaVersion: 1,
        seq: 3,
        type: 'automation_event',
        timeMs: baseTs + 1000,
        timestampIso: new Date(baseTs + 1000).toISOString(),
        flightElapsedMs: 1000,
        flightId: 'automation-corroborated',
        flightStartIso: new Date(baseTs).toISOString(),
        eventType: 'ap_disengaged',
        field: 'apMaster',
        previous: true,
        current: false,
        confidence: 'profile-confirmed',
        source: 'lvar',
        dataSource: 'msfs',
      }),
    ].join('\n') + '\n', 'utf8');

    try {
      const timelineGenerator = require(timelineGeneratorPath);
      const result = await timelineGenerator.generateFromCSV(csvPath);
      assert(result.success === true, `expected success, got ${result.error}`);

      const automationEvents = result.timeline.events.filter((item) => item.type === 'automation_event');
      assert(automationEvents.length === 2, `expected 2 automation events, got ${automationEvents.length}`);
      assert(automationEvents.some((item) => item.eventType === 'ap_engaged'), 'profile AP engagement should remain visible');
      assert(automationEvents.some((item) => item.eventType === 'ap_disengaged'), 'corroborated profile AP disconnect should remain visible');
      assert(result.timeline.automationSummary.eventCount === 2, 'automation summary should count corroborated profile events');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('automation replay expands compact v2 context and explicit SimConnect evidence', async () => {
    const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'automation-compact-v2-'));
    const fixture = createCanonicalBundleFixture(tmpDir, 'automation-compact-v2');
    const csvPath = fixture.csvPath;
    const sidecarPath = fixture.automationPath;
    const baseTs = 1700000210000;
    const startIso = new Date(baseTs).toISOString();
    const headers = [
      'flight_id',
      'flight_start_iso',
      'timestamp_utc',
      'ts',
      'flight_elapsed_ms',
      'record_type',
      'phase',
      'lat_deg',
      'lon_deg',
      'ra_ft',
      'on_ground',
      'ias_kts',
      'vs_fpm',
      'gs_kts',
      'hdg_true_deg',
      'alt_msl_ft',
      'aircraft',
    ];
    const rows = [
      ['automation-compact-v2', startIso, startIso, baseTs, 0, 'SAMPLE', 'CLIMB', 37, -122, 8000, 'false', 250, 1500, 260, 360, 10000, 'A320'],
      ['automation-compact-v2', startIso, new Date(baseTs + 1000).toISOString(), baseTs + 1000, 1000, 'SAMPLE', 'CLIMB', 37.01, -122, 8500, 'false', 260, 1200, 270, 360, 11000, 'A320'],
    ];
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');
    fs.writeFileSync(sidecarPath, [
      JSON.stringify({
        schemaVersion: 2,
        seq: 1,
        type: 'automation_checkpoint',
        reason: 'first_snapshot',
        timeMs: baseTs,
        timestampIso: startIso,
        flightId: 'automation-compact-v2',
        flightStartIso: startIso,
        context: {
          aircraftProfileId: 'pmdg-737',
          source: 'sdk',
          dataSource: 'rust-simvars',
          apReliable: true,
          athrReliable: true,
          reliabilityReason: 'sdk-connected',
        },
        state: {
          apMaster: true,
          athrArmed: false,
        },
      }),
      JSON.stringify({
        seq: 2,
        type: 'automation_delta',
        timeMs: baseTs + 500,
        stateChanged: { athrArmed: true },
      }),
      JSON.stringify({
        seq: 3,
        type: 'automation_event',
        timeMs: baseTs + 500,
        eventType: 'athr_armed',
        field: 'athrArmed',
        previous: false,
        current: true,
        confidence: 'profile-confirmed',
      }),
      JSON.stringify({
        seq: 4,
        type: 'automation_delta',
        timeMs: baseTs + 1000,
        stateChanged: { apMaster: false },
      }),
      JSON.stringify({
        seq: 5,
        type: 'automation_event',
        timeMs: baseTs + 1000,
        eventType: 'ap_disengaged',
        field: 'apMaster',
        previous: true,
        current: false,
        confidence: 'profile-confirmed',
        simconnectCorroborated: true,
      }),
      JSON.stringify({
        seq: 6,
        type: 'automation_delta',
        timeMs: baseTs + 1500,
        stateChanged: { apMaster: true },
      }),
      JSON.stringify({
        seq: 7,
        type: 'automation_event',
        timeMs: baseTs + 1500,
        eventType: 'ap_engaged',
        field: 'apMaster',
        previous: false,
        current: true,
        confidence: 'profile-confirmed',
      }),
      JSON.stringify({
        seq: 8,
        type: 'automation_delta',
        timeMs: baseTs + 2000,
        stateChanged: { apMaster: false },
      }),
      JSON.stringify({
        seq: 9,
        type: 'automation_event',
        timeMs: baseTs + 2000,
        eventType: 'ap_disengaged',
        field: 'apMaster',
        previous: true,
        current: false,
        confidence: 'profile-confirmed',
        simconnectCorroborated: false,
      }),
    ].join('\n') + '\n', 'utf8');

    try {
      const timelineGenerator = require(timelineGeneratorPath);
      const result = await timelineGenerator.generateFromCSV(csvPath);
      assert(result.success === true, `expected compact v2 success, got ${result.error}`);

      const automationEvents = result.timeline.events.filter((item) => item.type === 'automation_event');
      const armed = automationEvents.find((item) => item.eventType === 'athr_armed');
      const disconnected = automationEvents.find((item) => item.eventType === 'ap_disengaged');
      assert(armed, 'compact A/T ARM event should remain visible');
      assert(disconnected, 'explicitly corroborated compact AP disconnect should remain visible');
      assert(automationEvents.filter((item) => item.eventType === 'ap_disengaged').length === 1,
        'explicitly uncorroborated compact AP disconnect should stay hidden');
      assert(disconnected.source === 'sdk', `expected inherited SDK context, got ${disconnected.source}`);
      assert(disconnected.dataSource === 'rust-simvars',
        `expected inherited data source, got ${disconnected.dataSource}`);
      assert(disconnected.context.aircraft_profile_id === 'pmdg-737',
        `expected inherited aircraft profile, got ${disconnected.context.aircraft_profile_id}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('automation replay suppresses uncorroborated profile AP and mode-source chatter', async () => {
    const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'automation-chatter-'));
    const fixture = createCanonicalBundleFixture(tmpDir, 'automation-chatter');
    const csvPath = fixture.csvPath;
    const sidecarPath = fixture.automationPath;
    const baseTs = 1700000240000;
    const headers = [
      'flight_id',
      'flight_start_iso',
      'timestamp_utc',
      'ts',
      'timestamp_ms',
      'flight_elapsed_ms',
      'record_type',
      'phase',
      'lat_deg',
      'lon_deg',
      'ra_ft',
      'on_ground',
      'ias_kts',
      'vs_fpm',
      'gs_kts',
      'hdg_true_deg',
      'alt_msl_ft',
      'aircraft',
    ];
    const rows = [
      ['automation-chatter', new Date(baseTs).toISOString(), new Date(baseTs).toISOString(), baseTs, baseTs, 0, 'SAMPLE', 'CLIMB', 37.0000, -122.0000, 22000, 'false', 280, 1200, 320, 360, 25000, 'A320'],
      ['automation-chatter', new Date(baseTs).toISOString(), new Date(baseTs + 1000).toISOString(), baseTs + 1000, baseTs + 1000, 1000, 'SAMPLE', 'CLIMB', 37.0100, -122.0000, 26326, 'false', 290, 1000, 330, 360, 29300, 'A320'],
      ['automation-chatter', new Date(baseTs).toISOString(), new Date(baseTs + 2000).toISOString(), baseTs + 2000, baseTs + 2000, 2000, 'SAMPLE', 'CRUISE', 37.0200, -122.0000, 30000, 'false', 300, 0, 440, 360, 33000, 'A320'],
      ['automation-chatter', new Date(baseTs).toISOString(), new Date(baseTs + 3000).toISOString(), baseTs + 3000, baseTs + 3000, 3000, 'SAMPLE', 'CRUISE', 37.0300, -122.0000, 30000, 'false', 300, 0, 440, 360, 33000, 'A320'],
    ];
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');
    fs.writeFileSync(sidecarPath, [
      JSON.stringify({
        schemaVersion: 1,
        seq: 1,
        type: 'automation_event',
        timeMs: baseTs,
        timestampIso: new Date(baseTs).toISOString(),
        flightElapsedMs: 0,
        flightId: 'automation-chatter',
        flightStartIso: new Date(baseTs).toISOString(),
        eventType: 'ap_engaged',
        field: 'apMaster',
        previous: false,
        current: true,
        confidence: 'profile-confirmed',
        source: 'lvar',
        dataSource: 'msfs',
      }),
      JSON.stringify({
        schemaVersion: 1,
        seq: 2,
        type: 'automation_event',
        timeMs: baseTs + 500,
        timestampIso: new Date(baseTs + 500).toISOString(),
        flightElapsedMs: 500,
        flightId: 'automation-chatter',
        flightStartIso: new Date(baseTs).toISOString(),
        eventType: 'lateral_mode_changed',
        field: 'lateralMode',
        previous: 'HDG',
        current: 'LNAV',
        confidence: 'profile-confirmed',
        source: 'lvar',
        dataSource: 'msfs',
      }),
      JSON.stringify({
        schemaVersion: 1,
        seq: 3,
        type: 'automation_event',
        timeMs: baseTs + 600,
        timestampIso: new Date(baseTs + 600).toISOString(),
        flightElapsedMs: 600,
        flightId: 'automation-chatter',
        flightStartIso: new Date(baseTs).toISOString(),
        eventType: 'vertical_mode_changed',
        field: 'verticalMode',
        previous: null,
        current: 'VNAV',
        confidence: 'profile-confirmed',
        source: 'lvar',
        dataSource: 'msfs',
      }),
      JSON.stringify({
        schemaVersion: 1,
        seq: 4,
        type: 'automation_event',
        timeMs: baseTs + 700,
        timestampIso: new Date(baseTs + 700).toISOString(),
        flightElapsedMs: 700,
        flightId: 'automation-chatter',
        flightStartIso: new Date(baseTs).toISOString(),
        eventType: 'vertical_mode_changed',
        field: 'verticalMode',
        previous: 'VNAV',
        current: null,
        confidence: 'profile-confirmed',
        source: 'lvar',
        dataSource: 'msfs',
      }),
      JSON.stringify({
        schemaVersion: 1,
        seq: 5,
        type: 'automation_event',
        timeMs: baseTs + 1000,
        timestampIso: new Date(baseTs + 1000).toISOString(),
        flightElapsedMs: 1000,
        flightId: 'automation-chatter',
        flightStartIso: new Date(baseTs).toISOString(),
        eventType: 'ap_disengaged',
        field: 'apMaster',
        previous: true,
        current: false,
        confidence: 'profile-confirmed',
        source: 'lvar',
        dataSource: 'msfs',
      }),
      JSON.stringify({
        schemaVersion: 1,
        seq: 6,
        type: 'automation_event',
        timeMs: baseTs + 2000,
        timestampIso: new Date(baseTs + 2000).toISOString(),
        flightElapsedMs: 2000,
        flightId: 'automation-chatter',
        flightStartIso: new Date(baseTs).toISOString(),
        eventType: 'ap_engaged',
        field: 'apMaster',
        previous: false,
        current: true,
        confidence: 'profile-confirmed',
        source: 'lvar',
        dataSource: 'msfs',
      }),
      JSON.stringify({
        schemaVersion: 1,
        seq: 7,
        type: 'automation_event',
        timeMs: baseTs + 2500,
        timestampIso: new Date(baseTs + 2500).toISOString(),
        flightElapsedMs: 2500,
        flightId: 'automation-chatter',
        flightStartIso: new Date(baseTs).toISOString(),
        eventType: 'lateral_mode_changed',
        field: 'lateralMode',
        previous: 'HDG',
        current: 'LNAV',
        confidence: 'profile-confirmed',
        source: 'lvar',
        dataSource: 'msfs',
      }),
    ].join('\n') + '\n', 'utf8');

    try {
      const timelineGenerator = require(timelineGeneratorPath);
      const result = await timelineGenerator.generateFromCSV(csvPath);
      assert(result.success === true, `expected success, got ${result.error}`);

      const automationEvents = result.timeline.events.filter((item) => item.type === 'automation_event');
      assert(automationEvents.length === 3, `expected 3 automation events after chatter filtering, got ${automationEvents.length}`);
      assert(automationEvents.some((item) => item.eventType === 'ap_engaged'), 'first AP engagement should remain visible');
      assert(automationEvents.some((item) => item.eventType === 'lateral_mode_changed' && item.current === 'LNAV'), 'first LNAV selection should remain visible');
      assert(automationEvents.some((item) => item.eventType === 'vertical_mode_changed' && item.current === 'VNAV'), 'first VNAV selection should remain visible');
      assert(!automationEvents.some((item) => item.eventType === 'vertical_mode_changed' && item.current === null), 'VNAV source drops should stay hidden');
      assert(!automationEvents.some((item) => item.eventType === 'ap_disengaged'), 'high-altitude AP disconnect chatter should be hidden');
      assert(result.timeline.automationSummary.eventCount === 3, 'automation summary should count filtered events');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('recorded convective FLIGHT_VIOLATION rows are suppressed on replay', async () => {
    const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'recorded-convective-'));
    const csvPath = path.join(tmpDir, 'recorded-convective.csv');
    const baseTs = 1700000320000;
    const headers = [
      'flight_id',
      'timestamp_utc',
      'ts',
      'timestamp_ms',
      'flight_elapsed_ms',
      'record_type',
      'phase',
      'lat_deg',
      'lon_deg',
      'ra_ft',
      'on_ground',
      'ias_kts',
      'vs_fpm',
      'gs_kts',
      'hdg_true_deg',
      'alt_msl_ft',
      'aircraft',
      'rule_id',
      'label',
      'severity',
      'duration_ms',
      'risk_level',
      'confidence_level',
      'convective_score',
      'convective_duration_ms',
      'convective_motion_score',
      'convective_weather_score',
      'convective_weather_available',
      'convective_weather_aligned',
      'convective_peak_load_excursion_g',
      'convective_avg_load_excursion_g',
      'convective_peak_load_jerk_gps',
      'convective_peak_pitch_rate_dps',
      'convective_peak_roll_rate_dps',
      'convective_peak_yaw_rate_dps',
      'convective_peak_pitch_deg',
      'convective_peak_bank_deg',
      'convective_maneuver_ratio',
      'convective_maneuver_suppressed',
      'convective_vertical_reversals',
      'convective_vertical_reversal_rate_per_min',
      'convective_vertical_speed_activity_score',
      'convective_ias_range_kts',
      'convective_vs_range_fpm',
      'convective_in_cloud_ratio',
      'convective_precip_ratio',
      'convective_precip_rate_max_mm',
      'convective_density_alt_ft',
      'convective_sample_count',
    ];
    const rows = [
      ['convective-replay', new Date(baseTs).toISOString(), baseTs, '', 0, 'SAMPLE', 'CRUISE', 40.0000, -70.0000, 5000, 'false', 250, 0, 450, 90, 35000, 'A330', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['convective-replay', '', '', baseTs + 31000, '', 'FLIGHT_VIOLATION_START', 'CRUISE', 40.0100, -70.0100, 5000, 'false', 249, 900, 450, 90, 35000, 'A330', VIOLATION_RULE.CONVECTIVE_EXPOSURE, 'Convective Exposure Likelihood: HIGH', 'critical', '', 'HIGH', 'HIGH', 0.913, '', 1, 0.71, 1, 1, 0.56, 0.24, 0.79, 14.2, 21.2, 5.5, 9.4, 31.7, 0.382, 1, 7, 3.46, 0.518, 33.8, 1864.5, 0.812, 0.623, 2.76, 37150, 46],
      ['convective-replay', '', '', baseTs + 76000, '', 'FLIGHT_VIOLATION_END', 'CRUISE', 40.0200, -70.0200, 5000, 'false', 250, 0, 450, 90, 35000, 'A330', VIOLATION_RULE.CONVECTIVE_EXPOSURE, 'Convective Exposure Likelihood: HIGH', 'critical', 45000, 'HIGH', 'HIGH', 0.913, 45000, 1, 0.71, 1, 1, 0.56, 0.24, 0.79, 14.2, 21.2, 5.5, 9.4, 31.7, 0.382, 1, 7, 3.46, 0.518, 33.8, 1864.5, 0.812, 0.623, 2.76, 37150, 46],
    ];
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');

    try {
      const timelineGenerator = require(timelineGeneratorPath);
      const result = await timelineGenerator.generateFromCSV(csvPath);
      assert(result.success === true, `expected success, got ${result.error}`);

      const convectiveEvents = result.timeline.events.filter((event) =>
        (event.type === 'violation_start' || event.type === 'violation_end') &&
        event.ruleId === VIOLATION_RULE.CONVECTIVE_EXPOSURE);
      assert(convectiveEvents.length === 0, `expected convective replay rows to be suppressed, got ${convectiveEvents.length}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('recorded dry motion-only convective FLIGHT_VIOLATION rows are suppressed on replay', async () => {
    const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'recorded-dry-convective-'));
    const csvPath = path.join(tmpDir, 'recorded-dry-convective.csv');
    const baseTs = 1700000380000;
    const headers = [
      'flight_id',
      'timestamp_utc',
      'ts',
      'timestamp_ms',
      'flight_elapsed_ms',
      'record_type',
      'phase',
      'lat_deg',
      'lon_deg',
      'ra_ft',
      'on_ground',
      'ias_kts',
      'vs_fpm',
      'gs_kts',
      'hdg_true_deg',
      'alt_msl_ft',
      'aircraft',
      'rule_id',
      'label',
      'severity',
      'duration_ms',
      'risk_level',
      'confidence_level',
      'convective_score',
      'convective_duration_ms',
      'convective_motion_score',
      'convective_weather_score',
      'convective_weather_available',
      'convective_weather_aligned',
      'convective_precip_ratio',
      'convective_precip_rate_max_mm',
      'convective_sample_count',
    ];
    const rows = [
      ['dry-convective-replay', new Date(baseTs).toISOString(), baseTs, '', 0, 'SAMPLE', 'CLIMB', 40.0000, -70.0000, 5000, 'false', 250, 0, 450, 90, 35000, 'A330', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['dry-convective-replay', '', '', baseTs + 31000, '', 'FLIGHT_VIOLATION_START', 'CLIMB', 40.0100, -70.0100, 5000, 'false', 149, 1639, 450, 90, 12000, 'A330', VIOLATION_RULE.CONVECTIVE_EXPOSURE, 'Convective Exposure Likelihood: HIGH', 'critical', '', 'HIGH', 'LOW', 0.700, '', 1, 0, 1, 0, 0, 0, 379],
      ['dry-convective-replay', '', '', baseTs + 76000, '', 'FLIGHT_VIOLATION_END', 'CLIMB', 40.0200, -70.0200, 5000, 'false', 150, 0, 450, 90, 12000, 'A330', VIOLATION_RULE.CONVECTIVE_EXPOSURE, 'Convective Exposure Likelihood: HIGH', 'critical', 45000, 'HIGH', 'LOW', 0.742, 45000, 1, 0.14, 1, 1, 0, 0, 394],
    ];
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');

    try {
      const timelineGenerator = require(timelineGeneratorPath);
      const result = await timelineGenerator.generateFromCSV(csvPath);
      assert(result.success === true, `expected success, got ${result.error}`);

      const convectiveEvents = result.timeline.events.filter((event) =>
        (event.type === 'violation_start' || event.type === 'violation_end') &&
        event.ruleId === VIOLATION_RULE.CONVECTIVE_EXPOSURE);
      assert(convectiveEvents.length === 0, `expected dry convective replay rows to be suppressed, got ${convectiveEvents.length}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('short landing replay keeps signed Short Landing zone', async () => {
    const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'short-landing-'));
    const csvPath = path.join(tmpDir, 'short-landing.csv');
    const baseTs = 1700000000000;
    const headers = [
      'flight_id',
      'timestamp_utc',
      'ts',
      'flight_elapsed_ms',
      'record_type',
      'phase',
      'lat_deg',
      'lon_deg',
      'ra_ft',
      'on_ground',
      'ias_kts',
      'vs_fpm',
      'g_force',
      'gs_kts',
      'hdg_true_deg',
      'alt_msl_ft',
      'aircraft',
    ];
    const rows = [
      ['short-test', new Date(baseTs).toISOString(), baseTs, 0, 'SAMPLE', 'APPROACH', 36.9990, -122, 100, 'false', 140, -700, 1.1, 140, 360, 900, 'A320'],
      ['short-test', new Date(baseTs + 1000).toISOString(), baseTs + 1000, 1000, 'SAMPLE', 'APPROACH', 36.9998, -122, 5, 'true', 130, -500, 1.1, 120, 360, 800, 'A320'],
    ];

    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');

    try {
      await withMockRunway({
        icao: 'TEST',
        airportName: 'Test Field',
        runway: '36',
        runwayId: '36',
        threshold: { lat: 37, lon: -122 },
        heading: 360,
        lengthFt: 6000,
        widthFt: 150,
        surface: 'ASPHALT',
        elevation_ft: 700,
      }, async (timelineGenerator) => {
        const result = await timelineGenerator.generateFromCSV(csvPath);
        assert(result.success === true, `expected success, got ${result.error}`);
        const landing = result.timeline.events.find((event) => event.type === 'landing');
        assert(landing, 'expected landing event');
        assert(landing.touchdownDistance, 'expected touchdownDistance');
        assert(landing.touchdownDistance.distanceFt < 0, `expected signed negative distance, got ${landing.touchdownDistance.distanceFt}`);
        assert(landing.touchdownDistance.shortLanding === true, 'expected shortLanding flag');
        assert(landing.touchdownDistance.grade === 'Short Landing', `expected Short Landing, got ${landing.touchdownDistance.grade}`);
        assert(landing.touchdownDistance.score === 0, `expected score 0, got ${landing.touchdownDistance.score}`);
        assert(landing.touchdownDistance.zone === 'Before Threshold', `expected Before Threshold zone, got ${landing.touchdownDistance.zone}`);
        assert(Array.isArray(landing.approachProfile), 'expected approachProfile');
        assert(landing.approachProfile.length >= 2, `expected at least 2 approach samples, got ${landing.approachProfile.length}`);
        assert(landing.approachProfile[1].dtMs === 1000, `expected elapsed 0 sample to produce 1000 ms dt, got ${landing.approachProfile[1].dtMs}`);
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('pure replay core builds a landing without CSV file I/O', async () => {
    await withMockRunway({
      icao: 'TEST',
      airportName: 'Test Field',
      runway: '36',
      runwayId: '36',
      threshold: { lat: 37, lon: -122 },
      heading: 360,
      lengthFt: 6000,
      widthFt: 150,
      surface: 'ASPHALT',
      elevation_ft: 700,
    }, async (timelineGenerator) => {
      const result = timelineGenerator._generateTimelineFromRows('pure-replay.csv', [
        {
          flight_id: 'pure-replay',
          timestamp_utc: new Date(1700000200000).toISOString(),
          ts: 1700000200000,
          flight_elapsed_ms: 0,
          record_type: 'SAMPLE',
          phase: 'APPROACH',
          lat_deg: 36.9990,
          lon_deg: -122,
          ra_ft: 100,
          on_ground: false,
          ias_kts: 140,
          vs_fpm: -700,
          g_force: 1.1,
          gs_kts: 140,
          hdg_true_deg: 360,
          alt_msl_ft: 900,
          aircraft: 'A320',
        },
        {
          flight_id: 'pure-replay',
          timestamp_utc: new Date(1700000201000).toISOString(),
          ts: 1700000201000,
          flight_elapsed_ms: 1000,
          record_type: 'SAMPLE',
          phase: 'APPROACH',
          lat_deg: 36.9998,
          lon_deg: -122,
          ra_ft: 5,
          on_ground: true,
          ias_kts: 130,
          vs_fpm: -500,
          g_force: 1.1,
          gs_kts: 120,
          hdg_true_deg: 360,
          alt_msl_ft: 800,
          aircraft: 'A320',
        },
      ]);
      assert(result.success === true, `expected success, got ${result.error}`);
      const landing = result.timeline.events.find((event) => event.type === 'landing');
      assert(landing, 'expected landing event');
      assert(landing.touchdownDistance, 'expected touchdownDistance');
      assert(landing.touchdownDistance.shortLanding === true, 'expected shortLanding flag');
      assert(Array.isArray(landing.approachProfile), 'expected approach profile');
      assert(landing.approachProfile.length >= 2, `expected at least two approach samples, got ${landing.approachProfile.length}`);
    });
  });

  await testAsync('replay suppresses a short ground-level WOW dropout as bounce sensor chatter', async () => {
    await withMockRunway({
      icao: 'TEST',
      airportName: 'Test Field',
      runway: '36',
      runwayId: '36',
      threshold: { lat: 37, lon: -122 },
      heading: 360,
      lengthFt: 6000,
      widthFt: 150,
      surface: 'ASPHALT',
      elevation_ft: 700,
    }, async (timelineGenerator) => {
      const baseTs = 1700000203000;
      const sample = (offsetMs, overrides = {}) => ({
        flight_id: 'wow-chatter-replay',
        timestamp_utc: new Date(baseTs + offsetMs).toISOString(),
        ts: baseTs + offsetMs,
        flight_elapsed_ms: offsetMs,
        record_type: 'SAMPLE',
        phase: 'APPROACH',
        lat_deg: 37.001,
        lon_deg: -122,
        ra_ft: 100,
        on_ground: false,
        ias_kts: 130,
        vs_fpm: -700,
        g_force: 1.05,
        gs_kts: 120,
        hdg_true_deg: 360,
        alt_msl_ft: 800,
        alt_plane_ft: 800,
        aircraft: 'A320',
        aircraft_profile_id: 'fbw-a32nx',
        ...overrides,
      });
      const result = timelineGenerator._generateTimelineFromRows('wow-chatter-replay.csv', [
        sample(0),
        sample(1000, { ra_ft: 0, on_ground: true, vs_fpm: -180, alt_plane_ft: 700 }),
        // WOW briefly drops out, but neither RA nor geometric altitude rises.
        sample(1200, { ra_ft: 0, on_ground: false, vs_fpm: -20, alt_plane_ft: 699.9 }),
        sample(1400, { ra_ft: 0, on_ground: true, vs_fpm: -60, alt_plane_ft: 699.8 }),
      ]);

      assert(result.success === true, `expected success, got ${result.error}`);
      const landings = result.timeline.events.filter((event) => event.type === 'landing');
      assert(landings.length === 1, `expected one landing event, got ${landings.length}`);
      assert((landings[0].bounceCount || 0) === 0, `expected no replay bounce, got ${landings[0].bounceCount}`);
      assert(
        (landings[0].touchdownDistance?.bounceCount || 0) === 0,
        `expected no nested replay bounce, got ${landings[0].touchdownDistance?.bounceCount}`,
      );
    });
  });

  await testAsync('replay preserves a genuine bounce with corroborating radio-height lift', async () => {
    await withMockRunway({
      icao: 'TEST',
      airportName: 'Test Field',
      runway: '36',
      runwayId: '36',
      threshold: { lat: 37, lon: -122 },
      heading: 360,
      lengthFt: 6000,
      widthFt: 150,
      surface: 'ASPHALT',
      elevation_ft: 700,
    }, async (timelineGenerator) => {
      const baseTs = 1700000205000;
      const sample = (offsetMs, overrides = {}) => ({
        flight_id: 'physical-bounce-replay',
        timestamp_utc: new Date(baseTs + offsetMs).toISOString(),
        ts: baseTs + offsetMs,
        flight_elapsed_ms: offsetMs,
        record_type: 'SAMPLE',
        phase: 'APPROACH',
        lat_deg: 37.001,
        lon_deg: -122,
        ra_ft: 100,
        on_ground: false,
        ias_kts: 130,
        vs_fpm: -700,
        g_force: 1.05,
        gs_kts: 120,
        hdg_true_deg: 360,
        alt_msl_ft: 800,
        alt_plane_ft: 800,
        aircraft: 'A320',
        aircraft_profile_id: 'fbw-a32nx',
        ...overrides,
      });
      const result = timelineGenerator._generateTimelineFromRows('physical-bounce-replay.csv', [
        sample(0),
        sample(1000, { ra_ft: 0, on_ground: true, vs_fpm: -180, alt_plane_ft: 700 }),
        sample(1200, { ra_ft: 4, on_ground: false, vs_fpm: 80, alt_plane_ft: 703 }),
        sample(1500, { ra_ft: 0, on_ground: true, vs_fpm: -60, alt_plane_ft: 700 }),
      ]);

      assert(result.success === true, `expected success, got ${result.error}`);
      const landings = result.timeline.events.filter((event) => event.type === 'landing');
      assert(landings.length === 1, `expected one landing event, got ${landings.length}`);
      assert(landings[0].bounceCount === 1, `expected one replay bounce, got ${landings[0].bounceCount}`);
      assert(
        landings[0].touchdownDistance?.bounceCount === 1,
        `expected one nested replay bounce, got ${landings[0].touchdownDistance?.bounceCount}`,
      );
    });
  });

  await testAsync('replay confirms a sustained shallow hop but rejects similarly long WOW chatter', async () => {
    await withMockRunway({
      icao: 'TEST',
      airportName: 'Test Field',
      runway: '36',
      runwayId: '36',
      threshold: { lat: 37, lon: -122 },
      heading: 360,
      lengthFt: 6000,
      widthFt: 150,
      surface: 'ASPHALT',
      elevation_ft: 700,
    }, async (timelineGenerator) => {
      const baseTs = 1700000205500;
      const sample = (flightId, offsetMs, overrides = {}) => ({
        flight_id: flightId,
        timestamp_utc: new Date(baseTs + offsetMs).toISOString(),
        ts: baseTs + offsetMs,
        flight_elapsed_ms: offsetMs,
        record_type: 'SAMPLE',
        phase: 'APPROACH',
        lat_deg: 37.001,
        lon_deg: -122,
        ra_ft: 100,
        on_ground: false,
        ias_kts: 130,
        vs_fpm: -500,
        g_force: 1.05,
        gs_kts: 120,
        hdg_true_deg: 360,
        alt_msl_ft: 800,
        alt_plane_ft: 800,
        aircraft: 'A320',
        aircraft_profile_id: 'fbw-a32nx',
        ...overrides,
      });

      const shallowHop = timelineGenerator._generateTimelineFromRows('shallow-hop-replay.csv', [
        sample('shallow-hop-replay', 0),
        sample('shallow-hop-replay', 1000, { ra_ft: 0, on_ground: true, vs_fpm: -180, alt_plane_ft: 700 }),
        sample('shallow-hop-replay', 1200, { ra_ft: 0.1, on_ground: false, vs_fpm: 20, alt_plane_ft: 700.2 }),
        sample('shallow-hop-replay', 1700, { ra_ft: 0.4, on_ground: false, vs_fpm: 48, alt_plane_ft: 700.8 }),
        sample('shallow-hop-replay', 2135, { ra_ft: 0, on_ground: true, vs_fpm: -30, g_force: 1.1, alt_plane_ft: 700 }),
        {
          ...sample('shallow-hop-replay', 2600, { ra_ft: 0, on_ground: true, vs_fpm: -243, alt_plane_ft: 700 }),
          record_type: 'LANDING',
          grade: 'PERFECT',
          bounce_count: 0,
          bounce_grade: 'Clean',
          bounce_score: 100,
          td_sim_trusted: true,
          td_sim_fresh: true,
          td_sim_landing_vs_fpm: -349,
        },
      ]);
      assert(shallowHop.success === true, `expected shallow-hop success, got ${shallowHop.error}`);
      const shallowLanding = shallowHop.timeline.events.find((event) => event.type === 'landing');
      assert(shallowLanding?.bounceCount === 1, `expected one shallow replay bounce, got ${shallowLanding?.bounceCount}`);
      assert(shallowLanding?.touchdownDistance?.bounceCount === 1, 'expected replay bounce to win over persisted zero');
      assert(shallowLanding?.touchdownDistance?.bounceGrade == null, 'expected stale Clean bounce grade to be cleared');
      assert(shallowLanding?.touchdownDistance?.bounceScore == null, 'expected stale 100 bounce score to be cleared');
      assert(shallowLanding?.vs_fpm === -243, `expected persisted landing V/S, got ${shallowLanding?.vs_fpm}`);
      assert(shallowLanding?.grade === 'GOOD', `expected recorded-profile landing grade, got ${shallowLanding?.grade}`);

      const legacyExcursion = timelineGenerator._generateTimelineFromRows('legacy-excursion-replay.csv', [
        sample('legacy-excursion-replay', 0),
        sample('legacy-excursion-replay', 1000, { ra_ft: 0, on_ground: true, vs_fpm: -243, alt_plane_ft: 700 }),
        {
          ...sample('legacy-excursion-replay', 2600, { ra_ft: 0, on_ground: true, vs_fpm: -243, alt_plane_ft: 700 }),
          record_type: 'LANDING',
          grade: 'RUNWAY EXCURSION',
          runway_excursion: true,
          td_sim_trusted: true,
          td_sim_fresh: true,
          td_sim_landing_vs_fpm: -349,
        },
      ]);
      assert(legacyExcursion.success === true, `expected legacy-excursion success, got ${legacyExcursion.error}`);
      const excursionLanding = legacyExcursion.timeline.events.find((event) => event.type === 'landing');
      assert(excursionLanding?.vs_fpm === -243, 'complete legacy landing should retain persisted V/S');
      assert(excursionLanding?.grade === 'GOOD', 'legacy excursion sentinel must not replace the rate grade');
      assert(excursionLanding?.runwayExcursion === true, 'timeline event should preserve row.runway_excursion separately');

      for (const [label, tdSimTrusted, tdSimFresh] of [
        ['untrusted', false, true],
        ['stale', true, false],
      ]) {
        const flightId = `${label}-sustained-wow-chatter-replay`;
        const wowChatter = timelineGenerator._generateTimelineFromRows(`${flightId}.csv`, [
          sample(flightId, 0),
          sample(flightId, 1000, { ra_ft: 0, on_ground: true, vs_fpm: -180, alt_plane_ft: 700 }),
          sample(flightId, 1200, { ra_ft: 0.3, on_ground: false, vs_fpm: 5, alt_plane_ft: 700 }),
          sample(flightId, 1700, { ra_ft: 0.4, on_ground: false, vs_fpm: 10, alt_plane_ft: 700 }),
          sample(flightId, 2135, { ra_ft: 0, on_ground: true, vs_fpm: -30, g_force: 1.1, alt_plane_ft: 700 }),
          {
            ...sample(flightId, 2600, { ra_ft: 0, on_ground: true, vs_fpm: -243, alt_plane_ft: 700 }),
            record_type: 'LANDING',
            grade: 'PERFECT',
            bounce_count: 0,
            td_sim_trusted: tdSimTrusted,
            td_sim_fresh: tdSimFresh,
            td_sim_landing_vs_fpm: -349,
          },
        ]);
        assert(wowChatter.success === true, `expected ${label} WOW-chatter success, got ${wowChatter.error}`);
        const chatterLanding = wowChatter.timeline.events.find((event) => event.type === 'landing');
        assert((chatterLanding?.bounceCount || 0) === 0, `expected no ${label} chatter bounce, got ${chatterLanding?.bounceCount}`);
        assert(chatterLanding?.vs_fpm === -243, `expected ${label} simulator V/S to be ignored, got ${chatterLanding?.vs_fpm}`);
        assert(chatterLanding?.grade === 'GOOD', `expected ${label} rate grade to be recomputed, got ${chatterLanding?.grade}`);
      }

      const diagnosticOnly = timelineGenerator._generateTimelineFromRows('diagnostic-only-vs.csv', [{
        ...sample('diagnostic-only-vs', 1000, { on_ground: true, vs_fpm: null, ra_ft: 0, alt_plane_ft: 700 }),
        record_type: 'LANDING',
        grade: 'FIRM',
        td_sim_trusted: true,
        td_sim_fresh: true,
        td_sim_landing_vs_fpm: -349,
      }]);
      assert(diagnosticOnly.success === true, `expected diagnostic-only success, got ${diagnosticOnly.error}`);
      const diagnosticOnlyLanding = diagnosticOnly.timeline.events.find((event) => event.type === 'landing');
      assert(diagnosticOnlyLanding?.vs_fpm == null, 'simulator diagnostic must not fill a missing conventional V/S');
      assert(diagnosticOnlyLanding?.grade === 'FIRM', 'persisted rate grade is the fallback only when conventional V/S is absent');
    });
  });

  await testAsync('historical landing grading uses the recorded profile and leaves the active aircraft alone', async () => {
    await withMockRunway({
      icao: 'TEST',
      airportName: 'Test Field',
      runway: '36',
      runwayId: '36',
      threshold: { lat: 37, lon: -122 },
      heading: 360,
      lengthFt: 6000,
      widthFt: 150,
      surface: 'ASPHALT',
      elevation_ft: 700,
    }, async (timelineGenerator) => {
      const previousProfileId = profileLoader.getActiveProfileId();
      profileLoader.setActiveProfile('generic');
      const activeGenericId = profileLoader.getActiveProfileId();
      const baseTs = 1700000206000;
      const sample = (flightId, offsetMs, overrides = {}) => ({
        flight_id: flightId,
        timestamp_utc: new Date(baseTs + offsetMs).toISOString(),
        ts: baseTs + offsetMs,
        flight_elapsed_ms: offsetMs,
        record_type: 'SAMPLE',
        phase: 'APPROACH',
        lat_deg: 37.001,
        lon_deg: -122,
        ra_ft: 100,
        on_ground: false,
        ias_kts: 130,
        vs_fpm: -500,
        g_force: 1.05,
        gs_kts: 120,
        hdg_true_deg: 360,
        alt_msl_ft: 800,
        alt_plane_ft: 800,
        aircraft: 'A380',
        aircraft_profile_id: 'fbw-a380x',
        ...overrides,
      });

      try {
        const incomplete = timelineGenerator._generateTimelineFromRows('recorded-profile-grade.csv', [{
          ...sample('recorded-profile-grade', 1000, {
            ra_ft: 0,
            on_ground: true,
            vs_fpm: -180,
            alt_plane_ft: 700,
          }),
          record_type: 'LANDING',
          grade: null,
        }]);
        assert(incomplete.success === true, `expected incomplete-row success, got ${incomplete.error}`);
        const reconstructed = incomplete.timeline.events.find((event) => event.type === 'landing');
        assert(reconstructed?.vs_fpm === -180, `expected persisted V/S, got ${reconstructed?.vs_fpm}`);
        assert(reconstructed?.grade === 'GOOD', `expected recorded A380 grade GOOD, got ${reconstructed?.grade}`);
        assert(incomplete.timeline.analysisRescore?.mode === 'recorded', 'default timeline must use recorded landing analysis');
        assert(
          JSON.stringify(incomplete.timeline.analysisRescore?.contract) === JSON.stringify(CURRENT_ANALYSIS_RESCORE_CONTRACT),
          'timeline must expose the shared landing-analysis contract',
        );

        const contextBackedRow = {
          ...sample('recorded-context-grade', 1000, {
            ra_ft: 0,
            on_ground: true,
            vs_fpm: -180,
            alt_plane_ft: 700,
          }),
          record_type: 'LANDING',
          sample_index: 731,
          grade: 'PERFECT',
          landing_rate_context: JSON.stringify({
            schemaVersion: 1,
            criteriaSource: 'recorded',
            policy: { id: 'landing-rate-v1', version: 1 },
            profile: { id: 'fbw-a380x', name: 'FlyByWire A380X', resolved: true },
            thresholds: {
              perfectMinFpm: -250,
              goodMinFpm: -450,
              firmMinFpm: -700,
              hardMinFpm: -1000,
            },
          }),
        };
        const recordedSnapshot = timelineGenerator._generateTimelineFromRows(
          'recorded-context-grade.csv',
          [contextBackedRow],
        );
        const recordedSnapshotLanding = recordedSnapshot.timeline.events.find((event) => event.type === 'landing');
        assert(recordedSnapshotLanding?.grade === 'PERFECT', 'recorded context-backed grade must remain the default');
        assert(recordedSnapshotLanding?.landingKey === '731', 'normal timeline should expose the immutable LANDING sample index');
        assert(recordedSnapshotLanding?.landingGradePreview == null, 'normal timeline must not add retired grade-preview state');
        assert(recordedSnapshotLanding?.landingRateContext?.profile?.id === 'fbw-a380x', 'recorded scoring context should be exposed');

        const currentPreview = timelineGenerator._generateTimelineFromRows(
          'recorded-context-grade.csv',
          [contextBackedRow],
          { scoringMode: 'current-preview', requestId: 'preview-1' },
        );
        const currentPreviewLanding = currentPreview.timeline.events.find((event) => event.type === 'landing');
        assert(currentPreview.timeline.analysisRescore?.mode === 'current-preview', 'preview timeline must declare current-preview mode');
        assert(currentPreview.timeline.analysisRescore?.persistedDataModified === false, 'preview must declare that persisted data is untouched');
        assert(currentPreview.timeline.analysisRescore?.complete === false, 'LANDING-only preview must report missing replay surfaces');
        assert(currentPreviewLanding?.grade === 'GOOD', `expected current A380 preview grade GOOD, got ${currentPreviewLanding?.grade}`);
        assert(currentPreviewLanding?.landingGradePreview == null, 'current preview must not expose retired grade-only comparison state');
        assert(currentPreviewLanding?.landingKey === '731', 'preview event should keep the immutable LANDING sample index');
        assert(currentPreviewLanding?.landingRateContext?.criteriaSource === 'current-rescore', 'preview must expose the current scoring context');
        const currentPreviewAnalysis = currentPreview.timeline.analysisRescore?.landings?.[0];
        assert(currentPreviewAnalysis?.landingKey === '731', 'preview analysis should carry the immutable landing key');
        assert(currentPreviewAnalysis?.profileId === 'fbw-a380x', 'preview analysis must use the recorded profile id');
        assert(currentPreviewAnalysis?.metrics?.landingRate?.available === true, 'landing-rate rescore should be available');
        assert(currentPreviewAnalysis?.metrics?.landingRate?.source === 'reconstructed', 'landing-rate rescore should be reconstructed');
        assert(currentPreviewAnalysis?.metrics?.stability?.reason === 'approach_samples_unavailable', 'preview should explain missing stability samples');

        const retiredProfileRow = {
          ...sample('retired-profile-grade', 1000, {
            aircraft: 'PMDG 737-800',
            aircraft_profile_id: 'pmdg-737',
            ra_ft: 0,
            on_ground: true,
            vs_fpm: -650,
            alt_plane_ft: 700,
          }),
          record_type: 'LANDING',
          sample_index: 912,
          grade: 'VERY HARD',
          td_sim_landing_vs_fpm: -900,
        };
        const retiredProfile = timelineGenerator._generateTimelineFromRows('retired-profile-grade.csv', [retiredProfileRow]);
        assert(retiredProfile.success === true, `expected retired-profile success, got ${retiredProfile.error}`);
        const preserved = retiredProfile.timeline.events.find((event) => event.type === 'landing');
        assert(preserved?.vs_fpm === -650, `expected retired-profile persisted V/S, got ${preserved?.vs_fpm}`);
        assert(preserved?.grade === 'VERY HARD', `expected retired-profile saved grade, got ${preserved?.grade}`);

        const retiredPreview = timelineGenerator._generateTimelineFromRows(
          'retired-profile-grade.csv',
          [retiredProfileRow],
          { scoringMode: 'current-preview' },
        );
        const retiredPreviewLanding = retiredPreview.timeline.events.find((event) => event.type === 'landing');
        assert(retiredPreviewLanding?.grade === null, 'unavailable profile preview must not leak the recorded grade');
        assert(retiredPreviewLanding?.landingRateContext === null, 'retired profile preview must not substitute generic scoring context');
        const retiredPreviewAnalysis = retiredPreview.timeline.analysisRescore?.landings?.[0];
        assert(retiredPreviewAnalysis?.available === false, 'retired profile preview must be unavailable');
        assert(retiredPreviewAnalysis?.profileId === 'pmdg-737', 'retired preview must report the recorded profile id');
        assert(retiredPreviewAnalysis?.metrics?.landingRate?.reason === 'recorded_profile_unavailable', 'retired preview must explain why landing-rate rescore is unavailable');
        assert(retiredPreviewAnalysis?.metrics?.rollout?.reason === 'recorded_profile_unavailable', 'retired preview must fail closed for current rollout policy');

        const impactOnlyBounce = timelineGenerator._generateTimelineFromRows('recorded-profile-bounce.csv', [
          sample('recorded-profile-bounce', 0),
          sample('recorded-profile-bounce', 1000, {
            ra_ft: 0,
            on_ground: true,
            vs_fpm: -180,
            alt_plane_ft: 700,
          }),
          sample('recorded-profile-bounce', 1200, {
            ra_ft: 0,
            on_ground: false,
            vs_fpm: 0,
            alt_plane_ft: 700,
          }),
          sample('recorded-profile-bounce', 1500, {
            ra_ft: 0,
            on_ground: true,
            vs_fpm: -150,
            g_force: 1.1,
            alt_plane_ft: 700,
          }),
        ]);
        assert(impactOnlyBounce.success === true, `expected bounce success, got ${impactOnlyBounce.error}`);
        const bounceLanding = impactOnlyBounce.timeline.events.find((event) => event.type === 'landing');
        assert(bounceLanding?.grade === 'GOOD', `expected SAMPLE-only A380 grade GOOD, got ${bounceLanding?.grade}`);
        assert(bounceLanding?.bounceCount === 1, `expected recorded-profile bounce, got ${bounceLanding?.bounceCount}`);

        const retiredProfileBounce = timelineGenerator._generateTimelineFromRows('retired-profile-bounce.csv', [
          sample('retired-profile-bounce', 0, {
            aircraft: 'PMDG 737-800',
            aircraft_profile_id: 'pmdg-737',
          }),
          sample('retired-profile-bounce', 1000, {
            aircraft: 'PMDG 737-800',
            aircraft_profile_id: 'pmdg-737',
            ra_ft: 0,
            on_ground: true,
            vs_fpm: -650,
            alt_plane_ft: 700,
          }),
          sample('retired-profile-bounce', 1200, {
            aircraft: 'PMDG 737-800',
            aircraft_profile_id: 'pmdg-737',
            ra_ft: 0,
            on_ground: false,
            vs_fpm: 0,
            alt_plane_ft: 700,
          }),
          sample('retired-profile-bounce', 1500, {
            aircraft: 'PMDG 737-800',
            aircraft_profile_id: 'pmdg-737',
            ra_ft: 0,
            on_ground: true,
            vs_fpm: -650,
            g_force: 1.1,
            alt_plane_ft: 700,
          }),
        ]);
        assert(retiredProfileBounce.success === true, `expected retired-profile bounce success, got ${retiredProfileBounce.error}`);
        const retiredBounceLanding = retiredProfileBounce.timeline.events.find((event) => event.type === 'landing');
        assert(retiredBounceLanding?.bounceCount === 1, 'retired-profile impact fallback must retain bounce detection');
        assert(profileLoader.getActiveProfileId() === activeGenericId, 'historical analysis changed the active profile');
      } finally {
        if (previousProfileId) profileLoader.setActiveProfile(previousProfileId);
      }
    });
  });

  await testAsync('current preview fully reconstructs every landing-analysis surface for multiple landings', async () => {
    await withMockRunway({
      icao: 'TEST',
      airportName: 'Test Field',
      runway: '36',
      runwayId: '36',
      threshold: { lat: 37, lon: -122 },
      heading: 360,
      heading_true_deg: 360,
      lengthFt: 6000,
      widthFt: 150,
      surface: 'ASPHALT',
      elevation_ft: 700,
      source: 'msfs-facilities',
      elevationReference: 'runway',
    }, async (timelineGenerator) => {
      const baseTs = 1700000206250;
      const flightId = 'full-analysis-current-preview';
      const sample = (offsetMs, overrides = {}) => ({
        flight_id: flightId,
        timestamp_utc: new Date(baseTs + offsetMs).toISOString(),
        ts: baseTs + offsetMs,
        flight_elapsed_ms: offsetMs,
        record_type: 'SAMPLE',
        phase: 'APPROACH',
        lat_deg: 37.001,
        lon_deg: -122,
        ra_ft: 1200,
        on_ground: false,
        surface_on_runway: true,
        ias_kts: 140,
        vs_fpm: -640,
        g_force: 1.05,
        gs_kts: 120,
        bank_deg: 0,
        pitch_deg: 3,
        hdg_true_deg: 360,
        alt_msl_ft: 1900,
        alt_calibrated_ft: 1900,
        alt_plane_ft: 1900,
        gear_down_locked: 1,
        flaps_pct: 30,
        flaps_notch: 3,
        spoiler_pct: 0,
        spoiler_state: 'ARMED',
        thr1_pct: 35,
        thr2_pct: 35,
        aircraft: 'A380',
        aircraft_profile_id: 'fbw-a380x',
        ...overrides,
      });
      const recordedRateContext = JSON.stringify({
        schemaVersion: 1,
        criteriaSource: 'recorded',
        policy: { id: 'landing-rate-v1', version: 1 },
        profile: { id: 'fbw-a380x', name: 'FlyByWire A380X', resolved: true },
        thresholds: {
          perfectMinFpm: -100,
          goodMinFpm: -200,
          firmMinFpm: -300,
          hardMinFpm: -400,
        },
      });
      const heights = [1200, 950, 750, 550, 350, 150];
      const buildAttempt = (startOffsetMs, landingKey, bounceCount) => {
        const touchdownOffsetMs = startOffsetMs + 6000;
        const touchdownLat = 37.001 + (landingKey / 10000000);
        const rows = heights.map((raFt, index) => sample(startOffsetMs + index * 1000, {
          ra_ft: raFt,
          alt_msl_ft: 700 + raFt,
          alt_calibrated_ft: 700 + raFt,
          alt_plane_ft: 700 + raFt,
          lat_deg: touchdownLat - 0.001 + (index * 0.00015),
        }));
        rows.push(
          sample(touchdownOffsetMs, {
            phase: 'LANDING',
            ra_ft: 0,
            alt_msl_ft: 700,
            alt_calibrated_ft: 700,
            alt_plane_ft: 700,
            lat_deg: touchdownLat,
            on_ground: true,
            vs_fpm: -180,
            g_force: 1.25,
            gs_kts: 118,
          }),
          sample(touchdownOffsetMs + 500, {
            phase: 'LANDING',
            ra_ft: 0,
            alt_msl_ft: 700,
            alt_calibrated_ft: 700,
            alt_plane_ft: 700,
            lat_deg: touchdownLat + 0.0004,
            on_ground: true,
            vs_fpm: 0,
            gs_kts: 100,
          }),
          sample(touchdownOffsetMs + 1000, {
            phase: 'LANDING',
            ra_ft: 0,
            alt_msl_ft: 700,
            alt_calibrated_ft: 700,
            alt_plane_ft: 700,
            lat_deg: touchdownLat + 0.0008,
            on_ground: true,
            vs_fpm: 0,
            gs_kts: 80,
          }),
          sample(touchdownOffsetMs + 1500, {
            phase: 'TAXI-IN',
            ra_ft: 0,
            alt_msl_ft: 700,
            alt_calibrated_ft: 700,
            alt_plane_ft: 700,
            lat_deg: touchdownLat + 0.001,
            on_ground: true,
            surface_on_runway: false,
            vs_fpm: 0,
            gs_kts: 45,
          }),
          {
            ...sample(touchdownOffsetMs + 2000, {
              phase: 'LANDING',
              ra_ft: 0,
              alt_msl_ft: 700,
              alt_calibrated_ft: 700,
              alt_plane_ft: 700,
              lat_deg: touchdownLat,
              on_ground: true,
              vs_fpm: -180,
              g_force: 1.25,
              gs_kts: 118,
            }),
            record_type: 'LANDING',
            sample_index: landingKey,
            icao: 'TEST',
            runway: '36',
            grade: 'VERY HARD',
            landing_rate_context: recordedRateContext,
            runway_excursion: false,
            short_landing: false,
            touchdown_distance_ft: landingKey === 1001 ? 500 : 900,
            touchdown_distance_score: 1,
            touchdown_distance_grade: 'Dangerous',
            runway_condition: 'dry',
            runway_condition_source: 'simconnect',
            runway_condition_confident: true,
            runway_geometry_source: 'msfs-facilities',
            runway_reference_elev_ft: 700,
            runway_reference_elevation_source: 'msfs-facilities',
            runway_reference_elevation_kind: 'runway',
            runway_heading_true_deg: 360,
            runway_length_ft: 6000,
            runway_width_ft: 150,
            runway_threshold_lat: 37,
            runway_threshold_lon: -122,
            lateral_offset_ft: 8,
            lateral_offset_side: 'right',
            lateral_offset_score: 1,
            lateral_offset_grade: 'Excursion',
            lateral_offset_suspect: landingKey === 2002,
            bounce_count: bounceCount,
            bounce_score: 1,
            bounce_grade: 'Porpoise',
            bounce_distance_ft: bounceCount > 0 ? 80 : 0,
            bounce_worst_gforce: bounceCount > 0 ? 1.4 : 1.25,
            first_touchdown_lat: touchdownLat,
            first_touchdown_lon: -122,
            first_touchdown_vs_fpm: -180,
            first_touchdown_gforce: 1.25,
            final_touchdown_lat: bounceCount > 0 ? touchdownLat + 0.0002 : null,
            final_touchdown_lon: bounceCount > 0 ? -122 : null,
            final_touchdown_vs_fpm: bounceCount > 0 ? -90 : null,
            final_touchdown_gforce: bounceCount > 0 ? 1.4 : null,
            ultimate_stability_score: 1,
            ultimate_stability_samples: 99,
            ultimate_stability_gate_stable: false,
            ultimate_stability_gate_failures: 'persisted_failure',
            ultimate_stability_breakdown: JSON.stringify({ gear_ok: 1 }),
            rollout_analysis: JSON.stringify({
              schemaVersion: 2,
              source: 'persisted',
              assessment: 'critical',
              sampleCount: 99,
              flags: [{ code: 'persisted_only', severity: 'critical' }],
            }),
          },
        );
        return rows;
      };

      const rows = [
        ...buildAttempt(0, 1001, 0),
        {
          ...sample(9000, {
            phase: 'GO_AROUND',
            ra_ft: 1200,
            alt_msl_ft: 1900,
            alt_calibrated_ft: 1900,
            alt_plane_ft: 1900,
            on_ground: false,
            vs_fpm: 900,
          }),
          record_type: 'GO_AROUND',
          goaround_altitude_ft: 1200,
          previous_phase: 'LANDING',
        },
        ...buildAttempt(10000, 2002, 1),
      ];
      const recorded = timelineGenerator._generateTimelineFromRows(`${flightId}.csv`, rows);
      const preview = timelineGenerator._generateTimelineFromRows(
        `${flightId}.csv`,
        rows,
        { scoringMode: 'current-preview' },
      );
      assert(recorded.success === true, `expected recorded success, got ${recorded.error}`);
      assert(preview.success === true, `expected preview success, got ${preview.error}`);
      const recordedLandings = recorded.timeline.events.filter((event) => event.type === 'landing');
      const previewLandings = preview.timeline.events.filter((event) => event.type === 'landing');
      assert(recordedLandings.length === 2, `expected two recorded landings, got ${recordedLandings.length}`);
      assert(previewLandings.length === 2, `expected two preview landings, got ${previewLandings.length}`);
      assert(preview.timeline.analysisRescore?.complete === true, `expected complete preview, got ${JSON.stringify(preview.timeline.analysisRescore)}`);
      assert(preview.timeline.analysisRescore?.landingCount === 2, 'preview analysis must cover both landings');

      for (let index = 0; index < 2; index += 1) {
        const before = recordedLandings[index];
        const after = previewLandings[index];
        const analysis = preview.timeline.analysisRescore.landings[index];
        assert(after.landingKey === String(index === 0 ? 1001 : 2002), 'preview must retain each immutable landing key');
        assert(after.grade === 'GOOD' && before.grade === 'VERY HARD', 'landing-rate grade must be fully rescored');
        assert(after.ultimateStability?.score !== 1, 'persisted stability score must not leak into preview');
        assert(after.touchdownDistance?.score !== 1, 'persisted touchdown-distance score must not leak into preview');
        assert(after.touchdownDistance?.grade !== 'Dangerous', 'persisted touchdown-distance grade must not leak into preview');
        assert(after.touchdownDistance?.lateralOffsetScore === 100, 'lateral score must be reconstructed from the recorded offset');
        assert(after.touchdownDistance?.lateralOffsetGrade === 'Perfect', 'lateral grade must be reconstructed from the recorded offset');
        assert(after.touchdownDistance?.bounceScore !== 1, 'persisted bounce score must not leak into preview');
        assert(after.touchdownDistance?.bounceGrade !== 'Porpoise', 'persisted bounce grade must not leak into preview');
        assert(after.rolloutAnalysis?.source === 'replay', 'persisted rollout analysis must not leak into preview');
        assert(after.rolloutAnalysis?.assessment !== 'critical', 'rollout assessment must be reconstructed from SAMPLE rows');
        for (const metric of ['landingRate', 'stability', 'touchdownDistance', 'lateralOffset', 'bounce', 'rollout']) {
          assert(analysis.metrics?.[metric]?.available === true, `expected ${metric} to be available for landing ${index + 1}`);
          assert(analysis.metrics?.[metric]?.source === 'reconstructed', `expected reconstructed ${metric} for landing ${index + 1}`);
        }

        for (const field of ['vs_fpm', 'gforce', 'lat', 'lon', 'runwayExcursion', 'bounceCount']) {
          assert(after[field] === before[field], `raw landing field ${field} changed during preview`);
        }
        for (const field of ['distanceFt', 'shortLanding', 'bounceCount', 'bounceDistanceFt', 'bounceWorstGforce']) {
          assert(after.touchdownDistance?.[field] === before.touchdownDistance?.[field], `raw touchdown field ${field} changed during preview`);
        }
        assert(after.touchdownDistance?.lateralOffsetFt === 8, 'preview must retain the immutable LANDING-row lateral offset');
        assert(after.touchdownDistance?.lateralOffsetSide === 'right', 'preview must retain the immutable LANDING-row lateral side');
        assert(
          after.touchdownDistance?.lateralOffsetSuspect === (index === 1),
          'preview must retain the immutable LANDING-row lateral quality flag',
        );
        if (index === 1) {
          assert(
            after.ultimateStability?.scoringContext?.coverage?.metrics?.lateral_offset_ok?.available === false,
            'suspect recorded lateral geometry must not enter the reconstructed stability score',
          );
        }
        assert(
          JSON.stringify(after.touchdownDistance?.firstTouchdown) === JSON.stringify(before.touchdownDistance?.firstTouchdown),
          'first-touchdown bounce evidence changed during preview',
        );
        assert(
          JSON.stringify(after.touchdownDistance?.finalTouchdown) === JSON.stringify(before.touchdownDistance?.finalTouchdown),
          'final-touchdown bounce evidence changed during preview',
        );
        assert(after.runwayReferenceElevFt === 700, 'preview must retain the recorded runway elevation reference');
        assert(after.runwayReferenceElevationSource === 'msfs-facilities', 'preview must retain runway elevation provenance');
        assert(after.runwayReferenceElevationKind === 'runway', 'preview must retain runway elevation reference kind');
      }

      const recordedViolationFacts = recorded.timeline.events
        .filter((event) => event.type === 'violation_start' || event.type === 'violation_end')
        .map((event) => ({ type: event.type, timestampMs: event.timestampMs, ruleId: event.ruleId }));
      const previewViolationFacts = preview.timeline.events
        .filter((event) => event.type === 'violation_start' || event.type === 'violation_end')
        .map((event) => ({ type: event.type, timestampMs: event.timestampMs, ruleId: event.ruleId }));
      assert(
        JSON.stringify(previewViolationFacts) === JSON.stringify(recordedViolationFacts),
        'current preview must preserve violation detections',
      );
    });
  });

  await testAsync('replay confirms a sparse bounce from delayed post-impact load', async () => {
    await withMockRunway({
      icao: 'TEST',
      airportName: 'Test Field',
      runway: '36',
      runwayId: '36',
      threshold: { lat: 37, lon: -122 },
      heading: 360,
      lengthFt: 6000,
      widthFt: 150,
      surface: 'ASPHALT',
      elevation_ft: 700,
    }, async (timelineGenerator) => {
      const baseTs = 1700000206500;
      const sample = (offsetMs, overrides = {}) => ({
        flight_id: 'delayed-bounce-impact-replay',
        timestamp_utc: new Date(baseTs + offsetMs).toISOString(),
        ts: baseTs + offsetMs,
        flight_elapsed_ms: offsetMs,
        record_type: 'SAMPLE',
        phase: 'APPROACH',
        lat_deg: 37.001,
        lon_deg: -122,
        ra_ft: 50,
        on_ground: false,
        ias_kts: 130,
        vs_fpm: -500,
        g_force: 1,
        gs_kts: 120,
        hdg_true_deg: 360,
        alt_msl_ft: 750,
        alt_plane_ft: 750,
        aircraft: 'A320',
        ...overrides,
      });
      const result = timelineGenerator._generateTimelineFromRows('delayed-bounce-impact-replay.csv', [
        sample(0),
        sample(100, { ra_ft: 0, on_ground: true, vs_fpm: -180, alt_plane_ft: 700 }),
        // Sparse airborne evidence alone is deliberately inconclusive.
        sample(300, { ra_ft: 0, on_ground: false, vs_fpm: -74, alt_plane_ft: 700 }),
        sample(500, { ra_ft: 0, on_ground: true, vs_fpm: -20, alt_plane_ft: 700 }),
        // The live runner receives the impact load on a later ground SAMPLE.
        sample(600, { ra_ft: 0, on_ground: true, vs_fpm: -20, g_force: 1.4, alt_plane_ft: 700 }),
      ]);

      assert(result.success === true, `expected success, got ${result.error}`);
      const landings = result.timeline.events.filter((event) => event.type === 'landing');
      assert(landings.length === 1, `expected one landing event, got ${landings.length}`);
      assert(landings[0].bounceCount === 1, `expected one delayed replay bounce, got ${landings[0].bounceCount}`);
      assert(
        landings[0].touchdownDistance?.bounceCount === 1,
        `expected one nested delayed replay bounce, got ${landings[0].touchdownDistance?.bounceCount}`,
      );
    });
  });

  await testAsync('authoritative bounce-only LANDING row survives without touchdown distance', async () => {
    await withMockRunway(null, async (timelineGenerator) => {
      const baseTs = 1700000206750;
      const sample = (offsetMs, overrides = {}) => ({
        flight_id: 'bounce-only-landing-row',
        timestamp_utc: new Date(baseTs + offsetMs).toISOString(),
        ts: baseTs + offsetMs,
        flight_elapsed_ms: offsetMs,
        record_type: 'SAMPLE',
        phase: 'APPROACH',
        lat_deg: 37.001,
        lon_deg: -122,
        ra_ft: 50,
        on_ground: false,
        ias_kts: 130,
        vs_fpm: -500,
        g_force: 1,
        gs_kts: 120,
        hdg_true_deg: 360,
        alt_msl_ft: 750,
        alt_plane_ft: 750,
        aircraft: 'A320',
        ...overrides,
      });
      const result = timelineGenerator._generateTimelineFromRows('bounce-only-landing-row.csv', [
        sample(0),
        sample(1000, { ra_ft: 0, on_ground: true, vs_fpm: -180, alt_plane_ft: 700 }),
        {
          ...sample(2000, { ra_ft: 0, on_ground: true, vs_fpm: -180, alt_plane_ft: 700 }),
          record_type: 'LANDING',
          grade: 'GOOD',
          touchdown_distance_ft: null,
          bounce_count: 1,
          bounce_grade: 'Minor',
          bounce_score: 88,
          bounce_distance_ft: 12,
          bounce_worst_gforce: 1.4,
        },
      ]);

      assert(result.success === true, `expected success, got ${result.error}`);
      const landings = result.timeline.events.filter((event) => event.type === 'landing');
      assert(landings.length === 1, `expected one merged landing event, got ${landings.length}`);
      const landing = landings[0];
      assert(landing.bounceCount === 1, `expected authoritative top-level bounce count 1, got ${landing.bounceCount}`);
      assert(landing.touchdownDistance, 'expected bounce-only touchdownDistance payload');
      assert(landing.touchdownDistance.distanceFt == null, `expected no fabricated distance, got ${landing.touchdownDistance.distanceFt}`);
      assert(landing.touchdownDistance.bounceCount === 1, `expected nested bounce count 1, got ${landing.touchdownDistance.bounceCount}`);
      assert(landing.touchdownDistance.bounceScore === 88, `expected bounce score 88, got ${landing.touchdownDistance.bounceScore}`);
      assert(!Object.prototype.hasOwnProperty.call(landing, '_landingRowMerged'), 'expected replay merge marker to stay internal');
    });
  });

  await testAsync('continuous airborne cooldown starts a new replay landing without GO_AROUND', async () => {
    await withMockRunway({
      icao: 'TEST',
      airportName: 'Test Field',
      runway: '36',
      runwayId: '36',
      threshold: { lat: 37, lon: -122 },
      heading: 360,
      lengthFt: 6000,
      widthFt: 150,
      surface: 'ASPHALT',
      elevation_ft: 700,
    }, async (timelineGenerator) => {
      const baseTs = 1700000206900;
      const sample = (offsetMs, overrides = {}) => ({
        flight_id: 'continuous-airborne-rearm',
        timestamp_utc: new Date(baseTs + offsetMs).toISOString(),
        ts: baseTs + offsetMs,
        flight_elapsed_ms: offsetMs,
        record_type: 'SAMPLE',
        phase: 'APPROACH',
        lat_deg: 37.001,
        lon_deg: -122,
        ra_ft: 100,
        on_ground: false,
        ias_kts: 130,
        vs_fpm: -500,
        g_force: 1,
        gs_kts: 120,
        hdg_true_deg: 360,
        alt_msl_ft: 800,
        alt_plane_ft: 800,
        aircraft: 'A320',
        ...overrides,
      });
      const result = timelineGenerator._generateTimelineFromRows('continuous-airborne-rearm.csv', [
        sample(0),
        sample(1000, { ra_ft: 0, on_ground: true, vs_fpm: -180, alt_plane_ft: 700 }),
        sample(2000, { ra_ft: 100, on_ground: false, vs_fpm: 500, alt_plane_ft: 800 }),
        // Six continuous seconds airborne re-arms the live landing runner.
        sample(8000, { ra_ft: 100, on_ground: false, vs_fpm: -300, alt_plane_ft: 800 }),
        sample(8100, { ra_ft: 0, on_ground: true, vs_fpm: -180, alt_plane_ft: 700 }),
      ]);

      assert(result.success === true, `expected success, got ${result.error}`);
      const landings = result.timeline.events.filter((event) => event.type === 'landing');
      assert(landings.length === 2, `expected two landing attempts, got ${landings.length}`);
      assert((landings[0].bounceCount || 0) === 0, `expected no first-attempt bounce, got ${landings[0].bounceCount}`);
      assert((landings[1].bounceCount || 0) === 0, `expected no second-attempt bounce, got ${landings[1].bounceCount}`);
    });
  });

  await testAsync('go-around attempt owns its bounce and LANDING row merge', async () => {
    await withMockRunway({
      icao: 'TEST',
      airportName: 'Test Field',
      runway: '36',
      runwayId: '36',
      threshold: { lat: 37, lon: -122 },
      heading: 360,
      lengthFt: 6000,
      widthFt: 150,
      surface: 'ASPHALT',
      elevation_ft: 700,
    }, async (timelineGenerator) => {
      const baseTs = 1700000206950;
      const sample = (offsetMs, overrides = {}) => ({
        flight_id: 'current-attempt-landing-owner',
        timestamp_utc: new Date(baseTs + offsetMs).toISOString(),
        ts: baseTs + offsetMs,
        flight_elapsed_ms: offsetMs,
        record_type: 'SAMPLE',
        phase: 'APPROACH',
        lat_deg: 37.001,
        lon_deg: -122,
        ra_ft: 100,
        on_ground: false,
        ias_kts: 130,
        vs_fpm: -500,
        g_force: 1,
        gs_kts: 120,
        hdg_true_deg: 360,
        alt_msl_ft: 800,
        alt_plane_ft: 800,
        aircraft: 'A320',
        ...overrides,
      });
      const result = timelineGenerator._generateTimelineFromRows('current-attempt-landing-owner.csv', [
        sample(0),
        sample(1000, { ra_ft: 0, on_ground: true, vs_fpm: -180, alt_plane_ft: 700 }),
        {
          ...sample(2000, { ra_ft: 100, on_ground: false, vs_fpm: 1000, alt_plane_ft: 800 }),
          record_type: 'GO_AROUND',
          phase: 'GO_AROUND',
          goaround_altitude_ft: 100,
          previous_phase: 'LANDING',
        },
        sample(2500, { ra_ft: 100, on_ground: false, vs_fpm: -300, alt_plane_ft: 800 }),
        sample(8000, { ra_ft: 0, on_ground: true, vs_fpm: -180, alt_plane_ft: 700 }),
        sample(8200, { ra_ft: 4, on_ground: false, vs_fpm: 80, alt_plane_ft: 703 }),
        sample(8500, { ra_ft: 0, on_ground: true, vs_fpm: -60, alt_plane_ft: 700 }),
        {
          ...sample(9000, { ra_ft: 0, on_ground: true, vs_fpm: -180, alt_plane_ft: 700 }),
          record_type: 'LANDING',
          icao: 'TEST',
          runway: '36',
          grade: 'VERY HARD',
          touchdown_distance_ft: 2222,
          bounce_count: 1,
        },
      ]);

      assert(result.success === true, `expected success, got ${result.error}`);
      const landings = result.timeline.events.filter((event) => event.type === 'landing');
      assert(landings.length === 2, `expected two landing attempts, got ${landings.length}`);
      assert((landings[0].bounceCount || 0) === 0, `expected first attempt to remain bounce-free, got ${landings[0].bounceCount}`);
      assert(landings[0].grade !== 'VERY HARD', 'expected first attempt to remain unmerged');
      assert(landings[1].bounceCount === 1, `expected second attempt to own its bounce, got ${landings[1].bounceCount}`);
      assert(landings[1].touchdownDistance?.bounceCount === 1, 'expected second attempt nested bounce count 1');
      assert(landings[1].grade === 'GOOD', `expected conventional V/S to replace the stale LANDING row grade, got ${landings[1].grade}`);
      assert(landings[1].touchdownDistance?.distanceFt === 2222, `expected LANDING row distance 2222, got ${landings[1].touchdownDistance?.distanceFt}`);
      assert(!landings.some((landing) => Object.prototype.hasOwnProperty.call(landing, '_landingRowMerged')), 'expected no internal merge markers in output');
    });
  });

  await testAsync('explicit go-around starts a new landing sequence inside the bounce window', async () => {
    await withMockRunway({
      icao: 'TEST',
      airportName: 'Test Field',
      runway: '36',
      runwayId: '36',
      threshold: { lat: 37, lon: -122 },
      heading: 360,
      lengthFt: 6000,
      widthFt: 150,
      surface: 'ASPHALT',
      elevation_ft: 700,
    }, async (timelineGenerator) => {
      const baseTs = 1700000207000;
      const sample = (offsetMs, overrides = {}) => ({
        flight_id: 'go-around-bounce-boundary',
        timestamp_utc: new Date(baseTs + offsetMs).toISOString(),
        ts: baseTs + offsetMs,
        flight_elapsed_ms: offsetMs,
        record_type: 'SAMPLE',
        phase: 'APPROACH',
        lat_deg: 37.001,
        lon_deg: -122,
        ra_ft: 100,
        on_ground: false,
        ias_kts: 130,
        vs_fpm: -500,
        g_force: 1.05,
        gs_kts: 120,
        hdg_true_deg: 360,
        alt_msl_ft: 800,
        alt_plane_ft: 800,
        aircraft: 'A320',
        ...overrides,
      });
      const result = timelineGenerator._generateTimelineFromRows('go-around-bounce-boundary.csv', [
        sample(0),
        sample(1000, { ra_ft: 0, on_ground: true, vs_fpm: -180, alt_plane_ft: 700 }),
        {
          ...sample(2000, { ra_ft: 100, on_ground: false, vs_fpm: 1000, alt_plane_ft: 800 }),
          record_type: 'GO_AROUND',
          phase: 'GO_AROUND',
          goaround_altitude_ft: 100,
          previous_phase: 'LANDING',
        },
        sample(2200, { ra_ft: 100, on_ground: false, vs_fpm: -300, alt_plane_ft: 800 }),
        // Still less than ten seconds after the first touchdown. The explicit
        // attempt boundary must make this a second landing, not a bounce.
        sample(8000, { ra_ft: 0, on_ground: true, vs_fpm: -180, alt_plane_ft: 700 }),
      ]);

      assert(result.success === true, `expected success, got ${result.error}`);
      const landings = result.timeline.events.filter((event) => event.type === 'landing');
      assert(landings.length === 2, `expected two landing events, got ${landings.length}`);
      assert(landings[0].touchdownNumber === 1, `expected first touchdown number 1, got ${landings[0].touchdownNumber}`);
      assert(landings[1].touchdownNumber === 2, `expected second touchdown number 2, got ${landings[1].touchdownNumber}`);
      assert((landings[0].bounceCount || 0) === 0, `expected no first-landing bounce, got ${landings[0].bounceCount}`);
      assert((landings[1].bounceCount || 0) === 0, `expected no second-landing bounce, got ${landings[1].bounceCount}`);
      assert(
        result.timeline.events.some((event) => event.markerType === 'go_around'),
        'expected the explicit go-around marker to remain present',
      );
    });
  });

  await testAsync('replay reconstructs separate rollout-control analysis from sample rows', async () => {
    const runway = {
      icao: 'TEST',
      airportName: 'Test Field',
      runway: '36',
      runwayId: '36',
      threshold: { lat: 37, lon: -122 },
      heading: 360,
      lengthFt: 6000,
      widthFt: 150,
      surface: 'ASPHALT',
      elevation_ft: 700,
    };
    await withMockRunway(runway, async (timelineGenerator) => {
      const baseTs = 1700000200000;
      const sample = (offsetMs, overrides = {}) => ({
        flight_id: 'rollout-replay',
        timestamp_utc: new Date(baseTs + offsetMs).toISOString(),
        ts: baseTs + offsetMs,
        flight_elapsed_ms: offsetMs,
        record_type: 'SAMPLE',
        phase: 'APPROACH',
        lat_deg: 37.001,
        lon_deg: -122,
        ra_ft: 100,
        on_ground: false,
        surface_on_runway: true,
        ias_kts: 140,
        vs_fpm: -600,
        g_force: 1.1,
        gs_kts: 140,
        bank_deg: 0,
        hdg_true_deg: 360,
        alt_msl_ft: 900,
        aircraft: 'A320',
        ...overrides,
      });
      const result = timelineGenerator._generateTimelineFromRows('rollout-replay.csv', [
        sample(0),
        sample(1000, { on_ground: true, gs_kts: 136, bank_deg: -0.3, ra_ft: 5, alt_msl_ft: 800 }),
        sample(1500, {
          on_ground: true,
          gs_kts: 134,
          bank_deg: 0.8,
          roll_rate_rad_s: 5.2 * (Math.PI / 180),
          hdg_true_deg: 2,
          ra_ft: 0,
          alt_msl_ft: 800,
        }),
        sample(2000, {
          on_ground: true,
          gs_kts: 131,
          bank_deg: 3.3,
          roll_rate_rad_s: 5.4 * (Math.PI / 180),
          hdg_true_deg: 15,
          lon_deg: -121.99999,
          ra_ft: 0,
          alt_msl_ft: 800,
        }),
        sample(2500, {
          on_ground: true,
          gs_kts: 115,
          bank_deg: 2,
          hdg_true_deg: 14,
          lon_deg: -121.99999,
          ra_ft: 0,
          alt_msl_ft: 800,
        }),
        sample(3000, {
          on_ground: true,
          surface_on_runway: false,
          gs_kts: 80,
          bank_deg: 0,
          hdg_true_deg: 5,
          ra_ft: 0,
          alt_msl_ft: 800,
        }),
      ]);

      assert(result.success === true, `expected success, got ${result.error}`);
      const landing = result.timeline.events.find((event) => event.type === 'landing');
      assert(landing?.rolloutAnalysis, 'expected replay landing to include rollout analysis');
      assert(landing.rolloutAnalysis.schemaVersion === 2, `expected rollout schema v2, got ${landing.rolloutAnalysis.schemaVersion}`);
      assert(landing.rolloutAnalysis.assessment === 'caution', `expected rollout caution, got ${landing.rolloutAnalysis.assessment}`);
      assert(landing.rolloutAnalysis.maxBankDeg === 3.3, `expected 3.3 deg peak bank, got ${landing.rolloutAnalysis.maxBankDeg}`);
      assert(landing.rolloutAnalysis.maxHeadingDeviationDeg === 15, `expected 15 deg heading deviation, got ${landing.rolloutAnalysis.maxHeadingDeviationDeg}`);
      assert(
        landing.rolloutAnalysis.flags.some((flag) => flag.code === 'rapid_bank_change'),
        'expected replay analysis to flag the abrupt bank correction',
      );
    });
  });

  await testAsync('replay ends rollout-control analysis at raw taxi-in speed before the exit turn', async () => {
    const runway = {
      icao: 'TEST',
      airportName: 'Test Field',
      runway: '36',
      runwayId: '36',
      threshold: { lat: 37, lon: -122 },
      heading: 360,
      lengthFt: 6000,
      widthFt: 150,
      surface: 'ASPHALT',
      elevation_ft: 700,
    };
    await withMockRunway(runway, async (timelineGenerator) => {
      const baseTs = 1700000204000;
      const sample = (offsetMs, overrides = {}) => ({
        flight_id: 'rollout-speed-boundary',
        timestamp_utc: new Date(baseTs + offsetMs).toISOString(),
        ts: baseTs + offsetMs,
        flight_elapsed_ms: offsetMs,
        record_type: 'SAMPLE',
        phase: 'APPROACH',
        lat_deg: 37.001,
        lon_deg: -122,
        ra_ft: 100,
        on_ground: false,
        surface_on_runway: true,
        ias_kts: 140,
        vs_fpm: -600,
        g_force: 1.1,
        gs_kts: 140,
        bank_deg: 0,
        roll_rate_rad_s: 0,
        hdg_true_deg: 360,
        alt_msl_ft: 900,
        aircraft: 'A320',
        aircraft_profile_id: 'generic',
        ...overrides,
      });
      const result = timelineGenerator._generateTimelineFromRows('rollout-speed-boundary.csv', [
        sample(0),
        sample(1000, {
          phase: 'LANDING',
          on_ground: true,
          gs_kts: 132,
          bank_deg: 0.2,
          ra_ft: 5,
          alt_msl_ft: 800,
        }),
        sample(1500, {
          phase: 'LANDING',
          on_ground: true,
          gs_kts: 90,
          bank_deg: 0.3,
          hdg_true_deg: 0.5,
          ra_ft: 0,
          alt_msl_ft: 800,
        }),
        sample(2000, {
          phase: 'LANDING',
          on_ground: true,
          gs_kts: 60.1,
          bank_deg: 0.2,
          hdg_true_deg: 1,
          ra_ft: 0,
          alt_msl_ft: 800,
        }),
        sample(2500, {
          phase: 'LANDING',
          on_ground: true,
          gs_kts: 59.9,
          bank_deg: 8,
          hdg_true_deg: 20,
          lon_deg: -121.9997,
          ra_ft: 0,
          alt_msl_ft: 800,
        }),
        sample(3000, {
          phase: 'TAXI-IN',
          on_ground: true,
          surface_on_runway: false,
          gs_kts: 45,
          bank_deg: 10,
          hdg_true_deg: 30,
          lon_deg: -121.9995,
          ra_ft: 0,
          alt_msl_ft: 800,
        }),
      ]);

      assert(result.success === true, `expected success, got ${result.error}`);
      const landing = result.timeline.events.find((event) => event.type === 'landing');
      assert(landing?.rolloutAnalysis, 'expected replay landing to include rollout analysis');
      assert(landing.rolloutAnalysis.endGsKts === 60.1, `expected 60.1 kt scoring end, got ${landing.rolloutAnalysis.endGsKts}`);
      assert(landing.rolloutAnalysis.maxHeadingDeviationDeg === 1, `expected 1 deg peak heading deviation, got ${landing.rolloutAnalysis.maxHeadingDeviationDeg}`);
      assert(landing.rolloutAnalysis.maxBankDeg === 0.3, `expected 0.3 deg peak bank, got ${landing.rolloutAnalysis.maxBankDeg}`);
      assert(landing.rolloutAnalysis.assessment === 'normal', `expected normal rollout, got ${landing.rolloutAnalysis.assessment}`);
    });
  });

  await testAsync('replay resumes landing analysis after an ordinary telemetry gap', async () => {
    const runway = {
      icao: 'TEST',
      airportName: 'Test Field',
      runway: '36',
      runwayId: '36',
      threshold: { lat: 37, lon: -122 },
      heading: 360,
      lengthFt: 6000,
      widthFt: 150,
      surface: 'ASPHALT',
      elevation_ft: 700,
    };
    await withMockRunway(runway, async (timelineGenerator) => {
      const baseTs = 1700000205000;
      const touchdownLat = 37 + (2000 / 364567);
      const sample = (offsetMs, overrides = {}) => ({
        flight_id: 'gap-replay',
        timestamp_utc: new Date(baseTs + offsetMs).toISOString(),
        ts: baseTs + offsetMs,
        flight_elapsed_ms: offsetMs,
        record_type: 'SAMPLE',
        phase: 'APPROACH',
        lat_deg: touchdownLat - 0.001,
        lon_deg: -122,
        ra_ft: 100,
        on_ground: false,
        ias_kts: 140,
        vs_fpm: -700,
        g_force: 1.1,
        gs_kts: 140,
        hdg_true_deg: 360,
        alt_msl_ft: 900,
        aircraft: 'A320',
        ...overrides,
      });
      const result = timelineGenerator._generateTimelineFromRows('gap-replay.csv', [
        sample(0, { phase: 'TAXI', on_ground: true, ra_ft: 0, ias_kts: 0, vs_fpm: 0, gs_kts: 0 }),
        sample(31_001),
        sample(32_001, {
          lat_deg: touchdownLat,
          ra_ft: 5,
          on_ground: true,
          ias_kts: 130,
          vs_fpm: -500,
          gs_kts: 120,
        }),
      ]);

      assert(result.success === true, `expected success, got ${result.error}`);
      const landings = result.timeline.events.filter((event) => event.type === 'landing');
      assert(landings.length === 1, `expected one landing after the gap, got ${landings.length}`);
      assert(landings[0].touchdownDistance?.tdzAchieved === true, 'generated replay should retain the formal 3,000 ft TDZ result');
    });
  });

  await testAsync('a prior crash remains terminal across a later telemetry gap', async () => {
    await withMockRunway({
      icao: 'TEST',
      airportName: 'Test Field',
      runway: '36',
      runwayId: '36',
      threshold: { lat: 37, lon: -122 },
      heading: 360,
      lengthFt: 6000,
      widthFt: 150,
      surface: 'ASPHALT',
      elevation_ft: 700,
    }, async (timelineGenerator) => {
      const baseTs = 1700000208000;
      const common = {
        flight_id: 'crash-gap-replay',
        phase: 'APPROACH',
        lon_deg: -122,
        ias_kts: 130,
        vs_fpm: -500,
        g_force: 1.1,
        gs_kts: 120,
        hdg_true_deg: 360,
        alt_msl_ft: 900,
        aircraft: 'A320',
      };
      const result = timelineGenerator._generateTimelineFromRows('crash-gap-replay.csv', [
        {
          ...common,
          timestamp_utc: new Date(baseTs).toISOString(),
          ts: baseTs,
          flight_elapsed_ms: 0,
          record_type: 'CRASH',
          lat_deg: 37,
          ra_ft: 100,
          on_ground: false,
        },
        {
          ...common,
          timestamp_utc: new Date(baseTs + 31_001).toISOString(),
          ts: baseTs + 31_001,
          flight_elapsed_ms: 31_001,
          record_type: 'SAMPLE',
          lat_deg: 37.004,
          ra_ft: 100,
          on_ground: false,
        },
        {
          ...common,
          timestamp_utc: new Date(baseTs + 32_001).toISOString(),
          ts: baseTs + 32_001,
          flight_elapsed_ms: 32_001,
          record_type: 'SAMPLE',
          lat_deg: 37.005,
          ra_ft: 5,
          on_ground: true,
        },
      ]);

      assert(result.success === true, `expected success, got ${result.error}`);
      const landings = result.timeline.events.filter((event) => event.type === 'landing');
      assert(landings.length === 0, 'a crash should remain terminal even when later rows contain a timestamp gap');
    });
  });

  await testAsync('paused replay samples do not trigger landing or enter approach scoring', async () => {
    await withMockRunway({
      icao: 'TEST',
      airportName: 'Test Field',
      runway: '36',
      runwayId: '36',
      threshold: { lat: 37, lon: -122 },
      heading: 360,
      lengthFt: 6000,
      widthFt: 150,
      surface: 'ASPHALT',
      elevation_ft: 700,
    }, async (timelineGenerator) => {
      const baseTs = 1700000210000;
      const sample = (offsetMs, overrides = {}) => ({
        flight_id: 'paused-replay',
        timestamp_utc: new Date(baseTs + offsetMs).toISOString(),
        ts: baseTs + offsetMs,
        flight_elapsed_ms: offsetMs,
        record_type: 'SAMPLE',
        phase: 'APPROACH',
        lat_deg: 36.9990,
        lon_deg: -122,
        ra_ft: 100,
        on_ground: false,
        ias_kts: 140,
        vs_fpm: -700,
        g_force: 1.1,
        gs_kts: 140,
        hdg_true_deg: 360,
        alt_msl_ft: 900,
        aircraft: 'A320',
        sim_paused: false,
        sim_in_menu: false,
        ...overrides,
      });
      const pausedTs = baseTs + 500;
      const actualTouchdownTs = baseTs + 1500;
      const result = timelineGenerator._generateTimelineFromRows('paused-replay.csv', [
        sample(0),
        sample(500, {
          lat_deg: 36.9995,
          ra_ft: 5,
          on_ground: true,
          ias_kts: 135,
          vs_fpm: -650,
          sim_paused: true,
        }),
        sample(1500, {
          lat_deg: 36.9998,
          ra_ft: 5,
          on_ground: true,
          ias_kts: 130,
          vs_fpm: -500,
        }),
      ]);

      assert(result.success === true, `expected success, got ${result.error}`);
      const landings = result.timeline.events.filter((event) => event.type === 'landing');
      assert(landings.length === 1, `expected one landing event, got ${landings.length}`);
      assert(landings[0].timestampMs === actualTouchdownTs, `expected landing at ${actualTouchdownTs}, got ${landings[0].timestampMs}`);
      const sampleAbsTimes = landings[0].approachProfile
        .map((samplePoint) => samplePoint.absMs)
        .filter((value) => Number.isFinite(value));
      assert(!sampleAbsTimes.includes(pausedTs), 'paused sample should not enter approach profile');
      const finalProfileSample = landings[0].approachProfile.at(-1);
      assert(finalProfileSample.dtMs === 500, `expected profile dt to exclude paused time, got ${finalProfileSample.dtMs}`);
    });
  });

  await testAsync('missing on_ground sample does not synthesize touchdown transition', async () => {
    const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'missing-on-ground-'));
    const csvPath = path.join(tmpDir, 'missing-on-ground.csv');
    const baseTs = 1700000050000;
    const headers = [
      'flight_id',
      'timestamp_utc',
      'ts',
      'flight_elapsed_ms',
      'record_type',
      'phase',
      'lat_deg',
      'lon_deg',
      'ra_ft',
      'on_ground',
      'ias_kts',
      'vs_fpm',
      'g_force',
      'gs_kts',
      'hdg_true_deg',
      'alt_msl_ft',
      'aircraft',
    ];
    const rows = [
      ['missing-wow', new Date(baseTs).toISOString(), baseTs, 0, 'SAMPLE', 'APPROACH', 36.9990, -122, 100, '', 140, -700, 1.1, 140, 360, 900, 'A320'],
      ['missing-wow', new Date(baseTs + 1000).toISOString(), baseTs + 1000, 1000, 'SAMPLE', 'APPROACH', 36.9998, -122, 5, 'true', 130, -500, 1.1, 120, 360, 800, 'A320'],
    ];

    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');

    try {
      await withMockRunway({
        icao: 'TEST',
        airportName: 'Test Field',
        runway: '36',
        runwayId: '36',
        threshold: { lat: 37, lon: -122 },
        heading: 360,
        lengthFt: 6000,
        widthFt: 150,
        surface: 'ASPHALT',
        elevation_ft: 700,
      }, async (timelineGenerator) => {
        const result = await timelineGenerator.generateFromCSV(csvPath);
        assert(result.success === true, `expected success, got ${result.error}`);
        const landings = result.timeline.events.filter((event) => event.type === 'landing');
        assert(landings.length === 0, `expected no landing events, got ${landings.length}`);
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('GO_AROUND event resets replay approach samples before next landing', async () => {
    const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'go-around-reset-'));
    const csvPath = path.join(tmpDir, 'go-around-reset.csv');
    const baseTs = 1700000070000;
    const headers = [
      'flight_id',
      'timestamp_utc',
      'ts',
      'flight_elapsed_ms',
      'record_type',
      'phase',
      'lat_deg',
      'lon_deg',
      'ra_ft',
      'on_ground',
      'ias_kts',
      'vs_fpm',
      'gs_kts',
      'hdg_true_deg',
      'alt_msl_ft',
      'aircraft',
      'goaround_altitude_ft',
      'previous_phase',
    ];
    const rows = [
      ['goaround-test', new Date(baseTs).toISOString(), baseTs, 0, 'SAMPLE', 'APPROACH', 36.9900, -122, 1200, 'false', 145, -700, 145, 360, 1900, 'A320', '', ''],
      ['goaround-test', new Date(baseTs + 1000).toISOString(), baseTs + 1000, 1000, 'SAMPLE', 'APPROACH', 36.9920, -122, 900, 'false', 145, -650, 145, 360, 1600, 'A320', '', ''],
      ['goaround-test', new Date(baseTs + 2000).toISOString(), baseTs + 2000, 2000, 'GO_AROUND', 'GO_AROUND', 36.9940, -122, 100, 'false', 145, 1200, 145, 360, 1100, 'A320', 100, 'APPROACH'],
      ['goaround-test', new Date(baseTs + 3000).toISOString(), baseTs + 3000, 3000, 'SAMPLE', 'APPROACH', 36.9960, -122, 900, 'false', 140, -650, 140, 360, 1600, 'A320', '', ''],
      ['goaround-test', new Date(baseTs + 4000).toISOString(), baseTs + 4000, 4000, 'SAMPLE', 'APPROACH', 36.9980, -122, 100, 'false', 135, -600, 135, 360, 900, 'A320', '', ''],
      ['goaround-test', new Date(baseTs + 5000).toISOString(), baseTs + 5000, 5000, 'SAMPLE', 'APPROACH', 37.0000, -122, 5, 'true', 130, -450, 120, 360, 805, 'A320', '', ''],
    ];

    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');

    try {
      await withMockRunway({
        icao: 'TEST',
        airportName: 'Test Field',
        runway: '36',
        runwayId: '36',
        threshold: { lat: 37, lon: -122 },
        heading: 360,
        lengthFt: 6000,
        widthFt: 150,
        surface: 'ASPHALT',
        elevation_ft: 700,
      }, async (timelineGenerator) => {
        const result = await timelineGenerator.generateFromCSV(csvPath);
        assert(result.success === true, `expected success, got ${result.error}`);
        const goAround = result.timeline.events.find((event) => event.markerType === 'go_around');
        assert(goAround, 'expected GO_AROUND marker');
        const lateGoAround = result.timeline.events.find((event) => event.ruleId === VIOLATION_RULE.LATE_GO_AROUND);
        assert(lateGoAround, 'expected late_go_around violation');
        const landing = result.timeline.events.find((event) => event.type === 'landing');
        assert(landing, 'expected landing event after go-around');
        assert(Array.isArray(landing.approachProfile), 'expected approachProfile');
        const sampleAbsTimes = landing.approachProfile
          .map((sample) => sample.absMs)
          .filter((value) => Number.isFinite(value));
        assert(sampleAbsTimes.length > 0, 'expected approach profile timestamps');
        const firstProfileTs = Math.min(...sampleAbsTimes);
        assert(firstProfileTs >= baseTs + 3000, `expected profile reset after go-around, first sample was ${firstProfileTs}`);
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('LANDING row merge preserves touchdown geometry diagnostics', async () => {
    const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'landing-geometry-'));
    const csvPath = path.join(tmpDir, 'landing-geometry.csv');
    const baseTs = 1700000100000;
    const headers = [
      'flight_id',
      'timestamp_utc',
      'ts',
      'flight_elapsed_ms',
      'record_type',
      'phase',
      'lat_deg',
      'lon_deg',
      'ra_ft',
      'on_ground',
      'ias_kts',
      'vs_fpm',
      'g_force',
      'gs_kts',
      'hdg_true_deg',
      'alt_msl_ft',
      'aircraft',
      'grade',
      'touchdown_distance_ft',
      'touchdown_distance_score',
      'touchdown_distance_grade',
      'runway_geometry_source',
      'runway_heading_true_deg',
      'runway_length_ft',
      'runway_physical_length_ft',
      'runway_surface',
      'runway_threshold_lat',
      'runway_threshold_lon',
      'runway_physical_threshold_lat',
      'runway_physical_threshold_lon',
      'runway_displaced_threshold_ft',
      'short_landing',
      'runway_condition',
      'runway_condition_source',
      'runway_condition_confident',
      'lateral_offset_ft',
      'lateral_offset_side',
      'lateral_offset_score',
      'lateral_offset_grade',
      'lateral_offset_suspect',
      'runway_width_ft',
      'bounce_count',
      'bounce_grade',
      'bounce_score',
      'icao',
      'runway',
    ];
    const samplePadding = Array(headers.length - 17).fill('');
    const rows = [
      ['merge-test', new Date(baseTs).toISOString(), baseTs, 0, 'SAMPLE', 'APPROACH', 37.0000, -122, 100, 'false', 140, -700, 1.1, 140, 360, 900, 'A320', ...samplePadding],
      ['merge-test', new Date(baseTs + 1000).toISOString(), baseTs + 1000, 1000, 'SAMPLE', 'APPROACH', 37.0010, -122, 5, 'true', 130, -500, 1.1, 120, 360, 800, 'A320', ...samplePadding],
      ['merge-test', new Date(baseTs + 1500).toISOString(), baseTs + 1500, 1500, 'LANDING', 'LANDING', 37.0010, -122, 0, 'true', 125, -420, 1.35, 118, 360, 790, 'A320', 'Good', 1234, 88, 'Good', 'ourairports', 360, 6000, 7000, 'ASPHALT', 37, -122, 36.99, -122, 1000, 0, 'wet', 'inferred', 0, 42, 'right', 85, 'Marginal', 0, 150, 2, 'Multiple Bounces', 80, 'TEST', '35'],
    ];

    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');

    try {
      await withMockRunway({
        icao: 'TEST',
        airportName: 'Test Field',
        runway: '36',
        runwayId: '36',
        threshold: { lat: 37, lon: -122 },
        heading: 360,
        lengthFt: 6000,
        widthFt: 150,
        surface: 'ASPHALT',
        elevation_ft: 700,
      }, async (timelineGenerator) => {
        const result = await timelineGenerator.generateFromCSV(csvPath);
        assert(result.success === true, `expected success, got ${result.error}`);
        const landing = result.timeline.events.find((event) => event.type === 'landing');
        assert(landing, 'expected landing event');
        assert(landing.touchdownDistance, 'expected touchdownDistance');
        assert(landing.touchdownDistance.distanceFt === 1234, `expected LANDING distance, got ${landing.touchdownDistance.distanceFt}`);
        assert(landing.touchdownDistance.score === 88, `expected LANDING score, got ${landing.touchdownDistance.score}`);
        assert(landing.touchdownDistance.shortLanding === false, 'expected shortLanding false from LANDING row');
        assert(landing.touchdownDistance.tdzAchieved === true, 'expected LANDING row distance inside 3,000 ft to preserve TDZ achieved');
        assert(landing.touchdownDistance.runway_condition === 'wet', `expected runway condition wet, got ${landing.touchdownDistance.runway_condition}`);
        assert(landing.touchdownDistance.runway_condition_source === 'inferred', 'expected inferred condition source');
        assert(landing.touchdownDistance.runway_condition_confident === false, 'expected condition confidence false');
        assert(landing.touchdownDistance.lateralOffsetFt === 42, `expected lateral offset 42, got ${landing.touchdownDistance.lateralOffsetFt}`);
        assert(landing.touchdownDistance.lateralOffsetSide === 'right', `expected lateral side right, got ${landing.touchdownDistance.lateralOffsetSide}`);
        assert(landing.touchdownDistance.lateralOffsetScore === 85, `expected lateral score 85, got ${landing.touchdownDistance.lateralOffsetScore}`);
        assert(landing.touchdownDistance.lateralOffsetGrade === 'Marginal', `expected lateral grade Marginal, got ${landing.touchdownDistance.lateralOffsetGrade}`);
        assert(landing.touchdownDistance.runwayWidthFt === 150, `expected runway width 150, got ${landing.touchdownDistance.runwayWidthFt}`);
        assert(landing.touchdownDistance.runwayGeometrySource === 'ourairports', `expected geometry source, got ${landing.touchdownDistance.runwayGeometrySource}`);
        assert(landing.touchdownDistance.runwayHeadingTrueDeg === 360, `expected runway heading 360, got ${landing.touchdownDistance.runwayHeadingTrueDeg}`);
        assert(landing.touchdownDistance.runwayPhysicalLengthFt === 7000, `expected physical runway length 7000, got ${landing.touchdownDistance.runwayPhysicalLengthFt}`);
        assert(landing.touchdownDistance.runwayDisplacedThresholdFt === 1000, `expected displaced threshold 1000, got ${landing.touchdownDistance.runwayDisplacedThresholdFt}`);
        assert(landing.touchdownDistance.bounceCount === 2, `expected bounce count 2, got ${landing.touchdownDistance.bounceCount}`);
        assert(landing.vs_fpm === -420, `expected finalized LANDING V/S -420, got ${landing.vs_fpm}`);
        assert(landing.gforce === 1.35, `expected LANDING g_force 1.35, got ${landing.gforce}`);
        assert(landing.runway.runway_id === '35', `expected finalized LANDING runway 35, got ${landing.runway.runway_id}`);
        assert(landing.runway.width_ft === 150, `expected finalized runway width 150, got ${landing.runway.width_ft}`);
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}

// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════════════════════');
runAsyncTests().then(() => {
if (failed === 0) {
  console.log(`✓ All ${passed} timeline-generator tests passed`);
  process.exit(0);
} else {
  console.log(`✗ ${failed} failed, ${passed} passed`);
  process.exit(1);
}
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
