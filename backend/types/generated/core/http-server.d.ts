declare const os: typeof import("os");
type DebugLike = {
    log: (scope: string, message: string, extra?: Record<string, unknown>) => void;
};
type RequestLike = import('http').IncomingMessage & {
    url?: string | null;
    headers: import('http').IncomingHttpHeaders;
    method?: string | null;
};
type SimbriefLimiterLease = {
    allowed: true;
    release: () => void;
};
type SimbriefLimiterRejection = {
    allowed: false;
    statusCode: 429 | 503;
    retryAfterSeconds: number;
    error: string;
};
export declare function createSimbriefRequestLimiter({ now, cooldownMs, retentionMs, maxKeys, maxInFlight, maxInFlightPerClient, attemptWindowMs, maxAttemptsPerWindow, maxAttemptsPerClientWindow, }?: {
    now?: () => number;
    cooldownMs?: number;
    retentionMs?: number;
    maxKeys?: number;
    maxInFlight?: number;
    maxInFlightPerClient?: number;
    attemptWindowMs?: number;
    maxAttemptsPerWindow?: number;
    maxAttemptsPerClientWindow?: number;
}): {
    acquire: (username: string, remoteAddress: string | null | undefined) => SimbriefLimiterLease | SimbriefLimiterRejection;
};
export declare function resolvePackagedFrontendDir(moduleDir: string, packaged: boolean): string | null;
export declare const TOOLBAR_FRAME_ANCESTORS = "'self' coui: coui://html_ui";
export declare function getLocalIPsFromInterfaces(nets: ReturnType<typeof os.networkInterfaces>): string[];
export declare function isTrustedHttpRequest(req: RequestLike, remoteAccessEnable: boolean): boolean;
export declare function buildContentSecurityPolicy(req: RequestLike, nonce: string, remoteAccessEnable: boolean, options?: {
    frameAncestors?: string;
}): string;
export declare function buildBootstrapPayload(req: RequestLike, wsAuthToken: string, aircraftControlToken: string, networkInfo?: {
    ips: string[];
    httpPort: number | null;
    wsPort: number | null;
}, remoteAccessEnabled?: boolean): {
    ok: true;
    wsAuthToken: string;
    aircraftControlToken: string;
    remoteAccessEnabled: boolean;
    networkInfo: {
        ips: string[];
        httpPort: number | null;
        wsPort: number | null;
    };
};
export declare function startHttpServer({ wsPort, httpPort, remoteAccessEnable, wsAuthToken, aircraftControlToken, devicePairing, Debug, onFatalError, }: {
    wsPort: number;
    httpPort: number | null | undefined;
    remoteAccessEnable: boolean;
    wsAuthToken?: string;
    aircraftControlToken?: string;
    devicePairing?: {
        claimApprovedRequest: (id: unknown, remoteAddress: string | null | undefined) => string | null;
        createRequest: (remoteAddress: string | null | undefined) => {
            ok: boolean;
            request?: {
                confirmationCode: string;
                createdAt: number;
                expiresAt: number;
                id: string;
            };
            error?: string;
        };
        getRequestStatus: (id: unknown, remoteAddress: string | null | undefined) => {
            status: 'pending' | 'approved';
            expiresAt: number;
        } | {
            status: 'expired';
        };
    } | null;
    Debug: DebugLike;
    onFatalError?: (error: Error) => void;
}): {
    httpServer: import('http').Server;
    httpPort: number;
    httpBindAddress: string;
};
export {};
