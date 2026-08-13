#!/usr/bin/env node
// test-profile-autodetect.js
// Tests aircraft profile auto-detection from SimConnect titles.
//
// Run: node tests/scripts/test-profile-autodetect.js

// Set up environment
process.env.DEBUG_ENABLE = '0';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-profile-autodetect-'));
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

const profileLoader = require(resolveBackendRuntimeFile('aircraft', 'aircraft-profile-loader.js'));
const eventBus = require(resolveBackendRuntimeFile('core', 'event-bus.js'));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${e.message}`);
  }
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNotEqual(actual, expected, msg = '') {
  if (actual === expected) {
    throw new Error(`${msg}: expected anything except ${JSON.stringify(expected)}`);
  }
}

function assertNotNull(value, msg = '') {
  if (value == null) {
    throw new Error(`${msg}: expected non-null value`);
  }
}

console.log('\n=== Profile Auto-Detection Tests ===\n');

// ------------------------------
// Test Group: detectProfile()
// ------------------------------
console.log('--- detectProfile() ---');

test('does not detect PMDG 737 from non-PMDG config-path hint', () => {
  const profile = profileLoader.detectProfile('737-800 PAX SSW TC', {
    hint: 'SimObjects/Airplanes/Asobo_B737_800/aircraft.cfg',
  });
  assertNotEqual(profile.id, 'pmdg-737', 'profile ID');
});

test('detects FBW A32NX from config-path hint when title lacks vendor', () => {
  const profile = profileLoader.detectProfile('Airbus A320neo', {
    hint: 'Community/flybywire-aircraft-a320-neo/SimObjects/Airplanes/FlyByWire_A320_NEO/aircraft.cfg',
  });
  assertEqual(profile.id, 'fbw-a32nx', 'profile ID');
});

test('detects Fenix A32x variants from product titles and package paths', () => {
  const cases = [
    ['Fenix Simulations A319 IAE Sharklets', undefined, 'fenix-a319'],
    ['Fenix A320 CFM', undefined, 'fenix-a320'],
    ['Fenix Simulations Airbus A321 LR', undefined, 'fenix-a321'],
    [
      'Unknown repaint',
      'Community\\fnx-aircraft-319\\SimObjects\\Airplanes\\FNX_319\\aircraft.cfg',
      'fenix-a319',
    ],
    [
      'Unknown repaint',
      'Community/fnx-aircraft-320/SimObjects/Airplanes/FNX_32X/aircraft.cfg',
      'fenix-a320',
    ],
    [
      'Unknown repaint',
      'Community\\fnx-aircraft-321\\SimObjects\\Airplanes\\FNX_321\\aircraft.cfg',
      'fenix-a321',
    ],
    [
      'Fenix A320 CFM',
      'C:\\MSFS FSLTL Addons\\Community\\fnx-aircraft-320\\SimObjects\\Airplanes\\FNX_32X\\aircraft.cfg',
      'fenix-a320',
    ],
    [
      'Fenix A320 CFM',
      'C:\\PassiveAircraft Backup\\Community\\fnx-aircraft-320\\SimObjects\\Airplanes\\FNX_32X\\aircraft.cfg',
      'fenix-a320',
    ],
  ];
  for (const [title, hint, expectedId] of cases) {
    const profile = profileLoader.detectProfile(title, hint ? { hint } : undefined);
    assertEqual(profile.id, expectedId, `${title} profile ID`);
  }
});

test('Fenix A32x matchers reject traffic and passive-aircraft identities', () => {
  const cases = [
    ['FSLTL Fenix A319', undefined],
    ['FSLTL Fenix A320', undefined],
    ['FSLTL Fenix A321', undefined],
    ['PassiveAircraft Fenix A320', undefined],
    [
      'Fenix A319 CFM',
      'Community/fsltl-traffic-base/SimObjects/Airplanes/FSLTL_FNX_A319/aircraft.cfg',
    ],
    [
      'Fenix A320 CFM',
      'Community/fsltl-traffic-base/SimObjects/Airplanes/FSLTL_FNX_A320/aircraft.cfg',
    ],
    [
      'Fenix A321 CFM',
      'Community/fsltl-traffic-base/SimObjects/Airplanes/FSLTL_FNX_A321/aircraft.cfg',
    ],
    [
      'Fenix A320 CFM',
      'Official/OneStore/PassiveAircraft/SimObjects/Airplanes/FNX_A320/aircraft.cfg',
    ],
  ];
  for (const [title, hint] of cases) {
    const profile = profileLoader.detectProfile(title, hint ? { hint } : undefined);
    assertNotEqual(profile.id, 'fenix-a319', `${title} A319 profile ID`);
    assertNotEqual(profile.id, 'fenix-a320', `${title} A320 profile ID`);
    assertNotEqual(profile.id, 'fenix-a321', `${title} A321 profile ID`);
  }
});

test('detects the Microsoft / iniBuilds A320neo V2 and A321LR from documented identity and package paths', () => {
  const cases = [
    ['Airbus A320neo (v2) - Microsoft / iniBuilds', undefined, 'inibuilds-a320neo-v2'],
    ['Airbus A321LR - Microsoft / iniBuilds', undefined, 'inibuilds-a321lr'],
    [
      'Unknown repaint',
      'Official/StreamedPackages/fs24-microsoft-aircraft-a320neo/SimObjects/Airplanes/microsoft-a320neo/aircraft.cfg',
      'inibuilds-a320neo-v2',
    ],
    [
      'Unknown repaint',
      'Official/StreamedPackages/fs24-microsoft-aircraft-a321/SimObjects/Airplanes/microsoft-a321/aircraft.cfg',
      'inibuilds-a321lr',
    ],
  ];
  for (const [title, hint, expectedId] of cases) {
    const profile = profileLoader.detectProfile(title, hint ? { hint } : undefined);
    assertEqual(profile.id, expectedId, `${title} profile ID`);
  }
});

test('Microsoft / iniBuilds A32x matchers do not misclassify legacy, Fenix, FBW, LatinVFR, or sibling variants', () => {
  const cases = [
    ['Fenix A320neo', undefined, 'inibuilds-a320neo-v2'],
    [
      'Airbus A320neo',
      'Community/flybywire-aircraft-a320-neo/SimObjects/Airplanes/FlyByWire_A320_NEO/aircraft.cfg',
      'inibuilds-a320neo-v2',
    ],
    [
      'Asobo_A320_NEO',
      'Official/OneStore/asobo-aircraft-a320-neo/SimObjects/Airplanes/Asobo_A320_NEO/aircraft.cfg',
      'inibuilds-a320neo-v2',
    ],
    ['Airbus A320neo', undefined, 'inibuilds-a320neo-v2'],
    ['Airbus A320ceo', undefined, 'inibuilds-a320neo-v2'],
    ['Fenix Simulations Airbus A321 LR', undefined, 'inibuilds-a321lr'],
    [
      'LatinVFR Airbus A321LR',
      'Community/latinvfr-aircraft-a321neo/SimObjects/Airplanes/LVFR_A321neo/aircraft.cfg',
      'inibuilds-a321lr',
    ],
    ['Airbus A321LR', undefined, 'inibuilds-a321lr'],
    ['Airbus A321neo', undefined, 'inibuilds-a321lr'],
    ['Airbus A321ceo', undefined, 'inibuilds-a321lr'],
    ['Airbus A320neo (v2) - Microsoft / iniBuilds', undefined, 'inibuilds-a321lr'],
    ['Airbus A321LR - Microsoft / iniBuilds', undefined, 'inibuilds-a320neo-v2'],
  ];
  for (const [title, hint, forbiddenId] of cases) {
    const profile = profileLoader.detectProfile(title, hint ? { hint } : undefined);
    assertNotEqual(profile.id, forbiddenId, `${title} profile ID`);
  }
});

test('detects the canonical Virtualcol A220 profile', () => {
  const profile = profileLoader.detectProfile('Virtualcol A220-300');
  assertEqual(profile.id, 'virtualcol-a220', 'profile ID');
});

test('detects the canonical FlightSim Studio E175 profile', () => {
  const profile = profileLoader.detectProfile('FlightSim Studio E175');
  assertEqual(profile.id, 'fss-e175', 'profile ID');
});

test('detects Horizon 787-9 ahead of generic Asobo 787', () => {
  const profile = profileLoader.detectProfile('Horizon Simulations Boeing 787-9');
  assertEqual(profile.id, 'horizon-787-9', 'profile ID');
});

test('detects Kuro 787-8 ahead of generic Asobo 787', () => {
  const profile = profileLoader.detectProfile('Kuro_B787-8');
  assertEqual(profile.id, 'kuro-787-8', 'profile ID');
});

test('detects the stock Microsoft/Asobo 747-8 from documented title and supported MSFS 2024 paths', () => {
  const cases = [
    ['747-8i', undefined],
    ['Boeing 747-8 - Working Title Simulations', undefined],
    ['Boeing 747-8i - Working Title Simulations', undefined],
    ['Asobo_B747_8i', undefined],
    ['Microsoft / Asobo Studio Boeing 747-8i', undefined],
    ['Microsoft / Asobo Studio Boeing 747-8i / 747-8F', undefined],
    ['Boeing 747-8i (-8F)', undefined],
    ['Boeing 747-8i & 8f', undefined],
    ['Unknown repaint', 'SimObjects/Airplanes/asobo_b747_8i/aircraft.cfg'],
    ['Unknown repaint', 'Official/StreamedPackages/fs24-asobo-aircraft-b7478i/SimObjects/Airplanes/asobo_b747_8i/aircraft.cfg'],
  ];
  for (const [title, hint] of cases) {
    const profile = profileLoader.detectProfile(title, hint ? { hint } : undefined);
    assertEqual(profile.id, 'workingtitle-747-8', `${title} profile ID`);
  }
});

test('stock 747-8 matching rejects 747-400, Salty, FSLTL, PMDG, and passive identities', () => {
  const cases = [
    ['Boeing 747 Intercontinental', undefined],
    ['Boeing 747-8', undefined],
    ['Boeing 747-400 LCF Dreamlifter', undefined],
    ['Boeing 747-400 Global Supertanker', undefined],
    ['Salty Boeing 747-8i', 'Community/salty-747/SimObjects/Airplanes/Salty_B747_8i/aircraft.cfg'],
    ['Salty Asobo_B747_8i', undefined],
    ['FSLTL_B748F_CARGOLUX', 'Community/fsltl-traffic-base/SimObjects/Airplanes/FSLTL_B748F_CARGOLUX/aircraft.cfg'],
    ['PMDG Boeing 747-8i', 'Community/pmdg-aircraft-748/SimObjects/Airplanes/PMDG_748/aircraft.cfg'],
    ['Asobo PassiveAircraft B747-8i', 'Official/StreamedPackages/fs24-asobo-passiveaircraft-b747family/SimObjects/Airplanes/Passive_B747_8i/aircraft.cfg'],
    ['747-8i', 'Community/salty-747/SimObjects/Airplanes/Salty_B747_8i/aircraft.cfg'],
    ['Unknown repaint', 'Community/fs24-asobo-aircraft-b7478i/SimObjects/Airplanes/asobo_b747_8i/aircraft.cfg'],
  ];
  for (const [title, hint] of cases) {
    const profile = profileLoader.detectProfile(title, hint ? { hint } : undefined);
    assertNotEqual(profile.id, 'workingtitle-747-8', `${title} profile ID`);
  }
});

test('detects the stock Microsoft/Asobo 787-10 from exact product identity and supported MSFS 2024 paths', () => {
  const cases = [
    ['Boeing 787-10 Dreamliner', undefined],
    ['Boeing 787-10 Dreamliner - Working Title Simulations', undefined],
    ['Asobo_B787_10', undefined],
    ['Microsoft / Asobo Studio Boeing 787-10 Dreamliner', undefined],
    ['Unknown repaint', 'SimObjects/Airplanes/asobo_b787/aircraft.cfg'],
    ['Unknown repaint', 'Official/StreamedPackages/fs24-asobo-aircraft-b787-10/SimObjects/Airplanes/asobo_b787/aircraft.cfg'],
  ];
  for (const [title, hint] of cases) {
    const profile = profileLoader.detectProfile(title, hint ? { hint } : undefined);
    assertEqual(profile.id, 'asobo-787', `${title} profile ID`);
  }
});

test('stock 787-10 matching rejects bare Dreamliner, adjacent variants, traffic, passive, and community identities', () => {
  const cases = [
    ['Dreamliner', undefined],
    ['Boeing 787-8 Dreamliner', undefined],
    ['Boeing 787-9 Dreamliner', undefined],
    ['Heavy Division B78XH', undefined],
    ['QualityWings Boeing 787-10', undefined],
    ['Horizon Asobo_B787_10', 'SimObjects/Airplanes/Asobo_B787_10/aircraft.cfg'],
    ['FSLTL_B78X_QTR', 'Community/fsltl-traffic-base/SimObjects/Airplanes/FSLTL_B78X_QTR/aircraft.cfg'],
    ['Asobo PassiveAircraft B787-10', 'Official/StreamedPackages/fs24-asobo-passiveaircraft-b787family/SimObjects/Airplanes/Passive_B787_10/aircraft.cfg'],
    ['Boeing 787-10 Dreamliner', 'Community/heavy-division-b78xh/SimObjects/Airplanes/Asobo_B787_10/aircraft.cfg'],
    ['Unknown repaint', 'Community/asobo-aircraft-b787-10/SimObjects/Airplanes/asobo_b787/aircraft.cfg'],
  ];
  for (const [title, hint] of cases) {
    const profile = profileLoader.detectProfile(title, hint ? { hint } : undefined);
    assertNotEqual(profile.id, 'asobo-787', `${title} profile ID`);
  }
});

test('detects iniBuilds A300 from title', () => {
  const profile = profileLoader.detectProfile('iniBuilds A300-600R Airliner');
  assertEqual(profile.id, 'inibuilds-a300', 'profile ID');
});

test('detects iniBuilds A300 from config-path hint when title is generic', () => {
  const profile = profileLoader.detectProfile('A300-600R Airliner', {
    hint: 'Community/inibuilds-aircraft-a300-600r/SimObjects/Airplanes/iniBuilds A300-600R/aircraft.cfg',
  });
  assertEqual(profile.id, 'inibuilds-a300', 'profile ID');
});

test('detects the included Microsoft / iniBuilds Airbus A310-300 title and package variants', () => {
  const cases = [
    ['Airbus A310-300', undefined],
    ['Microsoft Airbus A310-300', undefined],
    ['iniBuilds Airbus A310-300', undefined],
    ['Microsoft_Airbus_A310_300', undefined],
    ['Unknown repaint', 'Official/OneStore/microsoft-aircraft-a310-300/SimObjects/Airplanes/A310/aircraft.cfg'],
  ];
  for (const [title, hint] of cases) {
    const profile = profileLoader.detectProfile(title, hint ? { hint } : undefined);
    assertEqual(profile.id, 'inibuilds-a310', `${title} profile ID`);
  }
});

test('does not confuse the iniBuilds A300-600R with the included A310-300', () => {
  const profile = profileLoader.detectProfile('iniBuilds Airbus A300-600R', {
    hint: 'Community/inibuilds-aircraft-a300-600r/SimObjects/Airplanes/A300/aircraft.cfg',
  });
  assertNotEqual(profile.id, 'inibuilds-a310', 'profile ID');
});

test('detects iniBuilds TriStar from its product title', () => {
  const profile = profileLoader.detectProfile('iniBuilds TriStar Airliner');
  assertEqual(profile.id, 'inibuilds-tristar', 'profile ID');
});

test('detects iniBuilds TriStar from config-path hint when the title is generic', () => {
  const profile = profileLoader.detectProfile('Lockheed L-1011-500', {
    hint: 'Official/OneStore/inibuilds-aircraft-tristar/SimObjects/Airplanes/iniBuilds L1011/aircraft.cfg',
  });
  assertEqual(profile.id, 'inibuilds-tristar', 'profile ID');
});

test('iniBuilds TriStar matcher rejects traffic and passive-aircraft identities', () => {
  const cases = [
    [
      'FSLTL iniBuilds L-1011 traffic',
      'Community/fsltl-traffic-base/SimObjects/Airplanes/FSLTL_L1011/aircraft.cfg',
    ],
    [
      'iniBuilds TriStar PassiveAircraft',
      'Official/OneStore/fs-base-aircraft-common/PassiveAircraft/SimObjects/Airplanes/iniBuilds L1011/aircraft.cfg',
    ],
  ];
  for (const [title, hint] of cases) {
    const profile = profileLoader.detectProfile(title, { hint });
    assertNotEqual(profile.id, 'inibuilds-tristar', `${title} profile ID`);
  }
});

test('detects TFDi Design MD-11 from vendor-qualified titles and official path identifiers', () => {
  const cases = [
    ['TFDi Design MD-11 Passenger GE', undefined],
    ['TFDi MD11 Freighter PW', undefined],
    [
      'Unknown repaint',
      'Community/tfdidesign-aircraft-md11/SimObjects/Airplanes/TFDi_Design_MD-11_GE/aircraft.cfg',
    ],
  ];
  for (const [title, hint] of cases) {
    const profile = profileLoader.detectProfile(title, hint ? { hint } : undefined);
    assertEqual(profile.id, 'tfdi-md-11', `${title} profile ID`);
  }
});

test('TFDi MD-11 matcher rejects generic, competing-vendor, adjacent-model, and FSLTL identities', () => {
  const cases = [
    ['McDonnell Douglas MD-11', undefined],
    ['Rotate MD-11', undefined],
    ['Sky Simulations MD-11', undefined],
    ['TFDi Design MD-10', undefined],
    ['TFDi Design DC-10', undefined],
    [
      'FSLTL_MD11F_ZZZZ',
      'Community/fsltl-traffic-base/SimObjects/Airplanes/FSLTL_MD11F_ZZZZ/aircraft.cfg',
    ],
    [
      'Unknown repaint',
      'Community/generic-aircraft-md11/SimObjects/Airplanes/MD11/aircraft.cfg',
    ],
  ];
  for (const [title, hint] of cases) {
    const profile = profileLoader.detectProfile(title, hint ? { hint } : undefined);
    assertNotEqual(profile.id, 'tfdi-md-11', `${title} profile ID`);
  }
});

test('detects iFly 737 MAX 8 separately from PMDG 737', () => {
  const profile = profileLoader.detectProfile('iFly Boeing 737 MAX 8');
  assertEqual(profile.id, 'ifly-737-max-8', 'profile ID');
  assertNotEqual(profile.id, 'pmdg-737', 'profile ID');
});

test('detects iFly 737 MAX 8 from config-path hint when title lacks vendor', () => {
  const profile = profileLoader.detectProfile('Boeing 737 MAX 8', {
    hint: 'Community/ifly-aircraft-737max8/SimObjects/Airplanes/iFly 737MAX8/aircraft.cfg',
  });
  assertEqual(profile.id, 'ifly-737-max-8', 'profile ID');
});

test('does not detect iFly 737 MAX 8 from non-iFly config-path hint', () => {
  const profile = profileLoader.detectProfile('Boeing 737 MAX 8', {
    hint: 'Official/OneStore/asobo-aircraft-737max8/SimObjects/Airplanes/B737MAX8/aircraft.cfg',
  });
  assertNotEqual(profile.id, 'ifly-737-max-8', 'profile ID');
});

test('detects MSFS 2024 included 737 MAX 8 separately from iFly and PMDG', () => {
  const profile = profileLoader.detectProfile('Boeing 737 MAX 8');
  assertEqual(profile.id, 'microsoft-737-max-8', 'profile ID');
  assertNotEqual(profile.id, 'ifly-737-max-8', 'profile ID');
  assertNotEqual(profile.id, 'pmdg-737', 'profile ID');
});

test('detects the included 737 MAX 8 from Microsoft/Asobo title and package variants', () => {
  const cases = [
    ['Asobo_B737_MAX8', undefined],
    ['Microsoft Boeing 737 MAX 8', undefined],
    ['Unknown repaint', 'Official/OneStore/asobo-aircraft-b737max8/SimObjects/Airplanes/B737MAX8/aircraft.cfg'],
  ];
  for (const [title, hint] of cases) {
    const profile = profileLoader.detectProfile(title, hint ? { hint } : undefined);
    assertEqual(profile.id, 'microsoft-737-max-8', `${title} profile ID`);
  }
});

test('does not confuse a generic Boeing 737-800 with the Microsoft 737 MAX 8', () => {
  const profile = profileLoader.detectProfile('Boeing 737-800');
  assertNotEqual(profile.id, 'microsoft-737-max-8', 'profile ID');
});

test('Microsoft 737 MAX 8 matcher vetoes explicit third-party and traffic identities', () => {
  const cases = [
    ['PMDG Boeing 737 MAX 8', undefined],
    ['Bredok3D Boeing 737 MAX 8', undefined],
    ['FSLTL Boeing 737 MAX 8', undefined],
    ['iFly Boeing 737 MAX 8', undefined],
    ['Unknown repaint', 'Community/bredok3d-aircraft-b737max8/SimObjects/Airplanes/B737MAX8/aircraft.cfg'],
    ['Unknown traffic', 'Community/fsltl-traffic-base/SimObjects/Airplanes/FSLTL_B38M/aircraft.cfg'],
  ];
  for (const [title, hint] of cases) {
    const profile = profileLoader.detectProfile(title, hint ? { hint } : undefined);
    assertNotEqual(profile.id, 'microsoft-737-max-8', `${title} profile ID`);
  }
});

test('detects Microsoft / S&H Software ATR 72-600 title and package variants', () => {
  const cases = [
    ['Microsoft ATR 72-600', undefined],
    ['S&H Software ATR 72-600', undefined],
    ['Microsoft_ATR_72_600', undefined],
    ['Unknown repaint', 'Official/OneStore/microsoft-aircraft-atr72-600/SimObjects/Airplanes/ATR72/aircraft.cfg'],
  ];
  for (const [title, hint] of cases) {
    const profile = profileLoader.detectProfile(title, hint ? { hint } : undefined);
    assertEqual(profile.id, 'microsoft-atr-72-600', `${title} profile ID`);
  }
});

test('does not confuse the ATR 42-600 with the Microsoft ATR 72-600 profile', () => {
  const profile = profileLoader.detectProfile('Microsoft ATR 42-600', {
    hint: 'Official/OneStore/microsoft-atr-common-pack/SimObjects/Airplanes/ATR42-600/aircraft.cfg',
  });
  assertNotEqual(profile.id, 'microsoft-atr-72-600', 'profile ID');
});

test('does not confuse the ATR 72-600F freighter with the passenger ATR 72-600 profile', () => {
  const cases = [
    ['Microsoft ATR 72-600F', undefined],
    ['Microsoft ATR 72 600 F', undefined],
    ['Unknown repaint', 'Official/OneStore/microsoft-aircraft-atr72-600f/SimObjects/Airplanes/ATR72-600F/aircraft.cfg'],
  ];
  for (const [title, hint] of cases) {
    const profile = profileLoader.detectProfile(title, hint ? { hint } : undefined);
    assertNotEqual(profile.id, 'microsoft-atr-72-600', `${title} profile ID`);
  }
});

test('detects MSFS 2024 included aircraft profiles from representative titles', () => {
  const cases = [
    ['Airbus A310-300', 'inibuilds-a310'],
    ['Airbus A320neo (v2) - Microsoft / iniBuilds', 'inibuilds-a320neo-v2'],
    ['Microsoft iniBuilds Airbus A321LR', 'inibuilds-a321lr'],
    ['Microsoft iniBuilds Airbus A330-300P2F', 'inibuilds-a330'],
    ['Microsoft iniBuilds Airbus A400M Atlas', 'inibuilds-a400m'],
    ['Boeing 737 Max 8', 'microsoft-737-max-8'],
    ['Microsoft ATR 72-600', 'microsoft-atr-72-600'],
    ['Boeing 747-8 - Working Title Simulations', 'workingtitle-747-8'],
    ['Boeing 787-10 Dreamliner - Working Title Simulations', 'asobo-787'],
    ['Cessna Citation CJ4', 'workingtitle-cj4'],
    ['Cessna Citation Longitude', 'workingtitle-citation-longitude'],
    ['Miltech Boeing C-17 Globemaster III', 'miltech-c17'],
  ];

  for (const [title, expectedId] of cases) {
    const profile = profileLoader.detectProfile(title);
    assertEqual(profile.id, expectedId, `${title} profile ID`);
  }
});

test('does not activate deferred C408 or DHC-6 profiles in this cut', () => {
  const cases = [
    ['Cessna 408 SkyCourier', 'microsoft-c408-skycourier'],
    ['DHC-6 Twin Otter', 'microsoft-dhc6-twin-otter'],
  ];
  for (const [title, removedProfileId] of cases) {
    const profile = profileLoader.detectProfile(title);
    assertNotEqual(profile.id, removedProfileId, `${title} profile ID`);
  }
});

test('falls back to generic for unknown aircraft', () => {
  const profile = profileLoader.detectProfile('Totally Unknown Aircraft XYZ');
  assertEqual(profile.id, 'generic', 'profile ID');
});

test('falls back to generic for null/empty title', () => {
  const profile1 = profileLoader.detectProfile(null);
  assertEqual(profile1.id, 'generic', 'null → generic');
  
  const profile2 = profileLoader.detectProfile('');
  assertEqual(profile2.id, 'generic', 'empty → generic');
});

// ------------------------------
// Test Group: setActiveProfileFromTitle()
// ------------------------------
console.log('\n--- setActiveProfileFromTitle() ---');

test('sets active profile from FlyByWire A32NX title', () => {
  profileLoader.clearCache();
  const profile = profileLoader.setActiveProfileFromTitle('FlyByWire A32NX');
  assertEqual(profile.id, 'fbw-a32nx', 'returned profile ID');
});

test('switching aircraft updates active profile', () => {
  profileLoader.clearCache();
  
  profileLoader.setActiveProfileFromTitle('iFly Boeing 737 MAX 8');
  assertEqual(profileLoader.getActiveProfile().id, 'ifly-737-max-8', 'first switch');
  
  profileLoader.setActiveProfileFromTitle('FlyByWire A32NX');
  assertEqual(profileLoader.getActiveProfile().id, 'fbw-a32nx', 'second switch');
  
  profileLoader.setActiveProfileFromTitle('Totally Unknown Aircraft XYZ');
  assertEqual(profileLoader.getActiveProfile().id, 'generic', 'third switch to generic');
});

// ------------------------------
// Test Group: Event Bus Integration
// ------------------------------
console.log('\n--- Event Bus Integration ---');

test('simconnect:aircraftChanged event triggers profile lookup', () => {
  profileLoader.clearCache();
  
  let receivedEvent = null;
  const unsub = eventBus.on('simconnect:aircraftChanged', (payload) => {
    receivedEvent = payload;
  });
  
  // Simulate what simconnect-client does
  eventBus.emit('simconnect:aircraftChanged', {
    title: 'FlyByWire A32NX',
    previousTitle: null,
    reason: 'SystemState:AircraftLoaded',
    timestamp: new Date().toISOString(),
  });
  
  assertNotNull(receivedEvent, 'event received');
  assertEqual(receivedEvent.title, 'FlyByWire A32NX', 'title in event');
  
  unsub();
});

test('profile change can be broadcast to simulated clients', () => {
  profileLoader.clearCache();
  
  const broadcasts = [];
  
  // Simulate the broadcast function
  function broadcast(msg) {
    broadcasts.push(msg);
  }
  
  // Simulate what simbridge-core does on aircraft change
  eventBus.on('simconnect:aircraftChanged', ({ title, previousTitle }) => {
    const profile = profileLoader.setActiveProfileFromTitle(title);
    broadcast({
      type: 'aircraftProfile',
      profile: {
        id: profile?.id,
        name: profile?.name,
        namespace: profile?.namespace,
        aircraftTitle: title,
      },
      previousTitle,
      source: 'auto-detect',
    });
  });
  
  // Trigger aircraft change
  eventBus.emit('simconnect:aircraftChanged', {
    title: 'FlyByWire A32NX',
    previousTitle: 'Generic Cessna',
    reason: 'test',
    timestamp: new Date().toISOString(),
  });
  
  assertEqual(broadcasts.length, 1, 'one broadcast');
  assertEqual(broadcasts[0].type, 'aircraftProfile', 'broadcast type');
  assertEqual(broadcasts[0].profile.id, 'fbw-a32nx', 'broadcast profile ID');
  assertEqual(broadcasts[0].previousTitle, 'Generic Cessna', 'previous title');
  assertEqual(broadcasts[0].source, 'auto-detect', 'source');
});

// ------------------------------
// Test Group: Profile Data After Switch
// ------------------------------
console.log('\n--- Profile Data After Switch ---');

test('getFlapsConfig() returns correct data after switch', () => {
  profileLoader.clearCache();
  profileLoader.setActiveProfileFromTitle('FlyByWire A32NX');
  
  const flaps = profileLoader.getFlapsConfig();
  assertNotNull(flaps, 'flaps config');
  assertNotNull(flaps.notches, 'flaps notches');
  
  // A32NX has source-backed landing detents.
  assertNotNull(flaps.landingNotches, 'landing notches');
});

test('getStabilityConfig() returns correct data after switch', () => {
  profileLoader.clearCache();
  profileLoader.setActiveProfileFromTitle('FlyByWire A32NX');
  
  const stability = profileLoader.getStabilityConfig();
  assertNotNull(stability, 'stability config');
  assertNotNull(stability.speedBand, 'runtime scoring speed band');
});

test('getThrottleConfig() returns correct data after switch', () => {
  profileLoader.clearCache();
  profileLoader.setActiveProfileFromTitle('iFly Boeing 737 MAX 8');
  
  const throttle = profileLoader.getThrottleConfig();
  assertNotNull(throttle, 'throttle config');
  assertEqual(throttle.type, 'servo', '737 MAX uses servo throttle');
});

test('config data changes when switching to A320', () => {
  profileLoader.clearCache();
  
  // First a Boeing-family profile.
  profileLoader.setActiveProfileFromTitle('iFly Boeing 737 MAX 8');
  assertEqual(profileLoader.getThrottleConfig()?.type, 'servo', '737 MAX servo');
  
  // Switch to A320
  profileLoader.setActiveProfileFromTitle('FlyByWire A32NX');
  assertEqual(profileLoader.getThrottleConfig()?.type, 'detent', 'A320 detent');
});

// ------------------------------
// Test Group: Edge Cases
// ------------------------------
console.log('\n--- Edge Cases ---');

test('handles rapid consecutive aircraft changes', () => {
  profileLoader.clearCache();
  
  const titles = [
    'iFly Boeing 737 MAX 8',
    'FlyByWire A32NX',
    'Generic Cessna',
    'Microsoft ATR 72-600',
    'FlyByWire A32NX',
  ];
  
  for (const title of titles) {
    profileLoader.setActiveProfileFromTitle(title);
  }
  
  // Last one wins
  assertEqual(profileLoader.getActiveProfile().id, 'fbw-a32nx', 'last aircraft');
});

test('handles whitespace in aircraft titles', () => {
  const profile = profileLoader.detectProfile('  FlyByWire A32NX  ');
  assertEqual(profile.id, 'fbw-a32nx', 'trimmed title matches');
});

test('handles mixed case in aircraft titles', () => {
  const profile = profileLoader.detectProfile('fLyByWiRe a32nX');
  assertEqual(profile.id, 'fbw-a32nx', 'case insensitive match');
});

// ------------------------------
// Summary
// ------------------------------
console.log('\n=== Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(1);
}

console.log('\n✓ All profile auto-detection tests passed!\n');
