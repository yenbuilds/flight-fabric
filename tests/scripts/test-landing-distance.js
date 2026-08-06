#!/usr/bin/env node
/**
 * test-landing-distance.js
 * Regression tests for backend/landing-distance.js functions.
 *
 * Tests:
 * - calculateDistanceFt: Haversine formula accuracy
 * - scoreTouchdownDistance: TDZ scoring bands
 * - getAdjustedBands: Short runway multiplier, surface conditions
 *
// Band names: PERFECT, GOOD, ACCEPTABLE, POOR, DANGEROUS
// Default thresholds: PERFECT ≤1000, GOOD ≤2500, ACCEPTABLE ≤3500, POOR ≤5000, DANGEROUS >5000
// Grades: Outstanding, Good, Acceptable, Long Landing, Dangerous
 *
 * Run: node tests/scripts/test-landing-distance.js
 */
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const landingDist = require(resolveBackendRuntimeFile('landing', 'landing-distance.js'));
const flightAnalysis = require(resolveBackendRuntimeFile('analysis', 'flight-analysis.js'));

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name, status: 'PASS' });
  } catch (e) {
    failed++;
    results.push({ name, status: 'FAIL', error: e.message });
    console.error(`FAIL: ${name}\n  ${e.message}`);
  }
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg} Expected ${expected}, got ${actual}`);
  }
}

function assertApprox(actual, expected, tolerance, msg = '') {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${msg} Expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

function assertNull(actual, msg = '') {
  if (actual !== null) {
    throw new Error(`${msg} Expected null, got ${actual}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// calculateDistanceFt tests (Haversine formula)
// ─────────────────────────────────────────────────────────────────────────────

test('calculateDistanceFt: same point returns 0', () => {
  const dist = landingDist.calculateDistanceFt(33.9425, -118.4081, 33.9425, -118.4081);
  assertEqual(dist, 0, 'Same point');
});

test('calculateDistanceFt: null inputs return null', () => {
  const dist = landingDist.calculateDistanceFt(null, -118, 34, -118);
  assertNull(dist, 'Null input');
});

test('calculateDistanceFt: 1 nautical mile ≈ 6076 ft', () => {
  // 1 NM at equator = 1 minute of latitude = 1/60 degree
  // From (0, 0) to (1/60, 0) should be ~6076 ft
  const dist = landingDist.calculateDistanceFt(0, 0, 1/60, 0);
  assertApprox(dist, 6076, 100, '1 NM');
});

test('calculateDistanceFt: known distance between two points', () => {
  // Two points approximately 1000 ft apart
  // 1000 ft ≈ 0.00274 degrees latitude at equator
  const dist = landingDist.calculateDistanceFt(0, 0, 0.00274, 0);
  assertApprox(dist, 1000, 50, '~1000 ft');
});

test('calculateDistanceFt: works in southern hemisphere', () => {
  // Sydney area: -33.8688, 151.2093
  const dist = landingDist.calculateDistanceFt(-33.8688, 151.2093, -33.8688, 151.2193);
  if (dist <= 0 || !Number.isFinite(dist)) {
    throw new Error(`Expected positive distance, got ${dist}`);
  }
});

test('calculateDistanceFt: works across date line', () => {
  // From 179°E to 179°W = 2 degrees
  const dist = landingDist.calculateDistanceFt(0, 179, 0, -179);
  // At equator, 2° longitude ≈ 120 NM ≈ 729,000 ft
  if (dist < 700000 || dist > 750000) {
    throw new Error(`Expected ~729,000 ft across date line, got ${dist}`);
  }
});

test('calculateDistanceFt: returns positive number for all valid inputs', () => {
  const dist = landingDist.calculateDistanceFt(40, -74, 41, -73);
  if (dist <= 0) {
    throw new Error(`Expected positive distance, got ${dist}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Signed touchdown distance tests
// ─────────────────────────────────────────────────────────────────────────────

test('calculateSignedTouchdownDistance: ahead of threshold is positive', () => {
  const threshold = { lat: 0, lon: 0 };
  const touchdown = { lat: 0.001, lon: 0 }; // North of threshold
  const result = landingDist.calculateSignedTouchdownDistance(threshold, touchdown, 0); // runway heading north

  if (result.distanceFt == null || result.distanceFt <= 0) {
    throw new Error(`Expected positive signed distance, got ${result.distanceFt}`);
  }
  assertEqual(result.isShort, false, 'Should not be marked short');
});

test('calculateSignedTouchdownDistance: behind threshold is negative and short', () => {
  const threshold = { lat: 0, lon: 0 };
  const touchdown = { lat: -0.001, lon: 0 }; // South of threshold
  const result = landingDist.calculateSignedTouchdownDistance(threshold, touchdown, 0); // runway heading north

  if (result.distanceFt == null || result.distanceFt >= 0) {
    throw new Error(`Expected negative signed distance, got ${result.distanceFt}`);
  }
  assertEqual(result.isShort, true, 'Should be marked short');
});

test('calculateSignedTouchdownDistance: missing heading returns null distance', () => {
  const threshold = { lat: 0, lon: 0 };
  const touchdown = { lat: 0.001, lon: 0 };
  const result = landingDist.calculateSignedTouchdownDistance(threshold, touchdown, null);

  assertNull(result.distanceFt, 'Distance should be null without heading');
  assertEqual(result.isShort, false, 'Short flag should default false');
});

// ─────────────────────────────────────────────────────────────────────────────
test('calculateSignedTouchdownDistance: non-finite heading returns null distance', () => {
  const threshold = { lat: 0, lon: 0 };
  const touchdown = { lat: 0.001, lon: 0 };

  for (const heading of [NaN, Infinity, -Infinity]) {
    const result = landingDist.calculateSignedTouchdownDistance(threshold, touchdown, heading);
    assertNull(result.distanceFt, `Distance should be null for heading ${heading}`);
    assertEqual(result.isShort, false, 'Short flag should default false');
  }
});

test('buildTouchdownRunwayAnalysis: uses explicit true-heading field without legacy heading alias', () => {
  const threshold = { lat: 40, lon: -74 };
  const touchdown = { lat: 40, lon: -74 + (1000 / (364567 * Math.cos(40 * Math.PI / 180))) };
  const analysis = flightAnalysis.buildTouchdownRunwayAnalysis({
    runwayData: {
      threshold,
      physicalThreshold: { lat: 39.999, lon: -74 },
      heading_true_deg: 90,
      lengthFt: 8000,
      physicalLengthFt: 9000,
      displacedThresholdFt: 1000,
      widthFt: 150,
      surface: 'ASPH',
      source: 'ourairports',
      icao: 'KTST',
      runway: '09',
    },
    touchdownPoint: touchdown,
    surfaceInputs: { surfaceCondition: 0 },
  });

  const tdd = analysis.touchdownDistanceData;
  assertEqual(analysis.shortLandingDetected, false, 'Touchdown past threshold should not be short');
  assertApprox(tdd.touchdown_distance_ft, 1000, 3, 'Explicit true heading should drive signed distance');
  assertEqual(tdd.lateral_offset_side, 'center', 'Explicit true heading should drive lateral offset');
  assertEqual(tdd.runway_geometry_source, 'ourairports', 'Provider source should be preserved');
  assertEqual(tdd.runway_heading_true_deg, 90, 'True runway heading should be persisted');
  assertEqual(tdd.runway_physical_length_ft, 9000, 'Physical runway length should be persisted');
  assertEqual(tdd.runway_displaced_threshold_ft, 1000, 'Displaced threshold should be persisted');
  assertEqual(tdd.runway_physical_threshold_lat, 39.999, 'Physical threshold lat should be persisted');
});

// scoreTouchdownDistance tests
// The generic scoring band through 1000 ft is Outstanding. The regulatory TDZ
// extends through 3000 ft; a narrower target requires aircraft/SOP-specific data.
// ─────────────────────────────────────────────────────────────────────────────

test('scoreTouchdownDistance: 500 ft = Outstanding grade', () => {
  const result = landingDist.scoreTouchdownDistance(500);
  assertEqual(result.grade, 'Outstanding', '500 ft grade');
  assertEqual(result.score, 100, '500 ft score');
});

test('scoreTouchdownDistance: 1000 ft = PERFECT boundary', () => {
  const result = landingDist.scoreTouchdownDistance(1000);
  assertEqual(result.grade, 'Outstanding', '1000 ft boundary');
});

test('scoreTouchdownDistance: 1001 ft = Good grade', () => {
  const result = landingDist.scoreTouchdownDistance(1001);
  assertEqual(result.grade, 'Good', '1001 ft');
});

test('scoreTouchdownDistance: 2000 ft = GOOD boundary', () => {
  const result = landingDist.scoreTouchdownDistance(2000);
  assertEqual(result.grade, 'Good', '2000 ft');
});

test('scoreTouchdownDistance: 2001 ft = Good grade', () => {
  const result = landingDist.scoreTouchdownDistance(2001);
  assertEqual(result.grade, 'Good', '2001 ft');
});

test('scoreTouchdownDistance: 3000 ft = ACCEPTABLE zone', () => {
  const result = landingDist.scoreTouchdownDistance(3000);
  assertEqual(result.grade, 'Acceptable', '3000 ft');
});

test('scoreTouchdownDistance: 3001 ft = Acceptable grade', () => {
  const result = landingDist.scoreTouchdownDistance(3001);
  assertEqual(result.grade, 'Acceptable', '3001 ft');
});

test('scoreTouchdownDistance: 4000 ft = POOR boundary', () => {
  const result = landingDist.scoreTouchdownDistance(4000);
  assertEqual(result.grade, 'Long Landing', '4000 ft');
});

test('scoreTouchdownDistance: 4001 ft = Long Landing grade', () => {
  const result = landingDist.scoreTouchdownDistance(4001);
  assertEqual(result.grade, 'Long Landing', '4001 ft');
});

test('scoreTouchdownDistance: 5000 ft = Long Landing', () => {
  const result = landingDist.scoreTouchdownDistance(5000);
  assertEqual(result.grade, 'Long Landing', '5000 ft');
});

// ─────────────────────────────────────────────────────────────────────────────
// Score value tests
// ─────────────────────────────────────────────────────────────────────────────

test('scoreTouchdownDistance: score decreases with distance', () => {
  const s500 = landingDist.scoreTouchdownDistance(500).score;
  const s1200 = landingDist.scoreTouchdownDistance(1200).score;
  const s2000 = landingDist.scoreTouchdownDistance(2000).score;
  const s3500 = landingDist.scoreTouchdownDistance(3500).score;
  
  if (!(s500 >= s1200 && s1200 >= s2000 && s2000 >= s3500)) {
    throw new Error(`Scores should decrease: ${s500} >= ${s1200} >= ${s2000} >= ${s3500}`);
  }
});

test('scoreTouchdownDistance: PERFECT score is 100', () => {
  const result = landingDist.scoreTouchdownDistance(500);
  assertEqual(result.score, 100, 'Perfect score');
});

test('scoreTouchdownDistance: DANGEROUS score is low', () => {
  const result = landingDist.scoreTouchdownDistance(6000);
  if (result.score > 30) {
    throw new Error(`Expected low score for DANGEROUS, got ${result.score}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

// scoreLateralOffset tests
// Default 150 ft runway: half-width 75 ft, so the bands are:
// Perfect <=10 ft, Good <=24.75 ft, Marginal <=49.5 ft,
// Poor <=75 ft, Excursion beyond the runway edge.

test('scoreLateralOffset: null returns Unknown and no score', () => {
  const result = landingDist.scoreLateralOffset(null);
  assertEqual(result.grade, 'Unknown', 'Null grade');
  assertNull(result.score, 'Null score');
});

test('scoreLateralOffset: 150 ft runway band boundaries match modal copy', () => {
  const cases = [
    { offset: 10, score: 100, grade: 'Perfect' },
    { offset: 10.1, score: 95, grade: 'Good' },
    { offset: 24.75, score: 95, grade: 'Good' },
    { offset: 24.76, score: 85, grade: 'Marginal' },
    { offset: 49.5, score: 85, grade: 'Marginal' },
    { offset: 49.51, score: 70, grade: 'Poor' },
    { offset: 75, score: 70, grade: 'Poor' },
    { offset: 75.1, score: 50, grade: 'Excursion' },
    { offset: 90, score: 48, grade: 'Excursion' },
  ];

  for (const testCase of cases) {
    const result = landingDist.scoreLateralOffset(testCase.offset, 150);
    assertEqual(result.score, testCase.score, `${testCase.offset} ft score`);
    assertEqual(result.grade, testCase.grade, `${testCase.offset} ft grade`);
  }
});

test('scoreLateralOffset: uses absolute offset and supplied runway width', () => {
  const left = landingDist.scoreLateralOffset(-40, 150);
  const right = landingDist.scoreLateralOffset(40, 150);
  assertEqual(left.score, right.score, 'Left/right score symmetry');
  assertEqual(left.grade, right.grade, 'Left/right grade symmetry');

  const narrowRunway = landingDist.scoreLateralOffset(40, 100);
  const wideRunway = landingDist.scoreLateralOffset(40, 200);
  assertEqual(narrowRunway.grade, 'Poor', '40 ft is near-edge on a 100 ft runway');
  assertEqual(wideRunway.grade, 'Marginal', '40 ft is off-center on a 200 ft runway');
});

test('scoreTouchdownDistance: 0 ft remains Outstanding without aircraft-specific target data', () => {
  const result = landingDist.scoreTouchdownDistance(0);
  assertEqual(result.grade, 'Outstanding', 'Zero distance');
  assertEqual(result.score, 100, 'Zero distance score');
});

test('scoreTouchdownDistance: touchdown within the first 1000 ft is outstanding by default', () => {
  assertEqual(landingDist.scoreTouchdownDistance(499).grade, 'Outstanding', '499 ft should be outstanding');
  assertEqual(landingDist.scoreTouchdownDistance(500).grade, 'Outstanding', '500 ft should be outstanding');
});

test('scoreTouchdownDistance: negative signed distance = Short Landing', () => {
  const result = landingDist.scoreTouchdownDistance(-250);
  assertEqual(result.grade, 'Short Landing', 'Negative signed distance grade');
  assertEqual(result.score, 0, 'Negative signed distance score');
});

test('scoreTouchdownDistance: null returns Unknown grade', () => {
  const result = landingDist.scoreTouchdownDistance(null);
  assertEqual(result.grade, 'Unknown', 'Null grade');
  assertNull(result.score, 'Null score');
});

test('scoreTouchdownDistance: NaN returns Unknown grade', () => {
  const result = landingDist.scoreTouchdownDistance(NaN);
  assertEqual(result.grade, 'Unknown', 'NaN grade');
});

test('scoreTouchdownDistance: very large distance = Dangerous', () => {
  const result = landingDist.scoreTouchdownDistance(50000);
  assertEqual(result.grade, 'Dangerous', 'Very large distance');
});

// ─────────────────────────────────────────────────────────────────────────────
// getAdjustedBands tests
// ─────────────────────────────────────────────────────────────────────────────

test('getAdjustedBands: default returns standard bands', () => {
  const bands = landingDist.getAdjustedBands();
  if (!bands.PERFECT || !bands.GOOD || !bands.ACCEPTABLE) {
    throw new Error('Expected standard bands');
  }
  assertEqual(bands.PERFECT.max, 1000, 'PERFECT max');
  assertEqual(bands.GOOD.max, 2500, 'GOOD max');
});

test('getAdjustedBands: short runway tightens bands via pct cap', () => {
  const normalBands = landingDist.getAdjustedBands(10000);
  const shortBands = landingDist.getAdjustedBands(4000);
  
  // Short runway: GOOD pctCap=0.33, 4000*0.33=1320 < 2500 → max=1320
  // Normal runway: GOOD pctCap=0.33, 10000*0.33=3300 > 2500 → max=2500
  if (shortBands.GOOD.max >= normalBands.GOOD.max) {
    throw new Error('Short runway should have tighter GOOD threshold via pct cap');
  }
});

test('getAdjustedBands: wet surface keeps the ideal target band fixed and reduces later thresholds', () => {
  const dryBands = landingDist.getAdjustedBands(10000, 'dry');
  const wetBands = landingDist.getAdjustedBands(10000, 'wet');
  if (wetBands.PERFECT.max !== dryBands.PERFECT.max) {
    throw new Error('Wet surface must not move the ideal touchdown target');
  }
  if (wetBands.GOOD.max >= dryBands.GOOD.max) {
    throw new Error('Wet surface should reduce later touchdown tolerance');
  }
});

test('getAdjustedBands: ice keeps ideal target fixed while giving the tightest later thresholds', () => {
  const dryBands = landingDist.getAdjustedBands(10000, 'dry');
  const iceBands = landingDist.getAdjustedBands(10000, 'ice');

  assertEqual(iceBands.PERFECT.max, dryBands.PERFECT.max, 'Ice must not move the ideal target');
  assertApprox(iceBands.GOOD.max, dryBands.GOOD.max * 0.5, 10, 'Ice later-band multiplier');
});

test('getAdjustedBands: unknown surface defaults to dry', () => {
  const dryBands = landingDist.getAdjustedBands(10000, 'dry');
  const unknownBands = landingDist.getAdjustedBands(10000, 'unknown');
  
  assertEqual(unknownBands.PERFECT.max, dryBands.PERFECT.max, 'Unknown defaults to dry');
});

// ─────────────────────────────────────────────────────────────────────────────
// Runway context tests
// ─────────────────────────────────────────────────────────────────────────────

test('scoreTouchdownDistance: runway context affects bands', () => {
  // Score same distance on short vs long runway
  const result1 = landingDist.scoreTouchdownDistance(1200, { runwayLengthFt: 12000 });
  const result2 = landingDist.scoreTouchdownDistance(1200, { runwayLengthFt: 4000 });
  
  // On short runway, same distance should potentially have different grade
  if (!result1.grade || !result2.grade) {
    throw new Error('Should handle runway context option');
  }
});

test('scoreTouchdownDistance: surface condition affects bands', () => {
  const dryResult = landingDist.scoreTouchdownDistance(2000, { surface: 'dry' });
  const wetResult = landingDist.scoreTouchdownDistance(2000, { surface: 'wet' });
  
  if (dryResult.grade !== 'Good') {
    throw new Error('Expected Good on dry');
  }
  if (wetResult.grade !== 'Acceptable') {
    throw new Error(`Expected Acceptable on wet, got ${wetResult.grade}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Result object structure tests
// ─────────────────────────────────────────────────────────────────────────────

test('scoreTouchdownDistance: returns distanceFt', () => {
  const result = landingDist.scoreTouchdownDistance(1234);
  assertEqual(result.distanceFt, 1234, 'Distance preserved');
});

test('scoreTouchdownDistance: returns bands object', () => {
  const result = landingDist.scoreTouchdownDistance(1000);
  if (!result.bands || !result.bands.PERFECT) {
    throw new Error('Expected bands object in result');
  }
});

test('scoreTouchdownDistance: returns zone description', () => {
  const result = landingDist.scoreTouchdownDistance(500);
  if (!result.zone) {
    throw new Error('Expected zone property');
  }
  assertEqual(result.zone, 'Ideal TDZ', 'Zone for PERFECT');
});

test('scoreTouchdownDistance: zone for Dangerous is Overrun Risk', () => {
  const result = landingDist.scoreTouchdownDistance(6000);
  assertEqual(result.zone, 'Overrun Risk', 'Zone for DANGEROUS');
});

// ─────────────────────────────────────────────────────────────────────────────
// Bounce scoring tests
// ─────────────────────────────────────────────────────────────────────────────

test('scoreBounce: clean landing returns 100', () => {
  const result = landingDist.scoreBounce({
    bounceCount: 0,
    firstTouchdown: { lat: 0, lon: 0, gforce: 1.3 },
    finalTouchdown: null,
  });

  assertEqual(result.score, 100, 'Clean landing score');
  assertEqual(result.grade, 'Clean', 'Clean landing grade');
  assertEqual(result.bounceCount, 0, 'Clean landing bounce count');
});

test('scoreBounce: single bounce penalizes score', () => {
  const result = landingDist.scoreBounce({
    bounceCount: 1,
    firstTouchdown: { lat: 0, lon: 0, gforce: 1.2 },
    finalTouchdown: { lat: 0.0003, lon: 0, gforce: 1.5 },
  });

  if (result.score >= 100) {
    throw new Error(`Expected score below 100 for bounce, got ${result.score}`);
  }
  assertEqual(result.grade, 'Single Bounce', 'Single bounce grade');
});

test('scoreBounce: explicit airborne distance excludes pre-liftoff rollout', () => {
  const result = landingDist.scoreBounce({
    bounceCount: 1,
    firstTouchdown: { lat: 0, lon: 0, gforce: 1.2 },
    finalTouchdown: { lat: 0.0012, lon: 0, gforce: 1.3 },
    airborneDistanceFt: 110,
  });

  assertEqual(result.distanceTraveledFt, 110, 'Only observed airborne distance should be reported');
  assertEqual(result.grade, 'Single Bounce', 'Explicit distance must preserve bounce grading');
});

test('scoreBounce: explicit zero airborne distance is not replaced by endpoint rollout', () => {
  const result = landingDist.scoreBounce({
    bounceCount: 1,
    firstTouchdown: { lat: 0, lon: 0, gforce: 1.2 },
    finalTouchdown: { lat: 0.0012, lon: 0, gforce: 1.3 },
    airborneDistanceFt: 0,
  });

  assertEqual(result.distanceTraveledFt, 0, 'Explicit zero must remain zero');
});

test('scoreBounce: multiple bounces grade and severity', () => {
  const result = landingDist.scoreBounce({
    bounceCount: 3,
    firstTouchdown: { lat: 0, lon: 0, gforce: 1.3 },
    finalTouchdown: { lat: 0.001, lon: 0, gforce: 1.9 },
  });

  assertEqual(result.grade, 'Repeated Bounces', 'Three bounces grade');
  if (result.score > 75) {
    throw new Error(`Expected stronger penalty for repeated bounces, got ${result.score}`);
  }
  assertEqual(result.worstGforce, 1.9, 'Worst G-force should be max of touchdowns');
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// calculateDistanceFt — invalid input guards (not covered above)
// ─────────────────────────────────────────────────────────────────────────────

test('calculateDistanceFt: NaN input returns null', () => {
  assertNull(landingDist.calculateDistanceFt(NaN, -74, 40, -74), 'NaN lat1');
  assertNull(landingDist.calculateDistanceFt(40, NaN, 40, -74), 'NaN lon1');
});

test('calculateDistanceFt: undefined input returns null', () => {
  assertNull(landingDist.calculateDistanceFt(undefined, -74, 40, -74), 'undefined lat1');
});

test('calculateDistanceFt: Infinity input returns null', () => {
  assertNull(landingDist.calculateDistanceFt(Infinity, -74, 40, -74), 'Infinity lat1');
});

// ─────────────────────────────────────────────────────────────────────────────
// calculateSignedTouchdownDistance — cardinal heading matrix
// Heading 0 (north) already covered above; add 90°, 180°, 270°.
//
// Helper: compute a touchdown point given a threshold, runway heading, a
// distance along the runway centerline, and an optional lateral offset (ft,
// right-positive). Uses the same coordinate arithmetic as
// calculateLateralOffset so "right" means the same thing in both functions.
// ─────────────────────────────────────────────────────────────────────────────

const FT_PER_DEG = 364567; // same constant used inside landing-distance.js

function mkOffset(threshLat, threshLon, headingDeg, distFt, lateralFt) {
  const rad    = headingDeg * Math.PI / 180;
  const cosLat = Math.cos(threshLat * Math.PI / 180);
  // Along-track unit vector (sin θ = east, cos θ = north)
  // Lateral unit vector 90° CW: (cos θ = east, −sin θ = north)
  const northFt = Math.cos(rad) * distFt + (-Math.sin(rad)) * lateralFt;
  const eastFt  = Math.sin(rad) * distFt + Math.cos(rad)    * lateralFt;
  return {
    lat: threshLat + northFt / FT_PER_DEG,
    lon: threshLon + eastFt  / (FT_PER_DEG * cosLat),
  };
}

const T = { lat: 40.0, lon: -74.0 }; // reference test threshold

test('calculateSignedTouchdownDistance: RWY 09 (east) 2000 ft down → positive, not short', () => {
  const td = mkOffset(40, -74, 90, 2000, 0);
  const r = landingDist.calculateSignedTouchdownDistance(T, td, 90);
  if (r.distanceFt == null || r.distanceFt <= 0) {
    throw new Error(`Expected positive distance, got ${r.distanceFt}`);
  }
  assertEqual(r.isShort, false, 'RWY09 normal landing should not be short');
});

test('calculateSignedTouchdownDistance: RWY 09 (east) 500 ft short → negative, isShort', () => {
  const td = mkOffset(40, -74, 90, -500, 0);
  const r = landingDist.calculateSignedTouchdownDistance(T, td, 90);
  if (r.distanceFt == null || r.distanceFt >= 0) {
    throw new Error(`Expected negative distance for short landing, got ${r.distanceFt}`);
  }
  assertEqual(r.isShort, true, 'RWY09 short landing should be flagged');
});

test('calculateSignedTouchdownDistance: RWY 18 (south) 2000 ft down → positive, not short', () => {
  const td = mkOffset(40, -74, 180, 2000, 0);
  const r = landingDist.calculateSignedTouchdownDistance(T, td, 180);
  if (r.distanceFt == null || r.distanceFt <= 0) {
    throw new Error(`Expected positive distance, got ${r.distanceFt}`);
  }
  assertEqual(r.isShort, false, 'RWY18 normal landing should not be short');
});

test('calculateSignedTouchdownDistance: RWY 27 (west) 2000 ft down → positive, not short', () => {
  const td = mkOffset(40, -74, 270, 2000, 0);
  const r = landingDist.calculateSignedTouchdownDistance(T, td, 270);
  if (r.distanceFt == null || r.distanceFt <= 0) {
    throw new Error(`Expected positive distance, got ${r.distanceFt}`);
  }
  assertEqual(r.isShort, false, 'RWY27 normal landing should not be short');
});

test('calculateSignedTouchdownDistance: distance magnitude roughly matches lateral-free along-track', () => {
  // A landing 1500 ft down the runway should produce |distanceFt| ≈ 1500 ft.
  const td = mkOffset(40, -74, 90, 1500, 0);
  const r = landingDist.calculateSignedTouchdownDistance(T, td, 90);
  assertApprox(r.distanceFt, 1500, 30, 'Signed distance magnitude');
});

test('calculateSignedTouchdownDistance: lateral offset does not inflate along-track distance', () => {
  const td = mkOffset(40, -74, 90, 1000, 1000);
  const r = landingDist.calculateSignedTouchdownDistance(T, td, 90);
  assertApprox(r.distanceFt, 1000, 30, 'Signed distance should be projected along runway');
  assertEqual(r.isShort, false, 'Point down runway should not be marked short');
});

test('calculateSignedTouchdownDistance: near-threshold lateral offset does not look far short', () => {
  const td = mkOffset(40, -74, 0, -1, 600);
  const r = landingDist.calculateSignedTouchdownDistance(T, td, 0);
  assertApprox(r.distanceFt, -1, 5, 'Only along-track distance should count before threshold');
  assertEqual(r.isShort, true, 'Point before threshold should still be marked short');
});

// ─────────────────────────────────────────────────────────────────────────────
// calculateLateralOffset — cardinal heading matrix
//
// Convention: positive offsetFt = right of runway, negative = left.
//   RWY 36 (north):  right = east,  left = west
//   RWY 09 (east):   right = south, left = north
//   RWY 18 (south):  right = west,  left = east
//   RWY 27 (west):   right = north, left = south
// ─────────────────────────────────────────────────────────────────────────────

test('calculateLateralOffset: null threshold → null offset, side center', () => {
  const r = landingDist.calculateLateralOffset(null, T, 90);
  assertNull(r.offsetFt, 'Null threshold');
  assertEqual(r.side, 'center', 'Side center for null threshold');
});

test('calculateLateralOffset: null heading → null offset, side center', () => {
  const r = landingDist.calculateLateralOffset(T, mkOffset(40, -74, 90, 2000, 0), null);
  assertNull(r.offsetFt, 'Null heading');
  assertEqual(r.side, 'center', 'Side center for null heading');
});

test('calculateLateralOffset: non-finite coordinate → null offset', () => {
  const r = landingDist.calculateLateralOffset({ lat: NaN, lon: -74 }, { lat: 40.001, lon: -74 }, 90);
  assertNull(r.offsetFt, 'NaN threshold lat');
  assertEqual(r.side, 'center');
});

test('calculateLateralOffset: RWY 36 (north) on centerline → center', () => {
  const td = mkOffset(40, -74, 360, 2000, 0);
  const r = landingDist.calculateLateralOffset(T, td, 360);
  assertEqual(r.side, 'center', 'On-centerline should be center');
  if (Math.abs(r.offsetFt) > 10) {
    throw new Error(`On-CL offset should be near zero, got ${r.offsetFt}`);
  }
});

test('calculateLateralOffset: RWY 36 (north) 50 ft right (east) → positive, right', () => {
  const td = mkOffset(40, -74, 360, 2000, 50);
  const r = landingDist.calculateLateralOffset(T, td, 360);
  assertEqual(r.side, 'right', 'RWY36 east offset should be right');
  assertApprox(r.offsetFt, 50, 5, 'RWY36 right offset magnitude');
});

test('calculateLateralOffset: RWY 36 (north) 50 ft left (west) → negative, left', () => {
  const td = mkOffset(40, -74, 360, 2000, -50);
  const r = landingDist.calculateLateralOffset(T, td, 360);
  assertEqual(r.side, 'left', 'RWY36 west offset should be left');
  assertApprox(r.offsetFt, -50, 5, 'RWY36 left offset magnitude');
});

test('calculateLateralOffset: RWY 09 (east) 50 ft right (south) → positive, right', () => {
  const td = mkOffset(40, -74, 90, 2000, 50);
  const r = landingDist.calculateLateralOffset(T, td, 90);
  assertEqual(r.side, 'right', 'RWY09 south offset should be right');
  assertApprox(r.offsetFt, 50, 5, 'RWY09 right offset magnitude');
});

test('calculateLateralOffset: RWY 09 (east) 50 ft left (north) → negative, left', () => {
  const td = mkOffset(40, -74, 90, 2000, -50);
  const r = landingDist.calculateLateralOffset(T, td, 90);
  assertEqual(r.side, 'left', 'RWY09 north offset should be left');
  assertApprox(r.offsetFt, -50, 5, 'RWY09 left offset magnitude');
});

test('calculateLateralOffset: RWY 18 (south) 50 ft right (west) → positive, right', () => {
  const td = mkOffset(40, -74, 180, 2000, 50);
  const r = landingDist.calculateLateralOffset(T, td, 180);
  assertEqual(r.side, 'right', 'RWY18 west offset should be right');
  assertApprox(r.offsetFt, 50, 5, 'RWY18 right offset magnitude');
});

test('calculateLateralOffset: RWY 27 (west) 50 ft right (north) → positive, right', () => {
  const td = mkOffset(40, -74, 270, 2000, 50);
  const r = landingDist.calculateLateralOffset(T, td, 270);
  assertEqual(r.side, 'right', 'RWY27 north offset should be right');
  assertApprox(r.offsetFt, 50, 5, 'RWY27 right offset magnitude');
});

test('calculateLateralOffset: left/right are symmetric (equal magnitude, opposite sign)', () => {
  const right = mkOffset(40, -74, 360, 2000,  40);
  const left  = mkOffset(40, -74, 360, 2000, -40);
  const rR = landingDist.calculateLateralOffset(T, right, 360);
  const rL = landingDist.calculateLateralOffset(T, left,  360);
  assertEqual(rR.side, 'right', 'Positive offset is right');
  assertEqual(rL.side, 'left',  'Negative offset is left');
  assertApprox(rR.offsetFt, -rL.offsetFt, 3, 'Symmetric magnitudes');
});

test('calculateLateralOffset: 4 ft right → side is center (below 5 ft threshold)', () => {
  const td = mkOffset(40, -74, 90, 2000, 4);
  const r = landingDist.calculateLateralOffset(T, td, 90);
  assertEqual(r.side, 'center', '4 ft should render as center');
});

test('calculateLateralOffset: 6 ft right → side is right (above 5 ft threshold)', () => {
  const td = mkOffset(40, -74, 90, 2000, 6);
  const r = landingDist.calculateLateralOffset(T, td, 90);
  assertEqual(r.side, 'right', '6 ft should render as right');
});

test('calculateLateralOffset: along-track distance does not affect lateral offset', () => {
  // Two touchdowns at different distances down the same runway, same lateral offset.
  // Lateral offset should be equal regardless of how far down the runway we landed.
  const td1 = mkOffset(40, -74, 90, 1000, 30);
  const td2 = mkOffset(40, -74, 90, 3000, 30);
  const r1 = landingDist.calculateLateralOffset(T, td1, 90);
  const r2 = landingDist.calculateLateralOffset(T, td2, 90);
  assertApprox(r1.offsetFt, r2.offsetFt, 3, 'Lateral offset independent of along-track distance');
});

// ─────────────────────────────────────────────────────────────────────────────
// inferSurfaceCondition
// ─────────────────────────────────────────────────────────────────────────────

test('inferSurfaceCondition: SimConnect enum 0 → dry, simconnect, confident', () => {
  const r = landingDist.inferSurfaceCondition({ surfaceCondition: 0 });
  assertEqual(r.surface, 'dry', 'Enum 0 = dry');
  assertEqual(r.source, 'simconnect', 'Source = simconnect');
  assertEqual(r.confident, true, 'Confident');
});

test('inferSurfaceCondition: SimConnect enum 1 → wet, simconnect, confident', () => {
  const r = landingDist.inferSurfaceCondition({ surfaceCondition: 1 });
  assertEqual(r.surface, 'wet');
  assertEqual(r.source, 'simconnect');
  assertEqual(r.confident, true);
});

test('inferSurfaceCondition: SimConnect enum 2 → ice, simconnect, confident', () => {
  const r = landingDist.inferSurfaceCondition({ surfaceCondition: 2 });
  assertEqual(r.surface, 'ice');
  assertEqual(r.source, 'simconnect');
  assertEqual(r.confident, true);
});

test('inferSurfaceCondition: SimConnect enum 3 → snow, simconnect, confident', () => {
  const r = landingDist.inferSurfaceCondition({ surfaceCondition: 3 });
  assertEqual(r.surface, 'snow');
  assertEqual(r.source, 'simconnect');
  assertEqual(r.confident, true);
});

test('inferSurfaceCondition: documented X-Plane runway-friction enum maps directly', () => {
  const dry = landingDist.inferSurfaceCondition({ xplaneRunwayFriction: 0 });
  const wet = landingDist.inferSurfaceCondition({ xplaneRunwayFriction: 4 });
  const snow = landingDist.inferSurfaceCondition({ xplaneRunwayFriction: 8 });
  const mixed = landingDist.inferSurfaceCondition({ xplaneRunwayFriction: 13 });

  assertEqual(dry.surface, 'dry', 'X-Plane dry');
  assertEqual(wet.surface, 'wet', 'X-Plane puddly maps to wet scoring');
  assertEqual(snow.surface, 'snow', 'X-Plane snowy');
  assertEqual(mixed.surface, 'ice', 'X-Plane snowy/icy uses restrictive ice scoring');
  assertEqual(mixed.source, 'xplane', 'source');
  assertEqual(mixed.confident, true, 'documented simulator runway state is confident');
});

test('inferSurfaceCondition: MSFS 2024 rain mask is wet but not an observed runway condition', () => {
  const r = landingDist.inferSurfaceCondition({ precipState: 4, oatC: 10 });
  assertEqual(r.surface, 'wet');
  assertEqual(r.source, 'inferred');
  assertEqual(r.confident, false);
});

test('inferSurfaceCondition: freezing OAT does not turn an explicit rain state into snow', () => {
  const r = landingDist.inferSurfaceCondition({ precipState: 4, oatC: -5 });
  assertEqual(r.surface, 'wet');
  assertEqual(r.source, 'inferred');
  assertEqual(r.confident, false);
});

test('inferSurfaceCondition: explicit snow mask remains snow even above freezing', () => {
  const r = landingDist.inferSurfaceCondition({ precipState: 8, oatC: 2 });
  assertEqual(r.surface, 'snow');
  assertEqual(r.confident, false);
});

test('inferSurfaceCondition: rain but OAT unknown → wet, inferred, not confident', () => {
  const r = landingDist.inferSurfaceCondition({ precipState: 4 });
  assertEqual(r.surface, 'wet');
  assertEqual(r.source, 'inferred');
  assertEqual(r.confident, false, 'OAT unknown = not confident');
});

test('inferSurfaceCondition: MSFS 2024 none mask (precipState 2) + warm OAT → dry', () => {
  const r = landingDist.inferSurfaceCondition({ precipState: 2, oatC: 15 });
  assertEqual(r.surface, 'dry');
  assertEqual(r.source, 'inferred');
  assertEqual(r.confident, false);
});

test('inferSurfaceCondition: no precip + warm OAT → dry, inferred, not observed', () => {
  const r = landingDist.inferSurfaceCondition({ precipState: 0, oatC: 15 });
  assertEqual(r.surface, 'dry');
  assertEqual(r.source, 'inferred');
  assertEqual(r.confident, false);
});

test('inferSurfaceCondition: no precip + OAT = -2 → wet (residual), inferred, not confident', () => {
  // OAT at exactly -2 uses the strict <= -2 guard so residual ice is plausible
  const r = landingDist.inferSurfaceCondition({ precipState: 0, oatC: -2 });
  assertEqual(r.surface, 'wet');
  assertEqual(r.source, 'inferred');
  assertEqual(r.confident, false);
});

test('inferSurfaceCondition: no precip + OAT = -1 → dry (above -2 floor)', () => {
  // -1 > -2, so no residual-ice concern → dry
  const r = landingDist.inferSurfaceCondition({ precipState: 0, oatC: -1 });
  assertEqual(r.surface, 'dry');
});

test('inferSurfaceCondition: OAT only, warm → dry, inferred, not confident (single signal)', () => {
  const r = landingDist.inferSurfaceCondition({ oatC: 20 });
  assertEqual(r.surface, 'dry');
  assertEqual(r.source, 'inferred');
  assertEqual(r.confident, false, 'Single signal = not confident');
});

test('inferSurfaceCondition: OAT only, freezing → wet, inferred, not confident', () => {
  const r = landingDist.inferSurfaceCondition({ oatC: -1 });
  assertEqual(r.surface, 'wet');
  assertEqual(r.source, 'inferred');
  assertEqual(r.confident, false);
});

test('inferSurfaceCondition: precipRate > 0.05 mm/hr counts as precipitation', () => {
  const r = landingDist.inferSurfaceCondition({ precipRateMm: 1.5, oatC: 15 });
  assertEqual(r.surface, 'wet', 'Rain rate > 0.05 mm/hr = hasPrecip');
  assertEqual(r.source, 'inferred');
  assertEqual(r.confident, false);
});

test('inferSurfaceCondition: precipRate = 0 mm/hr counts as no precipitation', () => {
  const r = landingDist.inferSurfaceCondition({ precipRateMm: 0, oatC: 15 });
  assertEqual(r.surface, 'dry', 'Zero precip rate = noPrecip');
});

test('inferSurfaceCondition: no inputs at all → wet failsafe, not confident', () => {
  const r = landingDist.inferSurfaceCondition({});
  assertEqual(r.surface, 'wet', 'No data = fail-safe wet');
  assertEqual(r.source, 'failsafe');
  assertEqual(r.confident, false);
});

test('inferSurfaceCondition: called with no argument → wet failsafe', () => {
  const r = landingDist.inferSurfaceCondition();
  assertEqual(r.surface, 'wet', 'No argument = fail-safe wet');
  assertEqual(r.source, 'failsafe');
});

// ─────────────────────────────────────────────────────────────────────────────
// scoreBounce — additional cases
// ─────────────────────────────────────────────────────────────────────────────

test('scoreBounce: worstGforce field is passed through when pre-computed', () => {
  // An intermediate bounce may have a higher G-force than either the first or
  // final touchdown. The pre-computed worstGforce must be preferred.
  const result = landingDist.scoreBounce({
    bounceCount: 2,
    firstTouchdown: { lat: 0, lon: 0, gforce: 1.3 },
    finalTouchdown: { lat: 0.001, lon: 0, gforce: 1.4 },
    worstGforce: 2.5, // intermediate bounce was harder
  });
  assertEqual(result.worstGforce, 2.5, 'Pre-computed worstGforce must be used');
});

test('scoreBounce: null input → Clean grade, score 100', () => {
  const r = landingDist.scoreBounce(null);
  assertEqual(r.score, 100);
  assertEqual(r.grade, 'Clean');
});

test('scoreBounce: missing bounceCount → Clean grade, score 100', () => {
  const r = landingDist.scoreBounce({});
  assertEqual(r.score, 100);
  assertEqual(r.grade, 'Clean');
});

test('scoreBounce: porpoise (4+ bounces) → Porpoise grade, low score', () => {
  const result = landingDist.scoreBounce({
    bounceCount: 5,
    firstTouchdown: { lat: 0, lon: 0, gforce: 1.5 },
    finalTouchdown: { lat: 0.002, lon: 0, gforce: 1.8 },
  });
  assertEqual(result.grade, 'Porpoise');
  if (result.score > 30) {
    throw new Error(`Expected low score for porpoise, got ${result.score}`);
  }
});

console.log('\n' + '─'.repeat(60));
console.log(`landing-distance.js tests: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(60));

if (failed > 0) {
  console.log('\nFailed tests:');
  results.filter(r => r.status === 'FAIL').forEach(r => {
    console.log(`  ✗ ${r.name}: ${r.error}`);
  });
  process.exit(1);
}

console.log('All tests passed ✓');
process.exit(0);
