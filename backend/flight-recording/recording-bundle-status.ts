'use strict';

/**
 * Durable completion certificate for one three-file flight recording bundle.
 *
 * The data writers deliberately remain independent append-only streams.  Once
 * all three streams have closed, this module hashes their final bytes and
 * publishes one small, no-replace certificate.  A reader accepts a recording
 * as complete only when every member matches that certificate; absence is an
 * incomplete/crash prefix, never an implicit success.
 */

const crypto = require('crypto') as typeof import('crypto');
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const recordingBundleLayout = require('./recording-bundle-layout') as {
  BUNDLE_FILES: {
    csv: string;
    automation: string;
    aircraftSpecific: string;
    status: string;
    analysisRescore: string;
  };
  BUNDLE_LAYOUT_VERSION: number;
  getArtifactPathForCsv: (_csvPath: unknown, _role: 'status') => string | null;
  getBundleFromCsvPath: (_csvPath: unknown) => {
    outputDir: string;
    bundleName: string;
    paths: {
      csv: string;
      automation: string;
      aircraftSpecific: string;
      status: string;
      analysisRescore: string;
    };
  } | null;
  getBundlePaths: (_outputDir: string, _bundleName: string) => {
    csv: string;
    automation: string;
    aircraftSpecific: string;
    status: string;
    analysisRescore: string;
  };
};
const { TextDecoder } = require('node:util') as typeof import('node:util');
const { parseCsvLine } = require('../utils/csv') as {
  parseCsvLine: (_line: string, _options?: { trimValues?: boolean }) => string[];
};

type AnyRecord = Record<string, any>;
type BundleStatusKind = 'complete' | 'degraded';
type ArtifactRole = 'csv' | 'automation' | 'aircraftSpecific';
type RecordingIdentity = {
  flightId: string;
  recordingSessionId: string;
  recordingStartEpochMs: number;
  recordingStartIso: string;
};
type ArtifactDigest = {
  fileName: string;
  sizeBytes: number;
  sha256: string;
};
type ArtifactCertificate = ArtifactDigest & {
  state: 'present';
  mtimeMs: number;
  ctimeMs: number;
};
type DegradedArtifactCertificate = Partial<Omit<ArtifactCertificate, 'state'>> & {
  fileName: string;
  state: 'present' | 'missing' | 'unreadable';
  error?: string;
};
type BundleStatusCertificate = RecordingIdentity & {
  schemaVersion: 2;
  layoutVersion: 2;
  type: 'recording_bundle_status';
  status: BundleStatusKind;
  bundleBaseName: string;
  finalizedAtEpochMs: number;
  finalizedAtIso: string;
  endReason: string;
  degradedReason?: string;
  artifacts: Record<ArtifactRole, ArtifactCertificate | DegradedArtifactCertificate>;
};
type PublishBundleStatusOptions = RecordingIdentity & {
  outputDir: string;
  bundleBaseName: string;
  status: BundleStatusKind;
  finalizedAtEpochMs: number;
  finalizedAtIso?: string;
  endReason?: string;
  degradedReason?: unknown;
};
type StatusArtifactObservation = ArtifactDigest & {
  identity?: Partial<RecordingIdentity> & { bundleStatusRequired?: boolean };
  mtimeMs?: number;
  ctimeMs?: number;
};
type VerifyBundleStatusOptions = {
  expectedIdentity: RecordingIdentity;
  artifacts: Record<ArtifactRole, StatusArtifactObservation>;
};
type BundleStatusReadResult = {
  statusPath: string;
  exists: boolean;
  state: 'complete' | 'degraded' | 'incomplete' | 'corrupt';
  healthy: boolean;
  certificate?: BundleStatusCertificate;
  error?: string;
  catalogRevision?: number;
  bundleSizeBytes?: number;
};

const BUNDLE_STATUS_SCHEMA_VERSION = 2;
const MAX_BUNDLE_STATUS_BYTES = 64 * 1024;
const MAX_DATA_ARTIFACT_BYTES = 200 * 1024 * 1024;
const MAX_IDENTITY_PREFIX_BYTES = 1024 * 1024;
const HASH_READ_BYTES = 256 * 1024;
const INVALID_UTF8_CODE = 'FF_INVALID_UTF8';
const SHA256_RE = /^[a-f0-9]{64}$/;

const ARTIFACT_DEFINITIONS: ReadonlyArray<{
  role: ArtifactRole;
  suffix: string;
  manifestType?: string;
}> = Object.freeze([
  { role: 'csv', suffix: recordingBundleLayout.BUNDLE_FILES.csv },
  { role: 'automation', suffix: recordingBundleLayout.BUNDLE_FILES.automation, manifestType: 'automation_manifest' },
  { role: 'aircraftSpecific', suffix: recordingBundleLayout.BUNDLE_FILES.aircraftSpecific, manifestType: 'aircraft_specific_manifest' },
]);

function isRecord(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function sanitizeReason(value: unknown, fallback: string): string {
  const errorCode = value instanceof Error
    ? nonEmptyText((value as NodeJS.ErrnoException).code)
    : null;
  // Storage errors commonly embed absolute local paths. Persist only a stable
  // code for Error objects; callers may pass a deliberately generic reason.
  const raw = value instanceof Error
    ? (errorCode ? `${fallback} (${errorCode})` : fallback)
    : String(value || fallback);
  const sanitized = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return (sanitized || fallback).slice(0, 512);
}

function publicReadError(value: unknown, fallback: string): string {
  const code = value instanceof Error
    ? nonEmptyText((value as NodeJS.ErrnoException).code)
    : null;
  // Native filesystem errors commonly include the absolute target path in
  // `message`.  These results are attached to logbook websocket payloads, so
  // expose only the stable error code.  Errors raised by our validators do
  // not have a code and retain their actionable, path-free message.
  if (code) {
    const safeCode = /^[A-Z0-9_]+$/i.test(code) ? code : 'IO_ERROR';
    return `${fallback} (${safeCode}).`;
  }
  return value instanceof Error ? value.message : String(value);
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeIdentity(value: Partial<RecordingIdentity>): RecordingIdentity {
  const flightId = nonEmptyText(value.flightId);
  const recordingSessionId = nonEmptyText(value.recordingSessionId);
  const recordingStartEpochMs = Number(value.recordingStartEpochMs);
  const recordingStartIso = nonEmptyText(value.recordingStartIso);
  if (!flightId || !recordingSessionId) throw new Error('Recording bundle status identity is incomplete');
  if (
    !Number.isSafeInteger(recordingStartEpochMs)
    || !recordingStartIso
    || Date.parse(recordingStartIso) !== recordingStartEpochMs
  ) {
    throw new Error('Recording bundle status start clock is invalid');
  }
  return { flightId, recordingSessionId, recordingStartEpochMs, recordingStartIso };
}

function normalizeBaseName(value: unknown): string {
  const baseName = nonEmptyText(value);
  if (!baseName || path.basename(baseName) !== baseName || baseName === '.' || baseName === '..') {
    throw new Error('Recording bundle status basename is invalid');
  }
  if (/\.(?:csv|jsonl|json)$/i.test(baseName)) {
    throw new Error('Recording bundle status basename includes an artifact suffix');
  }
  return baseName;
}

function getBundleStatusPath(outputDir: string, bundleBaseName: string): string {
  return recordingBundleLayout.getBundlePaths(outputDir, normalizeBaseName(bundleBaseName)).status;
}

function getBundleStatusPathForCsv(csvPath: string): string {
  const statusPath = recordingBundleLayout.getArtifactPathForCsv(csvPath, 'status');
  if (!statusPath) throw new Error('Recording bundle status requires canonical telemetry.csv');
  return statusPath;
}

function expectedArtifactPaths(outputDir: string, bundleBaseName: string): Record<ArtifactRole, string> {
  const baseName = normalizeBaseName(bundleBaseName);
  const paths = recordingBundleLayout.getBundlePaths(outputDir, baseName);
  return {
    csv: paths.csv,
    automation: paths.automation,
    aircraftSpecific: paths.aircraftSpecific,
  };
}

function requireBundleForCsv(csvPath: string) {
  const bundle = recordingBundleLayout.getBundleFromCsvPath(csvPath);
  if (!bundle) throw new Error('Recording bundle requires canonical telemetry.csv');
  return bundle;
}

function inspectCatalogFingerprintSync(csvPath: string): {
  catalogRevision: number;
  bundleSizeBytes: number;
} {
  const resolvedCsvPath = path.resolve(csvPath);
  const bundle = requireBundleForCsv(resolvedCsvPath);
  const artifactPaths = expectedArtifactPaths(bundle.outputDir, bundle.bundleName);
  const entries: Array<[string, string]> = [
    ...ARTIFACT_DEFINITIONS.map(({ role }) => [role, artifactPaths[role]] as [string, string]),
    ['status', getBundleStatusPathForCsv(resolvedCsvPath)],
    // Mutable user analysis is not part of the immutable completion
    // certificate, but it must advance history/logbook cache identities.
    ['analysisRescore', bundle.paths.analysisRescore],
  ];
  const revisionParts: string[] = [];
  let bundleSizeBytes = 0;
  for (const [role, targetPath] of entries) {
    try {
      const stat = fs.lstatSync(targetPath);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        bundleSizeBytes += stat.size;
      }
      const revisionMetadata: Array<string | number> = [
        role,
        stat.isFile() ? 'file' : (stat.isSymbolicLink() ? 'symlink' : 'other'),
        stat.dev,
        stat.ino,
        stat.size,
        // ctime is intentionally excluded. On Windows it can drift after
        // metadata-only activity even when certified bytes and mtime remain
        // unchanged, which must not evict a healthy flight from the catalog.
        stat.mtimeMs,
      ];
      // This optional analysis file is atomically replaced. Include ctime as
      // an extra cache-buster for same-size rewrites on coarse-mtime filesystems.
      if (role === 'analysisRescore') revisionMetadata.push(stat.ctimeMs);
      revisionParts.push(revisionMetadata.join(':'));
    } catch (error) {
      const rawCode = nonEmptyText((error as NodeJS.ErrnoException)?.code);
      const safeCode = rawCode && /^[A-Z0-9_]+$/i.test(rawCode) ? rawCode : 'IO_ERROR';
      revisionParts.push(`${role}:error:${safeCode}`);
    }
  }
  return {
    catalogRevision: Number.parseInt(
      crypto.createHash('sha256').update(revisionParts.join('|')).digest('hex').slice(0, 12),
      16,
    ),
    bundleSizeBytes,
  };
}

function decodeUtf8Strict(buffer: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    const error = new Error(`${label} contains invalid UTF-8`) as NodeJS.ErrnoException;
    error.code = INVALID_UTF8_CODE;
    throw error;
  }
}

function findCsvLogicalRecordEnds(buffer: Buffer, count: number): number[] {
  const ends: number[] = [];
  let quoted = false;
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    if (byte === 0x22) {
      if (quoted && buffer[index + 1] === 0x22) {
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (byte === 0x0a && !quoted) {
      ends.push(index);
      if (ends.length === count) return ends;
    }
  }
  return ends;
}

function extractCsvManifestIdentity(prefix: Buffer): RecordingIdentity & { bundleStatusRequired: boolean } {
  const ends = findCsvLogicalRecordEnds(prefix, 2);
  if (ends.length < 2) throw new Error('CSV identity manifest exceeds the bounded status prefix');
  const stripCr = (value: Buffer) => value.length > 0 && value[value.length - 1] === 0x0d
    ? value.subarray(0, value.length - 1)
    : value;
  const headerText = decodeUtf8Strict(stripCr(prefix.subarray(0, ends[0])), 'CSV header');
  const manifestText = decodeUtf8Strict(stripCr(prefix.subarray(ends[0] + 1, ends[1])), 'CSV identity manifest');
  const headers = parseCsvLine(headerText, { trimValues: true });
  const values = parseCsvLine(manifestText, { trimValues: true });
  if (headers.length !== values.length) throw new Error('CSV identity manifest width does not match its header');
  const value = (name: string): string => {
    const index = headers.indexOf(name);
    return index >= 0 ? String(values[index] || '').trim() : '';
  };
  if (!headers.includes('recording_session_id') || value('record_type') !== 'RECORDING_MANIFEST') {
    throw new Error('CSV is not a manifest-era recording bundle');
  }
  const recordingStartIso = value('flight_start_iso');
  const identity = normalizeIdentity({
    flightId: value('flight_id'),
    recordingSessionId: value('recording_session_id'),
    recordingStartEpochMs: Date.parse(recordingStartIso),
    recordingStartIso,
  });
  const rawRequired = value('bundle_status_required').toLowerCase();
  if (rawRequired && !['0', '1', 'false', 'true'].includes(rawRequired)) {
    throw new Error('CSV identity manifest has an invalid bundle_status_required value');
  }
  return { ...identity, bundleStatusRequired: rawRequired === '1' || rawRequired === 'true' };
}

function inspectCsvManifestPrefix(prefix: Buffer): {
  strictBundle: boolean;
  identity: (RecordingIdentity & { bundleStatusRequired: boolean }) | null;
} {
  const ends = findCsvLogicalRecordEnds(prefix, 2);
  if (ends.length < 1) throw new Error('CSV header exceeds the bounded status prefix');
  const stripCr = (value: Buffer) => value.length > 0 && value[value.length - 1] === 0x0d
    ? value.subarray(0, value.length - 1)
    : value;
  const headers = parseCsvLine(
    decodeUtf8Strict(stripCr(prefix.subarray(0, ends[0])), 'CSV header'),
    { trimValues: true },
  );
  const values = parseCsvLine(
    decodeUtf8Strict(stripCr(prefix.subarray(ends[0] + 1, ends[1] ?? prefix.length)), 'CSV first row'),
    { trimValues: true },
  );
  const recordTypeIndex = headers.indexOf('record_type');
  const firstRowIsManifest = recordTypeIndex >= 0
    && String(values[recordTypeIndex] || '').trim() === 'RECORDING_MANIFEST';
  const statusIndex = headers.indexOf('bundle_status_required');
  const statusRaw = statusIndex >= 0
    ? String(values[statusIndex] || '').trim().toLowerCase()
    : '';
  if (statusRaw && !['0', '1', 'false', 'true'].includes(statusRaw)) {
    throw new Error('CSV first row has an invalid bundle_status_required value');
  }
  if (!firstRowIsManifest) {
    if (statusRaw === '1' || statusRaw === 'true') {
      throw new Error('Completion-required CSV must begin with a RECORDING_MANIFEST');
    }
    // Some legacy/test CSV headers acquired additive modern columns while the
    // files themselves remained SAMPLE-first. The completion protocol is
    // explicitly manifest-opt-in, so those remain legacy-compatible.
    return { strictBundle: false, identity: null };
  }
  return {
    strictBundle: true,
    identity: extractCsvManifestIdentity(prefix),
  };
}

function extractJsonlManifestIdentity(
  prefix: Buffer,
  expectedType: string,
): RecordingIdentity & { bundleStatusRequired: boolean } {
  const newline = prefix.indexOf(0x0a);
  if (newline < 0) throw new Error(`${expectedType} exceeds the bounded status prefix`);
  let line = prefix.subarray(0, newline);
  if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
  const parsed = JSON.parse(decodeUtf8Strict(line, expectedType));
  if (!isRecord(parsed) || parsed.type !== expectedType || parsed.seq !== 1) {
    throw new Error(`Sidecar must begin with ${expectedType} at seq 1`);
  }
  if (
    parsed.bundleStatusRequired !== undefined
    && typeof parsed.bundleStatusRequired !== 'boolean'
  ) {
    throw new Error(`${expectedType} has an invalid bundleStatusRequired value`);
  }
  const recordingStartIso = nonEmptyText(parsed.flightStartIso) || '';
  const identity = normalizeIdentity({
    flightId: parsed.flightId,
    recordingSessionId: parsed.recordingSessionId,
    recordingStartEpochMs: Date.parse(recordingStartIso),
    recordingStartIso,
  });
  return { ...identity, bundleStatusRequired: parsed.bundleStatusRequired === true };
}

function assertMatchingIdentity(
  actual: Partial<RecordingIdentity> & { bundleStatusRequired?: boolean },
  expected: RecordingIdentity,
  label: string,
  requireStatus: boolean,
): void {
  if (
    actual.flightId !== expected.flightId
    || actual.recordingSessionId !== expected.recordingSessionId
    || actual.recordingStartEpochMs !== expected.recordingStartEpochMs
    || actual.recordingStartIso !== expected.recordingStartIso
  ) {
    throw new Error(`${label} identity does not match the recording bundle`);
  }
  if (requireStatus && actual.bundleStatusRequired !== true) {
    throw new Error(`${label} does not opt in to durable bundle status`);
  }
}

async function hashArtifact(
  filePath: string,
  role: ArtifactRole,
  expectedIdentity?: RecordingIdentity,
): Promise<StatusArtifactObservation> {
  const pathStat = await fs.promises.lstat(filePath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(`${role} recording artifact is not a regular file`);
  }
  if (pathStat.size <= 0 || pathStat.size > MAX_DATA_ARTIFACT_BYTES) {
    throw new Error(`${role} recording artifact size is invalid`);
  }

  const handle = await fs.promises.open(filePath, 'r');
  const digest = crypto.createHash('sha256');
  const prefixChunks: Buffer[] = [];
  let prefixBytes = 0;
  let bytesReadTotal = 0;
  let stableMtimeMs = 0;
  let stableCtimeMs = 0;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== pathStat.dev
      || opened.ino !== pathStat.ino
      || opened.size !== pathStat.size
    ) {
      throw new Error(`${role} recording artifact changed while it was opened`);
    }
    const buffer = Buffer.allocUnsafe(HASH_READ_BYTES);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      bytesReadTotal += bytesRead;
      if (prefixBytes < MAX_IDENTITY_PREFIX_BYTES) {
        const retained = Buffer.from(chunk.subarray(0, MAX_IDENTITY_PREFIX_BYTES - prefixBytes));
        prefixChunks.push(retained);
        prefixBytes += retained.length;
      }
      if (bytesReadTotal > MAX_DATA_ARTIFACT_BYTES) {
        throw new Error(`${role} recording artifact exceeds the file cap`);
      }
    }
    const ended = await handle.stat();
    if (
      ended.dev !== opened.dev
      || ended.ino !== opened.ino
      || ended.size !== opened.size
      || ended.mtimeMs !== opened.mtimeMs
      || ended.ctimeMs !== opened.ctimeMs
      || bytesReadTotal !== opened.size
    ) {
      throw new Error(`${role} recording artifact changed while it was hashed`);
    }
    stableMtimeMs = ended.mtimeMs;
    stableCtimeMs = ended.ctimeMs;
  } finally {
    await handle.close();
  }

  const prefix = Buffer.concat(prefixChunks, prefixBytes);
  const definition = ARTIFACT_DEFINITIONS.find((entry) => entry.role === role)!;
  const identity = role === 'csv'
    ? extractCsvManifestIdentity(prefix)
    : extractJsonlManifestIdentity(prefix, definition.manifestType!);
  if (expectedIdentity) assertMatchingIdentity(identity, expectedIdentity, role, true);
  return {
    fileName: path.basename(filePath),
    sizeBytes: bytesReadTotal,
    sha256: digest.digest('hex'),
    mtimeMs: stableMtimeMs,
    ctimeMs: stableCtimeMs,
    identity,
  };
}

async function observeDegradedArtifact(filePath: string, role: ArtifactRole): Promise<DegradedArtifactCertificate> {
  try {
    const observation = await hashArtifact(filePath, role);
    return {
      state: 'present',
      fileName: observation.fileName,
      sizeBytes: observation.sizeBytes,
      sha256: observation.sha256,
      mtimeMs: observation.mtimeMs,
      ctimeMs: observation.ctimeMs,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return {
      state: code === 'ENOENT' ? 'missing' : 'unreadable',
      fileName: path.basename(filePath),
      error: sanitizeReason(code || error, 'artifact unavailable'),
    };
  }
}

async function readJsonlManifestIdentityFromFile(
  filePath: string,
  role: Exclude<ArtifactRole, 'csv'>,
): Promise<RecordingIdentity & { bundleStatusRequired: boolean }> {
  const definition = ARTIFACT_DEFINITIONS.find((entry) => entry.role === role)!;
  const pathStat = await fs.promises.lstat(filePath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size <= 0) {
    throw new Error(`${role} recording artifact is not a regular non-empty file`);
  }
  if (pathStat.size > MAX_DATA_ARTIFACT_BYTES) {
    throw new Error(`${role} recording artifact exceeds the file cap`);
  }
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== pathStat.dev
      || opened.ino !== pathStat.ino
      || opened.size !== pathStat.size
      || opened.mtimeMs !== pathStat.mtimeMs
      || opened.ctimeMs !== pathStat.ctimeMs
    ) {
      throw new Error(`${role} recording artifact changed while it was opened`);
    }
    const prefix = Buffer.allocUnsafe(Math.min(opened.size, MAX_IDENTITY_PREFIX_BYTES));
    let offset = 0;
    while (offset < prefix.length) {
      const { bytesRead } = await handle.read(prefix, offset, prefix.length - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    const ended = await handle.stat();
    if (
      ended.dev !== opened.dev
      || ended.ino !== opened.ino
      || ended.size !== opened.size
      || ended.mtimeMs !== opened.mtimeMs
      || ended.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`${role} recording artifact changed while its manifest was read`);
    }
    return extractJsonlManifestIdentity(prefix.subarray(0, offset), definition.manifestType!);
  } finally {
    await handle.close();
  }
}

function readOptionalJsonlManifestIdentityFromFileSync(
  filePath: string,
  role: Exclude<ArtifactRole, 'csv'>,
): (RecordingIdentity & { bundleStatusRequired: boolean }) | null {
  let pathStat: import('fs').Stats;
  try {
    pathStat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size <= 0) {
    throw new Error(`${role} recording artifact is not a regular non-empty file`);
  }
  if (pathStat.size > MAX_DATA_ARTIFACT_BYTES) {
    throw new Error(`${role} recording artifact exceeds the file cap`);
  }

  const definition = ARTIFACT_DEFINITIONS.find((entry) => entry.role === role)!;
  const fd = fs.openSync(filePath, 'r');
  try {
    const opened = fs.fstatSync(fd);
    const afterOpen = fs.lstatSync(filePath);
    if (
      !opened.isFile()
      || !afterOpen.isFile()
      || afterOpen.isSymbolicLink()
      || opened.dev !== pathStat.dev
      || opened.ino !== pathStat.ino
      || opened.size !== pathStat.size
      || afterOpen.dev !== pathStat.dev
      || afterOpen.ino !== pathStat.ino
    ) {
      throw new Error(`${role} recording artifact changed while it was opened`);
    }
    const prefix = Buffer.allocUnsafe(Math.min(opened.size, MAX_IDENTITY_PREFIX_BYTES));
    let offset = 0;
    while (offset < prefix.length) {
      const bytesRead = fs.readSync(fd, prefix, offset, prefix.length - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    const ended = fs.fstatSync(fd);
    const afterRead = fs.lstatSync(filePath);
    if (
      ended.dev !== opened.dev
      || ended.ino !== opened.ino
      || ended.size !== opened.size
      || ended.mtimeMs !== opened.mtimeMs
      || ended.ctimeMs !== opened.ctimeMs
      || afterRead.dev !== opened.dev
      || afterRead.ino !== opened.ino
      || afterRead.size !== opened.size
      || afterRead.mtimeMs !== opened.mtimeMs
      || afterRead.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`${role} recording artifact changed while it was read`);
    }
    return extractJsonlManifestIdentity(prefix.subarray(0, offset), definition.manifestType!);
  } finally {
    fs.closeSync(fd);
  }
}

function pathEntryExistsSync(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

async function verifyRecordingBundleStatusWithCsvBuffer(
  csvPath: string,
  csvBuffer: Buffer,
): Promise<BundleStatusReadResult & { required: boolean; strictBundle: boolean }> {
  try {
    if (!Buffer.isBuffer(csvBuffer) || csvBuffer.length <= 0 || csvBuffer.length > MAX_DATA_ARTIFACT_BYTES) {
      throw new Error('CSV bytes are missing or exceed the file cap');
    }
    const prefix = csvBuffer.subarray(0, Math.min(csvBuffer.length, MAX_IDENTITY_PREFIX_BYTES));
    const inspected = inspectCsvManifestPrefix(prefix);
    if (!inspected.strictBundle || !inspected.identity) {
      return {
        statusPath: getBundleStatusPathForCsv(csvPath),
        exists: false,
        state: 'complete',
        healthy: true,
        required: false,
        strictBundle: false,
      };
    }

    const identity = inspected.identity;
    const bundle = requireBundleForCsv(csvPath);
    const paths = expectedArtifactPaths(bundle.outputDir, bundle.bundleName);
    if (!identity.bundleStatusRequired) {
      if (fs.existsSync(getBundleStatusPathForCsv(csvPath))) {
        throw new Error('CSV durable completion requirement disagrees with its bundle status certificate');
      }
      const [automationIdentity, aircraftIdentity] = await Promise.all([
        readJsonlManifestIdentityFromFile(paths.automation, 'automation').catch((error) => (
          (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : Promise.reject(error)
        )),
        readJsonlManifestIdentityFromFile(paths.aircraftSpecific, 'aircraftSpecific').catch((error) => (
          (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : Promise.reject(error)
        )),
      ]);
      if (automationIdentity) assertMatchingIdentity(automationIdentity, identity, 'automation', false);
      if (aircraftIdentity) assertMatchingIdentity(aircraftIdentity, identity, 'aircraftSpecific', false);
      if (automationIdentity?.bundleStatusRequired || aircraftIdentity?.bundleStatusRequired) {
        throw new Error('Recording bundle members disagree about durable completion status');
      }
      return {
        statusPath: getBundleStatusPathForCsv(csvPath),
        exists: false,
        state: 'complete',
        healthy: true,
        required: false,
        strictBundle: true,
      };
    }

    const [automation, aircraftSpecific] = await Promise.all([
      hashArtifact(paths.automation, 'automation', identity),
      hashArtifact(paths.aircraftSpecific, 'aircraftSpecific', identity),
    ]);
    const result = readRecordingBundleStatusSync(csvPath, {
      expectedIdentity: identity,
      artifacts: {
        csv: {
          fileName: path.basename(csvPath),
          sizeBytes: csvBuffer.length,
          sha256: crypto.createHash('sha256').update(csvBuffer).digest('hex'),
          identity,
        },
        automation,
        aircraftSpecific,
      },
    });
    return { ...result, required: true, strictBundle: true };
  } catch (error) {
    return {
      statusPath: getBundleStatusPathForCsv(csvPath),
      exists: fs.existsSync(getBundleStatusPathForCsv(csvPath)),
      state: 'corrupt',
      healthy: false,
      required: true,
      strictBundle: true,
      error: publicReadError(error, 'Recording bundle could not be verified'),
    };
  }
}

function writeFullySync(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, null);
    if (written <= 0) throw new Error('Bundle status write made no progress');
    offset += written;
  }
}

function syncDirectoryBestEffort(directory: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    // Node/Windows and some network filesystems cannot fsync directory handles.
    // The certificate file itself was fsynced and published by a same-directory
    // hard link; unsupported directory sync is the strongest available result.
    if (!['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(String(code || ''))) {
      throw error;
    }
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function publishCertificateNoReplace(statusPath: string, certificate: BundleStatusCertificate): void {
  const directory = path.dirname(statusPath);
  const tempPath = `${statusPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const bytes = Buffer.from(`${JSON.stringify(certificate)}\n`, 'utf8');
  if (bytes.length > MAX_BUNDLE_STATUS_BYTES) throw new Error('Recording bundle status exceeds its size cap');
  let fd: number | null = null;
  let linked = false;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    writeFullySync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.linkSync(tempPath, statusPath);
    linked = true;
    syncDirectoryBestEffort(directory);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
    if (linked) syncDirectoryBestEffort(directory);
  }
}

async function publishRecordingBundleStatus(
  options: PublishBundleStatusOptions,
): Promise<BundleStatusCertificate> {
  if (options.status !== 'complete' && options.status !== 'degraded') {
    throw new Error('Recording bundle status publication state is invalid');
  }
  const identity = normalizeIdentity(options);
  const outputDir = path.resolve(options.outputDir);
  const bundleBaseName = normalizeBaseName(options.bundleBaseName);
  const paths = expectedArtifactPaths(outputDir, bundleBaseName);
  const finalizedAtEpochMs = Number(options.finalizedAtEpochMs);
  const finalizedAtIso = options.finalizedAtIso || new Date(finalizedAtEpochMs).toISOString();
  if (
    !Number.isSafeInteger(finalizedAtEpochMs)
    || finalizedAtEpochMs < identity.recordingStartEpochMs
    || Date.parse(finalizedAtIso) !== finalizedAtEpochMs
  ) {
    throw new Error('Recording bundle finalization clock is invalid');
  }

  let artifacts: BundleStatusCertificate['artifacts'];
  if (options.status === 'complete') {
    const observations = await Promise.all(ARTIFACT_DEFINITIONS.map(({ role }) => (
      hashArtifact(paths[role], role, identity)
    )));
    artifacts = Object.fromEntries(observations.map((observation, index) => [
      ARTIFACT_DEFINITIONS[index].role,
      {
        state: 'present',
        fileName: observation.fileName,
        sizeBytes: observation.sizeBytes,
        sha256: observation.sha256,
        mtimeMs: observation.mtimeMs!,
        ctimeMs: observation.ctimeMs!,
      },
    ])) as BundleStatusCertificate['artifacts'];
  } else {
    const observations = await Promise.all(ARTIFACT_DEFINITIONS.map(({ role }) => (
      observeDegradedArtifact(paths[role], role)
    )));
    artifacts = Object.fromEntries(observations.map((observation, index) => [
      ARTIFACT_DEFINITIONS[index].role,
      observation,
    ])) as BundleStatusCertificate['artifacts'];
  }

  const certificate: BundleStatusCertificate = {
    schemaVersion: BUNDLE_STATUS_SCHEMA_VERSION,
    layoutVersion: recordingBundleLayout.BUNDLE_LAYOUT_VERSION as 2,
    type: 'recording_bundle_status',
    status: options.status,
    ...identity,
    bundleBaseName,
    finalizedAtEpochMs,
    finalizedAtIso,
    endReason: sanitizeReason(options.endReason, 'unknown'),
    ...(options.status === 'degraded'
      ? { degradedReason: sanitizeReason(options.degradedReason, 'recording member failed') }
      : {}),
    artifacts,
  };
  publishCertificateNoReplace(getBundleStatusPath(outputDir, bundleBaseName), certificate);
  return certificate;
}

function readCertificateSync(statusPath: string): BundleStatusCertificate {
  const pathStat = fs.lstatSync(statusPath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error('Recording bundle status is not a regular file');
  }
  if (pathStat.size <= 0 || pathStat.size > MAX_BUNDLE_STATUS_BYTES) {
    throw new Error('Recording bundle status size is invalid');
  }
  const fd = fs.openSync(statusPath, 'r');
  let buffer: Buffer;
  try {
    const opened = fs.fstatSync(fd);
    if (
      opened.dev !== pathStat.dev
      || opened.ino !== pathStat.ino
      || opened.size !== pathStat.size
      || opened.mtimeMs !== pathStat.mtimeMs
      || opened.ctimeMs !== pathStat.ctimeMs
    ) {
      throw new Error('Recording bundle status changed while it was opened');
    }
    buffer = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read <= 0) throw new Error('Recording bundle status ended before its committed size');
      offset += read;
    }
    const ended = fs.fstatSync(fd);
    if (
      ended.dev !== opened.dev
      || ended.ino !== opened.ino
      || ended.size !== opened.size
      || ended.mtimeMs !== opened.mtimeMs
      || ended.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error('Recording bundle status changed while it was read');
    }
  } finally {
    fs.closeSync(fd);
  }
  const text = decodeUtf8Strict(buffer, 'Recording bundle status');
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n') || text.slice(0, -1).includes('\r')) {
    throw new Error('Recording bundle status is torn or has an invalid commit delimiter');
  }
  const parsed = JSON.parse(text.slice(0, -1));
  if (!isRecord(parsed)) throw new Error('Recording bundle status is not an object');
  return parsed as BundleStatusCertificate;
}

function readCsvIdentityPrefixSync(csvPath: string): Buffer {
  const pathStat = fs.lstatSync(csvPath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size <= 0) {
    throw new Error('CSV is not a regular non-empty file');
  }
  if (pathStat.size > MAX_DATA_ARTIFACT_BYTES) throw new Error('CSV exceeds the file cap');
  const fd = fs.openSync(csvPath, 'r');
  try {
    const opened = fs.fstatSync(fd);
    if (
      opened.dev !== pathStat.dev
      || opened.ino !== pathStat.ino
      || opened.size !== pathStat.size
      || opened.mtimeMs !== pathStat.mtimeMs
      || opened.ctimeMs !== pathStat.ctimeMs
    ) {
      throw new Error('CSV changed while it was opened');
    }
    const prefix = Buffer.allocUnsafe(Math.min(opened.size, MAX_IDENTITY_PREFIX_BYTES));
    let offset = 0;
    while (offset < prefix.length) {
      const bytesRead = fs.readSync(fd, prefix, offset, prefix.length - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    const ended = fs.fstatSync(fd);
    if (
      ended.dev !== opened.dev
      || ended.ino !== opened.ino
      || ended.size !== opened.size
      || ended.mtimeMs !== opened.mtimeMs
      || ended.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error('CSV changed while its identity manifest was read');
    }
    return prefix.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
}

function validateCertificateShape(certificate: BundleStatusCertificate, csvPath: string): RecordingIdentity {
  if (
    certificate.schemaVersion !== BUNDLE_STATUS_SCHEMA_VERSION
    || certificate.layoutVersion !== recordingBundleLayout.BUNDLE_LAYOUT_VERSION
    || certificate.type !== 'recording_bundle_status'
    || !['complete', 'degraded'].includes(certificate.status)
  ) {
    throw new Error('Recording bundle status schema or state is unsupported');
  }
  const identity = normalizeIdentity(certificate);
  const baseName = normalizeBaseName(certificate.bundleBaseName);
  const bundle = requireBundleForCsv(csvPath);
  const expectedCsvPath = recordingBundleLayout.getBundlePaths(bundle.outputDir, baseName).csv;
  if (comparablePath(expectedCsvPath) !== comparablePath(csvPath)) {
    throw new Error('Recording bundle status basename does not match the CSV');
  }
  if (
    !Number.isSafeInteger(certificate.finalizedAtEpochMs)
    || certificate.finalizedAtEpochMs < identity.recordingStartEpochMs
    || Date.parse(certificate.finalizedAtIso) !== certificate.finalizedAtEpochMs
    || !nonEmptyText(certificate.endReason)
  ) {
    throw new Error('Recording bundle status finalization clock is invalid');
  }
  if (!isRecord(certificate.artifacts)) throw new Error('Recording bundle status artifacts are missing');
  const expectedPaths = expectedArtifactPaths(bundle.outputDir, baseName);
  for (const { role } of ARTIFACT_DEFINITIONS) {
    const artifact = certificate.artifacts[role];
    if (!isRecord(artifact) || artifact.fileName !== path.basename(expectedPaths[role])) {
      throw new Error(`Recording bundle status ${role} member is invalid`);
    }
    if (certificate.status === 'complete') {
      if (
        artifact.state !== 'present'
        || !Number.isSafeInteger(artifact.sizeBytes)
        || artifact.sizeBytes <= 0
        || artifact.sizeBytes > MAX_DATA_ARTIFACT_BYTES
        || typeof artifact.sha256 !== 'string'
        || !SHA256_RE.test(artifact.sha256)
        || !Number.isFinite(artifact.mtimeMs)
        || !Number.isFinite(artifact.ctimeMs)
      ) {
        throw new Error(`Recording bundle status ${role} digest is invalid`);
      }
    } else {
      const degradedArtifact = artifact as DegradedArtifactCertificate;
      if (!['present', 'missing', 'unreadable'].includes(String(degradedArtifact.state || ''))) {
        throw new Error(`Degraded recording bundle status ${role} state is invalid`);
      }
      if (degradedArtifact.state === 'present') {
        if (
          !Number.isSafeInteger(degradedArtifact.sizeBytes)
          || Number(degradedArtifact.sizeBytes) <= 0
          || Number(degradedArtifact.sizeBytes) > MAX_DATA_ARTIFACT_BYTES
          || typeof degradedArtifact.sha256 !== 'string'
          || !SHA256_RE.test(degradedArtifact.sha256)
          || !Number.isFinite(degradedArtifact.mtimeMs)
          || !Number.isFinite(degradedArtifact.ctimeMs)
          || degradedArtifact.error !== undefined
        ) {
          throw new Error(`Degraded recording bundle status ${role} observation is invalid`);
        }
      } else if (
        degradedArtifact.sizeBytes !== undefined
        || degradedArtifact.sha256 !== undefined
        || degradedArtifact.mtimeMs !== undefined
        || degradedArtifact.ctimeMs !== undefined
        || !nonEmptyText(degradedArtifact.error)
      ) {
        throw new Error(`Degraded recording bundle status ${role} failure observation is invalid`);
      }
    }
  }
  if (certificate.status === 'complete' && certificate.degradedReason !== undefined) {
    throw new Error('Complete recording bundle status must not contain a degraded reason');
  }
  if (certificate.status === 'degraded' && !nonEmptyText(certificate.degradedReason)) {
    throw new Error('Degraded recording bundle status is missing its reason');
  }
  return identity;
}

function inspectCsvBundleForCatalogSync(csvPath: string): {
  allowed: boolean;
  required: boolean;
  state: string;
  catalogRevision?: number;
  bundleSizeBytes?: number;
  recordingSessionId?: string;
  recordingFlightId?: string;
  error?: string;
} {
  try {
    const inspected = inspectCsvManifestPrefix(readCsvIdentityPrefixSync(csvPath));
    if (!inspected.strictBundle || !inspected.identity) {
      return {
        allowed: true,
        required: false,
        state: 'not_required',
        ...inspectCatalogFingerprintSync(csvPath),
      };
    }
    if (!inspected.identity.bundleStatusRequired) {
      const catalogIdentity = {
        recordingSessionId: inspected.identity.recordingSessionId,
        recordingFlightId: inspected.identity.flightId,
      };
      const fingerprint = inspectCatalogFingerprintSync(csvPath);
      if (pathEntryExistsSync(getBundleStatusPathForCsv(csvPath))) {
        return {
          allowed: false,
          required: true,
          state: 'corrupt',
          error: 'CSV durable completion requirement disagrees with its status certificate.',
          ...catalogIdentity,
          ...fingerprint,
        };
      }
      const bundle = requireBundleForCsv(csvPath);
      const artifactPaths = expectedArtifactPaths(bundle.outputDir, bundle.bundleName);
      const automationIdentity = readOptionalJsonlManifestIdentityFromFileSync(
        artifactPaths.automation,
        'automation',
      );
      const aircraftIdentity = readOptionalJsonlManifestIdentityFromFileSync(
        artifactPaths.aircraftSpecific,
        'aircraftSpecific',
      );
      if (automationIdentity) assertMatchingIdentity(automationIdentity, inspected.identity, 'automation', false);
      if (aircraftIdentity) assertMatchingIdentity(aircraftIdentity, inspected.identity, 'aircraftSpecific', false);
      if (automationIdentity?.bundleStatusRequired || aircraftIdentity?.bundleStatusRequired) {
        throw new Error('Recording bundle members disagree about durable completion status');
      }
      return {
        allowed: true,
        required: false,
        state: 'not_required',
        ...catalogIdentity,
        ...fingerprint,
      };
    }
    const status = inspectRecordingBundleStatusSync(csvPath, inspected.identity);
    return {
      allowed: status.state === 'complete',
      required: true,
      state: status.state,
      recordingSessionId: inspected.identity.recordingSessionId,
      recordingFlightId: inspected.identity.flightId,
      ...(Number.isSafeInteger(status.catalogRevision)
        ? { catalogRevision: status.catalogRevision, bundleSizeBytes: status.bundleSizeBytes }
        : {}),
      ...(status.error ? { error: status.error } : {}),
    };
  } catch (error) {
    let fingerprint: { catalogRevision?: number; bundleSizeBytes?: number } = {};
    try {
      fingerprint = inspectCatalogFingerprintSync(csvPath);
    } catch {}
    return {
      allowed: false,
      required: true,
      state: 'corrupt',
      error: publicReadError(error, 'Recording bundle could not be inspected'),
      ...fingerprint,
    };
  }
}

function readRecordingBundleStatusSync(
  csvPath: string,
  options?: VerifyBundleStatusOptions,
): BundleStatusReadResult {
  const statusPath = getBundleStatusPathForCsv(csvPath);
  try {
    const certificate = readCertificateSync(statusPath);
    const identity = validateCertificateShape(certificate, csvPath);
    if (certificate.status === 'degraded') {
      if (options) assertMatchingIdentity(identity, options.expectedIdentity, 'Bundle status', false);
      return {
        statusPath,
        exists: true,
        state: 'degraded',
        healthy: false,
        certificate,
        error: `Recording bundle finalized in a degraded state: ${certificate.degradedReason}`,
      };
    }
    if (options) {
      assertMatchingIdentity(identity, options.expectedIdentity, 'Bundle status', false);
      for (const { role } of ARTIFACT_DEFINITIONS) {
        const expected = certificate.artifacts[role] as ArtifactCertificate;
        const actual = options.artifacts[role];
        if (
          !actual
          || actual.fileName !== expected.fileName
          || actual.sizeBytes !== expected.sizeBytes
          || actual.sha256 !== expected.sha256
        ) {
          throw new Error(`Recording bundle ${role} bytes do not match the durable completion status`);
        }
        if (actual.identity) {
          assertMatchingIdentity(actual.identity, options.expectedIdentity, role, true);
        }
      }
    }
    return { statusPath, exists: true, state: 'complete', healthy: true, certificate };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return {
        statusPath,
        exists: false,
        state: 'incomplete',
        healthy: false,
        error: 'Recording bundle has no durable completion status; it is incomplete or crash-recovered.',
      };
    }
    return {
      statusPath,
      exists: true,
      state: 'corrupt',
      healthy: false,
      error: (error as NodeJS.ErrnoException)?.code === INVALID_UTF8_CODE
        ? 'Recording bundle status contains invalid UTF-8.'
        : publicReadError(error, 'Recording bundle status could not be read'),
    };
  }
}

function inspectRecordingBundleStatusSync(
  csvPath: string,
  expectedIdentity: RecordingIdentity,
): BundleStatusReadResult {
  const result = readRecordingBundleStatusSync(csvPath);
  if (!result.certificate || result.state !== 'complete') {
    return { ...result, ...inspectCatalogFingerprintSync(csvPath) };
  }
  try {
    const certificateIdentity = normalizeIdentity(result.certificate);
    assertMatchingIdentity(certificateIdentity, expectedIdentity, 'Bundle status', false);
    const baseName = normalizeBaseName(result.certificate.bundleBaseName);
    const bundle = requireBundleForCsv(csvPath);
    const artifactPaths = expectedArtifactPaths(bundle.outputDir, baseName);
    const revisionParts: string[] = [];
    let bundleSizeBytes = 0;
    for (const { role } of ARTIFACT_DEFINITIONS) {
      const artifact = result.certificate.artifacts[role] as ArtifactCertificate;
      const stat = fs.lstatSync(artifactPaths[role]);
      // The quick catalog gate uses stable file identity and modification
      // metadata. Full reads below still hash every artifact against the
      // durable certificate before consuming its contents.
      if (
        !stat.isFile()
        || stat.isSymbolicLink()
        || stat.size !== artifact.sizeBytes
        || stat.mtimeMs !== artifact.mtimeMs
      ) {
        throw new Error(`Recording bundle ${role} member does not match its completion status`);
      }
      bundleSizeBytes += stat.size;
      revisionParts.push([
        role,
        stat.dev,
        stat.ino,
        stat.size,
        stat.mtimeMs,
      ].join(':'));
    }
    const statusStat = fs.lstatSync(result.statusPath);
    bundleSizeBytes += statusStat.size;
    revisionParts.push([
      'status',
      statusStat.dev,
      statusStat.ino,
      statusStat.size,
      statusStat.mtimeMs,
      statusStat.ctimeMs,
    ].join(':'));
    try {
      const rescoreStat = fs.lstatSync(bundle.paths.analysisRescore);
      const rescoreKind = rescoreStat.isFile()
        ? (rescoreStat.isSymbolicLink() ? 'symlink' : 'file')
        : 'other';
      if (rescoreKind === 'file') bundleSizeBytes += rescoreStat.size;
      revisionParts.push([
        'analysisRescore',
        rescoreKind,
        rescoreStat.dev,
        rescoreStat.ino,
        rescoreStat.size,
        rescoreStat.mtimeMs,
        rescoreStat.ctimeMs,
      ].join(':'));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      revisionParts.push(`analysisRescore:${code === 'ENOENT' ? 'missing' : 'unreadable'}`);
    }
    const catalogRevision = Number.parseInt(
      crypto.createHash('sha256').update(revisionParts.join('|')).digest('hex').slice(0, 12),
      16,
    );
    return { ...result, catalogRevision, bundleSizeBytes };
  } catch (error) {
    let fingerprint: { catalogRevision?: number; bundleSizeBytes?: number } = {};
    try {
      fingerprint = inspectCatalogFingerprintSync(csvPath);
    } catch {}
    return {
      ...result,
      ...fingerprint,
      state: 'corrupt',
      healthy: false,
      error: publicReadError(error, 'Recording bundle files could not be inspected'),
    };
  }
}

module.exports = {
  getBundleStatusPath,
  inspectRecordingBundleStatusSync,
  inspectCsvBundleForCatalogSync,
  publishRecordingBundleStatus,
  readRecordingBundleStatusSync,
  verifyRecordingBundleStatusWithCsvBuffer,
  _hashArtifact: hashArtifact,
};

export {};
