/**
 * Timeline Generator - Reconstruct timelines from CSV flight logs
 *
 * ── ARCHITECTURE: THREE DETECTION PATTERNS ──────────────────────────────────
 *
 * 1. VIOLATION LOOP (streaming, per-row)
 *    Runs inside the main CSV row-iteration loop. Each row is examined in
 *    chronological order and checkViolationCondition() emits start/end event
 *    pairs whenever a metric crosses a threshold. Works on per-row data only;
 *    it has no knowledge of what comes later in the file (runway identity,
 *    whether a touchdown follows, etc.).
 *    Examples: high_sink_rate, GLIDESLOPE, LOCALIZER, BANK_ANGLE, below_glidepath
 *
 * 2. TOUCHDOWN EVENT BUILDER (single-point, triggered on WOW transition)
 *    Fires once per landing when the on_ground flag transitions from false→true
 *    at a reasonable IAS/VS. At this point the CSV row is the touchdown sample,
 *    the approach buffer (approachSamples) holds all pre-touchdown telemetry,
 *    and findRunwayByPosition() has resolved the runway. This is the ONLY place
 *    where runway geometry (threshold lat/lon, heading) is available during
 *    parsing, which is why any check that needs geometric runway context must
 *    live here rather than in the Violation Loop.
 *    Examples: landing grade, touchdown-zone scoring, lateral offset, short landing.
 *
 * 3. RETROACTIVE SCAN (post-hoc, at touchdown, over the approach buffer)
 *    After the landing event is assembled, the complete approachSamples buffer
 *    is scanned backwards or forwards to find conditions that could not be
 *    detected streaming because they require runway context. Results are emitted
 *    as violation_start events with a timestampMs pointing back to the moment
 *    the condition occurred in the approach, not to the touchdown moment.
 *    Examples: dangerously_low_approach (RA < threshold while still pre-threshold).
 *
 * ── STABILITY SCORER (retrospective, at touchdown) ──────────────────────────
 *    SimpleStabilityScorer accumulates approach samples (fed in the same loop
 *    that fills approachSamples) and computes a breakdown score at touchdown via
 *    getScore(). This is intentionally not just a fallback for missing LANDING
 *    rows: the legacy per-tick stability scorer was removed, and the live
 *    current-approach score is now written into the LANDING CSV row when the
 *    in-memory scorer is available. CSV replay still recomputes a fallback for
 *    older recordings and incomplete logs. If a LANDING row contains
 *    ultimate_stability_* fields, the merge path below prefers those persisted
 *    values.
 *
 *    Future simplification: once LANDING rows reliably persist the complete
 *    ultimate_stability_* payload and tests prove parity with CSV replay, this
 *    replay scorer can be demoted to a compatibility fallback or removed.
 *
 *    Stability is separate from the Violation Loop — violations are timeline
 *    events; the stability breakdown is a numeric summary on the landing card.
 *
 * ── DATA FLOWS ───────────────────────────────────────────────────────────────
 *    CSV row → Violation Loop → violation_start/end events on generatedTimeline
 *    CSV row → approachSamples buffer → Touchdown Event Builder → landing event
 *                                     → Retroactive Scan → violation_start events
 *                                     → SimpleStabilityScorer → breakdown on landing
 *
 * ── ON-DEMAND RECONSTRUCTION ─────────────────────────────────────────────────
 *    Timelines are reconstructed on-demand from CSV flight logs rather than being
 *    saved during flight. This ensures timelines are always available even if
 *    flights don't end cleanly (sim crash, user quits, backend killed). Since the
 *    CSV is append-only and survives crashes, we can always reconstruct from it.
 */

const fs = require('fs');
const path = require('path');
const { isMainThread, Worker } = require('node:worker_threads') as typeof import('node:worker_threads');
const { TextDecoder } = require('node:util') as typeof import('node:util');
const flightTypeClassifier = require('../lifecycle/flight-type-classifier');
const airportSearch = require('../landing/airport-search');
const landingDistance = require('../landing/landing-distance');
const { MARKER_TYPE, VIOLATION_RULE } = require('./timeline-events');
const { parseCsvLine, splitCsvLines } = require('../utils/csv');
const { computeCrosswind } = require('../utils/helpers') as {
  computeCrosswind: (windSpeed: unknown, windDirectionDeg: unknown, headingDeg: unknown) => number | null;
};
const { getFlightLogsStorageInfo: getFlightLogsStorageSummary, resolveFlightLogsDir } = require('../utils/flight-logs-dir');
const recordingBundleLayout = require('../flight-recording/recording-bundle-layout') as {
  BUNDLE_FILES: {
    csv: string;
    automation: string;
    aircraftSpecific: string;
    status: string;
    summary: string;
  };
  getBundleFromCsvPath: (_csvPath: unknown) => {
    outputDir: string;
    bundleName: string;
    paths: Record<string, string>;
  } | null;
  listBundleCsvPaths: (_outputDir: string) => string[];
};
const { ensureDirExists, getAppDataRoot } = require('../utils/storage-paths.js') as {
  ensureDirExists: (dirPath: string | null | undefined) => string | null | undefined;
  getAppDataRoot: () => string;
};
const {
  getRunwayTrueHeadingDeg,
  roundedHeadingDifferenceDegrees,
} = require('../utils/aviation-frames') as AviationFramesModule;
const {
  coalesceKnown,
  createFuelUsageRowSelector,
  hasFuelUsageAnchor,
  mapCsvRow,
  mergeTouchdownDistance,
  parseCSV,
  parseJsonObject,
  selectFuelUsageRows,
  summarizeFuelUsage,
  toBooleanOrNull,
  toFiniteNumber,
} = require('./timeline-csv-helpers.js') as {
  coalesceKnown: (primary: unknown, fallback: unknown) => unknown;
  createFuelUsageRowSelector: () => {
    push: (row: AnyRecord | null | undefined) => void;
    result: () => { firstFuelRow: AnyRecord | null; lastFuelRow: AnyRecord | null };
  };
  hasFuelUsageAnchor: (row: AnyRecord | null | undefined) => boolean;
  mapCsvRow: (headers: string[], values: unknown[]) => CsvRow;
  mergeTouchdownDistance: (existing: AnyRecord | null | undefined, incoming: AnyRecord | null | undefined) => AnyRecord | null;
  parseCSV: (filePath: string, options?: { sparseRows?: boolean }) => Promise<ParseCsvResult>;
  parseJsonObject: (value: unknown) => AnyRecord | null;
  selectFuelUsageRows: (rows: Array<AnyRecord | null | undefined>) => { firstFuelRow: AnyRecord | null; lastFuelRow: AnyRecord | null };
  summarizeFuelUsage: (
    firstFuelRow: AnyRecord | null | undefined,
    lastFuelRow: AnyRecord | null | undefined,
  ) => {
    fuelStartGal: number | null;
    fuelEndGal: number | null;
    fuelBurnGal: number | null;
    fuelBurnWeightLbs: number | null;
    fuelBurnSource?: string | null;
  };
  toBooleanOrNull: (value: unknown) => boolean | null;
  toFiniteNumber: (value: unknown) => number | null;
};
const { isPathInside } = require('../utils/path-guard') as {
  isPathInside: (parentDir: string | null | undefined, childPath: string | null | undefined, options?: { allowEqual?: boolean }) => boolean;
};
const { assertSafeFileTarget, safeReplaceTextFileSync, safeUnlinkSync } = require('../utils/safe-fs.js') as {
  assertSafeFileTarget: (_options: {
    allowedExtensions?: string[];
    operation: string;
    rootDir: string;
    targetPath: string;
  }) => string;
  safeReplaceTextFileSync: (_options: {
    allowedExtensions?: string[];
    data: string;
    operation: string;
    rootDir: string;
    targetPath: string;
  }) => string;
  safeUnlinkSync: (_options: {
    allowedExtensions?: string[];
    allowMissing?: boolean;
    operation: string;
    rootDir: string;
    targetPath: string;
  }) => boolean;
};
const profileLoader = require('../aircraft/aircraft-profile-loader') as {
  loadProfile: (id: unknown) => AnyRecord | null;
  getStabilityScoringCriteria: (profile?: AnyRecord | null) => AnyRecord | null;
};
const { getCategoryThresholds } = require('../lifecycle/phase') as {
  getCategoryThresholds: (category: unknown) => AnyRecord;
};
const {
  SimpleStabilityScorer,
  frameToSample,
  getStabilityCriteria,
  selectApproachAltitudeSource,
  BANK_MAX_DEG: STABILITY_BANK_MAX_DEG,
  VS_MIN_FPM: STABILITY_VS_MIN_FPM,
  resolveGlidepathAngleForApproach,
  targetVerticalSpeedForGlidepath,
} = require('../stability/stability-runner');
const {
  buildStabilityScoringContext,
  resolveStabilityPolicy,
} = require('../stability/stability-policy') as {
  buildStabilityScoringContext: (_input: AnyRecord) => AnyRecord;
  resolveStabilityPolicy: (_input: AnyRecord) => AnyRecord;
};
const { normalizeRetiredSpoilerStability } = require('../stability/retired-spoiler-compat.js') as {
  normalizeRetiredSpoilerStability: (value: unknown) => AnyRecord | null;
};
const {
  buildLandingRateScoringContext,
  gradeLandingForProfile,
  gradeLandingForRecordedProfile,
} = require('../landing/landing') as {
  buildLandingRateScoringContext: (_profileId: unknown) => AnyRecord;
  gradeLandingForProfile: (_vsFpm: number, _profileId: unknown) => { grade?: string | null } | null;
  gradeLandingForRecordedProfile: (_vsFpm: number, _profileId: unknown) => { grade?: string | null } | null;
};
const {
  assessRecordedBounceEvidence,
  isLegacyRunwayExcursionGrade,
  parseLandingRateContext,
  resolveLandingRateHeadline,
} = require('../landing/landing-replay-analysis.js') as {
  assessRecordedBounceEvidence: (_evidence: {
    airborneDurationMs?: number | null;
    altitudeLiftFt?: number | null;
    impactLoadG?: number | null;
    maxUpwardVsFpm?: number | null;
    radioHeightLiftFt?: number | null;
    recontactVsFpm?: number | null;
  }, _gradeFromVs: (_vsFpm: number) => string | null) => {
    confirmed: boolean;
    airborneDurationMs: number;
    radioHeightAuthoritative: boolean;
    hasPhysicalLift: boolean;
    hasPositiveMotion: boolean;
    hasMeaningfulImpact: boolean;
    hasCombinedShallowEvidence: boolean;
    shallowSecondarySignals: number;
  };
  isLegacyRunwayExcursionGrade: (_value: unknown) => boolean;
  parseLandingRateContext: (_value: unknown) => AnyRecord | null;
  resolveLandingRateHeadline: (
    _row: AnyRecord | null | undefined,
    _gradeFromVs: (_vsFpm: number) => string | null,
    _fallback?: AnyRecord | null,
    _options?: { rescoreWithCurrentRules?: boolean },
  ) => { vsFpm: number | null; grade: string | null };
};
const config = require('../core/config');
const { computeFlightSummaryFromRows } = require('../flight-recording/read-flight-summary');
const { readAutomationRowsForCsv } = require('../flight-recording/automation-jsonl-reader') as {
  readAutomationRowsForCsv: (csvPath: string, options?: {
    csvIdentity?: {
      flightId: string;
      flightStartIso: string;
      recordingSessionId: string | null;
      strictBundle: boolean;
    };
    maxRetainedBytes?: number;
    maxRows?: number;
  }) => Promise<{
    filePath: string;
    exists?: boolean;
    rows: AnyRecord[];
    lineCount: number;
    parseErrorCount: number;
    fileSizeBytes?: number;
    sha256?: string;
    recoveredTail?: boolean;
    error?: string;
  }>;
};
const { readAircraftSpecificRowsForCsv } = require('../flight-recording/aircraft-specific-jsonl-reader') as {
  readAircraftSpecificRowsForCsv: (csvPath: string, options?: {
    csvIdentity?: {
      flightId: string;
      flightStartIso: string;
      recordingSessionId: string | null;
      strictBundle: boolean;
    };
    maxRetainedBytes?: number;
    retainRows?: number;
  }) => Promise<{
    filePath: string;
    exists: boolean;
    rows: AnyRecord[];
    lineCount: number;
    parseErrorCount: number;
    fileSizeBytes?: number;
    sha256?: string;
    recoveredTail?: boolean;
    error?: string;
  }>;
};
const {
  inspectCsvBundleForCatalogSync,
  inspectRecordingBundleStatusSync,
  readRecordingBundleStatusSync,
} = require('../flight-recording/recording-bundle-status') as {
  inspectCsvBundleForCatalogSync: (_csvPath: string) => AnyRecord;
  inspectRecordingBundleStatusSync: (_csvPath: string, _identity: AnyRecord) => AnyRecord;
  readRecordingBundleStatusSync: (_csvPath: string, _options?: AnyRecord) => AnyRecord;
};
const { isOwnedHistorySummaryForCsv } = require('../history-index/history-summary-sidecar.js') as {
  isOwnedHistorySummaryForCsv: (_summaryPath: unknown, _csvPath: unknown) => boolean;
};
const {
  buildCanonicalStabilityFrameFromCsvRow,
  downsampleTimedSamples,
  isTakeoffSettlingTouchdown,
  isTouchdownTransitionCandidate,
} = require('../analysis/flight-analysis') as FlightAnalysisModule;
const { buildReplayLandingEvent } = require('./timeline-touchdown.js') as {
  buildReplayLandingEvent: (input: AnyRecord) => {
    landingEvent: AnyRecord;
    retroactiveViolations: AnyRecord[];
  };
};
const {
  analyzeRollout,
  inferCoordinatePrecisionDigits,
  ROLLOUT_ANALYSIS_LIMITS,
} = require('../landing/rollout-analysis.js') as {
  analyzeRollout: (samples: AnyRecord[], context?: AnyRecord) => AnyRecord | null;
  inferCoordinatePrecisionDigits: (samples: AnyRecord[]) => number | null;
  ROLLOUT_ANALYSIS_LIMITS: {
    maxWindowMs: number;
    maxSamples: number;
  };
};

type AnyRecord = Record<string, any>;
type CsvRow = Record<string, any>;
type Coordinate = { lat: number; lon: number };
type NullableCoordinate = { lat: number | null; lon: number | null };
type AirportSummary = { icao: string; name: string } & AnyRecord;
type ViolationState = { startTs: number; startElapsed: number; context: AnyRecord };
type HighSinkRateState = {
  active: boolean;
  onsetTimestampMs: number;
  onsetElapsedMs: number;
  onsetLat: number | null;
  onsetLon: number | null;
  onsetValueFpm: number;
  peakValueFpm: number;
  peakTimestampMs: number;
  lastThresholdBreachTimestampMs: number;
  context: AnyRecord;
  startEvent: AnyRecord | null;
};
type ReplayBounceCandidate = {
  startedElapsedMs: number;
  baselineAltitudeFt: number | null;
  baselineRadioHeightFt: number | null;
  peakAltitudeFt: number | null;
  peakRadioHeightFt: number | null;
  maxUpwardVsFpm: number | null;
  lastAirborneVsFpm: number | null;
};
type PendingReplayBounceConfirmation = {
  candidate: ReplayBounceCandidate;
  touchdownElapsedMs: number;
  airborneDurationMs: number;
  impactVsFpm: number;
  impactLoadG: number | null;
};
type ReplayFlapState = {
  kind: 'detent' | 'percent';
  profileKey: string;
  notchIndex: number;
  value: number;
  label: string;
  reliability: string;
  source: string;
};
type PendingReplayFlapChange = {
  state: ReplayFlapState;
  observationCount: number;
  row: CsvRow;
  timestampMs: number;
  elapsedMs: number;
  coordinates: NullableCoordinate;
};
type ParseCsvResult = {
  headers: string[];
  rows: CsvRow[];
  fileSizeBytes?: number;
  sha256?: string;
  error?: string;
};
type QuickPeekResult = {
  firstRow: CsvRow | null;
  lastRow: CsvRow | null;
  firstCoordRow: CsvRow | null;
  lastCoordRow: CsvRow | null;
  aircraftProfileId: string | null;
  firstFuelRow: CsvRow | null;
  lastFuelRow: CsvRow | null;
  distanceNm: number | null;
  rowCount: number;
  sampleCount: number;
  strictBundle: boolean;
  bundleStatusRequired: boolean;
  manifestIdentity: AnyRecord | null;
};
type CsvExactScanResult = {
  firstRow: CsvRow | null;
  lastRow: CsvRow | null;
  firstCoordRow: CsvRow | null;
  lastCoordRow: CsvRow | null;
  aircraftProfileId: string | null;
  rowCount: number;
  sampleCount: number;
  firstFuelRow: CsvRow | null;
  lastFuelRow: CsvRow | null;
  distanceNm: number | null;
  strictBundle: boolean;
  bundleStatusRequired: boolean;
  manifestIdentity: AnyRecord | null;
};
type FuelUsageColumnIndexes = {
  sampleIndex: number;
  phase: number;
  flightElapsedMs: number;
  timestampUtc: number;
  ts: number;
  fuelTotalGal: number;
  fuelTotalWeightLbs: number;
  fuelWeightPerGal: number;
  grossWeightLbs: number;
};
type ListingMetadataColumnIndexes = {
  recordType: number;
  schemaVersion: number;
  timestampUtc: number;
  ts: number;
  flightElapsedMs: number;
  aircraft: number;
  aircraftProfileId: number;
  lat: number;
  lon: number;
  flightId: number;
  recordingSessionId: number;
  flightStartIso: number;
  bundleStatusRequired: number;
};
type GeneratedTimeline = {
  flightId: string;
  startTime: string | number | null;
  endTime: string | number | null;
  simDateTimeLocal: string | null;
  simDateTimeUtc: string | null;
  durationMs: number;
  durationFormatted: string;
  aircraft: string;
  aircraftProfileId: string | null;
  departureAirport: AirportSummary | null;
  arrivalAirport: AirportSummary | null;
  route: string | null;
  distanceNm?: number | null;
  fuelBurnGal: number | null;
  fuelBurnWeightLbs: number | null;
  fuelStartGal: number | null;
  fuelEndGal: number | null;
  fuelBurnSource?: string | null;
  events: AnyRecord[];
  track: AnyRecord[];
  generated: boolean;
  generatedAt: string;
  eventCount?: number;
  sampleCount?: number;
  worstMoment?: AnyRecord | null;
  flightType?: string;
  flightClassification?: AnyRecord;
  automationSummary?: AnyRecord;
  analysisRescore?: {
    mode: 'recorded' | 'current-preview';
    scope: 'full-landing-analysis';
    contract: {
      id: string;
      version: number;
      scope: 'full-landing-analysis';
    };
    persistedDataModified: false;
    complete: boolean;
    landingCount: number;
    landings: AnyRecord[];
  };
};
type TimelineResult =
  | { success: false; error: string }
  | { success: true; timeline: GeneratedTimeline };
type TimelineSaveResult =
  | { success: false; error: string }
  | { success: true; filePath: string; timeline: GeneratedTimeline };
type DeleteFlightCsvExpectedIdentity = {
  mtimeMs?: unknown;
  sizeBytes?: unknown;
};
type GenerateMissingDetail = {
  file: string;
  status: 'generated' | 'skipped' | 'failed';
  reason?: string;
  eventCount?: number;
  error?: string;
};
type GenerateMissingResult = {
  generated: number;
  skipped: number;
  failed: number;
  details: GenerateMissingDetail[];
};
type FlightAnalysisModule = {
  buildCanonicalStabilityFrameFromCsvRow: (row: AnyRecord, dtMs: number | null) => AnyRecord;
  buildTouchdownRunwayAnalysis: (input: AnyRecord) => {
    touchdownDistanceData: AnyRecord;
    shortLandingDetected: boolean;
    tdzAchieved: boolean;
  };
  downsampleTimedSamples: (samples: AnyRecord[], maxPoints: number) => AnyRecord[];
  isTakeoffSettlingTouchdown: (input: AnyRecord) => boolean;
  isTouchdownTransitionCandidate: (input: AnyRecord) => boolean;
};
type AviationFramesModule = {
  getRunwayTrueHeadingDeg: (input: AnyRecord | null | undefined) => number | null;
  roundedHeadingDifferenceDegrees: (
    leftHeadingDeg: unknown,
    rightHeadingDeg: unknown,
    precision?: number,
  ) => number | null;
};

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const ALTITUDE_MARKERS = Object.freeze([
  { altitudeFt: 1000, markerType: MARKER_TYPE.ALTITUDE_1000 },
  { altitudeFt: 500, markerType: MARKER_TYPE.ALTITUDE_500 },
  { altitudeFt: 100, markerType: MARKER_TYPE.ALTITUDE_100 },
  { altitudeFt: 50, markerType: MARKER_TYPE.ALTITUDE_50 },
]);

/**
 * Manually bumped whenever a saved current-rules landing-analysis snapshot can
 * no longer be compared or replayed under the same semantic contract.
 * Storage sidecars import this exact JSON-safe value rather than inventing a
 * second version counter.
 */
const CURRENT_ANALYSIS_RESCORE_CONTRACT = Object.freeze({
  id: 'flight-fabric-landing-analysis',
  version: 4,
  scope: 'full-landing-analysis',
} as const);
const RESPAWN_GAP_MS = 30000;
// Keep CSV reconstruction aligned with the live landing runner: WOW changing
// false is only a raw candidate. A physical bounce also needs observable lift,
// upward motion when radio height is unavailable, or a meaningful recontact.
const REPLAY_BOUNCE_POST_IMPACT_CONFIRMATION_MS = 1000;
const REPLAY_TOUCHDOWN_REARM_MS = Number.isFinite(config.landing?.touchdownCooldownMs)
  ? Math.max(0, config.landing.touchdownCooldownMs)
  : 6000;
const LANDING_MERGE_WINDOW_MS = 30000;
const LANDING_TOUCHDOWN_IDENTITY_WINDOW_MS = 5 * 60 * 1000;
const LANDING_TOUCHDOWN_IDENTITY_MAX_DISTANCE_FT = 1500;
const FEET_PER_NAUTICAL_MILE = 6076.12;
const TRACK_POINT_MIN_GAP_MS = 2000;
const MAX_GENERATED_TIMELINE_EVENTS = 10_000;
const NULL_ISLAND_EPSILON_DEG = 1e-6;
const APPROACH_CEILING_FT = 1500;          // Collect approach samples below this RA
const APPROACH_PROFILE_MAX_POINTS = 120;   // Max points after downsample
const DELETE_MTIME_TOLERANCE_MS = 2000;
// Retroactive Scan: dangerously_low_approach thresholds.
// Any approach sample with RA below DANGEROUSLY_LOW_APPROACH_RA_FT that is also
// geometrically before the runway threshold (negative along-track distance) and
// more than FLARE_EXCLUSION_DISTANCE_FT before the threshold (to exclude the
// normal flare segment) triggers the violation.
//   50 ft: aircraft is at TDZ height but hasn't crossed the threshold yet —
//          the classic ILS antenna / approach light strike scenario.
//   500 ft: generous flare exclusion; a normal stabilised flare begins ~30 ft RA
//           and the aircraft covers at most ~200–300 ft of ground distance during
//           the flare at typical approach speeds, so 500 ft safely excludes all
//           legitimate flares while catching aircraft still on the 3° path.
const DANGEROUSLY_LOW_APPROACH_RA_FT = 50;
const FLARE_EXCLUSION_DISTANCE_FT    = 500;

// Stability thresholds for violation detection during replay.
// VS and bank values are sourced from stability-runner.js to avoid drift.
// HIGH_SINK_RATE_FPM is sourced from config (env: VIOLATION_HIGH_SINK_RATE_FPM) so
// a single user-tunable knob controls when the timeline flags an excessive descent.
const STABILITY_THRESHOLDS = {
  IAS_DEVIATION_KNOTS: 10,       // ±10 knots from target
  VS_MAX_FPM: -STABILITY_VS_MIN_FPM, // 1000 fpm — shared with stability-runner (legacy, retained for callers)
  HIGH_SINK_RATE_FPM: config.violationThresholds.highSinkRateFpm, // negative fpm; configurable
  HIGH_SINK_RATE_MIN_DURATION_MS: config.violationThresholds.highSinkRateMinDurationMs,
  HIGH_SINK_RATE_CLEAR_FPM:
    config.violationThresholds.highSinkRateFpm + config.violationThresholds.highSinkRateHysteresisFpm,
  GLIDESLOPE_DOTS: 1.0,          // ±1 dot
  LOCALIZER_DOTS: 1.0,           // ±1 dot
  BANK_MAX_DEG: STABILITY_BANK_MAX_DEG, // 25° — shared with stability-runner
  // Steep path-rate proxy: how many fpm steeper than the resolved approach
  // target before flagging an excessive descent-rate deviation. This is not a
  // positional below-glidepath measurement.
  // Defaults to 3° but uses verified airport/runway overrides when available.
  // Only fires when ILS gs_deviation_dots is absent (visual/RNAV); the
  // GLIDESLOPE violation is authoritative when ILS data is available.
  UNDERSHOOT_VS_DELTA_FPM: 400,
};
const MAX_PLAUSIBLE_ILS_DEVIATION_DOTS = 3;
const REPLAY_FLAP_SETTLE_MS = 500;
const REPLAY_FLAP_PERCENT_SETTLE_MS = 1000;
const REPLAY_FLAP_PERCENT_MIN_CHANGE = 2;

// Documentation note attached to high_sink_rate violations so the UI can distinguish
// the Flight Fabric stability rule from an aircraft GPWS "SINK RATE" aural callout,
// which uses a height-versus-rate envelope not modeled here.
const HIGH_SINK_RATE_NOTE = 'Internal approach-stability rule (not a GPWS callout). Triggered after vertical speed remains below the configured threshold during APPROACH/FINAL, and cleared only after recovery through a hysteresis margin. Real GPWS "SINK RATE" callouts use a height-vs-rate envelope and may not fire at the same moments.';

// ═══════════════════════════════════════════════════════════════════════════
// CSV Parsing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute heading deviation of the aircraft from the runway centerline.
 * Positive = aircraft heading right of runway heading, negative = left.
 * Mirrors the logic in landing-runner.js — this is the single source of truth;
 * the frontend must only read the pre-computed value, never re-derive it.
 *
 * @param {number|null} hdgTrueDeg - Aircraft true heading at touchdown
 * @param {number|null} rwyHdgDeg  - Runway true heading
 * @returns {number|null}
 */
function _computeCenterlineDev(hdgTrueDeg, rwyHdgDeg) {
  return roundedHeadingDifferenceDegrees(hdgTrueDeg, rwyHdgDeg);
}

function getReplayStabilityPolicyFromRow(
  row: AnyRecord | null | undefined,
  fallback: AnyRecord | null = null,
): AnyRecord {
  const profileId = getReplayAircraftProfileId(row, fallback);
  let profile = null;
  try {
    profile = profileLoader.loadProfile(profileId || 'generic');
  } catch (_e) {}
  let profileCriteria = null;
  try {
    profileCriteria = profileLoader.getStabilityScoringCriteria(profile);
  } catch (_e) {}
  const policy = resolveStabilityPolicy({
    profile,
    commonCriteria: getStabilityCriteria(),
    profileCriteria,
  });
  return {
    profile,
    profileId: profileId || 'generic',
    profileAvailable: profile !== null,
    policy,
    criteria: policy.criteria,
  };
}

/**
 * Compute a landing grade from conventional V/S. Historical grading is
 * explicitly anchored to the profile persisted in the recording, never the
 * currently active aircraft or simulator touchdown diagnostics. The frontend
 * must NOT re-derive grades from raw V/S.
 */
function _computeGradeFromVs(vsFpm, profileId: unknown = null) {
  if (vsFpm == null || !Number.isFinite(Number(vsFpm))) return null;
  const result = gradeLandingForRecordedProfile(Number(vsFpm), profileId);
  return result ? result.grade : null;
}

function getReplayAircraftProfileId(
  row: CsvRow | null | undefined,
  fallback: AnyRecord | null = null,
): string | null {
  return toNonEmptyString(row?.aircraft_profile_id ?? row?.aircraftProfileId)
    || toNonEmptyString(fallback?.aircraft_profile_id ?? fallback?.aircraftProfileId)
    || null;
}

function getReplayGradeFromVs(
  row: CsvRow | null | undefined,
  fallback: AnyRecord | null = null,
): (vsFpm: number) => string | null {
  const profileId = getReplayAircraftProfileId(row, fallback);
  return (vsFpm: number) => _computeGradeFromVs(vsFpm, profileId);
}

function getReplayImpactGradeFromVs(
  row: CsvRow | null | undefined,
  fallback: AnyRecord | null = null,
): (vsFpm: number) => string | null {
  const profileId = getReplayAircraftProfileId(row, fallback);
  return (vsFpm: number) => gradeLandingForProfile(vsFpm, profileId)?.grade ?? null;
}

function resolveReplayLandingHeadline(
  row: CsvRow | null | undefined,
  fallback: AnyRecord | null = null,
  options: { rescoreWithCurrentRules?: boolean } = {},
): { vsFpm: number | null; grade: string | null } {
  return resolveLandingRateHeadline(row, getReplayGradeFromVs(row, fallback), fallback, options);
}

function resolveReplayLandingKey(
  row: CsvRow | null | undefined,
  fallback: AnyRecord | null,
): string | null {
  const recordType = String(row?.record_type || '').trim().toUpperCase();
  const rawKey = recordType === 'LANDING'
    ? (row?.sample_index ?? row?.sampleIndex)
    : fallback?.landingKey;
  if (typeof rawKey === 'number') {
    return Number.isSafeInteger(rawKey) && rawKey >= 0 ? String(rawKey) : null;
  }
  if (typeof rawKey !== 'string') return null;
  const landingKey = rawKey.trim();
  return /^\d+$/.test(landingKey) ? landingKey : null;
}

function resolveReplayLandingGrade(
  row: CsvRow | null | undefined,
  fallback: AnyRecord | null,
  scoringMode: 'recorded' | 'current-preview',
): {
  headline: { vsFpm: number | null; grade: string | null };
  context: AnyRecord | null;
  landingKey: string | null;
  mode: 'recorded' | 'current-preview';
  metric: AnyRecord;
  profileId: string;
} {
  const recordedHeadline = resolveReplayLandingHeadline(row, fallback);
  const landingKey = resolveReplayLandingKey(row, fallback);
  const recordedContext = parseLandingRateContext(
    row?.landing_rate_context
      ?? row?.landingRateContext
      ?? fallback?.landing_rate_context
      ?? fallback?.landingRateContext,
  );
  const profileId = getReplayAircraftProfileId(row, fallback) || 'generic';
  if (scoringMode !== 'current-preview') {
    return {
      headline: recordedHeadline,
      context: recordedContext,
      landingKey,
      mode: scoringMode,
      profileId,
      metric: {
        applicable: recordedHeadline.vsFpm !== null || recordedHeadline.grade !== null,
        available: recordedHeadline.grade !== null,
        source: 'recorded',
        reason: recordedHeadline.grade !== null ? null : 'recorded_landing_rate_unavailable',
      },
    };
  }

  const currentGrade = recordedHeadline.vsFpm === null
    ? null
    : _computeGradeFromVs(recordedHeadline.vsFpm, profileId);
  const available = recordedHeadline.vsFpm !== null && currentGrade !== null;
  const currentContext = available
    ? {
        ...buildLandingRateScoringContext(profileId),
        criteriaSource: 'current-rescore',
      }
    : null;
  const reason = available
    ? null
    : recordedHeadline.vsFpm === null
      ? 'recorded_touchdown_rate_unavailable'
      : profileId !== 'generic'
        ? 'recorded_profile_unavailable'
        : 'current_rules_unavailable';

  return {
    // Never leak a persisted score into a current-rules snapshot. The raw
    // conventional touchdown rate remains authoritative even when its current
    // profile can no longer be resolved.
    headline: { vsFpm: recordedHeadline.vsFpm, grade: available ? currentGrade : null },
    context: currentContext,
    landingKey,
    mode: scoringMode,
    profileId,
    metric: {
      applicable: true,
      available,
      source: available ? 'reconstructed' : 'unavailable',
      reason,
    },
  };
}

function applyReplayLandingGrade(
  event: AnyRecord,
  resolved: {
    headline: { vsFpm: number | null; grade: string | null };
    context: AnyRecord | null;
    landingKey: string | null;
    mode: 'recorded' | 'current-preview';
    metric: AnyRecord;
    profileId: string;
  },
): AnyRecord {
  const fallbackGrade = toNonEmptyString(event?.grade);
  event.vs_fpm = resolved.headline.vsFpm;
  event.grade = resolved.mode === 'current-preview'
    ? resolved.headline.grade
    : (resolved.headline.grade ?? fallbackGrade);
  event.landingKey = resolved.landingKey;
  event.landingRateContext = resolved.context;
  event._analysisRescoreProfileId = resolved.profileId;
  event._analysisRescoreMetrics = {
    ...(event._analysisRescoreMetrics || {}),
    landingRate: resolved.metric,
  };
  return event;
}

function captureReplayStabilitySamples(scorer: AnyRecord): AnyRecord[] {
  return Array.isArray(scorer?.samples)
    ? scorer.samples.map((sample: AnyRecord) => ({ ...sample }))
    : [];
}

function rebuildCurrentReplayStability(
  event: AnyRecord,
  row: CsvRow,
  replayPolicy: AnyRecord,
): { value: AnyRecord | null; metric: AnyRecord } {
  if (replayPolicy?.profileAvailable !== true) {
    return {
      value: null,
      metric: {
        applicable: true,
        available: false,
        source: 'unavailable',
        reason: 'recorded_profile_unavailable',
      },
    };
  }

  const samples = Array.isArray(event?._analysisReplayStabilitySamples)
    ? event._analysisReplayStabilitySamples
    : [];
  if (samples.length === 0) {
    return {
      value: null,
      metric: {
        applicable: true,
        available: false,
        source: 'unavailable',
        reason: 'approach_samples_unavailable',
      },
    };
  }

  const scorer = new SimpleStabilityScorer(toFiniteNumber(replayPolicy?.criteria?.gateRaFt) ?? undefined);
  for (const sample of samples) scorer.addSample({ ...sample });

  // Prefer the runway reference captured with the landing. When older rows do
  // not carry it, pass null deliberately so the scorer takes its deterministic
  // radio-height fallback instead of consulting today's airport database.
  const runwayReferenceElevFt = toFiniteNumber(row.runway_reference_elev_ft);
  const airportIcao = toNonEmptyString(row.icao ?? event?.runway?.airport_icao);
  const runwayId = toNonEmptyString(row.runway ?? event?.runway?.runway_id);
  const lateralOffsetFt = toFiniteNumber(row.lateral_offset_ft);
  const runwayWidthFt = toFiniteNumber(row.runway_width_ft);
  const lateralOffsetSuspect = toBooleanOrNull(row.lateral_offset_suspect) === true;
  const glidepathAngle = resolveGlidepathAngleForApproach({ airportIcao, runwayId });
  const scoreResult = scorer.getScore(runwayReferenceElevFt, {
    lateralOffsetFt,
    runwayWidthFt: runwayWidthFt !== null && runwayWidthFt > 0 ? runwayWidthFt : null,
    lateralOffsetSuspect,
    airportIcao,
    runwayId,
    criteria: replayPolicy.criteria || null,
  });
  const value = scoreResult && scoreResult.breakdown
      ? {
        score: scoreResult.score,
        verdict: scoreResult.verdict,
        samples: scoreResult.samples,
        gateStable: scoreResult.gateStable,
        gateFailures: scoreResult.gateFailures,
        breakdown: scoreResult.breakdown,
        scoringContext: buildStabilityScoringContext({
          scoreResult,
          profile: replayPolicy.profile,
          glidepathAngle,
          policy: replayPolicy.policy,
          criteriaSource: 'current-rescore',
        }),
      }
    : null;
  const available = toFiniteNumber(value?.score) !== null;
  const gateFailure = Array.isArray(value?.gateFailures)
    ? toNonEmptyString(value.gateFailures[0])
    : null;
  return {
    value,
    metric: {
      applicable: true,
      available,
      source: available ? 'reconstructed' : 'unavailable',
      reason: available ? null : (gateFailure ? `stability_${gateFailure}` : 'stability_score_unavailable'),
    },
  };
}

function updateReplayBounceCandidate(candidate: ReplayBounceCandidate, row: CsvRow): void {
  const altitudeFt = toFiniteNumber(row.alt_plane_ft);
  const radioHeightFt = toFiniteNumber(row.ra_ft);
  const vsFpm = toFiniteNumber(row.vs_fpm);

  if (altitudeFt !== null && (candidate.peakAltitudeFt === null || altitudeFt > candidate.peakAltitudeFt)) {
    candidate.peakAltitudeFt = altitudeFt;
  }
  if (radioHeightFt !== null && (candidate.peakRadioHeightFt === null || radioHeightFt > candidate.peakRadioHeightFt)) {
    candidate.peakRadioHeightFt = radioHeightFt;
  }
  if (vsFpm !== null && (candidate.maxUpwardVsFpm === null || vsFpm > candidate.maxUpwardVsFpm)) {
    candidate.maxUpwardVsFpm = vsFpm;
  }
  if (vsFpm !== null) candidate.lastAirborneVsFpm = vsFpm;
}

function assessReplayBounceCandidate(
  candidate: ReplayBounceCandidate,
  row: CsvRow,
  confirmedImpact: {
    impactVsFpm?: number | null;
    impactLoadG?: number | null;
    airborneDurationMs?: number | null;
  } = {},
): AnyRecord {
  const altitudeLiftFt = candidate.baselineAltitudeFt !== null && candidate.peakAltitudeFt !== null
    ? candidate.peakAltitudeFt - candidate.baselineAltitudeFt
    : null;
  const radioHeightLiftFt = candidate.baselineRadioHeightFt !== null && candidate.peakRadioHeightFt !== null
    ? candidate.peakRadioHeightFt - candidate.baselineRadioHeightFt
    : null;
  const confirmedImpactVsFpm = toFiniteNumber(confirmedImpact.impactVsFpm);
  const recontactVsFpm = toFiniteNumber(row.vs_fpm);
  const impactVsFpm = confirmedImpactVsFpm ?? (
    recontactVsFpm !== null && candidate.lastAirborneVsFpm !== null
      ? Math.min(recontactVsFpm, candidate.lastAirborneVsFpm)
      : (recontactVsFpm ?? candidate.lastAirborneVsFpm)
  );
  const confirmedImpactLoadG = toFiniteNumber(confirmedImpact.impactLoadG);
  const impactLoadG = confirmedImpactLoadG ?? toFiniteNumber(row.g_force);
  const assessment = assessRecordedBounceEvidence({
    airborneDurationMs: confirmedImpact.airborneDurationMs,
    altitudeLiftFt,
    impactLoadG,
    maxUpwardVsFpm: candidate.maxUpwardVsFpm,
    radioHeightLiftFt,
    recontactVsFpm: impactVsFpm,
  }, getReplayImpactGradeFromVs(row));

  return {
    ...assessment,
    impactVsFpm: impactVsFpm ?? 0,
    impactLoadG: impactLoadG !== null && impactLoadG > 0 && impactLoadG <= 10
      ? impactLoadG
      : null,
  };
}

function applyConfirmedReplayBounce(landingEvent: AnyRecord | null, assessment: AnyRecord): boolean {
  if (!landingEvent || landingEvent.type !== 'landing') return false;

  landingEvent.bounceCount = (toFiniteNumber(landingEvent.bounceCount) ?? 0) + 1;
  const bounceImpactVsFpm = toFiniteNumber(assessment?.impactVsFpm) ?? 0;
  if (
    landingEvent.bounceVsFpm == null
    || bounceImpactVsFpm < landingEvent.bounceVsFpm
  ) {
    landingEvent.bounceVsFpm = bounceImpactVsFpm;
  }

  if (!landingEvent.touchdownDistance || typeof landingEvent.touchdownDistance !== 'object') {
    landingEvent.touchdownDistance = {};
  }
  landingEvent.touchdownDistance.bounceCount = landingEvent.bounceCount;
  return true;
}

function isValidCoordinate(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  return !(Math.abs(lat) <= NULL_ISLAND_EPSILON_DEG && Math.abs(lon) <= NULL_ISLAND_EPSILON_DEG);
}

function resolveEventCoordinates(row: CsvRow | null | undefined, fallbackCoordinates: Coordinate | null = null): NullableCoordinate {
  const rowLat = toFiniteNumber(row?.lat_deg);
  const rowLon = toFiniteNumber(row?.lon_deg);

  if (isValidCoordinate(rowLat, rowLon)) {
    return { lat: rowLat, lon: rowLon };
  }

  if (fallbackCoordinates && isValidCoordinate(fallbackCoordinates.lat, fallbackCoordinates.lon)) {
    return { lat: fallbackCoordinates.lat, lon: fallbackCoordinates.lon };
  }

  return { lat: null, lon: null };
}

function extractUltimateStability(row) {
  if (!row || typeof row !== 'object') return null;

  const score = Number.isFinite(row.ultimate_stability_score) ? row.ultimate_stability_score : null;
  const verdict = toNonEmptyString(row.ultimate_stability_verdict);
  const samples = Number.isFinite(row.ultimate_stability_samples) ? row.ultimate_stability_samples : null;
  const gateStable = toBooleanOrNull(row.ultimate_stability_gate_stable);

  const gateFailuresRaw = row.ultimate_stability_gate_failures;
  const gateFailures = typeof gateFailuresRaw === 'string' && gateFailuresRaw.trim()
    ? gateFailuresRaw.split('|').map((value) => value.trim()).filter(Boolean)
    : [];

  const metricEntries = [
    ['gear_ok', row.ultimate_stability_gear_ok_pct],
    ['flaps_ok', row.ultimate_stability_flaps_ok_pct],
    ['spoilers_ok', row.ultimate_stability_spoilers_ok_pct],
    ['config_ok', row.ultimate_stability_config_ok_pct],
    ['speed_ok', row.ultimate_stability_speed_ok_pct],
    ['speed_trend_ok', row.ultimate_stability_speed_trend_ok_pct],
    ['vs_ok', row.ultimate_stability_vs_ok_pct],
    ['glidepath_ok', row.ultimate_stability_glidepath_ok_pct],
    ['glidepath_below_ok', row.ultimate_stability_glidepath_below_ok_pct],
    ['glidepath_above_ok', row.ultimate_stability_glidepath_above_ok_pct],
    ['thrust_ok', row.ultimate_stability_thrust_ok_pct],
    ['thrust_not_idle_ok', row.ultimate_stability_thrust_not_idle_ok_pct],
    ['thrust_stable_ok', row.ultimate_stability_thrust_stable_ok_pct],
    ['pitch_ok', row.ultimate_stability_pitch_ok_pct],
    ['bank_ok', row.ultimate_stability_bank_ok_pct],
    ['lateral_offset_ok', row.ultimate_stability_lateral_offset_ok_pct],
  ];

  const breakdown = parseJsonObject(row.ultimate_stability_breakdown) || {};
  const scoringContext = parseJsonObject(row.ultimate_stability_context);
  for (const [key, value] of metricEntries) {
    if (Number.isFinite(value)) breakdown[key] = value;
  }

  const hasBreakdown = Object.keys(breakdown).length > 0;
  const hasData = score != null || verdict != null || samples != null || gateStable != null || gateFailures.length > 0 || hasBreakdown || scoringContext;
  if (!hasData) return null;

  return normalizeRetiredSpoilerStability({
    score,
    verdict,
    samples,
    gateStable,
    gateFailures,
    breakdown,
    scoringContext,
  });
}

function formatReplayFlapLabel(value: unknown, label: unknown): string {
  const text = String(label ?? value ?? '').trim();
  if (!text || text === '0') return 'UP';
  return text;
}

function resolveReplayFlapState(
  row: AnyRecord | null | undefined,
  profileCache: Map<string, AnyRecord | null>,
): ReplayFlapState | null {
  const profileId = toNonEmptyString(row?.aircraft_profile_id || row?.aircraftProfileId);
  const recordedNotch = toFiniteNumber(row?.flaps_notch ?? row?.flapsNotch);
  const recordedPercent = toFiniteNumber(row?.flaps_pct ?? row?.flapsPercent);
  if (!profileId || (recordedNotch === null && recordedPercent === null)) return null;

  let profile = profileCache.get(profileId);
  if (profile === undefined) {
    try {
      profile = profileLoader.loadProfile(profileId);
    } catch (_e) {
      profile = null;
    }
    profileCache.set(profileId, profile);
  }
  const recordedSource = toNonEmptyString(row?.flaps_source ?? row?.flapsSource)?.toLowerCase() || null;
  const reliability = toNonEmptyString(profile?.signalReliability?.flapsNotch) || 'generic';
  const flapDataQuality = toNonEmptyString(profile?.provenance?.dataQuality?.flaps)?.toLowerCase() || null;
  const configuredFlapLvar = profile?.dataSource?.lvars?.flaps ?? profile?.integration?.telemetry?.lvars?.flaps;
  const hasConfiguredFlapLvar = configuredFlapLvar !== null && configuredFlapLvar !== undefined && configuredFlapLvar !== '';
  const explicitlyAuthoritative = reliability === 'authoritative';

  // New recordings carry the source that produced the notch. LVAR detents are
  // accepted only when the profile actually configures that LVAR; SimConnect
  // handle-index mapping is accepted only for documented flap profiles. Older
  // recordings have no source column, so infer reliability solely for profiles
  // with a configured flap LVAR and non-estimated detent data.
  const sourceIsReliable = recordedSource === 'lvar'
    ? hasConfiguredFlapLvar && flapDataQuality !== 'estimated' && flapDataQuality !== 'unknown'
    : recordedSource === 'profile'
      ? explicitlyAuthoritative || flapDataQuality === 'documented'
      : recordedSource === null
        ? hasConfiguredFlapLvar && flapDataQuality !== 'estimated' && flapDataQuality !== 'unknown'
        : false;
  const profileKey = toNonEmptyString(profile?._qualifiedId || profile?._profileKey || profile?.id) || profileId;
  if (sourceIsReliable && reliability !== 'unavailable' && recordedNotch !== null) {
    const notches = profile?.aircraft?.flaps?.notches;
    if (Array.isArray(notches) && notches.length >= 2) {
      const notchIndex = notches.findIndex((notch: AnyRecord) => {
        const configuredValue = toFiniteNumber(notch?.value);
        return configuredValue !== null && Math.abs(configuredValue - recordedNotch) <= 0.001;
      });
      if (notchIndex >= 0) {
        const notch = notches[notchIndex];
        return {
          kind: 'detent',
          profileKey,
          notchIndex,
          value: recordedNotch,
          label: formatReplayFlapLabel(recordedNotch, notch?.label),
          reliability,
          source: recordedSource || 'profile-inferred',
        };
      }
    }
  }

  // When a trustworthy discrete detent is unavailable, use the recorded handle
  // percent. Quantizing to whole percentages plus the longer settle window below
  // prevents continuous surface travel from producing intermediate timeline rows.
  if (recordedPercent === null || recordedPercent < 0 || recordedPercent > 100) return null;
  const roundedPercent = Math.round(recordedPercent);
  return {
    kind: 'percent',
    profileKey,
    notchIndex: roundedPercent,
    value: roundedPercent,
    label: roundedPercent < 1 ? 'UP' : `${roundedPercent}%`,
    reliability: 'generic',
    source: recordedSource || 'percent-inferred',
  };
}

function buildReplayFlapChangeEvent(
  previous: ReplayFlapState,
  current: ReplayFlapState,
  row: CsvRow,
  timestampMs: number,
  elapsedMs: number,
  coordinates: NullableCoordinate,
): AnyRecord {
  const extending = current.notchIndex > previous.notchIndex;
  const label = `${extending ? 'Flaps extended' : 'Flaps retracted'} to ${current.label}`;
  const summary = `${previous.label} -> ${current.label}`;
  const confidence = current.kind === 'detent' ? 'profile-confirmed' : 'simconnect';

  return {
    type: 'configuration_event',
    eventType: 'flaps_changed',
    timestampMs,
    elapsedMs,
    label,
    summary,
    previous: previous.value,
    current: current.value,
    previousLabel: previous.label,
    currentLabel: current.label,
    direction: extending ? 'extension' : 'retraction',
    confidence,
    reliability: current.reliability,
    source: current.source,
    aircraftProfileId: current.profileKey,
    lat: coordinates.lat,
    lon: coordinates.lon,
    phase: toNonEmptyString(row.phase),
    raFt: toFiniteNumber(row.ra_ft),
    context: {
      previous_flaps: previous.label,
      current_flaps: current.label,
      previous_notch: previous.value,
      current_notch: current.value,
      value_type: current.kind,
      direction: extending ? 'extension' : 'retraction',
      confidence,
      signal_reliability: current.reliability,
      flaps_source: current.source,
      aircraft_profile_id: current.profileKey,
      phase: toNonEmptyString(row.phase),
      ra_ft: toFiniteNumber(row.ra_ft),
    },
  };
}

function isUsableUltimateStability(value) {
  if (!value || typeof value !== 'object') return false;
  const failures = Array.isArray(value.gateFailures)
    ? value.gateFailures.map((failure) => String(failure))
    : [];
  const samples = toFiniteNumber(value.samples);
  const score = toFiniteNumber(value.score);
  if (score === null && samples !== null && samples <= 0 && failures.includes('insufficient_data')) {
    return false;
  }
  return true;
}

function findLatestUnmergedLandingEventIndex(events, timestampMs, windowMs) {
  if (!Array.isArray(events) || events.length === 0) return undefined;

  // Replay now keeps one event per landing attempt and attaches physical
  // bounces directly to that event. When an explicit go-around or continuous
  // airborne re-arm creates another attempt inside the rollout merge window,
  // the newest unmerged touchdown is therefore the only safe time fallback.
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (!event || event.type !== 'landing' || event._landingRowMerged === true) continue;
    const eventTimestampMs = toFiniteNumber(event.timestampMs);
    if (eventTimestampMs === null) continue;
    const ageMs = timestampMs - eventTimestampMs;
    if (ageMs >= 0 && ageMs <= windowMs) return index;
  }
  return undefined;
}

function distanceFeetBetweenCoordinates(a, b) {
  if (!a || !b || !isValidCoordinate(a.lat, a.lon) || !isValidCoordinate(b.lat, b.lon)) return null;
  const earthRadiusFt = 20925524.9;
  const toRad = (deg) => deg * Math.PI / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthRadiusFt * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function getRowCoordinate(row: CsvRow | null | undefined): Coordinate | null {
  const lat = toFiniteNumber(row?.lat_deg);
  const lon = toFiniteNumber(row?.lon_deg);
  return isValidCoordinate(lat, lon) ? { lat, lon } : null;
}

function calculateTrackDistanceNmFromRows(rows: CsvRow[]): number | null {
  let previousCoord: Coordinate | null = null;
  let totalDistanceFt = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const coord = getRowCoordinate(row);
    if (!coord) continue;
    if (previousCoord) {
      const segmentFt = distanceFeetBetweenCoordinates(previousCoord, coord);
      if (segmentFt !== null) totalDistanceFt += segmentFt;
    }
    previousCoord = coord;
  }

  return totalDistanceFt > 0 ? Math.round((totalDistanceFt / FEET_PER_NAUTICAL_MILE) * 10) / 10 : null;
}

function getLandingRowTouchdownIdentities(row) {
  const identities = [];
  const seen = new Set();
  const addIdentity = (latValue, lonValue) => {
    const lat = toFiniteNumber(latValue);
    const lon = toFiniteNumber(lonValue);
    if (!isValidCoordinate(lat, lon)) return;
    const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    if (seen.has(key)) return;
    seen.add(key);
    identities.push({ lat, lon });
  };

  const finalLat = toFiniteNumber(row?.final_touchdown_lat);
  const finalLon = toFiniteNumber(row?.final_touchdown_lon);
  addIdentity(finalLat, finalLon);

  const firstLat = toFiniteNumber(row?.first_touchdown_lat);
  const firstLon = toFiniteNumber(row?.first_touchdown_lon);
  addIdentity(firstLat, firstLon);

  const rowLat = toFiniteNumber(row?.lat_deg);
  const rowLon = toFiniteNumber(row?.lon_deg);
  addIdentity(rowLat, rowLon);

  return identities;
}

function landingRunwayMatchesRow(event, row) {
  const rowIcao = typeof row?.icao === 'string' ? row.icao.trim().toUpperCase() : '';
  const rowRunway = row?.runway != null ? String(row.runway).trim().toUpperCase() : '';
  const eventIcao = typeof event?.runway?.airport_icao === 'string'
    ? event.runway.airport_icao.trim().toUpperCase()
    : '';
  const eventRunway = event?.runway?.runway_id != null
    ? String(event.runway.runway_id).trim().toUpperCase()
    : '';

  if (rowIcao && eventIcao && rowIcao !== eventIcao) return false;
  if (rowRunway && eventRunway && rowRunway !== eventRunway) return false;
  return true;
}

function findLandingEventByTouchdownIdentity(events, row, timestampMs) {
  const touchdownIdentities = getLandingRowTouchdownIdentities(row);
  if (!Array.isArray(events) || touchdownIdentities.length === 0) return undefined;

  const candidates = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => {
      if (!event || event.type !== 'landing') return false;
      if (event._landingRowMerged === true) return false;
      if (!landingRunwayMatchesRow(event, row)) return false;
      const eventTs = toFiniteNumber(event.timestampMs) ?? timestampMs;
      const ageMs = timestampMs - eventTs;
      return ageMs >= 0 && ageMs <= LANDING_TOUCHDOWN_IDENTITY_WINDOW_MS;
    })
    .map(({ event, index }) => {
      const distances = touchdownIdentities
        .map((touchdownIdentity) => distanceFeetBetweenCoordinates(
          { lat: toFiniteNumber(event.lat), lon: toFiniteNumber(event.lon) },
          touchdownIdentity,
        ))
        .filter((distanceFt) => distanceFt !== null);
      const distanceFt = distances.length > 0 ? Math.min(...distances) : null;
      return { event, index, distanceFt };
    })
    .filter(({ distanceFt }) => distanceFt !== null && distanceFt <= LANDING_TOUCHDOWN_IDENTITY_MAX_DISTANCE_FT)
    .sort((a, b) => {
      if (a.distanceFt !== b.distanceFt) return a.distanceFt - b.distanceFt;
      return (b.event.timestampMs ?? 0) - (a.event.timestampMs ?? 0);
    });

  return candidates[0]?.index;
}

function findActiveLandingEventIndex(events, activeLandingEvent, row, timestampMs) {
  if (!activeLandingEvent || activeLandingEvent._landingRowMerged === true) return undefined;
  const index = events.indexOf(activeLandingEvent);
  if (index < 0 || activeLandingEvent.type !== 'landing') return undefined;

  const eventTimestampMs = toFiniteNumber(activeLandingEvent.timestampMs);
  if (eventTimestampMs === null) return undefined;
  const ageMs = timestampMs - eventTimestampMs;
  if (ageMs < 0 || ageMs > LANDING_TOUCHDOWN_IDENTITY_WINDOW_MS) return undefined;
  if (!landingRunwayMatchesRow(activeLandingEvent, row)) return undefined;

  // When the LANDING row carries touchdown identities, reject an active event
  // that is clearly a different physical attempt. Same-runway touch-and-go
  // attempts can be close together, so proximity only vetoes; the explicit
  // active-attempt state remains the tie-breaker.
  const identities = getLandingRowTouchdownIdentities(row);
  const activeCoordinate = {
    lat: toFiniteNumber(activeLandingEvent.lat),
    lon: toFiniteNumber(activeLandingEvent.lon),
  };
  if (identities.length > 0 && isValidCoordinate(activeCoordinate.lat, activeCoordinate.lon)) {
    const nearestDistanceFt = Math.min(...identities.map(identity => (
      distanceFeetBetweenCoordinates(activeCoordinate, identity) ?? Number.POSITIVE_INFINITY
    )));
    if (nearestDistanceFt > LANDING_TOUCHDOWN_IDENTITY_MAX_DISTANCE_FT) return undefined;
  }

  return index;
}

/**
 * Build the inputs `frameToSample` needs from a parsed CSV row. Lives here
 * (rather than inline in the row loop) so the approach-profile sample and the
 * stability-scorer sample share one place that knows the CSV column layout.
 */
function csvRowToStabilityFrame(row, dtMs) {
  return buildCanonicalStabilityFrameFromCsvRow(row, dtMs);
}

// ═══════════════════════════════════════════════════════════════════════════
// Approach Profile Helpers
// ═══════════════════════════════════════════════════════════════════════════

// The map track is a visual breadcrumb trail, not the authoritative sample
// stream. Keep thinning in one helper so generateFromCSV can focus on event
// reconstruction and so the last valid point is always retained.
function appendTrackPointIfDue(input: {
  timeline: GeneratedTimeline;
  row: CsvRow;
  timestampMs: number;
  elapsedMs: number;
  rowIndex: number;
  rowCount: number;
  lastTrackPoint: AnyRecord | null;
}): AnyRecord | null {
  const { timeline, row, timestampMs, elapsedMs, rowIndex, rowCount, lastTrackPoint } = input;
  const lat = toFiniteNumber(row.lat_deg);
  const lon = toFiniteNumber(row.lon_deg);
  if (!isValidCoordinate(lat, lon)) return lastTrackPoint;

  const hdg = Number(row.hdg_true_deg);
  const pitch = toFiniteNumber(row.pitch_deg);
  const bank = toFiniteNumber(row.bank_deg);
  const ias = toFiniteNumber(row.ias_kts);
  const altMsl = toFiniteNumber(row.alt_msl_ft);
  const hasLast = !!lastTrackPoint;
  const deltaMs = hasLast ? (timestampMs - lastTrackPoint.timestampMs) : Number.POSITIVE_INFINITY;
  const dueByTime = deltaMs >= TRACK_POINT_MIN_GAP_MS;

  if (hasLast && !dueByTime && rowIndex !== rowCount - 1) {
    return lastTrackPoint;
  }

  const point = {
    timestampMs,
    elapsedMs,
    lat,
    lon,
    hdgTrueDeg: Number.isFinite(hdg) ? hdg : null,
    pitchDeg: Number.isFinite(pitch) ? pitch : null,
    rollDeg: Number.isFinite(bank) ? bank : null,
    iasKts: Number.isFinite(ias) ? ias : null,
    altFt: Number.isFinite(altMsl) ? altMsl : null,
  };
  timeline.track.push(point);
  return point;
}

// Approach-profile samples feed both the replay diagram and retrospective
// stability analysis. Keep the touchdown row for the diagram; the scorer
// excludes on-ground samples internally. Level/climb frames remain available
// so the retrospective VS check can detect a below-gate balloon, while explicit
// GO_AROUND rows and above-ceiling climbs reset the abandoned approach.
function shouldCollectApproachSample(row: CsvRow, ra: number | null, flightEnded: boolean, pausedOrMenu = false): boolean {
  return !pausedOrMenu &&
    ra !== null &&
    ra > 0 &&
    ra <= APPROACH_CEILING_FT &&
    toFiniteNumber(row.vs_fpm) !== null &&
    !flightEnded;
}

function isPausedOrMenuRow(row: CsvRow): boolean {
  return toBooleanOrNull(row.sim_paused) === true || toBooleanOrNull(row.sim_in_menu) === true;
}

function isLocalizerDeviationRelevant(row: CsvRow): boolean {
  const hasLocalizer = toBooleanOrNull(row?.nav1_has_localizer);
  if (hasLocalizer !== null) return hasLocalizer && isNavSignalUsable(row);

  const approachType = typeof row?.approach_type === 'string'
    ? row.approach_type.trim().toUpperCase()
    : '';
  return approachType.includes('ILS') ||
    /\bLOC\b/.test(approachType) ||
    approachType.includes('LOCALIZER');
}

function isGlideslopeDeviationRelevant(row: CsvRow): boolean {
  const hasGlideSlope = toBooleanOrNull(row?.nav1_has_glideslope);
  return hasGlideSlope === null ? true : hasGlideSlope && isNavSignalUsable(row);
}

function isNavSignalUsable(row: CsvRow): boolean {
  const signal = toFiniteNumber(row?.nav1_signal);
  return signal === null || signal > 0;
}

function plausibleIlsDeviationDots(value: unknown): number | null {
  const numeric = toFiniteNumber(value);
  if (numeric === null) return null;
  return Math.abs(numeric) <= MAX_PLAUSIBLE_ILS_DEVIATION_DOTS ? numeric : null;
}

// `tMs` is relative elapsed time when available and `absMs` is wall-clock time.
// The renderer/downstream scans need both, so build the row shape in one place.
function buildApproachProfileSample(
  row: CsvRow,
  rawElapsed: number | null,
  timestampMs: number,
  pausedOrMenuAccumulatedMs = 0,
): AnyRecord {
  const rawTMs = rawElapsed !== null
    ? rawElapsed
    : (Number.isFinite(timestampMs) ? timestampMs : 0);
  const tMs = Math.max(0, rawTMs - pausedOrMenuAccumulatedMs);

  return {
    raFt: toFiniteNumber(row.ra_ft),
    altMslFt: toFiniteNumber(row.alt_msl_ft),
    altCalibratedFt: toFiniteNumber(row.alt_calibrated_ft),
    altPlaneFt: toFiniteNumber(row.alt_plane_ft),
    pressureAltFt: toFiniteNumber(row.pressure_alt_ft),
    aircraftAglFt: toFiniteNumber(row.aircraft_agl_ft),
    aircraftAboveObstaclesFt: toFiniteNumber(row.aircraft_above_obstacles_ft),
    planeAglFt: toFiniteNumber(row.plane_agl_ft),
    planeAglMinusCgFt: toFiniteNumber(row.plane_agl_minus_cg_ft),
    vsFpm: toFiniteNumber(row.vs_fpm) ?? 0,
    iasKts: toFiniteNumber(row.ias_kts) ?? 0,
    gsKts: toFiniteNumber(row.gs_kts),
    pitchDeg: toFiniteNumber(row.pitch_deg),
    bankDeg: toFiniteNumber(row.bank_deg),
    latDeg: toFiniteNumber(row.lat_deg),
    lonDeg: toFiniteNumber(row.lon_deg),
    headingDeg: toFiniteNumber(row.hdg_true_deg),
    tMs,
    absMs: timestampMs,
  };
}

/**
 * Downsample approach profile to a maximum number of evenly-spaced points.
 * Returns the original array (or empty) if already within the limit.
 *
 * Computes `dtMs` for each kept sample as the elapsed time since the previous
 * kept sample (using `tMs` from raw samples). This is critical for the renderer:
 * it integrates groundspeed over dt to derive the chart's horizontal axis.
 * Without post-downsample dt aggregation, the raw per-sample dtMs (~100 ms at
 * 10 Hz) underestimates true inter-point spacing by the downsample ratio,
 * compressing the horizontal axis and breaking the 3 degree glideslope geometry.
 *
 * The transient `tMs` field is stripped from output (renderer only needs `dtMs`).
 *
 * @param {Array<{raFt:number, altMslFt:number|null, vsFpm:number, iasKts:number, gsKts:number|null, pitchDeg:number|null, bankDeg:number|null, tMs:number}>} samples
 * @param {number} maxPoints
 * @returns {Array<{raFt:number, altMslFt:number|null, vsFpm:number, iasKts:number, gsKts:number|null, pitchDeg:number|null, bankDeg:number|null, dtMs:number|null}>}
 */
function downsampleApproachProfile(samples, maxPoints, lockedAltitudeSource = null) {
  const altitudeSource = ['plane', 'calibrated', 'indicated', 'radio'].includes(lockedAltitudeSource)
    ? lockedAltitudeSource
    : selectApproachAltitudeSource(samples);
  const selectedAltitude = (sample) => (
    altitudeSource === 'plane'
      ? sample.altPlaneFt
      : (altitudeSource === 'calibrated'
        ? sample.altCalibratedFt
        : (altitudeSource === 'indicated' ? sample.altMslFt : null))
  );
  const sourceLockedSamples = samples.map((sample) => ({
    ...sample,
    profileAltitudeFt: selectedAltitude(sample),
    // Backward-compatible alias for older frontend builds.
    profileAltMslFt: selectedAltitude(sample),
    profileAltitudeSource: altitudeSource,
  }));
  return downsampleTimedSamples(sourceLockedSamples, maxPoints);
}

function getRowTimestampMs(row: CsvRow | null | undefined): number {
  const explicitTs = toFiniteNumber(row?.ts);
  if (explicitTs !== null) return explicitTs;

  const eventTs = toFiniteNumber(row?.timestamp_ms);
  if (eventTs !== null) return eventTs;

  const parsed = typeof row?.timestamp_utc === 'string'
    ? Date.parse(row.timestamp_utc)
    : NaN;
  return Number.isFinite(parsed) ? parsed : NaN;
}

function getRowElapsedMs(row: CsvRow | null | undefined, startTimestampMs: number): number {
  const explicitElapsed = toFiniteNumber(row?.flight_elapsed_ms);
  if (explicitElapsed !== null) return explicitElapsed;

  const timestampMs = getRowTimestampMs(row);
  if (Number.isFinite(timestampMs) && Number.isFinite(startTimestampMs)) {
    return Math.max(0, timestampMs - startTimestampMs);
  }

  return 0;
}

const AUTOMATION_EVENT_LABELS: Record<string, string> = Object.freeze({
  ap_engaged: 'AP engaged',
  ap_disengaged: 'AP disconnected',
  fd_changed: 'Flight director changed',
  athr_armed: 'A/T armed',
  athr_disarmed: 'A/T disarmed',
  athr_engaged: 'Autothrottle active',
  athr_disengaged: 'Autothrottle inactive',
  selected_altitude_changed: 'Selected altitude changed',
  selected_heading_changed: 'Selected heading changed',
  selected_speed_changed: 'Selected speed changed',
  selected_mach_changed: 'Selected Mach changed',
  selected_vertical_speed_changed: 'Selected vertical speed changed',
  lateral_mode_changed: 'Lateral mode changed',
  vertical_mode_changed: 'Vertical mode changed',
  approach_armed: 'Approach armed',
  loc_captured: 'LOC captured',
  gs_captured: 'GS captured',
  manual_takeover: 'Manual takeover',
});

const SUPPRESSED_AUTOMATION_TIMELINE_EVENTS = new Set([
  'selected_altitude_changed',
  'selected_heading_changed',
  'selected_speed_changed',
  'selected_mach_changed',
  'selected_vertical_speed_changed',
  // `athrActive` describes an aircraft-specific control state, not proof of a
  // pilot disconnect. Keep these legacy/future active-state rows in the
  // automation sidecar for diagnostics, but use the reliable ARM state for the
  // user-facing timeline.
  'athr_engaged',
  'athr_disengaged',
  'athr_active',
  'athr_inactive',
]);

const PROFILE_DISCONNECT_EVENT_TYPES = new Set([
  'ap_disengaged',
]);

const AUTOMATION_FIELD_UNITS: Record<string, string> = Object.freeze({
  selectedAltitudeFt: 'ft',
  selectedHeadingDeg: 'deg',
  selectedSpeedKt: 'kt',
  selectedMach: 'mach',
  selectedVsFpm: 'fpm',
});

function addKnown(target: AnyRecord, key: string, value: unknown): void {
  if (value === null || value === undefined || value === '') return;
  target[key] = value;
}

function humanizeAutomationToken(value: unknown): string {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\.]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim();
}

function getAutomationEventLabel(eventType: unknown): string {
  const key = toNonEmptyString(eventType);
  if (!key) return 'Automation event';
  return AUTOMATION_EVENT_LABELS[key] || humanizeAutomationToken(key);
}

function formatAutomationValue(field: unknown, value: unknown): string {
  if (value === null || value === undefined || value === '') return '--';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';

  const fieldKey = toNonEmptyString(field) || '';
  const numeric = toFiniteNumber(value);
  if (numeric !== null) {
    if (fieldKey === 'selectedMach') return `M${numeric.toFixed(2)}`;
    const unit = AUTOMATION_FIELD_UNITS[fieldKey];
    const rounded = Math.round(numeric);
    return unit ? `${rounded} ${unit}` : String(rounded);
  }

  return String(value);
}

function getAutomationEventTimestampMs(row: AnyRecord, startTimestampMs: number): number {
  const explicitTime = toFiniteNumber(row.timeMs);
  if (explicitTime !== null) return explicitTime;

  const iso = toNonEmptyString(row.timestampIso);
  if (iso) {
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) return parsed;
  }

  const elapsedMs = toFiniteNumber(row.flightElapsedMs);
  if (elapsedMs !== null && Number.isFinite(startTimestampMs)) {
    return startTimestampMs + elapsedMs;
  }

  return NaN;
}

function getAutomationEventElapsedMs(row: AnyRecord, timestampMs: number, startTimestampMs: number): number {
  const explicitElapsed = toFiniteNumber(row.flightElapsedMs);
  if (explicitElapsed !== null) return Math.max(0, explicitElapsed);

  if (Number.isFinite(timestampMs) && Number.isFinite(startTimestampMs)) {
    return Math.max(0, timestampMs - startTimestampMs);
  }

  return 0;
}

function buildAutomationSampleIndex(rows: CsvRow[], startTimestampMs: number): AnyRecord[] {
  return rows
    .filter((row) => {
      const recordType = String(row?.record_type || 'SAMPLE').trim() || 'SAMPLE';
      return recordType.toUpperCase() === 'SAMPLE';
    })
    .map((row) => {
      const timestampMs = getRowTimestampMs(row);
      if (!Number.isFinite(timestampMs)) return null;

      const lat = toFiniteNumber(row.lat_deg);
      const lon = toFiniteNumber(row.lon_deg);
      return {
        timestampMs,
        elapsedMs: getRowElapsedMs(row, startTimestampMs),
        raFt: toFiniteNumber(row.ra_ft),
        phase: toNonEmptyString(row.phase),
        lat: isValidCoordinate(lat, lon) ? lat : null,
        lon: isValidCoordinate(lat, lon) ? lon : null,
      };
    })
    .filter(Boolean) as AnyRecord[];
}

function findNearestAutomationSample(samples: AnyRecord[], timestampMs: number): AnyRecord | null {
  if (!Number.isFinite(timestampMs) || !samples.length) return null;

  let low = 0;
  let high = samples.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (samples[mid].timestampMs < timestampMs) low = mid + 1;
    else high = mid;
  }

  const candidates = [samples[low - 1], samples[low]].filter(Boolean);
  let best: AnyRecord | null = null;
  for (const sample of candidates) {
    const deltaMs = Math.abs(sample.timestampMs - timestampMs);
    if (!best || deltaMs < best.nearestSampleDeltaMs) {
      best = {
        ...sample,
        nearestSampleDeltaMs: deltaMs,
      };
    }
  }

  if (!best || best.nearestSampleDeltaMs > 30000) return null;
  return best;
}

function buildAutomationSummary(row: AnyRecord, nearestSample: AnyRecord | null): string {
  const eventType = toNonEmptyString(row.eventType);
  const field = toNonEmptyString(row.field);
  const parts: string[] = [];

  if (field && (row.previous !== undefined || row.current !== undefined)) {
    parts.push(`${formatAutomationValue(field, row.previous)} -> ${formatAutomationValue(field, row.current)}`);
  }

  if (eventType === 'ap_disengaged' && nearestSample?.raFt !== null && nearestSample?.raFt !== undefined) {
    parts.push(`RA ${Math.round(nearestSample.raFt)} ft`);
  }

  return parts.join(' - ');
}

function isUnknownAutomationModeDrop(row: AnyRecord, eventType: string): boolean {
  if (eventType !== 'lateral_mode_changed' && eventType !== 'vertical_mode_changed') return false;
  const current = toNonEmptyString(row.current);
  return !current;
}

function getAutomationRowTimestampMs(row: AnyRecord): number | null {
  const explicit = toFiniteNumber(row.timeMs);
  if (explicit !== null) return explicit;
  const iso = toNonEmptyString(row.timestampIso);
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function getAutomationRowConfidence(row: AnyRecord, reliabilityField: string): string {
  if (row?.[reliabilityField] === false) return 'unreliable';
  const reason = toNonEmptyString(row?.reliabilityReason) || '';
  if (reason.includes('lvar') || reason.includes('sdk')) return 'profile-confirmed';
  if (row?.[reliabilityField] === true) return 'simconnect';
  return 'unavailable';
}

function automationEventIdentity(row: AnyRecord, eventType: string): string {
  const timestampMs = getAutomationRowTimestampMs(row);
  if (timestampMs !== null) return `${timestampMs}:${eventType}`;
  return `${toFiniteNumber(row?.seq) ?? 'unknown'}:${eventType}`;
}

function buildAutomationTimelineRows(automationRows: AnyRecord[]): AnyRecord[] {
  const explicitArmEvents = new Set(
    automationRows
      .filter((row) => (
        row?.type === 'automation_event'
        && (row.eventType === 'athr_armed' || row.eventType === 'athr_disarmed')
      ))
      .map((row) => automationEventIdentity(row, row.eventType)),
  );
  const output: AnyRecord[] = [];
  let previousArmed: boolean | null = null;
  let compactContext: AnyRecord = {};

  for (const row of automationRows) {
    if (row?.type === 'automation_checkpoint' && row.context && typeof row.context === 'object') {
      compactContext = { ...row.context };
    } else if (
      row?.type === 'automation_delta'
      && row.contextChanged
      && typeof row.contextChanged === 'object'
    ) {
      compactContext = { ...compactContext };
      for (const [key, value] of Object.entries(row.contextChanged)) {
        if (value === null) delete compactContext[key];
        else compactContext[key] = value;
      }
    }
    const contextualRow = Object.keys(compactContext).length > 0
      ? { ...compactContext, ...row }
      : row;
    output.push(contextualRow);

    if (contextualRow?.type === 'automation_checkpoint') {
      const checkpointArmed = contextualRow.state?.athrArmed;
      if (typeof checkpointArmed === 'boolean') previousArmed = checkpointArmed;
      continue;
    }

    if (
      contextualRow?.type !== 'automation_delta'
      || !Object.prototype.hasOwnProperty.call(contextualRow.stateChanged || {}, 'athrArmed')
    ) {
      continue;
    }

    const currentArmed = contextualRow.stateChanged.athrArmed;
    if (typeof currentArmed !== 'boolean') {
      previousArmed = null;
      continue;
    }

    const eventType = currentArmed ? 'athr_armed' : 'athr_disarmed';
    if (
      typeof previousArmed === 'boolean'
      && previousArmed !== currentArmed
      && !explicitArmEvents.has(automationEventIdentity(contextualRow, eventType))
    ) {
      output.push({
        ...contextualRow,
        type: 'automation_event',
        eventType,
        field: 'athrArmed',
        previous: previousArmed,
        current: currentArmed,
        confidence: getAutomationRowConfidence(row, 'athrReliable'),
        synthetic: true,
      });
    }
    previousArmed = currentArmed;
  }

  return output;
}

function rowHasSimconnectOffEvidence(row: AnyRecord, field: string): boolean {
  const rawChangedSimconnect = row.rawChanged?.simconnect && typeof row.rawChanged.simconnect === 'object'
    ? row.rawChanged.simconnect
    : null;
  if (rawChangedSimconnect && rawChangedSimconnect[field] === false) return true;

  const rawSimconnect = row.raw?.simconnect && typeof row.raw.simconnect === 'object'
    ? row.raw.simconnect
    : null;
  return rawSimconnect ? rawSimconnect[field] === false : false;
}

function hasNearbySimconnectOffEvidence(
  automationRows: AnyRecord[],
  eventRow: AnyRecord,
  field: string | null,
): boolean {
  if (!field) return false;
  const eventTimeMs = getAutomationRowTimestampMs(eventRow);

  return automationRows.some((row) => {
    if (!row || row === eventRow) return false;
    if (row.type !== 'automation_delta' && row.type !== 'automation_checkpoint') return false;
    if (!rowHasSimconnectOffEvidence(row, field)) return false;

    const rowTimeMs = getAutomationRowTimestampMs(row);
    if (eventTimeMs === null || rowTimeMs === null) return true;
    return Math.abs(rowTimeMs - eventTimeMs) <= 1000;
  });
}

function isUncorroboratedProfileDisconnect(row: AnyRecord, eventType: string, automationRows: AnyRecord[]): boolean {
  if (!PROFILE_DISCONNECT_EVENT_TYPES.has(eventType)) return false;
  if (toNonEmptyString(row.confidence) !== 'profile-confirmed') return false;
  if (row.previous !== true || row.current !== false) return false;
  if (typeof row.simconnectCorroborated === 'boolean') {
    return row.simconnectCorroborated !== true;
  }
  return !hasNearbySimconnectOffEvidence(automationRows, row, toNonEmptyString(row.field));
}

function buildAutomationTimelineEvent(
  row: AnyRecord,
  samples: AnyRecord[],
  startTimestampMs: number,
  automationRows: AnyRecord[] = [],
): AnyRecord | null {
  if (!row || row.type !== 'automation_event') return null;

  const timestampMs = getAutomationEventTimestampMs(row, startTimestampMs);
  if (!Number.isFinite(timestampMs)) return null;

  const eventType = toNonEmptyString(row.eventType) || 'automation_event';
  if (SUPPRESSED_AUTOMATION_TIMELINE_EVENTS.has(eventType)) return null;
  if (isUnknownAutomationModeDrop(row, eventType)) return null;
  if (isUncorroboratedProfileDisconnect(row, eventType, automationRows)) return null;

  const field = toNonEmptyString(row.field);
  const confidence = toNonEmptyString(row.confidence);
  const source = toNonEmptyString(row.source);
  const dataSource = toNonEmptyString(row.dataSource);
  const nearestSample = findNearestAutomationSample(samples, timestampMs);
  const label = getAutomationEventLabel(eventType);
  const summary = buildAutomationSummary(row, nearestSample);
  const context: AnyRecord = {};

  addKnown(context, 'field', field);
  addKnown(context, 'previous', row.previous);
  addKnown(context, 'current', row.current);
  addKnown(context, 'confidence', confidence);
  addKnown(context, 'source', source);
  addKnown(context, 'data_source', dataSource);
  addKnown(context, 'aircraft_profile_id', row.aircraftProfileId);
  addKnown(context, 'reliability_reason', row.reliabilityReason);
  addKnown(context, 'phase', nearestSample?.phase);
  addKnown(context, 'ra_ft', nearestSample?.raFt !== null && nearestSample?.raFt !== undefined
    ? Math.round(nearestSample.raFt)
    : null);
  addKnown(context, 'nearest_sample_delta_ms', nearestSample?.nearestSampleDeltaMs !== undefined
    ? Math.round(nearestSample.nearestSampleDeltaMs)
    : null);

  return {
    type: 'automation_event',
    timestampMs,
    elapsedMs: getAutomationEventElapsedMs(row, timestampMs, startTimestampMs),
    eventType,
    field,
    previous: row.previous ?? null,
    current: row.current ?? null,
    confidence,
    source,
    dataSource,
    label,
    summary,
    lat: nearestSample?.lat ?? null,
    lon: nearestSample?.lon ?? null,
    raFt: nearestSample?.raFt ?? null,
    phase: nearestSample?.phase ?? null,
    context,
  };
}

function automationValueKey(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function mergeAutomationTimelineEvents(
  generatedTimeline: GeneratedTimeline,
  rows: CsvRow[],
  options: AnyRecord,
  startTimestampMs: number,
): string | null {
  const sidecar = options.automationSidecar && typeof options.automationSidecar === 'object'
    ? options.automationSidecar
    : null;
  const automationRows = Array.isArray(options.automationRows)
    ? options.automationRows
    : Array.isArray(sidecar?.rows)
      ? sidecar.rows
      : [];

  if (!automationRows.length) {
    if (sidecar?.error || sidecar?.parseErrorCount) {
      generatedTimeline.automationSummary = {
        eventCount: 0,
        parseErrorCount: sidecar?.parseErrorCount || 0,
        readError: sidecar?.error || null,
      };
    }
    return null;
  }

  const samples = buildAutomationSampleIndex(rows, startTimestampMs);
  const timelineAutomationRows = buildAutomationTimelineRows(automationRows);
  const lastVisibleStateByField = new Map<string, string>();
  let eventCount = 0;
  for (const row of timelineAutomationRows) {
    const event = buildAutomationTimelineEvent(row, samples, startTimestampMs, automationRows);
    if (!event) continue;
    const field = toNonEmptyString(event.field) || '';
    if (field && Object.prototype.hasOwnProperty.call(event, 'current')) {
      const valueKey = automationValueKey(event.current);
      if (lastVisibleStateByField.get(field) === valueKey) continue;
      lastVisibleStateByField.set(field, valueKey);
    }
    if (generatedTimeline.events.length >= MAX_GENERATED_TIMELINE_EVENTS) {
      return 'Timeline contains more events than Flight Fabric can process safely.';
    }
    generatedTimeline.events.push(event);
    eventCount += 1;
  }
  generatedTimeline.automationSummary = {
    eventCount,
    rowCount: automationRows.length,
    parseErrorCount: sidecar?.parseErrorCount || 0,
    readError: sidecar?.error || null,
  };
  return null;
}

function toNonEmptyString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

type SimulatorDateTimes = {
  local: string | null;
  utc: string | null;
};

function getSimulatorDateTimes(row: CsvRow | null | undefined): SimulatorDateTimes | null {
  const validity = row?.sim_datetime_valid;
  if (validity === false || validity === 0 || validity === '0' || validity === 'false') return null;

  const localDate = toNonEmptyString(row?.sim_date_local);
  const localTime = toNonEmptyString(row?.sim_time_local_hms);
  const utcDate = toNonEmptyString(row?.sim_date_utc);
  const utcTime = toNonEmptyString(row?.sim_time_zulu_hms);
  const local = toNonEmptyString(row?.sim_datetime_local)
    ?? (localDate && localTime ? `${localDate}T${localTime}` : null);
  const utc = toNonEmptyString(row?.sim_datetime_utc)
    ?? (utcDate && utcTime ? `${utcDate}T${utcTime}Z` : null);

  return local || utc ? { local, utc } : null;
}

function getSimulatorStartDateTimes(rows: CsvRow[]): SimulatorDateTimes {
  for (const row of rows) {
    const dateTimes = getSimulatorDateTimes(row);
    if (dateTimes) return dateTimes;
  }

  return { local: null, utc: null };
}

function attachSimulatorDateTimesToEvents(
  events: AnyRecord[],
  rows: CsvRow[],
  startTimestampMs: number,
): void {
  let rowIndex = 0;
  const readNextPoint = () => {
    while (rowIndex < rows.length) {
      const row = rows[rowIndex++];
      const dateTimes = getSimulatorDateTimes(row);
      if (dateTimes) {
        return {
          elapsedMs: getRowElapsedMs(row, startTimestampMs),
          ...dateTimes,
        };
      }
    }
    return null;
  };

  let before = null;
  let after = readNextPoint();
  const nearestPoint = (elapsedMs: number) => {
    while (after && after.elapsedMs < elapsedMs) {
      before = after;
      after = readNextPoint();
    }
    if (!before) return after;
    if (!after) return before;
    return elapsedMs - before.elapsedMs <= after.elapsedMs - elapsedMs ? before : after;
  };

  for (const event of events) {
    const elapsedMs = toFiniteNumber(event?.elapsedMs)
      ?? (
        Number.isFinite(event?.timestampMs) && Number.isFinite(startTimestampMs)
          ? Math.max(0, event.timestampMs - startTimestampMs)
          : null
      );
    if (elapsedMs === null) continue;
    const point = nearestPoint(elapsedMs);
    if (!point) continue;
    if (point.local) event.simDateTimeLocal = point.local;
    if (point.utc) event.simDateTimeUtc = point.utc;
  }
}

const RECORDED_FLIGHT_VIOLATION_STRING_CONTEXT = [
  'risk_level',
  'confidence_level',
  'spoiler_state',
] as const;

const RECORDED_FLIGHT_VIOLATION_NUMBER_CONTEXT = [
  'ias_kts',
  'ra_ft',
  'vs_fpm',
  'spoiler_pct',
  'max_approach_kts',
  'approach_overspeed_limit_kts',
  'approach_overspeed_buffer_kts',
  'approach_overspeed_excess_kts',
  'convective_score',
  'convective_duration_ms',
  'convective_motion_score',
  'convective_weather_score',
  'convective_peak_load_excursion_g',
  'convective_avg_load_excursion_g',
  'convective_peak_load_jerk_gps',
  'convective_peak_pitch_rate_dps',
  'convective_peak_roll_rate_dps',
  'convective_peak_yaw_rate_dps',
  'convective_peak_pitch_deg',
  'convective_peak_bank_deg',
  'convective_maneuver_ratio',
  'convective_vertical_reversals',
  'convective_vertical_reversal_rate_per_min',
  'convective_vertical_speed_activity_score',
  'convective_ias_range_kts',
  'convective_vs_range_fpm',
  'convective_in_cloud_ratio',
  'convective_precip_ratio',
  'convective_precip_rate_max_mm',
  'convective_density_alt_ft',
  'convective_sample_count',
] as const;

const RECORDED_FLIGHT_VIOLATION_BOOLEAN_CONTEXT = [
  'counts_as_upset',
  'convective_weather_available',
  'convective_weather_aligned',
  'convective_maneuver_suppressed',
] as const;

function copyRecordedFlightViolationContext(row: CsvRow, context: AnyRecord): void {
  for (const key of RECORDED_FLIGHT_VIOLATION_STRING_CONTEXT) {
    const value = toNonEmptyString(row[key]);
    if (value !== null) context[key] = value;
  }
  for (const key of RECORDED_FLIGHT_VIOLATION_NUMBER_CONTEXT) {
    const value = toFiniteNumber(row[key]);
    if (value !== null) context[key] = key.endsWith('_ms') || key.endsWith('_count')
      ? Math.round(value)
      : value;
  }
  for (const key of RECORDED_FLIGHT_VIOLATION_BOOLEAN_CONTEXT) {
    const value = toBooleanOrNull(row[key]);
    if (value !== null) context[key] = value;
  }
}

function shouldSuppressRecordedFlightViolation(row: CsvRow, ruleId: string): boolean {
  void row;
  return ruleId === VIOLATION_RULE.CONVECTIVE_EXPOSURE;
}

function buildRecordedFlightViolationEvent(
  type: 'violation_start' | 'violation_end',
  row: CsvRow,
  timestampMs: number,
  elapsedMs: number,
  coordinates: NullableCoordinate,
): AnyRecord | null {
  const ruleId = toNonEmptyString(row.rule_id);
  if (!ruleId) return null;
  if (shouldSuppressRecordedFlightViolation(row, ruleId)) return null;

  const label = toNonEmptyString(row.label);
  const severity = toNonEmptyString(row.severity);
  const context: AnyRecord = {};
  const pitchDeg = toFiniteNumber(row.pitch_deg);
  const bankDeg = toFiniteNumber(row.bank_deg);
  const gForce = toFiniteNumber(row.gforce ?? row.g_force);
  const durationMs = toFiniteNumber(row.duration_ms);

  if (label) context.label = label;
  if (pitchDeg !== null) context.pitch_deg = pitchDeg;
  if (bankDeg !== null) context.bank_deg = bankDeg;
  if (gForce !== null) context.gforce = gForce;
  if (durationMs !== null) context.duration_ms = Math.round(durationMs);
  copyRecordedFlightViolationContext(row, context);

  return {
    type,
    timestampMs,
    elapsedMs,
    ruleId,
    severity: severity || undefined,
    label: label || undefined,
    lat: coordinates.lat,
    lon: coordinates.lon,
    context,
  };
}

function removeRetiredSpoilerViolationSummaries(flightSummary: AnyRecord | null | undefined): void {
  if (!flightSummary || typeof flightSummary !== 'object') return;
  if (!Array.isArray(flightSummary.violations)) return;
  flightSummary.violations = flightSummary.violations.filter((violation) => (
    toNonEmptyString(violation?.rule_id ?? violation?.ruleId)
      !== VIOLATION_RULE.SPEEDBRAKE_DEPLOYED_IN_FLIGHT
  ));
}

function findFuelRows(rows: CsvRow[]) {
  return selectFuelUsageRows(rows);
}

function isCsvFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.csv');
}

function isRecordingManifestRow(row: CsvRow | null | undefined): boolean {
  return String(row?.record_type || '').trim().toUpperCase() === 'RECORDING_MANIFEST';
}

function stripCsvExtension(fileName: string): string {
  return fileName.replace(/\.csv$/i, '');
}

function isTimelineFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.timeline.json');
}

function stripTimelineExtension(fileName: string): string {
  return fileName.replace(/\.timeline\.json$/i, '');
}

function createInitialTimeline(csvPath: string, rows: CsvRow[]): GeneratedTimeline {
  const firstRow = rows[0];
  const lastRow = rows[rows.length - 1];
  const simulatorStart = getSimulatorStartDateTimes(rows);
  const startTimestampMs = getRowTimestampMs(firstRow);
  const endTimestampMs = getRowTimestampMs(lastRow);
  const durationMs = Number.isFinite(startTimestampMs) && Number.isFinite(endTimestampMs)
    ? Math.max(0, endTimestampMs - startTimestampMs)
    : getRowElapsedMs(lastRow, startTimestampMs);
  const { firstFuelRow, lastFuelRow } = findFuelRows(rows);
  const fuelUsage = summarizeFuelUsage(firstFuelRow, lastFuelRow);
  const flightId = firstRow.flight_id
    || recordingBundleLayout.getBundleFromCsvPath(csvPath)?.bundleName
    || stripCsvExtension(path.basename(csvPath));
  let aircraftProfileId: string | null = null;
  for (const row of rows) {
    aircraftProfileId = getReplayAircraftProfileId(row);
    if (aircraftProfileId) break;
  }

  const departureAirport = findNearestAirport(firstRow.lat_deg, firstRow.lon_deg);
  const arrivalAirport = findNearestAirport(lastRow.lat_deg, lastRow.lon_deg);

  return {
    flightId,
    startTime: firstRow.timestamp_utc || firstRow.ts || null,
    endTime: lastRow.timestamp_utc || lastRow.ts || null,
    simDateTimeLocal: simulatorStart.local,
    simDateTimeUtc: simulatorStart.utc,
    durationMs,
    durationFormatted: formatDuration(durationMs),
    aircraft: firstRow.aircraft || 'Unknown',
    aircraftProfileId,
    departureAirport: departureAirport ? {
      icao: departureAirport.icao,
      name: departureAirport.name,
    } : null,
    arrivalAirport: arrivalAirport ? {
      icao: arrivalAirport.icao,
      name: arrivalAirport.name,
    } : null,
    route: departureAirport && arrivalAirport ? `${departureAirport.icao} → ${arrivalAirport.icao}` : null,
    distanceNm: calculateTrackDistanceNmFromRows(rows),
    fuelBurnGal: fuelUsage.fuelBurnGal,
    fuelBurnWeightLbs: fuelUsage.fuelBurnWeightLbs,
    fuelStartGal: fuelUsage.fuelStartGal,
    fuelEndGal: fuelUsage.fuelEndGal,
    fuelBurnSource: fuelUsage.fuelBurnSource,
    events: [],
    track: [],
    generated: true,
    generatedAt: new Date().toISOString(),
  };
}

function buildLandingRowTouchdownDistance(
  row: CsvRow,
  scoringMode: 'recorded' | 'current-preview' = 'recorded',
): AnyRecord | null {
  const distanceFt = toFiniteNumber(row.touchdown_distance_ft);
  const bounceCount = toFiniteNumber(row.bounce_count);
  const bounceDistanceFt = toFiniteNumber(row.bounce_distance_ft);
  const bounceWorstGforce = toFiniteNumber(row.bounce_worst_gforce);
  const runwayLengthFt = toFiniteNumber(row.runway_length_ft);
  const runwayWidthFt = toFiniteNumber(row.runway_width_ft);
  const lateralOffsetFt = toFiniteNumber(row.lateral_offset_ft);
  const recordedZone = typeof row.touchdown_distance_zone === 'string' && row.touchdown_distance_zone.trim()
    ? row.touchdown_distance_zone.trim()
    : null;
  const runwayCondition = typeof row.runway_condition === 'string' && row.runway_condition
    ? row.runway_condition
    : null;
  const recordedShortLanding = toBooleanOrNull(row.short_landing);
  const shortLanding = recordedShortLanding ?? (distanceFt !== null ? distanceFt < 0 : null);
  const firstTouchdown = {
    lat: toFiniteNumber(row.first_touchdown_lat),
    lon: toFiniteNumber(row.first_touchdown_lon),
    vsFpm: toFiniteNumber(row.first_touchdown_vs_fpm),
    gforce: toFiniteNumber(row.first_touchdown_gforce),
  };
  const finalTouchdown = {
    lat: toFiniteNumber(row.final_touchdown_lat),
    lon: toFiniteNumber(row.final_touchdown_lon),
    vsFpm: toFiniteNumber(row.final_touchdown_vs_fpm),
    gforce: toFiniteNumber(row.final_touchdown_gforce),
  };
  const hasFirstTouchdown = Object.values(firstTouchdown).some(value => value !== null);
  const hasFinalTouchdown = Object.values(finalTouchdown).some(value => value !== null);

  const common = {
    distanceFt,
    shortLanding,
    tdzAchieved: distanceFt === null
      ? null
      : landingDistance.isTouchdownZoneAchieved(distanceFt, runwayLengthFt),
    runway_condition: runwayCondition,
    runway_condition_source:
      typeof row.runway_condition_source === 'string' && row.runway_condition_source
        ? row.runway_condition_source
        : null,
    runway_condition_confident: toBooleanOrNull(row.runway_condition_confident),
    runwaySurface:
      typeof row.runway_surface === 'string' && row.runway_surface
        ? row.runway_surface
        : null,
    runwayGeometrySource:
      typeof row.runway_geometry_source === 'string' && row.runway_geometry_source
        ? row.runway_geometry_source
        : null,
    runwayGeometryProviderChain:
      typeof row.runway_geometry_provider_chain === 'string' && row.runway_geometry_provider_chain
        ? row.runway_geometry_provider_chain
        : null,
    runwayGeometryFallbackReason:
      typeof row.runway_geometry_fallback_reason === 'string' && row.runway_geometry_fallback_reason
        ? row.runway_geometry_fallback_reason
        : null,
    runwayGeometryDiagnostics: parseJsonObject(row.runway_geometry_diagnostics),
    runwayHeadingTrueDeg: toFiniteNumber(row.runway_heading_true_deg),
    runwayPhysicalLengthFt: toFiniteNumber(row.runway_physical_length_ft),
    runwayThresholdLat: toFiniteNumber(row.runway_threshold_lat),
    runwayThresholdLon: toFiniteNumber(row.runway_threshold_lon),
    runwayPhysicalThresholdLat: toFiniteNumber(row.runway_physical_threshold_lat),
    runwayPhysicalThresholdLon: toFiniteNumber(row.runway_physical_threshold_lon),
    runwayDisplacedThresholdFt: toFiniteNumber(row.runway_displaced_threshold_ft),
    lateralOffsetFt: lateralOffsetFt !== null ? Math.abs(lateralOffsetFt) : null,
    lateralOffsetSide:
      typeof row.lateral_offset_side === 'string' && row.lateral_offset_side
        ? row.lateral_offset_side
        : null,
    lateralOffsetSource: lateralOffsetFt !== null ? 'landing-row' : null,
    lateralOffsetSuspect: toBooleanOrNull(row.lateral_offset_suspect),
    runwayLengthFt,
    runwayWidthFt,
    bounceCount,
    bounceDistanceFt,
    bounceWorstGforce,
    firstTouchdown: hasFirstTouchdown ? firstTouchdown : null,
    finalTouchdown: hasFinalTouchdown ? finalTouchdown : null,
  };

  if (scoringMode === 'current-preview') {
    const touchdownScoring = distanceFt === null
      ? null
      : landingDistance.scoreTouchdownDistance(distanceFt, {
          runwayLengthFt: runwayLengthFt ?? undefined,
          surface: runwayCondition ?? undefined,
        });
    const lateralScoring = lateralOffsetFt === null
      ? null
      : landingDistance.scoreLateralOffset(
          lateralOffsetFt,
          runwayWidthFt !== null && runwayWidthFt > 0 ? runwayWidthFt : undefined,
        );
    const bounceScoring = bounceCount === null
      ? null
      : landingDistance.scoreBounce({
          bounceCount,
          firstTouchdown: {
            lat: firstTouchdown.lat,
            lon: firstTouchdown.lon,
            vs_fpm: firstTouchdown.vsFpm,
            gforce: firstTouchdown.gforce,
          },
          finalTouchdown: bounceCount > 0
            ? {
                lat: finalTouchdown.lat,
                lon: finalTouchdown.lon,
                vs_fpm: finalTouchdown.vsFpm,
                gforce: finalTouchdown.gforce,
              }
            : null,
          airborneDistanceFt: bounceDistanceFt,
          worstGforce: bounceWorstGforce,
        });

    return {
      ...common,
      score: touchdownScoring?.score ?? null,
      grade: touchdownScoring?.grade ?? null,
      zone: touchdownScoring?.zone ?? null,
      lateralOffsetGrade: lateralScoring?.grade ?? null,
      lateralOffsetScore: lateralScoring?.score ?? null,
      bounceGrade: bounceScoring?.grade ?? null,
      bounceScore: bounceScoring?.score ?? null,
    };
  }

  const bounceGrade = row.bounce_grade || null;
  const bounceScore = toFiniteNumber(row.bounce_score);
  if (distanceFt === null) {
    const hasAuthoritativeBounceData = [
      bounceCount,
      bounceGrade,
      bounceScore,
      bounceDistanceFt,
      bounceWorstGforce,
    ].some(value => value !== null);
    if (!hasAuthoritativeBounceData) return null;

    // Bounce scoring is independent of runway geometry in the live runner.
    // Preserve it even when runway lookup failed and no touchdown distance was
    // recorded; omitting null distance keys also protects any replay-derived
    // distance when this partial object is merged.
    return {
      bounceCount,
      bounceGrade,
      bounceScore,
      bounceDistanceFt,
      bounceWorstGforce,
    };
  }

  let score = toFiniteNumber(row.touchdown_distance_score);
  let grade = row.touchdown_distance_grade || null;
  const computed = landingDistance.scoreTouchdownDistance(distanceFt, {
    runwayLengthFt: runwayLengthFt ?? undefined,
    surface: runwayCondition ?? undefined,
  });
  if (score == null) score = computed.score;
  if (grade == null) grade = computed.grade;

  return {
    ...common,
    score,
    grade,
    zone: recordedZone ?? computed.zone,
    lateralOffsetGrade:
      typeof row.lateral_offset_grade === 'string' && row.lateral_offset_grade
        ? row.lateral_offset_grade
        : null,
    lateralOffsetScore: toFiniteNumber(row.lateral_offset_score),
    bounceGrade,
    bounceScore,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Timeline Generation
// ═══════════════════════════════════════════════════════════════════════════

function setAnalysisRescoreMetric(event: AnyRecord, name: string, metric: AnyRecord): void {
  event._analysisRescoreMetrics = {
    ...(event._analysisRescoreMetrics || {}),
    [name]: metric,
  };
}

function unavailableGeometryMetric(reason: string): AnyRecord {
  return {
    applicable: false,
    available: true,
    source: 'unavailable',
    reason,
  };
}

const ANALYSIS_RESCORE_METRICS = Object.freeze([
  'landingRate',
  'stability',
  'touchdownDistance',
  'lateralOffset',
  'bounce',
  'rollout',
]);

function finalizeAnalysisRescore(
  generatedTimeline: GeneratedTimeline,
  scoringMode: 'recorded' | 'current-preview',
): void {
  const landingEvents = generatedTimeline.events.filter((event) => event?.type === 'landing');
  const landings = landingEvents.map((event) => {
    const metrics = { ...(event._analysisRescoreMetrics || {}) };
    if (scoringMode === 'recorded') {
      metrics.landingRate ??= {
        applicable: event.vs_fpm != null || event.grade != null,
        available: event.grade != null,
        source: 'recorded',
        reason: event.grade != null ? null : 'recorded_landing_rate_unavailable',
      };
      metrics.stability ??= {
        applicable: event.ultimateStability != null,
        available: event.ultimateStability != null,
        source: 'recorded',
        reason: event.ultimateStability != null ? null : 'recorded_stability_unavailable',
      };
      metrics.touchdownDistance ??= {
        applicable: event.touchdownDistance?.distanceFt != null,
        available: event.touchdownDistance?.score != null,
        source: 'recorded',
        reason: event.touchdownDistance?.score != null ? null : 'recorded_touchdown_geometry_unavailable',
      };
      metrics.lateralOffset ??= {
        applicable: event.touchdownDistance?.lateralOffsetFt != null,
        available: event.touchdownDistance?.lateralOffsetScore != null,
        source: 'recorded',
        reason: event.touchdownDistance?.lateralOffsetScore != null ? null : 'recorded_lateral_geometry_unavailable',
      };
      metrics.bounce ??= {
        applicable: event.touchdownDistance?.bounceCount != null || event.bounceCount != null,
        available: event.touchdownDistance?.bounceGrade != null,
        source: 'recorded',
        reason: event.touchdownDistance?.bounceGrade != null ? null : 'recorded_bounce_evidence_unavailable',
      };
      metrics.rollout ??= {
        applicable: event.rolloutAnalysis != null,
        available: event.rolloutAnalysis != null,
        source: 'recorded',
        reason: event.rolloutAnalysis != null ? null : 'recorded_rollout_unavailable',
      };
    } else {
      metrics.stability ??= {
        applicable: true,
        available: toFiniteNumber(event.ultimateStability?.score) !== null,
        source: toFiniteNumber(event.ultimateStability?.score) !== null ? 'reconstructed' : 'unavailable',
        reason: toFiniteNumber(event.ultimateStability?.score) !== null
          ? null
          : 'finalized_landing_row_unavailable',
      };
      for (const name of ANALYSIS_RESCORE_METRICS) {
        metrics[name] ??= {
          applicable: true,
          available: false,
          source: 'unavailable',
          reason: 'finalized_landing_row_unavailable',
        };
      }
    }

    const reasons: string[] = [];
    if (scoringMode === 'current-preview' && event._landingRowMerged !== true) {
      reasons.push('finalized_landing_row_unavailable');
    }
    if (scoringMode === 'current-preview' && !event.landingKey) {
      reasons.push('landing_key_unavailable');
    }
    for (const name of ANALYSIS_RESCORE_METRICS) {
      const metric = metrics[name];
      if (metric?.applicable !== false && metric?.available !== true && metric?.reason) {
        reasons.push(String(metric.reason));
      }
    }
    const uniqueReasons = [...new Set(reasons)];
    const available = scoringMode === 'recorded' || uniqueReasons.length === 0;

    delete event._analysisReplayStabilitySamples;
    delete event._analysisRescoreMetrics;
    delete event._analysisRescoreProfileId;

    return {
      landingKey: typeof event.landingKey === 'string' ? event.landingKey : null,
      timestampMs: toFiniteNumber(event.timestampMs),
      profileId: toNonEmptyString(event.aircraftProfileId) || 'generic',
      available,
      reasons: uniqueReasons,
      metrics,
    };
  });

  generatedTimeline.analysisRescore = {
    mode: scoringMode,
    scope: CURRENT_ANALYSIS_RESCORE_CONTRACT.scope,
    contract: { ...CURRENT_ANALYSIS_RESCORE_CONTRACT },
    persistedDataModified: false,
    complete: scoringMode === 'recorded' || landings.every((landing) => landing.available === true),
    landingCount: landings.length,
    landings,
  };
}

/**
 * Attach touchdown-to-rollout-track diagnostics when enough GPS data exists.
 * The fitted aircraft path has no independent runway-position reference, so it
 * must never replace an absolute lateral offset or its score.
 */
function attachRolloutLateralDiagnostics(
  generatedTimeline: GeneratedTimeline,
  rows: CsvRow[],
  scoringMode: 'recorded' | 'current-preview' = 'recorded',
) {
  const ROLLOUT_WINDOW_MS = 20000;
  const ROLLOUT_MIN_IAS_KTS = 40;

  for (const event of generatedTimeline.events) {
    if (event.type !== 'landing') continue;
    if (!event.touchdownDistance) continue;
    // Current-rules rescore treats the LANDING-row offset as an immutable
    // geometric observation. Re-fitting it from rollout coordinates would be a
    // new detection/reanalysis, not a score recomputation.
    if (scoringMode === 'current-preview') continue;
    if (
      event.touchdownDistance.lateralOffsetSource === 'landing-row'
      && event.touchdownDistance.lateralOffsetSuspect !== true
    ) {
      continue;
    }
    const rwyHeading = getRunwayTrueHeadingDeg(event.runway);
    if (rwyHeading == null) continue;
    if (!Number.isFinite(event.lat) || !Number.isFinite(event.lon)) continue;

    const rolloutSamples = [];
    for (const row of rows) {
      const rowTs = getRowTimestampMs(row);
      if (!Number.isFinite(rowTs)) continue;
      const dt = rowTs - event.timestampMs;
      if (dt < 0 || dt > ROLLOUT_WINDOW_MS) continue;
      if (toBooleanOrNull(row.on_ground) !== true) continue;
      const ias = toFiniteNumber(row.ias_kts);
      if (ias == null || ias < ROLLOUT_MIN_IAS_KTS) continue;
      const lat = toFiniteNumber(row.lat_deg);
      const lon = toFiniteNumber(row.lon_deg);
      if (!isValidCoordinate(lat, lon)) continue;
      rolloutSamples.push({ lat, lon });
    }

    if (rolloutSamples.length < 5) continue;

    const rolloutRelative = landingDistance.calculateTouchdownOffsetFromRolloutTrack(
      { lat: event.lat, lon: event.lon },
      rolloutSamples,
      rwyHeading,
    );

    if (rolloutRelative.offsetFt == null) continue;

    const dbOffsetFt = event.touchdownDistance.lateralOffsetFt;
    const dbOffsetSide = event.touchdownDistance.lateralOffsetSide;
    if (dbOffsetFt != null && !event.touchdownDistance.lateralOffsetSource) {
      event.touchdownDistance.lateralOffsetSource = 'runway-geometry';
    }
    event.touchdownDistance.lateralOffsetCalibration = {
      method: 'rollout-relative',
      sampleCount: rolloutRelative.sampleCount,
      alongTrackFt: rolloutRelative.alongTrackFt,
      empiricalHeadingDeg: rolloutRelative.headingDeg,
      rolloutRelativeOffsetFt: Math.abs(rolloutRelative.offsetFt),
      rolloutRelativeOffsetSide: rolloutRelative.side,
      databaseOffsetFt: dbOffsetFt,
      databaseOffsetSide: dbOffsetSide,
      absoluteOffsetPreserved: true,
    };
  }
}

/**
 * Generate a timeline from a CSV file.
 * @param {string} csvPath - Path to the CSV file
 * @param {Object} options - Generation options
 * @returns {{ success: boolean, timeline?: Object, error?: string }}
 */
async function generateFromCSVInProcess(csvPath: string, _options: AnyRecord = {}): Promise<TimelineResult> {
  const { headers, rows, fileSizeBytes: csvSizeBytes, sha256: csvSha256, error } = await parseCSV(
    csvPath,
    { sparseRows: true },
  );

  if (error) {
    return { success: false, error };
  }

  if (rows.length === 0) {
    return { success: false, error: 'No data rows in CSV' };
  }

  const options = { ..._options };
  const strictBundle = headers.includes('recording_session_id') || isRecordingManifestRow(rows[0]);
  const bundleStatusRequired = rows[0]?.bundle_status_required === true
    || rows[0]?.bundle_status_required === 1
    || rows[0]?.bundle_status_required === '1';
  const csvIdentity = {
    flightId: String(rows[0]?.flight_id || ''),
    flightStartIso: String(rows[0]?.flight_start_iso || ''),
    recordingSessionId: rows[0]?.recording_session_id == null
      ? null
      : String(rows[0].recording_session_id),
    strictBundle,
  };
  let automationSidecar = options.automationSidecar;

  if (strictBundle) {
    // Read sequentially so the largest retained sidecar cannot overlap with
    // another sidecar's transient parser state.
    const diskAutomationSidecar = await readAutomationRowsForCsv(csvPath, { csvIdentity });
    if (diskAutomationSidecar.error) {
      return { success: false, error: diskAutomationSidecar.error };
    }
    if (diskAutomationSidecar.exists !== true || diskAutomationSidecar.rows.length === 0) {
      return { success: false, error: 'Recording bundle is missing its committed automation identity manifest.' };
    }
    // Timeline only consumes the aircraft-specific manifest. The reader still
    // streams, validates, and hashes every committed row.
    const aircraftSpecificSidecar = await readAircraftSpecificRowsForCsv(csvPath, {
      csvIdentity,
      retainRows: 1,
    });
    if (aircraftSpecificSidecar.error) {
      return { success: false, error: aircraftSpecificSidecar.error };
    }
    if (!aircraftSpecificSidecar.exists || aircraftSpecificSidecar.rows.length === 0) {
      return { success: false, error: 'Recording bundle is missing its committed aircraft-specific identity manifest.' };
    }

    const csvManifest = rows[0];
    const expectedEnvelope = {
      flightId: String(csvManifest.flight_id || ''),
      recordingSessionId: String(csvManifest.recording_session_id || ''),
      flightStartIso: String(csvManifest.flight_start_iso || ''),
    };
    for (const [label, manifest] of [
      ['Automation', diskAutomationSidecar.rows[0]],
      ['Aircraft-specific', aircraftSpecificSidecar.rows[0]],
    ] as Array<[string, AnyRecord]>) {
      if (
        manifest.flightId !== expectedEnvelope.flightId
        || manifest.recordingSessionId !== expectedEnvelope.recordingSessionId
        || manifest.flightStartIso !== expectedEnvelope.flightStartIso
      ) {
        return { success: false, error: `${label} sidecar recording identity does not match the parsed CSV.` };
      }
    }
    for (const [label, manifest] of [
      ['Automation', diskAutomationSidecar.rows[0]],
      ['Aircraft-specific', aircraftSpecificSidecar.rows[0]],
    ] as Array<[string, AnyRecord]>) {
      const sidecarStatusRequired = manifest.bundleStatusRequired === true;
      if (sidecarStatusRequired !== bundleStatusRequired) {
        return { success: false, error: `${label} sidecar durable bundle-status requirement does not match the CSV.` };
      }
    }
    if (bundleStatusRequired) {
      if (
        !Number.isSafeInteger(csvSizeBytes)
        || typeof csvSha256 !== 'string'
        || !Number.isSafeInteger(diskAutomationSidecar.fileSizeBytes)
        || typeof diskAutomationSidecar.sha256 !== 'string'
        || !Number.isSafeInteger(aircraftSpecificSidecar.fileSizeBytes)
        || typeof aircraftSpecificSidecar.sha256 !== 'string'
      ) {
        return { success: false, error: 'Recording bundle could not produce complete artifact digests.' };
      }
      const expectedIdentity = {
        ...expectedEnvelope,
        recordingStartEpochMs: Date.parse(expectedEnvelope.flightStartIso),
        recordingStartIso: expectedEnvelope.flightStartIso,
      };
      const completion = readRecordingBundleStatusSync(csvPath, {
        expectedIdentity,
        artifacts: {
          csv: {
            fileName: path.basename(csvPath),
            sizeBytes: csvSizeBytes,
            sha256: csvSha256,
            identity: { ...expectedIdentity, bundleStatusRequired: true },
          },
          automation: {
            fileName: path.basename(diskAutomationSidecar.filePath),
            sizeBytes: diskAutomationSidecar.fileSizeBytes,
            sha256: diskAutomationSidecar.sha256,
            identity: { ...expectedIdentity, bundleStatusRequired: true },
          },
          aircraftSpecific: {
            fileName: path.basename(aircraftSpecificSidecar.filePath),
            sizeBytes: aircraftSpecificSidecar.fileSizeBytes,
            sha256: aircraftSpecificSidecar.sha256,
            identity: { ...expectedIdentity, bundleStatusRequired: true },
          },
        },
      });
      if (!completion.healthy) {
        return { success: false, error: completion.error || 'Recording bundle is not durably complete.' };
      }
    }
    automationSidecar = diskAutomationSidecar;
  } else if (
    options.includeAutomation !== false
    && !Array.isArray(options.automationRows)
    && !automationSidecar
  ) {
    automationSidecar = await readAutomationRowsForCsv(csvPath, { csvIdentity });
  }

  if (options.includeAutomation !== false && !Array.isArray(options.automationRows)) {
    options.automationSidecar = automationSidecar;
  }

  const timelineRows = rows.filter((row) => (
    String(row?.record_type || '').trim().toUpperCase() !== 'RECORDING_MANIFEST'
  ));
  if (timelineRows.length === 0) {
    return { success: false, error: 'CSV has no flight telemetry or event rows' };
  }

  return generateTimelineFromRows(csvPath, timelineRows, options);
}

const TIMELINE_WORKER_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_QUEUED_TIMELINE_WORKERS = 2;
let queuedTimelineWorkerCount = 0;
let timelineWorkerTail: Promise<void> = Promise.resolve();

function runTimelineWorker(csvPath: string, options: AnyRecord): Promise<TimelineResult> {
  return new Promise((resolve) => {
    let settled = false;
    let worker: import('node:worker_threads').Worker;
    let timeout: NodeJS.Timeout | null = null;

    const finish = (result: TimelineResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };

    try {
      worker = new Worker(path.join(__dirname, 'timeline-generation-worker.js'), {
        workerData: { csvPath, options },
        resourceLimits: {
          maxOldGenerationSizeMb: 384,
          maxYoungGenerationSizeMb: 32,
          codeRangeSizeMb: 32,
          stackSizeMb: 8,
        },
      });
    } catch {
      resolve({
        success: false,
        error: 'Timeline could not start its isolated processing worker.',
      });
      return;
    }

    timeout = setTimeout(() => {
      void worker.terminate();
      finish({
        success: false,
        error: 'Timeline processing exceeded its safe time limit.',
      });
    }, TIMELINE_WORKER_TIMEOUT_MS);

    worker.once('message', (message: unknown) => {
      const result = message as TimelineResult;
      if (
        !result
        || typeof result !== 'object'
        || typeof (result as { success?: unknown }).success !== 'boolean'
      ) {
        finish({
          success: false,
          error: 'Timeline worker returned an invalid result.',
        });
        void worker.terminate();
        return;
      }
      finish(result);
      void worker.terminate();
    });
    worker.once('error', () => {
      finish({
        success: false,
        error: 'Timeline processing exceeded its safe resource limits.',
      });
    });
    worker.once('exit', (code) => {
      if (!settled && code !== 0) {
        finish({
          success: false,
          error: 'Timeline processing stopped at its safe resource boundary.',
        });
      }
    });
  });
}

async function generateFromCSVIsolated(
  csvPath: string,
  options: AnyRecord = {},
): Promise<TimelineResult> {
  if (queuedTimelineWorkerCount >= MAX_QUEUED_TIMELINE_WORKERS) {
    return {
      success: false,
      error: 'Timeline processing is already busy. Please retry after the current recording finishes.',
    };
  }

  queuedTimelineWorkerCount += 1;
  const scheduled = timelineWorkerTail.then(() => runTimelineWorker(csvPath, options));
  timelineWorkerTail = scheduled.then(() => undefined, () => undefined);
  try {
    return await scheduled;
  } finally {
    queuedTimelineWorkerCount -= 1;
  }
}

/**
 * Attach a ground-roll control assessment to each landing without changing the
 * approach stability score. Current persisted live analysis wins because it
 * uses the provider's full-precision coordinates; older analysis versions are
 * reconstructed from SAMPLE rows so policy corrections apply to prior flights.
 */
function applyRolloutAnalysis(
  generatedTimeline: GeneratedTimeline,
  rows: CsvRow[],
  scoringMode: 'recorded' | 'current-preview' = 'recorded',
) {
  for (const event of generatedTimeline.events) {
    if (event.type !== 'landing') continue;
    const persistedSchemaVersion = toFiniteNumber(event.rolloutAnalysis?.schemaVersion);
    if (scoringMode === 'current-preview') {
      // A preview is a clean current-rules reconstruction. Persisted schema-v2
      // assessments are comparison inputs only and must never win this path.
      event.rolloutAnalysis = null;
    } else if (event.rolloutAnalysis && persistedSchemaVersion != null && persistedSchemaVersion >= 2) {
      continue;
    }
    const touchdownTimestampMs = toFiniteNumber(event.timestampMs);
    if (touchdownTimestampMs == null) {
      if (scoringMode === 'current-preview') {
        setAnalysisRescoreMetric(event, 'rollout', {
          applicable: true,
          available: false,
          source: 'unavailable',
          reason: 'touchdown_timestamp_unavailable',
        });
      }
      continue;
    }

    const rolloutRows: CsvRow[] = [];
    let sawOnRunway = false;
    for (const row of rows) {
      const recordType = String(row?.record_type || 'SAMPLE').trim().toUpperCase() || 'SAMPLE';
      if (recordType !== 'SAMPLE') continue;
      const rowTimestampMs = getRowTimestampMs(row);
      if (!Number.isFinite(rowTimestampMs)) continue;
      const deltaMs = rowTimestampMs - touchdownTimestampMs;
      if (deltaMs < 0) continue;
      if (deltaMs > ROLLOUT_ANALYSIS_LIMITS.maxWindowMs) break;

      const onGround = toBooleanOrNull(row.on_ground);
      if (onGround !== true) continue;
      const onRunway = toBooleanOrNull(row.surface_on_runway);
      if (onRunway === true) sawOnRunway = true;
      if (sawOnRunway && onRunway === false) break;

      rolloutRows.push({
        timestampMs: rowTimestampMs,
        onGround: true,
        paused: toBooleanOrNull(row.sim_paused) === true || toBooleanOrNull(row.sim_in_menu) === true,
        phase: row.phase ?? row.flight_phase_hint ?? null,
        gsKts: toFiniteNumber(row.gs_kts),
        bankDeg: toFiniteNumber(row.bank_deg),
        rollRateRadS: toFiniteNumber(row.roll_rate_rad_s),
        headingTrueDeg: toFiniteNumber(row.hdg_true_deg),
        lat: toFiniteNumber(row.lat_deg),
        lon: toFiniteNumber(row.lon_deg),
        aircraftProfileId: row.aircraft_profile_id ?? null,
      });
      if (rolloutRows.length >= ROLLOUT_ANALYSIS_LIMITS.maxSamples) break;
    }

    const runwayHeadingTrueDeg = event.touchdownDistance?.runwayHeadingTrueDeg
      ?? getRunwayTrueHeadingDeg(event.runway);
    const runwayThreshold = (
      Number.isFinite(event.touchdownDistance?.runwayThresholdLat)
      && Number.isFinite(event.touchdownDistance?.runwayThresholdLon)
    )
      ? {
          lat: event.touchdownDistance.runwayThresholdLat,
          lon: event.touchdownDistance.runwayThresholdLon,
        }
      : event.runway?.threshold;
    const coordinatePrecisionDigits = inferCoordinatePrecisionDigits(rolloutRows);
    const configuredTaxiInMaxKts = toFiniteNumber(config.phaseThresholds?.taxiInMaxKts);
    const profileId = event.aircraftProfileId
      ?? rolloutRows.find((row) => row.aircraftProfileId)?.aircraftProfileId
      ?? null;
    let replayProfile = null;
    try {
      replayProfile = profileLoader.loadProfile(profileId || 'generic');
    } catch (_error) {}
    if (scoringMode === 'current-preview' && !replayProfile) {
      setAnalysisRescoreMetric(event, 'rollout', {
        applicable: true,
        available: false,
        source: 'unavailable',
        reason: 'recorded_profile_unavailable',
      });
      continue;
    }
    const profileTaxiInMaxKts = toFiniteNumber(
      replayProfile?.aircraft?.phaseThresholds?.taxiInMaxKts,
    );
    const categoryTaxiInMaxKts = toFiniteNumber(
      getCategoryThresholds(replayProfile?.aircraft?.category)?.taxi_in_max_kts,
    );
    const taxiInMaxKts = configuredTaxiInMaxKts
      ?? profileTaxiInMaxKts
      ?? categoryTaxiInMaxKts;
    const analysis = analyzeRollout(rolloutRows, {
      taxiInMaxKts,
      runwayHeadingTrueDeg,
      runwayThreshold,
      runwayWidthFt: event.touchdownDistance?.runwayWidthFt ?? event.runway?.width_ft,
      runwayExcursion: event.runwayExcursion,
      coordinatePrecisionDigits,
      source: 'replay',
    });
    if (analysis) event.rolloutAnalysis = analysis;
    if (scoringMode === 'current-preview') {
      setAnalysisRescoreMetric(event, 'rollout', {
        applicable: true,
        available: analysis !== null,
        source: analysis ? 'reconstructed' : 'unavailable',
        reason: analysis ? null : 'rollout_samples_unavailable',
      });
    }
  }
}

async function generateFromCSV(csvPath: string, options: AnyRecord = {}): Promise<TimelineResult> {
  if (config.env?.isPackaged && isMainThread) {
    return generateFromCSVIsolated(csvPath, options);
  }
  return generateFromCSVInProcess(csvPath, options);
}

function generateTimelineFromRows(csvPath: string, rows: CsvRow[], _options: AnyRecord = {}): TimelineResult {

  const firstRow = rows[0];
  const lastRow = rows[rows.length - 1];
  const startTimestampMs = getRowTimestampMs(firstRow);
  const analysisRescoreMode: 'recorded' | 'current-preview' = _options?.scoringMode === 'current-preview'
    ? 'current-preview'
    : 'recorded';

  const generatedTimeline = createInitialTimeline(csvPath, rows);
  generatedTimeline.analysisRescore = {
    mode: analysisRescoreMode,
    scope: CURRENT_ANALYSIS_RESCORE_CONTRACT.scope,
    contract: { ...CURRENT_ANALYSIS_RESCORE_CONTRACT },
    persistedDataModified: false,
    complete: analysisRescoreMode === 'recorded',
    landingCount: 0,
    landings: [],
  };
  // State tracking
  let currentPhase = null;
  let lastRA = null;
  let lastTimestampMs = null;
  const crossedAltitudes = new Set();
  let wasOnGround = true;
  let touchdownCount = 0;
  let lastTouchdownTs = null;
  let lastAcceptedTouchdownTimestampMs = null;
  let maxRaFtSinceAirborne = 0;
  let lastGroundAltitudeFt: number | null = null;
  let lastGroundRadioHeightFt: number | null = null;
  let replayBounceCandidate: ReplayBounceCandidate | null = null;
  let pendingReplayBounceConfirmation: PendingReplayBounceConfirmation | null = null;
  let replayTouchdownRearmed = true;
  let activeReplayLandingEvent: AnyRecord | null = null;
  let flightEnded = false; // Track if we've seen a crash/flight end
  let lastTrackPoint = null;
  let lastValidCoordinates = null;
  let lastReplayFlapState: ReplayFlapState | null = null;
  let pendingReplayFlapChange: PendingReplayFlapChange | null = null;
  const replayFlapProfileCache = new Map<string, AnyRecord | null>();
  
  // Track active violations (to emit start/end pairs, not spam)
  const activeViolations = new Map<string, ViolationState>(); // ruleId → { startTs, startElapsed, startMetrics }
  let highSinkRateState: HighSinkRateState | null = null;
  
  // Approach profile reconstruction: collect telemetry samples during descent
  // for the approach-profile SVG diagram. Capped then downsampled to 120 pts.
  const MAX_APPROACH_SAMPLES = 3000; // raw limit before downsample
  let approachSamples = [];

  // Retrospective stability scorer for the *current* approach. LANDING rows now
  // carry live current-approach scores when the recorder completes normally, but
  // this replay scorer remains the compatibility path for older recordings and
  // incomplete logs. Persisted LANDING values take precedence in the merge below.
  //
  // Future cleanup: once enough real CSVs prove LANDING rows reliably contain
  // complete ultimate_stability_* data, keep this only as a legacy fallback or
  // delete it after migration/contract tests prove safe.
  const stabilityScorer = new SimpleStabilityScorer();
  let lastSampleTimestampMs = null;
  let pausedOrMenuStartTimestampMs = null;
  let pausedOrMenuAccumulatedMs = 0;
  
  // Phases that are NOT actual flight phases (should not trigger phase_start events)
  const NON_FLIGHT_PHASES = new Set(['OVERSPEED', 'STALL', 'OVERSPEED_END', 'STALL_END', 'CRASH']);
  
  // Process each row
  for (let i = 0; i < rows.length; i++) {
    if (generatedTimeline.events.length > MAX_GENERATED_TIMELINE_EVENTS) {
      return {
        success: false,
        error: 'Timeline contains more events than Flight Fabric can process safely.',
      };
    }
    const row = rows[i];
    const timestampMs = getRowTimestampMs(row);
    const rawElapsed = toFiniteNumber(row.flight_elapsed_ms);
    const elapsed = getRowElapsedMs(row, startTimestampMs);

    const rowLat = toFiniteNumber(row.lat_deg);
    const rowLon = toFiniteNumber(row.lon_deg);
    if (isValidCoordinate(rowLat, rowLon)) {
      lastValidCoordinates = { lat: rowLat, lon: rowLon };
      lastTrackPoint = appendTrackPointIfDue({
        timeline: generatedTimeline,
        row,
        timestampMs,
        elapsedMs: elapsed,
        rowIndex: i,
        rowCount: rows.length,
        lastTrackPoint,
      });
    }

    const eventCoordinates = resolveEventCoordinates(row, lastValidCoordinates);
    
    // Detect respawn/teleport: large timestamp gap (>30s) or position jump
    // After respawn, reset state to prevent spurious events
    if (lastTimestampMs != null && (timestampMs - lastTimestampMs) > RESPAWN_GAP_MS) {
      // Large gap - likely respawn or session resume
      wasOnGround = true;
      crossedAltitudes.clear();
      lastRA = null;
      approachSamples = [];
      stabilityScorer.reset();
      lastSampleTimestampMs = null;
      pausedOrMenuStartTimestampMs = null;
      pausedOrMenuAccumulatedMs = 0;
      lastTouchdownTs = null;
      lastAcceptedTouchdownTimestampMs = null;
      maxRaFtSinceAirborne = 0;
      lastGroundAltitudeFt = null;
      lastGroundRadioHeightFt = null;
      replayBounceCandidate = null;
      pendingReplayBounceConfirmation = null;
      replayTouchdownRearmed = true;
      activeReplayLandingEvent = null;
      // Preserve terminal crash state, but an ordinary telemetry gap starts a
      // fresh analyzable segment rather than ending the entire replay.
      lastReplayFlapState = null;
      pendingReplayFlapChange = null;
    }
    lastTimestampMs = timestampMs;
    
    // Skip processing after crash/respawn (data is unreliable)
    const recordType = row.record_type;
    const pausedOrMenu = isPausedOrMenuRow(row);
    if (pausedOrMenu) {
      pendingReplayFlapChange = null;
      if (pausedOrMenuStartTimestampMs === null && Number.isFinite(timestampMs)) {
        pausedOrMenuStartTimestampMs = timestampMs;
      }
    } else if (pausedOrMenuStartTimestampMs !== null && Number.isFinite(timestampMs)) {
      pausedOrMenuAccumulatedMs += Math.max(0, timestampMs - pausedOrMenuStartTimestampMs);
      pausedOrMenuStartTimestampMs = null;
    }
    if (recordType === 'CRASH') {
      flightEnded = true;
      replayBounceCandidate = null;
      pendingReplayBounceConfirmation = null;
      replayTouchdownRearmed = true;
      activeReplayLandingEvent = null;
      lastReplayFlapState = null;
      pendingReplayFlapChange = null;
      generatedTimeline.events.push({
        type: 'crash',
        timestampMs,
        elapsedMs: elapsed,
        lat: eventCoordinates.lat,
        lon: eventCoordinates.lon,
        ias_kts: row.ias_kts,
        vs_fpm: row.vs_fpm,
      });
      continue;
    }

    // Configuration changes are confirmed only after the destination has held
    // steady. This collapses lever travel and surface noise into one useful row.
    if (!pausedOrMenu && !flightEnded && (!recordType || recordType === 'SAMPLE')) {
      const flapState = resolveReplayFlapState(row, replayFlapProfileCache);
      if (flapState) {
        if (!lastReplayFlapState || lastReplayFlapState.profileKey !== flapState.profileKey ||
            lastReplayFlapState.kind !== flapState.kind) {
          lastReplayFlapState = flapState;
          pendingReplayFlapChange = null;
        } else if (lastReplayFlapState.notchIndex === flapState.notchIndex ||
                   (flapState.kind === 'percent' &&
                    Math.abs(lastReplayFlapState.notchIndex - flapState.notchIndex) < REPLAY_FLAP_PERCENT_MIN_CHANGE)) {
          // Repeated samples are expected. They establish the baseline without
          // producing duplicate rows and cancel a transient candidate that fell
          // back to the last confirmed detent.
          pendingReplayFlapChange = null;
        } else if (pendingReplayFlapChange?.state.profileKey === flapState.profileKey &&
                   pendingReplayFlapChange.state.kind === flapState.kind &&
                   pendingReplayFlapChange.state.notchIndex === flapState.notchIndex) {
          pendingReplayFlapChange.observationCount += 1;
          const settledForMs = timestampMs - pendingReplayFlapChange.timestampMs;
          const requiredSettleMs = flapState.kind === 'percent'
            ? REPLAY_FLAP_PERCENT_SETTLE_MS
            : REPLAY_FLAP_SETTLE_MS;
          if (pendingReplayFlapChange.observationCount >= 2 && settledForMs >= requiredSettleMs) {
            generatedTimeline.events.push(buildReplayFlapChangeEvent(
              lastReplayFlapState,
              pendingReplayFlapChange.state,
              pendingReplayFlapChange.row,
              pendingReplayFlapChange.timestampMs,
              pendingReplayFlapChange.elapsedMs,
              pendingReplayFlapChange.coordinates,
            ));
            lastReplayFlapState = pendingReplayFlapChange.state;
            pendingReplayFlapChange = null;
          }
        } else {
          // A new detent must be present in two consecutive eligible samples.
          // Store the first observation so the confirmed event keeps the actual
          // change time rather than the later confirmation time.
          pendingReplayFlapChange = {
            state: flapState,
            observationCount: 1,
            row,
            timestampMs,
            elapsedMs: elapsed,
            coordinates: eventCoordinates,
          };
        }
      } else {
        pendingReplayFlapChange = null;
      }

    }
    
    // Phase transitions (skip OVERSPEED/STALL - those are warnings, not phases)
    // Also skip EVENT rows (record_type !== 'SAMPLE') - their phase column is the event type, not FSM phase
    // This includes LANDING, GO_AROUND, etc. event records
    const isEventRow = recordType && recordType !== 'SAMPLE';
    if (!pausedOrMenu && row.phase && row.phase !== currentPhase && !NON_FLIGHT_PHASES.has(row.phase) && !isEventRow) {
      generatedTimeline.events.push({
        type: 'phase_start',
        timestampMs,
        elapsedMs: elapsed,
        newPhase: row.phase,
        previousPhase: currentPhase,
        lat: eventCoordinates.lat,
        lon: eventCoordinates.lon,
      });
      currentPhase = row.phase;
    }
    
    // Altitude markers (only during descent, RA decreasing)
    // Skip if RA is 0 (invalid/ground) or if flight has ended (post-crash noise)
    const ra = row.ra_ft;
    if (!pausedOrMenu && ra !== null && ra !== undefined && ra > 0 && lastRA !== null && lastRA > 0 && !flightEnded) {
      for (const { altitudeFt, markerType } of ALTITUDE_MARKERS) {
        // Crossing from above to below
        if (lastRA > altitudeFt && ra <= altitudeFt && !crossedAltitudes.has(markerType)) {
          crossedAltitudes.add(markerType);
          generatedTimeline.events.push({
            type: 'marker',
            timestampMs,
            elapsedMs: elapsed,
            markerType,
            lat: eventCoordinates.lat,
            lon: eventCoordinates.lon,
            context: {
              ra: ra,
            },
          });
        }
      }
    }
    if (!pausedOrMenu && ra !== null && ra > 0) {
      lastRA = ra;
    }
    
    // Reset altitude markers on climb (RA increasing significantly)
    if (!pausedOrMenu && ra > APPROACH_CEILING_FT) {
      crossedAltitudes.clear();
    }

    const onGround = toBooleanOrNull(row.on_ground);
    if (!pausedOrMenu && onGround === false && wasOnGround !== false) {
      maxRaFtSinceAirborne = 0;
    }
    if (!pausedOrMenu && onGround === false && Number.isFinite(ra) && ra > maxRaFtSinceAirborne) {
      maxRaFtSinceAirborne = ra;
    }
    const isTelemetrySample = !recordType || recordType === 'SAMPLE';

    if (
      pendingReplayBounceConfirmation
      && !pausedOrMenu
      && !flightEnded
      && isTelemetrySample
    ) {
      const pending = pendingReplayBounceConfirmation;
      const confirmationAgeMs = elapsed - pending.touchdownElapsedMs;
      if (onGround === false) {
        // Match the live runner: once another airborne segment starts, its
        // eventual load peak cannot retroactively confirm the prior contact.
        pendingReplayBounceConfirmation = null;
      } else if (onGround === true && confirmationAgeMs >= 0) {
        const measuredLoadG = toFiniteNumber(row.g_force);
        if (
          measuredLoadG !== null
          && measuredLoadG > 0
          && measuredLoadG <= 10
          && (pending.impactLoadG === null || measuredLoadG > pending.impactLoadG)
        ) {
          pending.impactLoadG = measuredLoadG;
        }
        const delayedAssessment = assessReplayBounceCandidate(pending.candidate, row, {
          impactVsFpm: pending.impactVsFpm,
          impactLoadG: pending.impactLoadG,
          airborneDurationMs: pending.airborneDurationMs,
        });
        if (
          confirmationAgeMs <= REPLAY_BOUNCE_POST_IMPACT_CONFIRMATION_MS
          && delayedAssessment.confirmed === true
        ) {
          if (applyConfirmedReplayBounce(activeReplayLandingEvent, delayedAssessment)) {
            touchdownCount++;
            lastTouchdownTs = pending.touchdownElapsedMs;
          }
          pendingReplayBounceConfirmation = null;
        } else if (confirmationAgeMs >= REPLAY_BOUNCE_POST_IMPACT_CONFIRMATION_MS) {
          pendingReplayBounceConfirmation = null;
        }
      } else if (confirmationAgeMs >= REPLAY_BOUNCE_POST_IMPACT_CONFIRMATION_MS) {
        pendingReplayBounceConfirmation = null;
      }
    }

    const isRawBounceAirborneSegment = !pausedOrMenu
      && !flightEnded
      && isTelemetrySample
      && onGround === false
      && activeReplayLandingEvent !== null
      && lastTouchdownTs !== null
      && replayTouchdownRearmed === false;
    if (isRawBounceAirborneSegment) {
      if (!replayBounceCandidate) {
        replayBounceCandidate = {
          startedElapsedMs: elapsed,
          baselineAltitudeFt: lastGroundAltitudeFt,
          baselineRadioHeightFt: lastGroundRadioHeightFt,
          peakAltitudeFt: null,
          peakRadioHeightFt: null,
          maxUpwardVsFpm: null,
          lastAirborneVsFpm: null,
        };
      }
      updateReplayBounceCandidate(replayBounceCandidate, row);
    }
    if (
      replayBounceCandidate
      && replayTouchdownRearmed === false
      && elapsed - replayBounceCandidate.startedElapsedMs >= REPLAY_TOUCHDOWN_REARM_MS
    ) {
      // The live runner re-arms only after a continuous airborne interval.
      // Once that interval elapses, the next contact owns a new attempt even
      // if it is still close to the previous touchdown in wall-clock time.
      replayTouchdownRearmed = true;
      replayBounceCandidate = null;
      pendingReplayBounceConfirmation = null;
    }
    
    // Accumulate approach profile samples when descending below ceiling
    // These are attached to landing events for the side-on approach diagram
    // Note: use row.vs_fpm directly — the block-scoped `const vs` is declared later
    if (shouldCollectApproachSample(row, ra, flightEnded, pausedOrMenu)) {
      const approachSample = buildApproachProfileSample(row, rawElapsed, timestampMs, pausedOrMenuAccumulatedMs);
      approachSamples.push(approachSample);
      // Keep a hard cap to avoid unbounded memory on long approaches
      if (approachSamples.length > MAX_APPROACH_SAMPLES) {
        approachSamples = approachSamples.slice(-MAX_APPROACH_SAMPLES);
      }

      // Feed the same row to the replay stability scorer. This preserves
      // historical stability for older CSVs and incomplete logs where the live
      // LANDING row does not contain a full ultimate_stability_* payload.
      const sampleTimestampMs = approachSample.tMs;
      const dtMs = lastSampleTimestampMs !== null && Number.isFinite(sampleTimestampMs)
        ? Math.max(0, sampleTimestampMs - lastSampleTimestampMs)
        : 100;
      const sample = frameToSample(csvRowToStabilityFrame(row, dtMs));
      if (sample) stabilityScorer.addSample(sample);
      lastSampleTimestampMs = sampleTimestampMs;
    }
    // Reset samples if climbing back above ceiling (go-around)
    if (!pausedOrMenu && ra !== null && ra > APPROACH_CEILING_FT && approachSamples.length > 0) {
      approachSamples = [];
      stabilityScorer.reset();
      lastSampleTimestampMs = null;
    }
    
    // Touchdown detection and landing analysis
    // Sanity checks: must have reasonable approach parameters
    // - IAS > 50 kts (not stopped/taxiing)
    // - IAS < 250 kts (not a crash at high speed respawn)
    // - VS < 0 (descending, not teleported to ground)
    // - Not after flight has ended (crash/respawn)
    const tdIas = toFiniteNumber(row.ias_kts) ?? 0;
    const vs = toFiniteNumber(row.vs_fpm) ?? 0;
    const isReasonableLanding = !pausedOrMenu && isTouchdownTransitionCandidate({
      wasOnGround,
      onGround,
      raFt: ra,
      iasKts: tdIas,
      vsFpm: vs,
      flightEnded,
      minIasKts: 50,
      maxIasKts: 250,
      maxRaFt: 50,
      requireDescent: true,
    }) && !isTakeoffSettlingTouchdown({
      lastAcceptedTouchdownMs: lastAcceptedTouchdownTimestampMs,
      peakRaFt: maxRaFtSinceAirborne,
      minAirborneRaFt: config.landing.touchdownMinAirborneRaFt,
    });
    
    if (isReasonableLanding) {
      // Bounce detection remains attached to the current landing attempt until
      // continuous airborne time reaches the live touchdown rearm threshold.
      // A bounce is part of the same landing sequence — do NOT create a separate timeline entry.
      // A second WOW contact is only a raw candidate. Match the live runner by
      // requiring corroborating motion/impact before changing the landing score.
      const isRawBounce = replayTouchdownRearmed === false
        && lastTouchdownTs !== null
        && activeReplayLandingEvent !== null;
      const contactCandidate = replayBounceCandidate;
      const bounceAssessment = isRawBounce && contactCandidate
        ? assessReplayBounceCandidate(contactCandidate, row, {
            airborneDurationMs: Math.max(0, elapsed - contactCandidate.startedElapsedMs),
          })
        : null;
      const isBounce = bounceAssessment?.confirmed === true;
      replayBounceCandidate = null;

      if (isBounce) {
        if (applyConfirmedReplayBounce(activeReplayLandingEvent, bounceAssessment)) {
          touchdownCount++;
          lastTouchdownTs = elapsed;
        }
        // Update the most recent landing event with bounce data instead of creating a new entry.
        // This mirrors how landing-runner.js handles bounces: same sequence, one timeline entry.
        // Do not reset approach samples — the approach is still the same sequence.
      } else if (isRawBounce && contactCandidate && bounceAssessment) {
        // The live runner waits briefly for a delayed impact-load SAMPLE after
        // the WOW transition; retain the same contact during replay.
        pendingReplayBounceConfirmation = {
          candidate: contactCandidate,
          touchdownElapsedMs: elapsed,
          airborneDurationMs: Math.max(0, elapsed - contactCandidate.startedElapsedMs),
          impactVsFpm: toFiniteNumber(bounceAssessment.impactVsFpm) ?? 0,
          impactLoadG: toFiniteNumber(bounceAssessment.impactLoadG),
        };
      } else if (!isRawBounce) {
        touchdownCount++;
        lastTouchdownTs = elapsed;
        const replayStabilityPolicy = getReplayStabilityPolicyFromRow(row);
        const touchdownLandingGrade = resolveReplayLandingGrade(
          row,
          null,
          analysisRescoreMode,
        );
        const touchdownHeadline = touchdownLandingGrade.headline;
        const replayStabilitySamples = captureReplayStabilitySamples(stabilityScorer);
        const touchdownResult = buildReplayLandingEvent({
          row: touchdownHeadline.vsFpm === toFiniteNumber(row.vs_fpm)
            ? row
            : { ...row, vs_fpm: touchdownHeadline.vsFpm },
          timestampMs,
          elapsedMs: elapsed,
          touchdownNumber: touchdownCount,
          eventCoordinates,
          approachSamples,
          stabilityScorer,
          stabilityCriteria: replayStabilityPolicy.criteria,
          stabilityPolicy: replayStabilityPolicy.policy,
          stabilityProfile: replayStabilityPolicy.profile,
          resolveGlidepathAngleForApproach,
          toFiniteNumber,
          computeGradeFromVs: getReplayImpactGradeFromVs(row),
          computeCenterlineDev: _computeCenterlineDev,
          downsampleApproachProfile,
          approachProfileMaxPoints: APPROACH_PROFILE_MAX_POINTS,
          dangerouslyLowApproachRaFt: DANGEROUSLY_LOW_APPROACH_RA_FT,
          flareExclusionDistanceFt: FLARE_EXCLUSION_DISTANCE_FT,
        });
        applyReplayLandingGrade(touchdownResult.landingEvent, touchdownLandingGrade);
        touchdownResult.landingEvent._analysisReplayStabilitySamples = replayStabilitySamples;

        generatedTimeline.events.push(touchdownResult.landingEvent);
        activeReplayLandingEvent = touchdownResult.landingEvent;
        replayTouchdownRearmed = false;
        pendingReplayBounceConfirmation = null;
        lastAcceptedTouchdownTimestampMs = timestampMs;
        generatedTimeline.events.push(...touchdownResult.retroactiveViolations);

        // Reset approach samples after touchdown (next approach starts fresh)
        approachSamples = [];
        stabilityScorer.reset();
        lastSampleTimestampMs = null;
      }
      // An uncorroborated raw contact is WOW chatter within the existing
      // landing sequence. Preserve the raw CSV, but do not create or score a
      // bounce and do not move the accepted touchdown anchor.
    }
    if (!isReasonableLanding && !pausedOrMenu && isTelemetrySample
        && wasOnGround === false && onGround === true) {
      // Even a recontact rejected by the touchdown sanity guard ends this raw
      // airborne segment. Do not let its evidence leak into a later WOW cycle.
      replayBounceCandidate = null;
    }
    if (!pausedOrMenu && !flightEnded && isTelemetrySample && onGround === true) {
      lastGroundAltitudeFt = toFiniteNumber(row.alt_plane_ft);
      lastGroundRadioHeightFt = toFiniteNumber(row.ra_ft);
    }
    if (!pausedOrMenu && onGround !== null) {
      wasOnGround = onGround;
    }
    
    // Stability violations (only during approach/final phases)
    // Track violations as start/end pairs, not spam on every row
    if (pausedOrMenu) {
      highSinkRateState = endHighSinkRateViolation(
        highSinkRateState,
        timestampMs,
        elapsed,
        generatedTimeline,
        eventCoordinates.lat,
        eventCoordinates.lon,
      );
      endAllViolations(timestampMs, elapsed, generatedTimeline, activeViolations, eventCoordinates.lat, eventCoordinates.lon);
    } else if (currentPhase && (currentPhase.includes('APPROACH') || currentPhase.includes('FINAL'))) {
      // Check each violation type and emit start/end events
      if (isTelemetrySample) {
        highSinkRateState = updateHighSinkRateViolation(
          highSinkRateState,
          toFiniteNumber(row.vs_fpm),
          timestampMs,
          elapsed,
          generatedTimeline,
          eventCoordinates.lat,
          eventCoordinates.lon,
        );
      }
      
      // MSFS documents NAV GSI as a +/-119 deflection but not its polarity, so
      // either direction uses the same severity threshold.
      const gsDevDots = plausibleIlsDeviationDots(row.gs_deviation_dots);
      const gsDevAbs = Number.isFinite(gsDevDots) ? Math.abs(gsDevDots) : 0;
      const gsDeviationAvailable = isGlideslopeDeviationRelevant(row) && Number.isFinite(gsDevDots);
      checkViolationCondition('GLIDESLOPE',
        gsDeviationAvailable && gsDevAbs > STABILITY_THRESHOLDS.GLIDESLOPE_DOTS,
        gsDevAbs > 2.0 ? 'warning' : 'caution',
        { value: gsDevDots, threshold: STABILITY_THRESHOLDS.GLIDESLOPE_DOTS, nav1_has_glideslope: row.nav1_has_glideslope ?? null, nav1_signal: row.nav1_signal ?? null },
        timestampMs, elapsed, generatedTimeline, activeViolations, eventCoordinates.lat, eventCoordinates.lon);
      
      const locDevDots = plausibleIlsDeviationDots(row.loc_deviation_dots);
      const locDevAbs = Number.isFinite(locDevDots) ? Math.abs(locDevDots) : 0;
      checkViolationCondition('LOCALIZER',
        isLocalizerDeviationRelevant(row) && locDevAbs > STABILITY_THRESHOLDS.LOCALIZER_DOTS,
        locDevAbs > 2 ? 'warning' : 'caution',
        { value: locDevDots, threshold: STABILITY_THRESHOLDS.LOCALIZER_DOTS, approach_type: row.approach_type ?? null, nav1_has_localizer: row.nav1_has_localizer ?? null, nav1_signal: row.nav1_signal ?? null },
        timestampMs, elapsed, generatedTimeline, activeViolations, eventCoordinates.lat, eventCoordinates.lon);
      
      checkViolationCondition('BANK_ANGLE',
        row.bank_deg !== null && Math.abs(row.bank_deg) > STABILITY_THRESHOLDS.BANK_MAX_DEG,
        Math.abs(row.bank_deg) > 30 ? 'warning' : 'caution',
        { value: row.bank_deg, threshold: STABILITY_THRESHOLDS.BANK_MAX_DEG },
        timestampMs, elapsed, generatedTimeline, activeViolations, eventCoordinates.lat, eventCoordinates.lon);

      // Steep path-rate proxy for visual/RNAV approaches: fires only when ILS
      // gs_deviation_dots is unavailable so it never doubles up with GLIDESLOPE.
      // Detects a sustained VS that is UNDERSHOOT_VS_DELTA_FPM (400 fpm) steeper
      // than the resolved glidepath rate for the current groundspeed. It detects
      // excess descent rate only and cannot establish position relative to a
      // published path or infer obstacle clearance.
      if (!gsDeviationAvailable && Number.isFinite(row.gs_kts) && row.gs_kts > 60 &&
          Number.isFinite(row.vs_fpm) && Number.isFinite(row.ra_ft) && row.ra_ft > 50) {
        const glidepathAngle = resolveGlidepathAngleForApproach({
          airportIcao: row.icao || row.airport_icao,
          runwayId: row.runway || row.runway_id,
        });
        const targetVsFpm = targetVerticalSpeedForGlidepath(row.gs_kts, glidepathAngle.angleDeg);
        // Negative means a descent rate steeper than the target. This check has
        // no positional path reference, despite the legacy event-key name.
        const vsDeficit = row.vs_fpm - targetVsFpm;
        checkViolationCondition('below_glidepath',
          vsDeficit < -STABILITY_THRESHOLDS.UNDERSHOOT_VS_DELTA_FPM,
          vsDeficit < -700 ? 'warning' : 'caution',
          {
            value: row.vs_fpm,
            target_fpm: Math.round(targetVsFpm),
            target_angle_deg: glidepathAngle.angleDeg,
            target_angle_source: glidepathAngle.source,
            deficit_fpm: Math.round(vsDeficit),
          },
          timestampMs, elapsed, generatedTimeline, activeViolations, eventCoordinates.lat, eventCoordinates.lon);
      }
    } else {
      // Not in approach/final - close any open violations
      highSinkRateState = endHighSinkRateViolation(
        highSinkRateState,
        timestampMs,
        elapsed,
        generatedTimeline,
        eventCoordinates.lat,
        eventCoordinates.lon,
      );
      endAllViolations(timestampMs, elapsed, generatedTimeline, activeViolations);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // CSV Event Records (OVERSPEED, STALL, GO_AROUND, etc.)
    // The CSV records event rows with record_type != 'SAMPLE' - process them here
    // recordType was declared earlier in the loop for CRASH handling
    // ═══════════════════════════════════════════════════════════════════════
    if (recordType && recordType !== 'SAMPLE' && recordType !== 'CRASH') {
      if (recordType === 'FLIGHT_VIOLATION_START' || recordType === 'FLIGHT_VIOLATION_END') {
        if (toNonEmptyString(row.rule_id) !== VIOLATION_RULE.SPEEDBRAKE_DEPLOYED_IN_FLIGHT) {
          const violationEvent = buildRecordedFlightViolationEvent(
            recordType === 'FLIGHT_VIOLATION_START' ? 'violation_start' : 'violation_end',
            row,
            timestampMs,
            elapsed,
            eventCoordinates,
          );
          if (violationEvent) generatedTimeline.events.push(violationEvent);
        }
      }
      // Overspeed events
      else if (recordType === 'OVERSPEED') {
        generatedTimeline.events.push({
          type: 'violation_start',
          timestampMs,
          elapsedMs: elapsed,
          ruleId: 'OVERSPEED',
          severity: 'warning',
          lat: eventCoordinates.lat,
          lon: eventCoordinates.lon,
          context: {
            ias_kts: row.ias_kts,
            barber_pole_kts: row.barber_pole_kts,
            overspeed_type: row.overspeed_type,
            flaps_percent: row.flaps_percent,
          },
        });
      } else if (recordType === 'OVERSPEED_END') {
        generatedTimeline.events.push({
          type: 'violation_end',
          timestampMs,
          elapsedMs: elapsed,
          ruleId: 'OVERSPEED',
          lat: eventCoordinates.lat,
          lon: eventCoordinates.lon,
          context: {
            duration_ms: row.warning_duration_ms,
          },
        });
      }
      // Stall events
      else if (recordType === 'STALL') {
        generatedTimeline.events.push({
          type: 'violation_start',
          timestampMs,
          elapsedMs: elapsed,
          ruleId: 'STALL',
          severity: 'warning',
          lat: eventCoordinates.lat,
          lon: eventCoordinates.lon,
          context: {
            ias_kts: row.ias_kts,
          },
        });
      } else if (recordType === 'STALL_END') {
        generatedTimeline.events.push({
          type: 'violation_end',
          timestampMs,
          elapsedMs: elapsed,
          ruleId: 'STALL',
          lat: eventCoordinates.lat,
          lon: eventCoordinates.lon,
          context: {
            duration_ms: row.warning_duration_ms,
          },
        });
      }
      // Go-around events
      else if (recordType === 'GO_AROUND') {
        const altitudeFt = toFiniteNumber(row.goaround_altitude_ft) ?? toFiniteNumber(row.ra_ft);
        const isLateGoAround = Number.isFinite(altitudeFt) && altitudeFt < 200;
        generatedTimeline.events.push({
          type: 'marker',
          markerType: MARKER_TYPE.GO_AROUND,
          timestampMs,
          elapsedMs: elapsed,
          lat: eventCoordinates.lat,
          lon: eventCoordinates.lon,
          context: {
            altitude_ft: altitudeFt,
            ra: altitudeFt,
            previous_phase: row.previous_phase,
            late: isLateGoAround,
          },
        });
        if (isLateGoAround) {
          generatedTimeline.events.push({
            type: 'violation_start',
            timestampMs,
            elapsedMs: elapsed,
            ruleId: VIOLATION_RULE.LATE_GO_AROUND,
            severity: 'warning',
            lat: eventCoordinates.lat,
            lon: eventCoordinates.lon,
            context: {
              altitude_ft: altitudeFt,
              previous_phase: row.previous_phase,
            },
          });
        }
        approachSamples = [];
        stabilityScorer.reset();
        lastSampleTimestampMs = null;
        lastTouchdownTs = null;
        lastAcceptedTouchdownTimestampMs = null;
        maxRaFtSinceAirborne = 0;
        replayBounceCandidate = null;
        pendingReplayBounceConfirmation = null;
        replayTouchdownRearmed = true;
        activeReplayLandingEvent = null;
        lastGroundAltitudeFt = null;
        lastGroundRadioHeightFt = null;
        crossedAltitudes.clear();
        lastRA = null;
        wasOnGround = false;
      }
      // Landing event rows — merged with the WOW-derived SAMPLE event already on the timeline.
      // The LANDING record is written by landing-runner.js at rollout completion and contributes:
      //   - icao/runway: heading-filtered position lookup (authoritative)
      //   - touchdown_distance_ft + scoring: calculated against correct runway threshold
      //   - xwind_kts: authoritative runway-relative component; the SAMPLE
      //     fallback is independently reconstructed against resolved runway heading
      //   - grade: touchdown-rate grade resolved from persisted touchdown inputs
      //   - runway_excursion/short_landing: independent landing-outcome facts
      //   - ultimate_stability_*: written by the live current-approach scorer when
      //     available. Timeline replay still reconstructs stability from SAMPLE rows
      //     for older CSVs or crash-shortened logs with no complete LANDING payload.
      // All fields use `?? existing.x` fallbacks so a missing LANDING column falls
      // back to the SAMPLE-derived value.
      else if (recordType === 'LANDING') {
        replayBounceCandidate = null;
        pendingReplayBounceConfirmation = null;
        const runwayExcursion = toBooleanOrNull(row.runway_excursion) === true
          || isLegacyRunwayExcursionGrade(row.grade);
        const persistedUltimateStability = extractUltimateStability(row);
        const ultimateStability = isUsableUltimateStability(persistedUltimateStability)
          ? persistedUltimateStability
          : null;

        // Authoritative runway from live system (heading-filtered, not pure geometry)
        const landingRunwayHeading = toFiniteNumber(row.runway_heading_true_deg) ??
          (Number.isFinite(row.runway_heading) ? row.runway_heading : null);
        const landingRunwayThresholdLat = toFiniteNumber(row.runway_threshold_lat);
        const landingRunwayThresholdLon = toFiniteNumber(row.runway_threshold_lon);
        const landingRunwayPhysicalThresholdLat = toFiniteNumber(row.runway_physical_threshold_lat);
        const landingRunwayPhysicalThresholdLon = toFiniteNumber(row.runway_physical_threshold_lon);
        const runwayInfo = (row.icao || row.runway)
          ? {
              airport_icao: row.icao || null,
              airport_name: null,
              runway_id: row.runway != null && row.runway !== '' ? String(row.runway) : null,
              length_ft: Number.isFinite(row.runway_length_ft) ? row.runway_length_ft : null,
              width_ft: toFiniteNumber(row.runway_width_ft),
              runway_heading: landingRunwayHeading,
              heading_true_deg: landingRunwayHeading,
              source: typeof row.runway_geometry_source === 'string' ? row.runway_geometry_source : null,
              physical_length_ft: toFiniteNumber(row.runway_physical_length_ft),
              displaced_threshold_ft: toFiniteNumber(row.runway_displaced_threshold_ft),
              threshold: landingRunwayThresholdLat !== null && landingRunwayThresholdLon !== null
                ? { lat: landingRunwayThresholdLat, lon: landingRunwayThresholdLon }
                : null,
              physical_threshold: landingRunwayPhysicalThresholdLat !== null && landingRunwayPhysicalThresholdLon !== null
                ? { lat: landingRunwayPhysicalThresholdLat, lon: landingRunwayPhysicalThresholdLon }
                : null,
            }
          : null;

        // Authoritative touchdown distance + scoring from landing-runner rollout.
        // bounce_count was added to the schema in April 2026; older CSVs will have it
        // as null. The merge below falls back to the WOW-counted value already on the
        // existing event so old recordings still display bounce count correctly.
        const touchdownDistance = buildLandingRowTouchdownDistance(row, analysisRescoreMode);

        const candidateIndex = findActiveLandingEventIndex(
          generatedTimeline.events,
          activeReplayLandingEvent,
          row,
          timestampMs
        ) ?? findLandingEventByTouchdownIdentity(
          generatedTimeline.events,
          row,
          timestampMs
        ) ?? findLatestUnmergedLandingEventIndex(
          generatedTimeline.events,
          timestampMs,
          LANDING_MERGE_WINDOW_MS
        );

        if (typeof candidateIndex === 'number') {
          const existing = generatedTimeline.events[candidateIndex];
          const landingGrade = resolveReplayLandingGrade(
            row,
            existing,
            analysisRescoreMode,
          );
          const landingHeadline = landingGrade.headline;
          const recordedBounceCount = toFiniteNumber(row.bounce_count);
          const mergedBounceCount = analysisRescoreMode === 'current-preview'
            ? recordedBounceCount
            : (recordedBounceCount ?? toFiniteNumber(existing.bounceCount));
          const bounceCountSource = analysisRescoreMode === 'recorded'
            ? (recordedBounceCount !== null
              ? 'recorded'
              : (toFiniteNumber(existing.bounceCount) !== null ? 'reconstructed' : 'unavailable'))
            : null;
          const finalizedRunway = analysisRescoreMode === 'current-preview'
            ? runwayInfo
            : runwayInfo && (
            landingRunwayHeading !== null ||
            (landingRunwayThresholdLat !== null && landingRunwayThresholdLon !== null)
          )
            ? {
                ...runwayInfo,
                heading: runwayInfo.runway_heading ?? null,
                heading_true_deg: runwayInfo.runway_heading ?? null,
              }
            : existing.runway;

          // Ordinary replay preserves a recorded outcome. Sample reconstruction
          // fills only legacy rows where bounce_count was not persisted.
          if (touchdownDistance && analysisRescoreMode === 'recorded') {
            touchdownDistance.bounceCount = mergedBounceCount;
          }

          const replayPolicy = getReplayStabilityPolicyFromRow(row, existing);
          const rebuiltStability = analysisRescoreMode === 'current-preview'
            ? rebuildCurrentReplayStability(existing, row, replayPolicy)
            : null;
          const mergedWindSpeedKts = toFiniteNumber(row.wind_speed_kts) ?? existing.wind_speed_kts ?? null;
          const mergedWindDirectionDeg = toFiniteNumber(row.wind_dir_deg) ?? existing.wind_dir_deg ?? null;
          const recordedCrosswindKts = toFiniteNumber(row.xwind_kts);
          const mergedCrosswindKts = recordedCrosswindKts ?? (
            toFiniteNumber(row.wind_speed_kts) !== null || toFiniteNumber(row.wind_dir_deg) !== null
              ? computeCrosswind(
                  mergedWindSpeedKts,
                  mergedWindDirectionDeg,
                  getRunwayTrueHeadingDeg(finalizedRunway),
                )
              : existing.xwind_kts ?? null
          );
          generatedTimeline.events[candidateIndex] = applyReplayLandingGrade({
            ...existing,
            _landingRowMerged: true,
            // Runway stays from the WOW-transition SAMPLE row detection — that uses
            // hdg_true_deg at the actual touchdown moment (correct approach heading).
            // The LANDING record contributes grade, stability, touchdown distance, and
            // bounce scoring (computed live during rollout with the full approach context).
            grade: landingHeadline.grade,
            runwayExcursion: runwayExcursion || existing.runwayExcursion === true,
            aircraftProfileId: toNonEmptyString(row.aircraft_profile_id) || existing.aircraftProfileId || null,
            bounceCount: mergedBounceCount,
            ...(bounceCountSource ? { bounceCountSource } : {}),
            // The SAMPLE touchdown runway is provisional. Prefer finalized
            // LANDING-row geometry when it contains an actual heading or
            // threshold; identifier-only context must not replace valid data.
            runway: finalizedRunway,
            runwayReferenceElevFt: toFiniteNumber(row.runway_reference_elev_ft)
              ?? existing.runwayReferenceElevFt
              ?? null,
            runwayReferenceElevationSource:
              toNonEmptyString(row.runway_reference_elevation_source)
              ?? existing.runwayReferenceElevationSource
              ?? null,
            runwayReferenceElevationKind:
              toNonEmptyString(row.runway_reference_elevation_kind)
              ?? existing.runwayReferenceElevationKind
              ?? null,
            touchdownDistance: analysisRescoreMode === 'current-preview'
              ? touchdownDistance
              : mergeTouchdownDistance(existing.touchdownDistance, touchdownDistance),
            ultimateStability: analysisRescoreMode === 'current-preview'
              ? rebuiltStability?.value ?? null
              : ultimateStability
              ? {
                  ...ultimateStability,
                  scoringContext:
                    ultimateStability.scoringContext
                    || existing.ultimateStability?.scoringContext
                    || null,
                }
              : existing.ultimateStability,
            // Centerline deviation: use hdg from LANDING row if present (more precise
            // than the SAMPLE row which can be post-touchdown/decelerating).
            centerlineDev: _computeCenterlineDev(
              toFiniteNumber(row.hdg_true_deg) ?? existing.hdg_true_deg,
              getRunwayTrueHeadingDeg(finalizedRunway)
            ) ?? (analysisRescoreMode === 'current-preview' ? null : existing.centerlineDev ?? null),
            // Authoritative per-touchdown values from LANDING record (override SAMPLE estimates)
            vs_fpm: landingHeadline.vsFpm,
            gforce: toFiniteNumber(row.g_force) ?? toFiniteNumber(row.gforce) ?? existing.gforce ?? null,
            bank_deg: toFiniteNumber(row.bank_deg) ?? existing.bank_deg ?? null,
            gs_kts: toFiniteNumber(row.gs_kts) ?? existing.gs_kts ?? null,
            xwind_kts: mergedCrosswindKts,
            wind_speed_kts: mergedWindSpeedKts,
            wind_dir_deg: mergedWindDirectionDeg,
            rolloutAnalysis: analysisRescoreMode === 'current-preview'
              ? null
              : parseJsonObject(row.rollout_analysis) || existing.rolloutAnalysis || null,
          }, landingGrade);
          if (analysisRescoreMode === 'current-preview') {
            const rescoredEvent = generatedTimeline.events[candidateIndex];
            setAnalysisRescoreMetric(rescoredEvent, 'stability', rebuiltStability!.metric);
            setAnalysisRescoreMetric(rescoredEvent, 'touchdownDistance',
              toFiniteNumber(row.touchdown_distance_ft) === null
                ? unavailableGeometryMetric('recorded_touchdown_geometry_unavailable')
                : { applicable: true, available: true, source: 'reconstructed', reason: null });
            setAnalysisRescoreMetric(rescoredEvent, 'lateralOffset',
              toFiniteNumber(row.lateral_offset_ft) === null
                ? unavailableGeometryMetric('recorded_lateral_geometry_unavailable')
                : { applicable: true, available: true, source: 'reconstructed', reason: null });
            setAnalysisRescoreMetric(rescoredEvent, 'bounce', recordedBounceCount === null
              ? { applicable: true, available: false, source: 'unavailable', reason: 'recorded_bounce_evidence_unavailable' }
              : { applicable: true, available: true, source: 'reconstructed', reason: null });
          }
          activeReplayLandingEvent = generatedTimeline.events[candidateIndex];
        } else {
          const landingGrade = resolveReplayLandingGrade(
            row,
            null,
            analysisRescoreMode,
          );
          const landingHeadline = landingGrade.headline;
          const standaloneBounceCount = toFiniteNumber(row.bounce_count);
          generatedTimeline.events.push(applyReplayLandingGrade({
            type: 'landing',
            _landingRowMerged: true,
            timestampMs,
            elapsedMs: elapsed,
            lat: eventCoordinates.lat,
            lon: eventCoordinates.lon,
            runway: runwayInfo ? {
              ...runwayInfo,
              heading: runwayInfo.runway_heading ?? null,
              heading_true_deg: runwayInfo.runway_heading ?? null,
            } : null,
            runwayReferenceElevFt: toFiniteNumber(row.runway_reference_elev_ft),
            runwayReferenceElevationSource: toNonEmptyString(row.runway_reference_elevation_source),
            runwayReferenceElevationKind: toNonEmptyString(row.runway_reference_elevation_kind),
            ias_kts: row.ias_kts,
            vs_fpm: landingHeadline.vsFpm,
            pitch_deg: row.pitch_deg,
            hdg_true_deg: row.hdg_true_deg,
            gforce: toFiniteNumber(row.g_force) ?? toFiniteNumber(row.gforce),
            bank_deg: toFiniteNumber(row.bank_deg),
            gs_kts: toFiniteNumber(row.gs_kts),
            xwind_kts: toFiniteNumber(row.xwind_kts) ?? computeCrosswind(
              toFiniteNumber(row.wind_speed_kts),
              toFiniteNumber(row.wind_dir_deg),
              runwayInfo ? toFiniteNumber(runwayInfo.runway_heading) : null,
            ),
            wind_speed_kts: toFiniteNumber(row.wind_speed_kts),
            wind_dir_deg: toFiniteNumber(row.wind_dir_deg),
            grade: landingHeadline.grade,
            runwayExcursion,
            aircraftProfileId: toNonEmptyString(row.aircraft_profile_id),
            bounceCount: standaloneBounceCount,
            ...(analysisRescoreMode === 'recorded'
              ? { bounceCountSource: standaloneBounceCount === null ? 'unavailable' : 'recorded' }
              : {}),
            centerlineDev: runwayInfo
              ? _computeCenterlineDev(toFiniteNumber(row.hdg_true_deg), runwayInfo.runway_heading)
              : null,
            touchdownDistance,
            ultimateStability: analysisRescoreMode === 'current-preview' ? null : ultimateStability,
            rolloutAnalysis: analysisRescoreMode === 'current-preview'
              ? null
              : parseJsonObject(row.rollout_analysis),
          }, landingGrade));
          if (analysisRescoreMode === 'current-preview') {
            const rescoredEvent = generatedTimeline.events[generatedTimeline.events.length - 1];
            setAnalysisRescoreMetric(rescoredEvent, 'stability', {
              applicable: true,
              available: false,
              source: 'unavailable',
              reason: 'approach_samples_unavailable',
            });
            setAnalysisRescoreMetric(rescoredEvent, 'touchdownDistance',
              toFiniteNumber(row.touchdown_distance_ft) === null
                ? unavailableGeometryMetric('recorded_touchdown_geometry_unavailable')
                : { applicable: true, available: true, source: 'reconstructed', reason: null });
            setAnalysisRescoreMetric(rescoredEvent, 'lateralOffset',
              toFiniteNumber(row.lateral_offset_ft) === null
                ? unavailableGeometryMetric('recorded_lateral_geometry_unavailable')
                : { applicable: true, available: true, source: 'reconstructed', reason: null });
            setAnalysisRescoreMetric(rescoredEvent, 'bounce', toFiniteNumber(row.bounce_count) === null
              ? { applicable: true, available: false, source: 'unavailable', reason: 'recorded_bounce_evidence_unavailable' }
              : { applicable: true, available: true, source: 'reconstructed', reason: null });
          }
          activeReplayLandingEvent = generatedTimeline.events[generatedTimeline.events.length - 1];
        }
      }
    }
  }
  
  // Close any remaining open violations at end of CSV
  const lastTs = getRowTimestampMs(lastRow);
  const lastElapsed = getRowElapsedMs(lastRow, startTimestampMs);
  const endCoordinates = resolveEventCoordinates(lastRow, lastValidCoordinates);
  highSinkRateState = endHighSinkRateViolation(
    highSinkRateState,
    lastTs,
    lastElapsed,
    generatedTimeline,
    endCoordinates.lat,
    endCoordinates.lon,
  );
  endAllViolations(lastTs, lastElapsed, generatedTimeline, activeViolations, endCoordinates.lat, endCoordinates.lon);
  if (generatedTimeline.events.length > MAX_GENERATED_TIMELINE_EVENTS) {
    return {
      success: false,
      error: 'Timeline contains more events than Flight Fabric can process safely.',
    };
  }

  attachRolloutLateralDiagnostics(generatedTimeline, rows, analysisRescoreMode);
  applyRolloutAnalysis(generatedTimeline, rows, analysisRescoreMode);
  const automationMergeError = mergeAutomationTimelineEvents(
    generatedTimeline,
    rows,
    _options,
    startTimestampMs,
  );
  if (automationMergeError) return { success: false, error: automationMergeError };

  // Sort events by timestamp (violations may have been inserted out of order)
  generatedTimeline.events.sort((a, b) => a.timestampMs - b.timestampMs);
  attachSimulatorDateTimesToEvents(generatedTimeline.events, rows, startTimestampMs);
  finalizeAnalysisRescore(generatedTimeline, analysisRescoreMode);
  
  // Compute summary stats
  generatedTimeline.eventCount = generatedTimeline.events.length;
  generatedTimeline.durationMs = Math.max(
    0,
    getRowElapsedMs(lastRow, startTimestampMs) - getRowElapsedMs(firstRow, startTimestampMs),
  );
  generatedTimeline.durationFormatted = formatDuration(generatedTimeline.durationMs);
  generatedTimeline.sampleCount = rows.reduce((count, row) => {
    const recordType = String(row?.record_type || 'SAMPLE').trim().toUpperCase() || 'SAMPLE';
    return recordType === 'SAMPLE' ? count + 1 : count;
  }, 0);
  
  // Find worst moment (most violations in a 30-second window)
  generatedTimeline.worstMoment = findWorstMoment(generatedTimeline.events);
  
  // ═══════════════════════════════════════════════════════════════════════
  // Retrospective Flight Type Classification
  // ═══════════════════════════════════════════════════════════════════════
  // Classify based on altitude, landing count, and timing patterns.
  // This enables pattern work detection for GA training flights.
  const flightClassification = flightTypeClassifier.classifyFlight(rows, {
    wowKey: 'on_ground',  // CSV uses 'on_ground' not 'wow'
    raKey: 'ra_ft',
    tsKey: 'ts',
  });
  
  generatedTimeline.flightType = flightClassification.flightType;
  generatedTimeline.flightClassification = {
    type: flightClassification.flightType,
    confidence: flightClassification.confidence,
    isPatternWork: flightClassification.isPatternWork,
    landingCount: flightClassification.landingCount,
    circuitCount: flightClassification.circuitCount,
    maxAltAglFt: flightClassification.maxAltAglFt,
    avgTimeBetweenLandingsMs: flightClassification.avgTimeBetweenLandingsMs,
  };

  // Attach flight summary (violations, envelope stats) to each landing event so
  // that the landing detail card shows identical data whether viewed live or when
  // revisiting from the logbook. Computed from the rows already in memory —
  // no extra disk I/O.
  try {
    const flightSummary = computeFlightSummaryFromRows(rows);
    if (flightSummary) {
      removeRetiredSpoilerViolationSummaries(flightSummary);
      for (const event of generatedTimeline.events) {
        if (event.type === 'landing') {
          event.flightSummary = flightSummary;
        }
      }
    }
  } catch (_e) { /* non-critical — landing card falls back gracefully */ }

  // `_landingRowMerged` is replay-only association state. Do not expose it in
  // timeline JSON or history responses.
  for (const event of generatedTimeline.events) {
    if (event && Object.prototype.hasOwnProperty.call(event, '_landingRowMerged')) {
      delete event._landingRowMerged;
    }
  }

  return { success: true, timeline: generatedTimeline };
}

/**
 * High sink rate is an episode, not a single-sample threshold alarm. Require a
 * sustained breach before publishing it, retain the original onset timestamp,
 * and keep the episode active until V/S recovers through a clear margin.
 */
function updateHighSinkRateViolation(
  state: HighSinkRateState | null,
  vsFpm: number | null,
  timestampMs: number,
  elapsedMs: number,
  timeline: GeneratedTimeline,
  lat: number | null = null,
  lon: number | null = null,
): HighSinkRateState | null {
  if (vsFpm === null) return state;

  const thresholdFpm = STABILITY_THRESHOLDS.HIGH_SINK_RATE_FPM;
  const clearThresholdFpm = STABILITY_THRESHOLDS.HIGH_SINK_RATE_CLEAR_FPM;
  const isThresholdBreach = vsFpm < thresholdFpm;

  if (!state) {
    if (!isThresholdBreach) return null;
    state = {
      active: false,
      onsetTimestampMs: timestampMs,
      onsetElapsedMs: elapsedMs,
      onsetLat: lat,
      onsetLon: lon,
      onsetValueFpm: vsFpm,
      peakValueFpm: vsFpm,
      peakTimestampMs: timestampMs,
      lastThresholdBreachTimestampMs: timestampMs,
      context: {},
      startEvent: null,
    };
  } else {
    if (vsFpm < state.peakValueFpm) {
      state.peakValueFpm = vsFpm;
      state.peakTimestampMs = timestampMs;
    }
    if (isThresholdBreach) state.lastThresholdBreachTimestampMs = timestampMs;
  }

  if (!state.active) {
    if (!isThresholdBreach) return null;
    if (timestampMs - state.onsetTimestampMs < STABILITY_THRESHOLDS.HIGH_SINK_RATE_MIN_DURATION_MS) {
      return state;
    }

    const severity = state.peakValueFpm < -1500 ? 'warning' : 'caution';
    state.context = {
      value: state.onsetValueFpm,
      peak_sink_rate_fpm: state.peakValueFpm,
      threshold_fpm: thresholdFpm,
      clear_threshold_fpm: clearThresholdFpm,
      onset_duration_ms: STABILITY_THRESHOLDS.HIGH_SINK_RATE_MIN_DURATION_MS,
      note: HIGH_SINK_RATE_NOTE,
    };
    state.startEvent = {
      type: 'violation_start',
      timestampMs: state.onsetTimestampMs,
      elapsedMs: state.onsetElapsedMs,
      ruleId: VIOLATION_RULE.HIGH_SINK_RATE,
      severity,
      lat: state.onsetLat,
      lon: state.onsetLon,
      context: state.context,
    };
    timeline.events.push(state.startEvent);
    state.active = true;
  }

  state.context.peak_sink_rate_fpm = state.peakValueFpm;
  if (state.startEvent) {
    state.startEvent.severity = state.peakValueFpm < -1500 ? 'warning' : 'caution';
  }

  if (vsFpm >= clearThresholdFpm) {
    return endHighSinkRateViolation(state, timestampMs, elapsedMs, timeline, lat, lon);
  }
  return state;
}

function endHighSinkRateViolation(
  state: HighSinkRateState | null,
  timestampMs: number,
  elapsedMs: number,
  timeline: GeneratedTimeline,
  lat: number | null = null,
  lon: number | null = null,
): null {
  if (!state?.active) return null;

  const durationMs = Math.max(0, timestampMs - state.onsetTimestampMs);
  const thresholdExceedanceDurationMs = Math.max(
    0,
    state.lastThresholdBreachTimestampMs - state.onsetTimestampMs,
  );
  state.context.peak_sink_rate_fpm = state.peakValueFpm;
  state.context.duration_ms = durationMs;
  state.context.threshold_exceedance_duration_ms = thresholdExceedanceDurationMs;

  timeline.events.push({
    type: 'violation_end',
    timestampMs,
    elapsedMs,
    ruleId: VIOLATION_RULE.HIGH_SINK_RATE,
    severity: state.startEvent?.severity || 'caution',
    lat,
    lon,
    timestamp_start: state.onsetTimestampMs,
    duration_ms: durationMs,
    context: { ...state.context },
  });
  return null;
}

/**
 * Check violation condition and emit start/end events.
 * Tracks active violations to avoid spam.
 */
function checkViolationCondition(ruleId: string, isViolating: boolean, severity: string, context: AnyRecord, timestampMs: number, elapsedMs: number, timeline: GeneratedTimeline, activeViolations: Map<string, ViolationState>, lat: number | null = null, lon: number | null = null) {
  if (isViolating) {
    // Violation condition is true
    if (!activeViolations.has(ruleId)) {
      // Start new violation
      timeline.events.push({
        type: 'violation_start',
        timestampMs,
        elapsedMs,
        ruleId,
        severity,
        lat,
        lon,
        context,
      });
      activeViolations.set(ruleId, { startTs: timestampMs, startElapsed: elapsedMs, context });
    }
    // else: violation already active, don't spam
  } else {
    // Violation condition is false
    if (activeViolations.has(ruleId)) {
      // End existing violation
      const start = activeViolations.get(ruleId);
      timeline.events.push({
        type: 'violation_end',
        timestampMs,
        elapsedMs,
        ruleId,
        severity,
        lat,
        lon,
        timestamp_start: start.startTs,
        duration_ms: timestampMs - start.startTs,
      });
      activeViolations.delete(ruleId);
    }
  }
}

/**
 * End all active violations (called at phase change or end of flight).
 */
function endAllViolations(timestampMs: number, elapsedMs: number, timeline: GeneratedTimeline, activeViolations: Map<string, ViolationState>, lat: number | null = null, lon: number | null = null) {
  for (const [ruleId, start] of activeViolations.entries()) {
    timeline.events.push({
      type: 'violation_end',
      timestampMs,
      elapsedMs,
      ruleId,
      lat,
      lon,
      timestamp_start: start.startTs,
      duration_ms: timestampMs - start.startTs,
    });
  }
  activeViolations.clear();
}

/**
 * Find nearest airport to given coordinates (within 5nm radius)
 */
function findNearestAirport(lat: number, lon: number): AirportSummary | null {
  const normalizedLat = toFiniteNumber(lat);
  const normalizedLon = toFiniteNumber(lon);
  if (!isValidCoordinate(normalizedLat, normalizedLon)) return null;
  
  try {
    const results = airportSearch.findSuitableAirports(normalizedLat, normalizedLon, {
      radiusNm: 5,
      minRunwayLengthFt: 3000,
      limit: 1
    });
    return results.length > 0 ? results[0] : null;
  } catch (err) {
    // Airport search not available (data not loaded)
    return null;
  }
}

/**
 * Find nearest airport with relaxed constraints for list summaries.
 */
function findNearestAirportSummary(lat: number, lon: number): AirportSummary | null {
  const normalizedLat = toFiniteNumber(lat);
  const normalizedLon = toFiniteNumber(lon);
  if (!isValidCoordinate(normalizedLat, normalizedLon)) return null;

  try {
    const SUMMARY_RADIUS_NM = 35;
    const results = airportSearch.findSuitableAirports(normalizedLat, normalizedLon, {
      radiusNm: SUMMARY_RADIUS_NM,
      minRunwayLengthFt: 2000,
      limit: 1,
    });
    return results.length > 0 ? results[0] : null;
  } catch {
    return null;
  }
}

/**
 * Format duration in milliseconds to human-readable string
 */
function formatDuration(ms) {
  if (!ms || ms < 0) return '0m';
  
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Find the worst moment in the timeline (highest violation density).
 */
function findWorstMoment(events: AnyRecord[]): AnyRecord | null {
  const violations = events.filter(e => e.type === 'violation_start');
  if (violations.length === 0) return null;
  
  const windowMs = 30000; // 30-second window
  let worstStart = 0;
  let worstCount = 0;
  let worstIndex = -1;
  
  for (let i = 0; i < violations.length; i++) {
    const windowEnd = violations[i].elapsedMs + windowMs;
    let count = 0;
    
    for (let j = i; j < violations.length && violations[j].elapsedMs <= windowEnd; j++) {
      count++;
    }
    
    if (count > worstCount) {
      worstCount = count;
      worstStart = violations[i].elapsedMs;
      // Find the index in the full events array
      worstIndex = events.indexOf(violations[i]);
    }
  }
  
  return {
    elapsedMs: worstStart,
    violationCount: worstCount,
    windowMs,
    index: worstIndex,
  };
}

/**
 * Generate and save a timeline from a CSV file.
 * @param {string} csvPath - Path to the CSV file
 * @returns {Promise<{ success: boolean, filePath?: string, timeline?: Object, error?: string }>}
 */
async function generateAndSave(csvPath: string): Promise<TimelineSaveResult> {
  const result = await generateFromCSV(csvPath);
  
  if (!result.success) {
    return { success: false, error: 'error' in result ? result.error : 'Timeline generation failed' };
  }
  
  // Save as an explicitly derived member of the recording bundle.
  const dir = path.resolve(path.dirname(csvPath));
  const timelinePath = recordingBundleLayout.getBundleFromCsvPath(csvPath)?.paths.timeline;
  if (!timelinePath) return { success: false, error: 'CSV is not in a canonical recording bundle' };
  
  try {
    safeReplaceTextFileSync({
      allowedExtensions: ['.json'],
      data: `${JSON.stringify(result.timeline)}\n`,
      operation: 'writeTimelineSidecar',
      rootDir: dir,
      targetPath: timelinePath,
    });
    return { 
      success: true, 
      filePath: timelinePath, 
      timeline: result.timeline,
    };
  } catch (err) {
    return { success: false, error: `Failed to write timeline: ${err.message}` };
  }
}

/**
 * Generate timelines for all CSVs that don't have one.
 * @returns {Promise<{ generated: number, skipped: number, failed: number, details: Object[] }>}
 */
async function generateMissing(): Promise<GenerateMissingResult> {
  const flightLogsDir = getFlightLogsDir();
  
  if (!fs.existsSync(flightLogsDir)) {
    return { generated: 0, skipped: 0, failed: 0, details: [] };
  }
  
  const csvFiles = recordingBundleLayout.listBundleCsvPaths(flightLogsDir);
  
  const results: GenerateMissingResult = { generated: 0, skipped: 0, failed: 0, details: [] };
  
  for (const csvPath of csvFiles) {
    const csv = path.basename(path.dirname(csvPath));
    const timelinePath = path.join(path.dirname(csvPath), 'timeline.json');
    if (fs.existsSync(timelinePath)) {
      let currentContract = false;
      try {
        const stat = fs.lstatSync(timelinePath);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 64 * 1024 * 1024) {
          const savedTimeline = JSON.parse(fs.readFileSync(timelinePath, 'utf8'));
          currentContract = JSON.stringify(savedTimeline?.analysisRescore?.contract)
            === JSON.stringify(CURRENT_ANALYSIS_RESCORE_CONTRACT);
        }
      } catch {
        currentContract = false;
      }
      if (currentContract) {
        results.skipped++;
        results.details.push({ file: csv, status: 'skipped', reason: 'Current timeline exists' });
        continue;
      }
    }
    
    const result = await generateAndSave(csvPath);
    
    if (result.success) {
      results.generated++;
      results.details.push({ file: csv, status: 'generated', eventCount: result.timeline.eventCount });
    } else {
      results.failed++;
      results.details.push({ file: csv, status: 'failed', error: 'error' in result ? result.error : 'Generation failed' });
    }
  }
  
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// CSV File Listing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the empty result shape used when a CSV cannot be inspected.
 */
function createEmptyQuickPeekResult(): QuickPeekResult {
  return {
    firstRow: null,
    lastRow: null,
    firstCoordRow: null,
    lastCoordRow: null,
    aircraftProfileId: null,
    firstFuelRow: null,
    lastFuelRow: null,
    distanceNm: null,
    rowCount: 0,
    sampleCount: 0,
    strictBundle: false,
    bundleStatusRequired: false,
    manifestIdentity: null,
  };
}

// Auto-start can leave tiny CSV fragments if the lifecycle gate opens and then
// immediately ends. Keep them on disk, but don't promote them to timeline items.
const MIN_LISTED_FLIGHT_SAMPLE_COUNT = 5;
const FLIGHT_LIST_METADATA_CACHE_VERSION = 9;
const FLIGHT_LIST_METADATA_CACHE_FILE = 'timeline-flight-list-cache.json';
const LISTED_FLIGHT_TIMESTAMP_COLUMNS = ['timestamp_utc', 'ts'];
const LISTED_FLIGHT_TELEMETRY_COLUMNS = [
  'record_type',
  'lat_deg',
  'lon_deg',
  'ias_kts',
  'vs_fpm',
  'ra_ft',
  'on_ground',
  'phase',
  'aircraft',
  'flight_id',
];
const MIN_LISTED_FLIGHT_TELEMETRY_COLUMNS = 3;

function getFlightListMetadataCachePath(): string {
  return path.join(getAppDataRoot(), FLIGHT_LIST_METADATA_CACHE_FILE);
}

function createEmptyFlightListMetadataCache(): AnyRecord {
  return {
    version: FLIGHT_LIST_METADATA_CACHE_VERSION,
    entries: {},
  };
}

function readFlightListMetadataCache(): AnyRecord {
  try {
    const cachePath = getFlightListMetadataCachePath();
    if (!fs.existsSync(cachePath)) return createEmptyFlightListMetadataCache();
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return createEmptyFlightListMetadataCache();
    if (parsed.version !== FLIGHT_LIST_METADATA_CACHE_VERSION) return createEmptyFlightListMetadataCache();
    if (!parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      return createEmptyFlightListMetadataCache();
    }
    return parsed;
  } catch {
    return createEmptyFlightListMetadataCache();
  }
}

function writeFlightListMetadataCache(cache: AnyRecord): void {
  try {
    const appDataRoot = getAppDataRoot();
    ensureDirExists(appDataRoot);
    safeReplaceTextFileSync({
      allowedExtensions: ['.json'],
      data: JSON.stringify(cache, null, 2),
      operation: 'write timeline flight-list metadata cache',
      rootDir: appDataRoot,
      targetPath: getFlightListMetadataCachePath(),
    });
  } catch {
    // Cache failures must never block the timeline list.
  }
}

function getCachedListedFlight(cache: AnyRecord, filePath: string, stat: AnyRecord): AnyRecord | null | undefined {
  const entry = cache?.entries?.[filePath];
  if (!entry || typeof entry !== 'object') return undefined;
  if (Number(entry.mtimeMs) !== Number(stat.mtimeMs)) return undefined;
  if (Number(entry.sizeBytes) !== Number(stat.size)) return undefined;
  if (entry.listed !== true) return null;
  const flight = entry.flight && typeof entry.flight === 'object' ? entry.flight : null;
  if (!flight) return null;
  return {
    ...flight,
    filePath,
    timestamp: stat.mtime,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
  };
}

function buildFlightListCacheEntry(stat: AnyRecord, flight: AnyRecord | null): AnyRecord {
  if (!flight) {
    return {
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      listed: false,
      flight: null,
    };
  }

  return {
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    listed: true,
    flight: {
      ...flight,
      timestamp: flight.timestamp instanceof Date ? flight.timestamp.toISOString() : flight.timestamp,
    },
  };
}

function hasRequiredListedFlightHeaders(headers: string[] | null | undefined): boolean {
  if (!Array.isArray(headers) || headers.length === 0) return false;
  const headerSet = new Set(headers.map((header) => String(header || '').trim()).filter(Boolean));
  const hasTimestamp = LISTED_FLIGHT_TIMESTAMP_COLUMNS.some((column) => headerSet.has(column));
  if (!hasTimestamp) return false;

  const telemetryColumnCount = LISTED_FLIGHT_TELEMETRY_COLUMNS
    .filter((column) => headerSet.has(column))
    .length;
  return telemetryColumnCount >= MIN_LISTED_FLIGHT_TELEMETRY_COLUMNS;
}

function openPinnedRegularCsvForListing(filePath: string): {
  fd: number;
  stat: import('fs').Stats;
} {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('Timeline listing CSV is not a regular file');
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const opened = fs.fstatSync(fd);
    const after = fs.lstatSync(filePath);
    if (
      !opened.isFile()
      || !after.isFile()
      || after.isSymbolicLink()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || after.dev !== before.dev
      || after.ino !== before.ino
    ) {
      throw new Error('Timeline listing CSV identity changed during open');
    }
    return { fd, stat: opened };
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    throw error;
  }
}

function readCsvHeadersForListing(filePath: string): string[] | null {
  try {
    const { fd } = openPinnedRegularCsvForListing(filePath);
    try {
      const buffer = Buffer.alloc(32 * 1024);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (bytesRead <= 0) return null;
      const text = buffer.toString('utf8', 0, bytesRead);
      const headerLine = splitCsvLines(text, { trimAndDropEmpty: true })[0];
      if (!headerLine) return null;
      return parseCsvLine(headerLine, { trimValues: true })
        .map((header) => String(header || '').trim());
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function shouldListCsvFlight(sampleCount: number): boolean {
  return Number.isFinite(sampleCount) && sampleCount >= MIN_LISTED_FLIGHT_SAMPLE_COUNT;
}

function createEmptyCsvExactScanResult(): CsvExactScanResult {
  return {
    firstRow: null,
    lastRow: null,
    firstCoordRow: null,
    lastCoordRow: null,
    aircraftProfileId: null,
    rowCount: 0,
    sampleCount: 0,
    firstFuelRow: null,
    lastFuelRow: null,
    distanceNm: null,
    strictBundle: false,
    bundleStatusRequired: false,
    manifestIdentity: null,
  };
}

function findFirstHeaderIndex(headers: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const index = headers.indexOf(candidate);
    if (index >= 0) return index;
  }
  return -1;
}

function getFuelUsageColumnIndexes(headers: string[]): FuelUsageColumnIndexes {
  return {
    sampleIndex: findFirstHeaderIndex(headers, ['sample_index', 'sampleIndex']),
    phase: findFirstHeaderIndex(headers, ['phase']),
    flightElapsedMs: findFirstHeaderIndex(headers, ['flight_elapsed_ms', 'flightElapsedMs']),
    timestampUtc: findFirstHeaderIndex(headers, ['timestamp_utc', 'timestampUtc']),
    ts: findFirstHeaderIndex(headers, ['ts', 'timestamp_ms', 'timestampMs']),
    fuelTotalGal: findFirstHeaderIndex(headers, ['fuel_total_gal', 'fuelTotalGal', 'fuelTotal', 'fuel_total']),
    fuelTotalWeightLbs: findFirstHeaderIndex(headers, ['fuel_total_weight_lbs', 'fuelTotalWeightLbs', 'fuelTotalWeight', 'fuel_weight_lbs']),
    fuelWeightPerGal: findFirstHeaderIndex(headers, ['fuel_weight_per_gal', 'fuelWeightPerGal', 'fuelWeightPerGallon']),
    grossWeightLbs: findFirstHeaderIndex(headers, ['gross_weight_lbs', 'grossWeightLbs', 'grossWeight', 'totalWeight']),
  };
}

function getListingMetadataColumnIndexes(headers: string[]): ListingMetadataColumnIndexes {
  return {
    recordType: findFirstHeaderIndex(headers, ['record_type']),
    schemaVersion: findFirstHeaderIndex(headers, ['schema_version']),
    timestampUtc: findFirstHeaderIndex(headers, ['timestamp_utc', 'timestampUtc']),
    ts: findFirstHeaderIndex(headers, ['ts', 'timestamp_ms', 'timestampMs']),
    flightElapsedMs: findFirstHeaderIndex(headers, ['flight_elapsed_ms', 'flightElapsedMs']),
    aircraft: findFirstHeaderIndex(headers, ['aircraft']),
    aircraftProfileId: findFirstHeaderIndex(headers, ['aircraft_profile_id', 'aircraftProfileId']),
    lat: findFirstHeaderIndex(headers, ['lat_deg']),
    lon: findFirstHeaderIndex(headers, ['lon_deg']),
    flightId: findFirstHeaderIndex(headers, ['flight_id']),
    recordingSessionId: findFirstHeaderIndex(headers, ['recording_session_id']),
    flightStartIso: findFirstHeaderIndex(headers, ['flight_start_iso']),
    bundleStatusRequired: findFirstHeaderIndex(headers, ['bundle_status_required']),
  };
}

function getCsvCell(values: unknown[], index: number): unknown {
  if (index < 0 || index >= values.length) return null;
  const value = values[index];
  return value === '' || value === undefined ? null : value;
}

function buildFuelUsageScanRow(values: unknown[], indexes: FuelUsageColumnIndexes): CsvRow | null {
  const row: CsvRow = {
    sample_index: getCsvCell(values, indexes.sampleIndex),
    phase: getCsvCell(values, indexes.phase),
    flight_elapsed_ms: getCsvCell(values, indexes.flightElapsedMs),
    timestamp_utc: getCsvCell(values, indexes.timestampUtc),
    ts: getCsvCell(values, indexes.ts),
    fuel_total_gal: getCsvCell(values, indexes.fuelTotalGal),
    fuel_total_weight_lbs: getCsvCell(values, indexes.fuelTotalWeightLbs),
    fuel_weight_per_gal: getCsvCell(values, indexes.fuelWeightPerGal),
    gross_weight_lbs: getCsvCell(values, indexes.grossWeightLbs),
  };
  return hasFuelUsageAnchor(row) ? row : null;
}

function buildListingMetadataScanRow(
  values: unknown[],
  indexes: ListingMetadataColumnIndexes,
): CsvRow {
  return {
    record_type: getCsvCell(values, indexes.recordType),
    schema_version: getCsvCell(values, indexes.schemaVersion),
    timestamp_utc: getCsvCell(values, indexes.timestampUtc),
    ts: getCsvCell(values, indexes.ts),
    flight_elapsed_ms: getCsvCell(values, indexes.flightElapsedMs),
    aircraft: getCsvCell(values, indexes.aircraft),
    aircraft_profile_id: getCsvCell(values, indexes.aircraftProfileId),
    // The exact scanner reads raw CSV cells, unlike mapCsvRow(), so preserve
    // the normal parsed-row contract explicitly. Passing coordinate strings
    // into airport-search makes additions such as `lat + latRange` concatenate
    // and prevents every route lookup from finding an airport.
    lat_deg: toFiniteNumber(getCsvCell(values, indexes.lat)),
    lon_deg: toFiniteNumber(getCsvCell(values, indexes.lon)),
  };
}

function countCsvRowsExact(filePath: string): CsvExactScanResult {
  const { fd } = openPinnedRegularCsvForListing(filePath);
  const buffer = Buffer.alloc(64 * 1024);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let record = '';
  let headers: string[] | null = null;
  let fuelColumnIndexes: FuelUsageColumnIndexes | null = null;
  let listingColumnIndexes: ListingMetadataColumnIndexes | null = null;
  let recordTypeIndex = -1;
  let strictBundle = false;
  let bundleStatusRequired = false;
  let manifestIdentity: AnyRecord | null = null;
  let rowCount = 0;
  let sampleCount = 0;
  let firstRow: CsvRow | null = null;
  let lastRow: CsvRow | null = null;
  let firstCoordRow: CsvRow | null = null;
  let lastCoordRow: CsvRow | null = null;
  let aircraftProfileId: string | null = null;
  const fuelSelector = createFuelUsageRowSelector();
  let previousCoord: Coordinate | null = null;
  let totalDistanceFt = 0;
  let inQuotes = false;
  let malformed = false;
  let pendingQuote = false;
  let previousWasCr = false;

  const consumeRecord = (rawRecord: string) => {
    if (malformed) return;
    if (!rawRecord.trim()) return;
    if (!headers) {
      headers = parseCsvLine(rawRecord, { trimValues: true }).map((value) => String(value || '').trim());
      recordTypeIndex = headers.indexOf('record_type');
      strictBundle = headers.includes('recording_session_id');
      fuelColumnIndexes = getFuelUsageColumnIndexes(headers);
      listingColumnIndexes = getListingMetadataColumnIndexes(headers);
      return;
    }

    const values = parseCsvLine(rawRecord, { trimValues: true });
    if (values.length !== headers.length) {
      malformed = true;
      return;
    }

    rowCount++;
    const recordType = recordTypeIndex >= 0
      ? String(values[recordTypeIndex] || 'SAMPLE').trim() || 'SAMPLE'
      : 'SAMPLE';
    if (recordType === 'RECORDING_MANIFEST') strictBundle = true;
    if (recordType === 'RECORDING_MANIFEST' && listingColumnIndexes) {
      const requiredRaw = String(
        getCsvCell(values, listingColumnIndexes.bundleStatusRequired) ?? '',
      ).trim().toLowerCase();
      if (requiredRaw && !['0', '1', 'false', 'true'].includes(requiredRaw)) {
        malformed = true;
        return;
      }
      bundleStatusRequired = requiredRaw === '1' || requiredRaw === 'true';
      const recordingStartIso = String(
        getCsvCell(values, listingColumnIndexes.flightStartIso) || '',
      ).trim();
      manifestIdentity = {
        flightId: String(getCsvCell(values, listingColumnIndexes.flightId) || '').trim(),
        recordingSessionId: String(
          getCsvCell(values, listingColumnIndexes.recordingSessionId) || '',
        ).trim(),
        recordingStartIso,
        recordingStartEpochMs: Date.parse(recordingStartIso),
      };
    }
    if (recordType === 'SAMPLE') sampleCount++;

    if (listingColumnIndexes) {
      const metadataRow = buildListingMetadataScanRow(values, listingColumnIndexes);
      if (!isRecordingManifestRow(metadataRow)) {
        firstRow ||= metadataRow;
        lastRow = metadataRow;
        aircraftProfileId ||= getReplayAircraftProfileId(metadataRow);
      }

      const lat = toFiniteNumber(metadataRow.lat_deg);
      const lon = toFiniteNumber(metadataRow.lon_deg);
      if (isValidCoordinate(lat, lon)) {
        firstCoordRow ||= metadataRow;
        lastCoordRow = metadataRow;
      }
    }

    if (fuelColumnIndexes) {
      const fuelRow = buildFuelUsageScanRow(values, fuelColumnIndexes);
      fuelSelector.push(fuelRow);
    }

    if (listingColumnIndexes) {
      const lat = toFiniteNumber(getCsvCell(values, listingColumnIndexes.lat));
      const lon = toFiniteNumber(getCsvCell(values, listingColumnIndexes.lon));
      if (isValidCoordinate(lat, lon)) {
        const coord = { lat, lon };
        if (previousCoord) {
          const segmentFt = distanceFeetBetweenCoordinates(previousCoord, coord);
          if (segmentFt !== null) totalDistanceFt += segmentFt;
        }
        previousCoord = coord;
      }
    }
  };

  const consumeText = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (pendingQuote) {
        if (ch === '"') {
          record += ch;
          pendingQuote = false;
          previousWasCr = false;
          continue;
        }
        inQuotes = false;
        pendingQuote = false;
      }

      if (ch === '"') {
        record += ch;
        if (inQuotes) {
          pendingQuote = true;
        } else {
          inQuotes = true;
        }
        previousWasCr = false;
        continue;
      }

      if (!inQuotes && (ch === '\n' || ch === '\r')) {
        if (ch === '\n' && previousWasCr) {
          previousWasCr = false;
          continue;
        }
        consumeRecord(record);
        record = '';
        previousWasCr = ch === '\r';
        continue;
      }

      record += ch;
      previousWasCr = false;
    }
  };

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      consumeText(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
    }
    consumeText(decoder.decode());

    if (record.trim()) {
      let currentLookingTail = strictBundle;
      let tailHasExpectedWidth = false;
      if (!currentLookingTail && headers) {
        const tailValues = parseCsvLine(record, { trimValues: true });
        const tailRecordType = recordTypeIndex >= 0
          ? String(tailValues[recordTypeIndex] || '').trim()
          : '';
        currentLookingTail = tailRecordType === 'RECORDING_MANIFEST';
        tailHasExpectedWidth = tailValues.length === headers.length;
      }
      // Current recordings use the record delimiter as the commit marker. A
      // complete-looking EOF fragment is still uncommitted after a crash.
      // Legacy recordings predate that rule and may end with a complete row but
      // no delimiter. Preserve that compatibility while quarantining an open
      // quoted field or a partial-width crash tail, just like the full parser.
      const tailHasCompleteQuotes = !inQuotes || pendingQuote;
      if (!currentLookingTail && (!headers || (tailHasExpectedWidth && tailHasCompleteQuotes))) {
        consumeRecord(record);
      }
    }
    if (malformed) return createEmptyCsvExactScanResult();
    const { firstFuelRow, lastFuelRow } = fuelSelector.result();
    const distanceNm = totalDistanceFt > 0
      ? Math.round((totalDistanceFt / FEET_PER_NAUTICAL_MILE) * 10) / 10
      : null;
    return {
      firstRow,
      lastRow,
      firstCoordRow,
      lastCoordRow,
      aircraftProfileId,
      rowCount,
      sampleCount,
      firstFuelRow,
      lastFuelRow,
      distanceNm,
      strictBundle,
      bundleStatusRequired,
      manifestIdentity,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Quick-read first and last lines of a CSV to extract metadata without full parse.
 * @param {string} filePath - Path to CSV file
 * @returns {{ firstRow: Object|null, lastRow: Object|null, firstCoordRow: Object|null, lastCoordRow: Object|null, rowCount: number }}
 */
function quickPeekCSV(filePath: string): QuickPeekResult {
  try {
    // The exact streaming scan is also the metadata scan. Keeping one parser
    // prevents head/tail chunk boundaries or an unterminated EOF fragment from
    // disagreeing with the row and sample counts shown in Timeline.
    return countCsvRowsExact(filePath);
  } catch {
    return createEmptyQuickPeekResult();
  }
}

function buildListedCsvFlight(filePath: string, fileName: string, stat: AnyRecord): AnyRecord | null {
    const headers = readCsvHeadersForListing(filePath);
    if (!hasRequiredListedFlightHeaders(headers)) return null;
    
    // Parse filename for flightId
    const basename = stripCsvExtension(fileName);
    const parts = basename.split('_');
    const flightId = parts[0];
    
    // Quick peek at CSV for route/duration
    const {
      firstRow,
      lastRow,
      firstCoordRow,
      lastCoordRow,
      aircraftProfileId,
      firstFuelRow,
      lastFuelRow,
      distanceNm,
      rowCount,
      sampleCount,
      strictBundle,
      bundleStatusRequired,
      manifestIdentity,
    } = quickPeekCSV(filePath);
    const fuelUsage = summarizeFuelUsage(firstFuelRow, lastFuelRow);
    
    let departureAirport = null;
    let arrivalAirport = null;
    let departureNearbyAirport = null;
    let arrivalNearbyAirport = null;
    let route = null;
    let displayRouteLabel = 'Location Unknown';
    let durationFormatted = null;
    
    if (firstCoordRow && lastCoordRow) {
      // Get airports from coordinates
      departureAirport = findNearestAirport(firstCoordRow.lat_deg, firstCoordRow.lon_deg);
      arrivalAirport = findNearestAirport(lastCoordRow.lat_deg, lastCoordRow.lon_deg);
      departureNearbyAirport = departureAirport || findNearestAirportSummary(firstCoordRow.lat_deg, firstCoordRow.lon_deg);
      arrivalNearbyAirport = arrivalAirport || findNearestAirportSummary(lastCoordRow.lat_deg, lastCoordRow.lon_deg);
      
      if (departureAirport && arrivalAirport) {
        route = `${departureAirport.icao} → ${arrivalAirport.icao}`;
      }

      if (route) {
        displayRouteLabel = route;
      } else if (departureNearbyAirport && arrivalNearbyAirport) {
        displayRouteLabel = departureNearbyAirport.icao === arrivalNearbyAirport.icao
          ? `NEAR ${departureNearbyAirport.icao}`
          : `NEAR ${departureNearbyAirport.icao} → NEAR ${arrivalNearbyAirport.icao}`;
      } else if (departureNearbyAirport) {
        displayRouteLabel = `NEAR ${departureNearbyAirport.icao}`;
      } else if (arrivalNearbyAirport) {
        displayRouteLabel = `NEAR ${arrivalNearbyAirport.icao}`;
      }
    } else if (firstCoordRow || lastCoordRow) {
      const coordRow = firstCoordRow || lastCoordRow;
      const nearby = findNearestAirportSummary(coordRow.lat_deg, coordRow.lon_deg);
      if (nearby) {
        displayRouteLabel = `NEAR ${nearby.icao}`;
        departureNearbyAirport = nearby;
      }
    }
      
    if (firstRow && lastRow) {
      // Calculate duration
      const startTs = getRowTimestampMs(firstRow);
      const endTs = getRowTimestampMs(lastRow);
      if (Number.isFinite(startTs) && Number.isFinite(endTs) && endTs >= startTs) {
        durationFormatted = formatDuration(endTs - startTs);
      }
    }
    
    return {
      filePath,
      flightId,
      timestamp: stat.mtime,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      csvMtimeMs: stat.mtimeMs,
      csvSizeBytes: stat.size,
      aircraft: typeof firstRow?.aircraft === 'string' && firstRow.aircraft.trim()
        ? firstRow.aircraft.trim()
        : (typeof firstCoordRow?.aircraft === 'string' && firstCoordRow.aircraft.trim()
          ? firstCoordRow.aircraft.trim()
          : null),
      aircraftProfileId: aircraftProfileId || getReplayAircraftProfileId(firstRow, firstCoordRow),
      route,
      displayRouteLabel,
      departureAirport: departureAirport ? { icao: departureAirport.icao, name: departureAirport.name } : null,
      arrivalAirport: arrivalAirport ? { icao: arrivalAirport.icao, name: arrivalAirport.name } : null,
      departureNearbyAirport: departureNearbyAirport ? { icao: departureNearbyAirport.icao, name: departureNearbyAirport.name } : null,
      arrivalNearbyAirport: arrivalNearbyAirport ? { icao: arrivalNearbyAirport.icao, name: arrivalNearbyAirport.name } : null,
      durationFormatted,
      distanceNm,
      fuelBurnGal: fuelUsage.fuelBurnGal,
      fuelBurnWeightLbs: fuelUsage.fuelBurnWeightLbs,
      fuelBurnSource: fuelUsage.fuelBurnSource,
      sampleCount,
      eventCount: sampleCount > 0 ? sampleCount : (rowCount > 0 ? rowCount : null),
      recordingBundleStrict: strictBundle,
      recordingBundleStatusRequired: bundleStatusRequired,
      recordingSessionId: manifestIdentity?.recordingSessionId || null,
      recordingStartIso: manifestIdentity?.recordingStartIso || null,
      recordingStartEpochMs: Number.isSafeInteger(manifestIdentity?.recordingStartEpochMs)
        ? manifestIdentity.recordingStartEpochMs
        : null,
      recordingFlightId: manifestIdentity?.flightId || null,
    };
}

/**
 * Inspect one already-authorized historic CSV without walking the whole flight
 * logs directory. The background history indexer uses this to checkpoint one
 * source at a time and yield between large files.
 */
function buildListedCsvFlightFromPath(filePath: string): AnyRecord | null {
  let stat: import('fs').Stats;
  try {
    const pinned = openPinnedRegularCsvForListing(filePath);
    stat = pinned.stat;
    fs.closeSync(pinned.fd);
  } catch {
    return null;
  }
  const bundle = recordingBundleLayout.getBundleFromCsvPath(filePath);
  const built = buildListedCsvFlight(filePath, bundle?.bundleName || path.basename(filePath), stat);
  if (!built || !shouldListCsvFlight(built.sampleCount)) return null;
  return decorateListedFlightBundleStatus(built);
}

function decorateListedFlightBundleStatus(flight: AnyRecord | null): AnyRecord | null {
  if (!flight) return null;
  if (flight.recordingBundleStatusRequired !== true) {
    const catalog = inspectCsvBundleForCatalogSync(flight.filePath);
    return {
      ...flight,
      recordingBundleStatus: flight.recordingBundleStrict === true ? catalog.state : 'not_required',
      recordingBundleHealthy: flight.recordingBundleStrict === true && !catalog.allowed ? false : null,
      ...(Number.isSafeInteger(catalog.catalogRevision)
        ? {
            recordingBundleCatalogRevision: catalog.catalogRevision,
            recordingBundleSizeBytes: catalog.bundleSizeBytes,
            sizeBytes: catalog.bundleSizeBytes,
          }
        : {}),
      ...(catalog.error ? { recordingBundleStatusError: catalog.error } : {}),
    };
  }
  if (
    !flight.recordingFlightId
    || !flight.recordingSessionId
    || !Number.isSafeInteger(flight.recordingStartEpochMs)
    || Date.parse(flight.recordingStartIso) !== flight.recordingStartEpochMs
  ) {
    const catalog = inspectCsvBundleForCatalogSync(flight.filePath);
    return {
      ...flight,
      recordingBundleStatus: 'corrupt',
      recordingBundleHealthy: false,
      recordingBundleStatusError: 'Recording manifest identity is invalid.',
      ...(Number.isSafeInteger(catalog.catalogRevision)
        ? {
            recordingBundleCatalogRevision: catalog.catalogRevision,
            recordingBundleSizeBytes: catalog.bundleSizeBytes,
            sizeBytes: catalog.bundleSizeBytes,
          }
        : {}),
    };
  }
  const status = inspectRecordingBundleStatusSync(flight.filePath, {
    flightId: flight.recordingFlightId,
    recordingSessionId: flight.recordingSessionId,
    recordingStartEpochMs: flight.recordingStartEpochMs,
    recordingStartIso: flight.recordingStartIso,
  });
  return {
    ...flight,
    recordingBundleStatus: status.state,
    // Listing validates the small certificate plus exact member names/sizes.
    // Full SHA-256 verification happens when Timeline opens the bundle, so do
    // not present a metadata-only check as end-to-end byte health.
    recordingBundleHealthy: status.state === 'complete' ? null : false,
    recordingBundleIntegrity: status.state === 'complete'
      ? 'completion_metadata_verified'
      : 'unhealthy',
    ...(Number.isSafeInteger(status.catalogRevision)
      ? {
          recordingBundleCatalogRevision: status.catalogRevision,
          recordingBundleSizeBytes: status.bundleSizeBytes,
          sizeBytes: status.bundleSizeBytes,
        }
      : {}),
    ...(status.error ? { recordingBundleStatusError: status.error } : {}),
  };
}

/**
 * List all CSV flight log files with metadata extracted from CSV contents.
 * @returns {{ filePath: string, flightId: string, timestamp: Date, route?: string, displayRouteLabel?: string, departureAirport?: Object, arrivalAirport?: Object, departureNearbyAirport?: Object, arrivalNearbyAirport?: Object, durationFormatted?: string, eventCount?: number, sampleCount?: number }[]}
 */
function listCSVFlights(options: {
  allowedCsvPaths?: string[];
  skipDeleteRecovery?: boolean;
} = {}): AnyRecord[] {
  const flightLogsDir = getFlightLogsDir();

  if (!fs.existsSync(flightLogsDir)) {
    return [];
  }

  if (options.skipDeleteRecovery !== true) {
    recoverInterruptedBundleDeletes(flightLogsDir);
  }

  const files = Array.isArray(options.allowedCsvPaths)
    ? Array.from(new Map(options.allowedCsvPaths.map((filePath) => {
        const resolved = path.resolve(String(filePath));
        const comparable = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        return [comparable, resolved] as const;
      })).values())
    : recordingBundleLayout.listBundleCsvPaths(flightLogsDir);
  const cache = readFlightListMetadataCache();
  const nextCache = createEmptyFlightListMetadataCache();
  let cacheChanged = false;

  const flights = files.map(filePath => {
    let stat: import('fs').Stats;
    try {
      const pinned = openPinnedRegularCsvForListing(filePath);
      stat = pinned.stat;
      fs.closeSync(pinned.fd);
    } catch {
      cacheChanged = true;
      return null;
    }
    const cachedFlight = getCachedListedFlight(cache, filePath, stat);
    if (cachedFlight !== undefined) {
      nextCache.entries[filePath] = cache.entries[filePath];
      return decorateListedFlightBundleStatus(cachedFlight);
    }

    const bundle = recordingBundleLayout.getBundleFromCsvPath(filePath);
    const builtFlight = buildListedCsvFlight(filePath, bundle?.bundleName || path.basename(filePath), stat);
    const listedFlight = builtFlight && shouldListCsvFlight(builtFlight.sampleCount) ? builtFlight : null;
    nextCache.entries[filePath] = buildFlightListCacheEntry(stat, listedFlight);
    cacheChanged = true;
    return decorateListedFlightBundleStatus(listedFlight);
  }).filter(Boolean)
    .sort((a, b) => b.timestamp - a.timestamp); // Most recent first

  const previousKeys = Object.keys(cache.entries || {});
  const nextKeys = Object.keys(nextCache.entries || {});
  if (!cacheChanged && previousKeys.length !== nextKeys.length) {
    cacheChanged = true;
  }
  if (!cacheChanged) {
    const nextKeySet = new Set(nextKeys);
    cacheChanged = previousKeys.some((key) => !nextKeySet.has(key));
  }
  if (cacheChanged) {
    writeFlightListMetadataCache(nextCache);
  }

  return flights;
}

// ═══════════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════════
// Storage management — disk-usage info and safe deletion. CSVs accumulate fast
// (a single ~hour flight at 10 Hz is ~3-5 MB), so the UI surfaces both the
// folder path and per-flight delete buttons.
// ═══════════════════════════════════════════════════════════════════════════

function getFlightLogsDir(): string {
  return resolveFlightLogsDir();
}

const DELETE_INTENT_FILE = '.ff-delete-intent.json';
const DELETE_INTENT_KIND = 'flight_fabric_bundle_delete_intent';
const DELETE_INTENT_SCHEMA_VERSION = 1;

function readDeleteIntent(bundleDir: string): AnyRecord | null {
  const intentPath = path.join(bundleDir, DELETE_INTENT_FILE);
  try {
    const stat = fs.lstatSync(intentPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 16 * 1024) return null;
    const parsed = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
    if (
      parsed?.schemaVersion !== DELETE_INTENT_SCHEMA_VERSION
      || parsed?.kind !== DELETE_INTENT_KIND
      || typeof parsed?.bundleName !== 'string'
      || typeof parsed?.token !== 'string'
      || !/^\d+-\d+-[a-f0-9]+$/.test(parsed.token)
      || typeof parsed?.recordingSessionId !== 'string'
      || !parsed.recordingSessionId
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function cleanupCommittedBundleDelete(rootDir: string, stagedDir: string, bundleName: string, token: string): boolean {
  const intent = readDeleteIntent(stagedDir);
  if (!intent || intent.bundleName !== bundleName || intent.token !== token) return false;
  const allowedNames = new Set([...Object.values(recordingBundleLayout.BUNDLE_FILES), DELETE_INTENT_FILE]);
  let entries: import('fs').Dirent[];
  try {
    const stat = fs.lstatSync(stagedDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(stagedDir) !== path.resolve(rootDir)) return false;
    entries = fs.readdirSync(stagedDir, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !allowedNames.has(entry.name))) return false;
  } catch {
    return false;
  }
  const csvPath = path.join(stagedDir, recordingBundleLayout.BUNDLE_FILES.csv);
  const csvIdentity = readCsvRecordingIdentity(csvPath);
  if (!csvIdentity || csvIdentity.recordingSessionId !== intent.recordingSessionId) return false;
  const cleanupOrder = [
    ...entries.filter((entry) => entry.name !== recordingBundleLayout.BUNDLE_FILES.csv && entry.name !== DELETE_INTENT_FILE),
    ...entries.filter((entry) => entry.name === recordingBundleLayout.BUNDLE_FILES.csv),
    ...entries.filter((entry) => entry.name === DELETE_INTENT_FILE),
  ];
  for (const entry of cleanupOrder) {
    try {
      safeUnlinkSync({
        operation: 'cleanup committed recording bundle delete',
        rootDir: stagedDir,
        targetPath: path.join(stagedDir, entry.name),
      });
    } catch {
      return false;
    }
  }
  try {
    fs.rmdirSync(stagedDir);
    return true;
  } catch {
    return false;
  }
}

function recoverInterruptedBundleDeletes(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const match = /^(.*)\.ff-delete-(\d+-\d+-[a-f0-9]+)$/.exec(entry.name);
    if (match) {
      cleanupCommittedBundleDelete(path.resolve(dir), path.join(dir, entry.name), match[1], match[2]);
      continue;
    }
    // A crash before the atomic directory rename can leave only our intent
    // marker in the still-visible bundle. Remove that marker after matching it
    // to the directory and the recording-session identity; no flight data moves.
    const bundleDir = path.join(dir, entry.name);
    const intent = readDeleteIntent(bundleDir);
    if (!intent || intent.bundleName !== entry.name) continue;
    const csvIdentity = readCsvRecordingIdentity(path.join(bundleDir, recordingBundleLayout.BUNDLE_FILES.csv));
    if (!csvIdentity || csvIdentity.recordingSessionId !== intent.recordingSessionId) continue;
    try {
      safeUnlinkSync({
        allowedExtensions: ['.json'],
        operation: 'recover uncommitted recording bundle delete intent',
        rootDir: bundleDir,
        targetPath: path.join(bundleDir, DELETE_INTENT_FILE),
      });
    } catch {}
  }
}

/**
 * Return total disk usage of the flight-logs directory plus file count.
 * Used by the Timeline tab's storage banner.
 */
function getFlightLogsStorageInfo(options: { allowedCsvPaths?: string[] } = {}): AnyRecord {
  return getFlightLogsStorageSummary(options);
}

/**
 * Delete a flight-log CSV. The path is validated to be inside the flight-logs
 * directory so a malicious / mistaken WS message cannot delete arbitrary files.
 *
 * @param {string} filePath  absolute path to a CSV
 * @returns {{ success: boolean, error?: string, deleted?: string }}
 */
function hasExpectedFileIdentity(stat: import('fs').Stats, expected: DeleteFlightCsvExpectedIdentity | null | undefined): boolean {
  if (!expected || typeof expected !== 'object') return false;

  const expectedSizeBytes = Number(expected.sizeBytes);
  const expectedMtimeMs = Number(expected.mtimeMs);
  if (!Number.isFinite(expectedSizeBytes) || !Number.isFinite(expectedMtimeMs)) return false;
  if (stat.size !== expectedSizeBytes) return false;

  return Math.abs(stat.mtimeMs - expectedMtimeMs) <= DELETE_MTIME_TOLERANCE_MS;
}

type StableFileIdentity = { dev: number; ino: number };

function captureStableFileIdentity(filePath: string): StableFileIdentity {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Recording bundle member is not a regular file');
  }
  return { dev: stat.dev, ino: stat.ino };
}

function assertStableFileIdentity(filePath: string, expected: StableFileIdentity): void {
  const actual = captureStableFileIdentity(filePath);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error('Recording bundle member changed during delete');
  }
}

function readCsvRecordingIdentity(filePath: string): AnyRecord | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const lines = splitCsvLines(buffer.toString('utf8', 0, bytesRead), { trimAndDropEmpty: true });
    if (lines.length < 2) return null;
    const headers = parseCsvLine(lines[0], { trimValues: true });
    const values = parseCsvLine(lines[1], { trimValues: true });
    const value = (name: string) => {
      const index = headers.indexOf(name);
      return index >= 0 ? String(values[index] || '') : '';
    };
    return {
      flightId: value('flight_id'),
      recordingSessionId: value('recording_session_id'),
      flightStartIso: value('flight_start_iso'),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function readJsonlRecordingIdentity(filePath: string): AnyRecord | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const line = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/).find((entry) => entry.trim());
    if (!line) return null;
    const row = JSON.parse(line);
    return {
      flightId: String(row.flightId || ''),
      recordingSessionId: String(row.recordingSessionId || ''),
      flightStartIso: String(row.flightStartIso || ''),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function identitiesBelongTogether(csvIdentity: AnyRecord | null, sidecarIdentity: AnyRecord | null): boolean {
  if (!csvIdentity || !sidecarIdentity) return false;
  if (!csvIdentity.flightId || !sidecarIdentity.flightId) return false;
  if (!csvIdentity.flightStartIso || !sidecarIdentity.flightStartIso) return false;
  if (csvIdentity.flightId !== sidecarIdentity.flightId) return false;
  if (csvIdentity.flightStartIso !== sidecarIdentity.flightStartIso) return false;
  if (
    csvIdentity.recordingSessionId
    && sidecarIdentity.recordingSessionId !== csvIdentity.recordingSessionId
  ) return false;
  return true;
}

function deleteFlightCsv(
  filePath: string,
  expectedIdentity?: DeleteFlightCsvExpectedIdentity | null,
): { success: boolean; error?: string; deleted?: string } {
  if (typeof filePath !== 'string' || !filePath) {
    return { success: false, error: 'filePath is required' };
  }
  const dir = path.resolve(getFlightLogsDir());
  recoverInterruptedBundleDeletes(dir);
  const resolved = path.resolve(filePath);
  const bundle = recordingBundleLayout.getBundleFromCsvPath(resolved);
  const samePath = (left: string, right: string) => (
    process.platform === 'win32'
      ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
      : path.resolve(left) === path.resolve(right)
  );
  if (
    !bundle
    || !samePath(bundle.outputDir, dir)
    || !samePath(bundle.paths.csv, resolved)
    || !isPathInside(dir, resolved)
  ) return { success: false, error: 'File is not a canonical Flight Fabric recording' };
  let stat: import('fs').Stats;
  try {
    stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('CSV is not a regular file');
  } catch {
    return { success: false, error: 'File not found' };
  }
  if (!hasExpectedFileIdentity(stat, expectedIdentity)) {
    return { success: false, error: 'Flight log changed on disk. Refresh the list and try again.' };
  }
  try {
    const bundleDir = path.dirname(resolved);
    const bundleDirStat = fs.lstatSync(bundleDir);
    if (
      !bundleDirStat.isDirectory()
      || bundleDirStat.isSymbolicLink()
      || !samePath(path.dirname(bundleDir), dir)
    ) throw new Error('Recording bundle directory is unsafe');

    const allowedNames = new Set(Object.values(recordingBundleLayout.BUNDLE_FILES));
    const directoryEntries = fs.readdirSync(bundleDir, { withFileTypes: true });
    if (directoryEntries.some((entry) => (
      !entry.isFile()
      || entry.isSymbolicLink()
      || !allowedNames.has(entry.name)
    ))) {
      return { success: false, error: 'Recording folder contains unrecognized files; delete was refused' };
    }

    const sidecars = [
      {
        operation: 'deleteFlightCsvAutomationSidecar',
        filePath: bundle.paths.automation,
        allowedExtensions: ['.jsonl'],
        kind: 'jsonl',
      },
      {
        operation: 'deleteFlightCsvAircraftSpecificSidecar',
        filePath: bundle.paths.aircraftSpecific,
        allowedExtensions: ['.jsonl'],
        kind: 'jsonl',
      },
      {
        operation: 'deleteFlightCsvBundleStatus',
        filePath: bundle.paths.status,
        allowedExtensions: ['.json'],
        kind: 'bundle-status',
      },
      {
        operation: 'deleteFlightCsvHistorySummary',
        filePath: bundle.paths.summary,
        allowedExtensions: ['.json'],
        kind: 'history-summary',
      },
      {
        operation: 'deleteFlightCsvTimeline',
        filePath: bundle.paths.timeline,
        allowedExtensions: ['.json'],
        kind: 'derived',
      },
    ];
    if (fs.existsSync(bundle.paths.summary) && !isOwnedHistorySummaryForCsv(bundle.paths.summary, resolved)) {
      return { success: false, error: 'Recording summary ownership could not be verified' };
    }
    const existingSidecars = sidecars
      .filter((sidecar) => (
        sidecar.filePath !== resolved
        && isPathInside(bundleDir, sidecar.filePath)
        && fs.existsSync(sidecar.filePath)
        && (sidecar.kind !== 'history-summary' || isOwnedHistorySummaryForCsv(sidecar.filePath, resolved))
      ));

    // Preflight every bundle member before deleting any one of them. This keeps
    // a malformed/refused second sidecar from causing the first sidecar to be
    // irreversibly removed while the authoritative CSV remains retryable.
    for (const sidecar of existingSidecars) {
      assertSafeFileTarget({
        allowedExtensions: sidecar.allowedExtensions,
        operation: `${sidecar.operation}:preflight`,
        rootDir: bundleDir,
        targetPath: sidecar.filePath,
      });
    }
    assertSafeFileTarget({
      allowedExtensions: ['.csv'],
      operation: 'deleteFlightCsv:preflight',
      rootDir: bundleDir,
      targetPath: resolved,
    });

    const members = [
      ...existingSidecars.map((sidecar) => ({
        operation: sidecar.operation,
        filePath: sidecar.filePath,
      })),
      { operation: 'deleteFlightCsv', filePath: resolved },
    ].map((member) => ({
      ...member,
      stableIdentity: captureStableFileIdentity(member.filePath),
    }));

    const csvIdentity = readCsvRecordingIdentity(resolved);
    if (!csvIdentity?.recordingSessionId) {
      return { success: false, error: 'Recording identity is missing; delete was refused' };
    }
    for (const sidecar of existingSidecars) {
      // The history summary is a derived, schema-marked Flight Fabric cache.
      // Its ownership was validated above; it need not duplicate legacy CSV
      // manifest fields in order to be removed with its source bundle.
      if (sidecar.kind === 'history-summary' || sidecar.kind === 'derived') continue;
      const sidecarStat = fs.statSync(sidecar.filePath);
      const sidecarIdentity = sidecar.kind === 'bundle-status'
        ? (() => {
            const status = readRecordingBundleStatusSync(resolved);
            return status.certificate ? {
              flightId: String(status.certificate.flightId || ''),
              recordingSessionId: String(status.certificate.recordingSessionId || ''),
              flightStartIso: String(status.certificate.recordingStartIso || ''),
            } : null;
          })()
        : readJsonlRecordingIdentity(sidecar.filePath);
      // A pre-manifest quick start/stop could leave an empty claimed sidecar.
      // It contains no unrelated history to protect and is still inode-guarded
      // by the delete transaction below.
      if (sidecarStat.size > 0 && !identitiesBelongTogether(csvIdentity, sidecarIdentity)) {
        return { success: false, error: 'Recording companion identity does not match the CSV' };
      }
    }
    // Identity reads use paths, so re-check each inode before the transaction
    // begins. A concurrent replacement cannot inherit the earlier validation.
    for (const member of members) {
      assertStableFileIdentity(member.filePath, member.stableIdentity);
    }

    const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const intentPath = path.join(bundleDir, DELETE_INTENT_FILE);
    safeReplaceTextFileSync({
      allowedExtensions: ['.json'],
      data: `${JSON.stringify({
        schemaVersion: DELETE_INTENT_SCHEMA_VERSION,
        kind: DELETE_INTENT_KIND,
        bundleName: bundle.bundleName,
        token,
        recordingSessionId: csvIdentity.recordingSessionId,
      })}\n`,
      operation: 'write recording bundle delete intent',
      rootDir: bundleDir,
      targetPath: intentPath,
    });
    for (const member of members) assertStableFileIdentity(member.filePath, member.stableIdentity);
    const currentBundleDirStat = fs.lstatSync(bundleDir);
    if (
      currentBundleDirStat.dev !== bundleDirStat.dev
      || currentBundleDirStat.ino !== bundleDirStat.ino
      || currentBundleDirStat.isSymbolicLink()
    ) throw new Error('Recording bundle directory changed during delete');

    const stagedDir = path.join(dir, `${bundle.bundleName}.ff-delete-${token}`);
    if (fs.existsSync(stagedDir)) throw new Error('Delete staging collision');
    fs.renameSync(bundleDir, stagedDir);
    cleanupCommittedBundleDelete(dir, stagedDir, bundle.bundleName, token);
    return { success: true, deleted: resolved };
  } catch (err) {
    // Use error code only — err.message often contains full file paths
    return { success: false, error: err.code ? `Delete failed: ${err.code}` : 'Delete failed' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  CURRENT_ANALYSIS_RESCORE_CONTRACT,
  parseCSV,
  generateFromCSV,
  generateAndSave,
  generateMissing,
  listCSVFlights,
  buildListedCsvFlightFromPath,
  recoverInterruptedBundleDeletes,
  getFlightLogsDir,
  getFlightLogsStorageInfo,
  deleteFlightCsv,
  STABILITY_THRESHOLDS,
  // Test-only exports — not stable API
  _quickPeekCSV: quickPeekCSV,
  _csvRowToStabilityFrame: csvRowToStabilityFrame,
  _downsampleApproachProfile: downsampleApproachProfile,
  _generateFromCSVInProcess: generateFromCSVInProcess,
  _generateFromCSVIsolated: generateFromCSVIsolated,
  _generateTimelineFromRows: generateTimelineFromRows,
  _toFiniteNumber: toFiniteNumber,
};

// CLI support
if (require.main === module) {
  const args = process.argv.slice(2);
  
  (async () => {
  if (args.includes('--generate-missing') || args.includes('-m')) {
    console.log('Generating missing timelines...\n');
    const results = await generateMissing();
    console.log(`Generated: ${results.generated}`);
    console.log(`Skipped:   ${results.skipped}`);
    console.log(`Failed:    ${results.failed}`);
    console.log('\nDetails:');
    for (const d of results.details) {
      console.log(`  ${d.file}: ${d.status}${d.eventCount ? ` (${d.eventCount} events)` : ''}${d.error ? ` - ${d.error}` : ''}`);
    }
  } else if (args.length > 0) {
    // Generate for specific file
    const csvPath = args[0];
    console.log(`Generating timeline for: ${csvPath}`);
    const result = await generateAndSave(csvPath);
    if (result.success) {
      console.log(`Saved: ${result.filePath} (${result.timeline.eventCount} events)`);
    } else {
      console.error(`Error: ${'error' in result ? result.error : 'Generation failed'}`);
      process.exit(1);
    }
  } else {
    console.log('Timeline Generator');
    console.log('==================');
    console.log('Usage:');
    console.log('  node timeline-generator.js <csv-file>     Generate timeline for specific CSV');
    console.log('  node timeline-generator.js --generate-missing  Generate all missing timelines');
    console.log('  node timeline-generator.js -m             Same as --generate-missing');
  }
  })().catch(err => { console.error(err); process.exit(1); });
}

export {};
