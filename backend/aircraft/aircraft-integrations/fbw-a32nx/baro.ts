import type { AircraftIntegrationAction, AircraftIntegrationField, SimConnectSequenceOperation } from '../types.js';

export type BaroTarget = 'captain' | 'firstOfficer' | 'both';
export type BaroOperation = 'qnhHpa' | 'qnhInHg' | 'std';
const BARO_SIDES = ['captain', 'firstOfficer'] as const;
export const baroSides = (target: BaroTarget) => target === 'both' ? [...BARO_SIDES] : [target];
export const baroField = (side: string, property: string) => property === 'unitInHg'
  ? `flightGuidance.baroUnit${side === 'captain' ? 'Captain' : 'FirstOfficer'}` : `baro.${side}.${property}`;
export const baroLetter = (side: string) => side === 'captain' ? 'L' : 'R';
export const BARO_INPUTS = {
  qnhHpa: { type: 'number', min: 948, max: 1084, step: 1 },
  qnhInHg: { type: 'number', min: 27.99, max: 32.01, step: 0.01 },
} as const;
export const BARO_HPA_PER_INHG = 33.863886666667;

export function baroFields(): Record<string, AircraftIntegrationField> {
  const field = (id: string, name: string, boolean = false): [string, AircraftIntegrationField] => [id, {
    id, sources: [{ route: { type: 'lvar', name: `L:${name}`, unit: 'Number' }, decode: boolean
      ? { type: 'boolean', trueValues: [1], falseValues: [0] } : { type: 'number', precision: 2 } }],
  }];
  return Object.fromEntries([field('baro.healthy', 'A32NX_FCU_HEALTHY', true), ...BARO_SIDES.flatMap((side) => [
    field(baroField(side, 'mode'), `A32NX_FCU_EFIS_${baroLetter(side)}_DISPLAY_BARO_MODE`),
    field(baroField(side, 'valueMode'), `A32NX_FCU_EFIS_${baroLetter(side)}_DISPLAY_BARO_VALUE_MODE`),
    field(baroField(side, 'value'), `A32NX_FCU_EFIS_${baroLetter(side)}_DISPLAY_BARO_VALUE`),
  ])]);
}

// This manifest enumerates every allowed write. The confirmed executor selects
// the necessary mode/unit writes from fresh observations; it never blindly pushes.
function baroOperations(target: BaroTarget, operation: BaroOperation): SimConnectSequenceOperation[] {
  return baroSides(target).flatMap((side): SimConnectSequenceOperation[] => {
    const event = `A32NX.FCU_EFIS_${baroLetter(side)}_BARO_`;
    if (operation === 'std') return [{ type: 'event', name: `${event}PULL`, value: 0 }];
    return [
      { type: 'lvar', name: `L:A32NX_FCU_EFIS_${baroLetter(side)}_BARO_IS_INHG`, unit: 'Number', value: operation === 'qnhInHg' ? 1 : 0 },
      { type: 'event', name: `${event}PUSH`, value: 0 },
      { type: 'event', name: `${event}SET`, inputValue: { source: 'input', scale: 16 * (operation === 'qnhInHg' ? BARO_HPA_PER_INHG : 1), round: 'nearest' } },
    ];
  });
}

export function baroActions(): Record<string, AircraftIntegrationAction> {
  return Object.fromEntries((['captain', 'firstOfficer', 'both'] as const).flatMap((target) =>
    (['qnhHpa', 'qnhInHg', 'std'] as const).map((operation) => {
      const id = `baro.${target}.${operation}`;
      return [id, { id, guard: { groupId: 'fbwA32nx.baro', cooldownMs: 750, retry: 'never' },
        ...(operation === 'std' ? {} : { input: BARO_INPUTS[operation] }),
        routes: [{ id: `fbwA32nx.${id}`, transport: 'simconnect-sequence', baro: { target, operation },
          operations: baroOperations(target, operation),
          readbacks: [{ fieldId: 'baro.healthy', expectedValue: true, timeoutMs: 2500 }, ...baroSides(target).flatMap((side) => [
            { fieldId: baroField(side, 'mode'), expectedValue: operation === 'std' ? 0 : 1, timeoutMs: 2500 },
            { fieldId: baroField(side, 'valueMode'), expectedValue: operation === 'std' ? 0 : operation === 'qnhHpa' ? 1 : 2, timeoutMs: 2500 },
            ...(operation === 'std' ? [] : [
              { fieldId: baroField(side, 'unitInHg'), expectedValue: operation === 'qnhInHg', timeoutMs: 2500 },
              { fieldId: baroField(side, 'value'), expectedInput: true as const, timeoutMs: 2500 },
            ]),
          ])],
        }], verification: 'untested' } as AircraftIntegrationAction];
    })));
}
