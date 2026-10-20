<script setup>
import { useTabsStore } from '../stores/tabs.js';
import TabIcon from './TabIcon.vue';
const tabs = useTabsStore();
</script>

<template>
  <div class="flight-workspace-toolbar">
    <div class="workspace-heading"><h1>Flight</h1><span>Current session</span></div>
    <nav class="workspace-view-switch" aria-label="Flight view">
      <button type="button" :class="{ active: tabs.activeTabId === 'livemap' }" :aria-current="tabs.activeTabId === 'livemap' ? 'page' : undefined" aria-controls="tab-livemap" @click="tabs.requestTabChange('livemap')"><TabIcon kind="livemap" />Map</button>
      <button type="button" :class="{ active: tabs.activeTabId === 'flight' }" :aria-current="tabs.activeTabId === 'flight' ? 'page' : undefined" aria-controls="tab-flight" @click="tabs.requestTabChange('flight')"><TabIcon kind="flight" />Overview</button>
    </nav>
  </div>
</template>
