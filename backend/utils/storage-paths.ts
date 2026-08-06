'use strict';

const childProcess = require('child_process') as typeof import('child_process');
const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;
type ResolveOptions = {
  env?: EnvLike;
};

const APP_NAME = 'Flight Fabric';
const DOCUMENTS_APP_DIR_NAME = 'Flight Fabric';
const FLIGHT_LOGS_DIR_NAME = 'Flight Logs';
const SETTINGS_DIR_NAME = 'Settings';
const SETTINGS_FILE_NAME = 'settings.json';
const PROFILES_DIR_NAME = 'Profiles';
const AIRCRAFT_PROFILES_DIR_NAME = 'Aircraft';
const BUNDLED_PROFILES_DIR_NAME = 'Bundled';
const LOCAL_PROFILES_DIR_NAME = 'Local';
const SDK_CONNECTORS_DIR_NAME = 'SDK Connectors';
const LOCAL_SDK_CONNECTORS_DIR_NAME = 'Local';
const COMMUNITY_SDK_CONNECTORS_DIR_NAME = 'Community';
const COMMUNITY_SDK_CONNECTOR_INSTALL_META_DIR_NAME = '.remote-meta';
const AUDIO_DIR_NAME = 'Audio';
const CABIN_ANNOUNCEMENTS_DIR_NAME = 'Cabin';
const THEMES_DIR_NAME = 'Themes';
const LOGBOOK_FILE_NAME = 'logbook.json';
const DESTINATION_TARGET_FILE_NAME = 'destination-target.json';
const ORIGIN_TARGET_FILE_NAME = 'origin-target.json';
const APP_DATA_MARKER_FILE_NAME = '.flight-fabric-data.json';
const USER_ID_FILE_NAME = '.msfs-telemetry-user-id';

function getHomeDir(env: EnvLike = process.env): string {
  return env.USERPROFILE || env.HOME || os.homedir();
}

function normalizeForCompare(targetPath: unknown): string | null {
  if (!targetPath || typeof targetPath !== 'string') return null;
  const normalized = path.normalize(targetPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathsEqual(a: unknown, b: unknown): boolean {
  const left = normalizeForCompare(a);
  const right = normalizeForCompare(b);
  return Boolean(left && right && left === right);
}

function isDirectory(dirPath: string | null | undefined): boolean {
  if (!dirPath) return false;
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function isFile(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function ensureDirExists(dirPath: string | null | undefined): string | null | undefined {
  if (!dirPath) return dirPath;
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

function getAppDataBaseDir(env: EnvLike = process.env): string {
  const homeDir = getHomeDir(env);

  if (process.platform === 'win32') {
    return env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support');
  }
  return env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
}

function getAppDataRoot(env: EnvLike = process.env): string {
  return path.join(getAppDataBaseDir(env), APP_NAME);
}

function getAppDataMarkerFilePath(env: EnvLike = process.env): string {
  return path.join(getAppDataRoot(env), APP_DATA_MARKER_FILE_NAME);
}

function resolveAppDataMarkerFilePath(options: ResolveOptions = {}): string {
  const env = options.env || process.env;
  return getAppDataMarkerFilePath(env);
}

function getSettingsDir(env: EnvLike = process.env): string {
  return path.join(getAppDataRoot(env), SETTINGS_DIR_NAME);
}

function getSettingsFilePath(env: EnvLike = process.env): string {
  return path.join(getSettingsDir(env), SETTINGS_FILE_NAME);
}

function resolveSettingsFilePath(options: ResolveOptions = {}): string {
  const env = options.env || process.env;
  return getSettingsFilePath(env);
}

function getProfilesRootDir(env: EnvLike = process.env): string {
  return path.join(getAppDataRoot(env), PROFILES_DIR_NAME);
}

function getAircraftProfilesDir(env: EnvLike = process.env): string {
  return path.join(getProfilesRootDir(env), AIRCRAFT_PROFILES_DIR_NAME);
}

function resolveAircraftProfilesDir(options: ResolveOptions = {}): string {
  const env = options.env || process.env;
  return getAircraftProfilesDir(env);
}

function getBundledProfilesDir(env: EnvLike = process.env): string {
  return path.join(getProfilesRootDir(env), AIRCRAFT_PROFILES_DIR_NAME, BUNDLED_PROFILES_DIR_NAME);
}

function resolveBundledProfilesDir(options: ResolveOptions = {}): string {
  const env = options.env || process.env;
  return getBundledProfilesDir(env);
}

function getLocalProfilesDir(env: EnvLike = process.env): string {
  return path.join(getProfilesRootDir(env), AIRCRAFT_PROFILES_DIR_NAME, LOCAL_PROFILES_DIR_NAME);
}

function resolveLocalProfilesDir(options: ResolveOptions = {}): string {
  const env = options.env || process.env;
  return getLocalProfilesDir(env);
}

function getAircraftProfilesNamespaceDir(namespace: unknown, env: EnvLike = process.env): string {
  switch (String(namespace || '').trim().toLowerCase()) {
    case 'bundled':
      return getBundledProfilesDir(env);
    case 'local':
      return getLocalProfilesDir(env);
    default:
      return getAircraftProfilesDir(env);
  }
}

function getAircraftProfilesSimulatorDir(namespace: unknown, simulator: unknown, env: EnvLike = process.env): string {
  const namespaceDir = getAircraftProfilesNamespaceDir(namespace, env);
  if (!namespaceDir) return namespaceDir;
  const normalizedSimulator = String(simulator || '').trim().toLowerCase();
  if (!normalizedSimulator) return namespaceDir;
  return path.join(namespaceDir, normalizedSimulator);
}

function getSdkConnectorsRootDir(env: EnvLike = process.env): string {
  return path.join(getAppDataRoot(env), SDK_CONNECTORS_DIR_NAME);
}

function getLocalSdkConnectorsDir(env: EnvLike = process.env): string {
  return path.join(getSdkConnectorsRootDir(env), LOCAL_SDK_CONNECTORS_DIR_NAME);
}

function getCommunitySdkConnectorsDir(env: EnvLike = process.env): string {
  return path.join(getSdkConnectorsRootDir(env), COMMUNITY_SDK_CONNECTORS_DIR_NAME);
}

function getCommunitySdkConnectorsRemoteMetaDir(env: EnvLike = process.env): string {
  return path.join(getCommunitySdkConnectorsDir(env), COMMUNITY_SDK_CONNECTOR_INSTALL_META_DIR_NAME);
}

function getAudioAssetsRootDir(env: EnvLike = process.env): string {
  return path.join(getAppDataRoot(env), AUDIO_DIR_NAME);
}

function getCabinAnnouncementAudioDir(env: EnvLike = process.env): string {
  return path.join(getAudioAssetsRootDir(env), CABIN_ANNOUNCEMENTS_DIR_NAME);
}

function getThemesDir(env: EnvLike = process.env): string {
  return path.join(getAppDataRoot(env), THEMES_DIR_NAME);
}

function resolveThemesDir(options: ResolveOptions = {}): string {
  const env = options.env || process.env;
  return getThemesDir(env);
}

function getLogbookFilePath(env: EnvLike = process.env): string {
  return path.join(getAppDataRoot(env), LOGBOOK_FILE_NAME);
}

function resolveLogbookFilePath(options: ResolveOptions = {}): string {
  const env = options.env || process.env;
  return getLogbookFilePath(env);
}

function getDestinationTargetFilePath(env: EnvLike = process.env): string {
  return path.join(getAppDataRoot(env), DESTINATION_TARGET_FILE_NAME);
}

function resolveDestinationTargetFilePath(options: ResolveOptions = {}): string {
  const env = options.env || process.env;
  return getDestinationTargetFilePath(env);
}

function getOriginTargetFilePath(env: EnvLike = process.env): string {
  return path.join(getAppDataRoot(env), ORIGIN_TARGET_FILE_NAME);
}

function resolveOriginTargetFilePath(options: ResolveOptions = {}): string {
  const env = options.env || process.env;
  return getOriginTargetFilePath(env);
}

function getUserIdFilePath(env: EnvLike = process.env): string {
  return path.join(getAppDataRoot(env), USER_ID_FILE_NAME);
}

function resolveUserIdFilePath(options: ResolveOptions = {}): string {
  const env = options.env || process.env;
  return getUserIdFilePath(env);
}

function expandWindowsEnvTokens(rawPath: unknown, env: EnvLike = process.env): string | null {
  if (!rawPath || typeof rawPath !== 'string') return null;
  return rawPath.replace(/%([^%]+)%/g, (_, key: string) => env[key] || `%${key}%`);
}

function getWindowsKnownDocumentsDir(env: EnvLike = process.env): string | null {
  if (process.platform !== 'win32') return null;
  if (env.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS === '1') return null;

  try {
    const output = childProcess.execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders" /v Personal',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const line = output
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith('Personal'));
    if (!line) return null;

    const parts = line.split(/\s{2,}/).filter(Boolean);
    const rawDocumentsPath = parts.length >= 3 ? parts[2] : null;
    if (!rawDocumentsPath) return null;

    const expandedPath = expandWindowsEnvTokens(rawDocumentsPath, env);
    return expandedPath ? path.normalize(expandedPath) : null;
  } catch {
    return null;
  }
}

function dedupePaths(pathsToCheck: unknown[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const targetPath of pathsToCheck) {
    if (!targetPath || typeof targetPath !== 'string') continue;
    const normalized = path.normalize(targetPath);
    const key = normalizeForCompare(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }

  return deduped;
}

function getDocumentsDirCandidates(env: EnvLike = process.env): string[] {
  const homeDir = getHomeDir(env);
  const candidates: Array<string | null | undefined> = [
    getWindowsKnownDocumentsDir(env),
    env.USERPROFILE ? path.join(env.USERPROFILE, 'Documents') : null,
    env.HOME ? path.join(env.HOME, 'Documents') : null,
    homeDir ? path.join(homeDir, 'Documents') : null,
    env.OneDrive ? path.join(env.OneDrive, 'Documents') : null,
    env.ONEDRIVE ? path.join(env.ONEDRIVE, 'Documents') : null,
    env.OneDriveConsumer ? path.join(env.OneDriveConsumer, 'Documents') : null,
    env.OneDriveCommercial ? path.join(env.OneDriveCommercial, 'Documents') : null,
  ];

  if (process.platform === 'win32' && homeDir) {
    try {
      const entries = fs.readdirSync(homeDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.toLowerCase().startsWith('onedrive')) continue;
        candidates.push(path.join(homeDir, entry.name, 'Documents'));
      }
    } catch {
      // Best-effort only.
    }
  }

  return dedupePaths(candidates);
}

const storagePathsApi = {
  AIRCRAFT_PROFILES_DIR_NAME,
  APP_DATA_MARKER_FILE_NAME,
  APP_NAME,
  AUDIO_DIR_NAME,
  CABIN_ANNOUNCEMENTS_DIR_NAME,
  COMMUNITY_SDK_CONNECTOR_INSTALL_META_DIR_NAME,
  COMMUNITY_SDK_CONNECTORS_DIR_NAME,
  DESTINATION_TARGET_FILE_NAME,
  DOCUMENTS_APP_DIR_NAME,
  FLIGHT_LOGS_DIR_NAME,
  LOCAL_PROFILES_DIR_NAME,
  LOCAL_SDK_CONNECTORS_DIR_NAME,
  LOGBOOK_FILE_NAME,
  BUNDLED_PROFILES_DIR_NAME,
  ORIGIN_TARGET_FILE_NAME,
  PROFILES_DIR_NAME,
  SETTINGS_DIR_NAME,
  SETTINGS_FILE_NAME,
  SDK_CONNECTORS_DIR_NAME,
  THEMES_DIR_NAME,
  USER_ID_FILE_NAME,
  dedupePaths,
  ensureDirExists,
  getAircraftProfilesDir,
  getAircraftProfilesNamespaceDir,
  getAircraftProfilesSimulatorDir,
  getAppDataBaseDir,
  getAppDataMarkerFilePath,
  getAppDataRoot,
  getAudioAssetsRootDir,
  getCabinAnnouncementAudioDir,
  getCommunitySdkConnectorsDir,
  getCommunitySdkConnectorsRemoteMetaDir,
  getDestinationTargetFilePath,
  getDocumentsDirCandidates,
  getHomeDir,
  getLocalProfilesDir,
  getLocalSdkConnectorsDir,
  getLogbookFilePath,
  getBundledProfilesDir,
  getOriginTargetFilePath,
  getProfilesRootDir,
  getSettingsDir,
  getSettingsFilePath,
  getSdkConnectorsRootDir,
  getThemesDir,
  getUserIdFilePath,
  isDirectory,
  isFile,
  pathsEqual,
  resolveAppDataMarkerFilePath,
  resolveAircraftProfilesDir,
  resolveDestinationTargetFilePath,
  resolveLocalProfilesDir,
  resolveLogbookFilePath,
  resolveBundledProfilesDir,
  resolveOriginTargetFilePath,
  resolveSettingsFilePath,
  resolveThemesDir,
  resolveUserIdFilePath,
};

module.exports = storagePathsApi;

export {};
