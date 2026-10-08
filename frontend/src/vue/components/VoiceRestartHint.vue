<script setup>
import { useVoiceControlStore } from '../stores/voice-control.js';
const voice = useVoiceControlStore();
</script>

<template>
  <p v-if="voice.restartHintVisible" class="mt-2 text-xs text-muted-fg" data-voice-restart-hint role="status">
    If voice still won't start, choose Quit FlightFabric in the system tray, then reopen it. Closing the window only hides it.
  </p>
</template>
