import {
  emitAppSettingsSaved,
  emitDebugFrame,
  emitWsMessage,
} from './runtime-signals.js';

const FLIGHT_STORE_MESSAGE_TYPES = new Set([
  'ias',
  'gs',
  'vs',
  'altitude',
  'heading',
  'xwind',
  'fuel',
  'gear',
  'lights',
  'flaps',
  'spoilers',
  'engines',
  'environment',
  'overspeed',
  'stall',
  'fuelExhausted',
  'cabinAltitudeWarning',
]);

const STATUS_STORE_MESSAGE_TYPES = new Set([
  'phase',
  'simState',
  'vreSampling',
  'assists',
  'flightRecording',
  'startFlightResult',
  'endFlightResult',
  'surface',
  'runwayContext',
  'flightTime',
  'aircraftProfile',
  'dataSources',
  'updateAvailable',
]);

const LOGBOOK_STORE_MESSAGE_TYPES = new Set(['logbook', 'historyIndexStatus']);
const TIMELINE_STORE_MESSAGE_TYPES = new Set(['timelineList', 'timelineListError', 'deleteFlightCsvResult', 'historyIndexStatus']);

function updateAircraftProfileDisplay({ aircraftControl, aircraftSpecificStore }, message) {
  aircraftControl.setActiveProfileToken?.(message.profile || {});
  aircraftSpecificStore?.applyProfile?.(message.profile || {});
  const controlCapabilities = message.controlCapabilities || message.profile?.controlCapabilities || {};
  aircraftControl.applyControlCapabilities?.(controlCapabilities);
  aircraftSpecificStore?.applyActionCapabilities?.(controlCapabilities.aircraftSpecific || {});
  aircraftSpecificStore?.applyDependencies?.(controlCapabilities.aircraftSpecificDependencies || {});
  aircraftControl.setFeedback({
    profileText: message.profile?._profileKey
      || message.profile?._qualifiedId
      || (message.profile?.namespace && message.profile?.simulator && message.profile?.id
        ? `${message.profile.namespace}/${message.profile.simulator}/${message.profile.id}`
        : (message.profile?.id || 'generic')),
  });
}

function handleSimState({
  getHasSeenFlightTelemetry,
  getWasSimconnectConnected,
  setWasSimconnectConnected,
  setSimconnectTelemetryConnected,
  resetTelemetryDisplay,
  setFlightState,
  aircraftControl,
  aircraftSpecificStore,
}, message) {
  const simConnectedNow = message.simconnectConnected === true;
  setSimconnectTelemetryConnected(simConnectedNow);
  aircraftSpecificStore?.applySimState?.(message);

  if (getWasSimconnectConnected() && !simConnectedNow) {
    resetTelemetryDisplay('simconnectDisconnected');
    setSimconnectTelemetryConnected(false);
    setWasSimconnectConnected(false);
    aircraftControl.clearProfileToken?.('Simulator disconnected. Waiting for profile refresh.');
    aircraftControl.clearPendingRequests('Simulator disconnected before control request completed.');
    aircraftControl.updateAvailability();
    return;
  }

  setWasSimconnectConnected(simConnectedNow);
  aircraftControl.updateAvailability();

  const showInMenu = simConnectedNow && message.inMenu === true;

  if (!simConnectedNow) {
    setFlightState('disconnected', {
      title: 'Simulator disconnected',
      copy: 'The app is reachable, but the simulator telemetry session is not currently connected.',
    });
  } else if (showInMenu) {
    setFlightState('inMenu');
  } else if (getHasSeenFlightTelemetry()) {
    setFlightState('live');
  } else {
    setFlightState('waiting', {
      copy: 'Connected to the simulator. Waiting for flight data from the active aircraft.',
    });
  }

}

function handleEndFlightResult({ consoleRef = console, alertRef = alert }, message) {
  if (message.success) {
    consoleRef.log('[UI] Flight ended manually:', message.reason);
    return;
  }
  alertRef(`Could not end flight: ${message.error || 'Unknown error'}`);
}

function handleStartFlightResult({ consoleRef = console, alertRef = alert }, message) {
  if (message.success) {
    consoleRef.log('[UI] Flight recording started manually:', message.flightId || message.reason);
    return;
  }
  alertRef(`Could not start recording: ${message.error || 'Unknown error'}`);
}

function handleCabinAnnouncement({ getCabinAnnouncements }, message) {
  const cabinAnnouncements = typeof getCabinAnnouncements === 'function'
    ? getCabinAnnouncements()
    : null;
  if (!cabinAnnouncements || typeof cabinAnnouncements.enqueue !== 'function') return;
  cabinAnnouncements.enqueue(message);
}

function resolveFlightStore({ flightStore, getFlightStore }) {
  if (flightStore) return flightStore;
  return typeof getFlightStore === 'function' ? getFlightStore() : null;
}

export function createAppMessageHandler({
  alertRef = alert,
  consoleRef = console,
  LIVE_TELEMETRY_MESSAGE_TYPES,
  getSimconnectTelemetryConnected,
  setSimconnectTelemetryConnected,
  getWasSimconnectConnected,
  setWasSimconnectConnected,
  getHasSeenFlightTelemetry,
  markFlightTelemetryActive,
  resetTelemetryDisplay,
  setFlightState,
  telemetryDisplay,
  appPreferences,
  autopilotPanel,
  aircraftControl,
  aircraftSpecificStore = null,
  landingController,
  telemetryWarnings,
  statusIndicators,
  lvarInspector,
  appSettingsController,
  updateEngines,
  flightStore,
  getFlightStore = () => null,
  statusStore = null,
  logbookStore = null,
  timelineStore = null,
  desktopIntegration = null,
  getCabinAnnouncements = () => null,
} = {}) {
  const aircraftProfileDeps = { aircraftControl, aircraftSpecificStore };
  const simStateDeps = {
    getHasSeenFlightTelemetry,
    getWasSimconnectConnected,
    setWasSimconnectConnected,
    setSimconnectTelemetryConnected,
    resetTelemetryDisplay,
    setFlightState,
    aircraftControl,
    aircraftSpecificStore,
  };
  const flightRecordingActionDeps = { consoleRef, alertRef };
  const cabinAnnouncementDeps = { getCabinAnnouncements };

  return function handleMessage(message) {
    const activeFlightStore = resolveFlightStore({ flightStore, getFlightStore });
    if (FLIGHT_STORE_MESSAGE_TYPES.has(message?.type)) {
      activeFlightStore?.ingestMessage?.(message);
    }
    if (STATUS_STORE_MESSAGE_TYPES.has(message?.type)) {
      statusStore?.ingestMessage?.(message);
    }
    if (LOGBOOK_STORE_MESSAGE_TYPES.has(message?.type)) {
      logbookStore?.ingestMessage?.(message);
    }
    if (TIMELINE_STORE_MESSAGE_TYPES.has(message?.type)) {
      timelineStore?.ingestMessage?.(message);
    }

    emitWsMessage(message);
    emitDebugFrame(message);

    if (LIVE_TELEMETRY_MESSAGE_TYPES.has(message.type) && getSimconnectTelemetryConnected() === false) {
      return;
    }

    if (LIVE_TELEMETRY_MESSAGE_TYPES.has(message.type)) {
      markFlightTelemetryActive();
    }

    switch (message.type) {
      case 'ias':
        telemetryDisplay.updateSpeedDisplay({ ias: message.value }, { updateFlightStore: false });
        break;
      case 'gs':
        telemetryDisplay.updateSpeedDisplay({ gs: message.value }, { updateFlightStore: false });
        break;
      case 'vs':
        telemetryDisplay.updateVerticalSpeedDisplay(message.value, { updateFlightStore: false });
        break;
      case 'altitude':
        telemetryDisplay.updateAltitudeDisplay(message, { updateFlightStore: false });
        break;
      case 'heading':
        telemetryDisplay.updateHeadingDisplay(message, { updateFlightStore: false });
        break;
      case 'xwind':
        break;
      case 'fuel':
        telemetryDisplay.updateFuelDisplay(message);
        break;
      case 'fuelUnit':
        appPreferences.applySyncedFuelUnit(message.unit);
        break;
      case 'showBranding':
        appPreferences.applyShowBranding(message.show !== false);
        break;
      case 'autopilot':
        autopilotPanel.update(message);
        break;
      case 'aircraftControlResult':
        aircraftControl.handleResult(message);
        break;
      case 'phase':
        break;
      case 'aircraftChanged':
        resetTelemetryDisplay('aircraftChanged');
        aircraftControl.resetProfileState?.('Aircraft changed. Waiting for profile capabilities.');
        aircraftSpecificStore?.prepareForAircraftChange?.();
        break;
      case 'simState':
        handleSimState(simStateDeps, message);
        break;
      case 'engines':
        updateEngines(message.data, { updateFlightStore: false });
        break;
      case 'flightTime':
        break;
      case 'aircraftProfile':
        updateAircraftProfileDisplay(aircraftProfileDeps, message);
        break;
      case 'aircraftSpecificState':
        aircraftSpecificStore?.ingestState?.(message);
        break;
      case 'runwayContext':
        break;
      case 'assists':
        if (!statusStore) statusIndicators?.updateAssistsIndicator(message.data);
        break;
      case 'surface':
        if (!statusStore) statusIndicators?.updateSurfaceIndicator(message.value);
        break;
      case 'landing':
        landingController.handleLandingMessage(message);
        break;
      case 'flightSummary':
        landingController.handleFlightSummaryMessage(message);
        break;
      case 'ultimateStabilityScore':
        landingController.handleUltimateStabilityScoreMessage(message);
        break;
      case 'overspeed':
        telemetryWarnings.showWarningIndicator('overspeed', message.active, message.ias, message.overspeedType);
        break;
      case 'stall':
        telemetryWarnings.showWarningIndicator('stall', message.active, message.ias);
        break;
      case 'cabinAltitudeWarning':
        telemetryWarnings.showCabinAltitudeWarning(message);
        break;
      case 'fuelExhausted':
        telemetryWarnings.showFuelExhaustedWarning(message);
        break;
      case 'flightViolation':
        landingController.handleFlightViolationMessage(message);
        break;
      case 'dataSources':
        lvarInspector?.handleDataSourcesMessage(message);
        break;
      case 'flightRecording':
        if (!statusStore) statusIndicators?.updateRecordingIndicator(message);
        desktopIntegration?.setRecordingBadge?.(message);
        break;
      case 'vreSampling':
        if (!statusStore) statusIndicators?.updateVreSamplingIndicator(message);
        break;
      case 'startFlightResult':
        handleStartFlightResult(flightRecordingActionDeps, message);
        break;
      case 'endFlightResult':
        handleEndFlightResult(flightRecordingActionDeps, message);
        break;
      case 'updateAvailable':
        telemetryWarnings.showUpdateBanner(message);
        break;
      case 'diskWarning':
        telemetryWarnings.showDiskWarning(message);
        break;
      case 'appSettings':
        appSettingsController.apply(message.settings, {
          settingsFile: message.settingsFile,
          storage: message.storage,
          backendVersion: message.backendVersion,
        });
        break;
      case 'appSettingsSaved':
        if (message.ok && message.settings) {
          appSettingsController.apply(message.settings, {
            settingsFile: message.settingsFile,
            storage: message.storage,
          });
        }
        if (message.ok && message.restartRequired === true) {
          statusStore?.showRestartRequiredBanner?.(message);
        }
        emitAppSettingsSaved(message);
        break;
      case 'cabinAnnouncement':
        handleCabinAnnouncement(cabinAnnouncementDeps, message);
        break;
    }
  };
}
