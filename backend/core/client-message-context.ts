// Minimal context boundary for client-message-handler.

export type ClientMessageContextState = {
  lastSimState: unknown;
  getSimState?: unknown;
  getPhase: unknown;
  flightCsvWriter: unknown;
  flightCsvStore?: unknown;
  recordingBundleGuard: unknown;
  flightActive: unknown;
  flightId: unknown;
  flightStartIso: unknown;
  flightStartAircraftTitle: unknown;
  recordingSession: unknown;
  startFlightManual: unknown;
  endFlight: unknown;
  getDestinationTarget: unknown;
  setDestinationTarget: unknown;
  clearDestinationTarget: unknown;
  getOriginTarget: unknown;
  setOriginTarget: unknown;
  clearOriginTarget: unknown;
  replayMessages: unknown;
  provider: unknown;
  broadcast: unknown;
  getCabinAnnouncementsConfig?: unknown;
  reconfigureCabinAnnouncements?: unknown;
  timeNow: unknown;
  Debug: unknown;
};

export function buildClientMessageContext(state: ClientMessageContextState): ClientMessageContextState {
  return {
    lastSimState: state.lastSimState,
    getSimState: state.getSimState,
    getPhase: state.getPhase,
    flightCsvWriter: state.flightCsvWriter,
    flightCsvStore: state.flightCsvStore,
    recordingBundleGuard: state.recordingBundleGuard,
    flightActive: state.flightActive,
    flightId: state.flightId,
    flightStartIso: state.flightStartIso,
    flightStartAircraftTitle: state.flightStartAircraftTitle,
    recordingSession: state.recordingSession,
    startFlightManual: state.startFlightManual,
    endFlight: state.endFlight,
    getDestinationTarget: state.getDestinationTarget,
    setDestinationTarget: state.setDestinationTarget,
    clearDestinationTarget: state.clearDestinationTarget,
    getOriginTarget: state.getOriginTarget,
    setOriginTarget: state.setOriginTarget,
    clearOriginTarget: state.clearOriginTarget,
    replayMessages: state.replayMessages,
    provider: state.provider,
    broadcast: state.broadcast,
    getCabinAnnouncementsConfig: state.getCabinAnnouncementsConfig,
    reconfigureCabinAnnouncements: state.reconfigureCabinAnnouncements,
    timeNow: state.timeNow,
    Debug: state.Debug,
  };
}
