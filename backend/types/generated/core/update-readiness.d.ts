type UpdateReadiness = {
    connected: unknown;
    observedAt: number;
    now: number;
    recording: boolean;
    finalizing: boolean;
    requests: number;
    shuttingDown: boolean;
};
export declare function getUpdateBlocker(state: UpdateReadiness): string;
export {};
