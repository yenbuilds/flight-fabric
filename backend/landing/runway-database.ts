/**
 * Runway Database
 *
 * Provides runway threshold coordinates and lengths for touchdown distance
 * calculation using local OurAirports CSV data.
 *
 * @module runway-database
 */

'use strict';

const { resolveOurAirportsFile } = require('./ourairports-paths');
const csvCache = require('./ourairports-csv-cache') as CsvCacheModule;
const { parseCsvLine, splitCsvLines } = require('../utils/csv') as CsvModule;
const { getRunwayCsvIndexes } = require('./runway-csv-columns') as RunwayCsvColumnsModule;
const {
  deriveTrueBearingFromCoordinates,
  getRunwayTrueHeadingDeg,
  headingDifferenceDegrees,
} = require('../utils/aviation-frames') as AviationFramesModule;

type CsvCacheModule = {
  getContent: (fileName: string) => string | null;
  releaseAll: () => void;
};

type CsvModule = {
  parseCsvLine: (line: string) => string[];
  splitCsvLines: (content: string) => string[];
};

type RunwayCsvIndexes = {
  airport_ident: number;
  le_ident: number;
  he_ident: number;
  le_lat: number;
  le_lon: number;
  he_lat: number;
  he_lon: number;
  length_ft: number;
  width_ft: number;
  surface: number;
  closed: number;
  le_heading_degT: number;
  he_heading_degT: number;
  le_displaced_threshold_ft: number;
  he_displaced_threshold_ft: number;
};

type RunwayCsvColumnsModule = {
  getRunwayCsvIndexes: (headers: string[]) => RunwayCsvIndexes;
};

type AviationFramesModule = {
  deriveTrueBearingFromCoordinates: (
    fromLatDeg: unknown,
    fromLonDeg: unknown,
    toLatDeg: unknown,
    toLonDeg: unknown,
  ) => number | null;
  getRunwayTrueHeadingDeg: (input: Record<string, unknown> | null | undefined) => number | null;
  headingDifferenceDegrees: (leftHeadingDeg: unknown, rightHeadingDeg: unknown) => number | null;
};

type AirportMeta = {
  name: string;
  elevation_ft: number;
};

type RunwayThreshold = {
  lat: number;
  lon: number;
};

type RunwayRecord = {
  lengthFt: number;
  physicalLengthFt: number;
  widthFt: number;
  surface: string;
  threshold: RunwayThreshold;
  physicalThreshold: RunwayThreshold;
  displacedThresholdFt: number;
  heading_true_deg: number;
  /** Legacy alias for heading_true_deg; keep until all consumers migrate. */
  heading: number;
};

type AirportEntry = {
  name: string;
  elevation_ft: number;
  runways: Record<string, RunwayRecord>;
};

type AirportDatabase = Record<string, AirportEntry>;

type RunwayLookup = RunwayRecord & {
  icao: string;
  runway: string;
  airportName: string;
  elevation_ft: number;
  elevationReference: 'airport';
};

type RunwayPositionMatch = RunwayLookup & {
  alongTrackFt?: number;
  crossTrackFt?: number;
  score?: number;
  distanceFromThreshold: number;
};

// -----------------------------------------------------------------------------
// Data Source Notes
// -----------------------------------------------------------------------------

/**
 * Runway data sources:
 *
 * 1. OurAirports (open data): https://ourairports.com/data/
 *    - runways.csv has threshold coords worldwide
 *    - airports.csv provides names/elevation
 *    - Public Domain data; GitHub mirror uses an Unlicense/public-domain dedication
 */

const RUNWAYS_CSV = resolveOurAirportsFile('runways.csv');

let csvAirportsCache: AirportDatabase | null = null;
let csvLoadError: string | null = null;

function ensureAirportEntry(
  database: AirportDatabase,
  airportIdent: string,
  airportMetaByIdent: Map<string, AirportMeta>,
): AirportEntry | null {
  const icao = String(airportIdent || '').toUpperCase();
  if (!icao) return null;

  if (database[icao]) return database[icao];

  const metadata = airportMetaByIdent.get(icao);
  database[icao] = {
    name: metadata?.name || icao,
    elevation_ft: metadata?.elevation_ft || 0,
    runways: {},
  };
  return database[icao];
}

function loadAirportsMetadata(): Map<string, AirportMeta> {
  const airportMetaByIdent = new Map<string, AirportMeta>();
  const content = csvCache.getContent('airports.csv');
  if (!content) return airportMetaByIdent;

  const lines = splitCsvLines(content);
  if (lines.length === 0) return airportMetaByIdent;

  const headers = parseCsvLine(lines[0]);
  const identIdx = headers.indexOf('ident');
  const nameIdx = headers.indexOf('name');
  const elevationIdx = headers.indexOf('elevation_ft');

  if (identIdx < 0) return airportMetaByIdent;

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const ident = String(fields[identIdx] || '').toUpperCase();
    if (!ident) continue;

    const elevation = parseFloat(fields[elevationIdx]);
    airportMetaByIdent.set(ident, {
      name: fields[nameIdx] || ident,
      elevation_ft: Number.isFinite(elevation) ? elevation : 0,
    });
  }

  return airportMetaByIdent;
}

function parsePositiveInteger(value: unknown): number {
  const parsed = parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function thresholdDisplacedAlongHeading(
  threshold: RunwayThreshold,
  headingDeg: number,
  displacedThresholdFt: number,
): RunwayThreshold {
  if (!Number.isFinite(displacedThresholdFt) || displacedThresholdFt <= 0) return threshold;
  if (!Number.isFinite(headingDeg)) return threshold;

  const headingRad = (headingDeg * Math.PI) / 180;
  const northFt = Math.cos(headingRad) * displacedThresholdFt;
  const eastFt = Math.sin(headingRad) * displacedThresholdFt;
  const cosLat = Math.cos((threshold.lat * Math.PI) / 180);
  if (Math.abs(cosLat) < 1e-9) return threshold;

  return {
    lat: threshold.lat + (northFt / 364567),
    lon: threshold.lon + (eastFt / (364567 * cosLat)),
  };
}

function loadCsvAirportDatabase(): AirportDatabase {
  const airportMetaByIdent = loadAirportsMetadata();
  const database: AirportDatabase = {};

  const rwyContent = csvCache.getContent('runways.csv');
  if (!rwyContent) {
    csvLoadError = `Runways file not found: ${RUNWAYS_CSV}`;
    return database;
  }

  const lines = splitCsvLines(rwyContent);
  if (lines.length === 0) {
    csvLoadError = `Runways file is empty: ${RUNWAYS_CSV}`;
    return database;
  }

  const headers = parseCsvLine(lines[0]);
  const idx = getRunwayCsvIndexes(headers);

  if (idx.airport_ident < 0) {
    csvLoadError = `Invalid runways CSV format: ${RUNWAYS_CSV}`;
    return database;
  }

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const airportIdent = String(fields[idx.airport_ident] || '').toUpperCase();
    if (!airportIdent) continue;
    if (idx.closed >= 0 && fields[idx.closed] === '1') continue;

    const airport = ensureAirportEntry(database, airportIdent, airportMetaByIdent);
    if (!airport) continue;

    const lengthFt = parseInt(fields[idx.length_ft], 10);
    const widthFt = parseInt(fields[idx.width_ft], 10);
    const surface = fields[idx.surface] || 'unknown';

    const endpoints = [
      {
        id: idx.le_ident >= 0 ? fields[idx.le_ident] : '',
        lat: idx.le_lat >= 0 ? parseFloat(fields[idx.le_lat]) : NaN,
        lon: idx.le_lon >= 0 ? parseFloat(fields[idx.le_lon]) : NaN,
        hdgT: idx.le_heading_degT >= 0 ? parseFloat(fields[idx.le_heading_degT]) : NaN,
        displacedThresholdFt: idx.le_displaced_threshold_ft >= 0
          ? parsePositiveInteger(fields[idx.le_displaced_threshold_ft])
          : 0,
      },
      {
        id: idx.he_ident >= 0 ? fields[idx.he_ident] : '',
        lat: idx.he_lat >= 0 ? parseFloat(fields[idx.he_lat]) : NaN,
        lon: idx.he_lon >= 0 ? parseFloat(fields[idx.he_lon]) : NaN,
        hdgT: idx.he_heading_degT >= 0 ? parseFloat(fields[idx.he_heading_degT]) : NaN,
        displacedThresholdFt: idx.he_displaced_threshold_ft >= 0
          ? parsePositiveInteger(fields[idx.he_displaced_threshold_ft])
          : 0,
      },
    ];

    for (let endpointIndex = 0; endpointIndex < endpoints.length; endpointIndex += 1) {
      const endpoint = endpoints[endpointIndex];
      const oppositeEndpoint = endpoints[endpointIndex === 0 ? 1 : 0];
      const runwayId = String(endpoint.id || '').toUpperCase();
      if (!runwayId) continue;
      if (!Number.isFinite(endpoint.lat) || !Number.isFinite(endpoint.lon)) continue;

      const headingTrueDeg = Number.isFinite(endpoint.hdgT)
        ? endpoint.hdgT
        : deriveTrueBearingFromCoordinates(
            endpoint.lat,
            endpoint.lon,
            oppositeEndpoint.lat,
            oppositeEndpoint.lon,
          );
      // A runway designator is magnetic and rounded. Never promote it to true
      // geometry: without an explicit degT value or two valid thresholds, omit
      // this direction so crosswind and touchdown geometry fail closed.
      if (headingTrueDeg == null) continue;
      const physicalLengthFt = Number.isFinite(lengthFt) ? lengthFt : 0;
      const displacedThresholdFt = endpoint.displacedThresholdFt;
      const threshold = thresholdDisplacedAlongHeading(
        { lat: endpoint.lat, lon: endpoint.lon },
        headingTrueDeg,
        displacedThresholdFt,
      );

      airport.runways[runwayId] = {
        lengthFt: Math.max(0, physicalLengthFt - displacedThresholdFt),
        physicalLengthFt,
        widthFt: Number.isFinite(widthFt) ? widthFt : 0,
        surface,
        threshold,
        physicalThreshold: {
          lat: endpoint.lat,
          lon: endpoint.lon,
        },
        displacedThresholdFt,
        heading_true_deg: headingTrueDeg,
        heading: headingTrueDeg,
      };
    }
  }

  csvLoadError = null;
  return database;
}

function getAirportsDb(): AirportDatabase {
  if (csvAirportsCache) return csvAirportsCache;
  csvAirportsCache = loadCsvAirportDatabase();
  // Raw CSV strings no longer needed — release to free ~16MB
  csvCache.releaseAll();
  return csvAirportsCache;
}

// -----------------------------------------------------------------------------
// Query Functions
// -----------------------------------------------------------------------------

/**
 * Get airport data by ICAO code
 *
 * @param {string} icao - ICAO code (case-insensitive)
 * @returns {Object|null} Airport data or null if not found
 */
function getAirport(icao: string | null | undefined): AirportEntry | null {
  if (!icao) return null;
  const airports = getAirportsDb();
  return airports[icao.toUpperCase()] || null;
}

/**
 * Get runway data
 *
 * @param {string} icao - ICAO code
 * @param {string} runway - Runway identifier (e.g., '31L', '09R')
 * @returns {Object|null} Runway data or null if not found
 */
function getRunway(icao: string, runway: string): RunwayLookup | null {
  const airport = getAirport(icao);
  if (!airport || !runway) return null;

  const normalizedRwy = runway.toUpperCase().replace(/^0+/, '');

  if (airport.runways[normalizedRwy]) {
    return {
      ...airport.runways[normalizedRwy],
      icao: icao.toUpperCase(),
      runway: normalizedRwy,
      airportName: airport.name,
      elevation_ft: airport.elevation_ft,
      elevationReference: 'airport',
    };
  }

  const withZero = normalizedRwy.replace(/^(\d)([LRC]?)$/, '0$1$2');
  if (airport.runways[withZero]) {
    return {
      ...airport.runways[withZero],
      icao: icao.toUpperCase(),
      runway: withZero,
      airportName: airport.name,
      elevation_ft: airport.elevation_ft,
      elevationReference: 'airport',
    };
  }

  return null;
}

/**
 * Find runway by touchdown position and optionally aircraft heading
 *
 * @param {number} lat - Touchdown latitude
 * @param {number} lon - Touchdown longitude
 * @param {number} [maxDistanceNm=2] - Maximum distance from threshold (nm)
 * @param {number} [aircraftTrueHeadingDeg=null] - Aircraft true heading at touchdown (degrees true)
 * @returns {Object|null} Best matching runway or null
 */
function findRunwayByPosition(
  lat: number | null | undefined,
  lon: number | null | undefined,
  maxDistanceNm = 2,
  aircraftTrueHeadingDeg: number | null = null,
): RunwayPositionMatch | null {
  if (lat == null || lon == null) return null;
  const airports = getAirportsDb();

  const NM_TO_DEG_LAT = 1 / 60;
  const maxDistDeg = maxDistanceNm * NM_TO_DEG_LAT * 2;
  const HEADING_TOLERANCE_DEG = 30;
  // maxDistanceNm is primarily an along-runway/threshold search radius. It
  // must not permit runway identity several thousand feet off centerline.
  // 1,500 ft still tolerates unusually poor scenery/database alignment while
  // rejecting a different parallel runway or nearby airport.
  const maxCrossTrackFt = Math.min(maxDistanceNm * 6076, 1500);

  function computeAlongTrack(
    threshold: RunwayThreshold,
    point: RunwayThreshold,
    headingDeg: number,
  ): { alongTrackFt: number; crossTrackFt: number } {
    const FT_PER_DEG_LAT = 364567;
    const cosLat = Math.cos((threshold.lat * Math.PI) / 180);

    const dLat = point.lat - threshold.lat;
    const dLon = point.lon - threshold.lon;

    const dNorthFt = dLat * FT_PER_DEG_LAT;
    const dEastFt = dLon * FT_PER_DEG_LAT * cosLat;

    const rwyRad = (headingDeg * Math.PI) / 180;
    const rwyDirX = Math.sin(rwyRad);
    const rwyDirY = Math.cos(rwyRad);

    const alongTrackFt = dEastFt * rwyDirX + dNorthFt * rwyDirY;
    const crossTrackFt = Math.abs(dEastFt * rwyDirY - dNorthFt * rwyDirX);

    return { alongTrackFt, crossTrackFt };
  }

  function approximateSurfaceDistanceNm(
    from: RunwayThreshold,
    to: RunwayThreshold,
  ): number {
    const meanLatRad = ((from.lat + to.lat) / 2) * Math.PI / 180;
    const dLatDeg = to.lat - from.lat;
    const dLonDeg = (to.lon - from.lon) * Math.cos(meanLatRad);
    return Math.sqrt(dLatDeg ** 2 + dLonDeg ** 2) * 60;
  }

  function hasRunwayWithinLatitudeGate(
    runwayEntries: Array<[string, RunwayRecord]>,
    targetLat: number,
    maxDeltaDeg: number,
  ): boolean {
    return runwayEntries.some(([, rwy]) => Math.abs(rwy.threshold.lat - targetLat) <= maxDeltaDeg);
  }

  const candidates: RunwayPositionMatch[] = [];

  for (const [icao, airport] of Object.entries(airports) as Array<[string, AirportEntry]>) {
    const runwayEntries = Object.entries(airport.runways) as Array<[string, RunwayRecord]>;
    if (runwayEntries.length === 0) continue;
    if (!hasRunwayWithinLatitudeGate(runwayEntries, lat, maxDistDeg)) continue;

    for (const [rwyId, rwy] of runwayEntries) {
      const runwayTrueHeadingDeg = getRunwayTrueHeadingDeg(rwy);
      if (runwayTrueHeadingDeg == null) continue;

      if (aircraftTrueHeadingDeg != null) {
        const diff = Math.abs(headingDifferenceDegrees(aircraftTrueHeadingDeg, runwayTrueHeadingDeg) ?? Infinity);
        if (diff > HEADING_TOLERANCE_DEG) continue;
      }

      const { alongTrackFt, crossTrackFt } = computeAlongTrack(
        rwy.threshold,
        { lat, lon },
        runwayTrueHeadingDeg
      );

      // The along-track window alone is not a geographic proximity test. A
      // parallel runway at the same latitude can have a plausible along-track
      // value while being arbitrarily far away laterally.
      if (crossTrackFt > maxCrossTrackFt) continue;

      const displacedThresholdFt = Number.isFinite(rwy.displacedThresholdFt) ? rwy.displacedThresholdFt : 0;
      const withinRunway = alongTrackFt >= -(displacedThresholdFt + 500) && alongTrackFt <= (rwy.lengthFt + 2000);
      if (!withinRunway) continue;

      const score = crossTrackFt + (alongTrackFt < 0 ? 5000 : 0);

      candidates.push({
        ...rwy,
        icao,
        runway: rwyId,
        airportName: airport.name,
        elevation_ft: airport.elevation_ft,
        elevationReference: 'airport',
        alongTrackFt,
        crossTrackFt,
        score,
        distanceFromThreshold: alongTrackFt / 6076,
      });
    }
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

  let bestMatch: RunwayPositionMatch | null = null;
  let bestDistanceNm = Infinity;

  for (const [icao, airport] of Object.entries(airports) as Array<[string, AirportEntry]>) {
    const runwayEntries = Object.entries(airport.runways) as Array<[string, RunwayRecord]>;
    if (runwayEntries.length === 0) continue;
    if (!hasRunwayWithinLatitudeGate(runwayEntries, lat, maxDistDeg)) continue;

    for (const [rwyId, rwy] of runwayEntries) {
      const runwayTrueHeadingDeg = getRunwayTrueHeadingDeg(rwy);
      if (runwayTrueHeadingDeg == null) continue;

      // Apply same heading filter as primary search to avoid matching
      // perpendicular crossing runways in the fallback path
      if (aircraftTrueHeadingDeg != null) {
        const diff = Math.abs(headingDifferenceDegrees(aircraftTrueHeadingDeg, runwayTrueHeadingDeg) ?? Infinity);
        if (diff > HEADING_TOLERANCE_DEG) continue;
      }

      const { crossTrackFt } = computeAlongTrack(rwy.threshold, { lat, lon }, runwayTrueHeadingDeg);
      if (crossTrackFt > maxCrossTrackFt) continue;

      const distanceNm = approximateSurfaceDistanceNm(rwy.threshold, { lat, lon });

      if (distanceNm < bestDistanceNm) {
        bestDistanceNm = distanceNm;
        bestMatch = {
          ...rwy,
          icao,
          runway: rwyId,
          airportName: airport.name,
          elevation_ft: airport.elevation_ft,
          elevationReference: 'airport',
          distanceFromThreshold: distanceNm,
        };
      }
    }
  }

  if (bestDistanceNm > maxDistanceNm) return null;

  return bestMatch;
}

/**
/**
 * Check if a position is near any known airport
 *
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {number} [radiusNm=5] - Search radius in nautical miles
 * @returns {Object|null} Nearest airport or null
 */
function findNearbyAirport(
  lat: number,
  lon: number,
  radiusNm = 5,
): { icao: string; name: string; elevation_ft: number; distanceNm: number } | null {
  const runway = findRunwayByPosition(lat, lon, radiusNm);
  if (!runway) return null;

  return {
    icao: runway.icao,
    name: runway.airportName,
    elevation_ft: runway.elevation_ft,
    distanceNm: runway.distanceFromThreshold,
  };
}

// -----------------------------------------------------------------------------
// Database Stats
// -----------------------------------------------------------------------------

/**
 * Get database coverage statistics
 *
 * @returns {Object} Coverage stats
 */
function getDatabaseStats(): {
  airportCount: number;
  runwayCount: number;
  shortRunwayCount: number;
  coverage: string;
  dataQuality: string;
  lastUpdated: null;
  sources: string[];
  loadError: string | null;
} {
  const airportsDb = getAirportsDb();
  const airports = Object.keys(airportsDb).length;
  let totalRunways = 0;
  let shortRunways = 0;

  for (const airport of Object.values(airportsDb) as AirportEntry[]) {
    for (const rwy of Object.values(airport.runways) as RunwayRecord[]) {
      totalRunways++;
      if (rwy.lengthFt < 6000) shortRunways++;
    }
  }

  return {
    airportCount: airports,
    runwayCount: totalRunways,
    shortRunwayCount: shortRunways,
    coverage: 'OurAirports CSV coverage',
    dataQuality: airports > 0 ? 'from local CSV import (OurAirports)' : 'unavailable (CSV not loaded)',
    lastUpdated: null,
    sources: ['OurAirports runways.csv', 'OurAirports airports.csv'],
    loadError: csvLoadError,
  };
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
  getAirport,
  getRunway,
  findRunwayByPosition,
  findNearbyAirport,
  getDatabaseStats,
};

export {};
