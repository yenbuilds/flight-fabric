// Lightweight, centralized debug logging with optional WS broadcast.
//
// SECURITY NOTES:
//   - In packaged mode, paths in data objects are redacted to prevent PII exposure
//   - Debug logs are in-memory only (MAX_BUFFER entries), not persisted to disk
//   - WS broadcast only happens if DEBUG_ENABLE=1 (disabled by default in packaged)

const config = require('./config.js') as {
  debug: { enable: boolean };
  env?: { isPackaged?: boolean };
  osPaths?: {
    appData?: string | null;
    home?: string | null;
    userProfile?: string | null;
    xdgConfigHome?: string | null;
  };
};
const timeSource = require('./time-source.js') as typeof import('./time-source');

export type DebugEntry = {
  ts: number;
  section: string;
  message: string;
  data: unknown;
};

type BroadcastFn = ((payload: Record<string, unknown>) => void) | null;

const MAX_BUFFER = 500;
const enabled = config.debug.enable;
const isPackaged = config.env?.isPackaged ?? false;

let broadcastFn: BroadcastFn = null;
let buffer: DebugEntry[] = [];

function redactPathString(str: string): string {
  let redacted = str;
  for (const root of [
    config.osPaths?.appData,
    config.osPaths?.home,
    config.osPaths?.userProfile,
    config.osPaths?.xdgConfigHome,
  ]) {
    if (root && root.length > 1) {
      redacted = redacted.split(root).join('<HOME>');
    }
  }

  return redacted
    .replace(/[A-Za-z]:\\Users\\[^\\]+/gi, '<HOME>')
    .replace(/\/Users\/[^\/]+/g, '<HOME>')
    .replace(/\/home\/[^\/]+/g, '<HOME>');
}

function redactPaths(obj: unknown, seen = new WeakSet<object>()): unknown {
  if (!isPackaged) return obj;
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return redactPathString(obj);
  }

  if (Array.isArray(obj)) {
    if (seen.has(obj)) return '[Circular]';
    seen.add(obj);
    return obj.map((value) => redactPaths(value, seen));
  }

  if (typeof obj === 'object') {
    if (seen.has(obj)) return '[Circular]';
    seen.add(obj);
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (/path|dir|file|location|root/i.test(key) && typeof value === 'string') {
        result[key] = redactPathString(value);
      } else {
        result[key] = redactPaths(value, seen);
      }
    }
    return result;
  }

  return obj;
}

export function init(broadcast: unknown): void {
  broadcastFn = typeof broadcast === 'function'
    ? (broadcast as (payload: Record<string, unknown>) => void)
    : null;
}

export function log(section: string, message: string, data?: unknown): void {
  if (!enabled) return;

  let safeData: unknown = null;
  try {
    safeData = data === undefined ? null : redactPaths(data);
  } catch (error) {
    const err = error as { message?: string };
    safeData = {
      redactionError: err?.message || String(err),
    };
  }
  const safeMessage = isPackaged ? redactPathString(message) : message;

  const entry: DebugEntry = {
    ts: timeSource.now(),
    section: section || 'general',
    message: safeMessage || '',
    data: safeData,
  };

  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) {
    buffer = buffer.slice(Math.floor(MAX_BUFFER * 0.1));
  }

  try {
    const zulu = new Date(entry.ts).toISOString().slice(11, 23) + 'Z';
    const prefix = `[${zulu}][DEBUG:${entry.section}]`;
    if (entry.data !== null) {
      console.log(prefix, entry.message, entry.data);
    } else {
      console.log(prefix, entry.message);
    }
  } catch {}

  if (broadcastFn) {
    try {
      broadcastFn({ type: 'debug', entry });
    } catch {}
  }
}

function zuluNow(): string {
  return new Date(timeSource.now()).toISOString().slice(11, 23) + 'Z';
}

export function tlog(prefix: string, ...args: unknown[]): void {
  const ts = zuluNow();
  console.log(`[${ts}]${prefix}`, ...args);
}

export function twarn(prefix: string, ...args: unknown[]): void {
  const ts = zuluNow();
  console.warn(`[${ts}]${prefix}`, ...args);
}
