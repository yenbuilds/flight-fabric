'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { safeModelFilePath, sha256File, verifyVoiceHotwords } = require('./voice-model-integrity');
const { VOICE_HOTWORDS, ZIPFORMER_MODEL } = require('./voice-model-manifest');
const {
  DEFAULT_PUSH_TO_TALK_SHORTCUT,
  normalizePushToTalkJoystick,
  normalizePushToTalkShortcut,
  pushToTalkHelperArguments,
} = require('./voice-push-to-talk');
const {
  createPushToTalkHelperSpawnOptions,
  createPushToTalkHook,
  resolvePushToTalkHelperPath,
  startJoystickLearnSession,
} = require('./voice-push-to-talk-hook');
const { AUDIO_CHANNEL, createVoiceRuntime } = require('./voice-runtime');
const {
  createVoiceSpeechEngine,
  resolveVoiceHotwordsPath,
  resolveVoiceModelDir,
} = require('./voice-speech-engine');

test('voice manifest pins the streaming Zipformer runtime subset', () => {
  assert.equal(ZIPFORMER_MODEL.engineVersion, '1.13.5');
  assert.equal(ZIPFORMER_MODEL.sampleRate, 16000);
  assert.equal(ZIPFORMER_MODEL.files.length, 5);
  assert.ok(ZIPFORMER_MODEL.files.every((file) => file.bytes > 0 && /^[A-F0-9]{64}$/.test(file.sha256)));
  assert.match(ZIPFORMER_MODEL.upstream.revision, /^[a-f0-9]{40}$/);
  assert.match(ZIPFORMER_MODEL.upstream.resolveUrl, new RegExp(ZIPFORMER_MODEL.upstream.revision));
  const pinnedFiles = new Set(ZIPFORMER_MODEL.files.map((file) => file.name));
  assert.equal(pinnedFiles.has('hotwords.txt'), false);
  assert.deepEqual(ZIPFORMER_MODEL.obsoleteFiles, ['hotwords.txt']);
  assert.deepEqual(
    Object.values(ZIPFORMER_MODEL.components).filter((filename) => !pinnedFiles.has(filename)),
    [],
  );
  assert.ok(VOICE_HOTWORDS.bytes > 0);
  assert.match(VOICE_HOTWORDS.sha256, /^[A-F0-9]{64}$/);
});

test('voice model paths remain beneath the configured resource directory', () => {
  const root = path.resolve('C:\\voice-model');
  assert.equal(safeModelFilePath(root, 'tokens.txt'), path.join(root, 'tokens.txt'));
  assert.throws(() => safeModelFilePath(root, '..\\tokens.txt'));
  assert.equal(
    resolveVoiceModelDir({ appDir: path.resolve('C:\\app'), isPackaged: true, resourcesPath: path.resolve('C:\\resources') }),
    path.join(path.resolve('C:\\resources'), 'models', ZIPFORMER_MODEL.id),
  );
  assert.equal(
    resolveVoiceHotwordsPath({ appDir: path.resolve('C:\\app'), isPackaged: true, resourcesPath: path.resolve('C:\\resources') }),
    path.join(path.resolve('C:\\resources'), 'voice', 'hotwords.txt'),
  );
});

test('tracked aviation hotwords pass integrity verification', async () => {
  const filename = path.resolve(__dirname, 'resources', 'voice', 'hotwords.txt');
  assert.deepEqual(await verifyVoiceHotwords(filename), { bytes: VOICE_HOTWORDS.bytes, verified: true });
  const hotwords = fs.readFileSync(filename, 'utf8');
  for (const digit of ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE']) {
    assert.match(hotwords, new RegExp(`^${digit} :`, 'm'));
  }
  for (const phrase of ['START A P U', 'START THE A P U', 'A P U START', 'START A P YOU',
    'Q N H', 'H P A', 'L S', 'N D', 'V H F', 'S T D', 'CAPTAIN L S', 'CAPTAIN Q N H',
    'SET NAV RADIOS', 'SET BOTH NAV RADIOS', 'TUNE NAV RADIOS', 'NAV RADIOS',
    'DECIMAL', 'POINT', 'NINER']) {
    assert.ok(hotwords.split('\n').some(line => line.startsWith(`${phrase} :`)), phrase);
  }
});

test('tracked BPE vocabulary matches the voice model manifest', async () => {
  const expected = ZIPFORMER_MODEL.files.find((file) => file.name === ZIPFORMER_MODEL.components.bpeVocab);
  const filename = path.resolve(__dirname, 'resources', 'voice', 'bpe.vocab');
  assert.equal(expected.source, 'bundled');
  assert.equal(fs.statSync(filename).size, expected.bytes);
  assert.equal(await sha256File(filename), expected.sha256);
});

test('literal aircraft command hints stay represented in the Zipformer hotwords', () => {
  const catalogueSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'backend', 'aircraft', 'aircraft-command-catalogue.ts'),
    'utf8',
  );
  const hotwordPhrases = new Set(
    fs.readFileSync(path.resolve(__dirname, 'resources', 'voice', 'hotwords.txt'), 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.split(':', 1)[0].trim())
      .filter(Boolean),
  );
  const literalHints = [...catalogueSource.matchAll(/hints:\s*\[([^\]]*)\]/gu)]
    .flatMap((match) => [...match[1].matchAll(/['"]([^'"]+)['"]/gu)].map((hint) => hint[1]));
  const missing = [...new Set(literalHints)].filter((hint) => !hotwordPhrases.has(hint));

  assert.deepEqual(missing, [], `Missing Zipformer hotwords for catalogue hints: ${missing.join(', ')}`);
});

test('generated PMDG 777 command hints stay represented in the Zipformer hotwords', () => {
  const hotwordPhrases = new Set(
    fs.readFileSync(path.resolve(__dirname, 'resources', 'voice', 'hotwords.txt'), 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.split(':', 1)[0].trim())
      .filter(Boolean),
  );
  const required = [
    'FLIGHT PATH ANGLE', 'F P A', 'AUTOPILOT LEFT', 'AUTOPILOT RIGHT',
    'AUTO PILOT LEFT', 'AUTO PILOT RIGHT', 'LEFT FLIGHT DIRECTOR',
    'RIGHT FLIGHT DIRECTOR', 'CAPTAIN FLIGHT DIRECTOR',
    'FIRST OFFICER FLIGHT DIRECTOR', 'LEFT AUTOTHROTTLE ARM',
    'RIGHT AUTOTHROTTLE ARM', 'L NAV', 'L N A B', 'V NAV', 'HEADING REFERENCE',
    'H D G', 'T R K', 'VERTICAL REFERENCE', 'V S', 'AUTOBRAKE', 'R T O',
    'AUTO BRAKE', 'OTTO BRAKE', 'F L C H', 'LOC', 'APP', 'NAV LIGHTS',
  ];

  assert.deepEqual(required.filter((hint) => !hotwordPhrases.has(hint)), []);
});

test('generated FlyByWire A32NX command hints stay represented in the Zipformer hotwords', () => {
  const hotwordPhrases = new Set(
    fs.readFileSync(path.resolve(__dirname, 'resources', 'voice', 'hotwords.txt'), 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.split(':', 1)[0].trim())
      .filter(Boolean),
  );
  const required = [
    'AUTOPILOT ONE', 'AUTOPILOT TWO', 'AUTOTHRUST', 'EXPEDITE',
    'SPEED MODE', 'HEADING MODE', 'ALTITUDE MODE', 'BEACON LIGHTS',
  ];

  assert.deepEqual(required.filter((hint) => !hotwordPhrases.has(hint)), []);
});

test('push-to-talk shortcuts require modifiers and one bounded key', () => {
  assert.equal(DEFAULT_PUSH_TO_TALK_SHORTCUT, '');
  assert.equal(normalizePushToTalkShortcut('ctrl + alt + spacebar'), 'Control+Alt+Space');
  assert.equal(normalizePushToTalkShortcut('shift+f12'), 'Shift+F12');
  assert.throws(() => normalizePushToTalkShortcut('Space'));
  assert.throws(() => normalizePushToTalkShortcut('Control+Alt+A+B'));
});

test('joystick push-to-talk bindings are bounded and become helper arguments', () => {
  const stickPath = '\\\\?\\hid#vid_044f&pid_b10a#9&764e407&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}';
  const binding = normalizePushToTalkJoystick({
    vendorId: '044f', productId: 'b10a', button: '5', name: ` T.16000M${String.fromCharCode(7)} `, path: stickPath,
  });
  assert.deepEqual(binding, { vendorId: '044F', productId: 'B10A', button: 5, name: 'T.16000M', path: stickPath });
  assert.equal(normalizePushToTalkJoystick(null), null, 'null means no joystick button');
  assert.equal(normalizePushToTalkJoystick(undefined), null);
  assert.throws(() => normalizePushToTalkJoystick({ vendorId: '44F', productId: 'B10A', button: 1 }), /hex/);
  assert.throws(() => normalizePushToTalkJoystick({ vendorId: '044F', productId: 'B10A', button: 0 }), /1 to 512/);
  assert.throws(() => normalizePushToTalkJoystick({ vendorId: '044F', productId: 'B10A', button: 513 }), /1 to 512/);
  assert.throws(() => normalizePushToTalkJoystick({ vendorId: '044F', productId: 'B10A', button: 1, name: 'x'.repeat(65) }), /too long/);
  assert.throws(() => normalizePushToTalkJoystick({ vendorId: '044F', productId: 'B10A', button: 1, path: 'a"b' }), /not usable/);
  assert.throws(() => normalizePushToTalkJoystick('T.16000M button 5'), /object/);

  assert.deepEqual(pushToTalkHelperArguments({ accelerator: 'Control+Alt+Space', joystick: null }), ['--shortcut', 'Control+Alt+Space']);
  assert.deepEqual(
    pushToTalkHelperArguments({ accelerator: '', joystick: binding }),
    ['--joystick', '044F:B10A', '--button', '5', '--device-path', stickPath],
  );
  assert.deepEqual(
    pushToTalkHelperArguments({ accelerator: 'Control+Alt+Space', joystick: { ...binding, path: '' } }),
    ['--shortcut', 'Control+Alt+Space', '--joystick', '044F:B10A', '--button', '5'],
  );
});

test('packaged PTT helper resolves only from application resources', () => {
  assert.equal(
    resolvePushToTalkHelperPath({ appDir: path.resolve('C:\\app'), isPackaged: true, resourcesPath: path.resolve('C:\\resources') }),
    path.join(path.resolve('C:\\resources'), 'voice', 'ptt-hook.exe'),
  );
});

test('PTT helper stays attached to the Electron process job', () => {
  assert.deepEqual(createPushToTalkHelperSpawnOptions(), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false,
  });
});

test('disposing a starting PTT hook cannot reactivate its helper', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-ptt-dispose-'));
  const helperPath = path.join(fixtureDir, 'ptt-hook.exe');
  fs.writeFileSync(helperPath, 'test fixture');
  const candidate = new EventEmitter();
  candidate.stdout = new EventEmitter();
  candidate.stderr = new EventEmitter();
  candidate.killCalls = 0;
  candidate.kill = () => {
    candidate.killCalls += 1;
    return true;
  };
  let downEvents = 0;
  const hook = createPushToTalkHook({
    helperPath,
    onDown: () => { downEvents += 1; },
    onUp: () => {},
    spawnProcess: () => candidate,
  });

  try {
    const registration = hook.setBinding({ accelerator: 'Control+Alt+F12' });
    hook.dispose();
    candidate.stdout.emit('data', Buffer.from('{"type":"ready"}\n'));

    await assert.rejects(registration, /disposed/i);
    assert.deepEqual(hook.getInfo(), { accelerator: '', joystick: null, joystickConnected: false, registered: false });
    assert.ok(candidate.killCalls >= 1, 'dispose must stop the exact in-flight helper object');
    candidate.stdout.emit('data', Buffer.from('{"type":"down"}\n'));
    assert.equal(downEvents, 0, 'a disposed helper must not emit push-to-talk events');
    await assert.rejects(hook.setBinding({ accelerator: 'Control+Alt+F12' }), /disposed/i);
  } finally {
    candidate.emit('close');
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

function createFakeHelperChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = 0;
  child.kill = () => { child.killCalls += 1; return true; };
  child.say = (event) => child.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`));
  return child;
}

test('PTT hook runs the helper with the keyboard shortcut and joystick button together and tracks the stick', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-ptt-joystick-'));
  const helperPath = path.join(fixtureDir, 'ptt-hook.exe');
  fs.writeFileSync(helperPath, 'test fixture');
  const spawned = [];
  const events = [];
  const hook = createPushToTalkHook({
    helperPath,
    onDown: (accelerator) => events.push(['down', accelerator]),
    onUp: (accelerator) => events.push(['up', accelerator]),
    onDevice: (info) => events.push(['device', info.joystickConnected]),
    onError: (error) => events.push(['error', error.message]),
    spawnProcess: (_path, args) => {
      const child = createFakeHelperChild();
      spawned.push({ args, child });
      return child;
    },
  });
  const joystick = { vendorId: '044F', productId: 'B10A', button: 5, name: 'T.16000M', path: '' };
  const stick = { type: 'device', vendorId: '044F', productId: 'B10A', name: 'T.16000M', path: 'p', buttons: 16 };

  try {
    const registration = hook.setBinding({ accelerator: 'Control+Alt+Space', joystick });
    spawned[0].child.say({ type: 'ready' });
    const info = await registration;
    assert.deepEqual(spawned[0].args, ['--shortcut', 'Control+Alt+Space', '--joystick', '044F:B10A', '--button', '5']);
    assert.deepEqual(info, { accelerator: 'Control+Alt+Space', joystick, joystickConnected: false, registered: true });

    spawned[0].child.say({ ...stick, connected: true });
    assert.equal(hook.getInfo().joystickConnected, true, 'a device report marks the bound stick connected');
    spawned[0].child.say({ type: 'down' });
    spawned[0].child.say({ type: 'up' });
    spawned[0].child.say({ ...stick, connected: false });
    assert.deepEqual(events, [['device', true], ['down', 'Control+Alt+Space'], ['up', 'Control+Alt+Space'], ['device', false]]);
    assert.equal(hook.getInfo().joystickConnected, false);

    const unchanged = await hook.setBinding({ accelerator: 'Control+Alt+Space', joystick });
    assert.equal(spawned.length, 1, 'an identical binding must not restart the helper');
    assert.equal(unchanged.registered, true);

    const joystickOnly = hook.setBinding({ accelerator: '', joystick });
    spawned[1].child.say({ type: 'ready' });
    await joystickOnly;
    assert.deepEqual(spawned[1].args, ['--joystick', '044F:B10A', '--button', '5']);
    assert.equal(spawned[0].child.killCalls, 1, 'the superseded helper is stopped');
    spawned[0].child.say({ type: 'down' });
    assert.equal(events.length, 4, 'a superseded helper cannot press push-to-talk');

    const cleared = await hook.setBinding({ accelerator: '', joystick: null });
    assert.equal(spawned.length, 2, 'clearing both bindings launches nothing');
    assert.equal(spawned[1].child.killCalls, 1, 'clearing both bindings stops the helper');
    assert.deepEqual(cleared, { accelerator: '', joystick: null, joystickConnected: false, registered: false });
  } finally {
    hook.dispose();
    for (const { child } of spawned) child.emit('close');
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('joystick learn session relays sanitized device and button events until stopped', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-ptt-learn-'));
  const helperPath = path.join(fixtureDir, 'ptt-hook.exe');
  fs.writeFileSync(helperPath, 'test fixture');
  const child = createFakeHelperChild();
  const seen = [];
  let args = null;
  const starting = startJoystickLearnSession({
    helperPath,
    onDevice: (device) => seen.push(['device', device]),
    onButton: (press) => seen.push(['button', press]),
    onStopped: (error) => seen.push(['stopped', error.message]),
    spawnProcess: (_path, spawnArgs) => { args = spawnArgs; return child; },
  });
  child.say({ type: 'ready' });
  const session = await starting;
  assert.deepEqual(args, ['--learn-joystick']);

  child.say({ type: 'device', connected: true, vendorId: '044f', productId: 'b10a', name: ' T.16000M ', path: 'p', buttons: 16 });
  child.say({ type: 'device', connected: true, vendorId: 'nope', productId: 'b10a', name: 'Broken', path: 'p', buttons: 16 });
  child.say({ type: 'button', vendorId: '044F', productId: 'B10A', name: 'T.16000M', path: 'p', buttons: 16, button: 5, down: true });
  child.say({ type: 'button', vendorId: '044F', productId: 'B10A', name: 'T.16000M', path: 'p', buttons: 16, button: 0, down: true });
  assert.deepEqual(seen, [
    ['device', { vendorId: '044F', productId: 'B10A', name: 'T.16000M', path: 'p', buttons: 16, connected: true }],
    ['button', { vendorId: '044F', productId: 'B10A', name: 'T.16000M', path: 'p', buttons: 16, button: 5, down: true }],
  ]);

  session.stop();
  assert.equal(child.killCalls, 1);
  child.emit('exit', null);
  assert.equal(seen.length, 2, 'an intentional stop is not reported as a failure');

  const failing = createFakeHelperChild();
  const failures = [];
  const secondStart = startJoystickLearnSession({
    helperPath, onDevice: () => {}, onButton: () => {},
    onStopped: (error) => failures.push(error.message),
    spawnProcess: () => failing,
  });
  failing.say({ type: 'ready' });
  await secondStart;
  failing.emit('exit', 3);
  assert.deepEqual(failures, ['Push-to-talk helper stopped (3).']);
  child.emit('close');
  failing.emit('close');
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test('voice runtime exposes transcription-only development mode only when unpackaged', () => {
  function runtimeInfoFor(isPackaged) {
    const ipcMain = new EventEmitter();
    const runtime = createVoiceRuntime({
      app: {
        isPackaged,
        getPath: () => path.resolve('C:\\voice-user-data'),
      },
      appDir: path.resolve('C:\\app'),
      getMainWindow: () => null,
      ipcMain,
      registerTrustedIpcHandler: () => {},
      resourcesPath: path.resolve('C:\\resources'),
    });
    return runtime.runtimeInfo();
  }

  assert.equal(runtimeInfoFor(false).development, true);
  assert.equal(runtimeInfoFor(true).development, false);
});

test('voice recognition is default-off and starts local resources only after explicit opt-in', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-voice-opt-in-'));
  const handlers = new Map();
  let engineReady = false;
  let engineInitializations = 0;
  let engineShutdowns = 0;
  let hookCreations = 0;
  let hookDisposals = 0;
  const speechEngine = {
    cancel: () => false,
    finish: () => false,
    getInfo: () => ({
      activeSessionId: null,
      modelId: 'test-model',
      ready: engineReady,
      state: engineReady ? 'ready' : 'stopped',
    }),
    initialize: async () => { engineInitializations += 1; engineReady = true; },
    onEvent: () => {},
    pushAudio: () => {},
    shutdown: async () => { engineShutdowns += 1; engineReady = false; },
    start: () => ({ sessionId: 'session_12345678', sampleRate: 16000, timeoutMs: 10000 }),
  };
  const runtime = createVoiceRuntime({
    app: { isPackaged: true, getPath: () => userDataDir },
    appDir: path.resolve('C:\\app'),
    getMainWindow: () => null,
    ipcMain: new EventEmitter(),
    pushToTalkHookFactory: () => {
      hookCreations += 1;
      return {
        dispose() { hookDisposals += 1; },
        getInfo: () => ({ accelerator: '', joystick: null, joystickConnected: false, registered: false }),
        setBinding: async ({ accelerator, joystick }) => ({ accelerator, joystick, joystickConnected: false, registered: true }),
      };
    },
    registerTrustedIpcHandler: (channel, handler) => handlers.set(channel, handler),
    resourcesPath: path.resolve('C:\\resources'),
    speechEngine,
  });

  try {
    const initial = await runtime.initialize();
    assert.equal(initial.enabled, false);
    assert.equal(initial.available, false);
    assert.equal(engineInitializations, 0, 'disabled startup must not initialize recognition');
    assert.equal(hookCreations, 0, 'disabled startup must not create the push-to-talk hook');
    assert.throws(
      () => handlers.get('voice:speech-start')({ sender: { id: 7 } }),
      /disabled/i,
    );

    const enabled = await handlers.get('voice:set-recognition-enabled')({}, true);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.available, true);
    assert.equal(engineInitializations, 1);
    assert.equal(hookCreations, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userDataDir, 'voice-control.json'), 'utf8')), {
      pushToTalkJoystick: null,
      pushToTalkShortcut: '',
      voiceRecognitionEnabled: true,
    });

    const disabled = await handlers.get('voice:set-recognition-enabled')({}, false);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.available, false);
    assert.equal(engineShutdowns, 1);
    assert.equal(hookDisposals, 1);
    assert.throws(
      () => handlers.get('voice:speech-start')({ sender: { id: 7 } }),
      /disabled/i,
    );
  } finally {
    await runtime.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('voice runtime exposes only its bounded local readback engine through trusted IPC', async () => {
  const handlers = new Map();
  const spoken = [];
  let cancellations = 0;
  const speechEngine = {
    cancel: () => false,
    finish: () => false,
    getInfo: () => ({ activeSessionId: null, modelId: 'test-model', ready: true, state: 'ready' }),
    initialize: async () => {},
    onEvent: () => {},
    pushAudio: () => {},
    shutdown: async () => {},
    start: () => ({ sessionId: 'session_12345678', sampleRate: 16000, timeoutMs: 10000 }),
  };
  const readbackEngine = {
    cancel() { cancellations += 1; return true; },
    getInfo: () => ({ available: true, engine: 'windows-sapi', local: true }),
    speak(text) { spoken.push(text); return true; },
  };
  const runtime = createVoiceRuntime({
    app: {
      isPackaged: true,
      getPath: () => path.resolve('C:\\voice-user-data'),
    },
    appDir: path.resolve('C:\\app'),
    getMainWindow: () => null,
    ipcMain: new EventEmitter(),
    readbackEngine,
    registerTrustedIpcHandler: (channel, handler) => handlers.set(channel, handler),
    resourcesPath: path.resolve('C:\\resources'),
    speechEngine,
  });

  assert.deepEqual(handlers.get('voice:get-readback-info')(), {
    available: true, engine: 'windows-sapi', local: true,
  });
  assert.deepEqual(handlers.get('voice:readback-speak')({}, 'Heading two seven zero set.'), {
    started: true,
  });
  assert.deepEqual(spoken, ['Heading two seven zero set.']);
  assert.deepEqual(handlers.get('voice:readback-cancel')(), { cancelled: true });
  assert.deepEqual(runtime.runtimeInfo().readback, readbackEngine.getInfo(),
    'runtime state should carry the readback engine state so the renderer can show readback failures');
  await runtime.shutdown();
  assert.equal(cancellations, 2, 'runtime shutdown should stop any remaining readback');
});

test('voice runtime authorizes microphone access only for its active renderer session', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-voice-session-'));
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  const listeners = new Map();
  let activeSessionId = null;
  let engineReady = true;
  const outgoing = [];
  let eventListener = () => {};
  let sessionSequence = 0;
  let acceptedAudioChunks = 0;
  const speechEngine = {
    cancel(sessionId) {
      if (activeSessionId !== sessionId) return false;
      activeSessionId = null;
      eventListener({ type: 'cancelled', sessionId });
      return true;
    },
    finish(sessionId) {
      if (activeSessionId !== sessionId) return false;
      activeSessionId = null;
      return true;
    },
    getInfo: () => ({
      activeSessionId,
      modelId: 'test-model',
      ready: engineReady,
      state: engineReady ? 'ready' : 'failed',
    }),
    initialize: async () => { engineReady = true; },
    onEvent(listener) { eventListener = listener; },
    pushAudio() { acceptedAudioChunks += 1; },
    shutdown: async () => { activeSessionId = null; },
    start() {
      if (activeSessionId) throw new Error('session already active');
      sessionSequence += 1;
      activeSessionId = `session_${String(sessionSequence).padStart(8, '0')}`;
      return { sessionId: activeSessionId, sampleRate: 16000, timeoutMs: 10000 };
    },
  };
  const runtime = createVoiceRuntime({
    app: {
      isPackaged: true,
      getPath: () => userDataDir,
    },
    appDir: path.resolve('C:\\app'),
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel, payload) => outgoing.push({ channel, payload }),
      },
    }),
    ipcMain,
    pushToTalkHookFactory: () => ({
      dispose() {},
      getInfo: () => ({ accelerator: '', joystick: null, joystickConnected: false, registered: false }),
      setBinding: async ({ accelerator, joystick }) => ({ accelerator, joystick, joystickConnected: false, registered: true }),
    }),
    registerTrustedIpcHandler: (channel, handler, options = {}) => {
      (options.listener === true ? listeners : handlers).set(channel, handler);
    },
    resourcesPath: path.resolve('C:\\resources'),
    speechEngine,
  });
  const owner = { id: 41 };
  const otherRenderer = { id: 42 };
  const startRecognition = handlers.get('voice:speech-start');
  const finishRecognition = handlers.get('voice:speech-finish');
  const cancelRecognition = handlers.get('voice:speech-cancel');
  const acceptAudio = listeners.get(AUDIO_CHANNEL);
  const audioPayload = (sessionId, sequence = 0) => ({
    sampleRate: 16000,
    samples: new Float32Array([0.25, -0.25]).buffer,
    sequence,
    sessionId,
  });

  await handlers.get('voice:set-recognition-enabled')({}, true);
  assert.equal(runtime.isAudioCaptureAuthorized(owner), false, 'idle microphone access must be denied');
  const first = startRecognition({ sender: owner });
  assert.equal(runtime.isAudioCaptureAuthorized(owner), true);
  assert.equal(runtime.isAudioCaptureAuthorized(otherRenderer), false);
  assert.equal(typeof acceptAudio, 'function', 'audio must use the centralized trusted listener registrar');
  acceptAudio({ sender: otherRenderer }, audioPayload(first.sessionId));
  assert.equal(acceptedAudioChunks, 0, 'another renderer must not inject audio into the session');
  acceptAudio({ sender: owner }, audioPayload(first.sessionId));
  assert.equal(acceptedAudioChunks, 1);
  assert.deepEqual(finishRecognition({ sender: owner }, first.sessionId), { finishing: true });
  assert.equal(runtime.isAudioCaptureAuthorized(owner), false, 'finishing must revoke microphone access');

  const second = startRecognition({ sender: owner });
  eventListener({ type: 'error', sessionId: second.sessionId, fatal: false });
  activeSessionId = null;
  assert.equal(runtime.isAudioCaptureAuthorized(owner), false, 'recognition errors must revoke microphone access');

  const third = startRecognition({ sender: owner });
  assert.deepEqual(cancelRecognition({ sender: owner }, third.sessionId), { cancelled: true });
  assert.equal(runtime.isAudioCaptureAuthorized(owner), false, 'cancellation must revoke microphone access');

  const fourth = startRecognition({ sender: owner });
  acceptAudio({ sender: owner }, {
    ...audioPayload(fourth.sessionId),
    samples: new ArrayBuffer(0),
  });
  assert.equal(runtime.isAudioCaptureAuthorized(owner), false, 'invalid audio must revoke microphone access');

  startRecognition({ sender: owner });
  assert.equal(runtime.cancelActiveSession(), true);
  assert.equal(runtime.isAudioCaptureAuthorized(owner), false, 'navigation-style cancellation must revoke microphone access');
  for (const withSessionId of [false, true]) {
    const failed = startRecognition({ sender: owner });
    activeSessionId = null;
    engineReady = false;
    eventListener({
      type: 'error', fatal: true, code: 'WORKER_FAILED', message: 'Local voice worker stopped.',
      ...(withSessionId ? { sessionId: failed.sessionId } : {}),
    });
    assert.equal(runtime.isAudioCaptureAuthorized(owner), false);
    assert.equal(runtime.runtimeInfo().available, false);
    assert.equal(runtime.runtimeInfo().error, 'Local voice worker stopped.');
    assert.equal(outgoing.at(-1).channel, 'voice:runtime-state');
    assert.equal(outgoing.at(-1).payload.error, 'Local voice worker stopped.');
    const recovered = await handlers.get('voice:set-recognition-enabled')({}, true);
    assert.equal(recovered.available, true);
    assert.equal(recovered.error, '');
  }
  await runtime.shutdown();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

for (const isPackaged of [true, false]) {
  test(`joystick release hold blocks saved bindings and IPC in ${isPackaged ? 'packaged' : 'development'} runs`, async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-voice-joystick-disabled-'));
    const settingsPath = path.join(userDataDir, 'voice-control.json');
    const joystick = { vendorId: '044F', productId: 'B10A', button: 5, name: 'T.16000M', path: 'p' };
    fs.writeFileSync(settingsPath, JSON.stringify({ pushToTalkJoystick: joystick, voiceRecognitionEnabled: true }));
    const handlers = new Map();
    const bindings = [];
    let learnStarts = 0;
    let hookInfo = { accelerator: '', joystick: null, joystickConnected: false, registered: false };
    const speechEngine = {
      cancel: () => false, finish: () => false,
      getInfo: () => ({ activeSessionId: null, modelId: 'test-model', ready: true, state: 'ready' }),
      initialize: async () => {}, onEvent: () => {}, pushAudio: () => {}, shutdown: async () => {},
      start: () => ({ sessionId: 'session_12345678', sampleRate: 16000, timeoutMs: 10000 }),
    };
    const runtime = createVoiceRuntime({
      app: { isPackaged, getPath: () => userDataDir }, appDir: __dirname, resourcesPath: __dirname,
      getMainWindow: () => null, ipcMain: new EventEmitter(), speechEngine,
      joystickLearnSessionFactory: async () => { learnStarts += 1; throw new Error('Must never start'); },
      pushToTalkHookFactory: () => ({
        dispose() {}, getInfo: () => hookInfo,
        setBinding: async (binding) => {
          bindings.push(binding);
          hookInfo = { ...binding, joystickConnected: false, registered: true };
          return hookInfo;
        },
      }),
      registerTrustedIpcHandler: (channel, handler) => handlers.set(channel, handler),
    });
    try {
      const info = await runtime.initialize();
      assert.equal(info.pushToTalk.joystickAvailable, false);
      assert.equal(info.pushToTalk.joystick, null);
      assert.equal(info.pushToTalk.joystickConnected, false);
      assert.deepEqual(bindings, [], 'a saved joystick alone must never launch the helper');
      for (const value of [joystick, null]) {
        await assert.rejects(handlers.get('voice:set-push-to-talk-joystick')({}, value), /disabled in this release/);
      }
      await assert.rejects(handlers.get('voice:joystick-learn-start')(), /disabled in this release/);
      assert.deepEqual(await handlers.get('voice:joystick-learn-stop')(), { stopped: false });
      assert.equal(learnStarts, 0, 'detection is blocked before any device access');
      const keyboard = await handlers.get('voice:set-push-to-talk-shortcut')({}, 'Control+Alt+Space');
      assert.equal(keyboard.registered, true);
      assert.deepEqual(bindings.at(-1), { accelerator: 'Control+Alt+Space', joystick: null });
      assert.equal(keyboard.joystick, null);
      assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).pushToTalkJoystick, joystick,
        'the disabled binding is retained for future use, not deleted');
      await handlers.get('voice:set-recognition-enabled')({}, false);
      await handlers.get('voice:set-recognition-enabled')({}, true);
      assert.ok(bindings.every(binding => binding.joystick === null), 'voice restart cannot restore the joystick');
      assert.deepEqual(handlers.get('voice:speech-start')({ sender: { id: 1 } }).sessionId, 'session_12345678',
        'on-screen recognition remains usable');
    } finally {
      await runtime.shutdown();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
}

function speechWorkerHarness() {
  const events = [];
  const streams = [];
  let handleMessage;
  class Recognizer {
    createStream() {
      const stream = {
        frames: 0,
        acceptWaveform({ samples }) { this.frames += samples.length; },
        inputFinished() {},
      };
      streams.push(stream);
      return stream;
    }
    isReady() { return false; }
    getResult() { return { text: 'START APU' }; }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'voice-speech-worker.js'), 'utf8'), {
    Float32Array,
    require(name) {
      if (name === 'node:worker_threads') return {
        parentPort: {
          on(_event, callback) { handleMessage = callback; },
          postMessage(event) { events.push(event); },
          close() {},
        },
        workerData: {
          modelDir: path.resolve('voice-model-fixture'),
          hotwordsPath: path.resolve('voice-hotwords-fixture.txt'),
        },
      };
      if (name === 'node:fs') return {
        lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 1 }),
      };
      if (name === 'sherpa-onnx-node') return { OnlineRecognizer: Recognizer };
      return require(name);
    },
  });
  assert.ok(events.some(event => event.type === 'ready'));
  return { events, streams, send: message => handleMessage(message) };
}

test('worker accepts exactly ten seconds regardless of PCM rate and chunk boundaries', () => {
  for (const sampleRate of [16000, 22050, 44100, 48000]) {
    for (const chunkFrames of [128, 2048, 8192]) {
      const worker = speechWorkerHarness();
      const sessionId = 'boundary_session';
      worker.send({ type: 'start', sessionId });
      const totalFrames = sampleRate * 10;
      let sequence = 0;
      for (let offset = 0; offset < totalFrames; offset += chunkFrames) {
        worker.send({
          type: 'audio', sessionId, sampleRate, sequence: sequence++,
          samples: new Float32Array(Math.min(chunkFrames, totalFrames - offset)),
        });
      }
      worker.send({ type: 'finish', sessionId });
      const context = `${sampleRate} Hz with ${chunkFrames}-frame chunks`;
      assert.equal(worker.events.filter(event => event.type === 'error').length, 0, context);
      assert.equal(worker.events.filter(event => event.type === 'final').length, 1, context);
      assert.equal(worker.streams[0].frames, sampleRate * 10.5, context);
    }
  }
});

test('worker rejects audio beyond ten seconds without producing a command', () => {
  const worker = speechWorkerHarness();
  const sessionId = 'overflow_session';
  const sampleRate = 44100;
  worker.send({ type: 'start', sessionId });
  for (let sequence = 0; sequence < 10; sequence += 1) {
    worker.send({ type: 'audio', sessionId, sampleRate, sequence, samples: new Float32Array(sampleRate) });
  }
  worker.send({ type: 'audio', sessionId, sampleRate, sequence: 10, samples: new Float32Array([0.1]) });
  worker.send({ type: 'finish', sessionId });
  assert.equal(worker.events.filter(event => event.type === 'error').length, 1);
  assert.equal(worker.events.filter(event => event.type === 'final').length, 0);
});

test('each push-to-talk utterance uses a fresh Zipformer stream', () => {
  const workerSource = fs.readFileSync(path.join(__dirname, 'voice-speech-worker.js'), 'utf8');
  assert.match(workerSource, /const stream = recognizer\.createStream\(\);/);
  assert.match(workerSource, /FINAL_SILENCE_SECONDS/);
  assert.match(workerSource, /hotwordsFile: hotwordsFile\(\)/);
  assert.doesNotMatch(workerSource, /recognizer\.reset\(|reusableStream/);
});

test('native Zipformer preserves final APU letters and heading digits, recognizes NAV and keeps silence empty', {
  timeout: 30_000,
}, async (t) => {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    t.skip('The bundled native recognizer targets Windows x64.');
    return;
  }
  const modelDir = resolveVoiceModelDir({ appDir: __dirname, isPackaged: false });
  if (!ZIPFORMER_MODEL.files.every((file) => fs.existsSync(path.join(modelDir, file.name)))) {
    t.skip('Provision the pinned voice model to run acoustic regressions.');
    return;
  }
  try { require.resolve('sherpa-onnx-node'); require.resolve('sherpa-onnx-win-x64'); } catch {
    t.skip('Install Electron dependencies to run acoustic regressions.');
    return;
  }
  const { readWave } = require('sherpa-onnx-node');
  const { normalizeAviationAcronyms } = await import('../frontend/src/voice/aviation-acronyms.js');
  const { interpretAircraftVoiceCommand } = await import('../frontend/src/voice/command-interpreter.js');
  const headingCatalogue = { commands: [{
    id: 'heading', speech: { patterns: ['set heading {value}'] },
    input: { kind: 'number', min: 0, max: 359, step: 1, units: 'degrees' },
  }] };
  const engine = createVoiceSpeechEngine();
  t.after(() => engine.shutdown());
  await engine.initialize();
  const fixtures = ['decimal', 'point'].map((separator) => ({
    ...readWave(path.join(__dirname, '..', 'tests', 'fixtures', 'voice', `nav-109-${separator}-five.wav`)),
    expected: `SET NAV RADIOS ONE ZERO NINE ${separator.toUpperCase()} FIVE`,
  }));
  for (const voice of ['david', 'zira']) {
    for (const [phrase, expectedAcronyms] of [
      ['apu-start', 'start apu'],
      ['apu-incomplete', 'start ap'],
      ['heading-270', 'set heading two seven zero'],
      ['heading-070', 'set heading zero seven zero'],
      ['heading-incomplete', null],
    ]) {
      const { samples, sampleRate } = readWave(path.join(
        __dirname, '..', 'tests', 'fixtures', 'voice', `${phrase}-${voice}.wav`,
      ));
      // SAPI adds about 700 ms of digital silence. Keeping it would conceal
      // truncated final tokens in short PTT recordings. Retain every non-zero
      // sample, vary alignment within the model's decoding chunks, and append
      // only the controller's 250 ms captured release tail.
      let end = samples.length;
      while (end > 0 && samples[end - 1] === 0) end -= 1;
      for (const prefixMs of [0, 80, 160, 240]) {
        const prefixFrames = Math.round(sampleRate * prefixMs / 1000);
        const aligned = new Float32Array(prefixFrames + end + Math.round(sampleRate * 0.25));
        aligned.set(samples.subarray(0, end), prefixFrames);
        fixtures.push({
          samples: aligned, sampleRate, expectedAcronyms,
          incompleteApu: phrase === 'apu-incomplete',
          incompleteHeading: phrase === 'heading-incomplete',
          label: `${phrase}-${voice}, prefix ${prefixMs} ms, captured tail 250 ms`,
        });
      }
    }
  }
  for (const durationMs of [0, 100, 1000, 3000]) {
    fixtures.push({ samples: new Float32Array(durationMs * 16), sampleRate: 16000, expected: '',
      silent: true, label: `digital silence, ${durationMs} ms` });
  }
  fixtures.push({ samples: new Float32Array(48000), sampleRate: 48000, expected: '',
    silent: true, label: 'digital silence at microphone sample rate, 1000 ms' });
  fixtures.push({ ...fixtures[0], label: 'speech after silent sessions' });
  for (const { samples, sampleRate, expected, expectedAcronyms, incompleteApu, incompleteHeading, silent, label } of fixtures) {
    const { sessionId } = engine.start();
    let unsubscribe;
    let timer;
    const partials = [];
    const final = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Native recognition did not finalize')), 10_000);
      unsubscribe = engine.onEvent((event) => {
        if (event.sessionId !== sessionId) return;
        if (event.type === 'partial') partials.push(event.text);
        if (event.type === 'error') reject(new Error(event.message));
        if (event.type === 'final') resolve(event);
      });
      try {
        // Each fixture fits inside the engine's four-second audio queue.
        for (let offset = 0, sequence = 0; offset < samples.length; offset += 3200, sequence++) {
          engine.pushAudio({ sessionId, sequence, sampleRate, samples: samples.slice(offset, offset + 3200) });
        }
        assert.equal(engine.finish(sessionId), true);
      } catch (error) { reject(error); }
    });
    try {
      const text = (await final).text;
      if (incompleteHeading) {
        // "Two seven" must not acquire an unspoken zero or become heading 27.
        assert.equal(interpretAircraftVoiceCommand(text, headingCatalogue).ok, false, `${label}: ${text}`);
      } else if (incompleteApu) {
        // Padding/bias changes must not turn an unspoken U into an executable
        // APU command. Missing P is also incomplete, so it remains rejected.
        assert.ok(['start a', 'start ap'].includes(normalizeAviationAcronyms(text.toLowerCase())), `${label}: ${text}`);
      } else if (expectedAcronyms) assert.equal(normalizeAviationAcronyms(text.toLowerCase()), expectedAcronyms, label);
      else assert.equal(text, expected, label);
      if (silent) assert.ok(partials.every(partial => partial === ''), `${label}: ${partials.join(', ')}`);
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  }
});

test('fatal worker initialization errors reject immediately instead of waiting for timeout', async () => {
  let fakeWorker = null;
  class FakeWorker extends EventEmitter {
    constructor() {
      super();
      fakeWorker = this;
      this.terminated = false;
    }
    postMessage() {}
    async terminate() { this.terminated = true; return 0; }
  }

  const engine = createVoiceSpeechEngine({
    appDir: path.resolve('C:\\app'),
    modelDir: path.resolve('C:\\voice-model'),
    WorkerClass: FakeWorker,
    verifyHotwords: async () => ({ verified: true }),
    verifyModel: async () => ({ verified: true }),
    initializationTimeoutMs: 5_000,
  });
  const initializing = engine.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  fakeWorker.emit('message', {
    type: 'error', fatal: true, code: 'ENGINE_INITIALIZATION_FAILED',
    message: 'Recognizer failed immediately.',
  });

  await assert.rejects(initializing, /Recognizer failed immediately/);
  assert.equal(engine.getInfo().state, 'failed');
  assert.equal(fakeWorker.terminated, true);
});

test('a non-zero worker exit during initialization rejects immediately', async () => {
  let fakeWorker = null;
  class FakeWorker extends EventEmitter {
    constructor() { super(); fakeWorker = this; }
    postMessage() {}
    async terminate() { return 0; }
  }

  const engine = createVoiceSpeechEngine({
    appDir: path.resolve('C:\\app'),
    modelDir: path.resolve('C:\\voice-model'),
    WorkerClass: FakeWorker,
    verifyHotwords: async () => ({ verified: true }),
    verifyModel: async () => ({ verified: true }),
    initializationTimeoutMs: 5_000,
  });
  const initializing = engine.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  fakeWorker.emit('exit', 1);

  await assert.rejects(initializing, /exited during initialization/i);
  assert.equal(engine.getInfo().state, 'failed');
});
