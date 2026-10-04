'use strict';

/** Legacy takeoff compatibility only. New records live in the flight CSV and
 * share landing's rebuildable history index. Unmatched old JSON entries remain
 * readable; entries proven present in a recording can be retired atomically. */
import type { TakeoffLogEntry } from './takeoff-record';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const {
  ensureDirExists,
  getAppDataRoot,
  TAKEOFF_LOG_FILE_NAME,
  resolveTakeoffLogFilePath,
} = require('../utils/storage-paths.js') as {
  ensureDirExists: (dirPath: string) => string | null | undefined;
  getAppDataRoot: () => string;
  TAKEOFF_LOG_FILE_NAME: string;
  resolveTakeoffLogFilePath: () => string;
};
const { safeReplaceTextFileSync } = require('../utils/safe-fs.js') as {
  safeReplaceTextFileSync: (_options: {
    allowedBasenames?: string[];
    allowedExtensions?: string[];
    data: string;
    operation: string;
    rootDir: string;
    targetPath: string;
  }) => string;
};

type AnyRecord = Record<string, any>;

type TakeoffLogState = { version: number; entries: TakeoffLogEntry[] };

const MAX_TAKEOFF_LOG_ENTRIES = 2000;
const MAX_LEGACY_LOG_BYTES = 16 * 1024 * 1024;
const APP_DATA_DIR = getAppDataRoot();
const TAKEOFF_LOG_FILE = resolveTakeoffLogFilePath();

// The module owns every write, so the parsed log is cached and re-read only
// when the file on disk changes; the Logbook asks for it on every refresh.
let cachedState: { mtimeMs: number; size: number; state: TakeoffLogState } | null = null;
let corruptWarned = false;

function emptyState(): TakeoffLogState {
  return { version: 1, entries: [] };
}

function readLog(): TakeoffLogState {
  let stat: ReturnType<typeof fs.statSync>;
  try {
    stat = fs.statSync(TAKEOFF_LOG_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      cachedState = null;
      return emptyState();
    }
    throw error;
  }
  if (cachedState && cachedState.mtimeMs === stat.mtimeMs && cachedState.size === stat.size) {
    return { ...cachedState.state, entries: cachedState.state.entries.slice() };
  }
  let state: TakeoffLogState;
  try {
    if (!stat.isFile() || stat.size > MAX_LEGACY_LOG_BYTES) throw new Error('Legacy takeoff log exceeds its size limit');
    const data = JSON.parse(fs.readFileSync(TAKEOFF_LOG_FILE, 'utf8')) as Partial<TakeoffLogState>;
    if (!data || !Array.isArray(data.entries) || data.entries.length > MAX_TAKEOFF_LOG_ENTRIES) {
      throw new Error('Takeoff log file has an invalid structure or entry count');
    }
    state = {
      ...data,
      version: Number(data.version) || 1,
      entries: data.entries,
    };
    corruptWarned = false;
  } catch (error) {
    // Keep damaged legacy bytes intact. Recording-backed history remains usable.
    if (!corruptWarned) {
      corruptWarned = true;
      console.warn(`[takeoff-logbook] ${TAKEOFF_LOG_FILE} is unreadable; the legacy file has been preserved:`, (error as Error)?.message);
    }
    state = emptyState();
  }
  cachedState = { mtimeMs: stat.mtimeMs, size: stat.size, state: { ...state, entries: state.entries.slice() } };
  return state;
}

function writeLog(data: TakeoffLogState): void {
  ensureDirExists(APP_DATA_DIR);
  ensureDirExists(path.dirname(TAKEOFF_LOG_FILE));
  safeReplaceTextFileSync({
    allowedBasenames: [TAKEOFF_LOG_FILE_NAME],
    allowedExtensions: ['.json'],
    data: JSON.stringify(data, null, 2),
    operation: 'writeTakeoffLog',
    rootDir: APP_DATA_DIR,
    targetPath: TAKEOFF_LOG_FILE,
  });
  try {
    const stat = fs.statSync(TAKEOFF_LOG_FILE);
    cachedState = { mtimeMs: stat.mtimeMs, size: stat.size, state: { ...data, entries: data.entries.slice() } };
  } catch {
    cachedState = null;
  }
}

function getEntries(): TakeoffLogEntry[] {
  return readLog().entries.filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string');
}

/** Retire only exact legacy IDs already proven recoverable from a recording. */
function deleteEntriesByIds(ids: string[]): number {
  const matched = new Set(ids);
  if (!matched.size) return 0;
  const log = readLog();
  const before = log.entries.length;
  log.entries = log.entries.filter((entry) => !matched.has(entry?.id));
  const removed = before - log.entries.length;
  if (removed) writeLog(log);
  return removed;
}

/** Explicit in-app flight deletion also removes unmatched legacy entries. */
function deleteEntriesForBundle(bundleName: string | null | undefined): number {
  if (typeof bundleName !== 'string' || !bundleName.trim()) return 0;
  const log = readLog();
  const before = log.entries.length;
  log.entries = log.entries.filter((entry) => entry?.recording?.bundleName !== bundleName);
  const removed = before - log.entries.length;
  if (removed) writeLog(log);
  return removed;
}

function averageRounded(values: Array<number | null | undefined>, digits = 0): number | null {
  const finite = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (finite.length === 0) return null;
  const factor = 10 ** digits;
  return Math.round((finite.reduce((sum, value) => sum + value, 0) / finite.length) * factor) / factor;
}

function computeStatsFromEntries(entries: TakeoffLogEntry[]): AnyRecord {
  const list = Array.isArray(entries) ? entries : [];
  const grades: Record<string, number> = {};
  const airports = new Set<string>();
  const aircraft = new Set<string>();
  let cautionCount = 0;
  for (const entry of list) {
    const grade = entry.runwayUseGrade || 'Unknown';
    grades[grade] = (grades[grade] || 0) + 1;
    if (['caution', 'warning', 'critical'].includes(entry.assessment || '')
      || (Array.isArray(entry.flags) && entry.flags.some((flag) => ['caution', 'warning', 'critical'].includes(flag?.severity)))
      || grade === 'Late Liftoff' || grade === 'Dangerous' || grade === 'Overrun') cautionCount += 1;
    if (entry.icao) airports.add(entry.icao);
    if (entry.aircraft) aircraft.add(entry.aircraft);
  }
  const remaining = list.map((entry) => entry.runwayRemainingFt).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return {
    total: list.length,
    grades,
    cautionCount,
    avgRollDistanceFt: averageRounded(list.map((entry) => entry.rollDistanceFt)),
    avgRunwayUsedPct: averageRounded(list.map((entry) => entry.runwayUsedPct), 1),
    minRunwayRemainingFt: remaining.length > 0 ? remaining.reduce((min, value) => Math.min(min, value), Infinity) : null,
    airports: airports.size,
    aircraft: aircraft.size,
  };
}

module.exports = {
  TAKEOFF_LOG_FILE,
  computeStatsFromEntries,
  deleteEntriesByIds,
  deleteEntriesForBundle,
  getEntries,
};

export {};
