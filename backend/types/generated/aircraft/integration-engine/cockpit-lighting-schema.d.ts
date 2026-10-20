import type { AnySchema } from 'ajv';
export type LightingPresetGroup = Readonly<{
    actionId: string;
    label: string;
    fields: readonly string[];
    displays?: boolean;
}>;
export declare const cockpitLightingGroupsSchema: AnySchema;
/** Presentation may refer only to actions and observations owned by this definition. */
export declare function hasValidCockpitLightingGroups(definition: {
    presentation?: {
        cockpitLightingGroups?: unknown;
    };
    actions: Readonly<Record<string, unknown>>;
    fields: Readonly<Record<string, unknown>>;
}): boolean;
