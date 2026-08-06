'use strict';

const fs = require('node:fs') as typeof import('node:fs');
const { resolveExistingDirectory } = require('../utils/helpers') as {
  resolveExistingDirectory: (_targetPath: unknown) => string | null;
};

type DiskProbeResult = {
  checked: boolean;
  freeDiskGb: number;
  reason?: string;
};

type DiskFloorDecision = DiskProbeResult & {
  allowed: boolean;
  cached: boolean;
  minFreeGb: number;
  newlyBlocked: boolean;
  requiredFreeGb: number;
  shouldStop: boolean;
};

type RecordingDiskGuardOptions = {
  minFreeGb: number;
  now?: () => number;
  probeAsync?: (_targetDir: string) => Promise<DiskProbeResult>;
  probeSync?: (_targetDir: string) => DiskProbeResult;
  recheckIntervalMs?: number;
  resumeMarginGb?: number;
};

type DiskError = Error & {
  code?: string;
  freeDiskGb?: number;
  minFreeGb?: number;
  requiredFreeGb?: number;
};

const GIB_BYTES = 1024 * 1024 * 1024;
const DEFAULT_RECHECK_INTERVAL_MS = 30 * 1000;
const DEFAULT_RESUME_MARGIN_GB = 0.5;
const DISK_CAPACITY_ERROR_CODES = new Set(['EDQUOT', 'ENOSPC', 'FF_LOW_DISK']);

function toFiniteNonNegative(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function formatGb(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : 'unknown';
}

function checkedDiskResult(stats: { bavail?: number; bfree?: number; bsize?: number }): DiskProbeResult {
  const availableBlocks = Number.isFinite(stats.bavail) ? Number(stats.bavail) : Number(stats.bfree);
  const blockSize = Number(stats.bsize);
  if (!Number.isFinite(availableBlocks) || availableBlocks < 0 || !Number.isFinite(blockSize) || blockSize <= 0) {
    return {
      checked: false,
      freeDiskGb: -1,
      reason: 'Disk space information was invalid',
    };
  }
  return {
    checked: true,
    // Keep full precision for the policy decision. Rounding before comparison
    // could accidentally allow a volume that is just below the hard floor.
    freeDiskGb: (availableBlocks * blockSize) / GIB_BYTES,
  };
}

function resolveDiskProbeDirectory(targetDir: string): string | null {
  return resolveExistingDirectory(targetDir);
}

function probeDiskSpaceSync(targetDir: string): DiskProbeResult {
  const checkDir = resolveDiskProbeDirectory(targetDir);
  if (!checkDir) {
    return {
      checked: false,
      freeDiskGb: -1,
      reason: 'Could not resolve the Flight Logs volume',
    };
  }
  try {
    if (typeof fs.statfsSync !== 'function') {
      return {
        checked: false,
        freeDiskGb: -1,
        reason: 'Disk space checks are not supported by this runtime',
      };
    }
    return checkedDiskResult(fs.statfsSync(checkDir));
  } catch {
    return {
      checked: false,
      freeDiskGb: -1,
      reason: 'Could not check free disk space',
    };
  }
}

async function probeDiskSpace(targetDir: string): Promise<DiskProbeResult> {
  const checkDir = resolveDiskProbeDirectory(targetDir);
  if (!checkDir) {
    return {
      checked: false,
      freeDiskGb: -1,
      reason: 'Could not resolve the Flight Logs volume',
    };
  }
  if (typeof fs.statfs !== 'function') {
    return {
      checked: false,
      freeDiskGb: -1,
      reason: 'Disk space checks are not supported by this runtime',
    };
  }
  return new Promise((resolve) => {
    fs.statfs(checkDir, (error, stats) => {
      if (error) {
        resolve({
          checked: false,
          freeDiskGb: -1,
          reason: 'Could not check free disk space',
        });
        return;
      }
      resolve(checkedDiskResult(stats));
    });
  });
}

function createRecordingDiskGuard(options: RecordingDiskGuardOptions) {
  const minFreeGb = toFiniteNonNegative(options.minFreeGb, 2);
  const resumeMarginGb = toFiniteNonNegative(options.resumeMarginGb, DEFAULT_RESUME_MARGIN_GB);
  const resumeFreeGb = minFreeGb + resumeMarginGb;
  const recheckIntervalMs = Math.max(
    1000,
    toFiniteNonNegative(options.recheckIntervalMs, DEFAULT_RECHECK_INTERVAL_MS),
  );
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const syncProbe = options.probeSync || probeDiskSpaceSync;
  const asyncProbe = options.probeAsync || probeDiskSpace;

  let blockedKind: 'low_disk' | 'unverified' | null = null;
  let lastStartDecision: DiskFloorDecision | null = null;
  let lastStartProbeAt = Number.NEGATIVE_INFINITY;
  let lastActiveProbeAt = Number.NEGATIVE_INFINITY;
  let activeProbe: Promise<DiskFloorDecision | null> | null = null;

  const allowDecision = (probe: DiskProbeResult): DiskFloorDecision => ({
    ...probe,
    allowed: true,
    cached: false,
    minFreeGb,
    newlyBlocked: false,
    requiredFreeGb: blockedKind === 'low_disk' ? resumeFreeGb : minFreeGb,
    shouldStop: false,
  });

  const blockDecision = (
    probe: DiskProbeResult,
    kind: 'low_disk' | 'unverified',
    previousKind: 'low_disk' | 'unverified' | null,
  ): DiskFloorDecision => {
    const requiredFreeGb = kind === 'low_disk' ? resumeFreeGb : minFreeGb;
    const reason = !probe.checked
      ? 'Flight recording cannot start because free disk space could not be verified.'
      : probe.freeDiskGb < minFreeGb
        ? `Low disk space: ${formatGb(probe.freeDiskGb)} GB free; recording requires at least ${formatGb(minFreeGb)} GB and will resume at ${formatGb(resumeFreeGb)} GB.`
        : `Flight recording remains blocked until ${formatGb(resumeFreeGb)} GB is free (${formatGb(probe.freeDiskGb)} GB available).`;
    return {
      ...probe,
      allowed: false,
      cached: false,
      minFreeGb,
      newlyBlocked: previousKind !== kind,
      reason,
      requiredFreeGb,
      shouldStop: kind === 'low_disk' && probe.checked && probe.freeDiskGb < minFreeGb,
    };
  };

  function checkBeforeStart(
    targetDir: string,
    checkOptions: { forceProbe?: boolean } = {},
  ): DiskFloorDecision {
    const currentTime = now();
    if (
      blockedKind
      && checkOptions.forceProbe !== true
      && lastStartDecision
      && currentTime - lastStartProbeAt < recheckIntervalMs
    ) {
      return { ...lastStartDecision, cached: true, newlyBlocked: false };
    }

    lastStartProbeAt = currentTime;
    const probe = syncProbe(targetDir);
    const previousKind = blockedKind;
    let decision: DiskFloorDecision;

    if (!probe.checked) {
      blockedKind = 'unverified';
      decision = blockDecision(probe, blockedKind, previousKind);
    } else if (blockedKind === 'low_disk' && probe.freeDiskGb < resumeFreeGb) {
      decision = blockDecision(probe, blockedKind, previousKind);
    } else if (probe.freeDiskGb < minFreeGb) {
      blockedKind = 'low_disk';
      decision = blockDecision(probe, blockedKind, previousKind);
    } else {
      blockedKind = null;
      decision = allowDecision(probe);
      lastActiveProbeAt = currentTime;
    }

    lastStartDecision = decision;
    return decision;
  }

  function checkActive(targetDir: string): Promise<DiskFloorDecision | null> {
    const currentTime = now();
    if (activeProbe || currentTime - lastActiveProbeAt < recheckIntervalMs) {
      return activeProbe || Promise.resolve(null);
    }
    lastActiveProbeAt = currentTime;
    const pending = asyncProbe(targetDir).then((probe) => {
      if (!probe.checked) {
        return {
          ...allowDecision(probe),
          reason: probe.reason || 'Could not verify free disk space during recording',
        };
      }

      const previousKind = blockedKind;
      if (probe.freeDiskGb < minFreeGb) {
        blockedKind = 'low_disk';
        const decision = blockDecision(probe, blockedKind, previousKind);
        lastStartDecision = decision;
        lastStartProbeAt = currentTime;
        return decision;
      }

      if (blockedKind === 'unverified' || (blockedKind === 'low_disk' && probe.freeDiskGb >= resumeFreeGb)) {
        blockedKind = null;
      }
      return allowDecision(probe);
    }).finally(() => {
      if (activeProbe === pending) activeProbe = null;
    });
    activeProbe = pending;
    return pending;
  }

  function markDiskCapacityFailure(): void {
    const previousKind = blockedKind;
    blockedKind = 'low_disk';
    lastStartProbeAt = now();
    lastStartDecision = {
      allowed: false,
      cached: false,
      checked: false,
      freeDiskGb: -1,
      minFreeGb,
      newlyBlocked: previousKind !== 'low_disk',
      reason: `Flight recording is paused after a disk capacity error and will resume only after ${formatGb(resumeFreeGb)} GB can be verified.`,
      requiredFreeGb: resumeFreeGb,
      shouldStop: false,
    };
  }

  function noteRecordingStarted(): void {
    lastActiveProbeAt = now();
  }

  function getState() {
    return {
      blockedKind,
      minFreeGb,
      resumeFreeGb,
      recheckIntervalMs,
    };
  }

  return {
    checkActive,
    checkBeforeStart,
    getState,
    markDiskCapacityFailure,
    noteRecordingStarted,
  };
}

function createLowDiskError(decision: DiskFloorDecision): DiskError {
  const error = new Error(decision.reason || 'Recording stopped at the free disk safety floor') as DiskError;
  error.code = 'FF_LOW_DISK';
  error.freeDiskGb = decision.freeDiskGb;
  error.minFreeGb = decision.minFreeGb;
  error.requiredFreeGb = decision.requiredFreeGb;
  return error;
}

function isDiskCapacityError(error: unknown): boolean {
  const code = error && typeof error === 'object'
    ? String((error as { code?: unknown }).code || '')
    : '';
  return DISK_CAPACITY_ERROR_CODES.has(code);
}

module.exports = {
  createLowDiskError,
  createRecordingDiskGuard,
  isDiskCapacityError,
  probeDiskSpace,
  probeDiskSpaceSync,
};

export {};
