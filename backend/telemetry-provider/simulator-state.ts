// Decode standard simulator values at the source normalization boundary.
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

/**
 * Normalize a surface payload for WS broadcast.
 *
 * Some providers/frames may omit `surface`. The legacy HUD expects a
 * `{ type: 'surface', value: <object> }` message; if it isn't emitted, SURFACE
 * and ON GROUND can get stuck at '--'.
 *
 * @param {any} surface
 * @param {boolean} wow
 * @returns {{ raw:number|null, name:string|null, class:string, runwayLike:boolean, onGround:boolean, valid:boolean }}
 */
function normalizeSurface(surface: unknown, wow: boolean): Record<string, any> {
  if (surface && typeof surface === 'object') return surface as Record<string, any>;
  // Use the canonical helper fallback shape.
  return decodeSurfaceType(Number.NaN, !!wow);
}

module.exports = { decodeGearState, decodeLights, decodeSurfaceType, decodeWOW, gearDown, normalizeSurface };

export {};
