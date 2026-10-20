type Bridge = {
    _started?: boolean;
    getSnapshot?: () => {
        status?: string;
    };
};
type RecoveryDependencies = {
    bridge: () => Bridge | null;
    ensure: () => Promise<Bridge | null>;
    now: () => number;
    wait: (ms: number) => Promise<void>;
};
/** Reconnect the transport only. The caller may send STOP after this succeeds,
 * never replay the motion demand whose acknowledgement was lost. */
export declare function recoverTaxiControlBridge(error: unknown, valid: () => boolean, deps: RecoveryDependencies): Promise<boolean>;
export {};
