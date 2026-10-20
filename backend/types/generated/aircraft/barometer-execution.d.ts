import type { AircraftIntegrationActionRoute } from './integration-engine/types.js';
import { type ControlReadSources } from './staged-control-execution.js';
type ExecutionRequest = {
    value?: number;
    isCurrent: () => boolean;
    /** A fresh, current-profile snapshot gate on every capture, never a cached observation. */
    capture: () => ControlReadSources | null;
    sendEvent: (name: string, value: number) => Promise<any>;
    setNamedVar: (input: {
        name: string;
        unit: string;
        value: number;
    }) => Promise<any>;
    executeCode: (code: string) => Promise<any>;
    findException?: (ids: number[], since: number) => unknown;
};
/**
 * Public barometer result adaptation for registry-validated neutral recipes.
 * Sampling contracts, writes and procedures belong to each YAML recipe.
 */
export declare function resolveBarometerExecution(_adapterId: string, route: AircraftIntegrationActionRoute): {
    requiresCalculatorTransport: boolean;
    execute: (request: ExecutionRequest) => Promise<{
        code: any;
        baro: {
            confirmedSides: string[];
            unit?: string;
            value?: number;
            target: "captain" | "firstOfficer" | "both";
            mode: string;
        };
        noOp?: boolean;
        idempotent?: boolean;
        ok: boolean;
        executionStarted?: undefined;
        error?: undefined;
    } | {
        code: any;
        baro: {
            confirmedSides: string[];
            unit?: string;
            value?: number;
            target: "captain" | "firstOfficer" | "both";
            mode: string;
        };
        ok: boolean;
        executionStarted: boolean;
        error: any;
    }>;
} | {
    requiresCalculatorTransport: boolean;
    execute: (request: ExecutionRequest) => Promise<{
        baro: {
            target: "captain" | "firstOfficer" | "both";
            mode: string;
            confirmedSides: string[];
        };
        code: any;
        error?: any;
        ok: boolean;
        executionStarted: boolean;
        noOp: boolean;
    } | {
        baro: {
            target: "captain" | "firstOfficer" | "both";
            mode: string;
            confirmedSides: string[];
        };
        code: any;
        error: any;
        ok: boolean;
        executionStarted: boolean;
        noOp?: undefined;
    }>;
};
export {};
