import type { StagedControlRecipe } from './staged-control-contract.js';
type Observation = {
    values: Record<string, unknown>;
    times: Record<string, number>;
};
export type StagedControlState = {
    available: boolean;
    targets: Record<string, Observation>;
};
export type ControlReadSources = {
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
/** Sample the recipe's own fields; whole-snapshot timestamps never stand in for field freshness. */
export declare function captureStagedControlState(recipe: StagedControlRecipe, sources: ControlReadSources, now?: number): StagedControlState | null;
/**
 * A bounded observed-control transaction. Stages describe absolute writes,
 * feedback-confirmed transitions and single increments; linking is inferred
 * only from each selected target's own newer observation, never from an ACK.
 */
export declare function executeStagedControl({ recipe, value, capture, isCurrent, write, findException, now, sleep, }: {
    recipe: StagedControlRecipe;
    value?: number;
    capture: () => StagedControlState | null;
    isCurrent: () => boolean;
    write: (targetId: string, writeKey: string) => Promise<any>;
    findException?: (ids: number[], since: number) => unknown;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
}): Promise<{
    confirmedTargets: string[];
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
    confirmedTargets: string[];
}>;
export {};
