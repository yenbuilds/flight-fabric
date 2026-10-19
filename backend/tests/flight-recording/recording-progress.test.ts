const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const test = require('node:test') as typeof import('node:test');
const { getRecordingSizeBytes } = require('../../flight-recording/recording-progress') as typeof import('../../flight-recording/recording-progress');
const { FlightCSVWriter, WorkerFlightCSVWriter } = require('../../flight-recording/flight-csv-writer');
const { AutomationJsonlRecorder } = require('../../flight-recording/automation-jsonl-recorder');
const { AircraftSpecificJsonlRecorder } = require('../../flight-recording/aircraft-specific-jsonl-recorder');
const timeSource = require('../../core/time-source') as typeof import('../../core/time-source');

for (const Writer of [FlightCSVWriter, WorkerFlightCSVWriter]) {
  test(`${Writer.name}: live size matches all three files without counting queued writes`, async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-recording-progress-'));
    const start = Date.now();
    const options = {
      outputDir, bundleBaseName: 'recording-progress', flightId: new Date(start).toISOString(),
      recordingSessionId: 'recording-progress-session', recordingStartEpochMs: start,
      recordingStartIso: new Date(start).toISOString(),
    };
    const csv = new Writer(options);
    const automation = new AutomationJsonlRecorder(options);
    const aircraft = new AircraftSpecificJsonlRecorder(options);
    const recorders = [csv, automation, aircraft];
    const actualSize = () => recorders.reduce((total, recorder) => total + fs.statSync(recorder.filePath).size, 0);
    try {
      for (const recorder of recorders) assert.equal(recorder.start(), true);
      const startupSize = getRecordingSizeBytes(options.recordingSessionId, recorders);
      assert.equal(startupSize, actualSize(), 'durable startup headers and manifests count immediately');
      assert.equal(csv.writeSample({ phase: 'TAXI', onGround: true, gs: 8, ias: 8, lat: -33.94, lon: 151.17 }), true);
      assert.equal(automation.recordAutopilotState({
        timeMs: start + 1000, aircraftTitle: 'Air France – A320', dataSource: 'simconnect',
        fdm: { apMaster: false, apFdActive: true, apAltTargetFt: 5000 },
        baseFdm: { apMaster: false, apFdActive: true, apAltTargetFt: 5000 }, simconnect: { connected: true },
      }), true);
      assert.equal(getRecordingSizeBytes(options.recordingSessionId, recorders), startupSize,
        'synchronously queued rows are not presented as written bytes');
      assert.deepEqual(await Promise.all(recorders.map(recorder => recorder.flush())), [true, true, true]);
      assert.equal(getRecordingSizeBytes(options.recordingSessionId, recorders), actualSize(),
        'completed writes count exact UTF-8 bytes and delimiters');
      assert(actualSize() > startupSize);
      assert.equal(getRecordingSizeBytes('next-flight', recorders), null, 'a previous flight cannot contribute bytes');
      for (const recorder of recorders) await recorder.close();
      assert.equal(getRecordingSizeBytes(options.recordingSessionId, recorders), null, 'closed writers cannot publish progress');
    } finally {
      for (const recorder of recorders) await recorder.close();
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test(`${Writer.name}: repeated sessions retain exact progress and release writer resources`, async (context) => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-recording-progress-sustained-'));
    const clock = timeSource.createFixedSource(Date.parse('2026-10-18T00:00:00.000Z'));
    let previousCsv: any = null;
    try {
      for (let sessionIndex = 0; sessionIndex < 3; sessionIndex += 1) {
        const start = clock.get();
        const options = {
          outputDir, bundleBaseName: `session-${sessionIndex}`, flightId: new Date(start).toISOString(),
          recordingSessionId: `session-${sessionIndex}`, recordingStartEpochMs: start,
          recordingStartIso: new Date(start).toISOString(),
        };
        const csv = new Writer(options);
        const automation = new AutomationJsonlRecorder(options);
        const aircraft = new AircraftSpecificJsonlRecorder(options);
        const recorders = [csv, automation, aircraft];
        try {
          for (const recorder of recorders) assert.equal(recorder.start(), true);
          let previousSize = getRecordingSizeBytes(options.recordingSessionId, recorders)!;
          if (previousCsv instanceof WorkerFlightCSVWriter) {
            previousCsv._handleWorkerMessage({ type: 'progress', rowCount: 999999, writtenBytes: 999999999 });
            assert.equal(previousCsv.getProgress(), null);
            assert.equal(getRecordingSizeBytes(options.recordingSessionId, recorders), previousSize);
          }
          for (let batchIndex = 0; batchIndex < 8; batchIndex += 1) {
            for (let sampleIndex = 0; sampleIndex < 256; sampleIndex += 1) {
              clock.advance(100);
              const elapsedSeconds = (clock.get() - start) / 1000;
              assert.equal(csv.writeSample({
                phase: 'CRUISE', onGround: false, gs: 450, ias: 270, alt: 35000, hdg: 90,
                lat: 0, lon: 100 + elapsedSeconds * 450 / 3600 / 60,
              }), true);
              automation.recordAutopilotState({
                timeMs: clock.get(), aircraftTitle: 'Microsoft Boeing 737 MAX 8 – Éire', dataSource: 'simconnect',
                fdm: { apMaster: true, apFdActive: true, apAltTargetFt: 35000 },
                baseFdm: { apMaster: true, apFdActive: true, apAltTargetFt: 35000 },
                simconnect: { connected: true },
              });
              aircraft.recordAircraftSpecificState({
                timeMs: clock.get(), aircraftTitle: 'Microsoft Boeing 737 MAX 8 – Éire',
                profileKey: 'bundled/msfs/microsoft-737-max-8', profileRevision: 4,
                integrationId: 'microsoft-737-max-8', templateId: 'microsoft-737-max-8',
                fieldCatalog: [{ id: 'controls.speedSelected', valueType: 'number' }],
                available: true, sourceStatus: { overall: 'connected', sources: { lvar: 'connected' } },
                values: { 'controls.speedSelected': 270 }, unavailable: [],
              });
              const currentSize = getRecordingSizeBytes(options.recordingSessionId, recorders)!;
              assert(currentSize >= previousSize, 'progress must not decrease within a session');
              previousSize = currentSize;
            }
            assert.deepEqual(await Promise.all(recorders.map(recorder => recorder.flush())), [true, true, true]);
            for (const recorder of recorders) {
              assert.equal(recorder.getProgress().writtenBytes, fs.statSync(recorder.filePath).size);
            }
            const actualSize = recorders.reduce((total, recorder) => total + fs.statSync(recorder.filePath).size, 0);
            assert.equal(getRecordingSizeBytes(options.recordingSessionId, recorders), actualSize);
            previousSize = actualSize;
            if (csv instanceof WorkerFlightCSVWriter) {
              assert.equal(csv.pendingRequests.size, 0);
              assert.equal(csv.pendingLines.length, 0);
              assert.equal(csv.inflightAppendBytes, 0);
              assert.equal(csv.inflightAppendLines, 0);
            }
          }
          const expectedSize = previousSize;
          try {
            for (const method of ['statSync', 'fstatSync', 'existsSync', 'readFileSync', 'readdirSync',
              'openSync', 'writeSync', 'writeFileSync', 'stat', 'fstat', 'readFile', 'readdir', 'open', 'write', 'writeFile'] as const) {
              context.mock.method(fs, method, () => { throw new Error(`Progress must not call fs.${method}`); });
            }
            for (let readIndex = 0; readIndex < 10000; readIndex += 1) {
              assert.equal(getRecordingSizeBytes(options.recordingSessionId, recorders), expectedSize);
            }
          } finally {
            context.mock.restoreAll();
          }
          for (const recorder of recorders) {
            const error = new Error('Simulated terminal write failure');
            recorder.lastError = error;
            assert.equal(getRecordingSizeBytes(options.recordingSessionId, recorders), null);
            recorder.lastError = null;
          }
        } finally {
          for (const recorder of recorders) await recorder.close();
          for (const recorder of recorders) assert.equal(recorder.getProgress(), null);
          for (const recorder of [automation, aircraft]) {
            assert.equal(recorder.stream, null);
            assert.equal(recorder.periodicSyncTimer, null);
            assert.equal(recorder.explicitFlushPromise, null);
          }
          if (csv instanceof WorkerFlightCSVWriter) {
            assert.equal(csv.worker, null);
            assert.equal(csv.workerTerminationPromise, null);
            assert.equal(csv.pendingRequests.size, 0);
            assert.equal(csv.inflightAppendBytes, 0);
          } else {
            assert.equal(csv.stream, null);
            assert.equal(csv.periodicSyncTimer, null);
          }
          previousCsv = csv;
        }
      }
      const files = fs.readdirSync(outputDir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
      assert.equal(files.length, 9, 'only the three artifacts per session are created');
    } finally {
      timeSource.resetTimeSource();
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
}

test('unavailable, mismatched or invalid member counters never produce a partial total', () => {
  const member = (id: string, writtenBytes: number) => ({ getProgress: () => ({ recordingSessionId: id, writtenBytes }) });
  assert.equal(getRecordingSizeBytes('flight', [member('flight', 12), member('flight', 34), member('flight', 56)]), 102);
  for (const third of [{}, { getProgress: () => null }, member('older-flight', 56), member('flight', -1),
    member('flight', NaN), member('flight', Infinity), member('flight', 1.5), member('flight', Number.MAX_SAFE_INTEGER)]) {
    assert.equal(getRecordingSizeBytes('flight', [member('flight', 12), member('flight', 34), third]), null);
  }
  assert.equal(getRecordingSizeBytes('flight', [member('flight', 0), member('flight', 0), member('flight', 0)]), 0);
  assert.equal(getRecordingSizeBytes('', [member('', 1), member('', 2), member('', 3)]), null);
  assert.equal(getRecordingSizeBytes('flight', [member('flight', 1), member('flight', 2)]), null);
  assert.equal(getRecordingSizeBytes('flight', Array.from({ length: 4 }, () => member('flight', 1))), null);
});

export {};
