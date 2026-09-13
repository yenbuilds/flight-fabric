<script setup>
import { useId } from 'vue';

// Each instance owns its paint servers, including when two panels are mounted.
const id = `flight-metric-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
const dialTicks = Array.from({ length: 40 }, (_, index) => ({
  angle: index * 9,
  major: index % 5 === 0,
}));
const fuelTicks = Array.from({ length: 13 }, (_, index) => ({
  angle: -90 + index * 15,
  major: index % 3 === 0,
}));

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
    viewBox="0 0 160 120"
    fill="none"
    :stroke="`url(#${id}-ink)`"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <linearGradient :id="`${id}-ink`" x1="24" y1="108" x2="138" y2="16" gradientUnits="userSpaceOnUse">
        <stop stop-color="currentColor" stop-opacity=".25" />
        <stop offset=".5" stop-color="currentColor" stop-opacity=".7" />
        <stop offset="1" stop-color="currentColor" />
      </linearGradient>
      <linearGradient :id="`${id}-wash`" x1="60" y1="16" x2="118" y2="106" gradientUnits="userSpaceOnUse">
        <stop stop-color="currentColor" stop-opacity=".24" />
        <stop offset="1" stop-color="currentColor" stop-opacity=".025" />
      </linearGradient>
      <linearGradient :id="`${id}-airframe`" x1="-30" y1="-25" x2="30" y2="30" gradientUnits="userSpaceOnUse">
        <stop stop-color="currentColor" stop-opacity=".32" />
        <stop offset=".5" stop-color="currentColor" stop-opacity=".12" />
        <stop offset="1" stop-color="currentColor" stop-opacity=".035" />
      </linearGradient>
      <g :id="`${id}-aircraft`" stroke="currentColor" stroke-width="1.25">
        <!-- Swept wings, separate nacelles, and a tapered fuselage retain detail at card size. -->
        <path d="m-3-12-33 29v6L-4 12m7-24 33 29v6L4 12" :fill="`url(#${id}-airframe)`" />
        <path d="m-2 27-12 11v4l14-5 14 5v-4L2 27" :fill="`url(#${id}-airframe)`" />
        <rect x="-18" y="3" width="5" height="14" rx="2.5" :fill="`url(#${id}-airframe)`" />
        <rect x="13" y="3" width="5" height="14" rx="2.5" :fill="`url(#${id}-airframe)`" />
        <path d="M0-43c-3 0-4.5 8-4.5 15v38L-2 32l2 10 2-10 2.5-22v-38C4.5-35 3-43 0-43Z" :fill="`url(#${id}-airframe)`" />
        <path d="M-2.7-29Q0-32 2.7-29M0 21v15M-29 17l20-9m38 9L9 8" stroke-width=".8" opacity=".65" />
      </g>
    </defs>

    <g v-if="kind === 'airspeed'" data-watermark-symbol="aircraft-airflow">
      <path d="M14 36h24c14 0 18-11 32-11M8 61h47M19 87h21c13 0 19 10 31 10" opacity=".55" />
      <path d="M29 46h19M18 73h28M9 46h10M7 87h4" stroke-width="1" opacity=".4" />
      <path d="M112 21a45 45 0 0 1 25 56" stroke-width=".8" stroke-dasharray="2 5" opacity=".4" />
      <use :href="`#${id}-aircraft`" transform="translate(97 62) rotate(72)" />
    </g>

    <g v-else-if="kind === 'vertical-speed'" data-watermark-symbol="vertical-speed-tape">
      <rect x="102" y="15" width="35" height="92" rx="5" :fill="`url(#${id}-wash)`" opacity=".6" />
      <path d="M125 23v76" stroke-width=".8" opacity=".45" />
      <path v-for="tick in 11" :key="tick" :d="`M${tick % 5 === 1 ? 111 : 117} ${26 + (tick - 1) * 7}h${tick % 5 === 1 ? 14 : 8}`" :opacity="tick % 5 === 1 ? .9 : .5" />
      <path d="M78 26v70m-9-61 9-9 9 9m-18 52 9 9 9-9" stroke-width="1.8" />
      <path d="M51 61h46" stroke-width=".8" stroke-dasharray="2 4" opacity=".5" />
      <path d="m99 61 9-7h30v14h-30Z" :fill="`url(#${id}-wash)`" />
      <path d="M116 61h14" stroke-width="2" />
      <path d="M54 28v12m-6-6h12M48 89h12" opacity=".5" />
    </g>

    <g v-else-if="kind === 'altitude'" data-watermark-symbol="precision-altimeter">
      <circle cx="99" cy="62" r="45" stroke-width=".8" opacity=".4" />
      <circle cx="99" cy="62" r="41" :fill="`url(#${id}-wash)`" />
      <circle cx="99" cy="62" r="29" stroke-width=".6" opacity=".3" />
      <path v-for="tick in dialTicks" :key="tick.angle" :d="`M99 25v${tick.major ? 7 : 3}`" :transform="`rotate(${tick.angle} 99 62)`" :stroke-width="tick.major ? 1.7 : .85" :opacity="tick.major ? .95 : .55" />
      <path d="m99 62 20-25-15 29Z" :fill="`url(#${id}-wash)`" />
      <path d="m98 60-13 19 6-21" fill="currentColor" fill-opacity=".3" />
      <circle cx="99" cy="62" r="4.5" :fill="`url(#${id}-wash)`" />
      <circle cx="99" cy="62" r="1.5" fill="currentColor" stroke="none" />
      <path d="M92 82h14M96 86h6M38 88h12m-18 7h23m-16 7h20" stroke-width="1" opacity=".45" />
    </g>

    <g v-else-if="kind === 'radio-altitude'" data-watermark-symbol="aircraft-terrain-range">
      <use :href="`#${id}-aircraft`" transform="translate(96 35) scale(.55)" />
      <path d="M88 65q8 7 16 0M80 73q16 13 32 0M72 81q24 19 48 0" :stroke-width="1.4" />
      <path d="M63 66 51 92m78-26 12 26" stroke-width=".8" stroke-dasharray="2 4" opacity=".4" />
      <path d="M37 104c10-1 16-12 26-10s14 11 26 7 15-7 23-4 14 6 19 3l14-8v20H37Z" :fill="`url(#${id}-wash)`" stroke="none" />
      <path d="M31 104c16 0 20-12 32-10s14 11 26 7 15-7 23-4 14 6 19 3l14-8" />
      <path d="M137 41v42m-3-38 3-4 3 4m-6 34 3 4 3-4" stroke-width="1" opacity=".75" />
      <path d="M131 35h12M131 89h12" stroke-width=".8" opacity=".4" />
    </g>

    <g v-else-if="kind === 'ground-speed'" data-watermark-symbol="ground-track-vector">
      <path d="m40 103 37-43h39l33 43Z" :fill="`url(#${id}-wash)`" opacity=".6" />
      <path d="m50 103 30-36m58 36-26-36" stroke-width=".8" opacity=".55" />
      <path d="M96 64v6m0 7v9m0 8v12" stroke-width="2" opacity=".75" />
      <path d="M66 86h10m39 0h9M56 97h15m49 0h14" stroke-width="2.5" opacity=".5" />
      <path d="M49 43h83l-11-10 24 13-24 13 11-10H49Z" :fill="`url(#${id}-wash)`" />
      <path d="M26 32h35M19 46h21M29 59h31" opacity=".5" />
      <path d="M24 110h126" stroke-width=".8" opacity=".3" />
    </g>

    <g v-else-if="kind === 'heading'" data-watermark-symbol="compass-rose">
      <circle cx="99" cy="64" r="43" stroke-width=".8" opacity=".4" />
      <circle cx="99" cy="64" r="39" :fill="`url(#${id}-wash)`" />
      <path v-for="tick in dialTicks" :key="tick.angle" :d="`M99 29v${tick.major ? 5 : 2.5}`" :transform="`rotate(${tick.angle} 99 64)`" :stroke-width="tick.major ? 1.5 : .8" :opacity="tick.major ? .85 : .45" />
      <g stroke-width=".85" opacity=".55">
        <path d="m99 45 5 14 14 5-14 5-5 14-5-14-14-5 14-5Z" />
        <path d="m85 50 28 28m0-28-28 28" />
      </g>
      <g transform="rotate(24 99 64)">
        <path d="m99 38 8 26-8 26-8-26Z" :fill="`url(#${id}-wash)`" />
        <path d="M99 38v26h-8Z" fill="currentColor" fill-opacity=".5" stroke="none" />
        <path d="M99 64v26" stroke-width=".75" opacity=".6" />
      </g>
      <circle cx="99" cy="64" r="2.5" fill="currentColor" fill-opacity=".4" />
      <path d="m95 14 4 5 4-5Z" fill="currentColor" fill-opacity=".35" />
      <g class="flight-metric-watermark__lettering" fill="currentColor" stroke="none" opacity=".8">
        <text x="99" y="13">N</text>
        <text x="147" y="67">E</text>
        <text x="99" y="117">S</text>
        <text x="50" y="67">W</text>
      </g>
    </g>

    <g v-else-if="kind === 'crosswind'" data-watermark-symbol="striped-windsock">
      <path d="M78 30v73m-11 4h23m-18-4h12" />
      <circle cx="78" cy="25" r="2" :fill="`url(#${id}-wash)`" />
      <path d="M80 31c19 1 35 12 61 13v9c-24 0-42 6-61 4Z" :fill="`url(#${id}-wash)`" />
      <path d="M93 33c3 8 3 15 1 24l11-1c2-7 2-12 0-19ZM118 41c1 5 1 9 0 14l11-1v-11Z" fill="currentColor" fill-opacity=".25" stroke-width=".8" />
      <ellipse cx="80" cy="44" rx="4" ry="13" :fill="`url(#${id}-wash)`" />
      <path d="M141 44q3 4 0 9" stroke-width=".8" />
      <path d="M29 44h32m-6-5 6 5-6 5M38 64h26M23 77h22c8 0 9-6 17-6" opacity=".55" />
      <path d="M92 85h26c9 0 9-9 3-9-3 0-4 2-4 4M99 93h35" stroke-width="1" opacity=".45" />
      <ellipse cx="78" cy="108" rx="23" ry="4" stroke-width=".8" opacity=".25" />
    </g>

    <g v-else data-watermark-symbol="fuel-quantity-gauge">
      <path d="M65 94a39 39 0 0 1 78 0Z" :fill="`url(#${id}-wash)`" />
      <path d="M61 94a43 43 0 0 1 86 0" stroke-width=".8" opacity=".4" />
      <path v-for="tick in fuelTicks" :key="tick.angle" :d="`M104 59v${tick.major ? 6 : 3}`" :transform="`rotate(${tick.angle} 104 94)`" :stroke-width="tick.major ? 1.6 : .85" :opacity="tick.major ? .9 : .5" />
      <path d="m101 93 23-24-17 28" :fill="`url(#${id}-wash)`" />
      <circle cx="104" cy="94" r="4" :fill="`url(#${id}-wash)`" />
      <path d="M75 100h58" stroke-width=".8" opacity=".4" />
      <path d="M50 49c-4 7-14 17-14 26a14 14 0 0 0 28 0c0-9-10-19-14-26Z" :fill="`url(#${id}-wash)`" />
      <path d="M42 74c-1 5 2 9 6 10" stroke-width="1.2" opacity=".65" />
      <path d="M42 103h15m-11 4h7" stroke-width=".8" opacity=".3" />
    </g>
  </svg>
</template>

<style scoped>
.flight-metric-watermark {
  position: absolute;
  right: 0.25rem;
  bottom: 0.15rem;
  z-index: 0;
  width: 10.75rem;
  height: auto;
  max-width: 55%;
  max-height: calc(100% - 0.65rem);
  color: rgb(var(--muted-foreground, 184 192 204));
  opacity: 0.38;
  mask-image: linear-gradient(to right, transparent, #000 28%);
  pointer-events: none;
  user-select: none;
}

.flight-metric-watermark__lettering {
  font-family: var(--ff-font-ui, sans-serif);
  font-size: 7px;
  font-weight: 600;
  text-anchor: middle;
}

@media (max-width: 639px) {
  .flight-metric-watermark {
    right: 0;
    bottom: 0.1rem;
    max-width: 52%;
    opacity: 0.3;
  }
}
</style>
