/**
 * Shared OurAirports CSV content cache.
 *
 * Both runway-database.js and airport-search.js load the same airports.csv and
 * runways.csv files independently, doubling memory during parsing. This module
 * reads each file once and caches the raw UTF-8 string so downstream consumers
 * avoid redundant disk I/O and transient string allocations.
 */

'use strict';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');

const PRIMARY_DATA_DIR = path.join(__dirname, '..', 'data-sync', 'data', 'ourairports');

function resolveOurAirportsFile(fileName: string): string {
  return path.join(PRIMARY_DATA_DIR, fileName);
}

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

function getRunwayCsvIndexes(headers: string[]): RunwayCsvIndexes {
  return {
    airport_ident: headers.indexOf('airport_ident'),
    le_ident: headers.indexOf('le_ident'),
    he_ident: headers.indexOf('he_ident'),
    le_lat: headers.indexOf('le_latitude_deg'),
    le_lon: headers.indexOf('le_longitude_deg'),
    he_lat: headers.indexOf('he_latitude_deg'),
    he_lon: headers.indexOf('he_longitude_deg'),
    length_ft: headers.indexOf('length_ft'),
    width_ft: headers.indexOf('width_ft'),
    surface: headers.indexOf('surface'),
    closed: headers.indexOf('closed'),
    le_heading_degT: headers.indexOf('le_heading_degT'),
    he_heading_degT: headers.indexOf('he_heading_degT'),
    le_displaced_threshold_ft: headers.indexOf('le_displaced_threshold_ft'),
    he_displaced_threshold_ft: headers.indexOf('he_displaced_threshold_ft'),
  };
}

const cache: Record<string, string | null> = Object.create(null);

/**
 * Return the raw UTF-8 content of an OurAirports CSV file, reading from disk
 * only on the first call.
 */
function getContent(fileName: string): string | null {
  if (fileName in cache) return cache[fileName];

  const filePath = resolveOurAirportsFile(fileName);
  if (!fs.existsSync(filePath)) {
    cache[fileName] = null;
    return null;
  }

  cache[fileName] = fs.readFileSync(filePath, 'utf8');
  return cache[fileName];
}

/**
 * Release cached raw CSV strings to free memory after all consumers have
 * finished parsing. Safe to call multiple times.
 */
function releaseAll(): void {
  for (const key of Object.keys(cache)) {
    delete cache[key];
  }
}

module.exports = { getContent, releaseAll, resolveOurAirportsFile, getRunwayCsvIndexes };

export {};
