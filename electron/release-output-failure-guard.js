'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  safeRemoveRootChildDirectorySync,
} = require('./safe-directory-removal');

const PUBLISHABLE_FILE_PATTERN = /\.(?:exe|blockmap|ya?ml)$/i;
const CHECKSUM_FILE_PATTERN = /^SHA256SUMS(?:\.txt)?$/i;

function normalizedPathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertSafeRegularDirectory(dirPath, label) {
  const stat = fs.lstatSync(dirPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a safe regular directory: ${dirPath}`);
  }
  if (normalizedPathKey(dirPath) !== normalizedPathKey(fs.realpathSync(dirPath))) {
    throw new Error(`${label} is a link, junction, or reparse point: ${dirPath}`);
  }
}

function assertSafeRegularFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a safe regular file: ${filePath}`);
  }
  if (normalizedPathKey(filePath) !== normalizedPathKey(fs.realpathSync(filePath))) {
    throw new Error(`${label} is a link or reparse-point entry: ${filePath}`);
  }
}

/**
 * Remove only canonical artifacts that a user could launch or publish. Other
 * diagnostics stay available for investigating the failed build.
 */
function invalidateElectronOutputArtifacts(outputDir) {
  if (!fs.existsSync(outputDir)) return [];
  assertSafeRegularDirectory(outputDir, 'Electron output directory');

  const removed = [];
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    const entryPath = path.join(outputDir, entry.name);
    if (entry.name === 'win-unpacked') {
      assertSafeRegularDirectory(entryPath, 'Electron unpacked output directory');
      safeRemoveRootChildDirectorySync({
        allowedChildNames: ['win-unpacked'],
        childName: entry.name,
        operation: 'Electron output invalidation',
        rootDir: outputDir,
      });
      if (fs.existsSync(entryPath)) {
        throw new Error(`Could not invalidate incomplete Electron output: ${entryPath}`);
      }
      removed.push(entry.name);
      continue;
    }

    if (!PUBLISHABLE_FILE_PATTERN.test(entry.name) && !CHECKSUM_FILE_PATTERN.test(entry.name)) {
      continue;
    }
    assertSafeRegularFile(entryPath, 'Electron release artifact');
    fs.unlinkSync(entryPath);
    removed.push(entry.name);
  }
  return removed;
}

function installElectronOutputFailureGuard(outputDir, options = {}) {
  const processRef = options.processRef || process;
  const reportError = options.reportError || (() => {});
  let armed = true;

  const onExit = () => {
    if (!armed) return;
    try {
      invalidateElectronOutputArtifacts(outputDir);
    } catch (error) {
      reportError(error);
    }
  };
  processRef.once('exit', onExit);

  return {
    disarm() {
      armed = false;
      processRef.removeListener('exit', onExit);
    },
  };
}

module.exports = {
  installElectronOutputFailureGuard,
  invalidateElectronOutputArtifacts,
};
