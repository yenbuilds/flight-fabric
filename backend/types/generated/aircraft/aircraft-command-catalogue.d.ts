import type { LightingPresetGroup } from './integration-engine/cockpit-lighting-schema.js';
/** Shared intent only. Each family below explicitly selects its own existing actions. */
export declare const PARITY_COMMAND_DEFINITIONS: readonly AircraftCommandDefinition[];
export declare function aircraftParityBindings(adapterId: string): readonly AircraftCommandBinding[];
/** Return independent presentation values; callers cannot mutate the frozen catalogue. */
export declare function cockpitLightingGroups(adapterId: string): readonly LightingPresetGroup[];
type GenericRecord = Record<string, any>;
export type AircraftCommandInput = Readonly<{
    kind: 'none';
} | {
    kind: 'boolean';
} | {
    kind: 'number';
    min: number;
    max: number;
    step: number;
    units: string;
} | {
    kind: 'enum';
    values: readonly string[];
}>;
export type AircraftCommandDefinition = Readonly<{
    description?: string;
    group: string;
    id: string;
    input: AircraftCommandInput;
    kind?: 'action' | 'preset';
    label: string;
    speech?: Readonly<{
        /** One complete spoken form shown beside a preset that takes a value. */
        example?: string;
        fixedInputs?: Readonly<Record<string, Readonly<{
            value: boolean;
        }>>>;
        hints?: readonly string[];
        patterns: readonly string[];
    }>;
}>;
type LegacyRequest = Readonly<{
    actionId?: string;
    control: string;
    operation: string;
    target?: string;
    value?: unknown;
}>;
export type AircraftCommandBinding = Readonly<{
    commandId: string;
    input?: AircraftCommandInput;
    brightnessFields?: readonly string[];
    observations?: readonly Readonly<{
        fieldId: string;
        expectedValue: boolean | string;
        label: string;
        inhibitsRequest?: boolean;
    }>[];
} & ({
    kind: 'fixed';
    request: LegacyRequest;
} | {
    kind: 'input';
    inputKey: string;
    request: LegacyRequest;
} | {
    kind: 'choice';
    choices: Readonly<Record<string, LegacyRequest>>;
} | {
    kind: 'choice-sequence';
    description: string;
    choices: Readonly<Record<string, readonly Readonly<{
        label: string;
        request: LegacyRequest;
        settleMs?: number;
    }>[]>>;
} | {
    kind: 'sequence';
    description: string;
    steps: readonly Readonly<{
        label: string;
        request: LegacyRequest;
        settleMs?: number;
    }>[];
} | {
    kind: 'input-sequence';
    description: string;
    inputKey: string;
    steps: readonly Readonly<{
        label: string;
        request: LegacyRequest;
    }>[];
})>;
export type AircraftCommandConfiguration = Readonly<{
    bindings: readonly AircraftCommandBinding[];
    id: string;
}>;
export type NormalizedAircraftCommandRequest = Readonly<{
    commandId: string;
    input: Readonly<Record<string, boolean | number | string>>;
    profileKey: string | null;
    profileRevision: number | null;
    requestId: string | null;
}>;
export declare function resolveAircraftCommandConfiguration(profile: unknown): AircraftCommandConfiguration;
export declare function resolveAircraftCommandRequest(rawRequest: unknown, profile: unknown): GenericRecord;
export declare function buildAircraftCommandCatalogue(profile: unknown, options: {
    profileRevision?: unknown;
    resolveControl: (request: unknown) => GenericRecord;
}): GenericRecord;
export {};
