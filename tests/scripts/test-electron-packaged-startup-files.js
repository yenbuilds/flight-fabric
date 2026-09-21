#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { listProfiles, resolveProfile } = require('../../scripts/release-profile-loader');
const { snapshotBackendRuntimeProfile } = require('../../electron/build-electron');
const {
  REQUIRED_PACKAGED_BACKEND_STARTUP_FILES,
  assertPackagedBackendStartupFiles,
  findMissingPackagedBackendStartupFiles,
} = require('./electron-packaged-startup-files');

test('packaged startup contract covers every cross-root backend dependency', () => {
  assert.deepEqual(REQUIRED_PACKAGED_BACKEND_STARTUP_FILES, [
    'core/simbridge.js',
    'autotaxi/session.js',
    'autotaxi/controller.js',
    'autotaxi/route.js',
    'telemetry-provider/cdu/provider.js',
    'utils/storage-paths.js',
    'utils/safe-fs.js',
    'utils/flight-logs-dir.js',
    'aircraft/aircraft-profile-identity.js',
  ]);
});

test('packaged startup contract reports the exact missing file', () => {
  const missing = findMissingPackagedBackendStartupFiles(
    path.join('virtual', 'resources', 'backend'),
    (candidatePath) => !candidatePath.endsWith(path.join('utils', 'safe-fs.js')),
  );

  assert.deepEqual(missing, ['utils/safe-fs.js']);
});

test('packaged startup succeeds without the offline-only autotaxi recorder', () => {
  assert.doesNotThrow(() => assertPackagedBackendStartupFiles(
    path.join('virtual', 'resources', 'backend'),
    { existsSync: candidate => !candidate.endsWith(path.join('autotaxi', 'recorder.js')) },
  ));
});

test('every release edition excludes the autotaxi recorder while retaining flight-control modules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-autotaxi-package-'));
  const controlModules = ['session.js', 'controller.js', 'route.js'];
  try {
    fs.mkdirSync(path.join(root, 'autotaxi'));
    for (const name of [...controlModules, 'recorder.js']) {
      fs.writeFileSync(path.join(root, 'autotaxi', name), 'module.exports = {};\n');
    }
    for (const name of listProfiles()) {
      const profile = resolveProfile(name);
      // Exercise the real staging inventory and inherited filters against a
      // small compiled-runtime fixture; no build or installed app is needed.
      const inventory = snapshotBackendRuntimeProfile(root, {
        ...profile,
        include: { ...profile.include, backend: [], backend_dirs: ['autotaxi'] },
      });
      assert.equal(inventory.has('autotaxi/recorder.js'), false, `${name}: diagnostic writer must not ship`);
      for (const file of controlModules) {
        assert.equal(inventory.has(`autotaxi/${file}`), true, `${name}: ${file} remains required`);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('packaged startup preflight fails clearly before launch', () => {
  assert.throws(
    () => assertPackagedBackendStartupFiles(
      path.join('virtual', 'resources', 'backend'),
      {
        existsSync: (candidatePath) => !candidatePath.endsWith(
          path.join('aircraft', 'aircraft-profile-identity.js'),
        ),
        label: 'Virgin installer backend',
      },
    ),
    {
      message: (
        'Virgin installer backend is missing required startup files: '
        + 'aircraft/aircraft-profile-identity.js'
      ),
    },
  );
});

test('all packaged release probes consume the shared startup contract', () => {
  for (const fileName of [
    'test-electron-packaged-smoke.js',
    'test-electron-packaged-backend-launch.js',
    'test-electron-installer-payload.js',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, fileName), 'utf8');
    assert.match(
      source,
      /require\(['"]\.\/electron-packaged-startup-files['"]\)/,
      `${fileName} must use the shared packaged-startup contract`,
    );
  }
});
