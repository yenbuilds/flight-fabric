#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(
  ROOT,
  'backend',
  'telemetry-provider',
  'rust-simconnect-sidecar',
  'Cargo.toml',
);
const BUNDLED_CONNECTORS_DIR = path.join(
  ROOT,
  'backend',
  'telemetry-provider',
  'sdk-connectors',
);

function candidateCargoPaths() {
  const names = process.platform === 'win32' ? ['cargo.exe', 'cargo.cmd', 'cargo'] : ['cargo'];
  const dirs = [];
  const cargoHome = process.env.CARGO_HOME;
  if (cargoHome) dirs.push(path.join(cargoHome, 'bin'));
  if (process.env.USERPROFILE) dirs.push(path.join(process.env.USERPROFILE, '.cargo', 'bin'));
  if (process.env.HOME) dirs.push(path.join(process.env.HOME, '.cargo', 'bin'));
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) dirs.push(dir);
  }

  const seen = new Set();
  const paths = [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      const key = candidate.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        paths.push(candidate);
      }
    }
  }
  return paths;
}

function resolveCargo() {
  for (const candidate of candidateCargoPaths()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'cargo.exe' : 'cargo';
}

const cargo = resolveCargo();
const connectorFiles = fs.existsSync(BUNDLED_CONNECTORS_DIR)
  ? fs.readdirSync(BUNDLED_CONNECTORS_DIR)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort()
    .map((name) => path.join(BUNDLED_CONNECTORS_DIR, name))
  : [];
const testTargets = connectorFiles.length > 0 ? connectorFiles : [null];

for (const connectorFile of testTargets) {
  if (connectorFile) {
    console.log(`[rust-sidecar-test] Validating connector ${path.relative(ROOT, connectorFile)}`);
  }
  const result = spawnSync(cargo, ['test', '--manifest-path', MANIFEST_PATH], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...(connectorFile ? { FF_TEST_SDK_CONNECTOR_FILE: connectorFile } : {}),
    },
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`[rust-sidecar-test] Failed to run Cargo: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}
