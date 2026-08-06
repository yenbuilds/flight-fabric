#!/usr/bin/env node
/**
 * Test suite for flaps.js raw telemetry integration.
 * Run: node tests/scripts/test-flaps.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-flaps-'));
const previousEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
  APPDATA: process.env.APPDATA,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};

process.env.HOME = tempRoot;
process.env.USERPROFILE = tempRoot;
process.env.APPDATA = path.join(tempRoot, 'AppData', 'Roaming');
process.env.XDG_CONFIG_HOME = path.join(tempRoot, '.config');
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

process.on('exit', () => {
  if (previousEnv.HOME === undefined) delete process.env.HOME; else process.env.HOME = previousEnv.HOME;
  if (previousEnv.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousEnv.USERPROFILE;
  if (previousEnv.HOMEDRIVE === undefined) delete process.env.HOMEDRIVE; else process.env.HOMEDRIVE = previousEnv.HOMEDRIVE;
  if (previousEnv.HOMEPATH === undefined) delete process.env.HOMEPATH; else process.env.HOMEPATH = previousEnv.HOMEPATH;
  if (previousEnv.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = previousEnv.APPDATA;
  if (previousEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousEnv.XDG_CONFIG_HOME;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const profileLoader = require(resolveBackendRuntimeFile('aircraft', 'aircraft-profile-loader.js'));
const flaps = require(resolveBackendRuntimeFile('aircraft', 'flaps.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}`);
    console.log(`  Error: ${e.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg} Expected ${expected}, got ${actual}`);
  }
}

function assertDeepEqual(actual, expected, msg = '') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg} Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function setProfile(id) {
  profileLoader.clearCache();
  profileLoader.setActiveProfile(id);
}

function profilesWithFlapNotches(filter = {}) {
  return profileLoader.listProfiles()
    .filter((summary) => !summary.abstract)
    .filter((summary) => !filter.source || summary.source === filter.source)
    .filter((summary) => !filter.simulator || summary.simulator === filter.simulator)
    .map((summary) => ({
      summary,
      profile: profileLoader.loadProfile(summary.qualifiedId || summary.id),
    }))
    .filter(({ profile }) => Array.isArray(profile?.aircraft?.flaps?.notches) && profile.aircraft.flaps.notches.length > 0);
}

console.log('\n--- Legacy Notch API Tests ---\n');

setProfile('generic');

test('getValidNotches returns empty for generic aircraft', () => {
  setProfile('generic');
  assertDeepEqual(flaps.getValidNotches(), []);
});

test('getValidNotches returns active profile flap detents', () => {
  setProfile('ifly-737-max-8');
  assertDeepEqual(flaps.getValidNotches(), [0, 1, 2, 5, 10, 15, 25, 30, 40]);
});

test('getLandingNotches returns empty for generic aircraft', () => {
  setProfile('generic');
  assertDeepEqual(flaps.getLandingNotches(), []);
});

test('getLandingNotches returns active profile landing detents', () => {
  setProfile('ifly-737-max-8');
  assertDeepEqual(flaps.getLandingNotches(), [30, 40]);
});

test('getMaxNotch returns legacy percent max for generic aircraft', () => {
  setProfile('generic');
  assertEqual(flaps.getMaxNotch(), 100);
});

test('getMaxNotch returns max active profile detent', () => {
  setProfile('ifly-737-max-8');
  assertEqual(flaps.getMaxNotch(), 40);
});

test('isLandingFlaps is permissive without profile landing detents', () => {
  setProfile('generic');
  assertEqual(flaps.isLandingFlaps(null), true);
  assertEqual(flaps.isLandingFlaps(0), true);
  assertEqual(flaps.isLandingFlaps(42), true);
});

test('isLandingFlaps checks active profile landing detents', () => {
  setProfile('ifly-737-max-8');
  assertEqual(flaps.isLandingFlaps(15), false);
  assertEqual(flaps.isLandingFlaps(30), true);
  assertEqual(flaps.isLandingFlaps(40), true);
});

console.log('\n--- Angle Fallback Tests ---\n');

test('physical angle is used for generic aircraft when available', () => {
  setProfile('generic');
  const obj = flaps.makeFlapsObj(42, null, 18);
  assertEqual(obj.source, 'angle-generic');
  assertEqual(obj.notch, 18);
  assertEqual(obj.label, '18 deg');
  assertEqual(obj.percent, 42);
});

test('physical angle labels zero as UP for generic aircraft', () => {
  setProfile('generic');
  const obj = flaps.makeFlapsObj(0, null, 0);
  assertEqual(obj.source, 'angle-generic');
  assertEqual(obj.notch, 0);
  assertEqual(obj.label, 'UP');
});

test('iFly 737 MAX profile maps handle index to cockpit detent before angle fallback', () => {
  setProfile('ifly-737-max-8');
  const obj = flaps.makeFlapsObj(17, 3, 9);
  assertEqual(obj.source, 'profile');
  assertEqual(obj.notch, 5);
  assertEqual(obj.label, '5');
  assertEqual(obj.percent, 17);
  assertEqual(obj.fraction, 0.17);
});

test('raw handle percent does not infer a profile detent without handle index', () => {
  setProfile('ifly-737-max-8');
  const obj = flaps.makeFlapsObj(17, null, 9);
  assertEqual(obj.source, 'angle-generic');
  assertEqual(obj.notch, 9);
  assertEqual(obj.label, '9 deg');
  assertEqual(obj.percent, 17);
  assertEqual(obj.fraction, 0.17);
});

test('profile flap index maps to a detent when handle percent is unavailable', () => {
  setProfile('ifly-737-max-8');
  const obj = flaps.makeFlapsObj(null, 3, 9);
  assertEqual(obj.source, 'profile');
  assertEqual(obj.notch, 5);
  assertEqual(obj.label, '5');
  assertEqual(obj.percent, null);
  assertEqual(obj.fraction, null);
});

test('SimConnect handle index is treated as a profile slot, not a cockpit value', () => {
  setProfile('ifly-737-max-8');
  const obj = flaps.makeFlapsObj(50, 5, 15);
  assertEqual(obj.source, 'profile');
  assertEqual(obj.notch, 15);
  assertEqual(obj.label, '15');
});

test('X-Plane 737 handle ratio is not mapped through profile detents without an index', () => {
  setProfile('bundled/xplane/laminar-737-800');
  const obj = flaps.makeFlapsObj(87.5, null, 30);
  assertEqual(obj.source, 'angle-generic');
  assertEqual(obj.notch, 30);
  assertEqual(obj.label, '30 deg');
  assertEqual(obj.percent, 88);
  assertEqual(obj.fraction, 0.875);
});

test('all bundled MSFS flap profiles map discrete handle indexes by slot', () => {
  const profiles = profilesWithFlapNotches({ source: 'bundled', simulator: 'msfs' });
  assertEqual(profiles.length > 10, true, 'expected broad MSFS flap profile coverage.');

  for (const { summary, profile } of profiles) {
    setProfile(summary.qualifiedId || summary.id);
    const notches = profile.aircraft.flaps.notches;
    for (let index = 0; index < notches.length; index++) {
      const expected = notches[index];
      const obj = flaps.makeFlapsObj(42, index, 12);
      assertEqual(obj.source, 'profile', `${summary.qualifiedId} index ${index}:`);
      assertEqual(obj.notch, expected.value, `${summary.qualifiedId} index ${index}:`);
      assertEqual(obj.label, String(expected.label), `${summary.qualifiedId} index ${index}:`);
      assertEqual(obj.percent, 42, `${summary.qualifiedId} index ${index}:`);
    }
  }
});

test('profile flap detents omit retired fraction metadata', () => {
  const profiles = profilesWithFlapNotches();
  for (const { summary, profile } of profiles) {
    for (const notch of profile.aircraft.flaps.notches) {
      assertEqual(
        Object.hasOwn(notch, 'fraction'),
        false,
        `${summary.qualifiedId} flap ${notch.value}:`,
      );
    }
  }
});

test('bundled X-Plane flap profiles do not map handle ratios without a discrete index', () => {
  const profiles = profilesWithFlapNotches({ source: 'bundled', simulator: 'xplane' });
  assertEqual(profiles.length > 0, true, 'expected X-Plane flap profile coverage.');

  for (const { summary } of profiles) {
    setProfile(summary.qualifiedId || summary.id);
    const obj = flaps.makeFlapsObj(50, null, 20);
    assertEqual(obj.source, 'angle-generic', `${summary.qualifiedId}:`);
    assertEqual(obj.notch, 20, `${summary.qualifiedId}:`);
    assertEqual(obj.label, '20 deg', `${summary.qualifiedId}:`);
  }
});

console.log('\n--- Percent Fallback Tests ---\n');

test('raw percent is used when physical angle is unavailable', () => {
  setProfile('generic');
  const obj = flaps.makeFlapsObj(83, 5, null);
  assertEqual(obj.source, 'percent');
  assertEqual(obj.notch, 83);
  assertEqual(obj.label, '83%');
  assertEqual(obj.percent, 83);
  assertEqual(obj.fraction, 0.83);
});

test('raw percent fallback is profile independent', () => {
  setProfile('ifly-737-max-8');
  const ifly = flaps.mapFlapsRawToNotch(50);
  setProfile('fbw-a32nx');
  const fbw = flaps.mapFlapsRawToNotch(50);
  assertEqual(JSON.stringify(ifly), JSON.stringify(fbw));
  assertEqual(ifly.notch, 50);
  assertEqual(ifly.label, '50%');
});

test('raw percent fallback clamps low and high values', () => {
  assertEqual(flaps.mapFlapsRawToNotch(-1).notch, 0);
  assertEqual(flaps.mapFlapsRawToNotch(-1).label, 'UP');
  assertEqual(flaps.mapFlapsRawToNotch(99999).notch, 100);
  assertEqual(flaps.mapFlapsRawToNotch(99999).label, '100%');
});

test('invalid raw percent returns null values', () => {
  const result = flaps.mapFlapsRawToNotch('invalid');
  assertEqual(result.notch, null);
  assertEqual(result.percent, null);
  assertEqual(result.fraction, null);
});

console.log('\n--- LVAR Tests ---\n');

test('numeric flap LVAR is used raw without profile mapping', () => {
  setProfile('bundled/msfs/headwind-a330');
  const obj = flaps.makeFlapsObjFromLvar(4);
  assertEqual(obj.source, 'lvar');
  assertEqual(obj.notch, 4);
  assertEqual(obj.label, '4');
  assertEqual(obj.percent, null);
});

test('string flap LVAR is used raw without profile mapping', () => {
  setProfile('bundled/msfs/headwind-a330');
  const obj = flaps.makeFlapsObjFromLvar('1+F');
  assertEqual(obj.source, 'lvar');
  assertEqual(obj.notch, null);
  assertEqual(obj.label, '1+F');
});

test('zero flap LVAR labels as UP', () => {
  const obj = flaps.makeFlapsObjFromLvar(0);
  assertEqual(obj.source, 'lvar');
  assertEqual(obj.notch, 0);
  assertEqual(obj.label, 'UP');
});

test('invalid flap LVAR returns null', () => {
  assertEqual(flaps.makeFlapsObjFromLvar(null), null);
  assertEqual(flaps.makeFlapsObjFromLvar(undefined), null);
});

console.log('\n========================================');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log('========================================\n');

if (failed > 0) process.exit(1);
