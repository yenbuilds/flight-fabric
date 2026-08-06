const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const {
  resolveWindowsTaskkillPath,
  stopSidecarProcess,
} = require('./sidecar-process-shutdown.js');

class FakeSidecarChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  writes: string[] = [];
  killCalls: Array<NodeJS.Signals | number | undefined> = [];
  exitOnStop: boolean;
  exitOnKill: boolean;
  emitWriteError: boolean;
  emitWriteErrorAfterExit: boolean;
  stdin: import('node:events').EventEmitter & {
    destroyed: boolean;
    writableEnded: boolean;
    writable: boolean;
    write: (chunk: string) => boolean;
  };

  constructor({
    exitOnStop = false,
    exitOnKill = false,
    emitWriteError = false,
    emitWriteErrorAfterExit = false,
  } = {}) {
    super();
    this.exitOnStop = exitOnStop;
    this.exitOnKill = exitOnKill;
    this.emitWriteError = emitWriteError;
    this.emitWriteErrorAfterExit = emitWriteErrorAfterExit;
    const stdin = new EventEmitter() as FakeSidecarChild['stdin'];
    stdin.destroyed = false;
    stdin.writableEnded = false;
    stdin.writable = true;
    stdin.write = (chunk: string): boolean => {
      this.writes.push(chunk);
      if (this.exitOnStop) queueMicrotask(() => this.finish(0, null));
      if (this.emitWriteError) {
        const emitError = (): void => {
          stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
        };
        if (this.emitWriteErrorAfterExit) setImmediate(emitError);
        else queueMicrotask(emitError);
      }
      return true;
    };
    this.stdin = stdin;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killCalls.push(signal);
    if (this.exitOnKill) {
      queueMicrotask(() => this.finish(null, signal as NodeJS.Signals));
    }
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

test('stopSidecarProcess waits for the stop command to exit before killing', async () => {
  const child = new FakeSidecarChild({ exitOnStop: true });

  const result = await stopSidecarProcess(child, {
    gracefulTimeoutMs: 50,
    forceKillTimeoutMs: 20,
  });

  assert.deepEqual(child.writes, [`${JSON.stringify({ type: 'stop' })}\n`]);
  assert.deepEqual(child.killCalls, []);
  assert.deepEqual(result, { exited: true, forceKillAttempted: false });
});

test('stopSidecarProcess force kills a child that ignores graceful shutdown', async () => {
  const child = new FakeSidecarChild({ exitOnKill: true });

  const result = await stopSidecarProcess(child, {
    gracefulTimeoutMs: 5,
    forceKillTimeoutMs: 50,
  });

  assert.deepEqual(child.killCalls, ['SIGKILL']);
  assert.deepEqual(result, { exited: true, forceKillAttempted: true });
});

test('Windows force stop terminates the complete spawned sidecar process tree', async () => {
  const child = new FakeSidecarChild();
  (child as any).pid = 626270;
  (child as any).spawnfile = 'C:\\ff\\ff-rust-simconnect-sidecar.exe';
  const calls: Array<{ command: string; args: string[]; timeout?: number }> = [];

  const result = await stopSidecarProcess(child as any, {
    gracefulTimeoutMs: 5,
    forceKillTimeoutMs: 50,
    treeKillRunner: (command: string, args: string[], options: { timeout?: number }) => {
      calls.push({ command, args, timeout: options.timeout });
      queueMicrotask(() => child.finish(null, 'SIGKILL'));
      return { status: 0 };
    },
  });

  assert.equal(calls.length, process.platform === 'win32' ? 1 : 0);
  if (process.platform === 'win32') {
    assert.match(calls[0].command, /(?:^|[\\/])taskkill\.exe$/i);
    assert.deepEqual(calls[0].args, ['/PID', '626270', '/T', '/F']);
    assert.ok((calls[0].timeout || 0) > 0);
    assert.deepEqual(child.killCalls, []);
  } else {
    assert.deepEqual(child.killCalls, ['SIGKILL']);
  }
  assert.deepEqual(result, { exited: true, forceKillAttempted: true });
});

test('Windows taskkill path uses the absolute system executable when available', () => {
  assert.equal(
    resolveWindowsTaskkillPath({ SystemRoot: 'C:\\Windows' }),
    'C:\\Windows\\System32\\taskkill.exe',
  );
  assert.equal(
    resolveWindowsTaskkillPath({ WINDIR: 'D:\\WinRoot' }),
    'D:\\WinRoot\\System32\\taskkill.exe',
  );
  assert.equal(resolveWindowsTaskkillPath({}), 'taskkill.exe');
});

test('stopSidecarProcess absorbs an asynchronous EPIPE while stopping', async () => {
  const child = new FakeSidecarChild({ emitWriteError: true, exitOnKill: true });

  const result = await stopSidecarProcess(child, {
    gracefulTimeoutMs: 5,
    forceKillTimeoutMs: 50,
  });

  assert.deepEqual(child.killCalls, ['SIGKILL']);
  assert.deepEqual(result, { exited: true, forceKillAttempted: true });
  assert.equal(child.stdin.listenerCount('error'), 0);
});

test('stopSidecarProcess keeps EPIPE handled when child exit wins the race', async () => {
  const child = new FakeSidecarChild({
    exitOnStop: true,
    emitWriteError: true,
    emitWriteErrorAfterExit: true,
  });

  const result = await stopSidecarProcess(child, {
    gracefulTimeoutMs: 50,
    forceKillTimeoutMs: 20,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(child.killCalls, []);
  assert.deepEqual(result, { exited: true, forceKillAttempted: false });
  assert.equal(child.stdin.listenerCount('error'), 0);
});

export {};
