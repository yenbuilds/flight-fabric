export type DebugEntry = {
    ts: number;
    section: string;
    message: string;
    data: unknown;
};
export declare function init(broadcast: unknown): void;
export declare function log(section: string, message: string, data?: unknown): void;
export declare function tlog(prefix: string, ...args: unknown[]): void;
export declare function twarn(prefix: string, ...args: unknown[]): void;
