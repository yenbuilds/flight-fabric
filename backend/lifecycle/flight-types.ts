/**
 * Canonical flight classification labels.
 *
 * Keep the runtime values and TypeScript aliases together so classifier logic,
 * tests, logbook summaries, and future consumers do not copy the same enum-like
 * shape into separate files.
 */
'use strict';

const FLIGHT_TYPE = Object.freeze({
  PATTERN_WORK: 'PATTERN_WORK',
  CROSS_COUNTRY: 'CROSS_COUNTRY',
  LOCAL_FLIGHT: 'LOCAL_FLIGHT',
  UNKNOWN: 'UNKNOWN',
} as const);

export type FlightTypeMap = typeof FLIGHT_TYPE;
export type FlightTypeValue = FlightTypeMap[keyof FlightTypeMap];

module.exports = {
  FLIGHT_TYPE,
};
