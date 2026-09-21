#!/usr/bin/env node
'use strict';

// Verify the release hold in the actual built helper. Joystick modes must
// reject before device access, even when invoked directly by an older client.

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createPushToTalkHelperSpawnOptions } = require('../../electron/voice-push-to-talk-hook');

const ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(ROOT, 'electron', 'voice-native', 'ptt-hook', 'Cargo.toml');
const HELPER = path.join(ROOT, 'electron', 'voice-native', 'ptt-hook', 'target', 'release', 'flight-fabric-ptt-hook.exe');

function runHelper(args, { durationMs = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(HELPER, args, createPushToTalkHelperSpawnOptions());
    const lines = [];
    const stderr = [];
    let output = '';
    let exited = false;
    let timer = null;
    child.stdout.on('data', (chunk) => {
      output += Buffer.from(chunk).toString('utf8');
      while (output.includes('\n')) {
        const index = output.indexOf('\n');
        lines.push(output.slice(0, index).replace(/\r$/, ''));
        output = output.slice(index + 1);
      }
    });
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk).toString('utf8')));
    child.once('error', reject);
    child.once('exit', (code) => {
      exited = true;
      clearTimeout(timer);
      resolve({ code, lines, stderr: stderr.join(''), killed: child.killed });
    });
    // Only the exact ChildProcess handle above is ever terminated.
    timer = setTimeout(() => { if (!exited) child.kill(); }, durationMs);
  });
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('PTT helper joystick mode test skipped (Windows only)');
    return;
  }
  execFileSync(
    'cargo',
    ['build', '--manifest-path', MANIFEST, '--release', '--locked'],
    { cwd: ROOT, stdio: 'inherit', windowsHide: true },
  );
  assert.equal(fs.existsSync(HELPER), true, 'PTT helper build output must exist');

  // Valid joystick invocations must fail before ready, hook setup or device I/O.
  for (const args of [
    ['--learn-joystick'],
    ['--joystick', '044F:B10A', '--button', '5'],
    ['--shortcut', 'Control+Alt+Space', '--joystick', '044F:B10A', '--button', '5'],
    ['--joystick', '044F:B10A', '--button', '5', '--device-path', 'saved-device'],
  ]) {
    const rejected = await runHelper(args);
    assert.equal(rejected.code, 2, 'joystick mode is disabled in the built binary');
    assert.equal(rejected.killed, false, 'the helper rejects the mode itself');
    assert.deepEqual(rejected.lines, [], 'no ready, device or button events may be emitted');
    assert.match(rejected.stderr, /joystick push-to-talk is disabled in this release/);
  }

  for (const args of [
    [],
    ['--joystick', '044F:B10A'],
    ['--button', '5'],
    ['--joystick', '044F:B10A', '--button', '0'],
    ['--learn-joystick', '--shortcut', 'Control+Alt+Space'],
    ['--joystick', '044F:B10A', '--button', '1', '--device-path', ''],
  ]) {
    const rejected = await runHelper(args, { durationMs: 3000 });
    assert.equal(rejected.code, 2, `helper must reject ${JSON.stringify(args)}`);
    assert.deepEqual(rejected.lines, [], 'a rejected invocation prints nothing on stdout');
    assert.match(rejected.stderr, /usage|needs|must|not usable/i);
  }

  console.log('PTT helper rejects all joystick modes before device access');
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
