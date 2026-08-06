<script setup>
import AppTooltip from './AppTooltip.vue';

defineProps({
  label: {
    type: String,
    required: true,
  },
  placement: {
    type: String,
    default: 'left',
  },
});
</script>

<template>
  <AppTooltip :placement="placement">
    <button type="button" class="settings-help-trigger" :aria-label="label">?</button>
    <template #content>
      <slot />
    </template>
  </AppTooltip>
</template>
