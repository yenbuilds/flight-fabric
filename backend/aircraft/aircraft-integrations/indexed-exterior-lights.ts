import type { AircraftIntegrationAction, AircraftIntegrationField } from './types';

/** Explicit indices from each installed aircraft's cockpit XML and systems.cfg. */
export function indexedExteriorLights(adapterId: 'fbw-a380x' | 'headwind-a330') {
  const fields: Record<string, AircraftIntegrationField> = {};
  const actions: Record<string, AircraftIntegrationAction> = {};
  const guardPrefix = adapterId === 'fbw-a380x' ? 'fbwA380x' : 'headwindA330';
  // A380's wing landing lamps share index 2. Headwind has separate 2/3 lamps.
  // Both use taxi index 1 for the nose and taxi indices 2/3 for runway turnoffs.
  const groups = [
    ['landing', 'LANDING', adapterId === 'fbw-a380x' ? [2] : [2, 3]],
    ['taxi', 'TAXI', [1]], ['runwayTurnoff', 'TAXI', [2, 3]],
  ] as const;
  for (const [group, type, indices] of groups) {
    for (const index of indices) {
      const id = `lights.individual.${group}${index}`;
      fields[id] = { id, sources: [{ route: { type: 'lvar', name: `A:LIGHT ${type}:${index}`, unit: 'Bool' },
        decode: { type: 'boolean', trueValues: [1, true], falseValues: [0, false] } }] };
    }
    for (const value of [false, true]) {
      const id = `lights.individual.${group}.${value ? 'on' : 'off'}`;
      const readbacks = indices.map(index => ({ fieldId: `lights.individual.${group}${index}`,
        expectedValue: value, timeoutMs: 3000, freshness: 'field' as const }));
      actions[id] = { id, guard: { groupId: `${guardPrefix}.lights.${group}`, cooldownMs: 300, retry: 'never' },
        routes: [{ id: `${adapterId}.${id}`, transport: 'simconnect-sequence',
          operations: indices.map(index => ({ type: 'event' as const, name: `${type}_LIGHTS_SET`, value: value ? 1 : 0,
            parameters: [index] })),
          ...(readbacks.length === 1 ? { readback: readbacks[0] } : { readbacks }),
        }], verification: 'untested' };
    }
  }
  return { fields, actions };
}
