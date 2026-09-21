import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { usePromptsStore } from './prompts.js';
import {
  createSupportRecord,
  describeSupportGoal,
  milestonesUpTo,
  nextSupportMilestone,
  normalizeSupportRecord,
  sanitizeSupportGoal,
  supportPromptBlockReason,
} from '../../support/milestones.js';

export const SUPPORT_PROMPT_ID = 'support';

export const useSupportStore = defineStore('support', () => {
  const prompts = usePromptsStore();
  const record = ref(createSupportRecord());
  const prompt = ref(null);
  const goal = ref(null);
  const goalClock = ref(Date.now());

  const supported = computed(() => record.value.supported);
  const muted = computed(() => record.value.muted);
  const promptsEnabled = computed(() => !record.value.muted && !record.value.supported);
  const promptVisible = computed(() => prompt.value != null && prompts.isCurrent(SUPPORT_PROMPT_ID));
  const goalSummary = computed(() => describeSupportGoal(goal.value, goalClock.value));

  function hydrate(raw, now = Date.now()) {
    record.value = normalizeSupportRecord(raw, now);
    if (record.value.muted || record.value.supported) closePrompt();
  }

  function serialize() {
    return { ...record.value, milestonesShown: [...record.value.milestonesShown] };
  }

  function closePrompt() {
    prompt.value = null;
    prompts.release(SUPPORT_PROMPT_ID);
  }

  // Called after a final landing score. Returns true when a prompt opened.
  // Showing counts as the ask: the milestone and the timestamp are recorded
  // even if the user never clicks anything.
  function considerMilestone({ total, airports = 0, now = Date.now() } = {}) {
    if (prompt.value) return false;
    if (supportPromptBlockReason(record.value, { total, now })) return false;
    const milestone = nextSupportMilestone(total, record.value.milestonesShown);
    if (milestone == null) return false;
    record.value = {
      ...record.value,
      lastPromptAt: now,
      milestonesShown: [...new Set([...record.value.milestonesShown, ...milestonesUpTo(milestone)])],
    };
    prompt.value = { milestone, total: Number(total) || milestone, airports: Number(airports) || 0, stage: 'ask' };
    prompts.request(SUPPORT_PROMPT_ID);
    return true;
  }

  function dismissPrompt() {
    closePrompt();
  }

  // The coffee link opens Ko-fi in the browser; the card then offers a way to
  // say "done" so it never asks again, without assuming the visit paid off.
  function coffeeClicked() {
    if (!prompt.value) return;
    prompt.value = { ...prompt.value, stage: 'thanks' };
  }

  function setSupported(value) {
    record.value = { ...record.value, supported: value === true };
    if (record.value.supported) closePrompt();
  }

  function setMuted(value) {
    record.value = { ...record.value, muted: value === true };
    if (record.value.muted) closePrompt();
  }

  function markSupportedFromPrompt() {
    setSupported(true);
  }

  function applyGoal(message) {
    refreshGoalClock();
    goal.value = sanitizeSupportGoal(message);
  }

  function refreshGoalClock(now = Date.now()) {
    goalClock.value = now;
  }

  function ingestMessage(message) {
    if (message?.type === 'supportGoal') applyGoal(message);
  }

  return {
    applyGoal,
    coffeeClicked,
    considerMilestone,
    dismissPrompt,
    goal,
    goalSummary,
    hydrate,
    ingestMessage,
    markSupportedFromPrompt,
    muted,
    prompt,
    promptVisible,
    promptsEnabled,
    record,
    refreshGoalClock,
    serialize,
    setMuted,
    setSupported,
    supported,
  };
});
