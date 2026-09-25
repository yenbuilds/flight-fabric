<script setup>
import { computed } from 'vue';
const presetWatermark = new URL('../../../assets/aircraft-presets.svg', import.meta.url).href;
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import AircraftQuickActions from './AircraftQuickActions.vue';
import CockpitLightingPresets from './CockpitLightingPresets.vue';

const controls = useAircraftControlsStore();
const available = computed(() => Object.values(controls.aircraftCommandCatalogue.commands || {})
  .some(command => command.kind === 'preset'));
</script>

<template>
  <section v-if="available" id="aircraft-page-presets" class="aircraft-presets aircraft-mobile-navigable-section"
    tabindex="-1" aria-labelledby="aircraft-presets-title" data-aircraft-presets-section>
    <div class="aircraft-presets__art" aria-hidden="true">
      <img class="aircraft-presets__watermark" :src="presetWatermark" alt="" />
    </div>
    <header class="aircraft-presets__heading">
      <span class="aircraft-presets__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" focusable="false">
          <path d="m12 3 9 5-9 5-9-5 9-5Z" />
          <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
        </svg>
      </span>
      <div>
        <h2 id="aircraft-presets-title" class="text-base font-semibold text-gray-100">Presets</h2>
        <p class="mt-1 text-xs text-muted-fg">Apply a group of settings together.</p>
      </div>
    </header>
    <AircraftQuickActions class="aircraft-presets__content" />
    <CockpitLightingPresets embedded class="aircraft-presets__content" />
  </section>
</template>

<style scoped>
.aircraft-presets {
  width: 100%;
  min-width: 0;
  position: relative;
  isolation: isolate;
  padding: 1rem;
  border: 1px solid rgb(var(--color-accent) / 0.32);
  border-radius: 0.75rem;
  background:
    radial-gradient(ellipse at 100% 0%, rgb(var(--color-accent) / 0.09), transparent 65%),
    rgb(var(--color-surface-50) / 0.35);
  box-shadow: inset 3px 0 0 rgb(var(--color-accent) / 0.55);
}
.aircraft-presets__art {
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
  user-select: none;
  color: rgb(var(--color-accent));
}
.aircraft-presets__watermark {
  position: absolute;
  top: -4rem;
  right: -1.5rem;
  width: 35rem;
  max-width: none;
  height: auto;
}
.aircraft-presets__heading,
.aircraft-presets__content {
  position: relative;
}
.aircraft-presets__heading {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.aircraft-presets__icon {
  display: grid;
  place-items: center;
  flex: 0 0 2.5rem;
  height: 2.5rem;
  border: 1px solid rgb(var(--color-accent) / 0.3);
  border-radius: 0.625rem;
  background: rgb(var(--color-accent) / 0.08);
  color: rgb(var(--color-accent));
}
.aircraft-presets__icon svg {
  width: 1.4rem;
  height: 1.4rem;
}
.aircraft-presets > :deep([data-aircraft-quick-actions]) {
  padding: 0;
  border: 0;
  background: transparent;
}
.aircraft-presets :deep([data-aircraft-quick-actions] + [data-cockpit-lighting-presets]) {
  margin-top: 0.75rem;
}
@media (max-width: 600px) {
  .aircraft-presets__watermark {
    right: -9rem;
    opacity: 0.5;
  }
}
@media (forced-colors: active) {
  .aircraft-presets__art {
    display: none;
  }
}
</style>
