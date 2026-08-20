'use strict';

const fs = require('fs');
const path = require('path');

const PMDG_737_PACKAGE_DIRS = Object.freeze([
  'pmdg-aircraft-736',
  'pmdg-aircraft-737',
  'pmdg-aircraft-738',
  'pmdg-aircraft-739',
]);
const PMDG_737_SDK_EULA_RELATIVE_PATH = Object.freeze([
  'Documentation',
  'SDK',
  'PMDG_737_MSFS_SDK.pdf',
]);

function isPathInsideOrEqual(parentDir, childPath) {
  const resolvedParent = path.resolve(parentDir);
  const resolvedChild = path.resolve(childPath);
  if (resolvedChild === resolvedParent) return true;
  const relative = path.relative(resolvedParent, resolvedChild);
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function uniqueCommunityFolders(installs) {
  const seen = new Set();
  const folders = [];
  for (const install of Array.isArray(installs) ? installs : []) {
    for (const candidate of [
      install?.preferredCommunityFolder,
      install?.community2024Folder,
      install?.communityFolder,
    ]) {
      if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
      const resolved = path.resolve(candidate);
      const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      if (seen.has(key)) continue;
      seen.add(key);
      folders.push(resolved);
    }
  }
  return folders;
}

function resolvePmdg737SdkEulaPath(installs, fsImpl = fs) {
  for (const communityFolder of uniqueCommunityFolders(installs)) {
    for (const packageDir of PMDG_737_PACKAGE_DIRS) {
      const candidate = path.join(
        communityFolder,
        packageDir,
        ...PMDG_737_SDK_EULA_RELATIVE_PATH,
      );
      if (!isPathInsideOrEqual(communityFolder, candidate)) continue;
      try {
        if (!fsImpl.existsSync(candidate) || !fsImpl.statSync(candidate).isFile()) continue;
        const realCommunity = fsImpl.realpathSync.native
          ? fsImpl.realpathSync.native(communityFolder)
          : fsImpl.realpathSync(communityFolder);
        const realCandidate = fsImpl.realpathSync.native
          ? fsImpl.realpathSync.native(candidate)
          : fsImpl.realpathSync(candidate);
        if (isPathInsideOrEqual(realCommunity, realCandidate)) return realCandidate;
      } catch {}
    }
  }
  return null;
}

module.exports = {
  PMDG_737_PACKAGE_DIRS,
  PMDG_737_SDK_EULA_RELATIVE_PATH,
  resolvePmdg737SdkEulaPath,
};
