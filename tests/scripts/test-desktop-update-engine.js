#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, '.tmp/update-engine-probe');
const ENGINE_ROOT = process.argv.includes('--packaged') ? path.join(ROOT, 'dist/electron/win-unpacked/resources/app.asar') : path.join(ROOT, 'electron');

// Generate a throwaway loopback TLS identity in memory. No private key is saved
// or trusted outside the isolated updater session used by this process.
function createFixtureTls() {
  const der = (tag, ...values) => {
    const bytes = Buffer.concat(values.map(value => Buffer.isBuffer(value) ? value : Buffer.from(value)));
    const length = bytes.length < 128 ? [bytes.length] : bytes.length < 256 ? [0x81, bytes.length] : [0x82, bytes.length >> 8, bytes.length & 255];
    return Buffer.concat([Buffer.from([tag, ...length]), bytes]);
  };
  const sequence = (...values) => der(0x30, ...values);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = sequence(Buffer.from('06092a864886f70d01010b0500', 'hex')); // sha256WithRSAEncryption
  const name = sequence(der(0x31, sequence(Buffer.from('0603550403', 'hex'), der(0x0c, 'isolated-updater-fixture'))));
  const utcTime = time => der(0x17, new Date(time).toISOString().replace(/[-:]/g, '').slice(2, 15).replace('T', '') + 'Z');
  const body = sequence(der(0x02, [1]), algorithm, name, sequence(utcTime(Date.now() - 86400000), utcTime(Date.now() + 86400000)), name,
    publicKey.export({ type: 'spki', format: 'der' }));
  const encoded = sequence(body, algorithm, der(0x03, [0], crypto.sign('sha256', body, privateKey)));
  const cert = '-----BEGIN CERTIFICATE-----\n' + encoded.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert, fingerprint: new crypto.X509Certificate(cert).fingerprint256 };
}

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
  await transport.setProxy({ mode: 'direct' });
  const fixtureHosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'downloads.example.invalid']);
  transport.setCertificateVerifyProc((request, callback) => {
    const pinned = fixtureHosts.has(request.hostname)
      && new crypto.X509Certificate(request.certificate.data).fingerprint256 === process.env.FF_UPDATER_FIXTURE_CERT;
    callback(pinned ? 0 : -2);
  });
  let fixtureSequence = 0;
  const fixtureCommand = (action, value) => new Promise(resolve => {
    const id = ++fixtureSequence;
    const reply = message => { if (message.id === id) { process.off('message', reply); resolve(message.value); } };
    process.on('message', reply);
    process.send({ id, action, value });
  });
  await transport.protocol.handle('https', request => {
    assert.equal(request.url, release.url);
    requests++;
    return new Response(data, { headers: { 'Content-Length': String(data.length), 'Content-Type': 'application/octet-stream' } });
  });
  const { createUpdateEngine } = require(path.join(ENGINE_ROOT, 'update-engine'));
  for (const file of ['update-engine.js', 'update-manifest.js']) {
    assert.deepEqual(fs.readFileSync(path.join(ENGINE_ROOT, file)), fs.readFileSync(path.join(ROOT, 'electron', file)), 'probe uses the final ' + file);
  }
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
  // Real Chromium redirects must pass the production webRequest guard at every
  // hop. Unlike protocol.handle(), the loopback HTTPS server exercises Chromium's
  // network hooks. Every payload is inert and unique, so the cache cannot skip a hop.
  const originalBeforeRequest = transport.webRequest.onBeforeRequest.bind(transport.webRequest);
  const originalHeadersReceived = transport.webRequest.onHeadersReceived.bind(transport.webRequest);
  let decisions = [];
  let responseDecisions = [];
  transport.webRequest.onBeforeRequest = listener => originalBeforeRequest(listener && ((details, callback) => {
    listener(details, result => {
      decisions.push({ url: details.url, cancelled: result.cancel });
      callback(result);
    });
  }));
  transport.webRequest.onHeadersReceived = listener => originalHeadersReceived(listener && ((details, callback) => {
    listener(details, result => {
      responseDecisions.push({ url: details.url, status: details.statusCode, cancelled: result.cancel });
      callback(result);
    });
  }));
  const renamedUrl = url => url.replace('/yenbuilds/flight-fabric/', '/yenbuilds/flightfabric-desktop/');
  const redirectScenarios = [
    { name: 'existing repository to existing release CDN', directCdn: true, cdn: 'release-assets.githubusercontent.com' },
    { name: 'old repository to renamed repository and release CDN', startRenamed: false, destination: old => renamedUrl(old), cdn: 'release-assets.githubusercontent.com' },
    { name: 'renamed repository to old repository and object CDN', startRenamed: true, destination: old => old, cdn: 'objects.githubusercontent.com' },
    { name: 'direct renamed repository installer', startRenamed: true },
    { name: 'renamed redirect with corrupt CDN payload', destination: old => renamedUrl(old), cdn: 'release-assets.githubusercontent.com', corrupt: true },
    // Deliberately invalid redirects exercise the signed installer's URL scope.
    { name: 'other repository', destination: old => old.replace('/flight-fabric/', '/other-repository/'), rejected: true },
    { name: 'lookalike renamed repository', destination: old => renamedUrl(old).replace('/flightfabric-desktop/', '/flightfabric-desktop-extra/'), rejected: true },
    { name: 'other release version', destination: old => renamedUrl(old).replace('/releases/download/v0.14.', '/releases/download/v0.15.'), rejected: true },
    { name: 'other installer filename', destination: old => renamedUrl(old).replace(/[^/]+\.exe$/, 'Other-Installer.exe'), rejected: true },
    { name: 'installer URL query', destination: old => renamedUrl(old) + '?redirect=unexpected', rejected: true },
    { name: 'untrusted download host', destination: old => old.replace('github.com', 'downloads.example.invalid'), rejected: true },
  ];
  try {
    for (const [index, scenario] of redirectScenarios.entries()) {
      const bytes = Buffer.from('Inert redirect fixture ' + index + ': ' + scenario.name);
      const version = '0.14.' + index;
      const oldUrl = publishedInstallerUrl(version);
      const candidate = { ...release, version, url: scenario.startRenamed ? renamedUrl(oldUrl) : oldUrl,
        size: bytes.length, sha512: crypto.createHash('sha512').update(bytes).digest('base64') };
      const cdnUrl = scenario.cdn && 'https://' + scenario.cdn + '/inert-updater-probe/' + version + '/installer.exe?token=fixture';
      const destination = scenario.directCdn ? cdnUrl : scenario.destination?.(oldUrl);
      decisions = [];
      responseDecisions = [];
      await fixtureCommand('configure', { start: candidate.url, destination, cdnUrl,
        bytes: (scenario.corrupt ? Buffer.alloc(bytes.length, 255) : bytes).toString('base64') });
      const redirectEngine = createUpdateEngine({ release: candidate, currentVersion: '0.12.1', signal: new AbortController().signal, onProgress() {} });
      const launchesBefore = spawned.length;
      try {
        if (scenario.rejected) {
          await assert.rejects(redirectEngine.download(), scenario.name + ' must be rejected');
          const requested = await fixtureCommand('requests');
          assert.deepEqual(requested, [candidate.url], 'rejected destination must never reach the transport');
          assert.deepEqual(decisions, [{ url: candidate.url, cancelled: false }, { url: destination, cancelled: true }],
            'production webRequest guard must reject the actual redirect destination');
        } else {
          if (scenario.corrupt) await assert.rejects(redirectEngine.download(), /sha512 checksum mismatch/i,
            'allowing a repository alias must never bypass installer integrity');
          else {
            const file = await redirectEngine.download();
            assert.deepEqual(fs.readFileSync(file), bytes);
          }
          const requested = await fixtureCommand('requests');
          const expected = [...new Set([candidate.url, destination, cdnUrl].filter(Boolean))];
          assert.deepEqual(requested, expected, 'real downloader must follow each expected redirect');
          assert.deepEqual(decisions, expected.map(url => ({ url, cancelled: false })),
            'production webRequest guard must allow every actual redirect hop');
          assert.deepEqual(responseDecisions, expected.map((url, hop) => ({ url, status: hop === expected.length - 1 ? 200 : 302, cancelled: false })),
            'production header guard must inspect each redirect and final payload');
        }
        assert.equal(spawned.length, launchesBefore, 'redirect probes never launch an installer');
        console.log('Real updater redirect guard passed: ' + scenario.name + '.');
      } finally { redirectEngine.dispose(); }
    }
  } finally {
    transport.webRequest.onBeforeRequest = originalBeforeRequest;
    transport.webRequest.onHeadersReceived = originalHeadersReceived;
  }
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
  const tls = createFixtureTls();
  let fixture;
  let requests = [];
  const server = require('node:https').createServer(tls, (request, response) => {
    const url = 'https://' + request.headers.host + request.url;
    requests.push(url);
    if (url === fixture?.start && fixture.destination) response.writeHead(302, { Location: fixture.destination }).end();
    else if (url === fixture?.destination && fixture.cdnUrl && fixture.destination !== fixture.cdnUrl) response.writeHead(302, { Location: fixture.cdnUrl }).end();
    else if (url === (fixture?.cdnUrl || fixture?.start)) {
      const bytes = Buffer.from(fixture.bytes, 'base64');
      response.writeHead(200, { 'Content-Length': bytes.length, 'Content-Type': 'application/octet-stream' }).end(bytes);
    } else response.writeHead(500).end('Unexpected fixture request');
  });
  let timer;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    env.FF_UPDATER_FIXTURE_CERT = tls.fingerprint;
    // These resolver rules belong only to this child process. Map every fixture
    // host to loopback and make all other names unresolvable; never reach GitHub.
    const hostRules = ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'downloads.example.invalid']
      .map(host => 'MAP ' + host + ' 127.0.0.1:' + server.address().port).concat('MAP * ~NOTFOUND').join(',');
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'),
      ['--host-resolver-rules=' + hostRules, __filename, ...process.argv.slice(2)], { cwd: ROOT, env, windowsHide: true, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    child.on('message', message => {
      if (message.action === 'configure') { fixture = message.value; requests = []; }
      child.send({ id: message.id, value: message.action === 'requests' ? requests : null });
    });
    timer = setTimeout(() => child.kill(), 20000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, 'updater adapter runtime probe');
  } finally { clearTimeout(timer); server.closeAllConnections(); server.close(); }
}
(process.versions.electron ? probe() : main()).catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1); else process.exitCode = 1;
});
