// Shared geometry for the Airbus-style virtual throttle quadrant.
//
// The quadrant is drawn as a vertical stack of rows: one row per forward
// detent (TOGA at the top, IDLE at the bottom) followed by a shorter, locked
// reverse zone. Lever knobs are placed by mapping a raw lever readback onto
// that row stack, so a lever sitting exactly on a detent lands on the centre
// of that detent's gate and a lever between detents is drawn between gates.

export const THROTTLE_FORWARD_ROW_UNITS = 1;
export const THROTTLE_REVERSE_ROW_UNITS = 2 / 3;

// Fractions of the reverse row (0 = top of the row, 1 = bottom) where the two
// reverse readback positions are drawn.
const REVERSE_IDLE_ROW_FRACTION = 0.32;
const FULL_REVERSE_ROW_FRACTION = 0.78;

function finiteOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Total quadrant height in row units for a quadrant with the given number of
 * forward detents.
 */
function throttleQuadrantTotalUnits(forwardDetentCount) {
  return forwardDetentCount * THROTTLE_FORWARD_ROW_UNITS + THROTTLE_REVERSE_ROW_UNITS;
}

/**
 * Build the piecewise-linear anchors that map a raw lever readback to a
 * vertical offset (in row units from the top of the quadrant).
 *
 * `detents` must be ordered from the top gate to the bottom gate (TOGA first,
 * IDLE last). `reverse` gives the raw readback values for reverse idle and
 * full reverse; either may be omitted when the aircraft does not report them.
 */
export function buildThrottleQuadrantAnchors(detents, options = {}) {
  const rawKey = options.rawKey || 'angle';
  const anchors = [];
  detents.forEach((detent, index) => {
    const raw = finiteOrNull(detent?.[rawKey]);
    if (raw === null) return;
    anchors.push({ raw, units: index * THROTTLE_FORWARD_ROW_UNITS + THROTTLE_FORWARD_ROW_UNITS / 2 });
  });
  const reverseTop = detents.length * THROTTLE_FORWARD_ROW_UNITS;
  const reverseIdle = finiteOrNull(options.reverse?.idle);
  if (reverseIdle !== null) {
    anchors.push({ raw: reverseIdle, units: reverseTop + THROTTLE_REVERSE_ROW_UNITS * REVERSE_IDLE_ROW_FRACTION });
  }
  const fullReverse = finiteOrNull(options.reverse?.full);
  if (fullReverse !== null) {
    anchors.push({ raw: fullReverse, units: reverseTop + THROTTLE_REVERSE_ROW_UNITS * FULL_REVERSE_ROW_FRACTION });
  }
  // Anchors are interpolated along the raw axis, so keep them sorted by raw
  // value regardless of whether the aircraft reports larger numbers at TOGA
  // (FlyByWire angles, Fenix positions) or the other way round.
  anchors.sort((a, b) => a.raw - b.raw);
  return Object.freeze(anchors.map((anchor) => Object.freeze(anchor)));
}

/**
 * Map a raw lever readback onto a percentage of the quadrant's height
 * (0 = top edge, 100 = bottom edge). Returns null when the readback is not a
 * finite number or there are no anchors to interpolate against. Values outside
 * the anchored span clamp to the nearest gate so a lever never leaves the
 * drawn quadrant.
 */
export function throttleQuadrantTravelPercent(value, anchors, forwardDetentCount) {
  const raw = finiteOrNull(value);
  if (raw === null || !Array.isArray(anchors) || anchors.length === 0) return null;
  const total = throttleQuadrantTotalUnits(forwardDetentCount);
  if (!(total > 0)) return null;

  let units;
  if (raw <= anchors[0].raw) {
    units = anchors[0].units;
  } else if (raw >= anchors[anchors.length - 1].raw) {
    units = anchors[anchors.length - 1].units;
  } else {
    units = anchors[anchors.length - 1].units;
    for (let index = 0; index < anchors.length - 1; index += 1) {
      const lower = anchors[index];
      const upper = anchors[index + 1];
      if (raw >= lower.raw && raw <= upper.raw) {
        const span = upper.raw - lower.raw;
        const ratio = span === 0 ? 0 : (raw - lower.raw) / span;
        units = lower.units + (upper.units - lower.units) * ratio;
        break;
      }
    }
  }
  const percent = (units / total) * 100;
  return Math.min(100, Math.max(0, Number(percent.toFixed(3))));
}

/**
 * Short text for a lever knob: "ENG 1" becomes "1", "L" stays "L".
 */
export function throttleKnobGlyph(label, index) {
  const text = typeof label === 'string' ? label.trim() : '';
  const stripped = text.replace(/^eng(?:ine)?\s*/i, '').trim();
  if (stripped.length >= 1 && stripped.length <= 2) return stripped.toUpperCase();
  return String(index + 1);
}
