import type { CduSide } from './types.js';
import { keys, letters, lineKeys } from './types.js';
import { createPmdgTransport, type PmdgTransportOptions } from './pmdg-shared.js';

const functions = ['INIT_REF', 'RTE', 'DEP_ARR', 'ALTN', 'VNAV', 'FIX', 'LEGS', 'HOLD', 'FMC_COMM', 'PROG', 'EXEC', 'MENU', 'NAV_RAD', 'PREV_PAGE', 'NEXT_PAGE'];
const entries = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'DOT', '0', 'PLUS_MINUS', ...letters, 'SPACE', 'DEL', 'SLASH', 'CLR'];
const eventKeys = [...lineKeys, ...functions.filter(key => key !== 'FMC_COMM'), ...entries];

/** 777X SDK: ordinary keys start at 328; FMC COMM is the separate 3471 event. */
export function pmdg777CduEvent(side: CduSide, key: string): string | null {
  if (!['left', 'right'].includes(side)) return null;
  const index = eventKeys.indexOf(key);
  if (index < 0 && key !== 'FMC_COMM') return null;
  const offset = key === 'FMC_COMM' ? (side === 'right' ? 4201 : 3471) : (side === 'right' ? 401 : 328) + index;
  return `#${69632 + offset}`;
}

export function createPmdg777Cdu(options: PmdgTransportOptions) {
  return createPmdgTransport({
    channelPrefix: 'pmdg-777-cdu', label: 'PMDG 777 CDU', event: pmdg777CduEvent,
    setup: 'In PMDG’s 777_Options.ini, under [SDK], set EnableDataBroadcast=1, EnableCDUBroadcast.0=1 and EnableCDUBroadcast.1=1. Reload the aircraft and power the CDU.',
    functionKeys: keys(functions), entryKeys: keys([...letters, 'SPACE', 'DEL', 'SLASH', 'CLR', ...entries.slice(0, 12)]),
  }, options);
}
