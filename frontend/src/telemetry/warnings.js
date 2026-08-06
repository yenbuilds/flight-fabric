export function createTelemetryWarnings({
  localStorageRef = null,
  setTimeoutRef = setTimeout,
  clearTimeoutRef = clearTimeout,
  statusStore = null,
  flightStore = null,
} = {}) {
  let fuelWarningTimeout = null;
  let cabinWarningTimeout = null;

  function getStorageItem(key) {
    const storageRef = localStorageRef || (typeof localStorage !== 'undefined' ? localStorage : null);
    try {
      return typeof storageRef?.getItem === 'function' ? storageRef.getItem(key) : null;
    } catch (_error) {
      return null;
    }
  }

  function formatNumberLabel(value, digits = 0, fallback = '?') {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue.toFixed(digits) : fallback;
  }

  function showDiskWarning(msg = {}) {
    statusStore?.showDiskWarning?.(msg);

    console.error(`[UI] DISK WARNING: ${msg.message || 'Disk space warning'}`);
    if (msg.level === 'critical') {
      console.error(`[UI] Recording stopped - ${msg.rowsWritten || 0} rows preserved`);
    }
  }

  function showUpdateBanner(msg = {}) {
    const dismissedVersion = getStorageItem('ff-update-dismissed');
    if (msg.latestVersion && dismissedVersion === msg.latestVersion) return;

    statusStore?.showUpdateBanner?.(msg);

    console.log(`[UI] Update available: ${msg.currentVersion} \u2192 ${msg.latestVersion}`);
  }

  function showWarningIndicator(type, active, ias, overspeedType) {
    flightStore?.updateSpeedWarning?.({ type, active, ias, overspeedType });

    if (active) {
      const label = type === 'overspeed'
        ? (overspeedType === 'vfe' ? 'FLAP OVERSPEED' : 'OVERSPEED')
        : 'STALL';
      console.log(`\u26A0\uFE0F ${label} warning at ${formatNumberLabel(ias)}kts`);
    }
  }

  function showFuelExhaustedWarning(msg = {}) {
    if (msg.exhausted) {
      flightStore?.showFuelExhaustedWarning?.(msg);
      console.log(`\u26FD Fuel exhausted - ${formatNumberLabel(msg.fuelGal, 2, '0')} gal remaining`);

      clearTimeoutRef(fuelWarningTimeout);
      fuelWarningTimeout = setTimeoutRef(() => {
        flightStore?.hideFuelExhaustedWarning?.();
      }, 30000);
    }
  }

  function showCabinAltitudeWarning(msg = {}) {
    flightStore?.updateCabinAltitudeWarning?.(msg);

    if (msg.active) {
      if (msg.severity === 'critical') {
        console.log(`\u26A0\uFE0F CRITICAL: Cabin altitude ${msg.cabinAltFt} ft - hypoxia risk!`);

        clearTimeoutRef(cabinWarningTimeout);
        cabinWarningTimeout = setTimeoutRef(() => {
          flightStore?.hideCabinAltitudeBanner?.();
        }, 10000);
      } else {
        console.log(`\u26A0\uFE0F Cabin altitude warning: ${msg.cabinAltFt} ft`);
      }
    } else {
      clearTimeoutRef(cabinWarningTimeout);
    }
  }

  return {
    showCabinAltitudeWarning,
    showDiskWarning,
    showFuelExhaustedWarning,
    showUpdateBanner,
    showWarningIndicator,
  };
}
