#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected=${expected} actual=${actual}`);
  }
}

function assertTrue(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function withTempHome(fn) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-user-settings-'));
  const tempAppData = path.join(tmpRoot, 'AppData', 'Roaming');
  const tempXdgConfig = path.join(tmpRoot, '.config');

  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };

  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;
  process.env.APPDATA = tempAppData;
  process.env.XDG_CONFIG_HOME = tempXdgConfig;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;

  try {
    return fn(tmpRoot);
  } finally {
    if (prev.HOME === undefined) delete process.env.HOME; else process.env.HOME = prev.HOME;
    if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.USERPROFILE;
    if (prev.HOMEDRIVE === undefined) delete process.env.HOMEDRIVE; else process.env.HOMEDRIVE = prev.HOMEDRIVE;
    if (prev.HOMEPATH === undefined) delete process.env.HOMEPATH; else process.env.HOMEPATH = prev.HOMEPATH;
    if (prev.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = prev.APPDATA;
    if (prev.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME;

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function loadFreshUserSettingsModule() {
  const modulePath = resolveBackendRuntimeFile('core', 'user-settings.js');
  const storagePathsModulePath = resolveBackendRuntimeFile('utils', 'storage-paths.js');
  delete require.cache[modulePath];
  delete require.cache[storagePathsModulePath];
  return require(modulePath);
}

function run() {
  withTempHome((tmpHome) => {
    const mod = loadFreshUserSettingsModule();
    const settingsPath = mod.SETTINGS_FILE;
    // Compute expected cabin dir using the same storage-paths logic (platform-appropriate).
    // Do NOT hardcode the Windows AppData path — it differs on macOS/Linux.
    const storagePaths = require(resolveBackendRuntimeFile('utils', 'storage-paths.js'));
    const cabinDir = storagePaths.getCabinAnnouncementAudioDir(process.env);
    const themesDir = storagePaths.getThemesDir(process.env);
    const markerPath = storagePaths.getAppDataMarkerFilePath(process.env);
    const retiredProfilesRootDir = path.join(storagePaths.getAppDataRoot(process.env), 'Profiles');

    // Defaults should be present and template should be created.
    assertTrue(fs.existsSync(settingsPath), 'settings.json template should be created on first load');
    assertTrue(fs.existsSync(markerPath), 'app-data marker should be created on first load');
    assertTrue(fs.existsSync(cabinDir), 'cabin announcement audio directory should be created on first load');
    assertTrue(fs.existsSync(themesDir), 'themes directory should be created on first load');
    assertTrue(!fs.existsSync(retiredProfilesRootDir), 'first load should not create the retired Profiles folder');
    assertTrue(!settingsPath.includes('.msfs-telemetry'), 'settings.json should use the new Flight Fabric path');
    assertEqual(mod.settings.network.remoteAccess, false, 'network.remoteAccess default');
    assertEqual(mod.settings.network.remoteAircraftControl, false, 'network.remoteAircraftControl default');
    assertEqual(Object.hasOwn(mod.settings, 'performance'), false, 'performance poll-rate setting is retired');
    assertEqual(Object.hasOwn(mod.settings, 'advanced'), false, 'backend debug setting is not user-configurable');
    assertEqual(mod.settings.recording.autoStart, true, 'recording.autoStart default');
    assertEqual(Object.hasOwn(mod.settings.recording, 'maxFlights'), false, 'recording.maxFlights is retired');
    assertEqual(Object.hasOwn(mod.settings.recording, 'maxStorageMB'), false, 'recording.maxStorageMB is retired');
    assertEqual(mod.settings.cabinAnnouncements.startupGraceMs, 5000, 'cabinAnnouncements.startupGraceMs default');
    assertEqual(mod.settings.debrief.stabilityCriteria.gateRaFt, 1000, 'debrief.stabilityCriteria.gateRaFt default');
    assertEqual(mod.settings.debrief.stabilityCriteria.speedPlusKts, 5, 'debrief.stabilityCriteria.speedPlusKts default');

    // Valid JSON roots that are not settings objects must fail back to defaults.
    for (const invalidRoot of ['null', '[]', '"settings"', '42', 'true']) {
      fs.writeFileSync(settingsPath, invalidRoot, 'utf8');
      const originalConsoleWarn = console.warn;
      let fallback;
      try {
        console.warn = () => {};
        fallback = loadFreshUserSettingsModule();
      } finally {
        console.warn = originalConsoleWarn;
      }
      assertEqual(fallback.settings.network.remoteAccess, false, `non-object root ${invalidRoot} uses defaults`);
      assertEqual(fallback.settings.recording.autoStart, true, `non-object root ${invalidRoot} keeps nested defaults`);
    }

    // Restore the generated template for the remaining persistence assertions.
    fs.writeFileSync(settingsPath, JSON.stringify(mod.DEFAULT_SETTINGS, null, 2), 'utf8');

    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assertEqual(saved.network.remoteAccess, false, 'saved template network.remoteAccess default');
    assertEqual(saved.network.remoteAircraftControl, false, 'saved template network.remoteAircraftControl default');
    assertEqual(Object.hasOwn(saved, 'performance'), false, 'saved template omits retired poll-rate setting');
    assertEqual(Object.hasOwn(saved, 'advanced'), false, 'saved template omits backend debug settings');
    assertEqual(saved.recording.autoStart, true, 'saved template recording.autoStart default');
    assertEqual(Object.hasOwn(saved.recording, 'maxFlights'), false, 'saved template omits retired recording.maxFlights');
    assertEqual(Object.hasOwn(saved.recording, 'maxStorageMB'), false, 'saved template omits retired recording.maxStorageMB');
    assertEqual(saved.cabinAnnouncements.startupGraceMs, 5000, 'saved template cabinAnnouncements.startupGraceMs default');
    assertEqual(saved.debrief.stabilityCriteria.passPct, 80, 'saved template debrief.stabilityCriteria.passPct default');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assertEqual(marker.app, 'Flight Fabric', 'app-data marker app name');
    assertEqual(marker.version, 1, 'app-data marker version');

    // Retired local profile overrides must be repaired without touching any
    // unrelated setting or leaving a silent generic-profile fallback behind.
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        _version: 3,
        aircraft: { profile: ' local/msfs/legacy-private-profile ' },
        network: { remoteAccess: true },
      }, null, 2),
      'utf8'
    );

    const localProfileWarnings = [];
    const originalConsoleWarn = console.warn;
    let repairedLocalProfile;
    try {
      console.warn = (...args) => localProfileWarnings.push(args.join(' '));
      repairedLocalProfile = loadFreshUserSettingsModule();
    } finally {
      console.warn = originalConsoleWarn;
    }

    assertEqual(repairedLocalProfile.settings.aircraft.profile, 'auto', 'retired local profile switches to auto');
    assertEqual(repairedLocalProfile.settings.network.remoteAccess, true, 'local profile migration preserves unrelated settings');
    const persistedLocalProfileRepair = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assertEqual(persistedLocalProfileRepair.aircraft.profile, 'auto', 'retired local profile repair is persisted');
    assertTrue(
      localProfileWarnings.some((message) => (
        message.includes('local aircraft profile override is no longer supported')
        && message.includes('switched to auto-detection')
        && message.includes('profile file was not deleted')
      )),
      'retired local profile repair should emit a clear non-destructive warning'
    );

    const repeatRepairWarnings = [];
    try {
      console.warn = (...args) => repeatRepairWarnings.push(args.join(' '));
      const repairedAgain = loadFreshUserSettingsModule();
      assertEqual(repairedAgain.settings.aircraft.profile, 'auto', 'retired local profile repair is idempotent');
    } finally {
      console.warn = originalConsoleWarn;
    }
    assertEqual(repeatRepairWarnings.length, 0, 'persisted local profile repair should not warn again');

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        _version: 3,
        aircraft: { profile: 'bundled/msfs/fbw-a32nx' },
      }, null, 2),
      'utf8'
    );
    const validBundledProfile = loadFreshUserSettingsModule();
    assertEqual(
      validBundledProfile.settings.aircraft.profile,
      'bundled/msfs/fbw-a32nx',
      'bundled profile override remains unchanged'
    );

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        _version: 3,
        aircraft: { profile: 'custom-profile-id' },
      }, null, 2),
      'utf8'
    );
    const validUnqualifiedProfile = loadFreshUserSettingsModule();
    assertEqual(
      validUnqualifiedProfile.settings.aircraft.profile,
      'custom-profile-id',
      'unqualified profile override remains unchanged'
    );

    const localProfileSaveWarnings = [];
    let repairedLocalProfileSave;
    try {
      console.warn = (...args) => localProfileSaveWarnings.push(args.join(' '));
      repairedLocalProfileSave = validUnqualifiedProfile.saveUserSettings({
        ...validUnqualifiedProfile.settings,
        aircraft: { profile: 'local/legacy-private-profile' },
      });
    } finally {
      console.warn = originalConsoleWarn;
    }
    assertEqual(repairedLocalProfileSave.aircraft.profile, 'auto', 'save path refuses retired local profile overrides');
    assertEqual(
      JSON.parse(fs.readFileSync(settingsPath, 'utf8')).aircraft.profile,
      'auto',
      'save path persists the repaired automatic profile selection'
    );
    assertEqual(localProfileSaveWarnings.length, 1, 'save path logs the retired local profile repair once');

    // Explicit migration fixture: older settings get the current schema version
    // and retired network-feature connection details are removed.
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        _version: 0,
        network: { remoteAccess: true },
        advanced: { debugMode: true },
        performance: { pollRateMs: 50 },
        liveSharing: {
          enabled: true,
          relayUrl: 'wss://your-relay.example.com/',
          callsign: 'TEST123',
        },
        obs: {
          enabled: true,
          host: 'obs.local',
          password: 'retired-secret',
        },
      }, null, 2),
      'utf8'
    );

    const migrated = loadFreshUserSettingsModule();
    assertEqual(migrated.settings._version, 3, 'migration bumps legacy settings version');
    assertEqual(migrated.settings.network.remoteAccess, true, 'migration preserves network.remoteAccess');
    assertEqual(migrated.settings.network.remoteAircraftControl, false, 'migration keeps trusted-LAN aircraft control opt-in');
    assertEqual(Object.hasOwn(migrated.settings, 'liveSharing'), false, 'migration removes retired live-sharing settings');
    assertEqual(Object.hasOwn(migrated.settings, 'obs'), false, 'migration removes retired OBS automation settings');
    assertEqual(Object.hasOwn(migrated.settings, 'performance'), false, 'migration removes retired poll-rate settings');
    assertEqual(Object.hasOwn(migrated.settings, 'advanced'), false, 'migration removes retired backend debug settings');

    migrated.saveUserSettings(migrated.settings);
    const persistedMigration = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assertEqual(persistedMigration._version, 3, 'persisted migration writes current settings version');
    assertEqual(Object.hasOwn(persistedMigration, 'liveSharing'), false, 'persisted migration omits retired live-sharing settings');
    assertEqual(Object.hasOwn(persistedMigration, 'obs'), false, 'persisted migration omits retired OBS settings');
    assertEqual(Object.hasOwn(persistedMigration, 'performance'), false, 'persisted migration omits retired poll-rate settings');
    assertEqual(Object.hasOwn(persistedMigration, 'advanced'), false, 'persisted migration omits retired backend debug settings');

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        _version: 99,
        network: { remoteAccess: false },
      }, null, 2),
      'utf8'
    );
    const futureVersion = loadFreshUserSettingsModule();
    assertEqual(futureVersion.settings._version, 99, 'migration does not downgrade future settings version');

    // User override + deep merge should preserve unspecified defaults.
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        network: { remoteAccess: true, remoteAircraftControl: true },
        advanced: { debugMode: true },
        recording: { autoStart: false, maxFlights: 42, maxStorageMB: 750 },
        performance: { pollRateMs: 50 },
        cabinAnnouncements: { startupGraceMs: 2500 },
        debrief: { stabilityCriteria: { speedPlusKts: 9 } },
      }, null, 2),
      'utf8'
    );

    const mod2 = loadFreshUserSettingsModule();
    assertEqual(mod2.settings.network.remoteAccess, true, 'user override: network.remoteAccess');
    assertEqual(mod2.settings.network.remoteAircraftControl, true, 'user override: network.remoteAircraftControl');
    assertEqual(mod2.settings.recording.autoStart, false, 'user override: recording.autoStart');
    assertEqual(Object.hasOwn(mod2.settings.recording, 'maxFlights'), false, 'legacy recording.maxFlights override is removed');
    assertEqual(Object.hasOwn(mod2.settings.recording, 'maxStorageMB'), false, 'legacy recording.maxStorageMB override is removed');
    assertEqual(Object.hasOwn(mod2.settings, 'performance'), false, 'legacy performance.pollRateMs override is removed');
    assertEqual(Object.hasOwn(mod2.settings, 'advanced'), false, 'legacy advanced.debugMode override is removed');
    assertEqual(mod2.settings.cabinAnnouncements.startupGraceMs, 2500, 'user override: cabinAnnouncements.startupGraceMs');
    assertEqual(mod2.settings.debrief.stabilityCriteria.speedPlusKts, 9, 'user override: debrief.stabilityCriteria.speedPlusKts');
    assertEqual(mod2.settings.debrief.stabilityCriteria.speedMinusKts, 5, 'deep merge preserves debrief.stabilityCriteria.speedMinusKts default');
    assertEqual(mod2.settings.network.wsPort, 8099, 'deep merge preserves network.wsPort default');

    const loadMigratedRecordingSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assertEqual(Object.hasOwn(loadMigratedRecordingSettings.recording, 'maxFlights'), false, 'load removes legacy recording.maxFlights from disk');
    assertEqual(Object.hasOwn(loadMigratedRecordingSettings.recording, 'maxStorageMB'), false, 'load removes legacy recording.maxStorageMB from disk');
    assertEqual(Object.hasOwn(loadMigratedRecordingSettings, 'performance'), false, 'load removes legacy poll rate from disk');
    assertEqual(Object.hasOwn(loadMigratedRecordingSettings, 'advanced'), false, 'load removes legacy backend debug setting from disk');

    mod2.saveUserSettings(mod2.settings);
    const persistedRetiredRecordingSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assertEqual(Object.hasOwn(persistedRetiredRecordingSettings.recording, 'maxFlights'), false, 'save removes legacy recording.maxFlights');
    assertEqual(Object.hasOwn(persistedRetiredRecordingSettings.recording, 'maxStorageMB'), false, 'save removes legacy recording.maxStorageMB');

    // getSetting env var overrides should win and parse correctly.
    process.env.TEST_BOOL_SETTING = 'true';
    process.env.TEST_NUM_SETTING = '123';
    process.env.TEST_NUM_BAD = 'not-a-number';

    assertEqual(
      mod2.getSetting(mod2.settings, 'network.remoteAccess', 'TEST_BOOL_SETTING', false),
      true,
      'getSetting boolean env override'
    );
    assertEqual(
      mod2.getSetting(mod2.settings, 'network.wsPort', 'TEST_NUM_SETTING', 100),
      123,
      'getSetting numeric env override'
    );
    assertEqual(
      mod2.getSetting(mod2.settings, 'network.wsPort', 'TEST_NUM_BAD', 100),
      100,
      'getSetting invalid numeric env override falls back to default'
    );

    delete process.env.TEST_BOOL_SETTING;
    delete process.env.TEST_NUM_SETTING;
    delete process.env.TEST_NUM_BAD;
  });

  console.log('✅ user-settings tests passed');
}

run();
