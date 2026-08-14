'use strict';

const fs = require('node:fs');
const path = require('node:path');

function normalizedPathKey(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(rootDir, targetPath) {
  const root = normalizedPathKey(rootDir);
  const target = normalizedPathKey(targetPath);
  const relative = path.relative(root, target);
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function refuse(operation, reason) {
  const error = new Error(`${operation} refused: ${reason}`);
  error.code = 'FF_SAFE_FS_REFUSED';
  throw error;
}

function assertSafeRegularDirectory(dirPath, operation, label) {
  const stat = fs.lstatSync(dirPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    refuse(operation, `${label} is not a safe regular directory: ${dirPath}`);
  }
  if (normalizedPathKey(dirPath) !== normalizedPathKey(fs.realpathSync(dirPath))) {
    refuse(operation, `${label} is a link, junction, or reparse point: ${dirPath}`);
  }
}

function removeSafeTreeEntry(rootDir, entryPath, operation) {
  const resolvedEntry = path.resolve(entryPath);
  if (!isPathInside(rootDir, resolvedEntry)) {
    refuse(operation, `tree entry is outside the allowed root: ${resolvedEntry}`);
  }

  const stat = fs.lstatSync(resolvedEntry);
  if (stat.isSymbolicLink()) {
    refuse(operation, `tree entry is a symbolic link: ${resolvedEntry}`);
  }

  const realEntry = fs.realpathSync(resolvedEntry);
  if (
    normalizedPathKey(realEntry) !== normalizedPathKey(resolvedEntry)
    || !isPathInside(rootDir, realEntry)
  ) {
    refuse(operation, `tree entry is a link, junction, or reparse point: ${resolvedEntry}`);
  }

  if (stat.isDirectory()) {
    for (const childName of fs.readdirSync(resolvedEntry)) {
      removeSafeTreeEntry(rootDir, path.join(resolvedEntry, childName), operation);
    }
    fs.rmdirSync(resolvedEntry);
    return;
  }

  if (stat.isFile()) {
    fs.unlinkSync(resolvedEntry);
    return;
  }

  refuse(operation, `tree entry is not a regular file or directory: ${resolvedEntry}`);
}

/**
 * Remove one explicitly allowlisted direct child of a trusted directory.
 *
 * Every descendant must remain a regular file or directory physically inside
 * the root. Links, junctions, reparse points, and special filesystem entries
 * are refused instead of traversed.
 */
function safeRemoveRootChildDirectorySync(options) {
  const {
    allowedChildNames = [],
    childName,
    operation,
    rootDir,
  } = options || {};

  if (!operation || typeof operation !== 'string') {
    refuse('Safe directory removal', 'missing operation name');
  }
  if (!rootDir || typeof rootDir !== 'string') {
    refuse(operation, 'missing allowed root directory');
  }
  if (
    !childName
    || typeof childName !== 'string'
    || path.basename(childName) !== childName
    || childName === '.'
    || childName === '..'
  ) {
    refuse(operation, `invalid root child name: ${String(childName)}`);
  }
  if (!allowedChildNames.includes(childName)) {
    refuse(operation, `root child name is not allowlisted: ${childName}`);
  }

  const resolvedRoot = path.resolve(rootDir);
  assertSafeRegularDirectory(resolvedRoot, operation, 'allowed root directory');

  const targetPath = path.resolve(resolvedRoot, childName);
  if (
    normalizedPathKey(path.dirname(targetPath)) !== normalizedPathKey(resolvedRoot)
    || !isPathInside(resolvedRoot, targetPath)
  ) {
    refuse(operation, `target is not an exact child of the allowed root: ${targetPath}`);
  }
  if (!fs.existsSync(targetPath)) return false;

  assertSafeRegularDirectory(targetPath, operation, 'target directory');
  removeSafeTreeEntry(resolvedRoot, targetPath, operation);
  if (fs.existsSync(targetPath)) {
    throw new Error(`${operation} failed to remove target directory: ${targetPath}`);
  }
  return true;
}

module.exports = {
  safeRemoveRootChildDirectorySync,
};
