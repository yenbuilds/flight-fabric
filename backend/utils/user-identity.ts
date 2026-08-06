'use strict';

const crypto = require('crypto') as typeof import('crypto');
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const Debug = require('../core/debug.js') as {
  log: (scope: string, message: string, meta?: Record<string, unknown>) => void;
};
const {
  ensureDirExists,
  getAppDataRoot,
  USER_ID_FILE_NAME,
  getUserIdFilePath: getPersistentUserIdFilePath,
} = require('./storage-paths.js') as {
  ensureDirExists: (dirPath: string) => string | null | undefined;
  getAppDataRoot: (env?: NodeJS.ProcessEnv | Record<string, string | undefined>) => string;
  USER_ID_FILE_NAME: string;
  getUserIdFilePath: (env?: NodeJS.ProcessEnv | Record<string, string | undefined>) => string;
};
const { safeReplaceTextFileSync } = require('./safe-fs.js') as {
  safeReplaceTextFileSync: (_options: {
    allowedBasenames?: string[];
    data: string;
    operation: string;
    rootDir: string;
    targetPath: string;
  }) => string;
};

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;
type ResolveUserIdOptions = {
  env?: EnvLike;
};

const SESSION_ID = crypto.randomUUID();
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cachedUserIds = new Map<string, string>();

function generateUUID(): string {
  return crypto.randomUUID();
}

function isUuidV4(value: unknown): boolean {
  return typeof value === 'string' && UUID_V4_RE.test(value);
}

function resolveUserIdPersistencePath(options: ResolveUserIdOptions = {}): string {
  const env = options.env || process.env;
  return getPersistentUserIdFilePath(env);
}

function getUserId(options: ResolveUserIdOptions = {}): string {
  const userIdFilePath = resolveUserIdPersistencePath(options);

  if (cachedUserIds.has(userIdFilePath)) {
    return cachedUserIds.get(userIdFilePath)!;
  }

  try {
    if (fs.existsSync(userIdFilePath)) {
      const content = fs.readFileSync(userIdFilePath, 'utf8').trim();
      if (isUuidV4(content)) {
        cachedUserIds.set(userIdFilePath, content);
        Debug.log('identity', 'Loaded existing user ID', { userId: `${content.slice(0, 8)}...` });
        return content;
      }
      Debug.log('identity', 'Invalid user ID format, regenerating');
    }

    const userId = generateUUID();
    ensureDirExists(path.dirname(userIdFilePath));
    safeReplaceTextFileSync({
      allowedBasenames: [USER_ID_FILE_NAME],
      data: `${userId}\n`,
      operation: 'writeUserId',
      rootDir: getAppDataRoot(options.env || process.env),
      targetPath: userIdFilePath,
    });
    cachedUserIds.set(userIdFilePath, userId);
    Debug.log('identity', 'Generated new user ID', { userId: `${userId.slice(0, 8)}...` });
    return userId;
  } catch (error) {
    const err = error as { message?: string };
    Debug.log('identity', 'Failed to persist user ID, using transient', {
      error: err.message,
    });
    const transientUserId = generateUUID();
    cachedUserIds.set(userIdFilePath, transientUserId);
    return transientUserId;
  }
}

function getSessionId(): string {
  return SESSION_ID;
}

function getUserIdFilePath(options: ResolveUserIdOptions = {}): string {
  return resolveUserIdPersistencePath(options);
}

const userIdentityApi = {
  __private: {
    generateUUID,
    isUuidV4,
    resetCache(): void {
      cachedUserIds.clear();
    },
    resolveUserIdPersistencePath,
  },
  getSessionId,
  getUserId,
  getUserIdFilePath,
};

module.exports = userIdentityApi;

export {};
