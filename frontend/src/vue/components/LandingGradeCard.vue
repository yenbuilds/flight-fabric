<script setup>
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';

const id = `landing-foil-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
const light = ref({ x: 0.32, y: 0.22 });
const engaged = ref(false);
let motionQuery;
let frame = 0;
let nextLight = light.value;

const reflectionTransform = computed(() => (
  `rotate(${(light.value.x - 0.5) * 65} 60 56) translate(${(light.value.x - 0.5) * 48} ${(light.value.y - 0.5) * 24})`
));

// Interlaced, engraved waves give the foil a fine banknote-style rosette.
const rosette = Array.from({ length: 9 }, (_, ring) => {
  const points = Array.from({ length: 721 }, (_, step) => {
    const angle = step * Math.PI / 360;
    const radius = 22 + ring * 1.1 + Math.sin(angle * 18 + ring * 0.48) * 3.5;
    return `${step ? 'L' : 'M'}${(60 + Math.cos(angle) * radius).toFixed(2)},${(48 + Math.sin(angle) * radius).toFixed(2)}`;
  });
  return `${points.join(' ')}Z`;
});

function moveLight(event) {
  if (event.pointerType === 'touch' || motionQuery?.matches) return;
  const bounds = event.currentTarget.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  nextLight = {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
  };
  engaged.value = true;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    light.value = nextLight;
    frame = 0;
  });
}

function resetLight() {
  cancelAnimationFrame(frame);
  frame = 0;
  engaged.value = false;
  light.value = { x: 0.32, y: 0.22 };
}

onMounted(() => {
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  motionQuery.addEventListener('change', resetLight);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  motionQuery?.removeEventListener('change', resetLight);
});
</script>

<template>
  <div
    class="landing-grade-card relative isolate min-h-[7.5rem] min-w-0 overflow-hidden bg-surface-100/80 px-4 py-3"
    :class="{ 'landing-grade-card--lit': engaged }"
    @pointerenter="moveLight"
    @pointermove="moveLight"
    @pointerleave="resetLight"
    @pointercancel="resetLight"
  >
    <div class="landing-grade-card__copy"><slot /></div>
    <svg
      class="landing-grade-card__medal"
      data-landing-summary-watermark="grade"
      viewBox="0 0 120 136"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient :id="`${id}-metal`" x1="16" y1="12" x2="98" y2="115" gradientUnits="userSpaceOnUse">
          <stop stop-color="#eff3ed" />
          <stop offset=".16" stop-color="#899ba4" />
          <stop offset=".29" stop-color="#dce5df" />
          <stop offset=".43" stop-color="#5e777e" />
          <stop offset=".54" stop-color="#edf0e8" />
          <stop offset=".68" stop-color="#91a0ae" />
          <stop offset=".85" stop-color="#c9d6d3" />
          <stop offset="1" stop-color="#637b84" />
        </linearGradient>
        <linearGradient :id="`${id}-spectrum`" x1="12" y1="18" x2="98" y2="83" gradientUnits="userSpaceOnUse" :gradientTransform="reflectionTransform" spreadMethod="reflect">
          <stop stop-color="#8597df" />
          <stop offset=".16" stop-color="#b0d6ed" />
          <stop offset=".30" stop-color="#a0e5c0" />
          <stop offset=".43" stop-color="#ece5b7" />
          <stop offset=".54" stop-color="#e3b5bc" />
          <stop offset=".66" stop-color="#a799dd" />
          <stop offset=".8" stop-color="#86d5e2" />
          <stop offset="1" stop-color="#c5eac8" />
        </linearGradient>
        <linearGradient :id="`${id}-edge`" x1="27" y1="12" x2="91" y2="88" gradientUnits="userSpaceOnUse">
          <stop stop-color="#ffffff" stop-opacity=".9" />
          <stop offset=".3" stop-color="#d9eeee" stop-opacity=".4" />
          <stop offset=".5" stop-color="#243c43" stop-opacity=".9" />
          <stop offset=".73" stop-color="#fbfff1" stop-opacity=".85" />
          <stop offset="1" stop-color="#3c535d" />
        </linearGradient>
        <radialGradient :id="`${id}-light`" :cx="`${light.x * 100}%`" :cy="`${light.y * 100}%`" r="70%">
          <stop stop-color="#fffef4" stop-opacity=".9" />
          <stop offset=".19" stop-color="#f5fffc" stop-opacity=".42" />
          <stop offset=".46" stop-color="#ecf5ff" stop-opacity="0" />
          <stop offset="1" stop-color="#0b1c2c" stop-opacity=".55" />
        </radialGradient>
        <pattern :id="`${id}-grain`" width="2.3" height="2.3" patternUnits="userSpaceOnUse" patternTransform="rotate(-28)">
          <path d="M0 .3H2.3" stroke="#fcfff7" stroke-opacity=".23" stroke-width=".3" />
          <path d="M0 1.2H2.3" stroke="#142c3a" stroke-opacity=".22" stroke-width=".3" />
        </pattern>
        <!-- Match the ribbon and medal winding so their overlap stays filled. -->
        <path :id="`${id}-shape`" d="m85 75 9 44-20-10-14 16-14-16-20 10 9-44Z M103 48a43 43 0 1 1-86 0 43 43 0 0 1 86 0Z" />
        <path :id="`${id}-lettering`" d="M26 48a34 34 0 1 1 68 0a34 34 0 1 1-68 0" />
      </defs>

      <use :href="`#${id}-shape`" fill="#060d13" transform="translate(0 2)" opacity=".7" />
      <use :href="`#${id}-shape`" :fill="`url(#${id}-metal)`" />
      <use :href="`#${id}-shape`" :fill="`url(#${id}-spectrum)`" class="landing-grade-card__diffraction" />
      <use :href="`#${id}-shape`" :fill="`url(#${id}-grain)`" />

      <!-- Recessed ribbon folds and a hairline bevel, as on stamped foil. -->
      <path d="m38 82-6 27 14-7 14 15 14-15 14 7-6-27M60 91v26" stroke="#233e4b" stroke-opacity=".55" stroke-width=".65" />
      <path d="m39 84-4 21m46-21 4 21M60 94v17" stroke="#f1ffe7" stroke-opacity=".55" stroke-width=".55" />
      <circle cx="60" cy="48" r="42.4" :stroke="`url(#${id}-edge)`" stroke-width="1.2" />
      <circle cx="60" cy="48" r="39.5" stroke="#243c49" stroke-opacity=".7" stroke-width=".5" />
      <circle cx="60" cy="48" r="38.7" stroke="#ecfff0" stroke-opacity=".55" stroke-width=".5" />
      <circle cx="60" cy="48" r="37" stroke="#1f4250" stroke-opacity=".65" stroke-width="1.7" stroke-dasharray=".45 1.5" />
      <g stroke="#264954" stroke-opacity=".6" stroke-width=".38">
        <path v-for="(path, index) in rosette" :key="index" :d="path" />
      </g>
      <g transform="translate(0 -.35)" stroke="#f1ffe6" stroke-opacity=".55" stroke-width=".25">
        <path v-for="(path, index) in rosette" :key="index" :d="path" />
      </g>
      <circle cx="60" cy="48" r="19.5" :fill="`url(#${id}-metal)`" stroke="#284552" stroke-opacity=".8" stroke-width=".8" />
      <circle cx="60" cy="48" r="18.5" :fill="`url(#${id}-spectrum)`" fill-opacity=".35" stroke="#f0fff1" stroke-opacity=".7" stroke-width=".5" />
      <circle cx="60" cy="48" r="16.5" stroke="#31505a" stroke-opacity=".4" stroke-width=".5" stroke-dasharray=".5 1.5" />
      <path d="m50 48 7 7 14-16" stroke="#effff6" stroke-opacity=".75" stroke-width="3.3" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 .65)" />
      <path d="m50 48 7 7 14-16" stroke="#2b4653" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
      <text fill="#263f4c" font-size="4.3" font-family="'IBM Plex Mono', monospace" letter-spacing="1.15" font-weight="600">
        <textPath :href="`#${id}-lettering`" startOffset="7%">FLIGHT FABRIC · FLIGHT FABRIC ·</textPath>
      </text>
      <use :href="`#${id}-shape`" :fill="`url(#${id}-light)`" class="landing-grade-card__reflection" />
      <path d="M29 27A37 37 0 0 1 76 15" stroke="#fffef1" stroke-opacity=".55" stroke-width=".6" stroke-linecap="round" />
    </svg>
  </div>
</template>

<style scoped>
.landing-grade-card {
  display: flex;
  flex-direction: column;
  background-image: radial-gradient(ellipse at 95% 100%, rgb(158 190 188 / 0.055), transparent 65%);
}

.landing-grade-card__copy {
  position: relative;
  z-index: 1;
}

.landing-grade-card__medal {
  display: block;
  flex: none;
  align-self: flex-end;
  width: 5rem;
  height: 5.667rem;
  margin-top: 0.25rem;
  margin-right: -0.125rem;
  margin-bottom: -0.5rem;
  overflow: visible;
  pointer-events: none;
  user-select: none;
  filter: drop-shadow(0 2px 1px rgb(0 0 0 / 0.28));
}

.landing-grade-card__diffraction {
  mix-blend-mode: color;
  opacity: 0.76;
  transition: opacity 240ms ease;
}

.landing-grade-card__reflection {
  mix-blend-mode: soft-light;
}

.landing-grade-card--lit .landing-grade-card__diffraction {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .landing-grade-card__diffraction {
    transition: none;
  }
}

@media (forced-colors: active) {
  .landing-grade-card__medal {
    display: none;
  }
}
</style>
