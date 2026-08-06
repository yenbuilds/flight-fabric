const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  HISTORY_INDEX_BUSY_TIMEOUT_MS,
  loadNodeSqlite,
  openHistoryIndexDatabase,
} = require('./sqlite-runtime.js');
const {
  HISTORY_INDEX_SCHEMA_VERSION,
  initializeHistoryIndexSchema,
  readSqliteUserVersion,
} = require('./sqlite-schema.js');

type AnyRecord = Record<string, any>;

function readCheckValues(rows: AnyRecord[], key: string): string[] {
  return (rows || []).map((row) => String(row?.[key] ?? Object.values(row || {})[0] ?? ''));
}

function findUnindexedForeignKeys(db: AnyRecord): string[] {
  const tableRows = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();
  const failures: string[] = [];

  for (const tableRow of tableRows || []) {
    const tableName = String(tableRow.name || '');
    const foreignKeyRows = db.prepare(`
      SELECT id, seq, "from" AS child_column
      FROM pragma_foreign_key_list(?)
      ORDER BY id, seq
    `).all(tableName);
    const foreignKeys = new Map<number, string[]>();
    for (const row of foreignKeyRows || []) {
      const id = Number(row.id);
      const columns = foreignKeys.get(id) || [];
      columns.push(String(row.child_column));
      foreignKeys.set(id, columns);
    }

    const indexRows = db.prepare('SELECT name FROM pragma_index_list(?) WHERE partial = 0').all(tableName);
    const indexColumns = (indexRows || []).map((row: AnyRecord) => (
      (db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(row.name) || [])
        .map((column: AnyRecord) => String(column.name))
    ));

    for (const [id, childColumns] of foreignKeys) {
      const covered = indexColumns.some((columns: string[]) => (
        childColumns.every((column, index) => columns[index] === column)
      ));
      if (!covered) failures.push(`${tableName} foreign key ${id} (${childColumns.join(', ')})`);
    }
  }

  return failures;
}

test('SQLite database doctor validates the production history-index schema', (t) => {
  const probe = loadNodeSqlite();
  if (!probe.available) {
    t.skip(`node:sqlite unavailable in this runtime: ${probe.error}`);
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-sqlite-doctor-'));
  const dbPath = path.join(tmpRoot, 'history.sqlite');
  const opened = openHistoryIndexDatabase({ dbPath });
  assert.equal(opened.success, true, opened.error);

  try {
    const db = opened.db;
    initializeHistoryIndexSchema(db);
    db.prepare(`
      INSERT INTO history_source_files (
        source_id, csv_path, csv_basename, mtime_ms, size_bytes, indexed_at_ms, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('doctor-source', 'C:/Flight Logs/doctor.csv', 'doctor.csv', 1, 2, 3, 'indexed');
    db.prepare(`
      INSERT INTO history_flights (
        flight_key, flight_id, source_id, csv_path, csv_basename, mtime_ms, size_bytes, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'doctor-source:doctor-flight',
      'doctor-flight',
      'doctor-source',
      'C:/Flight Logs/doctor.csv',
      'doctor.csv',
      1,
      2,
      '{}',
    );
    db.prepare(`
      INSERT INTO history_landings (
        landing_id, flight_key, flight_id, source_id, timestamp_ms, timestamp, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'doctor-landing',
      'doctor-source:doctor-flight',
      'doctor-flight',
      'doctor-source',
      4,
      '2026-08-06T00:00:00.004Z',
      '{}',
    );

    assert.equal(readSqliteUserVersion(db), HISTORY_INDEX_SCHEMA_VERSION);
    assert.equal(String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
    assert.equal(Number(db.prepare('PRAGMA synchronous').get().synchronous), 1);
    assert.equal(Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys), 1);
    assert.equal(Number(db.prepare('PRAGMA trusted_schema').get().trusted_schema), 0);
    assert.equal(Number(db.prepare('PRAGMA busy_timeout').get().timeout), HISTORY_INDEX_BUSY_TIMEOUT_MS);

    assert.deepEqual(readCheckValues(db.prepare('PRAGMA quick_check').all(), 'quick_check'), ['ok']);
    assert.deepEqual(readCheckValues(db.prepare('PRAGMA integrity_check').all(), 'integrity_check'), ['ok']);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(findUnindexedForeignKeys(db), []);
  } finally {
    try { opened.db.close(); } catch {}
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

export {};
