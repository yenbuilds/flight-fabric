const WebSocket = require('ws');
import { MINIMUMS_INPUTS } from '../aircraft/aircraft-integrations/fbw-a32nx/minimums.js';

const A32NX_MCDU_URL = 'ws://127.0.0.1:8380/interfaces/v1/mcdu';

function plain(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\{[^}]*\}/g, '').replace(/\[color\].*$/, '').replace(/\s+/g, ' ').trim() : '';
}

export function readMinimumsPage(raw: unknown) {
  const page = raw as Record<string, any> | null;
  const title = plain(page?.title);
  if (!/^APPR(?: |$)/.test(title) || !Array.isArray(page?.lines) || page.lines.length !== 12
      || typeof page.scratchpad !== 'string'
      || ![2, 3, 4, 5].every((row) => Array.isArray(page.lines[row]) && typeof page.lines[row][1] === 'string')
      || plain(page.lines[2]?.[1]) !== 'BARO') return null;
  return { title, scratchpad: plain(page.scratchpad), baro: plain(page.lines[3]?.[1]),
    radio: plain(page.lines[5]?.[1]), radioAvailable: plain(page.lines[4]?.[1]) === 'RADIO' };
}

/** SimBridge's documented remote MCDU keys edit FMGC performance data, not output LVARs.
 * Require the pilot's active PERF APPR page and empty scratchpad. Never navigate,
 * clear a pilot entry, retry a key, or continue after profile/input interference.
 */
export async function executeA32nxMinimums({ target, value, isCurrent,
  createSocket = () => new WebSocket(A32NX_MCDU_URL, { handshakeTimeout: 1500, maxPayload: 65536 }),
  timeoutMs = 9000, stepTimeoutMs = 1600,
}: {
  target: 'baro' | 'radio'; value: unknown; isCurrent: () => boolean;
  createSocket?: () => any; timeoutMs?: number; stepTimeoutMs?: number;
}) {
  const input = MINIMUMS_INPUTS[target];
  if (!input || typeof value !== 'number' || !Number.isInteger(value) || value < input.min || value > input.max) {
    return { ok: false, code: 'invalid_value', error: 'Minimums require whole feet within the published range.', executionStarted: false };
  }
  let socket: any, failure = '', executionStarted = false, sequence = 0, lastUpdate = 0;
  let lastScreenChange = 0;
  let screen: ReturnType<typeof readMinimumsPage> = null;
  let expectedEcho: string | null = null;
  const deadline = Date.now() + timeoutMs;
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error('Aircraft changed or simulator disconnected. Minimums were not confirmed.');
    if (failure) throw new Error(failure);
    if (Date.now() > deadline) throw new Error('MCDU timed out. Check the entry before trying again.');
  };
  const waitFor = async (test: () => boolean, message: string) => {
    const until = Math.min(deadline, Date.now() + stepTimeoutMs);
    while (true) {
      assertCurrent();
      if (test()) return;
      if (Date.now() >= until) throw new Error(message);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  try {
    assertCurrent();
    socket = createSocket();
    socket.on('error', () => { failure = 'FlyByWire SimBridge is unavailable. Start it on this PC using port 8380 and enable it in the EFB.'; });
    socket.on('close', () => { failure = 'MCDU disconnected. Check minimums in the aircraft.'; });
    socket.on('message', (data: any) => {
      const message = String(data);
      if (message.startsWith('event:')) {
        if (message === expectedEcho) expectedEcho = null;
        else failure = 'Another MCDU input interrupted minimums entry. Check the scratchpad and minimums.';
      }
      if (!message.startsWith('update:')) return;
      try {
        const next = readMinimumsPage(JSON.parse(message.slice(7)).left);
        if (JSON.stringify(next) !== JSON.stringify(screen)) lastScreenChange = Date.now();
        screen = next; sequence++; lastUpdate = Date.now();
      }
      catch { failure = 'The MCDU returned an invalid page. Minimums were not confirmed.'; }
    });
    await waitFor(() => socket.readyState === 1, 'FlyByWire SimBridge did not connect on port 8380.');
    socket.send('requestUpdate');
    // Other remote clients can request repeated updates. Only an actual change
    // to the entry/page restarts settling; every update still proves freshness.
    const stablePage = () => screen !== null && Date.now() - lastScreenChange >= 50 && Date.now() - lastUpdate <= 2000;
    await waitFor(stablePage, 'Open the active PERF APPR page on the powered captain MCDU, with an empty scratchpad.');
    const initial = screen!;
    if (initial.scratchpad) throw new Error('Clear the MCDU scratchpad before setting minimums.');
    if (target === 'radio' && !initial.radioAvailable) throw new Error('RADIO minimums are unavailable for this approach. Use BARO or select an ILS approach.');
    const samePage = () => stablePage() && screen!.title === initial.title
      && (target !== 'radio' || screen!.radioAvailable);
    const cleared = (text: string) => text === '' || /^\[\s*\]$/.test(text);
    const matches = () => samePage() && screen!.scratchpad === '' && screen![target] === String(value)
      && cleared(screen![target === 'baro' ? 'radio' : 'baro']);
    if (matches()) return { ok: true, noOp: true, confirmedValue: value, executionStarted: false };
    let prefix = '';
    for (const digit of String(value)) {
      assertCurrent();
      if (!samePage() || screen!.scratchpad !== prefix) throw new Error('MCDU page or scratchpad changed. Check the entry before trying again.');
      const baseline = sequence;
      expectedEcho = `event:left:${digit}`;
      executionStarted = true;
      socket.send(expectedEcho);
      prefix += digit;
      await waitFor(() => sequence > baseline && samePage() && screen!.scratchpad === prefix,
        'MCDU digit entry was not confirmed. Check the scratchpad before trying again.');
    }
    assertCurrent();
    if (!samePage() || screen!.scratchpad !== String(value)) throw new Error('MCDU changed before minimums could be entered.');
    const baseline = sequence;
    expectedEcho = `event:left:${target === 'baro' ? 'R2' : 'R3'}`;
    socket.send(expectedEcho);
    await waitFor(() => sequence > baseline && matches(), 'Minimums were not confirmed. Check PERF APPR for an out-of-range or invalid entry.');
    return { ok: true, confirmedValue: value, executionStarted: true };
  } catch (error) {
    return { ok: false, code: 'minimums_unconfirmed', error: error instanceof Error ? error.message : 'Minimums were not confirmed.', executionStarted };
  } finally {
    if (socket) socket.terminate();
  }
}
