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

export async function openPhoneSettings(tabs) {
  if (tabs.activeTabId !== 'settings' && !tabs.requestTabChange('settings')) return false;
  tabs.closeMoreSheet();
  await nextTick();
  await nextTick();
  if (tabs.activeTabId !== 'settings') return false;
  await focusSettingsSection('settings-phone-tablet-access');
  return true;
}

// Release the narrow More sheet before the native intro takes focus. Keep the
// current page and let the shared replay owner recheck saved/draft state.
export async function openSetup(tabs, settingsUi) {
  if (settingsUi.introOpen || settingsUi.introBlockedReason) return false;
  const originTab = tabs.activeTabId;
  tabs.closeMoreSheet();
  await nextTick();
  await nextTick();
  if (tabs.activeTabId !== originTab || tabs.moreSheetOpen) return false;
  if (document.activeElement === document.body) {
    [...document.querySelectorAll('[data-setup-navigation], #mobile-more-btn, #vue-main-root')]
      .find(element => element.getClientRects().length && !element.disabled && !element.closest('[inert]'))
      ?.focus({ preventScroll: true });
  }
  return settingsUi.requestIntro();
}
