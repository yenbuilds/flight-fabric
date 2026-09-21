import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createCduSession } from './session.js';
import { createProviderCdu } from './provider.js';
import { createFbwCdu, decodeFbwScreen, parseFbwText } from './fbw-a32nx.js';
import { createPmdgCdu, decodePmdgScreen, pmdgCduEvent } from './pmdg-737.js';
import { createPmdg777Cdu, pmdg777CduEvent } from './pmdg-777.js';
import { isClientMessageAuthorized } from '../../core/client-message-authorization.js';
import type { CduAdapter } from './types.js';
import type { CduRequest } from '../../../packages/telemetry-types/src/cdu.js';
const { WebSocket, WebSocketServer } = require('ws') as typeof import('ws');

test('PMDG decodes column-major cells, colors, flags, special symbols and power', () => {
  const raw = Array(1009).fill(0); raw[1008] = 1;
  raw[(23 * 14 + 13) * 3] = 0xa4;
  raw[(23 * 14 + 13) * 3 + 1] = 4;
  raw[(23 * 14 + 13) * 3 + 2] = 7;
  const screen = decodePmdgScreen(raw)!;
  assert.equal(screen.rows.length, 14); assert.equal(screen.rows[0].length, 24);
  assert.equal(screen.powered, true);
  assert.deepEqual(screen.rows[13][23], { text: '↓', color: 'amber', small: true, reverse: true, dim: true });
  raw[1008] = 0; assert.equal(decodePmdgScreen(raw)?.powered, false);
  assert.equal(decodePmdgScreen(raw.slice(1)), null);
  raw[2] = 256; assert.equal(decodePmdgScreen(raw), null);
});

test('PMDG keys map to the published left and right SDK events', () => {
  assert.equal(pmdgCduEvent('left', 'L1'), '#70166');
  assert.equal(pmdgCduEvent('left', 'EXEC'), '#70188');
  assert.equal(pmdgCduEvent('left', 'CLR'), '#70234');
  assert.equal(pmdgCduEvent('right', 'CLR'), '#70306');
  assert.equal(pmdgCduEvent('right', '#70188'), null);
});

test('FlyByWire text preserves nested styling and treats markup as text', () => {
  const cells = parseFbwText('{small}A{cyan}B{end}C{end}D[color]green');
  assert.deepEqual(cells.map(c => [c.text, c.color, c.small]), [['A', 'green', true], ['B', 'cyan', true], ['C', 'green', true], ['D', 'green', false]]);
  assert.equal(parseFbwText('<img src=x>').map(c => c.text).join(''), '<img src=x>');
  assert.equal(parseFbwText('X'.repeat(100)).length, 24);
});

test('777 SDK key mapping keeps its different function layout and separate FMC COMM events', () => {
  assert.equal(pmdg777CduEvent('left', 'L1'), '#69960');
  assert.equal(pmdg777CduEvent('right', 'L1'), '#70033');
  assert.equal(pmdg777CduEvent('left', 'VNAV'), '#69976');
  assert.equal(pmdg777CduEvent('left', 'EXEC'), '#69981');
  assert.equal(pmdg777CduEvent('left', 'NAV_RAD'), '#69983');
  assert.equal(pmdg777CduEvent('left', 'CLR'), '#70027');
  assert.equal(pmdg777CduEvent('right', 'CLR'), '#70100');
  assert.equal(pmdg777CduEvent('left', 'FMC_COMM'), '#73103');
  assert.equal(pmdg777CduEvent('right', 'FMC_COMM'), '#73833');
  assert.equal(pmdg777CduEvent('left', 'N1_LIMIT'), null);
  assert.equal(pmdg777CduEvent('left', '#69981'), null);
});

test('777 uses its own screen channels and does not send keys before powered data arrives', async () => {
  const raw = Array(1009).fill(0);
  let connected = false;
  const targets: string[] = [], writes: unknown[] = [], stopped: string[] = [];
  const adapter = createPmdg777Cdu({
    createBridge: side => ({ async start() {}, connect(target) { targets.push(target!.channel); },
      isDataConnected: () => connected, getSnapshot: () => ({ raw: { screen: raw } }), async stop() { stopped.push(side); } }),
    async sendEvent(name, value) { writes.push([name, value]); return { ok: true }; },
  });
  try {
    assert.equal(await adapter.read('left'), null);
    connected = true;
    assert.equal((await adapter.read('right'))?.powered, false);
    await assert.rejects(adapter.press('right', 'EXEC', () => true), /unavailable/);
    assert.deepEqual(writes, []);
    raw[1008] = 1;
    assert.equal((await adapter.read('right'))?.rows.length, 14);
    await adapter.press('right', 'FMC_COMM', () => true);
    assert.deepEqual(writes, [['#73833', 0x20000000], ['#73833', 0x00020000]]);
    assert.deepEqual(targets, ['pmdg-777-cdu-left', 'pmdg-777-cdu-right']);
  } finally { await adapter.dispose(); }
  assert.deepEqual(stopped, ['left', 'right']);
});
const fbwPage = () => ({ title: 'APPR', titleLeft: '', page: '{small}1/2{end}', scratchpad: '{cyan}123{end}',
  lines: Array.from({ length: 12 }, () => ['', '', '']), displayBrightness: 1, arrows: [false, false, true, false] });
test('FlyByWire aligns left/right/centre, keeps scratchpad and rejects malformed screens', () => {
  const page = fbwPage(); page.lines[0] = ['LEFT', 'RIGHT', 'MID'];
  const result = decodeFbwScreen(page)!;
  assert.equal(result.rows[1].map(c => c.text).join(''), 'LEFT      MID      RIGHT');
  assert.equal(result.rows[13].slice(0, 3).map(c => c.text).join(''), '123');
  assert.deepEqual(result.arrows, ['←']);
  assert.equal(decodeFbwScreen({ ...page, lines: [] }), null);
  assert.equal(decodeFbwScreen({ ...page, displayBrightness: 0 })?.powered, false);
});

test('SimBridge adapter connects lazily, requests freshness, sends one key and invalidates on close', async () => {
  class Socket extends EventEmitter {
    readyState = 0; sent: string[] = [];
    send(value: string, callback?: () => void) { this.sent.push(value); callback?.(); }
    terminate() { this.readyState = 3; this.emit('close'); }
  }
  const socket = new Socket(); let time = 1000;
  const adapter = createFbwCdu({ createSocket: () => socket, now: () => time });
  assert.equal(await adapter.read('left'), null);
  socket.readyState = 1; socket.emit('open');
  socket.emit('message', `update:${JSON.stringify({ left: fbwPage(), right: fbwPage() })}`);
  assert.equal((await adapter.read('right'))?.powered, true);
  await adapter.press('right', 'A', () => true);
  assert.equal(socket.sent.filter(s => s.startsWith('event:')).join(), 'event:right:A');
  time += 3000;
  assert.equal(await adapter.read('left'), null);
  await assert.rejects(adapter.press('left', 'B', () => true), /unavailable/);
  await adapter.dispose(); assert.equal(socket.readyState, 3);
});

test('PMDG bridge starts once per viewed side; sends press then release and disposes both', async () => {
  const raw = Array(1009).fill(0); raw[1008] = 1;
  const calls: unknown[] = [];
  const adapter = createPmdgCdu({
    createBridge: side => ({ async start() { calls.push(`start:${side}`); }, connect(target) { calls.push(target); },
      isDataConnected: () => true, getSnapshot: () => ({ raw: { screen: raw } }), async stop() { calls.push(`stop:${side}`); } }),
    async sendEvent(name, value) { calls.push([name, value]); return { ok: true }; },
  });
  await Promise.all([adapter.read('left'), adapter.read('left')]); await adapter.read('right');
  assert.equal(calls.filter(c => c === 'start:left').length, 1);
  await adapter.press('right', 'EXEC', () => true);
  assert.deepEqual(calls.slice(-2), [['#70260', 0x20000000], ['#70260', 0x00020000]]);
  await assert.rejects(adapter.press('left', 'UNKNOWN', () => true));
  await adapter.dispose(); assert.deepEqual(calls.slice(-2), ['stop:left', 'stop:right']);
});

test('A32NX receives both MCDUs and sends the selected-unit key over a real WebSocket', { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/interfaces/v1/mcdu' });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const received: string[] = [];
  let resolveKey!: () => void;
  const keyReceived = new Promise<void>(resolve => { resolveKey = resolve; });
  server.on('connection', connection => connection.on('message', value => {
    const text = String(value); received.push(text);
    if (text === 'requestUpdate') connection.send(`update:${JSON.stringify({ left: fbwPage(), right: { ...fbwPage(), title: 'RIGHT APPR' } })}`);
    if (text === 'event:right:R2') resolveKey();
  }));
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/interfaces/v1/mcdu`);
  const adapter = createFbwCdu({ createSocket: () => socket });
  try {
    const update = once(socket, 'message');
    assert.equal(await adapter.read('left'), null);
    await update;
    assert.equal((await adapter.read('left'))?.powered, true);
    assert.match((await adapter.read('right'))!.rows[0].map(cell => cell.text).join(''), /RIGHT APPR/);
    await adapter.press('right', 'R2', () => true);
    await keyReceived;
    assert.equal(received.filter(message => message.startsWith('event:')).length, 1);
    const closed = once(socket, 'close'); socket.terminate(); await closed;
    await assert.rejects(adapter.press('right', 'A', () => true), /unavailable/);
  } finally {
    await adapter.dispose();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('session gates permissions, key allowlist, generation and transport ownership', async () => {
  let context = { profileKey: 'bundled/msfs/fbw-a32nx', profileRevision: 1, integrationId: 'fbw-a32nx', connected: true };
  const presses: string[] = []; let stops = 0;
  const adapter: CduAdapter = { label: 'test', setup: '', functionKeys: [], entryKeys: [{ id: 'A', label: 'A' }],
    async read() { return { powered: true, rows: [] }; }, async press(side, key, valid) { assert.ok(valid()); presses.push(`${side}:${key}`); }, async dispose() { stops++; } };
  const session = createCduSession({ context: () => context, createAdapter: () => adapter });
  const request: CduRequest = { type: 'requestCduState', requestId: 'test', profileKey: context.profileKey, profileRevision: 1, side: 'left' };
  try {
    const state = await session.request(request);
    const key: CduRequest = { ...request, type: 'sendCduKey', key: 'A', sessionId: state.sessionId };
    await assert.rejects(session.request(key), /connection changed/);
    await assert.rejects(session.request({ ...key, key: 'A:event:left:EXEC' }, () => true), /Invalid/);
    await session.request(key, () => true); assert.deepEqual(presses, ['left:A']);
    context = { ...context, profileRevision: 2 };
    await assert.rejects(session.request(key, () => true), /Aircraft changed/);
    await session.request({ ...request, profileRevision: 2 }); assert.equal(stops, 1);
    await assert.rejects(session.request({ ...key, profileRevision: 2 }, () => true), /connection changed/);
  } finally { await session.dispose(); }
  assert.equal(stops, 2);
});

test('a failed adapter dispose is reported and does not block later sessions', async () => {
  let context = { profileKey: 'bundled/msfs/pmdg-737', profileRevision: 1, integrationId: 'pmdg-737', connected: true };
  const errors: unknown[] = []; const disposals: string[] = [];
  let created = 0;
  const createAdapter = (): CduAdapter => {
    const id = `adapter-${++created}`;
    return { label: id, setup: '', functionKeys: [], entryKeys: [],
      async read() { return { powered: true, rows: [] }; }, async press() {},
      async dispose() { disposals.push(id); if (id === 'adapter-1') throw new Error('sidecar did not exit'); } };
  };
  const session = createCduSession({ context: () => context, createAdapter, onError: (error) => errors.push(error) });
  const request: CduRequest = { type: 'requestCduState', requestId: 'test', profileKey: context.profileKey, profileRevision: 1, side: 'left' };
  await session.request(request);
  // The aircraft changes: the first adapter is disposed and that dispose rejects.
  context = { ...context, profileRevision: 2 };
  const second = await session.request({ ...request, profileRevision: 2 });
  assert.ok(second.sessionId, 'a later request still opens a fresh session');
  assert.equal(created, 2);
  assert.equal(errors.length, 1, 'the failed dispose is reported once');
  assert.match(String((errors[0] as Error).message), /sidecar did not exit/);
  context = { ...context, profileRevision: 3 };
  await session.request({ ...request, profileRevision: 3 });
  await session.dispose();
  assert.deepEqual(disposals, ['adapter-1', 'adapter-2', 'adapter-3'], 'every adapter after the failure is still disposed');
  assert.equal(errors.length, 1, 'later disposals succeed and add no errors');
});

test('an observed disconnect invalidates CDU keys before the cleanup timer runs', async () => {
  let context = { profileKey: 'bundled/msfs/fbw-a32nx', profileRevision: 1, integrationId: 'fbw-a32nx', connected: true };
  let disposals = 0, presses = 0;
  const session = createCduSession({ context: () => context, createAdapter: () => ({
    label: 'test', setup: '', functionKeys: [], entryKeys: [{ id: 'A', label: 'A' }],
    async read() { return { powered: true, rows: [] }; },
    async press() { presses++; }, async dispose() { disposals++; },
  }) });
  const request: CduRequest = { type: 'requestCduState', requestId: 'disconnect', profileKey: context.profileKey, profileRevision: 1, side: 'left' };
  try {
    const before = await session.request(request);
    context = { ...context, connected: false };
    await assert.rejects(session.request(request), /disconnected/);
    context = { ...context, connected: true };
    await assert.rejects(session.request({ ...request, type: 'sendCduKey', key: 'A', sessionId: before.sessionId }, () => true), /Reopen/);
    const after = await session.request(request);
    assert.notEqual(after.sessionId, before.sessionId);
    assert.equal(disposals, 1);
    assert.equal(presses, 0);
  } finally { await session.dispose(); }
});

for (const boundary of ['connection', 'aircraft', 'reader', 'writer', 'reader-process', 'writer-process'] as const) {
  test(`CDU ${boundary} generation changes invalidate pending and queued keys with the same profile`, async t => {
    const provider: Record<string, any> = { _connected: true, _simRunning: true, _systemState: { sim: 1 },
      _rustSimvarBridge: { _proc: {} }, _lvarBridge: { _proc: {} }, _autotaxiConnectionEpoch: 1, _rustControlReadbackNotBeforeMs: 1000 };
    const config = { profileKey: 'bundled/msfs/pmdg-737', profileRevision: 1, integrationId: 'pmdg-737' };
    let resume!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    const pressing = new Promise<void>(resolve => { entered = resolve; });
    let writes = 0, disposals = 0;
    t.mock.method(require('./pmdg-737.js'), 'createPmdgCdu', () => ({
      label: 'test', setup: '', functionKeys: [], entryKeys: [{ id: 'A', label: 'A' }],
      async read() { return { powered: true, rows: [] }; },
      async press(_side: string, _key: string, valid: () => boolean) {
        entered(); await waiting;
        if (!valid()) throw new Error('CDU ownership changed before the pending write.');
        writes++;
      },
      async dispose() { disposals++; },
    }));
    const session = createProviderCdu(provider, { getAircraftSpecificConfig: () => config });
    const request: CduRequest = { type: 'requestCduState', requestId: boundary, profileKey: config.profileKey, profileRevision: 1, side: 'left' };
    try {
      const before = await session.request(request);
      const key: CduRequest = { ...request, type: 'sendCduKey', key: 'A', sessionId: before.sessionId };
      const pending = session.request(key, () => true);
      await pressing;
      // No request or cleanup timer sees a disconnected context. The simulator
      // or one of its transports changes while the key awaits its next write.
      if (boundary === 'connection') provider._autotaxiConnectionEpoch++;
      else if (boundary === 'aircraft') provider._rustControlReadbackNotBeforeMs++;
      else if (boundary === 'reader') provider._rustSimvarBridge = {};
      else if (boundary === 'writer') provider._lvarBridge = {};
      else if (boundary === 'reader-process') provider._rustSimvarBridge._proc = {};
      else provider._lvarBridge._proc = {};
      resume();
      await assert.rejects(pending, /ownership changed/);
      await assert.rejects(session.request(key, () => true), /Reopen/);
      const after = await session.request(request);
      assert.notEqual(after.sessionId, before.sessionId);
      assert.equal(writes, 0);
      assert.equal(disposals, 1);
    } finally { resume(); await session.dispose(); }
  });
}

test('a PMDG key does not release through a restarted writer process', async t => {
  const createAdapter = createPmdgCdu;
  const raw = Array(1009).fill(0); raw[1008] = 1;
  const values: number[] = [];
  let disposals = 0;
  const writer = { _proc: {}, async sendSdkEvent(_name: string, value: number) {
    values.push(value);
    // LvarSidecarBridge.start() reuses the bridge while replacing its process.
    writer._proc = {};
    return { ok: true };
  } };
  const provider = { _connected: true, _simRunning: true, _systemState: { sim: 1 },
    _lvarBridge: writer, _rustSimvarBridge: {}, _autotaxiConnectionEpoch: 1,
    _rustControlReadbackNotBeforeMs: 1000, _bridgeMayBeLive: () => true };
  const config = { profileKey: 'bundled/msfs/pmdg-737', profileRevision: 1, integrationId: 'pmdg-737' };
  t.mock.method(require('./pmdg-737.js'), 'createPmdgCdu', options => createAdapter({ ...options,
    createBridge: () => ({ async start() {}, connect() {}, isDataConnected: () => true,
      getSnapshot: () => ({ raw: { screen: raw } }), async stop() { disposals++; } }),
  }));
  const session = createProviderCdu(provider, { getAircraftSpecificConfig: () => config });
  const request: CduRequest = { type: 'requestCduState', requestId: 'writer-restart', profileKey: config.profileKey, profileRevision: 1, side: 'left' };
  try {
    const before = await session.request(request);
    const key: CduRequest = { ...request, type: 'sendCduKey', key: 'A', sessionId: before.sessionId };
    await assert.rejects(session.request(key, () => true), /not confirmed/);
    assert.deepEqual(values, [0x20000000], 'neither release nor replay may reach the new writer process');
    await assert.rejects(session.request(key, () => true), /Reopen/);
    const after = await session.request(request);
    assert.notEqual(after.sessionId, before.sessionId);
    assert.equal(disposals, 1, 'the previous display adapter is cleaned up');
  } finally { await session.dispose(); }
});

test('an uncertain PMDG press still attempts release once without replaying the press', async () => {
  const raw = Array(1009).fill(0); raw[1008] = 1;
  const values: number[] = [];
  const adapter = createPmdgCdu({ createBridge: () => ({ async start() {}, connect() {}, isDataConnected: () => true,
    getSnapshot: () => ({ raw: { screen: raw } }), async stop() {} }),
    async sendEvent(_name, value) { values.push(value); if (value === 0x20000000) throw new Error('Lost acknowledgement'); return { ok: true }; } });
  await adapter.read('left');
  await assert.rejects(adapter.press('left', 'A', () => true), /not confirmed/);
  assert.deepEqual(values, [0x20000000, 0x00020000]);
  await adapter.dispose();
});

test('Fenix returns a launcher and refuses a direct key route', async () => {
  const context = { profileKey: 'bundled/msfs/fenix-a320', profileRevision: 1, integrationId: 'fenix-a32x', connected: true };
  const session = createCduSession({ context: () => context, createAdapter: () => { throw new Error('No adapter needed'); } });
  const request: CduRequest = { ...context, type: 'requestCduState', requestId: 'fenix', side: 'left' };
  assert.equal((await session.request(request)).externalPort, 8083);
  await assert.rejects(session.request({ ...request, type: 'sendCduKey', key: 'A' }, () => true), /Fenix web MCDU/);
  await session.dispose();
});

test('unpaired LAN viewers can read but cannot send CDU keys', () => {
  assert.equal(isClientMessageAuthorized({}, 'requestCduState'), true);
  assert.equal(isClientMessageAuthorized({}, 'sendCduKey'), false);
  assert.equal(isClientMessageAuthorized({ __ffAircraftControlClient: true }, 'sendCduKey'), true);
});
