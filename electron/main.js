/**
 * Electron Main Process
 * 
 * Runs the Flight Fabric backend and provides a native GUI wrapper.
 * The backend (simbridge.js) runs as a child process.
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, Notification, nativeImage, session } = require('electron');
const path = require('path');
const { spawn, fork, execFileSync } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const os = require('os');
const { createSettingsStore } = require('./settings-store');
const { detectMsfsInstalls } = require('./msfs-detect');
const { getLocalIPv4AddressesFromInterfaces } = require('./network-info');
const { resolveAllowedExternalUrl } = require('./external-url-policy');
const { isTrustedIpcSender } = require('./ipc-sender-policy');
const { installSessionPermissionPolicy } = require('./session-permission-policy');
const { canStopBackendPortOwner } = require('./backend-cleanup-policy');
const { acquireRuntimeOwnerLock } = require('./runtime-owner-lock');
const { isManagedProcessAlive } = require('./process-liveness');
const {
  classifyFlightFabricBackendIdentity,
  hasSameWindowsOwner,
  isSameWindowsProcessIdentity,
  normalizeWindowsProcessIdentity,
  normalizeWindowsSid,
} = require('./backend-process-identity');
const {
  createBackendPortSnapshot,
  createBoundedLineBuffer,
  createStartupReadinessGate,
  isExactReadinessLine,
  parseConfiguredTcpPort,
} = require('./backend-lifecycle');

const APP_PRODUCT_NAME = 'Flight Fabric';
const APP_ID = 'com.flightfabric.app';
const BACKEND_SHUTDOWN_MESSAGE = `${JSON.stringify({ type: 'shutdown', reason: 'electron_stop' })}\n`;
// Give normal cleanup 12 seconds, then let Electron own the complete Windows
// tree kill. The backend's parent-only last resort is deliberately later.
const BACKEND_FORCE_KILL_TIMEOUT_MS = 12000;
const BACKEND_EXIT_SETTLE_TIMEOUT_MS = 14000;
const BACKEND_FORCE_EXIT_VERIFY_TIMEOUT_MS = 3000;
const BACKEND_EXIT_POLL_INTERVAL_MS = 150;
const BACKEND_STARTUP_TIMEOUT_MS = 30000;
const BACKEND_OUTPUT_BUFFER_MAX_LENGTH = 64 * 1024;
const FRONTEND_CLOSE_TIMEOUT_MS = 2000;
const SHUTDOWN_RESOURCE_TIMEOUT_MS = 2500;
const PROCESS_GUARDIAN_READY_MARKER = '[FF_PROCESS_GUARDIAN_READY]';

function buildEmergencyFallbackDocument() {
  const inlineScript = `
              window.electronAPI?.onBackendStatus((data) => {
                document.getElementById('status').textContent = data.status;
              });
              window.electronAPI?.onBackendLog((data) => {
                const log = document.getElementById('log');
                log.textContent += data.text + '\\n';
                log.scrollTop = log.scrollHeight;
              });
            `;
  const scriptHash = crypto.createHash('sha256').update(inlineScript).digest('base64');
  return `
        <html>
          <head>
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; script-src 'sha256-${scriptHash}'; script-src-attr 'none'; style-src 'unsafe-inline'">
            <title>Flight Fabric</title>
          </head>
          <body style="font-family: sans-serif; padding: 20px; background: #1a1a2e; color: #fff;">
            <h1>Flight Fabric</h1>
            <p>Experimental release. Use with care.</p>
            <p>Backend status: <span id="status">Starting...</span></p>
            <pre id="log" style="background: #0f0f1a; padding: 10px; max-height: 400px; overflow: auto;"></pre>
            <script>${inlineScript}</script>
          </body>
        </html>
      `;
}

app.setName(APP_PRODUCT_NAME);
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}

function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isPathInsideOrEqual(parentDir, childPath) {
  if (typeof parentDir !== 'string' || typeof childPath !== 'string') return false;
  const resolvedParent = path.resolve(parentDir);
  const resolvedChild = path.resolve(childPath);
  const parent = process.platform === 'win32' ? resolvedParent.toLowerCase() : resolvedParent;
  const child = process.platform === 'win32' ? resolvedChild.toLowerCase() : resolvedChild;
  if (child === parent) return true;
  const relative = path.relative(parent, child);
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeTcpPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function readWindowsProcessIdentity(pid) {
  const normalizedPid = Math.trunc(Number(pid));
  if (!Number.isFinite(normalizedPid) || normalizedPid <= 0) return null;

  const psScript = [
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${normalizedPid}"`,
    'if (-not $p) { exit 3 }',
    '$owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid',
    'if (-not $owner -or $owner.ReturnValue -ne 0) { exit 4 }',
    '$identity=[pscustomobject]@{pid=[int]$p.ProcessId;commandLine=[string]$p.CommandLine;creationToken=$p.CreationDate.ToUniversalTime().Ticks.ToString();ownerSid=[string]$owner.Sid}',
    '[Console]::Out.Write(($identity | ConvertTo-Json -Compress))',
  ].join('; ');

  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return normalizeWindowsProcessIdentity(JSON.parse(output));
  } catch {
    return null;
  }
}

function resolveLifecycleSmokeConfig() {
  const envNonce = String(process.env.FF_ELECTRON_LIFECYCLE_SMOKE_NONCE || '').trim();
  const envStatusPath = String(process.env.FF_ELECTRON_LIFECYCLE_SMOKE_STATUS || '').trim();
  const envAction = String(process.env.FF_ELECTRON_LIFECYCLE_SMOKE_ACTION || '').trim();
  const nonceArg = process.argv.find((arg) => arg.startsWith('--ff-lifecycle-smoke='));
  const statusArg = process.argv.find((arg) => arg.startsWith('--ff-lifecycle-status='));
  const actionArg = process.argv.find((arg) => arg.startsWith('--ff-lifecycle-action='));
  const argNonce = nonceArg?.slice('--ff-lifecycle-smoke='.length) || '';
  const argStatusPath = statusArg?.slice('--ff-lifecycle-status='.length) || '';
  const argAction = actionArg?.slice('--ff-lifecycle-action='.length) || '';
  if (
    !/^[a-f0-9]{32}$/.test(envNonce)
      || !['quit', 'hard-death'].includes(envAction)
      || argNonce !== envNonce
      || argStatusPath !== envStatusPath
      || argAction !== envAction
  ) {
    return null;
  }

  const expectedRoot = path.resolve(os.tmpdir(), `flight-fabric-electron-lifecycle-${envNonce}`);
  const expectedStatusPath = path.join(expectedRoot, 'status.jsonl');
  try {
    if (path.resolve(envStatusPath) !== expectedStatusPath || !fs.statSync(expectedRoot).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  return Object.freeze({ action: envAction, nonce: envNonce, statusPath: expectedStatusPath });
}

const lifecycleSmokeConfig = resolveLifecycleSmokeConfig();
let lifecycleSmokeStatusInitialized = false;

if (lifecycleSmokeConfig) app.disableHardwareAcceleration();

function recordLifecycleSmokeEvent(event, detail = {}) {
  if (!lifecycleSmokeConfig) return;
  const line = `${JSON.stringify({
    event,
    pid: process.pid,
    ts: Date.now(),
    ...detail,
  })}\n`;
  try {
    if (!lifecycleSmokeStatusInitialized) {
      fs.writeFileSync(lifecycleSmokeConfig.statusPath, line, { encoding: 'utf8', flag: 'wx' });
      lifecycleSmokeStatusInitialized = true;
    } else {
      fs.appendFileSync(lifecycleSmokeConfig.statusPath, line, 'utf8');
    }
  } catch (error) {
    console.warn('[electron] Lifecycle smoke status write failed:', error.message || error);
  }
}

recordLifecycleSmokeEvent('electron-start');

let cachedCurrentWindowsOwnerSid;

function readCurrentWindowsOwnerSid() {
  if (process.platform !== 'win32') return '';
  if (cachedCurrentWindowsOwnerSid !== undefined) return cachedCurrentWindowsOwnerSid;
  const psScript = [
    '$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()',
    'if (-not $identity -or -not $identity.User) { exit 3 }',
    '[Console]::Out.Write($identity.User.Value)',
  ].join('; ');
  try {
    cachedCurrentWindowsOwnerSid = normalizeWindowsSid(execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ));
  } catch {
    cachedCurrentWindowsOwnerSid = '';
  }
  return cachedCurrentWindowsOwnerSid;
}

function resolveDevBackendFile(...segments) {
  return firstExistingPath([
    path.resolve(__dirname, '..', 'dist', 'backend', ...segments),
  ]);
}

function resolveDevBackendRoot() {
  const backendScript = resolveDevBackendFile('core', 'simbridge.js');
  return backendScript
    ? path.dirname(path.dirname(backendScript))
    : path.resolve(__dirname, '..', 'dist', 'backend');
}

function loadStoragePaths() {
  const devPath = resolveDevBackendFile('utils', 'storage-paths.js');
  const packagedPath = process.resourcesPath
    ? path.join(process.resourcesPath, 'backend', 'utils', 'storage-paths.js')
    : null;
  const candidates = [devPath, packagedPath].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return require(candidate);
    }
  }

  throw new Error('Unable to locate dist/backend/utils/storage-paths.js. Run `npm run build:backend:runtime` first.');
}

function loadFlightLogsDir() {
  const devPath = resolveDevBackendFile('utils', 'flight-logs-dir.js');
  const packagedPath = process.resourcesPath
    ? path.join(process.resourcesPath, 'backend', 'utils', 'flight-logs-dir.js')
    : null;
  const candidates = [devPath, packagedPath].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return require(candidate);
    }
  }

  throw new Error('Unable to locate dist/backend/utils/flight-logs-dir.js. Run `npm run build:backend:runtime` first.');
}

const {
  getAppDataRoot,
  getCabinAnnouncementAudioDir,
  getProfilesRootDir,
  getSettingsDir,
  getSettingsFilePath,
  getThemesDir,
} = loadStoragePaths();
const { resolveFlightLogsDir } = loadFlightLogsDir();
const ELECTRON_USER_DATA_DIR = path.join(getAppDataRoot(), 'Electron');
fs.mkdirSync(ELECTRON_USER_DATA_DIR, { recursive: true });
app.setPath('userData', ELECTRON_USER_DATA_DIR);
const CABIN_ANNOUNCEMENTS_DIR = getCabinAnnouncementAudioDir();
const THEMES_DIR = getThemesDir();

// Determine if we're in development or packaged
const isDev = !app.isPackaged;
const appRoot = isDev 
  ? path.resolve(__dirname, '..') 
  : path.dirname(app.getPath('exe'));

// -----------------------------------------------------------------------------
// Debug Logging (SECURITY: No PII, bounded disk usage)
// -----------------------------------------------------------------------------
// In packaged mode:
//   - Logs only to console (no file writes by default)
//   - Paths are redacted to prevent PII exposure (e.g., /Users/john/...)
//   - File logging can be enabled with ELECTRON_DEBUG_FILE=1 for troubleshooting
// In dev mode:
//   - Full logging to file and console for development convenience

const DEBUG_LOG_TO_FILE = isDev || process.env.ELECTRON_DEBUG_FILE === '1';
const DEBUG_LOG_MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB max log file
let debugLogPath = null;

/**
 * Redact potentially sensitive paths from log messages.
 * Replaces user home directory paths with <HOME>.
 * @param {string} msg - Message to redact
 * @returns {string} Redacted message
 */
function redactPaths(msg) {
  if (isDev) return msg; // No redaction in dev mode
  
  // Redact common user path patterns
  // Windows: C:\Users\username\...
  // macOS/Linux: /Users/username/..., /home/username/...
  let redacted = msg
    .replace(/[A-Za-z]:\\Users\\[^\\]+/gi, '<HOME>')
    .replace(/\/Users\/[^\/]+/g, '<HOME>')
    .replace(/\/home\/[^\/]+/g, '<HOME>')
    .replace(/C:\\Users\\[^\\]+/gi, '<HOME>');
  return redacted;
}

/**
 * Enforce max log file size (rolling buffer for disk safety).
 */
function enforceLogSize() {
  if (!debugLogPath || !DEBUG_LOG_TO_FILE) return;
  try {
    const stat = fs.statSync(debugLogPath);
    if (stat.size > DEBUG_LOG_MAX_SIZE_BYTES) {
      // Keep last 1 MB using fd-based read to avoid loading the whole file
      const keepBytes = 1024 * 1024;
      const offset = stat.size - keepBytes;
      const buf = Buffer.alloc(keepBytes);
      const fd = fs.openSync(debugLogPath, 'r');
      try {
        fs.readSync(fd, buf, 0, keepBytes, offset);
      } finally {
        fs.closeSync(fd);
      }
      fs.writeFileSync(debugLogPath, '[truncated]\n' + buf.toString('utf8'));
    }
  } catch (e) { /* ignore - file may not exist yet */ }
}

// Debug logging helper - writes to console, optionally to file
function debugLog(...args) {
  const rawMsg = args.join(' ');
  const msg = `[${new Date().toISOString()}] ${redactPaths(rawMsg)}`;
  console.log(msg);
  
  if (DEBUG_LOG_TO_FILE) {
    try {
      if (!debugLogPath) {
        debugLogPath = path.join(appRoot, 'electron-debug.log');
        enforceLogSize(); // Check size on first write
      }
      fs.appendFileSync(debugLogPath, msg + '\n');
      enforceLogSize();
    } catch (e) { /* ignore */ }
  }
}

debugLog('=== Electron Starting ===');
debugLog('isDev:', isDev);
debugLog('app.isPackaged:', app.isPackaged);
// SECURITY: Don't log full paths in packaged mode (redacted automatically)
debugLog('appRoot:', appRoot);
debugLog('process.execPath:', process.execPath);
debugLog('__dirname:', __dirname);

// Node modules path for the backend process.
// In packaged mode, backend dependencies live under resources/backend/node_modules.
const NODE_MODULES_PATH = isDev
  ? path.join(appRoot, 'node_modules')
  : path.join(appRoot, 'resources', 'backend', 'node_modules');

const DEV_BACKEND_ROOT = resolveDevBackendRoot();
const BACKEND_ROOT = isDev
  ? DEV_BACKEND_ROOT
  : path.join(appRoot, 'resources', 'backend');

debugLog('NODE_MODULES_PATH:', NODE_MODULES_PATH);
debugLog('NODE_MODULES exists:', fs.existsSync(NODE_MODULES_PATH));

// Paths
const BACKEND_SCRIPT = isDev
  ? path.join(BACKEND_ROOT, 'core', 'simbridge.js')
  : path.join(appRoot, 'resources', 'backend', 'core', 'simbridge.js');

const RUST_SIDECAR_BINARY_NAME = process.platform === 'win32'
  ? 'ff-rust-simconnect-sidecar.exe'
  : 'ff-rust-simconnect-sidecar';

function existingFileMtimeMs(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

function resolveSafeStaticPath(rootDir, relativePath) {
  const resolvedRoot = path.resolve(rootDir);
  const candidate = path.resolve(resolvedRoot, relativePath);
  if (!isPathInsideOrEqual(resolvedRoot, candidate)) return null;
  if (!fs.existsSync(candidate)) return candidate;

  try {
    const rootStat = fs.lstatSync(resolvedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const targetStat = fs.lstatSync(candidate);
    if (targetStat.isSymbolicLink()) return null;
    const realRoot = fs.realpathSync(resolvedRoot);
    const realTarget = fs.realpathSync(candidate);
    return isPathInsideOrEqual(realRoot, realTarget) ? realTarget : null;
  } catch {
    return null;
  }
}

function selectNewestManagedRustSidecar(telemetryProviderDir) {
  const mainBinary = path.join(telemetryProviderDir, RUST_SIDECAR_BINARY_NAME);
  const pendingBinary = path.join(
    telemetryProviderDir,
    '.pending',
    RUST_SIDECAR_BINARY_NAME,
  );
  const mainMtimeMs = existingFileMtimeMs(mainBinary);
  const pendingMtimeMs = existingFileMtimeMs(pendingBinary);
  if (mainMtimeMs === null) return pendingMtimeMs === null ? null : pendingBinary;
  if (pendingMtimeMs === null) return mainBinary;
  return pendingMtimeMs >= mainMtimeMs ? pendingBinary : mainBinary;
}

function resolveProcessGuardianBinary() {
  const shippedBinary = selectNewestManagedRustSidecar(
    path.join(BACKEND_ROOT, 'telemetry-provider'),
  );
  if (!isDev) return firstExistingPath([shippedBinary]);
  const backendBuildBinary = selectNewestManagedRustSidecar(
    path.join(appRoot, 'backend-build', 'telemetry-provider'),
  );
  return firstExistingPath([
    shippedBinary,
    backendBuildBinary,
    path.resolve(
      __dirname,
      '..',
      'backend',
      'telemetry-provider',
      'rust-simconnect-sidecar',
      'target',
      'release',
      RUST_SIDECAR_BINARY_NAME,
    ),
    path.resolve(
      __dirname,
      '..',
      'backend',
      'telemetry-provider',
      'rust-simconnect-sidecar',
      'target',
      'debug',
      RUST_SIDECAR_BINARY_NAME,
    ),
  ]);
}

debugLog('BACKEND_SCRIPT:', BACKEND_SCRIPT);
debugLog('BACKEND_SCRIPT exists:', fs.existsSync(BACKEND_SCRIPT));

const LAUNCHER_HTML = isDev
  ? path.join(appRoot, 'electron', 'launcher', 'index.html')
  : path.join(appRoot, 'resources', 'launcher', 'index.html');

const TASKBAR_ICON_PATH = isDev
  ? path.join(appRoot, 'electron', 'taskbar-icon.ico')
  : path.join(appRoot, 'resources', 'taskbar-icon.ico');
const TASKBAR_TRAY_ICON_PATH = firstExistingPath([
  isDev
    ? path.join(appRoot, 'electron', 'taskbar-icon.png')
    : path.join(appRoot, 'resources', 'taskbar-icon.png'),
  TASKBAR_ICON_PATH,
]);
const RECORDING_BADGE_ASSET_DIR = isDev
  ? path.join(appRoot, 'electron')
  : path.join(appRoot, 'resources');
const RECORDING_BADGE_ASSET_NAMES = Object.freeze({
  recording: Object.freeze({
    tray: 'taskbar-recording-icon.png',
    overlay: 'recording-overlay.png',
  }),
  finalizing: Object.freeze({
    tray: 'taskbar-finalizing-icon.png',
    overlay: 'finalizing-overlay.png',
  }),
});

const DEFAULT_BACKEND_WS_PORT = parseConfiguredTcpPort(process.env.SIMBRIDGE_WS_PORT, 8099);
const DEFAULT_FRONTEND_PORT = 8000;
const FRONTEND_HOST = '127.0.0.1';

// Frontend paths
const FRONTEND_SOURCE_DIR = isDev
  ? path.join(appRoot, 'frontend')
  : path.join(appRoot, 'resources', 'frontend');
const FRONTEND_DIST_DIR = isDev
  ? path.join(appRoot, 'frontend-dist')
  : path.join(appRoot, 'resources', 'frontend');
const FRONTEND_DIR = firstExistingPath([
  path.join(FRONTEND_DIST_DIR, 'index.html'),
  path.join(FRONTEND_SOURCE_DIR, 'index.html'),
]) === path.join(FRONTEND_DIST_DIR, 'index.html')
  ? FRONTEND_DIST_DIR
  : FRONTEND_SOURCE_DIR;

function getFrontendAssetCandidates(relativePath) {
  const seen = new Set();
  const roots = [FRONTEND_DIST_DIR, FRONTEND_SOURCE_DIR];
  const candidates = [];

  for (const root of roots) {
    const candidate = resolveSafeStaticPath(root, relativePath);
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    candidates.push(candidate);
  }

  return candidates;
}

// State
let mainWindow = null;
let tray = null;
let backendProcess = null;
let activeBackendLaunch = null;
let backendStartupState = null;
let backendGuardian = null;
let frontendServer = null;
let backendWsPort = DEFAULT_BACKEND_WS_PORT;
let backendHttpPort = parseConfiguredTcpPort(process.env.HTTP_PORT, 8100);
let frontendPort = DEFAULT_FRONTEND_PORT;
let isQuitting = false;
let isQuitSequenceRunning = false;
let applicationShutdownPromise = null;
let backendStartPromise = null;
let backendStopPromise = null;
let backendStartAttemptId = 0;
let runtimeOwnerLock = null;
let hasShownTrayCloseNotice = false;
let recordingBadgeState = 'stopped';
const recordingNativeImageCache = new Map();
let taskbarRecordingBadgeAppliedState = null;
let trayRecordingBadgeAppliedState = null;
let startupHealth = null;
let lifecycleSmokeQuitScheduled = false;
let lifecycleSmokeBeforeQuitRecorded = false;

// Backend state for IPC
let backendStatus = 'stopped';
let lastBackendOutput = [];

// Frontend HTTP server state for IPC
let frontendServerStatus = 'stopped';

function getConfiguredBackendPorts() {
  return createBackendPortSnapshot(backendWsPort, backendHttpPort);
}

function getBackendRuntimePorts() {
  if (activeBackendLaunch?.process === backendProcess) return activeBackendLaunch.ports;
  return getConfiguredBackendPorts();
}

function activateBackendLaunch(proc, ports) {
  activeBackendLaunch = Object.freeze({ process: proc, ports });
}

function clearActiveBackendLaunch(proc) {
  if (activeBackendLaunch?.process === proc) activeBackendLaunch = null;
}

const settingsStore = createSettingsStore({
  logger: (...args) => debugLog(...args),
});

({ backendWsPort, backendHttpPort } = settingsStore.refreshRuntimeNetworkFromSettings(
  { backendWsPort, backendHttpPort },
  process.env,
));

// ─────────────────────────────────────────────────────────────────────────────
// Static File Server for Frontend
// ─────────────────────────────────────────────────────────────────────────────

// MIME types for static file serving
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function writeStaticError(res, statusCode, message) {
  if (res.headersSent) {
    try { res.end(); } catch {}
    return;
  }
  res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
  res.end(message);
}

function buildRendererContentSecurityPolicy(nonce) {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.basemaps.cartocdn.com",
    "media-src 'self' data: blob:",
    "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join('; ');
}

function injectRendererCspNonce(html, nonce) {
  return html.replace(
    /<script\b(?![^>]*\bsrc\s*=)(?![^>]*\bnonce\s*=)([^>]*)>/gi,
    `<script nonce="${nonce}"$1>`,
  );
}

function streamStaticFile(req, res, filePath, contentType, options = {}) {
  const notFoundMessage = options.notFoundMessage || 'File not found';
  fs.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0), (openErr, descriptor) => {
    if (openErr) {
      const fileErr = openErr;
      if (typeof options.onMissing === 'function') {
        options.onMissing(fileErr);
        return;
      }
      if (fileErr.code !== 'ENOENT') {
        writeStaticError(res, 500, `Server error: ${fileErr.message}`);
        return;
      }
      writeStaticError(res, 404, notFoundMessage);
      return;
    }

    fs.fstat(descriptor, (statErr, stat) => {
      if (statErr || !stat.isFile()) {
        fs.close(descriptor, () => {
          const fileErr = statErr || Object.assign(new Error('Path is not a file'), { code: 'ENOENT' });
          if (typeof options.onMissing === 'function') {
            options.onMissing(fileErr);
            return;
          }
          if (fileErr.code !== 'ENOENT') {
            writeStaticError(res, 500, `Server error: ${fileErr.message}`);
            return;
          }
          writeStaticError(res, 404, notFoundMessage);
        });
        return;
      }

      if (contentType === 'text/html' && options.htmlNonce) {
        fs.readFile(descriptor, 'utf8', (readErr, html) => {
          fs.close(descriptor, () => {
            if (readErr) {
              if (typeof options.onMissing === 'function') {
                options.onMissing(readErr);
                return;
              }
              writeStaticError(res, 500, `Server error: ${readErr.message}`);
              return;
            }
            const body = injectRendererCspNonce(html, options.htmlNonce);
            res.writeHead(200, {
              'Content-Type': contentType,
              'Content-Length': Buffer.byteLength(body),
              'Cache-Control': 'no-cache',
            });
            if (req.method === 'HEAD') {
              res.end();
              return;
            }
            res.end(body);
          });
        });
        return;
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
      });

      if (req.method === 'HEAD') {
        fs.close(descriptor, () => res.end());
        return;
      }

      const stream = fs.createReadStream(filePath, { fd: descriptor, autoClose: true });
      stream.on('error', (streamErr) => {
        if (!res.headersSent) {
          writeStaticError(res, 500, `Server error: ${streamErr.message}`);
          return;
        }
        try { res.end(); } catch {}
      });
      stream.pipe(res);
    });
  });
}

/**
 * Start static file server for frontend files
 */
function startFrontendServer() {
  if (frontendServer) {
    debugLog('Frontend server already running');
    return Promise.resolve({ status: frontendServerStatus, port: frontendPort });
  }

  const http = require('http');
  const url = require('url');

  return new Promise((resolve) => {
    let settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    const server = http.createServer((req, res) => {
      const cspNonce = crypto.randomBytes(16).toString('base64');
      res.setHeader('Content-Security-Policy', buildRendererContentSecurityPolicy(cspNonce));
      res.setHeader('X-Content-Type-Options', 'nosniff');

      // Only serve static files via GET/HEAD.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        res.end('Method Not Allowed');
        return;
      }

      // Parse URL and get pathname
      const parsedUrl = url.parse(req.url, true);
      let pathname = parsedUrl.pathname;

      // Handle root requests
      if (pathname === '/') {
        pathname = '/frontend/index.html';
      }

      if (pathname.startsWith('/user-assets/cabin/')) {
        const cabinRoot = path.resolve(CABIN_ANNOUNCEMENTS_DIR);
        const relativePath = pathname.slice('/user-assets/cabin/'.length);
        const filePath = resolveSafeStaticPath(cabinRoot, relativePath);
        if (!filePath) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        streamStaticFile(req, res, filePath, contentType, {
          notFoundMessage: `File not found: ${pathname}`,
        });
        return;
      }

      if (pathname.startsWith('/user-assets/themes/')) {
        const themesRoot = path.resolve(THEMES_DIR);
        const bundledThemesRoot = path.resolve(FRONTEND_DIR, 'themes');
        const relativePath = pathname.slice('/user-assets/themes/'.length);
        const userThemePath = resolveSafeStaticPath(themesRoot, relativePath);
        const bundledThemePath = resolveSafeStaticPath(bundledThemesRoot, relativePath);
        if (!userThemePath || !bundledThemePath) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        const ext = path.extname(userThemePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        streamStaticFile(req, res, userThemePath, contentType, {
          onMissing: () => {
            streamStaticFile(req, res, bundledThemePath, contentType, {
              notFoundMessage: `File not found: ${pathname}`,
            });
          },
        });
        return;
      }

      // Resolve requested path within the bundled frontend, falling back to source assets
      // when the built tree intentionally omits compatibility scripts such as flight-phases.js.
      // SECURITY:
      // - Prevent absolute-path bypass (path.join(base, '/x') -> '/x')
      // - Prevent directory traversal (../)
      // - Do NOT allow serving arbitrary files from appRoot
      let relativePath;
      if (pathname.startsWith('/frontend/')) {
        relativePath = pathname.slice('/frontend/'.length);
      } else {
        relativePath = pathname.replace(/^\//, '');
      }
      const candidatePaths = getFrontendAssetCandidates(relativePath);
      if (candidatePaths.length === 0) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      // Get file extension for MIME type
      const ext = path.extname(relativePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      function tryNext(index) {
        if (index >= candidatePaths.length) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end(`File not found: ${pathname}`);
          return;
        }

        const filePath = candidatePaths[index];
        streamStaticFile(req, res, filePath, contentType, {
          htmlNonce: ext === '.html' ? cspNonce : undefined,
          notFoundMessage: `File not found: ${pathname}`,
          onMissing: (err) => {
            if (err.code === 'ENOENT') {
              tryNext(index + 1);
              return;
            }
            writeStaticError(res, 500, `Server error: ${err.message}`);
          },
        });
      }

      tryNext(0);
    });

    // Bind explicitly to loopback to avoid exposing the UI server to the LAN.
    frontendServer = server;
    server.listen(frontendPort, FRONTEND_HOST, () => {
      if (frontendServer !== server) return;
      frontendServerStatus = 'running';
      debugLog(`Frontend server started on http://${FRONTEND_HOST}:${frontendPort}`);
      debugLog(`Serving files from: ${FRONTEND_DIR}`);
      finish({ status: frontendServerStatus, port: frontendPort });
    });

    server.on('error', (err) => {
      if (frontendServer === server) frontendServer = null;
      frontendServerStatus = 'error';
      if (err.code === 'EADDRINUSE') {
        debugLog(`Port ${frontendPort} already in use, frontend server not started`);
      } else {
        debugLog('Frontend server error:', err.message);
      }
      try { server.close(); } catch {}
      try { server.closeAllConnections?.(); } catch {}
      finish({ status: frontendServerStatus, port: frontendPort, error: err.message });
    });
  });
}

/**
 * Stop the frontend server without letting a stuck socket wedge application
 * shutdown. State is detached first so later callers cannot keep using a
 * server that is already closing.
 */
function stopFrontendServer() {
  const server = frontendServer;
  frontendServer = null;
  frontendServerStatus = 'stopped';
  if (!server) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      debugLog(result ? 'Frontend server stopped' : 'Frontend server close did not complete cleanly');
      resolve(result);
    };
    const timeout = setTimeout(() => {
      console.warn('[electron] Frontend server close timed out; continuing application shutdown.');
      try { server.closeAllConnections?.(); } catch {}
      finish(false);
    }, FRONTEND_CLOSE_TIMEOUT_MS);

    try {
      server.close((error) => {
        if (error) {
          console.warn('[electron] Frontend server close failed:', error.message || error);
          finish(false);
          return;
        }
        finish(true);
      });
      try { server.closeAllConnections?.(); } catch {}
    } catch (error) {
      console.warn('[electron] Frontend server close failed:', error.message || error);
      finish(false);
    }
  });
}

function runBoundedShutdownTask(label, task, timeoutMs = SHUTDOWN_RESOURCE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      console.warn(`[electron] ${label} timed out; continuing application shutdown.`);
      finish(false);
    }, timeoutMs);

    Promise.resolve()
      .then(task)
      .then(() => finish(true))
      .catch((error) => {
        console.warn(`[electron] ${label} failed:`, error.message || error);
        finish(false);
      });
  });
}

function getFrontendUrl(options = {}) {
  const params = new URLSearchParams();
  const tab = options && typeof options.tab === 'string' ? options.tab.trim() : '';
  if (tab) params.set('tab', tab);
  const query = params.toString();
  return `http://${FRONTEND_HOST}:${frontendPort}/frontend/index.html${query ? `?${query}` : ''}`;
}

function isFrontendAppUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const hostMatches = parsed.hostname === FRONTEND_HOST || parsed.hostname === 'localhost';
    const portMatches = parsed.port === String(frontendPort);
    return parsed.protocol === 'http:'
      && hostMatches
      && portMatches
      && parsed.pathname === '/frontend/index.html';
  } catch {
    return false;
  }
}

function openExternalBrowserUrl(rawUrl, contextLabel) {
  const allowedUrl = resolveAllowedExternalUrl(rawUrl);
  if (!allowedUrl) {
    debugLog(`Blocked ${contextLabel}:`, rawUrl);
    return false;
  }
  shell.openExternal(allowedUrl).catch((err) => {
    debugLog(`External URL open failed for ${contextLabel}:`, err.message);
  });
  return true;
}

function getWindowFromEvent(event) {
  return BrowserWindow.fromWebContents(event?.sender) || mainWindow;
}

function registerTrustedIpcHandler(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedIpcSender({
      event,
      mainWebContents: mainWindow?.webContents || null,
      isFrontendAppUrl,
      launcherHtmlPath: LAUNCHER_HTML,
    })) {
      debugLog('Rejected IPC request from an untrusted sender:', channel);
      throw new Error('Untrusted Electron IPC sender');
    }
    return handler(event, ...args);
  });
}

function installDefaultSessionPermissionPolicy() {
  installSessionPermissionPolicy({
    electronSession: session.defaultSession,
    getMainWebContents: () => mainWindow?.webContents || null,
    isFrontendAppUrl,
    launcherHtmlPath: LAUNCHER_HTML,
    onDecision: ({ granted, permission, phase }) => {
      if (!granted) debugLog(`Denied renderer permission ${phase}:`, permission);
    },
  });
}

async function loadDesktopApp(targetWindow = mainWindow, options = {}) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    throw new Error('No Electron window is available.');
  }
  if (frontendServerStatus !== 'running') {
    throw new Error('Frontend server is not running.');
  }
  const url = getFrontendUrl(options);
  debugLog('Loading Desktop UI from:', url);
  await targetWindow.loadURL(url);
  return { success: true, url };
}

async function loadLegacyLauncher(targetWindow = mainWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    throw new Error('No Electron window is available.');
  }
  debugLog('Loading legacy launcher from:', LAUNCHER_HTML);
  debugLog('Launcher exists:', fs.existsSync(LAUNCHER_HTML));
  if (!fs.existsSync(LAUNCHER_HTML)) {
    throw new Error('Legacy launcher HTML is missing.');
  }
  await targetWindow.loadFile(LAUNCHER_HTML);
  return { success: true, path: LAUNCHER_HTML };
}

function fetchSimbriefViaBackend(username) {
  const normalizedUsername = typeof username === 'string'
    ? username.trim().replace(/[^A-Za-z0-9_-]/g, '')
    : '';
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(normalizedUsername)) {
    return Promise.resolve({
      ok: false,
      status: 400,
      body: { ok: false, error: 'Invalid or missing username parameter' },
    });
  }

  const port = Number(getBackendRuntimePorts().httpPort);
  if (!Number.isFinite(port) || port <= 0) {
    return Promise.resolve({
      ok: false,
      status: 0,
      body: { ok: false, error: 'Backend HTTP port is unavailable' },
    });
  }

  const requestPath = `/api/simbrief?username=${encodeURIComponent(normalizedUsername)}`;
  return new Promise((resolve) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      timeout: 18000,
      headers: {
        Accept: 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += String(chunk);
        if (data.length > 2 * 1024 * 1024) {
          req.destroy(new Error('Backend SimBrief response too large'));
        }
      });
      res.on('end', () => {
        let body;
        try {
          body = data ? JSON.parse(data) : {};
        } catch {
          body = { ok: false, error: 'Backend returned a non-JSON SimBrief response' };
        }
        const status = Number(res.statusCode) || 0;
        resolve({
          ok: status >= 200 && status < 300 && body?.ok !== false,
          status,
          body,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Backend SimBrief proxy timed out'));
    });
    req.on('error', (err) => {
      resolve({
        ok: false,
        status: 0,
        body: {
          ok: false,
          error: `Could not reach local backend SimBrief proxy on port ${port}: ${err.message}`,
        },
      });
    });
  });
}

function fetchBackendBootstrapViaBackend() {
  const port = Number(getBackendRuntimePorts().httpPort);
  if (!Number.isFinite(port) || port <= 0) {
    return Promise.resolve({
      ok: false,
      status: 0,
      port: 0,
      body: { ok: false, error: 'Backend HTTP port is unavailable' },
    });
  }

  return new Promise((resolve) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/api/bootstrap',
      timeout: 5000,
      headers: {
        Accept: 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += String(chunk);
        if (data.length > 64 * 1024) {
          req.destroy(new Error('Backend bootstrap response too large'));
        }
      });
      res.on('end', () => {
        let body;
        try {
          body = data ? JSON.parse(data) : {};
        } catch {
          body = { ok: false, error: 'Backend returned a non-JSON bootstrap response' };
        }
        const status = Number(res.statusCode) || 0;
        resolve({
          ok: status >= 200 && status < 300 && body?.ok !== false,
          status,
          port,
          body,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Backend bootstrap timed out'));
    });
    req.on('error', (err) => {
      resolve({
        ok: false,
        status: 0,
        port,
        body: {
          ok: false,
          error: `Could not reach local backend bootstrap on port ${port}: ${err.message}`,
        },
      });
    });
  });
}

function canListenOnPort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const tester = net.createServer();

    tester.once('error', () => {
      resolve(false);
    });

    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });

    tester.listen(port, host);
  });
}

async function findAvailablePort(startPort, host = '127.0.0.1', maxAttempts = 20) {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = startPort + offset;
    // eslint-disable-next-line no-await-in-loop
    const available = await canListenOnPort(candidate, host);
    if (available) return candidate;
  }
  return null;
}

async function promptToFreeBackendPort(port, label) {
  if (lifecycleSmokeConfig) {
    recordLifecycleSmokeEvent('startup-blocked', { reason: 'backend-port-busy', port, label });
    return false;
  }
  debugLog(`${label} port ${port} is busy, prompting user to stop the existing backend`);
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'Flight Fabric Backend Already Running',
    message: `Another process is using the ${label} port (${port}).`,
    detail: 'Flight Fabric cannot safely start a second backend on the same ports. You can stop the existing process only if its command line verifies that it is a Flight Fabric backend, or cancel and stop it yourself.',
    buttons: ['Stop Verified Flight Fabric Backend', 'Cancel Startup and Quit'],
    defaultId: 1,
    cancelId: 1,
  });

  if (response !== 0) {
    return false;
  }

  // Reaching this call means the user explicitly confirmed cleanup. The helper
  // still independently requires both Electron ownership locks before it may
  // recover an Electron-marked listener left behind by a crashed desktop app.
  const killed = killProcessOnPort(port, { allowElectronOwnerRecovery: true });
  if (killed) {
    await new Promise((r) => setTimeout(r, 1500));
    if (await canListenOnPort(port)) return true;
  }

  await dialog.showMessageBox({
    type: 'error',
    title: 'Backend Could Not Be Stopped',
    message: 'Flight Fabric did not stop the process using the backend port.',
    detail: 'The process was either not a verified Flight Fabric backend or could not be stopped. Flight Fabric will not start an unmanaged second backend.',
    buttons: ['Close'],
    defaultId: 0,
  });
  return false;
}

/**
 * Attempt to kill a process listening on the given port (Windows only).
 * Returns true if a process was found and kill was attempted.
 */
function killProcessOnPort(port, options = {}) {
  if (process.platform !== 'win32') return false;
  const safePort = normalizeTcpPort(port);
  if (!safePort) return false;
  const currentWindowsOwnerSid = readCurrentWindowsOwnerSid();
  if (!currentWindowsOwnerSid) {
    debugLog(`Skipping cleanup on port ${safePort}: current Windows owner SID could not be verified`);
    return false;
  }

  const baseCleanupCapabilities = {
    allowElectronOwnerRecovery: options.allowElectronOwnerRecovery === true,
    hasSingleInstanceLock: gotTheLock === true,
    hasRuntimeOwnerLock: runtimeOwnerLock?.acquired === true,
  };

  try {
    const output = execFileSync('netstat.exe', ['-ano'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const pids = new Set();
    for (const line of output.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      const localAddress = parts[1] || '';
      const state = parts[3] || '';
      if (state.toUpperCase() !== 'LISTENING' || !localAddress.endsWith(`:${safePort}`)) {
        continue;
      }
      const pid = parseInt(parts[4], 10);
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    }
    let killedCount = 0;
    for (const pid of pids) {
      const initialIdentity = readWindowsProcessIdentity(pid);
      const ownership = classifyFlightFabricBackendIdentity(initialIdentity);
      const cleanupCapabilities = {
        ...baseCleanupCapabilities,
        sameWindowsOwner: hasSameWindowsOwner(initialIdentity, currentWindowsOwnerSid),
      };
      if (!canStopBackendPortOwner(ownership, cleanupCapabilities)) {
        if (!cleanupCapabilities.sameWindowsOwner) {
          debugLog(`Skipping process on port ${safePort}, PID ${pid}: Windows process owner could not be verified as the current user`);
          continue;
        }
        if (ownership === 'electron') {
          debugLog(`Skipping process on port ${safePort}, PID ${pid}: Electron recovery requires both active ownership locks`);
          continue;
        }
        debugLog(`Skipping process on port ${safePort}, PID ${pid}: not a verified Flight Fabric backend`);
        continue;
      }
      if (ownership === 'electron') {
        debugLog(`Recovering stale Electron backend process tree on port ${safePort}, PID ${pid}`);
      }
      debugLog(`Killing stale process on port ${safePort}, PID ${pid}`);
      try {
        // Re-read immutable creation/owner/command-line identity immediately
        // before taskkill. A recycled PID must never inherit the prior cleanup
        // authorization.
        const currentIdentity = readWindowsProcessIdentity(pid);
        if (!isSameWindowsProcessIdentity(initialIdentity, currentIdentity)) {
          debugLog(`Skipping process on port ${safePort}, PID ${pid}: process identity changed before termination`);
          continue;
        }
        // The backend owns native sidecars. Terminate the verified process tree
        // so a forced stale-backend cleanup cannot leave those children behind.
        execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 5000 });
        killedCount += 1;
      } catch (e) {
        debugLog(`Failed to kill PID ${pid}: ${e.message}`);
      }
    }
    return killedCount > 0;
  } catch {
    return false;
  }
}

async function runStartupHealthChecks() {
  const airportsCsv = path.join(BACKEND_ROOT, 'data-sync', 'data', 'ourairports', 'airports.csv');
  const runwaysCsv = path.join(BACKEND_ROOT, 'data-sync', 'data', 'ourairports', 'runways.csv');
  let configuredPorts;
  try {
    configuredPorts = getConfiguredBackendPorts();
  } catch (error) {
    const health = {
      ok: false,
      checks: {},
      criticalFailures: [error.message || String(error)],
      timestamp: new Date().toISOString(),
    };
    startupHealth = health;
    debugLog('Startup health:', JSON.stringify(health));
    recordLifecycleSmokeEvent('startup-blocked', {
      reason: 'invalid-backend-ports',
      error: health.criticalFailures[0],
    });
    if (!lifecycleSmokeConfig) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'Invalid Backend Port Configuration',
        message: 'Flight Fabric cannot start with the configured backend ports.',
        detail: health.criticalFailures[0],
        buttons: ['Quit Flight Fabric'],
        defaultId: 0,
      });
    }
    return null;
  }
  const { wsPort, httpPort } = configuredPorts;

  const requestedFrontendPort = frontendPort;
  const frontendPortAvailable = await canListenOnPort(requestedFrontendPort, FRONTEND_HOST);
  if (!frontendPortAvailable) {
    const fallbackPort = await findAvailablePort(requestedFrontendPort + 1, FRONTEND_HOST, 30);
    if (Number.isFinite(fallbackPort)) {
      frontendPort = fallbackPort;
      debugLog(`Startup health: frontend port ${requestedFrontendPort} busy, using ${frontendPort}`);
    }
  }

  const resolvedFrontendPortAvailable = await canListenOnPort(frontendPort, FRONTEND_HOST);

  // Check backend port availability - attempt cleanup if busy (mirrors start-simbridge.bat)
  let wsPortAvailable = await canListenOnPort(wsPort);
  if (!wsPortAvailable) {
    const killed = await promptToFreeBackendPort(wsPort, 'backend WebSocket');
    if (!killed) return null;
    wsPortAvailable = true;
  }

  let httpPortAvailable = await canListenOnPort(httpPort);
  if (!httpPortAvailable) {
    const killed = await promptToFreeBackendPort(httpPort, 'backend HTTP');
    if (!killed) return null;
    httpPortAvailable = true;
  }

  const checks = {
    backendScriptExists: fs.existsSync(BACKEND_SCRIPT),
    backendNodeModulesExists: fs.existsSync(NODE_MODULES_PATH),
    airportsCsvExists: fs.existsSync(airportsCsv),
    runwaysCsvExists: fs.existsSync(runwaysCsv),
    wsPortAvailable,
    wsPortResolved: wsPort,
    httpPortAvailable,
    httpPortResolved: httpPort,
    frontendPortAvailable: resolvedFrontendPortAvailable,
    frontendPortRequested: requestedFrontendPort,
    frontendPortResolved: frontendPort,
  };

  const criticalFailures = [];
  if (!checks.backendScriptExists) criticalFailures.push('Backend script missing');
  if (!checks.backendNodeModulesExists) criticalFailures.push('Backend node_modules missing');
  if (!checks.airportsCsvExists) criticalFailures.push('airports.csv missing');
  if (!checks.runwaysCsvExists) criticalFailures.push('runways.csv missing');
  if (!checks.wsPortAvailable) criticalFailures.push(`Port ${checks.wsPortResolved} already in use`);
  if (!checks.httpPortAvailable) criticalFailures.push(`Port ${checks.httpPortResolved} already in use`);
  if (!checks.frontendPortAvailable) criticalFailures.push(`No available frontend port near ${checks.frontendPortRequested}`);

  const health = {
    ok: criticalFailures.length === 0,
    checks,
    criticalFailures,
    timestamp: new Date().toISOString(),
  };

  debugLog('Startup health:', JSON.stringify(health));

  if (criticalFailures.length > 0) {
    if (!lifecycleSmokeConfig) {
      dialog.showMessageBox({
        type: 'warning',
        title: 'Flight Fabric Startup Checks',
        message: 'Some startup checks failed. The app may not work correctly.',
        detail: criticalFailures.join('\n'),
        buttons: ['Continue'],
        defaultId: 0,
      }).catch(() => {});
    }
  }

  startupHealth = health;
  return health;
}

async function checkBackendPortsForSpawn(ports) {
  const { wsPort, httpPort } = ports;
  const [wsPortAvailable, httpPortAvailable] = await Promise.all([
    canListenOnPort(wsPort),
    canListenOnPort(httpPort),
  ]);

  if (wsPortAvailable && httpPortAvailable) return true;

  const busyPorts = [];
  if (!wsPortAvailable) busyPorts.push(`WebSocket ${wsPort}`);
  if (!httpPortAvailable) busyPorts.push(`HTTP ${httpPort}`);
  const error = `Backend not started because these ports are already in use: ${busyPorts.join(', ')}`;
  debugLog(error);
  backendStatus = 'error';
  sendToRenderer('backend-status', { status: backendStatus, error });
  recordLifecycleSmokeEvent('startup-blocked', { reason: 'spawn-port-race', error });
  if (!lifecycleSmokeConfig) {
    dialog.showMessageBox({
      type: 'error',
      title: 'Backend Did Not Start',
      message: 'Another process took a Flight Fabric backend port.',
      detail: `${error}. Close the other backend or app, then start the backend again.`,
      buttons: ['Close'],
      defaultId: 0,
    }).catch(() => {});
  }
  return false;
}

function appendBackendOutput(type, text) {
  const line = String(text || '').trim();
  if (!line) return;
  if (type === 'stderr') console.error('[backend:err]', line);
  else console.log('[backend]', line);
  lastBackendOutput.push({ type, text: line, ts: Date.now() });
  if (lastBackendOutput.length > 100) lastBackendOutput.shift();
  sendToRenderer('backend-log', { type, text: line });
}

function scheduleLifecycleSmokeQuit(proc) {
  if (!lifecycleSmokeConfig || lifecycleSmokeQuitScheduled) return;
  lifecycleSmokeQuitScheduled = true;
  const ports = activeBackendLaunch?.process === proc ? activeBackendLaunch.ports : null;
  recordLifecycleSmokeEvent('managed-ready', {
    backendPid: proc.pid,
    guardianPid: backendGuardian?.target === proc ? backendGuardian.process?.pid : null,
    wsPort: ports?.wsPort,
    httpPort: ports?.httpPort,
    action: lifecycleSmokeConfig.action,
  });
  if (lifecycleSmokeConfig.action !== 'quit') return;
  setTimeout(() => {
    recordLifecycleSmokeEvent('quit-requested');
    app.quit();
  }, 2000);
}

function tryCompleteBackendStartup(proc) {
  const state = backendStartupState;
  if (!state || state.proc !== proc || state.failureStarted || state.gate.isSettled()) return false;
  if (!state.backendReady || !state.guardianReady) return false;
  if (backendProcess !== proc || !isBackendProcessAlive(proc) || backendStatus === 'stopping') {
    state.gate.fail();
    return false;
  }
  backendStatus = 'running';
  sendToRenderer('backend-status', { status: backendStatus });
  state.gate.ready();
  scheduleLifecycleSmokeQuit(proc);
  return true;
}

async function failBackendStartupAndStop(proc, error) {
  const state = backendStartupState?.proc === proc ? backendStartupState : null;
  if (state?.failureStarted) return;
  if (state) state.failureStarted = true;

  const message = error?.message || String(error || 'Backend startup failed');
  if (backendStatus !== 'stopping' && !isQuitting) {
    backendStatus = 'error';
    sendToRenderer('backend-status', { status: backendStatus, error: message });
  }
  if (isBackendProcessAlive(proc)) {
    forceStopBackendProcessTree(proc);
    await waitForBackendProcessExit(proc);
  }
  if (state) state.gate.fail();
  if (backendStartupState === state) backendStartupState = null;
  if (!isQuitting && backendStatus !== 'stopping' && (!backendProcess || backendProcess === proc)) {
    backendStatus = 'error';
    sendToRenderer('backend-status', { status: backendStatus, error: message });
  }
}

function forceStopBackendGuardian(guardian) {
  if (!guardian || !isManagedProcessAlive(guardian)) return true;
  if (process.platform === 'win32' && Number.isFinite(guardian.pid) && guardian.pid > 0) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(guardian.pid), '/T', '/F'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return true;
    } catch (error) {
      if (!isManagedProcessAlive(guardian)) return true;
      console.warn('[electron] Failed to stop backend process guardian:', error.message || error);
      return false;
    }
  }
  try {
    return guardian.kill('SIGKILL');
  } catch (error) {
    console.warn('[electron] Failed to stop backend process guardian:', error.message || error);
    return false;
  }
}

function clearBackendGuardianForTarget(proc, { force = false } = {}) {
  const record = backendGuardian;
  if (!record || record.target !== proc) return;
  backendGuardian = null;
  if (force) forceStopBackendGuardian(record.process);
}

function handleBackendGuardianFailure(guardian, target, detail) {
  const record = backendGuardian;
  if (!record || record.process !== guardian || record.target !== target) return;
  backendGuardian = null;
  if (!isBackendProcessAlive(target) || backendStatus === 'stopping' || isQuitting) {
    const state = backendStartupState?.proc === target ? backendStartupState : null;
    if (state) state.gate.fail();
    return;
  }
  const error = new Error(`Backend process guardian failed: ${detail}`);
  console.error('[electron]', error.message);
  void failBackendStartupAndStop(target, error);
}

function startBackendProcessGuardian(proc) {
  if (process.platform !== 'win32') {
    const state = backendStartupState?.proc === proc ? backendStartupState : null;
    if (state) {
      state.guardianReady = true;
      tryCompleteBackendStartup(proc);
    }
    return true;
  }

  if (backendProcess !== proc || !Number.isFinite(Number(proc?.pid)) || Number(proc.pid) <= 0) {
    void failBackendStartupAndStop(proc, new Error('Backend exited before its process guardian could start'));
    return false;
  }

  const binary = resolveProcessGuardianBinary();
  if (!binary) {
    void failBackendStartupAndStop(proc, new Error(
      `Backend guardian binary not found: ${RUST_SIDECAR_BINARY_NAME}`,
    ));
    return false;
  }

  let guardian;
  try {
    guardian = spawn(binary, [
      '--process-guardian',
      `--ff-owner-pid=${process.pid}`,
      `--ff-target-pid=${proc.pid}`,
    ], {
      cwd: path.dirname(binary),
      env: { ...process.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    void failBackendStartupAndStop(proc, error);
    return false;
  }

  const record = { process: guardian, target: proc, ready: false };
  backendGuardian = record;
  recordLifecycleSmokeEvent('guardian-spawned', {
    backendPid: proc.pid,
    guardianPid: guardian.pid,
  });
  const stdoutLines = createBoundedLineBuffer((line) => {
    const text = String(line || '').trim();
    if (!text) return;
    debugLog('[process-guardian]', text);
    if (!isExactReadinessLine(text, PROCESS_GUARDIAN_READY_MARKER)) return;
    const current = backendGuardian;
    if (!current || current.process !== guardian || current.target !== proc) return;
    if (!current.ready) {
      recordLifecycleSmokeEvent('guardian-ready', {
        backendPid: proc.pid,
        guardianPid: guardian.pid,
      });
    }
    current.ready = true;
    const state = backendStartupState?.proc === proc ? backendStartupState : null;
    if (state) {
      state.guardianReady = true;
      tryCompleteBackendStartup(proc);
    }
  }, { maxBufferLength: BACKEND_OUTPUT_BUFFER_MAX_LENGTH });
  const stderrLines = createBoundedLineBuffer((line) => {
    const text = String(line || '').trim();
    if (text) console.warn('[process-guardian:err]', text);
  }, { maxBufferLength: BACKEND_OUTPUT_BUFFER_MAX_LENGTH });

  guardian.stdout?.on('data', (chunk) => stdoutLines.push(chunk));
  guardian.stdout?.on('end', () => stdoutLines.flush());
  guardian.stdout?.on('error', (error) => {
    handleBackendGuardianFailure(guardian, proc, `stdout pipe failed: ${error.message || error}`);
  });
  guardian.stderr?.on('data', (chunk) => stderrLines.push(chunk));
  guardian.stderr?.on('end', () => stderrLines.flush());
  guardian.stderr?.on('error', (error) => {
    handleBackendGuardianFailure(guardian, proc, `stderr pipe failed: ${error.message || error}`);
  });
  guardian.once('error', (error) => {
    handleBackendGuardianFailure(guardian, proc, error.message || error);
  });
  guardian.once('exit', (code, signal) => {
    recordLifecycleSmokeEvent('guardian-exit', {
      backendPid: proc.pid,
      guardianPid: guardian.pid,
      code,
      signal,
    });
    handleBackendGuardianFailure(
      guardian,
      proc,
      `exited before its target (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
    );
  });
  return true;
}

function cancelBackendStartup(proc) {
  const state = backendStartupState;
  if (!state || state.proc !== proc) return;
  backendStartupState = null;
  state.gate.cancel();
}

/**
 * Serialize backend starts so tray/IPC actions cannot launch duplicate children.
 */
function startBackend() {
  if (isQuitting) return Promise.resolve(false);
  if (backendStopPromise) {
    const stopping = backendStopPromise;
    return stopping.then(() => (isQuitting ? false : startBackend()));
  }
  if (backendStartPromise) return backendStartPromise;

  const attemptId = ++backendStartAttemptId;
  const attempt = startBackendOnce(attemptId).catch((err) => {
    debugLog('ERROR starting backend:', err.message);
    backendStatus = 'error';
    sendToRenderer('backend-status', { status: backendStatus, error: err.message });
    return false;
  });
  const tracked = attempt.finally(() => {
    if (backendStartPromise === tracked) backendStartPromise = null;
  });
  backendStartPromise = tracked;
  return tracked;
}

async function startBackendOnce(attemptId) {
  if (backendProcess) {
    if (!isBackendProcessAlive(backendProcess)) {
      markBackendProcessStopped(backendProcess);
    } else {
      debugLog('Backend process already exists with status:', backendStatus);
      return backendStatus === 'running';
    }
  }
  if (isQuitting || attemptId !== backendStartAttemptId) return false;

  ({ backendWsPort, backendHttpPort } = settingsStore.refreshRuntimeNetworkFromSettings(
    { backendWsPort, backendHttpPort },
    process.env,
  ));
  const launchPorts = createBackendPortSnapshot(backendWsPort, backendHttpPort);

  debugLog('=== Starting Backend ===');
  debugLog('BACKEND_SCRIPT:', BACKEND_SCRIPT);
  debugLog('Script exists:', fs.existsSync(BACKEND_SCRIPT));
  debugLog('isDev:', isDev);
  debugLog('process.execPath:', process.execPath);
  debugLog('backendWsPort:', launchPorts.wsPort);
  debugLog('backendHttpPort:', launchPorts.httpPort);

  const backendArgs = [
    '--ws-port', String(launchPorts.wsPort),
    '--http-port', String(launchPorts.httpPort),
    '--ff-launch-owner=electron',
  ];
  
  // Set environment for backend
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    // Set NODE_PATH so require() finds backend deps in the packaged app
    NODE_PATH: NODE_MODULES_PATH,
    // Signal to backend whether we're in packaged Electron mode
    // This enables rolling buffer storage and disk-safe logging
    ELECTRON_PACKAGED: app.isPackaged ? '1' : '0',
    FF_ELECTRON_BACKEND: '1',
    // The backend may treat EOF on this pipe as proof that Electron crashed.
    // Keep the behavior opt-in so CLI/daemon launches can safely ignore stdin.
    FF_PARENT_STDIN_LIFELINE: lifecycleSmokeConfig?.action === 'hard-death' ? '0' : '1',
    STABILITY_DEBUG_LOG: '0',
    STABILITY_DEBUG_ALWAYS_ACTIVE: '0',
  };

  debugLog('NODE_PATH set to:', NODE_MODULES_PATH);

  // In packaged mode, we need to use the Electron exe with ELECTRON_RUN_AS_NODE=1
  // This makes Electron act as a Node.js runtime
  const cwd = path.dirname(BACKEND_SCRIPT);
  debugLog('Working directory:', cwd);
  debugLog('CWD exists:', fs.existsSync(cwd));

  const exePath = process.execPath;
  if (!isDev && !fs.existsSync(exePath)) {
    // Portable exe extraction can delay file availability - verify first.
    debugLog('WARNING: execPath not found, waiting for extraction...');
    await new Promise((r) => setTimeout(r, 2000));
    if (!fs.existsSync(exePath)) {
      debugLog('ERROR: execPath still missing after wait:', exePath);
      backendStatus = 'error';
      sendToRenderer('backend-status', {
        status: backendStatus,
        error: `Executable not found: ${exePath}`,
      });
      return false;
    }
  }

  // Startup checks can become stale before the window is shown, and tray/IPC
  // starts can happen later. Recheck both ports immediately before every spawn.
  if (isQuitting || attemptId !== backendStartAttemptId) return false;
  if (!(await checkBackendPortsForSpawn(launchPorts))) return false;
  if (isQuitting || attemptId !== backendStartAttemptId) return false;

  let proc;
  try {
    if (isDev) {
      // Dev mode: fork works fine
      debugLog('Using fork() for dev mode');
      proc = fork(BACKEND_SCRIPT, backendArgs, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
    } else {
      // Packaged mode: use Electron exe with ELECTRON_RUN_AS_NODE=1 as Node
      debugLog('Using spawn() for packaged mode');
      debugLog('Spawning:', exePath, [BACKEND_SCRIPT, ...backendArgs]);
      proc = spawn(exePath, [BACKEND_SCRIPT, ...backendArgs], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    backendProcess = proc;
    activateBackendLaunch(proc, launchPorts);
    debugLog('Process spawned, PID:', proc.pid);
    recordLifecycleSmokeEvent('backend-spawned', {
      backendPid: proc.pid,
      wsPort: launchPorts.wsPort,
      httpPort: launchPorts.httpPort,
    });
  } catch (err) {
    debugLog('ERROR spawning process:', err.message);
    debugLog('Error stack:', err.stack);
    backendStatus = 'error';
    sendToRenderer('backend-status', { status: backendStatus, error: err.message });
    return false;
  }

  backendStatus = 'starting';
  sendToRenderer('backend-status', { status: backendStatus });

  const startupGate = createStartupReadinessGate({
    timeoutMs: BACKEND_STARTUP_TIMEOUT_MS,
    onTimeout: async () => {
      await failBackendStartupAndStop(
        proc,
        new Error(`Backend did not become ready within ${BACKEND_STARTUP_TIMEOUT_MS / 1000} seconds`),
      );
    },
  });
  const startupState = {
    proc,
    gate: startupGate,
    backendReady: false,
    guardianReady: process.platform !== 'win32',
    failureStarted: false,
  };
  backendStartupState = startupState;

  const stdoutLines = createBoundedLineBuffer((line) => {
    appendBackendOutput('stdout', line);
    // DO NOT CHANGE '[SIMBRIDGE_READY]' - it is the backend/Electron contract.
    if (!isExactReadinessLine(line, '[SIMBRIDGE_READY]')) return;
    const state = backendStartupState;
    if (!state || state.proc !== proc || backendProcess !== proc || backendStatus === 'stopping') return;
    if (!state.backendReady) recordLifecycleSmokeEvent('backend-ready', { backendPid: proc.pid });
    state.backendReady = true;
    tryCompleteBackendStartup(proc);
  }, { maxBufferLength: BACKEND_OUTPUT_BUFFER_MAX_LENGTH });
  const stderrLines = createBoundedLineBuffer((line) => {
    appendBackendOutput('stderr', line);
  }, { maxBufferLength: BACKEND_OUTPUT_BUFFER_MAX_LENGTH });

  proc.stdout?.on('data', (data) => stdoutLines.push(data));
  proc.stdout?.on('end', () => stdoutLines.flush());
  proc.stderr?.on('data', (data) => stderrLines.push(data));
  proc.stderr?.on('end', () => stderrLines.flush());
  const handleBackendStreamError = (label, error) => {
    if (backendProcess !== proc) {
      debugLog(`Ignoring stale backend ${label} pipe error for PID:`, proc.pid);
      return;
    }
    if (backendStatus === 'stopping' || isQuitting) return;
    void failBackendStartupAndStop(
      proc,
      new Error(`Backend ${label} pipe failed: ${error.message || error}`),
    );
  };
  proc.stdout?.on('error', (error) => handleBackendStreamError('stdout', error));
  proc.stderr?.on('error', (error) => handleBackendStreamError('stderr', error));
  proc.stdin?.on('error', (error) => handleBackendStreamError('stdin', error));

  proc.on('exit', (code) => {
    if (backendProcess !== proc) {
      debugLog('Ignoring stale backend exit event for PID:', proc.pid);
      return;
    }
    console.log('[electron] Backend exited with code:', code);
    recordLifecycleSmokeEvent('backend-exit', { backendPid: proc.pid, code });
    const state = backendStartupState?.proc === proc ? backendStartupState : null;
    if (state) {
      backendStartupState = null;
      state.gate.fail();
    }
    clearActiveBackendLaunch(proc);
    backendProcess = null;
    clearBackendGuardianForTarget(proc, { force: true });
    backendStatus = 'stopped';
    sendToRenderer('backend-status', { status: backendStatus, exitCode: code });
  });

  proc.on('error', (err) => {
    if (backendProcess !== proc) {
      debugLog('Ignoring stale backend error event for PID:', proc.pid);
      return;
    }
    console.error('[electron] Backend error:', err);
    // Only spawn failure (no PID) proves that no child exists. Other child
    // errors can be IPC/kill failures while the process is still alive, so
    // retain ownership and let the exit event clear the pointer.
    if (!proc.pid) {
      const state = backendStartupState?.proc === proc ? backendStartupState : null;
      if (state) {
        backendStartupState = null;
        state.gate.fail();
      }
      clearActiveBackendLaunch(proc);
      clearBackendGuardianForTarget(proc, { force: true });
      backendProcess = null;
    }
    if (backendStatus !== 'stopping') backendStatus = 'error';
    sendToRenderer('backend-status', { status: backendStatus, error: err.message });
  });

  startBackendProcessGuardian(proc);
  const ready = await startupGate.promise;
  if (backendStartupState === startupState) backendStartupState = null;
  return ready;
}

function isBackendProcessAlive(proc) {
  return isManagedProcessAlive(proc);
}

function markBackendProcessStopped(proc) {
  if (backendProcess !== proc) return;
  cancelBackendStartup(proc);
  clearActiveBackendLaunch(proc);
  backendProcess = null;
  clearBackendGuardianForTarget(proc, { force: true });
  backendStatus = 'stopped';
  sendToRenderer('backend-status', { status: backendStatus });
}

function waitForBackendProcessExit(proc, timeoutMs = BACKEND_FORCE_EXIT_VERIFY_TIMEOUT_MS) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  return new Promise((resolve) => {
    const poll = () => {
      if (!isBackendProcessAlive(proc)) {
        markBackendProcessStopped(proc);
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(poll, BACKEND_EXIT_POLL_INTERVAL_MS);
    };
    poll();
  });
}

function forceStopBackendProcessTree(proc) {
  if (!proc || !Number.isFinite(Number(proc.pid)) || Number(proc.pid) <= 0) return false;

  if (process.platform === 'win32') {
    // `proc` is the exact ChildProcess object spawned and retained by this
    // Electron instance. Do not downgrade to a parent-only kill if a fresh WMI
    // query fails: that would strand the Rust sidecars owned by this process.
    try {
      execFileSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      debugLog('Force-stopped Electron backend process tree, PID:', proc.pid);
      return true;
    } catch (error) {
      if (!isBackendProcessAlive(proc)) return true;
      console.warn('[electron] Failed to force-stop backend process tree:', error.message || error);
      return false;
    }
  }

  try {
    return proc.kill('SIGKILL');
  } catch (error) {
    console.warn('[electron] Failed to force kill backend:', error.message || error);
    return false;
  }
}

/**
 * Stop the backend process
 */
function stopBackend() {
  const pendingStart = backendStartPromise;
  // Cancel a start that is currently awaiting extraction/port checks.
  backendStartAttemptId += 1;
  if (backendProcess) cancelBackendStartup(backendProcess);

  if (backendStopPromise) {
    return backendStopPromise;
  }

  if (!backendProcess) {
    if (pendingStart) {
      console.log('[electron] Waiting for pending backend start cancellation...');
      const cancellation = pendingStart.then(
        () => {
          if (!backendProcess) return true;
          if (!isBackendProcessAlive(backendProcess)) {
            markBackendProcessStopped(backendProcess);
            return true;
          }
          return false;
        },
        () => !backendProcess,
      );
      const tracked = cancellation.finally(() => {
        if (backendStopPromise === tracked) backendStopPromise = null;
      });
      backendStopPromise = tracked;
      return tracked;
    }
    console.log('[electron] Backend not running');
    return Promise.resolve(true);
  }

  console.log('[electron] Stopping backend...');
  backendStatus = 'stopping';
  sendToRenderer('backend-status', { status: backendStatus });

  const proc = backendProcess;

  const stopPromise = new Promise((resolve) => {
    let settled = false;
    let forceKillTimer = null;
    let finalSettleTimer = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (finalSettleTimer) clearTimeout(finalSettleTimer);
      resolve(result);
    };

    proc.once('exit', () => settle(true));

    const signalFallback = (error) => {
      if (error) {
        console.warn('[electron] Backend stdin shutdown request failed:', error.message || error);
      }
      if (process.platform === 'win32') {
        // Node maps SIGTERM to a parent-only TerminateProcess on Windows. If
        // the graceful stdin channel is unavailable, terminate the tracked
        // backend tree so native sidecars cannot be reparented and stranded.
        forceStopBackendProcessTree(proc);
        return;
      }
      try {
        proc.kill('SIGTERM');
      } catch (signalError) {
        console.warn('[electron] Backend graceful signal fallback failed:', signalError.message || signalError);
      }
    };

    // A piped stdin command works on Windows without abruptly terminating the
    // Node child. Ending the pipe also provides an EOF fallback to the backend.
    const input = proc.stdin;
    if (input && !input.destroyed && !input.writableEnded) {
      const onInputError = (error) => signalFallback(error);
      input.once('error', onInputError);
      try {
        input.end(BACKEND_SHUTDOWN_MESSAGE, () => {
          input.removeListener('error', onInputError);
          debugLog('Backend shutdown request flushed to stdin');
        });
      } catch (error) {
        input.removeListener('error', onInputError);
        signalFallback(error);
      }
    } else {
      signalFallback(new Error('Backend stdin pipe is unavailable'));
    }

    // Allow 12 seconds for graceful cleanup, then own the complete tree kill
    // before the backend's later parent-only last resort can fire.
    forceKillTimer = setTimeout(() => {
      if (isBackendProcessAlive(proc)) {
        console.log('[electron] Force stopping backend process tree');
        forceStopBackendProcessTree(proc);
      }
    }, BACKEND_FORCE_KILL_TIMEOUT_MS);

    // The exit event may be queued behind this timer. Force once more, then
    // poll the OS-visible PID before deciding whether shutdown succeeded.
    finalSettleTimer = setTimeout(() => {
      if (isBackendProcessAlive(proc)) forceStopBackendProcessTree(proc);
      void waitForBackendProcessExit(proc).then((stopped) => {
        if (!stopped && backendProcess === proc) {
          backendStatus = 'error';
          sendToRenderer('backend-status', {
            status: backendStatus,
            error: `Backend process tree ${proc.pid} did not stop`,
          });
        }
        settle(stopped);
      });
    }, BACKEND_EXIT_SETTLE_TIMEOUT_MS);
  });

  backendStopPromise = stopPromise.finally(() => {
    backendStopPromise = null;
  });
  return backendStopPromise;
}

async function restartBackend() {
  const stopped = await stopBackend();
  if (backendProcess && !isBackendProcessAlive(backendProcess)) {
    markBackendProcessStopped(backendProcess);
  }
  if (backendProcess && isBackendProcessAlive(backendProcess)) {
    const error = 'Backend restart cancelled because the existing backend process tree did not stop.';
    backendStatus = 'error';
    sendToRenderer('backend-status', { status: backendStatus, error });
    console.warn(`[electron] ${error}`);
    return false;
  }
  if (!stopped) {
    debugLog('Backend stop reported a failure, but the managed PID is no longer present; restart may proceed.');
  }
  return startBackend();
}

async function shutdownApplication({ relaunch = false } = {}) {
  if (applicationShutdownPromise) return applicationShutdownPromise;

  isQuitSequenceRunning = true;
  isQuitting = true;
  stopTrayRecordingBadge({ restoreDefault: false });
  recordLifecycleSmokeEvent('shutdown-start', { relaunch });

  applicationShutdownPromise = (async () => {
    let stopped = false;
    try {
      stopped = await stopBackend();
    } catch (error) {
      console.warn('[electron] Backend shutdown failed during app exit:', error.message || error);
    }

    if (backendProcess && !isBackendProcessAlive(backendProcess)) {
      markBackendProcessStopped(backendProcess);
    }
    const liveBackend = backendProcess && isBackendProcessAlive(backendProcess);
    if (liveBackend) {
      const pidDetail = liveBackend ? ` (PID ${backendProcess.pid})` : '';
      const error = `Flight Fabric could not verify that its backend process tree stopped${pidDetail}.`;
      backendStatus = 'error';
      sendToRenderer('backend-status', { status: backendStatus, error });
      console.error(`[electron] ${error} Keeping the app and runtime lock active.`);
      recordLifecycleSmokeEvent('shutdown-blocked', { backendPid: backendProcess.pid });
      if (!lifecycleSmokeConfig) {
        try {
          await dialog.showMessageBox({
            type: 'error',
            title: 'Flight Fabric Could Not Quit Safely',
            message: error,
            detail: 'The desktop app will remain open so it does not abandon SimConnect sidecar processes. Try Quit again, or stop the reported backend process tree in Task Manager.',
            buttons: ['Keep Flight Fabric Open'],
            defaultId: 0,
          });
        } catch (dialogError) {
          console.warn('[electron] Failed to show shutdown error:', dialogError.message || dialogError);
        }
      }
      isQuitSequenceRunning = false;
      isQuitting = false;
      return false;
    }
    if (!stopped) {
      debugLog('Backend stop reported a failure, but the managed PID is no longer present; shutdown may proceed.');
    }

    try {
      const frontendStopped = await runBoundedShutdownTask(
        'Frontend server shutdown',
        () => stopFrontendServer(),
      );
      recordLifecycleSmokeEvent('frontend-stopped', { success: frontendStopped });

      const lock = runtimeOwnerLock;
      runtimeOwnerLock = null;
      if (lock) {
        const lockReleased = await runBoundedShutdownTask(
          'Runtime-owner lock release',
          () => lock.release(),
        );
        recordLifecycleSmokeEvent('runtime-lock-released', { success: lockReleased });
      }

      if (relaunch) {
        try {
          app.relaunch();
        } catch (error) {
          console.warn('[electron] Failed to schedule application relaunch:', error.message || error);
        }
      }
    } finally {
      // Once the backend is verified absent, auxiliary cleanup failures must
      // never leave a headless Electron main process running indefinitely.
      recordLifecycleSmokeEvent('app-exit');
      app.exit(0);
    }
    return true;
  })();

  const result = await applicationShutdownPromise;
  if (!result) applicationShutdownPromise = null;
  return result;
}

/**
 * Send message to renderer process
 */
function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send(channel, data);
    } catch (error) {
      debugLog(`Renderer send failed for ${channel}:`, error.message || error);
    }
  }
}

function showTrayCloseNotice() {
  if (hasShownTrayCloseNotice) return;
  hasShownTrayCloseNotice = true;

  const title = 'Flight Fabric is still running';
  const body = 'Flight logging and SimBridge keep running in the tray. Right-click the tray icon and choose Quit to exit.';

  try {
    if (Notification.isSupported()) {
      const notificationOptions = {
        title,
        body,
      };
      if (fs.existsSync(TASKBAR_ICON_PATH)) {
        notificationOptions.icon = TASKBAR_ICON_PATH;
      }
      new Notification(notificationOptions).show();
      return;
    }
  } catch (err) {
    debugLog('Tray close notification failed:', err.message);
  }

  try {
    if (tray && typeof tray.displayBalloon === 'function') {
      tray.displayBalloon({
        title,
        content: body,
        icon: fs.existsSync(TASKBAR_ICON_PATH) ? TASKBAR_ICON_PATH : undefined,
      });
    }
  } catch (err) {
    debugLog('Tray balloon notification failed:', err.message);
  }
}

function hideWindowToTrayOnClose(event) {
  if (isQuitting || !tray || !mainWindow || mainWindow.isDestroyed()) return;

  event.preventDefault();
  mainWindow.hide();
  showTrayCloseNotice();
}

function getTrayIconPath() {
  if (TASKBAR_TRAY_ICON_PATH && fs.existsSync(TASKBAR_TRAY_ICON_PATH)) {
    return TASKBAR_TRAY_ICON_PATH;
  }
  if (fs.existsSync(TASKBAR_ICON_PATH)) {
    return TASKBAR_ICON_PATH;
  }
  return null;
}

function setTrayDefaultImage() {
  if (!tray) return;
  const trayIconPath = getTrayIconPath();
  if (trayIconPath) {
    tray.setImage(trayIconPath);
    trayRecordingBadgeAppliedState = 'stopped';
  }
}

function getRecordingBadgeAssetPath(state, kind) {
  const normalizedState = state === 'finalizing' ? 'finalizing' : 'recording';
  const assetName = RECORDING_BADGE_ASSET_NAMES[normalizedState]?.[kind];
  if (!assetName) return null;
  const assetPath = path.join(RECORDING_BADGE_ASSET_DIR, assetName);
  return fs.existsSync(assetPath) ? assetPath : null;
}

function loadRecordingBadgeImage(state, kind) {
  const assetPath = getRecordingBadgeAssetPath(state, kind);
  if (!assetPath) return null;

  const cacheKey = `${kind}:${state === 'finalizing' ? 'finalizing' : 'recording'}`;
  const cached = recordingNativeImageCache.get(cacheKey);
  if (cached && !cached.isEmpty()) return cached;

  const image = nativeImage.createFromPath(assetPath);
  if (image.isEmpty()) return null;
  recordingNativeImageCache.set(cacheKey, image);
  return image;
}

function createTaskbarRecordingOverlayIcon(state) {
  return loadRecordingBadgeImage(state, 'overlay');
}

function createTrayRecordingIcon(state) {
  return loadRecordingBadgeImage(state, 'tray');
}

function stopTrayRecordingBadge({ restoreDefault = true } = {}) {
  if (restoreDefault) {
    setTrayDefaultImage();
  }
}

function setTrayRecordingBadgeImage(state, { force = false } = {}) {
  if (!tray) return;

  const normalizedState = state === 'finalizing' ? 'finalizing' : 'recording';
  if (!force && trayRecordingBadgeAppliedState === normalizedState) return;

  const recordingIcon = createTrayRecordingIcon(state);
  if (!recordingIcon || recordingIcon.isEmpty()) {
    setTrayDefaultImage();
    return;
  }

  tray.setImage(recordingIcon);
  trayRecordingBadgeAppliedState = normalizedState;
}

function setTaskbarRecordingBadgeImage(state, { force = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed() || typeof mainWindow.setOverlayIcon !== 'function') return;

  const isActive = state === 'recording' || state === 'finalizing';
  const normalizedState = isActive ? state : 'stopped';
  if (!force && taskbarRecordingBadgeAppliedState === normalizedState) return;
  const activityLabel = state === 'finalizing' ? 'Saving flight log' : 'Recording';
  const overlayIcon = isActive ? createTaskbarRecordingOverlayIcon(state) : null;
  mainWindow.setOverlayIcon(
    overlayIcon && !overlayIcon.isEmpty() ? overlayIcon : null,
    isActive ? activityLabel : '',
  );
  taskbarRecordingBadgeAppliedState = normalizedState;
}

function setRecordingBadge(payload = {}) {
  const rawStatus = typeof payload.status === 'string' ? payload.status.toLowerCase() : '';
  const nextState = rawStatus === 'recording' || rawStatus === 'finalizing' ? rawStatus : 'stopped';
  recordingBadgeState = nextState;

  const isActive = nextState === 'recording' || nextState === 'finalizing';
  const activityLabel = nextState === 'finalizing' ? 'Saving flight log' : 'Recording';
  const tooltip = isActive ? `Flight Fabric - ${activityLabel}` : 'Flight Fabric';

  try {
    setTaskbarRecordingBadgeImage(nextState);
  } catch (err) {
    debugLog('Recording taskbar badge update failed:', err.message);
  }

  try {
    if (tray) {
      if (isActive) {
        setTrayRecordingBadgeImage(nextState);
      } else {
        stopTrayRecordingBadge();
      }
      tray.setToolTip(tooltip);
    }
  } catch (err) {
    debugLog('Recording tray badge update failed:', err.message);
  }

  return { ok: true, state: recordingBadgeState };
}

/**
 * Create the main window
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'Flight Fabric',
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#05070a',
    autoHideMenuBar: true,
    icon: fs.existsSync(TASKBAR_ICON_PATH) ? TASKBAR_ICON_PATH : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      webSecurity: true, // Keep true for security, but log if CSS fails
      autoplayPolicy: 'no-user-gesture-required', // Allow cabin PA audio to play without a click first
    },
    show: false, // Don't show until ready
  });

  if (recordingBadgeState !== 'stopped') {
    try {
      setTaskbarRecordingBadgeImage(recordingBadgeState, { force: true });
    } catch (err) {
      debugLog('Recording taskbar badge restore failed:', err.message);
    }
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isFrontendAppUrl(url)) {
      mainWindow.loadURL(url).catch((err) => {
        debugLog('Same-window navigation failed:', err.message);
      });
      return { action: 'deny' };
    }
    openExternalBrowserUrl(url, 'window-open URL');
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isFrontendAppUrl(url)) return;
    event.preventDefault();
    openExternalBrowserUrl(url, 'top-level navigation');
  });

  loadDesktopApp(mainWindow).then(() => {
    debugLog('Desktop UI loaded successfully');
  }).catch((desktopErr) => {
    debugLog('Desktop UI load error:', desktopErr.message);
    loadLegacyLauncher(mainWindow).then(() => {
      debugLog('Legacy launcher loaded as fallback');
    }).catch((launcherErr) => {
      debugLog('Legacy launcher load error:', launcherErr.message);
      const fallbackDocument = buildEmergencyFallbackDocument();
      mainWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(fallbackDocument)}`);
    });
  });

  // Show when ready
  mainWindow.once('ready-to-show', () => {
    if (!lifecycleSmokeConfig) mainWindow.show();
    // Open DevTools in dev mode to debug CSS issues
    if (isDev) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  mainWindow.on('close', hideWindowToTrayOnClose);

  mainWindow.on('closed', () => {
    mainWindow = null;
    taskbarRecordingBadgeAppliedState = null;
  });
}

/**
 * Create system tray
 */
function createTray() {
  // Skip tray if no icon available (can't create tray without icon on Windows)
  const trayIconPath = getTrayIconPath();
  if (!trayIconPath) {
    console.log('[electron] No icon found, skipping tray creation');
    return;
  }
  
  try {
    tray = new Tray(trayIconPath);
    trayRecordingBadgeAppliedState = 'stopped';
  
  const contextMenu = Menu.buildFromTemplate([
    { 
      label: 'Show Window', 
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Start Backend',
      click: () => startBackend(),
    },
    {
      label: 'Stop Backend',
      click: () => stopBackend(),
    },
    {
      label: 'Restart Backend',
      click: () => restartBackend(),
    },
    { type: 'separator' },
    {
      label: 'Show Desktop UI',
      click: () => {
        if (!mainWindow) return;
        mainWindow.show();
        mainWindow.focus();
        loadDesktopApp(mainWindow).catch((err) => {
          debugLog('Tray Desktop UI navigation failed:', err.message);
        });
      },
    },
    {
      label: 'Recovery Launcher',
      click: () => {
        if (!mainWindow) return;
        mainWindow.show();
        mainWindow.focus();
        loadLegacyLauncher(mainWindow).catch((err) => {
          debugLog('Tray launcher fallback failed:', err.message);
        });
      },
    },
    { type: 'separator' },
    { 
      label: 'Quit', 
      click: () => {
        isQuitting = true;
        app.quit();
      }
    },
  ]);

  tray.setToolTip(recordingBadgeState === 'stopped' ? 'Flight Fabric' : `Flight Fabric - ${recordingBadgeState === 'finalizing' ? 'Saving flight log' : 'Recording'}`);
  tray.setContextMenu(contextMenu);
  if (recordingBadgeState !== 'stopped') {
    setTrayRecordingBadgeImage(recordingBadgeState, { force: true });
  }
  
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  } catch (err) {
    console.error('[electron] Failed to create tray:', err);
  }
}

// IPC handlers - Backend
registerTrustedIpcHandler('backend-start', () => startBackend());
registerTrustedIpcHandler('backend-stop', async () => {
  await stopBackend();
  return { status: backendStatus };
});
registerTrustedIpcHandler('backend-restart', async () => {
  await restartBackend();
  return { status: backendStatus };
});
registerTrustedIpcHandler('app-restart', async () => {
  const ok = await shutdownApplication({ relaunch: true });
  return { ok };
});
registerTrustedIpcHandler('backend-status', () => ({ status: backendStatus }));
registerTrustedIpcHandler('backend-logs', () => lastBackendOutput);
registerTrustedIpcHandler('backend-ws-port', () => getBackendRuntimePorts().wsPort);
registerTrustedIpcHandler('backend-http-port', () => getBackendRuntimePorts().httpPort);
registerTrustedIpcHandler('backend-bootstrap', () => fetchBackendBootstrapViaBackend());
registerTrustedIpcHandler('simbrief-fetch', (_, username) => fetchSimbriefViaBackend(username));
registerTrustedIpcHandler('recording-badge-set', (_, payload) => setRecordingBadge(payload));

registerTrustedIpcHandler('settings-get', () => {
  const settings = settingsStore.getSettings();
  return { success: true, settings, settingsFile: settingsStore.settingsFile };
});

registerTrustedIpcHandler('settings-save', (_, payload) => {
  try {
    createBackendPortSnapshot(payload?.wsPort, payload?.httpPort);
  } catch (error) {
    return { success: false, message: error.message || String(error) };
  }
  const result = settingsStore.saveSettings(payload);
  if (result.success) {
    ({ backendWsPort, backendHttpPort } = settingsStore.refreshRuntimeNetworkFromSettings(
      { backendWsPort, backendHttpPort },
      process.env,
    ));
  }
  return result;
});

registerTrustedIpcHandler('settings-reset', () => {
  const result = settingsStore.resetSettings();
  if (result.success) {
    ({ backendWsPort, backendHttpPort } = settingsStore.refreshRuntimeNetworkFromSettings(
      { backendWsPort, backendHttpPort },
      process.env,
    ));
  }
  return result;
});

registerTrustedIpcHandler('storage-locations-get', () => ({
  success: true,
  locations: [
    {
      id: 'appData',
      label: 'App Data',
      path: getAppDataRoot(),
      description: 'Settings, aircraft profiles, logbook metadata, local SDK connectors, and app-owned runtime state.',
    },
    {
      id: 'settings',
      label: 'Settings File',
      path: getSettingsFilePath(),
      description: 'The JSON settings file shared by the desktop app and backend.',
    },
    {
      id: 'electronData',
      label: 'Electron Data',
      path: ELECTRON_USER_DATA_DIR,
      description: 'Window state, Chromium cache/session data, and Electron-owned desktop app data.',
    },
    {
      id: 'flightLogs',
      label: 'Flight Logs',
      path: resolveFlightLogsDir({ createIfMissing: false }),
      description: 'User-visible CSV flight recordings saved under your Documents folder.',
    },
    {
      id: 'profiles',
      label: 'Aircraft Profiles',
      path: getProfilesRootDir(),
      description: 'Editable local aircraft profile overrides. Bundled defaults ship with the app.',
    },
    {
      id: 'settingsDir',
      label: 'Settings Folder',
      path: getSettingsDir(),
      description: 'The folder containing Flight Fabric settings files.',
    },
  ],
}));

// HTTP server status
registerTrustedIpcHandler('http-status', () => ({ status: frontendServerStatus, port: frontendPort }));
registerTrustedIpcHandler('startup-health', () => startupHealth);

// MSFS install detection - read-only filesystem probe, no traversal
registerTrustedIpcHandler('msfs-detect-installs', () => detectMsfsInstalls());

// Network info for Remote Access modal
registerTrustedIpcHandler('get-network-info', () => {
  const ips = getLocalIPv4AddressesFromInterfaces(os.networkInterfaces());
  const { httpPort, wsPort } = getBackendRuntimePorts();
  return { ips, httpPort, wsPort };
});

// IPC handlers - Navigation
registerTrustedIpcHandler('open-overlay', async (event, options = {}) => {
  const tab = options && typeof options.tab === 'string' ? options.tab.trim() : '';
  try {
    return await loadDesktopApp(getWindowFromEvent(event), { tab });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC handlers - Flight Recording
registerTrustedIpcHandler('pick-export-folder', async () => {
  const defaultPath = path.join(app.getPath('documents'), 'Flight Fabric', 'Flight Logs');
  
  // Ensure default folder exists
  try {
    if (!fs.existsSync(defaultPath)) {
      fs.mkdirSync(defaultPath, { recursive: true });
    }
  } catch (e) {
    debugLog('[pick-export-folder] Could not create default folder:', e.message);
  }
  
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Export Location',
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Export Here',
  });
  
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  
  return result.filePaths[0];
});

registerTrustedIpcHandler('reveal-in-explorer', async (_, folderPath) => {
  try {
    // Validate path is within expected user-owned directories (documents or app data)
    if (typeof folderPath !== 'string' || !folderPath.trim()) {
      return { success: false, error: 'Invalid folder path' };
    }
    const resolved = path.resolve(folderPath);
    const docsDir = app.getPath('documents');
    const docsAppDir = path.join(docsDir, 'Flight Fabric');
    const flightLogsAppDir = path.dirname(resolveFlightLogsDir({ createIfMissing: false }));
    const appDataDir = path.join(app.getPath('appData'), 'Flight Fabric');
    const inAllowedDir =
      isPathInsideOrEqual(docsAppDir, resolved) ||
      isPathInsideOrEqual(flightLogsAppDir, resolved) ||
      isPathInsideOrEqual(appDataDir, resolved);
    if (!inAllowedDir) {
      return { success: false, error: 'Path outside allowed directories' };
    }
    shell.showItemInFolder(resolved);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Legal files: allowlist of filenames that can be opened from resources/legal/.
// Never accept a full path from the renderer - only these known filenames.
const LEGAL_FILES_ALLOWLIST = new Set([
  'SAFETY-NOTICE.md',
  'LICENSE.md',
  'THIRD_PARTY_NOTICES.md',
  'OURAIRPORTS-DATA-LICENSE.txt',
]);

registerTrustedIpcHandler('open-legal-file', async (_, filename) => {
  if (typeof filename !== 'string' || !LEGAL_FILES_ALLOWLIST.has(filename)) {
    return { success: false, error: 'Unknown legal file' };
  }
  if (!process.resourcesPath) {
    return { success: false, error: 'Not running in packaged mode' };
  }
  const legalDir = path.join(process.resourcesPath, 'legal');
  const filePath = path.join(legalDir, filename);
  // Double-check resolved path is still inside legalDir (no traversal)
  if (!isPathInsideOrEqual(legalDir, filePath)) {
    return { success: false, error: 'Path traversal detected' };
  }
  try {
    const errMsg = await shell.openPath(filePath);
    if (errMsg) return { success: false, error: errMsg };
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

registerTrustedIpcHandler('reveal-legal-folder', async () => {
  if (!process.resourcesPath) {
    return { success: false, error: 'Not running in packaged mode' };
  }
  const legalDir = path.join(process.resourcesPath, 'legal');
  try {
    shell.showItemInFolder(legalDir);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// App lifecycle
void app.whenReady().then(async () => {
  if (!gotTheLock) return;
  installDefaultSessionPermissionPolicy();
  const lock = await acquireRuntimeOwnerLock({ owner: 'electron' });
  if (!lock.acquired) {
    recordLifecycleSmokeEvent('startup-blocked', { reason: 'runtime-owner-lock' });
    if (!lifecycleSmokeConfig) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'Flight Fabric Already Running',
        message: 'Another Flight Fabric launch mode is already active.',
        detail: 'Close the standalone backend window or quit the other Flight Fabric desktop instance, then try again. This app will not attach to a backend it does not own.',
        buttons: ['Quit Flight Fabric'],
        defaultId: 0,
      });
    }
    app.quit();
    return;
  }
  runtimeOwnerLock = lock;

  const health = await runStartupHealthChecks();
  if (!health) {
    // A backend port conflict was declined or could not be resolved. Do not
    // create a window and then auto-spawn a backend that cannot bind its ports.
    app.quit();
    return;
  }

  // Start the static file server before the window loads the Vue Desktop UI.
  const frontendResult = await startFrontendServer();
  if (frontendResult?.status !== 'running') {
    await stopFrontendServer();
    throw new Error(frontendResult?.error || 'Frontend server did not reach running state');
  }
  
  // The packaged lifecycle probe exercises the real main/backend/guardian
  // process tree without creating Chromium renderers. This keeps the probe
  // independent of GPU availability on headless Windows build agents while
  // leaving the production UI path unchanged.
  if (!lifecycleSmokeConfig) {
    createWindow();
    createTray();
  }
  recordLifecycleSmokeEvent('app-initialized');
  // Backend ownership must not depend on renderer navigation or
  // BrowserWindow ready-to-show, both of which can fail or hang.
  void startBackend().then((started) => {
    if (!started && lifecycleSmokeConfig) {
      recordLifecycleSmokeEvent('startup-blocked', { reason: 'backend-start-failed' });
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch(async (error) => {
  console.error('[electron] Fatal startup failure:', error);
  recordLifecycleSmokeEvent('startup-blocked', {
    reason: 'fatal-startup',
    error: error?.message || String(error),
  });
  if (!lifecycleSmokeConfig) {
    try {
      await dialog.showMessageBox({
        type: 'error',
        title: 'Flight Fabric Could Not Start',
        message: 'Flight Fabric encountered an unexpected startup error.',
        detail: error?.stack || error?.message || String(error),
        buttons: ['Quit Flight Fabric'],
        defaultId: 0,
      });
    } catch (dialogError) {
      console.warn('[electron] Failed to show startup error:', dialogError.message || dialogError);
    }
  }
  try {
    await shutdownApplication();
  } catch (shutdownError) {
    console.error('[electron] Fatal startup cleanup failed:', shutdownError);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  event.preventDefault();
  if (!lifecycleSmokeBeforeQuitRecorded) {
    lifecycleSmokeBeforeQuitRecorded = true;
    recordLifecycleSmokeEvent('before-quit');
  }
  if (isQuitSequenceRunning) return;
  void shutdownApplication();
});

// Handle second instance (single instance lock)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
