import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { useStatusStore } from './status.js';
import { useFlightStore } from './flight.js';
import { useAircraftControlsStore } from './aircraft-controls.js';

// Kept alive by the shell so tab changes do not revive dismissed reminders and
// arrival context is observed even while the user is looking at another page.
export const useFlightCuesStore = defineStore('flightCues', () => {
  const status = useStatusStore();
  const flight = useFlightStore();
  const controls = useAircraftControlsStore();
  const dismissed = ref([]);
  const arrived = ref(false);
  watch(() => status.phase, phase => {
    dismissed.value = [];
    if (phase === 'TAXI-IN') arrived.value = true;
    else if (['TAXI', 'TAKEOFF', '--', 'UNKNOWN'].includes(phase)) arrived.value = false;
  }, { immediate: true, flush: 'sync' });
  watch(() => [status.simConnected, status.simInMenu, flight.mode, status.aircraftProfile.profileKey,
    controls.aircraftCommandCatalogue.profileRevision], () => {
    dismissed.value = [];
    arrived.value = status.phase === 'TAXI-IN';
  }, { flush: 'sync' });
  const dismiss = key => { if (key && !dismissed.value.includes(key)) dismissed.value.push(key); };
  const restore = () => { dismissed.value = []; };
  return { dismissed, arrived, dismiss, restore };
});
