export const PCM_WORKLET_PROCESSOR_NAME = 'flight-fabric-pcm-capture';
export const DEFAULT_PCM_CHUNK_FRAMES = 2048;
export const MAX_PCM_CHUNK_FRAMES = 8192;
// AudioWorklet modules are scripts, so they must remain a same-origin file under
// the renderer CSP. `no-inline` prevents Vite from turning this small module
// into a data: URL in production builds.
export const DEFAULT_PCM_WORKLET_URL = new URL('./pcm-worklet.js?no-inline', import.meta.url).href;

const MIN_PCM_CHUNK_FRAMES = 128;
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 192000;
const DEFAULT_FLUSH_TIMEOUT_MS = 250;

function microphoneLabel(track) {
  const label = typeof track?.label === 'string' ? track.label.trim() : '';
  return label.slice(0, 160) || 'Windows default input';
}

function boundedDeviceId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 512) : '';
}

export function createMicrophoneConstraints({ deviceId = '' } = {}) {
  const selectedDeviceId = boundedDeviceId(deviceId);
  return {
    video: false,
    audio: {
      channelCount: { ideal: 1 },
      ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  };
}

export async function enumerateAudioInputDevices(globalRef = globalThis) {
  const enumerateDevices = globalRef?.navigator?.mediaDevices?.enumerateDevices;
  if (typeof enumerateDevices !== 'function') return [];
  const devices = await enumerateDevices.call(globalRef.navigator.mediaDevices);
  const inputs = [];
  const seen = new Set();
  for (const device of Array.isArray(devices) ? devices : []) {
    const deviceId = boundedDeviceId(device?.deviceId);
    if (device?.kind !== 'audioinput' || !deviceId || seen.has(deviceId)) continue;
    seen.add(deviceId);
    const label = typeof device?.label === 'string' ? device.label.trim().slice(0, 160) : '';
    inputs.push(Object.freeze({
      deviceId,
      label: label || `Microphone ${inputs.length + 1}`,
    }));
  }
  return inputs;
}

export async function discoverAudioInputDevices(globalRef = globalThis) {
  const mediaDevices = globalRef?.navigator?.mediaDevices;
  if (typeof mediaDevices?.getUserMedia !== 'function') {
    return enumerateAudioInputDevices(globalRef);
  }
  const stream = await mediaDevices.getUserMedia(createMicrophoneConstraints());
  try {
    return await enumerateAudioInputDevices(globalRef);
  } finally {
    for (const track of stream?.getTracks?.() || []) {
      try { track.stop?.(); } catch {}
    }
  }
}

export function inspectPcmCaptureSupport(globalRef = globalThis) {
  const AudioContext = globalRef?.AudioContext || globalRef?.webkitAudioContext;
  return {
    secureContext: globalRef?.isSecureContext === true,
    microphoneApi: typeof globalRef?.navigator?.mediaDevices?.getUserMedia === 'function',
    audioContext: typeof AudioContext === 'function',
    audioWorkletNode: typeof globalRef?.AudioWorkletNode === 'function',
  };
}

export function validateSampleRate(value) {
  const sampleRate = Number(value);
  if (!Number.isFinite(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    throw new RangeError('PCM sample rate is outside the supported range.');
  }
  return sampleRate;
}

function boundedFrameCount(value, name, minimum = 1) {
  const frames = Number(value);
  if (!Number.isInteger(frames) || frames < minimum || frames > MAX_PCM_CHUNK_FRAMES) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${MAX_PCM_CHUNK_FRAMES}.`);
  }
  return frames;
}

export function copyPcmChunk(value, { maxFrames = MAX_PCM_CHUNK_FRAMES } = {}) {
  const limit = boundedFrameCount(maxFrames, 'maxFrames');
  let input;
  if (value instanceof Float32Array) input = value;
  else if (value instanceof ArrayBuffer && value.byteLength % Float32Array.BYTES_PER_ELEMENT === 0) {
    input = new Float32Array(value);
  } else throw new TypeError('PCM chunks must be aligned Float32 samples.');
  if (input.length === 0 || input.length > limit) {
    throw new RangeError(`PCM chunk must contain between 1 and ${limit} frames.`);
  }
  const samples = new Float32Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const sample = input[index];
    if (!Number.isFinite(sample)) throw new TypeError('PCM chunks cannot contain non-finite samples.');
    samples[index] = Math.max(-1, Math.min(1, sample));
  }
  return samples;
}

function abortError(globalRef, message = 'PCM capture was cancelled.') {
  if (typeof globalRef?.DOMException === 'function') return new globalRef.DOMException(message, 'AbortError');
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function safeCall(callback, ...args) {
  try { callback(...args); } catch { /* Observers cannot prevent cleanup. */ }
}

export class PcmCapture {
  constructor({
    globalRef = globalThis,
    workletUrl = DEFAULT_PCM_WORKLET_URL,
    chunkFrames = DEFAULT_PCM_CHUNK_FRAMES,
    maxChunkFrames = MAX_PCM_CHUNK_FRAMES,
    flushTimeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
    deviceId = '',
    onChunk = () => {},
    onError = () => {},
    onStateChange = () => {},
  } = {}) {
    this.globalRef = globalRef;
    this.workletUrl = String(workletUrl || '');
    if (!this.workletUrl) throw new TypeError('A PCM worklet URL is required.');
    this.chunkFrames = boundedFrameCount(chunkFrames, 'chunkFrames', MIN_PCM_CHUNK_FRAMES);
    this.maxChunkFrames = boundedFrameCount(maxChunkFrames, 'maxChunkFrames');
    if (this.chunkFrames > this.maxChunkFrames) throw new RangeError('chunkFrames cannot exceed maxChunkFrames.');
    this.flushTimeoutMs = Number(flushTimeoutMs);
    if (!Number.isFinite(this.flushTimeoutMs) || this.flushTimeoutMs < 0 || this.flushTimeoutMs > 5000) {
      throw new RangeError('flushTimeoutMs must be between 0 and 5000 milliseconds.');
    }
    this.deviceId = boundedDeviceId(deviceId);
    this.onChunk = onChunk;
    this.onError = onError;
    this.onStateChange = onStateChange;
    this._state = 'idle';
    this._generation = 0;
    this._sequence = 0;
    this._resources = null;
    this._shutdownPromise = null;
  }

  get state() { return this._state; }
  get active() { return this._state !== 'idle'; }

  async start() {
    if (this._state !== 'idle' || this._shutdownPromise) throw new Error('PCM capture is already active.');
    const support = inspectPcmCaptureSupport(this.globalRef);
    if (!support.secureContext) throw new Error('PCM capture requires a secure context.');
    if (!support.microphoneApi) throw new Error('Microphone capture is unavailable.');
    if (!support.audioContext || !support.audioWorkletNode) throw new Error('AudioWorklet capture is unavailable.');

    const generation = ++this._generation;
    const resources = {
      context: null, node: null, source: null, stream: null,
      trackListeners: [], flushResolve: null, flushTimer: null,
    };
    this._resources = resources;
    this._sequence = 0;
    this._transition('starting');
    try {
      const stream = await this.globalRef.navigator.mediaDevices.getUserMedia(createMicrophoneConstraints({
        deviceId: this.deviceId,
      }));
      resources.stream = stream;
      this._assertStarting(generation);
      const audioTracks = stream?.getAudioTracks?.() || [];
      const videoTracks = stream?.getVideoTracks?.() || [];
      if (audioTracks.length === 0 || videoTracks.length > 0 || audioTracks.some((track) => track?.readyState === 'ended')) {
        throw new Error('Microphone capture returned an invalid media stream.');
      }
      for (const track of audioTracks) {
        const listener = () => this._captureFailed(resources, new Error('The microphone stream ended unexpectedly.'));
        track.addEventListener?.('ended', listener, { once: true });
        resources.trackListeners.push({ listener, track });
      }

      const AudioContext = this.globalRef.AudioContext || this.globalRef.webkitAudioContext;
      const context = new AudioContext({ latencyHint: 'interactive' });
      resources.context = context;
      validateSampleRate(context.sampleRate);
      if (typeof context.audioWorklet?.addModule !== 'function') throw new Error('AudioWorklet modules are unavailable.');
      await context.audioWorklet.addModule(this.workletUrl);
      this._assertStarting(generation);

      const source = context.createMediaStreamSource(stream);
      const node = new this.globalRef.AudioWorkletNode(context, PCM_WORKLET_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { chunkFrames: this.chunkFrames },
      });
      resources.source = source;
      resources.node = node;
      node.port.onmessage = (event) => this._handleWorkletMessage(resources, event);
      node.onprocessorerror = () => this._captureFailed(resources, new Error('The PCM processor stopped unexpectedly.'));
      source.connect(node);
      node.connect(context.destination);
      if (context.state === 'suspended' && typeof context.resume === 'function') await context.resume();
      this._assertStarting(generation);
      this._transition('running');
      return Object.freeze({
        chunkFrames: this.chunkFrames,
        deviceLabel: microphoneLabel(audioTracks[0]),
        sampleRate: validateSampleRate(context.sampleRate),
      });
    } catch (error) {
      if (this._resources === resources) this._resources = null;
      await this._releaseResources(resources);
      if (this._generation === generation && this._state !== 'idle') this._transition('idle');
      if (error?.name !== 'AbortError') safeCall(this.onError, error);
      throw error;
    }
  }

  stop() { return this._shutdown(true); }
  cancel() {
    if (this._shutdownPromise) {
      this._cancelPendingFlush();
      return this._shutdownPromise;
    }
    return this._shutdown(false);
  }

  _assertStarting(generation) {
    if (generation !== this._generation || this._state !== 'starting') throw abortError(this.globalRef);
  }
  _transition(state) { this._state = state; safeCall(this.onStateChange, state); }
  _handleWorkletMessage(resources, event) {
    if (event?.data?.type === 'flushed') { resources.flushResolve?.(); return; }
    if (event?.data?.type !== 'pcm' || this._resources !== resources) return;
    if (this._state !== 'running' && this._state !== 'stopping') return;
    try {
      const samples = copyPcmChunk(event.data.samples, { maxFrames: this.maxChunkFrames });
      this.onChunk({
        sampleRate: validateSampleRate(resources.context?.sampleRate),
        samples,
        sequence: this._sequence,
      });
      this._sequence += 1;
    } catch (error) { this._captureFailed(resources, error); }
  }
  _captureFailed(resources, error) {
    if (this._resources !== resources || this._state === 'idle') return;
    safeCall(this.onError, error);
    void this.cancel();
  }
  _shutdown(flush) {
    if (this._state === 'idle') return Promise.resolve();
    if (this._shutdownPromise) return this._shutdownPromise;
    const promise = this._performShutdown(flush);
    this._shutdownPromise = promise.finally(() => { this._shutdownPromise = null; });
    return this._shutdownPromise;
  }
  async _performShutdown(flush) {
    ++this._generation;
    this._transition('stopping');
    const resources = this._resources;
    try {
      if (resources?.node) {
        if (flush) await this._requestFlush(resources);
        else resources.node.port.postMessage({ type: 'cancel' });
      }
    } finally {
      if (this._resources === resources) this._resources = null;
      await this._releaseResources(resources);
      if (this._state === 'stopping') this._transition('idle');
    }
  }
  _requestFlush(resources) {
    return new Promise((resolve) => {
      const finish = () => {
        if (resources.flushResolve !== finish) return;
        resources.flushResolve = null;
        if (resources.flushTimer !== null) this.globalRef.clearTimeout(resources.flushTimer);
        resources.flushTimer = null;
        resolve();
      };
      resources.flushResolve = finish;
      resources.flushTimer = this.globalRef.setTimeout(finish, this.flushTimeoutMs);
      resources.node.port.postMessage({ type: 'flush' });
    });
  }
  _cancelPendingFlush() {
    try { this._resources?.node?.port?.postMessage({ type: 'cancel' }); }
    finally { this._resources?.flushResolve?.(); }
  }
  async _releaseResources(resources) {
    if (!resources) return;
    if (resources.flushTimer !== null) this.globalRef.clearTimeout(resources.flushTimer);
    resources.flushTimer = null;
    resources.flushResolve?.();
    resources.flushResolve = null;
    for (const { listener, track } of resources.trackListeners.splice(0)) track.removeEventListener?.('ended', listener);
    if (resources.node) {
      resources.node.onprocessorerror = null;
      resources.node.port.onmessage = null;
      try { resources.node.port.close?.(); } catch {}
      try { resources.node.disconnect(); } catch {}
      resources.node = null;
    }
    if (resources.source) {
      try { resources.source.disconnect(); } catch {}
      resources.source = null;
    }
    const streamTracks = resources.stream?.getTracks?.()
      || [...(resources.stream?.getAudioTracks?.() || []), ...(resources.stream?.getVideoTracks?.() || [])];
    for (const track of new Set(streamTracks)) { try { track.stop(); } catch {} }
    resources.stream = null;
    if (resources.context && resources.context.state !== 'closed') {
      try { await resources.context.close(); } catch {}
    }
    resources.context = null;
  }
}

export function createPcmCapture(options) { return new PcmCapture(options); }
