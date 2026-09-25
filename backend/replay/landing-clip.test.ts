'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildLandingReplayClip } = require('./landing-clip');
function fixture() {
  const rows = Array.from({ length: 121 }, (_, index) => ({ record_type: 'SAMPLE',
    ts: 100_000 + index * 1000, timestamp_monotonic: index * 1000,
    aircraft: '737-800 PAX SSW TC', aircraft_profile_id: 'pmdg-737',
    lat_deg: -33, lon_deg: 151 + index * 0.0001, alt_plane_ft: 200 - index,
    alt_msl_ft: 900, pitch_deg: 3, bank_deg: -1, hdg_true_deg: 359,
  }));
  return { rows, timeline: { events: [{ type: 'landing', timestampMs: 190_000, touchdownNumber: 1 }] } };
}
test('clip preserves physical altitude, source clock and exact identity', () => {
  const { rows, timeline } = fixture();
  rows.push({ record_type: 'LANDING', ts: 220_000 } as any);
  const clip = buildLandingReplayClip(rows, timeline, 0);
  assert.equal(clip.title, '737-800 PAX SSW TC');
  assert.equal(clip.touchdownMs, 90_000);
  assert.equal(clip.samples[0].altitudeFt, 200);
  assert.equal(clip.samples[0].pitchDeg, 3);
  assert.equal(clip.samples[0].sourceTimestampMs, 100_000);
  assert.equal(clip.samples.length, 121);
});
test('a delayed LANDING-only result cannot anchor native replay', () => {
  const { rows, timeline } = fixture();
  delete timeline.events[0].touchdownNumber;
  assert.throws(() => buildLandingReplayClip(rows, timeline, 0), /reconstructed touchdown/);
});
test('rejects missing aircraft, physical altitude, duplicate clocks, gaps and pause data', () => {
  for (const mutate of [
    row => { row.aircraft = ''; }, row => { row.alt_plane_ft = null; },
    row => { row.ts -= 1000; }, row => { row.timestamp_monotonic += 500; },
    row => { row.sim_paused = '1'; }, row => { row.sim_in_menu = true; }, row => { row.attitude_valid = false; },
  ]) {
    const { rows, timeline } = fixture(); mutate(rows[30]);
    assert.throws(() => buildLandingReplayClip(rows, timeline, 0));
  }
  const { rows, timeline } = fixture(); rows.splice(30, 3);
  assert.throws(() => buildLandingReplayClip(rows, timeline, 0), /gap/);
});
test('requires samples before and after a known contact', () => {
  const { rows, timeline } = fixture();
  assert.throws(() => buildLandingReplayClip(rows.slice(90), timeline, 0), /both sides/);
  assert.throws(() => buildLandingReplayClip(rows, timeline, 2), /touchdown/);
});
test('does not silently drop corrupt timestamps or coerce booleans and blanks into a pose', () => {
  for (const mutate of [
    row => { row.ts = 'broken'; }, row => { row.ts = null; }, row => { row.ts = false; },
    row => { row.alt_plane_ft = false; }, row => { row.lat_deg = ' '; },
    row => { row.pitch_deg = []; }, row => { row.sim_paused = 'true'; },
    row => { row.attitude_valid = 'false'; }, row => { row.sim_in_menu = 'unknown'; },
  ]) {
    const { rows, timeline } = fixture(); mutate(rows[30]);
    assert.throws(() => buildLandingReplayClip(rows, timeline, 0));
  }
});

test('oversized clips stop collecting samples at the bound', () => {
  const { rows, timeline } = fixture();
  const source = Array.from({ length: 1301 }, () => rows[30]);
  source.push({ get record_type() { return assert.fail('must stop before scanning the remaining oversized clip'); } } as any);
  assert.throws(() => buildLandingReplayClip(source, timeline, 0), /sample count/);
});
export {};
