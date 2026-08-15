<script setup>
import { watch } from 'vue';
import TabIcon from './TabIcon.vue';
import { MOBILE_MORE_TABS, MOBILE_PRIMARY_TABS } from '../tab-config.js';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import { useTabsStore } from '../stores/tabs.js';

const tabs = useTabsStore();
const aircraftSpecific = useAircraftSpecificStore();

function onKeydown(event) {
  if (event.key === 'Escape' && tabs.moreSheetOpen) {
    tabs.closeMoreSheet();
  }
}

watch(
  () => tabs.activeTabId,
  () => {
    tabs.closeMoreSheet();
  },
);

useDocumentEvent('keydown', onKeydown);
</script>

<template>
  <nav class="mobile-tab-bar" aria-label="Primary mobile navigation">
    <button
      v-for="tab in MOBILE_PRIMARY_TABS"
      :key="tab.id"
      class="mobile-tab relative"
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
        class="absolute right-2 top-2 inline-block h-2 w-2 rounded-full bg-amber-400 shadow-[0_0_0_2px_rgba(251,191,36,0.14)]"
        data-aircraft-setup-indicator
        title="Aircraft controls require setup"
        aria-hidden="true"
      ></span>
    </button>
    <button
      id="mobile-more-btn"
      class="mobile-tab"
      :class="{ active: tabs.isMoreTabActive }"
      type="button"
      aria-label="More navigation"
      aria-haspopup="true"
      :aria-expanded="tabs.moreSheetOpen ? 'true' : 'false'"
      aria-controls="mobile-more-sheet"
      @click="tabs.toggleMoreSheet()"
    >
      <TabIcon kind="more" />
      <span>More</span>
    </button>
  </nav>

  <div
    id="mobile-more-sheet"
    class="fixed inset-0 z-50"
    :class="{ hidden: !tabs.moreSheetOpen }"
    role="dialog"
    aria-modal="true"
    aria-labelledby="mobile-more-title"
  >
    <div id="mobile-more-backdrop" class="absolute inset-0 bg-black/60" @click="tabs.closeMoreSheet()"></div>
    <div class="mobile-more-panel absolute bottom-0 left-0 right-0 bg-surface-100 border-t border-surface-300 rounded-t-xl pt-2 pb-[env(safe-area-inset-bottom,0)] shadow-2xl">
      <div class="flex justify-center pb-2">
        <div class="w-10 h-1 rounded-full bg-surface-300"></div>
      </div>
      <div class="mobile-more-header flex items-center justify-between gap-3 px-4 pb-2">
        <h2 id="mobile-more-title" class="text-[10px] uppercase tracking-widest text-gray-500" style="font-family: 'B612 Mono', monospace;">More</h2>
        <button
          type="button"
          class="mobile-more-close"
          aria-label="Close menu"
          @click="tabs.closeMoreSheet()"
        >
          <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <button
        v-for="tab in MOBILE_MORE_TABS"
        :key="tab.id"
        class="mobile-more-item w-full flex items-center gap-3 px-4 py-3 text-left text-gray-200 hover:bg-surface-200 active:bg-surface-200"
        :data-tab="tab.id"
        :aria-current="tabs.activeTabId === tab.id ? 'page' : undefined"
        :aria-controls="`tab-${tab.id}`"
        type="button"
        @click="tabs.requestTabChange(tab.id)"
      >
        <TabIcon :kind="tab.icon" class="w-5 h-5 text-gray-400" />
        <span class="text-sm font-medium">{{ tab.label }}</span>
      </button>
    </div>
  </div>
</template>
