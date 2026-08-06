'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const test = require('node:test') as typeof import('node:test');
const recorder = require('./aircraft-specific-jsonl-recorder.js');
const { AutomationJsonlRecorder } = require('./automation-jsonl-recorder.js');
const { FlightCSVWriter } = require('./flight-csv-writer.js');
const { parseCsvLine, splitCsvLines } = require('../utils/csv.js');
const timeSource = require('../core/time-source.js') as typeof import('../core/time-source');
const { createAircraftSpecificStateProjector } = require('../aircraft/aircraft-specific-state.js');

type AnyRecord = Record<string, any>;

function readRows(filePath: string): AnyRecord[] {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function replayRows(rows: AnyRecord[]): { state: AnyRecord | null; boundaries: AnyRecord[] } {
  let expectedSeq = 1;
  let pendingConfig: AnyRecord | null = null;
  let activeConfig: AnyRecord | null = null;
  let activeConfigId: number | null = null;
  let state: AnyRecord | null = null;
  const boundaries: AnyRecord[] = [];

  for (const row of rows) {
    assert.equal(row.schemaVersion, 2);
    assert.equal(row.seq, expectedSeq, 'rows must remain a contiguous append-only sequence');
    expectedSeq += 1;

    if (row.type === 'aircraft_specific_config') {
      // Stage a config until its matching checkpoint arrives. A crash after a
      // config-only tail must not erase the prior replayable state.
      pendingConfig = row;
      continue;
    }
    if (row.type === 'aircraft_specific_checkpoint') {
      if (pendingConfig && pendingConfig.configId === row.configId) {
        activeConfig = pendingConfig;
        activeConfigId = pendingConfig.configId;
        pendingConfig = null;
      }
      assert.equal(row.configId, activeConfigId, 'checkpoint must use the active or staged config');
      state = {
        profileKey: activeConfig?.profileKey,
        configId: row.configId,
        available: row.available,
        sourceStatus: row.sourceStatus,
        values: { ...row.values },
        unavailable: [...row.unavailable],
      };
      if (row.reason === 'profile_change_end') boundaries.push(row);
      continue;
    }
    if (row.type === 'aircraft_specific_delta') {
      assert(state, 'delta requires a prior checkpoint');
      assert.equal(row.configId, activeConfigId, 'delta must use the active config');
      for (const [fieldId, value] of Object.entries(row.valuesSet || {})) state.values[fieldId] = value;
      for (const fieldId of row.valuesRemoved || []) delete state.values[fieldId];
      const unavailable = new Set(state.unavailable);
      for (const fieldId of row.unavailableAdded || []) unavailable.add(fieldId);
      for (const fieldId of row.unavailableRemoved || []) unavailable.delete(fieldId);
      state.unavailable = [...unavailable].sort();
      if (typeof row.availableChanged === 'boolean') state.available = row.availableChanged;
    }
  }

  return { state, boundaries };
}

test('canonical projector state records, updates route metadata, finalizes, and replays end to end', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-aircraft-jsonl-e2e-'));
  const recordingStartMs = Date.parse('2026-07-20T01:00:00.000Z');
  const flightId = '2026-07-20T01:00:00.000Z';
  const rawValues: AnyRecord = {
    'L:PRIVATE_MAX_SPEED': 210,
    'L:PRIVATE_MAX_AT_ARM': 0,
  };
  let activeRevision = 1;
  let activeConfig: AnyRecord = {
    profileKey: 'bundled/msfs/microsoft-737-max-8',
    profileRevision: 1,
    integrationId: 'microsoft-737-max-8',
    templateId: 'microsoft-737-max-8',
    fields: [
      {
        id: 'controls.speedSelected',
        source: { type: 'lvar', key: 'L:PRIVATE_MAX_SPEED' },
        decode: { type: 'number', precision: 0 },
      },
      {
        id: 'systems.autothrottleArmed',
        source: { type: 'lvar', key: 'L:PRIVATE_MAX_AT_ARM' },
        decode: { type: 'boolean', trueValues: [1], falseValues: [0] },
      },
    ],
  };

  try {
    const armed = recorder.startFlight({ flightId, outputDir, numericIntervalMs: 1000 });
    assert(armed, 'recorder should arm alongside the authoritative CSV lifecycle');

    const projector = createAircraftSpecificStateProjector({
      broadcast: () => {},
      profileLoader: {
        getActiveProfileRevision: () => activeRevision,
        getAircraftSpecificConfig: () => activeConfig,
      },
      resolverRegistry: {
        resolve: (binding: AnyRecord) => ({
          sourceId: binding.type,
          status: 'connected',
          rawValue: rawValues[binding.key],
        }),
      },
      onStateBuilt: (state: AnyRecord, context: AnyRecord) => {
        const config = context.config;
        recorder.recordAircraftSpecificState({
          timeMs: context.nowEpochMs,
          timestampIso: context.timestampIso,
          flightElapsedMs: context.nowEpochMs - recordingStartMs,
          flightId,
          flightStartIso: new Date(recordingStartMs).toISOString(),
          aircraftTitle: state.profileKey.includes('737')
            ? 'Microsoft Boeing 737 MAX 8'
            : 'Microsoft ATR 72-600',
          profileKey: state.profileKey,
          profileRevision: state.profileRevision,
          integrationId: config.integrationId,
          templateId: state.templateId,
          available: state.available,
          sourceStatus: state.sourceStatus,
          values: state.values,
          unavailable: state.unavailable,
          fieldCatalog: config.fields.map((field: AnyRecord) => ({
            id: field.id,
            valueType: field.decode.type,
          })),
        });
      },
    });

    projector.update({
      nowEpochMs: recordingStartMs,
      timestampIso: new Date(recordingStartMs).toISOString(),
    });
    rawValues['L:PRIVATE_MAX_SPEED'] = 245;
    projector.update({
      nowEpochMs: recordingStartMs + 100,
      timestampIso: new Date(recordingStartMs + 100).toISOString(),
    });

    activeRevision = 2;
    activeConfig = {
      profileKey: 'bundled/msfs/microsoft-atr-72-600',
      profileRevision: 2,
      integrationId: 'microsoft-atr-72-600',
      templateId: 'microsoft-atr-72-600',
      fields: [{
        id: 'controls.conditionLeverMode',
        source: { type: 'simvar', key: 'SIMVAR:PRIVATE_CONDITION_LEVER' },
        decode: { type: 'enum', values: { 0: 0, 1: 1 } },
      }],
    };
    rawValues['SIMVAR:PRIVATE_CONDITION_LEVER'] = 0;
    projector.update({
      nowEpochMs: recordingStartMs + 200,
      timestampIso: new Date(recordingStartMs + 200).toISOString(),
    });
    rawValues['SIMVAR:PRIVATE_CONDITION_LEVER'] = 1;
    projector.update({
      nowEpochMs: recordingStartMs + 250,
      timestampIso: new Date(recordingStartMs + 250).toISOString(),
    });

    const beforeRoutePath = recorder.getStats().filePath;
    assert.equal(await recorder.updateRoute('YSCB', 'YSSY'), true, 'sidecar should accept route metadata');
    assert.equal(recorder.getStats().filePath, beforeRoutePath, 'route metadata must not rename the immutable bundle');
    const stats = await recorder.endFlight({
      timeMs: recordingStartMs + 500,
      timestampIso: new Date(recordingStartMs + 500).toISOString(),
      flightElapsedMs: 500,
      flightId,
      flightStartIso: new Date(recordingStartMs).toISOString(),
      aircraftTitle: 'Microsoft ATR 72-600',
      endReason: 'test_end_to_end',
    });

    assert(stats?.hasFile, 'supported aircraft recording should produce a physical sidecar');
    assert.equal(stats.filename, 'aircraft-specific.jsonl');
    const rows = readRows(stats.filePath);
    assert.equal(rows.at(-1)?.reason, 'recording_end');
    assert.equal(rows.at(-1)?.endReason, 'test_end_to_end');
    assert(!JSON.stringify(rows).includes('PRIVATE_MAX_SPEED'), 'raw LVAR routes must never reach disk');
    assert(!JSON.stringify(rows).includes('PRIVATE_CONDITION_LEVER'), 'raw SimVar routes must never reach disk');

    const replay = replayRows(rows);
    assert.equal(replay.boundaries.length, 1, 'profile transition should close exactly one old config');
    assert.equal(replay.boundaries[0].values['controls.speedSelected'], 245,
      'old-profile boundary should preserve its latest coalesced value');
    assert.equal(replay.state?.profileKey, 'bundled/msfs/microsoft-atr-72-600');
    assert.equal(replay.state?.values['controls.conditionLeverMode'], 1,
      'number-valued enum transition should replay immediately');
  } finally {
    if (recorder.isRecording() || recorder.isFinalizing()) {
      await recorder.endFlight({ endReason: 'test_cleanup' });
    }
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('manual mid-flight recording uses one recording-relative clock across the artifact bundle', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-aircraft-jsonl-clock-e2e-'));
  const lifecycleFlightId = '2026-07-20T00:55:00.000Z';
  const recordingStartMs = Date.parse('2026-07-20T01:00:00.000Z');
  const recordingStartIso = new Date(recordingStartMs).toISOString();
  const clock = timeSource.createFixedSource(recordingStartMs);
  const csv = new FlightCSVWriter({ flightId: lifecycleFlightId, outputDir });
  const automation = new AutomationJsonlRecorder({ flightId: lifecycleFlightId, outputDir });
  const aircraft = new recorder.AircraftSpecificJsonlRecorder({ flightId: lifecycleFlightId, outputDir });

  try {
    assert(csv.start(), 'primary CSV should start');
    assert(automation.start(), 'automation sidecar should start');
    assert(aircraft.start(), 'aircraft-specific sidecar should arm');
    assert(csv.writeSample({
      timestampMs: recordingStartMs,
      timestampIso: recordingStartIso,
      onGround: false,
      phase: 'CRUISE',
      ias: 250,
      vs: 0,
      lat: -35.3,
      lon: 149.2,
    }), 'CSV should accept its first sample');
    assert(automation.recordAutopilotState({
      timeMs: recordingStartMs,
      timestampIso: recordingStartIso,
      flightElapsedMs: 0,
      flightId: lifecycleFlightId,
      flightStartIso: recordingStartIso,
      aircraftProfileId: 'microsoft-737-max-8',
      aircraftTitle: 'Microsoft Boeing 737 MAX 8',
      fdm: { apMaster: false, apFdActive: true },
      baseFdm: { apMaster: false, apFdActive: true },
      simconnect: { connected: true },
    }), 'automation sidecar should accept its first state');
    assert(aircraft.recordAircraftSpecificState({
      timeMs: recordingStartMs,
      timestampIso: recordingStartIso,
      flightElapsedMs: 0,
      flightId: lifecycleFlightId,
      flightStartIso: recordingStartIso,
      aircraftTitle: 'Microsoft Boeing 737 MAX 8',
      profileKey: 'bundled/msfs/microsoft-737-max-8',
      profileRevision: 1,
      integrationId: 'microsoft-737-max-8',
      templateId: 'microsoft-737-max-8',
      sourceStatus: { overall: 'connected', sources: { simvar: 'connected' } },
      values: { 'controls.speedSelected': 250 },
      unavailable: [],
      fieldCatalog: [{
        id: 'controls.speedSelected',
        valueType: 'number',
      }],
    }), 'aircraft-specific sidecar should accept its first state');

    clock.advance(1000);
    const endContext = {
      timeMs: clock.get(),
      timestampIso: new Date(clock.get()).toISOString(),
      flightElapsedMs: 1000,
      flightId: lifecycleFlightId,
      flightStartIso: recordingStartIso,
      aircraftTitle: 'Microsoft Boeing 737 MAX 8',
      endReason: 'manual_clock_e2e',
    };
    const [csvStats, automationStats, aircraftStats] = await Promise.all([
      csv.close(),
      automation.close(endContext),
      aircraft.close(endContext),
    ]);

    const csvLines = splitCsvLines(fs.readFileSync(csvStats.filePath, 'utf8'), { trimAndDropEmpty: true });
    const csvHeaders = parseCsvLine(csvLines[0]);
    const csvValues = parseCsvLine(csvLines[1]);
    const csvRow = Object.fromEntries(csvHeaders.map((field: string, index: number) => [field, csvValues[index]]));
    const automationRows = readRows(automationStats.filePath);
    const aircraftRows = readRows(aircraftStats.filePath);

    assert.equal(csvRow.flight_id, lifecycleFlightId);
    assert.equal(Number(csvRow.flight_elapsed_ms), 0, 'CSV clock should begin when manual recording starts');
    assert.equal(automationRows[0].flightId, lifecycleFlightId);
    assert.equal(automationRows[0].flightElapsedMs, 0);
    assert.equal(automationRows[0].flightStartIso, recordingStartIso);
    assert.equal(aircraftRows[0].flightId, lifecycleFlightId);
    assert.equal(aircraftRows[0].flightElapsedMs, 0);
    assert.equal(aircraftRows[0].flightStartIso, recordingStartIso);
    assert.equal(
      automationRows.at(-1)?.timeMs - automationRows[0].timeMs,
      1000,
      'compact automation rows should derive elapsed time from the manifest clock',
    );
    assert.equal(aircraftRows.at(-1)?.flightElapsedMs, 1000);
  } finally {
    timeSource.resetTimeSource();
    if (!csv.closed) await csv.close();
    if (!automation.closed) await automation.close({ endReason: 'test_cleanup' });
    if (!aircraft.closed) await aircraft.close({ endReason: 'test_cleanup' });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

export {};
