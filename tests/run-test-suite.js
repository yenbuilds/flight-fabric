#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, getRepoScratchAppData, getRepoScratchPath } = require('../scripts/repo-scratch');

const TEST_STEPS = [
  ['node', ['--test', 'tests/scripts/test-run-test-suite-isolation.js']],
  ['npm', ['run', 'build:backend:runtime']],
  ['npm', ['run', 'test:backend:companions']],
  ['npm', ['run', 'test:cabin-announcements']],
  ['npm', ['run', 'test:backend:compiled-units']],
  ['node', ['--test', 'dist/backend/landing/landing-replay-analysis.test.js']],
  ['node', [
    '--test',
    'dist/backend/flight-recording/flight-analysis-rescore-sidecar.test.js',
    'dist/backend/flight-recording/recording-bundle-layout.test.js',
    'dist/backend/flight-recording/flat-flight-log-migration.test.js',
  ]],
  ['node', [
    '--test',
    'dist/backend/history-index/sqlite-runtime.test.js',
    'dist/backend/history-index/sqlite-schema.test.js',
    'dist/backend/history-index/sqlite-doctor.test.js',
    'dist/backend/history-index/source-identity.test.js',
    'dist/backend/history-index/history-index-store.test.js',
    'dist/backend/history-index/history-summary-sidecar.test.js',
    'dist/backend/history-index/history-index-coordinator.test.js',
    'dist/backend/history-index/timeline-flight-index.test.js',
  ]],
  ['node', ['dist/backend/aircraft/aircraft-profile-resolution.test.js']],
  ['node', ['dist/backend/aircraft/aircraft-specific-state.test.js']],
  ['node', ['dist/backend/core/simbridge-runtime-state.test.js']],
  ['node', ['dist/backend/flight-recording/recording-path-guard.test.js']],
  ['node', ['dist/backend/telemetry-provider/simconnect-frame-builder.test.js']],
  ['node', ['dist/backend/utils/safe-fs.test.js']],
  ['node', ['scripts/validate-frame-contract.js']],
  ['npm', ['run', 'validate:simvar-units']],
  ['node', ['scripts/validate-profile-completeness.js']],
  ['node', ['tests/scripts/test-aircraft-profile-provenance.js']],
  ['node', ['tests/scripts/test-architecture-guards.js']],
  ['node', ['tests/scripts/test-contract-drift.js']],
  ['node', ['tests/scripts/test-type-drift.js']],
  ['node', ['tests/scripts/test-package-drift.js']],
  ['npm', ['run', 'test:repo-hygiene']],
  ['npm', ['run', 'test:safety-notices']],
  ['node', ['tests/scripts/test-dry-guards.js']],
  ['node', ['tests/scripts/test-io-boundaries.js']],
  ['node', ['tests/scripts/test-windows-process-cleanup.js']],
  ['node', ['tests/scripts/test-runtime-owner-lock.js']],
  ['node', ['tests/scripts/test-shutdown-smoke.js']],
  ['node', ['tests/scripts/test-aircraft-visuals.js']],
  ['node', ['tests/scripts/test-vue-stores.js']],
  ['node', ['tests/scripts/test-vue-components.js']],
  ['node', ['tests/scripts/test-vue-interactions.js']],
  ['npm', ['run', 'test:voice']],
  ['node', ['tests/scripts/test-telemetry-ui.js']],
  ['node', ['tests/scripts/test-ws-connection-bootstrap.js']],
  ['node', ['tests/scripts/test-pmdg-737-preview.js']],
  ['node', ['tests/scripts/test-approach-profile-renderer.js']],
  ['node', ['tests/scripts/test-no-hardcoded-aviation-data.js']],
  ['node', ['tests/scripts/test-schema-coverage.js']],
  ['node', ['tests/scripts/test-critical-csv-event-contract.js']],
  ['node', ['tests/scripts/test-csv-read-guard-policy.js']],
  ['node', ['--test', 'dist/backend/flight-recording/post-flight-insights-summary.test.js']],
  ['node', ['--test', 'dist/backend/landing/rollout-analysis.test.js']],
  ['node', ['dist/backend/flight-recording/schema-field-map.test.js']],
  ['node', ['tests/scripts/test-timeline-generator.js']],
  ['node', ['tests/scripts/test-analysis-parity.js']],
  ['node', ['tests/scripts/test-csv-roundtrip.js']],
  ['node', ['tests/scripts/test-v1-assist-columns.js']],
  ['node', ['tests/scripts/test-aircraft-profile-loader.js']],
  ['node', ['tests/scripts/test-flaps.js']],
  ['node', ['tests/scripts/test-stability-runner.js']],
  ['node', ['tests/scripts/test-profile-autodetect.js']],
  ['node', ['tests/scripts/test-helpers.js']],
  ['node', ['tests/scripts/test-landing.js']],
  ['node', ['tests/scripts/test-landing-distance.js']],
  ['node', ['tests/scripts/test-landing-runner.js']],
  ['node', ['tests/scripts/test-gear-spoilers.js']],
  ['node', ['tests/scripts/test-go-around-detection.js']],
  ['node', ['tests/scripts/test-quickpeek-fuel-scan.js']],
  ['node', ['tests/scripts/test-monte-carlo-runners.js']],
  ['node', ['tests/scripts/test-stall-timeline-coordinates.js']],
  ['node', ['dist/backend/lifecycle/flight-lifecycle.test.js']],
  ['node', ['dist/backend/lifecycle/flight-type-classifier.test.js']],
  ['node', ['dist/backend/flight-recording/flight-csv-writer.test.js']],
  ['node', ['dist/backend/landing/airport-geometry-service.test.js']],
  ['node', ['dist/backend/landing/msfs-facilities-geometry-provider.test.js']],
  ['node', ['dist/backend/landing/runway-database.test.js']],
  ['node', ['dist/backend/landing/airport-search.test.js']],
  ['node', ['dist/backend/utils/aviation-frames.test.js']],
  ['node', ['tests/scripts/test-core-modules.js']],
  ['node', ['tests/scripts/test-user-settings.js']],
  ['node', ['tests/scripts/test-storage-paths.js']],
  ['node', ['tests/scripts/test-http-server-theme-assets.js']],
  ['node', ['tests/scripts/test-user-identity.js']],
  ['node', ['--test', 'tests/scripts/test-electron-release-output-failure-guard.js']],
  ['node', ['electron/test-electron.js']],
  ['node', ['--test', 'tests/scripts/test-electron-packaged-startup-files.js']],
  ['node', ['tests/scripts/test-surface-normalizer.js']],
  ['node', ['tests/scripts/test-vre-evaluator.js']],
  ['node', ['dist/tests/backend/real-flight-replay.test.js']],
  ['node', ['dist/backend/landing/landing-scoring-wiring.test.js']],
  ['node', ['dist/backend/lifecycle/tick-frame.test.js']],
  ['node', ['dist/backend/core/config.test.js']],
  ['node', ['--test', 'dist/backend/aircraft/aircraft-control-service.test.js']],
  ['node', ['--test', 'dist/backend/aircraft/aircraft-integrations/registry.test.js']],
  ['node', ['--test', 'dist/backend/aircraft/aircraft-integrations/pmdg-737/adapter.test.js']],
  ['node', ['--test', 'dist/backend/aircraft/aircraft-integrations/pmdg-777/adapter.test.js']],
  ['node', ['--test', 'dist/backend/core/client-message-handler.aircraft-control.test.js']],
  ['node', ['dist/backend/telemetry-provider/lvar-sidecar-bridge.test.js']],
  ['node', ['--test', 'dist/backend/telemetry-provider/source-overlays.test.js']],
  ['node', ['dist/backend/telemetry-provider/simconnect-telemetry-provider.test.js']],
  ['node', ['--test', 'dist/backend/telemetry-provider/pmdg-737-sdk-integration.test.js']],
  ['node', ['--test', 'dist/backend/telemetry-provider/pmdg-777-sdk-integration.test.js']],
  ['npm', ['run', 'test:rust-sidecar']],
  ['npm', ['run', 'test:simbridge-mock']],
  ['node', ['tests/scripts/test-flight-violation-runner.js']],
  ['node', ['tests/scripts/test-convective-risk-runner.js']],
  ['node', ['tests/scripts/test-detect-flight-phase.js']],
  ['node', ['tests/scripts/test-phase-runner-hysteresis.js']],
  ['node', ['tests/scripts/test-destination-target-store.js']],
  ['node', ['tests/scripts/test-update-checker.js']],
  ['node', ['tests/scripts/test-flight-kinematics.js']],
  ['node', ['tests/scripts/test-flight-logbook-trends.js']],
  ['node', ['dist/backend/utils/path-guard.test.js']],
  ['node', ['tests/scripts/test-simbridge-core-utils.js']],
];

function commandFor(tool) {
  if (tool === 'node') return process.execPath;
  return tool;
}

function resolveStepCommand(tool, args) {
  if (tool === 'npm') {
    const npmExecPath = process.env.npm_execpath;
    if (npmExecPath && fs.existsSync(npmExecPath)) {
      return {
        command: process.execPath,
        args: [npmExecPath, ...args],
      };
    }

    if (process.platform === 'win32') {
      return {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', ['npm', ...args].join(' ')],
      };
    }
  }

  return {
    command: commandFor(tool),
    args,
  };
}

function formatStep(tool, args) {
  return [tool, ...args].join(' ');
}

function isPathWithin(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function createIsolatedTestEnvironment(baseEnv = process.env) {
  const scratchRoot = getRepoScratchPath();
  const testHome = getRepoScratchPath('test-suite-home');
  const documents = path.join(testHome, 'Documents');
  const originalHome = baseEnv.USERPROFILE || baseEnv.HOME;
  const cargoHome = baseEnv.CARGO_HOME || (originalHome ? path.join(originalHome, '.cargo') : undefined);
  const rustupHome = baseEnv.RUSTUP_HOME || (originalHome ? path.join(originalHome, '.rustup') : undefined);
  const appData = getRepoScratchAppData('test-suite-appdata');
  const localAppData = getRepoScratchPath('test-suite-appdata', 'AppData', 'Local');
  const xdgConfigHome = path.join(testHome, '.config');
  const oneDrive = path.join(testHome, 'OneDrive');
  fs.mkdirSync(testHome, { recursive: true });
  fs.mkdirSync(documents, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  fs.mkdirSync(xdgConfigHome, { recursive: true });
  fs.mkdirSync(oneDrive, { recursive: true });

  const env = {
    ...baseEnv,
    HOME: testHome,
    USERPROFILE: testHome,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: xdgConfigHome,
    OneDrive: oneDrive,
    ONEDRIVE: oneDrive,
    OneDriveConsumer: oneDrive,
    OneDriveCommercial: oneDrive,
    FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS: '1',
  };
  if (cargoHome) env.CARGO_HOME = cargoHome;
  if (rustupHome) env.RUSTUP_HOME = rustupHome;

  for (const [name, targetPath] of Object.entries({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    APPDATA: env.APPDATA,
    LOCALAPPDATA: env.LOCALAPPDATA,
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
    OneDrive: env.OneDrive,
    ONEDRIVE: env.ONEDRIVE,
    OneDriveConsumer: env.OneDriveConsumer,
    OneDriveCommercial: env.OneDriveCommercial,
  })) {
    if (!isPathWithin(scratchRoot, targetPath)) {
      throw new Error(`Refusing to run tests with ${name} outside the repository scratch directory: ${targetPath}`);
    }
  }

  return env;
}

function main() {
  const env = createIsolatedTestEnvironment();

  if (process.argv.includes('--check-environment')) {
    console.log(`Test environment is isolated under ${getRepoScratchPath()}`);
    return;
  }

  for (const [tool, args] of TEST_STEPS) {
    console.log(`\n> ${formatStep(tool, args)}`);
    const stepCommand = resolveStepCommand(tool, args);
    const result = spawnSync(stepCommand.command, stepCommand.args, {
      cwd: ROOT,
      env,
      stdio: 'inherit',
    });

    if (result.error) {
      console.error(`Failed to run ${formatStep(tool, args)}: ${result.error.message}`);
      process.exit(1);
    }

    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
  }
}

if (require.main === module) main();

module.exports = {
  createIsolatedTestEnvironment,
  isPathWithin,
};
