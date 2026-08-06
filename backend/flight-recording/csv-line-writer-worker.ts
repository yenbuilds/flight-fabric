'use strict';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const { parentPort, workerData } = require('worker_threads') as typeof import('worker_threads');
const {
  assertSafeRecordingFilePath,
  createSafeRecordingWriteStream,
  safeRenameRecordingFileSync,
} = require('./recording-path-guard') as {
  assertSafeRecordingFilePath: (_options: {
    extension: string;
    operation: string;
    outputDir: string;
    targetPath: string;
  }) => string;
  createSafeRecordingWriteStream: (_options: {
    extension: string;
    flags?: string;
    operation: string;
    outputDir: string;
    targetPath: string;
  }) => FsWriteStream;
  safeRenameRecordingFileSync: (_options: {
    extension: string;
    fromPath: string;
    operation: string;
    outputDir: string;
    toPath: string;
  }) => boolean;
};

type FsWriteStream = import('fs').WriteStream & {
  fd?: number | null;
};

type WorkerStartData = {
  controlBuffer?: SharedArrayBuffer;
  filePath?: string;
  headerLine?: string;
  manifestLine?: string;
  outputDir?: string;
  syncIntervalMs?: number;
  initialRowCount?: number;
  maxFileBytes?: number;
  initialAcceptedFileBytes?: number;
  expectedCreationIdentity?: { dev: number; ino: number };
  startupDelayMs?: number;
  startupNotifyDelayMs?: number;
  periodicSyncBarrierDelayMs?: number;
  periodicSyncErrorCode?: string;
  reportPeriodicSyncPhases?: boolean;
};

type WorkerCommand = {
  type?: string;
  requestId?: number;
  line?: string;
  lines?: string[];
  newPath?: string;
  controlBuffer?: SharedArrayBuffer;
};

let stream: FsWriteStream | null = null;
let filePath = '';
const startData = workerData as WorkerStartData | null | undefined;
const outputDir = startData?.outputDir || (startData?.filePath ? path.dirname(startData.filePath) : '');
let rowCount = Number.isFinite(startData?.initialRowCount)
  ? Math.max(0, Math.round(Number(startData?.initialRowCount)))
  : 0;
let closed = false;
let lastError: string | null = null;
let commandChain: Promise<void> = Promise.resolve();
const syncIntervalMs = Number.isFinite(startData?.syncIntervalMs)
  ? Number(startData?.syncIntervalMs)
  : 30000;
let lastSyncTime = Date.now();
let syncPromise: Promise<void> | null = null;
let syncTimer: NodeJS.Timeout | null = null;
let syncDirty = false;
let syncCatchUpDue = false;
const maxFileBytes = Number.isFinite(startData?.maxFileBytes)
  ? Math.max(1, Math.floor(Number(startData?.maxFileBytes)))
  : 200 * 1024 * 1024;
let acceptedFileBytes = Number.isFinite(startData?.initialAcceptedFileBytes)
  ? Math.max(0, Math.floor(Number(startData?.initialAcceptedFileBytes)))
  : 0;
const periodicSyncBarrierDelayMs = Number.isFinite(startData?.periodicSyncBarrierDelayMs)
  ? Math.max(0, Number(startData?.periodicSyncBarrierDelayMs))
  : 0;
const periodicSyncErrorCode = String(startData?.periodicSyncErrorCode || '');
const reportPeriodicSyncPhases = startData?.reportPeriodicSyncPhases === true;

function notifyStart(ok: boolean): void {
  const buffer = (workerData as WorkerStartData | null | undefined)?.controlBuffer;
  if (!buffer) return;
  const control = new Int32Array(buffer);
  Atomics.store(control, 0, ok ? 1 : -1);
  Atomics.notify(control, 0, 1);
}

function post(message: Record<string, unknown>): void {
  try {
    parentPort?.postMessage(message);
  } catch {}
}

function serializeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function writeUtf8FullySync(fd: number, text: string): void {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, null);
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error('CSV worker startup metadata write made no forward progress');
    }
    offset += written;
  }
}

function isDiskExhaustedError(err: NodeJS.ErrnoException | null | undefined): boolean {
  return err?.code === 'ENOSPC' || err?.code === 'EDQUOT';
}

function postError(err: NodeJS.ErrnoException | Error | unknown): void {
  lastError = serializeError(err);
  const code = typeof err === 'object' && err && 'code' in err
    ? String((err as NodeJS.ErrnoException).code || '')
    : '';
  const diskExhausted = isDiskExhaustedError(err as NodeJS.ErrnoException);
  // Any stream/write/sync failure is terminal for this artifact. The command
  // loop remains alive solely so the parent can still request close and wait
  // for descriptor release; no later append may advance rowCount.
  closed = true;
  clearPeriodicSyncTimer();
  post({
    type: 'error',
    error: lastError,
    code: code || undefined,
    diskExhausted,
  });
}

function startPeriodicSyncTimer(): void {
  if (syncTimer || syncIntervalMs <= 0) return;
  syncTimer = setInterval(() => scheduleSyncIfDue(true), syncIntervalMs);
  syncTimer.unref?.();
}

function clearPeriodicSyncTimer(): void {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

function scheduleSyncIfDue(force = false): void {
  if (closed || !stream || typeof stream.fd !== 'number') return;
  if (syncPromise) {
    if (force) syncCatchUpDue = true;
    return;
  }
  if (!syncDirty) return;

  const now = Date.now();
  if (!force && syncIntervalMs > 0 && now - lastSyncTime <= syncIntervalMs) return;

  const activeStream = stream;
  syncDirty = false;
  syncCatchUpDue = false;
  const pending = (async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        activeStream.write('', (error?: Error | null) => error ? reject(error) : resolve());
      });
      if (reportPeriodicSyncPhases) post({ type: 'periodicSyncPhase', phase: 'barrier' });
      if (periodicSyncBarrierDelayMs > 0) {
        const delayControl = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
        Atomics.wait(delayControl, 0, 0, periodicSyncBarrierDelayMs);
      }
      if (typeof activeStream.fd !== 'number') {
        throw new Error('CSV worker periodic sync file descriptor is unavailable');
      }
      if (reportPeriodicSyncPhases) post({ type: 'periodicSyncPhase', phase: 'fdatasync' });
      if (periodicSyncErrorCode) {
        const error = new Error('simulated CSV worker periodic sync failure') as NodeJS.ErrnoException;
        error.code = periodicSyncErrorCode;
        throw error;
      }
      await new Promise<void>((resolve, reject) => {
        fs.fdatasync(activeStream.fd as number, (error) => error ? reject(error) : resolve());
      });
      lastSyncTime = now;
    } catch (error) {
      postError(error);
    }
  })().finally(() => {
    if (syncPromise === pending) syncPromise = null;
    const shouldCatchUp = syncCatchUpDue || syncIntervalMs <= 0;
    syncCatchUpDue = false;
    if (syncDirty && shouldCatchUp && !closed && stream === activeStream) {
      scheduleSyncIfDue(true);
    }
  });
  syncPromise = pending;
}

async function waitForPeriodicSync(): Promise<void> {
  while (syncPromise) await syncPromise;
}

function waitForDrain(targetStream: FsWriteStream): Promise<void> {
  return new Promise((resolve) => {
    const cleanup = () => {
      targetStream.off('drain', onDrain);
      targetStream.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      resolve();
    };

    targetStream.once('drain', onDrain);
    targetStream.once('error', onError);
  });
}

async function flushStream(targetStream: FsWriteStream | null = stream): Promise<void> {
  if (!targetStream) throw new Error('CSV worker stream is unavailable');
  const activeStream = targetStream;
  await waitForPeriodicSync();
  await new Promise<void>((resolve, reject) => {
    activeStream.write('', (error?: Error | null) => error ? reject(error) : resolve());
  });
  if (typeof activeStream.fd !== 'number') throw new Error('CSV worker file descriptor is unavailable');
  await new Promise<void>((resolve, reject) => {
    fs.fdatasync(activeStream.fd as number, (error) => error ? reject(error) : resolve());
  });
}

function openStream(initialPath: string, headerLine: string, manifestLine: string): boolean {
  let startupStream: FsWriteStream | null = null;
  try {
    const resolvedPath = assertSafeRecordingFilePath({
      extension: '.csv',
      operation: 'startCsvWorkerRecording',
      outputDir,
      targetPath: initialPath,
    });
    const expectedIdentity = startData?.expectedCreationIdentity;
    const startupText = `${headerLine}\n${manifestLine}\n`;
    const startupBytes = Buffer.byteLength(startupText, 'utf8');
    if (startupBytes > maxFileBytes) {
      throw new Error(`CSV startup metadata exceeds the ${Math.round(maxFileBytes / 1024 / 1024)}MiB file cap`);
    }
    if (acceptedFileBytes !== 0 && acceptedFileBytes !== startupBytes) {
      throw new Error('CSV worker startup byte accounting mismatch');
    }
    let nextStream: FsWriteStream;
    let headerCommitted = false;
    if (expectedIdentity) {
      const fd = fs.openSync(resolvedPath, fs.constants.O_WRONLY | fs.constants.O_APPEND);
      try {
        const claimedStat = fs.fstatSync(fd);
        if (
          claimedStat.dev !== expectedIdentity.dev
          || claimedStat.ino !== expectedIdentity.ino
          || claimedStat.size !== 0
        ) {
          throw new Error('CSV worker startup claim identity changed');
        }
        // Startup success means both schema and immutable bundle identity are
        // already durable, even if the flight ends before telemetry arrives.
        writeUtf8FullySync(fd, startupText);
        fs.fdatasyncSync(fd);
        headerCommitted = true;
        nextStream = fs.createWriteStream(resolvedPath, { fd, autoClose: true }) as FsWriteStream;
      } catch (error) {
        try { fs.closeSync(fd); } catch {}
        throw error;
      }
    } else {
      nextStream = createSafeRecordingWriteStream({
        extension: '.csv',
        flags: 'wx',
        operation: 'openCsvWorkerRecording',
        outputDir,
        targetPath: resolvedPath,
      });
      startupStream = nextStream;
      if (typeof nextStream.fd !== 'number') {
        throw new Error('CSV worker startup descriptor is unavailable');
      }
      writeUtf8FullySync(nextStream.fd, startupText);
      fs.fdatasyncSync(nextStream.fd);
      headerCommitted = true;
    }
    nextStream.on('error', (err) => {
      postError(err);
    });
    stream = nextStream;
    filePath = resolvedPath;
    acceptedFileBytes = startupBytes;
    startPeriodicSyncTimer();
    if (!headerCommitted) throw new Error('CSV worker startup identity was not committed');
    return true;
  } catch (err) {
    try { startupStream?.destroy(); } catch {}
    postError(err);
    return false;
  }
}

async function appendLines(lines: string[]): Promise<number> {
  if (closed || !stream || lines.length === 0) return 0;

  let appended = 0;
  try {
    for (const line of lines) {
      if (closed || !stream) break;
      const activeStream = stream;
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (acceptedFileBytes + lineBytes > maxFileBytes) {
        throw new Error(`CSV reached the ${Math.round(maxFileBytes / 1024 / 1024)}MiB file cap`);
      }
      const previousRowCount = rowCount;
      const canContinue = activeStream.write(`${line}\n`);
      acceptedFileBytes += lineBytes;
      syncDirty = true;
      rowCount++;
      appended++;
      scheduleSyncIfDue();
      if (Math.floor(previousRowCount / 100) !== Math.floor(rowCount / 100)) {
        post({ type: 'progress', rowCount });
      }
      if (!canContinue) {
        await waitForDrain(activeStream);
      }
    }
  } catch (err) {
    postError(err);
    throw err;
  }

  return appended;
}

async function closeStream(): Promise<{ rowCount: number; fileSizeBytes: number; lastError: string | null }> {
  closed = true;
  clearPeriodicSyncTimer();
  const activeStream = stream;
  if (activeStream) {
    try {
      await flushStream(activeStream);
    } catch (error) {
      lastError = serializeError(error);
    }
    await new Promise<void>((resolve) => {
      if (activeStream.closed) return resolve();
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        activeStream.off('close', finish);
        resolve();
      };
      activeStream.once('close', finish);
      activeStream.end();
    });
  }
  stream = null;
  let fileSizeBytes = 0;
  try {
    if (filePath && fs.existsSync(filePath)) {
      fileSizeBytes = fs.statSync(filePath).size;
    }
  } catch {}
  return { rowCount, fileSizeBytes, lastError };
}

function closeStreamSync(controlBuffer?: SharedArrayBuffer): void {
  closed = true;
  clearPeriodicSyncTimer();
  const notify = () => {
    if (!controlBuffer) return;
    const control = new Int32Array(controlBuffer);
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0, 1);
  };

  try {
    if (stream) {
      const closingStream = stream;
      stream = null;
      closingStream.end(() => notify());
    } else {
      notify();
    }
  } catch {
    notify();
  }
}

async function updateFilePath(newPath: string): Promise<boolean> {
  if (closed || !filePath || !newPath || newPath === filePath) return false;

  const previousStream = stream;
  stream = null;
  let adoptedDestination = false;

  try {
    if (previousStream) {
      await flushStream(previousStream);
      await new Promise<void>((resolve) => {
        if (previousStream.closed) return resolve();
        previousStream.once('close', resolve);
        previousStream.end();
      });
    }
    const resolvedNewPath = assertSafeRecordingFilePath({
      extension: '.csv',
      operation: 'renameCsvWorkerRecording',
      outputDir,
      targetPath: newPath,
    });
    safeRenameRecordingFileSync({
      extension: '.csv',
      fromPath: filePath,
      operation: 'renameCsvWorkerRecording',
      outputDir,
      toPath: resolvedNewPath,
    });
    // Once the no-replace move commits, recovery and the parent-visible result
    // must follow the adopted path even if reopening the stream fails.
    filePath = resolvedNewPath;
    adoptedDestination = true;
    const nextStream = createSafeRecordingWriteStream({
      extension: '.csv',
      flags: 'a',
      operation: 'reopenCsvWorkerRecording',
      outputDir,
      targetPath: resolvedNewPath,
    });
    nextStream.on('error', (err) => {
      postError(err);
    });
    stream = nextStream;
    return true;
  } catch (err) {
    postError(err);
    try {
      const recovered = createSafeRecordingWriteStream({
        extension: '.csv',
        flags: 'a',
        operation: 'recoverCsvWorkerRecording',
        outputDir,
        targetPath: filePath,
      });
      recovered.on('error', (recoveryErr) => {
        postError(recoveryErr);
      });
      stream = recovered;
    } catch {}
    return adoptedDestination;
  }
}

async function handleCommand(command: WorkerCommand): Promise<void> {
  try {
    switch (command.type) {
      case 'appendLine':
        if (typeof command.line === 'string') {
          const appended = await appendLines([command.line]);
          if (typeof command.requestId === 'number') {
            post({ type: 'response', requestId: command.requestId, ok: true, rowCount, appended });
          }
        }
        return;
      case 'appendLines':
        if (Array.isArray(command.lines)) {
          const appended = await appendLines(command.lines.filter((line): line is string => typeof line === 'string'));
          if (typeof command.requestId === 'number') {
            post({ type: 'response', requestId: command.requestId, ok: true, rowCount, appended });
          }
        }
        return;
      case 'updatePath': {
        const ok = typeof command.newPath === 'string'
          ? await updateFilePath(command.newPath)
          : false;
        post({ type: 'response', requestId: command.requestId, ok });
        return;
      }
      case 'close': {
        const stats = await closeStream();
        post({ type: 'response', requestId: command.requestId, ok: true, stats });
        return;
      }
      case 'flush':
        await flushStream();
        post({ type: 'response', requestId: command.requestId, ok: true, rowCount });
        return;
      case 'closeSync': {
        closeStreamSync(command.controlBuffer);
        return;
      }
      default:
        return;
    }
  } catch (err) {
    const error = serializeError(err);
    lastError = error;
    post({ type: 'response', requestId: command.requestId, ok: false, error });
  }
}

const startupDelayMs = Number.isFinite(startData?.startupDelayMs)
  ? Math.max(0, Number(startData?.startupDelayMs))
  : 0;
if (startupDelayMs > 0) {
  const delayControl = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(delayControl, 0, 0, startupDelayMs);
}

const started = Boolean(
  startData?.filePath
  && startData?.headerLine
  && startData?.manifestLine
  && openStream(startData.filePath, startData.headerLine, startData.manifestLine)
);
const startupNotifyDelayMs = Number.isFinite(startData?.startupNotifyDelayMs)
  ? Math.max(0, Number(startData?.startupNotifyDelayMs))
  : 0;
if (started && startupNotifyDelayMs > 0) {
  const notifyDelayControl = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(notifyDelayControl, 0, 0, startupNotifyDelayMs);
}
notifyStart(started);

if (!started) {
  post({ type: 'startError', error: lastError || 'CSV line writer worker failed to start' });
} else {
  post({ type: 'started', filePath });
}

parentPort?.on('message', (command: WorkerCommand) => {
  commandChain = commandChain.then(() => handleCommand(command)).catch((err) => {
    lastError = serializeError(err);
    post({ type: 'error', error: lastError });
  });
});
