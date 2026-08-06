'use strict';

const path = require('path') as typeof import('path');
const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const { spawn, spawnSync } = require('child_process') as typeof import('child_process');
const { stopSidecarProcess } = require('./sidecar-process-shutdown.js') as {
  stopSidecarProcess: (
    child: import('child_process').ChildProcess | null | undefined,
  ) => Promise<{ exited: boolean; forceKillAttempted: boolean }>;
};
const {
  buildOwnedPidFilePath,
  buildParentSafeWindowsCleanupScript,
  clearSidecarPidFile,
  commandLineMatchesOwnerRecord,
  getBackendOwnerIdentity,
  getSidecarOwnerArgs,
  isLegacySidecarDemonstrablyOrphaned,
  isProcessOwnedByCurrentWindowsUser,
  isRecordedOwnerDemonstrablyGone,
  isSameProcessInstance,
  listOwnedPidFilePaths,
  readProcessMetadata,
  readSidecarPidRecord,
  writeSidecarPidRecord,
} = require('./sidecar-process-ownership.js') as SidecarOwnershipModule;

type ProcessMetadata = {
  pid: number;
  parentPid: number | null;
  startToken: string | null;
  startedAtMs: number | null;
  commandLine: string | null;
  userSid: string | null;
};

type BackendOwnerIdentity = {
  pid: number;
  token: string;
  startToken: string | null;
  startedAtMs: number;
  userSid: string | null;
};

type SidecarPidRecord = {
  version: number;
  pid: number;
  ownerPid: number | null;
  ownerToken: string | null;
  ownerStartToken: string | null;
  ownerStartedAtMs: number | null;
};

type SidecarOwnershipModule = {
  buildOwnedPidFilePath: (basePath: string, identity?: BackendOwnerIdentity) => string;
  buildParentSafeWindowsCleanupScript: (cleanupToken: string, role: 'sdk-clientdata') => string | null;
  clearSidecarPidFile: (pidFilePath: string, expectedPid?: number) => void;
  commandLineMatchesOwnerRecord: (commandLine: string | null | undefined, record: SidecarPidRecord) => boolean;
  getBackendOwnerIdentity: () => BackendOwnerIdentity;
  getSidecarOwnerArgs: (identity?: BackendOwnerIdentity) => string[];
  isLegacySidecarDemonstrablyOrphaned: (
    child: ProcessMetadata | null,
    metadataReader?: (pid: number) => ProcessMetadata | null,
  ) => boolean;
  isProcessOwnedByCurrentWindowsUser: (
    candidate: ProcessMetadata | null,
    identity?: BackendOwnerIdentity,
    platform?: NodeJS.Platform,
  ) => boolean;
  isSameProcessInstance: (
    initial: ProcessMetadata | null,
    confirmed: ProcessMetadata | null,
    platform?: NodeJS.Platform,
  ) => boolean;
  isRecordedOwnerDemonstrablyGone: (
    record: SidecarPidRecord,
    metadataReader?: (pid: number) => ProcessMetadata | null,
  ) => boolean;
  listOwnedPidFilePaths: (ownedPath: string, identity?: BackendOwnerIdentity) => string[];
  readProcessMetadata: (pid: number) => ProcessMetadata | null;
  readSidecarPidRecord: (pidFilePath: string) => SidecarPidRecord | null;
  writeSidecarPidRecord: (pidFilePath: string, childPid: number, identity?: BackendOwnerIdentity) => void;
};

type AnyRecord = Record<string, any>;
type BridgeStatus = 'disabled' | 'error' | 'starting' | 'stopped' | 'ready' | 'connecting' | 'disconnected' | 'running' | string;
type LaunchProvider = 'rust';

type SdkLaunchSpec = {
  provider: LaunchProvider;
  source: string;
  command: string;
  args: string[];
  cleanupToken: string;
};

type SdkLaunchResolution = {
  launchSpec: SdkLaunchSpec | null;
  error: string | null;
};

type SdkAdapter = {
  id: string;
  displayName: string;
  sourceType?: string;
  categories: string[];
  noDataHint?: string;
  pidFileName?: string;
  normalizeTarget?: (target: AnyRecord | null | undefined) => AnyRecord;
  describeTarget?: (target: AnyRecord | null | undefined) => string | null;
  buildConnectMessage?: (target: AnyRecord | null | undefined) => AnyRecord | null;
  buildSidecarEnv?: () => NodeJS.ProcessEnv;
  resolveLaunchSpec?: () => SdkLaunchResolution;
  normalizeSnapshot?: (rawSnapshot: AnyRecord | null | undefined) => AnyRecord;
};

type ReadyMessage = {
  type: 'ready';
  source?: string;
  librarySpec?: string;
  adapterId?: string;
};

type StatusMessage = {
  type: 'status';
  source?: string;
  librarySpec?: string;
  state?: string;
  error?: string | null;
};

type SnapshotMessage = {
  type: 'snapshot';
  source?: string;
  librarySpec?: string;
  values?: AnyRecord;
  raw?: AnyRecord;
  normalized?: AnyRecord;
  timestampIso?: string | null;
};

type CapabilitiesMessage = {
  type: 'capabilities';
  items?: string[];
};

type ErrorMessage = {
  type: 'error';
  message?: string;
};

type SidecarMessage = ReadyMessage | StatusMessage | SnapshotMessage | CapabilitiesMessage | ErrorMessage | AnyRecord;

type SnapshotState = {
  enabled: boolean;
  source: string;
  adapterId: string;
  adapterName: string;
  transportSource: string | null;
  librarySpec: string | null;
  status: BridgeStatus;
  aircraft: string | null;
  target: AnyRecord | null;
  normalized: AnyRecord;
  raw: AnyRecord;
  values: AnyRecord;
  updatedAt: string | null;
  error: string | null;
  categories: string[];
  snapshotSequence: number;
};

function isObject(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isReadyMessage(message: SidecarMessage): message is ReadyMessage {
  return isObject(message) && message.type === 'ready';
}

function isStatusMessage(message: SidecarMessage): message is StatusMessage {
  return isObject(message) && message.type === 'status';
}

function isSnapshotMessage(message: SidecarMessage): message is SnapshotMessage {
  return isObject(message) && message.type === 'snapshot';
}

function isCapabilitiesMessage(message: SidecarMessage): message is CapabilitiesMessage {
  return isObject(message) && message.type === 'capabilities';
}

function isErrorMessage(message: SidecarMessage): message is ErrorMessage {
  return isObject(message) && message.type === 'error';
}

function cloneRecord(value: AnyRecord | null | undefined): AnyRecord {
  return isObject(value) ? { ...value } : {};
}

function hasAnySdkData(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((item) => hasAnySdkData(item));
  if (isObject(value)) return Object.values(value).some((item) => hasAnySdkData(item));
  return false;
}

class SdkBridge {
  _adapter: SdkAdapter;
  _proc: import('child_process').ChildProcessWithoutNullStreams | null;
  _started: boolean;
  _startPromise: Promise<void> | null;
  _stopPromise: Promise<void> | null;
  _lineBuffer: string;
  _resolvedLaunchSpec: SdkLaunchSpec | null;
  _lastBackendProbeError: string | null;
  _pidFilePath: string;
  _ownerIdentity: BackendOwnerIdentity;
  _snapshot: SnapshotState;
  _lastConnectCommandProcess: import('child_process').ChildProcessWithoutNullStreams | null;
  _lastConnectCommandKey: string | null;

  constructor(adapter: SdkAdapter) {
    if (!adapter || typeof adapter !== 'object') {
      throw new Error('SdkBridge requires an adapter definition.');
    }

    this._adapter = adapter;
    this._proc = null;
    this._started = false;
    this._startPromise = null;
    this._stopPromise = null;
    this._lineBuffer = '';
    this._resolvedLaunchSpec = null;
    this._lastBackendProbeError = null;
    this._lastConnectCommandProcess = null;
    this._lastConnectCommandKey = null;
    this._ownerIdentity = getBackendOwnerIdentity();
    this._pidFilePath = buildOwnedPidFilePath(
      path.join(
        os.tmpdir(),
        adapter.pidFileName || `flight-fabric-sdk-${adapter.id}.pid`,
      ),
      this._ownerIdentity,
    );
    this._snapshot = {
      enabled: false,
      source: adapter.sourceType || 'sdk',
      adapterId: adapter.id,
      adapterName: adapter.displayName || adapter.id,
      transportSource: null,
      librarySpec: null,
      status: 'disabled',
      aircraft: null,
      target: null,
      normalized: {},
      raw: {},
      values: {},
      updatedAt: null,
      error: null,
      categories: Array.isArray(adapter.categories) ? adapter.categories.slice() : [],
      snapshotSequence: 0,
    };
  }

  _setStatus(status: BridgeStatus, error: string | null = null): void {
    const prevStatus = this._snapshot.status;
    const prevError = this._snapshot.error;
    this._snapshot.status = status;
    this._snapshot.error = error;
    if (status !== prevStatus || (error && error !== prevError)) {
      const suffix = error ? ` error=${String(error).slice(0, 200)}` : '';
      console.log(`[SDK-bridge:${this._adapter.id}] status ${prevStatus} -> ${status}${suffix}`);
    }
  }

  _buildSidecarEnv(): NodeJS.ProcessEnv {
    return typeof this._adapter.buildSidecarEnv === 'function'
      ? this._adapter.buildSidecarEnv()
      : { ...process.env };
  }

  _buildLaunchArgs(args: string[] = []): string[] {
    return [...args, ...getSidecarOwnerArgs(this._ownerIdentity)];
  }

  _resolveLaunchSpec(): SdkLaunchSpec | null {
    if (this._resolvedLaunchSpec) {
      return this._resolvedLaunchSpec;
    }

    const resolution = typeof this._adapter.resolveLaunchSpec === 'function'
      ? this._adapter.resolveLaunchSpec()
      : {
          launchSpec: null,
          error: `Adapter ${this._adapter.id} does not provide a launch resolver.`,
        };

    this._lastBackendProbeError = resolution?.error || null;
    if (!resolution?.launchSpec) {
      return null;
    }

    this._resolvedLaunchSpec = resolution.launchSpec;
    this._snapshot.transportSource = resolution.launchSpec.source;
    return resolution.launchSpec;
  }

  async start(): Promise<void> {
    if (this._stopPromise) {
      await this._stopPromise;
    }
    if (this._startPromise) {
      await this._startPromise;
      return;
    }
    if (this._started) return;

    const launchSpec = this._resolvedLaunchSpec || this._resolveLaunchSpec();
    if (!launchSpec) {
      const detail = this._lastBackendProbeError || 'No SDK sidecar launch path could be resolved.';
      this._setStatus('error', `No usable SDK sidecar provider found for ${this._adapter.displayName}. ${detail}`.slice(0, 500));
      return;
    }

    this._snapshot.enabled = true;
    this._snapshot.transportSource = launchSpec.source;
    this._cleanupStaleSidecarProcesses(launchSpec.cleanupToken);

    let child: import('child_process').ChildProcessWithoutNullStreams;
    try {
      child = spawn(launchSpec.command, this._buildLaunchArgs(launchSpec.args), {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: this._buildSidecarEnv(),
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this._setStatus('error', `SDK sidecar spawn failed: ${failure.message}`.slice(0, 500));
      throw failure;
    }
    this._proc = child;
    this._lastConnectCommandProcess = null;
    this._lastConnectCommandKey = null;

    child.stdout.on('data', (chunk) => this._onStdout(chunk));
    child.stdout.on('error', (error) => this._handlePipeError(child, 'stdout', error));
    child.stderr.on('data', (chunk) => this._onStderr(chunk));
    child.stderr.on('error', (error) => this._handlePipeError(child, 'stderr', error));
    child.on('exit', (code, signal) => this._handleProcessExit(child, code, signal));
    child.stdin.on('error', (error) => this._handleStdinError(child, error));

    let spawnConfirmed = false;
    const startPromise = new Promise<void>((resolve, reject) => {
      child.once('spawn', () => {
        spawnConfirmed = true;
        if (this._proc !== child || this._stopPromise) {
          resolve();
          return;
        }
        this._started = true;
        this._setStatus('starting');
        this._writePidFile(child.pid);
        resolve();
      });
      child.once('error', (error) => {
        if (spawnConfirmed) return;
        const failure = error instanceof Error ? error : new Error(String(error));
        if (this._proc === child) {
          this._clearPidFile(child.pid);
          this._started = false;
          this._proc = null;
          this._setStatus('error', `SDK sidecar spawn failed: ${failure.message}`.slice(0, 500));
        }
        reject(failure);
      });
    });
    child.on('error', (error) => this._handleProcessError(child, error));
    this._startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this._startPromise === startPromise) {
        this._startPromise = null;
      }
    }
  }

  _handleProcessError(
    child: import('child_process').ChildProcessWithoutNullStreams,
    error: Error,
  ): void {
    if (this._proc !== child) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this._setStatus('error', `SDK sidecar process error: ${failure.message}`.slice(0, 500));
  }

  _handlePipeError(
    child: import('child_process').ChildProcessWithoutNullStreams,
    pipe: 'stdout' | 'stderr',
    error: Error,
  ): void {
    if (this._proc !== child) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this._setStatus('error', `SDK sidecar ${pipe} error: ${failure.message}`.slice(0, 500));
  }

  _handleStdinError(
    child: import('child_process').ChildProcessWithoutNullStreams,
    error: Error,
  ): void {
    if (this._proc !== child) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this._setStatus('error', `SDK sidecar stdin error: ${failure.message}`.slice(0, 500));
  }

  _handleProcessExit(
    child: import('child_process').ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this._proc !== child) return;

    const wasStopping = this._stopPromise != null;
    this._clearPidFile(child.pid);
    const exitDetail = `exit:${code ?? 'null'} signal:${signal ?? 'null'}`;
    const priorError = this._snapshot.error;
    this._setStatus(
      'stopped',
      wasStopping ? null : (priorError ? `${priorError} (${exitDetail})` : exitDetail),
    );
    this._started = false;
    this._proc = null;
    this._lastConnectCommandProcess = null;
    this._lastConnectCommandKey = null;
  }

  async stop(): Promise<void> {
    if (this._stopPromise) {
      await this._stopPromise;
      return;
    }

    const pendingStart = this._startPromise;
    this._started = false;
    const stopPromise = (async (): Promise<void> => {
      try {
        await pendingStart;
      } catch {}
      const child = this._proc;
      try {
        const result = await stopSidecarProcess(child);
        if (!result.exited) {
          if (this._proc === child) {
            this._started = true;
          }
          const error = new Error(
            `SDK sidecar PID ${child?.pid ?? 'unknown'} did not exit after forced shutdown`,
          );
          this._setStatus('error', error.message);
          throw error;
        }

        if (this._proc === child) {
          this._proc = null;
        }
        this._clearPidFile(child?.pid);
        this._setStatus('stopped');
      } catch (error) {
        if (this._proc === child && child) {
          this._started = true;
        }
        throw error;
      }
    })();
    this._stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this._stopPromise === stopPromise) {
        this._stopPromise = null;
      }
    }
  }

  connect(target: AnyRecord | null = null): void {
    if (!target) {
      this._snapshot.target = null;
      this._snapshot.aircraft = null;
      this._snapshot.raw = {};
      this._snapshot.values = {};
      this._snapshot.normalized = {};
      this._snapshot.updatedAt = null;
      this._snapshot.snapshotSequence = 0;
      this._lastConnectCommandProcess = null;
      this._lastConnectCommandKey = null;
      if (!this._proc || !this._started) return;
      this._send({ type: 'disconnect' });
      return;
    }

    const normalizedTarget = typeof this._adapter.normalizeTarget === 'function'
      ? this._adapter.normalizeTarget(target)
      : cloneRecord(target);

    const payload = typeof this._adapter.buildConnectMessage === 'function'
      ? this._adapter.buildConnectMessage(normalizedTarget)
      : null;
    const payloadKey = payload ? JSON.stringify(payload) : null;
    const child = this._proc;
    const stdin = child?.stdin;
    const commandAlreadySentToLiveProcess = payloadKey != null
      && child != null
      && this._lastConnectCommandProcess === child
      && this._lastConnectCommandKey === payloadKey
      && !child.killed
      && stdin != null
      && !stdin.destroyed
      && !stdin.writableEnded
      && stdin.writable !== false;
    if (commandAlreadySentToLiveProcess) return;

    this._snapshot.target = cloneRecord(normalizedTarget);
    this._snapshot.aircraft = typeof this._adapter.describeTarget === 'function'
      ? this._adapter.describeTarget(normalizedTarget)
      : null;
    this._snapshot.raw = {};
    this._snapshot.values = {};
    this._snapshot.normalized = {};
    this._snapshot.updatedAt = null;
    this._snapshot.snapshotSequence = 0;

    if (!this._proc || !this._started) return;
    if (payload && this._send(payload)) {
      this._lastConnectCommandProcess = this._proc;
      this._lastConnectCommandKey = payloadKey;
    }
  }

  getSnapshot(): SnapshotState {
    return {
      ...this._snapshot,
      target: this._snapshot.target ? cloneRecord(this._snapshot.target) : null,
      normalized: cloneRecord(this._snapshot.normalized),
      raw: cloneRecord(this._snapshot.raw),
      values: cloneRecord(this._snapshot.values),
      categories: this._snapshot.categories.slice(),
    };
  }

  isDataConnected(): boolean {
    return (
      this._snapshot.status === 'running' &&
      (hasAnySdkData(this._snapshot.raw) || hasAnySdkData(this._snapshot.normalized))
    );
  }

  _send(message: AnyRecord): boolean {
    const child = this._proc;
    const stdin = child?.stdin;
    if (
      !child
      || !stdin
      || child.killed
      || stdin.destroyed
      || stdin.writableEnded
      || stdin.writable === false
    ) return false;
    try {
      stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch (error) {
      this._handleStdinError(
        child,
        error instanceof Error ? error : new Error(String(error)),
      );
      return false;
    }
  }

  _onStdout(chunk: Buffer | string): void {
    this._lineBuffer += chunk.toString('utf8');
    if (this._lineBuffer.length > 65536) {
      this._lineBuffer = '';
      return;
    }

    const lines = this._lineBuffer.split(/\r?\n/);
    this._lineBuffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      let msg: SidecarMessage;
      try {
        msg = JSON.parse(line) as SidecarMessage;
      } catch {
        continue;
      }

      if (isReadyMessage(msg)) {
        if (typeof msg.source === 'string' && msg.source.trim()) {
          this._snapshot.transportSource = msg.source.trim();
        }
        if (typeof msg.librarySpec === 'string' && msg.librarySpec.trim()) {
          this._snapshot.librarySpec = msg.librarySpec.trim();
        }
        this._setStatus('ready');
        if (this._snapshot.target) {
          const normalizedTarget = typeof this._adapter.normalizeTarget === 'function'
            ? this._adapter.normalizeTarget(this._snapshot.target)
            : cloneRecord(this._snapshot.target);
          this.connect(normalizedTarget);
        }
        continue;
      }

      if (isStatusMessage(msg)) {
        if (typeof msg.source === 'string' && msg.source.trim()) {
          this._snapshot.transportSource = msg.source.trim();
        }
        if (typeof msg.librarySpec === 'string' && msg.librarySpec.trim()) {
          this._snapshot.librarySpec = msg.librarySpec.trim();
        }
        const state = typeof msg.state === 'string' && msg.state.trim()
          ? msg.state.trim()
          : 'unknown';
        const errorText = typeof msg.error === 'string' && msg.error.trim()
          ? msg.error.trim()
          : null;
        if (state === 'subscribed') {
          this._setStatus('connecting', null);
        } else if (state === 'disconnected') {
          this._snapshot.raw = {};
          this._snapshot.values = {};
          this._snapshot.normalized = {};
          this._snapshot.updatedAt = null;
          this._snapshot.snapshotSequence = 0;
          this._setStatus('disconnected', errorText);
        } else {
          this._setStatus(state, errorText);
        }
        continue;
      }

      if (isSnapshotMessage(msg)) {
        if (typeof msg.source === 'string' && msg.source.trim()) {
          this._snapshot.transportSource = msg.source.trim();
        }
        if (typeof msg.librarySpec === 'string' && msg.librarySpec.trim()) {
          this._snapshot.librarySpec = msg.librarySpec.trim();
        }

        const rawValues = isObject(msg.raw)
          ? msg.raw
          : (isObject(msg.values) ? msg.values : {});
        let normalizedValues = isObject(msg.normalized) ? msg.normalized : null;
        if (!normalizedValues && typeof this._adapter.normalizeSnapshot === 'function') {
          try {
            normalizedValues = this._adapter.normalizeSnapshot(rawValues);
          } catch (err) {
            this._setStatus('error', err instanceof Error ? err.message : String(err));
            normalizedValues = {};
          }
        }

        this._snapshot.raw = cloneRecord(rawValues);
        this._snapshot.values = cloneRecord(rawValues);
        this._snapshot.normalized = cloneRecord(normalizedValues || {});
        this._snapshot.updatedAt = typeof msg.timestampIso === 'string' && msg.timestampIso.trim()
          ? msg.timestampIso
          : null;
        this._snapshot.snapshotSequence += 1;

        if ((hasAnySdkData(rawValues) || hasAnySdkData(normalizedValues)) && this._snapshot.status !== 'running') {
          this._setStatus('running');
        }
        continue;
      }

      if (isCapabilitiesMessage(msg)) {
        if (Array.isArray(msg.items)) {
          this._snapshot.categories = msg.items
            .map((item) => String(item || '').trim())
            .filter(Boolean);
        }
        continue;
      }

      if (isErrorMessage(msg)) {
        const errorMessage = typeof msg.message === 'string' && msg.message.trim()
          ? msg.message
          : 'unknown';
        this._setStatus('error', errorMessage);
      }
    }
  }

  _onStderr(chunk: Buffer | string): void {
    const text = chunk.toString('utf8').trim();
    if (!text) return;
    const looksFatal =
      text.includes('Traceback') ||
      text.includes('ModuleNotFoundError') ||
      text.includes('ImportError') ||
      text.includes('SyntaxError') ||
      text.includes("panicked at") ||
      text.includes("thread '");
    if (looksFatal) {
      this._setStatus('error', text.slice(0, 400));
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) console.log(`[SDK-sidecar:${this._adapter.id}] ${trimmed}`);
    }
  }

  _writePidFile(pid: number | undefined): void {
    if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return;
    try { writeSidecarPidRecord(this._pidFilePath, pid, this._ownerIdentity); } catch {}
  }

  _clearPidFile(expectedPid?: number): void {
    clearSidecarPidFile(this._pidFilePath, expectedPid);
  }

  _cleanupStaleSidecarProcesses(cleanupToken: string): void {
    this._cleanupFromPidFile(cleanupToken);
    this._cleanupByCommandLineScan(cleanupToken);
  }

  _cleanupFromPidFile(cleanupToken: string): void {
    for (const pidFilePath of listOwnedPidFilePaths(this._pidFilePath, this._ownerIdentity)) {
      const record = readSidecarPidRecord(pidFilePath);
      if (!record) {
        if (pidFilePath === this._pidFilePath) clearSidecarPidFile(pidFilePath);
        continue;
      }
      if (record.pid === process.pid) {
        clearSidecarPidFile(pidFilePath);
        continue;
      }

      const childMetadata = this._readProcessMetadata(record.pid);
      if (!childMetadata) {
        try {
          process.kill(record.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') {
            clearSidecarPidFile(pidFilePath);
          }
        }
        continue;
      }
      if (!isProcessOwnedByCurrentWindowsUser(childMetadata, this._ownerIdentity)) continue;

      const locallyOwned = record.version >= 1
        && record.ownerPid === this._ownerIdentity.pid
        && record.ownerToken === this._ownerIdentity.token;
      const commandLine = this._readProcessCommandLine(record.pid);
      if (!this._commandLineMatchesCleanupToken(commandLine, cleanupToken)
        || !this._commandLineMatchesRole(commandLine)) {
        // A different installation can use the same temp-directory prefix.
        // Preserve its modern ownership record; only this backend's record or
        // an unowned legacy record is safe for us to discard.
        if (locallyOwned || record.version < 1) clearSidecarPidFile(pidFilePath);
        continue;
      }

      const ownerGone = record.version >= 1
        ? commandLineMatchesOwnerRecord(commandLine, record)
          && (locallyOwned
            || isRecordedOwnerDemonstrablyGone(record, (pid) => this._readProcessMetadata(pid)))
        : isLegacySidecarDemonstrablyOrphaned(
            childMetadata,
            (pid) => this._readProcessMetadata(pid),
          );
      if (!ownerGone) continue;

      try {
        process.kill(record.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') {
          clearSidecarPidFile(pidFilePath);
        }
        continue;
      }
      const confirmedChild = this._readProcessMetadata(record.pid);
      if (!isProcessOwnedByCurrentWindowsUser(confirmedChild, this._ownerIdentity)) continue;
      if (!isSameProcessInstance(childMetadata, confirmedChild)) continue;
      const confirmedCommandLine = this._readProcessCommandLine(record.pid);
      if (!this._commandLineMatchesCleanupToken(confirmedCommandLine, cleanupToken)
        || !this._commandLineMatchesRole(confirmedCommandLine)) continue;
      try {
        process.kill(record.pid, 'SIGKILL');
      } catch {}
      clearSidecarPidFile(pidFilePath);
    }
  }

  _isProcessOwnedByCleanupToken(pid: number, cleanupToken: string): boolean {
    const commandLine = this._readProcessCommandLine(pid);
    return this._commandLineMatchesCleanupToken(commandLine, cleanupToken)
      && this._commandLineMatchesRole(commandLine);
  }

  _commandLineMatchesRole(commandLine: string | null | undefined): boolean {
    return /(?:^|\s)--sdk-clientdata-bridge(?:\s|$)/i.test(commandLine || '')
      && !/(?:^|\s)--simvars-bridge(?:\s|$)/i.test(commandLine || '');
  }

  _commandLineMatchesCleanupToken(commandLine: string | null | undefined, cleanupToken: string): boolean {
    const command = String(commandLine || '').trim().toLowerCase();
    const token = String(cleanupToken || '').trim().toLowerCase();
    if (!command || !token) return false;
    return command.includes(token) || command.replace(/\//g, '\\').includes(token.replace(/\//g, '\\'));
  }

  _readProcessCommandLine(pid: number): string | null {
    const normalizedPid = Math.trunc(Number(pid));
    if (!Number.isFinite(normalizedPid) || normalizedPid <= 0) return null;

    if (process.platform === 'win32') {
      const psScript = [
        `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${normalizedPid}"`,
        'if ($p -and $p.CommandLine) { [Console]::Out.Write($p.CommandLine) }',
      ].join('; ');
      try {
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 3000,
        });
        return result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim()
          ? result.stdout.trim()
          : null;
      } catch {
        return null;
      }
    }

    try {
      const cmdline = fs.readFileSync(`/proc/${normalizedPid}/cmdline`, 'utf8')
        .replace(/\0/g, ' ')
        .trim();
      return cmdline || null;
    } catch {
      return null;
    }
  }

  _readProcessMetadata(pid: number): ProcessMetadata | null {
    return readProcessMetadata(pid);
  }

  _buildCleanupScanScript(cleanupToken: string): string | null {
    return buildParentSafeWindowsCleanupScript(cleanupToken, 'sdk-clientdata');
  }

  _cleanupByCommandLineScan(cleanupToken: string): void {
    if (process.platform !== 'win32') return;
    const psScript = this._buildCleanupScanScript(cleanupToken);
    if (!psScript) return;
    try {
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5000,
      });
    } catch {}
  }
}

module.exports = { SdkBridge };

export {};
