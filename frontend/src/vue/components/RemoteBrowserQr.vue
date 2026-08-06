<script setup>
import { computed } from 'vue';
import { createQrSvgData } from '../../utils/qr-code.js';

const props = defineProps({
  value: {
    type: String,
    default: '',
  },
});

const qrData = computed(() => createQrSvgData(props.value));
</script>

<template>
  <div
    id="system-remote-qr"
    class="flex h-32 w-32 shrink-0 items-center justify-center rounded-xl border border-cyan-300/30 bg-white p-2 shadow-lg shadow-black/25"
  >
    <svg
      v-if="qrData"
      class="h-full w-full"
      :viewBox="qrData.viewBox"
      role="img"
      :aria-label="`QR code for ${qrData.value}`"
      shape-rendering="crispEdges"
    >
      <rect :width="qrData.viewBoxSize" :height="qrData.viewBoxSize" fill="#ffffff" />
      <path :d="qrData.path" fill="#020617" />
    </svg>
  </div>
</template>
