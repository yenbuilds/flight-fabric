<script setup>
import { useTimelineStore } from '../stores/timeline.js';

const timeline = useTimelineStore();
</script>

<template>
  <div
    v-if="timeline.summaryVisible"
    class="px-3 sm:px-4 py-2 sm:py-3 bg-surface-50 border-b border-surface-200"
  >
    <div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-2 sm:gap-4 text-center text-xs">
      <div>
        <div class="text-gray-500 uppercase tracking-wider mb-0.5">Events</div>
        <div class="font-semibold text-gray-200">{{ timeline.eventCountText }}</div>
      </div>
      <div>
        <div class="text-gray-500 uppercase tracking-wider mb-0.5">Violations</div>
        <div class="font-semibold text-amber-400">{{ timeline.violationCountText }}</div>
      </div>
      <div>
        <div class="text-gray-500 uppercase tracking-wider mb-0.5">Duration</div>
        <div class="font-semibold text-gray-200">{{ timeline.durationText }}</div>
      </div>
      <div>
        <div class="text-gray-500 uppercase tracking-wider mb-0.5">Distance</div>
        <div class="font-semibold text-gray-200">{{ timeline.distanceText }}</div>
      </div>
      <div>
        <div class="text-gray-500 uppercase tracking-wider mb-0.5">Score Impact</div>
        <div :class="timeline.scoreImpactClass">{{ timeline.scoreImpactText }}</div>
      </div>
    </div>
    <div
      v-if="timeline.fuelBurnText && timeline.fuelBurnText !== '--'"
      class="mt-2 text-right text-[11px] text-gray-500"
    >
      Estimated fuel burn: <span class="text-gray-400">{{ timeline.fuelBurnText }}</span>
    </div>
  </div>
</template>
