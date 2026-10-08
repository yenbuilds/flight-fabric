const TONES = Object.freeze({
  // Keep the press cue brief because microphone startup intentionally waits
  // for it to finish, preventing the cue from entering recognition audio.
  press: Object.freeze({ durationSeconds: 0.045, frequencyHz: 620 }),
  release: Object.freeze({ durationSeconds: 0.095, frequencyHz: 880 }),
});

// A modest ~2 dB increase over 0.4; keep the brief, smoothly faded envelope.
const PEAK_GAIN = 0.5;
// Cues last 45/95 ms. Allow a conservative second for browser resume plus
// playback, then continue silently rather than retaining a microphone attempt.
const PLAYBACK_DEADLINE_MS = 1000;

function audioContextConstructor(globalRef) {
  return globalRef?.AudioContext || globalRef?.webkitAudioContext || null;
}

// The cues intentionally use a renderer-only AudioContext. They are not
// microphone input and there is no IPC, persistence, or network path for them.
export function createPushToTalkTone({
  globalRef = globalThis,
  setTimeoutRef = globalThis.setTimeout,
  clearTimeoutRef = globalThis.clearTimeout,
} = {}) {
  let context = null;
  let active = null;
  let disposed = false;

  function retireContext(owned) {
    if (context === owned) context = null;
    // Browser closure can remain pending. Output is already detached, and
    // neither caller settlement nor a new play depends on that promise.
    try { Promise.resolve(owned?.close?.()).catch(() => {}); } catch {}
  }

  function play(phase, { signal } = {}) {
    const tone = TONES[phase];
    const AudioContext = audioContextConstructor(globalRef);
    if (disposed || signal?.aborted || !tone || typeof AudioContext !== 'function') return Promise.resolve(false);
    active?.settle(false);

    try {
      if (!context || context.state === 'closed') context = new AudioContext();
    } catch {
      return Promise.resolve(false);
    }
    const owned = context;
    return new Promise(resolve => {
      const playback = { oscillator: null, gain: null, timer: null, settled: false, settle };
      const onAbort = () => settle(false);
      function settle(completed) {
        if (playback.settled) return;
        playback.settled = true;
        clearTimeoutRef(playback.timer);
        playback.timer = null;
        signal?.removeEventListener('abort', onAbort);
        if (playback.oscillator) {
          playback.oscillator.onended = null;
          if (!completed) { try { playback.oscillator.stop(); } catch {} }
          try { playback.oscillator.disconnect(); } catch {}
        }
        try { playback.gain?.disconnect(); } catch {}
        playback.oscillator = null;
        playback.gain = null;
        if (active === playback) active = null;
        if (!completed) retireContext(owned);
        resolve(completed);
      }
      active = playback;
      playback.timer = setTimeoutRef(onAbort, PLAYBACK_DEADLINE_MS);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { settle(false); return; }
      void (async () => {
        try {
          if (owned.state === 'suspended' && typeof owned.resume === 'function') await owned.resume();
          if (playback.settled) return;
          if (owned.state !== 'running') { settle(false); return; }
          const oscillator = playback.oscillator = owned.createOscillator();
          const gain = playback.gain = owned.createGain();
          const startAt = owned.currentTime;
          const endAt = startAt + tone.durationSeconds;
          oscillator.type = 'triangle';
          oscillator.frequency.setValueAtTime(tone.frequencyHz, startAt);
          gain.gain.setValueAtTime(0.0001, startAt);
          gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, startAt + 0.006);
          gain.gain.exponentialRampToValueAtTime(0.0001, endAt);
          oscillator.connect(gain);
          gain.connect(owned.destination);
          oscillator.onended = () => settle(true);
          oscillator.start(startAt);
          oscillator.stop(endAt);
        } catch { settle(false); }
      })();
    });
  }

  function cancel() {
    active?.settle(false);
  }

  function dispose() {
    disposed = true;
    cancel();
    if (context) retireContext(context);
  }

  return Object.freeze({ cancel, dispose, play });
}
