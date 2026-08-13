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
  buildParentSafeWindowsCleanupScript: (cleanupToken: string, role: 'lvar') => string | null;
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
    enable?: boolean;
    autoEnable?: boolean;
    dllPath?: string;
    binaryPath?: string;
  };
  simconnect?: {
    provider?: string;
  };
  touchdownShake?: {
    enable?: boolean;
  };
};

type BridgeStatus = 'disabled' | 'error' | 'starting' | 'stopped' | 'ready' | 'connecting' | 'disconnected' | 'running' | string;
type MobiFlightState = 'connecting' | 'connected' | 'missing' | 'disabled' | 'error' | 'disconnected' | string;
type LaunchProvider = 'rust';

type Subscription = {
  key?: string;
  [key: string]: unknown;
};

type SnapshotState = {
  enabled: boolean;
  source: string;
  librarySpec: string | null;
  status: BridgeStatus;
  profileId: string;
  subscriptions: Subscription[];
  values: Record<string, unknown>;
  snapshotSequence: number;
  updatedAt: string | null;
  error: string | null;
  mobiflight: {
    state: MobiFlightState;
    connected: boolean;
    available: boolean;
    error: string | null;
    updatedAt: string | null;
  };
};

type LaunchSpec = {
  provider: LaunchProvider;
  source: string;
  command: string;
  args: string[];
  cleanupToken: string;
};

type ProbeResult = {
  ok: boolean;
  detail: string | null;
};

type PendingAckMessage = {
  type: string;
  requestId?: number;
  ok?: boolean;
  error?: string | null;
  [key: string]: unknown;
};

type PendingRequest = {
  ackType: string;
  resolve: (message: PendingAckMessage) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type ReadyMessage = {
  type: 'ready';
  source?: string;
  librarySpec?: string;
};

type StatusMessage = {
  type: 'status';
  source?: string;
  librarySpec?: string;
  state?: string;
  error?: string | null;
  subscriptionGeneration?: number;
};

type MobiFlightStatusMessage = {
  type: 'mobiflightStatus';
  state?: string;
  status?: string;
  connected?: boolean;
  available?: boolean;
  error?: string | null;
};

type SnapshotMessage = {
  type: 'snapshot';
  source?: string;
  librarySpec?: string;
  values?: Record<string, unknown>;
  timestampIso?: string | null;
  subscriptionGeneration?: number;
};

type ErrorMessage = {
  type: 'error';
  message?: string;
};

type SimConnectExceptionRecord = {
  exception: number | null;
  sendId: number;
  index: number | null;
  receivedAtMs: number;
};

type AckType =
  | 'sendEventAck'
  | 'sendSdkEventAck'
  | 'sendViewEventAck'
  | 'setNamedVarAck'
  | 'sendInputEventAck'
  | 'executeMobiFlightCodeAck'
  | 'eyepointOffsetAck'
  | 'cameraShakeAck';

type AckMessage = PendingAckMessage & {
  type: AckType;
};

type SidecarMessage = ReadyMessage | StatusMessage | MobiFlightStatusMessage | SnapshotMessage | ErrorMessage | AckMessage | Record<string, unknown>;

type NamedVarOptions = {
  name?: string;
  unit?: string;
  value?: unknown;
  dataType?: string;
};

type CameraShakeOptions = {
  pitch?: number;
  bank?: number;
  heading?: number;
  dx?: number;
  dy?: number;
  dz?: number;
};

type EyepointOffsetOptions = {
  x?: number;
  y?: number;
  z?: number;
  units?: string;
};

const SIDECAR_NAME_RE = /^[A-Za-z0-9 _./:#+%()-]+$/;
const SIDECAR_UNIT_RE = /^[A-Za-z0-9 _./:+%()-]+$/;
const MAX_SIDECAR_NAME_LENGTH = 160;
const MAX_SIDECAR_UNIT_LENGTH = 48;
const MAX_SIDECAR_NUMERIC_ABS = 1_000_000;
const MAX_SIDECAR_EVENT_DATA_ABS = 1_000_000;
const MAX_MOBIFLIGHT_CODE_LENGTH = 2048;
const MAX_CAMERA_OFFSET_METERS = 2;
const MAX_CAMERA_ANGLE_DEGREES = 15;
const MIN_OWNER_LIFELINE_VERSION = 1;
const ALLOWED_SIDECAR_DATA_TYPES = new Set(['float64', 'float32', 'int32', 'bool']);

function buildRejectedAck(type: AckType, error: string, extra: Record<string, unknown> = {}): PendingAckMessage {
  return {
    type,
    ok: false,
    error,
    ...extra,
  };
}

function isSafeSidecarToken(value: unknown, maxLength: number, pattern: RegExp): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && pattern.test(value);
}

function normalizeFiniteSidecarNumber(value: unknown, maxAbs = MAX_SIDECAR_NUMERIC_ABS): number | null {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && Math.abs(numericValue) <= maxAbs
    ? numericValue
    : null;
}

function normalizeSubscriptionGeneration(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function isSafeMobiFlightCode(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_MOBIFLIGHT_CODE_LENGTH
    && /^[\x09\x0A\x0D\x20-\x7E]+$/.test(value)
    && !value.includes('\0');
}

function isSafeCameraNumber(value: unknown, maxAbs: number): boolean {
  return normalizeFiniteSidecarNumber(value, maxAbs) != null;
}

function supportsRequiredOwnerLifeline(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const version = (payload as Record<string, unknown>).ownerLifelineVersion;
  return typeof version === 'number'
    && Number.isSafeInteger(version)
    && version >= MIN_OWNER_LIFELINE_VERSION;
}

class LvarSidecarBridge {
  _proc: import('child_process').ChildProcessWithoutNullStreams | null;
  _started: boolean;
  _startPromise: Promise<void> | null;
  _stopPromise: Promise<void> | null;
  _lineBuffer: string;
  _subscriptions: Subscription[];
  _nextRequestId: number;
  _pendingRequests: Map<number, PendingRequest>;
  _resolvedLaunchSpec: LaunchSpec | null;
  _resolvedRustPath: string | null;
  _autoEnabled: boolean | null;
  _lastBackendProbeError: string | null;
  _pidFilePath: string;
  _ownerIdentity: BackendOwnerIdentity;
  _snapshot: SnapshotState;
  _onReadyCallback: (() => void) | null;
  _recentSimConnectExceptions: SimConnectExceptionRecord[];
  _consecutiveAllNullSnapshots: number;
  _awaitingSubscriptionRefresh: boolean;
  _subscriptionGeneration: number;

  constructor() {
    this._proc = null;
    this._started = false;
    this._startPromise = null;
    this._stopPromise = null;
    this._lineBuffer = '';
    this._subscriptions = [];
    this._nextRequestId = 1;
    this._pendingRequests = new Map();
    this._resolvedLaunchSpec = null;
    this._resolvedRustPath = null;
    this._autoEnabled = null;
    this._lastBackendProbeError = null;
    this._ownerIdentity = getBackendOwnerIdentity();
    this._pidFilePath = buildOwnedPidFilePath(
      path.join(os.tmpdir(), 'flight-fabric-lvar-sidecar.pid'),
      this._ownerIdentity,
    );
    this._onReadyCallback = null;
    this._recentSimConnectExceptions = [];
    this._consecutiveAllNullSnapshots = 0;
    this._awaitingSubscriptionRefresh = false;
    this._subscriptionGeneration = 0;
    this._snapshot = {
      enabled: false,
      source: 'sidecar',
      librarySpec: null,
      status: 'disabled',
      profileId: 'generic',
      subscriptions: [],
      values: {},
      snapshotSequence: 0,
      updatedAt: null,
      error: null,
      mobiflight: {
        state: 'disabled',
        connected: false,
        available: false,
        error: null,
        updatedAt: null,
      },
    };
  }

  _setStatus(status: BridgeStatus, error: string | null = null): void {
    const prevStatus = this._snapshot.status;
    const prevError = this._snapshot.error;
    this._snapshot.status = status;
    this._snapshot.error = error;
    if (status !== prevStatus || (error && error !== prevError)) {
      const errSuffix = error ? ` error=${String(error).slice(0, 200)}` : '';
      console.log(`[LVAR-bridge] status ${prevStatus} → ${status}${errSuffix}`);
    }
  }

  isEnabled(): boolean {
    if (config.lvarSidecar?.enable === true) {
      this._snapshot.enabled = true;
      return true;
    }

    if (!config.lvarSidecar?.autoEnable) {
      this._snapshot.enabled = false;
      return false;
    }

    const enabled = this._resolveAutoEnable();
    this._snapshot.enabled = enabled;
    return enabled;
  }

  _resolveAutoEnable(): boolean {
    if (this._autoEnabled != null) {
      return this._autoEnabled;
    }

    const launchSpec = this._resolveLaunchSpec();
    if (!launchSpec) {
      this._autoEnabled = false;
      return false;
    }

    this._resolvedLaunchSpec = launchSpec;
    this._snapshot.source = launchSpec.source;
    this._autoEnabled = true;
    return true;
  }

  _getProviderPreference(): 'rust' | 'auto' {
    const raw = typeof config.simconnect?.provider === 'string'
      ? config.simconnect.provider.trim().toLowerCase()
      : 'auto';
    if (raw === 'rust') {
      return 'rust';
    }
    return 'auto';
  }

  _resolveLaunchSpec(): LaunchSpec | null {
    if (this._resolvedLaunchSpec) {
      return this._resolvedLaunchSpec;
    }

    const preference = this._getProviderPreference();
    const launchSpec = this._resolveRustLaunchSpec();
    if (launchSpec) {
      this._resolvedLaunchSpec = launchSpec;
      this._snapshot.source = launchSpec.source;
      return launchSpec;
    }

    this._lastBackendProbeError = this._lastBackendProbeError
      || (preference === 'rust'
        ? 'Rust sidecar is required but could not be resolved.'
        : 'Rust sidecar could not be resolved.');
    return null;
  }

  _resolveRustLaunchSpec(): LaunchSpec | null {
    const rustBinaryPath = this._resolveRustBinaryPath();
    if (!rustBinaryPath) {
      return null;
    }

    const probe = this._probeRustBinary(rustBinaryPath);
    if (!probe.ok) {
      this._lastBackendProbeError = probe.detail || 'rust sidecar probe failed';
      console.log(`[LVAR-bridge] rust candidate rejected (probe failed): ${rustBinaryPath}${this._lastBackendProbeError ? ` :: ${this._lastBackendProbeError}` : ''}`);
      return null;
    }

    this._lastBackendProbeError = null;
    this._resolvedRustPath = rustBinaryPath;
    console.log(`[LVAR-bridge] rust sidecar resolved: ${rustBinaryPath}`);
    return {
      provider: 'rust',
      source: 'rust-sidecar',
      command: rustBinaryPath,
      args: [],
      cleanupToken: rustBinaryPath,
    };
  }

  _resolveRustBinaryPath(): string | null {
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
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    this._lastBackendProbeError = `Rust sidecar binary not found. Tried: ${candidates.join(', ') || '(none)'}`;
    return null;
  }

  _probeRustBinary(command: string): ProbeResult {
    const probe = spawnSync(command, ['--probe'], {
      encoding: 'utf8',
      env: this._buildSidecarEnv(),
      windowsHide: true,
      timeout: 5000,
    });
    const stdout = probe?.stdout || '';
    const stderr = probe?.stderr || '';
    const detailText = [stdout, stderr]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(' | ');
    const payloadLine = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop();
    let payload = null;
    if (payloadLine) {
      try {
        payload = JSON.parse(payloadLine);
      } catch {}
    }

    const successfulProbe = Boolean(probe && probe.status === 0 && payload?.ok === true);
    if (successfulProbe && supportsRequiredOwnerLifeline(payload)) {
      return { ok: true, detail: payload.librarySpec || null };
    }

    return {
      ok: false,
      detail: successfulProbe
        ? `rust sidecar does not advertise ownerLifelineVersion >= ${MIN_OWNER_LIFELINE_VERSION}`
        : payload?.error || detailText || `rust sidecar probe exited with status ${probe?.status ?? 'unknown'}`,
    };
  }

  _buildSidecarEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (typeof config.lvarSidecar?.dllPath === 'string' && config.lvarSidecar.dllPath.trim()) {
      env.FF_SIMCONNECT_DLL_PATH = config.lvarSidecar.dllPath.trim();
    }
    env.SIMCONNECT_PROVIDER = 'rust';
    return env;
  }

  _buildLaunchArgs(args: string[] = []): string[] {
    return [...args, ...getSidecarOwnerArgs(this._ownerIdentity)];
  }

  async start(): Promise<void> {
    if (this._stopPromise) {
      await this._stopPromise;
    }
    if (this._startPromise) {
      await this._startPromise;
      return;
    }
    if (!this.isEnabled()) {
      this._snapshot.enabled = false;
      this._setStatus('disabled');
      return;
    }
    if (this._started) return;

    const launchSpec = this._resolvedLaunchSpec || this._resolveLaunchSpec();
    if (!launchSpec) {
      const detail = this._lastBackendProbeError || 'Configure FF_SIMCONNECT_DLL_PATH or simulator.simConnectDllPath if SimConnect.dll is installed outside the default search locations.';
      this._setStatus('error', `Rust LVAR sidecar could not be started. ${detail}`.slice(0, 500));
      return;
    }

    this._cleanupStaleSidecarProcesses(launchSpec.cleanupToken);

    this._snapshot.enabled = true;
    this._snapshot.source = launchSpec.source;

    let child: import('child_process').ChildProcessWithoutNullStreams;
    try {
      child = spawn(launchSpec.command, this._buildLaunchArgs(launchSpec.args), {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: this._buildSidecarEnv(),
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this._setStatus('error', `LVAR sidecar spawn failed: ${failure.message}`.slice(0, 500));
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
          this._flushPendingRequests(failure);
          this._clearPidFile(child.pid);
          this._started = false;
          this._proc = null;
          this._setStatus('error', `LVAR sidecar spawn failed: ${failure.message}`.slice(0, 500));
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

    // Seed with current subscriptions if we already have them.
    if (this._proc === child && this._started && this._subscriptions.length > 0) {
      this.setSubscriptions(this._subscriptions, this._snapshot.profileId);
    }
  }

  _handleProcessError(
    child: import('child_process').ChildProcessWithoutNullStreams,
    error: Error,
  ): void {
    if (this._proc !== child) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this._flushPendingRequests(failure);
    this._setStatus('error', `LVAR sidecar process error: ${failure.message}`.slice(0, 500));
  }

  _handlePipeError(
    child: import('child_process').ChildProcessWithoutNullStreams,
    pipe: 'stdout' | 'stderr',
    error: Error,
  ): void {
    if (this._proc !== child) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this._setStatus('error', `LVAR sidecar ${pipe} error: ${failure.message}`.slice(0, 500));
  }

  _handleStdinError(
    child: import('child_process').ChildProcessWithoutNullStreams,
    error: Error,
  ): void {
    if (this._proc !== child) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this._flushPendingRequests(failure);
    this._setStatus('error', `LVAR sidecar stdin error: ${failure.message}`.slice(0, 500));
  }

  _handleProcessExit(
    child: import('child_process').ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this._proc !== child) return;

    const wasStopping = this._stopPromise != null;
    this._flushPendingRequests(new Error(`LVAR sidecar stopped: exit=${code ?? 'null'} signal=${signal ?? 'null'}`));
    this._clearPidFile(child.pid);
    const exitDetail = `exit:${code ?? 'null'} signal:${signal ?? 'null'}`;
    const priorStatus = this._snapshot.status;
    const priorError = this._snapshot.error;
    const shouldPreserveError = !wasStopping
      && priorStatus === 'error'
      && typeof priorError === 'string'
      && priorError.length > 0;
    this._awaitingSubscriptionRefresh = this._subscriptions.length > 0;
    this._snapshot.values = {};
    this._snapshot.updatedAt = null;
    this._consecutiveAllNullSnapshots = 0;
    this._setStatus(
      'stopped',
      wasStopping ? null : (shouldPreserveError ? `${priorError} (${exitDetail})` : exitDetail),
    );
    this._snapshot.mobiflight = {
      state: 'disconnected',
      connected: false,
      available: false,
      error: null,
      updatedAt: new Date().toISOString(),
    };
    this._started = false;
    this._proc = null;
  }

  async stop(): Promise<void> {
    if (this._stopPromise) {
      await this._stopPromise;
      return;
    }

    this._flushPendingRequests(new Error('LVAR sidecar stopped'));
    this._recentSimConnectExceptions = [];
    const pendingStart = this._startPromise;
    this._started = false;
    this._awaitingSubscriptionRefresh = this._subscriptions.length > 0;
    this._snapshot.values = {};
    this._snapshot.updatedAt = null;
    this._consecutiveAllNullSnapshots = 0;
    this._snapshot.mobiflight = {
      state: 'disconnected',
      connected: false,
      available: false,
      error: null,
      updatedAt: new Date().toISOString(),
    };

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
            `LVAR sidecar PID ${child?.pid ?? 'unknown'} did not exit after forced shutdown`,
          );
          this._setStatus('error', error.message);
          throw error;
        }

        if (this._proc === child) {
          this._proc = null;
        }
        this._clearPidFile(child?.pid);
        if (this.isEnabled()) {
          this._setStatus('stopped');
        }
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

  _nextSidecarRequestId(): number {
    const requestId = this._nextRequestId;
    this._nextRequestId += 1;
    return requestId;
  }

  _flushPendingRequests(error: Error): void {
    if (this._pendingRequests.size === 0) return;
    const pending = Array.from(this._pendingRequests.values());
    this._pendingRequests.clear();
    for (const entry of pending) {
      clearTimeout(entry.timeout);
      try {
        entry.reject(error);
      } catch {}
    }
  }

  _registerPendingRequest(requestId: number, ackType: string, timeoutMs = 4000): Promise<PendingAckMessage> {
    return new Promise<PendingAckMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pendingRequests.delete(requestId);
        reject(new Error(`Timed out waiting for ${ackType}`));
      }, timeoutMs);
      timeout.unref?.();
      this._pendingRequests.set(requestId, { ackType, resolve, reject, timeout });
    });
  }

  _settlePendingRequest(msg: PendingAckMessage): boolean {
    const requestId = Number(msg && msg.requestId);
    if (!Number.isFinite(requestId)) return false;

    const entry = this._pendingRequests.get(requestId);
    if (!entry) return false;

    this._pendingRequests.delete(requestId);
    clearTimeout(entry.timeout);
    entry.resolve(msg);
    return true;
  }

  _sendWithAck(message: Record<string, unknown>, ackType: string): Promise<PendingAckMessage> {
    if (!this._proc || !this._started || !this._proc.stdin || this._proc.killed) {
      return Promise.resolve({
        type: ackType,
        ok: false,
        error: 'sidecar_unavailable',
      });
    }

    const requestId = this._nextSidecarRequestId();
    const pending = this._registerPendingRequest(requestId, ackType);
    this._send({
      ...message,
      requestId,
    });
    return pending;
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
        // This directory can contain PID files from another Windows user.
        // Unknown records are not ours to mutate; only our exact owned path is
        // safe to discard when malformed.
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
    return !/(?:^|\s)--(?:simvars|sdk-clientdata)-bridge(?:\s|$)/i.test(commandLine || '');
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
    return buildParentSafeWindowsCleanupScript(cleanupToken, 'lvar');
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

  setSubscriptions(subscriptions: Subscription[] = [], profileId = 'generic'): void {
    this._subscriptions = Array.isArray(subscriptions) ? subscriptions : [];
    this._snapshot.profileId = profileId || 'generic';
    this._snapshot.subscriptions = this._subscriptions;
    // A profile/subscription transition is a hard freshness boundary. Snapshots
    // already queued by the sidecar may still describe the previous aircraft,
    // so keep reads unavailable until the sidecar confirms that it has applied
    // the new subscription set.
    this._snapshot.values = {};
    this._snapshot.updatedAt = null;
    this._consecutiveAllNullSnapshots = 0;
    this._awaitingSubscriptionRefresh = true;
    this._subscriptionGeneration += 1;
    if (this._snapshot.status === 'running') {
      this._setStatus('connecting');
    }

    if (!this.isEnabled()) return;
    if (!this._proc || !this._started) return;

    this._send({
      type: 'setSubscriptions',
      subscriptions: this._subscriptions,
      subscriptionGeneration: this._subscriptionGeneration,
    });
  }

  /**
   * Fire a named SimConnect event through the Rust sidecar.
   * @param {string} eventName  e.g. 'EYEPOINT_DOWN'
   */
  sendEvent(eventName: string, value = 0, parameters: unknown[] = []): Promise<PendingAckMessage> {
    const name = typeof eventName === 'string' ? eventName.trim() : '';
    const numericValue = normalizeFiniteSidecarNumber(value, MAX_SIDECAR_EVENT_DATA_ABS);
    const numericParameters = Array.isArray(parameters) && parameters.length <= 4
      ? parameters.map((parameter) => normalizeFiniteSidecarNumber(parameter, MAX_SIDECAR_EVENT_DATA_ABS))
      : null;
    if (
      !isSafeSidecarToken(name, MAX_SIDECAR_NAME_LENGTH, SIDECAR_NAME_RE)
      || numericValue == null
      || numericParameters == null
      || numericParameters.some((parameter) => parameter == null)
    ) {
      return Promise.resolve(buildRejectedAck('sendEventAck', 'invalid_payload'));
    }
    const eventPayload = numericParameters.length > 0
      ? { name, value: numericValue, parameters: numericParameters }
      : { name, value: numericValue };
    return this._sendWithAck({ type: 'sendEvent', ...eventPayload }, 'sendEventAck');
  }

  /**
   * Send one exact third-party SDK event with an unsigned DWORD payload.
   * This is deliberately narrower than sendEvent: arbitrary event names remain
   * prohibited and the numeric payload must fit the native DWORD contract.
   */
  sendSdkEvent(eventName: string, value = 0): Promise<PendingAckMessage> {
    const name = typeof eventName === 'string' ? eventName.trim() : '';
    const numericValue = Number(value);
    if (
      !/^#[0-9]{5}$/.test(name)
      || !Number.isSafeInteger(numericValue)
      || numericValue < 0
      || numericValue > 0xffffffff
    ) {
      return Promise.resolve(buildRejectedAck('sendSdkEventAck', 'invalid_payload'));
    }
    return this._sendWithAck({ type: 'sendSdkEvent', name, value: numericValue }, 'sendSdkEventAck');
  }

  /**
   * Send a view/camera event using object ID 0 (not USER_AIRCRAFT).
   * Required for EYEPOINT_*, PAN_*, VIEW_* events.
   */
  /** Register a one-shot callback to fire when the sidecar emits 'ready'. */
  setOnReady(fn: (() => void) | null): void {
    this._onReadyCallback = fn;
  }

  sendViewEvent(eventName: string, value = 0): Promise<PendingAckMessage> {
    const name = typeof eventName === 'string' ? eventName.trim() : '';
    const numericValue = normalizeFiniteSidecarNumber(value, MAX_SIDECAR_EVENT_DATA_ABS);
    if (!isSafeSidecarToken(name, MAX_SIDECAR_NAME_LENGTH, SIDECAR_NAME_RE) || numericValue == null) {
      return Promise.resolve(buildRejectedAck('sendViewEventAck', 'invalid_payload'));
    }
    return this._sendWithAck({ type: 'sendViewEvent', name, value: numericValue }, 'sendViewEventAck');
  }

  setNamedVar({ name, unit = 'Number', value = 0, dataType = 'float64' }: NamedVarOptions = {}): Promise<PendingAckMessage> {
    const varName = typeof name === 'string' ? name.trim() : '';
    const unitName = typeof unit === 'string' && unit.trim() ? unit.trim() : 'Number';
    const numericValue = normalizeFiniteSidecarNumber(value);
    const normalizedDataType = typeof dataType === 'string' && dataType.trim()
      ? dataType.trim().toLowerCase()
      : 'float64';
    if (
      !isSafeSidecarToken(varName, MAX_SIDECAR_NAME_LENGTH, SIDECAR_NAME_RE)
      || !isSafeSidecarToken(unitName, MAX_SIDECAR_UNIT_LENGTH, SIDECAR_UNIT_RE)
      || numericValue == null
      || !ALLOWED_SIDECAR_DATA_TYPES.has(normalizedDataType)
    ) {
      return Promise.resolve(buildRejectedAck('setNamedVarAck', 'invalid_payload', { name: varName || undefined }));
    }

    return this._sendWithAck({
      type: 'setNamedVar',
      name: varName,
      unit: unitName,
      value: numericValue,
      dataType: normalizedDataType,
    }, 'setNamedVarAck');
  }

  sendInputEvent(eventName: string, value = 1): Promise<PendingAckMessage> {
    const name = typeof eventName === 'string' ? eventName.trim() : '';
    const numericValue = normalizeFiniteSidecarNumber(value, MAX_SIDECAR_EVENT_DATA_ABS);
    if (!isSafeSidecarToken(name, MAX_SIDECAR_NAME_LENGTH, SIDECAR_NAME_RE) || numericValue == null) {
      return Promise.resolve(buildRejectedAck('sendInputEventAck', 'invalid_payload'));
    }
    return this._sendWithAck({
      type: 'sendInputEvent',
      name,
      value: numericValue,
    }, 'sendInputEventAck');
  }

  executeMobiFlightCode(code: string): Promise<PendingAckMessage> {
    if (!isSafeMobiFlightCode(code)) {
      return Promise.resolve(buildRejectedAck('executeMobiFlightCodeAck', 'invalid_payload'));
    }
    return this._sendWithAck({
      type: 'executeMobiFlightCode',
      code,
    }, 'executeMobiFlightCodeAck');
  }

  /**
   * Call SimConnect_CameraSetRelative6DOF through the Rust sidecar.
   * @param {number} pitch  degrees (positive = nose down)
   * @param {number} bank   degrees
   * @param {number} heading degrees
   * @param {number} dx     positional delta X (metres)
   * @param {number} dy     positional delta Y (metres)
   * @param {number} dz     positional delta Z (metres)
   */
  sendCameraShake({ pitch = 0, bank = 0, heading = 0, dx = 0, dy = 0, dz = 0 }: CameraShakeOptions = {}): void {
    if (!config.touchdownShake?.enable) return;
    if (!this._proc || !this._started || !this._proc.stdin || this._proc.killed) return;
    if (
      !isSafeCameraNumber(pitch, MAX_CAMERA_ANGLE_DEGREES)
      || !isSafeCameraNumber(bank, MAX_CAMERA_ANGLE_DEGREES)
      || !isSafeCameraNumber(heading, MAX_CAMERA_ANGLE_DEGREES)
      || !isSafeCameraNumber(dx, MAX_CAMERA_OFFSET_METERS)
      || !isSafeCameraNumber(dy, MAX_CAMERA_OFFSET_METERS)
      || !isSafeCameraNumber(dz, MAX_CAMERA_OFFSET_METERS)
    ) {
      return;
    }
    this._send({ type: 'cameraShake', pitch, bank, heading, dx, dy, dz });
  }

  /**
   * Set STRUCT EYEPOINT DYNAMIC OFFSET via SetDataOnSimObject.
   * Additive overlay on the default eyepoint (G-effects / shake).
   * Units: Meters. (0,0,0) resets to default. Y = vertical (positive up).
   */
  sendEyepointOffset({ x = 0, y = 0, z = 0, units = 'Meters' }: EyepointOffsetOptions = {}): void {
    if (!this._proc || !this._started || !this._proc.stdin || this._proc.killed) return;
    const unitName = typeof units === 'string' && units.trim() ? units.trim() : 'Meters';
    if (
      !isSafeCameraNumber(x, MAX_CAMERA_OFFSET_METERS)
      || !isSafeCameraNumber(y, MAX_CAMERA_OFFSET_METERS)
      || !isSafeCameraNumber(z, MAX_CAMERA_OFFSET_METERS)
      || !isSafeSidecarToken(unitName, MAX_SIDECAR_UNIT_LENGTH, SIDECAR_UNIT_RE)
    ) {
      return;
    }
    this._send({ type: 'eyepointOffset', x, y, z, units: unitName });
  }

  getSnapshot(): SnapshotState {
    return {
      ...this._snapshot,
      values: { ...this._snapshot.values },
      subscriptions: [...this._snapshot.subscriptions],
      mobiflight: { ...this._snapshot.mobiflight },
    };
  }

  findRecentSimConnectException(
    sendIds: readonly number[],
    sinceMs: number,
  ): SimConnectExceptionRecord | null {
    const trustedSendIds = new Set(
      (Array.isArray(sendIds) ? sendIds : [])
        .map((value) => Number(value))
        .filter((value) => Number.isSafeInteger(value) && value >= 0),
    );
    if (trustedSendIds.size === 0) return null;
    const lowerBoundMs = Number.isFinite(sinceMs) ? sinceMs : 0;
    for (let index = this._recentSimConnectExceptions.length - 1; index >= 0; index -= 1) {
      const candidate = this._recentSimConnectExceptions[index];
      if (candidate.receivedAtMs < lowerBoundMs) break;
      if (trustedSendIds.has(candidate.sendId)) return { ...candidate };
    }
    return null;
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

  _onStdout(chunk: Buffer | string): void {
    this._lineBuffer += chunk.toString('utf8');

    // Guard against unbounded growth if sidecar sends data without newlines
    if (this._lineBuffer.length > 65536) {
      this._lineBuffer = '';
      return;
    }

    const lines = this._lineBuffer.split(/\r?\n/);
    this._lineBuffer = lines.pop() || '';

    for (const lineRaw of lines) {
      const line = lineRaw.trim();
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
        if (typeof this._onReadyCallback === 'function') {
          try { this._onReadyCallback(); } catch {}
          this._onReadyCallback = null;
        }
      } else if (msg.type === 'status') {
        if (typeof msg.source === 'string' && msg.source.trim()) {
          this._snapshot.source = msg.source.trim();
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
        const subscriptionGeneration = normalizeSubscriptionGeneration(msg.subscriptionGeneration);
        if (
          this._subscriptions.length > 0
          && (state === 'connecting' || state === 'connected' || state === 'disconnected' || state === 'error')
        ) {
          this._awaitingSubscriptionRefresh = true;
          this._snapshot.values = {};
          this._snapshot.updatedAt = null;
          this._consecutiveAllNullSnapshots = 0;
        }
        if (state === 'subscriptions_updated' && subscriptionGeneration === this._subscriptionGeneration) {
          this._awaitingSubscriptionRefresh = false;
        }
        this._setStatus(state, errorText);
      } else if (msg.type === 'mobiflightStatus') {
        const stateValue = typeof msg.state === 'string' && msg.state.trim()
          ? msg.state.trim().toLowerCase()
          : (typeof msg.status === 'string' && msg.status.trim()
              ? msg.status.trim().toLowerCase()
              : 'error');
        const connected = typeof msg.connected === 'boolean'
          ? msg.connected
          : stateValue === 'connected';
        const available = typeof msg.available === 'boolean'
          ? msg.available
          : connected;
        const error = typeof msg.error === 'string' && msg.error.trim()
          ? msg.error.trim().slice(0, 500)
          : null;
        this._snapshot.mobiflight = {
          state: stateValue,
          connected,
          available,
          error,
          updatedAt: new Date().toISOString(),
        };
      } else if (msg.type === 'snapshot') {
        const subscriptionGeneration = normalizeSubscriptionGeneration(msg.subscriptionGeneration);
        if (
          this._awaitingSubscriptionRefresh
          || (this._subscriptionGeneration > 0 && subscriptionGeneration !== this._subscriptionGeneration)
        ) {
          continue;
        }
        if (typeof msg.source === 'string' && msg.source.trim()) {
          this._snapshot.source = msg.source.trim();
        }
        if (typeof msg.librarySpec === 'string' && msg.librarySpec.trim()) {
          this._snapshot.librarySpec = msg.librarySpec.trim();
        }
        this._snapshot.values = msg.values && typeof msg.values === 'object'
          ? (msg.values as Record<string, unknown>)
          : {};
        this._snapshot.snapshotSequence += 1;
        const values = this._snapshot.values;
        const hasAnyValue = Object.values(values).some((value) => value != null);
        if (hasAnyValue) {
          // Reset null-streak on any successful read.
          this._consecutiveAllNullSnapshots = 0;
          if (this._snapshot.status !== 'running') {
            this._setStatus('running');
          }
        } else if (this._snapshot.status !== 'error') {
          // HYSTERESIS: a single all-null snapshot is normal noise during sim paused / aircraft load /
          // aircraft data-bridge tick gaps. Only downgrade after sustained nulls so the strip doesn't flap
          // between AP/AT visible and hidden every 200 ms. The sidecar also emits its own health
          // transitions after sustained nulls; this is just a faster local guard.
          this._consecutiveAllNullSnapshots = (this._consecutiveAllNullSnapshots || 0) + 1;
          const NULL_DOWNGRADE_THRESHOLD = 25; // ~5 s at 200 ms snapshot cadence
          if (this._consecutiveAllNullSnapshots === NULL_DOWNGRADE_THRESHOLD) {
            const subKeys = (this._subscriptions || []).map(s => s?.key).filter(Boolean);
            console.warn(
              `[LVAR-bridge] No LVAR values received for ${this._consecutiveAllNullSnapshots} consecutive snapshots ` +
              `(~${(this._consecutiveAllNullSnapshots * 0.2).toFixed(1)}s). ` +
              `Subscribed keys (${subKeys.length}): ${subKeys.join(', ') || '(none)'}. ` +
              `Likely causes: aircraft-specific variable bridge not loaded; aircraft variant uses a different ` +
              `LVAR namespace than the active profile; aircraft electrical not powered.`
            );
          }
          if (this._consecutiveAllNullSnapshots >= NULL_DOWNGRADE_THRESHOLD && this._snapshot.status === 'running') {
            this._setStatus('connecting');
          }
        }
        this._snapshot.updatedAt = typeof msg.timestampIso === 'string' && msg.timestampIso.trim()
          ? msg.timestampIso
          : null;
      } else if (msg.type === 'exception') {
        const sendId = Number(msg.sendId);
        if (Number.isSafeInteger(sendId) && sendId >= 0) {
          const exception = Number(msg.exception);
          const exceptionIndex = Number(msg.index);
          this._recentSimConnectExceptions.push({
            exception: Number.isSafeInteger(exception) && exception >= 0 ? exception : null,
            sendId,
            index: Number.isSafeInteger(exceptionIndex) && exceptionIndex >= 0
              ? exceptionIndex
              : null,
            receivedAtMs: Date.now(),
          });
          if (this._recentSimConnectExceptions.length > 64) {
            this._recentSimConnectExceptions.splice(
              0,
              this._recentSimConnectExceptions.length - 64,
            );
          }
        }
      } else if (msg.type === 'sendEventAck' || msg.type === 'sendSdkEventAck' || msg.type === 'sendViewEventAck' || msg.type === 'setNamedVarAck' || msg.type === 'sendInputEventAck' || msg.type === 'executeMobiFlightCodeAck') {
        this._settlePendingRequest(msg as PendingAckMessage);
      } else if (msg.type === 'eyepointOffsetAck') {
        const ackError = typeof msg.error === 'string' && msg.error.trim() ? msg.error : '';
        console.log(`[lvar-sidecar] eyepointOffsetAck ok=${msg.ok}${ackError ? ' err=' + ackError : ''}`);
      } else if (msg.type === 'cameraShakeAck') {
        const ackError = typeof msg.error === 'string' && msg.error.trim() ? msg.error : '';
        console.log(`[lvar-sidecar] cameraShakeAck ok=${msg.ok}${ackError ? ' err=' + ackError : ''}`);
      } else if (msg.type === 'error') {
        const errorMessage = typeof msg.message === 'string' && msg.message.trim()
          ? msg.message
          : 'unknown';
        this._setStatus('error', errorMessage);
      }
    }
  }

  _onStderr(chunk: Buffer | string): void {
    const message = chunk.toString('utf8').trim();
    if (!message) return;
    if (message.includes('SIMCONNECT_EXCEPTION_ALREADY_CREATED')) return;

    const looksFatal =
      message.includes("panicked at") ||
      message.includes("thread '");

    if (looksFatal) {
      this._setStatus('error', message.slice(0, 500));
    }
  }
}

module.exports = {
  LvarSidecarBridge,
  supportsRequiredOwnerLifeline,
};

export {};
