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

type AirportDistanceResult = {
  icao: string;
  name: string;
  lat: number;
  lon: number;
  distanceNm: number;
  bearingDeg: number;
  maxRunwayLengthFt: number;
  elevation_ft: number;
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

const airports = new Map<string, AirportRecord>();     // ICAO -> airport data
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
        maxRunwayLengthFt: 0,  // Will be populated from runways
        runways: [],
      };
      
      airports.set(ident, airport);
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
 * Find the nearest suitable airport
 * 
 * @param {number} lat - Current latitude
 * @param {number} lon - Current longitude
 * @param {number} [minRunwayLengthFt=5000] - Minimum runway length required
 * @returns {Object|null} Nearest suitable airport or null
 */
function findNearestSuitable(lat: number, lon: number, minRunwayLengthFt = 5000): SuitableAirportResult | null {
  const results = findSuitableAirports(lat, lon, {
    radiusNm: 200,  // Search wider for "nearest"
    minRunwayLengthFt,
    limit: 1,
  });
  
  return results[0] || null;
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
 * Get load error if any
 * @returns {string|null}
 */
function getLoadError(): string | null {
  return loadError;
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

/**
 * Find airport by ICAO/IATA code or name
 * 
 * @param {string} query - ICAO code, IATA code, or partial name
 * @returns {Object|null} Airport or null
 */
function findAirportByQuery(query: string | null | undefined): AirportRecord | null {
  if (!loadData()) return null;
  if (!query || query.length < 2) return null;
  
  const upperQuery = query.toUpperCase().trim();
  const lowerQuery = query.toLowerCase().trim();
  
  // Try exact ICAO match first
  const exactMatch = airports.get(upperQuery);
  if (exactMatch) return exactMatch;
  
  // Try searching all airports
  for (const apt of airports.values()) {
    // ICAO match
    if (apt.icao && apt.icao.toUpperCase() === upperQuery) return apt;
    if (apt.ident && apt.ident.toUpperCase() === upperQuery) return apt;
  }
  
  // Try name search (partial match)
  const nameMatches: AirportRecord[] = [];
  for (const apt of airports.values()) {
    if (apt.name && apt.name.toLowerCase().includes(lowerQuery)) {
      nameMatches.push(apt);
    }
  }
  
  // Return best name match (prefer large airports, then by name length)
  if (nameMatches.length > 0) {
    nameMatches.sort((a, b) => {
      // Prefer large airports
      const typeOrder: Record<string, number> = { large_airport: 0, medium_airport: 1, small_airport: 2 };
      const aType = typeOrder[a.type] ?? 3;
      const bType = typeOrder[b.type] ?? 3;
      if (aType !== bType) return aType - bType;
      // Then by runway length
      return (b.maxRunwayLengthFt || 0) - (a.maxRunwayLengthFt || 0);
    });
    return nameMatches[0];
  }
  
  return null;
}

/**
 * Calculate distance and bearing from current position to a destination airport
 * 
 * @param {number} lat - Current latitude
 * @param {number} lon - Current longitude
 * @param {string} destination - ICAO code or airport name
 * @returns {Object|null} Distance/bearing info or null
 */
function getDistanceToAirport(
  lat: number,
  lon: number,
  destination: string,
): AirportDistanceResult | null {
  const apt = findAirportByQuery(destination);
  if (!apt) return null;
  
  const distanceNm = haversineDistanceNm(lat, lon, apt.lat, apt.lon);
  const bearing = bearingDeg(lat, lon, apt.lat, apt.lon);
  
  return {
    icao: apt.icao || apt.ident,
    name: apt.name,
    lat: apt.lat,
    lon: apt.lon,
    distanceNm: distanceNm,
    bearingDeg: bearing,
    maxRunwayLengthFt: apt.maxRunwayLengthFt,
    elevation_ft: apt.elevation_ft,
  };
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
  getLoadError,
  getStats,
  
  // Search
  findSuitableAirports,
  findNearestSuitable,
  findAirportByQuery,
  getDistanceToAirport,
  
  // Helpers
  getMinRunwayForAircraft,
  estimateFlightTime,
  haversineDistanceNm,
  bearingDeg,
};

export {};
