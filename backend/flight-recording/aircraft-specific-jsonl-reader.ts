'use strict';

const fs = require('fs') as typeof import('fs');
const { getArtifactPathForCsv } = require('./recording-bundle-layout') as {
  getArtifactPathForCsv: (_csvPath: unknown, _role: 'aircraftSpecific') => string | null;
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

type AircraftSpecificReadResult = {
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

type CsvRecordingIdentity = {
  flightId: string;
  flightStartIso: string;
  recordingSessionId: string | null;
  strictBundle: boolean;
};

type AircraftSpecificIntegrityState = {
  expectedSeq: number;
  schemaVersion: number | null;
  flightId: string | null;
  flightStartIso: string | null;
  recordingSessionId: string | null;
  hasRecordingSessionId: boolean | null;
  previousTimeMs: number | null;
  previousElapsedMs: number | null;
  bundleStatusRequired: boolean | null;
  activeConfigId: number | null;
  pendingConfigId: number | null;
  lastConfigId: number;
};

const MAX_AIRCRAFT_SPECIFIC_JSONL_BYTES = 200 * 1024 * 1024;
const MAX_AIRCRAFT_SPECIFIC_JSONL_RECORD_CHARS = 2 * 1024 * 1024;
const MAX_AIRCRAFT_SPECIFIC_RETAINED_BYTES = 64 * 1024 * 1024;
const MAX_AIRCRAFT_SPECIFIC_ROWS = 150_000;
const AIRCRAFT_SPECIFIC_SCHEMA_VERSIONS = new Set([1, 2]);
const INVALID_UTF8_ERROR_CODE = 'FF_INVALID_UTF8';
const SAFE_FIELD_ID_RE = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;
const FIELD_VALUE_TYPES = new Set(['boolean', 'enum', 'number']);
const AIRCRAFT_SPECIFIC_ROW_TYPES = new Set([
  'aircraft_specific_manifest',
  'aircraft_specific_config',
  'aircraft_specific_checkpoint',
  'aircraft_specific_delta',
]);

function getAircraftSpecificSidecarPathForCsv(csvPath: string): string {
  return getArtifactPathForCsv(csvPath, 'aircraftSpecific') || '';
}

function formatAircraftSpecificJsonlLimit(): string {
  return `${Math.ceil(MAX_AIRCRAFT_SPECIFIC_JSONL_BYTES / (1024 * 1024))} MB`;
}

function isRecord(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

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

type AircraftSpecificReadOptions = {
  csvIdentity?: CsvRecordingIdentity;
  maxRetainedBytes?: number;
  retainRows?: number;
};

function validateAircraftSpecificRow(
  row: AnyRecord,
  state: AircraftSpecificIntegrityState,
): string | null {
  if (!AIRCRAFT_SPECIFIC_SCHEMA_VERSIONS.has(row.schemaVersion)) {
    return `unsupported schemaVersion ${String(row.schemaVersion)}`;
  }
  if (state.schemaVersion !== null && row.schemaVersion !== state.schemaVersion) {
    return 'schemaVersion changed inside the sidecar';
  }
  if (!Number.isSafeInteger(row.seq) || row.seq !== state.expectedSeq) {
    return `non-contiguous seq ${String(row.seq)}; expected ${state.expectedSeq}`;
  }
  if (!AIRCRAFT_SPECIFIC_ROW_TYPES.has(row.type)) {
    return `unsupported row type ${String(row.type)}`;
  }
  if (row.schemaVersion === 2) return validateCompactAircraftSpecificRow(row, state);

  const firstRow = state.expectedSeq === 1;
  const manifestRow = row.type === 'aircraft_specific_manifest';

  const flightId = nonEmptyText(row.flightId);
  if (!flightId) return 'missing flightId';
  if (state.flightId !== null && flightId !== state.flightId) return 'flightId changed inside the sidecar';

  const flightStartIso = nonEmptyText(row.flightStartIso);
  const flightStartMs = flightStartIso ? Date.parse(flightStartIso) : Number.NaN;
  if (!flightStartIso || !Number.isFinite(flightStartMs)) return 'missing or invalid flightStartIso';
  if (state.flightStartIso !== null && flightStartIso !== state.flightStartIso) {
    return 'flightStartIso changed inside the sidecar';
  }

  const hasRecordingSessionId = row.recordingSessionId !== undefined && row.recordingSessionId !== null;
  const recordingSessionId = hasRecordingSessionId ? nonEmptyText(row.recordingSessionId) : null;
  if (hasRecordingSessionId && !recordingSessionId) return 'invalid recordingSessionId';
  if (firstRow && manifestRow) {
    if (!recordingSessionId) return 'aircraft-specific manifest is missing recordingSessionId';
    if (row.flightElapsedMs !== 0) return 'aircraft-specific manifest must start at flightElapsedMs 0';
  } else if (!firstRow && manifestRow) {
    return 'aircraft_specific_manifest is only valid as the first row';
  }
  if (state.hasRecordingSessionId !== null && hasRecordingSessionId !== state.hasRecordingSessionId) {
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
    ? false
    : (typeof row.bundleStatusRequired === 'boolean' ? row.bundleStatusRequired : null);
  if (bundleStatusRequired === null) return 'bundleStatusRequired is invalid';
  if (state.bundleStatusRequired !== null && bundleStatusRequired !== state.bundleStatusRequired) {
    return 'bundleStatusRequired changed inside the sidecar';
  }

  const timeMs = row.timeMs;
  if (typeof timeMs !== 'number' || !Number.isSafeInteger(timeMs)) return 'missing or invalid timeMs';
  const timestampIso = nonEmptyText(row.timestampIso);
  const timestampMs = timestampIso ? Date.parse(timestampIso) : Number.NaN;
  if (!timestampIso || !Number.isFinite(timestampMs)) return 'missing or invalid timestampIso';
  if (timestampMs !== timeMs) return 'timestampIso does not match timeMs';
  if (timeMs < flightStartMs) return 'timeMs precedes flightStartIso';
  if (state.previousTimeMs !== null && timeMs < state.previousTimeMs) return 'timeMs moved backwards';

  const elapsedMs = row.flightElapsedMs;
  if (typeof elapsedMs !== 'number' || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
    return 'missing or invalid flightElapsedMs';
  }
  if (elapsedMs !== timeMs - flightStartMs) {
    return 'flightElapsedMs does not match the flight start clock';
  }
  if (state.previousElapsedMs !== null && elapsedMs < state.previousElapsedMs) {
    return 'flightElapsedMs moved backwards';
  }

  state.expectedSeq += 1;
  state.schemaVersion = state.schemaVersion ?? 1;
  state.flightId = state.flightId ?? flightId;
  state.flightStartIso = state.flightStartIso ?? flightStartIso;
  state.hasRecordingSessionId = state.hasRecordingSessionId ?? hasRecordingSessionId;
  state.recordingSessionId = state.recordingSessionId ?? recordingSessionId;
  state.bundleStatusRequired = state.bundleStatusRequired ?? bundleStatusRequired;
  state.previousTimeMs = timeMs;
  state.previousElapsedMs = elapsedMs;
  return null;
}

function validateCompactAircraftSpecificRow(
  row: AnyRecord,
  state: AircraftSpecificIntegrityState,
): string | null {
  const firstRow = state.expectedSeq === 1;
  const manifestRow = row.type === 'aircraft_specific_manifest';
  if (firstRow && !manifestRow) return 'schemaVersion 2 must begin with an aircraft_specific_manifest';
  if (!firstRow && manifestRow) return 'aircraft_specific_manifest is only valid as the first row';

  const elapsedMs = row.flightElapsedMs;
  if (typeof elapsedMs !== 'number' || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
    return 'missing or invalid flightElapsedMs';
  }
  if (state.previousElapsedMs !== null && elapsedMs < state.previousElapsedMs) {
    return 'flightElapsedMs moved backwards';
  }

  if (manifestRow) {
    if (elapsedMs !== 0) return 'aircraft-specific manifest must start at flightElapsedMs 0';
    const flightId = nonEmptyText(row.flightId);
    if (!flightId) return 'missing flightId';
    const recordingSessionId = nonEmptyText(row.recordingSessionId);
    if (!recordingSessionId) return 'aircraft-specific manifest is missing recordingSessionId';
    const flightStartIso = nonEmptyText(row.flightStartIso);
    const flightStartMs = flightStartIso ? Date.parse(flightStartIso) : Number.NaN;
    if (!flightStartIso || !Number.isFinite(flightStartMs)) return 'missing or invalid flightStartIso';
    if (row.timeMs !== flightStartMs) return 'manifest timeMs does not match flightStartIso';
    const timestampIso = nonEmptyText(row.timestampIso);
    if (!timestampIso || Date.parse(timestampIso) !== flightStartMs) {
      return 'manifest timestampIso does not match flightStartIso';
    }
    if (typeof row.bundleStatusRequired !== 'boolean') return 'bundleStatusRequired is invalid';
    state.flightId = flightId;
    state.flightStartIso = flightStartIso;
    state.recordingSessionId = recordingSessionId;
    state.hasRecordingSessionId = true;
    state.bundleStatusRequired = row.bundleStatusRequired;
    state.previousTimeMs = flightStartMs;
  } else {
    const configId = row.configId;
    if (!Number.isSafeInteger(configId) || configId < 1) return 'missing or invalid configId';

    if (row.type === 'aircraft_specific_config') {
      if (state.pendingConfigId !== null) return 'config row replaced an uncommitted config';
      if (configId !== state.lastConfigId + 1) {
        return `non-contiguous configId ${String(configId)}; expected ${state.lastConfigId + 1}`;
      }
      if (!nonEmptyText(row.profileKey)) return 'config row is missing profileKey';
      if (
        row.profileRevision !== null
        && (!Number.isSafeInteger(row.profileRevision) || row.profileRevision < 0)
      ) return 'config row has an invalid profileRevision';
      if (!isRecord(row.fieldTypes)) return 'config row is missing fieldTypes';
      const fields = Object.entries(row.fieldTypes);
      if (fields.length === 0 || fields.length > 128) return 'config row has an invalid fieldTypes size';
      for (const [fieldId, valueType] of fields) {
        if (
          fieldId.length > 128
          || !SAFE_FIELD_ID_RE.test(fieldId)
          || typeof valueType !== 'string'
          || !FIELD_VALUE_TYPES.has(valueType)
        ) return 'config row has an invalid fieldTypes entry';
      }
      state.pendingConfigId = configId;
      state.lastConfigId = configId;
    } else if (row.type === 'aircraft_specific_checkpoint') {
      if (state.pendingConfigId !== null) {
        if (configId !== state.pendingConfigId) return 'checkpoint does not commit the pending config';
        state.activeConfigId = configId;
        state.pendingConfigId = null;
      } else if (configId !== state.activeConfigId) {
        return 'checkpoint does not reference the active config';
      }
    } else if (configId !== state.activeConfigId) {
      return 'delta does not reference the active config';
    }
  }

  state.expectedSeq += 1;
  state.schemaVersion = state.schemaVersion ?? 2;
  state.previousElapsedMs = elapsedMs;
  return null;
}

async function readAircraftSpecificRowsForCsv(
  csvPath: string,
  options: AircraftSpecificReadOptions = {},
): Promise<AircraftSpecificReadResult> {
  const filePath = getAircraftSpecificSidecarPathForCsv(csvPath);
  const empty: AircraftSpecificReadResult = {
    filePath,
    exists: false,
    rows: [],
    lineCount: 0,
    parseErrorCount: 0,
  };

  if (!filePath || filePath === csvPath) return empty;
  let pathObserved = false;

  try {
    let pathStat: import('fs').BigIntStats;
    try {
      pathStat = await fs.promises.lstat(filePath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return empty;
      throw error;
    }
    pathObserved = true;
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      return { ...empty, exists: true, error: 'Aircraft-specific sidecar is not a regular file.' };
    }
    if (pathStat.size > BigInt(MAX_AIRCRAFT_SPECIFIC_JSONL_BYTES)) {
      return {
        ...empty,
        exists: true,
        error: `Aircraft-specific sidecar is too large to open in Timeline. Limit is ${formatAircraftSpecificJsonlLimit()}.`,
      };
    }

    const csvIdentity = options.csvIdentity || await readCsvRecordingIdentity(csvPath);
    const strictBundle = csvIdentity.strictBundle;
    const rows: AnyRecord[] = [];
    const retainRows = Number.isSafeInteger(options.retainRows)
      ? Math.max(0, Number(options.retainRows))
      : Number.POSITIVE_INFINITY;
    const maxRetainedBytes = Math.min(
      MAX_AIRCRAFT_SPECIFIC_RETAINED_BYTES,
      Number.isFinite(options.maxRetainedBytes)
        ? Math.max(0, Number(options.maxRetainedBytes))
        : MAX_AIRCRAFT_SPECIFIC_RETAINED_BYTES,
    );
    let parseErrorCount = 0;
    let recoveredTail = false;
    let lineCount = 0;
    let retainedBytes = 0;
    let firstCommittedRow: AnyRecord | null = null;
    const integrityState: AircraftSpecificIntegrityState = {
      expectedSeq: 1,
      schemaVersion: null,
      flightId: null,
      flightStartIso: null,
      recordingSessionId: null,
      hasRecordingSessionId: null,
      previousTimeMs: null,
      previousElapsedMs: null,
      bundleStatusRequired: null,
      activeConfigId: null,
      pendingConfigId: null,
      lastConfigId: 0,
    };

    const existing = { ...empty, exists: true };
    const fail = (error: string): never => {
      const failure = new Error(error) as Error & { aircraftSpecificResult?: AircraftSpecificReadResult };
      failure.aircraftSpecificResult = {
        ...existing,
        lineCount,
        parseErrorCount,
        error,
      };
      throw failure;
    };

    const streamed = await streamUtf8Records({
      expectedStat: pathStat,
      filePath,
      label: 'Aircraft-specific sidecar',
      maxBytes: MAX_AIRCRAFT_SPECIFIC_JSONL_BYTES,
      maxRecordChars: MAX_AIRCRAFT_SPECIFIC_JSONL_RECORD_CHARS,
      mode: 'line',
      onRecord(record, metadata) {
        const line = record.trim();
        if (!line) {
          if (strictBundle) {
            fail(`Aircraft-specific sidecar contains a blank row at line ${metadata.recordNumber}.`);
          }
          return;
        }
        lineCount += 1;
        if (lineCount > MAX_AIRCRAFT_SPECIFIC_ROWS) {
          fail(
            `Aircraft-specific sidecar contains more than ${MAX_AIRCRAFT_SPECIFIC_ROWS.toLocaleString('en-US')} rows, which exceeds Timeline's safe processing limit.`,
          );
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          parseErrorCount += 1;
          if (!metadata.terminated) {
            recoveredTail = true;
            return;
          }
          fail(`Aircraft-specific sidecar contains malformed JSON at line ${metadata.recordNumber}.`);
        }

        // The terminating newline is the append commit marker. A crash may
        // leave a syntactically valid-looking partial row, so do not expose it.
        if (!metadata.terminated) {
          recoveredTail = true;
          return;
        }
        if (!isRecord(parsed)) {
          fail(`Aircraft-specific sidecar contains a non-object row at line ${metadata.recordNumber}.`);
        }

        const integrityError = validateAircraftSpecificRow(parsed, integrityState);
        if (integrityError) {
          fail(`Aircraft-specific sidecar integrity error at line ${metadata.recordNumber}: ${integrityError}.`);
        }
        firstCommittedRow = firstCommittedRow || parsed;

        if (rows.length < retainRows) {
          const rowBytes = Buffer.byteLength(line, 'utf8');
          if (retainedBytes + rowBytes > maxRetainedBytes) {
            fail(
              'Aircraft-specific sidecar exceeds Timeline\'s safe retained-data limit. Archive or inspect this recording outside Flight Fabric.',
            );
          }
          retainedBytes += rowBytes;
          rows.push(parsed);
        }
      },
    });

    if (strictBundle && firstCommittedRow?.type !== 'aircraft_specific_manifest') {
      return {
        ...empty,
        exists: true,
        lineCount,
        parseErrorCount,
        error: 'Aircraft-specific sidecar has no committed identity manifest.',
      };
    }
    if (
      firstCommittedRow
      && (
        integrityState.flightId !== csvIdentity.flightId
        || integrityState.flightStartIso !== csvIdentity.flightStartIso
        || (
          strictBundle
          && integrityState.recordingSessionId !== csvIdentity.recordingSessionId
        )
      )
    ) {
      return {
        ...empty,
        exists: true,
        lineCount,
        parseErrorCount,
        error: 'Aircraft-specific sidecar recording identity does not match the CSV.',
      };
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
  } catch (error) {
    const validationResult = (
      error as Error & { aircraftSpecificResult?: AircraftSpecificReadResult }
    )?.aircraftSpecificResult;
    if (validationResult) return validationResult;
    return {
      ...empty,
      exists: pathObserved,
      error: (error as NodeJS.ErrnoException)?.code === INVALID_UTF8_ERROR_CODE
        ? 'Aircraft-specific sidecar contains invalid UTF-8.'
        : (error as NodeJS.ErrnoException)?.code === 'FF_FILE_TOO_LARGE'
          ? `Aircraft-specific sidecar is too large to open in Timeline. Limit is ${formatAircraftSpecificJsonlLimit()}.`
        : (error as NodeJS.ErrnoException)?.code === 'FF_FILE_CHANGED_ON_OPEN'
          ? 'Aircraft-specific sidecar changed while it was being opened.'
          : (error as NodeJS.ErrnoException)?.code === 'FF_FILE_CHANGED_DURING_READ'
            ? 'Aircraft-specific sidecar changed while it was being read.'
            : (error as NodeJS.ErrnoException)?.code === 'FF_RECORD_TOO_LARGE'
              ? 'Aircraft-specific sidecar contains a row larger than Timeline\'s safe processing limit.'
        : (error instanceof Error ? error.message : String(error)),
    };
  }
}

module.exports = {
  getAircraftSpecificSidecarPathForCsv,
  readAircraftSpecificRowsForCsv,
};

export {};
