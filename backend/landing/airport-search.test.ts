'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getMinRunwayForAircraft, estimateFlightTime } = require('./airport-search');

test('airport suitability does not infer runway performance from ICAO category', () => {
  assert.equal(getMinRunwayForAircraft({ aircraftCategory: 'A' }), 6000);
  assert.equal(getMinRunwayForAircraft({ aircraftCategory: 'D' }), 6000);
  assert.equal(getMinRunwayForAircraft({ minRunwayLengthFt: 5275, aircraftCategory: 'D' }), 5275);
});

test('flight-time estimate does not infer cruise speed from ICAO category', () => {
  assert.equal(estimateFlightTime(900, { aircraftCategory: 'A' }).cruiseSpeedKts, 450);
  assert.equal(estimateFlightTime(900, { aircraftCategory: 'D' }).cruiseSpeedKts, 450);
  assert.equal(estimateFlightTime(900, { cruiseSpeedKts: 300 }).cruiseSpeedKts, 300);
});
