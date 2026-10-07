'use strict';

const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { getProvider, resolveSelection } = require('./voice-cloud-provider');

// Average the input interval when downsampling; linear interpolation when upsampling.
// This preserves duration across ordinary 44.1/48 kHz microphone streams.
function pcm24k(chunks, frames, sampleRate) {
  const input = new Float32Array(frames);
  let offset = 0;
  for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.length; }
  const length = Math.floor(frames * 24000 / sampleRate);
  const output = Buffer.alloc(length * 2);
  const ratio = sampleRate / 24000;
  for (let i = 0; i < length; i++) {
    const start = i * ratio;
    let value;
    if (ratio >= 1) {
      const end = Math.min(frames, (i + 1) * ratio);
      let sum = 0;
      for (let j = Math.floor(start); j < end; j++) sum += input[j] * (Math.min(end, j + 1) - Math.max(start, j));
      value = sum / (end - start);
    } else {
      const j = Math.floor(start), fraction = start - j;
      value = input[j] * (1 - fraction) + input[Math.min(j + 1, frames - 1)] * fraction;
    }
    output.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767)), i * 2);
  }
  return output;
}

function createVoiceCloudEngine({ loadContract, getApiKey, getSelection = () => ({ ...resolveSelection(), revision: 0 }), interpret = null, resultTimeoutMs = 5500 }) {
  const events = new EventEmitter();
  let active = null;
  let ready = false;
  let contract;
  const emit = event => events.emit('event', Object.freeze(event));
  function isCurrentSelection(session) {
    const current = getSelection();
    return current.providerId === session.selection.providerId && current.modelId === session.selection.modelId
      && current.revision === session.selection.revision;
  }
  function getInfo() { return { activeSessionId: active?.sessionId || null, modelId: getSelection().modelId, providerId: getSelection().providerId, ready,
    state: ready ? 'ready' : 'stopped', sampleRate: 24000, timeoutMs: 10000 }; }
  async function initialize() {
    ready = false;
    contract = loadContract();
    getApiKey(getSelection().providerId); // Local check only; no provider request until release.
    ready = true;
    return getInfo();
  }
  function start({ context } = {}) {
    if (!ready) throw new Error('Cloud voice is not ready. Check your API key in Voice settings.');
    if (active) throw new Error('A voice session is already active.');
    const snapshot = context ? contract.validateContext(context) : contract.createContext({
      profileKey: 'voice-test', configurationId: 'voice-test', profileRevision: null,
      commands: [{ id: 'flightGuidance.heading.set', label: 'Selected heading',
        input: { kind: 'number', min: 0, max: 359, step: 1, units: 'degrees' } }],
    });
    const sessionId = randomUUID();
    const selected = getSelection();
    const selection = Object.freeze({ ...resolveSelection({ providerId: selected.providerId, modelId: selected.modelId }), revision: selected.revision });
    const provider = getProvider(selection.providerId);
    const session = { sessionId, selection, provider, context: snapshot, chunks: [], frames: 0, sampleRate: 0,
      nextSequence: 0, hasSignal: false, finishing: false, abort: new AbortController(), timer: null };
    session.timer = setTimeout(() => {
      if (active !== session || session.finishing) return;
      clear(session);
      emit({ type: 'error', sessionId, code: 'CAPTURE_TIMEOUT', message: 'Voice capture exceeded ten seconds. Please try a shorter request.' });
    }, 11000);
    active = session;
    return { sessionId, sampleRate: 24000, timeoutMs: 10000, selection };
  }
  function clear(session) {
    clearTimeout(session.timer);
    session.abort.abort();
    session.chunks.length = 0;
    if (active === session) active = null;
  }
  function pushAudio({ sessionId, sequence, sampleRate, samples }) {
    const session = active;
    if (!session || session.sessionId !== sessionId || session.finishing) throw new Error('No matching cloud voice session.');
    if (!Number.isSafeInteger(sequence) || sequence !== session.nextSequence
        || !Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000
        || (session.sampleRate && session.sampleRate !== sampleRate)
        || !(samples instanceof Float32Array) || !samples.length || samples.length > 8192) throw new Error('Invalid cloud voice audio.');
    if (session.frames + samples.length > sampleRate * 10) {
      throw Object.assign(new Error('Voice capture exceeded ten seconds. Please try a shorter request.'), { code: 'CAPTURE_TIMEOUT' });
    }
    for (const value of samples) {
      if (!Number.isFinite(value) || value < -1 || value > 1) throw new Error('Invalid cloud voice audio samples.');
      if (value !== 0) session.hasSignal = true;
    }
    session.chunks.push(new Float32Array(samples));
    session.sampleRate = sampleRate;
    session.frames += samples.length;
    session.nextSequence++;
    return { accepted: true, sequence };
  }
  function finish(sessionId) {
    const session = active;
    if (!session || session.sessionId !== sessionId || session.finishing) return false;
    if (!isCurrentSelection(session)) { cancel(sessionId); return false; }
    session.finishing = true;
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (active !== session) return;
      clear(session);
      emit({ type: 'error', sessionId, code: 'CLOUD_TIMEOUT', message: 'Cloud voice timed out. Nothing was executed. Please try again.' });
    }, resultTimeoutMs);
    void (async () => {
      try {
        let result;
        if (!session.hasSignal || session.frames < session.sampleRate * 0.1) {
          result = { intent: { decision: 'no-action', reason: 'incomplete' } };
        } else {
          const audio = pcm24k(session.chunks, session.frames, session.sampleRate);
          session.chunks.length = 0;
          result = await (interpret || session.provider.interpretAudio)({ audio, context: session.context,
            modelId: session.selection.modelId, apiKey: getApiKey(session.selection.providerId), contract, signal: session.abort.signal });
        }
        if (active !== session) return;
        if (!isCurrentSelection(session)) { cancel(sessionId); return; }
        const intent = contract.validateIntent(result.intent, session.context);
        clear(session);
        emit({ type: 'final', sessionId, mode: 'cloud', selection: session.selection, text: '', intent, usage: result.usage });
      } catch (error) {
        if (active !== session) return;
        clear(session);
        const messages = {
          CLOUD_AUTH: `${session.provider.label} rejected the API key or model access. Check Voice settings.`,
          CLOUD_QUOTA: `${session.provider.label} usage limit reached. Check your API quota or try again later.`,
          CLOUD_CONNECTION: 'Cloud voice could not connect. Check your connection or select Offline voice.',
          CLOUD_REQUEST: `${session.provider.label} rejected the voice request. Check your key and model access in Voice settings.`,
          CLOUD_INVALID: 'Cloud voice returned an invalid or incomplete proposal. Nothing was executed. Please try again.',
          CLOUD_TIMEOUT: 'Cloud voice timed out. Nothing was executed. Please try again.',
        };
        const code = Object.hasOwn(messages, error?.code) ? error.code : 'CLOUD_FAILED';
        emit({ type: 'error', sessionId, code,
          message: messages[code] || 'Cloud voice could not interpret the request. Check your connection, API key and quota, or select Offline voice.' });
      }
    })();
    return true;
  }
  function cancel(sessionId) {
    if (!active || active.sessionId !== sessionId) return false;
    clear(active);
    emit({ type: 'cancelled', sessionId, reason: 'user' });
    return true;
  }
  async function shutdown() { if (active) clear(active); ready = false; }
  return { initialize, start, pushAudio, finish, cancel, shutdown, getInfo,
    onEvent(listener) { events.on('event', listener); return () => events.off('event', listener); } };
}

module.exports = { createVoiceCloudEngine, pcm24k };
