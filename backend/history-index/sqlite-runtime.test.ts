const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  HISTORY_INDEX_BUSY_TIMEOUT_MS,
  HISTORY_INDEX_DB_FILE_NAME,
  isHistoryIndexCorruptionError,
  loadNodeSqlite,
  openHistoryIndexDatabase,
  quarantineHistoryIndexDatabase,
  resolveHistoryIndexDatabasePath,
  runHistoryIndexSqliteSmoke,
} = require('./sqlite-runtime.js');

test('history index database path resolves under app data', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-history-index-path-'));
  try {
    const env = {
      APPDATA: path.join(tmpRoot, 'AppData', 'Roaming'),
      HOME: tmpRoot,
      USERPROFILE: tmpRoot,
      XDG_CONFIG_HOME: path.join(tmpRoot, '.config'),
    };
    const resolved = resolveHistoryIndexDatabasePath({ env });
    assert.equal(path.basename(resolved), HISTORY_INDEX_DB_FILE_NAME);
    assert.ok(resolved.includes('Flight Fabric'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('history index sqlite smoke opens a temp database when node:sqlite is available', (t) => {
  const probe = loadNodeSqlite();
  if (!probe.available) {
    t.skip(`node:sqlite unavailable in this runtime: ${probe.error}`);
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-history-index-smoke-'));
  try {
    const dbPath = path.join(tmpRoot, 'history.sqlite');
    const result = runHistoryIndexSqliteSmoke({ dbPath });
    assert.equal(result.success, true, result.error);
    assert.equal(result.available, true);
    assert.equal(result.runtime, 'node:sqlite');
    assert.equal(result.userVersion, 0);
    assert.equal(result.dbPath, dbPath);
    assert.equal(fs.existsSync(dbPath), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('history index sqlite smoke refuses an implicit or explicit production database path', (t) => {
  const probe = loadNodeSqlite();
  if (!probe.available) {
    t.skip(`node:sqlite unavailable in this runtime: ${probe.error}`);
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-history-index-smoke-guard-'));
  const appDataRoot = path.join(tmpRoot, 'Flight Fabric');
  const productionDbPath = path.join(appDataRoot, HISTORY_INDEX_DB_FILE_NAME);
  try {
    const implicit = runHistoryIndexSqliteSmoke({ appDataRoot });
    assert.equal(implicit.success, false);
    assert.match(implicit.error, /explicit temporary dbPath/i);
    assert.equal(fs.existsSync(productionDbPath), false);

    const explicit = runHistoryIndexSqliteSmoke({ appDataRoot, dbPath: productionDbPath });
    assert.equal(explicit.success, false);
    assert.match(explicit.error, /refuses to use the production/i);
    assert.equal(fs.existsSync(productionDbPath), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('history index sqlite smoke rolls back its write probe and preserves schema metadata', (t) => {
  const probe = loadNodeSqlite();
  if (!probe.available) {
    t.skip(`node:sqlite unavailable in this runtime: ${probe.error}`);
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-history-index-smoke-rollback-'));
  const dbPath = path.join(tmpRoot, 'history.sqlite');
  try {
    const seeded = openHistoryIndexDatabase({ dbPath });
    assert.equal(seeded.success, true, seeded.error);
    try {
      seeded.db.exec('PRAGMA user_version = 7');
      seeded.db.exec('CREATE TABLE durable_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      seeded.db.prepare('INSERT INTO durable_probe (value) VALUES (?)').run('preserved');
    } finally {
      seeded.db.close();
    }

    const result = runHistoryIndexSqliteSmoke({ dbPath });
    assert.equal(result.success, true, result.error);
    assert.equal(result.userVersion, 7);

    const reopened = openHistoryIndexDatabase({ dbPath });
    assert.equal(reopened.success, true, reopened.error);
    try {
      assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version, 7);
      assert.equal(reopened.db.prepare('SELECT value FROM durable_probe').get().value, 'preserved');
      assert.equal(
        reopened.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'history_index_smoke'").get().count,
        0,
      );
    } finally {
      reopened.db.close();
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('history index sqlite smoke reports unavailable runtime without throwing', () => {
  const result = runHistoryIndexSqliteSmoke({ dbPath: ':memory:' });
  if (loadNodeSqlite().available) {
    assert.equal(result.success, true, result.error);
  } else {
    assert.equal(result.success, false);
    assert.equal(result.available, false);
    assert.equal(typeof result.error, 'string');
  }
});

test('history index connections enforce verified durability, lock-wait, and security settings', (t) => {
  const probe = loadNodeSqlite();
  if (!probe.available) {
    t.skip(`node:sqlite unavailable in this runtime: ${probe.error}`);
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-history-index-pragmas-'));
  const dbPath = path.join(tmpRoot, 'history.sqlite');
  try {
    const opened = openHistoryIndexDatabase({ dbPath });
    assert.equal(opened.success, true, opened.error);
    try {
      assert.equal(String(opened.db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
      assert.equal(Number(opened.db.prepare('PRAGMA synchronous').get().synchronous), 1);
      assert.equal(Number(opened.db.prepare('PRAGMA foreign_keys').get().foreign_keys), 1);
      assert.equal(Number(opened.db.prepare('PRAGMA busy_timeout').get().timeout), HISTORY_INDEX_BUSY_TIMEOUT_MS);
      assert.equal(Number(opened.db.prepare('PRAGMA trusted_schema').get().trusted_schema), 0);
      if (typeof opened.db.enableDefensive === 'function') {
        opened.db.exec('PRAGMA writable_schema = ON');
        assert.equal(Number(opened.db.prepare('PRAGMA writable_schema').get().writable_schema), 0);
        assert.throws(
          () => opened.db.enableLoadExtension(true),
          /extension loading|disabled at database creation/i,
        );
        assert.throws(
          () => opened.db.prepare('SELECT "flight_fabric_dqs_probe" AS value').get(),
          /no such column/i,
        );
      }
      opened.db.exec('CREATE TABLE durable_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      opened.db.prepare('INSERT INTO durable_probe (value) VALUES (?)').run('persisted');
    } finally {
      opened.db.close();
    }

    const reopened = openHistoryIndexDatabase({ dbPath });
    assert.equal(reopened.success, true, reopened.error);
    try {
      assert.equal(reopened.db.prepare('SELECT value FROM durable_probe').get().value, 'persisted');
      assert.equal(String(reopened.db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
    } finally {
      reopened.db.close();
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('history index corruption helper recognizes SQLite corruption messages', () => {
  assert.equal(isHistoryIndexCorruptionError('SQLITE_NOTADB: file is not a database'), true);
  assert.equal(isHistoryIndexCorruptionError('database disk image is malformed'), true);
  assert.equal(isHistoryIndexCorruptionError('permission denied'), false);
});

test('history index quarantine renames database and sidecars without deleting them', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-history-index-quarantine-'));
  try {
    const dbPath = path.join(tmpRoot, 'history.sqlite');
    fs.writeFileSync(dbPath, 'broken');
    fs.writeFileSync(`${dbPath}-wal`, 'wal');
    fs.writeFileSync(`${dbPath}-shm`, 'shm');

    const result = quarantineHistoryIndexDatabase(dbPath);
    assert.equal(result.quarantined, true, result.error);
    assert.equal(result.moved.length, 3);
    assert.equal(fs.existsSync(dbPath), false);
    assert.equal(fs.existsSync(`${dbPath}-wal`), false);
    assert.equal(fs.existsSync(`${dbPath}-shm`), false);
    for (const movedPath of result.moved) {
      assert.equal(fs.existsSync(movedPath), true);
      assert.match(path.basename(movedPath), /^history\.corrupt-/);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('history index quarantine rolls back a partial rename instead of reopening split state', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-history-index-quarantine-rollback-'));
  const dbPath = path.join(tmpRoot, 'history.sqlite');
  const originalRenameSync = fs.renameSync;
  try {
    fs.writeFileSync(dbPath, 'broken');
    fs.writeFileSync(`${dbPath}-wal`, 'wal');
    fs.writeFileSync(`${dbPath}-shm`, 'shm');
    let renameCount = 0;
    fs.renameSync = (...args) => {
      renameCount += 1;
      if (renameCount === 2) throw new Error('forced quarantine rename failure');
      return originalRenameSync(...args);
    };

    const result = quarantineHistoryIndexDatabase(dbPath);
    assert.equal(result.quarantined, false);
    assert.deepEqual(result.moved, []);
    assert.match(result.error, /forced quarantine rename failure/);
    assert.equal(fs.existsSync(dbPath), true);
    assert.equal(fs.existsSync(`${dbPath}-wal`), true);
    assert.equal(fs.existsSync(`${dbPath}-shm`), true);
  } finally {
    fs.renameSync = originalRenameSync;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
