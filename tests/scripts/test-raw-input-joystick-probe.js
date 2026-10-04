#!/usr/bin/env node
'use strict';

// Explicit developer check, not part of ordinary app startup or the general
// suite: briefly observes local controller reports without audio or commands.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CRATE = path.join(ROOT, 'electron', 'voice-native', 'ptt-hook');
const MANIFEST = path.join(CRATE, 'Cargo.toml');
const PROBE = path.join(CRATE, 'target', 'debug', 'flight-fabric-joystick-probe.exe');

function run(args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(PROBE, args, { cwd: ROOT, windowsHide: true, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) child.kill();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) child.kill();
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}

function events(result) {
  assert.equal(result.timedOut, false, 'diagnostic must stop itself');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const parsed = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
  for (let i = 0; i < parsed.length; i += 1) {
    assert.equal(parsed[i].sequence, i + 1, 'ordered, gap-free event stream');
    assert.ok(Number.isSafeInteger(parsed[i].elapsedUs));
    if (i) assert.ok(parsed[i].elapsedUs >= parsed[i - 1].elapsedUs);
    assert.ok(['device', 'device-error', 'ready', 'baseline', 'press', 'release', 'cancel', 'stopped'].includes(parsed[i].type));
  }
  return parsed;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('Raw Input controller diagnostic checks skipped (Windows only)');
    return;
  }

  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--offline', '--no-deps', '--format-version', '1', '--manifest-path', MANIFEST],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true }));
  const crate = metadata.packages.find((item) => item.name === 'flight-fabric-ptt-hook');
  const probe = crate.targets.find((target) => target.name === 'flight-fabric-joystick-probe');
  assert.deepEqual(probe['required-features'], ['raw-input-probe']);
  assert.deepEqual(crate.features.default, ['controller-ptt'], 'normal builds enable controller input without the diagnostic');
  const packaging = JSON.parse(fs.readFileSync(path.join(ROOT, 'electron', 'package.json'), 'utf8')).build;
  assert.ok(packaging.extraResources.some((item) => item.from === 'voice-native/ptt-hook/target/release/flight-fabric-ptt-hook.exe'));
  assert.equal(JSON.stringify(packaging).includes('flight-fabric-joystick-probe'), false);

  execFileSync('cargo', ['build', '--locked', '--offline', '--manifest-path', MANIFEST,
    '--features', 'raw-input-probe', '--bin', 'flight-fabric-joystick-probe'],
  { cwd: ROOT, stdio: 'inherit', windowsHide: true });

  for (const args of [[], ['--watch'], ['--watch', '--seconds', '0'], ['--watch', '--seconds', '61'], ['--list', '--watch']]) {
    const result = await run(args);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '', 'bad arguments cannot begin monitoring');
    assert.match(result.stderr, /Usage:/);
  }
  console.log('PASS explicit invocation, bounded arguments and production packaging isolation');

  const listed = events(await run(['--list']));
  assert.equal(listed.at(-1).reason, 'listed');
  assert.equal(listed.some((event) => ['press', 'release', 'baseline'].includes(event.type)), false);
  const ready = listed.find((event) => event.type === 'ready');
  assert.equal(ready.mode, 'list');
  assert.equal(ready.controllers, listed.filter((event) => event.type === 'device' && event.connected).length);
  for (const device of listed.filter(event => event.type === 'device')) {
    assert.equal(typeof device.name, 'string');
    assert.ok(Array.from(device.name).length <= 100, 'display names are bounded');
    assert.doesNotMatch(device.name, /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
    console.log(`Controller display name: ${device.name || '(Windows name unavailable; UI uses fallback)'}`);
  }
  console.log(`PASS list-only enumeration: ${ready.controllers} controller collection(s), ${listed.filter((event) => event.type === 'device-error').length} descriptor error(s)`);

  const watched = events(await run(['--watch', '--seconds', '2']));
  assert.equal(watched.find((event) => event.type === 'ready').mode, 'watch');
  assert.equal(watched.at(-1).reason, 'timeout');
  assert.equal(watched.at(-2).type, 'cancel', 'timeout cancels; it must not synthesize a normal release');
  console.log(`PASS bounded background session: ${watched.filter((event) => event.type === 'baseline').length} baseline(s); physical button behavior is not asserted`);

  const missing = events(await run(['--watch', '--seconds', '1', '--device-path', 'FlightFabric-test-device-that-does-not-exist']));
  assert.equal(missing.find((event) => event.type === 'ready').controllers, 0);
  assert.equal(missing.some((event) => ['device', 'press', 'release', 'baseline'].includes(event.type)), false,
    'an absent exact path must never fall back to another device');
  console.log('PASS absent device cannot select a different controller');

  const again = events(await run(['--watch', '--seconds', '1']));
  assert.equal(again.at(-1).type, 'stopped');
  console.log('PASS subsequent session can register and shut down cleanly');
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
