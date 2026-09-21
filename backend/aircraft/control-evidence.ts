/**
 * Control evidence: one small JSON line per aircraft command the app sends,
 * recording what was asked, which route carried it, and what the readback
 * saw. Every value here is already computed for the panel result; this only
 * keeps it.
 *
 * Boundaries:
 * - Never throws and never blocks: writes are queued and appended
 *   asynchronously; any failure is swallowed after one debug line.
 * - Contains no position, identity or path data. Fields are switch states,
 *   numbers, action ids and timings.
 * - Lives at <app data>/control-evidence.jsonl, capped by rotating to
 *   control-evidence.1.jsonl before an append would exceed 5 MiB. Existing
 *   oversized files from older builds are preserved by rotation, not trimmed.
 * - FF_CONTROL_EVIDENCE=0 disables it entirely.
 */
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');

const storagePaths = require('../utils/storage-paths') as { getAppDataRoot: (env?: NodeJS.ProcessEnv) => string };
const { getAppVersion } = require('../core/app-version') as typeof import('../core/app-version');

type GenericRecord = Record<string, any>;
export type ControlEvidenceEntry = GenericRecord;

const FILE_NAME = 'control-evidence.jsonl';
const ROTATED_FILE_NAME = 'control-evidence.1.jsonl';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 300;
const MAX_QUEUE = 200;
const MAX_ENTRY_BYTES = 32 * 1024;
const MAX_ENTRY_VALUES = 512;
const MAX_QUEUE_BYTES = 256 * 1024;
// Resolved through app-version so the packaged backend (whose manifest is one
// directory up, not two) records the same version as the rest of the runtime.
const appVersion: string | null = getAppVersion();

const boundedText = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value) return undefined;
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
};
const scalar = (value: unknown): string | number | boolean | null | undefined => {
  if (value === null || value === undefined) return value as null | undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return boundedText(value);
  return undefined;
};

/** Pick the evidence fields out of a normalized control result and its resolution. */
export function buildControlEvidence(result: GenericRecord, resolved: GenericRecord, context: { elapsedMs?: number; aircraftTitle?: string | null } = {}): ControlEvidenceEntry {
  const request = (resolved?.request || result?.request || {}) as GenericRecord;
  const action = (resolved?.action || result?.action || {}) as GenericRecord;
  const entry: ControlEvidenceEntry = {
    t: new Date().toISOString(),
    app: appVersion,
    aircraft: boundedText(context.aircraftTitle || undefined) ?? null,
    profile: scalar(resolved?.profileKey ?? result?.profileKey) ?? null,
    profileRevision: scalar(resolved?.profileRevision ?? result?.profileRevision) ?? null,
    simulator: scalar(resolved?.simulator ?? result?.simulator) ?? null,
    control: scalar(request.control) ?? null,
    action: scalar(request.actionId ?? request.target ?? request.action ?? request.command) ?? null,
    actionType: scalar(action.type) ?? null,
    value: scalar(request.value),
    resolvedBy: scalar(resolved?.resolvedBy ?? result?.resolvedBy) ?? null,
    integration: scalar(result?.integrationId),
    route: scalar(result?.routeId),
    transport: scalar(result?.transportMode ?? result?.transport),
    ok: result?.ok === true,
    code: scalar(result?.code) ?? null,
    error: result?.ok === true ? undefined : boundedText(result?.error),
    acknowledged: result?.transportAcknowledged === true ? true : undefined,
    skipped: result?.skipped === true || result?.noOp === true ? true : undefined,
    confirmed: result?.confirmedValues && typeof result.confirmedValues === 'object'
      ? Object.fromEntries(Object.entries(result.confirmedValues).map(([k, v]) => [k, scalar(v)]))
      : scalar(result?.confirmedValue),
    observed: scalar(result?.observedValue),
    expected: scalar(result?.expectedValue),
    readbackAdvanced: typeof result?.readbackAdvanced === 'boolean' ? result.readbackAdvanced : undefined,
    elapsedMs: Number.isFinite(context.elapsedMs) ? Math.round(context.elapsedMs as number) : undefined,
  };
  for (const key of Object.keys(entry)) if (entry[key] === undefined) delete entry[key];
  return entry;
}

let queue: Buffer[] = [];
let queuedBytes = 0;
let flushing: Promise<void> | null = null;
let warned = false;
let overrideDir: string | null = null;

export function isControlEvidenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = String(env.FF_CONTROL_EVIDENCE ?? '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off');
}

export function getControlEvidenceFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(overrideDir || storagePaths.getAppDataRoot(env), FILE_NAME);
}

/** Tests point the log at a temporary directory. */
export function setControlEvidenceDirectoryForTests(dir: string | null): void { overrideDir = dir; }

/** Queue one entry. Returns immediately; the append happens on its own. */
export function recordControlEvidence(entry: ControlEvidenceEntry, env: NodeJS.ProcessEnv = process.env): void {
  if (!isControlEvidenceEnabled(env)) return;
  let line: Buffer;
  try {
    // Evidence is optional. Refuse unreasonable diagnostic objects before
    // walking/stringifying their entire contents, including deeply nested or
    // circular input. Account for JSON escaping with the final byte check.
    let remainingBytes = MAX_ENTRY_BYTES;
    let values = 0;
    const serialized = JSON.stringify(entry, (key, value) => {
      if (++values > MAX_ENTRY_VALUES || key.length > MAX_ENTRY_BYTES
        || (typeof value === 'string' && value.length > MAX_ENTRY_BYTES)) throw new Error('Evidence entry too large');
      remainingBytes -= Buffer.byteLength(key, 'utf8') + 6;
      if (typeof value === 'string') remainingBytes -= Buffer.byteLength(value, 'utf8');
      if (remainingBytes < 0) throw new Error('Evidence entry too large');
      return value;
    });
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') + 1 > MAX_ENTRY_BYTES) return;
    line = Buffer.from(`${serialized}\n`, 'utf8');
  } catch { return; }
  // Bound both the number and bytes of pending entries while disk I/O is
  // slow. Prefer recent evidence; dropped diagnostics never affect controls.
  while (queue.length >= MAX_QUEUE || queuedBytes + line.length > MAX_QUEUE_BYTES) {
    queuedBytes -= queue.shift()!.length;
  }
  queue.push(line);
  queuedBytes += line.length;
  startFlush(env);
}

function startFlush(env: NodeJS.ProcessEnv): void {
  if (flushing) return;
  flushing = flush(env).finally(() => {
    flushing = null;
    if (queue.length) startFlush(env);
  });
}

async function appendBatch(batch: Buffer, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const file = getControlEvidenceFilePath(env);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    let size = 0;
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error('Evidence file size is unavailable');
      size = stat.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    // A stat failure or failed rotation must drop this batch. Neither means
    // an empty file, and continuing to append would bypass the size limit.
    if (size + batch.length > MAX_FILE_BYTES) {
      await fs.promises.rename(file, path.join(path.dirname(file), ROTATED_FILE_NAME));
    }
    await fs.promises.appendFile(file, batch);
  } catch (error) {
    if (!warned) { warned = true; console.warn(`[control-evidence] not recording: ${(error as Error)?.message || error}`); }
  }
}

async function flush(env: NodeJS.ProcessEnv): Promise<void> {
  while (queue.length) {
    const batch = Buffer.concat(queue, queuedBytes);
    queue = [];
    queuedBytes = 0;
    await appendBatch(batch, env);
  }
}

/** Wait for queued lines to land. Tests only; the app never needs to. */
export async function flushControlEvidenceForTests(): Promise<void> {
  while (flushing || queue.length) {
    if (!flushing) startFlush(process.env);
    await flushing;
  }
}

const controlEvidenceApi = { buildControlEvidence, recordControlEvidence, isControlEvidenceEnabled, getControlEvidenceFilePath, setControlEvidenceDirectoryForTests, flushControlEvidenceForTests };
module.exports = controlEvidenceApi;
export {};
