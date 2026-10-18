// An observation lost after dispatch cannot establish that the lever failed to
// move. Leave successful results and actual transport/preflight rejection with
// their existing handlers; this policy changes feedback, never write behavior.
export function spoilerObservationFailureText(result = {}, request = result.command || result.request || {}) {
  const commandId = request.commandId || result.commandId;
  if (commandId) {
    if (!['surfaces.spoilers.set', 'surfaces.spoilersArmed.set'].includes(commandId)) return null;
  } else if (request.control !== 'spoilers' && !(request.control === 'aircraft-specific'
    && request.operation === 'execute'
    && /^(?:flightControls\.speedbrake|controls\.(?:speedbrake|spoilers|spoilersArmed))\.(?:arm|disarm|armed|stowed|retracted|quarter|half|threeQuarter|full|set|on|off)$/.test(request.actionId || request.target || ''))) {
    return null;
  }
  if (result.ok !== false || result.executionStarted !== true || ![
    'aircraft_integration_readback_timeout', 'aircraft_integration_selector_readback_timeout',
    'observation_interrupted', 'stale_profile', 'sdk_transport_unavailable',
  ].includes(result.code)) return null;
  return 'Spoiler selection not confirmed. Check the cockpit.';
}
