'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const test = require('node:test') as typeof import('node:test');
const { FlightCSVWriter } = require('./flight-csv-writer.js');
const { AutomationJsonlRecorder } = require('./automation-jsonl-recorder.js');
const { AircraftSpecificJsonlRecorder } = require('./aircraft-specific-jsonl-recorder.js');
const { inspectFlatFlightLogs, migrateFlatFlightLogs } = require('./flat-flight-log-migration.js');
const layout = require('./recording-bundle-layout.js');
const { acquireRecordingBundleLease } = require('./recording-bundle-lease.js');
const {
  inspectCsvBundleForCatalogSync,
  publishRecordingBundleStatus,
} = require('./recording-bundle-status.js');

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('one-off migration republishes a strict flat recording as one certified bundle', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-flat-migration-strict-'));
  const startMs = Date.parse('2026-07-22T10:42:00.000Z');
  const identity = {
    flightId: 'pre-release-test-flight',
    recordingSessionId: crypto.randomUUID(),
    recordingStartEpochMs: startMs,
    recordingStartIso: new Date(startMs).toISOString(),
  };
  const sourceBundleName = 'temporary-source-bundle';
  const options = {
    ...identity,
    outputDir: root,
    bundleBaseName: sourceBundleName,
    bundleStatusRequired: true,
  };
  const csv = new FlightCSVWriter(options);
  const automation = new AutomationJsonlRecorder(options);
  const aircraft = new AircraftSpecificJsonlRecorder(options);
  try {
    assert(csv.start() && automation.start() && aircraft.start());
    assert(csv.writeSample({ timestampMs: startMs, phase: 'PREFLIGHT', lat: -37.67, lon: 144.84 }));
    assert(automation.recordAutopilotState({
      timeMs: startMs,
      fdm: { apMaster: false },
      baseFdm: { apMaster: false },
      simconnect: { connected: true },
    }));
    assert(aircraft.recordAircraftSpecificState({
      timeMs: startMs,
      profileKey: 'bundled/msfs/test',
      fieldCatalog: [{ id: 'controls.speedSelected', valueType: 'number' }],
      values: { 'controls.speedSelected': 220 },
      unavailable: [],
      sourceStatus: { overall: 'connected', sources: { simvar: 'connected' } },
    }));
    const [csvStats] = await Promise.all([
      csv.close(),
      automation.close({ timeMs: startMs + 1_000, endReason: 'migration_fixture' }),
      aircraft.close({ timeMs: startMs + 1_000, endReason: 'migration_fixture' }),
    ]);
    await publishRecordingBundleStatus({
      ...options,
      status: 'complete',
      finalizedAtEpochMs: startMs + 1_000,
      finalizedAtIso: new Date(startMs + 1_000).toISOString(),
      endReason: 'migration_fixture',
    });

    const sourcePaths = layout.getBundlePaths(root, sourceBundleName);
    const legacyBase = '2026-07-22T10-42-00_test';
    const legacy = {
      csv: path.join(root, `${legacyBase}.csv`),
      automation: path.join(root, `${legacyBase}.automation.jsonl`),
      aircraftSpecific: path.join(root, `${legacyBase}.aircraft-specific.jsonl`),
      status: path.join(root, `${legacyBase}.bundle-status.json`),
      summary: path.join(root, `${legacyBase}.history-summary.json`),
    };
    fs.renameSync(sourcePaths.csv, legacy.csv);
    fs.renameSync(sourcePaths.automation, legacy.automation);
    fs.renameSync(sourcePaths.aircraftSpecific, legacy.aircraftSpecific);
    fs.renameSync(sourcePaths.status, legacy.status);
    fs.rmdirSync(sourcePaths.dir);
    fs.writeFileSync(legacy.summary, `${JSON.stringify({
      schemaVersion: 1,
      analysisVersion: 1,
      source: { csvBasename: path.basename(legacy.csv) },
      flight: { flightId: identity.flightId, aircraft: 'Migration Test' },
      landings: [],
    })}\n`);
    const rawHashes = {
      csv: sha256(legacy.csv),
      automation: sha256(legacy.automation),
      aircraftSpecific: sha256(legacy.aircraftSpecific),
    };

    const result = await migrateFlatFlightLogs(root);
    assert.equal(result.failed, 0, JSON.stringify(result));
    assert.equal(result.migrated, 1);
    const destinationName = result.details[0].destination!;
    const destination = layout.getBundlePaths(root, destinationName);
    assert.equal(fs.existsSync(legacy.csv), false);
    assert.equal(fs.existsSync(legacy.automation), false);
    assert.equal(fs.existsSync(legacy.aircraftSpecific), false);
    assert.equal(fs.existsSync(legacy.status), false);
    assert.equal(fs.existsSync(legacy.summary), false);
    assert.deepEqual(layout.listBundleCsvPaths(root), [destination.csv]);
    assert.equal(sha256(destination.csv), rawHashes.csv);
    assert.equal(sha256(destination.automation), rawHashes.automation);
    assert.equal(sha256(destination.aircraftSpecific), rawHashes.aircraftSpecific);
    assert.equal(fs.existsSync(destination.summary), true);
    const catalog = inspectCsvBundleForCatalogSync(destination.csv);
    assert.equal(catalog.allowed, true, catalog.error || 'migrated strict bundle must validate');
    assert.equal(catalog.recordingSessionId, identity.recordingSessionId);
    assert.equal(csvStats.recordingSessionId, identity.recordingSessionId);
  } finally {
    if (!csv.closed) await csv.close();
    if (!automation.closed) await automation.close({ endReason: 'test_cleanup' });
    if (!aircraft.closed) await aircraft.close({ endReason: 'test_cleanup' });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('one-off migration keeps an older non-strict CSV readable without production legacy discovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-flat-migration-legacy-'));
  try {
    const legacyCsv = path.join(root, '2026-01-02T03-04-05_legacy.csv');
    fs.writeFileSync(legacyCsv, [
      'record_type,flight_id,flight_start_iso,timestamp_utc,ts,lat_deg,lon_deg',
      'SAMPLE,legacy-flight,2026-01-02T03:04:05.000Z,2026-01-02T03:04:05.000Z,1767323045000,-37.67,144.84',
    ].join('\n') + '\n');

    assert.deepEqual(layout.listBundleCsvPaths(root), [], 'production discovery must ignore pre-migration flat files');
    const result = await migrateFlatFlightLogs(root);
    assert.equal(result.failed, 0, JSON.stringify(result));
    assert.equal(result.migrated, 1);
    assert.equal(fs.existsSync(legacyCsv), false);
    const migrated = layout.listBundleCsvPaths(root);
    assert.equal(migrated.length, 1);
    assert.equal(fs.readFileSync(migrated[0], 'utf8').includes('legacy-flight'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dry-run validates flat recordings without changing their files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-flat-migration-dry-run-'));
  try {
    const csvPath = path.join(root, 'dry-run.csv');
    fs.writeFileSync(csvPath, [
      'record_type,flight_id,flight_start_iso,timestamp_utc',
      'SAMPLE,dry-run-flight,2026-01-02T03:04:05.000Z,2026-01-02T03:04:05.000Z',
    ].join('\n') + '\n');
    const before = sha256(csvPath);
    const result = inspectFlatFlightLogs(root);
    assert.equal(result.ready, 1);
    assert.equal(result.failed, 0, JSON.stringify(result));
    assert.equal(result.totalBytes, fs.statSync(csvPath).size);
    assert.equal(fs.existsSync(csvPath), true);
    assert.equal(sha256(csvPath), before);
    assert.deepEqual(layout.listBundleCsvPaths(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration refuses to run while any recording bundle lease exists', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-flat-migration-busy-'));
  const csvPath = path.join(root, 'busy.csv');
  fs.writeFileSync(csvPath, 'record_type,flight_id,flight_start_iso\nSAMPLE,busy-flight,2026-01-02T03:04:05.000Z\n');
  const lease = acquireRecordingBundleLease({
    outputDir: root,
    baseName: 'active-recording',
    purpose: 'recording',
  });
  assert.equal(lease.acquired, true);
  try {
    assert.throws(
      () => inspectFlatFlightLogs(root),
      /close Flight Fabric and try again/,
    );
    await assert.rejects(
      () => migrateFlatFlightLogs(root),
      /close Flight Fabric and try again/,
    );
    assert.equal(fs.existsSync(csvPath), true);
    assert.deepEqual(layout.listBundleCsvPaths(root), []);
  } finally {
    if (lease.acquired) lease.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration refuses an unowned summary and preserves every flat source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-flat-migration-refusal-'));
  try {
    const csvPath = path.join(root, 'owned.csv');
    const summaryPath = path.join(root, 'owned.history-summary.json');
    fs.writeFileSync(csvPath, 'record_type,flight_id,flight_start_iso\nSAMPLE,owned-flight,2026-01-02T03:04:05.000Z\n');
    fs.writeFileSync(summaryPath, '{"schemaVersion":1,"source":{"csvBasename":"different.csv"},"landings":[]}\n');
    const before = sha256(csvPath);
    const result = await migrateFlatFlightLogs(root);
    assert.equal(result.migrated, 0);
    assert.equal(result.failed, 1);
    assert.equal(fs.existsSync(csvPath), true);
    assert.equal(fs.existsSync(summaryPath), true);
    assert.equal(sha256(csvPath), before);
    assert.deepEqual(layout.listBundleCsvPaths(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

export {};
