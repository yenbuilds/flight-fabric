import type { AircraftIntegrationActionRoute } from './aircraft-integrations/types.js';
import { executeBaroTransaction } from './aircraft-integrations/fbw-a32nx/baro-control.js';
import { executeFenixBaroTransaction } from './aircraft-integrations/fenix-a32x/baro-control.js';
type ReadSources = {
    raw: (id: string) => {
        value: unknown;
        updatedAt: unknown;
    };
    decoded: (id: string) => {
        observed: unknown;
        fresh: boolean;
        updatedAtMs: number;
    };
};
type ExecutionRequest = {
    value?: number;
    isCurrent: () => boolean;
    /** A fresh, current-profile snapshot gate on every capture, never a cached observation. */
    capture: () => ReadSources | null;
    sendEvent: Parameters<typeof executeBaroTransaction>[0]['sendEvent'];
    setNamedVar: Parameters<typeof executeBaroTransaction>[0]['setNamedVar'];
    executeCode: Parameters<typeof executeFenixBaroTransaction>[0]['executeCode'];
    findException: Parameters<typeof executeBaroTransaction>[0]['findException'];
};
/**
 * Aircraft-owned compatibility dispatch for the existing, registry-validated
 * barometer contracts. It accepts no provider instance or executable profile
 * callbacks. The three procedures remain distinct pending later engine work.
 */
export declare function resolveBarometerExecution(adapterId: string, route: AircraftIntegrationActionRoute): {
    requiresCalculatorTransport: boolean;
    execute: (request: ExecutionRequest) => Promise<{
        baro: {
            confirmedSides: ("captain" | "firstOfficer")[];
            unit?: string;
            value?: number;
            target: import("./barometer-contract.js").BaroTarget;
            mode: string;
        };
        noOp?: boolean;
        idempotent?: boolean;
        ok: boolean;
        code: string;
        executionStarted?: undefined;
        error?: undefined;
    } | {
        ok: boolean;
        code: any;
        executionStarted: boolean;
        error: any;
        baro: {
            confirmedSides: ("captain" | "firstOfficer")[];
            unit?: string;
            value?: number;
            target: import("./barometer-contract.js").BaroTarget;
            mode: string;
        };
    }>;
} | {
    requiresCalculatorTransport: boolean;
    execute: (request: ExecutionRequest) => Promise<{
        ok: boolean;
        code: string;
        executionStarted: boolean;
        noOp: boolean;
        baro: {
            target: import("./barometer-contract.js").BaroTarget;
            mode: string;
            confirmedSides: ("captain" | "firstOfficer")[];
        };
        error?: undefined;
    } | {
        ok: boolean;
        code: any;
        error: any;
        executionStarted: boolean;
        baro: {
            target: import("./barometer-contract.js").BaroTarget;
            mode: string;
            confirmedSides: ("captain" | "firstOfficer")[];
        };
        noOp?: undefined;
    }>;
};
export {};
