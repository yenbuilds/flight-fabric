import { type AnySchema, type ValidateFunction } from 'ajv';
export declare const logicalIdSchema: {
    type: string;
    pattern: string;
};
export declare const adapterIdSchema: {
    type: string;
    pattern: string;
};
export declare const bundledProfileKeySchema: {
    type: string;
    pattern: string;
};
export declare const AIRCRAFT_DEFINITION_MAX_BYTES: number;
export declare function strictObject(properties: Record<string, AnySchema>, required?: string[]): {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: Record<string, AnySchema>;
};
export declare function createDocumentValidator<T>(schema: AnySchema): ValidateFunction<T>;
/** Read immutable release assets without allocating or reading beyond their byte limit. */
export declare function readBundledDefinitionBytes(filePath: string, maxBytes: number): Buffer;
/** Shared parsing boundary for bundled data. Tags, aliases and executable modules are never loaded. */
export declare function loadYamlDocument<T>(filePath: string, validate: ValidateFunction<T>, maxBytes?: number): T;
