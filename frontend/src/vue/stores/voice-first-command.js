import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { usePromptsStore } from './prompts.js';
import {
  VOICE_FIRST_COMMAND_PROMPT_ID,
  createFirstCommandRecord,
  firstCommandBlockReason,
  normalizeFirstCommandRecord,
} from '../../voice/first-command.js';

export { VOICE_FIRST_COMMAND_PROMPT_ID };

// Shown until one voice command has been sent, on the desktop app, for an
// aircraft that has voice commands. "Not now" hides it for the session,
// "Don't show again" for good, and a sent command retires it everywhere.
export const useVoiceFirstCommandStore = defineStore('voiceFirstCommand', () => {
  const prompts = usePromptsStore();
  const record = ref(createFirstCommandRecord());
  const prompt = ref(null);
  const shownThisSession = ref(false);
  const dismissedThisSession = ref(false);

  const blockReason = computed(() => firstCommandBlockReason(record.value));
  const eligible = computed(() => blockReason.value === null && !dismissedThisSession.value);
  const visible = computed(() => prompt.value != null && prompts.isCurrent(VOICE_FIRST_COMMAND_PROMPT_ID));

  function hydrate(raw) {
    record.value = normalizeFirstCommandRecord(raw);
  }

  function serialize() {
    return { ...record.value };
  }

  function close() {
    prompt.value = null;
    prompts.release(VOICE_FIRST_COMMAND_PROMPT_ID);
  }

  // Returns true when the card opened. Showing counts against the session
  // budget once per session, even if the aircraft changes and it reopens.
  function open({ example = '', aircraftName = '' } = {}) {
    if (prompt.value || !eligible.value || !example) return false;
    if (!shownThisSession.value) {
      shownThisSession.value = true;
      record.value = { ...record.value, sessionsShown: record.value.sessionsShown + 1 };
    }
    prompt.value = { stage: 'try', example: String(example), aircraftName: String(aircraftName || '') };
    prompts.request(VOICE_FIRST_COMMAND_PROMPT_ID);
    return true;
  }

  function updateContext({ example = '', aircraftName = '' } = {}) {
    if (!prompt.value || prompt.value.stage !== 'try') return;
    prompt.value = {
      ...prompt.value,
      example: String(example || prompt.value.example),
      aircraftName: String(aircraftName || ''),
    };
  }

  // The aircraft lost its voice commands or the sim went away: take the
  // card back without spending a "Not now".
  function withdraw() {
    if (!prompt.value || prompt.value.stage !== 'try') return;
    close();
  }

  function markCompleted() {
    if (!record.value.completed) record.value = { ...record.value, completed: true };
    if (prompt.value) prompt.value = { ...prompt.value, stage: 'done' };
  }

  function dismiss() {
    dismissedThisSession.value = true;
    close();
  }

  function mute() {
    record.value = { ...record.value, muted: true };
    close();
  }

  return {
    blockReason,
    dismiss,
    dismissedThisSession,
    eligible,
    hydrate,
    markCompleted,
    mute,
    open,
    prompt,
    record,
    serialize,
    shownThisSession,
    updateContext,
    visible,
    withdraw,
  };
});
