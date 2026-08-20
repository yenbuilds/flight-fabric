import { buildLandingPresentation } from './scoring.js';
import { buildLandingWindPresentation } from './wind.js';

/**
 * Approach profile renderer
 * Shared approach profile SVG renderer.
 *
 * Builds a side-on approach diagram showing:
 *   - Flight path (altitude vs distance-integrated approach axis)
 *   - 3-degree glideslope reference anchored at runway threshold
 *   - Runway surface with centerline dashes
 *   - First-1,000-ft target highlighted zone
 *   - Touchdown point with distance label
 *   - Stability gate (1,000 ft above threshold, RA fallback) marker
 *   - Aircraft silhouette at touchdown (rotated to pitch)
 *   - Touchdown-rate and scoped landing-fact annotations
 *   - High-sink-rate highlights (red segments)
 *   - Short-landing warning
 *
 * USAGE (both the app runtime and the timeline page):
 *   const svg = approachProfileApi.buildSvg(approachProfile, landingData);
 *   container.innerHTML = svg;
 *
 * ── Y-AXIS: HEIGHT ABOVE THRESHOLD (preferred) vs RA (fallback) ──────────
 *
 * The preferred y-axis is runway-relative geometric height. Each new profile
 * sample carries `profileAltitudeFt`, selected once for the complete approach,
 * and the landing record carries `runwayReferenceElevFt` (`thresholdElevFt` is
 * retained as a compatibility alias). New recordings prefer PLANE ALTITUDE so
 * cockpit barometer changes and atmospheric pressure changes cannot create a
 * fake climb. Older recordings use calibrated or legacy indicated altitude.
 *
 * If no single absolute-altitude source covers the approach, or the runway
 * lookup failed, the renderer falls back to `raFt` (radio altitude) for the
 * whole profile. A gap inside a locked source is omitted rather than filled
 * from another datum, with its elapsed time carried to the next valid sample.
 * Radio altitude is height-above-the-ground-directly-
 * below, so terrain undulations under the approach corridor (a valley, river
 * crossing, dropoff before the runway, etc.) appear as misleading "climbs"
 * or "dives" in the profile even though the aircraft was on a steady
 * geometric descent. Use the AGL fallback only when MSL data is unavailable.
 *
 * ── COORDINATE SYSTEM NOTES ────────────────────────────────────────────────
 *
 * The chart contains TWO separate x-axis coordinate systems that must not be
 * conflated:
 *
 * 1. FLIGHT PATH AXIS  [padL → tdX]
 *    The flight path is drawn using xScale(i), which maps cumulative ground
 *    distance (integrated from GS × dt) to pixels.  The final sample (touchdown)
 *    always lands at pixel x = tdX.  All flight-path geometry (the blue line,
 *    red sink-rate overlays, 3° glideslope) must use this axis.
 *
 * 2. RUNWAY DIAGRAM AXIS  [rwyStartX → rwyEndX]
 *    The runway, threshold markers, 1,000-ft target box, and touchdown dot are laid out as
 *    fixed visual fractions of the plot width (RUNWAY_REPR_FT = 8000 ft assumed).
 *    threshX lives here.  tdX is shared between both systems (it is both the last
 *    flight-path pixel and the touchdown dot on the runway diagram).
 *
 * The two systems share exactly ONE pixel: tdX (touchdown).  Using a position
 * from the runway diagram axis in flight-path axis calculations — or vice versa —
 * will silently produce wrong results.
 *
 * 3° GLIDESLOPE ANCHOR
 *    The ILS/PAPI glideslope is a fixed ground beam originating at the runway
 *    threshold, independent of where any aircraft lands.  Its anchor must be
 *    expressed in the FLIGHT PATH AXIS:
 *
 *      gsEndX = tdX - tdz.distanceFt × xPxPerFt
 *
 *    i.e. the threshold is tdz.distanceFt feet "before" the touchdown point on
 *    the cumulative-distance axis.  Do not use threshX (runway diagram axis) as
 *    the anchor — that was a previous bug that caused the glideslope to appear
 *    shallower than reality for long-distance landings (e.g. 8 500 ft touchdown
 *    put the anchor ~100 px too far right, making a true 3° beam look like ~1°).
 *
 *    Slope conversion:  tan(3°) gives ft-altitude per ft-distance.  To draw it
 *    correctly the slope must be scaled by the ratio of the two axis scales:
 *
 *      pixelSlope = tan(3°) × (yPxPerFt / xPxPerFt)
 *
 *    Without this, a raw tan(3°) pixel gradient would represent a wildly
 *    different angle depending on the chart's aspect ratio.
 *
 * TOUCHDOWN DISTANCE LABEL
 *    tdz.distanceFt is a float from the backend.  It must be passed through
 *    Math.round() before toLocaleString() to avoid labels like "8,527.315 ft".
 *
 * dtMs semantics
 *    Each point's `dtMs` is the elapsed time since the previous rendered
 *    point, rather than the gap between raw 10 Hz telemetry samples. The renderer
 *    integrates groundspeed × dt to derive `cumDistFt`, which sets every
 *    horizontal scale on the chart (xPxPerFt, the threshold anchor, and the
 *    glideslope's pixelSlope).
 *
 *    Both data paths must aggregate dt across downsampling:
 *      - Live: backend/stability/stability-runner.js → getApproachProfile()
 *      - Recorded: backend/events/timeline-generator.js → downsampleApproachProfile()
 *
 *    A previous bug emitted the raw per-sample dtMs (~100 ms) on every kept
 *    point, which compressed the horizontal axis by the downsample ratio
 *    (typically 5–10×), pushing the threshold off the left edge and making the
 *    flight path appear to fly *below* a too-shallow 3° beam.  The fallback
 *    `dtSec = 1` below is a last-resort guard only; correct rendering requires
 *    real dt values from the backend.
 *
 * ── TOP-DOWN (buildTopDownSvg) NOTES ───────────────────────────────────────
 *
 * CROSS-TRACK SIGN CONVENTION
 *    Positive crossTrack = LEFT of runway centerline (signed feet).
 *    The yScale `centerY - dev*scale` puts positive at the top of the plot
 *    where the "L" label sits; the "R" label sits at the bottom.
 *
 *    For runway heading θ (geographic, 0=N, 90=E):
 *      along = (cos θ, sin θ)        in (north, east) components
 *      LEFT  = (sin θ, -cos θ)       (90° CCW rotation of along)
 *
 *    The backend convention uses the opposite sign: lateral_offset_side='right' means
 *    east of centerline (positive lateral_offset_ft).  The renderer maps:
 *      side='left'  → +|lateralOffsetFt|   (top of plot)
 *      side='right' → -|lateralOffsetFt|   (bottom of plot)
 *
 * TOUCHDOWN LATERAL OFFSET
 *    The GPS reference origin is the touchdown point itself, so by
 *    construction crossTrack[last] would equal 0 — i.e. the touchdown dot
 *    would always sit on the centerline regardless of the actual offset.
 *    The renderer must shift the entire crossTrack array by the signed
 *    `tdz.lateralOffsetFt` so the touchdown dot lands at its true offset.
 *    Without this shift, the dot's text label ("12 ft R") and the dot's
 *    geometric position contradict each other.
 *
 * UNIFIED FT/PX SCALE
 *    Same discipline as the side view: when GPS data is available, the
 *    flight-path X axis and the runway-diagram X axis share a single
 *    ft/px scale, otherwise the threshold pixel won't line up with the
 *    flight-path point that crossed the threshold.  Layout in the GPS path:
 *
 *      totalFt   = approachLenFt + runwayLengthFt
 *      xPxPerFt  = usablePx / totalFt
 *      tdX       = leftMargin + approachLenFt × xPxPerFt
 *      rwyStartX = tdX - tdz.distanceFt × xPxPerFt   (threshold)
 *      rwyEndX   = rwyStartX + runwayLengthFt × xPxPerFt
 *
 *    The no-GPS fallback cannot do this (along-track is sample-index, not
 *    feet), so it keeps the legacy ratio-based layout — geometric accuracy
 *    is unrecoverable without GPS.
 */
// ES module — strict mode is implicit in modules.
import {
  COLORS,
  DEFAULT_PITCH_DEG,
  GATE_ALTITUDE_FT,
  gradeToColor,
  HIGH_SINK_RATE_FPM,
  MIN_PROFILE_POINTS,
  MIN_VALID_POINTS,
} from './approach-profile-shared.js';

const PROFILE_ALTITUDE_SOURCE_COVERAGE = 0.8;
const RUNWAY_RELATIVE_ALTITUDE_SOURCES = new Set([
  'selected',
  'plane',
  'calibrated',
  'indicated',
]);

function hasProfileCoverage(profile, valueOf) {
  if (!Array.isArray(profile) || profile.length === 0) return false;
  const finiteCount = profile.reduce(
    (count, point) => count + (Number.isFinite(valueOf(point)) ? 1 : 0),
    0,
  );
  const operationalTailSize = Math.min(5, profile.length);
  return finiteCount >= operationalTailSize
    && finiteCount / profile.length >= PROFILE_ALTITUDE_SOURCE_COVERAGE
    && profile.slice(-operationalTailSize).every((point) => Number.isFinite(valueOf(point)));
}

/**
 * Resolve one vertical datum for the complete rendered approach.
 *
 * New payloads carry an explicit backend-locked source. The coverage-based
 * branch is only for older recordings that predate profileAltitudeSource.
 * A missing point stays missing; it must never fall through to another datum.
 */
function createProfileHeightResolver(profile, runwayReferenceElevFt) {
  const points = Array.isArray(profile) ? profile : [];
  const explicitSource = points.find((point) => (
    point && (
      RUNWAY_RELATIVE_ALTITUDE_SOURCES.has(point.profileAltitudeSource)
      || point.profileAltitudeSource === 'radio'
    )
  ))?.profileAltitudeSource || null;

  let source = explicitSource;
  if (!source) {
    if (hasProfileCoverage(points, point => point?.profileAltitudeFt)) source = 'selected';
    else if (hasProfileCoverage(points, point => point?.profileAltMslFt)) source = 'selected';
    else if (hasProfileCoverage(points, point => point?.altPlaneFt)) source = 'plane';
    else if (hasProfileCoverage(points, point => point?.altCalibratedFt)) source = 'calibrated';
    else if (hasProfileCoverage(points, point => point?.altMslFt)) source = 'indicated';
    else source = 'radio';
  }

  const referenceElevationFt = Number.isFinite(runwayReferenceElevFt)
    ? runwayReferenceElevFt
    : null;
  const usesRunwayReference = referenceElevationFt != null && source !== 'radio';

  function selectedAltitudeOf(point) {
    if (!point || source === 'radio') return null;
    if (source === 'selected') {
      if (Number.isFinite(point.profileAltitudeFt)) return point.profileAltitudeFt;
      return Number.isFinite(point.profileAltMslFt) ? point.profileAltMslFt : null;
    }
    if (Number.isFinite(point.profileAltitudeFt)) return point.profileAltitudeFt;
    if (Number.isFinite(point.profileAltMslFt)) return point.profileAltMslFt;
    if (source === 'plane') return Number.isFinite(point.altPlaneFt) ? point.altPlaneFt : null;
    if (source === 'calibrated') return Number.isFinite(point.altCalibratedFt) ? point.altCalibratedFt : null;
    return Number.isFinite(point.altMslFt) ? point.altMslFt : null;
  }

  function heightOf(point) {
    if (usesRunwayReference) {
      const altitudeFt = selectedAltitudeOf(point);
      return altitudeFt == null ? null : altitudeFt - referenceElevationFt;
    }
    return Number.isFinite(point?.raFt) ? point.raFt : null;
  }

  return {
    heightOf,
    selectedAltitudeOf,
    source,
    usesRunwayReference,
  };
}

function filterProfileByHeight(profile, heightOf) {
  const points = [];
  let elapsedSinceValidMs = 0;

  for (const point of Array.isArray(profile) ? profile : []) {
    const dtMs = Number.isFinite(point?.dtMs) && point.dtMs > 0 ? point.dtMs : 0;
    elapsedSinceValidMs += dtMs;
    if (!Number.isFinite(heightOf(point))) continue;

    points.push({
      ...point,
      // When an unavailable locked-source sample is omitted, preserve its
      // elapsed time on the next usable point. Otherwise GS × dt shrinks the
      // horizontal approach distance and distorts the glideslope geometry.
      dtMs: elapsedSinceValidMs > 0 ? elapsedSinceValidMs : point?.dtMs,
    });
    elapsedSinceValidMs = 0;
  }

  return points;
}

function escapeSvgText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeSvgIdSuffix(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '');
}

function normalizeSignedDegrees(value) {
  if (!Number.isFinite(value)) return null;
  const normalized = (((value + 180) % 360) + 360) % 360 - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function safeSvgColor(value, fallback = COLORS.neutral) {
  const text = String(value || '').trim();
  if (/^#[0-9A-Fa-f]{3,8}$/.test(text)) return text;
  if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(text)) return text;
  return fallback;
}

function lateralSideCode(value) {
  const first = String(value || '').trim().charAt(0).toLowerCase();
  return first === 'l' || first === 'r' || first === 'c' ? first : '';
}
// ── Shared constants (aviation thresholds) ──────────────────────────────
// Keep in sync with stability-runner.js & timeline-generator.js.

// ── Grade → colour mapping ─────────────────────────────────────────────
// Tailwind palette values used project-wide.

/**
 * Resolve a grade string to its display colour.
 * @param {string} [grade]
 * @returns {string} CSS hex colour
 */

/**
 * Build the approach profile SVG string.
 *
 * @param {Array<{raFt:number, vsFpm:number, iasKts:number, gsKts:number|null, pitchDeg:number|null, bankDeg:number|null}>} profile
 *   Downsampled approach samples (from stability scorer or CSV reconstruction).
 * @param {object} [landing]
 *   Optional landing data for touchdown annotations.
 * @param {object} [landing.touchdownDistance]
 * @param {number} [landing.touchdownDistance.distanceFt]
 * @param {string} [landing.touchdownDistance.grade]
 * @param {number} [landing.vs]           - V/S at touchdown (fpm).
 * @param {number} [landing.vs_fpm]       - Alternate key used by timeline events.
 * @param {string} [landing.grade]        - Touchdown-rate grade string.
 * @param {string} [landing.color]        - Grade colour (CSS).
 * @param {number} [landing.pitchDeg]     - Pitch at touchdown.
 * @param {number} [landing.pitch_deg]    - Alternate key used by timeline events.
 * @param {boolean}[landing.shortLanding] - Landed short of threshold.
 * @param {boolean}[landing.runwayExcursion] - Runway excursion recorded after touchdown.
 * @param {string} [opts.idSuffix]        - Suffix appended to SVG IDs to allow
 *                                          multiple independent instances on one page.
 * @returns {string} Complete SVG markup, or '' if profile is too small.
 */
function buildSvg(profile, landing, opts) {
  if (!Array.isArray(profile) || profile.length < MIN_PROFILE_POINTS) return '';

  // Accept both real-time and timeline field names
  const ld = landing || {};
  const vs = ld.vs != null ? ld.vs : ld.vs_fpm;
  const pitchDeg = ld.pitchDeg != null ? ld.pitchDeg : ld.pitch_deg;
  const tdz = ld.touchdownDistance || null;
  const presentation = buildLandingPresentation(ld);
  const idSuffix = sanitizeSvgIdSuffix(opts && opts.idSuffix);

  // ── Y-axis: height above threshold (preferred) vs RA (fallback) ──────
  // Plot the backend's approach-locked altitude reference relative to the
  // runway elevation datum. Falls back to RA for older/incomplete data.
  const runwayReferenceElevFt = Number.isFinite(ld.runwayReferenceElevFt)
    ? ld.runwayReferenceElevFt
    : (Number.isFinite(ld.thresholdElevFt) ? ld.thresholdElevFt : null);
  const heightResolver = createProfileHeightResolver(profile, runwayReferenceElevFt);
  const altOf = heightResolver.heightOf;
  const usingAglFallback = !heightResolver.usesRunwayReference;

  // Filter to valid altitude samples (under whichever axis we're using)
  const points = filterProfileByHeight(profile, altOf);
  if (points.length < MIN_VALID_POINTS) return '';

  const maxAlt = Math.max(...points.map(p => altOf(p)));

  // Layout constants
  const W = 720;
  const H = 240;
  const padL = 50;
  const padR = 40;
  const padT = 24;
  const padB = 44;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const rwyY = padT + plotH;
  const rwyH = 14;

  // altMax — scale to flight path only
  const altMax = Math.max(maxAlt * 1.12, 200);
  const yScale = (alt) => padT + plotH - (alt / altMax) * plotH;

  // ── Runway & touchdown geometry (computed first so flight path can target it) ──
  const rwyFraction = 0.28;                            // runway = right 28 % of plot
  const rwyStartX = padL + plotW * (1 - rwyFraction);
  const rwyEndX   = padL + plotW;
  const rwyW      = rwyEndX - rwyStartX;
  const threshX   = rwyStartX;                         // threshold at runway left edge

  // Ideal touchdown target. The backend's formal TDZ flag extends to 3,000 ft.
  const RUNWAY_REPR_FT = 8000;
  const tdzFraction = 1000 / RUNWAY_REPR_FT;          // 1000 / 8000 = 0.125
  const tdzX = threshX + 14;
  const tdzW = rwyW * tdzFraction;

  // Touchdown X on the runway — based on distance when known
  let tdX;
  if (tdz && tdz.distanceFt != null && Math.abs(tdz.distanceFt) <= 15000) {
    const frac = Math.min(tdz.distanceFt / RUNWAY_REPR_FT, 0.95);
    tdX = threshX + 14 + frac * (rwyW - 18);
  } else {
    tdX = tdzX + tdzW * 0.5;                           // default: centre of target
  }
  const tdY = rwyY;

  // Flight-path X scale: use cumulative distance in FEET (GS × dt integrated)
  // so VRE's variable sample rates don't distort the horizontal axis.
  // Convert knots × seconds → feet: kts × (6076.12 / 3600) ≈ kts × 1.68781
  const KTS_TO_FPS = 1.68781;
  const cumDistFt = [0];
  for (let i = 1; i < points.length; i++) {
    const spd = (typeof points[i].gsKts === 'number' && points[i].gsKts > 10)
      ? points[i].gsKts
      : (typeof points[i].iasKts === 'number' && points[i].iasKts > 10 ? points[i].iasKts : 100);
    const dtSec = (typeof points[i].dtMs === 'number' && points[i].dtMs > 0)
      ? points[i].dtMs / 1000
      : 1; // fallback: assume 1 s between samples
    cumDistFt.push(cumDistFt[i - 1] + spd * dtSec * KTS_TO_FPS);
  }
  const totalDistFt = cumDistFt[cumDistFt.length - 1] || 1;
  const xScale = (i) => padL + (cumDistFt[i] / totalDistFt) * (tdX - padL);

  // --- Build SVG ---
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="w-full" style="max-height: 260px;">`;

  svg += `<defs>
    <linearGradient id="skyGrad${idSuffix}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0c1929" />
      <stop offset="100%" stop-color="#152238" />
    </linearGradient>
    <linearGradient id="pathGrad${idSuffix}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#60a5fa" stop-opacity="0.6" />
      <stop offset="100%" stop-color="#38bdf8" />
    </linearGradient>
    <linearGradient id="pathFill${idSuffix}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.15" />
      <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.02" />
    </linearGradient>
    <filter id="glowTd${idSuffix}" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="3" result="blur" />
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>`;

  // Background
  svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#skyGrad${idSuffix})" rx="8" />`;

  // --- Altitude grid lines ---
  const altSteps = [0, 200, 500, 1000, 1500];
  for (const alt of altSteps.filter(a => a <= altMax * 0.95)) {
    const y = yScale(alt);
    if (y < padT || y > rwyY) continue;
    svg += `<line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" stroke="#334155" stroke-width="0.5" stroke-dasharray="4,4" />`;
    svg += `<text x="${padL - 6}" y="${y + 3}" text-anchor="end" fill="#64748b" font-size="10" font-family="system-ui, sans-serif">${alt}</text>`;
  }
  svg += `<text x="12" y="${padT + plotH / 2}" text-anchor="middle" fill="#475569" font-size="9" font-family="system-ui, sans-serif" transform="rotate(-90, 12, ${padT + plotH / 2})">Altitude (${usingAglFallback ? 'ft RA' : 'ft above rwy ref'})</text>`;

  // --- 3-degree glideslope reference ---
  // The ILS/PAPI glideslope is a fixed beam originating at the runway threshold,
  // independent of where any aircraft touches down.  The flight-path x-axis maps
  // cumulative distance to [padL → tdX], so the threshold in that coordinate space
  // is tdX minus the known touchdown distance.  Using the visual threshX marker
  // here would be wrong because it lives in a separate decorative runway coordinate
  // system that only agrees with the flight-path axis at the touchdown point.
  const gsAngleRad = 3 * Math.PI / 180;
  const xPxPerFt = (tdX - padL) / totalDistFt;   // px per ft of horizontal distance
  const yPxPerFt = plotH / altMax;                 // px per ft of altitude
  const pixelSlope = Math.tan(gsAngleRad) * yPxPerFt / xPxPerFt;

  // Anchor: threshold position inside the flight-path coordinate system.
  // If touchdown distance is known, compute it precisely; otherwise fall back
  // to the visual runway threshold marker (best-effort).
  const gsEndX = (tdz && tdz.distanceFt != null)
    ? tdX - tdz.distanceFt * xPxPerFt
    : threshX;
  const gsEndY = yScale(0);

  // Clip line so it stays inside plotting area (left and top bounds).
  const maxRunLeftPx = gsEndX - padL;
  const maxRiseToTopPx = gsEndY - padT;
  const maxRunFromTopPx = maxRiseToTopPx / pixelSlope;
  const gsRunPx = Math.min(maxRunLeftPx, maxRunFromTopPx);

  const gsStartX = gsEndX - gsRunPx;
  const gsStartY = gsEndY - gsRunPx * pixelSlope;
  svg += `<line x1="${gsStartX}" y1="${gsStartY}" x2="${gsEndX}" y2="${gsEndY}" stroke="#4ade80" stroke-width="1.2" stroke-opacity="0.35" stroke-dasharray="6,4" />`;
  svg += `<text x="${gsStartX + 4}" y="${gsStartY - 5}" fill="#4ade80" fill-opacity="0.5" font-size="9" font-family="system-ui, sans-serif">3°</text>`;

  // --- Stability gate ---
  // The horizontal line is drawn at y = 1000 in the same preferred units as
  // scoring: selected absolute altitude minus the runway elevation reference
  // when available, otherwise radio altitude.
  if (GATE_ALTITUDE_FT <= altMax) {
    const gateY = yScale(GATE_ALTITUDE_FT);
    svg += `<line x1="${padL}" y1="${gateY}" x2="${padL + plotW}" y2="${gateY}" stroke="#a78bfa" stroke-width="1" stroke-dasharray="3,3" stroke-opacity="0.5" />`;
    svg += `<text x="${padL + plotW - 2}" y="${gateY + 3}" text-anchor="end" fill="#a78bfa" fill-opacity="0.7" font-size="9" font-family="system-ui, sans-serif">GATE</text>`;
  }

  // --- Terrain surface (ground before runway) ---
  svg += `<rect x="${padL}" y="${rwyY}" width="${rwyStartX - padL}" height="${rwyH}" fill="#1a2a1a" rx="1" />`;
  for (let x = padL + 12; x < rwyStartX - 8; x += 18) {
    svg += `<line x1="${x}" y1="${rwyY + 3}" x2="${x + 3}" y2="${rwyY + rwyH - 3}" stroke="#2d4a2d" stroke-width="0.7" />`;
  }

  // --- Runway surface ---
  svg += `<rect x="${rwyStartX}" y="${rwyY}" width="${rwyW}" height="${rwyH}" fill="#1e293b" stroke="#334155" stroke-width="0.5" rx="2" />`;
  for (let x = rwyStartX + 14; x < rwyEndX - 14; x += 22) {
    svg += `<rect x="${x}" y="${rwyY + 6}" width="12" height="2" fill="#475569" rx="1" />`;
  }
  // Threshold bars
  svg += `<rect x="${threshX + 3}" y="${rwyY + 2}" width="3" height="${rwyH - 4}" fill="#94a3b8" rx="0.5" />`;
  svg += `<rect x="${threshX + 9}" y="${rwyY + 2}" width="3" height="${rwyH - 4}" fill="#94a3b8" rx="0.5" />`;
  svg += `<text x="${threshX + 6}" y="${rwyY + rwyH + 11}" text-anchor="middle" fill="#64748b" font-size="9" font-family="system-ui, sans-serif">THR</text>`;

  // First-1,000-ft target highlight
  svg += `<rect x="${tdzX}" y="${rwyY + 1}" width="${tdzW}" height="${rwyH - 2}" fill="#4ade80" fill-opacity="0.12" rx="1" />`;
  // Label matches the app's scoring definition (≤1000 ft = Outstanding / "Within first 1,000 ft").
  // The aviation TDZ is 3,000 ft; this narrower green box is the app's target zone, not the full TDZ.
  svg += `<text x="${tdzX + tdzW / 2}" y="${rwyY + rwyH + 11}" text-anchor="middle" fill="#4ade80" fill-opacity="0.6" font-size="8" font-family="system-ui, sans-serif">\u22641000 ft</text>`;

  // --- Flight path filled area ---
  let areaPath = `M ${xScale(0)} ${yScale(altOf(points[0]))}`;
  for (let i = 1; i < points.length; i++) {
    areaPath += ` L ${xScale(i)} ${yScale(altOf(points[i]))}`;
  }
  areaPath += ` L ${xScale(points.length - 1)} ${rwyY} L ${xScale(0)} ${rwyY} Z`;
  svg += `<path d="${areaPath}" fill="url(#pathFill${idSuffix})" />`;

  // --- Flight path line ---
  let pathD = `M ${xScale(0)} ${yScale(altOf(points[0]))}`;
  for (let i = 1; i < points.length; i++) {
    pathD += ` L ${xScale(i)} ${yScale(altOf(points[i]))}`;
  }
  svg += `<path d="${pathD}" fill="none" stroke="url(#pathGrad${idSuffix})" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`;

  // --- V/S colour highlights (red for high sink rate) ---
  for (let i = 1; i < points.length; i++) {
    const sampleVs = points[i].vsFpm;
    if (typeof sampleVs === 'number' && sampleVs < HIGH_SINK_RATE_FPM) {
      const x1 = xScale(i - 1);
      const y1 = yScale(altOf(points[i - 1]));
      const x2 = xScale(i);
      const y2 = yScale(altOf(points[i]));
      const opacity = Math.min(0.8, Math.abs(sampleVs - HIGH_SINK_RATE_FPM) / 1000 * 0.5 + 0.2);
      svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#ef4444" stroke-width="3" stroke-opacity="${opacity.toFixed(2)}" stroke-linecap="round" />`;
    }
  }

  // --- Touchdown marker ---
  let tdDistLabel = '';
  let tdDistColor = COLORS.warning;
  if (tdz && tdz.distanceFt != null && Math.abs(tdz.distanceFt) <= 15000) {
    tdDistLabel = `${Math.round(tdz.distanceFt).toLocaleString()} ft`;
    tdDistColor = gradeToColor(tdz.grade);
  }

  svg += `<line x1="${tdX}" y1="${tdY - 8}" x2="${tdX}" y2="${tdY + rwyH + 2}" stroke="${tdDistColor}" stroke-width="1.5" stroke-opacity="0.7" />`;
  svg += `<circle cx="${tdX}" cy="${tdY}" r="5" fill="${tdDistColor}" filter="url(#glowTd${idSuffix})" />`;
  svg += `<circle cx="${tdX}" cy="${tdY}" r="3" fill="#fff" />`;

  if (tdDistLabel) {
    svg += `<text x="${tdX}" y="${rwyY + rwyH + 22}" text-anchor="middle" fill="${tdDistColor}" font-size="10" font-weight="600" font-family="system-ui, sans-serif">${tdDistLabel}</text>`;
  }

  // --- Aircraft silhouette ---
  const acftPitch = (pitchDeg != null) ? pitchDeg : DEFAULT_PITCH_DEG;
  const acftRotation = -acftPitch;
  const acftX = tdX - 2;
  const acftY = tdY - 14;
  svg += `<g transform="translate(${acftX}, ${acftY}) rotate(${acftRotation.toFixed(1)})">`;
  svg += `<line x1="-12" y1="0" x2="12" y2="0" stroke="#e2e8f0" stroke-width="2" stroke-linecap="round" />`;
  svg += `<line x1="-3" y1="0" x2="-3" y2="-6" stroke="#e2e8f0" stroke-width="1.5" stroke-linecap="round" />`;
  svg += `<line x1="-3" y1="0" x2="-3" y2="6" stroke="#e2e8f0" stroke-width="1.5" stroke-linecap="round" />`;
  svg += `<line x1="-12" y1="0" x2="-12" y2="-4" stroke="#e2e8f0" stroke-width="1" stroke-linecap="round" />`;
  svg += `<circle cx="12" cy="0" r="1.2" fill="#e2e8f0" />`;
  svg += `</g>`;

  // --- V/S annotation ---
  if (vs != null) {
    const vsVal = Math.round(vs);
    const vsColor = safeSvgColor(presentation.touchdownColor || ld.color);
    svg += `<text x="${tdX + 14}" y="${acftY - 2}" fill="${vsColor}" font-size="10" font-weight="600" font-family="system-ui, sans-serif">${vsVal} fpm</text>`;
  }

  // --- Independent touchdown / approach / bounce / excursion facts ---
  let annotationY = acftY + 10;
  if (presentation.touchdownGrade && presentation.touchdownGrade !== '--') {
    const gradeColor = safeSvgColor(presentation.touchdownColor || ld.color);
    svg += `<text x="${tdX + 14}" y="${annotationY}" fill="${gradeColor}" font-size="9" font-weight="500" font-family="system-ui, sans-serif">TD RATE ${escapeSvgText(presentation.touchdownGrade)}</text>`;
    annotationY += 11;
  }
  const peerFacts = [
    presentation.approachText ? `APP ${presentation.approachText}` : null,
    presentation.bounceKnown ? `BNC ${presentation.bounceText}` : null,
  ].filter(Boolean);
  if (peerFacts.length > 0) {
    svg += `<text x="${tdX + 14}" y="${annotationY}" fill="#94a3b8" font-size="8" font-weight="500" font-family="system-ui, sans-serif">${escapeSvgText(peerFacts.join(' · '))}</text>`;
    annotationY += 10;
  }
  if (presentation.approachScoreText) {
    svg += `<text x="${tdX + 14}" y="${annotationY}" fill="#64748b" font-size="7" font-family="system-ui, sans-serif">${escapeSvgText(presentation.approachScoreText)}</text>`;
    annotationY += 10;
  }
  if (presentation.verdict.flags.runwayExcursion) {
    svg += `<text x="${tdX + 14}" y="${annotationY}" fill="#ef4444" font-size="8" font-weight="700" font-family="system-ui, sans-serif">RUNWAY EXCURSION</text>`;
  }

  // --- Short landing warning ---
  if (ld.shortLanding) {
    svg += `<text x="${padL + plotW / 2}" y="${padT + 14}" text-anchor="middle" fill="#ef4444" font-size="11" font-weight="700" font-family="system-ui, sans-serif">SHORT OF THRESHOLD</text>`;
  }

  // --- Legend ---
  const legY = H - 6;
  const legItems = [
    { x: padL, color: '#38bdf8', dash: false, label: 'Flight path' },
    { x: padL + 110, color: '#ef4444', dash: false, label: 'High sink rate' },
    { x: padL + 230, color: '#4ade80', dash: true,  label: '3° glideslope' },
    { x: padL + 350, color: '#a78bfa', dash: true,  label: 'Stability gate' },
  ];
  for (const it of legItems) {
    const da = it.dash ? ' stroke-dasharray="4,3"' : '';
    svg += `<line x1="${it.x}" y1="${legY}" x2="${it.x + 16}" y2="${legY}" stroke="${it.color}" stroke-width="2"${da} />`;
    svg += `<text x="${it.x + 20}" y="${legY + 3}" fill="#94a3b8" font-size="9" font-family="system-ui, sans-serif">${it.label}</text>`;
  }

  svg += '</svg>';
  return svg;
}

/**
 * Build a top-down approach SVG showing lateral track relative to runway.
 *
 * Primary method: uses lat/lon GPS data to compute real cross-track and
 * along-track deviation from the runway centerline (haversine + projection).
 * Fallback: integrates heading offset when GPS is unavailable.
 *
 * @param {Array<{raFt:number, headingDeg:number|null, bankDeg:number|null, iasKts:number, latDeg:number|null, lonDeg:number|null}>} profile
 * @param {object} [landing] - Landing data with runway info.
 * @param {number} [landing.runwayHdg] - Runway heading in degrees.
 * @param {string} [landing.runway] - Runway ID (e.g. "22L").
 * @param {object} [landing.touchdownDistance]
 * @param {number} [landing.touchdownDistance.lateralOffsetFt]
 * @param {string} [landing.touchdownDistance.lateralOffsetSide]
 * @param {string} [landing.touchdownDistance.lateralOffsetGrade]
 * @param {number} [landing.centerlineDev] - Heading deviation at touchdown (deg).
 * @param {number} [landing.windDirectionTrueDeg] - Meteorological wind-from bearing, degrees true.
 * @param {number} [landing.windSpeed] - Wind speed at touchdown, knots.
 * @param {number} [landing.crosswind] - Runway-relative crosswind; positive is from the right.
 * @param {object} [opts]
 * @param {string} [opts.idSuffix] - SVG ID suffix for multiple instances.
 * @returns {string} SVG markup or '' if insufficient data.
 */
function buildTopDownSvg(profile, landing, opts) {
  if (!Array.isArray(profile) || profile.length < MIN_PROFILE_POINTS) return '';

  const ld = landing || {};
  const idSuffix = sanitizeSvgIdSuffix(opts && opts.idSuffix);
  const runwayReferenceElevFt = Number.isFinite(ld.runwayReferenceElevFt)
    ? ld.runwayReferenceElevFt
    : (Number.isFinite(ld.thresholdElevFt) ? ld.thresholdElevFt : null);

  const { heightOf: gateHeightOf } = createProfileHeightResolver(profile, runwayReferenceElevFt);

  const points = filterProfileByHeight(profile, gateHeightOf);
  if (points.length < MIN_VALID_POINTS) return '';

  // Check if we have real GPS data (lat/lon)
  const hasGps = points.filter(p =>
    typeof p.latDeg === 'number' && Number.isFinite(p.latDeg) &&
    typeof p.lonDeg === 'number' && Number.isFinite(p.lonDeg)
  ).length > points.length * 0.5;

  const hasHeading = profile.some(p =>
    typeof p.headingDeg === 'number' && Number.isFinite(p.headingDeg)
  );

  // The flight-path renderer may estimate a runway axis from the runway ID or
  // the aircraft's final heading. A true-wind vector must not use either
  // fallback: mixing a true bearing with a magnetic designator (or an
  // aircraft heading) can put the arrow on the wrong side of the runway.
  const explicitRunwayHeadingTrueDeg = Number.isFinite(ld.runwayHdg)
    ? ((ld.runwayHdg % 360) + 360) % 360
    : null;

  // Runway heading: prefer explicit, else derive from runway ID, else use last heading
  let rwyHdg = null;
  if (typeof ld.runwayHdg === 'number') {
    rwyHdg = ld.runwayHdg;
  } else if (ld.runway) {
    const num = parseInt(ld.runway.replace(/[^0-9]/g, ''), 10);
    if (num > 0 && num <= 36) rwyHdg = (num * 10) % 360;
  }
  if (rwyHdg == null) {
    const withHdg = points.filter(p => typeof p.headingDeg === 'number');
    if (withHdg.length > 0) {
      const last5 = withHdg.slice(-5);
      rwyHdg = last5.reduce((s, p) => s + p.headingDeg, 0) / last5.length;
    } else {
      rwyHdg = 0;
    }
  }

  // Layout constants
  const W = 720;
  const H = 240;
  const padL = 20;
  const padR = 20;
  const padT = 24;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const centerY = padT + plotH / 2;

  // Pull touchdown/runway data up-front (used by the cross-track shift below
  // and by the X-scale computation further down).
  const tdz = ld.touchdownDistance || null;
  const runwayLengthFt = (tdz && typeof tdz.runwayLengthFt === 'number' && tdz.runwayLengthFt > 1000)
    ? tdz.runwayLengthFt
    : 8000;
  // Physical runway width in feet. Used to size the runway rectangle in the
  // SAME ft/px scale as the cross-track flight path so a touchdown 71 ft
  // right of CL on a 150 ft runway visibly sits inside the runway box.
  // Default 150 ft is typical for commercial runways. Plumbed through
  // backend/events/timeline-generator.js (CSV-replay) and
  // backend/core/simbridge-core.js (live) onto touchdownDistance.runwayWidthFt.
  const runwayWidthFt = (tdz && Number.isFinite(tdz.runwayWidthFt) && tdz.runwayWidthFt > 20)
    ? tdz.runwayWidthFt
    : 150;
  const tdDistFt = (tdz && Number.isFinite(tdz.distanceFt) && Math.abs(tdz.distanceFt) <= 15000)
    ? tdz.distanceFt
    : null;

  // ── Compute along-track and cross-track positions ────────────────────
  //
  // Convention: positive crossTrack = LEFT of centerline (matches yScale,
  // which puts positive at top of plot where the "L" label sits, and matches
  // the backend's lateral_offset_side: 'right' = positive lateral_offset_ft).
  //
  // Sign derivation (works for any runway heading 0..360°):
  //   along = (axN, axE) = (cos θ, sin θ)  in (north, east) components
  //   right-of-along is the CW 90° rotation: (n, e) → (-e, n)
  //   left-of-along  is the CCW 90° rotation: (n, e) → ( e, -n)
  // We want LEFT-positive, so the cross-track unit vector is (axE, -axN).
  const FT_PER_DEG_LAT = 364567;  // ~60 NM × 6076 ft
  const alongTrack = [];  // 0 at touchdown, negative further out on approach
  const crossTrack = [];  // positive = LEFT of runway centerline (signed feet)
  const rwyRad = rwyHdg * Math.PI / 180;
  const axN = Math.cos(rwyRad);
  const axE = Math.sin(rwyRad);
  const cxN = axE;   // left-of-runway, north component
  const cxE = -axN;  // left-of-runway, east component

  if (hasGps) {
    // ── Origin selection: prefer runway threshold (absolute positioning) ──
    //
    // When the backend supplies the runway threshold lat/lon, use it as the
    // projection origin. Then crossTrack[i] is an ABSOLUTE feet-from-
    // centerline value for every sample (positive = LEFT) — no shift games
    // needed, and the chart faithfully shows where the aircraft actually
    // was relative to the runway.
    //
    // Without a threshold (older payloads), fall back to using the last
    // sample as origin and applying the backend's lateral_offset_* shift.
    // That fallback only positions the path correctly RELATIVE TO ITSELF;
    // any GPS noise / heading-projection error in earlier samples gets
    // baked in as a phantom diagonal across the chart. This is why the
    // threshold-anchored path above is strongly preferred.
    const thr = ld.runwayThreshold && Number.isFinite(ld.runwayThreshold.lat)
      ? ld.runwayThreshold
      : null;

    if (thr) {
      const refLat = thr.lat;
      const refLon = thr.lon;
      const cosLat = Math.cos(refLat * Math.PI / 180);
      for (const p of points) {
        if (typeof p.latDeg !== 'number' || typeof p.lonDeg !== 'number') {
          alongTrack.push(alongTrack.length > 0 ? alongTrack[alongTrack.length - 1] : 0);
          crossTrack.push(crossTrack.length > 0 ? crossTrack[crossTrack.length - 1] : 0);
          continue;
        }
        const dNorth = (p.latDeg - refLat) * FT_PER_DEG_LAT;
        const dEast = (p.lonDeg - refLon) * FT_PER_DEG_LAT * cosLat;
        // Threshold is the origin. Along-track is signed feet PAST the
        // threshold (positive = down the runway, negative = on approach).
        alongTrack.push(dNorth * axN + dEast * axE);
        crossTrack.push(dNorth * cxN + dEast * cxE);
      }
    } else {
      // Fallback: last-sample-as-origin + manual shift (legacy behavior).
      const refLat = points[points.length - 1].latDeg;
      const refLon = points[points.length - 1].lonDeg;
      const cosLat = Math.cos(refLat * Math.PI / 180);

      for (const p of points) {
        if (typeof p.latDeg !== 'number' || typeof p.lonDeg !== 'number') {
          alongTrack.push(alongTrack.length > 0 ? alongTrack[alongTrack.length - 1] : 0);
          crossTrack.push(crossTrack.length > 0 ? crossTrack[crossTrack.length - 1] : 0);
          continue;
        }
        const dNorth = (p.latDeg - refLat) * FT_PER_DEG_LAT;
        const dEast = (p.lonDeg - refLon) * FT_PER_DEG_LAT * cosLat;
        alongTrack.push(dNorth * axN + dEast * axE);
        crossTrack.push(dNorth * cxN + dEast * cxE);
      }

      // Shift crossTrack so the touchdown sits at its actual lateral offset
      // from centerline. Backend convention: lateral_offset_side='right'
      // => positive offset feet east of centerline. Convert to LEFT-positive.
      if (tdz && Number.isFinite(tdz.lateralOffsetFt) && tdz.lateralOffsetSide) {
        const sideSign = tdz.lateralOffsetSide === 'left' ? +1
                       : tdz.lateralOffsetSide === 'right' ? -1
                       : 0;
        const tdCrossFt = sideSign * Math.abs(tdz.lateralOffsetFt);
        for (let i = 0; i < crossTrack.length; i++) crossTrack[i] += tdCrossFt;
      }
    }
  } else {
    // Fallback when GPS is unavailable: integrate heading / bank to estimate
    // a relative lateral profile. This is approximate — it cannot recover an
    // absolute centerline position — so the path is normalised to end at the
    // backend-reported touchdown offset (or zero if unknown).
    let lateralPos = 0;
    crossTrack.push(0);
    alongTrack.push(0);
    for (let i = 1; i < points.length; i++) {
      let hdgDiff = 0;
      if (hasHeading && typeof points[i].headingDeg === 'number') {
        hdgDiff = points[i].headingDeg - rwyHdg;
        if (hdgDiff > 180) hdgDiff -= 360;
        if (hdgDiff < -180) hdgDiff += 360;
        hdgDiff = Math.max(-45, Math.min(45, hdgDiff));
      } else if (typeof points[i].bankDeg === 'number') {
        hdgDiff = points[i].bankDeg * 0.3;
        hdgDiff = Math.max(-45, Math.min(45, hdgDiff));
      }
      const stepDist = (typeof points[i].gsKts === 'number' && points[i].gsKts > 30)
        ? points[i].gsKts / 100
        : (typeof points[i].iasKts === 'number' && points[i].iasKts > 30 ? points[i].iasKts / 100 : 1);
      // Heading right of runway (positive hdgDiff) = drift toward RIGHT of
      // centerline = negative in our LEFT-positive convention.
      lateralPos -= Math.sin(hdgDiff * Math.PI / 180) * stepDist;
      crossTrack.push(lateralPos);
      alongTrack.push(i); // uniform spacing for fallback (no real ft scale)
    }
    // Anchor the fallback path: its endpoint should match the backend's
    // touchdown offset. Subtract the residual then add the true offset.
    let tdCrossFt = 0;
    if (tdz && Number.isFinite(tdz.lateralOffsetFt) && tdz.lateralOffsetSide) {
      const sideSign = tdz.lateralOffsetSide === 'left' ? +1
                     : tdz.lateralOffsetSide === 'right' ? -1
                     : 0;
      tdCrossFt = sideSign * Math.abs(tdz.lateralOffsetFt);
    }
    const finalDev = crossTrack[crossTrack.length - 1];
    if (crossTrack.length > 1) {
      for (let i = 0; i < crossTrack.length; i++) {
        // Linearly distribute the correction so endpoints land cleanly.
        const t = i / (crossTrack.length - 1);
        crossTrack[i] = crossTrack[i] - finalDev * t + tdCrossFt * t;
      }
    }
  }

  // Find extent for scaling.
  //
  // EQUAL-ASPECT scale: 1 ft along-track = 1 ft cross-track in pixels.
  // This is the only scale at which a real straight-in approach renders
  // as a visually straight line. Trade-off: the runway box becomes a
  // thin horizontal sliver (a 197 ft wide runway is invisible next to
  // a 30,000 ft long approach), and small touchdown offsets are barely
  // perceptible. We accept that to preserve geometric truth \u2014 the
  // user explicitly preferred geometric accuracy over runway visibility.
  //
  // The lateralScale (y px/ft) is computed AFTER the X scale below so
  // both axes share the same px/ft. We pre-compute maxCross / halfRwyFt
  // here for any consumer that still needs them (e.g. fallback branch),
  // but lateralScale itself is set after xPxPerFt is known.
  const maxCross = Math.max(...crossTrack.map(Math.abs), 0.5);
  const halfRwyFt = runwayWidthFt / 2;
  let lateralScale;  // assigned below; equal to xPxPerFt for the GPS branch.

  // ── Unified X scale ───────────────────────────────────────────────────
  //
  // Same coordinate-system discipline as the side-view (see buildSvg's
  // COORDINATE SYSTEM NOTES): the flight path and the runway diagram must
  // share a single ft/px scale, otherwise the threshold pixel won't line up
  // with the flight-path point that's `tdz.distanceFt` before touchdown,
  // and the bird's-eye view no longer uses a comparable geometric scale.
  //
  // Layout (left to right): approach segment → threshold → runway → end.
  // Total feet on chart = (approach length, GPS-derived) + runway length.
  //
  // For the no-GPS fallback path, alongTrack is just sample-index (no real
  // ft scale), so we keep the legacy ratio-based layout in that branch.

  let xScale;
  let rwyStartX;
  let rwyEndX;
  let rwyW;
  let tdX;
  // Pixels-per-foot along the X axis. Hoisted so the diagnostic overlay
  // can compute and report the vertical exaggeration factor (lateralScale
  // is in y-px/ft; xPxPerFtForOverlay is in x-px/ft; their ratio is the
  // y/x exaggeration that makes a tiny real track angle look like a
  // dramatic visual diagonal on the chart).
  let xPxPerFtForOverlay = null;

  if (hasGps) {
    // Two possible origin conventions for alongTrack (set above):
    //   - threshold-anchored: alongTrack[0] is large negative (start of
    //     approach, ~5 nm out), alongTrack[last] is small positive
    //     (touchdown, typically 500–3000 ft past threshold).
    //   - last-sample-anchored (legacy fallback): alongTrack[last] === 0,
    //     alongTrack[0] is most negative.
    // The chart's geometry only needs the threshold pixel and the touchdown
    // pixel; computing both from alongTrack values keeps the renderer
    // origin-agnostic. The threshold lives at alongTrack value = 0, the
    // touchdown at alongTrack[last]; in the legacy branch the touchdown is
    // at value 0 and we synthesize the threshold from tdz.distanceFt below.
    const minAlong = Math.min(...alongTrack);
    const maxAlong = Math.max(...alongTrack, 0);
    // Pixels-per-foot must accommodate both the approach segment AND the
    // full runway length to the right of the threshold.
    const totalFt = Math.max(50, (maxAlong - minAlong) + Math.max(0, runwayLengthFt - Math.max(0, maxAlong)));

    const innerPad = 8;
    const usablePx = plotW - innerPad * 2;
    const xPxPerFt = usablePx / totalFt;
    xPxPerFtForOverlay = xPxPerFt;
    // EQUAL-ASPECT: lateral scale matches x scale exactly. A real
    // straight-in approach (path parallel to runway axis) now renders as
    // a visually horizontal line. Cap to plotH/2 / maxCross so wide
    // excursions (circling approaches, missed approaches) don't blow off
    // the chart \u2014 in that case we revert to runway-width-anchored
    // scale and accept the visual exaggeration for that subset.
    const equalAspect = xPxPerFt;
    const fitPath     = (plotH / 2) / (maxCross * 1.3);
    lateralScale = Math.min(equalAspect, fitPath);

    // Pixel for alongTrack value = 0 (the runway threshold).
    const thrX = padL + innerPad + (-minAlong) * xPxPerFt;
    rwyStartX = thrX;
    rwyEndX = thrX + runwayLengthFt * xPxPerFt;
    rwyW = rwyEndX - rwyStartX;

    // Touchdown pixel from the actual last sample's along-track value.
    // For the threshold-anchored branch this is correct geometry; for the
    // legacy branch alongTrack[last] === 0 so tdX falls on rwyStartX, and
    // we then nudge it to the backend-reported tdz.distanceFt downrange.
    tdX = thrX + alongTrack[alongTrack.length - 1] * xPxPerFt;
    if (tdDistFt != null && Math.abs(alongTrack[alongTrack.length - 1]) < 1) {
      tdX = thrX + tdDistFt * xPxPerFt;
    }

    xScale = (i) => thrX + alongTrack[i] * xPxPerFt;
  } else {
    // Fallback layout: along-track is unitless (sample index). Use the
    // legacy ratio scheme; geometric accuracy is not achievable without GPS.
    const rwyFraction = 0.22;
    rwyStartX = padL + plotW * (1 - rwyFraction);
    rwyEndX = padL + plotW;
    rwyW = rwyEndX - rwyStartX;

    tdX = rwyStartX + rwyW * 0.15;
    if (tdDistFt != null) {
      const tdOriginX = rwyStartX + 14;
      const usableRunwayPx = Math.max(1, rwyW - 18);
      tdX = tdOriginX + (tdDistFt / runwayLengthFt) * usableRunwayPx;
      tdX = Math.max(padL + 8, Math.min(padL + plotW - 8, tdX));
    }
    const minAlong = Math.min(...alongTrack);
    const maxAlong = Math.max(...alongTrack);
    const alongRange = maxAlong - minAlong || 1;
    xScale = (i) => padL + ((alongTrack[i] - minAlong) / alongRange) * (tdX - padL);
    // Fallback branch has no real ft/ft scale (alongTrack is sample index),
    // so equal-aspect is meaningless. Use the legacy auto-fit-to-path scale.
    lateralScale = (plotH / 2) / (maxCross * 1.3);
  }

  const yScale = (dev) => centerY - dev * lateralScale;

  // Build the wind presentation only from validated numeric values. If a
  // stored crosswind component is unavailable, direction + speed + the true
  // runway heading contain enough information to derive it honestly.
  const baseWind = buildLandingWindPresentation(ld);
  const windRelativeFromDeg = explicitRunwayHeadingTrueDeg != null && baseWind.directionDeg != null
    ? normalizeSignedDegrees(baseWind.directionDeg - explicitRunwayHeadingTrueDeg)
    : null;
  const derivedCrosswindKts = baseWind.crosswindKts == null
    && baseWind.speedKts != null
    && windRelativeFromDeg != null
    ? baseWind.speedKts * Math.sin(windRelativeFromDeg * Math.PI / 180)
    : null;
  const wind = buildLandingWindPresentation({
    ...ld,
    crosswind: baseWind.crosswindKts ?? derivedCrosswindKts,
  });
  const showDirectionalWindVector = windRelativeFromDeg != null
    && wind.directionDeg != null
    && wind.speedKts != null
    && wind.speedKts >= 0.5;
  const showCalmWind = wind.calm && wind.speedKts != null;

  // --- Build SVG ---
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="w-full" style="max-height: 260px;">`;

  svg += `<defs>
    <linearGradient id="topSkyGrad${idSuffix}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0c1929" />
      <stop offset="100%" stop-color="#111d2e" />
    </linearGradient>
    <linearGradient id="topPathGrad${idSuffix}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#60a5fa" stop-opacity="0.6" />
      <stop offset="100%" stop-color="#38bdf8" />
    </linearGradient>
  </defs>`;

  // Background
  svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#topSkyGrad${idSuffix})" rx="8" />`;

  // --- Runway (bird's eye) ---
  // Runway rectangle width in pixels = (runway width in ft) × lateralScale.
  // This is the SAME ft/px scale used by yScale() for the flight path, so
  // a touchdown N ft off centerline plots N × lateralScale pixels off the
  // rectangle's centerline — visibly inside the box if N < halfRwyFt.
  const rwyHalfWidth = Math.max(6, halfRwyFt * lateralScale);
  svg += `<rect x="${rwyStartX}" y="${centerY - rwyHalfWidth}" width="${rwyW}" height="${rwyHalfWidth * 2}" fill="#1e293b" stroke="#334155" stroke-width="0.5" rx="2" />`;

  // Centerline dashes
  for (let x = rwyStartX + 14; x < rwyEndX - 14; x += 22) {
    svg += `<rect x="${x}" y="${centerY - 1}" width="12" height="2" fill="#475569" rx="1" />`;
  }

  // Threshold bars
  svg += `<rect x="${rwyStartX + 3}" y="${centerY - rwyHalfWidth + 3}" width="3" height="${rwyHalfWidth * 2 - 6}" fill="#94a3b8" rx="0.5" />`;
  svg += `<rect x="${rwyStartX + 9}" y="${centerY - rwyHalfWidth + 3}" width="3" height="${rwyHalfWidth * 2 - 6}" fill="#94a3b8" rx="0.5" />`;
  svg += `<text x="${rwyStartX + 6}" y="${centerY + rwyHalfWidth + 14}" text-anchor="middle" fill="#64748b" font-size="9" font-family="system-ui, sans-serif">THR</text>`;

  // --- Extended centerline (approach) ---
  svg += `<line x1="${padL}" y1="${centerY}" x2="${rwyStartX}" y2="${centerY}" stroke="#475569" stroke-width="0.8" stroke-dasharray="6,6" stroke-opacity="0.4" />`;

  // --- Lateral deviation scale marks ---
  // Show ±CL markers at plot edges
  svg += `<text x="${padL + 2}" y="${padT + 10}" fill="#475569" font-size="8" font-family="system-ui, sans-serif">L</text>`;
  svg += `<text x="${padL + 2}" y="${H - padB - 2}" fill="#475569" font-size="8" font-family="system-ui, sans-serif">R</text>`;

  // --- Flight path ---
  let pathD = `M ${xScale(0)} ${yScale(crossTrack[0])}`;
  for (let i = 1; i < points.length; i++) {
    pathD += ` L ${xScale(i)} ${yScale(crossTrack[i])}`;
  }
  svg += `<path d="${pathD}" fill="none" stroke="url(#topPathGrad${idSuffix})" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`;

  // --- Per-sample GPS dots ---
  // Plot a small dot at every actual GPS sample. This makes data sparsity
  // (or its absence) immediately visible: if the polyline looks like a
  // perfectly straight diagonal but the dots are clustered tightly along
  // that line, the flight really WAS that straight. If the dots span only
  // a few sparse positions, the smoothness is just polyline interpolation.
  // Only emitted when the GPS branch is active \u2014 the heading-integrated
  // fallback synthesises uniform-spacing positions and doesn't represent
  // real per-sample GPS.
  if (hasGps) {
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (typeof p.latDeg !== 'number' || typeof p.lonDeg !== 'number') continue;
      const cx = xScale(i);
      const cy = yScale(crossTrack[i]);
      svg += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="1.5" fill="#bae6fd" fill-opacity="0.85" />`;
    }
  }

  // --- Bank-angle colour segments (highlight non-wings-level) ---
  for (let i = 1; i < points.length; i++) {
    const bank = points[i].bankDeg;
    if (typeof bank === 'number' && Math.abs(bank) > 8) {
      const x1 = xScale(i - 1);
      const y1 = yScale(crossTrack[i - 1]);
      const x2 = xScale(i);
      const y2 = yScale(crossTrack[i]);
      const opacity = Math.min(0.7, Math.abs(bank) / 30);
      const color = Math.abs(bank) > 15 ? '#ef4444' : '#f59e0b';
      svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="3" stroke-opacity="${opacity.toFixed(2)}" stroke-linecap="round" />`;
    }
  }

  // --- Stability gate marker (altitude-based, find the sample crossing 1000ft) ---
  if (GATE_ALTITUDE_FT > 0) {
    let gateIdx = -1;
    for (let i = points.length - 1; i >= 0; i--) {
      if (gateHeightOf(points[i]) >= GATE_ALTITUDE_FT) {
        gateIdx = i;
        break;
      }
    }
    if (gateIdx >= 0) {
      const gx = xScale(gateIdx);
      svg += `<line x1="${gx}" y1="${padT}" x2="${gx}" y2="${padT + plotH}" stroke="#a78bfa" stroke-width="1" stroke-dasharray="3,3" stroke-opacity="0.5" />`;
      svg += `<text x="${gx}" y="${padT - 4}" text-anchor="middle" fill="#a78bfa" fill-opacity="0.7" font-size="9" font-family="system-ui, sans-serif">GATE</text>`;
    }
  }

  // --- Touchdown marker ---
  const lastDev = crossTrack[crossTrack.length - 1];
  const tdMarkerX = xScale(points.length - 1);
  const tdMarkerY = yScale(lastDev);

  let tdColor = COLORS.warning;
  if (tdz && tdz.lateralOffsetGrade) {
    tdColor = gradeToColor(tdz.lateralOffsetGrade === 'On Centerline' || tdz.lateralOffsetGrade === 'Good' ? 'Good' : tdz.lateralOffsetGrade);
  }

  svg += `<circle cx="${tdMarkerX}" cy="${tdMarkerY}" r="5" fill="${tdColor}" />`;
  svg += `<circle cx="${tdMarkerX}" cy="${tdMarkerY}" r="3" fill="#fff" />`;

  // Lateral offset label. The rollout-fit calibration is numerically
  // noisy below ~15 ft (the early steering correction biases the fit line
  // toward the rollout average rather than the painted centerline), so
  // anything single-digit feet is rendered as "ON CL" rather than a
  // misleading direction label.
  if (tdz && tdz.lateralOffsetFt != null) {
    const side = lateralSideCode(tdz.lateralOffsetSide);
    const label = Math.abs(tdz.lateralOffsetFt) < 15
      ? 'ON CL'
      : `${Math.abs(tdz.lateralOffsetFt)} ft ${side}`;
    svg += `<text x="${tdMarkerX + 12}" y="${tdMarkerY + 4}" fill="${tdColor}" font-size="10" font-weight="600" font-family="system-ui, sans-serif">${label}</text>`;
  } else if (ld.centerlineDev != null) {
    const dev = ld.centerlineDev;
    const label = Math.abs(dev) < 1 ? 'ON CL' : `${Math.abs(dev).toFixed(1)}° ${dev >= 0 ? 'R' : 'L'}`;
    svg += `<text x="${tdMarkerX + 12}" y="${tdMarkerY + 4}" fill="${tdColor}" font-size="10" font-weight="600" font-family="system-ui, sans-serif">${label}</text>`;
  }

  // --- Aircraft silhouette (top-down) at touchdown ---
  const acftHdgDev = ld.centerlineDev || 0;
  const acftRotation = acftHdgDev; // clockwise = right
  svg += `<g transform="translate(${tdMarkerX}, ${tdMarkerY}) rotate(${(-90 + acftRotation).toFixed(1)})">`;
  // Simplified top-down aircraft: fuselage + wings + tail
  svg += `<line x1="0" y1="-8" x2="0" y2="8" stroke="#e2e8f0" stroke-width="1.5" stroke-linecap="round" />`; // fuselage
  svg += `<line x1="-10" y1="2" x2="10" y2="2" stroke="#e2e8f0" stroke-width="1.5" stroke-linecap="round" />`; // wings
  svg += `<line x1="-4" y1="-7" x2="4" y2="-7" stroke="#e2e8f0" stroke-width="1" stroke-linecap="round" />`; // tailplane
  svg += `</g>`;

  // --- Runway label ---
  if (ld.runway) {
    svg += `<text x="${rwyEndX - 4}" y="${centerY + rwyHalfWidth + 14}" text-anchor="end" fill="#64748b" font-size="9" font-family="system-ui, sans-serif">RWY ${escapeSvgText(ld.runway)}</text>`;
  }

  // --- Wind at touchdown (runway-relative inset) ---
  // The chart's runway axis always points right. Wind direction is a
  // meteorological FROM bearing, but the arrowhead shows the direction the air
  // is actually moving. The airflow arrow is therefore 180 degrees opposite
  // the source bearing: wind from the right flows upward across the chart,
  // while wind from the left flows downward.
  if (showDirectionalWindVector || showCalmWind) {
    const windBoxX = 24;
    const windBoxY = 30;
    const windBoxW = 246;
    const windBoxH = 68;
    const windArrowCx = 62;
    const windArrowCy = 62;
    const windTextX = 101;
    const windAriaLabel = escapeSvgText(wind.ariaLabel);

    svg += `<g data-topdown-wind-overlay="true" role="img" aria-label="${windAriaLabel}">`;
    svg += `<rect x="${windBoxX}" y="${windBoxY}" width="${windBoxW}" height="${windBoxH}" rx="8" fill="#07111f" fill-opacity="0.92" stroke="#164e63" stroke-width="1" />`;

    if (showDirectionalWindVector) {
      const relativeDeg = windRelativeFromDeg.toFixed(1);
      const windFlowRelativeDeg = normalizeSignedDegrees(windRelativeFromDeg + 180);
      const flowRelativeDeg = windFlowRelativeDeg.toFixed(1);
      const absoluteRelativeDeg = Math.abs(windRelativeFromDeg);
      const windSide = absoluteRelativeDeg < 0.05
        ? 'headwind'
        : Math.abs(absoluteRelativeDeg - 180) < 0.05
          ? 'tailwind'
          : windRelativeFromDeg < 0 ? 'left' : 'right';

      // Subtle runway-reference axis behind the airflow arrow.
      svg += `<line x1="38" y1="${windArrowCy}" x2="86" y2="${windArrowCy}" stroke="#64748b" stroke-width="1" stroke-dasharray="3,3" />`;
      svg += `<g data-topdown-wind-vector="true" data-wind-relative-deg="${relativeDeg}" data-wind-flow-relative-deg="${flowRelativeDeg}" data-wind-side="${windSide}" transform="rotate(${flowRelativeDeg} ${windArrowCx} ${windArrowCy})">`;
      svg += `<line x1="39" y1="${windArrowCy}" x2="78" y2="${windArrowCy}" stroke="#2dd4bf" stroke-width="3" stroke-linecap="round" />`;
      svg += `<polygon points="86,${windArrowCy} 75,${windArrowCy - 7} 75,${windArrowCy + 7}" fill="#2dd4bf" />`;
      svg += `</g>`;
      svg += `<text x="${windTextX}" y="55" fill="#99f6e4" font-size="10" font-weight="700" font-family="system-ui, sans-serif">WIND FROM ${escapeSvgText(wind.directionText)}</text>`;
      svg += `<text x="${windTextX}" y="74" fill="#e2e8f0" font-size="11" font-weight="600" font-family="system-ui, sans-serif">${escapeSvgText(wind.speedText)} · ${escapeSvgText(wind.crosswindDetailText)}</text>`;
    } else {
      svg += `<text x="${windBoxX + 16}" y="58" fill="#99f6e4" font-size="11" font-weight="700" font-family="system-ui, sans-serif">WIND CALM</text>`;
      svg += `<text x="${windBoxX + 16}" y="78" fill="#cbd5e1" font-size="10" font-family="system-ui, sans-serif">${escapeSvgText(wind.speedText)} at touchdown</text>`;
    }
    svg += `</g>`;
  }

  // --- Diagnostic overlay (top-right) ---
  // Surfaces the actual inputs that drove the projection so a discrepancy
  // between the rendered picture and the pilot's recollection can be
  // localised: wrong runway match, wrong threshold lat/lon, or wrong
  // runway heading would all yield a misleading top-down even though the
  // renderer math is correct. Counts of valid GPS samples make sparsity
  // visible (a 5-sample approach will look perfectly straight regardless).
  const validGpsCount = points.filter(p => typeof p.latDeg === 'number' && typeof p.lonDeg === 'number').length;
  // Cross-track range (LEFT-positive feet) \u2014 surfaces the actual numeric
  // span of the projected path so the user can sanity-check what the
  // diagonal really represents in feet (a 30 ft drift over a 5 nm approach
  // is "straight as an arrow" in pilot terms, but the chart's runway-width-
  // anchored scale will still draw it as a visible line).
  const xtFirst = crossTrack.length > 0 ? crossTrack[0] : 0;
  const xtLast  = crossTrack.length > 0 ? crossTrack[crossTrack.length - 1] : 0;
  const xtMin   = crossTrack.length > 0 ? Math.min(...crossTrack) : 0;
  const xtMax   = crossTrack.length > 0 ? Math.max(...crossTrack) : 0;
  const fmtXt = (v) => `${v >= 0 ? '+' : ''}${Math.round(v)}`;
  const dx = W - padR - 4;
  const dy = padT + 8;
  svg += `<g font-family="system-ui, sans-serif" font-size="9" fill="#64748b" text-anchor="end">`;
  svg += `<text x="${dx}" y="${dy}">RWY hdg: ${rwyHdg.toFixed(1)}\u00b0 true</text>`;
  svg += `<text x="${dx}" y="${dy + 11}">GPS pts: ${validGpsCount}/${points.length}</text>`;
  if (ld.runwayThreshold && Number.isFinite(ld.runwayThreshold.lat)) {
    svg += `<text x="${dx}" y="${dy + 22}">THR: ${ld.runwayThreshold.lat.toFixed(5)}, ${ld.runwayThreshold.lon.toFixed(5)}</text>`;
  } else {
    svg += `<text x="${dx}" y="${dy + 22}" fill="#f59e0b">THR: (no runway threshold)</text>`;
  }
  // Touchdown lat/lon (last GPS sample). Lets the user paste both into
  // Google Earth and visually verify the perpendicular distance from the
  // runway centerline matches the reported lateral offset \u2014 useful when
  // the offset value seems implausible.
  const lastGps = [...points].reverse().find(p =>
    typeof p.latDeg === 'number' && typeof p.lonDeg === 'number'
  );
  if (lastGps) {
    svg += `<text x="${dx}" y="${dy + 33}">TD : ${lastGps.latDeg.toFixed(5)}, ${lastGps.lonDeg.toFixed(5)}</text>`;
  }
  svg += `<text x="${dx}" y="${dy + 44}">RWY w: ${runwayWidthFt} ft</text>`;
  // Cross-track diagnostics: positive = LEFT of CL, negative = RIGHT
  svg += `<text x="${dx}" y="${dy + 55}">XT first: ${fmtXt(xtFirst)} ft  last: ${fmtXt(xtLast)} ft</text>`;
  svg += `<text x="${dx}" y="${dy + 66}">XT range: ${fmtXt(xtMin)} \u2192 ${fmtXt(xtMax)} ft</text>`;
  if (xPxPerFtForOverlay && lateralScale && xPxPerFtForOverlay > 0) {
    const vExag = lateralScale / xPxPerFtForOverlay;
    const exagColor = vExag > 1.5 ? '#f59e0b' : '#64748b';
    svg += `<text x="${dx}" y="${dy + 77}" fill="${exagColor}">V-exag: ${vExag.toFixed(2)}\u00d7</text>`;
  }
  // Rollout-relative diagnostics are intentionally separate from the absolute
  // runway-centerline result. An aircraft track alone cannot identify the
  // painted centerline's absolute position.
  if (tdz && tdz.lateralOffsetCalibration) {
    const cal = tdz.lateralOffsetCalibration;
    const dbFt = Number.isFinite(cal.databaseOffsetFt) ? cal.databaseOffsetFt : null;
    const dbSide = lateralSideCode(cal.databaseOffsetSide);
    const relativeFt = Number.isFinite(cal.rolloutRelativeOffsetFt)
      ? Math.round(Math.abs(cal.rolloutRelativeOffsetFt))
      : null;
    const relativeSide = lateralSideCode(cal.rolloutRelativeOffsetSide);
    const relativeLabel = relativeFt == null ? 'unavailable' : `${relativeFt} ft ${relativeSide}`;
    const calLine = `XT rollout-relative: ${relativeLabel} (${cal.sampleCount} pts, ${cal.alongTrackFt} ft)`;
    svg += `<text x="${dx}" y="${dy + 88}">${escapeSvgText(calLine)}</text>`;
    if (dbFt != null) {
      svg += `<text x="${dx}" y="${dy + 99}" fill="#64748b">Absolute DB: ${dbFt} ft ${dbSide}</text>`;
    }
  }
  svg += `</g>`;

  // --- Legend ---
  const legY = H - 6;
  const legItems = [
    { x: padL, color: '#38bdf8', dash: false, label: 'Flight path' },
    { x: padL + 110, color: '#f59e0b', dash: false, label: 'Bank > 8°' },
    { x: padL + 210, color: '#ef4444', dash: false, label: 'Bank > 15°' },
    { x: padL + 310, color: '#a78bfa', dash: true,  label: 'Stability gate' },
  ];
  for (const it of legItems) {
    const da = it.dash ? ' stroke-dasharray="4,3"' : '';
    svg += `<line x1="${it.x}" y1="${legY}" x2="${it.x + 16}" y2="${legY}" stroke="${it.color}" stroke-width="2"${da} />`;
    svg += `<text x="${it.x + 20}" y="${legY + 3}" fill="#94a3b8" font-size="9" font-family="system-ui, sans-serif">${it.label}</text>`;
  }

  svg += '</svg>';
  return svg;
}

export const approachProfileApi = Object.freeze({
  buildSvg,
  buildTopDownSvg,
  createProfileHeightResolver,
  gradeToColor,
  GATE_ALTITUDE_FT,
  MIN_PROFILE_POINTS,
  COLORS,
});


