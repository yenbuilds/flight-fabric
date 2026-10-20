import type { AircraftIntegrationDefinition } from '../integration-engine/types.js';
type LegacyExport = Readonly<{
    kind: 'integration' | 'id';
    order: number;
} | {
    kind: 'profile';
    profileKey: string;
    order: number;
}>;
export type IntegrationCatalogue = Readonly<{
    order: number;
    legacyExports: Readonly<Record<string, LegacyExport>>;
}>;
export declare const catalogueSchema: {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: Record<string, import("ajv").AnySchema>;
};
/** Optional on custom definitions; bundled catalogue entries opt in explicitly. */
export declare function assertIntegrationCatalogue(definition: AircraftIntegrationDefinition): void;
/** Resolve compatibility aliases from data without deriving aircraft identities from export names. */
export declare function buildIntegrationCatalogue(input: readonly AircraftIntegrationDefinition[]): {
    definitions: Readonly<{
        behavior?: import("../integration-behavior.js").IntegrationBehavior;
        catalogue?: IntegrationCatalogue;
        actions: Readonly<Record<string, import("../integration-engine/types.js").AircraftIntegrationAction>>;
        aircraft: Readonly<{
            family: string;
            vendor: string;
        }>;
        fields: Readonly<Record<string, import("../integration-engine/types.js").AircraftIntegrationField>>;
        id: string;
        presentation: Readonly<{
            templateId: string;
            cockpitLightingGroups?: readonly import("./cockpit-lighting-schema.js").LightingPresetGroup[];
        }>;
        trustedProfileKeys: readonly string[];
    }>[];
    legacyExports: (readonly [string, unknown])[];
};
export {};
