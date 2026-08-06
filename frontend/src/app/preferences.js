const FUEL_UNITS = Object.freeze(['gal', 'lbs', 'kg']);
const FUEL_UNIT_LS_KEY = 'ff-fuel-unit';
const BRANDING_LS_KEY = 'ff-show-branding';
const LBS_TO_KG = 0.453592;

function readFuelUnit(storage) {
  try {
    const unit = storage.getItem(FUEL_UNIT_LS_KEY);
    return FUEL_UNITS.includes(unit) ? unit : 'gal';
  } catch {
    return 'gal';
  }
}

function readShowBranding(storage) {
  try {
    const value = storage.getItem(BRANDING_LS_KEY);
    return value === 'false' ? false : true;
  } catch {
    return true;
  }
}

function writeStorage(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch {}
}

export function createAppPreferences({
  storage = window.localStorage,
  getWsSend = () => null,
  preferencesStore = null,
  flightStore = null,
} = {}) {
  if (!preferencesStore) {
    throw new Error('Preferences store is required before app preferences runtime');
  }
  if (!flightStore) {
    throw new Error('Flight store is required before app preferences runtime');
  }

  let currentFuelUnit = readFuelUnit(storage);
  let lastFuelGal = null;
  let lastFuelWeightLbs = null;
  let currentShowBranding = readShowBranding(storage);

  function syncStore(partialState) {
    if (!preferencesStore || typeof preferencesStore.hydrate !== 'function') return;
    preferencesStore.hydrate(partialState);
  }

  syncStore({
    fuelUnit: currentFuelUnit,
    showBranding: currentShowBranding,
  });

  function convertFuel(gal, weightLbs) {
    if (currentFuelUnit === 'lbs') {
      return Number.isFinite(weightLbs) ? Math.round(weightLbs) : null;
    }
    if (currentFuelUnit === 'kg') {
      return Number.isFinite(weightLbs) ? Math.round(weightLbs * LBS_TO_KG) : null;
    }
    return Number.isFinite(gal) ? Math.round(gal) : null;
  }

  function renderFuelValue() {
    const val = convertFuel(lastFuelGal, lastFuelWeightLbs);
    const displayValue = val != null ? val.toLocaleString() : '----';

    flightStore?.updateFuelDisplay?.({
      displayValue,
      unit: currentFuelUnit,
      totalGal: lastFuelGal,
      totalWeightLbs: lastFuelWeightLbs,
    });
  }

  function setFuelTelemetry(fuel) {
    const payload = fuel && typeof fuel === 'object' ? fuel : { totalGal: fuel };
    lastFuelGal = Number.isFinite(payload.totalGal) ? payload.totalGal : null;
    lastFuelWeightLbs = Number.isFinite(payload.totalWeightLbs) ? payload.totalWeightLbs : null;
    renderFuelValue();
  }

  function applyFuelUnit(unit) {
    currentFuelUnit = unit;
    writeStorage(storage, FUEL_UNIT_LS_KEY, unit);
    syncStore({ fuelUnit: currentFuelUnit });
    renderFuelValue();
  }

  function applySyncedFuelUnit(unit) {
    if (FUEL_UNITS.includes(unit)) {
      applyFuelUnit(unit);
    }
  }

  function cycleFuelUnit() {
    const next = FUEL_UNITS[(FUEL_UNITS.indexOf(currentFuelUnit) + 1) % FUEL_UNITS.length];
    applyFuelUnit(next);
    const send = getWsSend();
    if (typeof send === 'function') {
      send({ type: 'fuelUnit', unit: next });
    }
  }

  function applyShowBranding(show) {
    currentShowBranding = show !== false;
    writeStorage(storage, BRANDING_LS_KEY, String(currentShowBranding));
    syncStore({ showBranding: currentShowBranding });
  }

  function syncToBackend() {
    const send = getWsSend();
    if (typeof send === 'function') {
      send({ type: 'fuelUnit', unit: currentFuelUnit });
      send({ type: 'showBranding', show: currentShowBranding });
    }
  }

  preferencesStore.registerRuntimeActions?.({
    cycleFuelUnit,
    applyShowBranding,
  });

  renderFuelValue();

  return {
    applyFuelUnit,
    applyShowBranding,
    applySyncedFuelUnit,
    cycleFuelUnit,
    renderFuelValue,
    setFuelGallons: setFuelTelemetry,
    setFuelTelemetry,
    syncToBackend,
  };
}
