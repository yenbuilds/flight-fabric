'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safeModelFilePath, sha256File, verifyVoiceHotwords } = require('./voice-model-integrity');
const { VOICE_HOTWORDS, ZIPFORMER_MODEL } = require('./voice-model-manifest');
const {
  DEFAULT_PUSH_TO_TALK_SHORTCUT,
  normalizePushToTalkShortcut,
} = require('./voice-push-to-talk');
const { resolvePushToTalkHelperPath } = require('./voice-push-to-talk-hook');
const { AUDIO_CHANNEL, createVoiceRuntime } = require('./voice-runtime');
const {
  createVoiceSpeechEngine,
  resolveVoiceHotwordsPath,
  resolveVoiceModelDir,
} = require('./voice-speech-engine');

test('voice manifest pins the compact Zipformer runtime subset', () => {
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
  assert.equal(VOICE_HOTWORDS.bytes, 2_309);
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
  assert.deepEqual(await verifyVoiceHotwords(filename), { bytes: 2_309, verified: true });
  const hotwords = fs.readFileSync(filename, 'utf8');
  for (const digit of ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE']) {
    assert.match(hotwords, new RegExp(`^${digit} :`, 'm'));
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

test('push-to-talk shortcuts require modifiers and one bounded key', () => {
  assert.equal(DEFAULT_PUSH_TO_TALK_SHORTCUT, '');
  assert.equal(normalizePushToTalkShortcut('ctrl + alt + spacebar'), 'Control+Alt+Space');
  assert.equal(normalizePushToTalkShortcut('shift+f12'), 'Shift+F12');
  assert.throws(() => normalizePushToTalkShortcut('Space'));
  assert.throws(() => normalizePushToTalkShortcut('Control+Alt+A+B'));
});

test('packaged PTT helper resolves only from application resources', () => {
  assert.equal(
    resolvePushToTalkHelperPath({ appDir: path.resolve('C:\\app'), isPackaged: true, resourcesPath: path.resolve('C:\\resources') }),
    path.join(path.resolve('C:\\resources'), 'voice', 'ptt-hook.exe'),
  );
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
        getInfo: () => ({ accelerator: '', registered: false }),
        setShortcut: async (accelerator) => ({ accelerator, registered: true }),
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
  await runtime.shutdown();
  assert.equal(cancellations, 2, 'runtime shutdown should stop any remaining readback');
});

test('voice runtime authorizes microphone access only for its active renderer session', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-voice-session-'));
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  const listeners = new Map();
  let activeSessionId = null;
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
      ready: true,
      state: 'ready',
    }),
    initialize: async () => {},
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
    getMainWindow: () => null,
    ipcMain,
    pushToTalkHookFactory: () => ({
      dispose() {},
      getInfo: () => ({ accelerator: '', registered: false }),
      setShortcut: async (accelerator) => ({ accelerator, registered: true }),
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
  await runtime.shutdown();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

test('each push-to-talk utterance uses a fresh Zipformer stream', () => {
  const workerSource = fs.readFileSync(path.join(__dirname, 'voice-speech-worker.js'), 'utf8');
  assert.match(workerSource, /const stream = recognizer\.createStream\(\);/);
  assert.match(workerSource, /FINAL_SILENCE_SECONDS/);
  assert.match(workerSource, /hotwordsFile: hotwordsFile\(\)/);
  assert.doesNotMatch(workerSource, /recognizer\.reset\(|reusableStream/);
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
