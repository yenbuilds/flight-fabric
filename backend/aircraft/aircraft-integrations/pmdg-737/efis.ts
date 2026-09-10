import type { AircraftIntegrationAction, AircraftIntegrationField } from '../types.js';

const sides = ['captain', 'firstOfficer'] as const;
const ranges = ['5', '10', '20', '40', '80', '160', '320', '640'];
export function pmdg737EfisFields(): Record<string, AircraftIntegrationField> {
  return { 'queries.flapsHandle': { id: 'queries.flapsHandle', sources: [{
    route: { type: 'lvar', name: 'A:FLAPS HANDLE INDEX', unit: 'Number' },
    decode: { type: 'enum', values: { 0: 'up', 1: '1', 2: '2', 3: '5', 4: '10', 5: '15', 6: '25', 7: '30', 8: '40' } },
  }] }, ...Object.fromEntries(sides.flatMap((side) => [
    [`efis.${side}.rangeNm`, ranges], [`efis.${side}.minimumsMode`, ['radio', 'baro']],
  ].map(([id, values]) => [id, {
    id, sources: [{ route: { type: 'sdk', adapter: 'clientdata-manifest', path: id },
      decode: { type: 'enum', values: Object.fromEntries((values as string[]).map((v) => [v, v])) } }],
  }]))) };
}

export function pmdg737EfisActions(): Record<string, AircraftIntegrationAction> {
  const actions: Record<string, AircraftIntegrationAction> = {};
  for (const [index, side] of sides.entries()) {
    for (const [kind, values, eventId, field] of [
      ['range', ranges, index === 0 ? 69993 : 70049, 'rangeNm'],
      ['minimums', ['radio', 'baro'], index === 0 ? 69988 : 70044, 'minimumsMode'],
    ] as const) {
      for (const [raw, value] of values.entries()) {
        const id = `efis.${side}.${kind}.${kind === 'range' ? `nm${value}` : value}`;
        actions[id] = { id, verification: 'untested',
          guard: { groupId: `pmdg737.efis.${side}.${kind}`, cooldownMs: 450, retry: 'never' },
          routes: [{ id: `pmdg737.${id}`, transport: 'sdk', adapter: 'clientdata-manifest',
            command: `#${eventId}`, value: raw,
            readback: { fieldId: `efis.${side}.${field}`, expectedValue: value, timeoutMs: 2500 } }],
        };
      }
    }
  }
  return actions;
}
