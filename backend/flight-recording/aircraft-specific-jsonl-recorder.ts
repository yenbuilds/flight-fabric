'use strict';

const fs = require('fs') as typeof import('fs');
const timeSource = require('../core/time-source') as { now: () => number };
const { resolveFlightLogsDir } = require('../utils/flight-logs-dir') as {
  resolveFlightLogsDir: (options?: { createIfMissing?: boolean }) => string;
};
const recordingBundleLayout = require('./recording-bundle-layout') as {
  BUNDLE_FILES: { aircraftSpecific: string };
  buildBundleName: (_flightId: unknown, _recordingSessionId: unknown) => string;
  getBundlePaths: (_outputDir: string, _bundleName: string) => { dir: string; aircraftSpecific: string };
};
const {
  assertSafeRecordingFilePath,
  createSafeRecordingWriteStream,
} = require('./recording-path-guard') as {
  assertSafeRecordingFilePath: (_options: RecordingPathOptions) => string;
  createSafeRecordingWriteStream: (_options: RecordingStreamOptions) => FsWriteStream;
};
const {
  closeWriteStreamDurably,
  flushWriteStreamDurably,
} = require('./recording-stream-durability') as {
  closeWriteStreamDurably: (_stream: FsWriteStream) => Promise<void>;
  flushWriteStreamDurably: (_stream: FsWriteStream) => Promise<void>;
};

type AnyRecord = Record<string, any>;
type Primitive = string | number | boolean;
type FsWriteStream = import('fs').WriteStream & { fd?: number | null };

type RecordingPathOptions = {
  extension: string;
  operation: string;
  outputDir: string;
  requiredSuffix?: string;
  targetPath: string;
};

type RecordingStreamOptions = RecordingPathOptions & { flags?: string };

type AircraftSpecificRecorderOptions = {
  flightId?: string;
  recordingSessionId?: string;
  recordingStartEpochMs?: number;
  recordingStartIso?: string;
  bundleBaseName?: string;
  bundleStatusRequired?: boolean;
  outputDir?: string;
  checkpointIntervalMs?: number;
  numericIntervalMs?: number;
  syncIntervalMs?: number;
  maxFileBytes?: number;
  onTerminalError?: (_error: Error) => void;
};

type FieldCatalogEntry = {
  id?: unknown;
  valueType?: unknown;
};

type AircraftSpecificStateInput = {
  timeMs?: number | null;
  timestampIso?: string | null;
  flightElapsedMs?: number | null;
  flightId?: string | null;
  flightStartIso?: string | null;
  aircraftTitle?: string | null;
  profileKey?: string | null;
  profileRevision?: number | null;
  integrationId?: string | null;
  templateId?: string | null;
  available?: boolean | null;
  sourceStatus?: AnyRecord | null;
  values?: AnyRecord | null;
  unavailable?: unknown[] | null;
  fieldCatalog?: FieldCatalogEntry[] | null;
};

type RecorderSnapshot = {
  timeMs: number;
  timestampIso: string;
  flightElapsedMs: number | null;
  flightId: string | null;
  recordingSessionId?: string | null;
  flightStartIso: string | null;
  aircraftTitle: string | null;
  profileKey: string;
  profileRevision: number | null;
  integrationId: string | null;
  templateId: string | null;
  configSignature: string;
  fieldTypes: Record<string, string>;
  valueTypeByField: Record<string, string>;
  available: boolean;
  sourceStatus: {
    overall: string;
    sources: Record<string, string>;
  };
  values: Record<string, Primitive>;
  unavailable: string[];
};

type AircraftSpecificRecorderStats = {
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
  hasFile: boolean;
  hasError: boolean;
  lastError: string | undefined;
  captureDisabled: boolean;
  creationIdentity: { dev: number; ino: number } | null;
};

const AIRCRAFT_SPECIFIC_SCHEMA_VERSION = 2;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 60_000;
const DEFAULT_NUMERIC_INTERVAL_MS = 1_000;
const DEFAULT_SYNC_INTERVAL_MS = 30_000;
const DEFAULT_MAX_FILE_BYTES = 200 * 1024 * 1024;
const JSONL_STREAM_BACKLOG_MAX_BYTES = 16 * 1024 * 1024;

const SAFE_FIELD_ID_RE = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;
const SAFE_SOURCE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const FIELD_VALUE_TYPES = new Set(['boolean', 'enum', 'number']);
const SOURCE_STATUSES = new Set([
  'connected',
  'stale',
  'disconnected',
  'disabled',
  'paused',
  'error',
  'unsupported',
  'awaiting-values',
]);

let activeRecorder: AircraftSpecificJsonlRecorder | null = null;
let activeFinalizationPromise: Promise<AircraftSpecificRecorderStats | null> | null = null;

function getDefaultFlightLogsDir(): string {
  return resolveFlightLogsDir({ createIfMissing: true });
}

function isRecord(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeText(value: unknown, maxLength = 256): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeTimestamp(value: unknown, timeMs: number): string {
  if (typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))) return value;
  return new Date(timeMs).toISOString();
}

function sanitizeFieldTypes(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const byId = new Map<string, string>();
  for (const rawEntry of value) {
    if (!isRecord(rawEntry)) continue;
    const id = typeof rawEntry.id === 'string' ? rawEntry.id : '';
    const valueType = typeof rawEntry.valueType === 'string' ? rawEntry.valueType : '';
    if (id.length > 128 || !SAFE_FIELD_ID_RE.test(id) || !FIELD_VALUE_TYPES.has(valueType) || byId.has(id)) continue;
    byId.set(id, valueType);
    if (byId.size >= 128) break;
  }
  return Object.fromEntries([...byId.entries()].sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  )));
}

function sanitizePrimitive(value: unknown, valueType: string): Primitive | undefined {
  if (valueType === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (valueType === 'number') {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
  if (valueType === 'enum') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
  }
  return undefined;
}

function sanitizeSourceStatus(value: unknown): RecorderSnapshot['sourceStatus'] {
  const raw = isRecord(value) ? value : {};
  const rawOverall = typeof raw.overall === 'string' ? raw.overall : '';
  const sources: Record<string, string> = {};
  if (isRecord(raw.sources)) {
    for (const sourceId of Object.keys(raw.sources).sort()) {
      const status = raw.sources[sourceId];
      if (SAFE_SOURCE_ID_RE.test(sourceId) && typeof status === 'string' && SOURCE_STATUSES.has(status)) {
        sources[sourceId] = status;
        if (Object.keys(sources).length >= 32) break;
      }
    }
  }
  return {
    overall: SOURCE_STATUSES.has(rawOverall) ? rawOverall : 'awaiting-values',
    sources,
  };
}

function buildConfigSignature(params: {
  profileKey: string;
  profileRevision: number | null;
  integrationId: string | null;
  templateId: string | null;
  fieldTypes: Record<string, string>;
}): string {
  return JSON.stringify({
    profileKey: params.profileKey,
    profileRevision: params.profileRevision,
    integrationId: params.integrationId,
    templateId: params.templateId,
    fieldTypes: params.fieldTypes,
  });
}

function buildSnapshot(
  input: AircraftSpecificStateInput,
  recorderFlightId?: string,
): RecorderSnapshot | null {
  const profileKey = sanitizeText(input.profileKey, 256);
  const fieldTypes = sanitizeFieldTypes(input.fieldCatalog);
  if (!profileKey || Object.keys(fieldTypes).length === 0) return null;

  const integrationId = sanitizeText(input.integrationId, 128);
  const templateId = sanitizeText(input.templateId, 128);
  const revision = finiteNumberOrNull(input.profileRevision);
  const profileRevision = revision != null && Number.isInteger(revision) && revision >= 0 ? revision : null;
  const configSignature = buildConfigSignature({
    profileKey,
    profileRevision,
    integrationId,
    templateId,
    fieldTypes,
  });
  const timeMs = finiteNumberOrNull(input.timeMs) ?? Date.now();
  const flightElapsed = finiteNumberOrNull(input.flightElapsedMs);
  const catalogTypes = new Map(Object.entries(fieldTypes));
  const valueTypeByField = { ...fieldTypes };
  const values: Record<string, Primitive> = {};
  const rawValues = isRecord(input.values) ? input.values : {};

  for (const [fieldId, valueType] of Object.entries(fieldTypes)) {
    const normalized = sanitizePrimitive(rawValues[fieldId], valueType);
    if (normalized !== undefined) values[fieldId] = normalized;
  }

  const unavailableSet = new Set<string>();
  if (Array.isArray(input.unavailable)) {
    for (const id of input.unavailable) {
      if (typeof id === 'string' && catalogTypes.has(id)) unavailableSet.add(id);
    }
  }
  for (const fieldId of Object.keys(fieldTypes)) {
    if (!Object.prototype.hasOwnProperty.call(values, fieldId)) unavailableSet.add(fieldId);
  }

  return {
    timeMs,
    timestampIso: normalizeTimestamp(input.timestampIso, timeMs),
    flightElapsedMs: flightElapsed != null && flightElapsed >= 0 ? flightElapsed : null,
    flightId: sanitizeText(input.flightId, 256) || sanitizeText(recorderFlightId, 256),
    flightStartIso: sanitizeText(input.flightStartIso, 64),
    aircraftTitle: sanitizeText(input.aircraftTitle, 256),
    profileKey,
    profileRevision,
    integrationId,
    templateId,
    configSignature,
    fieldTypes,
    valueTypeByField,
    available: Object.keys(values).length > 0,
    sourceStatus: sanitizeSourceStatus(input.sourceStatus),
    values,
    unavailable: [...unavailableSet].sort(),
  };
}

function commonRowFields(snapshot: RecorderSnapshot, configId: number, extra: AnyRecord = {}): AnyRecord {
  return {
    flightElapsedMs: snapshot.flightElapsedMs,
    configId,
    ...extra,
  };
}

function samePrimitive(left: Primitive | undefined, right: Primitive | undefined): boolean {
  return Object.is(left, right);
}

function sortedDifference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value)).sort();
}

function sourceStatusDelta(previous: RecorderSnapshot['sourceStatus'], current: RecorderSnapshot['sourceStatus']): AnyRecord | null {
  const changed: AnyRecord = {};
  if (previous.overall !== current.overall) changed.overall = current.overall;
  const sourcesSet: Record<string, string> = {};
  const sourcesRemoved: string[] = [];
  for (const [sourceId, status] of Object.entries(current.sources)) {
    if (previous.sources[sourceId] !== status) sourcesSet[sourceId] = status;
  }
  for (const sourceId of Object.keys(previous.sources)) {
    if (!Object.prototype.hasOwnProperty.call(current.sources, sourceId)) sourcesRemoved.push(sourceId);
  }
  if (Object.keys(sourcesSet).length > 0) changed.sourcesSet = sourcesSet;
  if (sourcesRemoved.length > 0) changed.sourcesRemoved = sourcesRemoved.sort();
  return Object.keys(changed).length > 0 ? changed : null;
}

function jsonlBytes(line: string): number {
  return Buffer.byteLength(line, 'utf8') + 1;
}

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}

function formatByteLimit(bytes: number): string {
  return bytes < 1024 * 1024 ? `${bytes} bytes` : `${formatMiB(bytes)} MiB`;
}

class AircraftSpecificJsonlRecorder {
  flightId: string | undefined;
  recordingSessionId: string | undefined;
  bundleStatusRequired: boolean;
  recordingStartEpochMs: number;
  recordingStartIso: string;
  bundleBaseName: string;
  outputDir: string;
  filename: string;
  filePath: string;
  stream: FsWriteStream | null;
  rowCount: number;
  seq: number;
  lastError: Error | null;
  started: boolean;
  closed: boolean;
  captureDisabled: boolean;
  physicalFileCreated: boolean;
  checkpointIntervalMs: number;
  numericIntervalMs: number;
  maxFileBytes: number;
  acceptedFileBytes: number;
  persistedConfigSignature: string | null;
  persistedConfigId: number | null;
  lastCheckpointMs: number | null;
  latestSnapshot: RecorderSnapshot | null;
  emittedSnapshot: RecorderSnapshot | null;
  lastNumericWriteMs: Map<string, number>;
  onTerminalError: ((_error: Error) => void) | null;
  terminalErrorNotified: boolean;
  creationIdentity: { dev: number; ino: number } | null;
  syncIntervalMs: number;
  lastSyncTime: number;
  periodicSyncPromise: Promise<void> | null;
  explicitFlushPromise: Promise<boolean> | null;
  periodicSyncTimer: NodeJS.Timeout | null;
  syncDirty: boolean;
  syncCatchUpDue: boolean;

  constructor(options: AircraftSpecificRecorderOptions = {}) {
    this.flightId = options.flightId;
    this.recordingSessionId = options.recordingSessionId || options.flightId;
    this.bundleStatusRequired = options.bundleStatusRequired === true;
    if (!this.recordingSessionId || !this.flightId) throw new Error('Aircraft-specific recording identities are required');
    this.recordingStartEpochMs = Number.isFinite(options.recordingStartEpochMs)
      ? Number(options.recordingStartEpochMs)
      : timeSource.now();
    this.recordingStartIso = options.recordingStartIso || new Date(this.recordingStartEpochMs).toISOString();
    if (Date.parse(this.recordingStartIso) !== this.recordingStartEpochMs) {
      throw new Error('Aircraft-specific recording start clock is inconsistent');
    }
    const flightLogsDir = options.outputDir || getDefaultFlightLogsDir();
    this.bundleBaseName = options.bundleBaseName
      || recordingBundleLayout.buildBundleName(this.recordingStartIso, this.recordingSessionId);
    const bundlePaths = recordingBundleLayout.getBundlePaths(flightLogsDir, this.bundleBaseName);
    this.outputDir = bundlePaths.dir;
    this.filename = recordingBundleLayout.BUNDLE_FILES.aircraftSpecific;
    this.filePath = bundlePaths.aircraftSpecific;
    this.stream = null;
    this.rowCount = 0;
    this.seq = 0;
    this.lastError = null;
    this.started = false;
    this.closed = false;
    this.captureDisabled = false;
    this.physicalFileCreated = false;
    this.checkpointIntervalMs = Number.isFinite(options.checkpointIntervalMs)
      ? Math.max(1, Number(options.checkpointIntervalMs))
      : DEFAULT_CHECKPOINT_INTERVAL_MS;
    this.numericIntervalMs = Number.isFinite(options.numericIntervalMs)
      ? Math.max(0, Number(options.numericIntervalMs))
      : DEFAULT_NUMERIC_INTERVAL_MS;
    this.maxFileBytes = Number.isFinite(options.maxFileBytes)
      ? Math.max(1, Number(options.maxFileBytes))
      : DEFAULT_MAX_FILE_BYTES;
    this.acceptedFileBytes = 0;
    this.persistedConfigSignature = null;
    this.persistedConfigId = null;
    this.lastCheckpointMs = null;
    this.latestSnapshot = null;
    this.emittedSnapshot = null;
    this.lastNumericWriteMs = new Map();
    this.onTerminalError = typeof options.onTerminalError === 'function' ? options.onTerminalError : null;
    this.terminalErrorNotified = false;
    this.creationIdentity = null;
    this.syncIntervalMs = Number.isFinite(options.syncIntervalMs)
      ? Math.max(0, Number(options.syncIntervalMs))
      : DEFAULT_SYNC_INTERVAL_MS;
    this.lastSyncTime = timeSource.now();
    this.periodicSyncPromise = null;
    this.explicitFlushPromise = null;
    this.periodicSyncTimer = null;
    this.syncDirty = false;
    this.syncCatchUpDue = false;
  }

  start(): boolean {
    if (this.closed || this.started || this.stream || this.physicalFileCreated || this.seq > 0) {
      console.warn('[aircraft-specific-jsonl] Recorder instance cannot be started more than once.');
      return false;
    }
    let claimedFd: number | null = null;
    try {
      this.filePath = assertSafeRecordingFilePath({
        extension: '.jsonl',
        operation: 'prepareAircraftSpecificJsonlRecording',
        outputDir: this.outputDir,
        requiredSuffix: recordingBundleLayout.BUNDLE_FILES.aircraftSpecific,
        targetPath: this.filePath,
      });
      if (fs.existsSync(this.filePath)) {
        const stat = fs.statSync(this.filePath);
        if (!stat.isFile()) throw new Error('aircraft-specific recording target is not a file');
        throw new Error('aircraft-specific recording target already exists; refusing to append a second schema sequence');
      }
      const manifestRow: AnyRecord = {
        type: 'aircraft_specific_manifest',
        timeMs: this.recordingStartEpochMs,
        timestampIso: this.recordingStartIso,
        flightElapsedMs: 0,
        flightId: this.flightId,
        recordingSessionId: this.recordingSessionId,
        bundleStatusRequired: this.bundleStatusRequired,
        flightStartIso: this.recordingStartIso,
      };
      const manifestLine = JSON.stringify({
        ...manifestRow,
        schemaVersion: AIRCRAFT_SPECIFIC_SCHEMA_VERSION,
        seq: 1,
      });
      const manifestBytes = jsonlBytes(manifestLine);
      if (manifestBytes > this.maxFileBytes) {
        this.recordLimitError(`Aircraft-specific JSONL reached the ${formatByteLimit(this.maxFileBytes)} file cap`);
        throw this.lastError || new Error('Aircraft-specific identity manifest exceeds the file cap');
      }
      claimedFd = fs.openSync(this.filePath, 'wx');
      const claimedStat = fs.fstatSync(claimedFd);
      this.creationIdentity = { dev: claimedStat.dev, ino: claimedStat.ino };
      this.physicalFileCreated = true;
      fs.writeFileSync(claimedFd, `${manifestLine}\n`, { encoding: 'utf8' });
      fs.fdatasyncSync(claimedFd);
      const stream = fs.createWriteStream(this.filePath, { fd: claimedFd, autoClose: true }) as FsWriteStream;
      claimedFd = null;
      this.stream = stream;
      this.startPeriodicSyncTimer();
      stream.on('error', (error: Error) => {
        this.recordError(error, true);
        if (this.stream === stream) this.stream = null;
      });
      this.seq = 1;
      this.rowCount = 1;
      this.acceptedFileBytes = manifestBytes;
      this.started = true;
      console.log(`[aircraft-specific-jsonl] Recording started: ${this.filePath}`);
      return true;
    } catch (error) {
      this.clearPeriodicSyncTimer();
      if (claimedFd !== null) {
        try { fs.closeSync(claimedFd); } catch {}
        claimedFd = null;
      }
      this.recordError(error, true);
      this.discardFailedStartClaim();
      return false;
    }
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
            this.physicalFileCreated = false;
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

  ensureStream(): boolean {
    if (!this.started || this.closed || this.captureDisabled) return false;
    if (this.stream) return true;
    try {
      const stream = createSafeRecordingWriteStream({
        extension: '.jsonl',
        flags: 'wx',
        operation: 'openAircraftSpecificJsonlRecording',
        outputDir: this.outputDir,
        requiredSuffix: recordingBundleLayout.BUNDLE_FILES.aircraftSpecific,
        targetPath: this.filePath,
      });
      this.stream = stream;
      if (typeof stream.fd === 'number') {
        const claimedStat = fs.fstatSync(stream.fd);
        this.creationIdentity = { dev: claimedStat.dev, ino: claimedStat.ino };
      }
      // Exclusive create claims the descriptor synchronously.
      this.physicalFileCreated = true;
      stream.on('error', (error: Error) => {
        this.recordError(error, true);
        if (this.stream === stream) this.stream = null;
      });
      console.log(`[aircraft-specific-jsonl] Recording started: ${this.filePath}`);
      return true;
    } catch (error) {
      this.recordError(error, true);
      return false;
    }
  }

  recordError(error: unknown, disableCapture = false): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (this.lastError?.message === normalized.message) {
      if (disableCapture) {
        this.captureDisabled = true;
        if (!this.terminalErrorNotified) {
          this.terminalErrorNotified = true;
          try { this.onTerminalError?.(normalized); } catch {}
        }
      }
      return;
    }
    this.lastError = normalized;
    if (disableCapture) {
      this.captureDisabled = true;
      this.clearPeriodicSyncTimer();
      if (!this.terminalErrorNotified) {
        this.terminalErrorNotified = true;
        try { this.onTerminalError?.(normalized); } catch {}
      }
    }
    console.error(`[aircraft-specific-jsonl] ${normalized.message}`);
  }

  startPeriodicSyncTimer(): void {
    if (this.periodicSyncTimer || this.syncIntervalMs <= 0) return;
    this.periodicSyncTimer = setInterval(() => {
      const stream = this.stream;
      if (!this.closed && !this.captureDisabled && stream) this.scheduleSyncIfDue(stream, true);
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
          throw new Error('Aircraft-specific JSONL periodic sync file descriptor is unavailable');
        }
        await new Promise<void>((resolve, reject) => {
          fs.fdatasync(stream.fd as number, (error: NodeJS.ErrnoException | null) => (
            error ? reject(error) : resolve()
          ));
        });
        this.lastSyncTime = now;
      } catch (error) {
        this.recordError(error, true);
      }
    })().finally(() => {
      if (this.periodicSyncPromise === pending) this.periodicSyncPromise = null;
      const shouldCatchUp = this.syncCatchUpDue || this.syncIntervalMs <= 0;
      this.syncCatchUpDue = false;
      if (
        this.syncDirty
        && shouldCatchUp
        && !this.closed
        && !this.captureDisabled
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

  recordLimitError(message: string): void {
    if (this.lastError?.message === message) return;
    this.recordError(new Error(message), true);
  }

  buildConfigRow(snapshot: RecorderSnapshot, reason: string, configId: number): AnyRecord {
    return commonRowFields(snapshot, configId, {
      type: 'aircraft_specific_config',
      reason,
      aircraftTitle: snapshot.aircraftTitle,
      profileKey: snapshot.profileKey,
      profileRevision: snapshot.profileRevision,
      integrationId: snapshot.integrationId,
      templateId: snapshot.templateId,
      fieldTypes: snapshot.fieldTypes,
    });
  }

  buildCheckpointRow(
    snapshot: RecorderSnapshot,
    reason: string,
    configId: number,
    extra: AnyRecord = {},
  ): AnyRecord {
    return commonRowFields(snapshot, configId, {
      type: 'aircraft_specific_checkpoint',
      reason,
      available: snapshot.available,
      sourceStatus: snapshot.sourceStatus,
      values: snapshot.values,
      unavailable: snapshot.unavailable,
      ...extra,
    });
  }

  writeRows(rows: AnyRecord[]): boolean {
    if (!this.started || this.closed || this.captureDisabled || rows.length === 0) return false;
    let nextSeq = this.seq;
    let lines: string[];
    try {
      lines = rows.map((row) => JSON.stringify({
        ...row,
        bundleStatusRequired: this.bundleStatusRequired,
        schemaVersion: AIRCRAFT_SPECIFIC_SCHEMA_VERSION,
        seq: ++nextSeq,
      }));
    } catch (error) {
      this.recordError(error, true);
      return false;
    }
    const totalBytes = lines.reduce((total, line) => total + jsonlBytes(line), 0);
    if (this.acceptedFileBytes + totalBytes > this.maxFileBytes) {
      this.recordLimitError(`Aircraft-specific JSONL reached the ${formatByteLimit(this.maxFileBytes)} file cap`);
      return false;
    }

    if (!this.ensureStream() || !this.stream) return false;
    const pendingBytes = typeof this.stream.writableLength === 'number' ? this.stream.writableLength : 0;
    if (pendingBytes + totalBytes > JSONL_STREAM_BACKLOG_MAX_BYTES) {
      this.recordLimitError(
        `Aircraft-specific JSONL stream backlog exceeded ${formatMiB(JSONL_STREAM_BACKLOG_MAX_BYTES)} MiB`,
      );
      return false;
    }
    try {
      for (const line of lines) this.stream.write(`${line}\n`);
      this.syncDirty = true;
      this.scheduleSyncIfDue(this.stream);
    } catch (error) {
      this.recordError(error, true);
      return false;
    }

    this.seq = nextSeq;
    this.rowCount += rows.length;
    this.acceptedFileBytes += totalBytes;
    return true;
  }

  resetNumericWriteTimes(snapshot: RecorderSnapshot): void {
    this.lastNumericWriteMs.clear();
    for (const [fieldId, value] of Object.entries(snapshot.values)) {
      if (snapshot.valueTypeByField[fieldId] === 'number' && typeof value === 'number') {
        this.lastNumericWriteMs.set(fieldId, snapshot.timeMs);
      }
    }
  }

  acceptCheckpoint(snapshot: RecorderSnapshot, configId: number): void {
    this.latestSnapshot = snapshot;
    this.emittedSnapshot = snapshot;
    this.persistedConfigSignature = snapshot.configSignature;
    this.persistedConfigId = configId;
    this.lastCheckpointMs = snapshot.timeMs;
    this.resetNumericWriteTimes(snapshot);
  }

  recordAircraftSpecificState(input: AircraftSpecificStateInput): boolean {
    if (!this.started || this.closed) return false;
    const requestedTimeMs = finiteNumberOrNull(input?.timeMs) ?? timeSource.now();
    const previousLatest = this.latestSnapshot;
    const timeMs = Math.max(
      requestedTimeMs,
      this.recordingStartEpochMs,
      previousLatest?.timeMs ?? this.recordingStartEpochMs,
    );
    const flightElapsedMs = Math.max(
      0,
      timeMs - this.recordingStartEpochMs,
      previousLatest?.flightElapsedMs ?? 0,
    );
    const snapshot = buildSnapshot({
      ...(input || {}),
      timeMs,
      timestampIso: new Date(timeMs).toISOString(),
      flightId: this.flightId,
      flightStartIso: this.recordingStartIso,
      flightElapsedMs,
    }, this.flightId);
    if (!snapshot) return false;
    snapshot.recordingSessionId = this.recordingSessionId || this.flightId || null;
    if (previousLatest) {
      snapshot.flightStartIso ||= previousLatest.flightStartIso;
      snapshot.aircraftTitle ||= previousLatest.aircraftTitle;
      if (snapshot.flightElapsedMs == null && snapshot.flightStartIso) {
        const startMs = Date.parse(snapshot.flightStartIso);
        if (Number.isFinite(startMs) && snapshot.timeMs >= startMs) {
          snapshot.flightElapsedMs = snapshot.timeMs - startMs;
        }
      }
      if (
        snapshot.flightElapsedMs == null
        && previousLatest.flightElapsedMs != null
        && snapshot.timeMs >= previousLatest.timeMs
      ) {
        snapshot.flightElapsedMs = previousLatest.flightElapsedMs + (snapshot.timeMs - previousLatest.timeMs);
      }
    }
    this.latestSnapshot = snapshot;
    if (this.captureDisabled) return false;

    const firstSnapshot = !this.emittedSnapshot;
    const configChanged = !firstSnapshot
      && snapshot.configSignature !== this.persistedConfigSignature;
    if (firstSnapshot || configChanged) {
      const reason = firstSnapshot ? 'first_snapshot' : 'profile_change';
      const rows: AnyRecord[] = [];
      const previousConfigId = this.persistedConfigId;
      const nextConfigId = (previousConfigId ?? 0) + 1;
      if (configChanged && previousLatest) {
        // Close the old logical contract with its newest state before installing
        // the new one. This preserves numeric changes that were still inside the
        // coalescing interval when a profile/config revision switched.
        rows.push(this.buildCheckpointRow(previousLatest, 'profile_change_end', previousConfigId as number, {
          nextProfileKey: snapshot.profileKey,
          nextProfileRevision: snapshot.profileRevision,
          nextConfigId,
        }));
      }
      rows.push(
        this.buildConfigRow(snapshot, reason, nextConfigId),
        this.buildCheckpointRow(snapshot, reason, nextConfigId),
      );
      const ok = this.writeRows(rows);
      if (ok) this.acceptCheckpoint(snapshot, nextConfigId);
      return ok;
    }

    const configId = this.persistedConfigId;
    if (configId === null) return false;

    const elapsedSinceCheckpoint = this.lastCheckpointMs == null
      ? Number.POSITIVE_INFINITY
      : snapshot.timeMs - this.lastCheckpointMs;
    if (elapsedSinceCheckpoint >= this.checkpointIntervalMs) {
      const ok = this.writeRows([this.buildCheckpointRow(snapshot, 'heartbeat', configId)]);
      if (ok) this.acceptCheckpoint(snapshot, configId);
      return ok;
    }

    const previous = this.emittedSnapshot;
    if (!previous) return false;
    const valuesSet: Record<string, Primitive> = {};
    const valuesRemoved: string[] = [];
    const numericFieldsWritten: string[] = [];

    for (const [fieldId, currentValue] of Object.entries(snapshot.values)) {
      const hadPrevious = Object.prototype.hasOwnProperty.call(previous.values, fieldId);
      const previousValue = previous.values[fieldId];
      if (hadPrevious && samePrimitive(previousValue, currentValue)) continue;
      if (
        hadPrevious
        && snapshot.valueTypeByField[fieldId] === 'number'
        && typeof previousValue === 'number'
        && typeof currentValue === 'number'
      ) {
        const lastWriteMs = this.lastNumericWriteMs.get(fieldId) ?? previous.timeMs;
        if (snapshot.timeMs - lastWriteMs < this.numericIntervalMs) continue;
        numericFieldsWritten.push(fieldId);
      }
      valuesSet[fieldId] = currentValue;
    }
    for (const fieldId of Object.keys(previous.values)) {
      if (!Object.prototype.hasOwnProperty.call(snapshot.values, fieldId)) valuesRemoved.push(fieldId);
    }

    const unavailableAdded = sortedDifference(snapshot.unavailable, previous.unavailable);
    const unavailableRemoved = sortedDifference(previous.unavailable, snapshot.unavailable);
    const statusChanged = sourceStatusDelta(previous.sourceStatus, snapshot.sourceStatus);
    const delta: AnyRecord = {};
    if (Object.keys(valuesSet).length > 0) delta.valuesSet = valuesSet;
    if (valuesRemoved.length > 0) delta.valuesRemoved = valuesRemoved.sort();
    if (unavailableAdded.length > 0) delta.unavailableAdded = unavailableAdded;
    if (unavailableRemoved.length > 0) delta.unavailableRemoved = unavailableRemoved;
    if (statusChanged) delta.sourceStatusChanged = statusChanged;
    if (previous.available !== snapshot.available) delta.availableChanged = snapshot.available;
    if (Object.keys(delta).length === 0) return true;

    const ok = this.writeRows([commonRowFields(snapshot, configId, {
      type: 'aircraft_specific_delta',
      ...delta,
    })]);
    if (!ok) return false;

    const nextEmittedValues = { ...previous.values };
    for (const [fieldId, value] of Object.entries(valuesSet)) nextEmittedValues[fieldId] = value;
    for (const fieldId of valuesRemoved) {
      delete nextEmittedValues[fieldId];
      this.lastNumericWriteMs.delete(fieldId);
    }
    for (const fieldId of numericFieldsWritten) this.lastNumericWriteMs.set(fieldId, snapshot.timeMs);
    for (const [fieldId, value] of Object.entries(valuesSet)) {
      if (
        snapshot.valueTypeByField[fieldId] === 'number'
        && typeof value === 'number'
        && typeof previous.values[fieldId] !== 'number'
      ) {
        this.lastNumericWriteMs.set(fieldId, snapshot.timeMs);
      } else if (snapshot.valueTypeByField[fieldId] !== 'number' || typeof value !== 'number') {
        this.lastNumericWriteMs.delete(fieldId);
      }
    }
    this.emittedSnapshot = { ...snapshot, values: nextEmittedValues };
    return true;
  }

  buildFinalSnapshot(endContext: AnyRecord): RecorderSnapshot | null {
    if (!this.latestSnapshot) return null;
    const latest = this.latestSnapshot;
    const timeMs = Math.max(finiteNumberOrNull(endContext.timeMs) ?? latest.timeMs, latest.timeMs);
    const elapsed = Math.max(
      0,
      timeMs - this.recordingStartEpochMs,
      latest.flightElapsedMs ?? 0,
    );
    return {
      ...latest,
      timeMs,
      timestampIso: new Date(timeMs).toISOString(),
      flightElapsedMs: elapsed,
      flightId: sanitizeText(this.flightId, 256),
      recordingSessionId: sanitizeText(this.recordingSessionId, 256),
      flightStartIso: this.recordingStartIso,
      aircraftTitle: sanitizeText(endContext.aircraftTitle, 256) || latest.aircraftTitle,
    };
  }

  writeFinalCheckpoint(endContext: AnyRecord = {}): boolean {
    if (!this.started || this.closed || this.captureDisabled) return false;
    const snapshot = this.buildFinalSnapshot(endContext);
    if (!snapshot) return false;
    const endReason = sanitizeText(endContext.endReason, 128) || 'recording_end';
    const rows: AnyRecord[] = [];
    let configId = this.persistedConfigId;
    if (snapshot.configSignature !== this.persistedConfigSignature) {
      configId = (configId ?? 0) + 1;
      rows.push(this.buildConfigRow(snapshot, 'recording_end', configId));
    }
    if (configId === null) return false;
    rows.push(this.buildCheckpointRow(snapshot, 'recording_end', configId, { endReason }));
    const ok = this.writeRows(rows);
    if (ok) this.acceptCheckpoint(snapshot, configId);
    return ok;
  }

  flush(): Promise<boolean> {
    if (!this.started || this.closed || this.captureDisabled) return Promise.resolve(false);
    const previousFlush = this.explicitFlushPromise;
    const pending = (async () => {
      try {
        if (previousFlush) await previousFlush;
        const stream = this.stream;
        if (!stream) return !this.physicalFileCreated;
        await this.waitForPeriodicSync();
        await flushWriteStreamDurably(stream);
        return true;
      } catch (error) {
        this.recordError(error, true);
        return false;
      }
    })();
    this.explicitFlushPromise = pending;
    void pending.then(() => {
      if (this.explicitFlushPromise === pending) this.explicitFlushPromise = null;
    });
    return pending;
  }

  async close(endContext: AnyRecord = {}): Promise<AircraftSpecificRecorderStats> {
    if (this.closed) return this.getStats();
    this.clearPeriodicSyncTimer();
    try {
      if (endContext.skipFinalCheckpoint !== true) {
        this.writeFinalCheckpoint(endContext);
      }
    } catch (error) {
      this.recordError(error);
    }
    this.closed = true;
    await this.waitForExplicitFlush();
    const stream = this.stream;
    this.stream = null;
    if (stream) {
      try {
        await this.waitForPeriodicSync();
        await closeWriteStreamDurably(stream);
      } catch (error) {
        this.recordError(error, true);
      }
    }
    const stats = this.getStats();
    console.log(`[aircraft-specific-jsonl] Recording complete: ${stats.rowCount} rows, ${stats.fileSizeKb}KB`);
    return stats;
  }

  closeSync(): AircraftSpecificRecorderStats {
    if (this.closed) return this.getStats();
    this.clearPeriodicSyncTimer();
    try {
      this.writeFinalCheckpoint({ endReason: 'recorder_replaced' });
    } catch (error) {
      this.recordError(error);
    }
    this.closed = true;
    if (this.stream) this.stream.end();
    this.stream = null;
    return this.getStats();
  }

  getStats(): AircraftSpecificRecorderStats {
    let statBytes = 0;
    let hasFile = false;
    try {
      if (fs.existsSync(this.filePath)) {
        const stat = fs.statSync(this.filePath);
        hasFile = stat.isFile();
        if (hasFile) {
          statBytes = stat.size;
        }
      }
    } catch {}
    const fileSizeBytes = statBytes;
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
      hasFile,
      hasError: !!this.lastError,
      lastError: this.lastError?.message,
      captureDisabled: this.captureDisabled,
      creationIdentity: this.creationIdentity,
    };
  }

}

function startFlight(options: AircraftSpecificRecorderOptions = {}): AircraftSpecificJsonlRecorder | null {
  if (activeFinalizationPromise || (activeRecorder && !activeRecorder.closed)) {
    console.warn('[aircraft-specific-jsonl] Recorder start refused while a recording is active or finalizing.');
    return null;
  }
  activeRecorder = null;
  const recorder = new AircraftSpecificJsonlRecorder({
    ...options,
    flightId: options.flightId || new Date().toISOString(),
  });
  if (!recorder.start()) return null;
  activeRecorder = recorder;
  return recorder;
}

function recordAircraftSpecificState(input: AircraftSpecificStateInput): boolean {
  if (!activeRecorder || activeRecorder.closed) return false;
  return activeRecorder.recordAircraftSpecificState(input);
}

async function endFlight(endContext: AnyRecord = {}): Promise<AircraftSpecificRecorderStats | null> {
  if (!activeRecorder) return activeFinalizationPromise ? await activeFinalizationPromise : null;
  const recorder = activeRecorder;
  activeRecorder = null;
  const closePromise = recorder.close(endContext).then((stats) => (stats.hasFile ? stats : null));
  const trackedFinalization = closePromise.finally(() => {
    if (activeFinalizationPromise === trackedFinalization) activeFinalizationPromise = null;
  });
  activeFinalizationPromise = trackedFinalization;
  return await trackedFinalization;
}

async function flush(): Promise<boolean> {
  if (!activeRecorder || activeRecorder.closed) return false;
  return await activeRecorder.flush();
}

function isRecording(): boolean {
  return activeRecorder !== null && !activeRecorder.closed;
}

function isFinalizing(): boolean {
  return activeFinalizationPromise !== null;
}

function getStats(): AircraftSpecificRecorderStats | null {
  return activeRecorder?.getStats() || null;
}

module.exports = {
  DEFAULT_CHECKPOINT_INTERVAL_MS,
  DEFAULT_SYNC_INTERVAL_MS,
  JSONL_STREAM_BACKLOG_MAX_BYTES,
  AircraftSpecificJsonlRecorder,
  buildSnapshot,
  startFlight,
  recordAircraftSpecificState,
  endFlight,
  flush,
  isRecording,
  isFinalizing,
  getStats,
};

export {};
