'use strict';

const path = require('path') as typeof import('path');
const {
  createHistorySourceId,
  sourceIdentityMatches,
} = require('./source-identity.js') as {
  createHistorySourceId: (_filePath: unknown) => string;
  sourceIdentityMatches: (_current: AnyRecord, _indexed: AnyRecord | null | undefined) => boolean;
};
const {
  getLandingsFromCsvFile,
  logbookOutcomeGrade,
} = require('../landing/flight-logbook.js') as {
  getLandingsFromCsvFile: (_filePath: string, _options?: { bypassCache?: boolean; mtimeMs?: number }) => Promise<AnyRecord[]>;
  logbookOutcomeGrade: (_entry: AnyRecord) => string | null;
};

type AnyRecord = Record<string, any>;
type CsvFileIdentity = {
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
  bundleCatalogRevision?: number;
  bundleSizeBytes?: number;
};
type RefreshOptions = {
  bypassCachePaths?: string[];
  pruneMissing?: boolean;
};
type RefreshResult = {
  indexed: number;
  landingsIndexed: number;
  skipped: number;
  pruned: number;
  totalInput: number;
};

function normalizePath(filePath: unknown): string | null {
  if (typeof filePath !== 'string' || !filePath.trim()) return null;
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeCsvIdentity(input: unknown): CsvFileIdentity | null {
  if (!input || typeof input !== 'object') return null;
  const row = input as AnyRecord;
  if (typeof row.filePath !== 'string' || !row.filePath.trim()) return null;
  const mtimeMs = Number(row.mtimeMs);
  const sizeBytes = Number(row.sizeBytes);
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(sizeBytes)) return null;
  return {
    filePath: row.filePath,
    mtimeMs,
    sizeBytes,
    ...(Number.isSafeInteger(Number(row.bundleCatalogRevision))
      ? { bundleCatalogRevision: Number(row.bundleCatalogRevision) }
      : {}),
    ...(Number.isSafeInteger(Number(row.bundleSizeBytes))
      ? { bundleSizeBytes: Number(row.bundleSizeBytes) }
      : {}),
  };
}

function indexSourceIdentity(source: CsvFileIdentity): CsvFileIdentity {
  return {
    ...source,
    mtimeMs: source.bundleCatalogRevision ?? source.mtimeMs,
    sizeBytes: source.bundleSizeBytes ?? source.sizeBytes,
  };
}

function landingToIndexInput(landing: AnyRecord, source: CsvFileIdentity): AnyRecord {
  const sourceId = createHistorySourceId(source.filePath);
  const sourceLandingId = typeof landing.id === 'string' && landing.id
    ? landing.id
    : String(landing.timestampMs ?? 0);
  return {
    // landing.id is display data and is not guaranteed to be globally unique.
    // Scope the SQLite primary key to the authoritative CSV source while the
    // original id remains intact in payload.
    landingId: `${sourceId}:${sourceLandingId}`,
    flightId: null,
    timestampMs: Number.isFinite(Number(landing.timestampMs)) ? Number(landing.timestampMs) : 0,
    timestamp: typeof landing.timestamp === 'string' && landing.timestamp
      ? landing.timestamp
      : new Date(Number(landing.timestampMs) || 0).toISOString(),
    aircraft: typeof landing.aircraft === 'string' ? landing.aircraft : null,
    aircraftProfileId: typeof landing.aircraftProfileId === 'string' ? landing.aircraftProfileId : null,
    icao: typeof landing.icao === 'string' ? landing.icao : null,
    runway: typeof landing.runway === 'string' ? landing.runway : null,
    vsFpm: Number.isFinite(Number(landing.vsFpm)) ? Number(landing.vsFpm) : null,
    grade: typeof landing.grade === 'string' ? landing.grade : null,
    outcomeGrade: typeof landing.outcomeGrade === 'string' ? landing.outcomeGrade : logbookOutcomeGrade(landing),
    gateStable: typeof landing.gateStable === 'boolean' ? landing.gateStable : null,
    stabilityScore:
      landing.stabilityScore !== null
      && landing.stabilityScore !== undefined
      && !(typeof landing.stabilityScore === 'string' && landing.stabilityScore.trim() === '')
      && Number.isFinite(Number(landing.stabilityScore))
        ? Number(landing.stabilityScore)
        : null,
    stabilityVerdict: typeof landing.stabilityVerdict === 'string' ? landing.stabilityVerdict : 'no_verdict',
    stabilityGateFailures: Array.isArray(landing.stabilityGateFailures) ? landing.stabilityGateFailures : [],
    touchdownDistanceFt: Number.isFinite(Number(landing.touchdownDistanceFt)) ? Number(landing.touchdownDistanceFt) : null,
    touchdownDistanceGrade: typeof landing.touchdownDistanceGrade === 'string' ? landing.touchdownDistanceGrade : null,
    runwayExcursion: typeof landing.runwayExcursion === 'boolean' ? landing.runwayExcursion : null,
    shortLanding: typeof landing.shortLanding === 'boolean' ? landing.shortLanding : null,
    payload: landing,
  };
}

async function refreshLogbookLandingIndex(
  store: AnyRecord,
  csvFiles: unknown[],
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const rows = (Array.isArray(csvFiles) ? csvFiles : [])
    .map(normalizeCsvIdentity)
    .filter((row): row is CsvFileIdentity => Boolean(row));
  const bypassCachePaths = new Set(
    (Array.isArray(options.bypassCachePaths) ? options.bypassCachePaths : [])
      .map(normalizePath)
      .filter((row): row is string => Boolean(row)),
  );

  const indexedPaths: string[] = [];
  const changedSources: AnyRecord[] = [];
  let indexed = 0;
  let skipped = 0;
  let landingsIndexed = 0;

  for (const source of rows) {
    indexedPaths.push(source.filePath);
    const indexedIdentity = indexSourceIdentity(source);
    const shouldBypassCache = bypassCachePaths.has(normalizePath(source.filePath) || '');
    const indexedSource = typeof store.getLandingsSourceByPath === 'function'
      ? store.getLandingsSourceByPath(source.filePath)
      : store.getSourceByPath?.(source.filePath);
    if (!shouldBypassCache && sourceIdentityMatches(indexedIdentity, indexedSource)) {
      skipped += 1;
      continue;
    }

    const landings = await getLandingsFromCsvFile(source.filePath, {
      bypassCache: shouldBypassCache,
      mtimeMs: source.mtimeMs,
    });
    changedSources.push({
      source: indexedIdentity,
      landings: landings.map((landing) => landingToIndexInput(landing, source)),
    });
    indexed += 1;
    landingsIndexed += landings.length;
  }

  let pruned = 0;
  if (options.pruneMissing !== false && typeof store.refreshSourcesLandingsIndex === 'function') {
    const refresh = store.refreshSourcesLandingsIndex(changedSources, indexedPaths);
    pruned = Number(refresh?.pruned) || 0;
  } else {
    if (changedSources.length > 0) {
      if (typeof store.replaceSourcesLandingsIndex === 'function') {
        store.replaceSourcesLandingsIndex(changedSources);
      } else {
        for (const source of changedSources) {
          store.replaceSourceIndex(source);
        }
      }
    }
    pruned = options.pruneMissing === false || typeof store.pruneMissingLandingSources !== 'function'
      ? 0
      : store.pruneMissingLandingSources(indexedPaths);
  }

  return {
    indexed,
    landingsIndexed,
    skipped,
    pruned,
    totalInput: rows.length,
  };
}

module.exports = {
  landingToIndexInput,
  refreshLogbookLandingIndex,
};

export {};
