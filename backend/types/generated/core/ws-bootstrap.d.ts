export declare const SUBSCRIBABLE_MESSAGE_TYPES: ReadonlyArray<string>;
type DebugLike = {
    log: (scope: string, message: string, extra?: Record<string, unknown>) => void;
};
type LoggerFn = (...args: unknown[]) => void;
type WsSocketLike = {
    on: (eventName: string, handler: (...args: any[]) => void | Promise<void>) => void;
    send?: (payload: string, ...args: any[]) => void;
    __ffPrivilegedClient?: boolean;
    __ffAircraftControlClient?: boolean;
    __ffAircraftControlPairingStatus?: AircraftControlPairingStatus;
    __ffSubscribedTypes?: ReadonlySet<string> | null;
};
type AircraftControlPairingStatus = 'not-requested' | 'accepted' | 'expired' | 'disabled';
type ClientConnectedHandler = (ws: WsSocketLike) => void;
type ClientMessageHandler = (ws: WsSocketLike, msg: Record<string, unknown>) => Promise<void> | void;
/**
 * Parse the optional `subscribe` handshake parameter. Returns null when the
 * client did not subscribe, a Set of message types when it did, or 'invalid'
 * when the request names an empty list or a type that is not subscribable.
 */
export declare function parseSubscriptionParameter(urlValue: string | null | undefined): ReadonlySet<string> | null | 'invalid';
/** Whether a subscribed socket should receive this serialized message. */
export declare function isSubscribedMessage(subscribedTypes: ReadonlySet<string> | null | undefined, payload: string): boolean;
export declare function isPrivateOrLoopbackRemoteAddress(remoteAddress: string | null | undefined): boolean;
export declare function createWsServer({ wsPort, remoteAccessEnable, remoteAircraftControlEnable, wsAuthToken, aircraftControlToken, devicePairing, Debug, tlog, onClientConnected, onClientMessage, onFatalError, }: {
    wsPort: number;
    remoteAccessEnable?: boolean;
    remoteAircraftControlEnable?: boolean;
    wsAuthToken?: string;
    aircraftControlToken?: string;
    devicePairing?: {
        hasApprovedSession: (sessionId: unknown, remoteAddress: string | null | undefined) => boolean;
    } | null;
    Debug: DebugLike;
    tlog: LoggerFn;
    onClientConnected: ClientConnectedHandler;
    onClientMessage: ClientMessageHandler;
    onFatalError?: (error: Error) => void;
}): unknown;
export {};
