import type { CduAdapter, CduCell, CduColor, CduScreen, CduSide } from './types.js';
import { keys, letters } from './types.js';
const WebSocket = require('ws');

const colors = new Set(['white', 'cyan', 'green', 'magenta', 'amber', 'red', 'yellow']);

/** Interpret the small, bounded SimBridge text format as cells, never HTML. */
export function parseFbwText(raw: string, small = false): CduCell[] {
  const [text, suffix] = raw.split('[color]');
  const base: Omit<CduCell, 'text'> = { color: colors.has(suffix) ? suffix as CduColor : 'white', small };
  let style = { ...base };
  const stack: typeof style[] = [];
  const cells: CduCell[] = [];
  for (const token of text.split(/(\{[^}]*\})/)) {
    if (token === '{sp}') cells.push({ text: ' ', ...style });
    else if (token === '{end}') style = stack.pop() || { ...base };
    else if (/^\{.*\}$/.test(token)) {
      const tag = token.slice(1, -1);
      stack.push({ ...style });
      if (colors.has(tag)) style.color = tag as CduColor;
      else if (tag === 'small' || tag === 'big') style.small = tag === 'small';
      else if (tag === 'inop') style.dim = true;
    } else for (const character of token) cells.push({ text: character, ...style });
    if (cells.length >= 24) break;
  }
  return cells.slice(0, 24);
}

export function decodeFbwScreen(raw: unknown): CduScreen | null {
  const page = raw as Record<string, any> | null;
  if (!page || typeof page.title !== 'string' || typeof page.scratchpad !== 'string'
      || !Array.isArray(page.lines) || page.lines.length !== 12
      || !page.lines.every((line: unknown) => Array.isArray(line) && line.length <= 3
        && line.every(value => typeof value === 'string' && value.length <= 2048))) return null;
  if ([page.title, page.scratchpad, page.titleLeft ?? '', page.page ?? ''].some(value => typeof value !== 'string' || value.length > 2048)) return null;
  const row = (parts: string[], small = false) => {
    const cells: CduCell[] = Array.from({ length: 24 }, () => ({ text: ' ', color: 'white' }));
    for (const index of [2, 0, 1]) {
      const content = parseFbwText(parts[index] || '', small);
      const start = index === 1 ? 24 - content.length : index === 2 ? Math.floor((24 - content.length) / 2) : 0;
      content.forEach((cell, offset) => { cells[start + offset] = cell; });
    }
    return cells;
  };
  const rows = [row([page.titleLeft || '', page.page || '', page.title]),
    ...page.lines.map((parts: string[], index: number) => row(parts, index % 2 === 0)), row([page.scratchpad])];
  // The protocol sends an empty screen with brightness zero when unpowered.
  const powered = typeof page.displayBrightness === 'number' ? page.displayBrightness > 0
    : rows.some(line => line.some(cell => cell.text.trim()));
  const arrows = ['↑', '↓', '←', '→'].filter((_, index) => page.arrows?.[index] === true);
  const names = ['fmgc', 'fail', 'mcdu_menu', 'fm1', 'ind', 'rdy', 'fm2'];
  return { powered: Boolean(powered), rows, arrows, annunciators: names.filter(name => page.annunciators?.[name] === true).map(name => name.replaceAll('_', ' ').toUpperCase()) };
}

export function createFbwCdu({ createSocket = () => new WebSocket('ws://127.0.0.1:8380/interfaces/v1/mcdu',
  { handshakeTimeout: 1500, maxPayload: 65536 }), now = Date.now } = {}): CduAdapter {
  let socket: any = null;
  let pages: Record<CduSide, CduScreen | null> = { left: null, right: null };
  let updatedAt = 0, requestedAt = 0;
  let disposed = false;
  const setup = 'Start FlyByWire SimBridge on this PC (port 8380), enable SimBridge in the aircraft EFB, and power the MCDU.';
  function connect() {
    if (socket || disposed) return;
    const current = createSocket();
    socket = current;
    const clear = () => { if (socket === current) { socket = null; pages = { left: null, right: null }; updatedAt = 0; } };
    current.on('error', () => { clear(); current.terminate(); });
    current.on('close', clear);
    current.on('open', () => { if (!disposed && socket === current) current.send('requestUpdate'); });
    current.on('message', (data: unknown) => {
      if (disposed || socket !== current || !String(data).startsWith('update:')) return;
      try {
        const update = JSON.parse(String(data).slice(7));
        pages = { left: decodeFbwScreen(update.left), right: decodeFbwScreen(update.right) };
        updatedAt = now();
      } catch { pages = { left: null, right: null }; updatedAt = 0; }
    });
  }
  return {
    label: 'FlyByWire A32NX MCDU', setup,
    functionKeys: keys(['DIR', 'PROG', 'PERF', 'INIT', 'DATA', 'FPLN', 'RAD', 'FUEL', 'SEC', 'ATC', 'MENU', 'AIRPORT', 'PREVPAGE', 'NEXTPAGE', 'UP', 'DOWN']),
    entryKeys: keys([...letters, 'SP', 'DIV', 'OVFY', 'CLR', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'DOT', '0', 'PLUSMINUS']),
    async read(side) {
      connect();
      if (socket?.readyState === 1 && now() - requestedAt >= 500) { requestedAt = now(); socket.send('requestUpdate'); }
      return socket?.readyState === 1 && now() - updatedAt <= 2500 ? pages[side] : null;
    },
    async press(side, key, isCurrent) {
      if (!isCurrent() || socket?.readyState !== 1 || now() - updatedAt > 2500 || !pages[side]?.powered) throw new Error('MCDU connection or screen is unavailable.');
      // The echo confirms delivery to SimBridge, not acceptance by the FMGC.
      await new Promise<void>((resolve, reject) => socket.send(`event:${side}:${key}`, (error: Error | undefined) => error ? reject(error) : resolve()));
    },
    async dispose() { disposed = true; const current = socket; socket = null; pages = { left: null, right: null }; current?.terminate(); },
  };
}
