#!/usr/bin/env node
/**
 * External Flight Replay Tests
 *
 * Uses optional curated telemetry fixtures to test approach analysis.
 * 
 * Run with: node dist/tests/backend/real-flight-replay.test.js
 */

const fs = require('fs');
const path = require('path');
const { createVreEvaluator, BAND } = require('../../backend/events/vre-evaluator');
const {
  candidateRealFlightsDirs,
  listTopLevelFlightJsonFiles,
  maybeResolveRealFlightsDir,
} = require('./real-flight-fixtures');
const { replayFlightWithTimeline } = require('./generate-flight-timeline');

type AnyRecord = Record<string, any>;

const REAL_FLIGHTS_DIR = maybeResolveRealFlightsDir({ baseDir: __dirname });
const MIN_FIXTURE_COUNT = 10;
const PRODUCTION_REPLAY_FIXTURES = [
  'EGLL-BAW427-2026-01-14-10hz.json',
  'KJFK-JBU2110-2026-01-14-full.json',
  'KJFK-ICE615-2026-01-14.json',
];
const LABELED_GO_AROUND_FIXTURE = REAL_FLIGHTS_DIR
  ? path.join(
    REAL_FLIGHTS_DIR,
    'goarounds',
    'UAL571-KSNA-2026-06-28-labeled.json',
  )
  : null;

function buildTwoAttemptLandingFixture() {
  let timestampMs = 1_700_000_000_000;
  const frames = [];
  const addFrames = (count, makeFrame) => {
    for (let index = 0; index < count; index++) {
      const values = makeFrame(index);
      frames.push({
        timestampMs,
        lat: values.lat,
        lon: values.lon ?? -117,
        alt_msl_ft: values.ra,
        ra_ft: values.ra,
        hdg_deg: 200,
        ias_kts: values.ias ?? 145,
        gs_kts: values.gs ?? 145,
        vs_fpm: values.vs,
        gear_down: true,
        flaps_extended: true,
        wow: values.ra < 10,
      });
      timestampMs += 1000;
    }
  };

  // Attempt one is deliberately unstable and geographically distinct. If any
  // of it survives the go-around reset, the final profile/metrics expose it.
  addFrames(15, index => ({
    ra: 800 - index * 5,
    vs: index % 2 ? -1500 : -700,
    ias: index % 2 ? 190 : 145,
    lat: -10,
  }));
  addFrames(11, index => ({ ra: 730 + index * 50, vs: 1100, ias: 150, lat: -10 }));

  // Attempt two is stable through touchdown and rollout.
  addFrames(55, index => ({ ra: 1450 - index * 20, vs: -700, ias: 145, lat: 20 }));
  addFrames(18, index => ({ ra: 350 - index * 19, vs: -650, ias: 145, lat: 20 }));
  addFrames(1, () => ({ ra: 5, vs: -300, ias: 120, gs: 120, lat: 20 }));
  addFrames(75, index => ({
    ra: 2,
    vs: 0,
    ias: Math.max(0, 110 - index * 2),
    gs: Math.max(0, 110 - index * 2),
    lat: 20,
  }));

  return {
    metadata: { callsign: 'TWO-ATTEMPT-REGRESSION' },
    frames,
  };
}

// ============================================================================
// Data Loading
// ============================================================================

function loadFlightData(filename) {
  const filepath = path.join(REAL_FLIGHTS_DIR, filename);
  if (!fs.existsSync(filepath)) {
    throw new Error(`Flight file not found: ${filepath}`);
  }
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

function listFlightFiles() {
  return listTopLevelFlightJsonFiles(REAL_FLIGHTS_DIR);
}

// ============================================================================
// Frame Conversion
// ============================================================================

function convertToFfFrame(osFrame, _prevOsFrame = null) {
  const {
    timestampMs,
    lat,
    lon,
    alt_msl_ft,
    ra_ft,
    hdg_deg,
    ias_kts,
    gs_kts,
    vs_fpm,
    gear_down,
    flaps_extended,
    wow
  } = osFrame;
  
  // Estimate pitch from VS (rough approximation)
  const pitchDeg = gs_kts > 50 ? Math.atan2(-vs_fpm, gs_kts * 101.269) * (180 / Math.PI) : 0;
  
  return {
    timestampMs,
    lat,
    lon,
    alt_msl: alt_msl_ft,
    display: {
      iasKts: ias_kts,
      vsFpm: vs_fpm,
      raFt: ra_ft,
      gsKts: gs_kts,
      pitchDeg,
      bankDeg: 0,
      hdgDeg: hdg_deg
    },
    gearHandle: gear_down ? 1 : 0,
    gearDownLocked: gear_down ? 0b111 : 0,
    flaps: flaps_extended ? 15000 : 0,
    spoilers: 0,
    wow,
    ra: ra_ft / 3.28084,
    checks: {
      speed_ok: ias_kts >= 120 && ias_kts <= 180,
      vs_ok: vs_fpm > -1200,
      gear_ok: gear_down,
      flaps_ok: flaps_extended,
      spoilers_ok: true,
      lights_ok: true,
      pitch_ok: pitchDeg > -5 && pitchDeg < 15,
      bank_ok: true
    }
  };
}

// ============================================================================
// VRE Analysis
// ============================================================================

function analyzeVre(flightData) {
  const startTime = flightData.frames[0]?.timestampMs || 0;
  const vreEvaluator = createVreEvaluator({ timeNow: () => startTime });
  
  const stats: AnyRecord = {
    totalFrames: flightData.frames.length,
    sampledFrames: 0,
    bandCounts: { BASELINE: 0, ELEVATED: 0, HIGH_FIDELITY: 0, ULTRA_FIDELITY: 0 },
    escalations: {},
    maxRateHz: 0,
    compressionRatio: 0
  };
  
  for (const osFrame of flightData.frames) {
    // Build a frame compatible with VRE evaluator
    const frame = {
      vs: osFrame.vs_fpm || 0,
      gs: osFrame.gs_kts || 0,
      pitchRate: 0,
      rollRate: 0,
      yawRate: 0,
      ra: osFrame.ra_ft || osFrame.alt_msl_ft || 10000,
      gearDown: !!osFrame.gear_down,
      flapsNotch: osFrame.flaps_extended ? 'EXTENDED' : 'UP',
      spoilerState: 'STOWED',
      wow: !!osFrame.wow
    };
    
    // Update evaluator time and evaluate
    vreEvaluator._setTimeForTest(osFrame.timestampMs);
    const result = vreEvaluator.evaluate(frame);
    
    if (result.shouldSample) {
      stats.sampledFrames++;
      const bandName = Object.keys(BAND).find(k => BAND[k] === result.band) || 'UNKNOWN';
      stats.bandCounts[bandName] = (stats.bandCounts[bandName] || 0) + 1;
      stats.maxRateHz = Math.max(stats.maxRateHz, result.rateHz);
      
      // Track escalation reasons
      if (result.escalationString && result.escalationString !== 'interval') {
        const reasons = result.escalationString.split(',');
        for (const r of reasons) {
          stats.escalations[r] = (stats.escalations[r] || 0) + 1;
        }
      }
    }
  }
  
  stats.compressionRatio = stats.totalFrames > 0 
    ? Number((stats.totalFrames / stats.sampledFrames).toFixed(2))
    : 0;
  
  return stats;
}

// ============================================================================
// Simple Analysis (no external deps)
// ============================================================================

function analyzeApproach(flightData) {
  const results = {
    flight: flightData.metadata,
    frameCount: flightData.frames.length,
    altitudes: [],
    touchdown: null,
    errors: [],
    vre: null  // VRE stats added
  };
  
  let prevFrame = null;
  let wasAirborne = false;
  
  for (let i = 0; i < flightData.frames.length; i++) {
    const osFrame = flightData.frames[i];
    
    try {
      const frame = convertToFfFrame(osFrame, prevFrame);
      
      // Sample at intervals
      if (i % 10 === 0 || frame.display.raFt < 100) {
        results.altitudes.push({
          ra_ft: frame.display.raFt,
          ias_kts: frame.display.iasKts,
          vs_fpm: frame.display.vsFpm,
          isStable: frame.checks.speed_ok && frame.checks.vs_ok && frame.checks.gear_ok
        });
      }
      
      // Touchdown detection
      if (!frame.wow) wasAirborne = true;
      if (wasAirborne && frame.wow && !results.touchdown) {
        results.touchdown = {
          vs_fpm: frame.display.vsFpm,
          ias_kts: frame.display.iasKts,
          ra_ft: frame.display.raFt
        };
      }
      
      prevFrame = osFrame;
    } catch (err) {
      results.errors.push({ frame: i, error: err.message });
    }
  }
  
  // Run VRE analysis
  try {
    results.vre = analyzeVre(flightData);
  } catch (err) {
    results.errors.push({ frame: 'VRE', error: err.message });
  }
  
  return results;
}

// ============================================================================
// Test Runner
// ============================================================================

function runTests() {
  console.log('\n=== Real Flight Data Replay Tests ===\n');
  if (!REAL_FLIGHTS_DIR) {
    console.log('Real flight replay tests skipped: tests/data/real-flights is not present in this checkout');
    console.log('Set FF_REAL_FLIGHTS_DIR to run the curated real-flight replay suite.\n');
    return true;
  }

  console.log(`Fixtures: ${REAL_FLIGHTS_DIR}\n`);
  
  const files = listFlightFiles();
  
  if (files.length === 0) {
    console.error('No flight data files found.');
    console.error(`Searched:\n${candidateRealFlightsDirs(__dirname).map((candidate) => `  - ${candidate}`).join('\n')}`);
    console.error('Run: node scripts/real-flight-data/opensky-simple.js --airport KJFK --date 2026-01-14 --limit 3');
    return false;
  }

  if (files.length < MIN_FIXTURE_COUNT) {
    console.error(`Expected at least ${MIN_FIXTURE_COUNT} curated real-flight fixtures, found ${files.length}.`);
    return false;
  }
  
  console.log(`Found ${files.length} flight data file(s)\n`);
  
  let passed = 0;
  let failed = 0;
  let touchdownCount = 0;
  let sampledVreCount = 0;
  let highFidelityVreCount = 0;
  
  for (const file of files) {
    process.stdout.write(`Testing ${file}... `);
    
    try {
      const data = loadFlightData(file);
      
      // Basic structure tests
      if (!data.metadata || !data.frames) {
        throw new Error('Invalid structure: missing metadata or frames');
      }
      if (data.frames.length < 10) {
        throw new Error(`Too few frames: ${data.frames.length}`);
      }
      
      // Frame format tests
      const firstFrame = data.frames[0];
      if (typeof firstFrame.lat !== 'number') throw new Error('Missing lat');
      if (typeof firstFrame.lon !== 'number') throw new Error('Missing lon');
      if (typeof firstFrame.alt_msl_ft !== 'number') throw new Error('Missing alt_msl_ft');
      
      // Analyze approach
      const results = analyzeApproach(data);
      
      if (results.errors.length > 0) {
        throw new Error(`${results.errors.length} processing errors`);
      }
      
      // Report
      console.log(`✓ ${results.frameCount} frames`);
      
      if (results.touchdown) {
        touchdownCount++;
        console.log(`   Touchdown: ${results.touchdown.vs_fpm.toFixed(0)} fpm @ ${results.touchdown.ias_kts.toFixed(0)} kts`);
      }
      
      // VRE stats
      if (results.vre) {
        const v = results.vre;
        if (v.sampledFrames > 0) sampledVreCount++;
        if ((v.bandCounts.HIGH_FIDELITY || 0) > 0 || (v.bandCounts.ULTRA_FIDELITY || 0) > 0) {
          highFidelityVreCount++;
        }
        console.log(`   VRE: ${v.sampledFrames}/${v.totalFrames} samples (${v.compressionRatio}x compression)`);
        console.log(`   Bands: B=${v.bandCounts.BASELINE} E=${v.bandCounts.ELEVATED} HF=${v.bandCounts.HIGH_FIDELITY} UF=${v.bandCounts.ULTRA_FIDELITY}`);
        const topEscalations = Object.entries(v.escalations)
          .sort((a, b) => Number(b[1]) - Number(a[1]))
          .slice(0, 3)
          .map(([k, v]) => `${k}:${v}`)
          .join(', ');
        if (topEscalations) {
          console.log(`   Top escalations: ${topEscalations}`);
        }
      }
      
      passed++;
      
    } catch (err) {
      console.log(`✗ ${err.message}`);
      failed++;
    }
  }

  const aggregateChecks = [
    {
      name: 'fixture set includes touchdown scenarios',
      ok: touchdownCount >= Math.min(8, files.length),
      detail: `${touchdownCount}/${files.length} fixtures reached touchdown`,
    },
    {
      name: 'VRE samples every fixture',
      ok: sampledVreCount === files.length,
      detail: `${sampledVreCount}/${files.length} fixtures produced VRE samples`,
    },
    {
      name: 'VRE escalates on low-altitude approach data',
      ok: highFidelityVreCount > 0,
      detail: `${highFidelityVreCount}/${files.length} fixtures reached high/ultra fidelity`,
    },
  ];

  for (const check of aggregateChecks) {
    if (check.ok) {
      console.log(`Aggregate: ${check.name} - ${check.detail}`);
    } else {
      console.log(`Aggregate failure: ${check.name} - ${check.detail}`);
      failed++;
    }
  }

  for (const fixture of PRODUCTION_REPLAY_FIXTURES) {
    process.stdout.write(`Production replay ${fixture}... `);
    try {
      if (!files.includes(fixture)) {
        throw new Error('fixture missing');
      }
      const data = loadFlightData(fixture);
      const result = replayFlightWithTimeline(data, {
        flightId: fixture.replace(/\.json$/i, ''),
        intervalMs: fixture.includes('10hz') ? 500 : 1000,
      });
      const events = Array.isArray(result.timeline?.events) ? result.timeline.events : [];
      const hasPhase = events.some((event) => event.event_type === 'phase_start');
      const hasFinalScore = events.some((event) => event.event_type === 'score_final');
      const hasTouchdown = events.some((event) => event.event_type === 'marker' && event.marker_type === 'touchdown');
      if (!hasPhase) throw new Error('no phase_start events');
      if (!hasFinalScore) throw new Error('no score_final event');
      if (!hasTouchdown) throw new Error('no touchdown marker');
      console.log(`ok (${events.length} events, score ${result.score}%)`);
      passed++;
    } catch (err) {
      console.log(`failed: ${err.message}`);
      failed++;
    }
  }

  process.stdout.write('Go-around scoring reset (approach -> go-around -> approach -> landing)... ');
  try {
    const result = replayFlightWithTimeline(buildTwoAttemptLandingFixture(), {
      flightId: 'two-attempt-scoring-regression',
      intervalMs: 1000,
    });
    if (result.goAroundEvents.length !== 1) {
      throw new Error(`expected one go-around, got ${result.goAroundEvents.length}`);
    }
    if (!result.finalLandingPayload) throw new Error('landing did not finalize');
    if (!result.finalApproachScore || !Number.isFinite(result.finalApproachScore.score)) {
      throw new Error('final approach score missing');
    }
    if (result.score !== result.finalApproachScore.score) {
      throw new Error('timeline score did not use the finalized current-approach score');
    }
    if (result.approachProfile.length !== result.finalApproachScore.samples) {
      throw new Error('profile/sample count mismatch');
    }
    if (result.approachProfile.length < 20) throw new Error('second approach profile is unexpectedly short');
    if (result.approachProfile.some(point => point.latDeg !== 20)) {
      throw new Error('first-attempt samples leaked into the final approach profile');
    }
    if (result.finalApproachScore.breakdown.speed_ok !== 100) {
      throw new Error('first-attempt speed excursions leaked into final scoring');
    }
    if (result.finalApproachScore.breakdown.vs_ok !== 100) {
      throw new Error('first-attempt sink-rate excursions leaked into final scoring');
    }
    console.log(`ok (${result.finalApproachScore.samples} second-attempt samples, score ${result.score}%)`);
    passed++;
  } catch (err) {
    console.log(`failed: ${err.message}`);
    failed++;
  }

  process.stdout.write('Labeled real-world go-around replay (UAL571 at KSNA)... ');
  try {
    if (!fs.existsSync(LABELED_GO_AROUND_FIXTURE)) throw new Error('fixture missing');
    const data = JSON.parse(fs.readFileSync(LABELED_GO_AROUND_FIXTURE, 'utf8'));
    if (data.metadata?.hasGoAround !== true) throw new Error('fixture is not positively labeled');
    if (!data.metadata?.labelSourceUrl) throw new Error('fixture label provenance missing');

    const result = replayFlightWithTimeline(data, {
      flightId: 'UAL571-KSNA-2026-06-28-labeled',
      intervalMs: 1000,
    });
    if (result.goAroundEvents.length !== 1) {
      throw new Error(`expected one detected go-around, got ${result.goAroundEvents.length}`);
    }
    const detected = result.goAroundEvents[0];
    const labelTimestampMs = Date.parse(data.metadata.eventTimestamp);
    const detectionLagMs = detected.timestampMs - labelTimestampMs;
    if (detectionLagMs < 0 || detectionLagMs > 12_000) {
      throw new Error(`detector lag ${detectionLagMs}ms is outside the expected confirmation window`);
    }
    if (detected.previous_phase !== 'DESCENT') {
      throw new Error(`expected DESCENT provenance, got ${detected.previous_phase}`);
    }
    const hasMarker = result.timeline.events.some(
      event => event.event_type === 'marker' && event.marker_type === 'go_around',
    );
    if (!hasMarker) throw new Error('go-around timeline marker missing');
    console.log(`ok (detected ${detectionLagMs / 1000}s after label)`);
    passed++;
  } catch (err) {
    console.log(`failed: ${err.message}`);
    failed++;
  }
  
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  
  return failed === 0;
}

// ============================================================================
// Exports & CLI
// ============================================================================

module.exports = {
  loadFlightData,
  convertToFfFrame,
  analyzeApproach,
  analyzeVre,
  listFlightFiles,
  REAL_FLIGHTS_DIR,
};

if (require.main === module) {
  const success = runTests();
  process.exit(success ? 0 : 1);
}

export {};
