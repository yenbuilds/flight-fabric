import type { AircraftIntegrationAction, AircraftIntegrationField } from '../types.js';
import { BARO_INPUTS, baroSides, type BaroTarget, type BaroOperation } from '../fbw-a32nx/baro.js';

export const fenixBaroUnitField = (side: string) => `flightGuidance.baroUnit${side === 'captain' ? 'Captain' : 'FirstOfficer'}`;
const fenixBaroNumber = (side: string) => side === 'captain' ? 1 : 2;
export const fenixBaroCounter = (side: string, button: boolean, direction: 1 | -1) => {
  const name = `${button ? 'S' : 'E'}_FCU_EFIS${fenixBaroNumber(side)}_BARO${button ? '_STD' : ''}`;
  return `(L:${name}, Number) ${direction === 1 ? '++' : '--'} (>L:${name}, Number)`;
};
export const fenixBaroUnits = (side: string, inHg: boolean) => `${inHg ? 0 : 1} (>L:S_FCU_EFIS${fenixBaroNumber(side)}_BARO_MODE, Number)`;

export function fenixBaroFields(): Record<string, AircraftIntegrationField> {
  const field = (id: string, name: string, boolean = false): [string, AircraftIntegrationField] => [id, { id,
    sources: [{ route: { type: 'lvar', name: `L:${name}`, unit: 'Number' }, decode: boolean
      ? { type: 'boolean', trueValues: [1], falseValues: [0] } : { type: 'number', precision: 2 } }],
  }];
  return Object.fromEntries([field('baro.healthy', 'B_FCU_POWER', true), ...baroSides('both').flatMap(side => [
    field(`baro.${side}.qnh`, `I_FCU_EFIS${fenixBaroNumber(side)}_QNH`, true),
    field(`baro.${side}.hpa`, `N_FCU_EFIS${fenixBaroNumber(side)}_BARO_HPA`),
    field(`baro.${side}.inhg`, `N_FCU_EFIS${fenixBaroNumber(side)}_BARO_INCH`),
  ])]);
}

/** Exact reviewed recipes: the executor selects only these codes from fresh state. */
export function fenixBaroActions(): Record<string, AircraftIntegrationAction> {
  return Object.fromEntries((['captain', 'firstOfficer', 'both'] as BaroTarget[]).flatMap(target =>
    (['qnhHpa', 'qnhInHg', 'std'] as BaroOperation[]).map(operation => {
      const id = `baro.${target}.${operation}`, inHg = operation === 'qnhInHg';
      return [id, { id, guard: { groupId: 'fenixA32x.baro', cooldownMs: 750, retry: 'never' },
        ...(operation === 'std' ? {} : { input: BARO_INPUTS[operation] }), verification: 'untested', routes: [{
          id: `fenixA32x.${id}`, transport: 'mobiflight-calculator', mode: 'fenix-baro', baro: { target, operation },
          codes: baroSides(target).flatMap(side => operation === 'std' ? [fenixBaroCounter(side, true, 1)]
            : [fenixBaroUnits(side, inHg), fenixBaroCounter(side, true, -1), fenixBaroCounter(side, false, -1), fenixBaroCounter(side, false, 1)]),
          readbacks: [{ fieldId: 'baro.healthy', expectedValue: true, timeoutMs: 2500, freshness: 'field' }, ...baroSides(target).flatMap(side => [
            { fieldId: `baro.${side}.qnh`, expectedValue: operation !== 'std', timeoutMs: 2500, freshness: 'field' as const },
            ...(operation === 'std' ? [] : [
              { fieldId: fenixBaroUnitField(side), expectedValue: inHg ? 'inhg' : 'hpa', timeoutMs: 2500, freshness: 'field' as const },
              { fieldId: `baro.${side}.${inHg ? 'inhg' : 'hpa'}`, expectedInput: true as const, timeoutMs: 2500, freshness: 'field' as const },
            ]),
          ])],
        }] } as AircraftIntegrationAction];
    })));
}
