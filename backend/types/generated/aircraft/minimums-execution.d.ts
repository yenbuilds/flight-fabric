import type { AircraftIntegrationActionRoute } from './integration-engine/types.js';
import { executeGuardedDisplayEntry } from './guarded-display-entry.js';
type ExecutionRequest = Omit<Parameters<typeof executeGuardedDisplayEntry>[0], 'recipe'>;
/** Public minimums result adapter for the registry-validated display-entry recipe. */
export declare function resolveMinimumsExecution(_adapterId: string, route: AircraftIntegrationActionRoute): {
    execute: (request: ExecutionRequest) => Promise<{
        ok: boolean;
        code: string;
        error: string;
        executionStarted: boolean;
        noOp?: undefined;
        confirmedValue?: undefined;
    } | {
        ok: boolean;
        noOp: boolean;
        confirmedValue: number;
        executionStarted: boolean;
        code?: undefined;
        error?: undefined;
    } | {
        ok: boolean;
        confirmedValue: number;
        executionStarted: boolean;
        code?: undefined;
        error?: undefined;
        noOp?: undefined;
    } | {
        code: string;
        ok: boolean;
        noOp: boolean;
        confirmedValue: number;
        executionStarted: boolean;
        error?: undefined;
    } | {
        code: string;
        ok: boolean;
        confirmedValue: number;
        executionStarted: boolean;
        error?: undefined;
        noOp?: undefined;
    }>;
};
export {};
