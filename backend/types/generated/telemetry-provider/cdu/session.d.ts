import type { CduAdapter } from './types.js';
import type { CduRequest, CduState } from '../../../packages/telemetry-types/src/cdu.js';
export interface CduContext {
    profileKey: string;
    profileRevision: number;
    integrationId: string;
    connected: boolean;
    /** Provider-owned identity across simulator connections and control transports. */
    generation?: unknown;
}
/** One provider-owned session, shared by viewers; adapters own their bounded transports. */
export declare function createCduSession({ context, createAdapter, now, onError }: {
    context: () => CduContext | null;
    createAdapter: (id: string) => CduAdapter | null;
    now?: () => number;
    onError?: (error: unknown) => void;
}): {
    request(message: CduRequest, canWrite?: () => boolean): Promise<Omit<CduState, "type" | "requestId" | "ok">>;
    dispose: () => Promise<void>;
    stop: () => Promise<void>;
};
