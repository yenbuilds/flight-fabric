<script setup>
import { useFeedbackStore } from '../stores/feedback.js';

const feedback = useFeedbackStore();
</script>

<template>
  <div id="app-feedback-toast" :class="feedback.toastClass" role="status" aria-live="polite">
    <div id="app-feedback-toast-title" class="app-feedback-toast-title">{{ feedback.toastTitle }}</div>
    <div id="app-feedback-toast-copy" class="app-feedback-toast-copy">{{ feedback.toastMessage }}</div>
  </div>
</template>
