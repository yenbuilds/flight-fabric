'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const test = require('node:test');
const {
  createLowDiskError,
  createRecordingDiskGuard,
  isDiskCapacityError,
  probeDiskSpaceSync,
} = require('./recording-disk-guard') as {
  createLowDiskError: (_decision: Record<string, any>) => NodeJS.ErrnoException;
  createRecordingDiskGuard: (_options: Record<string, any>) => Record<string, any>;
  isDiskCapacityError: (_error: unknown) => boolean;
  probeDiskSpaceSync: (_targetDir: string) => Record<string, any>;
};

function probe(freeDiskGb: number) {
  return { checked: true, freeDiskGb };
}

test('preflight blocks below the floor and requires hysteresis before resuming', () => {
  let currentTime = 1000;
  let freeDiskGb = 1.99;
  let probeCount = 0;
  const guard = createRecordingDiskGuard({
    minFreeGb: 2,
    resumeMarginGb: 0.5,
    recheckIntervalMs: 30_000,
    now: () => currentTime,
    probeSync: () => {
      probeCount += 1;
      return probe(freeDiskGb);
    },
  });

  const low = guard.checkBeforeStart('C:\\Flight Logs');
  assert.equal(low.allowed, false);
  assert.equal(low.shouldStop, true);
  assert.equal(low.requiredFreeGb, 2.5);
  assert.equal(probeCount, 1);

  currentTime += 1000;
  const cached = guard.checkBeforeStart('C:\\Flight Logs');
  assert.equal(cached.allowed, false);
  assert.equal(cached.cached, true);
  assert.equal(probeCount, 1, 'blocked automatic retries must not repeatedly probe the disk');

  freeDiskGb = 2.49;
  const belowResume = guard.checkBeforeStart('C:\\Flight Logs', { forceProbe: true });
  assert.equal(belowResume.allowed, false);
  assert.equal(belowResume.shouldStop, false);

  freeDiskGb = 2.5;
  const recovered = guard.checkBeforeStart('C:\\Flight Logs', { forceProbe: true });
  assert.equal(recovered.allowed, true);
  assert.equal(guard.getState().blockedKind, null);
});

test('preflight fails closed when the Flight Logs volume cannot be verified', () => {
  const guard = createRecordingDiskGuard({
    minFreeGb: 2,
    probeSync: () => ({ checked: false, freeDiskGb: -1, reason: 'probe failed' }),
  });
  const result = guard.checkBeforeStart('C:\\Flight Logs');
  assert.equal(result.allowed, false);
  assert.equal(result.shouldStop, false);
  assert.match(result.reason, /could not be verified/i);
});

test('the real probe checks the volume containing a not-yet-created Flight Logs directory', () => {
  const existingParent = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-recording-disk-volume-'));
  try {
    const result = probeDiskSpaceSync(path.join(existingParent, 'Flight Logs', 'future-bundle'));
    assert.equal(result.checked, true);
    assert.equal(Number.isFinite(result.freeDiskGb), true);
    assert.equal(result.freeDiskGb >= 0, true);
  } finally {
    fs.rmSync(existingParent, { recursive: true, force: true });
  }
});

test('periodic checks are throttled and trip only below the exact floor', async () => {
  let currentTime = 0;
  let freeDiskGb = 2;
  let probeCount = 0;
  const guard = createRecordingDiskGuard({
    minFreeGb: 2,
    recheckIntervalMs: 30_000,
    now: () => currentTime,
    probeAsync: async () => {
      probeCount += 1;
      return probe(freeDiskGb);
    },
  });

  guard.noteRecordingStarted();
  assert.equal(await guard.checkActive('C:\\Flight Logs'), null);
  assert.equal(probeCount, 0);

  currentTime = 30_000;
  const atFloor = await guard.checkActive('C:\\Flight Logs');
  assert.equal(atFloor.allowed, true);
  assert.equal(atFloor.shouldStop, false);

  currentTime = 60_000;
  freeDiskGb = 1.999999;
  const belowFloor = await guard.checkActive('C:\\Flight Logs');
  assert.equal(belowFloor.allowed, false);
  assert.equal(belowFloor.shouldStop, true);
  assert.equal(probeCount, 2);

  assert.equal(await guard.checkActive('C:\\Flight Logs'), null);
  assert.equal(probeCount, 2, 'the same low-disk interval must not create a retry loop');
});

test('an unavailable periodic probe does not destroy an active recording', async () => {
  let currentTime = 0;
  const guard = createRecordingDiskGuard({
    minFreeGb: 2,
    recheckIntervalMs: 30_000,
    now: () => currentTime,
    probeAsync: async () => ({ checked: false, freeDiskGb: -1, reason: 'probe failed' }),
  });
  guard.noteRecordingStarted();
  currentTime = 30_000;
  const result = await guard.checkActive('C:\\Flight Logs');
  assert.equal(result.allowed, true);
  assert.equal(result.shouldStop, false);
  assert.equal(result.checked, false);
});

test('low-disk and native capacity errors share one terminal category', () => {
  const error = createLowDiskError({
    reason: 'low disk',
    freeDiskGb: 1.5,
    minFreeGb: 2,
    requiredFreeGb: 2.5,
  });
  assert.equal(error.code, 'FF_LOW_DISK');
  assert.equal(isDiskCapacityError(error), true);
  assert.equal(isDiskCapacityError(Object.assign(new Error('full'), { code: 'ENOSPC' })), true);
  assert.equal(isDiskCapacityError(Object.assign(new Error('quota'), { code: 'EDQUOT' })), true);
  assert.equal(isDiskCapacityError(Object.assign(new Error('io'), { code: 'EIO' })), false);
});

test('a native capacity error enforces a quiet period and the resume threshold', () => {
  let currentTime = 0;
  let freeDiskGb = 10;
  let probeCount = 0;
  const guard = createRecordingDiskGuard({
    minFreeGb: 2,
    resumeMarginGb: 0.5,
    recheckIntervalMs: 30_000,
    now: () => currentTime,
    probeSync: () => {
      probeCount += 1;
      return probe(freeDiskGb);
    },
  });

  guard.markDiskCapacityFailure();
  const immediateRetry = guard.checkBeforeStart('C:\\Flight Logs');
  assert.equal(immediateRetry.allowed, false);
  assert.equal(immediateRetry.cached, true);
  assert.equal(probeCount, 0, 'a terminal capacity error must not immediately retry disk I/O');

  currentTime = 30_000;
  freeDiskGb = 2.49;
  const belowResume = guard.checkBeforeStart('C:\\Flight Logs');
  assert.equal(belowResume.allowed, false);
  assert.equal(belowResume.requiredFreeGb, 2.5);

  currentTime = 60_000;
  freeDiskGb = 2.5;
  assert.equal(guard.checkBeforeStart('C:\\Flight Logs').allowed, true);
});

export {};
