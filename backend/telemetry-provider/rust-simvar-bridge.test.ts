const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const rustBridgePath = path.join(__dirname, 'rust-simvar-bridge.js');
const {
  RustSimvarBridge,
  supportsRequiredOwnerLifeline,
} = require('./rust-simvar-bridge.js');
const {
  getManagedRustSidecarPaths,
  selectNewestManagedRustSidecar,
} = require('../../shared/rust-sidecar-artifact.js');

type KillCall = { pid: number; signal: string | number | undefined };

test('managed Rust sidecar selection follows the newest main or staged artifact', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-rust-artifact-test-'));
  const binaryName = process.platform === 'win32'
    ? 'ff-rust-simconnect-sidecar.exe'
    : 'ff-rust-simconnect-sidecar';
  try {
    const { mainPath, pendingPath } = getManagedRustSidecarPaths(tempDir, binaryName);
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
    fs.writeFileSync(mainPath, 'old-main');
    fs.writeFileSync(pendingPath, 'new-pending');

    const oldTime = new Date('2026-07-18T00:00:00Z');
    const middleTime = new Date('2026-07-18T00:01:00Z');
    const newTime = new Date('2026-07-18T00:02:00Z');
    fs.utimesSync(mainPath, oldTime, oldTime);
    fs.utimesSync(pendingPath, middleTime, middleTime);
    assert.equal(
      selectNewestManagedRustSidecar(tempDir, binaryName),
      pendingPath,
      'the first live build should hand the next process generation to pending',
    );

    fs.utimesSync(mainPath, newTime, newTime);
    assert.equal(
      selectNewestManagedRustSidecar(tempDir, binaryName),
      mainPath,
      'a later live build should return to a newer unlocked main executable',
    );

    fs.utimesSync(pendingPath, newTime, newTime);
    assert.equal(
      selectNewestManagedRustSidecar(tempDir, binaryName),
      pendingPath,
      'equal mtimes should resolve deterministically to the staged artifact',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

class FakeRustSimvarChild extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  killCalls: Array<NodeJS.Signals | number | undefined> = [];
  exitOnStop: boolean;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin: import('node:events').EventEmitter & {
    destroyed: boolean;
    writableEnded: boolean;
    writable: boolean;
    write: () => boolean;
  };

  constructor(pid: number, exitOnStop = true) {
    super();
    this.pid = pid;
    this.exitOnStop = exitOnStop;
    this.stdin = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      writable: true,
      write: (): boolean => {
        if (this.exitOnStop) queueMicrotask(() => this.finish(0, null));
        return true;
      },
    });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killCalls.push(signal);
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

async function withPatchedRustSpawn(
  spawnOverride: (...args: unknown[]) => unknown,
  run: (FreshRustSimvarBridge: any) => Promise<void>,
): Promise<void> {
  const childProcess = require('child_process');
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  const originalExistsSync = fs.existsSync;
  childProcess.spawn = spawnOverride;
  childProcess.spawnSync = () => ({
    status: 0,
    stdout: JSON.stringify({ ok: true, ownerLifelineVersion: 1 }),
    stderr: '',
  });
  fs.existsSync = (candidate: string) => (
    path.basename(candidate).toLowerCase().startsWith('ff-rust-simconnect-sidecar')
      ? true
      : originalExistsSync(candidate)
  );
  delete require.cache[require.resolve(rustBridgePath)];
  try {
    const { RustSimvarBridge: FreshRustSimvarBridge } = require(rustBridgePath);
    await run(FreshRustSimvarBridge);
  } finally {
    delete require.cache[require.resolve(rustBridgePath)];
    childProcess.spawn = originalSpawn;
    childProcess.spawnSync = originalSpawnSync;
    fs.existsSync = originalExistsSync;
  }
}

function withPatchedProcessKill(run: (calls: KillCall[]) => void): void {
  const originalKill = process.kill;
  const calls: KillCall[] = [];
  (process as any).kill = (pid: number, signal?: string | number): boolean => {
    calls.push({ pid, signal });
    return true;
  };
  try {
    run(calls);
  } finally {
    (process as any).kill = originalKill;
  }
}

function withTempPidFile(run: (bridge: any, pidFilePath: string) => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-rust-simvar-pid-test-'));
  try {
    const bridge = new RustSimvarBridge();
    const pidFilePath = path.join(tempDir, 'sidecar.pid');
    bridge._pidFilePath = pidFilePath;
    run(bridge, pidFilePath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeOwnedPidRecord(
  pidFilePath: string,
  { pid, ownerPid, ownerToken, ownerStartToken = 'owner-start' }: {
    pid: number;
    ownerPid: number;
    ownerToken: string;
    ownerStartToken?: string;
  },
): void {
  fs.writeFileSync(pidFilePath, JSON.stringify({
    version: 1,
    pid,
    ownerPid,
    ownerToken,
    ownerStartToken,
    ownerStartedAtMs: 1000,
  }), 'utf8');
}

test('RustSimvarBridge uses a role-specific PID file', () => {
  const bridge = new RustSimvarBridge();
  assert.match(
    path.basename(bridge._pidFilePath),
    /^flight-fabric-rust-simvars-sidecar-\d+-[0-9a-f-]+\.pid$/,
  );
});

test('RustSimvarBridge passes role and backend ownership identity to its child', () => {
  const bridge = new RustSimvarBridge();
  assert.deepEqual(bridge._buildLaunchArgs(), [
    '--simvars-bridge',
    `--ff-owner-pid=${bridge._ownerIdentity.pid}`,
    `--ff-owner-token=${bridge._ownerIdentity.token}`,
  ]);
});

test('RustSimvarBridge accepts only explicit supported owner lifeline probe versions', () => {
  assert.equal(supportsRequiredOwnerLifeline(null), false);
  assert.equal(supportsRequiredOwnerLifeline({}), false);
  assert.equal(supportsRequiredOwnerLifeline({ ownerLifelineVersion: '1' }), false);
  assert.equal(supportsRequiredOwnerLifeline({ ownerLifelineVersion: 0 }), false);
  assert.equal(supportsRequiredOwnerLifeline({ ownerLifelineVersion: 1 }), true);
  assert.equal(supportsRequiredOwnerLifeline({ ownerLifelineVersion: 2 }), true);
});

test('RustSimvarBridge start rejects and rolls back an asynchronous spawn error', async () => {
  const child = new FakeRustSimvarChild(626290, false);
  await withPatchedRustSpawn(() => {
    queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
    return child;
  }, async (FreshRustSimvarBridge) => {
    const bridge = new FreshRustSimvarBridge();
    bridge._cleanupStaleSidecarProcesses = () => {};
    bridge._writePidFile = () => {};
    bridge._clearPidFile = () => {};

    await assert.rejects(bridge.start(), /spawn ENOENT/);

    assert.equal(bridge._started, false);
    assert.equal(bridge._proc, null);
    assert.match(bridge.getSnapshot().error || '', /spawn failed: spawn ENOENT/);
  });
});

test('RustSimvarBridge absorbs post-spawn process and stdio errors while retaining the child for stop', async () => {
  const child = new FakeRustSimvarChild(626291, false);
  await withPatchedRustSpawn(() => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }, async (FreshRustSimvarBridge) => {
    const bridge = new FreshRustSimvarBridge();
    bridge._cleanupStaleSidecarProcesses = () => {};
    bridge._writePidFile = () => {};
    bridge._clearPidFile = () => {};

    await bridge.start();
    child.stdout.emit('error', new Error('stdout read failure'));
    assert.match(bridge.getSnapshot().error || '', /stdout error: stdout read failure/);
    child.stderr.emit('error', new Error('stderr read failure'));
    assert.match(bridge.getSnapshot().error || '', /stderr error: stderr read failure/);
    child.emit('error', new Error('post-spawn transport failure'));
    assert.equal(bridge._proc, child, 'process error must not abandon a potentially live process');
    assert.equal(bridge._started, true);
    assert.match(bridge.getSnapshot().error || '', /process error: post-spawn transport failure/);

    child.stdin.write = (): boolean => {
      queueMicrotask(() => child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
      return false;
    };
    bridge._send({ type: 'test' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(bridge._proc, child, 'transport error must not abandon a potentially live process');
    assert.equal(bridge._started, true);
    assert.match(bridge.getSnapshot().error || '', /stdin error: write EPIPE/);
    child.finish(0, null);
  });
});

test('RustSimvarBridge stale PID cleanup never kills LVAR or SDK bridge roles', () => {
  const binary = 'C:\\ff\\ff-rust-simconnect-sidecar.exe';
  const siblingCommands = [
    `"${binary}"`,
    `"${binary}" --sdk-clientdata-bridge`,
  ];

  for (const [index, commandLine] of siblingCommands.entries()) {
    withTempPidFile((bridge, pidFilePath) => {
      const stalePid = 626260 + index;
      const userSid = 'S-1-5-21-6262';
      bridge._ownerIdentity = { ...bridge._ownerIdentity, userSid };
      bridge._readProcessCommandLine = () => commandLine;
      bridge._readProcessMetadata = (pid) => ({
        pid,
        parentPid: 1,
        startToken: `sibling-start-${index}`,
        startedAtMs: 1000,
        commandLine,
        userSid,
      });
      fs.writeFileSync(pidFilePath, String(stalePid), 'utf8');

      withPatchedProcessKill((calls) => {
        bridge._cleanupFromPidFile(binary);
        assert.deepEqual(calls, []);
      });

      assert.equal(fs.existsSync(pidFilePath), false);
    });
  }
});

test('RustSimvarBridge clears its own mismatched record but preserves another installation\'s', () => {
  const binary = 'C:\\current-install\\ff-rust-simconnect-sidecar.exe';
  withTempPidFile((bridge, pidFilePath) => {
    const foreignPidFilePath = path.join(path.dirname(pidFilePath), 'sidecar-999-foreign.pid');
    const localChildPid = 626271;
    const childPid = 626269;
    const userSid = 'S-1-5-21-6262';
    bridge._ownerIdentity = { ...bridge._ownerIdentity, userSid };
    bridge._readProcessCommandLine = () => '"C:\\other-install\\ff-rust-simconnect-sidecar.exe" --simvars-bridge';
    bridge._readProcessMetadata = (pid) => ({
      pid,
      parentPid: 626270,
      startToken: 'foreign-install-rust-start',
      startedAtMs: 2000,
      commandLine: 'sidecar',
      userSid,
    });
    writeOwnedPidRecord(pidFilePath, {
      pid: localChildPid,
      ownerPid: bridge._ownerIdentity.pid,
      ownerToken: bridge._ownerIdentity.token,
    });
    writeOwnedPidRecord(foreignPidFilePath, {
      pid: childPid,
      ownerPid: 626270,
      ownerToken: 'foreign-install-rust-owner',
    });

    withPatchedProcessKill((calls) => {
      bridge._cleanupFromPidFile(binary);
      assert.deepEqual(calls, []);
    });

    assert.equal(fs.existsSync(pidFilePath), false);
    assert.equal(fs.existsSync(foreignPidFilePath), true);
  });
});

test('RustSimvarBridge stale PID cleanup force kills a SimVar role with reused owner PID', () => {
  const binary = 'C:\\ff\\ff-rust-simconnect-sidecar.exe';
  withTempPidFile((bridge, pidFilePath) => {
    const stalePid = 626262;
    const ownerPid = 626250;
    const ownerToken = 'stale-rust-owner';
    const userSid = 'S-1-5-21-6262';
    bridge._ownerIdentity = { ...bridge._ownerIdentity, userSid };
    bridge._readProcessCommandLine = () => `"${binary}" --simvars-bridge --ff-owner-pid=${ownerPid} --ff-owner-token=${ownerToken}`;
    bridge._readProcessMetadata = (pid) => pid === ownerPid
      ? { pid, parentPid: 1, startToken: 'reused-start', startedAtMs: 9000, commandLine: 'node reused', userSid }
      : { pid, parentPid: ownerPid, startToken: 'rust-sidecar-start', startedAtMs: 2000, commandLine: 'sidecar', userSid };
    writeOwnedPidRecord(pidFilePath, { pid: stalePid, ownerPid, ownerToken });

    withPatchedProcessKill((calls) => {
      bridge._cleanupFromPidFile(binary);
      assert.deepEqual(calls, [
        { pid: stalePid, signal: 0 },
        { pid: stalePid, signal: 'SIGKILL' },
      ]);
    });

    assert.equal(fs.existsSync(pidFilePath), false);
  });
});

test('RustSimvarBridge protects a SimVar sidecar owned by another live backend', () => {
  const binary = 'C:\\ff\\ff-rust-simconnect-sidecar.exe';
  withTempPidFile((bridge, pidFilePath) => {
    const childPid = 626266;
    const ownerPid = 626267;
    const ownerToken = 'foreign-rust-owner';
    const userSid = 'S-1-5-21-6262';
    bridge._ownerIdentity = { ...bridge._ownerIdentity, userSid };
    bridge._readProcessCommandLine = () => `"${binary}" --simvars-bridge --ff-owner-pid=${ownerPid} --ff-owner-token=${ownerToken}`;
    bridge._readProcessMetadata = (pid) => pid === ownerPid
      ? { pid, parentPid: 1, startToken: 'foreign-rust-start', startedAtMs: 1000, commandLine: 'node other-backend', userSid }
      : { pid, parentPid: ownerPid, startToken: 'foreign-rust-sidecar-start', startedAtMs: 2000, commandLine: 'sidecar', userSid };
    writeOwnedPidRecord(pidFilePath, {
      pid: childPid,
      ownerPid,
      ownerToken,
      ownerStartToken: 'foreign-rust-start',
    });

    withPatchedProcessKill((calls) => {
      bridge._cleanupFromPidFile(binary);
      assert.deepEqual(calls, []);
    });

    assert.equal(fs.existsSync(pidFilePath), true);
  });
});

test('RustSimvarBridge preserves a role-matched PID owned by another Windows user', () => {
  const binary = 'C:\\ff\\ff-rust-simconnect-sidecar.exe';
  withTempPidFile((bridge, pidFilePath) => {
    const childPid = 626268;
    bridge._ownerIdentity = { ...bridge._ownerIdentity, userSid: 'S-1-5-21-6262' };
    bridge._readProcessCommandLine = () => `"${binary}" --simvars-bridge --ff-owner-pid=${bridge._ownerIdentity.pid} --ff-owner-token=${bridge._ownerIdentity.token}`;
    bridge._readProcessMetadata = (pid) => ({
      pid,
      parentPid: bridge._ownerIdentity.pid,
      startToken: 'cross-user-rust-sidecar-start',
      startedAtMs: 2000,
      commandLine: 'sidecar',
      userSid: 'S-1-5-21-9999',
    });
    writeOwnedPidRecord(pidFilePath, {
      pid: childPid,
      ownerPid: bridge._ownerIdentity.pid,
      ownerToken: bridge._ownerIdentity.token,
    });

    withPatchedProcessKill((calls) => {
      bridge._cleanupFromPidFile(binary);
      assert.deepEqual(calls, []);
    });

    assert.equal(fs.existsSync(pidFilePath), true);
  });
});

test('RustSimvarBridge command-line scan selects only the SimVar bridge role', () => {
  const bridge = new RustSimvarBridge();
  const script = bridge._buildCleanupScanScript('C:\\ff\\ff-rust-simconnect-sidecar.exe') || '';

  assert.match(script, /-match '\(\?i\)\(\^\|\\s\)--simvars-bridge/);
  assert.match(script, /-notmatch '\(\?i\)\(\^\|\\s\)--sdk-clientdata-bridge/);
  assert.match(script, /\$actualParentCouldOwn/);
  assert.match(script, /\$ownershipDisproved/);
  assert.match(script, /\$currentSid/);
  assert.match(script, /\$confirmedSid/);
});

test('RustSimvarBridge stop waits for graceful exit without killing the child', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-rust-simvar-stop-test-'));
  try {
    const bridge = new RustSimvarBridge();
    const child = new FakeRustSimvarChild(626263);
    bridge._pidFilePath = path.join(tempDir, 'sidecar.pid');
    bridge._proc = child;
    bridge._started = true;
    fs.writeFileSync(bridge._pidFilePath, String(child.pid), 'utf8');
    child.on('exit', (code, signal) => bridge._handleProcessExit(child, code, signal));

    await bridge.stop();

    assert.deepEqual(child.killCalls, []);
    assert.equal(bridge._proc, null);
    assert.equal(bridge.getSnapshot().error, null);
    assert.equal(fs.existsSync(bridge._pidFilePath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('RustSimvarBridge retains a child and PID record when forced shutdown cannot confirm exit', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-rust-simvar-stop-failure-test-'));
  try {
    const bridge = new RustSimvarBridge();
    const child = new FakeRustSimvarChild(626266, false);
    bridge._pidFilePath = path.join(tempDir, 'sidecar.pid');
    bridge._proc = child;
    bridge._started = true;
    fs.writeFileSync(bridge._pidFilePath, String(child.pid), 'utf8');

    await assert.rejects(
      bridge.stop(),
      /Rust SimVar sidecar PID 626266 did not exit after forced shutdown/,
    );

    assert.equal(bridge._proc, child);
    assert.equal(bridge._started, true);
    assert.match(bridge.getSnapshot().error || '', /did not exit after forced shutdown/);
    assert.equal(fs.existsSync(bridge._pidFilePath), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('RustSimvarBridge ignores exit events from a replaced child', () => {
  withTempPidFile((bridge, pidFilePath) => {
    const staleChild = new FakeRustSimvarChild(626264);
    const currentChild = new FakeRustSimvarChild(626265);
    bridge._proc = currentChild;
    bridge._started = true;
    fs.writeFileSync(pidFilePath, String(currentChild.pid), 'utf8');

    bridge._handleProcessExit(staleChild, 0, null);

    assert.equal(bridge._proc, currentChild);
    assert.equal(bridge._started, true);
    assert.equal(fs.readFileSync(pidFilePath, 'utf8'), String(currentChild.pid));
  });
});

export {};
