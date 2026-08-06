const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');

type GenericRecord = Record<string, any>;

function decodeLights(value: number): GenericRecord {
  const recognitionBit = !!(value & (1 << 6));

  return {
    nav: !!(value & (1 << 0)),
    beacon: !!(value & (1 << 1)),
    landing: !!(value & (1 << 2)),
    taxi: !!(value & (1 << 3)),
    strobe: !!(value & (1 << 4)),
    panel: !!(value & (1 << 5)),
    recog: recognitionBit,
    turnoff: recognitionBit,
    wing: !!(value & (1 << 7)),
    logo: !!(value & (1 << 8)),
    cabin: !!(value & (1 << 9)),
    raw: value,
  };
}

const decodeWOW = (raw: number): boolean => raw > 0;
const gearDown = (bits: number): boolean => (bits & 0b111) === 0b111;

const SURFACE_TYPE_NAMES: Record<number, string> = {
  0: 'CONCRETE',
  1: 'GRASS',
  2: 'WATER',
  3: 'GRASS_BUMPY',
  4: 'ASPHALT',
  5: 'SHORT_GRASS',
  6: 'LONG_GRASS',
  7: 'HARD_TURF',
  8: 'SNOW',
  9: 'ICE',
  10: 'URBAN',
  11: 'FOREST',
  12: 'DIRT',
  13: 'CORAL',
  14: 'GRAVEL',
  15: 'OIL_TREATED',
  16: 'STEEL_MATS',
  17: 'BITUMINOUS',
  18: 'BRICK',
  19: 'MACADAM',
  20: 'PLANKS',
  21: 'SAND',
  22: 'SHALE',
  23: 'TARMAC',
  24: 'WRIGHT_FLYER_TRACK',
};

const PAVED_SURFACES = new Set([0, 4, 15, 16, 17, 18, 19, 22, 23]);
const UNPAVED_SURFACES = new Set([1, 3, 5, 6, 7, 12, 13, 14, 20, 21]);

function decodeSurfaceType(raw: number, wow: boolean, onAnyRunway?: boolean): GenericRecord {
  const onRunway = typeof onAnyRunway === 'boolean' ? onAnyRunway : null;

  if (!Number.isFinite(raw)) {
    return {
      raw: null,
      name: null,
      class: 'UNKNOWN',
      runwayLike: onRunway === true,
      onRunway,
      onGround: !!wow,
      valid: false,
    };
  }

  const code = raw | 0;
  const name = SURFACE_TYPE_NAMES[code] || 'UNKNOWN';

  if (!wow) {
    return {
      raw: code,
      name,
      class: 'UNKNOWN',
      runwayLike: false,
      onRunway: false,
      onGround: false,
      valid: false,
    };
  }

  let surfaceClass = 'UNKNOWN';
  let runwayLikeFromSurface = false;

  if (PAVED_SURFACES.has(code)) {
    surfaceClass = 'PAVED';
    runwayLikeFromSurface = true;
  } else if (UNPAVED_SURFACES.has(code)) {
    surfaceClass = 'UNPAVED';
  } else if (code === 2) {
    surfaceClass = 'WATER';
  }

  const runwayLike = onRunway !== null ? onRunway : runwayLikeFromSurface;

  return {
    raw: code,
    name,
    class: surfaceClass,
    runwayLike,
    onRunway,
    onGround: true,
    valid: surfaceClass !== 'UNKNOWN',
  };
}

function decodeGearState(input: {
  brake?: number;
  gearDownLocked?: number;
  gearLeft?: number;
  gearNose?: number;
  gearRight?: number;
}): GenericRecord {
  const parkingBrakeSet = typeof input.brake === 'number' && input.brake > 0.5;

  const normalizeGear = (gearValue: unknown): number => {
    if (typeof gearValue !== 'number') return 0;
    return Math.max(0, Math.min(1, gearValue / 100));
  };

  return {
    left: normalizeGear(input.gearLeft),
    right: normalizeGear(input.gearRight),
    nose: normalizeGear(input.gearNose),
    locked: input.gearDownLocked === 1,
    parkingBrake: parkingBrakeSet,
  };
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function rad2deg(rad: number): number {
  return rad * RAD2DEG;
}

function norm360(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

function normDelta180(delta: number): number {
  return (((delta + 180) % 360) + 360) % 360 - 180;
}

function computeCrosswind(windSpeed: unknown, windDirDeg: unknown, headingDeg: unknown): number | null {
  if (!Number.isFinite(windSpeed) || !Number.isFinite(windDirDeg) || !Number.isFinite(headingDeg)) return null;
  const speed = windSpeed as number;
  const direction = windDirDeg as number;
  const heading = headingDeg as number;
  if (Math.abs(speed) < 0.1) return 0;

  const normalizedHeading = norm360(heading);
  const normalizedWindDirection = norm360(direction);
  const delta = normDelta180(normalizedWindDirection - normalizedHeading);
  const relativeRadians = delta * DEG2RAD;

  const crosswind = speed * Math.sin(relativeRadians);
  return Math.round(crosswind * 10) / 10;
}

function resolveExistingDirectory(targetPath: unknown): string | null {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return null;

  let candidate = path.resolve(targetPath);
  while (true) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Walk upward until an existing directory is found. The Flight Logs
      // directory may not exist yet when the pre-recording check runs.
    }

    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

async function checkCsvDiskSpace(
  options: { minFreeGb?: number; targetDir?: string } = {}
): Promise<{ allowed: boolean; freeDiskGb: number; minFreeGb: number; reason?: string }> {
  const minFreeGb = options.minFreeGb ?? 1;
  const requestedDir = options.targetDir || (
    require('./flight-logs-dir.js') as {
      resolveFlightLogsDir: (options?: { createIfMissing?: boolean }) => string;
    }
  ).resolveFlightLogsDir({ createIfMissing: false });
  const checkDir = resolveExistingDirectory(requestedDir);

  if (!checkDir) {
    return { allowed: true, freeDiskGb: -1, minFreeGb, reason: 'Could not resolve flight logs disk' };
  }

  try {
    if (typeof fs.statfs === 'function') {
      return new Promise((resolve) => {
        fs.statfs(checkDir, (error, stats) => {
          if (error) {
            resolve({ allowed: true, freeDiskGb: -1, minFreeGb, reason: 'Could not check disk space' });
            return;
          }
          const availableBlocks = Number.isFinite(stats.bavail) ? stats.bavail : stats.bfree;
          const freeBytes = availableBlocks * stats.bsize;
          const freeDiskGb = Math.round((freeBytes / (1024 * 1024 * 1024)) * 100) / 100;

          if (freeDiskGb < minFreeGb) {
            resolve({
              allowed: false,
              freeDiskGb,
              minFreeGb,
              reason: `Low disk space: ${freeDiskGb.toFixed(1)} GB free (minimum ${minFreeGb} GB required)`,
            });
          } else {
            resolve({ allowed: true, freeDiskGb, minFreeGb });
          }
        });
      });
    }

    return { allowed: true, freeDiskGb: -1, minFreeGb, reason: 'fs.statfs not available' };
  } catch (error) {
    const err = error as { message?: string };
    return { allowed: true, freeDiskGb: -1, minFreeGb, reason: err.message };
  }
}

const helpersApi = {
  checkCsvDiskSpace,
  computeCrosswind,
  decodeGearState,
  decodeLights,
  decodeSurfaceType,
  decodeWOW,
  gearDown,
  rad2deg,
  resolveExistingDirectory,
};

module.exports = helpersApi;

export {};
