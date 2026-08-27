'use strict';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const { getBundleFromCsvPath, listBundleCsvPaths } = require('../flight-recording/recording-bundle-layout') as {
  getBundleFromCsvPath: (_csvPath: unknown) => { bundleName: string } | null;
  listBundleCsvPaths: (_outputDir: string) => string[];
};
const {
  readFlightAnalysisRescoreSidecar,
} = require('../flight-recording/flight-analysis-rescore-sidecar.js') as {
  readFlightAnalysisRescoreSidecar: (_csvPath: unknown) => {
    valid: boolean;
    document: GenericRecord | null;
  };
};
const timeSource = require('../core/time-source.js') as {
  now: () => number;
};
const {
  ensureDirExists,
  getAppDataRoot,
  LOGBOOK_FILE_NAME,
  resolveLogbookFilePath,
} = require('../utils/storage-paths.js') as {
  ensureDirExists: (dirPath: string) => string | null | undefined;
  getAppDataRoot: () => string;
  LOGBOOK_FILE_NAME: string;
  resolveLogbookFilePath: () => string;
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
const { getCsvRowWidthError } = require('../utils/csv.js') as {
  getCsvRowWidthError: (_headers: unknown[], _values: unknown[], _rowNumber: number) => string | null;
};
const { normalizeRetiredSpoilerStability } = require('../stability/retired-spoiler-compat.js') as {
  normalizeRetiredSpoilerStability: (value: unknown) => GenericRecord | null;
};
const { classifyApproachStability } = require('../stability/stability-runner.js') as {
  classifyApproachStability: (_value: GenericRecord | null | undefined) => string;
};
const {
  assessRecordedBounceEvidence,
  isLegacyRunwayExcursionGrade,
  resolveLandingRateHeadline,
} = require('./landing-replay-analysis.js') as {
  assessRecordedBounceEvidence: (_evidence: {
    airborneDurationMs?: number | null;
    altitudeLiftFt?: number | null;
    impactLoadG?: number | null;
    maxUpwardVsFpm?: number | null;
    radioHeightLiftFt?: number | null;
    recontactVsFpm?: number | null;
  }, _gradeFromVs: (_vsFpm: number) => string | null) => { confirmed: boolean };
  isLegacyRunwayExcursionGrade: (_value: unknown) => boolean;
  resolveLandingRateHeadline: (
    _row: GenericRecord | null | undefined,
    _gradeFromVs: (_vsFpm: number) => string | null,
    _fallback?: GenericRecord | null,
  ) => { vsFpm: number | null; grade: string | null };
};
const {
  inspectCsvBundleForCatalogSync,
  verifyRecordingBundleStatusWithCsvBuffer,
} = require('../flight-recording/recording-bundle-status') as {
  inspectCsvBundleForCatalogSync: (_csvPath: string) => {
    allowed: boolean;
    required: boolean;
    state: string;
    catalogRevision?: number;
    bundleSizeBytes?: number;
    recordingSessionId?: string;
    recordingFlightId?: string;
  };
  verifyRecordingBundleStatusWithCsvBuffer: (_csvPath: string, _buffer: Buffer) => Promise<{
    healthy: boolean;
    required: boolean;
    strictBundle: boolean;
    state: string;
  }>;
};

type GenericRecord = Record<string, any>;
const MSFS_TOUCHDOWN_ATTITUDE_NORMALIZED_SCHEMA_VERSION = 3;

type LandingEntry = {
  aircraft: string | null;
  aircraftProfileId: string | null;
  approachType: string | null;
  assists: GenericRecord | null;
  bankDeg: number | null;
  bounceCount: number | null;
  bounceCountSource?: 'recorded' | 'reconstructed' | 'unavailable';
  bounceGrade: string | null;
  bounceScore?: number | null;
  gateStable: boolean | null;
  stabilityGateFailures: string[];
  gforce: number | null;
  grade: string | null;
  iasKts: number | null;
  icao: string | null;
  id: string;
  lateralOffsetFt: number | null;
  lateralOffsetGrade: string | null;
  lateralOffsetScore: number | null;
  lateralOffsetSide: string | null;
  landingKey?: string | null;
  recordedGrade?: string | null;
  gradeSource?: 'recorded' | 'applied-rescore';
  analysisRescore?: GenericRecord | null;
  landingRateContext: GenericRecord | null;
  pitchDeg: number | null;
  runway: string | null;
  runwayCondition: string | null;
  runwayConditionConfident: boolean | null;
  runwayConditionSource: string | null;
  runwayExcursion: boolean;
  rolloutAnalysis: GenericRecord | null;
  runwayDisplacedThresholdFt: number | null;
  runwayGeometrySource: string | null;
  runwayGeometryProviderChain: string | null;
  runwayGeometryFallbackReason: string | null;
  runwayGeometryDiagnostics: GenericRecord | null;
  runwayHeadingTrueDeg: number | null;
  runwayLengthFt: number | null;
  runwayPhysicalLengthFt: number | null;
  runwayPhysicalThresholdLat: number | null;
  runwayPhysicalThresholdLon: number | null;
  runwayThresholdLat: number | null;
  runwayThresholdLon: number | null;
  runwayWidthFt: number | null;
  shortLanding: boolean;
  stabilityBreakdown: GenericRecord | null;
  stabilityContext: GenericRecord | null;
  stabilityScore: number | null;
  stabilityVerdict: 'stable' | 'marginal' | 'unstable' | 'no_verdict';
  surfaceName: string | null;
  touchdownDistanceFt: number | null;
  touchdownDistanceGrade: string | null;
  touchdownDistanceScore: number | null;
  touchdownDistanceZone?: string | null;
  timestamp: string;
  timestampMs: number;
  vsFpm: number | null;
  windDirDeg: number | null;
  windSpeedKts: number | null;
  xwindKts: number | null;
  gsKts: number | null;
};

type LogbookState = {
  entries: LandingEntry[];
  version: number;
};

type TrendsOptions = {
  aircraft?: string | null;
  windowSize?: number;
};

type GroupTrendSummary = {
  key: string;
  label: string;
  count: number;
  avgVsFpm: number | null;
  avgStabilityScore: number | null;
  stableRatePct: number | null;
  marginalRatePct: number | null;
  trendVs: 'improving' | 'regressing' | 'stable' | null;
  trendStability: 'improving' | 'regressing' | 'stable' | null;
  latestTimestampMs: number | null;
};

type FileLandingCacheEntry = {
  landings: LandingEntry[];
  mtimeMs: number;
  bundleStatusRequired: boolean;
  strictBundle: boolean;
  bundleFingerprint: string | null;
};

type CsvLogbookOptions = {
  bypassCachePaths?: string[];
  allowedCsvPaths?: string[];
};
type CsvLogbookListOptions = {
  allowedCsvPaths?: string[];
};
type CsvFileIdentity = {
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
  bundleStatusRequired: boolean;
  bundleCatalogRevision?: number;
  bundleSizeBytes?: number;
  recordingSessionId?: string;
  recordingFlightId?: string;
};
type CsvFileReadOptions = {
  bypassCache?: boolean;
  ignoreAnalysisRescore?: boolean;
  mtimeMs?: number;
};

type HistoryBounceCandidate = {
  baselineAltitudeFt: number | null;
  baselineRadioHeightFt: number | null;
  lastAirborneVsFpm: number | null;
  maxUpwardVsFpm: number | null;
  peakAltitudeFt: number | null;
  peakRadioHeightFt: number | null;
  startedElapsedMs: number;
};

type HistoryBounceState = {
  candidate: HistoryBounceCandidate | null;
  landingActive: boolean;
  lastGroundAltitudeFt: number | null;
  lastGroundRadioHeightFt: number | null;
  lastOnGround: boolean | null;
  pendingConfirmation: {
    airborneDurationMs: number;
    candidate: HistoryBounceCandidate;
    impactLoadG: number | null;
    impactVsFpm: number | null;
    touchdownElapsedMs: number;
  } | null;
  recoveredCount: number;
};

const LOGBOOK_CSV_READ_CONCURRENCY = 3;
const MAX_LANDINGS_FILE_CACHE_ENTRIES = 200;
const MAX_LOGBOOK_CSV_BYTES = 200 * 1024 * 1024;
const HISTORY_TOUCHDOWN_REARM_MS = 6000;
const HISTORY_BOUNCE_POST_IMPACT_CONFIRMATION_MS = 1000;
const COMPACT_REPEAT_COLUMNS = [
  'aircraft',
  'aircraft_profile_id',
  'data_source',
];

const APP_DATA_DIR = getAppDataRoot();
const LOGBOOK_FILE = resolveLogbookFilePath();
const landingsFileCache = new Map<string, FileLandingCacheEntry>();

function landingKeyFromSampleIndex(value: unknown): string | null {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? String(numeric) : null;
}

function getBundleFingerprint(filePath: string): string | null {
  const inspected = inspectCsvBundleForCatalogSync(filePath);
  if (
    !inspected.allowed
    || !Number.isSafeInteger(inspected.catalogRevision)
    || !Number.isSafeInteger(inspected.bundleSizeBytes)
  ) return null;
  return `${inspected.catalogRevision}:${inspected.bundleSizeBytes}`;
}

function canReuseLandingCache(
  entry: FileLandingCacheEntry | undefined,
  filePath: string,
  mtimeMs: number,
): boolean {
  if (!entry || entry.mtimeMs !== mtimeMs) return false;
  if (!entry.strictBundle) return true;
  const fingerprint = getBundleFingerprint(filePath);
  return fingerprint !== null && fingerprint === entry.bundleFingerprint;
}

function normalizeCachePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pruneStaleLandingsFileCache(activeFilePaths: string[]): void {
  const activeKeys = new Set(activeFilePaths.map(normalizeCachePath));
  for (const cacheKey of landingsFileCache.keys()) {
    if (!activeKeys.has(cacheKey)) {
      landingsFileCache.delete(cacheKey);
    }
  }
}

function pruneExcessLandingsFileCache(sortedFilePaths: string[]): void {
  if (landingsFileCache.size <= MAX_LANDINGS_FILE_CACHE_ENTRIES) return;

  const keepKeys = new Set(
    sortedFilePaths
      .slice(0, MAX_LANDINGS_FILE_CACHE_ENTRIES)
      .map(normalizeCachePath)
  );

  for (const cacheKey of landingsFileCache.keys()) {
    if (!keepKeys.has(cacheKey)) {
      landingsFileCache.delete(cacheKey);
    }
  }
}

function ensureDir(): void {
  ensureDirExists(APP_DATA_DIR);
  ensureDirExists(path.dirname(LOGBOOK_FILE));
}

function readLogbook(): LogbookState {
  let raw: string;
  try {
    raw = fs.readFileSync(LOGBOOK_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { version: 1, entries: [] };
    }
    throw error;
  }

  const data = JSON.parse(raw) as Partial<LogbookState>;
  if (!data || !Array.isArray(data.entries)) {
    throw new Error('Logbook file has an invalid structure');
  }
  return {
    version: Number(data.version) || 1,
    entries: data.entries as LandingEntry[],
  };
}

function writeLogbook(data: LogbookState): void {
  ensureDir();
  const json = JSON.stringify(data, null, 2);
  safeReplaceTextFileSync({
    allowedBasenames: [LOGBOOK_FILE_NAME],
    allowedExtensions: ['.json'],
    data: json,
    operation: 'writeLogbook',
    rootDir: APP_DATA_DIR,
    targetPath: LOGBOOK_FILE,
  });
}

function toNum(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toRecordedNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  return toNum(value);
}

function toBool(value: unknown): boolean | null {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function createHistoryBounceState(): HistoryBounceState {
  return {
    candidate: null,
    landingActive: false,
    lastGroundAltitudeFt: null,
    lastGroundRadioHeightFt: null,
    lastOnGround: null,
    pendingConfirmation: null,
    recoveredCount: 0,
  };
}

function updateHistoryBounceCandidate(
  candidate: HistoryBounceCandidate,
  row: GenericRecord,
): void {
  const altitudeFt = toRecordedNumber(row.alt_plane_ft);
  const radioHeightFt = toRecordedNumber(row.ra_ft);
  const vsFpm = toRecordedNumber(row.vs_fpm);
  if (altitudeFt !== null && (candidate.peakAltitudeFt === null || altitudeFt > candidate.peakAltitudeFt)) {
    candidate.peakAltitudeFt = altitudeFt;
  }
  if (
    radioHeightFt !== null
    && (candidate.peakRadioHeightFt === null || radioHeightFt > candidate.peakRadioHeightFt)
  ) {
    candidate.peakRadioHeightFt = radioHeightFt;
  }
  if (vsFpm !== null && (candidate.maxUpwardVsFpm === null || vsFpm > candidate.maxUpwardVsFpm)) {
    candidate.maxUpwardVsFpm = vsFpm;
  }
  if (vsFpm !== null) candidate.lastAirborneVsFpm = vsFpm;
}

function assessHistoryBounceCandidate(
  candidate: HistoryBounceCandidate,
  gradeFromVs: (vsFpm: number) => string | null,
  evidence: {
    airborneDurationMs: number;
    impactLoadG: number | null;
    impactVsFpm: number | null;
  },
): { confirmed: boolean } {
  const altitudeLiftFt = candidate.baselineAltitudeFt !== null && candidate.peakAltitudeFt !== null
    ? candidate.peakAltitudeFt - candidate.baselineAltitudeFt
    : null;
  const radioHeightLiftFt = (
    candidate.baselineRadioHeightFt !== null
    && candidate.peakRadioHeightFt !== null
  )
    ? candidate.peakRadioHeightFt - candidate.baselineRadioHeightFt
    : null;
  return assessRecordedBounceEvidence({
    airborneDurationMs: evidence.airborneDurationMs,
    altitudeLiftFt,
    impactLoadG: evidence.impactLoadG,
    maxUpwardVsFpm: candidate.maxUpwardVsFpm,
    radioHeightLiftFt,
    recontactVsFpm: evidence.impactVsFpm,
  }, gradeFromVs);
}

function isPlausibleHistoryTouchdown(row: GenericRecord): boolean {
  const iasKts = toRecordedNumber(row.ias_kts);
  const vsFpm = toRecordedNumber(row.vs_fpm);
  const radioHeightFt = toRecordedNumber(row.ra_ft);
  const phase = toText(row.phase)?.toUpperCase() || null;
  const isKnownNonLandingPhase = phase !== null && (
    phase.includes('TAKEOFF')
    || phase.includes('TAXI')
    || phase.includes('PARK')
  );
  return !isKnownNonLandingPhase
    && iasKts !== null
    && iasKts > 50
    && iasKts < 250
    && (radioHeightFt === null || radioHeightFt <= 50)
    && vsFpm !== null
    && vsFpm < 0;
}

function observeHistoryBounceSample(
  state: HistoryBounceState,
  row: GenericRecord,
  gradeFromVs: (vsFpm: number) => string | null,
): void {
  const onGround = toBool(row.on_ground);
  const elapsedMs = toRecordedNumber(row.flight_elapsed_ms) ?? toRecordedNumber(row.ts);
  if (onGround === null || elapsedMs === null) return;

  if (state.pendingConfirmation) {
    const pending = state.pendingConfirmation;
    const confirmationAgeMs = elapsedMs - pending.touchdownElapsedMs;
    if (onGround === false) {
      state.pendingConfirmation = null;
    } else if (confirmationAgeMs >= 0) {
      const measuredLoadG = toRecordedNumber(row.g_force);
      if (
        measuredLoadG !== null
        && measuredLoadG > 0
        && measuredLoadG <= 10
        && (pending.impactLoadG === null || measuredLoadG > pending.impactLoadG)
      ) {
        pending.impactLoadG = measuredLoadG;
      }
      const delayedAssessment = assessHistoryBounceCandidate(pending.candidate, gradeFromVs, {
        airborneDurationMs: pending.airborneDurationMs,
        impactLoadG: pending.impactLoadG,
        impactVsFpm: pending.impactVsFpm,
      });
      if (
        confirmationAgeMs <= HISTORY_BOUNCE_POST_IMPACT_CONFIRMATION_MS
        && delayedAssessment.confirmed
      ) {
        state.recoveredCount += 1;
        state.pendingConfirmation = null;
      } else if (confirmationAgeMs >= HISTORY_BOUNCE_POST_IMPACT_CONFIRMATION_MS) {
        state.pendingConfirmation = null;
      }
    } else if (confirmationAgeMs >= HISTORY_BOUNCE_POST_IMPACT_CONFIRMATION_MS) {
      state.pendingConfirmation = null;
    }
  }

  if (state.candidate && onGround === false) {
    updateHistoryBounceCandidate(state.candidate, row);
    if (elapsedMs - state.candidate.startedElapsedMs >= HISTORY_TOUCHDOWN_REARM_MS) {
      // A sustained airborne segment is a go-around/new approach, not a bounce
      // belonging to the previous landing row.
      state.candidate = null;
      state.pendingConfirmation = null;
      state.landingActive = false;
      state.recoveredCount = 0;
    }
  }

  if (state.lastOnGround === true && onGround === false && state.landingActive) {
    state.candidate = {
      baselineAltitudeFt: state.lastGroundAltitudeFt,
      baselineRadioHeightFt: state.lastGroundRadioHeightFt,
      lastAirborneVsFpm: null,
      maxUpwardVsFpm: null,
      peakAltitudeFt: null,
      peakRadioHeightFt: null,
      startedElapsedMs: elapsedMs,
    };
    updateHistoryBounceCandidate(state.candidate, row);
  } else if (state.lastOnGround === false && onGround === true) {
    if (state.landingActive && state.candidate) {
      const candidate = state.candidate;
      const recontactVsFpm = toRecordedNumber(row.vs_fpm);
      const impactVsFpm = recontactVsFpm !== null && candidate.lastAirborneVsFpm !== null
        ? Math.min(recontactVsFpm, candidate.lastAirborneVsFpm)
        : (recontactVsFpm ?? candidate.lastAirborneVsFpm);
      const airborneDurationMs = Math.max(0, elapsedMs - candidate.startedElapsedMs);
      const impactLoadG = toRecordedNumber(row.g_force);
      const assessment = assessHistoryBounceCandidate(candidate, gradeFromVs, {
        airborneDurationMs,
        impactLoadG,
        impactVsFpm,
      });
      if (assessment.confirmed) {
        state.recoveredCount += 1;
      } else {
        state.pendingConfirmation = {
          airborneDurationMs,
          candidate,
          impactLoadG,
          impactVsFpm,
          touchdownElapsedMs: elapsedMs,
        };
      }
      state.candidate = null;
    } else if (!state.landingActive && isPlausibleHistoryTouchdown(row)) {
      state.landingActive = true;
      state.recoveredCount = 0;
    }
  }

  if (onGround) {
    state.lastGroundAltitudeFt = toRecordedNumber(row.alt_plane_ft);
    state.lastGroundRadioHeightFt = toRecordedNumber(row.ra_ft);
  }
  state.lastOnGround = onGround;
}

function consumeHistoryBounceCount(state: HistoryBounceState): number {
  const recoveredCount = state.recoveredCount;
  state.candidate = null;
  state.landingActive = false;
  state.pendingConfirmation = null;
  state.recoveredCount = 0;
  return recoveredCount;
}

function isLegacyMsfsTouchdownAttitude(record: GenericRecord | null | undefined): boolean {
  if (!record) return false;
  const schemaVersion = toNum(record.schema_version ?? record.schemaVersion) ?? 2;
  const source = toText(
    record.touchdown_capture_source ??
    record.touchdownCaptureSource ??
    record.td_sim_source ??
    record.tdSimSource,
  );
  return schemaVersion < MSFS_TOUCHDOWN_ATTITUDE_NORMALIZED_SCHEMA_VERSION && source === 'msfs_last_touchdown';
}

function normalizeLandingAttitudeDeg(record: GenericRecord, value: unknown): number | null {
  const numeric = toNum(value);
  if (numeric == null) return null;
  return isLegacyMsfsTouchdownAttitude(record) ? -numeric : numeric;
}

const STABILITY_BREAKDOWN_FIELDS = [
  ['gear_ok', 'ultimate_stability_gear_ok_pct'],
  ['flaps_ok', 'ultimate_stability_flaps_ok_pct'],
  ['spoilers_ok', 'ultimate_stability_spoilers_ok_pct'],
  ['config_ok', 'ultimate_stability_config_ok_pct'],
  ['speed_ok', 'ultimate_stability_speed_ok_pct'],
  ['speed_trend_ok', 'ultimate_stability_speed_trend_ok_pct'],
  ['vs_ok', 'ultimate_stability_vs_ok_pct'],
  ['glidepath_ok', 'ultimate_stability_glidepath_ok_pct'],
  ['glidepath_below_ok', 'ultimate_stability_glidepath_below_ok_pct'],
  ['glidepath_above_ok', 'ultimate_stability_glidepath_above_ok_pct'],
  ['thrust_ok', 'ultimate_stability_thrust_ok_pct'],
  ['thrust_not_idle_ok', 'ultimate_stability_thrust_not_idle_ok_pct'],
  ['thrust_stable_ok', 'ultimate_stability_thrust_stable_ok_pct'],
  ['pitch_ok', 'ultimate_stability_pitch_ok_pct'],
  ['bank_ok', 'ultimate_stability_bank_ok_pct'],
  ['lateral_offset_ok', 'ultimate_stability_lateral_offset_ok_pct'],
] as const;

const LOGBOOK_GRADE_SEVERITY: Record<string, number> = {
  PERFECT: 0,
  BUTTER: 0,
  SMOOTH: 0,
  GOOD: 0,
  FIRM: 1,
  HARD: 2,
  'VERY HARD': 3,
  'RUNWAY EXCURSION': 3,
  SEVERE: 3,
  Outstanding: 0,
  Good: 0,
  Acceptable: 1,
  Marginal: 1,
  'Long Landing': 2,
  Poor: 2,
  Dangerous: 3,
  'Short Landing': 3,
};

function parseBreakdownObject(value: unknown): GenericRecord | null {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value as GenericRecord;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as GenericRecord : null;
  } catch {
    return null;
  }
}

function buildStabilityBreakdown(source: GenericRecord): GenericRecord | null {
  const breakdown = parseBreakdownObject(source.ultimate_stability_breakdown) || {};
  for (const [key, sourceKey] of STABILITY_BREAKDOWN_FIELDS) {
    const numeric = toNum(source[sourceKey]);
    if (numeric !== null) breakdown[key] = numeric;
  }
  return Object.keys(breakdown).length > 0 ? breakdown : null;
}

function normalizeGateFailures(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).map((failure) => failure.trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split('|').map((failure) => failure.trim()).filter(Boolean);
  }
  return [];
}

function buildStabilityResult(source: GenericRecord): GenericRecord {
  return normalizeRetiredSpoilerStability({
    score: toNum(source.ultimate_stability_score),
    verdict: toText(
      source.ultimate_stability_verdict
      ?? source.ultimateStabilityVerdict
      ?? source.ultimateStability?.verdict,
    ),
    gateStable: toBool(source.ultimate_stability_gate_stable),
    gateFailures: normalizeGateFailures(
      source.ultimate_stability_gate_failures ?? source.ultimate_stability_gateFailures,
    ),
    breakdown: buildStabilityBreakdown(source),
  }) || {
    score: toNum(source.ultimate_stability_score),
    verdict: 'no_verdict',
    gateStable: toBool(source.ultimate_stability_gate_stable),
    gateFailures: [],
    breakdown: null,
  };
}

function logbookGradeSeverity(grade: unknown): number {
  if (!grade || typeof grade !== 'string') return -1;
  return LOGBOOK_GRADE_SEVERITY[grade] ?? -1;
}

function hasExplicitlyCleanLogbookBounce(entry: Partial<LandingEntry>): boolean {
  const rawCount: unknown = entry.bounceCount;
  const hasCount = rawCount !== null
    && rawCount !== undefined
    && rawCount !== ''
    && Number.isFinite(Number(rawCount));
  const bounceGrade = typeof entry.bounceGrade === 'string' ? entry.bounceGrade.trim() : '';
  if (!hasCount && !bounceGrade) return false;
  const normalizedCount = hasCount ? Math.max(0, Math.round(Number(rawCount))) : 0;
  return normalizedCount === 0 && (!bounceGrade || bounceGrade.toLowerCase() === 'clean');
}

function isVerifiedPerfectLogbookEntry(entry: Partial<LandingEntry>): boolean {
  const touchdownDistanceFt = Number(entry.touchdownDistanceFt);
  return entry.gateStable === true
    && entry.touchdownDistanceFt !== null
    && entry.touchdownDistanceFt !== undefined
    && Number.isFinite(touchdownDistanceFt)
    && touchdownDistanceFt >= 0
    && touchdownDistanceFt <= 1000
    && hasExplicitlyCleanLogbookBounce(entry);
}

function logbookOutcomeGrade(entry: Partial<LandingEntry>): string | null {
  if (entry.runwayExcursion === true) return 'RUNWAY EXCURSION';
  const touchdownGrade = entry.shortLanding === true
    ? 'Short Landing'
    : (typeof entry.touchdownDistanceGrade === 'string' && entry.touchdownDistanceGrade.trim()
      ? entry.touchdownDistanceGrade.trim()
      : null);
  const vsGrade = typeof entry.grade === 'string' && entry.grade.trim() ? entry.grade.trim() : null;
  const touchdownSeverity = logbookGradeSeverity(touchdownGrade);
  const vsSeverity = logbookGradeSeverity(vsGrade);
  const outcomeGrade = touchdownSeverity > vsSeverity ? touchdownGrade : (vsGrade || touchdownGrade);
  return outcomeGrade?.toUpperCase() === 'PERFECT' && !isVerifiedPerfectLogbookEntry(entry)
    ? 'SMOOTH'
    : outcomeGrade;
}

function nestedAssistValue(source: GenericRecord, key: string): unknown {
  const assists = source.assists;
  return assists && typeof assists === 'object' ? assists[key] : undefined;
}

function buildAssistSummary(source: GenericRecord): GenericRecord | null {
  const summary = {
    unlimitedFuel: toBool(source.assist_unlimited_fuel ?? nestedAssistValue(source, 'unlimitedFuel')),
    landingAssist: toBool(source.assist_landing_enabled ?? nestedAssistValue(source, 'landingAssist')),
    takeoffAssist: toBool(source.assist_takeoff_enabled ?? nestedAssistValue(source, 'takeoffAssist')),
    aiControls: toBool(source.assist_ai_controls ?? nestedAssistValue(source, 'aiControls')),
    aiAutotrim: toBool(source.assist_ai_autotrim ?? nestedAssistValue(source, 'aiAutotrim')),
    aiDelegated: toBool(source.assist_ai_delegated ?? nestedAssistValue(source, 'aiDelegated')),
    aiAntistall: toNum(source.assist_ai_antistall_state ?? nestedAssistValue(source, 'aiAntistall')),
    aiAntistallActive: toBool(source.assist_ai_antistall_active ?? nestedAssistValue(source, 'aiAntistallActive')),
    realismPercent: toNum(source.assist_realism_pct ?? nestedAssistValue(source, 'realismPercent')),
    fullRealism: toBool(source.assist_full_realism ?? nestedAssistValue(source, 'fullRealism')),
    slewActive: toBool(source.assist_slew_active ?? nestedAssistValue(source, 'slewActive')),
    anyAssistActive: toBool(source.assist_any_active ?? nestedAssistValue(source, 'anyAssistActive')),
  };
  return Object.values(summary).some((value) => value !== null) ? summary : null;
}

function extractEntry(payload: GenericRecord | null | undefined): LandingEntry | null {
  if (!payload) return null;

  const { gradeLandingForRecordedProfile } = require('./landing.js') as {
    gradeLandingForRecordedProfile: (vsFpm: number, profileId: unknown) => GenericRecord | null;
  };
  const aircraftProfileId = toText(payload.aircraft_profile_id ?? payload.aircraftProfileId);
  const headline = resolveLandingRateHeadline(
    payload,
    (vsFpm) => toText(gradeLandingForRecordedProfile(vsFpm, aircraftProfileId)?.grade),
  );
  const payloadTimestampMs = toNum(payload.timestamp_ms);
  const stability = buildStabilityResult(payload);
  const timestamp =
    typeof payload.timestamp_utc === 'string' && payload.timestamp_utc
      ? payload.timestamp_utc
      : payloadTimestampMs != null
        ? new Date(payloadTimestampMs).toISOString()
        : new Date().toISOString();

  return {
    id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp,
    timestampMs: payloadTimestampMs ?? timeSource.now(),
    aircraft: payload.aircraft || null,
    aircraftProfileId,
    assists: buildAssistSummary(payload),
    icao: payload.icao || null,
    runway: toText(payload.runway),
    approachType: payload.approach_type || null,
    vsFpm: headline.vsFpm,
    iasKts: toNum(payload.ias_kts),
    gsKts: toNum(payload.gs_kts),
    grade: headline.grade,
    landingKey: landingKeyFromSampleIndex(payload.sample_index ?? payload.sampleIndex),
    recordedGrade: headline.grade,
    gradeSource: 'recorded',
    analysisRescore: null,
    landingRateContext: parseBreakdownObject(
      payload.landing_rate_context ?? payload.landingRateContext,
    ),
    gforce: toNum(payload.gforce),
    pitchDeg: normalizeLandingAttitudeDeg(payload, payload.pitch_deg ?? payload.pitchDeg),
    bankDeg: normalizeLandingAttitudeDeg(payload, payload.bank_deg ?? payload.bankDeg),
    windSpeedKts: toNum(payload.wind_speed_kts),
    windDirDeg: toNum(payload.wind_dir_deg),
    xwindKts: toNum(payload.xwind_kts),
    touchdownDistanceFt: toNum(payload.touchdown_distance_ft),
    touchdownDistanceGrade: payload.touchdown_distance_grade || null,
    touchdownDistanceScore: toNum(payload.touchdown_distance_score),
    lateralOffsetFt: toNum(payload.lateral_offset_ft),
    lateralOffsetGrade: payload.lateral_offset_grade || null,
    lateralOffsetScore: toNum(payload.lateral_offset_score),
    lateralOffsetSide: payload.lateral_offset_side || null,
    bounceCount: toNum(payload.bounce_count),
    bounceGrade: payload.bounce_grade || null,
    stabilityScore: stability.score,
    stabilityVerdict: stability.verdict,
    stabilityGateFailures: stability.gateFailures,
    stabilityBreakdown: stability.breakdown,
    stabilityContext: parseBreakdownObject(
      payload.ultimate_stability_context
      ?? payload.stabilityContext
      ?? payload.ultimateStability?.scoringContext,
    ),
    gateStable: stability.gateStable,
    runwayExcursion: toBool(payload.runway_excursion) === true
      || isLegacyRunwayExcursionGrade(payload.grade),
    rolloutAnalysis: parseBreakdownObject(payload.rollout_analysis ?? payload.rolloutAnalysis),
    shortLanding: toBool(payload.short_landing) ?? false,
    runwayCondition: payload.runway_condition || null,
    runwayConditionSource: payload.runway_condition_source || null,
    runwayConditionConfident: toBool(payload.runway_condition_confident),
    runwayGeometrySource: payload.runway_geometry_source || null,
    runwayGeometryProviderChain: payload.runway_geometry_provider_chain || null,
    runwayGeometryFallbackReason: payload.runway_geometry_fallback_reason || null,
    runwayGeometryDiagnostics: parseBreakdownObject(payload.runway_geometry_diagnostics),
    runwayHeadingTrueDeg: toNum(payload.runway_heading_true_deg),
    runwayLengthFt: toNum(payload.runway_length_ft),
    runwayPhysicalLengthFt: toNum(payload.runway_physical_length_ft),
    runwayThresholdLat: toNum(payload.runway_threshold_lat),
    runwayThresholdLon: toNum(payload.runway_threshold_lon),
    runwayPhysicalThresholdLat: toNum(payload.runway_physical_threshold_lat),
    runwayPhysicalThresholdLon: toNum(payload.runway_physical_threshold_lon),
    runwayDisplacedThresholdFt: toNum(payload.runway_displaced_threshold_ft),
    runwayWidthFt: toNum(payload.runway_width_ft),
    surfaceName: payload.surface_name || null,
  };
}

function addEntry(payload: GenericRecord | null | undefined): LandingEntry | null {
  const entry = extractEntry(payload);
  if (!entry) return null;

  const logbook = readLogbook();
  logbook.entries.unshift(entry);
  writeLogbook(logbook);
  return entry;
}

function getEntries(): LandingEntry[] {
  return readLogbook().entries;
}

function getStats(): GenericRecord {
  const entries = readLogbook().entries;
  return computeStatsFromEntries(entries);
}

function linearSlope(values: Array<number | null | undefined>): number | null {
  const valid = values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
  const length = valid.length;
  if (length < 3) return null;
  const xMean = (length - 1) / 2;
  const yMean = valid.reduce((left, right) => left + right, 0) / length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < length; index += 1) {
    numerator += (index - xMean) * (valid[index] - yMean);
    denominator += (index - xMean) * (index - xMean);
  }
  const raw = denominator === 0 ? 0 : numerator / denominator;
  // Express the fitted slope across the full window so sample count does not change the label.
  const windowChange = raw * (length - 1);
  const magnitude = Math.abs(yMean);
  return magnitude > 0.001 ? windowChange / magnitude : windowChange;
}

function linearTrend(values: Array<number | null | undefined>, metric: string): 'improving' | 'regressing' | 'stable' | null {
  const slope = linearSlope(values);
  if (slope === null) return null;
  const threshold = 0.03;
  if (metric === 'vs') return slope > threshold ? 'improving' : slope < -threshold ? 'regressing' : 'stable';
  if (metric === 'gforce') return slope < -threshold ? 'improving' : slope > threshold ? 'regressing' : 'stable';
  if (metric === 'stability') return slope > threshold ? 'improving' : slope < -threshold ? 'regressing' : 'stable';
  return 'stable';
}

function averageRounded(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  if (finite.length === 0) return null;
  return Math.round(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

function resolveLandingEntryStabilityVerdict(entry: Partial<LandingEntry>): string {
  if (
    entry.stabilityVerdict === 'stable'
    || entry.stabilityVerdict === 'marginal'
    || entry.stabilityVerdict === 'unstable'
    || entry.stabilityVerdict === 'no_verdict'
  ) return entry.stabilityVerdict;
  return classifyApproachStability({
    score: entry.stabilityScore,
    gateStable: entry.gateStable,
    gateFailures: entry.stabilityGateFailures,
    breakdown: entry.stabilityBreakdown,
  });
}

function computeGroupTrendRows(
  entries: LandingEntry[],
  getKey: (entry: LandingEntry) => string | null,
  getLabel: (entry: LandingEntry) => string | null,
  limit = 5,
): GroupTrendSummary[] {
  const groups = new Map<string, LandingEntry[]>();
  const labels = new Map<string, string>();

  for (const entry of entries) {
    const key = getKey(entry);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(entry);
    if (!labels.has(key)) labels.set(key, getLabel(entry) || key);
  }

  return [...groups.entries()]
    .map(([key, groupEntries]) => {
      const chronological = groupEntries
        .slice()
        .sort((left, right) => (left.timestampMs ?? 0) - (right.timestampMs ?? 0));
      const verdictValues = groupEntries
        .map(resolveLandingEntryStabilityVerdict)
        .filter((verdict) => verdict !== 'no_verdict');
      const stableCount = verdictValues.filter((verdict) => verdict === 'stable').length;
      const marginalCount = verdictValues.filter((verdict) => verdict === 'marginal').length;
      const latestTimestampMs = groupEntries.reduce((latest, entry) => (
        Number.isFinite(entry.timestampMs) ? Math.max(latest, entry.timestampMs) : latest
      ), Number.NEGATIVE_INFINITY);

      return {
        key,
        label: labels.get(key) || key,
        count: groupEntries.length,
        avgVsFpm: averageRounded(groupEntries.map((entry) => entry.vsFpm)),
        avgStabilityScore: averageRounded(groupEntries.map((entry) => entry.stabilityScore)),
        stableRatePct: verdictValues.length > 0 ? Math.round((stableCount / verdictValues.length) * 100) : null,
        marginalRatePct: verdictValues.length > 0 ? Math.round((marginalCount / verdictValues.length) * 100) : null,
        trendVs: linearTrend(chronological.map((entry) => entry.vsFpm), 'vs'),
        trendStability: linearTrend(chronological.map((entry) => entry.stabilityScore), 'stability'),
        latestTimestampMs: Number.isFinite(latestTimestampMs) ? latestTimestampMs : null,
      };
    })
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return (right.latestTimestampMs ?? 0) - (left.latestTimestampMs ?? 0);
    })
    .slice(0, limit);
}

function getTrends(options?: TrendsOptions): GenericRecord {
  const aircraft = options && typeof options.aircraft === 'string' && options.aircraft ? options.aircraft : null;
  const windowSize = options && Number.isInteger(options.windowSize) && (options.windowSize as number) >= 0
    ? (options.windowSize as number)
    : 20;

  const all = readLogbook().entries;
  const aircraftNames = [...new Set(all.map((entry) => entry.aircraft).filter(Boolean))].sort();
  const pool = aircraft ? all.filter((entry) => entry.aircraft === aircraft) : all;
  const chronoWindow = (windowSize === 0 ? pool.slice() : pool.slice(0, windowSize)).reverse();

  if (chronoWindow.length === 0) {
    return { points: [], aircraftNames, trendVs: null, trendGforce: null, trendStability: null };
  }

  const points = chronoWindow.map((entry) => ({
    timestampMs: entry.timestampMs,
    vsFpm: entry.vsFpm,
    gforce: entry.gforce,
    stabilityScore: entry.stabilityScore,
    stabilityVerdict: resolveLandingEntryStabilityVerdict(entry),
    grade: entry.grade,
    icao: entry.icao,
    aircraft: entry.aircraft,
  }));

  return {
    points,
    aircraftNames,
    trendVs: linearTrend(points.map((point) => point.vsFpm), 'vs'),
    trendGforce: linearTrend(points.map((point) => point.gforce), 'gforce'),
    trendStability: linearTrend(points.map((point) => point.stabilityScore), 'stability'),
  };
}

function deleteEntry(id: string | null | undefined): boolean {
  if (!id) return false;
  const logbook = readLogbook();
  const before = logbook.entries.length;
  logbook.entries = logbook.entries.filter((entry) => entry.id !== id);
  if (logbook.entries.length === before) return false;
  writeLogbook(logbook);
  return true;
}

function clearAll(): void {
  writeLogbook({ version: 1, entries: [] });
}

function parseLandingsFromContent(
  content: string,
  filePath: string,
  parseCsvLine: (line: string, options?: { trimValues?: boolean }) => string[],
  gradeLandingForRecordedProfile: (vsFpm: number, profileId: unknown) => GenericRecord | null,
  splitCsvLines: (content: string, options?: { trimAndDropEmpty?: boolean }) => string[],
  gradeLandingForImpactProfile: (vsFpm: number, profileId: unknown) => GenericRecord | null
    = gradeLandingForRecordedProfile,
): LandingEntry[] {
  const lines = splitCsvLines(content, { trimAndDropEmpty: true });
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map((header) => header.trim());
  const recordTypeIndex = headers.indexOf('record_type');
  if (recordTypeIndex === -1) {
    throw new Error('Logbook CSV is missing the record_type column');
  }

  const landings: LandingEntry[] = [];
  const compactDefaults: GenericRecord = {};
  const bounceState = createHistoryBounceState();

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const values = parseCsvLine(line, { trimValues: true });
    if (!values) {
      throw new Error(`Logbook CSV row ${index + 1} could not be parsed`);
    }
    const rowWidthError = getCsvRowWidthError(headers, values, index + 1);
    if (rowWidthError) {
      throw new Error(rowWidthError);
    }

    const row: GenericRecord = {};
    for (let valueIndex = 0; valueIndex < headers.length && valueIndex < values.length; valueIndex += 1) {
      const value = values[valueIndex];
      if (value === '' || value === undefined) {
        row[headers[valueIndex]] = null;
        continue;
      }
      if (value === 'true') {
        row[headers[valueIndex]] = true;
        continue;
      }
      if (value === 'false') {
        row[headers[valueIndex]] = false;
        continue;
      }
      const numeric = Number(value);
      row[headers[valueIndex]] = !Number.isNaN(numeric) && value.trim() !== '' ? numeric : value;
    }

    for (const column of COMPACT_REPEAT_COLUMNS) {
      const value = row[column];
      if (value !== null && value !== undefined && value !== '') {
        compactDefaults[column] = value;
      } else if (compactDefaults[column] !== null && compactDefaults[column] !== undefined && compactDefaults[column] !== '') {
        row[column] = compactDefaults[column];
      }
    }

    const headlineGradeFromVs = (landingVsFpm: number): string | null => toText(
      gradeLandingForRecordedProfile(landingVsFpm, row.aircraft_profile_id)?.grade,
    );
    const impactGradeFromVs = (landingVsFpm: number): string | null => toText(
      gradeLandingForImpactProfile(landingVsFpm, row.aircraft_profile_id)?.grade,
    );

    const recordType = toText(row.record_type) || values[recordTypeIndex];
    if (recordType === 'SAMPLE') {
      observeHistoryBounceSample(bounceState, row, impactGradeFromVs);
      continue;
    }
    if (recordType !== 'LANDING') continue;

    const recoveredBounceCount = consumeHistoryBounceCount(bounceState);
    const headline = resolveLandingRateHeadline(row, headlineGradeFromVs);
    const vsFpm = headline.vsFpm;
    if (vsFpm === null || vsFpm >= 0) continue;
    const grade = headline.grade;
    const persistedBounceCount = toRecordedNumber(row.bounce_count);
    const bounceCount = persistedBounceCount ?? (recoveredBounceCount > 0 ? recoveredBounceCount : null);
    const bounceCountSource = persistedBounceCount !== null
      ? 'recorded'
      : (recoveredBounceCount > 0 ? 'reconstructed' : 'unavailable');

    const stability = buildStabilityResult(row);

    const timestampMs = typeof row.ts === 'number' ? row.ts : null;
    const timestamp =
      typeof row.timestamp_utc === 'string' && row.timestamp_utc
        ? row.timestamp_utc
        : (timestampMs !== null ? new Date(timestampMs).toISOString() : null);

    landings.push({
      id: `${getBundleFromCsvPath(filePath)?.bundleName || path.basename(filePath)}-${index}`,
      timestamp: timestamp || new Date().toISOString(),
      timestampMs: timestampMs ?? 0,
      aircraft: typeof row.aircraft === 'string' && row.aircraft.trim() ? row.aircraft.trim() : null,
      aircraftProfileId: toText(row.aircraft_profile_id),
      assists: buildAssistSummary(row),
      icao: typeof row.icao === 'string' && row.icao.trim() ? row.icao.trim() : null,
      runway: toText(row.runway),
      approachType:
        typeof row.approach_type === 'string' && row.approach_type.trim() ? row.approach_type.trim() : null,
      vsFpm,
      grade,
      landingKey: landingKeyFromSampleIndex(row.sample_index),
      recordedGrade: grade,
      gradeSource: 'recorded',
      analysisRescore: null,
      landingRateContext: parseBreakdownObject(row.landing_rate_context),
      gforce: typeof row.g_force === 'number' ? row.g_force : null,
      iasKts: typeof row.ias_kts === 'number' ? row.ias_kts : null,
      xwindKts: typeof row.xwind_kts === 'number' ? row.xwind_kts : null,
      gsKts: typeof row.gs_kts === 'number' ? row.gs_kts : null,
      pitchDeg: normalizeLandingAttitudeDeg(row, row.pitch_deg),
      bankDeg: normalizeLandingAttitudeDeg(row, row.bank_deg),
      windSpeedKts: typeof row.wind_speed_kts === 'number' ? row.wind_speed_kts : null,
      windDirDeg: typeof row.wind_dir_deg === 'number' ? row.wind_dir_deg : null,
      touchdownDistanceFt: typeof row.touchdown_distance_ft === 'number' ? row.touchdown_distance_ft : null,
      touchdownDistanceGrade:
        typeof row.touchdown_distance_grade === 'string' && row.touchdown_distance_grade.trim()
          ? row.touchdown_distance_grade.trim()
          : null,
      touchdownDistanceScore:
        typeof row.touchdown_distance_score === 'number' ? row.touchdown_distance_score : null,
      lateralOffsetFt: typeof row.lateral_offset_ft === 'number' ? row.lateral_offset_ft : null,
      lateralOffsetGrade:
        typeof row.lateral_offset_grade === 'string' && row.lateral_offset_grade.trim()
          ? row.lateral_offset_grade.trim()
          : null,
      lateralOffsetScore: typeof row.lateral_offset_score === 'number' ? row.lateral_offset_score : null,
      lateralOffsetSide:
        typeof row.lateral_offset_side === 'string' && row.lateral_offset_side.trim()
          ? row.lateral_offset_side.trim()
          : null,
      stabilityScore: stability.score,
      stabilityVerdict: stability.verdict,
      stabilityGateFailures: stability.gateFailures,
      stabilityBreakdown: stability.breakdown,
      stabilityContext: parseBreakdownObject(row.ultimate_stability_context),
      gateStable: stability.gateStable,
      bounceCount,
      bounceCountSource,
      bounceGrade: typeof row.bounce_grade === 'string' && row.bounce_grade.trim() ? row.bounce_grade.trim() : null,
      runwayExcursion: toBool(row.runway_excursion) === true
        || isLegacyRunwayExcursionGrade(row.grade),
      rolloutAnalysis: parseBreakdownObject(row.rollout_analysis),
      shortLanding: toBool(row.short_landing) ?? false,
      runwayCondition:
        typeof row.runway_condition === 'string' && row.runway_condition.trim() ? row.runway_condition.trim() : null,
      runwayConditionSource:
        typeof row.runway_condition_source === 'string' && row.runway_condition_source.trim()
          ? row.runway_condition_source.trim()
          : null,
      runwayConditionConfident: toBool(row.runway_condition_confident),
      runwayGeometrySource:
        typeof row.runway_geometry_source === 'string' && row.runway_geometry_source.trim()
          ? row.runway_geometry_source.trim()
          : null,
      runwayGeometryProviderChain:
        typeof row.runway_geometry_provider_chain === 'string' && row.runway_geometry_provider_chain.trim()
          ? row.runway_geometry_provider_chain.trim()
          : null,
      runwayGeometryFallbackReason:
        typeof row.runway_geometry_fallback_reason === 'string' && row.runway_geometry_fallback_reason.trim()
          ? row.runway_geometry_fallback_reason.trim()
          : null,
      runwayGeometryDiagnostics: parseBreakdownObject(row.runway_geometry_diagnostics),
      runwayHeadingTrueDeg: typeof row.runway_heading_true_deg === 'number' ? row.runway_heading_true_deg : null,
      runwayLengthFt: typeof row.runway_length_ft === 'number' ? row.runway_length_ft : null,
      runwayPhysicalLengthFt:
        typeof row.runway_physical_length_ft === 'number' ? row.runway_physical_length_ft : null,
      runwayThresholdLat: typeof row.runway_threshold_lat === 'number' ? row.runway_threshold_lat : null,
      runwayThresholdLon: typeof row.runway_threshold_lon === 'number' ? row.runway_threshold_lon : null,
      runwayPhysicalThresholdLat:
        typeof row.runway_physical_threshold_lat === 'number' ? row.runway_physical_threshold_lat : null,
      runwayPhysicalThresholdLon:
        typeof row.runway_physical_threshold_lon === 'number' ? row.runway_physical_threshold_lon : null,
      runwayDisplacedThresholdFt:
        typeof row.runway_displaced_threshold_ft === 'number' ? row.runway_displaced_threshold_ft : null,
      runwayWidthFt: typeof row.runway_width_ft === 'number' ? row.runway_width_ft : null,
      surfaceName: typeof row.surface_name === 'string' && row.surface_name.trim() ? row.surface_name.trim() : null,
    });
  }

  return landings;
}

function listLogbookCsvFiles(options: CsvLogbookListOptions = {}): CsvFileIdentity[] {
  const { resolveFlightLogsDir } = require('../utils/flight-logs-dir.js') as {
    resolveFlightLogsDir: () => string;
  };

  const logsDir = resolveFlightLogsDir();
  if (!fs.existsSync(logsDir)) return [];
  const allowedPaths = Array.isArray(options.allowedCsvPaths)
    ? new Set(options.allowedCsvPaths
        .filter((filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0)
        .map(normalizeCachePath))
    : null;

  try {
    return listBundleCsvPaths(logsDir)
      .filter((filePath) => (
        allowedPaths ? allowedPaths.has(normalizeCachePath(filePath)) : true
      ))
      .map((filePath) => {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error('Logbook CSV is not a regular file');
        }
        if (stat.size > MAX_LOGBOOK_CSV_BYTES) return null;
        const bundle = inspectCsvBundleForCatalogSync(filePath);
        if (!bundle.allowed) return null;
        return {
          filePath,
          mtimeMs: stat.mtimeMs,
          sizeBytes: stat.size,
          bundleStatusRequired: bundle.required,
          ...(bundle.recordingSessionId ? { recordingSessionId: bundle.recordingSessionId } : {}),
          ...(bundle.recordingFlightId ? { recordingFlightId: bundle.recordingFlightId } : {}),
          ...(Number.isSafeInteger(bundle.catalogRevision)
            ? {
                bundleCatalogRevision: bundle.catalogRevision,
                bundleSizeBytes: bundle.bundleSizeBytes,
              }
            : {}),
        };
      })
      .filter((entry): entry is CsvFileIdentity => Boolean(entry))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
  } catch (error) {
    // An empty array is a valid, authoritative result only when the directory
    // is genuinely empty. Converting an I/O failure into [] lets downstream
    // reconciliation prune healthy SQLite rows as though every flight had
    // been deleted.
    throw new Error(
      `Flight history catalog scan failed: ${error instanceof Error ? error.message : String(error || 'unknown error')}`,
      { cause: error },
    );
  }
}

function materializeFlightAnalysisLandings(
  timeline: GenericRecord | null | undefined,
  recordedEntries: LandingEntry[],
): { success: true; landings: LandingEntry[] } | { success: false; error: string } {
  const landingEvents = Array.isArray(timeline?.events)
    ? timeline.events.filter((event) => event?.type === 'landing')
    : [];
  const eventByKey = new Map<string, GenericRecord>();
  for (const event of landingEvents) {
    const landingKey = typeof event?.landingKey === 'string' && /^(0|[1-9]\d*)$/.test(event.landingKey)
      ? event.landingKey
      : null;
    if (!landingKey) {
      return { success: false, error: 'A landing has no durable recording key.' };
    }
    if (eventByKey.has(landingKey)) {
      return { success: false, error: 'A landing recording key is duplicated.' };
    }
    eventByKey.set(landingKey, event);
  }

  if (eventByKey.size !== recordedEntries.length) {
    return { success: false, error: 'The rescored Timeline does not match every recorded landing.' };
  }

  const landings: LandingEntry[] = [];
  for (const entry of recordedEntries) {
    const event = entry.landingKey ? eventByKey.get(entry.landingKey) : null;
    if (!event) {
      return { success: false, error: 'A recorded landing could not be matched to its rescored analysis.' };
    }
    const touchdownDistance = event.touchdownDistance && typeof event.touchdownDistance === 'object'
      ? event.touchdownDistance
      : {};
    const stability = event.ultimateStability && typeof event.ultimateStability === 'object'
      ? event.ultimateStability
      : {};
    const gateFailures = Array.isArray(stability.gateFailures)
      ? stability.gateFailures.filter((value) => typeof value === 'string')
      : [];
    landings.push({
      ...entry,
      grade: toText(event.grade),
      recordedGrade: entry.recordedGrade ?? entry.grade,
      gradeSource: 'applied-rescore',
      landingRateContext: parseBreakdownObject(event.landingRateContext),
      touchdownDistanceFt: toNum(touchdownDistance.distanceFt),
      touchdownDistanceGrade: toText(touchdownDistance.grade),
      touchdownDistanceScore: toNum(touchdownDistance.score),
      touchdownDistanceZone: toText(touchdownDistance.zone),
      lateralOffsetFt: toNum(touchdownDistance.lateralOffsetFt),
      lateralOffsetGrade: toText(touchdownDistance.lateralOffsetGrade),
      lateralOffsetScore: toNum(touchdownDistance.lateralOffsetScore),
      lateralOffsetSide: toText(touchdownDistance.lateralOffsetSide),
      bounceCount: toNum(touchdownDistance.bounceCount ?? event.bounceCount),
      bounceGrade: toText(touchdownDistance.bounceGrade),
      bounceScore: toNum(touchdownDistance.bounceScore),
      stabilityScore: toNum(stability.score),
      stabilityVerdict:
        stability.verdict === 'stable'
        || stability.verdict === 'marginal'
        || stability.verdict === 'unstable'
        || stability.verdict === 'no_verdict'
          ? stability.verdict
          : classifyApproachStability({
            score: stability.score,
            gateStable: stability.gateStable,
            gateFailures,
            breakdown: stability.breakdown,
          }),
      stabilityGateFailures: gateFailures,
      stabilityBreakdown: parseBreakdownObject(stability.breakdown),
      stabilityContext: parseBreakdownObject(stability.scoringContext),
      gateStable: toBool(stability.gateStable),
      runwayExcursion: toBool(event.runwayExcursion) ?? false,
      shortLanding: toBool(touchdownDistance.shortLanding ?? event.shortLanding) ?? false,
      rolloutAnalysis: parseBreakdownObject(event.rolloutAnalysis),
      analysisRescore: {
        applied: true,
        scope: 'full-landing-analysis',
      },
    });
  }
  return { success: true, landings };
}

function applySavedFlightAnalysis(
  filePath: string,
  entries: LandingEntry[],
): LandingEntry[] {
  const read = readFlightAnalysisRescoreSidecar(filePath);
  const savedLandings = read.valid && Array.isArray(read.document?.landings)
    ? read.document.landings
    : null;
  if (!savedLandings) return entries;
  return savedLandings.map((entry) => ({ ...entry })) as LandingEntry[];
}

async function getLandingsFromCsvFile(filePath: string, options: CsvFileReadOptions = {}): Promise<LandingEntry[]> {
  const { parseCsvLine, splitCsvLines } = require('../utils/csv.js') as {
    parseCsvLine: (line: string, options?: { trimValues?: boolean }) => string[];
    splitCsvLines: (content: string, options?: { trimAndDropEmpty?: boolean }) => string[];
  };
  const { gradeLandingForProfile, gradeLandingForRecordedProfile } = require('./landing.js') as {
    gradeLandingForProfile: (vsFpm: number, profileId: unknown) => GenericRecord | null;
    gradeLandingForRecordedProfile: (vsFpm: number, profileId: unknown) => GenericRecord | null;
  };

  let fileHandle: import('fs/promises').FileHandle | null = null;
  try {
    const before = fs.lstatSync(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_LOGBOOK_CSV_BYTES) return [];
    fileHandle = await fs.promises.open(filePath, 'r');
    const stat = await fileHandle.stat();
    const after = fs.lstatSync(filePath);
    if (
      !stat.isFile()
      || !after.isFile()
      || after.isSymbolicLink()
      || stat.dev !== before.dev
      || stat.ino !== before.ino
      || after.dev !== before.dev
      || after.ino !== before.ino
      || stat.size > MAX_LOGBOOK_CSV_BYTES
    ) return [];
    const mtimeMs = Number.isFinite(Number(options.mtimeMs)) ? Number(options.mtimeMs) : stat.mtimeMs;
    const cacheKey = normalizeCachePath(filePath);
    const cached = landingsFileCache.get(cacheKey);
    if (!options.bypassCache && !options.ignoreAnalysisRescore && canReuseLandingCache(cached, filePath, mtimeMs)) {
      return cached.landings.slice();
    }

    // Passing the already-verified FileHandle preserves the inode pin while
    // retaining the shared asynchronous read path used by cache/concurrency
    // instrumentation.
    const fileBuffer = await fs.promises.readFile(fileHandle);
    const completion = await verifyRecordingBundleStatusWithCsvBuffer(filePath, fileBuffer);
    if (completion.required && !completion.healthy) {
      landingsFileCache.delete(cacheKey);
      return [];
    }
    const bundleFingerprint = completion.strictBundle ? getBundleFingerprint(filePath) : null;
    if (completion.strictBundle && bundleFingerprint === null) {
      landingsFileCache.delete(cacheKey);
      return [];
    }
    const content = fileBuffer.toString('utf8');
    const recordedLandings = parseLandingsFromContent(
      content,
      filePath,
      parseCsvLine,
      gradeLandingForRecordedProfile,
      splitCsvLines,
      gradeLandingForProfile,
    );
    const fileLandings = options.ignoreAnalysisRescore
      ? recordedLandings
      : applySavedFlightAnalysis(filePath, recordedLandings);
    if (!options.ignoreAnalysisRescore) {
      landingsFileCache.set(cacheKey, {
        mtimeMs,
        landings: fileLandings,
        bundleStatusRequired: completion.required,
        strictBundle: completion.strictBundle,
        bundleFingerprint,
      });
    }
    return fileLandings.slice();
  } finally {
    try { await fileHandle?.close(); } catch {}
  }
}

async function getLandingsFromCSVs(options: CsvLogbookOptions = {}): Promise<LandingEntry[]> {
  const bypassCachePaths = new Set(
    Array.isArray(options.bypassCachePaths)
      ? options.bypassCachePaths
        .filter((filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0)
        .map(normalizeCachePath)
      : [],
  );

  const csvFiles = listLogbookCsvFiles({ allowedCsvPaths: options.allowedCsvPaths });
  const allLandings: LandingEntry[] = [];
  const misses: Array<{ filePath: string; mtimeMs: number }> = [];
  const csvFilePaths = csvFiles.map(({ filePath }) => filePath);
  pruneStaleLandingsFileCache(csvFilePaths);

  for (const { filePath, mtimeMs } of csvFiles) {
    const cacheKey = normalizeCachePath(filePath);
    const cached = landingsFileCache.get(cacheKey);
    const shouldBypassCache = bypassCachePaths.has(cacheKey);
    if (!shouldBypassCache && canReuseLandingCache(cached, filePath, mtimeMs)) {
      allLandings.push(...cached.landings);
    } else {
      misses.push({ filePath, mtimeMs });
    }
  }

  if (misses.length > 0) {
    let nextMissIndex = 0;
    const workerCount = Math.min(LOGBOOK_CSV_READ_CONCURRENCY, misses.length);
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        const missIndex = nextMissIndex++;
        if (missIndex >= misses.length) return;
        const { filePath, mtimeMs } = misses[missIndex];
        try {
          const fileLandings = await getLandingsFromCsvFile(filePath, { bypassCache: true, mtimeMs });
          allLandings.push(...fileLandings);
        } catch {
          landingsFileCache.delete(normalizeCachePath(filePath));
        }
      }
    });
    await Promise.all(workers);
  }

  pruneExcessLandingsFileCache(csvFilePaths);
  allLandings.sort((left, right) => (right.timestampMs ?? 0) - (left.timestampMs ?? 0));
  return allLandings;
}

function computeStatsFromEntries(entries: LandingEntry[]): GenericRecord {
  if (!entries || entries.length === 0) {
    return {
      total: 0,
      grades: {},
      outcomeGrades: {},
      longLandingCount: 0,
      avgVsFpm: null,
      bestVsFpm: null,
      airports: 0,
      aircraft: 0,
      trends: { aircraft: [], airports: [], runways: [] },
    };
  }

  const grades: Record<string, number> = {};
  const outcomeGrades: Record<string, number> = {};
  let longLandingCount = 0;
  let vsSum = 0;
  let vsCount = 0;
  let bestVs = -Infinity;
  const airports = new Set<string>();
  const aircraftSet = new Set<string>();

  for (const entry of entries) {
    if (entry.grade) grades[entry.grade] = (grades[entry.grade] || 0) + 1;
    const outcomeGrade = logbookOutcomeGrade(entry);
    if (outcomeGrade) outcomeGrades[outcomeGrade] = (outcomeGrades[outcomeGrade] || 0) + 1;
    if (entry.touchdownDistanceGrade === 'Long Landing' || outcomeGrade === 'Long Landing') {
      longLandingCount += 1;
    }
    if (Number.isFinite(entry.vsFpm)) {
      vsSum += entry.vsFpm as number;
      vsCount += 1;
      if ((entry.vsFpm as number) > bestVs) bestVs = entry.vsFpm as number;
    }
    if (entry.icao) airports.add(entry.icao);
    if (entry.aircraft) aircraftSet.add(entry.aircraft);
  }

  const groupedTrends = {
    aircraft: computeGroupTrendRows(
      entries,
      (entry) => entry.aircraft || null,
      (entry) => entry.aircraft || null,
    ),
    airports: computeGroupTrendRows(
      entries,
      (entry) => entry.icao || null,
      (entry) => entry.icao || null,
    ),
    runways: computeGroupTrendRows(
      entries,
      (entry) => (entry.icao && entry.runway ? `${entry.icao}:${entry.runway}` : null),
      (entry) => (entry.icao && entry.runway ? `${entry.icao} ${entry.runway}` : null),
    ),
  };

  return {
    total: entries.length,
    grades,
    outcomeGrades,
    longLandingCount,
    avgVsFpm: vsCount > 0 ? Math.round(vsSum / vsCount) : null,
    bestVsFpm: Number.isFinite(bestVs) ? Math.round(bestVs) : null,
    airports: airports.size,
    aircraft: aircraftSet.size,
    trends: groupedTrends,
  };
}

const flightLogbookApi = {
  LOGBOOK_FILE,
  addEntry,
  clearAll,
  computeStatsFromEntries,
  deleteEntry,
  getEntries,
  getLandingsFromCsvFile,
  getLandingsFromCSVs,
  getStats,
  getTrends,
  listLogbookCsvFiles,
  logbookOutcomeGrade,
  materializeFlightAnalysisLandings,
  parseLandingsFromContent,
};

module.exports = flightLogbookApi;

export {};
