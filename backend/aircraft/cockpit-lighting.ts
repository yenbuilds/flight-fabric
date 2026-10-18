import type { LightingPresetGroup } from './integration-engine/cockpit-lighting-schema.js';

const { defaultAircraftIntegrationRegistry } = require('./integration-engine');

/** Return independent presentation values; callers cannot mutate the frozen catalogue. */
export function cockpitLightingGroups(adapterId: string): readonly LightingPresetGroup[] {
  const groups: readonly LightingPresetGroup[] = defaultAircraftIntegrationRegistry.getById(adapterId)
    ?.presentation.cockpitLightingGroups || [];
  return groups.map(group => ({ ...group, fields: [...group.fields] }));
}
