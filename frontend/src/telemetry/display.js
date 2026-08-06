export function createTelemetryDisplay({
  currentState,
  preferences,
  flightStore,
}) {
  function shouldUpdateFlightStore(options = {}) {
    return options.updateFlightStore !== false;
  }

  function updateSpeedDisplay({ ias = null, gs = null } = {}, options = {}) {
    if (shouldUpdateFlightStore(options)) {
      flightStore?.updateSpeedDisplay?.({ ias, gs });
    }

    if (ias != null) {
      const roundedIas = Math.round(ias);
      if (currentState) currentState.ias = roundedIas;
    }
  }

  function updateVerticalSpeedDisplay(vsRaw, options = {}) {
    if (shouldUpdateFlightStore(options)) {
      flightStore?.updateVerticalSpeedDisplay?.(vsRaw);
    }

    const vs = Math.round(vsRaw);
    if (currentState) currentState.vs = vs;
  }

  function updateAltitudeDisplay(message = {}, options = {}) {
    const { msl = null } = message;
    if (shouldUpdateFlightStore(options)) {
      flightStore?.updateAltitudeDisplay?.(message);
    }

    if (msl != null) {
      const roundedMsl = Math.round(msl);
      if (currentState) currentState.alt = roundedMsl;
    }
  }

  function updateHeadingDisplay(msg = {}, options = {}) {
    if (shouldUpdateFlightStore(options)) {
      flightStore?.updateHeadingDisplay?.(msg);
    }

    const heading = Math.round(msg.mag ?? msg.true ?? 0);
    if (currentState) currentState.hdg = heading;
  }

  function updateFuelDisplay(fuel) {
    if (typeof preferences?.setFuelTelemetry === 'function') {
      preferences.setFuelTelemetry(fuel);
      return;
    }
    preferences?.setFuelGallons?.(fuel && typeof fuel === 'object' ? fuel.totalGal : fuel);
  }

  function updateEngineDisplay(data, options = {}) {
    if (shouldUpdateFlightStore(options)) {
      flightStore?.updateEngineDisplay?.(data);
    }
  }

  return {
    updateSpeedDisplay,
    updateVerticalSpeedDisplay,
    updateAltitudeDisplay,
    updateHeadingDisplay,
    updateFuelDisplay,
    updateEngineDisplay,
  };
}
