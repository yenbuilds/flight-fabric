import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PcmCapture,
  createMicrophoneConstraints,
  discoverAudioInputDevices,
  enumerateAudioInputDevices,
} from './pcm-capture.js';

test('microphone constraints preserve raw capture by default', () => {
  assert.deepEqual(createMicrophoneConstraints(), {
    video: false,
    audio: {
      channelCount: { ideal: 1 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
});

test('microphone constraints target the selected input and keep browser processing disabled', () => {
  assert.deepEqual(createMicrophoneConstraints({
    deviceId: ' cockpit-mic ',
  }), {
    video: false,
    audio: {
      channelCount: { ideal: 1 },
      deviceId: { exact: 'cockpit-mic' },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
});

test('audio input enumeration is bounded, labelled, and de-duplicated', async () => {
  const mediaDevices = {
    async enumerateDevices() {
      assert.equal(this, mediaDevices);
      return [
        { kind: 'audioinput', deviceId: 'default', label: 'Default - USB headset' },
        { kind: 'videoinput', deviceId: 'camera', label: 'Camera' },
        { kind: 'audioinput', deviceId: 'usb-mic', label: '' },
        { kind: 'audioinput', deviceId: 'usb-mic', label: 'Duplicate' },
        { kind: 'audioinput', deviceId: '', label: 'Hidden input' },
      ];
    },
  };

  assert.deepEqual(await enumerateAudioInputDevices({ navigator: { mediaDevices } }), [
    { deviceId: 'default', label: 'Default - USB headset' },
    { deviceId: 'usb-mic', label: 'Microphone 2' },
  ]);
  assert.deepEqual(await enumerateAudioInputDevices({}), []);
});

test('explicit microphone discovery closes its temporary stream without reading audio', async () => {
  let requestedConstraints = null;
  let trackStops = 0;
  const mediaDevices = {
    async getUserMedia(constraints) {
      requestedConstraints = constraints;
      return { getTracks: () => [{ stop: () => { trackStops += 1; } }] };
    },
    async enumerateDevices() {
      return [
        { kind: 'audioinput', deviceId: 'default', label: 'Default microphone' },
        { kind: 'audioinput', deviceId: 'usb-headset', label: 'USB headset' },
      ];
    },
  };

  assert.deepEqual(
    await discoverAudioInputDevices({ navigator: { mediaDevices } }),
    [
      { deviceId: 'default', label: 'Default microphone' },
      { deviceId: 'usb-headset', label: 'USB headset' },
    ],
  );
  assert.deepEqual(requestedConstraints, createMicrophoneConstraints());
  assert.equal(trackStops, 1);
});

test('PCM capture sends the selected microphone constraints to getUserMedia', async () => {
  let requestedConstraints = null;
  const track = {
    label: 'Cockpit headset',
    readyState: 'live',
    addEventListener() {},
    removeEventListener() {},
    stop() {},
  };
  const stream = {
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
    getTracks: () => [track],
  };
  class FakeAudioContext {
    constructor() {
      this.audioWorklet = { addModule: async () => {} };
      this.destination = {};
      this.sampleRate = 48_000;
      this.state = 'running';
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async close() { this.state = 'closed'; }
  }
  class FakeAudioWorkletNode {
    constructor() {
      this.port = { close() {}, onmessage: null, postMessage() {} };
      this.onprocessorerror = null;
    }
    connect() {}
    disconnect() {}
  }
  const globalRef = {
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeAudioWorkletNode,
    clearTimeout,
    isSecureContext: true,
    navigator: {
      mediaDevices: {
        async getUserMedia(constraints) {
          requestedConstraints = constraints;
          return stream;
        },
      },
    },
    setTimeout,
  };
  const capture = new PcmCapture({
    deviceId: 'cockpit-mic',
    globalRef,
  });

  assert.deepEqual(await capture.start(), {
    chunkFrames: 2048,
    deviceLabel: 'Cockpit headset',
    sampleRate: 48_000,
  });
  assert.deepEqual(requestedConstraints, createMicrophoneConstraints({
    deviceId: 'cockpit-mic',
  }));
  await capture.cancel();
  assert.equal(capture.state, 'idle');
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// These fakes simulate browser reply timing, not physical microphone behavior.
function createLifecycleHarness({ pauseAt = '', failAt = '', pendingClose = false } = {}) {
  const pending = deferred();
  const reachedPause = deferred();
  const closeReply = deferred();
  const counters = { tracksStopped: 0, contextsCreated: 0, sourcesDisconnected: 0, nodesDisconnected: 0 };
  const listeners = new Map();
  const nodes = [];
  const contexts = [];
  const timers = new Map();
  const chunks = [];
  const errors = [];
  let nextTimer = 0;
  const track = {
    label: 'USB headset',
    readyState: 'live',
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    stop() { counters.tracksStopped += 1; this.readyState = 'ended'; },
  };
  const stream = { getAudioTracks: () => [track], getVideoTracks: () => [], getTracks: () => [track] };
  async function browserReply(stage, value) {
    if (stage === pauseAt) {
      reachedPause.resolve();
      await pending.promise;
    }
    if (stage === failAt) throw new Error(`Browser ${stage} failed.`);
    return value;
  }
  class AudioContext {
    constructor() {
      counters.contextsCreated += 1;
      contexts.push(this);
      this.sampleRate = 48_000;
      this.destination = {};
      this.state = 'suspended';
      this.audioWorklet = { addModule: () => browserReply('worklet') };
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() { counters.sourcesDisconnected += 1; } };
    }
    async resume() { await browserReply('resume'); if (this.state !== 'closed') this.state = 'running'; }
    async close() {
      this.closeRequests = (this.closeRequests || 0) + 1;
      this.state = 'closed';
      if (pendingClose) await closeReply.promise;
    }
  }
  class AudioWorkletNode {
    constructor() {
      nodes.push(this);
      this.messages = [];
      this.port = { onmessage: null, close() {}, postMessage: (message) => this.messages.push(message) };
    }
    connect() {}
    disconnect() { counters.nodesDisconnected += 1; }
  }
  const globalRef = {
    isSecureContext: true,
    AudioContext,
    AudioWorkletNode,
    navigator: { mediaDevices: { getUserMedia: () => browserReply('permission', stream) } },
    setTimeout(callback, milliseconds) {
      const id = ++nextTimer;
      timers.set(id, { callback, milliseconds });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const capture = new PcmCapture({
    globalRef,
    onChunk: (chunk) => chunks.push(chunk),
    onError: (error) => errors.push(error),
  });
  return { capture, pending, reachedPause, closeReply, counters, track, listeners, nodes, contexts, timers, chunks, errors };
}

test('PCM cancellation closes tracks across delayed microphone and audio initialization replies', async (t) => {
  for (const pauseAt of ['permission', 'worklet', 'resume']) {
    await t.test(pauseAt, async (t) => {
      const h = createLifecycleHarness({ pauseAt, pendingClose: true });
      t.after(() => { h.pending.resolve(); h.closeReply.resolve(); });
      const startup = h.capture.start();
      const rejectedStartup = assert.rejects(startup, { name: 'AbortError' });
      await h.reachedPause.promise;
      let cancelled = false;
      const cancellation = h.capture.cancel().then(() => { cancelled = true; });
      await new Promise(setImmediate);
      assert.equal(cancelled, true, 'startup cancellation cannot wait for context closure');
      await cancellation;
      assert.equal(h.capture.state, 'idle');
      assert.equal(h.counters.tracksStopped, pauseAt === 'permission' ? 0 : 1);
      h.pending.resolve();
      await rejectedStartup;
      assert.equal(h.counters.tracksStopped, 1, 'late permission grants must close before capture can start');
      assert.equal(h.counters.contextsCreated, pauseAt === 'permission' ? 0 : 1);
      assert.equal(h.capture.state, 'idle');
      assert.equal(h.listeners.size, 0);
      assert.equal(h.chunks.length, 0);
      assert.equal(h.errors.length, 0, 'intentional cancellation is not a microphone failure');
      assert.ok(h.contexts.every((context) => context.state === 'closed'));
      assert.ok(h.contexts.every((context) => context.closeRequests === 1), 'late startup cleanup cannot close the context again');
    });
  }
});

test('PCM initialization failures release every acquired microphone track', async (t) => {
  for (const failAt of ['permission', 'worklet', 'resume']) {
    await t.test(failAt, async () => {
      const h = createLifecycleHarness({ failAt });
      await assert.rejects(h.capture.start(), new RegExp(`Browser ${failAt} failed`));
      assert.equal(h.counters.tracksStopped, failAt === 'permission' ? 0 : 1);
      assert.equal(h.capture.state, 'idle');
      assert.equal(h.listeners.size, 0);
      assert.equal(h.errors.length, 1);
      assert.ok(h.contexts.every((context) => context.state === 'closed'));
    });
  }
});

test('PCM cancellation settles with browser context closure pending and permits a fresh capture', async () => {
  const h = createLifecycleHarness({ pendingClose: true });
  await h.capture.start();
  const staleMessageHandler = h.nodes[0].port.onmessage;
  let settled = false;
  const cancel = h.capture.cancel().then(() => { settled = true; });
  try {
    assert.equal(h.counters.tracksStopped, 1);
    assert.equal(h.nodes[0].port.onmessage, null);
    assert.equal(h.counters.nodesDisconnected, 1);
    assert.equal(h.counters.sourcesDisconnected, 1);
    await new Promise(setImmediate);
    assert.equal(settled, true, 'cancellation must not depend on the browser close reply');
    assert.equal(h.capture.state, 'idle');
    assert.equal(h.listeners.size, 0);

    const nextTrack = { ...h.track, readyState: 'live' };
    h.capture.globalRef.navigator.mediaDevices.getUserMedia = async () => ({
      getAudioTracks: () => [nextTrack], getVideoTracks: () => [], getTracks: () => [nextTrack],
    });
    await h.capture.start();
    h.closeReply.reject(new Error('Retired browser context close failed.'));
    staleMessageHandler({ data: { type: 'pcm', samples: new Float32Array(128) } });
    await new Promise(setImmediate);
    assert.equal(h.capture.state, 'running');
    assert.equal(nextTrack.readyState, 'live');
    assert.equal(h.counters.tracksStopped, 1);
    assert.equal(h.contexts[0].closeRequests, 1);
    assert.equal(h.chunks.length, 0);
    assert.equal(h.errors.length, 0);
  } finally {
    h.closeReply.resolve();
    await cancel;
    await h.capture.cancel();
  }
});

test('PCM release preserves final audio while browser context closure remains pending', async () => {
  const h = createLifecycleHarness({ pendingClose: true });
  await h.capture.start();
  let settled = false;
  const stop = h.capture.stop().then(() => { settled = true; });
  try {
    assert.equal(h.track.readyState, 'live', 'the normal final audio flush still owns its microphone');
    const samples = new Float32Array([0.1, 0.2, 0.3]);
    h.nodes[0].port.onmessage({ data: { type: 'pcm', samples } });
    h.nodes[0].port.onmessage({ data: { type: 'flushed' } });
    await new Promise(setImmediate);
    assert.equal(settled, true, 'release must settle without the browser close reply');
    assert.deepEqual(h.chunks.map((chunk) => chunk.samples), [samples]);
    assert.equal(h.track.readyState, 'ended');
    assert.equal(h.contexts[0].closeRequests, 1);
    assert.equal(h.capture.state, 'idle');
    assert.equal(h.listeners.size, 0);
    assert.equal(h.timers.size, 0);
  } finally {
    h.closeReply.resolve();
    await stop;
  }
});

test('PCM initialization failure settles while browser context closure remains pending', async () => {
  const h = createLifecycleHarness({ failAt: 'resume', pendingClose: true });
  let settled = false;
  const startup = assert.rejects(h.capture.start(), /Browser resume failed/)
    .then(() => { settled = true; });
  try {
    await new Promise(setImmediate);
    assert.equal(settled, true, 'cleanup must not hide the original initialization failure');
    assert.equal(h.capture.state, 'idle');
    assert.equal(h.track.readyState, 'ended');
    assert.equal(h.contexts[0].closeRequests, 1);
    assert.equal(h.listeners.size, 0);
    assert.equal(h.errors.length, 1);
  } finally {
    h.closeReply.resolve();
    await startup;
  }
});

test('PCM release stops the microphone after the bounded flush timeout', async () => {
  const h = createLifecycleHarness();
  await h.capture.start();
  const stop = h.capture.stop();
  assert.deepEqual(h.nodes[0].messages, [{ type: 'flush' }]);
  assert.equal(h.counters.tracksStopped, 0, 'normal release permits the final buffered audio to flush');
  assert.equal(h.timers.size, 1);
  const timer = [...h.timers.values()][0];
  assert.equal(timer.milliseconds, 250);
  timer.callback();
  await stop;
  assert.equal(h.counters.tracksStopped, 1);
  assert.equal(h.capture.state, 'idle');
  assert.equal(h.timers.size, 0);
});

test('PCM cancellation interrupts a pending release flush and rejects late audio', async (t) => {
  const h = createLifecycleHarness({ pendingClose: true });
  t.after(() => h.closeReply.resolve());
  await h.capture.start();
  const staleMessageHandler = h.nodes[0].port.onmessage;
  const stop = h.capture.stop();
  let cancelled = false;
  const cancellation = h.capture.cancel().then(() => { cancelled = true; });
  await new Promise(setImmediate);
  assert.equal(cancelled, true, 'cancelling a flush must settle before context closure');
  await cancellation;
  await stop;
  staleMessageHandler({ data: { type: 'pcm', samples: new Float32Array(128) } });
  assert.equal(h.counters.tracksStopped, 1);
  assert.deepEqual(h.nodes[0].messages, [{ type: 'flush' }, { type: 'cancel' }]);
  assert.equal(h.chunks.length, 0);
  assert.equal(h.timers.size, 0);
});

test('PCM browser capture failures close the microphone without waiting for a flush', async (t) => {
  for (const failure of ['track-ended', 'processor-error']) {
    await t.test(failure, async () => {
      const h = createLifecycleHarness();
      await h.capture.start();
      if (failure === 'track-ended') h.listeners.get('ended')();
      else h.nodes[0].onprocessorerror();
      assert.equal(h.counters.tracksStopped, 1);
      await h.capture.cancel();
      assert.equal(h.capture.state, 'idle');
      assert.equal(h.errors.length, 1);
      assert.equal(h.timers.size, 0);
    });
  }
});

test('microphone discovery cancellation closes a stream while device enumeration is pending', async () => {
  const pending = deferred();
  const enumerating = deferred();
  const abort = new AbortController();
  let trackStops = 0;
  const discovery = discoverAudioInputDevices({ navigator: { mediaDevices: {
    async getUserMedia() { return { getTracks: () => [{ stop: () => { trackStops += 1; } }] }; },
    enumerateDevices() { enumerating.resolve(); return pending.promise; },
  } } }, { signal: abort.signal });
  await enumerating.promise;
  abort.abort();
  assert.equal(trackStops, 1, 'cancellation cannot wait for the browser device-list reply');
  pending.resolve([]);
  await discovery;
  assert.equal(trackStops, 1);
});

test('microphone discovery closes a late permission grant without enumerating devices', async () => {
  const pending = deferred();
  const abort = new AbortController();
  let trackStops = 0;
  let enumerations = 0;
  const discovery = discoverAudioInputDevices({ navigator: { mediaDevices: {
    getUserMedia() { return pending.promise; },
    async enumerateDevices() { enumerations += 1; return []; },
  } } }, { signal: abort.signal });
  abort.abort();
  pending.resolve({ getTracks: () => [{ stop: () => { trackStops += 1; } }] });
  assert.deepEqual(await discovery, []);
  assert.equal(trackStops, 1);
  assert.equal(enumerations, 0);
});

test('microphone discovery closes its stream when browser enumeration fails', async () => {
  let trackStops = 0;
  await assert.rejects(discoverAudioInputDevices({ navigator: { mediaDevices: {
    async getUserMedia() { return { getTracks: () => [{ stop: () => { trackStops += 1; } }] }; },
    async enumerateDevices() { throw new Error('Device enumeration failed.'); },
  } } }), /Device enumeration failed/);
  assert.equal(trackStops, 1);
});
