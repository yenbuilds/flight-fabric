<script setup>
import AppTooltip from './AppTooltip.vue';
import FlightMetricWatermark from './FlightMetricWatermark.vue';
import { useFlightStore } from '../stores/flight.js';
import { usePreferencesStore } from '../stores/preferences.js';

const flight = useFlightStore();
const preferences = usePreferencesStore();

const warningBannerBaseClass = 'flight-global-warning fixed top-4 left-1/2 transform -translate-x-1/2 px-6 py-3 text-white font-bold text-xl rounded-lg shadow-lg z-50 animate-pulse';
const primaryGridClass = 'telemetry-grid-primary grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 lg:gap-5';
const secondaryGridClass = 'telemetry-grid-secondary grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 lg:gap-5';
const primaryCardClass = 'flight-metric-card flight-metric-card--primary telemetry-card-primary card-hover bg-surface-100 border border-surface-200 rounded-lg p-4 lg:p-5';
const secondaryCardClass = 'flight-metric-card flight-metric-card--secondary telemetry-card-secondary card-hover bg-surface-100 border border-surface-200 rounded-lg p-4 lg:p-5';
const systemCardClass = 'flight-system-card card-hover bg-surface-100 border border-surface-200 rounded-lg p-3';
const environmentCardClass = 'flight-environment-card card-hover bg-surface-100 border rounded-lg p-4';
const telemetryValueLargeClass = 'text-3xl sm:text-4xl lg:text-5xl font-semibold tabular telemetry-value';
const telemetryValueMediumClass = 'text-2xl sm:text-3xl font-semibold tabular telemetry-value';
const telemetryValueSystemClass = 'text-xl lg:text-2xl font-semibold telemetry-value';
const environmentLabelClass = 'flight-card-caption text-xs text-gray-500 uppercase tracking-wider mb-1';
const environmentUnitClass = 'flight-card-unit text-sm text-gray-500';
const metricWatermarkCardClass = 'relative isolate min-w-0 overflow-hidden';

const primaryMetricCards = [
  { cardId: 'ias-card', label: 'Airspeed', valueId: 'ias-value', valueKey: 'ias', unit: 'kt', watermark: 'airspeed', speedWarning: true },
  { cardId: 'vs-card', label: 'V/S', valueId: 'vs-value', valueKey: 'vs', unit: 'fpm', watermark: 'vertical-speed', toneKey: 'vs' },
  { cardId: 'alt-card', label: 'Altitude', valueId: 'alt-value', valueKey: 'alt', unit: 'ft', watermark: 'altitude' },
  { cardId: 'ra-card', label: 'Radio Alt', valueId: 'ra-value', valueKey: 'ra', unit: 'ft', watermark: 'radio-altitude', toneKey: 'ra', visibleKey: 'raVisible' },
];

const environmentCards = [
  { cardId: 'cabin-alt-card', label: 'Cabin Alt', valueId: 'cabin-alt-value', valueKey: 'cabinAlt', toneKey: 'cabinAlt', unit: 'ft', cardToneKey: 'cabinAltCardToneClass' },
  { cardId: 'cabin-vs-card', label: 'Cabin V/S', valueId: 'cabin-vs-value', valueKey: 'cabinVs', toneKey: 'cabinVs', unit: 'fpm' },
  { cardId: 'oat-card', label: 'OAT', valueId: 'oat-value', valueKey: 'oat', unit: '\u00b0C' },
];

const altitudeDiagnosticCards = [
  { cardId: 'alt-diag-indicated-card', label: 'Cockpit indicated', valueId: 'alt-diag-indicated-value', valueKey: 'indicated', unit: 'ft' },
  { cardId: 'alt-diag-calibrated-card', label: 'Calibrated indicated', valueId: 'alt-diag-calibrated-value', valueKey: 'calibrated', unit: 'ft' },
  { cardId: 'alt-diag-plane-card', label: 'MSFS plane altitude', valueId: 'alt-diag-plane-value', valueKey: 'plane', unit: 'ft' },
  { cardId: 'alt-diag-pressure-card', label: 'Pressure altitude', valueId: 'alt-diag-pressure-value', valueKey: 'pressure', unit: 'ft' },
  { cardId: 'alt-diag-radio-card', label: 'Radio height', valueId: 'alt-diag-radio-value', valueKey: 'radio', unit: 'ft' },
  { cardId: 'alt-diag-aircraft-agl-card', label: 'Aircraft AGL', valueId: 'alt-diag-aircraft-agl-value', valueKey: 'aircraftAgl', unit: 'ft' },
  { cardId: 'alt-diag-obstacles-card', label: 'Above obstacles', valueId: 'alt-diag-obstacles-value', valueKey: 'aircraftAboveObstacles', unit: 'ft' },
  { cardId: 'alt-diag-plane-agl-card', label: 'Plane AGL', valueId: 'alt-diag-plane-agl-value', valueKey: 'planeAgl', unit: 'ft' },
  { cardId: 'alt-diag-plane-agl-cg-card', label: 'Plane AGL minus CG', valueId: 'alt-diag-plane-agl-cg-value', valueKey: 'planeAglMinusCg', unit: 'ft' },
  { cardId: 'alt-diag-baro-effective-card', label: 'Baro effective', valueId: 'alt-diag-baro-effective-value', valueKey: 'kohlsmanSettingMb', unit: 'hPa' },
  { cardId: 'alt-diag-baro-tuned-card', label: 'Baro tuned', valueId: 'alt-diag-baro-tuned-value', valueKey: 'kohlsmanTunedMb', unit: 'hPa' },
  { cardId: 'alt-diag-baro-mode-card', label: 'Baro mode', valueId: 'alt-diag-baro-mode-value', valueKey: 'kohlsmanStd', unit: '' },
];

const lightItems = [
  { id: 'light-nav', name: 'nav', label: 'NAV' },
  { id: 'light-bcn', name: 'beacon', label: 'BCN' },
  { id: 'light-strb', name: 'strobe', label: 'STRB' },
  { id: 'light-ldg', name: 'landing', label: 'LDG' },
  { id: 'light-taxi', name: 'taxi', label: 'TAXI' },
];
</script>

<template>
  <div id="flight-live-shell" class="flight-live-shell" :class="{ 'is-muted': flight.muted }">
    <div
      id="fuel-exhausted-banner"
      :class="[warningBannerBaseClass, 'bg-amber-600', { hidden: !flight.fuelExhaustedWarningVisible }]"
    >
      FUEL EXHAUSTED
    </div>

    <div
      id="cabin-altitude-banner"
      :class="[warningBannerBaseClass, 'bg-red-600', { hidden: !flight.cabinAltitudeBannerVisible }]"
    >
      {{ flight.cabinAltitudeBannerLabel }}
    </div>

    <div id="flight-primary-grid" :class="primaryGridClass">
      <div
        v-for="card in primaryMetricCards"
        v-show="!card.visibleKey || flight.telemetry[card.visibleKey]"
        :id="card.cardId"
        :key="card.cardId"
        :class="[primaryCardClass, metricWatermarkCardClass]"
      >
        <FlightMetricWatermark :kind="card.watermark" />
        <div class="relative z-10">
          <div class="telemetry-label">{{ card.label }}</div>
          <div class="flex items-baseline gap-1">
            <span :id="card.valueId" :class="[telemetryValueLargeClass, card.toneKey ? flight.valueToneClass(card.toneKey) : '']">{{ flight.telemetry[card.valueKey] }}</span>
            <span class="telemetry-unit">{{ card.unit }}</span>
          </div>
        </div>
        <div
          v-if="card.speedWarning"
          class="warning-banner flight-inline-warning absolute inset-0 flex items-center justify-center bg-red-600/90 rounded-lg z-20 animate-pulse"
          :class="{ hidden: !flight.speedWarningVisible }"
        >
          <span class="text-white font-bold text-xl tracking-wider">{{ flight.speedWarningLabel }}</span>
        </div>
      </div>
    </div>

    <div id="flight-secondary-grid" :class="secondaryGridClass">
      <div id="gs-card" :class="[secondaryCardClass, metricWatermarkCardClass]">
        <FlightMetricWatermark kind="ground-speed" />
        <div class="relative z-10">
          <div class="telemetry-label">Ground Speed</div>
          <div class="flex items-baseline gap-1">
            <span id="gs-value" :class="telemetryValueLargeClass">{{ flight.telemetry.gs }}</span>
            <span class="telemetry-unit">kt</span>
          </div>
        </div>
      </div>

      <div id="hdg-card" :class="[secondaryCardClass, metricWatermarkCardClass]">
        <FlightMetricWatermark kind="heading" />
        <div class="relative z-10">
          <div class="telemetry-label">Heading</div>
          <div class="flex items-baseline gap-1">
            <span id="hdg-value" :class="telemetryValueLargeClass">{{ flight.telemetry.hdg }}</span>
            <span class="telemetry-unit">&deg;</span>
          </div>
        </div>
      </div>

      <div id="xwind-card" :class="[secondaryCardClass, metricWatermarkCardClass, 'col-span-2 sm:col-span-1']">
        <FlightMetricWatermark kind="crosswind" />
        <div class="relative z-10">
          <div class="telemetry-label">Crosswind</div>
          <div class="flex items-center gap-2">
            <span id="xwind-arrow" class="text-2xl lg:text-3xl" :style="flight.xwindArrowStyle">{{ flight.telemetry.xwindArrow }}</span>
            <div class="flex items-baseline gap-1">
              <span id="xwind-value" :class="[telemetryValueLargeClass, flight.valueToneClass('xwind')]">{{ flight.telemetry.xwind }}</span>
              <span class="telemetry-unit">kt</span>
            </div>
          </div>
        </div>
      </div>

      <div id="fuel-card" :class="[secondaryCardClass, metricWatermarkCardClass]">
        <FlightMetricWatermark kind="fuel" />
        <div class="relative z-10">
          <div class="flex items-center justify-between mb-1">
            <div class="telemetry-label">Fuel</div>
            <AppTooltip content="Toggle fuel unit (gal / lbs / kg)">
              <button
                id="fuel-unit-btn"
                class="flight-unit-toggle transition-colors tabular rounded"
                @click="preferences.requestFuelUnitCycle()"
              >{{ flight.telemetry.fuelUnit }}</button>
            </AppTooltip>
          </div>
          <div class="flex items-baseline gap-1">
            <span id="fuel-value" :class="[telemetryValueLargeClass, flight.valueToneClass('fuel')]">{{ flight.telemetry.fuel }}</span>
            <span id="fuel-unit-label" class="telemetry-unit">{{ flight.telemetry.fuelUnit }}</span>
          </div>
        </div>
      </div>
    </div>

    <details id="flight-altitude-diagnostics" class="flight-section-block flight-altitude-diagnostics">
      <summary id="flight-altitude-diagnostics-toggle" class="dashboard-section-kicker flight-altitude-diagnostics-summary">
        <span>Altitude diagnostics</span>
        <span class="flight-altitude-diagnostics-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div id="flight-altitude-diagnostics-grid" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
        <div
          v-for="card in altitudeDiagnosticCards"
          :id="card.cardId"
          :key="card.cardId"
          :class="secondaryCardClass"
        >
          <div class="flight-card-caption text-xs text-gray-500 uppercase tracking-wider mb-1">{{ card.label }}</div>
          <div class="flex items-baseline gap-1">
            <span :id="card.valueId" :class="telemetryValueMediumClass">{{ flight.telemetry.altitudeDiagnostics[card.valueKey] }}</span>
            <span v-if="card.unit" class="flight-card-unit text-sm text-gray-500">{{ card.unit }}</span>
          </div>
        </div>
      </div>
    </details>

    <div class="dashboard-section-kicker">Systems</div>

    <div id="flight-systems-grid" class="telemetry-grid-systems grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 lg:gap-5 mt-0">
      <div id="gear-card" :class="systemCardClass">
        <div class="telemetry-label">Gear</div>
        <div id="gear-state" :class="telemetryValueSystemClass" style="font-family: 'B612 Mono', monospace;">{{ flight.telemetry.gearState }}</div>
        <div class="flight-gear-indicators flex items-center justify-center gap-2 lg:gap-3">
          <AppTooltip content="Nose" anchor-tag="div"><div id="gear-n" :class="flight.gearDotClass('nose')"></div></AppTooltip>
          <AppTooltip content="Left" anchor-tag="div"><div id="gear-l" :class="flight.gearDotClass('left')"></div></AppTooltip>
          <AppTooltip content="Right" anchor-tag="div"><div id="gear-r" :class="flight.gearDotClass('right')"></div></AppTooltip>
        </div>
        <div class="flex justify-center">
          <AppTooltip content="Parking Brake" anchor-tag="div"><div id="parking-brake" :class="flight.parkingBrakeClass">P/BRK</div></AppTooltip>
        </div>
      </div>

      <div id="flaps-card" :class="systemCardClass">
        <div class="telemetry-label">Flaps</div>
        <div class="flex items-baseline gap-1">
          <span id="flaps-value" :class="telemetryValueSystemClass">{{ flight.telemetry.flaps }}</span>
          <span id="flaps-unit" class="telemetry-unit">{{ flight.telemetry.flapsUnit }}</span>
        </div>
      </div>

      <div id="spoilers-card" :class="systemCardClass">
        <div class="telemetry-label">Spoilers</div>
        <div id="spoilers-value" :class="telemetryValueSystemClass" style="font-family: 'B612 Mono', monospace;">{{ flight.telemetry.spoilers }}</div>
      </div>
    </div>

    <div class="flight-section-block">
      <div class="dashboard-section-kicker">Lights</div>
      <div id="lights-bar" class="flight-lights-bar flex flex-wrap gap-2" :class="{ hidden: !flight.telemetry.lights.available }">
        <div
          v-for="light in lightItems"
          :id="light.id"
          :key="light.name"
          :class="flight.lightClass(light.name)"
          :data-light="light.name"
        >
          {{ light.label }}
        </div>
      </div>
      <p id="lights-na" class="flight-empty-copy text-sm text-gray-500 italic" :class="{ hidden: flight.telemetry.lights.available }">Light data not available for this aircraft.</p>
    </div>

    <div class="flight-section-block">
      <div class="dashboard-section-kicker">Engines</div>
      <div id="engines-grid" class="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        <div
          v-for="engine in flight.engineCards"
          :id="`eng${engine.number}-card`"
          :key="engine.number"
          class="flight-engine-card card-hover bg-surface-100 border border-surface-200 rounded-lg p-4 text-center"
          :class="{ hidden: !engine.visible }"
        >
          <div class="flight-card-caption text-xs text-gray-500 mb-1">ENG {{ engine.number }}</div>
          <div :id="`eng${engine.number}-value`" class="text-2xl sm:text-3xl font-semibold tabular telemetry-value">{{ engine.value }}</div>
        </div>
      </div>
    </div>

    <div class="flight-section-block">
      <div class="dashboard-section-kicker">Environment</div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        <div
          v-for="card in environmentCards"
          :id="card.cardId"
          :key="card.cardId"
          :class="[environmentCardClass, card.cardToneKey ? flight[card.cardToneKey] : 'border-surface-200']"
        >
          <div :class="environmentLabelClass">{{ card.label }}</div>
          <div class="flex items-baseline gap-1">
            <span :id="card.valueId" :class="[telemetryValueMediumClass, card.toneKey ? flight.valueToneClass(card.toneKey) : '']">{{ flight.telemetry[card.valueKey] }}</span>
            <span :class="environmentUnitClass">{{ card.unit }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
