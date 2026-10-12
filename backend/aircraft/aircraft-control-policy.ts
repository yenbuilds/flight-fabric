import { getTriStarKeyEventPolicy } from './aircraft-integrations/inibuilds-tristar/key-event-policy.js';
import { getPmdg777ReadbackFailureHint } from './aircraft-integrations/pmdg-777/control-feedback.js';

/** Compatibility policy for already-validated profile key-event requests. */
export function resolveProfileKeyEventPolicy(profileKey: string, eventName: string) {
  return getTriStarKeyEventPolicy(profileKey, eventName);
}

/** Aircraft advice supplements a failed readback; it never authorizes a write. */
export function getAircraftReadbackFailureHint(adapterId: string, actionId: string): string {
  return adapterId === 'pmdg-777' ? getPmdg777ReadbackFailureHint(actionId) : '';
}
