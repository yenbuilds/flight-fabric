type DebugLike = {
    log: (scope: string, message: string, extra?: Record<string, unknown>) => void;
};
type LoggerFn = (...args: unknown[]) => void;
type WsSocketLike = {
    on: (eventName: string, handler: (...args: any[]) => void | Promise<void>) => void;
    send?: (payload: string, ...args: any[]) => void;
    __ffPrivilegedClient?: boolean;
    __ffAircraftControlClient?: boolean;
};
type ClientConnectedHandler = (ws: WsSocketLike) => void;
type ClientMessageHandler = (ws: WsSocketLike, msg: Record<string, unknown>) => Promise<void> | void;
export declare function isPrivateOrLoopbackRemoteAddress(remoteAddress: string | null | undefined): boolean;
export declare function createWsServer({ wsPort, remoteAccessEnable, remoteAircraftControlEnable, wsAuthToken, aircraftControlToken, Debug, tlog, onClientConnected, onClientMessage, onFatalError, }: {
    wsPort: number;
    remoteAccessEnable?: boolean;
    remoteAircraftControlEnable?: boolean;
    wsAuthToken?: string;
    aircraftControlToken?: string;
    Debug: DebugLike;
    tlog: LoggerFn;
    onClientConnected: ClientConnectedHandler;
    onClientMessage: ClientMessageHandler;
    onFatalError?: (error: Error) => void;
}): unknown;
export {};
