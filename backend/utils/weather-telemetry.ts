'use strict';

function finiteNumberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function sanitizeSeaLevelPressureMb(value: unknown): number | null {
  const numeric = finiteNumberOrNull(value);
  if (numeric == null) return null;
  return numeric >= 800 && numeric <= 1100 ? numeric : null;
}

function sanitizeVisibilityM(value: unknown): number | null {
  const numeric = finiteNumberOrNull(value);
  if (numeric == null) return null;
  return numeric >= 0 && numeric <= 200_000 ? numeric : null;
}

function sanitizePrecipRateMm(value: unknown): number | null {
  const numeric = finiteNumberOrNull(value);
  if (numeric == null) return null;
  if (numeric < 0) return numeric >= -0.5 ? 0 : null;
  return numeric <= 500 ? numeric : null;
}

function sanitizePrecipState(value: unknown): number | null {
  const numeric = finiteNumberOrNull(value);
  if (numeric == null) return null;
  const rounded = Math.round(numeric);
  if (Math.abs(numeric - rounded) > 0.001) return null;
  return rounded >= 0 && rounded <= 15 ? rounded : null;
}

module.exports = {
  sanitizePrecipRateMm,
  sanitizePrecipState,
  sanitizeSeaLevelPressureMb,
  sanitizeVisibilityM,
};

export {};
