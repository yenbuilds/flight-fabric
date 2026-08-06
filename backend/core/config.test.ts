// config.test.js
// Tests for feature flag defaults in dev vs packaged modes

'use strict';

const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');
const {
  resolveXPlaneStartupSelection,
} = require('./xplane-startup-gate.js') as {
  resolveXPlaneStartupSelection: (options: {
    explicitEnable?: boolean;
    cliRequested?: boolean;
    simulatorProtocol?: unknown;
  }) => {
    requested: boolean;
    enabled: boolean;
    blocked: boolean;
    isXPlane: boolean;
    simulatorProtocol: 'KittyHawk' | 'XPLANE_WEB';
  };
};

const tempHomeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-config-test-'));
process.env.HOME = path.join(tempHomeRoot, 'home');
process.env.USERPROFILE = process.env.HOME;
process.env.APPDATA = path.join(tempHomeRoot, 'AppData', 'Roaming');

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`    ${errorMessage}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, msg = ''): void {
  if (actual !== expected) {
    throw new Error(`${msg} Expected ${expected}, got ${actual}`);
  }
}

function assertTrue(value: unknown, msg = ''): void {
  if (!value) {
    throw new Error(msg || 'Expected truthy value');
  }
}

function assertFalse(value: unknown, msg = ''): void {
  if (value) {
    throw new Error(msg || 'Expected falsy value');
  }
}

console.log('\n=== Config Feature Flag Tests ===\n');

// -----------------------------------------------------------------------------
// Dev Mode Tests (default when not in Electron)
// -----------------------------------------------------------------------------
console.log('\n--- Dev Mode (default) ---\n');

// Clear any cached config module
delete require.cache[require.resolve('./config')];
// Ensure dev mode
delete process.env.ELECTRON_PACKAGED;
delete process.env.FLIGHT_ENV_MODE;
delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.FF_ELECTRON_BACKEND;
delete process.env.FF_LOCAL_BAT_LAUNCH;
delete process.env.FF_PARENT_STDIN_LIFELINE;
delete process.env.RUST_SIMVARS_MAX_VARS;
delete process.env.RECORDING_AUTO_START;
delete process.env.STABILITY_DEBUG_LOG;
delete process.env.STABILITY_DEBUG_ALWAYS_ACTIVE;
delete process.env.DEBUG_ENABLE;
delete process.env.FF_ENABLE_EXPERIMENTAL_XPLANE;
delete process.env.SIMCONNECT_PROTOCOL;
delete process.env.POLL_RATE_MS;
delete process.env.POLL_INTERVAL_MS;

const devConfig = require('./config');

test('envMode should be "dev" by default', () => {
  assertEqual(devConfig.env.mode, 'dev', 'env.mode');
});

test('isDev should be true', () => {
  assertTrue(devConfig.env.isDev, 'isDev');
});

test('isPackaged should be false', () => {
  assertFalse(devConfig.env.isPackaged, 'isPackaged');
});

test('parent stdin lifeline should require an explicit supervisor opt-in', () => {
  assertFalse(devConfig.env.parentStdinLifeline, 'parentStdinLifeline');
});

test('VRE ultra fidelity should default enabled', () => {
  assertTrue(devConfig.vre.ultraFidelityEnable, 'vre.ultraFidelityEnable');
});

test('LVAR sidecar provider should default to auto', () => {
  assertEqual(devConfig.lvarSidecar.provider, 'auto', 'lvarSidecar.provider');
});

test('Rust SimVars max vars should default to uncapped', () => {
  assertEqual(devConfig.simconnect.rustMaxVars, 0, 'simconnect.rustMaxVars');
});

test('Cabin announcement startup grace should default to 5000ms', () => {
  assertEqual(devConfig.cabinAnnouncements.startupGraceMs, 5000, 'cabinAnnouncements.startupGraceMs');
});

test('Cabin announcements should default disabled', () => {
  assertFalse(devConfig.cabinAnnouncements.enabled, 'cabinAnnouncements.enabled');
  assertFalse(
    devConfig.cabinAnnouncements.envOverrides.enabled,
    'cabinAnnouncements.envOverrides.enabled',
  );
  assertFalse(
    devConfig.cabinAnnouncements.envOverrides.style,
    'cabinAnnouncements.envOverrides.style',
  );
  assertFalse(
    devConfig.cabinAnnouncements.envOverrides.startupGraceMs,
    'cabinAnnouncements.envOverrides.startupGraceMs',
  );
});

test('Backend debug events should default disabled', () => {
  assertFalse(devConfig.debug.enable, 'debug.enable');
});

test('telemetry polling should be fixed at 100ms', () => {
  assertEqual(devConfig.poll.rateMs, 100, 'poll.rateMs');
  assertEqual(devConfig.poll.intervalMs, 100, 'poll.intervalMs');
});

delete require.cache[require.resolve('./config')];
process.env.POLL_RATE_MS = '50';
process.env.POLL_INTERVAL_MS = '500';
const devConfigWithRetiredPollOverrides = require('./config');

test('retired poll environment overrides should be ignored', () => {
  assertEqual(devConfigWithRetiredPollOverrides.poll.rateMs, 100, 'poll.rateMs');
  assertEqual(devConfigWithRetiredPollOverrides.poll.intervalMs, 100, 'poll.intervalMs');
});

delete process.env.POLL_RATE_MS;
delete process.env.POLL_INTERVAL_MS;

test('Recording auto-start should default enabled', () => {
  assertTrue(devConfig.recording.autoStart, 'recording.autoStart');
});

test('Update checks should default enabled', () => {
  assertTrue(devConfig.updates.enabled, 'updates.enabled');
});

test('Trusted-LAN aircraft control should default disabled', () => {
  assertFalse(devConfig.http.remoteAircraftControlEnable, 'http.remoteAircraftControlEnable');
});

test('X-Plane developer availability gate should default disabled', () => {
  assertFalse(devConfig.xplane.experimentalEnable, 'xplane.experimentalEnable');
  assertEqual(devConfig.simconnect.requestedProtocol, 'KittyHawk', 'simconnect.requestedProtocol');
  assertEqual(devConfig.simconnect.protocol, 'KittyHawk', 'simconnect.protocol');
});

test('stale X-Plane protocol settings should fail closed without the developer gate', () => {
  const selection = resolveXPlaneStartupSelection({
    simulatorProtocol: 'XPLANE_WEB',
  });

  assertTrue(selection.requested, 'requested');
  assertTrue(selection.blocked, 'blocked');
  assertFalse(selection.enabled, 'enabled');
  assertFalse(selection.isXPlane, 'isXPlane');
  assertEqual(selection.simulatorProtocol, 'KittyHawk', 'simulatorProtocol');
});

test('the --xplane request should fail closed without the developer gate', () => {
  const selection = resolveXPlaneStartupSelection({
    cliRequested: true,
  });

  assertTrue(selection.blocked, 'blocked');
  assertFalse(selection.isXPlane, 'isXPlane');
  assertEqual(selection.simulatorProtocol, 'KittyHawk', 'simulatorProtocol');
});

test('X-Plane protocol activation should require the explicit developer gate', () => {
  const selection = resolveXPlaneStartupSelection({
    explicitEnable: true,
    simulatorProtocol: 'XPLANE_WEB',
  });

  assertFalse(selection.blocked, 'blocked');
  assertTrue(selection.enabled, 'enabled');
  assertTrue(selection.isXPlane, 'isXPlane');
  assertEqual(selection.simulatorProtocol, 'XPLANE_WEB', 'simulatorProtocol');
});

test('the explicit developer gate should allow an intentional --xplane request', () => {
  const selection = resolveXPlaneStartupSelection({
    explicitEnable: true,
    cliRequested: true,
  });

  assertTrue(selection.enabled, 'enabled');
  assertTrue(selection.isXPlane, 'isXPlane');
  assertEqual(selection.simulatorProtocol, 'XPLANE_WEB', 'simulatorProtocol');
});

test('the developer gate alone should not select X-Plane', () => {
  const selection = resolveXPlaneStartupSelection({
    explicitEnable: true,
  });

  assertFalse(selection.requested, 'requested');
  assertFalse(selection.enabled, 'enabled');
  assertFalse(selection.isXPlane, 'isXPlane');
  assertEqual(selection.simulatorProtocol, 'KittyHawk', 'simulatorProtocol');
});

delete require.cache[require.resolve('./config')];
process.env.FF_ENABLE_EXPERIMENTAL_XPLANE = '1';
const devConfigXPlaneExplicitlyEnabled = require('./config');

test('X-Plane developer availability gate should honor an explicit opt-in', () => {
  assertTrue(devConfigXPlaneExplicitlyEnabled.xplane.experimentalEnable, 'xplane.experimentalEnable');
  assertEqual(
    devConfigXPlaneExplicitlyEnabled.simconnect.protocol,
    'KittyHawk',
    'the availability gate alone must not change the effective simulator',
  );
});

delete process.env.FF_ENABLE_EXPERIMENTAL_XPLANE;

delete require.cache[require.resolve('./config')];
process.env.SIMCONNECT_PROTOCOL = 'XPLANE_WEB';
const devConfigXPlaneRequestBlocked = require('./config');

test('config should expose a stale X-Plane request but keep the effective simulator on MSFS', () => {
  assertEqual(devConfigXPlaneRequestBlocked.simconnect.requestedProtocol, 'XPLANE_WEB', 'simconnect.requestedProtocol');
  assertEqual(devConfigXPlaneRequestBlocked.simconnect.protocol, 'KittyHawk', 'simconnect.protocol');
});

delete require.cache[require.resolve('../aircraft/aircraft-profile-loader.js')];
const profileLoaderWithBlockedXPlaneRequest = require('../aircraft/aircraft-profile-loader.js') as {
  loadProfile: (id: string) => { _qualifiedId?: string } | null;
};

test('blocked X-Plane requests should keep generic profile resolution on MSFS', () => {
  assertEqual(
    profileLoaderWithBlockedXPlaneRequest.loadProfile('generic')?._qualifiedId,
    'bundled/msfs/generic',
    'generic profile',
  );
});

delete require.cache[require.resolve('./config')];
process.env.FF_ENABLE_EXPERIMENTAL_XPLANE = '1';
const devConfigXPlaneRequestEnabled = require('./config');

test('config should select X-Plane only when the request and developer gate are both present', () => {
  assertEqual(devConfigXPlaneRequestEnabled.simconnect.requestedProtocol, 'XPLANE_WEB', 'simconnect.requestedProtocol');
  assertEqual(devConfigXPlaneRequestEnabled.simconnect.protocol, 'XPLANE_WEB', 'simconnect.protocol');
});

delete require.cache[require.resolve('../aircraft/aircraft-profile-loader.js')];
const profileLoaderWithEnabledXPlaneRequest = require('../aircraft/aircraft-profile-loader.js') as {
  loadProfile: (id: string) => { _qualifiedId?: string } | null;
};

test('intentional X-Plane activation should retain X-Plane generic profile resolution', () => {
  assertEqual(
    profileLoaderWithEnabledXPlaneRequest.loadProfile('generic')?._qualifiedId,
    'bundled/xplane/generic',
    'generic profile',
  );
});

delete process.env.FF_ENABLE_EXPERIMENTAL_XPLANE;
delete process.env.SIMCONNECT_PROTOCOL;

delete require.cache[require.resolve('./config')];
process.env.FF_ENABLE_EXPERIMENTAL_XPLANE = '1';
process.argv.push('--xplane');
const devConfigXPlaneCliEnabled = require('./config');
process.argv.pop();

test('config should expose X-Plane as effective for the intentional CLI activation path', () => {
  assertEqual(devConfigXPlaneCliEnabled.simconnect.requestedProtocol, 'KittyHawk', 'simconnect.requestedProtocol');
  assertEqual(devConfigXPlaneCliEnabled.simconnect.protocol, 'XPLANE_WEB', 'simconnect.protocol');
});

delete require.cache[require.resolve('../aircraft/aircraft-profile-loader.js')];
const profileLoaderWithEnabledXPlaneCli = require('../aircraft/aircraft-profile-loader.js') as {
  loadProfile: (id: string) => { _qualifiedId?: string } | null;
};

test('intentional CLI activation should keep generic profile resolution on X-Plane', () => {
  assertEqual(
    profileLoaderWithEnabledXPlaneCli.loadProfile('generic')?._qualifiedId,
    'bundled/xplane/generic',
    'generic profile',
  );
});

delete process.env.FF_ENABLE_EXPERIMENTAL_XPLANE;

delete require.cache[require.resolve('./config')];
process.env.REMOTE_AIRCRAFT_CONTROL_ENABLE = 'true';
delete process.env.REMOTE_ACCESS_ENABLE;
const devConfigAircraftControlWithoutLan = require('./config');

test('Trusted-LAN aircraft control should fail closed unless remote access is also enabled', () => {
  assertFalse(
    devConfigAircraftControlWithoutLan.http.remoteAircraftControlEnable,
    'http.remoteAircraftControlEnable',
  );
});

delete require.cache[require.resolve('./config')];
process.env.REMOTE_ACCESS_ENABLE = 'true';
const devConfigAircraftControlEnabled = require('./config');

test('Trusted-LAN aircraft control should enable only with both explicit settings', () => {
  assertTrue(devConfigAircraftControlEnabled.http.remoteAircraftControlEnable, 'http.remoteAircraftControlEnable');
});

delete process.env.REMOTE_ACCESS_ENABLE;
delete process.env.REMOTE_AIRCRAFT_CONTROL_ENABLE;

test('Stability debug always-active mode should stay disabled by default', () => {
  assertFalse(devConfig.stability.debugAlwaysActive, 'stability.debugAlwaysActive');
});

delete require.cache[require.resolve('./config')];
process.env.STABILITY_DEBUG_LOG = 'true';
const devConfigStabilityDebugEnabled = require('./config');

test('STABILITY_DEBUG_LOG can still be enabled for direct non-Electron debugging', () => {
  assertTrue(devConfigStabilityDebugEnabled.stability.debugLog, 'stability.debugLog');
});

delete process.env.STABILITY_DEBUG_LOG;

delete require.cache[require.resolve('./config')];
process.env.DEBUG_ENABLE = 'true';
const devConfigBackendDebugEnabled = require('./config');

test('DEBUG_ENABLE can still enable developer diagnostics outside user settings', () => {
  assertTrue(devConfigBackendDebugEnabled.debug.enable, 'debug.enable');
});

delete process.env.DEBUG_ENABLE;

delete require.cache[require.resolve('./config')];
process.env.VRE_ULTRA_FIDELITY_ENABLE = '0';
const devConfigVreDisabled = require('./config');

test('VRE ultra fidelity env override should disable feature', () => {
  assertFalse(devConfigVreDisabled.vre.ultraFidelityEnable, 'vre.ultraFidelityEnable');
});

delete process.env.VRE_ULTRA_FIDELITY_ENABLE;

delete require.cache[require.resolve('./config')];
process.env.CABIN_ANNOUNCEMENTS_STARTUP_GRACE_MS = '2500';
const devConfigCabinGraceOverride = require('./config');

test('Cabin announcement startup grace env override should be honored', () => {
  assertEqual(devConfigCabinGraceOverride.cabinAnnouncements.startupGraceMs, 2500, 'cabinAnnouncements.startupGraceMs');
  assertTrue(
    devConfigCabinGraceOverride.cabinAnnouncements.envOverrides.startupGraceMs,
    'cabinAnnouncements.envOverrides.startupGraceMs',
  );
});

delete process.env.CABIN_ANNOUNCEMENTS_STARTUP_GRACE_MS;

delete require.cache[require.resolve('./config')];
process.env.RECORDING_AUTO_START = '0';
const devConfigRecordingAutoStartDisabled = require('./config');

test('Recording auto-start env override should disable automatic recording', () => {
  assertFalse(devConfigRecordingAutoStartDisabled.recording.autoStart, 'recording.autoStart');
});

delete process.env.RECORDING_AUTO_START;

delete require.cache[require.resolve('./config')];
process.env.STABILITY_DEBUG_LOG = 'true';
process.env.FF_ELECTRON_BACKEND = '1';
const devConfigElectronStabilityDebugBlocked = require('./config');

test('Electron-launched backend should force stability debug logging off', () => {
  assertTrue(devConfigElectronStabilityDebugBlocked.env.isElectronBackend, 'env.isElectronBackend');
  assertFalse(devConfigElectronStabilityDebugBlocked.stability.debugLog, 'stability.debugLog');
});

delete process.env.STABILITY_DEBUG_LOG;
delete process.env.FF_ELECTRON_BACKEND;

delete require.cache[require.resolve('./config')];
process.env.STABILITY_DEBUG_LOG = 'true';
process.env.FF_LOCAL_BAT_LAUNCH = '1';
const devConfigBatchStabilityDebugBlocked = require('./config');

test('start-simbridge.bat launches should force stability debug logging off', () => {
  assertTrue(devConfigBatchStabilityDebugBlocked.env.isLocalBatchLaunch, 'env.isLocalBatchLaunch');
  assertFalse(devConfigBatchStabilityDebugBlocked.stability.debugLog, 'stability.debugLog');
});

delete process.env.STABILITY_DEBUG_LOG;
delete process.env.FF_LOCAL_BAT_LAUNCH;

delete require.cache[require.resolve('./config')];
process.env.STABILITY_DEBUG_ALWAYS_ACTIVE = '1';
const devConfigStabilityAlwaysActiveIgnored = require('./config');

test('STABILITY_DEBUG_ALWAYS_ACTIVE env override should be ignored', () => {
  assertFalse(
    devConfigStabilityAlwaysActiveIgnored.stability.debugAlwaysActive,
    'stability.debugAlwaysActive',
  );
  assertEqual(
    devConfigStabilityAlwaysActiveIgnored.stability.highAltResetRaFt,
    5000,
    'stability.highAltResetRaFt',
  );
});

delete process.env.STABILITY_DEBUG_ALWAYS_ACTIVE;

delete require.cache[require.resolve('./config')];
process.env.SIMCONNECT_PROVIDER = 'rust';
process.env.LVAR_SIDECAR_BINARY = 'C:\\custom\\ff-rust-simconnect-sidecar.exe';
const devConfigSidecarOverride = require('./config');

test('LVAR sidecar env overrides should honor canonical provider values', () => {
  assertEqual(devConfigSidecarOverride.lvarSidecar.provider, 'rust', 'lvarSidecar.provider');
  assertEqual(devConfigSidecarOverride.lvarSidecar.binaryPath, 'C:\\custom\\ff-rust-simconnect-sidecar.exe', 'lvarSidecar.binaryPath');
  assertEqual(devConfigSidecarOverride.simconnect.provider, 'rust', 'simconnect.provider');
});

delete process.env.SIMCONNECT_PROVIDER;
delete process.env.LVAR_SIDECAR_BINARY;

delete require.cache[require.resolve('./config')];
process.env.RUST_SIMVARS_MAX_VARS = '132';
const devConfigRustSimvarsMaxVars = require('./config');

test('Rust SimVars max vars env override should be honored', () => {
  assertEqual(devConfigRustSimvarsMaxVars.simconnect.rustMaxVars, 132, 'simconnect.rustMaxVars');
});

delete process.env.RUST_SIMVARS_MAX_VARS;

delete require.cache[require.resolve('./config')];
process.env.CSV_WRITER_MODE = 'worker';
const devConfigCsvWriterWorker = require('./config');

test('CSV writer mode should default to worker', () => {
  assertEqual(devConfig.recording.csvWriterMode, 'worker', 'recording.csvWriterMode');
});

test('CSV writer mode should allow worker', () => {
  assertEqual(devConfigCsvWriterWorker.recording.csvWriterMode, 'worker', 'recording.csvWriterMode');
});

delete process.env.CSV_WRITER_MODE;

delete require.cache[require.resolve('./config')];
process.env.CSV_WRITER_MODE = 'rust';
const devConfigCsvWriterInvalid = require('./config');

test('invalid CSV writer mode should normalize to inline', () => {
  assertEqual(devConfigCsvWriterInvalid.recording.csvWriterMode, 'inline', 'recording.csvWriterMode');
});

delete process.env.CSV_WRITER_MODE;

// -----------------------------------------------------------------------------
// Packaged Mode Tests (simulated via env var)
// -----------------------------------------------------------------------------
console.log('\n--- Packaged Mode (ELECTRON_PACKAGED=1) ---\n');

// Clear cached config
delete require.cache[require.resolve('./config')];
// Set packaged mode
process.env.ELECTRON_PACKAGED = '1';
process.env.STABILITY_DEBUG_LOG = 'true';
delete process.env.FLIGHT_ENV_MODE;

const packagedConfig = require('./config');

test('envMode should be "packaged" when ELECTRON_PACKAGED=1', () => {
  assertEqual(packagedConfig.env.mode, 'packaged', 'env.mode');
});

test('isDev should be false', () => {
  assertFalse(packagedConfig.env.isDev, 'isDev');
});

test('isPackaged should be true', () => {
  assertTrue(packagedConfig.env.isPackaged, 'isPackaged');
});

test('packaged Electron should force stability debug logging off', () => {
  assertFalse(packagedConfig.stability.debugLog, 'stability.debugLog');
});

test('packaged Electron should keep update checks enabled by default', () => {
  assertTrue(packagedConfig.updates.enabled, 'updates.enabled');
});

delete require.cache[require.resolve('./config')];
process.env.UPDATE_CHECKS_ENABLED = '0';
const packagedConfigUpdateChecksDisabled = require('./config');

test('update checks can be explicitly disabled', () => {
  assertFalse(packagedConfigUpdateChecksDisabled.updates.enabled, 'updates.enabled');
});

// -----------------------------------------------------------------------------
// Cleanup and Summary
// -----------------------------------------------------------------------------

// Clean up env
delete process.env.ELECTRON_PACKAGED;
delete process.env.STABILITY_DEBUG_LOG;
delete process.env.UPDATE_CHECKS_ENABLED;
delete process.env.FF_ENABLE_EXPERIMENTAL_XPLANE;
delete process.env.SIMCONNECT_PROTOCOL;

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

export {};
