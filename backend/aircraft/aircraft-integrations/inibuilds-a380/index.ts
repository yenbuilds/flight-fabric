import type { AircraftIntegrationAction, AircraftIntegrationDefinition, AircraftIntegrationField } from '../types.js';
import { comRadioActions, comRadioFields } from '../com-radio.js';
import { fcuActions, fcuFields } from './fcu.js';

const { defineAircraftIntegration } = require('../registry') as {
  defineAircraftIntegration: (definition: AircraftIntegrationDefinition) => AircraftIntegrationDefinition;
};

export const INIBUILDS_A380_ADAPTER_ID = 'inibuilds-a380';
export const INIBUILDS_A380_PROFILE_KEY = 'bundled/msfs/inibuilds-a380-800-rr';

// A380 package 1.0.0, loaded vendor behavior + two independent cockpit cycles.
// These detents are the reverse of the A350 mappings. Do not share its adapter.
// Exact source, hashes and live observations: docs/aircraft-intake/inibuilds-a380-behavior.evidence.json.
const selectors = [
  ['beacon', 'beacon', 'BEACON', 'INI_LIGHTS_BEACON', { 0: true, 1: false }],
  ['nav', 'nav', 'NAV', 'INI_LIGHTS_NAV', { 0: true, 1: false }],
  ['landing', 'landing', 'LANDING', 'INI_LIGHTS_LANDING', { 0: true, 1: false }],
  ['wing', 'wing', 'WING', 'INI_LIGHTS_WING', { 0: true, 1: false }],
  ['runwayTurnoff', 'runwayTurnoff', 'TURNOFF', 'INI_TURNOFF_LIGHT_SWITCH', { 0: true, 1: false }],
  ['strobe', 'strobeMode', 'STROBE', 'INI_LIGHTS_STROBE', { 0: 'on', 1: 'auto', 2: 'off' }],
  ['logo', 'logoMode', 'LOGO', 'INI_LIGHTS_LOGO', { 0: 'on', 1: 'auto', 2: 'off' }],
  ['nose', 'noseMode', 'NOSE', 'INI_LIGHTS_NOSE', { 0: 'takeoff', 1: 'taxi', 2: 'off' }],
] as const;

const fields: Record<string, AircraftIntegrationField> = { ...fcuFields };
const actions: Record<string, AircraftIntegrationAction> = { ...fcuActions };

// Standard COM1/2 events agree with both RMP displays and independent INI_VHF
// state on package 1.0.0. Keep the shared fresh-data/spacing/one-swap transaction.
// Evidence: docs/aircraft-intake/inibuilds-a380-radios.evidence.json.
Object.assign(fields, comRadioFields());
for (const [id, action] of Object.entries(comRadioActions('iniA380'))) {
  actions[id] = { ...action, verification: 'verified' };
}

// Lever selections, independently checked against the pedestal and powered
// surfaces. These readbacks do not imply completed travel or landing deployment.
// Source and live evidence: inibuilds-a380-surfaces.evidence.json.
fields['controls.flaps'] = { id: 'controls.flaps', sources: [{
  route: { type: 'simvar', name: 'FLAPS HANDLE INDEX', unit: 'Number' },
  decode: { type: 'enum', values: { 0: 'up', 1: '1', 2: '2', 3: '3', 4: 'full' } },
}] };
for (const [suffix, expectedValue, value] of [
  ['up', 'up', 0], ['one', '1', 4096], ['two', '2', 8192],
  ['three', '3', 12288], ['full', 'full', 16384],
] as const) {
  const id = `controls.flaps.${suffix}`;
  actions[id] = { id, guard: { groupId: 'controls.flaps', cooldownMs: 300, retry: 'never' },
    routes: [{ id: `iniA380.${id}.native`, transport: 'input-event', inputEvent: 'AIRLINER_FLAPS', value,
      readback: { fieldId: 'controls.flaps', expectedValue, timeoutMs: 3000, freshness: 'field' } }],
    verification: 'verified' };
}
fields['controls.speedbrake'] = { id: 'controls.speedbrake', sources: [{
  route: { type: 'lvar', name: 'L:INI_SPOILERS_HANDLE_POSITION', unit: 'Number' },
  decode: { type: 'enum', values: { 0: 'retracted', 0.5: 'half', 1: 'full' } },
}] };
fields['controls.spoilersArmed'] = { id: 'controls.spoilersArmed', sources: [{
  route: { type: 'lvar', name: 'L:INI_SPOILERS_ARMED', unit: 'Number' },
  decode: { type: 'boolean', trueValues: [1], falseValues: [0] },
}] };
// AIRLINER_PED_SPOILERS only changes animation. Use the custom events actually
// dispatched by the installed mouse behavior, with vendor state confirmation.
for (const [suffix, expectedValue, value] of [
  ['stowed', 'retracted', 0], ['half', 'half', 8192], ['full', 'full', 16384],
] as const) {
  const id = `controls.speedbrake.${suffix}`;
  actions[id] = { id, guard: { groupId: 'controls.speedbrake', cooldownMs: 300, retry: 'never' },
    routes: [{ id: `iniA380.${id}.event`, transport: 'simconnect-sequence',
      operations: [{ type: 'event', name: 'INI.SPOILERS_SET', value }],
      readback: { fieldId: 'controls.speedbrake', expectedValue, timeoutMs: 3000, freshness: 'field' } }],
    verification: 'verified' };
}
for (const [suffix, expectedValue] of [['on', true], ['off', false]] as const) {
  const id = `controls.spoilersArmed.${suffix}`;
  actions[id] = { id, guard: { groupId: 'controls.speedbrake', cooldownMs: 300, retry: 'never' },
    routes: [{ id: `iniA380.${id}.event`, transport: 'simconnect-sequence',
      operations: [{ type: 'event', name: `INI.SPOILERS_ARM_${suffix.toUpperCase()}`, value: 0 }],
      readback: { fieldId: 'controls.spoilersArmed', expectedValue, timeoutMs: 3000, freshness: 'field' } }],
    verification: 'verified' };
}

// The generic FLIGHT DIRECTOR ACTIVE SimVar stayed true with the cockpit FD off.
// Loaded behavior and two cockpit cycles establish this independent state.
fields['flightGuidance.flightDirector'] = {
  id: 'flightGuidance.flightDirector', sources: [{
    route: { type: 'lvar', name: 'L:INI_FD_ON', unit: 'Number' },
    decode: { type: 'boolean', trueValues: [1], falseValues: [0] },
  }],
};
for (const [suffix, expectedValue] of [['on', true], ['off', false]] as const) {
  const id = `flightGuidance.flightDirector.${suffix}`;
  actions[id] = { id, guard: { groupId: 'flightGuidance.flightDirector', cooldownMs: 300, retry: 'never' },
    routes: [{ id: `iniA380.${id}.native`, transport: 'input-event', inputEvent: 'AIRLINER_FCU_FD', value: 1,
      readback: { fieldId: 'flightGuidance.flightDirector', expectedValue, timeoutMs: 3000, freshness: 'field' } }],
    verification: 'verified' };
}

for (const [prefix, field, event, variable, positions] of selectors) {
  const fieldId = `lights.${field}`;
  fields[fieldId] = { id: fieldId, sources: [{
    route: { type: 'lvar', name: `L:${variable}`, unit: 'Number' },
    decode: { type: 'enum', values: positions },
  }] };
  for (const [raw, logical] of Object.entries(positions)) {
    const suffix = typeof logical === 'boolean' ? logical ? 'on' : 'off' : logical;
    const id = `lights.${prefix}.${suffix}`;
    actions[id] = {
      id, guard: { groupId: `lights.${prefix}`, cooldownMs: 300, retry: 'never' },
      routes: [{ id: `iniA380.${id}.native`, transport: 'input-event',
        inputEvent: `AIRLINER_LIGHTS_EXT_${event}`, value: Number(raw),
        readback: { fieldId, expectedValue: logical, timeoutMs: 3000, freshness: 'field' } }],
      verification: 'verified',
    };
  }
}

// Observed cockpit detents and repeated native writes; see cabin evidence.
for (const [prefix, event, variable, positions] of [
  ['seatBelts', 'SEAT_BELTS', 'INI_SEATBELTS_SWITCH', { 0: 'on', 1: 'auto', 2: 'off' }],
  ['noMobile', 'NO_MOBILE', 'INI_SIGNS_NO_MOBILE', { 0: 'on', 1: 'auto', 2: 'off' }],
  ['emergencyExit', 'EMER_EXIT', 'INI_EMER_EXIT_SWITCH', { 0: 'on', 1: 'arm', 2: 'off' }],
] as const) {
  const fieldId = `cabin.${prefix}Mode`;
  fields[fieldId] = { id: fieldId, sources: [{
    route: { type: 'lvar', name: `L:${variable}`, unit: 'Number' },
    decode: { type: 'enum', values: positions },
  }] };
  for (const [raw, logical] of Object.entries(positions)) {
    const id = `cabin.${prefix}.${logical}`;
    actions[id] = { id, guard: { groupId: `cabin.${prefix}`, cooldownMs: 300, retry: 'never' },
      routes: [{ id: `iniA380.${id}.native`, transport: 'input-event',
        inputEvent: `AIRLINER_SIGNS_${event}`, value: Number(raw),
        readback: { fieldId, expectedValue: logical, timeoutMs: 3000, freshness: 'field' } }],
      verification: 'verified' };
  }
}

// Air-system button selections. These are not valve position or supplied airflow.
// Every Set callback toggles; fixed intents require fresh same-state no-op handling.
for (const [prefix, event, variable] of [
  ['apuBleed', 'APU_BLEED', 'INI_AIR_BLEED_APU'],
  ['engineBleed1', 'BLEED_ENG_1', 'INI_AIR_BLEED_ENG1'],
  ['engineBleed2', 'BLEED_ENG_2', 'INI_AIR_BLEED_ENG2'],
  ['engineBleed3', 'BLEED_ENG_3', 'INI_AIR_BLEED_ENG3'],
  ['engineBleed4', 'BLEED_ENG_4', 'INI_AIR_BLEED_ENG4'],
  ['pack1', 'PACK_1', 'INI_AIR_PACK1_BUTTON'],
  ['pack2', 'PACK_2', 'INI_AIR_PACK2_BUTTON'],
] as const) {
  const fieldId = `systems.${prefix}Mode`;
  fields[fieldId] = { id: fieldId, sources: [{
    route: { type: 'lvar', name: `L:${variable}`, unit: 'Number' },
    decode: { type: 'enum', values: { 0: 'off', 1: 'on' } },
  }] };
  for (const expectedValue of ['off', 'on']) {
    const id = `systems.${prefix}.${expectedValue}`;
    actions[id] = { id, guard: { groupId: `systems.${prefix}`, cooldownMs: 300, retry: 'never' },
      routes: [{ id: `iniA380.${id}.native`, transport: 'input-event',
        inputEvent: `AIRLINER_AIR_${event}`, value: 1,
        readback: { fieldId, expectedValue, timeoutMs: 3000, freshness: 'field' } }],
      verification: 'verified' };
  }
}

// System state, not the auto-resetting *_CMD variables or animation positions.
for (const [fieldId, variable] of [
  ['systems.apuMaster', 'INI_APU_MASTER_SWITCH'],
  ['systems.apuStart', 'INI_APU_START_BUTTON'],
  ['systems.apuAvailable', 'INI_APU_AVAILABLE'],
  ['systems.apuMasterFault', 'INI_APU_MASTER_FAULT'],
] as const) {
  fields[fieldId] = { id: fieldId, sources: [{
    route: { type: 'lvar', name: `L:${variable}`, unit: 'Number' },
    decode: { type: 'boolean', trueValues: [1], falseValues: [0] },
  }] };
}

// Both master intents press the same aircraft button. Fresh same-state no-op
// handling is mandatory: repeating ON must not switch it OFF.
for (const [suffix, expectedValue] of [['on', true], ['off', false]] as const) {
  const id = `systems.apuMaster.${suffix}`;
  actions[id] = { id, guard: { groupId: 'systems.apuMaster', cooldownMs: 500, retry: 'never' },
    routes: [{ id: `iniA380.${id}.native`, transport: 'input-event',
      inputEvent: 'AIRLINER_APU_MASTER_SWITCH', value: 1,
      readback: { fieldId: 'systems.apuMaster', expectedValue, timeoutMs: 3000, freshness: 'field' } }],
    verification: 'partial' };
}
actions['systems.apuStart.start'] = {
  id: 'systems.apuStart.start', guard: { groupId: 'systems.apuStart', cooldownMs: 500, retry: 'never' },
  routes: [{ id: 'iniA380.apuStart.native', transport: 'input-event', inputEvent: 'AIRLINER_APU_START', value: 1,
    precondition: { fieldId: 'systems.apuMaster', expectedValue: true, freshness: 'field' },
    readback: { fieldId: 'systems.apuStart', expectedValue: true, timeoutMs: 3000, freshness: 'field' } }],
  verification: 'partial',
};

export const INIBUILDS_A380_INTEGRATION = defineAircraftIntegration({
  id: INIBUILDS_A380_ADAPTER_ID,
  aircraft: { vendor: 'iniBuilds', family: 'A380-800 RR' },
  trustedProfileKeys: [INIBUILDS_A380_PROFILE_KEY],
  presentation: { templateId: INIBUILDS_A380_ADAPTER_ID },
  fields, actions,
});
