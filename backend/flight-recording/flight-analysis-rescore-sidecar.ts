'use strict';

/**
 * Durable, reversible whole-flight analysis snapshots.
 *
 * The three recorder artifacts remain immutable. An explicit user rescore
 * stores one server-generated Timeline plus its matching Logbook projection in
 * this flight-owned sidecar. Apply replaces the entire snapshot atomically;
 * restore removes it. There are no per-component or per-landing overrides.
 */

const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');
const { TextDecoder } = require('node:util') as typeof import('node:util');
const recordingBundleLayout = require('./recording-bundle-layout.js') as {
  BUNDLE_FILES: {
    csv: string;
    automation: string;
    aircraftSpecific: string;
    status: string;
    analysisRescore: string;
    legacyLandingGradeRescore: string;
  };
  getBundleFromCsvPath: (_csvPath: unknown) => {
    outputDir: string;
    bundleName: string;
    paths: {
      dir: string;
      csv: string;
      automation: string;
      aircraftSpecific: string;
      status: string;
      analysisRescore: string;
      legacyLandingGradeRescore: string;
    };
  } | null;
};
const recordingBundleLease = require('./recording-bundle-lease.js') as {
  acquireBundleMutationLease: (_options: {
    outputDir: string;
    baseName: string;
    purpose: string;
  }) => { acquired: boolean; reason?: string; release?: () => void };
};
const {
  inspectCsvBundleForCatalogSync,
  readRecordingBundleStatusSync,
} = require('./recording-bundle-status.js') as {
  inspectCsvBundleForCatalogSync: (_csvPath: string) => {
    allowed: boolean;
    required: boolean;
    state: string;
  };
  readRecordingBundleStatusSync: (_csvPath: string) => {
    state: string;
    healthy: boolean;
    certificate?: AnyRecord;
  };
};
const {
  assertSafeFileTarget,
  safeReplaceTextFileSync,
  safeUnlinkSync,
} = require('../utils/safe-fs.js') as {
  assertSafeFileTarget: (_options: SafeFileOptions) => string;
  safeReplaceTextFileSync: (_options: SafeFileOptions & { data: string }) => string;
  safeUnlinkSync: (_options: SafeFileOptions & { allowMissing?: boolean }) => boolean;
};
const { classifyApproachStability } = require('../stability/stability-runner.js') as {
  classifyApproachStability: (_value: AnyRecord | null | undefined) => string;
};

type AnyRecord = Record<string, any>;
type SafeFileOptions = {
  allowedBasenames: string[];
  allowedExtensions: string[];
  operation: string;
  rootDir: string;
  targetPath: string;
};
type RecordingIdentity = {
  bundleName: string;
  csvFileName: string;
  flightId: string;
  recordingSessionId: string;
  recordingStartIso: string;
};
type ArtifactIdentity = {
  fileName: string;
  sizeBytes: number;
  sha256: string;
};
type ImmutableSource = {
  schemaVersion: 1;
  fingerprint: string;
  artifacts: {
    csv: ArtifactIdentity;
    automation: ArtifactIdentity;
    aircraftSpecific: ArtifactIdentity;
  };
};
type FlightAnalysisRescoreDocument = {
  schemaVersion: 1;
  type: 'flight_analysis_rescore_snapshot';
  revision: number;
  appliedAt: string;
  recording: RecordingIdentity;
  source: ImmutableSource;
  analysisContract: AnyRecord;
  analysisContractFingerprint: string;
  payloadSha256: string;
  snapshotFingerprint: string;
  timeline: AnyRecord;
  landings: AnyRecord[];
};
type OwnedBundle = NonNullable<ReturnType<typeof recordingBundleLayout.getBundleFromCsvPath>>;
type ReadResult = {
  exists: boolean;
  valid: boolean;
  document: FlightAnalysisRescoreDocument | null;
  timeline: AnyRecord | null;
  landings: AnyRecord[];
  error?: string;
};

const FLIGHT_ANALYSIS_RESCORE_SCHEMA_VERSION = 1;
const FLIGHT_ANALYSIS_RESCORE_TYPE = 'flight_analysis_rescore_snapshot';
const FLIGHT_ANALYSIS_RESCORE_FILE = recordingBundleLayout.BUNDLE_FILES.analysisRescore;
const LEGACY_LANDING_GRADE_RESCORE_FILE = recordingBundleLayout.BUNDLE_FILES.legacyLandingGradeRescore;
const MAX_FLIGHT_ANALYSIS_RESCORE_BYTES = 64 * 1024 * 1024;
const MAX_ANALYSIS_CONTRACT_BYTES = 128 * 1024;
const MAX_TIMELINE_EVENTS = 10_000;
const MAX_TIMELINE_TRACK_POINTS = 150_000;
const MAX_LANDINGS = 10_000;
const SHA256_RE = /^[a-f0-9]{64}$/;
const TRANSIENT_ROOT_KEYS = new Set([
  'filePath',
  'generatedAt',
  'requestId',
  'scoringMode',
  'landingGradeAnalysis',
  'analysisRescore',
  'analysisRescorePreview',
  'analysisRescoreComparison',
  'analysisRescoreRequest',
]);
const TRANSIENT_NESTED_KEYS = new Set([
  'landingGradePreview',
  'landingGradeOverride',
  'appliedLandingGrade',
]);

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, maxLength = 512): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as AnyRecord;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(',')}}`;
}

function cloneJson(value: unknown, label: string): any {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} is not JSON serializable`);
  }
  if (serialized === undefined) throw new Error(`${label} is unavailable`);
  try {
    return JSON.parse(serialized);
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function scrubTransientAnalysisFields(value: unknown, root = true): void {
  if (Array.isArray(value)) {
    for (const entry of value) scrubTransientAnalysisFields(entry, false);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if ((root && TRANSIENT_ROOT_KEYS.has(key)) || TRANSIENT_NESTED_KEYS.has(key)) {
      delete value[key];
      continue;
    }
    scrubTransientAnalysisFields(value[key], false);
  }
}

function normalizeLandingKey(value: unknown): string | null {
  if (Number.isSafeInteger(value) && Number(value) >= 0) return String(value);
  const raw = text(value, 64);
  if (!raw || !/^(0|[1-9]\d*)$/.test(raw)) return null;
  return Number.isSafeInteger(Number(raw)) ? String(Number(raw)) : null;
}

function knownNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function knownBoolean(value: unknown): boolean | null {
  return value === true ? true : value === false ? false : null;
}

function normalizedFailures(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
}

function normalizedStabilityVerdict(value: unknown, stability: AnyRecord): string {
  const explicit = text(value, 32);
  if (explicit === 'stable' || explicit === 'marginal' || explicit === 'unstable' || explicit === 'no_verdict') {
    return explicit;
  }
  return classifyApproachStability(stability);
}

function scoringProjectionFromTimelineLanding(event: AnyRecord): AnyRecord {
  const touchdown = isRecord(event.touchdownDistance) ? event.touchdownDistance : {};
  const stability = isRecord(event.ultimateStability) ? event.ultimateStability : {};
  return {
    aircraftProfileId: text(event.aircraftProfileId),
    vsFpm: knownNumber(event.vs_fpm ?? event.vsFpm),
    grade: text(event.grade, 128),
    landingRateContext: isRecord(event.landingRateContext) ? event.landingRateContext : null,
    stabilityScore: knownNumber(stability.score),
    stabilityVerdict: normalizedStabilityVerdict(stability.verdict, stability),
    gateStable: knownBoolean(stability.gateStable),
    stabilityGateFailures: normalizedFailures(stability.gateFailures),
    stabilityBreakdown: isRecord(stability.breakdown) ? stability.breakdown : null,
    stabilityContext: isRecord(stability.scoringContext) ? stability.scoringContext : null,
    touchdownDistanceFt: knownNumber(touchdown.distanceFt),
    touchdownDistanceGrade: text(touchdown.grade, 128),
    touchdownDistanceScore: knownNumber(touchdown.score),
    touchdownDistanceZone: text(touchdown.zone, 128),
    lateralOffsetFt: knownNumber(touchdown.lateralOffsetFt),
    lateralOffsetGrade: text(touchdown.lateralOffsetGrade, 128),
    lateralOffsetScore: knownNumber(touchdown.lateralOffsetScore),
    lateralOffsetSide: text(touchdown.lateralOffsetSide, 32),
    bounceCount: knownNumber(touchdown.bounceCount ?? event.bounceCount),
    bounceGrade: text(touchdown.bounceGrade ?? event.bounceGrade, 128),
    bounceScore: knownNumber(touchdown.bounceScore ?? event.bounceScore),
    runwayExcursion: knownBoolean(event.runwayExcursion),
    shortLanding: knownBoolean(event.shortLanding ?? touchdown.shortLanding),
    rolloutAnalysis: isRecord(event.rolloutAnalysis) ? event.rolloutAnalysis : null,
  };
}

function scoringProjectionFromLogbookLanding(landing: AnyRecord): AnyRecord {
  return {
    aircraftProfileId: text(landing.aircraftProfileId),
    vsFpm: knownNumber(landing.vsFpm ?? landing.vs_fpm),
    grade: text(landing.grade, 128),
    landingRateContext: isRecord(landing.landingRateContext) ? landing.landingRateContext : null,
    stabilityScore: knownNumber(landing.stabilityScore),
    stabilityVerdict: normalizedStabilityVerdict(landing.stabilityVerdict, {
      score: landing.stabilityScore,
      gateStable: landing.gateStable,
      gateFailures: landing.stabilityGateFailures,
      breakdown: landing.stabilityBreakdown,
    }),
    gateStable: knownBoolean(landing.gateStable),
    stabilityGateFailures: normalizedFailures(landing.stabilityGateFailures),
    stabilityBreakdown: isRecord(landing.stabilityBreakdown) ? landing.stabilityBreakdown : null,
    stabilityContext: isRecord(landing.stabilityContext) ? landing.stabilityContext : null,
    touchdownDistanceFt: knownNumber(landing.touchdownDistanceFt),
    touchdownDistanceGrade: text(landing.touchdownDistanceGrade, 128),
    touchdownDistanceScore: knownNumber(landing.touchdownDistanceScore),
    touchdownDistanceZone: text(landing.touchdownDistanceZone, 128),
    lateralOffsetFt: knownNumber(landing.lateralOffsetFt),
    lateralOffsetGrade: text(landing.lateralOffsetGrade, 128),
    lateralOffsetScore: knownNumber(landing.lateralOffsetScore),
    lateralOffsetSide: text(landing.lateralOffsetSide, 32),
    bounceCount: knownNumber(landing.bounceCount),
    bounceGrade: text(landing.bounceGrade, 128),
    bounceScore: knownNumber(landing.bounceScore),
    runwayExcursion: knownBoolean(landing.runwayExcursion),
    shortLanding: knownBoolean(landing.shortLanding),
    rolloutAnalysis: isRecord(landing.rolloutAnalysis) ? landing.rolloutAnalysis : null,
  };
}

function normalizeAnalysisPayload(input: {
  timeline: unknown;
  landings: unknown;
  analysisContract: unknown;
}): { timeline: AnyRecord; landings: AnyRecord[]; analysisContract: AnyRecord } {
  const timeline = cloneJson(input.timeline, 'Timeline snapshot');
  const landings = cloneJson(input.landings, 'Logbook projection');
  const analysisContract = cloneJson(input.analysisContract, 'Analysis contract');
  scrubTransientAnalysisFields(timeline);
  scrubTransientAnalysisFields(landings);

  if (!isRecord(timeline) || !Array.isArray(timeline.events) || !Array.isArray(timeline.track)) {
    throw new Error('Timeline snapshot is incomplete');
  }
  if (timeline.events.length > MAX_TIMELINE_EVENTS || timeline.track.length > MAX_TIMELINE_TRACK_POINTS) {
    throw new Error('Timeline snapshot exceeds its safe collection limits');
  }
  if (timeline.events.some((event: unknown) => !isRecord(event))) {
    throw new Error('Timeline snapshot contains an invalid event');
  }
  if (!Array.isArray(landings) || landings.length > MAX_LANDINGS || landings.some((entry) => !isRecord(entry))) {
    throw new Error('Logbook projection is invalid');
  }
  if (!isRecord(analysisContract)) throw new Error('Analysis contract is invalid');
  const contractId = text(analysisContract.id, 256);
  const contractVersion = analysisContract.version;
  if (
    !contractId
    || !(
      (typeof contractVersion === 'string' && contractVersion.trim() && contractVersion.length <= 128)
      || (Number.isSafeInteger(contractVersion) && Number(contractVersion) >= 1)
    )
  ) throw new Error('Analysis contract requires an id and version');
  if (Buffer.byteLength(JSON.stringify(analysisContract), 'utf8') > MAX_ANALYSIS_CONTRACT_BYTES) {
    throw new Error('Analysis contract exceeds its size cap');
  }

  const timelineLandings = timeline.events.filter((event: AnyRecord) => event.type === 'landing');
  const timelineByKey = new Map<string, AnyRecord>();
  for (const event of timelineLandings) {
    const key = normalizeLandingKey(event.landingKey);
    if (!key || timelineByKey.has(key)) throw new Error('Timeline landings require unique recording keys');
    event.landingKey = key;
    timelineByKey.set(key, event);
  }
  const logbookByKey = new Map<string, AnyRecord>();
  for (const landing of landings) {
    const key = normalizeLandingKey(landing.landingKey);
    if (!key || logbookByKey.has(key)) throw new Error('Logbook landings require unique recording keys');
    landing.landingKey = key;
    logbookByKey.set(key, landing);
  }
  if (timelineByKey.size === 0) {
    throw new Error('A flight analysis rescore requires at least one landing');
  }
  if (timelineByKey.size !== logbookByKey.size) {
    throw new Error('Timeline and Logbook landing counts do not match');
  }
  for (const [key, event] of timelineByKey) {
    const landing = logbookByKey.get(key);
    if (!landing) throw new Error('Timeline and Logbook landing identities do not match');
    if (
      stableStringify(scoringProjectionFromTimelineLanding(event))
      !== stableStringify(scoringProjectionFromLogbookLanding(landing))
    ) throw new Error(`Timeline and Logbook scoring disagree for landing ${key}`);
  }

  return { timeline, landings, analysisContract };
}

function artifactIdentity(value: unknown, expectedFileName: string): ArtifactIdentity | null {
  if (!isRecord(value)) return null;
  const fileName = text(value.fileName, 128);
  const sizeBytes = Number(value.sizeBytes);
  const sha256 = text(value.sha256, 64);
  if (
    fileName !== expectedFileName
    || !Number.isSafeInteger(sizeBytes)
    || sizeBytes <= 0
    || !sha256
    || !SHA256_RE.test(sha256)
  ) return null;
  return { fileName, sizeBytes, sha256 };
}

function normalizeRecordingIdentity(value: unknown): RecordingIdentity | null {
  if (!isRecord(value)) return null;
  const bundleName = text(value.bundleName);
  const csvFileName = text(value.csvFileName, 128);
  const flightId = text(value.flightId);
  const recordingSessionId = text(value.recordingSessionId);
  const recordingStartIso = isIsoTimestamp(value.recordingStartIso) ? value.recordingStartIso : null;
  if (
    !bundleName
    || csvFileName !== recordingBundleLayout.BUNDLE_FILES.csv
    || !flightId
    || !recordingSessionId
    || !recordingStartIso
  ) return null;
  return { bundleName, csvFileName, flightId, recordingSessionId, recordingStartIso };
}

function buildSourceFingerprint(recording: RecordingIdentity, artifacts: ImmutableSource['artifacts']): string {
  return sha256Text(stableStringify({ schemaVersion: 1, recording, artifacts }));
}

function normalizeImmutableSource(value: unknown, recording: RecordingIdentity): ImmutableSource | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.artifacts)) return null;
  const csv = artifactIdentity(value.artifacts.csv, recordingBundleLayout.BUNDLE_FILES.csv);
  const automation = artifactIdentity(value.artifacts.automation, recordingBundleLayout.BUNDLE_FILES.automation);
  const aircraftSpecific = artifactIdentity(
    value.artifacts.aircraftSpecific,
    recordingBundleLayout.BUNDLE_FILES.aircraftSpecific,
  );
  if (!csv || !automation || !aircraftSpecific) return null;
  const artifacts = { csv, automation, aircraftSpecific };
  const fingerprint = text(value.fingerprint, 64);
  if (!fingerprint || !SHA256_RE.test(fingerprint) || fingerprint !== buildSourceFingerprint(recording, artifacts)) {
    return null;
  }
  return { schemaVersion: 1, fingerprint, artifacts };
}

function sameRecordingIdentity(left: RecordingIdentity, right: RecordingIdentity): boolean {
  return left.bundleName === right.bundleName
    && left.csvFileName === right.csvFileName
    && left.flightId === right.flightId
    && left.recordingSessionId === right.recordingSessionId
    && left.recordingStartIso === right.recordingStartIso;
}

function resolveOwnedBundle(csvPath: unknown, flightLogsDir?: unknown): OwnedBundle {
  if (typeof csvPath !== 'string' || !csvPath) throw new Error('A canonical telemetry CSV is required');
  const bundle = recordingBundleLayout.getBundleFromCsvPath(csvPath);
  if (!bundle || comparablePath(bundle.paths.csv) !== comparablePath(csvPath)) {
    throw new Error('A canonical telemetry CSV is required');
  }
  const expectedRoot = typeof flightLogsDir === 'string' && flightLogsDir
    ? path.resolve(flightLogsDir)
    : path.resolve(bundle.outputDir);
  if (comparablePath(bundle.outputDir) !== comparablePath(expectedRoot)) {
    throw new Error('The recording is outside Flight Logs');
  }
  const rootStat = fs.lstatSync(expectedRoot);
  const bundleStat = fs.lstatSync(bundle.paths.dir);
  const csvStat = fs.lstatSync(bundle.paths.csv);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Flight Logs is unsafe');
  if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink()) throw new Error('Recording folder is unsafe');
  if (!csvStat.isFile() || csvStat.isSymbolicLink()) throw new Error('Recording CSV is unsafe');
  for (const [operation, fileName, targetPath] of [
    ['resolve flight analysis rescore sidecar', FLIGHT_ANALYSIS_RESCORE_FILE, bundle.paths.analysisRescore],
    ['resolve legacy landing grade rescore sidecar', LEGACY_LANDING_GRADE_RESCORE_FILE, bundle.paths.legacyLandingGradeRescore],
  ] as const) {
    assertSafeFileTarget({
      allowedBasenames: [fileName],
      allowedExtensions: ['.json'],
      operation,
      rootDir: bundle.paths.dir,
      targetPath,
    });
  }
  return bundle;
}

function captureImmutableSource(bundle: OwnedBundle): {
  recording: RecordingIdentity;
  source: ImmutableSource;
} {
  const inspection = inspectCsvBundleForCatalogSync(bundle.paths.csv);
  if (!inspection.allowed || inspection.required !== true || inspection.state !== 'complete') {
    throw new Error('Only a finalized, healthy recording can hold a saved rescore');
  }
  const status = readRecordingBundleStatusSync(bundle.paths.csv);
  const certificate = status.certificate;
  if (!status.healthy || status.state !== 'complete' || !isRecord(certificate)) {
    throw new Error('The recording completion certificate is unavailable');
  }
  const recordingStartIso = isIsoTimestamp(certificate.recordingStartIso)
    ? certificate.recordingStartIso
    : null;
  const recording: RecordingIdentity = {
    bundleName: bundle.bundleName,
    csvFileName: recordingBundleLayout.BUNDLE_FILES.csv,
    flightId: text(certificate.flightId) || '',
    recordingSessionId: text(certificate.recordingSessionId) || '',
    recordingStartIso: recordingStartIso || '',
  };
  if (!normalizeRecordingIdentity(recording) || text(certificate.bundleBaseName) !== bundle.bundleName) {
    throw new Error('The recording completion identity is invalid');
  }
  const csv = artifactIdentity(certificate.artifacts?.csv, recordingBundleLayout.BUNDLE_FILES.csv);
  const automation = artifactIdentity(
    certificate.artifacts?.automation,
    recordingBundleLayout.BUNDLE_FILES.automation,
  );
  const aircraftSpecific = artifactIdentity(
    certificate.artifacts?.aircraftSpecific,
    recordingBundleLayout.BUNDLE_FILES.aircraftSpecific,
  );
  if (!csv || !automation || !aircraftSpecific) {
    throw new Error('The recording completion artifact identities are invalid');
  }
  const artifacts = { csv, automation, aircraftSpecific };
  return {
    recording,
    source: {
      schemaVersion: 1,
      fingerprint: buildSourceFingerprint(recording, artifacts),
      artifacts,
    },
  };
}

function buildFlightAnalysisPreviewFingerprint(input: {
  timeline: unknown;
  landings: unknown;
  analysisContract: unknown;
  sourceFingerprint: unknown;
}): {
  timeline: AnyRecord;
  landings: AnyRecord[];
  analysisContract: AnyRecord;
  analysisContractFingerprint: string;
  payloadSha256: string;
  previewFingerprint: string;
  snapshotFingerprint: string;
} {
  const sourceFingerprint = text(input?.sourceFingerprint, 64);
  if (!sourceFingerprint || !SHA256_RE.test(sourceFingerprint)) {
    throw new Error('Analysis source fingerprint is invalid');
  }
  const normalized = normalizeAnalysisPayload(input);
  const analysisContractFingerprint = sha256Text(stableStringify(normalized.analysisContract));
  const payloadSha256 = sha256Text(stableStringify({
    timeline: normalized.timeline,
    landings: normalized.landings,
  }));
  const snapshotFingerprint = sha256Text(stableStringify({
    schemaVersion: 1,
    sourceFingerprint,
    analysisContractFingerprint,
    payloadSha256,
  }));
  return {
    ...normalized,
    analysisContractFingerprint,
    payloadSha256,
    previewFingerprint: snapshotFingerprint,
    snapshotFingerprint,
  };
}

function invalidRead(error = 'Saved flight analysis is invalid'): ReadResult {
  return { exists: true, valid: false, document: null, timeline: null, landings: [], error };
}

function normalizeDocument(
  value: unknown,
  expectedRecording: RecordingIdentity,
  expectedSource: ImmutableSource,
): FlightAnalysisRescoreDocument | null {
  if (!isRecord(value)) return null;
  if (
    value.schemaVersion !== FLIGHT_ANALYSIS_RESCORE_SCHEMA_VERSION
    || value.type !== FLIGHT_ANALYSIS_RESCORE_TYPE
    || !Number.isSafeInteger(value.revision)
    || value.revision < 1
    || !isIsoTimestamp(value.appliedAt)
  ) return null;
  const recording = normalizeRecordingIdentity(value.recording);
  if (!recording || !sameRecordingIdentity(recording, expectedRecording)) return null;
  const source = normalizeImmutableSource(value.source, recording);
  if (!source || source.fingerprint !== expectedSource.fingerprint) return null;
  let normalized;
  try {
    normalized = buildFlightAnalysisPreviewFingerprint({
      timeline: value.timeline,
      landings: value.landings,
      analysisContract: value.analysisContract,
      sourceFingerprint: source.fingerprint,
    });
  } catch {
    return null;
  }
  if (text(normalized.timeline.flightId) !== expectedRecording.flightId) return null;
  if (
    value.analysisContractFingerprint !== normalized.analysisContractFingerprint
    || value.payloadSha256 !== normalized.payloadSha256
    || value.snapshotFingerprint !== normalized.snapshotFingerprint
  ) return null;
  return {
    schemaVersion: 1,
    type: FLIGHT_ANALYSIS_RESCORE_TYPE,
    revision: value.revision,
    appliedAt: value.appliedAt,
    recording,
    source,
    analysisContract: normalized.analysisContract,
    analysisContractFingerprint: normalized.analysisContractFingerprint,
    payloadSha256: normalized.payloadSha256,
    snapshotFingerprint: normalized.snapshotFingerprint,
    timeline: normalized.timeline,
    landings: normalized.landings,
  };
}

function readDocumentUnlocked(
  bundle: OwnedBundle,
  current: { recording: RecordingIdentity; source: ImmutableSource },
): ReadResult {
  const sidecarPath = bundle.paths.analysisRescore;
  let fd: number | null = null;
  try {
    const before = fs.lstatSync(sidecarPath);
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.size <= 0
      || before.size > MAX_FLIGHT_ANALYSIS_RESCORE_BYTES
    ) return invalidRead();
    fd = fs.openSync(sidecarPath, 'r');
    const opened = fs.fstatSync(fd);
    const after = fs.lstatSync(sidecarPath);
    if (
      !opened.isFile()
      || !after.isFile()
      || after.isSymbolicLink()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || after.dev !== before.dev
      || after.ino !== before.ino
      || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
    ) return invalidRead();
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (bytesRead <= 0) return invalidRead();
      offset += bytesRead;
    }
    const ended = fs.fstatSync(fd);
    if (
      ended.dev !== opened.dev
      || ended.ino !== opened.ino
      || ended.size !== opened.size
      || ended.mtimeMs !== opened.mtimeMs
    ) return invalidRead();
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!decoded.endsWith('\n')) return invalidRead();
    const document = normalizeDocument(JSON.parse(decoded), current.recording, current.source);
    if (!document) return invalidRead();
    return {
      exists: true,
      valid: true,
      document,
      timeline: document.timeline,
      landings: document.landings,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { exists: false, valid: true, document: null, timeline: null, landings: [] };
    }
    return invalidRead();
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function readFlightAnalysisRescoreSidecar(
  csvPath: unknown,
  options: { flightLogsDir?: string } = {},
): ReadResult {
  try {
    const bundle = resolveOwnedBundle(csvPath, options.flightLogsDir);
    return readDocumentUnlocked(bundle, captureImmutableSource(bundle));
  } catch {
    return {
      exists: false,
      valid: false,
      document: null,
      timeline: null,
      landings: [],
      error: 'Recording or saved analysis identity is invalid',
    };
  }
}

function getFlightAnalysisRescoreSource(
  csvPath: unknown,
  options: { flightLogsDir?: string } = {},
): {
  success: boolean;
  error?: string;
  recording?: RecordingIdentity;
  source?: ImmutableSource;
  sourceFingerprint?: string;
  revision?: number;
  snapshotFingerprint?: string | null;
  analysisContractFingerprint?: string | null;
} {
  try {
    const bundle = resolveOwnedBundle(csvPath, options.flightLogsDir);
    const current = captureImmutableSource(bundle);
    const existing = readDocumentUnlocked(bundle, current);
    if (!existing.valid) throw new Error('Saved flight analysis is damaged');
    return {
      success: true,
      ...current,
      sourceFingerprint: current.source.fingerprint,
      revision: existing.document?.revision || 0,
      snapshotFingerprint: existing.document?.snapshotFingerprint || null,
      analysisContractFingerprint: existing.document?.analysisContractFingerprint || null,
    };
  } catch (error) {
    return publicFailure(error, 'Flight analysis source could not be inspected');
  }
}

function publicFailure(error: unknown, fallback: string) {
  const explicit = isRecord(error) ? text(error.publicMessage, 512) : null;
  if (explicit) return { success: false as const, error: explicit };
  const code = error instanceof Error ? text((error as NodeJS.ErrnoException).code, 64) : null;
  return { success: false as const, error: code ? `${fallback} (${code})` : fallback };
}

function failForUser(message: string): never {
  const error = new Error(message) as Error & { publicMessage?: string };
  error.publicMessage = message;
  throw error;
}

function optionalExpectedRevision(options: AnyRecord): number | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(options, 'expectedRevision')) return undefined;
  if (options.expectedRevision === null) return undefined;
  const revision = Number(options.expectedRevision);
  if (!Number.isSafeInteger(revision) || revision < 0) failForUser('The saved-analysis revision is invalid.');
  return revision;
}

function optionalSha256(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const normalized = text(value, 64);
  if (!normalized || !SHA256_RE.test(normalized)) failForUser(`${label} is invalid.`);
  return normalized;
}

function writeDocument(bundle: OwnedBundle, document: FlightAnalysisRescoreDocument): void {
  const data = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(data, 'utf8') > MAX_FLIGHT_ANALYSIS_RESCORE_BYTES) {
    failForUser('The rescored flight analysis exceeds its safe size limit.');
  }
  safeReplaceTextFileSync({
    allowedBasenames: [FLIGHT_ANALYSIS_RESCORE_FILE],
    allowedExtensions: ['.json'],
    data,
    operation: 'write flight analysis rescore sidecar',
    rootDir: bundle.paths.dir,
    targetPath: bundle.paths.analysisRescore,
  });
}

function saveFlightAnalysisRescore(options: {
  csvPath: string;
  flightLogsDir: string;
  timeline: unknown;
  landings: unknown;
  analysisContract: unknown;
  expectedRevision?: number | null;
  expectedSourceFingerprint?: string | null;
  expectedPreviewFingerprint?: string | null;
  expectedAnalysisContractFingerprint?: string | null;
}): AnyRecord {
  let bundle: OwnedBundle;
  let expectedRevision: number | null | undefined;
  let expectedSourceFingerprint: string | null | undefined;
  let expectedPreviewFingerprint: string | null | undefined;
  let expectedAnalysisContractFingerprint: string | null | undefined;
  try {
    bundle = resolveOwnedBundle(options?.csvPath, options?.flightLogsDir);
    expectedRevision = optionalExpectedRevision(options as AnyRecord);
    expectedSourceFingerprint = optionalSha256(options?.expectedSourceFingerprint, 'Analysis source fingerprint');
    expectedPreviewFingerprint = optionalSha256(options?.expectedPreviewFingerprint, 'Analysis preview fingerprint');
    expectedAnalysisContractFingerprint = optionalSha256(
      options?.expectedAnalysisContractFingerprint,
      'Analysis contract fingerprint',
    );
  } catch (error) {
    return publicFailure(error, 'Flight analysis rescore was refused');
  }

  const lease = recordingBundleLease.acquireBundleMutationLease({
    outputDir: bundle.outputDir,
    baseName: bundle.bundleName,
    purpose: 'flight_analysis_rescore',
  });
  if (!lease.acquired || typeof lease.release !== 'function') {
    return { success: false, error: 'The flight recording is currently busy. Try again shortly.' };
  }

  try {
    bundle = resolveOwnedBundle(options.csvPath, options.flightLogsDir);
    const current = captureImmutableSource(bundle);
    if (expectedSourceFingerprint !== undefined && expectedSourceFingerprint !== current.source.fingerprint) {
      failForUser('The flight recording changed after the preview. Preview it again before applying.');
    }
    const existing = readDocumentUnlocked(bundle, current);
    if (!existing.valid) failForUser('The saved flight analysis is damaged and was not overwritten.');
    const currentRevision = existing.document?.revision || 0;
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      failForUser('The saved flight analysis changed after the preview. Refresh and try again.');
    }
    const normalized = buildFlightAnalysisPreviewFingerprint({
      timeline: options.timeline,
      landings: options.landings,
      analysisContract: options.analysisContract,
      sourceFingerprint: current.source.fingerprint,
    });
    if (text(normalized.timeline.flightId) !== current.recording.flightId) {
      failForUser('The generated analysis belongs to a different flight recording.');
    }
    if (expectedPreviewFingerprint !== undefined && expectedPreviewFingerprint !== normalized.snapshotFingerprint) {
      failForUser('The analysis rules or result changed after the preview. Preview the flight again before applying.');
    }
    if (
      expectedAnalysisContractFingerprint !== undefined
      && expectedAnalysisContractFingerprint !== normalized.analysisContractFingerprint
    ) {
      failForUser('The analysis rules changed after the preview. Preview the flight again before applying.');
    }
    const now = new Date().toISOString();
    const document: FlightAnalysisRescoreDocument = {
      schemaVersion: 1,
      type: FLIGHT_ANALYSIS_RESCORE_TYPE,
      revision: currentRevision + 1,
      appliedAt: now,
      recording: current.recording,
      source: current.source,
      analysisContract: normalized.analysisContract,
      analysisContractFingerprint: normalized.analysisContractFingerprint,
      payloadSha256: normalized.payloadSha256,
      snapshotFingerprint: normalized.snapshotFingerprint,
      timeline: normalized.timeline,
      landings: normalized.landings,
    };
    writeDocument(bundle, document);
    const after = captureImmutableSource(bundle);
    if (
      !sameRecordingIdentity(current.recording, after.recording)
      || current.source.fingerprint !== after.source.fingerprint
    ) failForUser('The flight recording changed while its rescored analysis was saved.');
    return {
      success: true,
      document,
      revision: document.revision,
      sourceFingerprint: document.source.fingerprint,
      snapshotFingerprint: document.snapshotFingerprint,
      analysisContractFingerprint: document.analysisContractFingerprint,
      landingCount: document.landings.length,
    };
  } catch (error) {
    return publicFailure(error, 'Flight analysis rescore could not be saved');
  } finally {
    lease.release();
  }
}

function revertFlightAnalysisRescore(options: {
  csvPath: string;
  flightLogsDir: string;
  expectedRevision?: number | null;
  expectedSnapshotFingerprint?: string | null;
}): AnyRecord {
  let bundle: OwnedBundle;
  let expectedRevision: number | null | undefined;
  let expectedSnapshotFingerprint: string | null | undefined;
  try {
    bundle = resolveOwnedBundle(options?.csvPath, options?.flightLogsDir);
    expectedRevision = optionalExpectedRevision(options as AnyRecord);
    expectedSnapshotFingerprint = optionalSha256(
      options?.expectedSnapshotFingerprint,
      'Saved analysis fingerprint',
    );
  } catch (error) {
    return publicFailure(error, 'Flight analysis restore was refused');
  }

  const lease = recordingBundleLease.acquireBundleMutationLease({
    outputDir: bundle.outputDir,
    baseName: bundle.bundleName,
    purpose: 'flight_analysis_rescore_revert',
  });
  if (!lease.acquired || typeof lease.release !== 'function') {
    return { success: false, error: 'The flight recording is currently busy. Try again shortly.' };
  }

  try {
    bundle = resolveOwnedBundle(options.csvPath, options.flightLogsDir);
    const current = captureImmutableSource(bundle);
    const existing = readDocumentUnlocked(bundle, current);
    const damaged = existing.exists && !existing.valid;
    if (damaged && (expectedRevision !== undefined || expectedSnapshotFingerprint !== undefined)) {
      failForUser('The saved flight analysis is damaged. Restore it again after refreshing.');
    }
    const currentRevision = existing.document?.revision || 0;
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      failForUser('The saved flight analysis changed after the page loaded. Refresh and try again.');
    }
    if (
      expectedSnapshotFingerprint !== undefined
      && expectedSnapshotFingerprint !== (existing.document?.snapshotFingerprint || null)
    ) failForUser('The saved flight analysis changed after the page loaded. Refresh and try again.');

    // Preflight both recognized derived targets before deleting either one.
    for (const [fileName, targetPath] of [
      [FLIGHT_ANALYSIS_RESCORE_FILE, bundle.paths.analysisRescore],
      [LEGACY_LANDING_GRADE_RESCORE_FILE, bundle.paths.legacyLandingGradeRescore],
    ] as const) {
      assertSafeFileTarget({
        allowedBasenames: [fileName],
        allowedExtensions: ['.json'],
        operation: 'restore recorded flight analysis',
        rootDir: bundle.paths.dir,
        targetPath,
      });
    }
    // The ignored prototype is cleanup-only. Remove it first so unlinking the
    // active snapshot remains the restore operation's final logical commit.
    const removedLegacy = safeUnlinkSync({
      allowedBasenames: [LEGACY_LANDING_GRADE_RESCORE_FILE],
      allowedExtensions: ['.json'],
      allowMissing: true,
      operation: 'remove legacy landing grade rescore',
      rootDir: bundle.paths.dir,
      targetPath: bundle.paths.legacyLandingGradeRescore,
    });
    const removed = safeUnlinkSync({
      allowedBasenames: [FLIGHT_ANALYSIS_RESCORE_FILE],
      allowedExtensions: ['.json'],
      allowMissing: true,
      operation: 'remove saved flight analysis',
      rootDir: bundle.paths.dir,
      targetPath: bundle.paths.analysisRescore,
    });
    return {
      success: true,
      reverted: removed || removedLegacy,
      damaged,
      revision: currentRevision,
      snapshotFingerprint: existing.document?.snapshotFingerprint || null,
    };
  } catch (error) {
    return publicFailure(error, 'Flight analysis rescore could not be restored');
  } finally {
    lease.release();
  }
}

module.exports = {
  buildFlightAnalysisPreviewFingerprint,
  getFlightAnalysisRescoreSource,
  readFlightAnalysisRescoreSidecar,
  revertFlightAnalysisRescore,
  saveFlightAnalysisRescore,
};

export {};
