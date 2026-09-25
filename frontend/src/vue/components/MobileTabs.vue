<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import TabIcon from './TabIcon.vue';
import SupportLink from './SupportLink.vue';
import ToolbarPanelSetupTask from './ToolbarPanelSetupTask.vue';
import { EXPERIMENTAL_TABS } from '../tab-config.js';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import { useTabsStore } from '../stores/tabs.js';
import { useShellStore } from '../stores/shell.js';
import { containDialogFocus } from '../../ui/dialog-focus.js';

const tabs = useTabsStore();
const shell = useShellStore();
const morePanel = ref(null);
const aircraftSpecific = useAircraftSpecificStore();
let focusRevision = 0;
let mobileLayout = null;
let sheetOriginTabId = '';
let navigationPending = false;

function navigate(tabId) {
  navigationPending = true;
  if (!tabs.requestNavigationTabChange(tabId)) navigationPending = false;
}

function isAvailableFocusTarget(element) {
  return element?.isConnected && element !== document.body && element !== document.documentElement
    && !element.disabled && !element.closest('[inert]') && element.getClientRects().length > 0;
}

function syncMobileLayout() {
  if (mobileLayout && !mobileLayout.matches) tabs.closeMoreSheet();
}

onMounted(() => {
  mobileLayout = window.matchMedia('(max-width: 760px), (max-height: 500px) and (pointer: coarse)');
  mobileLayout.addEventListener('change', syncMobileLayout);
  syncMobileLayout();
});

onBeforeUnmount(() => {
  ++focusRevision;
  mobileLayout?.removeEventListener('change', syncMobileLayout);
});

function onKeydown(event) {
  if (!tabs.moreSheetOpen || event.defaultPrevented) return;
  if (event.key === 'Escape' && tabs.moreSheetOpen) {
    event.preventDefault();
    tabs.closeMoreSheet();
  }
  containDialogFocus(event, morePanel.value);
}

watch(() => tabs.moreSheetOpen, async open => {
  const revision = ++focusRevision;
  if (open) {
    sheetOriginTabId = tabs.activeTabId;
    navigationPending = false;
  }
  const navigated = !open && (navigationPending || tabs.activeTabId !== sheetOriginTabId);
  navigationPending = false;
  await nextTick();
  if (revision !== focusRevision) return;
  if (open) morePanel.value?.querySelector('button')?.focus({ preventScroll: true });
  else if (!shell.navigatorOpen) {
    if (navigated) {
      document.getElementById('vue-main-root')?.focus({ preventScroll: true });
      return;
    }
    const active = document.activeElement;
    // A resize can hide the sheet while focus already belongs to another
    // visible control. Only replace focus that disappeared with mobile UI.
    if (mobileLayout && !mobileLayout.matches && isAvailableFocusTarget(active)
      && !morePanel.value?.contains(active)) return;
    const targets = [document.getElementById('mobile-more-btn'),
      document.querySelector('.desktop-tab[aria-current="page"]'), document.getElementById('vue-main-root')];
    targets.find(isAvailableFocusTarget)?.focus({ preventScroll: true });
  }
});

watch(
  () => tabs.activeTabId,
  () => {
    tabs.closeMoreSheet();
  },
);

useDocumentEvent('keydown', onKeydown);
</script>

<template>
  <nav class="mobile-tab-bar" aria-label="Primary mobile navigation" :style="{ gridTemplateColumns: `repeat(${tabs.mobileNavigationPrimaryTabs.length + 1}, minmax(0, 1fr))` }">
    <button
      v-for="tab in tabs.mobileNavigationPrimaryTabs"
      :key="tab.id"
      class="mobile-tab relative"
      :class="{ active: tabs.activeNavigationTabId === tab.id }"
      :data-tab="tab.id"
      :aria-label="tab.id === 'autopilot' && aircraftSpecific.controlsSetupRequired
        ? `${tab.label}, setup required`
        : tab.label"
      :aria-current="tabs.activeNavigationTabId === tab.id ? 'page' : undefined"
      :aria-controls="tab.id === 'livemap' ? 'tab-livemap tab-flight' : `tab-${tab.id}`"
      type="button"
      @click="tabs.requestNavigationTabChange(tab.id)"
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
  >
    <div id="mobile-more-backdrop" class="absolute inset-0 bg-black/60" @click="tabs.closeMoreSheet()"></div>
    <div ref="morePanel" class="mobile-more-panel absolute bottom-0 left-0 right-0 bg-surface-100 border-t border-surface-300 rounded-t-xl pt-2 pb-[env(safe-area-inset-bottom,0)] shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="mobile-more-title" tabindex="-1">
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
      <SupportLink class="mobile-support-link" />
      <ToolbarPanelSetupTask class="mobile-toolbar-setup-task" />
      <button
        v-for="tab in tabs.mobileNavigationMoreTabs"
        :key="tab.id"
        class="mobile-more-item w-full flex items-center gap-3 px-4 py-3 text-left text-gray-200 hover:bg-surface-200 active:bg-surface-200"
        :data-tab="tab.id"
        :aria-current="tabs.activeNavigationTabId === tab.id ? 'page' : undefined"
        :aria-controls="tab.id === 'livemap' ? 'tab-livemap tab-flight' : `tab-${tab.id}`"
        type="button"
        @click="navigate(tab.id)"
      >
        <TabIcon :kind="tab.icon" class="w-5 h-5 text-gray-400" />
        <span class="text-sm font-medium">{{ tab.label }}</span>
      </button>
      <div class="mobile-more-experimental border-t border-surface-300 mt-2 pt-2">
        <h3 class="px-4 pb-1 text-[10px] uppercase tracking-widest text-amber-300/80" style="font-family: 'B612 Mono', monospace;">Experimental</h3>
        <button
          v-for="tab in EXPERIMENTAL_TABS"
          :key="tab.id"
          class="mobile-more-item w-full flex items-center gap-3 px-4 py-3 text-left text-gray-200 hover:bg-surface-200 active:bg-surface-200"
          :data-tab="tab.id"
          :aria-current="tabs.activeTabId === tab.id ? 'page' : undefined"
          :aria-controls="`tab-${tab.id}`"
          type="button"
          @click="navigate(tab.id)"
        >
          <TabIcon :kind="tab.icon" class="w-5 h-5 text-gray-400" />
          <span class="text-sm font-medium">{{ tab.label }}</span>
          <span class="ml-auto rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-amber-300">Preview</span>
        </button>
      </div>
      <button type="button" class="mobile-more-item w-full px-4 py-3 text-left text-sm" @click="shell.openNavigator('help'); tabs.closeMoreSheet()">Help &amp; shortcuts</button>
    </div>
  </div>
</template>
