'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getMinRunwayForAircraft, estimateFlightTime, findSuitableAirports } = require('../../landing/airport-search');

// Real coordinates at Sydney's airport reference point, using the bundled
// OurAirports data also exercised by airport-country.test.ts. Bankstown is
// approximately 9.4 NM west and has a longest runway below 5,000 ft.
const SYDNEY_LAT = -33.9461;
const SYDNEY_LON = 151.177;

function loadFreshAirportSearch(t: import('node:test').TestContext) {
  const modulePaths = ['../../landing/airport-search', '../../landing/ourairports-data'].map((name) => require.resolve(name));
  const previousModules = modulePaths.map((modulePath) => require.cache[modulePath]);
  for (const modulePath of modulePaths) delete require.cache[modulePath];
  t.after(() => {
    for (const [index, modulePath] of modulePaths.entries()) {
      delete require.cache[modulePath];
      if (previousModules[index]) require.cache[modulePath] = previousModules[index];
    }
  });
  return { search: require('../../landing/airport-search'), csvCache: require('../../landing/ourairports-data') };
}

test('airport statistics load bundled data and retain the loaded state', (t) => {
  const { search, csvCache } = loadFreshAirportSearch(t);
  assert.equal(search.isDataLoaded(), false);
  const stats = search.getStats();
  assert.equal(stats.loaded, true);
  assert.equal(search.isDataLoaded(), true);
  assert.ok(stats.airportCount > 0);
  assert.ok(stats.indexedCount > 0 && stats.indexedCount <= stats.airportCount);
  assert.equal(stats.error, null);

  const reads = t.mock.method(csvCache, 'getContent', () => {
    throw new Error('Already-loaded airport data should not need another CSV read');
  });
  assert.equal(search.loadData(), true);
  assert.deepEqual(search.getStats(), stats);
  assert.equal(reads.mock.callCount(), 0);
});

test('missing airport CSV data remains visible in statistics and yields no search matches', (t) => {
  const { search, csvCache } = loadFreshAirportSearch(t);
  t.mock.method(csvCache, 'getContent', () => null);
  const stats = search.getStats();
  assert.equal(stats.loaded, false);
  assert.equal(stats.airportCount, 0);
  assert.equal(stats.indexedCount, 0);
  assert.match(stats.error, /^Airports file not found: .*airports\.csv$/);
  assert.equal(search.loadData(), false);
  assert.equal(search.isDataLoaded(), false);
  assert.deepEqual(search.findSuitableAirports(SYDNEY_LAT, SYDNEY_LON), []);
});

test('an injected CSV read failure is reported through statistics without escaping to callers', (t) => {
  const { search, csvCache } = loadFreshAirportSearch(t);
  t.mock.method(csvCache, 'getContent', () => { throw new Error('Injected airport CSV read failure'); });
  assert.deepEqual(search.getStats(), {
    loaded: false, airportCount: 0, indexedCount: 0, error: 'Injected airport CSV read failure',
  });
  assert.equal(search.loadData(), false);
  assert.equal(search.isDataLoaded(), false);
  assert.deepEqual(search.findSuitableAirports(SYDNEY_LAT, SYDNEY_LON), []);
});

test('airport search applies its radius around Sydney', () => {
  const close = findSuitableAirports(SYDNEY_LAT, SYDNEY_LON, {
    radiusNm: 5, minRunwayLengthFt: 3000, limit: 5,
  });
  assert.deepEqual(close.map((airport: { icao: string }) => airport.icao), ['YSSY']);
  assert.ok(close[0].distanceNm < 0.01);

  const nearby = findSuitableAirports(SYDNEY_LAT, SYDNEY_LON, {
    radiusNm: 10, minRunwayLengthFt: 3000, limit: 5,
  });
  assert.deepEqual(nearby.map((airport: { icao: string }) => airport.icao), ['YSSY', 'YSBK']);
  assert.ok(nearby[1].distanceNm > 9 && nearby[1].distanceNm < 10);
  assert.ok(nearby[1].bearingDeg > 275 && nearby[1].bearingDeg < 282);
});

test('airport search applies the caller runway-length requirement', () => {
  const airports = findSuitableAirports(SYDNEY_LAT, SYDNEY_LON, {
    radiusNm: 10, minRunwayLengthFt: 5000, limit: 5,
  });
  assert.deepEqual(airports.map((airport: { icao: string }) => airport.icao), ['YSSY']);
  assert.ok(airports[0].maxRunwayLengthFt >= 5000);
});

test('airport search excludes requested types and returns no match when all are excluded', () => {
  const options = { radiusNm: 10, minRunwayLengthFt: 3000, limit: 5, excludeTypes: ['large_airport'] };
  const airports = findSuitableAirports(SYDNEY_LAT, SYDNEY_LON, options);
  assert.deepEqual(airports.map((airport: { icao: string }) => airport.icao), ['YSBK']);
  assert.equal(airports[0].type, 'medium_airport');
  assert.deepEqual(findSuitableAirports(SYDNEY_LAT, SYDNEY_LON, { ...options, radiusNm: 5 }), []);
});

test('airport search sorts by distance before applying the requested limit', () => {
  const options = { radiusNm: 40, minRunwayLengthFt: 2000, limit: 20 };
  const airports = findSuitableAirports(SYDNEY_LAT, SYDNEY_LON, options);
  assert.ok(airports.length > 2, 'the regional search has more candidates than the smaller limit');
  for (let index = 1; index < airports.length; index += 1) {
    assert.ok(airports[index - 1].distanceNm <= airports[index].distanceNm);
  }
  const limited = findSuitableAirports(SYDNEY_LAT, SYDNEY_LON, { ...options, limit: 2 });
  assert.deepEqual(limited, airports.slice(0, 2));
  assert.deepEqual(limited.map((airport: { icao: string }) => airport.icao), ['YSSY', 'YSBK']);
});

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
