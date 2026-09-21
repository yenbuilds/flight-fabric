import type { CduSide } from './types.js';
import { type PmdgTransportOptions } from './pmdg-shared.js';
export { decodePmdgScreen } from './pmdg-shared.js';
/** PMDG NG3 SDK's contiguous key events (left 534..602, right 606..674). */
export declare function pmdgCduEvent(side: CduSide, key: string): string | null;
export declare function createPmdgCdu(options: PmdgTransportOptions): import("./types.js").CduAdapter;
