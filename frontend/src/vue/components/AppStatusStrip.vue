<script setup>
import { useStatusStore } from '../stores/status.js';

const status = useStatusStore();
</script>

<template>
  <div class="flex items-center gap-3 min-w-0">
    <div class="flex items-center gap-2 min-w-0">
      <div
        class="w-2.5 h-2.5 rounded-full shrink-0"
        :class="status.websocketClass"
        :style="status.websocketStyle"
      />
      <div class="flex flex-col leading-tight min-w-0">
        <span class="truncate text-sm text-muted-fg">{{ status.websocketLabel }}</span>
      </div>
    </div>
  </div>
</template>
