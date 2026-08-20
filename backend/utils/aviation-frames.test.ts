'use strict';

const { createHarness } = require('../../tests/support/mini-test-harness') as {
  createHarness: () => {
    test: (name: string, fn: () => void) => void;
    assertEqual: (actual: unknown, expected: unknown, message?: string) => void;
    summary: (label: string) => void;
  };
};

const {
  deriveTrueBearingFromCoordinates,
  deriveMagneticHeadingFromTrue,
  deriveTrueHeadingFromMagnetic,
  getAircraftTrueHeadingDeg,
  getRunwayTrueHeadingDeg,
  headingDifferenceDegrees,
  normalizeHeadingDegrees,
} = require('./aviation-frames') as {
  deriveTrueBearingFromCoordinates: (
    fromLatDeg: unknown,
    fromLonDeg: unknown,
    toLatDeg: unknown,
    toLonDeg: unknown,
  ) => number | null;
  deriveMagneticHeadingFromTrue: (trueHeadingDeg: unknown, magvarDeg: unknown) => number | null;
  deriveTrueHeadingFromMagnetic: (magneticHeadingDeg: unknown, magvarDeg: unknown) => number | null;
  getAircraftTrueHeadingDeg: (input: Record<string, unknown> | null | undefined) => number | null;
  getRunwayTrueHeadingDeg: (input: Record<string, unknown> | null | undefined) => number | null;
  headingDifferenceDegrees: (leftHeadingDeg: unknown, rightHeadingDeg: unknown) => number | null;
  normalizeHeadingDegrees: (value: unknown) => number | null;
};

const { test, assertEqual, summary } = createHarness();

test('normalizes headings without treating missing values as north', () => {
  assertEqual(normalizeHeadingDegrees(null), null, 'null heading must stay unknown');
  assertEqual(normalizeHeadingDegrees(''), null, 'blank heading must stay unknown');
  assertEqual(normalizeHeadingDegrees(360), 0, '360 should normalize to north for comparison math');
  assertEqual(normalizeHeadingDegrees(-10), 350, 'negative headings should wrap');
});

test('converts between magnetic and true headings using project magvar convention', () => {
  assertEqual(deriveTrueHeadingFromMagnetic(267, 14), 253, 'true = magnetic - west-positive magvar');
  assertEqual(deriveMagneticHeadingFromTrue(253, 14), 267, 'magnetic = true + west-positive magvar');
  assertEqual(deriveTrueHeadingFromMagnetic(10, 20), 350, 'true heading conversion should wrap around north');
});

test('derives true bearings only from valid unambiguous coordinates', () => {
  assertEqual(deriveTrueBearingFromCoordinates(0, 0, 1, 0), 0, 'northbound geometry should be true north');
  assertEqual(deriveTrueBearingFromCoordinates(0, 0, 0, 1), 90, 'eastbound geometry should be true east');
  assertEqual(deriveTrueBearingFromCoordinates(0, 0, 0, 0), null, 'coincident thresholds must stay unknown');
  assertEqual(deriveTrueBearingFromCoordinates(91, 0, 0, 0), null, 'invalid latitude must stay unknown');
});

test('computes signed heading deltas across north', () => {
  assertEqual(headingDifferenceDegrees(10, 350), 20, '10 right of 350 should be +20');
  assertEqual(headingDifferenceDegrees(350, 10), -20, '350 left of 10 should be -20');
});

test('resolves aircraft and runway true-heading frames explicitly', () => {
  assertEqual(
    getAircraftTrueHeadingDeg({ hdg_true_deg: 350, hdg_mag_deg: 10, magvar_deg: 20 }),
    350,
    'explicit aircraft true heading should win',
  );
  assertEqual(
    getAircraftTrueHeadingDeg({ hdg_mag_deg: 10, magvar_deg: 20 }),
    350,
    'aircraft true heading should be derived from magnetic minus west-positive magvar',
  );
  assertEqual(
    getAircraftTrueHeadingDeg({ true_heading_deg: 281 }),
    281,
    'explicit legacy true-heading field should be accepted',
  );
  assertEqual(
    getAircraftTrueHeadingDeg({ heading_deg: 281 }),
    null,
    'ambiguous heading field should not be treated as true heading',
  );
  assertEqual(
    getRunwayTrueHeadingDeg({ heading_true_deg: 360, heading: 359 }),
    0,
    'explicit runway true heading should win over legacy alias',
  );
});

summary('aviation-frames tests');

export {};
