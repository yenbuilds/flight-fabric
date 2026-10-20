<template>
  <!-- Decorative waiting-state scene: the adjacent status text carries the meaning. -->
  <div class="waiting-scene" aria-hidden="true">
    <div class="waiting-scene-aircraft">
      <svg viewBox="0 0 200 110" fill="none" focusable="false">
        <defs>
          <radialGradient id="ff-waiting-glow-red"><stop offset="0" class="glow-red" /><stop offset="1" class="glow-red" stop-opacity="0" /></radialGradient>
          <radialGradient id="ff-waiting-glow-green"><stop offset="0" class="glow-green" /><stop offset="1" class="glow-green" stop-opacity="0" /></radialGradient>
          <radialGradient id="ff-waiting-glow-white"><stop offset="0" class="glow-white" /><stop offset="1" class="glow-white" stop-opacity="0" /></radialGradient>
          <linearGradient id="ff-waiting-beam" x1="0" x2="1"><stop offset="0" class="glow-white" stop-opacity=".22" /><stop offset="1" class="glow-white" stop-opacity="0" /></linearGradient>
          <linearGradient id="ff-waiting-wash" x1="1" y1="0" x2="0" y2="0"><stop offset="0" class="glow-white" stop-opacity=".32" /><stop offset="1" class="glow-white" stop-opacity="0" /></linearGradient>
        </defs>

        <!-- Taxi light ahead of the nose. -->
        <path class="scene-light" style="--on: 3s" d="M127 52.5 194 36v38l-67-16.5Z" fill="url(#ff-waiting-beam)" />

        <g class="waiting-scene-airframe" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M82 50 55 9q-4-3-8 0l13 41M82 60 55 101q-4 3-8 0l13-41" />
          <path d="M30 50 18 31q-3-2-6 0l7 19M30 60 18 79q-3 2-6 0l7-19" />
          <rect x="63" y="29" width="17" height="7" rx="3.5" />
          <rect x="63" y="74" width="17" height="7" rx="3.5" />
          <path d="M128 55c0-3.5-4-5-10-5H30c-10 0-16 2-18 5 2 3 8 5 18 5h88c6 0 10-1.5 10-5Z" />
          <path d="M121 52.5h3" opacity=".6" />
        </g>

        <!-- Wing lights wash the leading edges from the fuselage. -->
        <g class="scene-light" style="--on: 2.2s" fill="url(#ff-waiting-wash)">
          <path d="M92 50 59 21l6-5 29 34Z" />
          <path d="M92 60 59 89l6 5 29-34Z" />
        </g>

        <!-- Position lights: red port, green starboard, white tail. -->
        <g class="scene-light" style="--on: .4s">
          <circle cx="50" cy="8" r="6" fill="url(#ff-waiting-glow-red)" />
          <circle cx="50" cy="102" r="6" fill="url(#ff-waiting-glow-green)" />
          <circle cx="11" cy="55" r="5" fill="url(#ff-waiting-glow-white)" opacity=".7" />
          <circle cx="50" cy="8" r="1.3" class="dot-red" />
          <circle cx="50" cy="102" r="1.3" class="dot-green" />
        </g>

        <g class="scene-light" style="--on: 1.2s">
          <g class="scene-beacon">
            <circle cx="74" cy="55" r="9" fill="url(#ff-waiting-glow-red)" />
            <circle cx="74" cy="55" r="1.5" class="dot-red" />
          </g>
        </g>

        <g class="scene-light" style="--on: 3.8s">
          <g class="scene-strobe">
            <circle cx="47" cy="9" r="8" fill="url(#ff-waiting-glow-white)" />
            <circle cx="47" cy="101" r="8" fill="url(#ff-waiting-glow-white)" />
            <circle cx="11" cy="55" r="7" fill="url(#ff-waiting-glow-white)" />
          </g>
        </g>
      </svg>
    </div>
  </div>
</template>

<style scoped>
/*
 * Lights come on in sequence while parked, the aircraft taxis off the left of
 * the track, then it crosses slowly on a long loop with a quiet gap between
 * passes. Only the aircraft wrapper moves (a composited transform), and the
 * strobes and beacon stay small, soft glows rather than full flashes.
 */
.waiting-scene {
  --plane-w: clamp(7.5rem, 26cqw, 11.5rem);
  container-type: inline-size;
  position: relative;
  overflow: hidden;
  pointer-events: none;
  user-select: none;
  background:
    linear-gradient(90deg, rgb(var(--warning) / 0.32) 0 55%, transparent 0) 0 50% / 1.75rem 2px repeat-x,
    linear-gradient(rgb(var(--border) / 0.5), rgb(var(--border) / 0.5)) 0 24% / 100% 1px no-repeat,
    linear-gradient(rgb(var(--border) / 0.5), rgb(var(--border) / 0.5)) 0 76% / 100% 1px no-repeat;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent);
}
.waiting-scene-aircraft {
  width: var(--plane-w);
  animation:
    waiting-scene-depart 30s cubic-bezier(0.45, 0, 0.75, 0.6) 5s both,
    waiting-scene-taxi 46s linear 35s infinite;
}
.waiting-scene-aircraft svg { display: block; width: 100%; height: auto; overflow: visible; }
.waiting-scene-airframe { stroke: rgb(var(--muted-foreground)); fill: rgb(var(--panel)); }

.glow-red { stop-color: rgb(var(--danger)); }
.glow-green { stop-color: rgb(var(--success)); }
.glow-white { stop-color: rgb(var(--foreground)); }
.dot-red { fill: rgb(var(--danger)); }
.dot-green { fill: rgb(var(--success)); }

.scene-light { opacity: 0; animation: waiting-scene-light-on 0.9s ease-out var(--on, 0s) forwards; }
.scene-beacon { animation: waiting-scene-beacon 1.4s ease-in-out infinite; }
.scene-strobe { opacity: 0; animation: waiting-scene-strobe 2.4s linear infinite; }

@keyframes waiting-scene-light-on { to { opacity: 1; } }
@keyframes waiting-scene-depart {
  from { transform: translateX(2cqw); }
  to { transform: translateX(100cqw); }
}
@keyframes waiting-scene-taxi {
  0% { transform: translateX(calc(-1 * var(--plane-w))); }
  86%, 100% { transform: translateX(100cqw); }
}
@keyframes waiting-scene-beacon {
  0%, 100% { opacity: 0.15; }
  45% { opacity: 0.9; }
}
@keyframes waiting-scene-strobe {
  0%, 4.5%, 9% { opacity: 0; }
  1.5% { opacity: 0.8; }
  6% { opacity: 0.6; }
}

@media (prefers-reduced-motion: reduce) {
  .waiting-scene-aircraft { animation: none; transform: translateX(4cqw); }
  .scene-light { animation: none; opacity: 1; }
  .scene-beacon { animation: none; opacity: 0.5; }
  .scene-strobe { display: none; }
}
@media (forced-colors: active) { .waiting-scene { display: none; } }
</style>
