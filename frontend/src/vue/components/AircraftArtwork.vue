<script setup>
import { computed, ref, watch } from 'vue';
import { resolveAircraftVisual } from '../../aircraft/visual-manifest.js';

const props = defineProps({
  profileId: {
    type: String,
    default: '',
  },
  profileKey: {
    type: String,
    default: '',
  },
  aircraftName: {
    type: String,
    default: '',
  },
  variant: {
    type: String,
    default: 'thumbnail',
  },
  loading: {
    type: String,
    default: 'lazy',
  },
});

const resolvedVisual = computed(() => resolveAircraftVisual({
  profileId: props.profileId,
  profileKey: props.profileKey,
  aircraftName: props.aircraftName,
}));
const imageFailed = ref(false);
const showPlaceholder = computed(() => imageFailed.value || resolvedVisual.value.fidelity === 'class');
const placeholderLabel = computed(() => {
  const name = String(props.aircraftName || '').trim();
  const profile = String(props.profileKey || props.profileId || '').trim();
  const hasName = name && !/^(?:unknown(?: aircraft)?|generic(?: aircraft)?|aircraft|n\/?a|--?)$/i.test(name);
  const hasProfile = profile && !/(?:^|\/)(?:generic|unknown)$/i.test(profile);
  return hasName || hasProfile ? 'Aircraft image unavailable' : 'Unknown aircraft';
});

watch(resolvedVisual, () => { imageFailed.value = false; });
</script>

<template>
  <span
    class="aircraft-artwork"
    :class="[`aircraft-artwork--${variant}`, { 'aircraft-artwork--placeholder': showPlaceholder }]"
    :data-aircraft-visual-key="showPlaceholder ? 'generic-aircraft' : resolvedVisual.assetKey"
    :data-aircraft-visual-fidelity="showPlaceholder ? 'placeholder' : resolvedVisual.fidelity"
    :role="showPlaceholder ? 'img' : undefined"
    :aria-label="showPlaceholder ? placeholderLabel : undefined"
    :title="showPlaceholder ? placeholderLabel : undefined"
    :aria-hidden="showPlaceholder ? undefined : 'true'"
  >
    <span v-if="showPlaceholder" class="aircraft-artwork__placeholder" aria-hidden="true">
      <svg viewBox="0 0 96 80" class="aircraft-artwork__placeholder-icon" fill="none">
        <path fill="currentColor" d="M42 5c-4 0-7 7-7 13v14L9 48c-2 1-3 3-3 5v4c0 2 2 3 4 2l25-9v14l-10 8v4l17-5 17 5v-4l-10-8V50l25 9c2 1 4 0 4-2v-4c0-2-1-4-3-5L49 32V18c0-6-3-13-7-13Z" />
        <circle class="aircraft-artwork__placeholder-badge" cx="71" cy="56" r="19" stroke="currentColor" stroke-width="3" />
        <path d="M65 50a6 6 0 0 1 12 0c0 5-6 5-6 10" stroke="currentColor" stroke-width="4" stroke-linecap="round" />
        <circle cx="71" cy="66" r="2.2" fill="currentColor" />
      </svg>
      <span class="aircraft-artwork__placeholder-label">{{ placeholderLabel }}</span>
    </span>
    <img
      v-else
      class="aircraft-artwork__image"
      :src="resolvedVisual.src"
      alt=""
      :width="resolvedVisual.width"
      :height="resolvedVisual.height"
      :loading="loading"
      :fetchpriority="loading === 'eager' ? 'high' : 'low'"
      decoding="async"
      draggable="false"
      @error="imageFailed = true"
    />
  </span>
</template>
