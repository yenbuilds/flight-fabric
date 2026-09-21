import { test } from 'node:test';
import assert from 'node:assert/strict';
const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');
const evidence = require('./control-evidence') as typeof import('./control-evidence');
const controlService = require('./aircraft-control-service') as { executeAircraftControl: (provider: any, request: any, options?: any) => Promise<any> };

const readLines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)) : []);
const FILE_CAP = 5 * 1024 * 1024;
const QUEUE_CAP = 256 * 1024;
const enabled = { FF_CONTROL_EVIDENCE: '1' } as NodeJS.ProcessEnv;

async function withEvidenceDirectory(run: (dir: string, file: string) => Promise<void>): Promise<void> {
  await evidence.flushControlEvidenceForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-evidence-cap-'));
  evidence.setControlEvidenceDirectoryForTests(dir);
  try {
    await run(dir, evidence.getControlEvidenceFilePath());
  } finally {
    await evidence.flushControlEvidenceForTests();
    evidence.setControlEvidenceDirectoryForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('control evidence keeps only bounded, non-sensitive fields from a result', () => {
  const entry = evidence.buildControlEvidence({
    ok: true, code: 'executed', integrationId: 'pmdg-737', routeId: 'pmdg737.gear.parkingBrake.set.sdk', transportMode: 'sdk', confirmedValue: true,
    backendSource: 'rust', request: { control: 'aircraft-specific', actionId: 'gear.parkingBrake.set', value: 1, secretLookingField: 'x' },
  }, { profileKey: 'bundled/msfs/pmdg-737', profileRevision: 3, simulator: 'msfs', resolvedBy: 'integration', request: { control: 'aircraft-specific', actionId: 'gear.parkingBrake.set' }, action: { type: 'aircraft-integration' } },
  { elapsedMs: 184.6, aircraftTitle: 'PMDG 737-800' });
  assert.equal(entry.aircraft, 'PMDG 737-800');
  assert.equal(entry.profile, 'bundled/msfs/pmdg-737');
  assert.equal(entry.action, 'gear.parkingBrake.set');
  assert.equal(entry.actionType, 'aircraft-integration');
  assert.equal(entry.transport, 'sdk');
  assert.equal(entry.confirmed, true);
  assert.equal(entry.elapsedMs, 185);
  assert.equal(entry.ok, true);
  assert.ok(!('error' in entry), 'no error field on success');
  assert.ok(!('secretLookingField' in entry) && !('backendSource' in entry), 'unknown result fields are not copied');
  assert.match(entry.t, /^\d{4}-\d{2}-\d{2}T/);
  const failed = evidence.buildControlEvidence({ ok: false, code: 'aircraft_integration_readback_timeout', error: 'x'.repeat(1000), observedValue: false, expectedValue: true, readbackAdvanced: true }, { request: { target: 'lights.beacon.on' } });
  assert.equal(failed.ok, false);
  assert.equal(failed.action, 'lights.beacon.on');
  assert.equal(failed.error.length, 301, 'error text is bounded');
  assert.equal(failed.observed, false); assert.equal(failed.expected, true); assert.equal(failed.readbackAdvanced, true);
  const nested = evidence.buildControlEvidence({ ok: true, confirmedValue: { deep: { object: 1 } } }, { request: {} });
  assert.ok(!('confirmed' in nested), 'objects are not serialised as values');
});

test('control evidence appends asynchronously, rotates at the cap, can be disabled, and never throws', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-evidence-'));
  evidence.setControlEvidenceDirectoryForTests(dir);
  try {
    const file = evidence.getControlEvidenceFilePath();
    assert.equal(path.dirname(file), dir);
    evidence.recordControlEvidence({ t: 'a', ok: true });
    evidence.recordControlEvidence({ t: 'b', ok: false });
    await evidence.flushControlEvidenceForTests();
    assert.deepEqual(readLines(file).map(e => e.t), ['a', 'b']);
    evidence.recordControlEvidence({ t: 'c' }, { FF_CONTROL_EVIDENCE: '0' } as any);
    await evidence.flushControlEvidenceForTests();
    assert.equal(readLines(file).length, 2, 'disabled by FF_CONTROL_EVIDENCE=0');
    fs.writeFileSync(file, 'x'.repeat(5 * 1024 * 1024 + 1));
    evidence.recordControlEvidence({ t: 'd' });
    await evidence.flushControlEvidenceForTests();
    assert.deepEqual(readLines(file).map(e => e.t), ['d'], 'rotated to a fresh file');
    assert.ok(fs.existsSync(path.join(dir, 'control-evidence.1.jsonl')), 'previous file kept once');
    const circular: any = { t: 'e' }; circular.self = circular;
    assert.doesNotThrow(() => evidence.recordControlEvidence(circular));
    evidence.setControlEvidenceDirectoryForTests(path.join(dir, 'unwritable\0dir'));
    assert.doesNotThrow(() => evidence.recordControlEvidence({ t: 'f' }));
    await evidence.flushControlEvidenceForTests();
  } finally { evidence.setControlEvidenceDirectoryForTests(null); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('executeAircraftControl records evidence for executed commands and for provider errors, without changing its result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-evidence-hook-'));
  evidence.setControlEvidenceDirectoryForTests(dir);
  try {
    const profile = { id: 'generic', simulator: 'msfs', namespace: 'bundled', _profileKey: 'bundled/msfs/generic', integration: { controls: { genericFallback: true } } };
    let boomNext = false;
    const provider = {
      aircraftControlCapabilities: { actionTypes: ['key-event'] },
      executeAircraftControlAction: async () => (boomNext ? Promise.reject(new Error('bridge gone')) : { ok: true, code: 'executed', transportAcknowledged: true }),
    };
    const options = { profile, profileRevision: 3, requireProfileToken: true };
    const ok = await controlService.executeAircraftControl(provider, { control: 'gear', operation: 'down', profileKey: 'bundled/msfs/generic', profileRevision: 3 }, options);
    boomNext = true;
    const boom = await controlService.executeAircraftControl(provider, { control: 'gear', operation: 'up', profileKey: 'bundled/msfs/generic', profileRevision: 3 }, options);
    await evidence.flushControlEvidenceForTests();
    const lines = readLines(evidence.getControlEvidenceFilePath());
    assert.equal(ok.ok, true, ok.error);
    assert.equal(boom.code, 'provider_error');
    assert.equal(lines.length, 2);
    assert.equal(lines[0].ok, true); assert.equal(lines[0].actionType, 'key-event'); assert.equal(lines[0].control, 'gear'); assert.equal(lines[0].profile, 'bundled/msfs/generic'); assert.ok(Number.isInteger(lines[0].elapsedMs)); assert.equal(lines[0].acknowledged, true);
    assert.equal(lines[1].ok, false); assert.equal(lines[1].code, 'provider_error'); assert.match(lines[1].error, /bridge gone/);
    assert.ok(lines.every(l => !('request' in l) && !('backendSource' in l)), 'only the evidence fields');
  } finally { evidence.setControlEvidenceDirectoryForTests(null); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('control evidence never appends after repeated EACCES rotation failures and recovers when unlocked', async (t) => {
  await withEvidenceDirectory(async (dir, file) => {
    fs.writeFileSync(file, Buffer.alloc(FILE_CAP, 32));
    const backup = path.join(dir, 'control-evidence.1.jsonl');
    fs.writeFileSync(backup, 'previous archive');
    const originalRename = fs.promises.rename;
    let locked = true, attempts = 0;
    t.mock.method(fs.promises, 'rename', async (...args: Parameters<typeof fs.promises.rename>) => {
      attempts++;
      if (locked) throw Object.assign(new Error('fixture: archive locked'), { code: 'EACCES' });
      return originalRename(...args);
    });
    for (let batch = 0; batch < 3; batch++) {
      assert.doesNotThrow(() => evidence.recordControlEvidence({ batch }, enabled));
      await evidence.flushControlEvidenceForTests();
      assert.equal(fs.statSync(file).size, FILE_CAP);
      assert.equal(fs.readFileSync(backup, 'utf8'), 'previous archive');
    }
    assert.equal(attempts, 3);
    locked = false;
    evidence.recordControlEvidence({ recovered: true }, enabled);
    await evidence.flushControlEvidenceForTests();
    assert.deepEqual(readLines(file), [{ recovered: true }]);
    assert.equal(fs.statSync(backup).size, FILE_CAP, 'normal rotation replaces only the previous evidence archive');
  });
});

test('control evidence drops batches when stat fails for reasons other than ENOENT', async (t) => {
  await withEvidenceDirectory(async (_dir, file) => {
    fs.writeFileSync(file, 'original data\n');
    const originalStat = fs.promises.stat;
    let failed = true;
    t.mock.method(fs.promises, 'stat', async (...args: Parameters<typeof fs.promises.stat>) => {
      if (failed) throw Object.assign(new Error('fixture: stat denied'), { code: 'EACCES' });
      return originalStat(...args);
    });
    for (let batch = 0; batch < 3; batch++) {
      evidence.recordControlEvidence({ batch }, enabled);
      await evidence.flushControlEvidenceForTests();
    }
    assert.equal(fs.readFileSync(file, 'utf8'), 'original data\n');
    fs.unlinkSync(file);
    evidence.recordControlEvidence({ deniedMissingFile: true }, enabled);
    await evidence.flushControlEvidenceForTests();
    assert.equal(fs.existsSync(file), false, 'an arbitrary stat failure cannot be treated as a missing file');
    failed = false;
    evidence.recordControlEvidence({ createdAfterEnoent: true }, enabled);
    await evidence.flushControlEvidenceForTests();
    assert.deepEqual(readLines(file), [{ createdAfterEnoent: true }]);
  });
});

test('control evidence checks incoming UTF-8 bytes before appending or rotating', async () => {
  for (const value of ['ordinary evidence', '🛫'.repeat(3000)]) {
    await withEvidenceDirectory(async (dir, file) => {
      const entry = { value };
      const line = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8');
      fs.writeFileSync(file, Buffer.alloc(FILE_CAP - line.length, 32));
      evidence.recordControlEvidence(entry, enabled);
      await evidence.flushControlEvidenceForTests();
      assert.equal(fs.statSync(file).size, FILE_CAP, 'a batch fitting exactly does not exceed the cap');
      const backup = path.join(dir, 'control-evidence.1.jsonl');
      assert.equal(fs.existsSync(backup), false, 'an exactly fitting batch does not rotate early');
      fs.writeFileSync(file, Buffer.alloc(FILE_CAP - line.length + 1, 32));
      evidence.recordControlEvidence(entry, enabled);
      await evidence.flushControlEvidenceForTests();
      assert.equal(fs.statSync(backup).size, FILE_CAP - line.length + 1);
      assert.deepEqual(fs.readFileSync(file), line, 'a crossing batch goes wholly into the new file');
      assert.ok(fs.statSync(file).size <= FILE_CAP);
    });
  }
});

test('control evidence drops oversized, escaped, multibyte, deep and circular rows without affecting valid entries', async () => {
  await withEvidenceDirectory(async (_dir, file) => {
    const circular: any = {}; circular.self = circular;
    let deep: any = {};
    for (let index = 0; index < 1000; index++) deep = { nested: deep };
    for (const entry of [
      { value: 'x'.repeat(64 * 1024) },
      { value: '🛫'.repeat(9000) },
      { value: '\0'.repeat(10000) },
      { confirmed: Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`key${index}`, index])) },
      circular, deep,
    ]) assert.doesNotThrow(() => evidence.recordControlEvidence(entry, enabled));
    evidence.recordControlEvidence({ valid: true, value: '🛫'.repeat(3000) }, enabled);
    await evidence.flushControlEvidenceForTests();
    const lines = readLines(file);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].valid, true);
    assert.equal(lines[0].value, '🛫'.repeat(3000));
    assert.ok(fs.statSync(file).size <= 32 * 1024);
  });
});

test('control evidence bounds queued bytes while disk I/O stalls and retains recent rows', async (t) => {
  await withEvidenceDirectory(async (_dir, file) => {
    let release!: () => void;
    const stalled = new Promise<void>(resolve => { release = resolve; });
    const originalMkdir = fs.promises.mkdir;
    const originalAppend = fs.promises.appendFile;
    const appendBytes: number[] = [];
    t.mock.method(fs.promises, 'mkdir', async (...args: Parameters<typeof fs.promises.mkdir>) => {
      await stalled;
      return originalMkdir(...args);
    });
    t.mock.method(fs.promises, 'appendFile', async (...args: Parameters<typeof fs.promises.appendFile>) => {
      appendBytes.push(Buffer.byteLength(args[1] as Buffer));
      return originalAppend(...args);
    });
    const first = { first: true };
    evidence.recordControlEvidence(first, enabled);
    try {
      for (let index = 0; index < 1000; index++) {
        evidence.recordControlEvidence({ index, value: '🛫'.repeat(3000) }, enabled);
      }
    } finally { release(); }
    await evidence.flushControlEvidenceForTests();
    const lines = readLines(file);
    assert.equal(lines[0].first, true);
    assert.equal(lines.at(-1).index, 999);
    assert.ok(!lines.some(line => line.index === 0), 'old queued rows are discarded rather than growing memory');
    assert.ok(appendBytes.every(size => size <= QUEUE_CAP));
    assert.ok(fs.statSync(file).size <= QUEUE_CAP + Buffer.byteLength(`${JSON.stringify(first)}\n`, 'utf8'));
  });
});
