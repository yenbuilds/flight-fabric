'use strict';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const {
  ensureDirExists,
  getAppDataRoot,
} = require('../utils/storage-paths.js') as {
  ensureDirExists: (dirPath: string | null | undefined) => string | null | undefined;
  getAppDataRoot: (_env?: NodeJS.ProcessEnv | Record<string, string | undefined>) => string;
};

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;
type AnyRecord = Record<string, any>;

type RuntimeProbe =
  | { available: true; runtime: 'node:sqlite'; sqlite: AnyRecord }
  | { available: false; runtime: 'node:sqlite'; error: string };

type ResolveDatabasePathOptions = {
  appDataRoot?: string;
  dbPath?: string;
  env?: EnvLike;
};

type OpenDatabaseOptions = ResolveDatabasePathOptions;

type OpenDatabaseResult =
  | { success: true; available: true; runtime: 'node:sqlite'; db: AnyRecord; dbPath: string }
  | { success: false; available: boolean; runtime: 'node:sqlite'; dbPath: string; error: string };

type SmokeResult =
  | { success: true; available: true; runtime: 'node:sqlite'; dbPath: string; userVersion: number | null }
  | { success: false; available: boolean; runtime: 'node:sqlite'; dbPath: string; error: string };

const HISTORY_INDEX_DB_FILE_NAME = 'flight-fabric-history-index.sqlite';
const HISTORY_INDEX_SIDECAR_SUFFIXES = ['', '-shm', '-wal'];
const HISTORY_INDEX_BUSY_TIMEOUT_MS = 5000;

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || 'Unknown error');
}

function loadNodeSqlite(): RuntimeProbe {
  try {
    const sqlite = require('node:sqlite') as AnyRecord;
    if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
      return {
        available: false,
        runtime: 'node:sqlite',
        error: 'node:sqlite did not expose DatabaseSync',
      };
    }
    if (typeof sqlite.DatabaseSync.prototype?.enableDefensive !== 'function') {
      return {
        available: false,
        runtime: 'node:sqlite',
        error: 'node:sqlite does not support the required defensive connection mode',
      };
    }
    return { available: true, runtime: 'node:sqlite', sqlite };
  } catch (err) {
    return {
      available: false,
      runtime: 'node:sqlite',
      error: getErrorMessage(err),
    };
  }
}

function resolveHistoryIndexDatabasePath(options: ResolveDatabasePathOptions = {}): string {
  if (typeof options.dbPath === 'string' && options.dbPath.trim()) {
    if (options.dbPath === ':memory:') return options.dbPath;
    return path.resolve(options.dbPath);
  }
  const appDataRoot = typeof options.appDataRoot === 'string' && options.appDataRoot.trim()
    ? options.appDataRoot
    : getAppDataRoot(options.env);
  return path.join(appDataRoot, HISTORY_INDEX_DB_FILE_NAME);
}

function readPragmaValue(row: AnyRecord | null | undefined, key: string): unknown {
  if (!row || typeof row !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  const values = Object.values(row);
  return values.length === 1 ? values[0] : undefined;
}

function openNodeSqliteDatabase(sqlite: AnyRecord, dbPath: string): AnyRecord {
  return new sqlite.DatabaseSync(dbPath, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout: HISTORY_INDEX_BUSY_TIMEOUT_MS,
  });
}

function configureHistoryIndexConnection(db: AnyRecord, dbPath: string): void {
  if (typeof db.enableDefensive === 'function') db.enableDefensive(true);
  if (typeof db.enableLoadExtension === 'function') db.enableLoadExtension(false);

  db.exec('PRAGMA trusted_schema = OFF');
  // nosemgrep: ff.sqlite.dynamic-sql-construction -- this is a fixed application-owned integer constant.
  db.exec(`PRAGMA busy_timeout = ${HISTORY_INDEX_BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA foreign_keys = ON');

  if (dbPath !== ':memory:') {
    const journalRow = db.prepare('PRAGMA journal_mode = WAL').get();
    const journalMode = String(readPragmaValue(journalRow, 'journal_mode') || '').toLowerCase();
    if (journalMode !== 'wal') {
      throw new Error(`History index could not enable WAL journal mode (SQLite reported ${journalMode || 'unknown'})`);
    }
  }

  // This database is a rebuildable projection of the authoritative flight
  // bundles. WAL + NORMAL protects committed transactions while avoiding an
  // fsync on every derived-cache commit.
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA wal_autocheckpoint = 1000');

  const busyTimeout = Number(readPragmaValue(db.prepare('PRAGMA busy_timeout').get(), 'timeout'));
  const foreignKeys = Number(readPragmaValue(db.prepare('PRAGMA foreign_keys').get(), 'foreign_keys'));
  const synchronous = Number(readPragmaValue(db.prepare('PRAGMA synchronous').get(), 'synchronous'));
  const trustedSchema = Number(readPragmaValue(db.prepare('PRAGMA trusted_schema').get(), 'trusted_schema'));
  if (busyTimeout !== HISTORY_INDEX_BUSY_TIMEOUT_MS) {
    throw new Error(`History index busy timeout verification failed (SQLite reported ${busyTimeout})`);
  }
  if (foreignKeys !== 1) {
    throw new Error('History index foreign-key enforcement could not be enabled');
  }
  if (synchronous !== 1) {
    throw new Error(`History index NORMAL synchronous mode verification failed (SQLite reported ${synchronous})`);
  }
  if (trustedSchema !== 0) {
    throw new Error(`History index trusted-schema hardening failed (SQLite reported ${trustedSchema})`);
  }
}

function openHistoryIndexDatabase(options: OpenDatabaseOptions = {}): OpenDatabaseResult {
  const dbPath = resolveHistoryIndexDatabasePath(options);
  const probe = loadNodeSqlite();
  if (probe.available !== true) {
    return {
      success: false,
      available: false,
      runtime: 'node:sqlite',
      dbPath,
      error: probe.error,
    };
  }

  let db: AnyRecord | null = null;
  try {
    if (dbPath !== ':memory:') {
      ensureDirExists(path.dirname(dbPath));
    }
    db = openNodeSqliteDatabase(probe.sqlite, dbPath);
    configureHistoryIndexConnection(db, dbPath);
    return {
      success: true,
      available: true,
      runtime: 'node:sqlite',
      db,
      dbPath,
    };
  } catch (err) {
    try {
      db?.close();
    } catch {}
    return {
      success: false,
      available: true,
      runtime: 'node:sqlite',
      dbPath,
      error: getErrorMessage(err),
    };
  }
}

function isHistoryIndexCorruptionError(error: unknown): boolean {
  const text = getErrorMessage(error).toLowerCase();
  return text.includes('sqlite_corrupt')
    || text.includes('sqlite_notadb')
    || text.includes('database disk image is malformed')
    || text.includes('file is not a database')
    || text.includes('not a database');
}

function createQuarantinePath(filePath: string, now: Date = new Date()): string {
  const dir = path.dirname(filePath);
  const parsed = path.parse(filePath);
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const base = path.join(dir, `${parsed.name}.corrupt-${timestamp}${parsed.ext}`);
  if (!fs.existsSync(base)) return base;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(dir, `${parsed.name}.corrupt-${timestamp}-${index}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${parsed.name}.corrupt-${timestamp}-${Date.now()}${parsed.ext}`);
}

function quarantineHistoryIndexDatabase(dbPath: unknown): { quarantined: boolean; moved: string[]; error?: string } {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    return { quarantined: false, moved: [] };
  }

  const movedPairs: Array<{ sourcePath: string; targetPath: string }> = [];
  try {
    const quarantineBasePath = createQuarantinePath(dbPath);
    for (const suffix of HISTORY_INDEX_SIDECAR_SUFFIXES) {
      const sourcePath = `${dbPath}${suffix}`;
      if (!fs.existsSync(sourcePath)) continue;
      const targetPath = `${quarantineBasePath}${suffix}`;
      fs.renameSync(sourcePath, targetPath);
      movedPairs.push({ sourcePath, targetPath });
    }
    return { quarantined: movedPairs.length > 0, moved: movedPairs.map((pair) => pair.targetPath) };
  } catch (err) {
    const rollbackErrors: string[] = [];
    for (const pair of [...movedPairs].reverse()) {
      try {
        if (fs.existsSync(pair.targetPath) && !fs.existsSync(pair.sourcePath)) {
          fs.renameSync(pair.targetPath, pair.sourcePath);
        }
      } catch (rollbackErr) {
        rollbackErrors.push(getErrorMessage(rollbackErr));
      }
    }
    const stillMoved = movedPairs
      .map((pair) => pair.targetPath)
      .filter((targetPath) => fs.existsSync(targetPath));
    const baseError = getErrorMessage(err);
    return {
      quarantined: stillMoved.length > 0,
      moved: stillMoved,
      error: rollbackErrors.length > 0
        ? `${baseError}; quarantine rollback failed: ${rollbackErrors.join('; ')}`
        : baseError,
    };
  }
}

function readUserVersion(db: AnyRecord): number | null {
  const row = db.prepare('PRAGMA user_version').get();
  const value = row && typeof row === 'object' ? row.user_version : null;
  return Number.isFinite(value) ? Number(value) : null;
}

function runHistoryIndexSqliteSmoke(options: OpenDatabaseOptions = {}): SmokeResult {
  const opened = openHistoryIndexDatabase(options);
  if (opened.success !== true) {
    return {
      success: false,
      available: opened.available,
      runtime: 'node:sqlite',
      dbPath: opened.dbPath,
      error: opened.error,
    };
  }

  try {
    opened.db.exec('PRAGMA user_version = 0');
    opened.db.exec('CREATE TABLE IF NOT EXISTS history_index_smoke (id INTEGER PRIMARY KEY, checked_at_ms INTEGER NOT NULL)');
    opened.db.prepare('INSERT INTO history_index_smoke (checked_at_ms) VALUES (?)').run(Date.now());
    const userVersion = readUserVersion(opened.db);
    return {
      success: true,
      available: true,
      runtime: 'node:sqlite',
      dbPath: opened.dbPath,
      userVersion,
    };
  } catch (err) {
    return {
      success: false,
      available: true,
      runtime: 'node:sqlite',
      dbPath: opened.dbPath,
      error: getErrorMessage(err),
    };
  } finally {
    try {
      opened.db.close();
    } catch {}
  }
}

module.exports = {
  HISTORY_INDEX_BUSY_TIMEOUT_MS,
  HISTORY_INDEX_DB_FILE_NAME,
  configureHistoryIndexConnection,
  createQuarantinePath,
  isHistoryIndexCorruptionError,
  loadNodeSqlite,
  openHistoryIndexDatabase,
  quarantineHistoryIndexDatabase,
  resolveHistoryIndexDatabasePath,
  runHistoryIndexSqliteSmoke,
};

export {};
