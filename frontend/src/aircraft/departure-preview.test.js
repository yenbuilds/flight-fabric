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
      currentProfileKey: 'test', currentProfileRevision: 1, aircraft: { x: 0, z: 0, headingDeg: 0, speedKts: 0 },
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
  f.advance(1000); assert.equal(f.sent.at(-1).operation, 'status', 'late stationary replies need a fresh observation first');
  f.helper.receive(f.reply(f.sent.at(-1), { pushbackPreview: { ...f.reply().pushbackPreview, valid: false } }));
  f.advance(1000); assert.equal(f.sent.at(-1).operation, 'preview');
  f.helper.destroy();
});

test('an expired pushback plan keeps its live route marker while taxiing and replans only below the preview speed limit', () => {
  const f = fixture(); f.advance(600); f.helper.receive(f.reply(f.sent.at(-1), {
    aircraft: { x: 0, z: -30, headingDeg: 90, speedKts: 2 / 0.514444 },
    pushbackPreview: { ...f.reply().pushbackPreview, valid: false },
  }));
  const route = f.snapshot().data.route, scene = f.snapshot().data.scene;
  // 2 m/s is about 3.9 kt: ordinary slow taxi, with one fresh status per second.
  for (let seconds = 1; seconds <= 30; seconds++) {
    f.advance(1000);
    assert.equal(f.sent.at(-1).operation, 'status');
    f.helper.receive(f.reply(f.sent.at(-1), {
      aircraft: { x: seconds * 2, z: -30, headingDeg: 90, speedKts: 2 / 0.514444 },
      pushbackPreview: { id: '09', icao: 'TEST', runway: '09', phase: 'preview', valid: false },
      preview: undefined, scene: undefined,
    }));
    assert.equal(f.snapshot().fresh, true);
    assert.equal(f.snapshot().data.route, route);
    assert.equal(f.snapshot().data.scene, scene);
    assert.equal(f.timers.size, 1);
  }
  assert.equal(f.sent.filter(m => m.operation === 'preview').length, 1, 'moving status never requests a replacement pushback plan');
  // Brake gently at 0.2 m/s² until below the backend's 0.5 kt preview limit.
  for (let seconds = 1; seconds <= 9; seconds++) {
    f.advance(1000); assert.equal(f.sent.at(-1).operation, 'status');
    f.helper.receive(f.reply(f.sent.at(-1), { aircraft: { x: 60 + 2 * seconds - 0.1 * seconds ** 2,
      z: -30, headingDeg: 90, speedKts: (2 - 0.2 * seconds) / 0.514444 },
      pushbackPreview: { id: '09', icao: 'TEST', runway: '09', phase: 'preview', valid: false }, preview: undefined, scene: undefined }));
  }
  f.advance(1000); assert.equal(f.sent.at(-1).operation, 'preview', 'a sufficiently slow aircraft can obtain a new pushback start plan');
  assert.ok(f.sent.every(m => m.type === 'requestTaxiGuidance' && ['preview', 'status'].includes(m.operation)));
  f.helper.destroy(); assert.equal(f.timers.size, 0);
});

test('unknown or stale speed cannot trigger pushback recapture', () => {
  for (const speed of [undefined, null, NaN, Infinity, -1]) {
    const f = fixture(); f.advance(600); f.helper.receive(f.reply()); f.advance(1000);
    f.helper.receive(f.reply(f.sent.at(-1), { aircraft: { x: 0, z: 0, headingDeg: 0, speedKts: speed },
      pushbackPreview: { ...f.reply().pushbackPreview, valid: false } }));
    f.advance(1000); assert.equal(f.sent.at(-1).operation, 'status', 'unknown speed keeps read-only position polling');
    f.helper.destroy();
  }
  const f = fixture(); f.advance(600); f.helper.receive(f.reply()); f.advance(1000);
  const delayed = f.reply(f.sent.at(-1), { pushbackPreview: { ...f.reply().pushbackPreview, valid: false } });
  f.advance(2000); f.helper.receive(delayed);
  assert.equal(f.snapshot().fresh, false);
  f.advance(1000); assert.equal(f.sent.at(-1).operation, 'status', 'delayed stationary data cannot cause a recapture');
  f.helper.destroy();
});

test('a recapture rejected as the aircraft starts moving recovers by reading the retained plan', () => {
  const f = fixture(), stopped = { x: 0, z: -30, headingDeg: 90, speedKts: 0 };
  f.advance(600); f.helper.receive(f.reply(f.sent.at(-1), { aircraft: stopped })); f.advance(1000);
  f.helper.receive(f.reply(f.sent.at(-1), { aircraft: stopped, pushbackPreview: { ...f.reply().pushbackPreview, valid: false } }));
  const route = f.snapshot().data.route;
  f.advance(1000); assert.equal(f.sent.at(-1).operation, 'preview');
  // The aircraft can begin moving between the stationary status and recapture.
  f.helper.receive({ type: 'toolbarTaxiState', requestId: f.sent.at(-1).requestId, ok: false,
    error: 'Stop on the ground to preview pushback.' });
  assert.equal(f.snapshot().fresh, false);
  assert.equal(f.snapshot().data.route, route);
  const before = f.sent.length;
  f.advance(4999); assert.equal(f.sent.length, before, 'failure retains the existing bounded retry delay');
  f.advance(251); assert.equal(f.sent.at(-1).operation, 'status', 'failure does not loop on rejected moving previews');
  f.helper.receive(f.reply(f.sent.at(-1), { aircraft: { x: 5, z: -30, headingDeg: 90, speedKts: 2 / 0.514444 },
    pushbackPreview: { id: '09', icao: 'TEST', runway: '09', phase: 'preview', valid: false }, preview: undefined, scene: undefined }));
  assert.equal(f.snapshot().fresh, true); assert.equal(f.snapshot().error, '');
  assert.equal(f.snapshot().data.route, route);
  f.advance(1000); assert.equal(f.sent.at(-1).operation, 'status');
  f.helper.destroy(); assert.equal(f.timers.size, 0);
});
