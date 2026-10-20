// A successful write is not necessarily a confirmed flap selection. Keep
// button and voice feedback on the same result contract for every aircraft.
export function flapResultText(result = {}, request = result.command || result.request || {}) {
  const commandId = request.commandId || result.commandId;
  const fixedSelection = commandId === 'surfaces.flaps.set';
  if (!fixedSelection && commandId !== 'surfaces.flaps.adjust' && request.control !== 'flaps') return null;

  if (result.ok === true) {
    const value = request.input?.value;
    const hasReadback = (typeof result.confirmedValue === 'number' && Number.isFinite(result.confirmedValue))
      || (typeof result.confirmedValue === 'string' && result.confirmedValue.trim() !== '');
    if (fixedSelection && hasReadback && result.transportAcknowledged !== true
      && result.code !== 'sent_unconfirmed' && typeof value === 'string' && value.trim()) {
      return { outcome: 'confirmed', text: `Flaps ${value} selected.` };
    }
    // Relative routes can observe an index change without proving one lever
    // detent in the requested direction. Generic/profile writes may only ACK.
    // Neither supports claiming a named selection or completed surface travel.
    return result.noOp === true
      ? { outcome: 'unconfirmed', text: 'Flap selection not confirmed. Check the cockpit.' }
      : { outcome: 'sent', text: 'Flap command sent. Check the cockpit.' };
  }

  if (result.executionStarted === true && [
    'aircraft_integration_readback_timeout', 'aircraft_integration_selector_readback_timeout',
    'observation_interrupted', 'stale_profile', 'sdk_transport_unavailable',
  ].includes(result.code)) {
    return { outcome: 'unconfirmed', text: 'Flap selection not confirmed. Check the cockpit.' };
  }
  return { outcome: 'failed', text: 'Flap command failed. Check the cockpit.' };
}

// Gear feedback describes handle selection, not completed gear travel. Share
// the evidence rules between canonical commands, legacy buttons and voice.
export function gearResultText(result = {}, request = result.command || result.request || {}) {
  const commandId = request.commandId || result.commandId;
  if (commandId && commandId !== 'surfaces.gear.set') return null;
  const actionMatch = request.control === 'aircraft-specific' && request.operation === 'execute'
    ? /^(?:gear\.handle\.(up|down|off)|controls\.gear\.(up|down))$/.exec(request.actionId || request.target || '')
    : null;
  const actionTarget = actionMatch?.[1] || actionMatch?.[2];
  if (!commandId && request.control !== 'gear' && !actionTarget) return null;

  const requestedValue = commandId ? request.input?.value
    : request.control === 'gear' ? request.operation : actionTarget;
  const target = ['up', 'down', 'off'].includes(requestedValue) ? requestedValue : null;
  const unconfirmed = { outcome: 'unconfirmed', text: 'Gear selection not confirmed. Check the cockpit.' };

  if (result.ok === true) {
    // PMDG 737 publishes an enum; PMDG 777 and standard-handle routes publish
    // a boolean. A false readback is valid UP evidence, not a missing value.
    const matches = target != null && (result.confirmedValue === target
      || (target === 'up' && result.confirmedValue === false)
      || (target === 'down' && result.confirmedValue === true));
    const deliveryOnly = result.code === 'sent_unconfirmed' || result.transportAcknowledged === true;
    if (matches && !deliveryOnly) return { outcome: 'confirmed', text: `Gear ${target} selected.` };
    // A no-op cannot claim a write; an inconsistent explicit readback cannot
    // confirm the requested handle position. Never infer a toggle's target.
    if (result.noOp === true || (!deliveryOnly && target != null && result.confirmedValue != null)) {
      return unconfirmed;
    }
    return { outcome: 'sent', text: 'Gear command sent. Check the cockpit.' };
  }

  // Dispatch may have started before a rejected acknowledgement. Only known
  // observation failures become unconfirmed; transport rejections stay failed.
  if (result.executionStarted === true && [
    'aircraft_integration_readback_timeout', 'aircraft_integration_selector_readback_timeout',
    'observation_interrupted', 'stale_profile', 'sdk_transport_unavailable',
  ].includes(result.code)) return unconfirmed;
  return { outcome: 'failed', text: 'Gear command failed. Check the cockpit.' };
}

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
