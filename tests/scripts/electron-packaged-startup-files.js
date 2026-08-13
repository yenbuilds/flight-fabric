'use strict';

const fs = require('node:fs');
const path = require('node:path');

// These files cross the app.asar/resources boundary during packaged startup.
// Most are loaded through constructed paths, so a static relative-require scan
// of the backend artifact cannot prove that electron-builder included them.
const REQUIRED_PACKAGED_BACKEND_STARTUP_FILES = Object.freeze([
  'core/simbridge.js',
  'utils/storage-paths.js',
  'utils/safe-fs.js',
  'utils/flight-logs-dir.js',
  'aircraft/aircraft-profile-identity.js',
]);

function resolvePackagedBackendStartupFile(backendRoot, relativePath) {
  return path.join(backendRoot, ...relativePath.split('/'));
}

function findMissingPackagedBackendStartupFiles(
  backendRoot,
  existsSync = fs.existsSync,
) {
  return REQUIRED_PACKAGED_BACKEND_STARTUP_FILES.filter((relativePath) => (
    !existsSync(resolvePackagedBackendStartupFile(backendRoot, relativePath))
  ));
}

function assertPackagedBackendStartupFiles(
  backendRoot,
  { existsSync = fs.existsSync, label = 'Packaged backend' } = {},
) {
  const missing = findMissingPackagedBackendStartupFiles(backendRoot, existsSync);
  if (missing.length > 0) {
    throw new Error(
      `${label} is missing required startup files: ${missing.join(', ')}`,
    );
  }
}

module.exports = {
  REQUIRED_PACKAGED_BACKEND_STARTUP_FILES,
  assertPackagedBackendStartupFiles,
  findMissingPackagedBackendStartupFiles,
  resolvePackagedBackendStartupFile,
};
