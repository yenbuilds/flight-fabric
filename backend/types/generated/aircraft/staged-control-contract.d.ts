import type { AnySchema } from 'ajv';
type Scalar = string | number | boolean;
export type ControlObservation = {
    fieldId: string;
    type: 'boolean' | 'boolean01' | 'enum' | 'number';
    values?: Scalar[];
    optional?: true;
    rounding?: {
        property: string;
        equals: Scalar;
        scale: number;
        otherwise: number;
    };
};
export type ControlCondition = {
    property: string;
    equals?: Scalar;
    input?: true;
    scale?: number;
};
type StageBase = {
    phase: string;
    property: string;
    conditions: ControlCondition[];
    invalidate?: string;
};
type Freeze = {
    conditions: ControlCondition[];
    message: string;
};
export type ControlStage = StageBase & {
    kind: 'ensure';
    write: string;
    confirmation: 'written' | 'affected';
    freeze?: Freeze;
} | StageBase & {
    kind: 'transition';
    write: string;
    maxTransitions: number;
    completion: ControlCondition[];
    freeze: Freeze;
} | StageBase & {
    kind: 'step';
    decrease: string;
    increase: string;
    scale: number;
    min: number;
    max: number;
    maxSteps: number;
};
export type StagedControlRecipe = {
    sampling: 'raw' | 'decoded';
    freshnessMs: number;
    prerequisites: (ControlObservation & {
        equals: Scalar;
    })[];
    targets: {
        id: string;
        observations: Record<string, ControlObservation>;
        writes: Record<string, number>;
    }[];
    input?: {
        min: number;
        max: number;
        step: number;
        validation: 'offset-step' | 'scaled-integer';
        scale: number;
    };
    stages: ControlStage[];
    final: ControlCondition[];
    timing: {
        readbackTimeoutMs: number;
        pollMs: number;
        totalTimeoutMs?: number;
    };
    errors: {
        staleContext: string;
        failed: string;
        unavailable: string;
        transportRejected: string;
        writeRejected: string;
        invalidInput: string;
        timeout: string;
        timeLimit: string;
        finalChanged: string;
        outOfRange: string;
        missingValue: string;
        unexpectedStep: string;
        valueChanged: string;
    };
};
export declare const stagedControlSchema: AnySchema;
/** Validate references and consumed operations, not aircraft names or duplicate write recipes. */
export declare function hasValidStagedControl(definition: any, action: any, route: any): boolean;
export {};
