<script setup>
import { SUPPORT_URL as href } from '../../support/links.js';
</script>

<template>
  <a class="app-support-link" :href="href" target="_blank" rel="noopener noreferrer"
    aria-label="Support FlightFabric — buy me a coffee" title="Support FlightFabric — buy me a coffee">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg>
    <span class="app-support-link-copy"><strong>Support FlightFabric</strong><small>Buy me a coffee</small></span>
  </a>
</template>
