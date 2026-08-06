#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { classifyFlightFabricBackendIdentity } = require('../../electron/backend-process-identity');
const { acquireRuntimeOwnerLock } = require('../../electron/runtime-owner-lock');
const {
  captureCurrentUserWindowsProcessIdentity,
  forceStopVerifiedWindowsProcessTree,
  hasExactCommandLineArgument,
  readCurrentWindowsOwnerSid,
} = require('./windows-process-cleanup');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_EXE = path.join(ROOT, 'dist', 'electron', 'win-unpacked', 'Flight Fabric.exe');
const START_TIMEOUT_MS = 60000;
const EXIT_TIMEOUT_MS = 30000;
const PROCESS_EXIT_TIMEOUT_MS = 10000;
const OWNED_PID_FILE_PREFIXES = [
  'flight-fabric-lvar-sidecar-',
  'flight-fabric-sdk-',
  'flight-fabric-rust-simvars-sidecar-',
];

function resolvePackagedExecutable() {
  const explicitExeIndex = process.argv.indexOf('--exe');
  const explicitExe = explicitExeIndex >= 0 ? process.argv[explicitExeIndex + 1] : '';
  const exePath = explicitExe ? path.resolve(ROOT, explicitExe) : DEFAULT_EXE;
  if (!fs.existsSync(exePath)) {
    throw new Error(`Packaged Electron executable does not exist: ${exePath}`);
  }
  return exePath;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tail(value, maxLength = 6000) {
  const text = String(value || '');
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.listen(0, '127.0.0.1');
  });
}

function isProcessAlive(pid) {
  const normalizedPid = Math.trunc(Number(pid));
  if (!Number.isFinite(normalizedPid) || normalizedPid <= 0) return false;
  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function forceStopPid(pid, initialIdentity, options = {}) {
  const normalizedPid = Math.trunc(Number(pid));
  if (!Number.isFinite(normalizedPid) || normalizedPid <= 0 || process.platform !== 'win32') return false;
  const identity = initialIdentity || captureCurrentUserWindowsProcessIdentity(normalizedPid, {
    ownerSid: options.ownerSid,
    predicate: options.predicate,
  });
  return identity ? forceStopVerifiedWindowsProcessTree(identity) : false;
}

function isLifecycleElectronIdentity(identity, nonce) {
  return hasExactCommandLineArgument(identity.commandLine, `--ff-lifecycle-smoke=${nonce}`);
}

function isLifecycleBackendIdentity(identity) {
  return classifyFlightFabricBackendIdentity(identity) === 'electron';
}

function isLifecycleGuardianIdentity(identity, electronPid, backendPid) {
  return hasExactCommandLineArgument(identity.commandLine, '--process-guardian')
    && hasExactCommandLineArgument(identity.commandLine, `--ff-owner-pid=${electronPid}`)
    && hasExactCommandLineArgument(identity.commandLine, `--ff-target-pid=${backendPid}`);
}

function isLifecycleSidecarIdentity(identity, backendPid) {
  return identity.commandLine.toLowerCase().includes('ff-rust-simconnect-sidecar')
    && hasExactCommandLineArgument(identity.commandLine, `--ff-owner-pid=${backendPid}`);
}

function readStatusEvents(statusPath) {
  if (!fs.existsSync(statusPath)) return [];
  const lines = fs.readFileSync(statusPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const events = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line)); } catch {}
  }
  return events;
}

async function waitForStatusEvent(statusPath, eventName, child, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = readStatusEvents(statusPath).find((candidate) => candidate?.event === eventName);
    if (event) return event;
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`Packaged Electron exited before lifecycle event ${eventName}`);
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for packaged Electron lifecycle event ${eventName}`);
}

function waitForChildExit(child, timeoutMs = EXIT_TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Packaged Electron PID ${child.pid} did not exit`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

function listOwnedSidecarPidFiles(ownerPid, filesPresentBeforeLaunch) {
  const records = [];
  for (const entry of fs.readdirSync(os.tmpdir())) {
    if (filesPresentBeforeLaunch.has(entry) || !entry.endsWith('.pid')) continue;
    if (!OWNED_PID_FILE_PREFIXES.some((prefix) => entry.startsWith(prefix))) continue;
    const filePath = path.join(os.tmpdir(), entry);
    try {
      const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const pid = Math.trunc(Number(record?.pid));
      if (Number(record?.ownerPid) !== ownerPid || !Number.isFinite(pid) || pid <= 0) continue;
      if (isProcessAlive(pid)) records.push({ filePath, pid });
    } catch {}
  }
  return records;
}

async function waitForOwnedSidecars(ownerPid, filesPresentBeforeLaunch, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const records = listOwnedSidecarPidFiles(ownerPid, filesPresentBeforeLaunch);
    if (records.length > 0) return records;
    await delay(50);
  }
  return listOwnedSidecarPidFiles(ownerPid, filesPresentBeforeLaunch);
}

async function waitForProcessesToExit(pids, timeoutMs = PROCESS_EXIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessAlive(pid))) return true;
    await delay(50);
  }
  return pids.every((pid) => !isProcessAlive(pid));
}

function canListenOnPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function waitForPortsReleased(ports, timeoutMs = PROCESS_EXIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await Promise.all(ports.map(canListenOnPort))).every(Boolean)) return true;
    await delay(50);
  }
  return (await Promise.all(ports.map(canListenOnPort))).every(Boolean);
}

async function waitForRuntimeOwnerLockRelease(timeoutMs = PROCESS_EXIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = await acquireRuntimeOwnerLock({ owner: 'packaged-lifecycle-postflight' });
    if (lock.acquired) return lock;
    await delay(50);
  }
  return null;
}

function assertEvent(events, name, predicate = () => true) {
  const event = events.find((candidate) => candidate?.event === name && predicate(candidate));
  if (!event) throw new Error(`Lifecycle status is missing expected event ${name}`);
  return event;
}

async function runPackagedLifecycleScenario(action) {
  if (!['quit', 'hard-death'].includes(action)) throw new Error(`Unknown lifecycle action: ${action}`);
  if (process.platform !== 'win32') {
    console.log(`Packaged Electron lifecycle ${action} scenario skipped (Windows only)`);
    return;
  }
  const currentWindowsOwnerSid = readCurrentWindowsOwnerSid();
  if (!currentWindowsOwnerSid) {
    throw new Error('Cannot run packaged lifecycle probe without the current Windows owner SID');
  }

  const exePath = resolvePackagedExecutable();
  const chromiumDebugLogPath = path.join(path.dirname(exePath), 'debug.log');
  const chromiumDebugLogExistedBefore = fs.existsSync(chromiumDebugLogPath);
  const lockProbe = await acquireRuntimeOwnerLock({ owner: 'packaged-lifecycle-test-preflight' });
  if (!lockProbe.acquired) {
    throw new Error(`Cannot run packaged lifecycle probe while another Flight Fabric launch mode owns ${lockProbe.path}`);
  }
  await lockProbe.release();
  let wsPort = await findFreePort();
  let httpPort = await findFreePort();
  while (httpPort === wsPort) httpPort = await findFreePort();

  const nonce = crypto.randomBytes(16).toString('hex');
  const smokeRoot = path.resolve(os.tmpdir(), `flight-fabric-electron-lifecycle-${nonce}`);
  const statusPath = path.join(smokeRoot, 'status.jsonl');
  const profileRoot = path.join(smokeRoot, 'profile');
  fs.mkdirSync(profileRoot, { recursive: true });

  const filesPresentBeforeLaunch = new Set(fs.readdirSync(os.tmpdir()));
  let child = null;
  let stdout = '';
  let stderr = '';
  let backendPid = null;
  let guardianPid = null;
  let childIdentity = null;
  let backendIdentity = null;
  let guardianIdentity = null;
  let ownedSidecarRecords = [];

  try {
    const env = {
      ...process.env,
      HOME: profileRoot,
      USERPROFILE: profileRoot,
      APPDATA: path.join(profileRoot, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(profileRoot, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(profileRoot, '.config'),
      OneDrive: path.join(profileRoot, 'OneDrive'),
      FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS: '1',
      SIMBRIDGE_WS_PORT: String(wsPort),
      HTTP_PORT: String(httpPort),
      FF_ELECTRON_LIFECYCLE_SMOKE_NONCE: nonce,
      FF_ELECTRON_LIFECYCLE_SMOKE_STATUS: statusPath,
      FF_ELECTRON_LIFECYCLE_SMOKE_ACTION: action,
    };
    delete env.ELECTRON_RUN_AS_NODE;

    child = childProcess.spawn(exePath, [
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--in-process-gpu',
      `--ff-lifecycle-smoke=${nonce}`,
      `--ff-lifecycle-status=${statusPath}`,
      `--ff-lifecycle-action=${action}`,
    ], {
      cwd: path.dirname(exePath),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stdout?.on('error', (error) => { stderr += `\nstdout pipe: ${error.message || error}`; });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stderr?.on('error', (error) => { stderr += `\nstderr pipe: ${error.message || error}`; });
    child.once('error', (error) => { stderr += `\nprocess error: ${error.message || error}`; });

    const managedReady = await waitForStatusEvent(statusPath, 'managed-ready', child);
    backendPid = Math.trunc(Number(managedReady.backendPid));
    guardianPid = Math.trunc(Number(managedReady.guardianPid));
    if (!Number.isFinite(backendPid) || backendPid <= 0 || !Number.isFinite(guardianPid) || guardianPid <= 0) {
      throw new Error(`Lifecycle ready event had invalid managed PIDs: ${JSON.stringify(managedReady)}`);
    }
    if (backendPid === guardianPid || backendPid === child.pid || guardianPid === child.pid) {
      throw new Error('Lifecycle ready event did not identify three distinct managed processes');
    }
    if (managedReady.wsPort !== wsPort || managedReady.httpPort !== httpPort || managedReady.action !== action) {
      throw new Error(`Lifecycle ready event reported unexpected ports: ${JSON.stringify(managedReady)}`);
    }

    childIdentity = captureCurrentUserWindowsProcessIdentity(child.pid, {
      ownerSid: currentWindowsOwnerSid,
      predicate: (identity) => isLifecycleElectronIdentity(identity, nonce),
    });
    backendIdentity = captureCurrentUserWindowsProcessIdentity(backendPid, {
      ownerSid: currentWindowsOwnerSid,
      predicate: isLifecycleBackendIdentity,
    });
    guardianIdentity = captureCurrentUserWindowsProcessIdentity(guardianPid, {
      ownerSid: currentWindowsOwnerSid,
      predicate: (identity) => isLifecycleGuardianIdentity(identity, child.pid, backendPid),
    });
    if (!childIdentity || !backendIdentity || !guardianIdentity) {
      const unverifiedRoles = [
        !childIdentity && 'Electron',
        !backendIdentity && 'backend',
        !guardianIdentity && 'guardian',
      ].filter(Boolean);
      throw new Error(
        `Lifecycle ready event processes could not be verified as current test-owned instances: ${unverifiedRoles.join(', ')}`,
      );
    }

    ownedSidecarRecords = await waitForOwnedSidecars(backendPid, filesPresentBeforeLaunch);
    if (ownedSidecarRecords.length === 0) {
      throw new Error(`Backend PID ${backendPid} reached managed-ready without a live owned Rust sidecar`);
    }
    for (const record of ownedSidecarRecords) {
      record.identity = captureCurrentUserWindowsProcessIdentity(record.pid, {
        ownerSid: currentWindowsOwnerSid,
        predicate: (identity) => isLifecycleSidecarIdentity(identity, backendPid),
      });
    }

    let exit;
    if (action === 'hard-death') {
      const appExit = waitForChildExit(child);
      // On Windows ChildProcess.kill maps to TerminateProcess for this exact
      // PID; it deliberately does not perform a process-tree kill. The Rust
      // guardian must independently terminate the backend.
      if (!child.kill('SIGKILL')) {
        throw new Error(`Could not terminate Electron PID ${child.pid} for hard-death scenario`);
      }
      exit = await appExit;
    } else {
      exit = await waitForChildExit(child);
      if (exit.code !== 0 || exit.signal) {
        throw new Error(`Packaged Electron exited abnormally (code=${exit.code}, signal=${exit.signal || 'none'})`);
      }
    }

    const events = readStatusEvents(statusPath);
    assertEvent(events, 'backend-ready', (event) => event.backendPid === backendPid);
    assertEvent(events, 'guardian-ready', (event) => event.guardianPid === guardianPid);
    if (action === 'quit') {
      assertEvent(events, 'quit-requested');
      assertEvent(events, 'before-quit');
      assertEvent(events, 'shutdown-start');
      assertEvent(events, 'backend-exit', (event) => event.backendPid === backendPid);
      assertEvent(events, 'frontend-stopped', (event) => event.success === true);
      assertEvent(events, 'runtime-lock-released', (event) => event.success === true);
      assertEvent(events, 'app-exit');
      if (events.some((event) => event?.event === 'shutdown-blocked')) {
        throw new Error('Packaged Electron reported a blocked shutdown');
      }
    }

    const managedPids = [child.pid, backendPid, guardianPid, ...ownedSidecarRecords.map((record) => record.pid)];
    if (!(await waitForProcessesToExit(managedPids))) {
      const survivors = managedPids.filter(isProcessAlive);
      throw new Error(`Managed processes survived Electron ${action}: ${survivors.join(', ')}`);
    }
    if (!(await waitForPortsReleased([wsPort, httpPort]))) {
      throw new Error(`Backend ports remained bound after Electron ${action}: ${wsPort}, ${httpPort}`);
    }
    const releasedRuntimeLock = await waitForRuntimeOwnerLockRelease();
    if (!releasedRuntimeLock) {
      throw new Error(`Runtime-owner lock remained held after Electron ${action}`);
    }
    await releasedRuntimeLock.release();
  } catch (error) {
    const events = readStatusEvents(statusPath);
    error.message += `\nEvents: ${JSON.stringify(events)}\nSTDOUT:\n${tail(stdout)}\nSTDERR:\n${tail(stderr)}`;
    throw error;
  } finally {
    forceStopPid(child?.pid, childIdentity, {
      ownerSid: currentWindowsOwnerSid,
      predicate: (identity) => isLifecycleElectronIdentity(identity, nonce),
    });
    forceStopPid(backendPid, backendIdentity, {
      ownerSid: currentWindowsOwnerSid,
      predicate: isLifecycleBackendIdentity,
    });
    forceStopPid(guardianPid, guardianIdentity, {
      ownerSid: currentWindowsOwnerSid,
      predicate: (identity) => isLifecycleGuardianIdentity(identity, child?.pid, backendPid),
    });
    for (const record of ownedSidecarRecords) {
      forceStopPid(record.pid, record.identity, {
        ownerSid: currentWindowsOwnerSid,
        predicate: (identity) => isLifecycleSidecarIdentity(identity, backendPid),
      });
      try { fs.unlinkSync(record.filePath); } catch {}
    }
    const cleanupPids = [
      child?.pid,
      backendPid,
      guardianPid,
      ...ownedSidecarRecords.map((record) => record.pid),
    ].filter((pid) => Number.isFinite(Number(pid)) && Number(pid) > 0);
    await waitForProcessesToExit(cleanupPids, 5000);
    if (path.dirname(statusPath) === smokeRoot && path.basename(statusPath) === 'status.jsonl') {
      try {
        fs.rmSync(smokeRoot, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch (cleanupError) {
        console.warn(`Could not remove lifecycle temp directory ${smokeRoot}: ${cleanupError.message || cleanupError}`);
      }
    }
    if (!chromiumDebugLogExistedBefore) {
      try { fs.unlinkSync(chromiumDebugLogPath); } catch {}
    }
  }

  console.log(`Packaged Electron lifecycle ${action} scenario passed`);
  console.log(`Electron ${action} stopped backend ${backendPid}, guardian ${guardianPid}, and ${ownedSidecarRecords.length} Rust sidecar(s)`);
  console.log(`Released backend ports ${wsPort} and ${httpPort}`);
}

async function runPackagedLifecycleProbe() {
  await runPackagedLifecycleScenario('quit');
  await runPackagedLifecycleScenario('hard-death');
}

runPackagedLifecycleProbe().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
