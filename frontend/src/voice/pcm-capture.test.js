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
