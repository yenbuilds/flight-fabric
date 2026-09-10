import type { AircraftIntegrationAction, AircraftIntegrationField } from '../types.js';

const modes = ['off', 'low', 'medium', 'max'] as const;
const buttons = [['low', 'LO'], ['medium', 'MED'], ['max', 'MAX']] as const;
const guard = (control: string) => ({ groupId: `fenixA32x.controls.${control}`, cooldownMs: 750, retry: 'never' as const });
const buttonField = (mode: string) => `controls.autobrake.${mode}`;

export function fenixApproachFields(): Record<string, AircraftIntegrationField> {
  return {
    'controls.speedbrakePosition': { id: 'controls.speedbrakePosition', sources: [{
      route: { type: 'lvar', name: 'L:A_FC_SPEEDBRAKE', unit: 'Number' },
      decode: { type: 'number', precision: 3 },
    }] },
    ...Object.fromEntries(buttons.map(([mode, name]) => [buttonField(mode), {
      id: buttonField(mode), sources: [{
        route: { type: 'lvar', name: `L:I_MIP_AUTOBRAKE_${name}_L`, unit: 'Number' },
        decode: { type: 'boolean', trueValues: [1], falseValues: [0] },
      }],
    }])),
  };
}

export function fenixApproachActions(): Record<string, AircraftIntegrationAction> {
  const actions: Record<string, AircraftIntegrationAction> = {};
  for (const [control, fieldId, lvar, positions] of [
    ['flaps', 'controls.flapsHandle', 'S_FC_FLAPS', [['up', 0, 'up'], ['one', 1, '1'], ['two', 2, '2'], ['three', 3, '3'], ['full', 4, 'full']]],
    // Zero is ARMED, one is RETRACTED. Never treat zero as retract.
    ['speedbrake', 'controls.speedbrakePosition', 'A_FC_SPEEDBRAKE', [['armed', 0, 0], ['retracted', 1, 1], ['half', 2, 2], ['full', 3, 3]]],
  ] as const) {
    for (const [suffix, raw, expectedValue] of positions) {
      const id = `controls.${control}.${suffix}`;
      actions[id] = { id, guard: guard(control), verification: 'untested', routes: [{
        id: `fenixA32x.${id}`, transport: 'simconnect-sequence',
        operations: [{ type: 'lvar', name: `L:${lvar}`, unit: 'Number', value: raw }],
        readback: { fieldId, expectedValue, timeoutMs: 2500, freshness: 'field' },
      }] };
    }
  }
  for (const target of modes) {
    const id = `controls.autobrake.${target}`;
    actions[id] = { id, guard: guard('autobrake'), verification: 'untested', routes: [{
      id: `fenixA32x.${id}`, transport: 'mobiflight-calculator', mode: 'pulse', delayMs: 100,
      precondition: { fieldId: 'baro.healthy', expectedValue: true, freshness: 'field' },
      // Dark lamps do not establish OFF without power. Include power in the
      // confirmations so neither the no-op path nor a power loss can report success.
      readbacks: [
        { fieldId: 'baro.healthy', expectedValue: true, timeoutMs: 2500, freshness: 'field' },
        ...buttons.map(([mode]) => ({ fieldId: buttonField(mode), expectedValue: mode === target,
          timeoutMs: 2500, freshness: 'field' as const })),
      ],
      // OFF presses the selected mode once. Retain that button's release even
      // if the annunciators change during the pulse. Reject inconsistent lamps.
      pulses: modes.filter((current) => current !== target).map((current) => {
        const suffix = buttons.find(([mode]) => mode === (target === 'off' ? current : target))![1];
        const code = `(L:S_MIP_AUTOBRAKE_${suffix}, Number) ++ (>L:S_MIP_AUTOBRAKE_${suffix}, Number)`;
        return { when: buttons.map(([mode]) => ({ fieldId: buttonField(mode), expectedValue: mode === current,
          freshness: 'field' as const })), pressCode: code, releaseCode: code };
      }),
    }] };
  }
  return actions;
}
