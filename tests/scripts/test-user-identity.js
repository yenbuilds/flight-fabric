#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const storagePaths = require(resolveBackendRuntimeFile('utils', 'storage-paths.js'));

let passed = 0;
let failed = 0;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

function assertTrue(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected=${expected} actual=${actual}`);
  }
}

function assertNotEqual(actual, expected, message) {
  if (actual === expected) {
    throw new Error(`${message}: both=${actual}`);
  }
}

function withTempEnv(env, fn) {
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    OneDrive: process.env.OneDrive,
  };

  process.env.HOME = env.HOME;
  process.env.USERPROFILE = env.USERPROFILE;
  process.env.APPDATA = env.APPDATA;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  process.env.OneDrive = env.OneDrive;

  try {
    return fn();
  } finally {
    if (prev.HOME === undefined) delete process.env.HOME; else process.env.HOME = prev.HOME;
    if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.USERPROFILE;
    if (prev.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = prev.APPDATA;
    if (prev.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME;
    if (prev.OneDrive === undefined) delete process.env.OneDrive; else process.env.OneDrive = prev.OneDrive;
  }
}

function loadFreshUserIdentityModule() {
  const modulePath = resolveBackendRuntimeFile('utils', 'user-identity.js');
  delete require.cache[modulePath];
  return require(modulePath);
}

function withTestEnv(fn) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-user-identity-'));
  const env = {
    HOME: tmpRoot,
    USERPROFILE: tmpRoot,
    APPDATA: path.join(tmpRoot, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: path.join(tmpRoot, '.config'),
    OneDrive: path.join(tmpRoot, 'OneDrive'),
  };

  try {
    return withTempEnv(env, () => fn({ env, tmpRoot }));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function run() {
  console.log('\nUser Identity Tests\n');

  test('creates the persistent user ID inside app data', () => {
    withTestEnv(({ env }) => {
      const identity = loadFreshUserIdentityModule();
      const userId = identity.getUserId();
      const filePath = storagePaths.getUserIdFilePath(env);

      assertTrue(UUID_V4_RE.test(userId), 'generated user ID should be UUID v4');
      assertEqual(identity.getUserIdFilePath(), filePath, 'resolved user ID file path');
      assertTrue(fs.existsSync(filePath), 'user ID file should exist in app data');
      assertEqual(fs.readFileSync(filePath, 'utf8').trim(), userId, 'persisted user ID should match returned value');
    });
  });

  test('persists the same user ID across module reloads', () => {
    withTestEnv(() => {
      const firstIdentity = loadFreshUserIdentityModule();
      const firstUserId = firstIdentity.getUserId();

      const secondIdentity = loadFreshUserIdentityModule();
      const secondUserId = secondIdentity.getUserId();

      assertEqual(secondUserId, firstUserId, 'user ID should remain stable across reloads');
    });
  });

  test('falls back to a transient ID when persistence path is not writable', () => {
    withTestEnv(({ env }) => {
      const blockingPath = storagePaths.getAppDataRoot(env);
      fs.mkdirSync(path.dirname(blockingPath), { recursive: true });
      fs.writeFileSync(blockingPath, 'not-a-directory', 'utf8');

      const identity = loadFreshUserIdentityModule();
      const userId = identity.getUserId();
      const expectedPath = storagePaths.getUserIdFilePath(env);

      assertTrue(UUID_V4_RE.test(userId), 'transient fallback ID should be UUID v4');
      assertTrue(!fs.existsSync(expectedPath), 'persistent user ID file should not be created when path is blocked');
    });
  });

  console.log(`\nUser identity tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
