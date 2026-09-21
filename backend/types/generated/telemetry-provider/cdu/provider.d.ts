/** The only boundary that sees provider internals and trusted aircraft profiles. */
export declare function createProviderCdu(provider: Record<string, any>, profiles: Record<string, any>): {
    request(message: import("../../../packages/telemetry-types/src/cdu.js").CduRequest, canWrite?: () => boolean): Promise<Omit<import("../../../packages/telemetry-types/src/cdu.js").CduState, "type" | "requestId" | "ok">>;
    dispose: () => Promise<void>;
    stop: () => Promise<void>;
};
