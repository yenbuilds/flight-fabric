'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { getBundlePaths } = require('../flight-recording/recording-bundle-layout.js');
const {
  HISTORY_ANALYSIS_VERSION,
  getHistorySummaryPath,
  isOwnedHistorySummaryForCsv,
  readHistorySummary,
  writeHistorySummary,
} = require('./history-summary-sidecar.js');

test('history summary analysis contract is bumped for recorded bounce authority', () => {
  assert.equal(HISTORY_ANALYSIS_VERSION, 10);
});

test('history summary sidecar round-trips portable flight and landing metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-history-summary-'));
  try {
    const paths = getBundlePaths(root, '2026-07-22_10-42-00Z--12345678');
    fs.mkdirSync(paths.dir);
    const csvPath = paths.csv;
    fs.writeFileSync(csvPath, 'record_type,ts\nSAMPLE,1\n');
    const stat = fs.statSync(csvPath);
    const source = { filePath: csvPath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };

    assert.equal(writeHistorySummary(source, {
      flight: {
        filePath: csvPath,
        flightId: 'flight_123',
        aircraft: 'Test Aircraft',
        displayRouteLabel: 'YMML → YSSY',
      },
      landings: [{ id: 'landing-1', timestampMs: 123, vsFpm: -164 }],
    }), true);

    const summaryPath = getHistorySummaryPath(csvPath);
    assert.equal(isOwnedHistorySummaryForCsv(summaryPath, csvPath), true);
    const restored = readHistorySummary(source);
    assert.equal(restored.flight.filePath, csvPath);
    assert.equal(restored.flight.aircraft, 'Test Aircraft');
    assert.equal(restored.landings.length, 1);
    assert.equal(restored.landings[0].vsFpm, -164);

    const raw = fs.readFileSync(summaryPath, 'utf8');
    assert.equal(raw.includes(csvPath), false, 'portable summary must not persist an absolute CSV path');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('history summary sidecar is rejected when the authoritative CSV identity changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-history-summary-stale-'));
  try {
    const paths = getBundlePaths(root, '2026-07-22_11-42-00Z--87654321');
    fs.mkdirSync(paths.dir);
    const csvPath = paths.csv;
    fs.writeFileSync(csvPath, 'record_type,ts\nSAMPLE,1\n');
    const first = fs.statSync(csvPath);
    const source = { filePath: csvPath, mtimeMs: first.mtimeMs, sizeBytes: first.size };
    assert.equal(writeHistorySummary(source, { flight: null, landings: [] }), true);

    fs.appendFileSync(csvPath, 'SAMPLE,2\n');
    const changed = fs.statSync(csvPath);
    assert.equal(readHistorySummary({
      filePath: csvPath,
      mtimeMs: changed.mtimeMs,
      sizeBytes: changed.size,
    }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('history summary sidecar rejects an unchanged source analyzed by the prior contract', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-history-summary-analysis-'));
  try {
    const paths = getBundlePaths(root, '2026-08-07_01-02-03Z--11223344');
    fs.mkdirSync(paths.dir);
    const csvPath = paths.csv;
    fs.writeFileSync(csvPath, 'record_type,ts\nLANDING,1\n');
    const stat = fs.statSync(csvPath);
    const source = { filePath: csvPath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
    assert.equal(writeHistorySummary(source, { flight: null, landings: [] }), true);

    const summaryPath = getHistorySummaryPath(csvPath);
    const stale = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    stale.analysisVersion = HISTORY_ANALYSIS_VERSION - 1;
    fs.writeFileSync(summaryPath, JSON.stringify(stale), 'utf8');

    assert.equal(readHistorySummary(source), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

export {};
