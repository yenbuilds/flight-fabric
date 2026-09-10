const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { executeA32nxMinimums, readMinimumsPage } = require('./a32nx-minimums-control');

function harness(options: any = {}) {
  const lines = Array.from({ length: 12 }, () => ['', '']);
  lines[2][1] = '{white}BARO{end}'; lines[3][1] = '[   ]';
  lines[4][1] = options.noRadio ? '' : 'RADIO'; lines[5][1] = options.noRadio ? '' : '[ ]';
  const page = { title: options.title || '{green}APPR{end} ILS27', lines, scratchpad: options.scratchpad || '' };
  const socket = new EventEmitter(); socket.readyState = 1;
  let refresh: ReturnType<typeof setInterval> | undefined;
  socket.terminate = () => { socket.closed = true; clearInterval(refresh); };
  const keys = []; let current = true;
  const publish = () => socket.emit('message', `update:${JSON.stringify({ left: page, right: page })}`);
  socket.send = (message) => {
    if (message === 'requestUpdate') {
      publish();
      if (options.refreshMs) refresh = setInterval(publish, options.refreshMs);
      return;
    }
    keys.push(message); socket.emit('message', message);
    if (options.interference) { socket.emit('message', 'event:right:A'); return; }
    if (options.profileLoss) { current = false; return; }
    if (options.disconnect) { socket.emit('close'); return; }
    if (options.ignore) return;
    const key = message.split(':')[2];
    if (/^\d$/.test(key)) page.scratchpad += key;
    else if (key === 'R2' || key === 'R3') {
      if (options.rejected) { page.scratchpad = 'ENTRY OUT OF RANGE'; publish(); return; }
      page.lines[key === 'R2' ? 3 : 5][1] = page.scratchpad;
      page.lines[key === 'R2' ? 5 : 3][1] = '[ ]'; page.scratchpad = '';
    }
    publish();
  };
  const run = (target = 'baro', value: unknown = 420) => executeA32nxMinimums({ target, value, isCurrent: () => current,
    createSocket: () => socket, timeoutMs: 2000, stepTimeoutMs: 150 });
  return { page, socket, keys, run, publish };
}

test('minimums enters each digit once and confirms stored BARO/RADIO plus cleared alternate type', async () => {
  for (const target of ['baro', 'radio']) {
    const h = harness(); const result = await h.run(target, 420);
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.confirmedValue, 420);
    assert.deepEqual(h.keys, ['event:left:4', 'event:left:2', 'event:left:0', `event:left:${target === 'baro' ? 'R2' : 'R3'}`]);
    assert.equal(h.socket.closed, true);
  }
});

test('wrong/secondary page, occupied scratchpad, unavailable RADIO and invalid numbers never write', async () => {
  for (const options of [{ title: 'PERF TAKE OFF' }, { title: 'SEC APPR ILS27' }, { scratchpad: 'PILOT ENTRY' }]) {
    const h = harness(options); assert.equal((await h.run()).ok, false); assert.deepEqual(h.keys, []);
  }
  const noRadio = harness({ noRadio: true }); assert.equal((await noRadio.run('radio')).ok, false); assert.deepEqual(noRadio.keys, []);
  for (const value of [-1, 5001, 42.1, NaN, '200']) {
    const h = harness(); assert.equal((await h.run('radio', value)).ok, false); assert.deepEqual(h.keys, []);
  }
  assert.equal(readMinimumsPage({ title: 'APPR', lines: [] }), null);
});

test('matching minimums performs no input and retains a clean scratchpad', async () => {
  const h = harness(); h.page.lines[3][1] = '420';
  assert.equal((await h.run()).noOp, true); assert.deepEqual(h.keys, []);
});

test('repeated unchanged screen updates do not prevent minimums entry', async () => {
  const h = harness({ refreshMs: 10 });
  const result = await h.run();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.keys, ['event:left:4', 'event:left:2', 'event:left:0', 'event:left:R2']);
});

test('a missing scratchpad is not treated as an empty pilot entry', async () => {
  const h = harness(); delete h.page.scratchpad;
  const result = await h.run();
  assert.equal(result.executionStarted, false);
  assert.deepEqual(h.keys, []);
});

test('minimums confirms over an asynchronous WebSocket with repeated page updates', async () => {
  const WebSocket = require('ws');
  const { once } = require('node:events');
  const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  const h = harness({ refreshMs: 10 });
  try {
    await once(server, 'listening');
    server.on('connection', (client) => {
      h.socket.on('message', (message) => {
        setTimeout(() => { if (client.readyState === WebSocket.OPEN) client.send(message); }, 15);
      });
      client.on('message', (message) => h.socket.send(String(message)));
    });
    const result = await executeA32nxMinimums({ target: 'radio', value: 200, isCurrent: () => true,
      createSocket: () => new WebSocket(`ws://127.0.0.1:${server.address().port}/interfaces/v1/mcdu`),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.confirmedValue, 200);
    assert.deepEqual(h.keys, ['event:left:2', 'event:left:0', 'event:left:0', 'event:left:R3']);
  } finally {
    h.socket.terminate();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('interference, disconnect, profile change and missing digit updates stop without a line-select press or retry', async () => {
  for (const options of [{ interference: true }, { profileLoss: true }, { disconnect: true }, { ignore: true }]) {
    const h = harness(options); const result = await h.run();
    assert.equal(result.ok, false); assert.equal(result.executionStarted, true);
    assert.deepEqual(h.keys, ['event:left:4']); assert.equal(h.socket.closed, true);
  }
  const rejected = harness({ rejected: true });
  assert.equal((await rejected.run()).ok, false); assert.equal(rejected.keys.length, 4);
});

export {};
