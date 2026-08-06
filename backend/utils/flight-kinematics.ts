// Pure helpers for basic kinematics derived from telemetry.
//
// Safe to run in the real-time loop because it only normalizes/derives
// directly from current/previous samples (no intent inference or scoring).

const rates = require('./rates.js') as typeof import('./rates');

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
  const { pitchRateDeg, bankRateDeg } = rates.computeRates(
    previousPitch,
    previousBank,
    pitch,
    bank,
    dtSeconds,
  );

  return {
    pitchRateDeg,
    bankRateDeg,
    nextPreviousPitch: pitch,
    nextPreviousBank: bank,
  };
}
