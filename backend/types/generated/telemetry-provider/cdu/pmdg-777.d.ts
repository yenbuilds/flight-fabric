import type { CduSide } from './types.js';
import { type PmdgTransportOptions } from './pmdg-shared.js';
/** 777X SDK: ordinary keys start at 328; FMC COMM is the separate 3471 event. */
export declare function pmdg777CduEvent(side: CduSide, key: string): string | null;
export declare function createPmdg777Cdu(options: PmdgTransportOptions): import("./types.js").CduAdapter;
