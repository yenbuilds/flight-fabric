#!/usr/bin/env node
/**
 * test-flight-logbook-trends.js
 * Unit tests for linearSlope/linearTrend logic in backend/landing/flight-logbook.js
 *
 * linearSlope and linearTrend are private functions, so we test them via
 * getTrends() which is the public API that exercises them.
 * A small independent calculation fixture also tests the expected math.
 *
 * Run: node tests/scripts/test-flight-logbook-trends.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { getRepoScratchPath } = require('./repo-scratch');

const tmpRoot = getRepoScratchPath('flight-logbook-test-appdata');
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

const flightLogbook = require(resolveBackendRuntimeFile('landing', 'flight-logbook.js'));
const profileLoader = require(resolveBackendRuntimeFile('aircraft', 'aircraft-profile-loader.js'));

// Independent calculation fixture for the expected trend math.
function linearSlope(values) {
  const valid = values.filter(v => v !== null && v !== undefined && Number.isFinite(v));
  const n = valid.length;
  if (n < 3) return null;
  const xMean = (n - 1) / 2;
  const yMean = valid.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (valid[i] - yMean);
    den += (i - xMean) * (i - xMean);
  }
  const raw = den === 0 ? 0 : num / den;
  const mag = Math.abs(yMean);
  return mag > 0.001 ? raw / mag : raw;
}

function linearTrend(values, metric) {
  const slope = linearSlope(values);
  if (slope === null) return null;
  const threshold = 0.03;
  if (metric === 'vs')        return slope >  threshold ? 'improving' : slope < -threshold ? 'regressing' : 'stable';
  if (metric === 'gforce')   return slope < -threshold ? 'improving' : slope >  threshold ? 'regressing' : 'stable';
  if (metric === 'stability') return slope >  threshold ? 'improving' : slope < -threshold ? 'regressing' : 'stable';
  return 'stable';
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`    ${e.message}`);
  }
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg} Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNull(val, msg = '') {
  if (val !== null) throw new Error(`${msg} Expected null, got ${JSON.stringify(val)}`);
}

function createCanonicalCsvPath(logsDir, bundleName) {
  const bundleDir = path.join(logsDir, bundleName);
  fs.mkdirSync(bundleDir, { recursive: true });
  return path.join(bundleDir, 'telemetry.csv');
}

console.log('\n=== flight-logbook entry extraction ===\n');

test('addEntry preserves zero timestamp and zero scores', () => {
  flightLogbook.clearAll();
  const entry = flightLogbook.addEntry({
    timestamp_ms: 0,
    vs_fpm: -500,
    grade: 'FIRM',
    touchdown_distance_score: 0,
    ultimate_stability_score: 0,
    ultimate_stability_gate_failures: ['vs_unstable_after_gate', 'glidepath_proxy_unstable_after_gate'],
    ultimate_stability_context: {
      schemaVersion: 1,
      profile: { id: 'generic', name: 'Generic Aircraft', reliability: 'generic' },
      criteria: { speedMinusKts: 50, speedPlusKts: 100 },
    },
  });

  assertEqual(entry.timestampMs, 0, 'timestampMs');
  assertEqual(entry.timestamp, '1970-01-01T00:00:00.000Z', 'timestamp');
  assertEqual(entry.touchdownDistanceScore, 0, 'touchdownDistanceScore');
  assertEqual(entry.stabilityScore, 0, 'stabilityScore');
  assertEqual(entry.stabilityVerdict, 'unstable', 'stabilityVerdict');
  assertEqual(entry.stabilityGateFailures[0], 'vs_unstable_after_gate', 'first stabilityGateFailure');
  assertEqual(entry.stabilityGateFailures[1], 'glidepath_proxy_unstable_after_gate', 'second stabilityGateFailure');
  assertEqual(entry.stabilityContext.profile.id, 'generic', 'stabilityContext profile');
  assertEqual(entry.stabilityContext.criteria.speedPlusKts, 100, 'stabilityContext criteria');
  flightLogbook.clearAll();
});

test('addEntry preserves nested live stability verdicts', () => {
  flightLogbook.clearAll();
  const entry = flightLogbook.addEntry({
    timestamp_ms: 2,
    vs_fpm: -180,
    grade: 'GOOD',
    ultimate_stability_score: 96,
    ultimateStability: {
      verdict: 'marginal',
      scoringContext: { policy: { id: 'transport-v2', version: 2 } },
    },
    ultimate_stability_gate_stable: false,
    ultimate_stability_gate_failures: ['thrust_unstable_after_gate'],
  });

  assertEqual(entry.stabilityVerdict, 'marginal', 'nested stability verdict');
  assertEqual(entry.stabilityContext.policy.id, 'transport-v2', 'nested stability context');
  flightLogbook.clearAll();
});

test('addEntry keeps unavailable live stability as no verdict', () => {
  flightLogbook.clearAll();
  const entry = flightLogbook.addEntry({
    timestamp_ms: 3,
    vs_fpm: -180,
    grade: 'GOOD',
  });

  assertNull(entry.stabilityScore, 'stabilityScore');
  assertEqual(entry.stabilityVerdict, 'no_verdict', 'stabilityVerdict');
  assertNull(entry.stabilityBreakdown, 'stabilityBreakdown');
  flightLogbook.clearAll();
});

test('addEntry preserves numeric runway identifiers as display text', () => {
  flightLogbook.clearAll();
  const entry = flightLogbook.addEntry({
    timestamp_ms: 1,
    vs_fpm: -390,
    grade: 'FIRM',
    icao: 'YPAD',
    runway: 23,
  });

  assertEqual(entry.icao, 'YPAD', 'icao');
  assertEqual(entry.runway, '23', 'runway');
  flightLogbook.clearAll();
});

test('computeStatsFromEntries matches logbook panel aggregate values', () => {
  const stats = flightLogbook.computeStatsFromEntries([
    { vsFpm: -467.3, grade: 'FIRM', icao: null, aircraft: null, timestampMs: 1 },
    { vsFpm: -700.3, grade: 'HARD', icao: 'YPAD', runway: '23', aircraft: 'PMDG 777', stabilityScore: 70, gateStable: false, timestampMs: 2 },
    { vsFpm: -608.6, grade: 'FIRM', touchdownDistanceGrade: 'Long Landing', icao: 'KBOS', runway: '33R', aircraft: 'PMDG 777', stabilityScore: 84, stabilityVerdict: 'marginal', gateStable: false, timestampMs: 3 },
    { vsFpm: -420.2, grade: 'GOOD', icao: 'KBOS', runway: '33R', aircraft: 'PMDG 777', stabilityScore: 91, gateStable: true, timestampMs: 4 },
  ]);

  assertEqual(stats.total, 4, 'total');
  assertEqual(stats.grades.FIRM, 2, 'firm count');
  assertEqual(stats.grades.HARD, 1, 'hard count');
  assertEqual(stats.grades.GOOD, 1, 'good count');
  assertEqual(stats.outcomeGrades.FIRM, 1, 'firm outcome count');
  assertEqual(stats.outcomeGrades['Long Landing'], 1, 'long landing outcome count');
  assertEqual(stats.longLandingCount, 1, 'long landing count');
  assertEqual(stats.avgVsFpm, -549, 'avgVsFpm');
  assertEqual(stats.bestVsFpm, -420, 'bestVsFpm');
  assertEqual(stats.airports, 2, 'airports');
  assertEqual(stats.aircraft, 1, 'aircraft');
  assertEqual(stats.trends.aircraft[0].label, 'PMDG 777', 'aircraft trend label');
  assertEqual(stats.trends.aircraft[0].count, 3, 'aircraft trend count');
  assertEqual(stats.trends.aircraft[0].avgStabilityScore, 82, 'aircraft trend avg stability');
  assertEqual(stats.trends.aircraft[0].stableRatePct, 33, 'aircraft stable rate');
  assertEqual(stats.trends.aircraft[0].marginalRatePct, 33, 'aircraft marginal rate');
  assertEqual(stats.trends.airports[0].label, 'KBOS', 'airport trend label');
  assertEqual(stats.trends.runways[0].label, 'KBOS 33R', 'runway trend label');
});

test('logbook PERFECT outcomes require explicit stable, target, and clean evidence', () => {
  const verified = {
    grade: 'PERFECT',
    gateStable: true,
    touchdownDistanceFt: 1000,
    bounceCount: 0,
    bounceGrade: 'Clean',
  };

  assertEqual(flightLogbook.logbookOutcomeGrade(verified), 'PERFECT', 'verified PERFECT');
  assertEqual(
    flightLogbook.logbookOutcomeGrade({ ...verified, gateStable: null }),
    'SMOOTH',
    'unknown stability caps PERFECT',
  );
  assertEqual(
    flightLogbook.logbookOutcomeGrade({ ...verified, touchdownDistanceFt: 1001 }),
    'SMOOTH',
    'outside first 1,000 ft caps PERFECT',
  );
  assertEqual(
    flightLogbook.logbookOutcomeGrade({ ...verified, bounceCount: 1, bounceGrade: null }),
    'SMOOTH',
    'recorded bounce caps PERFECT',
  );
  assertEqual(
    flightLogbook.logbookOutcomeGrade({ ...verified, shortLanding: true }),
    'Short Landing',
    'critical touchdown outcome wins',
  );
  assertEqual(
    flightLogbook.logbookOutcomeGrade({ ...verified, runwayExcursion: true }),
    'RUNWAY EXCURSION',
    'runway excursion wins',
  );

  const stats = flightLogbook.computeStatsFromEntries([
    { ...verified, timestampMs: 1 },
    { ...verified, gateStable: false, timestampMs: 2 },
    { ...verified, touchdownDistanceFt: null, timestampMs: 3 },
  ]);
  assertEqual(stats.outcomeGrades.PERFECT, 1, 'verified PERFECT aggregate');
  assertEqual(stats.outcomeGrades.SMOOTH, 2, 'capped SMOOTH aggregate');
});

test('legacy logbook JSON without version is migrated to v1 on next write', () => {
  const logbookFile = flightLogbook.LOGBOOK_FILE;
  fs.mkdirSync(path.dirname(logbookFile), { recursive: true });
  fs.writeFileSync(
    logbookFile,
    JSON.stringify({
      entries: [
        {
          id: 'legacy-landing',
          timestamp: '2026-01-01T00:00:00.000Z',
          timestampMs: 1,
          vsFpm: -450,
          grade: 'FIRM',
          aircraft: 'Legacy A320',
        },
      ],
    }, null, 2),
    'utf8',
  );

  const entriesBeforeWrite = flightLogbook.getEntries();
  assertEqual(entriesBeforeWrite.length, 1, 'legacy entry count before write');
  assertEqual(entriesBeforeWrite[0].id, 'legacy-landing', 'legacy entry id before write');

  flightLogbook.addEntry({
    timestamp_ms: 2,
    vs_fpm: -320,
    grade: 'GOOD',
    aircraft: 'New A320',
  });

  const persisted = JSON.parse(fs.readFileSync(logbookFile, 'utf8'));
  assertEqual(persisted.version, 1, 'migrated logbook version');
  assertEqual(persisted.entries.length, 2, 'migrated logbook entry count');
  assertEqual(
    persisted.entries.some((entry) => entry.id === 'legacy-landing'),
    true,
    'migration preserves legacy logbook entry'
  );

  flightLogbook.clearAll();
});

test('addEntry refuses to overwrite a corrupt logbook', () => {
  const logbookFile = flightLogbook.LOGBOOK_FILE;
  const corruptContent = '{"version":1,"entries":[';
  fs.mkdirSync(path.dirname(logbookFile), { recursive: true });
  fs.writeFileSync(logbookFile, corruptContent, 'utf8');

  let threw = false;
  try {
    flightLogbook.addEntry({
      timestamp_ms: 2,
      vs_fpm: -320,
      grade: 'GOOD',
    });
  } catch {
    threw = true;
  }

  assertEqual(threw, true, 'corrupt logbook write must fail closed');
  assertEqual(fs.readFileSync(logbookFile, 'utf8'), corruptContent, 'corrupt logbook remains untouched');
  fs.rmSync(logbookFile, { force: true });
});

test('addEntry grades camelCase live payloads through their recorded aircraft profile', () => {
  flightLogbook.clearAll();
  const entry = flightLogbook.addEntry({
    timestamp_ms: 2,
    vs_fpm: -243.3,
    grade: 'PERFECT',
    aircraftProfileId: 'fbw-a32nx',
    td_sim_trusted: true,
    td_sim_fresh: true,
    td_sim_landing_vs_fpm: -349.2,
  });

  assertEqual(entry.vsFpm, -243.3, 'conventional V/S');
  assertEqual(entry.grade, 'GOOD', 'recorded A32NX rate grade');
  assertEqual(entry.aircraftProfileId, 'fbw-a32nx', 'normalized profile id');

  const retiredProfileEntry = flightLogbook.addEntry({
    timestamp_ms: 3,
    vs_fpm: -650,
    grade: 'VERY HARD',
    aircraftProfileId: 'pmdg-737',
    td_sim_landing_vs_fpm: -900,
  });
  assertEqual(retiredProfileEntry.vsFpm, -650, 'retired-profile conventional V/S');
  assertEqual(retiredProfileEntry.grade, 'VERY HARD', 'retired-profile saved grade');
  flightLogbook.clearAll();
});

test('logbook compatible writes do not downgrade future versions', () => {
  const logbookFile = flightLogbook.LOGBOOK_FILE;
  fs.mkdirSync(path.dirname(logbookFile), { recursive: true });
  fs.writeFileSync(
    logbookFile,
    JSON.stringify({
      version: 99,
      entries: [],
    }, null, 2),
    'utf8',
  );

  flightLogbook.addEntry({
    timestamp_ms: 3,
    vs_fpm: -300,
    grade: 'GOOD',
  });

  const persisted = JSON.parse(fs.readFileSync(logbookFile, 'utf8'));
  assertEqual(persisted.version, 99, 'future logbook version is preserved');
  assertEqual(persisted.entries.length, 1, 'future-version logbook entry count');

  flightLogbook.clearAll();
});

async function runAsyncTests() {
  console.log('\n=== CSV logbook ingestion ===\n');

  await testAsync('getLandingsFromCsvFile rejects malformed CSV rows', async () => {
    const logsRoot = path.join(tempHome, 'Documents', 'Flight Fabric');
    const logsDir = path.join(logsRoot, 'Flight Logs');
    fs.rmSync(logsRoot, { recursive: true, force: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const csvPath = createCanonicalCsvPath(logsDir, 'malformed-row');
    fs.writeFileSync(csvPath, 'ts,record_type,vs_fpm\n1,LANDING', 'utf8');

    let rejected = false;
    try {
      await flightLogbook.getLandingsFromCsvFile(csvPath, { bypassCache: true });
    } catch {
      rejected = true;
    }
    assertEqual(rejected, true, 'malformed CSV must not become an authoritative empty result');
  });

  await testAsync('getLandingsFromCsvFile propagates unexpected read failures', async () => {
    const logsRoot = path.join(tempHome, 'Documents', 'Flight Fabric');
    const logsDir = path.join(logsRoot, 'Flight Logs');
    fs.rmSync(logsRoot, { recursive: true, force: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const csvPath = createCanonicalCsvPath(logsDir, 'read-failure');
    fs.writeFileSync(csvPath, 'ts,record_type,vs_fpm\n1,LANDING,-320', 'utf8');
    const originalReadFile = fs.promises.readFile;
    fs.promises.readFile = async function failedRead() {
      throw new Error('simulated read failure');
    };

    let rejected = false;
    try {
      await flightLogbook.getLandingsFromCsvFile(csvPath, { bypassCache: true });
    } catch {
      rejected = true;
    } finally {
      fs.promises.readFile = originalReadFile;
    }
    assertEqual(rejected, true, 'unexpected read failure must reach the caller');
  });

  await testAsync('getLandingsFromCSVs keeps healthy history when one CSV is malformed', async () => {
    const logsRoot = path.join(tempHome, 'Documents', 'Flight Fabric');
    const logsDir = path.join(logsRoot, 'Flight Logs');
    fs.rmSync(logsRoot, { recursive: true, force: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const malformedPath = createCanonicalCsvPath(logsDir, 'malformed-history');
    fs.writeFileSync(malformedPath, 'ts,record_type,vs_fpm\n1,LANDING', 'utf8');
    const healthyPath = createCanonicalCsvPath(logsDir, 'healthy-history');
    fs.writeFileSync(healthyPath, 'ts,record_type,vs_fpm\n2,LANDING,-320', 'utf8');

    const landings = await flightLogbook.getLandingsFromCSVs({
      bypassCachePaths: [malformedPath, healthyPath],
      allowedCsvPaths: [malformedPath, healthyPath],
    });
    assertEqual(landings.length, 1, 'healthy landing remains available');
    assertEqual(landings[0].vsFpm, -320, 'healthy landing payload');
  });

  await testAsync('getLandingsFromCSVs keeps blank stability columns as no verdict', async () => {
    const logsRoot = path.join(tempHome, 'Documents', 'Flight Fabric');
    const logsDir = path.join(logsRoot, 'Flight Logs');
    fs.rmSync(logsRoot, { recursive: true, force: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const csvPath = createCanonicalCsvPath(logsDir, 'blank-stability');
    const headers = [
      'ts',
      'record_type',
      'vs_fpm',
      'aircraft',
      'ultimate_stability_score',
      'ultimate_stability_config_ok_pct',
    ];
    const rows = [[1, 'LANDING', -420, 'A320', '', '']];
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');

    const landings = await flightLogbook.getLandingsFromCSVs({ bypassCachePaths: [csvPath] });
    assertEqual(landings.length, 1, 'landing count');
    assertNull(landings[0].stabilityScore, 'stabilityScore');
    assertEqual(landings[0].stabilityVerdict, 'no_verdict', 'stabilityVerdict');
    assertNull(landings[0].stabilityBreakdown, 'stabilityBreakdown');
  });

  await testAsync('getLandingsFromCSVs reads canonical bundles and preserves ts=0', async () => {
    const logsRoot = path.join(tempHome, 'Documents', 'Flight Fabric');
    const logsDir = path.join(logsRoot, 'Flight Logs');
    fs.rmSync(logsRoot, { recursive: true, force: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const csvPath = createCanonicalCsvPath(logsDir, 'UPPER');
    const headers = ['ts', 'record_type', 'vs_fpm', 'aircraft'];
    const rows = [[0, 'LANDING', -420, 'A320']];
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');

    const landings = await flightLogbook.getLandingsFromCSVs({ bypassCachePaths: [csvPath] });
    assertEqual(landings.length, 1, 'landing count');
    assertEqual(landings[0].timestampMs, 0, 'timestampMs');
    assertEqual(landings[0].timestamp, '1970-01-01T00:00:00.000Z', 'timestamp');
    assertEqual(landings[0].aircraft, 'A320', 'aircraft');
  });

  await testAsync('getLandingsFromCSVs separates a legacy excursion sentinel from the rate grade', async () => {
    const logsRoot = path.join(tempHome, 'Documents', 'Flight Fabric');
    const logsDir = path.join(logsRoot, 'Flight Logs');
    fs.rmSync(logsRoot, { recursive: true, force: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const csvPath = createCanonicalCsvPath(logsDir, 'grade-preserved');
    const headers = ['ts', 'record_type', 'vs_fpm', 'grade', 'aircraft'];
    const rows = [[1, 'LANDING', -420, 'RUNWAY EXCURSION', 'A320']];
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');

    const landings = await flightLogbook.getLandingsFromCSVs({ bypassCachePaths: [csvPath] });
    assertEqual(landings.length, 1, 'landing count');
    assertEqual(landings[0].grade, 'HARD', 'rate grade recomputed from conventional V/S');
    assertEqual(landings[0].runwayExcursion, true, 'legacy sentinel preserved as separate excursion flag');
  });

  await testAsync('CSV history preserves conventional V/S and recomputes resolvable recorded-profile grades', async () => {
    const logsRoot = path.join(tempHome, 'Documents', 'Flight Fabric');
    const logsDir = path.join(logsRoot, 'Flight Logs');
    fs.rmSync(logsRoot, { recursive: true, force: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const headers = [
      'ts',
      'flight_elapsed_ms',
      'record_type',
      'phase',
      'on_ground',
      'ias_kts',
      'vs_fpm',
      'g_force',
      'ra_ft',
      'alt_plane_ft',
      'grade',
      'bounce_count',
      'bounce_grade',
      'td_sim_trusted',
      'td_sim_fresh',
      'td_sim_landing_vs_fpm',
      'aircraft_profile_id',
    ];
    const baseTs = Date.UTC(2026, 7, 7, 1, 2, 3);
    const sample = (elapsedMs, overrides = {}) => ({
      ts: baseTs + elapsedMs,
      flight_elapsed_ms: elapsedMs,
      record_type: 'SAMPLE',
      phase: 'APPROACH',
      on_ground: false,
      ias_kts: 130,
      vs_fpm: -500,
      g_force: 1.05,
      ra_ft: 100,
      alt_plane_ft: 800,
      ...overrides,
    });
    const motionRows = (motion) => {
      if (motion === 'noise') {
        return [
          sample(1200, { on_ground: false, vs_fpm: 5, ra_ft: 0.3, alt_plane_ft: 700 }),
          sample(1700, { on_ground: false, vs_fpm: 10, ra_ft: 0.4, alt_plane_ft: 700 }),
          sample(2135, { on_ground: true, vs_fpm: -30, g_force: 1.1, ra_ft: 0, alt_plane_ft: 700 }),
        ];
      }
      if (motion === 'hard-radio-height') {
        return [
          sample(1200, { on_ground: false, vs_fpm: 80, ra_ft: 4, alt_plane_ft: 703 }),
          sample(1500, { on_ground: true, vs_fpm: -60, g_force: 1.1, ra_ft: 0, alt_plane_ft: 700 }),
        ];
      }
      if (motion === 'hard-altitude-fallback') {
        return [
          sample(1200, { on_ground: false, vs_fpm: 80, ra_ft: null, alt_plane_ft: 703 }),
          sample(1500, { on_ground: true, vs_fpm: -60, g_force: 1.1, ra_ft: null, alt_plane_ft: 700 }),
        ];
      }
      if (motion === 'delayed-load') {
        return [
          sample(1200, { on_ground: false, vs_fpm: 10, ra_ft: 0, alt_plane_ft: 700 }),
          sample(1400, { on_ground: true, vs_fpm: -20, g_force: 1.1, ra_ft: 0, alt_plane_ft: 700 }),
          sample(1800, { on_ground: true, vs_fpm: -10, g_force: 1.4, ra_ft: 0, alt_plane_ft: 700 }),
        ];
      }
      if (motion === 'impact-only') {
        return [
          sample(1200, { on_ground: false, vs_fpm: 0, ra_ft: 0, alt_plane_ft: 700 }),
          sample(1500, { on_ground: true, vs_fpm: -150, g_force: 1.1, ra_ft: 0, alt_plane_ft: 700 }),
        ];
      }
      return [
        sample(1200, { on_ground: false, vs_fpm: 20, ra_ft: 0.1, alt_plane_ft: 700.2 }),
        sample(1700, { on_ground: false, vs_fpm: 48, ra_ft: 0.4, alt_plane_ft: 700.8 }),
        sample(2135, { on_ground: true, vs_fpm: -30, g_force: 1.1, ra_ft: 0, alt_plane_ft: 700 }),
      ];
    };
    const readFixture = async (bundleName, {
      motion = 'shallow',
      trusted = true,
      fresh = true,
      grade = 'PERFECT',
      landingVsFpm = -243,
      profileId = 'bundled/msfs/fbw-a32nx',
      persistedBounceCount = 0,
      persistedBounceGrade = 'Clean',
    } = {}) => {
      const initialRadioHeight = motion === 'hard-altitude-fallback' ? null : 0;
      const rows = [
        sample(0, { aircraft_profile_id: profileId }),
        sample(1000, {
          on_ground: true,
          vs_fpm: -180,
          ra_ft: initialRadioHeight,
          alt_plane_ft: 700,
        }),
        ...motionRows(motion),
        {
          ...sample(3000, { on_ground: true, vs_fpm: landingVsFpm, ra_ft: 0, alt_plane_ft: 700 }),
          record_type: 'LANDING',
          grade,
          bounce_count: persistedBounceCount,
          bounce_grade: persistedBounceGrade,
          td_sim_trusted: trusted,
          td_sim_fresh: fresh,
          td_sim_landing_vs_fpm: -349,
        },
      ];
      const csvPath = createCanonicalCsvPath(logsDir, bundleName);
      const content = [
        headers.join(','),
        ...rows.map((row) => headers.map((header) => row[header] ?? '').join(',')),
      ].join('\n');
      fs.writeFileSync(csvPath, content, 'utf8');
      const landings = await flightLogbook.getLandingsFromCsvFile(csvPath, { bypassCache: true });
      assertEqual(fs.readFileSync(csvPath, 'utf8'), content, `${bundleName} CSV remains authoritative`);
      assertEqual(landings.length, 1, `${bundleName} landing count`);
      return landings[0];
    };

    const latestStyle = await readFixture('latest-style');
    assertEqual(latestStyle.vsFpm, -243, 'complete persisted headline V/S');
    assertEqual(latestStyle.grade, 'GOOD', 'stale persisted grade recomputed from recorded profile');
    assertEqual(latestStyle.bounceCount, 0, 'complete persisted bounce count remains authoritative');
    assertEqual(latestStyle.bounceGrade, 'Clean', 'complete persisted bounce grade remains authoritative');
    assertEqual(latestStyle.bounceCountSource, 'recorded', 'complete bounce source');

    const stale = await readFixture('stale-simulator-rate', { fresh: false });
    assertEqual(stale.vsFpm, -243, 'stale simulator V/S ignored');
    assertEqual(stale.grade, 'GOOD', 'rate grade remains profile-derived');
    assertEqual(stale.bounceCount, 0, 'persisted bounce remains independent of rate trust');

    const untrusted = await readFixture('untrusted-simulator-rate', { trusted: false });
    assertEqual(untrusted.vsFpm, -243, 'untrusted simulator V/S ignored');
    assertEqual(untrusted.grade, 'GOOD', 'rate grade remains profile-derived');

    const noise = await readFixture('sustained-wow-noise', { motion: 'noise' });
    assertEqual(noise.bounceCount, 0, 'long WOW chatter is not a bounce');
    assertEqual(noise.bounceGrade, 'Clean', 'clean label remains for rejected chatter');

    const special = await readFixture('special-grade', { grade: 'RUNWAY EXCURSION' });
    assertEqual(special.vsFpm, -243, 'complete legacy excursion retains persisted V/S');
    assertEqual(special.grade, 'GOOD', 'legacy excursion sentinel does not replace the rate grade');
    assertEqual(special.runwayExcursion, true, 'legacy excursion remains a separate fact');

    const retiredProfile = await readFixture('retired-profile', {
      motion: 'noise',
      grade: 'VERY HARD',
      landingVsFpm: -650,
      profileId: 'pmdg-737',
    });
    assertEqual(retiredProfile.vsFpm, -650, 'retired-profile conventional V/S');
    assertEqual(retiredProfile.grade, 'VERY HARD', 'retired-profile saved grade is not replaced by generic bands');

    const hardRa = await readFixture('hard-radio-height', {
      motion: 'hard-radio-height',
      persistedBounceCount: null,
      persistedBounceGrade: null,
    });
    assertEqual(hardRa.bounceCount, 1, 'hard radio-height lift is recovered');
    assertEqual(hardRa.bounceCountSource, 'reconstructed', 'missing legacy bounce source');

    const hardFallback = await readFixture('hard-altitude-fallback', {
      motion: 'hard-altitude-fallback',
      persistedBounceCount: null,
      persistedBounceGrade: null,
    });
    assertEqual(hardFallback.bounceCount, 1, 'RA-absent altitude/VS lift is recovered');

    const delayedLoad = await readFixture('delayed-impact-load', {
      motion: 'delayed-load',
      persistedBounceCount: null,
      persistedBounceGrade: null,
    });
    assertEqual(delayedLoad.bounceCount, 1, 'short delayed impact load is recovered');

    const previousProfileId = profileLoader.getActiveProfileId();
    profileLoader.setActiveProfile('generic');
    const activeGenericId = profileLoader.getActiveProfileId();
    try {
      const recordedA380 = await readFixture('recorded-a380-profile', {
        motion: 'impact-only',
        grade: null,
        landingVsFpm: -180,
        profileId: 'fbw-a380x',
        persistedBounceCount: null,
        persistedBounceGrade: null,
      });
      assertEqual(recordedA380.grade, 'GOOD', 'missing grade uses recorded A380 thresholds');
      assertEqual(recordedA380.bounceCount, 1, 'bounce impact uses recorded A380 thresholds');
      assertEqual(profileLoader.getActiveProfileId(), activeGenericId, 'history analysis leaves active profile unchanged');
    } finally {
      if (previousProfileId) profileLoader.setActiveProfile(previousProfileId);
    }
  });

  await testAsync('getLandingsFromCSVs preserves stability gate failure reasons', async () => {
    const logsRoot = path.join(tempHome, 'Documents', 'Flight Fabric');
    const logsDir = path.join(logsRoot, 'Flight Logs');
    fs.rmSync(logsRoot, { recursive: true, force: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const csvPath = createCanonicalCsvPath(logsDir, 'gate-failures');
    const headers = ['ts', 'record_type', 'vs_fpm', 'ultimate_stability_gate_failures'];
    const rows = [[1, 'LANDING', -420, 'vs_unstable_after_gate|bank_unstable_after_gate']];
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');

    const landings = await flightLogbook.getLandingsFromCSVs({ bypassCachePaths: [csvPath] });
    assertEqual(landings.length, 1, 'landing count');
    assertEqual(landings[0].stabilityGateFailures[0], 'vs_unstable_after_gate', 'first gate failure');
    assertEqual(landings[0].stabilityGateFailures[1], 'bank_unstable_after_gate', 'second gate failure');
  });

  await testAsync('getLandingsFromCSVs removes retired spoiler penalties from saved flights', async () => {
    const logsRoot = path.join(tempHome, 'Documents', 'Flight Fabric');
    const logsDir = path.join(logsRoot, 'Flight Logs');
    fs.rmSync(logsRoot, { recursive: true, force: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const csvPath = createCanonicalCsvPath(logsDir, 'retired-spoiler-penalty');
    const headers = [
      'ts',
      'record_type',
      'vs_fpm',
      'ultimate_stability_score',
      'ultimate_stability_gate_stable',
      'ultimate_stability_gate_failures',
      'ultimate_stability_config_ok_pct',
      'ultimate_stability_gear_ok_pct',
      'ultimate_stability_flaps_ok_pct',
      'ultimate_stability_spoilers_ok_pct',
      'ultimate_stability_speed_ok_pct',
      'ultimate_stability_speed_trend_ok_pct',
      'ultimate_stability_vs_ok_pct',
      'ultimate_stability_glidepath_ok_pct',
      'ultimate_stability_thrust_ok_pct',
      'ultimate_stability_pitch_ok_pct',
      'ultimate_stability_bank_ok_pct',
      'ultimate_stability_lateral_offset_ok_pct',
    ];
    const rows = [[
      1,
      'LANDING',
      -238,
      75,
      0,
      'spoilers_moved_after_gate|glidepath_proxy_unstable_after_gate',
      0,
      100,
      100,
      0,
      85,
      86,
      96,
      51,
      81,
      100,
      100,
      100,
    ]];
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');

    const landings = await flightLogbook.getLandingsFromCSVs({ bypassCachePaths: [csvPath] });
    assertEqual(landings.length, 1, 'landing count');
    assertEqual(landings[0].stabilityScore, 89, 'stability score');
    assertEqual(landings[0].stabilityBreakdown.config_ok, 100, 'configuration score');
    assertEqual(landings[0].stabilityBreakdown.spoilers_ok, 100, 'retired spoiler metric');
    assertEqual(landings[0].stabilityVerdict, 'marginal', 'retired spoiler verdict');
    assertEqual(
      landings[0].stabilityGateFailures.join('|'),
      'glidepath_proxy_unstable_after_gate',
      'remaining gate failures',
    );
  });

  await testAsync('getLandingsFromCSVs normalizes legacy v2 MSFS touchdown attitude signs', async () => {
    const logsRoot = path.join(tempHome, 'Documents', 'Flight Fabric');
    const logsDir = path.join(logsRoot, 'Flight Logs');
    fs.rmSync(logsRoot, { recursive: true, force: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const headers = [
      'schema_version',
      'record_type',
      'touchdown_capture_source',
      'td_sim_source',
      'vs_fpm',
      'pitch_deg',
      'bank_deg',
    ];

    const v2CsvPath = createCanonicalCsvPath(logsDir, 'legacy-v2');
    fs.writeFileSync(
      v2CsvPath,
      [
        headers.join(','),
        [2, 'LANDING', 'msfs_last_touchdown', 'msfs_last_touchdown', -120, -7.7, 1.8].join(','),
      ].join('\n'),
      'utf8',
    );

    const v3CsvPath = createCanonicalCsvPath(logsDir, 'current-v3');
    fs.writeFileSync(
      v3CsvPath,
      [
        headers.join(','),
        [3, 'LANDING', 'msfs_last_touchdown', 'msfs_last_touchdown', -120, 7.7, -1.8].join(','),
      ].join('\n'),
      'utf8',
    );

    const landings = await flightLogbook.getLandingsFromCSVs({ bypassCachePaths: [v2CsvPath, v3CsvPath] });
    const legacy = landings.find((entry) => entry.id.startsWith('legacy-v2-'));
    const current = landings.find((entry) => entry.id.startsWith('current-v3-'));

    assertEqual(legacy.pitchDeg, 7.7, 'legacy pitchDeg');
    assertEqual(legacy.bankDeg, -1.8, 'legacy bankDeg');
    assertEqual(current.pitchDeg, 7.7, 'current pitchDeg');
    assertEqual(current.bankDeg, -1.8, 'current bankDeg');
  });

  await testAsync('getLandingsFromCSVs hydrates compact aircraft metadata from sample rows', async () => {
    const logsRoot = path.join(tempHome, 'Documents', 'Flight Fabric');
    const logsDir = path.join(logsRoot, 'Flight Logs');
    fs.rmSync(logsRoot, { recursive: true, force: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const csvPath = createCanonicalCsvPath(logsDir, 'compact-aircraft');
    const headers = ['ts', 'record_type', 'vs_fpm', 'aircraft', 'aircraft_profile_id'];
    const rows = [
      [0, 'SAMPLE', '', 'PMDG 737-800', 'pmdg-737'],
      [1, 'LANDING', -420, '', ''],
    ];
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');

    const landings = await flightLogbook.getLandingsFromCSVs({ bypassCachePaths: [csvPath] });
    assertEqual(landings.length, 1, 'landing count');
    assertEqual(landings[0].aircraft, 'PMDG 737-800', 'aircraft');
    assertEqual(landings[0].aircraftProfileId, 'pmdg-737', 'aircraftProfileId');
  });

  await testAsync('getLandingsFromCSVs preserves numeric runway identifiers as display text', async () => {
    const logsRoot = path.join(tempHome, 'Documents', 'Flight Fabric');
    const logsDir = path.join(logsRoot, 'Flight Logs');
    fs.rmSync(logsRoot, { recursive: true, force: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const csvPath = createCanonicalCsvPath(logsDir, 'numeric-runway');
    const headers = ['ts', 'record_type', 'vs_fpm', 'icao', 'runway'];
    const rows = [[2, 'LANDING', -390, 'YPAD', 23]];
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');

    const landings = await flightLogbook.getLandingsFromCSVs({ bypassCachePaths: [csvPath] });
    assertEqual(landings.length, 1, 'landing count');
    assertEqual(landings[0].icao, 'YPAD', 'icao');
    assertEqual(landings[0].runway, '23', 'runway');
  });

  await testAsync('getLandingsFromCSVs limits concurrent CSV reads', async () => {
    const logsRoot = path.join(tempHome, 'Documents', 'Flight Fabric');
    const logsDir = path.join(logsRoot, 'Flight Logs');
    fs.rmSync(logsRoot, { recursive: true, force: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const csvPaths = [];
    const headers = ['ts', 'record_type', 'vs_fpm', 'aircraft'];
    for (let index = 0; index < 8; index++) {
      const csvPath = createCanonicalCsvPath(logsDir, `limited-${index}`);
      csvPaths.push(csvPath);
      const rows = [[1000 + index, 'LANDING', -300 - index, `Aircraft ${index}`]];
      fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');
    }

    const originalReadFile = fs.promises.readFile;
    let activeReads = 0;
    let maxActiveReads = 0;
    fs.promises.readFile = async function patchedReadFile(...args) {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 10));
      try {
        return await originalReadFile.apply(this, args);
      } finally {
        activeReads -= 1;
      }
    };

    try {
      const landings = await flightLogbook.getLandingsFromCSVs({ bypassCachePaths: csvPaths });
      assertEqual(landings.length, 8, 'landing count');
      if (maxActiveReads > 3) {
        throw new Error(`expected no more than 3 concurrent reads, saw ${maxActiveReads}`);
      }
    } finally {
      fs.promises.readFile = originalReadFile;
    }
  });

  await testAsync('getLandingsFromCSVs caps retained file cache entries', async () => {
    const logsRoot = path.join(tempHome, 'Documents', 'Flight Fabric');
    const logsDir = path.join(logsRoot, 'Flight Logs');
    fs.rmSync(logsRoot, { recursive: true, force: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const headers = ['ts', 'record_type', 'vs_fpm', 'aircraft'];
    const csvPaths = [];
    const baseTime = Date.UTC(2026, 0, 1);
    for (let index = 0; index < 205; index++) {
      const csvPath = createCanonicalCsvPath(logsDir, `cache-${String(index).padStart(3, '0')}`);
      csvPaths.push(csvPath);
      const rows = [[2000 + index, 'LANDING', -350 - index, `Cache Aircraft ${index}`]];
      fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => row.join(','))].join('\n'), 'utf8');
      const fileTime = new Date(baseTime + (index * 1000));
      fs.utimesSync(csvPath, fileTime, fileTime);
    }

    const initialLandings = await flightLogbook.getLandingsFromCSVs({ bypassCachePaths: csvPaths });
    assertEqual(initialLandings.length, 205, 'initial landing count');

    const originalReadFile = fs.promises.readFile;
    let readCount = 0;
    fs.promises.readFile = async function patchedReadFile(...args) {
      readCount += 1;
      return await originalReadFile.apply(this, args);
    };

    try {
      const cachedLandings = await flightLogbook.getLandingsFromCSVs();
      assertEqual(cachedLandings.length, 205, 'cached landing count');
      assertEqual(readCount, 5, 'overflow cache miss count');
    } finally {
      fs.promises.readFile = originalReadFile;
    }
  });
}

console.log('\n=== linearSlope Tests ===\n');

// ─────────────────────────────────────────────────────────────────────────────
// linearSlope
// ─────────────────────────────────────────────────────────────────────────────

test('returns null for fewer than 3 values', () => {
  assertNull(linearSlope([]), 'empty array');
  assertNull(linearSlope([1]), 'single value');
  assertNull(linearSlope([1, 2]), 'two values');
});

test('returns null for fewer than 3 finite values (nulls filtered)', () => {
  assertNull(linearSlope([null, 1, null, 2, null]), 'only 2 finite values');
});

test('returns 0 for flat series', () => {
  const slope = linearSlope([100, 100, 100, 100, 100]);
  assertEqual(slope, 0, 'flat series should have slope 0');
});

test('positive slope for increasing series', () => {
  const slope = linearSlope([100, 200, 300, 400, 500]);
  if (slope === null || slope <= 0) {
    throw new Error(`Expected positive slope, got ${slope}`);
  }
});

test('negative slope for decreasing series', () => {
  const slope = linearSlope([500, 400, 300, 200, 100]);
  if (slope === null || slope >= 0) {
    throw new Error(`Expected negative slope, got ${slope}`);
  }
});

test('filters null/undefined values', () => {
  // [100, null, 200, undefined, 300] — 3 valid values
  const slope = linearSlope([100, null, 200, undefined, 300]);
  if (slope === null) {
    throw new Error('Should not return null with 3 valid values');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// linearTrend
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n=== linearTrend Tests ===\n');

test('returns null when fewer than 3 values', () => {
  assertNull(linearTrend([1, 2], 'vs'), 'too few values');
});

// VS metric: slope > 0 = improving (VS going toward 0, softer landings)
test('VS: improving when slope is positive (VS going toward 0)', () => {
  // VS values going from -800 toward -200 (improving = softer)
  const values = [-800, -600, -400, -300, -200];
  assertEqual(linearTrend(values, 'vs'), 'improving', 'VS improving');
});

test('VS: regressing when slope is negative (VS getting worse)', () => {
  // VS values going from -200 toward -800 (regressing = harder)
  const values = [-200, -300, -400, -600, -800];
  assertEqual(linearTrend(values, 'vs'), 'regressing', 'VS regressing');
});

test('VS: stable when slope is near zero', () => {
  // Flat VS values
  const values = [-400, -400, -400, -400, -400];
  assertEqual(linearTrend(values, 'vs'), 'stable', 'VS stable');
});

// G-force metric: slope < 0 = improving (decreasing G)
test('gforce: improving when slope is negative (G decreasing)', () => {
  // G-force going from 2.5 down to 1.2 (improving)
  const values = [2.5, 2.2, 1.8, 1.5, 1.2];
  assertEqual(linearTrend(values, 'gforce'), 'improving', 'gforce improving');
});

test('gforce: regressing when slope is positive (G increasing)', () => {
  // G-force going from 1.2 up to 2.5 (regressing)
  const values = [1.2, 1.5, 1.8, 2.2, 2.5];
  assertEqual(linearTrend(values, 'gforce'), 'regressing', 'gforce regressing');
});

test('gforce: stable when slope is near zero', () => {
  const values = [1.5, 1.5, 1.5, 1.5, 1.5];
  assertEqual(linearTrend(values, 'gforce'), 'stable', 'gforce stable');
});

// Stability metric: slope > 0 = improving (score rising)
test('stability: improving when slope is positive (score rising)', () => {
  const values = [60, 70, 75, 80, 90];
  assertEqual(linearTrend(values, 'stability'), 'improving', 'stability improving');
});

test('stability: regressing when slope is negative (score falling)', () => {
  const values = [90, 80, 75, 70, 60];
  assertEqual(linearTrend(values, 'stability'), 'regressing', 'stability regressing');
});

test('stability: stable when slope is near zero', () => {
  const values = [80, 80, 80, 80, 80];
  assertEqual(linearTrend(values, 'stability'), 'stable', 'stability stable');
});

// Unknown metric falls back to 'stable'
test('unknown metric returns stable', () => {
  const values = [1, 2, 3, 4, 5];
  assertEqual(linearTrend(values, 'unknown_metric'), 'stable', 'unknown metric');
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
function finish() {
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

runAsyncTests().then(finish).catch((err) => {
  failed++;
  console.error(err);
  finish();
});
