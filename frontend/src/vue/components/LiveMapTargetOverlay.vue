<script setup>
import { useLiveMapStore } from '../stores/live-map.js';

const liveMap = useLiveMapStore();
</script>

<template>
  <div
    id="live-map-target-overlay"
    class="live-map-target-overlay"
    :style="{ display: liveMap.overlayVisible ? 'flex' : 'none' }"
  >
    <span id="live-map-target-arrow" class="live-map-target-arrow" :style="liveMap.overlayArrowStyle">&uarr;</span>
    <span class="live-map-target-text">
      <span id="live-map-target-primary">{{ liveMap.overlayPrimary }}</span>
      <span id="live-map-target-secondary" class="text-gray-400">{{ liveMap.overlaySecondary }}</span>
    </span>
  </div>
</template>
