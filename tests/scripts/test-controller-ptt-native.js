'use strict';

// Integration check: no injected keyboard input, audio or simulator commands.
// Test the default build, or the exact helper bundled in a packaged app.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createPushToTalkHook } = require('../../electron/voice-push-to-talk-hook');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--helper')) throw new Error('Usage: test-controller-ptt-native.js [--helper path]');
const helper = args.length ? path.resolve(args[1])
  : path.resolve(__dirname, '../../electron/voice-native/ptt-hook/target/release/flight-fabric-ptt-hook.exe');

function run(args, { stopAfterReady = false, stopAfterHeartbeat = false, timeout = 35000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, args, { windowsHide: true, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', stoppedByTest = false;
    const start = performance.now();
    const timer = setTimeout(() => { child.kill(); reject(new Error('Native controller check timed out.')); }, timeout);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) { child.kill(); reject(new Error('Excessive helper output')); }
      if ((stopAfterReady && stdout.includes('"type":"ready"'))
        || (stopAfterHeartbeat && (stdout.match(/"type":"heartbeat"/g) || []).length >= 2)) {
        stoppedByTest = true; child.kill();
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      try { resolve({ code, stderr, stoppedByTest, duration: performance.now() - start,
        events: stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) }); }
      catch (error) { reject(error); }
    });
  });
}

async function main() {
  if (process.platform !== 'win32') return;
  const keyboard = await run(['--shortcut', 'Control+Alt+Shift+F12'], { stopAfterReady: true, timeout: 8000 });
  assert.equal(keyboard.stoppedByTest, true); assert.equal(keyboard.stderr, '');
  assert.equal(keyboard.events[0].type, 'ready');
  assert.equal(keyboard.events.some(event => ['down', 'up', 'stopped'].includes(event.type)), false);
  console.log('PASS standalone keyboard Raw Input registration becomes ready and owned child stops on request');
  const singleKeys = ['CapsLock', 'LeftControl', 'RightControl', 'LeftAlt', 'RightAlt',
    'LeftShift', 'RightShift', 'LeftSuper', 'RightSuper'];
  for (const shortcut of singleKeys) {
    for (const controllerEnabled of [false, true]) {
      const args = controllerEnabled
        ? ['--controller-integration', '--shortcut', shortcut, '--device-path', 'FlightFabric-absent-controller-smoke',
          '--report-id', '0', '--collection', '0', '--button', '1']
        : ['--shortcut', shortcut];
      const result = await run(args, { stopAfterReady: true, timeout: 8000 });
      assert.equal(result.stoppedByTest, true, `${shortcut}: helper reaches readiness`);
      assert.equal(result.stderr, '');
      assert.equal(result.events[0].type, 'ready');
      assert.equal(result.events.some(event => event.type === 'stopped'), false);
      // Real keys may be pressed on the host during this read-only check.
      // Their input events are permitted; the fixture neither injects nor acts on them.
    }
  }
  console.log('PASS Caps Lock and all eight sided modifiers start in keyboard-only and combined helpers');
  const combined = await run(['--controller-integration', '--shortcut', 'Control+Alt+Shift+F12',
    '--device-path', 'FlightFabric-absent-controller-smoke', '--report-id', '0', '--collection', '0', '--button', '1'],
  { stopAfterHeartbeat: true, timeout: 8000 });
  assert.equal(combined.stoppedByTest, true); assert.equal(combined.stderr, '');
  assert.equal(combined.events[0].type, 'ready'); assert.equal(combined.events[0].controllers, 0);
  assert.ok(combined.events.filter(event => event.type === 'heartbeat').length >= 2);
  assert.equal(combined.events.some(event => ['press', 'release', 'down', 'up', 'device'].includes(event.type)), false);
  console.log('PASS separate keyboard and controller registrations coexist with controller-loop heartbeat');
  const watch = await run(['--controller-integration', '--shortcut', '', '--device-path', 'FlightFabric-absent-controller-smoke',
    '--report-id', '0', '--collection', '0', '--button', '1'], { stopAfterHeartbeat: true, timeout: 8000 });
  assert.equal(watch.stoppedByTest, true); assert.equal(watch.stderr, '');
  assert.equal(watch.events[0].type, 'ready'); assert.equal(watch.events[0].controllers, 0);
  assert.ok(watch.events.filter(event => event.type === 'heartbeat').length >= 2);
  assert.equal(watch.events.some(event => ['press', 'release', 'down', 'up', 'device'].includes(event.type)), false);
  console.log('PASS continuous monitoring, heartbeat and exact-device isolation; owned child stops on request');
  let ownedChild; const failures = [];
  const hook = createPushToTalkHook({ helperPath: helper, controllerEnabled: true,
    spawnProcess: (...args) => (ownedChild = spawn(...args)), onDown() {}, onUp() {},
    onError: error => failures.push(error) });
  try {
    await hook.setBinding({ controller: { version: 1, devicePath: 'FlightFabric-absent-controller-smoke',
      reportId: 0, linkCollection: 0, button: 1 } });
    assert.equal(hook.getInfo().registered, true);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { hook.dispose(); reject(new Error('Wrapper did not stop its failed helper')); }, 5000);
      ownedChild.once('close', () => { clearTimeout(timer); resolve(); });
      ownedChild.stdout.destroy(new Error('Injected output-pipe failure'));
    });
    assert.equal(hook.getInfo().registered, false);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].message, 'Push-to-talk helper output closed.');
    assert.equal(failures[0].reason, 'output-pipe-failure');
    assert.equal(hook.getInfo().failureReason, 'output-pipe-failure');
    console.log('PASS real native helper output-pipe failure stops the owned child and revokes registration once');
  } finally { hook.dispose(); }
  const setup = await run(['--controller-setup', '--seconds', '30']);
  assert.equal(setup.code, 0, setup.stderr);
  assert.ok(setup.duration >= 29000 && setup.duration < 35000);
  assert.equal(setup.events.at(-1).type, 'stopped'); assert.equal(setup.events.at(-1).reason, 'timeout');
  assert.equal(setup.events.at(-2).type, 'cancel');
  console.log('PASS native button setup stops itself after 30 seconds and cancels rather than submitting');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
