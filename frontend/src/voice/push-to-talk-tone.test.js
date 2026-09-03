import test from 'node:test';
import assert from 'node:assert/strict';
import { createPushToTalkTone } from './push-to-talk-tone.js';

class FakeAudioContext {
  constructor() {
    this.currentTime = 4;
    this.destination = {};
    this.state = 'running';
    this.closed = false;
    this.events = [];
  }

  createOscillator() {
    const context = this;
    return {
      type: '',
      frequency: { setValueAtTime(value, time) { context.events.push(['frequency', value, time]); } },
      connect() {},
      disconnect() {},
      start(time) { context.events.push(['start', time]); },
      stop(time) {
        context.events.push(['stop', time]);
        queueMicrotask(() => this.onended?.());
      },
    };
  }

  createGain() {
    const context = this;
    return {
      gain: {
        setValueAtTime(value, time) { context.events.push(['gain-set', value, time]); },
        exponentialRampToValueAtTime(value, time) { context.events.push(['gain-ramp', value, time]); },
      },
      connect() {},
      disconnect() {},
    };
  }

  async close() {
    this.closed = true;
    this.state = 'closed';
  }
}

test('push-to-talk tones use distinct short local cues', async () => {
  const contexts = [];
  class TrackingAudioContext extends FakeAudioContext {
    constructor() {
      super();
      contexts.push(this);
    }
  }
  const tone = createPushToTalkTone({ globalRef: { AudioContext: TrackingAudioContext } });

  assert.equal(await tone.play('press'), true);
  assert.equal(await tone.play('release'), true);
  assert.equal(contexts.length, 1);
  assert.deepEqual(
    contexts[0].events.filter(([kind]) => kind === 'frequency'),
    [['frequency', 620, 4], ['frequency', 880, 4]],
  );
  assert.deepEqual(
    contexts[0].events.filter(([kind]) => kind === 'stop').map(([, time]) => Math.round(time * 1000)),
    [4045, 4095],
  );
  assert.deepEqual(
    contexts[0].events.filter(([kind, value]) => kind === 'gain-ramp' && value > 0.001)
      .map(([, value]) => value),
    [0.16, 0.16],
  );

  await tone.dispose();
  assert.equal(contexts[0].closed, true);
});

test('push-to-talk tones safely remain silent when Web Audio is unavailable', async () => {
  const tone = createPushToTalkTone({ globalRef: {} });
  assert.equal(await tone.play('press'), false);
  await tone.dispose();
});
