#!/usr/bin/env node
/**
 * test-ws-surface-message.js
 * Regression test: the backend must emit a `surface` WS message with an object payload.
 *
 * Why:
 * - The frontend depends on { type: 'surface', value: <object> } to keep
 *   SURFACE / ON GROUND fields current.
 * - If the backend stops emitting `surface` (or emits a non-object), those UI fields
 *   get stuck at "--" with no obvious backend error.
 *
 * Run:
 *   node tests/scripts/test-ws-surface-message.js
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const net = require('net');
const WebSocket = require('ws');
const os = require('os');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');

const LOOPBACK_HOST = '127.0.0.1';

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function waitForLine(child, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for backend startup (${timeoutMs}ms)`));
    }, timeoutMs);

    function onData(chunk) {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (predicate(line)) {
          cleanup();
          resolve(line);
          return;
        }
      }
    }

    function onExit(code, signal) {
      cleanup();
      reject(new Error(`Backend exited before ready (code=${code}, signal=${signal})`));
    }

    function cleanup() {
      clearTimeout(timeout);
      child.stdout && child.stdout.off('data', onData);
      child.stderr && child.stderr.off('data', onData);
      child.off('exit', onExit);
    }

    child.stdout && child.stdout.on('data', onData);
    child.stderr && child.stderr.on('data', onData);
    child.on('exit', onExit);
  });
}

function createLineRingBuffer(maxLines = 300) {
  const lines = [];
  return {
    push(line) {
      lines.push(line);
      if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
    },
    snapshot() {
      return lines.slice();
    },
  };
}

function attachLineCapture(child, ring) {
  let buffer = '';
  function onData(chunk) {
    buffer += String(chunk);
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || '';
    for (const line of parts) ring.push(line);
  }
  child.stdout && child.stdout.on('data', onData);
  child.stderr && child.stderr.on('data', onData);
  return () => {
    child.stdout && child.stdout.off('data', onData);
    child.stderr && child.stderr.off('data', onData);
  };
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, LOOPBACK_HOST, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreeWsPortPair() {
  // simbridge-core binds HTTP on wsPort+1, so we must ensure both are free.
  for (let i = 0; i < 50; i++) {
    const candidate = 19000 + Math.floor(Math.random() * 40000);
    // Avoid low ports / privileged ports and make sure +1 stays valid.
    if (candidate < 1025 || candidate >= 65534) continue;
    // eslint-disable-next-line no-await-in-loop
    const wsFree = await isPortFree(candidate);
    if (!wsFree) continue;
    // eslint-disable-next-line no-await-in-loop
    const httpFree = await isPortFree(candidate + 1);
    if (!httpFree) continue;
    return candidate;
  }
  throw new Error('Unable to find a free (wsPort, wsPort+1) pair');
}

async function startBackendMock({ wsPort }) {
  const backendPath = resolveBackendRuntimeFile('core', 'simbridge.js');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-ws-surface-'));
  const tempEnv = {
    HOME: tempRoot,
    USERPROFILE: tempRoot,
    APPDATA: path.join(tempRoot, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(tempRoot, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(tempRoot, '.config'),
    OneDrive: path.join(tempRoot, 'OneDrive'),
  };

  const env = {
    ...process.env,
    ...tempEnv,
    SIMBRIDGE_WS_PORT: String(wsPort),
    HTTP_PORT: String(wsPort + 1),

    // Keep the test quiet & deterministic
  };

  const child = spawn(process.execPath, [backendPath, '--mock'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Capture logs for debugging if the test fails.
  const ring = createLineRingBuffer(400);
  const detach = attachLineCapture(child, ring);
  child.__logRing = ring;
  child.__detachLogs = detach;
  child.__tempRoot = tempRoot;

  // Wait for both WS and HTTP servers to be up (HTTP bind failures otherwise
  // can crash the process after the WS server is already ready).
  await waitForLine(child, (line) => line.includes('[SIMBRIDGE_READY]'), 10000);

  return child;
}

function fetchBootstrapToken(httpPort) {
  return new Promise((resolve, reject) => {
    const req = require('http').get(`http://${LOOPBACK_HOST}:${httpPort}/api/bootstrap`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Bootstrap request failed with HTTP ${res.statusCode}`));
          return;
        }
        try {
          const payload = JSON.parse(body);
          const token = typeof payload?.wsAuthToken === 'string' ? payload.wsAuthToken : '';
          if (!token) {
            reject(new Error('Bootstrap response did not include wsAuthToken'));
            return;
          }
          resolve(token);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(3000, () => {
      req.destroy(new Error('Bootstrap request timed out'));
    });
    req.on('error', reject);
  });
}

async function stopChild(child) {
  if (!child || child.killed) return;

  try {
    if (typeof child.__detachLogs === 'function') child.__detachLogs();
  } catch {}

  await new Promise((resolve) => {
    let done = false;

    const timeout = setTimeout(() => {
      if (!done) {
        try { child.kill('SIGKILL'); } catch {}
        done = true;
        resolve();
      }
    }, 4000);

    child.once('exit', () => {
      if (done) return;
      clearTimeout(timeout);
      done = true;
      resolve();
    });

    try { child.kill('SIGINT'); } catch {
      clearTimeout(timeout);
      resolve();
    }
  });

  if (child.__tempRoot) {
    fs.rmSync(child.__tempRoot, { recursive: true, force: true });
  }
}

function waitForSurfaceMessage({ wsUrls, timeoutMs }) {
  const deadlineMs = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    let settled = false;
    let connectErrors = 0;
    let openedCount = 0;
    let nonSurfaceMessages = 0;
    const sampleTypes = [];
    const sampleErrors = [];
    let attemptIndex = 0;

    function done(err, msg) {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(msg);
    }

    function attemptConnect() {
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) {
        const extra = `opened=${openedCount}, connectErrors=${connectErrors}, nonSurface=${nonSurfaceMessages}, sampleTypes=${sampleTypes.slice(0, 8).join(',') || 'none'}, sampleErrors=${sampleErrors.slice(0, 3).join(' | ') || 'none'}`;
        done(new Error(`Timed out waiting for surface message (${timeoutMs}ms). ${extra}`));
        return;
      }

      const wsUrl = wsUrls[attemptIndex % wsUrls.length];
      attemptIndex += 1;

      const ws = new WebSocket(wsUrl);
      let closed = false;

      const safetyTimer = setTimeout(() => {
        if (closed) return;
        try { ws.terminate(); } catch {}
      }, Math.min(1000, remaining));

      ws.on('open', () => {
        openedCount += 1;
      });

      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (msg && msg.type === 'surface') {
          clearTimeout(safetyTimer);
          closed = true;
          try { ws.close(); } catch {}
          done(null, msg);
        } else if (msg && msg.type) {
          nonSurfaceMessages += 1;
          if (sampleTypes.length < 8) sampleTypes.push(String(msg.type));
        }
      });

      ws.on('error', (err) => {
        clearTimeout(safetyTimer);
        closed = true;
        connectErrors += 1;
        if (sampleErrors.length < 3) {
          const code = err && (err.code || err.errno) ? String(err.code || err.errno) : '';
          const msg = err && err.message ? String(err.message) : 'unknown error';
          sampleErrors.push(`${wsUrl} ${code} ${msg}`.trim());
        }
        // Retry quickly until the overall deadline.
        setTimeout(attemptConnect, 150);
      });

      ws.on('close', () => {
        clearTimeout(safetyTimer);
        closed = true;
      });
    }

    attemptConnect();
  });
}

async function main() {
  console.log('=== WS Surface Message Regression Test ===');

  // Must avoid collisions for BOTH WS port and the built-in HTTP port (wsPort+1).
  const wsPort = await findFreeWsPortPair();
  const wsUrls = [
    `ws://127.0.0.1:${wsPort}`,
    `ws://localhost:${wsPort}`,
    `ws://[::1]:${wsPort}`,
  ];

  let child;
  let passed = false;
  try {
    child = await startBackendMock({ wsPort });
    global.__wsSurfaceTestChild = child;
    const wsAuthToken = await fetchBootstrapToken(wsPort + 1);
    const authenticatedWsUrls = wsUrls.map((url) => `${url}?token=${encodeURIComponent(wsAuthToken)}`);

    const msg = await waitForSurfaceMessage({ wsUrls: authenticatedWsUrls, timeoutMs: 12000 });

    assert(msg && typeof msg === 'object', 'surface message must be an object');
    assert(msg.value && typeof msg.value === 'object', 'surface.value must be an object');
    assert(typeof msg.value.onGround === 'boolean', 'surface.value.onGround must be boolean');

    console.log('  ✓ Received surface message with object payload');
    console.log('  ✓ surface.value.onGround is boolean');

    console.log('✅ PASS');
    passed = true;
  } finally {
    await stopChild(child);
    // Keep captured logs available on failure for the outer catch handler.
    if (passed && global.__wsSurfaceTestChild === child) global.__wsSurfaceTestChild = undefined;
  }
}

main().catch((e) => {
  console.error('❌ FAIL:', e.message);
  // Best-effort: if backend output was captured, print it.
  try {
    const child = global.__wsSurfaceTestChild;
    const lines = child && child.__logRing && child.__logRing.snapshot && child.__logRing.snapshot();
    if (Array.isArray(lines) && lines.length) {
      console.error('--- backend logs (last lines) ---');
      console.error(lines.slice(-80).join('\n'));
      console.error('--- end backend logs ---');
    }
  } catch {}
  process.exitCode = 1;
});
