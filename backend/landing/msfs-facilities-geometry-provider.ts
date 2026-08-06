/**
 * MSFS Facilities Geometry Provider
 *
 * Keeps the domain-facing airport geometry API synchronous while refreshing
 * MSFS Facilities airport data through the Rust SimConnect sidecar in the
 * background. If the cache is cold or a request fails, airport-geometry-service
 * continues to fall back to OurAirports.
 */

'use strict';

type AnyRecord = Record<string, any>;

type Logger = {
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

type SidecarBridge = {
  requestFacilityAirport?: (
    icao: string,
    options?: { region?: string; timeoutMs?: number },
  ) => Promise<AnyRecord>;
  getSnapshot?: () => AnyRecord;
};

type CachedAirport = {
  icao: string;
  name: string;
  elevation_ft: number | null;
  runways: Record<string, AnyRecord>;
  fetchedAtMs: number;
  error: string | null;
};

type ProviderOptions = {
  cacheTtlMs?: number;
  errorRetryMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  logger?: Logger | null;
  logThrottleMs?: number;
};

type AirportRequestOptions = {
  force?: boolean;
  timeoutMs?: number;
};

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_ERROR_RETRY_MS = 30 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 4000;
const DEFAULT_LOG_THROTTLE_MS = 2 * 60 * 1000;
const FT_PER_DEG_LAT = 364567;
const HEADING_TOLERANCE_DEG = 30;

function finiteNumber(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeIcao(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (normalized.length < 2 || normalized.length > 8) return null;
  if (!/^[A-Z0-9_]+$/.test(normalized)) return null;
  return normalized;
}

function normalizeRunwayId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim().toUpperCase().replace(/^RWY\s*/, '');
  if (!normalized) return null;
  return normalized;
}

function runwayLookupKeys(value: unknown): string[] {
  const normalized = normalizeRunwayId(value);
  if (!normalized) return [];
  const keys = new Set<string>([normalized]);
  keys.add(normalized.replace(/^0+(\d)/, '$1'));
  const withZero = normalized.replace(/^(\d)([A-Z]?)$/, '0$1$2');
  keys.add(withZero);
  return [...keys].filter(Boolean);
}

function normalizeHeading(value: unknown): number | null {
  const numeric = finiteNumber(value);
  if (numeric == null) return null;
  const normalized = ((numeric % 360) + 360) % 360;
  return Math.round(normalized * 1_000_000) / 1_000_000;
}

function headingDifferenceDegrees(left: unknown, right: unknown): number | null {
  const a = normalizeHeading(left);
  const b = normalizeHeading(right);
  if (a == null || b == null) return null;
  let diff = a - b;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return diff;
}

function coordinate(value: unknown): { lat: number; lon: number } | null {
  if (!value || typeof value !== 'object') return null;
  const lat = finiteNumber((value as AnyRecord).lat);
  const lon = finiteNumber((value as AnyRecord).lon);
  return lat == null || lon == null ? null : { lat, lon };
}

function computeAlongTrack(
  threshold: { lat: number; lon: number },
  point: { lat: number; lon: number },
  headingDeg: number,
): { alongTrackFt: number; crossTrackFt: number } {
  const cosLat = Math.cos((threshold.lat * Math.PI) / 180);
  const dLat = point.lat - threshold.lat;
  const dLon = point.lon - threshold.lon;
  const dNorthFt = dLat * FT_PER_DEG_LAT;
  const dEastFt = dLon * FT_PER_DEG_LAT * cosLat;
  const rwyRad = (headingDeg * Math.PI) / 180;
  const rwyDirX = Math.sin(rwyRad);
  const rwyDirY = Math.cos(rwyRad);

  return {
    alongTrackFt: dEastFt * rwyDirX + dNorthFt * rwyDirY,
    crossTrackFt: Math.abs(dEastFt * rwyDirY - dNorthFt * rwyDirX),
  };
}

function approximateSurfaceDistanceNm(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): number {
  const meanLatRad = ((from.lat + to.lat) / 2) * Math.PI / 180;
  const dLatDeg = to.lat - from.lat;
  const dLonDeg = (to.lon - from.lon) * Math.cos(meanLatRad);
  return Math.sqrt(dLatDeg ** 2 + dLonDeg ** 2) * 60;
}

function normalizeRunway(raw: AnyRecord, airport: CachedAirport): AnyRecord | null {
  const runwayId = normalizeRunwayId(raw.runway ?? raw.runwayId ?? raw.runway_id);
  const threshold = coordinate(raw.threshold);
  const heading = normalizeHeading(raw.headingTrueDeg ?? raw.heading_true_deg ?? raw.heading);
  if (!runwayId || !threshold || heading == null) return null;

  const physicalThreshold = coordinate(raw.physicalThreshold ?? raw.physical_threshold);
  const lengthFt = finiteNumber(raw.lengthFt ?? raw.length_ft);
  const physicalLengthFt = finiteNumber(raw.physicalLengthFt ?? raw.physical_length_ft);
  const widthFt = finiteNumber(raw.widthFt ?? raw.width_ft);
  const displacedThresholdFt = finiteNumber(raw.displacedThresholdFt ?? raw.displaced_threshold_ft);
  const elevationFt = finiteNumber(raw.elevation_ft ?? raw.elevationFt ?? airport.elevation_ft);

  return {
    ...raw,
    source: 'msfs-facilities',
    icao: airport.icao,
    runway: runwayId,
    airportName: airport.name,
    elevation_ft: elevationFt,
    threshold,
    physicalThreshold,
    headingTrueDeg: heading,
    heading_true_deg: heading,
    heading,
    lengthFt,
    physicalLengthFt,
    widthFt,
    displacedThresholdFt,
    length_ft: lengthFt,
    physical_length_ft: physicalLengthFt,
    width_ft: widthFt,
    displaced_threshold_ft: displacedThresholdFt,
  };
}

function createEmptyAirport(icao: string): CachedAirport {
  return {
    icao,
    name: icao,
    elevation_ft: null,
    runways: {},
    fetchedAtMs: 0,
    error: null,
  };
}

function createMsfsFacilitiesGeometryProvider(
  bridge: SidecarBridge,
  options: ProviderOptions = {},
): AnyRecord {
  const cache = new Map<string, CachedAirport>();
  const pending = new Set<string>();
  const cacheTtlMs = Math.max(1000, Number(options.cacheTtlMs || DEFAULT_CACHE_TTL_MS));
  const errorRetryMs = Math.max(1000, Math.min(cacheTtlMs, Number(options.errorRetryMs || DEFAULT_ERROR_RETRY_MS)));
  const requestTimeoutMs = Math.max(500, Math.min(15000, Number(options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS)));
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const logger = options.logger === null ? null : (options.logger || console);
  const logThrottleMs = Math.max(0, Number(options.logThrottleMs ?? DEFAULT_LOG_THROTTLE_MS));
  const lastLogAtByKey = new Map<string, number>();
  let lastRequestIcao: string | null = null;
  let lastRequestAtMs: number | null = null;
  let lastOutcome: AnyRecord | null = null;

  function logThrottled(level: 'log' | 'warn', key: string, message: string): void {
    if (!logger) return;
    const logFn = level === 'warn' ? logger.warn : logger.log;
    if (typeof logFn !== 'function') return;

    const atMs = now();
    const lastAtMs = lastLogAtByKey.get(key);
    if (lastAtMs != null && atMs - lastAtMs < logThrottleMs) return;
    lastLogAtByKey.set(key, atMs);

    try {
      logFn.call(logger, message);
    } catch {
      // Logging must never affect live geometry fallback.
    }
  }

  function isBridgeUsable(): boolean {
    if (!bridge || typeof bridge.requestFacilityAirport !== 'function') {
      logThrottled(
        'warn',
        'unavailable:no-request-api',
        '[MSFS Facilities] unavailable: Rust bridge does not expose requestFacilityAirport; using fallback geometry',
      );
      return false;
    }
    const snapshot = typeof bridge.getSnapshot === 'function' ? bridge.getSnapshot() : null;
    const status = typeof snapshot?.status === 'string' ? snapshot.status.toLowerCase() : '';
    const liveStatuses = new Set(['connected', 'running']);
    if (status && !liveStatuses.has(status)) {
      const error = typeof snapshot?.error === 'string' && snapshot.error.trim()
        ? ` error=${snapshot.error.trim()}`
        : '';
      logThrottled(
        'warn',
        `unavailable:${status}:${error}`,
        `[MSFS Facilities] unavailable: Rust bridge status=${status || 'unknown'}${error}; using fallback geometry`,
      );
      return false;
    }
    return true;
  }

  function ingestAirport(message: AnyRecord, requestedIcao: string): AnyRecord {
    if (!message || message.ok !== true) {
      const failed = cache.get(requestedIcao) || createEmptyAirport(requestedIcao);
      failed.error = typeof message?.error === 'string' ? message.error : 'facility_request_failed';
      failed.fetchedAtMs = now();
      cache.set(requestedIcao, failed);
      lastOutcome = {
        ok: false,
        icao: requestedIcao,
        error: failed.error,
        atMs: failed.fetchedAtMs,
      };
      logThrottled(
        'warn',
        `failure:${requestedIcao}`,
        `[MSFS Facilities] airport request failed ICAO=${requestedIcao} error=${failed.error}; using fallback geometry`,
      );
      return lastOutcome;
    }

    if (!Array.isArray(message.runways) || message.runways.length === 0) {
      const failed = cache.get(requestedIcao) || createEmptyAirport(requestedIcao);
      failed.error = 'empty_facility_response';
      failed.fetchedAtMs = now();
      cache.set(requestedIcao, failed);
      lastOutcome = {
        ok: false,
        icao: requestedIcao,
        error: failed.error,
        runwayCount: 0,
        atMs: failed.fetchedAtMs,
      };
      logThrottled(
        'warn',
        `empty:${requestedIcao}`,
        `[MSFS Facilities] airport request returned no runway geometry ICAO=${requestedIcao}; using fallback geometry`,
      );
      return lastOutcome;
    }

    const icao = normalizeIcao(message.icao) || requestedIcao;
    const airportInfo = message.airport && typeof message.airport === 'object'
      ? message.airport
      : {};
    const airport: CachedAirport = {
      icao,
      name: typeof message.airportName === 'string' && message.airportName.trim()
        ? message.airportName.trim()
        : (typeof airportInfo.name === 'string' && airportInfo.name.trim() ? airportInfo.name.trim() : icao),
      elevation_ft: finiteNumber(airportInfo.elevationFt ?? message.elevationFt),
      runways: {},
      fetchedAtMs: now(),
      error: null,
    };

    for (const rawRunway of Array.isArray(message.runways) ? message.runways : []) {
      if (!rawRunway || typeof rawRunway !== 'object') continue;
      const runway = normalizeRunway(rawRunway, airport);
      if (!runway) continue;
      for (const key of runwayLookupKeys(runway.runway)) {
        airport.runways[key] = runway;
      }
    }

    cache.set(icao, airport);
    if (icao !== requestedIcao) cache.set(requestedIcao, airport);

    const runways = allUniqueRunwaysForAirport(airport);
    const runwayCount = runways.length;
    const unvalidatedThresholdCount = runways
      .filter((runway) => runway.thresholdMappingValidated === false)
      .length;
    const requestedSuffix = icao !== requestedIcao ? ` requested=${requestedIcao}` : '';
    const thresholdSuffix = unvalidatedThresholdCount > 0
      ? ` thresholdMapping=unvalidated(${unvalidatedThresholdCount})`
      : '';
    lastOutcome = {
      ok: true,
      icao,
      requestedIcao,
      runwayCount,
      unvalidatedThresholdCount,
      atMs: airport.fetchedAtMs,
    };
    logThrottled(
      'log',
      `cache:${icao}`,
      `[MSFS Facilities] cached airport geometry ICAO=${icao}${requestedSuffix} runways=${runwayCount}${thresholdSuffix}; fallback remains available`,
    );
    return lastOutcome;
  }

  function requestAirport(
    icaoValue: unknown,
    options: AirportRequestOptions = {},
  ): Promise<AnyRecord> {
    const icao = normalizeIcao(icaoValue);
    if (!icao) {
      return Promise.resolve({ ok: false, icao: null, error: 'invalid_icao' });
    }
    if (pending.has(icao)) {
      return Promise.resolve({ ok: false, icao, error: 'pending' });
    }
    if (!isBridgeUsable()) {
      return Promise.resolve({ ok: false, icao, error: 'bridge_unavailable' });
    }
    if (options.force !== true) {
      const cached = cache.get(icao);
      if (cached) {
        const ttl = cached.error && Object.keys(cached.runways).length === 0 ? errorRetryMs : cacheTtlMs;
        if (now() - cached.fetchedAtMs < ttl) {
          return Promise.resolve({ ok: true, icao, cached: true, skipped: 'cache_fresh' });
        }
      }
    }

    pending.add(icao);
    lastRequestIcao = icao;
    lastRequestAtMs = now();
    logThrottled(
      'log',
      `request:${icao}`,
      `[MSFS Facilities] requesting airport geometry ICAO=${icao}`,
    );
    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
      ? Math.max(500, Math.min(15000, Number(options.timeoutMs)))
      : requestTimeoutMs;
    let airportRequest: Promise<AnyRecord>;
    try {
      airportRequest = bridge.requestFacilityAirport!(icao, { timeoutMs });
    } catch (err) {
      const message = { ok: false, icao, error: err?.message || String(err) };
      const outcome = ingestAirport(message, icao);
      pending.delete(icao);
      return Promise.resolve(outcome);
    }
    return airportRequest
      .then((message) => {
        if (!message) {
          return ingestAirport({ ok: false, icao, error: 'empty_response' }, icao);
        }
        return ingestAirport(message, icao);
      })
      .catch((err) => {
        const message = { ok: false, icao, error: err?.message || String(err) };
        ingestAirport(message, icao);
        return message;
      })
      .finally(() => pending.delete(icao));
  }

  function prefetchAirport(icaoValue: unknown): void {
    requestAirport(icaoValue).catch(() => {});
  }

  function diagnosticSnapshot(): AnyRecord {
    const snapshot = typeof bridge.getSnapshot === 'function' ? bridge.getSnapshot() : null;
    const uniqueAirports = uniqueAirportsWithRunways(cache);
    const cachedIcaos = [...new Set(uniqueAirports.map((airport) => airport.icao))]
      .sort()
      .slice(0, 20);
    const errorIcaos = [...cache.values()]
      .filter((airport) => airport.error)
      .map((airport) => airport.icao)
      .filter((icao, index, all) => all.indexOf(icao) === index)
      .sort()
      .slice(0, 20);

    return {
      requestApi: typeof bridge.requestFacilityAirport === 'function',
      bridgeStatus: typeof snapshot?.status === 'string' ? snapshot.status : null,
      bridgeError: typeof snapshot?.error === 'string' ? snapshot.error : null,
      cacheEntryCount: cache.size,
      cacheAirportCount: uniqueAirports.length,
      cacheRunwayCount: uniqueAirports.reduce(
        (count, airport) => count + allUniqueRunwaysForAirport(airport).length,
        0,
      ),
      cachedIcaos,
      errorIcaos,
      pendingIcaos: [...pending].sort().slice(0, 20),
      lastRequestIcao,
      lastRequestAtMs,
      lastOutcome,
    };
  }

  function cachedAirport(icaoValue: unknown): CachedAirport | null {
    const icao = normalizeIcao(icaoValue);
    if (!icao) return null;
    prefetchAirport(icao);
    const cached = cache.get(icao);
    if (!cached || Object.keys(cached.runways).length === 0) return null;
    return cached;
  }

  function cachedRunway(icaoValue: unknown, runwayValue: unknown): AnyRecord | null {
    const airport = cachedAirport(icaoValue);
    if (!airport) return null;
    for (const key of runwayLookupKeys(runwayValue)) {
      if (airport.runways[key]) return airport.runways[key];
    }
    return null;
  }

  function allUniqueRunways(): AnyRecord[] {
    const seen = new Set<AnyRecord>();
    const runways: AnyRecord[] = [];
    for (const airport of cache.values()) {
      for (const runway of Object.values(airport.runways)) {
        if (seen.has(runway)) continue;
        seen.add(runway);
        runways.push(runway);
      }
    }
    return runways;
  }

  return {
    id: 'msfs-facilities',
    simulator: 'msfs',
    isAvailable: isBridgeUsable,
    prefetchAirport,
    probeAirport(icao: unknown, options: AirportRequestOptions = {}): Promise<AnyRecord> {
      return requestAirport(icao, { force: true, timeoutMs: options.timeoutMs });
    },
    getDiagnosticSnapshot: diagnosticSnapshot,
    getAirport(icao: string): AnyRecord | null {
      const airport = cachedAirport(icao);
      if (!airport) return null;
      return {
        name: airport.name,
        elevation_ft: airport.elevation_ft,
        source: 'msfs-facilities',
        runways: { ...airport.runways },
      };
    },
    getDatabaseStats(): AnyRecord {
      const airports = uniqueAirportsWithRunways(cache);
      let runwayCount = 0;
      for (const airport of airports) {
        runwayCount += allUniqueRunwaysForAirport(airport).length;
      }
      return {
        airportCount: airports.length,
        runwayCount,
        coverage: 'MSFS Facilities live cache',
        dataQuality: cache.size > 0 ? 'from MSFS Facilities API' : 'cold live cache',
        lastUpdated: null,
        sources: ['MSFS SimConnect Facilities'],
        loadError: null,
      };
    },
    getRunway(icao: string, runway: string): AnyRecord | null {
      return cachedRunway(icao, runway);
    },
    findRunwayByPosition(
      lat: number | null | undefined,
      lon: number | null | undefined,
      maxDistanceNm = 2,
      aircraftTrueHeadingDeg: number | null = null,
    ): AnyRecord | null {
      if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const point = { lat, lon };
      const candidates: AnyRecord[] = [];
      // maxDistanceNm also covers along-runway distance from the threshold;
      // cap lateral runway identity separately so a remote parallel runway is
      // not treated as the touchdown runway.
      const maxCrossTrackFt = Math.min(maxDistanceNm * 6076, 1500);

      for (const runway of allUniqueRunways()) {
        const threshold = coordinate(runway.threshold);
        const heading = normalizeHeading(runway.headingTrueDeg ?? runway.heading_true_deg ?? runway.heading);
        if (!threshold || heading == null) continue;
        if (aircraftTrueHeadingDeg != null) {
          const diff = Math.abs(headingDifferenceDegrees(aircraftTrueHeadingDeg, heading) ?? Infinity);
          if (diff > HEADING_TOLERANCE_DEG) continue;
        }

        const { alongTrackFt, crossTrackFt } = computeAlongTrack(threshold, point, heading);
        // Bound lateral proximity as well as along-runway position. Otherwise
        // a parallel cached runway can match a touchdown many miles away.
        if (crossTrackFt > maxCrossTrackFt) continue;
        const lengthFt = finiteNumber(runway.lengthFt ?? runway.length_ft) ?? 0;
        const displacedThresholdFt = finiteNumber(runway.displacedThresholdFt ?? runway.displaced_threshold_ft) ?? 0;
        const withinRunway = alongTrackFt >= -(displacedThresholdFt + 500) && alongTrackFt <= (lengthFt + 2000);
        if (!withinRunway) continue;
        candidates.push({
          ...runway,
          alongTrackFt,
          crossTrackFt,
          score: crossTrackFt + (alongTrackFt < 0 ? 5000 : 0),
          distanceFromThreshold: alongTrackFt / 6076,
        });
      }

      candidates.sort((a, b) => {
        // Runway identity is primarily lateral: a point on a centerline remains
        // that runway even when it is just before a staggered threshold. Preserve
        // the existing pre-threshold preference only for exact lateral ties.
        const crossTrackDelta = (a.crossTrackFt ?? Infinity) - (b.crossTrackFt ?? Infinity);
        return crossTrackDelta !== 0
          ? crossTrackDelta
          : (a.score ?? Infinity) - (b.score ?? Infinity);
      });
      if (candidates.length > 0) return candidates[0];

      let bestMatch: AnyRecord | null = null;
      let bestDistanceNm = Infinity;
      for (const runway of allUniqueRunways()) {
        const threshold = coordinate(runway.threshold);
        const heading = normalizeHeading(runway.headingTrueDeg ?? runway.heading_true_deg ?? runway.heading);
        if (!threshold || heading == null) continue;
        if (aircraftTrueHeadingDeg != null) {
          const diff = Math.abs(headingDifferenceDegrees(aircraftTrueHeadingDeg, heading) ?? Infinity);
          if (diff > HEADING_TOLERANCE_DEG) continue;
        }
        const { crossTrackFt } = computeAlongTrack(threshold, point, heading);
        if (crossTrackFt > maxCrossTrackFt) continue;
        const distanceNm = approximateSurfaceDistanceNm(threshold, point);
        if (distanceNm < bestDistanceNm) {
          bestDistanceNm = distanceNm;
          bestMatch = {
            ...runway,
            distanceFromThreshold: distanceNm,
          };
        }
      }

      return bestDistanceNm <= maxDistanceNm ? bestMatch : null;
    },
    findNearbyAirport(lat: number, lon: number, radiusNm = 5): AnyRecord | null {
      const runway = this.findRunwayByPosition(lat, lon, radiusNm);
      if (!runway) return null;
      return {
        icao: runway.icao,
        name: runway.airportName || runway.icao,
        elevation_ft: finiteNumber(runway.elevation_ft),
        distanceNm: runway.distanceFromThreshold,
        source: 'msfs-facilities',
      };
    },
    _cache: cache,
  };
}

function allUniqueRunwaysForAirport(airport: CachedAirport): AnyRecord[] {
  const seen = new Set<AnyRecord>();
  const runways: AnyRecord[] = [];
  for (const runway of Object.values(airport.runways)) {
    if (seen.has(runway)) continue;
    seen.add(runway);
    runways.push(runway);
  }
  return runways;
}

function uniqueAirportsWithRunways(cache: Map<string, CachedAirport>): CachedAirport[] {
  const seen = new Set<CachedAirport>();
  const airports: CachedAirport[] = [];
  for (const airport of cache.values()) {
    if (seen.has(airport)) continue;
    if (Object.keys(airport.runways).length === 0) continue;
    seen.add(airport);
    airports.push(airport);
  }
  return airports;
}

module.exports = {
  createMsfsFacilitiesGeometryProvider,
};

export {};
