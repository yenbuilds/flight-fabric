#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const storagePaths = require(resolveBackendRuntimeFile('utils', 'storage-paths.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

function assertTrue(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected=${expected} actual=${actual}`);
  }
}


function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-storage-paths-'));
  const env = {
    HOME: tmpRoot,
    USERPROFILE: tmpRoot,
    APPDATA: path.join(tmpRoot, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: path.join(tmpRoot, '.config'),
    OneDrive: path.join(tmpRoot, 'OneDrive'),
  };

  try {
    console.log('\nStorage Path Tests\n');

    test('settings path uses Flight Fabric settings folder', () => {
      const settingsPath = storagePaths.getSettingsFilePath(env);
      assertTrue(settingsPath.includes('Flight Fabric'), 'settings path should include the Flight Fabric folder');
      assertTrue(settingsPath.endsWith(path.join('Settings', 'settings.json')), 'settings path should end with Settings/settings.json');
    });

    test('retired aircraft profile directory APIs are not exposed', () => {
      const retiredProfilePathApis = [
        'PROFILES_DIR_NAME',
        'AIRCRAFT_PROFILES_DIR_NAME',
        'BUNDLED_PROFILES_DIR_NAME',
        'LOCAL_PROFILES_DIR_NAME',
        'getProfilesRootDir',
        'getAircraftProfilesDir',
        'resolveAircraftProfilesDir',
        'getBundledProfilesDir',
        'resolveBundledProfilesDir',
        'getLocalProfilesDir',
        'resolveLocalProfilesDir',
        'getAircraftProfilesNamespaceDir',
        'getAircraftProfilesSimulatorDir',
      ];
      assertTrue(
        retiredProfilePathApis.every((apiName) => storagePaths[apiName] === undefined),
        'storage path API should not advertise retired aircraft profile directories'
      );
    });

    test('cabin announcement audio dir uses the app-data tree', () => {
      const cabinDir = storagePaths.getCabinAnnouncementAudioDir(env);
      assertTrue(cabinDir.includes('Flight Fabric'), 'cabin announcement audio dir should include the Flight Fabric folder');
      assertTrue(cabinDir.endsWith(path.join('Audio', 'Cabin')), 'cabin announcement audio dir should end with Audio/Cabin');
    });

    test('themes dir uses the app-data tree', () => {
      const themesDir = storagePaths.getThemesDir(env);
      assertTrue(themesDir.includes('Flight Fabric'), 'themes dir should include the Flight Fabric folder');
      assertTrue(themesDir.endsWith(path.join('Themes')), 'themes dir should end with Themes');
    });

    test('user identity file uses the app-data root', () => {
      const userIdPath = storagePaths.getUserIdFilePath(env);
      const expectedPath = path.join(storagePaths.getAppDataRoot(env), storagePaths.USER_ID_FILE_NAME);
      assertEqual(userIdPath, expectedPath, 'user identity path');
    });

    test('app-data marker file uses the app-data root', () => {
      const markerPath = storagePaths.getAppDataMarkerFilePath(env);
      const expectedPath = path.join(storagePaths.getAppDataRoot(env), storagePaths.APP_DATA_MARKER_FILE_NAME);
      assertEqual(markerPath, expectedPath, 'app-data marker path');
    });

    test('documents candidates include a home Documents fallback', () => {
      const docsDir = path.join(tmpRoot, 'Documents');
      const candidates = storagePaths.getDocumentsDirCandidates(env);
      assertTrue(candidates.includes(docsDir), 'documents candidates should include the home Documents path');
    });

  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log(`\nStorage path tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
