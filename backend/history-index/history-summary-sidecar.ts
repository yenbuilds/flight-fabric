'use strict';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const { safeReplaceTextFileSync } = require('../utils/safe-fs.js') as {
  safeReplaceTextFileSync: (_options: {
    allowedExtensions: string[];
    data: string;
    operation: string;
    rootDir: string;
    targetPath: string;
  }) => void;
};
const { isPathInside } = require('../utils/path-guard.js') as {
  isPathInside: (_parent: string, _child: string, _options?: { allowEqual?: boolean }) => boolean;
};
const recordingBundleLayout = require('../flight-recording/recording-bundle-layout') as {
  BUNDLE_FILES: { summary: string };
  getArtifactPathForCsv: (_csvPath: unknown, _role: 'summary') => string | null;
  getBundleFromCsvPath: (_csvPath: unknown) => { bundleName: string } | null;
};

type AnyRecord = Record<string, any>;
type CsvSourceIdentity = {
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
  bundleCatalogRevision?: number;
  bundleSizeBytes?: number;
  recordingSessionId?: string;
};

const HISTORY_SUMMARY_SCHEMA_VERSION = 1;
// Bump whenever flight-list or landing extraction semantics change. Old
// summaries then fall back to their authoritative CSV exactly once.
const HISTORY_ANALYSIS_VERSION = 7;
const HISTORY_SUMMARY_SUFFIX = recordingBundleLayout.BUNDLE_FILES.summary;
const MAX_HISTORY_SUMMARY_BYTES = 8 * 1024 * 1024;

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function comparablePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function getHistorySummaryPath(csvPath: unknown): string | null {
  return recordingBundleLayout.getArtifactPathForCsv(csvPath, 'summary');
}

function sourceIdentity(source: CsvSourceIdentity): AnyRecord {
  return {
    bundleName: recordingBundleLayout.getBundleFromCsvPath(source.filePath)?.bundleName || null,
    csvBasename: path.basename(source.filePath),
    csvMtimeMs: finiteNumber(source.mtimeMs),
    csvSizeBytes: finiteNumber(source.sizeBytes),
    bundleCatalogRevision: finiteNumber(source.bundleCatalogRevision),
    bundleSizeBytes: finiteNumber(source.bundleSizeBytes),
    recordingSessionId: typeof source.recordingSessionId === 'string' ? source.recordingSessionId : null,
  };
}

function sourceIdentityMatchesSummary(source: CsvSourceIdentity, summarySource: unknown): boolean {
  if (!summarySource || typeof summarySource !== 'object') return false;
  const expected = sourceIdentity(source);
  const actual = summarySource as AnyRecord;
  if (String(actual.bundleName || '') !== expected.bundleName) return false;
  if (String(actual.csvBasename || '') !== expected.csvBasename) return false;
  if (finiteNumber(actual.csvMtimeMs) !== expected.csvMtimeMs) return false;
  if (finiteNumber(actual.csvSizeBytes) !== expected.csvSizeBytes) return false;
  if (finiteNumber(actual.bundleCatalogRevision) !== expected.bundleCatalogRevision) return false;
  if (finiteNumber(actual.bundleSizeBytes) !== expected.bundleSizeBytes) return false;
  if (String(actual.recordingSessionId || '') !== String(expected.recordingSessionId || '')) return false;
  return true;
}

function sanitizeFlightForSummary(flight: unknown): AnyRecord | null {
  if (!flight || typeof flight !== 'object') return null;
  const {
    filePath: _filePath,
    sourceId: _sourceId,
    csvBasename: _csvBasename,
    ...portable
  } = flight as AnyRecord;
  return {
    ...portable,
    timestamp: portable.timestamp instanceof Date
      ? portable.timestamp.toISOString()
      : portable.timestamp,
  };
}

function parseHistorySummaryBytes(
  bytes: Buffer,
  source: CsvSourceIdentity,
): { flight: AnyRecord | null; landings: AnyRecord[] } | null {
  if (!Buffer.isBuffer(bytes) || bytes.length <= 0 || bytes.length > MAX_HISTORY_SUMMARY_BYTES) return null;
  let parsed: AnyRecord;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.schemaVersion !== HISTORY_SUMMARY_SCHEMA_VERSION) return null;
  if (parsed.analysisVersion !== HISTORY_ANALYSIS_VERSION) return null;
  if (!sourceIdentityMatchesSummary(source, parsed.source)) return null;
  if (parsed.flight !== null && (!parsed.flight || typeof parsed.flight !== 'object' || Array.isArray(parsed.flight))) {
    return null;
  }
  if (!Array.isArray(parsed.landings)) return null;
  if (parsed.landings.some((landing: unknown) => !landing || typeof landing !== 'object' || Array.isArray(landing))) {
    return null;
  }
  return {
    flight: parsed.flight ? { ...parsed.flight, filePath: source.filePath } : null,
    landings: parsed.landings.map((landing: AnyRecord) => ({ ...landing })),
  };
}

function readHistorySummary(source: CsvSourceIdentity): { flight: AnyRecord | null; landings: AnyRecord[] } | null {
  const summaryPath = getHistorySummaryPath(source?.filePath);
  if (!summaryPath) return null;
  const rootDir = path.dirname(path.resolve(source.filePath));
  if (!isPathInside(rootDir, summaryPath)) return null;
  let fd: number | null = null;
  try {
    const before = fs.lstatSync(summaryPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_HISTORY_SUMMARY_BYTES) return null;
    fd = fs.openSync(summaryPath, 'r');
    const opened = fs.fstatSync(fd);
    const after = fs.lstatSync(summaryPath);
    if (
      !opened.isFile()
      || !after.isFile()
      || after.isSymbolicLink()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || after.dev !== before.dev
      || after.ino !== before.ino
      || opened.size > MAX_HISTORY_SUMMARY_BYTES
    ) return null;
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (bytesRead <= 0) return null;
      offset += bytesRead;
    }
    return parseHistorySummaryBytes(bytes, source);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function writeHistorySummary(
  source: CsvSourceIdentity,
  result: { flight?: AnyRecord | null; landings?: AnyRecord[] },
): boolean {
  const summaryPath = getHistorySummaryPath(source?.filePath);
  if (!summaryPath) return false;
  const rootDir = path.dirname(path.resolve(source.filePath));
  if (!isPathInside(rootDir, summaryPath)) return false;
  const flight = sanitizeFlightForSummary(result?.flight || null);
  const landings = Array.isArray(result?.landings)
    ? result.landings.filter((landing) => landing && typeof landing === 'object')
    : [];
  const payload = {
    schemaVersion: HISTORY_SUMMARY_SCHEMA_VERSION,
    analysisVersion: HISTORY_ANALYSIS_VERSION,
    generatedAt: new Date().toISOString(),
    display: {
      name: [flight?.displayRouteLabel || flight?.route || 'Location Unknown', flight?.aircraft]
        .filter(Boolean)
        .join(' — '),
      startedAt: flight?.recordingStartIso || null,
      duration: flight?.durationFormatted || null,
      route: flight?.displayRouteLabel || flight?.route || null,
      aircraft: flight?.aircraft || null,
      status: flight?.recordingBundleStatus || 'indexed',
    },
    source: sourceIdentity(source),
    recordingIdentity: {
      flightId: flight?.recordingFlightId || flight?.flightId || null,
      recordingSessionId: flight?.recordingSessionId || null,
      recordingStartIso: flight?.recordingStartIso || null,
    },
    flight,
    landings,
  };
  const data = `${JSON.stringify(payload, null, 2)}\n`;
  if (Buffer.byteLength(data, 'utf8') > MAX_HISTORY_SUMMARY_BYTES) return false;
  try {
    safeReplaceTextFileSync({
      allowedExtensions: ['.json'],
      data,
      operation: 'write flight history summary sidecar',
      rootDir,
      targetPath: summaryPath,
    });
    return true;
  } catch {
    return false;
  }
}

function isOwnedHistorySummaryForCsv(summaryPath: unknown, csvPath: unknown): boolean {
  if (typeof summaryPath !== 'string' || typeof csvPath !== 'string') return false;
  const expected = getHistorySummaryPath(csvPath);
  if (!expected || comparablePath(expected) !== comparablePath(summaryPath)) return false;
  try {
    const stat = fs.lstatSync(summaryPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_HISTORY_SUMMARY_BYTES) return false;
    const parsed = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    return parsed?.schemaVersion === HISTORY_SUMMARY_SCHEMA_VERSION
      && typeof parsed?.source?.csvBasename === 'string'
      && parsed.source.csvBasename === path.basename(csvPath)
      && parsed.source.bundleName === recordingBundleLayout.getBundleFromCsvPath(csvPath)?.bundleName;
  } catch {
    return false;
  }
}

module.exports = {
  HISTORY_ANALYSIS_VERSION,
  HISTORY_SUMMARY_SCHEMA_VERSION,
  HISTORY_SUMMARY_SUFFIX,
  getHistorySummaryPath,
  isOwnedHistorySummaryForCsv,
  readHistorySummary,
  sourceIdentityMatchesSummary,
  writeHistorySummary,
};

export {};
