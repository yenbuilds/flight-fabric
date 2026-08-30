<script setup>
import { ref } from 'vue';
import AppTooltip from './AppTooltip.vue';
import { useTimelineStore } from '../stores/timeline.js';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';

const timeline = useTimelineStore();
const wrapEl = ref(null);

const FILTER_OPTIONS = [
  { key: 'violations', label: 'Violations' },
  { key: 'landing', label: 'Landing' },
  { key: 'automation', label: 'Automation' },
  { key: 'flightGuidance', label: 'Flight Guidance' },
  { key: 'markers', label: 'Markers' },
  { key: 'phases', label: 'Phases' },
  { key: 'scores', label: 'Scores' },
];

function toggleMenu(event) {
  event?.stopPropagation?.();
  timeline.toggleMapFilterMenu();
}

function closeOnOutsideClick(event) {
  if (!timeline.mapFilterMenuOpen) return;
  if (wrapEl.value && wrapEl.value.contains(event.target)) return;
  timeline.closeMapFilterMenu();
}

function closeOnEscape(event) {
  if (event.key === 'Escape' && timeline.mapFilterMenuOpen) {
    timeline.closeMapFilterMenu();
  }
}

useDocumentEvent('click', closeOnOutsideClick);
useDocumentEvent('keydown', closeOnEscape);
</script>

<template>
  <div ref="wrapEl" class="timeline-map-filter-wrap relative">
    <AppTooltip content="Map layer filters">
      <button
        id="map-filter-toggle"
        type="button"
        class="flex items-center gap-1.5 px-2 py-1 text-xs text-gray-400 border border-surface-300 hover:border-accent/40 hover:text-gray-200 transition-colors"
        @click="toggleMenu"
      >
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z"
          />
        </svg>
        Layers
      </button>
    </AppTooltip>
    <div
      id="map-filter-dropdown"
      class="absolute right-0 top-full mt-1 z-50 bg-surface-100 border border-surface-200 shadow-lg p-3 min-w-max"
      :class="{ hidden: !timeline.mapFilterMenuOpen }"
      style="box-shadow: 0 4px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,212,255,0.08);"
    >
      <div class="text-[10px] uppercase tracking-widest text-gray-500 mb-2">Show on map</div>
      <div id="timeline-map-filters" class="flex flex-col gap-2 text-xs text-gray-300">
        <label
          v-for="option in FILTER_OPTIONS"
          :key="option.key"
          class="inline-flex items-center gap-2 cursor-pointer select-none"
        >
          <input
            :checked="timeline.mapFilters[option.key] === true"
            type="checkbox"
            class="map-filter-cb"
            @change="timeline.setMapFilter(option.key, $event.target.checked)"
          >
          <span>{{ option.label }}</span>
        </label>
      </div>
    </div>
  </div>
</template>
