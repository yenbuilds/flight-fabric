'use strict';

/**
 * One-off development-data migration from the pre-release flat Flight Logs
 * layout to canonical per-flight bundle directories.  Production discovery
 * intentionally does not depend on this module.
 */

const crypto = require('crypto') as typeof import('crypto');
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const { parseCsvLine, splitCsvLines } = require('../utils/csv.js') as {
  parseCsvLine: (_line: string, _options?: { trimValues?: boolean }) => string[];
  splitCsvLines: (_content: string, _options?: { trimAndDropEmpty?: boolean }) => string[];
};
const recordingBundleLayout = require('./recording-bundle-layout.js') as {
  BUNDLE_FILES: Record<string, string>;
  buildBundleName: (_flightId: unknown, _sessionId: unknown) => string;
  getBundlePaths: (_outputDir: string, _bundleName: string) => Record<string, string> & { dir: string; csv: string };
};
const recordingBundleLifecycle = require('./recording-bundle-lifecycle.js') as {
  allocateBundleBaseName: (_outputDir: string, _preferredName: string) => string;
};
const {
  acquireExclusiveFlightLogsMutationLease,
} = require('./recording-bundle-lease.js') as {
  acquireExclusiveFlightLogsMutationLease: (_options: Record<string, any>) =>
    | { acquired: true; release: () => boolean }
    | { acquired: false; reason: string; error?: string };
};
const {
  inspectCsvBundleForCatalogSync,
  publishRecordingBundleStatus,
} = require('./recording-bundle-status.js') as {
  inspectCsvBundleForCatalogSync: (_csvPath: string) => Record<string, any>;
  publishRecordingBundleStatus: (_options: Record<string, any>) => Promise<Record<string, any>>;
};
const {
  writeHistorySummary,
} = require('../history-index/history-summary-sidecar.js') as {
  writeHistorySummary: (_source: Record<string, any>, _result: Record<string, any>) => boolean;
};

type AnyRecord = Record<string, any>;
type FileIdentity = { dev: number; ino: number; size: number; mtimeMs: number };
type MigrationResult = {
  migrated: number;
  skipped: number;
  failed: number;
  details: Array<{ source: string; destination?: string; status: string; error?: string }>;
};
type FlatFlightInspection = {
  csvIdentity: AnyRecord;
  legacy: Record<string, string>;
  oldStatus: AnyRecord | null;
  oldSummary: AnyRecord | null;
  derivedIdentities: Array<{ filePath: string; identity: FileIdentity }>;
  sourceBytes: number;
};
type MigrationInspectionResult = {
  ready: number;
  failed: number;
  totalBytes: number;
  details: Array<{ source: string; status: 'ready' | 'failed'; bytes?: number; error?: string }>;
};

const LEGACY_SUFFIXES = Object.freeze({
  automation: '.automation.jsonl',
  aircraftSpecific: '.aircraft-specific.jsonl',
  status: '.bundle-status.json',
  summary: '.history-summary.json',
  timeline: '.timeline.json',
});

function captureRegularIdentity(filePath: string): FileIdentity {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Migration source is not a regular file');
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function identitiesMatch(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function readPrefix(filePath: string, maxBytes = 256 * 1024): string {
  const identity = captureRegularIdentity(filePath);
  const fd = fs.openSync(filePath, 'r');
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== identity.dev || opened.ino !== identity.ino || opened.size !== identity.size) {
      throw new Error('Migration source changed while it was opened');
    }
    const buffer = Buffer.alloc(Math.min(opened.size, maxBytes));
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return buffer.toString('utf8', 0, offset);
  } finally {
    fs.closeSync(fd);
  }
}

function readLegacyCsvIdentity(csvPath: string): AnyRecord {
  const lines = splitCsvLines(readPrefix(csvPath), { trimAndDropEmpty: true });
  if (lines.length < 2) throw new Error('CSV identity row is missing');
  const headers = parseCsvLine(lines[0], { trimValues: true });
  const values = parseCsvLine(lines[1], { trimValues: true });
  const value = (name: string) => {
    const index = headers.indexOf(name);
    return index >= 0 ? String(values[index] || '').trim() : '';
  };
  const rawStartIso = value('flight_start_iso') || value('timestamp_utc');
  const parsedStartMs = Date.parse(rawStartIso);
  const stat = fs.lstatSync(csvPath);
  const recordingStartEpochMs = Number.isFinite(parsedStartMs) ? parsedStartMs : Math.floor(stat.mtimeMs);
  const recordingStartIso = new Date(recordingStartEpochMs).toISOString();
  return {
    flightId: value('flight_id') || recordingStartIso,
    recordingSessionId: value('recording_session_id') || '',
    recordingStartEpochMs,
    recordingStartIso,
    bundleStatusRequired: ['1', 'true'].includes(value('bundle_status_required').toLowerCase()),
  };
}

function readLegacyJsonlIdentity(filePath: string): AnyRecord | null {
  if (!fs.existsSync(filePath)) return null;
  const line = readPrefix(filePath).split(/\r?\n/).find((entry) => entry.trim());
  if (!line) return null;
  const row = JSON.parse(line);
  return {
    flightId: String(row.flightId || ''),
    recordingSessionId: String(row.recordingSessionId || ''),
    recordingStartIso: String(row.flightStartIso || row.recordingStartIso || ''),
  };
}

function assertCompanionIdentity(csvIdentity: AnyRecord, sidecarPath: string): void {
  if (!fs.existsSync(sidecarPath)) return;
  const stat = fs.lstatSync(sidecarPath);
  if (stat.size === 0) return;
  const sidecar = readLegacyJsonlIdentity(sidecarPath);
  if (!sidecar) throw new Error('Recording companion identity is missing');
  if (
    sidecar.flightId !== csvIdentity.flightId
    || sidecar.recordingStartIso !== csvIdentity.recordingStartIso
    || (csvIdentity.recordingSessionId && sidecar.recordingSessionId !== csvIdentity.recordingSessionId)
  ) throw new Error('Recording companion identity does not match the CSV');
}

function readLegacySummary(summaryPath: string, csvBasename: string): AnyRecord | null {
  if (!fs.existsSync(summaryPath)) return null;
  try {
    const stat = captureRegularIdentity(summaryPath);
    if (stat.size <= 0 || stat.size > 8 * 1024 * 1024) return null;
    const parsed = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    if (parsed?.schemaVersion !== 1 || parsed?.source?.csvBasename !== csvBasename) return null;
    if (!Array.isArray(parsed.landings)) return null;
    return { flight: parsed.flight || null, landings: parsed.landings };
  } catch {
    return null;
  }
}

function readOwnedLegacyStatus(statusPath: string, csvIdentity: AnyRecord): AnyRecord | null {
  if (!fs.existsSync(statusPath)) return null;
  const stat = captureRegularIdentity(statusPath);
  if (stat.size <= 0 || stat.size > 64 * 1024) {
    throw new Error('Legacy bundle status is not a safe bounded file');
  }
  const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  if (
    !parsed
    || parsed.type !== 'recording_bundle_status'
    || parsed.flightId !== csvIdentity.flightId
    || parsed.recordingSessionId !== csvIdentity.recordingSessionId
    || parsed.recordingStartIso !== csvIdentity.recordingStartIso
  ) {
    throw new Error('Legacy bundle status identity does not match the CSV');
  }
  return parsed;
}

function hashRegularFile(filePath: string): string {
  const digest = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    let position = 0;
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  return digest.digest('hex');
}

function copyVerified(sourcePath: string, destinationPath: string): FileIdentity {
  const identity = captureRegularIdentity(sourcePath);
  const sourceHash = hashRegularFile(sourcePath);
  const afterHashIdentity = captureRegularIdentity(sourcePath);
  if (!identitiesMatch(identity, afterHashIdentity) || identity.mtimeMs !== afterHashIdentity.mtimeMs) {
    throw new Error('Migration source changed while it was hashed');
  }
  fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
  const copied = captureRegularIdentity(destinationPath);
  if (copied.size !== identity.size || hashRegularFile(destinationPath) !== sourceHash) {
    throw new Error('Migrated artifact copy did not match its source bytes');
  }
  const afterCopyIdentity = captureRegularIdentity(sourcePath);
  if (!identitiesMatch(identity, afterCopyIdentity) || identity.mtimeMs !== afterCopyIdentity.mtimeMs) {
    throw new Error('Migration source changed while it was copied');
  }
  return identity;
}

function unlinkIfStillOwned(filePath: string, identity: FileIdentity): boolean {
  try {
    const current = captureRegularIdentity(filePath);
    if (!identitiesMatch(identity, current)) return false;
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function legacyPaths(rootDir: string, csvName: string): Record<string, string> {
  const base = csvName.slice(0, -4);
  return {
    csv: path.join(rootDir, csvName),
    automation: path.join(rootDir, `${base}${LEGACY_SUFFIXES.automation}`),
    aircraftSpecific: path.join(rootDir, `${base}${LEGACY_SUFFIXES.aircraftSpecific}`),
    status: path.join(rootDir, `${base}${LEGACY_SUFFIXES.status}`),
    summary: path.join(rootDir, `${base}${LEGACY_SUFFIXES.summary}`),
    timeline: path.join(rootDir, `${base}${LEGACY_SUFFIXES.timeline}`),
  };
}

function makePreferredBundleName(csvIdentity: AnyRecord, csvName: string): string {
  const stableToken = csvIdentity.recordingSessionId || crypto
    .createHash('sha256')
    .update(`legacy-flight-bundle:${csvName}`)
    .digest('hex');
  return recordingBundleLayout.buildBundleName(csvIdentity.recordingStartIso, stableToken);
}

function listFlatCsvNames(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.toLowerCase().endsWith('.csv'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function assertSafeMigrationRoot(rootDir: string): string {
  const root = path.resolve(rootDir);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Flight Logs migration root is not a safe directory');
  }
  return root;
}

function inspectOneFlatFlight(rootDir: string, csvName: string): FlatFlightInspection {
  const root = path.resolve(rootDir);
  if (path.basename(csvName) !== csvName || !csvName.toLowerCase().endsWith('.csv')) {
    throw new Error('Migration requires a direct-child CSV name');
  }
  const legacy = legacyPaths(root, csvName);
  const csvIdentity = readLegacyCsvIdentity(legacy.csv);
  assertCompanionIdentity(csvIdentity, legacy.automation);
  assertCompanionIdentity(csvIdentity, legacy.aircraftSpecific);

  const derivedIdentities: Array<{ filePath: string; identity: FileIdentity }> = [];
  const summaryIdentity = fs.existsSync(legacy.summary) ? captureRegularIdentity(legacy.summary) : null;
  const oldSummary = readLegacySummary(legacy.summary, csvName);
  if (summaryIdentity) {
    const afterRead = captureRegularIdentity(legacy.summary);
    if (!identitiesMatch(summaryIdentity, afterRead) || summaryIdentity.mtimeMs !== afterRead.mtimeMs) {
      throw new Error('Legacy history summary changed while it was inspected');
    }
    derivedIdentities.push({ filePath: legacy.summary, identity: summaryIdentity });
  }
  if (fs.existsSync(legacy.summary) && !oldSummary) {
    throw new Error('Legacy history summary is not owned by the CSV');
  }

  const statusIdentity = fs.existsSync(legacy.status) ? captureRegularIdentity(legacy.status) : null;
  const oldStatus = readOwnedLegacyStatus(legacy.status, csvIdentity);
  if (statusIdentity) {
    const afterRead = captureRegularIdentity(legacy.status);
    if (!identitiesMatch(statusIdentity, afterRead) || statusIdentity.mtimeMs !== afterRead.mtimeMs) {
      throw new Error('Legacy bundle status changed while it was inspected');
    }
    derivedIdentities.push({ filePath: legacy.status, identity: statusIdentity });
  }
  if (csvIdentity.bundleStatusRequired && !oldStatus) {
    throw new Error('Durable legacy recording is missing its owned completion status');
  }

  let sourceBytes = 0;
  for (const role of ['csv', 'automation', 'aircraftSpecific', 'timeline']) {
    const filePath = legacy[role];
    if (!fs.existsSync(filePath)) continue;
    sourceBytes += captureRegularIdentity(filePath).size;
  }
  return { csvIdentity, legacy, oldStatus, oldSummary, derivedIdentities, sourceBytes };
}

async function migrateOneFlatFlight(rootDir: string, csvName: string): Promise<{ destination: string }> {
  const root = path.resolve(rootDir);
  const {
    legacy,
    csvIdentity,
    oldSummary,
    oldStatus,
    derivedIdentities,
  } = inspectOneFlatFlight(root, csvName);
  const preferredName = makePreferredBundleName(csvIdentity, csvName);
  const bundleName = recordingBundleLifecycle.allocateBundleBaseName(root, preferredName);
  const destination = recordingBundleLayout.getBundlePaths(root, bundleName);
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const stagingDir = path.join(root, `.${bundleName}.ff-migrate-${token}`);
  const copiedSources: Array<{ filePath: string; identity: FileIdentity }> = [];
  let finalDirCreated = false;

  try {
    fs.mkdirSync(stagingDir);
    const stagingFiles: Record<string, string> = {
      csv: path.join(stagingDir, recordingBundleLayout.BUNDLE_FILES.csv),
      automation: path.join(stagingDir, recordingBundleLayout.BUNDLE_FILES.automation),
      aircraftSpecific: path.join(stagingDir, recordingBundleLayout.BUNDLE_FILES.aircraftSpecific),
      timeline: path.join(stagingDir, recordingBundleLayout.BUNDLE_FILES.timeline),
    };
    copiedSources.push({ filePath: legacy.csv, identity: copyVerified(legacy.csv, stagingFiles.csv) });
    for (const role of ['automation', 'aircraftSpecific', 'timeline']) {
      if (!fs.existsSync(legacy[role])) continue;
      copiedSources.push({ filePath: legacy[role], identity: copyVerified(legacy[role], stagingFiles[role]) });
    }
    fs.renameSync(stagingDir, destination.dir);
    finalDirCreated = true;

    if (csvIdentity.bundleStatusRequired) {
      const hasAllArtifacts = fs.existsSync(destination.automation) && fs.existsSync(destination.aircraftSpecific);
      const finalizedAtEpochMs = Number.isSafeInteger(Number(oldStatus?.finalizedAtEpochMs))
        ? Number(oldStatus.finalizedAtEpochMs)
        : Math.max(csvIdentity.recordingStartEpochMs, Math.floor(fs.statSync(destination.csv).mtimeMs));
      await publishRecordingBundleStatus({
        flightId: csvIdentity.flightId,
        recordingSessionId: csvIdentity.recordingSessionId,
        recordingStartEpochMs: csvIdentity.recordingStartEpochMs,
        recordingStartIso: csvIdentity.recordingStartIso,
        outputDir: root,
        bundleBaseName: bundleName,
        status: hasAllArtifacts ? 'complete' : 'degraded',
        finalizedAtEpochMs,
        finalizedAtIso: new Date(finalizedAtEpochMs).toISOString(),
        endReason: 'pre-release_flat_layout_migration',
        degradedReason: hasAllArtifacts ? undefined : 'pre-release recording companion missing',
      });
    }

    const catalog = inspectCsvBundleForCatalogSync(destination.csv);
    if (!catalog.allowed && catalog.state !== 'not_required') {
      throw new Error('Migrated bundle did not pass completion validation');
    }
    if (oldSummary) {
      const csvStat = fs.lstatSync(destination.csv);
      writeHistorySummary({
        filePath: destination.csv,
        mtimeMs: csvStat.mtimeMs,
        sizeBytes: csvStat.size,
        bundleCatalogRevision: catalog.catalogRevision,
        bundleSizeBytes: catalog.bundleSizeBytes,
        recordingSessionId: csvIdentity.recordingSessionId || undefined,
      }, oldSummary);
    }
    for (const source of copiedSources) unlinkIfStillOwned(source.filePath, source.identity);
    for (const source of derivedIdentities) unlinkIfStillOwned(source.filePath, source.identity);
    return { destination: destination.dir };
  } catch (error) {
    if (!finalDirCreated) {
      try {
        for (const entry of fs.readdirSync(stagingDir)) fs.unlinkSync(path.join(stagingDir, entry));
        fs.rmdirSync(stagingDir);
      } catch {}
    }
    // Once the final directory exists, preserve it and every still-present
    // flat original for inspection. Never guess which copy should be removed.
    throw error;
  }
}

function acquireMigrationGate(root: string): { release: () => boolean } {
  const gate = acquireExclusiveFlightLogsMutationLease({
    outputDir: root,
    purpose: 'pre_release_flat_layout_migration',
  });
  if (gate.acquired === false) {
    throw new Error(`Flight Logs migration is not exclusive (${gate.error || gate.reason}); close Flight Fabric and try again`);
  }
  return gate;
}

function inspectFlatFlightLogs(rootDir: string): MigrationInspectionResult {
  const root = assertSafeMigrationRoot(rootDir);
  const gate = acquireMigrationGate(root);
  try {
    const result: MigrationInspectionResult = { ready: 0, failed: 0, totalBytes: 0, details: [] };
    for (const csvName of listFlatCsvNames(root)) {
      try {
        const inspected = inspectOneFlatFlight(root, csvName);
        result.ready += 1;
        result.totalBytes += inspected.sourceBytes;
        result.details.push({ source: csvName, status: 'ready', bytes: inspected.sourceBytes });
      } catch (error) {
        result.failed += 1;
        result.details.push({
          source: csvName,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  } finally {
    gate.release();
  }
}

async function migrateFlatFlightLogs(rootDir: string): Promise<MigrationResult> {
  const root = assertSafeMigrationRoot(rootDir);
  const gate = acquireMigrationGate(root);
  const result: MigrationResult = { migrated: 0, skipped: 0, failed: 0, details: [] };
  try {
    for (const csvName of listFlatCsvNames(root)) {
      try {
        const migrated = await migrateOneFlatFlight(root, csvName);
        result.migrated += 1;
        result.details.push({ source: csvName, destination: path.basename(migrated.destination), status: 'migrated' });
      } catch (error) {
        result.failed += 1;
        result.details.push({
          source: csvName,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  } finally {
    gate.release();
  }
}

module.exports = {
  LEGACY_SUFFIXES,
  inspectFlatFlightLogs,
  migrateFlatFlightLogs,
  readLegacyCsvIdentity,
};

export {};
