'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Config-backed modules must never touch the developer's application data.
const scratchParent = path.resolve(process.cwd(), '.tmp');
fs.mkdirSync(scratchParent, { recursive: true });
const scratchRoot = fs.mkdtempSync(path.join(scratchParent, 'takeoff-history-'));
const priorAppData = process.env.APPDATA;
const priorXdgConfig = process.env.XDG_CONFIG_HOME;
process.env.APPDATA = path.join(scratchRoot, 'appdata');
process.env.XDG_CONFIG_HOME = path.join(scratchRoot, 'appdata');
const storagePaths = require('../utils/storage-paths.js');
const priorDocumentsCandidates = storagePaths.getDocumentsDirCandidates;
storagePaths.getDocumentsDirCandidates = () => [path.join(scratchRoot, 'Documents')];
test.after(() => {
  timeSource.resetTimeSource();
  storagePaths.getDocumentsDirCandidates = priorDocumentsCandidates;
  if (priorAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = priorAppData;
  if (priorXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = priorXdgConfig;
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

const { FlightCSVWriter } = require('../flight-recording/flight-csv-writer.js');
const timeSource = require('../core/time-source.js');
const { AutomationJsonlRecorder } = require('../flight-recording/automation-jsonl-recorder.js');
const { AircraftSpecificJsonlRecorder } = require('../flight-recording/aircraft-specific-jsonl-recorder.js');
const { buildTakeoffCsvEventData } = require('../flight-recording/takeoff-csv-contract.js');
const { getBundlePaths } = require('../flight-recording/recording-bundle-layout.js');
const {
  inspectCsvBundleForCatalogSync,
  publishRecordingBundleStatus,
} = require('../flight-recording/recording-bundle-status.js');
const {
  getFlightAnalysisRescoreSource,
  saveFlightAnalysisRescore,
  revertFlightAnalysisRescore,
} = require('../flight-recording/flight-analysis-rescore-sidecar.js');
const {
  getFlightRecordsFromCsvFile,
  getLandingsFromCsvFile,
} = require('../landing/flight-logbook.js');
const { openHistoryIndexStore } = require('../history-index/history-index-store.js');
const { loadNodeSqlite } = require('../history-index/sqlite-runtime.js');
const { createHistoryIndexCoordinator } = require('../history-index/history-index-coordinator.js');
const { getHistorySummaryPath } = require('../history-index/history-summary-sidecar.js');

const START_MS = Date.parse('2026-10-01T00:00:00.000Z');
const LIFTOFF_MS = START_MS + 30_000;
const PROFILE_ID = 'bundled/msfs/fbw-a32nx';

function makeRoot(name) {
  const root = path.join(scratchRoot, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function recordedAnalysis() {
  return {
    schemaVersion: 3,
    assessmentContract: { id: 'takeoff-assessment', version: 1 },
    assessment: 'caution',
    rollDurationBasis: 'simulator',
    rollStart: { timestampMs: START_MS, simTimeSec: 70_000 },
    liftoff: { timestampMs: LIFTOFF_MS, simTimeSec: 70_060 },
    screenHeight: { reached: true, heightFt: 35, elapsedS: 3.6, timeBasis: 'simulator' },
    rotation: { rateDegS: 2.4, timeBasis: 'simulator', priorRateDegS: 2.9 },
    flags: [{ code: 'roll_heading', label: 'Heading deviation during roll', severity: 'caution' }],
  };
}

async function makeBundle(root, bundleName, options: { legacy?: boolean; provisional?: boolean } = {}) {
  const clock = timeSource.createFixedSource(START_MS);
  const identity = {
    flightId: `takeoff-history-flight-${bundleName}`,
    recordingSessionId: `takeoff-history-session-${bundleName}`,
    recordingStartEpochMs: START_MS,
    recordingStartIso: new Date(START_MS).toISOString(),
  };
  const writerOptions = {
    ...identity,
    bundleBaseName: bundleName,
    bundleStatusRequired: true,
    outputDir: root,
    writerMode: 'inline',
  };
  const csv = new FlightCSVWriter(writerOptions);
  const automation = new AutomationJsonlRecorder(writerOptions);
  const aircraftSpecific = new AircraftSpecificJsonlRecorder(writerOptions);
  assert.equal(csv.start(), true);
  assert.equal(automation.start(), true);
  assert.equal(aircraftSpecific.start(), true);
  assert.equal(automation.recordAutopilotState({ timeMs: START_MS + 100 }), true);

  const analysis: any = recordedAnalysis();
  if (options.legacy) delete analysis.assessmentContract;
  const payload = {
    timestamp_ms: LIFTOFF_MS,
    timestamp_utc: new Date(LIFTOFF_MS).toISOString(),
    aircraft: 'Test A320',
    aircraft_profile_id: PROFILE_ID,
    icao: 'YSSY',
    runway: '34L',
    ias_kts: 145,
    gs_kts: 142,
    takeoff_liftoff_timestamp_ms: LIFTOFF_MS,
    takeoff_roll_distance_ft: 3_200,
    takeoff_roll_duration_s: 60,
    takeoff_roll_start_source: 'standstill',
    takeoff_runway_remaining_ft: 6_000,
    takeoff_runway_use_score: options.legacy ? 87 : null,
    takeoff_runway_use_grade: options.legacy ? 'Good' : 'Recorded',
    takeoff_assessment: 'caution',
    takeoff_analysis: analysis,
    takeoff_final: true,
  };
  const frame = {
    aircraftProfileId: PROFILE_ID,
    timestampMs: LIFTOFF_MS + 5_000,
    timestampIso: new Date(LIFTOFF_MS + 5_000).toISOString(),
  };
  clock.set(LIFTOFF_MS + 5_000);
  if (options.provisional) {
    assert.equal(csv.writeEvent('TAKEOFF', buildTakeoffCsvEventData({
      ...payload,
      takeoff_final: false,
    }, 'provisional-takeoff'), frame), true);
  }
  assert.equal(csv.writeEvent('TAKEOFF', buildTakeoffCsvEventData(payload, 'recorded-takeoff'), frame), true);
  clock.set(START_MS + 600_000);
  assert.equal(csv.writeEvent('LANDING', {
    aircraft_profile_id: PROFILE_ID,
    grade: 'PERFECT',
    vs: -180,
    vs_fpm: -180,
  }, {
    aircraftProfileId: PROFILE_ID,
    timestampMs: START_MS + 600_000,
    timestampIso: new Date(START_MS + 600_000).toISOString(),
    vs: -180,
  }), true);
  await Promise.all([csv.close(), automation.close(), aircraftSpecific.close()]);
  await publishRecordingBundleStatus({
    ...identity,
    outputDir: root,
    bundleBaseName: bundleName,
    status: 'complete',
    finalizedAtEpochMs: START_MS + 601_000,
    finalizedAtIso: new Date(START_MS + 601_000).toISOString(),
    endReason: 'test_end',
  });
  return { identity, paths: getBundlePaths(root, bundleName), analysis };
}

function csvSource(filePath) {
  const stat = fs.statSync(filePath);
  const catalog = inspectCsvBundleForCatalogSync(filePath);
  assert.equal(catalog.allowed, true);
  return {
    filePath,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    bundleCatalogRevision: catalog.catalogRevision,
    bundleSizeBytes: catalog.bundleSizeBytes,
    recordingSessionId: catalog.recordingSessionId,
  };
}

async function waitForCompletion(coordinator) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = coordinator.getStatus();
    if (!status.busy) {
      assert.equal(status.phase, 'complete', status.error);
      assert.equal(status.failures, 0, status.error);
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Takeoff history indexing did not finish');
}

test('mixed finalized CSV records preserve takeoff timing and assessment while retaining landing compatibility', async () => {
  const bundle = await makeBundle(makeRoot('mixed'), 'mixed', { provisional: true });
  const records = await getFlightRecordsFromCsvFile(bundle.paths.csv);
  assert.equal(records.landings.length, 1);
  assert.equal(records.takeoffs.length, 1, 'a provisional row must not become a historical departure');
  const takeoff = records.takeoffs[0];
  assert.equal(takeoff.eventId, 'recorded-takeoff');
  assert.equal(takeoff.timestampMs, LIFTOFF_MS, 'history uses liftoff, not later finalization time');
  assert.equal(takeoff.rollDurationS, 60);
  assert.equal(takeoff.rollDurationBasis, 'simulator');
  assert.equal(takeoff.screenHeightTimeBasis, 'simulator');
  assert.equal(takeoff.rotationTimeBasis, 'simulator');
  assert.deepEqual(takeoff.analysis, bundle.analysis);
  assert.equal(takeoff.runwayUseGrade, 'Recorded');
  assert.equal(takeoff.runwayUseScore, null, 'a measured departure does not acquire a numerical grade');
  assert.equal(takeoff.recording.recordingSessionId, bundle.identity.recordingSessionId);
  assert.deepEqual(await getLandingsFromCsvFile(bundle.paths.csv), records.landings);
  assert.deepEqual(await getFlightRecordsFromCsvFile(bundle.paths.csv, { bypassCache: true }), records);
});

test('legacy takeoff assessment is imported as recorded without inventing current rule provenance', async () => {
  const bundle = await makeBundle(makeRoot('legacy'), 'legacy', { legacy: true });
  const { takeoffs } = await getFlightRecordsFromCsvFile(bundle.paths.csv);
  assert.equal(takeoffs.length, 1);
  assert.equal(takeoffs[0].runwayUseGrade, 'Good');
  assert.equal(takeoffs[0].runwayUseScore, 87);
  assert.deepEqual(takeoffs[0].analysis, bundle.analysis);
  assert.equal(Object.hasOwn(takeoffs[0].analysis, 'assessmentContract'), false);
});

test('Logbook and Timeline retain numeric-looking recording IDs and runway labels without changing measurement parsing', () => {
  const { parseCsvLine, splitCsvLines } = require('../utils/csv.js');
  const { mapCsvRow } = require('../events/timeline-csv-helpers.js');
  const { parseLandingsFromContent } = require('../landing/flight-logbook.js');
  const { extractRecordedTakeoff } = require('./takeoff-record.js');
  const headers = [
    'record_type', 'event_id', 'recording_session_id', 'flight_id', 'runway',
    'ts', 'takeoff_liftoff_timestamp_ms', 'sample_index', 'ias_kts', 'takeoff_final',
    'runway_excursion', 'lateral_offset_suspect',
  ];
  const values = [
    'TAKEOFF', '00123', '90071992547409931234', '90071992547409931235', '09',
    String(LIFTOFF_MS + 5_000), String(LIFTOFF_MS), '7', '143.5', 'true', 'false', 'false',
  ];
  const csvPath = getBundlePaths(scratchRoot, 'text-identifiers').csv;
  const csv = `${headers.join(',')}\n${values.join(',')}\n`;
  const takeoffs: any[] = [];
  assert.deepEqual(parseLandingsFromContent(
    csv, csvPath, parseCsvLine, () => null, splitCsvLines, () => null, takeoffs,
  ), []);
  assert.equal(takeoffs.length, 1);
  const mapped = mapCsvRow(headers, values);
  const timelineEntry = extractRecordedTakeoff(mapped, { bundleName: 'text-identifiers', rowIndex: 1 });
  assert.deepEqual(takeoffs[0], timelineEntry);
  assert.equal(timelineEntry.eventId, '00123');
  assert.equal(timelineEntry.recording.recordingSessionId, '90071992547409931234');
  assert.equal(timelineEntry.recording.flightId, '90071992547409931235');
  assert.equal(timelineEntry.runway, '09');
  assert.equal(timelineEntry.sampleIndex, 7);
  assert.equal(timelineEntry.iasKts, 143.5);
  assert.equal(timelineEntry.runwayExcursion, false);
  assert.equal(timelineEntry.lateralOffsetSuspect, false);
  assert.equal(mapped.takeoff_final, true);
});

test('restoring a bundle elsewhere retains takeoff identity and distinct recording sessions stay distinct', async () => {
  const bundle = await makeBundle(makeRoot('original'), 'portable');
  const original = await getFlightRecordsFromCsvFile(bundle.paths.csv);
  const restored = getBundlePaths(makeRoot('restored'), 'portable');
  fs.cpSync(bundle.paths.dir, restored.dir, { recursive: true });
  const imported = await getFlightRecordsFromCsvFile(restored.csv);
  assert.deepEqual(imported.takeoffs, original.takeoffs);
  const other = await makeBundle(makeRoot('other'), 'different-session');
  const otherRecords = await getFlightRecordsFromCsvFile(other.paths.csv);
  assert.equal(otherRecords.takeoffs[0].eventId, original.takeoffs[0].eventId);
  assert.notEqual(otherRecords.takeoffs[0].id, original.takeoffs[0].id);
});

test('legacy loose CSV takeoffs have identical row identities in Logbook and actual Timeline markers', () => {
  const { parseCsvLine, splitCsvLines } = require('../utils/csv.js');
  const { mapCsvRow } = require('../events/timeline-csv-helpers.js');
  const { parseLandingsFromContent } = require('../landing/flight-logbook.js');
  const { _generateTimelineFromRows } = require('../events/timeline-generator.js');
  const headers = ['record_type', 'ts', 'takeoff_liftoff_timestamp_ms', 'takeoff_runway_use_grade', 'takeoff_final'];
  const values = [
    ['SAMPLE', String(START_MS), '', '', ''],
    ['TAKEOFF', String(LIFTOFF_MS + 5000), String(LIFTOFF_MS), 'Recorded', 'true'],
    ['TAKEOFF', String(LIFTOFF_MS + 65000), String(LIFTOFF_MS + 60000), 'Recorded', 'true'],
  ];
  const csvPath = path.join(scratchRoot, 'old-loose-flight.csv');
  const content = `${headers.join(',')}\n${values.map((row) => row.join(',')).join('\n')}\n`;
  const takeoffs: any[] = [];
  parseLandingsFromContent(content, csvPath, parseCsvLine, () => null, splitCsvLines, () => null, takeoffs);
  const generated = _generateTimelineFromRows(csvPath, values.map((row) => mapCsvRow(headers, row)));
  assert.equal(generated.success, true, generated.error);
  const markers = generated.timeline.events.filter((event) => event.type === 'marker' && event.markerType === 'takeoff');
  assert.equal(markers.length, 2);
  assert.equal(takeoffs.length, 2);
  assert.deepEqual(markers.map((marker) => marker.context.takeoff_id), takeoffs.map((entry) => entry.id));
  assert.match(takeoffs[0].id, /^takeoff:"old-loose-flight\.csv":row:1$/);
  assert.match(takeoffs[1].id, /^takeoff:"old-loose-flight\.csv":row:2$/);
});

test('a damaged finalized bundle cannot retain cached takeoff or landing history', async () => {
  const bundle = await makeBundle(makeRoot('damaged'), 'damaged');
  const cached = await getFlightRecordsFromCsvFile(bundle.paths.csv);
  assert.equal(cached.takeoffs.length, 1);
  assert.equal(cached.landings.length, 1);
  fs.appendFileSync(bundle.paths.csv, 'corrupted recording\n');
  const refused = await getFlightRecordsFromCsvFile(bundle.paths.csv);
  assert.deepEqual(refused, { landings: [], takeoffs: [] });
});

test('landing rescore apply and restore preserve original takeoff history', async () => {
  const root = makeRoot('rescore');
  const bundle = await makeBundle(root, 'rescore');
  const before = await getFlightRecordsFromCsvFile(bundle.paths.csv);
  const source = getFlightAnalysisRescoreSource(bundle.paths.csv, { flightLogsDir: root });
  assert.equal(source.success, true, source.error);
  const landing = before.landings[0];
  const landingKey = landing.landingKey;
  assert.ok(landingKey, 'the recorder must provide the same durable landing key used by rescoring');
  const immutableCsv = fs.readFileSync(bundle.paths.csv);
  const saved = saveFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    expectedRevision: 0,
    expectedSourceFingerprint: source.source.fingerprint,
    analysisContract: { id: 'takeoff-history-landing-regression', version: 1 },
    timeline: {
      flightId: bundle.identity.flightId,
      events: [{
        type: 'landing', landingKey, aircraftProfileId: PROFILE_ID,
        vs_fpm: -180, grade: 'GOOD',
        ultimateStability: { verdict: 'no_verdict' },
      }],
      track: [],
    },
    landings: [{
      id: landing.id, landingKey, aircraftProfileId: PROFILE_ID,
      timestamp: landing.timestamp, timestampMs: landing.timestampMs,
      vsFpm: -180, grade: 'GOOD', stabilityVerdict: 'no_verdict',
      recordedGrade: landing.grade, gradeSource: 'applied-rescore',
      analysisRescore: { applied: true, scope: 'full-landing-analysis' },
    }],
  });
  assert.equal(saved.success, true, saved.error);
  const applied = await getFlightRecordsFromCsvFile(bundle.paths.csv);
  assert.equal(applied.landings[0].grade, 'GOOD');
  assert.deepEqual(applied.takeoffs, before.takeoffs);
  const restored = revertFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    expectedRevision: saved.revision,
  });
  assert.equal(restored.success, true, restored.error);
  const after = await getFlightRecordsFromCsvFile(bundle.paths.csv);
  assert.deepEqual(after, before);
  assert.deepEqual(fs.readFileSync(bundle.paths.csv), immutableCsv);
});

test('takeoffs survive shared history index rebuild, summary reuse and deletion followed by restore', async (t) => {
  const sqlite = loadNodeSqlite();
  if (!sqlite.available) {
    t.skip(`node:sqlite unavailable: ${sqlite.error}`);
    return;
  }
  const root = makeRoot('indexed');
  const bundle = await makeBundle(root, 'indexed');
  const source = csvSource(bundle.paths.csv);
  const original = await getFlightRecordsFromCsvFile(bundle.paths.csv);
  const opened = openHistoryIndexStore({ dbPath: path.join(root, 'history.sqlite') });
  assert.equal(opened.success, true, opened.error);
  const store = opened.store;
  const coordinatorStore = { ...store, close() {} };
  let scans = 0;
  const coordinator = createHistoryIndexCoordinator({
    openHistoryIndexStore: () => ({ success: true, store: coordinatorStore }),
    getFlightLogsDir: () => root,
    buildListedCsvFlightFromPath: () => ({
      filePath: source.filePath, flightId: bundle.identity.flightId,
      timestamp: new Date(START_MS).toISOString(), aircraft: 'Test A320',
    }),
    async getFlightRecordsFromCsvFile(filePath, options) {
      scans += 1;
      return getFlightRecordsFromCsvFile(filePath, options);
    },
  });
  try {
    coordinator.start([source]);
    const initial = await waitForCompletion(coordinator);
    assert.equal(initial.deepScans, 1);
    assert.equal(scans, 1, 'landing and takeoff records share one CSV read');
    const snapshot = store.queryLogbookSnapshot({ limit: 100 });
    assert.equal(snapshot.page.entries.length, 1);
    const indexedTakeoffs = snapshot.takeoffs.entries;
    assert.equal(indexedTakeoffs.length, 1);
    const { indexId, ...indexedTakeoff } = indexedTakeoffs[0];
    assert.equal(typeof indexId, 'string');
    assert.deepEqual(indexedTakeoff, original.takeoffs[0]);
    assert.equal(snapshot.takeoffStats.total, 1);
    const summaryPath = getHistorySummaryPath(bundle.paths.csv);
    assert.equal(fs.existsSync(summaryPath), true);

    coordinator.start([source], { rebuild: true });
    const rebuilt = await waitForCompletion(coordinator);
    assert.equal(rebuilt.summaryHits, 1);
    assert.equal(scans, 1, 'derived-store rebuild reuses the existing portable summary');
    assert.deepEqual(store.queryLogbookSnapshot({ limit: 100 }).takeoffs.entries, indexedTakeoffs);

    fs.unlinkSync(summaryPath);
    coordinator.start([source], { rebuild: true });
    const rescanned = await waitForCompletion(coordinator);
    assert.equal(rescanned.deepScans, 1);
    assert.equal(scans, 2);
    assert.deepEqual(store.queryLogbookSnapshot({ limit: 100 }).takeoffs.entries, indexedTakeoffs);

    coordinator.start([]);
    await waitForCompletion(coordinator);
    assert.equal(store.queryLogbookSnapshot({ limit: 100 }).takeoffs.entries.length, 0);
    assert.equal(store.queryLogbookSnapshot({ limit: 100 }).page.entries.length, 0);
    assert.equal(fs.existsSync(bundle.paths.csv), true, 'index pruning must not delete the recording');

    coordinator.start([source]);
    await waitForCompletion(coordinator);
    assert.deepEqual(store.queryLogbookSnapshot({ limit: 100 }).takeoffs.entries, indexedTakeoffs);
  } finally {
    store.close();
  }
});

test('Logbook facade retires only matched legacy takeoffs after indexing and does not resurrect them after removal', async (t) => {
  const sqlite = loadNodeSqlite();
  if (!sqlite.available) {
    t.skip(`node:sqlite unavailable: ${sqlite.error}`);
    return;
  }
  const { createFlightCsvStore } = require('../flight-recording/flight-csv-store.js');
  const takeoffLogbook = require('./takeoff-logbook.js');
  const logsRoot = path.join(scratchRoot, 'Documents', 'Flight Fabric', 'Flight Logs');
  fs.mkdirSync(logsRoot, { recursive: true });
  const bundle = await makeBundle(logsRoot, 'facade');
  const recorded = (await getFlightRecordsFromCsvFile(bundle.paths.csv)).takeoffs[0];
  const matchedLegacy = { ...recorded, id: 'legacy-matched', eventId: null, sampleIndex: null };
  const unmatchedLegacy = {
    ...recorded,
    id: 'legacy-only',
    eventId: null,
    sampleIndex: null,
    timestampMs: LIFTOFF_MS + 1_000,
    timestamp: new Date(LIFTOFF_MS + 1_000).toISOString(),
    rollDistanceFt: 1_000,
    recording: { bundleName: 'old-recording', recordingSessionId: 'old-session', flightId: 'old-flight' },
  };
  fs.mkdirSync(path.dirname(takeoffLogbook.TAKEOFF_LOG_FILE), { recursive: true });
  fs.writeFileSync(takeoffLogbook.TAKEOFF_LOG_FILE, JSON.stringify({
    version: 1, entries: [unmatchedLegacy, matchedLegacy],
  }));
  const store = createFlightCsvStore({
    openHistoryIndexStore: () => openHistoryIndexStore({ dbPath: path.join(scratchRoot, 'facade.sqlite') }),
  });
  const indexStatus = { getStatus: () => store.getHistoryIndexStatus() };
  const initial = await store.getLogbook({ entryLimit: 100 });
  assert.equal(initial.success, true, initial.error);
  assert.deepEqual(takeoffLogbook.getEntries().map((entry) => entry.id), ['legacy-only', 'legacy-matched'],
    'legacy records stay durable while their CSV-backed replacements are still being indexed');
  await waitForCompletion(indexStatus);
  const indexed = await store.getLogbook({ entryLimit: 100 });
  assert.equal(indexed.success, true, indexed.error);
  assert.equal(indexed.index.used, true);
  assert.equal(indexed.takeoffs.length, 2, 'one recorded departure replaces its legacy duplicate');
  assert.equal(indexed.takeoffStats.total, 2);
  assert.equal(indexed.takeoffStats.avgRollDistanceFt, 2_100);
  assert.deepEqual(takeoffLogbook.getEntries().map((entry) => entry.id), ['legacy-only']);
  const recordedFromIndex = indexed.takeoffs.find((entry) => entry.id === recorded.id);
  assert.ok(recordedFromIndex);
  assert.deepEqual(recordedFromIndex.analysis, recorded.analysis);

  const limited = await store.getLogbook({ entryLimit: 1 });
  assert.equal(limited.takeoffs.length, 1);
  assert.equal(limited.takeoffs[0].id, 'legacy-only', 'pagination combines both histories in timestamp order');
  assert.equal(limited.takeoffStats.total, 2, 'aggregates describe all records rather than the visible page');
  const totalsOnly = await store.getLogbook({ entryLimit: 0 });
  assert.deepEqual(totalsOnly.takeoffs, []);
  assert.equal(totalsOnly.takeoffStats.total, 2);

  const ambiguous = { ...matchedLegacy, id: 'shared-legacy-id' };
  const ambiguousExtra = { ...ambiguous, timestampMs: LIFTOFF_MS + 2_000, rollDistanceFt: 1234 };
  fs.writeFileSync(takeoffLogbook.TAKEOFF_LOG_FILE, JSON.stringify({
    version: 1, entries: [unmatchedLegacy, ambiguous, ambiguousExtra],
  }));
  const ambiguousHistory = await store.getLogbook({ entryLimit: 100 });
  assert.equal(ambiguousHistory.takeoffs.filter((entry) => entry.id === ambiguous.id).length, 2,
    'SQLite matching must not hide either legacy record when only one shared-ID record has a CSV counterpart');
  assert.deepEqual(takeoffLogbook.getEntries(), [unmatchedLegacy, ambiguous, ambiguousExtra]);
  fs.writeFileSync(takeoffLogbook.TAKEOFF_LOG_FILE, JSON.stringify({ version: 1, entries: [unmatchedLegacy] }));

  const removedDir = path.join(scratchRoot, 'removed-facade-bundle');
  fs.renameSync(bundle.paths.dir, removedDir);
  await store.getLogbook();
  await waitForCompletion(indexStatus);
  const afterRemoval = await store.getLogbook();
  assert.equal(afterRemoval.takeoffStats.total, 1);
  assert.deepEqual(afterRemoval.takeoffs.map((entry) => entry.id), ['legacy-only']);
  assert.deepEqual(takeoffLogbook.getEntries().map((entry) => entry.id), ['legacy-only']);

  fs.renameSync(removedDir, bundle.paths.dir);
  await store.getLogbook();
  await waitForCompletion(indexStatus);
  const afterRestore = await store.getLogbook();
  assert.equal(afterRestore.takeoffStats.total, 2);
  assert.deepEqual(afterRestore.takeoffs.find((entry) => entry.id === recorded.id), recordedFromIndex);
});

test('blocked flush preserves legacy evidence even after this coordinator completed an earlier index', async (t) => {
  const sqlite = loadNodeSqlite();
  if (!sqlite.available) {
    t.skip(`node:sqlite unavailable: ${sqlite.error}`);
    return;
  }
  const { createFlightCsvStore } = require('../flight-recording/flight-csv-store.js');
  const legacyLog = require('./takeoff-logbook.js');
  const logsRoot = path.join(scratchRoot, 'Documents', 'Flight Fabric', 'Flight Logs');
  const bundle = await makeBundle(logsRoot, 'stale-snapshot');
  const recorded = (await getFlightRecordsFromCsvFile(bundle.paths.csv)).takeoffs[0];
  fs.mkdirSync(path.dirname(legacyLog.TAKEOFF_LOG_FILE), { recursive: true });
  fs.writeFileSync(legacyLog.TAKEOFF_LOG_FILE, JSON.stringify({ version: 1, entries: [] }));
  let blocked = false;
  let flushCalls = 0;
  const store = createFlightCsvStore({
    openHistoryIndexStore: () => openHistoryIndexStore({ dbPath: path.join(scratchRoot, 'stale-snapshot.sqlite') }),
    recordingBundleGuard: {
      getActiveCsvPath: () => blocked ? getBundlePaths(logsRoot, 'another-active-flight').csv : null,
      async flushActiveBundle() { flushCalls += 1; return false; },
    },
  });
  const indexStatus = { getStatus: () => store.getHistoryIndexStatus() };
  const removedDir = path.join(scratchRoot, 'removed-stale-snapshot');
  try {
    assert.equal((await store.getLogbook()).success, true);
    await waitForCompletion(indexStatus);
    assert.equal(store.getHistoryIndexStatus().phase, 'complete');
    const legacy = { ...recorded, id: 'keep-stale-legacy', eventId: null, sampleIndex: null };
    const legacyBytes = JSON.stringify({ version: 1, entries: [legacy] });
    fs.writeFileSync(legacyLog.TAKEOFF_LOG_FILE, legacyBytes);
    fs.renameSync(bundle.paths.dir, removedDir);
    blocked = true;
    const stale = await store.getLogbook();
    assert.equal(stale.success, true, stale.error);
    assert.equal(stale.index.stale, true);
    assert.equal(flushCalls, 1);
    assert.equal(fs.readFileSync(legacyLog.TAKEOFF_LOG_FILE, 'utf8'), legacyBytes,
      'an old completed index must not retire the only surviving copy when the current catalog cannot be checked');

    blocked = false;
    await store.getLogbook();
    await waitForCompletion(indexStatus);
    const fresh = await store.getLogbook();
    assert.equal(fresh.success, true, fresh.error);
    assert.ok(fresh.takeoffs.some((entry) => entry.id === legacy.id));
    assert.deepEqual(legacyLog.getEntries(), [legacy]);
  } finally {
    await store.stop();
    if (fs.existsSync(removedDir)) fs.renameSync(removedDir, bundle.paths.dir);
  }
});

test('CSV fallback retires complete duplicates but preserves differing and ambiguous legacy evidence', async () => {
  const { createFlightCsvStore } = require('../flight-recording/flight-csv-store.js');
  const { getFlightRecordsFromCSVs } = require('../landing/flight-logbook.js');
  const legacyLog = require('./takeoff-logbook.js');
  const logsRoot = path.join(scratchRoot, 'Documents', 'Flight Fabric', 'Flight Logs');
  const bundle = await makeBundle(logsRoot, 'fallback');
  const recorded = (await getFlightRecordsFromCsvFile(bundle.paths.csv)).takeoffs[0];
  const duplicate = { ...recorded, id: 'fallback-duplicate', eventId: null, sampleIndex: null };
  const differing = { ...duplicate, id: 'keep-legacy-evidence', flags: [
    { code: 'legacy-edge', label: 'Earlier recorded runway-edge warning', severity: 'warning' },
  ] };
  const ambiguous = { ...duplicate, id: 'ambiguous-legacy-id' };
  const ambiguousExtra = { ...ambiguous, timestampMs: LIFTOFF_MS + 1_000, rollDistanceFt: 1234 };
  fs.mkdirSync(path.dirname(legacyLog.TAKEOFF_LOG_FILE), { recursive: true });
  fs.writeFileSync(legacyLog.TAKEOFF_LOG_FILE, JSON.stringify({ version: 1, entries: [duplicate, differing, ambiguous, ambiguousExtra] }));
  const expectedRecorded = (await getFlightRecordsFromCSVs()).takeoffs;
  const store = createFlightCsvStore({ openHistoryIndexStore: () => ({ success: false, error: 'Injected SQLite unavailable' }) });
  try {
    const result = await store.getLogbook({ entryLimit: 100 });
    assert.equal(result.success, true, result.error);
    assert.equal(result.index.used, false);
    assert.equal(result.takeoffStats.total, expectedRecorded.length + 3);
    assert.equal(result.takeoffs.some((entry) => entry.id === duplicate.id), false);
    assert.deepEqual(result.takeoffs.find((entry) => entry.id === differing.id).flags, differing.flags);
    assert.equal(result.takeoffs.filter((entry) => entry.id === ambiguous.id).length, 2,
      'both records sharing an ambiguous legacy ID stay visible');
    assert.deepEqual(legacyLog.getEntries(), [differing, ambiguous, ambiguousExtra]);
  } finally { await store.stop(); }
});

export {};
