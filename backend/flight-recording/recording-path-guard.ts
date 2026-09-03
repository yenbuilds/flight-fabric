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

module.exports = {
  assertSafeRecordingFilePath,
  createSafeRecordingWriteStream,
};

export {};
