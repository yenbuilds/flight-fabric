import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveTrackBuffer } from './live-track-buffer.js';

function createClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance(ms) { nowMs += ms; },
  };
}

test('a parked aircraft does not grow the trail, a moving one commits one vertex at a time', () => {
  const clock = createClock();
  const buffer = createLiveTrackBuffer({ now: clock.now });
  buffer.append({ lat: 51.47, lon: -0.46, altFt: 80 });
  for (let index = 0; index < 20; index += 1) {
    clock.advance(1000);
    buffer.append({ lat: 51.47, lon: -0.46, altFt: 80 });
  }
  assert.equal(buffer.size(), 2, 'first point plus a live endpoint that keeps being replaced');

  // 0.5 nm per step, one step per second: each message commits a vertex.
  for (let index = 1; index <= 10; index += 1) {
    clock.advance(1000);
    buffer.append({ lat: 51.47 + (index * 0.5 / 60), lon: -0.46, altFt: 80 + (index * 300) });
  }
  assert.equal(buffer.size(), 12);
  assert.equal(buffer.getSegments().length, 1);
  assert.equal(buffer.getLatest().altFt, 3080);
  assert.equal(buffer.getMinAltFt(), 80);

  // Sub-second bursts mostly refresh the endpoint; vertices are committed
  // roughly once per second of flight rather than once per message.
  for (let index = 1; index <= 8; index += 1) {
    clock.advance(250);
    buffer.append({ lat: 51.47 + ((10 + (index * 0.25)) * 0.5 / 60), lon: -0.46, altFt: 3080 + (index * 10) });
  }
  assert.ok(buffer.size() >= 14 && buffer.size() <= 16, `burst of 8 samples adds a few vertices, not 8: ${buffer.size()}`);
  assert.equal(buffer.getLatest().altFt, 3160, 'the endpoint follows the newest sample');
});

test('a simulator reposition starts a new segment instead of a chord', () => {
  const clock = createClock();
  const buffer = createLiveTrackBuffer({ now: clock.now });
  buffer.append({ lat: 51.47, lon: -0.46, altFt: 80 });
  clock.advance(2000);
  buffer.append({ lat: 51.49, lon: -0.46, altFt: 500 });
  clock.advance(2000);
  buffer.append({ lat: 51.51, lon: -0.46, altFt: 1000 });
  clock.advance(1000);
  const jump = buffer.append({ lat: 40.64, lon: -73.78, altFt: 20 });
  assert.equal(jump.newSegment, true);
  assert.equal(buffer.getSegments().length, 2);
  assert.equal(buffer.getSegments()[0].length, 3, 'the original trail is kept');
  assert.equal(buffer.getSegments()[1].length, 1);

  clock.advance(1000);
  const seam = buffer.append({ lat: 40.64, lon: 106.22, altFt: 20 });
  assert.equal(seam.newSegment, true, 'a 180 degree longitude change is never bridged');
  assert.equal(buffer.getSegments().length, 2, 'an unrenderable single point segment is reused');
});

test('long flights thin the oldest vertices and keep segment ends and recent detail', () => {
  const clock = createClock();
  const buffer = createLiveTrackBuffer({ now: clock.now, maxPoints: 200 });
  for (let index = 0; index < 300; index += 1) {
    clock.advance(1000);
    buffer.append({ lat: 0, lon: index * 0.01, altFt: 1000 });
  }
  assert.ok(buffer.size() <= 200, `size ${buffer.size()} stays within the cap`);
  assert.ok(buffer.size() > 100, 'thinning halves only the oldest part');
  const segment = buffer.getSegments()[0];
  assert.equal(segment[0].lon, 0, 'the first vertex survives');
  assert.ok(Math.abs(segment[segment.length - 1].lon - 2.99) < 1e-9, 'the live endpoint survives');
  for (let index = 1; index < segment.length; index += 1) {
    assert.ok(segment[index].lon > segment[index - 1].lon, 'order is preserved');
  }

  buffer.reset();
  assert.equal(buffer.size(), 0);
  assert.equal(buffer.getLatest(), null);
  assert.equal(buffer.getMinAltFt(), null);
});

test('samples without a position are ignored', () => {
  const buffer = createLiveTrackBuffer({ now: () => 1 });
  assert.deepEqual(buffer.append({ lat: 'x', lon: 1 }), { appended: false, newSegment: false });
  assert.deepEqual(buffer.append({}), { appended: false, newSegment: false });
  assert.equal(buffer.size(), 0);
});

test('repeated short trails stay bounded without joining reposition gaps', () => {
  const clock = createClock();
  const buffer = createLiveTrackBuffer({ now: clock.now, maxPoints: 20 });
  for (let leg = 0; leg < 100; leg += 1) {
    for (let point = 0; point < 2; point += 1) {
      clock.advance(1000);
      buffer.append({ lat: leg % 2 === 0 ? 0 : 40, lon: point * 0.01, altFt: leg });
      assert.ok(buffer.size() <= 20, 'segment endpoints cannot bypass the point budget');
    }
  }
  const segments = buffer.getSegments();
  assert.ok(segments.length > 1, 'recent gaps are retained');
  for (const segment of segments) {
    assert.ok(segment.every(point => point.lat === segment[0].lat), 'no gap is bridged');
  }
  assert.equal(buffer.getLatest(), segments.at(-1).at(-1));
  assert.equal(buffer.getLatest().altFt, 99);
  assert.equal(buffer.getMinAltFt(), 0, 'the flight altitude reference remains stable');
});
