// The live 3D view's own breadcrumb trail. It keeps altitude and speed with
// every point (the 2D trail only needs lat/lon), applies the same
// reposition-gap rule as the 2D map so a slew never draws a chord across the
// scene, and thins itself so a long flight cannot grow without bound.

import { getDistanceNm } from './geo.js';

const DEFAULT_MAX_POINTS = 12000;
const DEFAULT_MIN_SPACING_NM = 0.01;
const DEFAULT_MIN_INTERVAL_MS = 1000;
const JUMP_TOLERANCE_NM = 5;
const MAX_PLAUSIBLE_SPEED_KTS = 1200;
// While the simulator loads a flight it can report the aircraft at any
// altitude for a sample or two (a six-figure altitude over a parked aircraft
// has been seen). An altitude step no aircraft could fly is treated like a
// reposition so the trail never shoots into the sky and the framing and
// colour scale stay on the flight.
const ALTITUDE_JUMP_TOLERANCE_FT = 2500;
const MAX_PLAUSIBLE_CLIMB_FPM = 30_000;
const MAX_CONTINUITY_GAP_MS = 5 * 60 * 1000;

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function createLiveTrackBuffer({
  maxPoints = DEFAULT_MAX_POINTS,
  minSpacingNm = DEFAULT_MIN_SPACING_NM,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  now = () => Date.now(),
} = {}) {
  const pointLimit = Number.isSafeInteger(maxPoints) && maxPoints >= 2 ? maxPoints : DEFAULT_MAX_POINTS;
  let segments = [[]];
  let lastAccepted = null;
  let lastReceived = null;
  let totalPoints = 0;
  let minAltFt = null;
  let version = 0;

  function currentSegment() {
    return segments[segments.length - 1];
  }

  // A segment that would draw nothing: fewer than two points, or a committed
  // vertex whose live endpoint never moved off it. A committed vertex needs
  // movement, so any longer segment has a visible leg.
  function isStationaryStub(segment) {
    if (segment.length < 2) return true;
    if (segment.length > 2) return false;
    const [first, last] = segment;
    const movedNm = getDistanceNm(first.lat, first.lon, last.lat, last.lon);
    return !Number.isFinite(movedNm) || movedNm < minSpacingNm;
  }

  function recomputeMinAlt() {
    minAltFt = null;
    for (const segment of segments) {
      for (const point of segment) {
        if (point.altFt !== null && (minAltFt === null || point.altFt < minAltFt)) minAltFt = point.altFt;
      }
    }
  }

  function thin() {
    // Drop every other point from the oldest three quarters of the trail;
    // the recent quarter keeps full detail around the aircraft. Segment ends
    // survive within retained segments so gaps keep their exact edges.
    const keepDetailedFrom = Math.floor(totalPoints * 0.75);
    let globalIndex = 0;
    const next = [];
    for (const segment of segments) {
      const kept = [];
      for (let index = 0; index < segment.length; index += 1, globalIndex += 1) {
        if (
          globalIndex >= keepDetailedFrom
          || index === 0
          || index === segment.length - 1
          || globalIndex % 2 === 0
        ) {
          kept.push(segment[index]);
        }
      }
      next.push(kept);
    }
    segments = next;
    totalPoints = segments.reduce((sum, segment) => sum + segment.length, 0);
    // Repeated short legs can consist entirely of endpoints. Thinning cannot
    // shrink those, so retire the oldest complete legs without joining gaps.
    if (totalPoints > pointLimit) {
      // Leave headroom so fragmented trails do not re-copy the entire buffer
      // on every new point after reaching the limit.
      const retireTo = Math.max(2, Math.floor(pointLimit * 0.75));
      while (totalPoints > retireTo && segments.length > 1) {
        totalPoints -= segments.shift().length;
      }
    }
    if (totalPoints > pointLimit) {
      segments[0].splice(1, totalPoints - pointLimit);
      totalPoints = pointLimit;
    }
  }

  function append(sample = {}) {
    const lat = finiteOrNull(sample.lat);
    const lon = finiteOrNull(sample.lon);
    if (lat === null || lon === null) return { appended: false, newSegment: false };

    const receivedAtMs = finiteOrNull(sample.receivedAtMs) ?? now();
    const point = {
      lat,
      lon,
      altFt: finiteOrNull(sample.altFt),
      gsKts: finiteOrNull(sample.gsKts),
      vsFpm: finiteOrNull(sample.vsFpm),
      iasKts: finiteOrNull(sample.iasKts),
      timestampMs: finiteOrNull(sample.timestampMs) ?? receivedAtMs,
    };

    let newSegment = false;
    if (lastReceived) {
      const elapsedMs = Math.max(0, receivedAtMs - lastReceived.receivedAtMs);
      const continuityElapsedMs = Math.min(elapsedMs, MAX_CONTINUITY_GAP_MS);
      const maxContinuousNm = JUMP_TOLERANCE_NM + (MAX_PLAUSIBLE_SPEED_KTS * continuityElapsedMs / 3_600_000);
      const distanceNm = getDistanceNm(lastReceived.lat, lastReceived.lon, lat, lon);
      const crossesAntimeridian = Math.abs(lon - lastReceived.lon) > 180;
      const maxContinuousFt = ALTITUDE_JUMP_TOLERANCE_FT + (MAX_PLAUSIBLE_CLIMB_FPM * continuityElapsedMs / 60_000);
      const altitudeJump = point.altFt !== null && lastReceived.altFt !== null
        && Math.abs(point.altFt - lastReceived.altFt) > maxContinuousFt;
      if (crossesAntimeridian || !Number.isFinite(distanceNm) || distanceNm > maxContinuousNm || altitudeJump) {
        if (isStationaryStub(currentSegment())) {
          // Nothing to draw (a lone point, or a parked endpoint over its
          // committed vertex) so retire it. This is also where a loading
          // spike ends up: over the parked aircraft, then repositioned away
          // from by the first real sample.
          totalPoints -= currentSegment().length;
          currentSegment().length = 0;
          recomputeMinAlt();
        } else {
          segments.push([]);
        }
        lastAccepted = null;
        newSegment = true;
      }
    }
    // A sample without an altitude keeps the last known one for the
    // continuity check so a spike cannot hide behind a missing value.
    lastReceived = { lat, lon, altFt: point.altFt ?? lastReceived?.altFt ?? null, receivedAtMs };

    const segment = currentSegment();
    if (segment.length >= 2) {
      // The last vertex is the live endpoint; the one before it is committed.
      // Replace the endpoint until the aircraft has both moved and flown for
      // a while since that committed vertex, so a parked aircraft adds nothing.
      const committed = segment[segment.length - 2];
      const movedNm = getDistanceNm(committed.lat, committed.lon, lat, lon);
      const elapsedMs = point.timestampMs - committed.timestampMs;
      if (movedNm < minSpacingNm || elapsedMs < minIntervalMs) {
        segment[segment.length - 1] = point;
        lastAccepted = point;
        version += 1;
        if (point.altFt !== null && (minAltFt === null || point.altFt < minAltFt)) minAltFt = point.altFt;
        return { appended: false, newSegment };
      }
    }

    segment.push(point);
    totalPoints += 1;
    lastAccepted = point;
    version += 1;
    if (point.altFt !== null && (minAltFt === null || point.altFt < minAltFt)) minAltFt = point.altFt;
    if (totalPoints > pointLimit) thin();
    return { appended: true, newSegment };
  }

  function reset() {
    segments = [[]];
    lastAccepted = null;
    lastReceived = null;
    totalPoints = 0;
    minAltFt = null;
    version += 1;
  }

  return {
    append,
    reset,
    getSegments: () => segments,
    getLatest: () => lastAccepted,
    getMinAltFt: () => minAltFt,
    getVersion: () => version,
    size: () => totalPoints,
  };
}
