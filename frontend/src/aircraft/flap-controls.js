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
