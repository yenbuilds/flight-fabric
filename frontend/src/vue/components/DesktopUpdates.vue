<script setup>
import { useDesktopUpdatesStore } from '../stores/desktop-updates.js';
const updates = useDesktopUpdatesStore();
</script>

<template>
  <section v-if="updates.available" class="px-4 py-4 space-y-3" aria-labelledby="desktop-updates-title">
    <h3 id="desktop-updates-title" class="text-xs font-semibold text-fg">App updates</h3>
    <p v-if="updates.supported" class="text-xs text-muted-fg">Updates download here. You choose when FlightFabric restarts to install them.</p>
    <p v-if="updates.version" class="text-sm text-fg">Version {{ updates.version }}</p>
    <p v-if="updates.notes" class="text-xs whitespace-pre-wrap break-words text-muted-fg">{{ updates.notes }}</p>
    <progress v-if="updates.phase === 'downloading'" class="w-full" :value="updates.progress || 0" max="100" aria-label="Update download progress" />
    <p class="text-xs text-muted-fg" role="status" aria-live="polite">{{ updates.localError || updates.message }}</p>
    <p v-if="updates.phase === 'ready' && updates.installBlocker" class="text-xs text-warning">{{ updates.installBlocker }}</p>
    <div class="flex flex-wrap gap-2">
      <button v-if="updates.supported" class="ff-button-secondary px-3 py-2 text-xs border border-border disabled:opacity-60" type="button" :disabled="updates.busy" @click="updates.request('check')">Check for updates</button>
      <button v-if="updates.supported && updates.version" class="ff-button-secondary px-3 py-2 text-xs border border-border disabled:opacity-60" type="button"
        :disabled="updates.busy || (updates.phase === 'ready' && Boolean(updates.installBlocker))"
        @click="updates.primaryAction()">{{ updates.actionLabel }}</button>
      <button v-if="updates.phase === 'downloading'" class="ff-button-secondary px-3 py-2 text-xs border border-border disabled:opacity-60" type="button" @click="updates.request('cancel')">Cancel download</button>
      <a class="ff-button-secondary px-3 py-2 text-xs border border-border disabled:opacity-60" href="https://github.com/yenbuilds/flight-fabric/releases" target="_blank" rel="noopener noreferrer">Website download</a>
    </div>
  </section>
</template>
