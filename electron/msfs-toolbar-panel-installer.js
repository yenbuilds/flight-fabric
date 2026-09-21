'use strict';

/**
 * Installs, updates and removes the FlightFabric MSFS 2024 toolbar package
 * in a simulator Community folder.
 *
 * Runs in the Electron main process only. The renderer supplies a detected
 * installation id; every path is resolved again here from the read-only MSFS
 * detector, so the renderer can never name a destination. Rules:
 *
 *  - only `msfs2024-store` / `msfs2024-steam` ids; MSFS 2020 is unsupported;
 *  - the target is exactly `<Community>/flightfabric-toolbar`;
 *  - nothing is replaced or removed unless its manifest carries the
 *    FlightFabric package identity; links and junctions are refused;
 *  - the new copy is staged in a mkdtemp directory inside the Community
 *    folder with the user's ports substituted and layout/manifest
 *    regenerated, the old copy is moved aside, and the staged copy is
 *    renamed into place; a failed commit restores the old copy;
 *  - the simulator must be restarted after any change.
 */

const fs = require('node:fs');
const path = require('node:path');
const contract = require('./msfs-toolbar-panel-package');
const { safeRemoveRootChildDirectorySync } = require('./safe-directory-removal');

const SUPPORTED_INSTALL_ID = /^msfs2024-(store|steam)$/;
const STAGING_PREFIX = '.flightfabric-toolbar-staging-';
const STAGED_PACKAGE_DIR = 'package';
const ROLLBACK_DIR = 'rollback';

const STATUS = Object.freeze({
  NOT_INSTALLED: 'not_installed',
  INSTALLED: 'installed',
  UPDATE_AVAILABLE: 'update_available',
  CONFIGURATION_UPDATE_REQUIRED: 'configuration_update_required',
  REPAIR_REQUIRED: 'repair_required',
  FOREIGN_PACKAGE: 'foreign_package',
});

class InstallerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'InstallerError';
    this.code = code || 'toolbar_installer_error';
  }
}

function normalizedPathKey(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isExactChild(parentDir, childPath) {
  return normalizedPathKey(path.dirname(childPath)) === normalizedPathKey(parentDir);
}

function lstatOrNull(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch {
    return null;
  }
}

function assertRegularDirectory(dirPath, label) {
  const stat = lstatOrNull(dirPath);
  if (!stat) throw new InstallerError(`${label} does not exist: ${dirPath}`, 'missing_directory');
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new InstallerError(`${label} is not a regular directory: ${dirPath}`, 'unsafe_directory');
  }
  let real;
  try {
    real = fs.realpathSync(dirPath);
  } catch {
    throw new InstallerError(`${label} could not be resolved: ${dirPath}`, 'unsafe_directory');
  }
  if (normalizedPathKey(real) !== normalizedPathKey(dirPath)) {
    throw new InstallerError(`${label} is a link, junction or reparse point: ${dirPath}`, 'unsafe_directory');
  }
}

/** Every entry under `dir` must be a regular file or directory (no links). */
function findLinksInTree(dir) {
  const problems = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      problems.push(`unreadable directory ${current}`);
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const stat = lstatOrNull(entryPath);
      if (!stat || stat.isSymbolicLink()) {
        problems.push(`link or unreadable entry ${entryPath}`);
        continue;
      }
      if (stat.isDirectory()) walk(entryPath);
      else if (!stat.isFile()) problems.push(`special entry ${entryPath}`);
    }
  };
  walk(dir);
  return problems;
}

function readJsonOrNull(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readTextOrNull(filePath, maxBytes = 65536) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function payloadPath(rootDir, relativePath) {
  return path.join(rootDir, ...relativePath.split('/'));
}

/**
 * Inspect a directory that may hold our package. Never throws for a
 * damaged package; ownership decides whether it may be touched at all.
 */
function inspectPackageDirectory(dir) {
  const stat = lstatOrNull(dir);
  if (!stat) return { present: false, owned: false, safe: false, problems: [], manifest: null, config: null };
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { present: true, owned: false, safe: false, problems: ['target is not a regular directory'], manifest: null, config: null };
  }
  const manifest = readJsonOrNull(path.join(dir, contract.MANIFEST_FILE));
  const owned = contract.isOwnedManifest(manifest);
  const problems = [];
  if (!owned) {
    return { present: true, owned: false, safe: false, problems: ['manifest does not identify the FlightFabric toolbar package'], manifest, config: null };
  }
  problems.push(...findLinksInTree(dir));
  for (const relativePath of contract.PACKAGE_PAYLOAD_FILES) {
    const fileStat = lstatOrNull(payloadPath(dir, relativePath));
    if (!fileStat || !fileStat.isFile()) problems.push(`missing ${relativePath}`);
  }
  const layout = readJsonOrNull(path.join(dir, contract.LAYOUT_FILE));
  if (!layout || !Array.isArray(layout.content)) {
    problems.push('layout.json is missing or invalid');
  } else {
    for (const entry of layout.content) {
      if (!entry || typeof entry.path !== 'string') continue;
      const fileStat = lstatOrNull(payloadPath(dir, entry.path));
      if (fileStat && fileStat.isFile() && fileStat.size !== entry.size) problems.push(`layout size mismatch for ${entry.path}`);
    }
  }
  const config = contract.parseConfigSource(readTextOrNull(payloadPath(dir, contract.CONFIG_FILE)));
  if (!config) problems.push('configuration script is missing or invalid');
  return {
    present: true,
    owned: true,
    safe: !problems.some((problem) => problem.startsWith('link')),
    problems,
    manifest,
    config,
  };
}

function classifyInstalled(inspection, expectedVersion, ports) {
  if (!inspection.present) return STATUS.NOT_INSTALLED;
  if (!inspection.owned) return STATUS.FOREIGN_PACKAGE;
  if (inspection.problems.length > 0) return STATUS.REPAIR_REQUIRED;
  const installedVersion = inspection.manifest && inspection.manifest.package_version;
  if (installedVersion !== expectedVersion || (inspection.config && inspection.config.packageVersion !== expectedVersion)) {
    return STATUS.UPDATE_AVAILABLE;
  }
  if (!inspection.config || inspection.config.httpPort !== ports.httpPort || inspection.config.wsPort !== ports.wsPort) {
    return STATUS.CONFIGURATION_UPDATE_REQUIRED;
  }
  return STATUS.INSTALLED;
}

function verifySource(sourceDir, expectedVersion) {
  assertRegularDirectory(sourceDir, 'Toolbar package source');
  const problems = [];
  for (const relativePath of contract.PACKAGE_PAYLOAD_FILES) {
    const stat = lstatOrNull(payloadPath(sourceDir, relativePath));
    if (!stat || !stat.isFile()) problems.push(`missing ${relativePath}`);
  }
  const manifest = readJsonOrNull(path.join(sourceDir, contract.MANIFEST_FILE));
  if (!contract.isOwnedManifest(manifest)) problems.push('manifest identity is wrong');
  else if (manifest.package_version !== expectedVersion) problems.push(`manifest version ${manifest.package_version} does not match app version ${expectedVersion}`);
  const configTemplate = readTextOrNull(payloadPath(sourceDir, contract.CONFIG_FILE));
  if (!configTemplate
      || !configTemplate.includes(contract.HTTP_PORT_PLACEHOLDER)
      || !configTemplate.includes(contract.WS_PORT_PLACEHOLDER)) {
    problems.push('configuration template is missing its port placeholders');
  }
  if (problems.length > 0) {
    throw new InstallerError(`Toolbar package source is incomplete: ${problems.join('; ')}`, 'source_invalid');
  }
  return { manifest, configTemplate };
}

/**
 * Write a configured copy of the source package into `stageDir`.
 * Only the contract payload files are copied; layout and manifest are
 * regenerated from what was actually written.
 */
function stagePackage(sourceDir, stageDir, { ports, packageVersion, configTemplate }) {
  fs.mkdirSync(stageDir, { recursive: false });
  for (const relativePath of contract.PACKAGE_PAYLOAD_FILES) {
    const destination = payloadPath(stageDir, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (relativePath === contract.CONFIG_FILE) {
      fs.writeFileSync(destination, contract.substituteConfigPorts(configTemplate, ports), 'utf8');
    } else {
      fs.copyFileSync(payloadPath(sourceDir, relativePath), destination, fs.constants.COPYFILE_EXCL);
    }
  }
  const entries = contract.PACKAGE_PAYLOAD_FILES.map((relativePath) => {
    const stat = fs.statSync(payloadPath(stageDir, relativePath));
    return { path: relativePath, size: stat.size, mtimeMs: stat.mtimeMs };
  });
  const layout = contract.buildLayout(entries);
  const totalPackageSize = entries.reduce((sum, entry) => sum + entry.size, 0);
  const manifest = contract.buildManifest({ packageVersion, totalPackageSize });
  fs.writeFileSync(path.join(stageDir, contract.LAYOUT_FILE), contract.serializeLayout(layout), 'utf8');
  fs.writeFileSync(path.join(stageDir, contract.MANIFEST_FILE), contract.serializeManifest(manifest), 'utf8');
  const check = inspectPackageDirectory(stageDir);
  if (!check.owned || check.problems.length > 0) {
    throw new InstallerError(`Staged toolbar package failed verification: ${check.problems.join('; ') || 'not owned'}`, 'staging_invalid');
  }
}

/**
 * @param {object} options
 * @param {() => Array<object>} options.detectInstalls  read-only MSFS detector
 * @param {() => string} options.resolveSourceDir        bundled package location
 * @param {() => { httpPort: number, wsPort: number }} options.getPorts
 * @param {string} options.packageVersion                app version the package must carry
 * @param {(...args: unknown[]) => void} [options.logger]
 * @param {(from: string, to: string) => void} [options.rename]  fs.renameSync override for tests
 */
function createToolbarPanelInstaller(options) {
  const {
    detectInstalls,
    resolveSourceDir,
    getPorts,
    packageVersion,
    logger = () => {},
    rename = (from, to) => fs.renameSync(from, to),
  } = options || {};
  if (typeof detectInstalls !== 'function') throw new TypeError('detectInstalls is required');
  if (typeof resolveSourceDir !== 'function') throw new TypeError('resolveSourceDir is required');
  if (typeof getPorts !== 'function') throw new TypeError('getPorts is required');
  if (!contract.isValidPackageVersion(packageVersion)) throw new TypeError('packageVersion must be MAJOR.MINOR.PATCH');

  function currentPorts() {
    return contract.assertPorts(getPorts());
  }

  function resolveInstall(installId) {
    if (typeof installId !== 'string' || !SUPPORTED_INSTALL_ID.test(installId)) {
      throw new InstallerError('Only MSFS 2024 Microsoft Store or Steam installations are supported.', 'unsupported_install');
    }
    const entry = (detectInstalls() || []).find((candidate) => candidate && candidate.id === installId);
    if (!entry || entry.found !== true) {
      throw new InstallerError('That MSFS 2024 installation was not found on this PC.', 'install_not_found');
    }
    return entry;
  }

  /**
   * Community folders for an install: the legacy `Community` folder first
   * (where MSFS 2024 mounts html_ui toolbar packages), then `Community2024`
   * as a fallback and as a place stray copies are cleaned up from.
   */
  function communityCandidates(entry) {
    const folders = [];
    for (const key of ['communityFolder', 'community2024Folder']) {
      const value = typeof entry[key] === 'string' && entry[key].trim() ? path.resolve(entry[key].trim()) : null;
      if (value && !folders.some((known) => normalizedPathKey(known) === normalizedPathKey(value))) folders.push(value);
    }
    return folders;
  }

  function targetIn(communityDir) {
    assertRegularDirectory(communityDir, 'Community folder');
    const target = path.resolve(communityDir, contract.PACKAGE_DIRECTORY_NAME);
    if (path.basename(target) !== contract.PACKAGE_DIRECTORY_NAME || !isExactChild(communityDir, target)) {
      throw new InstallerError('Toolbar package target resolved outside the Community folder.', 'unsafe_target');
    }
    return target;
  }

  function describeInstall(entry, ports) {
    const folders = communityCandidates(entry);
    const primary = folders[0] || null;
    let status = STATUS.NOT_INSTALLED;
    let inspection = null;
    let problems = [];
    const strayCopies = [];
    if (!primary) {
      return {
        installId: entry.id,
        label: entry.label,
        found: true,
        communityFolder: null,
        status: STATUS.NOT_INSTALLED,
        installedVersion: null,
        installedPorts: null,
        problems: ['No Community folder was found for this installation.'],
        canInstall: false,
        strayCopies,
      };
    }
    try {
      const target = targetIn(primary);
      inspection = inspectPackageDirectory(target);
      status = classifyInstalled(inspection, packageVersion, ports);
      problems = inspection.problems.slice();
    } catch (error) {
      status = STATUS.REPAIR_REQUIRED;
      problems = [error.message];
    }
    for (const folder of folders.slice(1)) {
      try {
        const stray = inspectPackageDirectory(targetIn(folder));
        if (stray.present) strayCopies.push({ folder, owned: stray.owned });
      } catch {
        // An unreadable secondary folder is reported by the install step if used.
      }
    }
    if (strayCopies.length > 0 && status === STATUS.INSTALLED) status = STATUS.UPDATE_AVAILABLE;
    return {
      installId: entry.id,
      label: entry.label,
      found: true,
      communityFolder: primary,
      status,
      installedVersion: inspection && inspection.manifest ? String(inspection.manifest.package_version || '') : null,
      installedPorts: inspection && inspection.config ? { httpPort: inspection.config.httpPort, wsPort: inspection.config.wsPort } : null,
      problems,
      canInstall: status !== STATUS.FOREIGN_PACKAGE,
      strayCopies,
    };
  }

  function getStatus() {
    let ports = null;
    let portsError = '';
    try {
      ports = currentPorts();
    } catch (error) {
      portsError = error.message;
    }
    let sourceError = '';
    try {
      verifySource(resolveSourceDir(), packageVersion);
    } catch (error) {
      sourceError = error.message;
    }
    const installs = [];
    for (const entry of detectInstalls() || []) {
      if (!entry || typeof entry.id !== 'string' || !SUPPORTED_INSTALL_ID.test(entry.id)) continue;
      if (entry.found !== true) {
        installs.push({
          installId: entry.id,
          label: entry.label,
          found: false,
          communityFolder: null,
          status: STATUS.NOT_INSTALLED,
          installedVersion: null,
          installedPorts: null,
          problems: [],
          canInstall: false,
          strayCopies: [],
        });
        continue;
      }
      installs.push(describeInstall(entry, ports || { httpPort: null, wsPort: null }));
    }
    return {
      ok: !portsError && !sourceError,
      packageVersion,
      ports,
      error: portsError || sourceError || '',
      installs,
    };
  }

  function removeOwnedPackage(communityDir, operation) {
    const target = targetIn(communityDir);
    const inspection = inspectPackageDirectory(target);
    if (!inspection.present) return false;
    if (!inspection.owned) {
      throw new InstallerError(`A different package already uses ${target}. It was left untouched.`, 'foreign_package');
    }
    if (!inspection.safe) {
      throw new InstallerError(`The package at ${target} contains links or junctions and was left untouched.`, 'unsafe_package');
    }
    return safeRemoveRootChildDirectorySync({
      rootDir: communityDir,
      childName: contract.PACKAGE_DIRECTORY_NAME,
      allowedChildNames: [contract.PACKAGE_DIRECTORY_NAME],
      operation,
    });
  }

  function removeStagingDir(communityDir, stagingDir) {
    safeRemoveRootChildDirectorySync({
      rootDir: communityDir,
      childName: path.basename(stagingDir),
      allowedChildNames: [path.basename(stagingDir)],
      operation: 'removeToolbarStaging',
    });
  }

  function install(installId) {
    const entry = resolveInstall(installId);
    const ports = currentPorts();
    const sourceDir = resolveSourceDir();
    const { configTemplate } = verifySource(sourceDir, packageVersion);
    const folders = communityCandidates(entry);
    if (folders.length === 0) {
      throw new InstallerError('No Community folder was found for this installation.', 'community_missing');
    }
    const communityDir = folders[0];
    const target = targetIn(communityDir);

    const existing = inspectPackageDirectory(target);
    if (existing.present && !existing.owned) {
      throw new InstallerError(`A different package already uses ${target}. It was left untouched.`, 'foreign_package');
    }
    if (existing.present && !existing.safe) {
      throw new InstallerError(`The existing package at ${target} contains links or junctions and was left untouched.`, 'unsafe_package');
    }
    for (const folder of folders.slice(1)) {
      const stray = inspectPackageDirectory(targetIn(folder));
      if (stray.present && !stray.owned) {
        throw new InstallerError(`A different package uses ${path.join(folder, contract.PACKAGE_DIRECTORY_NAME)}. It was left untouched.`, 'foreign_package');
      }
    }

    const stagingDir = fs.mkdtempSync(path.join(communityDir, STAGING_PREFIX));
    const stagedPackage = path.join(stagingDir, STAGED_PACKAGE_DIR);
    const rollbackCopy = path.join(stagingDir, ROLLBACK_DIR);
    let movedAside = false;
    let committed = false;
    try {
      stagePackage(sourceDir, stagedPackage, { ports, packageVersion, configTemplate });
      if (existing.present) {
        rename(target, rollbackCopy);
        movedAside = true;
      }
      rename(stagedPackage, target);
      committed = true;
    } catch (error) {
      if (movedAside && !committed) {
        try {
          rename(rollbackCopy, target);
          movedAside = false;
        } catch (restoreError) {
          logger('Toolbar package rollback failed:', restoreError && restoreError.message);
          throw new InstallerError(
            `Installing failed and the previous copy could not be restored. It is kept at ${rollbackCopy}. ${error.message}`,
            'rollback_failed',
          );
        }
      }
      try {
        removeStagingDir(communityDir, stagingDir);
      } catch (cleanupError) {
        logger('Toolbar staging cleanup failed:', cleanupError && cleanupError.message);
      }
      throw error instanceof InstallerError ? error : new InstallerError(`Installing the toolbar package failed: ${error.message}`, 'install_failed');
    }

    const cleanupErrors = [];
    try {
      removeStagingDir(communityDir, stagingDir);
    } catch (cleanupError) {
      logger('Toolbar staging cleanup failed after commit:', cleanupError && cleanupError.message);
      cleanupErrors.push(`Temporary toolbar files remain at ${stagingDir}. Close MSFS before removing that temporary folder. ${cleanupError.message || ''}`);
    }
    for (const folder of folders.slice(1)) {
      try {
        removeOwnedPackage(folder, 'removeToolbarStrayCopy');
      } catch (strayError) {
        logger('Toolbar stray copy cleanup failed:', strayError && strayError.message);
        cleanupErrors.push(`An old toolbar copy could not be removed. Close MSFS and retry the installation. ${strayError.message || ''}`);
      }
    }
    const verification = inspectPackageDirectory(target);
    if (cleanupErrors.length) {
      // The primary copy is already committed. Keep it and surface the partial
      // result so the UI does not announce success while old files remain.
      return {
        ok: false,
        code: 'cleanup_incomplete',
        error: `Toolbar files were installed, but cleanup did not finish. ${cleanupErrors.join(' ')}`,
        installedPath: target,
        restartRequired: true,
      };
    }
    return {
      ok: true,
      status: classifyInstalled(verification, packageVersion, ports),
      installedPath: target,
      restartRequired: true,
    };
  }

  function uninstall(installId) {
    const entry = resolveInstall(installId);
    let removed = false;
    for (const folder of communityCandidates(entry)) {
      if (removeOwnedPackage(folder, 'removeToolbarPackage')) removed = true;
    }
    return { ok: true, removed, restartRequired: removed };
  }

  function guarded(operation) {
    return (...args) => {
      try {
        return operation(...args);
      } catch (error) {
        logger('Toolbar installer error:', error && error.message);
        return {
          ok: false,
          error: error && error.message ? error.message : 'Toolbar installer failed.',
          code: error && error.code ? error.code : 'toolbar_installer_error',
        };
      }
    };
  }

  return {
    getStatus: guarded(getStatus),
    install: guarded(install),
    uninstall: guarded(uninstall),
  };
}

module.exports = {
  STATUS,
  SUPPORTED_INSTALL_ID,
  createToolbarPanelInstaller,
  inspectPackageDirectory,
};
