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
const { resolveOurAirportsFile } = require('./ourairports-paths') as {
  resolveOurAirportsFile: (fileName: string) => string;
};

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

module.exports = { getContent, releaseAll };

export {};
