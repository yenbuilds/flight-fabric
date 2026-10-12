/**
 * stability-debug-logger.js
 *
 * Dedicated file-based debug logger for stability scoring.
 * Logs detailed information about gate checks, approach samples, and retrospective scoring
 * to help diagnose scoring issues.
 */

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const config = require('../core/config.js') as {
  stability?: {
    debugLog?: boolean;
  };
};
const timeSource = require('../core/time-source.js') as {
  now: () => number;
};

type LoggableData = Record<string, unknown>;

const LOG_DIR = path.resolve(__dirname, '..', 'logs', 'stability');
const SESSION_START = new Date().toISOString();
const SESSION_ID = SESSION_START.replace(/[:.]/g, '-').slice(0, 19);
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024;
const ROTATION_CHECK_INTERVAL = 50;

let writesSinceRotationCheck = 0;
let activeStream: import('fs').WriteStream | null = null;
let activeStreamPath: string | null = null;

const LOG_THROTTLE_MS_BY_CATEGORY: Record<string, number> = {
  SAMPLE: 1000,
  RAW_INPUT: 1000,
  RESET: 1000,
};

const lastLogTimestampByCategory: Record<string, number> = Object.create(null);

function isEnabled(): boolean {
  return config.stability?.debugLog === true;
}

function getLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `${date}_stability.log`);
}

let logDirVerified = false;
function ensureLogDir(): void {
  if (logDirVerified) return;
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
  logDirVerified = true;
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toFixed(2) : String(value);
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function ensureActiveStream(logPath: string): void {
  if (activeStreamPath === logPath && activeStream) return;
  if (activeStream) {
    try {
      activeStream.end();
    } catch {}
  }
  activeStream = fs.createWriteStream(logPath, { flags: 'a' });
  activeStream.on('error', () => {});
  activeStreamPath = logPath;
  writesSinceRotationCheck = 0;
}

function rotateIfNeeded(logPath: string): void {
  writesSinceRotationCheck += 1;
  if (writesSinceRotationCheck < ROTATION_CHECK_INTERVAL) return;
  writesSinceRotationCheck = 0;

  try {
    const stat = fs.statSync(logPath);
    if (stat.size >= MAX_LOG_SIZE_BYTES && activeStream) {
      activeStream.end();
      fs.renameSync(logPath, `${logPath}.1`);
      activeStream = fs.createWriteStream(logPath, { flags: 'a' });
      activeStream.on('error', () => {});
    }
  } catch {}
}

function writeLog(category: string, message: string, data: LoggableData = {}): void {
  if (!isEnabled()) return;

  const throttleMs = LOG_THROTTLE_MS_BY_CATEGORY[category];
  if (throttleMs) {
    const now = timeSource.now();
    const last = lastLogTimestampByCategory[category] || 0;
    if (now - last < throttleMs) return;
    lastLogTimestampByCategory[category] = now;
  }

  try {
    ensureLogDir();
    const timestamp = new Date().toISOString();
    const logPath = getLogPath();
    let line = `[${timestamp}] [${SESSION_ID}] [${category}] ${message}`;

    const keys = Object.keys(data);
    if (keys.length > 0) {
      const dataStr = Object.entries(data)
        .map(([key, value]) => `${key}=${formatValue(value)}`)
        .join(', ');
      line += ` | ${dataStr}`;
    }
    line += '\n';

    ensureActiveStream(logPath);
    rotateIfNeeded(logPath);
    activeStream?.write(line);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[stability-debug-logger] Write failed:', errorMessage);
  }
}

const stabilityDebugLoggerApi = {
  isEnabled,
  writeLog,
};

module.exports = stabilityDebugLoggerApi;

export {};
