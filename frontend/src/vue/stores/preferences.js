import { ref } from 'vue';
import { defineStore } from 'pinia';

export const usePreferencesStore = defineStore('preferences', () => {
  const fuelUnit = ref('gal');
  const showBranding = ref(true);

  let cycleFuelUnitHandler = null;
  let applyShowBrandingHandler = null;

  function hydrate(nextState = {}) {
    if (typeof nextState.fuelUnit === 'string' && nextState.fuelUnit) {
      fuelUnit.value = nextState.fuelUnit;
    }
    if (typeof nextState.showBranding === 'boolean') {
      showBranding.value = nextState.showBranding;
    }
  }

  function setFuelUnit(unit) {
    fuelUnit.value = unit || 'gal';
  }

  function setShowBranding(show) {
    showBranding.value = show !== false;
  }

  function registerRuntimeActions(actions = {}) {
    cycleFuelUnitHandler = typeof actions.cycleFuelUnit === 'function'
      ? actions.cycleFuelUnit
      : null;
    applyShowBrandingHandler = typeof actions.applyShowBranding === 'function'
      ? actions.applyShowBranding
      : null;
  }

  function requestFuelUnitCycle() {
    if (typeof cycleFuelUnitHandler !== 'function') {
      return false;
    }
    cycleFuelUnitHandler();
    return true;
  }

  function requestShowBranding(show) {
    if (typeof applyShowBrandingHandler === 'function') {
      applyShowBrandingHandler(show);
      return true;
    }

    setShowBranding(show);
    return false;
  }

  return {
    fuelUnit,
    hydrate,
    registerRuntimeActions,
    requestFuelUnitCycle,
    requestShowBranding,
    setFuelUnit,
    setShowBranding,
    showBranding,
  };
});
