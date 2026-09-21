<script setup>
import { computed } from 'vue';
import { formatVerticalScaleLabel } from '../../maps/three-d/view-mode.js';

const props = defineProps({
  legend: { type: Object, default: null },
  groundPlaneFt: { type: Number, default: null },
  verticalScale: { type: Number, default: null },
  terrainActive: { type: Boolean, default: false },
  terrainElevationFt: { type: Number, default: null },
  aboveTerrainFt: { type: Number, default: null },
  lighting: { type: Object, default: null },
  attribution: { type: Boolean, default: true },
  idPrefix: { type: String, default: 'map-3d' },
});

function formatValue(value, unit) {
  if (!Number.isFinite(value)) return '--';
  const rounded = Math.round(value);
  const text = Math.abs(rounded).toLocaleString('en-US');
  const sign = rounded < 0 ? '-' : (unit === 'fpm' && rounded > 0 ? '+' : '');
  return `${sign}${text}`;
}

const lowLabel = computed(() => {
  if (!props.legend) return '';
  if (props.legend.kind === 'diverging') {
    return `${props.legend.poleLabels?.low || 'Low'} ${formatValue(props.legend.lower, props.legend.unit)}`;
  }
  return formatValue(props.legend.lower, props.legend.unit);
});

const highLabel = computed(() => {
  if (!props.legend) return '';
  if (props.legend.kind === 'diverging') {
    return `${props.legend.poleLabels?.high || 'High'} ${formatValue(props.legend.upper, props.legend.unit)}`;
  }
  return formatValue(props.legend.upper, props.legend.unit);
});

const midLabel = computed(() => (
  props.legend?.kind === 'diverging' ? (props.legend.poleLabels?.mid || '') : ''
));

const scaleNote = computed(() => {
  const parts = [];
  if (props.terrainActive) {
    parts.push('Terrain');
  } else if (Number.isFinite(props.groundPlaneFt)) {
    parts.push(`Ground plane ${Math.round(props.groundPlaneFt).toLocaleString('en-US')} ft`);
  }
  if (Number.isFinite(props.verticalScale)) parts.push(formatVerticalScaleLabel(props.verticalScale));
  return parts.join(' · ');
});

const terrainNote = computed(() => {
  if (!props.terrainActive) return '';
  if (!Number.isFinite(props.terrainElevationFt)) return 'Terrain height: loading';
  const parts = [`Terrain below ${Math.round(props.terrainElevationFt).toLocaleString('en-US')} ft`];
  if (Number.isFinite(props.aboveTerrainFt)) {
    parts.push(`${Math.round(Math.max(0, props.aboveTerrainFt)).toLocaleString('en-US')} ft above`);
  }
  return parts.join(' · ');
});

const lightingNote = computed(() => {
  const lighting = props.lighting;
  if (!lighting) return '';
  if (lighting.source === 'day') return 'Daylight (fixed)';
  if (lighting.source === 'none') return '';
  const clock = lighting.source === 'sim' ? 'sim time' : (lighting.source === 'recording' ? 'recording clock' : 'real clock');
  const parts = [lighting.phaseLabel || ''];
  if (lighting.timeText) parts.push(`${lighting.timeText} ${clock}`);
  if (lighting.phase === 'night') parts.push('moonlight added so terrain stays visible');
  return parts.filter(Boolean).join(' · ');
});

const attributionText = computed(() => {
  if (!props.attribution) return '';
  return props.terrainActive
    ? '© OpenStreetMap contributors · Elevation: Mapzen terrain tiles (AWS Open Data)'
    : '© OpenStreetMap contributors';
});
</script>

<template>
  <div :id="`${idPrefix}-legend`" class="map-3d-legend" aria-live="polite">
    <template v-if="legend">
      <div class="map-3d-legend-title">
        <span>{{ legend.label }}</span>
        <span class="map-3d-legend-unit">{{ legend.unit }}</span>
      </div>
      <div class="map-3d-legend-bar" :style="{ background: legend.gradientCss }" aria-hidden="true"></div>
      <div class="map-3d-legend-labels">
        <span>{{ legend.hasData ? lowLabel : '--' }}</span>
        <span v-if="midLabel">{{ midLabel }}</span>
        <span>{{ legend.hasData ? highLabel : '--' }}</span>
      </div>
    </template>
    <div v-if="scaleNote" class="map-3d-legend-note">{{ scaleNote }}</div>
    <details class="map-3d-legend-details">
      <summary>Map details</summary>
      <div v-if="terrainNote" :id="`${idPrefix}-terrain-note`" class="map-3d-legend-note">{{ terrainNote }}</div>
      <div v-if="lightingNote" :id="`${idPrefix}-lighting-note`" class="map-3d-legend-note">{{ lightingNote }}</div>
      <div class="map-3d-legend-hint">Drag to orbit · Right-drag to pan · Scroll to zoom</div>
    </details>
    <div v-if="attributionText" class="map-3d-legend-attribution">{{ attributionText }}</div>
  </div>
</template>

<style scoped>
.map-3d-legend { max-height: calc(100% - 1.5rem); overflow-y: auto; overscroll-behavior: contain; pointer-events: auto; }
.map-3d-legend-details > summary { cursor: pointer; min-height: 2rem; align-content: center; color: rgb(var(--muted-foreground)); }
.map-3d-legend-details > summary:focus-visible { outline: 2px solid rgb(var(--selection)); outline-offset: -2px; }
.map-3d-legend-details[open] { display: grid; gap: 0.3rem; }
@media (pointer: coarse) {
  .map-3d-legend-details > summary { min-height: 2.75rem; }
}
</style>
