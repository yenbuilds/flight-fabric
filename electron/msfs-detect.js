/**
 * MSFS Install Detection Utility
 *
 * Scans a hardcoded set of well-known Windows paths for MSFS 2020 / 2024
 * installations. This is a read-only, non-recursive probe — it only checks
 * specific paths known to exist for each install variant and reads one
 * config file (UserCfg.opt) per candidate.
 *
 * Safety guarantees:
 *  - Only checks a fixed list of known paths. No filesystem traversal.
 *  - Reads a single known config file per candidate; all errors are swallowed.
 *  - Any path extracted from UserCfg.opt is validated (absolute, normalized,
 *    no path-traversal sequences) before use.
 *  - No writes, no spawned processes, no network calls.
 *  - Returns gracefully if env vars or paths are absent.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Known MSFS install candidates.
 * Each entry describes one edition and provides a function that resolves the
 * expected LocalCache directory using environment variables.  The functions
 * are lazy so callers can unit-test with injected env.
 */
const INSTALL_CANDIDATES = [
  {
    id: 'msfs2020-store',
    label: 'MSFS 2020 — Microsoft Store',
    localCache: (env) =>
      env.LOCALAPPDATA
        ? path.join(env.LOCALAPPDATA, 'Packages', 'Microsoft.FlightSimulator_8wekyb3d8bbwe', 'LocalCache')
        : null,
  },
  {
    id: 'msfs2020-steam',
    label: 'MSFS 2020 — Steam',
    localCache: (env) =>
      env.APPDATA
        ? path.join(env.APPDATA, 'Microsoft Flight Simulator')
        : null,
  },
  {
    id: 'msfs2024-store',
    label: 'MSFS 2024 — Microsoft Store',
    localCache: (env) =>
      env.LOCALAPPDATA
        ? path.join(env.LOCALAPPDATA, 'Packages', 'Microsoft.Limitless_8wekyb3d8bbwe', 'LocalCache')
        : null,
  },
  {
    id: 'msfs2024-steam',
    label: 'MSFS 2024 — Steam',
    localCache: (env) =>
      env.APPDATA
        ? path.join(env.APPDATA, 'Microsoft Flight Simulator 2024')
        : null,
  },
];

/**
 * Safely parse InstalledPackagesPath out of UserCfg.opt.
 * Returns an absolute normalized path string, or null if unavailable.
 *
 * @param {string} localCachePath
 * @returns {string|null}
 */
function parseUserCfgPackagesPath(localCachePath) {
  const cfgPath = path.join(localCachePath, 'UserCfg.opt');
  try {
    if (!fs.existsSync(cfgPath)) return null;

    // Read only the first 64 KB to avoid memory pressure on unexpected files.
    const fd = fs.openSync(cfgPath, 'r');
    const buf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const content = buf.toString('utf8', 0, bytesRead);

    // Line format: InstalledPackagesPath "C:\Some\Path"
    const match = content.match(/^InstalledPackagesPath\s+"([^"]+)"/m);
    if (!match || !match[1]) return null;

    const raw = match[1].trim();
    if (!path.isAbsolute(raw)) return null;

    const normalized = path.normalize(raw);
    // Reject anything that escaped to a drive root or contains suspicious sequences.
    if (normalized.length < 4) return null;

    return normalized;
  } catch {
    return null;
  }
}

/**
 * Safely test whether a path exists on disk.
 * Returns false on any error (permissions, etc.).
 *
 * @param {string} p
 * @returns {boolean}
 */
function safeExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Detect all MSFS installs present on this machine.
 *
 * @param {NodeJS.ProcessEnv} [env]  — defaults to process.env; injectable for testing
 * @returns {Array<{
 *   id: string,
 *   label: string,
 *   found: boolean,
 *   localCache: string|null,
 *   packagesFolder: string|null,
 *   communityFolder: string|null,
 *   community2024Folder: string|null,
 *   preferredCommunityFolder: string|null,
 *   officialFolder: string|null,
 * }>}
 */
function detectMsfsInstalls(env) {
  const resolvedEnv = env || process.env;
  const results = [];

  for (const candidate of INSTALL_CANDIDATES) {
    const localCache = candidate.localCache(resolvedEnv);

    if (!localCache) {
      results.push({
        id: candidate.id,
        label: candidate.label,
        found: false,
        localCache: null,
        packagesFolder: null,
        communityFolder: null,
        community2024Folder: null,
        preferredCommunityFolder: null,
        officialFolder: null,
      });
      continue;
    }

    const found = safeExists(localCache);

    let packagesFolder = null;
    let communityFolder = null;
    let community2024Folder = null;
    let preferredCommunityFolder = null;
    let officialFolder = null;

    if (found) {
      // Prefer the path declared in UserCfg.opt (custom install locations).
      const cfgPackages = parseUserCfgPackagesPath(localCache);
      if (cfgPackages && safeExists(cfgPackages)) {
        packagesFolder = cfgPackages;
      } else {
        // Fall back to the default inline Packages subfolder.
        const defaultPackages = path.join(localCache, 'Packages');
        if (safeExists(defaultPackages)) {
          packagesFolder = defaultPackages;
        }
      }

      if (packagesFolder) {
        const community = path.join(packagesFolder, 'Community');
        if (safeExists(community)) communityFolder = community;

        const community2024 = path.join(packagesFolder, 'Community2024');
        if (safeExists(community2024)) community2024Folder = community2024;

        // Native MSFS 2024 packages belong in Community2024. Retain Community
        // as a compatibility fallback for older 2024 folder layouts.
        preferredCommunityFolder = candidate.id.startsWith('msfs2024-')
          ? (community2024Folder || communityFolder)
          : communityFolder;

        const official = path.join(packagesFolder, 'Official');
        if (safeExists(official)) officialFolder = official;
      }
    }

    results.push({
      id: candidate.id,
      label: candidate.label,
      found,
      localCache,
      packagesFolder,
      communityFolder,
      community2024Folder,
      preferredCommunityFolder,
      officialFolder,
    });
  }

  return results;
}

module.exports = { detectMsfsInstalls };
