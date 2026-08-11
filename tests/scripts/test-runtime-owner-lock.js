#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {
  acquireRuntimeOwnerLock,
  normalizeLockPort,
} = require('../../electron/runtime-owner-lock');
const { classifyFlightFabricBackendIdentity } = require('../../electron/backend-process-identity');
const {
  PREPARE_RUNTIME_FLAG,
  canonicalizeBackendArgs,
  cleanupWrapperHandshake,
  readWrapperReady,
  writeWrapperControl,
} = require('../../scripts/start-backend-runtime');
const {
  captureCurrentUserWindowsProcessIdentity,
  forceStopVerifiedWindowsProcessTree,
  hasExactCommandLineArgument,
  readCurrentWindowsOwnerSid,
} = require('./windows-process-cleanup');

const SAFE_TEST_NONCE = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function waitForExit(child, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => reject(new Error('wrapper did not exit in time')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function waitForReady(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`wrapper backend did not become ready\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes('[SIMBRIDGE_READY]')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`wrapper exited before ready (code ${code}, signal ${signal || 'none'})\n${stderr}`));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWrapperState(nonce, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readWrapperReady(nonce);
    if (state && predicate(state)) return state;
    await delay(100);
  }
  throw new Error(`wrapper handshake ${nonce} did not reach the expected state`);
}

function isPortOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(open);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitForPortsReleased(ports, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = await Promise.all(ports.map((port) => isPortOpen(port)));
    if (states.every((open) => !open)) return;
    await delay(100);
  }
  throw new Error(`backend ports did not close after wrapper death: ${ports.join(', ')}`);
}

async function waitForDefaultLock(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = await acquireRuntimeOwnerLock({ owner: 'after-wrapper-death-test' });
    if (lock.acquired) return lock;
    await delay(100);
  }
  throw new Error('default runtime owner lock was not released after wrapper death');
}

function isExpectedTestBackendIdentity(identity) {
  return classifyFlightFabricBackendIdentity(identity) === 'stoppable'
    && hasExactCommandLineArgument(identity.commandLine, '--ff-launch-owner=batch')
    && hasExactCommandLineArgument(
      identity.commandLine,
      `--ff-launch-nonce=${SAFE_TEST_NONCE}`,
    );
}

function forceCleanupPorts(ports) {
  if (process.platform !== 'win32') return;
  try {
    const ownerSid = readCurrentWindowsOwnerSid();
    if (!ownerSid) return;
    const output = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
    const wanted = new Set(ports.map(String));
    const pids = new Set();
    for (const line of output.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 5 || fields[0].toUpperCase() !== 'TCP' || fields[3] !== 'LISTENING') continue;
      const localPort = fields[1].match(/:(\d+)$/)?.[1];
      if (localPort && wanted.has(localPort)) pids.add(fields[4]);
    }
    for (const pid of pids) {
      const identity = captureCurrentUserWindowsProcessIdentity(pid, {
        ownerSid,
        predicate: isExpectedTestBackendIdentity,
      });
      if (identity) forceStopVerifiedWindowsProcessTree(identity);
    }
  } catch {}
}

function forceCleanup(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {}
}

function verifyBatchPortValidation(root) {
  if (process.platform !== 'win32') return;

  const cases = [
    {
      env: { SIMBRIDGE_WS_PORT: '0', HTTP_PORT: '18100' },
      expected: 'WebSocket port must be an integer from 1 through 65535.',
    },
    {
      env: { SIMBRIDGE_WS_PORT: '18100', HTTP_PORT: '18100' },
      expected: 'WebSocket and HTTP ports must be different.',
    },
  ];

  for (const testCase of cases) {
    const result = spawnSync('cmd.exe', ['/d', '/c', 'start-simbridge.bat <NUL'], {
      cwd: root,
      env: {
        ...process.env,
        ...testCase.env,
      },
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    assert.equal(result.error, undefined, `batch validation should execute: ${result.error?.message || ''}`);
    assert.equal(result.status, 1, `invalid batch ports should exit 1\n${output}`);
    assert.match(output, /ERROR: Invalid backend port configuration\./);
    assert.ok(output.includes(testCase.expected), `expected validation detail was missing\n${output}`);
    assert.doesNotMatch(output, /\[prep\]/, 'invalid ports should fail before runtime preparation or launch');
  }
}

function verifyCanonicalWrapperOwnership() {
  const preservedNonce = 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789';
  const canonical = canonicalizeBackendArgs([
    '--mock',
    '--ff-launch-owner=electron',
    '--ff-launch-owner', 'spoofed-owner',
    '--FF-LAUNCH-OWNER=electron',
    '--ff-launch-nonce=not-safe',
    '--ff-launch-nonce', preservedNonce,
    '--ff-launch-nonce=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    '--FF-LAUNCH-NONCE=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    PREPARE_RUNTIME_FLAG,
  ], () => 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');

  assert.equal(canonical.prepareRuntime, true, 'private preparation flag should be consumed by the wrapper');
  assert.ok(!canonical.args.includes(PREPARE_RUNTIME_FLAG), 'private preparation flag must not reach the backend');
  assert.deepEqual(
    canonical.args.filter((arg) => arg.startsWith('--ff-launch-owner')),
    ['--ff-launch-owner=batch'],
    'wrapper should replace every caller-supplied owner with one canonical batch owner',
  );
  assert.deepEqual(
    canonical.args.filter((arg) => arg.startsWith('--ff-launch-nonce')),
    [`--ff-launch-nonce=${preservedNonce.toLowerCase()}`],
    'wrapper should preserve only the first safe nonce and remove all duplicates',
  );

  const generated = canonicalizeBackendArgs(
    ['--ff-launch-nonce=unsafe', '--ff-launch-owner=electron'],
    () => 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  );
  assert.equal(
    generated.launchNonce,
    'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    'wrapper should generate a safe nonce when callers do not provide one',
  );
}

async function verifyConcurrentPreparationSerialization(root, wrapper, env) {
  const firstNonce = '1111111111111111111111111111111111111111111111111111111111111111';
  const secondNonce = '2222222222222222222222222222222222222222222222222222222222222222';
  cleanupWrapperHandshake(firstNonce);
  cleanupWrapperHandshake(secondNonce);

  const first = spawn(process.execPath, [
    wrapper,
    PREPARE_RUNTIME_FLAG,
    `--ff-launch-nonce=${firstNonce}`,
  ], {
    cwd: root,
    env: { ...env, FF_START_SIMBRIDGE_SKIP_BUILD: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let firstStdout = '';
  let firstStderr = '';
  first.stdout.on('data', (chunk) => { firstStdout += chunk.toString(); });
  first.stderr.on('data', (chunk) => { firstStderr += chunk.toString(); });
  let second = null;
  try {
    const prepared = await waitForWrapperState(firstNonce, (state) => state.status === 'prepared');
    assert.ok(Number.isInteger(prepared.wsPort), 'locked preparation should publish the effective WebSocket port');
    assert.ok(Number.isInteger(prepared.httpPort), 'locked preparation should publish the effective HTTP port');

    second = spawn(process.execPath, [
      wrapper,
      PREPARE_RUNTIME_FLAG,
      `--ff-launch-nonce=${secondNonce}`,
    ], {
      cwd: root,
      env: { ...env, FF_START_SIMBRIDGE_SKIP_BUILD: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const secondExit = await waitForExit(second, 5000);
    assert.equal(secondExit.code, 2, 'a concurrent preparation wrapper should fail on the shared lock');
    const blocked = await waitForWrapperState(secondNonce, (state) => state.status === 'error');
    assert.equal(blocked.code, 'runtime_owner_lock_held', 'blocked preparation should report lock ownership, not run concurrently');

    writeWrapperControl(firstNonce, 'abort');
    const firstExit = await waitForExit(first, 5000);
    assert.equal(firstExit.code, 0, 'aborting prepared startup should release the lock without spawning a backend');
  } catch (error) {
    throw new Error(
      `${error.message}\nFIRST WRAPPER STDOUT:\n${firstStdout}\nFIRST WRAPPER STDERR:\n${firstStderr}`,
    );
  } finally {
    forceCleanup(first);
    forceCleanup(second);
    cleanupWrapperHandshake(firstNonce);
    cleanupWrapperHandshake(secondNonce);
  }
}

async function verifyPreparedLaunchReadiness(root, wrapper, env, wsPort, httpPort) {
  const nonce = '3333333333333333333333333333333333333333333333333333333333333333';
  cleanupWrapperHandshake(nonce);
  const preparedWrapper = spawn(process.execPath, [
    wrapper,
    '--mock',
    PREPARE_RUNTIME_FLAG,
    `--ff-launch-nonce=${nonce}`,
  ], {
    cwd: root,
    env: {
      ...env,
      FF_START_SIMBRIDGE_SKIP_BUILD: '1',
      SIMBRIDGE_WS_PORT: String(wsPort),
      HTTP_PORT: String(httpPort),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  preparedWrapper.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  preparedWrapper.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    const stdoutReady = waitForReady(preparedWrapper);
    const prepared = await waitForWrapperState(nonce, (state) => state.status === 'prepared');
    assert.deepEqual(
      { wsPort: prepared.wsPort, httpPort: prepared.httpPort },
      { wsPort, httpPort },
      'prepared handshake should publish the post-build effective ports',
    );
    writeWrapperControl(nonce, 'go');
    await waitForWrapperState(nonce, (state) => state.status === 'ready', 30000);
    await stdoutReady;
    cleanupWrapperHandshake(nonce);

    preparedWrapper.stdin.end(`${JSON.stringify({ type: 'shutdown', reason: 'prepared_launch_test' })}\n`);
    const exit = await waitForExit(preparedWrapper);
    assert.equal(exit.code, 0, 'a fully prepared and guarded wrapper should shut down cleanly');
  } catch (error) {
    throw new Error(`${error.message}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  } finally {
    forceCleanup(preparedWrapper);
    cleanupWrapperHandshake(nonce);
  }
}

async function main() {
  const root = path.resolve(__dirname, '..', '..');
  verifyBatchPortValidation(root);
  verifyCanonicalWrapperOwnership();

  const port = await findFreePort();
  assert.ok(port > 0, 'test port should be allocated');
  assert.equal(normalizeLockPort(port), port);

  const electronLock = await acquireRuntimeOwnerLock({ owner: 'electron-test', port });
  assert.equal(electronLock.acquired, true, 'first launch mode should acquire the lock');

  const standaloneLock = await acquireRuntimeOwnerLock({ owner: 'standalone-test', port });
  assert.equal(standaloneLock.acquired, false, 'second launch mode should fail closed');

  await electronLock.release();
  await electronLock.release();

  const replacementLock = await acquireRuntimeOwnerLock({ owner: 'replacement-test', port });
  assert.equal(replacementLock.acquired, true, 'lock should be reusable after owner shutdown');
  await replacementLock.release();

  const wrapper = path.join(root, 'scripts', 'start-backend-runtime.js');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-runtime-owner-lock-'));
  const wsPort = await findFreePort();
  let httpPort = await findFreePort();
  while (httpPort === wsPort) httpPort = await findFreePort();
  const env = {
    ...process.env,
    APPDATA: path.join(tempRoot, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(tempRoot, 'AppData', 'Local'),
    USERPROFILE: tempRoot,
  };
  await verifyConcurrentPreparationSerialization(root, wrapper, env);
  await verifyPreparedLaunchReadiness(root, wrapper, env, wsPort, httpPort);
  const args = [
    wrapper,
    '--mock',
    '--ws-port', String(wsPort),
    '--http-port', String(httpPort),
    '--ff-launch-owner=batch',
    `--ff-launch-nonce=${SAFE_TEST_NONCE}`,
  ];
  const firstWrapper = spawn(process.execPath, args, {
    cwd: root,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let hardDeathWrapper = null;

  try {
    await waitForReady(firstWrapper);

    // The lock is per Windows user, not per mutable USERPROFILE value. The
    // wrapper deliberately runs with a temporary home while this parent keeps
    // its normal environment, so both processes must still contend on one lock.
    const crossEnvironmentLock = await acquireRuntimeOwnerLock({ owner: 'parent-cross-env-check' });
    if (crossEnvironmentLock.acquired) await crossEnvironmentLock.release();
    assert.equal(crossEnvironmentLock.acquired, false, 'same-user launches with different USERPROFILE values should share the default lock');

    const blockedWrapper = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const blockedExit = await waitForExit(blockedWrapper, 5000);
    assert.equal(blockedExit.code, 2, 'second standalone wrapper should fail before spawning');

    firstWrapper.stdin.end(`${JSON.stringify({ type: 'shutdown', reason: 'runtime_owner_lock_test' })}\n`);
    const firstExit = await waitForExit(firstWrapper);
    assert.equal(firstExit.code, 0, 'owning wrapper should release its lock after graceful backend exit');

    const afterWrapperLock = await acquireRuntimeOwnerLock({ owner: 'after-wrapper-test' });
    assert.equal(afterWrapperLock.acquired, true, 'standalone wrapper should release the shared default lock');
    await afterWrapperLock.release();

    if (process.platform === 'win32') {
      hardDeathWrapper = spawn(process.execPath, args, {
        cwd: root,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      await waitForReady(hardDeathWrapper);

      // Redirected wrapper input ending must not masquerade as wrapper death.
      hardDeathWrapper.stdin.end();
      await delay(300);
      assert.equal(hardDeathWrapper.exitCode, null, 'wrapper should remain alive after redirected stdin EOF');
      const openStates = await Promise.all([wsPort, httpPort].map((value) => isPortOpen(value)));
      assert.deepEqual(openStates, [true, true], 'backend should remain available while its wrapper is alive');

      // SIGKILL maps to TerminateProcess on Windows and targets this direct
      // child only (there is deliberately no process-tree termination). The
      // dedicated stdin pipe must close and make the backend exit on its own.
      assert.equal(hardDeathWrapper.kill('SIGKILL'), true, 'wrapper hard kill should be delivered');
      await waitForExit(hardDeathWrapper, 5000);
      await waitForPortsReleased([wsPort, httpPort]);

      const afterDeathLock = await waitForDefaultLock();
      await afterDeathLock.release();
    }
  } finally {
    forceCleanup(firstWrapper);
    forceCleanup(hardDeathWrapper);
    forceCleanupPorts([wsPort, httpPort]);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log('Runtime owner lock test passed');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
