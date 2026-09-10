import test from 'node:test';
import assert from 'node:assert/strict';
import { aircraftCommandInput as parse } from './command-input.js';

test('command editor requires an explicit valid setting and preserves exact aircraft detents', () => {
  const pack = { kind: 'enum', values: ['off', 'auto'] };
  for (const invalid of [undefined, '', 'on', true]) assert.equal(parse(pack, invalid), null);
  assert.deepEqual(parse(pack, 'auto'), { value: 'auto' });
  assert.deepEqual(parse({ kind: 'boolean' }, false), { value: false });
  assert.equal(parse({ kind: 'boolean' }, 'false'), null);
  assert.deepEqual(parse({ kind: 'none' }), {});
  const altitude = { kind: 'number', min: 0, max: 49000, step: 100, units: 'feet' };
  for (const invalid of ['', ' ', '1e4', '0x100', '12001', '49001', '-100', 'NaN']) assert.equal(parse(altitude, invalid), null, invalid);
  assert.deepEqual(parse(altitude, '12000'), { value: 12000 });
  const mach = { kind: 'number', min: 0.4, max: 0.99, step: 0.01, units: 'mach' };
  assert.deepEqual(parse(mach, '0.78'), { value: 0.78 });
  assert.deepEqual(parse(mach, '.78'), { value: 0.78 });
  assert.equal(parse(mach, '0.781'), null);
});

test('command editor preserves leading squawk zeros and rejects invalid radio channels', () => {
  const squawk = { kind: 'number', min: 0, max: 7777, step: 1, units: 'squawk' };
  assert.deepEqual(parse(squawk, '0042'), { value: 42 });
  for (const invalid of ['42', '0080', '8888']) assert.equal(parse(squawk, invalid), null);
  const com = { kind: 'number', min: 118, max: 136.99, step: 0.005, units: 'com-megahertz' };
  assert.equal(parse(com, '118.020'), null); assert.deepEqual(parse(com, '118.015'), { value: 118.015 });
  const nav = { kind: 'number', min: 108, max: 117.95, step: 0.05, units: 'megahertz' };
  assert.equal(parse(nav, '110.31'), null); assert.deepEqual(parse(nav, '110.30'), { value: 110.3 });
});
