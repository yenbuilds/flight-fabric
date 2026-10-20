import type { GuardedDisplayEntryRecipe } from './guarded-display-entry-contract.js';
export declare function readDisplayEntryPage(raw: unknown, recipe: GuardedDisplayEntryRecipe): {
    title: string;
    scratchpad: string;
    fields: {
        [k: string]: string | boolean;
    };
};
/** Guarded, observed text entry. Never navigate, clear pilot input or retry a key. */
export declare function executeGuardedDisplayEntry({ recipe, value, isCurrent, createSocket, timeoutMs, stepTimeoutMs, }: {
    recipe: GuardedDisplayEntryRecipe;
    value: unknown;
    isCurrent: () => boolean;
    createSocket?: () => any;
    timeoutMs?: number;
    stepTimeoutMs?: number;
}): Promise<{
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
