<script setup>
import FlightStatePanel from './FlightStatePanel.vue';
import FlightTelemetryPanel from './FlightTelemetryPanel.vue';
import LastLandingSummary from './LastLandingSummary.vue';
</script>

<template>
  <div>
    <div class="menu-overlay">
      <div class="menu-overlay-content text-center">
        <div class="menu-overlay-kicker">SIM IS IN MENUS</div>
        <div class="menu-overlay-copy">Live flight data paused. Start a flight to wake the dashboard back up.</div>
      </div>
    </div>
    <div id="vue-flight-state-root">
      <FlightStatePanel />
    </div>
    <div id="vue-flight-telemetry-root">
      <FlightTelemetryPanel />
    </div>
    <div id="vue-last-landing-root">
      <LastLandingSummary />
    </div>
  </div>
</template>
