#!/usr/bin/env node
/**
 * test-landing.js
 * Regression tests for backend/landing.js functions.
 *
 * Tests:
 * - gradeLanding: VS-based landing grade (now profile-driven)
 *
 * NOTE: gradeLanding() now reads thresholds from the active aircraft profile.
 *       This test file validates both generic fallback and profile-specific behavior.
 *       Grades: PERFECT, GOOD, FIRM, HARD, VERY HARD
 *       Colors: lime, deepskyblue, gold, orange, red
 *
 * Tests derive thresholds from profileLoader.getLandingGrades()
 * rather than hardcoding values. If profile thresholds change, tests adapt.
 *
 * Run: node tests/scripts/test-landing.js
 */
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const landing = require(resolveBackendRuntimeFile('landing', 'landing.js'));
const profileLoader = require(resolveBackendRuntimeFile('aircraft', 'aircraft-profile-loader.js'));

// Fallback grades (must match landing.js FALLBACK_GRADES)
const FALLBACK_GRADES = {
  perfectMinFpm: -250,
  goodMinFpm: -450,
  firmMinFpm: -700,
  hardMinFpm: -1000,
};

/**
 * Get effective grades for current profile (profile-specific or fallback)
 */
function getEffectiveGrades() {
  return profileLoader.getLandingGrades() || FALLBACK_GRADES;
}

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

function assertApprox(actual, expected, tolerance = 0.01, msg = '') {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${msg} Expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

function assertOneOf(actual, allowed, msg = '') {
  if (!allowed.includes(actual)) {
    throw new Error(`${msg} Expected one of [${allowed.join(', ')}], got ${actual}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// gradeLanding tests - GENERIC PROFILE
// NOTE: Generic is intentionally lenient since we don't know aircraft type
// Tests derive thresholds from getEffectiveGrades() for antifragility
// ─────────────────────────────────────────────────────────────────────────────

// Ensure we're using generic profile for baseline tests
profileLoader.clearCache();
profileLoader.setActiveProfile('generic');

test('gradeLanding GENERIC: -50 fpm = PERFECT (lime)', () => {
  const result = landing.gradeLanding(-50);
  assertEqual(result.grade, 'PERFECT', 'Grade');
  assertEqual(result.color, 'lime', 'Color');
});

test('gradeLanding GENERIC: just above PERFECT threshold = PERFECT', () => {
  const grades = getEffectiveGrades();
  const result = landing.gradeLanding(grades.perfectMinFpm + 1);
  assertEqual(result.grade, 'PERFECT', 'Boundary');
});

test('gradeLanding GENERIC: at PERFECT threshold = GOOD', () => {
  const grades = getEffectiveGrades();
  const result = landing.gradeLanding(grades.perfectMinFpm);
  assertEqual(result.grade, 'GOOD', 'Just past PERFECT');
});

test('gradeLanding GENERIC: mid-GOOD range', () => {
  const grades = getEffectiveGrades();
  const midGood = (grades.perfectMinFpm + grades.goodMinFpm) / 2;
  const result = landing.gradeLanding(midGood);
  assertEqual(result.grade, 'GOOD', 'GOOD range');
  assertEqual(result.color, 'deepskyblue', 'Color');
});

test('gradeLanding GENERIC: just above GOOD threshold = GOOD', () => {
  const grades = getEffectiveGrades();
  const result = landing.gradeLanding(grades.goodMinFpm + 1);
  assertEqual(result.grade, 'GOOD', 'GOOD boundary');
});

test('gradeLanding GENERIC: at GOOD threshold = FIRM', () => {
  const grades = getEffectiveGrades();
  const result = landing.gradeLanding(grades.goodMinFpm);
  assertEqual(result.grade, 'FIRM', 'Just past GOOD');
});

test('gradeLanding GENERIC: mid-FIRM range', () => {
  const grades = getEffectiveGrades();
  const midFirm = (grades.goodMinFpm + grades.firmMinFpm) / 2;
  const result = landing.gradeLanding(midFirm);
  assertEqual(result.grade, 'FIRM', 'FIRM range');
  assertEqual(result.color, 'gold', 'Color');
});

test('gradeLanding GENERIC: just above FIRM threshold = FIRM', () => {
  const grades = getEffectiveGrades();
  const result = landing.gradeLanding(grades.firmMinFpm + 1);
  assertEqual(result.grade, 'FIRM', 'FIRM boundary');
});

test('gradeLanding GENERIC: at FIRM threshold = HARD', () => {
  const grades = getEffectiveGrades();
  const result = landing.gradeLanding(grades.firmMinFpm);
  assertEqual(result.grade, 'HARD', 'Just past FIRM');
});

test('gradeLanding GENERIC: mid-HARD range', () => {
  const grades = getEffectiveGrades();
  const midHard = (grades.firmMinFpm + grades.hardMinFpm) / 2;
  const result = landing.gradeLanding(midHard);
  assertEqual(result.grade, 'HARD', 'HARD range');
  assertEqual(result.color, 'orange', 'Color');
});

test('gradeLanding GENERIC: just above HARD threshold = HARD', () => {
  const grades = getEffectiveGrades();
  const result = landing.gradeLanding(grades.hardMinFpm + 1);
  assertEqual(result.grade, 'HARD', 'HARD boundary');
});

test('gradeLanding GENERIC: at HARD threshold = VERY HARD', () => {
  const grades = getEffectiveGrades();
  const result = landing.gradeLanding(grades.hardMinFpm);
  assertEqual(result.grade, 'VERY HARD', 'VERY HARD');
  assertEqual(result.color, 'red', 'Color');
});

test('gradeLanding GENERIC: well past HARD threshold = VERY HARD', () => {
  const grades = getEffectiveGrades();
  const result = landing.gradeLanding(grades.hardMinFpm - 200);
  assertEqual(result.grade, 'VERY HARD', 'VERY HARD extreme');
});

// ─────────────────────────────────────────────────────────────────────────────
// gradeLanding tests - iFly 737 MAX PROFILE (firmer jet thresholds)
// NOTE: Heavy jets land firmer - airline standard
// Tests derive thresholds from getEffectiveGrades() for antifragility
// ─────────────────────────────────────────────────────────────────────────────

// Switch to the iFly 737 MAX profile.
profileLoader.clearCache();
profileLoader.setActiveProfile('ifly-737-max-8');

test('gradeLanding 737 MAX: -50 fpm = PERFECT (lime)', () => {
  const result = landing.gradeLanding(-50);
  assertEqual(result.grade, 'PERFECT', 'Grade');
  assertEqual(result.color, 'lime', 'Color');
});

test('gradeLanding 737 MAX: just above PERFECT threshold = PERFECT', () => {
  const grades = getEffectiveGrades();
  const result = landing.gradeLanding(grades.perfectMinFpm + 1);
  assertEqual(result.grade, 'PERFECT', 'Boundary');
});

test('gradeLanding 737 MAX: at PERFECT threshold = GOOD', () => {
  const grades = getEffectiveGrades();
  const result = landing.gradeLanding(grades.perfectMinFpm);
  assertEqual(result.grade, 'GOOD', 'Just past PERFECT');
});

test('gradeLanding 737 MAX: mid-GOOD range', () => {
  const grades = getEffectiveGrades();
  const midGood = (grades.perfectMinFpm + grades.goodMinFpm) / 2;
  const result = landing.gradeLanding(midGood);
  assertEqual(result.grade, 'GOOD', 'GOOD range');
  assertEqual(result.color, 'deepskyblue', 'Color');
});

test('gradeLanding 737 MAX: just above GOOD threshold = GOOD', () => {
  const grades = getEffectiveGrades();
  const result = landing.gradeLanding(grades.goodMinFpm + 1);
  assertEqual(result.grade, 'GOOD', 'GOOD boundary');
});

test('gradeLanding 737 MAX: at GOOD threshold = FIRM', () => {
  const grades = getEffectiveGrades();
  const result = landing.gradeLanding(grades.goodMinFpm);
  assertEqual(result.grade, 'FIRM', 'Just past GOOD');
});

test('gradeLanding 737 MAX: mid-FIRM range', () => {
  const grades = getEffectiveGrades();
  const midFirm = (grades.goodMinFpm + grades.firmMinFpm) / 2;
  const result = landing.gradeLanding(midFirm);
  assertEqual(result.grade, 'FIRM', 'FIRM range');
  assertEqual(result.color, 'gold', 'Color');
});

test('gradeLanding 737 MAX: just above FIRM threshold = FIRM', () => {
  const grades = getEffectiveGrades();
  const result = landing.gradeLanding(grades.firmMinFpm + 1);
  assertEqual(result.grade, 'FIRM', 'FIRM boundary');
});

test('gradeLanding 737 MAX: at FIRM threshold = HARD', () => {
  const grades = getEffectiveGrades();
  const result = landing.gradeLanding(grades.firmMinFpm);
  assertEqual(result.grade, 'HARD', 'Just past FIRM');
});

test('gradeLanding 737 MAX: mid-HARD range', () => {
  const grades = getEffectiveGrades();
  const midHard = (grades.firmMinFpm + grades.hardMinFpm) / 2;
  const result = landing.gradeLanding(midHard);
  assertEqual(result.grade, 'HARD', 'HARD range');
  assertEqual(result.color, 'orange', 'Color');
});

test('gradeLanding 737 MAX: just above HARD threshold = HARD', () => {
  const grades = getEffectiveGrades();
  const result = landing.gradeLanding(grades.hardMinFpm + 1);
  assertEqual(result.grade, 'HARD', 'HARD boundary');
});

test('gradeLanding 737 MAX: at HARD threshold = VERY HARD', () => {
  const grades = getEffectiveGrades();
  const result = landing.gradeLanding(grades.hardMinFpm);
  assertEqual(result.grade, 'VERY HARD', 'VERY HARD');
  assertEqual(result.color, 'red', 'Color');
});

test('gradeLanding 737 MAX: well past HARD threshold = VERY HARD', () => {
  const grades = getEffectiveGrades();
  const result = landing.gradeLanding(grades.hardMinFpm - 200);
  assertEqual(result.grade, 'VERY HARD', 'VERY HARD extreme');
});

// Reset to generic for edge case tests
profileLoader.clearCache();
profileLoader.setActiveProfile('generic');

test('gradeLandingForProfile uses the recorded profile without changing the active aircraft', () => {
  const activeProfileId = profileLoader.getActiveProfileId();
  assertEqual(landing.gradeLanding(-180).grade, 'PERFECT', 'Active generic grade');
  assertEqual(
    landing.gradeLandingForProfile(-180, 'fbw-a380x').grade,
    'GOOD',
    'Recorded A380 grade',
  );
  assertEqual(profileLoader.getActiveProfileId(), activeProfileId, 'Active profile must remain unchanged');
});

test('gradeLandingForProfile uses A32NX landing bands for the LFPG conventional rate', () => {
  const activeProfileId = profileLoader.getActiveProfileId();
  assertEqual(
    landing.gradeLandingForProfile(-243.3, 'fbw-a32nx').grade,
    'GOOD',
    'Recorded A32NX grade',
  );
  assertEqual(profileLoader.getActiveProfileId(), activeProfileId, 'Active profile must remain unchanged');
});

test('landing-rate scoring context snapshots the recorded policy and exact profile bands', () => {
  const activeProfileId = profileLoader.getActiveProfileId();
  const context = landing.buildLandingRateScoringContext('fbw-a32nx');
  assertEqual(context.schemaVersion, 1, 'Context schema');
  assertEqual(context.policy.id, 'landing-rate-v1', 'Landing policy id');
  assertEqual(context.policy.version, 1, 'Landing policy version');
  assertEqual(context.profile.id, 'fbw-a32nx', 'Recorded profile id');
  assertEqual(context.profile.resolved, true, 'Recorded profile resolution');
  assertEqual(context.thresholds.perfectMinFpm, -120, 'A32NX perfect threshold');
  assertEqual(context.thresholds.goodMinFpm, -250, 'A32NX good threshold');
  assertEqual(context.thresholds.firmMinFpm, -400, 'A32NX firm threshold');
  assertEqual(context.thresholds.hardMinFpm, -650, 'A32NX hard threshold');
  assertEqual(profileLoader.getActiveProfileId(), activeProfileId, 'Context lookup must not change active profile');
});

test('recorded-profile grading fails closed instead of applying generic bands to a retired profile', () => {
  const activeProfileId = profileLoader.getActiveProfileId();
  assertEqual(
    landing.gradeLandingForRecordedProfile(-243.3, 'fbw-a32nx').grade,
    'GOOD',
    'Resolvable recorded profile grade',
  );
  assertEqual(
    landing.gradeLandingForRecordedProfile(-650, 'pmdg-737'),
    null,
    'Retired profile must not be silently regraded as generic',
  );
  assertEqual(
    landing.gradeLandingForRecordedProfile(-650, 737),
    null,
    'Numeric-only recorded profile IDs remain explicit instead of looking missing',
  );
  assertEqual(
    landing.gradeLandingForRecordedProfile(-650, null).grade,
    'FIRM',
    'Pre-profile recordings retain the historical generic default',
  );
  assertEqual(profileLoader.getActiveProfileId(), activeProfileId, 'Active profile must remain unchanged');
});

// ─────────────────────────────────────────────────────────────────────────────
// gradeLanding edge cases
// ─────────────────────────────────────────────────────────────────────────────

test('gradeLanding: zero VS = PERFECT', () => {
  const result = landing.gradeLanding(0);
  assertEqual(result.grade, 'PERFECT', 'Zero VS');
});

test('gradeLanding: positive VS (ascending) = PERFECT', () => {
  // The production landing path does not emit this case; the helper still handles it.
  const result = landing.gradeLanding(100);
  assertEqual(result.grade, 'PERFECT', 'Positive VS');
});

test('gradeLanding: non-finite VS uses neutral failsafe grade', () => {
  for (const vs of [NaN, Infinity, -Infinity]) {
    const result = landing.gradeLanding(vs);
    assertEqual(result.grade, 'FIRM', `Non-finite VS ${vs} grade`);
    assertEqual(result.color, 'gold', `Non-finite VS ${vs} color`);
  }
});

test('gradeLanding: very large negative VS = VERY HARD', () => {
  const result = landing.gradeLanding(-2000);
  assertEqual(result.grade, 'VERY HARD', 'Extreme VS');
});

test('gradeLanding: result has grade property', () => {
  const result = landing.gradeLanding(-200);
  if (!result.grade) {
    throw new Error('Expected grade property');
  }
});

test('gradeLanding: result has color property', () => {
  const result = landing.gradeLanding(-200);
  if (!result.color) {
    throw new Error('Expected color property');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Grade name consistency tests
// ─────────────────────────────────────────────────────────────────────────────

test('gradeLanding: grade names are in expected set', () => {
  const allowedGrades = ['PERFECT', 'GOOD', 'FIRM', 'HARD', 'VERY HARD'];
  
  // Test various VS values
  const testValues = [0, -50, -100, -200, -300, -400, -500, -600, -800, -1000];
  for (const vs of testValues) {
    const result = landing.gradeLanding(vs);
    assertOneOf(result.grade, allowedGrades, `VS ${vs}`);
  }
});

test('gradeLanding: color names are valid CSS colors', () => {
  const allowedColors = ['lime', 'deepskyblue', 'gold', 'orange', 'red'];
  
  const testValues = [0, -50, -200, -400, -550, -700];
  for (const vs of testValues) {
    const result = landing.gradeLanding(vs);
    assertOneOf(result.color, allowedColors, `VS ${vs} color`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Grade progression tests (severity increases with VS magnitude)
// ─────────────────────────────────────────────────────────────────────────────

test('gradeLanding: grades get worse as VS magnitude increases', () => {
  const gradeOrder = ['PERFECT', 'GOOD', 'FIRM', 'HARD', 'VERY HARD'];
  
  const results = [
    { vs: -50, result: landing.gradeLanding(-50) },
    { vs: -200, result: landing.gradeLanding(-200) },
    { vs: -400, result: landing.gradeLanding(-400) },
    { vs: -550, result: landing.gradeLanding(-550) },
    { vs: -700, result: landing.gradeLanding(-700) },
  ];
  
  for (let i = 0; i < results.length - 1; i++) {
    const currentIdx = gradeOrder.indexOf(results[i].result.grade);
    const nextIdx = gradeOrder.indexOf(results[i + 1].result.grade);
    if (nextIdx < currentIdx) {
      throw new Error(
        `Grade should get worse: VS ${results[i].vs} (${results[i].result.grade}) vs ` +
        `VS ${results[i + 1].vs} (${results[i + 1].result.grade})`
      );
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(60));
console.log(`landing.js tests: ${passed} passed, ${failed} failed`);
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
