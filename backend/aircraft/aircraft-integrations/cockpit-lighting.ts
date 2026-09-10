import type { AircraftIntegrationAction, AircraftIntegrationField, SimConnectSequenceOperation } from './types.js';

type Dimmer = readonly [key: string, address: string | number];
type Group = Readonly<{ key: string; label: string; displays?: true; dimmers: readonly Dimmer[] }>;
type Definition = Readonly<{ kind: 'potentiometer' | 'fenix-lvar'; groups: readonly Group[] }>;

// Explicit aircraft contracts, not generic MSFS potentiometer guesses. FBW
// indices come from each aircraft's Flight Deck API. Headwind was separately
// checked against its installed A330_NEO_INTERIOR.xml. Fenix names and 0..1
// bounds come from the shipped Cockpit_Behavior.xml and knob templates.
const airbusPanels: Group = { key: 'panels', label: 'Panel backlighting', dimmers: [
  ['glareshield', 84], ['glareshieldLcd', 87], ['mainAndPedestal', 85], ['overhead', 86],
] };
const airbusFlood: Group = { key: 'flood', label: 'Flood and table lights', dimmers: [
  ['mainFlood', 83], ['pedestalFlood', 76], ['captainTable', 10], ['firstOfficerTable', 11],
] };
const captainDisplays: Group = { key: 'captainDisplays', label: 'Captain displays', displays: true, dimmers: [
  ['captainPfd', 88], ['captainNd', 89], ['captainWeather', 94],
] };
const firstOfficerDisplays: Group = { key: 'firstOfficerDisplays', label: 'First officer displays', displays: true, dimmers: [
  ['firstOfficerPfd', 90], ['firstOfficerNd', 91], ['firstOfficerWeather', 95],
] };
const engineDisplays: Group = { key: 'engineDisplays', label: 'Engine and system displays', displays: true, dimmers: [
  ['upperDisplay', 92], ['lowerDisplay', 93],
] };
const DEFINITIONS: Readonly<Record<string, Definition>> = {
  'fbw-a32nx': { kind: 'potentiometer', groups: [airbusPanels, airbusFlood, captainDisplays, firstOfficerDisplays, engineDisplays] },
  'fbw-a380x': { kind: 'potentiometer', groups: [airbusPanels, airbusFlood,
    { ...captainDisplays, dimmers: [...captainDisplays.dimmers, ['captainMfd', 98]] },
    { ...firstOfficerDisplays, dimmers: [...firstOfficerDisplays.dimmers, ['firstOfficerMfd', 99]] }, engineDisplays,
  ] },
  'headwind-a330': { kind: 'potentiometer', groups: [airbusPanels,
    // Headwind 10/11 are discrete ceiling/map lamps, unlike the FBW table knobs.
    { key: 'flood', label: 'Flood lighting', dimmers: [['mainFlood', 83], ['pedestalFlood', 76]] },
    captainDisplays, firstOfficerDisplays, engineDisplays,
  ] },
  'fenix-a32x': { kind: 'fenix-lvar', groups: [
    { key: 'panels', label: 'Panel backlighting', dimmers: [
      ['fcu', 'A_FCU_LIGHTING'], ['fcuText', 'A_FCU_LIGHTING_TEXT'],
      ['overhead', 'A_OH_LIGHTING_OVD'], ['pedestal', 'A_PED_LIGHTING_PEDESTAL'],
    ] },
    { key: 'flood', label: 'Flood and map lights', dimmers: [
      ['mainFlood', 'A_MIP_LIGHTING_FLOOD_MAIN'], ['pedestalFlood', 'A_MIP_LIGHTING_FLOOD_PEDESTAL'],
      ['captainMap', 'A_MIP_LIGHTING_MAP_L'], ['firstOfficerMap', 'A_MIP_LIGHTING_MAP_R'],
    ] },
    { key: 'captainDisplays', label: 'Captain displays', displays: true, dimmers: [
      ['captainPfd', 'A_DISPLAY_BRIGHTNESS_CO'], ['captainNd', 'A_DISPLAY_BRIGHTNESS_CI'],
      ['captainWeather', 'A_DISPLAY_BRIGHTNESS_CI_OUTER'],
    ] },
    { key: 'firstOfficerDisplays', label: 'First officer displays', displays: true, dimmers: [
      ['firstOfficerPfd', 'A_DISPLAY_BRIGHTNESS_FO'], ['firstOfficerNd', 'A_DISPLAY_BRIGHTNESS_FI'],
      ['firstOfficerWeather', 'A_DISPLAY_BRIGHTNESS_FI_OUTER'],
    ] },
    { key: 'engineDisplays', label: 'Engine and system displays', displays: true, dimmers: [
      ['upperDisplay', 'A_DISPLAY_BRIGHTNESS_ECAM_U'], ['lowerDisplay', 'A_DISPLAY_BRIGHTNESS_ECAM_L'],
    ] },
  ] },
};

const fieldId = (key: string) => `lighting.${key}Percent`;
const actionId = (key: string) => `lighting.preset.${key}.set`;

export type LightingPresetGroup = Readonly<{ actionId: string; label: string; fields: readonly string[]; displays?: boolean }>;

export function cockpitLightingGroups(adapterId: string): readonly LightingPresetGroup[] {
  if (adapterId === 'pmdg-737') return [
    { actionId: 'lighting.cockpit.panels.set', label: 'Panel backlighting', fields: [
      'lighting.overheadCircuitBreakerPercent', 'lighting.overheadPanelPercent',
      'lighting.mainPanelCaptainPercent', 'lighting.mainPanelFirstOfficerPercent',
    ] },
    { actionId: 'lighting.cockpit.ambient.set', label: 'Flood and background lighting', fields: [
      'lighting.backgroundPercent', 'lighting.afdsFloodPercent', 'lighting.pedestalFloodPercent', 'lighting.pedestalPanelPercent',
    ] },
    { actionId: 'lighting.cockpit.captainDisplays.set', label: 'Captain and upper displays', displays: true, fields: [
      'lighting.displayCaptainOutboardPercent', 'lighting.displayCaptainInboardPercent',
      'lighting.displayCaptainMapPercent', 'lighting.displayUpperPercent',
    ] },
    { actionId: 'lighting.cockpit.firstOfficerDisplays.set', label: 'First officer and lower displays', displays: true, fields: [
      'lighting.displayFirstOfficerOutboardPercent', 'lighting.displayFirstOfficerInboardPercent',
      'lighting.displayFirstOfficerMapPercent', 'lighting.displayLowerPercent',
    ] },
  ];
  if (adapterId === 'pmdg-777') return [
    ...['dome', 'circuitBreaker', 'overheadPanel', 'glareshieldPanel', 'glareshieldFlood',
      'leftPanel', 'leftFlood', 'rightPanel', 'rightFlood', 'aislePanel', 'aisleFlood'].map(key => ({
      actionId: `lighting.${key}.set`, label: key.replace(/[A-Z]/g, c => ` ${c.toLowerCase()}`), fields: [`lighting.${key}Percent`],
    })),
    ...['leftOutboardDisplay', 'leftInboardDisplay', 'rightInboardDisplay', 'rightOutboardDisplay', 'upperDisplay', 'lowerDisplay'].map(key => ({
      actionId: `lighting.${key}.set`, label: key.replace(/[A-Z]/g, c => ` ${c.toLowerCase()}`), fields: [`lighting.${key}Percent`], displays: true,
    })),
  ];
  return (DEFINITIONS[adapterId]?.groups || []).map(group => ({
    actionId: actionId(group.key), label: group.label, displays: group.displays,
    fields: group.dimmers.map(([key]) => fieldId(key)),
  }));
}

export function cockpitLightingIntegration(adapterId: string): {
  fields: Readonly<Record<string, AircraftIntegrationField>>;
  actions: Readonly<Record<string, AircraftIntegrationAction>>;
} {
  const definition = DEFINITIONS[adapterId];
  const fields: Record<string, AircraftIntegrationField> = {};
  const actions: Record<string, AircraftIntegrationAction> = {};
  if (!definition) return { fields, actions };
  for (const group of definition.groups) {
    const operations: SimConnectSequenceOperation[] = group.dimmers.map(([key, address]) => {
      const id = fieldId(key);
      fields[id] = { id, sources: [{
        route: definition.kind === 'potentiometer'
          // Indexed pots are read through the sidecar's A: variable reader;
          // they are not part of the generic telemetry SimVar subscription.
          ? { type: 'lvar', name: `A:LIGHT POTENTIOMETER:${address}`, unit: 'Percent' }
          : { type: 'lvar', name: `L:${address}`, unit: 'Number' },
        decode: { type: 'number', precision: 0, ...(definition.kind === 'fenix-lvar' ? { scale: 100 } : {}) },
      }] };
      return definition.kind === 'potentiometer'
        // LIGHT_POTENTIOMETER_SET takes index first, brightness second.
        ? { type: 'event', name: 'LIGHT_POTENTIOMETER_SET', value: Number(address), parameters: [{ source: 'input', round: 'nearest' }] }
        : { type: 'lvar', name: `L:${address}`, unit: 'Number', inputValue: { source: 'input', scale: 0.01 } };
    });
    const readbacks = group.dimmers.map(([key]) => ({ fieldId: fieldId(key), expectedInput: true as const,
      timeoutMs: 2500, freshness: 'field' as const }));
    const id = actionId(group.key);
    actions[id] = { id, input: { type: 'number', min: 0, max: 100, step: 1 },
      guard: { groupId: 'lighting.cockpit', cooldownMs: 0, retry: 'never' },
      routes: [{ id: `${adapterId}.${id}`, transport: 'simconnect-sequence', operations,
        ...(readbacks.length === 1 ? { readback: readbacks[0] } : { readbacks }),
      }], verification: 'untested',
    };
  }
  return { fields, actions };
}
