#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { execFileSync, fork, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createPushToTalkHelperSpawnOptions } = require('../../electron/voice-push-to-talk-hook');

const ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(ROOT, 'electron', 'voice-native', 'ptt-hook', 'Cargo.toml');
const HELPER = path.join(
  ROOT,
  'electron',
  'voice-native',
  'ptt-hook',
  'target',
  'release',
  'flight-fabric-ptt-hook.exe',
);
const FIXTURE_PREFIX = '--ff-ptt-owner-fixture=';
const TEST_SHORTCUT = 'Control+Alt+Shift+F12';

function startExactProcessExitObserver(pid, expectedPath) {
  const psScript = [
    '$p=Get-Process -Id ([int]$env:FF_PTT_OBSERVER_PID) -ErrorAction Stop',
    '$actual=[IO.Path]::GetFullPath([string]$p.Path)',
    '$expected=[IO.Path]::GetFullPath([string]$env:FF_PTT_OBSERVER_PATH)',
    'if (-not [StringComparer]::OrdinalIgnoreCase.Equals($actual,$expected)) { exit 4 }',
    '$handle=$p.Handle',
    "[Console]::Out.WriteLine('ready')",
    '[Console]::Out.Flush()',
    'if (-not $p.WaitForExit(5000)) { exit 5 }',
  ].join('; ');
  const stderrChunks = [];
  const observer = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psScript],
    {
      detached: false,
      env: {
        ...process.env,
        FF_PTT_OBSERVER_PATH: expectedPath,
        FF_PTT_OBSERVER_PID: String(pid),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  observer.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk).toString('utf8')));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PTT helper exit observer did not become ready.')), 5000);
    let output = '';
    const finish = (callback, value) => {
      clearTimeout(timer);
      observer.removeListener('exit', onExit);
      callback(value);
    };
    const onExit = (code) => finish(
      reject,
      new Error(`PTT helper exit observer failed (${code ?? 'unknown'}): ${stderrChunks.join('')}`),
    );
    observer.stdout.on('data', (chunk) => {
      output += Buffer.from(chunk).toString('utf8');
      if (output.split(/\r?\n/u).includes('ready')) finish(resolve);
    });
    observer.once('exit', onExit);
  });
  return { observer, ready, stderrChunks };
}

function runOwnerFixture(fixtureArgument, helperPath) {
  if (!fixtureArgument.startsWith(FIXTURE_PREFIX) || !path.isAbsolute(helperPath)) {
    process.exit(2);
  }

  const helper = spawn(
    helperPath,
    ['--shortcut', TEST_SHORTCUT],
    createPushToTalkHelperSpawnOptions(),
  );
  let output = '';
  let ready = false;

  const fail = (message) => {
    if (process.connected) process.send({ type: 'error', message });
    process.exit(1);
  };

  helper.stdout.on('data', (chunk) => {
    output += Buffer.from(chunk).toString('utf8');
    while (output.includes('\n')) {
      const newline = output.indexOf('\n');
      const line = output.slice(0, newline).replace(/\r$/, '');
      output = output.slice(newline + 1);
      if (line === '{"type":"ready"}' && !ready) {
        ready = true;
        process.send({
          type: 'ready',
          fixtureMarker: fixtureArgument,
          ownerPid: process.pid,
          helperPid: helper.pid,
        });
      }
    }
  });
  helper.stderr.on('data', () => {});
  helper.once('error', (error) => fail(error.message));
  helper.once('exit', (code) => {
    if (!ready) fail(`PTT helper exited before ready (${code ?? 'unknown'}).`);
  });

  // Keep this owner alive until the outer test force-terminates its exact process handle.
  setInterval(() => {}, 1000);
}

function waitForFixtureReady(owner, stderrChunks) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PTT owner fixture did not become ready.')), 5000);
    const finish = (callback, value) => {
      clearTimeout(timer);
      owner.removeListener('message', onMessage);
      owner.removeListener('exit', onExit);
      callback(value);
    };
    const onMessage = (message) => {
      if (message?.type === 'ready') finish(resolve, message);
      if (message?.type === 'error') finish(reject, new Error(message.message));
    };
    const onExit = (code) => finish(
      reject,
      new Error(`PTT owner fixture exited before ready (${code ?? 'unknown'}): ${stderrChunks.join('')}`),
    );
    owner.on('message', onMessage);
    owner.once('exit', onExit);
  });
}

function waitForChildExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PTT owner fixture did not exit.')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  const fixtureArgument = process.argv.find((argument) => argument.startsWith(FIXTURE_PREFIX));
  if (fixtureArgument) {
    runOwnerFixture(fixtureArgument, process.argv[3]);
    return;
  }
  if (process.platform !== 'win32') {
    console.log('PTT helper parent lifecycle test skipped (Windows only)');
    return;
  }

  execFileSync(
    'cargo',
    ['build', '--manifest-path', MANIFEST, '--release', '--locked'],
    { cwd: ROOT, stdio: 'inherit', windowsHide: true },
  );
  assert.equal(fs.existsSync(HELPER), true, 'PTT helper build output must exist');

  const fixtureToken = randomUUID();
  const fixtureMarker = `${FIXTURE_PREFIX}${fixtureToken}`;
  const stderrChunks = [];
  const owner = fork(__filename, [fixtureMarker, HELPER], {
    cwd: ROOT,
    detached: false,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
  owner.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk).toString('utf8')));
  let observer = null;
  let observerStderr = [];

  try {
    const ready = await waitForFixtureReady(owner, stderrChunks);
    assert.equal(ready.fixtureMarker, fixtureMarker, 'fixture must echo its unguessable launch marker');
    assert.equal(ready.ownerPid, owner.pid, 'fixture must report the exact child process we spawned');
    assert.ok(Number.isSafeInteger(ready.helperPid) && ready.helperPid > 0, 'fixture must report its helper PID');

    const exitObserver = startExactProcessExitObserver(ready.helperPid, HELPER);
    observer = exitObserver.observer;
    observerStderr = exitObserver.stderrChunks;
    await exitObserver.ready;

    // ChildProcess.kill uses the process handle held by Node. It does not select a
    // target by PID, so PID reuse cannot redirect this termination to another process.
    assert.equal(owner.kill('SIGKILL'), true, 'exact fixture process handle must terminate');
    await waitForChildExit(owner);
    await waitForChildExit(observer, 7000);
    assert.equal(
      observer.exitCode,
      0,
      `exact helper process handle did not signal exit: ${observerStderr.join('')}`,
    );
  } finally {
    // Cleanup is intentionally limited to the exact ChildProcess handle created above.
    // Never taskkill a PID obtained from process enumeration in this regression test.
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
    if (observer && observer.exitCode === null && observer.signalCode === null) observer.kill('SIGKILL');
  }

  console.log('PTT helper parent lifecycle test passed');
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
