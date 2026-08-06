'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const test = require('node:test') as typeof import('node:test');
const { EventEmitter } = require('node:events') as typeof import('node:events');

const timeSource = require('../core/time-source.js') as typeof import('../core/time-source');
const { parseCsvLine, splitCsvLines } = require('../utils/csv.js');
const {
  FlightCSVWriter,
  WorkerFlightCSVWriter,
  startFlight: startCsvFlight,
  endFlight: endCsvFlight,
  isRecording: isCsvRecording,
  generateFilename: generateCsvFilename,
  DEFAULT_MAX_CSV_FILE_BYTES,
} = require('./flight-csv-writer.js');
const {
  AutomationJsonlRecorder,
  DEFAULT_MAX_AUTOMATION_FILE_BYTES,
} = require('./automation-jsonl-recorder.js');
const { readAutomationRowsForCsv } = require('./automation-jsonl-reader.js');
const aircraftRecorderModule = require('./aircraft-specific-jsonl-recorder.js');
const bundleLifecycle = require('./recording-bundle-lifecycle.js');
const { closeWriteStreamDurably } = require('./recording-stream-durability.js');

type AnyRecord = Record<string, any>;

function readJsonl(filePath: string): AnyRecord[] {
  return fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function readCsvRows(filePath: string): AnyRecord[] {
  const lines = splitCsvLines(fs.readFileSync(filePath, 'utf8'), { trimAndDropEmpty: true });
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line: string) => {
    const values = parseCsvLine(line);
    assert.equal(values.length, headers.length);
    return Object.fromEntries(headers.map((header: string, index: number) => [header, values[index]]));
  });
}

test('same-second flight IDs allocate distinct whole-bundle basenames', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bundle-collision-'));
  try {
    const firstId = '2026-07-20T01:02:03.100Z';
    const secondId = '2026-07-20T01:02:03.900Z';
    const firstPreferred = path.basename(generateCsvFilename(firstId, null, null), '.csv');
    const secondPreferred = path.basename(generateCsvFilename(secondId, null, null), '.csv');
    assert.equal(firstPreferred, secondPreferred, 'legacy filename projection should demonstrate the collision');
    const first = bundleLifecycle.allocateBundleBaseName(outputDir, firstPreferred);
    fs.mkdirSync(path.join(outputDir, first));
    fs.writeFileSync(bundleLifecycle.bundlePaths(outputDir, first)[1], '{}\n');
    const second = bundleLifecycle.allocateBundleBaseName(outputDir, secondPreferred);
    assert.equal(second, `${first}-2`);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('failed startup cleanup never removes the CSV while an owned companion remains', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bundle-cleanup-order-'));
  const bundleBaseName = 'cleanup-order';
  const filePaths = bundleLifecycle.bundlePaths(outputDir, bundleBaseName);
  fs.mkdirSync(path.dirname(filePaths[0]));
  const artifacts = filePaths.map((filePath: string) => {
    fs.writeFileSync(filePath, 'owned\n');
    const stat = fs.statSync(filePath);
    return { filePath, creationIdentity: { dev: stat.dev, ino: stat.ino } };
  });
  const failingPath = filePaths.find((filePath: string) => filePath.endsWith('aircraft-specific.jsonl'));
  const csvPath = filePaths.find((filePath: string) => filePath.endsWith('.csv'));
  const originalUnlinkSync = fs.unlinkSync;
  (fs as any).unlinkSync = (filePath: import('fs').PathLike) => {
    if (path.resolve(String(filePath)) === path.resolve(String(failingPath))) {
      const error = new Error('simulated cleanup failure') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    }
    return originalUnlinkSync(filePath);
  };
  try {
    assert.throws(
      () => bundleLifecycle.discardUncommittedBundle(outputDir, bundleBaseName, artifacts),
      /simulated cleanup failure/,
    );
    for (const filePath of filePaths) {
      assert.equal(fs.existsSync(filePath), true, 'failed staging must roll the complete visible bundle back');
    }
    assert.equal(fs.existsSync(String(failingPath)), true);
    assert.equal(fs.existsSync(String(csvPath)), true);
  } finally {
    (fs as any).unlinkSync = originalUnlinkSync;
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('bundle finalization ownership always requires the exact recording session UUID', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bundle-owner-id-'));
  const recordingSessionId = crypto.randomUUID();
  try {
    bundleLifecycle.resetRecordingBundleLifecycleForTests();
    bundleLifecycle.beginRecordingBundle({
      recordingSessionId,
      flightId: 'physical-flight',
      recordingStartEpochMs: 0,
      recordingStartIso: new Date(0).toISOString(),
      outputDir,
      baseName: 'owner-id',
      csvPath: bundleLifecycle.bundlePaths(outputDir, 'owner-id')[0],
    });
    assert.throws(() => bundleLifecycle.markRecordingBundleFinalizing(''), /identity is required/);
    assert.throws(() => bundleLifecycle.markRecordingBundleFinalizing('wrong'), /identity mismatch/);
    bundleLifecycle.markRecordingBundleFinalizing(recordingSessionId);
    assert.throws(() => bundleLifecycle.markRecordingBundleFinalizing('wrong'), /identity mismatch/);
    assert.throws(() => bundleLifecycle.finishRecordingBundle(''), /identity is required/);
    assert.throws(() => bundleLifecycle.finishRecordingBundle('wrong'), /identity mismatch/);
    bundleLifecycle.finishRecordingBundle(recordingSessionId);
    assert.equal(bundleLifecycle.getFinalizingRecordingBundle(), null);
  } finally {
    bundleLifecycle.resetRecordingBundleLifecycleForTests();
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('bundle startup ownership promotes atomically and protects its CSV path before commit', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bundle-startup-owner-'));
  const recordingSessionId = crypto.randomUUID();
  const csvPath = bundleLifecycle.bundlePaths(outputDir, 'startup-owner')[0];
  try {
    bundleLifecycle.resetRecordingBundleLifecycleForTests();
    bundleLifecycle.beginRecordingBundleStartup({
      recordingSessionId,
      flightId: 'startup-owner-flight',
      recordingStartEpochMs: 0,
      recordingStartIso: new Date(0).toISOString(),
      outputDir,
      baseName: 'startup-owner',
      csvPath,
    });

    assert.equal(bundleLifecycle.isOwnedRecordingBundleCsvPath(csvPath), true);
    assert.match(bundleLifecycle.getRecordingBundleStartBlocker(), /starting or rolling back/);
    assert.throws(
      () => bundleLifecycle.commitRecordingBundleStartup('wrong-session'),
      /identity mismatch/,
    );
    assert.equal(bundleLifecycle.getStartingRecordingBundle()?.recordingSessionId, recordingSessionId);

    const active = bundleLifecycle.commitRecordingBundleStartup(recordingSessionId);
    assert.equal(active.recordingSessionId, recordingSessionId);
    assert.equal(bundleLifecycle.getStartingRecordingBundle(), null);
    assert.equal(bundleLifecycle.getActiveRecordingBundle()?.recordingSessionId, recordingSessionId);
    assert.equal(bundleLifecycle.isOwnedRecordingBundleCsvPath(csvPath), true);

    bundleLifecycle.markRecordingBundleFinalizing(recordingSessionId);
    bundleLifecycle.finishRecordingBundle(recordingSessionId);
    assert.equal(bundleLifecycle.isOwnedRecordingBundleCsvPath(csvPath), false);
  } finally {
    bundleLifecycle.resetRecordingBundleLifecycleForTests();
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('inline CSV post-claim header failure closes and removes only its owned inode', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-inline-start-failure-'));
  const startMs = Date.parse('2026-07-20T00:30:00.000Z');
  const terminalErrors: Error[] = [];
  const writer = new FlightCSVWriter({
    flightId: 'inline-start-failure',
    recordingSessionId: crypto.randomUUID(),
    recordingStartEpochMs: startMs,
    recordingStartIso: new Date(startMs).toISOString(),
    bundleBaseName: 'inline-start-failure',
    outputDir,
    onTerminalError: (error: Error) => terminalErrors.push(error),
  });
  const originalWriteSync = fs.writeSync;
  (fs as any).writeSync = () => {
    const error = new Error('simulated header write failure') as NodeJS.ErrnoException;
    error.code = 'EIO';
    throw error;
  };
  try {
    assert.equal(writer.start(), false);
  } finally {
    (fs as any).writeSync = originalWriteSync;
  }
  try {
    assert.equal(terminalErrors.length, 1);
    assert.equal(fs.existsSync(writer.filePath), false, 'failed header claim must not leave an orphan');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('inline and worker CSV startup durably commit the same immutable identity manifest', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-csv-start-manifest-'));
  const startMs = Date.parse('2026-07-20T00:45:00.000Z');
  const startIso = new Date(startMs).toISOString();
  const recordingSessionId = crypto.randomUUID();
  const originalFdatasyncSync = fs.fdatasyncSync;
  let inlineStartupSyncs = 0;
  try {
    for (const [label, Writer] of [
      ['inline', FlightCSVWriter],
      ['worker', WorkerFlightCSVWriter],
    ] as const) {
      const writer = new Writer({
        flightId: 'csv-start-manifest-flight',
        recordingSessionId,
        recordingStartEpochMs: startMs,
        recordingStartIso: startIso,
        bundleBaseName: `csv-start-manifest-${label}`,
        outputDir,
      });
      if (label === 'inline') {
        (fs as any).fdatasyncSync = (fd: number) => {
          inlineStartupSyncs += 1;
          return originalFdatasyncSync(fd);
        };
      }
      assert.equal(
        writer.writeSample({
          flightId: 'pre-start-poison',
          recordingSessionId: 'pre-start-poison',
          schemaVersion: 999,
        }),
        false,
        `${label} must reject pre-start data without poisoning manifest compaction state`,
      );
      try {
        assert.equal(writer.start(), true);
      } finally {
        (fs as any).fdatasyncSync = originalFdatasyncSync;
      }

      const rows = readCsvRows(writer.filePath);
      assert.equal(rows.length, 1, `${label} startup must expose exactly one complete identity row`);
      assert.deepEqual({
        record_type: rows[0].record_type,
        sample_index: rows[0].sample_index,
        schema_version: rows[0].schema_version,
        recording_session_id: rows[0].recording_session_id,
        flight_id: rows[0].flight_id,
        flight_start_iso: rows[0].flight_start_iso,
        flight_elapsed_ms: rows[0].flight_elapsed_ms,
        timestamp_monotonic: rows[0].timestamp_monotonic,
        ts: rows[0].ts,
        timestamp_utc: rows[0].timestamp_utc,
        recorded_at_ms: rows[0].recorded_at_ms,
        recorded_at_utc: rows[0].recorded_at_utc,
      }, {
        record_type: 'RECORDING_MANIFEST',
        sample_index: '0',
        schema_version: '3',
        recording_session_id: recordingSessionId,
        flight_id: 'csv-start-manifest-flight',
        flight_start_iso: startIso,
        flight_elapsed_ms: '0',
        timestamp_monotonic: '0',
        ts: String(startMs),
        timestamp_utc: startIso,
        recorded_at_ms: String(startMs),
        recorded_at_utc: startIso,
      });
      const manifestFields = new Set([
        'record_type',
        'sample_index',
        'schema_version',
        'recording_session_id',
        'bundle_status_required',
        'flight_id',
        'flight_start_iso',
        'flight_elapsed_ms',
        'timestamp_monotonic',
        'ts',
        'timestamp_utc',
        'recorded_at_ms',
        'recorded_at_utc',
      ]);
      for (const [field, value] of Object.entries(rows[0])) {
        if (!manifestFields.has(field)) {
          assert.equal(value, '', `${label} manifest must not fabricate telemetry field ${field}`);
        }
      }
      assert.equal(writer.rowCount, 1);
      assert.equal(writer.nextSampleIndex, 1);
      const stats = await writer.close();
      assert.equal(stats.rowCount, 1, 'close stats count the durable manifest row');
    }
    assert.equal(inlineStartupSyncs, 1, 'inline success must fdatasync the startup identity before returning');
  } finally {
    (fs as any).fdatasyncSync = originalFdatasyncSync;
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('inline startup sync failure removes its exact partially initialized inode', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-csv-start-sync-failure-'));
  const startMs = Date.parse('2026-07-20T00:50:00.000Z');
  const terminalErrors: Error[] = [];
  const writer = new FlightCSVWriter({
    flightId: 'csv-start-sync-failure',
    recordingSessionId: crypto.randomUUID(),
    recordingStartEpochMs: startMs,
    recordingStartIso: new Date(startMs).toISOString(),
    bundleBaseName: 'csv-start-sync-failure',
    outputDir,
    onTerminalError: (error: Error) => terminalErrors.push(error),
  });
  const originalFdatasyncSync = fs.fdatasyncSync;
  (fs as any).fdatasyncSync = () => {
    const error = new Error('simulated startup fdatasync failure') as NodeJS.ErrnoException;
    error.code = 'EIO';
    throw error;
  };
  try {
    assert.equal(writer.start(), false);
  } finally {
    (fs as any).fdatasyncSync = originalFdatasyncSync;
  }
  try {
    assert.equal(terminalErrors.length, 1);
    assert.equal(fs.existsSync(writer.filePath), false);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('CSV and automation writer caps match the 200 MiB reader boundary and reject before overflow', async () => {
  const startMs = Date.parse('2026-07-20T00:55:00.000Z');
  const startIso = new Date(startMs).toISOString();
  assert.equal(DEFAULT_MAX_CSV_FILE_BYTES, 200 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_AUTOMATION_FILE_BYTES, 200 * 1024 * 1024);

  const scenarios = [
    {
      label: 'csv-inline',
      create: (outputDir: string, errors: Error[]) => new FlightCSVWriter({
        flightId: 'cap-csv-inline',
        recordingSessionId: crypto.randomUUID(),
        recordingStartEpochMs: startMs,
        recordingStartIso: startIso,
        bundleBaseName: 'cap-csv-inline',
        outputDir,
        onTerminalError: (error: Error) => errors.push(error),
      }),
      write: (recorder: AnyRecord) => recorder.writeSample({ phase: 'CRUISE' }),
      close: (recorder: AnyRecord) => recorder.close(),
    },
    {
      label: 'csv-worker',
      create: (outputDir: string, errors: Error[]) => new WorkerFlightCSVWriter({
        flightId: 'cap-csv-worker',
        recordingSessionId: crypto.randomUUID(),
        recordingStartEpochMs: startMs,
        recordingStartIso: startIso,
        bundleBaseName: 'cap-csv-worker',
        outputDir,
        onTerminalError: (error: Error) => errors.push(error),
      }),
      write: (recorder: AnyRecord) => recorder.writeSample({ phase: 'CRUISE' }),
      close: (recorder: AnyRecord) => recorder.close(),
    },
    {
      label: 'automation',
      create: (outputDir: string, errors: Error[]) => new AutomationJsonlRecorder({
        flightId: 'cap-automation',
        recordingSessionId: crypto.randomUUID(),
        recordingStartEpochMs: startMs,
        recordingStartIso: startIso,
        bundleBaseName: 'cap-automation',
        outputDir,
        onTerminalError: (error: Error) => errors.push(error),
      }),
      write: (recorder: AnyRecord) => recorder.recordAutopilotState({
        timeMs: startMs,
        fdm: { apMaster: false },
        baseFdm: { apMaster: false },
        simconnect: { connected: true },
      }),
      close: (recorder: AnyRecord) => recorder.close({ timeMs: startMs }),
    },
  ];

  for (const scenario of scenarios) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), `ff-${scenario.label}-cap-`));
    const errors: Error[] = [];
    const recorder = scenario.create(outputDir, errors);
    try {
      assert.equal(recorder.start(), true);
      assert.equal(recorder.maxFileBytes, 200 * 1024 * 1024);
      assert(recorder.acceptedFileBytes > 0, `${scenario.label} startup identity bytes must count toward the cap`);
      // Equality is allowed by the readers and writers. The next complete row
      // would exceed it and must be rejected before any bytes are accepted.
      recorder.maxFileBytes = recorder.acceptedFileBytes;
      const exactBoundary = recorder.acceptedFileBytes;
      assert.equal(scenario.write(recorder), false);
      assert.equal(recorder.acceptedFileBytes, exactBoundary);
      assert.equal(errors.length, 1, `${scenario.label} must notify the bundle exactly once`);
      const stats = await scenario.close(recorder);
      assert.equal(stats.hasError, true);
      assert.equal(fs.statSync(stats.filePath).size, exactBoundary);
    } finally {
      if (!recorder.closed) await scenario.close(recorder);
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }
});

test('CSV and automation startup fail atomically when their identity record exceeds the cap', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-startup-cap-'));
  const startMs = Date.parse('2026-07-20T00:58:00.000Z');
  const options = {
    flightId: 'startup-cap',
    recordingSessionId: crypto.randomUUID(),
    recordingStartEpochMs: startMs,
    recordingStartIso: new Date(startMs).toISOString(),
    outputDir,
    maxFileBytes: 1,
  };
  const recorders = [
    new FlightCSVWriter({ ...options, bundleBaseName: 'startup-cap-inline' }),
    new WorkerFlightCSVWriter({ ...options, bundleBaseName: 'startup-cap-worker' }),
    new AutomationJsonlRecorder({ ...options, bundleBaseName: 'startup-cap-automation' }),
  ];
  try {
    for (const recorder of recorders) {
      assert.equal(recorder.start(), false);
      assert.equal(fs.existsSync(recorder.filePath), false, 'failed capped startup must remove its exact claim');
    }
  } finally {
    await Promise.all(recorders.map((recorder) => recorder.close({} as any)));
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('JSONL close stats never reread the complete recording into memory', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-jsonl-bounded-stats-'));
  const startMs = Date.parse('2026-07-20T00:59:00.000Z');
  const startIso = new Date(startMs).toISOString();
  const common = {
    recordingSessionId: crypto.randomUUID(),
    recordingStartEpochMs: startMs,
    recordingStartIso: startIso,
    outputDir,
  };
  const automation = new AutomationJsonlRecorder({
    ...common,
    flightId: 'bounded-stats-automation',
    bundleBaseName: 'bounded-stats-automation',
  });
  const aircraft = new aircraftRecorderModule.AircraftSpecificJsonlRecorder({
    ...common,
    flightId: 'bounded-stats-aircraft',
    bundleBaseName: 'bounded-stats-aircraft',
  });
  const originalReadFileSync = fs.readFileSync;
  let wholeFileReads = 0;
  try {
    assert(automation.start() && aircraft.start());
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
    const protectedPaths = new Set([automation.filePath, aircraft.filePath].map((value) => path.resolve(value)));
    (fs as any).readFileSync = (filePath: import('fs').PathOrFileDescriptor, ...args: any[]) => {
      if (typeof filePath !== 'number' && protectedPaths.has(path.resolve(String(filePath)))) wholeFileReads += 1;
      return (originalReadFileSync as any)(filePath, ...args);
    };
    const [automationStats, aircraftStats] = await Promise.all([
      automation.close({ timeMs: startMs }),
      aircraft.close({ timeMs: startMs }),
    ]);
    automation.getStats();
    aircraft.getStats();
    assert.equal(wholeFileReads, 0, 'row statistics must stay O(1) at the 200 MiB ceiling');
    assert.equal(automationStats.rowCount, 3);
    assert.equal(aircraftStats.rowCount, 4);
  } finally {
    (fs as any).readFileSync = originalReadFileSync;
    if (!automation.closed) await automation.close({});
    if (!aircraft.closed) await aircraft.close({});
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('CSV and both JSONLs freeze one session, clock, and basename against hostile row metadata', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bundle-envelope-'));
  const startMs = Date.parse('2026-07-20T01:00:00.000Z');
  const startIso = new Date(startMs).toISOString();
  const flightId = 'physical-flight-id';
  const recordingSessionId = crypto.randomUUID();
  const bundleBaseName = 'bundle-envelope';
  const options = { flightId, recordingSessionId, recordingStartEpochMs: startMs, recordingStartIso: startIso, bundleBaseName, outputDir };
  const clock = timeSource.createFixedSource(startMs);
  const csv = new FlightCSVWriter(options);
  const automation = new AutomationJsonlRecorder(options);
  const aircraft = new aircraftRecorderModule.AircraftSpecificJsonlRecorder(options);
  try {
    assert(csv.start() && automation.start() && aircraft.start());
    assert(csv.writeSample({ flightId: 'wrong', sessionId: 'backend-session', flightStartIso: '1999-01-01T00:00:00.000Z', flightElapsedMs: -1 }));
    assert(automation.recordAutopilotState({
      timeMs: startMs - 5000,
      timestampIso: '1999-01-01T00:00:00.000Z',
      flightId: 'wrong',
      flightStartIso: '1999-01-01T00:00:00.000Z',
      flightElapsedMs: 999999,
      fdm: { apMaster: false },
      baseFdm: { apMaster: false },
      simconnect: { connected: true },
    }));
    assert(aircraft.recordAircraftSpecificState({
      timeMs: startMs - 5000,
      timestampIso: '1999-01-01T00:00:00.000Z',
      flightId: 'wrong',
      flightStartIso: '1999-01-01T00:00:00.000Z',
      flightElapsedMs: 999999,
      profileKey: 'bundled/msfs/test',
      fieldCatalog: [{ id: 'controls.speedSelected', valueType: 'number' }],
      values: { 'controls.speedSelected': 220 },
      unavailable: [],
      sourceStatus: { overall: 'connected', sources: { simvar: 'connected' } },
    }));
    clock.advance(1000);
    const hostileEnd = { timeMs: startMs - 1000, flightId: 'wrong-end', flightStartIso: '1998-01-01T00:00:00.000Z', flightElapsedMs: -2 };
    const [csvStats, automationStats, aircraftStats] = await Promise.all([
      csv.close(),
      automation.close(hostileEnd),
      aircraft.close(hostileEnd),
    ]);
    for (const stats of [csvStats, automationStats, aircraftStats]) {
      assert.equal(stats.recordingSessionId, recordingSessionId);
      assert.equal(stats.recordingStartIso, startIso);
      assert.equal(stats.bundleBaseName, bundleBaseName);
      assert.equal(path.basename(path.dirname(stats.filePath)), bundleBaseName);
    }
    assert.deepEqual(
      [csvStats.filePath, automationStats.filePath, aircraftStats.filePath].map((filePath) => path.basename(filePath)),
      ['telemetry.csv', 'automation.jsonl', 'aircraft-specific.jsonl'],
    );

    const [csvManifest, csvRow] = readCsvRows(csvStats.filePath);
    assert.equal(csvManifest.record_type, 'RECORDING_MANIFEST');
    assert.equal(csvRow.flight_id || csvManifest.flight_id, flightId);
    assert.equal(csvRow.session_id, 'backend-session', 'backend session identity must retain its historical meaning');
    assert.equal(csvRow.recording_session_id || csvManifest.recording_session_id, recordingSessionId);
    assert.equal(csvRow.flight_start_iso || csvManifest.flight_start_iso, startIso);
    assert.equal(Number(csvRow.flight_elapsed_ms), 0);
    assert.equal(Number(csvRow.timestamp_monotonic), 0);

    const automationRows = readJsonl(automationStats.filePath);
    assert.equal(automationRows[0].flightId, flightId);
    assert.equal(automationRows[0].recordingSessionId, recordingSessionId);
    assert.equal(automationRows[0].flightStartIso, startIso);
    assert.equal(automationRows[0].flightElapsedMs, 0);
    assert.equal(automationRows[0].timestampIso, startIso);
    for (const row of automationRows.slice(1)) {
      assert.equal(row.flightId, undefined);
      assert.equal(row.recordingSessionId, undefined);
      assert.equal(row.flightStartIso, undefined);
      assert.equal(row.flightElapsedMs, undefined);
      assert.equal(row.timestampIso, undefined);
      assert(Number.isSafeInteger(row.timeMs));
      assert(row.timeMs - startMs >= 0, 'compact automation time must derive a non-negative elapsed clock');
    }
    const aircraftRows = readJsonl(aircraftStats.filePath);
    assert.equal(aircraftRows[0].flightId, flightId);
    assert.equal(aircraftRows[0].recordingSessionId, recordingSessionId);
    assert.equal(aircraftRows[0].flightStartIso, startIso);
    for (const row of aircraftRows.slice(1)) {
      assert.equal(row.flightId, undefined);
      assert.equal(row.recordingSessionId, undefined);
      assert.equal(row.flightStartIso, undefined);
      assert.equal(row.timeMs, undefined);
      assert.equal(row.timestampIso, undefined);
      assert(row.flightElapsedMs >= 0);
    }
    const automationRead = await readAutomationRowsForCsv(csvStats.filePath);
    assert.equal(automationRead.error, undefined, 'a distinct session UUID matching the CSV must be accepted');
    assert.equal(automationRead.rows.length, automationRows.length);

    fs.writeFileSync(
      automationStats.filePath,
      `${automationRows.map((row) => JSON.stringify({ ...row, flightId: 'another-flight' })).join('\n')}\n`,
    );
    const mismatchedRead = await readAutomationRowsForCsv(csvStats.filePath);
    assert.match(mismatchedRead.error || '', /does not match the CSV/);
  } finally {
    timeSource.resetTimeSource();
    if (!csv.closed) await csv.close();
    if (!automation.closed) await automation.close({});
    if (!aircraft.closed) await aircraft.close({});
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('durable close waits for close after an earlier stream error', async () => {
  class FakeStream extends EventEmitter {
    destroyed = false;
    closed = false;
    fd = 123;
    write(_chunk: string, callback: (error?: Error | null) => void) { callback(); return true; }
    end() {
      queueMicrotask(() => this.emit('error', new Error('simulated EIO')));
      setTimeout(() => {
        this.closed = true;
        this.emit('close');
      }, 20);
    }
    destroy() {}
  }
  const fake = new FakeStream();
  const originalFdatasync = fs.fdatasync;
  (fs as any).fdatasync = (_fd: number, callback: (error?: Error | null) => void) => callback();
  try {
    let settled = false;
    const closing = closeWriteStreamDurably(fake as any).finally(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'error must not release finalization ownership before close');
    await assert.rejects(closing, /simulated EIO/);
    assert.equal(fake.closed, true);
  } finally {
    (fs as any).fdatasync = originalFdatasync;
  }
});

test('inline CSV close waits for an in-progress periodic fdatasync', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-inline-periodic-sync-'));
  const startMs = Date.parse('2026-07-20T01:30:00.000Z');
  const clock = timeSource.createFixedSource(startMs);
  const writer = new FlightCSVWriter({
    flightId: 'inline-periodic-sync',
    recordingSessionId: crypto.randomUUID(),
    recordingStartEpochMs: startMs,
    recordingStartIso: new Date(startMs).toISOString(),
    bundleBaseName: 'inline-periodic-sync',
    outputDir,
    syncIntervalMs: 0,
  });
  const originalFdatasync = fs.fdatasync;
  let fdatasyncCalls = 0;
  let releasePeriodicSync: ((error?: NodeJS.ErrnoException | null) => void) | null = null;
  (fs as any).fdatasync = (
    _fd: number,
    callback: (error?: NodeJS.ErrnoException | null) => void,
  ) => {
    fdatasyncCalls += 1;
    if (fdatasyncCalls === 1) {
      releasePeriodicSync = callback;
      return;
    }
    callback();
  };
  try {
    assert.equal(writer.start(), true);
    const stream = writer.stream as any;
    const originalWrite = stream.write.bind(stream);
    let releaseWriteBarrier: (() => void) | null = null;
    let delayedBarrier = false;
    stream.write = (chunk: unknown, ...args: unknown[]) => {
      if (chunk === '' && !delayedBarrier) {
        delayedBarrier = true;
        releaseWriteBarrier = () => { originalWrite('', ...args); };
        return true;
      }
      return originalWrite(chunk, ...args);
    };
    assert.equal(writer.writeSample({}), true);
    assert(releaseWriteBarrier, 'the due sync must first enqueue a WriteStream ordering barrier');
    assert.equal(fdatasyncCalls, 0, 'fdatasync must not start before prior row write callbacks drain');

    let settled = false;
    const closing = writer.close().finally(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'close must retain the stream until the periodic sync completes');
    releaseWriteBarrier();
    for (let attempt = 0; attempt < 20 && !releasePeriodicSync; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert(releasePeriodicSync, 'fdatasync must start after the write-queue barrier is released');
    releasePeriodicSync();
    const stats = await closing;
    assert.equal(stats.rowCount, 2);
    assert(fdatasyncCalls >= 2, 'close must perform its own final durable sync after the periodic sync');
  } finally {
    (fs as any).fdatasync = originalFdatasync;
    timeSource.resetTimeSource();
    if (!writer.closed) await writer.close();
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('periodic timer immediately catches up a dirty row when an earlier sync spans a tick', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-periodic-sync-catch-up-'));
  const startMs = Date.parse('2026-07-20T01:32:00.000Z');
  timeSource.createFixedSource(startMs);
  const writer = new FlightCSVWriter({
    flightId: 'periodic-sync-catch-up',
    recordingSessionId: crypto.randomUUID(),
    recordingStartEpochMs: startMs,
    recordingStartIso: new Date(startMs).toISOString(),
    bundleBaseName: 'periodic-sync-catch-up',
    outputDir,
    syncIntervalMs: 15,
  });
  const originalFdatasync = fs.fdatasync;
  let fdatasyncCalls = 0;
  let releaseFirstSync: ((error?: NodeJS.ErrnoException | null) => void) | null = null;
  try {
    assert.equal(writer.start(), true);
    (fs as any).fdatasync = (
      _fd: number,
      callback: (error?: NodeJS.ErrnoException | null) => void,
    ) => {
      fdatasyncCalls += 1;
      if (fdatasyncCalls === 1) {
        releaseFirstSync = callback;
        return;
      }
      callback();
    };

    assert.equal(writer.writeSample({}), true);
    for (let attempt = 0; attempt < 100 && !releaseFirstSync; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert(releaseFirstSync, 'the first timer-driven sync must be in flight');

    assert.equal(writer.writeSample({}), true);
    for (let attempt = 0; attempt < 100 && !writer.syncCatchUpDue; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(writer.syncCatchUpDue, true, 'a missed timer tick must request one catch-up sync');

    // Removing future ticks proves that completion of the slow sync, rather
    // than a later interval, starts durability for the second dirty row.
    writer._clearPeriodicSyncTimer();
    releaseFirstSync();
    releaseFirstSync = null;
    await writer._waitForPeriodicSync();
    assert.equal(fdatasyncCalls, 2, 'the dirty row must be synced immediately after the slow sync');

    const stats = await writer.close();
    assert.equal(stats.rowCount, 3);
  } finally {
    if (releaseFirstSync) releaseFirstSync();
    (fs as any).fdatasync = originalFdatasync;
    timeSource.resetTimeSource();
    if (!writer.closed) await writer.close();
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('both JSONL periodic syncs drain the WriteStream queue before fdatasync and close waits', async () => {
  const startMs = Date.parse('2026-07-20T01:35:00.000Z');
  const startIso = new Date(startMs).toISOString();
  const scenarios = [
    {
      label: 'automation',
      create: (outputDir: string) => new AutomationJsonlRecorder({
        flightId: 'jsonl-periodic-automation',
        recordingSessionId: crypto.randomUUID(),
        recordingStartEpochMs: startMs,
        recordingStartIso: startIso,
        bundleBaseName: 'jsonl-periodic-automation',
        outputDir,
        syncIntervalMs: 0,
      }),
      record: (recorder: AnyRecord, now: number) => recorder.recordAutopilotState({
        timeMs: now,
        fdm: { apMaster: false },
        baseFdm: { apMaster: false },
        simconnect: { connected: true },
      }),
      close: (recorder: AnyRecord, now: number) => recorder.close({ timeMs: now }),
    },
    {
      label: 'aircraft',
      create: (outputDir: string) => new aircraftRecorderModule.AircraftSpecificJsonlRecorder({
        flightId: 'jsonl-periodic-aircraft',
        recordingSessionId: crypto.randomUUID(),
        recordingStartEpochMs: startMs,
        recordingStartIso: startIso,
        bundleBaseName: 'jsonl-periodic-aircraft',
        outputDir,
        syncIntervalMs: 0,
      }),
      record: (recorder: AnyRecord, now: number) => recorder.recordAircraftSpecificState({
        timeMs: now,
        profileKey: 'bundled/msfs/test',
        fieldCatalog: [{ id: 'controls.speedSelected', valueType: 'number' }],
        values: { 'controls.speedSelected': 220 },
        unavailable: [],
        sourceStatus: { overall: 'connected', sources: { simvar: 'connected' } },
      }),
      close: (recorder: AnyRecord, now: number) => recorder.close({ timeMs: now }),
    },
  ];

  for (const scenario of scenarios) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), `ff-${scenario.label}-periodic-order-`));
    const clock = timeSource.createFixedSource(startMs);
    const recorder = scenario.create(outputDir);
    const originalFdatasync = fs.fdatasync;
    let fdatasyncCalls = 0;
    let releasePeriodicSync: ((error?: NodeJS.ErrnoException | null) => void) | null = null;
    try {
      assert.equal(recorder.start(), true);
      const stream = recorder.stream as any;
      const originalWrite = stream.write.bind(stream);
      let releaseWriteBarrier: (() => void) | null = null;
      let delayedBarrier = false;
      stream.write = (chunk: unknown, ...args: any[]) => {
        if (chunk === '' && !delayedBarrier) {
          delayedBarrier = true;
          releaseWriteBarrier = () => { originalWrite('', ...args); };
          return true;
        }
        return originalWrite(chunk, ...args);
      };
      (fs as any).fdatasync = (
        _fd: number,
        callback: (error?: NodeJS.ErrnoException | null) => void,
      ) => {
        fdatasyncCalls += 1;
        if (fdatasyncCalls === 1) {
          releasePeriodicSync = callback;
          return;
        }
        callback();
      };

      assert.equal(scenario.record(recorder, clock.get()), true);
      assert(releaseWriteBarrier, `${scenario.label} must enqueue a write-queue barrier`);
      assert.equal(fdatasyncCalls, 0, `${scenario.label} fdatasync must wait for the row write callback`);

      let settled = false;
      const closing = scenario.close(recorder, clock.get()).finally(() => { settled = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false, `${scenario.label} close must wait for periodic durability`);
      releaseWriteBarrier();
      for (let attempt = 0; attempt < 100 && !releasePeriodicSync; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      assert(releasePeriodicSync, `${scenario.label} fdatasync must follow the released write barrier`);
      releasePeriodicSync();
      const stats = await closing;
      assert.equal(stats.hasError, false);
      assert(fdatasyncCalls >= 2, `${scenario.label} close must also perform a final durable sync`);
    } finally {
      (fs as any).fdatasync = originalFdatasync;
      timeSource.resetTimeSource();
      if (!recorder.closed) await scenario.close(recorder, startMs + 1);
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }
});

test('an explicit flush overlapping close is a benign hand-off for all three inline writers', async () => {
  const startMs = Date.parse('2026-07-20T01:37:00.000Z');
  const startIso = new Date(startMs).toISOString();
  const scenarios: Array<{
    label: string;
    create: (_outputDir: string, _onTerminalError: (_error: Error) => void) => AnyRecord;
    record: (_recorder: AnyRecord, _now: number) => boolean;
    close: (_recorder: AnyRecord, _now: number) => Promise<AnyRecord>;
  }> = [
    {
      label: 'csv',
      create: (outputDir, onTerminalError) => new FlightCSVWriter({
        flightId: 'flush-close-csv',
        recordingSessionId: crypto.randomUUID(),
        recordingStartEpochMs: startMs,
        recordingStartIso: startIso,
        bundleBaseName: 'flush-close-csv',
        outputDir,
        syncIntervalMs: 0,
        onTerminalError,
      }),
      record: (recorder) => recorder.writeSample({}),
      close: (recorder) => recorder.close(),
    },
    {
      label: 'automation',
      create: (outputDir, onTerminalError) => new AutomationJsonlRecorder({
        flightId: 'flush-close-automation',
        recordingSessionId: crypto.randomUUID(),
        recordingStartEpochMs: startMs,
        recordingStartIso: startIso,
        bundleBaseName: 'flush-close-automation',
        outputDir,
        syncIntervalMs: 0,
        onTerminalError,
      }),
      record: (recorder, now) => recorder.recordAutopilotState({
        timeMs: now,
        fdm: { apMaster: false },
        baseFdm: { apMaster: false },
        simconnect: { connected: true },
      }),
      close: (recorder, now) => recorder.close({ timeMs: now }),
    },
    {
      label: 'aircraft',
      create: (outputDir, onTerminalError) => new aircraftRecorderModule.AircraftSpecificJsonlRecorder({
        flightId: 'flush-close-aircraft',
        recordingSessionId: crypto.randomUUID(),
        recordingStartEpochMs: startMs,
        recordingStartIso: startIso,
        bundleBaseName: 'flush-close-aircraft',
        outputDir,
        syncIntervalMs: 0,
        onTerminalError,
      }),
      record: (recorder, now) => recorder.recordAircraftSpecificState({
        timeMs: now,
        profileKey: 'bundled/msfs/test',
        fieldCatalog: [{ id: 'controls.speedSelected', valueType: 'number' }],
        values: { 'controls.speedSelected': 220 },
        unavailable: [],
        sourceStatus: { overall: 'connected', sources: { simvar: 'connected' } },
      }),
      close: (recorder, now) => recorder.close({ timeMs: now }),
    },
  ];

  for (const scenario of scenarios) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), `ff-${scenario.label}-flush-close-`));
    const terminalErrors: Error[] = [];
    const recorder = scenario.create(outputDir, (error) => terminalErrors.push(error));
    const originalFdatasync = fs.fdatasync;
    let fdatasyncCalls = 0;
    let releasePeriodicSync: ((error?: NodeJS.ErrnoException | null) => void) | null = null;
    try {
      timeSource.createFixedSource(startMs);
      assert.equal(recorder.start(), true);
      (fs as any).fdatasync = (
        _fd: number,
        callback: (error?: NodeJS.ErrnoException | null) => void,
      ) => {
        fdatasyncCalls += 1;
        if (fdatasyncCalls === 1) {
          releasePeriodicSync = callback;
          return;
        }
        callback();
      };

      assert.equal(scenario.record(recorder, startMs), true);
      for (let attempt = 0; attempt < 100 && !releasePeriodicSync; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      assert(releasePeriodicSync, `${scenario.label} periodic sync must be in flight`);

      let flushSettled = false;
      let closeSettled = false;
      const flushing = recorder.flush().finally(() => { flushSettled = true; });
      const closing = scenario.close(recorder, startMs).finally(() => { closeSettled = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(flushSettled, false, `${scenario.label} flush must still own the stream`);
      assert.equal(closeSettled, false, `${scenario.label} close must wait for the explicit flush`);

      releasePeriodicSync();
      releasePeriodicSync = null;
      const [flushed, stats] = await Promise.all([flushing, closing]);
      assert.equal(flushed, true, `${scenario.label} close takeover must not fail the active flush`);
      assert.equal(stats.hasError, false, `${scenario.label} must not report a synthetic storage error`);
      assert.equal(terminalErrors.length, 0, `${scenario.label} must not notify a terminal error`);
      assert(fdatasyncCalls >= 3, `${scenario.label} must retain explicit and final durable barriers`);
      assert.equal(fs.readFileSync(stats.filePath).subarray(-1)[0], 0x0a, `${scenario.label} must end on a committed row`);
    } finally {
      if (releasePeriodicSync) releasePeriodicSync();
      (fs as any).fdatasync = originalFdatasync;
      timeSource.resetTimeSource();
      if (!recorder.closed) await scenario.close(recorder, startMs + 1);
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }
});

test('both JSONL periodic sync failures are terminal and notify the bundle once', async () => {
  const startMs = Date.parse('2026-07-20T01:40:00.000Z');
  const startIso = new Date(startMs).toISOString();
  const scenarios = [
    {
      label: 'automation',
      create: (outputDir: string, errors: Error[]) => new AutomationJsonlRecorder({
        flightId: 'jsonl-sync-error-automation',
        recordingSessionId: crypto.randomUUID(),
        recordingStartEpochMs: startMs,
        recordingStartIso: startIso,
        bundleBaseName: 'jsonl-sync-error-automation',
        outputDir,
        syncIntervalMs: 0,
        onTerminalError: (error: Error) => errors.push(error),
      }),
      record: (recorder: AnyRecord, now: number) => recorder.recordAutopilotState({
        timeMs: now,
        fdm: { apMaster: false },
        baseFdm: { apMaster: false },
        simconnect: { connected: true },
      }),
      close: (recorder: AnyRecord, now: number) => recorder.close({ timeMs: now }),
    },
    {
      label: 'aircraft',
      create: (outputDir: string, errors: Error[]) => new aircraftRecorderModule.AircraftSpecificJsonlRecorder({
        flightId: 'jsonl-sync-error-aircraft',
        recordingSessionId: crypto.randomUUID(),
        recordingStartEpochMs: startMs,
        recordingStartIso: startIso,
        bundleBaseName: 'jsonl-sync-error-aircraft',
        outputDir,
        syncIntervalMs: 0,
        onTerminalError: (error: Error) => errors.push(error),
      }),
      record: (recorder: AnyRecord, now: number) => recorder.recordAircraftSpecificState({
        timeMs: now,
        profileKey: 'bundled/msfs/test',
        fieldCatalog: [{ id: 'controls.speedSelected', valueType: 'number' }],
        values: { 'controls.speedSelected': 220 },
        unavailable: [],
        sourceStatus: { overall: 'connected', sources: { simvar: 'connected' } },
      }),
      close: (recorder: AnyRecord, now: number) => recorder.close({ timeMs: now }),
    },
  ];

  for (const scenario of scenarios) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), `ff-${scenario.label}-periodic-error-`));
    const clock = timeSource.createFixedSource(startMs);
    const errors: Error[] = [];
    const recorder = scenario.create(outputDir, errors);
    const originalFdatasync = fs.fdatasync;
    let syncCalls = 0;
    try {
      assert.equal(recorder.start(), true);
      (fs as any).fdatasync = (
        fd: number,
        callback: (error?: NodeJS.ErrnoException | null) => void,
      ) => {
        syncCalls += 1;
        if (syncCalls === 1) {
          const error = new Error(`simulated ${scenario.label} periodic EIO`) as NodeJS.ErrnoException;
          error.code = 'EIO';
          callback(error);
          return;
        }
        originalFdatasync(fd, callback);
      };
      clock.advance(1);
      assert.equal(scenario.record(recorder, clock.get()), true);
      for (let attempt = 0; attempt < 100 && errors.length === 0; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(errors.length, 1, `${scenario.label} must notify its terminal sync failure once`);
      assert.equal(scenario.record(recorder, clock.get()), false, `${scenario.label} must reject rows after sync failure`);
      const stats = await scenario.close(recorder, clock.get());
      assert.equal(stats.hasError, true);
      assert.equal(errors.length, 1);
    } finally {
      (fs as any).fdatasync = originalFdatasync;
      timeSource.resetTimeSource();
      if (!recorder.closed) await scenario.close(recorder, startMs + 1);
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }
});

test('worker CSV periodic sync crosses its write barrier before fdatasync and close waits', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-worker-periodic-order-'));
  const startMs = Date.parse('2026-07-20T01:42:00.000Z');
  const phases: string[] = [];
  const writer = new WorkerFlightCSVWriter({
    flightId: 'worker-periodic-order',
    recordingSessionId: crypto.randomUUID(),
    recordingStartEpochMs: startMs,
    recordingStartIso: new Date(startMs).toISOString(),
    bundleBaseName: 'worker-periodic-order',
    outputDir,
    syncIntervalMs: 0,
    workerPeriodicSyncBarrierDelayMs: 75,
    workerReportPeriodicSyncPhases: true,
  });
  try {
    assert.equal(writer.start(), true);
    writer.worker?.on('message', (message: AnyRecord) => {
      if (message?.type === 'periodicSyncPhase') phases.push(String(message.phase));
    });
    assert.equal(writer.writeSample({}), true);
    let settled = false;
    const closing = writer.close().finally(() => { settled = true; });
    for (let attempt = 0; attempt < 40 && phases.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(phases, ['barrier'], 'worker must report its queue barrier before fdatasync starts');
    assert.equal(settled, false, 'worker close must wait while periodic durability is between barrier and fdatasync');
    const stats = await closing;
    assert.equal(stats.hasError, false);
    assert.deepEqual(phases.slice(0, 2), ['barrier', 'fdatasync']);
  } finally {
    if (!writer.closed) await writer.close();
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('concurrent worker CSV closes share one durable finalization handshake', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-worker-concurrent-close-'));
  const startMs = Date.parse('2026-07-20T01:42:30.000Z');
  const writer = new WorkerFlightCSVWriter({
    flightId: 'worker-concurrent-close',
    recordingSessionId: crypto.randomUUID(),
    recordingStartEpochMs: startMs,
    recordingStartIso: new Date(startMs).toISOString(),
    bundleBaseName: 'worker-concurrent-close',
    outputDir,
    syncIntervalMs: 0,
    workerPeriodicSyncBarrierDelayMs: 75,
  });
  try {
    assert.equal(writer.start(), true);
    assert.equal(writer.writeSample({ aircraft: 'Concurrent close regression' }), true);
    const firstClose = writer.close();
    const secondClose = writer.close();
    assert.equal(secondClose, firstClose, 'duplicate close callers must join the in-flight worker handshake');
    const [firstStats, secondStats] = await Promise.all([firstClose, secondClose]);
    assert.equal(firstStats.hasError, false);
    assert.equal(secondStats.hasError, false);
    assert.equal(firstStats.rowCount, 2);
    const lines = splitCsvLines(fs.readFileSync(firstStats.filePath, 'utf8'), { trimAndDropEmpty: true });
    assert.equal(lines.length, 3, 'header, manifest, and accepted sample must all survive duplicate close');
  } finally {
    if (!writer.closed) await writer.close();
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('worker CSV periodic sync failure is terminal and notifies the bundle once', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-worker-periodic-error-'));
  const startMs = Date.parse('2026-07-20T01:43:00.000Z');
  const terminalErrors: Error[] = [];
  const writer = new WorkerFlightCSVWriter({
    flightId: 'worker-periodic-error',
    recordingSessionId: crypto.randomUUID(),
    recordingStartEpochMs: startMs,
    recordingStartIso: new Date(startMs).toISOString(),
    bundleBaseName: 'worker-periodic-error',
    outputDir,
    syncIntervalMs: -1,
    workerPeriodicSyncErrorCode: 'EIO',
    onTerminalError: (error: Error) => terminalErrors.push(error),
  });
  try {
    assert.equal(writer.start(), true);
    assert.equal(writer.writeSample({}), true);
    for (let attempt = 0; attempt < 40 && terminalErrors.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(terminalErrors.length, 1);
    assert.match(terminalErrors[0].message, /periodic sync failure/i);
    assert.equal(writer.writeSample({}), false);
    const stats = await writer.close();
    assert.equal(stats.hasError, true);
    assert.equal(terminalErrors.length, 1);
  } finally {
    if (!writer.closed) await writer.close();
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('worker failure close waits until worker descriptor ownership terminates', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-worker-termination-'));
  const startMs = Date.parse('2026-07-20T01:45:00.000Z');
  const writer = new WorkerFlightCSVWriter({
    flightId: 'worker-termination',
    recordingSessionId: crypto.randomUUID(),
    recordingStartEpochMs: startMs,
    recordingStartIso: new Date(startMs).toISOString(),
    bundleBaseName: 'worker-termination',
    outputDir,
  });
  let releaseTermination: ((exitCode: number) => void) | null = null;
  const termination = new Promise<number>((resolve) => { releaseTermination = resolve; });
  (writer as any).worker = { terminate: () => termination };
  try {
    writer._handleWorkerFailure(new Error('simulated worker failure'));
    let settled = false;
    const closing = writer.close().finally(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'bundle finalization must wait while the failed worker can still own the fd');
    assert(releaseTermination);
    releaseTermination(1);
    const stats = await closing;
    assert.equal(stats.hasError, true);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('worker terminal-error shutdown still persists accepted rows before close', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-worker-terminal-close-'));
  const startMs = Date.parse('2026-07-20T02:00:00.000Z');
  const writer = new WorkerFlightCSVWriter({
    flightId: 'worker-terminal-flight',
    recordingSessionId: crypto.randomUUID(),
    recordingStartEpochMs: startMs,
    recordingStartIso: new Date(startMs).toISOString(),
    bundleBaseName: 'worker-terminal-close',
    outputDir,
  });
  try {
    assert.equal(writer.start(), true);
    assert(fs.statSync(writer.filePath).size > 0, 'worker startup success must imply a committed CSV header');
    assert.equal(writer.writeSample({}), true);
    writer._recordTerminalError(new Error('simulated asynchronous stream failure'));
    const stats = await writer.close();
    const lines = splitCsvLines(fs.readFileSync(stats.filePath, 'utf8'), { trimAndDropEmpty: true });
    assert.equal(lines.length, 3, 'the header, manifest, and accepted sample must survive terminal close');
    assert.equal(stats.rowCount, 2);
    assert.equal(stats.hasError, true);
  } finally {
    if (!writer.closed) await writer.close();
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('worker startup timeout safely falls back without an orphan or late terminal callback', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-worker-start-timeout-'));
  const startMs = Date.parse('2026-07-20T02:30:00.000Z');
  const terminalErrors: Error[] = [];
  try {
    const writer = startCsvFlight({
      flightId: 'worker-timeout-flight',
      recordingSessionId: crypto.randomUUID(),
      recordingStartEpochMs: startMs,
      recordingStartIso: new Date(startMs).toISOString(),
      bundleBaseName: 'worker-timeout',
      outputDir,
      writerMode: 'worker',
      workerStartupTimeoutMs: 5,
      workerStartupNotifyDelayMs: 100,
      onTerminalError: (error: Error) => terminalErrors.push(error),
    });
    assert(writer instanceof FlightCSVWriter, 'the inline fallback must claim the cleaned basename');
    assert.equal(writer.writeSample({ sessionId: 'backend-session' }), true);
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    assert.equal(fs.existsSync(writer.filePath), true, 'late worker cleanup must preserve the replacement inode');
    assert.equal(terminalErrors.length, 0, 'failed startup callbacks must not poison the fallback recorder');
    const stats = await endCsvFlight();
    assert(stats);
    const lines = splitCsvLines(fs.readFileSync(stats.filePath, 'utf8'), { trimAndDropEmpty: true });
    assert.equal(lines.length, 3);
  } finally {
    if (isCsvRecording()) await endCsvFlight();
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

export {};
