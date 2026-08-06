#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function resolveElectronExecutable() {
  const explicitExeIndex = process.argv.indexOf('--exe');
  const explicitExe = explicitExeIndex >= 0 ? process.argv[explicitExeIndex + 1] : '';
  if (explicitExe) {
    const resolved = path.resolve(ROOT, explicitExe);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Explicit Electron executable does not exist: ${resolved}`);
    }
    return resolved;
  }

  try {
    return require(path.join(ROOT, 'electron', 'node_modules', 'electron'));
  } catch (err) {
    throw new Error(`Could not resolve Electron executable. Run npm install in electron/. ${err.message}`);
  }
}

function cleanupProbeFiles(dbPath) {
  for (const suffix of ['', '-shm', '-wal']) {
    try {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {}
  }
}

function parseProbeOutput(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  const lastLine = lines[lines.length - 1] || '';
  try {
    return JSON.parse(lastLine);
  } catch (err) {
    throw new Error(`Electron SQLite probe did not return JSON. Output: ${stdout || '(empty)'}`);
  }
}

const electronExe = resolveElectronExecutable();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-electron-sqlite-'));
const dbPath = path.join(tmpDir, 'probe.sqlite');

const probeCode = `
try {
  const sqlite = require('node:sqlite');
  if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
    throw new Error('node:sqlite did not expose DatabaseSync');
  }
  const db = new sqlite.DatabaseSync(process.env.FF_SQLITE_PROBE_DB, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout: 5000,
  });
  db.enableDefensive(true);
  db.enableLoadExtension(false);
  db.exec('PRAGMA trusted_schema = OFF');
  db.exec('PRAGMA writable_schema = ON');
  let extensionLoadingRejected = false;
  try { db.enableLoadExtension(true); } catch { extensionLoadingRejected = true; }
  let doubleQuotedStringRejected = false;
  try { db.prepare('SELECT "flight_fabric_dqs_probe" AS value').get(); } catch { doubleQuotedStringRejected = true; }
  db.exec('PRAGMA user_version = 7');
  db.exec('CREATE TABLE IF NOT EXISTS electron_sqlite_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO electron_sqlite_probe (value) VALUES (?)').run('ok');
  const row = db.prepare('SELECT value FROM electron_sqlite_probe ORDER BY id DESC LIMIT 1').get();
  const version = db.prepare('PRAGMA user_version').get();
  const writableSchema = db.prepare('PRAGMA writable_schema').get();
  const trustedSchema = db.prepare('PRAGMA trusted_schema').get();
  db.close();
  console.log(JSON.stringify({
    ok: true,
    value: row && row.value,
    userVersion: version && version.user_version,
    writableSchema: writableSchema && writableSchema.writable_schema,
    trustedSchema: trustedSchema && trustedSchema.trusted_schema,
    extensionLoadingRejected,
    doubleQuotedStringRejected,
    node: process.version,
    electron: process.versions.electron || null,
    modules: process.versions.modules || null,
    sqlite: process.versions.sqlite || null
  }));
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(2);
}
`;

try {
  const result = childProcess.spawnSync(electronExe, ['-e', probeCode], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      FF_SQLITE_PROBE_DB: dbPath,
    },
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `Electron SQLite probe exited ${result.status}\nSTDOUT:\n${result.stdout || ''}\nSTDERR:\n${result.stderr || ''}`,
    );
  }

  const payload = parseProbeOutput(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.value, 'ok');
  assert.equal(payload.userVersion, 7);
  assert.equal(payload.writableSchema, 0, 'defensive mode should reject writable_schema');
  assert.equal(payload.trustedSchema, 0, 'trusted schemas should be disabled');
  assert.equal(payload.extensionLoadingRejected, true, 'extension loading must remain disabled');
  assert.equal(payload.doubleQuotedStringRejected, true, 'double-quoted string literals must remain disabled');
  assert.ok(payload.electron, 'probe should run inside Electron');
  assert.ok(payload.sqlite, 'probe should report the embedded SQLite version');
  assert.equal(fs.existsSync(dbPath), true, 'probe database should be created on disk');

  console.log('Electron node:sqlite probe passed');
  console.log(`Electron ${payload.electron}, Node ${payload.node}, SQLite ${payload.sqlite}, modules ${payload.modules}`);
} finally {
  cleanupProbeFiles(dbPath);
  try {
    fs.rmdirSync(tmpDir);
  } catch {}
}
