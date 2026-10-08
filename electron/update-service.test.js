'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { keyId } = require('./update-manifest');
const { createUpdateService } = require('./update-service');

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture(overrides = {}) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const der = pair.publicKey.export({ type: 'spki', format: 'der' });
  const release = { version: '0.13.0', sha512: 'fixture', size: 100, url: 'fixture', notes: 'A release' };
  let offered = release;
  const events = [];
  const calls = [];
  const service = createUpdateService({ currentVersion: '0.12.1', supported: true,
    trust: { enabled: true, keys: [{ id: keyId(der), publicKey: der.toString('base64') }] },
    feed: { read: async () => ({ release: offered }) }, cachePath: path.resolve(__dirname, '../.tmp'),
    createEngine: () => ({ download: async () => { calls.push('download'); return 'fixture'; }, install: () => calls.push('install'), dispose: () => calls.push('dispose') }),
    recover: async () => true, prepare: async () => calls.push('prepare'), verify: async () => calls.push('verify'),
    handoff: async (install) => { calls.push('handoff'); install(); }, onState: s => events.push(s), ...overrides });
  return { service, release, calls, events, offer: value => { offered = value; } };
}

test('check/download never install; explicit installation waits for prepare and reverification', async () => {
  const f = fixture();
  await f.service.check();
  assert.deepEqual(f.calls, []);
  assert.equal(f.service.snapshot().phase, 'available');
  await f.service.download();
  assert.deepEqual(f.calls, ['download', 'verify']);
  assert.equal(f.service.snapshot().phase, 'ready');
  await f.service.install();
  assert.deepEqual(f.calls, ['download', 'verify', 'verify', 'prepare', 'verify', 'handoff', 'install']);
});

test('withdrawal or newer release after download invalidates installation', async () => {
  for (const replacement of [null, { version: '0.14.0', size: 200, sha512: 'other', url: 'other', notes: '' }]) {
    const f = fixture();
    await f.service.download();
    f.offer(replacement);
    await f.service.install();
    assert.equal(f.calls.includes('prepare'), false);
    assert.equal(f.calls.includes('install'), false);
  }
});

test('busy recording, failed verification and failed shutdown never install', async () => {
  const f = fixture({ prepare: async () => { throw Object.assign(new Error('Recording is active.'), { code: 'blocked' }); } });
  await f.service.download();
  await f.service.install();
  assert.equal(f.calls.includes('install'), false);
  assert.match(f.service.snapshot().message, /Recording/);
  const bad = fixture({ verify: async () => { throw new Error('deliberately corrupt fixture'); } });
  await bad.service.download();
  assert.equal(bad.service.snapshot().phase, 'error');
  assert.equal(bad.calls.includes('install'), false);
});

test('duplicate clicks share operation; late cancelled download cannot become ready', async () => {
  const gate = deferred();
  const started = deferred();
  let downloads = 0;
  const f = fixture({ createEngine: () => ({ download: async () => { downloads += 1; started.resolve(); await gate.promise; return 'fixture'; }, dispose() {} }) });
  const first = f.service.download();
  const second = f.service.download();
  assert.equal(first, second);
  await started.promise;
  f.service.cancel();
  gate.resolve();
  await first;
  assert.equal(downloads, 1);
  assert.notEqual(f.service.snapshot().phase, 'ready');
  assert.equal(f.calls.includes('install'), false);
});

test('Windows session ending during preparation prevents handoff', async () => {
  const gate = deferred();
  const f = fixture({ prepare: () => gate.promise });
  await f.service.download();
  const pending = f.service.install();
  await new Promise(r => setImmediate(r));
  f.service.sessionEnding();
  gate.resolve();
  await pending;
  assert.equal(f.calls.includes('handoff'), false);
});

test('unconfigured trust and unsupported launch modes do not perform updater work', async () => {
  for (const options of [{ trust: { enabled: true, keys: [] } }, { supported: false }]) {
    const f = fixture(options);
    await f.service.check(); await f.service.download(); await f.service.install();
    assert.equal(f.service.snapshot().supported, false);
    assert.deepEqual(f.calls, []);
  }
});


test('a ready installer corrupted before restart is discarded and can be downloaded again', async () => {
  let checks = 0;
  const f = fixture({ verify: async () => {
    if (++checks === 2) throw Object.assign(new Error('Corrupt cached update.'), { code: 'integrity' });
  } });
  await f.service.download();
  await f.service.install();
  assert.equal(f.service.snapshot().phase, 'error');
  assert(!f.calls.includes('prepare'));
  await f.service.download();
  assert.equal(f.service.snapshot().phase, 'ready');
  assert.equal(f.calls.filter(c => c === 'download').length, 2);
});


test('download responses require exact length and an unencoded full payload', () => {
  const { isAllowedDownloadResponse } = require('./update-engine');
  const response = { statusCode: 200, responseHeaders: { 'Content-Length': ['100'] } };
  assert.equal(isAllowedDownloadResponse(response, 100), true);
  assert.equal(isAllowedDownloadResponse(response, 99), false);
  assert.equal(isAllowedDownloadResponse({ statusCode: 200 }, 100), false);
  assert.equal(isAllowedDownloadResponse({ ...response, responseHeaders: { 'content-length': ['100'], 'content-encoding': ['gzip'] } }, 100), false);
  assert.equal(isAllowedDownloadResponse({ ...response, responseHeaders: { 'content-length': ['100'], 'transfer-encoding': ['chunked'] } }, 100), false);
  assert.equal(isAllowedDownloadResponse({ statusCode: 206 }, 100), false);
  assert.equal(isAllowedDownloadResponse({ statusCode: 302 }, 100), true);
});

test('a removed ready installer can be downloaded again without stopping the backend', async () => {
  const fs = require('node:fs/promises');
  const { verifyInstaller } = require('./update-manifest');
  const dir = await fs.mkdtemp(path.join(__dirname, '../.tmp/update-missing-'));
  const file = path.join(dir, 'update.exe');
  const bytes = Buffer.from('Inert installer fixture');
  let downloads = 0;
  const f = fixture({ verify: verifyInstaller, createEngine: () => ({
    download: async () => { downloads++; await fs.writeFile(file, bytes); return file; }, dispose() {},
  }) });
  Object.assign(f.release, { size: bytes.length, sha512: crypto.createHash('sha512').update(bytes).digest('base64') });
  try {
    await f.service.download();
    await fs.unlink(file); // Represents cache cleanup or antivirus quarantine between download and restart.
    await f.service.install();
    assert.equal(f.service.snapshot().phase, 'error');
    assert(!f.calls.includes('prepare'));
    await f.service.download();
    assert.equal(f.service.snapshot().phase, 'ready');
    assert.equal(downloads, 2);
  } finally { f.service.dispose(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('post-shutdown failure restores services before allowing retry', async () => {
  const recovery = deferred();
  const started = deferred();
  let running = true;
  let attempts = 0;
  const f = fixture({
    prepare: async () => { assert(running); running = false; },
    handoff: async () => { if (++attempts === 1) throw new Error('Installer spawn failed'); },
    recover: async () => { started.resolve(); await recovery.promise; running = true; return true; },
  });
  await f.service.download();
  const pending = f.service.install();
  // Settle without relying on a timeout when the recovery callback is missing.
  await Promise.race([started.promise, pending]);
  assert.equal(f.service.snapshot().phase, 'preparing');
  assert.equal(f.service.install(), pending, 'duplicate retry waits for recovery');
  recovery.resolve();
  await pending;
  assert(running);
  assert.equal(f.service.snapshot().phase, 'ready');
  await f.service.install();
  assert.equal(attempts, 2);
});

test('failed recovery asks for an app restart and session ending never restarts services', async () => {
  const f = fixture({ prepare: async () => { throw new Error('Voice cleanup failed'); }, recover: async () => false });
  await f.service.download();
  await f.service.install();
  assert.match(f.service.snapshot().message, /Restart FlightFabric/);
  let recovered = false;
  const gate = deferred();
  const ending = fixture({ prepare: () => gate.promise, recover: async () => { recovered = true; } });
  await ending.service.download();
  const pending = ending.service.install();
  await new Promise(r => setImmediate(r));
  ending.service.sessionEnding(); gate.resolve(); await pending;
  assert.equal(recovered, false);
});

test('failed handoff removes its receipt and a changed offer replaces the displayed notes', async () => {
  const fs = require('node:fs/promises');
  const dir = await fs.mkdtemp(path.join(__dirname, '../.tmp/update-receipt-'));
  const receiptPath = path.join(dir, 'pending.json');
  const f = fixture({ receiptPath, handoff: async () => { throw new Error('Launch denied'); } });
  try {
    await f.service.download();
    await f.service.install();
    await assert.rejects(fs.stat(receiptPath), { code: 'ENOENT' });
    f.offer({ ...f.release, version: '0.14.0', notes: 'Replacement release notes' });
    await f.service.install();
    assert.equal(f.service.snapshot().notes, 'Replacement release notes');
    assert.equal(f.service.snapshot().version, '0.14.0');
  } finally { f.service.dispose(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('desktop handoff awaits launch, restores voice IPC and restarts only its owned backend', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf('function initializeDesktopVoiceRuntime()');
  const end = source.indexOf('// Handle second instance', start);
  assert(start > 0 && end > start);
  const handlers = new Map();
  let updaterOptions;
  let voices = 0;
  let quits = 0;
  let starts = 0;
  const context = {
    app: { getPath: () => __dirname, getVersion: () => '0.12.1', isPackaged: true, quit: () => { quits++; } },
    path, fs: { existsSync: () => true, readFileSync: () => '{}' }, os: require('node:os'),
    process: { platform: 'win32', arch: 'x64', env: {}, execPath: path.join(__dirname, 'FlightFabric.exe') },
    __dirname, updateTrust: {}, createSignedFeed: () => ({}), createUpdateEngine() {},
    createUpdateService: (options) => { updaterOptions = options; return { start() {}, snapshot() {} }; },
    updateError: (code, message) => Object.assign(new Error(message), { code }),
    voiceRuntime: null, voiceIpcHandlers: new Set(),
    createVoiceRuntime: ({ registerTrustedIpcHandler }) => {
      voices++; registerTrustedIpcHandler('voice-test', () => {});
      return { initialize: async () => {}, shutdown: async () => {} };
    },
    registerTrustedIpcHandler: (channel, handler) => { assert(!handlers.has(channel), 'voice handler registered only once'); handlers.set(channel, handler); },
    ipcMain: { removeHandler: channel => handlers.delete(channel) }, debugLog() {},
    mainWindow: { on() {} }, mainWindowState: { save() {} }, sendToRenderer() {},
    settingsStore: { settingsFile: 'unused' }, desktopUpdater: null,
    updatePreparing: false, updateFinalQuit: false, isQuitting: false,
    applicationShutdownPromise: null, backendStartPromise: null, backendStopPromise: null,
    backendProcess: { alive: true }, isBackendProcessAlive: proc => proc.alive,
    prepareBackendForUpdate: async () => { context.backendProcess = null; },
    runBoundedShutdownTask: async (_label, fn) => { await fn(); return true; },
    startBackend: async () => { assert.equal(context.updatePreparing, false); starts++; context.backendProcess = { alive: true }; return true; },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  await context.initializeDesktopVoiceRuntime();
  context.initializeDesktopUpdater();
  const signal = new AbortController().signal;
  await updaterOptions.prepare(signal);
  assert.equal(handlers.size, 0);
  assert.equal(context.backendProcess, null);
  const launch = deferred();
  const handoff = updaterOptions.handoff(() => launch.promise, signal);
  await Promise.resolve();
  assert.equal(quits, 0, 'no quit before installer spawn');
  // Reject after the asynchronous boundary, as Windows process creation can do.
  launch.resolve(Promise.reject(new Error('Installer denied')));
  await assert.rejects(handoff, /Installer denied/);
  assert.equal(context.isQuitting, false);
  assert.equal(await updaterOptions.recover(), true);
  assert.equal(voices, 2);
  assert.equal(handlers.size, 1);
  assert.equal(starts, 1);
  updaterOptions.onState({ phase: 'ready' });
  assert.equal(context.updatePreparing, false);
  await updaterOptions.prepare(signal);
  await updaterOptions.handoff(async () => {}, signal);
  assert.equal(quits, 1);
  assert.equal(context.updateFinalQuit, true);
});

test('installer quarantine during cleanup restores services and requires a new download', async () => {
  const fs = require('node:fs/promises');
  const { verifyInstaller } = require('./update-manifest');
  const dir = await fs.mkdtemp(path.join(__dirname, '../.tmp/update-quarantine-'));
  const file = path.join(dir, 'update.exe');
  const bytes = Buffer.from('Inert cached update fixture');
  let restored = false;
  const f = fixture({ verify: verifyInstaller,
    createEngine: () => ({ download: async () => { await fs.writeFile(file, bytes); return file; }, dispose() {} }),
    prepare: async () => { await fs.unlink(file); },
    recover: async () => { restored = true; return true; },
  });
  Object.assign(f.release, { size: bytes.length, sha512: crypto.createHash('sha512').update(bytes).digest('base64') });
  try {
    await f.service.download(); await f.service.install();
    assert.equal(restored, true);
    assert.equal(f.service.snapshot().phase, 'error');
    assert(!f.calls.includes('handoff'));
    await f.service.download();
    assert.equal(f.service.snapshot().phase, 'ready');
  } finally { f.service.dispose(); await fs.rm(dir, { recursive: true, force: true }); }
});
