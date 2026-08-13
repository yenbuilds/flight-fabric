const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BACKEND_RUNTIME_ROOT = path.resolve(__dirname, '..');

function resolveBackendPath(...segments) {
  return path.join(BACKEND_RUNTIME_ROOT, ...segments);
}

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {}
}

function clearStoreModules() {
  [
    resolveBackendPath('flight-recording', 'flight-csv-store.js'),
    resolveBackendPath('flight-recording', 'flight-analysis-rescore-sidecar.js'),
    resolveBackendPath('flight-recording', 'csv-read-guard.js'),
    resolveBackendPath('flight-recording', 'recording-bundle-lifecycle.js'),
    resolveBackendPath('events', 'timeline-generator.js'),
    resolveBackendPath('events', 'timeline-events.js'),
    resolveBackendPath('history-index', 'history-index-store.js'),
    resolveBackendPath('history-index', 'source-identity.js'),
    resolveBackendPath('history-index', 'sqlite-runtime.js'),
    resolveBackendPath('history-index', 'sqlite-schema.js'),
    resolveBackendPath('history-index', 'logbook-landing-index.js'),
    resolveBackendPath('history-index', 'timeline-flight-index.js'),
    resolveBackendPath('landing', 'flight-logbook.js'),
    resolveBackendPath('landing', 'landing.js'),
    resolveBackendPath('utils', 'csv.js'),
    resolveBackendPath('utils', 'flight-logs-dir.js'),
    resolveBackendPath('utils', 'storage-paths.js'),
  ].forEach(clearModule);
}

async function withTempAppData(fn) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-csv-store-'));
  const previous = {
    APPDATA: process.env.APPDATA,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    OneDrive: process.env.OneDrive,
    ONEDRIVE: process.env.ONEDRIVE,
    OneDriveConsumer: process.env.OneDriveConsumer,
    OneDriveCommercial: process.env.OneDriveCommercial,
    FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS: process.env.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS,
  };

  process.env.APPDATA = path.join(tmpRoot, 'AppData', 'Roaming');
  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;
  process.env.XDG_CONFIG_HOME = path.join(tmpRoot, '.config');
  process.env.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS = '1';
  delete process.env.OneDrive;
  delete process.env.ONEDRIVE;
  delete process.env.OneDriveConsumer;
  delete process.env.OneDriveCommercial;
  clearStoreModules();

  try {
    await fn();
  } finally {
    if (previous.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = previous.APPDATA;
    if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
    if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous.USERPROFILE;
    if (previous.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.XDG_CONFIG_HOME;
    if (previous.OneDrive === undefined) delete process.env.OneDrive; else process.env.OneDrive = previous.OneDrive;
    if (previous.ONEDRIVE === undefined) delete process.env.ONEDRIVE; else process.env.ONEDRIVE = previous.ONEDRIVE;
    if (previous.OneDriveConsumer === undefined) delete process.env.OneDriveConsumer; else process.env.OneDriveConsumer = previous.OneDriveConsumer;
    if (previous.OneDriveCommercial === undefined) delete process.env.OneDriveCommercial; else process.env.OneDriveCommercial = previous.OneDriveCommercial;
    if (previous.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS === undefined) delete process.env.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS; else process.env.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS = previous.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS;
    clearStoreModules();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function buildWriter(filePath, overrides = {}) {
  return {
    isRecording() {
      return true;
    },
    getStats() {
      return { filePath };
    },
    async flush() {
      return true;
    },
    ...overrides,
  };
}

function makeBundlePaths(logsDir: string, bundleName: string) {
  const dir = path.join(logsDir, bundleName);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    csv: path.join(dir, 'telemetry.csv'),
    automation: path.join(dir, 'automation.jsonl'),
    aircraftSpecific: path.join(dir, 'aircraft-specific.jsonl'),
    status: path.join(dir, 'manifest.json'),
    summary: path.join(dir, 'summary.json'),
    timeline: path.join(dir, 'timeline.json'),
    analysisRescore: path.join(dir, 'analysis-rescore.json'),
    legacyLandingGradeRescore: path.join(dir, 'landing-grade-rescore.json'),
  };
}

async function waitForHistoryIndex(store, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = store.getHistoryIndexStatus();
    if (!status.busy) {
      assert.notEqual(status.phase, 'error', status.error || 'history index failed');
      assert.equal(status.failures, 0, JSON.stringify(status));
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('history index did not complete');
}

function writeTimelineCsv(filePath, requestedSampleCount = 5) {
  const sampleCount = Math.max(0, Number.isInteger(requestedSampleCount) ? requestedSampleCount : 5);
  const startMs = Date.parse('2026-05-25T00:00:00.000Z');
  const rows = [
    'record_type,timestamp_utc,ts,lat_deg,lon_deg,ias_kts,vs_fpm,ra_ft,on_ground,phase,aircraft',
  ];

  for (let index = 0; index < sampleCount; index += 1) {
    const ts = startMs + index * 1000;
    const lat = (47.45 + index * 0.01).toFixed(4);
    const lon = (-122.31 + index * 0.01).toFixed(4);
    const ias = 140 - index;
    const vs = -500 + index * 25;
    const ra = 1000 - index * 50;
    rows.push(`SAMPLE,${new Date(ts).toISOString()},${ts},${lat},${lon},${ias},${vs},${ra},0,APPROACH,Store Test`);
  }

  fs.writeFileSync(
    filePath,
    rows.join('\n') + '\n',
  );
}

function writeIndexedTimelineCsv(filePath, options: Record<string, any> = {}) {
  const sampleCount = options.sampleCount || 6;
  const startMs = Date.parse(options.startIso || '2026-05-25T00:00:00.000Z');
  const aircraft = options.aircraft || 'Indexed Test';
  const rows = [
    'record_type,timestamp_utc,ts,lat_deg,lon_deg,ias_kts,vs_fpm,ra_ft,on_ground,phase,aircraft,flight_id,fuel_total_gal',
  ];

  for (let index = 0; index < sampleCount; index += 1) {
    const ts = startMs + index * 1000;
    rows.push([
      'SAMPLE',
      new Date(ts).toISOString(),
      ts,
      (47.45 + index * 0.01).toFixed(5),
      (-122.31 + index * 0.01).toFixed(5),
      140 + index,
      -500 + index,
      1500 - index * 100,
      0,
      index < sampleCount - 1 ? 'APPROACH' : 'TAXI_IN',
      aircraft,
      options.flightId || path.basename(filePath, path.extname(filePath)),
      1000 - index * 5,
    ].join(','));
  }

  fs.writeFileSync(filePath, rows.join('\n') + '\n');
  const mtime = new Date(startMs + sampleCount * 1000);
  fs.utimesSync(filePath, mtime, mtime);
}

function writeManifestBundle(logsDir: string, baseName: string, bundleStatusRequired: boolean) {
  const recordingStartEpochMs = Date.parse('2026-05-25T00:00:00.000Z');
  const recordingStartIso = new Date(recordingStartEpochMs).toISOString();
  const identity = {
    flightId: 'optout-cache-flight',
    recordingSessionId: 'optout-cache-session',
    recordingStartEpochMs,
    recordingStartIso,
  };
  const paths = makeBundlePaths(logsDir, baseName);
  const csvPath = paths.csv;
  const automationPath = paths.automation;
  const aircraftSpecificPath = paths.aircraftSpecific;
  const headers = [
    'record_type',
    'bundle_status_required',
    'flight_id',
    'recording_session_id',
    'flight_start_iso',
    'timestamp_utc',
    'ts',
    'vs_fpm',
    'grade',
    'icao',
    'runway',
    'aircraft',
    'sample_index',
    'aircraft_profile_id',
    'schema_version',
    'flight_elapsed_ms',
    'timestamp_monotonic',
  ];
  const landingMs = recordingStartEpochMs + 1_000;
  fs.writeFileSync(csvPath, [
    headers.join(','),
    [
      'RECORDING_MANIFEST',
      bundleStatusRequired ? 1 : 0,
      identity.flightId,
      identity.recordingSessionId,
      identity.recordingStartIso,
      identity.recordingStartIso,
      identity.recordingStartEpochMs,
      '',
      '',
      '',
      '',
      '',
      0,
      '',
      3,
      0,
      0,
    ].join(','),
    ...Array.from({ length: 5 }, (_, index) => {
      const sampleMs = recordingStartEpochMs + 100 + index * 100;
      return [
        'SAMPLE',
        bundleStatusRequired ? 1 : 0,
        identity.flightId,
        identity.recordingSessionId,
        identity.recordingStartIso,
        new Date(sampleMs).toISOString(),
        sampleMs,
        -100,
        '',
        '',
        '',
        'Opt-out Cache Test',
        index + 1,
        '',
        3,
        sampleMs - recordingStartEpochMs,
        sampleMs - recordingStartEpochMs,
      ].join(',');
    }),
    [
      'LANDING',
      bundleStatusRequired ? 1 : 0,
      identity.flightId,
      identity.recordingSessionId,
      identity.recordingStartIso,
      new Date(landingMs).toISOString(),
      landingMs,
      -320,
      'GOOD',
      'YSCB',
      '35',
      'Opt-out Cache Test',
      6,
      'bundled/msfs/fbw-a32nx',
      3,
      landingMs - recordingStartEpochMs,
      landingMs - recordingStartEpochMs,
    ].join(','),
  ].join('\n') + '\n', 'utf8');
  const manifestBase = {
    schemaVersion: 1,
    seq: 1,
    timeMs: recordingStartEpochMs,
    timestampIso: recordingStartIso,
    flightElapsedMs: 0,
    flightId: identity.flightId,
    recordingSessionId: identity.recordingSessionId,
    bundleStatusRequired,
    flightStartIso: identity.recordingStartIso,
  };
  fs.writeFileSync(automationPath, `${JSON.stringify({
    ...manifestBase,
    type: 'automation_manifest',
  })}\n`, 'utf8');
  fs.writeFileSync(aircraftSpecificPath, `${JSON.stringify({
    ...manifestBase,
    type: 'aircraft_specific_manifest',
  })}\n`, 'utf8');
  return { identity, csvPath, automationPath, aircraftSpecificPath };
}

function writeOptOutManifestBundle(logsDir: string, baseName: string) {
  return writeManifestBundle(logsDir, baseName, false);
}

function fileIdentity(filePath) {
  const stat = fs.statSync(filePath);
  return {
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
  };
}

test('resolveCsvInsideFlightLogs accepts only canonical bundle telemetry', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { resolveCsvInsideFlightLogs } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });

    const csvPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_valid').csv;
    const unrelatedCsv = path.join(logsDir, 'unrelated.csv');
    const outsidePath = path.join(path.dirname(logsDir), 'outside.csv');
    fs.writeFileSync(csvPath, 'record_type,timestamp_utc\n');
    fs.writeFileSync(unrelatedCsv, 'personal,data\n');

    assert.equal(resolveCsvInsideFlightLogs(csvPath), path.resolve(csvPath));
    if (process.platform === 'win32') {
      assert.equal(resolveCsvInsideFlightLogs(csvPath.toUpperCase()).toLowerCase(), path.resolve(csvPath).toLowerCase());
    }
    assert.equal(resolveCsvInsideFlightLogs(outsidePath), null);
    assert.equal(resolveCsvInsideFlightLogs(unrelatedCsv), null);
    assert.equal(resolveCsvInsideFlightLogs(path.join(logsDir, 'not-csv.txt')), null);
  });
});

test('deleteFlightCsv accepts valid Windows case variants inside the flight logs directory', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const paths = makeBundlePaths(logsDir, '2026-05-25T00-00-00_delete');
    const csvPath = paths.csv;
    fs.writeFileSync(csvPath, 'record_type,flight_id,flight_start_iso,recording_session_id\nSAMPLE,delete-flight,2026-05-25T00:00:00.000Z,delete-session\n');

    const requestedPath = process.platform === 'win32' ? csvPath.toUpperCase() : csvPath;
    const result = timelineGenerator.deleteFlightCsv(requestedPath, fileIdentity(csvPath));

    assert.equal(result.success, true, result.error || 'expected delete to succeed');
    assert.equal(fs.existsSync(csvPath), false);
  });
});

test('deleteFlightCsv deletes the recording sidecars for the same flight', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const paths = makeBundlePaths(logsDir, '2026-05-25T00-00-00_delete');
    const csvPath = paths.csv;
    const automationSidecarPath = paths.automation;
    const aircraftSpecificSidecarPath = paths.aircraftSpecific;
    const analysisRescorePath = paths.analysisRescore;
    const legacyLandingGradeRescorePath = paths.legacyLandingGradeRescore;
    const unrelatedPath = path.join(logsDir, 'unrelated.aircraft-specific.jsonl');
    const flightId = 'delete-flight';
    const flightStartIso = '2026-05-25T00:00:00.000Z';
    const recordingSessionId = 'delete-recording-session';
    fs.writeFileSync(
      csvPath,
      `record_type,flight_id,flight_start_iso,recording_session_id\nSAMPLE,${flightId},${flightStartIso},${recordingSessionId}\n`,
    );
    const companionIdentity = { flightId, flightStartIso, recordingSessionId };
    fs.writeFileSync(automationSidecarPath, `${JSON.stringify({ type: 'automation_checkpoint', ...companionIdentity })}\n`);
    fs.writeFileSync(aircraftSpecificSidecarPath, `${JSON.stringify({ type: 'aircraft_specific_checkpoint', ...companionIdentity })}\n`);
    fs.writeFileSync(analysisRescorePath, '{"type":"flight_analysis_rescore_snapshot"}\n');
    fs.writeFileSync(legacyLandingGradeRescorePath, '{"type":"landing_grade_rescore_overrides"}\n');
    fs.writeFileSync(unrelatedPath, '{"type":"aircraft_specific_checkpoint"}\n');

    const result = timelineGenerator.deleteFlightCsv(csvPath, fileIdentity(csvPath));

    assert.equal(result.success, true, result.error || 'expected delete to succeed');
    assert.equal(fs.existsSync(csvPath), false);
    assert.equal(fs.existsSync(automationSidecarPath), false);
    assert.equal(fs.existsSync(aircraftSpecificSidecarPath), false);
    assert.equal(fs.existsSync(analysisRescorePath), false);
    assert.equal(fs.existsSync(legacyLandingGradeRescorePath), false);
    assert.equal(fs.existsSync(unrelatedPath), true);
  });
});

test('indexed completed bundle reports total bytes but deletes with the CSV identity', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const {
      getBundleStatusPath,
      publishRecordingBundleStatus,
    } = require(resolveBackendPath('flight-recording', 'recording-bundle-status.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const baseName = '2026-05-25T00-00-00_indexed-complete-delete';
    const bundle = writeManifestBundle(logsDir, baseName, true);
    const statusPath = getBundleStatusPath(logsDir, baseName);
    await publishRecordingBundleStatus({
      ...bundle.identity,
      outputDir: logsDir,
      bundleBaseName: baseName,
      status: 'complete',
      finalizedAtEpochMs: bundle.identity.recordingStartEpochMs + 1_000,
      finalizedAtIso: new Date(bundle.identity.recordingStartEpochMs + 1_000).toISOString(),
      endReason: 'test_end',
    });

    const csvIdentity = fileIdentity(bundle.csvPath);
    const bundlePaths = [
      bundle.csvPath,
      bundle.automationPath,
      bundle.aircraftSpecificPath,
      statusPath,
    ];
    const expectedBundleBytes = bundlePaths.reduce((total, filePath) => total + fs.statSync(filePath).size, 0);
    const store = createFlightCsvStore();
    const initial = await store.listFlightsIndexed({ limit: 10 });
    assert.equal(initial.success, true);
    assert.equal(initial.index.status.busy, true);
    await waitForHistoryIndex(store);
    const listed = await store.listFlightsIndexed({ limit: 10 });
    const historySummaryPath = makeBundlePaths(logsDir, baseName).summary;
    assert.equal(fs.existsSync(historySummaryPath), true, 'first deep index should create a portable summary');

    assert.equal(listed.success, true, listed.error || 'expected indexed list to succeed');
    assert.equal(listed.index.used, true, listed.index.error || 'expected SQLite index to be used');
    assert.equal(listed.flights.length, 1);
    const flight = listed.flights[0];
    assert.equal(flight.sizeBytes, expectedBundleBytes);
    assert.equal(flight.recordingBundleSizeBytes, expectedBundleBytes);
    assert.equal(flight.csvSizeBytes, csvIdentity.sizeBytes);
    assert.equal(flight.csvMtimeMs, csvIdentity.mtimeMs);
    assert.notEqual(flight.sizeBytes, flight.csvSizeBytes, 'bundle and CSV sizes must remain distinct');

    const deleted = store.deleteFlightCsv(flight.filePath, {
      mtimeMs: flight.csvMtimeMs,
      sizeBytes: flight.csvSizeBytes,
    });

    assert.equal(deleted.success, true, deleted.error || 'expected complete bundle delete to succeed');
    for (const filePath of bundlePaths) {
      assert.equal(fs.existsSync(filePath), false, `delete must remove ${path.basename(filePath)}`);
    }
    assert.equal(fs.existsSync(historySummaryPath), false, 'delete must remove its owned derived summary');
    assert.equal(deleted.storage.fileCount, 0);
    assert.equal(deleted.storage.totalBytes, 0);
  });
});

test('deleteFlightCsv accepts an owned legacy zero-byte automation companion', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const paths = makeBundlePaths(logsDir, '2026-05-25T00-00-00_empty-sidecar');
    const csvPath = paths.csv;
    const sidecarPath = paths.automation;
    fs.writeFileSync(csvPath, 'record_type,flight_id,flight_start_iso,recording_session_id\nSAMPLE,empty-sidecar-flight,2026-05-25T00:00:00.000Z,empty-sidecar-session\n');
    fs.writeFileSync(sidecarPath, '');

    const result = timelineGenerator.deleteFlightCsv(csvPath, fileIdentity(csvPath));

    assert.equal(result.success, true, result.error || 'expected empty companion bundle delete to succeed');
    assert.equal(fs.existsSync(csvPath), false);
    assert.equal(fs.existsSync(sidecarPath), false);
  });
});

test('deleteFlightCsv preserves every member when a non-empty companion identity mismatches', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const paths = makeBundlePaths(logsDir, '2026-05-25T00-00-00_mismatch');
    const csvPath = paths.csv;
    const sidecarPath = paths.automation;
    fs.writeFileSync(csvPath, 'record_type,flight_id,flight_start_iso,recording_session_id\nSAMPLE,flight-a,2026-05-25T00:00:00.000Z,session-a\n');
    fs.writeFileSync(sidecarPath, `${JSON.stringify({
      flightId: 'flight-a',
      flightStartIso: '2026-05-25T00:00:00.000Z',
      recordingSessionId: 'session-b',
    })}\n`);

    const result = timelineGenerator.deleteFlightCsv(csvPath, fileIdentity(csvPath));

    assert.equal(result.success, false);
    assert.match(result.error || '', /identity does not match/);
    assert.equal(fs.existsSync(csvPath), true);
    assert.equal(fs.existsSync(sidecarPath), true);
  });
});

test('deleteFlightCsv keeps every visible member when the atomic directory stage fails', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const paths = makeBundlePaths(logsDir, '2026-05-25T00-00-00_stage-failure');
    const csvPath = paths.csv;
    const automationPath = paths.automation;
    const aircraftPath = paths.aircraftSpecific;
    const identity = {
      flightId: 'stage-failure-flight',
      flightStartIso: '2026-05-25T00:00:00.000Z',
      recordingSessionId: 'stage-failure-session',
    };
    fs.writeFileSync(csvPath, `record_type,flight_id,flight_start_iso,recording_session_id\nSAMPLE,${identity.flightId},${identity.flightStartIso},${identity.recordingSessionId}\n`);
    fs.writeFileSync(automationPath, `${JSON.stringify({ type: 'automation_checkpoint', ...identity })}\n`);
    fs.writeFileSync(aircraftPath, `${JSON.stringify({ type: 'aircraft_specific_checkpoint', ...identity })}\n`);

    const originalRenameSync = fs.renameSync;
    (fs as any).renameSync = (fromPath: import('fs').PathLike, toPath: import('fs').PathLike) => {
      if (String(toPath).includes('.ff-delete-')) {
        const error = new Error('simulated stage failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return originalRenameSync(fromPath, toPath);
    };
    try {
      const result = timelineGenerator.deleteFlightCsv(csvPath, fileIdentity(csvPath));
      assert.equal(result.success, false);
      for (const filePath of [csvPath, automationPath, aircraftPath]) assert.equal(fs.existsSync(filePath), true);
    } finally {
      (fs as any).renameSync = originalRenameSync;
    }
    timelineGenerator.recoverInterruptedBundleDeletes(logsDir);
    assert.equal(fs.existsSync(path.join(paths.dir, '.ff-delete-intent.json')), false);
  });
});

test('delete recovery completes an atomically staged bundle delete', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const leaseProtocol = require(resolveBackendPath('flight-recording', 'recording-bundle-lease.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const bundleName = '2026-05-25T00-00-00_recovery';
    const paths = makeBundlePaths(logsDir, bundleName);
    const recordingSessionId = 'recovery-session';
    fs.writeFileSync(paths.csv, `record_type,flight_id,flight_start_iso,recording_session_id\nSAMPLE,recovery-flight,2026-05-25T00:00:00.000Z,${recordingSessionId}\n`);
    fs.writeFileSync(paths.automation, '{}\n');
    fs.writeFileSync(paths.aircraftSpecific, '{}\n');
    const transactionId = '123-456-abc';
    fs.writeFileSync(path.join(paths.dir, '.ff-delete-intent.json'), `${JSON.stringify({
      schemaVersion: 1,
      kind: 'flight_fabric_bundle_delete_intent',
      bundleName,
      token: transactionId,
      recordingSessionId,
    })}\n`);
    const stagedDir = path.join(logsDir, `${bundleName}.ff-delete-${transactionId}`);
    fs.renameSync(paths.dir, stagedDir);

    const recoverOriginal = timelineGenerator.recoverInterruptedBundleDeletes;
    let concurrentMutation: any = null;
    timelineGenerator.recoverInterruptedBundleDeletes = (dirPath) => {
      concurrentMutation = leaseProtocol.acquireBundleMutationLease({
        outputDir: logsDir,
        baseName: bundleName,
        purpose: 'delete_during_recovery',
      });
      recoverOriginal(dirPath);
    };
    try {
      const listed = await createFlightCsvStore().listFlights();
      assert.equal(listed.success, true);
    } finally {
      timelineGenerator.recoverInterruptedBundleDeletes = recoverOriginal;
    }
    assert.equal(concurrentMutation.acquired, false, 'delete recovery must hold the catalog mutation gate');

    assert.equal(fs.existsSync(stagedDir), false, 'a committed directory tombstone must be cleaned up');
    assert.equal(fs.existsSync(paths.dir), false, 'a committed delete must never be rolled back into view');
  });
});

test('delete recovery refuses an unowned staged directory and preserves a replacement bundle', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const bundleName = '2026-05-25T00-00-00_reused';
    const replacement = makeBundlePaths(logsDir, bundleName);
    const newCsv = 'record_type,flight_id,flight_start_iso,recording_session_id\nSAMPLE,new-flight,2026-05-25T01:00:00.000Z,new-session\n';
    fs.writeFileSync(replacement.csv, newCsv);
    const transactionId = '123-456-def';
    const stagedDir = path.join(logsDir, `${bundleName}.ff-delete-${transactionId}`);
    fs.mkdirSync(stagedDir);
    fs.writeFileSync(path.join(stagedDir, 'telemetry.csv'), 'record_type,flight_id,flight_start_iso,recording_session_id\nSAMPLE,old-flight,2026-05-25T00:00:00.000Z,old-session\n');
    fs.writeFileSync(path.join(stagedDir, '.ff-delete-intent.json'), `${JSON.stringify({
      schemaVersion: 1,
      kind: 'flight_fabric_bundle_delete_intent',
      bundleName,
      token: transactionId,
      recordingSessionId: 'different-session',
    })}\n`);

    timelineGenerator.listCSVFlights();

    assert.equal(fs.readFileSync(replacement.csv, 'utf8'), newCsv, 'recovery must preserve the replacement bundle');
    assert.equal(fs.existsSync(stagedDir), true, 'unprovable staged content must fail closed');
  });
});

test('deleteFlightCsv keeps the primary CSV retryable when sidecar cleanup is refused', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const paths = makeBundlePaths(logsDir, '2026-05-25T00-00-00_retryable');
    const csvPath = paths.csv;
    const automationSidecarPath = paths.automation;
    const invalidSidecarPath = paths.aircraftSpecific;
    fs.writeFileSync(csvPath, 'record_type,flight_id,flight_start_iso,recording_session_id\nSAMPLE,retryable-flight,2026-05-25T00:00:00.000Z,retryable-session\n');
    fs.writeFileSync(automationSidecarPath, '{"type":"automation_checkpoint"}\n');
    fs.mkdirSync(invalidSidecarPath);

    const result = timelineGenerator.deleteFlightCsv(csvPath, fileIdentity(csvPath));

    assert.equal(result.success, false, 'guarded sidecar refusal should fail the deletion request');
    assert.equal(fs.existsSync(csvPath), true, 'primary CSV should remain selectable for a retry');
    assert.equal(fs.existsSync(automationSidecarPath), true,
      'preflight refusal must preserve sidecars that appeared earlier in deletion order');
    assert.equal(fs.statSync(invalidSidecarPath).isDirectory(), true, 'refused sidecar target should remain untouched');
  });
});

test('flight logs storage totals include recording sidecars and completed status but ignore status temps', async () => {
  await withTempAppData(async () => {
    const { getFlightLogsStorageInfo, resolveFlightLogsDir } = require(resolveBackendPath('utils', 'flight-logs-dir.js'));
    const logsDir = resolveFlightLogsDir({ createIfMissing: true });
    const paths = makeBundlePaths(logsDir, '2026-05-25T00-00-00_storage');
    const csvPath = paths.csv;
    const automationSidecarPath = paths.automation;
    const aircraftSpecificSidecarPath = paths.aircraftSpecific;
    const bundleStatusPath = paths.status;
    fs.writeFileSync(csvPath, 'abc');
    fs.writeFileSync(automationSidecarPath, '12345');
    fs.writeFileSync(aircraftSpecificSidecarPath, '1234567');
    fs.writeFileSync(bundleStatusPath, '123456789');
    fs.writeFileSync(`${bundleStatusPath}.tmp-deadbeef`, 'must-be-ignored');
    fs.writeFileSync(path.join(logsDir, 'ignore.txt'), 'ignored');
    fs.writeFileSync(path.join(logsDir, 'ignore.jsonl'), 'not-a-recording-sidecar');

    const storage = getFlightLogsStorageInfo();

    assert.equal(storage.fileCount, 1);
    assert.equal(storage.totalBytes, 24);
  });
});

test('readAutomationRowsForCsv refuses oversized sidecars before reading', async () => {
  await withTempAppData(async () => {
    const { readAutomationRowsForCsv } = require(resolveBackendPath('flight-recording', 'automation-jsonl-reader.js'));
    const { resolveFlightLogsDir } = require(resolveBackendPath('utils', 'flight-logs-dir.js'));
    const logsDir = resolveFlightLogsDir({ createIfMissing: true });
    const paths = makeBundlePaths(logsDir, '2026-05-25T00-00-00_large-sidecar');
    const csvPath = paths.csv;
    const sidecarPath = paths.automation;
    fs.writeFileSync(csvPath, 'record_type,timestamp_utc\n');
    const fd = fs.openSync(sidecarPath, 'w');
    try {
      fs.ftruncateSync(fd, 200 * 1024 * 1024 + 1);
    } finally {
      fs.closeSync(fd);
    }

    const result = await readAutomationRowsForCsv(csvPath);

    assert.equal(result.rows.length, 0);
    assert.match(result.error, /too large/i);
  });
});

test('generateTimelineFromFile flushes the active CSV before parsing', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const activeCsvPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_active').csv;
    writeTimelineCsv(activeCsvPath);

    let flushed = false;
    const store = createFlightCsvStore({
      flightCsvWriter: buildWriter(activeCsvPath, {
        async flush() {
          flushed = true;
          return true;
        },
      }),
    });

    const result = await store.generateTimelineFromFile(activeCsvPath);

    assert.equal(flushed, true);
    assert.equal(result.success, true);
    assert.equal(result.timeline.aircraft, 'Store Test');
    assert.equal(result.timeline.filePath, path.resolve(activeCsvPath));
  });
});

test('timeline current-preview reconstructs the complete analysis without creating a cached artifact', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const flightLogbook = require(resolveBackendPath('landing', 'flight-logbook.js'));
    const sidecar = require(resolveBackendPath('flight-recording', 'flight-analysis-rescore-sidecar.js'));
    const originalGenerateFromCSV = timelineGenerator.generateFromCSV;
    const originalGetLandings = flightLogbook.getLandingsFromCsvFile;
    const originalMaterialize = flightLogbook.materializeFlightAnalysisLandings;
    const originalGetSource = sidecar.getFlightAnalysisRescoreSource;
    const originalRead = sidecar.readFlightAnalysisRescoreSidecar;
    const originalFingerprint = sidecar.buildFlightAnalysisPreviewFingerprint;
    const calls: Array<{ csvPath: string; options: Record<string, any> }> = [];
    try {
      timelineGenerator.generateFromCSV = async (csvPath, options) => {
        calls.push({ csvPath, options });
        return {
          success: true,
          timeline: {
            analysisRescore: {
              mode: options.scoringMode,
              complete: true,
              scope: 'full-landing-analysis',
              landingCount: 1,
            },
            events: [{
              type: 'landing',
              landingKey: '6',
              grade: options.scoringMode === 'current-preview' ? 'GOOD' : 'PERFECT',
              touchdownDistance: {},
            }],
          },
        };
      };
      flightLogbook.getLandingsFromCsvFile = async () => [{ landingKey: '6', grade: 'PERFECT' }];
      flightLogbook.materializeFlightAnalysisLandings = () => ({
        success: true,
        landings: [{ landingKey: '6', grade: 'GOOD', gradeSource: 'applied-rescore' }],
      });
      sidecar.getFlightAnalysisRescoreSource = () => ({
        success: true,
        sourceFingerprint: 'a'.repeat(64),
      });
      sidecar.readFlightAnalysisRescoreSidecar = () => ({
        exists: false,
        valid: true,
        document: null,
      });
      sidecar.buildFlightAnalysisPreviewFingerprint = () => ({
        previewFingerprint: 'b'.repeat(64),
        snapshotFingerprint: 'b'.repeat(64),
        analysisContractFingerprint: 'c'.repeat(64),
      });
      const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
      const logsDir = timelineGenerator.getFlightLogsDir();
      fs.mkdirSync(logsDir, { recursive: true });
      const paths = makeBundlePaths(logsDir, '2026-05-25T00-00-00_preview-options');
      writeTimelineCsv(paths.csv);
      const options = { requestId: 'preview-store-1', scoringMode: 'current-preview' };
      const store = createFlightCsvStore();

      const byFile = await store.generateTimelineFromFile(paths.csv, options);
      const byFlightId = await store.generateTimelineForFlightId(
        '2026-05-25T00-00-00_preview-options',
        options,
      );

      assert.equal(byFile.success, true);
      assert.equal(byFlightId.success, true);
      assert.equal(byFile.timeline.filePath, path.resolve(paths.csv));
      assert.equal(byFlightId.timeline.filePath, path.resolve(paths.csv));
      assert.equal(calls.length, 4);
      assert.deepEqual(calls.map((call) => call.options.scoringMode), [
        'recorded', 'current-preview', 'recorded', 'current-preview',
      ]);
      assert.equal(byFile.timeline.analysisRescorePreview.available, true);
      assert.equal(byFile.timeline.analysisRescorePreview.changedMetricCount, 1);
      assert.equal(byFile.timeline.analysisRescorePreview.previewFingerprint, 'b'.repeat(64));
      assert.equal(fs.existsSync(paths.timeline), false, 'preview reads must not write timeline.json');
      assert.equal(fs.existsSync(paths.summary), false, 'preview reads must not write summary.json');
    } finally {
      timelineGenerator.generateFromCSV = originalGenerateFromCSV;
      flightLogbook.getLandingsFromCsvFile = originalGetLandings;
      flightLogbook.materializeFlightAnalysisLandings = originalMaterialize;
      sidecar.getFlightAnalysisRescoreSource = originalGetSource;
      sidecar.readFlightAnalysisRescoreSidecar = originalRead;
      sidecar.buildFlightAnalysisPreviewFingerprint = originalFingerprint;
    }
  });
});

test('generateTimelineFromFile fails closed when the active CSV cannot flush', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { ACTIVE_CSV_NOT_READY, createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const activeCsvPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_active').csv;
    writeTimelineCsv(activeCsvPath);

    const store = createFlightCsvStore({
      flightCsvWriter: buildWriter(activeCsvPath, {
        async flush() {
          return false;
        },
      }),
    });

    const result = await store.generateTimelineFromFile(activeCsvPath);

    assert.equal(result.success, false);
    assert.equal(result.error, ACTIVE_CSV_NOT_READY);
  });
});

test('generateTimelineFromFile refuses an active three-artifact bundle without attempting a non-atomic read', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { ACTIVE_CSV_NOT_READY, createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const activeCsvPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_bundle').csv;
    writeTimelineCsv(activeCsvPath);

    let flushAttempted = false;
    const store = createFlightCsvStore({
      flightCsvWriter: buildWriter(activeCsvPath),
      recordingBundleGuard: {
        isOwnedCsvPath: (candidate: unknown) => path.resolve(String(candidate)) === path.resolve(activeCsvPath),
        async flushActiveBundle() {
          flushAttempted = true;
          return true;
        },
      },
    });

    const result = await store.generateTimelineFromFile(activeCsvPath);

    assert.equal(result.success, false);
    assert.equal(result.error, ACTIVE_CSV_NOT_READY);
    assert.equal(flushAttempted, false, 'a flush cannot create a cross-file snapshot lease');
  });
});

test('startup rollback ownership blocks list, Timeline reads, and deletion until all three files are released', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const bundleLifecycle = require(resolveBackendPath('flight-recording', 'recording-bundle-lifecycle.js'));
    const { ACTIVE_CSV_NOT_READY, createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const baseName = '2026-05-25T00-00-00_startup-rollback';
    const paths = makeBundlePaths(logsDir, baseName);
    const csvPath = paths.csv;
    const automationPath = paths.automation;
    const aircraftPath = paths.aircraftSpecific;
    writeTimelineCsv(csvPath);
    fs.writeFileSync(automationPath, '{"type":"automation_manifest"}\n');
    fs.writeFileSync(aircraftPath, '{"type":"aircraft_specific_manifest"}\n');

    const recordingSessionId = 'startup-rollback-session';
    const recordingStartEpochMs = Date.parse('2026-05-25T00:00:00.000Z');
    bundleLifecycle.beginRecordingBundleStartup({
      recordingSessionId,
      flightId: 'startup-rollback-flight',
      recordingStartEpochMs,
      recordingStartIso: new Date(recordingStartEpochMs).toISOString(),
      outputDir: logsDir,
      baseName,
      csvPath,
    });

    let flushAttempted = false;
    const recordingBundleGuard = {
      isOwnedCsvPath: (candidate: unknown) => bundleLifecycle.isOwnedRecordingBundleCsvPath(candidate),
      isFinalizing: () => Boolean(bundleLifecycle.getFinalizingRecordingBundle()),
      isBusy: () => Boolean(bundleLifecycle.getStartingRecordingBundle()),
      getActiveCsvPath: () => (
        bundleLifecycle.getActiveRecordingBundle()?.csvPath
        || bundleLifecycle.getStartingRecordingBundle()?.csvPath
        || null
      ),
      async flushActiveBundle() {
        flushAttempted = true;
        return true;
      },
    };
    const store = createFlightCsvStore({
      flightCsvWriter: buildWriter(csvPath, {
        isRecording: () => false,
        isFinalizing: () => false,
        getStats: () => null,
      }),
      recordingBundleGuard,
    });

    try {
      const listResult = await store.listFlights();
      const timelineResult = await store.generateTimelineFromFile(csvPath);
      const deleteResult = store.deleteFlightCsv(csvPath, fileIdentity(csvPath));

      assert.equal(listResult.success, false);
      assert.equal(listResult.error, ACTIVE_CSV_NOT_READY);
      assert.equal(timelineResult.success, false);
      assert.equal(timelineResult.error, ACTIVE_CSV_NOT_READY);
      assert.equal(deleteResult.success, false);
      assert.equal(deleteResult.error, 'Cannot delete an active or finalizing recording');
      assert.equal(flushAttempted, false, 'rollback is not a readable cross-file snapshot');
      for (const filePath of [csvPath, automationPath, aircraftPath]) {
        assert.equal(fs.existsSync(filePath), true, 'rollback-owned artifacts must remain untouched');
      }
    } finally {
      bundleLifecycle.finishRecordingBundleStartup(recordingSessionId);
    }
  });
});

test('cross-process lease marker blocks Timeline, directory, logbook, and delete store paths', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const leaseProtocol = require(resolveBackendPath('flight-recording', 'recording-bundle-lease.js'));
    const { ACTIVE_CSV_NOT_READY, createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const baseName = '2026-05-25T00-00-00_external-lease';
    const csvPath = makeBundlePaths(logsDir, baseName).csv;
    writeTimelineCsv(csvPath);

    // A purpose not eligible for the guarded local-active metadata exception
    // models a lease owned by another runtime without relying on process-local
    // writer state.
    const externalLease = leaseProtocol.acquireBundleReadLease({
      outputDir: logsDir,
      baseName,
      purpose: 'external_runtime_recording',
    });
    assert.equal(externalLease.acquired, true);

    const store = createFlightCsvStore();
    try {
      const timelineResult = await store.generateTimelineFromFile(csvPath);
      const listResult = await store.listFlights();
      const logbookResult = await store.getLogbook();
      const deleteResult = store.deleteFlightCsv(csvPath, fileIdentity(csvPath));

      assert.equal(timelineResult.success, false);
      assert.equal(timelineResult.error, ACTIVE_CSV_NOT_READY);
      assert.equal(listResult.success, false);
      assert.equal(listResult.error, ACTIVE_CSV_NOT_READY);
      assert.equal(logbookResult.success, false);
      assert.equal(logbookResult.error, ACTIVE_CSV_NOT_READY);
      assert.equal(deleteResult.success, false);
      assert.equal(deleteResult.error, 'Cannot delete an active or finalizing recording');
      assert.equal(fs.existsSync(csvPath), true);
    } finally {
      externalLease.release();
    }

    const readable = await store.generateTimelineFromFile(csvPath);
    assert.equal(readable.success, true, readable.error || 'released bundle should be readable');
  });
});

test('directory read uses its leased allowlist and excludes a recording created after the snapshot', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const leaseProtocol = require(resolveBackendPath('flight-recording', 'recording-bundle-lease.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const snapshottedPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_snapshotted').csv;
    const laterPath = makeBundlePaths(logsDir, '2026-05-25T00-00-01_later').csv;
    writeTimelineCsv(snapshottedPath);

    const acquireOriginal = leaseProtocol.acquireBundleDirectoryReadLeases;
    leaseProtocol.acquireBundleDirectoryReadLeases = (options) => {
      const result = acquireOriginal(options);
      if (result.acquired) writeTimelineCsv(laterPath);
      return result;
    };
    try {
      const result = await createFlightCsvStore().listFlights();
      assert.equal(result.success, true);
      assert.deepEqual(result.flights.map((flight) => path.resolve(flight.filePath)), [path.resolve(snapshottedPath)]);
      assert.equal(result.storage.fileCount, 1, 'storage count must use the same leased allowlist');
      assert.equal(fs.existsSync(laterPath), true, 'fixture proves the later CSV existed before Timeline readdir');
    } finally {
      leaseProtocol.acquireBundleDirectoryReadLeases = acquireOriginal;
    }
  });
});

test('symbolic-link CSVs fail directory snapshots closed and never contribute listing or storage bytes', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const flightLogbook = require(resolveBackendPath('landing', 'flight-logbook.js'));
    const { ACTIVE_CSV_NOT_READY, createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });

    const outsidePath = path.join(path.dirname(logsDir), 'outside-valid-flight.csv');
    const linkedPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_linked').csv;
    writeTimelineCsv(outsidePath);
    let originalLstatSync: typeof fs.lstatSync | null = null;
    try {
      fs.symlinkSync(outsidePath, linkedPath, 'file');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        // Windows hosts without Developer Mode cannot create a file symlink.
        // Keep this branch deterministic by presenting the same lstat contract
        // over a harmless local fixture; all production decisions use lstat.
        writeTimelineCsv(linkedPath);
        originalLstatSync = fs.lstatSync;
        (fs as any).lstatSync = (candidate: import('fs').PathLike, ...args: any[]) => {
          const stat = (originalLstatSync as any)(candidate, ...args);
          const candidatePath = path.resolve(String(candidate));
          const comparableCandidate = process.platform === 'win32' ? candidatePath.toLowerCase() : candidatePath;
          const comparableLinked = process.platform === 'win32'
            ? path.resolve(linkedPath).toLowerCase()
            : path.resolve(linkedPath);
          if (comparableCandidate === comparableLinked) {
            stat.isSymbolicLink = () => true;
          }
          return stat;
        };
      } else {
        throw error;
      }
    }

    try {
      assert.throws(
        () => timelineGenerator.listCSVFlights({ skipDeleteRecovery: true }),
        /not a safe regular file/,
        'low-level listing must fail closed on canonical telemetry symlinks',
      );
      const storage = timelineGenerator.getFlightLogsStorageInfo();
      const landings = await flightLogbook.getLandingsFromCsvFile(linkedPath);
      const storeFlights = await createFlightCsvStore().listFlights();

      assert.deepEqual(landings, [], 'logbook reads must not follow the CSV symlink');
      assert.equal(storage.fileCount, 0, 'storage count must not follow a canonical telemetry symlink');
      assert.equal(storage.totalBytes, 0, 'storage bytes must not follow a canonical telemetry symlink');
      assert.equal(storeFlights.success, false, 'the leased directory snapshot must fail closed');
      assert.equal(storeFlights.error, ACTIVE_CSV_NOT_READY);
      assert.equal(fs.existsSync(outsidePath), true, 'the external target must remain untouched');
    } finally {
      if (originalLstatSync) (fs as any).lstatSync = originalLstatSync;
    }
  });
});

test('generateTimelineForFlightId resolves the immutable bundle name', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const csvPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_bundle-id').csv;
    writeTimelineCsv(csvPath);

    const store = createFlightCsvStore();
    const result = await store.generateTimelineForFlightId('2026-05-25T00-00-00_bundle-id');

    assert.equal(result.success, true, result.error || 'expected timeline generation to succeed');
    assert.equal(result.timeline.aircraft, 'Store Test');
    assert.equal(result.timeline.filePath, path.resolve(csvPath));
  });
});

test('flight-id lookup uses exact recorded identity and fails closed when it is ambiguous', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const first = writeOptOutManifestBundle(logsDir, '2026-05-25_00-00-00Z--identity-a');
    const store = createFlightCsvStore();

    const exact = await store.generateTimelineForFlightId(first.identity.flightId);
    assert.equal(exact.success, true, exact.error || 'recorded flight identity should resolve');
    assert.equal(exact.timeline.filePath, path.resolve(first.csvPath));

    writeOptOutManifestBundle(logsDir, '2026-05-25_00-00-00Z--identity-b');
    const ambiguous = await store.generateTimelineForFlightId(first.identity.flightId);
    assert.equal(ambiguous.success, false);
    assert.match(ambiguous.error, /more than one recording/i);
  });
});

test('normal historic timeline path survives preview, durable rescore, and revert', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const flightLogbook = require(resolveBackendPath('landing', 'flight-logbook.js'));
    const originalGenerateFromCSV = timelineGenerator.generateFromCSV;
    const originalGetLandings = flightLogbook.getLandingsFromCsvFile;
    const { publishRecordingBundleStatus } = require(
      resolveBackendPath('flight-recording', 'recording-bundle-status.js')
    );
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const bundleName = '2026-05-25_00-00-00Z--rescore-e2e';
    const bundle = writeManifestBundle(logsDir, bundleName, true);
    await publishRecordingBundleStatus({
      ...bundle.identity,
      outputDir: logsDir,
      bundleBaseName: bundleName,
      status: 'complete',
      finalizedAtEpochMs: bundle.identity.recordingStartEpochMs + 2_000,
      finalizedAtIso: new Date(bundle.identity.recordingStartEpochMs + 2_000).toISOString(),
      endReason: 'test_end',
    });
    const landingEvent = (mode) => ({
      type: 'landing',
      landingKey: '6',
      aircraftProfileId: 'bundled/msfs/fbw-a32nx',
      vs_fpm: -320,
      grade: mode === 'current-preview' ? 'GOOD' : 'PERFECT',
      landingRateContext: { policy: { id: 'landing-rate-v1', version: 1 } },
      ultimateStability: {
        score: mode === 'current-preview' ? 92 : 80,
        gateStable: mode === 'current-preview',
        gateFailures: mode === 'current-preview' ? [] : ['speed'],
        breakdown: { speed: mode === 'current-preview' ? 95 : 75 },
        scoringContext: { policy: { id: 'stability', version: 2 } },
      },
      touchdownDistance: {
        distanceFt: 900,
        grade: mode === 'current-preview' ? 'Outstanding' : 'Good',
        score: mode === 'current-preview' ? 100 : 85,
        zone: 'Touchdown Zone',
        lateralOffsetFt: 12,
        lateralOffsetGrade: 'Excellent',
        lateralOffsetScore: 98,
        lateralOffsetSide: 'right',
        bounceCount: 0,
        bounceGrade: 'Clean',
        bounceScore: 100,
        shortLanding: false,
      },
      runwayExcursion: false,
      rolloutAnalysis: {
        schemaVersion: 2,
        assessment: mode === 'current-preview' ? 'normal' : 'caution',
        flags: [],
      },
    });
    timelineGenerator.generateFromCSV = async (_csvPath, options) => ({
      success: true,
      timeline: {
        flightId: bundle.identity.flightId,
        events: [landingEvent(options?.scoringMode)],
        track: [],
        analysisRescore: {
          mode: options?.scoringMode || 'recorded',
          scope: 'full-landing-analysis',
          complete: true,
          landingCount: 1,
        },
      },
    });
    flightLogbook.getLandingsFromCsvFile = async () => [{
      landingKey: '6',
      aircraftProfileId: 'bundled/msfs/fbw-a32nx',
      vsFpm: -320,
      grade: 'PERFECT',
      recordedGrade: 'PERFECT',
      runwayExcursion: false,
      shortLanding: false,
    }];

    try {
      const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
      const store = createFlightCsvStore();
      const recorded = await store.generateTimelineFromFile(bundle.csvPath);
      assert.equal(recorded.success, true, recorded.error || 'recorded timeline should load');
      const recordedLanding = recorded.timeline.events.find((event) => event.type === 'landing');
      assert.equal(recordedLanding?.grade, 'PERFECT');

      const preview = await store.generateTimelineFromFile(recorded.timeline.filePath, {
        requestId: 'e2e-preview',
        scoringMode: 'current-preview',
      });
      assert.equal(preview.success, true, preview.error || 'preview timeline should load');
      assert.equal(preview.timeline.analysisRescorePreview.available, true);
      assert(preview.timeline.analysisRescorePreview.changedMetricCount >= 3);

      const previewState = preview.timeline.analysisRescorePreview;
      const applied = await store.applyFlightAnalysisRescore({
        filePath: preview.timeline.filePath,
        flightId: bundle.identity.flightId,
        expectedRevision: previewState.baseRevision,
        expectedSourceFingerprint: previewState.sourceFingerprint,
        expectedPreviewFingerprint: previewState.previewFingerprint,
        expectedAnalysisContractFingerprint: previewState.analysisContractFingerprint,
      });
      assert.equal(applied.success, true, applied.error || 'full analysis should apply atomically');

      const appliedTimeline = await store.generateTimelineFromFile(preview.timeline.filePath);
      const appliedLanding = appliedTimeline.timeline.events.find((event) => event.type === 'landing');
      assert.equal(appliedTimeline.timeline.analysisRescore.applied, true);
      assert.equal(appliedLanding?.grade, 'GOOD');
      assert.equal(appliedLanding?.ultimateStability?.score, 92);
      assert.equal(appliedLanding?.touchdownDistance?.score, 100);
      assert.equal(appliedLanding?.rolloutAnalysis?.assessment, 'normal');

      const reverted = store.revertFlightAnalysisRescore({
        filePath: appliedTimeline.timeline.filePath,
        flightId: bundle.identity.flightId,
        expectedRevision: appliedTimeline.timeline.analysisRescore.revision,
        expectedSnapshotFingerprint: appliedTimeline.timeline.analysisRescore.snapshotFingerprint,
      });
      assert.equal(reverted.success, true, reverted.error || 'full analysis should restore');
      assert.equal(reverted.reverted, true);

      const restoredTimeline = await store.generateTimelineFromFile(appliedTimeline.timeline.filePath);
      const restoredLanding = restoredTimeline.timeline.events.find((event) => event.type === 'landing');
      assert.equal(restoredTimeline.timeline.analysisRescore.applied, false);
      assert.equal(restoredLanding?.grade, 'PERFECT');
    } finally {
      timelineGenerator.generateFromCSV = originalGenerateFromCSV;
      flightLogbook.getLandingsFromCsvFile = originalGetLandings;
    }
  });
});

test('listFlights flushes directory reads and fails closed on flush failure', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { ACTIVE_CSV_NOT_READY, createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const activeCsvPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_active').csv;
    writeTimelineCsv(activeCsvPath);

    let flushCount = 0;
    const readyStore = createFlightCsvStore({
      flightCsvWriter: buildWriter(activeCsvPath, {
        async flush() {
          flushCount += 1;
          return true;
        },
      }),
    });
    const ready = await readyStore.listFlights();
    assert.equal(ready.success, true);
    assert.equal(flushCount, 1);
    assert.equal(ready.flights.length, 1);

    const blockedStore = createFlightCsvStore({
      flightCsvWriter: buildWriter(activeCsvPath, {
        async flush() {
          return false;
        },
      }),
    });
    const blocked = await blockedStore.listFlights();
    assert.equal(blocked.success, false);
    assert.equal(blocked.error, ACTIVE_CSV_NOT_READY);
  });
});

test('listFlights uses the bundle directory as the legacy flightId fallback', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const csvPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_bundle-fallback').csv;
    writeTimelineCsv(csvPath);

    const store = createFlightCsvStore();
    const result = await store.listFlights();

    assert.equal(result.success, true, result.error || 'expected listFlights to succeed');
    const flight = result.flights.find((entry) => entry.filePath === csvPath);
    assert.ok(flight, 'expected canonical telemetry to be listed');
    assert.equal(flight.flightId, '2026-05-25T00-00-00');
  });
});

test('listFlights filters recorder fragments with too few samples', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    writeTimelineCsv(makeBundlePaths(logsDir, '2026-05-25T00-00-00_fragment').csv, 2);
    writeTimelineCsv(makeBundlePaths(logsDir, '2026-05-25T00-01-00_meaningful').csv, 5);

    const store = createFlightCsvStore();
    const result = await store.listFlights();

    assert.equal(result.success, true, result.error || 'expected listFlights to succeed');
    assert.equal(result.flights.length, 1);
    assert.equal(result.flights[0].flightId, '2026-05-25T00-01-00');
    assert.equal(result.flights[0].sampleCount, 5);
  });
});

test('listFlights ignores unrelated CSV files in the flight logs directory', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });

    const unrelatedPath = path.join(logsDir, 'expenses.csv');
    fs.writeFileSync(
      unrelatedPath,
      [
        'timestamp_utc,amount,note',
        '2026-05-25T00:00:00.000Z,12,coffee',
        '2026-05-25T00:00:01.000Z,15,lunch',
        '2026-05-25T00:00:02.000Z,9,parking',
        '2026-05-25T00:00:03.000Z,30,taxi',
        '2026-05-25T00:00:04.000Z,44,hotel',
      ].join('\n') + '\n',
    );
    writeTimelineCsv(makeBundlePaths(logsDir, '2026-05-25T00-01-00_meaningful').csv, 5);

    const store = createFlightCsvStore();
    const result = await store.listFlights();

    assert.equal(result.success, true, result.error || 'expected listFlights to succeed');
    assert.equal(fs.existsSync(unrelatedPath), true, 'unrelated CSV should remain untouched');
    assert.equal(result.flights.length, 1);
    assert.equal(result.flights[0].flightId, '2026-05-25T00-01-00');
  });
});

test('listFlights ignores malformed Flight Fabric-looking CSV files', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });

    const malformedPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_malformed').csv;
    fs.writeFileSync(
      malformedPath,
      [
        'record_type,timestamp_utc,ts,lat_deg,lon_deg,ias_kts,vs_fpm,ra_ft,on_ground,phase,aircraft',
        'SAMPLE,2026-05-25T00:00:00.000Z,1779667200000,47.45,-122.31,140,-500,1000,0,APPROACH,Store Test',
        'SAMPLE,2026-05-25T00:00:01.000Z,1779667201000,47.46,-122.30,139',
        'SAMPLE,2026-05-25T00:00:02.000Z,1779667202000,47.47,-122.29,138,-450,900,0,APPROACH,Store Test',
        'SAMPLE,2026-05-25T00:00:03.000Z,1779667203000,47.48,-122.28,137,-425,850,0,APPROACH,Store Test',
        'SAMPLE,2026-05-25T00:00:04.000Z,1779667204000,47.49,-122.27,136,-400,800,0,APPROACH,Store Test',
      ].join('\n') + '\n',
    );
    writeTimelineCsv(makeBundlePaths(logsDir, '2026-05-25T00-01-00_meaningful').csv, 5);

    const store = createFlightCsvStore();
    const result = await store.listFlights();

    assert.equal(result.success, true, result.error || 'expected listFlights to succeed');
    assert.equal(fs.existsSync(malformedPath), true, 'malformed CSV should remain untouched');
    assert.equal(result.flights.length, 1);
    assert.equal(result.flights[0].flightId, '2026-05-25T00-01-00');
  });
});

test('flight-analysis rescore store facade resolves only owned historic recordings', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const sidecar = require(resolveBackendPath('flight-recording', 'flight-analysis-rescore-sidecar.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const csvPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_rescore').csv;
    writeTimelineCsv(csvPath);

    const calls: Array<Record<string, any>> = [];
    const originalRevert = sidecar.revertFlightAnalysisRescore;
    sidecar.revertFlightAnalysisRescore = (request) => {
      calls.push({ action: 'revert', request });
      return { success: true, reverted: true, revision: 1 };
    };
    try {
      const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
      const store = createFlightCsvStore();
      const outside = await store.applyFlightAnalysisRescore({
        filePath: path.join(path.dirname(logsDir), 'outside.csv'),
        expectedRevision: 0,
        expectedSourceFingerprint: 'a'.repeat(64),
        expectedPreviewFingerprint: 'b'.repeat(64),
        expectedAnalysisContractFingerprint: 'c'.repeat(64),
      });
      assert.equal(outside.success, false);
      assert.equal(calls.length, 0);

      const reverted = store.revertFlightAnalysisRescore({
        flightId: '2026-05-25T00-00-00_rescore',
        expectedRevision: 1,
        expectedSnapshotFingerprint: 'd'.repeat(64),
      });

      assert.equal(reverted.success, true);
      assert.deepEqual(calls, [
        {
          action: 'revert',
          request: {
            csvPath,
            flightLogsDir: logsDir,
            expectedRevision: 1,
            expectedSnapshotFingerprint: 'd'.repeat(64),
          },
        },
      ]);
    } finally {
      sidecar.revertFlightAnalysisRescore = originalRevert;
    }
  });
});

test('listFlightsIndexed refreshes SQLite index and returns a bounded page', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    writeIndexedTimelineCsv(makeBundlePaths(logsDir, '2026-05-25T00-00-00_indexed-a').csv, {
      aircraft: 'Indexed Alpha',
      flightId: 'indexed-a',
      startIso: '2026-05-25T00:00:00.000Z',
    });
    const indexedBPath = makeBundlePaths(logsDir, '2026-05-26T00-00-00_indexed-b').csv;
    writeIndexedTimelineCsv(indexedBPath, {
      aircraft: 'Indexed Bravo',
      flightId: 'indexed-b',
      startIso: '2026-05-26T00:00:00.000Z',
    });

    const store = createFlightCsvStore();
    const initial = await store.listFlightsIndexed({ limit: 1 });
    assert.equal(initial.success, true);
    assert.equal(initial.index.status.busy, true);
    await waitForHistoryIndex(store);
    const result = await store.listFlightsIndexed({ limit: 1 });

    assert.equal(result.success, true, result.error || 'expected indexed list to succeed');
    assert.equal(result.index.used, true, result.index.error || 'expected SQLite index to be used');
    assert.equal(result.index.totalMatching, 2);
    assert.equal(result.index.limit, 1);
    assert.equal(result.index.offset, 0);
    assert.equal(result.index.status.indexedFiles, 2);
    assert.equal(result.index.status.deepScans, 2);
    assert.equal(result.flights.length, 1);
    assert.equal(result.flights[0].flightId, '2026-05-26T00-00-00');
    assert.equal(result.flights[0].aircraft, 'Indexed Bravo');
    assert.equal(result.flights[0].filePath, indexedBPath);

    const filtered = await store.listFlightsIndexed({ aircraftFilter: 'Alpha', limit: 10 });
    assert.equal(filtered.success, true);
    assert.equal(filtered.index.used, true);
    assert.equal(filtered.index.totalMatching, 1);
    assert.equal(filtered.flights.length, 1);
    assert.equal(filtered.flights[0].aircraft, 'Indexed Alpha');

    const rebuild = await store.startHistoryIndex({ rebuild: true });
    assert.equal(rebuild.success, true);
    assert.equal(rebuild.status.busy, true);
    const rebuiltStatus = await waitForHistoryIndex(store);
    assert.equal(rebuiltStatus.summaryHits, 2, 'SQLite rebuild should use tiny portable summaries');
    assert.equal(rebuiltStatus.deepScans, 0, 'valid summaries must avoid reparsing telemetry CSV rows');
    const rebuilt = await store.listFlightsIndexed({ limit: 10 });
    assert.equal(rebuilt.success, true);
    assert.equal(rebuilt.index.totalMatching, 2);
  });
});

test('busy history progress reads SQLite without taking repeated directory-wide leases', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const leaseProtocol = require(resolveBackendPath('flight-recording', 'recording-bundle-lease.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    writeIndexedTimelineCsv(makeBundlePaths(logsDir, '2026-05-25T00-00-00_progress').csv, {
      aircraft: 'Progress Test',
      flightId: 'progress-test',
    });

    const acquireDirectoryOriginal = leaseProtocol.acquireBundleDirectoryReadLeases;
    const acquireCatalogOriginal = leaseProtocol.acquireBundleCatalogSnapshotLease;
    let directoryLeaseCount = 0;
    let catalogSnapshotCount = 0;
    leaseProtocol.acquireBundleDirectoryReadLeases = (leaseOptions) => {
      directoryLeaseCount += 1;
      return acquireDirectoryOriginal(leaseOptions);
    };
    leaseProtocol.acquireBundleCatalogSnapshotLease = (leaseOptions) => {
      catalogSnapshotCount += 1;
      return acquireCatalogOriginal(leaseOptions);
    };
    try {
      const store = createFlightCsvStore();
      const initial = await store.listFlightsIndexed({ limit: 10 });
      assert.equal(initial.success, true);
      assert.equal(initial.index.status.busy, true);
      assert.equal(directoryLeaseCount, 0);
      assert.equal(catalogSnapshotCount, 1);

      const progressiveFlights = await store.listFlightsIndexed({ limit: 10 });
      const progressiveLogbook = await store.getLogbook({ entryLimit: 10 });
      assert.equal(progressiveFlights.success, true);
      assert.equal(progressiveFlights.index.used, true);
      assert.equal(progressiveLogbook.success, true);
      assert.equal(progressiveLogbook.index.used, true);
      assert.equal(
        directoryLeaseCount,
        0,
        'history refresh must not create a directory-wide per-bundle lease group',
      );
      assert.equal(catalogSnapshotCount, 1, 'busy UI polling must reuse the existing catalog snapshot');

      await waitForHistoryIndex(store);
    } finally {
      leaseProtocol.acquireBundleDirectoryReadLeases = acquireDirectoryOriginal;
      leaseProtocol.acquireBundleCatalogSnapshotLease = acquireCatalogOriginal;
    }
  });
});

test('listFlightsIndexed keeps fallback responses bounded when SQLite cannot open', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const fallbackPaths = makeBundlePaths(logsDir, '2026-05-25T00-00-00_fallback-a');
    const fallbackCsvPath = fallbackPaths.csv;
    writeIndexedTimelineCsv(fallbackCsvPath, {
      aircraft: 'Fallback Alpha',
      flightId: 'fallback-a',
      startIso: '2026-05-25T00:00:00.000Z',
    });
    const fallbackAutomationPath = fallbackPaths.automation;
    fs.writeFileSync(fallbackAutomationPath, '{"type":"legacy_automation"}\n');
    writeIndexedTimelineCsv(makeBundlePaths(logsDir, '2026-05-26T00-00-00_fallback-b').csv, {
      aircraft: 'Fallback Bravo',
      flightId: 'fallback-b',
      startIso: '2026-05-26T00:00:00.000Z',
    });

    const store = createFlightCsvStore({
      openHistoryIndexStore() {
        return { success: false, available: false, dbPath: '', error: 'forced sqlite failure' };
      },
    });
    const result = await store.listFlightsIndexed({ aircraftFilter: 'Alpha', limit: 1 });

    assert.equal(result.success, true, result.error || 'expected fallback list to succeed');
    assert.equal(result.index.used, false);
    assert.equal(result.index.paged, true);
    assert.equal(result.index.fallback, 'open_failed');
    assert.equal(result.index.totalMatching, 1);
    assert.equal(result.index.limit, 1);
    assert.equal(result.flights.length, 1);
    assert.equal(result.flights[0].aircraft, 'Fallback Alpha');
    assert.equal(
      result.flights[0].sizeBytes,
      fs.statSync(fallbackCsvPath).size + fs.statSync(fallbackAutomationPath).size,
      'fallback rows must report all existing bundle bytes',
    );
    assert.equal(result.flights[0].recordingBundleSizeBytes, result.flights[0].sizeBytes);
    assert.equal(result.flights[0].csvSizeBytes, fs.statSync(fallbackCsvPath).size);
  });
});

test('listFlightsIndexed serves completed bundles on flush failure without a completed index', async () => {
  await withTempAppData(async () => {
    const leaseProtocol = require(resolveBackendPath('flight-recording', 'recording-bundle-lease.js'));
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { ACTIVE_CSV_NOT_READY, createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const activeBaseName = '2026-05-25T00-00-00_active';
    const activeCsvPath = makeBundlePaths(logsDir, activeBaseName).csv;
    const completedCsvPath = makeBundlePaths(logsDir, '2026-05-24T00-00-00_completed').csv;
    writeTimelineCsv(activeCsvPath);
    writeTimelineCsv(completedCsvPath);
    const recordingLease = leaseProtocol.acquireRecordingBundleLease({
      outputDir: logsDir,
      baseName: activeBaseName,
      purpose: 'recording',
      createDirectory: true,
    });
    assert.equal(recordingLease.acquired, true);

    try {
      const store = createFlightCsvStore({
        flightCsvWriter: buildWriter(activeCsvPath, {
          async flush() {
            return false;
          },
        }),
      });

      const result = await store.listFlightsIndexed();

      assert.equal(result.success, true, result.error || 'expected completed-bundle fallback');
      assert.equal(result.flights.length, 1);
      assert.equal(result.flights[0].filePath, completedCsvPath);
      assert.equal(result.index?.used, false);
      assert.equal(result.index?.fallback, 'completed_bundle_snapshot');
      assert.equal(result.index?.stale, true);
      assert.equal(result.index?.staleReason, ACTIVE_CSV_NOT_READY);
    } finally {
      recordingLease.release?.();
    }
  });
});

test('listFlightsIndexed does not flush the committed live bundle before serving saved flights', async () => {
  await withTempAppData(async () => {
    const bundleLifecycle = require(resolveBackendPath('flight-recording', 'recording-bundle-lifecycle.js'));
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });

    const activeBaseName = '2026-05-25T00-00-00_committed-startup';
    const activePaths = makeBundlePaths(logsDir, activeBaseName);
    const completedCsvPath = makeBundlePaths(logsDir, '2026-05-24T00-00-00_saved').csv;
    writeTimelineCsv(activePaths.csv);
    writeTimelineCsv(completedCsvPath);

    const recordingSessionId = 'committed-startup-session';
    const recordingStartEpochMs = Date.parse('2026-05-25T00:00:00.000Z');
    bundleLifecycle.beginRecordingBundleStartup({
      recordingSessionId,
      flightId: 'committed-startup-flight',
      recordingStartEpochMs,
      recordingStartIso: new Date(recordingStartEpochMs).toISOString(),
      outputDir: logsDir,
      baseName: activeBaseName,
      csvPath: activePaths.csv,
    });
    bundleLifecycle.commitRecordingBundleStartup(recordingSessionId);

    let flushCount = 0;
    const recordingBundleGuard = {
      isOwnedCsvPath: (candidate: unknown) => bundleLifecycle.isOwnedRecordingBundleCsvPath(candidate),
      isFinalizing: () => Boolean(bundleLifecycle.getFinalizingRecordingBundle()),
      isBusy: () => Boolean(bundleLifecycle.getStartingRecordingBundle()),
      getActiveCsvPath: () => (
        bundleLifecycle.getActiveRecordingBundle()?.csvPath
        || bundleLifecycle.getStartingRecordingBundle()?.csvPath
        || bundleLifecycle.getFinalizingRecordingBundle()?.csvPath
        || null
      ),
      async flushActiveBundle() {
        flushCount += 1;
        return await new Promise<boolean>(() => {});
      },
    };

    try {
      const store = createFlightCsvStore({
        openHistoryIndexStore: () => ({
          success: false,
          available: true,
          error: 'Injected unavailable index',
        }),
        recordingBundleGuard,
      });
      const timeoutToken = Symbol('timeline-list-timeout');
      let timeoutHandle: NodeJS.Timeout | null = null;
      const result = await Promise.race([
        store.listFlightsIndexed({ limit: 10 }),
        new Promise<typeof timeoutToken>((resolve) => {
          timeoutHandle = setTimeout(() => resolve(timeoutToken), 1_000);
        }),
      ]);
      if (timeoutHandle) clearTimeout(timeoutHandle);

      if (result === timeoutToken) {
        assert.fail('saved-flight listing must not wait for a live bundle flush');
      }
      assert.equal(result.success, true, result.error || 'saved flights should load during recording');
      assert.equal(flushCount, 0, 'finalized history must not flush the live recording bundle');
      assert(
        result.flights.some((flight) => flight.filePath === completedCsvPath),
        'the finalized saved flight must remain visible while another flight is active',
      );
      assert(
        result.flights.every((flight) => flight.filePath !== activePaths.csv),
        'the in-progress bundle must be omitted from Recent Flights',
      );
    } finally {
      bundleLifecycle.markRecordingBundleFinalizing(recordingSessionId);
      bundleLifecycle.finishRecordingBundle(recordingSessionId);
      bundleLifecycle.resetRecordingBundleLifecycleForTests();
    }
  });
});

test('listFlightsIndexed excludes a known finalizing bundle from the completed-bundle fallback', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const finalizingCsvPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_finalizing-list').csv;
    const completedCsvPath = makeBundlePaths(logsDir, '2026-05-24T00-00-00_completed-list').csv;
    writeTimelineCsv(finalizingCsvPath);
    writeTimelineCsv(completedCsvPath);

    const store = createFlightCsvStore({
      openHistoryIndexStore: () => ({ success: false, available: true, error: 'Injected unavailable index' }),
      recordingBundleGuard: {
        isFinalizing: () => true,
        isBusy: () => false,
        getActiveCsvPath: () => finalizingCsvPath,
      },
    });
    const result = await store.listFlightsIndexed();

    assert.equal(result.success, true, result.error || 'expected completed-bundle fallback');
    assert.deepEqual(result.flights.map((flight) => flight.filePath), [completedCsvPath]);
    assert.equal(result.index?.fallback, 'completed_bundle_snapshot');
  });
});

test('listFlightsIndexed fails closed when a busy bundle path is unavailable', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { ACTIVE_CSV_NOT_READY, createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const possiblyActiveCsvPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_unknown-busy').csv;
    writeTimelineCsv(possiblyActiveCsvPath);

    const store = createFlightCsvStore({
      openHistoryIndexStore: () => ({ success: false, available: true, error: 'Injected unavailable index' }),
      recordingBundleGuard: {
        isFinalizing: () => true,
        isBusy: () => false,
        getActiveCsvPath: () => null,
      },
    });
    const result = await store.listFlightsIndexed();

    assert.equal(result.success, false);
    assert.equal(result.error, ACTIVE_CSV_NOT_READY);
  });
});

test('listFlightsIndexed falls back to completed bundles when the completed SQLite snapshot cannot be queried', async () => {
  await withTempAppData(async () => {
    const leaseProtocol = require(resolveBackendPath('flight-recording', 'recording-bundle-lease.js'));
    const { openHistoryIndexStore } = require(resolveBackendPath('history-index', 'history-index-store.js'));
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { ACTIVE_CSV_NOT_READY, createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const completedCsvPath = makeBundlePaths(logsDir, '2026-05-24T00-00-00_completed-index').csv;
    writeIndexedTimelineCsv(completedCsvPath, {
      aircraft: 'Completed Index Fallback',
      flightId: 'completed-index-fallback',
    });

    let rejectIndexQueries = false;
    const controlledOpenHistoryIndexStore = () => (
      rejectIndexQueries
        ? { success: false, available: true, error: 'Injected completed-index query failure' }
        : openHistoryIndexStore()
    );
    const indexingStore = createFlightCsvStore({
      openHistoryIndexStore: controlledOpenHistoryIndexStore,
    });
    const initial = await indexingStore.listFlightsIndexed({ limit: 10 });
    assert.equal(initial.success, true, initial.error || 'expected initial index request to succeed');
    await waitForHistoryIndex(indexingStore);
    const indexed = await indexingStore.listFlightsIndexed({ limit: 10 });
    assert.equal(indexed.success, true, indexed.error || 'expected completed index');
    assert.equal(indexed.index?.used, true);

    const activeBaseName = '2026-05-25T00-00-00_active-index-fallback';
    const activeCsvPath = makeBundlePaths(logsDir, activeBaseName).csv;
    writeTimelineCsv(activeCsvPath);
    const recordingLease = leaseProtocol.acquireRecordingBundleLease({
      outputDir: logsDir,
      baseName: activeBaseName,
      purpose: 'recording',
      createDirectory: true,
    });
    assert.equal(recordingLease.acquired, true);

    try {
      rejectIndexQueries = true;
      const blockedStore = createFlightCsvStore({
        openHistoryIndexStore: controlledOpenHistoryIndexStore,
        flightCsvWriter: buildWriter(activeCsvPath, {
          async flush() {
            return false;
          },
        }),
      });
      const fallback = await blockedStore.listFlightsIndexed({ limit: 10 });

      assert.equal(fallback.success, true, fallback.error || 'expected completed-bundle fallback');
      assert.equal(fallback.flights.length, 1);
      assert.equal(fallback.flights[0].filePath, completedCsvPath);
      assert.equal(fallback.flights[0].aircraft, 'Completed Index Fallback');
      assert.equal(fallback.index?.used, false);
      assert.equal(fallback.index?.fallback, 'completed_bundle_snapshot');
      assert.equal(fallback.index?.stale, true);
      assert.equal(fallback.index?.staleReason, ACTIVE_CSV_NOT_READY);
    } finally {
      recordingLease.release?.();
    }
  });
});

test('listFlightsIndexed serves the completed index when an active CSV cannot flush', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { ACTIVE_CSV_NOT_READY, createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const csvPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_index-fallback').csv;
    writeIndexedTimelineCsv(csvPath, {
      aircraft: 'Index Fallback',
      flightId: 'index-fallback',
    });

    const indexingStore = createFlightCsvStore();
    const initial = await indexingStore.listFlightsIndexed({ limit: 10 });
    assert.equal(initial.success, true, initial.error || 'expected initial list to succeed');
    await waitForHistoryIndex(indexingStore);
    const indexed = await indexingStore.listFlightsIndexed({ limit: 10 });
    assert.equal(indexed.success, true, indexed.error || 'expected indexed list to succeed');
    assert.equal(indexed.flights.length, 1);

    const blockedStore = createFlightCsvStore({
      flightCsvWriter: buildWriter(csvPath, {
        async flush() {
          return false;
        },
      }),
    });
    const fallback = await blockedStore.listFlightsIndexed({ limit: 10 });

    assert.equal(fallback.success, true, fallback.error || 'expected completed-index fallback');
    assert.equal(fallback.flights.length, 1);
    assert.equal(fallback.flights[0].aircraft, 'Index Fallback');
    assert.equal(fallback.index?.used, true);
    assert.equal(fallback.index?.stale, true);
    assert.equal(fallback.index?.staleReason, ACTIVE_CSV_NOT_READY);
  });
});

test('indexed history reports catalog I/O failures instead of treating them as an empty history', async () => {
  await withTempAppData(async () => {
    const leaseProtocol = require(resolveBackendPath('flight-recording', 'recording-bundle-lease.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const acquireCatalogOriginal = leaseProtocol.acquireBundleCatalogSnapshotLease;
    leaseProtocol.acquireBundleCatalogSnapshotLease = () => ({
      acquired: false,
      reason: 'io_error',
      error: 'EACCES',
    });
    try {
      const result = await createFlightCsvStore().listFlightsIndexed();
      assert.equal(result.success, false);
      assert.match(result.error, /catalog is unavailable.*EACCES/i);
    } finally {
      leaseProtocol.acquireBundleCatalogSnapshotLease = acquireCatalogOriginal;
    }
  });
});

test('getLogbook flushes active CSV and bypasses cached active-file data', async () => {
  await withTempAppData(async () => {
    const { resolveFlightLogsDir } = require(resolveBackendPath('utils', 'flight-logs-dir.js'));
    const { getLandingsFromCSVs } = require(resolveBackendPath('landing', 'flight-logbook.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = resolveFlightLogsDir({ createIfMissing: true });
    fs.mkdirSync(logsDir, { recursive: true });
    const activeCsvPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_active').csv;
    const header = 'record_type,timestamp_utc,ts,vs_fpm,ias_kts,g_force,icao,runway,aircraft';
    fs.writeFileSync(
      activeCsvPath,
      [
        header,
        'SAMPLE,2026-05-25T00:00:00.000Z,1779638400000,-500,140,1.2,YSSY,34L,Cache Test',
      ].join('\n') + '\n',
    );
    const fixedMtime = new Date('2026-05-25T00:00:10.000Z');
    fs.utimesSync(activeCsvPath, fixedMtime, fixedMtime);

    const cachedEntries = await getLandingsFromCSVs();
    assert.equal(cachedEntries.length, 0);

    fs.writeFileSync(
      activeCsvPath,
      [
        header,
        'SAMPLE,2026-05-25T00:00:00.000Z,1779638400000,-500,140,1.2,YSSY,34L,Cache Test',
        'LANDING,2026-05-25T00:01:00.000Z,1779638460000,-420,132,1.35,YSSY,34L,Cache Test',
      ].join('\n') + '\n',
    );
    fs.utimesSync(activeCsvPath, fixedMtime, fixedMtime);

    let flushed = false;
    const store = createFlightCsvStore({
      flightCsvWriter: buildWriter(activeCsvPath, {
        async flush() {
          flushed = true;
          return true;
        },
      }),
    });
    const initialResponse = await store.getLogbook();
    assert.equal(initialResponse.success, true);
    assert.equal(initialResponse.index?.status?.busy, true);
    const completedIndex = await waitForHistoryIndex(store);
    const result = await store.getLogbook();

    assert.equal(flushed, true);
    assert.equal(result.success, true);
    assert.equal(result.entries.length, 1, JSON.stringify(completedIndex));
    assert.equal(result.entries[0].icao, 'YSSY');
    assert.equal(result.stats.total, 1);
  });
});

test('getLogbook serves the completed index when an active CSV cannot flush', async () => {
  await withTempAppData(async () => {
    const { resolveFlightLogsDir } = require(resolveBackendPath('utils', 'flight-logs-dir.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = resolveFlightLogsDir({ createIfMissing: true });
    fs.mkdirSync(logsDir, { recursive: true });
    const csvPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_index-fallback').csv;
    const header = 'record_type,timestamp_utc,ts,vs_fpm,ias_kts,g_force,icao,runway,aircraft';
    fs.writeFileSync(
      csvPath,
      [
        header,
        'LANDING,2026-05-25T00:01:00.000Z,1779638460000,-420,132,1.35,YSSY,34L,Index Fallback',
      ].join('\n') + '\n',
    );

    const indexingStore = createFlightCsvStore();
    const initial = await indexingStore.getLogbook();
    assert.equal(initial.success, true);
    await waitForHistoryIndex(indexingStore);
    const indexed = await indexingStore.getLogbook();
    assert.equal(indexed.success, true);
    assert.equal(indexed.stats.total, 1);

    const blockedStore = createFlightCsvStore({
      flightCsvWriter: buildWriter(csvPath, {
        async flush() {
          return false;
        },
      }),
    });
    const fallback = await blockedStore.getLogbook();

    assert.equal(fallback.success, true);
    assert.equal(fallback.entries.length, 1);
    assert.equal(fallback.entries[0].icao, 'YSSY');
    assert.equal(fallback.stats.total, 1);
    assert.equal(fallback.index?.used, true);
    assert.equal(fallback.index?.stale, true);
    assert.equal(fallback.index?.staleReason, 'Active flight CSV is not ready yet');
  });
});

test('getLogbook falls back to completed bundles when the completed SQLite snapshot cannot be queried', async () => {
  await withTempAppData(async () => {
    const leaseProtocol = require(resolveBackendPath('flight-recording', 'recording-bundle-lease.js'));
    const { openHistoryIndexStore } = require(resolveBackendPath('history-index', 'history-index-store.js'));
    const { resolveFlightLogsDir } = require(resolveBackendPath('utils', 'flight-logs-dir.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = resolveFlightLogsDir({ createIfMissing: true });
    fs.mkdirSync(logsDir, { recursive: true });
    const completedCsvPath = makeBundlePaths(logsDir, '2026-05-24T00-00-00_completed-logbook').csv;
    const header = 'record_type,timestamp_utc,ts,vs_fpm,ias_kts,g_force,icao,runway,aircraft';
    fs.writeFileSync(
      completedCsvPath,
      [
        header,
        'LANDING,2026-05-24T00:01:00.000Z,1779552060000,-390,128,1.28,YMML,27,Completed Logbook',
      ].join('\n') + '\n',
    );

    let rejectIndexQueries = false;
    const controlledOpenHistoryIndexStore = () => (
      rejectIndexQueries
        ? { success: false, available: true, error: 'Injected completed-index query failure' }
        : openHistoryIndexStore()
    );
    const indexingStore = createFlightCsvStore({
      openHistoryIndexStore: controlledOpenHistoryIndexStore,
    });
    const initial = await indexingStore.getLogbook();
    assert.equal(initial.success, true);
    await waitForHistoryIndex(indexingStore);
    const indexed = await indexingStore.getLogbook();
    assert.equal(indexed.success, true);
    assert.equal(indexed.stats.total, 1);
    assert.equal(indexed.index?.used, true);
    assert.equal(indexed.entries[0].stabilityScore, null);
    assert.equal(indexed.entries[0].stabilityVerdict, 'no_verdict');
    const indexedAircraftTrend = indexed.stats.trends.aircraft[0];
    assert.equal(indexedAircraftTrend.avgStabilityScore, null);
    assert.equal(indexedAircraftTrend.stableRatePct, null);
    assert.equal(indexedAircraftTrend.marginalRatePct, null);
    assert.equal(indexedAircraftTrend.trendStability, null);

    const activeBaseName = '2026-05-25T00-00-00_active-logbook-fallback';
    const activeCsvPath = makeBundlePaths(logsDir, activeBaseName).csv;
    fs.writeFileSync(
      activeCsvPath,
      [
        header,
        'SAMPLE,2026-05-25T00:00:00.000Z,1779638400000,-500,140,1.2,,,Active Flight',
      ].join('\n') + '\n',
    );
    const recordingLease = leaseProtocol.acquireRecordingBundleLease({
      outputDir: logsDir,
      baseName: activeBaseName,
      purpose: 'recording',
      createDirectory: true,
    });
    assert.equal(recordingLease.acquired, true);

    try {
      rejectIndexQueries = true;
      const blockedStore = createFlightCsvStore({
        openHistoryIndexStore: controlledOpenHistoryIndexStore,
        flightCsvWriter: buildWriter(activeCsvPath, {
          async flush() {
            return false;
          },
        }),
      });
      const fallback = await blockedStore.getLogbook();

      assert.equal(fallback.success, true);
      assert.equal(fallback.entries.length, 1);
      assert.equal(fallback.entries[0].icao, 'YMML');
      assert.equal(fallback.entries[0].stabilityScore, null);
      assert.equal(fallback.entries[0].stabilityVerdict, 'no_verdict');
      assert.equal(fallback.stats.total, 1);
      const fallbackAircraftTrend = fallback.stats.trends.aircraft[0];
      assert.deepEqual(
        {
          avgStabilityScore: fallbackAircraftTrend.avgStabilityScore,
          stableRatePct: fallbackAircraftTrend.stableRatePct,
          marginalRatePct: fallbackAircraftTrend.marginalRatePct,
          trendStability: fallbackAircraftTrend.trendStability,
        },
        {
          avgStabilityScore: indexedAircraftTrend.avgStabilityScore,
          stableRatePct: indexedAircraftTrend.stableRatePct,
          marginalRatePct: indexedAircraftTrend.marginalRatePct,
          trendStability: indexedAircraftTrend.trendStability,
        },
      );
      assert.equal(fallback.index?.used, false);
      assert.equal(fallback.index?.fallback, 'completed_bundle_snapshot');
      assert.equal(fallback.index?.stale, true);
      assert.equal(fallback.index?.staleReason, 'Active flight CSV is not ready yet');
    } finally {
      recordingLease.release?.();
    }
  });
});

test('opt-out manifest sidecar tamper invalidates warm logbook cache and SQLite source', async () => {
  await withTempAppData(async () => {
    const { resolveFlightLogsDir } = require(resolveBackendPath('utils', 'flight-logs-dir.js'));
    const { getLandingsFromCsvFile } = require(resolveBackendPath('landing', 'flight-logbook.js'));
    const { loadNodeSqlite } = require(resolveBackendPath('history-index', 'sqlite-runtime.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = resolveFlightLogsDir({ createIfMissing: true });
    const bundle = writeOptOutManifestBundle(logsDir, '2026-05-25T00-00-00_optout-cache');
    const sqliteAvailable = loadNodeSqlite().available === true;
    const store = createFlightCsvStore({
      flightCsvWriter: buildWriter(path.join(logsDir, 'inactive.csv'), {
        isRecording() {
          return false;
        },
      }),
    });

    const initial = await store.getLogbook();
    assert.equal(initial.success, true);
    await waitForHistoryIndex(store);
    const first = await store.getLogbook();
    assert.equal(first.success, true);
    assert.equal(first.entries.length, 1);
    assert.equal(first.entries[0].icao, 'YSCB');
    if (sqliteAvailable) {
      assert.equal(first.index?.used, true);
      assert.equal(first.index?.status.indexedFiles, 1);
    }

    const original = fs.readFileSync(bundle.automationPath, 'utf8');
    const changedSessionId = `${bundle.identity.recordingSessionId.slice(0, -1)}x`;
    const tampered = original.replace(bundle.identity.recordingSessionId, changedSessionId);
    assert.notEqual(tampered, original);
    assert.equal(Buffer.byteLength(tampered), Buffer.byteLength(original));
    const originalStat = fs.statSync(bundle.automationPath);
    fs.writeFileSync(bundle.automationPath, tampered, 'utf8');
    const advancedMtime = new Date(originalStat.mtimeMs + 2_000);
    fs.utimesSync(bundle.automationPath, advancedMtime, advancedMtime);

    const directAfterTamper = await getLandingsFromCsvFile(bundle.csvPath);
    assert.deepEqual(directAfterTamper, [],
      'a warm cache must not bypass a changed opt-out sidecar identity');

    const invalidating = await store.getLogbook();
    assert.equal(invalidating.success, true);
    await waitForHistoryIndex(store);
    const second = await store.getLogbook();
    assert.equal(second.success, true);
    assert.deepEqual(second.entries, []);
    assert.equal(second.stats.total, 0);
    if (sqliteAvailable) {
      assert.equal(second.index?.used, true);
      assert.equal(second.index?.status.totalFiles, 0,
        'the invalidated whole-bundle source must be removed from SQLite');
    }
  });
});

test('getLogbook caps returned entries while preserving all-time stats', async () => {
  await withTempAppData(async () => {
    const { resolveFlightLogsDir } = require(resolveBackendPath('utils', 'flight-logs-dir.js'));
    const { loadNodeSqlite } = require(resolveBackendPath('history-index', 'sqlite-runtime.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const sqliteAvailable = loadNodeSqlite().available === true;
    const logsDir = resolveFlightLogsDir({ createIfMissing: true });
    const csvPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_many-landings').csv;
    const headers = ['record_type', 'timestamp_utc', 'ts', 'vs_fpm', 'grade', 'icao', 'runway', 'aircraft', 'touchdown_distance_grade'];
    const startMs = Date.parse('2026-05-25T00:00:00.000Z');
    const rows = Array.from({ length: 505 }, (_, index) => {
      const ts = startMs + index * 60000;
      const touchdownGrade = index === 0 ? 'Long Landing' : 'Good';
      return ['LANDING', new Date(ts).toISOString(), ts, -300 - (index % 5), 'GOOD', 'YSSY', '34L', 'Scale Test', touchdownGrade].join(',');
    });
    fs.writeFileSync(csvPath, [headers.join(','), ...rows].join('\n') + '\n', 'utf8');

    const store = createFlightCsvStore({
      flightCsvWriter: buildWriter(path.join(logsDir, 'inactive.csv'), {
        isRecording() {
          return false;
        },
      }),
    });

    const initial = await store.getLogbook();
    assert.equal(initial.success, true);
    assert.equal(initial.index?.status?.busy, true);
    await waitForHistoryIndex(store);
    const result = await store.getLogbook();

    assert.equal(result.success, true);
    if (sqliteAvailable) {
      assert.equal(result.index?.used, true);
      assert.equal(result.index?.totalMatching, 505);
    }
    assert.equal(result.entries.length, 500);
    assert.equal(result.stats.total, 505);
    assert.equal(result.stats.outcomeGrades.FIRM, 504);
    assert.equal(result.stats.outcomeGrades['Long Landing'], 1);
    assert.equal(result.stats.longLandingCount, 1);
  });
});

test('getLogbook skips oversized CSVs before reading file contents', async () => {
  await withTempAppData(async () => {
    const { resolveFlightLogsDir } = require(resolveBackendPath('utils', 'flight-logs-dir.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = resolveFlightLogsDir({ createIfMissing: true });
    const hugeCsvPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_huge').csv;
    const fd = fs.openSync(hugeCsvPath, 'w');
    try {
      fs.ftruncateSync(fd, 200 * 1024 * 1024 + 1);
    } finally {
      fs.closeSync(fd);
    }

    let hugeReadCount = 0;
    const originalReadFile = fs.promises.readFile;
    fs.promises.readFile = async function patchedReadFile(filePath, ...args) {
      if (path.resolve(String(filePath)) === path.resolve(hugeCsvPath)) {
        hugeReadCount += 1;
      }
      return await originalReadFile.call(this, filePath, ...args);
    };

    try {
      const store = createFlightCsvStore({
        flightCsvWriter: buildWriter(path.join(logsDir, 'inactive.csv'), {
          isRecording() {
            return false;
          },
        }),
      });

      const result = await store.getLogbook();

      assert.equal(result.success, true);
      await waitForHistoryIndex(store);
      assert.equal(hugeReadCount, 0);
    } finally {
      fs.promises.readFile = originalReadFile;
    }
  });
});

test('deleteFlightCsv refuses to delete the active recording path', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const activeCsvPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_active').csv;
    fs.writeFileSync(activeCsvPath, 'record_type,timestamp_utc\nSAMPLE,2026-05-25T00:00:00.000Z\n');

    const store = createFlightCsvStore({ flightCsvWriter: buildWriter(activeCsvPath) });
    const requestedPath = process.platform === 'win32' ? activeCsvPath.toUpperCase() : activeCsvPath;
    const result = store.deleteFlightCsv(requestedPath);

    assert.equal(result.success, false);
    assert.equal(result.error, 'Cannot delete an active or finalizing recording');
    assert.equal(fs.existsSync(activeCsvPath), true);
  });
});

test('deleteFlightCsv refuses to delete a finalizing recording path', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const { createFlightCsvStore } = require(resolveBackendPath('flight-recording', 'flight-csv-store.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const finalizingCsvPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_finalizing').csv;
    fs.writeFileSync(finalizingCsvPath, 'record_type,timestamp_utc\n');

    const store = createFlightCsvStore({
      flightCsvWriter: buildWriter(finalizingCsvPath, {
        isRecording() {
          return false;
        },
        isFinalizing() {
          return true;
        },
        getFinalizingStats() {
          return { filePath: finalizingCsvPath };
        },
      }),
    });
    const result = store.deleteFlightCsv(finalizingCsvPath);

    assert.equal(result.success, false);
    assert.equal(result.error, 'Cannot delete an active or finalizing recording');
    assert.equal(fs.existsSync(finalizingCsvPath), true);
  });
});

test('deleteFlightCsv refuses stale file identity metadata', async () => {
  await withTempAppData(async () => {
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const csvPath = makeBundlePaths(logsDir, '2026-05-25T00-00-00_stale').csv;
    fs.writeFileSync(csvPath, 'record_type,timestamp_utc\n');
    const identity = fileIdentity(csvPath);

    fs.writeFileSync(csvPath, 'record_type,timestamp_utc\nSAMPLE,2026-05-25T00:00:00.000Z\n');
    const result = timelineGenerator.deleteFlightCsv(csvPath, identity);

    assert.equal(result.success, false);
    assert.equal(result.error, 'Flight log changed on disk. Refresh the list and try again.');
    assert.equal(fs.existsSync(csvPath), true);
  });
});

export {};
