import type { CduAdapter, CduCell, CduScreen } from './types.js';
/** Interpret the small, bounded SimBridge text format as cells, never HTML. */
export declare function parseFbwText(raw: string, small?: boolean): CduCell[];
export declare function decodeFbwScreen(raw: unknown): CduScreen | null;
export declare function createFbwCdu({ createSocket, now }?: {
    createSocket?: () => any;
    now?: () => number;
}): CduAdapter;
