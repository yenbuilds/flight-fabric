import type { AircraftIntegrationAction, AircraftIntegrationActionCondition, AircraftIntegrationField } from '../types.js';

// Native target trial and generic-event failure: AIRCRAFT-ONBOARDING-SESSION-2026-10-02.md.
// A native write echo alone cannot confirm a target: require the independently
// updated autopilot target as well. Acceptance remains variant-specific.
export const nativeFcuFields: Record<string, AircraftIntegrationField> = {};
export const nativeFcuActions: Record<string, AircraftIntegrationAction> = {};
function field(id: string, name: string, boolean = false) {
  nativeFcuFields[id] = { id, sources: [{ route: { type: 'lvar', name: `L:${name}`, unit: 'Number' },
    decode: boolean ? { type: 'boolean', trueValues: [1], falseValues: [0] } : { type: 'number', precision: 0 } }] };
}
for (const [id, name] of [
  ['speedManaged', 'INI_managed_speed'], ['speedDashed', 'INI_FCU_SPD_DASHED'],
  ['headingManaged', 'INI_FCU_HDG_DOT'], ['headingDashed', 'INI_FCU_HDG_DASHED'],
  ['trackFpa', 'INI_TRACK_FPA_STATE'], ['verticalSpeedDashed', 'INI_FCU_VS_DASHED'],
]) field(`fcu.${id}`, name, true);
nativeFcuFields['systems.mainBusVoltage'] = { id: 'systems.mainBusVoltage', sources: [{
  route: { type: 'lvar', name: 'A:ELECTRICAL MAIN BUS VOLTAGE', unit: 'Volts' }, decode: { type: 'number' },
}] };
const condition = (id: string): AircraftIntegrationActionCondition => ({ fieldId: `fcu.${id}`, expectedValue: false, freshness: 'field' });
for (const [name, id, variable, min, max, step] of [
  ['speed', 'speedKts', 'INI_Airspeed_Dial', 100, 399, 1],
  ['heading', 'headingDeg', 'INI_HEADING_DIAL', 0, 359, 1],
  ['altitude', 'altitudeFt', 'INI_Altitude_Dial', 100, 49000, 100],
  ['verticalSpeed', 'verticalSpeedFpm', 'INI_vvi_dial', -6000, 6000, 100],
] as const) {
  const nativeId = `fcu.${id}Native`, fieldId = `fcu.${id}`, actionId = `flightGuidance.${name}.set`;
  field(nativeId, variable);
  const requires: AircraftIntegrationActionCondition[] = [{ fieldId: 'systems.mainBusVoltage', min: 20, max: 40, freshness: 'field' }];
  if (name === 'speed') requires.push(condition('speedManaged'), condition('speedDashed'), { fieldId: nativeId, min: 100, max: 399, freshness: 'field' });
  if (name === 'heading') requires.push(condition('headingManaged'), condition('headingDashed'), condition('trackFpa'));
  if (name === 'verticalSpeed') requires.push(condition('verticalSpeedDashed'), condition('trackFpa'));
  nativeFcuActions[actionId] = { id: actionId, input: { type: 'number', min, max, step },
    guard: { groupId: `microsoftIniBuildsA32x.flightGuidance.${name}`, cooldownMs: 300, retry: 'never', requires },
    routes: [{ id: `microsoftIniBuildsA32x.${name}.nativeTarget`, transport: 'simconnect-sequence',
      operations: [{ type: 'lvar', name: `L:${variable}`, unit: 'Number', inputValue: { source: 'input' } }],
      readbacks: [nativeId, fieldId].map(fieldId => ({ fieldId, expectedInput: true, timeoutMs: 3000, freshness: 'field' })),
    }], verification: 'partial' };
}
