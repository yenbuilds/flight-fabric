import type { CduKey, CduScreen, CduSide } from '../../../packages/telemetry-types/src/cdu.js';
export type { CduCell, CduColor, CduKey, CduScreen, CduSide } from '../../../packages/telemetry-types/src/cdu.js';
export interface CduAdapter {
    label: string;
    setup: string;
    functionKeys: CduKey[];
    entryKeys: CduKey[];
    read(side: CduSide): Promise<CduScreen | null>;
    press(side: CduSide, key: string, isCurrent: () => boolean): Promise<void>;
    dispose(): Promise<void>;
}
export declare const lineKeys: string[];
export declare const keys: (ids: string[]) => CduKey[];
export declare const letters: string[];
