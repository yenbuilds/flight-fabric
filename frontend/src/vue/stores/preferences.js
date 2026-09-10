import { ref } from 'vue';
import { defineStore } from 'pinia';

export const usePreferencesStore = defineStore('preferences', () => {
  const fuelUnit = ref('gal');
  const showBranding = ref(true);

  let cycleFuelUnitHandler = null;

  function hydrate(nextState = {}) {
    if (typeof nextState.fuelUnit === 'string' && nextState.fuelUnit) {
      fuelUnit.value = nextState.fuelUnit;
    }
    if (typeof nextState.showBranding === 'boolean') {
      showBranding.value = nextState.showBranding;
    }
  }

  function registerRuntimeActions(actions = {}) {
    cycleFuelUnitHandler = typeof actions.cycleFuelUnit === 'function'
      ? actions.cycleFuelUnit
      : null;
  }

  function requestFuelUnitCycle() {
    if (typeof cycleFuelUnitHandler !== 'function') {
      return false;
    }
    cycleFuelUnitHandler();
    return true;
  }

  return {
    fuelUnit,
    hydrate,
    registerRuntimeActions,
    requestFuelUnitCycle,
    showBranding,
  };
});
