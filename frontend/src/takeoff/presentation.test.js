import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTimelineEventDetailState } from '../timeline/detail-state.js';
import {
  buildTakeoffDebriefConfidence,
  buildTakeoffDebriefReasons,
  buildTakeoffPresentation,
  buildTakeoffPreview,
  createDefaultTakeoffCardState,
  takeoffGradeHex,
  takeoffGradeSeverity,
} from './presentation.js';

test('recorded Takeoff inspector preserves findings and qualifies capture time without exposing storage metadata', () => {
  const event = { type: 'marker', markerType: 'takeoff', context: {
    takeoff_id: 'internal-takeoff', event_id: 'event-1', sample_index: 123,
    roll_duration_s: 22.4, roll_duration_basis: 'capture', rotation_rate_deg_s: 2.1,
    flags: [{ severity: 'warning', label: 'Recorded runway-edge contact' }],
    takeoff_analysis: { rotation: { timeBasis: 'capture' }, assessmentContract: { id: 'takeoff-assessment', version: 1 } },
  } };
  const before = structuredClone(event);
  const state = buildTimelineEventDetailState(event);
  const rows = state.metricSections.flatMap((section) => section.rows);
  assert.equal(rows.find((row) => row.key === 'roll_duration_s').value, '22.4 (real time)');
  assert.equal(rows.find((row) => row.key === 'rotation_rate_deg_s').value, '2.10 (real time)');
  assert.match(rows.find((row) => row.key === 'flags').value, /warning: Recorded runway-edge contact/);
  assert.equal(rows.some((row) => ['takeoff_id', 'event_id', 'sample_index', 'takeoff_analysis', 'roll_duration_basis'].includes(row.key)), false);
  assert.deepEqual(event, before, 'presentation must preserve recorded metadata');
});

test('recorded Takeoff inspector qualifies physical position, airborne intervals and observed height source', () => {
  for (const [heightSource, reached, expectedLabel] of [
    ['radio', true, 'Radio-height target (ft)'],
    ['baro', true, 'Height-gain target from liftoff (ft)'],
    ['plane', true, 'Geometric height-gain target from liftoff (ft)'],
    ['radio', false, 'Radio-height target (ft)'],
    [undefined, undefined, 'Screen-height target (ft)'],
  ]) {
    const event = { type: 'marker', markerType: 'takeoff', context: {
      roll_distance_ft: 4400, hop_count: 1, runway_used_pct: 80,
      liftoff_distance_ft: 4800, runway_remaining_ft: 1200, max_pitch_deg: 14,
      screen_height_ft: 35, screen_height_remaining_ft: 400,
      takeoff_analysis: { screenHeight: { heightSource, reached } },
    } };
    const before = structuredClone(event);
    const rows = buildTimelineEventDetailState(event).metricSections.flatMap((section) => section.rows);
    assert.equal(rows.find((row) => row.key === 'screen_height_ft').label, expectedLabel);
    assert.equal(rows.find((row) => row.key === 'runway_used_pct').label, 'Liftoff position (% from runway start)');
    assert.equal(rows.find((row) => row.key === 'roll_distance_ft').label, 'Distance to final liftoff including airborne intervals (ft)');
    assert.equal(rows.find((row) => row.key === 'max_pitch_deg').label, 'Max pitch during capture (deg)');
    const observation = rows.find((row) => row.key === 'screen_height_observation');
    if (reached === undefined) assert.equal(observation, undefined, 'unknown legacy observation is not inferred');
    else assert.equal(observation.value, reached ? 'Observed' : 'Not observed during capture');
    if (reached === false) assert.equal(rows.find((row) => row.key === 'screen_height_remaining_ft').value, '--');
    assert.deepEqual(event, before, 'display qualifications never change the recording');
  }
});

function scoredTakeoff(overrides = {}) {
  return {
    type: 'takeoff',
    final: true,
    timestampMs: 1_700_000_000_000,
    icao: 'YSCB',
    runway: '35',
    grade: 'Good',
    score: 95,
    zone: 'Comfortable margin',
    assessment: 'normal',
    runwayExcursion: false,
    hopCount: 0,
    runwayUse: {
      grade: 'Good', score: 95, zone: 'Comfortable margin',
      liftoffDistanceFt: 4000, remainingFt: 2000, usedPct: 66.7, runwayLengthFt: 6000, beyondRunwayEnd: false,
    },
    roll: { distanceFt: 3800, durationS: 30, startSource: 'standstill', distanceSource: 'runway_projection' },
    liftoff: { iasKts: 140, gsKts: 138, pitchDeg: 8.7, bankDeg: 0.2, headingTrueDeg: 360, flapsNotch: 1 },
    screenHeight: { heightFt: 35, basis: 'transport_35ft', reached: true, elapsedS: 4.2, distanceFt: 5000, remainingFt: 1000, beyondRunwayEnd: false },
    rotation: { rateDegS: 2.6, maxPitchDeg: 12.1, liftoffPitchDeg: 8.7 },
    lateral: { liftoffOffsetFt: 6, liftoffOffsetSide: 'center', score: 100, grade: 'Perfect', verified: true },
    heading: { liftoffDeviationDeg: 1.2, liftoffDeviationSide: 'right' },
    flags: [],
    crosswind: 8,
    windSpeed: 8,
    windDirectionTrueDeg: 90,
    runwayHdg: 360,
    finalizeReason: 'airborne',
    ...overrides,
  };
}

test('rounded zero runway remaining does not invent an overrun', () => {
  const message = scoredTakeoff({ runwayUse: { remainingFt: 0, beyondRunwayEnd: false } });
  assert.equal(buildTakeoffPresentation(message).runwayUse.remainingText, '0 ft');
  message.runwayUse.beyondRunwayEnd = true;
  assert.equal(buildTakeoffPresentation(message).runwayUse.remainingText, '0 ft past end');
});

test('grades map to the same severity ladder the landing card uses', () => {
  assert.equal(takeoffGradeSeverity('Outstanding'), 0);
  assert.equal(takeoffGradeSeverity('Good'), 0);
  assert.equal(takeoffGradeSeverity('Acceptable'), 1);
  assert.equal(takeoffGradeSeverity('Late Liftoff'), 2);
  assert.equal(takeoffGradeSeverity('Dangerous'), 3);
  assert.equal(takeoffGradeSeverity('overrun'), 3, 'case-insensitive');
  assert.equal(takeoffGradeSeverity('Unknown'), -1);
  assert.equal(takeoffGradeHex(3), '#ef4444');
  assert.equal(takeoffGradeHex(-1), '#4a5e74');
});

test('a scored takeoff renders every fact as text with a tone', () => {
  const card = buildTakeoffPresentation(scoredTakeoff(), { previousNonce: 3 });
  assert.equal(card.gradeAnimationNonce, 4);
  assert.equal(card.capturedAtMs, 1_700_000_000_000);
  assert.equal(card.gradeText, 'GOOD');
  assert.equal(card.gradeColor, '#10b981');
  assert.equal(card.gradeDetailText, 'Comfortable margin');
  assert.equal(card.scoreText, 'Recorded runway-use score 95%');
  assert.equal(card.airportText, 'YSCB');
  assert.equal(card.runwayText, 'RWY 35');
  assert.equal(card.runwayUse.remainingText, '2,000 ft');
  assert.equal(card.runwayUse.remainingTone, 'text-green-400');
  assert.equal(card.runwayUse.usedText, '67% from runway start');
  assert.equal(card.runwayUse.liftoffDistanceText, '4,000 ft');
  assert.equal(card.runwayUse.runwayLengthText, '6,000 ft');
  assert.equal(card.roll.distanceText, '3,800 ft');
  assert.equal(card.roll.durationText, '30 s');
  assert.equal(card.roll.startNoteText, 'From low speed (8 kt or less)');
  assert.equal(card.liftoff.iasText, '140 kt');
  assert.equal(card.liftoff.gsText, 'GS: 138');
  assert.equal(card.liftoff.pitchText, '+8.7 deg');
  assert.equal(card.liftoff.flapsText, 'Flaps 1');
  assert.equal(card.liftoff.hopText, 'None observed');
  assert.equal(card.climb.screenText, '1,000 ft left');
  assert.match(card.climb.screenDetailText, /Runway left at 35 ft · 4\.2 s after liftoff/);
  assert.equal(card.climb.rotationText, '2.6 deg/s');
  assert.equal(card.climb.rotationDetailText, 'Measured average to liftoff');
  assert.equal(card.climb.maxPitchText, '+12.1 deg');
  assert.equal(card.alignment.lateralText, '6 ft');
  assert.equal(card.alignment.lateralGradeText, 'Recorded grade: Perfect');
  assert.equal(card.alignment.lateralGradeTone, 'text-green-400');
  assert.equal(card.alignment.headingText, '1.2 deg R');
  assert.equal(card.alignment.headingGradeText, 'Measured at liftoff');
  assert.equal(card.alignment.crosswindText, '8 kt R');
  assert.equal(card.wind.available, true);
  assert.match(card.wind.ariaLabel, /^Wind at liftoff/);
  assert.equal(card.debrief.confidenceText, 'High');
  assert.deepEqual(card.debrief.reasons.map((reason) => reason.text), [
    'Lifted off on the centerline',
  ]);
  assert.equal(card.excursionVisible, false);
});

test('an overrun keeps the runway-end facts explicit and never reads as praise', () => {
  const card = buildTakeoffPresentation(scoredTakeoff({
    grade: 'Overrun',
    score: 0,
    zone: 'Lifted off beyond runway end',
    assessment: 'critical',
    runwayUse: { grade: 'Overrun', score: 0, zone: 'Lifted off beyond runway end', liftoffDistanceFt: 6120, remainingFt: -120, usedPct: 102, runwayLengthFt: 6000, beyondRunwayEnd: true },
    screenHeight: { heightFt: 35, reached: true, elapsedS: 5.1, distanceFt: 6900, remainingFt: -900, beyondRunwayEnd: true },
    flags: [{ code: 'liftoff_beyond_runway_end', label: 'Lifted off beyond the runway end', severity: 'critical' }],
    lateral: { liftoffOffsetFt: 30, liftoffOffsetSide: 'left', score: 95, grade: 'Good', verified: true },
  }));
  assert.equal(card.gradeText, 'OVERRUN');
  assert.equal(card.gradeColor, '#ef4444');
  assert.equal(card.runwayUse.remainingText, '120 ft past end');
  assert.equal(card.runwayUse.remainingTone, 'text-red-400');
  assert.equal(card.climb.screenText, '900 ft past end');
  assert.equal(card.climb.screenTone, 'text-gray-100');
  assert.match(card.climb.screenDetailText, /reached beyond the runway end/);
  assert.equal(card.debrief.reasons[0].text, 'Lifted off beyond the runway end');
  assert.equal(card.debrief.reasons[0].tone, 'danger');
  assert.equal(card.debrief.reasons.length, 1, 'the grade is already shown in the summary');
  assert.ok(!card.debrief.reasons.some((reason) => reason.tone === 'good'), 'praise stays off a critical debrief');
  assert.equal(card.alignment.lateralGradeText, 'Recorded grade: Good', 'the saved grade remains visible in the metrics');
});

test('missing geometry is reported as unavailable, not as a good takeoff', () => {
  const card = buildTakeoffPresentation(scoredTakeoff({
    grade: 'Unknown',
    score: null,
    zone: 'Runway geometry unavailable',
    runway: null,
    runwayUse: { grade: 'Unknown', score: null, zone: 'Runway geometry unavailable', liftoffDistanceFt: null, remainingFt: null, usedPct: null, runwayLengthFt: null, beyondRunwayEnd: false },
    roll: { distanceFt: 3810, durationS: 29.6, startSource: 'runway_aligned', distanceSource: 'position_delta' },
    screenHeight: { heightFt: 35, reached: false, elapsedS: null, distanceFt: null, remainingFt: null, beyondRunwayEnd: false },
    lateral: { liftoffOffsetFt: null, liftoffOffsetSide: null, score: null, grade: 'Unverified', verified: false },
    heading: { liftoffDeviationDeg: null, liftoffDeviationSide: null },
    crosswind: null,
    finalizeReason: 'timeout_no_height',
  }));
  assert.equal(card.gradeText, 'NO GRADE');
  assert.equal(card.gradeColor, '#4a5e74');
  assert.equal(card.scoreText, '');
  assert.equal(card.runwayText, '--');
  assert.equal(card.runwayUse.remainingText, '-- ft');
  assert.equal(card.runwayUse.remainingDetailText, 'Runway geometry unavailable');
  assert.equal(card.runwayUse.usedText, '--');
  assert.equal(card.roll.distanceText, '3,810 ft');
  assert.equal(card.roll.startNoteText, 'Rolling start; measured from runway alignment');
  assert.equal(card.climb.screenText, 'Not observed');
  assert.equal(card.alignment.lateralText, '-- ft');
  assert.equal(card.alignment.lateralGradeText, 'Unverified');
  assert.equal(card.alignment.headingText, '-- deg');
  assert.equal(card.alignment.crosswindText, '-- kt');
  assert.equal(card.debrief.confidenceText, 'Low');
  assert.match(card.debrief.confidenceReason, /No runway geometry/);
  assert.match(card.debrief.confidenceReason, /Capture ended after a timeout/);
  assert.equal(card.debrief.visible, true);
});

test('settle-backs, late liftoff and rapid rotation escalate their tiles', () => {
  const card = buildTakeoffPresentation(scoredTakeoff({
    grade: 'Late Liftoff',
    zone: 'Little runway remaining',
    hopCount: 2,
    runwayUse: { grade: 'Late Liftoff', score: 55, zone: 'Little runway remaining', liftoffDistanceFt: 5700, remainingFt: 300, usedPct: 95, runwayLengthFt: 6000, beyondRunwayEnd: false },
    rotation: { rateDegS: 5.4, maxPitchDeg: 14 },
    flags: [
      { code: 'late_liftoff', label: 'Late liftoff with little runway remaining', severity: 'caution' },
      { code: 'settled_after_liftoff', label: 'Settled back onto the runway 2 times after lifting off', severity: 'caution' },
      { code: 'rapid_rotation', label: 'Rapid rotation', severity: 'caution' },
    ],
  }));
  assert.equal(card.gradeText, 'LATE LIFTOFF');
  assert.equal(card.gradeColor, '#fb923c');
  assert.equal(card.runwayUse.remainingTone, 'text-orange-400');
  assert.equal(card.liftoff.hopText, '2x');
  assert.equal(card.liftoff.hopTone, 'text-amber-400');
  assert.equal(card.liftoff.hopDetailText, 'Settled back 2 times');
  assert.equal(card.climb.rotationTone, 'text-amber-400');
  assert.equal(card.climb.rotationDetailText, 'Measured average to liftoff');
  const tones = card.debrief.reasons.map((reason) => reason.tone);
  assert.deepEqual(tones, ['warning', 'warning', 'warning'], 'recorded cautions stay visible without a duplicate grade tag');
});

test('a smoother final rotation keeps the earlier liftoff caution and peak pitch visible', () => {
  const card = buildTakeoffPresentation(scoredTakeoff({
    rotation: { rateDegS: 2.6, priorMaxRateDegS: 12, maxPitchDeg: 18 },
    flags: [{ code: 'rapid_rotation', label: 'Rapid rotation during an earlier liftoff', severity: 'caution' }],
    hopCount: 1,
  }));
  assert.equal(card.climb.rotationText, '2.6 deg/s', 'the final rotation measurement remains distinct');
  assert.equal(card.climb.rotationTone, 'text-amber-400');
  assert.equal(card.climb.rotationDetailText, 'Measured average to liftoff · Earlier liftoff: 12.0 deg/s');
  assert.equal(card.climb.maxPitchText, '+18.0 deg');
  assert.ok(card.debrief.reasons.some((reason) => reason.text === 'Rapid rotation during an earlier liftoff'));
  assert.ok(!card.debrief.reasons.some((reason) => reason.text === 'Steady rotation'));
});

test('debrief helpers stay honest on empty input', () => {
  assert.deepEqual(buildTakeoffDebriefReasons(null), []);
  assert.equal(buildTakeoffDebriefConfidence({}).confidenceText, 'Low');
  const empty = buildTakeoffPresentation(null);
  assert.deepEqual(empty, createDefaultTakeoffCardState());
});

test('new takeoffs show neutral measurements without runway points or generic rotation judgments', () => {
  for (const rateDegS of [1, 3, 5, 8]) {
    const card = buildTakeoffPresentation(scoredTakeoff({
      grade: 'Recorded', score: null, zone: 'Observed runway remaining',
      runwayUse: { grade: 'Recorded', score: null, remainingFt: 2000, verified: true },
      rotation: { rateDegS, priorMaxRateDegS: 12, maxPitchDeg: 18 },
    }));
    assert.equal(card.gradeText, 'RECORDED');
    assert.equal(card.gradeLabel, 'Takeoff record');
    assert.equal(card.scoreText, '');
    assert.equal(card.runwayUse.remainingTone, 'text-gray-100');
    assert.equal(card.climb.rotationTone, 'text-gray-100');
    assert.equal(card.climb.rotationDetailText, 'Measured average to liftoff · Earlier liftoff: 12.0 deg/s');
    assert.ok(!card.debrief.reasons.some((reason) => /rotation|runway use/i.test(reason.text)));
  }
});

test('an uncertain runway-end position remains explicit in the report and Overview', () => {
  const card = buildTakeoffPresentation(scoredTakeoff({
    grade: 'Unknown', score: null, zone: 'Liftoff position uncertain at runway end',
    runwayUse: { remainingFt: null, liftoffDistanceFt: null, verified: true, notScoredReason: 'liftoff_position_uncertain' },
    flags: [{ code: 'liftoff_position_uncertain', label: 'Liftoff position uncertain at the runway end', severity: 'caution' }],
  }));
  const preview = buildTakeoffPreview(card, { available: true });
  assert.equal(card.runwayUse.remainingText, 'Uncertain');
  assert.equal(card.debrief.confidenceText, 'Low');
  assert.equal(preview.remaining, 'Uncertain');
  assert.match(card.debrief.confidenceReason, /Liftoff position uncertain/);
  assert.doesNotMatch(card.debrief.confidenceReason, /No runway geometry/);
  assert.match(preview.assessment, /Liftoff position uncertain/);
  assert.notEqual(preview.assessmentTone, 'text-danger');
});

test('the Overview preview derives from the same card state', () => {
  const waiting = buildTakeoffPreview(createDefaultTakeoffCardState(), { available: false });
  assert.equal(waiting.available, false);
  assert.equal(waiting.status, 'Waiting for liftoff in this session.');
  const pending = buildTakeoffPreview(createDefaultTakeoffCardState(), { available: false, pending: true });
  assert.match(pending.status, /Measuring the climb-out/);

  const card = buildTakeoffPresentation(scoredTakeoff());
  const preview = buildTakeoffPreview(card, { available: true });
  assert.equal(preview.available, true);
  assert.equal(preview.grade, 'GOOD');
  assert.equal(preview.remaining, '2,000 ft');
  assert.equal(preview.remainingDetail, 'Comfortable margin');
  assert.equal(preview.roll, '3,800 ft');
  assert.equal(preview.liftoff, '140 kt');
  assert.equal(preview.screen, '1,000 ft left');
  assert.equal(preview.runway, 'YSCB 35');
});

test('Overview keeps critical findings beside a high runway-use score and carries incomplete confidence', () => {
  const card = buildTakeoffPresentation(scoredTakeoff({
    grade: 'Outstanding', score: 100, assessment: 'critical', runwayExcursion: true,
    flags: [{ code: 'runway_excursion', label: 'Runway excursion during the takeoff roll', severity: 'critical' }],
    screenHeight: { heightFt: 35, reached: false }, finalizeReason: 'telemetry_gap',
  }));
  const preview = buildTakeoffPreview(card, { available: true });
  assert.equal(preview.grade, 'OUTSTANDING');
  assert.match(preview.assessment, /Runway excursion/);
  assert.equal(preview.assessmentTone, 'text-danger');
  assert.match(preview.confidence, /Low confidence.*Telemetry gap/);
  assert.ok(!card.debrief.reasons.some((reason) => reason.tone === 'good'));
});

test('unverified runway use remains qualified in the preview', () => {
  const card = buildTakeoffPresentation(scoredTakeoff({
    grade: 'Unknown', score: null,
    runwayUse: { remainingFt: -1000, verified: false, zone: 'Runway geometry unverified' },
    lateral: { verified: false }, heading: { liftoffDeviationDeg: 25 },
  }));
  const preview = buildTakeoffPreview(card, { available: true });
  assert.equal(preview.grade, 'NO GRADE');
  assert.match(preview.confidence, /Low confidence.*geometry unverified/);
  assert.equal(preview.remainingTone, 'text-gray-100');
  assert.equal(card.alignment.headingTone, 'text-gray-100');
  assert.equal(card.alignment.headingGradeText, 'Unverified');
});

test('runway remaining without a recorded zone identifies when it was measured', () => {
  const card = buildTakeoffPresentation(scoredTakeoff({ zone: null, runwayUse: { remainingFt: 1500 } }));
  assert.equal(card.runwayUse.remainingDetailText, 'At liftoff');
  assert.equal(buildTakeoffPreview(card, { available: true }).remainingDetail, 'At liftoff');
});

test('liftoff alignment stays neutral and recorded ground findings remain explicit', () => {
  for (const deviation of [0, 5, 15, 25]) {
    const card = buildTakeoffPresentation(scoredTakeoff({
      grade: 'Recorded', score: null,
      lateral: { liftoffOffsetFt: 90, liftoffOffsetSide: 'right', score: null, grade: 'Recorded', verified: true },
      heading: { liftoffDeviationDeg: deviation, liftoffDeviationSide: 'right' },
      flags: [{ code: 'heading_deviation', label: 'Major runway-heading deviation during the roll', severity: 'warning' }],
    }));
    assert.equal(card.alignment.headingTone, 'text-gray-100');
    assert.equal(card.alignment.headingGradeText, 'Measured at liftoff');
    assert.equal(card.alignment.lateralText, '90 ft R');
    assert.equal(card.alignment.lateralGradeText, 'Measured at liftoff');
    assert.equal(card.alignment.lateralTone, 'text-gray-100');
    assert.match(buildTakeoffPreview(card, { available: true }).assessment, /deviation during the roll/);
    assert.ok(card.debrief.reasons.some((reason) => reason.tone === 'danger'));
  }
});

test('one unconfirmed ground-contact indication never reads as a clean departure', () => {
  const card = buildTakeoffPresentation(scoredTakeoff({
    grade: 'Recorded', score: null, hopCount: 0,
    flags: [{ code: 'ground_contact_uncertain', label: 'Brief ground-contact indication; contact not confirmed', severity: 'caution' }],
  }));
  assert.equal(card.liftoff.hopText, 'Uncertain');
  assert.match(card.liftoff.hopDetailText, /not confirmed/);
  assert.equal(card.debrief.confidenceText, 'Medium');
  assert.match(buildTakeoffPreview(card, { available: true }).assessment, /not confirmed/);
});

test('confidence evaluates each capture limitation separately and the lowest confidence wins', () => {
  for (const [overrides, expected, reason] of [
    [{}, 'High', ''],
    [{ roll: { startSource: 'runway_aligned' } }, 'Medium', 'Rolling start'],
    [{ lateral: { verified: false } }, 'Medium', 'alignment unverified'],
    [{ screenHeight: { reached: false } }, 'Medium', 'screen height not observed'],
    [{ finalizeReason: 'timeout' }, 'Medium', 'timeout'],
    [{ finalizeReason: 'telemetry_gap' }, 'Low', 'Telemetry gap'],
    [{ runwayUse: { remainingFt: null } }, 'Low', 'No runway geometry'],
    [{ runwayUse: { remainingFt: 2000, verified: false } }, 'Low', 'geometry unverified'],
    [{ roll: { startSource: 'runway_aligned' }, finalizeReason: 'telemetry_gap' }, 'Low', 'Telemetry gap'],
  ]) {
    const confidence = buildTakeoffDebriefConfidence(scoredTakeoff(overrides));
    assert.equal(confidence.confidenceText, expected);
    assert.ok(confidence.confidenceReason.includes(reason));
  }
});

test('a recovered ground-edge event remains visible beside neutral liftoff measurements', () => {
  const card = buildTakeoffPresentation(scoredTakeoff({
    grade: 'Recorded', score: null, assessment: 'warning',
    runwayUse: { remainingFt: 2000, grade: 'Recorded', score: null, verified: true },
    lateral: { liftoffOffsetFt: 0, maxOffsetFt: 90, grade: 'Recorded', score: null, verified: true },
    flags: [{ code: 'lateral_offset', label: 'Ground contact outside the runway reference edge', severity: 'warning' }],
  }));
  assert.equal(card.alignment.lateralText, '0 ft');
  assert.match(card.assessmentText, /outside the runway reference edge/);
  assert.equal(card.assessmentTone, 'text-danger');
  assert.match(buildTakeoffPreview(card, { available: true }).assessment, /outside the runway reference edge/);
  assert.ok(!card.debrief.reasons.some(reason => reason.tone === 'good'));
});

test('capture-time fallback and airborne settle-back intervals are qualified without changing legacy measurements', () => {
  const card = buildTakeoffPresentation(scoredTakeoff({
    hopCount: 1,
    roll: { distanceFt: 4400, durationS: 35, durationBasis: 'capture', startSource: 'standstill' },
    rotation: { rateDegS: 2.5, timeBasis: 'capture' },
    screenHeight: { heightFt: 35, reached: true, elapsedS: 4, remainingFt: 2000, timeBasis: 'capture' },
  }));
  assert.equal(card.roll.durationText, '35 s (real time)');
  assert.match(card.roll.startNoteText, /Includes airborne intervals/);
  assert.match(card.climb.rotationDetailText, /real time/);
  assert.match(card.climb.screenDetailText, /Time measured in real time/);
  const simulator = buildTakeoffPresentation(scoredTakeoff({ rotation: { rateDegS: 2.5, timeBasis: 'simulator' } }));
  assert.equal(simulator.climb.rotationDetailText, 'Measured average to liftoff');
});

test('specific findings are deduplicated and serious findings stay ahead of the reason limit', () => {
  const flags = [
    ...Array.from({ length: 6 }, (_, index) => ({ code: `context_${index}`, label: `Recorded caution ${index}`, severity: 'caution' })),
    { code: 'edge', label: 'Earlier edge caution', severity: 'caution' },
    { code: 'edge', label: 'Ground contact outside the runway reference edge', severity: 'warning' },
    { code: 'end', label: 'Ground contact beyond the runway end', severity: 'critical' },
  ];
  const message = scoredTakeoff({ flags, assessment: 'critical' });
  const before = structuredClone(message);
  const card = buildTakeoffPresentation(message);
  assert.deepEqual(card.debrief.reasons.slice(0, 2).map((reason) => reason.text), [
    'Ground contact beyond the runway end', 'Ground contact outside the runway reference edge',
  ]);
  assert.equal(card.debrief.reasons.length, 6);
  assert.doesNotMatch(card.assessmentText, /Earlier edge caution/);
  assert.ok(!card.debrief.reasons.some((reason) => /runway use|centerline/.test(reason.text)));
  assert.deepEqual(message, before, 'display ordering does not change the recorded assessment');

  const serious = Array.from({ length: 7 }, (_, index) => ({ code: `warning_${index}`, label: `Warning ${index}`, severity: 'warning' }));
  assert.equal(buildTakeoffDebriefReasons(scoredTakeoff({ flags: serious })).length, 7, 'a display limit never hides a serious finding');
});

test('a recorded serious assessment without matching flags remains visible in the full debrief', () => {
  for (const flags of [[],
    [{ code: 'climb_incomplete', label: 'Screen height not observed', severity: 'caution' }],
    [{ code: 'missing_label', label: '   ', severity: 'critical' }],
  ]) {
    const card = buildTakeoffPresentation(scoredTakeoff({ grade: 'Recorded', score: null, assessment: 'critical', flags }));
    assert.equal(card.debrief.visible, true);
    assert.equal(card.debrief.reasons[0].text, 'Critical assessment recorded');
    assert.equal(card.debrief.reasons[0].tone, 'danger');
    assert.match(card.assessmentText, /^Critical assessment recorded/);
    assert.equal(card.assessmentTone, 'text-danger');
  }
});

test('incomplete observation does not claim a clean departure or uninterrupted flight', () => {
  for (const overrides of [
    { screenHeight: { heightFt: 35, reached: false } },
    { finalizeReason: 'telemetry_gap' },
    { finalizeReason: 'timeout_no_height' },
  ]) {
    const card = buildTakeoffPresentation(scoredTakeoff(overrides));
    assert.equal(card.liftoff.hopText, 'None observed');
    assert.match(card.liftoff.hopDetailText, /capture incomplete/);
    assert.equal(card.liftoff.hopDetailTone, 'text-gray-500');
    assert.doesNotMatch(card.liftoff.hopDetailText, /Stayed airborne|Clean/);
    assert.equal(card.climb.maxPitchIntervalText, 'During capture');
  }
  const complete = buildTakeoffPresentation(scoredTakeoff());
  assert.equal(complete.liftoff.hopDetailText, 'No confirmed ground contacts during capture');
  assert.equal(complete.climb.maxPitchIntervalText, 'During capture', 'confirmation can continue beyond screen height');
});

test('a repeated liftoff keeps timing provenance and labels airborne intervals as takeoff distance', () => {
  const card = buildTakeoffPresentation(scoredTakeoff({
    hopCount: 1,
    rotation: { rateDegS: 2.5, priorMaxRateDegS: 5.4, timeBasis: 'capture' },
  }));
  assert.equal(card.roll.label, 'Distance to final liftoff');
  assert.match(card.roll.startNoteText, /Includes airborne intervals/);
  assert.equal(card.climb.rotationDetailText, 'Measured average in real time to liftoff · Earlier liftoff: 5.4 deg/s');
  assert.equal(buildTakeoffPreview(card, { available: true }).rollLabel, 'Distance to final liftoff');
  assert.equal(buildTakeoffPresentation(scoredTakeoff()).roll.label, 'Ground roll');
});

test('screen-height display distinguishes radio height, geometric gain and recorded barometric gain', () => {
  for (const [heightSource, label, detail] of [
    ['radio', 'Screen height', '35 ft radio height'],
    ['baro', 'Height gained', '35 ft height gained since liftoff'],
    ['plane', 'Height gained', '35 ft geometric height gained since liftoff'],
    [undefined, 'Screen height', '35 ft'],
  ]) {
    const card = buildTakeoffPresentation(scoredTakeoff({
      screenHeight: { heightFt: 35, heightSource, reached: true, elapsedS: 4, remainingFt: 1000 },
    }));
    assert.equal(card.climb.screenLabel, label);
    assert.ok(card.climb.screenDetailText.includes(detail));
    assert.equal(buildTakeoffPreview(card, { available: true }).screenLabel, label);
    assert.equal(buildTakeoffPreview(card, { available: true }).screenDetail, card.climb.screenDetailText, 'Overview preserves the height reference beside the runway distance');
    if (!heightSource) assert.doesNotMatch(card.climb.screenDetailText, /radio height|height gained/);
  }
});

test('a negative measured liftoff pitch alone does not manufacture an aircraft-independent caution', () => {
  const card = buildTakeoffPresentation(scoredTakeoff({
    grade: 'Recorded', score: null,
    liftoff: { pitchDeg: -0.5 }, lateral: { grade: 'Recorded', verified: true },
  }));
  assert.equal(card.liftoff.pitchText, '-0.5 deg');
  assert.equal(card.liftoff.pitchTone, 'text-gray-100');
  assert.equal(card.assessmentText, '');
  assert.deepEqual(card.debrief.reasons, []);
});
