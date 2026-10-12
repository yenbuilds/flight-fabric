import type { AircraftIntegrationActionRoute } from './aircraft-integrations/types.js';
import { executeA32nxMinimums } from './aircraft-integrations/fbw-a32nx/minimums-control.js';
type ExecutionRequest = Omit<Parameters<typeof executeA32nxMinimums>[0], 'target'>;
/** Aircraft-owned selection for the existing registry-validated minimums route. */
export declare function resolveMinimumsExecution(adapterId: string, route: AircraftIntegrationActionRoute): {
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
    }>;
};
export {};
