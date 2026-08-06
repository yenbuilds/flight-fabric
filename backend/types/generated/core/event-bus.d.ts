export type EventHandler = (payload: unknown) => void;
export declare function setDebug(enabled: boolean): void;
export declare function emit(event: string, payload: unknown): void;
export declare function on(event: string, handler: EventHandler): () => void;
export declare function once(event: string, handler: EventHandler): () => void;
export declare function off(event: string, handler: EventHandler): void;
export declare function removeAllListeners(event?: string): void;
export declare function listenerCount(event: string): number;
export declare function eventNames(): string[];
