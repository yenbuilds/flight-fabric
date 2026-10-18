import type { GuardedDisplayEntryRecipe } from './guarded-display-entry-contract.js';

const WebSocket = require('ws');
// Transport protocol, not an aircraft recipe. Definitions cannot supply a URL
// or arbitrary protocol messages; only numeric keys and a validated line key.
const SIMBRIDGE_MCDU_URL = 'ws://127.0.0.1:8380/interfaces/v1/mcdu';

function plain(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\{[^}]*\}/g, '').replace(/\[color\].*$/, '').replace(/\s+/g, ' ').trim() : '';
}

export function readDisplayEntryPage(raw: unknown, recipe: GuardedDisplayEntryRecipe) {
  const page = raw as Record<string, any> | null;
  const title = plain(page?.title);
  const layout = recipe.page;
  if (!(title === layout.titlePrefix || title.startsWith(`${layout.titlePrefix} `))
    || !Array.isArray(page?.lines) || page.lines.length !== layout.rowCount || typeof page.scratchpad !== 'string'
    || ![...layout.labels, ...Object.values(layout.fields)].every(cell =>
      Array.isArray(page.lines[cell.row]) && typeof page.lines[cell.row][cell.column] === 'string')
    || layout.labels.some(cell => plain(page.lines[cell.row][cell.column]) !== cell.equals)) return null;
  return { title, scratchpad: plain(page.scratchpad), fields: Object.fromEntries(Object.entries(layout.fields).map(([id, cell]) => {
    const value = plain(page.lines[cell.row][cell.column]);
    return [id, cell.equals === undefined ? value : value === cell.equals];
  })) };
}

/** Guarded, observed text entry. Never navigate, clear pilot input or retry a key. */
export async function executeGuardedDisplayEntry({ recipe, value, isCurrent,
  createSocket = () => new WebSocket(SIMBRIDGE_MCDU_URL, {
    handshakeTimeout: recipe.timing.handshakeTimeoutMs, maxPayload: recipe.timing.maxPayload,
  }),
  timeoutMs = recipe.timing.timeoutMs, stepTimeoutMs = recipe.timing.stepTimeoutMs,
}: {
  recipe: GuardedDisplayEntryRecipe; value: unknown; isCurrent: () => boolean;
  createSocket?: () => any; timeoutMs?: number; stepTimeoutMs?: number;
}) {
  const { input, messages, timing } = recipe;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < input.min || value > input.max) {
    return { ok: false, code: 'invalid_value', error: messages.invalidValue, executionStarted: false };
  }
  let socket: any, failure = '', executionStarted = false, sequence = 0, lastUpdate = 0, lastScreenChange = 0;
  let screen: ReturnType<typeof readDisplayEntryPage> = null;
  let expectedEcho: string | null = null;
  const deadline = Date.now() + timeoutMs;
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error(messages.stale);
    if (failure) throw new Error(failure);
    if (Date.now() > deadline) throw new Error(messages.timeout);
  };
  const waitFor = async (test: () => boolean, message: string) => {
    const until = Math.min(deadline, Date.now() + stepTimeoutMs);
    while (true) {
      assertCurrent();
      if (test()) return;
      if (Date.now() >= until) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, timing.pollMs));
    }
  };
  try {
    assertCurrent();
    socket = createSocket();
    socket.on('error', () => { failure = messages.unavailable; });
    socket.on('close', () => { failure = messages.disconnected; });
    socket.on('message', (data: any) => {
      const message = String(data);
      if (message.startsWith('event:')) {
        if (message === expectedEcho) expectedEcho = null;
        else failure = messages.interference;
      }
      if (!message.startsWith('update:')) return;
      try {
        const next = readDisplayEntryPage(JSON.parse(message.slice(7))[recipe.channel], recipe);
        if (JSON.stringify(next) !== JSON.stringify(screen)) lastScreenChange = Date.now();
        screen = next; sequence++; lastUpdate = Date.now();
      } catch { failure = messages.invalidPage; }
    });
    await waitFor(() => socket.readyState === 1, messages.connectTimeout);
    socket.send('requestUpdate');
    // Repeated unchanged updates prove freshness without restarting settling.
    const stablePage = () => screen !== null && Date.now() - lastScreenChange >= timing.settleMs
      && Date.now() - lastUpdate <= timing.freshnessMs;
    await waitFor(stablePage, messages.pageRequired);
    const initial = screen!;
    if (initial.scratchpad) throw new Error(messages.scratchpadOccupied);
    const available = () => !recipe.availableWhen
      || screen!.fields[recipe.availableWhen.fieldId] === recipe.availableWhen.expectedValue;
    if (!available()) throw new Error(messages.fieldUnavailable);
    const samePage = () => stablePage() && screen!.title === initial.title && available();
    const cleared = (value: string | boolean) => typeof value === 'string' && (value === '' || /^\[\s*\]$/.test(value));
    const matches = () => samePage() && screen!.scratchpad === '' && screen!.fields[recipe.valueField] === String(value)
      && recipe.clearFieldIds.every(id => cleared(screen!.fields[id]));
    if (matches()) return { ok: true, noOp: true, confirmedValue: value, executionStarted: false };
    let prefix = '';
    for (const digit of String(value)) {
      assertCurrent();
      if (!samePage() || screen!.scratchpad !== prefix) throw new Error(messages.entryChanged);
      const baseline = sequence;
      expectedEcho = `event:${recipe.channel}:${digit}`;
      executionStarted = true;
      socket.send(expectedEcho);
      prefix += digit;
      await waitFor(() => sequence > baseline && samePage() && screen!.scratchpad === prefix, messages.digitUnconfirmed);
    }
    assertCurrent();
    if (!samePage() || screen!.scratchpad !== String(value)) throw new Error(messages.commitChanged);
    const baseline = sequence;
    expectedEcho = `event:${recipe.channel}:${recipe.confirmKey}`;
    socket.send(expectedEcho);
    await waitFor(() => sequence > baseline && matches(), messages.unconfirmed);
    return { ok: true, confirmedValue: value, executionStarted: true };
  } catch (error) {
    return { ok: false, code: 'entry_unconfirmed', error: error instanceof Error ? error.message : messages.failed, executionStarted };
  } finally {
    if (socket) socket.terminate();
  }
}
