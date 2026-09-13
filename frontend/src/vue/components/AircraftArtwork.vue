<script setup>
import { computed, ref, useId, watch } from 'vue';
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

const artworkId = `aircraft-placeholder-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

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
      <svg viewBox="0 0 96 80" class="aircraft-artwork__placeholder-icon" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" focusable="false">
        <defs>
          <linearGradient :id="`${artworkId}-wash`" x1="20" y1="6" x2="62" y2="73" gradientUnits="userSpaceOnUse">
            <stop stop-color="currentColor" stop-opacity=".28" />
            <stop offset="1" stop-color="currentColor" stop-opacity=".04" />
          </linearGradient>
        </defs>
        <path d="M12 24a33 33 0 0 1 52-11M8 57a33 33 0 0 0 24 17" stroke-width=".75" stroke-dasharray="2 4" opacity=".3" />
        <g :fill="`url(#${artworkId}-wash)`">
          <path d="M37 29 9 49v5l28-8m7-17 27 20v5l-27-8" />
          <path d="m38 59-12 10v4l15-5 13 5v-4L43 59" />
          <path d="M41 6c-3 0-4 7-4 13v30l2 16 2 7 2-7 2-16V19c0-6-1-13-4-13Z" />
        </g>
        <path d="M39 18q2-2 4 0M41 54v10M15 49l17-9m34 9L50 40" stroke-width=".8" opacity=".55" />
        <circle class="aircraft-artwork__placeholder-badge" cx="73" cy="57" r="18" />
        <circle cx="73" cy="57" r="14.5" stroke-width=".75" opacity=".35" />
        <path d="M68 51a5 5 0 0 1 10 0c0 4-5 4-5 8" stroke-width="2" />
        <circle cx="73" cy="65" r="1.3" fill="currentColor" stroke="none" />
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
