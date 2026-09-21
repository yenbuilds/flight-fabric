import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { usePromptsStore } from './prompts.js';

export const WHATS_NEW_PROMPT_ID = 'whats-new';
const MAX_HIGHLIGHTS = 4;

// Shown once per version, only after an update, never on a fresh install.
export const useWhatsNewStore = defineStore('whatsNew', () => {
  const prompts = usePromptsStore();
  const open = ref(false);
  const version = ref('');
  const highlights = ref([]);
  const releaseNotesUrl = ref('');
  const displayAllowed = ref(true);

  const hasPromptSlot = computed(() => open.value && prompts.isCurrent(WHATS_NEW_PROMPT_ID));
  const visible = computed(() => hasPromptSlot.value && displayAllowed.value);

  function setDisplayAllowed(value) {
    displayAllowed.value = value === true;
  }

  function show(payload = {}) {
    const items = Array.isArray(payload.highlights) ? payload.highlights : [];
    version.value = String(payload.version || '').trim();
    highlights.value = items
      .map((item) => ({
        label: String(item?.label || '').trim(),
        text: String(item?.text || '').trim(),
      }))
      .filter((item) => item.text)
      .slice(0, MAX_HIGHLIGHTS);
    releaseNotesUrl.value = String(payload.releaseNotesUrl || '').trim();
    if (!version.value || !highlights.value.length) return false;
    open.value = true;
    prompts.request(WHATS_NEW_PROMPT_ID);
    return true;
  }

  function dismiss() {
    open.value = false;
    prompts.release(WHATS_NEW_PROMPT_ID);
  }

  return { dismiss, displayAllowed, hasPromptSlot, highlights, open, releaseNotesUrl, setDisplayAllowed, show, version, visible };
});
