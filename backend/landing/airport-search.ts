/**
 * Airport Search Module
 * 
 * Provides spatial search for airports using OurAirports data.
 * Supports filtering by minimum runway length for divert planning.
 * 
 * @module airport-search
 */

'use strict';

const Debug = require('../core/debug') as DebugModule;
const { resolveOurAirportsFile } = require('./ourairports-paths');
const csvCache = require('./ourairports-csv-cache') as CsvCacheModule;
const { getRunwayCsvIndexes } = require('./runway-csv-columns') as RunwayCsvColumnsModule;
const { parseCsvLine } = require('../utils/csv') as CsvModule;

type DebugModule = {
  log: (section: string, message: string, data?: Record<string, unknown>) => void;
};

type CsvCacheModule = {
  getContent: (fileName: string) => string | null;
  releaseAll: () => void;
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
};

type RunwayCsvColumnsModule = {
  getRunwayCsvIndexes: (headers: string[]) => RunwayCsvIndexes;
};

type CsvModule = {
  parseCsvLine: (line: string) => string[];
};

type AirportRunway = {
  le_ident: string;
  he_ident: string;
  length_ft: number;
  width_ft: number;
  surface: string;
};

type AirportRecord = {
  id: string;
  ident: string;
  icao: string;
  type: string;
  name: string;
  lat: number;
  lon: number;
  elevation_ft: number;
  /** ISO 3166-1 alpha-2 from OurAirports `iso_country`, or null when blank. */
  isoCountry: string | null;
  maxRunwayLengthFt: number;
  runways: AirportRunway[];
};

type SearchOptions = {
  radiusNm?: number;
  minRunwayLengthFt?: number;
  limit?: number;
  excludeTypes?: string[];
};

type SuitableAirportResult = {
  icao: string;
  ident: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  elevation_ft: number;
  maxRunwayLengthFt: number;
  distanceNm: number;
  bearingDeg: number;
};

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const AIRPORTS_FILE = resolveOurAirportsFile('airports.csv');
const RUNWAYS_FILE = resolveOurAirportsFile('runways.csv');

// Earth radius in nautical miles
const EARTH_RADIUS_NM = 3440.065;

// Conversion factors
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

const airports = new Map<string, AirportRecord>();     // ident -> airport data
const airportsByIcao = new Map<string, AirportRecord>(); // icao_code -> airport data, where it differs from ident
let airportsByCoord: AirportRecord[] = [];       // Array for spatial search [{lat, lon, icao, ...}]
let isLoaded = false;
let loadError: string | null = null;

// -----------------------------------------------------------------------------
// Geometry Functions
// -----------------------------------------------------------------------------

/**
 * Calculate great circle distance between two points (Haversine formula)
 * @param {number} lat1 - Latitude 1 (degrees)
 * @param {number} lon1 - Longitude 1 (degrees)
 * @param {number} lat2 - Latitude 2 (degrees)
 * @param {number} lon2 - Longitude 2 (degrees)
 * @returns {number} Distance in nautical miles
 */
function haversineDistanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) *
            Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_NM * c;
}

/**
 * Calculate initial bearing from point 1 to point 2
 * @param {number} lat1 - Latitude 1 (degrees)
 * @param {number} lon1 - Longitude 1 (degrees)
 * @param {number} lat2 - Latitude 2 (degrees)
 * @param {number} lon2 - Longitude 2 (degrees)
 * @returns {number} Bearing in degrees (0-360)
 */
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const lat1Rad = lat1 * DEG_TO_RAD;
  const lat2Rad = lat2 * DEG_TO_RAD;
  
  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
            Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
  
  const bearing = Math.atan2(y, x) * RAD_TO_DEG;
  return (bearing + 360) % 360;
}

// -----------------------------------------------------------------------------
// Data Loading
// -----------------------------------------------------------------------------

/**
 * Load OurAirports data into memory
 * @returns {boolean} Success
 */
function loadData(): boolean {
  if (isLoaded) return true;
  
  try {
    // Load airports
    const airportsContent = csvCache.getContent('airports.csv');
    if (!airportsContent) {
      loadError = `Airports file not found: ${AIRPORTS_FILE}`;
      Debug.log('airport-search', loadError);
      return false;
    }
    const airportLines = airportsContent.split('\n');
    
    if (airportLines.length === 0) {
      loadError = `Airports file is empty: ${AIRPORTS_FILE}`;
      Debug.log('airport-search', loadError);
      return false;
    }
    
    const airportHeaders = parseCsvLine(airportLines[0]);
    
    // Get column indices
    const aptIdx = {
      id: airportHeaders.indexOf('id'),
      ident: airportHeaders.indexOf('ident'),
      type: airportHeaders.indexOf('type'),
      name: airportHeaders.indexOf('name'),
      lat: airportHeaders.indexOf('latitude_deg'),
      lon: airportHeaders.indexOf('longitude_deg'),
      elevation: airportHeaders.indexOf('elevation_ft'),
      icao: airportHeaders.indexOf('icao_code'),
      isoCountry: airportHeaders.indexOf('iso_country'),
    };
    
    for (let i = 1; i < airportLines.length; i++) {
      const line = airportLines[i].trim();
      if (!line) continue;
      
      const fields = parseCsvLine(line);
      const ident = fields[aptIdx.ident];
      const type = fields[aptIdx.type];
      
      // Skip heliports and closed airports
      if (type === 'heliport' || type === 'closed') continue;
      
      const lat = parseFloat(fields[aptIdx.lat]);
      const lon = parseFloat(fields[aptIdx.lon]);
      
      if (isNaN(lat) || isNaN(lon)) continue;
      
      const airport: AirportRecord = {
        id: fields[aptIdx.id],
        ident: ident,
        icao: fields[aptIdx.icao] || ident,
        type: type,
        name: fields[aptIdx.name],
        lat: lat,
        lon: lon,
        elevation_ft: parseFloat(fields[aptIdx.elevation]) || 0,
        isoCountry: normalizeIsoCountry(aptIdx.isoCountry >= 0 ? fields[aptIdx.isoCountry] : ''),
        maxRunwayLengthFt: 0,  // Will be populated from runways
        runways: [],
      };
      
      airports.set(ident, airport);
      if (airport.icao !== ident) airportsByIcao.set(airport.icao, airport);
    }
    
    Debug.log('airport-search', `Loaded ${airports.size} airports`);
    
    // Load runways and associate with airports
    const runwaysContent = csvCache.getContent('runways.csv');
    if (!runwaysContent) {
      loadError = `Runways file not found: ${RUNWAYS_FILE}`;
      Debug.log('airport-search', loadError);
      return false;
    }
    const runwayLines = runwaysContent.split('\n');
    
    if (runwayLines.length === 0) {
      loadError = `Runways file is empty: ${RUNWAYS_FILE}`;
      Debug.log('airport-search', loadError);
      return false;
    }
    
    const runwayHeaders = parseCsvLine(runwayLines[0]);
    const rwyIdx = getRunwayCsvIndexes(runwayHeaders);
    
    let runwayCount = 0;
    for (let i = 1; i < runwayLines.length; i++) {
      const line = runwayLines[i].trim();
      if (!line) continue;
      
      const fields = parseCsvLine(line);
      const airportIdent = fields[rwyIdx.airport_ident];
      const airport = airports.get(airportIdent);
      if (!airport) continue;
      
      const closed = fields[rwyIdx.closed] === '1';
      if (closed) continue;
      
      const lengthFt = parseInt(fields[rwyIdx.length_ft], 10);
      if (isNaN(lengthFt) || lengthFt === 0) continue;
      
      const runway: AirportRunway = {
        le_ident: fields[rwyIdx.le_ident],
        he_ident: fields[rwyIdx.he_ident],
        length_ft: lengthFt,
        width_ft: parseInt(fields[rwyIdx.width_ft], 10) || 0,
        surface: fields[rwyIdx.surface],
      };
      
      airport.runways.push(runway);
      if (lengthFt > airport.maxRunwayLengthFt) {
        airport.maxRunwayLengthFt = lengthFt;
      }
      runwayCount++;
    }
    
    Debug.log('airport-search', `Loaded ${runwayCount} runways`);
    
    // Build spatial index (simple array sorted by lat for bounding box queries)
    airportsByCoord = Array.from(airports.values())
      .filter(a => a.maxRunwayLengthFt > 0)  // Only airports with runways
      .sort((a, b) => a.lat - b.lat);
    
    Debug.log('airport-search', `Indexed ${airportsByCoord.length} airports with runways`);
    
    isLoaded = true;
    // Release raw CSV cache — parsed data is held in `airports` Map
    csvCache.releaseAll();
    return true;
    
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    loadError = errorMessage;
    Debug.log('airport-search', 'Failed to load data', { error: errorMessage });
    return false;
  }
}

// -----------------------------------------------------------------------------
// Search Functions
// -----------------------------------------------------------------------------

/**
 * Find airports within radius that can accommodate aircraft
 * 
 * @param {number} lat - Current latitude
 * @param {number} lon - Current longitude
 * @param {Object} options - Search options
 * @param {number} [options.radiusNm=100] - Search radius in nautical miles
 * @param {number} [options.minRunwayLengthFt=5000] - Minimum runway length required
 * @param {number} [options.limit=5] - Maximum results to return
 * @param {string[]} [options.excludeTypes] - Airport types to exclude
 * @returns {Array<Object>} Array of suitable airports with distance and bearing
 */
function findSuitableAirports(lat: number, lon: number, options: SearchOptions = {}): SuitableAirportResult[] {
  const {
    radiusNm = 100,
    minRunwayLengthFt = 5000,
    limit = 5,
    excludeTypes = [],
  } = options;
  
  if (!loadData()) {
    return [];
  }
  
  // Quick bounding box filter (1 degree lat ≈ 60nm)
  const latRange = radiusNm / 60;
  const lonRange = radiusNm / (60 * Math.cos(lat * DEG_TO_RAD));
  
  const candidates = airportsByCoord.filter(apt => 
    apt.lat >= lat - latRange &&
    apt.lat <= lat + latRange &&
    apt.lon >= lon - lonRange &&
    apt.lon <= lon + lonRange &&
    apt.maxRunwayLengthFt >= minRunwayLengthFt &&
    !excludeTypes.includes(apt.type)
  );
  
  // Calculate distance and bearing for each candidate
  const results: SuitableAirportResult[] = candidates.map(apt => ({
    icao: apt.icao || apt.ident,
    ident: apt.ident,
    name: apt.name,
    type: apt.type,
    lat: apt.lat,
    lon: apt.lon,
    elevation_ft: apt.elevation_ft,
    maxRunwayLengthFt: apt.maxRunwayLengthFt,
    distanceNm: haversineDistanceNm(lat, lon, apt.lat, apt.lon),
    bearingDeg: bearingDeg(lat, lon, apt.lat, apt.lon),
  }));
  
  // Filter by actual distance (bounding box is approximate)
  const inRange = results.filter(apt => apt.distanceNm <= radiusNm);
  
  // Sort by distance and limit
  inRange.sort((a, b) => a.distanceNm - b.distanceNm);
  
  return inRange.slice(0, limit);
}

/**
 * Get a caller-supplied minimum runway length.
 *
 * ICAO approach category and wake-turbulence category do not encode landing
 * performance. Do not infer runway suitability from aircraftCategory: callers
 * must provide an explicit performance-derived value when they have one.
 * 
 * @param {Object} [aircraftOrProfile] - Aircraft profile object
 * @returns {number} Minimum runway length in feet
 */
function getMinRunwayForAircraft(
  aircraftOrProfile: { minRunwayLengthFt?: number | null; aircraftCategory?: string } | null | undefined,
): number {
  const requestedLength = Number(aircraftOrProfile?.minRunwayLengthFt);
  return Number.isFinite(requestedLength) && requestedLength >= 1000 && requestedLength <= 20000
    ? Math.round(requestedLength)
    : 6000;
}

/**
 * Check if data is loaded
 * @returns {boolean}
 */
function isDataLoaded(): boolean {
  return isLoaded;
}

/**
 * Get statistics about loaded data
 * @returns {Object}
 */
function getStats(): { loaded: boolean; airportCount: number; indexedCount: number; error: string | null } {
  if (!isLoaded) {
    loadData();
  }
  
  return {
    loaded: isLoaded,
    airportCount: airports.size,
    indexedCount: airportsByCoord.length,
    error: loadError,
  };
}

function normalizeIsoCountry(value: unknown): string | null {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/**
 * Exact ICAO / ident lookup with no name search, for callers that must not
 * accept a fuzzy match (for example attributing a country to a logged airport).
 */
function findAirportByIcao(icao: string | null | undefined): AirportRecord | null {
  if (!loadData()) return null;
  const code = String(icao || '').trim().toUpperCase();
  if (!code) return null;
  return airports.get(code) || airportsByIcao.get(code) || null;
}

/**
 * Estimate flight time using a caller-supplied cruise speed when available.
 * ICAO category is intentionally ignored because it is not a cruise-performance
 * classification.
 * 
 * @param {number} distanceNm - Distance in nautical miles
 * @param {Object} [aircraftOrProfile] - Aircraft profile object
 * @returns {Object} Time estimate
 */
function estimateFlightTime(
  distanceNm: number,
  aircraftOrProfile?: { cruiseSpeedKts?: number | null; aircraftCategory?: string } | null,
): { cruiseSpeedKts: number; flightTimeHours: number; hours: number; minutes: number; formatted: string } {
  const requestedSpeed = Number(aircraftOrProfile?.cruiseSpeedKts);
  const cruiseSpeedKts = Number.isFinite(requestedSpeed) && requestedSpeed >= 40 && requestedSpeed <= 700
    ? requestedSpeed
    : 450;
  
  const flightTimeHours = distanceNm / cruiseSpeedKts;
  const hours = Math.floor(flightTimeHours);
  const minutes = Math.round((flightTimeHours - hours) * 60);
  
  return {
    cruiseSpeedKts,
    flightTimeHours,
    hours,
    minutes,
    formatted: hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`,
  };
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
  // Data loading
  loadData,
  isDataLoaded,
  getStats,
  
  // Search
  findSuitableAirports,
  findAirportByIcao,
  
  // Helpers
  getMinRunwayForAircraft,
  estimateFlightTime,
  haversineDistanceNm,
  bearingDeg,
};

export {};
