<script setup>
import { useId } from 'vue';

defineProps({
  kind: {
    type: String,
    required: true,
    validator: value => ['devices', 'toolbar', 'recording', 'audio'].includes(value),
  },
});

const id = `settings-art-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
</script>

<template>
  <div class="settings-section-watermark" :data-settings-watermark="kind" aria-hidden="true">
    <svg viewBox="0 0 480 300" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" focusable="false">
      <defs>
        <linearGradient :id="`${id}-wash`" x1=".8" y1="0" x2=".2" y2="1">
          <stop stop-color="currentColor" stop-opacity=".18" />
          <stop offset="1" stop-color="currentColor" stop-opacity=".015" />
        </linearGradient>
      </defs>

      <!-- Fine construction lines echo the flight instruments and debrief art. -->
      <g opacity=".22" stroke-width=".75">
        <path d="M112 56h328M112 252h328M144 30v242M420 30v242" stroke-dasharray="2 8" />
        <path d="M132 44h24m-12-12v24M408 240h24m-12-12v24" />
        <circle cx="286" cy="148" r="118" stroke-dasharray="2 8" />
      </g>

      <g v-if="kind === 'devices'">
        <!-- Tablet with a flight display, phone in front, and a local radio link. -->
        <rect x="206" y="55" width="212" height="160" rx="13" :fill="`url(#${id}-wash)`" stroke-width="2" />
        <rect x="216" y="65" width="192" height="140" rx="5" opacity=".65" />
        <path d="M308 60h10M226 85h171" opacity=".45" />
        <circle cx="302" cy="143" r="37" />
        <path d="M266 143h72m-69-13h66m-66 26h66M284 139h10l8 7 8-7h10M302 106v8m0 58v8" opacity=".8" />
        <path d="M356 111h34m-34 10h23m-23 21h34m-34 10h28m-28 21h34" opacity=".55" />
        <rect x="156" y="123" width="83" height="135" rx="12" :fill="`url(#${id}-wash)`" stroke-width="2" />
        <rect x="163" y="131" width="69" height="119" rx="6" />
        <path d="M186 136h22M186 242h22M174 167h46m-46 10h31m-31 36h46m-46 10h23" opacity=".65" />
        <path d="M175 199h9l7-12 10 21 8-13h10" />
        <g stroke-width="2.5">
          <path d="M120 75a59 59 0 0 1 83 0M132 88a41 41 0 0 1 59 0M145 101a23 23 0 0 1 33 0" />
          <circle cx="161.5" cy="114" r="3" fill="currentColor" stroke="none" />
        </g>
        <path d="M253 238h49a17 17 0 0 0 17-17v-6M253 234v8" opacity=".4" stroke-dasharray="3 5" />
      </g>

      <g v-else-if="kind === 'toolbar'">
        <!-- The simulator viewport, its top toolbar, and a floating companion panel. -->
        <rect x="140" y="55" width="292" height="183" rx="10" :fill="`url(#${id}-wash)`" stroke-width="2" />
        <path d="M150 92h272M150 205h272" opacity=".4" />
        <path d="m152 192 50-36 35 18 45-31 39 26 36-15 63 36" opacity=".3" />
        <path d="m260 159 19 3 7-6 7 6 19-3M286 123v10" opacity=".7" />
        <rect x="192" y="64" width="188" height="29" rx="7" :fill="`url(#${id}-wash)`" />
        <path d="M211 73v10m-5-5h10M237 73l5 5-5 5-5-5ZM260 73h10v10h-10M316 73h10m-10 5h10m-10 5h6M344 73v10l9-5Z" />
        <rect x="281" y="68" width="23" height="21" rx="4" />
        <path d="m287 79 5-6 6 6m-6-6v11" />
        <path d="M292 96v18h44" opacity=".6" stroke-dasharray="3 5" />
        <rect x="329" y="109" width="114" height="154" rx="8" :fill="`url(#${id}-wash)`" stroke-width="2" />
        <path d="M330 132h111M341 121h39m49-3 6 6m0-6-6 6M341 145h20m8 0h22m8 0h30" opacity=".65" />
        <rect x="341" y="156" width="90" height="44" rx="4" opacity=".6" />
        <path d="m350 186 19-18 22 14 30-17" stroke-dasharray="3 4" />
        <circle cx="350" cy="186" r="2.5" /><circle cx="421" cy="165" r="2.5" />
        <rect x="341" y="212" width="40" height="16" rx="3" opacity=".7" />
        <rect x="389" y="212" width="42" height="16" rx="3" opacity=".7" />
        <path d="M341 241h61m-61 8h43M243 249h69m-36-10-2 10" opacity=".45" />
      </g>

      <g v-else-if="kind === 'recording'">
        <!-- Swept-wing airframe over an observed track and a recording timeline. -->
        <path d="M109 216c40 0 26-64 68-64s50 46 94 17 38-90 95-90h39" opacity=".55" stroke-dasharray="4 6" />
        <g transform="translate(290 118) rotate(24)">
          <path d="m-6-20-67 52v10L-7 19m13-39 67 52v10L7 19" :fill="`url(#${id}-wash)`" stroke-width="2" />
          <path d="m-4 46-23 18v8l27-9 27 9v-8L4 46" :fill="`url(#${id}-wash)`" />
          <rect x="-37" y="1" width="10" height="27" rx="5" :fill="`url(#${id}-wash)`" />
          <rect x="27" y="1" width="10" height="27" rx="5" :fill="`url(#${id}-wash)`" />
          <path d="M0-79c-6 0-9 15-9 28v65l5 42 4 17 4-17 5-42v-65C9-64 6-79 0-79Z" :fill="`url(#${id}-wash)`" stroke-width="2" />
          <path d="M-5-52q5-5 10 0M0 38v25m-58-31 40-19m76 19L18 13" opacity=".6" />
        </g>
        <path d="M134 231h288M148 222v18m37-14v10m37-14v10m37-14v10m37-14v10m37-14v10m37-14v10m37-14v18" opacity=".5" />
        <rect x="173" y="211" width="180" height="40" rx="6" :fill="`url(#${id}-wash)`" />
        <circle cx="193" cy="231" r="7" /><circle cx="193" cy="231" r="3" fill="currentColor" stroke="none" />
        <path d="M214 231h16l5-7 8 14 8-19 9 20 7-11 7 3h58" />
        <circle cx="405" cy="79" r="4" /><circle cx="109" cy="216" r="4" />
      </g>

      <g v-else>
        <!-- Cabin PA speaker with acoustic waves and a row of aircraft windows. -->
        <rect x="166" y="60" width="63" height="91" rx="28" opacity=".28" />
        <rect x="244" y="60" width="63" height="91" rx="28" opacity=".28" />
        <rect x="322" y="60" width="63" height="91" rx="28" opacity=".28" />
        <path d="M140 172h284" opacity=".2" />
        <path d="M188 147h30l50-38v119l-50-38h-30a8 8 0 0 1-8-8v-27a8 8 0 0 1 8-8Z" :fill="`url(#${id}-wash)`" stroke-width="2" />
        <path d="M218 148v42m-25-32v21m8-21v21M256 123v91" opacity=".6" />
        <g stroke-width="2">
          <path d="M288 143a37 37 0 0 1 0 51M305 126a61 61 0 0 1 0 85M323 108a86 86 0 0 1 0 121" />
        </g>
        <path d="M184 253h18m8-5v10m8-16v22m8-19v16m8-26v36m8-20v4m8-16v28m8-23v18m8-14v10m8-20v30m8-24v18m8-11v4m8-7v10m8-15v20m8-13v6m8-3h18" opacity=".5" />
      </g>
    </svg>
  </div>
</template>

<style scoped>
.settings-section-watermark {
  position: absolute;
  inset: 0;
  z-index: -1;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
  user-select: none;
  color: rgb(var(--muted-foreground));
}

.settings-section-watermark svg {
  position: absolute;
  top: -1.5rem;
  right: -0.75rem;
  width: clamp(28rem, 48%, 36rem);
  max-width: none;
  height: auto;
  opacity: .3;
  mask-image: linear-gradient(110deg, transparent 12%, #000 56%), linear-gradient(to bottom, #000 65%, transparent);
  mask-composite: intersect;
}

@media (max-width: 639px) {
  .settings-section-watermark svg {
    top: -0.5rem;
    right: -3.5rem;
    width: 24rem;
    opacity: .18;
    mask-image: linear-gradient(110deg, transparent 24%, #000 85%), linear-gradient(to bottom, #000 40%, transparent 90%);
  }
}

@media (forced-colors: active) {
  .settings-section-watermark { display: none; }
}
</style>
