#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIST = path.join(ROOT, 'frontend-dist');
const FRONTEND_MAIN = path.join(FRONTEND_DIST, 'main.js');
const FRONTEND_INDEX = path.join(FRONTEND_DIST, 'index.html');
const FRONTEND_TAILWIND = path.join(FRONTEND_DIST, 'tailwind.css');
const RUST_SIDECAR_BINARY_NAME = process.platform === 'win32'
  ? 'ff-rust-simconnect-sidecar.exe'
  : 'ff-rust-simconnect-sidecar';
const BACKEND_DIST_MARKERS = [
  path.join(ROOT, 'dist', 'backend', 'core', 'simbridge-core.js'),
  path.join(ROOT, 'dist', 'backend', 'core', 'http-server.js'),
  path.join(ROOT, 'dist', 'backend', 'telemetry-provider', RUST_SIDECAR_BINARY_NAME),
  path.join(ROOT, 'dist', 'shared', 'flight-phases.js'),
];
const OURAIRPORTS_DIR = path.join(ROOT, 'backend', 'data-sync', 'data', 'ourairports');
const OURAIRPORTS_MARKERS = [
  path.join(OURAIRPORTS_DIR, 'airports.csv'),
  path.join(OURAIRPORTS_DIR, 'runways.csv'),
  path.join(OURAIRPORTS_DIR, 'manifest.json'),
];

const BACKEND_INPUTS = [
  path.join(ROOT, 'backend'),
  path.join(ROOT, 'shared'),
  path.join(ROOT, 'scripts', 'build-backend-runtime.js'),
  path.join(ROOT, 'tsconfig.backend.runtime.json'),
  path.join(ROOT, 'package.json'),
];

const FRONTEND_INPUTS = [
  path.join(ROOT, 'frontend'),
  path.join(ROOT, 'tailwind.config.js'),
  path.join(ROOT, 'shared', 'app-settings-shared.js'),
  path.join(ROOT, 'shared', 'flight-phases.js'),
];

function log(message) {
  console.log(`[prepare-start-runtime] ${message}`);
}

function shouldSkipDir(name) {
  return name === '.git'
    || name === 'node_modules'
    || name === 'dist'
    || name === 'frontend-dist'
    || name === '__pycache__'
    || name === 'target';
}

function shouldSkipFile(filePath) {
  const base = path.basename(filePath).toLowerCase();
  return base.endsWith('.log')
    || base.endsWith('.tmp')
    || base.endsWith('.bak')
    || base.endsWith('.map')
    || base.endsWith('.pyc')
    || base.endsWith('.pyo');
}

function latestMtimeMs(targetPath) {
  if (!fs.existsSync(targetPath)) return 0;
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  let latest = stat.mtimeMs;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.isDirectory() && shouldSkipDir(entry.name)) continue;
    const childPath = path.join(targetPath, entry.name);
    if (!entry.isDirectory() && shouldSkipFile(childPath)) continue;
    latest = Math.max(latest, latestMtimeMs(childPath));
  }
  return latest;
}

function oldestExistingMtimeMs(outputPaths) {
  let oldest = Number.POSITIVE_INFINITY;
  for (const outputPath of outputPaths) {
    if (!fs.existsSync(outputPath)) return 0;
    oldest = Math.min(oldest, fs.statSync(outputPath).mtimeMs);
  }
  return Number.isFinite(oldest) ? oldest : 0;
}

function isOutputStale(inputPaths, outputPaths) {
  const latestInput = inputPaths.reduce((latest, inputPath) => Math.max(latest, latestMtimeMs(inputPath)), 0);
  const oldestOutput = oldestExistingMtimeMs(outputPaths);
  return oldestOutput <= 0 || latestInput > oldestOutput;
}

function runNodeScript(scriptPath, args = []) {
  execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

function getMissingOrEmptyFiles(filePaths) {
  return filePaths.filter((filePath) => {
    if (!fs.existsSync(filePath)) return true;
    try {
      return fs.statSync(filePath).size <= 0;
    } catch {
      return true;
    }
  });
}

function ensureRequiredOurAirportsData() {
  const missing = getMissingOrEmptyFiles(OURAIRPORTS_MARKERS);
  if (missing.length === 0) {
    log('Required OurAirports data is present.');
    return;
  }

  const labels = missing.map((filePath) => path.relative(ROOT, filePath).replace(/\\/g, '/'));
  throw new Error(
    `Required OurAirports data missing or empty: ${labels.join(', ')}. `
    + 'Run npm run data:sync:required explicitly, then retry.',
  );
}

function main() {
  ensureRequiredOurAirportsData();

  if (process.env.FF_START_SIMBRIDGE_SKIP_BUILD === '1') {
    log('Skipping runtime freshness check because FF_START_SIMBRIDGE_SKIP_BUILD=1.');
    return;
  }

  if (isOutputStale(BACKEND_INPUTS, BACKEND_DIST_MARKERS)) {
    log('Backend runtime is stale; rebuilding dist/backend.');
    runNodeScript(path.join(ROOT, 'scripts', 'build-backend-runtime.js'));
  } else {
    log('Backend runtime is current.');
  }

  if (isOutputStale(FRONTEND_INPUTS, [FRONTEND_INDEX, FRONTEND_MAIN, FRONTEND_TAILWIND])) {
    log('Frontend bundle is stale; rebuilding frontend-dist.');
    runNodeScript(path.join(ROOT, 'frontend', 'build.js'));
  } else {
    log('Frontend bundle is current.');
  }
}

main();
