<script setup>
import { computed, ref } from 'vue';
import AppTooltip from './AppTooltip.vue';
import { useTimelineStore } from '../stores/timeline.js';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';

const timeline = useTimelineStore();
const wrapEl = ref(null);
const toggleButton = ref(null);

const FILTER_OPTIONS = [
  { key: 'violations', label: 'Cautions & violations' },
  { key: 'landing', label: 'Landing' },
  { key: 'automation', label: 'Automation' },
  { key: 'flightGuidance', label: 'Flight Guidance' },
  { key: 'markers', label: 'Markers' },
  { key: 'phases', label: 'Phases' },
  { key: 'scores', label: 'Scores' },
];
const hiddenTypeCount = computed(() => FILTER_OPTIONS.filter(option => timeline.mapFilters[option.key] !== true).length);

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
  if (timeline.mapFilterMenuOpen) {
    event.preventDefault();
    event.stopPropagation();
    timeline.closeMapFilterMenu();
    toggleButton.value?.focus({ preventScroll: true });
  }
}

useDocumentEvent('click', closeOnOutsideClick);
</script>

<template>
  <div ref="wrapEl" class="timeline-map-filter-wrap relative" @keydown.esc="closeOnEscape">
    <AppTooltip content="Filter events on the map only">
      <button
        ref="toggleButton"
        id="map-filter-toggle"
        type="button"
        class="flex items-center gap-1.5 px-2 py-1 text-xs text-gray-400 border border-surface-300 hover:border-accent/40 hover:text-gray-200 transition-colors"
        :aria-expanded="timeline.mapFilterMenuOpen"
        aria-controls="map-filter-dropdown"
        @click="toggleMenu"
      >
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z"
          />
        </svg>
        Map events
        <span v-if="hiddenTypeCount" class="text-primary">{{ hiddenTypeCount }} {{ hiddenTypeCount === 1 ? 'type' : 'types' }} off</span>
      </button>
    </AppTooltip>
    <div
      id="map-filter-dropdown"
      class="absolute right-0 top-full mt-1 z-50 bg-panel border border-border shadow-lg p-3 w-64 max-w-[calc(100vw-2rem)] max-h-72 overflow-y-auto overscroll-contain"
      :class="{ hidden: !timeline.mapFilterMenuOpen }"
      role="group"
      aria-label="Filter map events"
    >
      <div class="text-[10px] uppercase tracking-widest text-gray-500 mb-2">Show on map</div>
      <p class="mb-2 text-xs text-muted-fg">These filters affect map markers only. The event list is filtered separately.</p>
      <div id="timeline-map-filters" class="flex flex-col gap-2 text-xs text-gray-300">
        <label
          v-for="option in FILTER_OPTIONS"
          :key="option.key"
          class="inline-flex min-h-[44px] items-center gap-2 cursor-pointer select-none"
        >
          <input
            :checked="timeline.mapFilters[option.key] === true"
            type="checkbox"
            class="map-filter-cb"
            :data-timeline-map-filter="option.key"
            @change="timeline.setMapFilter(option.key, $event.target.checked)"
          >
          <span>{{ option.label }}</span>
        </label>
      </div>
    </div>
  </div>
</template>
