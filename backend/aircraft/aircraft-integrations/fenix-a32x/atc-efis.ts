import type { AircraftIntegrationAction, AircraftIntegrationDecoder, AircraftIntegrationField } from '../types.js';
import { confirmedSquawkAction } from '../transponder.js';

const ranges = ['10', '20', '40', '80', '160', '320'];
const sides = ['captain', 'firstOfficer'] as const;
const bool: AircraftIntegrationDecoder = { type: 'boolean', trueValues: [1], falseValues: [0] };
const field = (id: string, name: string, decode: AircraftIntegrationDecoder): AircraftIntegrationField => ({
  id, sources: [{ route: { type: 'lvar', name: `L:${name}`, unit: 'Number' }, decode }],
});

export function fenixAtcEfisFields(): Record<string, AircraftIntegrationField> {
  return {
    'surveillance.powered': field('surveillance.powered', 'B_PED_XPDR', bool),
    'surveillance.squawk': field('surveillance.squawk', 'N_FREQ_XPDR_SELECTED', { type: 'number', precision: 0 }),
    'surveillance.transmitting': { id: 'surveillance.transmitting', sources: [{
      route: { type: 'lvar', name: 'A:TRANSPONDER STATE:1', unit: 'Number' },
      decode: { type: 'boolean', trueValues: [3, 4, 5], falseValues: [0, 1, 2] },
    }] },
    'controls.flapsHandle': field('controls.flapsHandle', 'S_FC_FLAPS',
      { type: 'enum', values: { 0: 'up', 1: '1', 2: '2', 3: '3', 4: 'full' } }),
    ...Object.fromEntries(sides.flatMap((side, index) => [
      [`navigation.${side}.range`, field(`navigation.${side}.range`, `S_FCU_EFIS${index + 1}_ND_ZOOM`,
        { type: 'enum', values: Object.fromEntries(ranges.map((nm, raw) => [raw, nm])) })],
      [`navigation.${side}.ls`, field(`navigation.${side}.ls`, `I_FCU_EFIS${index + 1}_LS`, bool)],
    ])),
  };
}

export function fenixAtcEfisActions(): Record<string, AircraftIntegrationAction> {
  const actions: Record<string, AircraftIntegrationAction> = {};
  const guard = (id: string) => ({ groupId: `fenixA32x.${id}`, cooldownMs: 750, retry: 'never' as const });
  for (const [index, side] of sides.entries()) {
    for (const [raw, nm] of ranges.entries()) {
      const fieldId = `navigation.${side}.range`, id = `${fieldId}.nm${nm}`;
      actions[id] = { id, guard: guard(fieldId), verification: 'untested', routes: [{
        id: `fenixA32x.${id}`, transport: 'simconnect-sequence',
        operations: [{ type: 'lvar', name: `L:S_FCU_EFIS${index + 1}_ND_ZOOM`, unit: 'Number', value: raw }],
        readback: { fieldId, expectedValue: nm, timeoutMs: 2500, freshness: 'field' },
      }] };
    }
    for (const on of [false, true]) {
      const fieldId = `navigation.${side}.ls`, id = `${fieldId}.${on ? 'on' : 'off'}`;
      const name = `S_FCU_EFIS${index + 1}_LS`;
      const code = `(L:${name}, Number) ++ (>L:${name}, Number)`;
      actions[id] = { id, guard: guard(fieldId), verification: 'untested', routes: [{
        id: `fenixA32x.${id}`, transport: 'mobiflight-calculator', mode: 'pulse',
        pressCode: code, releaseCode: code, delayMs: 100,
        readback: { fieldId, expectedValue: on, timeoutMs: 2500, freshness: 'field' },
      }] };
    }
  }
  actions['surveillance.ident.activate'] = {
    id: 'surveillance.ident.activate', guard: guard('surveillance.ident'), verification: 'untested', routes: [{
      id: 'fenixA32x.surveillance.ident.activate', transport: 'mobiflight-calculator', mode: 'pulse',
      precondition: { fieldId: 'surveillance.transmitting', expectedValue: true, freshness: 'field' },
      pressCode: '(L:S_XPDR_IDENT, Number) ++ (>L:S_XPDR_IDENT, Number)',
      releaseCode: '(L:S_XPDR_IDENT, Number) ++ (>L:S_XPDR_IDENT, Number)', delayMs: 100,
      confirmation: 'transport-acknowledged',
    }],
  };
  actions['surveillance.squawk.set'] = confirmedSquawkAction('fenixA32x');
  return actions;
}
