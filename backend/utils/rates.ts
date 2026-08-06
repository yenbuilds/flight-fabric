// Centralizes pitch/bank rate computation in deg/sec, preserving behavior.

const { rad2deg } = require('./helpers.js') as { rad2deg: (rad: number) => number };

export type RatesResult = {
  pitchRateDeg: number;
  bankRateDeg: number;
};

/**
 * Compute pitch and bank rates in deg/sec.
 */
export function computeRates(
  prevPitchRad: number,
  prevBankRad: number,
  pitchRad: number,
  bankRad: number,
  dtSeconds: number,
): RatesResult {
  const pitchRate = (pitchRad - prevPitchRad) / dtSeconds;
  const bankRate = (bankRad - prevBankRad) / dtSeconds;

  return {
    pitchRateDeg: rad2deg(pitchRate),
    bankRateDeg: rad2deg(bankRate),
  };
}
