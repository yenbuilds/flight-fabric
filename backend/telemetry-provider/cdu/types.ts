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

export const lineKeys = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6'];
export const keys = (ids: string[]): CduKey[] => ids.map(id => ({ id, label: id.replaceAll('_', ' ') }));
export const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
