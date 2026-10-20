/**
 * Shared OurAirports CSV content cache.
 *
 * Both runway-database.js and airport-search.js load the same airports.csv and
 * runways.csv files independently, doubling memory during parsing. This module
 * reads each file once and caches the raw UTF-8 string so downstream consumers
 * avoid redundant disk I/O and transient string allocations.
 */
export {};
