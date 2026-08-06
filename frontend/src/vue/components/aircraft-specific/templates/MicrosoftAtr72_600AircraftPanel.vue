<script setup>
import StandardAircraftMonitoringPanel from './StandardAircraftMonitoringPanel.vue';

const props = defineProps({
  values: { type: Object, default: () => ({}) },
  unavailable: { type: Array, default: () => [] },
  sourceStatus: { type: String, default: 'awaiting-values' },
});

const modes = [
  { id: 'fgcp.apMaster', label: 'AP' },
  { id: 'fgcp.flightDirector', label: 'FD' },
  { id: 'fgcp.headingSelect', label: 'HDG SEL' },
  { id: 'fgcp.altitudeMode', label: 'ALT' },
  { id: 'fgcp.verticalSpeedMode', label: 'V/S' },
  { id: 'fgcp.approach', label: 'APP' },
];

// The ATR adapter deliberately exposes only fields with an actual backend
// binding. TURN OFF is omitted until a distinct ATR readback is verified.
const lightFields = [
  { id: 'lights.strobe', label: 'STROBE' },
  { id: 'lights.beacon', label: 'BEACON' },
  { id: 'lights.nav', label: 'NAV' },
  { id: 'lights.logo', label: 'LOGO' },
  { id: 'lights.wing', label: 'WING' },
  { id: 'lights.landing', label: 'LANDING' },
  { id: 'lights.taxi', label: 'TAXI' },
];
</script>

<template>
  <StandardAircraftMonitoringPanel
    template-id="microsoft-atr-72-600"
    title="Microsoft / S&amp;H Software ATR 72-600"
    subtitle="Expert Series passenger-variant monitoring page for MSFS 2020 and MSFS 2024."
    guidance-label="Flight Guidance Control Panel"
    guidance-prefix="fgcp"
    :mode-indicators="modes"
    :light-fields="lightFields"
    :values="props.values"
    :unavailable="props.unavailable"
    :source-status="props.sourceStatus"
  />
</template>
