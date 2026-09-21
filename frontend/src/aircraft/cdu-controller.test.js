import test from 'node:test';
import assert from 'node:assert/strict';
import { createCduController, cduKeyboardKey, fenixMcduUrl, CDU_KEY_QUEUE_LIMIT, CDU_KEY_SPACING_MS } from './cdu-controller.js';

function timedController() {
  const sent = [], timers = new Map(); let clock = 1000, counter = 0, model, canWrite = true;
  const profile = { profileKey: 'test', profileRevision: 1 };
  const controller = createCduController({ send: request => sent.push(request), getProfile: () => ({ ...profile }),
    getCanWrite: () => canWrite, onChange: value => { model = value; }, now: () => clock,
    setTimeoutRef: (callback, delay) => { timers.set(++counter, { callback, at: clock + delay }); return counter; },
    clearTimeoutRef: id => timers.delete(id) });
  const reply = (request = sent.at(-1), extra = {}) => controller.receive({ ...request, type: 'cduState', ok: true,
    sessionId: 's', screen: { powered: true, rows: [] }, ...extra });
  const advance = ms => {
    const end = clock + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      clock = next[1].at; timers.delete(next[0]); next[1].callback();
    }
    clock = end;
  };
  controller.read(); reply();
  return { controller, reply, advance, sent, profile, get model() { return model; }, set canWrite(value) { canWrite = value; },
    keys: () => sent.filter(request => request.type === 'sendCduKey').map(request => request.key) };
}

test('a tap immediately after a fast reply still respects key spacing', () => {
  const h = timedController();
  try {
    h.controller.press('A'); h.reply(); h.advance(10);
    h.controller.press('B');
    assert.deepEqual(h.keys(), ['A'], 'the empty queue must not bypass the backend spacing limit');
    h.advance(CDU_KEY_SPACING_MS - 11); assert.deepEqual(h.keys(), ['A']);
    h.advance(1); assert.deepEqual(h.keys(), ['A', 'B']);
  } finally { h.controller.dispose(); }
});

test('queue overflow remains visible after the accepted keys drain and polling resumes', () => {
  const h = timedController();
  try {
    h.controller.press('A');
    for (let i = 0; i < CDU_KEY_QUEUE_LIMIT; i++) h.controller.press('B');
    assert.equal(h.controller.press('C'), false);
    const warning = h.model.error;
    for (let i = 0; i < CDU_KEY_QUEUE_LIMIT; i++) { h.reply(); h.advance(CDU_KEY_SPACING_MS); }
    h.reply(); h.controller.read(); h.reply();
    assert.equal(h.model.error, warning, 'automatic queue delivery must not hide a refused character');
    assert.equal(h.keys().includes('C'), false);
    h.advance(CDU_KEY_SPACING_MS); h.controller.press('D'); h.reply();
    assert.equal(h.model.error, '', 'a fresh manual entry clears the warning');
  } finally { h.controller.dispose(); }
});

test('queued input is discarded when a poll replaces the control session', () => {
  const h = timedController();
  try {
    h.controller.press('A'); h.controller.press('B'); h.reply();
    h.controller.read(); h.reply(undefined, { sessionId: 'replacement' });
    h.advance(CDU_KEY_SPACING_MS);
    assert.deepEqual(h.keys(), ['A'], 'keys intended for the previous session must not be replayed');
    assert.equal(h.model.queued, 0);
    assert.match(h.model.error, /changed|cancelled/i);
  } finally { h.controller.dispose(); }
});

test('queued keys recheck the profile and write permission before delivery', () => {
  for (const invalidate of [h => { h.profile.profileRevision++; }, h => { h.canWrite = false; }]) {
    const h = timedController();
    try {
      h.controller.press('A'); h.controller.press('B'); h.reply();
      invalidate(h); h.advance(CDU_KEY_SPACING_MS);
      assert.deepEqual(h.keys(), ['A']);
      assert.equal(h.model.queued, 0); assert.equal(h.model.pending, false);
      assert.ok(h.model.error, 'cancelled input is explained');
    } finally { h.controller.dispose(); }
  }
});

test('display loss cancels queued keys even if a fresh poll recovers before the spacing gap ends', () => {
  for (const unavailable of [{ ok: false, error: 'Display connection lost.' }, { screen: { powered: false, rows: [] } }]) {
    const h = timedController();
    try {
      h.controller.press('A'); h.controller.press('B'); h.reply();
      h.controller.read(); h.reply(undefined, unavailable);
      h.controller.read(); h.reply(); h.advance(CDU_KEY_SPACING_MS);
      assert.deepEqual(h.keys(), ['A']);
      assert.match(h.model.error, /cancelled/);
      assert.equal(h.model.pending, false);
    } finally { h.controller.dispose(); }
  }
});

test('controller correlates responses, never retries keys, and rejects previous unit/profile responses', () => {
  const sent = [], timers = new Map(); let counter = 0, model, canWrite = true;
  const profile = { profileKey: 'bundled/msfs/pmdg-737', profileRevision: 1 };
  const controller = createCduController({ send: request => sent.push(request), getProfile: () => profile,
    getCanWrite: () => canWrite, onChange: value => { model = value; },
    setTimeoutRef: callback => { timers.set(++counter, callback); return counter; }, clearTimeoutRef: id => timers.delete(id) });
  const reply = (request, extra = {}) => controller.receive({ ...request, type: 'cduState', ok: true, sessionId: 'session', screen: { powered: true, rows: [] }, ...extra });
  controller.read(); reply(sent.at(-1));
  canWrite = false; assert.equal(controller.press('A'), false);
  canWrite = true; assert.equal(controller.press('A'), true);
  reply(sent.at(-1)); assert.equal(model.pending, false);
  controller.read(); const old = sent.at(-1);
  controller.reset('right'); reply(old); assert.equal(model.state.screen, undefined);
  controller.read(); profile.profileRevision = 2; reply(sent.at(-1)); assert.equal(model.state.screen, undefined);
  controller.disconnect(); assert.equal(controller.press('A'), false);
  assert.equal(sent.filter(request => request.type === 'sendCduKey').length, 1);
  controller.dispose();
});

test('keys typed while one is in flight queue in order and go out spaced after each reply', () => {
  const sent = [], timers = new Map(); let counter = 0, model, clock = 1000;
  const profile = { profileKey: 'test', profileRevision: 1 };
  const controller = createCduController({ send: request => sent.push(request), getProfile: () => profile,
    getCanWrite: () => true, onChange: value => { model = value; }, now: () => clock,
    setTimeoutRef: (callback, delay) => { timers.set(++counter, { callback, delay }); return counter; }, clearTimeoutRef: id => timers.delete(id) });
  const reply = request => controller.receive({ ...request, type: 'cduState', ok: true, sessionId: 's', screen: { powered: true, rows: [] } });
  const keys = () => sent.filter(request => request.type === 'sendCduKey').map(request => request.key);
  const fireSpacing = () => {
    const entry = [...timers.entries()].find(([, value]) => value.delay === CDU_KEY_SPACING_MS);
    assert.ok(entry, 'a spacing timer is armed after the reply'); timers.delete(entry[0]); clock += entry[1].delay; entry[1].callback();
  };
  try {
    controller.read(); reply(sent.at(-1));
    assert.equal(controller.press('K'), true);
    assert.equal(controller.press('L'), true);
    assert.equal(controller.press('A'), true);
    assert.equal(controller.press('X'), true);
    assert.deepEqual(keys(), ['K'], 'only one key is in flight');
    assert.equal(model.pending, true); assert.equal(model.queued, 3);
    reply(sent.at(-1));
    assert.deepEqual(keys(), ['K'], 'the next key waits for the spacing gap');
    assert.equal(model.pending, true, 'queued keys keep the status busy');
    fireSpacing(); assert.deepEqual(keys(), ['K', 'L']);
    reply(sent.at(-1)); fireSpacing(); reply(sent.at(-1)); fireSpacing(); reply(sent.at(-1));
    assert.deepEqual(keys(), ['K', 'L', 'A', 'X']);
    assert.equal(model.pending, false); assert.equal(model.queued, 0); assert.equal(model.error, '');
    assert.equal([...timers.values()].filter(value => value.delay === CDU_KEY_SPACING_MS).length, 0, 'no stray spacing timer');

    // A press during the spacing gap joins the back of the queue instead of jumping ahead.
    clock += CDU_KEY_SPACING_MS;
    controller.press('S'); controller.press('T'); reply(sent.at(-1));
    assert.equal(controller.press('U'), true);
    assert.deepEqual(keys().slice(-1), ['S']);
    fireSpacing(); assert.deepEqual(keys().slice(-2), ['S', 'T']);
    reply(sent.at(-1)); fireSpacing(); reply(sent.at(-1));
    assert.deepEqual(keys().slice(-3), ['S', 'T', 'U']);

    clock += CDU_KEY_SPACING_MS; controller.press('1');
    for (let index = 0; index < CDU_KEY_QUEUE_LIMIT; index += 1) assert.equal(controller.press('2'), true);
    assert.equal(controller.press('3'), false, 'the queue is bounded');
    assert.match(model.error, /catch up/);
    assert.equal(model.queued, CDU_KEY_QUEUE_LIMIT);
  } finally { controller.dispose(); }
});

test('a failed or timed-out key drops the typed-ahead keys instead of typing blind', () => {
  const sent = [], timers = new Map(); let counter = 0, model, clock = 1000;
  const profile = { profileKey: 'test', profileRevision: 1 };
  // Snapshot per call, as the modal does, so a revision bump is visible against the request's profile.
  const controller = createCduController({ send: request => sent.push(request), getProfile: () => ({ ...profile }),
    getCanWrite: () => true, onChange: value => { model = value; }, now: () => clock,
    setTimeoutRef: (callback, delay) => { timers.set(++counter, { callback, delay }); return counter; }, clearTimeoutRef: id => timers.delete(id) });
  const reply = (request, extra = {}) => controller.receive({ ...request, type: 'cduState', ok: true, sessionId: 's', screen: { powered: true, rows: [] }, ...extra });
  const keys = () => sent.filter(request => request.type === 'sendCduKey').map(request => request.key);
  try {
    controller.read(); reply(sent.at(-1));
    controller.press('A'); controller.press('B'); controller.press('C');
    reply(sent.at(-1), { ok: false, error: 'CDU key delivery was not confirmed.' });
    assert.deepEqual(keys(), ['A']); assert.equal(model.queued, 0); assert.equal(model.pending, false);
    assert.match(model.error, /not confirmed/);

    controller.read(); reply(sent.at(-1));
    controller.press('D'); controller.press('E');
    const timeout = [...timers.entries()].at(-1);
    assert.equal(timeout[1].delay, 3000); timers.delete(timeout[0]); timeout[1].callback();
    assert.deepEqual(keys(), ['A', 'D']); assert.equal(model.queued, 0);
    assert.match(model.error, /timed out/);

    controller.read(); reply(sent.at(-1));
    controller.press('F'); controller.press('G');
    controller.reset();
    assert.equal(model.queued, 0);
    reply(sent.at(-1));
    assert.deepEqual(keys(), ['A', 'D', 'F'], 'a reset discards the queue and the reply to the old key sends nothing');

    controller.read(); reply(sent.at(-1));
    controller.press('H'); controller.press('I');
    profile.profileRevision = 2;
    reply(sent.at(-1));
    assert.equal(model.queued, 0, 'an aircraft change under a key discards what was typed for the old one');
    assert.equal([...timers.values()].some(value => value.delay === 60), false, 'no spacing timer survives the drop');
    assert.deepEqual(keys(), ['A', 'D', 'F', 'H']);

    profile.profileRevision = 1;
    controller.read(); reply(sent.at(-1));
    controller.press('J'); controller.press('K');
    reply(sent.at(-1), { side: 'right' });
    assert.equal(model.queued, 0, 'a reply for the other unit discards the typed-ahead keys');
    assert.deepEqual(keys(), ['A', 'D', 'F', 'H', 'J']);
  } finally { controller.dispose(); }
});

test('keyboard input ignores browser shortcuts/repeat and uses vendor punctuation', () => {
  assert.equal(cduKeyboardKey({ key: 'a' }, ['A']), 'A');
  assert.equal(cduKeyboardKey({ key: '/', ctrlKey: true }, ['DIV']), null);
  assert.equal(cduKeyboardKey({ key: 'a', repeat: true }, ['A']), null);
  assert.equal(cduKeyboardKey({ key: 'Backspace' }, ['CLR']), 'CLR');
  assert.equal(cduKeyboardKey({ key: '/' }, ['DIV']), 'DIV');
  assert.equal(cduKeyboardKey({ key: 'Enter' }, ['EXEC']), null);
});

test('Fenix links use simulator host, fixed port and no FlightFabric credentials', () => {
  assert.equal(fenixMcduUrl('ws://192.168.1.12:3001/?token=secret'), 'http://192.168.1.12:8083/');
  assert.equal(fenixMcduUrl(null, 'http://localhost:3000/'), 'http://localhost:8083/');
  assert.equal(fenixMcduUrl('file:///app.html'), '');
});

test('a timed-out key stays uncertain through reads and is not retried', () => {
  const sent = [], timers = new Map(); let counter = 0, model;
  const profile = { profileKey: 'test', profileRevision: 1 };
  const controller = createCduController({ send: request => sent.push(request), getProfile: () => profile,
    getCanWrite: () => true, onChange: value => { model = value; },
    setTimeoutRef: callback => { timers.set(++counter, callback); return counter; }, clearTimeoutRef: id => timers.delete(id) });
  const reply = request => controller.receive({ ...request, type: 'cduState', ok: true, sessionId: 's', screen: { powered: true, rows: [] } });
  controller.read(); reply(sent.at(-1));
  controller.press('A'); const key = sent.at(-1);
  [...timers.values()][0]();
  assert.equal(model.state.screen, null); assert.match(model.error, /timed out/);
  reply(key); assert.equal(model.state.screen, null);
  controller.read(); reply(sent.at(-1));
  assert.match(model.error, /timed out/);
  assert.equal(sent.filter(request => request.type === 'sendCduKey').length, 1);
  controller.dispose();
});

test('read failures and timeouts cannot erase an uncertain key warning', () => {
  const sent = [], timers = new Map(); let counter = 0, model;
  const profile = { profileKey: 'test', profileRevision: 1 };
  const controller = createCduController({ send: request => sent.push(request), getProfile: () => profile,
    getCanWrite: () => true, onChange: value => { model = value; },
    setTimeoutRef: callback => { timers.set(++counter, callback); return counter; }, clearTimeoutRef: id => timers.delete(id) });
  const reply = (request, extra = {}) => controller.receive({ ...request, type: 'cduState', ok: true, sessionId: 's', screen: { powered: true, rows: [] }, ...extra });
  try {
    controller.read(); reply(sent.at(-1));
    controller.press('A');
    reply(sent.at(-1), { ok: false, error: 'CDU key delivery was not confirmed. Check the aircraft before trying again.' });
    const warning = model.error;
    controller.read(); reply(sent.at(-1), { ok: false, error: 'Aircraft connection changed.' });
    assert.equal(model.state.screen, null);
    assert.equal(model.error, warning);
    controller.read(); [...timers.values()].at(-1)();
    assert.equal(model.error, warning);
    controller.read(); reply(sent.at(-1));
    assert.equal(model.state.screen.powered, true);
    assert.equal(model.error, warning);
    assert.equal(sent.filter(request => request.type === 'sendCduKey').length, 1);
  } finally { controller.dispose(); }
});

test('an older read failure cannot blank a newer successful key response', () => {
  const sent = []; let model;
  const profile = { profileKey: 'test', profileRevision: 1 };
  const controller = createCduController({ send: request => sent.push(request), getProfile: () => profile,
    getCanWrite: () => true, onChange: value => { model = value; } });
  const reply = (request, extra = {}) => controller.receive({ ...request, type: 'cduState', ok: true, sessionId: 's', screen: { powered: true, rows: [] }, ...extra });
  try {
    controller.read(); reply(sent.at(-1));
    controller.read(); const oldRead = sent.at(-1);
    controller.press('A'); reply(sent.at(-1));
    reply(oldRead, { ok: false, error: 'Old read failed.' });
    assert.equal(model.state.screen?.powered, true);
    assert.equal(model.error, '');
    assert.equal(model.pending, false);
  } finally { controller.dispose(); }
});

test('out-of-order timeouts and successful reads preserve the newest CDU state', () => {
  const sent = [], timers = new Map(); let counter = 0, model, clock = 1000;
  const profile = { profileKey: 'test', profileRevision: 1 };
  const controller = createCduController({ send: request => sent.push(request), getProfile: () => profile,
    getCanWrite: () => true, onChange: value => { model = value; }, now: () => clock,
    setTimeoutRef: callback => { timers.set(++counter, callback); return counter; }, clearTimeoutRef: id => timers.delete(id) });
  const reply = request => controller.receive({ ...request, type: 'cduState', ok: true, sessionId: 's', screen: { powered: true, rows: [] } });
  try {
    controller.read(); reply(sent.at(-1));
    controller.read(); const oldTimeout = timers.get(counter);
    controller.press('A'); reply(sent.at(-1));
    oldTimeout();
    assert.equal(model.state.screen.powered, true, 'old poll timeout must not clear the newer screen');
    assert.equal(model.error, '');

    clock += CDU_KEY_SPACING_MS;
    controller.read(); const oldRead = sent.at(-1);
    controller.press('B'); timers.get(counter)();
    assert.equal(model.state.screen, null);
    reply(oldRead);
    assert.equal(model.state.screen, null, 'old success must not restore a screen invalidated by a later timeout');
    assert.match(model.error, /Key delivery timed out/);
    assert.equal(controller.press('C'), false);
    assert.equal(sent.filter(request => request.type === 'sendCduKey').length, 2);
  } finally { controller.dispose(); }
});
