import type { AnySchema } from 'ajv';
import { logicalIdSchema } from '../integration-engine/definition-yaml.js';

export type LightingPresetGroup = Readonly<{
  actionId: string;
  label: string;
  fields: readonly string[];
  displays?: boolean;
}>;

export const cockpitLightingGroupsSchema: AnySchema = {
  type: 'array', minItems: 1, maxItems: 32,
  items: {
    type: 'object', additionalProperties: false, required: ['actionId', 'label', 'fields'],
    properties: {
      actionId: logicalIdSchema,
      label: { type: 'string', minLength: 1, maxLength: 160 },
      fields: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: logicalIdSchema },
      displays: { type: 'boolean' },
    },
  },
};

/** Presentation may refer only to actions and observations owned by this definition. */
export function hasValidCockpitLightingGroups(definition: {
  presentation?: { cockpitLightingGroups?: unknown };
  actions: Readonly<Record<string, unknown>>;
  fields: Readonly<Record<string, unknown>>;
}): boolean {
  const groups = definition.presentation?.cockpitLightingGroups;
  if (groups === undefined) return true;
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > 32) return false;
  const actionIds = new Set<string>();
  return groups.every(group => {
    if (!group || typeof group !== 'object' || Array.isArray(group)
      || Object.keys(group).some(key => !['actionId', 'label', 'fields', 'displays'].includes(key))
      || typeof group.actionId !== 'string' || !Object.hasOwn(definition.actions, group.actionId)
      || actionIds.has(group.actionId)
      || typeof group.label !== 'string' || !group.label.length || group.label.length > 160
      || (group.displays !== undefined && typeof group.displays !== 'boolean')
      || !Array.isArray(group.fields) || group.fields.length < 1 || group.fields.length > 32
      || new Set(group.fields).size !== group.fields.length
      || group.fields.some(fieldId => typeof fieldId !== 'string' || !Object.hasOwn(definition.fields, fieldId))) return false;
    actionIds.add(group.actionId);
    return true;
  });
}
