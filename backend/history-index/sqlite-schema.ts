'use strict';

type AnyRecord = Record<string, any>;
type InitializeResult = {
  contractInvalidated: boolean;
  meta: Record<string, string>;
  schemaVersion: number;
  sourceContractVersion: string;
};

const HISTORY_INDEX_SCHEMA_VERSION = 2;
const HISTORY_INDEX_SOURCE_CONTRACT_VERSION = 'flight-bundle-history-index-v12';
const HISTORY_INDEX_TABLES = [
  'history_index_meta',
  'history_source_files',
  'history_flights',
  'history_landings',
];
const HISTORY_INDEX_INDEXES = [
  'history_flights_started_at_idx',
  'history_flights_aircraft_idx',
  'history_flights_route_idx',
  'history_flights_source_idx',
  'history_landings_timestamp_idx',
  'history_landings_aircraft_idx',
  'history_landings_airport_idx',
  'history_landings_runway_idx',
  'history_landings_source_idx',
  'history_landings_flight_key_idx',
];
const HISTORY_SOURCE_LANE_COLUMNS = [
  'flights_mtime_ms',
  'flights_size_bytes',
  'flights_indexed_at_ms',
  'landings_mtime_ms',
  'landings_size_bytes',
  'landings_indexed_at_ms',
];

function nowIso(): string {
  return new Date().toISOString();
}

function stringifyMetaValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function setMeta(db: AnyRecord, key: string, value: unknown): void {
  db.prepare(`
    INSERT INTO history_index_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, stringifyMetaValue(value));
}

function setMetaIfMissing(db: AnyRecord, key: string, value: unknown): void {
  db.prepare(`
    INSERT OR IGNORE INTO history_index_meta (key, value)
    VALUES (?, ?)
  `).run(key, stringifyMetaValue(value));
}

function readHistoryIndexMeta(db: AnyRecord): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM history_index_meta ORDER BY key').all();
  const meta: Record<string, string> = {};
  for (const row of rows || []) {
    if (row && typeof row.key === 'string') {
      meta[row.key] = stringifyMetaValue(row.value);
    }
  }
  return meta;
}

function readSqliteUserVersion(db: AnyRecord): number {
  const row = db.prepare('PRAGMA user_version').get();
  const value = row && typeof row === 'object' ? Number(row.user_version) : 0;
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function createHistoryIndexTables(db: AnyRecord): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS history_source_files (
      source_id TEXT PRIMARY KEY,
      csv_path TEXT NOT NULL UNIQUE,
      csv_basename TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      size_bytes INTEGER NOT NULL,
      indexed_at_ms INTEGER NOT NULL,
      flights_mtime_ms REAL,
      flights_size_bytes INTEGER,
      flights_indexed_at_ms INTEGER,
      landings_mtime_ms REAL,
      landings_size_bytes INTEGER,
      landings_indexed_at_ms INTEGER,
      status TEXT NOT NULL,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS history_flights (
      flight_key TEXT PRIMARY KEY,
      flight_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      csv_path TEXT NOT NULL,
      csv_basename TEXT NOT NULL,
      started_at_ms INTEGER,
      ended_at_ms INTEGER,
      mtime_ms REAL NOT NULL,
      size_bytes INTEGER NOT NULL,
      aircraft TEXT,
      aircraft_profile_id TEXT,
      departure_icao TEXT,
      arrival_icao TEXT,
      route_label TEXT,
      display_route_label TEXT,
      duration_ms INTEGER,
      duration_formatted TEXT,
      sample_count INTEGER,
      event_count INTEGER,
      fuel_burn_gal REAL,
      fuel_burn_source TEXT,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(source_id) REFERENCES history_source_files(source_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS history_landings (
      landing_id TEXT PRIMARY KEY,
      flight_key TEXT,
      flight_id TEXT,
      source_id TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      aircraft TEXT,
      aircraft_profile_id TEXT,
      icao TEXT,
      runway TEXT,
      vs_fpm REAL,
      grade TEXT,
      outcome_grade TEXT,
      gate_stable INTEGER,
      stability_score REAL,
      stability_gate_failures_json TEXT,
      touchdown_distance_ft REAL,
      touchdown_distance_grade TEXT,
      runway_excursion INTEGER,
      short_landing INTEGER,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(source_id) REFERENCES history_source_files(source_id) ON DELETE CASCADE,
      FOREIGN KEY(flight_key) REFERENCES history_flights(flight_key) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS history_flights_started_at_idx
      ON history_flights(started_at_ms DESC);
    CREATE INDEX IF NOT EXISTS history_flights_aircraft_idx
      ON history_flights(aircraft);
    CREATE INDEX IF NOT EXISTS history_flights_route_idx
      ON history_flights(departure_icao, arrival_icao);
    CREATE INDEX IF NOT EXISTS history_flights_source_idx
      ON history_flights(source_id);

    CREATE INDEX IF NOT EXISTS history_landings_timestamp_idx
      ON history_landings(timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS history_landings_aircraft_idx
      ON history_landings(aircraft);
    CREATE INDEX IF NOT EXISTS history_landings_airport_idx
      ON history_landings(icao);
    CREATE INDEX IF NOT EXISTS history_landings_runway_idx
      ON history_landings(icao, runway);
    CREATE INDEX IF NOT EXISTS history_landings_source_idx
      ON history_landings(source_id);
    CREATE INDEX IF NOT EXISTS history_landings_flight_key_idx
      ON history_landings(flight_key);
  `);
}

function ensureHistorySourceLaneColumns(db: AnyRecord): void {
  const existingColumns = new Set(
    (db.prepare('PRAGMA table_info(history_source_files)').all() || [])
      .map((row: AnyRecord) => row?.name)
      .filter((name: unknown): name is string => typeof name === 'string'),
  );
  const columns = [
    ['flights_mtime_ms', 'REAL'],
    ['flights_size_bytes', 'INTEGER'],
    ['flights_indexed_at_ms', 'INTEGER'],
    ['landings_mtime_ms', 'REAL'],
    ['landings_size_bytes', 'INTEGER'],
    ['landings_indexed_at_ms', 'INTEGER'],
  ];

  for (const [name, type] of columns) {
    if (!existingColumns.has(name)) {
      // nosemgrep: ff.sqlite.dynamic-sql-construction -- names and types come only from the fixed schema list above.
      db.exec(`ALTER TABLE history_source_files ADD COLUMN ${name} ${type}`);
    }
  }
}

function hasCurrentHistoryIndexSchema(db: AnyRecord, currentVersion: number): boolean {
  if (currentVersion !== HISTORY_INDEX_SCHEMA_VERSION) return false;
  try {
    const tableNames = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() || [])
        .map((row: AnyRecord) => row?.name)
        .filter((name: unknown): name is string => typeof name === 'string'),
    );
    if (HISTORY_INDEX_TABLES.some((tableName) => !tableNames.has(tableName))) return false;

    const indexNames = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() || [])
        .map((row: AnyRecord) => row?.name)
        .filter((name: unknown): name is string => typeof name === 'string'),
    );
    if (HISTORY_INDEX_INDEXES.some((indexName) => !indexNames.has(indexName))) return false;

    const sourceColumns = new Set(
      (db.prepare('PRAGMA table_info(history_source_files)').all() || [])
        .map((row: AnyRecord) => row?.name)
        .filter((name: unknown): name is string => typeof name === 'string'),
    );
    if (HISTORY_SOURCE_LANE_COLUMNS.some((columnName) => !sourceColumns.has(columnName))) return false;

    const meta = readHistoryIndexMeta(db);
    return meta.schema_version === String(HISTORY_INDEX_SCHEMA_VERSION)
      && meta.source_contract_version === HISTORY_INDEX_SOURCE_CONTRACT_VERSION;
  } catch {
    return false;
  }
}

function initializeHistoryIndexSchema(db: AnyRecord): InitializeResult {
  const currentVersion = readSqliteUserVersion(db);
  if (currentVersion > HISTORY_INDEX_SCHEMA_VERSION) {
    throw new Error(
      `History index schema version ${currentVersion} is newer than supported ${HISTORY_INDEX_SCHEMA_VERSION}`,
    );
  }

  db.exec('PRAGMA foreign_keys = ON');
  if (hasCurrentHistoryIndexSchema(db, currentVersion)) {
    return {
      contractInvalidated: false,
      meta: readHistoryIndexMeta(db),
      schemaVersion: HISTORY_INDEX_SCHEMA_VERSION,
      sourceContractVersion: HISTORY_INDEX_SOURCE_CONTRACT_VERSION,
    };
  }

  db.exec('BEGIN IMMEDIATE');
  let contractInvalidated = false;
  try {
    createHistoryIndexTables(db);
    ensureHistorySourceLaneColumns(db);
    const existingMeta = readHistoryIndexMeta(db);
    const existingContractVersion = existingMeta.source_contract_version;
    if (existingContractVersion && existingContractVersion !== HISTORY_INDEX_SOURCE_CONTRACT_VERSION) {
      // Indexed payloads are derived from CSVs by application code. A contract
      // bump means unchanged CSV identities may now produce different rows.
      // Mark both lanes stale so the progressive rebuild refreshes every source,
      // while retaining the previous derived rows for read availability.
      db.exec(`
        UPDATE history_source_files
        SET flights_mtime_ms = NULL,
            flights_size_bytes = NULL,
            flights_indexed_at_ms = NULL,
            landings_mtime_ms = NULL,
            landings_size_bytes = NULL,
            landings_indexed_at_ms = NULL
      `);
      contractInvalidated = true;
    }
    const now = nowIso();
    setMetaIfMissing(db, 'created_at', now);
    setMeta(db, 'updated_at', now);
    setMeta(db, 'schema_version', HISTORY_INDEX_SCHEMA_VERSION);
    setMeta(db, 'source_contract_version', HISTORY_INDEX_SOURCE_CONTRACT_VERSION);
    // nosemgrep: ff.sqlite.dynamic-sql-construction -- the version is an application-owned integer constant.
    db.exec(`PRAGMA user_version = ${HISTORY_INDEX_SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  }

  return {
    contractInvalidated,
    meta: readHistoryIndexMeta(db),
    schemaVersion: HISTORY_INDEX_SCHEMA_VERSION,
    sourceContractVersion: HISTORY_INDEX_SOURCE_CONTRACT_VERSION,
  };
}

module.exports = {
  HISTORY_INDEX_SCHEMA_VERSION,
  HISTORY_INDEX_SOURCE_CONTRACT_VERSION,
  initializeHistoryIndexSchema,
  readHistoryIndexMeta,
  readSqliteUserVersion,
};

export {};
