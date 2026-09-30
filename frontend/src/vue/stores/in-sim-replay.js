import { defineStore } from 'pinia';

// Availability comes from the backend, never a browser preference. Retain the
// recovery surface across disconnects, but require a fresh opt-in to start.
export const useInSimReplayStore = defineStore('in-sim-replay', {
  state: () => ({ enabled: false, blocked: false }),
  actions: {
    receive(message) {
      if (message?.type !== 'inSimReplayState') return;
      this.enabled = message.enabled === true;
      this.blocked = message.blocked === true;
    },
    disconnect() { this.enabled = false; },
  },
});
