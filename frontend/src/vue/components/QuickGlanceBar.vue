<script setup>
import { useFlightStore } from '../stores/flight.js';

const flight = useFlightStore();
</script>

<template>
  <div class="qg-item">
    <div class="qg-label">IAS</div>
    <div>
      <span id="qg-ias" class="qg-value">{{ flight.telemetry.quickGlance.ias }}</span>
      <span class="qg-unit"> kt</span>
    </div>
  </div>
  <div class="qg-item">
    <div class="qg-label">V/S</div>
    <div>
      <span id="qg-vs" class="qg-value">{{ flight.telemetry.quickGlance.vs }}</span>
      <span class="qg-unit"> fpm</span>
    </div>
  </div>
  <div class="qg-item">
    <div class="qg-label">RA</div>
    <div>
      <span id="qg-ra" class="qg-value">{{ flight.telemetry.quickGlance.ra }}</span>
      <span class="qg-unit"> ft</span>
    </div>
  </div>
  <div class="qg-item">
    <div class="qg-label">GEAR</div>
    <div class="qg-gear">
      <span id="qg-gear-l" :class="flight.quickGlanceGearDotClass('left')"></span>
      <span id="qg-gear-c" :class="flight.quickGlanceGearDotClass('nose')"></span>
      <span id="qg-gear-r" :class="flight.quickGlanceGearDotClass('right')"></span>
    </div>
  </div>
</template>
