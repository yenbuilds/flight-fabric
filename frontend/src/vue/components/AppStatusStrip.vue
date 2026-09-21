<script setup>
import { computed } from 'vue';
import { useStatusStore } from '../stores/status.js';

const status = useStatusStore();
const label = computed(() => status.websocket === 'ready' && !status.primarySource?.connected
  ? 'Waiting for simulator' : status.websocketLabel);
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
        <span class="truncate text-xs text-muted-fg" role="status" :data-connection="status.websocket">{{ label }}</span>
      </div>
    </div>
  </div>
</template>
