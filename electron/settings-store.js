const fs = require('fs');
const path = require('path');
const {
  PMDG_737_SDK_EULA_ACCEPTANCE_VERSION,
  getPmdg737SdkEulaAcceptance,
} = require('../shared/pmdg-737-sdk-authorization');
const {
  PMDG_777_SDK_EULA_ACCEPTANCE_VERSION,
  getPmdg777SdkEulaAcceptance,
} = require('../shared/pmdg-777-sdk-authorization');

function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function loadBackendRuntimeModule(relativePath) {
  const devPath = firstExistingPath([
    path.resolve(__dirname, '..', 'dist', 'backend', relativePath),
  ]);
  const packagedPath = process.resourcesPath
    ? path.join(process.resourcesPath, 'backend', relativePath)
    : null;
  const candidates = [devPath, packagedPath].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return require(candidate);
    }
  }

  throw new Error(`Unable to locate backend runtime module ${relativePath}. Run \`npm run build:backend:runtime\` first.`);
}

const {
  ensureDirExists,
  getAppDataRoot,
  resolveSettingsFilePath,
} = loadBackendRuntimeModule(path.join('utils', 'storage-paths.js'));
const {
  safeReplaceTextFileSync,
} = loadBackendRuntimeModule(path.join('utils', 'safe-fs.js'));
const {
  parseProfileLocator,
} = loadBackendRuntimeModule(path.join('aircraft', 'aircraft-profile-identity.js'));

const APP_DATA_DIR = getAppDataRoot();
const USER_SETTINGS_FILE = resolveSettingsFilePath();

const LAUNCHER_SETTINGS_DEFAULTS = Object.freeze({
  aircraft: 'auto',
  simconnect: 'KittyHawk',
  wsPort: 8099,
  httpPort: 8100,
  remoteAccess: false,
});

function sanitizeSimulatorProtocol(value) {
  return String(value || '').trim().toUpperCase() === 'XPLANE_WEB'
    ? 'XPLANE_WEB'
    : LAUNCHER_SETTINGS_DEFAULTS.simconnect;
}

function sanitizeAircraftProfile(value) {
  const normalized = typeof value === 'string' && value.trim()
    ? value.trim()
    : LAUNCHER_SETTINGS_DEFAULTS.aircraft;
  return parseProfileLocator(normalized)?.namespace === 'local'
    ? LAUNCHER_SETTINGS_DEFAULTS.aircraft
    : normalized;
}

function mapUserSettingsToLauncherSettings(userSettings) {
  const network = userSettings?.network || {};
  const aircraft = userSettings?.aircraft || {};
  const simulator = userSettings?.simulator || {};

  return {
    aircraft: sanitizeAircraftProfile(aircraft.profile),
    simconnect: sanitizeSimulatorProtocol(simulator.protocol),
    wsPort: Number.isFinite(Number(network.wsPort))
      ? Number(network.wsPort)
      : LAUNCHER_SETTINGS_DEFAULTS.wsPort,
    httpPort: Number.isFinite(Number(network.httpPort))
      ? Number(network.httpPort)
      : LAUNCHER_SETTINGS_DEFAULTS.httpPort,
    remoteAccess: typeof network.remoteAccess === 'boolean'
      ? network.remoteAccess
      : LAUNCHER_SETTINGS_DEFAULTS.remoteAccess,
  };
}

function applyLauncherSettingsToUserSettings(userSettings, launcherSettings) {
  const next = { ...(userSettings || {}) };

  // The backend telemetry cadence is fixed at 100 ms. Remove the retired key
  // whenever the legacy launcher writes settings so stale files are not
  // misleading and cannot appear to configure runtime behavior.
  if (next.performance && typeof next.performance === 'object' && !Array.isArray(next.performance)) {
    next.performance = { ...next.performance };
    delete next.performance.pollRateMs;
    if (Object.keys(next.performance).length === 0) delete next.performance;
  }

  // Backend diagnostics are not a launcher/user setting. Remove the retired
  // value whenever the launcher writes the shared settings file.
  if (next.advanced && typeof next.advanced === 'object' && !Array.isArray(next.advanced)) {
    next.advanced = { ...next.advanced };
    delete next.advanced.debugMode;
    if (Object.keys(next.advanced).length === 0) delete next.advanced;
  }

  next.aircraft = next.aircraft || {};
  next.simulator = next.simulator || {};
  next.network = next.network || {};

  next.aircraft.profile = launcherSettings.aircraft;
  next.simulator.protocol = launcherSettings.simconnect;
  next.network.wsPort = launcherSettings.wsPort;
  next.network.httpPort = launcherSettings.httpPort;
  next.network.remoteAccess = launcherSettings.remoteAccess;

  next._version = 3;
  next._description = 'Flight Fabric user settings. Edit values below and restart the app.';
  next._lastUpdated = new Date().toISOString();

  return next;
}

function sanitizeLauncherSettings(payload) {
  const input = payload || {};
  const rawWsPort = Number(input.wsPort);
  const rawHttpPort = Number(input.httpPort);
  return {
    aircraft: sanitizeAircraftProfile(input.aircraft),
    simconnect: sanitizeSimulatorProtocol(input.simconnect),
    // Clamp ports to unprivileged range
    wsPort: Number.isFinite(rawWsPort) && rawWsPort >= 1024 && rawWsPort <= 65535 ? Math.round(rawWsPort) : LAUNCHER_SETTINGS_DEFAULTS.wsPort,
    httpPort: Number.isFinite(rawHttpPort) && rawHttpPort >= 1024 && rawHttpPort <= 65535 ? Math.round(rawHttpPort) : LAUNCHER_SETTINGS_DEFAULTS.httpPort,
    remoteAccess: input.remoteAccess === true,
  };
}

function createSettingsStore({ settingsFile = USER_SETTINGS_FILE, logger = () => {} } = {}) {
  const appDataDir = path.dirname(settingsFile);

  function ensureAppDataDir() {
    ensureDirExists(APP_DATA_DIR);
    ensureDirExists(appDataDir);
  }

  function readUserSettingsFile() {
    try {
      if (!fs.existsSync(settingsFile)) return {};
      const raw = fs.readFileSync(settingsFile, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      logger('[settings] Failed to read settings file:', err.message);
      return {};
    }
  }

  function writeUserSettingsFile(settingsObject) {
    ensureAppDataDir();
    safeReplaceTextFileSync({
      allowedExtensions: ['.json'],
      data: JSON.stringify(settingsObject, null, 2),
      operation: 'saveElectronSettings',
      rootDir: appDataDir,
      targetPath: settingsFile,
    });
  }

  function getSettings() {
    return mapUserSettingsToLauncherSettings(readUserSettingsFile());
  }

  function saveSettings(payload) {
    try {
      const sanitized = sanitizeLauncherSettings(payload);
      const current = readUserSettingsFile();
      const updated = applyLauncherSettingsToUserSettings(current, sanitized);
      writeUserSettingsFile(updated);
      return { success: true, settings: mapUserSettingsToLauncherSettings(updated) };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  function resetSettings() {
    try {
      const current = readUserSettingsFile();
      const updated = applyLauncherSettingsToUserSettings(current, LAUNCHER_SETTINGS_DEFAULTS);
      writeUserSettingsFile(updated);
      return { success: true, settings: mapUserSettingsToLauncherSettings(updated) };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  function getPmdg737SdkEulaStatus() {
    return getPmdg737SdkEulaAcceptance(readUserSettingsFile());
  }

  function getPmdg777SdkEulaStatus() {
    return getPmdg777SdkEulaAcceptance(readUserSettingsFile());
  }

  function acceptPmdg737SdkEula() {
    try {
      const current = readUserSettingsFile();
      const updated = {
        ...current,
        integrations: {
          ...(current?.integrations || {}),
          pmdg737Sdk: {
            eulaAcceptedVersion: PMDG_737_SDK_EULA_ACCEPTANCE_VERSION,
            eulaAcceptedAt: new Date().toISOString(),
          },
        },
        _lastUpdated: new Date().toISOString(),
      };
      writeUserSettingsFile(updated);
      return { success: true, ...getPmdg737SdkEulaAcceptance(updated) };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  function acceptPmdg777SdkEula() {
    try {
      const current = readUserSettingsFile();
      const updated = {
        ...current,
        integrations: {
          ...(current?.integrations || {}),
          pmdg777Sdk: {
            eulaAcceptedVersion: PMDG_777_SDK_EULA_ACCEPTANCE_VERSION,
            eulaAcceptedAt: new Date().toISOString(),
          },
        },
        _lastUpdated: new Date().toISOString(),
      };
      writeUserSettingsFile(updated);
      return { success: true, ...getPmdg777SdkEulaAcceptance(updated) };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  function refreshRuntimeNetworkFromSettings(runtimeState, env = process.env) {
    const settings = getSettings();
    const next = { ...runtimeState };
    if (env.SIMBRIDGE_WS_PORT === undefined || String(env.SIMBRIDGE_WS_PORT).trim() === '') {
      next.backendWsPort = settings.wsPort;
    }
    if (env.HTTP_PORT === undefined || String(env.HTTP_PORT).trim() === '') {
      next.backendHttpPort = settings.httpPort;
    }
    return next;
  }

  return {
    acceptPmdg737SdkEula,
    acceptPmdg777SdkEula,
    getSettings,
    getPmdg737SdkEulaStatus,
    getPmdg777SdkEulaStatus,
    saveSettings,
    resetSettings,
    refreshRuntimeNetworkFromSettings,
    settingsFile,
  };
}

module.exports = {
  APP_DATA_DIR,
  USER_SETTINGS_FILE,
  LAUNCHER_SETTINGS_DEFAULTS,
  createSettingsStore,
};
