import type { AircraftIntegrationAction, AircraftIntegrationField } from './types.js';
import { confirmedSquawkAction } from './transponder.js';

/** Shared simulator transponder state; PMDG's SDK does not publish the code. */
export function pmdgAtcFields(): Record<string, AircraftIntegrationField> {
  const boolean = (id: string, name: string, trueValues: number[], falseValues: number[]): AircraftIntegrationField => ({
    id, sources: [{ route: { type: 'lvar', name, unit: 'Number' }, decode: { type: 'boolean', trueValues, falseValues } }],
  });
  return {
    'surveillance.squawk': { id: 'surveillance.squawk', sources: [{ route: {
      type: 'lvar', name: 'A:TRANSPONDER CODE:1', unit: 'Bco16',
    }, decode: { type: 'squawk-bco16' } }] },
    'surveillance.powered': boolean('surveillance.powered', 'A:TRANSPONDER STATE:1', [1, 2, 3, 4, 5], [0]),
    'surveillance.transmitting': boolean('surveillance.transmitting', 'A:TRANSPONDER STATE:1', [3, 4, 5], [0, 1, 2]),
  };
}

export function pmdgAtcActions(prefix: 'pmdg737' | 'pmdg777', identSwitch: 806 | 746): Record<string, AircraftIntegrationAction> {
  const guard = (control: string) => ({ groupId: `${prefix}.surveillance.${control}`, cooldownMs: 1000, retry: 'never' as const });
  return {
    'surveillance.squawk.set': confirmedSquawkAction(prefix),
    'surveillance.ident.activate': {
      id: 'surveillance.ident.activate', guard: guard('ident'), verification: 'untested', routes: [{
        id: `${prefix}.surveillance.ident.activate`, transport: 'simconnect-sequence',
        precondition: { fieldId: 'surveillance.transmitting', expectedValue: true, freshness: 'field' },
        operations: [
          { type: 'event', name: 'ROTOR_BRAKE', value: identSwitch * 100 + 1 },
          { type: 'event', name: 'ROTOR_BRAKE', value: identSwitch * 100 + 4 },
        ],
        // The SDK exposes a button, not the duration of the transmitted IDENT.
        confirmation: 'transport-acknowledged',
      }],
    },
  };
}
