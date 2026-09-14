'use strict';

const { createHarness } = require('../../tests/support/mini-test-harness') as {
  createHarness: () => {
    test: (name: string, fn: () => void) => void;
    assertEqual: (actual: unknown, expected: unknown, message?: string) => void;
    assertTrue: (value: unknown, message?: string) => void;
    summary: (label: string) => void;
  };
};

const csvCache = require('./ourairports-csv-cache') as {
  getContent: (fileName: string) => string | null;
  releaseAll: () => void;
};

const { test, assertEqual, assertTrue, summary } = createHarness();

const csvReads: string[] = [];
csvCache.getContent = (fileName: string): string | null => {
  csvReads.push(fileName);
  if (fileName === 'airports.csv') {
    return [
      'ident,name,elevation_ft',
      'BGUD,Corrected East Runway,100',
      'BBAD,Uncorrected North Decoy,100',
      'BFLT,First Runway Latitude Gate,100',
      'BDIS,Displaced Threshold Field,100',
      'BPAR,Staggered Parallel Field,100',
      'BDRV,Coordinate Derived Heading,100',
      'BSKP,Missing True Geometry,100',
      'BSOU,Southern Latitude Boundary,100',
      'BTIA,First Identical Runway,100',
      'BTIB,Second Identical Runway,100',
      'BEXT,Whole Airport Latitude Gate,100',
      'BBND,Inclusive Latitude Boundary,100',
    ].join('\n');
  }

  if (fileName === 'runways.csv') {
    return [
      'airport_ident,le_ident,he_ident,le_latitude_deg,le_longitude_deg,he_latitude_deg,he_longitude_deg,length_ft,width_ft,surface,closed,le_heading_degT,he_heading_degT,le_displaced_threshold_ft,he_displaced_threshold_ft',
      'BGUD,09,,70,0.05,,,8000,150,ASP,0,90,,,',
      'BBAD,36,,70.03,0,,,8000,150,ASP,0,360,,,',
      'BFLT,01,,10.2,30,,,8000,150,ASP,0,10,,,',
      'BFLT,09,,10,30.005,,,8000,150,ASP,0,90,,,',
      'BDIS,17,35,0.1,0,0,0,10000,150,ASP,0,180,360,0,2000',
      'BPAR,36L,,20,40,,,8000,150,ASP,0,360,,,',
      'BPAR,36R,,19.99,40.003,,,8000,150,ASP,0,360,,,',
      'BDRV,05,23,0,0,0.01,0.01,8000,150,ASP,0,,,,',
      'BSKP,09,,5,5,,,8000,150,ASP,0,,,,',
      'BSOU,36,,-31.001,150,,,8000,150,ASP,0,0,,,',
      'BTIA,09,,41,70,,,8000,150,ASP,0,0,,,',
      'BTIA,36,,41,70,,,8000,150,ASP,0,0,,,',
      'BTIB,01,,40.99,80,,,8000,150,ASP,0,10,,,',
      'BTIB,36,,41,70,,,8000,150,ASP,0,0,,,',
      'BEXT,36,,-20.002,80,,,8000,150,ASP,0,0,,,',
      'BEXT,09,,-20,81,,,8000,150,ASP,0,90,,,',
      'BBND,36,,60,10,,,60000,150,ASP,0,0,,,',
    ].join('\n');
  }

  return null;
};
csvCache.releaseAll = (): void => {};

const { findRunwayByPosition, findNearbyAirport, getRunway } = require('./runway-database') as {
  findNearbyAirport: (_lat: number, _lon: number, _radiusNm?: number) => { icao: string } | null;
  getRunway: (
    icao: string,
    runway: string,
  ) => {
    lengthFt: number;
    physicalLengthFt: number;
    displacedThresholdFt: number;
    heading: number;
    heading_true_deg: number;
    threshold: { lat: number; lon: number };
    physicalThreshold: { lat: number; lon: number };
  } | null;
  findRunwayByPosition: (
    lat: number,
    lon: number,
    maxDistanceNm?: number,
    aircraftTrueHeadingDeg?: number | null,
  ) => { icao: string; runway: string; distanceFromThreshold: number; heading: number; heading_true_deg: number } | null;
};

test('fallback runway distance scales longitude at high latitudes', () => {
  const match = findRunwayByPosition(70, 0, 2);

  assertEqual(match?.icao, 'BGUD', 'Corrected high-latitude fallback should pick the closer east/west runway');
  assertTrue(
    match != null && match.distanceFromThreshold > 1 && match.distanceFromThreshold < 1.1,
    `Expected corrected distance near 1.03 NM, got ${match?.distanceFromThreshold}`,
  );
});

test('airport latitude prefilter considers all runway endpoints', () => {
  const match = findRunwayByPosition(10, 30, 2);

  assertEqual(match?.icao, 'BFLT', 'Airport should not be skipped when a later runway is within the latitude gate');
  assertEqual(match?.runway, '09', 'Fallback should select the closer later runway after the airport passes the gate');
});

test('runway records expose true heading with legacy heading alias', () => {
  const match = findRunwayByPosition(70.03, 0, 2, 360);

  assertEqual(match?.icao, 'BBAD', 'Expected true-heading-filtered runway match');
  assertEqual(match?.heading_true_deg, 360, 'Expected explicit true-heading field from CSV heading_degT');
  assertEqual(match?.heading, 360, 'Expected legacy heading alias to preserve compatibility');
});

test('missing degT headings are derived from threshold coordinates, not runway designators', () => {
  const lowEnd = getRunway('BDRV', '05');
  const highEnd = getRunway('BDRV', '23');

  assertTrue(
    lowEnd != null && Math.abs(lowEnd.heading_true_deg - 45) < 0.01,
    `Expected coordinate-derived true heading near 45 degrees, got ${lowEnd?.heading_true_deg}`,
  );
  assertTrue(
    highEnd != null && Math.abs(highEnd.heading_true_deg - 225) < 0.01,
    `Expected reciprocal coordinate-derived true heading near 225 degrees, got ${highEnd?.heading_true_deg}`,
  );
  assertEqual(lowEnd?.heading, lowEnd?.heading_true_deg, 'legacy alias should retain the derived true bearing');
});

test('missing degT heading without reciprocal threshold geometry fails closed', () => {
  assertEqual(
    getRunway('BSKP', '09'),
    null,
    'A magnetic runway designator must not be exposed as true runway geometry',
  );
});

test('primary runway matching rejects a far parallel runway', () => {
  const match = findRunwayByPosition(70.03, 20, 2, 360);

  assertEqual(match, null, 'A runway outside the cross-track search radius must not match');
});

test('runway matching does not use the threshold radius as a lateral radius', () => {
  const match = findRunwayByPosition(70.03, 0.05, 2, 360);

  assertEqual(match, null, 'A parallel centerline about one nautical mile away must not match');
});

test('runway records use displaced threshold as touchdown scoring origin', () => {
  const runway = getRunway('BDIS', '35');

  assertEqual(runway?.displacedThresholdFt, 2000, 'Expected displaced threshold from CSV');
  assertEqual(runway?.lengthFt, 8000, 'Expected lengthFt to represent landing distance available');
  assertEqual(runway?.physicalLengthFt, 10000, 'Expected physical runway length to remain available');
  assertTrue(
    runway != null && runway.threshold.lat > runway.physicalThreshold.lat,
    'Expected northbound threshold to be shifted from the physical runway end',
  );

  const touchdownInDisplacedAreaLat = 1000 / 364567;
  const match = findRunwayByPosition(touchdownInDisplacedAreaLat, 0, 2, 360);
  assertEqual(match?.icao, 'BDIS', 'Expected touchdown inside displaced area to still match runway');
  assertEqual(match?.runway, '35', 'Expected runway 35 match');
  assertTrue(
    match != null && match.distanceFromThreshold < 0,
    'Expected position before displaced threshold to be negative along-track',
  );
});

test('staggered parallel runway matching keeps a short touchdown on the nearest centerline', () => {
  const touchdownLat = 20 - (100 / 364567);
  const match = findRunwayByPosition(touchdownLat, 40, 2, 360);

  assertEqual(match?.icao, 'BPAR', 'Expected staggered parallel airport match');
  assertEqual(match?.runway, '36L', 'Expected the touchdown centerline rather than the offset parallel runway');
  assertTrue(
    match != null && match.distanceFromThreshold < 0,
    'Expected the intended runway to retain its signed pre-threshold distance',
  );
});

test('latitude lookup finds airports across a southern integer latitude boundary', () => {
  assertEqual(findNearbyAirport(-30.999, 150, 12)?.icao, 'BSOU');
});

test('latitude lookup preserves airport and runway enumeration order for exact ties', () => {
  const match = findRunwayByPosition(41, 70, 2, 0);
  assertEqual(match?.icao, 'BTIA', 'A lower-latitude endpoint must not reorder tied airports');
  assertEqual(match?.runway, '36', 'Numeric runway keys must retain their original enumeration order');
});

test('latitude lookup retains every runway at an airport admitted by another endpoint', () => {
  const match = findRunwayByPosition(-20, 80, 0.01, 0);
  assertEqual(match?.icao, 'BEXT');
  assertEqual(match?.runway, '36', 'The latitude gate applies to the airport, not each candidate runway');
});

test('latitude lookup preserves inclusive gate boundaries', () => {
  assertEqual(findRunwayByPosition(60.125, 10, 3.75, 0)?.icao, 'BBND');
  assertEqual(findRunwayByPosition(60.125 + 1e-10, 10, 3.75, 0), null);
  assertEqual(findRunwayByPosition(60, 10, 0, 0)?.icao, 'BBND');
});

test('latitude lookup handles empty regions and unusual radii', () => {
  assertEqual(findNearbyAirport(-80, -140, 12), null);
  assertEqual(findNearbyAirport(-31, 150, -1), null);
  assertEqual(findNearbyAirport(-31, 150, NaN), null);
  assertEqual(findNearbyAirport(NaN, 150, 12), null);
  assertEqual(findNearbyAirport(-31, 150, Infinity)?.icao, 'BSOU');
});

test('repeated nearby lookups reuse CSV data and do not revisit distant runway coordinates', () => {
  const threshold = getRunway('BGUD', '09')!.threshold;
  const descriptor = Object.getOwnPropertyDescriptor(threshold, 'lat')!;
  let distantReads = 0;
  Object.defineProperty(threshold, 'lat', {
    configurable: true,
    get: () => { distantReads += 1; return descriptor.value; },
  });
  try {
    for (let i = 0; i < 5; i += 1) {
      assertEqual(findNearbyAirport(-31, 150, 12)?.icao, 'BSOU');
    }
    assertEqual(distantReads, 0, 'Warm nearby lookups must skip distant airport data');
    assertEqual(csvReads.join(','), 'airports.csv,runways.csv', 'CSV files should be loaded only once');
  } finally {
    Object.defineProperty(threshold, 'lat', descriptor);
  }
});

summary('runway-database tests');

export {};
