const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { EventEmitter } = require('node:events');
const {
  MOBIFLIGHT_MAX_CALCULATOR_CODE_LENGTH,
} = require('../utils/mobiflight-protocol.js') as typeof import('../utils/mobiflight-protocol.js');

const bridgePath = path.join(__dirname, 'lvar-sidecar-bridge.js');
const configPath = path.join(__dirname, '..', 'core', 'config.js');
require('./sidecar-process-ownership.js').getBackendOwnerIdentity();

type EnvPatch = Record<string, string | null | undefined>;
type ExistsSyncOverride = (candidate: string) => boolean;
type SpawnSyncOverride = (command: string, args: string[]) => { status: number; stdout: string; stderr: string };
type SpawnOverride = (...args: unknown[]) => unknown;
type ProcessMetadata = {
  pid: number;
  parentPid: number | null;
  startToken: string | null;
  startedAtMs: number | null;
  commandLine: string | null;
  userSid: string | null;
};
type LvarSidecarBridgeTestInstance = {
  isEnabled: () => boolean;
  getSnapshot: () => {
    source: string;
    error: string | null;
    snapshotSequence?: number;
    profileId?: string;
    values?: Record<string, unknown>;
    updatedAt?: string | null;
    mobiflight?: { state: string; connected: boolean; available: boolean; error: string | null; updatedAt?: string | null };
  };
  setSubscriptions: (subscriptions?: Array<Record<string, unknown>>, profileId?: string) => void;
  sendEvent: (eventName: string, value?: unknown, parameters?: unknown[]) => Promise<{ ok?: boolean; error?: string | null }>;
  sendSdkEvent: (eventName: string, value?: unknown) => Promise<{ ok?: boolean; error?: string | null }>;
  setNamedVar: (options?: Record<string, unknown>) => Promise<{ ok?: boolean; error?: string | null }>;
  executeMobiFlightCode: (code: string) => Promise<{ ok?: boolean; error?: string | null }>;
  findRecentSimConnectException: (
    sendIds: readonly number[],
    sinceMs: number,
  ) => { exception: number | null; sendId: number; index: number | null; receivedAtMs: number } | null;
  stop: () => Promise<void>;
  sendEyepointOffset: (options?: Record<string, unknown>) => void;
  start: () => Promise<void>;
  _resolveLaunchSpec: () => { provider: string; source: string } | null;
  _buildSidecarEnv: () => NodeJS.ProcessEnv;
  _buildLaunchArgs: (args?: string[]) => string[];
  _cleanupFromPidFile: (cleanupToken: string) => void;
  _pidFilePath: string;
  _lastBackendProbeError: string | null;
  _ownerIdentity: { pid: number; token: string; startToken: string | null; startedAtMs: number; userSid: string | null };
  _readProcessCommandLine: (pid: number) => string | null;
  _readProcessMetadata: (pid: number) => ProcessMetadata | null;
  _commandLineMatchesRole: (commandLine: string | null | undefined) => boolean;
  _buildCleanupScanScript: (cleanupToken: string) => string | null;
  _handleProcessExit: (child: any, code: number | null, signal: NodeJS.Signals | null) => void;
  _sendWithAck?: (...args: unknown[]) => Promise<{ ok?: boolean; error?: string | null }>;
  _onStdout: (chunk: Buffer | string) => void;
  _proc?: unknown;
  _started?: boolean;
};
type LvarSidecarBridgeCtor = new () => LvarSidecarBridgeTestInstance;
type KillCall = { pid: number; signal: string | number | undefined };

class FakeLvarChild extends EventEmitter {
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

async function withPatchedSpawnBridge(
  spawnOverride: SpawnOverride,
  run: (BridgeCtor: LvarSidecarBridgeCtor) => Promise<void>,
): Promise<void> {
  const childProcess = require('child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = spawnOverride;
  delete require.cache[require.resolve(bridgePath)];
  try {
    const { LvarSidecarBridge } = require(bridgePath) as { LvarSidecarBridge: LvarSidecarBridgeCtor };
    await run(LvarSidecarBridge);
  } finally {
    delete require.cache[require.resolve(bridgePath)];
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-lvar-pid-test-'));
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

function withPatchedBridge(
  { env = {}, existsSync, spawnSync }: {
    env?: EnvPatch;
    existsSync?: ExistsSyncOverride;
    spawnSync?: SpawnSyncOverride;
  },
  run: (BridgeCtor: LvarSidecarBridgeCtor) => void,
): void {
  const fs = require('fs');
  const childProcess = require('child_process');
  const originalExistsSync = fs.existsSync;
  const originalSpawnSync = childProcess.spawnSync;
  const previousEnv = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(env)) {
    previousEnv.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  fs.existsSync = existsSync || fs.existsSync;
  childProcess.spawnSync = spawnSync || childProcess.spawnSync;

  delete require.cache[require.resolve(configPath)];
  delete require.cache[require.resolve(bridgePath)];

  try {
    const { LvarSidecarBridge } = require(bridgePath) as { LvarSidecarBridge: LvarSidecarBridgeCtor };
    return run(LvarSidecarBridge);
  } finally {
    delete require.cache[require.resolve(configPath)];
    delete require.cache[require.resolve(bridgePath)];
    fs.existsSync = originalExistsSync;
    childProcess.spawnSync = originalSpawnSync;
    for (const [key, value] of previousEnv.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('LvarSidecarBridge auto mode prefers Rust sidecar when probe succeeds', () => {
  const rustBinary = 'C:\\ff\\ff-rust-simconnect-sidecar.exe';
  const spawnCalls = [];

  withPatchedBridge({
    env: {
      LVAR_SIDECAR_AUTO_ENABLE: 'true',
      SIMCONNECT_PROVIDER: 'auto',
      LVAR_SIDECAR_BINARY: rustBinary,
    },
    existsSync: (candidate) => candidate === rustBinary,
    spawnSync: (command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      assert.equal(command, rustBinary);
      assert.deepEqual(args, ['--probe']);
      return {
        status: 0,
        stdout: JSON.stringify({
          type: 'probe',
          ok: true,
          source: 'rust-sidecar',
          backend: 'rust',
          ownerLifelineVersion: 1,
        }),
        stderr: '',
      };
    },
  }, (LvarSidecarBridge) => {
    const bridge = new LvarSidecarBridge();
    assert.equal(bridge.isEnabled(), true);
    assert.equal(bridge.getSnapshot().source, 'rust-sidecar');
  });

  assert.equal(spawnCalls.filter((call) => call.command === rustBinary).length, 1);
});

test('LvarSidecarBridge rejects an otherwise successful legacy probe without owner lifeline capability', () => {
  const rustBinary = 'C:\\ff\\ff-rust-simconnect-sidecar.exe';

  withPatchedBridge({
    env: {
      LVAR_SIDECAR_AUTO_ENABLE: 'true',
      SIMCONNECT_PROVIDER: 'auto',
      LVAR_SIDECAR_BINARY: rustBinary,
    },
    existsSync: (candidate) => candidate === rustBinary,
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({ type: 'probe', ok: true, source: 'rust-sidecar', backend: 'rust' }),
      stderr: '',
    }),
  }, (LvarSidecarBridge) => {
    const bridge = new LvarSidecarBridge();
    assert.equal(bridge.isEnabled(), false);
    assert.match(bridge._lastBackendProbeError || '', /ownerLifelineVersion >= 1/);
  });
});

test('LvarSidecarBridge start rejects and rolls back an asynchronous spawn error', async () => {
  const child = new FakeLvarChild(424290, false);
  await withPatchedSpawnBridge(() => {
    queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
    return child;
  }, async (LvarSidecarBridge) => {
    const bridge = new LvarSidecarBridge();
    bridge.isEnabled = () => true;
    (bridge as any)._resolvedLaunchSpec = {
      command: 'missing-lvar-sidecar.exe',
      args: [],
      cleanupToken: 'missing-lvar-sidecar.exe',
      provider: 'rust',
      source: 'rust-sidecar',
    };
    (bridge as any)._cleanupStaleSidecarProcesses = () => {};
    (bridge as any)._writePidFile = () => {};
    (bridge as any)._clearPidFile = () => {};

    await assert.rejects(bridge.start(), /spawn ENOENT/);

    assert.equal(bridge._started, false);
    assert.equal(bridge._proc, null);
    assert.match(bridge.getSnapshot().error || '', /spawn failed: spawn ENOENT/);
  });
});

test('LvarSidecarBridge absorbs post-spawn process and stdio errors while retaining the child for stop', async () => {
  const child = new FakeLvarChild(424291, false);
  await withPatchedSpawnBridge(() => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }, async (LvarSidecarBridge) => {
    const bridge = new LvarSidecarBridge();
    bridge.isEnabled = () => true;
    (bridge as any)._resolvedLaunchSpec = {
      command: 'fake-lvar-sidecar.exe',
      args: [],
      cleanupToken: 'fake-lvar-sidecar.exe',
      provider: 'rust',
      source: 'rust-sidecar',
    };
    (bridge as any)._cleanupStaleSidecarProcesses = () => {};
    (bridge as any)._writePidFile = () => {};
    (bridge as any)._clearPidFile = () => {};

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
    (bridge as any)._send({ type: 'test' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(bridge._proc, child, 'transport error must not abandon a potentially live process');
    assert.equal(bridge._started, true);
    assert.match(bridge.getSnapshot().error || '', /stdin error: write EPIPE/);
    child.finish(0, null);
  });
});

test('LvarSidecarBridge auto mode does not fall back when Rust probe fails', () => {
  const rustBinary = 'C:\\ff\\ff-rust-simconnect-sidecar.exe';
  const spawnCalls = [];

  withPatchedBridge({
    env: {
      LVAR_SIDECAR_AUTO_ENABLE: 'true',
      SIMCONNECT_PROVIDER: 'auto',
      LVAR_SIDECAR_BINARY: rustBinary,
    },
    existsSync: (candidate) => candidate === rustBinary,
    spawnSync: (command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      if (command === rustBinary) {
        assert.deepEqual(args, ['--probe']);
        return {
          status: 2,
          stdout: JSON.stringify({ type: 'probe', ok: false, error: 'rust probe failed' }),
          stderr: '',
        };
      }
      throw new Error(`Unexpected spawnSync call: ${command} ${args.join(' ')}`);
    },
  }, (LvarSidecarBridge) => {
    const bridge = new LvarSidecarBridge();
    assert.equal(bridge.isEnabled(), false);
  });

  assert.deepEqual(
    spawnCalls.map((call) => [call.command, call.args[0]]),
    [[rustBinary, '--probe']]
  );
});

test('LvarSidecarBridge rejects custom sidecar binary paths with unexpected basenames', () => {
  const unsafeBinary = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const spawnCalls = [];

  withPatchedBridge({
    env: {
      LVAR_SIDECAR_AUTO_ENABLE: 'true',
      SIMCONNECT_PROVIDER: 'auto',
      LVAR_SIDECAR_BINARY: unsafeBinary,
    },
    existsSync: (candidate) => candidate === unsafeBinary,
    spawnSync: (command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      throw new Error(`Unexpected spawnSync call: ${command} ${args.join(' ')}`);
    },
  }, (LvarSidecarBridge) => {
    const bridge = new LvarSidecarBridge();
    assert.equal(bridge.isEnabled(), false);
  });

  assert.equal(spawnCalls.length, 0);
});

test('LvarSidecarBridge explicit Rust mode stays disabled when no binary is present', () => {
  withPatchedBridge({
    env: {
      LVAR_SIDECAR_AUTO_ENABLE: 'true',
      SIMCONNECT_PROVIDER: 'rust',
      LVAR_SIDECAR_BINARY: 'C:\\ff\\missing-rust-sidecar.exe',
    },
    existsSync: () => false,
    spawnSync: (): { status: number; stdout: string; stderr: string } => {
      throw new Error('spawnSync should not be called when the Rust binary is missing');
    },
  }, (LvarSidecarBridge) => {
    const bridge = new LvarSidecarBridge();
    assert.equal(bridge.isEnabled(), false);
    assert.match(bridge.getSnapshot().error || '', /^$/);
  });
});

test('LvarSidecarBridge clears unverified stale PID files without killing unrelated processes', () => {
  withPatchedBridge({}, (LvarSidecarBridge) => {
    withTempPidFile((pidFilePath) => {
      const bridge = new LvarSidecarBridge();
      const stalePid = 424242;
      const userSid = 'S-1-5-21-4242';
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
});

test('LvarSidecarBridge kills a role-matched PID only when its owner start identity is stale', () => {
  withPatchedBridge({}, (LvarSidecarBridge) => {
    withTempPidFile((pidFilePath) => {
      const bridge = new LvarSidecarBridge();
      const stalePid = 424243;
      const ownerPid = 424240;
      const ownerToken = 'stale-owner';
      const userSid = 'S-1-5-21-4242';
      bridge._ownerIdentity = { ...bridge._ownerIdentity, userSid };
      bridge._pidFilePath = pidFilePath;
      bridge._readProcessCommandLine = () => `"C:\\ff\\ff-rust-simconnect-sidecar.exe" --ff-owner-pid=${ownerPid} --ff-owner-token=${ownerToken}`;
      bridge._readProcessMetadata = (pid) => pid === ownerPid
        ? { pid, parentPid: 1, startToken: 'reused-owner-start', startedAtMs: 9000, commandLine: 'node backend', userSid }
        : { pid, parentPid: ownerPid, startToken: 'sidecar-start', startedAtMs: 2000, commandLine: 'sidecar', userSid };
      writeOwnedPidRecord(pidFilePath, { pid: stalePid, ownerPid, ownerToken });

      withPatchedProcessKill((calls) => {
        bridge._cleanupFromPidFile('C:\\ff\\ff-rust-simconnect-sidecar.exe');
        assert.deepEqual(calls, [
          { pid: stalePid, signal: 0 },
          { pid: stalePid, signal: 'SIGKILL' },
        ]);
      });

      assert.equal(fs.existsSync(pidFilePath), false);
    });
  });
});

test('LvarSidecarBridge passes backend ownership identity to its child', () => {
  withPatchedBridge({}, (LvarSidecarBridge) => {
    const bridge = new LvarSidecarBridge();
    assert.deepEqual(bridge._buildLaunchArgs(), [
      `--ff-owner-pid=${bridge._ownerIdentity.pid}`,
      `--ff-owner-token=${bridge._ownerIdentity.token}`,
    ]);
  });
});

test('LvarSidecarBridge protects a matching sidecar owned by another live backend', () => {
  withPatchedBridge({}, (LvarSidecarBridge) => {
    withTempPidFile((pidFilePath) => {
      const bridge = new LvarSidecarBridge();
      const foreignChildPid = 424247;
      const foreignOwnerPid = 424248;
      const foreignOwnerToken = 'foreign-live-owner';
      const userSid = 'S-1-5-21-4242';
      bridge._ownerIdentity = { ...bridge._ownerIdentity, userSid };
      bridge._pidFilePath = pidFilePath;
      bridge._readProcessCommandLine = () => `"C:\\ff\\ff-rust-simconnect-sidecar.exe" --ff-owner-pid=${foreignOwnerPid} --ff-owner-token=${foreignOwnerToken}`;
      bridge._readProcessMetadata = (pid) => pid === foreignOwnerPid
        ? { pid, parentPid: 1, startToken: 'foreign-start', startedAtMs: 1000, commandLine: 'node other-backend', userSid }
        : { pid, parentPid: foreignOwnerPid, startToken: 'foreign-sidecar-start', startedAtMs: 2000, commandLine: 'sidecar', userSid };
      writeOwnedPidRecord(pidFilePath, {
        pid: foreignChildPid,
        ownerPid: foreignOwnerPid,
        ownerToken: foreignOwnerToken,
        ownerStartToken: 'foreign-start',
      });

      withPatchedProcessKill((calls) => {
        bridge._cleanupFromPidFile('C:\\ff\\ff-rust-simconnect-sidecar.exe');
        assert.deepEqual(calls, []);
      });

      assert.equal(fs.existsSync(pidFilePath), true);
      assert.notEqual(bridge._ownerIdentity.token, foreignOwnerToken);
    });
  });
});

test('LvarSidecarBridge preserves a role-matched PID owned by another Windows user', () => {
  withPatchedBridge({}, (LvarSidecarBridge) => {
    withTempPidFile((pidFilePath) => {
      const bridge = new LvarSidecarBridge();
      const childPid = 424249;
      bridge._ownerIdentity = { ...bridge._ownerIdentity, userSid: 'S-1-5-21-4242' };
      bridge._pidFilePath = pidFilePath;
      bridge._readProcessCommandLine = () => `"C:\\ff\\ff-rust-simconnect-sidecar.exe" --ff-owner-pid=${bridge._ownerIdentity.pid} --ff-owner-token=${bridge._ownerIdentity.token}`;
      bridge._readProcessMetadata = (pid) => ({
        pid,
        parentPid: bridge._ownerIdentity.pid,
        startToken: 'cross-user-sidecar-start',
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
});

test('LvarSidecarBridge command-line scan excludes sibling roles and requires disproved parent ownership', () => {
  withPatchedBridge({}, (LvarSidecarBridge) => {
    const bridge = new LvarSidecarBridge();

    const script = bridge._buildCleanupScanScript('C:\\ff\\ff-rust-simconnect-sidecar.exe') || '';
    assert.match(script, /--simvars-bridge/);
    assert.match(script, /--sdk-clientdata-bridge/);
    assert.match(script, /\$actualParentCouldOwn/);
    assert.match(script, /\$declaredOwnerCouldOwn/);
    assert.match(script, /\$ownershipDisproved/);
    assert.match(script, /\$currentSid/);
    assert.match(script, /\$confirmedSid/);
  });
});

test('LvarSidecarBridge stop waits for graceful exit without killing the child', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-lvar-stop-test-'));
  let bridge: LvarSidecarBridgeTestInstance | null = null;
  try {
    withPatchedBridge({}, (LvarSidecarBridge) => {
      bridge = new LvarSidecarBridge();
    });
    const child = new FakeLvarChild(424244);
    bridge!._pidFilePath = path.join(tempDir, 'sidecar.pid');
    bridge!._proc = child;
    bridge!._started = true;
    fs.writeFileSync(bridge!._pidFilePath, String(child.pid), 'utf8');
    child.on('exit', (code, signal) => bridge!._handleProcessExit(child, code, signal));

    await bridge!.stop();

    assert.deepEqual(child.killCalls, []);
    assert.equal(bridge!._proc, null);
    assert.equal(bridge!.getSnapshot().error, null);
    assert.equal(fs.existsSync(bridge!._pidFilePath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('LvarSidecarBridge retains a child and PID record when forced shutdown cannot confirm exit', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-lvar-stop-failure-test-'));
  let bridge: LvarSidecarBridgeTestInstance | null = null;
  try {
    withPatchedBridge({}, (LvarSidecarBridge) => {
      bridge = new LvarSidecarBridge();
    });
    const child = new FakeLvarChild(424247, false);
    bridge!._pidFilePath = path.join(tempDir, 'sidecar.pid');
    bridge!._proc = child;
    bridge!._started = true;
    fs.writeFileSync(bridge!._pidFilePath, String(child.pid), 'utf8');

    await assert.rejects(
      bridge!.stop(),
      /LVAR sidecar PID 424247 did not exit after forced shutdown/,
    );

    assert.equal(bridge!._proc, child);
    assert.equal(bridge!._started, true);
    assert.match(bridge!.getSnapshot().error || '', /did not exit after forced shutdown/);
    assert.equal(fs.existsSync(bridge!._pidFilePath), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('LvarSidecarBridge ignores exit events from a replaced child', () => {
  withPatchedBridge({}, (LvarSidecarBridge) => {
    withTempPidFile((pidFilePath) => {
      const bridge = new LvarSidecarBridge();
      const staleChild = new FakeLvarChild(424245);
      const currentChild = new FakeLvarChild(424246);
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
});

test('LvarSidecarBridge rejects invalid control payloads before sidecar stdin', async () => {
  let namedVarAck: { ok?: boolean; error?: string | null } | null = null;
  let eventAck: { ok?: boolean; error?: string | null } | null = null;
  let sidecarCalls = 0;

  withPatchedBridge({}, (LvarSidecarBridge) => {
    const bridge = new LvarSidecarBridge();
    bridge._sendWithAck = async () => {
      sidecarCalls += 1;
      return { ok: true };
    };

    namedVarAck = bridge.setNamedVar({
      name: 'L:BAD;Remove-Item',
      unit: 'Number',
      value: 1,
      dataType: 'float64',
    }) as any;
    eventAck = bridge.sendEvent('AP_ALT_VAR_SET_ENGLISH', Number.POSITIVE_INFINITY) as any;
  });

  namedVarAck = await namedVarAck as any;
  eventAck = await eventAck as any;
  assert.equal(namedVarAck?.ok, false);
  assert.equal(namedVarAck?.error, 'invalid_payload');
  assert.equal(eventAck?.ok, false);
  assert.equal(eventAck?.error, 'invalid_payload');
  assert.equal(sidecarCalls, 0);
});

test('LvarSidecarBridge gives SDK DWORD payloads a narrow event-only path', async () => {
  const calls = [];
  let results = [];
  withPatchedBridge({}, (LvarSidecarBridge) => {
    const bridge = new LvarSidecarBridge();
    bridge._sendWithAck = async (message, ackType) => {
      calls.push({ message, ackType });
      return { ok: true };
    };
    results = [
      bridge.sendEvent('#12345', 0x20000000),
      bridge.sendSdkEvent('AP_MASTER', 1),
      bridge.sendSdkEvent('#12345', -1),
      bridge.sendSdkEvent('#12345', 1.5),
      bridge.sendSdkEvent('#12345', 0x20000000),
    ];
  });
  const acknowledgements = await Promise.all(results);
  assert.equal(acknowledgements[0].ok, false, 'generic events retain their smaller ceiling');
  assert.equal(acknowledgements[1].ok, false, 'SDK path rejects non-numeric event names');
  assert.equal(acknowledgements[2].ok, false, 'SDK path rejects signed payloads');
  assert.equal(acknowledgements[3].ok, false, 'SDK path rejects fractional payloads');
  assert.equal(acknowledgements[4].ok, true, 'bounded unsigned SDK payload should pass');
  assert.deepEqual(calls, [{
    message: { type: 'sendSdkEvent', name: '#12345', value: 0x20000000 },
    ackType: 'sendSdkEventAck',
  }]);
});

test('LvarSidecarBridge sends bounded multi-parameter generic events only', async () => {
  const calls = [];
  let results = [];
  withPatchedBridge({}, (LvarSidecarBridge) => {
    const bridge = new LvarSidecarBridge();
    bridge._sendWithAck = async (message, ackType) => {
      calls.push({ message, ackType });
      return { ok: true };
    };
    results = [
      bridge.sendEvent('HEADING_BUG_SET', 275, [0]),
      bridge.sendEvent('HEADING_BUG_SET', 275, [0, 1, 2, 3, 4]),
      bridge.sendEvent('HEADING_BUG_SET', 275, [Number.NaN]),
    ];
  });

  const acknowledgements = await Promise.all(results);
  assert.equal(acknowledgements[0].ok, true, 'a bounded second event parameter should pass');
  assert.equal(acknowledgements[1].ok, false, 'more than four additional parameters should fail closed');
  assert.equal(acknowledgements[2].ok, false, 'non-finite additional parameters should fail closed');
  assert.deepEqual(calls, [{
    message: { type: 'sendEvent', name: 'HEADING_BUG_SET', value: 275, parameters: [0] },
    ackType: 'sendEventAck',
  }]);
});

test('LvarSidecarBridge clears its own mismatched record but preserves another installation\'s', () => {
  withPatchedBridge({}, (LvarSidecarBridge) => {
    withTempPidFile((pidFilePath) => {
      const bridge = new LvarSidecarBridge();
      const foreignPidFilePath = path.join(path.dirname(pidFilePath), 'sidecar-999-foreign.pid');
      const localChildPid = 424252;
      const childPid = 424250;
      const userSid = 'S-1-5-21-4242';
      bridge._ownerIdentity = { ...bridge._ownerIdentity, userSid };
      bridge._pidFilePath = pidFilePath;
      bridge._readProcessCommandLine = () => '"C:\\other-install\\ff-rust-simconnect-sidecar.exe"';
      bridge._readProcessMetadata = (pid) => ({
        pid,
        parentPid: 424251,
        startToken: 'foreign-install-sidecar-start',
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
        ownerPid: 424251,
        ownerToken: 'foreign-install-owner',
      });

      withPatchedProcessKill((calls) => {
        bridge._cleanupFromPidFile('C:\\current-install\\ff-rust-simconnect-sidecar.exe');
        assert.deepEqual(calls, []);
      });

      assert.equal(fs.existsSync(pidFilePath), false);
      assert.equal(fs.existsSync(foreignPidFilePath), true);
    });
  });
});

test('LvarSidecarBridge retains bounded SimConnect exceptions for exact packet correlation', () => {
  withPatchedBridge({}, (LvarSidecarBridge) => {
    const bridge = new LvarSidecarBridge();
    const beforeExceptionMs = Date.now();
    bridge._onStdout(`${JSON.stringify({
      type: 'exception',
      exception: 3,
      sendId: 4242,
      index: 7,
    })}\n`);

    assert.deepEqual(
      bridge.findRecentSimConnectException([4242], beforeExceptionMs),
      {
        exception: 3,
        sendId: 4242,
        index: 7,
        receivedAtMs: bridge.findRecentSimConnectException([4242], beforeExceptionMs)?.receivedAtMs,
      },
      'an exception can be matched to the acknowledged SimConnect packet',
    );
    assert.equal(
      bridge.findRecentSimConnectException([9999], beforeExceptionMs),
      null,
      'an unrelated packet cannot be attributed to the command',
    );
  });
});

test('LvarSidecarBridge refuses unsafe eyepoint offsets before writing to stdin', () => {
  withPatchedBridge({}, (LvarSidecarBridge) => {
    const bridge = new LvarSidecarBridge();
    let writes = 0;
    bridge._started = true;
    bridge._proc = {
      killed: false,
      stdin: {
        write() {
          writes += 1;
        },
      },
    };

    bridge.sendEyepointOffset({ x: 99, y: 0, z: 0, units: 'Meters' });
    assert.equal(writes, 0);

    bridge.sendEyepointOffset({ x: 1, y: 0, z: 0, units: 'Meters' });
    assert.equal(writes, 1);
  });
});

test('LvarSidecarBridge tracks MobiFlight health and uses the bounded ACK command contract', async () => {
  let commandPromise: Promise<{ ok?: boolean; error?: string | null }> | null = null;
  let capturedMessage: Record<string, unknown> | null = null;
  let capturedAckType: unknown = null;

  withPatchedBridge({}, (LvarSidecarBridge) => {
    const bridge = new LvarSidecarBridge();
    bridge._onStdout(`${JSON.stringify({
      type: 'mobiflightStatus',
      state: 'connected',
      connected: true,
      available: true,
    })}\n`);
    assert.deepEqual(bridge.getSnapshot().mobiflight, {
      state: 'connected',
      connected: true,
      available: true,
      error: null,
      updatedAt: bridge.getSnapshot().mobiflight?.updatedAt,
    });
    bridge._onStdout(`${JSON.stringify({ type: 'snapshot', values: { light_taxi: 0 }, timestampIso: new Date().toISOString() })}\n`);
    bridge._onStdout(`${JSON.stringify({ type: 'snapshot', values: { light_taxi: 100 }, timestampIso: new Date().toISOString() })}\n`);
    assert.equal(bridge.getSnapshot().snapshotSequence, 2);

    bridge._sendWithAck = async (message: unknown, ackType: unknown) => {
      capturedMessage = message as Record<string, unknown>;
      capturedAckType = ackType;
      return { ok: true };
    };
    commandPromise = bridge.executeMobiFlightCode(
      '0 (L:switch_117_73X, number) == if{ 11701 (>K:ROTOR_BRAKE) }',
    );
  });

  const ack = await commandPromise;
  assert.equal(ack?.ok, true);
  assert.deepEqual(capturedMessage, {
    type: 'executeMobiFlightCode',
    code: '0 (L:switch_117_73X, number) == if{ 11701 (>K:ROTOR_BRAKE) }',
  });
  assert.equal(capturedAckType, 'executeMobiFlightCodeAck');
});

test('LvarSidecarBridge accepts snapshots only for the latest overlapping subscription generation', () => {
  withPatchedBridge({}, (LvarSidecarBridge) => {
    const bridge = new LvarSidecarBridge();
    const oldTimestamp = '2026-07-14T00:00:00.000Z';
    const newTimestamp = '2026-07-14T00:00:01.000Z';
    const writes: Array<Record<string, unknown>> = [];
    bridge.isEnabled = () => true;
    bridge._started = true;
    bridge._proc = {
      killed: false,
      stdin: {
        write(line: string) {
          writes.push(JSON.parse(line));
        },
      },
    };

    bridge._onStdout(`${JSON.stringify({
      type: 'snapshot',
      values: { old_taxi_light: 100 },
      timestampIso: oldTimestamp,
    })}\n`);
    assert.deepEqual(bridge.getSnapshot().values, { old_taxi_light: 100 });
    assert.equal(bridge.getSnapshot().updatedAt, oldTimestamp);

    bridge.setSubscriptions([
      { key: 'intermediate_test_value', expression: '(L:TEST_VALUE)', unit: 'Number' },
    ], 'msfs-test-aircraft-intermediate');
    bridge.setSubscriptions([
      { key: 'new_test_value', expression: '(L:TEST_VALUE)', unit: 'Number' },
    ], 'msfs-test-aircraft');
    assert.equal(bridge.getSnapshot().profileId, 'msfs-test-aircraft');
    assert.deepEqual(bridge.getSnapshot().values, {});
    assert.equal(bridge.getSnapshot().updatedAt, null);
    assert.deepEqual(writes.map((message) => message.subscriptionGeneration), [1, 2]);

    // Generation 1 belongs to the superseded request. Its confirmation and
    // snapshot must remain blocked after generation 2 has been requested.
    bridge._onStdout(`${JSON.stringify({
      type: 'status',
      state: 'subscriptions_updated',
      subscriptionGeneration: 1,
    })}\n`);
    bridge._onStdout(`${JSON.stringify({
      type: 'snapshot',
      values: { intermediate_taxi_light: 0 },
      timestampIso: oldTimestamp,
      subscriptionGeneration: 1,
    })}\n`);
    assert.deepEqual(bridge.getSnapshot().values, {});
    assert.equal(bridge.getSnapshot().updatedAt, null);

    bridge._onStdout(`${JSON.stringify({
      type: 'status',
      state: 'subscriptions_updated',
      subscriptionGeneration: 2,
    })}\n`);
    bridge._onStdout(`${JSON.stringify({
      type: 'snapshot',
      values: { new_taxi_light: 0 },
      timestampIso: newTimestamp,
      subscriptionGeneration: 2,
    })}\n`);
    assert.deepEqual(bridge.getSnapshot().values, { new_taxi_light: 0 });
    assert.equal(bridge.getSnapshot().updatedAt, newTimestamp);
    assert.equal(bridge.getSnapshot().snapshotSequence, 2);
  });
});

test('LvarSidecarBridge recovers when disconnected subscription changes coalesce to one latest confirmation', () => {
  withPatchedBridge({}, (LvarSidecarBridge) => {
    const bridge = new LvarSidecarBridge();
    bridge.isEnabled = () => true;
    bridge._started = true;
    bridge._proc = {
      killed: false,
      stdin: { write() {} },
    };

    bridge.setSubscriptions([{ key: 'first', expression: '(L:FIRST)', unit: 'Number' }], 'first');
    bridge.setSubscriptions([{ key: 'latest', expression: '(L:LATEST)', unit: 'Number' }], 'latest');
    bridge._onStdout(`${JSON.stringify({ type: 'status', state: 'connecting', subscriptionGeneration: 1 })}\n`);
    bridge._onStdout(`${JSON.stringify({ type: 'status', state: 'connecting', subscriptionGeneration: 2 })}\n`);

    // A reconnect applies only the latest stored set, so one generation-2
    // confirmation is sufficient even though two changes were requested.
    bridge._onStdout(`${JSON.stringify({
      type: 'status',
      state: 'subscriptions_updated',
      subscriptionGeneration: 2,
    })}\n`);
    bridge._onStdout(`${JSON.stringify({
      type: 'snapshot',
      values: { latest: 50 },
      timestampIso: '2026-07-14T00:00:02.000Z',
      subscriptionGeneration: 2,
    })}\n`);

    assert.deepEqual(bridge.getSnapshot().values, { latest: 50 });
    assert.equal(bridge.getSnapshot().updatedAt, '2026-07-14T00:00:02.000Z');
  });
});

test('LvarSidecarBridge enforces the MobiFlight wire envelope before sidecar stdin', async () => {
  let commandPromises: Array<Promise<{ ok?: boolean; error?: string | null }>> = [];
  let sidecarCalls = 0;
  withPatchedBridge({}, (LvarSidecarBridge) => {
    const bridge = new LvarSidecarBridge();
    bridge._sendWithAck = async () => {
      sidecarCalls += 1;
      return { ok: true };
    };
    commandPromises = [
      bridge.executeMobiFlightCode('X'.repeat(MOBIFLIGHT_MAX_CALCULATOR_CODE_LENGTH)),
      bridge.executeMobiFlightCode('X'.repeat(MOBIFLIGHT_MAX_CALCULATOR_CODE_LENGTH + 1)),
      bridge.executeMobiFlightCode('1\n2'),
      bridge.executeMobiFlightCode(`1 (>K:ROTOR_BRAKE)\u0000`),
    ];
  });
  const acks = await Promise.all(commandPromises);
  assert.equal(acks[0]?.ok, true);
  for (const ack of acks.slice(1)) {
    assert.equal(ack?.ok, false);
    assert.equal(ack?.error, 'invalid_payload');
  }
  assert.equal(sidecarCalls, 1);
});

export {};
