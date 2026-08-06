'use strict';

const path = require('path') as typeof import('path');
const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const { spawn, spawnSync } = require('child_process') as typeof import('child_process');
const config = require('../core/config') as ConfigModule;
const {
  selectNewestManagedRustSidecar,
} = require('../../shared/rust-sidecar-artifact.js') as {
  selectNewestManagedRustSidecar: (
    telemetryProviderDir: string,
    binaryName: string,
  ) => string | null;
};
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
  buildParentSafeWindowsCleanupScript: (cleanupToken: string, role: 'simvars') => string | null;
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

type ConfigModule = {
  lvarSidecar?: {
    dllPath?: string;
    binaryPath?: string;
  };
  simconnect?: {
    rustMaxVars?: number;
  };
};

type BridgeStatus = 'disabled' | 'error' | 'starting' | 'ready' | 'connected' | 'simvars_updated' | 'running' | 'stopped' | 'disconnected' | string;

type SimvarSubscription = {
  key: string;
  expression?: string;
  simvar?: string;
  unit?: string;
  dataType?: string;
  isolated?: boolean;
};

type SnapshotMessage = {
  type: 'snapshot';
  stream?: string;
  source?: string;
  librarySpec?: string;
  values?: Record<string, unknown>;
  timestampIso?: string | null;
};

type StatusMessage = {
  type: 'status';
  source?: string;
  librarySpec?: string;
  state?: string;
  error?: string | null;
};

type ReadyMessage = {
  type: 'ready';
  source?: string;
  librarySpec?: string;
};

type ErrorMessage = {
  type: 'error';
  message?: string;
};

type SystemStateMessage = {
  type: 'systemState';
  name?: string;
  integer?: number;
  float?: number;
  string?: string;
  timestampIso?: string;
};

type SystemEventMessage = {
  type: 'systemEvent';
  name?: string;
  timestampIso?: string;
};

type LifecycleMessage = {
  type: 'lifecycle';
  event?: string;
};

type ExceptionMessage = {
  type: 'exception';
  exception?: number;
  sendId?: number;
  index?: number;
};

type FacilityAirportMessage = {
  type: 'facilityAirport';
  ok?: boolean;
  requestId?: number;
  icao?: string | null;
  airport?: Record<string, unknown> | null;
  airportName?: string | null;
  runways?: Array<Record<string, unknown>>;
  error?: string | null;
};

type SidecarMessage =
  | ReadyMessage
  | StatusMessage
  | SnapshotMessage
  | SystemStateMessage
  | SystemEventMessage
  | LifecycleMessage
  | ExceptionMessage
  | FacilityAirportMessage
  | ErrorMessage
  | Record<string, unknown>;

type RustSimvarSnapshot = {
  enabled: boolean;
  source: string;
  librarySpec: string | null;
  status: BridgeStatus;
  subscriptions: SimvarSubscription[];
  values: Record<string, unknown>;
  updatedAt: string | null;
  error: string | null;
};

type RustSimvarBridgeOptions = {
  enabled?: boolean;
  chunkSize?: number;
  pollIntervalMs?: number;
  onSnapshot?: (snapshot: RustSimvarSnapshot) => void;
  onStatus?: (snapshot: RustSimvarSnapshot) => void;
  onSystemState?: (message: SystemStateMessage) => void;
  onSystemEvent?: (message: SystemEventMessage) => void;
  onLifecycle?: (message: LifecycleMessage) => void;
  onException?: (message: ExceptionMessage) => void;
};

type PendingFacilityRequest = {
  timer: NodeJS.Timeout;
  resolve: (message: FacilityAirportMessage) => void;
};

const FACILITY_REQUEST_TIMEOUT_MS = 4000;

function normalizeFacilityIcao(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (normalized.length < 2 || normalized.length > 8) return null;
  if (!/^[A-Z0-9_]+$/.test(normalized)) return null;
  return normalized;
}

function normalizeFacilityRegion(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toUpperCase();
  if (normalized.length > 8) return '';
  if (!/^[A-Z0-9_-]*$/.test(normalized)) return '';
  return normalized;
}

function resolveRustBinaryPath(): string | null {
  const unique = new Set<string>();
  const candidates: string[] = [];
  const exeName = process.platform === 'win32'
    ? 'ff-rust-simconnect-sidecar.exe'
    : 'ff-rust-simconnect-sidecar';
  const repoRoot = path.resolve(__dirname, '..', '..');
  const normalizeCandidate = (value: unknown): string | null => {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (path.basename(trimmed).toLowerCase() !== exeName.toLowerCase()) return null;
    return path.resolve(trimmed);
  };
  const pushCandidate = (value: unknown): void => {
    const candidate = normalizeCandidate(value);
    if (!candidate || unique.has(candidate)) return;
    unique.add(candidate);
    candidates.push(candidate);
  };

  pushCandidate(config.lvarSidecar?.binaryPath);
  pushCandidate(selectNewestManagedRustSidecar(__dirname, exeName));
  pushCandidate(path.join(__dirname, 'rust-simconnect-sidecar', 'target', 'release', exeName));
  pushCandidate(path.join(__dirname, 'rust-simconnect-sidecar', 'target', 'debug', exeName));
  pushCandidate(path.join(repoRoot, 'backend-build', 'telemetry-provider', exeName));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function buildSidecarEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (typeof config.lvarSidecar?.dllPath === 'string' && config.lvarSidecar.dllPath.trim()) {
    env.FF_SIMCONNECT_DLL_PATH = config.lvarSidecar.dllPath.trim();
  }
  env.SIMCONNECT_PROVIDER = 'rust';
  return env;
}

const MIN_OWNER_LIFELINE_VERSION = 1;

function supportsRequiredOwnerLifeline(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const version = (payload as Record<string, unknown>).ownerLifelineVersion;
  return typeof version === 'number'
    && Number.isSafeInteger(version)
    && version >= MIN_OWNER_LIFELINE_VERSION;
}

function probeRustBinary(command: string): { ok: boolean; error: string | null } {
  const probe = spawnSync(command, ['--probe'], {
    encoding: 'utf8',
    env: buildSidecarEnv(),
    windowsHide: true,
    timeout: 5000,
  });
  const stdout = String(probe?.stdout || '');
  const stderr = String(probe?.stderr || '');
  const line = stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .pop();
  let payload: Record<string, unknown> | null = null;
  if (line) {
    try {
      payload = JSON.parse(line);
    } catch {}
  }

  const successfulProbe = probe?.status === 0 && payload?.ok === true;
  if (successfulProbe && supportsRequiredOwnerLifeline(payload)) {
    return { ok: true, error: null };
  }

  return {
    ok: false,
    error: successfulProbe
      ? `rust sidecar does not advertise ownerLifelineVersion >= ${MIN_OWNER_LIFELINE_VERSION}`
      : typeof payload?.error === 'string'
      ? payload.error
      : [stdout.trim(), stderr.trim()].filter(Boolean).join(' | ') || `probe exited with status ${probe?.status ?? 'unknown'}`,
  };
}

class RustSimvarBridge {
  _proc: import('child_process').ChildProcessWithoutNullStreams | null;
  _lineBuffer: string;
  _started: boolean;
  _stopping: boolean;
  _startPromise: Promise<void> | null;
  _stopPromise: Promise<void> | null;
  _pidFilePath: string;
  _ownerIdentity: BackendOwnerIdentity;
  _subscriptions: SimvarSubscription[];
  _enabled: boolean;
  _chunkSize: number;
  _pollIntervalMs: number;
  _onSnapshot: ((snapshot: RustSimvarSnapshot) => void) | null;
  _onStatus: ((snapshot: RustSimvarSnapshot) => void) | null;
  _onSystemState: ((message: SystemStateMessage) => void) | null;
  _onSystemEvent: ((message: SystemEventMessage) => void) | null;
  _onLifecycle: ((message: LifecycleMessage) => void) | null;
  _onException: ((message: ExceptionMessage) => void) | null;
  _snapshot: RustSimvarSnapshot;
  _lastStatusLogKey: string | null;
  _nextFacilityRequestId: number;
  _pendingFacilityRequests: Map<number, PendingFacilityRequest>;

  constructor(options: RustSimvarBridgeOptions = {}) {
    this._proc = null;
    this._lineBuffer = '';
    this._started = false;
    this._stopping = false;
    this._startPromise = null;
    this._stopPromise = null;
    this._ownerIdentity = getBackendOwnerIdentity();
    this._pidFilePath = buildOwnedPidFilePath(
      path.join(os.tmpdir(), 'flight-fabric-rust-simvars-sidecar.pid'),
      this._ownerIdentity,
    );
    this._subscriptions = [];
    this._enabled = options.enabled ?? true;
    this._chunkSize = Math.max(1, Math.min(64, Number(options.chunkSize || 20)));
    this._pollIntervalMs = Math.max(50, Math.min(5000, Number(options.pollIntervalMs || 200)));
    this._onSnapshot = typeof options.onSnapshot === 'function' ? options.onSnapshot : null;
    this._onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
    this._onSystemState = typeof options.onSystemState === 'function' ? options.onSystemState : null;
    this._onSystemEvent = typeof options.onSystemEvent === 'function' ? options.onSystemEvent : null;
    this._onLifecycle = typeof options.onLifecycle === 'function' ? options.onLifecycle : null;
    this._onException = typeof options.onException === 'function' ? options.onException : null;
    this._lastStatusLogKey = null;
    this._nextFacilityRequestId = 1;
    this._pendingFacilityRequests = new Map();
    this._snapshot = {
      enabled: this._enabled,
      source: 'rust-sidecar',
      librarySpec: null,
      status: this._enabled ? 'starting' : 'disabled',
      subscriptions: [],
      values: {},
      updatedAt: null,
      error: null,
    };
  }

  isEnabled(): boolean {
    return this._enabled;
  }

  _buildLaunchArgs(): string[] {
    return ['--simvars-bridge', ...getSidecarOwnerArgs(this._ownerIdentity)];
  }

  async start(): Promise<void> {
    if (this._stopPromise) {
      await this._stopPromise;
    }
    if (this._startPromise) {
      await this._startPromise;
      return;
    }
    if (!this._enabled) {
      this._setStatus('disabled');
      return;
    }
    if (this._started) return;
    this._stopping = false;

    const command = resolveRustBinaryPath();
    if (!command) {
      this._setStatus('error', 'Rust SimVar sidecar binary not found.');
      return;
    }

    const probe = probeRustBinary(command);
    if (!probe.ok) {
      this._setStatus('error', `Rust SimVar sidecar probe failed: ${probe.error || 'unknown'}`.slice(0, 500));
      return;
    }

    this._cleanupStaleSidecarProcesses(command);

    let child: import('child_process').ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, this._buildLaunchArgs(), {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: buildSidecarEnv(),
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this._setStatus('error', `Rust SimVar sidecar spawn failed: ${failure.message}`.slice(0, 500));
      throw failure;
    }
    this._proc = child;

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
        if (this._proc !== child || this._stopPromise || this._stopping) {
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
          this._stopping = false;
          this._rejectPendingFacilityRequests(failure.message);
          this._setStatus('error', `Rust SimVar sidecar spawn failed: ${failure.message}`.slice(0, 500));
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

    if (this._proc === child && this._started && this._subscriptions.length > 0) {
      this.setSimVars(this._subscriptions);
    }
  }

  _handleProcessError(
    child: import('child_process').ChildProcessWithoutNullStreams,
    error: Error,
  ): void {
    if (this._proc !== child) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this._rejectPendingFacilityRequests(failure.message);
    this._setStatus('error', `Rust SimVar sidecar process error: ${failure.message}`.slice(0, 500));
  }

  _handlePipeError(
    child: import('child_process').ChildProcessWithoutNullStreams,
    pipe: 'stdout' | 'stderr',
    error: Error,
  ): void {
    if (this._proc !== child) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this._setStatus('error', `Rust SimVar sidecar ${pipe} error: ${failure.message}`.slice(0, 500));
  }

  _handleStdinError(
    child: import('child_process').ChildProcessWithoutNullStreams,
    error: Error,
  ): void {
    if (this._proc !== child) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this._rejectPendingFacilityRequests(failure.message);
    this._setStatus('error', `Rust SimVar sidecar stdin error: ${failure.message}`.slice(0, 500));
  }

  _handleProcessExit(
    child: import('child_process').ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this._proc !== child) return;

    const wasStopping = this._stopping;
    this._clearPidFile(child.pid);
    this._started = false;
    this._proc = null;
    this._stopping = false;
    this._rejectPendingFacilityRequests(`exit:${code ?? 'null'} signal:${signal ?? 'null'}`);
    this._setStatus(
      'stopped',
      wasStopping ? null : `exit:${code ?? 'null'} signal:${signal ?? 'null'}`,
    );
  }

  async stop(): Promise<void> {
    if (this._stopPromise) {
      await this._stopPromise;
      return;
    }

    const pendingStart = this._startPromise;
    this._stopping = this._proc != null || pendingStart != null;
    this._started = false;
    this._rejectPendingFacilityRequests('stopped');
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
          this._stopping = false;
          const error = new Error(
            `Rust SimVar sidecar PID ${child?.pid ?? 'unknown'} did not exit after forced shutdown`,
          );
          this._setStatus('error', error.message);
          throw error;
        }

        if (this._proc === child) {
          this._proc = null;
        }
        this._clearPidFile(child?.pid);
        this._stopping = false;
        if (this._enabled) this._setStatus('stopped');
      } catch (error) {
        if (this._proc === child && child) {
          this._started = true;
        }
        this._stopping = false;
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

  _writePidFile(pid: number | undefined): void {
    if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return;
    try {
      writeSidecarPidRecord(this._pidFilePath, pid, this._ownerIdentity);
    } catch {}
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
    return /(?:^|\s)--simvars-bridge(?:\s|$)/i.test(commandLine || '')
      && !/(?:^|\s)--sdk-clientdata-bridge(?:\s|$)/i.test(commandLine || '');
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
    return buildParentSafeWindowsCleanupScript(cleanupToken, 'simvars');
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

  setSimVars(subscriptions: SimvarSubscription[]): void {
    this._subscriptions = Array.isArray(subscriptions) ? subscriptions : [];
    this._snapshot.subscriptions = [...this._subscriptions];
    if (!this._enabled || !this._started || !this._proc) return;
    this._send({
      type: 'setSimVars',
      chunkSize: this._chunkSize,
      pollIntervalMs: this._pollIntervalMs,
      subscriptions: this._subscriptions,
    });
  }

  getSnapshot(): RustSimvarSnapshot {
    return {
      ...this._snapshot,
      subscriptions: [...this._snapshot.subscriptions],
      values: { ...this._snapshot.values },
    };
  }

  requestFacilityAirport(
    icao: unknown,
    options: { region?: unknown; timeoutMs?: number } = {},
  ): Promise<FacilityAirportMessage> {
    const normalizedIcao = normalizeFacilityIcao(icao);
    if (!normalizedIcao) {
      return Promise.resolve({
        type: 'facilityAirport',
        ok: false,
        icao: typeof icao === 'string' ? icao : null,
        error: 'invalid_icao',
      });
    }
    if (!this._enabled || !this._started || !this._proc || this._proc.killed) {
      return Promise.resolve({
        type: 'facilityAirport',
        ok: false,
        icao: normalizedIcao,
        error: 'not_started',
      });
    }

    const requestId = this._nextFacilityRequestId++;
    const timeoutMs = Math.max(500, Math.min(15000, Number(options.timeoutMs || FACILITY_REQUEST_TIMEOUT_MS)));
    const region = normalizeFacilityRegion(options.region);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pendingFacilityRequests.delete(requestId);
        resolve({
          type: 'facilityAirport',
          ok: false,
          requestId,
          icao: normalizedIcao,
          error: 'timeout',
        });
      }, timeoutMs);

      this._pendingFacilityRequests.set(requestId, { timer, resolve });
      this._send({
        type: 'requestFacilityAirport',
        requestId,
        icao: normalizedIcao,
        region,
      });
    });
  }

  _setStatus(status: BridgeStatus, error: string | null = null): void {
    const previous = this._snapshot.status;
    this._snapshot.status = status;
    this._snapshot.error = error;
    const errorText = error ? String(error).slice(0, 180) : '';
    const logKey = `${status}|${errorText}`;
    const shouldLog = previous !== status || (Boolean(errorText) && this._lastStatusLogKey !== logKey);
    if (shouldLog) {
      const suffix = errorText ? ` error=${errorText}` : '';
      console.log(`[RustSimVars] status ${previous} -> ${status}${suffix}`);
      this._lastStatusLogKey = logKey;
    }
    if (this._onStatus) {
      this._onStatus(this.getSnapshot());
    }
  }

  _send(message: Record<string, unknown>): void {
    const child = this._proc;
    const stdin = child?.stdin;
    if (
      !child
      || !stdin
      || child.killed
      || stdin.destroyed
      || stdin.writableEnded
      || stdin.writable === false
    ) return;
    try {
      stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this._handleStdinError(
        child,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  _settleFacilityRequest(message: FacilityAirportMessage): void {
    const requestId = Number(message.requestId);
    if (!Number.isInteger(requestId)) return;
    const pending = this._pendingFacilityRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this._pendingFacilityRequests.delete(requestId);
    pending.resolve(message);
  }

  _rejectPendingFacilityRequests(error: string): void {
    for (const [requestId, pending] of this._pendingFacilityRequests.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({
        type: 'facilityAirport',
        ok: false,
        requestId,
        error,
      });
    }
    this._pendingFacilityRequests.clear();
  }

  _onStdout(chunk: Buffer | string): void {
    if (this._stopping) return;
    this._lineBuffer += chunk.toString('utf8');
    if (this._lineBuffer.length > 1024 * 1024) {
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
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (msg.type === 'ready') {
        if (typeof msg.source === 'string' && msg.source.trim()) {
          this._snapshot.source = msg.source.trim();
        }
        if (typeof msg.librarySpec === 'string' && msg.librarySpec.trim()) {
          this._snapshot.librarySpec = msg.librarySpec.trim();
        }
        this._setStatus('ready');
        this.setSimVars(this._subscriptions);
        continue;
      }

      if (msg.type === 'status') {
        if (typeof msg.source === 'string' && msg.source.trim()) {
          this._snapshot.source = msg.source.trim();
        }
        if (typeof msg.librarySpec === 'string' && msg.librarySpec.trim()) {
          this._snapshot.librarySpec = msg.librarySpec.trim();
        }
        this._setStatus(
          typeof msg.state === 'string' && msg.state.trim() ? msg.state.trim() : 'unknown',
          typeof msg.error === 'string' && msg.error.trim() ? msg.error.trim() : null,
        );
        continue;
      }

      if (msg.type === 'snapshot') {
        if (msg.stream && msg.stream !== 'simvars') continue;
        if (typeof msg.source === 'string' && msg.source.trim()) {
          this._snapshot.source = msg.source.trim();
        }
        if (typeof msg.librarySpec === 'string' && msg.librarySpec.trim()) {
          this._snapshot.librarySpec = msg.librarySpec.trim();
        }
        this._snapshot.values = msg.values && typeof msg.values === 'object'
          ? { ...msg.values }
          : {};
        this._snapshot.updatedAt = typeof msg.timestampIso === 'string' && msg.timestampIso.trim()
          ? msg.timestampIso
          : null;
        if (Object.values(this._snapshot.values).some((value) => value != null)) {
          this._setStatus('running');
        }
        if (this._onSnapshot) {
          this._onSnapshot(this.getSnapshot());
        }
        continue;
      }

      if (msg.type === 'systemState') {
        this._onSystemState?.(msg as SystemStateMessage);
        continue;
      }

      if (msg.type === 'systemEvent') {
        this._onSystemEvent?.(msg as SystemEventMessage);
        continue;
      }

      if (msg.type === 'lifecycle') {
        this._onLifecycle?.(msg as LifecycleMessage);
        continue;
      }

      if (msg.type === 'exception') {
        this._onException?.(msg as ExceptionMessage);
        continue;
      }

      if (msg.type === 'facilityAirport') {
        this._settleFacilityRequest(msg as FacilityAirportMessage);
        continue;
      }

      if (msg.type === 'facilityDebug') {
        const event = typeof msg.event === 'string' && msg.event.trim()
          ? msg.event.trim()
          : 'debug';
        const details = { ...msg };
        delete details.type;
        delete details.event;
        delete details.source;
        delete details.backend;
        delete details.timestampIso;
        console.log(`[MSFS Facilities] sidecar ${event} ${JSON.stringify(details)}`);
        continue;
      }

      if (msg.type === 'error') {
        this._setStatus('error', typeof msg.message === 'string' ? msg.message : 'unknown');
      }
    }
  }

  _onStderr(chunk: Buffer | string): void {
    if (this._stopping) return;
    const text = chunk.toString('utf8').trim();
    if (!text) return;
    if (text.includes('panicked at') || text.includes("thread '")) {
      this._setStatus('error', text.slice(0, 500));
    }
  }
}

module.exports = {
  RustSimvarBridge,
  supportsRequiredOwnerLifeline,
};

export {};
