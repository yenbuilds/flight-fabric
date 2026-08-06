'use strict';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const crypto = require('crypto') as typeof import('crypto');
const { ensureDirExists } = require('./storage-paths.js') as {
  ensureDirExists: (dirPath: string | null | undefined) => string | null | undefined;
};
const { isPathInside } = require('./path-guard') as {
  isPathInside: (parentDir: string | null | undefined, childPath: string | null | undefined, options?: { allowEqual?: boolean }) => boolean;
};

type GuardOptions = {
  allowedBasenames?: string[];
  allowedExtensions?: string[];
  allowMissing?: boolean;
  operation: string;
  rejectSymlinks?: boolean;
  rootDir: string;
  targetPath: string;
};

type WriteTextOptions = GuardOptions & {
  data: string;
  encoding?: BufferEncoding;
};

type CopyFileOptions = GuardOptions & {
  sourcePath: string;
};

function normalizeExtension(value: string): string {
  const trimmed = String(value || '').trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

function fail(operation: string, reason: string): never {
  const error = new Error(`${operation} refused: ${reason}`) as NodeJS.ErrnoException;
  error.code = 'FF_SAFE_FS_REFUSED';
  throw error;
}

function comparePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function realpathSyncNative(targetPath: string): string {
  const realpathNative = (fs.realpathSync as typeof fs.realpathSync & { native?: typeof fs.realpathSync }).native;
  return realpathNative ? realpathNative(targetPath) : fs.realpathSync(targetPath);
}

function assertSafeParentDirectory(rootDir: string, targetPath: string, operation: string, rejectSymlinks: boolean): void {
  if (!rejectSymlinks) return;

  const resolvedRoot = path.resolve(rootDir);
  const resolvedParent = path.dirname(path.resolve(targetPath));
  if (!isPathInside(resolvedRoot, resolvedParent, { allowEqual: true })) {
    fail(operation, 'target parent is outside the allowed root');
  }

  if (!fs.existsSync(resolvedRoot)) return;
  const rootStat = fs.lstatSync(resolvedRoot);
  if (!rootStat.isDirectory()) {
    fail(operation, 'allowed root is not a directory');
  }

  let existingAncestor = resolvedParent;
  while (!fs.existsSync(existingAncestor) && isPathInside(resolvedRoot, existingAncestor, { allowEqual: true })) {
    const nextAncestor = path.dirname(existingAncestor);
    if (nextAncestor === existingAncestor) break;
    existingAncestor = nextAncestor;
  }

  if (!fs.existsSync(existingAncestor)) return;
  const ancestorStat = fs.lstatSync(existingAncestor);
  if (ancestorStat.isSymbolicLink()) {
    fail(operation, 'target parent contains a symbolic link');
  }
  if (!ancestorStat.isDirectory()) {
    fail(operation, 'target parent is not a directory');
  }

  const relativeParts = path.relative(resolvedRoot, existingAncestor)
    .split(path.sep)
    .filter(Boolean);
  let cursor = resolvedRoot;
  for (const part of relativeParts) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) break;
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      fail(operation, 'target parent contains a symbolic link');
    }
    if (!stat.isDirectory()) {
      fail(operation, 'target parent is not a directory');
    }
  }

  const rootReal = realpathSyncNative(resolvedRoot);
  const ancestorReal = realpathSyncNative(existingAncestor);
  if (!isPathInside(rootReal, ancestorReal, { allowEqual: true })) {
    fail(operation, 'target parent escapes the allowed root');
  }

  const rootComparable = comparePath(rootReal);
  const ancestorComparable = comparePath(ancestorReal);
  if (ancestorComparable !== rootComparable && !isPathInside(rootReal, ancestorReal)) {
    fail(operation, 'target parent escapes the allowed root');
  }
}

function assertSafeFileTarget(options: GuardOptions): string {
  const {
    allowedBasenames = [],
    allowedExtensions = [],
    operation,
    rejectSymlinks = true,
    rootDir,
    targetPath,
  } = options;

  if (!rootDir || typeof rootDir !== 'string') fail(operation, 'missing root directory');
  if (!targetPath || typeof targetPath !== 'string') fail(operation, 'missing target path');

  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  if (!isPathInside(resolvedRoot, resolvedTarget)) {
    fail(operation, 'target is outside the allowed root');
  }
  assertSafeParentDirectory(resolvedRoot, resolvedTarget, operation, rejectSymlinks);

  const basename = path.basename(resolvedTarget);
  if (allowedBasenames.length > 0 && !allowedBasenames.includes(basename)) {
    fail(operation, 'target filename is not allowlisted');
  }

  if (allowedExtensions.length > 0) {
    const targetExt = path.extname(resolvedTarget).toLowerCase();
    const allowed = allowedExtensions.map(normalizeExtension).filter(Boolean);
    if (!allowed.includes(targetExt)) {
      fail(operation, 'target extension is not allowlisted');
    }
  }

  if (rejectSymlinks && fs.existsSync(resolvedTarget)) {
    const stat = fs.lstatSync(resolvedTarget);
    if (stat.isSymbolicLink()) {
      fail(operation, 'target is a symbolic link');
    }
    if (!stat.isFile()) {
      fail(operation, 'target is not a regular file');
    }
  }

  return resolvedTarget;
}

function safeUnlinkSync(options: GuardOptions): boolean {
  const resolvedTarget = assertSafeFileTarget(options);
  if (!fs.existsSync(resolvedTarget)) {
    if (options.allowMissing === true) return false;
    const error = new Error(`${options.operation} failed: file not found`) as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    throw error;
  }
  fs.unlinkSync(resolvedTarget);
  return true;
}

function safeWriteTextFileSync(options: WriteTextOptions): string {
  const resolvedTarget = assertSafeFileTarget(options);
  ensureDirExists(path.dirname(resolvedTarget));
  fs.writeFileSync(resolvedTarget, options.data, options.encoding || 'utf8');
  return resolvedTarget;
}

function safeCopyFileSync(options: CopyFileOptions): string {
  const resolvedTarget = assertSafeFileTarget(options);
  if (!options.sourcePath || typeof options.sourcePath !== 'string') {
    fail(options.operation, 'missing source path');
  }
  const resolvedSource = path.resolve(options.sourcePath);
  const sourceStat = fs.lstatSync(resolvedSource);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    fail(options.operation, 'source is not a regular file');
  }
  ensureDirExists(path.dirname(resolvedTarget));
  fs.copyFileSync(resolvedSource, resolvedTarget);
  return resolvedTarget;
}

function safeReplaceTextFileSync(options: WriteTextOptions): string {
  const resolvedTarget = assertSafeFileTarget(options);
  ensureDirExists(path.dirname(resolvedTarget));
  const tmpName = `${path.basename(resolvedTarget)}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const tmpPath = assertSafeFileTarget({
    ...options,
    allowedBasenames: [],
    allowedExtensions: [...(options.allowedExtensions || []), '.tmp'],
    targetPath: path.join(path.dirname(resolvedTarget), tmpName),
  });
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(tmpPath, 'wx');
    fs.writeFileSync(descriptor, options.data, options.encoding || 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(tmpPath, resolvedTarget);
    return resolvedTarget;
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
    try {
      safeUnlinkSync({
        allowedExtensions: ['.tmp'],
        allowMissing: true,
        operation: `${options.operation}:cleanup`,
        rootDir: options.rootDir,
        targetPath: tmpPath,
      });
    } catch {
      // Ignore cleanup failures; preserve the original write/rename error.
    }
    throw error;
  }
}

module.exports = {
  assertSafeFileTarget,
  safeCopyFileSync,
  safeReplaceTextFileSync,
  safeUnlinkSync,
  safeWriteTextFileSync,
};

export {};
