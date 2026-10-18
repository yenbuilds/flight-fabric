const { defaultAircraftIntegrationRegistry } = require('./integration-engine');

/** Compatibility policy for already-validated profile key-event requests. */
export function resolveProfileKeyEventPolicy(profileKey: string, eventName: string) {
  const definition = defaultAircraftIntegrationRegistry.resolveForProfile(profileKey);
  const policy = definition?.trustedProfileKeys.includes(profileKey) ? definition.behavior?.keyEventPolicy : null;
  const groupId = policy && Object.hasOwn(policy.eventGroups, eventName) ? policy.eventGroups[eventName] : null;
  return groupId ? { groupId, cooldownMs: policy.cooldownMs,
    inFlightError: policy.inFlightError, cooldownError: policy.cooldownError } : null;
}

/** Aircraft advice supplements a failed readback; it never authorizes a write. */
export function getAircraftReadbackFailureHint(adapterId: string, actionId: string): string {
  const definition = defaultAircraftIntegrationRegistry.getById(adapterId);
  const hints = definition?.id === adapterId ? definition.behavior?.readbackFailureHints : null;
  return hints?.find(hint => actionId.startsWith(hint.actionPrefix))?.text || '';
}
