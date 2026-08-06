'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const test = require('node:test') as typeof import('node:test');

const timeSource = require('../core/time-source.js') as typeof import('../core/time-source');
const { parseCsvLine, splitCsvLines } = require('../utils/csv.js');
const {
  FlightCSVWriter,
  generateFilename: generateCsvFilename,
} = require('./flight-csv-writer.js');
const { AutomationJsonlRecorder } = require('./automation-jsonl-recorder.js');
const {
  AircraftSpecificJsonlRecorder,
} = require('./aircraft-specific-jsonl-recorder.js');
const {
  allocateBundleBaseName,
  bundlePaths,
} = require('./recording-bundle-lifecycle.js');
const { publishRecordingBundleStatus } = require('./recording-bundle-status.js') as {
  publishRecordingBundleStatus: (_options: Record<string, any>) => Promise<Record<string, any>>;
};
const { generateFromCSV } = require('../events/timeline-generator.js') as {
  generateFromCSV: (_csvPath: string) => Promise<Record<string, any>>;
};
const { getLandingsFromCsvFile } = require('../landing/flight-logbook.js') as {
  getLandingsFromCsvFile: (_csvPath: string, _options?: Record<string, any>) => Promise<Record<string, any>[]>;
};

type AnyRecord = Record<string, any>;

function encodeCsvValue(value: string): string {
  return /[,"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function rewriteManifestStatusFlag(content: string, value: '0' | '1'): string {
  const lines = splitCsvLines(content);
  const headers = parseCsvLine(lines[0]);
  const statusIndex = headers.indexOf('bundle_status_required');
  assert.notEqual(statusIndex, -1);
  const manifest = parseCsvLine(lines[1]);
  manifest[statusIndex] = value;
  lines[1] = manifest.map(encodeCsvValue).join(',');
  return `${lines.join('\n')}\n`;
}

function readCsvRows(filePath: string): AnyRecord[] {
  const lines = splitCsvLines(fs.readFileSync(filePath, 'utf8'), { trimAndDropEmpty: true });
  assert(lines.length > 1, 'CSV must contain a header and at least one data row');
  const headers = parseCsvLine(lines[0]);
  const compactRepeatColumns = new Set([
    'schema_version',
    'user_id',
    'session_id',
    'recording_session_id',
    'flight_id',
    'flight_start_iso',
    'aircraft',
    'aircraft_profile_id',
    'data_source',
  ]);
  const previousValues: Record<string, string> = {};
  return lines.slice(1).map((line: string) => {
    const values = parseCsvLine(line);
    assert.equal(values.length, headers.length, 'every CSV row must have the complete schema width');
    return Object.fromEntries(headers.map((header: string, index: number) => {
      let value = values[index];
      if (compactRepeatColumns.has(header)) {
        if (value === '' && Object.prototype.hasOwnProperty.call(previousValues, header)) {
          value = previousValues[header];
        } else if (value !== '') {
          previousValues[header] = value;
        }
      }
      return [header, value];
    }));
  });
}

function readCompleteJsonl(filePath: string): AnyRecord[] {
  const contents = fs.readFileSync(filePath, 'utf8');
  assert(contents.length > 0, `${path.basename(filePath)} must not be empty`);
  assert(contents.endsWith('\n'), `${path.basename(filePath)} must not have an unterminated tail`);
  const lines = contents.split('\n');
  assert.equal(lines.pop(), '', 'the only empty JSONL segment must be the terminated tail');
  assert(lines.every((line: string) => line.trim().length > 0), 'JSONL must not contain blank interior rows');
  return lines.map((line: string, index: number) => {
    assert.doesNotThrow(() => JSON.parse(line), `JSONL row ${index + 1} must parse independently`);
    return JSON.parse(line);
  });
}

function assertJsonlEnvelope(
  rows: AnyRecord[],
  expected: {
    flightId: string;
    recordingSessionId: string;
    recordingStartIso: string;
  },
  compact: boolean | 'automation' = false,
): void {
  assert(rows.length >= 2, 'JSONL must contain an initial state and final checkpoint');
  let previousTimeMs = Number.NEGATIVE_INFINITY;
  let previousElapsedMs = Number.NEGATIVE_INFINITY;
  rows.forEach((row, index) => {
    assert.equal(row.seq, index + 1, 'JSONL sequence numbers must be contiguous');
    const elapsedMs = Number.isFinite(row.flightElapsedMs)
      ? row.flightElapsedMs
      : row.timeMs - Date.parse(expected.recordingStartIso);
    assert(Number.isFinite(elapsedMs), 'every JSONL row must have a finite explicit or derived elapsed clock');
    assert(elapsedMs >= previousElapsedMs, 'JSONL elapsed clocks must be nondecreasing');
    if (!compact || index === 0) {
      assert.equal(row.flightId, expected.flightId, 'writer-owned flight identity must be immutable');
      assert.equal(row.recordingSessionId, expected.recordingSessionId,
        'writer-owned recording session identity must be immutable');
      assert.equal(row.flightStartIso, expected.recordingStartIso,
        'writer-owned recording start clock must be immutable');
      assert(Number.isFinite(row.timeMs), 'identity rows must have a finite wall clock');
      assert(row.timeMs >= previousTimeMs, 'JSONL wall clocks must be nondecreasing');
      assert.equal(elapsedMs, row.timeMs - Date.parse(expected.recordingStartIso),
        'JSONL wall and elapsed clocks must share the recording origin');
      assert.equal(row.timestampIso, new Date(row.timeMs).toISOString(),
        'JSONL ISO and epoch clocks must describe the same instant');
      previousTimeMs = row.timeMs;
    } else if (compact === 'automation') {
      assert.equal(row.flightId, undefined, 'compact automation rows must not repeat flight identity');
      assert.equal(row.recordingSessionId, undefined, 'compact automation rows must not repeat session identity');
      assert.equal(row.flightStartIso, undefined, 'compact automation rows must not repeat recording start');
      assert(Number.isFinite(row.timeMs), 'compact automation rows must retain one sortable epoch clock');
      assert(row.timeMs >= previousTimeMs, 'compact automation wall clocks must be nondecreasing');
      assert.equal(row.timestampIso, undefined, 'compact automation rows must not repeat ISO time');
      assert.equal(row.flightElapsedMs, undefined, 'compact automation rows must derive elapsed time');
      previousTimeMs = row.timeMs;
    } else {
      assert.equal(row.flightId, undefined, 'compact state rows must not repeat flight identity');
      assert.equal(row.recordingSessionId, undefined, 'compact state rows must not repeat session identity');
      assert.equal(row.flightStartIso, undefined, 'compact state rows must not repeat recording start');
      assert.equal(row.timeMs, undefined, 'compact state rows must not repeat wall time');
      assert.equal(row.timestampIso, undefined, 'compact state rows must not repeat ISO time');
    }
    previousElapsedMs = elapsedMs;
  });
  assert.equal(rows.at(-1)?.reason, 'recording_end', 'JSONL must end with a recording_end checkpoint');
}

function hostileMetadata(): AnyRecord {
  return {
    _recordType: 'hostile-record-type',
    schemaVersion: 999,
    schema_version: 998,
    flightId: 'hostile-flight-id',
    flight_id: 'hostile-flight-id-alias',
    recordingSessionId: 'hostile-recording-session-id',
    recording_session_id: 'hostile-recording-session-id-alias',
    flightStartIso: '1999-01-01T00:00:00.000Z',
    flight_start: '1998-01-01T00:00:00.000Z',
    flightElapsedMs: 99_999_999,
    flight_elapsed_ms: 88_888_888,
    timestampMonotonic: 77_777_777,
    timestamp_monotonic: 66_666_666,
    timestampMs: 1,
    timestamp_ms: 2,
    timestampIso: '1970-01-01T00:00:00.001Z',
    timestamp_utc: '1970-01-01T00:00:00.002Z',
    sampleIndex: 999,
    sample_index: 998,
  };
}

test('CSV and both JSONLs remain one clocked, parseable artifact bundle end to end', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-recording-artifact-sync-'));
  const recordingStartEpochMs = Date.parse('2026-07-20T03:04:05.678Z');
  const recordingStartIso = new Date(recordingStartEpochMs).toISOString();
  const flightId = '2026-07-20T02:55:00.000Z';
  const recordingSessionId = crypto.randomUUID();
  const applicationSessionId = crypto.randomUUID();
  const bundleBaseName = 'Flight_2026-07-20T03-04-05_YSCB-YSSY';
  const commonOptions = {
    flightId,
    recordingSessionId,
    recordingStartEpochMs,
    recordingStartIso,
    bundleBaseName,
    bundleStatusRequired: true,
    outputDir,
  };
  const clock = timeSource.createFixedSource(recordingStartEpochMs);
  const csv = new FlightCSVWriter(commonOptions);
  const automation = new AutomationJsonlRecorder({ ...commonOptions, checkpointIntervalMs: 60_000 });
  const aircraft = new AircraftSpecificJsonlRecorder({
    ...commonOptions,
    checkpointIntervalMs: 60_000,
    numericIntervalMs: 0,
  });

  const automationInput = (apMaster: boolean): AnyRecord => ({
    ...hostileMetadata(),
    timeMs: clock.get(),
    aircraftProfileId: 'microsoft-737-max-8',
    aircraftTitle: 'Microsoft Boeing 737 MAX 8',
    dataSource: 'simconnect',
    fdm: { apMaster, apFdActive: true, apHdgHold: apMaster, apAltTargetFt: 8_000 },
    baseFdm: { apMaster, apFdActive: true, apHdgHold: apMaster, apAltTargetFt: 8_000 },
    simconnect: { connected: true },
  });
  const aircraftInput = (speed: number): AnyRecord => ({
    ...hostileMetadata(),
    timeMs: clock.get(),
    aircraftTitle: 'Microsoft Boeing 737 MAX 8',
    profileKey: 'bundled/msfs/microsoft-737-max-8',
    profileRevision: 1,
    integrationId: 'microsoft-737-max-8',
    templateId: 'microsoft-737-max-8',
    available: true,
    sourceStatus: { overall: 'connected', sources: { simvar: 'connected' } },
    fieldCatalog: [{
      id: 'controls.speedSelected',
      valueType: 'number',
    }],
    values: { 'controls.speedSelected': speed },
    unavailable: [],
  });

  try {
    assert.equal(csv.start(), true, 'CSV should claim its exact bundle path');
    assert.equal(automation.start(), true, 'automation JSONL should claim its exact bundle path');
    assert.equal(aircraft.start(), true, 'aircraft JSONL should claim its exact bundle path');
    for (const artifactPath of [csv.filePath, automation.filePath, aircraft.filePath]) {
      assert.equal(fs.existsSync(artifactPath), true,
        `successful bundle startup must immediately claim ${path.basename(artifactPath)}`);
    }

    assert.equal(csv.writeSample({
      ...hostileMetadata(),
      sessionId: applicationSessionId,
      phase: 'CRUISE',
      onGround: false,
      ias: 245,
      lat: -35.3,
      lon: 149.2,
    }), true);
    assert.equal(automation.recordAutopilotState(automationInput(true)), true);
    assert.equal(aircraft.recordAircraftSpecificState(aircraftInput(245)), true);

    clock.advance(125);
    assert.equal(csv.writeEvent('LANDING', {
      ...hostileMetadata(),
      eventId: 'sync-contract-event',
      phase: 'CRUISE',
      vs: -180,
      gforce: 1.2,
      icao: 'YSCB',
      runway: '35',
    }, {
      ...hostileMetadata(),
      sessionId: applicationSessionId,
      phase: 'CRUISE',
      onGround: false,
      ias: 244,
    }), true);
    assert.equal(automation.recordAutopilotState(automationInput(false)), true);
    assert.equal(aircraft.recordAircraftSpecificState(aircraftInput(246)), true);

    clock.advance(75);
    assert.equal(csv.writeSample({
      ...hostileMetadata(),
      sessionId: applicationSessionId,
      phase: 'CRUISE',
      onGround: false,
      ias: 243,
      lat: -35.31,
      lon: 149.21,
    }), true);
    assert.equal(automation.recordAutopilotState({
      ...automationInput(false),
      fdm: { ...automationInput(false).fdm, apAltTargetFt: 9_000 },
      baseFdm: { ...automationInput(false).baseFdm, apAltTargetFt: 9_000 },
    }), true);
    assert.equal(aircraft.recordAircraftSpecificState(aircraftInput(247)), true);

    assert.deepEqual(await Promise.all([csv.flush(), automation.flush(), aircraft.flush()]), [true, true, true],
      'all three open artifacts must flush before they are exposed to readers');

    clock.advance(100);
    const hostileEndContext = {
      ...hostileMetadata(),
      timeMs: clock.get(),
      endReason: 'sync_e2e_complete',
    };
    const [csvStats, automationStats, aircraftStats] = await Promise.all([
      csv.close(),
      automation.close(hostileEndContext),
      aircraft.close(hostileEndContext),
    ]);

    for (const stats of [csvStats, automationStats, aircraftStats]) {
      assert.equal(stats.flightId, flightId);
      assert.equal(stats.recordingSessionId, recordingSessionId);
      assert.equal(stats.recordingStartEpochMs, recordingStartEpochMs);
      assert.equal(stats.recordingStartIso, recordingStartIso);
      assert.equal(stats.bundleBaseName, bundleBaseName);
    }
    assert.deepEqual(
      [csvStats.filePath, automationStats.filePath, aircraftStats.filePath].map((filePath) => path.basename(filePath)),
      [
        'telemetry.csv',
        'automation.jsonl',
        'aircraft-specific.jsonl',
      ],
      'each artifact must use its canonical name',
    );
    assert.deepEqual(
      [csvStats.filePath, automationStats.filePath, aircraftStats.filePath].map((filePath) => path.dirname(filePath)),
      [path.join(outputDir, bundleBaseName), path.join(outputDir, bundleBaseName), path.join(outputDir, bundleBaseName)],
      'all artifacts must remain in the same immutable bundle directory',
    );

    const csvRows = readCsvRows(csvStats.filePath);
    assert.equal(csvRows.length, 4, 'CSV should contain its manifest, both samples, and the event');
    assert.deepEqual(
      csvRows.map((row) => row.record_type),
      ['RECORDING_MANIFEST', 'SAMPLE', 'LANDING', 'SAMPLE'],
    );
    assert(csvRows.every((row) => row.schema_version === '3'), 'CSV schema version must be writer-owned');
    assert.equal(csvRows[0].bundle_status_required, '1',
      'the CSV manifest must opt the current core bundle into completion certification');
    let previousElapsedMs = Number.NEGATIVE_INFINITY;
    csvRows.forEach((row, index) => {
      assert.equal(row.flight_id, flightId);
      if (row.record_type !== 'RECORDING_MANIFEST') {
        assert.equal(row.session_id, applicationSessionId,
          'the pre-existing backend-run session contract must remain intact');
      }
      assert.equal(row.recording_session_id, recordingSessionId,
        'the additive recording-session column must carry the bundle UUID');
      assert.equal(row.flight_start_iso, recordingStartIso);
      assert.equal(Number(row.sample_index), index);
      assert.equal(Number(row.flight_elapsed_ms), Number(row.timestamp_monotonic),
        'CSV elapsed and monotonic clocks must be identical');
      assert(Number(row.flight_elapsed_ms) >= previousElapsedMs, 'CSV clocks must be nondecreasing');
      assert.equal(Number(row.ts), recordingStartEpochMs + Number(row.flight_elapsed_ms),
        'CSV epoch and elapsed clocks must share the recording origin');
      assert.equal(row.timestamp_utc, new Date(Number(row.ts)).toISOString());
      previousElapsedMs = Number(row.flight_elapsed_ms);
    });
    assert.deepEqual(csvRows.map((row) => Number(row.flight_elapsed_ms)), [0, 0, 125, 200]);

    const expectedEnvelope = { flightId, recordingSessionId, recordingStartIso };
    const automationRows = readCompleteJsonl(automationStats.filePath);
    const aircraftRows = readCompleteJsonl(aircraftStats.filePath);
    assertJsonlEnvelope(automationRows, expectedEnvelope, 'automation');
    assertJsonlEnvelope(aircraftRows, expectedEnvelope, true);
    assert.equal(automationRows[0]?.type, 'automation_manifest');
    assert.equal(aircraftRows[0]?.type, 'aircraft_specific_manifest');
    assert.equal(automationRows.at(-1)?.endReason, 'sync_e2e_complete');
    assert.equal(aircraftRows.at(-1)?.endReason, 'sync_e2e_complete');
    assert.equal(automationRows.at(-1)?.timeMs - automationRows[0].timeMs, 300);
    assert.equal(aircraftRows.at(-1)?.flightElapsedMs, 300);
    assert.equal(automationRows[0]?.bundleStatusRequired, true);
    assert(automationRows.slice(1).every((row) => row.bundleStatusRequired === undefined));
    assert(aircraftRows.every((row) => row.bundleStatusRequired === true));

    await publishRecordingBundleStatus({
      ...commonOptions,
      status: 'complete',
      finalizedAtEpochMs: clock.get(),
      finalizedAtIso: new Date(clock.get()).toISOString(),
      endReason: 'sync_e2e_complete',
    });

    const timelineResult = await generateFromCSV(csvStats.filePath);
    assert.equal(timelineResult.success, true,
      `Timeline must accept the synchronized three-file bundle: ${timelineResult.error || ''}`);
    assert.equal(timelineResult.timeline?.sampleCount, 2,
      'Timeline sample count must exclude the CSV manifest and sparse event rows');
    const healthyLandings = await getLandingsFromCsvFile(csvStats.filePath, { bypassCache: true });
    assert.equal(healthyLandings.length, 1,
      'Logbook ingestion must accept a fully certified current bundle');

    const originalCsv = fs.readFileSync(csvStats.filePath, 'utf8');
    const downgradedCsv = rewriteManifestStatusFlag(originalCsv, '0');
    assert.equal(Buffer.byteLength(downgradedCsv), Buffer.byteLength(originalCsv));
    fs.writeFileSync(csvStats.filePath, downgradedCsv, 'utf8');
    const downgradedTimeline = await generateFromCSV(csvStats.filePath);
    assert.equal(downgradedTimeline.success, false,
      'Timeline must not let the CSV silently opt out while both sidecars still require certification');
    assert.match(downgradedTimeline.error, /durable bundle-status requirement does not match the CSV/i);
    const downgradedLandings = await getLandingsFromCsvFile(csvStats.filePath, { bypassCache: true });
    assert.deepEqual(downgradedLandings, [],
      'Logbook ingestion must reject a CSV-only completion-requirement downgrade');
    fs.writeFileSync(csvStats.filePath, originalCsv, 'utf8');

    const originalAircraft = fs.readFileSync(aircraftStats.filePath, 'utf8');
    const changedValueIndex = originalAircraft.lastIndexOf('247');
    assert.notEqual(changedValueIndex, -1, 'fixture must contain the final aircraft value');
    const changedAircraft = `${originalAircraft.slice(0, changedValueIndex)}248${originalAircraft.slice(changedValueIndex + 3)}`;
    assert.equal(Buffer.byteLength(changedAircraft), Buffer.byteLength(originalAircraft),
      'tamper fixture must preserve the certified member size');
    fs.writeFileSync(aircraftStats.filePath, changedAircraft, 'utf8');
    const corruptBundleResult = await generateFromCSV(csvStats.filePath);
    assert.equal(corruptBundleResult.success, false,
      'Timeline must fail closed when a current bundle member is changed without changing its size');
    assert.match(corruptBundleResult.error, /aircraftSpecific bytes.*durable completion status/i);
    const corruptLandings = await getLandingsFromCsvFile(csvStats.filePath, { bypassCache: true });
    assert.deepEqual(corruptLandings, [],
      'Logbook ingestion must fail closed on the same same-size member tamper');
  } finally {
    timeSource.resetTimeSource();
    if (!csv.closed) await csv.close();
    if (!automation.closed) await automation.close({ endReason: 'test_cleanup' });
    if (!aircraft.closed) await aircraft.close({ endReason: 'test_cleanup' });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('aircraft-specific member remains a durable manifest when no profile snapshot arrives', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-aircraft-manifest-only-'));
  const recordingStartEpochMs = Date.parse('2026-07-20T04:00:00.000Z');
  const recordingStartIso = new Date(recordingStartEpochMs).toISOString();
  const flightId = 'manifest-only-flight';
  const recordingSessionId = crypto.randomUUID();
  const bundleBaseName = 'manifest-only-bundle';
  const recorder = new AircraftSpecificJsonlRecorder({
    flightId,
    recordingSessionId,
    recordingStartEpochMs,
    recordingStartIso,
    bundleBaseName,
    outputDir,
  });
  try {
    assert.equal(recorder.start(), true);
    assert.equal(fs.existsSync(recorder.filePath), true, 'start must claim the aircraft-specific member');
    assert.equal(await recorder.flush(), true, 'manifest-only member must flush durably');
    const stats = await recorder.close({ endReason: 'no_profile_snapshot' });
    const rows = readCompleteJsonl(stats.filePath);
    assert.equal(stats.rowCount, 1);
    assert.equal(stats.hasFile, true);
    assert.deepEqual(rows, [{
      schemaVersion: 2,
      seq: 1,
      type: 'aircraft_specific_manifest',
      timeMs: recordingStartEpochMs,
      timestampIso: recordingStartIso,
      flightElapsedMs: 0,
      flightId,
      recordingSessionId,
      bundleStatusRequired: false,
      flightStartIso: recordingStartIso,
    }]);
  } finally {
    if (!recorder.closed) await recorder.close({ endReason: 'test_cleanup' });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('same-second sessions allocate different whole-bundle basenames once the first is claimed', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-recording-basename-sync-'));
  try {
    const firstFlightId = '2026-07-20T03:04:05.100Z';
    const secondFlightId = '2026-07-20T03:04:05.900Z';
    const firstPreferred = path.basename(generateCsvFilename(firstFlightId, null, null), '.csv');
    const secondPreferred = path.basename(generateCsvFilename(secondFlightId, null, null), '.csv');
    assert.equal(firstPreferred, secondPreferred, 'the test fixture must exercise a same-second name collision');

    const firstBaseName = allocateBundleBaseName(outputDir, firstPreferred);
    fs.mkdirSync(path.join(outputDir, firstBaseName));
    for (const artifactPath of bundlePaths(outputDir, firstBaseName)) {
      fs.writeFileSync(artifactPath, 'claimed\n', { flag: 'wx' });
    }
    const secondBaseName = allocateBundleBaseName(outputDir, secondPreferred);

    assert.notEqual(secondBaseName, firstBaseName);
    assert.equal(secondBaseName, `${firstBaseName}-2`);
    assert(bundlePaths(outputDir, secondBaseName).every((artifactPath: string) => !fs.existsSync(artifactPath)),
      'the allocated second bundle must be clear across all three artifact suffixes');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('conflicting writer startup fails closed without appending to any existing artifact', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-recording-start-conflict-'));
  const recordingStartEpochMs = Date.parse('2026-07-20T03:04:05.678Z');
  const recordingStartIso = new Date(recordingStartEpochMs).toISOString();
  const commonOptions = {
    flightId: 'conflict-flight',
    recordingSessionId: crypto.randomUUID(),
    recordingStartEpochMs,
    recordingStartIso,
    outputDir,
  };
  const cases = [
    {
      suffix: '.csv',
      create: (bundleBaseName: string) => new FlightCSVWriter({ ...commonOptions, bundleBaseName }),
      attemptWrite: (writer: AnyRecord) => writer.writeSample({ phase: 'PREFLIGHT' }),
      close: (writer: AnyRecord) => writer.close(),
    },
    {
      suffix: '.automation.jsonl',
      create: (bundleBaseName: string) => new AutomationJsonlRecorder({ ...commonOptions, bundleBaseName }),
      attemptWrite: (writer: AnyRecord) => writer.recordAutopilotState({
        timeMs: recordingStartEpochMs,
        fdm: { apMaster: false },
        baseFdm: { apMaster: false },
        simconnect: { connected: true },
      }),
      close: (writer: AnyRecord) => writer.close({ timeMs: recordingStartEpochMs }),
    },
    {
      suffix: '.aircraft-specific.jsonl',
      create: (bundleBaseName: string) => new AircraftSpecificJsonlRecorder({ ...commonOptions, bundleBaseName }),
      attemptWrite: (writer: AnyRecord) => writer.recordAircraftSpecificState({
        timeMs: recordingStartEpochMs,
        profileKey: 'bundled/msfs/microsoft-737-max-8',
        fieldCatalog: [{ id: 'controls.speedSelected', valueType: 'number' }],
        values: { 'controls.speedSelected': 220 },
        unavailable: [],
        sourceStatus: { overall: 'connected', sources: { simvar: 'connected' } },
      }),
      close: (writer: AnyRecord) => writer.close({ timeMs: recordingStartEpochMs }),
    },
  ];

  try {
    for (const [index, scenario] of cases.entries()) {
      const bundleBaseName = `existing-bundle-${index}`;
      const targetPath = bundlePaths(outputDir, bundleBaseName)[index];
      const original = Buffer.from(`pre-existing artifact ${index}\n`, 'utf8');
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, original, { flag: 'wx' });
      const writer = scenario.create(bundleBaseName);

      assert.equal(writer.start(), false, `${scenario.suffix} startup must reject an existing target`);
      assert.equal(scenario.attemptWrite(writer), false, `${scenario.suffix} must reject writes after failed startup`);
      await scenario.close(writer);
      assert.deepEqual(fs.readFileSync(targetPath), original,
        `${scenario.suffix} startup failure must not append, truncate, or replace existing bytes`);
    }
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

export {};
