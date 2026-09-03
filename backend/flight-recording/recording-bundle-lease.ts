/**
 * Cross-process leases for flight-recording bundles.
 *
 * The normal Electron and standalone launchers already share one runtime-owner
 * lock. These file leases protect the narrower filesystem boundary as well:
 * an independently launched process cannot read, list, or delete a bundle
 * while another process is starting, writing, or finalizing it.
 *
 * Lease existence is the mutex. The owning process keeps the descriptor open
 * and refreshes its mtime. Crash recovery is deliberately conservative: a
 * lease is reclaimed only when it is a valid Flight Fabric lease, its owner is
 * definitely dead, and a grace period has elapsed. Malformed, symlinked, or
 * otherwise unprovable files are blockers and are never removed.
 */
'use strict';

const crypto = require('crypto') as typeof import('crypto');
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const recordingBundleLayout = require('./recording-bundle-layout') as {
  getBundleFromCsvPath: (_csvPath: unknown) => { bundleName: string } | null;
  listBundleCsvPaths: (_outputDir: string) => string[];
};

const BUNDLE_LEASE_SUFFIX = '.ff-bundle.lease';
const CATALOG_LEASE_FILE = '.ff-bundle-catalog.lease';
const LEASE_KIND = 'flight_fabric_recording_bundle_lease';
const LEASE_SCHEMA_VERSION = 1;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_STALE_RECOVERY_GRACE_MS = 10_000;
const RELEASE_RETRY_INTERVAL_MS = 250;
const MAX_LEASE_BYTES = 16 * 1024;
const PROCESS_START_EPOCH_MS = Math.round(Date.now() - (process.uptime() * 1_000));
const GLOBAL_REGISTRY_KEY = Symbol.for('flight-fabric.recording-bundle-leases.v1');

type LeaseScope = 'bundle' | 'catalog';
type ProcessLiveness = 'alive' | 'dead' | 'unknown';
type LeaseIdentity = { dev: number; ino: number };
type LeaseRecord = {
  schemaVersion: number;
  kind: string;
  scope: LeaseScope;
  baseName: string | null;
  purpose: string;
  token: string;
  pid: number;
  processStartEpochMs: number;
  createdAtEpochMs: number;
};
type LeaseRuntime = {
  filePath: string;
  comparableFilePath: string;
  fd: number | null;
  identity: LeaseIdentity;
  record: LeaseRecord;
  refs: number;
  releaseRequested: boolean;
  heartbeatTimer: NodeJS.Timeout | null;
  releaseRetryTimer: NodeJS.Timeout | null;
};
type LeaseHandle = {
  acquired: true;
  filePath: string;
  scope: LeaseScope;
  baseName: string | null;
  purpose: string;
  token: string;
  release: () => boolean;
};
type LeaseFailure = {
  acquired: false;
  reason: 'busy' | 'unsafe' | 'io_error';
  error?: string;
};
type LeaseResult = LeaseHandle | LeaseFailure;
type LeaseOptions = {
  outputDir: string;
  baseName?: string | null;
  purpose?: string;
  createDirectory?: boolean;
  heartbeatIntervalMs?: number;
  staleRecoveryGraceMs?: number;
  now?: () => number;
  isProcessAlive?: (_pid: number) => ProcessLiveness;
  beforeEnumerate?: (_outputDir: string) => void;
};
type ExistingLease = {
  identity: LeaseIdentity;
  record: LeaseRecord;
  stat: import('fs').Stats;
};
type LeaseGroup = {
  acquired: true;
  leases: LeaseHandle[];
  csvPaths?: string[];
  release: () => void;
};
type LeaseGroupResult = LeaseGroup | LeaseFailure;

const globalObject = globalThis as typeof globalThis & {
  [GLOBAL_REGISTRY_KEY]?: Map<string, LeaseRuntime>;
};
const runtimeLeases = globalObject[GLOBAL_REGISTRY_KEY]
  || (globalObject[GLOBAL_REGISTRY_KEY] = new Map<string, LeaseRuntime>());

function asLeaseFailure(result: LeaseResult): LeaseFailure {
  return result as LeaseFailure;
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertBaseName(value: unknown): string {
  const baseName = typeof value === 'string' ? value.trim() : '';
  if (!baseName || baseName === '.' || baseName === '..' || path.basename(baseName) !== baseName) {
    throw new Error('Invalid recording bundle basename');
  }
  if (/\.(?:csv|jsonl|json|lease)$/i.test(baseName)) {
    throw new Error('Recording bundle basename must not include an artifact or lease suffix');
  }
  return baseName;
}

function getBundleLeasePath(outputDir: string, baseName: string): string {
  return path.join(path.resolve(outputDir), `${assertBaseName(baseName)}${BUNDLE_LEASE_SUFFIX}`);
}

function getCatalogLeasePath(outputDir: string): string {
  return path.join(path.resolve(outputDir), CATALOG_LEASE_FILE);
}

function finiteNonNegative(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function captureRegularIdentity(filePath: string): { stat: import('fs').Stats; identity: LeaseIdentity } {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Recording bundle lease is not a regular file');
  }
  return { stat, identity: { dev: stat.dev, ino: stat.ino } };
}

function identitiesMatch(left: LeaseIdentity, right: LeaseIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function writeAllSync(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, null);
    if (written <= 0) throw new Error('Could not write recording bundle lease');
    offset += written;
  }
}

function isValidLeaseRecord(
  value: unknown,
  expectedScope: LeaseScope,
  expectedBaseName: string | null,
): value is LeaseRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<LeaseRecord>;
  if (record.schemaVersion !== LEASE_SCHEMA_VERSION || record.kind !== LEASE_KIND) return false;
  if (record.scope !== expectedScope || record.baseName !== expectedBaseName) return false;
  if (typeof record.purpose !== 'string' || !record.purpose || record.purpose.length > 128) return false;
  if (
    typeof record.token !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.token)
  ) return false;
  if (!Number.isInteger(record.pid) || Number(record.pid) <= 0) return false;
  if (!Number.isFinite(record.processStartEpochMs) || Number(record.processStartEpochMs) <= 0) return false;
  if (!Number.isFinite(record.createdAtEpochMs) || Number(record.createdAtEpochMs) <= 0) return false;
  return true;
}

function readExistingLease(
  filePath: string,
  expectedScope: LeaseScope,
  expectedBaseName: string | null,
): ExistingLease | null {
  let fd: number | null = null;
  try {
    const before = captureRegularIdentity(filePath);
    if (before.stat.size <= 0 || before.stat.size > MAX_LEASE_BYTES) return null;
    fd = fs.openSync(filePath, 'r');
    const opened = fs.fstatSync(fd);
    const openedIdentity = { dev: opened.dev, ino: opened.ino };
    if (!opened.isFile() || !identitiesMatch(before.identity, openedIdentity)) return null;
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead <= 0) return null;
      offset += bytesRead;
    }
    const after = captureRegularIdentity(filePath);
    if (!identitiesMatch(before.identity, after.identity) || after.stat.size !== opened.size) return null;
    const text = buffer.toString('utf8');
    if (!text.endsWith('\n') || text.includes('\uFFFD')) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isValidLeaseRecord(parsed, expectedScope, expectedBaseName)) return null;
    return { identity: before.identity, record: parsed, stat: after.stat };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function defaultProcessLiveness(pid: number): ProcessLiveness {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

function ownerIsDefinitelyDead(
  record: LeaseRecord,
  isProcessAlive: (_pid: number) => ProcessLiveness,
): boolean {
  if (record.pid === process.pid) {
    return Math.abs(record.processStartEpochMs - PROCESS_START_EPOCH_MS) > 2_000;
  }
  return isProcessAlive(record.pid) === 'dead';
}

function cleanupIdentityCheckedPath(filePath: string, identity: LeaseIdentity): boolean {
  try {
    const current = captureRegularIdentity(filePath);
    if (!identitiesMatch(current.identity, identity)) return false;
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function inspectPathExistence(filePath: string): 'missing' | 'present' | 'unknown' {
  try {
    fs.lstatSync(filePath);
    return 'present';
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unknown';
  }
}

function tryReclaimStaleLease(
  filePath: string,
  scope: LeaseScope,
  baseName: string | null,
  options: LeaseOptions,
): boolean {
  const existing = readExistingLease(filePath, scope, baseName);
  if (!existing) return false;
  const now = (options.now || Date.now)();
  const graceMs = finiteNonNegative(
    options.staleRecoveryGraceMs,
    DEFAULT_STALE_RECOVERY_GRACE_MS,
  );
  const lastHeartbeatMs = Math.max(existing.record.createdAtEpochMs, existing.stat.mtimeMs);
  if (!Number.isFinite(now) || now - lastHeartbeatMs < graceMs) return false;
  const isProcessAlive = options.isProcessAlive || defaultProcessLiveness;
  if (!ownerIsDefinitelyDead(existing.record, isProcessAlive)) return false;

  // Hard-link staging makes stale recovery no-replace. A second contender may
  // observe the old inode or a newly created lease, but cannot unlink the new
  // inode using this stale identity.
  const reclaimPath = `${filePath}.ff-reclaim-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.linkSync(filePath, reclaimPath);
    const staged = captureRegularIdentity(reclaimPath);
    const current = captureRegularIdentity(filePath);
    if (
      !identitiesMatch(staged.identity, existing.identity)
      || !identitiesMatch(current.identity, existing.identity)
    ) return false;
    const stagedLease = readExistingLease(reclaimPath, scope, baseName);
    if (!stagedLease || stagedLease.record.token !== existing.record.token) return false;
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  } finally {
    cleanupIdentityCheckedPath(reclaimPath, existing.identity);
  }
}

function finishReleasedRuntime(runtime: LeaseRuntime): void {
  runtimeLeases.delete(runtime.comparableFilePath);
  if (runtime.heartbeatTimer) {
    clearInterval(runtime.heartbeatTimer);
    runtime.heartbeatTimer = null;
  }
  if (runtime.releaseRetryTimer) {
    clearTimeout(runtime.releaseRetryTimer);
    runtime.releaseRetryTimer = null;
  }
}

function scheduleReleaseRetry(runtime: LeaseRuntime): void {
  if (runtime.releaseRetryTimer || runtimeLeases.get(runtime.comparableFilePath) !== runtime) return;
  runtime.releaseRetryTimer = setTimeout(() => {
    runtime.releaseRetryTimer = null;
    releaseRuntime(runtime);
  }, RELEASE_RETRY_INTERVAL_MS);
  runtime.releaseRetryTimer.unref?.();
}

function releaseRuntime(runtime: LeaseRuntime): boolean {
  if (runtime.refs > 0 || !runtime.releaseRequested) return false;
  if (runtime.heartbeatTimer) {
    clearInterval(runtime.heartbeatTimer);
    runtime.heartbeatTimer = null;
  }

  let pathStillOwned = false;
  const beforeClose = readExistingLease(
    runtime.filePath,
    runtime.record.scope,
    runtime.record.baseName,
  );
  if (
    beforeClose
    && identitiesMatch(beforeClose.identity, runtime.identity)
    && beforeClose.record.token === runtime.record.token
  ) pathStillOwned = true;

  if (runtime.fd !== null) {
    try { fs.closeSync(runtime.fd); } catch {}
    runtime.fd = null;
  }
  if (!pathStillOwned) {
    const existence = inspectPathExistence(runtime.filePath);
    // A missing marker needs no cleanup. A readable valid marker with another
    // token is provably no longer ours. A transient read/lstat failure remains
    // owned in the registry and is retried without deleting anything.
    if (existence === 'missing') {
      finishReleasedRuntime(runtime);
      return true;
    }
    if (beforeClose && beforeClose.record.token !== runtime.record.token) {
      finishReleasedRuntime(runtime);
      return false;
    }
    scheduleReleaseRetry(runtime);
    return false;
  }

  const afterClose = readExistingLease(
    runtime.filePath,
    runtime.record.scope,
    runtime.record.baseName,
  );
  if (
    !afterClose
    || !identitiesMatch(afterClose.identity, runtime.identity)
    || afterClose.record.token !== runtime.record.token
  ) {
    const existence = inspectPathExistence(runtime.filePath);
    if (existence === 'missing') {
      finishReleasedRuntime(runtime);
      return true;
    }
    if (afterClose && afterClose.record.token !== runtime.record.token) {
      finishReleasedRuntime(runtime);
      return false;
    }
    scheduleReleaseRetry(runtime);
    return false;
  }
  if (cleanupIdentityCheckedPath(runtime.filePath, runtime.identity)) {
    finishReleasedRuntime(runtime);
    return true;
  }

  // Windows antivirus/indexing handles can transiently reject unlink after the
  // owner descriptor closes. Keep registry ownership and retry automatically;
  // dropping the runtime here would leave a valid same-PID marker that no
  // process could conservatively reclaim until this process exited.
  scheduleReleaseRetry(runtime);
  return false;
}

function createHandle(runtime: LeaseRuntime): LeaseHandle {
  let released = false;
  return {
    acquired: true,
    filePath: runtime.filePath,
    scope: runtime.record.scope,
    baseName: runtime.record.baseName,
    purpose: runtime.record.purpose,
    token: runtime.record.token,
    release(): boolean {
      if (released) return true;
      released = true;
      runtime.refs = Math.max(0, runtime.refs - 1);
      if (runtime.refs > 0) return true;
      runtime.releaseRequested = true;
      return releaseRuntime(runtime);
    },
  };
}

function createRawLease(
  filePath: string,
  scope: LeaseScope,
  baseName: string | null,
  options: LeaseOptions,
  allowedReentrantPurposes: string[] = [],
): LeaseResult {
  const key = comparablePath(filePath);
  const existingRuntime = runtimeLeases.get(key);
  if (existingRuntime) {
    if (existingRuntime.releaseRequested) {
      return { acquired: false, reason: 'busy' };
    }
    if (!allowedReentrantPurposes.includes(existingRuntime.record.purpose)) {
      return { acquired: false, reason: 'busy' };
    }
    existingRuntime.refs += 1;
    return createHandle(existingRuntime);
  }

  if (options.createDirectory === true) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch (error) {
      return {
        acquired: false,
        reason: 'io_error',
        error: (error as NodeJS.ErrnoException)?.code || 'MKDIR_FAILED',
      };
    }
  }

  const now = options.now || Date.now;
  const purpose = String(options.purpose || 'unknown').slice(0, 128) || 'unknown';
  const record: LeaseRecord = {
    schemaVersion: LEASE_SCHEMA_VERSION,
    kind: LEASE_KIND,
    scope,
    baseName,
    purpose,
    token: crypto.randomUUID(),
    pid: process.pid,
    processStartEpochMs: PROCESS_START_EPOCH_MS,
    createdAtEpochMs: now(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | null = null;
    let identity: LeaseIdentity | null = null;
    try {
      fd = fs.openSync(filePath, 'wx', 0o600);
      const opened = fs.fstatSync(fd);
      if (!opened.isFile()) throw new Error('Recording bundle lease is not a regular file');
      identity = { dev: opened.dev, ino: opened.ino };
      const payload = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
      writeAllSync(fd, payload);
      fs.fdatasyncSync(fd);
      const visible = captureRegularIdentity(filePath);
      if (!identitiesMatch(visible.identity, identity)) {
        throw new Error('Recording bundle lease identity changed during creation');
      }
      const heartbeatIntervalMs = finiteNonNegative(
        options.heartbeatIntervalMs,
        DEFAULT_HEARTBEAT_INTERVAL_MS,
      );
      const runtime: LeaseRuntime = {
        filePath,
        comparableFilePath: key,
        fd,
        identity,
        record,
        refs: 1,
        releaseRequested: false,
        heartbeatTimer: null,
        releaseRetryTimer: null,
      };
      if (heartbeatIntervalMs > 0) {
        runtime.heartbeatTimer = setInterval(() => {
          try {
            const heartbeat = new Date();
            if (runtime.fd !== null) fs.futimesSync(runtime.fd, heartbeat, heartbeat);
          } catch {
            // Lease existence still fails closed. Never remove or replace a
            // marker merely because a heartbeat could not be refreshed.
          }
        }, heartbeatIntervalMs);
        runtime.heartbeatTimer.unref?.();
      }
      runtimeLeases.set(key, runtime);
      return createHandle(runtime);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      if (identity) cleanupIdentityCheckedPath(filePath, identity);
      if (code !== 'EEXIST') {
        return { acquired: false, reason: 'io_error', error: code || 'LEASE_CREATE_FAILED' };
      }
      if (attempt === 0 && tryReclaimStaleLease(filePath, scope, baseName, options)) {
        continue;
      }
      const safeExisting = readExistingLease(filePath, scope, baseName);
      return { acquired: false, reason: safeExisting ? 'busy' : 'unsafe' };
    }
  }
  return { acquired: false, reason: 'busy' };
}

function acquireCatalogLease(options: LeaseOptions): LeaseResult {
  return createRawLease(getCatalogLeasePath(options.outputDir), 'catalog', null, options);
}

/**
 * Acquire an exclusive gate for a whole-directory maintenance operation.
 *
 * The catalog lease prevents new recordings, reads, and mutations from
 * starting while the direct-child lease scan runs. Any existing bundle lease
 * means a writer or reader may still own files, so maintenance fails closed.
 * Stale markers are deliberately not reclaimed here: one-off maintenance is
 * only safe after Flight Fabric has been fully stopped.
 */
function acquireExclusiveFlightLogsMutationLease(options: LeaseOptions): LeaseResult {
  const outputDir = path.resolve(options.outputDir);
  const catalog = acquireCatalogLease({
    ...options,
    outputDir,
    purpose: options.purpose || 'exclusive_flight_logs_mutation',
  });
  if (!catalog.acquired) return catalog;
  try {
    const entries = fs.readdirSync(outputDir, { withFileTypes: true });
    if (entries.some((entry) => entry.name.toLowerCase().endsWith(BUNDLE_LEASE_SUFFIX))) {
      catalog.release();
      return { acquired: false, reason: 'busy', error: 'BUNDLE_LEASE_PRESENT' };
    }
    return catalog;
  } catch (error) {
    catalog.release();
    return {
      acquired: false,
      reason: 'io_error',
      error: (error as NodeJS.ErrnoException)?.code || 'LEASE_DIRECTORY_SCAN_FAILED',
    };
  }
}

function acquireBundleLeaseWithoutCatalog(
  options: LeaseOptions,
  allowedReentrantPurposes: string[] = [],
): LeaseResult {
  let baseName: string;
  try {
    baseName = assertBaseName(options.baseName);
  } catch {
    return { acquired: false, reason: 'unsafe' };
  }
  return createRawLease(
    getBundleLeasePath(options.outputDir, baseName),
    'bundle',
    baseName,
    options,
    allowedReentrantPurposes,
  );
}

/** Acquire the long-lived writer lease, serializing its publication briefly. */
function acquireRecordingBundleLease(options: LeaseOptions): LeaseResult {
  const catalog = acquireCatalogLease({ ...options, purpose: 'recording_start_catalog' });
  if (!catalog.acquired) return catalog;
  try {
    return acquireBundleLeaseWithoutCatalog({ ...options, purpose: options.purpose || 'recording' });
  } finally {
    catalog.release();
  }
}

/** Acquire one completed bundle for a read. */
function acquireBundleReadLease(options: LeaseOptions): LeaseResult {
  return acquireBundleLeaseWithoutCatalog({ ...options, purpose: options.purpose || 'read' });
}

function bundleLeaseAllowsCatalogSnapshot(
  outputDir: string,
  baseName: string,
  options: LeaseOptions,
): boolean {
  const leasePath = getBundleLeasePath(outputDir, baseName);
  const runtime = runtimeLeases.get(comparablePath(leasePath));
  if (runtime) {
    // The guarded history caller flushes its own active recorder before taking
    // this snapshot. Other local read-only work cannot change catalog metadata.
    return runtime.releaseRequested !== true && [
      'recording',
      'history_index',
      'timeline_read',
      'timeline_list',
      'logbook_read',
      'logbook_fallback_read',
    ].includes(runtime.record.purpose);
  }

  const existence = inspectPathExistence(leasePath);
  if (existence === 'missing') return true;
  if (existence === 'unknown') return false;
  if (tryReclaimStaleLease(leasePath, 'bundle', baseName, options)) return true;

  // A live read-only lease in another runtime is compatible with lightweight
  // metadata inspection. Unknown purposes and recording ownership fail closed.
  const existing = readExistingLease(leasePath, 'bundle', baseName);
  return Boolean(existing && [
    'history_index',
    'timeline_read',
    'timeline_list',
    'logbook_read',
    'logbook_fallback_read',
  ].includes(existing.record.purpose));
}

/**
 * Capture only the set of visible bundle CSV paths under the catalog gate.
 *
 * History reconciliation needs a stable directory membership snapshot, but it
 * does not read every bundle while taking that snapshot. Creating and syncing
 * one lease file per historic flight is therefore unnecessary and scales
 * poorly. The returned catalog lease remains held until `release()` so callers
 * can inspect lightweight bundle metadata before allowing create/delete/rename
 * mutations to resume.
 */
function acquireBundleCatalogSnapshotLease(options: LeaseOptions): LeaseGroupResult {
  const outputDir = path.resolve(options.outputDir);
  const catalog = acquireCatalogLease({
    ...options,
    outputDir,
    purpose: options.purpose || 'catalog_snapshot',
  });
  if (!catalog.acquired) return asLeaseFailure(catalog);
  try {
    options.beforeEnumerate?.(outputDir);
    const csvPaths = recordingBundleLayout.listBundleCsvPaths(outputDir);
    for (const csvPath of csvPaths) {
      const baseName = recordingBundleLayout.getBundleFromCsvPath(csvPath)?.bundleName || '';
      if (!baseName || !bundleLeaseAllowsCatalogSnapshot(outputDir, baseName, options)) {
        catalog.release();
        return { acquired: false, reason: 'busy', error: 'BUNDLE_LEASE_PRESENT' };
      }
    }
    let released = false;
    return {
      acquired: true,
      leases: [catalog],
      csvPaths,
      release() {
        if (released) return;
        released = true;
        catalog.release();
      },
    };
  } catch (error) {
    catalog.release();
    return {
      acquired: false,
      reason: 'io_error',
      error: (error as NodeJS.ErrnoException)?.code || 'CATALOG_SNAPSHOT_FAILED',
    };
  }
}

/**
 * Acquire catalog + bundle for deletion/recovery. The catalog remains held so
 * tombstone recovery cannot race another list/delete transaction.
 */
function acquireBundleMutationLease(options: LeaseOptions): LeaseGroupResult {
  const catalog = acquireCatalogLease({ ...options, purpose: 'bundle_mutation_catalog' });
  if (!catalog.acquired) return asLeaseFailure(catalog);
  const bundle = acquireBundleLeaseWithoutCatalog({ ...options, purpose: options.purpose || 'delete' });
  if (!bundle.acquired) {
    catalog.release();
    return asLeaseFailure(bundle);
  }
  let released = false;
  return {
    acquired: true,
    leases: [catalog, bundle],
    release() {
      if (released) return;
      released = true;
      bundle.release();
      catalog.release();
    },
  };
}

/**
 * Capture the current CSV catalog for a guarded list/logbook operation. Delete
 * recovery and enumeration run under the catalog gate; each visible bundle is
 * then leased and the gate is released. The caller must scan only `csvPaths`.
 * A busy or unsafe member fails the whole directory read instead of returning
 * a misleading partial catalog.
 */
function acquireBundleDirectoryReadLeases(options: LeaseOptions): LeaseGroupResult {
  const outputDir = path.resolve(options.outputDir);
  const catalog = acquireCatalogLease({ ...options, purpose: 'directory_read_catalog' });
  if (!catalog.acquired) return asLeaseFailure(catalog);
  const leases: LeaseHandle[] = [catalog];
  let completed = false;
  try {
    try {
      options.beforeEnumerate?.(outputDir);
    } catch (error) {
      return {
        acquired: false,
        reason: 'io_error',
        error: (error as NodeJS.ErrnoException)?.code || 'PRE_ENUMERATION_FAILED',
      };
    }
    let csvPaths: string[];
    try {
      csvPaths = recordingBundleLayout.listBundleCsvPaths(outputDir);
    } catch (error) {
      return {
        acquired: false,
        reason: 'io_error',
        error: (error as NodeJS.ErrnoException)?.code || 'READDIR_FAILED',
      };
    }
    for (const csvPath of csvPaths) {
      let csvIdentity: LeaseIdentity;
      try {
        csvIdentity = captureRegularIdentity(csvPath).identity;
      } catch {
        return { acquired: false, reason: 'unsafe', error: 'CSV_NOT_REGULAR' };
      }
      const baseName = recordingBundleLayout.getBundleFromCsvPath(csvPath)?.bundleName || '';
      const lease = acquireBundleLeaseWithoutCatalog(
        {
          ...options,
          outputDir,
          baseName,
          purpose: options.purpose || 'directory_read',
        },
        // The guarded store flushes and validates its own active bundle before
        // requesting a metadata-directory snapshot, so it may borrow that
        // same-process recording lease.
        // Background history indexing already holds a read lease for the one
        // bundle it is inspecting. A concurrent indexed-list request only
        // reads catalog metadata and SQLite, so sharing that same-process read
        // lease is safe and keeps existing flights visible while indexing.
        // Cross-process leases are still absent from runtimeLeases and remain
        // strict blockers. Detailed reads, mutations, recording starts, and
        // catalog leases remain exclusive even inside one process.
        ['recording', 'recording_startup', 'history_index'],
      );
      if (!lease.acquired) return asLeaseFailure(lease);
      leases.push(lease);
      try {
        const afterLeaseIdentity = captureRegularIdentity(csvPath).identity;
        if (!identitiesMatch(csvIdentity, afterLeaseIdentity)) {
          return { acquired: false, reason: 'unsafe', error: 'CSV_IDENTITY_CHANGED' };
        }
      } catch {
        return { acquired: false, reason: 'unsafe', error: 'CSV_IDENTITY_CHANGED' };
      }
    }
    // The catalog gate protects enumeration only. Once every visible basename
    // has its own lease, release the gate so a new recording can start while a
    // long history/index read parses the fixed allowlist below. The caller must
    // use `csvPaths`; a second unfiltered readdir would defeat this snapshot.
    if (!catalog.release()) {
      return { acquired: false, reason: 'unsafe', error: 'CATALOG_RELEASE_FAILED' };
    }
    leases.shift();
    let released = false;
    completed = true;
    return {
      acquired: true,
      leases,
      csvPaths,
      release() {
        if (released) return;
        released = true;
        for (const lease of [...leases].reverse()) lease.release();
      },
    };
  } finally {
    // On failure, the returned object has no release hook, so unwind here.
    // Successful groups retain only the fixed set of bundle leases.
    if (!completed) {
      for (const lease of [...leases].reverse()) lease.release();
    }
  }
}

function resetRecordingBundleLeasesForTests(): void {
  for (const runtime of [...runtimeLeases.values()]) {
    runtime.refs = 0;
    runtime.releaseRequested = true;
    releaseRuntime(runtime);
  }
}

module.exports = {
  BUNDLE_LEASE_SUFFIX,
  acquireBundleDirectoryReadLeases,
  acquireBundleCatalogSnapshotLease,
  acquireBundleMutationLease,
  acquireBundleReadLease,
  acquireExclusiveFlightLogsMutationLease,
  acquireRecordingBundleLease,
  getBundleLeasePath,
  getCatalogLeasePath,
  resetRecordingBundleLeasesForTests,
};

export {};
