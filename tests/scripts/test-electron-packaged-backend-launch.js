#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_EXE = path.join(ROOT, 'dist', 'electron', 'win-unpacked', 'Flight Fabric.exe');
const READY_MARKER = '[SIMBRIDGE_READY]';
const LAUNCH_TIMEOUT_MS = 15000;
const SIDECAR_EXIT_TIMEOUT_MS = 10000;
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

function tail(value, maxLength = 6000) {
  const text = String(value || '');
  return text.length > maxLength ? text.slice(text.length - maxLength) : text;
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function listOwnedSidecarPidFiles(ownerPid, filesPresentBeforeLaunch) {
  const records = [];
  for (const entry of fs.readdirSync(os.tmpdir())) {
    if (filesPresentBeforeLaunch.has(entry)) continue;
    if (!entry.endsWith('.pid')) continue;
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

async function waitForOwnedSidecars(ownerPid, filesPresentBeforeLaunch, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const records = listOwnedSidecarPidFiles(ownerPid, filesPresentBeforeLaunch);
    if (records.length > 0) return records;
    await delay(100);
  }
  return [];
}

async function waitForProcessesToExit(pids, timeoutMs = SIDECAR_EXIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessAlive(pid))) return true;
    await delay(100);
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

async function waitForPortsReleased(ports, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await Promise.all(ports.map(canListenOnPort))).every(Boolean)) return true;
    await delay(100);
  }
  return false;
}

function waitForChildExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Backend PID ${child.pid} did not exit`)), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      childProcess.spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      child.kill('SIGKILL');
    }
  } catch {}
}

async function runPackagedBackendLaunchProbe() {
  const exePath = resolvePackagedExecutable();
  const chromiumDebugLogPath = path.join(path.dirname(exePath), 'debug.log');
  const chromiumDebugLogExistedBefore = fs.existsSync(chromiumDebugLogPath);
  const backendRoot = path.join(path.dirname(exePath), 'resources', 'backend');
  const backendScript = path.join(backendRoot, 'core', 'simbridge.js');
  const backendNodeModules = path.join(backendRoot, 'node_modules');
  if (!fs.existsSync(backendScript)) {
    throw new Error(`Packaged backend script does not exist: ${backendScript}`);
  }
  if (!fs.existsSync(backendNodeModules)) {
    throw new Error(`Packaged backend node_modules does not exist: ${backendNodeModules}`);
  }

  const wsPort = await findFreePort();
  const httpPort = await findFreePort();
  if (!wsPort || !httpPort || wsPort === httpPort) {
    throw new Error('Could not allocate local test ports for packaged backend launch');
  }

  let stdout = '';
  let stderr = '';
  let child = null;
  let ownedSidecarRecords = [];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-electron-backend-launch-'));
  const filesPresentBeforeLaunch = new Set(fs.readdirSync(os.tmpdir()));

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        killChild(child);
        reject(new Error(
          `Packaged backend did not reach ${READY_MARKER} within ${LAUNCH_TIMEOUT_MS}ms\n`
          + `STDOUT:\n${tail(stdout)}\nSTDERR:\n${tail(stderr)}`,
        ));
      }, LAUNCH_TIMEOUT_MS);

      function finish(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (err) {
          killChild(child);
          reject(err);
          return;
        }
        resolve();
      }

      child = childProcess.spawn(exePath, [
        backendScript,
        '--ws-port',
        String(wsPort),
        '--http-port',
        String(httpPort),
      ], {
        cwd: backendRoot,
        env: {
          ...process.env,
          HOME: tempRoot,
          USERPROFILE: tempRoot,
          APPDATA: path.join(tempRoot, 'AppData', 'Roaming'),
          LOCALAPPDATA: path.join(tempRoot, 'AppData', 'Local'),
          XDG_CONFIG_HOME: path.join(tempRoot, '.config'),
          OneDrive: path.join(tempRoot, 'OneDrive'),
          FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS: '1',
          ELECTRON_RUN_AS_NODE: '1',
          NODE_PATH: backendNodeModules,
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.once('error', finish);
      child.once('exit', (code, signal) => {
        if (!settled) {
          finish(new Error(
            `Packaged backend exited before ready (code ${code}, signal ${signal || 'none'})\n`
            + `STDOUT:\n${tail(stdout)}\nSTDERR:\n${tail(stderr)}`,
          ));
        }
      });
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        if (stdout.includes(READY_MARKER)) {
          finish();
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    });

    const backendPid = child.pid;
    ownedSidecarRecords = await waitForOwnedSidecars(backendPid, filesPresentBeforeLaunch);
    if (ownedSidecarRecords.length === 0) {
      throw new Error(`Packaged backend PID ${backendPid} reached ready state without a live owned Rust sidecar`);
    }

    // On Windows, SIGKILL maps to parent-only TerminateProcess for this direct
    // child. The sidecar owner HANDLE must independently observe that death and
    // terminate every captured Rust PID without relying on a process-tree kill.
    const backendExit = waitForChildExit(child);
    if (!child.kill('SIGKILL')) {
      throw new Error(`Could not terminate packaged backend PID ${backendPid}`);
    }
    await backendExit;

    const sidecarPids = ownedSidecarRecords.map((record) => record.pid);
    if (!(await waitForProcessesToExit(sidecarPids))) {
      const survivors = sidecarPids.filter(isProcessAlive);
      throw new Error(`Rust sidecars survived packaged backend death: ${survivors.join(', ')}`);
    }
    if (!(await waitForPortsReleased([wsPort, httpPort]))) {
      throw new Error(`Packaged backend ports remained bound after PID ${backendPid} exited`);
    }
  } finally {
    killChild(child);
    for (const record of ownedSidecarRecords) {
      try { fs.unlinkSync(record.filePath); } catch {}
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (!chromiumDebugLogExistedBefore) {
      try { fs.unlinkSync(chromiumDebugLogPath); } catch {}
    }
  }

  console.log('Packaged backend launch probe passed');
  console.log(`Reached ${READY_MARKER} on WS ${wsPort}, HTTP ${httpPort}`);
  console.log(`Verified ${ownedSidecarRecords.length} owned Rust sidecar(s) exited after parent-only backend termination`);
}

runPackagedBackendLaunchProbe().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
