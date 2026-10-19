export function flightGuidanceObservationFailureText(result = {}, request = result.command || result.request || {}) {
  if (result.ok !== false || result.executionStarted !== true || ![
    'aircraft_integration_readback_timeout', 'observation_interrupted',
    'stale_profile', 'sdk_transport_unavailable',
  ].includes(result.code)) return null;

  const commandId = request.commandId || result.commandId;
  const mode = commandId
    ? /^flightGuidance\.(headingSelect|headingHold|approach)\.engage$/.exec(commandId)?.[1]
    : request.control === 'aircraft-specific' && request.operation === 'execute'
      ? /^afds\.(headingSelect|headingHold|approach)\.engage$/.exec(request.actionId || request.target || '')?.[1]
      : null;
  const label = { headingSelect: 'Heading select', headingHold: 'Heading hold', approach: 'Approach selection' }[mode];
  return label ? `${label} not confirmed. Check the flight mode annunciator.` : null;
}
