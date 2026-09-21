import type { CduSide } from './types.js';
import { keys, letters, lineKeys } from './types.js';
import { createPmdgTransport, type PmdgTransportOptions } from './pmdg-shared.js';
export { decodePmdgScreen } from './pmdg-shared.js';

const functions = ['INIT_REF', 'RTE', 'CLB', 'CRZ', 'DES', 'MENU', 'LEGS', 'DEP_ARR', 'HOLD', 'PROG', 'EXEC', 'N1_LIMIT', 'FIX', 'PREV_PAGE', 'NEXT_PAGE'];
const entries = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'DOT', '0', 'PLUS_MINUS', ...letters, 'SPACE', 'DEL', 'SLASH', 'CLR'];
const eventKeys = [...lineKeys, ...functions, ...entries];

/** PMDG NG3 SDK's contiguous key events (left 534..602, right 606..674). */
export function pmdgCduEvent(side: CduSide, key: string): string | null {
  const index = eventKeys.indexOf(key);
  return index < 0 || !['left', 'right'].includes(side) ? null : `#${69632 + (side === 'left' ? 534 : 606) + index}`;
}

export function createPmdgCdu(options: PmdgTransportOptions) {
  return createPmdgTransport({
    channelPrefix: 'pmdg-737-cdu', label: 'PMDG 737 CDU', event: pmdgCduEvent,
    setup: 'In PMDG’s 737_Options.ini (737NG3_Options.ini on older versions), under [SDK], set EnableDataBroadcast=1, EnableCDUBroadcast.0=1 and EnableCDUBroadcast.1=1. Reload the aircraft and power the CDU.',
    functionKeys: keys(functions), entryKeys: keys([...letters, 'SPACE', 'DEL', 'SLASH', 'CLR', ...entries.slice(0, 12)]),
  }, options);
}
