/**
 * Landing Scoring Wiring Contract Test
 * 
 * This test ensures that every scoring function exported from landing-distance.js
 * is wired into the live landing flow, complementing isolated scoring tests with
 * an integration-level contract.
 * 
 * Contract:
 * - landing-runner.js calls the shared touchdown analysis helper
 * - flight-analysis.js calls the touchdown distance and lateral offset scorers
 * - landing-runner.js still calls scoreBounce(), which is runner-owned state
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createHarness } = require('../../tests/support/mini-test-harness');

const harness = createHarness();

// List of scoring functions that MUST be wired into landing-runner.js
// Update this list when adding new scoring functions to landing-distance.js
const SCORING_FUNCTIONS = [
  'scoreTouchdownDistance',
  'scoreLateralOffset',
  'scoreBounce',
];

const SHARED_SCORING_FUNCTIONS = [
  'scoreTouchdownDistance',
  'scoreLateralOffset',
];

const RUNNER_SCORING_FUNCTIONS = [
  'scoreBounce',
];

// List of calculation functions that scoring depends on (also must be wired)
const CALCULATION_FUNCTIONS = [
  'calculateTouchdownDistance',
  'calculateSignedTouchdownDistance',
  'calculateLateralOffset',
];

const SHARED_ANALYSIS_FUNCTIONS = [
  'buildTouchdownRunwayAnalysis',
];

function appearsAsDefinedAndExported(source, functionName) {
  const definitionPattern = new RegExp(`\\bfunction\\s+${functionName}\\b|\\b(?:const|let|var)\\s+${functionName}\\s*=`, 'm');
  const exportPattern = new RegExp(`module\\.exports\\s*=\\s*\\{[\\s\\S]*?\\b${functionName}\\b`, 'm');
  return definitionPattern.test(source) && exportPattern.test(source);
}

function appearsAsCall(source, functionName) {
  const callPattern = new RegExp(`\\b${functionName}\\s*\\(`, 'g');
  return callPattern.test(source);
}

function getLandingDistanceImportSection(landingRunnerSource) {
  const match = landingRunnerSource.match(/const\s*\{([\s\S]*?)\}\s*=\s*require\(['"]\.\/landing-distance['"]\)/m);
  return match ? match[1] : null;
}

function getFlightAnalysisImportSection(landingRunnerSource) {
  const match = landingRunnerSource.match(/const\s*\{([\s\S]*?)\}\s*=\s*require\(['"]\.\.\/analysis\/flight-analysis['"]\)/m);
  return match ? match[1] : null;
}

function importsLandingDistanceModule(source) {
  return /require\(['"]\.\.\/landing\/landing-distance['"]\)/m.test(source);
}

function appearsInImportSection(importSection, functionName) {
  if (!importSection) return false;
  const symbolPattern = new RegExp(`\\b${functionName}\\b`, 'm');
  return symbolPattern.test(importSection);
}

function runChecks({
  title,
  functions,
  check,
  passMessage,
  failMessage,
  errors,
}) {
  console.log(title);
  for (const fn of functions) {
    harness.test(passMessage(fn), () => {
      if (!check(fn)) {
        const message = failMessage(fn);
        errors.push(message);
        throw new Error(message);
      }
    });
  }
}

function runWiringContractTests() {
  const landingRunnerPath = path.join(__dirname, 'landing-runner.js');
  const landingDistancePath = path.join(__dirname, 'landing-distance.js');
  const flightAnalysisPath = path.join(__dirname, '..', 'analysis', 'flight-analysis.js');
  
  // Read source files
  const landingRunnerSource = fs.readFileSync(landingRunnerPath, 'utf8');
  const landingDistanceSource = fs.readFileSync(landingDistancePath, 'utf8');
  const flightAnalysisSource = fs.readFileSync(flightAnalysisPath, 'utf8');
  
  const errors = [];
  
  console.log('=== Landing Scoring Wiring Contract Tests ===\n');
  
  // Test 1: Verify all scoring functions are exported from landing-distance.js
  runChecks({
    title: 'Checking landing-distance.js exports...',
    functions: SCORING_FUNCTIONS,
    check: (fn) => appearsAsDefinedAndExported(landingDistanceSource, fn),
    passMessage: (fn) => `${fn} is defined and exported`,
    failMessage: (fn) => `${fn} is not properly exported from landing-distance.js`,
    errors,
  });
  
  // Test 2: Verify landing-runner.js calls the shared touchdown analysis helper.
  runChecks({
    title: '\nChecking landing-runner.js touchdown analysis wiring...',
    functions: SHARED_ANALYSIS_FUNCTIONS,
    check: (fn) => appearsAsCall(landingRunnerSource, fn),
    passMessage: (fn) => `${fn}() is called in landing flow`,
    failMessage: (fn) => `${fn} is not called in landing-runner.js`,
    errors,
  });
  
  // Test 3: Verify touchdown scorers are called by the shared analysis helper.
  runChecks({
    title: '\nChecking shared touchdown analysis scoring...',
    functions: SHARED_SCORING_FUNCTIONS,
    check: (fn) => appearsAsCall(flightAnalysisSource, fn),
    passMessage: (fn) => `${fn}() is called by flight-analysis`,
    failMessage: (fn) => `${fn} is not called by flight-analysis.js`,
    errors,
  });

  // Test 4: Verify calculation functions are called by the shared analysis helper.
  runChecks({
    title: '\nChecking shared touchdown analysis geometry...',
    functions: CALCULATION_FUNCTIONS,
    check: (fn) => appearsAsCall(flightAnalysisSource, fn),
    passMessage: (fn) => `${fn}() is called by flight-analysis`,
    failMessage: (fn) => `${fn} is not called by flight-analysis.js`,
    errors,
  });

  // Test 5: Bounce scoring is still runner-owned because it depends on rollout state.
  runChecks({
    title: '\nChecking runner-owned bounce scoring...',
    functions: RUNNER_SCORING_FUNCTIONS,
    check: (fn) => appearsAsCall(landingRunnerSource, fn),
    passMessage: (fn) => `${fn}() is called in landing flow`,
    failMessage: (fn) => `${fn} is not called in landing-runner.js`,
    errors,
  });
  
  // Test 6: Verify the import chain is explicit.
  console.log('\nChecking imports...');
  const landingDistanceImportSection = getLandingDistanceImportSection(landingRunnerSource);
  const flightAnalysisImportSection = getFlightAnalysisImportSection(landingRunnerSource);

  if (landingDistanceImportSection) {
    for (const fn of RUNNER_SCORING_FUNCTIONS) {
      harness.test(`${fn} is imported`, () => {
        if (!appearsInImportSection(landingDistanceImportSection, fn)) {
          const message = `${fn} is not imported in landing-runner.js require statement`;
          errors.push(message);
          throw new Error(message);
        }
      });
    }
  } else {
    console.log('  ✗ Could not find landing-distance import statement');
    errors.push('landing-distance.js import not found in landing-runner.js');
    harness.test('landing-distance import statement exists', () => {
      throw new Error('landing-distance.js import not found in landing-runner.js');
    });
  }

  if (flightAnalysisImportSection) {
    for (const fn of SHARED_ANALYSIS_FUNCTIONS) {
      harness.test(`${fn} is imported`, () => {
        if (!appearsInImportSection(flightAnalysisImportSection, fn)) {
          const message = `${fn} is not imported in landing-runner.js require statement`;
          errors.push(message);
          throw new Error(message);
        }
      });
    }
  } else {
    console.log('  ✗ Could not find flight-analysis import statement');
    errors.push('flight-analysis.js import not found in landing-runner.js');
    harness.test('flight-analysis import statement exists', () => {
      throw new Error('flight-analysis.js import not found in landing-runner.js');
    });
  }

  harness.test('flight-analysis imports landing-distance module', () => {
    if (!importsLandingDistanceModule(flightAnalysisSource)) {
      const message = 'flight-analysis.js does not import landing-distance.js';
      errors.push(message);
      throw new Error(message);
    }
  });

  const { passed, failed } = harness.getStats();
  
  // Summary
  console.log('\n========================================');
  if (failed === 0) {
    console.log(`ALL WIRING TESTS PASSED (${passed} checks)`);
    console.log('\nAll scoring functions are properly wired into the landing flow.');
    process.exit(0);
  } else {
    console.log(`WIRING TESTS FAILED: ${failed} failures, ${passed} passed\n`);
    console.log('ERRORS:');
    for (const err of errors) {
      console.log(`  • ${err}`);
    }
    console.log('\n⚠️  Scoring functions exist but are not connected to the landing flow!');
    console.log('   Monte Carlo tests may pass while real landings produce no scores.');
    console.log('   Fix the landing-runner -> flight-analysis -> landing-distance chain.');
    process.exit(1);
  }
}

// Run if invoked directly
if (require.main === module) {
  runWiringContractTests();
}

module.exports = { runWiringContractTests, SCORING_FUNCTIONS, CALCULATION_FUNCTIONS };

export {};
