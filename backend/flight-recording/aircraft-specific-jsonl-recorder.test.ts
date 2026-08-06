'use strict';

const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');
const recorderModule = require('./aircraft-specific-jsonl-recorder.js');

let passed = 0;
let failed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function test(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn();
    console.log(`  + ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  - ${name}: ${(error as Error).message}`);
    failed += 1;
  }
}

function makeOutputDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ff-aircraft-jsonl-${name}-`));
}

function readRows(filePath: string): Record<string, any>[] {
  const contents = fs.readFileSync(filePath, 'utf8').trim();
  if (!contents) return [];
  return contents.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function baseInput(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    timeMs: overrides.timeMs ?? 0,
    timestampIso: overrides.timestampIso || '2026-07-19T00:00:00.000Z',
    flightElapsedMs: overrides.flightElapsedMs ?? overrides.timeMs ?? 0,
    flightId: '2026-07-19T00:00:00.000Z',
    flightStartIso: '2026-07-19T00:00:00.000Z',
    aircraftTitle: 'Microsoft Boeing 737 MAX 8',
    profileKey: overrides.profileKey || 'bundled/msfs/microsoft-737-max-8',
    profileRevision: overrides.profileRevision ?? 4,
    integrationId: overrides.integrationId || 'microsoft-737-max-8',
    templateId: overrides.templateId || 'microsoft-737-max-8',
    fieldCatalog: overrides.fieldCatalog || [
      { id: 'controls.speedSelected', valueType: 'number' },
      { id: 'systems.autothrottleArmed', valueType: 'boolean' },
      { id: 'systems.flightMode', valueType: 'enum' },
    ],
    available: overrides.available ?? true,
    sourceStatus: overrides.sourceStatus || {
      overall: 'connected',
      sources: { lvar: 'connected' },
    },
    values: overrides.values || {
      'controls.speedSelected': 210,
      'systems.autothrottleArmed': false,
      'systems.flightMode': 'LNAV',
    },
    unavailable: overrides.unavailable || [],
    ...overrides,
  };
}

async function withRecorder(
  name: string,
  options: Record<string, any>,
  fn: (recorder: any, outputDir: string) => Promise<void>,
): Promise<void> {
  const outputDir = makeOutputDir(name);
  const recorder = new recorderModule.AircraftSpecificJsonlRecorder({
    flightId: '2026-07-19T00:00:00.000Z',
    outputDir,
    recordingStartEpochMs: 0,
    recordingStartIso: new Date(0).toISOString(),
    ...options,
  });
  try {
    assert(recorder.start(), 'recorder should arm successfully');
    await fn(recorder, outputDir);
  } finally {
    if (!recorder.closed) await recorder.close({ endReason: 'test_cleanup' });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

async function run(): Promise<void> {
  console.log('\nAircraft-Specific JSONL Recorder Tests\n');

  await test('eagerly writes an identity manifest without a supported state', async () => {
    await withRecorder('manifest-only', {}, async (recorder, outputDir) => {
      const plannedPath = recorder.filePath;
      assert(fs.existsSync(plannedPath), 'successful start must claim the sidecar immediately');
      assert(await recorder.flush(), 'the identity manifest should flush durably');
      const stats = await recorder.close({ endReason: 'no_profile' });
      const rows = readRows(plannedPath);
      assert(stats.rowCount === 1, 'manifest-only recording should have one row');
      assert(stats.hasFile === true, 'manifest-only recording should report its claimed file');
      assert(fs.readdirSync(outputDir).length === 1, 'manifest-only recording should leave exactly one sidecar');
      assert(rows.length === 1 && rows[0].type === 'aircraft_specific_manifest',
        'the sole row should be the aircraft-specific identity manifest');
      assert(rows[0].seq === 1 && rows[0].flightElapsedMs === 0,
        'the manifest should establish sequence and recording clock origin');
      assert(rows[0].flightId === recorder.flightId, 'the manifest should own the flight identity');
      assert(rows[0].recordingSessionId === recorder.recordingSessionId,
        'the manifest should own the recording session identity');
      assert(rows[0].flightStartIso === recorder.recordingStartIso,
        'the manifest should own the recording start clock');
    });
  });

  await test('state writes cannot create a manifest-less sidecar before startup', async () => {
    const outputDir = makeOutputDir('pre-start-write');
    const recorder = new recorderModule.AircraftSpecificJsonlRecorder({
      flightId: '2026-07-19T00:00:00.000Z',
      outputDir,
      recordingStartEpochMs: 0,
      recordingStartIso: new Date(0).toISOString(),
    });
    try {
      assert(!recorder.recordAircraftSpecificState(baseInput()), 'pre-start state must be rejected');
      assert(!recorder.writeRows([{ type: 'test_row' }]), 'pre-start raw row must be rejected');
      assert(!fs.existsSync(recorder.filePath), 'pre-start writes must not claim a manifest-less file');
      assert(recorder.start(), 'a clean start should still succeed after rejected pre-start calls');
      const stats = await recorder.close({ endReason: 'no_profile' });
      const rows = readRows(stats.filePath);
      assert(rows.length === 1 && rows[0].type === 'aircraft_specific_manifest',
        'the eventual artifact should begin and end with only its committed manifest');
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  await test('writer-owned schema and sequence cannot be overridden by row data', async () => {
    await withRecorder('owned-envelope', {}, async (recorder) => {
      assert(recorder.writeRows([{
        type: 'test_row',
        schemaVersion: 999,
        seq: 999,
      }]), 'test row should be accepted');
      const stats = await recorder.close({ endReason: 'no_profile' });
      const rows = readRows(stats.filePath);
      assert(rows.length === 2, 'manifest and test row should be persisted');
      assert(rows[1].schemaVersion === 2, 'row data must not override the writer schema version');
      assert(rows[1].seq === 2, 'row data must not override the contiguous writer sequence');
    });
  });

  await test('capacity shutdown drains accepted rows without appending a final checkpoint', async () => {
    await withRecorder('capacity-close', {}, async (recorder) => {
      assert(recorder.recordAircraftSpecificState(baseInput()), 'first state should be accepted');
      const acceptedRows = recorder.getStats().rowCount;
      const stats = await recorder.close({
        endReason: 'low_disk_safety_floor',
        skipFinalCheckpoint: true,
      });
      const rows = readRows(stats.filePath);
      assert(stats.rowCount === acceptedRows, 'capacity close must not increase the accepted row count');
      assert(!rows.some((row) => row.reason === 'recording_end'),
        'capacity close must not append a recording_end checkpoint');
    });
  });

  await test('a repeated start cannot delete or disable an active sidecar', async () => {
    await withRecorder('repeat-start', {}, async (recorder) => {
      const activePath = recorder.filePath;
      assert(!recorder.start(), 'a recorder instance must refuse a second start');
      assert(fs.existsSync(activePath), 'refusing a second start must preserve the active artifact');
      assert(recorder.recordAircraftSpecificState(baseInput()),
        'refusing a second start must leave the active recorder usable');
      const stats = await recorder.close({ timeMs: 100, endReason: 'test_end' });
      const rows = readRows(activePath);
      assert(stats.hasError === false && rows.map((row) => row.seq).join(',') === '1,2,3,4',
        'active history should remain healthy and contiguous after the refusal');
    });
  });

  await test('writes sanitized config and first/final checkpoints with deterministic sequence', async () => {
    await withRecorder('first', {}, async (recorder) => {
      const input = baseInput({
        fieldCatalog: [
          {
            id: 'systems.flightMode',
            valueType: 'enum',
            sourceType: 'lvar',
            sourceFingerprint: `sha256:${'1'.repeat(64)}`,
            source: 'L:PRIVATE_PATH',
            logicalContract: { type: 'enum', values: { 1: 'LNAV' } },
          },
          { id: 'controls.speedSelected', valueType: 'number' },
          { id: 'systems.autothrottleArmed', valueType: 'boolean' },
          { id: '../privateBinding', valueType: 'number' },
        ],
        values: {
          'controls.speedSelected': 210,
          'systems.autothrottleArmed': false,
          'systems.flightMode': 'LNAV',
          privateVendorPayload: 'L:PRIVATE_PATH',
        },
        sourceStatus: {
          overall: 'connected',
          sources: { lvar: 'connected', 'L:PRIVATE/PATH': 'connected' },
        },
        actionCapabilities: { 'autopilot.disconnect': true },
        rawBinding: { key: 'L:PRIVATE_PATH' },
      });
      assert(recorder.recordAircraftSpecificState(input), 'first state should be accepted');
      const stats = await recorder.close({
        timeMs: 500,
        timestampIso: '2026-07-19T00:00:00.500Z',
        flightElapsedMs: 500,
        endReason: 'test_end',
      });
      const rows = readRows(stats.filePath);
      assert(rows.length === 4, 'expected manifest, config, first checkpoint, and final checkpoint');
      assert(rows.map((row) => row.seq).join(',') === '1,2,3,4', 'sequence should be contiguous');
      assert(rows.every((row) => row.schemaVersion === 2), 'every row should use schema v2');
      assert(rows[0].type === 'aircraft_specific_manifest', 'first row should establish bundle identity');
      assert(rows[1].type === 'aircraft_specific_config', 'second row should declare the config');
      assert(rows[2].reason === 'first_snapshot', 'third row should be the first checkpoint');
      assert(rows[3].reason === 'recording_end', 'last row should be the final checkpoint');
      assert(rows[3].endReason === 'test_end', 'final checkpoint should preserve end reason');
      assert(Object.keys(rows[1].fieldTypes).join(',')
        === 'controls.speedSelected,systems.autothrottleArmed,systems.flightMode',
      'field types should be sorted and invalid IDs removed');
      assert(rows[1].fieldTypes['controls.speedSelected'] === 'number'
        && rows[1].fieldTypes['systems.autothrottleArmed'] === 'boolean'
        && rows[1].fieldTypes['systems.flightMode'] === 'enum',
      'config should retain only the logical value type needed for replay');
      assert(rows.slice(1).every((row) => row.configId === 1),
        'the initial config and its checkpoints should share a compact config ID');
      const serialized = JSON.stringify(rows);
      assert(!serialized.includes('PRIVATE_PATH'), 'raw binding paths must not be persisted');
      assert(!serialized.includes('actionCapabilities'), 'control capabilities must not be persisted');
      assert(!serialized.includes('privateVendorPayload'), 'values outside the logical catalog must be dropped');
      assert(!serialized.includes('Fingerprint') && !serialized.includes('sha256:'),
        'aircraft-specific rows must not persist per-field or config fingerprints');
      assert(rows.slice(2).every((row) => (
        row.flightId === undefined
        && row.timeMs === undefined
        && row.timestampIso === undefined
        && row.profileKey === undefined
      )), 'state rows should not repeat manifest or config metadata');
    });
  });

  await test('coalesces numeric changes without advancing their persisted baseline', async () => {
    await withRecorder('numeric', { numericIntervalMs: 1000 }, async (recorder) => {
      assert(recorder.recordAircraftSpecificState(baseInput()), 'first snapshot should write');
      assert(recorder.recordAircraftSpecificState(baseInput({
        timeMs: 100,
        values: {
          'controls.speedSelected': 220,
          'systems.autothrottleArmed': false,
          'systems.flightMode': 'LNAV',
        },
      })), 'suppressed numeric change should be accepted');
      assert(recorder.recordAircraftSpecificState(baseInput({
        timeMs: 200,
        values: {
          'controls.speedSelected': 230,
          'systems.autothrottleArmed': true,
          'systems.flightMode': 'LNAV',
        },
      })), 'boolean change should write immediately');
      assert(recorder.recordAircraftSpecificState(baseInput({
        timeMs: 1000,
        values: {
          'controls.speedSelected': 250,
          'systems.autothrottleArmed': true,
          'systems.flightMode': 'LNAV',
        },
      })), 'latest numeric value should write when its interval expires');
      assert(recorder.recordAircraftSpecificState(baseInput({
        timeMs: 1100,
        values: {
          'controls.speedSelected': 260,
          'systems.autothrottleArmed': true,
          'systems.flightMode': 'LNAV',
        },
      })), 'next numeric value should remain pending');

      const stats = await recorder.close({
        timeMs: 1200,
        timestampIso: '2026-07-19T00:00:01.200Z',
        flightElapsedMs: 1200,
        endReason: 'test_end',
      });
      const rows = readRows(stats.filePath);
      const deltas = rows.filter((row) => row.type === 'aircraft_specific_delta');
      assert(deltas.length === 2, 'expected one immediate and one coalesced delta');
      assert(deltas[0].valuesSet['systems.autothrottleArmed'] === true, 'boolean change should be immediate');
      assert(!Object.prototype.hasOwnProperty.call(deltas[0].valuesSet, 'controls.speedSelected'),
        'pending number must not hitchhike on an immediate boolean delta');
      assert(deltas[1].valuesSet['controls.speedSelected'] === 250, 'coalesced delta should store latest due number');
      const final = rows.at(-1);
      assert(final.values['controls.speedSelected'] === 260, 'final checkpoint must preserve the latest pending number');
    });
  });

  await test('writes number-valued enum transitions immediately', async () => {
    await withRecorder('numeric-enum', { numericIntervalMs: 1000 }, async (recorder) => {
      const fieldCatalog = [{
        id: 'systems.detent',
        valueType: 'enum',
        sourceType: 'simvar',
        logicalContract: { type: 'enum', values: { 0: 0, 1: 1 } },
      }];
      assert(recorder.recordAircraftSpecificState(baseInput({
        fieldCatalog,
        values: { 'systems.detent': 0 },
      })), 'initial numeric enum should write');
      assert(recorder.recordAircraftSpecificState(baseInput({
        timeMs: 100,
        fieldCatalog,
        values: { 'systems.detent': 1 },
      })), 'numeric enum transition should write immediately');

      const stats = await recorder.close({ timeMs: 200, endReason: 'test_end' });
      const deltas = readRows(stats.filePath).filter((row) => row.type === 'aircraft_specific_delta');
      assert(deltas.length === 1, 'numeric enum should not be suppressed by continuous-number cadence');
      assert(deltas[0].valuesSet['systems.detent'] === 1, 'numeric enum delta should preserve its decoded value');
    });
  });

  await test('records removals, unavailable transitions, sources, and global availability immediately', async () => {
    await withRecorder('availability', {}, async (recorder) => {
      assert(recorder.recordAircraftSpecificState(baseInput()), 'first snapshot should write');
      assert(recorder.recordAircraftSpecificState(baseInput({
        timeMs: 100,
        flightElapsedMs: null,
        flightStartIso: null,
        aircraftTitle: null,
        values: { 'systems.autothrottleArmed': false },
        unavailable: ['controls.speedSelected', 'systems.flightMode'],
        sourceStatus: {
          overall: 'stale',
          sources: { lvar: 'stale', sdk: 'disconnected' },
        },
      })), 'partial unavailability should write');
      assert(recorder.recordAircraftSpecificState(baseInput({
        timeMs: 200,
        values: {},
        unavailable: ['controls.speedSelected', 'systems.autothrottleArmed', 'systems.flightMode'],
        sourceStatus: { overall: 'disconnected', sources: {} },
      })), 'complete unavailability should write');

      const stats = await recorder.close({ timeMs: 300, endReason: 'test_end' });
      const deltas = readRows(stats.filePath).filter((row) => row.type === 'aircraft_specific_delta');
      assert(deltas.length === 2, 'expected both availability deltas');
      assert(deltas[0].valuesRemoved.join(',') === 'controls.speedSelected,systems.flightMode',
        'first delta should explicitly remove missing values');
      assert(deltas[0].unavailableAdded.join(',') === 'controls.speedSelected,systems.flightMode',
        'first delta should explicitly add unavailable fields');
      assert(deltas[0].sourceStatusChanged.overall === 'stale', 'source overall status should change');
      assert(deltas[0].sourceStatusChanged.sourcesSet.sdk === 'disconnected', 'new source should be explicit');
      assert(deltas[0].flightElapsedMs === 100, 'missing end-tick elapsed time should be reconstructed from flight start');
      assert(deltas[0].aircraftTitle === undefined,
        'delta rows should not repeat stable aircraft metadata');
      assert(deltas[1].availableChanged === false, 'global availability becoming false should be explicit');
      assert(deltas[1].sourceStatusChanged.sourcesRemoved.join(',') === 'lvar,sdk',
        'removed sources should be explicit');
    });
  });

  await test('writes heartbeat and profile-revision checkpoints', async () => {
    await withRecorder('checkpoints', { checkpointIntervalMs: 1000 }, async (recorder) => {
      assert(recorder.recordAircraftSpecificState(baseInput()), 'first snapshot should write');
      assert(recorder.recordAircraftSpecificState(baseInput({ timeMs: 1000 })), 'heartbeat should write');
      assert(recorder.recordAircraftSpecificState(baseInput({ timeMs: 1100, profileRevision: 5 })),
        'profile revision change should write config and checkpoint');

      const stats = await recorder.close({ timeMs: 1200, endReason: 'test_end' });
      const rows = readRows(stats.filePath);
      assert(rows.some((row) => row.type === 'aircraft_specific_checkpoint' && row.reason === 'heartbeat'),
        'heartbeat checkpoint should exist');
      const profileRows = rows.filter((row) => row.reason === 'profile_change');
      assert(profileRows.length === 2, 'profile revision should produce config plus full checkpoint');
      assert(profileRows.every((row) => row.configId === 2),
        'profile change rows should reference the next sequential config ID');
      assert(profileRows.find((row) => row.type === 'aircraft_specific_config')?.profileRevision === 5,
        'the profile change config should carry the new revision');
      assert(profileRows.find((row) => row.type === 'aircraft_specific_checkpoint')?.profileRevision === undefined,
        'the matching checkpoint should not repeat config metadata');
    });
  });

  await test('closes the old config with its latest pending value before a profile change', async () => {
    await withRecorder('profile-boundary', { numericIntervalMs: 1000 }, async (recorder) => {
      assert(recorder.recordAircraftSpecificState(baseInput()), 'profile A should write');
      assert(recorder.recordAircraftSpecificState(baseInput({
        timeMs: 100,
        values: {
          'controls.speedSelected': 245,
          'systems.autothrottleArmed': false,
          'systems.flightMode': 'LNAV',
        },
      })), 'profile A pending numeric state should be retained');
      assert(recorder.recordAircraftSpecificState(baseInput({
        timeMs: 200,
        profileKey: 'bundled/msfs/microsoft-atr-72-600',
        profileRevision: 5,
        integrationId: 'microsoft-atr-72-600',
        templateId: 'microsoft-atr-72-600',
        values: {
          'controls.speedSelected': 180,
          'systems.autothrottleArmed': true,
          'systems.flightMode': 'IAS',
        },
      })), 'profile B should write');

      const stats = await recorder.close({ timeMs: 300, endReason: 'test_end' });
      const rows = readRows(stats.filePath);
      const boundaryIndex = rows.findIndex((row) => row.reason === 'profile_change_end');
      const nextConfigIndex = rows.findIndex((row) => (
        row.type === 'aircraft_specific_config'
        && row.profileKey === 'bundled/msfs/microsoft-atr-72-600'
      ));
      assert(boundaryIndex > 0 && boundaryIndex < nextConfigIndex,
        'old checkpoint must precede the new profile config');
      assert(rows[boundaryIndex].values['controls.speedSelected'] === 245,
        'old boundary checkpoint must flush the latest pending numeric value');
      assert(rows[boundaryIndex].nextProfileKey === 'bundled/msfs/microsoft-atr-72-600',
        'old boundary should identify the incoming profile');
    });
  });

  await test('records pre-state route metadata without renaming the bundle', async () => {
    await withRecorder('manifest-route', {}, async (recorder) => {
      const originalPath = recorder.filePath;
      assert(await recorder.updateFilename('YSCB', 'YSSY'), 'manifest route update should succeed');
      assert(recorder.filePath === originalPath, 'route metadata must not rename the immutable bundle');
      assert(recorder.filename === 'aircraft-specific.jsonl', 'sidecar filename should remain canonical');
      assert(recorder.recordAircraftSpecificState(baseInput()), 'state should remain writable');
      const stats = await recorder.close({ timeMs: 500, endReason: 'test_end' });
      assert(fs.existsSync(stats.filePath), 'canonical sidecar should exist');
      assert(stats.filePath === originalPath, 'finalization should retain the original path');
    });
  });

  await test('updates route metadata on an open sidecar without splitting row history', async () => {
    await withRecorder('open-route', {}, async (recorder) => {
      assert(recorder.recordAircraftSpecificState(baseInput()), 'first snapshot should write');
      const originalPath = recorder.filePath;
      assert(await recorder.updateFilename(null, 'YSSY'), 'open route update should succeed');
      assert(recorder.filePath === originalPath && fs.existsSync(originalPath), 'open route update must keep the canonical path');
      assert(recorder.recordAircraftSpecificState(baseInput({
        timeMs: 100,
        values: {
          'controls.speedSelected': 210,
          'systems.autothrottleArmed': true,
          'systems.flightMode': 'LNAV',
        },
      })), 'post-rename state should write');
      const stats = await recorder.close({ timeMs: 200, endReason: 'test_end' });
      const rows = readRows(stats.filePath);
      assert(rows.map((row) => row.seq).join(',') === '1,2,3,4,5', 'renamed file should contain contiguous full history');
    });
  });

  await test('refuses a pre-state request to switch bundle identity', async () => {
    await withRecorder('manifest-route-collision', {}, async (recorder) => {
      const originalPath = recorder.filePath;
      assert(await recorder.updateFilename('YSCB', 'YSSY', 'different-bundle') === false,
        'pre-state bundle identity switch should be refused');
      assert(recorder.filePath === originalPath, 'recorder should retain its original planned path');
      assert(recorder.recordAircraftSpecificState(baseInput()), 'recording should continue at the original path');
      const stats = await recorder.close({ timeMs: 100, endReason: 'test_end' });
      assert(stats.filePath === originalPath && fs.existsSync(originalPath),
        'continued recording should finalize at the original path');
    });
  });

  await test('refuses an open bundle identity switch and continues contiguous history', async () => {
    await withRecorder('open-route-collision', {}, async (recorder) => {
      assert(recorder.recordAircraftSpecificState(baseInput()), 'first snapshot should write');
      assert(await recorder.flush(), 'source should flush before the collision');
      const originalPath = recorder.filePath;
      assert(await recorder.updateFilename(null, 'YSSY', 'different-bundle') === false,
        'open bundle identity switch should be refused');
      assert(recorder.recordAircraftSpecificState(baseInput({
        timeMs: 100,
        values: {
          'controls.speedSelected': 210,
          'systems.autothrottleArmed': true,
          'systems.flightMode': 'LNAV',
        },
      })), 'source recording should continue after refused rename');
      const stats = await recorder.close({ timeMs: 200, endReason: 'test_end' });
      assert(stats.filePath === originalPath, 'failed rename should keep the source basename');
      const rows = readRows(originalPath);
      assert(rows.map((row) => row.seq).join(',') === '1,2,3,4,5',
        'source history should remain contiguous through final checkpoint');
    });
  });

  await test('fails startup atomically when the identity manifest exceeds the file cap', async () => {
    const outputDir = makeOutputDir('manifest-cap');
    const recorder = new recorderModule.AircraftSpecificJsonlRecorder({
      flightId: '2026-07-19T00:00:00.000Z',
      outputDir,
      maxFileBytes: 64,
    });
    try {
      assert(!recorder.start(), 'a cap too small for the identity manifest must fail startup');
      await new Promise<void>((resolve) => setImmediate(resolve));
      const stats = await recorder.close({ endReason: 'test_end' });
      assert(stats.captureDisabled === true, 'manifest-cap refusal should disable capture');
      assert(stats.hasError === true, 'file-cap refusal should be visible in stats');
      assert(stats.rowCount === 0, 'a rejected manifest must not advance sequence state');
      assert(fs.readdirSync(outputDir).length === 0, 'file-cap refusal should not leave a partial sidecar');
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  await test('refuses an existing canonical sidecar instead of restarting its sequence in append mode', async () => {
    const outputDir = makeOutputDir('collision');
    const flightId = '2026-07-19T00:00:00.000Z';
    const recorder = new recorderModule.AircraftSpecificJsonlRecorder({ flightId, outputDir });
    const filePath = recorder.filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{"schemaVersion":1,"seq":99}\n');
    try {
      assert(!recorder.start(), 'existing sidecar should make optional recorder startup fail');
      assert(fs.readFileSync(filePath, 'utf8') === '{"schemaVersion":1,"seq":99}\n',
        'collision refusal must preserve the existing history byte-for-byte');
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  await test('does not report a synchronous exclusive-open failure as a saved artifact', async () => {
    const outputDir = makeOutputDir('open-failure');
    const recorder = new recorderModule.AircraftSpecificJsonlRecorder({
      flightId: '2026-07-19T00:00:00.000Z',
      outputDir,
    });
    const originalOpenSync = fs.openSync;
    try {
      (fs as any).openSync = () => {
        throw new Error('simulated synchronous exclusive-open failure');
      };
      assert(!recorder.start(), 'failed exclusive open must reject startup');
      const stats = await recorder.close({ endReason: 'test_end' });
      assert(stats.hasFile === false, 'failed open must not synthesize file existence');
      assert(stats.fileSizeBytes === 0, 'failed open must not report accepted bytes as persisted bytes');
      assert(stats.hasError && stats.captureDisabled, 'exclusive-open failure should disable capture');
    } finally {
      (fs as any).openSync = originalOpenSync;
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  await test('cleans its exclusive claim when identity-manifest durability fails', async () => {
    const outputDir = makeOutputDir('manifest-write-failure');
    const terminalErrors: Error[] = [];
    const recorder = new recorderModule.AircraftSpecificJsonlRecorder({
      flightId: '2026-07-19T00:00:00.000Z',
      outputDir,
      onTerminalError: (error: Error) => terminalErrors.push(error),
    });
    const originalFdatasyncSync = fs.fdatasyncSync;
    try {
      (fs as any).fdatasyncSync = () => {
        throw new Error('simulated manifest durability failure');
      };
      assert(!recorder.start(), 'manifest durability failure must reject startup');
    } finally {
      (fs as any).fdatasyncSync = originalFdatasyncSync;
    }
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const stats = await recorder.close({ endReason: 'test_end' });
      assert(!fs.existsSync(recorder.filePath), 'failed manifest startup must remove its owned claim');
      assert(stats.rowCount === 0 && stats.hasFile === false, 'failed manifest must not report a saved row');
      assert(terminalErrors.length === 1, 'failed manifest startup should report one terminal error');
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  await test('closeSync after a route update cannot reopen or leak a closed recorder stream', async () => {
    await withRecorder('close-during-rename', {}, async (recorder) => {
      assert(recorder.recordAircraftSpecificState(baseInput()), 'first snapshot should write');
      await recorder.flush();
      const originalPath = recorder.filePath;
      const routeUpdate = recorder.updateFilename(null, 'YSSY');
      assert(await routeUpdate === true, 'route metadata update should flush and complete');
      recorder.closeSync();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert(recorder.closed && recorder.stream === null, 'closed recorder must not retain a reopened stream');
      assert(fs.existsSync(originalPath), 'already-written history should remain at the original path');
      assert(recorder.filePath === originalPath, 'route metadata must not create a split destination history');
    });
  });

  await test('compact config identity is stable across input order and tracks replay-visible changes', async () => {
    const first = recorderModule.buildSnapshot(baseInput({
      profileRevision: 1,
      fieldCatalog: [
        { id: 'systems.flightMode', valueType: 'enum' },
        { id: 'controls.speedSelected', valueType: 'number' },
      ],
    }), 'flight');
    const second = recorderModule.buildSnapshot(baseInput({
      profileRevision: 1,
      fieldCatalog: [
        { id: 'controls.speedSelected', valueType: 'number' },
        { id: 'systems.flightMode', valueType: 'enum' },
      ],
    }), 'flight');
    assert(first && second, 'both snapshots should be valid');
    assert(first.configSignature === second.configSignature,
      'field input order must not affect compact config identity');

    const revised = recorderModule.buildSnapshot(baseInput({
      profileRevision: 2,
      fieldCatalog: [{
        id: 'controls.speedSelected',
        valueType: 'number',
      }],
    }), 'flight');
    const retyped = recorderModule.buildSnapshot(baseInput({
      profileRevision: 1,
      fieldCatalog: [{
        id: 'controls.speedSelected',
        valueType: 'enum',
      }],
    }), 'flight');
    const ignoredProvenance = recorderModule.buildSnapshot(baseInput({
      profileRevision: 1,
      fieldCatalog: [{
        id: 'controls.speedSelected',
        valueType: 'number',
        sourceType: 'sdk',
        sourceFingerprint: `sha256:${'a'.repeat(64)}`,
        logicalContract: { type: 'number', precision: 6 },
      }],
    }), 'flight');
    assert(revised && revised.configSignature !== first.configSignature,
      'profile revision changes should install a new config');
    assert(retyped && retyped.configSignature !== first.configSignature,
      'field type changes should install a new config');
    assert(ignoredProvenance && ignoredProvenance.configSignature === recorderModule.buildSnapshot(baseInput({
      profileRevision: 1,
      fieldCatalog: [{ id: 'controls.speedSelected', valueType: 'number' }],
    }), 'flight')?.configSignature,
    'source and decoder provenance should not participate in the compact recording schema');
  });

  await test('singleton lifecycle preserves a manifest-only generic-flight sidecar', async () => {
    const outputDir = makeOutputDir('singleton');
    try {
      const recorder = recorderModule.startFlight({
        flightId: '2026-07-19T01:00:00.000Z',
        outputDir,
      });
      assert(recorder, 'singleton should arm');
      assert(recorderModule.isRecording(), 'singleton should report armed recording');
      assert(!recorderModule.recordAircraftSpecificState(baseInput({ fieldCatalog: [] })),
        'unsupported state should not record');
      const stats = await recorderModule.endFlight({ endReason: 'generic' });
      assert(stats?.rowCount === 1 && stats.hasFile, 'generic singleton should return its identity manifest artifact');
      assert(!recorderModule.isRecording(), 'singleton should clear after end');
      assert(fs.readdirSync(outputDir).length === 1, 'generic flight should retain exactly one manifest sidecar');
    } finally {
      if (recorderModule.isRecording()) await recorderModule.endFlight({ endReason: 'test_cleanup' });
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  await test('singleton refuses a replacement until the raw finalization settles', async () => {
    const outputDir = makeOutputDir('singleton-finalizing');
    let releaseClose: (() => void) | null = null;
    try {
      const recorder = recorderModule.startFlight({
        flightId: '2026-07-19T02:00:00.000Z',
        outputDir,
      });
      assert(recorder, 'singleton should arm');
      assert(recorderModule.recordAircraftSpecificState(baseInput()), 'singleton should record a state');
      const originalClose = recorder.close.bind(recorder);
      const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
      recorder.close = async (endContext: Record<string, any>) => {
        await closeGate;
        return await originalClose(endContext);
      };

      const finalization = recorderModule.endFlight({ timeMs: 100, endReason: 'test_end' });
      await Promise.resolve();
      assert(recorderModule.isFinalizing(), 'singleton should expose raw finalization ownership');
      assert(recorderModule.startFlight({
        flightId: '2026-07-19T02:01:00.000Z',
        outputDir,
      }) === null, 'replacement must be refused while close is pending');

      releaseClose?.();
      const stats = await finalization;
      assert(stats?.hasFile === true, 'original finalization should complete normally');
      assert(!recorderModule.isFinalizing(), 'finalization ownership should clear only after close settles');
    } finally {
      releaseClose?.();
      if (recorderModule.isRecording() || recorderModule.isFinalizing()) {
        await recorderModule.endFlight({ endReason: 'test_cleanup' });
      }
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  console.log(`\nAircraft-Specific JSONL Recorder: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

export {};
