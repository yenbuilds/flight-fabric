/**
 * CSV Read Guard - synchronizes read paths with the active append-only writer.
 *
 * Timeline/logbook reads are often requested while a flight is still recording.
 * The writer may have rows buffered in-process or in the worker thread, so
 * consumers must flush the active CSV before treating it as complete enough to
 * read. This module keeps that active-file comparison and fail-closed flush
 * behavior in one place for the store and websocket handlers.
 */
'use strict';

const path = require('path') as typeof import('path');

type AnyRecord = Record<string, any>;
type DebugLike = { log?: (_scope: string, _event: string, _payload?: AnyRecord) => void } | null | undefined;
type RecordingBundleGuard = {
  isOwnedCsvPath?: (_csvPath: unknown) => boolean;
  isFinalizing?: () => boolean;
  isBusy?: () => boolean;
  getActiveCsvPath?: () => string | null;
  flushActiveBundle?: () => Promise<boolean>;
} | null | undefined;

function resolveCsvPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return path.resolve(value);
  } catch {
    return null;
  }
}

function compareCsvPath(value: unknown): string | null {
  const resolved = resolveCsvPath(value);
  if (!resolved) return null;
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function getActiveCsvPath(flightCsvWriter: AnyRecord | null | undefined): string | null {
  try {
    if (!flightCsvWriter || typeof flightCsvWriter.isRecording !== 'function' || !flightCsvWriter.isRecording()) {
      return null;
    }
    const stats = typeof flightCsvWriter.getStats === 'function' ? flightCsvWriter.getStats() : null;
    return resolveCsvPath(stats?.filePath);
  } catch {
    return null;
  }
}

function getFinalizingCsvPath(flightCsvWriter: AnyRecord | null | undefined): string | null {
  try {
    if (!flightCsvWriter || typeof flightCsvWriter.isFinalizing !== 'function' || !flightCsvWriter.isFinalizing()) {
      return null;
    }
    const stats = typeof flightCsvWriter.getFinalizingStats === 'function'
      ? flightCsvWriter.getFinalizingStats()
      : null;
    return resolveCsvPath(stats?.filePath);
  } catch {
    return null;
  }
}

function isActiveCsvPath(flightCsvWriter: AnyRecord | null | undefined, csvPath: unknown): boolean {
  const activePath = compareCsvPath(getActiveCsvPath(flightCsvWriter));
  const requestedPath = compareCsvPath(csvPath);
  return Boolean(activePath && requestedPath && activePath === requestedPath);
}

function isFinalizingCsvPath(flightCsvWriter: AnyRecord | null | undefined, csvPath: unknown): boolean {
  const finalizingPath = compareCsvPath(getFinalizingCsvPath(flightCsvWriter));
  const requestedPath = compareCsvPath(csvPath);
  return Boolean(finalizingPath && requestedPath && finalizingPath === requestedPath);
}

function debugLog(Debug: DebugLike, event: string, payload?: AnyRecord): void {
  try {
    if (Debug && typeof Debug.log === 'function') {
      Debug.log('csv', event, payload);
    }
  } catch {
    // Diagnostics must never break a CSV read decision.
  }
}

async function flushActiveCsvBeforeRead(
  flightCsvWriter: AnyRecord | null | undefined,
  csvPath: unknown,
  Debug?: DebugLike,
  recordingBundleGuard?: RecordingBundleGuard,
): Promise<boolean> {
  if (recordingBundleGuard?.isOwnedCsvPath?.(csvPath)) {
    if (recordingBundleGuard.isFinalizing?.() || recordingBundleGuard.isBusy?.()) return false;
    if (typeof recordingBundleGuard.flushActiveBundle !== 'function') return false;
    try {
      return await recordingBundleGuard.flushActiveBundle();
    } catch {
      return false;
    }
  }
  if (isFinalizingCsvPath(flightCsvWriter, csvPath)) return false;
  if (!isActiveCsvPath(flightCsvWriter, csvPath)) return true;
  if (!flightCsvWriter || typeof flightCsvWriter.flush !== 'function') return false;

  try {
    const ok = await flightCsvWriter.flush();
    if (!ok) {
      debugLog(Debug, 'active_csv_flush_before_read_failed', { filePath: resolveCsvPath(csvPath) });
    }
    return ok !== false;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    debugLog(Debug, 'active_csv_flush_before_read_error', {
      error: errorMessage,
    });
    return false;
  }
}

async function flushActiveCsvBeforeDirectoryRead(
  flightCsvWriter: AnyRecord | null | undefined,
  Debug?: DebugLike,
  recordingBundleGuard?: RecordingBundleGuard,
): Promise<{ ready: boolean; activeCsvPath: string | null }> {
  const bundleActivePath = resolveCsvPath(recordingBundleGuard?.getActiveCsvPath?.());
  if (recordingBundleGuard?.isFinalizing?.() || recordingBundleGuard?.isBusy?.()) {
    return { ready: false, activeCsvPath: bundleActivePath };
  }
  if (bundleActivePath) {
    if (typeof recordingBundleGuard?.flushActiveBundle !== 'function') {
      return { ready: false, activeCsvPath: bundleActivePath };
    }
    try {
      const ready = await recordingBundleGuard.flushActiveBundle();
      return { ready, activeCsvPath: bundleActivePath };
    } catch {
      return { ready: false, activeCsvPath: bundleActivePath };
    }
  }
  const finalizingCsvPath = getFinalizingCsvPath(flightCsvWriter);
  if (finalizingCsvPath) return { ready: false, activeCsvPath: finalizingCsvPath };
  const activeCsvPath = getActiveCsvPath(flightCsvWriter);
  if (!activeCsvPath) return { ready: true, activeCsvPath: null };
  if (!flightCsvWriter || typeof flightCsvWriter.flush !== 'function') {
    return { ready: false, activeCsvPath };
  }

  try {
    const ok = await flightCsvWriter.flush();
    if (!ok) debugLog(Debug, 'active_csv_flush_before_directory_read_failed', { filePath: activeCsvPath });
    return { ready: ok !== false, activeCsvPath };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    debugLog(Debug, 'active_csv_flush_before_directory_read_error', {
      error: errorMessage,
      filePath: activeCsvPath,
    });
    return { ready: false, activeCsvPath };
  }
}

module.exports = {
  compareCsvPath,
  flushActiveCsvBeforeDirectoryRead,
  flushActiveCsvBeforeRead,
  getActiveCsvPath,
  getFinalizingCsvPath,
  isActiveCsvPath,
  isFinalizingCsvPath,
  resolveCsvPath,
};

export {};
