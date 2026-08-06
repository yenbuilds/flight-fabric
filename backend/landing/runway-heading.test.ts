'use strict';

const { createHarness } = require('../../tests/support/mini-test-harness') as {
  createHarness: () => {
    test: (name: string, fn: () => void) => void;
    assertEqual: (actual: unknown, expected: unknown, message?: string) => void;
    summary: (label: string) => void;
  };
};
const { parseRunwayHeadingFromId } = require('./runway-heading') as {
  parseRunwayHeadingFromId: (value: unknown) => number;
};

const { test, assertEqual, summary } = createHarness();

test('parses standard runway IDs', () => {
  assertEqual(parseRunwayHeadingFromId('09'), 90, '09 should parse to 90');
  assertEqual(parseRunwayHeadingFromId('27'), 270, '27 should parse to 270');
  assertEqual(parseRunwayHeadingFromId('35L'), 350, '35L should parse to 350');
});

test('handles edge values and normalization', () => {
  assertEqual(parseRunwayHeadingFromId('36'), 360, '36 should parse to 360 without colliding with invalid IDs');
  assertEqual(parseRunwayHeadingFromId('36L'), 360, '36L should parse to 360 without colliding with invalid IDs');
  assertEqual(parseRunwayHeadingFromId('00'), 0, '00 should parse to 0');
  assertEqual(parseRunwayHeadingFromId('01R'), 10, '01R should parse to 10');
});

test('returns zero for invalid values', () => {
  assertEqual(parseRunwayHeadingFromId(''), 0, 'Empty string should parse to 0');
  assertEqual(parseRunwayHeadingFromId('XX'), 0, 'Invalid ID should parse to 0');
  assertEqual(parseRunwayHeadingFromId(null), 0, 'Null should parse to 0');
});

summary('runway-heading tests');

export {};
