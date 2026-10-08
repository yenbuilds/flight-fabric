#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, '.tmp/update-engine-probe');
const ENGINE_ROOT = process.argv.includes('--packaged') ? path.join(ROOT, 'dist/electron/win-unpacked/resources/app.asar') : path.join(ROOT, 'electron');

async function probe() {
  const { app, session, shell } = require('electron');
  const childProcess = require('node:child_process');
  const { EventEmitter } = require('node:events');
  app.setPath('userData', path.join(OUTPUT, 'profile-' + process.pid));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const { NsisUpdater } = require(path.join(ENGINE_ROOT, 'node_modules/electron-updater'));
  const { ElectronAppAdapter } = require(path.join(ENGINE_ROOT, 'node_modules/electron-updater/out/ElectronAppAdapter'));
  // Isolated process-local fixture configuration; no development bypass is
  // added to FlightFabric and no user's update cache is accessed.
  Object.defineProperty(app, 'isPackaged', { value: true });
  app.getVersion = () => '0.12.1';
  Object.defineProperty(ElectronAppAdapter.prototype, 'baseCachePath', { get: () => OUTPUT });
  NsisUpdater.prototype.loadUpdateConfig = async () => ({ updaterCacheDirName: 'cache-' + process.pid });
  NsisUpdater.prototype.quitAndInstall = () => { throw new Error('Unawaited quit forbidden in this test'); };
  shell.openPath = () => { throw new Error('Unverified shell fallback forbidden in this test'); };
  let quits = 0;
  app.quit = () => { quits++; };
  const spawned = [];
  const outcomes = [];
  childProcess.spawn = (command, args, options) => {
    assert(outcomes.length, 'all process launches must have a fixture outcome');
    const outcome = outcomes.shift();
    const child = new EventEmitter();
    child.unref = () => {};
    spawned.push({ command, args, options });
    // A PID alone is not enough: deliver the actual terminal spawn event later.
    child.pid = 123;
    setImmediate(() => outcome === 'spawn' ? child.emit('spawn')
      : child.emit('error', Object.assign(new Error('Deliberately simulated launch failure'), { code: outcome })));
    return child;
  };
  const data = Buffer.from('Inert update transport fixture. Never an executable.');
  const { publishedInstallerUrl } = require('../../scripts/release-names');
  const release = { version: '0.13.0', url: publishedInstallerUrl('0.13.0'), size: data.length,
    sha512: crypto.createHash('sha512').update(data).digest('base64'), notes: '', kind: 'nsis' };
  let requests = 0;
  const transport = session.fromPartition('electron-updater', { cache: false });
  await transport.protocol.handle('https', request => {
    assert.equal(request.url, release.url);
    requests++;
    return new Response(data, { headers: { 'Content-Length': String(data.length), 'Content-Type': 'application/octet-stream' } });
  });
  const { createUpdateEngine } = require(path.join(ENGINE_ROOT, 'update-engine'));
  assert.deepEqual(fs.readFileSync(path.join(ENGINE_ROOT, 'update-engine.js')), fs.readFileSync(path.join(ROOT, 'electron/update-engine.js')), 'probe uses the final engine source');
  const controller = new AbortController();
  const engine = createUpdateEngine({ release, currentVersion: '0.12.1', signal: controller.signal, onProgress() {} });
  try {
    const file = await engine.download();
    assert.deepEqual(fs.readFileSync(file), data);
    assert.equal(requests, 1, 'only the authenticated full installer is requested');
    assert(file.startsWith(OUTPUT + path.sep));
    outcomes.push('ENOENT');
    await assert.rejects(engine.install(), /could not start/);
    assert.equal(spawned.length, 1, 'missing installer does not use an unverified shell fallback');
    assert.equal(quits, 0);
    outcomes.push('EACCES', 'EPERM');
    await assert.rejects(engine.install(), /could not start/);
    assert.equal(spawned.length, 3, 'denied launch attempts the bundled elevation helper exactly once');
    assert.equal(path.basename(spawned[2].command), 'elevate.exe');
    assert.equal(quits, 0, 'an asynchronous launch failure must leave the old app available');
    outcomes.push('spawn');
    let launched = false;
    const pending = engine.install().then(() => { launched = true; });
    await Promise.resolve();
    assert.equal(launched, false, 'PID assignment cannot authorize quit before the spawn event');
    await pending;
    assert.equal(quits, 0, 'main owns quitting after the awaited handoff');
    assert.equal(spawned[3].command, file);
    assert.deepEqual(spawned[3].args, ['--updated', '/S', '--force-run']);
    assert.equal(spawned[3].options.windowsHide, true);
    console.log('Real updater download and asynchronous launch-failure/retry probes passed; all child spawns were intercepted, no installer executed.');
  } finally { engine.dispose(); transport.protocol.unhandle('https'); }
  // Exercise the real downloader with interrupted/cancelled/corrupt inert responses.
  // Each scenario has distinct bytes, so no previous cache entry can satisfy it.
  for (const [index, failure] of ['disconnect', 'cancel', 'checksum'].entries()) {
    const bytes = Buffer.alloc(128 * 1024, index + 1);
    const version = '0.13.' + (index + 2);
    const candidate = { ...release, version, url: publishedInstallerUrl(version), size: bytes.length,
      sha512: crypto.createHash('sha512').update(bytes).digest('base64') };
    const abort = new AbortController();
    let healthy = false;
    let attempts = 0;
    let stalledBody;
    await transport.protocol.handle('https', request => {
      assert.equal(request.url, candidate.url);
      attempts++;
      const headers = { 'Content-Length': String(bytes.length), 'Content-Type': 'application/octet-stream' };
      if (healthy) return new Response(bytes, { headers });
      if (failure === 'checksum') return new Response(Buffer.alloc(bytes.length, 255), { headers });
      return new Response(new ReadableStream({
        start(controller) {
          stalledBody = controller;
          controller.enqueue(bytes.subarray(0, bytes.length / 2));
          setImmediate(() => {
            if (failure === 'cancel') abort.abort();
            else controller.error(new Error('Deliberately simulated network interruption'));
          });
        },
      }), { headers });
    });
    let failedEngine = createUpdateEngine({ release: candidate, currentVersion: '0.12.1', signal: abort.signal, onProgress() {} });
    try {
      const launchesBefore = spawned.length;
      await assert.rejects(failedEngine.download(), failure + ' must not yield an installable file');
      assert.equal(attempts, 1, 'failure was exercised through the transport');
      assert.equal(spawned.length, launchesBefore, 'download failure never launches anything');
      failedEngine.dispose(); failedEngine = null;
      try { stalledBody?.close(); } catch {} // Release the cancelled fixture body.
      healthy = true;
      const retry = createUpdateEngine({ release: candidate, currentVersion: '0.12.1', signal: new AbortController().signal, onProgress() {} });
      try {
        const file = await retry.download();
        assert.deepEqual(fs.readFileSync(file), bytes);
        assert.equal(attempts, 2, 'retry fetches a complete payload rather than accepting the partial cache');
        assert.equal(spawned.length, launchesBefore);
      } finally { retry.dispose(); }
      console.log('Real updater ' + failure + ' failure and complete retry passed.');
    } finally { failedEngine?.dispose(); transport.protocol.unhandle('https'); }
  }
  app.exit(0);
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename, ...process.argv.slice(2)], { cwd: ROOT, env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 20000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, 'updater adapter runtime probe');
  } finally { clearTimeout(timer); }
}
(process.versions.electron ? probe() : main()).catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1); else process.exitCode = 1;
});
