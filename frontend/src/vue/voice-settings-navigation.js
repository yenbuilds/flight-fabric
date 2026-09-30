import { nextTick } from 'vue';

// Wait for page scroll restoration and the narrow More sheet to release focus.
export async function focusVoiceSettings(tabs) {
  await nextTick();
  // The tab runtime queues its scroll restore during the first render flush.
  // A second tick runs after it, including when the desktop window is hidden.
  await nextTick();
  if (tabs.activeTabId !== 'settings') return;
  const section = document.getElementById('settings-voice-control');
  if (!section?.getClientRects().length || section.closest('[inert]')) return;
  section.focus({ preventScroll: true });
  section.scrollIntoView({ block: 'start', behavior: 'instant' });
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
