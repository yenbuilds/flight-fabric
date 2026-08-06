'use strict';

type AnyRecord = Record<string, any>;

const RETIRED_SPOILER_FAILURE = 'spoilers_moved_after_gate';
const SCORE_METRIC_KEYS = Object.freeze([
  'config_ok',
  'speed_ok',
  'speed_trend_ok',
  'vs_ok',
  'glidepath_ok',
  'thrust_ok',
  'pitch_ok',
  'bank_ok',
  'lateral_offset_ok',
]);
const CONFIG_SCORE_CAPS: Readonly<Record<string, number>> = Object.freeze({
  gear_not_down_at_gate: 60,
  flaps_not_set_at_gate: 60,
  gear_changed_after_gate: 70,
  flaps_changed_after_gate: 70,
});

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeGateFailures(value: unknown): string[] {
  const failures = Array.isArray(value)
    ? value
    : (typeof value === 'string' && value.trim() ? value.split('|') : []);
  return failures
    .map((failure) => String(failure).trim())
    .filter(Boolean);
}

function normalizeRetiredSpoilerStability(value: unknown): AnyRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as AnyRecord;
  const breakdown = input.breakdown && typeof input.breakdown === 'object' && !Array.isArray(input.breakdown)
    ? { ...input.breakdown }
    : null;
  const gateFailures = normalizeGateFailures(input.gateFailures);
  const hadRetiredPenalty = gateFailures.includes(RETIRED_SPOILER_FAILURE);
  if (!hadRetiredPenalty) return { ...input, gateFailures };

  const filteredFailures = gateFailures.filter((failure) => failure !== RETIRED_SPOILER_FAILURE);
  if (!breakdown) {
    return {
      ...input,
      gateStable: filteredFailures.length === 0,
      gateFailures: filteredFailures,
    };
  }
  breakdown.spoilers_ok = 100;
  const gearOk = finiteNumber(breakdown.gear_ok);
  const flapsOk = finiteNumber(breakdown.flaps_ok);
  if (gearOk !== null && flapsOk !== null) {
    breakdown.config_ok = gearOk >= 100 && flapsOk >= 100 ? 100 : 0;
  }

  const scoreInputs = SCORE_METRIC_KEYS
    .map((key) => finiteNumber(breakdown[key]))
    .filter((metric): metric is number => metric !== null);
  let score = finiteNumber(input.score);
  if (scoreInputs.length > 0) {
    score = Math.max(
      0,
      Math.min(100, Math.round(scoreInputs.reduce((sum, metric) => sum + metric, 0) / scoreInputs.length)),
    );
    for (const failure of filteredFailures) {
      const cap = CONFIG_SCORE_CAPS[failure];
      if (typeof cap === 'number') score = Math.min(score, cap);
    }
  }

  return {
    ...input,
    score,
    gateStable: filteredFailures.length === 0,
    gateFailures: filteredFailures,
    breakdown,
  };
}

module.exports = {
  RETIRED_SPOILER_FAILURE,
  normalizeRetiredSpoilerStability,
};

export {};
