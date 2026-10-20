<script setup>
defineProps({ kind: { type: String, default: 'headset' } });
</script>

<template>
  <!-- Adjacent text names the action. These static drawings add no focus stops. -->
  <svg class="setup-illustration" viewBox="0 0 120 88" fill="none" aria-hidden="true" focusable="false">
    <ellipse cx="60" cy="76" rx="44" ry="6" fill="currentColor" opacity=".06" />
    <g stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <g v-if="kind === 'headset'">
        <path d="M29 49V38a31 31 0 0 1 62 0v11" />
        <path d="M36 32a25 25 0 0 1 48 0" opacity=".35" />
        <rect x="23" y="40" width="15" height="27" rx="7" class="setup-illustration-accent" />
        <rect x="82" y="40" width="15" height="27" rx="7" class="setup-illustration-accent" />
        <path d="M88 65v4a7 7 0 0 1-7 7H64" />
        <rect x="53" y="72" width="14" height="7" rx="3.5" class="setup-illustration-accent" />
        <path d="M49 45v8m7-15v22m8-19v16m7-11v6" class="setup-illustration-accent" />
      </g>
      <g v-else-if="kind === 'keyboard'">
        <rect x="12" y="27" width="96" height="44" rx="8" />
        <path d="M22 38h5m9 0h5m9 0h5m9 0h5m9 0h5m9 0h5M22 49h5m9 0h5m9 0h5m9 0h5m9 0h5M23 60h8m10 0h39" opacity=".55" />
        <rect x="86" y="45" width="13" height="18" rx="3" class="setup-illustration-accent" />
        <path d="M92 18v-7m-8 9-4-5m20 5 4-5" class="setup-illustration-accent" />
      </g>
      <g v-else-if="kind === 'controller'">
        <path d="M34 66h52l10 8v5H24v-5Z" />
        <path d="m46 66 5-10h18l5 10M54 56l-7-25q-2-8 3-13l7-7h14q8 0 8 8v7l-10 6-4 24" />
        <path d="m69 32 8 2q3 1 2 5l-3 8h-8" />
        <path d="m53 20 6-5h10v8H57Z" class="setup-illustration-accent" />
        <path d="m52 36 10-2m-8 9 7-2M81 71h5" opacity=".5" />
      </g>
      <g v-else-if="kind === 'touch'">
        <rect x="21" y="11" width="78" height="59" rx="7" />
        <rect x="38" y="24" width="44" height="25" rx="12" class="setup-illustration-accent" />
        <path d="M60 30v10m-5-3a5 5 0 0 0 10 0M60 45v-3" />
        <path d="M66 75 55 62q-4-5 0-7 2-1 7 3V43q0-6 5-6t5 6v12q17-4 17 8l-2 12" fill="rgb(var(--panel))" />
      </g>
      <g v-else-if="kind === 'phone'">
        <rect x="9" y="16" width="65" height="43" rx="5" />
        <path d="M41 59v12m-14 0h29M28 37l8 8 17-18" class="setup-illustration-accent" />
        <rect x="84" y="31" width="27" height="46" rx="6" />
        <path d="M94 70h7M79 22l6-7m-11 0h11v11" class="setup-illustration-accent" />
      </g>
      <g v-else>
        <path d="M60 11q6 0 6 13v15l35 20v8L66 56v13l10 6v5l-16-4-16 4v-5l10-6V56L19 67v-8l35-20V24q0-13 6-13Z" />
      </g>
    </g>
  </svg>
</template>
