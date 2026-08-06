const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  loadNodeSqlite,
  openHistoryIndexDatabase,
} = require('./sqlite-runtime.js');
const {
  HISTORY_INDEX_SCHEMA_VERSION,
  HISTORY_INDEX_SOURCE_CONTRACT_VERSION,
  initializeHistoryIndexSchema,
  readHistoryIndexMeta,
  readSqliteUserVersion,
} = require('./sqlite-schema.js');

function withTempDb(fn) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-history-index-schema-'));
  const dbPath = path.join(tmpRoot, 'history.sqlite');
  try {
    const opened = openHistoryIndexDatabase({ dbPath });
    assert.equal(opened.success, true, opened.error);
    try {
      fn(opened.db, dbPath);
    } finally {
      opened.db.close();
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

test('history index schema initializes tables, indexes, and meta', (t) => {
  const probe = loadNodeSqlite();
  if (!probe.available) {
    t.skip(`node:sqlite unavailable in this runtime: ${probe.error}`);
    return;
  }

  withTempDb((db) => {
    const result = initializeHistoryIndexSchema(db);
    assert.equal(result.contractInvalidated, false);
    assert.equal(result.schemaVersion, HISTORY_INDEX_SCHEMA_VERSION);
    assert.equal(result.sourceContractVersion, HISTORY_INDEX_SOURCE_CONTRACT_VERSION);
    assert.equal(readSqliteUserVersion(db), HISTORY_INDEX_SCHEMA_VERSION);

    const meta = readHistoryIndexMeta(db);
    assert.equal(meta.schema_version, String(HISTORY_INDEX_SCHEMA_VERSION));
    assert.equal(meta.source_contract_version, HISTORY_INDEX_SOURCE_CONTRACT_VERSION);
    assert.ok(meta.created_at);
    assert.ok(meta.updated_at);

    const tableRows = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name
    `).all();
    const tableNames = tableRows.map((row) => row.name);
    assert.ok(tableNames.includes('history_source_files'));
    assert.ok(tableNames.includes('history_flights'));
    assert.ok(tableNames.includes('history_landings'));

    const indexRows = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
      ORDER BY name
    `).all();
    const indexNames = indexRows.map((row) => row.name);
    assert.ok(indexNames.includes('history_flights_started_at_idx'));
    assert.ok(indexNames.includes('history_landings_timestamp_idx'));
    assert.ok(indexNames.includes('history_landings_flight_key_idx'));
  });
});

test('history index schema upgrades v1 in place and adds the landing flight-key index', (t) => {
  const probe = loadNodeSqlite();
  if (!probe.available) {
    t.skip(`node:sqlite unavailable in this runtime: ${probe.error}`);
    return;
  }

  withTempDb((db) => {
    initializeHistoryIndexSchema(db);
    db.prepare(`
      INSERT INTO history_source_files (
        source_id, csv_path, csv_basename, mtime_ms, size_bytes, indexed_at_ms, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('v1-source', 'C:/Flight Logs/v1.csv', 'v1.csv', 1, 2, 3, 'indexed');
    db.exec('DROP INDEX history_landings_flight_key_idx');
    db.exec('PRAGMA user_version = 1');
    db.prepare("UPDATE history_index_meta SET value = '1' WHERE key = 'schema_version'").run();

    const result = initializeHistoryIndexSchema(db);

    assert.equal(result.schemaVersion, HISTORY_INDEX_SCHEMA_VERSION);
    assert.equal(readSqliteUserVersion(db), HISTORY_INDEX_SCHEMA_VERSION);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM history_source_files').get().count, 1);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get('history_landings_flight_key_idx').count,
      1,
    );
  });
});

test('history index schema retains readable rows but invalidates their freshness when the source contract changes', (t) => {
  const probe = loadNodeSqlite();
  if (!probe.available) {
    t.skip(`node:sqlite unavailable in this runtime: ${probe.error}`);
    return;
  }

  withTempDb((db) => {
    initializeHistoryIndexSchema(db);
    db.prepare(`
      INSERT INTO history_source_files (
        source_id, csv_path, csv_basename, mtime_ms, size_bytes, indexed_at_ms,
        flights_mtime_ms, flights_size_bytes, flights_indexed_at_ms,
        landings_mtime_ms, landings_size_bytes, landings_indexed_at_ms, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'stale-source', 'C:/Flight Logs/stale.csv', 'stale.csv', 1234, 4096, 5678,
      1234, 4096, 5678, 1234, 4096, 5678, 'indexed',
    );
    db.prepare(`
      INSERT INTO history_flights (
        flight_key, flight_id, source_id, csv_path, csv_basename, mtime_ms, size_bytes, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'stale-source:flight',
      'flight',
      'stale-source',
      'C:/Flight Logs/stale.csv',
      'stale.csv',
      1234,
      4096,
      JSON.stringify({ aircraft: 'old-derived-value' }),
    );
    db.prepare("UPDATE history_index_meta SET value = 'flight-csv-history-index-v1' WHERE key = 'source_contract_version'").run();

    const result = initializeHistoryIndexSchema(db);

    assert.equal(result.contractInvalidated, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM history_source_files').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM history_flights').get().count, 1);
    const freshness = db.prepare(`
      SELECT flights_indexed_at_ms, landings_indexed_at_ms
      FROM history_source_files
    `).get();
    assert.equal(freshness.flights_indexed_at_ms, null);
    assert.equal(freshness.landings_indexed_at_ms, null);
    assert.equal(result.meta.source_contract_version, HISTORY_INDEX_SOURCE_CONTRACT_VERSION);
  });
});

test('history index schema initialization is read-neutral after the schema is current', (t) => {
  const probe = loadNodeSqlite();
  if (!probe.available) {
    t.skip(`node:sqlite unavailable in this runtime: ${probe.error}`);
    return;
  }

  withTempDb((db) => {
    initializeHistoryIndexSchema(db);
    db.prepare("UPDATE history_index_meta SET value = 'sentinel' WHERE key = 'updated_at'").run();

    const result = initializeHistoryIndexSchema(db);

    assert.equal(result.contractInvalidated, false);
    assert.equal(result.meta.updated_at, 'sentinel');
    assert.equal(readHistoryIndexMeta(db).updated_at, 'sentinel');
  });
});

test('history index schema accepts source, flight, and landing rows', (t) => {
  const probe = loadNodeSqlite();
  if (!probe.available) {
    t.skip(`node:sqlite unavailable in this runtime: ${probe.error}`);
    return;
  }

  withTempDb((db) => {
    initializeHistoryIndexSchema(db);

    db.prepare(`
      INSERT INTO history_source_files (
        source_id, csv_path, csv_basename, mtime_ms, size_bytes, indexed_at_ms, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('source-1', 'C:/Flight Logs/flight.csv', 'flight.csv', 1234, 4096, 5678, 'indexed');

    db.prepare(`
      INSERT INTO history_flights (
        flight_key, flight_id, source_id, csv_path, csv_basename, started_at_ms, ended_at_ms,
        mtime_ms, size_bytes, aircraft, departure_icao, arrival_icao, sample_count,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'source-1:flight-1',
      'flight-1',
      'source-1',
      'C:/Flight Logs/flight.csv',
      'flight.csv',
      1000,
      2000,
      1234,
      4096,
      '737-800',
      'EGLL',
      'LFPG',
      1200,
      JSON.stringify({ flightId: 'flight-1' }),
    );

    db.prepare(`
      INSERT INTO history_landings (
        landing_id, flight_key, flight_id, source_id, timestamp_ms, timestamp, aircraft, icao,
        runway, vs_fpm, grade, outcome_grade, gate_stable, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'landing-1',
      'source-1:flight-1',
      'flight-1',
      'source-1',
      2000,
      '2026-07-09T00:00:02.000Z',
      '737-800',
      'LFPG',
      '27R',
      -210,
      'Good',
      'Good',
      1,
      JSON.stringify({ id: 'landing-1', grade: 'Good' }),
    );

    const landing = db.prepare('SELECT landing_id, outcome_grade FROM history_landings').get();
    assert.equal(landing.landing_id, 'landing-1');
    assert.equal(landing.outcome_grade, 'Good');
  });
});

test('history index schema rejects newer sqlite user_version', (t) => {
  const probe = loadNodeSqlite();
  if (!probe.available) {
    t.skip(`node:sqlite unavailable in this runtime: ${probe.error}`);
    return;
  }

  withTempDb((db) => {
    db.exec(`PRAGMA user_version = ${HISTORY_INDEX_SCHEMA_VERSION + 1}`);
    assert.throws(
      () => initializeHistoryIndexSchema(db),
      /newer than supported/,
    );
  });
});
