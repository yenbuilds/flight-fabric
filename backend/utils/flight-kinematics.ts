// Pure helpers for basic kinematics derived from telemetry.
//
// Safe to run in the real-time loop because it only normalizes/derives
// directly from current/previous samples (no intent inference or scoring).

const { rad2deg } = require('./units.js') as { rad2deg: (rad: number) => number };

export type IasTrendInput = {
  ias: number;
  previousIAS: number;
};

export type IasTrendResult = {
  trend: number;
  nextPreviousIAS: number;
};

export type PitchBankRatesInput = {
  previousPitch: number;
  previousBank: number;
  pitch: number;
  bank: number;
  dtSeconds: number;
};

export type PitchBankRatesResult = {
  pitchRateDeg: number;
  bankRateDeg: number;
  nextPreviousPitch: number;
  nextPreviousBank: number;
};

export function computeIasTrend({ ias, previousIAS }: IasTrendInput): IasTrendResult {
  const trend = ias - previousIAS;
  return {
    trend,
    nextPreviousIAS: ias,
  };
}

export function computePitchBankRates({
  previousPitch,
  previousBank,
  pitch,
  bank,
  dtSeconds,
}: PitchBankRatesInput): PitchBankRatesResult {
  const pitchRate = (pitch - previousPitch) / dtSeconds;
  const bankRate = (bank - previousBank) / dtSeconds;

  return {
    pitchRateDeg: rad2deg(pitchRate),
    bankRateDeg: rad2deg(bankRate),
    nextPreviousPitch: pitch,
    nextPreviousBank: bank,
  };
}
