<script setup>
import { nextTick } from 'vue';
import { useToolbarPanelStore } from '../stores/toolbar-panel.js';
import { useTabsStore } from '../stores/tabs.js';
import { focusToolbarPanelSettings } from '../toolbar-panel-navigation.js';

const toolbarPanel = useToolbarPanelStore();
const tabs = useTabsStore();

async function openSetup() {
  if (!tabs.requestTabChange('settings')) return;
  await focusToolbarPanelSettings(tabs);
}

async function dismiss(event) {
  const nextTarget = event.currentTarget.closest('nav, [role="dialog"]')?.querySelector('[data-tab="settings"]');
  toolbarPanel.dismissSetup();
  await nextTick();
  nextTarget?.focus({ preventScroll: true });
}
</script>

<template>
  <section v-if="toolbarPanel.setupTask" class="toolbar-setup-task" aria-label="Things to do">
    <p class="toolbar-setup-copy toolbar-setup-kicker">Things to do</p>
    <button type="button" class="toolbar-setup-open" :aria-label="toolbarPanel.setupTask.action + ': MSFS 2024 toolbar panel'" :title="toolbarPanel.setupTask.action + ': MSFS 2024 toolbar panel'" @click="openSetup">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18m-9 3v5m-2-2 2 2 2-2"/></svg>
      <span class="toolbar-setup-copy"><strong>{{ toolbarPanel.setupTask.title }}</strong><span>{{ toolbarPanel.setupTask.detail }}</span><b>{{ toolbarPanel.setupTask.action }} <span aria-hidden="true">→</span></b></span>
    </button>
    <div class="toolbar-setup-copy toolbar-setup-meta">
      <span>Optional</span>
      <button v-if="toolbarPanel.setupTask.kind === 'not_installed'" type="button" title="Hide this suggestion. Toolbar setup stays in Settings and Go to." @click="dismiss">Not now</button>
    </div>
  </section>
</template>
