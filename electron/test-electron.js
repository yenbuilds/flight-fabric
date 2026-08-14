#!/usr/bin/env node
/**
 * Basic tests for Electron app components.
 * 
 * These tests run WITHOUT Electron runtime - they test the pure logic
 * and module structure. Browser-level smoke coverage lives in
 * tests/scripts/test-browser-smoke.js.
 * 
 * Run: node electron/test-electron.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { canStopBackendPortOwner } = require('./backend-cleanup-policy');
const {
  createBackendPortSnapshot,
  createBoundedLineBuffer,
  createStartupReadinessGate,
  isExactReadinessLine,
  parseConfiguredTcpPort,
  selectBackendRuntimePorts,
} = require('./backend-lifecycle');
const {
  classifyFlightFabricBackendIdentity,
  hasSameWindowsOwner,
  isSameWindowsProcessIdentity,
  normalizeWindowsProcessIdentity,
} = require('./backend-process-identity');
const { createSettingsStore } = require('./settings-store');
const { getLocalIPv4AddressesFromInterfaces } = require('./network-info');
const { resolveAllowedExternalUrl } = require('./external-url-policy');
const { isManagedProcessAlive } = require('./process-liveness');
const { isExactLauncherUrl, isTrustedIpcSender } = require('./ipc-sender-policy');
const {
  TRUSTED_RENDERER_PERMISSION,
  installSessionPermissionPolicy,
  isTrustedRendererPermission,
} = require('./session-permission-policy');
const { resolveBackendEntry } = require('../scripts/backend-runtime-paths');
const {
  copySharedRuntimeAssets,
  shouldExcludeRuntimeModuleEntry,
} = require('./after-pack');
const {
  assertBackendRuntimeInventoriesMatch,
  selectSimConnectDllSource,
  snapshotBackendRuntimeProfile,
} = require('./build-electron');

let passed = 0;
let failed = 0;
const pendingTests = [];

function test(name, condition) {
  if (condition) {
    console.log('  ✓', name);
    passed++;
  } else {
    console.log('  ✗', name, '← FAILED');
    failed++;
  }
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

// ─────────────────────────────────────────────────────────────
// File Structure Tests
// ─────────────────────────────────────────────────────────────
section('File Structure');

const electronDir = path.resolve(__dirname);
const projectRoot = path.resolve(__dirname, '..');

test('main.js exists', fs.existsSync(path.join(electronDir, 'main.js')));
test('preload.js exists', fs.existsSync(path.join(electronDir, 'preload.js')));
test('package.json exists', fs.existsSync(path.join(electronDir, 'package.json')));
test('build-electron.js exists', fs.existsSync(path.join(electronDir, 'build-electron.js')));
test('icon.ico exists', fs.existsSync(path.join(electronDir, 'icon.ico')));
test('runtime icon.png exists', fs.existsSync(path.join(electronDir, 'icon.png')));
test('taskbar icon.ico exists', fs.existsSync(path.join(electronDir, 'taskbar-icon.ico')));
test('taskbar icon.png exists', fs.existsSync(path.join(electronDir, 'taskbar-icon.png')));
test('recording tray icon exists', fs.existsSync(path.join(electronDir, 'taskbar-recording-icon.png')));
test('finalizing tray icon exists', fs.existsSync(path.join(electronDir, 'taskbar-finalizing-icon.png')));
test('recording taskbar overlay exists', fs.existsSync(path.join(electronDir, 'recording-overlay.png')));
test('finalizing taskbar overlay exists', fs.existsSync(path.join(electronDir, 'finalizing-overlay.png')));
test('launcher icon.png exists', fs.existsSync(path.join(electronDir, 'launcher', 'icon.png')));
test('launcher event bindings exist', fs.existsSync(path.join(electronDir, 'launcher', 'launcher-events.js')));
test('installer notice exists', fs.existsSync(path.join(electronDir, 'installer-notice.txt')));
test('backend-cleanup-policy.js exists', fs.existsSync(path.join(electronDir, 'backend-cleanup-policy.js')));
test('settings-store.js exists', fs.existsSync(path.join(electronDir, 'settings-store.js')));
test('network-info.js exists', fs.existsSync(path.join(electronDir, 'network-info.js')));
test('process-liveness.js exists', fs.existsSync(path.join(electronDir, 'process-liveness.js')));
test('runtime-owner-lock.js exists', fs.existsSync(path.join(electronDir, 'runtime-owner-lock.js')));
test('backend-lifecycle.js exists', fs.existsSync(path.join(electronDir, 'backend-lifecycle.js')));
test('backend-process-identity.js exists', fs.existsSync(path.join(electronDir, 'backend-process-identity.js')));
test('external-url-policy.js exists', fs.existsSync(path.join(electronDir, 'external-url-policy.js')));
test('session-permission-policy.js exists', fs.existsSync(path.join(electronDir, 'session-permission-policy.js')));
test(
  'packaged lifecycle probe exists',
  fs.existsSync(path.join(projectRoot, 'tests', 'scripts', 'test-electron-packaged-lifecycle.js')),
);
test(
  'virgin installer payload probe exists',
  fs.existsSync(path.join(projectRoot, 'tests', 'scripts', 'test-electron-installer-payload.js')),
);

section('IPC Sender Policy');

const launcherHtmlPath = path.join(electronDir, 'launcher', 'index.html');
const launcherUrl = pathToFileURL(launcherHtmlPath).href;
const launcherHtmlSource = fs.readFileSync(launcherHtmlPath, 'utf8');
const launcherInlineScript = launcherHtmlSource.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
const launcherInlineScriptHash = crypto.createHash('sha256')
  .update(launcherInlineScript.replace(/\r\n?/g, '\n'))
  .digest('base64');
test(
  'legacy launcher CSP allows only self-hosted and hash-approved scripts',
  launcherHtmlSource.includes('http-equiv="Content-Security-Policy"') &&
    launcherHtmlSource.includes(`'sha256-${launcherInlineScriptHash}'`) &&
    launcherHtmlSource.includes("script-src-attr 'none'") &&
    !launcherHtmlSource.includes("'unsafe-eval'"),
);
test(
  'legacy launcher uses delegated events instead of inline event handlers',
  !/\son[a-z]+\s*=/i.test(launcherHtmlSource) &&
    launcherHtmlSource.includes('data-launcher-action=') &&
    launcherHtmlSource.includes('src="launcher-events.js"'),
);
const frontendUrl = 'http://127.0.0.1:8000/frontend/index.html';
const isTestFrontendAppUrl = (rawUrl) => {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:'
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
      && parsed.port === '8000'
      && parsed.pathname === '/frontend/index.html';
  } catch {
    return false;
  }
};
function createIpcPolicyContext(frameUrl = frontendUrl) {
  const mainFrame = { url: frameUrl };
  const mainWebContents = { mainFrame, isDestroyed: () => false };
  return {
    event: { sender: mainWebContents, senderFrame: mainFrame },
    mainWebContents,
    isFrontendAppUrl: isTestFrontendAppUrl,
    launcherHtmlPath,
  };
}

test(
  'IPC sender policy accepts the local Vue main frame',
  isTrustedIpcSender(createIpcPolicyContext(frontendUrl)),
);
test(
  'IPC sender policy rejects auxiliary frontend documents',
  !isTrustedIpcSender(createIpcPolicyContext('http://127.0.0.1:8000/frontend/widgets-compact/widget.html')),
);
test(
  'IPC sender policy accepts the exact bundled launcher main frame',
  isTrustedIpcSender(createIpcPolicyContext(launcherUrl)),
);
test(
  'launcher URL policy rejects query/hash variants and other local files',
  isExactLauncherUrl(launcherUrl, launcherHtmlPath)
    && !isExactLauncherUrl(`${launcherUrl}?unexpected=1`, launcherHtmlPath)
    && !isExactLauncherUrl(`${launcherUrl}#unexpected`, launcherHtmlPath)
    && !isExactLauncherUrl(pathToFileURL(path.join(electronDir, 'preload.js')).href, launcherHtmlPath),
);
const foreignWindowContext = createIpcPolicyContext();
foreignWindowContext.event.sender = { mainFrame: foreignWindowContext.event.senderFrame };
test(
  'IPC sender policy rejects a different renderer window',
  !isTrustedIpcSender(foreignWindowContext),
);
const subframeContext = createIpcPolicyContext();
subframeContext.event.senderFrame = { url: frontendUrl };
test(
  'IPC sender policy rejects subframe requests even when the URL looks local',
  !isTrustedIpcSender(subframeContext),
);
test(
  'IPC sender policy rejects remote pages in the main window',
  !isTrustedIpcSender(createIpcPolicyContext('https://example.invalid/')),
);
const destroyedContext = createIpcPolicyContext();
destroyedContext.mainWebContents.isDestroyed = () => true;
test(
  'IPC sender policy fails closed for destroyed or missing sender state',
  !isTrustedIpcSender(destroyedContext)
    && !isTrustedIpcSender({ ...createIpcPolicyContext(), event: null })
    && !isTrustedIpcSender({ ...createIpcPolicyContext(), mainWebContents: null }),
);

section('External URL Policy');

for (const [label, url] of [
  ['Flight Fabric corresponding source', 'https://github.com/yenbuilds/flight-fabric/releases'],
  ['Flight Fabric latest release', 'https://github.com/yenbuilds/flight-fabric/releases/latest'],
  ['Flight Fabric tagged release', 'https://github.com/yenbuilds/flight-fabric/releases/tag/v0.2.1'],
  ['Flight Fabric release asset', 'https://github.com/yenbuilds/flight-fabric/releases/download/v0.2.1/Flight.Fabric.exe'],
  ['MobiFlight install guide', 'https://docs.mobiflight.com/guides/wasm-module/wasm-reinstall/'],
  ['MobiFlight enable guide', 'https://docs.mobiflight.com/guides/wasm-module/enable-in-msfs2024/'],
  ['OpenStreetMap copyright', 'https://www.openstreetmap.org/copyright'],
  ['CARTO attribution', 'https://carto.com/'],
  ['Leaflet attribution', 'https://leafletjs.com/'],
]) {
  test(`external URL policy allows ${label}`, resolveAllowedExternalUrl(url) === url);
}

for (const [label, url] of [
  ['plain HTTP', 'http://github.com/yenbuilds/flight-fabric/releases/latest'],
  ['mailto', 'mailto:support@example.com'],
  ['local file', 'file:///C:/Windows/System32/calc.exe'],
  ['JavaScript', 'javascript:alert(1)'],
  ['data URL', 'data:text/html,hello'],
  ['custom protocol', 'ms-settings:privacy'],
  ['arbitrary HTTPS host', 'https://example.com/'],
  ['lookalike GitHub host', 'https://github.com.attacker.example/yenbuilds/flight-fabric/releases/latest'],
  ['credential-confused GitHub URL', 'https://github.com@attacker.example/yenbuilds/flight-fabric/releases/latest'],
  ['other GitHub repository', 'https://github.com/attacker/flight-fabric/releases/latest'],
  ['non-release repository path', 'https://github.com/yenbuilds/flight-fabric/issues'],
  ['release path traversal', 'https://github.com/yenbuilds/flight-fabric/releases/../issues'],
  ['non-default port', 'https://github.com:8443/yenbuilds/flight-fabric/releases/latest'],
  ['query string', 'https://github.com/yenbuilds/flight-fabric/releases/latest?source=renderer'],
  ['fragment', 'https://github.com/yenbuilds/flight-fabric/releases/latest#download'],
  ['unapproved MobiFlight page', 'https://docs.mobiflight.com/'],
  ['OpenStreetMap lookalike', 'https://www.openstreetmap.org.attacker.example/copyright'],
  ['leading whitespace', ' https://carto.com/'],
  ['oversized URL', `https://github.com/yenbuilds/flight-fabric/releases/${'a'.repeat(2048)}`],
  ['malformed URL', 'not a URL'],
]) {
  test(`external URL policy rejects ${label}`, resolveAllowedExternalUrl(url) === null);
}

section('Session Permission Policy');

function createPermissionPolicyContext(frameUrl = frontendUrl) {
  const mainFrame = { url: frameUrl };
  const mainWebContents = { mainFrame, isDestroyed: () => false };
  return {
    webContents: mainWebContents,
    permission: TRUSTED_RENDERER_PERMISSION,
    requestingUrl: frameUrl,
    isMainFrame: true,
    mainWebContents,
    isFrontendAppUrl: isTestFrontendAppUrl,
    launcherHtmlPath,
  };
}

test(
  'session permission policy allows clipboard writes from the local Vue main frame',
  isTrustedRendererPermission(createPermissionPolicyContext(frontendUrl)),
);
test(
  'session permission policy allows clipboard writes from the exact launcher main frame',
  isTrustedRendererPermission(createPermissionPolicyContext(launcherUrl)),
);
test(
  'session permission policy denies every non-clipboard renderer permission',
  [
    'clipboard-read',
    'display-capture',
    'fileSystem',
    'geolocation',
    'hid',
    'media',
    'notifications',
    'openExternal',
    'serial',
    'usb',
    'unknown',
  ].every((permission) => !isTrustedRendererPermission({
    ...createPermissionPolicyContext(),
    permission,
  })),
);
const foreignPermissionContext = createPermissionPolicyContext();
foreignPermissionContext.webContents = { mainFrame: foreignPermissionContext.mainWebContents.mainFrame };
const subframePermissionContext = createPermissionPolicyContext();
subframePermissionContext.isMainFrame = false;
const mismatchedUrlPermissionContext = createPermissionPolicyContext();
mismatchedUrlPermissionContext.requestingUrl = `${frontendUrl}?unexpected=1`;
const destroyedPermissionContext = createPermissionPolicyContext();
destroyedPermissionContext.mainWebContents.isDestroyed = () => true;
test(
  'session permission policy rejects foreign, subframe, stale-URL, remote, and destroyed requesters',
  !isTrustedRendererPermission(foreignPermissionContext)
    && !isTrustedRendererPermission(subframePermissionContext)
    && !isTrustedRendererPermission(mismatchedUrlPermissionContext)
    && !isTrustedRendererPermission(createPermissionPolicyContext('https://example.invalid/'))
    && !isTrustedRendererPermission(destroyedPermissionContext),
);

let installedRequestHandler = null;
let installedCheckHandler = null;
const permissionDecisions = [];
const installedPermissionContext = createPermissionPolicyContext();
installSessionPermissionPolicy({
  electronSession: {
    setPermissionRequestHandler(handler) { installedRequestHandler = handler; },
    setPermissionCheckHandler(handler) { installedCheckHandler = handler; },
  },
  getMainWebContents: () => installedPermissionContext.mainWebContents,
  isFrontendAppUrl: isTestFrontendAppUrl,
  launcherHtmlPath,
  onDecision: (decision) => permissionDecisions.push(decision),
});
const permissionRequestResults = [];
installedRequestHandler(
  installedPermissionContext.webContents,
  TRUSTED_RENDERER_PERMISSION,
  (granted) => permissionRequestResults.push(granted),
  { requestingUrl: frontendUrl, isMainFrame: true },
);
installedRequestHandler(
  installedPermissionContext.webContents,
  'media',
  (granted) => permissionRequestResults.push(granted),
  { requestingUrl: frontendUrl, isMainFrame: true },
);
const trustedPermissionCheck = installedCheckHandler(
  installedPermissionContext.webContents,
  TRUSTED_RENDERER_PERMISSION,
  'http://127.0.0.1:8000',
  { requestingUrl: frontendUrl, isMainFrame: true },
);
const deniedPermissionCheck = installedCheckHandler(
  installedPermissionContext.webContents,
  'geolocation',
  'http://127.0.0.1:8000',
  { requestingUrl: frontendUrl, isMainFrame: true },
);
test(
  'session policy installs complete request and check handlers with single fail-closed decisions',
  typeof installedRequestHandler === 'function'
    && typeof installedCheckHandler === 'function'
    && permissionRequestResults.join(',') === 'true,false'
    && trustedPermissionCheck === true
    && deniedPermissionCheck === false
    && permissionDecisions.length === 4,
);

section('Managed Process Liveness');

const unresolvedChild = { pid: 4242, exitCode: null, signalCode: null };
const probeError = (code) => {
  const error = new Error(`probe failed with ${code}`);
  error.code = code;
  return error;
};
let observedProbe = null;
const successfulProbeResult = isManagedProcessAlive(unresolvedChild, (pid, signal) => {
  observedProbe = { pid, signal };
});
test(
  'successful signal-0 probe treats a tracked child as alive',
  successfulProbeResult === true && observedProbe?.pid === 4242 && observedProbe?.signal === 0,
);
test(
  'ESRCH is the only probe error that proves a tracked child is absent',
  isManagedProcessAlive(unresolvedChild, () => { throw probeError('ESRCH'); }) === false,
);
for (const code of ['EPERM', 'EACCES', 'UNKNOWN']) {
  test(
    `${code} probe failure conservatively retains tracked-child ownership`,
    isManagedProcessAlive(unresolvedChild, () => { throw probeError(code); }) === true,
  );
}

function asyncTest(name, run) {
  pendingTests.push(Promise.resolve().then(run).then(
    (condition) => test(name, condition),
    (error) => {
      console.error(error);
      test(name, false);
    },
  ));
}
test(
  'an observed child exit does not require another OS probe',
  isManagedProcessAlive({ ...unresolvedChild, exitCode: 0 }, () => {
    throw new Error('probe should not run after an observed exit');
  }) === false,
);

section('Backend Lifecycle Helpers');

const configuredPorts = createBackendPortSnapshot(8099, 8100);
const updatedPorts = createBackendPortSnapshot(9099, 9100);
const managedPortProcess = { pid: 4242 };
const activeLaunch = Object.freeze({ process: managedPortProcess, ports: configuredPorts });
test(
  'active backend ports remain pinned when configured settings change',
  Object.isFrozen(configuredPorts) &&
    selectBackendRuntimePorts(updatedPorts, activeLaunch, managedPortProcess) === configuredPorts,
);
test(
  'configured ports take effect after the managed child is cleared',
  selectBackendRuntimePorts(updatedPorts, activeLaunch, null) === updatedPorts,
);
let invalidPortRejected = false;
let duplicatePortsRejected = false;
try { createBackendPortSnapshot(0, 8100); } catch { invalidPortRejected = true; }
try { createBackendPortSnapshot(8100, 8100); } catch { duplicatePortsRejected = true; }
test(
  'backend port snapshots reject invalid and duplicate endpoints',
  invalidPortRejected &&
    duplicatePortsRejected &&
    Number.isNaN(parseConfiguredTcpPort('8099oops', 8099)) &&
    parseConfiguredTcpPort(undefined, 8099) === 8099,
);

const readinessLines = [];
const readinessBuffer = createBoundedLineBuffer((line) => readinessLines.push(line), {
  maxBufferLength: 256,
});
readinessBuffer.push('[SIMBRIDGE_');
readinessBuffer.push('READY]\r\nnext');
readinessBuffer.flush();
test(
  'line buffering preserves readiness markers split across stdout chunks',
  readinessLines.length === 2 &&
    readinessLines[0] === '[SIMBRIDGE_READY]' &&
    readinessLines[1] === 'next',
);
test(
  'readiness markers must occupy an exact trimmed line',
  isExactReadinessLine('  [SIMBRIDGE_READY]\r', '[SIMBRIDGE_READY]') &&
    !isExactReadinessLine('diagnostic [SIMBRIDGE_READY]', '[SIMBRIDGE_READY]') &&
    !isExactReadinessLine('[FF_PROCESS_GUARDIAN_READY] extra', '[FF_PROCESS_GUARDIAN_READY]'),
);
const boundedBuffer = createBoundedLineBuffer(() => {}, { maxBufferLength: 256 });
boundedBuffer.push('x'.repeat(2048));
test('stdout buffering retains a bounded tail', boundedBuffer.getBufferedLength() === 256);

asyncTest('startup readiness resolves true only after ready()', async () => {
  let timeoutCallback;
  const gate = createStartupReadinessGate({
    timeoutMs: 100,
    scheduleTimeout(callback) {
      timeoutCallback = callback;
      return { unref() {} };
    },
    cancelTimeout() {},
  });
  const accepted = gate.ready();
  timeoutCallback();
  return accepted === true && await gate.promise === true;
});

asyncTest('startup timeout runs cleanup before resolving false', async () => {
  let timeoutCallback;
  let cleanupComplete = false;
  const gate = createStartupReadinessGate({
    timeoutMs: 100,
    scheduleTimeout(callback) {
      timeoutCallback = callback;
      return { unref() {} };
    },
    cancelTimeout() {},
    async onTimeout() {
      await Promise.resolve();
      cleanupComplete = true;
    },
  });
  timeoutCallback();
  const result = await gate.promise;
  return result === false && cleanupComplete && gate.ready() === false;
});

asyncTest('cancelling startup suppresses later timeout cleanup', async () => {
  let timeoutCallback;
  let timeoutCleanupRan = false;
  const gate = createStartupReadinessGate({
    timeoutMs: 100,
    scheduleTimeout(callback) {
      timeoutCallback = callback;
      return { unref() {} };
    },
    cancelTimeout() {},
    onTimeout() { timeoutCleanupRan = true; },
  });
  gate.cancel();
  timeoutCallback();
  const result = await gate.promise;
  await Promise.resolve();
  return result === false && timeoutCleanupRan === false;
});

const electronIdentity = normalizeWindowsProcessIdentity({
  pid: 4242,
  commandLine: 'node C:\\ff\\core\\simbridge.js --ff-launch-owner=electron',
  creationToken: '638880000000000000',
  ownerSid: 'S-1-5-21-1000',
});
test(
  'Windows process identity classifies only complete verified Electron backends',
  classifyFlightFabricBackendIdentity(electronIdentity) === 'electron' &&
    classifyFlightFabricBackendIdentity({ ...electronIdentity, commandLine: 'node unrelated.js' }) === 'unverified',
);
test(
  'Windows process owner checks fail closed for a different account',
  hasSameWindowsOwner(electronIdentity, 'S-1-5-21-1000') &&
    !hasSameWindowsOwner(electronIdentity, 'S-1-5-21-2000'),
);
test(
  'PID reuse invalidates stale cleanup authorization',
  isSameWindowsProcessIdentity(electronIdentity, { ...electronIdentity }) &&
    !isSameWindowsProcessIdentity(electronIdentity, {
      ...electronIdentity,
      creationToken: '638880000000000001',
    }),
);

const settingsStoreSource = fs.readFileSync(path.join(electronDir, 'settings-store.js'), 'utf8');
const electronMainSource = fs.readFileSync(path.join(electronDir, 'main.js'), 'utf8').replace(/\r\n?/g, '\n');
const packagedLifecycleProbeSource = fs.readFileSync(
  path.join(projectRoot, 'tests', 'scripts', 'test-electron-packaged-lifecycle.js'),
  'utf8',
);
const packagedBackendLaunchProbeSource = fs.readFileSync(
  path.join(projectRoot, 'tests', 'scripts', 'test-electron-packaged-backend-launch.js'),
  'utf8',
);
test(
  'settings store writes route through safe-fs',
  settingsStoreSource.includes('safeReplaceTextFileSync') &&
    settingsStoreSource.includes("operation: 'saveElectronSettings'") &&
    !settingsStoreSource.includes('fs.writeFileSync(settingsFile'),
);
test(
  'Electron startup health checks both backend ports',
  electronMainSource.includes('httpPortAvailable') &&
    electronMainSource.includes('backend HTTP') &&
    electronMainSource.includes('Port ${checks.httpPortResolved} already in use'),
);
test(
  'Electron launches backend with explicit WS and HTTP ports',
  electronMainSource.includes("'--ws-port', String(launchPorts.wsPort)") &&
    electronMainSource.includes("'--http-port', String(launchPorts.httpPort)"),
);

const appIconPng = fs.readFileSync(path.join(electronDir, 'icon.png'));
test(
  'runtime icon is a 1024px RGBA PNG',
  appIconPng.readUInt32BE(16) === 1024 &&
    appIconPng.readUInt32BE(20) === 1024 &&
    appIconPng[25] === 6
);

const appIconIco = fs.readFileSync(path.join(electronDir, 'icon.ico'));
const icoImageCount = appIconIco.readUInt16LE(4);
const icoHas256pxEntry = Array.from(
  { length: icoImageCount },
  (_, index) => appIconIco[6 + (index * 16)] === 0 && appIconIco[7 + (index * 16)] === 0
).some(Boolean);
test('Windows icon contains multiple resolutions including 256px', icoImageCount >= 7 && icoHas256pxEntry);

const taskbarIconIco = fs.readFileSync(path.join(electronDir, 'taskbar-icon.ico'));
const taskbarIcoImageCount = taskbarIconIco.readUInt16LE(4);
const taskbarIcoSizes = Array.from({ length: taskbarIcoImageCount }, (_, index) => {
  const encodedSize = taskbarIconIco[6 + (index * 16)];
  return encodedSize === 0 ? 256 : encodedSize;
});
test(
  'compact Windows icon contains every optically rendered taskbar size',
  JSON.stringify(taskbarIcoSizes) === JSON.stringify([16, 20, 24, 32, 40, 48, 64, 128, 256])
);

const iconGeneratorSource = fs.readFileSync(path.join(projectRoot, 'scripts', 'generate-app-icons.ps1'), 'utf8');
test(
  'compact icon frames use direct small-size rendering and an optical scale',
  iconGeneratorSource.includes('$compactOpticalScale = 1.12') &&
    iconGeneratorSource.includes('-RenderCompactDirect')
);
test(
  'tray recording badge is enlarged independently from the taskbar overlay',
  iconGeneratorSource.includes('$trayBadgeFillDiameter = 124.0') &&
    iconGeneratorSource.includes('New-OverlayBadgeBitmap -Size 32')
);

for (const [filename, expectedSize] of [
  ['taskbar-recording-icon.png', 256],
  ['taskbar-finalizing-icon.png', 256],
  ['recording-overlay.png', 32],
  ['finalizing-overlay.png', 32],
]) {
  const badgePng = fs.readFileSync(path.join(electronDir, filename));
  test(`${filename} is a ${expectedSize}px RGBA PNG`, (
    badgePng.readUInt32BE(16) === expectedSize &&
    badgePng.readUInt32BE(20) === expectedSize &&
    badgePng[25] === 6
  ));
}

section('Backend Cleanup Policy');

test('prompt-confirmed same-user standalone backend cleanup remains allowed', (
  canStopBackendPortOwner('stoppable', { sameWindowsOwner: true }) === true
));
test('backend cleanup fails closed when the Windows owner is not the current user', (
  canStopBackendPortOwner('stoppable', { sameWindowsOwner: false }) === false
));
test('unverified backend owners always fail closed', (
  canStopBackendPortOwner('unverified', {
    sameWindowsOwner: true,
    allowElectronOwnerRecovery: true,
    hasSingleInstanceLock: true,
    hasRuntimeOwnerLock: true,
  }) === false
));
test('Electron backend recovery requires explicit prompt-confirmed authority', (
  canStopBackendPortOwner('electron', {
    sameWindowsOwner: true,
    hasSingleInstanceLock: true,
    hasRuntimeOwnerLock: true,
  }) === false
));
test('Electron backend recovery requires the Electron single-instance lock', (
  canStopBackendPortOwner('electron', {
    sameWindowsOwner: true,
    allowElectronOwnerRecovery: true,
    hasRuntimeOwnerLock: true,
  }) === false
));
test('Electron backend recovery requires the shared runtime-owner lock', (
  canStopBackendPortOwner('electron', {
    sameWindowsOwner: true,
    allowElectronOwnerRecovery: true,
    hasSingleInstanceLock: true,
  }) === false
));
test('prompt plus both ownership locks allow stale Electron backend recovery', (
  canStopBackendPortOwner('electron', {
    sameWindowsOwner: true,
    allowElectronOwnerRecovery: true,
    hasSingleInstanceLock: true,
    hasRuntimeOwnerLock: true,
  }) === true
));

// -----------------------------------------------------------------------------
// Network Info Smoke Test
// -----------------------------------------------------------------------------
section('Network Info Smoke');

const rankedNetworkIps = getLocalIPv4AddressesFromInterfaces({
  'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.17.32.1' }],
  Tailscale: [{ family: 'IPv4', internal: false, address: '100.64.1.7' }],
  WiFi: [{ family: 'IPv4', internal: false, address: '192.168.50.49' }],
  Ethernet: [{ family: 'IPv4', internal: false, address: '10.0.0.5' }],
  Loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
  LinkLocal: [{ family: 'IPv4', internal: false, address: '169.254.83.107' }],
});
test(
  'network info prefers 192.168 LAN IPs over virtual, public, and link-local adapters',
  JSON.stringify(rankedNetworkIps) === JSON.stringify(['192.168.50.49', '10.0.0.5', '172.17.32.1', '100.64.1.7', '169.254.83.107']),
);

// ─────────────────────────────────────────────────────────────
// Settings Store Smoke Test
// ─────────────────────────────────────────────────────────────
section('Settings Store Smoke');

const tempSettingsFile = path.join(os.tmpdir(), `flight-fabric-settings-smoke-${Date.now()}-${process.pid}.json`);
const settingsStore = createSettingsStore({ settingsFile: tempSettingsFile });

const initialSettings = settingsStore.getSettings();
test('settings store returns defaults when file is missing', initialSettings.wsPort === 8099 && initialSettings.httpPort === 8100);

fs.writeFileSync(tempSettingsFile, JSON.stringify({
  aircraft: { profile: ' local/msfs/legacy-private-profile ' },
}, null, 2));
const retiredLocalProfileSettings = settingsStore.getSettings();
test('settings store displays retired local profile overrides as auto', retiredLocalProfileSettings.aircraft === 'auto');

const saveResult = settingsStore.saveSettings({
  aircraft: 'fbw-a32nx',
  debug: true,
  simconnect: 'XPLANE_WEB',
  pollRateMs: 80,
  wsPort: 9200,
  httpPort: 9300,
  remoteAccess: false,
});
test('settings save succeeds', saveResult.success === true);
test('settings file is created', fs.existsSync(tempSettingsFile));

const persisted = JSON.parse(fs.readFileSync(tempSettingsFile, 'utf8'));
test('persists nested network.wsPort', persisted.network?.wsPort === 9200);
test('persists nested network.httpPort', persisted.network?.httpPort === 9300);
test('ignores retired backend debug setting', !Object.hasOwn(persisted.advanced || {}, 'debugMode'));
test('persists nested simulator.protocol', persisted.simulator?.protocol === 'XPLANE_WEB');
test('preserves supported aircraft profile selections', persisted.aircraft?.profile === 'fbw-a32nx');
test('ignores retired poll-rate input', !Object.hasOwn(persisted.performance || {}, 'pollRateMs'));
test('does not expose poll rate through launcher settings', !Object.hasOwn(saveResult.settings || {}, 'pollRateMs'));
test('does not expose backend debug through launcher settings', !Object.hasOwn(saveResult.settings || {}, 'debug'));

const runtimeNoEnv = settingsStore.refreshRuntimeNetworkFromSettings(
  { backendWsPort: 8099, backendHttpPort: 8100 },
  {},
);
test('runtime ports refresh from saved settings without env override', runtimeNoEnv.backendWsPort === 9200 && runtimeNoEnv.backendHttpPort === 9300);
const startBackendSource = electronMainSource.match(
  /async function startBackendOnce\(attemptId\) \{[\s\S]*?(?=\/\*\*\s*\n \* Stop the backend process)/,
)?.[0] || '';
test(
  'startBackend refreshes runtime ports from settings before spawn',
  startBackendSource.includes('settingsStore.refreshRuntimeNetworkFromSettings')
);

const runtimeWithEnv = settingsStore.refreshRuntimeNetworkFromSettings(
  { backendWsPort: 7777, backendHttpPort: 8888 },
  { SIMBRIDGE_WS_PORT: '7777', HTTP_PORT: '8888' },
);
test('runtime ports keep env-provided values', runtimeWithEnv.backendWsPort === 7777 && runtimeWithEnv.backendHttpPort === 8888);
const invalidEnvRuntime = settingsStore.refreshRuntimeNetworkFromSettings(
  { backendWsPort: parseConfiguredTcpPort('invalid', 8099), backendHttpPort: 8100 },
  { SIMBRIDGE_WS_PORT: 'invalid' },
);
test('invalid explicit environment ports remain invalid for fail-closed startup', Number.isNaN(invalidEnvRuntime.backendWsPort));

const retiredLocalProfileSave = settingsStore.saveSettings({
  aircraft: 'local/msfs/legacy-private-profile',
  simconnect: 'XPLANE_WEB',
  wsPort: 9200,
  httpPort: 9300,
  remoteAccess: false,
});
const persistedRetiredLocalProfileSave = JSON.parse(fs.readFileSync(tempSettingsFile, 'utf8'));
test('settings store refuses to re-save retired local profile overrides', (
  retiredLocalProfileSave.success === true
  && retiredLocalProfileSave.settings.aircraft === 'auto'
  && persistedRetiredLocalProfileSave.aircraft?.profile === 'auto'
));

const resetResult = settingsStore.resetSettings();
test('settings reset succeeds', resetResult.success === true);
test('settings reset restores defaults', resetResult.settings.wsPort === 8099 && resetResult.settings.httpPort === 8100);

try {
  if (fs.existsSync(tempSettingsFile)) fs.unlinkSync(tempSettingsFile);
} catch {
  // ignore cleanup errors in smoke test
}

// ─────────────────────────────────────────────────────────────
// Package.json Validation
// ─────────────────────────────────────────────────────────────
section('Package.json Validation');

const electronPkg = require('./package.json');
const rootPkg = require('../package.json');

test('has name field', typeof electronPkg.name === 'string');
test('has version field', typeof electronPkg.version === 'string');
test('has main entry point', electronPkg.main === 'main.js');
test('has electron dependency', electronPkg.devDependencies?.electron || electronPkg.dependencies?.electron);
test('has electron-builder', electronPkg.devDependencies?.['electron-builder']);
test('start script builds frontend first', electronPkg.scripts?.start?.includes('frontend:build'));
test('dev script builds frontend first', electronPkg.scripts?.dev?.includes('frontend:build'));
test(
  'Electron release gate runs the packaged lifecycle regression probe',
  rootPkg.scripts?.['electron:release']?.includes('npm run test:electron:lifecycle'),
);
test(
  'Electron release gate starts with the clean-candidate preflight when private release tooling is present',
  !rootPkg.scripts?.['release:check']
    || rootPkg.scripts?.['electron:release']?.trim().startsWith('npm run release:check &&'),
);
test(
  'Electron release gate runs the real IPC sender regression probe',
  rootPkg.scripts?.['electron:release']?.includes('npm run test:electron:ipc-runtime'),
);
test(
  'Electron release gate generates checksums after probes and verifies the final output',
  rootPkg.scripts?.['electron:release']?.indexOf('npm run electron:release:summary') >
    rootPkg.scripts?.['electron:release']?.indexOf('npm run test:electron:lifecycle') &&
    (rootPkg.scripts?.['release:verify']
      ? rootPkg.scripts?.['electron:release']?.indexOf('npm run release:verify -- --dist dist/electron') >
        rootPkg.scripts?.['electron:release']?.indexOf('npm run electron:release:summary')
      : rootPkg.scripts?.['electron:release']?.trim().endsWith('npm run electron:release:summary')),
);
test(
  'packaged launch probes remove newly generated Chromium debug logs',
  [packagedBackendLaunchProbeSource, packagedLifecycleProbeSource].every((source) => (
    source.includes("path.join(path.dirname(exePath), 'debug.log')") &&
    source.includes('chromiumDebugLogExistedBefore') &&
    source.includes('fs.unlinkSync(chromiumDebugLogPath)')
  )),
);

// Build config
test('has build config', typeof electronPkg.build === 'object');
test('build bundles runtime owner lock', electronPkg.build.files.includes('runtime-owner-lock.js'));
test('build bundles managed process liveness helper', electronPkg.build.files.includes('process-liveness.js'));
test('build bundles backend cleanup policy', electronPkg.build.files.includes('backend-cleanup-policy.js'));
test('build bundles backend lifecycle helper', electronPkg.build.files.includes('backend-lifecycle.js'));
test('build bundles Windows process identity helper', electronPkg.build.files.includes('backend-process-identity.js'));
test('build has appId', typeof electronPkg.build?.appId === 'string');
test('build has productName', typeof electronPkg.build?.productName === 'string');
test('build has app icon config', electronPkg.build?.icon === 'taskbar-icon.ico');
test('build targets win', electronPkg.build?.win !== undefined);
test(
  'Windows build delegates executable icon editing to afterPack',
  electronPkg.build?.win?.icon === 'taskbar-icon.ico' &&
    electronPkg.build?.win?.signAndEditExecutable === false &&
    electronPkg.devDependencies?.rcedit
);
test('build bundles safety notice with legal files', JSON.stringify(electronPkg.build?.extraResources || []).includes('SAFETY-NOTICE.md'));
test('build bundles taskbar icon resource', JSON.stringify(electronPkg.build?.extraResources || []).includes('"from":"taskbar-icon.ico"'));
test('build bundles tray bitmap icon resource', JSON.stringify(electronPkg.build?.extraResources || []).includes('"from":"taskbar-icon.png"'));
test(
  'build bundles recording badge artwork',
  ['taskbar-recording-icon.png', 'taskbar-finalizing-icon.png', 'recording-overlay.png', 'finalizing-overlay.png']
    .every((filename) => JSON.stringify(electronPkg.build?.extraResources || []).includes(`"from":"${filename}"`)),
);
test('build uses backend dependency afterPack hook', electronPkg.build?.afterPack === './after-pack.js');
test('NSIS installer displays the installer notice', electronPkg.build?.nsis?.license === 'installer-notice.txt');
test(
  'NSIS installer cannot target arbitrary directories or delete user data',
  electronPkg.build?.nsis?.allowToChangeInstallationDirectory === false &&
    electronPkg.build?.nsis?.deleteAppDataOnUninstall === false,
);
const installerNotice = fs.readFileSync(path.join(electronDir, 'installer-notice.txt'), 'utf8');
test(
  'installer notice covers alpha status, AGPL, no warranty, safety, storage, and source access',
  installerNotice.includes('unsigned experimental alpha software') &&
    installerNotice.includes('not certified, approved, or intended for') &&
    installerNotice.includes('Do not rely on Flight Fabric') &&
    /GNU Affero General Public\s+License/.test(installerNotice) &&
    installerNotice.includes('provided "as is" and "as available."') &&
    installerNotice.includes('maximum extent') &&
    installerNotice.includes('permitted by applicable law') &&
    installerNotice.includes('cannot lawfully be excluded, restricted, or modified') &&
    installerNotice.includes('does not impose') &&
    installerNotice.includes('additional restriction') &&
    installerNotice.includes('application-data directory') &&
    installerNotice.includes('https://github.com/yenbuilds/flight-fabric/releases')
);

// ─────────────────────────────────────────────────────────────
// Main Process Source Validation
// ─────────────────────────────────────────────────────────────
section('Main Process Source');

const mainSource = electronMainSource;

// Check for required Electron imports
test('imports app from electron', mainSource.includes("require('electron')"));
test('imports BrowserWindow', mainSource.includes('BrowserWindow'));
test('explicitly sandboxes the renderer process', mainSource.includes('sandbox: true'));
test('imports ipcMain', mainSource.includes('ipcMain'));
test('imports session for renderer permission policy', mainSource.includes('nativeImage, session'));
test('imports Tray', mainSource.includes('Tray'));
test('imports Notification', mainSource.includes('Notification'));
test('imports nativeImage', mainSource.includes('nativeImage'));
test(
  'uses a dedicated taskbar icon for the window and bitmap tray icon for the tray',
  mainSource.includes('TASKBAR_ICON_PATH') &&
    mainSource.includes('TASKBAR_TRAY_ICON_PATH') &&
    mainSource.includes('new Tray(trayIconPath)')
);
test(
  'sets the Windows app identity to Flight Fabric',
  mainSource.includes("const APP_PRODUCT_NAME = 'Flight Fabric'") &&
    mainSource.includes("const APP_ID = 'com.flightfabric.app'") &&
    mainSource.includes('app.setName(APP_PRODUCT_NAME)') &&
    mainSource.includes('app.setAppUserModelId(APP_ID)')
);

// Check for backend process management
test('has startBackend function', mainSource.includes('function startBackend'));
test('has stopBackend function', mainSource.includes('function stopBackend'));
test('uses fork for backend', mainSource.includes('fork('));
const startBackendWrapperSource = mainSource.match(
  /function startBackend\(\) \{[\s\S]*?(?=async function startBackendOnce)/,
)?.[0] || '';
test(
  'backend starts are serialized and the tracked promise is identity-cleared',
  startBackendWrapperSource.includes('if (backendStopPromise)') &&
    startBackendWrapperSource.includes('stopping.then(() => (isQuitting ? false : startBackend()))') &&
  startBackendWrapperSource.includes('if (backendStartPromise) return backendStartPromise;') &&
    startBackendWrapperSource.includes('backendStartPromise === tracked') &&
    startBackendWrapperSource.includes('backendStartPromise = null'),
);
const spawnPortGuardIndex = startBackendSource.indexOf('await checkBackendPortsForSpawn(launchPorts)');
const devForkIndex = startBackendSource.indexOf('fork(BACKEND_SCRIPT');
const packagedSpawnIndex = startBackendSource.indexOf('spawn(exePath');
test(
  'every backend spawn gets an immediate non-destructive two-port recheck',
  mainSource.includes('await Promise.all([\n    canListenOnPort(wsPort),\n    canListenOnPort(httpPort)') &&
    spawnPortGuardIndex >= 0 &&
    devForkIndex > spawnPortGuardIndex &&
    packagedSpawnIndex > spawnPortGuardIndex &&
    !startBackendSource.includes('promptToFreeBackendPort(') &&
    !startBackendSource.includes('killProcessOnPort('),
);
test(
  'Electron marks its child ownership and ignores stale child lifecycle events',
  startBackendSource.includes("'--ff-launch-owner=electron'") &&
    (startBackendSource.match(/backendProcess !== proc/g) || []).length >= 2 &&
    startBackendSource.includes('Ignoring stale backend exit event') &&
    startBackendSource.includes('Ignoring stale backend error event'),
);
test(
  'live-child errors retain ownership until the exit event',
  startBackendSource.includes('if (!proc.pid) {') &&
    startBackendSource.includes('backendProcess = null;') &&
    startBackendSource.includes("if (backendStatus !== 'stopping') backendStatus = 'error';"),
);
test(
  'backend start resolves only after bounded line-buffered readiness',
  startBackendSource.includes('createStartupReadinessGate({') &&
    startBackendSource.includes('createBoundedLineBuffer((line) =>') &&
    startBackendSource.includes("isExactReadinessLine(line, '[SIMBRIDGE_READY]')") &&
    startBackendSource.includes('const ready = await startupGate.promise;') &&
    startBackendSource.includes('return ready;'),
);
test(
  'backend startup timeout and stop cancellation cannot leave readiness pending',
  mainSource.includes('const BACKEND_STARTUP_TIMEOUT_MS = 30000;') &&
    mainSource.includes('await failBackendStartupAndStop(') &&
    mainSource.includes('if (backendProcess) cancelBackendStartup(backendProcess);'),
);
test(
  'backend and guardian pipe errors are identity-gated and fail closed',
  startBackendSource.includes("proc.stdout?.on('error'") &&
    startBackendSource.includes("proc.stderr?.on('error'") &&
    startBackendSource.includes("proc.stdin?.on('error'") &&
    startBackendSource.includes('if (backendProcess !== proc)') &&
    mainSource.includes("guardian.stdout?.on('error'") &&
    mainSource.includes("guardian.stderr?.on('error'") &&
    mainSource.includes('handleBackendGuardianFailure(guardian, proc,'),
);
test(
  'Windows backend startup requires the Rust process guardian',
  mainSource.includes("const PROCESS_GUARDIAN_READY_MARKER = '[FF_PROCESS_GUARDIAN_READY]';") &&
    mainSource.includes("'--process-guardian'") &&
    mainSource.includes('`--ff-owner-pid=${process.pid}`') &&
    mainSource.includes('`--ff-target-pid=${proc.pid}`') &&
    mainSource.includes('isExactReadinessLine(text, PROCESS_GUARDIAN_READY_MARKER)') &&
    mainSource.includes('if (!state.backendReady || !state.guardianReady) return false;') &&
    mainSource.includes('handleBackendGuardianFailure'),
);
test(
  'running backend ports use an immutable launch snapshot until that child exits',
  startBackendSource.includes('const launchPorts = createBackendPortSnapshot') &&
    startBackendSource.includes('activateBackendLaunch(proc, launchPorts);') &&
    mainSource.includes('if (activeBackendLaunch?.process === backendProcess) return activeBackendLaunch.ports;') &&
    mainSource.includes("registerTrustedIpcHandler('backend-http-port', () => getBackendRuntimePorts().httpPort)") &&
    mainSource.includes('const port = Number(getBackendRuntimePorts().httpPort);'),
);
test(
  'Electron validates distinct backend ports before health checks, settings writes, and spawn',
  mainSource.includes('configuredPorts = getConfiguredBackendPorts();') &&
    mainSource.includes("title: 'Invalid Backend Port Configuration'") &&
    mainSource.includes('createBackendPortSnapshot(payload?.wsPort, payload?.httpPort);') &&
    startBackendSource.includes('const launchPorts = createBackendPortSnapshot(backendWsPort, backendHttpPort);'),
);
test(
  'debug file logging enforces the size cap after appends',
  mainSource.includes("fs.appendFileSync(debugLogPath, msg + '\\n');\n      enforceLogSize();")
);
test('Electron backend launch forces stability debug file logging off', (
  mainSource.includes("FF_ELECTRON_BACKEND: '1'") &&
  mainSource.includes("STABILITY_DEBUG_LOG: '0'") &&
  mainSource.includes("STABILITY_DEBUG_ALWAYS_ACTIVE: '0'")
));

// Check for IPC handlers
test('handles backend-start', mainSource.includes("registerTrustedIpcHandler('backend-start'"));
test('handles backend-stop', mainSource.includes("registerTrustedIpcHandler('backend-stop'"));
test('handles backend-restart', mainSource.includes("registerTrustedIpcHandler('backend-restart'"));
test('handles app-restart', mainSource.includes("registerTrustedIpcHandler('app-restart'"));
test('handles backend-status', mainSource.includes("registerTrustedIpcHandler('backend-status'"));
test('handles recording-badge-set', mainSource.includes("registerTrustedIpcHandler('recording-badge-set'"));
test('handles settings-get', mainSource.includes("registerTrustedIpcHandler('settings-get'"));
test('handles settings-save', mainSource.includes("registerTrustedIpcHandler('settings-save'"));
test('handles settings-reset', mainSource.includes("registerTrustedIpcHandler('settings-reset'"));
test('handles storage-locations-get', mainSource.includes("registerTrustedIpcHandler('storage-locations-get'"));
test('storage locations omit retired local aircraft profile folders', (
  !mainSource.includes("id: 'profiles'")
  && !mainSource.includes('getProfilesRootDir')
  && !mainSource.includes('Editable local aircraft profile overrides')
  && !mainSource.includes('Settings, aircraft profiles')
));

// Check for graceful shutdown
test('uses SIGTERM for graceful shutdown', mainSource.includes('SIGTERM'));
test('has force kill fallback', mainSource.includes('SIGKILL'));
const stopBackendSource = mainSource.match(
  /function stopBackend\(\) \{[\s\S]*?(?=async function restartBackend)/,
)?.[0] || '';
test(
  'Windows stdin failure falls back to a complete managed process-tree kill',
  stopBackendSource.includes("if (process.platform === 'win32')") &&
    stopBackendSource.includes('forceStopBackendProcessTree(proc);') &&
    stopBackendSource.indexOf('forceStopBackendProcessTree(proc);') < stopBackendSource.indexOf("proc.kill('SIGTERM')"),
);
test(
  'requests graceful backend shutdown over the gated stdin lifeline',
  mainSource.includes("FF_PARENT_STDIN_LIFELINE: lifecycleSmokeConfig?.action === 'hard-death' ? '0' : '1'") &&
    mainSource.includes("type: 'shutdown'") &&
    mainSource.includes('input.end(BACKEND_SHUTDOWN_MESSAGE'),
);
const backendForceKillTimeout = Number(
  mainSource.match(/const BACKEND_FORCE_KILL_TIMEOUT_MS = (\d+);/)?.[1],
);
test(
  'Electron owns the supervised tree kill before the backend parent-only fallback',
  backendForceKillTimeout > 10000 &&
    mainSource.includes('}, BACKEND_FORCE_KILL_TIMEOUT_MS);') &&
    fs.readFileSync(path.join(projectRoot, 'backend', 'core', 'simbridge.ts'), 'utf8')
      .includes('const BACKEND_FORCE_EXIT_TIMEOUT_MS = 15000;'),
);
const appRestartHandlerSource = mainSource.match(
  /registerTrustedIpcHandler\('app-restart',[\s\S]*?\n}\);/,
)?.[0] || '';
const shutdownApplicationSource = mainSource.match(
  /async function shutdownApplication\([\s\S]*?(?=\/\*\*\s*\n \* Send message to renderer process)/,
)?.[0] || '';
test(
  'app restart awaits the shared application shutdown sequence before relaunch',
  appRestartHandlerSource.includes('await shutdownApplication({ relaunch: true })') &&
    appRestartHandlerSource.includes('return { ok }') &&
    shutdownApplicationSource.includes('stopped = await stopBackend();') &&
    shutdownApplicationSource.includes('if (relaunch)') &&
    shutdownApplicationSource.includes('app.relaunch();'),
);
test(
  'application shutdown retains the runtime lock when its managed backend is still alive',
  shutdownApplicationSource.includes('if (liveBackend)') &&
    shutdownApplicationSource.indexOf('if (liveBackend)') < shutdownApplicationSource.indexOf("'Runtime-owner lock release'") &&
    shutdownApplicationSource.includes('Keeping the app and runtime lock active.') &&
    shutdownApplicationSource.includes('applicationShutdownPromise = null'),
);
test(
  'auxiliary cleanup failures cannot bypass final Electron exit after backend shutdown',
  shutdownApplicationSource.includes("'Frontend server shutdown'") &&
    shutdownApplicationSource.includes("'Runtime-owner lock release'") &&
    shutdownApplicationSource.includes('} finally {') &&
    shutdownApplicationSource.includes('app.exit(0);'),
);
test(
  'second-instance loser cannot enter asynchronous whenReady startup',
  mainSource.includes("void app.whenReady().then(async () => {\n  if (!gotTheLock) return;"),
);
const readyToShowSource = mainSource.match(
  /mainWindow\.once\('ready-to-show',[\s\S]*?\n  \}\);/,
)?.[0] || '';
const whenReadySource = mainSource.match(
  /void app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*?\n\}\)\.catch/,
)?.[0] || '';
test(
  'frontend bind failure detaches the failed server and aborts app initialization',
  mainSource.includes('if (frontendServer === server) frontendServer = null;') &&
    whenReadySource.includes("if (frontendResult?.status !== 'running')") &&
    whenReadySource.includes('await stopFrontendServer();') &&
    whenReadySource.includes('throw new Error('),
);
test(
  'backend auto-start is independent of renderer ready-to-show',
  !readyToShowSource.includes('startBackend(') &&
    whenReadySource.includes('createWindow();') &&
    whenReadySource.includes('createTray();') &&
    whenReadySource.includes('void startBackend().then(') &&
    whenReadySource.indexOf('createTray();') < whenReadySource.indexOf('void startBackend().then('),
);
test(
  'packaged lifecycle smoke mode covers nonce-gated normal quit and Electron hard death',
  mainSource.includes('FF_ELECTRON_LIFECYCLE_SMOKE_NONCE') &&
    mainSource.includes("argNonce !== envNonce") &&
    mainSource.includes("['quit', 'hard-death'].includes(envAction)") &&
    mainSource.includes("recordLifecycleSmokeEvent('managed-ready'") &&
    mainSource.includes("recordLifecycleSmokeEvent('quit-requested')") &&
    mainSource.includes('app.quit();') &&
    mainSource.includes("recordLifecycleSmokeEvent('before-quit')") &&
    mainSource.includes("recordLifecycleSmokeEvent('app-exit')") &&
    packagedLifecycleProbeSource.includes("await runPackagedLifecycleScenario('quit')") &&
    packagedLifecycleProbeSource.includes("await runPackagedLifecycleScenario('hard-death')") &&
    packagedLifecycleProbeSource.includes("child.kill('SIGKILL')") &&
    packagedLifecycleProbeSource.includes('captureCurrentUserWindowsProcessIdentity') &&
    packagedLifecycleProbeSource.includes('forceStopVerifiedWindowsProcessTree(identity)') &&
    packagedLifecycleProbeSource.includes('isLifecycleElectronIdentity') &&
    packagedLifecycleProbeSource.includes('isLifecycleGuardianIdentity') &&
    packagedLifecycleProbeSource.includes('isLifecycleSidecarIdentity') &&
    packagedLifecycleProbeSource.includes('waitForProcessesToExit(managedPids)') &&
    packagedLifecycleProbeSource.includes('waitForPortsReleased([wsPort, httpPort])') &&
    packagedLifecycleProbeSource.includes('waitForRuntimeOwnerLockRelease()'),
);
test(
  'renderer disposal cannot crash backend lifecycle event delivery',
  mainSource.includes('try {\n      mainWindow.webContents.send(channel, data);') &&
    mainSource.includes('Renderer send failed for ${channel}:'),
);
test('window close hides to tray instead of quitting when tray is available', mainSource.includes("mainWindow.on('close', hideWindowToTrayOnClose)") && mainSource.includes('mainWindow.hide();'));
test('tray close notice tells users Flight Fabric is still running', mainSource.includes('Flight Fabric is still running') && mainSource.includes('Right-click the tray icon and choose Quit to exit.'));
test(
  'recording badge loads generated artwork for taskbar and tray and can be reapplied',
  mainSource.includes('setOverlayIcon(') &&
    mainSource.includes('function loadRecordingBadgeImage') &&
    mainSource.includes('nativeImage.createFromPath(assetPath)') &&
    mainSource.includes('function setTaskbarRecordingBadgeImage') &&
    mainSource.includes('function setTrayRecordingBadgeImage') &&
    mainSource.includes('tray.setImage(recordingIcon)') &&
    mainSource.includes('stopTrayRecordingBadge({ restoreDefault: false })') &&
    !mainSource.includes('if (recordingBadgeState === nextState)')
);
test('uses execFileSync for stale port cleanup', mainSource.includes('execFileSync('));
test('does not use shell-string execSync in main process', !mainSource.includes('execSync('));
test('normalizes TCP ports before process cleanup', mainSource.includes('function normalizeTcpPort'));
test('stale port cleanup verifies Flight Fabric backend identity before taskkill', (
  mainSource.includes('function readWindowsProcessIdentity') &&
    mainSource.includes('classifyFlightFabricBackendIdentity(initialIdentity)') &&
    mainSource.includes('isSameWindowsProcessIdentity(initialIdentity, currentIdentity)') &&
    mainSource.includes('not a verified Flight Fabric backend') &&
    mainSource.includes('Stop Verified Flight Fabric Backend')
));
test(
  'stale Electron cleanup is same-user, prompt-confirmed, and requires both active ownership locks',
  mainSource.includes('hasSameWindowsOwner(initialIdentity, currentWindowsOwnerSid)') &&
    mainSource.includes('function killProcessOnPort(port, options = {})') &&
    mainSource.includes('killProcessOnPort(port, { allowElectronOwnerRecovery: true })') &&
    mainSource.includes('allowElectronOwnerRecovery: options.allowElectronOwnerRecovery === true') &&
    mainSource.includes('hasSingleInstanceLock: gotTheLock === true') &&
    mainSource.includes('hasRuntimeOwnerLock: runtimeOwnerLock?.acquired === true') &&
    mainSource.includes('sameWindowsOwner: hasSameWindowsOwner') &&
    mainSource.includes('canStopBackendPortOwner(ownership, cleanupCapabilities)') &&
    mainSource.includes('Recovering stale Electron backend process tree'),
);
test(
  'backend port conflicts cannot continue with an unmanaged backend',
  !mainSource.includes("'Continue Anyway'") &&
    (mainSource.match(/if \(!killed\) return null;/g) || []).length === 2 &&
    mainSource.includes('app.quit();')
);
test(
  'verified stale backend cleanup terminates its sidecar process tree',
  mainSource.includes("['/PID', String(pid), '/T', '/F']"),
);
test(
  'final Electron shutdown fallback verifies and terminates the managed process tree',
  mainSource.includes('function forceStopBackendProcessTree(proc)') &&
    mainSource.includes("['/PID', String(proc.pid), '/T', '/F']") &&
    mainSource.includes('waitForBackendProcessExit(proc)') &&
    mainSource.includes('isManagedProcessAlive(proc)') &&
    mainSource.includes('Keeping the app and runtime lock active.'),
);
const backendRestartHandlerSource = mainSource.match(
  /registerTrustedIpcHandler\('backend-restart',[\s\S]*?\n}\);/,
)?.[0] || '';
const restartBackendSource = mainSource.match(
  /async function restartBackend\(\) \{[\s\S]*?(?=async function shutdownApplication)/,
)?.[0] || '';
test(
  'backend restart starts only after the old managed process is confirmed absent',
  backendRestartHandlerSource.includes('await restartBackend();') &&
    restartBackendSource.includes('const stopped = await stopBackend();') &&
    restartBackendSource.includes('isBackendProcessAlive(backendProcess)') &&
    restartBackendSource.includes('return false;') &&
    restartBackendSource.includes('return startBackend();'),
);
const runtimeOwnerLockSource = fs.readFileSync(path.join(electronDir, 'runtime-owner-lock.js'), 'utf8');
const backendWrapperSource = fs.readFileSync(path.join(projectRoot, 'scripts', 'start-backend-runtime.js'), 'utf8');
test(
  'both backend supervisors use the same fail-closed process liveness rule',
  mainSource.includes("require('./process-liveness')") &&
    backendWrapperSource.includes("require('../electron/process-liveness')") &&
    backendWrapperSource.includes('return isManagedProcessAlive(target);'),
);
test(
  'Electron and standalone launch modes share an OS-released runtime lock',
  runtimeOwnerLockSource.includes('getDefaultRuntimeOwnerPipePath') &&
    runtimeOwnerLockSource.includes('os.userInfo().username.toLowerCase()') &&
    !/^\s*const identity\s*=.*os\.homedir\(\)/m.test(runtimeOwnerLockSource) &&
    runtimeOwnerLockSource.includes('server.listen(path, onListening)') &&
    runtimeOwnerLockSource.includes("host, port, exclusive: true") &&
    mainSource.includes("acquireRuntimeOwnerLock({ owner: 'electron' })") &&
    backendWrapperSource.includes("acquireRuntimeOwnerLock({ owner: 'standalone' })") &&
    mainSource.includes("'Runtime-owner lock release'") &&
    mainSource.includes('() => lock.release()') &&
    backendWrapperSource.includes('await runtimeOwnerLock.release();'),
);
test(
  'standalone forced shutdown keeps ownership until its complete backend tree is gone',
  backendWrapperSource.includes("execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']") &&
    backendWrapperSource.includes('Refusing to release the runtime lock while the backend PID is still alive.') &&
    backendWrapperSource.includes('Backend is still alive; retaining the runtime lock.') &&
    backendWrapperSource.includes('verifyForcedChildExit()'),
);
const wrapperRunCliSource = backendWrapperSource.match(
  /async function runCli\(\) \{[\s\S]*?(?=\nif \(require\.main === module\))/,
)?.[0] || '';
const wrapperStartupFailureBeforeLiveCheck = wrapperRunCliSource.slice(
  wrapperRunCliSource.indexOf("reportPrepareError(launchContext, 'startup_failed', error);"),
  wrapperRunCliSource.indexOf('if (isChildRunning())'),
);
test(
  'standalone startup failure keeps its guardian until a live backend is force-stopped',
  wrapperRunCliSource.includes('if (isChildRunning())') &&
    wrapperRunCliSource.includes("forceSignalFallback('SIGTERM');") &&
    !wrapperStartupFailureBeforeLiveCheck.includes('stopProcessGuardian()'),
);
test(
  'fatal startup errors route through the shared shutdown sequence',
  mainSource.includes("console.error('[electron] Fatal startup failure:'") &&
    mainSource.includes('await shutdownApplication();') &&
    mainSource.includes("console.error('[electron] Fatal startup cleanup failed:'"),
);
test('uses path.relative containment checks for IPC paths', mainSource.includes('function isPathInsideOrEqual') && mainSource.includes('path.relative'));
test(
  'streams non-HTML frontend assets and buffers only HTML for CSP nonce injection',
  mainSource.includes('function streamStaticFile') &&
    mainSource.includes("contentType === 'text/html' && options.htmlNonce") &&
    mainSource.includes('injectRendererCspNonce') &&
    mainSource.includes('fs.createReadStream'),
);
test(
  'desktop renderer responses use a restrictive per-request CSP',
  mainSource.includes("res.setHeader('Content-Security-Policy', buildRendererContentSecurityPolicy(cspNonce))") &&
    mainSource.includes("script-src 'self' 'nonce-${nonce}'") &&
    mainSource.includes("script-src-attr 'none'") &&
    !mainSource.match(/script-src[^"\n]*unsafe-eval/),
);
test(
  'emergency renderer fallback hash-approves its fixed inline script',
  mainSource.includes('function buildEmergencyFallbackDocument()') &&
    mainSource.includes("crypto.createHash('sha256').update(inlineScript)") &&
    mainSource.includes("script-src 'sha256-${scriptHash}'"),
);
test('legal allowlist includes safety notice', mainSource.includes("'SAFETY-NOTICE.md'"));
test('has Desktop UI URL helper', mainSource.includes('function getFrontendUrl'));
test('loads Desktop UI into the main BrowserWindow', mainSource.includes('loadDesktopApp(mainWindow)'));
test('keeps legacy launcher as fallback', mainSource.includes('function loadLegacyLauncher') && mainSource.includes('Legacy launcher loaded as fallback'));
test('intercepts same-app popup navigation', mainSource.includes('setWindowOpenHandler') && mainSource.includes('isFrontendAppUrl(url)'));
test(
  'accepts only the exact local desktop document as an internal app URL',
  mainSource.includes("return parsed.protocol === 'http:'") &&
    mainSource.includes("parsed.pathname === '/frontend/index.html'"),
);
test('explicitly disables renderer webviews', mainSource.includes('webviewTag: false'));
test(
  'rejects every attempted webview attachment',
  mainSource.includes("mainWindow.webContents.on('will-attach-webview'") &&
    mainSource.includes("mainWindow.webContents.on('will-attach-webview', (event) => {\n    event.preventDefault();"),
);
const topLevelNavigationHandlerMatch = mainSource.match(
  /mainWindow\.webContents\.on\('will-navigate',[\s\S]*?\n  \}\);/,
);
const topLevelNavigationHandler = topLevelNavigationHandlerMatch ? topLevelNavigationHandlerMatch[0] : '';
test(
  'blocks unexpected top-level navigation without disrupting the local frontend',
  topLevelNavigationHandler.includes('if (isFrontendAppUrl(url)) return;') &&
    topLevelNavigationHandler.includes('event.preventDefault();') &&
    topLevelNavigationHandler.includes("openExternalBrowserUrl(url, 'top-level navigation');") &&
    !topLevelNavigationHandler.includes('mainWindow.loadURL'),
);
const externalBrowserUrlHelperMatch = mainSource.match(
  /function openExternalBrowserUrl\([\s\S]*?\n\}/,
);
const externalBrowserUrlHelper = externalBrowserUrlHelperMatch ? externalBrowserUrlHelperMatch[0] : '';
test(
  'external navigation passes only a policy-approved canonical URL to the OS shell',
  externalBrowserUrlHelper.includes('const allowedUrl = resolveAllowedExternalUrl(rawUrl);') &&
    externalBrowserUrlHelper.includes('if (!allowedUrl)') &&
    externalBrowserUrlHelper.includes('shell.openExternal(allowedUrl)') &&
    !externalBrowserUrlHelper.includes('shell.openExternal(rawUrl)'),
);
const openOverlayHandlerMatch = mainSource.match(/registerTrustedIpcHandler\('open-overlay'[\s\S]*?\n\}\);/);
const openOverlayHandler = openOverlayHandlerMatch ? openOverlayHandlerMatch[0] : '';
test('open-overlay navigates the existing Electron window', openOverlayHandler.includes('loadDesktopApp(getWindowFromEvent(event)') && !openOverlayHandler.includes('shell.openExternal'));
const revealInExplorerHandlerMatch = mainSource.match(/registerTrustedIpcHandler\('reveal-in-explorer'[\s\S]*?\n\}\);/);
const revealInExplorerHandler = revealInExplorerHandlerMatch ? revealInExplorerHandlerMatch[0] : '';
test('reveal-in-explorer is limited to Flight Fabric-owned roots', (
  revealInExplorerHandler.includes('docsAppDir') &&
  revealInExplorerHandler.includes('flightLogsAppDir') &&
  revealInExplorerHandler.includes('appDataDir') &&
  !revealInExplorerHandler.includes('isPathInsideOrEqual(docsDir')
));

// Check for single instance lock
test('uses requestSingleInstanceLock', mainSource.includes('requestSingleInstanceLock'));
test('pins Electron userData under the stable Flight Fabric app-data root', mainSource.includes("path.join(getAppDataRoot(), 'Electron')") && mainSource.includes("app.setPath('userData', ELECTRON_USER_DATA_DIR)"));
test('prefers dist/backend in dev mode', mainSource.includes("path.resolve(__dirname, '..', 'dist', 'backend'"));
test('does not fall back to source backend in dev mode', !mainSource.includes("path.resolve(__dirname, '..', 'backend'"));
test('main process registers backend bootstrap fallback IPC', mainSource.includes("registerTrustedIpcHandler('backend-bootstrap'") && mainSource.includes('fetchBackendBootstrapViaBackend'));
test('main process registers SimBrief fallback IPC', mainSource.includes("registerTrustedIpcHandler('simbrief-fetch'") && mainSource.includes('fetchSimbriefViaBackend'));
const trustedIpcChannels = [...mainSource.matchAll(/registerTrustedIpcHandler\('([^']+)'/g)]
  .map((match) => match[1]);
test(
  'every incoming Electron IPC channel uses the trusted sender registrar',
  trustedIpcChannels.length === 24
    && new Set(trustedIpcChannels).size === trustedIpcChannels.length
    && (mainSource.match(/ipcMain\.handle\(/g) || []).length === 1,
);
test(
  'default Electron session installs deny-by-default request and check handlers before creating the UI',
  mainSource.includes('installDefaultSessionPermissionPolicy();')
    && mainSource.includes('electronSession: session.defaultSession')
    && mainSource.indexOf('installDefaultSessionPermissionPolicy();') < mainSource.indexOf('createWindow();'),
);

// ─────────────────────────────────────────────────────────────
// Preload Script Validation
// ─────────────────────────────────────────────────────────────
section('Preload Script');

const preloadSource = fs.readFileSync(path.join(electronDir, 'preload.js'), 'utf8');

// Check for context bridge usage
test('uses contextBridge', preloadSource.includes('contextBridge'));
test('uses exposeInMainWorld', preloadSource.includes('exposeInMainWorld'));
test('exposes electronAPI', preloadSource.includes("'electronAPI'"));

// Check for exposed methods
test('exposes startBackend', preloadSource.includes('startBackend'));
test('exposes stopBackend', preloadSource.includes('stopBackend'));
test('exposes restartBackend', preloadSource.includes('restartBackend'));
test('exposes restartApp', preloadSource.includes('restartApp'));
test('exposes getBackendStatus', preloadSource.includes('getBackendStatus'));
test('exposes backend bootstrap fallback', preloadSource.includes('getBackendBootstrap') && preloadSource.includes("ipcRenderer.invoke('backend-bootstrap'"));
test('exposes fetchSimbrief fallback', preloadSource.includes('fetchSimbrief') && preloadSource.includes("ipcRenderer.invoke('simbrief-fetch'"));
test('exposes getSettings', preloadSource.includes('getSettings'));
test('exposes saveSettings', preloadSource.includes('saveSettings'));
test('exposes resetSettings', preloadSource.includes('resetSettings'));
test('exposes getStorageLocations', preloadSource.includes('getStorageLocations'));
test('exposes setRecordingBadge', preloadSource.includes('setRecordingBadge') && preloadSource.includes("ipcRenderer.invoke('recording-badge-set'"));
test('exposes onBackendStatus listener', preloadSource.includes('onBackendStatus'));
test('exposes onBackendLog listener', preloadSource.includes('onBackendLog'));

// Check for security
test('uses ipcRenderer.invoke (not send)', preloadSource.includes('ipcRenderer.invoke'));
test('returns unsubscribe for listeners', preloadSource.includes('removeListener'));

// ─────────────────────────────────────────────────────────────
// Build Script Validation
// ─────────────────────────────────────────────────────────────
section('Build Script');

const buildScript = fs.readFileSync(path.join(electronDir, 'build-electron.js'), 'utf8');
const afterPackScript = fs.readFileSync(path.join(electronDir, 'after-pack.js'), 'utf8');
const dataSyncScript = fs.readFileSync(path.join(projectRoot, 'scripts', 'sync-aviation-data.js'), 'utf8');
const releaseSummaryScript = fs.readFileSync(path.join(projectRoot, 'scripts', 'electron-release-summary.js'), 'utf8');
const packagedSmokeScript = fs.readFileSync(
  path.join(projectRoot, 'tests', 'scripts', 'test-electron-packaged-smoke.js'),
  'utf8',
);
const rootPackage = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
);

test('handles backend copying', buildScript.includes('copyBackend') || buildScript.includes('backend'));
test('builds bundled frontend', buildScript.includes("runNpm(['--prefix', 'frontend', 'run', 'build']"));
test('build script avoids shell-string execSync', !buildScript.includes('execSync'));
test(
  'native rebuild uses the supported electron-rebuild v4 version flag',
  buildScript.includes("'--version', electronVersion")
    && !buildScript.includes("'--electron-version'"),
);
test(
  'build sources backend dependencies only from the backend lockfile install',
    buildScript.includes("const BACKEND_PACKAGE_LOCK = path.join(BACKEND_SOURCE, 'package-lock.json')") &&
    buildScript.includes("const BACKEND_NODE_MODULES = path.join(BACKEND_SOURCE, 'node_modules')") &&
    buildScript.includes('copyLockedBackendNodeModules') &&
    !buildScript.includes('ROOT_NODE_MODULES') &&
    !buildScript.includes('findInstalledPackageDir'),
);
test(
  'build rejects missing or version-drifted locked transitive dependencies',
  buildScript.includes('Object.entries(lockfile.packages)') &&
    buildScript.includes("lockPath.startsWith('node_modules/')") &&
    buildScript.includes('installedPackage.version !== lockedPackage.version') &&
    buildScript.includes('Missing locked backend dependency') &&
    buildScript.includes('run npm ci --prefix backend'),
);

const backendStagingFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-backend-staging-'));
try {
  const sourceRoot = path.join(backendStagingFixture, 'source');
  const stagedRoot = path.join(backendStagingFixture, 'staged');
  const fixtureProfile = {
    name: 'fixture',
    include: {
      backend: ['entry.js'],
      backend_dirs: ['utils'],
    },
    exclude_patterns: [],
  };
  fs.mkdirSync(path.join(sourceRoot, 'utils'), { recursive: true });
  fs.mkdirSync(path.join(stagedRoot, 'utils'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'entry.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(sourceRoot, 'utils', 'storage-paths.js'), 'module.exports = 2;\n');
  fs.copyFileSync(path.join(sourceRoot, 'entry.js'), path.join(stagedRoot, 'entry.js'));
  fs.copyFileSync(
    path.join(sourceRoot, 'utils', 'storage-paths.js'),
    path.join(stagedRoot, 'utils', 'storage-paths.js')
  );

  const expectedInventory = snapshotBackendRuntimeProfile(sourceRoot, fixtureProfile, {
    rootLabel: 'fixture source',
  });
  const exactStagedInventory = snapshotBackendRuntimeProfile(stagedRoot, fixtureProfile, {
    rootLabel: 'fixture staging',
  });
  let exactStagingAccepted = true;
  try {
    assertBackendRuntimeInventoriesMatch(
      expectedInventory,
      exactStagedInventory,
      'Fixture staging mismatch'
    );
  } catch {
    exactStagingAccepted = false;
  }
  test('backend staging inventory accepts an exact filtered copy', exactStagingAccepted);

  fs.unlinkSync(path.join(stagedRoot, 'utils', 'storage-paths.js'));
  const incompleteStagedInventory = snapshotBackendRuntimeProfile(stagedRoot, fixtureProfile, {
    rootLabel: 'fixture staging',
  });
  let incompleteStagingError = null;
  try {
    assertBackendRuntimeInventoriesMatch(
      expectedInventory,
      incompleteStagedInventory,
      'Fixture staging mismatch'
    );
  } catch (err) {
    incompleteStagingError = err;
  }
  test(
    'backend staging inventory rejects a silently omitted runtime module with its exact path',
    incompleteStagingError?.code === 'FF_BACKEND_STAGING_UNSTABLE'
      && incompleteStagingError.message.includes('missing utils/storage-paths.js')
  );

  fs.writeFileSync(path.join(sourceRoot, 'utils', 'storage-paths.js'), 'module.exports = 3;\n');
  const mutatedSourceInventory = snapshotBackendRuntimeProfile(sourceRoot, fixtureProfile, {
    rootLabel: 'fixture source',
  });
  let sourceMutationError = null;
  try {
    assertBackendRuntimeInventoriesMatch(
      expectedInventory,
      mutatedSourceInventory,
      'Compiled backend runtime changed while staging'
    );
  } catch (err) {
    sourceMutationError = err;
  }
  test(
    'backend staging inventory rejects source mutation during the copy window',
    sourceMutationError?.code === 'FF_BACKEND_STAGING_UNSTABLE'
      && sourceMutationError.message.includes('changed utils/storage-paths.js')
  );

  let missingRequiredDirectoryError = null;
  try {
    snapshotBackendRuntimeProfile(sourceRoot, {
      ...fixtureProfile,
      include: { backend: [], backend_dirs: ['lifecycle'] },
    }, { rootLabel: 'compiled backend runtime' });
  } catch (err) {
    missingRequiredDirectoryError = err;
  }
  test(
    'backend staging refuses a missing required profile directory with a precise retry error',
    missingRequiredDirectoryError?.code === 'FF_BACKEND_STAGING_UNSTABLE'
      && missingRequiredDirectoryError.message.includes('lifecycle')
      && missingRequiredDirectoryError.message.includes('Stop other builds and retry')
  );

  let missingRequiredFileError = null;
  try {
    snapshotBackendRuntimeProfile(sourceRoot, {
      ...fixtureProfile,
      include: { backend: ['missing-entry.js'], backend_dirs: [] },
    }, { rootLabel: 'compiled backend runtime' });
  } catch (err) {
    missingRequiredFileError = err;
  }
  test(
    'backend staging refuses a missing required profile file instead of skipping it',
    missingRequiredFileError?.code === 'FF_BACKEND_STAGING_UNSTABLE'
      && missingRequiredFileError.message.includes('missing-entry.js')
  );
} finally {
  fs.rmSync(backendStagingFixture, { recursive: true, force: true });
}
test(
  'build rejects links, reparse points, and non-regular backend dependency entries',
  buildScript.includes('assertSafeDependencyTree') &&
    buildScript.includes('Backend dependency contains a link or reparse-point entry') &&
    buildScript.includes('Backend dependency contains a non-regular entry') &&
    afterPackScript.includes('Backend dependency contains a link or reparse-point entry') &&
    afterPackScript.includes('Backend dependency contains a non-regular entry'),
);
test(
  'build removes stale release checksums before replacing packaged executables',
  buildScript.includes("/^SHA256SUMS(?:\\.txt)?$/i.test(file)"),
);
test(
  'build invalidates stale artifacts before fallible dependency and source builds',
  buildScript.indexOf('ensureCleanElectronOutput();')
    < buildScript.indexOf('ensureOurAirportsData();'),
);
test(
  'build fails closed when a stale release artifact cannot be removed',
  buildScript.includes('failedArtifactRemovals') &&
    buildScript.includes('Refusing to risk a stale release artifact'),
);
test(
  'build cleanup rejects redirected output directories and linked artifacts',
  buildScript.includes('Refusing to clean a redirected Electron output path') &&
    buildScript.includes("stat.isSymbolicLink()") &&
    buildScript.includes("throw new Error('link or reparse-point entry')"),
);
test(
  'user release builds recreate every owned dependency tree and require native rebuild success',
  buildScript.includes("['root', ROOT]") &&
    buildScript.includes("['backend', BACKEND_SOURCE]") &&
    buildScript.includes("['frontend', FRONTEND_SRC]") &&
    buildScript.includes("['Electron', ELECTRON_DIR]") &&
    buildScript.includes("runNpm(['ci']") &&
    buildScript.includes("HUSKY: '0'") &&
    buildScript.includes("'--skip-native-rebuild is not allowed for the user release profile'") &&
    !buildScript.includes('Continuing build (native modules may not work)'),
);
test(
  'Rust release build uses a fresh locked target and probes the exact binary before copying',
  buildScript.includes("resetRepoScratchDirectory(RUST_SIDECAR_BUILD_TARGET_NAME)") &&
    buildScript.includes("'--locked'") &&
    buildScript.includes("'--target-dir'") &&
    buildScript.indexOf('resetRepoScratchDirectory(RUST_SIDECAR_BUILD_TARGET_NAME)')
      < buildScript.indexOf('execFileSync(CARGO_BIN') &&
    buildScript.indexOf('verifyRustSidecarGuardianCapability(RUST_SIDECAR_BINARY_SRC)')
      < buildScript.indexOf('fs.copyFileSync(RUST_SIDECAR_BINARY_SRC, rustSidecarDest)'),
);
test(
  'ambient SimConnect configuration cannot override an available owned runtime',
  (() => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-simconnect-source-'));
    try {
      const runtimeDir = path.join(fixtureRoot, 'dist-backend');
      const sourceDir = path.join(fixtureRoot, 'source-backend');
      const relativeDll = path.join('telemetry-provider', 'simconnect', 'SimConnect.dll');
      const runtimeDll = path.join(runtimeDir, relativeDll);
      const sourceDll = path.join(sourceDir, relativeDll);
      const ambientDll = path.join(fixtureRoot, 'ambient', 'SimConnect.dll');
      for (const [filePath, contents] of [
        [runtimeDll, 'runtime'],
        [sourceDll, 'source'],
        [ambientDll, 'ambient'],
      ]) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents);
      }

      const options = {
        rootDir: fixtureRoot,
        backendRuntimeDir: runtimeDir,
        backendSourceDir: sourceDir,
        configuredPath: ambientDll,
        sdkPaths: [],
      };
      if (selectSimConnectDllSource(options)?.path !== sourceDll) return false;
      fs.unlinkSync(sourceDll);
      if (selectSimConnectDllSource(options)?.path !== runtimeDll) return false;
      fs.unlinkSync(runtimeDll);
      return selectSimConnectDllSource(options)?.path === ambientDll;
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  })(),
);
test(
  'build requires every legal notice advertised by the installer',
  buildScript.includes("'SAFETY-NOTICE.md'") &&
    buildScript.includes("'THIRD_PARTY_NOTICES.md'") &&
    buildScript.includes("'LICENSE.md'") &&
    buildScript.includes("'OURAIRPORTS-DATA-LICENSE.txt'"),
);
test(
  'release summary generates and verifies checksums for exact versioned artifacts',
  releaseSummaryScript.includes("crypto.createHash('sha256')") &&
    releaseSummaryScript.includes("'SHA256SUMS.txt'") &&
    releaseSummaryScript.includes('`Flight.Fabric.Setup.${version}.exe`') &&
    releaseSummaryScript.includes('writeChecksums([publishedInstaller], checksumPath)') &&
    releaseSummaryScript.includes('verifyChecksumFile(checksumPath, [publishedInstaller])') &&
    releaseSummaryScript.includes('Expected exactly'),
);
test(
  'release summary rejects alternate publishable artifacts and requires the unpacked app',
  releaseSummaryScript.includes('allowedTopLevelNames') &&
    releaseSummaryScript.includes('Unexpected top-level release output') &&
    releaseSummaryScript.includes('expectedBlockmapName') &&
    releaseSummaryScript.includes("const WIN_UNPACKED_EXECUTABLE_NAME = 'Flight Fabric.exe'") &&
    releaseSummaryScript.includes('Required unpacked executable is missing'),
);
test(
  'composite release verifies the same clean source commit when private release tooling is present',
  !rootPackage.scripts?.['release:source:verify']
    || rootPackage.scripts['electron:release'].endsWith('&& npm run release:source:verify'),
);
test('handles dashboard build', buildScript.includes('buildDashboard') || buildScript.includes('--with-dashboard'));
test('supports PyInstaller for dashboard', buildScript.includes('pyinstaller') || buildScript.includes('PyInstaller'));
test('OurAirports sync writes a freshness manifest', dataSyncScript.includes('MANIFEST_FILE_NAME') && dataSyncScript.includes('downloadedAt') && dataSyncScript.includes('sha256'));
test('Electron build enforces OurAirports freshness manifest', buildScript.includes('getOurAirportsFreshnessIssues') && buildScript.includes('OURAIRPORTS_DATA_MAX_AGE_DAYS') && buildScript.includes('manifest.json'));
test('Electron build fetches required OurAirports data before packaging when missing or stale', buildScript.includes("'scripts/sync-aviation-data.js', '--required-only'"));
test('Electron build verifies packaged OurAirports freshness', buildScript.includes('verifyPackagedOurAirportsData') && buildScript.includes('invalid or stale airport data'));
test('Electron build bundles SimConnect DLL for Windows telemetry', buildScript.includes('copySimConnectRuntime') && buildScript.includes('FF_SIMCONNECT_DLL_PATH') && buildScript.includes('SimConnect.dll'));
test('afterPack fails when backend node_modules is missing', afterPackScript.includes('throw new Error') && afterPackScript.includes('Missing backend runtime node_modules'));
test('afterPack verifies required backend dependencies after copying', afterPackScript.includes('missing required backend runtime dependencies') && afterPackScript.includes('packaged backend'));
test('afterPack removes stale destination node_modules before copying', afterPackScript.includes('fs.rmSync(backendModulesDest'));
function probesSharedRuntimeCopy() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-shared-runtime-copy-'));
  const sourceDir = path.join(tempRoot, 'source');
  const destinationDir = path.join(tempRoot, 'destination');
  const requiredFiles = [
    'app-settings-shared.js',
    'flight-phases.js',
    'rust-sidecar-artifact.js',
    'violation-rules.js',
  ];
  try {
    fs.mkdirSync(sourceDir);
    fs.mkdirSync(destinationDir);
    for (const fileName of requiredFiles) {
      fs.writeFileSync(path.join(sourceDir, fileName), `module.exports = ${JSON.stringify(fileName)};\n`);
    }
    fs.writeFileSync(path.join(sourceDir, 'types.d.ts'), 'export {};\n');
    fs.writeFileSync(path.join(destinationDir, 'stale-leftover.js'), 'stale\n');

    copySharedRuntimeAssets(sourceDir, destinationDir, tempRoot);
    return requiredFiles.every((fileName) => fs.existsSync(path.join(destinationDir, fileName)))
      && !fs.existsSync(path.join(destinationDir, 'types.d.ts'))
      && fs.existsSync(path.join(destinationDir, 'stale-leftover.js'));
  } catch {
    return false;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
test(
  'afterPack copies only the required shared runtime without deleting unrelated files',
  probesSharedRuntimeCopy(),
);
function probesSharedRuntimeDestinationGuards() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-shared-runtime-guard-'));
  const sourceDir = path.join(tempRoot, 'source');
  const appOutDir = path.join(tempRoot, 'app-out');
  const resourcesDir = path.join(appOutDir, 'resources');
  const outsideDir = path.join(tempRoot, 'outside');
  const redirectedDestination = path.join(resourcesDir, 'shared');
  const sentinelPath = path.join(outsideDir, 'sentinel.txt');
  let redirected = false;
  try {
    fs.mkdirSync(sourceDir);
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.mkdirSync(outsideDir);
    for (const fileName of [
      'app-settings-shared.js',
      'flight-phases.js',
      'rust-sidecar-artifact.js',
      'violation-rules.js',
    ]) {
      fs.writeFileSync(path.join(sourceDir, fileName), 'module.exports = {};\n');
    }
    fs.writeFileSync(sentinelPath, 'outside\n');

    let escapeRejected = false;
    try {
      copySharedRuntimeAssets(sourceDir, outsideDir, appOutDir);
    } catch (error) {
      escapeRejected = /destination escapes/.test(error.message);
    }
    if (!escapeRejected || fs.readFileSync(sentinelPath, 'utf8') !== 'outside\n') return false;

    try {
      fs.symlinkSync(
        outsideDir,
        redirectedDestination,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      redirected = true;
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) return true;
      throw error;
    }

    let redirectRejected = false;
    try {
      copySharedRuntimeAssets(sourceDir, redirectedDestination, appOutDir);
    } catch (error) {
      redirectRejected = /not a regular directory|link, junction, or reparse point/.test(error.message);
    }
    return redirectRejected && fs.readFileSync(sentinelPath, 'utf8') === 'outside\n';
  } catch {
    return false;
  } finally {
    if (redirected && fs.existsSync(redirectedDestination)) {
      try { fs.unlinkSync(redirectedDestination); } catch {}
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
test(
  'afterPack refuses escaping or redirected shared-runtime write targets',
  probesSharedRuntimeDestinationGuards(),
);
test(
  'Electron builds launch a freshly extracted installer payload before succeeding',
  buildScript.includes('verifyVirginInstallerPayload')
    && buildScript.includes('test-electron-installer-payload.js')
    && buildScript.includes('  verifyVirginInstallerPayload();'),
);
test(
  'afterPack prunes dependency docs, tests, source, and repository metadata',
  afterPackScript.includes("'spec'") &&
    afterPackScript.includes("lowerName.endsWith('.md')") &&
    afterPackScript.includes('isRuntimeTestOrSpecFile') &&
    afterPackScript.includes("lowerName.endsWith('.d.ts')") &&
    afterPackScript.includes("lowerName.endsWith('.js.map')") &&
    afterPackScript.includes("lowerName.endsWith('.log')") &&
    afterPackScript.includes("lowerName === '_template.json'") &&
    afterPackScript.includes("lowerName.endsWith('.mts')") &&
    afterPackScript.includes("'.husky'") &&
    afterPackScript.includes("'.vscode'") &&
    afterPackScript.includes("'.gitattributes'") &&
    afterPackScript.includes("'.npmrc'") &&
    afterPackScript.includes("lowerName.startsWith('tsconfig')") &&
    afterPackScript.includes("lowerName.startsWith('jsconfig')"),
);
test(
  'afterPack preserves dependency license and legal notices',
  afterPackScript.includes('isRuntimeLegalNotice') &&
    afterPackScript.includes('if (isRuntimeLegalNotice(lowerName)) return false'),
);
const runtimeFileEntry = (name) => ({
  name,
  isDirectory: () => false,
  isFile: () => true,
});
test(
  'dependency legal exception cannot preserve test or TypeScript source files',
  shouldExcludeRuntimeModuleEntry(runtimeFileEntry('LICENSE.test.js')) &&
    shouldExcludeRuntimeModuleEntry(runtimeFileEntry('NOTICE.spec.ts')) &&
    shouldExcludeRuntimeModuleEntry(runtimeFileEntry('COPYING.ts')) &&
    !shouldExcludeRuntimeModuleEntry(runtimeFileEntry('LICENSE.md')) &&
    !shouldExcludeRuntimeModuleEntry(runtimeFileEntry('NOTICE.txt')),
);
test(
  'packaged smoke compares actual backend package roots with the locked inventory',
  packagedSmokeScript.includes('unexpected packaged backend dependency') &&
    packagedSmokeScript.includes('missing packaged backend dependency'),
);
test(
  'afterPack applies the project icon to the packaged Windows executable',
  afterPackScript.includes("require('rcedit')") &&
    afterPackScript.includes("path.join(__dirname, 'taskbar-icon.ico')") &&
    afterPackScript.includes('icon: iconPath')
);
test(
  'afterPack stamps Flight Fabric metadata on the packaged Windows executable',
  afterPackScript.includes("'file-version': version") &&
    afterPackScript.includes("'product-version': version") &&
    afterPackScript.includes("'version-string'") &&
    afterPackScript.includes("CompanyName: 'Flight Fabric'") &&
    afterPackScript.includes('FileDescription: productName') &&
    afterPackScript.includes('ProductName: productName')
);
test(
  'afterPack signs the finalized app and owned Rust sidecar when signing is configured',
  afterPackScript.includes('context.packager.signIf(ownedExecutable)') &&
    afterPackScript.includes("'ff-rust-simconnect-sidecar.exe'"),
);
test(
  'afterPack hardens Electron fuses without disabling the packaged backend launcher',
  electronPkg.devDependencies?.['@electron/fuses'] &&
    afterPackScript.includes('strictlyRequireAllFuses: true') &&
    afterPackScript.includes('[FuseV1Options.RunAsNode]: true') &&
    afterPackScript.includes('[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false') &&
    afterPackScript.includes('[FuseV1Options.EnableNodeCliInspectArguments]: false') &&
    afterPackScript.includes('[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true') &&
    afterPackScript.includes('[FuseV1Options.OnlyLoadAppFromAsar]: true') &&
    afterPackScript.includes('getCurrentFuseWire(executablePath)'),
);

// Check package.json extraResources for bundled files
const extraResources = electronPkg.build?.extraResources || [];
const packagedAppFiles = electronPkg.build?.files || [];
const resourcePaths = extraResources.map(r => typeof r === 'string' ? r : r.from).join(' ');
test('build bundles IPC sender policy', packagedAppFiles.includes('ipc-sender-policy.js'));
test('build bundles external URL policy', packagedAppFiles.includes('external-url-policy.js'));
test('build bundles session permission policy', packagedAppFiles.includes('session-permission-policy.js'));
const backendResource = extraResources.find(r => r && typeof r === 'object' && r.from === '../backend-build');
const frontendResource = extraResources.find(r => r && typeof r === 'object' && r.from === '../frontend-dist');
const sharedResource = extraResources.find(r => r && typeof r === 'object' && r.from === '../dist/shared');
const launcherResource = extraResources.find(r => r && typeof r === 'object' && r.from === 'launcher');
const rootLegalResource = extraResources.find(r => r && typeof r === 'object' && r.from === '..' && r.to === 'legal');
const codeResourceFilters = [
  backendResource,
  frontendResource,
  sharedResource,
  launcherResource,
].map(resource => resource?.filter || []);
test('bundles backend', resourcePaths.includes('backend'));
test('bundles frontend', resourcePaths.includes('frontend'));
test('bundles shared runtime assets', resourcePaths.includes('dist/shared'));
test('does not bundle retired live-sharing runtime assets', !resourcePaths.includes('live-sharing'));
const deprecatedExtensionResourcePath = ['dist', 'modules'].join('/');
test('does not bundle deprecated extension runtime assets', !resourcePaths.includes(deprecatedExtensionResourcePath));
test('does not bundle source module folders directly', !resourcePaths.includes('../modules'));
test('bundles electron launcher', resourcePaths.includes('launcher'));
test('shared runtime resources exclude TypeScript declarations', (sharedResource?.filter || []).includes('!**/*.d.ts'));
test('code resource roots exclude source maps and TypeScript files', codeResourceFilters.every(filter => (
  filter.includes('!**/*.map') && filter.includes('!**/*.ts') && filter.includes('!**/*.d.ts')
)));
test('backend resources exclude dependency samples and tests', (backendResource?.filter || []).every(pattern => typeof pattern === 'string')
  && (backendResource?.filter || []).includes('!**/samples/**')
  && (backendResource?.filter || []).includes('!**/examples/**')
  && (backendResource?.filter || []).includes('!**/test/**')
  && (backendResource?.filter || []).includes('!**/tests/**'));
test('backend resources exclude all environment-specific secret files',
  (backendResource?.filter || []).includes('!**/.env')
  && (backendResource?.filter || []).includes('!**/.env.*'));
test('bundles OurAirports notice from the root legal notice set', (rootLegalResource?.filter || []).includes('OURAIRPORTS-DATA-LICENSE.txt'));
test('does not bundle the repository legal folder', !resourcePaths.includes('../legal'));

// ─────────────────────────────────────────────────────────────
// Path Resolution Tests
// ─────────────────────────────────────────────────────────────
section('Path Resolution');

// Simulate development paths (what main.js calculates)
const devAppRoot = path.resolve(__dirname, '..');
const devBackendScript = resolveBackendEntry();
const devLauncherHtml = path.join(devAppRoot, 'electron', 'launcher', 'index.html');

test('dev backend script path exists', fs.existsSync(devBackendScript));
test('dev launcher HTML path exists', fs.existsSync(devLauncherHtml));

// ─────────────────────────────────────────────────────────────
// Dashboard Files (Additive - for hybrid mode)
// ─────────────────────────────────────────────────────────────
section('Dashboard Files');

const dashboardDir = path.join(projectRoot, 'tools', 'flight-dashboard');
const hasDashboard = fs.existsSync(dashboardDir);

if (!hasDashboard) {
  console.log('  - dashboard not present (optional feature), skipping checks');
} else {
  test('dashboard app.py exists', fs.existsSync(path.join(dashboardDir, 'app.py')));
  test('dashboard_launcher.py exists', fs.existsSync(path.join(dashboardDir, 'dashboard_launcher.py')));
  test('flight-dashboard.spec exists', fs.existsSync(path.join(dashboardDir, 'flight-dashboard.spec')));
}

// Validate launcher script contents
const launcherPath = path.join(dashboardDir, 'dashboard_launcher.py');
if (hasDashboard && fs.existsSync(launcherPath)) {
  const launcherSource = fs.readFileSync(launcherPath, 'utf8');
  test('launcher handles frozen mode', launcherSource.includes('sys.frozen') || launcherSource.includes('_MEIPASS'));
  test('launcher imports streamlit', launcherSource.includes('streamlit'));
  test('launcher accepts --port arg', launcherSource.includes('--port'));
}

// Validate spec file contents  
const specPath = path.join(dashboardDir, 'flight-dashboard.spec');
if (hasDashboard && fs.existsSync(specPath)) {
  const specSource = fs.readFileSync(specPath, 'utf8');
  test('spec defines Analysis', specSource.includes('Analysis('));
  test('spec has hidden imports', specSource.includes('hiddenimports'));
  test('spec includes app.py', specSource.includes('app.py'));
}

// ─────────────────────────────────────────────────────────────
// Backend Script Compatibility
// ─────────────────────────────────────────────────────────────
section('Backend Compatibility');

const backendScript = resolveBackendEntry();
const backendSource = fs.readFileSync(backendScript, 'utf8');
const backendEntrySource = fs.readFileSync(path.join(projectRoot, 'backend', 'core', 'simbridge.ts'), 'utf8');
const backendConfigSource = fs.readFileSync(path.join(projectRoot, 'backend', 'core', 'config.ts'), 'utf8');

// Backend should work when forked
test('backend is valid Node.js (no top-level await)', !backendSource.match(/^await\s/m));
test('backend has WS port config', backendSource.includes('wsPort') || backendSource.includes('WS'));
test(
  'backend stdin shutdown and EOF handling require the Electron lifeline opt-in',
  backendConfigSource.includes("parentStdinLifeline: bool('FF_PARENT_STDIN_LIFELINE', false)") &&
    backendEntrySource.includes('if (config.env.parentStdinLifeline && !process.stdin.isTTY)') &&
    backendEntrySource.includes("message?.type !== 'shutdown'") &&
    backendEntrySource.includes("parentInput.on('close'") &&
    backendEntrySource.includes("handleShutdown('parent_stdin_eof')"),
);

// ─────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────
void Promise.all(pendingTests).then(() => {
  console.log('\n' + '─'.repeat(60));
  console.log(`Electron tests: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(60));

  if (failed > 0) {
    console.log('\n⚠️  Some tests failed');
    process.exit(1);
  } else {
    console.log('\nAll tests passed ✓');
    process.exit(0);
  }
});
