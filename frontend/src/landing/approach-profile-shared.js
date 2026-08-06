export const GATE_ALTITUDE_FT = 1000;
export const HIGH_SINK_RATE_FPM = -1000;
export const MIN_PROFILE_POINTS = 5;
export const MIN_VALID_POINTS = 3;
export const DEFAULT_PITCH_DEG = 3;

export const COLORS = {
  success: '#00e070',
  warning: '#fbbf24',
  danger: '#ef4444',
  neutral: '#e2e8f0',
};

export function gradeToColor(grade) {
  if (!grade) return COLORS.neutral;
  if (grade === 'Outstanding' || grade === 'Good') return COLORS.success;
  if (grade === 'Acceptable' || grade === 'Marginal') return COLORS.warning;
  return COLORS.danger;
}
