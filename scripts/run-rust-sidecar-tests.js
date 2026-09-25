#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveCargo } = require('./rust-toolchain');

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
