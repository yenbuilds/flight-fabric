<script setup>
defineProps({
  kind: {
    type: String,
    required: true,
    validator: (value) => [
      'airspeed',
      'vertical-speed',
      'altitude',
      'radio-altitude',
      'ground-speed',
      'heading',
      'crosswind',
      'fuel',
    ].includes(value),
  },
});
</script>

<template>
  <svg
    class="flight-metric-watermark"
    :data-flight-metric-watermark="kind"
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
    <g v-if="kind === 'airspeed'">
      <path d="M10 30h34M17 48h27M6 66h38" />
      <g transform="translate(48 20) rotate(90 16 16) scale(1.65)">
        <path
          d="M16 1.8c.9 0 1.6.7 1.7 1.6l1.2 10.2 10.6 6.1c.6.3.9 1 .7 1.6l-.7 2.5c-.1.5-.6.7-1.1.5l-9.2-3.2.7 5.9 3.1 2.2c.3.2.4.6.3.9l-.4 1.1-5.3-1.7c-1.1-.4-2.3-.4-3.4 0l-5.3 1.7-.4-1.1c-.1-.3 0-.7.3-.9l3.1-2.2.7-5.9-9.2 3.2c-.5.2-1-.1-1.1-.5l-.7-2.5c-.2-.6.1-1.3.7-1.6l10.6-6.1 1.2-10.2c.1-.9.8-1.6 1.7-1.6Z"
          fill="currentColor"
          stroke="none"
        />
      </g>
    </g>

    <g v-else-if="kind === 'vertical-speed'">
      <path d="M76 13v70" />
      <path d="M62 20h14M67 31h9M62 42h14M62 54h14M67 65h9M62 76h14" />
      <path d="m38 37 13-14 13 14M51 24v49m-13-14 13 14 13-14" />
      <path d="M83 48h22" stroke-width="4" />
    </g>

    <g v-else-if="kind === 'altitude'">
      <circle cx="76" cy="49" r="34" />
      <circle cx="76" cy="49" r="4" />
      <path d="M76 15v8m24 2-6 6m16 18h-8m-2 24-6-6M76 83v-8m-24-2 6-6M42 49h8m2-24 6 6" />
      <path d="m76 49 17-21M76 49l-9 17" />
      <path d="M25 77h22m-17-9h17m-12-9h12" />
    </g>

    <g v-else-if="kind === 'radio-altitude'" data-watermark-symbol="aircraft-terrain-range">
      <g transform="translate(53 4) scale(1.4)">
        <path
          d="M16 1.8c.9 0 1.6.7 1.7 1.6l1.2 10.2 10.6 6.1c.6.3.9 1 .7 1.6l-.7 2.5c-.1.5-.6.7-1.1.5l-9.2-3.2.7 5.9 3.1 2.2c.3.2.4.6.3.9l-.4 1.1-5.3-1.7c-1.1-.4-2.3-.4-3.4 0l-5.3 1.7-.4-1.1c-.1-.3 0-.7.3-.9l3.1-2.2.7-5.9-9.2 3.2c-.5.2-1-.1-1.1-.5l-.7-2.5c-.2-.6.1-1.3.7-1.6l10.6-6.1 1.2-10.2c.1-.9.8-1.6 1.7-1.6Z"
          fill="currentColor"
          stroke="none"
        />
      </g>
      <path d="M66 54q9 8 18 0M62 60q13 12 26 0" />
      <path d="M99 45v30" stroke-dasharray="4 5" />
      <path d="m93 68 6 7 6-7" />
      <path d="M17 81c13-9 24 9 37 0s24 9 37 0 18 5 22 1" />
    </g>

    <g v-else-if="kind === 'ground-speed'" data-watermark-symbol="ground-track-vector">
      <path d="M18 74h92" />
      <path d="M30 69v10m21-10v10m21-10v10m21-10v10" />
      <path d="M35 46h67" stroke-width="4" />
      <path d="m89 33 13 13-13 13" stroke-width="4" />
      <path d="M20 31h38M10 46h19M18 61h40" />
    </g>

    <g v-else-if="kind === 'heading'">
      <circle cx="76" cy="50" r="34" />
      <path d="M76 16v8m24 2-6 6m16 18h-8m-2 24-6-6M76 84v-8m-24-2 6-6M42 50h8m2-24 6 6" />
      <path d="m76 28 9 28-9-5-9 5Z" fill="currentColor" stroke="none" />
      <path d="M76 11v-6m-5 7 5-7 5 7" />
      <circle cx="76" cy="50" r="3" />
    </g>

    <g v-else-if="kind === 'crosswind'">
      <path d="M90 20v66M81 86h19" />
      <path d="m89 24-43-10 4 25 39-11Z" />
      <path d="M49 21 88 25M51 30l36-4" />
      <path d="M13 51h49m-11-11 11 11-11 11" />
      <path d="M18 68h32" stroke-dasharray="5 6" />
    </g>

    <g v-else>
      <path d="M36 70a34 34 0 0 1 68 0" />
      <path d="M45 70h50" />
      <path d="M70 69 89 43" />
      <circle cx="70" cy="69" r="4" />
      <path d="M43 56 37 53m17-10-4-5m20-3v-7m17 15 5-5m-4 32h8" />
      <path d="M21 29c0 7-5 12-11 12S0 36 0 29c0-6 10-18 10-18s11 12 11 18Z" transform="translate(8 26)" />
    </g>
  </svg>
</template>

<style scoped>
.flight-metric-watermark {
  position: absolute;
  right: -0.7rem;
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
  .flight-metric-watermark {
    right: -0.4rem;
    width: 9rem;
  }
}
</style>
