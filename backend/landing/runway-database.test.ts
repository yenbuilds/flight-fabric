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

csvCache.getContent = (fileName: string): string | null => {
  if (fileName === 'airports.csv') {
    return [
      'ident,name,elevation_ft',
      'BGUD,Corrected East Runway,100',
      'BBAD,Uncorrected North Decoy,100',
      'BFLT,First Runway Latitude Gate,100',
      'BDIS,Displaced Threshold Field,100',
      'BPAR,Staggered Parallel Field,100',
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
    ].join('\n');
  }

  return null;
};
csvCache.releaseAll = (): void => {};

const { findRunwayByPosition, getRunway } = require('./runway-database') as {
  getRunway: (
    icao: string,
    runway: string,
  ) => {
    lengthFt: number;
    physicalLengthFt: number;
    displacedThresholdFt: number;
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

summary('runway-database tests');

export {};
