import { nextTick } from 'vue';

// Let the tab runtime restore its scroll position before moving to the section.
// Both the sidebar and view search use this same focus destination.
export async function focusToolbarPanelSettings(tabs) {
  await nextTick();
  await new Promise(resolve => window.requestAnimationFrame(resolve));
  if (tabs.activeTabId !== 'settings') return;
  const section = document.getElementById('settings-toolbar-panel');
  if (!section?.getClientRects().length || section.closest('[inert]')) return;
  section.focus({ preventScroll: true });
  section.scrollIntoView({ block: 'start', behavior: 'instant' });
}
