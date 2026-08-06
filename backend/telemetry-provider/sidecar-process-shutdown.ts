'use strict';

const path = require('node:path') as typeof import('node:path');
const { spawnSync } = require('node:child_process') as typeof import('node:child_process');

type SidecarChild = import('child_process').ChildProcess;
type TreeKillResult = { status?: number | null; error?: Error };
type TreeKillRunner = (
  command: string,
  args: string[],
  options: import('child_process').SpawnSyncOptions,
) => TreeKillResult;

type SidecarStopOptions = {
  gracefulTimeoutMs?: number;
  forceKillTimeoutMs?: number;
  treeKillRunner?: TreeKillRunner;
};

type SidecarStopResult = {
  exited: boolean;
  forceKillAttempted: boolean;
};

const DEFAULT_GRACEFUL_TIMEOUT_MS = 750;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 250;
const WINDOWS_TREE_KILL_TIMEOUT_MS = 500;

function resolveWindowsTaskkillPath(
  environment: Record<string, string | undefined>,
): string {
  const windowsRoot = environment.SystemRoot || environment.WINDIR;
  return windowsRoot
    ? path.join(windowsRoot, 'System32', 'taskkill.exe')
    : 'taskkill.exe';
}

function hasChildExited(child: SidecarChild): boolean {
  return (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined);
}

function waitForChildExit(child: SidecarChild, timeoutMs: number): Promise<boolean> {
  if (hasChildExited(child)) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);

    child.once('exit', onExit);
    timer = setTimeout(
      () => finish(hasChildExited(child)),
      Math.max(0, Number(timeoutMs) || 0),
    );

    // Cover an exit between the initial state check and listener registration.
    if (hasChildExited(child)) finish(true);
  });
}

function sendStopMessage(child: SidecarChild): void {
  const stdin = child.stdin;
  if (!stdin || stdin.destroyed || stdin.writableEnded || stdin.writable === false) {
    return;
  }

  // A child can close stdin after the state checks above but before Windows
  // completes the write. Leave a one-shot error listener on this dying stream:
  // the child exit event may arrive before the asynchronous EPIPE event.
  const ignoreStdinError = (): void => {};
  const canListenForErrors = typeof stdin.once === 'function'
    && typeof stdin.removeListener === 'function';
  if (canListenForErrors) stdin.once('error', ignoreStdinError);
  try {
    stdin.write(`${JSON.stringify({ type: 'stop' })}\n`);
  } catch (error) {
    if (canListenForErrors) stdin.removeListener('error', ignoreStdinError);
    throw error;
  }
}

function forceKillSidecarProcess(
  child: SidecarChild,
  treeKillRunner: TreeKillRunner = spawnSync,
): void {
  const pid = Math.trunc(Number(child.pid));
  const isSpawnedWindowsChild = process.platform === 'win32'
    && Number.isFinite(pid)
    && pid > 0
    && typeof child.spawnfile === 'string'
    && child.spawnfile.length > 0;

  if (isSpawnedWindowsChild) {
    // This is an operating-system process boundary, not application
    // configuration. Keep the environment read here and the path resolver
    // separately testable instead of coupling shutdown to core/config.
    // eslint-disable-next-line no-restricted-syntax
    const taskkillPath = resolveWindowsTaskkillPath(process.env);
    try {
      const result = treeKillRunner(
        taskkillPath,
        ['/PID', String(pid), '/T', '/F'],
        {
          windowsHide: true,
          stdio: 'ignore',
          timeout: WINDOWS_TREE_KILL_TIMEOUT_MS,
        },
      );
      if (!result.error && result.status === 0) return;
    } catch {}
  }

  try {
    child.kill('SIGKILL');
  } catch {}
}

async function stopSidecarProcess(
  child: SidecarChild | null | undefined,
  options: SidecarStopOptions = {},
): Promise<SidecarStopResult> {
  if (!child) {
    return { exited: true, forceKillAttempted: false };
  }
  if (hasChildExited(child)) {
    return { exited: true, forceKillAttempted: false };
  }

  try {
    sendStopMessage(child);
  } catch {}

  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS;
  if (await waitForChildExit(child, gracefulTimeoutMs)) {
    return { exited: true, forceKillAttempted: false };
  }

  forceKillSidecarProcess(child, options.treeKillRunner);

  const forceKillTimeoutMs = options.forceKillTimeoutMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS;
  return {
    exited: await waitForChildExit(child, forceKillTimeoutMs),
    forceKillAttempted: true,
  };
}

module.exports = {
  forceKillSidecarProcess,
  resolveWindowsTaskkillPath,
  stopSidecarProcess,
  waitForChildExit,
};

export {};
