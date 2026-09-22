<script setup>
import { useId } from 'vue';

const id = `landing-summary-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

defineProps({
  kind: {
    type: String,
    required: true,
    validator: (value) => ['grade', 'rate', 'zone', 'approach', 'bounce', 'liftoff', 'roll', 'climb', 'rotation'].includes(value),
  },
});
</script>

<template>
  <svg
    class="landing-summary-watermark"
    :data-landing-summary-watermark="kind"
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
    </defs>

    <g v-if="kind === 'grade'" data-watermark-symbol="landing-medallion">
      <path d="m76 74-7 34 20-11 10 12 5-24m2-11 15 34 3-17 16 2-17-29" :fill="`url(#${id}-wash)`" />
      <path d="m80 82-4 14m47-15 5 10" stroke-width=".8" opacity=".5" />
      <circle cx="99" cy="52" r="34" :fill="`url(#${id}-wash)`" />
      <circle cx="99" cy="52" r="29" stroke-width=".8" opacity=".55" />
      <path v-for="tick in 36" :key="tick" d="M99 21v2" :transform="`rotate(${tick * 10} 99 52)`" stroke-width=".8" opacity=".5" />
      <circle cx="99" cy="52" r="23" stroke-width=".8" opacity=".4" />
      <path d="m85 52 9 9 19-21" stroke-width="2" />
      <path d="M57 58c-6-11-5-23 1-33m-2 21-8-5m7-3 7-6M140 58c6-11 5-23-1-33m2 21 8-5m-7-3-7-6" stroke-width="1" opacity=".4" />
    </g>

    <g v-else-if="kind === 'rate'" data-watermark-symbol="touchdown-descent-rate">
      <path d="M97 18h6v47h10L100 81 87 65h10Z" :fill="`url(#${id}-wash)`" />
      <path d="M100 26v31" stroke-width=".8" opacity=".5" />
      <path d="M74 24v53" stroke-width=".8" opacity=".4" />
      <path v-for="tick in 7" :key="tick" :d="`M${tick % 3 === 1 ? 63 : 68} ${26 + (tick - 1) * 8}H74`" :opacity="tick % 3 === 1 ? .75 : .4" stroke-width="1" />
      <path d="M121 31v26m-3-4 3 4 3-4M52 39h9m-14 8h14" stroke-width="1" opacity=".4" />
      <ellipse cx="100" cy="94" rx="19" ry="5" :fill="`url(#${id}-wash)`" />
      <ellipse cx="100" cy="94" rx="8" ry="2" opacity=".65" />
      <path d="M36 94h45m38 0h27M37 103h108" stroke-width="1" opacity=".6" />
      <path d="m45 103-5 6m19-6-5 6m19-6-5 6m19-6-5 6m19-6-5 6m19-6-5 6m19-6-5 6" stroke-width=".8" opacity=".3" />
    </g>

    <g v-else-if="kind === 'zone'" data-watermark-symbol="runway-touchdown-zone">
      <g transform="rotate(10 100 62)">
        <rect x="72" y="13" width="56" height="96" rx="3" stroke-width=".8" opacity=".4" />
        <rect x="77" y="18" width="46" height="86" rx="1" :fill="`url(#${id}-wash)`" />
        <path d="M79 55h42v27H79Z" fill="currentColor" fill-opacity=".12" stroke="none" />
        <path d="M100 23v7m0 8v7m0 8v7m0 19v7m0 8v5" stroke-width="1.8" opacity=".7" />
        <path d="M83 29v9m5-9v9m24-9v9m5-9v9M84 88v10m5-10v10m22-10v10m5-10v10" stroke-width="2" opacity=".65" />
        <path d="M83 58v10m34-10v10" stroke-width="3" />
        <circle cx="100" cy="69" r="8" />
        <circle cx="100" cy="69" r="2" fill="currentColor" fill-opacity=".5" stroke="none" />
        <path d="M88 69h5m14 0h5M100 57v5m0 14v5" stroke-width=".8" />
      </g>
      <path d="M38 64h23m-6-5 6 5-6 5M46 77h12M139 27v65m-3-65h6m-6 65h6" stroke-width="1" opacity=".5" />
    </g>

    <g v-else-if="kind === 'approach'" data-watermark-symbol="stabilized-glidepath">
      <path d="m33 25 100 67-100-44Z" :fill="`url(#${id}-wash)`" stroke-width=".8" opacity=".65" />
      <path d="m34 37 99 55" stroke-width=".9" stroke-dasharray="3 5" opacity=".5" />
      <path d="M37 23c10 0 10 29 24 31s17 9 27 14 29 16 45 24" stroke-width="1.8" />
      <path d="M67 39v34m29-16v31M62 39h10m-10 34h10m19-16h10m-10 31h10" stroke-width=".8" opacity=".6" />
      <circle cx="67" cy="55" r="2.5" :fill="`url(#${id}-wash)`" />
      <circle cx="96" cy="72" r="2.5" :fill="`url(#${id}-wash)`" />
      <path d="M35 105h113M35 99v6m24-3v3m24-3v3m24-3v3" stroke-width=".8" opacity=".35" />
      <path d="M120 96h26v5h-26Z" :fill="`url(#${id}-wash)`" />
      <path d="M125 98.5h4m5 0h4" stroke-width=".8" opacity=".7" />
      <circle cx="133" cy="92" r="3" :fill="`url(#${id}-wash)`" />
    </g>

    <g v-else-if="kind === 'liftoff'" data-watermark-symbol="runway-liftoff-point">
      <g transform="rotate(-10 100 62)">
        <rect x="72" y="13" width="56" height="96" rx="3" stroke-width=".8" opacity=".4" />
        <rect x="77" y="18" width="46" height="86" rx="1" :fill="`url(#${id}-wash)`" />
        <path d="M100 23v7m0 8v7m0 8v7m0 8v7m0 8v5" stroke-width="1.8" opacity=".7" />
        <path d="M83 92v9m5-9v9m24-9v9m5-9v9" stroke-width="2" opacity=".65" />
        <path d="M79 40h42" stroke-width="1.2" opacity=".6" stroke-dasharray="3 3" />
        <path d="M100 74 88 58h8V38h8v20h8Z" :fill="`url(#${id}-wash)`" stroke-width="1.4" />
      </g>
      <path d="M38 64h23m-6-5 6 5-6 5M139 27v65m-3-65h6m-6 65h6" stroke-width="1" opacity=".5" />
    </g>

    <g v-else-if="kind === 'roll'" data-watermark-symbol="ground-roll-distance">
      <path d="M28 96h118M28 90v12m118-12v12" stroke-width="1.2" opacity=".7" />
      <path v-for="tick in 11" :key="tick" :d="`M${34 + (tick - 1) * 11} ${tick % 5 === 1 ? 84 : 89}V96`" :opacity="tick % 5 === 1 ? .7 : .35" stroke-width=".9" />
      <path d="M36 70c14 0 26-2 40-6s26-10 44-24" stroke-width="1.8" :fill="`url(#${id}-wash)`" />
      <path d="M113 45c-8 2-13 9-14 15 7-3 13-8 14-15Z" :fill="`url(#${id}-wash)`" stroke-width=".8" />
      <circle cx="46" cy="70" r="3" :fill="`url(#${id}-wash)`" />
      <circle cx="78" cy="65" r="3" :fill="`url(#${id}-wash)`" />
      <path d="m42 108-5 6m23-6-5 6m23-6-5 6m23-6-5 6m23-6-5 6m23-6-5 6" stroke-width=".8" opacity=".3" />
    </g>

    <g v-else-if="kind === 'climb'" data-watermark-symbol="screen-height-crossing">
      <path d="M30 98h116" stroke-width="1.1" opacity=".6" />
      <path d="M36 92c20-4 40-10 60-24s30-30 44-44" stroke-width="1.8" />
      <path d="M118 42v56m-4-56h8" stroke-width="1" opacity=".5" stroke-dasharray="3 3" />
      <path d="M118 42h20l-6-5m6 5-6 5" stroke-width="1" opacity=".55" />
      <path d="M96 68c-8 2-13 9-14 15 7-3 13-8 14-15Z" :fill="`url(#${id}-wash)`" stroke-width=".8" />
      <circle cx="118" cy="42" r="3.5" :fill="`url(#${id}-wash)`" />
      <path d="M40 92v6m18-8v8m18-11v11" stroke-width=".8" opacity=".35" />
    </g>

    <g v-else-if="kind === 'rotation'" data-watermark-symbol="rotation-pitch-arc">
      <path d="M34 90h112" stroke-width="1" opacity=".55" />
      <path d="M60 90 130 52" stroke-width="1.6" />
      <path d="M60 90h70" stroke-width="1" opacity=".4" stroke-dasharray="3 4" />
      <path d="M110 90a50 50 0 0 0-6-22" stroke-width="1" opacity=".6" />
      <path d="m104 68-5 2 4 5" stroke-width="1" opacity=".6" />
      <path d="M96 80c-6-3-11-3-16-1 5 4 11 5 16 1Z" :fill="`url(#${id}-wash)`" stroke-width=".8" />
      <circle cx="60" cy="90" r="3" :fill="`url(#${id}-wash)`" />
      <path d="M118 78h12m-12 6h8" stroke-width=".8" opacity=".45" />
    </g>

    <g v-else data-watermark-symbol="touchdown-bounce-trace">
      <path d="M36 94c10-70 28-70 38 0 8-44 23-44 31 0 6-25 17-25 23 0Z" :fill="`url(#${id}-wash)`" stroke="none" />
      <path d="M36 94c10-70 28-70 38 0 8-44 23-44 31 0 6-25 17-25 23 0h15" stroke-width="1.8" />
      <path d="M55 43v43m34-24v24m28-9v9" stroke-width=".8" stroke-dasharray="2 4" opacity=".4" />
      <path d="M29 94h116M32 103h112" stroke-width="1" opacity=".55" />
      <path d="m42 103-5 6m23-6-5 6m23-6-5 6m23-6-5 6m23-6-5 6m23-6-5 6" stroke-width=".8" opacity=".3" />
      <circle v-for="x in [74, 105, 128]" :key="x" :cx="x" cy="94" r="3.5" :fill="`url(#${id}-wash)`" />
      <path d="M48 34h14m20 19h14m15 14h12" stroke-width="1" opacity=".5" />
    </g>
  </svg>
</template>

<style scoped>
.landing-summary-watermark {
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

@media (max-width: 639px) {
  .landing-summary-watermark {
    right: 0;
    bottom: 0.1rem;
    max-width: 52%;
    opacity: 0.3;
  }
}
</style>
