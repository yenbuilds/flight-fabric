type Cell = Readonly<{
    row: number;
    column: number;
}>;
export type GuardedDisplayEntryRecipe = Readonly<{
    channel: 'left' | 'right';
    input: Readonly<{
        min: number;
        max: number;
        step: 1;
    }>;
    page: Readonly<{
        titlePrefix: string;
        rowCount: number;
        labels: readonly Readonly<Cell & {
            equals: string;
        }>[];
        fields: Readonly<Record<string, Readonly<Cell & {
            equals?: string;
        }>>>;
    }>;
    valueField: string;
    clearFieldIds: readonly string[];
    availableWhen?: Readonly<{
        fieldId: string;
        expectedValue: string | boolean;
    }>;
    confirmKey: string;
    timing: Readonly<{
        timeoutMs: number;
        stepTimeoutMs: number;
        freshnessMs: number;
        settleMs: number;
        pollMs: number;
        handshakeTimeoutMs: number;
        maxPayload: number;
    }>;
    messages: Readonly<Record<'invalidValue' | 'stale' | 'timeout' | 'unavailable' | 'disconnected' | 'interference' | 'invalidPage' | 'connectTimeout' | 'pageRequired' | 'scratchpadOccupied' | 'fieldUnavailable' | 'entryChanged' | 'digitUnconfirmed' | 'commitChanged' | 'unconfirmed' | 'failed', string>>;
}>;
export declare const guardedDisplayEntrySchema: {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: Record<string, import("ajv").AnySchema>;
};
/** The same bounded recipe contract applies to YAML and programmatic registration. */
export declare function hasValidGuardedDisplayEntryRecipe(recipe: unknown, actionInput: unknown): recipe is GuardedDisplayEntryRecipe;
export {};
