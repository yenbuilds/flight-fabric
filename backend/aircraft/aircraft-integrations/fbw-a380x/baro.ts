import type { AircraftIntegrationAction, AircraftIntegrationField } from '../types.js';
import { baroLetter, baroSides } from '../fbw-a32nx/baro.js';

// A380X Flight Deck API and vendor FlyByWireInterface::updateEfisSync:
// PUSH selects STD; PULL returns to local pressure. The A320 is the reverse.
// CP_ACTIVE and DISPLAY_BARO_IS_STD belong to each independent EFIS panel.
export function a380BaroFields(): Record<string, AircraftIntegrationField> {
  return Object.fromEntries((['captain', 'firstOfficer'] as const).flatMap(side =>
    ([['active', 'CP_ACTIVE'], ['std', 'DISPLAY_BARO_IS_STD']] as const).map(([property, suffix]) => {
      const id = `baro.${side}.${property}`;
      return [id, { id, sources: [{
        route: { type: 'lvar', name: `L:A32NX_FCU_EFIS_${baroLetter(side)}_${suffix}`, unit: 'Number' },
        decode: { type: 'boolean', trueValues: [1], falseValues: [0] },
      }] } as AircraftIntegrationField];
    })));
}

export function a380BaroActions(): Record<string, AircraftIntegrationAction> {
  return Object.fromEntries((['captain', 'firstOfficer', 'both'] as const).map(target => {
    const id = `baro.${target}.std`;
    return [id, { id, verification: 'untested',
      guard: { groupId: 'fbwA380x.baro', cooldownMs: 750, retry: 'never' },
      routes: [{ id: `fbwA380x.${id}`, transport: 'simconnect-sequence', baro: { target, operation: 'std' },
        operations: baroSides(target).map(side => ({ type: 'event', name: `A32NX.FCU_EFIS_${baroLetter(side)}_BARO_PUSH`, value: 0 })),
        readbacks: baroSides(target).flatMap(side => ['active', 'std'].map(property => ({
          fieldId: `baro.${side}.${property}`, expectedValue: true, timeoutMs: 2500, freshness: 'field',
        }))),
      }],
    } as AircraftIntegrationAction];
  }));
}
