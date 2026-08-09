'use strict';

const {
  sourceIdentityMatches,
} = require('./source-identity.js') as {
  sourceIdentityMatches: (_current: AnyRecord, _indexed: AnyRecord | null | undefined) => boolean;
};

type AnyRecord = Record<string, any>;
type TimelineFlightIndexRefreshResult = {
  indexed: number;
  skipped: number;
  pruned: number;
  totalInput: number;
};
type TimelineFlightIndexQueryOptions = {
  limit?: unknown;
  offset?: unknown;
  routeFilter?: unknown;
  aircraftFilter?: unknown;
  sort?: unknown;
};

function normalizeLimit(value: unknown, fallback: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(max, Math.floor(numeric)));
}

function normalizeOffset(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.floor(numeric));
}

function finiteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function knownFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  return finiteNumber(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function booleanOrNull(value: unknown): boolean | null {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function normalizeIndexedLandingEvent(landing: AnyRecord): AnyRecord {
  const existingTouchdown = landing.touchdownDistance && typeof landing.touchdownDistance === 'object'
    ? landing.touchdownDistance
    : null;
  const touchdownFallback = {
    distanceFt: knownFiniteNumber(landing.touchdownDistanceFt),
    grade: nonEmptyString(landing.touchdownDistanceGrade),
    score: knownFiniteNumber(landing.touchdownDistanceScore),
    zone: nonEmptyString(landing.touchdownDistanceZone),
    lateralOffsetFt: knownFiniteNumber(landing.lateralOffsetFt),
    lateralOffsetGrade: nonEmptyString(landing.lateralOffsetGrade),
    lateralOffsetScore: knownFiniteNumber(landing.lateralOffsetScore),
    lateralOffsetSide: nonEmptyString(landing.lateralOffsetSide),
    bounceCount: knownFiniteNumber(landing.bounceCount),
    bounceGrade: nonEmptyString(landing.bounceGrade),
    bounceScore: knownFiniteNumber(landing.bounceScore),
    runwayHeadingTrueDeg: knownFiniteNumber(landing.runwayHeadingTrueDeg),
    runwayLengthFt: knownFiniteNumber(landing.runwayLengthFt),
    runwayPhysicalLengthFt: knownFiniteNumber(landing.runwayPhysicalLengthFt),
    runwayThresholdLat: knownFiniteNumber(landing.runwayThresholdLat),
    runwayThresholdLon: knownFiniteNumber(landing.runwayThresholdLon),
    runwayWidthFt: knownFiniteNumber(landing.runwayWidthFt),
  };
  const hasTouchdownFallback = Object.values(touchdownFallback).some((value) => value !== null);
  const touchdownDistance = existingTouchdown || hasTouchdownFallback
    ? Object.fromEntries(Object.entries({
        ...touchdownFallback,
        ...(existingTouchdown || {}),
      }).filter(([, value]) => value !== null && value !== undefined))
    : null;

  const existingStability = landing.ultimateStability && typeof landing.ultimateStability === 'object'
    ? landing.ultimateStability
    : null;
  const gateFailures = Array.isArray(landing.stabilityGateFailures)
    ? landing.stabilityGateFailures.filter(Boolean)
    : [];
  const stabilityFallback = {
    score: knownFiniteNumber(landing.stabilityScore),
    verdict: nonEmptyString(landing.stabilityVerdict),
    gateStable: booleanOrNull(landing.gateStable),
    gateFailures: gateFailures.length > 0 ? gateFailures : null,
    breakdown: landing.stabilityBreakdown && typeof landing.stabilityBreakdown === 'object'
      ? landing.stabilityBreakdown
      : null,
    scoringContext: landing.stabilityContext && typeof landing.stabilityContext === 'object'
      ? landing.stabilityContext
      : null,
  };
  const hasStabilityFallback = Object.values(stabilityFallback).some((value) => value !== null);
  const ultimateStability = existingStability || hasStabilityFallback
    ? Object.fromEntries(Object.entries({
        ...stabilityFallback,
        ...(existingStability || {}),
      }).filter(([, value]) => value !== null && value !== undefined))
    : null;

  return {
    ...landing,
    type: 'landing',
    vs_fpm: knownFiniteNumber(landing.vs_fpm) ?? knownFiniteNumber(landing.vsFpm),
    ...(touchdownDistance ? { touchdownDistance } : {}),
    ...(ultimateStability ? { ultimateStability } : {}),
  };
}

function normalizeFuelBurnGal(value: unknown): number | null {
  const numeric = finiteNumber(value);
  return numeric !== null && numeric > 1 ? numeric : null;
}

function getTimestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function getAirportIcao(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const icao = String((value as AnyRecord).icao || '').trim().toUpperCase();
  return icao || null;
}

function getDepartureIcao(flight: AnyRecord): string | null {
  return getAirportIcao(flight.departureAirport)
    || getAirportIcao(flight.departureNearbyAirport)
    || null;
}

function getArrivalIcao(flight: AnyRecord): string | null {
  return getAirportIcao(flight.arrivalAirport)
    || getAirportIcao(flight.arrivalNearbyAirport)
    || null;
}

function normalizeSearch(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function flightRouteText(flight: AnyRecord): string {
  return [
    flight.displayRouteLabel,
    flight.route,
    flight.flightId,
    getDepartureIcao(flight),
    getArrivalIcao(flight),
  ].map((value) => String(value || '')).join(' ');
}

function compareText(left: unknown, right: unknown): number {
  const normalizedLeft = normalizeSearch(left);
  const normalizedRight = normalizeSearch(right);
  if (!normalizedLeft && !normalizedRight) return 0;
  if (!normalizedLeft) return 1;
  if (!normalizedRight) return -1;
  return normalizedLeft.localeCompare(normalizedRight, undefined, { numeric: true, sensitivity: 'base' });
}

function flightTimestampMs(flight: AnyRecord): number {
  return getTimestampMs(flight.timestamp) || finiteNumber(flight.mtimeMs) || 0;
}

function compareRecent(left: AnyRecord, right: AnyRecord): number {
  return flightTimestampMs(right) - flightTimestampMs(left);
}

function compareFuel(left: AnyRecord, right: AnyRecord, direction: 'asc' | 'desc'): number {
  const leftFuel = normalizeFuelBurnGal(left.fuelBurnGal);
  const rightFuel = normalizeFuelBurnGal(right.fuelBurnGal);
  if (leftFuel === null && rightFuel === null) return 0;
  if (leftFuel === null) return 1;
  if (rightFuel === null) return -1;
  return direction === 'desc' ? rightFuel - leftFuel : leftFuel - rightFuel;
}

function normalizeTimelineFlightForIndex(flight: AnyRecord): AnyRecord | null {
  if (!flight || typeof flight !== 'object') return null;
  if (typeof flight.filePath !== 'string' || !flight.filePath.trim()) return null;
  const timestampMs = getTimestampMs(flight.timestamp) || finiteNumber(flight.mtimeMs) || Date.now();
  const sizeBytes = finiteNumber(flight.sizeBytes) ?? 0;
  const csvMtimeMs = finiteNumber(flight.csvMtimeMs) ?? finiteNumber(flight.mtimeMs) ?? timestampMs;
  const csvSizeBytes = finiteNumber(flight.csvSizeBytes) ?? sizeBytes;
  const flightId = String(flight.flightId || '').trim() || String(flight.filePath).split(/[\\/]/).pop() || 'flight';
  const fuelBurnGal = normalizeFuelBurnGal(flight.fuelBurnGal);
  const bundleCatalogRevision = finiteNumber(flight.recordingBundleCatalogRevision);
  const bundleSizeBytes = finiteNumber(flight.recordingBundleSizeBytes);

  return {
    source: {
      filePath: flight.filePath,
      mtimeMs: bundleCatalogRevision ?? finiteNumber(flight.mtimeMs) ?? timestampMs,
      sizeBytes: bundleSizeBytes ?? sizeBytes,
      ...(typeof flight.recordingSessionId === 'string' && flight.recordingSessionId
        ? { recordingSessionId: flight.recordingSessionId }
        : {}),
    },
    flights: [{
      flightId,
      startedAtMs: timestampMs,
      endedAtMs: null,
      aircraft: typeof flight.aircraft === 'string' ? flight.aircraft : null,
      aircraftProfileId: typeof flight.aircraftProfileId === 'string' ? flight.aircraftProfileId : null,
      departureIcao: getDepartureIcao(flight),
      arrivalIcao: getArrivalIcao(flight),
      routeLabel: typeof flight.route === 'string' ? flight.route : null,
      displayRouteLabel: typeof flight.displayRouteLabel === 'string' ? flight.displayRouteLabel : null,
      durationMs: finiteNumber(flight.durationMs),
      durationFormatted: typeof flight.durationFormatted === 'string' ? flight.durationFormatted : null,
      sampleCount: finiteNumber(flight.sampleCount),
      eventCount: finiteNumber(flight.eventCount),
      fuelBurnGal,
      fuelBurnSource: fuelBurnGal !== null && typeof flight.fuelBurnSource === 'string' ? flight.fuelBurnSource : null,
      payload: {
        ...flight,
        csvMtimeMs,
        csvSizeBytes,
        timestamp: flight.timestamp instanceof Date ? flight.timestamp.toISOString() : flight.timestamp,
      },
    }],
    landings: [],
  };
}

function queryTimelineFlightsPage(flights: unknown[], options: TimelineFlightIndexQueryOptions = {}): AnyRecord {
  const limit = normalizeLimit(options.limit, 150, 1000);
  const offset = normalizeOffset(options.offset);
  const routeFilter = normalizeSearch(options.routeFilter);
  const aircraftFilter = normalizeSearch(options.aircraftFilter);

  const filtered = (Array.isArray(flights) ? flights : [])
    .filter((flight): flight is AnyRecord => Boolean(flight && typeof flight === 'object'))
    .filter((flight) => {
      const routeText = normalizeSearch(flightRouteText(flight));
      const aircraftText = normalizeSearch(flight.aircraft);
      return (!routeFilter || routeText.includes(routeFilter))
        && (!aircraftFilter || aircraftText.includes(aircraftFilter));
    });

  filtered.sort((left, right) => {
    switch (String(options.sort || 'recent')) {
      case 'oldest':
        return flightTimestampMs(left) - flightTimestampMs(right);
      case 'fuel_burn_desc':
        return compareFuel(left, right, 'desc') || compareRecent(left, right);
      case 'fuel_burn_asc':
        return compareFuel(left, right, 'asc') || compareRecent(left, right);
      case 'route':
        return compareText(left.displayRouteLabel || left.route, right.displayRouteLabel || right.route)
          || compareRecent(left, right);
      case 'aircraft':
        return compareText(left.aircraft, right.aircraft)
          || compareText(left.displayRouteLabel || left.route, right.displayRouteLabel || right.route)
          || compareRecent(left, right);
      case 'recent':
      default:
        return compareRecent(left, right);
    }
  });

  return {
    flights: limit === 0 ? [] : filtered.slice(offset, offset + limit),
    totalMatching: filtered.length,
    limit,
    offset,
  };
}

function refreshTimelineFlightsIndex(store: AnyRecord, flights: unknown[], options: { pruneMissing?: boolean } = {}): TimelineFlightIndexRefreshResult {
  const rows = Array.isArray(flights) ? flights : [];
  const indexedPaths: string[] = [];
  const changedSources: AnyRecord[] = [];
  let indexed = 0;
  let skipped = 0;

  for (const row of rows) {
    const normalized = normalizeTimelineFlightForIndex(row as AnyRecord);
    if (!normalized) {
      skipped += 1;
      continue;
    }
    indexedPaths.push(normalized.source.filePath);
    const indexedSource = typeof store.getFlightsSourceByPath === 'function'
      ? store.getFlightsSourceByPath(normalized.source.filePath)
      : store.getSourceByPath?.(normalized.source.filePath);
    if (sourceIdentityMatches(normalized.source, indexedSource)) {
      skipped += 1;
      continue;
    }
    changedSources.push(normalized);
    indexed += 1;
  }

  if (changedSources.length > 0) {
    if (typeof store.replaceSourcesFlightsIndex === 'function') {
      store.replaceSourcesFlightsIndex(changedSources);
    } else if (typeof store.replaceSourcesIndex === 'function') {
      store.replaceSourcesIndex(changedSources);
    } else {
      for (const normalized of changedSources) {
        store.replaceSourceIndex(normalized);
      }
    }
  }

  const pruned = options.pruneMissing === false ? 0 : store.pruneMissingSources(indexedPaths);
  return {
    indexed,
    skipped,
    pruned,
    totalInput: rows.length,
  };
}

function queryIndexedTimelineFlights(store: AnyRecord, options: TimelineFlightIndexQueryOptions = {}): AnyRecord {
  const page = store.queryFlights(options);
  if (typeof store.queryLatestLandingForSource !== 'function' || !Array.isArray(page?.flights)) {
    return page;
  }
  return {
    ...page,
    flights: page.flights.map((flight: AnyRecord) => {
      const sourceId = typeof flight?.sourceId === 'string' ? flight.sourceId : '';
      if (!sourceId) return flight;
      const latestLanding = store.queryLatestLandingForSource(sourceId);
      const landingEvent = latestLanding?.payload && typeof latestLanding.payload === 'object'
        ? latestLanding.payload
        : latestLanding;
      if (!landingEvent || typeof landingEvent !== 'object') return flight;
      return {
        ...flight,
        latestLandingEvent: normalizeIndexedLandingEvent(landingEvent),
      };
    }),
  };
}

module.exports = {
  normalizeTimelineFlightForIndex,
  normalizeIndexedLandingEvent,
  queryIndexedTimelineFlights,
  queryTimelineFlightsPage,
  refreshTimelineFlightsIndex,
};

export {};
