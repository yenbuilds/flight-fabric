'use strict';

const path = require('path') as typeof import('path');
const fs = require('fs') as typeof import('fs');
const { spawnSync } = require('child_process') as typeof import('child_process');
const config = require('../../core/config') as ConfigModule;
const {
  selectNewestManagedRustSidecar,
} = require('../../../shared/rust-sidecar-artifact.js') as {
  selectNewestManagedRustSidecar: (
    telemetryProviderDir: string,
    binaryName: string,
  ) => string | null;
};
const {
  getCommunitySdkConnectorsDir,
  getLocalSdkConnectorsDir,
} = require('../../utils/storage-paths.js') as {
  getCommunitySdkConnectorsDir: () => string;
  getLocalSdkConnectorsDir: () => string;
};

type ConfigModule = {
  lvarSidecar?: {
    dllPath?: string;
    binaryPath?: string;
  };
};

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

type ProbeResult = {
  ok: boolean;
  detail: string | null;
};

const MIN_OWNER_LIFELINE_VERSION = 1;

function supportsRequiredOwnerLifeline(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const version = (payload as Record<string, unknown>).ownerLifelineVersion;
  return typeof version === 'number'
    && Number.isSafeInteger(version)
    && version >= MIN_OWNER_LIFELINE_VERSION;
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function buildSidecarEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (typeof config.lvarSidecar?.dllPath === 'string' && config.lvarSidecar.dllPath.trim()) {
    env.FF_SIMCONNECT_DLL_PATH = config.lvarSidecar.dllPath.trim();
  }
  env.FF_SDK_CONNECTORS_PATHS = [
    path.join(__dirname, '..', 'sdk-connectors'),
    getLocalSdkConnectorsDir(),
    getCommunitySdkConnectorsDir(),
  ].join(path.delimiter);
  env.SIMCONNECT_PROVIDER = 'rust';
  return env;
}

function resolveRustBinaryPath(): { binaryPath: string | null; error: string | null } {
  const unique = new Set<string>();
  const candidates: string[] = [];
  const exeName = process.platform === 'win32'
    ? 'ff-rust-simconnect-sidecar.exe'
    : 'ff-rust-simconnect-sidecar';
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const normalizeCandidate = (value: unknown): string | null => {
    const trimmed = trimString(value);
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
  pushCandidate(selectNewestManagedRustSidecar(path.join(__dirname, '..'), exeName));
  pushCandidate(path.join(__dirname, '..', 'rust-simconnect-sidecar', 'target', 'release', exeName));
  pushCandidate(path.join(__dirname, '..', 'rust-simconnect-sidecar', 'target', 'debug', exeName));
  pushCandidate(path.join(repoRoot, 'backend-build', 'telemetry-provider', exeName));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { binaryPath: candidate, error: null };
    }
  }

  return {
    binaryPath: null,
    error: `Rust sidecar binary not found. Tried: ${candidates.join(', ') || '(none)'}`,
  };
}

function probeRustBinary(command: string): ProbeResult {
  const probe = spawnSync(command, ['--probe'], {
    encoding: 'utf8',
    env: buildSidecarEnv(),
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

function resolveLaunchSpec(): SdkLaunchResolution {
  const { binaryPath, error } = resolveRustBinaryPath();
  if (!binaryPath) {
    return {
      launchSpec: null,
      error,
    };
  }

  const probe = probeRustBinary(binaryPath);
  if (!probe.ok) {
    const detail = probe.detail || 'rust sidecar probe failed';
    console.log(`[SDK-adapter:rust-clientdata] rust candidate rejected (probe failed): ${binaryPath}${detail ? ` :: ${detail}` : ''}`);
    return {
      launchSpec: null,
      error: detail,
    };
  }

  console.log(`[SDK-adapter:rust-clientdata] rust sidecar resolved: ${binaryPath}`);
  return {
    launchSpec: {
      provider: 'rust',
      source: 'rust-sidecar',
      command: binaryPath,
      args: ['--sdk-clientdata-bridge'],
      cleanupToken: binaryPath,
    },
    error: null,
  };
}

module.exports = { buildSidecarEnv, resolveLaunchSpec, supportsRequiredOwnerLifeline };

export {};
