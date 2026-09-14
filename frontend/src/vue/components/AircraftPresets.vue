<script setup>
import { computed } from 'vue';
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
      <svg class="aircraft-presets__watermark" viewBox="0 0 560 280" fill="none" focusable="false">
        <g stroke="currentColor" stroke-width="1">
          <circle cx="398" cy="136" r="106" opacity="0.3" />
          <circle cx="398" cy="136" r="85" stroke-dasharray="2 9" opacity="0.35" />
          <path d="M398 20v16m0 200v16M282 136h16m200 0h16M316 54l11 11m142 142 11 11M316 218l11-11M469 65l11-11" opacity="0.4" />
          <path d="M32 232h116c76 0 81-96 157-96h45M142 254h84c91 0 63-67 136-67" stroke-dasharray="4 7" opacity="0.3" />
          <circle cx="148" cy="232" r="4" opacity="0.5" />
          <circle cx="226" cy="254" r="4" opacity="0.5" />
        </g>
        <g transform="translate(398 136) rotate(35)">
          <path d="M0-76c4 0 6 8 6 16v36l65 42v11L6 5v45l21 17v8L0 65l-27 10v-8l21-17V5l-65 24V18l65-42v-36c0-8 2-16 6-16Z"
            fill="currentColor" fill-opacity="0.07" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.3" stroke-linejoin="round" />
          <path d="M0-58V54M-53 19l47-31M53 19 6-12M-17 67l17-6 17 6" stroke="currentColor" stroke-opacity="0.25" />
        </g>
      </svg>
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
