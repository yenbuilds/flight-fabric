import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceSetupTest, initialVoiceTestState } from './voice-setup-test.js';

function harness(options = {}) {
  const state = { runtime: { enabled: true, available: true }, selectedInputDeviceId: 'selected-mic',
    spokenReadbacks: false, voiceTest: initialVoiceTestState(),
    setVoiceTestState(patch) { this.voiceTest = { ...this.voiceTest, ...patch }; },
    setInputDevicesError(value) { this.inputDevicesError = value; },
  };
  const calls = [], captures = [], contexts = [], scheduled = new Map();
  let id = 0;
  const timers = { setTimeout(fn, ms) { const key = ++id; scheduled.set(key, { fn, ms }); return key; }, clearTimeout(key) { scheduled.delete(key); } };
  const api = { startRecognition: options.start || (async () => ({ sessionId: 'test-session' })),
    sendAudio(payload) { calls.push(['audio', payload]); },
    async finishRecognition(sessionId) { calls.push(['finish', sessionId]); return { finishing: true }; },
    async cancelRecognition(sessionId) { calls.push(['cancel', sessionId]); },
    async speakReadback(text) { calls.push(['speak', text]); return { started: true }; },
  };
  class AudioContext {
    state = 'running'; destination = {}; closed = false;
    constructor() {
      contexts.push(this);
      if (options.resume) { this.state = 'suspended'; this.resume = options.resume; }
    }
    createBufferSource() {
      if (options.outputError) throw new Error('Output unavailable');
      this.source = { connect() {}, disconnect() {}, stop() {}, start() {} };
      return this.source;
    }
    createBuffer(_channels, frames, rate) {
      this.rate = rate; this.samples = new Float32Array(frames);
      return { getChannelData: () => this.samples };
    }
    async close() { this.closed = true; }
  }
  const controller = createVoiceSetupTest({ api, voiceStore: state, timers,
    canStart: options.canStart || (() => true),
    globalRef: { AudioContext },
    cancelReadback: () => calls.push(['cancel-readback']),
    createCapture(callbacks) {
      const capture = { callbacks,
        start: options.captureStart || (async () => ({ deviceLabel: 'Selected microphone', sampleRate: 48000 })),
        async stop() { calls.push(['capture-stop']); },
        async cancel() { calls.push(['capture-cancel']); },
      };
      captures.push(capture); return capture;
    },
  });
  const audio = (values = new Float32Array([0.2, -0.2]), sampleRate = 48000) => captures.at(-1).callbacks.onChunk({ samples: values, sampleRate });
  const final = text => controller.handleRecognitionEvent({ type: 'final', sessionId: 'test-session', text });
  return { state, calls, captures, contexts, controller, scheduled, audio, final, api };
}

test('voice setup uses selected microphone and real recognition API without changing preferences', async () => {
  const h = harness();
  assert.equal(await h.controller.start(), true);
  assert.equal(h.captures[0].callbacks.deviceId, 'selected-mic');
  h.audio();
  assert(h.state.voiceTest.level > 0);
  assert.equal(h.state.voiceTest.heardAudio, true);
  await h.controller.finish();
  assert(h.calls.findIndex(([type]) => type === 'capture-stop') < h.calls.findIndex(([type]) => type === 'finish'));
  await h.final('SET HEADING TWO SEVEN ZERO');
  assert.equal(h.state.voiceTest.recognized, true);
  assert.match(h.state.voiceTest.message, /No command was sent/);
  assert.equal(h.state.voiceTest.playbackAvailable, true);
  assert.equal(h.state.spokenReadbacks, false);
  assert.equal(h.state.selectedInputDeviceId, 'selected-mic');
  assert.deepEqual(h.state.runtime, { enabled: true, available: true });
  assert.equal(h.scheduled.size, 0);
  await h.controller.dispose();
});

test('sample accepts numeric transcription and rejects a different heading or aircraft command', async () => {
  for (const [text, recognized] of [['Set heading 270.', true], ['set heading two seventy degrees', true],
    ['set heading two eight zero', false], ['release parking brake', false]]) {
    const h = harness();
    await h.controller.start(); h.audio(); await h.controller.finish(); await h.final(text);
    assert.equal(h.state.voiceTest.recognized, recognized, text);
    assert.equal(h.state.voiceTest.transcript, text);
    assert.equal(h.calls.some(([type]) => type === 'speak'), false, 'recognition does not trigger readbacks');
    await h.controller.dispose();
  }
});

test('silence is distinct from audible input without a transcript', async () => {
  for (const [value, message] of [[0, /No sound detected/], [0.1, /Sound detected, but no speech/]]) {
    const h = harness();
    await h.controller.start(); h.audio(new Float32Array([value, -value]));
    await h.controller.finish(); await h.final('');
    assert.match(h.state.voiceTest.message, message);
    assert.equal(h.state.voiceTest.recognized, false);
    await h.controller.dispose();
  }
});

test('recording and recognition stop automatically with a five-second PCM memory cap', async () => {
  const h = harness();
  await h.controller.start();
  for (let n = 0; n < 150; n++) h.audio(new Float32Array(2048).fill(0.1));
  await new Promise(resolve => setImmediate(resolve));
  const sent = h.calls.filter(([type]) => type === 'audio');
  assert.equal(sent.reduce((sum, [, payload]) => sum + payload.samples.byteLength / 4, 0), 48000 * 5);
  assert.deepEqual(sent.map(([, payload]) => payload.sequence), sent.map((_, index) => index));
  assert.equal(h.calls.filter(([type]) => type === 'finish').length, 1);
  await h.final('set heading 270');
  assert.equal(await h.controller.playRecording(), true);
  assert.equal(h.contexts[0].samples.length, 48000 * 5);
  assert.equal(await h.controller.start(), false, 'playback excludes microphone capture');
  await h.controller.cancel();
  assert.equal(h.contexts[0].closed, true);
  assert.equal(h.state.voiceTest.playbackAvailable, false);
  assert.equal(h.scheduled.size, 0);
});

test('wall-clock limit finishes even when microphone chunks stop arriving', async () => {
  const h = harness();
  await h.controller.start();
  const timer = [...h.scheduled.values()].find(entry => entry.ms === 5000);
  timer.fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.voiceTest.phase, 'recognizing');
  assert.equal(h.calls.filter(([type]) => type === 'finish').length, 1);
  await h.controller.cancel();
});

test('disabled or unavailable recognition stays explicit and never opens a microphone', async () => {
  for (const runtime of [{ enabled: false, available: false }, { enabled: true, available: false, error: 'Model missing' }]) {
    const h = harness(); h.state.runtime = runtime;
    assert.equal(await h.controller.start(), false);
    assert.equal(h.captures.length, 0);
    assert.deepEqual(h.state.runtime, runtime);
    assert.match(h.state.voiceTest.message, runtime.enabled ? /Model missing/ : /Enable voice control/);
  }
});

test('busy normal voice or discovery excludes tests and spoken feedback', async () => {
  const h = harness({ canStart: () => false });
  assert.equal(await h.controller.start(), false);
  assert.equal(await h.controller.testSpokenFeedback(), false);
  assert.deepEqual(h.calls, []);
});

test('permission failures release the recognition session and report an actionable error', async () => {
  const h = harness({ captureStart: async () => { throw new Error('Microphone access denied'); } });
  assert.equal(await h.controller.start(), false);
  assert.match(h.state.voiceTest.message, /Microphone access denied/);
  assert(h.calls.some(([type, session]) => type === 'cancel' && session === 'test-session'));
  assert(h.calls.some(([type]) => type === 'capture-cancel'));
  assert.equal(h.controller.busy, false);
});

test('navigation during a pending start cancels its late session without opening the microphone', async () => {
  let resolveStart;
  const h = harness({ start: () => new Promise(resolve => { resolveStart = resolve; }) });
  const started = h.controller.start();
  assert.equal(h.controller.busy, true);
  await h.controller.cancel();
  resolveStart({ sessionId: 'late-session' });
  assert.equal(await started, false);
  assert.equal(h.captures.length, 0);
  assert(h.calls.some(([type, session]) => type === 'cancel' && session === 'late-session'));
  assert.equal(h.state.voiceTest.phase, 'idle');
});

test('cancel and fatal errors close capture; stale final results cannot resurrect tests', async () => {
  for (const failure of [false, true]) {
    const h = harness(); await h.controller.start(); h.audio();
    if (failure) await h.controller.handleRecognitionEvent({ type: 'error', fatal: true, message: 'Engine stopped' });
    else await h.controller.cancel();
    const state = { ...h.state.voiceTest };
    await h.final('set heading two seven zero');
    assert.deepEqual(h.state.voiceTest, state);
    assert.equal(h.state.voiceTest.playbackAvailable, false);
    assert.equal(h.scheduled.size, 0);
    assert(h.calls.some(([type]) => type === 'capture-cancel'));
  }
});

test('lost finalization times out and releases capture and recognition', async () => {
  const h = harness(); await h.controller.start(); h.audio(); await h.controller.finish();
  [...h.scheduled.values()].find(entry => entry.ms === 15000).fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.state.voiceTest.message, /timed out/);
  assert.equal(h.controller.busy, false);
  assert.equal(h.scheduled.size, 0);
});

test('spoken feedback can be tested with recognition and saved readbacks off', async () => {
  const h = harness(); h.state.runtime = { enabled: false, available: false };
  assert.equal(await h.controller.testSpokenFeedback(), true);
  assert(h.calls.some(([type, text]) => type === 'speak' && text === 'Spoken feedback is working.'));
  assert.equal(h.captures.length, 0);
  assert.equal(h.state.spokenReadbacks, false);
  assert.equal(h.state.runtime.enabled, false);
  await h.controller.cancel();
  assert.equal(h.state.voiceTest.feedbackMessage, '');
});

test('an idle test does not cancel ordinary command readbacks when Settings closes', async () => {
  const h = harness(); await h.controller.cancel();
  assert.deepEqual(h.calls, []);
});

test('playback setup failure closes its audio context and preserves an actionable result', async () => {
  const h = harness({ outputError: true });
  await h.controller.start(); h.audio(); await h.controller.finish(); await h.final('set heading 270');
  assert.equal(await h.controller.playRecording(), false);
  assert.equal(h.contexts[0].closed, true);
  assert.equal(h.controller.busy, false);
  assert.match(h.state.voiceTest.message, /playback failed/);
  await h.controller.dispose();
});

test('navigation while output is opening prevents late playback and clears its recording', async () => {
  let resume;
  const h = harness({ resume: () => new Promise(resolve => { resume = resolve; }) });
  await h.controller.start(); h.audio(); await h.controller.finish(); await h.final('set heading 270');
  const playback = h.controller.playRecording();
  await h.controller.cancel();
  resume();
  assert.equal(await playback, false);
  assert.equal(h.contexts[0].closed, true);
  assert.equal(h.state.voiceTest.phase, 'idle');
  assert.equal(h.state.voiceTest.playbackAvailable, false);
  assert.equal(h.scheduled.size, 0);
});
