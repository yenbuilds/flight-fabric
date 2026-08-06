#!/usr/bin/env node
'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { resolveBackendEntry } = require('./backend-runtime-paths');

const ROOT = path.resolve(__dirname, '..', '..');

const BACKEND_ENTRY = resolveBackendEntry();

let testWsPort = 0;
let testHttpPort = 0;
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-shutdown-smoke-'));
const TEST_APPDATA = path.join(TEST_ROOT, 'AppData', 'Roaming');

let failed = 0;

function ok(message) {
  console.log(`✓ ${message}`);
}

function fail(message) {
  console.log(`✗ ${message}`);
  failed += 1;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canListenOnPort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, host);
  });
}

function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.once('error', reject);
    tester.once('listening', () => {
      const address = tester.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      tester.close(() => resolve(port));
    });
    tester.listen(0, host);
  });
}

function canConnectToPort(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(result);
    }

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));

    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

async function waitForPortReachable(port, shouldBeReachable, timeoutMs = 10000) {
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    const reachable = await canConnectToPort(port);
    if (reachable === shouldBeReachable) return true;
    await wait(100);
  }
  return false;
}

function waitForReady(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let buffer = '';

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for [SIMBRIDGE_READY]'));
    }, timeoutMs);

    function onData(data) {
      const text = data.toString();
      buffer += text;
      if (buffer.includes('[SIMBRIDGE_READY]')) {
        cleanup();
        resolve();
      }
    }

    function onExit(code) {
      cleanup();
      reject(new Error(`Backend exited before ready (code=${code})`));
    }

    function cleanup() {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    }

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
  });
}

function waitForExit(child, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for backend process exit'));
    }, timeoutMs);

    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function startBackendProcess({ parentStdinLifeline = false, requireHook = null } = {}) {
  const nodeArgs = [];
  if (requireHook) nodeArgs.push('--require', requireHook);
  nodeArgs.push(BACKEND_ENTRY, '--mock', '--ws-port', String(testWsPort), '--http-port', String(testHttpPort));
  return spawn(process.execPath, nodeArgs, {
    cwd: path.dirname(BACKEND_ENTRY),
    stdio: [parentStdinLifeline ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      APPDATA: TEST_APPDATA,
      ELECTRON_PACKAGED: '0',
      FF_PARENT_STDIN_LIFELINE: parentStdinLifeline ? '1' : '0',
    },
  });
}

async function runFatalStartupScenario() {
  console.log('\n--- Fatal provider startup cleanup ---');

  const wsFreeBefore = await canListenOnPort(testWsPort);
  const httpFreeBefore = await canListenOnPort(testHttpPort);
  if (!wsFreeBefore || !httpFreeBefore) {
    fail(`Pre-check failed: test ports ${testWsPort}/${testHttpPort} must be free`);
    return;
  }

  const hookPath = path.join(TEST_ROOT, 'inject-fatal-provider.js');
  fs.writeFileSync(hookPath, `
'use strict';
const Module = require('module');
const originalLoad = Module._load;
const provider = {
  capabilities: { isMock: true, enableLandingRunner: false },
  setBroadcast() {},
  async start() {
    // Let both server listen callbacks run first. This proves the fatal path is
    // cleaning up resources already acquired before the provider rejects.
    await new Promise((resolve) => setTimeout(resolve, 500));
    throw new Error('injected_provider_start_failure');
  },
  async nextFrame() { return {}; },
  async stop() {},
};
const providerModule = {
  createProvider() { return provider; },
  getDataSourceInfo() {
    return {
      primary: { type: 'mock', name: 'Injected failure', connected: false },
      secondary: [],
      sources: [],
    };
  },
};
Module._load = function(request) {
  if (request === '../telemetry-provider') return providerModule;
  return originalLoad.apply(this, arguments);
};
`, 'utf8');

  const child = startBackendProcess({ requireHook: hookPath });
  let output = '';
  child.stdout.on('data', (data) => { output += data.toString(); });
  child.stderr.on('data', (data) => { output += data.toString(); });

  let exit;
  try {
    exit = await waitForExit(child, 10000);
  } catch (err) {
    fail(`Fatal startup did not terminate the backend: ${err.message}`);
    try { child.kill('SIGKILL'); } catch {}
    return;
  }

  const listenersWereBound = output.includes('[ws] Bound') && output.includes('[http] Bound');
  const falselyClaimedReady = output.includes('[SIMBRIDGE_READY]');
  if (
    exit.code === 1
    && listenersWereBound
    && !falselyClaimedReady
    && output.includes('injected_provider_start_failure')
  ) {
    ok('Fatal provider startup rolls back without claiming backend readiness');
  } else {
    fail(`Fatal provider startup exit was code=${exit.code} signal=${exit.signal}; output=${output.trim()}`);
  }

  const wsReleased = await waitForPortReachable(testWsPort, false, 10000);
  const httpReleased = await waitForPortReachable(testHttpPort, false, 10000);
  if (wsReleased && httpReleased) {
    ok(`Ports ${testWsPort}/${testHttpPort} released after fatal startup`);
  } else {
    fail(`Ports ${testWsPort}/${testHttpPort} remained bound after fatal startup`);
  }
}

async function runScenario({ label, shutdownLabel, shutdownAction, parentStdinLifeline = false }) {
  console.log(`\n--- ${label} ---`);

  const wsFreeBefore = await canListenOnPort(testWsPort);
  const httpFreeBefore = await canListenOnPort(testHttpPort);

  if (!wsFreeBefore || !httpFreeBefore) {
    fail(`Pre-check failed: test ports ${testWsPort}/${testHttpPort} must be free`);
    return;
  }

  const child = startBackendProcess({ parentStdinLifeline });

  child.stdout.on('data', (d) => {
    const txt = d.toString().trim();
    if (txt) console.log(`[backend] ${txt}`);
  });
  child.stderr.on('data', (d) => {
    const txt = d.toString().trim();
    if (txt) console.log(`[backend:err] ${txt}`);
  });

  try {
    await waitForReady(child);
    ok('Backend reached ready state');
  } catch (err) {
    fail(err.message);
    try { child.kill('SIGKILL'); } catch {}
    return;
  }

  const wsBound = await waitForPortReachable(testWsPort, true, 10000);
  const httpBound = await waitForPortReachable(testHttpPort, true, 10000);
  if (wsBound && httpBound) {
    ok(`Ports ${testWsPort}/${testHttpPort} are bound while running`);
  } else {
    fail(`Expected ports ${testWsPort}/${testHttpPort} to be bound while running`);
  }

  try {
    shutdownAction(child);
  } catch (err) {
    fail(`Failed to send ${shutdownLabel}: ${err.message}`);
    try { child.kill('SIGKILL'); } catch {}
    return;
  }

  try {
    await waitForExit(child);
    ok(`Backend exited after ${shutdownLabel}`);
  } catch (err) {
    fail(err.message);
    try { child.kill('SIGKILL'); } catch {}
    return;
  }

  const wsReleased = await waitForPortReachable(testWsPort, false, 10000);
  const httpReleased = await waitForPortReachable(testHttpPort, false, 10000);

  if (wsReleased && httpReleased) {
    ok(`Ports ${testWsPort}/${testHttpPort} released after ${shutdownLabel}`);
  } else {
    fail(`Ports ${testWsPort}/${testHttpPort} not released in time after ${shutdownLabel}`);
  }
}

async function main() {
  testWsPort = await findFreePort();
  testHttpPort = await findFreePort();
  while (testHttpPort === testWsPort) testHttpPort = await findFreePort();

  console.log('=== Shutdown Smoke Test ===');
  console.log(`Backend entry: ${BACKEND_ENTRY}`);
  console.log(`Test ports: WS ${testWsPort}, HTTP ${testHttpPort}`);

  await runFatalStartupScenario();

  await runScenario({
    label: 'Graceful shutdown (SIGTERM)',
    shutdownLabel: 'SIGTERM',
    shutdownAction: (child) => child.kill('SIGTERM'),
  });

  await runScenario({
    label: 'Electron graceful shutdown (parent stdin command)',
    shutdownLabel: 'parent stdin shutdown command',
    parentStdinLifeline: true,
    shutdownAction: (child) => child.stdin.write(`${JSON.stringify({ type: 'shutdown', reason: 'shutdown_smoke' })}\n`),
  });

  await runScenario({
    label: 'Electron crash cleanup (parent stdin EOF)',
    shutdownLabel: 'parent stdin EOF',
    parentStdinLifeline: true,
    shutdownAction: (child) => child.stdin.end(),
  });

  await runScenario({
    label: 'Forced termination (SIGKILL)',
    shutdownLabel: 'SIGKILL',
    shutdownAction: (child) => child.kill('SIGKILL'),
  });

  console.log('\n------------------------------------');
  if (failed > 0) {
    console.log(`Shutdown smoke test failed: ${failed} check(s)`);
    process.exit(1);
  }

  console.log('Shutdown smoke test passed');
}

main()
  .catch((err) => {
    console.error('Shutdown smoke test crashed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });
