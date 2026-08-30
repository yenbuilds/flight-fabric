'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');
const { after, test } = require('node:test') as typeof import('node:test');
const {
  readAircraftSpecificRowsForCsv,
} = require('./aircraft-specific-jsonl-reader') as {
  readAircraftSpecificRowsForCsv: (
    _csvPath: string,
    _options?: {
      retainRows?: number;
      onCommittedRow?: (_row: Record<string, any>) => void;
    },
  ) => Promise<Record<string, any>>;
};

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-aircraft-jsonl-reader-'));
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

const startIso = '2026-07-20T01:02:03.004Z';
const startMs = Date.parse(startIso);
const flightId = 'reader-flight';
const recordingSessionId = 'reader-session';

function createCsv(
  name: string,
  sessionId: string | null = recordingSessionId,
  recordType = sessionId === null ? 'SAMPLE' : 'RECORDING_MANIFEST',
): string {
  const bundleDir = path.join(tempRoot, name);
  fs.mkdirSync(bundleDir);
  const csvPath = path.join(bundleDir, 'telemetry.csv');
  const sessionHeader = sessionId === null ? '' : ',recording_session_id';
  const sessionValue = sessionId === null ? '' : `,${sessionId}`;
  fs.writeFileSync(
    csvPath,
    `record_type,flight_id,flight_start_iso${sessionHeader}\n${recordType},${flightId},${startIso}${sessionValue}\n`,
    'utf8',
  );
  return csvPath;
}

function sidecarPath(csvPath: string): string {
  return path.join(path.dirname(csvPath), 'aircraft-specific.jsonl');
}

function row(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    schemaVersion: 1,
    seq: 1,
    type: 'aircraft_specific_manifest',
    timeMs: startMs,
    timestampIso: startIso,
    flightElapsedMs: 0,
    flightId,
    recordingSessionId,
    flightStartIso: startIso,
    ...overrides,
  };
}

function writeRows(csvPath: string, rows: Record<string, any>[], terminate = true): void {
  const body = rows.map((entry) => JSON.stringify(entry)).join('\n');
  fs.writeFileSync(sidecarPath(csvPath), `${body}${terminate ? '\n' : ''}`, 'utf8');
}

test('accepts a synchronized strict sidecar with a committed identity manifest', async () => {
  const csvPath = createCsv('valid');
  writeRows(csvPath, [
    row(),
    row({
      seq: 2,
      type: 'aircraft_specific_config',
      timeMs: startMs + 25,
      timestampIso: new Date(startMs + 25).toISOString(),
      flightElapsedMs: 25,
    }),
  ]);

  const result = await readAircraftSpecificRowsForCsv(csvPath);
  assert.equal(result.error, undefined);
  assert.equal(result.exists, true);
  assert.equal(result.rows.length, 2);
});

test('reports a missing companion distinctly', async () => {
  const result = await readAircraftSpecificRowsForCsv(createCsv('missing'));
  assert.equal(result.exists, false);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.rows, []);
});

test('rejects cross-file identity mismatch', async () => {
  const csvPath = createCsv('identity-mismatch');
  writeRows(csvPath, [row({ recordingSessionId: 'different-session' })]);
  const result = await readAircraftSpecificRowsForCsv(csvPath);
  assert.match(result.error, /identity does not match/i);
});

test('rejects an internally changed identity and non-contiguous sequence', async () => {
  const identityCsvPath = createCsv('identity-drift');
  writeRows(identityCsvPath, [
    row(),
    row({
      seq: 2,
      type: 'aircraft_specific_delta',
      flightId: 'changed-flight',
      timeMs: startMs + 10,
      timestampIso: new Date(startMs + 10).toISOString(),
      flightElapsedMs: 10,
    }),
  ]);
  assert.match((await readAircraftSpecificRowsForCsv(identityCsvPath)).error, /flightId changed/i);

  const seqCsvPath = createCsv('sequence-gap');
  writeRows(seqCsvPath, [
    row(),
    row({
      seq: 3,
      type: 'aircraft_specific_delta',
      timeMs: startMs + 10,
      timestampIso: new Date(startMs + 10).toISOString(),
      flightElapsedMs: 10,
    }),
  ]);
  assert.match((await readAircraftSpecificRowsForCsv(seqCsvPath)).error, /non-contiguous seq/i);
});

test('rejects malformed interior JSON but quarantines an unterminated final row', async () => {
  const malformedCsvPath = createCsv('malformed-interior');
  fs.writeFileSync(
    sidecarPath(malformedCsvPath),
    `${JSON.stringify(row())}\n{"broken":\n${JSON.stringify(row({ seq: 2 }))}\n`,
    'utf8',
  );
  assert.match((await readAircraftSpecificRowsForCsv(malformedCsvPath)).error, /malformed JSON at line 2/i);

  const tornCsvPath = createCsv('torn-final');
  writeRows(tornCsvPath, [
    row(),
    row({
      seq: 2,
      type: 'aircraft_specific_delta',
      timeMs: startMs + 10,
      timestampIso: new Date(startMs + 10).toISOString(),
      flightElapsedMs: 10,
    }),
  ], false);
  const recovered = await readAircraftSpecificRowsForCsv(tornCsvPath);
  assert.equal(recovered.error, undefined);
  assert.equal(recovered.recoveredTail, true);
  assert.equal(recovered.rows.length, 1);
});

test('rejects blank rows inside a strict JSONL stream', async () => {
  const csvPath = createCsv('blank-interior');
  fs.writeFileSync(
    sidecarPath(csvPath),
    `${JSON.stringify(row())}\n\n${JSON.stringify(row({
      seq: 2,
      type: 'aircraft_specific_delta',
      timeMs: startMs + 10,
      timestampIso: new Date(startMs + 10).toISOString(),
      flightElapsedMs: 10,
    }))}\n`,
    'utf8',
  );
  assert.match((await readAircraftSpecificRowsForCsv(csvPath)).error, /blank row at line 2/i);
});

test('rejects invalid UTF-8 and a strict file without a manifest', async () => {
  const utf8CsvPath = createCsv('invalid-utf8');
  fs.writeFileSync(sidecarPath(utf8CsvPath), Buffer.from([0xc3, 0x28, 0x0a]));
  assert.match((await readAircraftSpecificRowsForCsv(utf8CsvPath)).error, /invalid UTF-8/i);

  const noManifestCsvPath = createCsv('no-manifest');
  writeRows(noManifestCsvPath, [row({ type: 'aircraft_specific_checkpoint' })]);
  assert.match((await readAircraftSpecificRowsForCsv(noManifestCsvPath)).error, /identity manifest/i);
});

test('rejects a non-zero or repeated identity manifest', async () => {
  const nonZeroCsvPath = createCsv('nonzero-manifest');
  writeRows(nonZeroCsvPath, [row({
    timeMs: startMs + 1,
    timestampIso: new Date(startMs + 1).toISOString(),
    flightElapsedMs: 1,
  })]);
  assert.match((await readAircraftSpecificRowsForCsv(nonZeroCsvPath)).error, /flightElapsedMs 0/i);

  const duplicateCsvPath = createCsv('duplicate-manifest');
  writeRows(duplicateCsvPath, [
    row(),
    row({
      seq: 2,
      timeMs: startMs + 1,
      timestampIso: new Date(startMs + 1).toISOString(),
      flightElapsedMs: 1,
    }),
  ]);
  assert.match((await readAircraftSpecificRowsForCsv(duplicateCsvPath)).error, /only valid as the first row/i);
});

test('keeps a legacy config-first sidecar readable when the CSV has no bundle session column', async () => {
  const csvPath = createCsv('legacy', null);
  const legacy = row({
    type: 'aircraft_specific_config',
    recordingSessionId: undefined,
  });
  writeRows(csvPath, [legacy]);
  const result = await readAircraftSpecificRowsForCsv(csvPath);
  assert.equal(result.error, undefined);
  assert.equal(result.rows.length, 1);
});

test('rejects manifest-first and session-scoped CSV identity downgrades', async () => {
  const manifestWithoutSessionPath = createCsv(
    'manifest-without-session',
    null,
    'RECORDING_MANIFEST',
  );
  writeRows(manifestWithoutSessionPath, [row({
    type: 'aircraft_specific_config',
    recordingSessionId: undefined,
  })]);
  const manifestWithoutSession = await readAircraftSpecificRowsForCsv(manifestWithoutSessionPath);
  assert.match(manifestWithoutSession.error, /recording_session_id/i);
  assert.deepEqual(manifestWithoutSession.rows, []);

  const blankSessionPath = createCsv('blank-session', '');
  writeRows(blankSessionPath, [row()]);
  const blankSession = await readAircraftSpecificRowsForCsv(blankSessionPath);
  assert.match(blankSession.error, /recording_session_id/i);
  assert.deepEqual(blankSession.rows, []);

  const sampleFirstCurrentPath = createCsv('sample-first-current', recordingSessionId, 'SAMPLE');
  writeRows(sampleFirstCurrentPath, [row()]);
  const sampleFirstCurrent = await readAircraftSpecificRowsForCsv(sampleFirstCurrentPath);
  assert.match(sampleFirstCurrent.error, /must begin with a RECORDING_MANIFEST/i);
  assert.deepEqual(sampleFirstCurrent.rows, []);
});

test('accepts compact v2 rows and validates sequential config references', async () => {
  const csvPath = createCsv('compact-v2');
  const manifest = row({ schemaVersion: 2, bundleStatusRequired: true });
  const config = {
    schemaVersion: 2,
    seq: 2,
    type: 'aircraft_specific_config',
    flightElapsedMs: 0,
    configId: 1,
    reason: 'first_snapshot',
    profileKey: 'bundled/msfs/test-sdk-aircraft',
    profileRevision: 4,
    integrationId: 'test-sdk-aircraft',
    templateId: 'test-sdk-aircraft',
    fieldTypes: {
      'afds.apEngaged': 'boolean',
      'flightControls.flapNeedleLeft': 'number',
    },
  };
  const checkpoint = {
    schemaVersion: 2,
    seq: 3,
    type: 'aircraft_specific_checkpoint',
    flightElapsedMs: 0,
    configId: 1,
    reason: 'first_snapshot',
    available: true,
    sourceStatus: { overall: 'connected', sources: { sdk: 'connected' } },
    values: { 'afds.apEngaged': false },
    unavailable: ['flightControls.flapNeedleLeft'],
  };
  const delta = {
    schemaVersion: 2,
    seq: 4,
    type: 'aircraft_specific_delta',
    flightElapsedMs: 25,
    configId: 1,
    valuesSet: { 'afds.apEngaged': true },
  };
  writeRows(csvPath, [manifest, config, checkpoint, delta]);

  const result = await readAircraftSpecificRowsForCsv(csvPath);
  assert.equal(result.error, undefined);
  assert.equal(result.rows.length, 4);
  assert.equal(result.rows[1].configId, 1);
  assert.equal(result.rows[1].configHash, undefined);
  assert.equal(result.rows[3].flightId, undefined);
});

test('projects every committed row while retaining only the requested bounded prefix', async () => {
  const csvPath = createCsv('stream-project-v2');
  const rows = [
    row({ schemaVersion: 2, bundleStatusRequired: true }),
    {
      schemaVersion: 2,
      seq: 2,
      type: 'aircraft_specific_config',
      flightElapsedMs: 0,
      configId: 1,
      profileKey: 'bundled/msfs/pmdg-777',
      profileRevision: 1,
      integrationId: 'pmdg-777',
      templateId: 'pmdg-777',
      fieldTypes: { 'flightGuidance.localizer': 'boolean' },
    },
    {
      schemaVersion: 2,
      seq: 3,
      type: 'aircraft_specific_checkpoint',
      flightElapsedMs: 0,
      configId: 1,
      values: { 'flightGuidance.localizer': false },
      unavailable: [],
      sourceStatus: { overall: 'connected', sources: { sdk: 'connected' } },
    },
  ];
  writeRows(csvPath, rows);

  const projected: string[] = [];
  const result = await readAircraftSpecificRowsForCsv(csvPath, {
    retainRows: 1,
    onCommittedRow(projectedRow) {
      projected.push(projectedRow.type);
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(projected, [
    'aircraft_specific_manifest',
    'aircraft_specific_config',
    'aircraft_specific_checkpoint',
  ]);
});

test('rejects compact v2 config gaps, uncommitted deltas, and mixed schemas', async () => {
  const baseConfig = {
    schemaVersion: 2,
    seq: 2,
    type: 'aircraft_specific_config',
    flightElapsedMs: 0,
    configId: 1,
    reason: 'first_snapshot',
    profileKey: 'bundled/msfs/test-sdk-aircraft',
    profileRevision: 4,
    fieldTypes: { 'afds.apEngaged': 'boolean' },
  };

  const gapPath = createCsv('compact-v2-config-gap');
  writeRows(gapPath, [
    row({ schemaVersion: 2, bundleStatusRequired: true }),
    { ...baseConfig, configId: 2 },
  ]);
  assert.match((await readAircraftSpecificRowsForCsv(gapPath)).error, /non-contiguous configId/i);

  const uncommittedPath = createCsv('compact-v2-uncommitted');
  writeRows(uncommittedPath, [
    row({ schemaVersion: 2, bundleStatusRequired: true }),
    baseConfig,
    {
      schemaVersion: 2,
      seq: 3,
      type: 'aircraft_specific_delta',
      flightElapsedMs: 1,
      configId: 1,
      valuesSet: { 'afds.apEngaged': true },
    },
  ]);
  assert.match((await readAircraftSpecificRowsForCsv(uncommittedPath)).error, /active config/i);

  const mixedPath = createCsv('compact-v2-mixed-schema');
  writeRows(mixedPath, [
    row({ schemaVersion: 2, bundleStatusRequired: true }),
    { ...baseConfig, schemaVersion: 1 },
  ]);
  assert.match((await readAircraftSpecificRowsForCsv(mixedPath)).error, /schemaVersion changed/i);
});

export {};
