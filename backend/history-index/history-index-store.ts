'use strict';

const path = require('path') as typeof import('path');
const {
  isHistoryIndexCorruptionError,
  openHistoryIndexDatabase,
  quarantineHistoryIndexDatabase,
} = require('./sqlite-runtime.js') as {
  isHistoryIndexCorruptionError: (_error: unknown) => boolean;
  openHistoryIndexDatabase: (_options?: Record<string, unknown>) => AnyRecord;
  quarantineHistoryIndexDatabase: (_dbPath: unknown) => { quarantined: boolean; moved: string[]; error?: string };
};
const {
  initializeHistoryIndexSchema,
} = require('./sqlite-schema.js') as {
  initializeHistoryIndexSchema: (_db: AnyRecord) => AnyRecord;
};
const {
  createHistorySourceIdentity,
  normalizeHistorySourcePath,
} = require('./source-identity.js') as {
  createHistorySourceIdentity: (_input: SourceIndexInput['source']) => HistorySourceIdentity;
  normalizeHistorySourcePath: (_filePath: unknown) => string;
};
const { normalizeRetiredSpoilerStability } = require('../stability/retired-spoiler-compat.js') as {
  normalizeRetiredSpoilerStability: (value: unknown) => AnyRecord | null;
};
const { classifyApproachStability } = require('../stability/stability-runner.js') as {
  classifyApproachStability: (_value: AnyRecord | null | undefined) => string;
};

type AnyRecord = Record<string, any>;
type StoreOptions = {
  appDataRoot?: string;
  dbPath?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
};
type HistorySourceIdentity = {
  sourceId: string;
  csvPath: string;
  csvBasename: string;
  normalizedPath: string;
  mtimeMs: number;
  sizeBytes: number;
};
type SourceIndexInput = {
  source: {
    filePath: string;
    mtimeMs: number;
    sizeBytes: number;
    status?: string | null;
    error?: string | null;
    recordingSessionId?: string | null;
  };
  flights?: FlightIndexInput[];
  landings?: LandingIndexInput[];
};
type FlightIndexInput = {
  flightId: string;
  startedAtMs?: number | null;
  endedAtMs?: number | null;
  aircraft?: string | null;
  aircraftProfileId?: string | null;
  departureIcao?: string | null;
  arrivalIcao?: string | null;
  routeLabel?: string | null;
  displayRouteLabel?: string | null;
  durationMs?: number | null;
  durationFormatted?: string | null;
  sampleCount?: number | null;
  eventCount?: number | null;
  fuelBurnGal?: number | null;
  fuelBurnSource?: string | null;
  payload?: AnyRecord | null;
};
type LandingIndexInput = {
  landingId: string;
  flightId?: string | null;
  timestampMs: number;
  timestamp: string;
  aircraft?: string | null;
  aircraftProfileId?: string | null;
  icao?: string | null;
  runway?: string | null;
  vsFpm?: number | null;
  grade?: string | null;
  outcomeGrade?: string | null;
  gateStable?: boolean | null;
  stabilityScore?: number | null;
  stabilityVerdict?: string | null;
  stabilityGateFailures?: string[] | null;
  touchdownDistanceFt?: number | null;
  touchdownDistanceGrade?: string | null;
  runwayExcursion?: boolean | null;
  shortLanding?: boolean | null;
  payload?: AnyRecord | null;
};
type QueryFlightsOptions = {
  limit?: unknown;
  offset?: unknown;
  routeFilter?: unknown;
  aircraftFilter?: unknown;
  sort?: unknown;
};
type QueryLandingsOptions = {
  limit?: unknown;
  offset?: unknown;
};
type OpenStoreResult =
  | {
      success: true;
      store: ReturnType<typeof createHistoryIndexStore>;
      dbPath: string;
      recovered?: boolean;
      quarantined?: string[];
    }
  | { success: false; available: boolean; dbPath: string; error: string; recovered?: boolean; quarantined?: string[] };

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || 'Unknown error');
}

function assertHistoryIndexIntegrity(db: AnyRecord): void {
  const rows = db.prepare('PRAGMA quick_check(1)').all();
  const failures = (rows || [])
    .map((row: AnyRecord) => {
      if (!row || typeof row !== 'object') return String(row || 'unknown quick_check result');
      const value = Object.prototype.hasOwnProperty.call(row, 'quick_check')
        ? row.quick_check
        : Object.values(row)[0];
      return String(value || 'unknown quick_check result');
    })
    .filter((value: string) => value.toLowerCase() !== 'ok');
  if (failures.length > 0 || rows.length === 0) {
    throw new Error(`SQLITE_CORRUPT: history index quick_check failed: ${failures.join('; ') || 'no result'}`);
  }
}

function nullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

const MIN_RELIABLE_FUEL_BURN_GAL = 1;

function normalizeFuelBurnGal(value: unknown): number | null {
  const fuelBurnGal = nullableNumber(value);
  return fuelBurnGal !== null && fuelBurnGal > MIN_RELIABLE_FUEL_BURN_GAL ? fuelBurnGal : null;
}

function nullableInteger(value: unknown): number | null {
  const numeric = nullableNumber(value);
  return numeric === null ? null : Math.floor(numeric);
}

function boolToDb(value: unknown): number | null {
  return typeof value === 'boolean' ? (value ? 1 : 0) : null;
}

function dbBool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return Number(value) === 1;
}

function normalizeLimit(value: unknown, fallback: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(max, Math.floor(numeric)));
}

function normalizeOffset(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.floor(numeric));
}

function likePattern(value: unknown): string | null {
  const trimmed = nullableString(value);
  if (!trimmed) return null;
  return `%${trimmed.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function readSourceRow(row: AnyRecord | null | undefined): AnyRecord | null {
  if (!row) return null;
  return {
    sourceId: row.source_id,
    csvPath: row.csv_path,
    csvBasename: row.csv_basename,
    mtimeMs: row.mtime_ms,
    sizeBytes: row.size_bytes,
    indexedAtMs: row.indexed_at_ms,
    flightsMtimeMs: row.flights_mtime_ms,
    flightsSizeBytes: row.flights_size_bytes,
    flightsIndexedAtMs: row.flights_indexed_at_ms,
    landingsMtimeMs: row.landings_mtime_ms,
    landingsSizeBytes: row.landings_size_bytes,
    landingsIndexedAtMs: row.landings_indexed_at_ms,
    status: row.status,
    error: row.error,
  };
}

function readLaneSourceRow(row: AnyRecord | null | undefined, lane: 'flights' | 'landings'): AnyRecord | null {
  const source = readSourceRow(row);
  if (!source) return null;
  const mtimeMs = lane === 'flights' ? source.flightsMtimeMs : source.landingsMtimeMs;
  const sizeBytes = lane === 'flights' ? source.flightsSizeBytes : source.landingsSizeBytes;
  if (mtimeMs === null || mtimeMs === undefined || sizeBytes === null || sizeBytes === undefined) return null;
  if (!Number.isFinite(Number(mtimeMs)) || !Number.isFinite(Number(sizeBytes))) return null;
  return {
    ...source,
    mtimeMs: Number(mtimeMs),
    sizeBytes: Number(sizeBytes),
  };
}

function readFlightRow(row: AnyRecord): AnyRecord {
  let payload: AnyRecord | null = null;
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : null;
  } catch {
    payload = null;
  }
  const fuelBurnGal = normalizeFuelBurnGal(row.fuel_burn_gal);
  const csvMtimeMs = nullableNumber(payload?.csvMtimeMs) ?? nullableNumber(payload?.mtimeMs);
  const csvSizeBytes = nullableNumber(payload?.csvSizeBytes) ?? nullableNumber(payload?.sizeBytes);
  const timestamp = payload?.timestamp instanceof Date
    ? payload.timestamp.toISOString()
    : nullableString(payload?.timestamp);
  return {
    ...(payload && typeof payload === 'object' ? payload : {}),
    flightId: row.flight_id,
    sourceId: row.source_id,
    filePath: row.csv_path,
    csvBasename: row.csv_basename,
    timestamp: timestamp || (Number.isFinite(Number(row.mtime_ms)) ? new Date(Number(row.mtime_ms)).toISOString() : null),
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms,
    mtimeMs: csvMtimeMs ?? row.mtime_ms,
    sizeBytes: nullableNumber(payload?.sizeBytes) ?? row.size_bytes,
    csvMtimeMs: csvMtimeMs ?? row.mtime_ms,
    csvSizeBytes: csvSizeBytes ?? row.size_bytes,
    aircraft: row.aircraft,
    aircraftProfileId: row.aircraft_profile_id,
    departureIcao: row.departure_icao,
    arrivalIcao: row.arrival_icao,
    routeLabel: row.route_label,
    displayRouteLabel: row.display_route_label,
    durationMs: row.duration_ms,
    durationFormatted: row.duration_formatted,
    sampleCount: row.sample_count,
    eventCount: row.event_count,
    fuelBurnGal,
    fuelBurnSource: fuelBurnGal === null ? null : row.fuel_burn_source,
  };
}

function createFlightRowKey(sourceId: string, flightId: unknown): string {
  const normalizedFlightId = nullableString(flightId) || sourceId;
  return `${sourceId}:${normalizedFlightId}`;
}

function normalizeLandingStabilityForStorage(landing: LandingIndexInput): {
  gateStable: boolean | null;
  stabilityScore: number | null;
  stabilityGateFailures: string[];
  payloadJson: string;
} {
  const payload = landing.payload && typeof landing.payload === 'object' && !Array.isArray(landing.payload)
    ? landing.payload
    : null;
  const payloadUltimateStability = payload?.ultimateStability
    && typeof payload.ultimateStability === 'object'
    && !Array.isArray(payload.ultimateStability)
    ? payload.ultimateStability
    : null;
  const gateStable = typeof landing.gateStable === 'boolean'
    ? landing.gateStable
    : (typeof payload?.gateStable === 'boolean'
      ? payload.gateStable
      : (typeof payloadUltimateStability?.gateStable === 'boolean' ? payloadUltimateStability.gateStable : null));
  const stabilityScore = nullableNumber(landing.stabilityScore)
    ?? nullableNumber(payload?.stabilityScore)
    ?? nullableNumber(payloadUltimateStability?.score);
  const rawGateFailures = Array.isArray(landing.stabilityGateFailures)
    ? landing.stabilityGateFailures
    : (Array.isArray(payload?.stabilityGateFailures)
      ? payload.stabilityGateFailures
      : (Array.isArray(payloadUltimateStability?.gateFailures) ? payloadUltimateStability.gateFailures : []));
  const stabilityGateFailures = rawGateFailures
    .filter((failure): failure is string => typeof failure === 'string');
  if (!stabilityGateFailures.includes('spoilers_moved_after_gate')) {
    return {
      gateStable,
      stabilityScore,
      stabilityGateFailures,
      payloadJson: JSON.stringify(landing.payload || landing),
    };
  }

  const stability = normalizeRetiredSpoilerStability({
    score: stabilityScore,
    gateStable,
    gateFailures: stabilityGateFailures,
    breakdown: payload?.stabilityBreakdown,
    verdict: nullableString(landing.stabilityVerdict),
  });
  if (!stability) {
    return {
      gateStable,
      stabilityScore,
      stabilityGateFailures,
      payloadJson: JSON.stringify(landing.payload || landing),
    };
  }

  const normalizedPayload: AnyRecord = {
    ...(payload || landing),
    gateStable: stability.gateStable,
    stabilityScore: stability.score,
    stabilityGateFailures: stability.gateFailures,
    stabilityBreakdown: stability.breakdown,
    stabilityVerdict: stability.verdict,
  };
  if (payload?.ultimateStability && typeof payload.ultimateStability === 'object' && !Array.isArray(payload.ultimateStability)) {
    normalizedPayload.ultimateStability = {
      ...payload.ultimateStability,
      score: stability.score,
      verdict: stability.verdict,
      gateStable: stability.gateStable,
      gateFailures: stability.gateFailures,
      breakdown: stability.breakdown,
    };
  }

  return {
    gateStable: typeof stability.gateStable === 'boolean' ? stability.gateStable : null,
    stabilityScore: nullableNumber(stability.score),
    stabilityGateFailures: Array.isArray(stability.gateFailures)
      ? stability.gateFailures.filter((failure: unknown): failure is string => typeof failure === 'string')
      : [],
    payloadJson: JSON.stringify(normalizedPayload),
  };
}

function readLandingRow(row: AnyRecord): AnyRecord {
  let payload: AnyRecord | null = null;
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : null;
  } catch {
    payload = null;
  }
  const stabilityGateFailures = parseJsonArray(row.stability_gate_failures_json);
  const hasRetiredSpoilerPenalty = stabilityGateFailures.includes('spoilers_moved_after_gate');
  const stability = hasRetiredSpoilerPenalty ? normalizeRetiredSpoilerStability({
    score: row.stability_score,
    gateStable: dbBool(row.gate_stable),
    gateFailures: stabilityGateFailures,
    breakdown: payload?.stabilityBreakdown,
  }) : null;
  const recordedVerdict = nullableString(payload?.stabilityVerdict)
    || nullableString(payload?.ultimate_stability_verdict)
    || nullableString(payload?.ultimateStabilityVerdict)
    || nullableString(payload?.ultimateStability?.verdict);
  const stabilityVerdict = stability?.verdict
    || (
      recordedVerdict === 'stable'
      || recordedVerdict === 'marginal'
      || recordedVerdict === 'unstable'
      || recordedVerdict === 'no_verdict'
        ? recordedVerdict
        : classifyApproachStability({
          score: row.stability_score,
          gateStable: dbBool(row.gate_stable),
          gateFailures: stabilityGateFailures,
          breakdown: payload?.stabilityBreakdown,
          availability: payload?.stabilityAvailability,
        })
    );
  const gateStable = stability?.gateStable ?? dbBool(row.gate_stable);
  const stabilityScore = stability?.score ?? row.stability_score;
  const normalizedGateFailures = stability?.gateFailures ?? stabilityGateFailures;
  if (payload) {
    payload = {
      ...payload,
      ...(stability ? {
        gateStable,
        stabilityScore,
        stabilityGateFailures: normalizedGateFailures,
        stabilityBreakdown: stability.breakdown,
      } : {}),
      stabilityVerdict,
    };
    if (payload.ultimateStability && typeof payload.ultimateStability === 'object' && !Array.isArray(payload.ultimateStability)) {
      payload.ultimateStability = {
        ...payload.ultimateStability,
        score: stabilityScore,
        verdict: stabilityVerdict,
        gateStable,
        gateFailures: normalizedGateFailures,
        ...(stability ? { breakdown: stability.breakdown } : {}),
      };
    }
  }
  const recordedVsFpm = nullableNumber(row.vs_fpm);
  const landingVsFpm = recordedVsFpm !== null && recordedVsFpm < 0 ? recordedVsFpm : null;
  const landingGrade = recordedVsFpm !== null && landingVsFpm === null ? null : row.grade;
  return {
    landingId: row.landing_id,
    flightKey: row.flight_key,
    flightId: row.flight_id,
    sourceId: row.source_id,
    timestampMs: row.timestamp_ms,
    timestamp: row.timestamp,
    aircraft: row.aircraft,
    aircraftProfileId: row.aircraft_profile_id,
    icao: row.icao,
    runway: row.runway,
    vsFpm: landingVsFpm,
    grade: landingGrade,
    outcomeGrade: row.outcome_grade,
    gateStable,
    stabilityScore,
    stabilityVerdict,
    stabilityGateFailures: normalizedGateFailures,
    touchdownDistanceFt: row.touchdown_distance_ft,
    touchdownDistanceGrade: row.touchdown_distance_grade,
    runwayExcursion: dbBool(row.runway_excursion),
    shortLanding: dbBool(row.short_landing),
    payload,
  };
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function roundNullableNumber(value: unknown): number | null {
  const numeric = nullableNumber(value);
  return numeric === null ? null : Math.round(numeric);
}

function readCountMap(rows: AnyRecord[], labelKey = 'label'): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows || []) {
    const label = nullableString(row?.[labelKey]);
    if (!label) continue;
    result[label] = Number(row.count) || 0;
  }
  return result;
}

function linearSlope(values: Array<number | null | undefined>): number | null {
  const valid = values.filter((value): value is number => Number.isFinite(value));
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
  if (metric === 'stability') return slope > threshold ? 'improving' : slope < -threshold ? 'regressing' : 'stable';
  return 'stable';
}

function createHistoryIndexStore(db: AnyRecord) {
  assertHistoryIndexIntegrity(db);
  initializeHistoryIndexSchema(db);

  function getRawSourceRowByPath(filePath: unknown): AnyRecord | null {
    const normalizedFilePath = nullableString(filePath);
    if (!normalizedFilePath) return null;
    const csvPath = path.resolve(normalizedFilePath);
    return db.prepare('SELECT * FROM history_source_files WHERE csv_path = ? COLLATE NOCASE').get(csvPath);
  }

  function getSourceByPath(filePath: unknown): AnyRecord | null {
    return readSourceRow(getRawSourceRowByPath(filePath));
  }

  function getFlightsSourceByPath(filePath: unknown): AnyRecord | null {
    return readLaneSourceRow(getRawSourceRowByPath(filePath), 'flights');
  }

  function getLandingsSourceByPath(filePath: unknown): AnyRecord | null {
    return readLaneSourceRow(getRawSourceRowByPath(filePath), 'landings');
  }

  function getSourceFlightIds(sourceId: string): { primaryFlightId: string | null; flightKeysById: Map<string, string> } {
    const rows = db.prepare(`
      SELECT flight_id, flight_key
      FROM history_flights
      WHERE source_id = ?
      ORDER BY COALESCE(started_at_ms, 0) ASC, flight_key ASC
    `).all(sourceId);
    const flightKeysById = new Map<string, string>();
    let primaryFlightId: string | null = null;
    for (const row of rows || []) {
      const flightId = nullableString(row.flight_id);
      const flightKey = nullableString(row.flight_key);
      if (!flightId || !flightKey) continue;
      if (primaryFlightId === null) primaryFlightId = flightId;
      flightKeysById.set(flightId, flightKey);
    }
    return { primaryFlightId, flightKeysById };
  }

  function relinkSourceLandingsToFlights(sourceId: string, primaryFlightId: string | null): void {
    const flightRows = db.prepare(`
      SELECT flight_id, flight_key
      FROM history_flights
      WHERE source_id = ?
    `).all(sourceId);
    const linkLanding = db.prepare(`
      UPDATE history_landings
      SET flight_key = ?
      WHERE source_id = ? AND flight_id = ?
    `);
    for (const flightRow of flightRows || []) {
      const flightId = nullableString(flightRow.flight_id);
      const flightKey = nullableString(flightRow.flight_key);
      if (flightId && flightKey) linkLanding.run(flightKey, sourceId, flightId);
    }
    if (primaryFlightId) {
      const primaryFlightKey = createFlightRowKey(sourceId, primaryFlightId);
      db.prepare(`
        UPDATE history_landings
        SET flight_id = ?, flight_key = ?
        WHERE source_id = ? AND flight_key IS NULL
      `).run(primaryFlightId, primaryFlightKey, sourceId);
    }
  }

  function upsertSourceInTransaction(
    input: SourceIndexInput,
    indexedAtMs = Date.now(),
    lane: 'flights' | 'landings' | 'all' | null = null,
  ): HistorySourceIdentity {
    const identity = createHistorySourceIdentity(input.source);
    const status = nullableString(input.source.status) || 'indexed';
    const error = nullableString(input.source.error);

    db.prepare(`
      INSERT INTO history_source_files (
        source_id, csv_path, csv_basename, mtime_ms, size_bytes, indexed_at_ms, status, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        csv_path = excluded.csv_path,
        csv_basename = excluded.csv_basename,
        mtime_ms = excluded.mtime_ms,
        size_bytes = excluded.size_bytes,
        indexed_at_ms = excluded.indexed_at_ms,
        status = excluded.status,
        error = excluded.error
    `).run(
      identity.sourceId,
      identity.csvPath,
      identity.csvBasename,
      identity.mtimeMs,
      identity.sizeBytes,
      indexedAtMs,
      status,
      error,
    );

    if (lane === 'flights' || lane === 'all') {
      db.prepare(`
        UPDATE history_source_files
        SET flights_mtime_ms = ?, flights_size_bytes = ?, flights_indexed_at_ms = ?
        WHERE source_id = ?
      `).run(identity.mtimeMs, identity.sizeBytes, indexedAtMs, identity.sourceId);
    }
    if (lane === 'landings' || lane === 'all') {
      db.prepare(`
        UPDATE history_source_files
        SET landings_mtime_ms = ?, landings_size_bytes = ?, landings_indexed_at_ms = ?
        WHERE source_id = ?
      `).run(identity.mtimeMs, identity.sizeBytes, indexedAtMs, identity.sourceId);
    }

    return identity;
  }

  function replaceSourceFlightsIndexInTransaction(input: SourceIndexInput, indexedAtMs = Date.now()): AnyRecord {
    const identity = upsertSourceInTransaction(input, indexedAtMs, 'flights');
    const flights = Array.isArray(input.flights) ? input.flights : [];

    db.prepare('DELETE FROM history_flights WHERE source_id = ?').run(identity.sourceId);

    const insertFlight = db.prepare(`
      INSERT INTO history_flights (
        flight_key, flight_id, source_id, csv_path, csv_basename, started_at_ms, ended_at_ms,
        mtime_ms, size_bytes, aircraft, aircraft_profile_id, departure_icao,
        arrival_icao, route_label, display_route_label, duration_ms,
        duration_formatted, sample_count, event_count, fuel_burn_gal,
        fuel_burn_source, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const flight of flights) {
      const flightId = nullableString(flight.flightId) || identity.sourceId;
      const fuelBurnGal = normalizeFuelBurnGal(flight.fuelBurnGal);
      insertFlight.run(
        createFlightRowKey(identity.sourceId, flightId),
        flightId,
        identity.sourceId,
        identity.csvPath,
        identity.csvBasename,
        nullableInteger(flight.startedAtMs),
        nullableInteger(flight.endedAtMs),
        identity.mtimeMs,
        identity.sizeBytes,
        nullableString(flight.aircraft),
        nullableString(flight.aircraftProfileId),
        nullableString(flight.departureIcao),
        nullableString(flight.arrivalIcao),
        nullableString(flight.routeLabel),
        nullableString(flight.displayRouteLabel),
        nullableInteger(flight.durationMs),
        nullableString(flight.durationFormatted),
        nullableInteger(flight.sampleCount),
        nullableInteger(flight.eventCount),
        fuelBurnGal,
        fuelBurnGal === null ? null : nullableString(flight.fuelBurnSource),
        JSON.stringify(flight.payload || flight),
      );
    }
    const { primaryFlightId } = getSourceFlightIds(identity.sourceId);
    relinkSourceLandingsToFlights(identity.sourceId, primaryFlightId);

    return {
      source: readSourceRow(db.prepare('SELECT * FROM history_source_files WHERE source_id = ?').get(identity.sourceId)),
      flightsIndexed: flights.length,
    };
  }

  function replaceSourceLandingsIndexInTransaction(input: SourceIndexInput, indexedAtMs = Date.now()): AnyRecord {
    const identity = upsertSourceInTransaction(input, indexedAtMs, 'landings');
    const landings = Array.isArray(input.landings) ? input.landings : [];
    const { primaryFlightId, flightKeysById } = getSourceFlightIds(identity.sourceId);

    db.prepare('DELETE FROM history_landings WHERE source_id = ?').run(identity.sourceId);

    const insertLanding = db.prepare(`
      INSERT INTO history_landings (
        landing_id, flight_key, flight_id, source_id, timestamp_ms, timestamp, aircraft,
        aircraft_profile_id, icao, runway, vs_fpm, grade, outcome_grade,
        gate_stable, stability_score, stability_gate_failures_json,
        touchdown_distance_ft, touchdown_distance_grade, runway_excursion,
        short_landing, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const landing of landings) {
      const landingFlightId = nullableString(landing.flightId) || primaryFlightId;
      const stability = normalizeLandingStabilityForStorage(landing);
      insertLanding.run(
        nullableString(landing.landingId) || `${identity.sourceId}:${landing.timestampMs}`,
        landingFlightId ? flightKeysById.get(landingFlightId) || null : null,
        landingFlightId,
        identity.sourceId,
        nullableInteger(landing.timestampMs) || 0,
        nullableString(landing.timestamp) || new Date(nullableInteger(landing.timestampMs) || 0).toISOString(),
        nullableString(landing.aircraft),
        nullableString(landing.aircraftProfileId),
        nullableString(landing.icao),
        nullableString(landing.runway),
        nullableNumber(landing.vsFpm),
        nullableString(landing.grade),
        nullableString(landing.outcomeGrade),
        boolToDb(stability.gateStable),
        stability.stabilityScore,
        JSON.stringify(stability.stabilityGateFailures),
        nullableNumber(landing.touchdownDistanceFt),
        nullableString(landing.touchdownDistanceGrade),
        boolToDb(landing.runwayExcursion),
        boolToDb(landing.shortLanding),
        stability.payloadJson,
      );
    }

    return {
      source: readSourceRow(db.prepare('SELECT * FROM history_source_files WHERE source_id = ?').get(identity.sourceId)),
      landingsIndexed: landings.length,
    };
  }

  function replaceSourceIndexInTransaction(input: SourceIndexInput, indexedAtMs = Date.now()): AnyRecord {
    const identity = upsertSourceInTransaction(input, indexedAtMs, 'all');
    const flights = Array.isArray(input.flights) ? input.flights : [];
    const landings = Array.isArray(input.landings) ? input.landings : [];

    db.prepare('DELETE FROM history_landings WHERE source_id = ?').run(identity.sourceId);
    db.prepare('DELETE FROM history_flights WHERE source_id = ?').run(identity.sourceId);

    const insertFlight = db.prepare(`
      INSERT INTO history_flights (
        flight_key, flight_id, source_id, csv_path, csv_basename, started_at_ms, ended_at_ms,
        mtime_ms, size_bytes, aircraft, aircraft_profile_id, departure_icao,
        arrival_icao, route_label, display_route_label, duration_ms,
        duration_formatted, sample_count, event_count, fuel_burn_gal,
        fuel_burn_source, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const primaryFlightId = flights.length > 0
      ? (nullableString(flights[0]?.flightId) || identity.sourceId)
      : null;
    for (const flight of flights) {
      const flightId = nullableString(flight.flightId) || identity.sourceId;
      const fuelBurnGal = normalizeFuelBurnGal(flight.fuelBurnGal);
      insertFlight.run(
        createFlightRowKey(identity.sourceId, flightId),
        flightId,
        identity.sourceId,
        identity.csvPath,
        identity.csvBasename,
        nullableInteger(flight.startedAtMs),
        nullableInteger(flight.endedAtMs),
        identity.mtimeMs,
        identity.sizeBytes,
        nullableString(flight.aircraft),
        nullableString(flight.aircraftProfileId),
        nullableString(flight.departureIcao),
        nullableString(flight.arrivalIcao),
        nullableString(flight.routeLabel),
        nullableString(flight.displayRouteLabel),
        nullableInteger(flight.durationMs),
        nullableString(flight.durationFormatted),
        nullableInteger(flight.sampleCount),
        nullableInteger(flight.eventCount),
        fuelBurnGal,
        fuelBurnGal === null ? null : nullableString(flight.fuelBurnSource),
        JSON.stringify(flight.payload || flight),
      );
    }

    const insertLanding = db.prepare(`
      INSERT INTO history_landings (
        landing_id, flight_key, flight_id, source_id, timestamp_ms, timestamp, aircraft,
        aircraft_profile_id, icao, runway, vs_fpm, grade, outcome_grade,
        gate_stable, stability_score, stability_gate_failures_json,
        touchdown_distance_ft, touchdown_distance_grade, runway_excursion,
        short_landing, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const landing of landings) {
      const landingFlightId = nullableString(landing.flightId) || primaryFlightId;
      const stability = normalizeLandingStabilityForStorage(landing);
      insertLanding.run(
        nullableString(landing.landingId) || `${identity.sourceId}:${landing.timestampMs}`,
        landingFlightId ? createFlightRowKey(identity.sourceId, landingFlightId) : null,
        landingFlightId,
        identity.sourceId,
        nullableInteger(landing.timestampMs) || 0,
        nullableString(landing.timestamp) || new Date(nullableInteger(landing.timestampMs) || 0).toISOString(),
        nullableString(landing.aircraft),
        nullableString(landing.aircraftProfileId),
        nullableString(landing.icao),
        nullableString(landing.runway),
        nullableNumber(landing.vsFpm),
        nullableString(landing.grade),
        nullableString(landing.outcomeGrade),
        boolToDb(stability.gateStable),
        stability.stabilityScore,
        JSON.stringify(stability.stabilityGateFailures),
        nullableNumber(landing.touchdownDistanceFt),
        nullableString(landing.touchdownDistanceGrade),
        boolToDb(landing.runwayExcursion),
        boolToDb(landing.shortLanding),
        stability.payloadJson,
      );
    }

    return {
      source: readSourceRow(db.prepare('SELECT * FROM history_source_files WHERE source_id = ?').get(identity.sourceId)),
      flightsIndexed: flights.length,
      landingsIndexed: landings.length,
    };
  }

  function replaceSourceIndex(input: SourceIndexInput): AnyRecord {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = replaceSourceIndexInTransaction(input);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw err;
    }

  }

  function replaceSourcesIndex(inputs: SourceIndexInput[]): AnyRecord {
    const rows = Array.isArray(inputs) ? inputs : [];
    const indexedAtMs = Date.now();
    let flightsIndexed = 0;
    let landingsIndexed = 0;

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const input of rows) {
        const result = replaceSourceIndexInTransaction(input, indexedAtMs);
        flightsIndexed += Number(result.flightsIndexed) || 0;
        landingsIndexed += Number(result.landingsIndexed) || 0;
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw err;
    }

    return {
      sourcesIndexed: rows.length,
      flightsIndexed,
      landingsIndexed,
    };
  }

  function replaceSourcesFlightsIndex(inputs: SourceIndexInput[]): AnyRecord {
    const rows = Array.isArray(inputs) ? inputs : [];
    const indexedAtMs = Date.now();
    let flightsIndexed = 0;

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const input of rows) {
        const result = replaceSourceFlightsIndexInTransaction(input, indexedAtMs);
        flightsIndexed += Number(result.flightsIndexed) || 0;
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw err;
    }

    return {
      sourcesIndexed: rows.length,
      flightsIndexed,
    };
  }

  function replaceSourcesLandingsIndex(inputs: SourceIndexInput[]): AnyRecord {
    const rows = Array.isArray(inputs) ? inputs : [];
    const indexedAtMs = Date.now();
    let landingsIndexed = 0;

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const input of rows) {
        const result = replaceSourceLandingsIndexInTransaction(input, indexedAtMs);
        landingsIndexed += Number(result.landingsIndexed) || 0;
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw err;
    }

    return {
      sourcesIndexed: rows.length,
      landingsIndexed,
    };
  }

  function pruneMissingSources(filePaths: unknown[]): { sourcesPruned: number; flightsPruned: number } {
    const keepPaths = new Set(
      (Array.isArray(filePaths) ? filePaths : [])
        .filter((filePath) => typeof filePath === 'string' && filePath.length > 0)
        .map((filePath) => normalizeHistorySourcePath(filePath)),
    );
    const rows = db.prepare('SELECT source_id, csv_path FROM history_source_files WHERE flights_indexed_at_ms IS NOT NULL').all();
    let sourcesPruned = 0;
    let flightsPruned = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      const deleteFlights = db.prepare('DELETE FROM history_flights WHERE source_id = ?');
      const clearFlightFreshness = db.prepare(`
        UPDATE history_source_files
        SET flights_mtime_ms = NULL, flights_size_bytes = NULL, flights_indexed_at_ms = NULL
        WHERE source_id = ?
      `);
      const deleteOrphanSource = db.prepare(`
        DELETE FROM history_source_files
        WHERE source_id = ? AND landings_indexed_at_ms IS NULL
      `);
      for (const row of rows || []) {
        if (!keepPaths.has(normalizeHistorySourcePath(row.csv_path))) {
          const result = deleteFlights.run(row.source_id);
          clearFlightFreshness.run(row.source_id);
          deleteOrphanSource.run(row.source_id);
          sourcesPruned += 1;
          flightsPruned += Number(result?.changes) || 0;
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
    return { sourcesPruned, flightsPruned };
  }

  function pruneMissingLandingSourcesInTransaction(filePaths: unknown[]): { sourcesPruned: number; landingsPruned: number } {
    const keepPaths = new Set(
      (Array.isArray(filePaths) ? filePaths : [])
        .filter((filePath) => typeof filePath === 'string' && filePath.length > 0)
        .map((filePath) => normalizeHistorySourcePath(filePath)),
    );
    const rows = db.prepare('SELECT source_id, csv_path FROM history_source_files WHERE landings_indexed_at_ms IS NOT NULL').all();
    let sourcesPruned = 0;
    let landingsPruned = 0;
    const deleteLandings = db.prepare('DELETE FROM history_landings WHERE source_id = ?');
    const clearLandingFreshness = db.prepare(`
      UPDATE history_source_files
      SET landings_mtime_ms = NULL, landings_size_bytes = NULL, landings_indexed_at_ms = NULL
      WHERE source_id = ?
    `);
    const deleteOrphanSource = db.prepare(`
      DELETE FROM history_source_files
      WHERE source_id = ? AND flights_indexed_at_ms IS NULL
    `);
    for (const row of rows || []) {
      if (!keepPaths.has(normalizeHistorySourcePath(row.csv_path))) {
        const result = deleteLandings.run(row.source_id);
        clearLandingFreshness.run(row.source_id);
        deleteOrphanSource.run(row.source_id);
        sourcesPruned += 1;
        landingsPruned += Number(result?.changes) || 0;
      }
    }
    return { sourcesPruned, landingsPruned };
  }

  function pruneMissingLandingSources(filePaths: unknown[]): { sourcesPruned: number; landingsPruned: number } {
    db.exec('BEGIN IMMEDIATE');
    try {
      const pruned = pruneMissingLandingSourcesInTransaction(filePaths);
      db.exec('COMMIT');
      return pruned;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  function refreshSourcesLandingsIndex(inputs: SourceIndexInput[], filePaths: unknown[]): AnyRecord {
    const rows = Array.isArray(inputs) ? inputs : [];
    const indexedAtMs = Date.now();
    let landingsIndexed = 0;

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const input of rows) {
        const result = replaceSourceLandingsIndexInTransaction(input, indexedAtMs);
        landingsIndexed += Number(result.landingsIndexed) || 0;
      }
      const pruned = pruneMissingLandingSourcesInTransaction(filePaths);
      db.exec('COMMIT');
      return {
        sourcesIndexed: rows.length,
        landingsIndexed,
        ...pruned,
      };
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  function queryFlights(options: QueryFlightsOptions = {}): AnyRecord {
    const limit = normalizeLimit(options.limit, 150, 1000);
    const offset = normalizeOffset(options.offset);
    const where: string[] = [];
    const params: unknown[] = [];
    const aircraft = likePattern(options.aircraftFilter);
    const route = likePattern(options.routeFilter);
    if (aircraft) {
      where.push('aircraft LIKE ? ESCAPE \'\\\'');
      params.push(aircraft);
    }
    if (route) {
      where.push(`(
        route_label LIKE ? ESCAPE '\\'
        OR display_route_label LIKE ? ESCAPE '\\'
        OR departure_icao LIKE ? ESCAPE '\\'
        OR arrival_icao LIKE ? ESCAPE '\\'
      )`);
      params.push(route, route, route, route);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    let sortSql = 'ORDER BY COALESCE(started_at_ms, mtime_ms, 0) DESC';
    switch (String(options.sort || 'recent')) {
      case 'oldest':
        sortSql = 'ORDER BY COALESCE(started_at_ms, mtime_ms, 0) ASC';
        break;
      case 'fuel_burn_desc':
        sortSql = 'ORDER BY CASE WHEN fuel_burn_gal > 1 THEN 0 ELSE 1 END ASC, fuel_burn_gal DESC, COALESCE(started_at_ms, mtime_ms, 0) DESC';
        break;
      case 'fuel_burn_asc':
        sortSql = 'ORDER BY CASE WHEN fuel_burn_gal > 1 THEN 0 ELSE 1 END ASC, fuel_burn_gal ASC, COALESCE(started_at_ms, mtime_ms, 0) DESC';
        break;
      case 'route':
        sortSql = 'ORDER BY COALESCE(display_route_label, route_label, \'\') COLLATE NOCASE ASC, COALESCE(started_at_ms, mtime_ms, 0) DESC';
        break;
      case 'aircraft':
        sortSql = 'ORDER BY COALESCE(aircraft, \'\') COLLATE NOCASE ASC, COALESCE(display_route_label, route_label, \'\') COLLATE NOCASE ASC, COALESCE(started_at_ms, mtime_ms, 0) DESC';
        break;
    }
    // nosemgrep: ff.sqlite.dynamic-sql-construction -- predicates are selected from fixed clauses above; values stay bound.
    const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM history_flights ${whereSql}`).get(...params);
    const rows = limit === 0
      ? []
      // nosemgrep: ff.sqlite.dynamic-sql-construction -- predicates and ordering are fixed allowlists; values stay bound.
      : db.prepare(`
        SELECT *
        FROM history_flights
        ${whereSql}
        ${sortSql}
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset);
    return {
      flights: rows.map(readFlightRow),
      totalMatching: Number(totalRow?.total) || 0,
      limit,
      offset,
    };
  }

  function queryLandings(options: QueryLandingsOptions = {}): AnyRecord {
    const limit = normalizeLimit(options.limit, 500, 1000);
    const offset = normalizeOffset(options.offset);
    const totalRow = db.prepare('SELECT COUNT(*) AS total FROM history_landings').get();
    const rows = limit === 0
      ? []
      : db.prepare(`
        SELECT *
        FROM history_landings
        ORDER BY timestamp_ms DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset);
    return {
      landings: rows.map(readLandingRow),
      totalMatching: Number(totalRow?.total) || 0,
      limit,
      offset,
    };
  }

  function queryLatestLandingForSource(sourceId: unknown): AnyRecord | null {
    const normalizedSourceId = nullableString(sourceId);
    if (!normalizedSourceId) return null;
    const row = db.prepare(`
      SELECT *
      FROM history_landings
      WHERE source_id = ?
      ORDER BY timestamp_ms DESC
      LIMIT 1
    `).get(normalizedSourceId);
    return row ? readLandingRow(row) : null;
  }

  function queryLogbookEntries(options: QueryLandingsOptions = {}): AnyRecord {
    const limit = normalizeLimit(options.limit, 500, 1000);
    const offset = normalizeOffset(options.offset);
    const totalRow = db.prepare('SELECT COUNT(*) AS total FROM history_landings').get();
    const rows = limit === 0
      ? []
      : db.prepare(`
        SELECT *
        FROM history_landings
        ORDER BY timestamp_ms DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset);
    const entries = rows.map((row: AnyRecord) => {
      const landing = readLandingRow(row);
      if (!landing.payload || typeof landing.payload !== 'object') return landing;
      const { payload, ...indexed } = landing;
      return { ...payload, ...indexed };
    });
    return {
      entries,
      totalMatching: Number(totalRow?.total) || 0,
      limit,
      offset,
    };
  }

  function queryLogbookSnapshot(options: QueryLandingsOptions = {}): AnyRecord {
    db.exec('BEGIN');
    try {
      const page = queryLogbookEntries(options);
      const stats = queryLogbookStats();
      db.exec('COMMIT');
      return { page, stats };
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  function queryLogbookTrendRows(kind: 'aircraft' | 'airports' | 'runways', limit = 5): AnyRecord[] {
    const configs = {
      aircraft: {
        keySql: 'aircraft',
        labelSql: 'aircraft',
        extraSelect: '',
        whereSql: 'aircraft IS NOT NULL AND TRIM(aircraft) <> \'\'',
        groupSql: 'aircraft',
        trendWhereSql: 'aircraft = ?',
        trendParams: (row: AnyRecord) => [row.key],
      },
      airports: {
        keySql: 'icao',
        labelSql: 'icao',
        extraSelect: '',
        whereSql: 'icao IS NOT NULL AND TRIM(icao) <> \'\'',
        groupSql: 'icao',
        trendWhereSql: 'icao = ?',
        trendParams: (row: AnyRecord) => [row.key],
      },
      runways: {
        keySql: "icao || ':' || runway",
        labelSql: "icao || ' ' || runway",
        extraSelect: ', icao AS trend_icao, runway AS trend_runway',
        whereSql: 'icao IS NOT NULL AND TRIM(icao) <> \'\' AND runway IS NOT NULL AND TRIM(runway) <> \'\'',
        groupSql: 'icao, runway',
        trendWhereSql: 'icao = ? AND runway = ?',
        trendParams: (row: AnyRecord) => [row.trend_icao, row.trend_runway],
      },
    };
    const config = configs[kind];
    // nosemgrep: ff.sqlite.dynamic-sql-construction -- kind is a closed union selecting fixed SQL fragments.
    const groups = db.prepare(`
      SELECT
        ${config.keySql} AS key,
        ${config.labelSql} AS label
        ${config.extraSelect},
        COUNT(*) AS count,
        ROUND(AVG(CASE WHEN vs_fpm < 0 THEN vs_fpm END)) AS avg_vs_fpm,
        ROUND(AVG(stability_score)) AS avg_stability_score,
        MAX(timestamp_ms) AS latest_timestamp_ms
      FROM history_landings
      WHERE ${config.whereSql}
      GROUP BY ${config.groupSql}
      ORDER BY count DESC, latest_timestamp_ms DESC
      LIMIT ?
    `).all(Math.max(0, Math.min(20, Math.floor(Number(limit) || 5))));

    // nosemgrep: ff.sqlite.dynamic-sql-construction -- the selected predicate is fixed and its values remain bound.
    const trendStatement = db.prepare(`
      SELECT
        vs_fpm,
        stability_score,
        gate_stable,
        stability_gate_failures_json,
        payload_json
      FROM history_landings
      WHERE ${config.trendWhereSql}
      ORDER BY timestamp_ms ASC
    `);

    return (groups || []).map((row: AnyRecord) => {
      const trendRows = trendStatement.all(...config.trendParams(row));
      const verdictValues = trendRows
        .map((trendRow: AnyRecord) => readLandingRow(trendRow).stabilityVerdict)
        .filter((verdict: unknown) => verdict !== 'no_verdict');
      const stableCount = verdictValues.filter((verdict: unknown) => verdict === 'stable').length;
      const marginalCount = verdictValues.filter((verdict: unknown) => verdict === 'marginal').length;
      return {
        key: nullableString(row.key) || '',
        label: nullableString(row.label) || nullableString(row.key) || '',
        count: Number(row.count) || 0,
        avgVsFpm: roundNullableNumber(row.avg_vs_fpm),
        avgStabilityScore: roundNullableNumber(row.avg_stability_score),
        stableRatePct: verdictValues.length > 0 ? Math.round((stableCount / verdictValues.length) * 100) : null,
        marginalRatePct: verdictValues.length > 0 ? Math.round((marginalCount / verdictValues.length) * 100) : null,
        trendVs: linearTrend(trendRows.map((trendRow: AnyRecord) => {
          const vsFpm = nullableNumber(trendRow.vs_fpm);
          return vsFpm !== null && vsFpm < 0 ? vsFpm : null;
        }), 'vs'),
        trendStability: linearTrend(trendRows.map((trendRow: AnyRecord) => nullableNumber(trendRow.stability_score)), 'stability'),
        latestTimestampMs: nullableInteger(row.latest_timestamp_ms),
      };
    });
  }

  function queryLogbookStats(): AnyRecord {
    const totals = db.prepare(`
      SELECT
        COUNT(*) AS total,
        ROUND(AVG(CASE WHEN vs_fpm < 0 THEN vs_fpm END)) AS avg_vs_fpm,
        ROUND(MAX(CASE WHEN vs_fpm < 0 THEN vs_fpm END)) AS best_vs_fpm,
        COUNT(DISTINCT NULLIF(TRIM(icao), '')) AS airports,
        COUNT(DISTINCT NULLIF(TRIM(aircraft), '')) AS aircraft,
        SUM(CASE
          WHEN touchdown_distance_grade = 'Long Landing' OR outcome_grade = 'Long Landing' THEN 1
          ELSE 0
        END) AS long_landing_count
      FROM history_landings
    `).get();
    const gradeRows = db.prepare(`
      SELECT grade AS label, COUNT(*) AS count
      FROM history_landings
      WHERE grade IS NOT NULL AND TRIM(grade) <> ''
        AND (vs_fpm IS NULL OR vs_fpm < 0)
      GROUP BY grade
    `).all();
    const outcomeRows = db.prepare(`
      SELECT outcome_grade AS label, COUNT(*) AS count
      FROM history_landings
      WHERE outcome_grade IS NOT NULL AND TRIM(outcome_grade) <> ''
      GROUP BY outcome_grade
    `).all();

    return {
      total: Number(totals?.total) || 0,
      grades: readCountMap(gradeRows),
      outcomeGrades: readCountMap(outcomeRows),
      longLandingCount: Number(totals?.long_landing_count) || 0,
      avgVsFpm: roundNullableNumber(totals?.avg_vs_fpm),
      bestVsFpm: roundNullableNumber(totals?.best_vs_fpm),
      airports: Number(totals?.airports) || 0,
      aircraft: Number(totals?.aircraft) || 0,
      trends: {
        aircraft: queryLogbookTrendRows('aircraft'),
        airports: queryLogbookTrendRows('airports'),
        runways: queryLogbookTrendRows('runways'),
      },
    };
  }

  function getCounts(): AnyRecord {
    return {
      sources: Number(db.prepare('SELECT COUNT(*) AS count FROM history_source_files').get()?.count) || 0,
      flights: Number(db.prepare('SELECT COUNT(*) AS count FROM history_flights').get()?.count) || 0,
      landings: Number(db.prepare('SELECT COUNT(*) AS count FROM history_landings').get()?.count) || 0,
    };
  }

  /**
   * Clear only Flight Fabric's derived SQLite catalogue. Authoritative CSVs and
   * portable history-summary sidecars are deliberately outside this database
   * transaction and are never touched by an index rebuild.
   */
  function clearDerivedHistoryIndex(): AnyRecord {
    const before = getCounts();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM history_landings').run();
      db.prepare('DELETE FROM history_flights').run();
      db.prepare('DELETE FROM history_source_files').run();
      db.exec('COMMIT');
      return before;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  function close(): void {
    db.close();
  }

  return {
    clearDerivedHistoryIndex,
    close,
    db,
    getCounts,
    getFlightsSourceByPath,
    getLandingsSourceByPath,
    getSourceByPath,
    pruneMissingLandingSources,
    pruneMissingSources,
    queryFlights,
    queryLatestLandingForSource,
    queryLandings,
    queryLogbookEntries,
    queryLogbookSnapshot,
    queryLogbookStats,
    refreshSourcesLandingsIndex,
    replaceSourceIndex,
    replaceSourcesFlightsIndex,
    replaceSourcesIndex,
    replaceSourcesLandingsIndex,
  };
}

function openHistoryIndexStore(options: StoreOptions = {}): OpenStoreResult {
  function recoverCorruptDatabase(dbPath: string, originalError: string): OpenStoreResult | null {
    if (!isHistoryIndexCorruptionError(originalError)) return null;

    const quarantine = quarantineHistoryIndexDatabase(dbPath);
    if (!quarantine.quarantined || quarantine.error) {
      return {
        success: false,
        available: true,
        dbPath,
        error: quarantine.error
          ? `${originalError}; failed to quarantine corrupt history index safely: ${quarantine.error}`
          : originalError,
        recovered: false,
        quarantined: quarantine.moved,
      };
    }

    const reopened = openHistoryIndexDatabase({ ...options, dbPath });
    if (reopened.success !== true) {
      return {
        success: false,
        available: reopened.available,
        dbPath: reopened.dbPath,
        error: `History index was quarantined after corruption, but a fresh database could not open: ${reopened.error}`,
        recovered: false,
        quarantined: quarantine.moved,
      };
    }

    try {
      return {
        success: true,
        store: createHistoryIndexStore(reopened.db),
        dbPath: reopened.dbPath,
        recovered: true,
        quarantined: quarantine.moved,
      };
    } catch (err) {
      try {
        reopened.db.close();
      } catch {}
      return {
        success: false,
        available: true,
        dbPath: reopened.dbPath,
        error: `History index was quarantined after corruption, but a fresh schema could not initialize: ${getErrorMessage(err)}`,
        recovered: false,
        quarantined: quarantine.moved,
      };
    }
  }

  const opened = openHistoryIndexDatabase(options);
  if (opened.success !== true) {
    const recovered = recoverCorruptDatabase(opened.dbPath, opened.error);
    if (recovered) return recovered;
    return {
      success: false,
      available: opened.available,
      dbPath: opened.dbPath,
      error: opened.error,
    };
  }

  try {
    return {
      success: true,
      store: createHistoryIndexStore(opened.db),
      dbPath: opened.dbPath,
    };
  } catch (err) {
    const error = getErrorMessage(err);
    try {
      opened.db.close();
    } catch {}
    const recovered = recoverCorruptDatabase(opened.dbPath, error);
    if (recovered) return recovered;
    return {
      success: false,
      available: true,
      dbPath: opened.dbPath,
      error,
    };
  }
}

module.exports = {
  assertHistoryIndexIntegrity,
  createHistoryIndexStore,
  openHistoryIndexStore,
};

export {};
