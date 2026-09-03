/**
 * Flight CSV Writer - authoritative append-only flight record.
 *
 * This module owns durable flight recording. It writes telemetry samples and
 * sparse event rows into the V1 CSV schema from `schema-field-map.ts`; downstream
 * features such as timeline replay, logbook summaries, sharing cards, analytics,
 * and debugging are all consumers of this file, not competing sources of truth.
 *
 * Data-integrity rules:
 * - Start failure means the flight cannot be treated as durably recorded.
 * - Rows are schema-built and CSV-escaped here before they touch disk.
 * - LANDING, GO_AROUND, warning, and violation rows are intentionally persisted
 *   beside SAMPLE rows because replay needs the live event context.
 * - A recording bundle path is immutable from startup through finalization;
 *   route data belongs in rows rather than filesystem names.
 * - Disk exhaustion fails closed and emits a storage warning so the UI can tell
 *   the user that only a partial authoritative record exists.
 *
 * This is not an export helper. Treat it as the flight recorder.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads') as typeof import('worker_threads');
const { resolveFlightLogsDir } = require('../utils/flight-logs-dir');
const recordingBundleLayout = require('./recording-bundle-layout') as {
  BUNDLE_FILES: { csv: string };
  buildBundleName: (_flightId: unknown, _recordingSessionId: unknown) => string;
  getBundlePaths: (_outputDir: string, _bundleName: string) => { dir: string; csv: string };
};
const {
  assertSafeRecordingFilePath,
} = require('./recording-path-guard') as {
  assertSafeRecordingFilePath: (_options: {
    extension: string;
    operation: string;
    outputDir: string;
    targetPath: string;
  }) => string;
};
const {
  closeWriteStreamDurably,
  flushWriteStreamDurably,
} = require('./recording-stream-durability') as {
  closeWriteStreamDurably: (_stream: FsWriteStream) => Promise<void>;
  flushWriteStreamDurably: (_stream: FsWriteStream) => Promise<void>;
};
const timeSource = require('../core/time-source') as TimeSourceModule;
const config = require('../core/config') as ConfigModule;

// Single source of truth for field definitions
const schemaFieldMap = require('./schema-field-map') as SchemaFieldMapModule;

// eventBus used ONLY for disk exhaustion notification (critical data integrity event)
// All other broadcasting handled by callers (simbridge-core)
const eventBus = require('../core/event-bus') as EventBusModule;

type TimeSourceModule = {
  now: () => number;
};

type SchemaFieldMapModule = {
  getV1Columns: () => string[];
  buildRow: (frame: CsvFrame) => CsvRow;
};

type EventBusModule = {
  emit: (event: string, payload: unknown) => void;
};

type ConfigModule = {
  recording?: {
    csvWriterMode?: string;
  };
};

type FsWriteStream = import('fs').WriteStream & {
  fd?: number | null;
};
type CsvFrame = Record<string, any>;
type CsvRow = Record<string, string>;
type EventRowData = Record<string, any>;
type CsvWriterMode = 'inline' | 'worker';

type FlightWriterOptions = {
  flightId?: string;
  recordingSessionId?: string;
  recordingStartEpochMs?: number;
  recordingStartIso?: string;
  bundleBaseName?: string;
  bundleStatusRequired?: boolean;
  outputDir?: string;
  departureIcao?: string | null;
  arrivalIcao?: string | null;
  syncIntervalMs?: number;
  maxFileBytes?: number;
  writerMode?: CsvWriterMode;
  onTerminalError?: (_error: Error) => void;
  workerStartupTimeoutMs?: number;
  workerStartupDelayMs?: number;
  workerStartupNotifyDelayMs?: number;
  workerPeriodicSyncBarrierDelayMs?: number;
  workerPeriodicSyncErrorCode?: string;
  workerReportPeriodicSyncPhases?: boolean;
};

type FlightRecordingStats = {
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
  durationMs: number;
  departureIcao: string | null;
  arrivalIcao: string | null;
  hasError: boolean;
  lastError: string | undefined;
  creationIdentity: { dev: number; ino: number } | null;
};

type ErrorWithCode = Error & {
  code?: string;
};

type CsvWriterInstance = FlightCSVWriter | WorkerFlightCSVWriter;

function defaultOnGroundForEvent(eventType: string): boolean | null {
  const normalized = String(eventType || '').toUpperCase();
  if (normalized === 'LANDING') return true;
  if (normalized === 'GO_AROUND') return false;
  return null;
}

function buildEventPhaseFields(eventType: string, eventData: EventRowData, frame: CsvFrame): Record<string, any> {
  const normalized = String(eventType || '').toUpperCase();
  if (normalized === 'LANDING') {
    const phaseHint = eventData.flightPhaseHint
      ?? eventData.flight_phase_hint
      ?? eventData.phase
      ?? frame.flightPhaseHint
      ?? frame.flight_phase_hint
      ?? frame.phase
      ?? null;
    return {
      phase: 'LANDING',
      flightPhaseHint: phaseHint,
      flight_phase_hint: phaseHint,
    };
  }

  return {
    phase: eventData.phase ?? frame.phase ?? eventType,
  };
}

// The schema accepts both eventId and event_id. Normalize once so inline and
// worker writers cannot emit diverging aliases for the same event row.
function resolveEventId(eventType: string, eventData: EventRowData, now: number): string {
  return String(eventData.eventId || eventData.event_id || `${eventType}-${now}`);
}

type PendingWorkerRequest = {
  resolve: (value: WorkerResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  onSettled?: () => void;
  onRejectedResponse?: (error: Error) => void;
};

type WorkerResponse = {
  type?: string;
  requestId?: number;
  ok?: boolean;
  error?: string;
  code?: string;
  diskExhausted?: boolean;
  rowCount?: number;
  filePath?: string;
  stats?: {
    rowCount?: number;
    fileSizeBytes?: number;
    lastError?: string | null;
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// V1 SCHEMA - Dynamic from schema-field-map.ts (single source of truth)
// ═══════════════════════════════════════════════════════════════════════════

// V1_COLUMNS is derived from schema-field-map.ts (single source of truth)
// This eliminates duplicate column definitions.
// To add a field: edit schema-field-map.ts only.
const V1_COLUMNS = schemaFieldMap.getV1Columns();
const CSV_SCHEMA_VERSION = 3;
const COMPACT_REPEAT_COLUMNS = [
  'schema_version',
  'user_id',
  'session_id',
  'recording_session_id',
  'bundle_status_required',
  'flight_id',
  'flight_start_iso',
  'aircraft',
  'aircraft_profile_id',
  'data_source',
];
const WORKER_APPEND_BATCH_MAX_LINES = 512;
const WORKER_APPEND_BATCH_MAX_BYTES = 256 * 1024;
const WORKER_INFLIGHT_APPEND_MAX_BYTES = 64 * 1024 * 1024;
const WORKER_APPEND_REQUEST_TIMEOUT_MS = 60000;
function removeEmptyRecordingBundleDir(outputDir: string): void {
  try { fs.rmdirSync(outputDir); } catch {}
}
const INLINE_STREAM_BACKLOG_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_CSV_FILE_BYTES = 200 * 1024 * 1024;

// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════

let activeWriter: CsvWriterInstance | null = null;
let finalizingWriter: CsvWriterInstance | null = null;
let activeFinalizationPromise: Promise<FlightRecordingStats | null> | null = null;
let diskExhausted = false;  // Global flag to prevent cascading ENOSPC errors

// ═══════════════════════════════════════════════════════════════════════════
// CSV Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if an error is a disk space exhaustion error.
 * @param {Error} err - The error to check
 * @returns {boolean}
 */
function isDiskExhaustedError(err: ErrorWithCode | null | undefined): boolean {
  if (!err) return false;
  // ENOSPC: No space left on device (Linux/macOS/Windows)
  // EDQUOT: Disk quota exceeded (some systems)
  return err.code === 'ENOSPC' || err.code === 'EDQUOT';
}

function csvLineBytesWithNewline(line: string): number {
  return Buffer.byteLength(line, 'utf8') + 1;
}

function writeUtf8FullySync(fd: number, text: string): void {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, null);
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error('Recording startup metadata write made no forward progress');
    }
    offset += written;
  }
}

function formatMiB(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

/**
 * Handle disk exhaustion - emit events and log.
 * Called only once per session to avoid spam.
 * @param {FlightCSVWriter} writer - The writer instance
 * @param {Error} err - The error that triggered this
 */
function handleDiskExhaustion(
  writer: { filePath?: string; rowCount?: number } | null | undefined,
  err: Error,
): void {
  if (diskExhausted) return; // Already handled
  diskExhausted = true;
  
  console.error('[flight-csv] CRITICAL: Disk space exhausted during recording');
  console.error(`[flight-csv] Error: ${err.message}`);
  console.error(`[flight-csv] Incomplete flight saved: ${writer?.rowCount || 0} rows`);
  
  // Emit for UI warning (picked up by simbridge-core → WebSocket broadcast)
  eventBus.emit('storage:diskExhausted', {
    filePath: writer?.filePath,
    rowsWritten: writer?.rowCount || 0,
    message: 'Recording stopped — disk space exhausted. Incomplete flight data preserved.',
  });
}

/**
 * Escape a value for CSV output.
 */
function escapeCSV(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('\n') || str.includes('"') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Convert a row object to CSV line.
 */
function compactRowForWrite(row: CsvRow, lastCompactValues: Record<string, string>): CsvRow {
  let compacted: CsvRow | null = null;

  for (const column of COMPACT_REPEAT_COLUMNS) {
    const value = row[column];
    if (value === null || value === undefined || value === '') continue;

    const strValue = String(value);
    if (lastCompactValues[column] === strValue) {
      compacted = compacted || { ...row };
      compacted[column] = '';
      continue;
    }

    lastCompactValues[column] = strValue;
  }
  return compacted || row;
}

function rowToCSV(row: CsvRow, lastCompactValues: Record<string, string>): string {
  const outputRow = compactRowForWrite(row, lastCompactValues);
  return V1_COLUMNS.map(col => escapeCSV(outputRow[col])).join(',');
}

function buildRecordingManifestCsvLine(
  envelope: {
    flightId: string | undefined;
    recordingSessionId: string | undefined;
    recordingStartEpochMs: number;
    recordingStartIso: string;
    bundleStatusRequired: boolean;
  },
  lastCompactValues: Record<string, string>,
): string {
  // Build this sparse row explicitly. Normal telemetry defaults such as
  // sim_paused=0 and attitude_valid=1 are meaningful for SAMPLE rows but would
  // be fabricated state in a startup identity record.
  const row = Object.fromEntries(V1_COLUMNS.map((column) => [column, ''])) as CsvRow;
  Object.assign(row, {
    record_type: 'RECORDING_MANIFEST',
    sample_index: '0',
    schema_version: String(CSV_SCHEMA_VERSION),
    recording_session_id: String(envelope.recordingSessionId || ''),
    bundle_status_required: envelope.bundleStatusRequired ? '1' : '0',
    ts: String(Math.round(envelope.recordingStartEpochMs)),
    timestamp_utc: envelope.recordingStartIso,
    recorded_at_ms: String(Math.round(envelope.recordingStartEpochMs)),
    recorded_at_utc: envelope.recordingStartIso,
    flight_id: String(envelope.flightId || ''),
    flight_elapsed_ms: '0',
    timestamp_monotonic: '0',
    flight_start_iso: envelope.recordingStartIso,
  });
  return rowToCSV(row, lastCompactValues);
}

function normalizeCsvWriterMode(value: unknown): CsvWriterMode {
  return String(value || '').trim().toLowerCase() === 'worker' ? 'worker' : 'inline';
}

function getConfiguredCsvWriterMode(options: FlightWriterOptions = {}): CsvWriterMode {
  return options.writerMode || normalizeCsvWriterMode(config.recording?.csvWriterMode || 'worker');
}

/**
 * Get default flight logs directory.
 */
function getDefaultFlightLogsDir(): string {
  return resolveFlightLogsDir({ createIfMissing: true });
}

/**
 * Sanitize flight_id for use as filename.
 */
function sanitizeFlightId(flightId: string | null | undefined): string {
  if (!flightId) return 'unknown-flight';
  return flightId
    .replace(/\.\d{3}Z$/, '')  // Remove milliseconds
    .replace(/Z$/, '')          // Remove trailing Z
    .replace(/:/g, '-');        // Replace colons
}

/**
 * Generate filename from flight info.
 */
function generateFilename(
  flightId: string | null | undefined,
  departureIcao: string | null | undefined,
  arrivalIcao: string | null | undefined,
): string {
  const base = sanitizeFlightId(flightId);
  
  if (departureIcao && arrivalIcao) {
    return `${base}_${departureIcao}-${arrivalIcao}.csv`;
  } else if (arrivalIcao) {
    return `${base}_to-${arrivalIcao}.csv`;
  } else if (departureIcao) {
    return `${base}_from-${departureIcao}.csv`;
  }
  
  return `${base}.csv`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Writer Class
// ═══════════════════════════════════════════════════════════════════════════

class FlightCSVWriter {
  flightId: string | undefined;
  recordingSessionId: string | undefined;
  bundleStatusRequired: boolean;
  recordingStartIso: string;
  bundleBaseName: string;
  outputDir: string;
  departureIcao: string | null;
  arrivalIcao: string | null;
  filename: string;
  filePath: string;
  stream: FsWriteStream | null;
  rowCount: number;
  nextSampleIndex: number;
  startTime: number;
  lastSyncTime: number;
  lastError: Error | null;
  closed: boolean;
  syncIntervalMs: number;
  lastCompactValues: Record<string, string>;
  onTerminalError: ((_error: Error) => void) | null;
  terminalErrorNotified: boolean;
  lastElapsedMs: number;
  creationIdentity: { dev: number; ino: number } | null;
  periodicSyncPromise: Promise<void> | null;
  explicitFlushPromise: Promise<boolean> | null;
  maxFileBytes: number;
  acceptedFileBytes: number;
  periodicSyncTimer: NodeJS.Timeout | null;
  syncDirty: boolean;
  syncCatchUpDue: boolean;

  constructor(options: FlightWriterOptions = {}) {
    this.flightId = options.flightId;
    this.recordingSessionId = options.recordingSessionId || options.flightId;
    this.bundleStatusRequired = options.bundleStatusRequired === true;
    if (!this.recordingSessionId || !this.flightId) throw new Error('CSV recording identities are required');
    const flightLogsDir = options.outputDir || getDefaultFlightLogsDir();
    this.departureIcao = options.departureIcao || null;
    this.arrivalIcao = options.arrivalIcao || null;
    this.startTime = Number.isFinite(options.recordingStartEpochMs)
      ? Number(options.recordingStartEpochMs)
      : timeSource.now();
    this.recordingStartIso = options.recordingStartIso || new Date(this.startTime).toISOString();
    if (Date.parse(this.recordingStartIso) !== this.startTime) {
      throw new Error('CSV recording start clock is inconsistent');
    }

    this.bundleBaseName = options.bundleBaseName
      || recordingBundleLayout.buildBundleName(this.recordingStartIso, this.recordingSessionId);
    const bundlePaths = recordingBundleLayout.getBundlePaths(flightLogsDir, this.bundleBaseName);
    this.outputDir = bundlePaths.dir;
    this.filename = recordingBundleLayout.BUNDLE_FILES.csv;
    this.filePath = bundlePaths.csv;

    this.stream = null;
    this.rowCount = 0;
    this.nextSampleIndex = 0;
    this.lastSyncTime = timeSource.now();
    this.lastError = null;
    this.closed = false;
    this.lastCompactValues = {};
    this.onTerminalError = typeof options.onTerminalError === 'function' ? options.onTerminalError : null;
    this.terminalErrorNotified = false;
    this.lastElapsedMs = 0;
    this.creationIdentity = null;
    this.periodicSyncPromise = null;
    this.explicitFlushPromise = null;
    this.maxFileBytes = Number.isFinite(options.maxFileBytes)
      ? Math.max(1, Math.floor(Number(options.maxFileBytes)))
      : DEFAULT_MAX_CSV_FILE_BYTES;
    this.acceptedFileBytes = 0;
    this.periodicSyncTimer = null;
    this.syncDirty = false;
    this.syncCatchUpDue = false;
    
    // Crash resilience: force fsync every N seconds to minimize data loss
    // on hard crash (power loss, BSOD, etc.). 30s = worst case 30s of lost data.
    this.syncIntervalMs = options.syncIntervalMs ?? 30000;
  }
  
  /**
   * Start the writer - opens file and writes header.
   * Returns false if failed (flight cannot be recorded).
   */
  start(): boolean {
    let claimedFd: number | null = null;
    let startupStream: FsWriteStream | null = null;
    try {
      this.filePath = assertSafeRecordingFilePath({
        extension: '.csv',
        operation: 'startFlightCsvRecording',
        outputDir: this.outputDir,
        targetPath: this.filePath,
      });
      
      // A new recording must never append to an unverified prior session.
      // Bundle allocation handles collisions before start; exclusive create is
      // the final cross-process race guard.
      claimedFd = fs.openSync(this.filePath, 'wx');
      const claimedStat = fs.fstatSync(claimedFd);
      this.creationIdentity = { dev: claimedStat.dev, ino: claimedStat.ino };
      // Commit both schema and immutable bundle identity before exposing a live
      // writer. This keeps a quick start/stop CSV joinable with both JSONL
      // manifests even when no telemetry sample ever arrives.
      const manifestLine = buildRecordingManifestCsvLine({
        flightId: this.flightId,
        recordingSessionId: this.recordingSessionId,
        recordingStartEpochMs: this.startTime,
        recordingStartIso: this.recordingStartIso,
        bundleStatusRequired: this.bundleStatusRequired,
      }, this.lastCompactValues);
      const startupText = `${V1_COLUMNS.join(',')}\n${manifestLine}\n`;
      const startupBytes = Buffer.byteLength(startupText, 'utf8');
      if (startupBytes > this.maxFileBytes) {
        throw new Error(`CSV startup metadata exceeds the ${formatMiB(this.maxFileBytes)}MiB file cap`);
      }
      writeUtf8FullySync(claimedFd, startupText);
      fs.fdatasyncSync(claimedFd);
      this.acceptedFileBytes = startupBytes;
      this.rowCount = 1;
      this.nextSampleIndex = 1;
      const stream = fs.createWriteStream(this.filePath, { fd: claimedFd, autoClose: true }) as FsWriteStream;
      startupStream = stream;
      claimedFd = null;
      this.stream = stream;
      this._startPeriodicSyncTimer();
      
      // Handle stream errors to prevent unhandled exceptions crashing the process
      stream.on('error', (err: ErrorWithCode) => {
        this._recordTerminalError(err);
        
        // Check for disk exhaustion
        if (isDiskExhaustedError(err)) {
          handleDiskExhaustion(this, err);
          return;
        }
        
        console.error(`[flight-csv] Stream error: ${err.message}`);
        // Don't close - let writes fail gracefully via the closed/stream checks
      });
      
      console.log(`[flight-csv] Recording started: ${this.filePath}`);
      return true;
      
    } catch (err) {
      const error = err as ErrorWithCode;
      this._clearPeriodicSyncTimer();
      if (claimedFd !== null) {
        try { fs.closeSync(claimedFd); } catch {}
        claimedFd = null;
      }
      if (startupStream) {
        this.stream = null;
        startupStream.once('close', () => this._discardFailedStartupClaimIfOwned());
        try { startupStream.destroy(); } catch {}
      }
      this.closed = true;
      this._discardFailedStartupClaimIfOwned();
      this._recordTerminalError(error);
      
      // Check for disk exhaustion at start
      if (isDiskExhaustedError(error)) {
        handleDiskExhaustion(this, error);
        return false;
      }
      
      console.error(`[flight-csv] CRITICAL: Failed to start recording: ${error.message}`);
      console.error('[flight-csv] Flight will NOT be recorded.');
      return false;
    }
  }
  
  /**
   * Append a telemetry sample row.
   * This is the main real-time write path.
   * 
   * Uses schema-field-map.ts for extraction (single source of truth).
   */
  writeSample(frame: CsvFrame): boolean {
    if (this.closed || this.terminalErrorNotified || diskExhausted) return false;
    if (!this.stream) return false;
    
    try {
      // Overlay metadata onto frame for schema-field-map extraction.
      // Mutate in-place to avoid object spread copy on every sample (hot path).
      const prev_recordType = frame._recordType;
      const prevSchemaVersion = frame.schemaVersion;
      const prev_schema_version = frame.schema_version;
      const prevFlightId = frame.flightId;
      const prevRecordingSessionId = frame.recordingSessionId;
      const prev_recording_session_id = frame.recording_session_id;
      const prevBundleStatusRequired = frame.bundleStatusRequired;
      const prev_bundle_status_required = frame.bundle_status_required;
      const prevElapsed = frame.flightElapsedMs;
      const prevTimestampMonotonic = frame.timestampMonotonic;
      const prev_timestamp_monotonic = frame.timestamp_monotonic;
      const prevFlightStartIso = frame.flightStartIso;
      const prev_flight_start = frame.flight_start;
      const prevTimestampMs = frame.timestampMs;
      const prev_timestamp_ms = frame.timestamp_ms;
      const prevTimestampIso = frame.timestampIso;
      const prev_timestamp_utc = frame.timestamp_utc;
      const prevSampleIndex = frame.sampleIndex;
      const prev_sample_index = frame.sample_index;
      const sampleIndex = this.nextSampleIndex;

      frame._recordType = 'SAMPLE';
      frame.schemaVersion = CSV_SCHEMA_VERSION;
      frame.schema_version = CSV_SCHEMA_VERSION;
      frame.flightId = this.flightId;
      frame.recordingSessionId = this.recordingSessionId;
      frame.recording_session_id = this.recordingSessionId;
      frame.bundleStatusRequired = this.bundleStatusRequired;
      frame.bundle_status_required = this.bundleStatusRequired;
      frame.flightElapsedMs = this._nextElapsedMs(timeSource.now());
      frame.timestampMs = this.startTime + frame.flightElapsedMs;
      frame.timestamp_ms = frame.timestampMs;
      frame.timestampIso = new Date(frame.timestampMs).toISOString();
      frame.timestamp_utc = frame.timestampIso;
      frame.timestampMonotonic = frame.flightElapsedMs;
      frame.timestamp_monotonic = frame.flightElapsedMs;
      frame.flightStartIso = this.recordingStartIso;
      frame.flight_start = this.recordingStartIso;
      frame.sampleIndex = sampleIndex;
      frame.sample_index = frame.sampleIndex;

      let row: CsvRow;
      try {
        // Use schema-field-map for all extraction and formatting
        row = schemaFieldMap.buildRow(frame);
      } finally {
        // Always restore — even if buildRow throws — to avoid side-effects on shared frame
        frame._recordType = prev_recordType;
        frame.schemaVersion = prevSchemaVersion;
        frame.schema_version = prev_schema_version;
        frame.flightId = prevFlightId;
        frame.recordingSessionId = prevRecordingSessionId;
        frame.recording_session_id = prev_recording_session_id;
        frame.bundleStatusRequired = prevBundleStatusRequired;
        frame.bundle_status_required = prev_bundle_status_required;
        frame.flightElapsedMs = prevElapsed;
        frame.timestampMonotonic = prevTimestampMonotonic;
        frame.timestamp_monotonic = prev_timestamp_monotonic;
        frame.flightStartIso = prevFlightStartIso;
        frame.flight_start = prev_flight_start;
        frame.timestampMs = prevTimestampMs;
        frame.timestamp_ms = prev_timestamp_ms;
        frame.timestampIso = prevTimestampIso;
        frame.timestamp_utc = prev_timestamp_utc;
        frame.sampleIndex = prevSampleIndex;
        frame.sample_index = prev_sample_index;
      }

      const ok = this._appendCsvLine(rowToCSV(row, this.lastCompactValues));
      if (ok) this.nextSampleIndex = sampleIndex + 1;
      return ok;
      
    } catch (err) {
      const error = err as ErrorWithCode;
      this._recordTerminalError(error);
      
      // Check for disk exhaustion
      if (isDiskExhaustedError(error)) {
        handleDiskExhaustion(this, error);
        return false;
      }
      
      console.error(`[flight-csv] Write error: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Write an event row (LANDING, GO_AROUND, etc.)
   * Events are interleaved with samples at the correct timestamp.
   * 
   * Uses schema-field-map.ts for extraction (single source of truth).
   */
  writeEvent(eventType: string, eventData: EventRowData, frame: CsvFrame = {}): boolean {
    if (this.closed || this.terminalErrorNotified || diskExhausted) return false;
    if (!this.stream) return false;
    
    try {
      const now = timeSource.now();
      const elapsedMs = this._nextElapsedMs(now);
      const eventId = resolveEventId(eventType, eventData, now);
      const sampleIndex = this.nextSampleIndex;
      // Build frame with event data overlay
      // Event data takes precedence for certain fields (e.g., landing VS/G)
      const enrichedFrame = {
        ...frame,
        // Event overrides
        vs: eventData.vs ?? frame.vs,
        gForce: eventData.gforce ?? frame.gForce,
        ias: eventData.ias_kts ?? frame.ias,
        ra: frame.altitude?.ra ?? frame.ra ?? 0,
        onGround: frame.onGround ?? frame.on_ground ?? defaultOnGroundForEvent(eventType),
        phase: frame.phase || eventType,
        gearDownLocked: frame.gearDownLocked ?? frame.gear?.locked ?? true,
        // Event-specific columns
        icao: eventData.icao || '',
        runway: eventData.runway || '',
        touchdownDistanceFt: eventData.touchdown_distance_ft,
        touchdown_distance_ft: eventData.touchdown_distance_ft,
        // Go-around context (sparse - only for GO_AROUND events)
        previousPhase: eventData.previous_phase,
        previous_phase: eventData.previous_phase,
        goaroundAltitudeFt: eventData.altitude_ft,
        goaround_altitude_ft: eventData.altitude_ft,
        // Overspeed/Stall warning context (sparse - only for warning events)
        warningType: eventData.warning_type,
        warning_type: eventData.warning_type,
        warningActive: eventData.warning_active,
        warning_active: eventData.warning_active,
        overspeedType: eventData.overspeed_type,
        overspeed_type: eventData.overspeed_type,
        barberPoleKts: eventData.barber_pole_kts,
        barber_pole_kts: eventData.barber_pole_kts,
        warningDurationMs: eventData.warning_duration_ms,
        warning_duration_ms: eventData.warning_duration_ms,
        flapsPercent: eventData.flaps_percent,
        // Preserve additional event fields (e.g., ultimate stability metrics)
        ...eventData,
        ...buildEventPhaseFields(eventType, eventData, frame),
        _recordType: eventType,
        schemaVersion: CSV_SCHEMA_VERSION,
        schema_version: CSV_SCHEMA_VERSION,
        flightId: this.flightId,
        recordingSessionId: this.recordingSessionId,
        recording_session_id: this.recordingSessionId,
        bundleStatusRequired: this.bundleStatusRequired,
        bundle_status_required: this.bundleStatusRequired,
        flightElapsedMs: elapsedMs,
        timestampMonotonic: elapsedMs,
        timestamp_monotonic: elapsedMs,
        flightStartIso: this.recordingStartIso,
        flight_start: this.recordingStartIso,
        timestampMs: this.startTime + elapsedMs,
        timestamp_ms: this.startTime + elapsedMs,
        timestampIso: new Date(this.startTime + elapsedMs).toISOString(),
        timestamp_utc: new Date(this.startTime + elapsedMs).toISOString(),
        eventId,
        event_id: eventId,
        sampleIndex,
      };
      
      // Use schema-field-map for all extraction and formatting
      const row = schemaFieldMap.buildRow(enrichedFrame);
      
      const ok = this._appendCsvLine(rowToCSV(row, this.lastCompactValues));
      if (!ok) return false;
      this.nextSampleIndex = sampleIndex + 1;
      
      // Update arrival ICAO if this is a landing
      if (eventType === 'LANDING' && eventData.icao) {
        this.arrivalIcao = eventData.icao;
      }
      
      console.log(`[flight-csv] Event recorded: ${eventType}${eventData.icao ? ` at ${eventData.icao}` : ''}`);
      return true;
      
    } catch (err) {
      const error = err as ErrorWithCode;
      this._recordTerminalError(error);
      
      // Check for disk exhaustion
      if (isDiskExhaustedError(error)) {
        handleDiskExhaustion(this, error);
        return false;
      }
      
      console.error(`[flight-csv] Event write error: ${error.message}`);
      return false;
    }
  }

  _discardFailedStartupClaimIfOwned(): void {
    if (this.creationIdentity) {
      try {
        const stat = fs.lstatSync(this.filePath);
        if (
          stat.isFile()
          && !stat.isSymbolicLink()
          && stat.dev === this.creationIdentity.dev
          && stat.ino === this.creationIdentity.ino
        ) {
          fs.unlinkSync(this.filePath);
        }
      } catch {}
    }
    removeEmptyRecordingBundleDir(this.outputDir);
  }

  _startPeriodicSyncTimer(): void {
    if (this.periodicSyncTimer || this.syncIntervalMs <= 0) return;
    this.periodicSyncTimer = setInterval(() => {
      const stream = this.stream;
      if (!this.closed && !this.terminalErrorNotified && stream) {
        this._scheduleSyncIfDue(stream, true);
      }
    }, this.syncIntervalMs);
    this.periodicSyncTimer.unref?.();
  }

  _clearPeriodicSyncTimer(): void {
    if (this.periodicSyncTimer) clearInterval(this.periodicSyncTimer);
    this.periodicSyncTimer = null;
  }

  _scheduleSyncIfDue(stream: FsWriteStream, force = false): void {
    // Note: stream.fd is null until the async open event fires.
    const now = timeSource.now();
    if (this.periodicSyncPromise) {
      // A timer firing while durability is still in flight must not lose its
      // turn. If a row is (or becomes) dirty before the active sync settles,
      // finally() will immediately run one ordered catch-up sync.
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
    const syncPromise = (async () => {
      try {
        // The WriteStream queue owns ordering. A direct fdatasync immediately
        // after write() can run before libuv has submitted the row bytes.
        await new Promise<void>((resolve, reject) => {
          stream.write('', (error?: Error | null) => error ? reject(error) : resolve());
        });
        if (typeof stream.fd !== 'number') {
          throw new Error('CSV periodic sync file descriptor is unavailable');
        }
        await new Promise<void>((resolve, reject) => {
          fs.fdatasync(stream.fd as number, (error) => error ? reject(error) : resolve());
        });
        this.lastSyncTime = now;
      } catch (error) {
        const syncError = error as ErrorWithCode;
        this._recordTerminalError(syncError);
        if (isDiskExhaustedError(syncError)) handleDiskExhaustion(this, syncError);
      }
    })().finally(() => {
      if (this.periodicSyncPromise === syncPromise) this.periodicSyncPromise = null;
      const shouldCatchUp = this.syncCatchUpDue || this.syncIntervalMs <= 0;
      this.syncCatchUpDue = false;
      if (
        this.syncDirty
        && shouldCatchUp
        && !this.closed
        && !this.terminalErrorNotified
        && this.stream === stream
      ) this._scheduleSyncIfDue(stream, true);
    });
    this.periodicSyncPromise = syncPromise;
  }

  async _waitForPeriodicSync(): Promise<void> {
    while (this.periodicSyncPromise) await this.periodicSyncPromise;
  }

  async _waitForExplicitFlush(): Promise<void> {
    while (this.explicitFlushPromise) await this.explicitFlushPromise;
  }

  _nextElapsedMs(nowMs: number): number {
    this.lastElapsedMs = Math.max(0, this.lastElapsedMs, nowMs - this.startTime);
    return this.lastElapsedMs;
  }

  _recordTerminalError(error: Error): void {
    this.lastError = error;
    if (this.terminalErrorNotified) return;
    this.terminalErrorNotified = true;
    try { this.onTerminalError?.(error); } catch {}
  }

  _appendCsvLine(line: string): boolean {
    if (
      this.closed
      || this.terminalErrorNotified
      || diskExhausted
    ) return false;

    const lineBytes = csvLineBytesWithNewline(line);
    if (this.acceptedFileBytes + lineBytes > this.maxFileBytes) {
      this._recordBacklogError(`CSV reached the ${formatMiB(this.maxFileBytes)}MiB file cap`);
      return false;
    }
    const stream = this.stream;
    if (!stream) return false;

    const pendingBytes = typeof stream.writableLength === 'number' ? stream.writableLength : 0;
    if (pendingBytes + lineBytes > INLINE_STREAM_BACKLOG_MAX_BYTES) {
      this._recordBacklogError(`CSV inline stream backlog exceeded ${formatMiB(INLINE_STREAM_BACKLOG_MAX_BYTES)}MiB`);
      return false;
    }

    stream.write(`${line}\n`);
    this.acceptedFileBytes += lineBytes;
    this.syncDirty = true;
    this.rowCount++;
    this._scheduleSyncIfDue(stream);
    return true;
  }

  _recordBacklogError(message: string): void {
    if (this.lastError?.message === message) return;
    this._recordTerminalError(new Error(message));
    console.error(`[flight-csv] ${message}`);
  }

  flush(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    const previousFlush = this.explicitFlushPromise;
    const pending = (async () => {
      try {
        // Serialize explicit durability barriers. close() waits for the newest
        // operation in this chain before taking the stream reference away, so
        // a list/logbook flush that was already in progress cannot mistake a
        // normal close hand-off for a storage failure.
        if (previousFlush) await previousFlush;
        const stream = this.stream;
        if (!stream) return false;
        await this._waitForPeriodicSync();
        await flushWriteStreamDurably(stream);
        return true;
      } catch (error) {
        this._recordTerminalError(error as Error);
        return false;
      }
    })();
    this.explicitFlushPromise = pending;
    void pending.then(() => {
      if (this.explicitFlushPromise === pending) this.explicitFlushPromise = null;
    });
    return pending;
  }
  
  /**
   * Close the writer and finalize the file.
   * Returns a Promise that resolves with stats about the recorded flight.
   * Waits for all data to be flushed to disk.
   */
  close(): Promise<FlightRecordingStats> {
    if (this.closed) return Promise.resolve(this.getStats());

    return (async () => {
      this.closed = true;
      this._clearPeriodicSyncTimer();
      await this._waitForExplicitFlush();

      const stream = this.stream;
      this.stream = null;
      if (stream) {
        try {
          await this._waitForPeriodicSync();
          await closeWriteStreamDurably(stream);
        } catch (error) {
          this._recordTerminalError(error as Error);
        }
      }
      this.closed = true;
      const stats = this.getStats();
      console.log(`[flight-csv] Recording complete: ${this.rowCount} rows, ${stats.fileSizeKb}KB`);
      return stats;
    })();
  }
  
  /**
   * Synchronous close - use only when you don't need to wait for flush.
   * Data may be lost if process exits immediately after.
   */
  closeSync(): FlightRecordingStats {
    if (this.closed) return this.getStats();
    
    this.closed = true;
    this._clearPeriodicSyncTimer();
    
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
    
    const stats = this.getStats();
    console.log(`[flight-csv] Recording complete (sync): ${this.rowCount} rows`);
    
    return stats;
  }
  
  /**
   * Get current stats.
   */
  getStats(): FlightRecordingStats {
    let fileSizeBytes = 0;
    try {
      if (fs.existsSync(this.filePath)) {
        fileSizeBytes = fs.statSync(this.filePath).size;
      }
    } catch (e) { /* ignore */ }
    
    return {
      flightId: this.flightId,
      recordingSessionId: this.recordingSessionId,
      bundleStatusRequired: this.bundleStatusRequired,
      recordingStartEpochMs: this.startTime,
      recordingStartIso: this.recordingStartIso,
      bundleBaseName: this.bundleBaseName,
      filePath: this.filePath,
      filename: this.filename,
      outputDir: this.outputDir,
      rowCount: this.rowCount,
      fileSizeBytes,
      fileSizeKb: Math.round(fileSizeBytes / 1024),
      durationMs: timeSource.now() - this.startTime,
      departureIcao: this.departureIcao,
      arrivalIcao: this.arrivalIcao,
      hasError: !!this.lastError,
      lastError: this.lastError?.message,
      creationIdentity: this.creationIdentity,
    };
  }
  
}

class WorkerFlightCSVWriter {
  flightId: string | undefined;
  recordingSessionId: string | undefined;
  bundleStatusRequired: boolean;
  recordingStartIso: string;
  bundleBaseName: string;
  outputDir: string;
  departureIcao: string | null;
  arrivalIcao: string | null;
  filename: string;
  filePath: string;
  rowCount: number;
  nextSampleIndex: number;
  startTime: number;
  lastSyncTime: number;
  lastError: Error | null;
  closed: boolean;
  syncIntervalMs: number;
  worker: import('worker_threads').Worker | null;
  nextRequestId: number;
  pendingRequests: Map<number, PendingWorkerRequest>;
  pendingLines: string[];
  pendingLineBytes: number;
  inflightAppendBytes: number;
  inflightAppendLines: number;
  flushScheduled: boolean;
  lastCompactValues: Record<string, string>;
  onTerminalError: ((_error: Error) => void) | null;
  terminalErrorNotified: boolean;
  lastElapsedMs: number;
  creationIdentity: { dev: number; ino: number } | null;
  workerStartupTimeoutMs: number;
  workerStartupDelayMs: number;
  workerStartupNotifyDelayMs: number;
  workerTerminationPromise: Promise<number> | null;
  closePromise: Promise<FlightRecordingStats> | null;
  maxFileBytes: number;
  acceptedFileBytes: number;
  workerPeriodicSyncBarrierDelayMs: number;
  workerPeriodicSyncErrorCode: string;
  workerReportPeriodicSyncPhases: boolean;

  constructor(options: FlightWriterOptions = {}) {
    this.flightId = options.flightId;
    this.recordingSessionId = options.recordingSessionId || options.flightId;
    this.bundleStatusRequired = options.bundleStatusRequired === true;
    if (!this.recordingSessionId || !this.flightId) throw new Error('CSV recording identities are required');
    const flightLogsDir = options.outputDir || getDefaultFlightLogsDir();
    this.departureIcao = options.departureIcao || null;
    this.arrivalIcao = options.arrivalIcao || null;
    this.startTime = Number.isFinite(options.recordingStartEpochMs)
      ? Number(options.recordingStartEpochMs)
      : timeSource.now();
    this.recordingStartIso = options.recordingStartIso || new Date(this.startTime).toISOString();
    if (Date.parse(this.recordingStartIso) !== this.startTime) {
      throw new Error('CSV recording start clock is inconsistent');
    }

    this.bundleBaseName = options.bundleBaseName
      || recordingBundleLayout.buildBundleName(this.recordingStartIso, this.recordingSessionId);
    const bundlePaths = recordingBundleLayout.getBundlePaths(flightLogsDir, this.bundleBaseName);
    this.outputDir = bundlePaths.dir;
    this.filename = recordingBundleLayout.BUNDLE_FILES.csv;
    this.filePath = bundlePaths.csv;

    this.rowCount = 0;
    this.nextSampleIndex = 0;
    this.lastSyncTime = timeSource.now();
    this.lastError = null;
    this.closed = false;
    this.syncIntervalMs = options.syncIntervalMs ?? 30000;
    this.worker = null;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.pendingLines = [];
    this.pendingLineBytes = 0;
    this.inflightAppendBytes = 0;
    this.inflightAppendLines = 0;
    this.flushScheduled = false;
    this.lastCompactValues = {};
    this.onTerminalError = typeof options.onTerminalError === 'function' ? options.onTerminalError : null;
    this.terminalErrorNotified = false;
    this.lastElapsedMs = 0;
    this.creationIdentity = null;
    this.workerStartupTimeoutMs = Number.isFinite(options.workerStartupTimeoutMs)
      ? Math.max(1, Number(options.workerStartupTimeoutMs))
      : 5000;
    this.workerStartupDelayMs = Number.isFinite(options.workerStartupDelayMs)
      ? Math.max(0, Number(options.workerStartupDelayMs))
      : 0;
    this.workerStartupNotifyDelayMs = Number.isFinite(options.workerStartupNotifyDelayMs)
      ? Math.max(0, Number(options.workerStartupNotifyDelayMs))
      : 0;
    this.workerTerminationPromise = null;
    this.closePromise = null;
    this.maxFileBytes = Number.isFinite(options.maxFileBytes)
      ? Math.max(1, Math.floor(Number(options.maxFileBytes)))
      : DEFAULT_MAX_CSV_FILE_BYTES;
    this.acceptedFileBytes = 0;
    this.workerPeriodicSyncBarrierDelayMs = Number.isFinite(options.workerPeriodicSyncBarrierDelayMs)
      ? Math.max(0, Number(options.workerPeriodicSyncBarrierDelayMs))
      : 0;
    this.workerPeriodicSyncErrorCode = String(options.workerPeriodicSyncErrorCode || '');
    this.workerReportPeriodicSyncPhases = options.workerReportPeriodicSyncPhases === true;
  }

  _discardStartupClaimIfOwned(): void {
    if (this.creationIdentity) {
      try {
        const safePath = assertSafeRecordingFilePath({
          extension: '.csv',
          operation: 'discardFailedWorkerCsvStartup',
          outputDir: this.outputDir,
          targetPath: this.filePath,
        });
        const stat = fs.lstatSync(safePath);
        if (
          stat.isFile()
          && !stat.isSymbolicLink()
          && stat.dev === this.creationIdentity.dev
          && stat.ino === this.creationIdentity.ino
        ) {
          fs.unlinkSync(safePath);
        }
      } catch {
        // Preserve unknown/replaced paths. A later retry will allocate a new
        // basename instead of risking deletion of another process's artifact.
      }
    }
    removeEmptyRecordingBundleDir(this.outputDir);
  }

  _waitForStartupClaimRelease(maxWaitMs = 500): void {
    const waitControl = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      this._discardStartupClaimIfOwned();
      try {
        if (!fs.existsSync(this.filePath)) return;
        const stat = fs.lstatSync(this.filePath);
        if (
          !this.creationIdentity
          || stat.dev !== this.creationIdentity.dev
          || stat.ino !== this.creationIdentity.ino
        ) return;
      } catch {
        return;
      }
      Atomics.wait(waitControl, 0, 0, 10);
    }
  }

  start(): boolean {
    const workerPath = path.join(__dirname, 'csv-line-writer-worker.js');
    const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const control = new Int32Array(controlBuffer);
    let startupWorker: import('worker_threads').Worker | null = null;

    try {
      this.filePath = assertSafeRecordingFilePath({
        extension: '.csv',
        operation: 'startWorkerFlightCsvRecording',
        outputDir: this.outputDir,
        targetPath: this.filePath,
      });
      const claimFd = fs.openSync(this.filePath, 'wx');
      try {
        const claimedStat = fs.fstatSync(claimFd);
        this.creationIdentity = { dev: claimedStat.dev, ino: claimedStat.ino };
      } finally {
        fs.closeSync(claimFd);
      }
      const manifestLine = buildRecordingManifestCsvLine({
        flightId: this.flightId,
        recordingSessionId: this.recordingSessionId,
        recordingStartEpochMs: this.startTime,
        recordingStartIso: this.recordingStartIso,
        bundleStatusRequired: this.bundleStatusRequired,
      }, this.lastCompactValues);
      const startupBytes = Buffer.byteLength(`${V1_COLUMNS.join(',')}\n${manifestLine}\n`, 'utf8');
      if (startupBytes > this.maxFileBytes) {
        throw new Error(`CSV startup metadata exceeds the ${formatMiB(this.maxFileBytes)}MiB file cap`);
      }
      this.acceptedFileBytes = startupBytes;

      const worker = new Worker(workerPath, {
        workerData: {
          controlBuffer,
          filePath: this.filePath,
          headerLine: V1_COLUMNS.join(','),
          manifestLine,
          outputDir: this.outputDir,
          syncIntervalMs: this.syncIntervalMs,
          initialRowCount: 1,
          maxFileBytes: this.maxFileBytes,
          initialAcceptedFileBytes: startupBytes,
          expectedCreationIdentity: this.creationIdentity,
          startupDelayMs: this.workerStartupDelayMs,
          startupNotifyDelayMs: this.workerStartupNotifyDelayMs,
          periodicSyncBarrierDelayMs: this.workerPeriodicSyncBarrierDelayMs,
          periodicSyncErrorCode: this.workerPeriodicSyncErrorCode,
          reportPeriodicSyncPhases: this.workerReportPeriodicSyncPhases,
        },
      });
      startupWorker = worker;

      this.worker = worker;
      worker.on('message', (message: WorkerResponse) => this._handleWorkerMessage(message));
      worker.on('error', (err: Error) => this._handleWorkerFailure(err));
      worker.on('exit', (code) => {
        if (!this.closed) {
          this._handleWorkerFailure(new Error(`CSV worker exited unexpectedly with code ${code}`));
        }
        this.worker = null;
      });

      const waitResult = Atomics.wait(control, 0, 0, this.workerStartupTimeoutMs);
      if (Atomics.load(control, 0) !== 1) {
        const error = new Error(waitResult === 'timed-out'
          ? 'CSV worker startup timed out'
          : 'CSV worker failed to start');
        this.lastError = error;
        this.closed = true;
        this.worker = null;
        this._discardStartupClaimIfOwned();
        const termination = Promise.resolve(worker.terminate());
        this._waitForStartupClaimRelease();
        void termination
          .catch(() => undefined)
          .finally(() => this._discardStartupClaimIfOwned());
        return false;
      }

      console.log(`[flight-csv] Worker recording started: ${this.filePath}`);
      const claimedStat = fs.statSync(this.filePath);
      if (
        !this.creationIdentity
        || claimedStat.dev !== this.creationIdentity.dev
        || claimedStat.ino !== this.creationIdentity.ino
      ) {
        throw new Error('CSV worker startup target identity changed');
      }
      this.rowCount = 1;
      this.nextSampleIndex = 1;
      return true;
    } catch (err) {
      const error = err as ErrorWithCode;
      this.lastError = error;
      this.closed = true;
      if (startupWorker) {
        this.worker = null;
        this._discardStartupClaimIfOwned();
        const termination = Promise.resolve(startupWorker.terminate());
        this._waitForStartupClaimRelease();
        void termination
          .catch(() => undefined)
          .finally(() => this._discardStartupClaimIfOwned());
      } else {
        this._discardStartupClaimIfOwned();
      }
      console.error(`[flight-csv] Worker start failed: ${error.message}`);
      return false;
    }
  }

  _handleWorkerMessage(message: WorkerResponse): void {
    if (this.closed && !this.worker) return;
    if (message?.type === 'progress' && typeof message.rowCount === 'number') {
      this.rowCount = Math.max(this.rowCount, message.rowCount);
      return;
    }

    if (message?.type === 'error' || message?.type === 'startError') {
      const error = new Error(message.error || 'CSV worker error') as ErrorWithCode;
      if (message.code) {
        error.code = message.code;
      }
      this._recordTerminalError(error);
      if (message.diskExhausted) {
        handleDiskExhaustion(this, error);
        this.closed = true;
        this._clearPendingLines();
        this._rejectPendingRequests(error);
        this._terminateWorker();
      }
      console.error(`[flight-csv] Worker error: ${this.lastError.message}`);
      return;
    }

    if (message?.type !== 'response' || typeof message.requestId !== 'number') {
      return;
    }

    const pending = this.pendingRequests.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(message.requestId);
    pending.onSettled?.();

    if (message.ok === false) {
      const error = new Error(message.error || 'CSV worker request failed');
      pending.onRejectedResponse?.(error);
      pending.reject(error);
    } else {
      pending.resolve(message);
    }
  }

  _handleWorkerFailure(err: Error): void {
    if (this.closed && !this.worker) return;
    this._recordTerminalError(err);
    this.closed = true;
    this._clearPendingLines();
    this._rejectPendingRequests(err);
    this._terminateWorker();
  }

  _recordTerminalError(error: Error): void {
    this.lastError = error;
    if (this.terminalErrorNotified) return;
    this.terminalErrorNotified = true;
    try { this.onTerminalError?.(error); } catch {}
  }

  _terminateWorker(): Promise<number> | null {
    if (this.workerTerminationPromise) return this.workerTerminationPromise;
    const worker = this.worker;
    this.worker = null;
    if (!worker) return null;
    try {
      const termination = Promise.resolve(worker.terminate()).finally(() => {
        if (this.workerTerminationPromise === termination) this.workerTerminationPromise = null;
      });
      this.workerTerminationPromise = termination;
      return termination;
    } catch {
      return null;
    }
  }

  _clearPendingLines(): void {
    this.pendingLines = [];
    this.pendingLineBytes = 0;
    this.flushScheduled = false;
  }

  _rejectPendingRequests(err: Error): void {
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.onSettled?.();
      pending.reject(err);
      this.pendingRequests.delete(requestId);
    }
  }

  _scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      if (this.closed) {
        this._clearPendingLines();
        return;
      }
      if (this.terminalErrorNotified) return;
      this._flushPendingLines();
    });
  }

  _flushPendingLines(allowAfterTerminal = false): boolean {
    if (this.terminalErrorNotified && !allowAfterTerminal) return false;
    if (this.pendingLines.length === 0) {
      this.flushScheduled = false;
      this.pendingLineBytes = 0;
      return true;
    }

    const lines = this.pendingLines;
    const lineBytes = this.pendingLineBytes;
    this.pendingLines = [];
    this.pendingLineBytes = 0;
    this.flushScheduled = false;
    return this._postAppendLines(lines, lineBytes, allowAfterTerminal);
  }

  _postAppendLines(lines: string[], lineBytes: number, allowAfterTerminal = false): boolean {
    if (this.closed || lines.length === 0) return false;
    if (!this.worker) {
      this._recordTerminalError(new Error('CSV worker disappeared before accepted rows were posted'));
      return false;
    }

    if (this.inflightAppendBytes + lineBytes > WORKER_INFLIGHT_APPEND_MAX_BYTES) {
      const error = new Error(
        `CSV worker backlog exceeded ${Math.round(WORKER_INFLIGHT_APPEND_MAX_BYTES / 1024 / 1024)}MiB`,
      );
      console.error(`[flight-csv] ${error.message}`);
      this._handleWorkerFailure(error);
      return false;
    }

    const requestId = this.nextRequestId++;
    let settled = false;
    const releaseBacklog = () => {
      if (settled) return;
      settled = true;
      this.inflightAppendBytes = Math.max(0, this.inflightAppendBytes - lineBytes);
      this.inflightAppendLines = Math.max(0, this.inflightAppendLines - lines.length);
    };

    this.inflightAppendBytes += lineBytes;
    this.inflightAppendLines += lines.length;

    const timeout = setTimeout(() => {
      if (!this.pendingRequests.delete(requestId)) return;
      releaseBacklog();
      this._handleWorkerFailure(new Error('CSV worker append request timed out'));
    }, WORKER_APPEND_REQUEST_TIMEOUT_MS);

    this.pendingRequests.set(requestId, {
      resolve: () => {},
      reject: () => {},
      timeout,
      onSettled: releaseBacklog,
      onRejectedResponse: (err) => {
        // A failed append is terminal for this recording, but the worker may
        // still be responsive enough to durably close its stream. Leave it
        // alive for the coordinated close handshake.
        this._recordTerminalError(err);
        this._clearPendingLines();
      },
    });

    if (!this._post({ type: 'appendLines', lines, requestId }, allowAfterTerminal)) {
      clearTimeout(timeout);
      this.pendingRequests.delete(requestId);
      releaseBacklog();
      return false;
    }

    return true;
  }

  _post(message: Record<string, unknown>, allowAfterTerminal = false): boolean {
    if (this.closed || (this.terminalErrorNotified && !allowAfterTerminal) || !this.worker) return false;
    try {
      this.worker.postMessage(message);
      return true;
    } catch (err) {
      this._handleWorkerFailure(err as Error);
      return false;
    }
  }

  _request(
    message: Record<string, unknown>,
    timeoutMs = 10000,
    options: { allowAfterTerminal?: boolean } = {},
  ): Promise<WorkerResponse> {
    if (this.closed || !this.worker) {
      return Promise.reject(new Error('CSV worker is not running'));
    }

    if (!this._flushPendingLines(options.allowAfterTerminal === true)) {
      return Promise.reject(new Error('CSV worker pending-line flush failed'));
    }

    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`CSV worker request timed out: ${message.type || 'unknown'}`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });
      if (!this._post({ ...message, requestId }, options.allowAfterTerminal === true)) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(new Error('CSV worker post failed'));
      }
    });
  }

  _appendCsvLine(line: string): boolean {
    if (this.closed) return false;
    if (!this.worker) {
      this._recordTerminalError(new Error('CSV worker is unavailable'));
      return false;
    }

    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (this.acceptedFileBytes + lineBytes > this.maxFileBytes) {
      this._recordTerminalError(new Error(`CSV reached the ${formatMiB(this.maxFileBytes)}MiB file cap`));
      return false;
    }

    this.pendingLines.push(line);
    this.pendingLineBytes += lineBytes;
    this.acceptedFileBytes += lineBytes;
    this.rowCount++;

    if (
      this.pendingLines.length >= WORKER_APPEND_BATCH_MAX_LINES
      || this.pendingLineBytes >= WORKER_APPEND_BATCH_MAX_BYTES
    ) {
      return this._flushPendingLines();
    }

    this._scheduleFlush();
    return true;
  }

  writeSample(frame: CsvFrame): boolean {
    if (this.closed || this.terminalErrorNotified || diskExhausted) return false;
    if (!this.worker) return false;

    try {
      const prev_recordType = frame._recordType;
      const prevSchemaVersion = frame.schemaVersion;
      const prev_schema_version = frame.schema_version;
      const prevFlightId = frame.flightId;
      const prevRecordingSessionId = frame.recordingSessionId;
      const prev_recording_session_id = frame.recording_session_id;
      const prevBundleStatusRequired = frame.bundleStatusRequired;
      const prev_bundle_status_required = frame.bundle_status_required;
      const prevElapsed = frame.flightElapsedMs;
      const prevTimestampMonotonic = frame.timestampMonotonic;
      const prev_timestamp_monotonic = frame.timestamp_monotonic;
      const prevFlightStartIso = frame.flightStartIso;
      const prev_flight_start = frame.flight_start;
      const prevTimestampMs = frame.timestampMs;
      const prev_timestamp_ms = frame.timestamp_ms;
      const prevTimestampIso = frame.timestampIso;
      const prev_timestamp_utc = frame.timestamp_utc;
      const prevSampleIndex = frame.sampleIndex;
      const prev_sample_index = frame.sample_index;
      const sampleIndex = this.nextSampleIndex;

      frame._recordType = 'SAMPLE';
      frame.schemaVersion = CSV_SCHEMA_VERSION;
      frame.schema_version = CSV_SCHEMA_VERSION;
      frame.flightId = this.flightId;
      frame.recordingSessionId = this.recordingSessionId;
      frame.recording_session_id = this.recordingSessionId;
      frame.bundleStatusRequired = this.bundleStatusRequired;
      frame.bundle_status_required = this.bundleStatusRequired;
      frame.flightElapsedMs = this._nextElapsedMs(timeSource.now());
      frame.timestampMs = this.startTime + frame.flightElapsedMs;
      frame.timestamp_ms = frame.timestampMs;
      frame.timestampIso = new Date(frame.timestampMs).toISOString();
      frame.timestamp_utc = frame.timestampIso;
      frame.timestampMonotonic = frame.flightElapsedMs;
      frame.timestamp_monotonic = frame.flightElapsedMs;
      frame.flightStartIso = this.recordingStartIso;
      frame.flight_start = this.recordingStartIso;
      frame.sampleIndex = sampleIndex;
      frame.sample_index = frame.sampleIndex;

      let row: CsvRow;
      try {
        row = schemaFieldMap.buildRow(frame);
      } finally {
        frame._recordType = prev_recordType;
        frame.schemaVersion = prevSchemaVersion;
        frame.schema_version = prev_schema_version;
        frame.flightId = prevFlightId;
        frame.recordingSessionId = prevRecordingSessionId;
        frame.recording_session_id = prev_recording_session_id;
        frame.bundleStatusRequired = prevBundleStatusRequired;
        frame.bundle_status_required = prev_bundle_status_required;
        frame.flightElapsedMs = prevElapsed;
        frame.timestampMonotonic = prevTimestampMonotonic;
        frame.timestamp_monotonic = prev_timestamp_monotonic;
        frame.flightStartIso = prevFlightStartIso;
        frame.flight_start = prev_flight_start;
        frame.timestampMs = prevTimestampMs;
        frame.timestamp_ms = prev_timestamp_ms;
        frame.timestampIso = prevTimestampIso;
        frame.timestamp_utc = prev_timestamp_utc;
        frame.sampleIndex = prevSampleIndex;
        frame.sample_index = prev_sample_index;
      }

      const ok = this._appendCsvLine(rowToCSV(row, this.lastCompactValues));
      if (ok) this.nextSampleIndex = sampleIndex + 1;
      return ok;
    } catch (err) {
      this._recordTerminalError(err as Error);
      console.error(`[flight-csv] Worker write error: ${this.lastError.message}`);
      return false;
    }
  }

  writeEvent(eventType: string, eventData: EventRowData, frame: CsvFrame = {}): boolean {
    if (this.closed || this.terminalErrorNotified || diskExhausted) return false;
    if (!this.worker) return false;

    try {
      const now = timeSource.now();
      const elapsedMs = this._nextElapsedMs(now);
      const eventId = resolveEventId(eventType, eventData, now);
      const sampleIndex = this.nextSampleIndex;
      const enrichedFrame = {
        ...frame,
        vs: eventData.vs ?? frame.vs,
        gForce: eventData.gforce ?? frame.gForce,
        ias: eventData.ias_kts ?? frame.ias,
        ra: frame.altitude?.ra ?? frame.ra ?? 0,
        onGround: frame.onGround ?? frame.on_ground ?? defaultOnGroundForEvent(eventType),
        phase: frame.phase || eventType,
        gearDownLocked: frame.gearDownLocked ?? frame.gear?.locked ?? true,
        icao: eventData.icao || '',
        runway: eventData.runway || '',
        touchdownDistanceFt: eventData.touchdown_distance_ft,
        touchdown_distance_ft: eventData.touchdown_distance_ft,
        previousPhase: eventData.previous_phase,
        previous_phase: eventData.previous_phase,
        goaroundAltitudeFt: eventData.altitude_ft,
        goaround_altitude_ft: eventData.altitude_ft,
        warningType: eventData.warning_type,
        warning_type: eventData.warning_type,
        warningActive: eventData.warning_active,
        warning_active: eventData.warning_active,
        overspeedType: eventData.overspeed_type,
        overspeed_type: eventData.overspeed_type,
        barberPoleKts: eventData.barber_pole_kts,
        barber_pole_kts: eventData.barber_pole_kts,
        warningDurationMs: eventData.warning_duration_ms,
        warning_duration_ms: eventData.warning_duration_ms,
        flapsPercent: eventData.flaps_percent,
        ...eventData,
        ...buildEventPhaseFields(eventType, eventData, frame),
        _recordType: eventType,
        schemaVersion: CSV_SCHEMA_VERSION,
        schema_version: CSV_SCHEMA_VERSION,
        flightId: this.flightId,
        recordingSessionId: this.recordingSessionId,
        recording_session_id: this.recordingSessionId,
        bundleStatusRequired: this.bundleStatusRequired,
        bundle_status_required: this.bundleStatusRequired,
        flightElapsedMs: elapsedMs,
        timestampMonotonic: elapsedMs,
        timestamp_monotonic: elapsedMs,
        flightStartIso: this.recordingStartIso,
        flight_start: this.recordingStartIso,
        timestampMs: this.startTime + elapsedMs,
        timestamp_ms: this.startTime + elapsedMs,
        timestampIso: new Date(this.startTime + elapsedMs).toISOString(),
        timestamp_utc: new Date(this.startTime + elapsedMs).toISOString(),
        eventId,
        event_id: eventId,
        sampleIndex,
      };

      const row = schemaFieldMap.buildRow(enrichedFrame);
      const ok = this._appendCsvLine(rowToCSV(row, this.lastCompactValues));
      if (ok) this.nextSampleIndex = sampleIndex + 1;
      if (ok && eventType === 'LANDING' && eventData.icao) {
        this.arrivalIcao = eventData.icao;
      }
      if (ok) {
        console.log(`[flight-csv] Event recorded: ${eventType}${eventData.icao ? ` at ${eventData.icao}` : ''}`);
      }
      return ok;
    } catch (err) {
      this._recordTerminalError(err as Error);
      console.error(`[flight-csv] Worker event write error: ${this.lastError.message}`);
      return false;
    }
  }

  close(): Promise<FlightRecordingStats> {
    // All callers must join the same durable close handshake.  Previously a
    // second close() observed `closed` after the first caller posted the worker
    // close command, then immediately terminated the worker.  That could abort
    // the fdatasync/stream-close sequence and leave the first caller waiting
    // for its request timeout.
    if (this.closePromise) return this.closePromise;

    if (this.closed) {
      const alreadyClosed = (async () => {
        try {
          const termination = this._terminateWorker() || this.workerTerminationPromise;
          if (termination) await termination;
        } catch {}
        return this.getStats();
      })();
      this.closePromise = alreadyClosed;
      return alreadyClosed;
    }

    const closing = (async () => {
      try {
        // A terminal stream error gates new rows, but the worker may still be
        // alive with already-accepted parent and stream buffers. Let this one
        // control path post those accepted rows and then perform the worker's
        // flush/end/close handshake before ownership ends.
        const closeRequest = this._request(
          { type: 'close' },
          60000,
          { allowAfterTerminal: this.terminalErrorNotified },
        );
        // _request posts every already-accepted batch and then the close command
        // synchronously. Gate public writes immediately after that ordering is
        // established so nothing can be accepted behind the worker close.
        this.closed = true;
        const response = await closeRequest;
        if (response.stats?.rowCount != null) {
          this.rowCount = response.stats.rowCount;
        }
        if (response.stats?.lastError) {
          this._recordTerminalError(new Error(response.stats.lastError));
        }
      } catch (err) {
        this._recordTerminalError(err as Error);
      } finally {
        this.closed = true;
        try {
          const termination = this._terminateWorker();
          if (termination) await termination;
        } catch {}
      }

      const stats = this.getStats();
      console.log(`[flight-csv] Worker recording complete: ${this.rowCount} rows, ${stats.fileSizeKb}KB`);
      return stats;
    })();
    this.closePromise = closing;
    return closing;
  }

  async flush(): Promise<boolean> {
    if (this.closed) return false;
    try {
      const response = await this._request({ type: 'flush' }, 30000);
      if (response.rowCount != null) {
        this.rowCount = Math.max(this.rowCount, response.rowCount);
      }
      return response.ok !== false;
    } catch (err) {
      this._recordTerminalError(err as Error);
      return false;
    }
  }

  closeSync(): FlightRecordingStats {
    if (this.closed) {
      try { this.worker?.terminate(); } catch {}
      this.worker = null;
      return this.getStats();
    }

    const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const control = new Int32Array(controlBuffer);
    try {
      this._flushPendingLines();
      this.worker?.postMessage({ type: 'closeSync', controlBuffer });
      Atomics.wait(control, 0, 0, 2000);
    } catch {}
    this._rejectPendingRequests(new Error('CSV worker closed synchronously'));
    this.closed = true;
    this._terminateWorker();
    return this.getStats();
  }

  getStats(): FlightRecordingStats {
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
      recordingStartEpochMs: this.startTime,
      recordingStartIso: this.recordingStartIso,
      bundleBaseName: this.bundleBaseName,
      filePath: this.filePath,
      filename: this.filename,
      outputDir: this.outputDir,
      rowCount: this.rowCount,
      fileSizeBytes,
      fileSizeKb: Math.round(fileSizeBytes / 1024),
      durationMs: timeSource.now() - this.startTime,
      departureIcao: this.departureIcao,
      arrivalIcao: this.arrivalIcao,
      hasError: !!this.lastError,
      lastError: this.lastError?.message,
      creationIdentity: this.creationIdentity,
    };
  }

  _nextElapsedMs(nowMs: number): number {
    this.lastElapsedMs = Math.max(0, this.lastElapsedMs, nowMs - this.startTime);
    return this.lastElapsedMs;
  }

}

// ═══════════════════════════════════════════════════════════════════════════
// Module API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Start recording a new flight.
 * Returns the writer instance, or null if recording failed to start.
 * 
 * A null return means the flight cannot be recorded.
 * Callers must handle this as "flight does not exist" per V1 Authority Rule.
 */
function startFlight(options: FlightWriterOptions = {}): CsvWriterInstance | null {
  if (activeFinalizationPromise || finalizingWriter) {
    console.warn('[flight-csv] Recording start refused while the previous CSV is finalizing.');
    return null;
  }

  if (activeWriter && !activeWriter.closed) {
    console.warn('[flight-csv] Recording start refused while a CSV writer is active.');
    return null;
  }
  
  // Reset disk exhaustion flag for new flight
  diskExhausted = false;

  const writerMode = getConfiguredCsvWriterMode(options);
  const writerOptions = {
    flightId: options.flightId || new Date().toISOString(),
    recordingSessionId: options.recordingSessionId,
    recordingStartEpochMs: options.recordingStartEpochMs,
    recordingStartIso: options.recordingStartIso,
    bundleBaseName: options.bundleBaseName,
    bundleStatusRequired: options.bundleStatusRequired,
    onTerminalError: options.onTerminalError,
    outputDir: options.outputDir,
    departureIcao: options.departureIcao,
    arrivalIcao: options.arrivalIcao,
    syncIntervalMs: options.syncIntervalMs,
    maxFileBytes: options.maxFileBytes,
    workerStartupTimeoutMs: options.workerStartupTimeoutMs,
    workerStartupDelayMs: options.workerStartupDelayMs,
    workerStartupNotifyDelayMs: options.workerStartupNotifyDelayMs,
    workerPeriodicSyncBarrierDelayMs: options.workerPeriodicSyncBarrierDelayMs,
    workerPeriodicSyncErrorCode: options.workerPeriodicSyncErrorCode,
    workerReportPeriodicSyncPhases: options.workerReportPeriodicSyncPhases,
  };

  let writer: CsvWriterInstance = writerMode === 'worker'
    ? new WorkerFlightCSVWriter(writerOptions)
    : new FlightCSVWriter(writerOptions);

  if (!writer.start()) {
    if (writerMode === 'worker') {
      console.warn('[flight-csv] Worker writer unavailable; falling back to inline writer');
      writer = new FlightCSVWriter(writerOptions);
      if (!writer.start()) {
        return null;
      }
    } else {
      // Startup failed; no recording can be created.
      return null;
    }
  }
  
  activeWriter = writer;
  
  return writer;
}

/**
 * Write a sample to the active flight.
 * No-op if no active flight.
 */
function writeSample(frame: CsvFrame): boolean {
  if (!activeWriter || activeWriter.closed) return false;
  const result = activeWriter.writeSample(frame);
  return result;
}

/**
 * Write an event to the active flight.
 * No-op if no active flight.
 */
function writeEvent(eventType: string, eventData: EventRowData, frame?: CsvFrame): boolean {
  if (!activeWriter || activeWriter.closed) return false;
  return activeWriter.writeEvent(eventType, eventData, frame);
}

/**
 * End the current flight recording.
 * Returns a Promise that resolves with stats about the recorded flight.
 * Waits for all data to be flushed to disk.
 */
async function endFlight(): Promise<FlightRecordingStats | null> {
  if (!activeWriter) return activeFinalizationPromise ? await activeFinalizationPromise : null;
  
  const writer = activeWriter;
  activeWriter = null;
  finalizingWriter = writer;
  const closePromise = writer.close();
  const trackedFinalization = closePromise.finally(() => {
    if (finalizingWriter === writer) finalizingWriter = null;
    if (activeFinalizationPromise === trackedFinalization) activeFinalizationPromise = null;
  });
  activeFinalizationPromise = trackedFinalization;
  return await trackedFinalization;
}

async function flush(): Promise<boolean> {
  if (!activeWriter || activeWriter.closed) return false;
  return await activeWriter.flush();
}

/**
 * Check if a flight is currently being recorded.
 */
function isRecording(): boolean {
  return activeWriter !== null && !activeWriter.closed;
}

function isFinalizing(): boolean {
  return activeFinalizationPromise !== null || finalizingWriter !== null;
}

/**
 * Get stats for the current flight (if recording).
 */
function getStats(): FlightRecordingStats | null {
  if (!activeWriter) return null;
  return activeWriter.getStats();
}

function getFinalizingStats(): FlightRecordingStats | null {
  if (!finalizingWriter) return null;
  return finalizingWriter.getStats();
}

/**
 * Get the V1 column schema.
 */
function getV1Columns(): string[] {
  return [...V1_COLUMNS];
}

module.exports = {
  // Primary API
  startFlight,
  endFlight,
  writeSample,
  writeEvent,
  
  // Query API
  isRecording,
  isFinalizing,
  getStats,
  getFinalizingStats,
  flush,
  
  // Schema
  getV1Columns,
  V1_COLUMNS,
  DEFAULT_MAX_CSV_FILE_BYTES,
  
  // Utilities
  getDefaultFlightLogsDir,
  generateFilename,
  sanitizeFlightId,
  
  // Class (for advanced usage)
  FlightCSVWriter,
  WorkerFlightCSVWriter,
};

export {};
