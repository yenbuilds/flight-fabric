type ClientScopeFlags = {
    __ffPrivilegedClient?: boolean;
    __ffAircraftControlClient?: boolean;
};
type ServerMessage = Record<string, any>;
export declare const UNPAIRED_PASSTHROUGH_SERVER_MESSAGE_TYPES: ReadonlyArray<string>;
export declare const UNPAIRED_PROJECTED_SERVER_MESSAGE_TYPES: ReadonlyArray<string>;
export declare const UNPAIRED_SUPPRESSED_SERVER_MESSAGE_TYPES: ReadonlyArray<string>;
export declare function projectServerMessageForClient(client: ClientScopeFlags | null | undefined, message: unknown): ServerMessage | null;
export declare function projectSerializedServerMessageForClient(client: ClientScopeFlags | null | undefined, payload: string): string | null;
export {};
