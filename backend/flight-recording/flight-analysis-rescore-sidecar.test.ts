'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const test = require('node:test') as typeof import('node:test');

const { FlightCSVWriter } = require('./flight-csv-writer.js') as {
  FlightCSVWriter: new (_options: any) => any;
};
const { AutomationJsonlRecorder } = require('./automation-jsonl-recorder.js') as {
  AutomationJsonlRecorder: new (_options: any) => any;
};
const { AircraftSpecificJsonlRecorder } = require('./aircraft-specific-jsonl-recorder.js') as {
  AircraftSpecificJsonlRecorder: new (_options: any) => any;
};
const { getBundlePaths } = require('./recording-bundle-layout.js') as {
  getBundlePaths: (_outputDir: string, _bundleName: string) => any;
};
const {
  inspectCsvBundleForCatalogSync,
  publishRecordingBundleStatus,
} = require('./recording-bundle-status.js') as {
  inspectCsvBundleForCatalogSync: (_csvPath: string) => any;
  publishRecordingBundleStatus: (_options: any) => Promise<any>;
};
const {
  buildFlightAnalysisPreviewFingerprint,
  getFlightAnalysisRescoreSource,
  readFlightAnalysisRescoreSidecar,
  revertFlightAnalysisRescore,
  saveFlightAnalysisRescore,
} = require('./flight-analysis-rescore-sidecar.js') as {
  buildFlightAnalysisPreviewFingerprint: (_input: any) => any;
  getFlightAnalysisRescoreSource: (_csvPath: string, _options?: any) => any;
  readFlightAnalysisRescoreSidecar: (_csvPath: string, _options?: any) => any;
  revertFlightAnalysisRescore: (_options: any) => any;
  saveFlightAnalysisRescore: (_options: any) => any;
};

const START_MS = Date.parse('2026-08-09T01:02:03.000Z');

async function makeBundle(root: string, bundleName: string) {
  const identity = {
    flightId: `analysis-flight-${bundleName}`,
    recordingSessionId: `analysis-session-${bundleName}`,
    recordingStartEpochMs: START_MS,
    recordingStartIso: new Date(START_MS).toISOString(),
  };
  const options = {
    ...identity,
    bundleBaseName: bundleName,
    bundleStatusRequired: true,
    outputDir: root,
    writerMode: 'inline',
  };
  const csv = new FlightCSVWriter(options);
  const automation = new AutomationJsonlRecorder(options);
  const aircraftSpecific = new AircraftSpecificJsonlRecorder(options);
  assert.equal(csv.start(), true);
  assert.equal(automation.start(), true);
  assert.equal(aircraftSpecific.start(), true);
  assert.equal(automation.recordAutopilotState({ timeMs: START_MS + 100 }), true);
  assert.equal(csv.writeEvent('LANDING', {
    aircraft_profile_id: 'bundled/msfs/fbw-a32nx',
    grade: 'PERFECT',
    vs: -180,
    vs_fpm: -180,
  }, {
    aircraftProfileId: 'bundled/msfs/fbw-a32nx',
    timestampMs: START_MS + 1_000,
    timestampIso: new Date(START_MS + 1_000).toISOString(),
    vs: -180,
  }), true);
  assert.equal(csv.writeEvent('LANDING', {
    aircraft_profile_id: 'bundled/msfs/fbw-a32nx',
    grade: 'FIRM',
    vs: -510,
    vs_fpm: -510,
  }, {
    aircraftProfileId: 'bundled/msfs/fbw-a32nx',
    timestampMs: START_MS + 2_000,
    timestampIso: new Date(START_MS + 2_000).toISOString(),
    vs: -510,
  }), true);
  await Promise.all([csv.close(), automation.close(), aircraftSpecific.close()]);
  await publishRecordingBundleStatus({
    ...identity,
    outputDir: root,
    bundleBaseName: bundleName,
    status: 'complete',
    finalizedAtEpochMs: START_MS + 3_000,
    finalizedAtIso: new Date(START_MS + 3_000).toISOString(),
    endReason: 'test_end',
  });
  return { identity, paths: getBundlePaths(root, bundleName) };
}

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function buildSnapshot(flightId: string, secondGrade = 'HARD') {
  const firstContext = { schemaVersion: 1, policy: { id: 'landing-rate-v2', version: 2 } };
  const stabilityContext = { schemaVersion: 2, policy: { id: 'transport-v2', version: 2 } };
  const firstEvent = {
    type: 'landing',
    landingKey: '1',
    aircraftProfileId: 'bundled/msfs/fbw-a32nx',
    vs_fpm: -180,
    grade: 'GOOD',
    landingRateContext: firstContext,
    ultimateStability: {
      score: 91,
      verdict: 'stable',
      gateStable: true,
      gateFailures: [],
      breakdown: { speed_ok: 96 },
      scoringContext: stabilityContext,
    },
    touchdownDistance: {
      distanceFt: 850,
      grade: 'Outstanding',
      score: 100,
      zone: 'ideal',
      lateralOffsetFt: 7,
      lateralOffsetGrade: 'Perfect',
      lateralOffsetScore: 100,
      lateralOffsetSide: 'right',
      bounceCount: 0,
      bounceGrade: 'Clean',
      bounceScore: 100,
      shortLanding: false,
    },
    runwayExcursion: false,
    rolloutAnalysis: { schemaVersion: 3, assessment: 'normal' },
  };
  const secondEvent = {
    type: 'landing',
    landingKey: '2',
    aircraftProfileId: 'bundled/msfs/fbw-a32nx',
    vs_fpm: -510,
    grade: secondGrade,
    landingRateContext: firstContext,
    ultimateStability: {
      score: 58,
      verdict: 'unstable',
      gateStable: false,
      gateFailures: ['speed_unstable_after_gate'],
      breakdown: { speed_ok: 52 },
      scoringContext: stabilityContext,
    },
    touchdownDistance: {
      distanceFt: 2700,
      grade: 'Acceptable',
      score: 75,
      zone: 'long',
      lateralOffsetFt: 31,
      lateralOffsetGrade: 'Marginal',
      lateralOffsetScore: 85,
      lateralOffsetSide: 'left',
      bounceCount: 1,
      bounceGrade: 'Single Bounce',
      bounceScore: 70,
      shortLanding: false,
    },
    runwayExcursion: false,
    rolloutAnalysis: { schemaVersion: 3, assessment: 'caution' },
  };
  const toLanding = (event: any) => ({
    id: `${flightId}:${event.landingKey}`,
    landingKey: event.landingKey,
    aircraftProfileId: event.aircraftProfileId,
    vsFpm: event.vs_fpm,
    grade: event.grade,
    recordedGrade: event.landingKey === '1' ? 'PERFECT' : 'FIRM',
    gradeSource: 'applied-rescore',
    analysisRescore: { applied: true, scope: 'full-landing-analysis' },
    landingRateContext: event.landingRateContext,
    stabilityScore: event.ultimateStability.score,
    stabilityVerdict: event.ultimateStability.verdict,
    gateStable: event.ultimateStability.gateStable,
    stabilityGateFailures: event.ultimateStability.gateFailures,
    stabilityBreakdown: event.ultimateStability.breakdown,
    stabilityContext: event.ultimateStability.scoringContext,
    touchdownDistanceFt: event.touchdownDistance.distanceFt,
    touchdownDistanceGrade: event.touchdownDistance.grade,
    touchdownDistanceScore: event.touchdownDistance.score,
    touchdownDistanceZone: event.touchdownDistance.zone,
    lateralOffsetFt: event.touchdownDistance.lateralOffsetFt,
    lateralOffsetGrade: event.touchdownDistance.lateralOffsetGrade,
    lateralOffsetScore: event.touchdownDistance.lateralOffsetScore,
    lateralOffsetSide: event.touchdownDistance.lateralOffsetSide,
    bounceCount: event.touchdownDistance.bounceCount,
    bounceGrade: event.touchdownDistance.bounceGrade,
    bounceScore: event.touchdownDistance.bounceScore,
    runwayExcursion: event.runwayExcursion,
    shortLanding: event.touchdownDistance.shortLanding,
    rolloutAnalysis: event.rolloutAnalysis,
  });
  return {
    timeline: {
      flightId,
      generated: true,
      generatedAt: '2026-08-09T03:00:00.000Z',
      filePath: 'must-not-be-persisted',
      analysisRescorePreview: { previewFingerprint: 'must-not-be-persisted' },
      events: [firstEvent, secondEvent],
      track: [],
    },
    landings: [toLanding(firstEvent), toLanding(secondEvent)],
    analysisContract: {
      id: 'full-flight-analysis',
      version: 2,
      profiles: [{ id: 'bundled/msfs/fbw-a32nx', sha256: 'a'.repeat(64) }],
    },
  };
}

test('whole-flight rescore saves every landing atomically without changing recorder artifacts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-analysis-rescore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = await makeBundle(root, 'durable');
  const payload = buildSnapshot(bundle.identity.flightId);
  const immutablePaths = [bundle.paths.csv, bundle.paths.automation, bundle.paths.aircraftSpecific];
  const hashesBefore = immutablePaths.map(sha256);
  const sourceBefore = getFlightAnalysisRescoreSource(bundle.paths.csv, { flightLogsDir: root });
  const catalogBefore = inspectCsvBundleForCatalogSync(bundle.paths.csv);
  assert.equal(sourceBefore.success, true, sourceBefore.error);
  assert.equal(sourceBefore.revision, 0);
  assert.equal(sourceBefore.sourceFingerprint, sourceBefore.source.fingerprint);

  const preview = buildFlightAnalysisPreviewFingerprint({
    ...payload,
    sourceFingerprint: sourceBefore.source.fingerprint,
  });
  const reorderedContractPreview = buildFlightAnalysisPreviewFingerprint({
    ...payload,
    analysisContract: {
      profiles: payload.analysisContract.profiles,
      version: payload.analysisContract.version,
      id: payload.analysisContract.id,
    },
    sourceFingerprint: sourceBefore.source.fingerprint,
  });
  assert.equal(reorderedContractPreview.snapshotFingerprint, preview.snapshotFingerprint);
  const saved = saveFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    ...payload,
    expectedRevision: 0,
    expectedSourceFingerprint: sourceBefore.source.fingerprint,
    expectedPreviewFingerprint: preview.snapshotFingerprint,
    expectedAnalysisContractFingerprint: preview.analysisContractFingerprint,
  });
  assert.equal(saved.success, true, saved.error);
  assert.equal(saved.revision, 1);
  assert.equal(saved.landingCount, 2);
  assert.equal(path.basename(bundle.paths.analysisRescore), 'analysis-rescore.json');
  assert.deepEqual(immutablePaths.map(sha256), hashesBefore);

  const read = readFlightAnalysisRescoreSidecar(bundle.paths.csv, { flightLogsDir: root });
  assert.equal(read.valid, true, read.error);
  assert.equal(read.exists, true);
  assert.equal(read.document.revision, 1);
  assert.equal(read.landings.length, 2);
  assert.equal(read.landings[0].recordedGrade, 'PERFECT');
  assert.equal(read.landings[0].gradeSource, 'applied-rescore');
  assert.equal(read.landings[0].analysisRescore.applied, true);
  assert.equal(read.timeline.events[1].ultimateStability.score, 58);
  assert.equal(read.timeline.events[1].touchdownDistance.bounceGrade, 'Single Bounce');
  assert.equal(Object.hasOwn(read.timeline, 'generatedAt'), false);
  assert.equal(Object.hasOwn(read.timeline, 'filePath'), false);
  assert.equal(Object.hasOwn(read.timeline, 'analysisRescorePreview'), false);
  assert.equal(read.document.snapshotFingerprint, preview.snapshotFingerprint);
  assert.equal(preview.previewFingerprint, preview.snapshotFingerprint);

  const sourceAfter = getFlightAnalysisRescoreSource(bundle.paths.csv, { flightLogsDir: root });
  assert.equal(sourceAfter.source.fingerprint, sourceBefore.source.fingerprint);
  assert.equal(sourceAfter.revision, 1);
  const catalogAfter = inspectCsvBundleForCatalogSync(bundle.paths.csv);
  assert.notEqual(catalogAfter.catalogRevision, catalogBefore.catalogRevision);
  assert.ok(catalogAfter.bundleSizeBytes > catalogBefore.bundleSizeBytes);
});

test('whole-flight save uses source, revision, and preview CAS and replaces all landings together', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-analysis-cas-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = await makeBundle(root, 'cas');
  const source = getFlightAnalysisRescoreSource(bundle.paths.csv, { flightLogsDir: root });
  const firstPayload = buildSnapshot(bundle.identity.flightId);
  const firstPreview = buildFlightAnalysisPreviewFingerprint({
    ...firstPayload,
    sourceFingerprint: source.source.fingerprint,
  });
  const first = saveFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    ...firstPayload,
    expectedRevision: 0,
    expectedPreviewFingerprint: firstPreview.snapshotFingerprint,
  });
  assert.equal(first.success, true, first.error);

  const nextPayload = buildSnapshot(bundle.identity.flightId, 'VERY HARD');
  const nextPreview = buildFlightAnalysisPreviewFingerprint({
    ...nextPayload,
    sourceFingerprint: source.source.fingerprint,
  });
  const staleRevision = saveFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    ...nextPayload,
    expectedRevision: 0,
  });
  assert.equal(staleRevision.success, false);
  assert.match(staleRevision.error, /changed after the preview/i);
  const staleSource = saveFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    ...nextPayload,
    expectedRevision: 1,
    expectedSourceFingerprint: 'b'.repeat(64),
  });
  assert.equal(staleSource.success, false);
  assert.match(staleSource.error, /recording changed/i);
  const stalePreview = saveFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    ...nextPayload,
    expectedRevision: 1,
    expectedPreviewFingerprint: firstPreview.snapshotFingerprint,
  });
  assert.equal(stalePreview.success, false);
  assert.match(stalePreview.error, /rules or result changed/i);
  const staleContract = saveFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    ...nextPayload,
    expectedRevision: 1,
    expectedAnalysisContractFingerprint: 'c'.repeat(64),
  });
  assert.equal(staleContract.success, false);
  assert.match(staleContract.error, /rules changed/i);

  const replaced = saveFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    ...nextPayload,
    expectedRevision: 1,
    expectedSourceFingerprint: source.source.fingerprint,
    expectedPreviewFingerprint: nextPreview.snapshotFingerprint,
  });
  assert.equal(replaced.success, true, replaced.error);
  assert.equal(replaced.revision, 2);
  const read = readFlightAnalysisRescoreSidecar(bundle.paths.csv, { flightLogsDir: root });
  assert.deepEqual(read.landings.map((landing: any) => landing.grade), ['GOOD', 'VERY HARD']);
});

test('restore is revision guarded, removes the whole snapshot, and cleans ignored legacy state', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-analysis-revert-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = await makeBundle(root, 'revert');
  const source = getFlightAnalysisRescoreSource(bundle.paths.csv, { flightLogsDir: root });
  const payload = buildSnapshot(bundle.identity.flightId);
  const saved = saveFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    ...payload,
    expectedRevision: 0,
  });
  assert.equal(saved.success, true, saved.error);
  fs.writeFileSync(bundle.paths.legacyLandingGradeRescore, '{"legacy":true}\n', 'utf8');

  const stale = revertFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    expectedRevision: 0,
  });
  assert.equal(stale.success, false);
  assert.equal(fs.existsSync(bundle.paths.analysisRescore), true);
  const restored = revertFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    expectedRevision: 1,
    expectedSnapshotFingerprint: saved.snapshotFingerprint,
  });
  assert.equal(restored.success, true, restored.error);
  assert.equal(restored.reverted, true);
  assert.equal(fs.existsSync(bundle.paths.analysisRescore), false);
  assert.equal(fs.existsSync(bundle.paths.legacyLandingGradeRescore), false);
  const read = readFlightAnalysisRescoreSidecar(bundle.paths.csv, { flightLogsDir: root });
  assert.equal(read.valid, true);
  assert.equal(read.exists, false);
});

test('damaged snapshots fail closed, are not overwritten, and explicit unguarded restore can recover', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-analysis-damaged-'));
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-analysis-other-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(otherRoot, { recursive: true, force: true }));
  const bundle = await makeBundle(root, 'damaged');
  const payload = buildSnapshot(bundle.identity.flightId);

  const escaped = saveFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: otherRoot,
    ...payload,
  });
  assert.equal(escaped.success, false);
  assert.equal(fs.existsSync(bundle.paths.analysisRescore), false);

  const damagedBytes = '{"schemaVersion":1';
  fs.writeFileSync(bundle.paths.analysisRescore, damagedBytes, 'utf8');
  const read = readFlightAnalysisRescoreSidecar(bundle.paths.csv, { flightLogsDir: root });
  assert.equal(read.exists, true);
  assert.equal(read.valid, false);
  const refused = saveFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    ...payload,
  });
  assert.equal(refused.success, false);
  assert.match(refused.error, /damaged.*not overwritten/i);
  assert.equal(fs.readFileSync(bundle.paths.analysisRescore, 'utf8'), damagedBytes);
  const guardedRestore = revertFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    expectedRevision: 1,
  });
  assert.equal(guardedRestore.success, false);
  const recovered = revertFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
  });
  assert.equal(recovered.success, true, recovered.error);
  assert.equal(recovered.damaged, true);
  assert.equal(fs.existsSync(bundle.paths.analysisRescore), false);
});

test('snapshot validation refuses partial, duplicate, or disagreeing landing projections', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-analysis-validation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = await makeBundle(root, 'validation');
  const payload = buildSnapshot(bundle.identity.flightId);
  const wrongFlight = saveFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    ...payload,
    timeline: { ...payload.timeline, flightId: 'another-flight' },
  });
  assert.equal(wrongFlight.success, false);
  assert.match(wrongFlight.error, /different flight recording/i);
  const empty = saveFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    ...payload,
    timeline: { ...payload.timeline, events: [] },
    landings: [],
  });
  assert.equal(empty.success, false);
  const missing = saveFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    ...payload,
    landings: payload.landings.slice(0, 1),
  });
  assert.equal(missing.success, false);
  const duplicate = saveFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    ...payload,
    landings: [payload.landings[0], payload.landings[0]],
  });
  assert.equal(duplicate.success, false);
  const disagreeing = saveFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    ...payload,
    landings: payload.landings.map((landing: any, index: number) => (
      index === 0 ? { ...landing, stabilityScore: 1 } : landing
    )),
  });
  assert.equal(disagreeing.success, false);
  const disagreeingVerdict = saveFlightAnalysisRescore({
    csvPath: bundle.paths.csv,
    flightLogsDir: root,
    ...payload,
    landings: payload.landings.map((landing: any, index: number) => (
      index === 0 ? { ...landing, stabilityVerdict: 'unstable' } : landing
    )),
  });
  assert.equal(disagreeingVerdict.success, false);
  assert.equal(fs.existsSync(bundle.paths.analysisRescore), false);
});

export {};
