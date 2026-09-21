import type { BaseCommand } from './commands.js';

/** Remote display only; the aircraft remains responsible for all FMC calculations. */
export type CduSide = 'left' | 'right';
export type CduColor = 'white' | 'cyan' | 'green' | 'magenta' | 'amber' | 'red' | 'yellow';
export interface CduCell {
  text: string;
  color: CduColor;
  small?: boolean;
  reverse?: boolean;
  dim?: boolean;
}
export interface CduScreen {
  powered: boolean;
  rows: CduCell[][];
  annunciators?: string[];
  arrows?: string[];
}
export interface CduKey { id: string; label: string }
export interface CduState {
  type: 'cduState';
  requestId: string;
  ok: boolean;
  error?: string;
  profileKey?: string;
  profileRevision?: number;
  integrationId?: string;
  side?: CduSide;
  sessionId?: string;
  label?: string;
  mode?: 'external' | 'integrated';
  externalPort?: number;
  setup?: string;
  screen?: CduScreen | null;
  functionKeys?: CduKey[];
  entryKeys?: CduKey[];
}
export interface CduRequest extends BaseCommand {
  type: 'requestCduState' | 'sendCduKey';
  requestId: string;
  profileKey: string;
  profileRevision: number;
  side: CduSide;
  sessionId?: string;
  key?: string;
}
