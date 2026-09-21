<script setup>
import { computed } from 'vue';
import TabIcon from './TabIcon.vue';
import SupportLink from './SupportLink.vue';
import { navigationTabId } from '../tab-config.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import { useShellStore } from '../stores/shell.js';
import { useTabsStore } from '../stores/tabs.js';

const tabs = useTabsStore();
const shell = useShellStore();
const aircraftSpecific = useAircraftSpecificStore();
const groups = computed(() => {
  const routes = [...tabs.desktopPrimaryTabs, ...tabs.desktopSecondaryTabs];
  const withShortcuts = tab => ({ ...tab, shortcuts: routes.flatMap((route, index) => navigationTabId(route.id) === tab.id ? [String(index + 1)] : []) });
  const primary = tabs.desktopNavigationPrimaryTabs.map(withShortcuts);
  const secondary = tabs.desktopNavigationSecondaryTabs.map(withShortcuts);
  const utility = tab => ['settings', 'system'].includes(tab.id);
  return [
    { id: 'primary', label: 'Flight', tabs: primary.filter(tab => !utility(tab)) },
    { id: 'secondary', label: 'More views', tabs: secondary.filter(tab => !utility(tab)) },
    { id: 'utilities', label: 'Manage', tabs: [...primary, ...secondary].filter(utility) },
  ].filter(group => group.tabs.length);
});
</script>

<template>
  <div class="sidebar-brand">
    <img src="/assets/app-icon.png" alt="" width="28" height="28" aria-hidden="true">
    <span class="sidebar-label">FlightFabric</span>
    <button class="sidebar-collapse" type="button" :aria-label="shell.sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'" :aria-expanded="!shell.sidebarCollapsed" @click="shell.toggleSidebar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></svg>
    </button>
  </div>
  <button class="sidebar-search" type="button" aria-label="Search views and tools" title="Search views and tools (Ctrl+K)" @click="shell.openNavigator()">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>
    <span class="sidebar-label">Go to...</span><kbd class="sidebar-label">Ctrl K</kbd>
  </button>
  <nav class="desktop-tab-bar sidebar-navigation" aria-label="Primary navigation">
    <div v-for="group in groups" :key="group.id" class="sidebar-nav-group" :class="'sidebar-nav-' + group.id">
      <p class="sidebar-group-label">{{ group.label }}</p>
      <button v-for="tab in group.tabs" :key="tab.id" class="desktop-tab" :class="{ active: tabs.activeNavigationTabId === tab.id }" :data-tab="tab.id"
        :aria-label="tab.id === 'autopilot' && aircraftSpecific.controlsSetupRequired ? tab.label + ', setup required' : tab.label"
        :aria-current="tabs.activeNavigationTabId === tab.id ? 'page' : undefined" :aria-controls="tab.id === 'livemap' ? 'tab-livemap tab-flight' : 'tab-' + tab.id"
        :aria-keyshortcuts="tab.shortcuts.join(' ')" :title="tab.label + ' (' + tab.shortcuts.join(' / ') + ')'" type="button" @click="tabs.requestNavigationTabChange(tab.id)">
        <TabIcon :kind="tab.icon" />
        <span class="sidebar-label">{{ tab.label }}</span>
        <span v-if="tab.id === 'autopilot' && aircraftSpecific.controlsSetupRequired" class="sidebar-attention" data-aircraft-setup-indicator title="Aircraft controls require setup" aria-hidden="true"></span>
        <kbd class="desktop-tab-keycap sidebar-label" aria-hidden="true">{{ tab.shortcuts.join(' / ') }}</kbd>
      </button>
    </div>
  </nav>
  <div class="sidebar-bottom">
    <SupportLink />
    <button class="sidebar-help" type="button" aria-label="Help and shortcuts" title="Help and shortcuts" @click="shell.openNavigator('help')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9a2.5 2.5 0 0 1 4.8 1c0 1.8-2.4 1.8-2.4 3.5M12 16v.5"/></svg>
      <span class="sidebar-label">Help &amp; shortcuts</span>
    </button>
  </div>
</template>
