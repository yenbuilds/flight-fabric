'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AIRPORT_DATA_RETRY_MS,
  airportIsoCountry,
  createAirportCountryLookup,
  withFlightCountries,
  withFlightCountriesList,
  withLandingCountry,
  withLandingCountryList,
} = require('./airport-country') as typeof import('./airport-country');
const { findAirportByIcao } = require('./airport-search') as {
  findAirportByIcao: (icao: string | null | undefined) => { isoCountry: string | null } | null;
};

const lookup = (icao: string | null | undefined) => ({ YSSY: 'AU', KJFK: 'US', EGLL: 'GB' } as Record<string, string>)[String(icao || '').toUpperCase()] || null;

test('bundled OurAirports data attributes countries by exact ICAO only', () => {
  assert.equal(findAirportByIcao('YSSY')?.isoCountry, 'AU');
  assert.equal(findAirportByIcao('kjfk')?.isoCountry, 'US');
  assert.equal(airportIsoCountry('EGLL'), 'GB');
  // A name fragment must not resolve: the fuzzy query path is not used here.
  assert.equal(findAirportByIcao('Sydney'), null);
  assert.equal(airportIsoCountry('Sydney'), null);
  assert.equal(airportIsoCountry(''), null);
  assert.equal(airportIsoCountry(null), null);
  assert.equal(airportIsoCountry(42 as unknown as string), null);
});

test('a failed airport-data load is not retried for every airport in a list', () => {
  let clock = 1_000_000;
  let loadCalls = 0;
  let loadResult = false;
  let loaded = false;
  const search = {
    isDataLoaded: () => loaded,
    loadData: () => { loadCalls += 1; loaded = loadResult; return loaded; },
    findAirportByIcao: (icao: string | null | undefined) => (icao === 'YSSY' ? { isoCountry: 'AU' } : null),
  };
  const lookup = createAirportCountryLookup(search, () => clock);

  assert.equal(lookup('YSSY'), null);
  assert.equal(lookup('KJFK'), null);
  assert.equal(lookup('YSSY'), null);
  assert.equal(loadCalls, 1, 'one parse attempt covers the whole list response');

  clock += AIRPORT_DATA_RETRY_MS;
  loadResult = true;
  assert.equal(lookup('YSSY'), 'AU', 'a later response retries the load and attributes normally');
  assert.equal(loadCalls, 2);
  assert.equal(lookup('YSSY'), 'AU');
  assert.equal(loadCalls, 2, 'loaded data is not reloaded');

  const throwing = createAirportCountryLookup({
    isDataLoaded: () => true,
    loadData: () => true,
    findAirportByIcao: () => { throw new Error('boom'); },
  }, () => clock);
  assert.equal(throwing('YSSY'), null, 'a lookup exception never breaks the list response');
});

test('timeline flights gain departure and arrival countries from indexed ICAOs or airport summaries', () => {
  assert.deepEqual(
    withFlightCountries({ flightId: 'F1', departureIcao: 'YSSY', arrivalIcao: 'KJFK' }, lookup),
    { flightId: 'F1', departureIcao: 'YSSY', arrivalIcao: 'KJFK', departureCountry: 'AU', arrivalCountry: 'US' },
  );
  const scanned = withFlightCountries({
    departureAirport: { icao: 'EGLL', name: 'Heathrow' },
    arrivalNearbyAirport: { icao: 'YSSY', name: 'Sydney' },
  }, lookup);
  assert.equal(scanned.departureCountry, 'GB');
  assert.equal(scanned.arrivalCountry, 'AU');
  // Unknown ends stay explicit nulls so the client shape is stable.
  assert.deepEqual(withFlightCountries({ route: 'Location Unknown' }, lookup), {
    route: 'Location Unknown', departureCountry: null, arrivalCountry: null,
  });
  assert.deepEqual(withFlightCountries({ departureIcao: 'ZZZZ' }, lookup).departureCountry, null);
});

test('logbook entries gain a country from their landing ICAO', () => {
  assert.deepEqual(withLandingCountry({ id: 'L1', icao: 'YSSY', runway: '34L' }, lookup), {
    id: 'L1', icao: 'YSSY', runway: '34L', country: 'AU',
  });
  assert.equal(withLandingCountry({ id: 'L2', icao: null }, lookup).country, null);
});

test('list helpers leave non-array or non-object input alone', () => {
  assert.equal(withFlightCountriesList(null, lookup), null);
  assert.equal(withLandingCountryList(undefined, lookup), undefined);
  assert.deepEqual(withFlightCountriesList([null, { departureIcao: 'YSSY' }], lookup), [
    null, { departureIcao: 'YSSY', departureCountry: 'AU', arrivalCountry: null },
  ]);
  assert.deepEqual(withLandingCountryList([{ icao: 'KJFK' }, 'x'], lookup), [{ icao: 'KJFK', country: 'US' }, 'x']);
});
