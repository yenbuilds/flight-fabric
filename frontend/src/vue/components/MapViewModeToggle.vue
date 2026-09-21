<script setup>
import { MAP_VIEW_MODES } from '../../maps/three-d/view-mode.js';

const props = defineProps({
  modelValue: { type: String, default: '2d' },
  idPrefix: { type: String, default: 'map-view' },
  label: { type: String, default: 'Map view' },
});
const emit = defineEmits(['update:modelValue']);

const OPTIONS = [
  { key: '2d', label: '2D', title: 'Flat map' },
  { key: '3d', label: '3D', title: 'Altitude and camera view' },
];

function select(mode) {
  if (!MAP_VIEW_MODES.includes(mode) || mode === props.modelValue) return;
  emit('update:modelValue', mode);
}
</script>

<template>
  <div
    :id="`${idPrefix}-toggle`"
    class="map-view-toggle"
    role="group"
    :aria-label="label"
  >
    <button
      v-for="option in OPTIONS"
      :id="`${idPrefix}-${option.key}`"
      :key="option.key"
      type="button"
      class="map-view-toggle-option"
      :class="{ active: modelValue === option.key }"
      :aria-pressed="modelValue === option.key ? 'true' : 'false'"
      :title="option.title"
      :data-map-view="option.key"
      @click="select(option.key)"
    >
      {{ option.label }}
    </button>
  </div>
</template>
