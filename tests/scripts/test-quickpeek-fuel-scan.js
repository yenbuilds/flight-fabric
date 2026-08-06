#!/usr/bin/env node
'use strict';

/**
 * Regression test for quickPeekCSV() large-file fuel-burn detection.
 *
 * Verifies that the bounded forward scan correctly finds a first valid
 * fuel sample even when it appears well beyond the initial 32 KB head chunk.
 *
 * Reproduces a historical bug where listCSVFlights() returned fuelBurnGal:
 * null for a 277 KB CSV whose first valid fuel row appeared outside the first
 * 32 KB window.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { getRepoScratchAppData } = require('./repo-scratch');

const tempAppData = getRepoScratchAppData('quickpeek-fuel-scan-appdata');
fs.mkdirSync(tempAppData, { recursive: true });
process.env.APPDATA = tempAppData;

const { _quickPeekCSV } = require(resolveBackendRuntimeFile('events', 'timeline-generator.js'));
const { selectFuelUsageRows, summarizeFuelUsage } = require(resolveBackendRuntimeFile('events', 'timeline-csv-helpers.js'));
const { PHASES } = require(resolveBackendRuntimeFile('lifecycle', 'phases.js'));
const { createHarness } = require(resolveBackendRuntimeFile('test-support', 'mini-test-harness.js'));

const { test, assertEqual, assertTrue, summary } = createHarness();

const PEEK_BYTES = 32 * 1024; // must match timeline-generator constant

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEADERS = [
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
  'fuel_total_gal',
  'fuel_total_weight_lbs',
  'fuel_weight_per_gal',
  'gross_weight_lbs',
];

function makeRow(opts = {}) {
  const {
    ts = 1700000000000,
    elapsedMs = 0,
    lat = 37.6,
    lon = -122.4,
    fuel = '',
    fuelWeight = '',
    fuelWeightPerGal = '',
    grossWeight = '',
    phase = PHASES.CRUISE,
  } = opts;
  return [
    'test-flight',
    new Date(ts).toISOString(),
    ts,
    elapsedMs,
    'SAMPLE',
    phase,
    lat,
    lon,
    5000,
    'false',
    250,
    100,
    fuel,
    fuelWeight,
    fuelWeightPerGal,
    grossWeight,
  ].join(',');
}

/**
 * Build a CSV where the first fuel sample appears at approximately `targetOffset`
 * bytes. Rows before that offset have no fuel. The total file is padded to at
 * least `minSize` bytes so the large-file code path is triggered when needed.
 */
function buildLargeCsv(targetOffset, fuelStart, fuelEnd, minSize = 0) {
  const headerLine = HEADERS.join(',') + '\n';

  const rows = [];
  let byteCount = headerLine.length;
  let ts = 1700000000000;
  let elapsed = 0;

  // Padding rows (no fuel) until we reach targetOffset
  while (byteCount < targetOffset) {
    const row = makeRow({ ts, elapsedMs: elapsed });
    rows.push(row);
    byteCount += row.length + 1;
    ts += 1000;
    elapsed += 1000;
  }

  // First fuel row
  const fuelStartRow = makeRow({ ts, elapsedMs: elapsed, fuel: fuelStart });
  rows.push(fuelStartRow);
  byteCount += fuelStartRow.length + 1;
  ts += 1000;
  elapsed += 1000;

  // Some intermediate fuel rows
  for (let i = 0; i < 10; i++) {
    const row = makeRow({ ts, elapsedMs: elapsed, fuel: fuelStart - i });
    rows.push(row);
    byteCount += row.length + 1;
    ts += 1000;
    elapsed += 1000;
  }

  // Final fuel row
  const fuelEndRow = makeRow({ ts, elapsedMs: elapsed, fuel: fuelEnd });
  rows.push(fuelEndRow);
  byteCount += fuelEndRow.length + 1;
  ts += 1000;
  elapsed += 1000;

  // Pad with no-fuel rows until minSize is reached
  while (byteCount < minSize) {
    const row = makeRow({ ts, elapsedMs: elapsed });
    rows.push(row);
    byteCount += row.length + 1;
    ts += 1000;
    elapsed += 1000;
  }

  return headerLine + rows.join('\n') + '\n';
}

function buildTailFuelJumpCsv(minSize = PEEK_BYTES * 3, postJumpRows = 8) {
  const headerLine = HEADERS.join(',') + '\n';
  const rows = [];
  let byteCount = headerLine.length;
  let ts = 1700000000000;
  let elapsed = 0;
  let fuel = 15800.2;
  let grossWeight = 417160;

  const push = (row) => {
    rows.push(row);
    byteCount += row.length + 1;
    ts += 1000;
    elapsed += 1000;
  };

  push(makeRow({ ts, elapsedMs: elapsed, fuel, grossWeight, phase: PHASES.TAXI }));

  while (byteCount < minSize) {
    fuel = Math.max(8808.8, fuel - 120);
    grossWeight = Math.max(370316, grossWeight - 800);
    push(makeRow({ ts, elapsedMs: elapsed, fuel: fuel.toFixed(1), grossWeight, phase: PHASES.CRUISE }));
  }

  push(makeRow({ ts, elapsedMs: elapsed, fuel: 8808.8, grossWeight: 370316, phase: PHASES.PARKED }));
  for (let i = 0; i < postJumpRows; i++) {
    push(makeRow({ ts, elapsedMs: elapsed, fuel: 15901.0, grossWeight: 370316, phase: PHASES.PARKED }));
  }

  return headerLine + rows.join('\n') + '\n';
}

function buildLongSampledTailFuelJumpCsv() {
  const headerLine = HEADERS.join(',') + '\n';
  const rows = [];
  let byteCount = headerLine.length;
  let ts = 1700000000000;
  let elapsed = 0;

  const push = (row) => {
    rows.push(row);
    byteCount += row.length + 1;
    ts += 1000;
    elapsed += 1000;
  };

  push(makeRow({
    ts,
    elapsedMs: elapsed,
    fuel: 2855.4,
    fuelWeight: 19130.8,
    fuelWeightPerGal: 6.7,
    grossWeight: 152242,
    phase: PHASES.TAXI,
  }));
  push(makeRow({
    ts,
    elapsedMs: elapsed,
    fuel: 950.7,
    fuelWeight: 6369.9,
    fuelWeightPerGal: 6.7,
    grossWeight: 139481,
    phase: 'TAXI-IN',
  }));

  const badTailStartBytes = byteCount;
  while (byteCount - badTailStartBytes < PEEK_BYTES * 258) {
    push(makeRow({
      ts,
      elapsedMs: elapsed,
      fuel: 3437.5,
      fuelWeight: 23031.2,
      fuelWeightPerGal: 6.7,
      grossWeight: 133634,
      phase: 'TAXI-IN',
    }));
  }

  return headerLine + rows.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('small file: finds firstFuelRow in head (baseline)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-quickpeek-'));
  const filePath = path.join(tmpDir, 'small.csv');
  try {
    // Small file — fuel appears early (well within first 32 KB)
    const csv = buildLargeCsv(1024, 500, 100);
    fs.writeFileSync(filePath, csv, 'utf8');
    const stat = fs.statSync(filePath);
    assertTrue(stat.size <= PEEK_BYTES * 2, 'fixture should be a small file');

    const { firstFuelRow, lastFuelRow } = _quickPeekCSV(filePath);
    assertTrue(firstFuelRow != null, 'firstFuelRow should be non-null for small file');
    assertTrue(lastFuelRow != null, 'lastFuelRow should be non-null for small file');

    const start = parseFloat(firstFuelRow.fuel_total_gal);
    const end = parseFloat(lastFuelRow.fuel_total_gal);
    assertTrue(Number.isFinite(start), 'firstFuelRow.fuel_total_gal should be numeric');
    assertTrue(Number.isFinite(end), 'lastFuelRow.fuel_total_gal should be numeric');
    assertEqual(start, 500, 'firstFuelRow fuel should be 500');
    assertEqual(end, 100, 'lastFuelRow fuel should be 100');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('small file: accumulates recorded coordinate distance', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-quickpeek-'));
  const filePath = path.join(tmpDir, 'distance.csv');
  try {
    const headerLine = HEADERS.join(',') + '\n';
    const rows = [
      makeRow({ ts: 1700000000000, elapsedMs: 0, lat: 37.6, lon: -122.4 }),
      makeRow({ ts: 1700000001000, elapsedMs: 1000, lat: 37.7, lon: -122.4 }),
      makeRow({ ts: 1700000002000, elapsedMs: 2000, lat: 37.8, lon: -122.4 }),
    ];
    fs.writeFileSync(filePath, headerLine + rows.join('\n') + '\n', 'utf8');

    const { distanceNm } = _quickPeekCSV(filePath);
    assertTrue(distanceNm > 11 && distanceNm < 13, `distanceNm should be about 12 NM, got ${distanceNm}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('large file: finds firstFuelRow via forward scan when beyond head chunk', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-quickpeek-'));
  const filePath = path.join(tmpDir, 'large.csv');
  try {
    // Fuel first appears at 48 KB — beyond the 32 KB head window.
    // minSize ensures the total file exceeds 64 KB (the small-file threshold).
    const FUEL_OFFSET = PEEK_BYTES + 16 * 1024; // 48 KB
    const csv = buildLargeCsv(FUEL_OFFSET, 800, 300, PEEK_BYTES * 2 + 4096);
    fs.writeFileSync(filePath, csv, 'utf8');
    const stat = fs.statSync(filePath);
    assertTrue(stat.size > PEEK_BYTES * 2, 'fixture should be a large file (> 64 KB)');

    const { firstFuelRow, lastFuelRow } = _quickPeekCSV(filePath);
    assertTrue(firstFuelRow != null, `firstFuelRow should be non-null for large file (size=${stat.size})`);
    assertTrue(lastFuelRow != null, 'lastFuelRow should be non-null for large file');

    const start = parseFloat(firstFuelRow.fuel_total_gal);
    const end = parseFloat(lastFuelRow.fuel_total_gal);
    assertEqual(start, 800, 'firstFuelRow fuel should be 800');
    assertEqual(end, 300, 'lastFuelRow fuel should be 300');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('large file: fuelBurnGal is correct after forward scan fix', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-quickpeek-'));
  const filePath = path.join(tmpDir, 'large-burn.csv');
  try {
    // Fuel first appears deep in the tail region — beyond head + bounded middle scans.
    // minSize ensures the file is > 64 KB but the fuel appears near the end.
    const MIN_FILE = PEEK_BYTES * 3; // 96 KB
    const FUEL_OFFSET = MIN_FILE - PEEK_BYTES / 2; // fuel in the tail chunk
    const csv = buildLargeCsv(FUEL_OFFSET, 499, 0, MIN_FILE);
    fs.writeFileSync(filePath, csv, 'utf8');
    const stat = fs.statSync(filePath);
    assertTrue(stat.size > PEEK_BYTES * 2, 'fixture must be a large file');

    const { firstFuelRow, lastFuelRow } = _quickPeekCSV(filePath);
    assertTrue(firstFuelRow != null, `firstFuelRow must not be null (file size=${stat.size})`);

    const start = parseFloat(firstFuelRow.fuel_total_gal);
    const end = parseFloat(lastFuelRow.fuel_total_gal);
    const burn = start - end;
    assertTrue(burn > 0, `fuelBurnGal should be positive, got ${burn}`);
    assertEqual(start, 499, 'fuelStartGal should be 499');
    assertEqual(end, 0, 'fuelEndGal should be 0');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('fuel gallons increase but fuel weight decreases uses recorded fuel density', () => {
  const summary = summarizeFuelUsage(
    { fuel_total_gal: 200, fuel_total_weight_lbs: 1400, fuel_weight_per_gal: 7 },
    { fuel_total_gal: 205, fuel_total_weight_lbs: 700, fuel_weight_per_gal: 7 },
  );

  assertEqual(summary.fuelBurnSource, 'fuel_total_weight', 'fuel burn should prefer fuel-weight delta');
  assertEqual(summary.fuelBurnGal, 100, 'fuel burn should use the recorded fuel weight per gallon');
  assertEqual(summary.fuelBurnWeightLbs, 700, 'fuel burn should preserve authoritative mass');
});

test('large file: parked fuel-total jump without gross-weight increase uses pre-jump fuel row', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-quickpeek-'));
  const filePath = path.join(tmpDir, 'tail-fuel-jump.csv');
  try {
    const csv = buildTailFuelJumpCsv();
    fs.writeFileSync(filePath, csv, 'utf8');
    const stat = fs.statSync(filePath);
    assertTrue(stat.size > PEEK_BYTES * 2, 'tail-jump fixture must be a large file');

    const { firstFuelRow, lastFuelRow } = _quickPeekCSV(filePath);
    const summary = summarizeFuelUsage(firstFuelRow, lastFuelRow);

    assertEqual(Number(firstFuelRow.fuel_total_gal), 15800.2, 'first fuel row should be the flight start fuel');
    assertEqual(Number(lastFuelRow.fuel_total_gal), 8808.8, 'last fuel row should ignore the parked telemetry jump');
    assertEqual(summary.fuelBurnSource, 'fuel_total_gal', 'fuel burn should remain direct gallon telemetry');
    assertEqual(summary.fuelBurnGal, 6991.4, 'fuel burn should use the pre-jump fuel total');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('mass-only X-Plane fuel rows stop at a post-flight refuel', () => {
  const { firstFuelRow, lastFuelRow } = selectFuelUsageRows([
    { fuel_total_weight_lbs: 2200 },
    { fuel_total_weight_lbs: 1500 },
    { fuel_total_weight_lbs: 2600 },
  ]);
  const summary = summarizeFuelUsage(firstFuelRow, lastFuelRow);

  assertEqual(lastFuelRow.fuel_total_weight_lbs, 1500, 'last row should remain before the mass-only refuel');
  assertEqual(summary.fuelBurnSource, 'fuel_total_weight', 'mass-only burn should remain authoritative');
  assertEqual(summary.fuelBurnWeightLbs, 700, 'burn should use start mass minus pre-refuel mass');
});

test('large file: long parked fuel-total jump tail uses backward scan pre-jump fuel row', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-quickpeek-'));
  const filePath = path.join(tmpDir, 'long-tail-fuel-jump.csv');
  try {
    const csv = buildTailFuelJumpCsv(PEEK_BYTES * 3, 600);
    fs.writeFileSync(filePath, csv, 'utf8');
    const stat = fs.statSync(filePath);
    assertTrue(stat.size > PEEK_BYTES * 3, 'long tail-jump fixture must be larger than the tail-only window');

    const { firstFuelRow, lastFuelRow } = _quickPeekCSV(filePath);
    const summary = summarizeFuelUsage(firstFuelRow, lastFuelRow);

    assertEqual(Number(firstFuelRow.fuel_total_gal), 15800.2, 'first fuel row should be the flight start fuel');
    assertEqual(Number(lastFuelRow.fuel_total_gal), 8808.8, 'last fuel row should come from before the long parked telemetry jump');
    assertEqual(summary.fuelBurnSource, 'fuel_total_gal', 'fuel burn should remain direct gallon telemetry');
    assertEqual(summary.fuelBurnGal, 6991.4, 'fuel burn should use the pre-jump fuel total');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('large file: fuel jump tail beyond sampled window still uses pre-jump fuel row', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-quickpeek-'));
  const filePath = path.join(tmpDir, 'sample-window-fuel-jump.csv');
  try {
    const csv = buildLongSampledTailFuelJumpCsv();
    fs.writeFileSync(filePath, csv, 'utf8');
    const stat = fs.statSync(filePath);
    assertTrue(stat.size > PEEK_BYTES * 258, 'fixture must exceed the old recent-fuel sampling window');

    const { firstFuelRow, lastFuelRow } = _quickPeekCSV(filePath);
    const summary = summarizeFuelUsage(firstFuelRow, lastFuelRow);

    assertEqual(Number(firstFuelRow.fuel_total_gal), 2855.4, 'first fuel row should be the flight start fuel');
    assertEqual(Number(lastFuelRow.fuel_total_gal), 950.7, 'last fuel row should come from before the long bad fuel tail');
    assertEqual(summary.fuelBurnSource, 'fuel_total_gal', 'fuel burn should remain direct gallon telemetry');
    assertEqual(summary.fuelBurnGal, 1904.7, 'fuel burn should use the pre-jump fuel total');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('fuel gallons increase without fuel-weight telemetry does not infer burn from gross weight', () => {
  const summary = summarizeFuelUsage(
    { fuel_total_gal: 15800.2, gross_weight_lbs: 417160 },
    { fuel_total_gal: 15901.0, gross_weight_lbs: 370316 },
  );

  assertEqual(summary.fuelBurnSource, null, 'gross weight alone should not be a fuel-burn source');
  assertEqual(summary.fuelBurnGal, null, 'gross weight alone should not infer fuel burn');
});

test('unchanged or near-zero gallon telemetry does not publish fake burn', () => {
  const unchanged = summarizeFuelUsage(
    { fuel_total_gal: 0 },
    { fuel_total_gal: 0 },
  );
  assertEqual(unchanged.fuelBurnSource, null, 'constant zero gallon telemetry should not be a fuel-burn source');
  assertEqual(unchanged.fuelBurnGal, null, 'constant zero gallon telemetry should not render Burn 0');

  const noise = summarizeFuelUsage(
    { fuel_total_gal: 500.2 },
    { fuel_total_gal: 499.7 },
  );
  assertEqual(noise.fuelBurnSource, null, 'tiny gallon deltas should be treated as telemetry noise');
  assertEqual(noise.fuelBurnGal, null, 'tiny gallon deltas should not render a fake burn');
});

test('parked refuel jump with matching gross-weight increase still uses pre-refuel fuel row', () => {
  const { firstFuelRow, lastFuelRow } = selectFuelUsageRows([
    {
      timestamp_utc: '2026-07-09T14:05:10.551Z',
      phase: PHASES.TAXI,
      fuel_total_gal: 1275.6,
      fuel_total_weight_lbs: 8546.5,
      fuel_weight_per_gal: 6.7,
      gross_weight_lbs: 74846,
    },
    {
      timestamp_utc: '2026-07-09T15:07:08.975Z',
      phase: PHASES.PARKED,
      fuel_total_gal: 852.7,
      fuel_total_weight_lbs: 5713.3,
      fuel_weight_per_gal: 6.7,
      gross_weight_lbs: 72013,
    },
    {
      timestamp_utc: '2026-07-09T15:07:10.053Z',
      phase: PHASES.PARKED,
      fuel_total_gal: 1549.5,
      fuel_total_weight_lbs: 10381.6,
      fuel_weight_per_gal: 6.7,
      gross_weight_lbs: 80234,
    },
  ]);
  const summary = summarizeFuelUsage(firstFuelRow, lastFuelRow);

  assertEqual(Number(lastFuelRow.fuel_total_gal), 852.7, 'last fuel row should stop before the parked refuel jump');
  assertEqual(summary.fuelBurnSource, 'fuel_total_gal', 'pre-refuel total-fuel telemetry should remain the burn source');
  assertEqual(summary.fuelBurnGal, 422.9, 'burn should use start fuel minus pre-refuel parked fuel');
});

test('large file: no fuel at all returns null firstFuelRow (no crash)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-quickpeek-'));
  const filePath = path.join(tmpDir, 'no-fuel.csv');
  try {
    // Create a large file with absolutely no fuel data
    const headerLine = HEADERS.join(',') + '\n';
    let csv = headerLine;
    let ts = 1700000000000;
    for (let i = 0; i < 2000; i++) {
      csv += makeRow({ ts, elapsedMs: i * 1000 }) + '\n';
      ts += 1000;
    }
    fs.writeFileSync(filePath, csv, 'utf8');
    const stat = fs.statSync(filePath);
    assertTrue(stat.size > PEEK_BYTES * 2, 'no-fuel fixture must be a large file');

    const { firstFuelRow, lastFuelRow } = _quickPeekCSV(filePath);
    assertEqual(firstFuelRow, null, 'firstFuelRow should be null when no fuel in file');
    assertEqual(lastFuelRow, null, 'lastFuelRow should be null when no fuel in file');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log('\n=== quickPeekCSV Large-File Fuel Scan Tests ===');
summary('quickPeekCSV fuel scan tests');
