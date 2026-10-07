import { nextTick } from 'vue';
import { focusSettingsSection } from './settings-section-navigation.js';

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
