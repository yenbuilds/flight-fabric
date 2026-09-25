import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeparturePreview } from './departure-preview.js';

function fixture() {
  let time = 10000, serial = 0, snapshot;
  const timers = new Map(), sent = [];
  const context = { connected: true, visible: true, enabled: true, profileKey: 'test', profileRevision: 1, icao: 'TEST', runway: '09' };
  const helper = createDeparturePreview({ now: () => time, send: message => { sent.push(message); return true; },
    changed: value => { snapshot = value; }, setTimeout: (fn, ms) => { timers.set(++serial, { fn, at: time + ms }); return serial; },
    clearTimeout: id => timers.delete(id) });
  function advance(ms) {
    const until = time + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      time = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    time = until;
  }
  function reply(request = sent.at(-1), fields = {}) {
    return { type: 'toolbarTaxiState', ok: true, requestId: request.requestId,
      currentProfileKey: 'test', currentProfileRevision: 1, aircraft: { x: 0, z: 0, headingDeg: 0 },
      pushbackPreview: { id: request.runway, icao: request.icao, runway: request.runway, valid: true, phase: 'preview', points: [{x:0,z:0},{x:0,z:-30}] },
      preview: { points: [{x:0,z:-30},{x:100,z:-30}] }, scene: { key: 1 }, ...fields };
  }
  helper.update(context);
  return { helper, sent, context, advance, reply, snapshot: () => snapshot, timers };
}

test('automatic departure preview debounces edits, ignores old replies and never sends a control operation', () => {
  const f = fixture();
  f.advance(600); assert.equal(f.sent.length, 1);
  const old = f.reply();
  f.helper.update({ ...f.context, runway: '27' });
  assert.equal(f.helper.receive(old), false);
  f.advance(600); f.helper.receive(f.reply());
  assert.equal(f.snapshot().data.pushbackPreview.runway, '27');
  assert.equal(f.snapshot().fresh, true);
  f.advance(1000); assert.equal(f.sent.at(-1).operation, 'status');
  f.helper.receive(f.reply(f.sent.at(-1), { aircraft: null }));
  assert.equal(f.snapshot().fresh, false, 'fresh transport cannot make stale position live');
  f.helper.update({ ...f.context, visible: false });
  assert.equal(f.timers.size, 0, 'hidden viewers keep no polling timer');
  const count = f.sent.length; f.advance(10000);
  assert.equal(f.sent.length, count); assert.equal(f.snapshot().data, null);
  assert.ok(f.sent.every(m => m.type === 'requestTaxiGuidance' && ['preview', 'status'].includes(m.operation) && m.pushback === true));
  f.helper.destroy(); assert.equal(f.timers.size, 0);
});

test('position changes replan, silence disables readiness, and scene-free progress retains the shown geometry', () => {
  const f = fixture(); f.advance(600); f.helper.receive(f.reply());
  const geometry = f.snapshot().data.pushbackPreview.points;
  f.advance(1000);
  f.helper.receive(f.reply(f.sent.at(-1), { pushbackPreview: { id: '09', icao: 'TEST', runway: '09', phase: 'pushing', valid: false }, preview: undefined, scene: undefined }));
  assert.equal(f.snapshot().data.pushbackPreview.points, geometry);
  f.advance(2250); assert.equal(f.snapshot().fresh, false);
  f.helper.receive(f.reply(f.sent.at(-1), { pushbackPreview: { ...f.reply().pushbackPreview, valid: false } }));
  f.advance(1000); assert.equal(f.sent.at(-1).operation, 'preview');
  f.helper.destroy();
});
