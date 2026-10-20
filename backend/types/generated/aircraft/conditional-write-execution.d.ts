import type { SimConnectSequenceActionRoute } from './integration-engine/types.js';
type Sample = {
    observed: unknown;
    updatedAtMs: number;
    fresh: boolean;
};
export type ConditionalWriteState = Record<string, {
    ready: boolean;
    satisfied: boolean;
    updatedAt: number;
}>;
/** Read only the explicitly associated fields of a registry-validated recipe. */
export declare function captureConditionalWriteState(route: SimConnectSequenceActionRoute, sample: (id: string) => Sample, now?: number): ConditionalWriteState | null;
/**
 * Ordered, conditional fixed writes with independent confirmation per target.
 * The recipe owns field/event associations; this operation owns no aircraft facts.
 * Writes are never retried. Linked feedback may satisfy a later target before dispatch.
 */
export declare function executeConditionalWrites({ route, capture, isCurrent, sendEvent, findException, now, sleep, }: {
    route: SimConnectSequenceActionRoute;
    capture: () => ConditionalWriteState | null;
    isCurrent: () => boolean;
    sendEvent: (name: string, value: number) => Promise<unknown>;
    findException?: (ids: number[], since: number) => unknown;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
}): Promise<{
    ok: boolean;
    code: string;
    executionStarted: boolean;
    noOp: boolean;
    confirmedTargets: string[];
    error?: undefined;
} | {
    ok: boolean;
    code: any;
    error: any;
    executionStarted: boolean;
    confirmedTargets: string[];
    noOp?: undefined;
}>;
export {};
