export declare function readMinimumsPage(raw: unknown): {
    title: string;
    scratchpad: string;
    baro: string;
    radio: string;
    radioAvailable: boolean;
};
/** SimBridge's documented remote MCDU keys edit FMGC performance data, not output LVARs.
 * Require the pilot's active PERF APPR page and empty scratchpad. Never navigate,
 * clear a pilot entry, retry a key, or continue after profile/input interference.
 */
export declare function executeA32nxMinimums({ target, value, isCurrent, createSocket, timeoutMs, stepTimeoutMs, }: {
    target: 'baro' | 'radio';
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
