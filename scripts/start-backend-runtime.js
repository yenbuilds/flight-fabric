#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const {
  ROOT,
  resolveBackendEntry,
  resolveBackendRuntimeFile,
} = require('./backend-runtime-paths');
const { acquireRuntimeOwnerLock } = require('../electron/runtime-owner-lock');
const { isManagedProcessAlive } = require('../electron/process-liveness');
const {
  selectNewestManagedRustSidecar,
} = require('../shared/rust-sidecar-artifact.js');

const PREPARE_RUNTIME_FLAG = '--ff-wrapper-prepare-runtime';
const LAUNCH_OWNER_FLAG = '--ff-launch-owner';
const LAUNCH_NONCE_FLAG = '--ff-launch-nonce';
const SAFE_NONCE_PATTERN = /^[0-9a-f]{64}$/i;
const HANDSHAKE_DIR = path.join(ROOT, '.tmp');
const PREPARE_SCRIPT = path.join(ROOT, 'scripts', 'prepare-start-runtime.js');
const PREPARE_CONTROL_TIMEOUT_MS = 120000;
const PREPARE_CONTROL_POLL_MS = 100;
const PROCESS_GUARDIAN_READY_MARKER = '[FF_PROCESS_GUARDIAN_READY]';
const PROCESS_GUARDIAN_READY_TIMEOUT_MS = 5000;
const BACKEND_READY_MARKER = '[SIMBRIDGE_READY]';
const BACKEND_READY_TIMEOUT_MS = 30000;
const BACKEND_LINE_BUFFER_MAX_LENGTH = 64 * 1024;
const SIGNAL_FALLBACK_TIMEOUT_MS = 12000;

let child = null;
let processGuardian = null;
let runtimeOwnerLock = null;
let launchContext = null;
let forwardingSignal = false;
let finishing = false;
let shutdownRequested = false;
let signalFallbackTimer = null;

function createLaunchNonce() {
  return crypto.randomBytes(32).toString('hex');
}

function readConsumedFlagValue(args, index, flagName) {
  const arg = args[index];
  const normalizedArg = String(arg).toLowerCase();
  const normalizedFlag = flagName.toLowerCase();
  if (normalizedArg.startsWith(`${normalizedFlag}=`)) {
    return { consumed: 1, value: String(arg).slice(flagName.length + 1) };
  }
  if (normalizedArg !== normalizedFlag) return null;
  const next = args[index + 1];
  if (typeof next === 'string' && !next.startsWith('--')) {
    return { consumed: 2, value: next };
  }
  return { consumed: 1, value: '' };
}

function canonicalizeBackendArgs(rawArgs, nonceFactory = createLaunchNonce) {
  const forwarded = [];
  let prepareRuntime = false;
  let launchNonce = null;

  for (let index = 0; index < rawArgs.length;) {
    const arg = String(rawArgs[index]);
    if (arg.toLowerCase() === PREPARE_RUNTIME_FLAG) {
      prepareRuntime = true;
      index += 1;
      continue;
    }

    const ownerFlag = readConsumedFlagValue(rawArgs, index, LAUNCH_OWNER_FLAG);
    if (ownerFlag) {
      index += ownerFlag.consumed;
      continue;
    }

    const nonceFlag = readConsumedFlagValue(rawArgs, index, LAUNCH_NONCE_FLAG);
    if (nonceFlag) {
      if (!launchNonce && SAFE_NONCE_PATTERN.test(nonceFlag.value)) {
        launchNonce = nonceFlag.value.toLowerCase();
      }
      index += nonceFlag.consumed;
      continue;
    }

    forwarded.push(arg);
    index += 1;
  }

  launchNonce = String(launchNonce || nonceFactory()).toLowerCase();
  if (!SAFE_NONCE_PATTERN.test(launchNonce)) {
    throw new Error('Launch nonce generation did not return 64 hexadecimal characters');
  }

  forwarded.push(`${LAUNCH_OWNER_FLAG}=batch`);
  forwarded.push(`${LAUNCH_NONCE_FLAG}=${launchNonce}`);
  return Object.freeze({
    args: forwarded,
    launchNonce,
    prepareRuntime,
  });
}

function replacePortArgs(args, wsPort, httpPort) {
  const forwarded = [];
  for (let index = 0; index < args.length;) {
    const arg = args[index];
    const wsFlag = readConsumedFlagValue(args, index, '--ws-port');
    const httpFlag = readConsumedFlagValue(args, index, '--http-port');
    const consumedFlag = wsFlag || httpFlag;
    if (consumedFlag) {
      index += consumedFlag.consumed;
      continue;
    }
    forwarded.push(arg);
    index += 1;
  }
  forwarded.push('--ws-port', String(wsPort), '--http-port', String(httpPort));
  return forwarded;
}

function assertSafeLaunchNonce(value) {
  const nonce = String(value || '').toLowerCase();
  if (!SAFE_NONCE_PATTERN.test(nonce)) {
    throw new Error('Wrapper handshake nonce must be 64 hexadecimal characters');
  }
  return nonce;
}

function getWrapperHandshakePaths(value) {
  const nonce = assertSafeLaunchNonce(value);
  const baseName = `ff-wrapper-${nonce}`;
  return Object.freeze({
    ready: path.join(HANDSHAKE_DIR, `${baseName}.ready.json`),
    control: path.join(HANDSHAKE_DIR, `${baseName}.control.json`),
  });
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' });
    try {
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      if (!error || (error.code !== 'EEXIST' && error.code !== 'EPERM')) throw error;
      // Windows rename does not replace an existing destination. Readers only
      // ever see complete JSON files; if they hit this tiny replacement gap,
      // their polling loop treats it as not ready yet and retries.
      fs.rmSync(filePath, { force: true });
      fs.renameSync(temporaryPath, filePath);
    }
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function readWrapperReady(value) {
  const nonce = assertSafeLaunchNonce(value);
  const state = readJsonIfPresent(getWrapperHandshakePaths(nonce).ready);
  if (!state) return null;
  if (state.nonce !== nonce) throw new Error('Wrapper ready handshake nonce mismatch');
  return state;
}

function writeWrapperControl(value, action) {
  const nonce = assertSafeLaunchNonce(value);
  if (action !== 'go' && action !== 'abort') {
    throw new Error('Wrapper control action must be go or abort');
  }
  atomicWriteJson(getWrapperHandshakePaths(nonce).control, { nonce, action });
}

function cleanupWrapperHandshake(value) {
  const paths = getWrapperHandshakePaths(value);
  fs.rmSync(paths.ready, { force: true });
  fs.rmSync(paths.control, { force: true });
}

function writePrepareStatus(context, status) {
  if (!context || !context.prepareRuntime) return;
  atomicWriteJson(context.handshakePaths.ready, {
    nonce: context.launchNonce,
    ...status,
  });
}

function reportPrepareError(context, code, error) {
  if (!context || !context.prepareRuntime) return;
  const message = error && error.message ? error.message : String(error || code);
  try {
    writePrepareStatus(context, { status: 'error', code, message });
  } catch (writeError) {
    console.error(`[start-backend-runtime] Failed to report preparation error: ${writeError.message}`);
  }
}

function normalizeRuntimePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} port must be an integer from 1 through 65535`);
  }
  return port;
}

function resolvePreparedRuntimePorts() {
  const configPath = resolveBackendRuntimeFile('core', 'config.js');
  delete require.cache[require.resolve(configPath)];
  const config = require(configPath);
  const wsPort = normalizeRuntimePort(config?.ws?.port, 'WebSocket');
  const httpPort = normalizeRuntimePort(config?.http?.port, 'HTTP');
  if (wsPort === httpPort) {
    throw new Error('WebSocket and HTTP ports must be different');
  }
  return Object.freeze({ wsPort, httpPort });
}

function runRuntimePreparation() {
  execFileSync(process.execPath, [PREPARE_SCRIPT], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWrapperControl(context) {
  const deadline = Date.now() + PREPARE_CONTROL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const control = readJsonIfPresent(context.handshakePaths.control);
    if (control) {
      if (control.nonce !== context.launchNonce) {
        throw new Error('Wrapper control handshake nonce mismatch');
      }
      if (control.action === 'go' || control.action === 'abort') return control.action;
      throw new Error('Wrapper control handshake contained an invalid action');
    }
    await delay(PREPARE_CONTROL_POLL_MS);
  }
  throw new Error('Timed out waiting for the batch launcher to authorize backend startup');
}

function firstExistingPath(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function resolveProcessGuardianBinary(backendEntry) {
  if (process.platform !== 'win32') return null;
  const binaryName = 'ff-rust-simconnect-sidecar.exe';
  const backendRoot = path.dirname(path.dirname(backendEntry));
  const managedRuntimeBinary = selectNewestManagedRustSidecar(
    path.join(backendRoot, 'telemetry-provider'),
    binaryName,
  );
  const managedPackagedBinary = selectNewestManagedRustSidecar(
    path.join(ROOT, 'backend-build', 'telemetry-provider'),
    binaryName,
  );
  return firstExistingPath([
    managedRuntimeBinary,
    managedPackagedBinary,
    path.join(ROOT, 'backend', 'telemetry-provider', 'rust-simconnect-sidecar', 'target', 'release', binaryName),
    path.join(ROOT, 'backend', 'telemetry-provider', 'rust-simconnect-sidecar', 'target', 'debug', binaryName),
    path.join(ROOT, 'backend', 'telemetry-provider', binaryName),
  ]);
}

function isChildRunning(target = child) {
  return isManagedProcessAlive(target);
}

function isGuardianRunning() {
  return isManagedProcessAlive(processGuardian);
}

function stopProcessGuardian() {
  if (!isGuardianRunning()) return;
  try {
    processGuardian.kill('SIGTERM');
  } catch {}
}

function waitForProcessGuardianReady(guardian) {
  return new Promise((resolve, reject) => {
    let lineBuffer = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      guardian.stdout?.removeListener('data', onStdout);
      guardian.stdout?.removeListener('error', onStdoutError);
      guardian.stderr?.removeListener('error', onStderrError);
      guardian.removeListener('error', onError);
      guardian.removeListener('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onStdout = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      lineBuffer += text;
      if (lineBuffer.length > BACKEND_LINE_BUFFER_MAX_LENGTH) {
        lineBuffer = lineBuffer.slice(-BACKEND_LINE_BUFFER_MAX_LENGTH);
      }
      for (;;) {
        const newlineIndex = lineBuffer.indexOf('\n');
        if (newlineIndex < 0) break;
        const line = lineBuffer.slice(0, newlineIndex).replace(/\r$/, '');
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        if (line === PROCESS_GUARDIAN_READY_MARKER) {
          finish();
          return;
        }
      }
    };
    const onError = (error) => finish(new Error(`Process guardian failed to launch: ${error.message}`));
    const onStdoutError = (error) => finish(new Error(`Process guardian stdout failed: ${error.message}`));
    const onStderrError = (error) => finish(new Error(`Process guardian stderr failed: ${error.message}`));
    const onExit = (code, signal) => finish(new Error(
      `Process guardian exited before ready (code ${code ?? 'none'}, signal ${signal || 'none'})`,
    ));
    const timer = setTimeout(
      () => finish(new Error('Timed out waiting for the process guardian to become ready')),
      PROCESS_GUARDIAN_READY_TIMEOUT_MS,
    );
    guardian.stdout?.on('data', onStdout);
    guardian.stdout?.once('error', onStdoutError);
    guardian.stderr?.once('error', onStderrError);
    guardian.once('error', onError);
    guardian.once('exit', onExit);
  });
}

function waitForBackendReadyMarker(backendChild) {
  return new Promise((resolve, reject) => {
    let lineBuffer = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      backendChild.stdout?.removeListener('data', onStdout);
      backendChild.stdout?.removeListener('error', onStreamError);
      backendChild.removeListener('error', onError);
      backendChild.removeListener('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onStdout = (chunk) => {
      lineBuffer += chunk.toString();
      if (lineBuffer.length > BACKEND_LINE_BUFFER_MAX_LENGTH) {
        lineBuffer = lineBuffer.slice(-BACKEND_LINE_BUFFER_MAX_LENGTH);
      }
      for (;;) {
        const newlineIndex = lineBuffer.indexOf('\n');
        if (newlineIndex < 0) break;
        const line = lineBuffer.slice(0, newlineIndex).replace(/\r$/, '');
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        if (line === BACKEND_READY_MARKER) {
          finish();
          return;
        }
      }
    };
    const onError = (error) => finish(new Error(`Backend failed before readiness: ${error.message}`));
    const onStreamError = (error) => finish(new Error(`Backend stdout failed before readiness: ${error.message}`));
    const onExit = (code, signal) => finish(new Error(
      `Backend exited before ${BACKEND_READY_MARKER} (code ${code ?? 'none'}, signal ${signal || 'none'})`,
    ));
    const timer = setTimeout(
      () => finish(new Error(`Timed out waiting for exact backend marker ${BACKEND_READY_MARKER}`)),
      BACKEND_READY_TIMEOUT_MS,
    );
    backendChild.stdout?.on('data', onStdout);
    backendChild.stdout?.once('error', onStreamError);
    backendChild.once('error', onError);
    backendChild.once('exit', onExit);
  });
}

async function startProcessGuardian(backendEntry, backendChild) {
  if (process.platform !== 'win32') return;
  const guardianBinary = resolveProcessGuardianBinary(backendEntry);
  if (!guardianBinary) {
    throw new Error('Rust process guardian is required on Windows but its executable was not found');
  }
  if (!backendChild || !Number.isInteger(backendChild.pid) || backendChild.pid <= 0) {
    throw new Error('Backend PID was unavailable for process guardian startup');
  }

  const guardian = spawn(guardianBinary, [
    '--process-guardian',
    `--ff-owner-pid=${process.pid}`,
    `--ff-target-pid=${backendChild.pid}`,
  ], {
    cwd: path.dirname(guardianBinary),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processGuardian = guardian;
  guardian.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  const onGuardianStreamError = (streamName) => (error) => {
    if (!isChildRunning(backendChild)) return;
    console.error(`[start-backend-runtime] Process guardian ${streamName} failed: ${error.message}`);
    shutdownRequested = true;
    forceSignalFallback('SIGTERM');
  };
  guardian.stdout?.on('error', onGuardianStreamError('stdout'));
  guardian.stderr?.on('error', onGuardianStreamError('stderr'));
  await waitForProcessGuardianReady(guardian);

  guardian.once('exit', (code, signal) => {
    if (processGuardian === guardian) processGuardian = null;
    if (!isChildRunning(backendChild)) return;
    console.error(
      `[start-backend-runtime] Process guardian exited while the backend was still running `
      + `(code ${code ?? 'none'}, signal ${signal || 'none'}); stopping the backend tree.`,
    );
    shutdownRequested = true;
    forceSignalFallback('SIGTERM');
  });
  guardian.once('error', (error) => {
    if (!isChildRunning(backendChild)) return;
    console.error(`[start-backend-runtime] Process guardian failed: ${error.message}`);
    shutdownRequested = true;
    forceSignalFallback('SIGTERM');
  });
}

function verifyForcedChildExit(attempt = 0) {
  if (!isChildRunning()) {
    stopProcessGuardian();
    void finish(forwardingSignal ? 0 : 1);
    return;
  }
  if (attempt >= 20) {
    console.error('[start-backend-runtime] Backend PID is still alive after forced tree termination; retaining the runtime lock.');
    return;
  }
  setTimeout(() => verifyForcedChildExit(attempt + 1), 150);
}

function forceSignalFallback(signal) {
  if (!isChildRunning()) return true;

  if (process.platform === 'win32') {
    try {
      // The backend owns native sidecars. A parent-only TerminateProcess can
      // strand them, so the Windows fallback must always target the full tree.
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5000,
      });
      verifyForcedChildExit();
      return true;
    } catch (error) {
      if (!isChildRunning()) {
        verifyForcedChildExit();
        return true;
      }
      console.error(`[start-backend-runtime] Failed to stop backend process tree: ${error.message || error}`);
      return false;
    }
  }

  try {
    return child.kill(signal);
  } catch (error) {
    console.error(`[start-backend-runtime] Failed to signal backend: ${error.message || error}`);
    return false;
  }
}

function forwardSignal(signal) {
  forwardingSignal = true;
  if (!child) {
    void finish(0);
    return;
  }

  if (!isChildRunning(child)) {
    void finish(0);
    return;
  }
  if (shutdownRequested) {
    forceSignalFallback(signal);
    return;
  }
  shutdownRequested = true;

  const input = child.stdin;
  if (!input || input.destroyed || input.writableEnded) {
    forceSignalFallback(signal);
    return;
  }

  const reason = `wrapper_${signal.toLowerCase()}`;
  const message = `${JSON.stringify({ type: 'shutdown', reason })}\n`;
  const onInputError = () => forceSignalFallback(signal);
  input.once('error', onInputError);
  try {
    input.end(message, () => input.removeListener('error', onInputError));
  } catch {
    input.removeListener('error', onInputError);
    forceSignalFallback(signal);
    return;
  }

  // If the backend's stdin handler is unavailable or cleanup wedges, own the
  // complete tree kill before the backend's later parent-only last resort.
  signalFallbackTimer = setTimeout(
    () => forceSignalFallback(signal),
    SIGNAL_FALLBACK_TIMEOUT_MS,
  );
  signalFallbackTimer.unref();
}

function installSignalHandlers() {
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((signal) => {
    process.on(signal, () => forwardSignal(signal));
  });
}

async function finish(code) {
  if (finishing) return;
  if (isChildRunning()) {
    console.error('[start-backend-runtime] Refusing to release the runtime lock while the backend PID is still alive.');
    return;
  }
  finishing = true;
  stopProcessGuardian();
  if (signalFallbackTimer) {
    clearTimeout(signalFallbackTimer);
    signalFallbackTimer = null;
  }
  if (runtimeOwnerLock) {
    await runtimeOwnerLock.release();
    runtimeOwnerLock = null;
  }
  process.exit(code);
}

function wireBackendLifecycle(backendChild) {
  // Always drain and forward backend stdout. Readiness parsing uses its own
  // bounded line buffer, so redirected wrapper output cannot block the child.
  backendChild.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk);
  });
  backendChild.stderr?.on('data', (chunk) => {
    process.stderr.write(chunk);
  });
  const onBackendStreamError = (streamName) => (error) => {
    console.error(`[start-backend-runtime] Backend ${streamName} failed: ${error.message}`);
    if (!isChildRunning(backendChild)) return;
    if (!launchContext?.backendReady) {
      reportPrepareError(launchContext, 'backend_output_stream_failed', error);
    }
    shutdownRequested = true;
    forceSignalFallback('SIGTERM');
  };
  backendChild.stdout?.on('error', onBackendStreamError('stdout'));
  backendChild.stderr?.on('error', onBackendStreamError('stderr'));
  backendChild.stdin?.on('error', (error) => {
    if (!isChildRunning(backendChild) || shutdownRequested) return;
    console.error(`[start-backend-runtime] Backend stdin failed: ${error.message}`);
    if (!launchContext?.backendReady) {
      reportPrepareError(launchContext, 'backend_input_stream_failed', error);
    }
    shutdownRequested = true;
    forceSignalFallback('SIGTERM');
  });

  // Tests and other redirected launches can send the same structured shutdown
  // command used by Electron. Do not propagate wrapper stdin EOF: redirected
  // input ending is not proof that the wrapper itself died.
  if (!process.stdin.isTTY && backendChild.stdin) {
    process.stdin.pipe(backendChild.stdin, { end: false });
  }

  backendChild.on('error', (error) => {
    console.error(`[start-backend-runtime] Failed to launch backend: ${error.message}`);
    // ChildProcess also emits `error` when a later kill operation fails. A PID
    // means this wrapper still owns a potentially live backend; retain the lock
    // and use the tree-aware fallback instead of abandoning it.
    if (isChildRunning(backendChild)) {
      console.error('[start-backend-runtime] Backend is still alive; retaining the runtime lock.');
      if (shutdownRequested) forceSignalFallback('SIGTERM');
      return;
    }
    void finish(1);
  });

  backendChild.on('exit', (code, signal) => {
    if (launchContext?.prepareRuntime && !launchContext.backendReady) {
      reportPrepareError(
        launchContext,
        'backend_exited_before_ready',
        new Error(`Backend exited before ${BACKEND_READY_MARKER}`),
      );
    }
    if (signal && !forwardingSignal) {
      console.error(`[start-backend-runtime] Backend exited due to signal ${signal}`);
      void finish(1);
      return;
    }
    void finish(code ?? 0);
  });
}

function spawnBackend(backendEntry, backendArgs) {
  const backendChild = spawn(process.execPath, [backendEntry, ...backendArgs], {
    cwd: path.dirname(backendEntry),
    env: {
      ...process.env,
      FF_PARENT_STDIN_LIFELINE: '1',
    },
    // Keep a wrapper-owned pipe open for the backend's full lifetime. If this
    // process is killed, Windows closes the write handle and the backend treats
    // EOF as a parent-death shutdown request. The native process guardian is a
    // second, handle-based guarantee for abrupt wrapper termination on Windows.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child = backendChild;
  wireBackendLifecycle(backendChild);
  return backendChild;
}

async function main(rawArgs = process.argv.slice(2)) {
  const canonical = canonicalizeBackendArgs(rawArgs);
  launchContext = {
    ...canonical,
    handshakePaths: getWrapperHandshakePaths(canonical.launchNonce),
  };
  if (launchContext.prepareRuntime) cleanupWrapperHandshake(launchContext.launchNonce);

  const lock = await acquireRuntimeOwnerLock({ owner: 'standalone' });
  if (!lock.acquired) {
    const error = new Error(
      'Another Flight Fabric launch mode is active. '
      + 'Quit the desktop app or close the other standalone backend first.',
    );
    console.error(`[start-backend-runtime] ${error.message}`);
    reportPrepareError(launchContext, 'runtime_owner_lock_held', error);
    process.exitCode = 2;
    return;
  }
  runtimeOwnerLock = lock;

  let backendArgs = launchContext.args;
  if (launchContext.prepareRuntime) {
    runRuntimePreparation();
  }

  // Entry resolution may trigger a backend build. Keep it behind the shared
  // owner lock so no launch mode can execute against a half-replaced runtime.
  const backendEntry = resolveBackendEntry();

  if (launchContext.prepareRuntime) {
    const ports = resolvePreparedRuntimePorts();
    backendArgs = replacePortArgs(backendArgs, ports.wsPort, ports.httpPort);
    launchContext.ports = ports;
    writePrepareStatus(launchContext, { status: 'prepared', ...ports });
    const action = await waitForWrapperControl(launchContext);
    if (action === 'abort') {
      cleanupWrapperHandshake(launchContext.launchNonce);
      await finish(0);
      return;
    }
    fs.rmSync(launchContext.handshakePaths.control, { force: true });
  }

  const backendChild = spawnBackend(backendEntry, backendArgs);
  const backendReady = waitForBackendReadyMarker(backendChild);
  // This await is the boundary between merely having a backend PID and having
  // a launch that is both guarded against wrapper death and provider-ready.
  await Promise.all([
    startProcessGuardian(backendEntry, backendChild),
    backendReady,
  ]);
  launchContext.backendReady = true;
  if (launchContext.prepareRuntime) {
    writePrepareStatus(launchContext, { status: 'ready', ...launchContext.ports });
  }
}

async function runCli() {
  installSignalHandlers();
  try {
    await main();
  } catch (error) {
    console.error(`[start-backend-runtime] Startup failed: ${error.message}`);
    reportPrepareError(launchContext, 'startup_failed', error);
    if (isChildRunning()) {
      // Keep the native guardian alive until the failed backend is confirmed
      // gone. Stopping it first would create a crash window where an abrupt
      // wrapper exit could abandon the backend and its native sidecars.
      shutdownRequested = true;
      forceSignalFallback('SIGTERM');
      return;
    }
    await finish(1);
  }
}

if (require.main === module) {
  void runCli();
}

module.exports = {
  PREPARE_RUNTIME_FLAG,
  canonicalizeBackendArgs,
  cleanupWrapperHandshake,
  getWrapperHandshakePaths,
  readWrapperReady,
  replacePortArgs,
  resolveProcessGuardianBinary,
  resolvePreparedRuntimePorts,
  writeWrapperControl,
};
