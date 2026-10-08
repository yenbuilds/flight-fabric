<script setup>
import { useVoiceControlStore } from '../stores/voice-control.js';
const voice = useVoiceControlStore();
</script>

<template>
  <div v-if="voice.restartHintVisible || voice.pushToTalkRetryVisible" class="mt-2 text-xs text-muted-fg">
    <div v-if="voice.pushToTalkRetryVisible" data-voice-ptt-recovery>
      <p role="status">{{ voice.runtime.pttRetrying ? 'Reconnecting push-to-talk…' : voice.runtime.shortcutError || 'Push-to-talk stopped. Retry to reconnect your shortcut or controller.' }}</p>
      <button type="button" class="ff-button-secondary voice-ptt-retry mt-2 text-xs disabled:opacity-50"
        data-voice-ptt-retry :disabled="voice.runtime.pttRetrying" :aria-busy="voice.runtime.pttRetrying"
        @click="voice.retryPushToTalk">{{ voice.runtime.pttRetrying ? 'Retrying…' : 'Retry push-to-talk' }}</button>
    </div>
    <p v-if="voice.restartHintVisible" :class="voice.pushToTalkRetryVisible ? 'mt-2' : ''" data-voice-restart-hint role="status">
      If voice still won't start, choose Quit FlightFabric in the system tray, then reopen it. Closing the window only hides it.
    </p>
  </div>
</template>

<style scoped>
.voice-ptt-retry { min-height: 2.75rem; }
</style>
