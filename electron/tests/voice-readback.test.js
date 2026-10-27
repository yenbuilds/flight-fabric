'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createVoiceReadback } = require('../voice-readback');

function fixture(selectedEngine = 'kokoro') {
  const children = [], played = [], spoken = [], timers = new Set();
  const engine = createVoiceReadback({
    player: { getInfo: () => ({ available: true, local: true, lastError: '' }),
      cancel: () => true, speak: text => { spoken.push(text); return true; },
      playAudio: wav => { played.push(wav); return true; } },
    spawnWorker() {
      const child = new EventEmitter();
      child.messages = []; child.kill = () => { child.killed = true; return true; };
      child.postMessage = message => child.messages.push(message);
      children.push(child); return child;
    },
    setTimer: fn => { timers.add(fn); return fn; }, clearTimer: fn => timers.delete(fn),
  });
  if (selectedEngine) engine.select(selectedEngine);
  const wav = Buffer.alloc(100); wav.write('RIFF');
  function ready(child = children.at(-1)) { child.emit('message', { type: 'ready' }); }
  function complete(child = children.at(-1)) { child.emit('message', { type: 'audio', id: child.messages.at(-1).id, wav }); }
  return { engine, children, played, spoken, timers, ready, complete, wav };
}

test('Kokoro is lazy, caches identical text, and switches to Windows without loading a model', () => {
  const f = fixture();
  assert.equal(f.engine.getInfo().selectedEngine, 'kokoro');
  assert.equal(f.children.length, 0);
  assert.equal(f.engine.speak('Heading two seven zero set.'), true);
  f.ready(); f.complete();
  assert.equal(f.played.length, 1);
  f.engine.speak('Heading two seven zero set.');
  assert.equal(f.played.length, 2);
  assert.equal(f.children[0].messages.length, 1);
  f.engine.select('windows-sapi');
  assert.equal(f.children[0].killed, true);
  f.engine.speak('Heading one eight zero set.');
  assert.deepEqual(f.spoken, ['Heading one eight zero set.']);
  assert.equal(f.children.length, 1);
  f.engine.dispose();
});

test('Windows is the default and never preloads Kokoro even with spoken feedback active', () => {
  const f = fixture(null);
  assert.equal(f.engine.getInfo().selectedEngine, 'windows-sapi');
  f.engine.select('windows-sapi');
  f.engine.setActive(true); f.engine.setActive(true);
  f.engine.selectVoice('kokoro', 'bf_emma');
  f.engine.select('windows-sapi');
  assert.equal(f.engine.speak('Heading two seven zero set.'), true);
  assert.deepEqual(f.spoken, ['Heading two seven zero set.']);
  assert.equal(f.children.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.engine.getInfo().preparing, false);
  f.engine.dispose();
});

for (const phase of ['loading', 'ready', 'generating']) {
test(`switching to Windows during Kokoro ${phase} retires it without late playback or restart`, () => {
  const f = fixture();
  f.engine.setActive(true);
  if (phase !== 'loading') f.ready();
  if (phase === 'generating') f.engine.speak('Gear down selected.');
  const old = f.children[0];
  const queuedTimeouts = [...f.timers];
  f.engine.select('windows-sapi');
  assert.equal(old.killed, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.engine.getInfo().preparing, false);
  // Native messages and already queued deadline callbacks may arrive after retirement.
  old.emit('spawn'); old.emit('message', { type: 'ready' });
  old.emit('message', { type: 'audio', id: 1, wav: f.wav });
  old.emit('message', { type: 'error', id: 1 }); old.emit('error', new Error('Retired worker'));
  for (const timeout of queuedTimeouts) timeout();
  old.emit('exit', 1);
  f.engine.setActive(true);
  assert.equal(f.children.length, 1, 'active Windows feedback must not restart Kokoro after its exit');
  assert.deepEqual(f.played, []); assert.deepEqual(f.spoken, []);
  assert.equal(f.engine.getInfo().fallbackReason, '');
  assert.equal(f.engine.speak('Gear up selected.'), true);
  assert.deepEqual(f.spoken, ['Gear up selected.']);
  assert.equal(f.timers.size, 0);
  f.engine.dispose();
});
}

test('rapid engine switches wait for native exit and clear cached Kokoro audio', () => {
  const f = fixture();
  const text = 'Heading two seven zero set.';
  f.engine.setActive(true); f.ready();
  f.engine.speak(text); f.complete();
  f.engine.speak('Gear down selected.');
  const old = f.children[0];
  f.engine.select('windows-sapi');
  f.engine.speak('Gear up selected.');
  f.engine.select('kokoro'); f.engine.speak(text);
  assert.equal(old.killed, true);
  assert.equal(f.children.length, 1, 'replacement waits for the retired process to exit');
  assert.equal(f.played.length, 1, 'switching engines must discard the previous audio cache');
  f.complete(old); old.emit('message', { type: 'error' });
  old.emit('exit', 0);
  assert.equal(f.children.length, 2);
  old.emit('message', { type: 'ready' }); old.emit('error', new Error('Obsolete worker'));
  assert.equal(f.children[1].messages.length, 0, 'old readiness cannot activate the replacement');
  f.ready();
  assert.equal(f.children[1].messages[0].text, text);
  f.complete();
  assert.equal(f.played.length, 2);
  assert.deepEqual(f.spoken, ['Gear up selected.']);
  assert.equal(f.engine.getInfo().fallbackReason, '');
  f.engine.dispose();
});

test('replacement waits for native exit and discards obsolete audio and errors', () => {
  const f = fixture();
  f.engine.speak('Heading two seven zero set.'); f.ready();
  const old = f.children[0];
  f.engine.speak('Heading one eight zero set.');
  f.engine.speak('Heading zero nine zero set.');
  assert.equal(f.children.length, 1, 'no concurrent synthesis process');
  f.complete(old); old.emit('message', { type: 'error' });
  assert.equal(f.played.length, 0); assert.equal(f.spoken.length, 0);
  old.emit('exit', 0);
  assert.equal(f.children.length, 2);
  f.ready(); assert.equal(f.children[1].messages[0].text, 'Heading zero nine zero set.');
  f.complete(); assert.equal(f.played.length, 1);
  f.engine.dispose();
});

test('PTT cancellation, release and disposal prevent late playback or fallback', () => {
  for (const action of ['cancel', 'release', 'dispose']) {
    const f = fixture(); f.engine.speak('Gear down selected.'); f.ready();
    f.engine[action](); f.complete(); f.children[0].emit('message', { type: 'error' });
    f.children[0].emit('exit', 1);
    assert.equal(f.played.length, 0); assert.equal(f.spoken.length, 0);
    assert.equal(f.timers.size, 0);
    if (action === 'dispose') assert.equal(f.engine.speak('Gear up selected.'), false);
    f.engine.dispose();
  }
});

test('timeout falls back once, keeps preference, and explicit retry recovers', () => {
  const f = fixture(); f.engine.speak('Altitude ten thousand set.');
  [...f.timers][0]();
  assert.deepEqual(f.spoken, ['Altitude ten thousand set.']);
  assert.equal(f.engine.getInfo().selectedEngine, 'kokoro');
  assert.equal(f.engine.getInfo().engine, 'windows-sapi');
  f.children[0].emit('exit', 1);
  f.engine.speak('Flaps one selected.'); assert.equal(f.children.length, 1);
  f.engine.select('kokoro'); f.engine.speak('Flaps two selected.'); f.ready(); f.complete();
  assert.equal(f.played.length, 1); assert.equal(f.engine.getInfo().fallbackReason, '');
  f.engine.dispose();
});

test('native crash, malformed audio, failed startup and shutdown remain bounded', () => {
  for (const mode of ['exit', 'error', 'invalid']) {
    const f = fixture(); f.engine.speak('Parking brake set.'); f.ready();
    const child = f.children[0];
    if (mode === 'exit') child.emit('exit', 1);
    else child.emit('message', mode === 'error' ? { type: 'error', id: 1 } : { type: 'audio', id: 1, wav: [] });
    assert.deepEqual(f.spoken, ['Parking brake set.']);
    assert.equal(f.timers.size, 0); f.engine.dispose();
  }
  const engine = createVoiceReadback({ player: { getInfo: () => ({ available: true }), cancel() {}, speak: () => true },
    spawnWorker() { throw new Error('Cannot launch'); } });
  engine.select('kokoro');
  assert.equal(engine.speak('Gear down selected.'), true);
  assert.match(engine.getInfo().fallbackReason, /could not start/); engine.dispose();
});

test('rejects unknown engines and invalid text before changing active work', () => {
  const f = fixture(); f.engine.speak('Gear down selected.');
  assert.throws(() => f.engine.select('../model'), /Unsupported/);
  assert.throws(() => f.engine.speak('x'.repeat(241)), /Invalid/);
  assert.throws(() => f.engine.selectVoice('kokoro', 'missing'), /Unsupported/);
  assert.equal(f.children[0].killed, undefined); f.engine.dispose();
});

test('voice choices reuse the model but keep cache entries distinct and retire pending old speech', () => {
  const f = fixture();
  const text = 'Heading two seven zero set.';
  f.engine.speak(text); f.ready(); f.complete();
  assert.equal(f.children[0].messages[0].voiceId, 'af_heart');
  f.engine.selectVoice('kokoro', 'bf_emma');
  f.engine.speak(text); f.complete();
  assert.equal(f.children.length, 1, 'idle model stays loaded across voice changes');
  assert.equal(f.children[0].messages[1].voiceId, 'bf_emma');
  f.engine.selectVoice('kokoro', 'af_heart'); f.engine.speak(text);
  assert.equal(f.children[0].messages.length, 2, 'matching voice can use its own cached audio');
  f.engine.speak('Altitude ten thousand set.');
  const old = f.children[0];
  f.engine.selectVoice('kokoro', 'af_bella');
  assert.equal(old.killed, true);
  const before = f.played.length;
  f.complete(old); old.emit('message', { type: 'error' }); old.emit('exit', 1);
  assert.equal(f.played.length, before); assert.deepEqual(f.spoken, []);
  f.engine.speak(text); f.ready(); f.complete();
  assert.equal(f.children[1].messages[0].voiceId, 'af_bella');
  assert.equal(f.played.length, before + 1);
  f.engine.dispose();
});

test('short US/UK catalogue preserves a saved older American voice without crowding new selections', () => {
  const f = fixture();
  assert.deepEqual(f.engine.getInfo().voices.map(voice => voice.id),
    ['af_bella', 'af_heart', 'am_michael', 'am_puck', 'bf_emma', 'bf_isabella', 'bm_fable', 'bm_george']);
  f.engine.selectVoice('kokoro', 'af_alloy');
  assert.equal(f.engine.getInfo().selectedVoice, 'af_alloy');
  assert.equal(f.engine.getInfo().voices.length, 9);
  assert.ok(f.engine.getInfo().voices.some(voice => voice.id === 'af_alloy'));
  f.engine.speak('Heading two seven zero set.'); f.ready(); f.complete();
  assert.equal(f.children[0].messages[0].voiceId, 'af_alloy');
  f.engine.selectVoice('kokoro', 'bm_george');
  assert.equal(f.engine.getInfo().voices.length, 8);
  f.engine.speak('Heading two seven zero set.'); f.complete();
  assert.equal(f.children[0].messages[1].voiceId, 'bm_george');
  assert.equal(f.children.length, 1);
  f.engine.dispose();
});

test('cancelling before the process spawns retries termination on spawn', () => {
  const f = fixture(); f.engine.speak('Parking brake released.');
  const child = f.children[0]; let attempts = 0;
  child.kill = () => { attempts++; return false; };
  f.engine.cancel(); assert.equal(attempts, 1);
  child.emit('spawn'); assert.equal(attempts, 2);
  child.emit('message', { type: 'ready' }); child.emit('exit', 1);
  assert.equal(child.messages.length, 0); assert.equal(f.played.length, 0); f.engine.dispose();
});

test('idle unload and bounded cache preserve only current audio', () => {
  const f = fixture();
  for (let i = 0; i < 34; i++) { f.engine.speak(`Heading ${i} set.`); if (i === 0) f.ready(); f.complete(); }
  assert.equal(f.children[0].messages.length, 34);
  f.engine.speak('Heading 0 set.'); assert.equal(f.children[0].messages.length, 35, 'oldest cache entry evicted');
  f.complete(); [...f.timers][0](); assert.equal(f.children[0].killed, true);
  f.children[0].emit('exit', 0); assert.equal(f.children.length, 1, 'idle exit does not respawn');
  f.engine.dispose();
});

test('enabled feedback preloads once, remains ready between commands, and releases on disable', () => {
  const f = fixture();
  f.engine.setActive(true); f.engine.setActive(true);
  assert.equal(f.children.length, 1); assert.equal(f.engine.getInfo().preparing, true);
  f.ready(); assert.equal(f.engine.getInfo().preparing, false);
  assert.equal(f.children[0].messages.length, 0, 'preparation does not synthesize or play speech');
  f.engine.speak('Heading two seven zero set.'); f.complete();
  assert.equal(f.timers.size, 0, 'enabled feedback stays ready instead of unloading after two quiet minutes');
  f.engine.setActive(false);
  assert.equal(f.children[0].killed, true);
  f.children[0].emit('exit', 0);
  assert.equal(f.children.length, 1, 'disabled speech never reloads itself');
  f.engine.dispose();
});

test('background preparation failure is bounded and does not silently respawn', () => {
  const f = fixture(); f.engine.setActive(true);
  [...f.timers][0]();
  assert.match(f.engine.getInfo().fallbackReason, /too long/);
  assert.deepEqual(f.spoken, []);
  f.children[0].emit('exit', 1); f.engine.setActive(true);
  assert.equal(f.children.length, 1);
  f.engine.select('kokoro'); assert.equal(f.children.length, 2);
  f.engine.setActive(false); f.children[1].emit('message', { type: 'ready' });
  f.children[1].emit('exit', 0); assert.equal(f.children.length, 2);
  f.engine.dispose();
});
