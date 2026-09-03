/**
 * Lifecycle ownership for the three files that make up one flight record.
 *
 * The CSV is authoritative, but its automation and aircraft-specific JSONL
 * companions share the same immutable flight/session identity, recording clock,
 * and basename. Process-local state coordinates the three writers, while a
 * cross-process lease is held from startup through finalization. Together they
 * let the websocket read/delete facade fail closed even after one individual
 * writer has failed or finished before the other two.
 */
'use strict';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const recordingBundleLayout = require('./recording-bundle-layout') as {
  BUNDLE_FILES: {
    csv: string;
    automation: string;
    aircraftSpecific: string;
    status: string;
    summary: string;
  };
  getBundleDir: (_outputDir: string, _bundleName: string) => string;
  getBundlePaths: (_outputDir: string, _bundleName: string) => {
    dir: string;
    csv: string;
    automation: string;
    aircraftSpecific: string;
    status: string;
    summary: string;
  };
};
const bundleLeaseProtocol = require('./recording-bundle-lease') as {
  acquireRecordingBundleLease: (_options: {
    outputDir: string;
    baseName: string;
    purpose: string;
    createDirectory: boolean;
  }) => {
    acquired: boolean;
    reason?: string;
    release?: () => boolean;
  };
  BUNDLE_LEASE_SUFFIX: string;
};

type BundleOwnership = {
  recordingSessionId: string;
  flightId: string;
  recordingStartEpochMs: number;
  recordingStartIso: string;
  outputDir: string;
  baseName: string;
  csvPath: string;
  degradedReason?: string | null;
};

let activeBundle: BundleOwnership | null = null;
let finalizingBundle: BundleOwnership | null = null;
let startingBundle: BundleOwnership | null = null;
let ownedBundleLease: { release: () => boolean } | null = null;

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertBaseName(value: unknown): string {
  const baseName = typeof value === 'string' ? value.trim() : '';
  if (!baseName || path.basename(baseName) !== baseName || baseName === '.' || baseName === '..') {
    throw new Error('Invalid recording bundle basename');
  }
  if (/\.(?:csv|jsonl)$/i.test(baseName)) {
    throw new Error('Recording bundle basename must not include an artifact suffix');
  }
  return baseName;
}

function bundlePaths(outputDir: string, baseName: string): string[] {
  const paths = recordingBundleLayout.getBundlePaths(outputDir, assertBaseName(baseName));
  return [paths.csv, paths.automation, paths.aircraftSpecific];
}

function discardUncommittedBundle(outputDir: string, baseName: string, artifacts: unknown[]): void {
  const allowedPaths = new Set(bundlePaths(outputDir, baseName).map(comparablePath));
  const ownedArtifacts: Array<{
    filePath: string;
    isCsv: boolean;
    creationIdentity: { dev: number; ino: number };
  }> = [];
  for (const rawArtifact of Array.isArray(artifacts) ? artifacts : []) {
    const artifact = rawArtifact && typeof rawArtifact === 'object'
      ? rawArtifact as { filePath?: unknown; creationIdentity?: { dev?: unknown; ino?: unknown } | null }
      : null;
    if (!artifact || typeof artifact.filePath !== 'string' || !artifact.creationIdentity) continue;
    const filePath = path.resolve(artifact.filePath);
    if (!allowedPaths.has(comparablePath(filePath)) || !fs.existsSync(filePath)) continue;
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Refusing to discard a non-regular recording artifact');
    }
    if (stat.dev !== artifact.creationIdentity.dev || stat.ino !== artifact.creationIdentity.ino) {
      continue;
    }
    ownedArtifacts.push({
      filePath,
      isCsv: filePath.toLowerCase().endsWith('.csv'),
      creationIdentity: {
        dev: Number(artifact.creationIdentity.dev),
        ino: Number(artifact.creationIdentity.ino),
      },
    });
  }

  if (ownedArtifacts.length === 0) return;
  const ordered = [
    ...ownedArtifacts.filter((entry) => !entry.isCsv),
    ...ownedArtifacts.filter((entry) => entry.isCsv),
  ];
  const transactionId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const staged: Array<typeof ordered[number] & { stagedPath: string }> = [];

  const assertOwnedIdentity = (filePath: string, expected: { dev: number; ino: number }) => {
    const stat = fs.lstatSync(filePath);
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.dev !== expected.dev
      || stat.ino !== expected.ino
    ) {
      throw new Error('Uncommitted recording artifact identity changed during cleanup');
    }
  };

  try {
    for (let index = 0; index < ordered.length; index += 1) {
      const artifact = ordered[index];
      const stagedPath = `${artifact.filePath}.ff-delete-${transactionId}-${index}`;
      if (fs.existsSync(stagedPath)) throw new Error('Uncommitted cleanup staging collision');
      assertOwnedIdentity(artifact.filePath, artifact.creationIdentity);
      fs.linkSync(artifact.filePath, stagedPath);
      try {
        assertOwnedIdentity(stagedPath, artifact.creationIdentity);
        assertOwnedIdentity(artifact.filePath, artifact.creationIdentity);
        fs.unlinkSync(artifact.filePath);
      } catch (error) {
        try {
          assertOwnedIdentity(stagedPath, artifact.creationIdentity);
          fs.unlinkSync(stagedPath);
        } catch {}
        throw error;
      }
      staged.push({ ...artifact, stagedPath });
    }
  } catch (error) {
    for (const artifact of [...staged].reverse()) {
      try {
        if (!fs.existsSync(artifact.filePath) && fs.existsSync(artifact.stagedPath)) {
          assertOwnedIdentity(artifact.stagedPath, artifact.creationIdentity);
          fs.linkSync(artifact.stagedPath, artifact.filePath);
          assertOwnedIdentity(artifact.filePath, artifact.creationIdentity);
          fs.unlinkSync(artifact.stagedPath);
        }
      } catch {
        // Tombstone retains the bytes for the normal delete-recovery scan.
      }
    }
    throw error;
  }

  // Logical commit is the CSV staged last. Keep that marker until all companion
  // tombstones are gone so the normal flight-log recovery scan can distinguish
  // committed cleanup from interrupted staging after a crash.
  const csvArtifact = staged.find((entry) => entry.isCsv);
  for (const artifact of staged.filter((entry) => entry !== csvArtifact)) {
    try {
      fs.unlinkSync(artifact.stagedPath);
    } catch {
      return;
    }
  }
  if (csvArtifact) {
    try { fs.unlinkSync(csvArtifact.stagedPath); } catch {}
  }
  try {
    const bundleDir = recordingBundleLayout.getBundleDir(outputDir, baseName);
    const stat = fs.lstatSync(bundleDir);
    if (stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(bundleDir).length === 0) {
      fs.rmdirSync(bundleDir);
    }
  } catch {}
}

function isBaseNameAvailable(outputDir: string, baseName: string): boolean {
  const paths = bundlePaths(outputDir, baseName);
  const bundleDir = recordingBundleLayout.getBundleDir(outputDir, baseName);
  const reservationPaths = [
    bundleDir,
    ...paths,
    recordingBundleLayout.getBundlePaths(outputDir, baseName).status,
    path.join(path.resolve(outputDir), `${assertBaseName(baseName)}${bundleLeaseProtocol.BUNDLE_LEASE_SUFFIX}`),
  ];
  if (reservationPaths.some((filePath) => fs.existsSync(filePath))) return false;
  let entries: string[];
  try {
    entries = fs.readdirSync(path.resolve(outputDir));
  } catch {
    return true;
  }
  const tombstonePrefixes = [
    `${path.basename(bundleDir)}.ff-delete-`,
    `${path.basename(bundleDir)}.ff-migrate-`,
  ];
  return !entries.some((entry) => tombstonePrefixes.some((prefix) => entry.startsWith(prefix)));
}

/**
 * Reserve-by-convention a basename that is clear across all three artifacts.
 * Actual writers still open with exclusive-create flags, so another process
 * winning the race fails startup instead of appending/replacing history.
 */
function allocateBundleBaseName(outputDir: string, preferredBaseName: string): string {
  const safePreferred = assertBaseName(preferredBaseName);
  if (isBaseNameAvailable(outputDir, safePreferred)) return safePreferred;

  for (let suffix = 2; suffix <= 9999; suffix += 1) {
    const candidate = `${safePreferred}-${suffix}`;
    if (isBaseNameAvailable(outputDir, candidate)) return candidate;
  }
  throw new Error('Could not allocate a unique flight recording basename');
}

function normalizeOwnership(input: BundleOwnership): BundleOwnership {
  const recordingStartEpochMs = Number(input.recordingStartEpochMs);
  const recordingStartIso = String(input.recordingStartIso || '');
  if (!Number.isFinite(recordingStartEpochMs) || Date.parse(recordingStartIso) !== recordingStartEpochMs) {
    throw new Error('Invalid recording bundle clock');
  }
  const recordingSessionId = String(input.recordingSessionId || '');
  const flightId = String(input.flightId || '');
  if (!recordingSessionId || !flightId) {
    throw new Error('Recording bundle session and flight identities are required');
  }
  const outputDir = path.resolve(input.outputDir);
  const baseName = assertBaseName(input.baseName);
  return Object.freeze({
    recordingSessionId,
    flightId,
    recordingStartEpochMs,
    recordingStartIso,
    outputDir,
    baseName,
    csvPath: recordingBundleLayout.getBundlePaths(outputDir, baseName).csv,
    degradedReason: input.degradedReason || null,
  });
}

function beginRecordingBundle(input: BundleOwnership): BundleOwnership {
  if (startingBundle || activeBundle || finalizingBundle) {
    throw new Error('A recording bundle is already active or finalizing');
  }
  const normalized = normalizeOwnership(input);
  const lease = bundleLeaseProtocol.acquireRecordingBundleLease({
    outputDir: normalized.outputDir,
    baseName: normalized.baseName,
    purpose: 'recording',
    createDirectory: true,
  });
  if (!lease.acquired || typeof lease.release !== 'function') {
    throw new Error('Recording bundle is owned by another process');
  }
  ownedBundleLease = { release: lease.release };
  activeBundle = normalized;
  return activeBundle;
}

/**
 * Own a bundle path while its three exclusive-create writers are starting.
 *
 * Startup can fail after the CSV has closed but before a JSONL companion has
 * finished closing. Keeping this distinct from `activeBundle` lets read/delete
 * guards protect those files through rollback without treating an uncommitted
 * recording as active history.
 */
function beginRecordingBundleStartup(input: BundleOwnership): BundleOwnership {
  if (startingBundle || activeBundle || finalizingBundle) {
    throw new Error('A recording bundle is already starting, active, or finalizing');
  }
  const normalized = normalizeOwnership(input);
  const lease = bundleLeaseProtocol.acquireRecordingBundleLease({
    outputDir: normalized.outputDir,
    baseName: normalized.baseName,
    purpose: 'recording_startup',
    createDirectory: true,
  });
  if (!lease.acquired || typeof lease.release !== 'function') {
    throw new Error('Recording bundle is owned by another process');
  }
  ownedBundleLease = { release: lease.release };
  startingBundle = normalized;
  return startingBundle;
}

function commitRecordingBundleStartup(recordingSessionId: string): BundleOwnership {
  if (!recordingSessionId) throw new Error('Recording bundle startup identity is required');
  if (!startingBundle || startingBundle.recordingSessionId !== recordingSessionId) {
    throw new Error('Recording bundle startup identity mismatch');
  }
  if (activeBundle || finalizingBundle) {
    throw new Error('A recording bundle became active or finalizing during startup');
  }
  const committed = startingBundle;
  activeBundle = committed;
  startingBundle = null;
  return committed;
}

function finishRecordingBundleStartup(recordingSessionId: string): void {
  if (!recordingSessionId) throw new Error('Recording bundle startup completion identity is required');
  if (!startingBundle || startingBundle.recordingSessionId !== recordingSessionId) {
    throw new Error('Recording bundle startup completion identity mismatch');
  }
  startingBundle = null;
  const lease = ownedBundleLease;
  ownedBundleLease = null;
  try { lease?.release(); } catch {}
}

function markRecordingBundleFinalizing(recordingSessionId: string): BundleOwnership | null {
  if (!recordingSessionId) throw new Error('Recording bundle finalization identity is required');
  if (!activeBundle) {
    if (finalizingBundle && finalizingBundle.recordingSessionId !== recordingSessionId) {
      throw new Error('Recording bundle finalization identity mismatch');
    }
    return finalizingBundle;
  }
  if (activeBundle.recordingSessionId !== recordingSessionId) {
    throw new Error('Recording bundle finalization identity mismatch');
  }
  finalizingBundle = activeBundle;
  activeBundle = null;
  return finalizingBundle;
}

function finishRecordingBundle(recordingSessionId: string): void {
  if (!recordingSessionId) throw new Error('Recording bundle completion identity is required');
  if (finalizingBundle && finalizingBundle.recordingSessionId !== recordingSessionId) {
    throw new Error('Recording bundle completion identity mismatch');
  }
  if (finalizingBundle?.recordingSessionId === recordingSessionId) {
    finalizingBundle = null;
    const lease = ownedBundleLease;
    ownedBundleLease = null;
    try { lease?.release(); } catch {}
  }
}

function updateRecordingBundleBaseName(recordingSessionId: string, baseName: string): BundleOwnership {
  const current = activeBundle;
  if (!current || current.recordingSessionId !== recordingSessionId) {
    throw new Error('Recording bundle rename identity mismatch');
  }
  if (assertBaseName(baseName) !== current.baseName) {
    throw new Error('A leased recording bundle basename cannot change');
  }
  return current;
}

function markRecordingBundleDegraded(recordingSessionId: string, reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason || 'recording member failed');
  if (activeBundle?.recordingSessionId === recordingSessionId) {
    activeBundle = normalizeOwnership({ ...activeBundle, degradedReason: message });
    return;
  }
  if (finalizingBundle?.recordingSessionId === recordingSessionId) {
    finalizingBundle = normalizeOwnership({ ...finalizingBundle, degradedReason: message });
  }
}

function getActiveRecordingBundle(): BundleOwnership | null {
  return activeBundle ? { ...activeBundle } : null;
}

function getStartingRecordingBundle(): BundleOwnership | null {
  return startingBundle ? { ...startingBundle } : null;
}

function getFinalizingRecordingBundle(): BundleOwnership | null {
  return finalizingBundle ? { ...finalizingBundle } : null;
}

function getRecordingBundleStartBlocker(): string {
  if (startingBundle) return 'A flight recording bundle is still starting or rolling back';
  if (finalizingBundle) return 'Previous flight recording bundle is still finalizing';
  if (activeBundle) return 'A flight recording bundle is already active';
  return '';
}

function isOwnedRecordingBundleCsvPath(csvPath: unknown): boolean {
  if (typeof csvPath !== 'string' || !csvPath.trim()) return false;
  let requested: string;
  try {
    requested = comparablePath(csvPath);
  } catch {
    return false;
  }
  return [startingBundle, activeBundle, finalizingBundle].some((bundle) => (
    bundle ? comparablePath(bundle.csvPath) === requested : false
  ));
}

function resetRecordingBundleLifecycleForTests(): void {
  const lease = ownedBundleLease;
  ownedBundleLease = null;
  try { lease?.release(); } catch {}
  startingBundle = null;
  activeBundle = null;
  finalizingBundle = null;
}

module.exports = {
  allocateBundleBaseName,
  assertBaseName,
  beginRecordingBundle,
  beginRecordingBundleStartup,
  bundlePaths,
  commitRecordingBundleStartup,
  discardUncommittedBundle,
  finishRecordingBundle,
  finishRecordingBundleStartup,
  getActiveRecordingBundle,
  getFinalizingRecordingBundle,
  getRecordingBundleStartBlocker,
  getStartingRecordingBundle,
  isOwnedRecordingBundleCsvPath,
  markRecordingBundleFinalizing,
  markRecordingBundleDegraded,
  resetRecordingBundleLifecycleForTests,
  updateRecordingBundleBaseName,
};

export {};
