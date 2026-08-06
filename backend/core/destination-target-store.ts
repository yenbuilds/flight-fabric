const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const {
  ensureDirExists,
  DESTINATION_TARGET_FILE_NAME,
  getAppDataRoot,
  ORIGIN_TARGET_FILE_NAME,
  resolveDestinationTargetFilePath,
  resolveOriginTargetFilePath,
} = require('../utils/storage-paths.js') as {
  DESTINATION_TARGET_FILE_NAME: string;
  ensureDirExists: (dirPath: string) => void;
  getAppDataRoot: () => string;
  ORIGIN_TARGET_FILE_NAME: string;
  resolveDestinationTargetFilePath: () => string;
  resolveOriginTargetFilePath: () => string;
};
const { safeReplaceTextFileSync, safeUnlinkSync } = require('../utils/safe-fs.js') as {
  safeReplaceTextFileSync: (_options: {
    allowedBasenames?: string[];
    allowedExtensions?: string[];
    data: string;
    operation: string;
    rootDir: string;
    targetPath: string;
  }) => string;
  safeUnlinkSync: (_options: {
    allowedBasenames?: string[];
    allowedExtensions?: string[];
    allowMissing?: boolean;
    operation: string;
    rootDir: string;
    targetPath: string;
  }) => boolean;
};

export type TargetLocation = {
  icao: string;
  name: string;
  lat: number;
  lon: number;
  initialDistanceNm: number | null;
};

type TargetInput = {
  icao?: unknown;
  name?: unknown;
  lat?: unknown;
  lon?: unknown;
  initialDistanceNm?: unknown;
} | null | undefined;

const APP_DATA_DIR = getAppDataRoot();
const DESTINATION_TARGET_FILE = resolveDestinationTargetFilePath();
const ORIGIN_TARGET_FILE = resolveOriginTargetFilePath();

function ensureDataDir(): void {
  ensureDirExists(APP_DATA_DIR);
  ensureDirExists(path.dirname(DESTINATION_TARGET_FILE));
  ensureDirExists(path.dirname(ORIGIN_TARGET_FILE));
}

const MAX_TARGET_NAME_LEN = 200;

export function sanitizeTarget(input: TargetInput): TargetLocation | null {
  if (!input || typeof input !== 'object') return null;

  const icao = String(input.icao || '').trim().toUpperCase();
  const name = String(input.name || icao || '').trim().slice(0, MAX_TARGET_NAME_LEN);
  const lat = Number(input.lat);
  const lon = Number(input.lon);
  const initialDistanceNm = Number(input.initialDistanceNm);

  if (!icao || !/^[A-Z0-9]{3,4}$/.test(icao)) return null;
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) return null;

  return {
    icao,
    name: name || icao,
    lat,
    lon,
    initialDistanceNm: Number.isFinite(initialDistanceNm) && initialDistanceNm > 0
      ? initialDistanceNm
      : null,
  };
}

function readTargetFromFile(filePath: string): TargetLocation | null {
  ensureDataDir();
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as TargetInput;
    return sanitizeTarget(parsed);
  } catch {
    return null;
  }
}

function writeTargetToFile(filePath: string, target: TargetLocation | null): void {
  ensureDataDir();
  safeReplaceTextFileSync({
    allowedBasenames: [DESTINATION_TARGET_FILE_NAME, ORIGIN_TARGET_FILE_NAME],
    allowedExtensions: ['.json'],
    data: JSON.stringify(target, null, 2),
    operation: 'writeRouteTarget',
    rootDir: APP_DATA_DIR,
    targetPath: filePath,
  });
}

function clearTargetFile(filePath: string): void {
  ensureDataDir();
  safeUnlinkSync({
    allowedBasenames: [DESTINATION_TARGET_FILE_NAME, ORIGIN_TARGET_FILE_NAME],
    allowedExtensions: ['.json'],
    allowMissing: true,
    operation: 'clearRouteTarget',
    rootDir: APP_DATA_DIR,
    targetPath: filePath,
  });
}

export function readDestinationTarget(): TargetLocation | null {
  return readTargetFromFile(DESTINATION_TARGET_FILE);
}

export function writeDestinationTarget(target: TargetLocation | null): void {
  writeTargetToFile(DESTINATION_TARGET_FILE, target);
}

export function clearDestinationTargetFile(): void {
  clearTargetFile(DESTINATION_TARGET_FILE);
}

export function readOriginTarget(): TargetLocation | null {
  return readTargetFromFile(ORIGIN_TARGET_FILE);
}

export function writeOriginTarget(target: TargetLocation | null): void {
  writeTargetToFile(ORIGIN_TARGET_FILE, target);
}

export function clearOriginTargetFile(): void {
  clearTargetFile(ORIGIN_TARGET_FILE);
}

export {
  DESTINATION_TARGET_FILE,
  ORIGIN_TARGET_FILE,
};
