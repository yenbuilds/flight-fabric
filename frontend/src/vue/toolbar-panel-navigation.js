import { nextTick } from 'vue';
import { focusSettingsSection } from './settings-section-navigation.js';

// Let the tab runtime restore its scroll position before moving to the section.
// Both the sidebar and view search use this same focus destination.
export async function focusToolbarPanelSettings(tabs) {
  await nextTick();
  await new Promise(resolve => window.requestAnimationFrame(resolve));
  if (tabs.activeTabId !== 'settings') return;
  await focusSettingsSection('settings-toolbar-panel');
}
