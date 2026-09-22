'use strict';

/**
 * Takeoff logbook: the scored takeoffs shown in the Logbook tab.
 *
 * Landings reach the Logbook through the flight CSVs and the SQLite history
 * index. Takeoffs are new, so rather than re-scanning every recording on each
 * request (the cost the index exists to avoid) or forcing a full re-index,
 * each scored takeoff is appended to a small JSON log in app data, the same
 * pattern as the local landing logbook file. Entries carry the recording
 * bundle they came from so deleting a flight removes its takeoffs.
 */

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

export type TakeoffLogRecording = {
  bundleName?: string | null;
  recordingSessionId?: string | null;
  flightId?: string | null;
};

export type TakeoffLogEntry = {
  id: string;
  timestamp: string | null;
  timestampMs: number | null;
  flightStart: string | null;
  aircraft: string | null;
  aircraftProfileId: string | null;
  icao: string | null;
  runway: string | null;
  iasKts: number | null;
  gsKts: number | null;
  pitchDeg: number | null;
  flapsNotch: number | null;
  windSpeedKts: number | null;
  windDirDeg: number | null;
  xwindKts: number | null;
  rollDistanceFt: number | null;
  rollDurationS: number | null;
  rollStartSource: string | null;
  liftoffDistanceFt: number | null;
  runwayRemainingFt: number | null;
  runwayUsedPct: number | null;
  runwayUseScore: number | null;
  runwayUseGrade: string | null;
  runwayUseZone: string | null;
  runwayLengthFt: number | null;
  runwayGeometrySource: string | null;
  screenHeightFt: number | null;
  screenHeightRemainingFt: number | null;
  screenHeightReached: boolean;
  rotationRateDegS: number | null;
  maxPitchDeg: number | null;
  lateralOffsetFt: number | null;
  lateralOffsetSide: string | null;
  lateralOffsetGrade: string | null;
  lateralOffsetSuspect: boolean;
  hopCount: number;
  assessment: string | null;
  runwayExcursion: boolean;
  flags: Array<{ code: string; label: string; severity: string }>;
  recording: { bundleName: string | null; recordingSessionId: string | null; flightId: string | null };
};

type TakeoffLogState = { version: number; entries: TakeoffLogEntry[] };

const MAX_TAKEOFF_LOG_ENTRIES = 2000;
const MAX_FLAGS_PER_ENTRY = 8;
const APP_DATA_DIR = getAppDataRoot();
const TAKEOFF_LOG_FILE = resolveTakeoffLogFilePath();

function toNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toText(value: unknown, limit = 120): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, limit) : null;
}

function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

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
    return { version: cachedState.state.version, entries: cachedState.state.entries.slice() };
  }
  let state: TakeoffLogState;
  try {
    const data = JSON.parse(fs.readFileSync(TAKEOFF_LOG_FILE, 'utf8')) as Partial<TakeoffLogState>;
    if (!data || !Array.isArray(data.entries)) throw new Error('Takeoff log file has an invalid structure');
    state = {
      version: Number(data.version) || 1,
      entries: data.entries.filter((entry) => entry && typeof entry === 'object') as TakeoffLogEntry[],
    };
    corruptWarned = false;
  } catch (error) {
    // This file is the only store for takeoffs. A damaged file must not
    // silence every later takeoff, so it is treated as empty and the next
    // scored takeoff replaces it. The first sighting is reported.
    if (!corruptWarned) {
      corruptWarned = true;
      console.warn(`[takeoff-logbook] ${TAKEOFF_LOG_FILE} is unreadable and will be replaced by the next scored takeoff:`, (error as Error)?.message);
    }
    state = emptyState();
  }
  cachedState = { mtimeMs: stat.mtimeMs, size: stat.size, state: { version: state.version, entries: state.entries.slice() } };
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
    cachedState = { mtimeMs: stat.mtimeMs, size: stat.size, state: { version: data.version, entries: data.entries.slice() } };
  } catch {
    cachedState = null;
  }
}

/**
 * Map a `takeoff:final` payload (snake_case, see takeoff-runner.ts) to a
 * logbook entry. Field names mirror the Takeoff timeline marker so the two
 * projections agree.
 */
function extractEntry(payload: AnyRecord | null | undefined, recording: TakeoffLogRecording = {}): TakeoffLogEntry | null {
  if (!payload || typeof payload !== 'object') return null;
  const timestampMs = toNum(payload.timestamp_ms);
  const timestamp = toText(payload.timestamp_utc, 40)
    ?? (timestampMs != null ? new Date(timestampMs).toISOString() : null);
  const analysis = payload.takeoff_analysis && typeof payload.takeoff_analysis === 'object'
    ? payload.takeoff_analysis as AnyRecord
    : null;
  const flags = Array.isArray(analysis?.flags)
    ? analysis!.flags
      .filter((flag: unknown) => flag && typeof flag === 'object')
      .slice(0, MAX_FLAGS_PER_ENTRY)
      .map((flag: AnyRecord) => ({
        code: toText(flag.code, 48) || '',
        label: toText(flag.label, 160) || '',
        severity: toText(flag.severity, 16) || 'caution',
      }))
      .filter((flag: { code: string; label: string }) => flag.code && flag.label)
    : [];
  return {
    id: `${timestampMs ?? Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp,
    timestampMs,
    flightStart: toText(payload.flight_start, 40),
    aircraft: toText(payload.aircraft, 200),
    aircraftProfileId: toText(payload.aircraft_profile_id, 200),
    icao: toText(payload.icao, 8),
    runway: toText(payload.runway, 16),
    iasKts: toNum(payload.ias_kts),
    gsKts: toNum(payload.gs_kts),
    pitchDeg: toNum(payload.pitch_deg),
    flapsNotch: toNum(payload.flaps_notch),
    windSpeedKts: toNum(payload.wind_speed_kts),
    windDirDeg: toNum(payload.wind_dir_deg),
    xwindKts: toNum(payload.xwind_kts),
    rollDistanceFt: toNum(payload.takeoff_roll_distance_ft),
    rollDurationS: toNum(payload.takeoff_roll_duration_s),
    rollStartSource: toText(payload.takeoff_roll_start_source, 32),
    liftoffDistanceFt: toNum(payload.takeoff_liftoff_distance_ft),
    runwayRemainingFt: toNum(payload.takeoff_runway_remaining_ft),
    runwayUsedPct: toNum(payload.takeoff_runway_used_pct),
    runwayUseScore: toNum(payload.takeoff_runway_use_score),
    runwayUseGrade: toText(payload.takeoff_runway_use_grade, 32),
    runwayUseZone: toText(payload.takeoff_runway_use_zone, 64),
    runwayLengthFt: toNum(payload.runway_physical_length_ft) ?? toNum(payload.runway_length_ft),
    runwayGeometrySource: toText(payload.runway_geometry_source, 32),
    screenHeightFt: toNum(payload.takeoff_screen_height_ft),
    screenHeightRemainingFt: toNum(payload.takeoff_screen_height_remaining_ft),
    screenHeightReached: analysis?.screenHeight?.reached === true,
    rotationRateDegS: toNum(payload.takeoff_rotation_rate_deg_s),
    maxPitchDeg: toNum(payload.takeoff_max_pitch_deg),
    lateralOffsetFt: toNum(payload.lateral_offset_ft),
    lateralOffsetSide: toText(payload.lateral_offset_side, 16),
    lateralOffsetGrade: toText(payload.lateral_offset_grade, 32),
    lateralOffsetSuspect: payload.lateral_offset_suspect !== false,
    hopCount: Math.max(0, Math.round(toNum(payload.takeoff_hop_count) ?? 0)),
    assessment: toText(payload.takeoff_assessment, 16),
    runwayExcursion: toBool(payload.runway_excursion),
    flags,
    recording: {
      bundleName: toText(recording.bundleName, 200),
      recordingSessionId: toText(recording.recordingSessionId, 128),
      flightId: toText(recording.flightId, 128),
    },
  };
}

function addEntry(payload: AnyRecord | null | undefined, recording: TakeoffLogRecording = {}): TakeoffLogEntry | null {
  const entry = extractEntry(payload, recording);
  if (!entry) return null;
  const log = readLog();
  log.entries.unshift(entry);
  if (log.entries.length > MAX_TAKEOFF_LOG_ENTRIES) log.entries.length = MAX_TAKEOFF_LOG_ENTRIES;
  writeLog(log);
  return entry;
}

function getEntries(): TakeoffLogEntry[] {
  return readLog().entries;
}

function deleteEntry(id: string | null | undefined): boolean {
  if (!id) return false;
  const log = readLog();
  const before = log.entries.length;
  log.entries = log.entries.filter((entry) => entry.id !== id);
  if (log.entries.length === before) return false;
  writeLog(log);
  return true;
}

/** Remove the takeoffs recorded in a flight bundle that has been deleted. */
function deleteEntriesForBundle(bundleName: string | null | undefined): number {
  const target = toText(bundleName, 200);
  if (!target) return 0;
  const log = readLog();
  const before = log.entries.length;
  log.entries = log.entries.filter((entry) => entry?.recording?.bundleName !== target);
  const removed = before - log.entries.length;
  if (removed > 0) writeLog(log);
  return removed;
}

function clearAll(): void {
  writeLog({ version: 1, entries: [] });
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
    if (grade === 'Late Liftoff' || grade === 'Dangerous' || grade === 'Overrun') cautionCount += 1;
    if (entry.icao) airports.add(entry.icao);
    if (entry.aircraft) aircraft.add(entry.aircraft);
  }
  const remaining = list.map((entry) => entry.runwayRemainingFt).filter((value): value is number => typeof value === 'number');
  return {
    total: list.length,
    grades,
    cautionCount,
    avgRollDistanceFt: averageRounded(list.map((entry) => entry.rollDistanceFt)),
    avgRunwayUsedPct: averageRounded(list.map((entry) => entry.runwayUsedPct), 1),
    minRunwayRemainingFt: remaining.length > 0 ? Math.min(...remaining) : null,
    airports: airports.size,
    aircraft: aircraft.size,
  };
}

function getStats(): AnyRecord {
  return computeStatsFromEntries(readLog().entries);
}

/** Return bounded display entries with totals for the complete saved takeoff log. */
function getLogbook(limit: unknown): { entries: TakeoffLogEntry[]; stats: AnyRecord } {
  const entries = getEntries();
  const numericLimit = Number(limit);
  const count = Number.isFinite(numericLimit) && numericLimit > 0
    ? Math.min(1000, Math.floor(numericLimit))
    : 500;
  return { entries: entries.slice(0, count), stats: computeStatsFromEntries(entries) };
}

module.exports = {
  TAKEOFF_LOG_FILE,
  addEntry,
  clearAll,
  computeStatsFromEntries,
  deleteEntriesForBundle,
  deleteEntry,
  extractEntry,
  getEntries,
  getLogbook,
  getStats,
};

export {};
