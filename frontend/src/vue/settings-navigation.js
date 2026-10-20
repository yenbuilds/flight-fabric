import { nextTick } from 'vue';

// Scroll within Settings without replacing any form, draft or voice session.
export async function focusSettingsSection(id) {
  const section = document.getElementById(id);
  if (!section?.getClientRects().length || section.closest('[inert]')) return;
  section.dispatchEvent(new Event('settings-reveal'));
  if (section.tagName === 'DETAILS') section.open = true;
  await nextTick();
  if (!section.getClientRects().length || section.closest('[inert]')) return;
  section.focus({ preventScroll: true });
  section.scrollIntoView({ block: 'start', behavior: 'instant' });
}

// Let the tab runtime restore its scroll position before moving to the section.
// Both the sidebar and view search use this same focus destination.
export async function focusToolbarPanelSettings(tabs) {
  await nextTick();
  await new Promise(resolve => window.requestAnimationFrame(resolve));
  if (tabs.activeTabId !== 'settings') return;
  await focusSettingsSection('settings-toolbar-panel');
}

// Wait for page scroll restoration and the narrow More sheet to release focus.
export async function focusVoiceSettings(tabs) {
  await nextTick();
  // The tab runtime queues its scroll restore during the first render flush.
  // A second tick runs after it, including when the desktop window is hidden.
  await nextTick();
  if (tabs.activeTabId !== 'settings') return;
  await focusSettingsSection('settings-voice-control');
}

export async function openVoiceSettings(tabs, voice, { fromAircraft = false } = {}) {
  if (!voice.bridgeAvailable) return false;
  if (tabs.activeTabId !== 'settings' && !tabs.requestTabChange('settings')) return false;
  tabs.closeMoreSheet();
  voice.settingsReturnToAircraft = fromAircraft;
  voice.panelOpen = false;
  await focusVoiceSettings(tabs);
  return true;
}
