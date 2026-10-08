import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceControlController } from './voice-controller.js';
import { createPinia, setActivePinia } from 'pinia';
import { useAircraftControlsStore } from '../vue/stores/aircraft-controls.js';
import { createAircraftControlController } from '../aircraft/control-controller.js';
import { createAutopilotPanel } from '../aircraft/autopilot-panel.js';
import { initialVoiceTestState } from './voice-setup-test.js';
import { flapResultText } from '../aircraft/flap-controls.js';
import { gearResultText } from '../aircraft/gear-controls.js';
import { createPcmCapture } from './pcm-capture.js';

function createHarness(options = {}) {
  const command = {
    id: 'flightGuidance.heading.set',
    label: 'Selected heading',
    input: { kind: 'number', min: 0, max: 359, step: 1, units: 'degrees' },
    speech: { patterns: ['set heading {value}', 'heading {value}'], hints: ['HEADING'] },
  };
  const defaultCatalogue = {
      configurationId: 'generic', profileKey: 'test/generic', profileRevision: 1,
      commands: { [command.id]: command },
  };
  const aircraftControlsStore = options.aircraftControlsStore || {
    availability: options.availability || { enabled: true, reason: 'Ready.' },
    aircraftCommandCatalogue: options.catalogue || defaultCatalogue,
  };
  const sentCommands = [];
  const aircraftControl = options.aircraftControl || {
    sendCommand(commandId, input, commandOptions) {
      sentCommands.push({ commandId, input, options: commandOptions });
      return options.sendCommandResult ?? true;
    },
  };
  const state = {
    runtime: {
      available: false, development: false, enabled: false, error: '', modelId: '', shortcut: '',
      shortcutError: '', shortcutRegistered: false,
    },
    status: 'initializing', statusText: '', transcript: '', lastCommand: '', activeSessionId: '',
    inputDevices: [], inputDevicesError: '', selectedInputDeviceId: '', spokenReadbacks: true,
    voiceTest: initialVoiceTestState(),
  };
  const voiceStore = Object.assign(state, {
    bindRuntime(actions) { this.actions = actions; },
    applyRuntimeInfo(info) {
      this.runtime = {
        available: info.available === true,
        development: info.development === true,
        enabled: info.enabled === true,
        mode: info.mode === 'cloud' ? 'cloud' : 'offline',
        cloud: info.cloud || { keyConfigured: false, storageAvailable: false },
        error: info.error || '',
        modelId: info.engine?.modelId || '',
        shortcut: typeof info.pushToTalk?.accelerator === 'string'
          ? info.pushToTalk.accelerator
          : '',
        shortcutError: info.pushToTalk?.error || '',
        shortcutRegistered: info.pushToTalk?.registered === true,
        controllerEnabled: info.pushToTalk?.controllerEnabled === true,
      };
    },
    setState(status, text) { this.status = status; this.statusText = text; },
    setSession(value) { this.activeSessionId = value; },
    setTranscript(value) { this.transcript = value; },
    setLastCommand(value) { this.lastCommand = value; },
    setDeviceLabel(value) { this.deviceLabel = value; },
    setInputDevices(value) { this.inputDevices = value; },
    setInputDevicesError(value) { this.inputDevicesError = value; },
    setSelectedInputDevice(value) { this.selectedInputDeviceId = String(value || ''); },
    setSpokenReadbacks(value) { this.spokenReadbacks = value === true; },
    setVoiceTestState(patch) { this.voiceTest = { ...this.voiceTest, ...patch }; },
  });
  let recognitionListener = null;
  let pttListener = null;
  let runtimeListener = null;
  let recognitionSessionIndex = 0;
  const audio = [];
  const cancellations = [];
  const captureCancellations = [];
  const captureStops = [];
  let runtimeInfo = options.runtimeInfo || ({
      available: true,
      development: options.development === true,
      enabled: true,
      engine: { modelId: 'zipformer' },
      pushToTalk: { accelerator: 'Control+Alt+Space', registered: true },
    });
  const api = {
    getRuntimeInfo: async () => runtimeInfo,
    onRecognitionEvent(listener) { recognitionListener = listener; return () => {}; },
    onPushToTalk(listener) { pttListener = listener; return () => {}; },
    onRuntimeState(listener) { runtimeListener = listener; return () => {}; },
    startRecognition: options.startRecognition
      || (async () => ({
        sessionId: recognitionSessionIndex++ === 0
          ? 'session_12345678'
          : `session_next_${recognitionSessionIndex}`,
      })),
    finishRecognition: async () => ({ finishing: true }),
    cancelRecognition: async (sessionId) => { cancellations.push(sessionId); },
    speakReadback: async value => { spokenReadbacks.push(value); return { started: true }; },
    sendAudio(payload) { audio.push(payload); },
    setRecognitionEnabled: async (enabled) => {
      runtimeInfo = {
        ...runtimeInfo,
        available: enabled === true,
        enabled: enabled === true,
      };
      runtimeListener?.(runtimeInfo);
      return runtimeInfo;
    },
    setPushToTalkShortcut: async (accelerator) => ({ accelerator, registered: true }),
    ...options.controllerApi,
  };
  const captures = [];
  const spokenReadbacks = [];
  const readbackCancellations = [];
  const readback = options.readback || {
    prepare() { return true; },
    speak(value) { spokenReadbacks.push(value); return true; },
    cancel() { readbackCancellations.push(true); },
  };
  const toneEvents = [];
  const pushToTalkTone = options.pushToTalkTone || {
    async play(phase) {
      toneEvents.push({ phase, stoppedCaptures: captureStops.length });
      return true;
    },
    async dispose() {},
  };
  const createCapture = options.createCapture || ((callbacks) => {
    const capture = {
      callbacks,
      start: async () => ({ deviceLabel: 'Test microphone', sampleRate: 48000 }),
      stop: async () => {
        captureStops.push(capture);
        if (options.chunkOnStop) {
          callbacks.onChunk({
            sampleRate: 48000,
            samples: new Float32Array([0.25, -0.25]),
            sequence: 0,
          });
        }
      },
      cancel: async () => { captureCancellations.push(capture); },
    };
    captures.push(capture);
    return capture;
  });
  const controller = createVoiceControlController({
    api, aircraftControl, aircraftControlsStore, voiceStore, createCapture,
    aircraftSpecificStore: options.aircraftSpecificStore,
    simbriefStore: options.simbriefStore,
    globalRef: options.globalRef || {}, readback, pushToTalkTone,
    // Most controller tests do not need to spend real time in the production
    // release tail. The dedicated regression below exercises the real delay.
    releaseTailMs: options.releaseTailMs ?? 0,
  });
  return {
    aircraftControlsStore, audio, cancellations, captureCancellations, captureStops, captures, controller,
    completeLastCommand: (result) => sentCommands.at(-1)?.options?.onResult?.(result),
    emitRecognition: (event) => recognitionListener?.(event),
    emitPtt: (event) => pttListener?.(event),
    emitRuntime: (event) => runtimeListener?.(event),
    readbackCancellations, sentCommands, spokenReadbacks, toneEvents, voiceStore,
  };
}

const cloudRuntime = { available: true, enabled: true, mode: 'cloud',
  cloud: { keyConfigured: true, storageAvailable: true, providerId: 'openai', modelId: 'gpt-realtime-2.1-mini', revision: 0 } };
const headingIntent = { decision: 'command', commandId: 'flightGuidance.heading.set', input: { value: 270 } };
function cloudFinal(intent = headingIntent) {
  return { type: 'final', mode: 'cloud', selection: { providerId: 'openai', modelId: 'gpt-realtime-2.1-mini', revision: 0 }, sessionId: 'session_12345678', text: '', intent: structuredClone(intent) };
}

test('cloud PTT passes the resolved context and executes once through the existing command/readback path', async t => {
  let supplied;
  const h = createHarness({ runtimeInfo: cloudRuntime, startRecognition: async options => {
    supplied = options; return { sessionId: 'session_12345678' };
  } });
  t.after(() => h.controller.dispose()); await h.controller.initialize();
  await h.controller.begin();
  assert.equal(supplied.context.profileRevision, 1);
  assert.equal(supplied.context.commands[0].input.max, 359);
  assert.equal(h.sentCommands.length, 0);
  await h.controller.finish();
  await h.emitRecognition(cloudFinal()); await h.emitRecognition(cloudFinal());
  assert.equal(h.sentCommands.length, 1);
  assert.equal(h.sentCommands[0].commandId, headingIntent.commandId);
  assert.deepEqual(h.sentCommands[0].input, { value: 270 });
  assert.equal(h.voiceStore.status, 'sending');
  assert.deepEqual(h.spokenReadbacks, []);
  h.completeLastCommand({ ok: true });
  assert.equal(h.voiceStore.status, 'sent');
  assert.equal(h.spokenReadbacks.length, 1);
});

test('cloud capture limit closes the microphone and preserves the error through runtime cancellation', async t => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { EventEmitter } = await import('node:events');
  const { createVoiceRuntime } = await import('../../../electron/voice-runtime.js');
  const { createVoiceCloudEngine } = await import('../../../electron/voice-cloud-engine.js');
  const { default: contract } = await import('../../../shared/voice-intent.js');
  const root = path.resolve('.tmp'); fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'voice-capture-regression-'));
  const handlers = new Map(), deliveries = [];
  let h, uploads = 0;
  fs.writeFileSync(path.join(directory, 'voice-control.json'), JSON.stringify({ voiceMode: 'cloud', voiceRecognitionEnabled: true }));
  const engine = createVoiceCloudEngine({ loadContract: () => contract, getApiKey: () => 'synthetic-key',
    interpret: async () => { uploads++; return { intent: headingIntent }; } });
  const runtime = createVoiceRuntime({ app: { isPackaged: false, getPath: () => directory }, appDir: directory,
    cloudVoiceEnabled: true, // Keep the preview lifecycle regression active while release builds disable it.
    ipcMain: new EventEmitter(), cloudEngine: engine,
    credentialStore: { info: () => ({ keyConfigured: true, storageAvailable: true }) },
    readbackEngine: { getInfo: () => ({}), cancel() {} },
    registerTrustedIpcHandler: (name, handler) => handlers.set(name, handler),
    pushToTalkHookFactory: () => ({ setBinding: async () => {}, getInfo: () => ({}), dispose() {} }),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false,
      send(channel, data) { if (channel === 'voice:speech-event' && h) deliveries.push(h.emitRecognition(data)); } } }),
  });
  t.after(async () => {
    await h?.controller.dispose(); await runtime.shutdown();
    assert.equal(path.dirname(directory), root); fs.rmSync(directory, { recursive: true, force: true });
  });
  const owner = { id: 77 };
  const invoke = (name, value) => handlers.get(`voice:${name}`)({ sender: owner }, value);
  await runtime.initialize();
  h = createHarness({ controllerApi: {
    getRuntimeInfo: async () => runtime.runtimeInfo(), startRecognition: async options => invoke('speech-start', options),
    sendAudio: value => invoke('speech-audio', value), cancelRecognition: async id => invoke('speech-cancel', id),
    finishRecognition: async id => invoke('speech-finish', id),
  } });
  await h.controller.initialize(); await h.controller.begin();
  // Synthetic PCM at normal 48 kHz/worklet chunk size crosses ten seconds of capture.
  for (let sequence = 0; sequence < 235; sequence++) h.captures[0].callbacks.onChunk({
    sequence, sampleRate: 48000, samples: new Float32Array(2048).fill(0.1),
  });
  await Promise.all(deliveries);
  assert.equal(h.voiceStore.status, 'error');
  assert.match(h.voiceStore.statusText, /ten seconds.*shorter request/i);
  assert.equal(h.captureCancellations.length, 1);
  assert.equal(runtime.isAudioCaptureAuthorized(owner), false);
  assert.equal(engine.getInfo().activeSessionId, null);
  assert.equal(uploads, 0); assert.deepEqual(h.sentCommands, []);
  assert.equal(await h.controller.begin(), true, 'the user can start a fresh request after the error');
  await h.controller.cancel('user');
});

test('cloud proposals cannot fall back to offline parsing or dispatch after context/cancellation changes', async t => {
  for (const failure of ['invalid', 'extra', 'transcript-only', 'mode', 'profile', 'contract', 'cancel', 'disable', 'disconnect']) {
    const h = createHarness({ runtimeInfo: cloudRuntime }); t.after(() => h.controller.dispose());
    await h.controller.initialize(); await h.controller.begin(); await h.controller.finish();
    let event = cloudFinal();
    if (failure === 'invalid') event.intent.input = { value: 900 };
    if (failure === 'extra') event.intent = { ...headingIntent, rawRecipe: 'execute' };
    if (failure === 'transcript-only') event = { ...event, intent: undefined, text: 'set heading two seven zero' };
    if (failure === 'mode') event.mode = 'offline';
    if (failure === 'profile') h.aircraftControlsStore.aircraftCommandCatalogue.profileRevision++;
    if (failure === 'contract') h.aircraftControlsStore.aircraftCommandCatalogue.commands['flightGuidance.heading.set'].input.max = 180;
    if (failure === 'cancel') await h.controller.cancel();
    if (failure === 'disable') await h.voiceStore.actions.setRecognitionEnabled(false);
    if (failure === 'disconnect') h.controller.handleSimulatorStateChange({ blocked: true });
    await h.emitRecognition(event);
    assert.deepEqual(h.sentCommands, [], failure);
    assert.deepEqual(h.spokenReadbacks, [], failure);
  }
});

test('cloud questions and clarification never write or manufacture a state answer', async t => {
  for (const intent of [
    { decision: 'clarify', reason: 'unclear' }, { decision: 'no-action', reason: 'multiple-requests' },
    { decision: 'query', query: 'what is my flight plan' },
  ]) {
    let supplied;
    const h = createHarness({ runtimeInfo: cloudRuntime, startRecognition: async options => {
      supplied = options; return { sessionId: 'session_12345678' };
    } });
    t.after(() => h.controller.dispose()); await h.controller.initialize(); await h.controller.begin(); await h.controller.finish();
    if (intent.decision === 'query') intent.query = supplied.context.queries.find(q => /flight plan/.test(q)) || supplied.context.queries[0];
    await h.emitRecognition(cloudFinal(intent));
    assert.deepEqual(h.sentCommands, []);
    if (intent.decision === 'query') assert.match(h.voiceStore.statusText, /plan|SimBrief/i);
    else assert.equal(h.voiceStore.status, 'unmatched');
  }
});

test('both cloud providers answer aircraft questions from current local telemetry only', async t => {
  for (const providerId of ['openai', 'gemini']) for (const condition of ['fresh', 'stale', 'unknown', 'disconnected', 'profile-changed']) {
    const now = Date.now();
    const state = { activeProfileKey: 'bundled/msfs/fbw-a32nx', activeProfileRevision: 2, sourceStatus: 'connected',
      values: { 'controls.spoilersArmed': true }, receivedAt: now, updatedAt: new Date(now).toISOString(),
      valueUpdatedAt: { 'controls.spoilersArmed': new Date(now).toISOString() } };
    const selection = { providerId, modelId: providerId === 'openai' ? 'gpt-realtime-2.1-mini' : 'gemini-3.8-flash', revision: 0 };
    const h = createHarness({ runtimeInfo: { ...cloudRuntime, cloud: { ...cloudRuntime.cloud, ...selection } },
      aircraftSpecificStore: state, availability: { enabled: false, reason: 'Read only' },
      catalogue: { profileKey: state.activeProfileKey, profileRevision: 2, configurationId: 'fbw-a32nx', commands: {} } });
    t.after(() => h.controller.dispose());
    await h.controller.initialize();
    assert.equal(await h.controller.begin(), true);
    await h.controller.finish();
    // Telemetry can change while a provider interprets the clip. The answer
    // must use the current sample, never a snapshot or a provider's prose.
    if (condition === 'stale') state.valueUpdatedAt['controls.spoilersArmed'] = new Date(now - 5000).toISOString();
    if (condition === 'unknown') state.values['controls.spoilersArmed'] = null;
    if (condition === 'disconnected') state.sourceStatus = 'disconnected';
    if (condition === 'profile-changed') state.activeProfileRevision++;
    await h.emitRecognition({ ...cloudFinal({ decision: 'query', query: 'are spoilers armed' }), selection });
    assert.deepEqual(h.sentCommands, [], `${providerId}/${condition}`);
    assert.equal(h.voiceStore.status, condition === 'fresh' ? 'sent' : 'error', `${providerId}/${condition}`);
    if (condition === 'fresh') assert.deepEqual(h.spokenReadbacks, ['Ground spoilers armed.']);
    else assert.equal(h.spokenReadbacks.some(text => text.includes('Ground spoilers armed')), false);
  }
});

test('cloud setup test checks an interpreted heading without aircraft access and clears on mode switch', async t => {
  const h = createHarness({ runtimeInfo: cloudRuntime, availability: { enabled: false } });
  t.after(() => h.controller.dispose()); await h.controller.initialize();
  await h.voiceStore.actions.startVoiceTest(); await h.voiceStore.actions.finishVoiceTest();
  await h.emitRecognition(cloudFinal()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.voiceStore.voiceTest.recognized, true);
  assert.equal(h.voiceStore.voiceTest.interpreted, true);
  assert.deepEqual(h.sentCommands, []);
  h.emitRuntime({ ...cloudRuntime, mode: 'offline' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.voiceStore.voiceTest.phase, 'idle');
});

test('Gemini proposals share command dispatch and cannot survive provider/model/key changes', async t => {
  const selection = { providerId: 'gemini', modelId: 'gemini-3.8-flash', revision: 1 };
  for (const scenario of ['valid', 'provider-changed', 'model-changed', 'key-changed', 'wrong-provider-result', 'runtime-switch']) {
    const runtimeInfo = { ...cloudRuntime, cloud: { ...cloudRuntime.cloud, ...selection } };
    const h = createHarness({ runtimeInfo }); t.after(() => h.controller.dispose());
    await h.controller.initialize(); await h.controller.begin(); await h.controller.finish();
    const final = { ...cloudFinal(), selection };
    if (scenario === 'provider-changed') h.voiceStore.runtime.cloud = { ...runtimeInfo.cloud, providerId: 'openai' };
    if (scenario === 'model-changed') h.voiceStore.runtime.cloud = { ...runtimeInfo.cloud, modelId: 'new-model' };
    if (scenario === 'key-changed') h.voiceStore.runtime.cloud = { ...runtimeInfo.cloud, revision: 2 };
    if (scenario === 'wrong-provider-result') final.selection = cloudFinal().selection;
    if (scenario === 'runtime-switch') {
      h.emitRuntime({ ...runtimeInfo, cloud: { ...runtimeInfo.cloud, revision: 2 } });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.cancellations.length, 1);
    }
    await h.emitRecognition(final);
    assert.equal(h.sentCommands.length, scenario === 'valid' ? 1 : 0, scenario);
  }
});

test('cloud settings actions keep the selected provider attached to key writes and retire setup tests', async t => {
  const calls = [];
  const info = { ...cloudRuntime, cloud: { ...cloudRuntime.cloud, providerId: 'gemini', modelId: 'gemini-3.8-flash', revision: 1 } };
  const h = createHarness({ runtimeInfo: cloudRuntime, controllerApi: {
    setCloudProvider: async selection => { calls.push(['provider', selection]); return info; },
    saveCloudKey: async (id, key) => { calls.push(['key', id, key.length]); return info; },
    removeCloudKey: async id => { calls.push(['remove', id]); return info; },
  } });
  t.after(() => h.controller.dispose()); await h.controller.initialize(); await h.voiceStore.actions.startVoiceTest();
  await h.voiceStore.actions.setCloudProvider({ providerId: 'gemini' });
  await h.emitRecognition(cloudFinal());
  await h.voiceStore.actions.saveCloudKey('gemini', 'synthetic');
  await h.voiceStore.actions.removeCloudKey('gemini');
  assert.deepEqual(calls, [['provider', { providerId: 'gemini' }], ['key', 'gemini', 9], ['remove', 'gemini']]);
  assert.equal(h.voiceStore.voiceTest.phase, 'idle');
  assert.deepEqual(h.sentCommands, []);
});

test('Settings voice test works in a release without an aircraft and cannot dispatch after reconnect', async () => {
  const h = createHarness({ availability: { enabled: false, reason: 'MSFS is not connected.' } });
  await h.controller.initialize();
  assert.equal(h.voiceStore.runtime.development, false);
  assert.equal(h.voiceStore.status, 'blocked');
  assert.equal(await h.voiceStore.actions.startVoiceTest(), true);
  assert.equal(await h.controller.begin(), false, 'normal PTT cannot overlap a test');
  h.emitPtt({ type: 'up' });
  assert.equal(h.voiceStore.voiceTest.phase, 'listening', 'a global key release cannot finish a Settings test');
  h.aircraftControlsStore.availability.enabled = true;
  h.controller.handleAircraftContextChange();
  h.controller.handleSimulatorStateChange({ blocked: true });
  assert.equal(h.voiceStore.voiceTest.phase, 'listening');
  h.captures[0].callbacks.onChunk({ sampleRate: 48000, samples: new Float32Array([0.2, -0.2]), sequence: 0 });
  await h.voiceStore.actions.finishVoiceTest();
  await h.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'set heading two seven zero' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.voiceStore.voiceTest.recognized, true);
  assert.deepEqual(h.sentCommands, []);
  assert.deepEqual(h.spokenReadbacks, []);
  assert.equal(await h.controller.begin(), true, 'ordinary PTT recovers after testing');
  await h.controller.finish();
  await h.emitRecognition({ type: 'final', sessionId: 'session_next_2', text: 'set heading two seven zero' });
  assert.equal(h.sentCommands.length, 1, 'ordinary PTT still dispatches through its normal guards');
  await h.controller.dispose();
});

test('voice test cannot replace normal capture or a pending aircraft command', async () => {
  const h = createHarness(); await h.controller.initialize();
  await h.controller.begin();
  assert.equal(await h.voiceStore.actions.startVoiceTest(), false);
  await h.controller.finish();
  await h.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'set heading two seven zero' });
  assert.equal(await h.voiceStore.actions.startVoiceTest(), false);
  h.completeLastCommand({ ok: true });
  assert.equal(await h.voiceStore.actions.startVoiceTest(), true);
  await h.controller.dispose();
  assert.equal(h.voiceStore.voiceTest.phase, 'idle');
});

test('controller disconnect cancels capture and ignores late commands', async () => {
  const h = createHarness(); await h.controller.initialize();
  await h.controller.begin();
  h.emitPtt({ type: 'cancel', reason: 'device-removed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.captureCancellations.length, 1);
  assert.equal(h.captureStops.length, 0, 'cancellation must not finish or flush an utterance');
  await h.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'set heading two seven zero' });
  assert.equal(h.sentCommands.length, 0);
  assert.deepEqual(h.cancellations, ['session_12345678']);
  await h.controller.dispose();
});

test('cancelling controller setup before audio cleanup finishes cannot start it later', async t => {
  const calls = [];
  const info = { available: true, enabled: true, pushToTalk: { controllerEnabled: true } };
  const h = createHarness({ runtimeInfo: info, controllerApi: {
    startControllerSetup: async () => { calls.push('start'); return info; },
    cancelControllerSetup: async () => { calls.push('cancel'); return info; },
  } });
  t.after(() => h.controller.dispose());
  await h.controller.initialize();
  await h.controller.begin();
  let releaseCleanup;
  h.captures[0].cancel = () => new Promise(resolve => { releaseCleanup = resolve; });
  const starting = h.voiceStore.actions.startControllerSetup();
  await new Promise(resolve => setImmediate(resolve));
  await h.voiceStore.actions.cancelControllerSetup();
  releaseCleanup();
  assert.equal(await starting, false);
  assert.deepEqual(calls, ['cancel'], 'a superseded request never starts native setup');
});

test('controller cancellation retires a pending recognition start before microphone access', async () => {
  let acknowledge;
  const h = createHarness({ startRecognition: () => new Promise(resolve => { acknowledge = resolve; }) });
  await h.controller.initialize();
  const start = h.controller.begin();
  await new Promise(resolve => setImmediate(resolve));
  h.emitPtt({ type: 'cancel', reason: 'device-removed' });
  acknowledge({ sessionId: 'session_12345678' }); await start;
  assert.equal(h.captures.length, 0);
  assert.deepEqual(h.cancellations, ['session_12345678']);
  assert.equal(h.sentCommands.length, 0);
  await h.controller.dispose();
});

test('controller loss during the release tail cancels instead of flushing speech', async () => {
  const h = createHarness({ releaseTailMs: 30 }); await h.controller.initialize();
  await h.controller.begin(); const finishing = h.controller.finish();
  h.emitPtt({ type: 'cancel', reason: 'device-removed' });
  await finishing; await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.captureStops.length, 0); assert.equal(h.captureCancellations.length, 1);
  await h.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'set heading two seven zero' });
  assert.equal(h.sentCommands.length, 0);
  await h.controller.dispose();
});

test('controller cancellation during final-result cleanup prevents command dispatch', async t => {
  const h = createHarness(); t.after(() => h.controller.dispose());
  await h.controller.initialize(); await h.controller.begin(); await h.controller.finish();
  let releaseCleanup;
  const cleanup = new Promise(resolve => { releaseCleanup = resolve; });
  h.captures[0].cancel = () => cleanup;
  const final = h.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'set heading two seven zero' });
  h.emitPtt({ type: 'cancel', reason: 'device-removed' });
  releaseCleanup(); await final;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.sentCommands, [], 'a cancelled final result must not execute after cleanup');
});

test('a release after an unsolicited final cannot authorize that final', async t => {
  const h = createHarness(); t.after(() => h.controller.dispose());
  await h.controller.initialize(); await h.voiceStore.actions.begin();
  let releaseCleanup;
  const cleanup = new Promise(resolve => { releaseCleanup = resolve; });
  h.captures[0].cancel = () => cleanup;
  const final = h.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'set heading two seven zero' });
  await h.voiceStore.actions.finish();
  releaseCleanup(); await final;
  assert.deepEqual(h.sentCommands, [], 'release must precede recognition completion');
  assert.match(h.voiceStore.statusText, /before push-to-talk was released/);
});

test('an old flush failure cannot cancel the next push-to-talk attempt', async t => {
  const h = createHarness(); t.after(() => h.controller.dispose());
  await h.controller.initialize(); await h.controller.begin();
  let failFlush;
  h.captures[0].stop = () => new Promise((_resolve, reject) => { failFlush = reject; });
  const finishing = h.controller.finish();
  await h.controller.cancel('device-removed');
  assert.equal(await h.controller.begin(), true);
  failFlush(new Error('Old capture stopped'));
  assert.equal(await finishing, false);
  assert.equal(h.voiceStore.activeSessionId, 'session_next_2');
  assert.equal(h.voiceStore.status, 'listening');
  assert.deepEqual(h.cancellations, ['session_12345678']);
});

test('old cancellation cleanup cannot hide the next active microphone', async t => {
  const h = createHarness(); t.after(() => h.controller.dispose());
  await h.controller.initialize(); await h.controller.begin();
  let releaseCleanup;
  const cleanup = new Promise(resolve => { releaseCleanup = resolve; });
  h.captures[0].cancel = () => cleanup;
  const cancelled = h.controller.cancel('device-removed');
  assert.equal(await h.controller.begin(), true);
  releaseCleanup(); await cancelled;
  assert.equal(h.voiceStore.status, 'listening');
  assert.equal(h.voiceStore.activeSessionId, 'session_next_2');
});

test('a global button tap cannot release an on-screen push-to-talk hold', async t => {
  const h = createHarness(); t.after(() => h.controller.dispose());
  await h.controller.initialize(); await h.voiceStore.actions.begin();
  h.emitPtt({ type: 'down' }); h.emitPtt({ type: 'up' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.voiceStore.status, 'listening');
  assert.equal(h.captureStops.length, 0);
  await h.voiceStore.actions.finish();
  assert.equal(h.captureStops.length, 1, 'the owning on-screen release still completes its utterance');
});

test('stale on-screen release and blur cannot retire a global push-to-talk hold', async t => {
  const h = createHarness(); t.after(() => h.controller.dispose());
  await h.controller.initialize(); h.emitPtt({ type: 'down' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.voiceStore.status, 'listening');
  assert.equal(await h.voiceStore.actions.finish(), false);
  assert.equal(await h.voiceStore.actions.cancel(), false);
  assert.equal(h.voiceStore.status, 'listening');
  assert.equal(h.captureStops.length, 0);
  h.emitPtt({ type: 'up' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.captureStops.length, 1, 'the owning global release still completes its utterance');
});

test('disabling voice cancels the Settings test and ignores its late transcript', async () => {
  const h = createHarness(); await h.controller.initialize();
  await h.voiceStore.actions.startVoiceTest();
  await h.controller.setRecognitionEnabled(false);
  await h.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'set heading two seven zero' });
  assert.equal(h.voiceStore.voiceTest.phase, 'idle');
  assert.equal(h.voiceStore.runtime.enabled, false);
  assert.deepEqual(h.sentCommands, []);
  assert.equal(h.captureCancellations.length, 1);
  await h.controller.dispose();
});

test('spoken-feedback diagnostics remain usable while recognition is off across runtime updates', async () => {
  const h = createHarness({ runtimeInfo: { enabled: false, available: false } });
  await h.controller.initialize();
  assert.equal(await h.voiceStore.actions.testSpokenFeedback(), true);
  const cancellations = h.readbackCancellations.length;
  h.emitRuntime({ enabled: false, available: false });
  assert.equal(h.readbackCancellations.length, cancellations, 'readback runtime updates must not cancel their own test');
  assert.match(h.voiceStore.voiceTest.feedbackMessage, /Playing/);
  assert.deepEqual(h.spokenReadbacks, ['Spoken feedback is working.']);
  assert.equal(h.voiceStore.runtime.enabled, false);
  await h.controller.dispose();
});

test('ordinary PTT retires test output ownership before its own command readback', async () => {
  const h = createHarness(); await h.controller.initialize();
  await h.voiceStore.actions.testSpokenFeedback();
  await h.controller.begin(); await h.controller.finish();
  await h.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'set heading 270' });
  h.completeLastCommand({ ok: true });
  const cancellations = h.readbackCancellations.length;
  await h.voiceStore.actions.cancelVoiceTest();
  assert.equal(h.readbackCancellations.length, cancellations, 'leaving Settings cannot cancel a normal command readback');
  await h.controller.dispose();
});

test('voice and page COM swap requests share pending state and cannot overlap in either direction', async () => {
  setActivePinia(createPinia());
  const controls = useAircraftControlsStore(), sent = [];
  const command = { id: 'radios.com1.swap', label: 'Swap COM 1', input: { kind: 'none' },
    speech: { patterns: ['swap com one'] } };
  const catalogue = { profileKey: 'bundled/msfs/fbw-a32nx', profileRevision: 1,
    configurationId: 'fbw-a32nx', commands: [command] };
  const aircraftControl = createAircraftControlController({
    WebSocketRef: { OPEN: 1 }, getWs: () => ({ readyState: 1 }), getWsSend: () => message => sent.push(message),
    getAuthorizationScope: () => 'full-control', getSimconnectConnected: () => true,
    aircraftControlsStore: controls,
  });
  aircraftControl.setActiveProfileToken({ _profileKey: catalogue.profileKey, profileRevision: 1 });
  aircraftControl.applyControlCapabilities({ aircraftCommands: catalogue });
  aircraftControl.updateAvailability();
  const h = createHarness({ aircraftControlsStore: controls, aircraftControl });
  const speakSwap = async () => {
    assert.equal(await h.controller.begin(), true);
    const sessionId = h.voiceStore.activeSessionId;
    await h.controller.finish();
    await h.emitRecognition({ type: 'final', sessionId, text: 'swap com one' });
  };
  const pendingKey = 'aircraft-command:radios.com1.swap';
  try {
    await h.controller.initialize();
    await speakSwap();
    assert.equal(sent.length, 1);
    assert.equal(aircraftControl.sendCommand(command.id), false, 'a page click cannot send a second swap');
    assert.equal(controls.isCommandPending(pendingKey), true, 'the page must show the voice swap as pending');
    aircraftControl.handleResult({ requestId: sent[0].requestId, commandId: command.id, ok: true, code: 'executed',
      radio: { index: 1, bank: 'active', frequencyMhz: 123.45 } });
    assert.equal(controls.isCommandPending(pendingKey), false);
    assert.match(h.spokenReadbacks.at(-1), /confirmed/i, 'voice still owns its correlated result');
    assert.equal(aircraftControl.sendCommand(command.id), true);
    await speakSwap();
    assert.equal(sent.length, 2, 'voice cannot send another swap while a page request is pending');
    aircraftControl.handleResult({ requestId: sent[1].requestId, commandId: command.id, ok: false, error: 'Swap rejected' });
    assert.equal(controls.isCommandPending(pendingKey), false, 'a failure releases the shared pending state');
  } finally {
    await h.controller.dispose();
    aircraftControl.clearPendingRequests();
  }
});

test('generic flap buttons and voice cannot send overlapping relative adjustments', async () => {
  setActivePinia(createPinia());
  const controls = useAircraftControlsStore(), sent = [], timers = [];
  const command = { id: 'surfaces.flaps.adjust', label: 'Adjust flaps', input: { kind: 'enum', values: ['increase', 'decrease'] },
    speech: { patterns: ['flaps {value}'] } };
  const catalogue = { profileKey: 'bundled/msfs/generic', profileRevision: 1, configurationId: 'generic', commands: [command] };
  const aircraftControl = createAircraftControlController({
    WebSocketRef: { OPEN: 1 }, getWs: () => ({ readyState: 1 }), getWsSend: () => message => sent.push(message),
    getAuthorizationScope: () => 'full-control', getSimconnectConnected: () => true, aircraftControlsStore: controls,
    now: () => 1000,
    setTimeoutRef: callback => { const timer = { callback }; timers.push(timer); return timer; },
    clearTimeoutRef: timer => { timer.cancelled = true; },
  });
  aircraftControl.setActiveProfileToken({ _profileKey: catalogue.profileKey, profileRevision: 1 });
  aircraftControl.applyControlCapabilities({ aircraftCommands: catalogue });
  const panel = createAutopilotPanel({ aircraftControl, aircraftControlsStore: controls, getCurrentState: () => ({}) });
  panel.bindControls();
  const h = createHarness({ aircraftControlsStore: controls, aircraftControl });
  const button = { type: 'control', id: 'flapsIncrease' };
  const speak = async () => {
    assert.equal(await h.controller.begin(), true);
    const sessionId = h.voiceStore.activeSessionId;
    await h.controller.finish();
    await h.emitRecognition({ type: 'final', sessionId, text: 'flaps increase' });
  };
  try {
    await h.controller.initialize();
    await speak();
    assert.equal(await controls.requestControlCommand(button), false, 'a page click cannot add another flap detent');
    assert.equal(controls.isCommandPending(button), true, 'the generic flap button shows the voice request as pending');
    aircraftControl.handleResult({ requestId: sent[0].requestId, commandId: command.id, ok: true, code: 'executed' });
    assert.equal(controls.isCommandPending(button), false);
    assert.equal(controls.feedback.actionText, 'Flap command sent. Check the cockpit.');
    assert.deepEqual(h.spokenReadbacks, [controls.feedback.actionText], 'buttons and voice share the same delivery-only result');
    assert.equal(await controls.requestControlCommand(button), true);
    await speak();
    assert.equal(sent.length, 2, 'voice cannot add a flap detent while the page request is pending');
    aircraftControl.handleResult({ requestId: sent[1].requestId, commandId: command.id, ok: false, error: 'Rejected' });
    assert.equal(controls.isCommandPending(button), false);
    assert.equal(controls.isCommandPending(`aircraft-command:${command.id}`), false);
    const options = { pendingKey: 'panel:flaps', minimumPendingMs: 350 };
    assert.equal(aircraftControl.sendCommand(command.id, { value: 'increase' }, options), true);
    aircraftControl.handleResult({ requestId: sent.at(-1).requestId, commandId: command.id, ok: true, code: 'executed' });
    assert.equal(aircraftControl.sendCommand(command.id, { value: 'increase' }), false, 'the shared command remains pending during the panel cooldown');
    aircraftControl.clearPendingRequests('Connection lost.');
    assert.deepEqual(controls.pendingCommands, {}, 'disconnect clears every pending key owned by the request');
    assert.ok(timers.every(timer => timer.cancelled));
    assert.equal(aircraftControl.sendCommand(command.id, { value: 'increase' }, options), true);
    for (const timer of timers) timer.callback();
    assert.equal(controls.isCommandPending('panel:flaps'), true, 'old cooldowns cannot release a new panel request');
    assert.equal(controls.isCommandPending(`aircraft-command:${command.id}`), true, 'old cooldowns cannot release its canonical key');
  } finally { await h.controller.dispose(); aircraftControl.clearPendingRequests(); }
});

test('state queries speak fresh observations while writes are unavailable and never call sendCommand', async () => {
  for (const stale of [false, true]) {
    const now = Date.now();
    const state = { activeProfileKey: 'bundled/msfs/fbw-a32nx', activeProfileRevision: 2, sourceStatus: 'connected',
      values: { 'controls.spoilersArmed': true }, unavailable: [], updatedAt: new Date(now).toISOString(), receivedAt: now,
      valueUpdatedAt: { 'controls.spoilersArmed': new Date(now - (stale ? 60000 : 0)).toISOString() } };
    const h = createHarness({ aircraftSpecificStore: state, availability: { enabled: false, reason: 'Read only' },
      catalogue: { profileKey: state.activeProfileKey, profileRevision: 2, configurationId: 'fbw-a32nx', commands: {} } });
    await h.controller.initialize(); assert.equal(await h.controller.begin(), true);
    await h.controller.finish();
    h.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'are spoilers armed' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.sentCommands.length, 0);
    assert.equal(h.voiceStore.status, stale ? 'error' : 'sent');
    assert.match(h.spokenReadbacks[0], stale ? /unavailable/ : /Ground spoilers armed/);
    await h.controller.dispose();
  }
});

test('read-only queries work before a control catalogue and reject profile or data loss during capture', async () => {
  for (const change of ['none', 'profile', 'disconnected', 'missing-field']) {
    const now = Date.now();
    const state = { activeProfileKey: 'bundled/msfs/fbw-a32nx', activeProfileRevision: 2, sourceStatus: 'connected',
      values: { 'controls.spoilersArmed': false }, unavailable: [], updatedAt: new Date(now).toISOString(), receivedAt: now,
      valueUpdatedAt: { 'controls.spoilersArmed': new Date(now).toISOString() } };
    const h = createHarness({ aircraftSpecificStore: state, availability: { enabled: false, reason: 'Read only' },
      catalogue: { profileKey: '', profileRevision: null, configurationId: '', commands: {} } });
    await h.controller.initialize(); assert.equal(await h.controller.begin(), true);
    await h.controller.finish();
    if (change === 'profile') state.activeProfileRevision++;
    if (change === 'disconnected') state.sourceStatus = 'disconnected';
    if (change === 'missing-field') state.valueUpdatedAt = {};
    await h.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'are spoilers armed' });
    assert.equal(h.sentCommands.length, 0);
    assert.equal(h.voiceStore.status, change === 'none' ? 'sent' : 'error');
    assert.equal(h.spokenReadbacks.includes('Ground spoilers disarmed.'), change === 'none');
    await h.controller.dispose();
  }
});

test('SimBrief flight plan questions read the loaded OFP on any voice-ready aircraft without dispatching controls', async () => {
  const plan = { origin: 'YSSY', departureRunway: '34L', destination: 'WSSS', arrivalRunway: '02C', cruiseAltFl: 'FL360',
    procedures: { sid: 'DEEZ5', sidTransition: 'KADAL', star: 'ARAM1A', starTransition: null } };
  const cases = [
    [plan, 'what is the simbrief flight plan', 'sent',
      'Departure YSSY, runway 34L, SID DEEZ5, transition KADAL. Planned altitude FL360. Arrival WSSS, runway 02C, STAR ARAM1A, no transition.',
      'Departure Y S S Y, runway three four left, SID D E E Z five, transition K A D A L. Planned altitude flight level three six zero. Arrival W S S S, runway zero two center, STAR A R A M one A, no transition.'],
    [plan, "what's my departure", 'sent', 'Departure YSSY, runway 34L, SID DEEZ5, transition KADAL.',
      'Departure Y S S Y, runway three four left, SID D E E Z five, transition K A D A L.'],
    [null, 'what is the arrival', 'error', 'No SimBrief flight plan loaded. Fetch an OFP on the SimBrief tab first.',
      'No SimBrief flight plan loaded. Fetch an OFP on the SimBrief tab first.'],
  ];
  // A generic command catalogue with no state queries still answers, as does a query-only aircraft.
  for (const [current, phrase, status, text, spoken] of cases) for (const queryOnly of [false, true]) {
    const now = Date.now();
    const state = queryOnly ? { activeProfileKey: 'bundled/msfs/fbw-a32nx', activeProfileRevision: 2, sourceStatus: 'connected',
      values: {}, unavailable: [], updatedAt: new Date(now).toISOString(), receivedAt: now, valueUpdatedAt: {} } : undefined;
    const h = createHarness({ simbriefStore: { plan: current }, aircraftSpecificStore: state,
      ...(queryOnly ? { availability: { enabled: false, reason: 'Read only' },
        catalogue: { profileKey: state.activeProfileKey, profileRevision: 2, configurationId: 'fbw-a32nx', commands: {} } } : {}) });
    await h.controller.initialize(); assert.equal(await h.controller.begin(), true);
    assert.ok(h.controller.collectHints().includes('WHAT IS THE SIMBRIEF FLIGHT PLAN'));
    await h.controller.finish();
    await h.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: phrase });
    assert.equal(h.sentCommands.length, 0, phrase);
    assert.equal(h.voiceStore.status, status, phrase);
    assert.equal(h.voiceStore.statusText, text, phrase);
    assert.equal(h.spokenReadbacks[0], spoken, phrase);
    assert.match(h.voiceStore.lastCommand, /^Read flight plan: flightPlan/);
    await h.controller.dispose();
  }
});

test('new altimeter and Fenix state questions speak observations without dispatching controls', async () => {
  const cases = [
    ['fbw-a32nx', 'what is captain q n h', { 'baro.captain.mode': 1, 'baro.captain.valueMode': 1,
      'baro.captain.value': 1016, 'flightGuidance.baroUnitCaptain': false }, true, 'Captain Q N H one zero one six hectopascals.'],
    ['fenix-a320', 'what is first officer qnh', { 'baro.firstOfficer.qnh': true,
      'flightGuidance.baroUnitFirstOfficer': 'inhg', 'baro.firstOfficer.inhg': 29.90 }, true, 'First officer Q N H two nine decimal nine zero inches of mercury.'],
    ['fenix-a320', 'are both altimeters on std', { 'baro.captain.qnh': false, 'baro.firstOfficer.qnh': false }, true, 'Yes. Both altimeters standard pressure.'],
    ['fenix-a320', 'are both altimeters on std', { 'baro.captain.qnh': false }, false, 'Captain standard pressure. First officer altimeter data unavailable.'],
    ['fenix-a320', 'are spoilers armed', { 'controls.speedbrakePosition': 0 }, true, 'Ground spoilers armed.'],
    ['fenix-a320', 'what is autobrake', { 'controls.autobrake.low': false, 'controls.autobrake.medium': true,
      'controls.autobrake.max': false }, true, 'Autobrake medium.'],
  ];
  for (const [profile, phrase, readings, ok, expected] of cases) for (const enabled of [false, true]) {
    const now = Date.now(), values = { 'baro.healthy': true, ...readings };
    const state = { activeProfileKey: `bundled/msfs/${profile}`, activeProfileRevision: 2, sourceStatus: 'connected', values,
      unavailable: [], updatedAt: new Date(now).toISOString(), receivedAt: now,
      valueUpdatedAt: Object.fromEntries(Object.keys(values).map(id => [id, new Date(now).toISOString()])) };
    const h = createHarness({ aircraftSpecificStore: state, availability: { enabled, reason: 'Test access' },
      catalogue: { profileKey: state.activeProfileKey, profileRevision: 2, configurationId: profile, commands: {} } });
    await h.controller.initialize(); assert.equal(await h.controller.begin(), true);
    assert.ok(h.controller.collectHints().includes('WHAT IS CAPTAIN QNH'));
    await h.controller.finish();
    await h.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: phrase });
    assert.equal(h.sentCommands.length, 0, phrase);
    assert.equal(h.voiceStore.status, ok ? 'sent' : 'error', phrase);
    assert.equal(h.spokenReadbacks[0], expected, phrase);
    assert.equal(h.voiceStore.statusText, expected, phrase);
    await h.controller.dispose();
  }
});

test('voice preferences select a microphone and persist local spoken feedback safely', async () => {
  const values = new Map([
    ['flight-fabric.voice-capture-preferences.v1', JSON.stringify({
      audioProcessing: true,
      deviceId: 'stored-mic',
      spokenReadbacks: false,
    })],
  ]);
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  const mediaDevices = {
    enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'stored-mic', label: 'Cockpit headset' },
      { kind: 'videoinput', deviceId: 'camera', label: 'Camera' },
    ],
  };
  const harness = createHarness({ globalRef: { localStorage, navigator: { mediaDevices } } });

  await harness.controller.initialize();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.voiceStore.inputDevices, [
    { deviceId: 'stored-mic', label: 'Cockpit headset' },
  ]);
  assert.equal(await harness.controller.begin(), true);
  assert.equal(harness.captures[0].callbacks.deviceId, 'stored-mic');
  assert.equal('audioProcessing' in harness.captures[0].callbacks, false);
  assert.equal(harness.voiceStore.spokenReadbacks, false);
  await harness.controller.cancel('user');

  harness.controller.setInputDevice('new-mic');
  harness.controller.setSpokenReadbacks(true);
  assert.deepEqual(JSON.parse(values.get('flight-fabric.voice-capture-preferences.v1')), {
    deviceId: 'new-mic',
    spokenReadbacks: true,
  });
});

test('disabled voice control does not enumerate or capture microphones until explicit opt-in', async () => {
  let enumerations = 0;
  let discoveryTrackStops = 0;
  const mediaDevices = {
    addEventListener() {},
    removeEventListener() {},
    async getUserMedia() {
      return { getTracks: () => [{ stop: () => { discoveryTrackStops += 1; } }] };
    },
    async enumerateDevices() {
      enumerations += 1;
      return [{ kind: 'audioinput', deviceId: 'test-mic', label: 'Test microphone' }];
    },
  };
  const harness = createHarness({
    globalRef: { navigator: { mediaDevices } },
    runtimeInfo: {
      available: false,
      development: false,
      enabled: false,
      engine: { modelId: 'zipformer' },
      pushToTalk: { accelerator: '', error: '', registered: false },
    },
  });

  await harness.controller.initialize();
  assert.equal(harness.voiceStore.status, 'disabled');
  assert.equal(enumerations, 0);
  assert.deepEqual(await harness.controller.refreshInputDevices(), []);
  assert.equal(enumerations, 0);
  assert.equal(await harness.controller.begin(), false);
  assert.equal(harness.captures.length, 0);

  assert.equal(await harness.controller.setRecognitionEnabled(true), true);
  assert.equal(enumerations, 1);
  assert.equal(discoveryTrackStops, 1, 'explicit opt-in must close the short device-discovery stream');
  assert.deepEqual(harness.voiceStore.inputDevices, [
    { deviceId: 'test-mic', label: 'Test microphone' },
  ]);
  assert.equal(await harness.controller.begin(), true);
  assert.equal(harness.captures.length, 1);

  assert.equal(await harness.controller.setRecognitionEnabled(false), true);
  assert.equal(harness.captureCancellations.length, 1, 'disabling voice must stop renderer capture');
  assert.deepEqual(harness.voiceStore.inputDevices, []);
  assert.equal(harness.voiceStore.status, 'disabled');
  assert.equal(await harness.controller.begin(), false);
});

test('microphone discovery errors survive readiness refresh and clear after a successful retry', async () => {
  let denied = true;
  let trackStops = 0;
  const harness = createHarness({
    availability: { enabled: false, reason: 'MSFS is disconnected.' },
    runtimeInfo: { available: false, enabled: false },
    globalRef: { navigator: { mediaDevices: {
      async getUserMedia() {
        if (denied) throw new Error('Microphone access denied.');
        return { getTracks: () => [{ stop: () => { trackStops += 1; } }] };
      },
      async enumerateDevices() { return [{ kind: 'audioinput', deviceId: 'mic', label: 'Headset' }]; },
    } } },
  });
  await harness.controller.initialize();
  assert.equal(await harness.controller.setRecognitionEnabled(true), true);
  assert.equal(harness.voiceStore.status, 'blocked', 'simulator readiness is separate from microphone setup');
  assert.equal(harness.voiceStore.inputDevicesError, 'Microphone access denied.');
  assert.equal(harness.captures.length, 0);
  assert.equal(harness.cancellations.length, 1, 'failed discovery releases its native session');
  denied = false;
  await harness.controller.refreshInputDevices({ requestAccess: true });
  assert.equal(harness.voiceStore.inputDevicesError, '');
  assert.equal(harness.voiceStore.inputDevices[0].label, 'Headset');
  assert.equal(trackStops, 1);
  denied = true;
  await harness.controller.refreshInputDevices({ requestAccess: true });
  assert.equal(harness.voiceStore.inputDevicesError, 'Microphone access denied.');
  await harness.controller.setRecognitionEnabled(false);
  assert.equal(harness.voiceStore.inputDevicesError, '', 'disabling clears obsolete setup failures');
  await harness.controller.dispose();
});

test('microphone discovery failure preserves a held aircraft result', async () => {
  const harness = createHarness({ globalRef: { navigator: { mediaDevices: {
    async getUserMedia() { throw new Error('Microphone access denied.'); },
    async enumerateDevices() { return []; },
  } } } });
  await harness.controller.initialize();
  await harness.controller.begin();
  await harness.controller.finish();
  await harness.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero' });
  harness.completeLastCommand({ ok: false, error: 'Verify aircraft state.' });
  const held = { status: harness.voiceStore.status, text: harness.voiceStore.statusText };
  await harness.controller.refreshInputDevices({ requestAccess: true });
  assert.equal(harness.voiceStore.inputDevicesError, 'Microphone access denied.');
  assert.equal(harness.voiceStore.status, held.status);
  assert.equal(harness.voiceStore.statusText, held.text);
  assert.equal(await harness.controller.begin(), true);
  assert.equal(harness.voiceStore.inputDevicesError, '', 'a successful capture clears the obsolete access failure');
  await harness.controller.cancel('user');
  await harness.controller.dispose();
});

test('disabling voice during microphone discovery ignores a late access failure', async () => {
  let rejectAccess;
  let accessStarted;
  const started = new Promise(resolve => { accessStarted = resolve; });
  const harness = createHarness({ globalRef: { navigator: { mediaDevices: {
    getUserMedia() { accessStarted(); return new Promise((resolve, reject) => { rejectAccess = reject; }); },
    async enumerateDevices() { return []; },
  } } } });
  await harness.controller.initialize();
  const discovery = harness.controller.refreshInputDevices({ requestAccess: true });
  await started;
  await harness.controller.setRecognitionEnabled(false);
  rejectAccess(new Error('Late microphone failure.'));
  await discovery;
  assert.equal(harness.voiceStore.status, 'disabled');
  assert.equal(harness.voiceStore.inputDevicesError, '');
  assert.equal(harness.cancellations.length, 1);
  await harness.controller.dispose();
});

test('explicit microphone refresh discovers named devices without sending recognition audio', async () => {
  let accessGranted = false;
  let trackStops = 0;
  const mediaDevices = {
    async getUserMedia() {
      accessGranted = true;
      return { getTracks: () => [{ stop: () => { trackStops += 1; } }] };
    },
    async enumerateDevices() {
      return accessGranted
        ? [{ kind: 'audioinput', deviceId: 'usb-headset', label: 'USB headset' }]
        : [{ kind: 'audioinput', deviceId: '', label: '' }];
    },
  };
  const harness = createHarness({ globalRef: { navigator: { mediaDevices } } });

  await harness.controller.initialize();
  assert.deepEqual(harness.voiceStore.inputDevices, []);

  assert.deepEqual(
    await harness.controller.refreshInputDevices({ requestAccess: true }),
    [{ deviceId: 'usb-headset', label: 'USB headset' }],
  );
  assert.deepEqual(harness.voiceStore.inputDevices, [
    { deviceId: 'usb-headset', label: 'USB headset' },
  ]);
  assert.equal(trackStops, 1, 'the temporary media stream must close immediately');
  assert.deepEqual(harness.cancellations, ['session_12345678']);
  assert.equal(harness.captures.length, 0, 'device discovery must not start the PCM capture path');
  assert.equal(harness.audio.length, 0, 'device discovery must not send audio to recognition');
});

test('turning voice off ignores a pending device-change enumeration', async (t) => {
  let resolveDevices;
  const mediaDevices = { async enumerateDevices() { return []; } };
  const h = createHarness({ globalRef: { navigator: { mediaDevices } } });
  t.after(() => h.controller.dispose());
  await h.controller.initialize();
  mediaDevices.enumerateDevices = () => new Promise(resolve => { resolveDevices = resolve; });
  const refresh = h.controller.refreshInputDevices();
  await h.controller.setRecognitionEnabled(false);
  resolveDevices([{ kind: 'audioinput', deviceId: 'headset', label: 'USB headset' }]);
  await refresh;
  assert.deepEqual(h.voiceStore.inputDevices, [], 'a late device list must not repopulate disabled voice settings');
});

test('turning voice off closes microphone discovery while device enumeration is pending', async (t) => {
  let resolveDevices;
  let enumerationStarted;
  const started = new Promise(resolve => { enumerationStarted = resolve; });
  let trackStops = 0;
  const mediaDevices = {
    async enumerateDevices() { return []; },
    async getUserMedia() { return { getTracks: () => [{ stop() { trackStops++; } }] }; },
  };
  const h = createHarness({ runtimeInfo: cloudRuntime, globalRef: { navigator: { mediaDevices } } });
  t.after(() => h.controller.dispose());
  await h.controller.initialize();
  mediaDevices.enumerateDevices = () => new Promise(resolve => {
    resolveDevices = resolve;
    enumerationStarted();
  });
  const discovery = h.controller.refreshInputDevices({ requestAccess: true });
  await started;
  await h.controller.setRecognitionEnabled(false);
  try {
    assert.equal(trackStops, 1, 'turning voice off must close the temporary microphone immediately');
    assert.deepEqual(h.cancellations, ['session_12345678']);
  } finally {
    resolveDevices([{ kind: 'audioinput', deviceId: 'headset', label: 'USB headset' }]);
    await discovery;
  }
  assert.deepEqual(h.voiceStore.inputDevices, []);
  assert.equal(trackStops, 1);
  assert.equal(h.audio.length, 0);
});

test('recognition terminal events close pending microphone discovery and release its caller', async (t) => {
  for (const [label, event, runtimeInfo] of [
    // The offline engine's 11-second watchdog asks the worker to finish;
    // a healthy empty discovery session ends with this final event.
    ['offline watchdog final', { type: 'final', text: '', reason: 'requested' }],
    ['cloud capture timeout', { type: 'error', code: 'CAPTURE_TIMEOUT', message: 'Capture expired.' }, cloudRuntime],
    ['session cancellation', { type: 'cancelled' }, cloudRuntime],
  ]) {
    await t.test(label, async (t) => {
      let resolveDevices;
      let enumerationStarted;
      const started = new Promise(resolve => { enumerationStarted = resolve; });
      let trackStops = 0;
      const mediaDevices = {
        async enumerateDevices() { return []; },
        async getUserMedia() { return { getTracks: () => [{ stop() { trackStops++; } }] }; },
      };
      const h = createHarness({ runtimeInfo, globalRef: { navigator: { mediaDevices } } });
      t.after(() => h.controller.dispose());
      await h.controller.initialize();
      mediaDevices.enumerateDevices = () => new Promise(resolve => {
        resolveDevices = resolve;
        enumerationStarted();
      });
      let discoverySettled = false;
      const discovery = h.controller.refreshInputDevices({ requestAccess: true })
        .then(value => { discoverySettled = true; return value; });
      await started;
      await h.emitRecognition({ ...event, sessionId: 'session_12345678' });
      await new Promise(resolve => setImmediate(resolve));
      try {
        assert.equal(trackStops, 1, 'termination must close discovery before enumeration completes');
        assert.equal(discoverySettled, true, 'Settings must unlock without waiting for the browser reply');
        assert.equal(h.audio.length, 0);
        assert.equal(h.sentCommands.length, 0);
      } finally {
        resolveDevices([{ kind: 'audioinput', deviceId: 'headset', label: 'USB headset' }]);
        await discovery;
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.deepEqual(h.voiceStore.inputDevices, [], 'retired discovery must not publish a late list');
      assert.equal(trackStops, 1, 'late cleanup must not stop an already released stream again');
      mediaDevices.enumerateDevices = async () => [];
      assert.equal(await h.controller.begin(), true, 'termination must leave the next capture usable');
    });
  }
});

test('discovery expiry releases the enable action while microphone access is still pending', async (t) => {
  let grantAccess;
  let accessStarted;
  const started = new Promise(resolve => { accessStarted = resolve; });
  let trackStops = 0;
  const h = createHarness({ runtimeInfo: { ...cloudRuntime, available: false, enabled: false }, globalRef: { navigator: { mediaDevices: {
    async enumerateDevices() { return []; },
    getUserMedia() { accessStarted(); return new Promise(resolve => { grantAccess = resolve; }); },
  } } } });
  t.after(() => h.controller.dispose());
  await h.controller.initialize();
  let enableSettled = false;
  const enabling = h.controller.setRecognitionEnabled(true).then(value => { enableSettled = true; return value; });
  await started;
  await h.emitRecognition({ type: 'error', sessionId: 'session_12345678', code: 'CAPTURE_TIMEOUT', message: 'Capture expired.' });
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(enableSettled, true, 'Settings must unlock so the user can turn voice off after discovery expires');
  } finally {
    grantAccess({ getTracks: () => [{ stop() { trackStops++; } }] });
    await enabling;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(trackStops, 1, 'a late microphone grant is still stopped after the enable action has returned');
  assert.equal(h.audio.length, 0);
  assert.equal(await h.controller.setRecognitionEnabled(false), true);
});

test('provider changes retire pending microphone discovery and permit a new capture', async (t) => {
  let grantAccess;
  let accessStarted;
  const started = new Promise(resolve => { accessStarted = resolve; });
  let enumerations = 0;
  let trackStops = 0;
  const h = createHarness({ runtimeInfo: cloudRuntime, globalRef: { navigator: { mediaDevices: {
    async enumerateDevices() { enumerations++; return []; },
    getUserMedia() { accessStarted(); return new Promise(resolve => { grantAccess = resolve; }); },
  } } } });
  t.after(() => h.controller.dispose());
  await h.controller.initialize();
  const discovery = h.controller.refreshInputDevices({ requestAccess: true });
  await started;
  h.emitRuntime({ ...cloudRuntime, cloud: { ...cloudRuntime.cloud, providerId: 'gemini', modelId: 'gemini-3.8-flash', revision: 1 } });
  try {
    assert.deepEqual(h.cancellations, ['session_12345678'], 'provider changes release the discovery session');
    assert.equal(await h.controller.begin(), true, 'an abandoned permission request must not block push-to-talk');
  } finally {
    grantAccess({ getTracks: () => [{ stop() { trackStops++; } }] });
    await discovery;
  }
  assert.equal(trackStops, 1, 'a late permission grant must close its obsolete stream');
  assert.equal(enumerations, 2, 'only initialization and the new capture enumerate devices');
  assert.equal(h.voiceStore.activeSessionId, 'session_next_2');
  assert.equal(h.captureCancellations.length, 0, 'late discovery cleanup must not cancel the new capture');
});

test('shutdown before discovery authorization returns prevents opening the microphone', async () => {
  let resolveRecognition;
  let accessRequests = 0;
  const h = createHarness({
    startRecognition: () => new Promise(resolve => { resolveRecognition = resolve; }),
    globalRef: { navigator: { mediaDevices: {
      async enumerateDevices() { return []; },
      async getUserMedia() { accessRequests++; return { getTracks: () => [] }; },
    } } },
  });
  await h.controller.initialize();
  const discovery = h.controller.refreshInputDevices({ requestAccess: true });
  await h.controller.dispose();
  resolveRecognition({ sessionId: 'session_discovery' });
  await discovery;
  assert.equal(accessRequests, 0);
  assert.deepEqual(h.cancellations, ['session_discovery']);
  assert.equal(h.voiceStore.actions, null);
  assert.deepEqual(h.voiceStore.inputDevices, []);
});

test('late discovery replies and terminal events cannot retire a newer microphone refresh', async (t) => {
  const requests = [];
  let signalAccess;
  let trackStops = 0;
  const h = createHarness({ runtimeInfo: cloudRuntime, globalRef: { navigator: { mediaDevices: {
    async enumerateDevices() { return [{ kind: 'audioinput', deviceId: 'headset', label: 'USB headset' }]; },
    getUserMedia() {
      const promise = new Promise((resolve, reject) => { requests.push({ resolve, reject }); });
      signalAccess();
      return promise;
    },
  } } } });
  t.after(() => h.controller.dispose());
  await h.controller.initialize();
  let started = new Promise(resolve => { signalAccess = resolve; });
  const oldDiscovery = h.controller.refreshInputDevices({ requestAccess: true });
  await started;
  h.emitRuntime({ ...cloudRuntime, cloud: { ...cloudRuntime.cloud, revision: 1 } });
  started = new Promise(resolve => { signalAccess = resolve; });
  const newDiscovery = h.controller.refreshInputDevices({ requestAccess: true });
  await started;
  for (const event of [
    { type: 'final', text: '', reason: 'requested' },
    { type: 'error', code: 'CAPTURE_TIMEOUT', message: 'Capture expired.' },
    { type: 'cancelled' },
  ]) {
    await h.emitRecognition({ ...event, sessionId: 'session_12345678' });
    assert.deepEqual(h.cancellations, ['session_12345678'], 'a retired session event cannot cancel the new discovery');
    assert.equal(await h.controller.begin(), false, 'the new discovery must keep microphone ownership');
    assert.equal(trackStops, 0, 'the new permission request has not granted a stream yet');
  }
  requests[0].reject(new Error('Obsolete microphone access failure.'));
  await oldDiscovery;
  assert.equal(h.voiceStore.inputDevicesError, '');
  assert.equal(await h.controller.begin(), false, 'the new discovery still owns the microphone');
  requests[1].resolve({ getTracks: () => [{ stop() { trackStops++; } }] });
  await newDiscovery;
  assert.equal(trackStops, 1);
  assert.deepEqual(h.cancellations, ['session_12345678', 'session_next_2']);
  assert.equal(h.voiceStore.inputDevices[0].label, 'USB headset');
  assert.equal(h.audio.length, 0);
  assert.equal(h.sentCommands.length, 0);
  assert.equal(await h.controller.begin(), true);
});

test('one push-to-talk session dispatches one exact shared aircraft command', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  assert.equal(harness.voiceStore.status, 'ready');
  assert.equal(await harness.controller.begin(), true);
  harness.captures[0].callbacks.onChunk({
    sampleRate: 48000, samples: new Float32Array([0.1, -0.1]), sequence: 0,
  });
  assert.equal(harness.audio.length, 1);
  assert.equal(await harness.controller.finish(), true);
  harness.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.sentCommands.length, 1);
  assert.deepEqual(harness.sentCommands[0].input, { value: 270 });
  assert.equal(harness.sentCommands[0].commandId, 'flightGuidance.heading.set');
  assert.equal(harness.sentCommands[0].options.pendingKey, 'aircraft-command:flightGuidance.heading.set');
  assert.equal(typeof harness.sentCommands[0].options.onResult, 'function');
  harness.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'heading one eight zero' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.sentCommands.length, 1);
});

test('failed global shortcut registration keeps on-screen push-to-talk ready with truthful status', async () => {
  const harness = createHarness({
    runtimeInfo: {
      available: true,
      development: false,
      enabled: true,
      engine: { modelId: 'zipformer' },
      pushToTalk: {
        accelerator: 'Control+Alt+Space',
        error: 'Shortcut is already in use',
        registered: false,
      },
    },
  });

  await harness.controller.initialize();

  assert.equal(harness.voiceStore.runtime.shortcutRegistered, false);
  assert.equal(harness.voiceStore.runtime.shortcutError, 'Shortcut is already in use');
  assert.equal(harness.voiceStore.status, 'ready', 'speech availability should keep the on-screen PTT usable');
  assert.match(harness.voiceStore.statusText, /global push-to-talk unavailable/i);
  assert.match(harness.voiceStore.statusText, /shortcut is already in use/i);
  assert.match(harness.voiceStore.statusText, /on-screen button/i);
  assert.doesNotMatch(harness.voiceStore.statusText, /Hold Control\+Alt\+Space/i);
  assert.equal(await harness.controller.begin(), true, 'the on-screen PTT should still start recognition');
  await harness.controller.cancel('user');
  harness.emitPtt({ type: 'error', error: 'Push-to-talk helper stopped' });
  assert.equal(harness.voiceStore.runtime.shortcutRegistered, false);
  assert.equal(harness.voiceStore.runtime.shortcutError, 'Push-to-talk helper stopped');
  assert.equal(harness.voiceStore.status, 'ready', 'a stopped shortcut helper must not disable on-screen PTT');
  assert.match(harness.voiceStore.statusText, /on-screen button/i);
});

test('unassigned global shortcut asks for setup while on-screen push-to-talk stays ready', async () => {
  const harness = createHarness({
    runtimeInfo: {
      available: true,
      development: false,
      enabled: true,
      engine: { modelId: 'zipformer' },
      pushToTalk: { accelerator: '', error: '', registered: false },
    },
  });

  await harness.controller.initialize();

  assert.equal(harness.voiceStore.runtime.shortcut, '');
  assert.equal(harness.voiceStore.status, 'ready');
  assert.match(harness.voiceStore.statusText, /choose a push-to-talk shortcut in voice settings/i);
  assert.match(harness.voiceStore.statusText, /on-screen button/i);
  assert.doesNotMatch(harness.voiceStore.statusText, /unavailable/i);
  assert.equal(await harness.controller.begin(), true, 'the on-screen PTT should work without a global shortcut');
  await harness.controller.cancel('user');
});

test('controller-enabled setup offers both input choices without requiring a keyboard shortcut', async () => {
  const harness = createHarness({ runtimeInfo: { available: true, enabled: true,
    pushToTalk: { controllerEnabled: true, accelerator: '', registered: false } } });
  await harness.controller.initialize();
  assert.match(harness.voiceStore.statusText, /keyboard shortcut or controller button/);
  assert.equal(await harness.controller.begin(), true);
  await harness.controller.cancel('user');
  await harness.controller.dispose();
});

test('development mode transcribes without a simulator, aircraft, or command catalogue', async () => {
  const harness = createHarness({
    development: true,
    availability: { enabled: false, reason: 'Simulator telemetry link unavailable.' },
    catalogue: { commands: {} },
  });

  await harness.controller.initialize();
  assert.equal(harness.voiceStore.status, 'ready');
  assert.equal(harness.voiceStore.statusText, 'Ready.');
  assert.equal(await harness.controller.begin(), true);
  assert.match(harness.voiceStore.statusText, /nothing will be sent/i);
  assert.equal(await harness.controller.finish(), true);
  await harness.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'test the zipformer microphone',
  });

  assert.equal(harness.voiceStore.transcript, 'test the zipformer microphone');
  assert.equal(harness.voiceStore.status, 'transcribed');
  assert.match(harness.voiceStore.statusText, /nothing was sent/i);
  assert.equal(harness.sentCommands.length, 0);
  assert.equal(await harness.controller.begin(), true, 'a completed development transcription should be retryable');
  assert.equal(harness.voiceStore.transcript, '', 'the next PTT should still begin with an empty transcript');
  await harness.controller.cancel('user');
});

test('development transcription can preview a known command but never dispatches it', async () => {
  const harness = createHarness({
    development: true,
    availability: { enabled: false, reason: 'Simulator telemetry link unavailable.' },
  });

  await harness.controller.initialize();
  await harness.controller.begin();
  // Freeze the no-dispatch decision at PTT-down even if the simulator becomes
  // available before the recognizer returns its final result.
  harness.aircraftControlsStore.availability = { enabled: true, reason: 'Ready.' };
  harness.controller.handleAircraftContextChange();
  assert.deepEqual(harness.cancellations, [], 'a backend reconnect should not interrupt transcription-only PTT');
  await harness.controller.finish();
  await harness.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero',
  });

  assert.equal(harness.voiceStore.status, 'transcribed');
  assert.match(harness.voiceStore.lastCommand, /Would send Selected heading: 270/i);
  assert.equal(harness.sentCommands.length, 0);
});

test('development transcription recovers a bounded altitude digit homophone', async () => {
  const altitude = {
    id: 'flightGuidance.altitude.set',
    label: 'Selected altitude',
    input: { kind: 'number', min: 0, max: 60000, step: 100, units: 'feet' },
    speech: { patterns: ['set altitude {value}', 'altitude {value}'], hints: ['ALTITUDE'] },
  };
  const harness = createHarness({
    development: true,
    availability: { enabled: false, reason: 'Simulator telemetry link unavailable.' },
    catalogue: {
      configurationId: 'generic', profileKey: 'test/generic', profileRevision: 1,
      commands: { [altitude.id]: altitude },
    },
  });

  await harness.controller.initialize();
  await harness.controller.begin();
  await harness.controller.finish();
  await harness.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'SAID ALTITUDE ONE TO ZERO',
  });

  assert.equal(harness.voiceStore.status, 'transcribed');
  assert.match(harness.voiceStore.lastCommand, /Interpreted as.*set altitude one two zero/i);
  assert.match(harness.voiceStore.lastCommand, /Would send Selected altitude: 12000/i);
  assert.equal(harness.sentCommands.length, 0);
});

test('packaged-mode aircraft gates remain enforced without a simulator', async () => {
  const harness = createHarness({
    development: false,
    availability: { enabled: false, reason: 'Simulator telemetry link unavailable.' },
    catalogue: { commands: {} },
  });

  await harness.controller.initialize();
  assert.equal(harness.voiceStore.status, 'blocked');
  assert.match(harness.voiceStore.statusText, /simulator telemetry/i);
  assert.equal(await harness.controller.begin(), false);
  assert.equal(harness.captures.length, 0);
  assert.equal(harness.sentCommands.length, 0);
});

test('development builds still execute normally when an aircraft command is available', async () => {
  const harness = createHarness({ development: true });

  await harness.controller.initialize();
  await harness.controller.begin();
  await harness.controller.finish();
  await harness.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero',
  });

  assert.equal(harness.sentCommands.length, 1);
  assert.equal(harness.voiceStore.status, 'sending');
});

test('a new push-to-talk clears the prior transcript and rejects late prior-session text', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  await harness.controller.begin();
  harness.emitRecognition({
    type: 'partial', sessionId: 'session_12345678', text: 'old word',
  });
  assert.equal(harness.voiceStore.transcript, 'old word');
  await harness.controller.finish();
  await harness.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'old word',
  });

  assert.equal(await harness.controller.begin(), true);
  assert.equal(harness.voiceStore.transcript, '');
  const nextSessionId = harness.voiceStore.activeSessionId;
  assert.notEqual(nextSessionId, 'session_12345678');

  harness.emitRecognition({
    type: 'partial', sessionId: 'session_12345678', text: 'stale old word',
  });
  assert.equal(harness.voiceStore.transcript, '');
  harness.emitRecognition({
    type: 'partial', sessionId: nextSessionId, text: 'new command',
  });
  assert.equal(harness.voiceStore.transcript, 'new command');
  await harness.controller.cancel('user');
});

test('a bounded recognition correction is visible and dispatches the validated command', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  await harness.controller.begin();
  await harness.controller.finish();
  await harness.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'said heading two seven zero',
  });

  assert.equal(harness.sentCommands.length, 1);
  assert.equal(harness.sentCommands[0].commandId, 'flightGuidance.heading.set');
  assert.deepEqual(harness.sentCommands[0].input, { value: 270 });
  assert.match(harness.voiceStore.lastCommand, /Interpreted as.*set heading two seven zero/i);
});

test('a decoded tens word and clipped trailing zero recover to the spoken heading', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  await harness.controller.begin();
  await harness.controller.finish();
  await harness.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'SET HEADING TWO EIGHTY ZER',
  });

  assert.equal(harness.sentCommands.length, 1);
  assert.equal(harness.sentCommands[0].commandId, 'flightGuidance.heading.set');
  assert.deepEqual(harness.sentCommands[0].input, { value: 280 });
  assert.match(harness.voiceStore.lastCommand, /Interpreted as.*set heading two eighty zero/i);
});

test('an incomplete multi-channel command asks for the missing discriminator and stays fail-closed', async () => {
  const autopilotOne = {
    id: 'flightGuidance.autopilot1.engage', label: 'Autopilot 1', input: { kind: 'none' },
    speech: { patterns: ['engage autopilot one', 'engage autopilot left'] },
  };
  const autopilotTwo = {
    id: 'flightGuidance.autopilot2.engage', label: 'Autopilot 2', input: { kind: 'none' },
    speech: { patterns: ['engage autopilot two', 'engage autopilot right'] },
  };
  const harness = createHarness({
    catalogue: {
      configurationId: 'pmdg-777', profileKey: 'test/pmdg-777', profileRevision: 1,
      commands: { [autopilotOne.id]: autopilotOne, [autopilotTwo.id]: autopilotTwo },
    },
  });
  await harness.controller.initialize();
  await harness.controller.begin();
  await harness.controller.finish();
  await harness.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'engage autopilot',
  });

  assert.equal(harness.sentCommands.length, 0);
  assert.equal(harness.voiceStore.status, 'unmatched');
  assert.match(harness.voiceStore.statusText, /finish with.*one.*left.*two.*right/i);
  assert.match(harness.voiceStore.statusText, /nothing was executed/i);
});

test('voice feedback waits for and preserves the correlated backend success result', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  await harness.controller.begin();
  await harness.controller.finish();
  await harness.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero',
  });

  assert.equal(harness.voiceStore.status, 'sending');
  assert.match(harness.voiceStore.statusText, /Sending Selected heading: 270/);
  harness.controller.refreshReadyState();
  assert.equal(harness.voiceStore.status, 'sending', 'routine simState refresh must not hide an in-flight command');

  harness.completeLastCommand({ ok: true, requestId: 'ctrl-1' });
  assert.equal(harness.voiceStore.status, 'sent');
  assert.match(harness.voiceStore.statusText, /Sent Selected heading: 270/);
  assert.deepEqual(harness.spokenReadbacks, ['Heading two seven zero set.']);
  harness.controller.refreshReadyState();
  assert.equal(harness.voiceStore.status, 'sent', 'routine simState refresh must preserve correlated success feedback');

  const cancellationsBeforeNextPtt = harness.readbackCancellations.length;
  assert.equal(await harness.controller.begin(), true, 'the next PTT should explicitly recover from held success feedback');
  assert.equal(harness.readbackCancellations.length, cancellationsBeforeNextPtt + 1);
  assert.equal(harness.voiceStore.status, 'listening');
  await harness.controller.cancel('user');
});

test('unconfirmed backend results keep voice feedback honest for commands and presets', async () => {
  for (const stepCount of [1, 3]) {
    const harness = createHarness();
    await harness.controller.initialize();
    await harness.controller.begin();
    await harness.controller.finish();
    await harness.emitRecognition({
      type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero',
    });

    harness.completeLastCommand({
      ok: true, code: 'sent_unconfirmed', requestId: 'ctrl-1',
      stepCount, completedStepCount: stepCount, unconfirmedStepCount: 1,
      ...(stepCount > 1 ? { transportAcknowledged: true } : {}),
    });
    assert.equal(harness.voiceStore.status, 'sent');
    assert.match(harness.voiceStore.statusText, /response unconfirmed.*check the simulator/i);
    assert.deepEqual(harness.spokenReadbacks, ['Command sent. Aircraft response unconfirmed. Check the simulator.']);
    harness.controller.refreshReadyState();
    assert.match(harness.voiceStore.statusText, /response unconfirmed/i);
    assert.equal(harness.sentCommands.length, 1, 'feedback must not retry the command');
    await harness.controller.begin();
    await harness.controller.cancel('user');
  }
});

test('APU voice dispatch reports request acceptance or existing startup without claiming availability', async () => {
  for (const code of ['executed', 'already_satisfied']) for (const transcript of ['start apu', 'start ay pee you', 'START A P YOU']) {
    const harness = createHarness({ catalogue: { configurationId: 'test-apu', profileKey: 'test/apu', profileRevision: 1, commands: {
      apu: { id: 'configuration.apu.start', label: 'Start APU', input: { kind: 'none' },
        speech: { patterns: ['start apu'] } },
    } } });
    await harness.controller.initialize();
    await harness.controller.begin();
    await harness.controller.finish();
    await harness.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: transcript });
    harness.completeLastCommand({ ok: true, code, transportAcknowledged: code === 'executed' });
    assert.equal(harness.voiceStore.status, 'sent');
    assert.equal(harness.sentCommands.length, 1);
    assert.deepEqual(harness.spokenReadbacks, [code === 'executed'
      ? 'A P U start requested.' : 'A P U already starting or running.']);
    assert.doesNotMatch(harness.voiceStore.statusText, /APU (?:is available|started successfully)/i);
  }
});

test('IDENT transport acceptance speaks a request without claiming active IDENT or retrying', async () => {
  const harness = createHarness({ catalogue: { configurationId: 'pmdg-777', profileKey: 'bundled/msfs/pmdg-777', profileRevision: 1, commands: {
    ident: { id: 'surveillance.ident.activate', label: 'IDENT', input: { kind: 'none' }, speech: { patterns: ['ident'] } },
  } } });
  await harness.controller.initialize(); await harness.controller.begin(); await harness.controller.finish();
  await harness.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'ident' });
  assert.equal(harness.spokenReadbacks.length, 0);
  harness.completeLastCommand({ ok: true, code: 'executed', transportAcknowledged: true });
  assert.deepEqual(harness.spokenReadbacks, ['IDENT requested.']);
  assert.match(harness.voiceStore.statusText, /IDENT requested/);
  assert.equal(harness.sentCommands.length, 1);
});

test('clipped APU letters never dispatch or produce a start-request readback', async () => {
  for (const transcript of ['START A P', 'start ay pee', 'start AP']) {
    const harness = createHarness({ catalogue: { configurationId: 'test-apu', profileKey: 'test/apu', profileRevision: 1, commands: {
      apu: { id: 'configuration.apu.start', label: 'Start APU', input: { kind: 'none' },
        speech: { patterns: ['start apu', 'start a p u'] } },
    } } });
    await harness.controller.initialize();
    await harness.controller.begin();
    await harness.controller.finish();
    await harness.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: transcript });
    assert.equal(harness.sentCommands.length, 0, transcript);
    assert.equal(harness.spokenReadbacks.length, 0, transcript);
  }
});

test('COM voice completion speaks the observed active frequency and never confirms a missing readback', async () => {
  for (const confirmed of [true, false]) {
    const harness = createHarness({ catalogue: { configurationId: 'fbw-a32nx', profileKey: 'bundled/msfs/fbw-a32nx', profileRevision: 1, commands: {
      swap: { id: 'radios.com2.swap', label: 'Swap COM 2', input: { kind: 'none' }, speech: { patterns: ['swap com two'] } },
    } } });
    await harness.controller.initialize();
    await harness.controller.begin();
    await harness.controller.finish();
    await harness.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'swap com two' });
    assert.equal(harness.spokenReadbacks.length, 0, 'dispatch is not confirmation');
    harness.completeLastCommand({ ok: true, code: 'executed', ...(confirmed
      ? { radio: { index: 2, bank: 'active', frequencyMhz: 123.005 } } : {}) });
    assert.equal(harness.sentCommands.length, 1);
    if (confirmed) {
      assert.match(harness.voiceStore.statusText, /COM 2 active 123.005 MHz confirmed/);
      assert.deepEqual(harness.spokenReadbacks, ['Com two active one two three decimal zero zero five confirmed.']);
    } else {
      assert.match(harness.voiceStore.statusText, /unconfirmed/);
      assert.match(harness.spokenReadbacks[0], /unconfirmed/);
    }
  }
});

test('approach voice waits for confirmation and never speaks a selection after failure or unconfirmed dispatch', async () => {
  for (const [id, value, spoken] of [
    ['surfaces.flaps.set', 'full', 'Flaps full selected.'],
    ['surfaces.autobrake.set', 'medium', 'Autobrake medium set.'],
    ['surfaces.spoilers.set', 'half', 'Speedbrake half selected.'],
  ]) for (const code of ['executed', 'sent_unconfirmed', 'aircraft_integration_readback_timeout']) {
    const harness = createHarness({ catalogue: { configurationId: 'fbw-a32nx', profileKey: 'bundled/msfs/fbw-a32nx', profileRevision: 1, commands: {
      approach: { id, label: 'Approach control', input: { kind: 'enum', values: [value] }, speech: { patterns: ['select {value}'] } },
    } } });
    await harness.controller.initialize(); await harness.controller.begin(); await harness.controller.finish();
    await harness.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: `select ${value}` });
    assert.equal(harness.spokenReadbacks.length, 0, 'dispatch alone cannot confirm selection');
    harness.completeLastCommand({ ok: code !== 'aircraft_integration_readback_timeout', code,
      ...(id === 'surfaces.flaps.set' && code === 'executed' ? { confirmedValue: 'full' } : {}) });
    assert.equal(harness.sentCommands.length, 1);
    if (code === 'executed') assert.deepEqual(harness.spokenReadbacks, [spoken]);
    else assert.equal(harness.spokenReadbacks.includes(spoken), false);
  }
});

test('flap voice distinguishes observed selection, unconfirmed dispatch and rejected commands across aircraft', async () => {
  for (const profile of ['pmdg-737', 'pmdg-737-600', 'pmdg-737-700', 'pmdg-737-900',
    'pmdg-777', 'pmdg-777-200er', 'pmdg-777-200lr', 'pmdg-777f',
    'fenix-a319', 'fenix-a320', 'fenix-a321', 'fbw-a32nx']) {
    for (const code of ['executed', 'sent_unconfirmed', 'aircraft_integration_readback_timeout',
      'aircraft_integration_simconnect_exception', 'aircraft_integration_readback_unavailable', 'observation_interrupted']) {
      const harness = createHarness({ catalogue: {
        configurationId: profile, profileKey: `bundled/msfs/${profile}`, profileRevision: 1,
        commands: { flaps: { id: 'surfaces.flaps.set', label: 'Flap detent',
          input: { kind: 'enum', values: ['1', '5'] }, speech: { patterns: ['flaps {value}'] } } },
      } });
      await harness.controller.initialize(); await harness.controller.begin(); await harness.controller.finish();
      await harness.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'flaps one' });
      assert.equal(harness.spokenReadbacks.length, 0, 'dispatch alone does not confirm selection');
      harness.completeLastCommand({ ok: ['executed', 'sent_unconfirmed'].includes(code), code,
        ...(code === 'executed' ? { confirmedValue: '1' } : {}),
        executionStarted: code !== 'aircraft_integration_readback_unavailable',
        error: code === 'executed' ? '' : 'Aircraft diagnostic retained.' });
      assert.equal(harness.sentCommands.length, 1, 'no automatic retry after any outcome');
      if (code === 'executed') {
        assert.deepEqual(harness.spokenReadbacks, ['Flaps 1 selected.']);
        assert.equal(harness.voiceStore.status, 'sent');
      } else if (['aircraft_integration_readback_timeout', 'observation_interrupted'].includes(code)) {
        assert.deepEqual(harness.spokenReadbacks, ['Flap selection not confirmed. Check the cockpit.']);
        assert.equal(harness.voiceStore.status, 'error');
        assert.match(harness.voiceStore.statusText, /Aircraft diagnostic retained/);
      } else if (code === 'sent_unconfirmed') {
        assert.deepEqual(harness.spokenReadbacks, ['Flap command sent. Check the cockpit.']);
        assert.equal(harness.voiceStore.status, 'sent');
      } else {
        assert.deepEqual(harness.spokenReadbacks, ['Flap command failed. Check the cockpit.']);
        assert.equal(harness.voiceStore.status, 'failed');
      }
    }
  }
});

test('generic and relative flap voice never infer an exact lever change from delivery or index movement', async () => {
  for (const profile of ['generic', 'fbw-a380x', 'inibuilds-a350-900', 'inibuilds-a350-1000',
    'microsoft-737-max-8', 'inibuilds-a320neo-v2', 'inibuilds-a321lr']) {
    for (const value of ['increase', 'decrease']) {
      const harness = createHarness({ catalogue: {
        configurationId: profile, profileKey: `bundled/msfs/${profile}`, profileRevision: 1,
        commands: { flaps: { id: 'surfaces.flaps.adjust', label: 'Adjust flaps',
          input: { kind: 'enum', values: ['increase', 'decrease'] }, speech: { patterns: ['flaps {value}'] } } },
      } });
      await harness.controller.initialize(); await harness.controller.begin(); await harness.controller.finish();
      await harness.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: `flaps ${value}` });
      assert.equal(harness.spokenReadbacks.length, 0);
      harness.completeLastCommand({ ok: true, code: profile === 'generic' ? 'sent_unconfirmed' : 'executed',
        ...(profile === 'generic' ? {} : { confirmedValue: 2 }) });
      assert.deepEqual(harness.spokenReadbacks, ['Flap command sent. Check the cockpit.']);
      assert.equal(harness.sentCommands.length, 1);
      await harness.controller.dispose();
    }
  }
});

test('flap feedback requires explicit confirmation and keeps preflight failures distinct from interrupted dispatch', () => {
  const request = { commandId: 'surfaces.flaps.set', input: { value: 'up' } };
  assert.equal(flapResultText({ ok: true, confirmedValue: 0 }, request).text, 'Flaps up selected.');
  assert.equal(flapResultText({ ok: true, confirmedValue: 0, noOp: true }, request).outcome, 'confirmed');
  for (const extra of [{}, { confirmedValue: null }, { confirmedValue: NaN }, { confirmedValue: '' },
    { confirmedValue: false }, { confirmedValue: 0, transportAcknowledged: true },
    { confirmedValue: 0, code: 'sent_unconfirmed' }]) {
    assert.equal(flapResultText({ ok: true, ...extra }, request).outcome, 'sent');
  }
  assert.equal(flapResultText({ ok: true, noOp: true }, request).outcome, 'unconfirmed', 'an unproven no-op cannot claim a write');
  for (const code of ['stale_profile', 'sdk_transport_unavailable', 'observation_interrupted']) {
    assert.equal(flapResultText({ ok: false, code }, request).outcome, 'failed');
    assert.equal(flapResultText({ ok: false, code, executionStarted: true }, request).outcome, 'unconfirmed');
  }
  for (const code of ['simconnect_exception', 'aircraft_integration_simconnect_exception', 'action_failed']) {
    assert.equal(flapResultText({ ok: false, code, executionStarted: true }, request).outcome, 'failed');
  }
  assert.equal(flapResultText({ ok: true }, { control: 'flaps', operation: 'increment' }).outcome, 'sent');
  assert.equal(flapResultText({ ok: true }, { commandId: 'surfaces.gear.set' }), null);
});

test('flap button feedback preserves confirmation, uncertainty, rejection and request ownership', () => {
  setActivePinia(createPinia());
  const controls = useAircraftControlsStore(), sent = [], toasts = [], replies = [];
  const controller = createAircraftControlController({
    WebSocketRef: { OPEN: 1 }, getWs: () => ({ readyState: 1 }), getWsSend: () => message => sent.push(message),
    getAuthorizationScope: () => 'full-control', getSimconnectConnected: () => true,
    aircraftControlsStore: controls, showToast: (...toast) => toasts.push(toast),
  });
  const profileKey = 'bundled/msfs/fbw-a32nx', commandId = 'surfaces.flaps.set';
  controller.setActiveProfileToken({ _profileKey: profileKey, profileRevision: 1 });
  controller.applyControlCapabilities({ aircraftCommands: { profileKey, profileRevision: 1,
    commands: [{ id: commandId, label: 'Flaps', input: { kind: 'enum', values: ['1'] } }] } });
  for (const [result, text, tone] of [
    [{ ok: true, code: 'executed', confirmedValue: '1' }, 'Flaps 1 selected.', 'success'],
    [{ ok: true, code: 'sent_unconfirmed' }, 'Flap command sent. Check the cockpit.', 'warning'],
    [{ ok: false, code: 'aircraft_integration_readback_timeout', executionStarted: true }, 'Flap selection not confirmed. Check the cockpit.', 'warning'],
    [{ ok: false, code: 'aircraft_integration_simconnect_exception', executionStarted: true }, 'Flap command failed. Check the cockpit.', 'error'],
  ]) {
    const input = { value: '1' };
    assert.equal(controller.sendCommand(commandId, input, { onResult: result => replies.push(result) }), true);
    const message = { ...result, commandId, request: { commandId, input }, requestId: sent.at(-1).requestId };
    controller.handleResult(message);
    assert.equal(controls.feedback.actionText, text);
    assert.equal(toasts.at(-1)[0], tone);
    assert.equal(controls.isCommandPending(`aircraft-command:${commandId}`), false);
    const count = toasts.length;
    controller.handleResult(message);
    assert.equal(toasts.length, count, 'duplicate replies do not replace feedback');
  }
  assert.equal(sent.length, 4, 'no retry on unconfirmed or rejected selection');
  assert.equal(replies.length, 4, 'each caller settles once');
  controller.clearPendingRequests();
});

test('gear feedback accepts only matching handle evidence and separates observation loss from rejection', () => {
  const request = { commandId: 'surfaces.gear.set', input: { value: 'up' } };
  for (const confirmedValue of [false, 'up']) {
    assert.equal(gearResultText({ ok: true, confirmedValue, noOp: true }, request).text, 'Gear up selected.');
    for (const extra of [{ code: 'sent_unconfirmed' }, { transportAcknowledged: true }]) {
      assert.equal(gearResultText({ ok: true, confirmedValue, ...extra }, request).outcome, 'sent');
    }
  }
  assert.equal(gearResultText({ ok: true }, request).outcome, 'sent');
  assert.equal(gearResultText({ ok: true, noOp: true }, request).outcome, 'unconfirmed');
  // Deliberately inconsistent result payloads must never invent a selection.
  for (const confirmedValue of [true, 'down', 'off', 0, NaN, '']) {
    assert.equal(gearResultText({ ok: true, confirmedValue }, request).outcome, 'unconfirmed');
  }
  for (const code of ['aircraft_integration_readback_timeout', 'aircraft_integration_selector_readback_timeout',
    'observation_interrupted', 'stale_profile', 'sdk_transport_unavailable']) {
    assert.equal(gearResultText({ ok: false, code }, request).outcome, 'failed');
    assert.equal(gearResultText({ ok: false, code, executionStarted: true }, request).outcome, 'unconfirmed');
  }
  for (const code of ['aircraft_integration_readback_unavailable', 'simconnect_exception',
    'aircraft_integration_simconnect_exception', 'simconnect_sequence_execution_failed', 'action_failed']) {
    assert.equal(gearResultText({ ok: false, code, executionStarted: true }, request).outcome, 'failed');
  }
  assert.equal(gearResultText({ ok: true, confirmedValue: false }, { control: 'gear', operation: 'toggle' }).outcome, 'sent');
  for (const request of [{ commandId: 'surfaces.flaps.set' },
    { control: 'aircraft-specific', operation: 'execute', actionId: 'gear.parkingBrake.set' },
    { control: 'aircraft-specific', operation: 'execute', actionId: 'controls.gear.off' }]) {
    assert.equal(gearResultText({ ok: true }, request), null);
  }
  assert.equal(gearResultText({ ok: true, commandId: 'configuration.takeoff.set',
    request: { control: 'aircraft-specific', operation: 'execute', actionId: 'controls.gear.up' } }), null,
  'a step within an unrelated command must not replace its overall feedback');
});

test('gear buttons and voice agree on confirmation, delivery, observation failure and rejection', async () => {
  const commandId = 'surfaces.gear.set', pendingKey = `aircraft-command:${commandId}`;
  // Boundary fixtures reflect the actual string SDK, boolean handle and generic
  // result contracts. They validate feedback, not an aircraft moving in MSFS.
  for (const profile of ['pmdg-737', 'pmdg-777', 'fbw-a380x', 'generic']) {
    setActivePinia(createPinia());
    const controls = useAircraftControlsStore(), sent = [], toasts = [];
    const profileKey = `bundled/msfs/${profile}`;
    const aircraftControl = createAircraftControlController({
      WebSocketRef: { OPEN: 1 }, getWs: () => ({ readyState: 1 }), getWsSend: () => message => sent.push(message),
      getAuthorizationScope: () => 'full-control', getSimconnectConnected: () => true,
      aircraftControlsStore: controls, showToast: (...toast) => toasts.push(toast),
    });
    aircraftControl.setActiveProfileToken({ _profileKey: profileKey, profileRevision: 1 });
    aircraftControl.applyControlCapabilities({ aircraftCommands: { profileKey, profileRevision: 1,
      configurationId: profile, commands: [{ id: commandId, label: 'Landing gear',
        input: { kind: 'enum', values: ['up', 'down'] }, speech: { patterns: ['gear {value}'] } }] } });
    aircraftControl.updateAvailability();
    const h = createHarness({ aircraftControlsStore: controls, aircraftControl });
    try {
      await h.controller.initialize();
      for (const value of ['up', 'down']) {
        const confirmedValue = profile === 'pmdg-737' ? value : value === 'down';
        const cases = [
          ...(profile === 'generic'
            ? [[{ ok: true, code: 'sent_unconfirmed' }, 'Gear command sent. Check the cockpit.', 'sent', 'warning']]
            : [
              [{ ok: true, code: 'executed', confirmedValue }, `Gear ${value} selected.`, 'sent', 'success'],
              [{ ok: true, code: 'executed', confirmedValue, noOp: true }, `Gear ${value} selected.`, 'sent', 'success'],
              [{ ok: false, code: 'aircraft_integration_readback_timeout', executionStarted: true },
                'Gear selection not confirmed. Check the cockpit.', 'unconfirmed', 'warning'],
            ]),
          [{ ok: false, code: 'stale_profile', executionStarted: true },
            'Gear selection not confirmed. Check the cockpit.', 'unconfirmed', 'warning'],
          ...(profile === 'fbw-a380x' ? [] : [[
            { ok: false, code: profile === 'generic' ? 'observation_interrupted' : 'sdk_transport_unavailable', executionStarted: true },
            'Gear selection not confirmed. Check the cockpit.', 'unconfirmed', 'warning',
          ]]),
          [{ ok: false, code: 'stale_profile' }, 'Gear command failed. Check the cockpit.', 'failed', 'error'],
          [{ ok: false, code: profile === 'generic' ? 'simconnect_exception' : 'aircraft_integration_simconnect_exception', executionStarted: true },
            'Gear command failed. Check the cockpit.', 'failed', 'error'],
        ];
        for (const [result, text, status, tone] of cases) {
          const before = sent.length, spokenBefore = h.spokenReadbacks.length;
          assert.equal(await h.controller.begin(), true);
          const sessionId = h.voiceStore.activeSessionId;
          await h.controller.finish();
          await h.emitRecognition({ type: 'final', sessionId, text: `gear ${value}` });
          assert.equal(sent.length, before + 1);
          assert.equal(h.spokenReadbacks.length, spokenBefore, 'dispatch alone cannot announce selection');
          assert.equal(aircraftControl.sendCommand(commandId, { value }), false, 'button cannot overlap voice');
          const message = { ...result, commandId, request: { commandId, input: { value } },
            requestId: sent.at(-1).requestId, profileKey, stepCount: 1, completedStepCount: result.ok ? 1 : 0,
            ...(!result.ok ? { error: 'Aircraft diagnostic retained.' } : {}) };
          aircraftControl.handleResult(message);
          assert.equal(controls.feedback.actionText, text);
          assert.equal(controls.feedback.status, status);
          assert.equal(toasts.at(-1)[0], tone);
          assert.equal(h.spokenReadbacks.at(-1), text);
          assert.equal(h.voiceStore.status, status === 'unconfirmed' ? 'error' : status);
          if (!result.ok) {
            assert.match(controls.feedback.routeText, /Aircraft diagnostic retained/);
            assert.match(h.voiceStore.statusText, /Aircraft diagnostic retained/);
          }
          assert.equal(controls.isCommandPending(pendingKey), false);
          const count = toasts.length;
          aircraftControl.handleResult(message);
          assert.equal(toasts.length, count, 'duplicate replies do not replace feedback');
          assert.equal(h.spokenReadbacks.length, spokenBefore + 1, 'caller settles once');
          assert.equal(sent.length, before + 1, 'unconfirmed results never trigger a retry');
        }
      }
    } finally { await h.controller.dispose(); aircraftControl.clearPendingRequests(); }
  }
});

test('direct gear buttons retain shared feedback and ignore replies from a retired profile', () => {
  setActivePinia(createPinia());
  const controls = useAircraftControlsStore(), sent = [], toasts = [], replies = [];
  const controller = createAircraftControlController({
    WebSocketRef: { OPEN: 1 }, getWs: () => ({ readyState: 1 }), getWsSend: () => message => sent.push(message),
    getAuthorizationScope: () => 'full-control', getSimconnectConnected: () => true,
    aircraftControlsStore: controls, showToast: (...toast) => toasts.push(toast),
  });
  controller.setActiveProfileToken({ _profileKey: 'test/gear', profileRevision: 1 });
  const requests = [
    [{ control: 'gear', operation: 'down' }, true, 'down'],
    [{ control: 'aircraft-specific', operation: 'execute', actionId: 'controls.gear.up' }, false, 'up'],
    [{ control: 'aircraft-specific', operation: 'execute', target: 'gear.handle.off' }, 'off', 'off'],
  ];
  for (const [request, confirmedValue, target] of requests) for (const confirmed of [true, false]) {
    assert.equal(controller.send(request, { onResult: result => replies.push(result) }), true);
    controller.handleResult({ request, requestId: sent.at(-1).requestId,
      ...(confirmed ? { ok: true, code: 'executed', confirmedValue }
        : { ok: false, code: 'aircraft_integration_readback_timeout', executionStarted: true }) });
    assert.equal(controls.feedback.actionText, confirmed ? `Gear ${target} selected.` : 'Gear selection not confirmed. Check the cockpit.');
    assert.deepEqual(controls.pendingCommands, {});
  }
  assert.equal(sent.length, 6); assert.equal(replies.length, 6);
  const request = requests[0][0];
  controller.send(request, { onResult: result => replies.push(result) });
  const requestId = sent.at(-1).requestId;
  controller.resetProfileState('Aircraft changed.');
  const before = { ...controls.feedback }, replyCount = replies.length, toastCount = toasts.length;
  controller.handleResult({ requestId, request, ok: false, executionStarted: true, code: 'aircraft_integration_readback_timeout' });
  assert.deepEqual(controls.feedback, before);
  assert.equal(toasts.length, toastCount); assert.equal(replies.length, replyCount);
  assert.deepEqual(controls.pendingCommands, {});
});

test('both altimeters voice feedback requires both readbacks and speaks partial failure', async () => {
  for (const confirmed of [true, false]) {
    const harness = createHarness({ catalogue: { configurationId: 'fbw-a32nx', profileKey: 'bundled/msfs/fbw-a32nx', profileRevision: 1, commands: {
      baro: { id: 'baro.both.std', label: 'Both standard pressure', input: { kind: 'none' }, speech: { patterns: ['both standard pressure'] } },
    } } });
    await harness.controller.initialize(); await harness.controller.begin(); await harness.controller.finish();
    await harness.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'both standard pressure' });
    assert.equal(harness.spokenReadbacks.length, 0);
    harness.completeLastCommand({ ok: confirmed, code: confirmed ? 'executed' : 'baro_readback_timeout',
      baro: { target: 'both', mode: 'std', confirmedSides: confirmed ? ['captain', 'firstOfficer'] : ['captain'] } });
    assert.equal(harness.sentCommands.length, 1);
    assert.equal(harness.voiceStore.status, confirmed ? 'sent' : 'error');
    assert.match(harness.spokenReadbacks[0], confirmed ? /Both altimeters standard pressure confirmed/ : /Captain standard pressure observed.*First officer unconfirmed/);
  }
});

test('disabled spoken feedback remains silent', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  harness.controller.setSpokenReadbacks(false);
  await harness.controller.begin();
  await harness.controller.finish();
  await harness.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero',
  });

  harness.completeLastCommand({ ok: true, requestId: 'ctrl-1' });
  assert.deepEqual(harness.spokenReadbacks, []);
});

test('voice feedback reports a correlated backend failure and remains retryable', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  await harness.controller.begin();
  await harness.controller.finish();
  await harness.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero',
  });

  harness.completeLastCommand({
    ok: false,
    requestId: 'ctrl-1',
    completedStepCount: 1,
    stepCount: 3,
    error: 'Aircraft readback did not confirm the requested position.',
  });
  assert.equal(harness.voiceStore.status, 'failed');
  assert.match(harness.voiceStore.statusText, /1 of 3 steps completed before failure/i);
  assert.match(harness.voiceStore.statusText, /verify aircraft state/i);
  assert.match(harness.voiceStore.statusText, /readback did not confirm/i);
  assert.deepEqual(harness.spokenReadbacks, ['Command failed. Verify aircraft state.']);
  const heldFailure = harness.voiceStore.statusText;
  harness.emitPtt({ type: 'error', error: 'Push-to-talk helper stopped' });
  assert.equal(harness.voiceStore.runtime.shortcutRegistered, false);
  assert.equal(harness.voiceStore.runtime.shortcutError, 'Push-to-talk helper stopped');
  assert.equal(harness.voiceStore.status, 'failed', 'a shortcut-helper failure must not hide correlated command feedback');
  assert.equal(harness.voiceStore.statusText, heldFailure);
  harness.controller.refreshReadyState();
  assert.equal(harness.voiceStore.status, 'failed', 'routine simState refresh must preserve correlated failure feedback');

  assert.equal(await harness.controller.begin(), true, 'the next PTT should allow an immediate retry after failure');
  const retrySessionId = harness.voiceStore.activeSessionId;
  await harness.controller.finish();
  await harness.emitRecognition({
    type: 'final', sessionId: retrySessionId, text: 'heading two seven zero',
  });
  harness.completeLastCommand({
    ok: false,
    requestId: 'ctrl-2',
    completedStepCount: 0,
    stepCount: 3,
    error: 'Aircraft profile changed before execution.',
  });
  assert.equal(harness.voiceStore.status, 'failed');
  assert.doesNotMatch(harness.voiceStore.statusText, /steps completed before failure/i);
  assert.doesNotMatch(harness.voiceStore.statusText, /verify aircraft state/i);
  assert.match(harness.voiceStore.statusText, /profile changed before execution/i);
});

test('voice feedback warns when preset execution starts but its first step is unconfirmed', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  await harness.controller.begin();
  await harness.controller.finish();
  await harness.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero',
  });

  harness.completeLastCommand({
    ok: false,
    requestId: 'ctrl-1',
    completedStepCount: 0,
    stepCount: 3,
    executionStarted: true,
    steps: [{ index: 0, ok: false, code: 'aircraft_integration_readback_timeout' }],
    error: 'The transport accepted the command, but readback did not confirm it.',
  });

  assert.equal(harness.voiceStore.status, 'failed');
  assert.match(harness.voiceStore.statusText, /0 of 3 steps confirmed before failure/i);
  assert.match(harness.voiceStore.statusText, /verify aircraft state/i);
});

test('single-step voice feedback distinguishes unconfirmed execution from preflight rejection', async () => {
  const unconfirmed = createHarness();
  await unconfirmed.controller.initialize();
  await unconfirmed.controller.begin();
  await unconfirmed.controller.finish();
  await unconfirmed.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero',
  });
  unconfirmed.completeLastCommand({
    ok: false,
    requestId: 'ctrl-1',
    completedStepCount: 0,
    stepCount: 1,
    executionStarted: true,
    error: 'Aircraft control request failed.',
  });
  assert.match(unconfirmed.voiceStore.statusText, /0 of 1 step confirmed before failure/i);
  assert.match(unconfirmed.voiceStore.statusText, /verify aircraft state/i);

  const preflight = createHarness();
  await preflight.controller.initialize();
  await preflight.controller.begin();
  await preflight.controller.finish();
  await preflight.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero',
  });
  preflight.completeLastCommand({
    ok: false,
    requestId: 'ctrl-1',
    completedStepCount: 0,
    stepCount: 1,
    steps: [{ index: 0, ok: false, code: 'action_cooldown' }],
    error: 'Aircraft profile changed before execution.',
  });
  assert.doesNotMatch(preflight.voiceStore.statusText, /confirmed before failure/i);
  assert.doesNotMatch(preflight.voiceStore.statusText, /verify aircraft state/i);
  assert.deepEqual(preflight.spokenReadbacks, ['Command failed.']);
});

test('aircraft context changes retire pending voice result ownership', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  await harness.controller.begin();
  await harness.controller.finish();
  await harness.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero',
  });
  assert.equal(harness.voiceStore.status, 'sending');

  harness.aircraftControlsStore.aircraftCommandCatalogue.profileRevision = 2;
  harness.controller.handleAircraftContextChange();
  assert.equal(harness.voiceStore.status, 'ready');
  harness.completeLastCommand({ ok: true, requestId: 'ctrl-stale' });
  assert.equal(harness.voiceStore.status, 'ready', 'a stale old-profile result must not overwrite the new context');
});

test('routine same-profile replay preserves the active utterance and pending result', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  await harness.controller.begin();

  harness.controller.handleAircraftContextChange({ preserveResult: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.cancellations, [], 'a cached profile replay must not cancel active push-to-talk');
  assert.equal(harness.voiceStore.status, 'listening');

  await harness.controller.finish();
  await harness.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero',
  });
  assert.equal(harness.voiceStore.status, 'sending');

  harness.aircraftControlsStore.availability = {
    enabled: false,
    reason: 'Waiting for current aircraft profile.',
  };
  harness.controller.handleSimulatorStateChange({ blocked: false });
  assert.equal(harness.voiceStore.status, 'sending', 'reconnect must not hide an in-flight command while its profile reloads');

  harness.aircraftControlsStore.availability = { enabled: true, reason: 'Ready.' };
  harness.controller.handleAircraftContextChange({ preserveResult: true });
  assert.equal(harness.voiceStore.status, 'sending', 'a cached profile replay must retain in-flight result ownership');
  harness.completeLastCommand({ ok: true, requestId: 'ctrl-1' });
  assert.equal(harness.voiceStore.status, 'sent');
  assert.match(harness.voiceStore.statusText, /sent selected heading/i);
});

test('routine capability loss preserves pending and held voice results when commands disappear', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  await harness.controller.begin();
  await harness.controller.finish();
  await harness.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero',
  });
  assert.equal(harness.voiceStore.status, 'sending');

  harness.aircraftControlsStore.aircraftCommandCatalogue.commands = {};
  harness.controller.handleAircraftContextChange({ preserveResult: true });
  assert.equal(harness.voiceStore.status, 'sending', 'capability loss must retain an in-flight result owner');

  harness.completeLastCommand({
    ok: false,
    completedStepCount: 1,
    stepCount: 3,
    error: 'Aircraft readback failed.',
  });
  assert.equal(harness.voiceStore.status, 'failed');
  assert.match(harness.voiceStore.statusText, /verify aircraft state/i);
  const heldWarning = harness.voiceStore.statusText;

  harness.controller.handleAircraftContextChange({ preserveResult: true });
  assert.equal(harness.voiceStore.status, 'failed', 'an empty replay must not hide the correlated warning');
  assert.equal(harness.voiceStore.statusText, heldWarning);
  assert.equal(await harness.controller.begin(), false, 'PTT must remain blocked when no executable voice commands exist');
  assert.equal(harness.voiceStore.statusText, heldWarning, 'a blocked PTT attempt must not dismiss the warning');
});

test('an aircraft revision change cancels capture and prevents stale voice dispatch', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  await harness.controller.begin();
  harness.aircraftControlsStore.aircraftCommandCatalogue.profileRevision = 2;
  harness.controller.handleAircraftContextChange();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.cancellations, ['session_12345678']);
  harness.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.sentCommands.length, 0);
});

test('a blocked simulator state cancels executable voice capture and return to flight restores it', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  await harness.controller.begin();

  harness.aircraftControlsStore.availability = {
    enabled: false,
    reason: 'Simulator is in a menu or loading state.',
  };
  harness.controller.handleSimulatorStateChange({ blocked: true });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.cancellations, ['session_12345678']);
  assert.equal(harness.voiceStore.status, 'blocked');
  assert.match(harness.voiceStore.statusText, /menu or loading state/i);
  assert.equal(await harness.controller.begin(), false, 'voice execution must remain blocked outside active flight');

  harness.aircraftControlsStore.availability = { enabled: true, reason: 'Ready.' };
  harness.controller.handleSimulatorStateChange({ blocked: false });
  assert.equal(harness.voiceStore.status, 'ready');
  assert.equal(await harness.controller.begin(), true, 'returning to active flight should restore voice PTT');
  const restoredSessionId = harness.voiceStore.activeSessionId;
  await harness.controller.finish();
  await harness.emitRecognition({
    type: 'final', sessionId: restoredSessionId, text: 'heading two seven zero',
  });
  assert.equal(harness.voiceStore.status, 'sending');

  harness.aircraftControlsStore.availability = {
    enabled: false,
    reason: 'Simulator is in a menu or loading state.',
  };
  harness.controller.handleSimulatorStateChange({ blocked: true });
  assert.equal(harness.voiceStore.status, 'sending', 'a blocked sim state must retain ownership of the in-flight result');
  harness.completeLastCommand({
    ok: false,
    completedStepCount: 0,
    stepCount: 3,
    executionStarted: true,
    steps: [{ index: 0, ok: false, code: 'aircraft_integration_readback_timeout' }],
    error: 'The transport accepted the command, but readback did not confirm it.',
  });
  assert.equal(harness.voiceStore.status, 'failed');
  assert.match(harness.voiceStore.statusText, /0 of 3 steps confirmed before failure/i);
  assert.match(harness.voiceStore.statusText, /verify aircraft state/i);
  harness.controller.handleSimulatorStateChange({ blocked: true });
  assert.equal(harness.voiceStore.status, 'failed', 'repeated blocked sim state must preserve the correlated warning');
  const heldWarning = harness.voiceStore.statusText;
  assert.equal(await harness.controller.begin(), false, 'global PTT must remain blocked while simulator writes are unavailable');
  assert.equal(harness.voiceStore.status, 'failed');
  assert.equal(harness.voiceStore.statusText, heldWarning, 'a blocked retry must not dismiss the verify-aircraft warning');

  harness.aircraftControlsStore.availability = {
    enabled: false,
    reason: 'Waiting for current aircraft profile.',
  };
  harness.controller.handleSimulatorStateChange({ blocked: false });
  assert.equal(harness.voiceStore.status, 'failed', 'the first reconnect state must not hide the held warning while profile data reloads');

  harness.aircraftControlsStore.availability = { enabled: true, reason: 'Ready.' };
  harness.controller.handleAircraftContextChange({ preserveResult: true });
  assert.equal(harness.voiceStore.status, 'failed', 'returning to flight should retain the result until the next PTT');
  assert.equal(await harness.controller.begin(), true, 'the next PTT should restore voice after the held result');
  await harness.controller.cancel('user');
});

test('a late aircraft-context mismatch rejects safely without disabling retry', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  await harness.controller.begin();
  await harness.controller.finish();
  harness.aircraftControlsStore.aircraftCommandCatalogue.profileRevision = 2;

  await harness.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero',
  });

  assert.equal(harness.sentCommands.length, 0);
  assert.equal(harness.voiceStore.status, 'error');
  assert.match(harness.voiceStore.statusText, /aircraft changed/i);
  assert.equal(await harness.controller.begin(), true);
  await harness.controller.cancel('user');
});

test('a command-catalogue race rejects safely without disabling retry', async () => {
  const harness = createHarness({ sendCommandResult: false });
  await harness.controller.initialize();
  await harness.controller.begin();
  await harness.controller.finish();

  await harness.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero',
  });

  assert.equal(harness.sentCommands.length, 1);
  assert.equal(harness.voiceStore.status, 'error');
  assert.match(harness.voiceStore.statusText, /no longer available/i);
  assert.equal(await harness.controller.begin(), true);
  await harness.controller.cancel('user');
});

test('a quick push-to-talk release during the press cue does not open a microphone session', async () => {
  let resolvePressCue;
  const pressCue = new Promise((resolve) => { resolvePressCue = resolve; });
  let recognitionStarts = 0;
  const harness = createHarness({
    startRecognition: async () => {
      recognitionStarts += 1;
      return { sessionId: 'session_12345678' };
    },
    pushToTalkTone: {
      play: (phase) => (phase === 'press' ? pressCue : Promise.resolve(true)),
      dispose: async () => {},
    },
  });
  await harness.controller.initialize();

  const beginning = harness.controller.begin();
  assert.equal(await harness.controller.finish(), true);
  resolvePressCue(true);

  assert.equal(await beginning, false);
  assert.equal(recognitionStarts, 0);
  assert.equal(harness.captures.length, 0);
  assert.equal(harness.voiceStore.status, 'ready');
});

test('a quick push-to-talk release is retained while recognition startup is pending', async () => {
  let resolvePressCue;
  const pressCue = new Promise((resolve) => { resolvePressCue = resolve; });
  let resolveRecognition;
  const recognition = new Promise((resolve) => { resolveRecognition = resolve; });
  let recognitionStarted;
  const started = new Promise((resolve) => { recognitionStarted = resolve; });
  const harness = createHarness({
    startRecognition: () => {
      recognitionStarted();
      return recognition;
    },
    pushToTalkTone: {
      play: (phase) => (phase === 'press' ? pressCue : Promise.resolve(true)),
      dispose: async () => {},
    },
  });
  await harness.controller.initialize();

  const beginning = harness.controller.begin();
  resolvePressCue(true);
  await started;
  assert.equal(await harness.controller.finish(), true);
  resolveRecognition({ sessionId: 'session_12345678' });

  assert.equal(await beginning, false);
  assert.deepEqual(harness.cancellations, ['session_12345678']);
  assert.equal(harness.captures.length, 0);
  assert.equal(harness.voiceStore.status, 'ready');
});

test('a recognizer final cannot dispatch before push-to-talk release', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  await harness.controller.begin();

  await harness.emitRecognition({
    type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero', reason: 'endpoint',
  });

  assert.equal(harness.sentCommands.length, 0);
  assert.equal(harness.voiceStore.status, 'error');
  assert.match(harness.voiceStore.statusText, /before push-to-talk was released/i);
  assert.equal(harness.captureCancellations.length, 1);
  assert.equal(await harness.controller.begin(), true, 'the rejected attempt should remain retryable');
  await harness.controller.cancel('user');
});

test('fatal recognizer failures close active and finishing microphone sessions and allow recovery', async () => {
  for (const finishing of [false, true]) {
    const harness = createHarness();
    await harness.controller.initialize();
    await harness.controller.begin();
    if (finishing) await harness.controller.finish();
    // Session-scoped failures from an earlier attempt must stay ignored.
    await harness.emitRecognition({ type: 'error', fatal: true, sessionId: 'session_old', message: 'Old error.' });
    assert.equal(harness.captureCancellations.length, 0);
    const message = 'Local voice worker stopped.';
    const failed = harness.emitRecognition({ type: 'error', fatal: true, code: 'WORKER_FAILED', message });
    harness.emitRuntime({ available: false, enabled: true, error: message });
    await failed;
    assert.equal(harness.captureCancellations.length, 1);
    assert.equal(harness.voiceStore.activeSessionId, '');
    assert.equal(harness.voiceStore.status, 'unavailable');
    assert.equal(harness.voiceStore.statusText, message);
    await harness.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero' });
    assert.equal(harness.sentCommands.length, 0);
    assert.equal(await harness.controller.finish(), false);
    assert.equal(await harness.controller.begin(), false);
    harness.emitRuntime({ available: true, enabled: true });
    assert.equal(await harness.controller.begin(), true);
    await harness.controller.cancel('user');
  }
});

test('runtime loss during recognition startup prevents late microphone capture', async () => {
  let resolveRecognition;
  let signalStarted;
  const recognition = new Promise(resolve => { resolveRecognition = resolve; });
  const started = new Promise(resolve => { signalStarted = resolve; });
  const harness = createHarness({
    startRecognition() { signalStarted(); return recognition; },
  });
  await harness.controller.initialize();
  const beginning = harness.controller.begin();
  await started;
  harness.emitRuntime({ available: false, enabled: true, error: 'Local voice worker stopped.' });
  await new Promise(resolve => setImmediate(resolve));
  resolveRecognition({ sessionId: 'session_12345678' });
  assert.equal(await beginning, false);
  assert.equal(harness.captures.length, 0);
  assert.equal(harness.voiceStore.activeSessionId, '');
  assert.equal(harness.voiceStore.status, 'unavailable');
  assert.equal(harness.sentCommands.length, 0);
  assert.ok(harness.cancellations.includes('session_12345678'));
});

test('push-to-talk release sends the final flushed PCM chunk before recognition finishes', async () => {
  const harness = createHarness({ chunkOnStop: true });
  await harness.controller.initialize();
  await harness.controller.begin();

  assert.equal(await harness.controller.finish(), true);
  assert.equal(harness.captureStops.length, 1);
  assert.equal(harness.audio.length, 1);
  assert.equal(harness.audio[0].sequence, 0);
});

test('push-to-talk release keeps accepting audio during a bounded tail before flush', async () => {
  const harness = createHarness({ releaseTailMs: 25 });
  await harness.controller.initialize();
  await harness.controller.begin();

  const finishing = harness.controller.finish();
  assert.equal(harness.captureStops.length, 0, 'capture must remain open during the release tail');
  harness.captures[0].callbacks.onChunk({
    sampleRate: 48000,
    samples: new Float32Array([0.4, -0.4]),
    sequence: 0,
  });
  assert.equal(await finishing, true);

  assert.equal(harness.captureStops.length, 1);
  assert.equal(harness.audio.length, 1, 'tail audio must reach recognition before capture is flushed');
  assert.equal(harness.audio[0].sequence, 0);
});

test('push-to-talk cues bracket capture without adding sound to microphone audio', async () => {
  const harness = createHarness({ chunkOnStop: true });
  await harness.controller.initialize();
  await harness.controller.begin();

  assert.deepEqual(harness.toneEvents, [{ phase: 'press', stoppedCaptures: 0 }]);
  assert.equal(await harness.controller.finish(), true);
  assert.equal(harness.audio.length, 1, 'the final microphone chunk is sent before the release cue');
  assert.deepEqual(harness.toneEvents, [
    { phase: 'press', stoppedCaptures: 0 },
    { phase: 'release', stoppedCaptures: 1 },
  ]);
});

// Deliberately pending browser replies exercise the real capture/controller
// boundary; they do not reproduce a physical microphone or browser failure.
function createPendingPcmCloseFixture() {
  const tracks = [];
  const nodes = [];
  const contexts = [];
  const events = [];
  class AudioContext {
    constructor() {
      this.state = 'running';
      this.sampleRate = 48000;
      this.destination = {};
      this.audioWorklet = { addModule: async () => {} };
      this.closeCalls = 0;
      this.closeSettled = false;
      this.closeReply = new Promise(resolve => { this.resolveClose = () => {
        this.closeSettled = true;
        resolve();
      }; });
      contexts.push(this);
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    close() {
      this.closeCalls += 1;
      this.state = 'closed';
      events.push('close-request');
      return this.closeReply;
    }
  }
  class AudioWorkletNode {
    constructor() {
      this.port = {
        onmessage: null,
        close() {},
        postMessage: message => {
          if (message.type !== 'flush') return;
          queueMicrotask(() => {
            events.push('final-pcm');
            this.port.onmessage?.({ data: { type: 'pcm', samples: new Float32Array([0.25, -0.25]) } });
            this.port.onmessage?.({ data: { type: 'flushed' } });
          });
        },
      };
      nodes.push(this);
    }
    connect() {}
    disconnect() {}
  }
  const globalRef = {
    isSecureContext: true, AudioContext, AudioWorkletNode, setTimeout, clearTimeout,
    navigator: { mediaDevices: { async getUserMedia() {
      const track = {
        readyState: 'live', label: 'Synthetic microphone',
        addEventListener() {}, removeEventListener() {},
        stop() { this.readyState = 'ended'; events.push('track-stop'); },
      };
      tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] };
    } } },
  };
  return {
    tracks, nodes, contexts, events,
    createCapture: callbacks => createPcmCapture({ ...callbacks, globalRef }),
    resolveAllCloses: () => contexts.forEach(context => context.resolveClose()),
  };
}

test('PTT completion and retry do not await browser context closure', async t => {
  const browser = createPendingPcmCloseFixture();
  const harness = createHarness({
    createCapture: browser.createCapture,
    controllerApi: { async finishRecognition() { browser.events.push('recognition-finish'); } },
    pushToTalkTone: {
      async play(phase) {
        if (phase === 'release') browser.events.push('release-cue');
        return true;
      },
      async dispose() {},
    },
  });
  t.after(async () => { browser.resolveAllCloses(); await harness.controller.dispose(); });
  await harness.controller.initialize();
  assert.equal(await harness.controller.begin(), true);
  const staleMessage = browser.nodes[0].port.onmessage;
  let completed = false;
  const finishing = harness.controller.finish().then(result => { completed = true; return result; });
  // Drain this operation's promise jobs without resolving browser close.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, true, 'PTT completion must not wait for the browser close reply');
  assert.equal(await finishing, true);
  assert.deepEqual(browser.events, ['final-pcm', 'track-stop', 'close-request', 'release-cue', 'recognition-finish']);
  assert.equal(harness.audio.length, 1);
  assert.equal(harness.audio[0].sequence, 0);
  assert.equal(browser.contexts[0].closeCalls, 1);
  assert.equal(browser.contexts[0].closeSettled, false);
  await harness.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero' });
  assert.equal(harness.sentCommands.length, 1);
  harness.completeLastCommand({ ok: true });
  assert.equal(await harness.controller.begin(), true, 'a fresh PTT attempt can begin while old closure is pending');
  browser.contexts[0].resolveClose();
  staleMessage({ data: { type: 'pcm', samples: new Float32Array([0.1]) } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(browser.tracks[1].readyState, 'live');
  assert.equal(harness.voiceStore.status, 'listening');
  assert.equal(harness.audio.length, 1, 'the retired capture cannot send audio into the new session');
  assert.equal(harness.sentCommands.length, 1);
});

test('voice disable settles with browser context closure pending and prevents late dispatch', async t => {
  const browser = createPendingPcmCloseFixture();
  const harness = createHarness({ createCapture: browser.createCapture });
  t.after(async () => { browser.resolveAllCloses(); await harness.controller.dispose(); });
  await harness.controller.initialize();
  await harness.controller.begin();
  const finishing = harness.controller.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(browser.tracks[0].readyState, 'ended');
  assert.equal(browser.contexts[0].closeSettled, false);
  let disabled = false;
  const disabling = harness.voiceStore.actions.setRecognitionEnabled(false).then(() => { disabled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disabled, true, 'turning voice off must not wait for the browser close reply');
  await disabling;
  await finishing;
  assert.equal(harness.voiceStore.runtime.enabled, false);
  assert.deepEqual(harness.cancellations, ['session_12345678']);
  await harness.emitRecognition({ type: 'final', sessionId: 'session_12345678', text: 'heading two seven zero' });
  browser.contexts[0].resolveClose();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(harness.sentCommands, []);
  assert.equal(harness.voiceStore.activeSessionId, '');
  assert.equal(browser.contexts[0].closeCalls, 1);
});

for (const event of [
  { type: 'error', code: 'CAPTURE_TIMEOUT', message: 'Voice capture exceeded ten seconds. Please try a shorter request.' },
  { type: 'cancelled', reason: 'user' },
]) {
  test(`recognition ${event.type} settles and permits retry while browser context closure is pending`, async t => {
    const browser = createPendingPcmCloseFixture();
    const harness = createHarness({ createCapture: browser.createCapture, runtimeInfo: cloudRuntime });
    t.after(async () => { browser.resolveAllCloses(); await harness.controller.dispose(); });
    await harness.controller.initialize();
    assert.equal(await harness.controller.begin(), true);
    const staleMessage = browser.nodes[0].port.onmessage;
    let settled = false;
    const terminated = harness.emitRecognition({ ...event, sessionId: 'session_12345678' })
      .then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true, 'a terminal event must settle without the browser close reply');
    await terminated;
    assert.equal(browser.tracks[0].readyState, 'ended');
    assert.equal(browser.contexts[0].closeCalls, 1);
    assert.equal(browser.contexts[0].closeSettled, false);
    assert.equal(harness.voiceStore.activeSessionId, '');
    assert.equal(harness.voiceStore.status, event.type === 'error' ? 'error' : 'ready');
    if (event.type === 'error') assert.equal(harness.voiceStore.statusText, event.message);
    else assert.match(harness.voiceStore.statusText, /hold|push-to-talk/i);
    assert.deepEqual(harness.sentCommands, []);
    assert.deepEqual(harness.audio, []);

    assert.equal(await harness.controller.begin(), true, 'the next PTT attempt must not wait for old closure');
    await harness.emitRecognition(cloudFinal());
    staleMessage({ data: { type: 'pcm', samples: new Float32Array([0.1]) } });
    browser.contexts[0].resolveClose();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(browser.tracks[1].readyState, 'live');
    assert.equal(harness.voiceStore.activeSessionId, 'session_next_2');
    assert.equal(harness.voiceStore.status, 'listening');
    assert.equal(browser.contexts[0].closeCalls, 1);
    assert.deepEqual(harness.sentCommands, [], 'the retired result cannot dispatch a command');
    assert.deepEqual(harness.audio, [], 'the retired capture cannot upload audio into the new session');
    assert.deepEqual(harness.spokenReadbacks, []);
  });
}

test('microphone capture failures stay visible instead of being replaced by ready state', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  await harness.controller.begin();

  harness.captures[0].callbacks.onError(new Error('Microphone permission was denied.'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.voiceStore.status, 'error');
  assert.match(harness.voiceStore.statusText, /permission was denied/i);
  assert.deepEqual(harness.cancellations, ['session_12345678']);
  assert.equal(harness.captureCancellations.length, 1);
  assert.equal(await harness.controller.begin(), true, 'the next PTT should recover from the visible error');
  await harness.controller.cancel('user');
});

test('recognition finalization failures stay visible and remain retryable', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  await harness.controller.begin();
  harness.captures[0].stop = async () => {
    throw new Error('Audio flush failed.');
  };

  assert.equal(await harness.controller.finish(), false);
  assert.equal(harness.voiceStore.status, 'error');
  assert.match(harness.voiceStore.statusText, /audio flush failed/i);
  assert.deepEqual(harness.cancellations, ['session_12345678']);
  assert.equal(await harness.controller.begin(), true, 'the next PTT should recover after a finalization failure');
  await harness.controller.cancel('user');
});
