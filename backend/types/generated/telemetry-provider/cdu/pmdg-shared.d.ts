import type { CduAdapter, CduScreen, CduSide } from './types.js';
/** Shared 737/777 SDK layout: 24 columns, 14 rows, three bytes per cell, power byte. */
export declare function decodePmdgScreen(raw: unknown): CduScreen | null;
type Bridge = {
    start(): Promise<void>;
    connect(target: {
        channel: string;
    } | null): void;
    getSnapshot(): {
        raw?: Record<string, unknown>;
        error?: string;
    };
    isDataConnected(): boolean;
    stop(): Promise<void>;
};
export type PmdgTransportOptions = {
    sendEvent: (name: string, value: number) => Promise<{
        ok: boolean;
        error?: string;
    }>;
    createBridge?: (side: CduSide) => Bridge;
    now?: () => number;
};
type PmdgSpec = Pick<CduAdapter, 'label' | 'setup' | 'functionKeys' | 'entryKeys'> & {
    channelPrefix: string;
    event: (side: CduSide, key: string) => string | null;
};
export declare function createPmdgTransport(spec: PmdgSpec, { sendEvent, now, createBridge }: PmdgTransportOptions): CduAdapter;
export {};
