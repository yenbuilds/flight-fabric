'use strict';

const crypto = require('crypto') as typeof import('crypto');
const path = require('path') as typeof import('path');
const { getBundleFromCsvPath } = require('../flight-recording/recording-bundle-layout') as {
  getBundleFromCsvPath: (_csvPath: unknown) => { bundleName: string } | null;
};

type SourceIdentityInput = {
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
  recordingSessionId?: string;
};

type HistorySourceIdentity = {
  sourceId: string;
  csvPath: string;
  csvBasename: string;
  normalizedPath: string;
  mtimeMs: number;
  sizeBytes: number;
};

type IndexedSourceIdentity = {
  csvPath?: unknown;
  mtimeMs?: unknown;
  sizeBytes?: unknown;
};

function normalizeHistorySourcePath(filePath: unknown): string {
  const resolved = path.resolve(String(filePath || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function createHistorySourceId(filePath: unknown, recordingSessionId?: unknown): string {
  const sessionId = typeof recordingSessionId === 'string' ? recordingSessionId.trim().toLowerCase() : '';
  const bundleName = getBundleFromCsvPath(filePath)?.bundleName || '';
  const identityKind = sessionId ? 'recording-session-v1' : (bundleName ? 'recording-bundle-v1' : 'history-source-v1');
  const identityValue = sessionId || bundleName || normalizeHistorySourcePath(filePath);
  const digest = crypto
    .createHash('sha256')
    .update(`${identityKind}:${identityValue}`)
    .digest('hex')
    .slice(0, 32);
  return `${sessionId ? 'rec' : 'src'}_${digest}`;
}

function finiteNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function createHistorySourceIdentity(input: SourceIdentityInput): HistorySourceIdentity {
  const csvPath = path.resolve(input.filePath);
  return {
    sourceId: createHistorySourceId(csvPath, input.recordingSessionId),
    csvPath,
    csvBasename: path.basename(csvPath),
    normalizedPath: normalizeHistorySourcePath(csvPath),
    mtimeMs: finiteNumber(input.mtimeMs),
    sizeBytes: Math.max(0, Math.floor(finiteNumber(input.sizeBytes))),
  };
}

function sourceIdentityMatches(
  current: HistorySourceIdentity | SourceIdentityInput,
  indexed: IndexedSourceIdentity | null | undefined,
): boolean {
  if (!indexed) return false;
  const currentIdentity = 'sourceId' in current
    ? current
    : createHistorySourceIdentity(current);
  return normalizeHistorySourcePath(indexed.csvPath) === currentIdentity.normalizedPath
    && finiteNumber(indexed.mtimeMs, NaN) === currentIdentity.mtimeMs
    && Math.max(0, Math.floor(finiteNumber(indexed.sizeBytes, NaN))) === currentIdentity.sizeBytes;
}

module.exports = {
  createHistorySourceId,
  createHistorySourceIdentity,
  normalizeHistorySourcePath,
  sourceIdentityMatches,
};

export {};
