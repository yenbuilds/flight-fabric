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
