import '../../../shared/violation-rules.js';
const { VIOLATION_RULE } = globalThis.FlightFabricViolationRules;
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimelineEventRowState } from './events.js';
import { buildTimelineSummaryState } from './model.js';
import { buildTimelineEventDetailState } from './detail-state.js';
import { getTimelineEventMarkerVisual } from './map.js';
import { getStabilityContextSummary, getStabilityMetricPresentation } from '../landing/stability-context.js';
import { buildLandingPresentation } from '../landing/scoring.js';
import { buildLandingDetailSections } from './landing-detail.js';
import { buildDebriefConfidence, buildDebriefReasons } from '../landing/debrief-insights.js';
import { createPinia, setActivePinia } from 'pinia';
import { useLandingStore } from '../vue/stores/landing.js';
import { useFlightStore } from '../vue/stores/flight.js';

const v4Result = (severity = 'caution') => ({
  score: 98, samples: 20, verdict: severity === 'warning' ? 'unstable' : 'marginal', gateStable: false,
  gateFailures: [severity === 'warning' ? 'approach_warning' : 'approach_caution'],
  breakdown: { config_ok: 100, vs_ok: 92, glideslope_ok: 100, localizer_ok: 100 },
  scoringContext: { schemaVersion: 4, policy: { id: 'transport-v4', version: 4 }, profile: { id: 'pmdg-737' },
    criteria: { gateRaFt: 1000, passPct: 80 }, assessment: { version: 4, rules: { lowHeightFt: 500 },
      window: { observedDurationMs: 20000, coverage: 1 }, episodes: [{ severity }], groups: {} } },
});

test('amber cautions, red violations and neutral endings agree across timeline and map', () => {
  const amber = { type: 'violation_start', ruleId: VIOLATION_RULE.HIGH_SINK_RATE, severity: 'caution', timestampMs: 1000 };
  const red = { ...amber, severity: 'warning' };
  const end = { ...red, type: 'violation_end' };
  assert.equal(buildTimelineEventRowState(amber, 0, 0).type, 'caution');
  assert.equal(buildTimelineEventRowState(red, 0, 0).type, 'violation');
  assert.equal(buildTimelineEventRowState(end, 0, 0).type, 'recovery');
  assert.equal(getTimelineEventMarkerVisual(amber).border, '#fbbf24');
  assert.equal(getTimelineEventMarkerVisual(red).border, '#f87171');
  assert.equal(getTimelineEventMarkerVisual(end).border, '#94a3b8');
  assert.equal(buildTimelineEventDetailState(amber).type, 'Caution');
});

test('summary counts cautions separately and never counts recovery as another violation', () => {
  const events = [
    { type: 'violation_start', ruleId: 'a', severity: 'caution', timestampMs: 1000 },
    { type: 'violation_start', ruleId: 'b', severity: 'warning', timestampMs: 2000 },
    { type: 'violation_end', ruleId: 'a', severity: 'caution', timestampMs: 3000 },
    { type: 'violation_end', ruleId: 'b', severity: 'warning', timestampMs: 4000 },
  ];
  const summary = buildTimelineSummaryState({ events }, events);
  assert.equal(summary.cautionCountText, '1'); assert.equal(summary.violationCountText, '1');
});

test('new episodes explain breach time, recovery, height and signal source', () => {
  const event = { type: 'violation_start', ruleId: 'approach_vertical_profile', severity: 'caution', timestampMs: 1000,
    context: { assessment_version: 4, start_height_ft: 998, end_height_ft: 680, altitude_source: 'plane',
      duration_ms: 19000, threshold_exceedance_duration_ms: 6100, reasons: [VIOLATION_RULE.HIGH_SINK_RATE, 'steep_path_rate'],
      peak_sink_rate_fpm: -1171, end_reason: 'recovered' } };
  const row = buildTimelineEventRowState(event, 0, 0);
  assert.match(row.subtitle, /998 ft AAL/); assert.match(row.subtitle, /6\.1s outside limits/);
  assert.match(row.subtitle, /High sink rate \+ Steep path rate/);
  const details = buildTimelineEventDetailState(event).metricSections[0].rows;
  assert.ok(details.some(r => r.label === 'Episode including recovery' && r.value === '19.0s'));
  assert.ok(details.some(r => r.label === 'Time outside alert limits' && r.value === '6.1s'));
  const gap = buildTimelineEventRowState({ ...event, type: 'violation_end', context: { ...event.context, end_reason: 'data_gap' } }, 0, 0);
  assert.match(gap.title, /telemetry gap/); assert.doesNotMatch(gap.title, /recovered/);
});

test('v4 score explanations disclose grouped deductions and graded bands without rewriting legacy copy', () => {
  const context = { policy: { version: 4, name: 'Common transport rules' }, profile: { id: 'pmdg-737', name: 'PMDG 737' },
    criteria: { gateRaFt: 1000, glidepathAngleDeg: 3, glidepathVsDeltaMaxFpm: 200 }, reference: { altitudeSource: 'plane' },
    assessment: { version: 4, rules: { lowHeightFt: 500, lowHeightWeight: 1.5, flareHeightFt: 50, pathCautionMarginFpm: 200 },
      groups: { vertical: { score: 89, pointsLost: 2.75 } } } };
  const summary = getStabilityContextSummary(context);
  assert.match(summary.detail, /elapsed time/); assert.match(summary.detail, /Vertical profile −2\.8/);
  const presentation = getStabilityMetricPresentation('glidepath_ok', context);
  assert.match(presentation.criteriaText, /caution beyond 400 fpm/);
  assert.match(presentation.descriptionText, /×1\.5 below 500 ft/);
  const legacy = getStabilityMetricPresentation('glidepath_ok', { ...context, assessment: null });
  assert.match(legacy.criteriaText, /within 200 fpm/); assert.doesNotMatch(legacy.criteriaText, /caution beyond/);
});

test('v4 landing summaries, Timeline details and debrief use caution counts rather than strict-check counts', () => {
  for (const severity of ['caution', 'warning']) {
    const result = v4Result(severity);
    const event = { type: 'landing', ultimateStability: result };
    const presentation = buildLandingPresentation(event);
    assert.equal(presentation.approachVerdict, severity === 'warning' ? 'UNSTABLE' : 'MARGINAL');
    assert.match(presentation.approachDetailText, severity === 'warning' ? /1 violation/ : /1 caution/);
    assert.match(presentation.approachDetailText, /Approach score 98%/);
    assert.doesNotMatch(presentation.approachExplanation + presentation.approachDetailText, /strict|soft\/proxy/);
    const detail = buildLandingDetailSections(event).find(section => section.key === 'retrospective-stability');
    assert.ok(detail.rows.some(row => row.label === 'Approach Findings'));
    assert.ok(detail.rows.some(row => row.key === 'glideslope_ok' && row.value === '100%'));
    assert.match(detail.noteText, severity === 'warning' ? /high average score cannot hide a red violation/ : /amber caution/);
    assert.doesNotMatch(detail.noteText, /strict|soft\/proxy/);
    const reasons = buildDebriefReasons(event, { ultimateStability: result }).map(reason => reason.text).join(' ');
    assert.match(reasons, severity === 'warning' ? /Unstable approach/ : /Marginal approach - caution/);
    assert.doesNotMatch(reasons, /soft\/proxy/);
  }
});

test('v4 debrief confidence uses time coverage, not telemetry frame count', () => {
  const result = v4Result();
  const data = { touchdownDistance: { distanceFt: 800 }, lateralOffsetFt: 5 };
  assert.deepEqual(buildDebriefConfidence(data, { ...result, samples: 20 }), buildDebriefConfidence(data, { ...result, samples: 600 }));
  const legacy = buildLandingPresentation({ ultimateStability: { ...result, scoringContext: null } });
  assert.match(legacy.approachExplanation, /soft\/proxy/);
});

function recoveredSinkResult() {
  const result = v4Result();
  result.scoringContext.assessment.episodes = [3800, 5600].map(exceedanceMs => ({
    ruleId: 'approach_vertical_profile', severity: 'caution', reasons: [VIOLATION_RULE.HIGH_SINK_RATE],
    exceedanceMs, durationMs: exceedanceMs + 3000, endReason: 'recovered',
  }));
  return result;
}

test('recovered sink cautions lead with score and measured findings across shared surfaces without rescoring', () => {
  setActivePinia(createPinia());
  const result = recoveredSinkResult();
  const before = JSON.stringify(result);
  const event = { type: 'landing', final: true, vs: -169, grade: 'GOOD', ultimateStability: result,
    touchdownDistance: { distanceFt: 2065, runwayLengthFt: 11289, grade: 'Good', score: 100, tdzAchieved: true } };
  const presentation = buildLandingPresentation(event);
  const findings = '2 sink-rate exceedances · Recovered';
  assert.equal(presentation.approachText, '98%');
  assert.equal(presentation.approachDetailText, findings);
  assert.equal(presentation.approachVerdict, 'MARGINAL', 'retain the recorded assessment for detailed review');
  assert.equal(presentation.touchdownPositionText, 'Within touchdown zone');
  assert.equal(presentation.verdict.touchdown.data.score, 100);
  const landing = useLandingStore();
  landing.applyLandingCardMessage(event);
  assert.equal(landing.landingCard.approach.stabilityText, '98%');
  assert.equal(landing.landingCard.approach.stabilityNoteText, findings);
  assert.equal(landing.landingCard.touchdown.distanceGradeText, 'Within touchdown zone');
  assert.equal(landing.landingCard.touchdown.distanceGradeTone, 'text-gray-500');
  const flight = useFlightStore();
  flight.updateLandingPreview(event);
  assert.equal(flight.lastLanding.stability, '98%');
  assert.equal(flight.lastLanding.stabilityScore, findings);
  const reasons = buildDebriefReasons(event, { ultimateStability: result, touchdownDistance: event.touchdownDistance });
  assert.ok(reasons.some(reason => reason.text === findings && reason.tone === 'warning'));
  assert.ok(!reasons.some(reason => /Marginal|1,000 ft target/.test(reason.text)));
  const row = buildTimelineEventRowState(event, 0, 0);
  assert.match(JSON.stringify(row), /APP 98%/);
  assert.match(JSON.stringify(row), /sink-rate exceedances/);
  const sections = buildLandingDetailSections(event);
  assert.ok(sections.some(section => section.rows.some(row => row.key === 'approach-findings' && row.value === findings)));
  assert.ok(sections.some(section => section.rows.some(row => row.key === 'gate-stable' && row.value === 'MARGINAL')));
  assert.equal(JSON.stringify(result), before, 'presentation must not alter saved scores, episodes or verdicts');
});

test('score-led recovery presentation never hides warnings, quality failures or unknown recovery', () => {
  for (const endReason of ['window_ended', 'data_gap', 'paused', undefined]) {
    const result = recoveredSinkResult();
    result.scoringContext.assessment.episodes[1].endReason = endReason;
    assert.equal(buildLandingPresentation({ ultimateStability: result }).approachText, 'MARGINAL');
  }
  const qualityFailure = recoveredSinkResult();
  qualityFailure.gateFailures.push('glidepath_proxy_unstable_after_gate');
  assert.equal(buildLandingPresentation({ ultimateStability: qualityFailure }).approachText, 'MARGINAL');
  const warning = recoveredSinkResult();
  warning.verdict = 'unstable';
  warning.gateFailures = ['approach_warning'];
  warning.scoringContext.assessment.episodes[1].severity = 'warning';
  assert.equal(buildLandingPresentation({ ultimateStability: warning }).approachText, 'UNSTABLE');
  const unknown = { ...recoveredSinkResult(), score: null, verdict: 'no_verdict' };
  assert.equal(buildLandingPresentation({ ultimateStability: unknown }).approachText, 'NO VERDICT');
  const mixed = recoveredSinkResult();
  mixed.scoringContext.assessment.episodes[1].reasons.push('glideslope_deviation');
  assert.equal(buildLandingPresentation({ ultimateStability: mixed }).approachFindingsText, '2 cautions · Recovered');
});

test('touchdown position distinguishes short, beyond-zone, past-end and unavailable results', () => {
  for (const [distanceFt, runwayLengthFt, expected] of [
    [999, 11000, 'Within touchdown zone'], [1001, 11000, 'Within touchdown zone'],
    [3000, 11000, 'Within touchdown zone'], [3001, 11000, 'Beyond touchdown zone'],
    [-10, 11000, 'Short of threshold'], [900, 800, 'Past runway end'],
    [null, 11000, 'Position unavailable'],
  ]) {
    assert.equal(buildLandingPresentation({ touchdownDistance: { distanceFt, runwayLengthFt } }).touchdownPositionText, expected);
  }
});

test('landing card and Last Landing summary retain v4 verdicts even with a high score, and clear missing scores', () => {
  setActivePinia(createPinia());
  const landing = useLandingStore();
  const flight = useFlightStore();
  for (const result of [v4Result(), v4Result('warning'), { ...v4Result(), score: null, verdict: 'no_verdict' }]) {
    const message = { final: true, vs: -180, ultimateStability: result };
    landing.applyLandingCardMessage(message);
    flight.updateLandingPreview(message);
    const label = result.verdict.toUpperCase().replace('_', ' ');
    assert.equal(landing.landingCard.approach.stabilityText, label);
    assert.equal(flight.lastLanding.stability, label);
    assert.equal(flight.lastLanding.stabilityScore, result.score === null ? '' : 'Approach score 98%');
    assert.doesNotMatch(landing.landingCard.approach.stabilityTooltip, /strict|soft\/proxy/);
  }
});
