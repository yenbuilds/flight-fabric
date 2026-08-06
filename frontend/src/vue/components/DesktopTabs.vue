<script setup>
import TabIcon from './TabIcon.vue';
import { DESKTOP_TABS } from '../tab-config.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import { useTabsStore } from '../stores/tabs.js';

const tabs = useTabsStore();
const aircraftSpecific = useAircraftSpecificStore();
</script>

<template>
  <section class="desktop-tab-stage" aria-label="Workspace navigation">
    <nav class="desktop-tab-bar" aria-label="Primary navigation">
      <button
        v-for="tab in DESKTOP_TABS"
        :key="tab.id"
        class="desktop-tab"
        :class="{ active: tabs.activeTabId === tab.id }"
        :data-tab="tab.id"
        :aria-label="tab.id === 'autopilot' && aircraftSpecific.controlsSetupRequired
          ? `${tab.label}, setup required`
          : tab.label"
        :aria-current="tabs.activeTabId === tab.id ? 'page' : undefined"
        :aria-controls="`tab-${tab.id}`"
        type="button"
        @click="tabs.requestTabChange(tab.id)"
      >
        <TabIcon :kind="tab.icon" />
        <span>{{ tab.label }}</span>
        <span
          v-if="tab.id === 'autopilot' && aircraftSpecific.controlsSetupRequired"
          class="ml-0.5 inline-block h-2 w-2 shrink-0 rounded-full bg-amber-400 shadow-[0_0_0_2px_rgba(251,191,36,0.14)]"
          data-aircraft-setup-indicator
          title="Aircraft controls require setup"
          aria-hidden="true"
        ></span>
      </button>
    </nav>
  </section>
</template>
