// =========================================================================
// SINGLE SOURCE OF TRUTH for aviation value reference frames.
// =========================================================================
//
// Use field names that include the reference frame/unit before comparing:
// - hdg_true_deg vs hdg_mag_deg
// - wind_dir_true_deg vs wind_dir_mag_deg
// - alt_msl_ft vs alt_agl_ft vs ra_ft
// - distance_nm vs distance_ft vs distance_deg
//
// Domain comparisons should convert to a canonical frame at the boundary and
// then call helpers from this file. This prevents apples-to-oranges comparisons
// such as magnetic aircraft heading against true runway geometry.
// =========================================================================

type HeadingInput = Record<string, unknown> | null | undefined;

function isBlank(value: unknown): boolean {
  return value == null || value === '';
}

export function finiteNumberOrNull(value: unknown): number | null {
  if (isBlank(value)) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const numeric = finiteNumberOrNull(value);
    if (numeric != null) return numeric;
  }
  return null;
}

export function normalizeHeadingDegrees(value: unknown): number | null {
  const numeric = finiteNumberOrNull(value);
  if (numeric == null) return null;
  return ((numeric % 360) + 360) % 360;
}

// Project convention: magvar_deg is positive when magnetic north is west of
// true north, matching MSFS. Therefore magnetic = true + magvar and
// true = magnetic - magvar.
export function deriveTrueHeadingFromMagnetic(
  magneticHeadingDeg: unknown,
  magvarDeg: unknown,
): number | null {
  const magnetic = normalizeHeadingDegrees(magneticHeadingDeg);
  const magvar = finiteNumberOrNull(magvarDeg);
  return magnetic != null && magvar != null ? normalizeHeadingDegrees(magnetic - magvar) : null;
}

export function deriveMagneticHeadingFromTrue(
  trueHeadingDeg: unknown,
  magvarDeg: unknown,
): number | null {
  const trueHeading = normalizeHeadingDegrees(trueHeadingDeg);
  const magvar = finiteNumberOrNull(magvarDeg);
  return trueHeading != null && magvar != null ? normalizeHeadingDegrees(trueHeading + magvar) : null;
}

export function headingDifferenceDegrees(leftHeadingDeg: unknown, rightHeadingDeg: unknown): number | null {
  const left = normalizeHeadingDegrees(leftHeadingDeg);
  const right = normalizeHeadingDegrees(rightHeadingDeg);
  if (left == null || right == null) return null;

  let diff = left - right;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return diff;
}

export function roundedHeadingDifferenceDegrees(
  leftHeadingDeg: unknown,
  rightHeadingDeg: unknown,
  precision = 1,
): number | null {
  const diff = headingDifferenceDegrees(leftHeadingDeg, rightHeadingDeg);
  if (diff == null) return null;

  const factor = 10 ** Math.max(0, precision);
  return Math.round(diff * factor) / factor;
}

export function getMagvarDeg(input: HeadingInput): number | null {
  return firstFiniteNumber(
    input?.magvar_deg,
    input?.magvarDeg,
    input?.magvar,
  );
}

export function getAircraftTrueHeadingDeg(input: HeadingInput): number | null {
  if (!input) return null;

  return normalizeHeadingDegrees(firstFiniteNumber(
    input.hdg_true_deg,
    input.hdgTrueDeg,
    input.true_heading_deg,
    input.trueHeadingDeg,
    input.heading_true_deg,
    input.headingTrueDeg,
  )) ?? deriveTrueHeadingFromMagnetic(
    firstFiniteNumber(
      input.hdg_mag_deg,
      input.hdgMagDeg,
      input.heading_mag_deg,
      input.headingMagDeg,
    ),
    getMagvarDeg(input),
  );
}

export function getRunwayTrueHeadingDeg(input: HeadingInput): number | null {
  if (!input) return null;

  return normalizeHeadingDegrees(firstFiniteNumber(
    input.heading_true_deg,
    input.headingTrueDeg,
    input.runway_heading_true_deg,
    input.runway_heading,
    input.runwayHeading,
    // Legacy alias retained by runway-database for compatibility. New code
    // should prefer heading_true_deg so the reference frame is visible.
    input.heading,
  ));
}
