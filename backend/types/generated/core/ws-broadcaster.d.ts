type BroadcastPayload = Record<string, unknown> & {
    type?: string | null;
};
type WsClientLike = {
    bufferedAmount?: number;
    readyState: number;
    send: (message: string) => void;
    terminate: () => void;
};
type WsServerLike = {
    clients: Iterable<WsClientLike>;
};
type EventBusLike = {
    emit: (eventName: string, payload: BroadcastPayload) => void;
};
type DebugLike = {
    log: (scope: string, message: string, extra?: Record<string, unknown>) => void;
};
export declare const MAX_WS_BUFFERED_BYTES: number;
export declare function createBroadcast({ wss, eventBus, Debug, }: {
    wss: WsServerLike;
    eventBus: EventBusLike;
    Debug: DebugLike;
}): (obj: BroadcastPayload) => void;
export {};
