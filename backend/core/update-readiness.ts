'use strict';

type UpdateReadiness = {
  connected: unknown;
  observedAt: number;
  now: number;
  recording: boolean;
  finalizing: boolean;
  replay: boolean;
  requests: number;
  shuttingDown: boolean;
};

export function getUpdateBlocker(state: UpdateReadiness): string {
  if (state.shuttingDown) return 'FlightFabric is already shutting down.';
  if (state.recording || state.finalizing) return 'Finish recording and wait for the flight log to finish saving before updating.';
  if (state.replay) return 'Finish replay and recovery before updating.';
  if (state.connected !== false || !Number.isFinite(state.observedAt) || !Number.isFinite(state.now) || state.observedAt <= 0 || state.now - state.observedAt > 5000 || state.now < state.observedAt) {
    return 'Close the simulator and wait for FlightFabric to confirm disconnection before updating.';
  }
  if (state.requests > 0) return 'Wait for pending FlightFabric operations to finish, then try again.';
  return '';
}
