'use strict';

const fs = require('fs');
const { getCsvRowWidthError, parseCsvLine } = require('../utils/csv');
const { streamUtf8Records } = require('../utils/bounded-utf8-record-reader') as {
  streamUtf8Records: (_options: {
    expectedStat: import('fs').BigIntStats;
    filePath: string;
    label: string;
    maxBytes: number;
    maxRecordChars: number;
    mode: 'csv';
    onRecord: (_record: string, _metadata: { recordNumber: number; terminated: boolean }) => void;
  }) => Promise<{ fileSizeBytes: number; recordCount: number; sha256: string }>;
};

type AnyRecord = Record<string, any>;
type CsvRow = Record<string, any>;
type ParseCsvResult = {
  headers: string[];
  rows: CsvRow[];
  fileSizeBytes?: number;
  sha256?: string;
  error?: string;
  recoveredTail?: boolean;
};
type ParseCsvOptions = {
  sparseRows?: boolean;
};
type CsvEnvelopeState = {
  strictBundle: boolean;
  expectedSampleIndex: number;
  previousElapsedMs: number | null;
  bundleStatusRequired: boolean | null;
};

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
const IMMUTABLE_RECORDING_COLUMNS = new Set([
  'flight_id',
  'flight_start_iso',
  'recording_session_id',
  'bundle_status_required',
]);
const MAX_TIMELINE_CSV_BYTES = 200 * 1024 * 1024;
const MAX_TIMELINE_CSV_RECORD_CHARS = 2 * 1024 * 1024;
const MAX_TIMELINE_CSV_ROWS = 150_000;
const MAX_TIMELINE_PARSE_MEMORY_GROWTH_BYTES = 384 * 1024 * 1024;
const MAX_TIMELINE_PARSE_PROCESS_BYTES = 768 * 1024 * 1024;
const INVALID_UTF8_ERROR_CODE = 'FF_INVALID_UTF8';
const CURRENT_CSV_SCHEMA_VERSION = 3;

function hasCompleteCsvQuotes(record: string): boolean {
  let inQuotes = false;
  for (let index = 0; index < record.length; index += 1) {
    if (record[index] !== '"') continue;
    if (inQuotes && record[index + 1] === '"') {
      index += 1;
      continue;
    }
    inQuotes = !inQuotes;
  }
  return !inQuotes;
}

function getStrictCsvDocumentSyntaxError(content: string, startingLogicalRow = 1): string | null {
  type FieldState = 'start' | 'unquoted' | 'quoted' | 'after_quote';
  let state: FieldState = 'start';
  let logicalRow = startingLogicalRow;
  let record = '';

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (state === 'quoted') {
      record += char;
      if (char === '"') {
        if (content[index + 1] === '"') {
          record += content[index + 1];
          index += 1;
        } else {
          state = 'after_quote';
        }
      }
      continue;
    }

    if (char === '\n' || char === '\r') {
      if (!record.trim()) return `CSV contains a blank logical row at row ${logicalRow}`;
      record = '';
      state = 'start';
      logicalRow += 1;
      if (char === '\r' && content[index + 1] === '\n') index += 1;
      continue;
    }

    record += char;
    if (state === 'start') {
      if (char === '"') state = 'quoted';
      else if (char !== ',') state = 'unquoted';
      continue;
    }
    if (state === 'unquoted') {
      if (char === '"') return `CSV row ${logicalRow} contains a quote inside an unquoted field`;
      if (char === ',') state = 'start';
      continue;
    }
    if (state === 'after_quote') {
      if (char === ',') {
        state = 'start';
        continue;
      }
      return `CSV row ${logicalRow} contains characters after a closing quote`;
    }
  }

  // An open quote at EOF is handled by the crash-tail path below. It is not a
  // committed malformed interior record unless another logical row follows.
  return null;
}

function formatCsvSize(bytes: unknown): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return 'unknown size';
  return `${Math.ceil(value / (1024 * 1024))} MB`;
}

function formatTimelineCsvLimit(): string {
  return formatCsvSize(MAX_TIMELINE_CSV_BYTES);
}

function parseValue(str: unknown) {
  if (str === '' || str === undefined) return null;
  if (str === 'true') return true;
  if (str === 'false') return false;

  const num = Number(str);
  if (!isNaN(num) && str !== '') return num;

  return str;
}

function mapCsvRow(
  headers: string[],
  values: unknown[],
  options: ParseCsvOptions = {},
): CsvRow {
  const row: CsvRow = {};
  for (let index = 0; index < headers.length && index < values.length; index++) {
    const value = parseValue(values[index]);
    if (options.sparseRows === true && value === null) continue;
    row[headers[index]] = value;
  }
  return row;
}

function hydrateCompactRepeatedColumns(
  row: CsvRow,
  defaults: CsvRow,
  enforceImmutableRecordingEnvelope: boolean,
): string | null {
  for (const column of COMPACT_REPEAT_COLUMNS) {
    const value = row[column];
    if (value !== null && value !== undefined && value !== '') {
      if (defaults[column] === undefined || defaults[column] === null || defaults[column] === '') {
        defaults[column] = value;
      } else if (
        enforceImmutableRecordingEnvelope
        && IMMUTABLE_RECORDING_COLUMNS.has(column)
        && value !== defaults[column]
      ) {
        return `${column} changed inside the CSV`;
      }
      continue;
    }

    if (defaults[column] !== undefined && defaults[column] !== null && defaults[column] !== '') {
      row[column] = defaults[column];
    }
  }
  return null;
}

function validateCsvEnvelope(row: CsvRow, state: CsvEnvelopeState): string | null {
  if (!state.strictBundle) return null;

  const firstRow = state.expectedSampleIndex === 0;
  if (firstRow && row.record_type !== 'RECORDING_MANIFEST') {
    return 'new recording must begin with a RECORDING_MANIFEST row';
  }
  if (!firstRow && row.record_type === 'RECORDING_MANIFEST') {
    return 'RECORDING_MANIFEST is only valid as the first row';
  }
  if (
    typeof row.schema_version !== 'number'
    || !Number.isSafeInteger(row.schema_version)
    || row.schema_version !== CURRENT_CSV_SCHEMA_VERSION
  ) {
    return `schema_version must be ${CURRENT_CSV_SCHEMA_VERSION}`;
  }

  const recordingSessionId = row.recording_session_id;
  if (typeof recordingSessionId !== 'string' || !recordingSessionId.trim()) {
    return 'recording_session_id is missing or invalid';
  }
  if (typeof row.flight_id !== 'string' || !row.flight_id.trim()) {
    return 'flight_id is missing or invalid';
  }
  if (typeof row.flight_start_iso !== 'string' || !Number.isFinite(Date.parse(row.flight_start_iso))) {
    return 'flight_start_iso is missing or invalid';
  }

  const rawStatusRequired = row.bundle_status_required;
  const bundleStatusRequired = rawStatusRequired === true || rawStatusRequired === 1 || rawStatusRequired === '1'
    ? true
    : (rawStatusRequired === false || rawStatusRequired === 0 || rawStatusRequired === '0' || rawStatusRequired == null || rawStatusRequired === '')
      ? false
      : null;
  if (bundleStatusRequired === null) return 'bundle_status_required is invalid';
  if (state.bundleStatusRequired !== null && bundleStatusRequired !== state.bundleStatusRequired) {
    return 'bundle_status_required changed inside the CSV';
  }

  const sampleIndex = row.sample_index;
  if (typeof sampleIndex !== 'number' || !Number.isSafeInteger(sampleIndex) || sampleIndex !== state.expectedSampleIndex) {
    return `non-contiguous sample_index ${String(row.sample_index)}; expected ${state.expectedSampleIndex}`;
  }

  const elapsedMs = row.flight_elapsed_ms;
  if (typeof elapsedMs !== 'number' || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
    return 'flight_elapsed_ms is missing or invalid';
  }
  if (firstRow && elapsedMs !== 0) {
    return 'RECORDING_MANIFEST must start at flight_elapsed_ms 0';
  }
  if (state.previousElapsedMs !== null && elapsedMs < state.previousElapsedMs) {
    return 'flight_elapsed_ms moved backwards';
  }

  const monotonicMs = row.timestamp_monotonic;
  if (typeof monotonicMs !== 'number' || !Number.isSafeInteger(monotonicMs) || monotonicMs !== elapsedMs) {
    return 'timestamp_monotonic does not match flight_elapsed_ms';
  }

  const timestampMs = row.ts;
  const expectedTimestampMs = Date.parse(row.flight_start_iso) + elapsedMs;
  if (typeof timestampMs !== 'number' || !Number.isSafeInteger(timestampMs) || timestampMs !== expectedTimestampMs) {
    return 'ts does not match the immutable flight start clock';
  }
  if (
    typeof row.timestamp_utc !== 'string'
    || !Number.isFinite(Date.parse(row.timestamp_utc))
    || Date.parse(row.timestamp_utc) !== timestampMs
  ) {
    return 'timestamp_utc does not match ts';
  }

  state.expectedSampleIndex += 1;
  state.previousElapsedMs = elapsedMs;
  state.bundleStatusRequired = state.bundleStatusRequired ?? bundleStatusRequired;
  return null;
}

async function parseCSV(filePath: string, options: ParseCsvOptions = {}): Promise<ParseCsvResult> {
  let headers: string[] = [];
  const rows: CsvRow[] = [];
  const parseStartMemory = process.memoryUsage();
  const parseStartBytes = parseStartMemory.heapUsed + parseStartMemory.external;

  const fail = (error: string): never => {
    const failure = new Error(error) as Error & { csvResult?: ParseCsvResult };
    failure.csvResult = { headers, rows: [], error };
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
        'CSV expands beyond Timeline\'s safe memory budget. Archive or inspect this recording outside Flight Fabric.',
      );
    }
  };

  try {
    const pathStat = await fs.promises.lstat(filePath, { bigint: true });
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      return { headers: [], rows: [], error: 'CSV is not a regular file' };
    }
    if (pathStat.size > BigInt(MAX_TIMELINE_CSV_BYTES)) {
      return {
        headers: [],
        rows: [],
        error: `CSV is too large to open in Timeline (${formatCsvSize(Number(pathStat.size))}; limit is ${formatTimelineCsvLimit()}). Delete, archive, or inspect it outside Flight Fabric.`,
      };
    }

    const compactDefaults: CsvRow = {};
    const envelopeState: CsvEnvelopeState = {
      strictBundle: false,
      expectedSampleIndex: 0,
      previousElapsedMs: null,
      bundleStatusRequired: null,
    };
    let headerRecord = '';
    let pendingBlankRow: number | null = null;
    let strictBundle: boolean | null = null;
    let recoveredTail = false;

    const streamed = await streamUtf8Records({
      expectedStat: pathStat,
      filePath,
      label: 'CSV',
      maxBytes: MAX_TIMELINE_CSV_BYTES,
      maxRecordChars: MAX_TIMELINE_CSV_RECORD_CHARS,
      mode: 'csv',
      onRecord(record, metadata) {
        if (!record.trim()) {
          if (strictBundle !== false) {
            if (strictBundle === true) {
              fail(`CSV contains a blank logical row at row ${metadata.recordNumber}`);
            }
            pendingBlankRow = pendingBlankRow ?? metadata.recordNumber;
          }
          return;
        }

        if (headers.length === 0) {
          headerRecord = record;
          headers = parseCsvLine(record, { trimValues: true });
          const duplicateHeader = headers.find((header, index) => headers.indexOf(header) !== index);
          if (duplicateHeader !== undefined) {
            fail(`CSV header contains duplicate column ${duplicateHeader || '(empty)'}`);
          }
          strictBundle = headers.includes('recording_session_id') ? true : null;
          envelopeState.strictBundle = strictBundle === true;
          if (strictBundle) {
            if (pendingBlankRow !== null) {
              fail(`CSV contains a blank logical row at row ${pendingBlankRow}`);
            }
            const syntaxError = getStrictCsvDocumentSyntaxError(headerRecord, metadata.recordNumber);
            if (syntaxError) fail(syntaxError);
          }
          return;
        }

        const values = parseCsvLine(record, { trimValues: true });
        const row = mapCsvRow(headers, values, options);
        if (strictBundle === null) {
          strictBundle = row.record_type === 'RECORDING_MANIFEST';
          envelopeState.strictBundle = strictBundle;
          if (strictBundle) {
            const headerSyntaxError = getStrictCsvDocumentSyntaxError(headerRecord, 1);
            if (headerSyntaxError) fail(headerSyntaxError);
            if (pendingBlankRow !== null) {
              fail(`CSV contains a blank logical row at row ${pendingBlankRow}`);
            }
          }
        }

        const widthError = getCsvRowWidthError(headers, values, metadata.recordNumber);
        const quotesComplete = hasCompleteCsvQuotes(record);
        const isRecoverableTail = !metadata.terminated
          && (strictBundle === true || Boolean(widthError) || !quotesComplete);
        if (isRecoverableTail) {
          recoveredTail = true;
          return;
        }
        if (strictBundle) {
          const syntaxError = getStrictCsvDocumentSyntaxError(record, metadata.recordNumber);
          if (syntaxError) fail(syntaxError);
        }
        if (widthError || !quotesComplete) {
          fail(widthError || `CSV row ${metadata.recordNumber} has an unterminated quoted field`);
        }
        if (rows.length >= MAX_TIMELINE_CSV_ROWS) {
          fail(
            `CSV contains more than ${MAX_TIMELINE_CSV_ROWS.toLocaleString('en-US')} rows, which exceeds Timeline's safe processing limit.`,
          );
        }

        const immutableError = hydrateCompactRepeatedColumns(row, compactDefaults, Boolean(strictBundle));
        if (immutableError) {
          fail(`CSV integrity error at row ${metadata.recordNumber}: ${immutableError}`);
        }
        const envelopeError = validateCsvEnvelope(row, envelopeState);
        if (envelopeError) {
          fail(`CSV integrity error at row ${metadata.recordNumber}: ${envelopeError}`);
        }
        rows.push(row);
        if ((rows.length & 127) === 0) assertMemoryBudget();
      },
    });

    if (headers.length < 1) {
      return { headers: [], rows: [], error: 'CSV has no header row' };
    }
    if (rows.length < 1 && !recoveredTail) {
      return { headers, rows: [], error: 'CSV has no data rows' };
    }
    assertMemoryBudget();

    return recoveredTail
      ? {
        headers,
        rows,
        recoveredTail: true,
        fileSizeBytes: streamed.fileSizeBytes,
        sha256: streamed.sha256,
      }
      : {
        headers,
        rows,
        fileSizeBytes: streamed.fileSizeBytes,
        sha256: streamed.sha256,
      };
  } catch (err: any) {
    if (err?.csvResult) return err.csvResult;
    return {
      headers: [],
      rows: [],
      error: err?.code === INVALID_UTF8_ERROR_CODE
        ? 'CSV contains invalid UTF-8'
        : err?.code === 'FF_FILE_TOO_LARGE'
          ? `CSV is too large to open in Timeline (limit is ${formatTimelineCsvLimit()}). Delete, archive, or inspect it outside Flight Fabric.`
        : err?.code === 'FF_FILE_CHANGED_ON_OPEN'
          ? 'CSV changed while it was being opened'
          : err?.code === 'FF_FILE_CHANGED_DURING_READ'
            ? 'CSV changed while it was being read'
            : err?.code === 'FF_RECORD_TOO_LARGE'
              ? 'CSV contains a row larger than Timeline\'s safe processing limit'
        : (err?.code ? `CSV read failed: ${err.code}` : 'CSV read failed'),
    };
  }
}

function toFiniteNumber(value: unknown) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBooleanOrNull(value: unknown) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function coalesceKnown(primary: unknown, fallback: unknown) {
  return primary !== null && primary !== undefined && primary !== ''
    ? primary
    : fallback ?? null;
}

function parseJsonObject(value: unknown) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const TOUCHDOWN_DISTANCE_PRESERVE_KEYS = [
  'shortLanding',
  'runway_condition',
  'runway_condition_source',
  'runway_condition_confident',
  'lateralOffsetFt',
  'lateralOffsetSide',
  'lateralOffsetGrade',
  'lateralOffsetScore',
  'lateralOffsetSuspect',
  'runwayLengthFt',
  'runwayWidthFt',
  'runwaySurface',
  'runwayGeometrySource',
  'runwayHeadingTrueDeg',
  'runwayPhysicalLengthFt',
  'runwayThresholdLat',
  'runwayThresholdLon',
  'runwayPhysicalThresholdLat',
  'runwayPhysicalThresholdLon',
  'runwayDisplacedThresholdFt',
];

function mergeTouchdownDistance(existing: AnyRecord | null | undefined, incoming: AnyRecord | null | undefined) {
  if (!incoming) return existing || null;
  if (!existing) return incoming;

  const merged = { ...existing, ...incoming };
  for (const key of TOUCHDOWN_DISTANCE_PRESERVE_KEYS) {
    merged[key] = coalesceKnown(incoming[key], existing[key]);
  }
  return merged;
}

function extractFuelTotalGal(row: AnyRecord | null | undefined) {
  if (!row || typeof row !== 'object') return null;
  return toFiniteNumber(row.fuel_total_gal ?? row.fuelTotalGal ?? row.fuelTotal ?? row.fuel_total);
}

function extractFuelTotalWeightLbs(row: AnyRecord | null | undefined) {
  if (!row || typeof row !== 'object') return null;
  return toFiniteNumber(
    row.fuel_total_weight_lbs ??
    row.fuelTotalWeightLbs ??
    row.fuelTotalWeight ??
    row.fuel_weight_lbs
  );
}

function extractFuelWeightPerGal(row: AnyRecord | null | undefined) {
  if (!row || typeof row !== 'object') return null;
  const value = toFiniteNumber(
    row.fuel_weight_per_gal ??
    row.fuelWeightPerGal ??
    row.fuelWeightPerGallon
  );
  return value !== null && value > 0 && value < 25 ? value : null;
}

function hasFuelUsageAnchor(row: AnyRecord | null | undefined) {
  return (
    extractFuelTotalGal(row) !== null ||
    extractFuelTotalWeightLbs(row) !== null
  );
}

const MIN_WEIGHT_FUEL_BURN_LBS = 10;
const MAX_WEIGHT_FUEL_BURN_LBS = 1_000_000;
const MIN_RELIABLE_FUEL_BURN_GAL = 1;
const REFUEL_OR_RESET_INCREASE_GAL = 25;
const REFUEL_OR_RESET_INCREASE_LBS = 10;

function isRefuelOrResetIncrease(previousRow: AnyRecord | null | undefined, row: AnyRecord | null | undefined) {
  const previousFuelGal = extractFuelTotalGal(previousRow);
  const fuelGal = extractFuelTotalGal(row);
  if (Number.isFinite(previousFuelGal) && Number.isFinite(fuelGal)) {
    if (fuelGal - previousFuelGal > REFUEL_OR_RESET_INCREASE_GAL) return true;
  }

  // X-Plane supplies authoritative fuel mass but no trustworthy volume. A
  // material increase in total fuel mass is likewise a refuel/reset boundary.
  const previousFuelWeightLbs = extractFuelTotalWeightLbs(previousRow);
  const fuelWeightLbs = extractFuelTotalWeightLbs(row);
  return Number.isFinite(previousFuelWeightLbs) && Number.isFinite(fuelWeightLbs)
    ? fuelWeightLbs - previousFuelWeightLbs > REFUEL_OR_RESET_INCREASE_LBS
    : false;
}

function hasReturnedToPreIncreaseLevel(anchorRow: AnyRecord, row: AnyRecord): boolean {
  const anchorFuelGal = extractFuelTotalGal(anchorRow);
  const fuelGal = extractFuelTotalGal(row);
  const anchorFuelWeightLbs = extractFuelTotalWeightLbs(anchorRow);
  const fuelWeightLbs = extractFuelTotalWeightLbs(row);
  const hasGalComparison = Number.isFinite(anchorFuelGal) && Number.isFinite(fuelGal);
  const hasWeightComparison = Number.isFinite(anchorFuelWeightLbs) && Number.isFinite(fuelWeightLbs);
  if (!hasGalComparison && !hasWeightComparison) return false;

  const gallonsReturned = !hasGalComparison || fuelGal <= anchorFuelGal + REFUEL_OR_RESET_INCREASE_GAL;
  const weightReturned = !hasWeightComparison || fuelWeightLbs <= anchorFuelWeightLbs + REFUEL_OR_RESET_INCREASE_LBS;
  return gallonsReturned && weightReturned;
}

function createFuelUsageRowSelector() {
  let firstFuelRow: AnyRecord | null = null;
  let previousFuelRow: AnyRecord | null = null;
  let lastAcceptedFuelRow: AnyRecord | null = null;
  let suspiciousAnchorRow: AnyRecord | null = null;

  function push(row: AnyRecord | null | undefined) {
    if (!hasFuelUsageAnchor(row)) return;
    const fuelRow = row as AnyRecord;

    if (!firstFuelRow) {
      firstFuelRow = fuelRow;
      previousFuelRow = firstFuelRow;
      lastAcceptedFuelRow = firstFuelRow;
      return;
    }

    if (suspiciousAnchorRow) {
      if (hasReturnedToPreIncreaseLevel(suspiciousAnchorRow, fuelRow)) {
        suspiciousAnchorRow = null;
        lastAcceptedFuelRow = fuelRow;
      }
      previousFuelRow = fuelRow;
      return;
    }

    if (isRefuelOrResetIncrease(previousFuelRow, fuelRow)) {
      suspiciousAnchorRow = previousFuelRow;
      previousFuelRow = fuelRow;
      return;
    }

    lastAcceptedFuelRow = fuelRow;
    previousFuelRow = fuelRow;
  }

  function result() {
    return {
      firstFuelRow,
      lastFuelRow: lastAcceptedFuelRow,
    };
  }

  return {
    push,
    result,
  };
}

function selectFuelUsageRows(rows: Array<AnyRecord | null | undefined>) {
  const selector = createFuelUsageRowSelector();
  for (const row of rows) {
    selector.push(row);
  }
  return selector.result();
}

function getRecordedFuelWeightPerGal(firstFuelRow: AnyRecord | null | undefined, lastFuelRow: AnyRecord | null | undefined) {
  return extractFuelWeightPerGal(firstFuelRow) ?? extractFuelWeightPerGal(lastFuelRow);
}

function inferFuelBurnGalFromFuelWeight(
  firstFuelRow: AnyRecord | null | undefined,
  lastFuelRow: AnyRecord | null | undefined,
) {
  const weightStartLbs = extractFuelTotalWeightLbs(firstFuelRow);
  const weightEndLbs = extractFuelTotalWeightLbs(lastFuelRow);
  if (!Number.isFinite(weightStartLbs) || !Number.isFinite(weightEndLbs)) return null;

  const deltaLbs = weightStartLbs - weightEndLbs;
  if (deltaLbs < MIN_WEIGHT_FUEL_BURN_LBS || deltaLbs > MAX_WEIGHT_FUEL_BURN_LBS) return null;

  const fuelWeightPerGal = getRecordedFuelWeightPerGal(firstFuelRow, lastFuelRow);
  if (!Number.isFinite(fuelWeightPerGal)) return null;
  return Math.round((deltaLbs / fuelWeightPerGal) * 10) / 10;
}

function getFuelBurnWeightLbs(
  firstFuelRow: AnyRecord | null | undefined,
  lastFuelRow: AnyRecord | null | undefined,
) {
  const weightStartLbs = extractFuelTotalWeightLbs(firstFuelRow);
  const weightEndLbs = extractFuelTotalWeightLbs(lastFuelRow);
  if (!Number.isFinite(weightStartLbs) || !Number.isFinite(weightEndLbs)) return null;

  const deltaLbs = weightStartLbs - weightEndLbs;
  if (deltaLbs < MIN_WEIGHT_FUEL_BURN_LBS || deltaLbs > MAX_WEIGHT_FUEL_BURN_LBS) return null;
  return Math.round(deltaLbs);
}

function summarizeFuelUsage(firstFuelRow: AnyRecord | null | undefined, lastFuelRow: AnyRecord | null | undefined) {
  const fuelStartGal = extractFuelTotalGal(firstFuelRow);
  const fuelEndGal = extractFuelTotalGal(lastFuelRow);
  const fuelBurnWeightLbs = getFuelBurnWeightLbs(firstFuelRow, lastFuelRow);
  const fuelWeightFuelBurnGal = inferFuelBurnGalFromFuelWeight(firstFuelRow, lastFuelRow);
  const fallbackSource = fuelBurnWeightLbs !== null ? 'fuel_total_weight' : null;

  if (!Number.isFinite(fuelStartGal) || !Number.isFinite(fuelEndGal)) {
    return {
      fuelStartGal,
      fuelEndGal,
      fuelBurnGal: fuelWeightFuelBurnGal,
      fuelBurnWeightLbs,
      fuelBurnSource: fallbackSource,
    };
  }

  const deltaGal = fuelStartGal - fuelEndGal;
  if (deltaGal < -1) {
    return {
      fuelStartGal,
      fuelEndGal,
      fuelBurnGal: fuelWeightFuelBurnGal,
      fuelBurnWeightLbs,
      fuelBurnSource: fallbackSource,
    };
  }

  const fuelBurnGal = Math.round(Math.max(0, deltaGal) * 10) / 10;
  if (fuelBurnGal <= MIN_RELIABLE_FUEL_BURN_GAL && fuelWeightFuelBurnGal !== null && fuelWeightFuelBurnGal > MIN_RELIABLE_FUEL_BURN_GAL) {
    return {
      fuelStartGal,
      fuelEndGal,
      fuelBurnGal: fuelWeightFuelBurnGal,
      fuelBurnWeightLbs,
      fuelBurnSource: fallbackSource,
    };
  }

  if (fuelBurnGal <= MIN_RELIABLE_FUEL_BURN_GAL) {
    return {
      fuelStartGal,
      fuelEndGal,
      fuelBurnGal: null,
      fuelBurnWeightLbs: null,
      fuelBurnSource: null,
    };
  }

  return {
    fuelStartGal,
    fuelEndGal,
    fuelBurnGal,
    fuelBurnWeightLbs,
    fuelBurnSource: 'fuel_total_gal',
  };
}

module.exports = {
  coalesceKnown,
  createFuelUsageRowSelector,
  extractFuelTotalGal,
  extractFuelTotalWeightLbs,
  extractFuelWeightPerGal,
  hasFuelUsageAnchor,
  mapCsvRow,
  mergeTouchdownDistance,
  parseCSV,
  parseJsonObject,
  parseValue,
  selectFuelUsageRows,
  summarizeFuelUsage,
  toBooleanOrNull,
  toFiniteNumber,
};

export {};
