'use strict';

// Exercise the shipped composition, not the dormant phone-service fixture.
// All data and listeners belong to this disposable test process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { once } = require('node:events');
const WebSocket = require('ws');
const { getRepoScratchPath } = require('./repo-scratch');
const { resolveBackendRuntimeFile: runtime } = require('./backend-runtime-paths');

test('release runtime cannot enable phone voice, serve certificates or accept audio with saved access', { timeout: 30000 }, async t => {
  const scratch = getRepoScratchPath('phone-voice-disabled');
  fs.mkdirSync(scratch, { recursive: true });
  const home = fs.mkdtempSync(path.join(scratch, 'run-'));
  for (const [key, value] of Object.entries({
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: path.join(home, '.config'),
    FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS: '1', REMOTE_ACCESS_ENABLE: '1',
    REMOTE_AIRCRAFT_CONTROL_ENABLE: '1', MOBILE_VOICE_ENABLE: '1',
    RECORDING_AUTO_START: '0', UPDATE_CHECKS_ENABLED: '0', CABIN_ANNOUNCEMENTS_ENABLED: '0',
  })) process.env[key] = value;
  for (const key of ['HOMEDRIVE', 'HOMEPATH', 'OneDrive', 'ONEDRIVE', 'OneDriveConsumer', 'OneDriveCommercial']) delete process.env[key];

  const storage = require(runtime('utils', 'storage-paths.js'));
  const settingsFile = storage.getSettingsFilePath();
  assert(!path.relative(home, settingsFile).startsWith('..'), 'never touch real user settings');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ mobileVoice: { enabled: true },
    network: { remoteAccess: true, remoteAircraftControl: true, updateChecks: false },
    recording: { autoStart: false }, cabinAnnouncements: { enabled: false } }));
  // Model an old test installation. The release must not even read its key.
  const identityFile = path.join(path.dirname(settingsFile), 'mobile-voice', 'identity.json');
  fs.mkdirSync(path.dirname(identityFile), { recursive: true });
  const identityBytes = 'inactive test identity; not a real certificate or key';
  fs.writeFileSync(identityFile, identityBytes);
  const readFile = fs.readFileSync;
  let identityReads = 0, tlsServers = 0;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (path.resolve(String(file)) === identityFile) identityReads++;
    return readFile.call(this, file, ...args);
  });
  t.mock.method(https, 'createServer', () => { tlsServers++; throw new Error('Phone TLS listener must stay disabled'); });
  const listen = http.Server.prototype.listen;
  const servers = [];
  t.mock.method(http.Server.prototype, 'listen', function(port, _host, callback) {
    servers.push(this);
    // Exercise production LAN authorization while binding fixtures to loopback.
    return listen.call(this, port, '127.0.0.1', callback);
  });
  const shutdown = new AbortController();
  const clients = [];
  let markReady;
  const ready = new Promise(resolve => { markReady = resolve; });
  const { runSimbridgeCore } = require(runtime('core', 'simbridge-core.js'));
  assert.equal(require(runtime('core', 'config.js')).http.mobileVoiceEnable, false);
  const work = runSimbridgeCore({ wsPort: 0, httpPort: 0, shutdownSignal: shutdown.signal,
    provider: { capabilities: { isMock: true, enableLandingRunner: false },
      start: async () => markReady(), stop: async () => {},
      nextFrame: () => new Promise(() => {}) } });
  // Attach rejection handling immediately while startup is pending.
  const stopped = work.then(() => ({ ok: true }), error => ({ ok: false, error }));
  t.after(async () => {
    for (const client of clients) client.terminate();
    shutdown.abort('phone_voice_release_check');
    const result = await stopped;
    if (!result.ok) throw result.error;
  });
  await Promise.race([ready, stopped.then(result => { throw result.error || new Error('Stopped before ready'); })]);
  assert.equal(servers.length, 2, 'only normal HTTP and telemetry WebSocket listeners start');
  const [wsPort, httpPort] = servers.map(server => server.address().port);
  const base = `http://127.0.0.1:${httpPort}`;
  const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
  assert(bootstrap.wsAuthToken, 'desktop bootstrap still works');
  async function assertHttpDisabled(headers, clientLabel) {
    for (const route of ['/api/mobile-voice', '/api/mobile-voice?setup=1', '/mobile-voice/ca.cer',
      '/mobile-voice/ca.cer?download=1', '/mobile-voice/audio', '/mobile-voice/host']) {
      for (const method of ['GET', 'POST', 'HEAD']) {
        const response = await fetch(base + route, { method, headers,
          ...(method === 'POST' ? { body: 'enable' } : {}) });
        assert.equal(response.status, 410, `${clientLabel}: ${method} ${route} stays unavailable`);
        assert.equal(response.headers.get('content-disposition'), null, 'no certificate attachment');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        if (method !== 'HEAD') assert.equal((await response.json()).enabled, false);
      }
    }
  }
  await assertHttpDisabled({ 'X-FlightFabric-Token': bootstrap.wsAuthToken }, 'privileged desktop');
  const browserHeaders = { Origin: base };
  const browserBootstrap = await (await fetch(`${base}/api/bootstrap`, { headers: browserHeaders })).json();
  assert.equal(browserBootstrap.wsAuthToken, '', 'browser context has no desktop credential');
  await assertHttpDisabled(browserHeaders, 'unpaired browser');
  async function connect(url, options) {
    const client = new WebSocket(url, options); clients.push(client);
    client.messages = [];
    client.on('message', data => client.messages.push(JSON.parse(data.toString())));
    client.on('error', () => {});
    await once(client, 'open');
    return client;
  }
  async function reply(client, predicate) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const message = client.messages.find(predicate);
      if (message) return message;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Expected backend reply did not arrive');
  }
  for (const port of [httpPort, wsPort]) {
    for (const route of ['/mobile-voice/host', '/mobile-voice/audio']) {
      const client = new WebSocket(`ws://127.0.0.1:${port}${route}?token=${bootstrap.wsAuthToken}`, { handshakeTimeout: 3000 });
      clients.push(client);
      await assert.rejects(once(client, 'open'), /Unexpected server response: (400|410)|socket hang up/,
        'retired host/audio upgrades cannot connect on either active listener');
    }
  }
  const desktop = await connect(`ws://127.0.0.1:${wsPort}/?token=${bootstrap.wsAuthToken}`);
  assert.equal((await reply(desktop, msg => msg.type === 'authorizationScope')).scope, 'full-control');
  desktop.send(JSON.stringify({ type: 'executeAircraftCommand', requestId: 'stale-phone-command',
    mobileVoiceSessionId: 'a'.repeat(32), commandId: 'autopilot.heading.set', value: 270 }));
  const rejected = await reply(desktop, msg => msg.requestId === 'stale-phone-command');
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /Phone voice is unavailable/);

  // Normal phone access still uses the existing explicit approval flow.
  assert.equal((await fetch(`${base}/phone`, { redirect: 'manual' })).status, 302);
  const request = await (await fetch(`${base}/api/device-pairing/request`, {
    method: 'POST', headers: { 'X-Flight-Fabric-Pairing': '1' } })).json();
  assert.equal(request.ok, true);
  desktop.send(JSON.stringify({ type: 'approveDevicePairingRequest', requestId: request.requestId,
    confirmationCode: request.confirmationCode, approvalId: 'normal-phone' }));
  assert.equal((await reply(desktop, msg => msg.type === 'devicePairingApprovalResult')).ok, true);
  const pairing = await fetch(`${base}/api/device-pairing/status?requestId=${request.requestId}`);
  const cookie = pairing.headers.get('set-cookie').split(';')[0];
  const phone = await connect(`ws://127.0.0.1:${wsPort}/`, {
    origin: base, headers: { Cookie: cookie } });
  assert.equal((await reply(phone, msg => msg.type === 'authorizationScope')).scope, 'aircraft-control');
  await assertHttpDisabled({ ...browserHeaders, Cookie: cookie }, 'paired phone');
  for (const mobileVoiceSessionId of ['a'.repeat(32), '', null]) {
    const requestId = `paired-phone-${String(mobileVoiceSessionId)}`;
    phone.send(JSON.stringify({ type: 'executeAircraftCommand', requestId,
      mobileVoiceSessionId, commandId: 'autopilot.heading.set', value: 270 }));
    const result = await reply(phone, msg => msg.requestId === requestId);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Aircraft control request failed.',
      'paired clients retain the existing sanitized error envelope');
  }
  for (const route of ['/mobile-voice/host', '/mobile-voice/audio']) {
    const client = new WebSocket(`ws://127.0.0.1:${wsPort}${route}`, {
      origin: base, headers: { Cookie: cookie }, handshakeTimeout: 3000 });
    clients.push(client);
    await assert.rejects(once(client, 'open'), /Unexpected server response: 410/,
      'pairing cannot restore retired phone audio/host upgrades');
  }

  assert.equal(tlsServers, 0, 'no TLS/certificate listener can be created');
  assert.equal(identityReads, 0, 'the old private-key cache is never loaded');
  assert.equal(readFile(identityFile, 'utf8'), identityBytes, 'old test data is untouched');
  assert.equal(Object.keys(require.cache).some(file => /[\\/]core[\\/]mobile-voice(?:-identity)?\.js$/.test(file)), false,
    'production never loads the dormant certificate/audio service');
});
