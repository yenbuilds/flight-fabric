import assert from 'node:assert/strict';
import test from 'node:test';
import { createSceneProjection } from './projection.js';
import {
  buildTrackColorScale,
  buildTrackGeometry,
  computeTrackBounds,
  computeTrackFloorFt,
  derivePointMetrics,
  normalizeTrackColorMode,
  rgbToHex,
  sampleRamp,
  TRACK_COLOR_MODES,
} from './track-geometry.js';

const START_MS = Date.UTC(2026, 8, 19, 12, 0, 0);

function climbSegment() {
  return [
    { lat: 51.47, lon: -0.46, altFt: 80, timestampMs: START_MS },
    { lat: 51.50, lon: -0.40, altFt: 3000, timestampMs: START_MS + 60_000 },
    { lat: 51.55, lon: -0.30, altFt: 9000, timestampMs: START_MS + 120_000 },
    { lat: 51.60, lon: -0.20, altFt: 9000, timestampMs: START_MS + 180_000 },
  ];
}

test('colour modes normalize and ramps interpolate between the documented stops', () => {
  assert.equal(normalizeTrackColorMode('groundSpeed'), 'groundSpeed');
  assert.equal(normalizeTrackColorMode('rainbow'), 'altitude');
  const stops = TRACK_COLOR_MODES.altitude.stops;
  assert.equal(rgbToHex(sampleRamp(stops, 0)), stops[0]);
  assert.equal(rgbToHex(sampleRamp(stops, 1)), stops[stops.length - 1]);
  const mid = sampleRamp(stops, 0.5);
  assert.ok(mid.every((channel) => channel >= 0 && channel <= 1));
  assert.equal(rgbToHex(sampleRamp(stops, -3)), stops[0], 'below-range clamps to the first stop');
  assert.equal(TRACK_COLOR_MODES.verticalSpeed.kind, 'diverging');
});

test('derived metrics fill vertical speed and ground speed from neighbouring samples', () => {
  const { segments, derived } = derivePointMetrics([climbSegment()]);
  assert.equal(derived, true);
  const [first, second] = segments[0];
  assert.ok(Math.abs(first.vsFpm - ((3000 - 80) / 1)) < 1e-6, 'first point climbs 2920 ft in one minute');
  assert.ok(first.gsKts > 100 && first.gsKts < 400, `ground speed derived from distance: ${first.gsKts}`);
  assert.ok(second.vsFpm > 0);
  const last = segments[0][3];
  assert.ok(Math.abs(last.vsFpm) < 1e-6, 'the last point looks back to a level neighbour');

  const recorded = derivePointMetrics([[{ lat: 0, lon: 0, altFt: 100, gsKts: 250, vsFpm: -700, timestampMs: 1 }]]);
  assert.equal(recorded.derived, false);
  assert.equal(recorded.segments[0][0].gsKts, 250, 'recorded values are never overwritten');

  const gapFilled = derivePointMetrics([[
    { lat: 0, lon: 0, altFt: 1000, timestampMs: 1 },
    { lat: 0, lon: 0.01, altFt: null, timestampMs: 2 },
  ]]);
  assert.equal(gapFilled.segments[0][1].altFt, 1000, 'altitude gaps carry the last known value');
});

test('colour scales span the data for sequential modes and centre on zero for vertical speed', () => {
  const { segments } = derivePointMetrics([climbSegment()]);
  const altitude = buildTrackColorScale(segments, 'altitude');
  assert.equal(altitude.lower, 80);
  assert.equal(altitude.upper, 9000);
  assert.equal(altitude.hasData, true);
  assert.equal(rgbToHex(altitude.colorFor(segments[0][0])), TRACK_COLOR_MODES.altitude.stops[0]);
  assert.equal(rgbToHex(altitude.colorFor(segments[0][2])), TRACK_COLOR_MODES.altitude.stops[4]);
  assert.ok(altitude.ticks.length >= 2 && altitude.ticks.every((tick) => tick.t >= 0 && tick.t <= 1));

  const vertical = buildTrackColorScale(segments, 'verticalSpeed');
  assert.equal(vertical.kind, 'diverging');
  assert.equal(-vertical.lower, vertical.upper, 'arms are symmetric');
  assert.ok(vertical.upper >= 2920);
  assert.equal(rgbToHex(vertical.colorFor({ vsFpm: 0 })), TRACK_COLOR_MODES.verticalSpeed.stops[1], 'level flight is the neutral midpoint');

  const empty = buildTrackColorScale([], 'groundSpeed');
  assert.equal(empty.hasData, false);
  assert.equal(empty.min, null);
  assert.ok(Array.isArray(empty.colorFor({})), 'points without data still get a colour');
});

test('floor and bounds describe the recorded track', () => {
  assert.equal(computeTrackFloorFt([climbSegment()]), 50, 'floor rounds the lowest altitude down to 50 ft');
  assert.equal(computeTrackFloorFt([]), 0);
  const bounds = computeTrackBounds([climbSegment()]);
  assert.ok(Math.abs(bounds.minLat - 51.47) < 1e-9 && Math.abs(bounds.maxLat - 51.60) < 1e-9);
  assert.ok(Math.abs(bounds.centerLon - (-0.33)) < 1e-9);
  assert.equal(bounds.pointCount, 4);
  const seam = computeTrackBounds([[{ lat: 0, lon: 179 }, { lat: 0, lon: -179 }]]);
  assert.ok(Math.abs(seam.maxLon - 181) < 1e-9, 'longitudes unwrap around the first point');
  assert.equal(computeTrackBounds([]), null);
});

test('track geometry emits segment pairs, a curtain to the ground and a shadow', () => {
  const segments = [climbSegment(), [
    { lat: 52.0, lon: 0.5, altFt: 2000, timestampMs: START_MS + 900_000 },
    { lat: 52.1, lon: 0.6, altFt: 1000, timestampMs: START_MS + 960_000 },
  ]];
  const { segments: derived } = derivePointMetrics(segments);
  const projection = createSceneProjection({ refLat: 51.5, refLon: -0.3, floorFt: 50, verticalScale: 1 });
  const scale = buildTrackColorScale(derived, 'altitude');
  const geometry = buildTrackGeometry(derived, projection, scale);

  assert.equal(geometry.pointCount, 6);
  assert.equal(geometry.spanCount, 4, 'three spans in the first segment, one in the second, none across the gap');
  assert.equal(geometry.pathPositions.length, 4 * 6);
  assert.equal(geometry.pathColors.length, 4 * 6);
  assert.equal(geometry.shadowPositions.length, 4 * 6);
  assert.equal(geometry.curtainPositions.length, 4 * 18, 'two triangles per span');
  assert.equal(geometry.curtainColors.length, 4 * 18);
  for (let index = 1; index < geometry.shadowPositions.length; index += 3) {
    assert.equal(geometry.shadowPositions[index], 0, 'the shadow lies on the ground plane');
  }
  assert.ok(geometry.bounds.maxY > geometry.bounds.minY);
  assert.ok(Math.abs(geometry.bounds.minY - projection.altitudeToY(80)) < 1e-6);

  const empty = buildTrackGeometry([], projection, scale);
  assert.equal(empty.pointCount, 0);
  assert.equal(empty.bounds, null);
});
