/**
 * Landing Distance Calculation and Scoring
 * 
 * Provides touchdown distance calculation from runway threshold and
 * scoring bands for proficiency analysis.
 * 
 * Architecture notes:
 * - Pure functions, no state (compliant with factory pattern philosophy)
 * - Units in feet for display and scoring
 * - Distance calculation via haversine formula
 * 
 * @module landing-distance
 */

'use strict';

type NullableNumber = number | null | undefined;
type RunwaySide = 'left' | 'right' | 'center';
type KnownSurface = 'dry' | 'wet' | 'ice' | 'snow';
type SurfaceSource = 'simconnect' | 'xplane' | 'inferred' | 'unavailable';
type BandKey = 'NEAR_THRESHOLD' | 'PERFECT' | 'GOOD' | 'ACCEPTABLE' | 'POOR' | 'DANGEROUS';

type CoordinateLike = {
  lat: NullableNumber;
  lon: NullableNumber;
};

type RolloutSample = CoordinateLike;

type TouchdownBand = {
  /** Inclusive upper limit of the band, in feet from the landing threshold. */
  max: number;
  score: number;
  grade: string;
  zone: string;
};

type TouchdownBands = Record<BandKey, TouchdownBand>;

/** Score and labels per band; limits are computed per runway by getAdjustedBands(). */
type TouchdownBandLabels = Record<BandKey, Omit<TouchdownBand, 'max'>>;

type TouchdownScore = {
  score: number | null;
  grade: string;
  zone: string;
  distanceFt: number | null;
  /** End of the touchdown zone used for this landing (3,000 ft or one third of the runway). */
  zoneEndFt: number | null;
  bands: TouchdownBands | null;
};

type SignedTouchdownDistance = {
  distanceFt: number | null;
  isShort: boolean;
};

type LateralOffsetResult = {
  offsetFt: number | null;
  side: RunwaySide;
};

type TrackLateralOffsetResult = LateralOffsetResult & {
  sampleCount: number;
  alongTrackFt: number;
  headingDeg: number | null;
};

type LateralOffsetScore = {
  score: number | null;
  grade: string;
  penalty: number;
  zone?: string;
};

type TouchdownImpact = Partial<CoordinateLike> & {
  vs_fpm?: NullableNumber;
  gforce?: NullableNumber;
};

type BounceData = {
  bounceCount: number;
  firstTouchdown?: TouchdownImpact | null;
  finalTouchdown?: TouchdownImpact | null;
  worstGforce?: NullableNumber;
  /** Sum of the observed airborne portions between touchdown contacts. */
  airborneDistanceFt?: NullableNumber;
};

type BounceScore = {
  score: number;
  grade: string;
  penalty: number;
  bounceCount: number;
  distanceTraveledFt: number;
  worstGforce: number | null;
};

type SurfaceConditionInputs = {
  surfaceCondition?: NullableNumber;
  xplaneRunwayFriction?: NullableNumber;
  precipState?: NullableNumber;
  precipRateMm?: NullableNumber;
  oatC?: NullableNumber;
};

type ResolvedSurfaceCondition = {
  surface: KnownSurface | null;
  source: SurfaceSource;
  confident: boolean;
};

type TouchdownScoreOptions = {
  runwayLengthFt?: NullableNumber;
  surface?: string | null;
};

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Earth radius in feet (approx. mean radius: 6,371 km = ~20,902,232 ft; rounded constant is equivalent for runway-scale calculations)
 * Source: Haversine formula standard geographic reference
 */
const EARTH_RADIUS_FT = 20902224;

/**
 * Touchdown-distance scoring.
 *
 * Two real-world boundaries anchor the scale and never move for weather:
 *   - the aiming point, approximately 1,000 ft from the threshold
 *     (FAA AIM 2-3-3, ICAO Annex 14 aiming-point markings);
 *   - the touchdown zone end: the first 3,000 ft of the runway or the first
 *     third of the landing length, whichever is less (FAA AC 91-79B,
 *     Boeing FCTM; the same one-third line drives "LONG LANDING" callouts).
 *
 * Everything past the zone end is a Long Landing (orange) and past half the
 * runway, or 5,000 ft, an overrun risk (red). Those are the operational
 * boundaries. Inside the zone, the score is a proficiency layer for the app,
 * not an aviation standard: the space between the aiming point and the zone
 * end is split into Ideal (first quarter), Good (to two thirds) and Late
 * (the rest). Anchoring on the aiming point keeps the ideal target where the
 * runway markings are on every runway; only the zone end shrinks with length.
 *
 * A touchdown inside the first 500 ft is inside the zone geometrically but
 * implies a threshold crossing well below the standard 50 ft, so it gets its
 * own amber caution.
 *
 * Grades are the labels the logbook and history index already rank:
 * Outstanding/Good (green), Near Threshold/Acceptable (amber),
 * Long Landing (orange), Dangerous/Short Landing (red).
 */
const AIMING_POINT_FT = 1000;
const NEAR_THRESHOLD_FT = 500;
const TOUCHDOWN_ZONE_MAX_FT = 3000;
const TOUCHDOWN_ZONE_RUNWAY_FRACTION = 1 / 3;
const LONG_LANDING_MAX_FT = 5000;
const LONG_LANDING_RUNWAY_FRACTION = 1 / 2;
const IDEAL_ZONE_FRACTION = 1 / 4;
const GOOD_ZONE_FRACTION = 2 / 3;

/** Grade/score/zone labels per band; band limits come from getAdjustedBands(). */
const TDZ_BANDS: TouchdownBandLabels = {
  //                score  grade             zone
  NEAR_THRESHOLD: { score: 85,  grade: 'Near Threshold', zone: 'Before Aiming Point' },
  PERFECT:        { score: 100, grade: 'Outstanding',    zone: 'Ideal TDZ'    },
  GOOD:           { score: 95,  grade: 'Good',           zone: 'Within TDZ'   },
  ACCEPTABLE:     { score: 80,  grade: 'Acceptable',     zone: 'Late TDZ'     },
  POOR:           { score: 60,  grade: 'Long Landing',   zone: 'Beyond TDZ'   },
  DANGEROUS:      { score: 10,  grade: 'Dangerous',      zone: 'Overrun Risk' },
};

function validRunwayLengthFt(runwayLengthFt: unknown): number | null {
  return typeof runwayLengthFt === 'number' && Number.isFinite(runwayLengthFt) && runwayLengthFt > 0
    ? runwayLengthFt
    : null;
}

/**
 * End of the touchdown zone for a runway: 3,000 ft or one third of the
 * landing length, whichever is less. Unknown length falls back to 3,000 ft.
 */
function touchdownZoneEndFt(runwayLengthFt: unknown = null): number {
  const lengthFt = validRunwayLengthFt(runwayLengthFt);
  if (lengthFt === null) return TOUCHDOWN_ZONE_MAX_FT;
  return Math.min(TOUCHDOWN_ZONE_MAX_FT, Math.round(lengthFt * TOUCHDOWN_ZONE_RUNWAY_FRACTION));
}

/**
 * Whether a touchdown distance lies inside a given zone end and before the
 * runway end. Replay uses this with the zone end that was recorded with the
 * landing, so a stored grade and its zone flag never disagree.
 */
function isWithinTouchdownZone(distanceFt: unknown, zoneEndFt: unknown, runwayLengthFt: unknown = null): boolean {
  if (typeof distanceFt !== 'number' || !Number.isFinite(distanceFt)) return false;
  const endFt = typeof zoneEndFt === 'number' && Number.isFinite(zoneEndFt) && zoneEndFt > 0
    ? zoneEndFt
    : TOUCHDOWN_ZONE_MAX_FT;
  if (distanceFt < 0 || distanceFt > endFt) return false;

  const lengthFt = validRunwayLengthFt(runwayLengthFt);
  return lengthFt === null || distanceFt < lengthFt;
}

function isTouchdownZoneAchieved(distanceFt: unknown, runwayLengthFt: unknown = null): boolean {
  return isWithinTouchdownZone(distanceFt, touchdownZoneEndFt(runwayLengthFt), runwayLengthFt);
}

const FT_PER_DEG_LAT = 364567;

function isNumericValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeLongitudeDelta(deltaDeg: number): number {
  return ((deltaDeg % 360) + 540) % 360 - 180;
}

function normalizeHeadingDeg(headingDeg: number): number {
  return ((headingDeg % 360) + 360) % 360;
}

function unknownTouchdownScore(): TouchdownScore {
  return {
    score: null,
    grade: 'Unknown',
    zone: 'No data',
    distanceFt: null,
    zoneEndFt: null,
    bands: null
  };
}

// -----------------------------------------------------------------------------
// Distance Calculation
// -----------------------------------------------------------------------------

/**
 * Calculate distance between two lat/lon points using haversine formula
 * 
 * @param {number} lat1 - First point latitude (degrees)
 * @param {number} lon1 - First point longitude (degrees)
 * @param {number} lat2 - Second point latitude (degrees)
 * @param {number} lon2 - Second point longitude (degrees)
 * @returns {number} Distance in feet
 */
function calculateDistanceFt(
  lat1: NullableNumber,
  lon1: NullableNumber,
  lat2: NullableNumber,
  lon2: NullableNumber,
): number | null {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) {
    return null;
  }

  // Guard against non-numeric / non-finite inputs (prevents NaN propagation).
  if (![lat1, lon1, lat2, lon2].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return null;
  }

  const toRad = (deg: number): number => deg * Math.PI / 180;
  
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  
  const clampedA = Math.min(1, Math.max(0, a));
  const c = 2 * Math.atan2(Math.sqrt(clampedA), Math.sqrt(1 - clampedA));
  
  return EARTH_RADIUS_FT * c;
}

/**
 * Calculate touchdown distance from runway threshold
 * 
 * @param {Object} threshold - Runway threshold coordinates
 * @param {number} threshold.lat - Threshold latitude
 * @param {number} threshold.lon - Threshold longitude
 * @param {Object} touchdown - Touchdown point coordinates
 * @param {number} touchdown.lat - Touchdown latitude
 * @param {number} touchdown.lon - Touchdown longitude
 * @returns {number|null} Distance in feet, or null if coordinates missing
 */
function calculateTouchdownDistance(
  threshold: CoordinateLike | null | undefined,
  touchdown: CoordinateLike | null | undefined,
): number | null {
  if (!threshold || !touchdown) return null;
  return calculateDistanceFt(threshold.lat, threshold.lon, touchdown.lat, touchdown.lon);
}

/**
 * Calculate SIGNED along-runway touchdown distance from runway threshold.
 * Positive = landed past threshold (normal), Negative = landed SHORT of threshold (dangerous).
 * 
 * Projects (touchdown - threshold) onto the runway direction vector. This deliberately
 * returns along-track distance, not straight-line distance, so lateral offset does not
 * inflate touchdown distance or pre-threshold approach distance.
 * 
 * @param {Object} threshold - Runway threshold coordinates
 * @param {number} threshold.lat - Threshold latitude (degrees)
 * @param {number} threshold.lon - Threshold longitude (degrees)
 * @param {Object} touchdown - Touchdown point coordinates
 * @param {number} touchdown.lat - Touchdown latitude (degrees)
 * @param {number} touchdown.lon - Touchdown longitude (degrees)
 * @param {number} runwayHeadingDeg - Runway heading in degrees true for lat/lon geometry
 * @returns {{ distanceFt: number|null, isShort: boolean }} Along-runway distance in feet (negative if short) and short flag
 */
function calculateSignedTouchdownDistance(
  threshold: CoordinateLike | null | undefined,
  touchdown: CoordinateLike | null | undefined,
  runwayHeadingDeg: NullableNumber,
): SignedTouchdownDistance {
  if (!threshold || !touchdown || !isNumericValue(runwayHeadingDeg)) {
    return { distanceFt: null, isShort: false };
  }

  if (![threshold.lat, threshold.lon, touchdown.lat, touchdown.lon].every(isNumericValue)) {
    return { distanceFt: null, isShort: false };
  }

  const thresholdLat = threshold.lat as number;
  const thresholdLon = threshold.lon as number;
  const touchdownLat = touchdown.lat as number;
  const touchdownLon = touchdown.lon as number;
  const runwayHeading = normalizeHeadingDeg(runwayHeadingDeg);

  // Convert runway heading to radians (geographic: 0=North, 90=East)
  const rwyRadians = (runwayHeading * Math.PI) / 180;

  // Unit vector in runway direction (flat earth approximation OK at runway scale)
  const rwyDirX = Math.sin(rwyRadians); // East component
  const rwyDirY = Math.cos(rwyRadians); // North component

  // Vector from threshold to touchdown, projected into local feet.
  const dLat = touchdownLat - thresholdLat; // North-positive
  const dLon = normalizeLongitudeDelta(touchdownLon - thresholdLon); // East-positive
  
  const cosLat = Math.cos((thresholdLat * Math.PI) / 180);
  const dX = dLon * FT_PER_DEG_LAT * cosLat; // East displacement in feet
  const dY = dLat * FT_PER_DEG_LAT;          // North displacement in feet

  // Dot product with the runway direction gives signed along-track distance.
  const signedDistanceFt = dX * rwyDirX + dY * rwyDirY;

  const isShort = signedDistanceFt < 0;

  return { distanceFt: signedDistanceFt, isShort };
}

/**
 * Calculate LATERAL offset from runway centerline at touchdown.
 * Positive = right of centerline, Negative = left of centerline.
 * 
 * Uses cross product of (touchdown - threshold) with runway direction vector
 * to determine perpendicular distance from centerline.
 * 
 * @param {Object} threshold - Runway threshold coordinates
 * @param {number} threshold.lat - Threshold latitude (degrees)
 * @param {number} threshold.lon - Threshold longitude (degrees)
 * @param {Object} touchdown - Touchdown point coordinates
 * @param {number} touchdown.lat - Touchdown latitude (degrees)
 * @param {number} touchdown.lon - Touchdown longitude (degrees)
 * @param {number} runwayHeadingDeg - Runway heading in degrees true for lat/lon geometry
 * @returns {{ offsetFt: number|null, side: 'left'|'right'|'center' }} Lateral offset and side
 */
function calculateLateralOffset(
  threshold: CoordinateLike | null | undefined,
  touchdown: CoordinateLike | null | undefined,
  runwayHeadingDeg: NullableNumber,
): LateralOffsetResult {
  if (!threshold || !touchdown || runwayHeadingDeg == null) {
    return { offsetFt: null, side: 'center' };
  }

  // Guard against non-finite inputs
  if (![threshold.lat, threshold.lon, touchdown.lat, touchdown.lon, runwayHeadingDeg]
      .every(Number.isFinite)) {
    return { offsetFt: null, side: 'center' };
  }

  const thresholdLat = threshold.lat as number;
  const thresholdLon = threshold.lon as number;
  const touchdownLat = touchdown.lat as number;
  const touchdownLon = touchdown.lon as number;
  const runwayHeading = normalizeHeadingDeg(runwayHeadingDeg as number);

  // Convert runway heading to radians (geographic: 0=North, 90=East)
  const rwyRadians = (runwayHeading * Math.PI) / 180;

  // Unit vector PERPENDICULAR to runway (90° clockwise = right side)
  // Perpendicular to (sin θ, cos θ) is (cos θ, -sin θ)
  const perpDirX = Math.cos(rwyRadians);  // East component (points right of runway)
  const perpDirY = -Math.sin(rwyRadians); // North component

  // Vector from threshold to touchdown (in degrees)
  const dLat = touchdownLat - thresholdLat; // North-positive
  const dLon = normalizeLongitudeDelta(touchdownLon - thresholdLon); // East-positive
  
  // Convert to approximate feet using lat/lon scaling
  // 1 degree latitude ≈ 364,567 ft (at any latitude)
  // 1 degree longitude ≈ 364,567 ft × cos(lat) (varies with latitude)
  const cosLat = Math.cos((thresholdLat * Math.PI) / 180);
  
  const dNorthFt = dLat * FT_PER_DEG_LAT;
  const dEastFt = dLon * FT_PER_DEG_LAT * cosLat;

  // Dot product with perpendicular vector gives lateral offset
  // Positive = right of centerline, Negative = left of centerline
  const lateralOffsetFt = dEastFt * perpDirX + dNorthFt * perpDirY;

  const side = Math.abs(lateralOffsetFt) < 5 ? 'center' 
             : lateralOffsetFt > 0 ? 'right' 
             : 'left';

  return { offsetFt: Math.round(lateralOffsetFt), side };
}

/**
 * Calculate touchdown offset relative to the aircraft's OWN fitted rollout
 * track. This is not an absolute runway-centerline estimator: without an
 * independent positional reference, a parallel rollout displaced from the
 * painted centerline is indistinguishable from a centerline rollout.
 *
 * Why this exists: MSFS scenery is built from Bing satellite imagery and is
 * routinely offset 30–100 ft from the AIRAC survey coordinates that
 * OurAirports / runways.csv use. A pilot landing on the painted centerline
 * in the sim can therefore be reported as 50–80 ft off centerline by the
 * pure-database math in `calculateLateralOffset`, even though the geometry
 * vs. the database is correct.
 *
 * The aircraft on rollout (post-touchdown, on-ground, decelerating, IAS still
 * above ~40 kts) tracks the painted centerline within a few feet because
 * the pilot is steering down the visible white line. So a least-squares fit
 * through the rollout lat/lon samples gives a centerline that matches what
 * the pilot followed after touchdown. Callers may expose this as a diagnostic,
 * but must not replace an absolute surveyed/scenery centerline measurement or
 * score with it.
 *
 * @param {Object} touchdown - Touchdown coordinates {lat, lon}
 * @param {Array<{lat:number, lon:number}>} rolloutSamples - Post-touchdown
 *   GPS samples taken while still rolling out at >40 kts (ideally 5–30
 *   samples spanning ≥500 ft along-track).
 * @param {number} fallbackHeadingDeg - Database runway heading (degrees
 *   true). Used only to disambiguate the ±180° sign of the PCA principal
 *   axis so that "positive offset = right of runway" matches the convention
 *   of `calculateLateralOffset`.
 * @returns {{offsetFt:number|null, side:'left'|'right'|'center',
 *   sampleCount:number, alongTrackFt:number, headingDeg:number|null}}
 *   `offsetFt`/`side` are null when there are too few samples or insufficient
 *   along-track spread for a stable fit.
 */
function calculateTouchdownOffsetFromRolloutTrack(
  touchdown: CoordinateLike | null | undefined,
  rolloutSamples: RolloutSample[] | null | undefined,
  fallbackHeadingDeg: NullableNumber,
): TrackLateralOffsetResult {
  const empty: TrackLateralOffsetResult = { offsetFt: null, side: 'center', sampleCount: 0, alongTrackFt: 0, headingDeg: null };
  if (!touchdown || !Number.isFinite(touchdown.lat) || !Number.isFinite(touchdown.lon)) return empty;
  if (!Array.isArray(rolloutSamples) || rolloutSamples.length < 5) return empty;
  if (!Number.isFinite(fallbackHeadingDeg)) return empty;

  const touchdownLat = touchdown.lat as number;
  const touchdownLon = touchdown.lon as number;
  const fallbackHeading = normalizeHeadingDeg(fallbackHeadingDeg as number);

  // Project each sample to local ENU (feet) anchored at the touchdown point.
  // Each sample also carries a `weight` that ramps from 0 in the first quarter
  // of rollout up to 1 in the second half. Rationale: the early rollout is
  // dominated by the pilot's steering correction back toward the painted
  // centerline, so those samples bias the fit line away from the CL. The
  // late rollout is settled on the painted line, so weighting late samples
  // more heavily produces a fit that closely tracks the actual painted CL —
  // which then makes the touchdown's perpendicular distance (and crucially
  // its sign) match what the pilot actually saw.
  const cosLat = Math.cos((touchdownLat * Math.PI) / 180);
  const pts: Array<{ x: number; y: number }> = [];
  for (const s of rolloutSamples) {
    if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const east = normalizeLongitudeDelta((s.lon as number) - touchdownLon) * FT_PER_DEG_LAT * cosLat;
    const north = ((s.lat as number) - touchdownLat) * FT_PER_DEG_LAT;
    pts.push({ x: east, y: north });
  }
  if (pts.length < 5) return empty;

  const n = pts.length;
  // Weight ramp: first quartile gets 0, third+fourth quartile get 1, second
  // quartile linearly ramps from 0 to 1. Caller passes samples in time
  // order, so index is a faithful proxy for along-track progress.
  const weights = new Array<number>(n);
  let wSum = 0;
  for (let i = 0; i < n; i++) {
    const frac = i / (n - 1); // 0 at touchdown, 1 at end of window
    let w: number;
    if (frac < 0.25) w = 0;
    else if (frac < 0.5) w = (frac - 0.25) / 0.25;
    else w = 1;
    weights[i] = w;
    wSum += w;
  }
  // Defensive: if weights collapse (degenerate input), fall back to uniform.
  if (wSum < 1e-6) {
    for (let i = 0; i < n; i++) weights[i] = 1;
    wSum = n;
  }

  // Weighted sample mean
  let xm = 0, ym = 0;
  for (let i = 0; i < n; i++) { xm += pts[i].x * weights[i]; ym += pts[i].y * weights[i]; }
  xm /= wSum; ym /= wSum;

  // Weighted 2x2 covariance
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = pts[i].x - xm, dy = pts[i].y - ym;
    const w = weights[i];
    sxx += w * dx * dx;
    syy += w * dy * dy;
    sxy += w * dx * dy;
  }

  // Principal axis (largest eigenvector of the covariance matrix). The
  // formula 0.5*atan2(2*sxy, sxx-syy) gives the angle of the dominant axis
  // measured from the +x (east) axis, in radians.
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let dx = Math.cos(angle); // east component of along-runway unit vector
  let dy = Math.sin(angle); // north component

  // PCA leaves the ±direction ambiguous. Disambiguate using the database
  // heading: forward along the runway in ENU is (sin θ, cos θ). If our PCA
  // axis points roughly opposite, flip it so "along-runway" matches
  // database forward and the sign convention below stays consistent.
  const dbForwardE = Math.sin((fallbackHeading * Math.PI) / 180);
  const dbForwardN = Math.cos((fallbackHeading * Math.PI) / 180);
  if (dx * dbForwardE + dy * dbForwardN < 0) {
    dx = -dx;
    dy = -dy;
  }

  // Verify that the empirical heading is within 20 degrees of the database
  // heading. A larger difference indicates that the rollout samples do not
  // describe a clean centerline track, so reject the fit and use the fallback.
  const empiricalHeadingDeg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  const headingDiff = Math.abs(normalizeLongitudeDelta(empiricalHeadingDeg - fallbackHeading));
  if (headingDiff > 20) {
    return { ...empty, sampleCount: pts.length, headingDeg: empiricalHeadingDeg };
  }

  // Along-track spread of the rollout samples (max projection onto the
  // along-runway axis minus the min). Fits with insufficient spread are
  // numerically unstable, so abort below 300 ft.
  let alongMin = Infinity, alongMax = -Infinity;
  for (const p of pts) {
    const along = (p.x - xm) * dx + (p.y - ym) * dy;
    if (along < alongMin) alongMin = along;
    if (along > alongMax) alongMax = along;
  }
  const alongTrackFt = alongMax - alongMin;
  if (alongTrackFt < 300) {
    return { ...empty, sampleCount: pts.length, headingDeg: empiricalHeadingDeg, alongTrackFt };
  }

  // Touchdown is the local origin (0,0). Signed perpendicular distance from
  // the fitted centerline (which passes through (xm,ym) with direction
  // (dx,dy)). Right-of-runway perpendicular is (dy, -dx) — rotating the
  // forward vector 90° clockwise.
  const lateralOffsetFt = (0 - xm) * dy + (0 - ym) * (-dx);
  const side = Math.abs(lateralOffsetFt) < 5 ? 'center'
             : lateralOffsetFt > 0 ? 'right'
             : 'left';

  return {
    offsetFt: Math.round(lateralOffsetFt),
    side,
    sampleCount: pts.length,
    alongTrackFt: Math.round(alongTrackFt),
    headingDeg: empiricalHeadingDeg,
  };
}

/**
 * @deprecated Use `calculateTouchdownOffsetFromRolloutTrack`. The retained
 * alias preserves compatibility while making the relative-track semantics
 * explicit for new callers.
 */
const calculateLateralOffsetFromTrack = calculateTouchdownOffsetFromRolloutTrack;

/**
 * Score lateral offset from centerline.
 * 
 * @param {number} offsetFt - Lateral offset in feet (absolute value used)
 * @param {number} runwayWidthFt - Runway width in feet (default 150ft)
 * @returns {Object} Scoring result
 */
function scoreLateralOffset(offsetFt: NullableNumber, runwayWidthFt: NullableNumber = 150): LateralOffsetScore {
  if (!isNumericValue(offsetFt)) {
    return { score: null, grade: 'Unknown', penalty: 0 };
  }

  const absOffset = Math.abs(offsetFt);
  const effectiveRunwayWidthFt = isNumericValue(runwayWidthFt) && runwayWidthFt > 0
    ? runwayWidthFt
    : 150;
  const halfWidth = effectiveRunwayWidthFt / 2;

  // Scoring bands based on runway half-width
  // Perfect: within 10ft of centerline
  // Good: within 1/3 of half-width (~25ft for 150ft runway)
  // Marginal: within 2/3 of half-width (~50ft)
  // Poor: within half-width (still on runway)
  // Excursion: outside runway edge
  
  if (absOffset <= 10) {
    return { score: 100, grade: 'Perfect', penalty: 0, zone: 'centerline' };
  } else if (absOffset <= halfWidth * 0.33) {
    return { score: 95, grade: 'Good', penalty: 5, zone: 'near centerline' };
  } else if (absOffset <= halfWidth * 0.66) {
    return { score: 85, grade: 'Marginal', penalty: 15, zone: 'off center' };
  } else if (absOffset <= halfWidth) {
    return { score: 70, grade: 'Poor', penalty: 30, zone: 'near edge' };
  } else {
    // Off runway - serious
    const overshoot = absOffset - halfWidth;
    const extraPenalty = Math.min(50, Math.round(overshoot / 10)); // +1 penalty per 10ft past edge
    return { score: Math.max(0, 50 - extraPenalty), grade: 'Outside runway reference', penalty: 50 + extraPenalty, zone: 'outside reference edge' };
  }
}

/**
 * Score bounce severity and calculate distance traveled during bounces.
 * 
 * @param {Object} bounceData - Bounce tracking data
 * @param {number} bounceData.bounceCount - Number of bounces (0 = clean landing)
 * @param {Object} bounceData.firstTouchdown - { lat, lon, vs_fpm, gforce }
 * @param {Object} bounceData.finalTouchdown - { lat, lon, vs_fpm, gforce } or null if no bounces
 * @param {number|null} [bounceData.airborneDistanceFt] - Sum of observed airborne-segment distances.
 *   New live landings provide this so ground rollout before a wheel unload is not mislabeled as bounce distance.
 * @param {number|null} [bounceData.worstGforce] - Pre-computed worst G-force across ALL touchdowns.
 *   When provided, used directly instead of only comparing first/last (avoids underreporting on 3+ bounce sequences).
 * @returns {Object} Bounce analysis result
 */
function scoreBounce(bounceData: BounceData | null | undefined): BounceScore {
  if (!bounceData || !Number.isInteger(bounceData.bounceCount) || bounceData.bounceCount < 0) {
    return { 
      score: 100, 
      grade: 'Clean', 
      penalty: 0, 
      bounceCount: 0,
      distanceTraveledFt: 0,
      worstGforce: null,
    };
  }

  const { bounceCount, firstTouchdown, finalTouchdown } = bounceData;
  
  if (bounceCount === 0) {
    // Clean landing - no bounces
    return { 
      score: 100, 
      grade: 'Clean', 
      penalty: 0, 
      bounceCount: 0,
      distanceTraveledFt: 0,
      worstGforce: isNumericValue(firstTouchdown?.gforce) ? firstTouchdown.gforce : null,
    };
  }

  // Live detection supplies the distance accumulated only while WOW is false.
  // Retain the endpoint fallback for historical/replay callers that predate the
  // airborne-distance field, but never replace an explicit zero with rollout.
  let distanceTraveledFt = isNumericValue(bounceData.airborneDistanceFt) && bounceData.airborneDistanceFt >= 0
    ? bounceData.airborneDistanceFt
    : 0;
  if (bounceData.airborneDistanceFt == null && firstTouchdown && finalTouchdown &&
      firstTouchdown.lat != null && firstTouchdown.lon != null &&
      finalTouchdown.lat != null && finalTouchdown.lon != null) {
    distanceTraveledFt = calculateDistanceFt(
      firstTouchdown.lat, firstTouchdown.lon,
      finalTouchdown.lat, finalTouchdown.lon
    ) || 0;
  }

  // Prefer the pre-computed worst G-force (covers all intermediate bounces).
  // Fall back to max of first/last only when not provided (e.g. timeline replay from CSV).
  let worstGforce: number | null;
  if (isNumericValue(bounceData.worstGforce)) {
    worstGforce = bounceData.worstGforce;
  } else {
    const gforces = [firstTouchdown?.gforce, finalTouchdown?.gforce].filter((g): g is number => isNumericValue(g));
    worstGforce = gforces.length > 0 ? Math.max(...gforces) : null;
  }

  // Scoring based on bounce count and distance
  let score: number;
  let grade: string;
  let penalty: number;
  
  if (bounceCount === 1) {
    // Single bounce - minor issue
    penalty = 5 + Math.min(10, Math.round(distanceTraveledFt / 100)); // +1 per 100ft traveled
    score = Math.max(70, 95 - penalty);
    grade = 'Single Bounce';
  } else if (bounceCount === 2) {
    // Double bounce - moderate issue
    penalty = 15 + Math.min(15, Math.round(distanceTraveledFt / 50)); // +1 per 50ft traveled
    score = Math.max(50, 85 - penalty);
    grade = 'Multiple Bounces';
  } else if (bounceCount === 3) {
    // Triple bounce - significant issue
    penalty = 25 + Math.min(20, Math.round(distanceTraveledFt / 30)); // +1 per 30ft traveled
    score = Math.max(30, 75 - penalty);
    grade = 'Repeated Bounces';
  } else {
    // 4+ bounces - porpoise, dangerous
    penalty = 40 + Math.min(30, Math.round(distanceTraveledFt / 20)); // +1 per 20ft traveled
    score = Math.max(10, 60 - penalty);
    grade = 'Porpoise';
  }

  return {
    score,
    grade,
    penalty,
    bounceCount,
    distanceTraveledFt: Math.round(distanceTraveledFt),
    worstGforce,
  };
}

// -----------------------------------------------------------------------------
// Scoring
// -----------------------------------------------------------------------------

/**
 * Band limits for a runway. Every limit is an inclusive upper bound in feet
 * from the landing threshold and the limits are monotonic, so each distance
 * maps to exactly one band.
 *
 *   NEAR_THRESHOLD  500 ft                       (fixed: threshold-crossing geometry)
 *   PERFECT         aim + (T - aim) / 4          (1,500 ft when T = 3,000)
 *   GOOD            aim + (T - aim) * 2 / 3      (2,333 ft when T = 3,000)
 *   ACCEPTABLE      T = min(3,000, L / 3)        (the touchdown zone end)
 *   POOR            max(T, min(5,000, L / 2))    (Long Landing)
 *   DANGEROUS       beyond
 *
 * On a runway so short that T falls at or before the aiming point, the three
 * in-zone bands collapse onto T; the aiming point itself is never moved
 * toward the threshold.
 *
 * @param {number} runwayLengthFt - Landing length in feet, or null when unknown
 * @param {string} _surface - Retained for caller compatibility; weather does not move the zone
 */
function getAdjustedBands(runwayLengthFt: NullableNumber, _surface: string | null = null): TouchdownBands {
  const lengthFt = validRunwayLengthFt(runwayLengthFt);
  const zoneEndFt = touchdownZoneEndFt(lengthFt);
  const zoneSpanFt = Math.max(0, zoneEndFt - AIMING_POINT_FT);
  const idealMaxFt = Math.min(zoneEndFt, Math.round(AIMING_POINT_FT + zoneSpanFt * IDEAL_ZONE_FRACTION));
  const goodMaxFt = Math.max(idealMaxFt, Math.min(zoneEndFt, Math.round(AIMING_POINT_FT + zoneSpanFt * GOOD_ZONE_FRACTION)));
  const longMaxFt = lengthFt === null
    ? Math.max(zoneEndFt, LONG_LANDING_MAX_FT)
    : Math.max(zoneEndFt, Math.min(LONG_LANDING_MAX_FT, Math.round(lengthFt * LONG_LANDING_RUNWAY_FRACTION)));

  return {
    // The ideal band starts at NEAR_THRESHOLD_FT, so the near-threshold band
    // ends one foot before it; distances are scored in whole feet.
    NEAR_THRESHOLD: { ...TDZ_BANDS.NEAR_THRESHOLD, max: Math.min(NEAR_THRESHOLD_FT - 1, idealMaxFt) },
    PERFECT: { ...TDZ_BANDS.PERFECT, max: idealMaxFt },
    GOOD: { ...TDZ_BANDS.GOOD, max: goodMaxFt },
    ACCEPTABLE: { ...TDZ_BANDS.ACCEPTABLE, max: zoneEndFt },
    POOR: { ...TDZ_BANDS.POOR, max: longMaxFt },
    DANGEROUS: { ...TDZ_BANDS.DANGEROUS, max: Infinity },
  };
}

/**
 * Score a touchdown distance
 *
 * @param {number} distanceFt - Touchdown distance from the landing threshold in feet
 * @param {Object} options - Scoring options
 * @param {number} [options.runwayLengthFt] - Landing length; sets the zone end and the overrun bands
 * @param {string} [options.surface] - Recorded for callers; does not change the result
 * @returns {Object} Scoring result
 * @returns {number} result.score - Score 0-100
 * @returns {string} result.grade - Human-readable grade
 * @returns {string} result.zone - Touchdown zone description
 * @returns {number} result.distanceFt - Input distance
 * @returns {number} result.zoneEndFt - Touchdown zone end used for this runway
 * @returns {Object} result.bands - Effective scoring bands used
 */
function scoreTouchdownDistance(distanceFt: NullableNumber, options: TouchdownScoreOptions | null = {}): TouchdownScore {
  if (!isNumericValue(distanceFt)) {
    return unknownTouchdownScore();
  }

  const normalizedOptions = options ?? {};
  const runwayLengthFt = validRunwayLengthFt(normalizedOptions.runwayLengthFt);
  const bands = getAdjustedBands(runwayLengthFt, normalizedOptions.surface ?? null);
  const zoneEndFt = bands.ACCEPTABLE.max;

  if (distanceFt < 0) {
    return {
      score: 0,
      grade: 'Short Landing',
      zone: 'Before Threshold',
      distanceFt,
      zoneEndFt,
      bands,
    };
  }

  if (runwayLengthFt !== null && distanceFt >= runwayLengthFt) {
    return {
      score: 0,
      grade: 'Dangerous',
      zone: 'Past Runway End',
      distanceFt,
      zoneEndFt,
      bands,
    };
  }

  let result: TouchdownBand;
  if (distanceFt <= bands.NEAR_THRESHOLD.max) {
    result = bands.NEAR_THRESHOLD;
  } else if (distanceFt <= bands.PERFECT.max) {
    result = bands.PERFECT;
  } else if (distanceFt <= bands.GOOD.max) {
    result = bands.GOOD;
  } else if (distanceFt <= bands.ACCEPTABLE.max) {
    result = bands.ACCEPTABLE;
  } else if (distanceFt <= bands.POOR.max) {
    result = bands.POOR;
  } else {
    result = bands.DANGEROUS;
  }

  return {
    score: result.score,
    grade: result.grade,
    zone: result.zone,
    distanceFt,
    zoneEndFt,
    bands
  };
}



// -----------------------------------------------------------------------------
// Surface Condition Inference
// -----------------------------------------------------------------------------

/**
 * SimConnect surface condition enum (when present): 0=Normal, 1=Wet, 2=Icy, 3=Snow.
 * NOTE: as of MSFS 2024 this SimVar is not exposed by the stock SimConnect SDK,
 * so the raw value is virtually always null. Weather telemetry can provide an
 * explicitly uncertain proxy; missing observations remain unknown.
 */
const SIMCONNECT_SURFACE_ENUM = ['dry', 'wet', 'ice', 'snow'] as const;

/**
 * Resolve runway surface condition for landing-distance scoring.
 *
 * Resolution order:
 *   1. If `surfaceCondition` is a known SimConnect enum (0-3), use it.
 *   2. Else use precipitation telemetry as a conservative weather proxy:
 *        - explicit snow state -> 'snow'
 *        - explicit rain state or measurable rate -> 'wet'
 *        - explicit no precipitation + warm OAT -> 'dry'
 *        - explicit no precipitation + freezing OAT -> 'wet' (conservative)
 *   3. If inputs are missing, return null with source 'unavailable'.
 *      Weather-derived values are never marked confident because precipitation
 *      and OAT are not an observed runway assessment. They do not alter TDZ scoring.
 *
 * @param {Object} inputs
 * @param {number|null} [inputs.surfaceCondition] - SimConnect enum if present
 * @param {number|null} [inputs.precipState]      - MSFS 2024 mask: 2 = none, 4 = rain, 8 = snow
 * @param {number|null} [inputs.precipRateMm]     - mm/hr
 * @param {number|null} [inputs.oatC]             - outside air temperature, °C
 * @returns Resolved observation or uncertain weather proxy; null when unavailable.
 */
function inferSurfaceCondition(inputs: SurfaceConditionInputs = {}): ResolvedSurfaceCondition {
  const { surfaceCondition, xplaneRunwayFriction, precipState, precipRateMm, oatC } = inputs;

  if (typeof surfaceCondition === 'number' && Number.isInteger(surfaceCondition) && surfaceCondition >= 0 && surfaceCondition < SIMCONNECT_SURFACE_ENUM.length) {
    return { surface: SIMCONNECT_SURFACE_ENUM[surfaceCondition] as KnownSurface, source: 'simconnect', confident: true };
  }

  // X-Plane 12 runway_friction enum: dry=0, wet/puddly=1-6,
  // snowy=7-9, icy=10-12, snowy/icy=13-15.
  if (typeof xplaneRunwayFriction === 'number' && Number.isInteger(xplaneRunwayFriction)) {
    if (xplaneRunwayFriction === 0) return { surface: 'dry', source: 'xplane', confident: true };
    if (xplaneRunwayFriction >= 1 && xplaneRunwayFriction <= 6) return { surface: 'wet', source: 'xplane', confident: true };
    if (xplaneRunwayFriction >= 7 && xplaneRunwayFriction <= 9) return { surface: 'snow', source: 'xplane', confident: true };
    if (xplaneRunwayFriction >= 10 && xplaneRunwayFriction <= 15) return { surface: 'ice', source: 'xplane', confident: true };
  }

  const oatKnown = typeof oatC === 'number' && Number.isFinite(oatC);
  const precipStateKnown = typeof precipState === 'number' && Number.isFinite(precipState);
  const precipRateKnown = typeof precipRateMm === 'number' && Number.isFinite(precipRateMm);
  // MSFS 2024 exposes AMBIENT PRECIP STATE as a mask: 2=None, 4=Rain, 8=Snow.
  // Keep 0/1 as legacy no-precip values for older/fixture data.
  const precipStateMask = precipStateKnown ? Math.trunc(precipState) : null;
  const stateHasRain = precipStateMask != null && (precipStateMask & 4) !== 0;
  const stateHasSnow = precipStateMask != null && (precipStateMask & 8) !== 0;
  const stateHasPrecip = stateHasRain || stateHasSnow;
  const stateNoPrecip = precipStateMask != null
    ? ((precipStateMask & 2) !== 0 || precipStateMask <= 1)
    : false;
  // "No precipitation" requires either an explicit none state OR a measured rate of 0.
  const hasPrecip = (precipStateKnown && stateHasPrecip) || (precipRateKnown && precipRateMm > 0.05);
  const noPrecip = (precipStateKnown && stateNoPrecip) || (precipRateKnown && precipRateMm <= 0.05);

  // The state mask already identifies rain versus snow. OAT cannot turn a
  // reported rain state into snow; freezing rain and runway ice would require
  // observations that the simulator does not provide here.
  if (stateHasSnow) return { surface: 'snow', source: 'inferred', confident: false };
  if (hasPrecip) {
    // A rate without a precipitation-type state cannot distinguish rain/snow.
    return { surface: 'wet', source: 'inferred', confident: false };
  }
  if (noPrecip && oatKnown) {
    if (oatC <= -2) return { surface: 'wet', source: 'inferred', confident: false }; // residual contamination plausible
    return { surface: 'dry', source: 'inferred', confident: false };
  }
  // OAT alone cannot establish whether precipitation or residual runway
  // contamination is present. Without an explicit precipitation observation,
  // treat the available weather data as insufficient and fail safe to wet.
  return { surface: null, source: 'unavailable', confident: false };
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
  // Distance calculation
  calculateDistanceFt,
  calculateTouchdownDistance,
  calculateSignedTouchdownDistance,
  calculateLateralOffset,
  calculateTouchdownOffsetFromRolloutTrack,
  calculateLateralOffsetFromTrack,
  
  // Scoring
  scoreTouchdownDistance,
  isTouchdownZoneAchieved,
  isWithinTouchdownZone,
  touchdownZoneEndFt,
  scoreLateralOffset,
  scoreBounce,
  getAdjustedBands,
  inferSurfaceCondition,
  TDZ_BANDS,
  TOUCHDOWN_ZONE_MAX_FT,
};

export {};
