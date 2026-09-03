'use strict';

const fs = require('fs');
const { getArtifactPathForCsv } = require('./recording-bundle-layout') as {
  getArtifactPathForCsv: (_csvPath: unknown, _role: 'automation') => string | null;
};
const { streamUtf8Records } = require('../utils/bounded-utf8-record-reader') as {
  streamUtf8Records: (_options: {
    expectedStat: import('fs').BigIntStats;
    filePath: string;
    label: string;
    maxBytes: number;
    maxRecordChars: number;
    mode: 'line';
    onRecord: (_record: string, _metadata: { recordNumber: number; terminated: boolean }) => void;
  }) => Promise<{ fileSizeBytes: number; recordCount: number; sha256: string }>;
};
const { parseCsvLine, splitCsvLines } = require('../utils/csv') as {
  parseCsvLine: (_line: string, _options?: { trimValues?: boolean }) => string[];
  splitCsvLines: (_content: string, _options?: { trimAndDropEmpty?: boolean }) => string[];
};

type AnyRecord = Record<string, any>;

type AutomationReadResult = {
  filePath: string;
  exists: boolean;
  rows: AnyRecord[];
  lineCount: number;
  parseErrorCount: number;
  fileSizeBytes?: number;
  sha256?: string;
  recoveredTail?: boolean;
  error?: string;
};

const MAX_AUTOMATION_JSONL_BYTES = 200 * 1024 * 1024;
const MAX_AUTOMATION_JSONL_RECORD_CHARS = 2 * 1024 * 1024;
const MAX_AUTOMATION_RETAINED_BYTES = 64 * 1024 * 1024;
const MAX_AUTOMATION_ROWS = 150_000;
const MAX_TIMELINE_PARSE_MEMORY_GROWTH_BYTES = 384 * 1024 * 1024;
const MAX_TIMELINE_PARSE_PROCESS_BYTES = 768 * 1024 * 1024;
const AUTOMATION_SCHEMA_VERSIONS = new Set([1, 2]);
const INVALID_UTF8_ERROR_CODE = 'FF_INVALID_UTF8';
const AUTOMATION_ROW_TYPES = new Set([
  'automation_manifest',
  'automation_checkpoint',
  'automation_delta',
  'automation_event',
]);

function formatAutomationJsonlLimit(): string {
  return `${Math.ceil(MAX_AUTOMATION_JSONL_BYTES / (1024 * 1024))} MB`;
}

function getAutomationSidecarPathForCsv(csvPath: string): string {
  return getArtifactPathForCsv(csvPath, 'automation') || '';
}

function isRecord(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

type CsvRecordingIdentity = {
  flightId: string;
  flightStartIso: string;
  recordingSessionId: string | null;
  strictBundle: boolean;
};

type AutomationReadOptions = {
  csvIdentity?: CsvRecordingIdentity;
  maxRetainedBytes?: number;
  maxRows?: number;
};

async function readCsvRecordingIdentity(csvPath: string): Promise<CsvRecordingIdentity> {
  const handle = await fs.promises.open(csvPath, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = splitCsvLines(buffer.toString('utf8', 0, bytesRead), { trimAndDropEmpty: true });
    if (lines.length < 2) throw new Error('CSV has no data row for recording identity validation');
    const headers = parseCsvLine(lines[0], { trimValues: true });
    const values = parseCsvLine(lines[1], { trimValues: true });
    const value = (name: string): string => {
      const index = headers.indexOf(name);
      return index >= 0 ? String(values[index] || '').trim() : '';
    };
    const flightId = value('flight_id');
    const flightStartIso = value('flight_start_iso');
    const recordingSessionId = value('recording_session_id') || null;
    const firstRowIsManifest = value('record_type') === 'RECORDING_MANIFEST';
    const strictBundle = headers.includes('recording_session_id') || firstRowIsManifest;
    if (!flightId || !flightStartIso || !Number.isFinite(Date.parse(flightStartIso))) {
      throw new Error('CSV recording identity is missing or invalid');
    }
    if (strictBundle && !recordingSessionId) {
      throw new Error('Current CSV recording identity is missing recording_session_id');
    }
    if (strictBundle && !firstRowIsManifest) {
      throw new Error('Current CSV must begin with a RECORDING_MANIFEST row');
    }
    return { flightId, flightStartIso, recordingSessionId, strictBundle };
  } finally {
    await handle.close();
  }
}

type AutomationIntegrityState = {
  strictBundle: boolean;
  expectedSeq: number;
  schemaVersion: number | null;
  flightId: string | null;
  flightStartIso: string | null;
  recordingSessionId: string | null;
  hasRecordingSessionId: boolean | null;
  previousTimeMs: number | null;
  previousElapsedMs: number | null;
  bundleStatusRequired: boolean | null;
};

function validateAutomationRow(
  row: AnyRecord,
  state: AutomationIntegrityState,
): string | null {
  const firstRow = state.expectedSeq === 1;
  const declaredSchemaVersion = row.schemaVersion;
  if (firstRow) {
    if (!AUTOMATION_SCHEMA_VERSIONS.has(declaredSchemaVersion)) {
      return `unsupported schemaVersion ${String(declaredSchemaVersion)}`;
    }
  } else if (
    state.schemaVersion === 1
      ? declaredSchemaVersion !== 1
      : declaredSchemaVersion !== undefined && declaredSchemaVersion !== state.schemaVersion
  ) {
    return `schemaVersion changed inside the sidecar`;
  }
  const schemaVersion = state.schemaVersion ?? declaredSchemaVersion;
  const compactV2 = schemaVersion === 2;

  if (!Number.isSafeInteger(row.seq) || row.seq !== state.expectedSeq) {
    return `non-contiguous seq ${String(row.seq)}; expected ${state.expectedSeq}`;
  }
  if (!AUTOMATION_ROW_TYPES.has(row.type)) {
    return `unsupported row type ${String(row.type)}`;
  }

  const manifestRow = row.type === 'automation_manifest';

  const flightId = nonEmptyText(row.flightId);
  if ((!compactV2 || firstRow) && !flightId) return 'missing flightId';
  if (flightId && state.flightId !== null && flightId !== state.flightId) {
    return 'flightId changed inside the sidecar';
  }

  const flightStartIso = nonEmptyText(row.flightStartIso);
  const flightStartMs = flightStartIso ? Date.parse(flightStartIso) : Number.NaN;
  if ((!compactV2 || firstRow) && (!flightStartIso || !Number.isFinite(flightStartMs))) {
    return 'missing or invalid flightStartIso';
  }
  if (flightStartIso && state.flightStartIso !== null && flightStartIso !== state.flightStartIso) {
    return 'flightStartIso changed inside the sidecar';
  }
  const effectiveFlightStartIso = flightStartIso || state.flightStartIso;
  const effectiveFlightStartMs = effectiveFlightStartIso
    ? Date.parse(effectiveFlightStartIso)
    : Number.NaN;

  const hasRecordingSessionId = row.recordingSessionId !== undefined && row.recordingSessionId !== null;
  const recordingSessionId = hasRecordingSessionId ? nonEmptyText(row.recordingSessionId) : null;
  if (hasRecordingSessionId && !recordingSessionId) return 'invalid recordingSessionId';
  if (firstRow && manifestRow) {
    if (!recordingSessionId) return 'automation manifest is missing recordingSessionId';
    if (row.flightElapsedMs !== 0) return 'automation manifest must start at flightElapsedMs 0';
  } else if (!firstRow && manifestRow) {
    return 'automation_manifest is only valid as the first row';
  }
  if (
    !compactV2
    && state.hasRecordingSessionId !== null
    && hasRecordingSessionId !== state.hasRecordingSessionId
  ) {
    return 'recordingSessionId presence changed inside the sidecar';
  }
  if (
    recordingSessionId
    && state.recordingSessionId !== null
    && recordingSessionId !== state.recordingSessionId
  ) {
    return 'recordingSessionId changed inside the sidecar';
  }
  const bundleStatusRequired = row.bundleStatusRequired === undefined
    ? (compactV2 && !firstRow ? state.bundleStatusRequired : false)
    : (typeof row.bundleStatusRequired === 'boolean' ? row.bundleStatusRequired : null);
  if (bundleStatusRequired === null) return 'bundleStatusRequired is invalid';
  if (state.bundleStatusRequired !== null && bundleStatusRequired !== state.bundleStatusRequired) {
    return 'bundleStatusRequired changed inside the sidecar';
  }
  const timeMs = row.timeMs;
  if (typeof timeMs !== 'number' || !Number.isSafeInteger(timeMs)) return 'missing or invalid timeMs';
  const timestampIso = nonEmptyText(row.timestampIso);
  const timestampMs = timestampIso ? Date.parse(timestampIso) : Number.NaN;
  if ((!compactV2 || firstRow) && (!timestampIso || !Number.isFinite(timestampMs))) {
    return 'missing or invalid timestampIso';
  }
  if (timestampIso && timestampMs !== timeMs) return 'timestampIso does not match timeMs';
  if (timeMs < effectiveFlightStartMs) return 'timeMs precedes flightStartIso';
  if (state.previousTimeMs !== null && timeMs < state.previousTimeMs) return 'timeMs moved backwards';

  const elapsedMs = row.flightElapsedMs;
  if (
    (!compactV2 || firstRow)
    && state.strictBundle
    && (typeof elapsedMs !== 'number' || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0)
  ) {
    return 'missing or invalid flightElapsedMs';
  }
  if (
    (!compactV2 || firstRow)
    && !state.strictBundle
    && elapsedMs != null
    && (typeof elapsedMs !== 'number' || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0)
  ) {
    return 'missing or invalid flightElapsedMs';
  }
  if (
    elapsedMs != null
    && (typeof elapsedMs !== 'number' || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0)
  ) {
    return 'missing or invalid flightElapsedMs';
  }
  if (typeof elapsedMs === 'number' && elapsedMs !== timeMs - effectiveFlightStartMs) {
    return 'flightElapsedMs does not match the flight start clock';
  }
  if (typeof elapsedMs === 'number' && state.previousElapsedMs !== null && elapsedMs < state.previousElapsedMs) {
    return 'flightElapsedMs moved backwards';
  }

  state.expectedSeq += 1;
  state.schemaVersion = state.schemaVersion ?? schemaVersion;
  state.flightId = state.flightId ?? flightId;
  state.flightStartIso = state.flightStartIso ?? flightStartIso;
  state.hasRecordingSessionId = state.hasRecordingSessionId ?? hasRecordingSessionId;
  state.recordingSessionId = state.recordingSessionId ?? recordingSessionId;
  state.bundleStatusRequired = state.bundleStatusRequired ?? bundleStatusRequired;
  state.previousTimeMs = timeMs;
  if (typeof elapsedMs === 'number') state.previousElapsedMs = elapsedMs;
  return null;
}

async function readAutomationRowsForCsv(
  csvPath: string,
  options: AutomationReadOptions = {},
): Promise<AutomationReadResult> {
  const filePath = getAutomationSidecarPathForCsv(csvPath);
  const empty: AutomationReadResult = {
    filePath,
    exists: false,
    rows: [],
    lineCount: 0,
    parseErrorCount: 0,
  };

  if (!filePath || filePath === csvPath) return empty;

  let sidecarExists = false;
  try {
    let pathStat: import('fs').BigIntStats;
    try {
      pathStat = await fs.promises.lstat(filePath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return empty;
      return {
        ...empty,
        exists: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    sidecarExists = true;
    const existing = { ...empty, exists: true };
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      return {
        ...existing,
        error: 'Automation sidecar is not a regular file.',
      };
    }
    if (pathStat.size > BigInt(MAX_AUTOMATION_JSONL_BYTES)) {
      return {
        ...existing,
        error: `Automation sidecar is too large to open in Timeline. Limit is ${formatAutomationJsonlLimit()}.`,
      };
    }

    const csvIdentity = options.csvIdentity || await readCsvRecordingIdentity(csvPath);
    const strictBundle = csvIdentity.strictBundle;
    const rows: AnyRecord[] = [];
    const maxRetainedBytes = Math.min(
      MAX_AUTOMATION_RETAINED_BYTES,
      Number.isFinite(options.maxRetainedBytes)
        ? Math.max(0, Number(options.maxRetainedBytes))
        : MAX_AUTOMATION_RETAINED_BYTES,
    );
    const maxRows = Math.min(
      MAX_AUTOMATION_ROWS,
      Number.isSafeInteger(options.maxRows)
        ? Math.max(0, Number(options.maxRows))
        : MAX_AUTOMATION_ROWS,
    );
    let parseErrorCount = 0;
    let recoveredTail = false;
    let lineCount = 0;
    let retainedBytes = 0;
    let firstCommittedRow: AnyRecord | null = null;
    const parseStartMemory = process.memoryUsage();
    const parseStartBytes = parseStartMemory.heapUsed + parseStartMemory.external;
    const integrityState: AutomationIntegrityState = {
      strictBundle,
      expectedSeq: 1,
      schemaVersion: null,
      flightId: null,
      flightStartIso: null,
      recordingSessionId: null,
      hasRecordingSessionId: null,
      previousTimeMs: null,
      previousElapsedMs: null,
      bundleStatusRequired: null,
    };

    const fail = (error: string): never => {
      const failure = new Error(error) as Error & { automationResult?: AutomationReadResult };
      failure.automationResult = {
        ...existing,
        lineCount,
        parseErrorCount,
        error,
      };
      throw failure;
    };

    const assertMemoryBudget = () => {
      const memory = process.memoryUsage();
      const currentBytes = memory.heapUsed + memory.external;
      if (
        currentBytes > MAX_TIMELINE_PARSE_PROCESS_BYTES
        || currentBytes - parseStartBytes > MAX_TIMELINE_PARSE_MEMORY_GROWTH_BYTES
      ) {
        fail(
          'Automation sidecar expands beyond Timeline\'s safe memory budget. Archive or inspect this recording outside Flight Fabric.',
        );
      }
    };

    const streamed = await streamUtf8Records({
      expectedStat: pathStat,
      filePath,
      label: 'Automation sidecar',
      maxBytes: MAX_AUTOMATION_JSONL_BYTES,
      maxRecordChars: MAX_AUTOMATION_JSONL_RECORD_CHARS,
      mode: 'line',
      onRecord(record, metadata) {
        const line = record.trim();
        if (!line) {
          if (strictBundle) {
            fail(`Automation sidecar contains a blank row at line ${metadata.recordNumber}.`);
          }
          return;
        }
        lineCount += 1;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          parseErrorCount += 1;
          if (!metadata.terminated) {
            recoveredTail = true;
            return;
          }
          fail(`Automation sidecar contains malformed JSON at line ${metadata.recordNumber}.`);
        }

        // JSONL newline is the commit delimiter. A process crash can leave a
        // syntactically complete-looking prefix at EOF, so never expose it.
        if (!metadata.terminated) {
          recoveredTail = true;
          return;
        }
        if (!isRecord(parsed)) {
          fail(`Automation sidecar contains a non-object row at line ${metadata.recordNumber}.`);
        }

        const integrityError = validateAutomationRow(parsed, integrityState);
        if (integrityError) {
          fail(`Automation sidecar integrity error at line ${metadata.recordNumber}: ${integrityError}.`);
        }
        firstCommittedRow = firstCommittedRow || parsed;

        const rowBytes = Buffer.byteLength(line, 'utf8');
        if (rows.length >= maxRows || retainedBytes + rowBytes > maxRetainedBytes) {
          fail(
            'Automation sidecar exceeds Timeline\'s safe retained-data limit. Archive or inspect this recording outside Flight Fabric.',
          );
        }
        retainedBytes += rowBytes;
        rows.push(parsed);
        if ((rows.length & 127) === 0) assertMemoryBudget();
      },
    });
    assertMemoryBudget();

    if (strictBundle && firstCommittedRow?.type !== 'automation_manifest') {
      return {
        ...existing,
        lineCount,
        parseErrorCount,
        error: 'New automation sidecar must begin with an automation_manifest row.',
      };
    }
    if (rows.length > 0) {
      if (
        integrityState.flightId !== csvIdentity.flightId
        || integrityState.flightStartIso !== csvIdentity.flightStartIso
        || (
          strictBundle
          && integrityState.recordingSessionId !== csvIdentity.recordingSessionId
        )
      ) {
        return {
          ...existing,
          lineCount,
          parseErrorCount,
          error: 'Automation sidecar recording identity does not match the CSV.',
        };
      }
    }

    return {
      filePath,
      exists: true,
      rows,
      lineCount,
      parseErrorCount,
      fileSizeBytes: streamed.fileSizeBytes,
      sha256: streamed.sha256,
      ...(recoveredTail ? { recoveredTail: true } : {}),
    };
  } catch (err) {
    const validationResult = (err as Error & { automationResult?: AutomationReadResult })?.automationResult;
    if (validationResult) return validationResult;
    return {
      ...empty,
      exists: sidecarExists,
      error: (err as NodeJS.ErrnoException)?.code === INVALID_UTF8_ERROR_CODE
        ? 'Automation sidecar contains invalid UTF-8.'
        : (err as NodeJS.ErrnoException)?.code === 'FF_FILE_TOO_LARGE'
          ? `Automation sidecar is too large to open in Timeline. Limit is ${formatAutomationJsonlLimit()}.`
        : (err as NodeJS.ErrnoException)?.code === 'FF_FILE_CHANGED_ON_OPEN'
          ? 'Automation sidecar changed while it was being opened.'
          : (err as NodeJS.ErrnoException)?.code === 'FF_FILE_CHANGED_DURING_READ'
            ? 'Automation sidecar changed while it was being read.'
            : (err as NodeJS.ErrnoException)?.code === 'FF_RECORD_TOO_LARGE'
              ? 'Automation sidecar contains a row larger than Timeline\'s safe processing limit.'
        : (err instanceof Error ? err.message : String(err)),
    };
  }
}

module.exports = {
  readAutomationRowsForCsv,
};

export {};
