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

const crypto = require('node:crypto') as typeof import('node:crypto');
const path = require('path') as typeof import('path');
const recordingBundleLayout = require('./recording-bundle-layout') as {
  getBundleFromCsvPath: (_csvPath: unknown) => {
    bundleName: string;
    outputDir: string;
    paths: { csv: string };
  } | null;
  listBundleCsvPaths: (_outputDir: string) => string[];
};
const flightAnalysisRescoreSidecar = require('./flight-analysis-rescore-sidecar.js') as {
  buildFlightAnalysisPreviewFingerprint: (_options: AnyRecord) => AnyRecord;
  getFlightAnalysisRescoreSource: (_csvPath: string, _options?: AnyRecord) => AnyRecord;
  readFlightAnalysisRescoreSidecar: (_csvPath: string, _options?: AnyRecord) => AnyRecord;
  saveFlightAnalysisRescore: (_options: {
    csvPath: string;
    flightLogsDir: string;
    timeline: AnyRecord;
    landings: AnyRecord[];
    analysisContract: AnyRecord;
    expectedRevision?: number | null;
    expectedSourceFingerprint?: string | null;
    expectedPreviewFingerprint?: string | null;
    expectedAnalysisContractFingerprint?: string | null;
  }) => Promise<AnyRecord>;
  revertFlightAnalysisRescore: (_options: {
    csvPath: string;
    flightLogsDir: string;
    expectedRevision?: number | null;
    expectedSnapshotFingerprint?: string | null;
  }) => AnyRecord;
};
const timelineGenerator = require('../events/timeline-generator') as {
  CURRENT_ANALYSIS_RESCORE_CONTRACT?: AnyRecord;
  deleteFlightCsv: (_filePath: string, _expectedIdentity?: { mtimeMs?: unknown; sizeBytes?: unknown } | null) => { success: boolean; error?: string; deleted?: string };
  generateFromCSV: (_csvPath: string, _options?: TimelineGenerationOptions) => Promise<{ success: boolean; timeline?: AnyRecord; error?: string }>;
  getFlightLogsDir: () => string;
  getFlightLogsStorageInfo: (_options?: { allowedCsvPaths?: string[] }) => AnyRecord;
  listCSVFlights: (_options?: { allowedCsvPaths?: string[]; skipDeleteRecovery?: boolean }) => AnyRecord[];
  buildListedCsvFlightFromPath: (_filePath: string) => AnyRecord | null;
  recoverInterruptedBundleDeletes: (_dir: string) => void;
};
const {
  getLandingsFromCSVs,
  getLandingsFromCsvFile,
  computeStatsFromEntries,
  listLogbookCsvFiles,
  materializeFlightAnalysisLandings,
} = require('../landing/flight-logbook') as {
  getLandingsFromCSVs: (_options?: { bypassCachePaths?: string[]; allowedCsvPaths?: string[] }) => Promise<AnyRecord[]>;
  getLandingsFromCsvFile: (_filePath: string, _options?: AnyRecord) => Promise<AnyRecord[]>;
  computeStatsFromEntries: (_entries: AnyRecord[]) => AnyRecord;
  listLogbookCsvFiles: (_options?: { allowedCsvPaths?: string[] }) => AnyRecord[];
  materializeFlightAnalysisLandings: (
    _timeline: AnyRecord,
    _recordedEntries: AnyRecord[],
  ) => { success: boolean; landings?: AnyRecord[]; error?: string };
};
const { openHistoryIndexStore } = require('../history-index/history-index-store') as {
  openHistoryIndexStore: (_options?: AnyRecord) => AnyRecord;
};
const { resolveHistoryIndexDatabasePath } = require('../history-index/sqlite-runtime') as {
  resolveHistoryIndexDatabasePath: (_options?: AnyRecord) => string;
};
const { classifyApproachStability } = require('../stability/stability-runner.js') as {
  classifyApproachStability: (_value: AnyRecord | null | undefined) => string;
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
type TimelineGenerationOptions = {
  requestId?: string | number | null;
  scoringMode?: 'recorded' | 'current-preview';
};
type FlightAnalysisRescoreRequest = {
  filePath?: unknown;
  flightId?: unknown;
  expectedRevision?: number | null;
  expectedSourceFingerprint?: string | null;
  expectedPreviewFingerprint?: string | null;
  expectedAnalysisContractFingerprint?: string | null;
  expectedSnapshotFingerprint?: string | null;
};
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
  return typeof value === 'string'
    && value.trim().length > 0
    && value.trim().length <= 512
    && /^[a-zA-Z0-9_.:+\-]+$/.test(value.trim());
}

function analysisMetricText(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Unavailable';
  return String(value);
}

function analysisContractFingerprint(contract: AnyRecord): string {
  return crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

function scoreMetricText(grade: unknown, score: unknown): string {
  const label = analysisMetricText(grade);
  return Number.isFinite(Number(score)) ? `${label} · ${Math.round(Number(score))}` : label;
}

function stabilityMetricText(stability: AnyRecord | null | undefined): string {
  if (!stability || typeof stability !== 'object') return 'Unavailable';
  const resolvedVerdict = (
    stability.verdict === 'stable'
    || stability.verdict === 'marginal'
    || stability.verdict === 'unstable'
    || stability.verdict === 'no_verdict'
  ) ? stability.verdict : classifyApproachStability(stability);
  const verdict = resolvedVerdict === 'no_verdict'
    ? 'NO VERDICT'
    : resolvedVerdict.toUpperCase();
  return Number.isFinite(Number(stability.score))
    ? `${verdict} · ${Math.round(Number(stability.score))}`
    : verdict;
}

function rolloutMetricText(rollout: AnyRecord | null | undefined): string {
  if (!rollout || typeof rollout !== 'object') return 'Unavailable';
  const assessment = typeof rollout.assessment === 'string' && rollout.assessment.trim()
    ? rollout.assessment.trim().toUpperCase()
    : 'Unavailable';
  const flags = Array.isArray(rollout.flags)
    ? rollout.flags
        .map((flag) => typeof flag?.code === 'string' ? flag.code : '')
        .filter(Boolean)
        .sort()
    : [];
  return flags.length > 0 ? `${assessment} · ${flags.join(', ')}` : assessment;
}

function landingAnalysisMetricRows(recorded: AnyRecord, current: AnyRecord): AnyRecord[] {
  const recordedDistance = recorded?.touchdownDistance || {};
  const currentDistance = current?.touchdownDistance || {};
  const rows = [
    {
      key: 'landing-rate-grade',
      label: 'Touchdown rate',
      recorded: analysisMetricText(recorded?.grade),
      current: analysisMetricText(current?.grade),
    },
    {
      key: 'stability',
      label: 'Approach stability',
      recorded: stabilityMetricText(recorded?.ultimateStability),
      current: stabilityMetricText(current?.ultimateStability),
    },
    {
      key: 'touchdown-distance',
      label: 'Touchdown zone',
      recorded: scoreMetricText(recordedDistance.grade, recordedDistance.score),
      current: scoreMetricText(currentDistance.grade, currentDistance.score),
    },
    {
      key: 'lateral-offset',
      label: 'Centerline',
      recorded: scoreMetricText(recordedDistance.lateralOffsetGrade, recordedDistance.lateralOffsetScore),
      current: scoreMetricText(currentDistance.lateralOffsetGrade, currentDistance.lateralOffsetScore),
    },
    {
      key: 'bounce',
      label: 'Bounce',
      recorded: scoreMetricText(recordedDistance.bounceGrade, recordedDistance.bounceScore),
      current: scoreMetricText(currentDistance.bounceGrade, currentDistance.bounceScore),
    },
    {
      key: 'rollout',
      label: 'Rollout',
      recorded: rolloutMetricText(recorded?.rolloutAnalysis),
      current: rolloutMetricText(current?.rolloutAnalysis),
    },
  ];
  return rows.map((row) => ({ ...row, changed: row.recorded !== row.current }));
}

function buildFlightAnalysisComparison(
  recordedTimeline: AnyRecord,
  currentTimeline: AnyRecord,
): { success: true; landings: AnyRecord[]; changedMetricCount: number }
  | { success: false; error: string } {
  const recordedLandings = Array.isArray(recordedTimeline?.events)
    ? recordedTimeline.events.filter((event) => event?.type === 'landing')
    : [];
  const currentLandings = Array.isArray(currentTimeline?.events)
    ? currentTimeline.events.filter((event) => event?.type === 'landing')
    : [];
  const recordedByKey = new Map<string, AnyRecord>();
  for (const event of recordedLandings) {
    if (typeof event?.landingKey !== 'string' || !event.landingKey) {
      return { success: false, error: 'A recorded landing has no durable identity.' };
    }
    recordedByKey.set(event.landingKey, event);
  }
  if (recordedByKey.size !== recordedLandings.length || currentLandings.length !== recordedLandings.length) {
    return { success: false, error: 'The current analysis does not match every recorded landing.' };
  }
  let changedMetricCount = 0;
  const landings: AnyRecord[] = [];
  for (let index = 0; index < currentLandings.length; index += 1) {
    const current = currentLandings[index];
    const landingKey = typeof current?.landingKey === 'string' ? current.landingKey : '';
    const recorded = landingKey ? recordedByKey.get(landingKey) : null;
    if (!recorded) return { success: false, error: 'A rescored landing could not be matched.' };
    const metrics = landingAnalysisMetricRows(recorded, current);
    changedMetricCount += metrics.filter((metric) => metric.changed === true).length;
    landings.push({
      landingKey,
      label: `Landing ${index + 1}`,
      available: true,
      metrics,
    });
  }
  return { success: true, landings, changedMetricCount };
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

  function resolveHistoricalCsvRequest(
    filePath: unknown,
    flightId: unknown,
  ): { success: true; csvPath: string } | { success: false; error: string } {
    if (filePath !== undefined && filePath !== null && filePath !== '') {
      const csvPath = resolveCsvInsideFlightLogs(filePath);
      return csvPath
        ? { success: true, csvPath }
        : { success: false, error: 'The selected flight recording is unavailable' };
    }
    if (!isSafeFlightId(flightId)) {
      return { success: false, error: 'The selected flight recording is unavailable' };
    }
    try {
      const logsDir = timelineGenerator.getFlightLogsDir();
      const requestedFlightId = flightId.trim();
      const candidates = recordingBundleLayout.listBundleCsvPaths(logsDir);
      const catalogEntries = listLogbookCsvFiles({ allowedCsvPaths: candidates });
      const recordingIdentityMatches = catalogEntries.filter((entry) => (
        entry.recordingFlightId === requestedFlightId
      ));
      if (recordingIdentityMatches.length === 1) {
        return { success: true, csvPath: recordingIdentityMatches[0].filePath };
      }
      if (recordingIdentityMatches.length > 1) {
        return { success: false, error: 'The selected flight identity matches more than one recording' };
      }

      // Legacy recordings may not expose a manifest flight identity. Preserve
      // compatibility only for an exact canonical bundle-name match; prefix
      // matching can silently select the wrong flight when identifiers share a
      // date/time stem.
      const exactBundleMatches = candidates.filter((candidate) => (
        recordingBundleLayout.getBundleFromCsvPath(candidate)?.bundleName === requestedFlightId
      ));
      return exactBundleMatches.length === 1
        ? { success: true, csvPath: exactBundleMatches[0] }
        : { success: false, error: exactBundleMatches.length > 1
            ? 'The selected flight identity matches more than one recording'
            : 'The selected flight recording was not found' };
    } catch {
      return { success: false, error: 'The selected flight recording is unavailable' };
    }
  }

  function historicalCsvCanBeMutated(csvPath: string): boolean {
    try {
      return recordingBundleGuard?.isOwnedCsvPath?.(csvPath) !== true
        && !isActiveCsvPath(flightCsvWriter, csvPath)
        && !isFinalizingCsvPath(flightCsvWriter, csvPath);
    } catch {
      return false;
    }
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

  async function buildCurrentFlightAnalysis(csvPath: string): Promise<AnyRecord> {
    const analysisContract = timelineGenerator.CURRENT_ANALYSIS_RESCORE_CONTRACT || {
      id: 'flight-fabric-landing-analysis',
      version: 3,
      scope: 'full-landing-analysis',
    };
    const recordedResult = await timelineGenerator.generateFromCSV(csvPath, { scoringMode: 'recorded' });
    if (!recordedResult.success || !recordedResult.timeline) {
      return { success: false, error: recordedResult.error || 'Recorded flight analysis could not be reconstructed' };
    }
    const currentResult = await timelineGenerator.generateFromCSV(csvPath, { scoringMode: 'current-preview' });
    if (!currentResult.success || !currentResult.timeline) {
      return { success: false, error: currentResult.error || 'Current flight analysis could not be reconstructed' };
    }
    const currentStatus = currentResult.timeline.analysisRescore;
    if (!currentStatus || currentStatus.complete !== true) {
      return {
        success: false,
        error: 'The full current analysis is incomplete for one or more landings.',
        timeline: currentResult.timeline,
      };
    }
    if (!Number.isSafeInteger(currentStatus.landingCount) || currentStatus.landingCount < 1) {
      return { success: false, error: 'This flight has no recorded landing analysis to rescore.' };
    }

    const recordedEntries = await getLandingsFromCsvFile(csvPath, {
      bypassCache: true,
      ignoreAnalysisRescore: true,
    });
    const projection = materializeFlightAnalysisLandings(currentResult.timeline, recordedEntries);
    if (!projection.success || !Array.isArray(projection.landings)) {
      return { success: false, error: projection.error || 'The Logbook analysis could not be reconstructed' };
    }
    const comparison = buildFlightAnalysisComparison(recordedResult.timeline, currentResult.timeline);
    if (!comparison.success) return comparison;

    const source = flightAnalysisRescoreSidecar.getFlightAnalysisRescoreSource(csvPath, {
      flightLogsDir: timelineGenerator.getFlightLogsDir(),
    });
    if (!source || source.success === false || typeof source.sourceFingerprint !== 'string') {
      return { success: false, error: source?.error || 'The recording source could not be fingerprinted safely' };
    }
    const currentSaved = flightAnalysisRescoreSidecar.readFlightAnalysisRescoreSidecar(csvPath, {
      flightLogsDir: timelineGenerator.getFlightLogsDir(),
    });
    if (currentSaved?.exists === true && currentSaved?.valid !== true) {
      return { success: false, error: 'The saved flight analysis is damaged. Restore it before rescoring.' };
    }
    const baseRevision = Number.isSafeInteger(currentSaved?.document?.revision)
      ? currentSaved.document.revision
      : 0;
    const previewFingerprintResult = flightAnalysisRescoreSidecar.buildFlightAnalysisPreviewFingerprint({
      timeline: currentResult.timeline,
      landings: projection.landings,
      analysisContract,
      sourceFingerprint: source.sourceFingerprint,
    });
    const previewFingerprint = typeof previewFingerprintResult === 'string'
      ? previewFingerprintResult
      : previewFingerprintResult?.snapshotFingerprint;
    if (typeof previewFingerprint !== 'string') {
      return { success: false, error: 'The current analysis could not be fingerprinted safely' };
    }
    return {
      success: true,
      recordedTimeline: recordedResult.timeline,
      timeline: currentResult.timeline,
      landings: projection.landings,
      analysisContract,
      analysisContractFingerprint: previewFingerprintResult?.analysisContractFingerprint
        || analysisContractFingerprint(analysisContract),
      sourceFingerprint: source.sourceFingerprint,
      previewFingerprint,
      baseRevision,
      baseSnapshotFingerprint: typeof currentSaved?.document?.snapshotFingerprint === 'string'
        ? currentSaved.document.snapshotFingerprint
        : null,
      comparison,
    };
  }

  async function generateTimelineFromFile(
    filePath: unknown,
    options: TimelineGenerationOptions = {},
  ): Promise<TimelineReadResult> {
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
      if (options.scoringMode === 'current-preview') {
        const preview = await buildCurrentFlightAnalysis(csvPath);
        if (!preview.success) {
          return { success: false, error: preview.error || 'Current flight analysis is unavailable' };
        }
        return {
          success: true,
          timeline: {
            ...preview.timeline,
            filePath: csvPath,
            analysisRescore: {
              ...(preview.timeline.analysisRescore || {}),
              applied: false,
              revision: preview.baseRevision || null,
            },
            analysisRescorePreview: {
              available: true,
              previewFingerprint: preview.previewFingerprint,
              baseRevision: preview.baseRevision,
              sourceFingerprint: preview.sourceFingerprint,
              analysisContract: preview.analysisContract,
              analysisContractFingerprint: preview.analysisContractFingerprint,
              landingCount: preview.comparison.landings.length,
              changedMetricCount: preview.comparison.changedMetricCount,
              saveRequired: preview.previewFingerprint !== preview.baseSnapshotFingerprint,
              landings: preview.comparison.landings,
              reason: null,
            },
          },
        };
      }

      const saved = flightAnalysisRescoreSidecar.readFlightAnalysisRescoreSidecar(csvPath, {
        flightLogsDir: timelineGenerator.getFlightLogsDir(),
      });
      if (saved?.valid === true && saved?.document?.timeline) {
        return {
          success: true,
          timeline: {
            ...saved.document.timeline,
            filePath: csvPath,
            analysisRescore: {
              applied: true,
              mode: 'applied',
              scope: 'full-landing-analysis',
              revision: saved.document.revision,
              appliedAt: saved.document.appliedAt,
              snapshotFingerprint: saved.document.snapshotFingerprint,
              analysisContract: saved.document.analysisContract,
            },
          },
        };
      }

      const result = await timelineGenerator.generateFromCSV(csvPath, options);
      if (result.success) {
        return {
          success: true,
          timeline: {
            ...(result.timeline || {}),
            analysisRescore: {
              ...((result.timeline || {}).analysisRescore || {}),
              applied: false,
              revision: null,
              ...(saved?.exists === true && saved?.valid !== true
                ? { warning: 'Saved flight analysis is damaged; recorded analysis is shown.' }
                : {}),
            },
            // Keep subsequent preview/apply/revert requests tied to the exact
            // canonical recording selected for this historic read.
            filePath: csvPath,
          },
        };
      }
      return { success: false, error: result.error || 'Timeline not found' };
    } finally {
      readLease.release();
    }
  }

  async function generateTimelineForFlightId(
    flightId: unknown,
    options: TimelineGenerationOptions = {},
  ): Promise<TimelineReadResult> {
    const resolved = resolveHistoricalCsvRequest(undefined, flightId);
    if (resolved.success === false) {
      return { success: false, error: resolved.error };
    }
    return generateTimelineFromFile(resolved.csvPath, options);
  }

  async function applyFlightAnalysisRescore(request: FlightAnalysisRescoreRequest = {}): Promise<AnyRecord> {
    const resolved = resolveHistoricalCsvRequest(request.filePath, request.flightId);
    if (!resolved.success) return resolved;
    if (!historicalCsvCanBeMutated(resolved.csvPath)) {
      return { success: false, error: 'Only a finalized flight recording can be rescored' };
    }
    if (
      !Number.isSafeInteger(request.expectedRevision)
      || typeof request.expectedSourceFingerprint !== 'string'
      || typeof request.expectedPreviewFingerprint !== 'string'
      || typeof request.expectedAnalysisContractFingerprint !== 'string'
    ) {
      return { success: false, error: 'Preview the complete current analysis before saving it.' };
    }
    const readLease = recordingBundleLease.acquireBundleReadLease({
      outputDir: timelineGenerator.getFlightLogsDir(),
      baseName: csvBundleBaseName(resolved.csvPath),
      purpose: 'flight_analysis_rescore_preview',
    });
    if (!readLease.acquired || typeof readLease.release !== 'function') {
      return { success: false, error: 'The flight recording is currently busy. Try again shortly.' };
    }
    let analysis: AnyRecord;
    try {
      analysis = await buildCurrentFlightAnalysis(resolved.csvPath);
    } finally {
      readLease.release();
    }
    if (!analysis.success) return analysis;
    if (
      analysis.baseRevision !== request.expectedRevision
      || analysis.sourceFingerprint !== request.expectedSourceFingerprint
      || analysis.previewFingerprint !== request.expectedPreviewFingerprint
      || analysis.analysisContractFingerprint !== request.expectedAnalysisContractFingerprint
    ) {
      return { success: false, error: 'The flight or scoring rules changed after the preview. Preview it again.' };
    }
    const saved = await flightAnalysisRescoreSidecar.saveFlightAnalysisRescore({
      csvPath: resolved.csvPath,
      flightLogsDir: timelineGenerator.getFlightLogsDir(),
      timeline: analysis.timeline,
      landings: analysis.landings,
      analysisContract: analysis.analysisContract,
      expectedRevision: request.expectedRevision,
      expectedSourceFingerprint: request.expectedSourceFingerprint,
      expectedPreviewFingerprint: request.expectedPreviewFingerprint,
      expectedAnalysisContractFingerprint: request.expectedAnalysisContractFingerprint,
    });
    return saved?.success === true
      ? {
          ...saved,
          appliedAt: saved.document?.appliedAt || saved.appliedAt,
        }
      : saved;
  }

  function revertFlightAnalysisRescore(request: FlightAnalysisRescoreRequest = {}): AnyRecord {
    const resolved = resolveHistoricalCsvRequest(request.filePath, request.flightId);
    if (!resolved.success) return resolved;
    if (!historicalCsvCanBeMutated(resolved.csvPath)) {
      return { success: false, error: 'Only a finalized flight recording can be rescored' };
    }
    if (
      !Number.isSafeInteger(request.expectedRevision)
      || typeof request.expectedSnapshotFingerprint !== 'string'
    ) {
      return { success: false, error: 'The saved flight analysis changed. Reload before restoring.' };
    }
    return flightAnalysisRescoreSidecar.revertFlightAnalysisRescore({
      csvPath: resolved.csvPath,
      flightLogsDir: timelineGenerator.getFlightLogsDir(),
      expectedRevision: request.expectedRevision,
      expectedSnapshotFingerprint: request.expectedSnapshotFingerprint,
    });
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
    applyFlightAnalysisRescore,
    deleteFlightCsv,
    generateTimelineForFlightId,
    generateTimelineFromFile,
    getHistoryIndexStatus,
    getLogbook,
    listFlightsIndexed,
    listFlights,
    revertFlightAnalysisRescore,
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
