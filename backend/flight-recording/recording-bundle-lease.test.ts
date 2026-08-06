const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const leaseProtocol = require('./recording-bundle-lease.js');
const { getBundlePaths } = require('./recording-bundle-layout.js');

function writeBundleCsv(outputDir: string, baseName: string): string {
  const paths = getBundlePaths(outputDir, baseName);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.csv, 'header\n');
  return paths.csv;
}

const CHILD_HOLDER_SOURCE = String.raw`
  const leases = require(process.argv[1]);
  const outputDir = process.argv[2];
  const baseName = process.argv[3];
  const lease = leases.acquireRecordingBundleLease({
    outputDir,
    baseName,
    purpose: 'recording',
    createDirectory: true,
    heartbeatIntervalMs: 25,
  });
  if (!lease.acquired) {
    process.stdout.write('FAILED:' + lease.reason + '\n');
    process.exit(2);
  }
  process.stdout.write('READY\n');
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    if (String(chunk).includes('RELEASE')) {
      lease.release();
      process.exit(0);
    }
  });
  setInterval(() => {}, 1000);
`;

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-bundle-lease-'));
}

function waitForOutputLine(child: any, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for child output: ${output}`)), 5_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.split(/\r?\n/).includes(expected)) {
        clearTimeout(timeout);
        resolve();
      }
      if (output.includes('FAILED:')) {
        clearTimeout(timeout);
        reject(new Error(output.trim()));
      }
    });
    child.once('error', (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code: number | null) => {
      if (!output.split(/\r?\n/).includes(expected)) {
        clearTimeout(timeout);
        reject(new Error(`Lease child exited ${code}: ${output.trim()}`));
      }
    });
  });
}

function waitForExit(child: any): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for lease condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test.afterEach(() => {
  leaseProtocol.resetRecordingBundleLeasesForTests();
});

test('specific reads and mutation never reenter a same-process recording lease', () => {
  const outputDir = makeTempDir();
  const baseName = '2026-07-20T12-00-00_reentrant-guard';
  try {
    const recording = leaseProtocol.acquireRecordingBundleLease({
      outputDir,
      baseName,
      purpose: 'recording',
      createDirectory: true,
    });
    assert.equal(recording.acquired, true);
    writeBundleCsv(outputDir, baseName);

    const read = leaseProtocol.acquireBundleReadLease({ outputDir, baseName, purpose: 'timeline_read' });
    assert.equal(read.acquired, false);
    assert.equal(read.reason, 'busy');

    const mutation = leaseProtocol.acquireBundleMutationLease({ outputDir, baseName, purpose: 'delete' });
    assert.equal(mutation.acquired, false);
    assert.equal(mutation.reason, 'busy');
    assert.equal(fs.existsSync(leaseProtocol.getCatalogLeasePath(outputDir)), false);

    recording.release();
    assert.equal(fs.existsSync(leaseProtocol.getBundleLeasePath(outputDir, baseName)), false);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('directory snapshot borrows only the flushed local recording and releases its catalog gate', () => {
  const outputDir = makeTempDir();
  const baseName = '2026-07-20T12-00-01_directory-snapshot';
  const laterBaseName = '2026-07-20T12-00-02_later-recording';
  try {
    const csvPath = writeBundleCsv(outputDir, baseName);
    const recording = leaseProtocol.acquireRecordingBundleLease({
      outputDir,
      baseName,
      purpose: 'recording',
      createDirectory: true,
    });
    assert.equal(recording.acquired, true);

    let mutationDuringRecovery: any = null;
    const directory = leaseProtocol.acquireBundleDirectoryReadLeases({
      outputDir,
      purpose: 'timeline_list',
      beforeEnumerate() {
        mutationDuringRecovery = leaseProtocol.acquireBundleMutationLease({
          outputDir,
          baseName,
          purpose: 'delete_during_recovery',
        });
      },
    });
    assert.equal(mutationDuringRecovery.acquired, false, 'recovery callback must run under the catalog gate');
    assert.equal(directory.acquired, true);
    assert.deepEqual(directory.csvPaths, [csvPath]);
    assert.equal(fs.existsSync(leaseProtocol.getCatalogLeasePath(outputDir)), false);

    const laterRecording = leaseProtocol.acquireRecordingBundleLease({
      outputDir,
      baseName: laterBaseName,
      purpose: 'recording',
      createDirectory: true,
    });
    assert.equal(laterRecording.acquired, true, 'long history reads must not retain the catalog gate');
    assert.equal(directory.csvPaths.includes(getBundlePaths(outputDir, laterBaseName).csv), false);

    laterRecording.release();
    directory.release();
    assert.equal(fs.existsSync(leaseProtocol.getBundleLeasePath(outputDir, baseName)), true);
    recording.release();
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('directory snapshot shares a same-process history-index read lease', () => {
  const outputDir = makeTempDir();
  const baseName = '2026-07-20T12-00-02_history-index';
  try {
    const csvPath = writeBundleCsv(outputDir, baseName);
    const historyRead = leaseProtocol.acquireBundleReadLease({
      outputDir,
      baseName,
      purpose: 'history_index',
    });
    assert.equal(historyRead.acquired, true);

    const directory = leaseProtocol.acquireBundleDirectoryReadLeases({
      outputDir,
      purpose: 'timeline_indexed_list',
    });
    assert.equal(directory.acquired, true, directory.error || directory.reason);
    assert.deepEqual(directory.csvPaths, [csvPath]);

    directory.release();
    assert.equal(
      fs.existsSync(leaseProtocol.getBundleLeasePath(outputDir, baseName)),
      true,
      'the indexer must retain its original read lease',
    );
    historyRead.release();
    assert.equal(fs.existsSync(leaseProtocol.getBundleLeasePath(outputDir, baseName)), false);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('catalog snapshot captures membership with one catalog lease and no per-bundle markers', () => {
  const outputDir = makeTempDir();
  const firstBaseName = '2026-07-20T12-00-02_catalog-a';
  const secondBaseName = '2026-07-20T12-00-03_catalog-b';
  try {
    const csvPaths = [
      writeBundleCsv(outputDir, firstBaseName),
      writeBundleCsv(outputDir, secondBaseName),
    ];
    const snapshot = leaseProtocol.acquireBundleCatalogSnapshotLease({
      outputDir,
      purpose: 'history_catalog_snapshot',
    });
    assert.equal(snapshot.acquired, true, snapshot.error || snapshot.reason);
    assert.deepEqual(snapshot.csvPaths, csvPaths);
    assert.equal(fs.existsSync(leaseProtocol.getCatalogLeasePath(outputDir)), true);
    assert.equal(fs.existsSync(leaseProtocol.getBundleLeasePath(outputDir, firstBaseName)), false);
    assert.equal(fs.existsSync(leaseProtocol.getBundleLeasePath(outputDir, secondBaseName)), false);

    const mutation = leaseProtocol.acquireBundleMutationLease({
      outputDir,
      baseName: firstBaseName,
      purpose: 'delete_during_catalog_snapshot',
    });
    assert.equal(mutation.acquired, false);
    assert.equal(mutation.reason, 'busy');

    snapshot.release();
    assert.equal(fs.existsSync(leaseProtocol.getCatalogLeasePath(outputDir)), false);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('a live child-process recording blocks read, list, and mutation; its crashed lease is reclaimed', async () => {
  const outputDir = makeTempDir();
  const baseName = '2026-07-20T12-00-03_cross-process';
  const modulePath = path.join(__dirname, 'recording-bundle-lease.js');
  const child = spawn(process.execPath, ['-e', CHILD_HOLDER_SOURCE, modulePath, outputDir, baseName], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  try {
    await waitForOutputLine(child, 'READY');
    writeBundleCsv(outputDir, baseName);

    const read = leaseProtocol.acquireBundleReadLease({ outputDir, baseName, purpose: 'timeline_read' });
    assert.equal(read.acquired, false);
    assert.equal(read.reason, 'busy');

    const directory = leaseProtocol.acquireBundleDirectoryReadLeases({ outputDir, purpose: 'timeline_list' });
    assert.equal(directory.acquired, false);
    assert.equal(directory.reason, 'busy');
    assert.equal(fs.existsSync(leaseProtocol.getCatalogLeasePath(outputDir)), false);

    const mutation = leaseProtocol.acquireBundleMutationLease({ outputDir, baseName, purpose: 'delete' });
    assert.equal(mutation.acquired, false);
    assert.equal(mutation.reason, 'busy');

    child.kill('SIGKILL');
    await waitForExit(child);

    const recovered = leaseProtocol.acquireBundleReadLease({
      outputDir,
      baseName,
      purpose: 'post_crash_read',
      staleRecoveryGraceMs: 0,
      now: () => Date.now() + 60_000,
    });
    assert.equal(recovered.acquired, true, recovered.error || recovered.reason);
    recovered.release();
    assert.equal(fs.existsSync(leaseProtocol.getBundleLeasePath(outputDir, baseName)), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child);
    }
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('malformed or unprovable lease files fail closed and are never removed', () => {
  const outputDir = makeTempDir();
  const baseName = '2026-07-20T12-00-04_unknown-marker';
  const leasePath = leaseProtocol.getBundleLeasePath(outputDir, baseName);
  const original = 'user-controlled unknown bytes\n';
  try {
    fs.writeFileSync(leasePath, original);
    const read = leaseProtocol.acquireBundleReadLease({
      outputDir,
      baseName,
      purpose: 'timeline_read',
      staleRecoveryGraceMs: 0,
      now: () => Date.now() + 60_000,
      isProcessAlive: () => 'dead',
    });
    assert.equal(read.acquired, false);
    assert.equal(read.reason, 'unsafe');
    assert.equal(fs.readFileSync(leasePath, 'utf8'), original);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('completed-status files and their delete tombstones reserve the whole basename', () => {
  const outputDir = makeTempDir();
  const preferred = '2026-07-20T12-00-05_status-reservation';
  const lifecycle = require('./recording-bundle-lifecycle.js');
  try {
    const paths = getBundlePaths(outputDir, preferred);
    fs.mkdirSync(paths.dir);
    const statusPath = paths.status;
    fs.writeFileSync(statusPath, '{}\n');
    assert.equal(lifecycle.allocateBundleBaseName(outputDir, preferred), `${preferred}-2`);

    fs.rmSync(paths.dir, { recursive: true });
    fs.mkdirSync(path.join(outputDir, `${preferred}.ff-delete-123-456-abc`));
    assert.equal(lifecycle.allocateBundleBaseName(outputDir, preferred), `${preferred}-2`);
  } finally {
    lifecycle.resetRecordingBundleLifecycleForTests();
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('transient lease unlink failure retains ownership and retries automatically', async () => {
  const outputDir = makeTempDir();
  const baseName = '2026-07-20T12-00-06_release-retry';
  const leasePath = leaseProtocol.getBundleLeasePath(outputDir, baseName);
  try {
    const recording = leaseProtocol.acquireRecordingBundleLease({
      outputDir,
      baseName,
      purpose: 'recording',
      createDirectory: true,
    });
    assert.equal(recording.acquired, true);
    writeBundleCsv(outputDir, baseName);

    const unlinkOriginal = fs.unlinkSync;
    let refused = false;
    (fs as any).unlinkSync = (candidatePath: import('fs').PathLike) => {
      if (!refused && path.resolve(String(candidatePath)) === path.resolve(leasePath)) {
        refused = true;
        const error = new Error('simulated antivirus sharing violation') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return unlinkOriginal(candidatePath);
    };
    let released: boolean;
    try {
      released = recording.release();
    } finally {
      (fs as any).unlinkSync = unlinkOriginal;
    }
    assert.equal(released, false, 'the first unlink attempt should report the transient failure');
    assert.equal(fs.existsSync(leasePath), true);

    const blockedDuringRetry = leaseProtocol.acquireBundleReadLease({
      outputDir,
      baseName,
      purpose: 'timeline_read',
    });
    assert.equal(blockedDuringRetry.acquired, false, 'registry ownership must survive the failed unlink');
    const directoryDuringRetry = leaseProtocol.acquireBundleDirectoryReadLeases({
      outputDir,
      purpose: 'timeline_list',
    });
    assert.equal(directoryDuringRetry.acquired, false, 'metadata borrow must not reenter a pending release');

    await waitForCondition(() => !fs.existsSync(leasePath));
    assert.equal(fs.existsSync(leasePath), false, 'background retry should remove only the owned marker');
    const replacement = leaseProtocol.acquireBundleReadLease({
      outputDir,
      baseName,
      purpose: 'post_retry_read',
    });
    assert.equal(replacement.acquired, true);
    replacement.release();
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('transient lease verification read failure also retries without abandoning ownership', async () => {
  const outputDir = makeTempDir();
  const baseName = '2026-07-20T12-00-07_release-read-retry';
  const leasePath = leaseProtocol.getBundleLeasePath(outputDir, baseName);
  try {
    const recording = leaseProtocol.acquireRecordingBundleLease({
      outputDir,
      baseName,
      purpose: 'recording',
      createDirectory: true,
    });
    assert.equal(recording.acquired, true);

    const openOriginal = fs.openSync;
    let refused = false;
    (fs as any).openSync = (candidatePath: import('fs').PathLike, flags: string, ...rest: any[]) => {
      if (
        !refused
        && path.resolve(String(candidatePath)) === path.resolve(leasePath)
        && flags === 'r'
      ) {
        refused = true;
        const error = new Error('simulated transient lease read denial') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return (openOriginal as any)(candidatePath, flags, ...rest);
    };
    let released: boolean;
    try {
      released = recording.release();
    } finally {
      (fs as any).openSync = openOriginal;
    }
    assert.equal(released, false);
    const blocked = leaseProtocol.acquireBundleReadLease({
      outputDir,
      baseName,
      purpose: 'timeline_read',
    });
    assert.equal(blocked.acquired, false);
    await waitForCondition(() => !fs.existsSync(leasePath));
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
