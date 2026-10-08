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
    [0.5, 0.5],
  );

  await tone.dispose();
  assert.equal(contexts[0].closed, true);
});

test('push-to-talk tones safely remain silent when Web Audio is unavailable', async () => {
  const tone = createPushToTalkTone({ globalRef: {} });
  assert.equal(await tone.play('press'), false);
  await tone.dispose();
});

// Deliberately deferred browser callbacks test ownership; they do not model a
// measured failure rate or timing threshold on a physical audio device.
function controlledAudio({ suspended = false, closeRejects = false } = {}) {
  const contexts = [], timers = new Set(), connected = new Set();
  class AudioContext extends FakeAudioContext {
    constructor() {
      super();
      this.state = suspended ? 'suspended' : 'running';
      this.oscillators = [];
      this.closeCalls = 0;
      this.resumeReply = new Promise(resolve => { this.resumeNow = () => { this.state = 'running'; resolve(); }; });
      contexts.push(this);
    }
    resume() { return this.resumeReply; }
    close() {
      this.closeCalls++;
      return closeRejects ? Promise.reject(new Error('Injected close rejection')) : new Promise(() => {});
    }
    createOscillator() {
      const node = super.createOscillator();
      node.connect = () => connected.add(node);
      node.disconnect = () => connected.delete(node);
      node.stop = () => {}; // Browser ended callback is delivered explicitly.
      this.oscillators.push(node);
      return node;
    }
    createGain() {
      const node = super.createGain();
      node.connect = () => connected.add(node);
      node.disconnect = () => connected.delete(node);
      return node;
    }
  }
  const tone = createPushToTalkTone({
    globalRef: { AudioContext },
    setTimeoutRef(callback, delay) { const timer = { callback, delay }; timers.add(timer); return timer; },
    clearTimeoutRef(timer) { timers.delete(timer); },
  });
  return { tone, contexts, timers, connected,
    expire() { for (const timer of [...timers]) { timers.delete(timer); timer.callback(); } },
  };
}

test('a stalled tone resume times out without waiting for close and ignores its late reply', async () => {
  const h = controlledAudio({ suspended: true });
  const playing = h.tone.play('press');
  assert.equal(h.timers.size, 1, 'resume and playback must share one owned deadline');
  h.expire();
  assert.equal(await playing, false);
  assert.equal(h.contexts[0].closeCalls, 1);
  assert.equal(h.timers.size, 0);
  const next = h.tone.play('press');
  assert.equal(h.contexts.length, 2, 'the failed context must be retired');
  h.contexts[0].resumeNow();
  await Promise.resolve();
  assert.equal(h.contexts[0].oscillators.length, 0, 'late resume must not play into the new capture');
  h.contexts[1].resumeNow();
  await Promise.resolve();
  h.contexts[1].oscillators[0].onended();
  assert.equal(await next, true);
  assert.equal(h.connected.size, 0);
  await h.tone.dispose();
});

test('missing tone ended callback detaches output and permits a fresh play', async () => {
  const h = controlledAudio({ closeRejects: true });
  const playing = h.tone.play('press');
  const oldEnded = h.contexts[0].oscillators[0].onended;
  assert.equal(h.timers.size, 1);
  h.expire();
  assert.equal(await playing, false);
  assert.equal(h.connected.size, 0);
  assert.equal(h.contexts[0].oscillators[0].onended, null);
  const next = h.tone.play('press');
  oldEnded();
  assert.equal(h.connected.size, 2, 'obsolete callback must not disconnect new output');
  h.contexts[1].oscillators[0].onended();
  assert.equal(await next, true);
  assert.equal(h.timers.size, 0);
  await h.tone.dispose();
});

test('tone abort, supersession and disposal settle callers before pending browser cleanup', async () => {
  for (const terminal of ['abort', 'supersede', 'dispose']) {
    const h = controlledAudio({ suspended: true });
    const abort = new AbortController();
    const playing = h.tone.play('release', { signal: abort.signal });
    assert.equal(h.timers.size, 1);
    let next;
    if (terminal === 'abort') abort.abort();
    if (terminal === 'supersede') next = h.tone.play('press');
    if (terminal === 'dispose') await h.tone.dispose();
    assert.equal(await playing, false, terminal);
    assert.equal(h.contexts[0].closeCalls, 1);
    h.contexts[0].resumeNow();
    await Promise.resolve();
    assert.equal(h.contexts[0].oscillators.length, 0);
    await h.tone.dispose();
    if (next) assert.equal(await next, false);
    assert.equal(h.timers.size, 0);
    assert.equal(h.connected.size, 0);
    assert.equal(await h.tone.play('press'), false, 'disposed owners cannot reacquire audio');
  }
});

test('aborting or superseding audible output detaches it before replacement and ignores a late ended callback', async () => {
  for (const terminal of ['abort', 'supersede']) {
    const h = controlledAudio();
    const abort = new AbortController();
    const playing = h.tone.play('release', { signal: abort.signal });
    const oldContext = h.contexts[0];
    const oldOscillator = oldContext.oscillators[0];
    const oldEnded = oldOscillator.onended;
    assert.equal(h.connected.size, 2, 'the release cue has connected output');
    if (terminal === 'abort') {
      abort.abort();
      assert.equal(h.connected.size, 0, 'abort disconnects synchronously');
      assert.equal(h.timers.size, 0);
    }
    const next = h.tone.play('press');
    assert.equal(await playing, false, terminal);
    assert.equal(oldContext.closeCalls, 1, 'a pending browser close cannot block replacement');
    assert.equal(oldOscillator.onended, null);
    assert.equal(h.connected.has(oldOscillator), false);
    assert.equal(h.connected.size, 2, 'only the replacement output remains connected');
    assert.equal(h.timers.size, 1);
    oldEnded();
    assert.equal(h.connected.size, 2, 'late completion cannot detach replacement output');
    assert.equal(h.timers.size, 1, 'late completion cannot clear replacement deadline');
    h.contexts[1].oscillators[0].onended();
    assert.equal(await next, true);
    assert.equal(h.connected.size, 0);
    assert.equal(h.timers.size, 0);
    await h.tone.dispose();
  }
});

test('explicit tone cancellation retires a completed command\'s pending release cue without disposing the reusable owner', async () => {
  const h = controlledAudio({ suspended: true });
  const playing = h.tone.play('release');
  h.tone.cancel();
  assert.equal(await playing, false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.contexts[0].closeCalls, 1);
  h.contexts[0].resumeNow();
  await Promise.resolve();
  assert.equal(h.contexts[0].oscillators.length, 0, 'late release resume cannot play into Settings capture');

  const next = h.tone.play('press');
  h.contexts[1].resumeNow();
  await Promise.resolve();
  h.contexts[1].oscillators[0].onended();
  assert.equal(await next, true);
  h.tone.cancel();
  assert.equal(h.contexts[1].closeCalls, 0, 'idle cancellation preserves a healthy reusable context');
  const following = h.tone.play('press');
  assert.equal(h.contexts.length, 2);
  h.contexts[1].oscillators[1].onended();
  assert.equal(await following, true);
  await h.tone.dispose();
  assert.equal(h.connected.size, 0);
  assert.equal(h.timers.size, 0);
});

test('repeated tone completion releases nodes, deadlines and abort listeners while reusing healthy context', async () => {
  const h = controlledAudio();
  const abort = new AbortController();
  const listeners = new Set();
  const signal = {
    get aborted() { return abort.signal.aborted; },
    addEventListener(type, listener, options) { listeners.add(listener); abort.signal.addEventListener(type, listener, options); },
    removeEventListener(type, listener) { listeners.delete(listener); abort.signal.removeEventListener(type, listener); },
  };
  for (let i = 0; i < 32; i++) {
    const playing = h.tone.play(i % 2 ? 'release' : 'press', { signal });
    assert.equal(h.timers.size, 1);
    assert.equal(listeners.size, 1);
    h.contexts[0].oscillators.at(-1).onended();
    assert.equal(await playing, true);
    assert.equal(h.connected.size, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(listeners.size, 0);
  }
  assert.equal(h.contexts.length, 1);
  abort.abort();
  await h.tone.dispose();
});
