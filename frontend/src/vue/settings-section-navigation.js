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
