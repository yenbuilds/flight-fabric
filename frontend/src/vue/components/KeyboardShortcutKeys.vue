<script setup>
import { computed } from 'vue';

const props = defineProps({
  shortcut: { type: String, default: '' },
});

// Display labels only: keep the stored accelerator unchanged.
const labels = new Map([
  ['Control', 'Ctrl'],
  ['Super', 'Win'],
  ['Escape', 'Esc'],
  ['PageUp', 'PgUp'],
  ['PageDown', 'PgDn'],
]);
const keys = computed(() => props.shortcut.split('+').filter(Boolean)
  .map(key => labels.get(key) || key));
</script>

<template>
  <span class="keyboard-shortcut font-mono">
    <span class="sr-only">{{ shortcut }}</span>
    <span v-for="(key, index) in keys" :key="index" class="keyboard-shortcut__part" aria-hidden="true">
      <span v-if="index" class="keyboard-shortcut__separator">+</span>
      <kbd class="keyboard-shortcut__key">{{ key }}</kbd>
    </span>
  </span>
</template>

<style scoped>
.keyboard-shortcut {
  display: inline-flex;
  max-width: 100%;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem;
  vertical-align: middle;
}

.keyboard-shortcut__part {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.keyboard-shortcut__separator {
  color: rgb(var(--muted-foreground));
  font-weight: 400;
}

.keyboard-shortcut__key {
  display: inline-flex;
  min-width: 1.8em;
  min-height: 2em;
  align-items: center;
  justify-content: center;
  padding: 0.1em 0.5em;
  border: 1px solid rgb(var(--border-strong));
  border-bottom-width: 3px;
  border-radius: 0.35rem;
  background: rgb(var(--panel-elevated));
  color: rgb(var(--foreground));
  box-shadow: inset 0 1px 0 rgb(var(--foreground) / 0.06);
  font: inherit;
  line-height: 1.4;
  white-space: nowrap;
}
</style>
