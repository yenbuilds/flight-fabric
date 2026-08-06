<script setup>
import { computed } from 'vue';
import AppTooltip from './AppTooltip.vue';
import { useTimelineStore } from '../stores/timeline.js';

const timeline = useTimelineStore();

const toggleLabel = computed(() => (timeline.pfdCollapsed ? '+' : '-'));
</script>

<template>
  <div
    id="timeline-pfd-overlay"
    class="timeline-pfd-overlay"
    :class="{ 'pfd-collapsed': timeline.pfdCollapsed }"
    :style="{ '--pfd-scale': timeline.pfdScale }"
  >
    <AppTooltip content="Toggle instruments">
      <button
        id="pfd-toggle-btn"
        type="button"
        class="pfd-toggle-btn"
        @click="timeline.togglePfdCollapsed()"
      >
        {{ toggleLabel }}
      </button>
    </AppTooltip>
    <div id="timeline-pfd" class="pfd-overlay-panel" :style="{ opacity: timeline.pfdOverlayOpacity }">
      <div class="pfd-adi-wrap pfd-overlay-adi">
        <div id="pfd-adi-disc" class="pfd-adi-disc" :style="{ transform: timeline.pfdAdiTransform }">
          <div class="pfd-adi-sky"></div>
          <div class="pfd-adi-ground"></div>
          <div class="pfd-adi-horizon"></div>
          <div id="pfd-adi-pitchmarks"></div>
        </div>
        <div class="pfd-adi-aircraft">
          <svg width="80" height="10" viewBox="0 0 80 10">
            <path d="M0 5 L30 5 L34 9 L34 5 L46 5 L46 9 L50 5 L80 5" fill="none" stroke="#d4a853" stroke-width="2" stroke-linecap="round"/>
            <circle cx="40" cy="5" r="2.5" fill="none" stroke="#d4a853" stroke-width="1.5"/>
          </svg>
        </div>
        <div id="pfd-roll-ptr" class="pfd-roll-ptr" :style="{ transform: timeline.pfdRollPointerTransform }">v</div>
        <div class="pfd-roll-arc">
          <svg width="120" height="18" viewBox="0 0 120 18">
            <path d="M10 16 A52 52 0 0 1 110 16" fill="none" stroke="rgba(138,155,181,0.3)" stroke-width="1"/>
            <line x1="60" y1="0" x2="60" y2="5" stroke="rgba(138,155,181,0.5)" stroke-width="1"/>
            <line x1="32" y1="8" x2="34" y2="13" stroke="rgba(138,155,181,0.4)" stroke-width="1"/>
            <line x1="88" y1="8" x2="86" y2="13" stroke="rgba(138,155,181,0.4)" stroke-width="1"/>
            <line x1="16" y1="14" x2="19" y2="16" stroke="rgba(138,155,181,0.3)" stroke-width="1"/>
            <line x1="104" y1="14" x2="101" y2="16" stroke="rgba(138,155,181,0.3)" stroke-width="1"/>
          </svg>
        </div>
      </div>
      <div class="pfd-overlay-digits">
        <div class="pfd-overlay-field">
          <span class="pfd-overlay-lbl">IAS</span>
          <div id="pfd-spd-box" class="pfd-spd-box pfd-overlay-box">{{ timeline.pfdSpeedDisplay }}</div>
        </div>
        <div class="pfd-overlay-field">
          <span class="pfd-overlay-lbl">ALT</span>
          <div id="pfd-alt-box" class="pfd-alt-box pfd-overlay-box">{{ timeline.pfdAltitudeDisplay }}</div>
        </div>
        <div class="pfd-overlay-field">
          <span class="pfd-overlay-lbl">HDG</span>
          <div id="pfd-hdg-box" class="pfd-hdg-box pfd-overlay-box">{{ timeline.pfdHeadingDisplay }}</div>
        </div>
      </div>
      <div class="pfd-readouts pfd-overlay-readouts">
        <span>P <span id="pfd-pitch-val" class="val">{{ timeline.pfdPitchDisplay }}</span>&deg;</span>
        <span>R <span id="pfd-roll-val" class="val">{{ timeline.pfdRollDisplay }}</span>&deg;</span>
      </div>
      <div class="pfd-overlay-hidden" aria-hidden="true">
        <div class="pfd-hdg-wrap"><div id="pfd-hdg-tape" class="pfd-hdg-tape"></div><div class="pfd-hdg-index"></div></div>
        <div class="pfd-spd-wrap"><div class="pfd-tape-label">IAS <span class="unit">KTS</span></div><div id="pfd-spd-tape" class="pfd-spd-tape"></div></div>
        <div class="pfd-alt-wrap"><div class="pfd-tape-label">ALT <span class="unit">FT</span></div><div id="pfd-alt-tape" class="pfd-alt-tape"></div></div>
        <div class="pfd-profile-wrap"><div class="pfd-profile-label">PROFILE</div><canvas id="pfd-profile-canvas"></canvas></div>
      </div>
    </div>
  </div>
</template>
