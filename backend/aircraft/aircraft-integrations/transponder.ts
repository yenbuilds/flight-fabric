import type { AircraftIntegrationAction } from './types.js';

/** Opt-in only: confirm the aircraft's selected code after a BCO16 event. */
export function confirmedSquawkAction(prefix: string): AircraftIntegrationAction {
  return {
    id: 'surveillance.squawk.set', input: { type: 'number', min: 0, max: 7777, step: 1 },
    guard: { groupId: `${prefix}.surveillance.squawk`, cooldownMs: 1000, retry: 'never' },
    verification: 'untested', routes: [{
      id: `${prefix}.surveillance.squawk.set`, transport: 'simconnect-sequence',
      precondition: { fieldId: 'surveillance.powered', expectedValue: true, freshness: 'field' },
      operations: [{ type: 'event', name: 'XPNDR_SET', inputValue: { source: 'input', encoding: 'squawk-bco16' } }],
      readback: { fieldId: 'surveillance.squawk', expectedInput: true, timeoutMs: 2500, freshness: 'field' },
    }],
  };
}
