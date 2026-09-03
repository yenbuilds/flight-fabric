const TONES = Object.freeze({
  // Keep the press cue brief because microphone startup intentionally waits
  // for it to finish, preventing the cue from entering recognition audio.
  press: Object.freeze({ durationSeconds: 0.045, frequencyHz: 620 }),
  release: Object.freeze({ durationSeconds: 0.095, frequencyHz: 880 }),
});

const PEAK_GAIN = 0.16;

function audioContextConstructor(globalRef) {
  return globalRef?.AudioContext || globalRef?.webkitAudioContext || null;
}

// The cues intentionally use a renderer-only AudioContext. They are not
// microphone input and there is no IPC, persistence, or network path for them.
export function createPushToTalkTone({ globalRef = globalThis } = {}) {
  let context = null;

  async function play(phase) {
    const tone = TONES[phase];
    const AudioContext = audioContextConstructor(globalRef);
    if (!tone || typeof AudioContext !== 'function') return false;

    try {
      if (!context || context.state === 'closed') context = new AudioContext();
      if (context.state === 'suspended' && typeof context.resume === 'function') await context.resume();
      if (context.state !== 'running') return false;

      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const startAt = context.currentTime;
      const endAt = startAt + tone.durationSeconds;
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(tone.frequencyHz, startAt);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, startAt + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, endAt);
      oscillator.connect(gain);
      gain.connect(context.destination);

      return await new Promise((resolve) => {
        oscillator.onended = () => {
          try { oscillator.disconnect(); } catch {}
          try { gain.disconnect(); } catch {}
          resolve(true);
        };
        oscillator.start(startAt);
        oscillator.stop(endAt);
      });
    } catch {
      return false;
    }
  }

  async function dispose() {
    if (!context || context.state === 'closed') return;
    try { await context.close?.(); } catch {}
    context = null;
  }

  return Object.freeze({ dispose, play });
}
