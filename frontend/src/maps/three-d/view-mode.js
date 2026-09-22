// Shared vocabulary for the 2D/3D map switch and the 3D view options, used
// by the live-map and timeline stores for shared defaults and saved 3D options.

import { DEFAULT_TRACK_COLOR_MODE, normalizeTrackColorMode } from './track-geometry.js';

export const MAP_VIEW_MODES = Object.freeze(['2d', '3d']);
const DEFAULT_MAP_VIEW_MODE = '2d';

export const CAMERA_MODES = Object.freeze({
  chase: Object.freeze({ key: 'chase', label: 'Chase', hint: 'Camera stays behind the aircraft' }),
  orbit: Object.freeze({ key: 'orbit', label: 'Orbit', hint: 'Camera keeps its bearing while following' }),
  top: Object.freeze({ key: 'top', label: 'Top-down', hint: 'North-up view from above' }),
});
export const CAMERA_MODE_KEYS = Object.freeze(Object.keys(CAMERA_MODES));
const DEFAULT_CAMERA_MODE = 'chase';

export const LIGHTING_MODES = Object.freeze({
  time: Object.freeze({ key: 'time', label: 'Time of day', hint: 'Sun position from the simulator clock; moonlight at night' }),
  day: Object.freeze({ key: 'day', label: 'Daylight', hint: 'Fixed daylight regardless of the clock' }),
});
export const LIGHTING_MODE_KEYS = Object.freeze(Object.keys(LIGHTING_MODES));
const DEFAULT_LIGHTING_MODE = 'time';

export const VERTICAL_SCALE_OPTIONS = Object.freeze([1, 2, 3, 5]);
const DEFAULT_VERTICAL_SCALE = 2;

export function normalizeMapViewMode(value, fallback = DEFAULT_MAP_VIEW_MODE) {
  return MAP_VIEW_MODES.includes(value) ? value : fallback;
}

export function normalizeCameraMode(value, fallback = DEFAULT_CAMERA_MODE) {
  return CAMERA_MODE_KEYS.includes(value) ? value : fallback;
}

export function normalizeLightingMode(value, fallback = DEFAULT_LIGHTING_MODE) {
  return LIGHTING_MODE_KEYS.includes(value) ? value : fallback;
}

export function normalizeVerticalScale(value, fallback = DEFAULT_VERTICAL_SCALE) {
  const numeric = Number(value);
  return VERTICAL_SCALE_OPTIONS.includes(numeric) ? numeric : fallback;
}

export function defaultMap3dOptions() {
  return {
    cameraMode: DEFAULT_CAMERA_MODE,
    colorMode: DEFAULT_TRACK_COLOR_MODE,
    verticalScale: DEFAULT_VERTICAL_SCALE,
    showCurtain: true,
    showTerrain: true,
    lighting: DEFAULT_LIGHTING_MODE,
  };
}

export function normalizeMap3dOptions(value, fallback = defaultMap3dOptions()) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    cameraMode: normalizeCameraMode(source.cameraMode, fallback.cameraMode),
    colorMode: normalizeTrackColorMode(source.colorMode ?? fallback.colorMode),
    verticalScale: normalizeVerticalScale(source.verticalScale, fallback.verticalScale),
    showCurtain: typeof source.showCurtain === 'boolean' ? source.showCurtain : fallback.showCurtain,
    showTerrain: typeof source.showTerrain === 'boolean' ? source.showTerrain : fallback.showTerrain,
    lighting: normalizeLightingMode(source.lighting, fallback.lighting),
  };
}

export function formatVerticalScaleLabel(value) {
  const scale = normalizeVerticalScale(value);
  return scale === 1 ? 'True scale' : `Vertical x${scale}`;
}
