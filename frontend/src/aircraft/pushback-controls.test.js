import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPushbackControls } from './pushback-controls.js';

function fixture() {
  let time = 10000, serial = 0, completed = 0, snapshot;
  const timers = new Map(), sent = [];
  const context = { connected: true, visible: true, enabled: true, profileKey: 'test', profileRevision: 1, icao: 'TEST', runway: '09',
    preview: { fresh: true, data: { pushbackPreview: { id: 'shown', phase: 'preview', valid: true } } } };
  const helper = createPushbackControls({ now: () => time, send: m => { sent.push(m); return true; }, changed: s => { snapshot = s; },
    complete: () => completed++, setTimeout: (fn, ms) => { timers.set(++serial, { fn, at: time + ms }); return serial; }, clearTimeout: id => timers.delete(id) });
  function advance(ms) {
    const end = time + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      time = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    time = end;
  }
  function reply(request = sent.at(-1), values = {}) {
    helper.receive({ type: 'pushbackState', requestId: request.requestId, ok: true, currentProfileKey: 'test', currentProfileRevision: 1,
      icao: 'TEST', runway: '09', active: false, status: 'idle', canStart: true, ...values });
  }
  helper.update(context);
  return { helper, context, sent, timers, advance, reply, snapshot: () => snapshot, completions: () => completed };
}
test('Start requires fresh status and the shown preview, and duplicate activation cannot send another Start', () => {
  const f = fixture();
  assert.equal(f.helper.request('start'), false);
  f.reply(); assert.equal(f.snapshot().canStart, true);
  f.helper.update({ ...f.context, preview: { ...f.context.preview, fresh: false } });
  assert.equal(f.helper.request('start'), false);
  f.helper.update(f.context); f.helper.request('start');
  assert.equal(f.sent.at(-1).previewId, 'shown');
  assert.equal(f.snapshot().active, true); assert.equal(f.helper.request('start'), false);
  f.reply(undefined, { active: true, status: 'pushing', canStart: false });
  f.advance(500);
  assert.equal(f.sent.at(-1).operation, 'status');
  f.reply(undefined, { active: false, status: 'complete' });
  assert.equal(f.snapshot().completed, true); assert.equal(f.snapshot().canStart, false); assert.equal(f.completions(), 1);
  f.helper.destroy(); assert.equal(f.timers.size, 0);
});
test('closing or switching context stops owned pushback and late replies cannot resume it', () => {
  for (const next of [{ visible: false }, { connected: false }, { enabled: false }, { profileKey: 'other' }]) {
    const f = fixture(); f.reply(); f.helper.request('start'); const start = f.sent.at(-1);
    f.helper.update({ ...f.context, ...next });
    assert.equal(f.sent.filter(r => r.operation === 'stop').length, 1);
    f.reply(start, { active: true, status: 'pushing' });
    assert.equal(f.snapshot().active, false);
    f.helper.update(f.context); f.advance(500);
    assert.equal(f.sent.filter(r => r.operation === 'start').length, 1);
    f.helper.destroy(); assert.equal(f.timers.size, 0);
  }
});
test('observing another owner never stops it on hide, silence or destroy', () => {
  const f = fixture(); f.reply(undefined, { active: true, status: 'pushing', canStart: false });
  f.advance(2500); f.helper.update({ ...f.context, visible: false }); f.helper.destroy();
  assert.ok(f.sent.every(r => r.operation === 'status'));
});
test('silence stops an owned pushback and stale replies cannot replace a later stop', () => {
  const f = fixture(); f.reply(); f.helper.request('start'); const start = f.sent.at(-1);
  f.reply(start, { active: true, status: 'pushing' }); f.advance(2250);
  const stop = f.sent.find(r => r.operation === 'stop'); assert.ok(stop);
  f.reply(stop, { active: false, status: 'stopped' });
  f.reply(start, { active: true, status: 'pushing' });
  assert.equal(f.snapshot().active, false); f.helper.destroy();
});
test('permission and brake reasons remain beside a disabled Start', () => {
  const f = fixture(); f.reply(undefined, { ok: false, error: 'Aircraft control permission is required for pushback.' });
  assert.equal(f.snapshot().canStart, false); assert.match(f.snapshot().reason, /permission/);
  f.advance(1000); f.reply(undefined, { canStart: false, unavailableReason: 'Release the parking brake to push back.' });
  assert.equal(f.snapshot().canStart, false); assert.match(f.snapshot().reason, /parking brake/); f.helper.destroy();
});

test('out-of-order command replies clear pending state without replacing newer observed state', () => {
  const f = fixture(); f.reply(); f.helper.request('start'); const start = f.sent.at(-1);
  f.advance(1000); f.reply(undefined, { active: true, status: 'pushing' });
  f.reply(start, { active: true, status: 'pushing' });
  assert.equal(f.snapshot().pending, '');
  f.advance(250); f.reply(undefined, { active: false, status: 'complete' });
  assert.equal(f.snapshot().completed, true); f.helper.destroy();
});

test('command failures stay visible across successful status polling until the user retries', () => {
  const f = fixture(); f.reply(); f.helper.request('start');
  f.reply(undefined, { ok: false, error: 'The displayed preview has expired.' });
  f.advance(1000); f.reply();
  assert.match(f.snapshot().reason, /preview has expired/);
  f.helper.request('start'); assert.doesNotMatch(f.snapshot().reason, /preview has expired/); f.helper.destroy();
});
