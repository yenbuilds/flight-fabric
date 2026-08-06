<script setup>
import { useFlightStore } from '../stores/flight.js';

const flight = useFlightStore();
</script>

<template>
  <div
    id="flight-state-panel"
    class="flight-state-panel ff-panel ff-panel-hero"
    role="status"
    aria-live="polite"
    :hidden="!flight.flightStateVisible"
  >
    <div class="flight-state-eyebrow">Flight Feed</div>
    <div id="flight-state-title" class="flight-state-title">{{ flight.title }}</div>
    <div id="flight-state-copy" class="flight-state-copy">{{ flight.copy }}</div>
  </div>
</template>
