'use strict';

const fs = require('fs');
const path = require('path');
const timeSource = require('../core/time-source') as TimeSourceModule;
const { resolveFlightLogsDir } = require('../utils/flight-logs-dir') as {
  resolveFlightLogsDir: (options?: { createIfMissing?: boolean }) => string;
};
const recordingBundleLayout = require('./recording-bundle-layout') as {
  BUNDLE_FILES: { automation: string };
  buildBundleName: (_flightId: unknown, _recordingSessionId: unknown) => string;
  getBundlePaths: (_outputDir: string, _bundleName: string) => { dir: string; automation: string };
};
const {
  assertSafeRecordingFilePath,
  createSafeRecordingWriteStream,
  safeRenameRecordingFileSync,
} = require('./recording-path-guard') as {
  assertSafeRecordingFilePath: (_options: {
    extension: string;
    operation: string;
    outputDir: string;
    requiredSuffix?: string;
    targetPath: string;
  }) => string;
  createSafeRecordingWriteStream: (_options: {
    extension: string;
    flags?: string;
    operation: string;
    outputDir: string;
    requiredSuffix?: string;
    targetPath: string;
  }) => FsWriteStream;
  safeRenameRecordingFileSync: (_options: {
    extension: string;
    fromPath: string;
    operation: string;
    outputDir: string;
    requiredSuffix?: string;
    toPath: string;
  }) => boolean;
};
const {
  closeWriteStreamDurably,
  flushWriteStreamDurably,
} = require('./recording-stream-durability') as {
  closeWriteStreamDurably: (_stream: FsWriteStream) => Promise<void>;
  flushWriteStreamDurably: (_stream: FsWriteStream) => Promise<void>;
};

type TimeSourceModule = {
  now: () => number;
};

type AnyRecord = Record<string, any>;
type AutomationSource = 'simconnect' | 'lvar' | 'sdk' | 'profile' | 'mixed' | 'unknown';
type ConfidenceValue = 'profile-confirmed' | 'simconnect' | 'inferred' | 'unavailable' | 'unreliable';

type AutomationRecorderOptions = {
  flightId?: string;
  recordingSessionId?: string;
  recordingStartEpochMs?: number;
  recordingStartIso?: string;
  bundleBaseName?: string;
  bundleStatusRequired?: boolean;
  outputDir?: string;
  departureIcao?: string | null;
  arrivalIcao?: string | null;
  checkpointIntervalMs?: number;
  syncIntervalMs?: number;
  maxFileBytes?: number;
  onTerminalError?: (_error: Error) => void;
};

type AutomationStateInput = {
  timeMs?: number | null;
  timestampIso?: string | null;
  flightElapsedMs?: number | null;
  flightId?: string | null;
  flightStartIso?: string | null;
  aircraftProfileId?: string | null;
  aircraftTitle?: string | null;
  dataSource?: string | null;
  source?: AutomationSource;
  fdm?: AnyRecord | null;
  baseFdm?: AnyRecord | null;
  simconnect?: AnyRecord | null;
  reliability?: {
    apReliable?: boolean | null;
    athrReliable?: boolean | null;
    reason?: string | null;
  } | null;
  sourceContext?: {
    lvarSidecarConnected?: boolean;
    lvarHasData?: boolean;
    lvarHasAutopilotData?: boolean;
    lvarHasAutothrottleData?: boolean;
    sdkConnected?: boolean;
    sdkHasData?: boolean;
    sdkHasAutomationData?: boolean;
    lvarValues?: AnyRecord | null;
    sdkValues?: AnyRecord | null;
    sdkNormalized?: AnyRecord | null;
    lvarSidecarSource?: AnyRecord | null;
    sdkSource?: AnyRecord | null;
  } | null;
};

type AutomationRecorderStats = {
  flightId: string | undefined;
  recordingSessionId: string | undefined;
  bundleStatusRequired: boolean;
  recordingStartEpochMs: number;
  recordingStartIso: string;
  bundleBaseName: string;
  filePath: string;
  filename: string;
  outputDir: string;
  rowCount: number;
  fileSizeBytes: number;
  fileSizeKb: number;
  hasError: boolean;
  lastError: string | undefined;
  creationIdentity: { dev: number; ino: number } | null;
};

type AutomationSnapshot = {
  meta: AnyRecord;
  raw: AnyRecord;
  state: AnyRecord;
  confidence: Record<string, ConfidenceValue>;
};

type FsWriteStream = import('fs').WriteStream & {
  fd?: number | null;
};

const AUTOMATION_SCHEMA_VERSION = 2;
// The reader processes the append-only log from the beginning, so periodic
// full-state rewrites do not improve crash-tail recovery. First/final
// checkpoints and deltas are sufficient; callers can still opt into periodic
// diagnostic checkpoints by supplying a positive interval.
const DEFAULT_CHECKPOINT_INTERVAL_MS = 0;
const DEFAULT_SYNC_INTERVAL_MS = 30000;
const DEFAULT_MAX_AUTOMATION_FILE_BYTES = 200 * 1024 * 1024;
const JSONL_RENAME_QUEUE_MAX_BYTES = 8 * 1024 * 1024;
const JSONL_STREAM_BACKLOG_MAX_BYTES = 16 * 1024 * 1024;

const AP_MODE_FIELDS = Object.freeze([
  'apHdgHold',
  'apNavHold',
  'apLnavHold',
  'apLocHold',
  'apAltHold',
  'apVsHold',
  'apVnavHold',
  'apLvlChgHold',
  'apFlcHold',
  'apExpedHold',
  'apApprHold',
  'apSpeedHold',
]);

const AUTOMATION_FDM_FIELDS = Object.freeze([
  'apMaster',
  'apFdActive',
  'athrArmed',
  'athrActive',
  ...AP_MODE_FIELDS,
  'apHdgTargetDeg',
  'apAltTargetFt',
  'apVsTargetFpm',
  'apSpeedTargetKts',
  'apMachTarget',
]);

const AP_STATE_FIELDS = Object.freeze([
  'apMaster',
  'apFdActive',
  ...AP_MODE_FIELDS,
  'apHdgTargetDeg',
  'apAltTargetFt',
  'apVsTargetFpm',
  'apSpeedTargetKts',
  'apMachTarget',
]);

const ATHR_STATE_FIELDS = Object.freeze([
  'athrArmed',
  'athrActive',
]);

const AUTOMATION_LVAR_KEYS = Object.freeze([
  'autopilot',
  'autothrottle',
  'ap_channel_a',
  'ap_channel_b',
  'mode_speed',
  'mode_lnav',
  'mode_vnav',
  'mode_loc',
  'mode_app',
  'mode_heading',
  'mode_altitude_hold',
  'mode_vertical_speed',
  'mode_flc',
  'mode_expedite',
  'selected_heading',
  'selected_speed',
  'selected_altitude',
  'selected_vertical_speed',
]);

const AUTOMATION_SDK_RAW_KEYS = Object.freeze([
  'ap',
  'fd',
  'fd_l',
  'fd_r',
  'at',
  'at_armed',
  'at_arm_l',
  'at_arm_r',
  'mcp_lnav',
  'mcp_vnav',
  'mcp_flch',
  'mcp_hdg_hold',
  'mcp_vs_fpa',
  'mcp_alt_hold',
  'mcp_loc',
  'mcp_app',
  'mcp_speed_kts',
  'mcp_mach',
  'mcp_heading',
  'mcp_altitude',
  'mcp_vs',
]);

const NUMERIC_THRESHOLDS: Record<string, number> = Object.freeze({
  selectedHeadingDeg: 1,
  selectedAltitudeFt: 100,
  selectedSpeedKt: 1,
  selectedMach: 0.01,
  selectedVsFpm: 100,
  selectedFpaDeg: 0.1,
});

let activeRecorder: AutomationJsonlRecorder | null = null;

function getDefaultFlightLogsDir(): string {
  return resolveFlightLogsDir({ createIfMissing: true });
}

function sanitizeFlightId(flightId: string | null | undefined): string {
  if (!flightId) return 'unknown-flight';
  return String(flightId)
    .replace(/\.\d{3}Z$/, '')
    .replace(/Z$/, '')
    .replace(/:/g, '-');
}

function generateCsvBaseFilename(
  flightId: string | null | undefined,
  departureIcao: string | null | undefined,
  arrivalIcao: string | null | undefined,
): string {
  const base = sanitizeFlightId(flightId);

  if (departureIcao && arrivalIcao) return `${base}_${departureIcao}-${arrivalIcao}.csv`;
  if (arrivalIcao) return `${base}_to-${arrivalIcao}.csv`;
  if (departureIcao) return `${base}_from-${departureIcao}.csv`;
  return `${base}.csv`;
}

function generateFilename(
  flightId: string | null | undefined,
  departureIcao: string | null | undefined,
  arrivalIcao: string | null | undefined,
): string {
  const csvFilename = generateCsvBaseFilename(flightId, departureIcao, arrivalIcao);
  return csvFilename.replace(/\.csv$/i, '.automation.jsonl');
}

function isRecord(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteNumberOrNull(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function boolForRecordingWithBaseCrossCheck(overlayValue: unknown, baseValue: unknown): boolean | null {
  const overlayBool = boolOrNull(overlayValue);
  const baseBool = boolOrNull(baseValue);
  if (overlayBool === false && baseBool === true) return true;
  return overlayBool;
}

function pickKnownFields(source: AnyRecord | null | undefined, keys: readonly string[]): AnyRecord {
  if (!isRecord(source)) return {};
  const out: AnyRecord = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const value = source[key];
      if (value !== undefined) out[key] = value;
    }
  }
  return out;
}

function sortedClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedClone);
  if (!isRecord(value)) return value;

  const out: AnyRecord = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) out[key] = sortedClone(child);
  }
  return out;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortedClone(value));
}

function jsonlLineBytesWithNewline(line: string): number {
  return Buffer.byteLength(line, 'utf8') + 1;
}

function formatMiB(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

function valuesEqual(previous: unknown, current: unknown, threshold = 0): boolean {
  if (isFiniteNumber(previous) && isFiniteNumber(current) && threshold > 0) {
    return Math.abs(current - previous) < threshold;
  }
  return stableStringify(previous) === stableStringify(current);
}

function diffRecords(previous: AnyRecord | null | undefined, current: AnyRecord, thresholds: Record<string, number> = {}): AnyRecord {
  const prev = isRecord(previous) ? previous : {};
  const out: AnyRecord = {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(current)]);

  for (const key of keys) {
    const nextValue = current[key];
    const prevValue = prev[key];

    if (isRecord(nextValue) && isRecord(prevValue)) {
      const childDiff = diffRecords(prevValue, nextValue, thresholds);
      if (Object.keys(childDiff).length > 0) out[key] = childDiff;
      continue;
    }

    if (!valuesEqual(prevValue, nextValue, thresholds[key] || 0)) {
      out[key] = nextValue ?? null;
    }
  }

  return out;
}

function hasChanges(diff: AnyRecord): boolean {
  return Object.keys(diff).length > 0;
}

function deriveLateralMode(fdm: AnyRecord): string | null {
  if (fdm.apLocHold === true) return 'LOC';
  if (fdm.apLnavHold === true) return 'LNAV';
  if (fdm.apNavHold === true) return 'NAV';
  if (fdm.apHdgHold === true) return 'HDG';
  if (fdm.apApprHold === true) return 'APP';
  return null;
}

function deriveVerticalMode(fdm: AnyRecord): string | null {
  if (fdm.apVnavHold === true) return 'VNAV';
  if (fdm.apLvlChgHold === true || fdm.apFlcHold === true) return 'LVL_CHG';
  if (fdm.apVsHold === true) return 'VS';
  if (fdm.apAltHold === true) return 'ALT';
  if (fdm.apApprHold === true) return 'APP';
  return null;
}

function confidenceForReliability(reliable: boolean | null | undefined, reason: string | null | undefined): ConfidenceValue {
  if (reliable === false) return 'unreliable';
  if (typeof reason === 'string' && (reason.includes('lvar') || reason.includes('sdk'))) return 'profile-confirmed';
  if (reliable === true) return 'simconnect';
  return 'unavailable';
}

function buildAutomationState(input: AutomationStateInput): {
  state: AnyRecord;
  confidence: Record<string, ConfidenceValue>;
} {
  const fdm = isRecord(input.fdm) ? input.fdm : {};
  const baseFdm = isRecord(input.baseFdm) ? input.baseFdm : {};
  const reliability = input.reliability || {};
  const apConfidence = confidenceForReliability(reliability.apReliable, reliability.reason);
  const athrConfidence = confidenceForReliability(reliability.athrReliable, reliability.reason);
  const recordingFdm: AnyRecord = {
    ...fdm,
    apMaster: boolForRecordingWithBaseCrossCheck(fdm.apMaster, baseFdm.apMaster),
    athrActive: boolForRecordingWithBaseCrossCheck(fdm.athrActive, baseFdm.athrActive),
  };
  if (reliability.apReliable === false) {
    for (const field of AP_STATE_FIELDS) recordingFdm[field] = null;
  }
  if (reliability.athrReliable === false) {
    for (const field of ATHR_STATE_FIELDS) recordingFdm[field] = null;
  }

  const state: AnyRecord = {
    apMaster: boolOrNull(recordingFdm.apMaster),
    fdActive: boolOrNull(recordingFdm.apFdActive),
    athrArmed: boolOrNull(recordingFdm.athrArmed),
    athrActive: boolOrNull(recordingFdm.athrActive),
    selectedHeadingDeg: finiteNumberOrNull(recordingFdm.apHdgTargetDeg),
    selectedAltitudeFt: finiteNumberOrNull(recordingFdm.apAltTargetFt),
    selectedSpeedKt: finiteNumberOrNull(recordingFdm.apSpeedTargetKts),
    selectedMach: finiteNumberOrNull(recordingFdm.apMachTarget),
    selectedVsFpm: finiteNumberOrNull(recordingFdm.apVsTargetFpm),
    lateralMode: deriveLateralMode(recordingFdm),
    verticalMode: deriveVerticalMode(recordingFdm),
    modeFlags: pickKnownFields(recordingFdm, AP_MODE_FIELDS),
  };

  const confidence: Record<string, ConfidenceValue> = {
    apMaster: apConfidence,
    fdActive: apConfidence,
    selectedHeadingDeg: apConfidence,
    selectedAltitudeFt: apConfidence,
    selectedSpeedKt: apConfidence,
    selectedMach: apConfidence,
    selectedVsFpm: apConfidence,
    lateralMode: apConfidence,
    verticalMode: apConfidence,
    modeFlags: apConfidence,
    athrArmed: athrConfidence,
    athrActive: athrConfidence,
  };

  return { state, confidence };
}

function buildRawObservation(input: AutomationStateInput): AnyRecord {
  const sourceContext = input.sourceContext || {};
  const simconnectFields = pickKnownFields(input.simconnect, AUTOMATION_FDM_FIELDS);
  const baseFdmFields = pickKnownFields(input.baseFdm, AUTOMATION_FDM_FIELDS);
  const raw: AnyRecord = {
    overlay: pickKnownFields(input.fdm, AUTOMATION_FDM_FIELDS),
    simconnect: Object.keys(simconnectFields).length > 0 ? simconnectFields : baseFdmFields,
  };

  const lvars = pickKnownFields(sourceContext.lvarValues, AUTOMATION_LVAR_KEYS);
  if (Object.keys(lvars).length > 0) raw.lvars = lvars;

  const sdkRaw = pickKnownFields(sourceContext.sdkValues, AUTOMATION_SDK_RAW_KEYS);
  if (Object.keys(sdkRaw).length > 0) raw.sdkRaw = sdkRaw;

  const sdkAutomation = isRecord(sourceContext.sdkNormalized?.automation)
    ? sourceContext.sdkNormalized.automation
    : null;
  if (sdkAutomation && Object.keys(sdkAutomation).length > 0) {
    raw.sdkNormalized = { automation: sortedClone(sdkAutomation) };
  }

  return raw;
}

function hasAnyPopulatedField(record: AnyRecord): boolean {
  return Object.values(record).some((value) => value !== null && value !== undefined);
}

function hasLvarAutomationSourceData(sourceContext: AutomationStateInput['sourceContext']): boolean {
  if (!sourceContext) return false;
  if (sourceContext.lvarHasAutopilotData === true || sourceContext.lvarHasAutothrottleData === true) {
    return true;
  }

  return hasAnyPopulatedField(pickKnownFields(sourceContext.lvarValues, AUTOMATION_LVAR_KEYS));
}

function determineSource(input: AutomationStateInput): AutomationSource {
  if (input.source) return input.source;
  const sourceContext = input.sourceContext || {};
  if (sourceContext.sdkHasAutomationData ?? sourceContext.sdkHasData) return 'sdk';
  if (hasLvarAutomationSourceData(sourceContext)) return 'lvar';
  if (input.simconnect || input.baseFdm || input.fdm) return 'simconnect';
  return 'unknown';
}

function buildSnapshot(input: AutomationStateInput, fallbackFlightId?: string): AutomationSnapshot {
  const { state, confidence } = buildAutomationState(input);
  const sourceContext = input.sourceContext || {};
  const timeMs = isFiniteNumber(input.timeMs) ? input.timeMs : timeSource.now();
  const raw = buildRawObservation(input);

  return {
    meta: {
      timeMs,
      timestampIso: input.timestampIso || new Date(timeMs).toISOString(),
      flightElapsedMs: isFiniteNumber(input.flightElapsedMs) ? input.flightElapsedMs : null,
      flightId: input.flightId || fallbackFlightId || null,
      flightStartIso: input.flightStartIso || null,
      aircraftProfileId: input.aircraftProfileId || 'generic',
      aircraftTitle: input.aircraftTitle || null,
      source: determineSource(input),
      dataSource: input.dataSource || null,
      apReliable: typeof input.reliability?.apReliable === 'boolean' ? input.reliability.apReliable : null,
      athrReliable: typeof input.reliability?.athrReliable === 'boolean' ? input.reliability.athrReliable : null,
      reliabilityReason: input.reliability?.reason || null,
      lvarSidecarConnected: sourceContext.lvarSidecarConnected === true,
      sdkConnected: sourceContext.sdkConnected === true,
    },
    raw,
    state,
    confidence,
  };
}

const COMPACT_CONTEXT_FIELDS = Object.freeze([
  'aircraftProfileId',
  'aircraftTitle',
  'source',
  'dataSource',
  'apReliable',
  'athrReliable',
  'reliabilityReason',
  'lvarSidecarConnected',
  'sdkConnected',
]);

function buildCompactContext(meta: AnyRecord): AnyRecord {
  return pickKnownFields(meta, COMPACT_CONTEXT_FIELDS);
}

function isKnownModeValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function buildEventRows(previousState: AnyRecord, currentState: AnyRecord, stateDiff: AnyRecord): AnyRecord[] {
  const events: AnyRecord[] = [];
  const addChange = (field: string, eventType: string, options: { requireCurrentKnownMode?: boolean } = {}) => {
    if (!Object.prototype.hasOwnProperty.call(stateDiff, field)) return;
    if (options.requireCurrentKnownMode === true && !isKnownModeValue(currentState[field])) return;
    events.push({
      eventType,
      field,
      previous: previousState[field] ?? null,
      current: currentState[field] ?? null,
    });
  };

  if (
    Object.prototype.hasOwnProperty.call(stateDiff, 'apMaster')
    && typeof previousState.apMaster === 'boolean'
    && typeof currentState.apMaster === 'boolean'
  ) {
    events.push({
      eventType: currentState.apMaster === true ? 'ap_engaged' : 'ap_disengaged',
      field: 'apMaster',
      previous: previousState.apMaster ?? null,
      current: currentState.apMaster ?? null,
    });
  }

  addChange('fdActive', 'fd_changed');

  if (
    Object.prototype.hasOwnProperty.call(stateDiff, 'athrArmed')
    && typeof previousState.athrArmed === 'boolean'
    && typeof currentState.athrArmed === 'boolean'
  ) {
    events.push({
      eventType: currentState.athrArmed === true ? 'athr_armed' : 'athr_disarmed',
      field: 'athrArmed',
      previous: previousState.athrArmed ?? null,
      current: currentState.athrArmed ?? null,
    });
  }

  addChange('lateralMode', 'lateral_mode_changed', { requireCurrentKnownMode: true });
  addChange('verticalMode', 'vertical_mode_changed', { requireCurrentKnownMode: true });

  const previousFlags = isRecord(previousState.modeFlags) ? previousState.modeFlags : {};
  const currentFlags = isRecord(currentState.modeFlags) ? currentState.modeFlags : {};
  const modeFlagDiff = isRecord(stateDiff.modeFlags) ? stateDiff.modeFlags : {};

  if (modeFlagDiff.apApprHold === true && previousFlags.apApprHold !== true) {
    events.push({
      eventType: 'approach_armed',
      field: 'modeFlags.apApprHold',
      previous: previousFlags.apApprHold ?? null,
      current: currentFlags.apApprHold ?? null,
    });
  }

  if (modeFlagDiff.apLocHold === true && previousFlags.apLocHold !== true) {
    events.push({
      eventType: 'loc_captured',
      field: 'modeFlags.apLocHold',
      previous: previousFlags.apLocHold ?? null,
      current: currentFlags.apLocHold ?? null,
    });
  }

  return events;
}

class AutomationJsonlRecorder {
  flightId: string | undefined;
  recordingSessionId: string | undefined;
  bundleStatusRequired: boolean;
  recordingStartEpochMs: number;
  recordingStartIso: string;
  bundleBaseName: string;
  outputDir: string;
  departureIcao: string | null;
  arrivalIcao: string | null;
  filename: string;
  filePath: string;
  stream: FsWriteStream | null;
  rowCount: number;
  seq: number;
  lastError: Error | null;
  terminalError: boolean;
  closed: boolean;
  renameInProgress: boolean;
  renamePromise: Promise<boolean> | null;
  renameQueuedLines: string[];
  renameQueuedLineBytes: number;
  checkpointIntervalMs: number;
  lastCheckpointMs: number | null;
  lastSnapshot: AutomationSnapshot | null;
  onTerminalError: ((_error: Error) => void) | null;
  terminalErrorNotified: boolean;
  creationIdentity: { dev: number; ino: number } | null;
  syncIntervalMs: number;
  lastSyncTime: number;
  periodicSyncPromise: Promise<void> | null;
  explicitFlushPromise: Promise<boolean> | null;
  maxFileBytes: number;
  acceptedFileBytes: number;
  periodicSyncTimer: NodeJS.Timeout | null;
  syncDirty: boolean;
  syncCatchUpDue: boolean;

  constructor(options: AutomationRecorderOptions = {}) {
    this.flightId = options.flightId;
    this.recordingSessionId = options.recordingSessionId || options.flightId;
    this.bundleStatusRequired = options.bundleStatusRequired === true;
    if (!this.recordingSessionId || !this.flightId) throw new Error('Automation recording identities are required');
    this.recordingStartEpochMs = Number.isFinite(options.recordingStartEpochMs)
      ? Number(options.recordingStartEpochMs)
      : timeSource.now();
    this.recordingStartIso = options.recordingStartIso || new Date(this.recordingStartEpochMs).toISOString();
    if (Date.parse(this.recordingStartIso) !== this.recordingStartEpochMs) {
      throw new Error('Automation recording start clock is inconsistent');
    }
    const flightLogsDir = options.outputDir || getDefaultFlightLogsDir();
    this.departureIcao = options.departureIcao || null;
    this.arrivalIcao = options.arrivalIcao || null;
    this.bundleBaseName = options.bundleBaseName
      || recordingBundleLayout.buildBundleName(this.recordingStartIso, this.recordingSessionId);
    const bundlePaths = recordingBundleLayout.getBundlePaths(flightLogsDir, this.bundleBaseName);
    this.outputDir = bundlePaths.dir;
    this.filename = recordingBundleLayout.BUNDLE_FILES.automation;
    this.filePath = bundlePaths.automation;
    this.stream = null;
    this.rowCount = 0;
    this.seq = 0;
    this.lastError = null;
    this.terminalError = false;
    this.closed = false;
    this.renameInProgress = false;
    this.renamePromise = null;
    this.renameQueuedLines = [];
    this.renameQueuedLineBytes = 0;
    this.checkpointIntervalMs = options.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS;
    this.lastCheckpointMs = null;
    this.lastSnapshot = null;
    this.onTerminalError = typeof options.onTerminalError === 'function' ? options.onTerminalError : null;
    this.terminalErrorNotified = false;
    this.creationIdentity = null;
    this.syncIntervalMs = Number.isFinite(options.syncIntervalMs)
      ? Math.max(0, Number(options.syncIntervalMs))
      : DEFAULT_SYNC_INTERVAL_MS;
    this.lastSyncTime = timeSource.now();
    this.periodicSyncPromise = null;
    this.explicitFlushPromise = null;
    this.maxFileBytes = Number.isFinite(options.maxFileBytes)
      ? Math.max(1, Math.floor(Number(options.maxFileBytes)))
      : DEFAULT_MAX_AUTOMATION_FILE_BYTES;
    this.acceptedFileBytes = 0;
    this.periodicSyncTimer = null;
    this.syncDirty = false;
    this.syncCatchUpDue = false;
  }

  recordTerminalError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.lastError = normalized;
    this.terminalError = true;
    this.clearPeriodicSyncTimer();
    if (this.terminalErrorNotified) return;
    this.terminalErrorNotified = true;
    try { this.onTerminalError?.(normalized); } catch {}
  }

  startPeriodicSyncTimer(): void {
    if (this.periodicSyncTimer || this.syncIntervalMs <= 0) return;
    this.periodicSyncTimer = setInterval(() => {
      const stream = this.stream;
      if (!this.closed && !this.terminalError && stream) this.scheduleSyncIfDue(stream, true);
    }, this.syncIntervalMs);
    this.periodicSyncTimer.unref?.();
  }

  clearPeriodicSyncTimer(): void {
    if (this.periodicSyncTimer) clearInterval(this.periodicSyncTimer);
    this.periodicSyncTimer = null;
  }

  scheduleSyncIfDue(stream: FsWriteStream, force = false): void {
    const now = timeSource.now();
    if (this.periodicSyncPromise) {
      if (force) this.syncCatchUpDue = true;
      return;
    }
    if (
      !this.syncDirty
      || (!force && this.syncIntervalMs > 0 && now - this.lastSyncTime <= this.syncIntervalMs)
      || typeof stream.fd !== 'number'
    ) return;

    this.syncDirty = false;
    this.syncCatchUpDue = false;
    const pending = (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          stream.write('', (error?: Error | null) => error ? reject(error) : resolve());
        });
        if (typeof stream.fd !== 'number') {
          throw new Error('Automation JSONL periodic sync file descriptor is unavailable');
        }
        await new Promise<void>((resolve, reject) => {
          fs.fdatasync(stream.fd as number, (error: NodeJS.ErrnoException | null) => (
            error ? reject(error) : resolve()
          ));
        });
        this.lastSyncTime = now;
      } catch (error) {
        this.recordTerminalError(error);
      }
    })().finally(() => {
      if (this.periodicSyncPromise === pending) this.periodicSyncPromise = null;
      const shouldCatchUp = this.syncCatchUpDue || this.syncIntervalMs <= 0;
      this.syncCatchUpDue = false;
      if (
        this.syncDirty
        && shouldCatchUp
        && !this.closed
        && !this.terminalError
        && this.stream === stream
      ) this.scheduleSyncIfDue(stream, true);
    });
    this.periodicSyncPromise = pending;
  }

  async waitForPeriodicSync(): Promise<void> {
    while (this.periodicSyncPromise) await this.periodicSyncPromise;
  }

  async waitForExplicitFlush(): Promise<void> {
    while (this.explicitFlushPromise) await this.explicitFlushPromise;
  }

  discardFailedStartClaim(): void {
    const expectedIdentity = this.creationIdentity;
    const removeIfOwned = () => {
      if (expectedIdentity) {
        try {
          const stat = fs.lstatSync(this.filePath);
          if (
            stat.isFile()
            && !stat.isSymbolicLink()
            && stat.dev === expectedIdentity.dev
            && stat.ino === expectedIdentity.ino
          ) {
            fs.unlinkSync(this.filePath);
          }
        } catch {}
      }
      try { fs.rmdirSync(this.outputDir); } catch {}
    };

    const stream = this.stream;
    this.stream = null;
    if (!stream || stream.closed) {
      removeIfOwned();
      return;
    }
    stream.once('close', removeIfOwned);
    try {
      stream.destroy();
    } catch {
      removeIfOwned();
    }
  }

  start(): boolean {
    if (this.closed || this.stream || this.seq > 0) {
      console.warn('[automation-jsonl] Recorder instance cannot be started more than once.');
      return false;
    }
    let claimedFd: number | null = null;
    try {
      this.filePath = assertSafeRecordingFilePath({
        extension: '.jsonl',
        operation: 'prepareAutomationJsonlRecording',
        outputDir: this.outputDir,
        requiredSuffix: recordingBundleLayout.BUNDLE_FILES.automation,
        targetPath: this.filePath,
      });
      const manifestLine = JSON.stringify({
        type: 'automation_manifest',
        timeMs: this.recordingStartEpochMs,
        timestampIso: this.recordingStartIso,
        flightId: this.flightId,
        recordingSessionId: this.recordingSessionId,
        bundleStatusRequired: this.bundleStatusRequired,
        flightStartIso: this.recordingStartIso,
        flightElapsedMs: 0,
        schemaVersion: AUTOMATION_SCHEMA_VERSION,
        seq: 1,
      });
      const manifestBytes = Buffer.byteLength(manifestLine, 'utf8') + 1;
      if (manifestBytes > this.maxFileBytes) {
        throw new Error(`Automation JSONL identity manifest exceeds the ${Math.round(this.maxFileBytes / 1024 / 1024)}MiB file cap`);
      }
      claimedFd = fs.openSync(this.filePath, 'wx');
      const claimedStat = fs.fstatSync(claimedFd);
      this.creationIdentity = { dev: claimedStat.dev, ino: claimedStat.ino };
      fs.writeFileSync(claimedFd, `${manifestLine}\n`, { encoding: 'utf8' });
      fs.fdatasyncSync(claimedFd);
      const stream = fs.createWriteStream(this.filePath, { fd: claimedFd, autoClose: true }) as FsWriteStream;
      claimedFd = null;
      this.stream = stream;
      this.startPeriodicSyncTimer();
      stream.on('error', (err: Error) => {
        this.recordTerminalError(err);
        console.error(`[automation-jsonl] Stream error: ${err.message}`);
      });
      this.seq = 1;
      this.rowCount = 1;
      this.acceptedFileBytes = manifestBytes;
      console.log(`[automation-jsonl] Recording started: ${this.filePath}`);
      return true;
    } catch (err) {
      this.clearPeriodicSyncTimer();
      if (claimedFd !== null) {
        try { fs.closeSync(claimedFd); } catch {}
        claimedFd = null;
      }
      this.recordTerminalError(err);
      this.discardFailedStartClaim();
      console.error(`[automation-jsonl] Failed to start recording: ${this.lastError?.message || String(err)}`);
      return false;
    }
  }

  recordAutopilotState(input: AutomationStateInput): boolean {
    if (this.closed || this.terminalError) return false;

    const previous = this.lastSnapshot;
    const requestedTimeMs = isFiniteNumber(input?.timeMs) ? input.timeMs : timeSource.now();
    const timeMs = Math.max(
      requestedTimeMs,
      this.recordingStartEpochMs,
      previous && isFiniteNumber(previous.meta.timeMs) ? previous.meta.timeMs : this.recordingStartEpochMs,
    );
    const elapsedMs = Math.max(
      0,
      timeMs - this.recordingStartEpochMs,
      previous && isFiniteNumber(previous.meta.flightElapsedMs) ? previous.meta.flightElapsedMs : 0,
    );
    const snapshot = buildSnapshot({
      ...(input || {}),
      timeMs,
      timestampIso: new Date(timeMs).toISOString(),
      flightId: this.flightId,
      flightStartIso: this.recordingStartIso,
      flightElapsedMs: elapsedMs,
    }, this.flightId);
    snapshot.meta.recordingSessionId = this.recordingSessionId;
    const elapsedSinceCheckpoint = this.lastCheckpointMs == null
      ? Number.POSITIVE_INFINITY
      : snapshot.meta.timeMs - this.lastCheckpointMs;
    const checkpointDue = !previous || (
      this.checkpointIntervalMs > 0
      && elapsedSinceCheckpoint >= this.checkpointIntervalMs
    );

    if (checkpointDue) {
      const ok = this.writeRow({
        type: 'automation_checkpoint',
        reason: previous ? 'heartbeat' : 'first_snapshot',
        timeMs: snapshot.meta.timeMs,
        context: buildCompactContext(snapshot.meta),
        state: snapshot.state,
      });
      if (ok) {
        this.lastSnapshot = snapshot;
        this.lastCheckpointMs = snapshot.meta.timeMs;
      }
      return ok;
    }

    const stateChanged = diffRecords(previous.state, snapshot.state, NUMERIC_THRESHOLDS);
    const contextChanged = diffRecords(
      buildCompactContext(previous.meta),
      buildCompactContext(snapshot.meta),
    );

    if (!hasChanges(stateChanged) && !hasChanges(contextChanged)) {
      return true;
    }

    const deltaOk = this.writeRow({
      type: 'automation_delta',
      timeMs: snapshot.meta.timeMs,
      ...(hasChanges(stateChanged) ? { stateChanged } : {}),
      ...(hasChanges(contextChanged) ? { contextChanged } : {}),
    });

    if (!deltaOk) return false;

    for (const event of buildEventRows(previous.state, snapshot.state, stateChanged)) {
      if (!this.writeRow({
        type: 'automation_event',
        timeMs: snapshot.meta.timeMs,
        ...event,
        confidence: snapshot.confidence[event.field] || snapshot.confidence[event.field?.split('.')[0]] || null,
        ...(event.eventType === 'ap_disengaged'
          ? { simconnectCorroborated: snapshot.raw?.simconnect?.apMaster === false }
          : {}),
      })) return false;
    }

    this.lastSnapshot = snapshot;
    return true;
  }

  writeFinalCheckpoint(reason = 'recording_end', endContext: AnyRecord = {}): boolean {
    if (this.closed || this.terminalError || !this.lastSnapshot) return false;
    const requestedTimeMs = isFiniteNumber(endContext.timeMs)
      ? endContext.timeMs
      : this.lastSnapshot.meta.timeMs;
    const timeMs = Math.max(requestedTimeMs, this.lastSnapshot.meta.timeMs);
    return this.writeRow({
      timeMs,
      context: buildCompactContext(this.lastSnapshot.meta),
      state: this.lastSnapshot.state,
      type: 'automation_checkpoint',
      reason,
      ...(typeof endContext.endReason === 'string' && endContext.endReason
        ? { endReason: endContext.endReason }
        : {}),
    });
  }

  writeRow(row: AnyRecord): boolean {
    const nextSeq = this.seq + 1;
    let line: string;
    try {
      line = JSON.stringify({
        ...row,
        seq: nextSeq,
      });
    } catch (error) {
      this.recordTerminalError(error);
      return false;
    }
    const accepted = this.appendLine(line);
    if (accepted) this.seq = nextSeq;
    return accepted;
  }

  appendLine(
    line: string,
    options: { countRow?: boolean; countAcceptedBytes?: boolean } = {},
  ): boolean {
    if (this.closed || this.terminalError) return false;
    const countRow = options.countRow !== false;
    const countAcceptedBytes = options.countAcceptedBytes !== false;
    const lineBytes = jsonlLineBytesWithNewline(line);
    if (countAcceptedBytes && this.acceptedFileBytes + lineBytes > this.maxFileBytes) {
      this.recordTerminalError(new Error(
        `Automation JSONL reached the ${Math.round(this.maxFileBytes / 1024 / 1024)}MiB file cap`,
      ));
      return false;
    }
    if (this.renameInProgress) {
      return this.queueLineDuringRename(line, countRow, lineBytes, countAcceptedBytes);
    }
    if (!this.stream) return false;

    const pendingBytes = typeof this.stream.writableLength === 'number' ? this.stream.writableLength : 0;
    if (pendingBytes + lineBytes > JSONL_STREAM_BACKLOG_MAX_BYTES) {
      this.recordBacklogError(`Automation JSONL stream backlog exceeded ${formatMiB(JSONL_STREAM_BACKLOG_MAX_BYTES)}MiB`);
      return false;
    }

    try {
      this.stream.write(`${line}\n`);
      if (countAcceptedBytes) this.acceptedFileBytes += lineBytes;
      this.syncDirty = true;
      if (countRow) this.rowCount++;
      this.scheduleSyncIfDue(this.stream);
      return true;
    } catch (error) {
      this.recordTerminalError(error);
      return false;
    }
  }

  recordBacklogError(message: string): void {
    if (this.lastError?.message === message) return;
    this.recordTerminalError(new Error(message));
    console.error(`[automation-jsonl] ${message}`);
  }

  queueLineDuringRename(
    line: string,
    countRow: boolean,
    lineBytes = jsonlLineBytesWithNewline(line),
    countAcceptedBytes = true,
  ): boolean {
    if (this.renameQueuedLineBytes + lineBytes > JSONL_RENAME_QUEUE_MAX_BYTES) {
      this.recordBacklogError(`Automation JSONL rename backlog exceeded ${formatMiB(JSONL_RENAME_QUEUE_MAX_BYTES)}MiB`);
      return false;
    }

    this.renameQueuedLines.push(line);
    this.renameQueuedLineBytes += lineBytes;
    if (countAcceptedBytes) this.acceptedFileBytes += lineBytes;
    this.syncDirty = true;
    if (countRow) this.rowCount++;
    return true;
  }

  flushRenameQueuedLines(): void {
    const queued = this.renameQueuedLines;
    this.renameQueuedLines = [];
    this.renameQueuedLineBytes = 0;

    for (let index = 0; index < queued.length; index += 1) {
      if (!this.appendLine(queued[index], { countRow: false, countAcceptedBytes: false })) {
        const remaining = queued.slice(index);
        this.renameQueuedLines = remaining;
        this.renameQueuedLineBytes = remaining.reduce(
          (total, queuedLine) => total + jsonlLineBytesWithNewline(queuedLine),
          0,
        );
        break;
      }
    }
  }

  flush(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    const previousFlush = this.explicitFlushPromise;
    const pending = (async () => {
      try {
        if (previousFlush) await previousFlush;
        if (this.renamePromise) {
          const renamed = await this.renamePromise;
          if (!renamed) return false;
        }
        const stream = this.stream;
        if (!stream || this.terminalError) return false;
        await this.waitForPeriodicSync();
        await flushWriteStreamDurably(stream);
        return true;
      } catch (error) {
        this.recordTerminalError(error);
        return false;
      }
    })();
    this.explicitFlushPromise = pending;
    void pending.then(() => {
      if (this.explicitFlushPromise === pending) this.explicitFlushPromise = null;
    });
    return pending;
  }

  async close(endContext: AnyRecord = {}): Promise<AutomationRecorderStats> {
    if (this.closed) return this.getStats();
    this.clearPeriodicSyncTimer();

    try {
      if (this.renamePromise) await this.renamePromise;
      if (endContext.skipFinalCheckpoint !== true) {
        this.writeFinalCheckpoint('recording_end', endContext);
      }
    } catch (err) {
      this.recordTerminalError(err);
    }

    // Gate new appends before waiting, but only after the final checkpoint has
    // joined the stream. Existing explicit flushes retain ownership until they
    // settle; the final close barrier below then covers the checkpoint too.
    this.closed = true;
    await this.waitForExplicitFlush();

    const stream = this.stream;
    this.stream = null;
    if (stream) {
      try {
        await this.waitForPeriodicSync();
        await closeWriteStreamDurably(stream);
      } catch (error) {
        this.recordTerminalError(error);
      }
    }
    const stats = this.getStats();
    console.log(`[automation-jsonl] Recording complete: ${stats.rowCount} rows, ${stats.fileSizeKb}KB`);
    return stats;
  }

  closeSync(): AutomationRecorderStats {
    if (this.closed) return this.getStats();
    this.clearPeriodicSyncTimer();
    try {
      this.writeFinalCheckpoint('recording_end');
    } catch (err) {
      this.recordTerminalError(err);
    }
    this.closed = true;
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
    return this.getStats();
  }

  getStats(): AutomationRecorderStats {
    let fileSizeBytes = 0;
    try {
      if (fs.existsSync(this.filePath)) {
        fileSizeBytes = fs.statSync(this.filePath).size;
      }
    } catch {}

    return {
      flightId: this.flightId,
      recordingSessionId: this.recordingSessionId,
      bundleStatusRequired: this.bundleStatusRequired,
      recordingStartEpochMs: this.recordingStartEpochMs,
      recordingStartIso: this.recordingStartIso,
      bundleBaseName: this.bundleBaseName,
      filePath: this.filePath,
      filename: this.filename,
      outputDir: this.outputDir,
      rowCount: this.rowCount,
      fileSizeBytes,
      fileSizeKb: Math.round(fileSizeBytes / 1024),
      hasError: !!this.lastError,
      lastError: this.lastError?.message,
      creationIdentity: this.creationIdentity,
    };
  }

  async updateFilename(
    departureIcao: string | null | undefined,
    arrivalIcao: string | null | undefined,
    bundleBaseName?: string,
  ): Promise<boolean> {
    if (this.closed) return false;
    if (bundleBaseName && bundleBaseName !== this.bundleBaseName) return false;
    if (!await this.flush()) return false;
    this.departureIcao = departureIcao || this.departureIcao;
    this.arrivalIcao = arrivalIcao || this.arrivalIcao;
    return true;
  }

  async updateFilenameNow(
    departureIcao: string | null | undefined,
    arrivalIcao: string | null | undefined,
    newFilename: string,
  ): Promise<boolean> {
    const newPath = path.join(this.outputDir, newFilename);

    try {
      this.renameInProgress = true;
      if (this.stream) {
        const stream = this.stream;
        this.stream = null;
        await this.waitForPeriodicSync();
        await closeWriteStreamDurably(stream);
      }

      safeRenameRecordingFileSync({
        extension: '.jsonl',
        fromPath: this.filePath,
        operation: 'renameAutomationJsonlRecording',
        outputDir: this.outputDir,
        requiredSuffix: recordingBundleLayout.BUNDLE_FILES.automation,
        toPath: newPath,
      });

      this.filename = newFilename;
      this.bundleBaseName = path.basename(newFilename, '.automation.jsonl');
      this.filePath = path.resolve(newPath);
      this.departureIcao = departureIcao || this.departureIcao;
      this.arrivalIcao = arrivalIcao || this.arrivalIcao;

      const stream = createSafeRecordingWriteStream({
        extension: '.jsonl',
        flags: 'a',
        operation: 'reopenAutomationJsonlRecording',
        outputDir: this.outputDir,
      requiredSuffix: recordingBundleLayout.BUNDLE_FILES.automation,
        targetPath: this.filePath,
      });
      this.stream = stream;
      stream.on('error', (err: Error) => {
        this.recordTerminalError(err);
        console.error(`[automation-jsonl] Stream error after rename: ${err.message}`);
      });
      this.renameInProgress = false;
      this.flushRenameQueuedLines();

      console.log(`[automation-jsonl] File renamed: ${newFilename}`);
      return true;
    } catch (err) {
      this.lastError = err as Error;
      console.warn(`[automation-jsonl] Rename failed: ${this.lastError.message}`);
      try {
        const stream = createSafeRecordingWriteStream({
          extension: '.jsonl',
          flags: 'a',
          operation: 'recoverAutomationJsonlRecording',
          outputDir: this.outputDir,
          requiredSuffix: recordingBundleLayout.BUNDLE_FILES.automation,
          targetPath: this.filePath,
        });
        this.stream = stream;
        stream.on('error', (streamError: Error) => {
          this.recordTerminalError(streamError);
          if (this.stream === stream) this.stream = null;
        });
      } catch (recoveryError) {
        this.recordTerminalError(recoveryError);
      }
      this.renameInProgress = false;
      this.flushRenameQueuedLines();
      return false;
    }
  }
}

let activeFinalizationPromise: Promise<AutomationRecorderStats | null> | null = null;
let finalizingRecorder: AutomationJsonlRecorder | null = null;

function startFlight(options: AutomationRecorderOptions = {}): AutomationJsonlRecorder | null {
  if (activeFinalizationPromise || finalizingRecorder || (activeRecorder && !activeRecorder.closed)) {
    console.warn('[automation-jsonl] Recorder start refused while a recording is active or finalizing.');
    return null;
  }

  const recorder = new AutomationJsonlRecorder({
    ...options,
    flightId: options.flightId || new Date().toISOString(),
  });

  if (!recorder.start()) return null;
  activeRecorder = recorder;
  return recorder;
}

function recordAutopilotState(input: AutomationStateInput): boolean {
  if (!activeRecorder || activeRecorder.closed) return false;
  return activeRecorder.recordAutopilotState(input);
}

async function endFlight(endContext: AnyRecord = {}): Promise<AutomationRecorderStats | null> {
  if (!activeRecorder) return activeFinalizationPromise ? await activeFinalizationPromise : null;
  const recorder = activeRecorder;
  activeRecorder = null;
  finalizingRecorder = recorder;
  const closePromise = recorder.close(endContext);
  const tracked = closePromise.finally(() => {
    if (finalizingRecorder === recorder) finalizingRecorder = null;
    if (activeFinalizationPromise === tracked) activeFinalizationPromise = null;
  });
  activeFinalizationPromise = tracked;
  return await tracked;
}

async function updateRoute(
  departureIcao: string | null | undefined,
  arrivalIcao: string | null | undefined,
  bundleBaseName?: string,
): Promise<boolean> {
  if (!activeRecorder || activeRecorder.closed) return false;
  return await activeRecorder.updateFilename(departureIcao, arrivalIcao, bundleBaseName);
}

async function flush(): Promise<boolean> {
  if (!activeRecorder || activeRecorder.closed) return false;
  return await activeRecorder.flush();
}

function isRecording(): boolean {
  return activeRecorder !== null && !activeRecorder.closed;
}

function isFinalizing(): boolean {
  return activeFinalizationPromise !== null || finalizingRecorder !== null;
}

function getStats(): AutomationRecorderStats | null {
  if (!activeRecorder) return null;
  return activeRecorder.getStats();
}

function getFinalizingStats(): AutomationRecorderStats | null {
  return finalizingRecorder?.getStats() || null;
}

module.exports = {
  AUTOMATION_SCHEMA_VERSION,
  DEFAULT_CHECKPOINT_INTERVAL_MS,
  DEFAULT_SYNC_INTERVAL_MS,
  DEFAULT_MAX_AUTOMATION_FILE_BYTES,
  AutomationJsonlRecorder,
  buildAutomationState,
  buildRawObservation,
  buildSnapshot,
  diffRecords,
  generateFilename,
  startFlight,
  recordAutopilotState,
  endFlight,
  updateRoute,
  flush,
  isRecording,
  isFinalizing,
  getStats,
  getFinalizingStats,
};

export {};
