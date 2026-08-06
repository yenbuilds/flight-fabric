'use strict';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const { ensureDirExists } = require('../utils/storage-paths.js') as {
  ensureDirExists: (dirPath: string | null | undefined) => string | null | undefined;
};
const { assertSafeFileTarget } = require('../utils/safe-fs.js') as {
  assertSafeFileTarget: (_options: {
    allowedExtensions?: string[];
    operation: string;
    rootDir: string;
    targetPath: string;
  }) => string;
};

type FsWriteStream = import('fs').WriteStream & {
  fd?: number | null;
};

type RecordingPathOptions = {
  extension: string;
  operation: string;
  outputDir: string;
  requiredSuffix?: string;
  targetPath: string;
};

type RecordingStreamOptions = RecordingPathOptions & {
  flags?: string;
};

type RecordingRenameOptions = {
  extension: string;
  fromPath: string;
  operation: string;
  outputDir: string;
  requiredSuffix?: string;
  toPath: string;
};

function fail(operation: string, reason: string): never {
  const error = new Error(`${operation} refused: ${reason}`) as NodeJS.ErrnoException;
  error.code = 'FF_RECORDING_PATH_REFUSED';
  throw error;
}

function comparePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertSafeRecordingFilePath(options: RecordingPathOptions): string {
  const outputDir = path.resolve(options.outputDir);
  ensureDirExists(outputDir);

  const outputDirStat = fs.lstatSync(outputDir);
  if (outputDirStat.isSymbolicLink()) {
    fail(options.operation, 'recording directory is a symbolic link');
  }
  if (!outputDirStat.isDirectory()) {
    fail(options.operation, 'recording directory is not a directory');
  }

  const resolvedTarget = assertSafeFileTarget({
    allowedExtensions: [options.extension],
    operation: options.operation,
    rootDir: outputDir,
    targetPath: options.targetPath,
  });

  if (comparePath(path.dirname(resolvedTarget)) !== comparePath(outputDir)) {
    fail(options.operation, 'recording files must be direct children of the recording directory');
  }

  if (options.requiredSuffix && !path.basename(resolvedTarget).toLowerCase().endsWith(options.requiredSuffix.toLowerCase())) {
    fail(options.operation, 'recording filename does not match the expected suffix');
  }

  return resolvedTarget;
}

function createSafeRecordingWriteStream(options: RecordingStreamOptions): FsWriteStream {
  const resolvedTarget = assertSafeRecordingFilePath(options);
  if (options.flags === 'wx') {
    // Claim synchronously so startup cannot report success and discover an
    // EEXIST collision on a later event-loop turn.
    const fd = fs.openSync(resolvedTarget, 'wx');
    try {
      return fs.createWriteStream(resolvedTarget, { fd, autoClose: true }) as FsWriteStream;
    } catch (error) {
      try { fs.closeSync(fd); } catch {}
      throw error;
    }
  }
  return fs.createWriteStream(resolvedTarget, { flags: options.flags || 'a' }) as FsWriteStream;
}

function safeRenameRecordingFileSync(options: RecordingRenameOptions): boolean {
  const fromPath = assertSafeRecordingFilePath({
    extension: options.extension,
    operation: `${options.operation}:from`,
    outputDir: options.outputDir,
    requiredSuffix: options.requiredSuffix,
    targetPath: options.fromPath,
  });
  const toPath = assertSafeRecordingFilePath({
    extension: options.extension,
    operation: `${options.operation}:to`,
    outputDir: options.outputDir,
    requiredSuffix: options.requiredSuffix,
    targetPath: options.toPath,
  });

  if (!fs.existsSync(fromPath)) return false;
  if (comparePath(fromPath) === comparePath(toPath)) return true;

  // `rename(2)` replaces an existing destination on POSIX even though Windows
  // normally refuses the same operation. Recording route updates must have the
  // same no-replace behavior on every platform: an older flight artifact at the
  // destination is never disposable. A hard-link followed by unlink is an
  // atomic no-replace move for regular files on the same filesystem. `linkSync`
  // fails with EEXIST if another writer wins the destination race.
  try {
    fs.linkSync(fromPath, toPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') fail(options.operation, 'rename destination already exists');
    throw error;
  }

  try {
    fs.unlinkSync(fromPath);
  } catch (error) {
    // Roll back the newly-created link when possible so a failed move retains
    // the original source identity rather than leaving two visible basenames.
    try { fs.unlinkSync(toPath); } catch {}
    throw error;
  }
  return true;
}

module.exports = {
  assertSafeRecordingFilePath,
  createSafeRecordingWriteStream,
  safeRenameRecordingFileSync,
};

export {};
