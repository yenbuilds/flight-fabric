<script setup>
import { computed } from 'vue';

const props = defineProps({
  hud: { type: Object, default: null },
  idPrefix: { type: String, default: 'live-map-3d' },
});

function formatInteger(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '--';
}

function formatSigned(value) {
  if (!Number.isFinite(value)) return '--';
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString('en-US')}`;
}

function formatHeading(value) {
  if (!Number.isFinite(value)) return '---';
  return String(Math.round(((value % 360) + 360) % 360)).padStart(3, '0');
}

const tiles = computed(() => {
  const hud = props.hud || {};
  return [
    { key: 'alt', label: 'ALT', value: formatInteger(hud.altitudeFt), unit: 'ft' },
    { key: 'agl', label: 'AGL', value: formatInteger(hud.aglFt), unit: 'ft' },
    { key: 'gs', label: 'GS', value: formatInteger(hud.groundSpeedKts), unit: 'kt' },
    { key: 'vs', label: 'V/S', value: formatSigned(hud.verticalSpeedFpm), unit: 'fpm' },
    { key: 'hdg', label: 'HDG', value: formatHeading(hud.headingDeg), unit: 'deg' },
    { key: 'ias', label: 'IAS', value: formatInteger(hud.iasKts), unit: 'kt' },
  ];
});
</script>

<template>
  <div :id="`${idPrefix}-hud`" class="map-3d-hud" role="group" aria-label="Live flight readouts">
    <div
      v-for="tile in tiles"
      :key="tile.key"
      class="map-3d-hud-tile"
      :data-hud-key="tile.key"
    >
      <span class="map-3d-hud-label">{{ tile.label }}</span>
      <span class="map-3d-hud-value">{{ tile.value }}</span>
      <span class="map-3d-hud-unit">{{ tile.unit }}</span>
    </div>
  </div>
</template>
