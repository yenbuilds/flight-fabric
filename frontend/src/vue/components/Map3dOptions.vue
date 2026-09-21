<script setup>
import { TRACK_COLOR_MODES, TRACK_COLOR_MODE_KEYS } from '../../maps/three-d/track-geometry.js';
import {
  CAMERA_MODES,
  CAMERA_MODE_KEYS,
  LIGHTING_MODES,
  LIGHTING_MODE_KEYS,
  VERTICAL_SCALE_OPTIONS,
  formatVerticalScaleLabel,
} from '../../maps/three-d/view-mode.js';

defineProps({
  options: { type: Object, required: true },
  idPrefix: { type: String, default: 'map-3d' },
  showCamera: { type: Boolean, default: false },
  disclosure: { type: Boolean, default: true },
});
const emit = defineEmits(['update']);

const selectClass = 'map-3d-select';

function update(key, event) {
  const raw = event?.target?.value;
  emit('update', key, key === 'verticalScale' ? Number(raw) : raw);
}

function updateCurtain(event) {
  emit('update', 'showCurtain', event?.target?.checked === true);
}

function updateTerrain(event) {
  emit('update', 'showTerrain', event?.target?.checked === true);
}
</script>

<template>
  <component :is="disclosure ? 'details' : 'div'" class="map-3d-settings">
    <summary v-if="disclosure">3D settings</summary>
  <div :id="`${idPrefix}-options`" class="map-3d-options">
    <label v-if="showCamera" class="map-3d-option">
      <span class="map-3d-option-label">Camera</span>
      <select
        :id="`${idPrefix}-camera-mode`"
        :class="selectClass"
        :value="options.cameraMode"
        @change="update('cameraMode', $event)"
      >
        <option
          v-for="key in CAMERA_MODE_KEYS"
          :key="key"
          :value="key"
          :title="CAMERA_MODES[key].hint"
        >
          {{ CAMERA_MODES[key].label }}
        </option>
      </select>
    </label>
    <label class="map-3d-option">
      <span class="map-3d-option-label">Colour</span>
      <select
        :id="`${idPrefix}-color-mode`"
        :class="selectClass"
        :value="options.colorMode"
        @change="update('colorMode', $event)"
      >
        <option v-for="key in TRACK_COLOR_MODE_KEYS" :key="key" :value="key">
          {{ TRACK_COLOR_MODES[key].label }}
        </option>
      </select>
    </label>
    <label class="map-3d-option">
      <span class="map-3d-option-label">Height</span>
      <select
        :id="`${idPrefix}-vertical-scale`"
        :class="selectClass"
        :value="String(options.verticalScale)"
        @change="update('verticalScale', $event)"
      >
        <option v-for="scale in VERTICAL_SCALE_OPTIONS" :key="scale" :value="String(scale)">
          {{ formatVerticalScaleLabel(scale) }}
        </option>
      </select>
    </label>
    <label class="map-3d-option">
      <span class="map-3d-option-label">Light</span>
      <select
        :id="`${idPrefix}-lighting`"
        :class="selectClass"
        :value="options.lighting"
        @change="update('lighting', $event)"
      >
        <option
          v-for="key in LIGHTING_MODE_KEYS"
          :key="key"
          :value="key"
          :title="LIGHTING_MODES[key].hint"
        >
          {{ LIGHTING_MODES[key].label }}
        </option>
      </select>
    </label>
    <label class="map-3d-option map-3d-option-check">
      <input
        :id="`${idPrefix}-curtain`"
        type="checkbox"
        class="map-filter-cb"
        :checked="options.showCurtain === true"
        @change="updateCurtain"
      >
      <span>Curtain</span>
    </label>
    <label class="map-3d-option map-3d-option-check" title="Raise the ground to real elevation (Terrarium tiles, AWS Open Data)">
      <input
        :id="`${idPrefix}-terrain`"
        type="checkbox"
        class="map-filter-cb"
        :checked="options.showTerrain === true"
        @change="updateTerrain"
      >
      <span>Terrain</span>
    </label>
  </div>
  </component>
</template>

<style scoped>
.map-3d-settings { margin-top: 0.5rem; min-width: 0; }
.map-3d-settings > summary { cursor: pointer; width: fit-content; min-height: 2rem; align-content: center; color: rgb(var(--muted-foreground)); font-size: 0.75rem; }
.map-3d-settings > summary:hover { color: rgb(var(--foreground)); }
.map-3d-settings > summary:focus-visible { outline: 2px solid rgb(var(--selection)); outline-offset: 2px; border-radius: 0.25rem; }
.map-3d-settings .map-3d-options { padding-block: 0.5rem; gap: 0.65rem 1rem; }
.map-3d-settings .map-3d-select { min-height: 2rem; }
@media (pointer: coarse) {
  .map-3d-settings > summary, .map-3d-settings .map-3d-option, .map-3d-settings .map-3d-select { min-height: 2.75rem; }
}
</style>
