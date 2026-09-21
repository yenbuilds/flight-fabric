import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

// One non-modal prompt at a time. Anything that wants the corner card
// (what's new, voice guidance, support) asks for the slot and renders
// only while it holds it, so two cards never stack.
export const usePromptsStore = defineStore('prompts', () => {
  const queue = ref([]);
  const shown = ref([]);
  const current = computed(() => queue.value[0] || null);

  function request(id) {
    if (!id || queue.value.includes(id)) return;
    queue.value = [...queue.value, id];
    if (!shown.value.includes(id)) shown.value = [...shown.value, id];
  }

  function release(id) {
    queue.value = queue.value.filter((entry) => entry !== id);
  }

  function isCurrent(id) {
    return current.value === id;
  }

  // Whether a card has appeared at any point this session, even if it has
  // since been dismissed. Lets one card yield to another that already had
  // the user's attention today.
  function wasShown(id) {
    return shown.value.includes(id);
  }

  return { queue, shown, current, request, release, isCurrent, wasShown };
});
