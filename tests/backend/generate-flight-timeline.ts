#!/usr/bin/env node
/**
 * Generate timelines from optional flight replay fixtures.
 *
 * This helper uses an isolated collector and installs no production transport
 * or persistence subscribers. Fixtures and generated output are supplied
 * separately from the application runtime.
 * 
 * Usage:
 *   node dist/tests/backend/generate-flight-timeline.js                     # All flights
 *   node dist/tests/backend/generate-flight-timeline.js KJFK-ICE615        # Specific flight
 *   node dist/tests/backend/generate-flight-timeline.js --list              # List available flights
 *   node dist/tests/backend/generate-flight-timeline.js --instability       # Generate with instabilities
 * 
 * Output:
 *   tests/data/real-flights/timelines/<flight>-timeline.json
 * 
 * @module generate-flight-timeline
 */

'use strict';

// Set defaults for testing
if (!process.env.VREF_KTS) {
  process.env.VREF_KTS = '170';
}

const fs = require('fs');
const path = require('path');
const { APPROACH_PHASES, PHASES } = require('../../backend/lifecycle/phases');
const { VIOLATION_RULE } = require('../../shared/violation-rules.js');
const { maybeResolveRealFlightsDir } = require('./real-flight-fixtures');

type AnyRecord = Record<string, any>;

const REAL_FLIGHTS_DIR = maybeResolveRealFlightsDir({ baseDir: __dirname, requireJson: false });
const TIMELINE_OUTPUT_DIR = REAL_FLIGHTS_DIR ? path.join(REAL_FLIGHTS_DIR, 'timelines') : null;

// ============================================================================
// Timeline Capture
// ============================================================================

/**
 * Create a timeline collector that captures events during flight replay.
 * Uses simulated flight time, not wall-clock time.
 */
function createTimelineCollector(flightId) {
  const events = [];
  let eventIndex = 0;
  let currentSimTime = 0;  // Current simulation timestamp
  
  // Track active violations (keyed by rule_id)
  const activeViolations = new Map();
  let currentPhase = null;
  let phaseStartTs = null;
  
  /**
   * Set current simulation time (call this before processing each frame).
   */
  function setSimTime(timestampMs) {
    currentSimTime = timestampMs;
  }
  
  /**
   * Add an event to the timeline.
   */
  function addEvent(eventData) {
    const timestamp = eventData.timestamp_ms ?? currentSimTime;
    events.push({
      id: `${flightId}-${eventIndex++}`,
      flightId,
      timestamp_ms: timestamp,
      timestamp_utc: new Date(timestamp).toISOString(),
      ...eventData,
    });
  }
  
  /**
   * Record a phase transition.
   */
  function recordPhase(phaseName, context = {}) {
    // End previous phase
    if (currentPhase && currentPhase !== phaseName) {
      addEvent({
        event_type: 'phase_end',
        phase_name: currentPhase,
        duration_ms: currentSimTime - (phaseStartTs || currentSimTime),
      });
    }
    
    // Start new phase
    currentPhase = phaseName;
    phaseStartTs = currentSimTime;
    addEvent({
      event_type: 'phase_start',
      phase_name: phaseName,
      context,
    });
  }
  
  /**
   * Record a violation (start).
   */
  function startViolation(ruleId, severity, metrics = {}) {
    if (activeViolations.has(ruleId)) return;
    
    activeViolations.set(ruleId, { startTime: currentSimTime, metrics });
    
    addEvent({
      event_type: 'violation_start',
      rule_id: ruleId,
      severity,
      metrics,
    });
  }
  
  /**
   * Record a violation (end).
   */
  function endViolation(ruleId, scoreImpact = 0) {
    const violation = activeViolations.get(ruleId);
    if (!violation) return;
    
    activeViolations.delete(ruleId);
    
    addEvent({
      event_type: 'violation_end',
      rule_id: ruleId,
      duration_ms: currentSimTime - violation.startTime,
      score_impact: scoreImpact,
    });
  }
  
  /**
   * Record a marker event.
   */
  function addMarker(markerType, context = {}) {
    addEvent({
      event_type: 'marker',
      marker_type: markerType,
      context,
    });
  }
  
  /**
   * Record final score.
   */
  function recordFinalScore(score, breakdown = {}) {
    addEvent({
      event_type: 'score_final',
      score,
      breakdown,
    });
  }
  
  /**
   * Get the complete timeline.
   */
  function getTimeline() {
    // Close any remaining violations
    for (const [ruleId] of activeViolations) {
      endViolation(ruleId, 0);
    }
    
    // End final phase
    if (currentPhase) {
      addEvent({
        event_type: 'phase_end',
        phase_name: currentPhase,
        duration_ms: currentSimTime - (phaseStartTs || currentSimTime),
      });
    }
    
    return {
      flightId,
      generatedAt: new Date().toISOString(),
      source: 'real-flight-timeline-generator',
      eventCount: events.length,
      events,
    };
  }
  
  return {
    setSimTime,
    addEvent,
    recordPhase,
    startViolation,
    endViolation,
    addMarker,
    recordFinalScore,
    getTimeline,
    events,
  };
}

// ============================================================================
// Frame Processing (from test-real-flight-integration.js)
// ============================================================================

function lerp(a, b, t) {
  if (typeof a !== 'number' || typeof b !== 'number') return b;
  return a + (b - a) * t;
}

function interpolateFrame(frameA: AnyRecord, frameB: AnyRecord, t: number, newTimestampMs: number, options: AnyRecord = {}) {
  const ra_ft = lerp(frameA.ra_ft, frameB.ra_ft, t);
  const alt_msl_ft = lerp(frameA.alt_msl_ft, frameB.alt_msl_ft, t);
  const ias_kts = lerp(frameA.ias_kts, frameB.ias_kts, t);
  const gs_kts = lerp(frameA.gs_kts, frameB.gs_kts, t);
  const vs_fpm = lerp(frameA.vs_fpm, frameB.vs_fpm, t);
  const hdg_deg = lerp(frameA.hdg_deg, frameB.hdg_deg, t);
  
  const gear_down = ra_ft < 2500;
  const flaps_fraction = ra_ft > 3000 ? 0 
    : ra_ft > 2000 ? 0.3
    : ra_ft > 1000 ? 0.6
    : 1.0;
  const spoilers_fraction = ra_ft < 10 ? 1.0 : 0;
  const wow = ra_ft < 10;
  
  const fpa_deg = gs_kts > 50 ? Math.atan2(-vs_fpm / 60, gs_kts * 1.68781) * (180 / Math.PI) : 0;
  const pitch_deg = fpa_deg + 3;
  
  const hdgChange = Math.abs((frameB.hdg_deg || 0) - (frameA.hdg_deg || 0));
  const bank_deg = hdgChange > 5 ? Math.min(15, hdgChange * 0.5) * (Math.random() > 0.5 ? 1 : -1) : (Math.random() - 0.5) * 4;
  
  let finalIas = ias_kts;
  let finalVs = vs_fpm;
  let finalGear = gear_down;
  let finalFlaps = flaps_fraction;
  
  if (options.instability) {
    const inst = options.instability;
    const speedRange = inst.speedExcursionRange || 100;
    if (inst.speedExcursionAlt && Math.abs(ra_ft - inst.speedExcursionAlt) < speedRange) {
      finalIas += inst.speedExcursionKts || 20;
    }
    if (inst.lateGearAlt && ra_ft > inst.lateGearAlt) {
      finalGear = false;
    }
    if (inst.lateFlapAlt && ra_ft > inst.lateFlapAlt) {
      finalFlaps = Math.max(0, finalFlaps - 0.5);
    }
    if (inst.highSinkAlt && ra_ft < inst.highSinkAlt && ra_ft > 50) {
      finalVs = Math.min(finalVs, inst.highSinkFpm || -1200);
    }
  }
  
  return {
    timestampMs: newTimestampMs,
    lat: lerp(frameA.lat, frameB.lat, t),
    lon: lerp(frameA.lon, frameB.lon, t),
    alt_msl_ft,
    ra_ft,
    hdg_deg,
    ias_kts: finalIas,
    gs_kts,
    vs_fpm: finalVs,
    gear_down: finalGear,
    flaps_extended: finalFlaps > 0.5,
    flaps_fraction: finalFlaps,
    spoilers_fraction,
    pitch_deg,
    bank_deg,
    wow
  };
}

function synthesizeOriginal(frame: AnyRecord, options: AnyRecord = {}) {
  const ra_ft = frame.ra_ft ?? frame.alt_msl_ft ?? 0;
  const vs_fpm = frame.vs_fpm ?? 0;
  const gs_kts = frame.gs_kts ?? 200;
  const ias_kts = frame.ias_kts ?? gs_kts * 0.82;
  const wow = ra_ft < 10;
  
  const gear_down = ra_ft < 2500;
  const flaps_fraction = ra_ft > 3000 ? 0 
    : ra_ft > 2000 ? 0.3
    : ra_ft > 1000 ? 0.6
    : 1.0;
  
  const fpa_deg = gs_kts > 50 ? Math.atan2(-vs_fpm / 60, gs_kts * 1.68781) * (180 / Math.PI) : 0;
  const pitch_deg = fpa_deg + 3;
  const bank_deg = (Math.random() - 0.5) * 4;
  
  let finalIas = ias_kts;
  let finalVs = vs_fpm;
  let finalGear = gear_down;
  let finalFlaps = flaps_fraction;
  
  if (options.instability) {
    const inst = options.instability;
    const speedRange = inst.speedExcursionRange || 100;
    if (inst.speedExcursionAlt && Math.abs(ra_ft - inst.speedExcursionAlt) < speedRange) {
      finalIas += inst.speedExcursionKts || 20;
    }
    if (inst.lateGearAlt && ra_ft > inst.lateGearAlt) {
      finalGear = false;
    }
    if (inst.lateFlapAlt && ra_ft > inst.lateFlapAlt) {
      finalFlaps = Math.max(0, finalFlaps - 0.5);
    }
    if (inst.highSinkAlt && ra_ft < inst.highSinkAlt && ra_ft > 50) {
      finalVs = Math.min(finalVs, inst.highSinkFpm || -1200);
    }
  }
  
  return {
    ...frame,
    ias_kts: finalIas,
    vs_fpm: finalVs,
    gear_down: finalGear,
    flaps_extended: finalFlaps > 0.5,
    flaps_fraction: finalFlaps,
    spoilers_fraction: wow ? 1.0 : 0,
    pitch_deg,
    bank_deg,
    wow
  };
}

function interpolateFrames(frames: AnyRecord[], targetIntervalMs = 1000, options: AnyRecord = {}) {
  if (frames.length < 2) return frames;
  
  const denseFrames = [];
  
  for (let i = 0; i < frames.length - 1; i++) {
    const frameA = frames[i];
    const frameB = frames[i + 1];
    
    const tA = frameA.timestampMs;
    const tB = frameB.timestampMs;
    const duration = tB - tA;
    
    if (duration <= 0) {
      denseFrames.push(synthesizeOriginal(frameA, options));
      continue;
    }
    
    denseFrames.push(synthesizeOriginal(frameA, options));
    
    const steps = Math.floor(duration / targetIntervalMs);
    for (let step = 1; step < steps; step++) {
      const t = step / steps;
      const interpTimestamp = tA + step * targetIntervalMs;
      denseFrames.push(interpolateFrame(frameA, frameB, t, interpTimestamp, options));
    }
  }
  
  denseFrames.push(synthesizeOriginal(frames[frames.length - 1], options));
  
  return denseFrames;
}

function convertOpenSkyToFF(osFrame, _prevFrame = null, dtMs = 1000) {
  const {
    timestampMs,
    lat,
    lon,
    alt_msl_ft = 0,
    ra_ft = 0,
    hdg_deg = 0,
    ias_kts = 0,
    gs_kts = 0,
    vs_fpm = 0,
    gear_down = false,
    flaps_extended = false,
    flaps_fraction = flaps_extended ? 1.0 : 0,
    spoilers_fraction = 0,
    pitch_deg = 0,
    bank_deg = 0,
    wow = false
  } = osFrame;
  
  const pitchRad = pitch_deg * (Math.PI / 180);
  const bankRad = bank_deg * (Math.PI / 180);
  const gforce = wow ? (1.0 + Math.abs(vs_fpm) / 500) : 1.0;
  
  return {
    timestampMs,
    display: {
      iasKts: ias_kts,
      vsFpm: vs_fpm,
      raFt: ra_ft,
      gsKts: gs_kts,
      pitchDeg: pitch_deg,
      bankDeg: bank_deg,
      hdgDeg: hdg_deg
    },
    ias: ias_kts,
    vs: vs_fpm,
    ra: ra_ft,
    wow,
    gs: gs_kts,
    heading: hdg_deg,
    lat,
    lon,
    gforce,
    alt_msl: alt_msl_ft,
    gearDownLocked: gear_down ? 0b111 : 0,
    gearHandle: gear_down ? 1 : 0,
    // Flaps/spoilers: 0-100 percent (SimConnect-native)
    flaps: flaps_fraction * 100,
    spoilers: spoilers_fraction * 100,
    pitch: pitchRad,
    bank: bankRad,
    windSpeed: 8,
    windDir: 270,
    visibilityM: 3000,  // IMC for 1000ft gate
    checks: {
      speed_ok: ias_kts >= 120 && ias_kts <= 180,
      vs_ok: vs_fpm > -1200,
      gear_ok: gear_down,
      flaps_ok: flaps_fraction > 0.5,
      spoilers_ok: true,
      lights_ok: true,
      pitch_ok: Math.abs(pitch_deg) < 10,
      bank_ok: Math.abs(bank_deg) < 10
    },
    dtMs,
    _replay: true,
    _synthetic: true
  };
}

// ============================================================================
// Flight Replay with Timeline Generation
// ============================================================================

/**
 * Replay a flight through PRODUCTION evaluators and collect timeline events.
 * 
 * This now uses the actual production evaluators to test them:
 * - phase-runner (phase detection)
 * - landing-runner (touchdown detection and grading)
 * - stability-runner (approach stability scoring)
 */
function replayFlightWithTimeline(flightData: AnyRecord, options: AnyRecord = {}) {
  const stabilityRunner = require('../../backend/stability/stability-runner');
  const { createPhaseRunner, PHASES: _PHASES } = require('../../backend/lifecycle/phase-runner');
  const { createLandingRunner } = require('../../backend/landing/landing-runner');
  const eventBus = require('../../backend/core/event-bus');
  const {
    resetGoAroundScoringState,
    shouldCollectCurrentApproachSample,
    shouldStartCurrentApproachScorer,
  } = require('../../backend/core/simbridge-core-utils');
  const timeSource = require('../../backend/core/time-source');
  
  const flightId = options.flightId || flightData.metadata?.callsign || 'UNKNOWN';
  const timeline = createTimelineCollector(flightId);
  
  // Interpolate frames to 1Hz (100ms would be more realistic but slower)
  const denseFrames = interpolateFrames(
    flightData.frames, 
    options.intervalMs || 1000,
    { instability: options.instability }
  );
  
  // Create a controllable time source for replay
  const startTime = denseFrames[0]?.timestampMs || Date.now();
  const simTimeSource = timeSource.createFixedSource(startTime);
  
  // Create isolated evaluator instances with controlled time source
  const phaseRunner = createPhaseRunner({ timeNow: () => simTimeSource.get() });
  const landingRunner = createLandingRunner();
  
  // Reset module-level stability runner
  stabilityRunner.resetStability();
  
  // Track state for timeline events
  let lastPhase = null;
  const altMarkers = { 1000: false, 500: false, 200: false };
  let _touchdownCount = 0;
  let currentApproachScorer = new stabilityRunner.SimpleStabilityScorer();
  let finalApproachScore = null;
  let finalApproachProfile = [];
  let finalLandingPayload = null;
  const goAroundEvents = [];

  const createCurrentApproachScorer = () => new stabilityRunner.SimpleStabilityScorer();
  const unsubscribeGoAround = eventBus.on('phase:goAround', (rawPayload) => {
    const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
    const timestampMs = simTimeSource.get();
    goAroundEvents.push({ ...payload, timestampMs });
    timeline.setSimTime(timestampMs);
    timeline.addMarker('go_around', payload);
    currentApproachScorer = resetGoAroundScoringState({
      resetStability: stabilityRunner.resetStability,
      landingRunner,
      createCurrentApproachScorer,
    });
  });

  const unsubscribeLandingFinal = eventBus.on('landing:final', (rawPayload) => {
    const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
    finalLandingPayload = { ...payload };
    if (!currentApproachScorer || currentApproachScorer.hasScored) return;

    finalApproachScore = currentApproachScorer.getScore(
      Number.isFinite(options.thresholdElevFt) ? options.thresholdElevFt : null,
      { criteria: options.stabilityCriteria || undefined },
    );
    finalApproachProfile = currentApproachScorer.getApproachProfile(5000);
    currentApproachScorer = null;
  });
  
  // Capture broadcast messages for timeline
  const capturedBroadcasts = [];
  const broadcast = (msg) => {
    capturedBroadcasts.push({ ...msg, _simTime: simTimeSource.get() });
  };
  
  // Process each frame through production evaluators
  let prevFrame = null;
  try {
  for (const osFrame of denseFrames) {
    const dtMs = prevFrame ? (osFrame.timestampMs - prevFrame.timestampMs) : 1000;
    const frame = convertOpenSkyToFF(osFrame, prevFrame, dtMs);
    prevFrame = osFrame;
    
    // Advance simulation time
    simTimeSource.set(osFrame.timestampMs);
    timeline.setSimTime(osFrame.timestampMs);
    
    // ═══════════════════════════════════════════════════════════════════════
    // PHASE RUNNER (production)
    // ═══════════════════════════════════════════════════════════════════════
    const frameSurface = (frame as AnyRecord).surface;
    const phaseResult = phaseRunner.updatePhase({
      iasKts: frame.display?.iasKts ?? frame.ias,
      wow: frame.wow,
      vsFpm: frame.display?.vsFpm ?? frame.vs,
      raFt: frame.display?.raFt ?? frame.ra,
      gsKts: frame.display?.gsKts ?? frame.gs,
      altMslFt: frame.alt_msl,
      approachConfigured: Boolean(frame.gearDownLocked)
        || (typeof frame.flaps === 'number' && Number.isFinite(frame.flaps) && frame.flaps > 0),
      aircraftName: flightId,
      onRunway: typeof frameSurface?.onRunway === 'boolean'
        ? frameSurface.onRunway
        : (typeof frameSurface?.runwayLike === 'boolean' ? frameSurface.runwayLike : null),
    }, broadcast);
    
    const currentPhase = phaseResult.phase;
    if (currentPhase !== lastPhase) {
      timeline.recordPhase(currentPhase, {
        altitude_ft: Math.round(frame.ra),
        ias_kts: Math.round(frame.ias),
      });
      lastPhase = currentPhase;
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // STABILITY RUNNER (production)
    // ═══════════════════════════════════════════════════════════════════════
    const stabResult = stabilityRunner.runStability(frame);

    // Mirror the live current-approach collection path. The shared go-around
    // reset listener above is invoked synchronously by the production phase
    // runner, before any climb frame can reach this scorer.
    const raFt = frame.display?.raFt ?? frame.ra ?? null;
    const vsFpm = frame.display?.vsFpm ?? frame.vs ?? null;
    const eligible = shouldCollectCurrentApproachSample({
      phase: currentPhase,
      raFt,
      vsFpm,
      onGround: frame.wow,
      rolloutActive: landingRunner.isRolloutActive(),
      collectionCeilingFt: options.collectionCeilingFt,
      warmup: false,
    });
    const startEligible = eligible && Number.isFinite(vsFpm) && vsFpm < 0;

    if (shouldStartCurrentApproachScorer({
      flightActive: true,
      eligible: startEligible,
      scorerPresent: !!currentApproachScorer,
      hasScored: currentApproachScorer?.hasScored === true,
    })) {
      currentApproachScorer = createCurrentApproachScorer();
    }

    if (eligible && currentApproachScorer && !currentApproachScorer.hasScored) {
      const sample = stabilityRunner.frameToSample({
        ...frame,
        pitchDeg: frame.display?.pitchDeg,
        bankDeg: frame.display?.bankDeg,
      });
      if (sample) currentApproachScorer.addSample(sample);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // LANDING RUNNER (production)
    // ═══════════════════════════════════════════════════════════════════════
    const currentTime = simTimeSource.get();
    const timeCtx = {
      nowEpochMs: currentTime,
      nowIso: new Date(currentTime).toISOString(),
      flightStartEpochMs: denseFrames[0]?.timestampMs || currentTime,
    };
    const landingCtx = {
      phase: currentPhase,
      stability: stabResult,
    };
    landingRunner.update(frame, broadcast, timeCtx, landingCtx);
    
    // ═══════════════════════════════════════════════════════════════════════
    // Timeline events (altitude markers, violations)
    // ═══════════════════════════════════════════════════════════════════════
    
    // Altitude markers during approach
    if (APPROACH_PHASES.has(currentPhase) && currentPhase !== PHASES.GO_AROUND) {
      if (frame.ra < 1050 && frame.ra > 950 && !altMarkers[1000]) {
        altMarkers[1000] = true;
        timeline.addMarker('altitude_1000', { ra_ft: Math.round(frame.ra) });
      }
      if (frame.ra < 550 && frame.ra > 450 && !altMarkers[500]) {
        altMarkers[500] = true;
        timeline.addMarker('altitude_500', { ra_ft: Math.round(frame.ra) });
      }
      if (frame.ra < 250 && frame.ra > 150 && !altMarkers[200]) {
        altMarkers[200] = true;
        timeline.addMarker('altitude_200', { ra_ft: Math.round(frame.ra) });
      }
    }
    
    // Detect violations from frame checks (during approach)
    if (APPROACH_PHASES.has(currentPhase) && currentPhase !== PHASES.GO_AROUND) {
      if (!frame.checks.speed_ok) {
        timeline.startViolation(VIOLATION_RULE.EXCESS_IAS_DEVIATION, 'warning', { ias_kts: Math.round(frame.ias) });
      } else {
        timeline.endViolation(VIOLATION_RULE.EXCESS_IAS_DEVIATION, -2);
      }
      
      if (!frame.checks.vs_ok) {
        timeline.startViolation(VIOLATION_RULE.HIGH_SINK_RATE, 'warning', { vs_fpm: Math.round(frame.vs) });
      } else {
        timeline.endViolation(VIOLATION_RULE.HIGH_SINK_RATE, -3);
      }
      
      if (frame.ra < 1500 && !frame.checks.gear_ok) {
        timeline.startViolation(VIOLATION_RULE.GEAR_NOT_DOWN, 'critical', { ra_ft: Math.round(frame.ra) });
      } else {
        timeline.endViolation(VIOLATION_RULE.GEAR_NOT_DOWN, -5);
      }
      
      if (frame.ra < 1000 && !frame.checks.flaps_ok) {
        timeline.startViolation(VIOLATION_RULE.FLAPS_NOT_SET, 'warning', { ra_ft: Math.round(frame.ra) });
      } else {
        timeline.endViolation(VIOLATION_RULE.FLAPS_NOT_SET, -2);
      }
    }
  }
  } finally {
    unsubscribeGoAround();
    unsubscribeLandingFinal();
    timeSource.resetTimeSource();
  }
  
  // Process captured broadcasts for landing events
  for (const msg of capturedBroadcasts) {
    if (msg.type === 'landing') {
      timeline.setSimTime(msg._simTime);
      timeline.addMarker('touchdown', {
        ias_kts: msg.ias_kts || 0,
        vs_fpm: msg.vs_fpm || 0,
        gforce: msg.gforce || '1.00',
        grade: msg.grade || 'unknown',
      });
      _touchdownCount++;
    }
  }
  
  // Get final stability score by checking last result
  const finalStab = stabilityRunner.runStability({
    display: { iasKts: 0, vsFpm: 0, raFt: 0, gsKts: 0 },
    wow: true,
    visibilityM: 10000
  });
  
  // Extract numeric score (realtimeScore might be object with .score property)
  let finalScore = 100;
  if (typeof finalApproachScore?.score === 'number') {
    finalScore = finalApproachScore.score;
  } else if (typeof finalStab.realtimeScore === 'number') {
    finalScore = finalStab.realtimeScore;
  } else if (finalStab.realtimeScore?.score !== undefined) {
    finalScore = finalStab.realtimeScore.score;
  } else if (typeof finalStab.ultimateScore === 'number') {
    finalScore = finalStab.ultimateScore;
  }
  
  timeline.recordFinalScore(finalScore, {
    realtimeScore: finalStab.realtimeScore,
    ultimateScore: finalStab.ultimateScore,
    windowSamples: finalStab.windowSamples,
    frameCount: denseFrames.length,
    approachSamples: finalApproachScore?.samples ?? null,
    goAroundCount: goAroundEvents.length,
  });
  
  return {
    timeline: timeline.getTimeline(),
    score: finalScore,
    frameCount: denseFrames.length,
    goAroundEvents,
    finalApproachScore,
    approachProfile: finalApproachProfile,
    finalLandingPayload,
  };
}

// ============================================================================
// File Loading
// ============================================================================

function loadFlightFiles() {
  if (!REAL_FLIGHTS_DIR) {
    console.error('Real flights directory not found.');
    return [];
  }

  if (!fs.existsSync(REAL_FLIGHTS_DIR)) {
    console.error('Real flights directory not found:', REAL_FLIGHTS_DIR);
    return [];
  }
  
  const files = fs.readdirSync(REAL_FLIGHTS_DIR)
    .filter(f => f.endsWith('.json') && !f.includes('metadata'))
    .map(f => ({
      name: f.replace('.json', ''),
      path: path.join(REAL_FLIGHTS_DIR, f),
    }));
  
  return files;
}

function loadFlight(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return data;
}

// ============================================================================
// Main CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  if (!REAL_FLIGHTS_DIR || !TIMELINE_OUTPUT_DIR) {
    console.error('Real flights directory not found. Set FF_REAL_FLIGHTS_DIR or restore tests/data/real-flights.');
    process.exit(1);
  }
  
  // Create output directory
  if (!fs.existsSync(TIMELINE_OUTPUT_DIR)) {
    fs.mkdirSync(TIMELINE_OUTPUT_DIR, { recursive: true });
  }
  
  // List mode
  if (args.includes('--list')) {
    const flights = loadFlightFiles();
    console.log('\nAvailable flights:');
    flights.forEach(f => console.log(`  ${f.name}`));
    console.log(`\nTotal: ${flights.length} flights`);
    return;
  }
  
  // Check for instability flag
  const withInstability = args.includes('--instability');
  const instabilityOptions = withInstability ? {
    speedExcursionAlt: 600,
    speedExcursionKts: 25,
    speedExcursionRange: 200,
  } : null;
  
  // Filter for specific flight
  const specificFlight = args.find(a => !a.startsWith('--'));
  
  // Load flights
  let flights = loadFlightFiles();
  if (specificFlight) {
    flights = flights.filter(f => f.name.includes(specificFlight));
  }
  
  if (flights.length === 0) {
    console.error('No flights found');
    process.exit(1);
  }
  
  console.log(`\n🛬 Timeline Generator`);
  console.log(`   Flights: ${flights.length}`);
  console.log(`   Instability: ${withInstability ? 'YES' : 'NO'}\n`);
  
  const results = [];
  
  for (const flight of flights) {
    try {
      const data = loadFlight(flight.path);
      
      const { timeline, score, frameCount } = replayFlightWithTimeline(data, {
        flightId: flight.name,
        instability: instabilityOptions,
      });
      
      // Save timeline
      const outputPath = path.join(
        TIMELINE_OUTPUT_DIR, 
        `${flight.name}${withInstability ? '-unstable' : ''}-timeline.json`
      );
      fs.writeFileSync(outputPath, JSON.stringify(timeline, null, 2));
      
      console.log(`✓ ${flight.name}`);
      console.log(`    Frames: ${frameCount} | Events: ${timeline.eventCount} | Score: ${score}%`);
      console.log(`    Output: ${path.basename(outputPath)}`);
      
      results.push({
        flight: flight.name,
        score,
        frameCount,
        eventCount: timeline.eventCount,
        outputPath,
      });
      
    } catch (err) {
      console.error(`✗ ${flight.name}: ${err.message}`);
    }
  }
  
  console.log(`\n📊 Summary: ${results.length} timelines generated`);
  console.log(`   Output directory: ${TIMELINE_OUTPUT_DIR}\n`);
}

module.exports = {
  convertOpenSkyToFF,
  interpolateFrames,
  loadFlight,
  loadFlightFiles,
  replayFlightWithTimeline,
  REAL_FLIGHTS_DIR,
  TIMELINE_OUTPUT_DIR,
};

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

export {};
