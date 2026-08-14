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
const genericVisual = resolveAircraftVisual();
const imageSrc = ref('');
const imageHidden = ref(false);

watch(resolvedVisual, (visual) => {
  imageSrc.value = visual.src;
  imageHidden.value = false;
}, { immediate: true });

function handleImageError() {
  if (imageSrc.value !== genericVisual.src) {
    imageSrc.value = genericVisual.src;
    return;
  }
  imageHidden.value = true;
}
</script>

<template>
  <span
    class="aircraft-artwork"
    :class="`aircraft-artwork--${variant}`"
    :data-aircraft-visual-key="resolvedVisual.assetKey"
    :data-aircraft-visual-fidelity="resolvedVisual.fidelity"
    aria-hidden="true"
  >
    <img
      v-if="!imageHidden"
      class="aircraft-artwork__image"
      :src="imageSrc"
      alt=""
      :width="resolvedVisual.width"
      :height="resolvedVisual.height"
      :loading="loading"
      :fetchpriority="loading === 'eager' ? 'high' : 'low'"
      decoding="async"
      draggable="false"
      @error="handleImageError"
    />
  </span>
</template>
