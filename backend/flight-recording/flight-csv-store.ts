/**
 * Flight CSV Store - guarded read facade for recorded flight CSVs.
 *
 * `flight-csv-writer.ts` owns the live append-only recording. This module sits
 * on the read side for websocket/UI requests: list flights, generate timelines,
 * read logbook data, and delete old CSVs. Reads can race the active writer
 * because rows may still be buffered in either inline or worker writer mode, so
 * active-file and directory reads first ask `csv-read-guard` to flush the
 * writer. If the active CSV cannot be flushed, direct CSV reads fail closed.
 * Saved-flight and logbook lists may still use a previously completed SQLite
 * snapshot or a lease-protected scan that explicitly excludes the active CSV.
 * Both fallbacks are marked stale and never read the active recording bundle.
 *
 * The store also centralizes filesystem guardrails: historic reads must resolve
 * to `.csv` files under the flight logs directory, active recordings cannot be
 * deleted, and caller-facing responses avoid leaking raw absolute paths.
 */
'use strict';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const recordingBundleLayout = require('./recording-bundle-layout') as {
  getBundleFromCsvPath: (_csvPath: unknown) => {
    bundleName: string;
    outputDir: string;
    paths: { csv: string };
  } | null;
  listBundleCsvPaths: (_outputDir: string) => string[];
};
const timelineGenerator = require('../events/timeline-generator') as {
  deleteFlightCsv: (_filePath: string, _expectedIdentity?: { mtimeMs?: unknown; sizeBytes?: unknown } | null) => { success: boolean; error?: string; deleted?: string };
  generateFromCSV: (_csvPath: string) => Promise<{ success: boolean; timeline?: AnyRecord; error?: string }>;
  getFlightLogsDir: () => string;
  getFlightLogsStorageInfo: (_options?: { allowedCsvPaths?: string[] }) => AnyRecord;
  listCSVFlights: (_options?: { allowedCsvPaths?: string[]; skipDeleteRecovery?: boolean }) => AnyRecord[];
  buildListedCsvFlightFromPath: (_filePath: string) => AnyRecord | null;
  recoverInterruptedBundleDeletes: (_dir: string) => void;
};
const { getLandingsFromCSVs, computeStatsFromEntries, listLogbookCsvFiles } = require('../landing/flight-logbook') as {
  getLandingsFromCSVs: (_options?: { bypassCachePaths?: string[]; allowedCsvPaths?: string[] }) => Promise<AnyRecord[]>;
  computeStatsFromEntries: (_entries: AnyRecord[]) => AnyRecord;
  listLogbookCsvFiles: (_options?: { allowedCsvPaths?: string[] }) => AnyRecord[];
};
const { openHistoryIndexStore } = require('../history-index/history-index-store') as {
  openHistoryIndexStore: (_options?: AnyRecord) => AnyRecord;
};
const { resolveHistoryIndexDatabasePath } = require('../history-index/sqlite-runtime') as {
  resolveHistoryIndexDatabasePath: (_options?: AnyRecord) => string;
};
const {
  queryIndexedTimelineFlights,
  queryTimelineFlightsPage,
} = require('../history-index/timeline-flight-index') as {
  queryIndexedTimelineFlights: (_store: AnyRecord, _options?: AnyRecord) => AnyRecord;
  queryTimelineFlightsPage: (_flights: unknown[], _options?: AnyRecord) => AnyRecord;
};
const { createHistoryIndexCoordinator } = require('../history-index/history-index-coordinator') as {
  createHistoryIndexCoordinator: (_options: AnyRecord) => AnyRecord;
};
const {
  compareCsvPath,
  flushActiveCsvBeforeDirectoryRead,
  flushActiveCsvBeforeRead,
  getActiveCsvPath,
  isActiveCsvPath,
  isFinalizingCsvPath,
} = require('./csv-read-guard') as {
  compareCsvPath: (_csvPath: unknown) => string | null;
  flushActiveCsvBeforeDirectoryRead: (
    _flightCsvWriter?: AnyRecord | null,
    _Debug?: DebugLike,
    _recordingBundleGuard?: AnyRecord | null,
  ) => Promise<{ ready: boolean; activeCsvPath: string | null }>;
  flushActiveCsvBeforeRead: (
    _flightCsvWriter: AnyRecord | null | undefined,
    _csvPath: unknown,
    _Debug?: DebugLike,
    _recordingBundleGuard?: AnyRecord | null,
  ) => Promise<boolean>;
  getActiveCsvPath: (_flightCsvWriter: AnyRecord | null | undefined) => string | null;
  isActiveCsvPath: (_flightCsvWriter: AnyRecord | null | undefined, _csvPath: unknown) => boolean;
  isFinalizingCsvPath: (_flightCsvWriter: AnyRecord | null | undefined, _csvPath: unknown) => boolean;
};
const { isPathInside } = require('../utils/path-guard') as {
  isPathInside: (parentDir: string | null | undefined, childPath: string | null | undefined, options?: { allowEqual?: boolean }) => boolean;
};
const recordingBundleLease = require('./recording-bundle-lease') as {
  acquireBundleCatalogSnapshotLease: (_options: {
    outputDir: string;
    purpose: string;
    createDirectory?: boolean;
    beforeEnumerate?: (_outputDir: string) => void;
  }) => { acquired: boolean; csvPaths?: string[]; release?: () => void; error?: string };
  acquireBundleDirectoryReadLeases: (_options: {
    outputDir: string;
    purpose: string;
    createDirectory?: boolean;
    beforeEnumerate?: (_outputDir: string) => void;
  }) => { acquired: boolean; csvPaths?: string[]; release?: () => void };
  acquireBundleMutationLease: (_options: {
    outputDir: string;
    baseName: string;
    purpose: string;
  }) => { acquired: boolean; release?: () => void };
  acquireBundleReadLease: (_options: {
    outputDir: string;
    baseName: string;
    purpose: string;
  }) => { acquired: boolean; release?: () => boolean };
};

type AnyRecord = Record<string, any>;
type DebugLike = { log?: (_scope: string, _event: string, _payload?: AnyRecord) => void } | null | undefined;
type StoreOptions = {
  Debug?: DebugLike;
  flightCsvWriter?: AnyRecord | null;
  recordingBundleGuard?: AnyRecord | null;
  openHistoryIndexStore?: (_options?: AnyRecord) => AnyRecord;
};
type TimelineReadResult =
  | { success: true; timeline: AnyRecord }
  | { success: false; error: string };
type TimelineListResult =
  | { success: true; flights: AnyRecord[]; storage: AnyRecord }
  | { success: false; error: string };
type TimelineListOptions = {
  aircraftFilter?: unknown;
  limit?: unknown;
  offset?: unknown;
  routeFilter?: unknown;
  sort?: unknown;
};
type IndexedTimelineListResult =
  | {
      success: true;
      flights: AnyRecord[];
      storage: AnyRecord | null;
      index: AnyRecord;
    }
  | { success: false; error: string };
type DeleteExpectedIdentity = { mtimeMs?: unknown; sizeBytes?: unknown } | null | undefined;
type DeleteResult = { success: boolean; error?: string | null; storage?: AnyRecord | null };
type LogbookResult =
  | { success: true; entries: AnyRecord[]; stats: AnyRecord; index?: AnyRecord }
  | { success: false; error: string };
type LogbookReadOptions = {
  entryLimit?: unknown;
};
type HistoryCatalogSnapshot = {
  bypassCachePaths: string[];
  csvFiles: AnyRecord[];
  csvPaths: string[];
  storage: AnyRecord;
};
type HistoryCatalogResult =
  | { success: true; snapshot: HistoryCatalogSnapshot }
  | { success: false; error: string };

const ACTIVE_CSV_NOT_READY = 'Active flight CSV is not ready yet';
const DEFAULT_LOGBOOK_ENTRY_LIMIT = 500;
const MAX_LOGBOOK_ENTRY_LIMIT = 1000;
const sharedHistoryIndexCoordinators = new Map<unknown, AnyRecord>();

function isCompletedHistoryIndexStatus(status: unknown): status is AnyRecord {
  if (!status || typeof status !== 'object') return false;
  const candidate = status as AnyRecord;
  return candidate.phase === 'complete'
    && candidate.busy !== true
    && candidate.counts !== null
    && typeof candidate.counts === 'object';
}

function getSharedHistoryIndexCoordinator(
  openHistoryIndexStoreFn: (_options?: AnyRecord) => AnyRecord,
  Debug: DebugLike,
): AnyRecord {
  const coordinatorKey = openHistoryIndexStoreFn === openHistoryIndexStore
    ? resolveHistoryIndexDatabasePath()
    : openHistoryIndexStoreFn;
  const existing = sharedHistoryIndexCoordinators.get(coordinatorKey);
  if (existing) return existing;
  const created = createHistoryIndexCoordinator({
    Debug,
    openHistoryIndexStore: openHistoryIndexStoreFn,
  });
  sharedHistoryIndexCoordinators.set(coordinatorKey, created);
  return created;
}

function isSafeFlightId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && /^[a-zA-Z0-9_\-]+$/.test(value);
}

function resolveCsvInsideFlightLogs(filePath: unknown): string | null {
  if (typeof filePath !== 'string' || !filePath) return null;

  try {
    const logsDir = path.resolve(timelineGenerator.getFlightLogsDir());
    const csvPath = path.resolve(filePath);
    if (!isPathInside(logsDir, csvPath)) return null;
    const bundle = recordingBundleLayout.getBundleFromCsvPath(csvPath);
    if (!bundle) return null;
    const comparable = (value: string) => (
      process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
    );
    if (
      comparable(bundle.outputDir) !== comparable(logsDir)
      || comparable(bundle.paths.csv) !== comparable(csvPath)
    ) return null;
    return csvPath;
  } catch {
    return null;
  }
}

function createFlightCsvStore(options: StoreOptions = {}) {
  const flightCsvWriter = options.flightCsvWriter || null;
  const Debug = options.Debug || null;
  const recordingBundleGuard = options.recordingBundleGuard || null;
  const openHistoryIndexStoreFn = typeof options.openHistoryIndexStore === 'function'
    ? options.openHistoryIndexStore
    : openHistoryIndexStore;
  const historyIndexCoordinator = getSharedHistoryIndexCoordinator(openHistoryIndexStoreFn, Debug);
  let indexedStorageSnapshot: AnyRecord | null = null;

  function getKnownActiveCsvPath(): string | null {
    try {
      const guardedPath = compareCsvPath(recordingBundleGuard?.getActiveCsvPath?.());
      if (guardedPath) return guardedPath;
    } catch {}
    return getActiveCsvPath(flightCsvWriter);
  }

  function normalizeLogbookEntryLimit(value: unknown): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_LOGBOOK_ENTRY_LIMIT;
    return Math.max(0, Math.min(MAX_LOGBOOK_ENTRY_LIMIT, Math.floor(numeric)));
  }

  function readTimelinePageFromIndex(
    options: TimelineListOptions,
    historyIndexStatus: AnyRecord,
    storage: AnyRecord | null,
  ): IndexedTimelineListResult | null {
    const opened = openHistoryIndexStoreFn();
    if (!opened.success) return null;
    try {
      const page = queryIndexedTimelineFlights(opened.store, options);
      return {
        success: true,
        flights: page.flights,
        storage,
        index: {
          used: true,
          paged: true,
          limit: page.limit,
          offset: page.offset,
          status: historyIndexStatus,
          totalMatching: page.totalMatching,
        },
      };
    } catch (err) {
      try {
        Debug?.log?.('history-index', 'sqlite_timeline_query_failed', {
          error: err instanceof Error ? err.message : String(err || 'Unknown error'),
        });
      } catch {}
      return null;
    } finally {
      try { opened.store.close(); } catch {}
    }
  }

  function acquireCompletedBundleDirectorySnapshot(
    activeCsvPath: string | null,
    purpose: string,
  ): { csvPaths: string[]; release: () => void } | null {
    // This fallback is only safe when the one non-completed bundle can be
    // identified and removed from the snapshot. A busy/finalizing guard with
    // no path must remain fail-closed rather than risk parsing a moving CSV.
    const activePathKey = compareCsvPath(activeCsvPath);
    if (!activePathKey) return null;
    const directoryLeases = recordingBundleLease.acquireBundleDirectoryReadLeases({
      outputDir: timelineGenerator.getFlightLogsDir(),
      purpose,
      createDirectory: true,
      beforeEnumerate: timelineGenerator.recoverInterruptedBundleDeletes,
    });
    if (!directoryLeases.acquired || typeof directoryLeases.release !== 'function') return null;
    return {
      csvPaths: (directoryLeases.csvPaths || []).filter((csvPath) => (
        compareCsvPath(csvPath) !== activePathKey
      )),
      release: directoryLeases.release,
    };
  }

  async function readCompletedTimelinePageWhileActiveUnavailable(
    options: TimelineListOptions,
    historyIndexStatus: AnyRecord,
    activeCsvPath: string | null,
  ): Promise<IndexedTimelineListResult | null> {
    const snapshot = acquireCompletedBundleDirectorySnapshot(activeCsvPath, 'timeline_list');
    if (!snapshot) return null;
    try {
      const flights = timelineGenerator.listCSVFlights({
        allowedCsvPaths: snapshot.csvPaths,
        skipDeleteRecovery: true,
      });
      const page = queryTimelineFlightsPage(flights, options);
      return {
        success: true,
        flights: page.flights,
        storage: timelineGenerator.getFlightLogsStorageInfo({
          allowedCsvPaths: snapshot.csvPaths,
        }),
        index: {
          used: false,
          paged: true,
          fallback: 'completed_bundle_snapshot',
          stale: true,
          staleReason: ACTIVE_CSV_NOT_READY,
          status: historyIndexStatus,
          limit: page.limit,
          offset: page.offset,
          totalMatching: page.totalMatching,
        },
      };
    } catch (err) {
      try {
        Debug?.log?.('history-index', 'completed_bundle_timeline_fallback_failed', {
          error: err instanceof Error ? err.message : String(err || 'Unknown error'),
        });
      } catch {}
      return null;
    } finally {
      snapshot.release();
    }
  }

  function readLogbookFromIndex(
    entryLimit: number,
    historyIndexStatus: AnyRecord,
  ): LogbookResult | null {
    const opened = openHistoryIndexStoreFn();
    if (!opened.success) return null;
    try {
      const snapshot = typeof opened.store.queryLogbookSnapshot === 'function'
        ? opened.store.queryLogbookSnapshot({ limit: entryLimit })
        : null;
      const page = snapshot?.page || (typeof opened.store.queryLogbookEntries === 'function'
        ? opened.store.queryLogbookEntries({ limit: entryLimit })
        : null);
      const stats = snapshot?.stats || (typeof opened.store.queryLogbookStats === 'function'
        ? opened.store.queryLogbookStats()
        : null);
      if (!page || !stats || !Array.isArray(page.entries)) return null;
      return {
        success: true,
        entries: page.entries,
        stats,
        index: {
          used: true,
          status: historyIndexStatus,
          totalMatching: page.totalMatching,
          limit: page.limit,
          offset: page.offset,
        },
      } as LogbookResult;
    } catch (err) {
      try {
        Debug?.log?.('logbook', 'sqlite_logbook_query_failed', {
          error: err instanceof Error ? err.message : String(err || 'Unknown error'),
        });
      } catch {}
      return null;
    } finally {
      try { opened.store.close(); } catch {}
    }
  }

  async function readCompletedLogbookWhileActiveUnavailable(
    entryLimit: number,
    historyIndexStatus: AnyRecord,
    activeCsvPath: string | null,
  ): Promise<LogbookResult | null> {
    const snapshot = acquireCompletedBundleDirectorySnapshot(activeCsvPath, 'logbook_fallback_read');
    if (!snapshot) return null;
    try {
      const entries = await getLandingsFromCSVs({
        allowedCsvPaths: snapshot.csvPaths,
      });
      return {
        success: true,
        entries: entryLimit > 0 ? entries.slice(0, entryLimit) : [],
        stats: computeStatsFromEntries(entries),
        index: {
          used: false,
          fallback: 'completed_bundle_snapshot',
          stale: true,
          staleReason: ACTIVE_CSV_NOT_READY,
          status: historyIndexStatus,
        },
      };
    } catch (err) {
      try {
        Debug?.log?.('logbook', 'completed_bundle_logbook_fallback_failed', {
          error: err instanceof Error ? err.message : String(err || 'Unknown error'),
        });
      } catch {}
      return null;
    } finally {
      snapshot.release();
    }
  }

  function captureHistoryCatalog(
    purpose: string,
    activeCsvPath: string | null,
  ): HistoryCatalogResult {
    const catalogLease = recordingBundleLease.acquireBundleCatalogSnapshotLease({
      outputDir: timelineGenerator.getFlightLogsDir(),
      purpose,
      createDirectory: true,
      beforeEnumerate: timelineGenerator.recoverInterruptedBundleDeletes,
    });
    if (!catalogLease.acquired || typeof catalogLease.release !== 'function') {
      const leaseError = 'error' in catalogLease ? catalogLease.error : '';
      return {
        success: false,
        error: leaseError === 'BUNDLE_LEASE_PRESENT'
          ? ACTIVE_CSV_NOT_READY
          : `Flight history catalog is unavailable${leaseError ? ` (${leaseError})` : ''}`,
      };
    }
    try {
      const csvPaths = catalogLease.csvPaths || [];
      const bypassCachePaths = activeCsvPath ? [activeCsvPath] : [];
      const csvFiles = listLogbookCsvFiles({ allowedCsvPaths: csvPaths }).map((source) => ({
        ...source,
        ...(bypassCachePaths.some((candidate) => path.resolve(candidate) === path.resolve(source.filePath))
          ? { bypassCache: true }
          : {}),
      }));
      return {
        success: true,
        snapshot: {
          bypassCachePaths,
          csvFiles,
          csvPaths,
          storage: timelineGenerator.getFlightLogsStorageInfo({ allowedCsvPaths: csvPaths }),
        },
      };
    } catch (error) {
      try {
        Debug?.log?.('history-index', 'catalog_snapshot_failed', {
          error: error instanceof Error ? error.message : String(error || 'Unknown error'),
        });
      } catch {}
      return {
        success: false,
        error: `Flight history catalog scan failed: ${
          error instanceof Error ? error.message : String(error || 'Unknown error')
        }`,
      };
    } finally {
      catalogLease.release();
    }
  }

  async function readTimelinePageWithoutIndex(
    options: TimelineListOptions,
    historyIndexStatus: AnyRecord,
    fallback: string,
    error: unknown,
  ): Promise<IndexedTimelineListResult> {
    const listed = await listFlights();
    if (!listed.success) {
      return { success: false, error: 'error' in listed ? listed.error : ACTIVE_CSV_NOT_READY };
    }
    const page = queryTimelineFlightsPage(listed.flights, options);
    return {
      success: true,
      flights: page.flights,
      storage: listed.storage,
      index: {
        used: false,
        paged: true,
        fallback,
        error: error instanceof Error ? error.message : String(error || 'Unknown error'),
        status: historyIndexStatus,
        limit: page.limit,
        offset: page.offset,
        totalMatching: page.totalMatching,
      },
    };
  }

  async function generateTimelineFromFile(filePath: unknown): Promise<TimelineReadResult> {
    const csvPath = resolveCsvInsideFlightLogs(filePath);
    if (!csvPath) {
      return {
        success: false,
        error: 'Timeline requests must specify a CSV file inside the flight logs directory',
      };
    }

    // Timeline merges the CSV with JSONL companions. A flush is not a snapshot
    // barrier while all three streams remain writable, so an active bundle can
    // expose different read frontiers. Fail closed until bundle finalization.
    if (recordingBundleGuard?.isOwnedCsvPath?.(csvPath)) {
      return { success: false, error: ACTIVE_CSV_NOT_READY };
    }

    const activeCsvReady = await flushActiveCsvBeforeRead(flightCsvWriter, csvPath, Debug, recordingBundleGuard);
    if (!activeCsvReady) {
      return { success: false, error: ACTIVE_CSV_NOT_READY };
    }

    const readLease = recordingBundleLease.acquireBundleReadLease({
      outputDir: timelineGenerator.getFlightLogsDir(),
      baseName: csvBundleBaseName(csvPath),
      purpose: 'timeline_read',
    });
    if (!readLease.acquired || typeof readLease.release !== 'function') {
      return { success: false, error: ACTIVE_CSV_NOT_READY };
    }
    try {
      const result = await timelineGenerator.generateFromCSV(csvPath);
      if (result.success) {
        return { success: true, timeline: result.timeline || {} };
      }
      return { success: false, error: result.error || 'Timeline not found' };
    } finally {
      readLease.release();
    }
  }

  async function generateTimelineForFlightId(flightId: unknown): Promise<TimelineReadResult> {
    if (!isSafeFlightId(flightId)) {
      return {
        success: false,
        error: 'Invalid flightId: must be a non-empty alphanumeric string',
      };
    }

    let matchingFile: string | null = null;
    try {
      const dir = timelineGenerator.getFlightLogsDir();
      if (fs.existsSync(dir)) {
        matchingFile = recordingBundleLayout.listBundleCsvPaths(dir)
          .find((csvPath) => (
            recordingBundleLayout.getBundleFromCsvPath(csvPath)?.bundleName.startsWith(flightId)
          )) || null;
        if (matchingFile) {
          const result = await generateTimelineFromFile(matchingFile);
          if (result.success) return result;
          return {
            success: false,
            error: 'error' in result ? result.error : 'Failed to generate timeline',
          };
        }
      }
    } catch {
      return { success: false, error: 'Failed to generate timeline' };
    }

    return { success: false, error: 'Timeline not found for flight: ' + flightId };
  }

  async function listFlights(): Promise<TimelineListResult> {
    const activeCsvReady = await flushActiveCsvBeforeDirectoryRead(flightCsvWriter, Debug, recordingBundleGuard);
    if (!activeCsvReady.ready) {
      return { success: false, error: ACTIVE_CSV_NOT_READY };
    }

    const directoryLeases = recordingBundleLease.acquireBundleDirectoryReadLeases({
      outputDir: timelineGenerator.getFlightLogsDir(),
      purpose: 'timeline_list',
      createDirectory: true,
      beforeEnumerate: timelineGenerator.recoverInterruptedBundleDeletes,
    });
    if (!directoryLeases.acquired || typeof directoryLeases.release !== 'function') {
      return { success: false, error: ACTIVE_CSV_NOT_READY };
    }
    try {
      return {
        success: true,
        flights: timelineGenerator.listCSVFlights({
          allowedCsvPaths: directoryLeases.csvPaths || [],
          skipDeleteRecovery: true,
        }),
        storage: timelineGenerator.getFlightLogsStorageInfo({
          allowedCsvPaths: directoryLeases.csvPaths || [],
        }),
      };
    } finally {
      directoryLeases.release();
    }
  }

  async function listFlightsIndexed(options: TimelineListOptions = {}): Promise<IndexedTimelineListResult> {
    const currentStatus = historyIndexCoordinator.getStatus();
    const knownActiveCsvPath = getKnownActiveCsvPath();
    if (knownActiveCsvPath) {
      // Recent Flights is finalized history. A live CSV and its JSONL
      // companions are irrelevant to this response, and waiting for all three
      // streams can leave the WebSocket request pending indefinitely. Prefer a
      // completed SQLite generation; otherwise scan a leased directory
      // snapshot that explicitly excludes the active bundle.
      if (isCompletedHistoryIndexStatus(currentStatus)) {
        const indexed = readTimelinePageFromIndex(options, currentStatus, indexedStorageSnapshot);
        if (indexed?.success) {
          return {
            ...indexed,
            index: {
              ...(indexed.index || {}),
              stale: true,
              staleReason: ACTIVE_CSV_NOT_READY,
            },
          };
        }
      }
      const completed = await readCompletedTimelinePageWhileActiveUnavailable(
        options,
        currentStatus,
        knownActiveCsvPath,
      );
      if (completed?.success) return completed;
      return { success: false, error: ACTIVE_CSV_NOT_READY };
    }

    const activeCsvReady = await flushActiveCsvBeforeDirectoryRead(flightCsvWriter, Debug, recordingBundleGuard);
    if (!activeCsvReady.ready) {
      // A completed SQLite generation is an internally consistent snapshot and
      // does not touch the active bundle. It is safe to keep saved flights
      // visible while the active recording cannot satisfy its cross-file flush
      // barrier. The current flight is intentionally omitted until a later
      // successful catalog refresh.
      if (isCompletedHistoryIndexStatus(currentStatus)) {
        const indexed = readTimelinePageFromIndex(options, currentStatus, indexedStorageSnapshot);
        if (indexed?.success) {
          return {
            ...indexed,
            index: {
              ...(indexed.index || {}),
              stale: true,
              staleReason: ACTIVE_CSV_NOT_READY,
            },
          };
        }
      }
      // The Recent Flights panel contains finalized history only. If the live
      // three-member bundle cannot currently satisfy its durability barrier,
      // keep that one path out of a separately leased directory snapshot and
      // list the completed bundles instead. This never parses the active CSV.
      const completed = await readCompletedTimelinePageWhileActiveUnavailable(
        options,
        currentStatus,
        activeCsvReady.activeCsvPath,
      );
      if (completed?.success) return completed;
      return { success: false, error: ACTIVE_CSV_NOT_READY };
    }

    if (currentStatus.busy === true) {
      // The running coordinator already owns a stable catalog snapshot. UI
      // progress polling must query its SQLite checkpoints directly; taking a
      // new all-bundle lease snapshot here creates an O(files) lease storm and
      // can starve both indexing and graceful shutdown.
      return readTimelinePageFromIndex(options, currentStatus, indexedStorageSnapshot)
        || { success: false, error: ACTIVE_CSV_NOT_READY };
    }

    const catalogResult = captureHistoryCatalog('timeline_indexed_list', activeCsvReady.activeCsvPath);
    if (!catalogResult.success) {
      return { success: false, error: 'error' in catalogResult ? catalogResult.error : ACTIVE_CSV_NOT_READY };
    }
    const catalog = catalogResult.snapshot;
    const historyIndexStatus = historyIndexCoordinator.start(catalog.csvFiles);
    indexedStorageSnapshot = catalog.storage;
    const opened = openHistoryIndexStoreFn();
    if (!opened.success) {
      return readTimelinePageWithoutIndex(options, historyIndexStatus, 'open_failed', opened.error);
    }
    try {
      const page = queryIndexedTimelineFlights(opened.store, options);
      return {
        success: true,
        flights: page.flights,
        storage: catalog.storage,
        index: {
          used: true,
          paged: true,
          limit: page.limit,
          offset: page.offset,
          status: historyIndexStatus,
          totalMatching: page.totalMatching,
        },
      };
    } catch (err) {
      return readTimelinePageWithoutIndex(options, historyIndexStatus, 'query_failed', err);
    } finally {
      try { opened.store.close(); } catch {}
    }
  }

  function deleteFlightCsv(filePath: unknown, expectedIdentity?: DeleteExpectedIdentity): DeleteResult {
    if (
      recordingBundleGuard?.isOwnedCsvPath?.(filePath)
      || isActiveCsvPath(flightCsvWriter, filePath)
      || isFinalizingCsvPath(flightCsvWriter, filePath)
    ) {
      return { success: false, error: 'Cannot delete an active or finalizing recording' };
    }
    if (typeof filePath !== 'string') {
      return { success: false, error: 'filePath is required' };
    }

    const csvPath = resolveCsvInsideFlightLogs(filePath);
    if (!csvPath) {
      const rejected = timelineGenerator.deleteFlightCsv(filePath, expectedIdentity);
      return { success: rejected.success, error: rejected.error || null, storage: null };
    }
    const mutationLease = recordingBundleLease.acquireBundleMutationLease({
      outputDir: timelineGenerator.getFlightLogsDir(),
      baseName: csvBundleBaseName(csvPath),
      purpose: 'delete',
    });
    if (!mutationLease.acquired || typeof mutationLease.release !== 'function') {
      return { success: false, error: 'Cannot delete an active or finalizing recording' };
    }
    let result: { success: boolean; error?: string; deleted?: string };
    try {
      result = timelineGenerator.deleteFlightCsv(csvPath, expectedIdentity);
    } finally {
      mutationLease.release();
    }
    let storage: AnyRecord | null = null;
    if (result.success) {
      try {
        storage = timelineGenerator.getFlightLogsStorageInfo();
      } catch {
        storage = null;
      }
    }

    return {
      success: result.success,
      error: result.error || null,
      storage,
    };
  }

  async function getLogbook(options: LogbookReadOptions = {}): Promise<LogbookResult> {
    const entryLimit = normalizeLogbookEntryLimit(options.entryLimit);
    const currentStatus = historyIndexCoordinator.getStatus();
    const activeCsvReady = await flushActiveCsvBeforeDirectoryRead(flightCsvWriter, Debug, recordingBundleGuard);
    if (!activeCsvReady.ready) {
      // The SQLite index is a completed, internally consistent snapshot and
      // does not read the active recording bundle. Keep saved landings
      // available when a live artifact cannot momentarily satisfy its
      // cross-file flush barrier; the active flight will be incorporated by a
      // later successful catalog refresh.
      const indexed = readLogbookFromIndex(entryLimit, currentStatus);
      if (indexed?.success) {
        return {
          ...indexed,
          index: {
            ...(indexed.index || {}),
            stale: true,
            staleReason: ACTIVE_CSV_NOT_READY,
          },
        };
      }
      const completed = await readCompletedLogbookWhileActiveUnavailable(
        entryLimit,
        currentStatus,
        activeCsvReady.activeCsvPath,
      );
      if (completed?.success) return completed;
      return { success: false, error: ACTIVE_CSV_NOT_READY };
    }

    if (currentStatus.busy === true) {
      return readLogbookFromIndex(entryLimit, currentStatus)
        || { success: false, error: ACTIVE_CSV_NOT_READY };
    }

    const catalogResult = captureHistoryCatalog('logbook_read', activeCsvReady.activeCsvPath);
    if (!catalogResult.success) {
      return { success: false, error: 'error' in catalogResult ? catalogResult.error : ACTIVE_CSV_NOT_READY };
    }
    const catalog = catalogResult.snapshot;
    const historyIndexStatus = historyIndexCoordinator.start(catalog.csvFiles);
    const indexed = readLogbookFromIndex(entryLimit, historyIndexStatus);
    if (indexed) return indexed;

    // SQLite is only a derived cache. Retain the fully leased CSV parser as a
    // rare fallback so history remains available if the local index cannot open.
    const directoryLeases = recordingBundleLease.acquireBundleDirectoryReadLeases({
      outputDir: timelineGenerator.getFlightLogsDir(),
      purpose: 'logbook_fallback_read',
      createDirectory: true,
      beforeEnumerate: timelineGenerator.recoverInterruptedBundleDeletes,
    });
    if (!directoryLeases.acquired || typeof directoryLeases.release !== 'function') {
      return { success: false, error: ACTIVE_CSV_NOT_READY };
    }
    try {
      const bypassCachePaths = activeCsvReady.activeCsvPath ? [activeCsvReady.activeCsvPath] : [];
      const entries = await getLandingsFromCSVs({
        bypassCachePaths,
        allowedCsvPaths: directoryLeases.csvPaths || [],
      });
      return {
        success: true,
        entries: entryLimit > 0 ? entries.slice(0, entryLimit) : [],
        stats: computeStatsFromEntries(entries),
        index: { used: false, status: historyIndexStatus },
      };
    } finally {
      directoryLeases.release();
    }
  }

  function getHistoryIndexStatus(): AnyRecord {
    return historyIndexCoordinator.getStatus();
  }

  async function startHistoryIndex(options: { rebuild?: boolean } = {}): Promise<AnyRecord> {
    const activeCsvReady = await flushActiveCsvBeforeDirectoryRead(flightCsvWriter, Debug, recordingBundleGuard);
    if (!activeCsvReady.ready) {
      return { success: false, error: ACTIVE_CSV_NOT_READY, status: getHistoryIndexStatus() };
    }
    const catalogResult = captureHistoryCatalog(
      options.rebuild === true ? 'history_index_rebuild' : 'history_index_check',
      activeCsvReady.activeCsvPath,
    );
    if (!catalogResult.success) {
      return {
        success: false,
        error: 'error' in catalogResult ? catalogResult.error : ACTIVE_CSV_NOT_READY,
        status: getHistoryIndexStatus(),
      };
    }
    const catalog = catalogResult.snapshot;
    indexedStorageSnapshot = catalog.storage;
    return {
      success: true,
      status: historyIndexCoordinator.start(catalog.csvFiles, {
        rebuild: options.rebuild === true,
        forceCheck: true,
      }),
    };
  }

  async function stop(): Promise<AnyRecord> {
    return historyIndexCoordinator.cancel();
  }

  return {
    deleteFlightCsv,
    generateTimelineForFlightId,
    generateTimelineFromFile,
    getHistoryIndexStatus,
    getLogbook,
    listFlightsIndexed,
    listFlights,
    startHistoryIndex,
    stop,
  };
}

function csvBundleBaseName(csvPath: string): string {
  return recordingBundleLayout.getBundleFromCsvPath(csvPath)?.bundleName || '';
}

module.exports = {
  ACTIVE_CSV_NOT_READY,
  createFlightCsvStore,
  isSafeFlightId,
  resolveCsvInsideFlightLogs,
};

export {};
