<script setup>
import { useLiveMapStore } from '../stores/live-map.js';

const liveMap = useLiveMapStore();
</script>

<template>
  <div id="dest-progress-wrap" :class="liveMap.destinationProgressVisible ? 'pb-2' : 'hidden pb-2'">
    <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[10px] text-gray-500 mb-1">
      <span id="dest-progress-label" :title="liveMap.destinationProgressTitle || undefined">{{ liveMap.destinationProgressLabel }}</span>
      <span id="dest-progress-text" class="whitespace-nowrap">{{ liveMap.destinationProgressText }}</span>
    </div>
    <div class="h-1.5 w-full bg-surface-200 rounded-full overflow-hidden">
      <div id="dest-progress-fill" class="dest-progress-fill h-full bg-accent rounded-full" :style="liveMap.destinationProgressWidthStyle"></div>
    </div>
  </div>
</template>
