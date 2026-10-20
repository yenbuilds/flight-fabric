// Own the complete guarded deletion transaction, including crash recovery.
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const { parseCsvLine, splitCsvLines } = require('../utils/csv');
const { resolveFlightLogsDir } = require('../utils/flight-logs-dir');
const { isPathInside } = require('../utils/path-guard');
const { assertSafeFileTarget, safeReplaceTextFileSync, safeUnlinkSync } = require('../utils/safe-fs');
const { readRecordingBundleStatusSync } = require('./recording-bundle-status');
const { isOwnedHistorySummaryForCsv } = require('../history-index/history-summary-sidecar');
const recordingBundleLayout = require('./recording-bundle-layout') as {
  BUNDLE_FILES: {
    csv: string;
    automation: string;
    aircraftSpecific: string;
    status: string;
    summary: string;
  };
  getBundleFromCsvPath: (_csvPath: unknown) => {
    outputDir: string;
    bundleName: string;
    paths: Record<string, string>;
  } | null;
  listBundleCsvPaths: (_outputDir: string) => string[];
};

type AnyRecord = Record<string, any>;

function getFlightLogsDir(): string {
  return resolveFlightLogsDir();
}

type DeleteFlightCsvExpectedIdentity = {
  mtimeMs?: unknown;
  sizeBytes?: unknown;
};
const DELETE_MTIME_TOLERANCE_MS = 2000;

const DELETE_INTENT_FILE = '.ff-delete-intent.json';
const DELETE_INTENT_KIND = 'flight_fabric_bundle_delete_intent';
const DELETE_INTENT_SCHEMA_VERSION = 1;

function readDeleteIntent(bundleDir: string): AnyRecord | null {
  const intentPath = path.join(bundleDir, DELETE_INTENT_FILE);
  try {
    const stat = fs.lstatSync(intentPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 16 * 1024) return null;
    const parsed = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
    if (
      parsed?.schemaVersion !== DELETE_INTENT_SCHEMA_VERSION
      || parsed?.kind !== DELETE_INTENT_KIND
      || typeof parsed?.bundleName !== 'string'
      || typeof parsed?.token !== 'string'
      || !/^\d+-\d+-[a-f0-9]+$/.test(parsed.token)
      || typeof parsed?.recordingSessionId !== 'string'
      || !parsed.recordingSessionId
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function cleanupCommittedBundleDelete(rootDir: string, stagedDir: string, bundleName: string, token: string): boolean {
  const intent = readDeleteIntent(stagedDir);
  if (!intent || intent.bundleName !== bundleName || intent.token !== token) return false;
  const allowedNames = new Set([...Object.values(recordingBundleLayout.BUNDLE_FILES), DELETE_INTENT_FILE]);
  let entries: import('fs').Dirent[];
  try {
    const stat = fs.lstatSync(stagedDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(stagedDir) !== path.resolve(rootDir)) return false;
    entries = fs.readdirSync(stagedDir, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !allowedNames.has(entry.name))) return false;
  } catch {
    return false;
  }
  const csvPath = path.join(stagedDir, recordingBundleLayout.BUNDLE_FILES.csv);
  const csvIdentity = readCsvRecordingIdentity(csvPath);
  if (!csvIdentity || csvIdentity.recordingSessionId !== intent.recordingSessionId) return false;
  const cleanupOrder = [
    ...entries.filter((entry) => entry.name !== recordingBundleLayout.BUNDLE_FILES.csv && entry.name !== DELETE_INTENT_FILE),
    ...entries.filter((entry) => entry.name === recordingBundleLayout.BUNDLE_FILES.csv),
    ...entries.filter((entry) => entry.name === DELETE_INTENT_FILE),
  ];
  for (const entry of cleanupOrder) {
    try {
      safeUnlinkSync({
        operation: 'cleanup committed recording bundle delete',
        rootDir: stagedDir,
        targetPath: path.join(stagedDir, entry.name),
      });
    } catch {
      return false;
    }
  }
  try {
    fs.rmdirSync(stagedDir);
    return true;
  } catch {
    return false;
  }
}

function recoverInterruptedBundleDeletes(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const match = /^(.*)\.ff-delete-(\d+-\d+-[a-f0-9]+)$/.exec(entry.name);
    if (match) {
      cleanupCommittedBundleDelete(path.resolve(dir), path.join(dir, entry.name), match[1], match[2]);
      continue;
    }
    // A crash before the atomic directory rename can leave only our intent
    // marker in the still-visible bundle. Remove that marker after matching it
    // to the directory and the recording-session identity; no flight data moves.
    const bundleDir = path.join(dir, entry.name);
    const intent = readDeleteIntent(bundleDir);
    if (!intent || intent.bundleName !== entry.name) continue;
    const csvIdentity = readCsvRecordingIdentity(path.join(bundleDir, recordingBundleLayout.BUNDLE_FILES.csv));
    if (!csvIdentity || csvIdentity.recordingSessionId !== intent.recordingSessionId) continue;
    try {
      safeUnlinkSync({
        allowedExtensions: ['.json'],
        operation: 'recover uncommitted recording bundle delete intent',
        rootDir: bundleDir,
        targetPath: path.join(bundleDir, DELETE_INTENT_FILE),
      });
    } catch {}
  }
}

/**
 * Delete a flight-log CSV. The path is validated to be inside the flight-logs
 * directory so a malicious / mistaken WS message cannot delete arbitrary files.
 *
 * @param {string} filePath  absolute path to a CSV
 * @returns {{ success: boolean, error?: string, deleted?: string }}
 */
function hasExpectedFileIdentity(stat: import('fs').Stats, expected: DeleteFlightCsvExpectedIdentity | null | undefined): boolean {
  if (!expected || typeof expected !== 'object') return false;

  const expectedSizeBytes = Number(expected.sizeBytes);
  const expectedMtimeMs = Number(expected.mtimeMs);
  if (!Number.isFinite(expectedSizeBytes) || !Number.isFinite(expectedMtimeMs)) return false;
  if (stat.size !== expectedSizeBytes) return false;

  return Math.abs(stat.mtimeMs - expectedMtimeMs) <= DELETE_MTIME_TOLERANCE_MS;
}

type StableFileIdentity = { dev: number; ino: number };

function captureStableFileIdentity(filePath: string): StableFileIdentity {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Recording bundle member is not a regular file');
  }
  return { dev: stat.dev, ino: stat.ino };
}

function assertStableFileIdentity(filePath: string, expected: StableFileIdentity): void {
  const actual = captureStableFileIdentity(filePath);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error('Recording bundle member changed during delete');
  }
}

function readCsvRecordingIdentity(filePath: string): AnyRecord | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const lines = splitCsvLines(buffer.toString('utf8', 0, bytesRead), { trimAndDropEmpty: true });
    if (lines.length < 2) return null;
    const headers = parseCsvLine(lines[0], { trimValues: true });
    const values = parseCsvLine(lines[1], { trimValues: true });
    const value = (name: string) => {
      const index = headers.indexOf(name);
      return index >= 0 ? String(values[index] || '') : '';
    };
    return {
      flightId: value('flight_id'),
      recordingSessionId: value('recording_session_id'),
      flightStartIso: value('flight_start_iso'),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function readJsonlRecordingIdentity(filePath: string): AnyRecord | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const line = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/).find((entry) => entry.trim());
    if (!line) return null;
    const row = JSON.parse(line);
    return {
      flightId: String(row.flightId || ''),
      recordingSessionId: String(row.recordingSessionId || ''),
      flightStartIso: String(row.flightStartIso || ''),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function identitiesBelongTogether(csvIdentity: AnyRecord | null, sidecarIdentity: AnyRecord | null): boolean {
  if (!csvIdentity || !sidecarIdentity) return false;
  if (!csvIdentity.flightId || !sidecarIdentity.flightId) return false;
  if (!csvIdentity.flightStartIso || !sidecarIdentity.flightStartIso) return false;
  if (csvIdentity.flightId !== sidecarIdentity.flightId) return false;
  if (csvIdentity.flightStartIso !== sidecarIdentity.flightStartIso) return false;
  if (
    csvIdentity.recordingSessionId
    && sidecarIdentity.recordingSessionId !== csvIdentity.recordingSessionId
  ) return false;
  return true;
}

function deleteFlightCsv(
  filePath: string,
  expectedIdentity?: DeleteFlightCsvExpectedIdentity | null,
): { success: boolean; error?: string; deleted?: string } {
  if (typeof filePath !== 'string' || !filePath) {
    return { success: false, error: 'filePath is required' };
  }
  const dir = path.resolve(getFlightLogsDir());
  recoverInterruptedBundleDeletes(dir);
  const resolved = path.resolve(filePath);
  const bundle = recordingBundleLayout.getBundleFromCsvPath(resolved);
  const samePath = (left: string, right: string) => (
    process.platform === 'win32'
      ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
      : path.resolve(left) === path.resolve(right)
  );
  if (
    !bundle
    || !samePath(bundle.outputDir, dir)
    || !samePath(bundle.paths.csv, resolved)
    || !isPathInside(dir, resolved)
  ) return { success: false, error: 'File is not a canonical FlightFabric recording' };
  let stat: import('fs').Stats;
  try {
    stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('CSV is not a regular file');
  } catch {
    return { success: false, error: 'File not found' };
  }
  if (!hasExpectedFileIdentity(stat, expectedIdentity)) {
    return { success: false, error: 'Flight log changed on disk. Refresh the list and try again.' };
  }
  try {
    const bundleDir = path.dirname(resolved);
    const bundleDirStat = fs.lstatSync(bundleDir);
    if (
      !bundleDirStat.isDirectory()
      || bundleDirStat.isSymbolicLink()
      || !samePath(path.dirname(bundleDir), dir)
    ) throw new Error('Recording bundle directory is unsafe');

    const allowedNames = new Set(Object.values(recordingBundleLayout.BUNDLE_FILES));
    const directoryEntries = fs.readdirSync(bundleDir, { withFileTypes: true });
    if (directoryEntries.some((entry) => (
      !entry.isFile()
      || entry.isSymbolicLink()
      || !allowedNames.has(entry.name)
    ))) {
      return { success: false, error: 'Recording folder contains unrecognized files; delete was refused' };
    }

    const sidecars = [
      {
        operation: 'deleteFlightCsvAutomationSidecar',
        filePath: bundle.paths.automation,
        allowedExtensions: ['.jsonl'],
        kind: 'jsonl',
      },
      {
        operation: 'deleteFlightCsvAircraftSpecificSidecar',
        filePath: bundle.paths.aircraftSpecific,
        allowedExtensions: ['.jsonl'],
        kind: 'jsonl',
      },
      {
        operation: 'deleteFlightCsvBundleStatus',
        filePath: bundle.paths.status,
        allowedExtensions: ['.json'],
        kind: 'bundle-status',
      },
      {
        operation: 'deleteFlightCsvHistorySummary',
        filePath: bundle.paths.summary,
        allowedExtensions: ['.json'],
        kind: 'history-summary',
      },
      {
        operation: 'deleteFlightCsvTimeline',
        filePath: bundle.paths.timeline,
        allowedExtensions: ['.json'],
        kind: 'derived',
      },
    ];
    if (fs.existsSync(bundle.paths.summary) && !isOwnedHistorySummaryForCsv(bundle.paths.summary, resolved)) {
      return { success: false, error: 'Recording summary ownership could not be verified' };
    }
    const existingSidecars = sidecars
      .filter((sidecar) => (
        sidecar.filePath !== resolved
        && isPathInside(bundleDir, sidecar.filePath)
        && fs.existsSync(sidecar.filePath)
        && (sidecar.kind !== 'history-summary' || isOwnedHistorySummaryForCsv(sidecar.filePath, resolved))
      ));

    // Preflight every bundle member before deleting any one of them. This keeps
    // a malformed/refused second sidecar from causing the first sidecar to be
    // irreversibly removed while the authoritative CSV remains retryable.
    for (const sidecar of existingSidecars) {
      assertSafeFileTarget({
        allowedExtensions: sidecar.allowedExtensions,
        operation: `${sidecar.operation}:preflight`,
        rootDir: bundleDir,
        targetPath: sidecar.filePath,
      });
    }
    assertSafeFileTarget({
      allowedExtensions: ['.csv'],
      operation: 'deleteFlightCsv:preflight',
      rootDir: bundleDir,
      targetPath: resolved,
    });

    const members = [
      ...existingSidecars.map((sidecar) => ({
        operation: sidecar.operation,
        filePath: sidecar.filePath,
      })),
      { operation: 'deleteFlightCsv', filePath: resolved },
    ].map((member) => ({
      ...member,
      stableIdentity: captureStableFileIdentity(member.filePath),
    }));

    const csvIdentity = readCsvRecordingIdentity(resolved);
    if (!csvIdentity?.recordingSessionId) {
      return { success: false, error: 'Recording identity is missing; delete was refused' };
    }
    for (const sidecar of existingSidecars) {
      // The history summary is a derived, schema-marked FlightFabric cache.
      // Its ownership was validated above; it need not duplicate legacy CSV
      // manifest fields in order to be removed with its source bundle.
      if (sidecar.kind === 'history-summary' || sidecar.kind === 'derived') continue;
      const sidecarStat = fs.statSync(sidecar.filePath);
      const sidecarIdentity = sidecar.kind === 'bundle-status'
        ? (() => {
            const status = readRecordingBundleStatusSync(resolved);
            return status.certificate ? {
              flightId: String(status.certificate.flightId || ''),
              recordingSessionId: String(status.certificate.recordingSessionId || ''),
              flightStartIso: String(status.certificate.recordingStartIso || ''),
            } : null;
          })()
        : readJsonlRecordingIdentity(sidecar.filePath);
      // A pre-manifest quick start/stop could leave an empty claimed sidecar.
      // It contains no unrelated history to protect and is still inode-guarded
      // by the delete transaction below.
      if (sidecarStat.size > 0 && !identitiesBelongTogether(csvIdentity, sidecarIdentity)) {
        return { success: false, error: 'Recording companion identity does not match the CSV' };
      }
    }
    // Identity reads use paths, so re-check each inode before the transaction
    // begins. A concurrent replacement cannot inherit the earlier validation.
    for (const member of members) {
      assertStableFileIdentity(member.filePath, member.stableIdentity);
    }

    const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const intentPath = path.join(bundleDir, DELETE_INTENT_FILE);
    safeReplaceTextFileSync({
      allowedExtensions: ['.json'],
      data: `${JSON.stringify({
        schemaVersion: DELETE_INTENT_SCHEMA_VERSION,
        kind: DELETE_INTENT_KIND,
        bundleName: bundle.bundleName,
        token,
        recordingSessionId: csvIdentity.recordingSessionId,
      })}\n`,
      operation: 'write recording bundle delete intent',
      rootDir: bundleDir,
      targetPath: intentPath,
    });
    for (const member of members) assertStableFileIdentity(member.filePath, member.stableIdentity);
    const currentBundleDirStat = fs.lstatSync(bundleDir);
    if (
      currentBundleDirStat.dev !== bundleDirStat.dev
      || currentBundleDirStat.ino !== bundleDirStat.ino
      || currentBundleDirStat.isSymbolicLink()
    ) throw new Error('Recording bundle directory changed during delete');

    const stagedDir = path.join(dir, `${bundle.bundleName}.ff-delete-${token}`);
    if (fs.existsSync(stagedDir)) throw new Error('Delete staging collision');
    fs.renameSync(bundleDir, stagedDir);
    cleanupCommittedBundleDelete(dir, stagedDir, bundle.bundleName, token);
    return { success: true, deleted: resolved };
  } catch (err) {
    // Use error code only — err.message often contains full file paths
    return { success: false, error: err.code ? `Delete failed: ${err.code}` : 'Delete failed' };
  }
}

module.exports = { deleteFlightCsv, recoverInterruptedBundleDeletes };

export {};
