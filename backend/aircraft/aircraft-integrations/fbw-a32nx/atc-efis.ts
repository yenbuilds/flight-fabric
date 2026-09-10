import type { AircraftIntegrationAction, AircraftIntegrationField } from '../types.js';

export function atcEfisFields(): Record<string, AircraftIntegrationField> {
  const bool = (id: string, name: string, trueValues = [1], falseValues = [0]): AircraftIntegrationField => ({
    id, sources: [{ route: { type: 'lvar', name, unit: 'Number' }, decode: { type: 'boolean', trueValues, falseValues } }],
  });
  return {
    'surveillance.squawk': { id: 'surveillance.squawk', sources: [{ route: {
      type: 'lvar', name: 'A:TRANSPONDER CODE:1', unit: 'Bco16',
    }, decode: { type: 'squawk-bco16' } }] },
    'surveillance.powered': bool('surveillance.powered', 'A:TRANSPONDER STATE:1', [1, 2, 3, 4, 5]),
    'surveillance.transmitting': bool('surveillance.transmitting', 'A:TRANSPONDER STATE:1', [3, 4, 5], [0, 1, 2]),
    'surveillance.ident': bool('surveillance.ident', 'A:TRANSPONDER IDENT:1'),
    ...Object.fromEntries(['Captain', 'FirstOfficer'].map((side) => {
      const id = `navigation.ls${side}`;
      return [id, bool(id, `L:A32NX_FCU_EFIS_${side === 'Captain' ? 'L' : 'R'}_LS_LIGHT_ON`)];
    })),
  };
}

export function atcEfisActions(): Record<string, AircraftIntegrationAction> {
  const guard = (groupId: string) => ({ groupId: `fbwA32nx.${groupId}`, cooldownMs: 750, retry: 'never' as const });
  return {
    'surveillance.squawk.set': {
      id: 'surveillance.squawk.set', input: { type: 'number', min: 0, max: 7777, step: 1 },
      guard: guard('surveillance.squawk'), verification: 'untested', routes: [{
        id: 'fbwA32nx.surveillance.squawk.set', transport: 'simconnect-sequence',
        precondition: { fieldId: 'surveillance.powered', expectedValue: true, freshness: 'field' },
        operations: [{ type: 'event', name: 'XPNDR_SET', inputValue: { source: 'input', encoding: 'squawk-bco16' } }],
        readback: { fieldId: 'surveillance.squawk', expectedInput: true, timeoutMs: 2500, freshness: 'field' },
      }],
    },
    'surveillance.ident.activate': {
      id: 'surveillance.ident.activate', guard: guard('surveillance.ident'), verification: 'untested', routes: [{
        id: 'fbwA32nx.surveillance.ident.activate', transport: 'simconnect-sequence',
        precondition: { fieldId: 'surveillance.transmitting', expectedValue: true, freshness: 'field' },
        operations: [{ type: 'event', name: 'XPNDR_IDENT_ON', value: 0 }],
        readback: { fieldId: 'surveillance.ident', expectedValue: true, timeoutMs: 2500, freshness: 'field' },
      }],
    },
    ...Object.fromEntries(['Captain', 'FirstOfficer'].flatMap((side) => [false, true].map((on) => {
      const id = `navigation.ls${side}.${on ? 'on' : 'off'}`;
      return [id, { id, guard: guard(`navigation.ls${side}`), verification: 'untested', routes: [{
        id: `fbwA32nx.${id}`, transport: 'simconnect-sequence',
        precondition: { fieldId: 'baro.healthy', expectedValue: true, freshness: 'field' },
        operations: [{ type: 'event', name: `A32NX.FCU_EFIS_${side === 'Captain' ? 'L' : 'R'}_LS_PUSH`, value: 0 }],
        readback: { fieldId: `navigation.ls${side}`, expectedValue: on, timeoutMs: 2500, freshness: 'field' },
      }] } as AircraftIntegrationAction];
    }))),
  };
}
