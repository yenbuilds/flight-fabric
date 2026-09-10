import { freshAircraftValue } from '../voice/state-queries.js';

// The backend catalogue owns which aircraft fields mean starting/available.
// Elapsed startup time and switch master ON never supply an observed outcome.
export function presetObservation(command, snapshot, nowMs = Date.now()) {
  if (snapshot?.available !== true) return null;
  const matches = command?.observations?.filter((observation) => (
    Object.is(freshAircraftValue(snapshot, observation.fieldId, nowMs), observation.expectedValue)
  )) || [];
  if (!matches.length) return null;
  // Keep the highest-priority status visible while honoring every fresh guard.
  return { ...matches[0], inhibitsRequest: matches.some((observation) => observation.inhibitsRequest === true) };
}
