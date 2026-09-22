<script setup>
import { computed } from 'vue';
import { useTakeoffStore } from '../stores/takeoff.js';
import { useTabsStore } from '../stores/tabs.js';

const takeoff = useTakeoffStore();
const tabs = useTabsStore();

const gradeStyle = computed(() => ({
  color: takeoff.preview.gradeColor || '#4a5e74',
}));
</script>

<template>
  <div
    id="data-last-takeoff-card"
    class="flight-summary-card ff-panel bg-surface-100 border border-surface-200 overflow-hidden"
  >
    <div class="p-3 sm:p-4 border-b border-surface-200 flex items-center justify-between gap-3">
      <div>
        <div class="ff-kicker">Last Takeoff</div>
        <div id="data-last-takeoff-status" class="text-xs text-muted-fg mt-0.5">{{ takeoff.preview.status }}</div>
      </div>
      <button
        id="data-open-takeoff-btn"
        type="button"
        :disabled="!takeoff.preview.available"
        class="ff-button-secondary flight-summary-action px-3 py-2 text-xs font-medium rounded transition-colors"
        @click="tabs.requestTabChange('landing')"
      >
        Full Report
      </button>
    </div>
    <div v-show="takeoff.preview.available" class="grid grid-cols-2 lg:grid-cols-6 divide-x divide-y lg:divide-y-0 divide-surface-200">
      <div class="px-4 py-3">
        <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Runway use grade</div>
        <div
          id="data-last-takeoff-grade"
          class="text-base font-semibold tabular"
          style="font-family:'B612 Mono',monospace;letter-spacing:0.06em;"
          :style="gradeStyle"
        >
          {{ takeoff.preview.grade }}
        </div>
      </div>
      <div class="px-4 py-3">
        <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Runway remaining</div>
        <div id="data-last-takeoff-remaining" class="text-base font-semibold tabular" :class="takeoff.preview.remainingTone" style="font-family:'B612 Mono',monospace;">{{ takeoff.preview.remaining }}</div>
        <div v-if="takeoff.preview.remainingDetail" class="mt-0.5 text-[10px] text-gray-500">{{ takeoff.preview.remainingDetail }}</div>
      </div>
      <div class="px-4 py-3">
        <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Ground roll</div>
        <div id="data-last-takeoff-roll" class="text-base font-semibold tabular text-gray-200" style="font-family:'B612 Mono',monospace;">{{ takeoff.preview.roll }}</div>
      </div>
      <div class="px-4 py-3">
        <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Liftoff speed</div>
        <div id="data-last-takeoff-ias" class="text-base font-semibold tabular text-gray-200" style="font-family:'B612 Mono',monospace;">{{ takeoff.preview.liftoff }}</div>
      </div>
      <div class="px-4 py-3">
        <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Screen height</div>
        <div id="data-last-takeoff-screen" class="text-base font-semibold tabular" :class="takeoff.preview.screenTone" style="font-family:'B612 Mono',monospace;">{{ takeoff.preview.screen }}</div>
      </div>
      <div class="px-4 py-3">
        <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Runway</div>
        <div id="data-last-takeoff-runway" class="text-base font-semibold tabular text-gray-200" style="font-family:'B612 Mono',monospace;">{{ takeoff.preview.runway }}</div>
      </div>
    </div>
  </div>
</template>
