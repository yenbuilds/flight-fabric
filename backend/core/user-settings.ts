// user-settings.js
// User-editable settings loaded from settings.json in the app data directory.
//
// This provides a user-friendly way to configure Flight Fabric without
// needing to edit environment variables or .env files.
//
// Settings file location:
//   Windows: %APPDATA%\\Flight Fabric\\Settings\\settings.json
//   macOS:   ~/Library/Application Support/Flight Fabric/Settings/settings.json
//
// If the file doesn't exist, defaults are used and a template is created.
//
// IMPORTANT: Environment variables always override settings.json values.
// This allows power users to use env vars while casual users edit JSON.

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const { parseProfileLocator } = require('../aircraft/aircraft-profile-identity.js') as {
  parseProfileLocator: (value: unknown) => { namespace?: string | null } | null;
};
const { APP_SETTINGS_DEFAULTS } = require('../../shared/app-settings-shared.js') as {
  APP_SETTINGS_DEFAULTS: {
    cabinAnnouncementsEnabled: boolean;
  };
};
const {
  ensureDirExists,
  APP_DATA_MARKER_FILE_NAME,
  SETTINGS_FILE_NAME,
  getAppDataRoot,
  getCabinAnnouncementAudioDir,
  getThemesDir,
  resolveAppDataMarkerFilePath,
  resolveSettingsFilePath,
} = require('../utils/storage-paths.js') as {
  APP_DATA_MARKER_FILE_NAME: string;
  ensureDirExists: (dirPath: string) => void;
  SETTINGS_FILE_NAME: string;
  getAppDataRoot: () => string;
  getCabinAnnouncementAudioDir: () => string;
  getThemesDir: () => string;
  resolveAppDataMarkerFilePath: () => string;
  resolveSettingsFilePath: () => string;
};
const { safeReplaceTextFileSync } = require('../utils/safe-fs.js') as {
  safeReplaceTextFileSync: (_options: {
    allowedBasenames?: string[];
    allowedExtensions?: string[];
    data: string;
    operation: string;
    rootDir: string;
    targetPath: string;
  }) => string;
};

type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
type JsonObject = { [key: string]: JsonValue };
type JsonArray = JsonValue[];
type SettingsObject = Record<string, any>;

// App data directory (same as where user-owned app data lives)
const CURRENT_SETTINGS_VERSION = 3;
const APP_DATA_DIR = getAppDataRoot();
const CABIN_ANNOUNCEMENTS_DIR = getCabinAnnouncementAudioDir();
const THEMES_DIR = getThemesDir();
const APP_DATA_MARKER_FILE = resolveAppDataMarkerFilePath();
const SETTINGS_FILE = resolveSettingsFilePath();
let retiredLocalProfileWarningEmitted = false;

// Default settings with documentation
const DEFAULT_SETTINGS: SettingsObject = {
  // Schema version for forward compatibility
  _version: CURRENT_SETTINGS_VERSION,
  _description: 'Flight Fabric user settings. Edit values below and restart the app.',

  // ---------------------------------------------------------------------------
  // Database Storage Limits
  // ---------------------------------------------------------------------------
  // Used by launcher settings UI and local retention controls.
  database: {
    // Maximum database size in megabytes (default: 200 MB)
    maxSizeMB: 200,

    // Maximum age of flight data in days (default: 90 days)
    maxAgeDays: 90,
  },

  // ---------------------------------------------------------------------------
  // Network & Remote Access
  // ---------------------------------------------------------------------------
  network: {
    // WebSocket server port (default: 8099)
    // Change if another app is using this port.
    wsPort: 8099,

    // HTTP server port for mobile/tablet access (default: 8100)
    httpPort: 8100,

    // Allow access from other devices on your network (default: false)
    // When false, only this computer can connect.
    // When true, tablets/phones on same WiFi can view overlays.
    remoteAccess: false,

    // Allow trusted-LAN browsers to send aircraft control commands (default: false).
    // This never grants settings, recording, history, or profile-management access.
    remoteAircraftControl: false,

    // Check for app updates by fetching the public update manifest
    // (default: true). Checks use a low cadence and can be disabled for a
    // fully quiet app.
    updateChecks: true,

    // Allow the online OpenStreetMap standard basemap in map views.
    // (default: true). Turn off for local overlays without third-party tile
    // server requests.
    onlineMapTiles: true,
  },

  // ---------------------------------------------------------------------------
  // Flight Recording
  // ---------------------------------------------------------------------------
  recording: {
    // Automatically start saving a CSV flight log when Flight Fabric detects a
    // flight start (default: true). Turn off if you only want live monitoring.
    autoStart: true,
  },

  // ---------------------------------------------------------------------------
  // Aircraft
  // ---------------------------------------------------------------------------
  aircraft: {
    // Aircraft profile override. Use 'auto' for title-based detection.
    profile: 'auto',
  },

  // ---------------------------------------------------------------------------
  // Vendor SDK authorizations
  // ---------------------------------------------------------------------------
  integrations: {
    pmdg737Sdk: {
      // Set only by the desktop EULA flow after the installed PMDG SDK PDF is
      // opened and the user explicitly accepts it.
      eulaAcceptedVersion: '',
      eulaAcceptedAt: '',
    },
    pmdg777Sdk: {
      // Set only by the desktop EULA flow after the installed PMDG SDK PDF is
      // opened and the user explicitly accepts it.
      eulaAcceptedVersion: '',
      eulaAcceptedAt: '',
    },
  },

  // ---------------------------------------------------------------------------
  // Debrief
  // ---------------------------------------------------------------------------
  // Personal simulator debrief criteria. These are not SOP compliance rules and
  // do not make Flight Fabric training software; they only tune the local
  // post-flight stability explanation/scoring model.
  debrief: {
    stabilityCriteria: {
      gateRaFt: 1000,
      speedMinusKts: 5,
      speedPlusKts: 5,
      vsMinFpm: -1000,
      vsMaxClimbFpm: 200,
      glidepathAngleDeg: 3,
      glidepathVsDeltaMaxFpm: 200,
      speedTrendMaxKtsPerSec: 2.5,
      thrustIdleMinPct: 15,
      thrustStableMaxPctPerSec: 10,
      pitchMinDeg: -5,
      pitchMaxDeg: 15,
      bankMaxDeg: 25,
      passPct: 80,
    },
  },

  // ---------------------------------------------------------------------------
  // Simulator
  // ---------------------------------------------------------------------------
  simulator: {
    // Simulator connection mode.
    // KittyHawk = supported MSFS 2024 path.
    // XPLANE_WEB = experimental, untested X-Plane 12 Web API provider.
    protocol: 'KittyHawk',
  },

  // ---------------------------------------------------------------------------
  // Cabin Announcements
  // ---------------------------------------------------------------------------
  // Plays pre-recorded cabin PA audio at key flight phase transitions.
  // Drop custom files into Flight Fabric/Audio/Cabin/{style}/ inside the
  // per-user app-data folder. User files override bundled defaults with the
  // same style + filename.
  //
  // Phases covered: taxi-out, climb, cruise (seatbelt off), descent,
  //                 final approach, taxi-in (arrival).
  cabinAnnouncements: {
    // Master switch (default: false - users opt in before PA audio plays).
    enabled: APP_SETTINGS_DEFAULTS.cabinAnnouncementsEnabled,

    // Audio pack subfolder inside Flight Fabric/Audio/Cabin/
    //   e.g. "standard", "concise", or any custom folder name you create.
    style: 'standard',

    // Ignore phase-triggered PA audio briefly after startup, flight start,
    // or aircraft change so load-time phase noise does not play audio.
    startupGraceMs: 5000,
  },

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------
  effects: {
    // Camera shake on touchdown, scaled to landing V/S (default: false).
    // Requires the LVAR sidecar bridge to be running.
    touchdownShake: false,
  },

};

/**
 * Ensure the app data directory exists
 */
function ensureAppDataDir(): void {
  ensureDirExists(APP_DATA_DIR);
  ensureDirExists(path.dirname(SETTINGS_FILE));
  ensureDirExists(CABIN_ANNOUNCEMENTS_DIR);
  ensureDirExists(THEMES_DIR);
  ensureAppDataMarker();
}

function ensureAppDataMarker(): void {
  if (fs.existsSync(APP_DATA_MARKER_FILE)) return;

  try {
    safeReplaceTextFileSync({
      allowedBasenames: [APP_DATA_MARKER_FILE_NAME],
      allowedExtensions: ['.json'],
      data: JSON.stringify({
        app: 'Flight Fabric',
        purpose: 'Marks this directory as Flight Fabric per-user app data.',
        version: 1,
      }, null, 2),
      operation: 'createAppDataMarker',
      rootDir: APP_DATA_DIR,
      targetPath: APP_DATA_MARKER_FILE,
    });
  } catch (error) {
    const err = error as { message?: string };
    console.warn(`[settings] Could not create app-data marker: ${err.message}`);
  }
}

function hasRetiredRecordingLimits(settings: SettingsObject): boolean {
  const recording = settings.recording;
  return (
    recording !== null
    && typeof recording === 'object'
    && !Array.isArray(recording)
    && (
      Object.hasOwn(recording, 'maxFlights')
      || Object.hasOwn(recording, 'maxStorageMB')
      || Object.hasOwn(recording, 'maxStorageMb')
    )
  );
}

function hasRetiredPollRate(settings: SettingsObject): boolean {
  return (
    settings.performance !== null
    && typeof settings.performance === 'object'
    && !Array.isArray(settings.performance)
    && Object.hasOwn(settings.performance, 'pollRateMs')
  );
}

function hasRetiredDebugMode(settings: SettingsObject): boolean {
  return (
    settings.advanced !== null
    && typeof settings.advanced === 'object'
    && !Array.isArray(settings.advanced)
    && Object.hasOwn(settings.advanced, 'debugMode')
  );
}

function hasRetiredLocalAircraftProfile(settings: SettingsObject): boolean {
  return parseProfileLocator(settings.aircraft?.profile)?.namespace === 'local';
}

function migrateUserSettings(settings: SettingsObject): SettingsObject {
  const currentVersion = Number(settings._version);
  if (!Number.isFinite(currentVersion) || currentVersion < CURRENT_SETTINGS_VERSION) {
    settings._version = CURRENT_SETTINGS_VERSION;
  }

  // These retired alpha features were removed in settings v2. Drop their saved
  // connection details, including any legacy OBS WebSocket password.
  delete settings.liveSharing;
  delete settings.obs;

  // Telemetry acquisition is fixed at 100 ms (10 Hz). Remove the retired
  // setting so settings.json cannot imply that this safety invariant is
  // user-configurable. Preserve any unrelated future performance keys.
  if (
    settings.performance !== null
    && typeof settings.performance === 'object'
    && !Array.isArray(settings.performance)
  ) {
    delete settings.performance.pollRateMs;
    if (Object.keys(settings.performance).length === 0) delete settings.performance;
  }

  // Flight recordings are retained until the user deletes them. These legacy
  // keys were never enforced and implied automatic pruning that does not exist.
  if (
    settings.recording !== null
    && typeof settings.recording === 'object'
    && !Array.isArray(settings.recording)
  ) {
    delete settings.recording.maxFlights;
    delete settings.recording.maxStorageMB;
    delete settings.recording.maxStorageMb;
  }

  // Backend debug events are support/developer-only and may be enabled only
  // with DEBUG_ENABLE. Remove the retired user setting so stale files cannot
  // reactivate or advertise the internal diagnostic stream.
  if (
    settings.advanced !== null
    && typeof settings.advanced === 'object'
    && !Array.isArray(settings.advanced)
  ) {
    delete settings.advanced.debugMode;
    if (Object.keys(settings.advanced).length === 0) delete settings.advanced;
  }

  // Local/imported profiles are no longer executable configuration sources.
  // Repair only the retired qualified namespace; keep bundled and auto values
  // untouched, and never delete the user's old profile files.
  if (hasRetiredLocalAircraftProfile(settings)) {
    settings.aircraft.profile = 'auto';
    if (!retiredLocalProfileWarningEmitted) {
      retiredLocalProfileWarningEmitted = true;
      console.warn(
        '[settings] A saved local aircraft profile override is no longer supported; '
        + 'switched to auto-detection. The profile file was not deleted.',
      );
    }
  }

  return settings;
}

/**
 * Load user settings from settings.json
 * Creates the file with defaults if it doesn't exist.
 * @returns {object} Merged settings (defaults + user overrides)
 */
function loadUserSettings(): SettingsObject {
  ensureAppDataDir();

  let userSettings: SettingsObject = {};
  let removeRetiredRecordingLimitsFromDisk = false;
  let removeRetiredPollRateFromDisk = false;
  let removeRetiredDebugModeFromDisk = false;
  let removeRetiredLocalAircraftProfileFromDisk = false;

  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const parsedSettings: unknown = JSON.parse(raw);
      if (
        parsedSettings === null
        || typeof parsedSettings !== 'object'
        || Array.isArray(parsedSettings)
      ) {
        throw new Error('Settings root must be a JSON object');
      }
      userSettings = parsedSettings as SettingsObject;
      removeRetiredRecordingLimitsFromDisk = hasRetiredRecordingLimits(userSettings);
      removeRetiredPollRateFromDisk = hasRetiredPollRate(userSettings);
      removeRetiredDebugModeFromDisk = hasRetiredDebugMode(userSettings);
      removeRetiredLocalAircraftProfileFromDisk = hasRetiredLocalAircraftProfile(userSettings);
    } catch (error) {
      userSettings = {};
      const err = error as { message?: string };
      console.warn(`[settings] Could not parse ${SETTINGS_FILE}: ${err.message}`);
      console.warn('[settings] Using default settings.');
    }
  } else {
    // Create default settings file for user reference
    try {
      safeReplaceTextFileSync({
        allowedBasenames: [SETTINGS_FILE_NAME],
        allowedExtensions: ['.json'],
        data: JSON.stringify(DEFAULT_SETTINGS, null, 2),
        operation: 'createUserSettings',
        rootDir: APP_DATA_DIR,
        targetPath: SETTINGS_FILE,
      });
      console.log(`[settings] Created ${SETTINGS_FILE} with default values.`);
    } catch (error) {
      const err = error as { message?: string };
      console.warn(`[settings] Could not create settings file: ${err.message}`);
    }
  }

  // Deep merge: defaults + user overrides
  const merged = migrateUserSettings(deepMerge(DEFAULT_SETTINGS, userSettings));
  if (
    removeRetiredRecordingLimitsFromDisk
    || removeRetiredPollRateFromDisk
    || removeRetiredDebugModeFromDisk
    || removeRetiredLocalAircraftProfileFromDisk
  ) {
    try {
      safeReplaceTextFileSync({
        allowedBasenames: [SETTINGS_FILE_NAME],
        allowedExtensions: ['.json'],
        data: JSON.stringify(merged, null, 2),
        operation: 'migrateRetiredUserSettings',
        rootDir: APP_DATA_DIR,
        targetPath: SETTINGS_FILE,
      });
    } catch (error) {
      const err = error as { message?: string };
      console.warn(`[settings] Could not remove retired settings from ${SETTINGS_FILE}: ${err.message}`);
    }
  }
  return merged;
}

/**
 * Persist a full user settings object to disk.
 * @param {object} nextSettings
 * @returns {object} Saved merged settings
 */
function saveUserSettings(nextSettings: SettingsObject | null | undefined): SettingsObject {
  ensureAppDataDir();
  const merged = migrateUserSettings(deepMerge(DEFAULT_SETTINGS, nextSettings || {}));
  safeReplaceTextFileSync({
    allowedBasenames: [SETTINGS_FILE_NAME],
    allowedExtensions: ['.json'],
    data: JSON.stringify(merged, null, 2),
    operation: 'saveUserSettings',
    rootDir: APP_DATA_DIR,
    targetPath: SETTINGS_FILE,
  });
  return merged;
}

/**
 * Update a subset of user settings and persist the result.
 * @param {object} patch
 * @returns {object} Saved merged settings
 */
function updateUserSettings(patch: SettingsObject | null | undefined): SettingsObject {
  const current = loadUserSettings();
  const merged = deepMerge(current, patch || {});
  return saveUserSettings(merged);
}

/**
 * Deep merge two objects (target wins on conflict)
 */
function deepMerge(defaults: SettingsObject, overrides: SettingsObject): SettingsObject {
  const result: SettingsObject = { ...defaults };

  for (const key of Object.keys(overrides)) {
    if (
      overrides[key] !== null &&
      typeof overrides[key] === 'object' &&
      !Array.isArray(overrides[key]) &&
      defaults[key] !== null &&
      typeof defaults[key] === 'object' &&
      !Array.isArray(defaults[key])
    ) {
      result[key] = deepMerge(defaults[key], overrides[key]);
    } else {
      result[key] = overrides[key];
    }
  }

  return result;
}

/**
 * Get a setting value, with environment variable override support.
 * @param {object} settings - Loaded settings object
 * @param {string} settingPath - Dot-notation path like "recording.autoStart"
 * @param {string} envVar - Environment variable name that can override
 * @param {any} defaultValue - Fallback if neither setting nor env var exists
 * @returns {any} The resolved value
 */
function getSetting<T>(settings: SettingsObject, settingPath: string, envVar: string, defaultValue: T): T {
  // Environment variable always wins
  const envValue = process.env[envVar];
  if (envValue !== undefined && envValue !== '') {
    // Parse based on default value type
    if (typeof defaultValue === 'number') {
      const n = Number.parseInt(envValue, 10);
      return (Number.isFinite(n) ? n : defaultValue) as T;
    }
    if (typeof defaultValue === 'boolean') {
      return (envValue === '1' || envValue === 'true') as T;
    }
    return envValue as T;
  }

  // Walk the settings path
  const parts = settingPath.split('.');
  let value: any = settings;
  for (const part of parts) {
    if (value === null || value === undefined) break;
    value = value[part];
  }

  return value !== undefined ? value : defaultValue;
}

// Load settings once at module load time
const userSettings = loadUserSettings();

const userSettingsApi = {
  // Raw settings object
  settings: userSettings,

  // IO helpers
  loadUserSettings,
  saveUserSettings,
  updateUserSettings,

  // Helper to get settings with env override
  getSetting,

  // Paths
  SETTINGS_FILE,
  APP_DATA_DIR,
  APP_DATA_MARKER_FILE,

  // Default reference
  DEFAULT_SETTINGS,
};

module.exports = userSettingsApi;

export {};
