'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const test = require('node:test') as typeof import('node:test');

const { FlightCSVWriter } = require('./flight-csv-writer') as { FlightCSVWriter: new (_options: any) => any };
const { AutomationJsonlRecorder } = require('./automation-jsonl-recorder') as {
  AutomationJsonlRecorder: new (_options: any) => any;
};
const { AircraftSpecificJsonlRecorder } = require('./aircraft-specific-jsonl-recorder') as {
  AircraftSpecificJsonlRecorder: new (_options: any) => any;
};
const { getBundlePaths } = require('./recording-bundle-layout') as {
  getBundlePaths: (_outputDir: string, _bundleName: string) => any;
};
const {
  getBundleStatusPath,
  publishRecordingBundleStatus,
  readRecordingBundleStatusSync,
  inspectRecordingBundleStatusSync,
  inspectCsvBundleForCatalogSync,
  _hashArtifact,
} = require('./recording-bundle-status') as {
  getBundleStatusPath: (_outputDir: string, _baseName: string) => string;
  publishRecordingBundleStatus: (_options: any) => Promise<any>;
  readRecordingBundleStatusSync: (_csvPath: string, _options?: any) => any;
  inspectRecordingBundleStatusSync: (_csvPath: string, _identity: any) => any;
  inspectCsvBundleForCatalogSync: (_csvPath: string) => any;
  _hashArtifact: (_filePath: string, _role: string, _identity?: any) => Promise<any>;
};

const START_MS = Date.parse('2026-07-20T00:00:00.000Z');

function makeIdentity(suffix: string) {
  return {
    flightId: `status-flight-${suffix}`,
    recordingSessionId: `status-session-${suffix}`,
    recordingStartEpochMs: START_MS,
    recordingStartIso: new Date(START_MS).toISOString(),
  };
}

async function makeClosedBundle(
  outputDir: string,
  baseName: string,
  suffix: string,
  bundleStatusRequired = true,
) {
  const identity = makeIdentity(suffix);
  const options = {
    ...identity,
    bundleBaseName: baseName,
    bundleStatusRequired,
    outputDir,
    writerMode: 'inline',
  };
  const csv = new FlightCSVWriter(options);
  const automation = new AutomationJsonlRecorder(options);
  const aircraftSpecific = new AircraftSpecificJsonlRecorder(options);
  assert.equal(csv.start(), true);
  assert.equal(automation.start(), true);
  assert.equal(aircraftSpecific.start(), true);
  assert.equal(automation.recordAutopilotState({ timeMs: START_MS + 500 }), true);
  await Promise.all([csv.close(), automation.close(), aircraftSpecific.close()]);
  return {
    identity,
    paths: getBundlePaths(outputDir, baseName),
  };
}

async function artifactObservations(bundle: Awaited<ReturnType<typeof makeClosedBundle>>) {
  return {
    csv: await _hashArtifact(bundle.paths.csv, 'csv', bundle.identity),
    automation: await _hashArtifact(bundle.paths.automation, 'automation', bundle.identity),
    aircraftSpecific: await _hashArtifact(
      bundle.paths.aircraftSpecific,
      'aircraftSpecific',
      bundle.identity,
    ),
  };
}

function publishOptions(outputDir: string, baseName: string, identity: any, overrides: any = {}) {
  return {
    ...identity,
    outputDir,
    bundleBaseName: baseName,
    status: 'complete',
    finalizedAtEpochMs: START_MS + 1_000,
    finalizedAtIso: new Date(START_MS + 1_000).toISOString(),
    endReason: 'test_end',
    ...overrides,
  };
}

test('complete status certifies exact closed bytes and is published no-replace', async (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bundle-status-complete-'));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const bundle = await makeClosedBundle(outputDir, 'complete', 'complete');
  await publishRecordingBundleStatus(publishOptions(outputDir, 'complete', bundle.identity));

  const verified = readRecordingBundleStatusSync(bundle.paths.csv, {
    expectedIdentity: bundle.identity,
    artifacts: await artifactObservations(bundle),
  });
  assert.equal(verified.state, 'complete');
  assert.equal(verified.healthy, true);
  assert.equal(verified.certificate.artifacts.csv.sizeBytes, fs.statSync(bundle.paths.csv).size);

  await assert.rejects(
    publishRecordingBundleStatus(publishOptions(outputDir, 'complete', bundle.identity)),
    (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
  );
});

test('invalid publication state cannot create a permanent certificate', async (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bundle-status-invalid-'));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const bundle = await makeClosedBundle(outputDir, 'invalid', 'invalid');
  await assert.rejects(
    publishRecordingBundleStatus(publishOptions(outputDir, 'invalid', bundle.identity, {
      status: 'typo',
    })),
    /publication state is invalid/i,
  );
  assert.equal(fs.existsSync(getBundleStatusPath(outputDir, 'invalid')), false);
});

test('missing/torn status and changed member bytes fail closed', async (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bundle-status-crash-'));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const bundle = await makeClosedBundle(outputDir, 'crash', 'crash');
  const statusPath = getBundleStatusPath(outputDir, 'crash');
  fs.writeFileSync(`${statusPath}.tmp-crash-prefix`, '{"partial":', 'utf8');
  const missing = readRecordingBundleStatusSync(bundle.paths.csv);
  assert.equal(missing.state, 'incomplete');
  assert.equal(missing.exists, false);

  fs.writeFileSync(statusPath, '{"partial":', 'utf8');
  const torn = readRecordingBundleStatusSync(bundle.paths.csv);
  assert.equal(torn.state, 'corrupt');
  fs.unlinkSync(statusPath);

  await publishRecordingBundleStatus(publishOptions(outputDir, 'crash', bundle.identity));
  const originalAutomation = fs.readFileSync(bundle.paths.automation, 'utf8');
  const changedAutomation = originalAutomation.replace('first_snapshot', 'first_snapshou');
  assert.notEqual(changedAutomation, originalAutomation);
  assert.equal(Buffer.byteLength(changedAutomation), Buffer.byteLength(originalAutomation));
  fs.writeFileSync(bundle.paths.automation, changedAutomation, 'utf8');
  const quick = inspectRecordingBundleStatusSync(bundle.paths.csv, bundle.identity);
  assert.equal(quick.state, 'corrupt');
  assert.match(quick.error, /automation member/i);
  const full = readRecordingBundleStatusSync(bundle.paths.csv, {
    expectedIdentity: bundle.identity,
    artifacts: await artifactObservations(bundle),
  });
  assert.equal(full.state, 'corrupt');
  assert.match(full.error, /bytes do not match/i);
});

test('catalog inspection tolerates metadata-only ctime drift on certified members', async (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bundle-status-ctime-'));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const bundle = await makeClosedBundle(outputDir, 'ctime', 'ctime');
  await publishRecordingBundleStatus(publishOptions(outputDir, 'ctime', bundle.identity));
  const before = inspectCsvBundleForCatalogSync(bundle.paths.csv);
  assert.equal(before.allowed, true);
  assert.equal(before.state, 'complete');

  const originalLstatSync = fs.lstatSync;
  try {
    (fs as any).lstatSync = (target: import('fs').PathLike, ...args: any[]) => {
      const stat = (originalLstatSync as any).call(fs, target, ...args);
      if (path.resolve(String(target)) !== path.resolve(bundle.paths.automation)) return stat;
      return new Proxy(stat, {
        get(source, property) {
          if (property === 'ctimeMs') return source.ctimeMs + 60_000;
          const value = Reflect.get(source, property);
          return typeof value === 'function' ? value.bind(source) : value;
        },
      });
    };

    const after = inspectCsvBundleForCatalogSync(bundle.paths.csv);
    assert.equal(after.allowed, true);
    assert.equal(after.state, 'complete');
    assert.equal(after.catalogRevision, before.catalogRevision);
    assert.equal(after.bundleSizeBytes, before.bundleSizeBytes);
  } finally {
    (fs as any).lstatSync = originalLstatSync;
  }
});

test('known member failure publishes explicit degraded status without leaking paths', async (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bundle-status-degraded-'));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const bundle = await makeClosedBundle(outputDir, 'degraded', 'degraded');
  fs.unlinkSync(bundle.paths.aircraftSpecific);
  const localPathError = Object.assign(new Error(`write failed at ${outputDir}\\secret.jsonl`), { code: 'EIO' });
  await publishRecordingBundleStatus(publishOptions(outputDir, 'degraded', bundle.identity, {
    status: 'degraded',
    degradedReason: localPathError,
  }));

  const result = readRecordingBundleStatusSync(bundle.paths.csv, {
    expectedIdentity: bundle.identity,
    artifacts: {} as any,
  });
  assert.equal(result.state, 'degraded');
  assert.equal(result.healthy, false);
  assert.equal(result.certificate.artifacts.aircraftSpecific.state, 'missing');
  assert.match(result.certificate.degradedReason, /EIO/);
  assert.doesNotMatch(result.certificate.degradedReason, /secret|ff-bundle-status-degraded/i);

  const statusPath = getBundleStatusPath(outputDir, 'degraded');
  const malformed = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  malformed.artifacts.aircraftSpecific.sizeBytes = 1;
  fs.writeFileSync(statusPath, `${JSON.stringify(malformed)}\n`, 'utf8');
  const malformedResult = readRecordingBundleStatusSync(bundle.paths.csv);
  assert.equal(malformedResult.state, 'corrupt');
  assert.match(malformedResult.error, /failure observation is invalid/i);
});

test('filesystem failures returned to clients never disclose local paths', async (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bundle-status-private-'));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const bundle = await makeClosedBundle(outputDir, 'private', 'private');
  await publishRecordingBundleStatus(publishOptions(outputDir, 'private', bundle.identity));
  const statusPath = getBundleStatusPath(outputDir, 'private');
  const originalLstatSync = fs.lstatSync;

  try {
    (fs as any).lstatSync = (target: import('fs').PathLike, ...args: any[]) => {
      if (path.resolve(String(target)) === path.resolve(statusPath)) {
        throw Object.assign(new Error(`EACCES: permission denied, lstat '${statusPath}'`), { code: 'EACCES' });
      }
      return (originalLstatSync as any).call(fs, target, ...args);
    };
    const statusRead = readRecordingBundleStatusSync(bundle.paths.csv);
    assert.equal(statusRead.state, 'corrupt');
    assert.match(statusRead.error, /EACCES/);
    assert.doesNotMatch(statusRead.error, /ff-bundle-status-private|bundle-status\.json/i);

    (fs as any).lstatSync = (target: import('fs').PathLike, ...args: any[]) => {
      if (path.resolve(String(target)) === path.resolve(bundle.paths.automation)) {
        throw Object.assign(new Error(`EACCES: permission denied, lstat '${bundle.paths.automation}'`), { code: 'EACCES' });
      }
      return (originalLstatSync as any).call(fs, target, ...args);
    };
    const inspected = inspectRecordingBundleStatusSync(bundle.paths.csv, bundle.identity);
    assert.equal(inspected.state, 'corrupt');
    assert.match(inspected.error, /EACCES/);
    assert.doesNotMatch(inspected.error, /ff-bundle-status-private|automation\.jsonl/i);
  } finally {
    (fs as any).lstatSync = originalLstatSync;
  }
});

test('manifest-era standalone CSV explicitly opting out remains compatible', async (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bundle-status-optout-'));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const identity = makeIdentity('optout');
  const csv = new FlightCSVWriter({
    ...identity,
    bundleBaseName: 'optout',
    bundleStatusRequired: false,
    outputDir,
    writerMode: 'inline',
  });
  assert.equal(csv.start(), true);
  await csv.close();
  const paths = getBundlePaths(outputDir, 'optout');
  const result = inspectCsvBundleForCatalogSync(paths.csv);
  assert.equal(result.allowed, true);
  assert.equal(result.required, false);
  assert.equal(result.state, 'not_required');
  assert.equal(Number.isSafeInteger(result.catalogRevision), true);
  assert.equal(result.bundleSizeBytes, fs.statSync(paths.csv).size);
});

test('manifest-era opt-out catalog validates present sidecars and revisions their bytes', async (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bundle-status-optout-sidecars-'));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const bundle = await makeClosedBundle(outputDir, 'optout-sidecars', 'optout-sidecars', false);
  const before = inspectCsvBundleForCatalogSync(bundle.paths.csv);
  assert.equal(before.allowed, true);
  assert.equal(before.required, false);
  assert.equal(before.state, 'not_required');
  assert.equal(Number.isSafeInteger(before.catalogRevision), true);
  assert.equal(
    before.bundleSizeBytes,
    fs.statSync(bundle.paths.csv).size
      + fs.statSync(bundle.paths.automation).size
      + fs.statSync(bundle.paths.aircraftSpecific).size,
  );

  const original = fs.readFileSync(bundle.paths.automation, 'utf8');
  const changedSessionId = `${bundle.identity.recordingSessionId.slice(0, -1)}x`;
  assert.notEqual(changedSessionId, bundle.identity.recordingSessionId);
  const tampered = original.replace(bundle.identity.recordingSessionId, changedSessionId);
  assert.notEqual(tampered, original);
  assert.equal(Buffer.byteLength(tampered), Buffer.byteLength(original));
  const originalStat = fs.statSync(bundle.paths.automation);
  fs.writeFileSync(bundle.paths.automation, tampered, 'utf8');
  const advancedMtime = new Date(originalStat.mtimeMs + 2_000);
  fs.utimesSync(bundle.paths.automation, advancedMtime, advancedMtime);

  const after = inspectCsvBundleForCatalogSync(bundle.paths.csv);
  assert.equal(after.allowed, false);
  assert.equal(after.state, 'corrupt');
  assert.match(after.error, /automation identity does not match/i);
  assert.equal(Number.isSafeInteger(after.catalogRevision), true);
  assert.notEqual(after.catalogRevision, before.catalogRevision);
});

test('catalog revision changes when an incomplete bundle is finalized degraded', async (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bundle-status-revision-'));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const bundle = await makeClosedBundle(outputDir, 'revision', 'revision');
  const before = inspectRecordingBundleStatusSync(bundle.paths.csv, bundle.identity);
  assert.equal(before.state, 'incomplete');
  assert.equal(Number.isSafeInteger(before.catalogRevision), true);

  await publishRecordingBundleStatus(publishOptions(outputDir, 'revision', bundle.identity, {
    status: 'degraded',
    degradedReason: 'test member failure',
  }));
  const after = inspectRecordingBundleStatusSync(bundle.paths.csv, bundle.identity);
  assert.equal(after.state, 'degraded');
  assert.equal(Number.isSafeInteger(after.catalogRevision), true);
  assert.notEqual(after.catalogRevision, before.catalogRevision);
  assert.ok(after.bundleSizeBytes > before.bundleSizeBytes);
});

test('Windows path case variants still address the same certificate', { skip: process.platform !== 'win32' }, async (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bundle-status-case-'));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const bundle = await makeClosedBundle(outputDir, 'case', 'case');
  await publishRecordingBundleStatus(publishOptions(outputDir, 'case', bundle.identity));
  const result = readRecordingBundleStatusSync(bundle.paths.csv.toUpperCase());
  assert.equal(result.state, 'complete');
});

export {};
