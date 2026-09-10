const { VIOLATION_RULE } = require('../../shared/violation-rules.js') as typeof import('../../shared/violation-rules.js');
// Retrospective game assessment, shared by the landing score and timeline.
// Aviation anchors: a height gate, configured landing, controlled energy and
// flight path. The graded bands/weights below are product rules, not an SOP.
export const APPROACH_ASSESSMENT_RULES = Object.freeze({
  version: 4,
  stepMs: 200,
  smoothingMs: 1000,
  maximumGapMs: 2000,
  minimumDurationMs: 10000,
  minimumCoverage: 0.8,
  flareHeightFt: 50,
  lowHeightFt: 500,
  lowHeightWeight: 1.5,
  cautionEntryMs: 3000,
  warningEntryMs: 1000,
  recoveryMs: 2000,
  sustainedWarningMs: 20000,
  lowSustainedWarningMs: 10000,
  sustainedSinkExcessFpm: 100,
  sustainedAttitudeExcessDeg: 2,
  sustainedNavigationExcessDots: 0.2,
  sinkWarningMarginFpm: 500,
  sinkRecoveryMarginFpm: 100,
  pathCautionMarginFpm: 200,
  pathWarningMarginFpm: 500,
  pathRecoveryMarginFpm: 50,
  speedWarningMarginKts: 10,
  bankWarningMarginDeg: 10,
  pitchWarningMarginDeg: 10,
  navigationCautionDots: 1,
  navigationWarningDots: 2,
  navigationRecoveryDots: 0.8,
  groupWeights: Object.freeze({ configuration: 20, speed: 25, vertical: 25, attitude: 15, thrust: 5, alignment: 10 }),
});

type Values = Record<string, any>;
export type AssessmentSample = Values & { heightFt: number; dtMs?: number; timestampMs?: number };
type Point = AssessmentSample & { timeMs: number; valid: boolean };
type Episode = Values & { ruleId: string; severity: 'caution' | 'warning'; startMs: number; endMs: number };
const RULES = APPROACH_ASSESSMENT_RULES;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const bounded = (value: number) => Math.max(0, Math.min(1, value));
const lossOutside = (value: unknown, min: number, max: number, margin: number): number | null =>
  finite(value) ? bounded(Math.max(min - value, value - max, 0) / margin) : null;
const worst = (...values: Array<number | null>): number | null => {
  const known = values.filter(finite);
  return known.length ? Math.max(...known) : null;
};

function interpolate(a: Point, b: Point, timeMs: number): Point {
  const fraction = (timeMs - a.timeMs) / (b.timeMs - a.timeMs);
  const result = { ...a, timeMs, valid: true };
  for (const key of ['heightFt', 'iasKts', 'vsFpm', 'gsKts', 'pitchDeg', 'bankDeg', 'thrustPct', 'latDeg', 'lonDeg', 'gsDeviationDots', 'locDeviationDots']) {
    result[key] = finite(a[key]) && finite(b[key]) ? a[key] + (b[key] - a[key]) * fraction : null;
  }
  return result;
}

function timedSamples(samples: AssessmentSample[]): Point[] {
  let elapsedMs = 0;
  return samples.map((sample, index) => {
    if (index > 0) elapsedMs += finite(sample.dtMs) && sample.dtMs > 0 ? sample.dtMs : 100;
    return { ...sample, timeMs: finite(sample.timestampMs) ? sample.timestampMs : elapsedMs, valid: true };
  }).filter((sample, index, all) => index === 0 || sample.timeMs > all[index - 1].timeMs);
}

/** Fixed time grid with interpolation only across short, observed intervals.
 * Pauses/dropouts remain gaps, never invented good flight time. */
function resample(samples: Point[], startMs: number, endMs: number): Point[] {
  const points: Point[] = [];
  let index = 0;
  for (let timeMs = startMs; timeMs < endMs; timeMs += RULES.stepMs) {
    while (index + 1 < samples.length && samples[index + 1].timeMs <= timeMs) index++;
    const a = samples[index];
    const b = samples[index + 1];
    if (!a || !b || !finite(a.heightFt) || !finite(b.heightFt)
        || a.paused || b.paused || b.timeMs - a.timeMs > RULES.maximumGapMs || a.onGround || b.onGround) {
      const skipToMs = b ? Math.min(endMs, startMs + Math.ceil((b.timeMs - startMs) / RULES.stepMs) * RULES.stepMs) : endMs;
      points.push({ ...(a || {}), timeMs, heightFt: a?.heightFt ?? 0, valid: false,
        excludedMs: a?.paused || b?.paused ? skipToMs - timeMs : 0 });
      // Do not allocate hours of synthetic points for a pause or recording gap.
      timeMs = skipToMs - RULES.stepMs;
    } else {
      points.push(interpolate(a, b, timeMs));
    }
  }
  return points;
}

type Alert = { breach: boolean; severe: boolean; clear: boolean; reasons: string[]; value?: number; target?: number; advisoryOnly?: boolean; sustainedEligible?: boolean };

function collectEpisodes(points: Point[], alerts: Array<Alert | null>, ruleId: string, endMs: number): Episode[] {
  const episodes: Episode[] = [];
  let state: Values | null = null;
  const finish = (point: Point, reason: string) => {
    if (state?.published) episodes.push({
      ruleId, severity: state.warning ? 'warning' : 'caution',
      startMs: state.start.timeMs, endMs: point.timeMs,
      startHeightFt: state.start.heightFt, endHeightFt: point.heightFt,
      lat: state.start.latDeg ?? null, lon: state.start.lonDeg ?? null,
      endLat: point.latDeg ?? null, endLon: point.lonDeg ?? null,
      exceedanceMs: state.exceedanceMs, durationMs: point.timeMs - state.start.timeMs,
      peakValue: state.peakValue, targetValue: state.targetValue,
      peakGlideslopeDots: state.peakGlideslopeDots ?? null,
      peakSinkRateFpm: state.peakSinkRateFpm ?? null,
      reasons: [...state.reasons], endReason: reason,
    });
    state = null;
  };
  points.forEach((point, index) => {
    const alert = alerts[index];
    const dt = Math.min(RULES.stepMs, endMs - point.timeMs);
    if (!point.valid || !alert) { finish(point, point.valid ? 'window_ended' : point.excludedMs ? 'paused' : 'data_gap'); return; }
    if (!state) {
      if (!alert.breach) return;
      state = { start: point, published: false, warning: false, exceedanceMs: 0, consecutiveMs: 0,
        severeMs: 0, lowBreachMs: 0, clearMs: 0, reasons: new Set<string>(), peakValue: null, targetValue: null };
    }
    if (alert.breach) {
      state.exceedanceMs += dt;
      state.consecutiveMs += dt;
      alert.reasons.forEach(reason => state.reasons.add(reason));
      if (finite(point.gsDeviationDots)) state.peakGlideslopeDots = Math.max(state.peakGlideslopeDots || 0, Math.abs(point.gsDeviationDots));
      if (finite(point.vsFpm)) state.peakSinkRateFpm = Math.min(state.peakSinkRateFpm ?? 0, point.vsFpm);
      if (finite(alert.value) && (state.peakValue === null
          || Math.abs(alert.value - (alert.target ?? 0)) > Math.abs(state.peakValue - (state.targetValue ?? 0)))) {
        state.peakValue = alert.value;
        state.targetValue = alert.target ?? null;
      }
    } else {
      state.consecutiveMs = 0;
      if (!state.published) { state = null; return; }
    }
    state.severeMs = alert.severe && !alert.advisoryOnly ? state.severeMs + dt : 0;
    const sustained = alert.sustainedEligible && !alert.advisoryOnly;
    state.sustainedMs = sustained ? (state.sustainedMs || 0) + dt : 0;
    state.lowBreachMs = sustained && point.heightFt <= RULES.lowHeightFt ? state.lowBreachMs + dt : 0;
    if (!alert.advisoryOnly && (state.severeMs >= RULES.warningEntryMs
        || state.sustainedMs >= RULES.sustainedWarningMs
        || (alert.breach && state.lowBreachMs >= RULES.lowSustainedWarningMs))) state.warning = true;
    if (state.consecutiveMs >= RULES.cautionEntryMs || state.warning) state.published = true;
    state.clearMs = alert.clear ? state.clearMs + dt : 0;
    if (state.clearMs >= RULES.recoveryMs) finish({ ...point, timeMs: point.timeMs + dt }, 'recovered');
  });
  if (state) finish({ ...points[points.length - 1], timeMs: endMs }, 'window_ended');
  return episodes;
}

export function assessApproach(input: {
  samples: AssessmentSample[];
  criteria: Values;
  configuration: { score: number | null; gear: boolean | null; flaps: boolean | null; failures: string[] };
  lateralScore: number | null;
}): Values {
  const { criteria, configuration, lateralScore } = input;
  const samples = timedSamples(input.samples);
  const gateIndex = samples.findIndex(sample => sample.heightFt <= criteria.gateRaFt);
  const first = samples[gateIndex];
  const previous = samples[gateIndex - 1];
  const gate = previous && previous.heightFt > criteria.gateRaFt
      && first.timeMs - previous.timeMs <= RULES.maximumGapMs
    ? interpolate(previous, first, previous.timeMs + (first.timeMs - previous.timeMs)
      * (previous.heightFt - criteria.gateRaFt) / (previous.heightFt - first.heightFt))
    : first;
  const last = samples[samples.length - 1];
  const startMs = gate?.timeMs ?? 0;
  const endMs = last?.timeMs ?? startMs;
  const points = gate ? resample(samples, startMs, endMs) : [];
  const knownMs = points.reduce((sum, point) => sum + (point.valid ? Math.min(RULES.stepMs, endMs - point.timeMs) : 0), 0);
  const pausedMs = points.reduce((sum, point) => sum + (point.excludedMs || 0), 0);
  const assessment: Values = {
    version: RULES.version, rules: RULES,
    timeReference: input.samples.every(sample => finite(sample.timestampMs)) ? 'epoch' : 'relative',
    window: { startMs, endMs, collectionStartMs: samples[0]?.timeMs ?? startMs,
      gateHeightFt: criteria.gateRaFt, observedGateHeightFt: gate?.heightFt ?? null,
      observedDurationMs: knownMs, pausedDurationMs: pausedMs,
      coverage: endMs > startMs + pausedMs ? knownMs / (endMs - startMs - pausedMs) : 0 },
    referenceIasKts: gate?.iasKts ?? null,
    episodes: [], groups: {}, metrics: {},
  };
  const unavailableReason = !gate ? 'no_gate_sample'
    : gate.heightFt < criteria.gateRaFt - 100 ? 'incomplete_gate_coverage'
      : knownMs < RULES.minimumDurationMs || assessment.window.coverage < RULES.minimumCoverage ? 'insufficient_data' : null;
  if (unavailableReason) return { assessment, score: null, verdict: 'no_verdict', failures: [unavailableReason] };

  const losses: Array<Record<string, number | null>> = [];
  const verticalAlerts: Array<Alert | null> = [];
  const speedAlerts: Array<Alert | null> = [];
  const bankAlerts: Array<Alert | null> = [];
  const pitchAlerts: Array<Alert | null> = [];
  const localizerAlerts: Array<Alert | null> = [];
  const targetFactor = criteria.glidepathAngleDeg === 3 ? 5.31
    : 6076.12 / 60 * Math.tan(criteria.glidepathAngleDeg * Math.PI / 180);
  const historySteps = RULES.smoothingMs / RULES.stepMs;
  points.forEach((point, index) => {
    if (!point.valid) {
      losses.push({}); verticalAlerts.push(null); speedAlerts.push(null); bankAlerts.push(null); pitchAlerts.push(null); localizerAlerts.push(null); return;
    }
    const energy = point.heightFt > RULES.flareHeightFt;
    const history = points.slice(Math.max(0, index - historySteps + 1), index + 1);
    const smoothVs = history.every(sample => sample.valid)
      ? history.reduce((sum, sample) => sum + sample.vsFpm, 0) / history.length : point.vsFpm;
    const before = points[index - historySteps];
    const trend = (key: string) => before?.valid && history.every(sample => sample.valid)
        && finite(point[key]) && finite(before[key]) ? Math.abs(point[key] - before[key]) : null;
    const speedTrend = energy ? trend('iasKts') : null;
    const thrustTrend = energy ? trend('thrustPct') : null;
    const target = finite(point.gsKts) && point.gsKts >= 30 ? -point.gsKts * targetFactor : null;
    // Published steep approaches receive the same relative tolerance.
    const sinkLimit = criteria.glidepathAngleDeg > 3 && target !== null
      ? Math.min(criteria.vsMinFpm, target - criteria.glidepathVsDeltaMaxFpm) : criteria.vsMinFpm;
    const pathDelta = energy && target !== null ? smoothVs - target : null;
    const pathIdeal = criteria.glidepathVsDeltaMaxFpm;
    const pathCaution = pathIdeal + RULES.pathCautionMarginFpm;
    const speedMin = gate.iasKts - criteria.speedMinusKts;
    const speedMax = gate.iasKts + criteria.speedPlusKts;
    const values = {
      speed_ok: energy ? lossOutside(point.iasKts, speedMin, speedMax, RULES.speedWarningMarginKts) : null,
      speed_trend_ok: lossOutside(speedTrend, 0, criteria.speedTrendMaxKtsPerSec, criteria.speedTrendMaxKtsPerSec || 1),
      vs_ok: lossOutside(smoothVs, sinkLimit, criteria.vsMaxClimbFpm, RULES.sinkWarningMarginFpm),
      glidepath_ok: lossOutside(pathDelta, -pathIdeal, pathIdeal, RULES.pathWarningMarginFpm),
      glidepath_below_ok: lossOutside(pathDelta, -pathIdeal, Infinity, RULES.pathWarningMarginFpm),
      glidepath_above_ok: lossOutside(pathDelta, -Infinity, pathIdeal, RULES.pathWarningMarginFpm),
      thrust_ok: lossOutside(thrustTrend, 0, criteria.thrustStableMaxPctPerSec, criteria.thrustStableMaxPctPerSec || 1),
      pitch_ok: lossOutside(point.pitchDeg, criteria.pitchMinDeg, criteria.pitchMaxDeg, RULES.pitchWarningMarginDeg),
      bank_ok: lossOutside(point.bankDeg, -criteria.bankMaxDeg, criteria.bankMaxDeg, RULES.bankWarningMarginDeg),
      glideslope_ok: energy ? lossOutside(point.gsDeviationDots, -RULES.navigationCautionDots, RULES.navigationCautionDots, 1) : null,
      localizer_ok: energy ? lossOutside(point.locDeviationDots, -RULES.navigationCautionDots, RULES.navigationCautionDots, 1) : null,
    };
    losses.push({ ...values, speed: worst(values.speed_ok, values.speed_trend_ok),
      vertical: worst(values.vs_ok, values.glideslope_ok ?? values.glidepath_ok),
      attitude: worst(values.pitch_ok, values.bank_ok), thrust: values.thrust_ok });
    const sinkBreach = smoothVs < sinkLimit;
    const gsDeviation = energy && finite(point.gsDeviationDots) ? Math.abs(point.gsDeviationDots) : null;
    const pathBreach = gsDeviation === null && pathDelta !== null && Math.abs(pathDelta) > pathCaution;
    const reasons = [sinkBreach ? VIOLATION_RULE.HIGH_SINK_RATE : '', pathBreach ? (pathDelta < 0 ? 'steep_path_rate' : 'shallow_path_rate') : '',
      gsDeviation !== null && gsDeviation > RULES.navigationCautionDots ? 'glideslope_deviation' : '',
      smoothVs > criteria.vsMaxClimbFpm ? 'climbing_on_approach' : ''].filter(Boolean);
    // A rate estimate cannot establish unsafe path position, even alongside a
    // minor sink exceedance. Only measured sink/climb or guidance escalates.
    verticalAlerts.push({ breach: reasons.length > 0,
      severe: smoothVs < sinkLimit - RULES.sinkWarningMarginFpm || smoothVs > criteria.vsMaxClimbFpm + RULES.sinkWarningMarginFpm
        || (gsDeviation !== null && gsDeviation > RULES.navigationWarningDots),
      clear: smoothVs >= sinkLimit + RULES.sinkRecoveryMarginFpm && smoothVs <= criteria.vsMaxClimbFpm
        && (gsDeviation !== null ? gsDeviation <= RULES.navigationRecoveryDots
          : pathDelta === null || Math.abs(pathDelta) <= pathCaution - RULES.pathRecoveryMarginFpm),
      reasons, value: smoothVs, target: target ?? undefined,
      advisoryOnly: !sinkBreach && gsDeviation === null && smoothVs <= criteria.vsMaxClimbFpm,
      sustainedEligible: smoothVs < sinkLimit - RULES.sustainedSinkExcessFpm
        || smoothVs > criteria.vsMaxClimbFpm + RULES.sustainedSinkExcessFpm
        || (gsDeviation !== null && gsDeviation > RULES.navigationCautionDots + RULES.sustainedNavigationExcessDots),
    });
    speedAlerts.push(energy ? { breach: point.iasKts < speedMin || point.iasKts > speedMax,
      severe: point.iasKts < speedMin - RULES.speedWarningMarginKts || point.iasKts > speedMax + RULES.speedWarningMarginKts,
      clear: point.iasKts >= speedMin + 1 && point.iasKts <= speedMax - 1,
      reasons: ['airspeed_deviation'], value: point.iasKts, target: gate.iasKts, advisoryOnly: true } : null);
    bankAlerts.push(finite(point.bankDeg) ? { breach: Math.abs(point.bankDeg) > criteria.bankMaxDeg,
      sustainedEligible: Math.abs(point.bankDeg) > criteria.bankMaxDeg + RULES.sustainedAttitudeExcessDeg,
      severe: Math.abs(point.bankDeg) > criteria.bankMaxDeg + RULES.bankWarningMarginDeg,
      clear: Math.abs(point.bankDeg) <= Math.max(0, criteria.bankMaxDeg - 2), reasons: [VIOLATION_RULE.EXCESSIVE_BANK], value: point.bankDeg } : null);
    pitchAlerts.push(finite(point.pitchDeg) ? { breach: point.pitchDeg < criteria.pitchMinDeg || point.pitchDeg > criteria.pitchMaxDeg,
      sustainedEligible: point.pitchDeg < criteria.pitchMinDeg - RULES.sustainedAttitudeExcessDeg
        || point.pitchDeg > criteria.pitchMaxDeg + RULES.sustainedAttitudeExcessDeg,
      severe: point.pitchDeg < criteria.pitchMinDeg - RULES.pitchWarningMarginDeg || point.pitchDeg > criteria.pitchMaxDeg + RULES.pitchWarningMarginDeg,
      clear: point.pitchDeg >= criteria.pitchMinDeg + 1 && point.pitchDeg <= criteria.pitchMaxDeg - 1,
      reasons: ['pitch_deviation'], value: point.pitchDeg } : null);
    localizerAlerts.push(energy && finite(point.locDeviationDots) ? {
      breach: Math.abs(point.locDeviationDots) > RULES.navigationCautionDots,
      sustainedEligible: Math.abs(point.locDeviationDots) > RULES.navigationCautionDots + RULES.sustainedNavigationExcessDots,
      severe: Math.abs(point.locDeviationDots) > RULES.navigationWarningDots,
      clear: Math.abs(point.locDeviationDots) <= RULES.navigationRecoveryDots,
      reasons: ['localizer_deviation'], value: point.locDeviationDots,
    } : null);
  });
  assessment.episodes = [
    ...collectEpisodes(points, verticalAlerts, 'approach_vertical_profile', endMs),
    ...collectEpisodes(points, speedAlerts, 'approach_airspeed', endMs),
    ...collectEpisodes(points, bankAlerts, 'approach_bank', endMs),
    ...collectEpisodes(points, pitchAlerts, 'approach_pitch', endMs),
    ...collectEpisodes(points, localizerAlerts, 'approach_localizer', endMs),
  ].sort((a, b) => a.startMs - b.startMs);

  const scoreMetric = (key: string) => {
    let loss = 0, weight = 0, observedMs = 0, eligibleMs = 0;
    points.forEach((point, index) => {
      const value = losses[index][key];
      const dt = Math.min(RULES.stepMs, endMs - point.timeMs);
      const energyMetric = ['speed_ok', 'speed_trend_ok', 'speed', 'glidepath_ok', 'glidepath_below_ok', 'glidepath_above_ok',
        'thrust_ok', 'thrust', 'glideslope_ok', 'localizer_ok'].includes(key);
      if (point.valid && (!energyMetric || point.heightFt > RULES.flareHeightFt)) eligibleMs += dt;
      if (!finite(value)) return;
      const weightedMs = dt * (point.heightFt <= RULES.lowHeightFt ? RULES.lowHeightWeight : 1);
      observedMs += dt; loss += value * weightedMs; weight += weightedMs;
    });
    return { score: weight && observedMs >= Math.min(5000, eligibleMs) && observedMs >= eligibleMs * RULES.minimumCoverage
      ? Math.round(100 * (1 - loss / weight)) : null, observedMs, eligibleMs };
  };
  for (const key of ['speed_ok', 'speed_trend_ok', 'vs_ok', 'glidepath_ok', 'glidepath_below_ok', 'glidepath_above_ok', 'thrust_ok', 'pitch_ok', 'bank_ok', 'glideslope_ok', 'localizer_ok']) {
    assessment.metrics[key] = scoreMetric(key);
  }
  if (assessment.metrics.glideslope_ok.score !== null) {
    for (const key of ['glidepath_ok', 'glidepath_below_ok', 'glidepath_above_ok']) {
      assessment.metrics[key] = { ...assessment.metrics[key], diagnosticScore: assessment.metrics[key].score,
        score: null, notScoredReason: 'valid_glideslope' };
    }
  }
  let weightedTotal = 0, totalWeight = 0;
  for (const [key, weight] of Object.entries(RULES.groupWeights)) {
    let scored;
    if (key === 'configuration') {
      scored = { score: configuration.score, observedMs: knownMs };
    } else if (key === 'alignment') {
      const localizer = assessment.metrics.localizer_ok;
      scored = { score: lateralScore === null ? localizer.score : Math.min(lateralScore, localizer.score ?? 100),
        observedMs: localizer.observedMs };
    } else {
      scored = scoreMetric(key);
    }
    assessment.groups[key] = { ...scored, weight };
    if (finite(scored.score)) { weightedTotal += scored.score * weight; totalWeight += weight; }
  }
  for (const group of Object.values(assessment.groups) as Values[]) {
    group.effectiveWeightPct = finite(group.score) ? 100 * group.weight / totalWeight : 0;
    group.pointsLost = finite(group.score) ? (100 - group.score) * group.weight / totalWeight : null;
  }
  let score = Math.round(weightedTotal / totalWeight);
  for (const failure of configuration.failures) score = Math.min(score, failure.includes('not_') ? 60 : 70);
  const failures = [...configuration.failures];
  const failureIds = { speed_ok: 'speed_proxy_unstable_after_gate', speed_trend_ok: 'speed_trend_unstable_after_gate',
    vs_ok: 'vs_unstable_after_gate', glidepath_ok: 'glidepath_proxy_unstable_after_gate',
    glidepath_below_ok: 'path_rate_steep_after_gate', glidepath_above_ok: 'path_rate_shallow_after_gate',
    thrust_ok: 'thrust_unstable_after_gate', pitch_ok: 'pitch_unstable_after_gate', bank_ok: 'bank_unstable_after_gate',
    glideslope_ok: 'glideslope_unstable_after_gate', localizer_ok: 'localizer_unstable_after_gate' };
  for (const [key, metric] of Object.entries(assessment.metrics) as Array<[string, Values]>) {
    if (finite(metric.score) && metric.score < criteria.passPct) failures.push(failureIds[key]);
  }
  if (lateralScore !== null && lateralScore < criteria.passPct) failures.push('lateral_offset_unstable_at_touchdown');
  const warning = assessment.episodes.some((episode: Episode) => episode.severity === 'warning');
  const caution = assessment.episodes.length > 0;
  // A severe episode cannot be hidden by averaging a long benign approach.
  const severeCore = [assessment.metrics.vs_ok.score, assessment.metrics.pitch_ok.score, assessment.metrics.bank_ok.score, lateralScore]
    .some(value => finite(value) && value < 60);
  const verdict = configuration.failures.length || score < 80 || warning || severeCore ? 'unstable'
    : caution || failures.length ? 'marginal' : 'stable';
  if (warning) failures.push('approach_warning');
  else if (caution) failures.push('approach_caution');
  return { assessment, score, verdict, failures };
}
