import type { AircraftIntegrationDefinition } from './integration-engine/types.js';
export type FlightGuidanceRecipe = {
    id: string;
    version: number;
    eventType: string;
    lane: string;
    source: string;
    profileLeaves: string[];
    modeSettleMs: number;
    targetSettleMs: number;
    maxEvents: number;
    maxCoverageIntervals: number;
    dedupeWindowMs: number;
    lateralModes: string[];
    verticalModes: string[];
    automationModeAliases: Record<string, string>;
    fields: Record<string, string>;
    booleanModes: {
        fieldId: string;
        label: string;
    }[];
    targetLabelPrefix: string;
};
type OverlayInput = {
    key: string;
    allowed: number[];
} | {
    key: string;
    min: number;
    max: number;
    coerceNumber?: boolean;
};
export type LightingOverlayRecipe = {
    snapshotStatus: string;
    freshnessMs: number;
    futureToleranceMs: number;
    inputs: Record<string, OverlayInput>;
    outputs: Record<string, {
        any: {
            input: string;
            equals: number;
        }[];
    }>;
};
export type IntegrationBehavior = {
    keyEventPolicy?: {
        eventGroups: Record<string, string>;
        cooldownMs: number;
        inFlightError: string;
        cooldownError: string;
    };
    readbackFailureHints?: {
        actionPrefix: string;
        text: string;
    }[];
    lightingOverlay?: LightingOverlayRecipe;
    flightGuidanceProjection?: FlightGuidanceRecipe;
};
export declare const integrationBehaviorSchema: {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: Record<string, import("ajv").AnySchema>;
};
/** Shared metadata validation also covers definitions registered without the YAML loader. */
export declare function assertIntegrationBehavior(definition: AircraftIntegrationDefinition): void;
export {};
