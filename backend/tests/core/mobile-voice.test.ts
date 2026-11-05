import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createMobileVoiceService } from '../../core/mobile-voice';
import { createDevicePairingManager } from '../../core/device-pairing';
import { loadMobileVoiceIdentity } from '../../core/mobile-voice-identity';
import { startHttpServer } from '../../core/http-server';
import { createWsServer } from '../../core/ws-bootstrap';
const WebSocket = require('ws');
const TOKEN = 'fixture-desktop-session';

async function fixture(t: import('node:test').TestContext, options: Partial<Pick<Parameters<typeof createMobileVoiceService>[0],
  'identityLoader' | 'port' | 'initiallyEnabled' | 'saveEnabled' | 'directory' | 'ips'>> = {}) {
  fs.mkdirSync('.tmp', { recursive: true });
  const directory = options.directory || fs.mkdtempSync(path.resolve('.tmp/mobile-voice-test-'));
  const preferenceFile = path.join(directory, 'access-test.json');
  const readPreference = () => fs.existsSync(preferenceFile) && JSON.parse(fs.readFileSync(preferenceFile, 'utf8')).enabled === true;
  let now = 0;
  const pairing = createDevicePairingManager({ now: () => now, sessionTtlMs: 10000 });
  const request = pairing.createRequest('127.0.0.1');
  assert.equal(request.ok, true);
  if (!request.ok) throw new Error('Fixture pairing failed');
  pairing.approveRequest(request.request.id, request.request.confirmationCode);
  const cookie = pairing.claimApprovedRequest(request.request.id, '127.0.0.1');
  const telemetry = createWsServer({ wsPort: 0, wsAuthToken: TOKEN, remoteAccessEnable: true,
    remoteAircraftControlEnable: true, devicePairing: pairing, Debug: { log() {} }, tlog() {},
    onClientConnected() {}, onClientMessage() {},
  }) as any;
  await once(telemetry, 'listening');
  const { httpServer: server } = startHttpServer({ httpPort: 0, wsPort: telemetry.address().port,
    remoteAccessEnable: true, wsAuthToken: TOKEN, devicePairing: pairing, Debug: { log() {} },
    handleAdditionalRequest: (req, res) => service.handleHttp(req, res),
  });
  await once(server, 'listening');
  const port = (server.address() as import('net').AddressInfo).port;
  const service = createMobileVoiceService({ httpServer: server, port: 0, ips: ['127.0.0.1'], directory,
    initiallyEnabled: readPreference(), saveEnabled: enabled => fs.writeFileSync(preferenceFile, JSON.stringify({ enabled })),
    token: TOKEN, pairing, upgradeTelemetry: (req, socket, head) => telemetry.handleUpgrade(req, socket, head,
      ws => telemetry.emit('connection', ws, req)), ...options });
  const sockets: any[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await service.dispose(); server.closeAllConnections();
    for (const socket of telemetry.clients) socket.terminate();
    await new Promise<void>(resolve => telemetry.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function configure(action: string, token = TOKEN) {
    const response = await fetch(`http://127.0.0.1:${port}/api/mobile-voice`, {
      method: 'POST', headers: { 'X-FlightFabric-Token': token }, body: action });
    return { code: response.status, body: await response.json() as any };
  }
  async function connect(host = false, options: Record<string, unknown> = {}) {
    const securePort = service.status().port;
    const ca = fs.existsSync(path.join(directory, 'identity.json'))
      ? JSON.parse(fs.readFileSync(path.join(directory, 'identity.json'), 'utf8')).cert : '';
    const socket = new WebSocket(host ? `ws://127.0.0.1:${port}/mobile-voice/host?token=${TOKEN}`
      : `wss://127.0.0.1:${securePort}/mobile-voice/audio`, {
      ca, origin: host ? 'http://127.0.0.1:8000' : `https://127.0.0.1:${securePort}`,
      headers: { Cookie: `__Secure-ff_voice_pair=${cookie}` }, ...options,
    });
    sockets.push(socket); socket.on('error', () => {});
    socket.messages = []; socket.on('message', (data: Buffer) => socket.messages.push(data));
    await once(socket, 'open');
    return socket;
  }
  async function secureRequest(route: string, method = 'GET') {
    const ca = JSON.parse(fs.readFileSync(path.join(directory, 'identity.json'), 'utf8')).cert;
    return new Promise<{ code: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = https.request(`https://127.0.0.1:${service.status().port}${route}`, {
        // Exercise the LAN request policy on a deterministic loopback transport.
        ca, method, headers: { Host: `192.168.1.50:${service.status().port}`, 'X-Flight-Fabric-Pairing': '1' },
      }, res => {
        let body = ''; res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ code: res.statusCode || 0, headers: res.headers, body }));
      });
      req.on('error', reject); req.end();
    });
  }
  return { directory, service, configure, connect, secureRequest, pairing, sockets, port, readPreference, expire: () => { now = 20000; } };
}
function frame(id: string, sequence = 0, rate = 16000, count = 2048) {
  const bytes = Buffer.alloc(44 + count * 4);
  bytes.write(id, 0, 'ascii'); bytes.writeUInt32LE(sequence, 32); bytes.writeUInt32LE(rate, 36); bytes.writeUInt32LE(count, 40);
  for (let i = 0; i < count; i++) bytes.writeFloatLE(Math.sin(i / 10) * 0.1, 44 + i * 4);
  return bytes;
}
async function start(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal((await f.configure('enable')).code, 200);
  const host = await f.connect(true);
  const startMessage = once(host, 'message');
  const phone = await f.connect();
  const msg = JSON.parse((await startMessage)[0].toString());
  assert.equal(msg.kind, 'start');
  const ready = once(phone, 'message'); host.send(JSON.stringify({ kind: 'ready', id: msg.id }));
  assert.equal(JSON.parse((await ready)[0].toString()).kind, 'ready');
  return { host, phone, id: msg.id };
}

test('mobile voice uses a trusted TLS identity, secure pairing and one dispatch per complete utterance', async t => {
  const f = await fixture(t), { host, phone, id } = await start(f);
  assert.equal(f.service.authorizeDispatch(id), false);
  const audio = once(host, 'message'); phone.send(frame(id));
  assert.deepEqual((await audio)[0], frame(id));
  const finished = once(host, 'message'); phone.send(JSON.stringify({ kind: 'finish', chunks: 1 }));
  assert.deepEqual(JSON.parse((await finished)[0].toString()), { kind: 'finish', id });
  assert.equal(f.service.authorizeDispatch(id), true);
  assert.equal(f.service.authorizeDispatch(id), false);
  const result = once(phone, 'message');
  host.send(JSON.stringify({ kind: 'status', id, status: 'sent', message: 'Heading set to 270', transcript: 'set heading two seven zero', done: true }));
  assert.equal(JSON.parse((await result)[0].toString()).message, 'Heading set to 270');
  const identity = await loadMobileVoiceIdentity(f.directory, ['127.0.0.1']);
  assert.equal(identity.fingerprint, f.service.status().fingerprint, 'reopening retains the phone-trusted identity');
});

test('remote voice cannot be enabled without desktop authority; HTTP pairing cannot authenticate audio', async t => {
  const f = await fixture(t);
  assert.equal((await f.configure('enable', 'wrong')).code, 403);
  assert.equal(f.service.status().enabled, false);
  await f.configure('enable'); await f.connect(true);
  await assert.rejects(f.connect(false, { headers: { Cookie: 'ff_aircraft_pair=ordinary-http-session' } }), /403/);
  await assert.rejects(f.connect(false, { origin: 'https://untrusted.example' }), /403/);
  await assert.rejects(f.connect(false, { ca: '' }), /certificate|verify/i);
});

test('phone setup receives only public connection metadata and downloads the matching certificate', async t => {
  const f = await fixture(t);
  const metadata = async () => {
    const response = await fetch(`http://127.0.0.1:${f.port}/api/mobile-voice`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  };
  assert.deepEqual(await metadata(), { enabled: false, preparing: false, available: false, port: null, fingerprint: '' });
  await f.configure('enable');
  const details = await metadata();
  assert.deepEqual(details, { enabled: true, preparing: false, available: false, port: f.service.status().port,
    fingerprint: f.service.status().fingerprint });
  const certificate = await fetch(`http://127.0.0.1:${f.port}/mobile-voice/ca.cer`);
  assert.equal(certificate.headers.get('content-type'), 'application/x-x509-ca-cert');
  const { X509Certificate } = await import('node:crypto');
  assert.equal(new X509Certificate(Buffer.from(await certificate.arrayBuffer())).fingerprint256, details.fingerprint);
  const entry = await fetch(`http://127.0.0.1:${f.port}/phone`, { redirect: 'manual' });
  assert.equal(entry.status, 302);
  assert.match(entry.headers.get('location') || '', /^\/remote\?wsPort=\d+$/);
  const unauthorized = await fetch(`http://127.0.0.1:${f.port}/api/mobile-voice`, { method: 'POST', body: 'enable' });
  assert.equal(unauthorized.status, 403, 'the phone can read setup but cannot enable its own access');
  await f.configure('disable');
  assert.deepEqual(await metadata(), { enabled: false, preparing: false, available: false, port: null, fingerprint: '' });
});

for (const fault of ['sequence', 'missing-chunk', 'invalid-pcm', 'revoked', 'disconnect', 'second-phone']) {
  test(`remote voice refuses ${fault} and allows a fresh attempt`, async t => {
    const f = await fixture(t), { host, phone, id } = await start(f);
    if (fault === 'second-phone') {
      const second = await f.connect();
      if (!second.messages.length) await once(second, 'message');
      assert.match(JSON.parse(second.messages[0].toString()).message, /busy/);
      assert.equal(phone.readyState, 1);
    } else {
      const cancelled = once(host, 'message');
      if (fault === 'sequence') phone.send(frame(id, 1));
      if (fault === 'missing-chunk') phone.send(JSON.stringify({ kind: 'finish', chunks: 1 }));
      if (fault === 'invalid-pcm') { const bytes = frame(id); bytes.writeFloatLE(NaN, 44); phone.send(bytes); }
      if (fault === 'revoked') { f.expire(); phone.send(frame(id)); }
      if (fault === 'disconnect') phone.close();
      assert.equal(JSON.parse((await cancelled)[0].toString()).kind, 'cancel');
      assert.equal(f.service.authorizeDispatch(id), false);
      if (fault !== 'revoked') {
        const next = once(host, 'message'); const retry = await f.connect();
        assert.notEqual(JSON.parse((await next)[0].toString()).id, id); retry.close();
      }
    }
  });
}

test('disabling phone access releases listener and sessions; reconnect does not reuse old authority', async t => {
  const f = await fixture(t), { host, phone, id } = await start(f);
  const closed = Promise.all([once(phone, 'close'), once(host, 'close')]);
  assert.equal((await f.configure('disable')).code, 200); await closed;
  assert.equal(f.service.status().enabled, false);
  assert.equal(f.service.authorizeDispatch(id), false);
  assert.equal((await f.configure('enable')).code, 200);
  await f.connect(true);
});

test('pairing expiry after a complete recording still prevents command dispatch', async t => {
  const f = await fixture(t), { host, phone, id } = await start(f);
  const audio = once(host, 'message'); phone.send(frame(id)); await audio;
  const final = once(host, 'message'); phone.send(JSON.stringify({ kind: 'finish', chunks: 1 })); await final;
  f.expire(); assert.equal(f.service.authorizeDispatch(id), false);
});

test('desktop disconnect after phone finish retires dispatch authority and permits a fresh host session', async t => {
  const f = await fixture(t), { host, phone, id } = await start(f);
  const audio = once(host, 'message'); phone.send(frame(id)); await audio;
  const final = once(host, 'message'); phone.send(JSON.stringify({ kind: 'finish', chunks: 1 })); await final;
  const closed = once(phone, 'close'); host.close(); await closed;
  assert.equal(f.service.authorizeDispatch(id), false, 'finished audio loses authority when its PC host disconnects');

  const nextHost = await f.connect(true);
  const nextStart = once(nextHost, 'message');
  const nextPhone = await f.connect();
  const nextId = JSON.parse((await nextStart)[0].toString()).id;
  assert.notEqual(nextId, id);
  const ready = once(nextPhone, 'message');
  // A late result for the retired utterance must not finish the new recording.
  nextHost.send(JSON.stringify({ kind: 'status', id, status: 'sent', done: true }));
  nextHost.send(JSON.stringify({ kind: 'ready', id: nextId }));
  assert.equal(JSON.parse((await ready)[0].toString()).kind, 'ready');
  assert.equal(f.service.authorizeDispatch(nextId), false, 'new authority still requires complete audio');
  const nextAudio = once(nextHost, 'message'); nextPhone.send(frame(nextId)); await nextAudio;
  const nextFinal = once(nextHost, 'message'); nextPhone.send(JSON.stringify({ kind: 'finish', chunks: 1 })); await nextFinal;
  assert.equal(f.service.authorizeDispatch(id), false);
  assert.equal(f.service.authorizeDispatch(nextId), true);
  assert.equal(f.service.authorizeDispatch(nextId), false, 'the replacement can dispatch only once');
});

test('capture timeout cancels the PC owner and releases the phone', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, phone, id } = await start(f);
  const cancelled = once(host, 'message'), closed = once(phone, 'close');
  t.mock.timers.tick(10001);
  assert.equal(JSON.parse((await cancelled)[0].toString()).kind, 'cancel');
  await closed; assert.equal(f.service.authorizeDispatch(id), false);
});

test('disabling during certificate preparation prevents a late listener and permits explicit retry', async t => {
  let release: () => void, entered: () => void, first = true;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, { identityLoader: async (...args) => {
    if (first) { first = false; entered(); await paused; }
    return loadMobileVoiceIdentity(...args);
  } });
  const enabling = f.configure('enable'); await started;
  await f.configure('disable'); release();
  assert.equal((await enabling).body.enabled, false);
  assert.equal(f.service.status().port, null);
  assert.equal((await f.configure('enable')).body.enabled, true);
});

test('invalid trusted-host terminal data cannot crash the service or keep a microphone session alive', async t => {
  const f = await fixture(t), { host, phone, id } = await start(f);
  const closed = once(phone, 'close'); host.send('null'); await closed;
  assert.equal(f.service.authorizeDispatch(id), false);
});

test('production HTTPS pairing and telemetry share secure authority without exposing the desktop token', async t => {
  const f = await fixture(t); await f.configure('enable');
  const request = await f.secureRequest('/api/device-pairing/request', 'POST');
  assert.equal(request.code, 201);
  const pending = JSON.parse(request.body);
  assert.equal(f.pairing.approveRequest(pending.requestId, pending.confirmationCode), true);
  const claimed = await f.secureRequest(`/api/device-pairing/status?requestId=${pending.requestId}`);
  assert.equal(claimed.code, 200);
  const cookie = claimed.headers['set-cookie']?.[0] || '';
  assert.match(cookie, /^__Secure-ff_voice_pair=/);
  assert.match(cookie, /; HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200; Secure$/);
  const bootstrap = await f.secureRequest('/api/bootstrap');
  assert.equal(bootstrap.code, 200);
  assert.equal(bootstrap.body.includes(TOKEN), false, 'LAN HTTPS never receives the privileged desktop token');
  const ca = JSON.parse(fs.readFileSync(path.join(f.directory, 'identity.json'), 'utf8')).cert;
  const socket = new WebSocket(`wss://127.0.0.1:${f.service.status().port}/ws`, { ca,
    origin: `https://127.0.0.1:${f.service.status().port}`, headers: { Cookie: cookie.split(';')[0] } });
  f.sockets.push(socket);
  const messages: any[] = []; socket.on('message', data => messages.push(JSON.parse(data.toString())));
  await once(socket, 'open');
  if (!messages.length) await once(socket, 'message');
  assert.equal(messages[0].scope, 'aircraft-control');
  const closed = once(socket, 'close');
  await f.configure('disable'); await closed;
  assert.equal(f.service.status().enabled, false, 'disable closes upgraded telemetry as well as audio');
});

test('occupied secure port fails cleanly and permits retry after the port is released', async t => {
  const occupied = http.createServer(); occupied.listen(0, '0.0.0.0'); await once(occupied, 'listening');
  t.after(() => occupied.close());
  const f = await fixture(t, { port: (occupied.address() as import('net').AddressInfo).port });
  assert.equal((await f.configure('enable')).code, 503);
  assert.equal(f.service.status().enabled, false);
  await new Promise<void>(resolve => occupied.close(() => resolve()));
  assert.equal((await f.configure('enable')).body.enabled, true);
});

test('saved phone access restores after service restart, reuses its certificate and stays off after disable', async t => {
  const first = await fixture(t);
  await first.service.ready;
  assert.equal(first.service.status().enabled, false, 'new users must opt in');
  assert.equal((await first.configure('enable')).code, 200);
  assert.equal(first.readPreference(), true);
  const fingerprint = first.service.status().fingerprint;
  await first.service.dispose();
  assert.equal(first.readPreference(), true, 'shutdown never clears the saved choice');
  const restarted = await fixture(t, { directory: first.directory });
  await restarted.service.ready;
  assert.equal(restarted.service.status().enabled, true, 'no new enable action is needed');
  assert.equal(restarted.service.status().fingerprint, fingerprint);
  assert.equal(restarted.service.status().available, false, 'restoring access does not create a host or grant phone authority');
  assert.equal((await restarted.configure('disable')).code, 200);
  await restarted.service.dispose();
  const off = await fixture(t, { directory: first.directory });
  await off.service.ready;
  assert.equal(off.service.status().enabled, false);
  assert.equal(off.readPreference(), false);
});

test('failed preference writes leave access unchanged and permit a retry', async t => {
  let rejectSave = true, saved = false;
  const f = await fixture(t, { saveEnabled: enabled => {
    if (rejectSave) throw new Error('Fixture: settings disk is read-only');
    saved = enabled;
  } });
  assert.equal((await f.configure('enable')).code, 503);
  assert.equal(f.service.status().enabled, false); assert.equal(saved, false);
  rejectSave = false;
  assert.equal((await f.configure('enable')).code, 200); assert.equal(saved, true);
  rejectSave = true;
  assert.equal((await f.configure('disable')).code, 503);
  assert.equal(f.service.status().enabled, true); assert.equal(saved, true);
  rejectSave = false;
  assert.equal((await f.configure('disable')).code, 200);
  assert.equal(f.service.status().enabled, false); assert.equal(saved, false);
});

test('startup failure keeps HTTP recovery available and never rewrites the saved choice', async t => {
  const occupied = http.createServer(); occupied.listen(0, '0.0.0.0'); await once(occupied, 'listening');
  t.after(() => occupied.close());
  const writes: boolean[] = [];
  const f = await fixture(t, { initiallyEnabled: true, port: (occupied.address() as import('net').AddressInfo).port,
    saveEnabled: value => { writes.push(value); } });
  await f.service.ready;
  assert.equal(f.service.status().enabled, false); assert.match(f.service.status().error, /could not start/);
  assert.deepEqual(writes, []);
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/phone`, { redirect: 'manual' })).status, 302);
  await new Promise<void>(resolve => occupied.close(() => resolve()));
  assert.equal((await f.configure('enable')).code, 200);
  assert.equal(f.service.status().error, ''); assert.deepEqual(writes, [true]);
});

test('disabled LAN access prevents restoring the saved phone listener', async t => {
  const f = await fixture(t, { initiallyEnabled: true, ips: [], saveEnabled: () => assert.fail('startup must not write') });
  await f.service.ready;
  assert.equal(f.service.status().enabled, false);
  assert.match(f.service.status().error, /could not start/);
});

test('disable and re-enable supersede delayed startup, including its late failure', async t => {
  let rejectFirst: (error: Error) => void, first = true;
  const paused = new Promise<never>((_, reject) => { rejectFirst = reject; });
  const writes: boolean[] = [];
  const f = await fixture(t, { initiallyEnabled: true, saveEnabled: value => { writes.push(value); },
    identityLoader: async (...args) => { if (first) { first = false; return paused; } return loadMobileVoiceIdentity(...args); } });
  assert.equal(f.service.status().preparing, true);
  assert.equal((await f.configure('disable')).code, 200);
  assert.equal((await f.configure('enable')).code, 200, 'new intent need not wait for retired certificate preparation');
  rejectFirst(new Error('Fixture: retired preparation failure')); await f.service.ready;
  assert.equal(f.service.status().enabled, true); assert.equal(f.service.status().error, '');
  assert.deepEqual(writes, [false, true]);
});
