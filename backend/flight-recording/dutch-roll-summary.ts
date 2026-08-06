'use strict';

type DutchRollInputRow = {
  record_type?: unknown;
  ts?: unknown;
  timestamp_ms?: unknown;
  phase?: unknown;
  on_ground?: unknown;
  sim_paused?: unknown;
  sim_in_menu?: unknown;
  ias_kts?: unknown;
  gs_kts?: unknown;
  alt_msl_ft?: unknown;
  ra_ft?: unknown;
  bank_deg?: unknown;
  roll_rate_rad_s?: unknown;
  yaw_rate_rad_s?: unknown;
  sideslip_deg?: unknown;
  hdg_true_deg?: unknown;
  track_true_deg?: unknown;
};

type DutchRollSample = {
  tsMs: number;
  phase: string | null;
  bankDeg: number;
  yawRateDegS: number | null;
  sideslipDeg: number | null;
  yawSignal: number;
};

type DutchRollEpisode = {
  start_ts: number;
  end_ts: number;
  duration_ms: number;
  phase: string | null;
  cycles: number;
  sample_count: number;
  max_bank_deg: number;
  max_yaw_rate_deg_s: number | null;
  max_sideslip_deg: number | null;
};

type DutchRollSummary = {
  detected: boolean;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  episodes: number;
  max_duration_ms: number;
  max_bank_deg: number;
  max_yaw_rate_deg_s: number | null;
  max_sideslip_deg: number | null;
  cycles: number;
  start_ts: number;
  end_ts: number;
  phase: string | null;
  sample_count: number;
};

const AIRLINER_MIN_IAS_KTS = 180;
const AIRLINER_MAX_IAS_KTS = 430;
const MIN_SAMPLE_COUNT = 8;
const MAX_SAMPLE_GAP_MS = 2500;
const MIN_FLIP_INTERVAL_MS = 900;
const MAX_FLIP_INTERVAL_MS = 8000;
const MIN_EPISODE_DURATION_MS = 10000;
const SAMPLE_PADDING_MS = 1500;
const BANK_DEADBAND_DEG = 1.25;
const YAW_RATE_DEADBAND_DEG_S = 0.25;
const SIDESLIP_DEADBAND_DEG = 0.35;
const MIN_PEAK_BANK_DEG = 2.5;
const MAX_PEAK_BANK_DEG = 22;
const MIN_PEAK_YAW_RATE_DEG_S = 0.7;
const MIN_PEAK_SIDESLIP_DEG = 0.8;
const MAX_MEAN_BANK_DEG = 6;
const QUALIFYING_PHASES = new Set(['CLIMB', 'CRUISE', 'DESCENT']);
const EXCLUDED_PHASES = new Set([
  'PARKED',
  'TAXI',
  'TAXI-IN',
  'TAXI_OUT',
  'TAXI-OUT',
  'TAKEOFF',
  'APPROACH',
  'LANDING',
  'GO_AROUND',
  'GO-AROUND',
]);

function toFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBoolean(value: unknown): boolean | null {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  return null;
}

function toPhase(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().toUpperCase();
}

function angleDeltaDeg(a: number, b: number): number {
  let delta = ((a - b + 540) % 360) - 180;
  if (Object.is(delta, -0)) delta = 0;
  return delta;
}

function absFinite(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? Math.abs(value) : null;
}

function signalSign(value: number, deadband: number): -1 | 0 | 1 {
  if (value > deadband) return 1;
  if (value < -deadband) return -1;
  return 0;
}

function pickYawSignal(row: DutchRollInputRow): {
  yawSignal: number | null;
  yawRateDegS: number | null;
  sideslipDeg: number | null;
} {
  const yawRateRadS = toFiniteNumber(row.yaw_rate_rad_s);
  const yawRateDegS = yawRateRadS !== null ? yawRateRadS * (180 / Math.PI) : null;
  const sideslipDeg = toFiniteNumber(row.sideslip_deg);
  if (yawRateDegS !== null && Math.abs(yawRateDegS) <= 45) {
    return { yawSignal: yawRateDegS, yawRateDegS, sideslipDeg };
  }
  if (sideslipDeg !== null && Math.abs(sideslipDeg) <= 30) {
    return { yawSignal: sideslipDeg, yawRateDegS, sideslipDeg };
  }

  const heading = toFiniteNumber(row.hdg_true_deg);
  const track = toFiniteNumber(row.track_true_deg);
  if (heading !== null && track !== null) {
    const betaProxy = angleDeltaDeg(heading, track);
    if (Math.abs(betaProxy) <= 30) {
      return { yawSignal: betaProxy, yawRateDegS, sideslipDeg };
    }
  }

  return { yawSignal: null, yawRateDegS, sideslipDeg };
}

function isQualifyingAirlinerSample(row: DutchRollInputRow): DutchRollSample | null {
  const recordType = typeof row.record_type === 'string' ? row.record_type : null;
  if (recordType && recordType !== 'SAMPLE') return null;
  if (toBoolean(row.sim_paused) === true || toBoolean(row.sim_in_menu) === true) return null;
  if (toBoolean(row.on_ground) === true) return null;

  const phase = toPhase(row.phase);
  if (phase && EXCLUDED_PHASES.has(phase)) return null;
  if (phase && !QUALIFYING_PHASES.has(phase)) return null;

  const ias = toFiniteNumber(row.ias_kts);
  if (ias === null || ias < AIRLINER_MIN_IAS_KTS || ias > AIRLINER_MAX_IAS_KTS) return null;

  const raFt = toFiniteNumber(row.ra_ft);
  const altMslFt = toFiniteNumber(row.alt_msl_ft);
  if (raFt !== null && raFt < 1000) return null;
  if (raFt === null && altMslFt !== null && altMslFt < 3000) return null;

  const tsMs = toFiniteNumber(row.timestamp_ms) ?? toFiniteNumber(row.ts);
  const bankDeg = toFiniteNumber(row.bank_deg);
  if (tsMs === null || bankDeg === null || Math.abs(bankDeg) > MAX_PEAK_BANK_DEG) return null;

  const yaw = pickYawSignal(row);
  if (yaw.yawSignal === null) return null;

  return {
    tsMs,
    phase,
    bankDeg,
    yawRateDegS: yaw.yawRateDegS,
    sideslipDeg: yaw.sideslipDeg,
    yawSignal: yaw.yawSignal,
  };
}

function splitSegments(samples: DutchRollSample[]): DutchRollSample[][] {
  const sorted = samples.slice().sort((a, b) => a.tsMs - b.tsMs);
  const segments: DutchRollSample[][] = [];
  let current: DutchRollSample[] = [];

  for (const sample of sorted) {
    const previous = current[current.length - 1];
    if (
      previous &&
      (sample.tsMs - previous.tsMs > MAX_SAMPLE_GAP_MS || (sample.phase && previous.phase && sample.phase !== previous.phase))
    ) {
      if (current.length >= MIN_SAMPLE_COUNT) segments.push(current);
      current = [];
    }
    current.push(sample);
  }

  if (current.length >= MIN_SAMPLE_COUNT) segments.push(current);
  return segments;
}

function buildFlipTimes(samples: DutchRollSample[], field: 'bankDeg' | 'yawSignal', deadband: number): number[] {
  const flips: number[] = [];
  let lastSign: -1 | 0 | 1 = 0;

  for (const sample of samples) {
    const sign = signalSign(sample[field], deadband);
    if (sign === 0) continue;
    if (lastSign !== 0 && sign !== lastSign) {
      flips.push(sample.tsMs);
    }
    lastSign = sign;
  }

  return flips;
}

function buildFlipRuns(flipTimes: number[]): number[][] {
  const runs: number[][] = [];
  let current: number[] = [];

  for (const ts of flipTimes) {
    const previous = current[current.length - 1];
    if (!previous) {
      current = [ts];
      continue;
    }

    const interval = ts - previous;
    if (interval >= MIN_FLIP_INTERVAL_MS && interval <= MAX_FLIP_INTERVAL_MS) {
      current.push(ts);
      continue;
    }

    if (current.length >= 4) runs.push(current);
    current = [ts];
  }

  if (current.length >= 4) runs.push(current);
  return runs;
}

function summarizeEpisode(samples: DutchRollSample[], bankRun: number[], yawFlips: number[]): DutchRollEpisode | null {
  const startTs = Math.max(samples[0].tsMs, bankRun[0] - SAMPLE_PADDING_MS);
  const endTs = Math.min(samples[samples.length - 1].tsMs, bankRun[bankRun.length - 1] + SAMPLE_PADDING_MS);
  const durationMs = endTs - startTs;
  if (durationMs < MIN_EPISODE_DURATION_MS) return null;

  const episodeSamples = samples.filter((sample) => sample.tsMs >= startTs && sample.tsMs <= endTs);
  if (episodeSamples.length < MIN_SAMPLE_COUNT) return null;

  const episodeYawFlips = yawFlips.filter((ts) => ts >= startTs && ts <= endTs);
  if (episodeYawFlips.length < 3) return null;

  const maxBankDeg = Math.max(...episodeSamples.map((sample) => Math.abs(sample.bankDeg)));
  const meanBankDeg = episodeSamples.reduce((sum, sample) => sum + sample.bankDeg, 0) / episodeSamples.length;
  const maxYawRate = Math.max(0, ...episodeSamples.map((sample) => absFinite(sample.yawRateDegS) ?? 0));
  const maxSideslip = Math.max(0, ...episodeSamples.map((sample) => absFinite(sample.sideslipDeg) ?? 0));
  const hasYawEvidence = maxYawRate >= MIN_PEAK_YAW_RATE_DEG_S || maxSideslip >= MIN_PEAK_SIDESLIP_DEG;

  if (maxBankDeg < MIN_PEAK_BANK_DEG || maxBankDeg > MAX_PEAK_BANK_DEG) return null;
  if (Math.abs(meanBankDeg) > MAX_MEAN_BANK_DEG) return null;
  if (!hasYawEvidence) return null;

  const phaseCounts = new Map<string, number>();
  for (const sample of episodeSamples) {
    if (!sample.phase) continue;
    phaseCounts.set(sample.phase, (phaseCounts.get(sample.phase) || 0) + 1);
  }
  const phase = [...phaseCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    start_ts: startTs,
    end_ts: endTs,
    duration_ms: durationMs,
    phase,
    cycles: bankRun.length / 2,
    sample_count: episodeSamples.length,
    max_bank_deg: Math.round(maxBankDeg * 10) / 10,
    max_yaw_rate_deg_s: maxYawRate > 0 ? Math.round(maxYawRate * 10) / 10 : null,
    max_sideslip_deg: maxSideslip > 0 ? Math.round(maxSideslip * 10) / 10 : null,
  };
}

function confidenceForEpisode(episode: DutchRollEpisode): 'LOW' | 'MEDIUM' | 'HIGH' {
  const yawStrong = (episode.max_yaw_rate_deg_s ?? 0) >= 1.2 || (episode.max_sideslip_deg ?? 0) >= 1.5;
  if (episode.duration_ms >= 20000 && episode.cycles >= 3 && yawStrong) return 'HIGH';
  if (episode.duration_ms >= 14000 && episode.cycles >= 2.5) return 'MEDIUM';
  return 'LOW';
}

function detectDutchRollSummary(rows: DutchRollInputRow[]): DutchRollSummary | null {
  const samples = rows.map(isQualifyingAirlinerSample).filter(Boolean) as DutchRollSample[];
  if (samples.length < MIN_SAMPLE_COUNT) return null;

  const episodes: DutchRollEpisode[] = [];
  for (const segment of splitSegments(samples)) {
    const bankFlips = buildFlipTimes(segment, 'bankDeg', BANK_DEADBAND_DEG);
    const yawDeadband = segment.some((sample) => sample.yawRateDegS !== null)
      ? YAW_RATE_DEADBAND_DEG_S
      : SIDESLIP_DEADBAND_DEG;
    const yawFlips = buildFlipTimes(segment, 'yawSignal', yawDeadband);

    for (const bankRun of buildFlipRuns(bankFlips)) {
      const episode = summarizeEpisode(segment, bankRun, yawFlips);
      if (episode) episodes.push(episode);
    }
  }

  if (!episodes.length) return null;

  episodes.sort((a, b) => b.duration_ms - a.duration_ms || b.cycles - a.cycles);
  const strongest = episodes[0];
  return {
    detected: true,
    confidence: confidenceForEpisode(strongest),
    episodes: episodes.length,
    max_duration_ms: Math.round(strongest.duration_ms),
    max_bank_deg: strongest.max_bank_deg,
    max_yaw_rate_deg_s: strongest.max_yaw_rate_deg_s,
    max_sideslip_deg: strongest.max_sideslip_deg,
    cycles: Math.round(strongest.cycles * 10) / 10,
    start_ts: Math.round(strongest.start_ts),
    end_ts: Math.round(strongest.end_ts),
    phase: strongest.phase,
    sample_count: strongest.sample_count,
  };
}

module.exports = { detectDutchRollSummary };

export {};
