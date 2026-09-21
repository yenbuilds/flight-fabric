<script setup>
import { useTabsStore } from '../stores/tabs.js';
const tabs = useTabsStore();
</script>

<template>
  <div class="flight-workspace-toolbar">
    <div class="workspace-heading"><h1>Flight</h1><span>Current session</span></div>
    <nav class="workspace-view-switch" aria-label="Flight view">
      <button type="button" :class="{ active: tabs.activeTabId === 'livemap' }" :aria-current="tabs.activeTabId === 'livemap' ? 'page' : undefined" aria-controls="tab-livemap" @click="tabs.requestTabChange('livemap')">Map</button>
      <button type="button" :class="{ active: tabs.activeTabId === 'flight' }" :aria-current="tabs.activeTabId === 'flight' ? 'page' : undefined" aria-controls="tab-flight" @click="tabs.requestTabChange('flight')">Overview</button>
    </nav>
  </div>
</template>
