<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import TabIcon from './TabIcon.vue';
import { containDialogFocus } from '../../ui/dialog-focus.js';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';
import { useShellStore } from '../stores/shell.js';
import { useTabsStore } from '../stores/tabs.js';
import { useToolbarPanelStore } from '../stores/toolbar-panel.js';
import { focusToolbarPanelSettings } from '../toolbar-panel-navigation.js';
import { SUPPORT_URL as supportHref } from '../../support/links.js';

const shell = useShellStore();
const tabs = useTabsStore();
const toolbarPanel = useToolbarPanelStore();
const panel = ref(null);
const query = ref('');
const selected = ref(0);
let returnTarget = null;
let focusRevision = 0;
let navigating = false;
let background = null;
let backgroundWasInert = false;
const descriptions = {
  livemap: 'Live position, route and map', flight: 'Flight instruments and aircraft state',
  autopilot: 'Cockpit controls, presets, voice and CDU', dispatch: 'Flight plan, fuel and briefing',
  timeline: 'Saved flights, replay and landing review', settings: 'Preferences and integrations',
  system: 'Connection, devices and services', landing: 'Most recent takeoff and landing assessment',
  cues: 'Experimental flight cues', lvars: 'Aircraft variable inspector',
  'toolbar-panel': 'Install, update or repair the in-sim toolbar',
};
const destinations = computed(() => [
  ...[...tabs.desktopPrimaryTabs, ...tabs.desktopSecondaryTabs].map((tab, index) => ({ ...tab, shortcut: String(index + 1) })),
  ...(toolbarPanel.available ? [{ id: 'toolbar-panel', tabId: 'settings', label: 'MSFS 2024 toolbar panel', icon: 'settings' }] : []),
  { id: 'landing', label: 'Takeoff and landing', icon: 'landing' },
  { id: 'cues', label: 'Flight cues', icon: 'cues' },
  { id: 'lvars', label: 'LVAR inspector', icon: 'system' },
]);
const results = computed(() => {
  const terms = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return destinations.value.filter(tab => {
    const text = `${tab.label} ${descriptions[tab.id] || ''}`.toLowerCase();
    return terms.every(term => text.includes(term));
  });
});

function close() { shell.closeNavigator(); }
async function navigate(tab) {
  if (!tab || navigating) return;
  const targetTab = tab.tabId || tab.id;
  if (!tabs.requestTabChange(targetTab)) {
    panel.value?.querySelector('input')?.focus({ preventScroll: true });
    return;
  }
  navigating = true;
  close();
  await nextTick();
  if (!shell.navigatorOpen && tabs.activeTabId === targetTab) {
    if (tab.id === 'toolbar-panel') await focusToolbarPanelSettings(tabs);
    else document.getElementById('vue-main-root')?.focus({ preventScroll: true });
  }
  navigating = false;
}
function onSearchKeydown(event) {
  if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
  if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
  event.preventDefault();
  const count = results.value.length;
  if (!count) return;
  if (event.key === 'ArrowDown') selected.value = (selected.value + 1) % count;
  if (event.key === 'ArrowUp') selected.value = (selected.value + count - 1) % count;
  if (event.key === 'Enter' && !event.repeat) navigate(results.value[selected.value]);
  nextTick(() => panel.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
}
function releaseBackground() {
  if (background && !backgroundWasInert) background.inert = false;
  background = null;
}
function isAvailableTarget(element) {
  return element?.isConnected && element !== document.body && element !== document.documentElement
    && !element.disabled && !element.closest('[inert]') && element.getClientRects().length > 0;
}
watch(results, () => { selected.value = 0; });
watch([() => shell.navigatorOpen, () => shell.navigatorMode], async ([open], [wasOpen]) => {
  const revision = ++focusRevision;
  if (open) {
    if (!wasOpen) {
      returnTarget = document.activeElement?.closest?.('#mobile-more-sheet')
        ? document.getElementById('mobile-more-btn') : document.activeElement;
      background = document.querySelector('.app-workbench');
      backgroundWasInert = background?.inert === true;
      if (background) background.inert = true;
    }
    query.value = '';
    selected.value = 0;
    tabs.closeMoreSheet();
    await nextTick();
    if (revision !== focusRevision || !shell.navigatorOpen) return;
    panel.value?.querySelector(shell.navigatorMode === 'navigate' ? 'input' : '[data-navigator-close]')?.focus({ preventScroll: true });
  } else {
    releaseBackground();
    const target = returnTarget;
    const restoreFocus = !navigating;
    returnTarget = null;
    await nextTick();
    if (!restoreFocus || revision !== focusRevision || shell.navigatorOpen) return;
    const candidates = [target, ...document.querySelectorAll('[aria-label="Search views and tools"]'),
      document.getElementById('mobile-more-btn'), document.getElementById('vue-main-root')];
    candidates.find(isAvailableTarget)?.focus({ preventScroll: true });
  }
});
onBeforeUnmount(() => { ++focusRevision; releaseBackground(); });
useDocumentEvent('keydown', event => {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  if (shell.navigatorOpen) {
    const activeDialog = event.target?.closest?.('[aria-modal="true"], dialog[open]');
    if (activeDialog && activeDialog !== panel.value) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    containDialogFocus(event, panel.value);
    return;
  }
  if (event.repeat || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || String(event.key).toLowerCase() !== 'k') return;
  const dialogOpen = [...document.querySelectorAll('[aria-modal="true"], dialog[open]')].some(element => element.getClientRects().length);
  if (dialogOpen || event.target?.isContentEditable
    || event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"], [role="menu"], [data-cdu-modal]')) return;
  event.preventDefault();
  shell.openNavigator();
});
</script>

<template>
  <Teleport to="body">
    <div v-if="shell.navigatorOpen" class="app-navigator-backdrop ff-keyboard-safe-overlay" @click.self="close">
      <section ref="panel" class="app-navigator" role="dialog" aria-modal="true" aria-labelledby="app-navigator-title" tabindex="-1">
        <header class="app-navigator-header">
          <h2 id="app-navigator-title">{{ shell.navigatorMode === 'help' ? 'Help & shortcuts' : 'Go to...' }}</h2>
          <button type="button" class="ff-icon-button" aria-label="Close" data-navigator-close @click="close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
          </button>
        </header>
        <template v-if="shell.navigatorMode === 'navigate'">
          <div class="app-navigator-search">
            <label class="sr-only" for="app-navigator-query">Search views and tools</label>
            <input id="app-navigator-query" v-model="query" type="search" placeholder="Search views and tools..." autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="app-navigator-results" :aria-activedescendant="results[selected] ? 'navigator-result-' + results[selected].id : undefined" @keydown="onSearchKeydown">
          </div>
          <div id="app-navigator-results" class="app-navigator-results" role="listbox" aria-label="Views and tools">
            <div v-for="(tab, index) in results" :key="tab.id" class="app-navigator-result" :class="{ selected: index === selected }" role="presentation" @pointermove="$event.pointerType === 'mouse' && (selected = index)">
              <button :id="'navigator-result-' + tab.id" type="button" role="option" :aria-selected="index === selected" tabindex="-1" @mousedown.prevent @click="navigate(tab)"><TabIcon :kind="tab.icon" /><span><strong>{{ tab.label }}</strong><small>{{ descriptions[tab.id] }}</small></span><kbd v-if="tab.shortcut" aria-hidden="true">{{ tab.shortcut }}</kbd></button>
            </div>
          </div>
          <p v-if="!results.length" class="app-navigator-empty" role="status">No matching views. Try aircraft, briefing, or settings.</p>
          <footer class="app-navigator-hint"><span>Arrow keys to choose · Enter to open</span><span>Esc to close</span></footer>
        </template>
        <div v-else class="app-help-content">
          <p>Keep your flight in view. Use the navigation to move between tasks, or search for a view with <kbd>Ctrl K</kbd> (<kbd>⌘ K</kbd> on Mac).</p>
          <dl class="app-shortcuts"><div><dt>Switch views</dt><dd><kbd>1</kbd> - <kbd>{{ tabs.desktopPrimaryTabs.length + tabs.desktopSecondaryTabs.length }}</kbd></dd></div><div><dt>Find aircraft controls</dt><dd><kbd>Ctrl F</kbd> in Aircraft</dd></div><div><dt>Close a dialog</dt><dd><kbd>Esc</kbd></dd></div></dl>
          <p class="text-muted-fg">View shortcuts pause while you type or use a dialog. Your voice shortcut is configured separately in Voice settings.</p>
          <div class="app-help-actions"><button type="button" class="ff-button-secondary" @click="navigate(destinations.find(tab => tab.id === 'settings'))">Open settings</button><button type="button" class="ff-button-secondary" @click="navigate(destinations.find(tab => tab.id === 'system'))">Connection &amp; devices</button></div>
          <div class="app-help-links"><a id="footer-source-link" href="https://github.com/yenbuilds/flight-fabric/releases" target="_blank" rel="noopener noreferrer">Releases & source (AGPL)</a><a id="footer-support-link" :href="supportHref" target="_blank" rel="noopener noreferrer">Support FlightFabric</a></div>
        </div>
      </section>
    </div>
  </Teleport>
</template>
