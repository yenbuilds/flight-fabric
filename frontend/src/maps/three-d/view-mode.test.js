import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultMap3dOptions,
  formatVerticalScaleLabel,
  normalizeCameraMode,
  normalizeLightingMode,
  normalizeMap3dOptions,
  normalizeMapViewMode,
  normalizeVerticalScale,
  CAMERA_MODE_KEYS,
  VERTICAL_SCALE_OPTIONS,
} from './view-mode.js';

test('view modes and camera modes fall back to safe defaults', () => {
  assert.equal(normalizeMapViewMode('3d'), '3d');
  assert.equal(normalizeMapViewMode('2d'), '2d');
  assert.equal(normalizeMapViewMode('globe'), '2d');
  assert.equal(normalizeMapViewMode(null, '3d'), '3d');
  assert.deepEqual(CAMERA_MODE_KEYS, ['chase', 'orbit', 'top']);
  assert.equal(normalizeCameraMode('orbit'), 'orbit');
  assert.equal(normalizeCameraMode('drone'), 'chase');
  assert.equal(normalizeLightingMode('day'), 'day');
  assert.equal(normalizeLightingMode('disco'), 'time');
});

test('vertical scale accepts only the offered steps and labels true scale honestly', () => {
  assert.deepEqual([...VERTICAL_SCALE_OPTIONS], [1, 2, 3, 5]);
  assert.equal(normalizeVerticalScale('3'), 3);
  assert.equal(normalizeVerticalScale(4), 2);
  assert.equal(normalizeVerticalScale(undefined, 5), 5);
  assert.equal(formatVerticalScaleLabel(1), 'True scale');
  assert.equal(formatVerticalScaleLabel(5), 'Vertical x5');
});

test('3D option objects are normalized field by field', () => {
  assert.deepEqual(defaultMap3dOptions(), {
    cameraMode: 'chase',
    colorMode: 'altitude',
    verticalScale: 2,
    showCurtain: true,
    showTerrain: true,
    lighting: 'time',
  });
  assert.deepEqual(normalizeMap3dOptions({ cameraMode: 'top', colorMode: 'verticalSpeed', verticalScale: 5, showCurtain: false, showTerrain: false, lighting: 'day' }), {
    cameraMode: 'top',
    colorMode: 'verticalSpeed',
    verticalScale: 5,
    showCurtain: false,
    showTerrain: false,
    lighting: 'day',
  });
  assert.deepEqual(normalizeMap3dOptions({ cameraMode: 'nope', colorMode: 7, verticalScale: 'x', showCurtain: 'yes' }), defaultMap3dOptions());
  assert.deepEqual(normalizeMap3dOptions('garbage'), defaultMap3dOptions());
  const stored = normalizeMap3dOptions({ colorMode: 'groundSpeed' }, { ...defaultMap3dOptions(), verticalScale: 3 });
  assert.equal(stored.verticalScale, 3, 'missing fields keep the previous value');
});
