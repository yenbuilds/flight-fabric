'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { createPushToTalkHook } = require('./voice-push-to-talk-hook');
const { createControllerSetup } = require('./voice-controller-setup');
const { normalizeControllerBinding } = require('./voice-controller-button');
const { createVoiceRuntime } = require('./voice-runtime');

const binding = Object.freeze({ version: 1, devicePath: '\\\\?\\HID#TEST', reportId: 2, linkCollection: 3, button: 400, label: 'Test controller' });
const event = (type, overrides = {}) => ({ type, path: binding.devicePath, reportId: 2, linkCollection: 3, button: 400, ...overrides });
function fixture(t) {
  const base = path.resolve(__dirname, '../.tmp'); fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'controller-test-'));
  const helperPath = path.join(directory, 'helper.exe'); fs.writeFileSync(helperPath, 'fixture');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, helperPath };
}
function child() {
  const result = new EventEmitter(); result.stdout = new EventEmitter(); result.stderr = new EventEmitter();
  result.kills = 0; result.kill = () => { result.kills++; return true; };
  result.say = (...events) => result.stdout.emit('data', Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n'));
  return result;
}

async function runtimeFixture(t, enabled = true) {
  const { directory, helperPath } = fixture(t);
  const settingsPath = path.join(directory, 'voice-control.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ voiceRecognitionEnabled: enabled,
    pushToTalkShortcut: 'Control+F1', controllerBindingV1: binding }));
  const handlers = new Map(), sent = [], children = [];
  const startup = { automaticReady: true };
  let engineReady = false, activeSessionId = null;
  const speech = { initialize: async () => { engineReady = true; },
    shutdown: async () => { engineReady = false; activeSessionId = null; }, onEvent() {},
    getInfo: () => ({ ready: engineReady, activeSessionId }),
    start: () => ({ sessionId: activeSessionId = 'test-session' }),
    cancel: () => { activeSessionId = null; return true; } };
  const runtime = createVoiceRuntime({ app: { isPackaged: false, getPath: () => directory },
    appDir: directory, ipcMain: new EventEmitter(), speechEngine: speech,
    readbackEngine: { getInfo: () => ({}), cancel() {} },
    getMainWindow: () => ({ isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (channel, data) => sent.push({ channel, data }) } }),
    registerTrustedIpcHandler: (name, fn) => handlers.set(name, fn),
    pushToTalkHookFactory: options => createPushToTalkHook({ ...options, helperPath,
      spawnProcess: () => {
        const process = child(); children.push(process);
        if (startup.automaticReady) queueMicrotask(() => process.say({ type: 'ready' }));
        return process;
      } }) });
  t.after(async () => {
    await runtime.shutdown();
  });
  await runtime.initialize();
  return { runtime, handlers, children, sent, settingsPath, startup,
    invoke: (name, value) => handlers.get(`voice:${name}`)({}, value) };
}

test('failed shortcut save restores the running keyboard and controller binding', { skip: process.platform !== 'win32' }, async t => {
  const h = await runtimeFixture(t);
  const saved = fs.readFileSync(h.settingsPath, 'utf8');
  fs.mkdirSync(`${h.settingsPath}.tmp`);
  await assert.rejects(h.invoke('set-push-to-talk-shortcut', 'Control+F2'));
  assert.equal(h.runtime.runtimeInfo().pushToTalk.accelerator, 'Control+F1');
  assert.equal(fs.readFileSync(h.settingsPath, 'utf8'), saved);
  h.children.at(-1).say(event('press'), event('release'));
  assert.deepEqual(h.sent.filter(e => e.channel === 'voice:push-to-talk').slice(-2).map(e => e.data.type), ['down', 'up']);
  fs.rmdirSync(`${h.settingsPath}.tmp`);
  await h.invoke('set-push-to-talk-shortcut', 'Control+F2');
  assert.equal(JSON.parse(fs.readFileSync(h.settingsPath, 'utf8')).pushToTalkShortcut, 'Control+F2');
});

test('failed enable save cannot grant microphone authority or start a helper', { skip: process.platform !== 'win32' }, async t => {
  const h = await runtimeFixture(t, false);
  fs.mkdirSync(`${h.settingsPath}.tmp`);
  await assert.rejects(async () => h.invoke('set-recognition-enabled', true));
  assert.equal(h.runtime.runtimeInfo().enabled, false);
  assert.throws(() => h.handlers.get('voice:speech-start')({ sender: { id: 7 } }), /disabled/);
  assert.equal(h.children.length, 0);
  fs.rmdirSync(`${h.settingsPath}.tmp`);
  await h.invoke('set-recognition-enabled', true);
  assert.equal(h.runtime.runtimeInfo().pushToTalk.registered, true);
});

test('failed disable save still revokes capture, shuts down and publishes disabled state', { skip: process.platform !== 'win32' }, async t => {
  const h = await runtimeFixture(t);
  const sender = { id: 7 };
  h.handlers.get('voice:speech-start')({ sender });
  assert.equal(h.runtime.isAudioCaptureAuthorized(sender), true);
  fs.mkdirSync(`${h.settingsPath}.tmp`);
  await assert.rejects(async () => h.invoke('set-recognition-enabled', false));
  assert.equal(h.runtime.isAudioCaptureAuthorized(sender), false);
  assert.equal(h.runtime.runtimeInfo().enabled, false);
  assert.equal(h.runtime.runtimeInfo().engine.ready, false);
  assert.ok(h.children.every(process => process.kills));
  assert.equal(h.sent.filter(e => e.channel === 'voice:runtime-state').at(-1).data.enabled, false);
  fs.rmdirSync(`${h.settingsPath}.tmp`);
  await h.invoke('set-recognition-enabled', false);
  assert.equal(JSON.parse(fs.readFileSync(h.settingsPath, 'utf8')).voiceRecognitionEnabled, false);
  await h.invoke('set-recognition-enabled', true);
  assert.equal(h.runtime.runtimeInfo().pushToTalk.registered, true);
});

test('disabling during binding rollback cannot restart input or replace the saved shortcut', { skip: process.platform !== 'win32' }, async t => {
  const h = await runtimeFixture(t);
  fs.mkdirSync(`${h.settingsPath}.tmp`);
  h.startup.automaticReady = false;
  const changing = assert.rejects(h.invoke('set-push-to-talk-shortcut', 'Control+F2'), /EISDIR|EPERM|EACCES/);
  await new Promise(resolve => setImmediate(resolve));
  h.children[1].say({ type: 'ready' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.children.length, 3, 'write failure started the old binding again');
  fs.rmdirSync(`${h.settingsPath}.tmp`);
  await h.invoke('set-recognition-enabled', false);
  await changing;
  assert.equal(h.runtime.runtimeInfo().pushToTalk.registered, false);
  assert.equal(h.runtime.runtimeInfo().engine.ready, false);
  assert.ok(h.children.every(process => process.kills));
  assert.equal(JSON.parse(fs.readFileSync(h.settingsPath, 'utf8')).pushToTalkShortcut, 'Control+F1');
  h.startup.automaticReady = true;
  await h.invoke('set-recognition-enabled', true);
  assert.equal(h.runtime.runtimeInfo().pushToTalk.accelerator, 'Control+F1');
  assert.equal(h.runtime.runtimeInfo().pushToTalk.registered, true);
});

test('disable during pending keyboard or controller changes persists only the committed binding', { skip: process.platform !== 'win32' }, async t => {
  const h = await runtimeFixture(t);
  for (const [action, value] of [['set-push-to-talk-shortcut', 'Control+F2'], ['controller-binding-clear', undefined]]) {
    h.startup.automaticReady = false;
    const changing = assert.rejects(h.invoke(action, value), /disposed/);
    await new Promise(resolve => setImmediate(resolve));
    await h.invoke('set-recognition-enabled', false);
    await changing;
    const saved = JSON.parse(fs.readFileSync(h.settingsPath, 'utf8'));
    assert.equal(saved.pushToTalkShortcut, 'Control+F1');
    assert.equal(saved.voiceRecognitionEnabled, false);
    assert.deepEqual(saved.controllerBindingV1, binding);
    assert.equal(h.runtime.runtimeInfo().pushToTalk.accelerator, 'Control+F1');
    assert.ok(h.children.every(process => process.kills));
    h.startup.automaticReady = true;
    await h.invoke('set-recognition-enabled', true);
  }
});

test('invalid event fields fail closed without escaping into the main process', async t => {
  const { helperPath } = fixture(t);
  for (const invalid of [event('baseline', { path: 42, heldButtons: 1 }),
    event('cancel', { path: 42, reason: 'device-removed' }), event('release', { button: '400' }),
    event('device', { connected: 'false' }), event('baseline', { heldButtons: -1 }),
    event('device', { connected: true, name: 42 }), event('device', { connected: true, name: 'x'.repeat(201) }),
    { type: 'unexpected-transition' }]) {
    const process = child(), errors = [];
    const hook = createPushToTalkHook({ helperPath, controllerEnabled: true, spawnProcess: () => process,
      onDown() {}, onUp: () => assert.fail('invalid input must not release capture'), onError: e => errors.push(e) });
    t.after(() => hook.dispose());
    const ready = hook.setBinding({ controller: binding }); process.say({ type: 'ready' }); await ready;
    process.say(event('press'));
    assert.doesNotThrow(() => process.say(invalid), JSON.stringify(invalid));
    assert.equal(hook.getInfo().registered, false, JSON.stringify(invalid));
    assert.equal(errors.length, 1); assert.ok(process.kills);
  }
});

test('setup rejects malformed discovery and startup events without keeping a saveable candidate', async t => {
  const { helperPath } = fixture(t);
  for (const beforeReady of [true, false]) {
    const process = child();
    const setup = createControllerSetup({ helperPath, spawnProcess: () => process });
    t.after(() => setup.stop());
    const started = setup.start();
    if (beforeReady) process.say(event('device', { connected: true, vendorId: 1234 }));
    else {
      process.say(event('device', { connected: true }), { type: 'ready' }); await started;
      process.say(event('press'), event('release'));
      assert.equal(setup.bindingToSave().button, binding.button);
      assert.doesNotThrow(() => process.say(event('cancel', { path: {}, reason: 'device-removed' })));
    }
    await started;
    assert.equal(setup.getInfo().phase, 'error');
    assert.throws(() => setup.bindingToSave()); assert.ok(process.kills);
  }
});

test('all keyboard/controller hold orderings retain release ownership through reconnect and rebind', async t => {
  const { helperPath } = fixture(t);
  const orders = [
    ['down', 'up', 'press', 'release'], ['press', 'release', 'down', 'up'],
    ['down', 'press', 'up', 'release'], ['down', 'press', 'release', 'up'],
    ['press', 'down', 'up', 'release'], ['press', 'down', 'release', 'up'],
  ];
  for (const order of orders) {
    const children = [], delivered = [];
    const hook = createPushToTalkHook({ helperPath, controllerEnabled: true,
      spawnProcess: () => { const process = child(); children.push(process); return process; },
      onDown: () => delivered.push('down'), onUp: () => delivered.push('up'),
      onCancel: () => delivered.push('cancel') });
    t.after(() => hook.dispose());
    const started = hook.setBinding({ accelerator: 'Control+F1', controller: binding });
    const process = children[0];
    process.say(event('device', { connected: true }), { type: 'ready' }, event('baseline', { heldButtons: 0 }));
    await started;
    for (const type of order) {
      const value = ['down', 'up'].includes(type) ? { type } : event(type);
      process.say(value, value); // Duplicate transitions never add a capture or release.
    }
    const serial = order[1] === 'up' || order[1] === 'release';
    assert.deepEqual(delivered, serial ? ['down', 'up', 'down', 'up'] : ['down', 'up'], order.join(','));
    delivered.length = 0;
    process.say({ type: 'down' }, event('press'), event('cancel', { reason: 'device-removed' }),
      event('device', { connected: false }), event('device', { connected: true }),
      event('baseline', { heldButtons: 1 }), { type: 'up' });
    assert.deepEqual(delivered, ['down', 'cancel'], 'unplug never completes an overlapping capture');
    process.say(event('press'), event('release'));
    assert.deepEqual(delivered.slice(-2), ['down', 'up'], 'a new hold works after reconnect');
    process.say(event('press'));
    const replacement = hook.setBinding({ accelerator: 'Control+F2', controller: { ...binding, button: 401 } });
    children[1].say({ type: 'ready' }); await replacement;
    assert.equal(delivered.at(-1), 'cancel');
    const length = delivered.length;
    process.say(event('release'), { type: 'up' });
    assert.equal(delivered.length, length, 'the retired helper cannot finish the new binding');
    children[1].say(event('press', { button: 401 }), event('release', { button: 401 }));
    assert.deepEqual(delivered.slice(-2), ['down', 'up']);
    hook.dispose(); children[1].say({ type: 'down' });
    assert.equal(hook.getInfo().registered, false);
    assert.equal(delivered.at(-1), 'up');
  }
});

test('voice runtime loads using only JavaScript files declared in the packaged app', t => {
  const { directory } = fixture(t);
  const packaged = path.join(directory, 'packaged-app'); fs.mkdirSync(packaged);
  const included = require('./package.json').build.files.filter(name => name.endsWith('.js') && !name.includes('*'));
  for (const name of included) fs.copyFileSync(path.join(__dirname, name), path.join(packaged, name));
  const packagedRequire = createRequire(path.join(packaged, 'package.json'));
  assert.equal(typeof packagedRequire('./voice-runtime').createVoiceRuntime, 'function');
});

test('helper promotion retains one-chunk startup events and serializes overlapping sources', async t => {
  const { helperPath } = fixture(t); const process = child(); const delivered = [];
  const hook = createPushToTalkHook({ helperPath, controllerEnabled: true, spawnProcess: () => process,
    onDown: () => delivered.push('down'), onUp: () => delivered.push('up'), onCancel: () => delivered.push('cancel') });
  t.after(() => hook.dispose());
  const ready = hook.setBinding({ accelerator: 'Control+Alt+Space', controller: binding });
  process.say(event('device', { connected: true }), { type: 'ready' }, { type: 'down' }, event('press'));
  assert.equal((await ready).controller.state, 'ready');
  assert.deepEqual(delivered, ['down']);
  process.say({ type: 'up' }); assert.deepEqual(delivered, ['down']);
  process.say(event('release')); assert.deepEqual(delivered, ['down', 'up']);
  process.say(event('press'), { type: 'down' }, event('cancel', { reason: 'device-removed' }));
  assert.equal(delivered.at(-1), 'cancel');
  const count = delivered.length;
  process.say({ type: 'down' }, { type: 'up' }); assert.equal(delivered.length, count, 'cancelled overlap requires release before new capture');
  process.say(event('press', { path: 'another-device' })); assert.equal(delivered.length, count);
  process.say(event('press'), event('release')); assert.deepEqual(delivered.slice(-2), ['down', 'up']);
});

test('exit immediately after ready cannot register a dead helper', async t => {
  const { helperPath } = fixture(t); const process = child();
  const hook = createPushToTalkHook({ helperPath, spawnProcess: () => process, onDown() {}, onUp() {} });
  t.after(() => hook.dispose());
  const ready = hook.setBinding({ accelerator: 'Control+Alt+Space' });
  process.say({ type: 'ready' }); process.emit('exit', 1);
  await assert.rejects(ready, /stopped/); assert.equal(hook.getInfo().registered, false);
});

test('out-of-order binding launches cannot replace the newest binding', async t => {
  const { helperPath } = fixture(t); const children = [];
  const hook = createPushToTalkHook({ helperPath, spawnProcess: () => { const c = child(); children.push(c); return c; }, onDown() {}, onUp() {} });
  t.after(() => hook.dispose());
  const first = hook.setBinding({ accelerator: 'Control+F1' });
  const second = hook.setBinding({ accelerator: 'Control+F2' });
  children[1].say({ type: 'ready' }); await second;
  children[0].say({ type: 'ready' }); await assert.rejects(first, /superseded/);
  assert.equal(hook.getInfo().accelerator, 'Control+F2');
  const pending = hook.setBinding({ accelerator: 'Control+F3' });
  await hook.setBinding({ accelerator: 'Control+F2' });
  children[2].say({ type: 'ready' }); await assert.rejects(pending, /superseded/);
  assert.equal(hook.getInfo().accelerator, 'Control+F2', 'reaffirming the current binding supersedes pending changes');
});

test('malformed helper output cancels its authority instead of dropping a release', async t => {
  const { helperPath } = fixture(t); const process = child(); const errors = [];
  const hook = createPushToTalkHook({ helperPath, spawnProcess: () => process, onDown() {}, onUp() {}, onError: e => errors.push(e) });
  t.after(() => hook.dispose());
  const ready = hook.setBinding({ accelerator: 'Control+F1' }); process.say({ type: 'ready' }); await ready;
  process.stdout.emit('data', Buffer.from('{bad\n'));
  assert.equal(errors.length, 1); assert.equal(hook.getInfo().registered, false); assert.ok(process.kills);
});

for (const [stream, signal] of [['stdout', 'error'], ['stdout', 'end'], ['stdout', 'close'], ['stderr', 'error']]) {
  test(`helper ${stream} ${signal} stops the held input without an uncaught stream error`, async t => {
    const { helperPath } = fixture(t); const process = child(); const errors = [];
    const hook = createPushToTalkHook({ helperPath, spawnProcess: () => process,
      onDown() {}, onUp() {}, onError: error => errors.push(error) });
    t.after(() => hook.dispose());
    const ready = hook.setBinding({ accelerator: 'Control+F1' });
    process.say({ type: 'ready' }); await ready; process.say({ type: 'down' });
    assert.doesNotThrow(() => process[stream].emit(signal, new Error('Pipe failed')));
    assert.equal(hook.getInfo().registered, false);
    assert.equal(errors.length, 1); assert.ok(process.kills);
    process.emit('exit', 1);
    assert.equal(errors.length, 1, 'one pipe failure has one cancellation path');
  });
}

test('output closure before readiness rejects and stops the candidate immediately', async t => {
  const { helperPath } = fixture(t); const process = child();
  const hook = createPushToTalkHook({ helperPath, spawnProcess: () => process, onDown() {}, onUp() {} });
  t.after(() => hook.dispose());
  const ready = hook.setBinding({ accelerator: 'Control+F1' });
  process.stdout.emit('end');
  await assert.rejects(ready, /output closed/);
  assert.equal(hook.getInfo().registered, false); assert.ok(process.kills);
});

test('setup deadline retains a released candidate after normal output closure', async t => {
  const { helperPath } = fixture(t); const process = child();
  const setup = createControllerSetup({ helperPath, spawnProcess: () => process });
  t.after(() => setup.stop());
  const ready = setup.start();
  process.say(event('device', { connected: true }), { type: 'ready' }); await ready;
  process.say(event('press'), event('release'), { type: 'cancel', reason: 'timeout' }, { type: 'stopped', reason: 'timeout' });
  process.stdout.emit('end'); process.emit('exit', 0);
  assert.equal(setup.getInfo().phase, 'ready');
  assert.equal(setup.bindingToSave().button, binding.button);
  assert.ok(process.kills);
});

test('button setup requires a fresh complete hold, exposes no path, and ends monitoring on cancel', async t => {
  const { helperPath } = fixture(t); const process = child(); let args;
  const setup = createControllerSetup({ helperPath, spawnProcess: (_file, values) => { args = values; return process; } });
  t.after(() => setup.stop());
  const ready = setup.start();
  process.say(event('device', { connected: true, vendorId: '044F', productId: 'B10A' }), { type: 'ready' }, event('baseline', { heldButtons: 1 }));
  await ready; assert.deepEqual(args, ['--controller-setup', '--seconds', '30']);
  assert.throws(() => setup.bindingToSave());
  process.say(event('press')); assert.equal(setup.getInfo().held, true); assert.throws(() => setup.bindingToSave());
  process.say(event('release', { linkCollection: 4 })); assert.throws(() => setup.bindingToSave());
  process.say(event('release')); assert.equal(setup.bindingToSave().button, 400);
  assert.equal(JSON.stringify(setup.getInfo()).includes('HID#'), false);
  setup.stop(); assert.ok(process.kills); assert.equal(setup.getInfo().phase, 'idle');
});

test('button setup saves friendly Windows names and falls back when names are missing', async t => {
  const { helperPath } = fixture(t);
  for (const [name, label] of [['T.16000M', 'T.16000M'], ['  Flight   Yoke  ', 'Flight Yoke'], ['', 'Controller 044F:B10A'], [undefined, 'Controller 044F:B10A']]) {
    const process = child();
    const setup = createControllerSetup({ helperPath, spawnProcess: () => process });
    t.after(() => setup.stop());
    const started = setup.start();
    process.say(event('device', { connected: true, vendorId: '044F', productId: 'B10A', name }), { type: 'ready' });
    await started;
    process.say(event('press'), event('release'));
    assert.equal(setup.getInfo().selection.label, label);
    assert.deepEqual(setup.bindingToSave(), { ...binding, label });
    assert.equal(JSON.stringify(setup.getInfo()).includes(binding.devicePath), false);
  }
});

test('friendly names update saved-binding display without changing exact device selection', async t => {
  const { helperPath } = fixture(t); const process = child(); const delivered = [];
  const hook = createPushToTalkHook({ helperPath, controllerEnabled: true, spawnProcess: () => process,
    onDown: () => delivered.push('down'), onUp: () => delivered.push('up') });
  t.after(() => hook.dispose());
  const ready = hook.setBinding({ controller: binding });
  process.say(event('device', { connected: true, name: 'T.16000M' }), { type: 'ready' }); await ready;
  assert.equal(hook.getInfo().controller.binding.label, 'T.16000M');
  process.say(event('device', { path: 'another-controller', connected: true, name: 'Other yoke' }),
    event('press', { path: 'another-controller' }));
  assert.equal(hook.getInfo().controller.binding.label, 'T.16000M');
  assert.deepEqual(delivered, []);
  process.say(event('press'), event('release'));
  assert.deepEqual(delivered, ['down', 'up']);
  process.say(event('device', { connected: false }));
  assert.equal(hook.getInfo().controller.binding.label, 'T.16000M', 'loss keeps the last known display name');
});

test('invalid, ambiguous legacy and out-of-range identities cannot become bindings', () => {
  for (const value of [{ vendorId: '044F', productId: 'B10A', button: 1 }, { ...binding, reportId: 256 }, { ...binding, devicePath: 'bad\npath' }, { ...binding, button: 0 }]) {
    assert.throws(() => normalizeControllerBinding(value));
  }
});

test('a stalled continuous helper is stopped and reported before it can hold capture indefinitely', async t => {
  const { helperPath } = fixture(t); const process = child(); let time = 0; const errors = [];
  t.mock.timers.enable({ apis: ['setInterval'] });
  const hook = createPushToTalkHook({ helperPath, controllerEnabled: true, spawnProcess: () => process,
    now: () => time, onDown() {}, onUp() {}, onError: e => errors.push(e) });
  t.after(() => hook.dispose());
  const ready = hook.setBinding({ accelerator: '', controller: binding }); process.say({ type: 'ready' }); await ready;
  time = 6000; t.mock.timers.tick(1000);
  assert.equal(errors.length, 1); assert.match(errors[0].message, /responding/);
  assert.ok(process.kills); assert.equal(hook.getInfo().registered, false);
});

test('suspend cancels both sources and resumption requires fresh input', async t => {
  const { helperPath } = fixture(t); const process = child(); const events = []; let time = 0;
  t.mock.timers.enable({ apis: ['setInterval'] });
  const hook = createPushToTalkHook({ helperPath, controllerEnabled: true, spawnProcess: () => process,
    now: () => time, onError: () => events.push('error'),
    onDown: () => events.push('down'), onUp: () => events.push('up'), onCancel: () => events.push('cancel') });
  t.after(() => hook.dispose());
  const ready = hook.setBinding({ accelerator: 'Control+F1', controller: binding }); process.say({ type: 'ready' }); await ready;
  process.say({ type: 'down' }, event('press'), { type: 'cancel', reason: 'suspend' }, { type: 'paused' });
  assert.deepEqual(events, ['down', 'cancel']); assert.equal(hook.getInfo().registered, false);
  time = 60000; t.mock.timers.tick(1000); assert.equal(process.kills, 0, 'a known suspend does not count as helper failure');
  process.say({ type: 'resumed' }, event('baseline', { heldButtons: 1 }));
  t.mock.timers.tick(1000); assert.equal(process.kills, 0, 'resume resets the heartbeat deadline');
  assert.equal(hook.getInfo().controller.state, 'release-required'); assert.deepEqual(events, ['down', 'cancel']);
  process.say(event('press'), event('release')); assert.deepEqual(events.slice(-2), ['down', 'up']);
});

for (const isPackaged of [false, true]) {
test(`${isPackaged ? 'packaged' : 'normal development'} runtime supports controller setup, persistence and cancellation without opt-in`, { skip: process.platform !== 'win32' }, async t => {
  const { directory } = fixture(t); const previousEnv = process.env.FF_CONTROLLER_PTT; delete process.env.FF_CONTROLLER_PTT;
  t.after(() => { if (previousEnv === undefined) delete process.env.FF_CONTROLLER_PTT; else process.env.FF_CONTROLLER_PTT = previousEnv; });
  fs.writeFileSync(path.join(directory, 'voice-control.json'), JSON.stringify({ voiceRecognitionEnabled: true, pushToTalkJoystick: { button: 1 } }));
  const handlers = new Map(); const sent = []; let hookOptions, activeSessionId = null, cancellations = 0, binds = [];
  const speech = { initialize: async () => {}, shutdown: async () => {}, onEvent() {}, getInfo: () => ({ ready: true, activeSessionId }),
    start: () => ({ sessionId: activeSessionId = 'test-session' }), cancel: () => { cancellations++; activeSessionId = null; return true; } };
  let setupInfo = { phase: 'idle' }; let setupStarts = 0; let selectedBinding = binding;
  const dependencies = { app: { isPackaged, getPath: () => directory }, appDir: directory, resourcesPath: directory, ipcMain: new EventEmitter(), speechEngine: speech,
    readbackEngine: { getInfo: () => ({}), cancel() {} }, getMainWindow: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, data) => sent.push({ channel, data }) } }),
    registerTrustedIpcHandler: (name, fn) => handlers.set(name, fn),
    pushToTalkHookFactory: options => { hookOptions = options; return { setBinding: async value => { binds.push(value); return { accelerator: value.accelerator, registered: true }; }, getInfo: () => ({ registered: true }), dispose() {} }; },
    controllerSetupFactory: () => ({ start: async () => { setupStarts++; setupInfo = { phase: 'ready' }; }, stop: () => { setupInfo = { phase: 'idle' }; }, getInfo: () => setupInfo, bindingToSave: () => selectedBinding }) };
  const runtime = createVoiceRuntime(dependencies); t.after(() => runtime.shutdown()); await runtime.initialize();
  assert.equal(runtime.runtimeInfo().pushToTalk.controllerEnabled, true);
  assert.equal(runtime.runtimeInfo().development, !isPackaged, 'packaged aircraft-readiness safeguards remain in force');
  const sender = new EventEmitter(); sender.id = 7;
  const queuedSetup = handlers.get('voice:controller-setup-start')({ sender });
  const cancelledSetup = handlers.get('voice:controller-setup-cancel')();
  await Promise.all([queuedSetup, cancelledSetup]);
  assert.equal(setupStarts, 0, 'navigation/cancel before queued setup starts must not launch monitoring');
  for (const departure of ['destroyed', 'did-start-navigation']) {
    const pending = handlers.get('voice:controller-setup-start')({ sender });
    sender.emit(departure);
    await pending;
    assert.equal(setupStarts, 0, `${departure} before queued setup starts must not launch monitoring`);
    assert.equal(sender.listenerCount('destroyed'), 0);
    assert.equal(sender.listenerCount('did-start-navigation'), 0);
  }
  handlers.get('voice:speech-start')({ sender });
  await handlers.get('voice:controller-setup-start')({ sender });
  assert.ok(cancellations); assert.throws(() => handlers.get('voice:speech-start')({ sender }), /paused/);
  await handlers.get('voice:controller-setup-save')();
  assert.equal(sender.listenerCount('destroyed'), 0);
  assert.equal(sender.listenerCount('did-start-navigation'), 0);
  assert.deepEqual(binds.at(-1).controller, binding);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'voice-control.json'), 'utf8'));
  assert.deepEqual(saved.controllerBindingV1, binding); assert.deepEqual(saved.pushToTalkJoystick, { button: 1 });
  handlers.get('voice:speech-start')({ sender }); hookOptions.onCancel('device-removed');
  assert.equal(activeSessionId, null); assert.ok(sent.some(e => e.channel === 'voice:push-to-talk' && e.data.type === 'cancel'));
  selectedBinding = { ...binding, button: 401 };
  await handlers.get('voice:controller-setup-start')({ sender });
  const temporary = path.join(directory, 'voice-control.json.tmp');
  fs.mkdirSync(temporary); // Force a settings write failure without touching the saved binding.
  await assert.rejects(handlers.get('voice:controller-setup-save')());
  assert.deepEqual(binds.slice(-2).map(value => value.controller), [selectedBinding, binding]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'voice-control.json'), 'utf8')), saved);
  fs.rmdirSync(temporary);
  hookOptions.onError(new Error('Previous helper failed'));
  await handlers.get('voice:controller-setup-start')({ sender });
  await handlers.get('voice:controller-setup-save')();
  assert.equal(runtime.runtimeInfo().pushToTalk.error, '', 'successful recovery clears the old helper error');
});
}

test('normal packaged installs expose button settings without enabling voice or starting helpers', { skip: process.platform !== 'win32' }, async t => {
  const { directory } = fixture(t); const handlers = new Map();
  const runtime = createVoiceRuntime({ app: { isPackaged: true, getPath: () => directory }, appDir: directory,
    ipcMain: new EventEmitter(), getMainWindow: () => null,
    registerTrustedIpcHandler: (name, handler) => handlers.set(name, handler),
    speechEngine: { getInfo: () => ({ ready: false }), shutdown: async () => {}, onEvent() {},
      initialize: () => assert.fail('disabled voice must not initialize speech') },
    readbackEngine: { getInfo: () => ({}), cancel() {} },
    pushToTalkHookFactory: () => assert.fail('disabled voice must not monitor buttons'),
    controllerSetupFactory: () => assert.fail('setup must be explicitly started'),
  });
  t.after(() => runtime.shutdown());
  await runtime.initialize();
  assert.equal(runtime.runtimeInfo().enabled, false);
  assert.equal(runtime.runtimeInfo().development, false);
  assert.equal(runtime.runtimeInfo().pushToTalk.controllerEnabled, true);
  assert.equal(runtime.runtimeInfo().pushToTalk.controller.state, 'unbound');
  assert.throws(() => handlers.get('voice:controller-setup-start')({ sender: { id: 7 } }), /enable|disabled/i);
});
