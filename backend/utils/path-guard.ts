/**
 * Shared path-containment helpers.
 *
 * Use these instead of string-prefix checks when validating that a resolved file
 * path stays inside an allowed directory. Windows paths are case-insensitive, so
 * containment comparisons must normalize case there before calling
 * `path.relative()`.
 */
'use strict';

const path = require('path') as typeof import('path');

type ContainmentOptions = {
  allowEqual?: boolean;
};

function comparePathForContainment(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(parentDir: string | null | undefined, childPath: string | null | undefined, options: ContainmentOptions = {}): boolean {
  if (!parentDir || !childPath) return false;
  const parent = comparePathForContainment(parentDir);
  const child = comparePathForContainment(childPath);
  if (options.allowEqual && child === parent) return true;

  const relative = path.relative(parent, child);
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveWithinRoot(rootDir: string | null | undefined, relativePath: string, options: ContainmentOptions = { allowEqual: true }): string | null {
  if (!rootDir || typeof relativePath !== 'string') return null;
  const resolvedRoot = path.resolve(rootDir);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (!isPathInside(resolvedRoot, resolvedPath, { allowEqual: options.allowEqual !== false })) {
    return null;
  }
  return resolvedPath;
}

module.exports = {
  comparePathForContainment,
  isPathInside,
  resolveWithinRoot,
};

export {};
