#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { WebSocket } = require('ws');
const {
  PROFILE_KEY,
  PROFILE_REVISION,
  createPreviewRuntime,
  resolveNpmCliPath,
} = require('../../scripts/dev/pmdg-737-preview');

const ROOT = path.resolve(__dirname, '..', '..');

function waitForMessage(messages, predicate, label, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      const match = messages.find(predicate);
      if (match) {
        resolve(match);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function waitForOpen(socket, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out opening preview WebSocket')), timeoutMs);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main() {
  const npmCliPath = resolveNpmCliPath();
  const npmProbe = spawnSync(process.execPath, [npmCliPath, '--version'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.ifError(npmProbe.error);
  assert.strictEqual(npmProbe.status, 0, npmProbe.stderr || 'npm CLI probe failed');

  const frontendRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-pmdg-preview-'));
  const indexPath = path.join(frontendRoot, 'index.html');
  const originalIndex = '<!doctype html><html><head><title>Fixture</title></head><body><main>Flight Fabric</main></body></html>';
  fs.writeFileSync(indexPath, originalIndex);

  let runtime;
  let socket;
  try {
    runtime = await createPreviewRuntime({
      rootDir: ROOT,
      frontendRoot,
      buildFrontend: false,
      openBrowser: false,
      scenario: 'cold-dark',
      httpPort: 0,
      wsPort: 0,
    });

    const previewUrl = new URL(runtime.url);
    assert.strictEqual(previewUrl.hostname, '127.0.0.1');
    assert.strictEqual(previewUrl.searchParams.get('tab'), 'autopilot');
    assert.strictEqual(Number(previewUrl.searchParams.get('port')), runtime.wsPort);
    assert.strictEqual(previewUrl.searchParams.get('previewPanel'), 'open');

    const htmlResponse = await fetch(runtime.url);
    const html = await htmlResponse.text();
    assert.strictEqual(htmlResponse.status, 200);
    assert.match(html, /\/__pmdg-preview\/client\.css/);
    assert.match(html, /\/__pmdg-preview\/client\.js/);
    assert.strictEqual(fs.readFileSync(indexPath, 'utf8'), originalIndex, 'preview must not alter frontend files');

    const clientResponse = await fetch(`${previewUrl.origin}/__pmdg-preview/client.js`);
    assert.strictEqual(clientResponse.status, 200);
    assert.match(await clientResponse.text(), /FIXTURE DATA/);

    const traversalResponse = await fetch(`${previewUrl.origin}/..%2fpackage.json`);
    assert.strictEqual(traversalResponse.status, 403, 'preview static server must block path traversal');

    const initialPublicState = await (await fetch(`${previewUrl.origin}/__pmdg-preview/state`)).json();
    assert.strictEqual(initialPublicState.scenario, 'cold-dark');
    assert.ok(initialPublicState.scenarios.length >= 8);

    const messages = [];
    socket = new WebSocket(runtime.wsUrl);
    socket.on('message', (payload) => messages.push(JSON.parse(payload.toString('utf8'))));
    await waitForOpen(socket);
    await waitForMessage(messages, (message) => message.type === 'authorizationScope', 'authorization scope');
    socket.send(JSON.stringify({ type: 'requestState' }));

    const profile = await waitForMessage(messages, (message) => message.type === 'aircraftProfile', 'aircraft profile');
    const coldDark = await waitForMessage(
      messages,
      (message) => message.type === 'aircraftSpecificState'
        && message.values['systems.electrical.batteryMode'] === 'off',
      'cold-and-dark state',
    );
    assert.strictEqual(profile.profile._profileKey, PROFILE_KEY);
    assert.strictEqual(profile.profile.profileRevision, PROFILE_REVISION);
    assert.ok(Object.keys(coldDark.actionCapabilities).length >= 100, 'fixture should expose the exact PMDG action surface');
    assert.strictEqual(
      Object.keys(coldDark.actionCapabilities).length,
      Object.keys(runtime.contracts.actions).length,
      'fixture action capabilities must match the PMDG source contract',
    );

    socket.send(JSON.stringify({
      type: 'executeAircraftControl',
      requestId: 'battery-on',
      profileKey: PROFILE_KEY,
      profileRevision: PROFILE_REVISION,
      control: 'aircraft-specific',
      operation: 'execute',
      actionId: 'systems.electrical.battery.on',
    }));
    await waitForMessage(
      messages,
      (message) => message.type === 'aircraftSpecificState'
        && message.values['systems.electrical.batteryMode'] === 'on',
      'battery readback',
    );
    const batteryResult = await waitForMessage(
      messages,
      (message) => message.type === 'aircraftControlResult' && message.requestId === 'battery-on',
      'battery action result',
    );
    assert.strictEqual(batteryResult.ok, true);

    socket.send(JSON.stringify({
      type: 'executeAircraftControl',
      requestId: 'ground-power-connect',
      profileKey: PROFILE_KEY,
      profileRevision: PROFILE_REVISION,
      control: 'aircraft-specific',
      operation: 'execute',
      actionId: 'systems.electrical.groundPower.connect',
    }));
    const groundPower = await waitForMessage(
      messages,
      (message) => message.type === 'aircraftSpecificState'
        && message.values['systems.electrical.transferBus1Powered'] === true
        && message.values['systems.electrical.transferBus2Powered'] === true,
      'ground power readback',
    );
    assert.strictEqual(groundPower.values['systems.electrical.transferBus1Powered'], true);

    const staleResponse = await fetch(`${previewUrl.origin}/__pmdg-preview/scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'stale' }),
    });
    assert.strictEqual(staleResponse.status, 200);
    assert.strictEqual((await staleResponse.json()).scenario, 'stale');
    await waitForMessage(
      messages,
      (message) => message.type === 'aircraftSpecificState' && message.sourceStatus?.overall === 'stale',
      'stale scenario broadcast',
    );

    const invalidResponse = await fetch(`${previewUrl.origin}/__pmdg-preview/scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'not-a-scenario' }),
    });
    assert.strictEqual(invalidResponse.status, 400);

    process.stdout.write('PMDG 737 preview fixture: integration test passed.\n');
  } finally {
    if (socket) socket.terminate();
    if (runtime) await runtime.close();
    fs.rmSync(frontendRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
