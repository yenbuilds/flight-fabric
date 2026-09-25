import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTakeoffDebriefConfidence,
  buildTakeoffDebriefReasons,
  buildTakeoffPresentation,
  buildTakeoffPreview,
  createDefaultTakeoffCardState,
  takeoffGradeHex,
  takeoffGradeSeverity,
} from './presentation.js';

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
  assert.equal(card.runwayUse.usedText, '67% of runway used');
  assert.equal(card.runwayUse.liftoffDistanceText, '4,000 ft');
  assert.equal(card.runwayUse.runwayLengthText, '6,000 ft');
  assert.equal(card.roll.distanceText, '3,800 ft');
  assert.equal(card.roll.durationText, '30 s');
  assert.equal(card.roll.startNoteText, 'From standstill');
  assert.equal(card.liftoff.iasText, '140 kt');
  assert.equal(card.liftoff.gsText, 'GS: 138');
  assert.equal(card.liftoff.pitchText, '+8.7 deg');
  assert.equal(card.liftoff.flapsText, 'Flaps 1');
  assert.equal(card.liftoff.hopText, 'Clean');
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
    'Good runway use',
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
  assert.equal(card.debrief.reasons[0].text, 'Overrun runway use');
  assert.equal(card.debrief.reasons[0].tone, 'danger');
  assert.equal(card.debrief.reasons[1].text, 'Lifted off beyond the runway end');
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
  assert.deepEqual(tones.slice(0, 4), ['warning', 'warning', 'warning', 'warning'], 'a late liftoff is a caution, never styled as a failure');
  assert.equal(card.debrief.reasons[0].color, '#fb923c', 'the grade tag matches the orange headline');
});

test('a smoother final rotation keeps the earlier liftoff caution and peak pitch visible', () => {
  const card = buildTakeoffPresentation(scoredTakeoff({
    rotation: { rateDegS: 2.6, priorMaxRateDegS: 12, maxPitchDeg: 18 },
    flags: [{ code: 'rapid_rotation', label: 'Rapid rotation during an earlier liftoff', severity: 'caution' }],
    hopCount: 1,
  }));
  assert.equal(card.climb.rotationText, '2.6 deg/s', 'the final rotation measurement remains distinct');
  assert.equal(card.climb.rotationTone, 'text-amber-400');
  assert.equal(card.climb.rotationDetailText, 'Earlier liftoff: 12.0 deg/s');
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
    assert.equal(card.climb.rotationDetailText, 'Earlier liftoff: 12.0 deg/s');
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
