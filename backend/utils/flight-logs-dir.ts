'use strict';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const recordingBundleLayout = require('../flight-recording/recording-bundle-layout') as {
  getBundleFromCsvPath: (_csvPath: unknown) => { paths: Record<string, string> } | null;
  listBundleCsvPaths: (_outputDir: string) => string[];
};
const {
  DOCUMENTS_APP_DIR_NAME,
  FLIGHT_LOGS_DIR_NAME,
  ensureDirExists,
  getDocumentsDirCandidates,
  getHomeDir,
  isDirectory,
} = require('./storage-paths.js') as {
  DOCUMENTS_APP_DIR_NAME: string;
  FLIGHT_LOGS_DIR_NAME: string;
  ensureDirExists: (dirPath: string) => string | null | undefined;
  getDocumentsDirCandidates: (env?: NodeJS.ProcessEnv | Record<string, string | undefined>) => string[];
  getHomeDir: (env?: NodeJS.ProcessEnv | Record<string, string | undefined>) => string;
  isDirectory: (dirPath: string | null | undefined) => boolean;
};

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;
type FlightLogsOptions = {
  createIfMissing?: boolean;
  env?: EnvLike;
  allowedCsvPaths?: string[];
};

type FlightLogsDirPair = {
  documentsDir: string;
  currentDir: string;
};

type FlightLogsStorageInfo = {
  dir: string;
  exists: boolean;
  fileCount: number;
  totalBytes: number;
};

const FLIGHT_LOGS_FOLDER = FLIGHT_LOGS_DIR_NAME;

function getFlightLogsDirPairs(env: EnvLike = process.env): FlightLogsDirPair[] {
  return getDocumentsDirCandidates(env).map((documentsDir) => ({
    currentDir: path.join(documentsDir, DOCUMENTS_APP_DIR_NAME, FLIGHT_LOGS_FOLDER),
    documentsDir,
  }));
}

function getFlightLogsDirCandidates(env: EnvLike = process.env): string[] {
  return getFlightLogsDirPairs(env).map((pair) => pair.currentDir);
}

function countCsvFiles(dirPath: string): number {
  if (!isDirectory(dirPath)) return 0;
  try {
    return recordingBundleLayout.listBundleCsvPaths(dirPath).length;
  } catch {
    return 0;
  }
}

function resolveFlightLogsDir(options: FlightLogsOptions = {}): string {
  const { createIfMissing = false } = options;
  const env = options.env || process.env;

  const candidates = getFlightLogsDirCandidates(env);
  const fallback = path.join(getHomeDir(env), 'Documents', DOCUMENTS_APP_DIR_NAME, FLIGHT_LOGS_FOLDER);
  const candidatesWithLogs = candidates
    .map((candidate) => ({ candidate, csvCount: countCsvFiles(candidate) }))
    .filter((entry) => entry.csvCount > 0)
    .sort((left, right) => right.csvCount - left.csvCount);

  const resolvedDir =
    candidatesWithLogs[0]?.candidate ||
    candidates.find((candidate) => isDirectory(candidate)) ||
    candidates[0] ||
    fallback;

  if (createIfMissing && !isDirectory(resolvedDir)) {
    ensureDirExists(resolvedDir);
  }

  return resolvedDir;
}

function getFlightLogsStorageInfo(options: FlightLogsOptions = {}): FlightLogsStorageInfo {
  const dir = resolveFlightLogsDir(options);
  const info: FlightLogsStorageInfo = {
    dir,
    exists: false,
    fileCount: 0,
    totalBytes: 0,
  };

  if (!fs.existsSync(dir)) {
    return info;
  }

  const comparableAllowedCsvPaths = Array.isArray(options.allowedCsvPaths)
    ? new Set(options.allowedCsvPaths
        .filter((filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0)
        .map((filePath) => {
          const resolved = path.resolve(filePath);
          return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        }))
    : null;
  let totalBytes = 0;
  let fileCount = 0;
  let csvPaths: string[] = [];
  try {
    csvPaths = recordingBundleLayout.listBundleCsvPaths(dir);
  } catch {}
  for (const csvPath of csvPaths) {
    const comparable = process.platform === 'win32'
      ? path.resolve(csvPath).toLowerCase()
      : path.resolve(csvPath);
    if (comparableAllowedCsvPaths && !comparableAllowedCsvPaths.has(comparable)) continue;
    const bundle = recordingBundleLayout.getBundleFromCsvPath(csvPath);
    if (!bundle) continue;
    fileCount += 1;
    for (const memberPath of Object.values(bundle.paths)) {
      if (memberPath === path.dirname(csvPath)) continue;
      try {
        const stat = fs.lstatSync(memberPath);
        if (stat.isFile() && !stat.isSymbolicLink()) totalBytes += stat.size;
      } catch {
        // Optional or unreadable bundle members do not hide the recording.
      }
    }
  }

  info.exists = true;
  info.fileCount = fileCount;
  info.totalBytes = totalBytes;
  return info;
}

const flightLogsDirApi = {
  FLIGHT_LOGS_FOLDER,
  getDocumentsDirCandidates,
  getFlightLogsDirCandidates,
  getFlightLogsDirPairs,
  getFlightLogsStorageInfo,
  resolveFlightLogsDir,
};

module.exports = flightLogsDirApi;

export {};
