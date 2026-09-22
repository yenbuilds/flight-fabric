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

test('an altitude the aircraft could not have flown to is a reposition, not a trail', () => {
  const clock = createClock();
  const buffer = createLiveTrackBuffer({ now: clock.now });
  // The simulator loads a flight at Nuuk: one sample lands at a six-figure
  // altitude over the parked aircraft before the real altitude arrives.
  buffer.append({ lat: 64.19, lon: -51.68, altFt: 101_932 });
  clock.advance(1000);
  const settled = buffer.append({ lat: 64.19, lon: -51.68, altFt: 279 });
  assert.equal(settled.newSegment, true);
  assert.equal(buffer.size(), 1, 'the spike is retired instead of kept as a vertex');
  assert.equal(buffer.getSegments().length, 1);
  assert.equal(buffer.getLatest().altFt, 279);
  assert.equal(buffer.getMinAltFt(), 279);

  // A spike that lingers for several samples over the parked aircraft is a
  // stationary stub and is retired the same way.
  clock.advance(1000);
  buffer.append({ lat: 64.19, lon: -51.68, altFt: 101_932 });
  clock.advance(1000);
  buffer.append({ lat: 64.19, lon: -51.68, altFt: 101_932 });
  clock.advance(1000);
  buffer.append({ lat: 64.19, lon: -51.68, altFt: 101_932 });
  clock.advance(1000);
  buffer.append({ lat: 64.19, lon: -51.68, altFt: 280 });
  assert.equal(buffer.getSegments().length, 1);
  assert.equal(buffer.size(), 1);
  assert.equal(buffer.getLatest().altFt, 280);
  assert.equal(buffer.getMinAltFt(), 280);
  for (const segment of buffer.getSegments()) {
    assert.ok(segment.every(point => point.altFt < 1000), 'no spike survives in the trail');
  }

  // A sample with no altitude between the spike and the real value does not
  // let the spike through.
  const gapped = createLiveTrackBuffer({ now: clock.now });
  gapped.append({ lat: 64.19, lon: -51.68, altFt: 101_932 });
  clock.advance(1000);
  gapped.append({ lat: 64.19, lon: -51.68 });
  clock.advance(1000);
  gapped.append({ lat: 64.19, lon: -51.68, altFt: 279 });
  assert.ok(gapped.getSegments().flat().every(point => point.altFt === null || point.altFt < 1000));
  assert.equal(gapped.getMinAltFt(), 279);
});

test('a fast climb, a pause and a low spike keep the trail and altitude reference honest', () => {
  const clock = createClock();
  const buffer = createLiveTrackBuffer({ now: clock.now });
  buffer.append({ lat: 51.47, lon: -0.46, altFt: 1000 });
  clock.advance(2000);
  buffer.append({ lat: 51.49, lon: -0.46, altFt: 2000 });
  clock.advance(1000);
  // 1,000 ft in a second (60,000 fpm) is inside the tolerance for a zoom climb.
  const climb = buffer.append({ lat: 51.51, lon: -0.46, altFt: 3000 });
  assert.equal(climb.newSegment, false, 'a steep climb is continuous');
  clock.advance(10 * 60 * 1000);
  // After a long pause the sim resumes where it froze; the continuity budget
  // grows with the gap so a resumed climb is not a reposition.
  const resumed = buffer.append({ lat: 51.53, lon: -0.46, altFt: 12_000 });
  assert.equal(resumed.newSegment, false);
  assert.equal(buffer.getSegments().length, 1);
  assert.equal(buffer.size(), 4);

  // A brief sample at a nonsense low altitude starts a new segment; the
  // flown trail is kept and the altitude reference ignores the spike once
  // the real altitude returns.
  clock.advance(1000);
  const spike = buffer.append({ lat: 51.53, lon: -0.46, altFt: -30_000 });
  assert.equal(spike.newSegment, true);
  assert.equal(buffer.getSegments().length, 2, 'the flown trail stays');
  clock.advance(1000);
  buffer.append({ lat: 51.53, lon: -0.46, altFt: 12_050 });
  assert.equal(buffer.getSegments().length, 2);
  assert.equal(buffer.getSegments()[0].length, 4);
  assert.equal(buffer.getSegments()[1].length, 1);
  assert.equal(buffer.getMinAltFt(), 1000, 'the retired spike does not lower the ground reference');
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
