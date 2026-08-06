<script setup>
import { useTimelineStore } from '../stores/timeline.js';

const timeline = useTimelineStore();
</script>

<template>
  <div
    id="timeline-altitude-profile"
    class="timeline-altitude-profile"
    :class="{ hidden: !timeline.altitudeProfileVisible && !timeline.altitudeProfileEmptyVisible }"
  >
    <div class="timeline-altitude-profile-head">
      <div>
        <div class="timeline-altitude-profile-title">Altitude Profile</div>
        <div id="timeline-altitude-range" class="timeline-altitude-profile-range">{{ timeline.altitudeProfileRangeText }}</div>
      </div>
      <div id="timeline-altitude-current" class="timeline-altitude-profile-current">{{ timeline.altitudeProfileCurrentText }}</div>
    </div>
    <div class="timeline-altitude-profile-plot">
      <svg
        id="timeline-altitude-profile-svg"
        class="timeline-altitude-profile-svg"
        viewBox="0 0 640 96"
        preserveAspectRatio="none"
        role="img"
        aria-label="Altitude profile"
      >
        <line class="timeline-altitude-grid" x1="22" y1="12" x2="624" y2="12" />
        <line class="timeline-altitude-grid" x1="22" y1="45" x2="624" y2="45" />
        <line class="timeline-altitude-grid timeline-altitude-baseline" x1="22" y1="78" x2="624" y2="78" />
        <path
          v-if="timeline.altitudeProfileFillD"
          id="timeline-altitude-profile-fill"
          class="timeline-altitude-profile-fill"
          :d="timeline.altitudeProfileFillD"
        />
        <path
          v-if="timeline.altitudeProfilePathD"
          id="timeline-altitude-profile-path"
          class="timeline-altitude-profile-path"
          :d="timeline.altitudeProfilePathD"
        />
        <g v-if="timeline.altitudeProfileCursorVisible" id="timeline-altitude-profile-cursor">
          <line
            class="timeline-altitude-profile-cursor-line"
            :x1="timeline.altitudeProfileCursorX"
            y1="12"
            :x2="timeline.altitudeProfileCursorX"
            y2="78"
          />
          <circle
            class="timeline-altitude-profile-cursor-dot"
            :cx="timeline.altitudeProfileCursorX"
            :cy="timeline.altitudeProfileCursorY"
            r="4.2"
          />
        </g>
      </svg>
      <div
        id="timeline-altitude-profile-empty"
        class="timeline-altitude-profile-empty"
        :class="{ hidden: !timeline.altitudeProfileEmptyVisible }"
      >
        No altitude samples
      </div>
    </div>
    <div class="timeline-altitude-profile-axis">
      <span id="timeline-altitude-min">{{ timeline.altitudeProfileMinText }}</span>
      <span id="timeline-altitude-max">{{ timeline.altitudeProfileMaxText }}</span>
    </div>
  </div>
</template>
