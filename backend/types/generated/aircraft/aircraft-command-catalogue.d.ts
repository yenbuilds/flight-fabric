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
type AircraftCommandBinding = Readonly<{
    commandId: string;
    input?: AircraftCommandInput;
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
    kind: 'sequence';
    description: string;
    steps: readonly Readonly<{
        label: string;
        request: LegacyRequest;
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
export declare const GENERIC_AIRCRAFT_COMMAND_CONFIGURATION: AircraftCommandConfiguration;
export declare const PMDG_737_AIRCRAFT_COMMAND_CONFIGURATION: AircraftCommandConfiguration;
export declare const FBW_A32NX_AIRCRAFT_COMMAND_CONFIGURATION: AircraftCommandConfiguration;
export declare const FENIX_A32X_AIRCRAFT_COMMAND_CONFIGURATION: AircraftCommandConfiguration;
export declare const PMDG_777_AIRCRAFT_COMMAND_CONFIGURATION: AircraftCommandConfiguration;
export declare function resolveAircraftCommandConfiguration(profile: unknown): AircraftCommandConfiguration;
export declare function normalizeAircraftCommandRequest(rawRequest: unknown): NormalizedAircraftCommandRequest | null;
export declare function resolveAircraftCommandRequest(rawRequest: unknown, profile: unknown): GenericRecord;
export declare function buildAircraftCommandCatalogue(profile: unknown, options: {
    profileRevision?: unknown;
    resolveControl: (request: unknown) => GenericRecord;
}): GenericRecord;
export {};
