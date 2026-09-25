import type { AircraftIntegrationAction, AircraftIntegrationActionCondition, AircraftIntegrationField } from '../types.js';

// Exact RR Basic 1.0.0 observations, not an inherited A350 write contract.
// Both the vendor target AND its independently updated autopilot SimVar must
// confirm. A write echoed by the same LVAR alone cannot establish acceptance.
// Ground selector evidence: docs/aircraft-intake/inibuilds-a380-fcu.evidence.json.
export const fcuFields: Record<string, AircraftIntegrationField> = {};
export const fcuActions: Record<string, AircraftIntegrationAction> = {};
const field = (id: string, type: 'lvar' | 'simvar', name: string, unit: string, boolean = false) => {
  fcuFields[id] = { id, sources: [{ route: { type, name, unit },
    decode: boolean ? { type: 'boolean', trueValues: [1], falseValues: [0] } : { type: 'number' } }] };
};
for (const [id, name] of [
  ['powered', 'INI_FCU_POWERED_VAR'], ['trackFpa', 'INI_TRACK_FPA_STATE'],
  ['speedDashed', 'INI_FCU_SPD_DASHED'], ['headingDashed', 'INI_FCU_HDG_DASHED'],
  ['verticalSpeedDashed', 'INI_FCU_VS_DASHED'], ['speedManaged', 'INI_FCU_SPD_DOT'],
  ['headingManaged', 'INI_FCU_HDG_DOT'],
]) field(`flightGuidance.${id}`, 'lvar', `L:${name}`, 'Number', true);

const condition = (name: string, expectedValue: boolean): AircraftIntegrationActionCondition =>
  ({ fieldId: `flightGuidance.${name}`, expectedValue, freshness: 'field' });
const powered = condition('powered', true);
for (const [name, variable, simvar, unit, min, max, step] of [
  ['speed', 'INI_AIRSPEED_DIAL', 'AUTOPILOT AIRSPEED HOLD VAR', 'knots', 100, 350, 1],
  ['heading', 'INI_HEADING_DIAL', 'AUTOPILOT HEADING LOCK DIR', 'degrees', 0, 359, 1],
  ['altitude', 'INI_ALTITUDE_DIAL', 'AUTOPILOT ALTITUDE LOCK VAR', 'feet', 100, 49000, 100],
  ['verticalSpeed', 'INI_VVI_DIAL', 'AUTOPILOT VERTICAL HOLD VAR', 'feet per minute', -6000, 6000, 100],
] as const) {
  const fieldId = `flightGuidance.${name}Value`, confirmedId = `flightGuidance.${name}Confirmed`;
  field(fieldId, 'lvar', `L:${variable}`, 'Number');
  field(confirmedId, 'simvar', simvar, unit);
  const requires: AircraftIntegrationActionCondition[] = [powered];
  if (name === 'speed') requires.push(
    // The two INI_PRESET*_IS_MACH candidates and the generic managed-Mach flag
    // stayed zero in MACH. Require the observed knots domain instead.
    { fieldId, freshness: 'field', min: 100, max: 350 },
    condition('speedDashed', false), condition('speedManaged', false));
  if (name === 'heading') requires.push(condition('trackFpa', false),
    condition('headingDashed', false), condition('headingManaged', false));
  if (name === 'verticalSpeed') requires.push(condition('trackFpa', false), condition('verticalSpeedDashed', false));
  const id = `flightGuidance.${name}.set`;
  fcuActions[id] = { id, input: { type: 'number', min, max, step },
    guard: { groupId: 'flightGuidance.fcu', cooldownMs: 300, retry: 'never', requires },
    routes: [{ id: `iniA380.${name}.target`, transport: 'simconnect-sequence',
      operations: [{ type: 'lvar', name: `L:${variable}`, unit: 'Number', inputValue: { source: 'input' } }],
      readbacks: [fieldId, confirmedId].map(id => ({ fieldId: id, expectedInput: true, timeoutMs: 3000, freshness: 'field' })),
    }], verification: 'partial' };
}

// First touch reveals V/S using the aircraft's own command. It can replace an
// expired preselection; setting a target is a separate intent and never pulls
// the knob or claims V/S engagement. Repeated reveal is an ordinary no-op.
fcuActions['flightGuidance.verticalSpeed.reveal'] = {
  id: 'flightGuidance.verticalSpeed.reveal',
  guard: { groupId: 'flightGuidance.fcu', cooldownMs: 300, retry: 'never',
    requires: [powered, condition('trackFpa', false)] },
  routes: [{ id: 'iniA380.verticalSpeed.reveal', transport: 'input-event',
    inputEvent: 'AIRLINER_FCU_VS_KNOB', value: 1,
    readback: { fieldId: 'flightGuidance.verticalSpeedDashed', expectedValue: false, timeoutMs: 3000, freshness: 'field' } }],
  verification: 'partial',
};
