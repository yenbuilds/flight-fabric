#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BUILD_SCRIPT = path.join(ROOT, 'scripts', 'build-backend-runtime.js');
const RUST_SIDECAR_BINARY_NAME = process.platform === 'win32'
  ? 'ff-rust-simconnect-sidecar.exe'
  : 'ff-rust-simconnect-sidecar';
const DIST_RUNTIME_REQUIRED_PATHS = [
  path.join(ROOT, 'dist', 'backend', 'core', 'simbridge-core.js'),
  path.join(ROOT, 'dist', 'backend', 'telemetry-provider', RUST_SIDECAR_BINARY_NAME),
  path.join(ROOT, 'dist', 'shared', 'flight-phases.js'),
  path.join(ROOT, 'dist', 'shared', 'app-settings-shared.js'),
];
let ensuredDistRuntime = false;

function hasCompleteDistRuntime() {
  return DIST_RUNTIME_REQUIRED_PATHS.every((filePath) => fs.existsSync(filePath));
}

function buildBackendRuntime() {
  execFileSync(process.execPath, [BUILD_SCRIPT], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  ensuredDistRuntime = true;
}

function ensureBackendRuntime() {
  if (hasCompleteDistRuntime()) {
    ensuredDistRuntime = true;
    return;
  }

  if (!ensuredDistRuntime) {
    buildBackendRuntime();
  }

  if (!hasCompleteDistRuntime()) {
    throw new Error('Backend dist runtime is unavailable after build-backend-runtime.js');
  }
}

function ensureBackendRuntimeFile(filePath) {
  if (fs.existsSync(filePath)) return true;
  buildBackendRuntime();
  if (!hasCompleteDistRuntime()) {
    throw new Error('Backend dist runtime is unavailable after build-backend-runtime.js');
  }
  return fs.existsSync(filePath);
}

function resolveBackendRuntimeFile(...segments) {
  ensureBackendRuntime();
  if (segments[0] === 'test-support') {
    const distTestSupportPath = path.join(ROOT, 'dist', 'tests', 'support', ...segments.slice(1));
    if (ensureBackendRuntimeFile(distTestSupportPath)) return distTestSupportPath;
  }
  if (segments[0] === 'test') {
    const distBackendTestPath = path.join(ROOT, 'dist', 'tests', 'backend', ...segments.slice(1));
    if (ensureBackendRuntimeFile(distBackendTestPath)) return distBackendTestPath;
  }
  const distPath = path.join(ROOT, 'dist', 'backend', ...segments);
  if (ensureBackendRuntimeFile(distPath)) return distPath;
  throw new Error(`Unable to locate dist backend runtime file: ${distPath}`);
}

function resolveBackendRuntimeRoot() {
  const entryPath = resolveBackendRuntimeFile('core', 'simbridge.js');
  return path.dirname(path.dirname(entryPath));
}

function resolveBackendEntry() {
  return resolveBackendRuntimeFile('core', 'simbridge.js');
}

module.exports = {
  ROOT,
  DIST_RUNTIME_REQUIRED_PATHS,
  ensureBackendRuntime,
  hasCompleteDistRuntime,
  resolveBackendEntry,
  resolveBackendRuntimeFile,
  resolveBackendRuntimeRoot,
};
