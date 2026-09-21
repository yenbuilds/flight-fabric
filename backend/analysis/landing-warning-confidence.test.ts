import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StallWarningFilter, transientStallRows } from '../telemetry-provider/stall-warning-filter';
import { RunwayExcursionFilter } from '../landing/runway-geometry-confidence';
import { analyzeRollout } from '../landing/rollout-analysis';
const { buildTouchdownRunwayAnalysis, buildCanonicalStabilityFrameFromCsvRow } = require('./flight-analysis');
const { scoreTouchdownDistance, inferSurfaceCondition } = require('../landing/landing-distance');

test('the WSSS fallback coordinate mismatch cannot establish an excursion or alignment penalty', () => {
  const runway = { source: 'ourairports', threshold: { lat: 1.376277, lon: 103.989393 },
    heading_true_deg: 203, lengthFt: 10694, widthFt: 197 };
  const result = buildTouchdownRunwayAnalysis({ runwayData: runway,
    touchdownPoint: { lat: 1.369883, lon: 103.986273 }, onRunway: true, surfaceInputs: { oatC: 30 } });
  const data = result.touchdownDistanceData;
  assert.equal(data.touchdown_distance_ft, 2590);
  assert.ok(Math.abs(data.lateral_offset_ft - 136) < 1);
  assert.equal(data.lateral_offset_suspect, true);
  assert.equal(data.lateral_offset_score, null);
  assert.equal(data.lateral_offset_grade, 'Unverified');
  // 2,590 ft on a 10,694 ft landing length: inside the 3,000 ft zone but past
  // the 2,333 ft Good limit, so it is a late-in-zone caution.
  assert.equal(data.touchdown_distance_grade, 'Acceptable');
  assert.equal(data.touchdown_zone_end_ft, 3000);
  assert.equal(data.runway_condition, null);
  assert.equal(result.tdzAchieved, true);
  const conflict = buildTouchdownRunwayAnalysis({ runwayData: { ...runway, source: 'msfs-facilities' },
    touchdownPoint: { lat: 1.369883, lon: 103.986273 }, onRunway: true });
  assert.equal(conflict.touchdownDistanceData.lateral_offset_score, null, 'conflicting surface telemetry must fail open');
});

test('the touchdown zone is 3,000 ft or one third of the runway and weather never moves it', () => {
  // Long runway: the zone ends at 3,000 ft on every surface.
  for (const surface of ['dry', 'wet', 'ice', 'snow', 'slush', 'unknown', null]) {
    const expectations: Array<[number, string, number]> = [
      [500, 'Outstanding', 100], [1000, 'Outstanding', 100], [1500, 'Outstanding', 100],
      [1501, 'Good', 95], [2333, 'Good', 95],
      [2334, 'Acceptable', 80], [3000, 'Acceptable', 80],
      [3001, 'Long Landing', 60], [5000, 'Long Landing', 60],
      [5001, 'Dangerous', 10],
    ];
    for (const [distance, grade, score] of expectations) {
      const result = scoreTouchdownDistance(distance, { surface, runwayLengthFt: 12000 });
      assert.equal(result.grade, grade, `${distance} ft on ${surface}`);
      assert.equal(result.score, score, `${distance} ft on ${surface}`);
      assert.equal(result.zoneEndFt, 3000);
    }
  }
  // Short runway: the zone is the first third, and half the runway is the overrun line.
  // Zone end 1,333 ft: Ideal to 1,083 ft, Good to 1,222 ft, Late to 1,333 ft.
  assert.equal(scoreTouchdownDistance(1080, { runwayLengthFt: 4000 }).grade, 'Outstanding');
  assert.equal(scoreTouchdownDistance(1100, { runwayLengthFt: 4000 }).grade, 'Good');
  assert.equal(scoreTouchdownDistance(1300, { runwayLengthFt: 4000 }).grade, 'Acceptable');
  assert.equal(scoreTouchdownDistance(1334, { runwayLengthFt: 4000 }).grade, 'Long Landing');
  assert.equal(scoreTouchdownDistance(2001, { runwayLengthFt: 4000 }).grade, 'Dangerous');
  assert.equal(scoreTouchdownDistance(2999, { runwayLengthFt: 4000 }).zoneEndFt, 1333);
  // The aiming point never moves toward the threshold.
  assert.equal(scoreTouchdownDistance(1000, { runwayLengthFt: 3000 }).grade, 'Outstanding');
  assert.equal(scoreTouchdownDistance(1001, { runwayLengthFt: 3000 }).grade, 'Long Landing');
  // Inside the first 500 ft is an amber caution, not a perfect landing.
  assert.equal(scoreTouchdownDistance(0, { runwayLengthFt: 12000 }).grade, 'Near Threshold');
  assert.equal(scoreTouchdownDistance(499, { runwayLengthFt: 12000 }).score, 85);
  assert.equal(scoreTouchdownDistance(-1, { runwayLengthFt: 4000 }).grade, 'Short Landing');
  assert.equal(scoreTouchdownDistance(2000, { runwayLengthFt: 2000 }).grade, 'Dangerous');
  assert.equal(inferSurfaceCondition({ oatC: 30 }).surface, null);
});

test('rollout never treats precise GPS plus unknown runway geometry as a proven runway-edge event', () => {
  const samples = [0, 200, 400].map(timestampMs => ({ timestampMs, onGround: true, gsKts: 100,
    bankDeg: 0, headingTrueDeg: 203, lat: 1.369883, lon: 103.986273 }));
  const context = { runwayHeadingTrueDeg: 203, runwayThreshold: { lat: 1.376277, lon: 103.989393 },
    runwayWidthFt: 197, coordinatePrecisionDigits: 7 };
  for (const source of [null, 'ourairports', 'recorded-snapshot', 'legacy-derived']) {
    const result = analyzeRollout(samples, { ...context, runwayGeometrySource: source });
    assert.equal(result?.assessment, 'normal');
    assert.equal(result?.lateralVerified, false);
  }
  assert.equal(analyzeRollout(samples, { ...context, runwayGeometrySource: 'msfs-facilities' })?.assessment, 'warning');
  const conflict = analyzeRollout(samples.map(sample => ({ ...sample, onRunway: true })),
    { ...context, runwayGeometrySource: 'msfs-facilities' });
  assert.equal(conflict?.assessment, 'normal', 'surface disagreement during rollout makes geometry unverified');
  assert.equal(conflict?.lateralNotScoredReason, 'surface_geometry_conflict');
  assert.equal(analyzeRollout(samples, { ...context, runwayWidthFt: null,
    runwayGeometrySource: 'msfs-facilities' })?.lateralVerified, false, 'missing width cannot establish an edge margin');
});

test('quarter-second stall pulses are suppressed; a continuous airborne warning is retained', () => {
  const filter = new StallWarningFilter();
  for (const start of [0, 600, 1000]) {
    assert.equal(filter.update(true, true, false, start), false);
    assert.equal(filter.update(true, true, false, start + 125), false);
    assert.equal(filter.update(false, true, false, start + 250), false);
  }
  for (const at of [2000, 2250, 2500, 2750]) assert.equal(filter.update(true, true, false, at), false);
  assert.equal(filter.update(true, true, false, 3000), true);
  assert.equal(filter.update(false, true, false, 3250), false);
  for (const at of [3500, 4000, 4500]) assert.equal(filter.update(true, true, true, at), false);
  assert.equal(filter.update(true, false, false, 5000), false);
  assert.equal(filter.update(true, true, false, 7000), false, 'missing time cannot confirm a warning');
});

test('historical stall suppression requires a complete short pair', () => {
  const rows = [
    { record_type: 'STALL', ts: 1000 }, { record_type: 'STALL_END', ts: 1250 },
    { record_type: 'STALL', ts: 2000 }, { record_type: 'STALL_END', ts: 3000 },
    { record_type: 'STALL', ts: 4000 },
  ];
  assert.deepEqual([...transientStallRows(rows)], rows.slice(0, 2));
  assert.equal(transientStallRows([{ record_type: 'STALL', ts: null }, { record_type: 'STALL_END', ts: '' }]).size, 0);
  assert.equal(transientStallRows([
    { record_type: 'STALL', timestamp_utc: '2026-09-13T00:00:00.000Z' },
    { record_type: 'STALL_END', timestamp_utc: '2026-09-13T00:00:00.250Z' },
  ]).size, 2);
});

test('a confirmed excursion requires a sustained known surface transition, never a paved taxiway or glitch', () => {
  const runway = { onGround: true, onRunway: true, valid: true, class: 'PAVED' };
  const grass = { ...runway, onRunway: false, class: 'UNPAVED' };
  const filter = new RunwayExcursionFilter();
  assert.equal(filter.update(runway, 100, 60, 0), false);
  assert.equal(filter.update(grass, 100, 60, 250), false);
  assert.equal(filter.update(runway, 100, 60, 500), false);
  assert.equal(filter.update(grass, 100, 60, 750), false);
  assert.equal(filter.update(grass, 100, 60, 1250), false);
  assert.equal(filter.update(grass, 100, 60, 1750), true);
  for (const surface of [{ ...grass, class: 'PAVED' }, { ...grass, valid: false }, { ...grass, onRunway: null }]) {
    const candidate = new RunwayExcursionFilter();
    candidate.update(runway, 100, 60, 0);
    for (const at of [250, 750, 1250, 1750]) assert.equal(candidate.update(surface, 100, 60, at), false);
  }
});

test('CSV speed targets require reliable telemetry and an active autothrottle', () => {
  const row = { ap_reliable: '1', athr_reliable: '1', athr_active: '1', ap_speed_target_kts: '144' };
  assert.equal(buildCanonicalStabilityFrameFromCsvRow(row, 100).selectedSpeedKts, 144);
  assert.equal(buildCanonicalStabilityFrameFromCsvRow({ ...row, ap_reliable: '' }, 100).selectedSpeedKts, null);
  assert.equal(buildCanonicalStabilityFrameFromCsvRow({ ...row, athr_active: '0' }, 100).selectedSpeedKts, null);
  assert.equal(buildCanonicalStabilityFrameFromCsvRow({ ...row, athr_reliable: '' }, 100).selectedSpeedKts, null);
});
