import type { AircraftIntegrationAction } from '../types.js';

export const MINIMUMS_INPUTS = {
  baro: { type: 'number', min: 0, max: 39000, step: 1 },
  radio: { type: 'number', min: 0, max: 5000, step: 1 },
} as const;

export function minimumsActions(): Record<string, AircraftIntegrationAction> {
  return Object.fromEntries((['baro', 'radio'] as const).map((target) => {
    const id = `approach.minimums.${target}`;
    return [id, { id, input: MINIMUMS_INPUTS[target], verification: 'untested',
      guard: { groupId: 'fbwA32nx.approach.minimums', cooldownMs: 1000, retry: 'never' },
      routes: [{ id: `fbwA32nx.${id}`, transport: 'simbridge-mcdu', target }],
    } as AircraftIntegrationAction];
  }));
}
