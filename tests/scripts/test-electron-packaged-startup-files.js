#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  REQUIRED_PACKAGED_BACKEND_STARTUP_FILES,
  assertPackagedBackendStartupFiles,
  findMissingPackagedBackendStartupFiles,
} = require('./electron-packaged-startup-files');

test('packaged startup contract covers every cross-root backend dependency', () => {
  assert.deepEqual(REQUIRED_PACKAGED_BACKEND_STARTUP_FILES, [
    'core/simbridge.js',
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
