#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SCRATCH_DIR = '.tmp';

function getRepoScratchRoot() {
  return process.env.FF_REPO_SCRATCH_ROOT
    ? path.resolve(process.env.FF_REPO_SCRATCH_ROOT)
    : path.join(ROOT, DEFAULT_SCRATCH_DIR);
}

function getRepoScratchPath(...segments) {
  return path.join(getRepoScratchRoot(), ...segments);
}

function getRepoScratchAppData(name) {
  return getRepoScratchPath(name, 'AppData', 'Roaming');
}

function normalizedAbsolutePathKey(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertRegularScratchDirectory(targetPath, label) {
  const stat = fs.lstatSync(targetPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular directory: ${targetPath}`);
  }
  if (
    normalizedAbsolutePathKey(targetPath)
    !== normalizedAbsolutePathKey(fs.realpathSync(targetPath))
  ) {
    throw new Error(`${label} is a link, junction, or reparse point: ${targetPath}`);
  }
}

/**
 * Recreate one exact child of the configured repository scratch root.
 *
 * Release builds use this before invoking compilers so an ignored, persistent
 * build cache can never be mistaken for output produced by the current source.
 * Refuse redirected scratch paths instead of recursively deleting through them.
 */
function resetRepoScratchDirectory(name) {
  if (
    typeof name !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
    || name === '.'
    || name === '..'
  ) {
    throw new Error(`Invalid repository scratch directory name: ${String(name)}`);
  }

  const scratchRoot = path.resolve(getRepoScratchRoot());
  const targetPath = path.resolve(scratchRoot, name);
  if (
    normalizedAbsolutePathKey(path.dirname(targetPath))
    !== normalizedAbsolutePathKey(scratchRoot)
  ) {
    throw new Error(`Repository scratch directory escapes its root: ${targetPath}`);
  }

  if (!fs.existsSync(scratchRoot)) {
    fs.mkdirSync(scratchRoot, { recursive: true });
  }
  assertRegularScratchDirectory(scratchRoot, 'Repository scratch root');

  if (fs.existsSync(targetPath)) {
    assertRegularScratchDirectory(targetPath, 'Repository scratch build directory');
    fs.rmSync(targetPath, { recursive: true, force: true });
  }

  fs.mkdirSync(targetPath);
  assertRegularScratchDirectory(targetPath, 'Repository scratch build directory');
  return targetPath;
}

module.exports = {
  DEFAULT_SCRATCH_DIR,
  ROOT,
  getRepoScratchAppData,
  getRepoScratchPath,
  getRepoScratchRoot,
  resetRepoScratchDirectory,
};
