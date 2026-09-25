import type { AircraftIntegrationAction, AircraftIntegrationField } from '../types.js';

// Installed A350 1.2.6 cockpit behavior and HubHop use MAP_RANGE;
// the older vendor PDF says MAP_MODE_RANGE. Both sides passed parked readback
// checks on the -900; see docs/A350-PROFILE-VALIDATION.md for scope and limits.
// The selector has twelve positions. Only the seven normal
// navigation detents are exposed; airport zoom and mode-dependent scale are not.
const ranges = ['10', '20', '40', '80', '160', '320', '640'];
const sides = ['captain', 'firstOfficer'] as const;
const lvar = (side: string) => `L:INI_MAP_RANGE_${side === 'captain' ? 'CAPT' : 'FO'}_SWITCH`;
export function a350NdRangeFields(): Record<string, AircraftIntegrationField> {
  return Object.fromEntries(sides.map((side) => {
    const id = `navigation.${side}.range`;
    return [id, { id, sources: [{ route: { type: 'lvar', name: lvar(side), unit: 'Number' },
      decode: { type: 'enum', values: { 0: 'zoom', 1: 'zoom', 2: 'zoom', 3: 'zoom', 4: 'zoom',
        ...Object.fromEntries(ranges.map((nm, raw) => [raw + 5, nm])) } } }] }];
  }));
}
export function a350NdRangeActions(): Record<string, AircraftIntegrationAction> {
  return Object.fromEntries(sides.flatMap((side) => ranges.map((nm, index) => {
    const fieldId = `navigation.${side}.range`, id = `${fieldId}.nm${nm}`;
    return [id, { id, verification: 'untested',
      guard: { groupId: `iniA350.${fieldId}`, cooldownMs: 450, retry: 'never' },
      routes: [{ id: `iniA350.${id}`, transport: 'simconnect-sequence',
        operations: [{ type: 'lvar', name: lvar(side), unit: 'Number', value: index + 5 }],
        readback: { fieldId, expectedValue: nm, timeoutMs: 2500, freshness: 'field' } }],
    } as AircraftIntegrationAction];
  })));
}
