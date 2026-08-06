/*
 * simbridge-core.mock.test.js
 *
 * Integration-style test: spawns a child process that runs simbridge-core
 * with a scripted mock provider and asserts lifecycle markers on stdout.
 *
 * Keep the test minimal, deterministic, and reversible: it creates no persistent
 * state and uses an ephemeral WS port (0).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');

const runnerPath = path.join(__dirname, '..', 'support', 'simbridge-mock-runner.js');
const { finalizeRecordingForShutdown, runSimbridgeShutdownSequence } = require('../../backend/core/simbridge-shutdown.js') as {
  finalizeRecordingForShutdown: (options: Record<string, unknown>) => Promise<void>;
  runSimbridgeShutdownSequence: (options: Record<string, unknown>) => Promise<void>;
};

test('simbridge-core: active-flight shutdown also waits an earlier bundle rollback', async () => {
  let releaseRollback: (() => void) | null = null;
  let settled = false;
  const calls: string[] = [];
  const rollback = new Promise<void>((resolve) => {
    releaseRollback = resolve;
  });

  const finalization = finalizeRecordingForShutdown({
    flightActive: true,
    endActiveFlight: async () => {
      calls.push('end-active-flight');
      return null;
    },
    getPendingFinalization: () => rollback,
    finalizeOpenRecorders: async () => {
      calls.push('finalize-open-recorders');
    },
  }).finally(() => {
    settled = true;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['end-active-flight']);
  assert.equal(settled, false, 'shutdown must remain blocked on startup rollback cleanup');
  assert.ok(releaseRollback);
  releaseRollback();
  await finalization;
  assert.equal(settled, true);
});

test('simbridge-core: inactive-flight shutdown prefers pending cleanup, otherwise closes orphan recorders', async () => {
  const calls: string[] = [];
  await finalizeRecordingForShutdown({
    flightActive: false,
    endActiveFlight: async () => calls.push('unexpected-end'),
    getPendingFinalization: () => Promise.resolve().then(() => calls.push('pending-finalization')),
    finalizeOpenRecorders: async () => calls.push('unexpected-open-finalization'),
  });
  assert.deepEqual(calls, ['pending-finalization']);

  calls.length = 0;
  await finalizeRecordingForShutdown({
    flightActive: false,
    endActiveFlight: async () => calls.push('unexpected-end'),
    getPendingFinalization: () => null,
    finalizeOpenRecorders: async () => calls.push('open-recorder-finalization'),
  });
  assert.deepEqual(calls, ['open-recorder-finalization']);
});

test('simbridge-core: provider shutdown starts despite a hanging earlier component', async () => {
  let releaseHangingStop: (() => void) | null = null;
  const calls: string[] = [];
  const hangingStop = new Promise<void>((resolve) => {
    releaseHangingStop = resolve;
  });

  const shutdownPromise = runSimbridgeShutdownSequence({
    finalizationTask: () => {
      calls.push('finalization');
    },
    provider: {
      stop: () => {
        calls.push('telemetry provider');
      },
    },
    cabinAnnouncementsHandle: {
      stop: () => {
        calls.push('cabin announcements');
        return hangingStop;
      },
    },
    stopHandle: async (handle: { stop?: () => unknown } | null, label: string) => {
      if (!handle?.stop) return null;
      calls.push(`start:${label}`);
      return handle.stop();
    },
    closeServersTask: () => {
      calls.push('servers');
    },
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(calls.includes('cabin announcements'), 'the deliberately hanging component should have started');
  assert.ok(calls.includes('telemetry provider'), 'provider.stop() must start without awaiting the hanging component');
  assert.ok(!calls.includes('servers'), 'server close should wait for primary cleanup tasks');

  assert.ok(releaseHangingStop, 'hanging stop release should be initialized');
  releaseHangingStop();
  await shutdownPromise;
  assert.ok(calls.includes('servers'), 'server close should run after handle and finalization cleanup');
});

test('simbridge-core: shutdown waits all work, always closes servers, and aggregates failures', async () => {
  let releaseProvider: (() => void) | null = null;
  const calls: string[] = [];
  const gatedProvider = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });

  const shutdownPromise = runSimbridgeShutdownSequence({
    provider: {
      stop: () => {
        calls.push('provider');
        return gatedProvider;
      },
    },
    cabinAnnouncementsHandle: {
      stop: () => {
        calls.push('failing component');
        throw new Error('component exploded');
      },
    },
    finalizationTask: () => {
      calls.push('finalization');
      throw new Error('finalization exploded');
    },
    stopHandle: async (handle: { stop?: () => unknown } | null) => handle?.stop?.(),
    closeServersTask: () => {
      calls.push('servers');
      throw new Error('server close exploded');
    },
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(calls.includes('provider'));
  assert.ok(calls.includes('failing component'));
  assert.ok(calls.includes('finalization'));
  assert.ok(!calls.includes('servers'), 'server close must wait for the gated provider stop');

  assert.ok(releaseProvider);
  releaseProvider();
  await assert.rejects(
    shutdownPromise,
    (error: unknown) => {
      if (!(error instanceof AggregateError)) return false;
      const messages = error.errors.map((entry: Error) => entry.message).join('\n');
      assert.match(messages, /component exploded/);
      assert.match(messages, /finalization exploded/);
      assert.match(messages, /server close exploded/);
      return true;
    },
  );
  assert.ok(calls.includes('servers'), 'server close must still run after primary cleanup failures');
});

test('simbridge-core: provider lifecycle and profile detection smoke test', async (_t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-simbridge-core-mock-'));

  // Spawn child node process to run the runner script
  const node = process.execPath;
  const cp = spawn(node, [runnerPath], {
    env: {
      ...process.env,
      HOME: tempRoot,
      USERPROFILE: tempRoot,
      APPDATA: path.join(tempRoot, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(tempRoot, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(tempRoot, '.config'),
      OneDrive: path.join(tempRoot, 'OneDrive'),
      FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout = [];
  const stderr = [];

  cp.stdout.on('data', (d) => {
    const s = d.toString();
    stdout.push(s);
  });
  cp.stderr.on('data', (d) => {
    const s = d.toString();
    stderr.push(s);
  });

  // Wait for process to exit (timeout safety)
  let exitCode;
  try {
    exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        cp.kill();
        resolve(-1);
      }, 5000); // 5s timeout

      cp.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  // Flatten captured stdout
  const outStr = stdout.join(' ');
  const errStr = stderr.join(' ');

  // Basic assertions: process exited successfully and emitted markers
  assert.strictEqual(exitCode, 0, `Runner exited with code ${exitCode}; stderr: ${errStr}`);

  // Expect provider lifecycle markers in output
  assert.ok(outStr.includes('TEST:provider_start'), 'Missing provider_start marker');
  assert.ok(outStr.includes('[SIMBRIDGE_READY]'), 'Missing canonical backend readiness marker');
  assert.ok(
    outStr.indexOf('[http] Bound') < outStr.indexOf('[SIMBRIDGE_READY]'),
    'canonical readiness must follow the HTTP listener binding',
  );
  assert.ok(
    outStr.indexOf('TEST:provider_start') < outStr.indexOf('[SIMBRIDGE_READY]'),
    'canonical readiness must follow required provider startup',
  );

  // provider_start should happen only once
  const startCount = (outStr.match(/TEST:provider_start/g) || []).length;
  assert.strictEqual(startCount, 1, `provider_start should be called once, got ${startCount}`);

  assert.ok(outStr.includes('TEST:provider_disconnected'), 'Missing provider_disconnected marker');
  assert.ok(outStr.includes('TEST:provider_reconnected'), 'Missing provider_reconnected marker');
  assert.ok(outStr.includes('TEST:reconnect_rates_reset:true'), 'Derivative baselines were not reset after reconnect');
  assert.ok(outStr.includes('TEST:provider_connected_no_title') || outStr.match(/TEST:provider_connected_with_title:/), 'Missing provider connected markers');
  assert.ok(outStr.match(/TEST:provider_connected_with_title:.*PMDG/), 'Missing provider_connected_with_title marker');
  assert.ok(outStr.match(/TEST:profile_detected:/), 'Missing profile_detected marker');
  assert.ok(
    outStr.match(/TEST:canonical_tick:true:0/),
    'Core did not emit one independently owned, deeply frozen canonical TickFrame',
  );

  // Profile should remain stable across degraded gap
  assert.ok(outStr.match(/TEST:profile_stable:/), 'Missing profile_stable marker (profile did not remain stable across gap)');

  // Check data source metadata markers
  assert.ok(outStr.match(/TEST:data_source:mock:(true|false)/), 'Missing data_source marker');

  // Collect last_frame_local_ts and ensure they're increasing
  const tsMatches = outStr.match(/TEST:last_frame_local_ts:(\d+)/g) || [];
  assert.ok(tsMatches.length >= 3, `Expected at least 3 last_frame_local_ts markers, found ${tsMatches.length}`);
  const tsVals = tsMatches.map(m => parseInt(m.split(':').pop(), 10));
  for (let i = 1; i < tsVals.length; i++) {
    assert.ok(tsVals[i] >= tsVals[i - 1], `Timestamps not non-decreasing: ${tsVals.join(',')}`);
  }

  assert.ok(outStr.includes('TEST:done'), 'Missing done marker');
  assert.ok(outStr.includes('TEST:provider_stop'), 'Shutdown did not reach provider.stop()');
  assert.ok(outStr.includes('TEST:core_stopped'), 'Core did not escape a non-settling frame acquisition');
  assert.ok(!outStr.includes('TEST:runner_error'), 'Found runner_error marker - unexpected');
});

export {};
