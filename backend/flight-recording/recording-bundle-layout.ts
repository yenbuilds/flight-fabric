'use strict';

/**
 * Canonical on-disk layout for one Flight Fabric recording.
 *
 * Mutable presentation metadata (route, aircraft, callsign, destination) is
 * deliberately absent from physical paths.  The directory name is allocated
 * once from the flight-start clock and recording-session UUID; every consumer
 * resolves artifacts through this module instead of reconstructing paths.
 */

const fs = require('fs') as typeof import('fs');
const crypto = require('crypto') as typeof import('crypto');
const path = require('path') as typeof import('path');

const BUNDLE_LAYOUT_VERSION = 2;
const BUNDLE_FILES = Object.freeze({
  csv: 'telemetry.csv',
  automation: 'automation.jsonl',
  aircraftSpecific: 'aircraft-specific.jsonl',
  status: 'manifest.json',
  summary: 'summary.json',
  timeline: 'timeline.json',
});

type BundleArtifactRole = keyof typeof BUNDLE_FILES;

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertBundleName(value: unknown): string {
  const bundleName = typeof value === 'string' ? value.trim() : '';
  if (
    !bundleName
    || bundleName === '.'
    || bundleName === '..'
    || path.basename(bundleName) !== bundleName
    || /[\\/:*?"<>|\u0000-\u001f]/.test(bundleName)
  ) {
    throw new Error('Invalid recording bundle directory name');
  }
  return bundleName;
}

function getBundleDir(outputDir: string, bundleName: string): string {
  return path.join(path.resolve(outputDir), assertBundleName(bundleName));
}

function getBundlePaths(outputDir: string, bundleName: string): Record<BundleArtifactRole | 'dir', string> {
  const dir = getBundleDir(outputDir, bundleName);
  return {
    dir,
    csv: path.join(dir, BUNDLE_FILES.csv),
    automation: path.join(dir, BUNDLE_FILES.automation),
    aircraftSpecific: path.join(dir, BUNDLE_FILES.aircraftSpecific),
    status: path.join(dir, BUNDLE_FILES.status),
    summary: path.join(dir, BUNDLE_FILES.summary),
    timeline: path.join(dir, BUNDLE_FILES.timeline),
  };
}

function getBundleFromCsvPath(csvPath: unknown): {
  outputDir: string;
  bundleName: string;
  paths: ReturnType<typeof getBundlePaths>;
} | null {
  if (typeof csvPath !== 'string' || !csvPath) return null;
  const resolvedCsv = path.resolve(csvPath);
  if (path.basename(resolvedCsv).toLowerCase() !== BUNDLE_FILES.csv) return null;
  const dir = path.dirname(resolvedCsv);
  const bundleName = path.basename(dir);
  try {
    const outputDir = path.dirname(dir);
    const paths = getBundlePaths(outputDir, bundleName);
    if (comparablePath(paths.csv) !== comparablePath(resolvedCsv)) return null;
    return { outputDir, bundleName, paths };
  } catch {
    return null;
  }
}

function getArtifactPathForCsv(csvPath: unknown, role: BundleArtifactRole): string | null {
  const bundle = getBundleFromCsvPath(csvPath);
  return bundle ? bundle.paths[role] : null;
}

function listBundleCsvPaths(outputDir: string): string[] {
  const root = path.resolve(outputDir);
  if (!fs.existsSync(root)) return [];
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Flight Logs is not a safe directory');
  }
  const csvPaths: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    let paths: ReturnType<typeof getBundlePaths>;
    try {
      paths = getBundlePaths(root, entry.name);
    } catch {
      continue;
    }
    if (!fs.existsSync(paths.csv)) continue;
    const csvStat = fs.lstatSync(paths.csv);
    if (!csvStat.isFile() || csvStat.isSymbolicLink()) {
      throw new Error('Recording bundle telemetry is not a safe regular file');
    }
    csvPaths.push(paths.csv);
  }
  return csvPaths.sort((left, right) => left.localeCompare(right));
}

function buildBundleName(recordingStartClock: unknown, recordingSessionId: unknown): string {
  const rawClock = typeof recordingStartClock === 'string' ? recordingStartClock.trim() : '';
  const parsedClock = Date.parse(rawClock);
  if (!Number.isFinite(parsedClock)) throw new Error('Recording bundle requires a valid flight-start clock');
  const iso = new Date(parsedClock).toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace('T', '_')
    .replace(/:/g, '-');
  const rawSession = String(recordingSessionId || '').trim();
  if (!rawSession) throw new Error('Recording bundle requires a session identity');
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(rawSession)
    ? rawSession.replace(/-/g, '').toLowerCase().slice(0, 8)
    : crypto.createHash('sha256').update(rawSession).digest('hex').slice(0, 8);
  return assertBundleName(`${iso}--${uuid}`);
}

module.exports = {
  BUNDLE_FILES,
  BUNDLE_LAYOUT_VERSION,
  assertBundleName,
  buildBundleName,
  getArtifactPathForCsv,
  getBundleDir,
  getBundleFromCsvPath,
  getBundlePaths,
  listBundleCsvPaths,
};

export {};
