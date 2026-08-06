#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { getRepoScratchPath } = require('./repo-scratch');

const tmpRoot = getRepoScratchPath('analysis-parity-appdata');
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

const fixturesPath = path.join(__dirname, '..', 'data', 'analysis-parity', 'golden-fixtures.json');
if (!fs.existsSync(fixturesPath)) {
  console.log('analysis parity tests skipped: tests/data/analysis-parity/golden-fixtures.json is not present in this checkout');
  process.exit(0);
}

const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

const analysis = require(resolveBackendRuntimeFile('analysis', 'flight-analysis.js'));
const landingDistance = require(resolveBackendRuntimeFile('landing', 'landing-distance.js'));
const { SimpleStabilityScorer, frameToSample } = require(resolveBackendRuntimeFile('stability', 'stability-runner.js'));
const sourceOverlays = require(resolveBackendRuntimeFile('telemetry-provider', 'source-overlays.js'));
const timelineGeneratorPath = resolveBackendRuntimeFile('events', 'timeline-generator.js');
const runwayDatabasePath = resolveBackendRuntimeFile('landing', 'runway-database.js');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function approx(actual, expected, tolerance = 0.001) {
  return Math.abs(actual - expected) <= tolerance;
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  OK ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL ${name}: ${err.message}`);
    failed += 1;
  }
}

function csvValue(value) {
  if (value == null) return '';
  const stringValue = String(value);
  return /[",\n\r]/.test(stringValue)
    ? `"${stringValue.replace(/"/g, '""')}"`
    : stringValue;
}

function writeFixtureCsv(fixture) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ff-analysis-${fixture.id}-`));
  const csvPath = path.join(tmpDir, `${fixture.id}.csv`);
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
    'gear_down_locked',
    'flaps_pct',
    'flaps_notch',
    'spoiler_pct',
    'spoiler_state',
    'thr1_pct',
    'thr2_pct',
    'thr3_pct',
    'thr4_pct',
    'pitch_deg',
    'bank_deg',
    'oat_c',
    'aircraft',
  ];
  const baseTs = 1770000000000;
  const lines = [headers.join(',')];
  for (const row of fixture.rows) {
    const ts = baseTs + row.elapsedMs;
    const csvRow = {
      ...row,
      flight_id: fixture.id,
      timestamp_utc: new Date(ts).toISOString(),
      ts,
      flight_elapsed_ms: row.elapsedMs,
    };
    lines.push(headers.map((header) => csvValue(csvRow[header])).join(','));
  }
  fs.writeFileSync(csvPath, lines.join('\n'), 'utf8');
  return { csvPath, tmpDir };
}

async function withMockRunway(runwayData, fn) {
  const previousTimelineGenerator = require.cache[timelineGeneratorPath];
  const previousRunwayDatabase = require.cache[runwayDatabasePath];

  delete require.cache[timelineGeneratorPath];
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

    delete require.cache[runwayDatabasePath];
    if (previousRunwayDatabase) require.cache[runwayDatabasePath] = previousRunwayDatabase;
  }
}

function replayFixture(fixture) {
  const { csvPath, tmpDir } = writeFixtureCsv(fixture);
  return withMockRunway(fixtures.runway, async (timelineGenerator) => {
    try {
      return await timelineGenerator.generateFromCSV(csvPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}

function landingEvents(timelineResult) {
  assert(timelineResult.success === true, `timeline replay failed: ${timelineResult.error}`);
  return timelineResult.timeline.events.filter((event) => event.type === 'landing');
}

async function main() {
  console.log('\nAnalysis parity guardrails');

  await test('takeoff hop fixture does not produce a replay landing', async () => {
    const fixture = fixtures.fixtures.find((item) => item.id === 'takeoff-hop-not-landing');
    const result = await replayFixture(fixture);
    assert(landingEvents(result).length === fixture.expectLandingCount, 'brief takeoff hop became a landing');
  });

  await test('unknown replay weather fails safe to wet runway scoring', async () => {
    const fixture = fixtures.fixtures.find((item) => item.id === 'wet-failsafe-touchdown');
    const result = await replayFixture(fixture);
    const landings = landingEvents(result);
    assert(landings.length === fixture.expectLandingCount, `expected one landing, got ${landings.length}`);
    const tdz = landings[0].touchdownDistance;
    assert(tdz, 'landing missing touchdownDistance');
    assert(tdz.runway_condition === fixture.expectRunwayCondition, `expected ${fixture.expectRunwayCondition}, got ${tdz.runway_condition}`);
    assert(tdz.runway_condition_source === fixture.expectRunwayConditionSource, `expected ${fixture.expectRunwayConditionSource}, got ${tdz.runway_condition_source}`);
  });

  await test('shared touchdown runway analysis matches replay touchdown fields', async () => {
    const fixture = fixtures.fixtures.find((item) => item.id === 'wet-failsafe-touchdown');
    const touchdownRow = fixture.rows[fixture.rows.length - 1];
    const sharedAnalysis = analysis.buildTouchdownRunwayAnalysis({
      runwayData: fixtures.runway,
      touchdownPoint: { lat: touchdownRow.lat_deg, lon: touchdownRow.lon_deg },
      surfaceInputs: {},
    });
    const shared = sharedAnalysis.touchdownDistanceData;
    const result = await replayFixture(fixture);
    const replay = landingEvents(result)[0].touchdownDistance;
    assert(replay.distanceFt === shared.touchdown_distance_ft, `distance drift: replay=${replay.distanceFt} shared=${shared.touchdown_distance_ft}`);
    assert(replay.lateralOffsetSide === shared.lateral_offset_side, `side drift: replay=${replay.lateralOffsetSide} shared=${shared.lateral_offset_side}`);
    assert(replay.runway_condition === shared.runway_condition, `surface drift: replay=${replay.runway_condition} shared=${shared.runway_condition}`);
    assert(replay.tdzAchieved === sharedAnalysis.tdzAchieved, `TDZ drift: replay=${replay.tdzAchieved} shared=${sharedAnalysis.tdzAchieved}`);
  });

  await test('high-elevation stability gate uses height above runway threshold', async () => {
    const fixture = fixtures.fixtures.find((item) => item.id === 'high-elevation-gate');
    const scorer = new SimpleStabilityScorer();
    for (const frame of fixture.samples) {
      const sample = frameToSample(frame);
      assert(sample, 'fixture sample failed canonical normalization');
      scorer.addSample(sample);
    }
    const result = scorer.getScore(fixtures.runway.elevation_ft);
    assert(result.gateStable === fixture.expectGateStable, `expected gateStable=${fixture.expectGateStable}, got ${result.gateStable}`);
    assert(result.score !== null, 'expected a computed stability score');
  });

  await test('downsampled approach dtMs sums to kept elapsed time', async () => {
    const samples = Array.from({ length: 10 }, (_, index) => ({ tMs: index * 1000, gsKts: 120, raFt: 1000 - index * 90 }));
    const downsampled = analysis.downsampleTimedSamples(samples, 5);
    const totalDt = downsampled.reduce((sum, sample) => sum + (sample.dtMs || 0), 0);
    assert(downsampled.length === 5, `expected five samples, got ${downsampled.length}`);
    assert(totalDt === 9000, `expected 9000ms total kept gap, got ${totalDt}`);
  });

  await test('right-of-centerline geometry stays right after projection', async () => {
    const threshold = fixtures.runway.threshold;
    const rightPoint = { lat: threshold.lat + 0.001, lon: threshold.lon + 0.0002 };
    const projected = analysis.projectPointToRunwayFeet(threshold, rightPoint, fixtures.runway.heading);
    const landingOffset = landingDistance.calculateLateralOffset(threshold, rightPoint, fixtures.runway.heading);
    assert(projected.crossTrackFt > 0, `expected positive crossTrackFt, got ${projected.crossTrackFt}`);
    assert(projected.side === 'right', `expected projected right, got ${projected.side}`);
    assert(landingOffset.side === 'right', `expected landing-distance right, got ${landingOffset.side}`);
  });

  await test('MCP speed window distinguishes IAS, Mach, and blank values', async () => {
    const profile = { dataSource: { preferred: 'lvars', lvars: { mcp: { speed: 'mcp_speed' } } } };
    const baseFdm = { apSpeedTargetKts: 222, apMachTarget: 0.74 };
    const resolve = (mcpSpeed) => {
      const sourceContext = sourceOverlays.createSourceOverlayContext({
        frame: { lvars: { values: { mcp_speed: mcpSpeed } } },
        dataSourceInfo: { secondary: [{ type: 'lvar-sidecar', connected: true }] },
      });
      return sourceOverlays.resolveAutopilotSourceOverlay({ baseFdm, profile, sourceContext });
    };
    assert(resolve(245).apSpeedTargetKts === 245, 'IAS window did not map to knots');
    assert(resolve(0.78).apMachTarget === 0.78, 'Mach window did not map to Mach');
    const blank = resolve(0);
    assert(blank.apSpeedTargetKts === null, `blank speed should not become IAS, got ${blank.apSpeedTargetKts}`);
    assert(blank.apMachTarget === null, `blank speed should not become Mach, got ${blank.apMachTarget}`);
  });

  console.log(`\nAnalysis parity guardrails: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.log(`  FAIL unexpected error: ${err.stack || err.message}`);
  console.log(`\nAnalysis parity guardrails: ${passed} passed, ${failed + 1} failed`);
  process.exitCode = 1;
});
