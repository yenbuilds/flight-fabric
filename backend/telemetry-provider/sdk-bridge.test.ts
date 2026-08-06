const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const sdkBridgePath = path.join(__dirname, 'sdk-bridge.js');
const sdkRegistry = require('./sdk-registry.js');
const { SdkBridge } = require('./sdk-bridge.js');
const {
  supportsRequiredOwnerLifeline,
} = require('./sdk-adapters/rust-clientdata-launch.js');

type KillCall = { pid: number; signal: string | number | undefined };

class FakeSdkChild extends EventEmitter {
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

async function withPatchedSdkSpawn(
  spawnOverride: (...args: unknown[]) => unknown,
  run: (FreshSdkBridge: any) => Promise<void>,
): Promise<void> {
  const childProcess = require('child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = spawnOverride;
  delete require.cache[require.resolve(sdkBridgePath)];
  try {
    const { SdkBridge: FreshSdkBridge } = require(sdkBridgePath);
    await run(FreshSdkBridge);
  } finally {
    delete require.cache[require.resolve(sdkBridgePath)];
    childProcess.spawn = originalSpawn;
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

function withTempPidFile(run: (pidFilePath: string) => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-sdk-pid-test-'));
  try {
    run(path.join(tempDir, 'sidecar.pid'));
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

test('SdkBridge prefers normalized SDK values supplied by the sidecar', () => {
  const adapter = sdkRegistry.getSdkAdapterById('clientdata-manifest');
  const bridge = new SdkBridge(adapter);

  bridge._onStdout(`${JSON.stringify({
    type: 'snapshot',
    values: {
      raw_flag: false,
      raw_speed: 999,
      raw_state: 'DOWN',
    },
    normalized: {
      automation: {
        ap: {
          engaged: true,
          selected: { speedKts: 111 },
        },
      },
      spoilers: { state: 'STOWED' },
    },
    timestampIso: '2026-05-24T01:00:00Z',
  })}\n`);

  const snapshot = bridge.getSnapshot();
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.raw.raw_speed, 999);
  assert.equal(snapshot.normalized.automation.ap.engaged, true);
  assert.equal(snapshot.normalized.automation.ap.selected.speedKts, 111);
  assert.equal(snapshot.normalized.spoilers.state, 'STOWED');
});

test('generic ClientData manifest adapter relies on sidecar normalized values only', () => {
  const adapter = sdkRegistry.getSdkAdapterById('clientdata-manifest');
  const bridge = new SdkBridge(adapter);

  bridge._onStdout(`${JSON.stringify({
    type: 'snapshot',
    values: {
      raw_flag: true,
      raw_speed: 250,
    },
    timestampIso: '2026-05-24T02:00:00Z',
  })}\n`);

  let snapshot = bridge.getSnapshot();
  assert.deepEqual(snapshot.normalized, {});
  assert.equal(snapshot.raw.raw_flag, true);

  bridge._onStdout(`${JSON.stringify({
    type: 'snapshot',
    values: {
      flag: true,
    },
    normalized: {
      lights: { nav: true },
    },
    timestampIso: '2026-05-24T02:01:00Z',
  })}\n`);

  snapshot = bridge.getSnapshot();
  assert.equal(snapshot.normalized.lights.nav, true);
});

test('generic ClientData manifest adapter does not connect without an explicit target', () => {
  const adapter = sdkRegistry.getSdkAdapterById('clientdata-manifest');
  const bridge = new SdkBridge(adapter);
  const writes = [];

  bridge._started = true;
  bridge._proc = {
    killed: false,
    stdin: {
      write(chunk: string) {
        writes.push(chunk);
      },
    },
  };

  bridge.connect({});

  assert.equal(writes.length, 0);
  assert.equal(bridge.getSnapshot().aircraft, null);
  assert.deepEqual(bridge.getSnapshot().target, {});
});

test('SdkBridge sends a target only once when ready follows connect in the same process generation', () => {
  const adapter = sdkRegistry.getSdkAdapterById('clientdata-manifest');
  const bridge = new SdkBridge(adapter);
  const firstWrites: string[] = [];
  const firstChild = {
    killed: false,
    stdin: {
      destroyed: false,
      writableEnded: false,
      writable: true,
      write(chunk: string) {
        firstWrites.push(chunk);
        return true;
      },
    },
  };

  bridge._started = true;
  bridge._proc = firstChild;
  bridge.connect({ connector: 'test-sdk-a' });
  bridge._onStdout(`${JSON.stringify({ type: 'ready', source: 'rust-sidecar' })}\n`);

  assert.equal(firstWrites.length, 1, 'ready must not replay a target already sent to this child');
  assert.deepEqual(JSON.parse(firstWrites[0]), { type: 'connect', aircraft: 'test-sdk-a' });

  const replacementWrites: string[] = [];
  bridge._proc = {
    killed: false,
    stdin: {
      destroyed: false,
      writableEnded: false,
      writable: true,
      write(chunk: string) {
        replacementWrites.push(chunk);
        return true;
      },
    },
  };
  bridge._onStdout(`${JSON.stringify({ type: 'ready', source: 'rust-sidecar' })}\n`);

  assert.equal(replacementWrites.length, 1, 'a replacement child must receive the retained target');
  assert.deepEqual(JSON.parse(replacementWrites[0]), { type: 'connect', aircraft: 'test-sdk-a' });
});

test('SdkBridge keeps a healthy snapshot when the same connect payload is repeated', () => {
  const adapter = sdkRegistry.getSdkAdapterById('clientdata-manifest');
  const bridge = new SdkBridge(adapter);
  const writes: string[] = [];
  bridge._started = true;
  bridge._proc = {
    killed: false,
    stdin: {
      destroyed: false,
      writableEnded: false,
      writable: true,
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
    },
  };

  bridge.connect({ connector: 'test-sdk-a' });
  bridge._onStdout(`${JSON.stringify({
    type: 'snapshot',
    values: { sdk_value: 737 },
    normalized: { automation: { ap: { engaged: true } } },
    timestampIso: '2026-07-18T23:18:49Z',
  })}\n`);
  const healthySnapshot = bridge.getSnapshot();

  bridge.connect({ id: 'test-sdk-a' });

  assert.equal(writes.length, 1, 'an equivalent payload must not be sent twice to the same child');
  assert.deepEqual(bridge.getSnapshot(), healthySnapshot, 'duplicate connect must not clear live SDK data');
});

test('SdkBridge sends changed targets and sends the same target to a replacement child', () => {
  const adapter = sdkRegistry.getSdkAdapterById('clientdata-manifest');
  const bridge = new SdkBridge(adapter);
  const firstWrites: string[] = [];
  bridge._started = true;
  bridge._proc = {
    killed: false,
    stdin: {
      destroyed: false,
      writableEnded: false,
      writable: true,
      write(chunk: string) {
        firstWrites.push(chunk);
        return true;
      },
    },
  };

  bridge.connect({ connector: 'test-sdk-a' });
  bridge.connect({ connector: 'test-sdk-b' });

  assert.deepEqual(firstWrites.map((chunk) => JSON.parse(chunk)), [
    { type: 'connect', aircraft: 'test-sdk-a' },
    { type: 'connect', aircraft: 'test-sdk-b' },
  ]);

  const replacementWrites: string[] = [];
  bridge._proc = {
    killed: false,
    stdin: {
      destroyed: false,
      writableEnded: false,
      writable: true,
      write(chunk: string) {
        replacementWrites.push(chunk);
        return true;
      },
    },
  };
  bridge.connect({ connector: 'test-sdk-b' });

  assert.equal(replacementWrites.length, 1, 'a replacement child must receive the current target');
  assert.deepEqual(JSON.parse(replacementWrites[0]), { type: 'connect', aircraft: 'test-sdk-b' });
});

test('SdkBridge start rejects and rolls back an asynchronous spawn error', async () => {
  const child = new FakeSdkChild(525290, false);
  await withPatchedSdkSpawn(() => {
    queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
    return child;
  }, async (FreshSdkBridge) => {
    const bridge = new FreshSdkBridge({ id: 'spawn-test', displayName: 'Spawn test SDK' });
    bridge._resolvedLaunchSpec = {
      command: 'missing-sdk-sidecar.exe',
      args: [],
      cleanupToken: 'missing-sdk-sidecar.exe',
      source: 'rust-sidecar',
    };
    bridge._cleanupStaleSidecarProcesses = () => {};
    bridge._writePidFile = () => {};
    bridge._clearPidFile = () => {};

    await assert.rejects(bridge.start(), /spawn ENOENT/);

    assert.equal(bridge._started, false);
    assert.equal(bridge._proc, null);
    assert.match(bridge.getSnapshot().error || '', /spawn failed: spawn ENOENT/);
  });
});

test('SdkBridge absorbs post-spawn process and stdio errors while retaining the child for stop', async () => {
  const child = new FakeSdkChild(525291, false);
  await withPatchedSdkSpawn(() => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }, async (FreshSdkBridge) => {
    const bridge = new FreshSdkBridge({ id: 'stdin-test', displayName: 'Stdin test SDK' });
    bridge._resolvedLaunchSpec = {
      command: 'fake-sdk-sidecar.exe',
      args: [],
      cleanupToken: 'fake-sdk-sidecar.exe',
      source: 'rust-sidecar',
    };
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

test('SdkBridge preserves its role flag and passes backend ownership identity to its child', () => {
  const adapter = sdkRegistry.getSdkAdapterById('clientdata-manifest');
  const bridge = new SdkBridge(adapter);
  assert.deepEqual(bridge._buildLaunchArgs(['--sdk-clientdata-bridge']), [
    '--sdk-clientdata-bridge',
    `--ff-owner-pid=${bridge._ownerIdentity.pid}`,
    `--ff-owner-token=${bridge._ownerIdentity.token}`,
  ]);
});

test('SDK ClientData launch accepts only explicit supported owner lifeline probe versions', () => {
  assert.equal(supportsRequiredOwnerLifeline(null), false);
  assert.equal(supportsRequiredOwnerLifeline({}), false);
  assert.equal(supportsRequiredOwnerLifeline({ ownerLifelineVersion: '1' }), false);
  assert.equal(supportsRequiredOwnerLifeline({ ownerLifelineVersion: 0 }), false);
  assert.equal(supportsRequiredOwnerLifeline({ ownerLifelineVersion: 1 }), true);
  assert.equal(supportsRequiredOwnerLifeline({ ownerLifelineVersion: 2 }), true);
});

test('SdkBridge clears unverified stale PID files without killing unrelated processes', () => {
  const adapter = sdkRegistry.getSdkAdapterById('clientdata-manifest');
  const bridge = new SdkBridge(adapter);

  withTempPidFile((pidFilePath) => {
    const stalePid = 525252;
    const userSid = 'S-1-5-21-5252';
    bridge._ownerIdentity = { ...bridge._ownerIdentity, userSid };
    bridge._pidFilePath = pidFilePath;
    bridge._readProcessCommandLine = () => 'C:\\Windows\\System32\\notepad.exe';
    bridge._readProcessMetadata = (pid) => ({
      pid,
      parentPid: 1,
      startToken: 'unrelated-start',
      startedAtMs: 1000,
      commandLine: 'C:\\Windows\\System32\\notepad.exe',
      userSid,
    });
    fs.writeFileSync(pidFilePath, String(stalePid), 'utf8');

    withPatchedProcessKill((calls) => {
      bridge._cleanupFromPidFile('C:\\ff\\ff-rust-simconnect-sidecar.exe');
      assert.deepEqual(calls, []);
    });

    assert.equal(fs.existsSync(pidFilePath), false);
  });
});

test('SdkBridge clears its own mismatched record but preserves another installation\'s', () => {
  const adapter = sdkRegistry.getSdkAdapterById('clientdata-manifest');
  const bridge = new SdkBridge(adapter);

  withTempPidFile((pidFilePath) => {
    const foreignPidFilePath = path.join(path.dirname(pidFilePath), 'sidecar-999-foreign.pid');
    const localChildPid = 525264;
    const childPid = 525262;
    const userSid = 'S-1-5-21-5252';
    bridge._ownerIdentity = { ...bridge._ownerIdentity, userSid };
    bridge._pidFilePath = pidFilePath;
    bridge._readProcessCommandLine = () => '"C:\\other-install\\ff-rust-simconnect-sidecar.exe" --sdk-clientdata-bridge';
    bridge._readProcessMetadata = (pid) => ({
      pid,
      parentPid: 525263,
      startToken: 'foreign-install-sdk-start',
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
      ownerPid: 525263,
      ownerToken: 'foreign-install-sdk-owner',
    });

    withPatchedProcessKill((calls) => {
      bridge._cleanupFromPidFile('C:\\current-install\\ff-rust-simconnect-sidecar.exe');
      assert.deepEqual(calls, []);
    });

    assert.equal(fs.existsSync(pidFilePath), false);
    assert.equal(fs.existsSync(foreignPidFilePath), true);
  });
});

test('SdkBridge does not kill SimVar bridge processes from PID-file cleanup', () => {
  const adapter = sdkRegistry.getSdkAdapterById('clientdata-manifest');
  const bridge = new SdkBridge(adapter);

  withTempPidFile((pidFilePath) => {
    const stalePid = 525253;
    const userSid = 'S-1-5-21-5252';
    bridge._ownerIdentity = { ...bridge._ownerIdentity, userSid };
    bridge._pidFilePath = pidFilePath;
    bridge._readProcessCommandLine = () => '"C:\\ff\\ff-rust-simconnect-sidecar.exe" --simvars-bridge';
    bridge._readProcessMetadata = (pid) => ({
      pid,
      parentPid: 1,
      startToken: 'simvar-start',
      startedAtMs: 1000,
      commandLine: 'simvar sidecar',
      userSid,
    });
    fs.writeFileSync(pidFilePath, String(stalePid), 'utf8');

    withPatchedProcessKill((calls) => {
      bridge._cleanupFromPidFile('C:\\ff\\ff-rust-simconnect-sidecar.exe');
      assert.deepEqual(calls, []);
    });

    assert.equal(fs.existsSync(pidFilePath), false);
  });
});

test('SdkBridge does not classify an unflagged LVAR sidecar as SDK-owned', () => {
  const adapter = sdkRegistry.getSdkAdapterById('clientdata-manifest');
  const bridge = new SdkBridge(adapter);
  const binary = 'C:\\ff\\ff-rust-simconnect-sidecar.exe';

  bridge._readProcessCommandLine = () => `"${binary}"`;
  assert.equal(bridge._isProcessOwnedByCleanupToken(525257, binary), false);
  bridge._readProcessCommandLine = () => `"${binary}" --simvars-bridge`;
  assert.equal(bridge._isProcessOwnedByCleanupToken(525257, binary), false);
  bridge._readProcessCommandLine = () => `"${binary}" --sdk-clientdata-bridge`;
  assert.equal(bridge._isProcessOwnedByCleanupToken(525257, binary), true);
});

test('SdkBridge protects a matching SDK sidecar owned by another live backend', () => {
  const adapter = sdkRegistry.getSdkAdapterById('clientdata-manifest');
  const bridge = new SdkBridge(adapter);

  withTempPidFile((pidFilePath) => {
    const childPid = 525258;
    const ownerPid = 525259;
    const ownerToken = 'foreign-sdk-owner';
    const userSid = 'S-1-5-21-5252';
    bridge._ownerIdentity = { ...bridge._ownerIdentity, userSid };
    bridge._pidFilePath = pidFilePath;
    bridge._readProcessCommandLine = () => `"C:\\ff\\ff-rust-simconnect-sidecar.exe" --sdk-clientdata-bridge --ff-owner-pid=${ownerPid} --ff-owner-token=${ownerToken}`;
    bridge._readProcessMetadata = (pid) => pid === ownerPid
      ? { pid, parentPid: 1, startToken: 'foreign-sdk-start', startedAtMs: 1000, commandLine: 'node other-backend', userSid }
      : { pid, parentPid: ownerPid, startToken: 'foreign-sdk-sidecar-start', startedAtMs: 2000, commandLine: 'sidecar', userSid };
    writeOwnedPidRecord(pidFilePath, {
      pid: childPid,
      ownerPid,
      ownerToken,
      ownerStartToken: 'foreign-sdk-start',
    });

    withPatchedProcessKill((calls) => {
      bridge._cleanupFromPidFile('C:\\ff\\ff-rust-simconnect-sidecar.exe');
      assert.deepEqual(calls, []);
    });

    assert.equal(fs.existsSync(pidFilePath), true);
  });
});

test('SdkBridge reaps a locally owned stale SDK child before restart', () => {
  const adapter = sdkRegistry.getSdkAdapterById('clientdata-manifest');
  const bridge = new SdkBridge(adapter);

  withTempPidFile((pidFilePath) => {
    const childPid = 525260;
    const userSid = 'S-1-5-21-5252';
    bridge._ownerIdentity = { ...bridge._ownerIdentity, userSid };
    bridge._pidFilePath = pidFilePath;
    bridge._readProcessCommandLine = () => `"C:\\ff\\ff-rust-simconnect-sidecar.exe" --sdk-clientdata-bridge --ff-owner-pid=${bridge._ownerIdentity.pid} --ff-owner-token=${bridge._ownerIdentity.token}`;
    bridge._readProcessMetadata = (pid) => ({
      pid,
      parentPid: bridge._ownerIdentity.pid,
      startToken: 'local-sdk-sidecar-start',
      startedAtMs: 2000,
      commandLine: 'sidecar',
      userSid,
    });
    writeOwnedPidRecord(pidFilePath, {
      pid: childPid,
      ownerPid: bridge._ownerIdentity.pid,
      ownerToken: bridge._ownerIdentity.token,
      ownerStartToken: bridge._ownerIdentity.startToken || 'local-start',
    });

    withPatchedProcessKill((calls) => {
      bridge._cleanupFromPidFile('C:\\ff\\ff-rust-simconnect-sidecar.exe');
      assert.deepEqual(calls, [
        { pid: childPid, signal: 0 },
        { pid: childPid, signal: 'SIGKILL' },
      ]);
    });

    assert.equal(fs.existsSync(pidFilePath), false);
  });
});

test('SdkBridge preserves a role-matched PID owned by another Windows user', () => {
  const adapter = sdkRegistry.getSdkAdapterById('clientdata-manifest');
  const bridge = new SdkBridge(adapter);

  withTempPidFile((pidFilePath) => {
    const childPid = 525261;
    bridge._ownerIdentity = { ...bridge._ownerIdentity, userSid: 'S-1-5-21-5252' };
    bridge._pidFilePath = pidFilePath;
    bridge._readProcessCommandLine = () => `"C:\\ff\\ff-rust-simconnect-sidecar.exe" --sdk-clientdata-bridge --ff-owner-pid=${bridge._ownerIdentity.pid} --ff-owner-token=${bridge._ownerIdentity.token}`;
    bridge._readProcessMetadata = (pid) => ({
      pid,
      parentPid: bridge._ownerIdentity.pid,
      startToken: 'cross-user-sdk-sidecar-start',
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
      bridge._cleanupFromPidFile('C:\\ff\\ff-rust-simconnect-sidecar.exe');
      assert.deepEqual(calls, []);
    });

    assert.equal(fs.existsSync(pidFilePath), true);
  });
});

test('SdkBridge command-line scan requires SDK role and disproved parent ownership', () => {
  const adapter = sdkRegistry.getSdkAdapterById('clientdata-manifest');
  const bridge = new SdkBridge(adapter);

  const script = bridge._buildCleanupScanScript('C:\\ff\\ff-rust-simconnect-sidecar.exe') || '';
  assert.match(script, /-match '\(\?i\)\(\^\|\\s\)--sdk-clientdata-bridge/);
  assert.match(script, /--simvars-bridge/);
  assert.match(script, /\$actualParentCouldOwn/);
  assert.match(script, /\$ownershipDisproved/);
  assert.match(script, /\$currentSid/);
  assert.match(script, /\$confirmedSid/);
});

test('SdkBridge stop waits for graceful exit without killing the child', async () => {
  const adapter = sdkRegistry.getSdkAdapterById('clientdata-manifest');
  const bridge = new SdkBridge(adapter);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-sdk-stop-test-'));
  try {
    const child = new FakeSdkChild(525254);
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

test('SdkBridge retains a child and PID record when forced shutdown cannot confirm exit', async () => {
  const adapter = sdkRegistry.getSdkAdapterById('clientdata-manifest');
  const bridge = new SdkBridge(adapter);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-sdk-stop-failure-test-'));
  try {
    const child = new FakeSdkChild(525257, false);
    bridge._pidFilePath = path.join(tempDir, 'sidecar.pid');
    bridge._proc = child;
    bridge._started = true;
    fs.writeFileSync(bridge._pidFilePath, String(child.pid), 'utf8');

    await assert.rejects(
      bridge.stop(),
      /SDK sidecar PID 525257 did not exit after forced shutdown/,
    );

    assert.equal(bridge._proc, child);
    assert.equal(bridge._started, true);
    assert.match(bridge.getSnapshot().error || '', /did not exit after forced shutdown/);
    assert.equal(fs.existsSync(bridge._pidFilePath), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('SdkBridge ignores exit events from a replaced child', () => {
  const adapter = sdkRegistry.getSdkAdapterById('clientdata-manifest');
  const bridge = new SdkBridge(adapter);

  withTempPidFile((pidFilePath) => {
    const staleChild = new FakeSdkChild(525255);
    const currentChild = new FakeSdkChild(525256);
    bridge._pidFilePath = pidFilePath;
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
