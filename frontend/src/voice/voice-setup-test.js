import { createPcmCapture } from './pcm-capture.js';
import { normalizeVoiceText, parseAviationNumber } from './aviation-number-parser.js';
import { cloudSelectionKey } from './cloud-intent.js';

export const VOICE_TEST_PHRASE = 'Set heading two seven zero';
const RECORDING_MS = 5000;
const SESSION_MS = 15000;

export function initialVoiceTestState() {
  return { phase: 'idle', message: '', transcript: '', recognized: false, level: 0,
    heardAudio: false, deviceLabel: '', playbackAvailable: false, feedbackMessage: '', interpreted: false };
}

// This controller has no aircraft catalogue, command sender or simulator access.
// It tests the same PCM/recognition path and checks only the displayed sample.
export function createVoiceSetupTest({ api, voiceStore, canStart = () => true,
  globalRef = globalThis, createCapture = createPcmCapture,
  cancelReadback = () => {}, timers = globalThis } = {}) {
  let active = null;
  let closing = null;
  let recording = null;
  let playback = null;
  let disposed = false;
  let feedbackGeneration = 0;
  let feedbackOwned = false;
  const update = (patch) => voiceStore.setVoiceTestState?.(patch);
  const isBusy = () => Boolean(active || closing || playback);
  const clearTimers = (session) => {
    timers.clearTimeout(session.recordTimer);
    timers.clearTimeout(session.deadline);
  };

  async function stopPlayback() {
    const playing = playback;
    if (!playing) return;
    playback = null;
    timers.clearTimeout(playing.deadline);
    if (playing.source) playing.source.onended = null;
    try { playing.source?.stop(); } catch {}
    try { playing.source?.disconnect(); } catch {}
    try { await playing.context.close(); } catch {}
  }

  async function cancel(message = '') {
    feedbackGeneration++;
    if (active || playback || feedbackOwned) cancelReadback();
    feedbackOwned = false;
    const session = active;
    active = null;
    if (session) clearTimers(session);
    recording = null;
    if (!session && !closing && !playback) {
      update({ ...initialVoiceTestState(), phase: message ? 'error' : 'idle', message });
      return;
    }
    update({ phase: 'stopping', level: 0, playbackAvailable: false, feedbackMessage: '' });
    const previous = closing;
    const cleanup = (async () => {
      await previous;
      await stopPlayback();
      try { await session?.capture?.cancel(); } catch {}
      if (session?.id) { try { await api?.cancelRecognition?.(session.id); } catch {} }
    })();
    closing = cleanup;
    await cleanup;
    if (closing !== cleanup) return;
    closing = null;
    update({ ...initialVoiceTestState(), phase: message ? 'error' : 'idle', message });
  }

  async function fail(session, message) {
    if (active !== session) return;
    await cancel(message);
  }

  async function finish() {
    const session = active;
    if (!session || session.finishing || !session.ready) return false;
    session.finishing = true;
    timers.clearTimeout(session.recordTimer);
    update({ phase: 'recognizing', level: 0, message: 'Recognizing your test phrase…' });
    try {
      // Flush the same worklet used by ordinary push-to-talk before recognition.
      await session.capture.stop();
      if (active !== session) return false;
      const result = await api.finishRecognition(session.id);
      if (result?.finishing === false) throw new Error('Recognition stopped. Try the test again.');
      return true;
    } catch (error) {
      await fail(session, error?.message || 'The voice test could not finish.');
      return false;
    }
  }

  async function start() {
    if (disposed || isBusy() || !canStart()) return false;
    if (!voiceStore.runtime.enabled || !voiceStore.runtime.available) {
      update({ phase: 'error', message: voiceStore.runtime.enabled
        ? (voiceStore.runtime.error || 'Voice recognition is unavailable.')
        : 'Enable voice control above to test your microphone and speech recognition.' });
      return false;
    }
    recording = null;
    feedbackGeneration++;
    feedbackOwned = false;
    cancelReadback();
    const session = { id: '', mode: voiceStore.runtime.mode || 'offline', capture: null, ready: false, finishing: false,
      cloudSelection: cloudSelectionKey(voiceStore.runtime.cloud),
      chunks: [], frames: 0, sampleRate: 0, heardAudio: false };
    active = session;
    update({ ...initialVoiceTestState(), phase: 'starting', message: 'Opening microphone…' });
    session.deadline = timers.setTimeout(() => {
      void fail(session, 'The voice test timed out. Check microphone access and try again.');
    }, SESSION_MS);
    try {
      const recognition = await api.startRecognition();
      session.id = recognition?.sessionId || '';
      if (!session.id) throw new Error('The recognition session could not start.');
      if (active !== session) {
        await api.cancelRecognition(session.id);
        return false;
      }
      session.capture = createCapture({ globalRef,
        deviceId: String(voiceStore.selectedInputDeviceId || ''),
        onChunk({ samples, sampleRate }) {
          if (active !== session) return;
          try {
            if (session.sampleRate && session.sampleRate !== sampleRate) throw new Error('Microphone sample rate changed. Try again.');
            session.sampleRate = sampleRate;
            const remaining = Math.floor(sampleRate * RECORDING_MS / 1000) - session.frames;
            if (remaining <= 0) return;
            const chunk = samples.slice(0, remaining);
            const rms = Math.sqrt(chunk.reduce((sum, value) => sum + value * value, 0) / chunk.length);
            session.heardAudio ||= rms >= 0.003;
            session.frames += chunk.length;
            session.chunks.push(chunk);
            api.sendAudio({ sessionId: session.id, sequence: session.chunks.length - 1,
              sampleRate, samples: chunk.buffer });
            update({ heardAudio: session.heardAudio,
              level: session.finishing ? 0 : Math.round(Math.max(0, Math.min(1, (20 * Math.log10(rms || 1e-6) + 60) / 60)) * 100) });
            if (session.ready && session.frames >= sampleRate * RECORDING_MS / 1000) void finish();
          } catch (error) { void fail(session, error?.message || 'Microphone audio could not be tested.'); }
        },
        onError(error) { void fail(session, error?.message || 'Microphone capture failed.'); },
      });
      const info = await session.capture.start();
      if (active !== session) return false;
      session.ready = true;
      voiceStore.setInputDevicesError?.('');
      update({ phase: 'listening', deviceLabel: info.deviceLabel,
        message: 'Listening for five seconds. Say the test phrase.' });
      session.recordTimer = timers.setTimeout(() => { void finish(); }, RECORDING_MS);
      return true;
    } catch (error) {
      await fail(session, error?.message || 'The voice test could not start.');
      return false;
    }
  }

  async function handleRecognitionEvent(event = {}) {
    const session = active;
    if (!session || (event.sessionId !== session.id && !(event.type === 'error' && event.fatal && !event.sessionId))) return;
    if (event.type === 'partial') {
      update({ transcript: String(event.text || '').slice(0, 4096) });
      return;
    }
    if (event.type === 'error' || event.type === 'cancelled') {
      await fail(session, event.message || 'The voice test stopped. Try again.');
      return;
    }
    if (event.type !== 'final') return;
    if ((event.mode || 'offline') !== session.mode || (voiceStore.runtime.mode || 'offline') !== session.mode) {
      await fail(session, 'Voice mode changed. Please start the test again.');
      return;
    }
    if (!session.finishing) {
      await fail(session, 'Recognition ended before the test finished. Please try again.');
      return;
    }
    clearTimers(session);
    try { await session.capture?.cancel(); } catch {}
    if (active !== session) return;
    const cloud = session.mode === 'cloud';
    if (cloud && (session.cloudSelection !== cloudSelectionKey(voiceStore.runtime.cloud)
        || session.cloudSelection !== cloudSelectionKey(event.selection))) {
      await fail(session, 'Cloud voice settings changed. Please start the test again.');
      return;
    }
    const proposedHeading = event.intent?.input?.value;
    const cloudHeading = cloud && event.intent?.decision === 'command'
      && event.intent.commandId === 'flightGuidance.heading.set'
      && Number.isInteger(proposedHeading) && proposedHeading >= 0 && proposedHeading <= 359
      ? proposedHeading : null;
    const transcript = cloud ? (cloudHeading !== null ? `Selected heading ${cloudHeading}°` : '') : String(event.text || '').trim().slice(0, 4096);
    const heading = /^set heading (.+)$/.exec(normalizeVoiceText(transcript).replace(/\.$/, ''));
    const recognized = cloud ? cloudHeading === 270 : Boolean(heading && parseAviationNumber(heading[1], { units: 'degrees' }) === 270);
    recording = session.frames ? { chunks: session.chunks, frames: session.frames, sampleRate: session.sampleRate } : null;
    active = null;
    update({ phase: 'complete', transcript, interpreted: cloud, recognized, level: 0,
      playbackAvailable: Boolean(recording), message: recognized
        ? 'Test phrase recognized: heading 270°. No command was sent.'
        : transcript ? 'Speech recognized. Try saying the displayed test phrase again.'
          : session.heardAudio ? 'Sound detected, but no speech was recognized. Try again.'
            : 'No sound detected. Check the microphone and its input volume, then try again.' });
  }

  async function playRecording() {
    if (disposed || isBusy() || !recording || !canStart()) return false;
    const AudioContext = globalRef.AudioContext || globalRef.webkitAudioContext;
    if (!AudioContext) { update({ message: 'Audio playback is unavailable.' }); return false; }
    const generation = ++feedbackGeneration;
    feedbackOwned = false;
    cancelReadback();
    let playing;
    try {
      const context = new AudioContext();
      playing = { context, source: null };
      playback = playing;
      const source = context.createBufferSource();
      playing.source = source;
      playing.deadline = timers.setTimeout(() => {
        if (playback !== playing) return;
        void stopPlayback().then(() => {
          if (generation === feedbackGeneration && !disposed) update({ phase: 'complete', message: 'Playback stopped. Check your audio output if you heard nothing.' });
        });
      }, 10000);
      update({ phase: 'playing', feedbackMessage: '' });
      const buffer = context.createBuffer(1, recording.frames, recording.sampleRate);
      const channel = buffer.getChannelData(0);
      let offset = 0;
      for (const chunk of recording.chunks) { channel.set(chunk, offset); offset += chunk.length; }
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        if (playback !== playing) return;
        void stopPlayback().then(() => {
          if (generation === feedbackGeneration && !disposed) update({ phase: 'complete' });
        });
      };
      if (context.state === 'suspended') await context.resume();
      if (playback !== playing) return false;
      source.start();
      return true;
    } catch {
      if (!playing || playback === playing) {
        if (playing) await stopPlayback();
        if (generation !== feedbackGeneration || disposed) return false;
        update({ phase: 'complete', message: 'Recording playback failed. Check your audio output and try again.' });
      }
      return false;
    }
  }

  async function testSpokenFeedback() {
    if (disposed || isBusy() || !canStart()) return false;
    const generation = ++feedbackGeneration;
    feedbackOwned = true;
    cancelReadback();
    try {
      const result = await api?.speakReadback?.('Spoken feedback is working.');
      if (generation !== feedbackGeneration || disposed) return false;
      update({ feedbackMessage: result?.started === true
        ? 'Playing the test phrase through your default audio output.'
        : 'Spoken feedback could not start. Check your Windows voice and audio output.' });
      return result?.started === true;
    } catch {
      if (generation === feedbackGeneration && !disposed) update({ feedbackMessage: 'Spoken feedback could not start. Check your audio output.' });
      return false;
    }
  }

  return Object.freeze({ start, finish, cancel, playRecording, testSpokenFeedback,
    handleRecognitionEvent, get busy() { return isBusy(); },
    async dispose() { disposed = true; await cancel(); } });
}
