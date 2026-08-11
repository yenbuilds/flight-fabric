<script setup>
defineProps({
  kind: {
    type: String,
    required: true,
    validator: (value) => ['grade', 'rate', 'zone', 'approach', 'bounce'].includes(value),
  },
});
</script>

<template>
  <svg
    class="landing-summary-watermark"
    :data-landing-summary-watermark="kind"
    viewBox="0 0 120 96"
    fill="none"
    stroke="currentColor"
    stroke-width="2.25"
    stroke-linecap="round"
    stroke-linejoin="round"
    vector-effect="non-scaling-stroke"
    aria-hidden="true"
    focusable="false"
  >
    <g v-if="kind === 'grade'">
      <circle cx="73" cy="43" r="27" />
      <circle cx="73" cy="43" r="20" stroke-dasharray="2 6" />
      <path d="m61 43 8 8 17-19" />
      <path d="m58 66-5 21 20-10 20 10-5-21" />
    </g>

    <g v-else-if="kind === 'rate'">
      <path d="M22 78h82" />
      <path d="M67 12v50" />
      <path d="m52 47 15 15 15-15" />
      <path d="M31 24h18M36 36h13M41 48h8" />
      <path d="M57 78h20" stroke-width="4" />
    </g>

    <g v-else-if="kind === 'zone'">
      <rect x="48" y="7" width="46" height="82" rx="3" />
      <path d="M71 14v9m0 9v9m0 9v9m0 9v9" stroke-dasharray="5 5" />
      <path d="M53 68h13m10 0h13M53 74h13m10 0h13" />
      <path d="M54 57h34" stroke-width="4" />
      <path d="M30 57h18m-7-7 7 7-7 7" />
    </g>

    <g v-else-if="kind === 'approach'">
      <path d="M10 48h100" stroke-dasharray="3 7" opacity=".55" />
      <path
        d="M10 48Q15 44 20 48T30 48Q36 39 42 48T54 48Q62 31 70 48T86 48Q97 21 108 48"
        stroke-width="3"
      />
    </g>

    <g v-else>
      <path d="M16 78h91" />
      <path d="M19 77c10-47 28-47 38 0 7-29 20-29 27 0 5-16 14-16 19 0" />
      <circle cx="57" cy="77" r="3" />
      <circle cx="84" cy="77" r="3" />
      <circle cx="103" cy="77" r="3" />
    </g>
  </svg>
</template>

<style scoped>
.landing-summary-watermark {
  position: absolute;
  right: -0.75rem;
  bottom: -0.65rem;
  z-index: 0;
  width: 9.5rem;
  height: 7.5rem;
  color: rgb(203 213 225);
  opacity: 0.075;
  pointer-events: none;
  user-select: none;
}

@media (max-width: 639px) {
  .landing-summary-watermark {
    right: -0.35rem;
    width: 10rem;
  }
}
</style>
