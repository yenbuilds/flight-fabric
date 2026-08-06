'use strict';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const { getBundleFromCsvPath } = require('../flight-recording/recording-bundle-layout') as {
  getBundleFromCsvPath: (_csvPath: unknown) => { bundleName: string } | null;
};
const timelineGenerator = require('../events/timeline-generator.js') as {
  buildListedCsvFlightFromPath: (_filePath: string) => AnyRecord | null;
  getFlightLogsDir: () => string;
};
const { getLandingsFromCsvFile } = require('../landing/flight-logbook.js') as {
  getLandingsFromCsvFile: (_filePath: string, _options?: AnyRecord) => Promise<AnyRecord[]>;
};
const { landingToIndexInput } = require('./logbook-landing-index.js') as {
  landingToIndexInput: (_landing: AnyRecord, _source: AnyRecord) => AnyRecord;
};
const { normalizeTimelineFlightForIndex } = require('./timeline-flight-index.js') as {
  normalizeTimelineFlightForIndex: (_flight: AnyRecord) => AnyRecord | null;
};
const { sourceIdentityMatches } = require('./source-identity.js') as {
  sourceIdentityMatches: (_current: AnyRecord, _indexed: AnyRecord | null | undefined) => boolean;
};
const recordingBundleLease = require('../flight-recording/recording-bundle-lease.js') as {
  acquireBundleReadLease: (_options: {
    outputDir: string;
    baseName: string;
    purpose: string;
  }) => { acquired: boolean; release?: () => boolean };
};
const {
  readHistorySummary,
  writeHistorySummary,
} = require('./history-summary-sidecar.js') as {
  readHistorySummary: (_source: AnyRecord) => { flight: AnyRecord | null; landings: AnyRecord[] } | null;
  writeHistorySummary: (_source: AnyRecord, _result: { flight: AnyRecord | null; landings: AnyRecord[] }) => boolean;
};

type AnyRecord = Record<string, any>;
type CsvSourceIdentity = {
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
  bundleCatalogRevision?: number;
  bundleSizeBytes?: number;
  recordingSessionId?: string;
  bypassCache?: boolean;
};
type DebugLike = { log?: (_scope: string, _event: string, _payload?: AnyRecord) => void } | null | undefined;
type CoordinatorOptions = {
  Debug?: DebugLike;
  openHistoryIndexStore: () => AnyRecord;
  acquireBundleReadLease?: typeof recordingBundleLease.acquireBundleReadLease;
  buildListedCsvFlightFromPath?: typeof timelineGenerator.buildListedCsvFlightFromPath;
  getFlightLogsDir?: typeof timelineGenerator.getFlightLogsDir;
  getLandingsFromCsvFile?: typeof getLandingsFromCsvFile;
  readHistorySummary?: typeof readHistorySummary;
  writeHistorySummary?: typeof writeHistorySummary;
};

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeSource(input: unknown): CsvSourceIdentity | null {
  if (!input || typeof input !== 'object') return null;
  const source = input as AnyRecord;
  if (typeof source.filePath !== 'string' || !source.filePath.trim()) return null;
  const mtimeMs = finiteNumber(source.mtimeMs);
  const sizeBytes = finiteNumber(source.sizeBytes);
  if (mtimeMs === null || sizeBytes === null) return null;
  return {
    filePath: source.filePath,
    mtimeMs,
    sizeBytes,
    ...(Number.isSafeInteger(Number(source.bundleCatalogRevision))
      ? { bundleCatalogRevision: Number(source.bundleCatalogRevision) }
      : {}),
    ...(Number.isSafeInteger(Number(source.bundleSizeBytes))
      ? { bundleSizeBytes: Number(source.bundleSizeBytes) }
      : {}),
    ...(source.bypassCache === true ? { bypassCache: true } : {}),
    ...(typeof source.recordingSessionId === 'string' && source.recordingSessionId.trim()
      ? { recordingSessionId: source.recordingSessionId.trim() }
      : {}),
  };
}

function indexIdentity(source: CsvSourceIdentity): AnyRecord {
  return {
    filePath: source.filePath,
    mtimeMs: source.bundleCatalogRevision ?? source.mtimeMs,
    sizeBytes: source.bundleSizeBytes ?? source.sizeBytes,
    ...(source.recordingSessionId ? { recordingSessionId: source.recordingSessionId } : {}),
  };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function publicStatus(state: AnyRecord): AnyRecord {
  const totalFiles = Math.max(0, Number(state.totalFiles) || 0);
  const completedFiles = Math.max(0, Math.min(totalFiles, Number(state.completedFiles) || 0));
  const totalBytes = Math.max(0, Number(state.totalBytes) || 0);
  const completedBytes = Math.max(0, Math.min(totalBytes, Number(state.completedBytes) || 0));
  const percent = totalBytes > 0
    ? Math.max(0, Math.min(100, Math.round((completedBytes / totalBytes) * 100)))
    : (totalFiles > 0 ? Math.round((completedFiles / totalFiles) * 100) : 100);
  return {
    phase: state.phase,
    busy: state.phase === 'checking' || state.phase === 'indexing',
    mode: state.mode,
    generation: Number(state.generation) || 0,
    totalFiles,
    completedFiles,
    pendingFiles: Math.max(0, totalFiles - completedFiles),
    totalBytes,
    completedBytes,
    percent,
    indexedFiles: Math.max(0, Number(state.indexedFiles) || 0),
    summaryHits: Math.max(0, Number(state.summaryHits) || 0),
    deepScans: Math.max(0, Number(state.deepScans) || 0),
    failures: Math.max(0, Number(state.failures) || 0),
    currentFile: typeof state.currentFile === 'string' ? state.currentFile : '',
    lastFailedFile: typeof state.lastFailedFile === 'string' ? state.lastFailedFile : '',
    startedAtMs: finiteNumber(state.startedAtMs),
    completedAtMs: finiteNumber(state.completedAtMs),
    error: typeof state.error === 'string' ? state.error : '',
    counts: state.counts && typeof state.counts === 'object' ? { ...state.counts } : null,
  };
}

function createHistoryIndexCoordinator(options: CoordinatorOptions) {
  if (typeof options?.openHistoryIndexStore !== 'function') {
    throw new Error('History index coordinator requires a store opener');
  }
  const Debug = options.Debug || null;
  const openHistoryIndexStore = options.openHistoryIndexStore;
  const acquireReadLease = options.acquireBundleReadLease || recordingBundleLease.acquireBundleReadLease;
  const buildFlight = options.buildListedCsvFlightFromPath || timelineGenerator.buildListedCsvFlightFromPath;
  const flightLogsDir = options.getFlightLogsDir || timelineGenerator.getFlightLogsDir;
  const readLandings = options.getLandingsFromCsvFile || getLandingsFromCsvFile;
  const readSummary = options.readHistorySummary || readHistorySummary;
  const writeSummary = options.writeHistorySummary || writeHistorySummary;

  const state: AnyRecord = {
    phase: 'idle',
    mode: 'incremental',
    generation: 0,
    totalFiles: 0,
    completedFiles: 0,
    totalBytes: 0,
    completedBytes: 0,
    indexedFiles: 0,
    summaryHits: 0,
    deepScans: 0,
    failures: 0,
    currentFile: '',
    lastFailedFile: '',
    startedAtMs: null,
    completedAtMs: null,
    error: '',
    counts: null,
    catalogSignature: '',
  };
  let runPromise: Promise<void> | null = null;
  let cancelRequested = false;

  function markCancelled(): void {
    state.phase = 'cancelled';
    state.currentFile = '';
    state.completedAtMs = Date.now();
    state.error = '';
  }

  async function inspectSource(source: CsvSourceIdentity): Promise<{
    flight: AnyRecord | null;
    landings: AnyRecord[];
    usedSummary: boolean;
  }> {
    const summary = readSummary(source);
    if (summary) {
      return { ...summary, usedSummary: true };
    }
    const flight = buildFlight(source.filePath);
    const landings = await readLandings(source.filePath, {
      bypassCache: source.bypassCache === true,
      mtimeMs: source.mtimeMs,
    });
    writeSummary(source, { flight, landings });
    return { flight, landings, usedSummary: false };
  }

  async function run(sources: CsvSourceIdentity[], mode: 'incremental' | 'rebuild'): Promise<void> {
    let opened: AnyRecord | null = null;
    try {
      await nextTurn();
      if (cancelRequested) {
        markCancelled();
        return;
      }
      opened = openHistoryIndexStore();
      if (!opened?.success || !opened.store) {
        throw new Error(opened?.error || 'SQLite history index is unavailable');
      }
      if (cancelRequested) {
        markCancelled();
        return;
      }
      const store = opened.store;
      const indexedPaths = sources.map((source) => source.filePath);
      if (mode === 'rebuild') {
        if (typeof store.clearDerivedHistoryIndex !== 'function') {
          throw new Error('SQLite history index cannot be rebuilt by this runtime');
        }
        store.clearDerivedHistoryIndex();
      } else {
        store.pruneMissingSources?.(indexedPaths);
        store.pruneMissingLandingSources?.(indexedPaths);
      }

      const pending: CsvSourceIdentity[] = [];
      let completedBytes = 0;
      for (const source of sources) {
        const identity = indexIdentity(source);
        const flightsFresh = sourceIdentityMatches(identity, store.getFlightsSourceByPath?.(source.filePath));
        const landingsFresh = sourceIdentityMatches(identity, store.getLandingsSourceByPath?.(source.filePath));
        if (flightsFresh && landingsFresh) {
          state.completedFiles += 1;
          completedBytes += Math.max(0, source.sizeBytes);
        } else {
          pending.push(source);
        }
      }
      state.completedBytes = completedBytes;
      state.phase = pending.length > 0 ? 'indexing' : 'complete';

      for (const source of pending) {
        if (cancelRequested) break;
        state.currentFile = getBundleFromCsvPath(source.filePath)?.bundleName || path.basename(source.filePath);
        const lease = acquireReadLease({
          outputDir: flightLogsDir(),
          baseName: getBundleFromCsvPath(source.filePath)?.bundleName || '',
          purpose: 'history_index',
        });
        try {
          if (!lease.acquired || typeof lease.release !== 'function') {
            throw new Error('Recording is currently busy');
          }
          const before = fs.lstatSync(source.filePath);
          if (
            !before.isFile()
            || before.isSymbolicLink()
            || before.mtimeMs !== source.mtimeMs
            || before.size !== source.sizeBytes
          ) {
            throw new Error('Recording changed before it could be indexed');
          }
          const inspected = await inspectSource(source);
          if (cancelRequested) break;
          const normalizedFlight = inspected.flight
            ? normalizeTimelineFlightForIndex(inspected.flight)
            : null;
          const identity = indexIdentity(source);
          store.replaceSourceIndex({
            // The catalog snapshot is authoritative for source freshness.
            // Portable summaries can legitimately contain flight payloads
            // created before a flat-log migration changed the bundle
            // fingerprint. Trusting that cached payload here makes the newly
            // indexed row immediately stale and causes every later check to
            // parse the same history again.
            source: identity,
            flights: normalizedFlight?.flights || [],
            landings: inspected.landings.map((landing) => landingToIndexInput(landing, source)),
          });
          state.indexedFiles += 1;
          if (inspected.usedSummary) state.summaryHits += 1;
          else state.deepScans += 1;
        } catch (error) {
          state.failures += 1;
          state.lastFailedFile = path.basename(source.filePath);
          try {
            Debug?.log?.('history-index', 'source_index_failed', {
              file: path.basename(source.filePath),
              error: error instanceof Error ? error.message : String(error || 'Unknown error'),
            });
          } catch {}
        } finally {
          try { lease.release?.(); } catch {}
          state.completedFiles += 1;
          state.completedBytes += Math.max(0, source.sizeBytes);
          state.currentFile = '';
        }
        await nextTurn();
      }

      if (cancelRequested) {
        markCancelled();
        return;
      }

      state.counts = store.getCounts?.() || null;
      state.phase = 'complete';
      state.completedAtMs = Date.now();
      state.generation += 1;
    } catch (error) {
      state.phase = 'error';
      state.error = error instanceof Error ? error.message : 'History index failed';
      state.completedAtMs = Date.now();
      try {
        Debug?.log?.('history-index', 'index_failed', { error: state.error });
      } catch {}
    } finally {
      try { opened?.store?.close?.(); } catch {}
      runPromise = null;
    }
  }

  function start(sourceRows: unknown[], startOptions: { rebuild?: boolean; forceCheck?: boolean } = {}): AnyRecord {
    if (runPromise) return publicStatus(state);
    const sources = (Array.isArray(sourceRows) ? sourceRows : [])
      .map(normalizeSource)
      .filter((source): source is CsvSourceIdentity => Boolean(source))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    const mode = startOptions.rebuild === true ? 'rebuild' : 'incremental';
    const catalogSignature = sources.map((source) => [
      source.filePath,
      source.mtimeMs,
      source.sizeBytes,
      source.bundleCatalogRevision ?? '',
      source.bundleSizeBytes ?? '',
      source.recordingSessionId ?? '',
      source.bypassCache === true ? 'bypass' : '',
    ].join(':')).join('|');
    if (
      mode === 'incremental'
      && startOptions.forceCheck !== true
      && state.phase === 'complete'
      && state.catalogSignature === catalogSignature
    ) {
      return publicStatus(state);
    }
    Object.assign(state, {
      phase: 'checking',
      mode,
      totalFiles: sources.length,
      completedFiles: 0,
      totalBytes: sources.reduce((total, source) => total + Math.max(0, source.sizeBytes), 0),
      completedBytes: 0,
      indexedFiles: 0,
      summaryHits: 0,
      deepScans: 0,
      failures: 0,
      currentFile: '',
      lastFailedFile: '',
      startedAtMs: Date.now(),
      completedAtMs: null,
      error: '',
      catalogSignature,
    });
    cancelRequested = false;
    runPromise = run(sources, mode);
    return publicStatus(state);
  }

  async function cancel(): Promise<AnyRecord> {
    cancelRequested = true;
    const activeRun = runPromise;
    if (activeRun) await activeRun;
    else if (state.phase === 'checking' || state.phase === 'indexing') markCancelled();
    return publicStatus(state);
  }

  return {
    cancel,
    getStatus: () => publicStatus(state),
    start,
  };
}

module.exports = {
  createHistoryIndexCoordinator,
  indexIdentity,
  normalizeSource,
};

export {};
