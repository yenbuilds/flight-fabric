const { VIOLATION_RULE } = require('../../shared/violation-rules.js') as typeof import('../../shared/violation-rules.js');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRecordedApproachAssessments } from './approach-timeline';
import { assessApproach } from './approach-assessment';
const { SimpleStabilityScorer, frameToSample, getStabilityCriteria } = require('./stability-runner');
const { resolveStabilityPolicy, buildStabilityScoringContext } = require('./stability-policy');
const { buildCanonicalStabilityFrameFromCsvRow } = require('../analysis/flight-analysis');
const START = 1789000000000;
const criteria = { ...getStabilityCriteria(), assessmentVersion: 4 };

function samplesAt(cadence: number | number[], change: (seconds: number) => Record<string, any> = () => ({})) {
  const samples = [];
  let ms = 0, index = 0, previous = 0;
  while (ms <= 110000) {
    const seconds = ms / 1000;
    samples.push(frameToSample({ timestampMs: START + ms, dtMs: ms - previous,
      raFt: 1100 - seconds * 10, altPlaneFt: 1115 - seconds * 10, iasKts: 140, gsKts: 140,
      vsFpm: -743.4, pitchDeg: 3, bankDeg: 0, thrustPct: 40,
      gearDownLocked: 1, flapsPercent: 40, onGround: false, ...change(seconds) }));
    previous = ms;
    ms += Array.isArray(cadence) ? cadence[index++ % cadence.length] : cadence;
  }
  return samples;
}

function score(samples, extra = {}) {
  const scorer = new SimpleStabilityScorer();
  samples.forEach(sample => scorer.addSample(sample));
  return scorer.getScore(15, { criteria, ...extra });
}

test('v4 transport policy is identical across airliner categories and profiles', () => {
  const policies = ['pmdg-737', 'pmdg-777', 'fenix-a32x', 'fbw-a32nx', 'fbw-a380x'].map((id, index) =>
    resolveStabilityPolicy({ profile: { id, aircraft: { category: index < 3 ? 'C' : 'D' } }, commonCriteria: getStabilityCriteria(), profileCriteria: { vsMinFpm: -9999 } }));
  for (const policy of policies) { assert.equal(policy.id, 'transport-v4'); assert.deepEqual(policy.criteria, policies[0].criteria); }
});

test('steady approach is 100 and stable at every supported sample cadence', () => {
  for (const cadence of [100, 200, 500, 1000, [100, 200, 900, 300, 500]]) {
    const result = score(samplesAt(cadence));
    assert.equal(result.score, 100); assert.equal(result.verdict, 'stable');
    assert.deepEqual(result.assessment.episodes, []);
    assert.equal(result.reference.gateHeightFt, 1000);
  }
});

test('same continuous approach scores within one point at 1–30 Hz and irregular cadence', () => {
  const change = t => ({ iasKts: 140 + 9 * Math.sin(t / 8), vsFpm: -850 + 350 * Math.sin(t / 7), thrustPct: 40 + 10 * Math.sin(t / 9) });
  const results = [33, 100, 200, 500, 1000, [100, 300, 900, 200]].map(c => score(samplesAt(c, change)));
  assert.ok(Math.max(...results.map(r => r.score)) - Math.min(...results.map(r => r.score)) <= 1, JSON.stringify(results.map(r => r.score)));
  assert.equal(new Set(results.map(r => r.verdict)).size, 1);
  assert.equal(new Set(results.map(r => r.assessment.episodes.length)).size, 1);
});

test('gate uses AAL, ignores terrain/phase and excludes preparation above it', () => {
  const result = score(samplesAt(100, t => ({ raFt: 3000 - t * 10, phase: 'DESCENT', vsFpm: t < 8 ? -2000 : -743.4 })));
  assert.equal(result.reference.altitudeSource, 'plane'); assert.equal(result.score, 100);
  assert.equal(result.assessment.window.startMs, START + 10000); assert.equal(result.assessment.episodes.length, 0);
});

test('short moderate sink and path deviation share one amber episode and one contribution', () => {
  const result = score(samplesAt(100, t => ({ vsFpm: t >= 25 && t < 32 ? -1200 : -743.4 })));
  const episodes = result.assessment.episodes;
  assert.equal(episodes.length, 1); assert.equal(episodes[0].severity, 'caution');
  assert.ok(episodes[0].reasons.includes(VIOLATION_RULE.HIGH_SINK_RATE)); assert.ok(episodes[0].reasons.includes('steep_path_rate'));
  assert.equal(result.verdict, 'marginal'); assert.ok(result.score >= 95);
  assert.ok(episodes[0].durationMs > episodes[0].exceedanceMs, 'recovery must be disclosed separately');
  assert.equal(result.assessment.groups.vertical.weight, 25);
});

test('severe low-altitude sink remains red even with a high overall score', () => {
  const result = score(samplesAt(100, t => ({ vsFpm: t >= 80 && t < 84 ? -1900 : -743.4 })));
  assert.equal(result.verdict, 'unstable'); assert.ok(result.assessment.episodes.some(e => e.severity === 'warning'));
});

test('a fractional-second sensor excursion does not create an episode', () => {
  const result = score(samplesAt(100, t => ({ vsFpm: t >= 40 && t < 40.2 ? -1900 : -743.4 })));
  assert.equal(result.assessment.episodes.length, 0); assert.equal(result.verdict, 'stable');
});

test('self-referenced airspeed is advisory, never a definitive red VAPP violation', () => {
  const result = score(samplesAt(100, t => ({ iasKts: t > 60 && t < 82 ? 156 : 140 })));
  const speed = result.assessment.episodes.filter(e => e.ruleId === 'approach_airspeed');
  assert.ok(speed.length > 0); assert.ok(speed.every(e => e.severity === 'caution'));
  assert.equal(result.verdict, 'marginal');
});

test('flare energy changes are excluded, while dangerous sink still counts', () => {
  const normal = score(samplesAt(100, t => t >= 105 ? { iasKts: 120, thrustPct: 0, vsFpm: -100 } : {}));
  assert.equal(normal.breakdown.speed_ok, 100); assert.equal(normal.breakdown.thrust_ok, 100);
  const severe = score(samplesAt(100, t => t >= 105 ? { vsFpm: -2000 } : {}));
  assert.equal(severe.verdict, 'unstable');
});

test('low-altitude deviation carries more weight than the same deviation higher up', () => {
  const high = score(samplesAt(100, t => ({ vsFpm: t >= 25 && t < 35 ? -1200 : -743.4 })));
  const low = score(samplesAt(100, t => ({ vsFpm: t >= 75 && t < 85 ? -1200 : -743.4 })));
  assert.ok(low.assessment.groups.vertical.pointsLost > high.assessment.groups.vertical.pointsLost);
});

test('missing or sparse approach data does not produce an inflated score', () => {
  const sparse = score(samplesAt(10000));
  assert.equal(sparse.score, null); assert.equal(sparse.verdict, 'no_verdict');
  const incomplete = score(samplesAt(100).filter(s => s.altPlaneFt < 700));
  assert.equal(incomplete.score, null); assert.ok(incomplete.gateFailures.includes('incomplete_gate_coverage'));
  const missing = score(samplesAt(100, () => ({ thrustPct: null, bankDeg: null, pitchDeg: null })));
  assert.equal(missing.assessment.groups.thrust.score, null); assert.equal(missing.assessment.groups.attitude.score, null);
  assert.equal(missing.assessment.groups.alignment.score, null);
});

test('configuration failures retain hard score caps', () => {
  const result = score(samplesAt(100, () => ({ gearDownLocked: 0 })));
  assert.equal(result.verdict, 'unstable'); assert.ok(result.score <= 60);
});

test('valid ILS guidance replaces the path-rate proxy, invalid needles are excluded', () => {
  const valid = score(samplesAt(100, () => ({ vsFpm: -950, gsKts: 100, gsDeviation: 0, nav1HasGlideSlope: true, nav1Signal: 100 })));
  const invalid = score(samplesAt(100, () => ({ vsFpm: -950, gsKts: 100, gsDeviation: 0, nav1HasGlideSlope: false, nav1Signal: 0 })));
  assert.equal(valid.breakdown.glideslope_ok, 100); assert.equal(valid.assessment.groups.vertical.score, 100);
  assert.equal(valid.verdict, 'stable'); assert.equal(valid.breakdown.glidepath_ok, null);
  assert.equal(invalid.breakdown.glideslope_ok, null); assert.ok(invalid.assessment.groups.vertical.score < 100);
});

test('live and CSV-normalized telemetry produce the same v4 result', () => {
  const live = samplesAt(200, t => ({ vsFpm: t >= 30 && t < 38 ? -1200 : -743.4 }));
  const replay = live.map(s => frameToSample(buildCanonicalStabilityFrameFromCsvRow({
    timestamp_utc: new Date(s.timestampMs).toISOString(), ra_ft: s.raFt, alt_plane_ft: s.altPlaneFt,
    ias_kts: s.iasKts, vs_fpm: s.vsFpm, gs_kts: s.gsKts, gear_down_locked: 1, flaps_pct: 40,
    pitch_deg: 3, bank_deg: 0, thr1_pct: 40, thr2_pct: 40, on_ground: 0,
  }, s.dtMs)));
  const a = score(live), b = score(replay);
  assert.equal(a.score, b.score); assert.equal(a.verdict, b.verdict); assert.deepEqual(a.assessment, b.assessment);
});

test('replay uses persisted episodes, removes duplicate legacy rules, and retains other attempts', () => {
  const evaluated = score(samplesAt(200, t => ({ vsFpm: t >= 25 && t < 32 ? -1200 : -743.4 })));
  const context = buildStabilityScoringContext({ scoreResult: evaluated });
  const original = [
    { type: 'violation_start', ruleId: VIOLATION_RULE.HIGH_SINK_RATE, timestampMs: START - 5000, severity: 'warning' },
    { type: 'violation_start', ruleId: VIOLATION_RULE.HIGH_SINK_RATE, timestampMs: START + 25000 },
    { type: 'violation_end', ruleId: VIOLATION_RULE.HIGH_SINK_RATE, timestamp_start: START + 25000, timestampMs: START + 34000 },
    { type: 'landing', timestampMs: START + 111000, ultimateStability: { scoringContext: context } },
  ];
  const json = JSON.stringify(original);
  const result = applyRecordedApproachAssessments(original, START - 60000);
  assert.equal(result.filter(e => e.ruleId === VIOLATION_RULE.HIGH_SINK_RATE).length, 1);
  const start = result.find(e => e.ruleId === 'approach_vertical_profile' && e.type === 'violation_start');
  assert.equal(start.timestampMs, evaluated.assessment.episodes[0].startMs);
  assert.equal(start.severity, 'caution'); assert.equal(JSON.stringify(original), json);
  assert.deepEqual(applyRecordedApproachAssessments(original, START - 60000), result);
  assert.deepEqual(applyRecordedApproachAssessments(result, START - 60000), result, 'applying recorded episodes twice must not duplicate them');
});

test('older saved flight events and scores are not reinterpreted', () => {
  const events = [{ type: 'landing', ultimateStability: { score: 88, scoringContext: { policy: { id: 'transport-v3' } } } }];
  assert.deepEqual(applyRecordedApproachAssessments(events, START), events);
});

test('explicit pauses are excluded from quality and confidence without allocating synthetic flight time', () => {
  const ordinary = samplesAt(200, t => ({ iasKts: 140 + 8 * Math.sin(t / 10) }));
  const expected = score(ordinary);
  const scorer = new SimpleStabilityScorer();
  let paused = false;
  for (const sample of ordinary) {
    if (!paused && sample.timestampMs >= START + 60000) {
      scorer.notePause(START + 60000);
      paused = true;
    }
    scorer.addSample({ ...sample, timestampMs: sample.timestampMs + (paused ? 3600000 : 0) });
  }
  const result = scorer.getScore(15, { criteria });
  assert.ok(Math.abs(result.score - expected.score) <= 1);
  assert.equal(result.verdict, expected.verdict);
  assert.ok(result.assessment.window.pausedDurationMs >= 3600000);
  assert.ok(result.assessment.window.coverage >= 0.99);
});

test('poor touchdown alignment cannot be hidden by benign approach averages', () => {
  const result = score(samplesAt(200), { lateralOffsetFt: 90, runwayWidthFt: 150 });
  assert.equal(result.verdict, 'unstable');
  assert.ok(result.gateFailures.includes('lateral_offset_unstable_at_touchdown'));
});

test('a tiny sustained limit exceedance remains amber; a meaningful prolonged deviation becomes red', () => {
  const tiny = score(samplesAt(200, t => ({ vsFpm: t >= 60 && t < 90 ? -1001 : -743.4 })));
  assert.ok(tiny.assessment.episodes.length > 0);
  assert.ok(tiny.assessment.episodes.every(e => e.severity === 'caution'));
  assert.equal(tiny.verdict, 'marginal');
  const meaningful = score(samplesAt(200, t => ({ vsFpm: t >= 60 && t < 90 ? -1150 : -743.4 })));
  assert.equal(meaningful.verdict, 'unstable');
  assert.ok(meaningful.assessment.episodes.some(e => e.severity === 'warning'));
});

test('a large path-rate estimate cannot turn a tiny measured sink exceedance red', () => {
  const result = score(samplesAt(200, t => ({ gsKts: 40, vsFpm: t >= 60 && t < 90 ? -1001 : -743.4 })));
  assert.ok(result.assessment.episodes.some(e => e.reasons.includes(VIOLATION_RULE.HIGH_SINK_RATE)));
  assert.ok(result.assessment.episodes.every(e => e.severity === 'caution'));
});

test('missing readings from the selected height source are data gaps, not low-altitude flight', () => {
  const samples = samplesAt(200).map(s => ({ ...s, heightFt: s.timestampMs >= START + 60000 && s.timestampMs < START + 90000 ? NaN : s.raFt }));
  const result = assessApproach({ samples, criteria,
    configuration: { score: 100, gear: true, flaps: true, failures: [] }, lateralScore: null });
  assert.equal(result.verdict, 'no_verdict');
  assert.ok(result.assessment.window.coverage < 0.8);
  assert.ok(result.failures.includes('insufficient_data'));
});
