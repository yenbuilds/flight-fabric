<script setup>
import { computed } from 'vue';
import { countryDisplayName, countryFlagSrc, normalizeCountryCode } from '../../timeline/country-flags.js';

// A small inline flag for the country an airport sits in. Renders nothing
// when the code is unknown so callers can place it unconditionally.
const props = defineProps({
  country: {
    type: String,
    default: '',
  },
  // Spoken form for assistive tech, e.g. "Australia". Defaults to the country
  // name; pass an empty string to make the flag purely decorative.
  label: {
    type: String,
    default: null,
  },
});

const code = computed(() => normalizeCountryCode(props.country));
const src = computed(() => countryFlagSrc(code.value));
const name = computed(() => countryDisplayName(code.value));
const alt = computed(() => (props.label === null ? name.value : props.label));
</script>

<template>
  <img
    v-if="code"
    class="country-flag"
    :src="src"
    :alt="alt"
    :title="name"
    :data-country-flag="code"
    width="18"
    height="12"
    loading="lazy"
    decoding="async"
  />
</template>
