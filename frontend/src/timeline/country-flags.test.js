import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  COUNTRY_FLAG_CODES,
  countryDisplayName,
  countryFlagSrc,
  flightRouteSegments,
  normalizeCountryCode,
} from './country-flags.js';

const flagsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'flags');

test('the flag code manifest matches the vendored SVG directory exactly', () => {
  const onDisk = fs.readdirSync(flagsDir).filter(name => name.endsWith('.svg')).map(name => name.slice(0, -4)).sort();
  assert.deepEqual([...COUNTRY_FLAG_CODES].sort(), onDisk);
  assert.ok(onDisk.every(code => /^[A-Z]{2}$/.test(code)), 'only ISO 3166-1 alpha-2 flags are vendored');
  assert.ok(fs.existsSync(path.join(flagsDir, 'LICENSE')), 'the flag set ships its MIT licence');
});

test('country codes normalize to a vendored flag or nothing', () => {
  assert.equal(normalizeCountryCode('au'), 'AU');
  assert.equal(countryFlagSrc(' us '), '/assets/flags/US.svg');
  assert.equal(countryFlagSrc('XK'), '/assets/flags/XK.svg');
  // OurAirports placeholders and junk never produce an image request.
  for (const value of ['OC', 'XP', 'ZZ', 'AUS', '', null, undefined, 42]) {
    assert.equal(normalizeCountryCode(value), '', String(value));
    assert.equal(countryFlagSrc(value), '', String(value));
  }
});

test('country names come from Intl with the code as a fallback', () => {
  assert.equal(countryDisplayName('AU'), 'Australia');
  assert.equal(countryDisplayName('gb'), 'United Kingdom');
  assert.equal(countryDisplayName('ZZ'), '');
  assert.match(countryDisplayName('XK'), /Kosovo|XK/);
});

test('route labels split into per-end segments with their countries', () => {
  assert.deepEqual(flightRouteSegments({ departureCountry: 'AU', arrivalCountry: 'US' }, 'YSSY → KJFK'), [
    { text: 'YSSY', country: 'AU' },
    { text: 'KJFK', country: 'US' },
  ]);
  assert.deepEqual(flightRouteSegments({ departureCountry: 'AU', arrivalCountry: null }, 'NEAR YSSY → NEAR YMML'), [
    { text: 'NEAR YSSY', country: 'AU' },
    { text: 'NEAR YMML', country: '' },
  ]);
  assert.deepEqual(flightRouteSegments({ departureCountry: null, arrivalCountry: 'AU' }, 'NEAR YSSY'), [
    { text: 'NEAR YSSY', country: 'AU' },
  ]);
  assert.deepEqual(flightRouteSegments({}, 'Location Unknown'), [{ text: 'Location Unknown', country: '' }]);
  assert.deepEqual(flightRouteSegments(null, ''), []);
  // Legacy hyphenated labels stay a single segment rather than guessing ends.
  assert.deepEqual(flightRouteSegments({ departureCountry: 'AU', arrivalCountry: 'US' }, 'YSSY-KJFK'), [
    { text: 'YSSY-KJFK', country: 'AU' },
  ]);
});
