import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceControlController } from './voice-controller.js';

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
  const aircraftControlsStore = {
    availability: options.availability || { enabled: true, reason: 'Ready.' },
    aircraftCommandCatalogue: options.catalogue || defaultCatalogue,
  };
  const sentCommands = [];
  const aircraftControl = {
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
    inputDevices: [], selectedInputDeviceId: '', spokenReadbacks: true,
  };
  const voiceStore = Object.assign(state, {
    bindRuntime(actions) { this.actions = actions; },
    applyRuntimeInfo(info) {
      this.runtime = {
        available: info.available === true,
        development: info.development === true,
        enabled: info.enabled === true,
        error: info.error || '',
        modelId: info.engine?.modelId || '',
        shortcut: typeof info.pushToTalk?.accelerator === 'string'
          ? info.pushToTalk.accelerator
          : '',
        shortcutError: info.pushToTalk?.error || '',
        shortcutRegistered: info.pushToTalk?.registered === true,
      };
    },
    setState(status, text) { this.status = status; this.statusText = text; },
    setSession(value) { this.activeSessionId = value; },
    setTranscript(value) { this.transcript = value; },
    setLastCommand(value) { this.lastCommand = value; },
    setDeviceLabel(value) { this.deviceLabel = value; },
    setInputDevices(value) { this.inputDevices = value; },
    setSelectedInputDevice(value) { this.selectedInputDeviceId = String(value || ''); },
    setSpokenReadbacks(value) { this.spokenReadbacks = value === true; },
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
  const createCapture = (callbacks) => {
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
  };
  const controller = createVoiceControlController({
    api, aircraftControl, aircraftControlsStore, voiceStore, createCapture,
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
  assert.equal(harness.sentCommands[0].options.pendingKey, 'voice:flightGuidance.heading.set');
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
