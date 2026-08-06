declare const os: typeof import("os");
type DebugLike = {
    log: (scope: string, message: string, extra?: Record<string, unknown>) => void;
};
type RequestLike = import('http').IncomingMessage & {
    url?: string | null;
    headers: import('http').IncomingHttpHeaders;
    method?: string | null;
};
export declare function resolvePackagedFrontendDir(moduleDir: string, packaged: boolean): string | null;
export declare function getLocalIPsFromInterfaces(nets: ReturnType<typeof os.networkInterfaces>): string[];
export declare function isTrustedHttpRequest(req: RequestLike, remoteAccessEnable: boolean): boolean;
export declare function buildContentSecurityPolicy(req: RequestLike, nonce: string, remoteAccessEnable: boolean): string;
export declare function injectCspNonce(html: string, nonce: string): string;
export declare function buildBootstrapPayload(req: RequestLike, wsAuthToken: string, aircraftControlToken: string, networkInfo?: {
    ips: string[];
    httpPort: number | null;
    wsPort: number | null;
}): {
    ok: true;
    wsAuthToken: string;
    aircraftControlToken: string;
    networkInfo: {
        ips: string[];
        httpPort: number | null;
        wsPort: number | null;
    };
};
export declare function startHttpServer({ wsPort, httpPort, remoteAccessEnable, wsAuthToken, aircraftControlToken, Debug, onFatalError, }: {
    wsPort: number;
    httpPort: number | null | undefined;
    remoteAccessEnable: boolean;
    wsAuthToken?: string;
    aircraftControlToken?: string;
    Debug: DebugLike;
    onFatalError?: (error: Error) => void;
}): {
    httpServer: import('http').Server;
    httpPort: number;
    httpBindAddress: string;
};
export {};
