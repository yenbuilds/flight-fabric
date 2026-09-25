'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { parseArgs, parseControl, createReplayController, createReplayOutputReader, nativeBuildSpec, createReplayLogWriter, terminalText } = require('../../scripts/run-dedicated-replay');
const { resolveCargo } = require('../../scripts/rust-toolchain');
test('preparation defaults to no native connection; live requires known 1x source', () => {
  assert.equal(parseArgs(['flight.csv']).live, false);
  assert.throws(() => parseArgs(['flight.csv', '--live']), /1x/);
  assert.equal(parseArgs(['flight.csv', '--live', '--recorded-at-1x']).live, true);
  assert.throws(() => parseArgs(['--recover', 'flight.csv']), /separate/);
  assert.throws(() => parseArgs(['flight.csv', '--landing', '0']), /positive/);
});
test('seek uses seconds, cannot leave the clip, and restart always pauses at zero', () => {
  assert.deepEqual(parseControl('seek 2.5', 5000), { type: 'seek', positionMs: 2500 });
  assert.deepEqual(parseControl('restart', 5000), { type: 'seek', positionMs: 0 });
  for (const value of ['seek -1', 'seek Infinity', 'seek 6', 'play extra', 'stop extra']) {
    assert.throws(() => parseControl(value, 5000));
  }
});

function controllerHarness() {
  const input = new EventEmitter();
  const sent = [];
  const timers = new Map();
  const notices = [];
  let nextTimer = 0;
  input.write = (line, callback) => { sent.push(JSON.parse(line)); callback(); };
  input.end = () => { input.writableEnded = true; };
  const controller = createReplayController({ input, session: 'session-a', notice: message => notices.push(message),
    setTimer: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimer: id => timers.delete(id) });
  return { controller, input, sent, timers, notices };
}
test('Stop is sent immediately while Start is awaiting an acknowledgement', () => {
  const { controller, sent, timers } = controllerHarness();
  assert.equal(controller.send({ type: 'start' }), true);
  assert.equal(controller.send({ type: 'play' }), false);
  assert.equal(controller.send({ type: 'stop' }), true);
  assert.deepEqual(sent.map(message => message.type), ['start', 'stop']);
  assert.equal(timers.size, 1);
  assert.equal(controller.acknowledge({ session: 'session-a', requestId: 1, ok: true }), false);
  assert.equal(timers.size, 1, 'late Start acknowledgement must not clear the Stop watchdog');
  assert.equal(controller.send({ type: 'stop' }), true);
  assert.equal(sent.length, 2, 'repeated Stop does not flood the pipe');
  assert.equal(controller.acknowledge({ session: 'session-a', requestId: 2, ok: true }), true);
  assert.equal(timers.size, 0);
  controller.close();
});
test('timeout or pipe failure permanently closes writes and requests native recovery through EOF', () => {
  for (const failure of ['timeout', 'pipe']) {
    const { controller, input, sent, timers } = controllerHarness();
    controller.send({ type: 'start' });
    if (failure === 'timeout') [...timers.values()][0]();
    else input.emit('error', new Error('broken pipe'));
    assert.equal(input.writableEnded, true);
    assert.equal(controller.send({ type: 'start' }), false);
    assert.equal(sent.length, 1);
    assert.equal(timers.size, 0);
  }
});

test('unsolicited or malformed acknowledgements cannot throw or cancel a pending timeout', () => {
  const { controller, timers, input } = controllerHarness();
  assert.equal(controller.acknowledge({ session: 'session-a', ok: true }), false);
  assert.equal(controller.acknowledge(null), false);
  controller.send({ type: 'start' });
  for (const message of [null, {}, { session: 'session-a', ok: true },
    { session: 'other', requestId: 1, ok: true }, { session: 'session-a', requestId: 1, ok: 'true' }]) {
    assert.equal(controller.acknowledge(message), false);
    assert.equal(timers.size, 1);
  }
  assert.equal(controller.acknowledge({ session: 'session-a', requestId: 1, ok: true }), true);
  assert.equal(controller.acknowledge({ session: 'session-a', ok: true }), false);
  assert.notEqual(input.writableEnded, true);
  controller.close();
});
test('output bounds apply per line, not to a coalesced batch of valid status messages', () => {
  const received = [];
  const reader = createReplayOutputReader(message => received.push(message), error => assert.fail(error));
  reader((JSON.stringify({ type: 'replayStatus', detail: 'a'.repeat(200) }) + '\n').repeat(100));
  reader('{"partial":'); reader('true}\n');
  assert.equal(received.length, 101);
  assert.deepEqual(received.at(-1), { partial: true });
  let failures = 0;
  const bad = createReplayOutputReader(() => assert.fail('oversized line must not be accepted'), () => failures++);
  bad('x'.repeat(16385)); bad('ignored\n');
  assert.equal(failures, 1);
});
test('native build and launch use the same explicit target despite Cargo environment overrides', () => {
  const root = path.resolve('test-workspace');
  const spec = nativeBuildSpec(root, { CARGO_TARGET_DIR: 'elsewhere', CARGO_BUILD_TARGET: 'other-architecture' });
  assert.equal(spec.command, 'cargo.exe');
  assert.equal(spec.args[spec.args.indexOf('--target') + 1], 'x86_64-pc-windows-msvc');
  assert.ok(spec.args.includes('--release'));
  assert.ok(spec.args.includes('--locked'));
  assert.equal(spec.binary, path.join(spec.args[spec.args.indexOf('--target-dir') + 1],
    'x86_64-pc-windows-msvc', 'release', 'ff-rust-simconnect-sidecar.exe'));
});

test('stalled or excessive logs have bounded memory/disk use and close control for recovery', () => {
  const { Writable } = require('node:stream');
  for (const limit of ['memory', 'disk']) {
    const stream = new Writable({ write(_data, _encoding, callback) { if (limit === 'disk') callback(); } });
    const { controller, input, timers } = controllerHarness();
    controller.send({ type: 'start' });
    let failures = 0;
    const write = createReplayLogWriter(stream, reason => { failures++; controller.close(reason); },
      { maxBytes: 16, maxBufferedBytes: 8 });
    assert.equal(write('12345678'), true);
    if (limit === 'disk') assert.equal(write('12345678'), true);
    assert.equal(write('x'), false);
    for (let i = 0; i < 100; i++) assert.equal(write('ignored'), false);
    assert.equal(failures, 1);
    assert.ok(stream.writableLength <= 8);
    assert.equal(input.writableEnded, true, 'log overflow must request native recovery through EOF');
    assert.equal(timers.size, 0);
    assert.equal(controller.send({ type: 'play' }), false);
    stream.destroy();
  }
});

test('log failures close the actual controller once, including write callbacks and emitted errors', () => {
  for (const failure of ['throw', 'callback', 'event']) {
    const stream = new EventEmitter();
    stream.writableLength = 0;
    stream.end = () => { stream.writableEnded = true; };
    stream.write = (_data, callback) => {
      if (failure === 'throw') throw new Error('disk unavailable');
      if (failure === 'callback') callback(new Error('disk unavailable'));
      if (failure === 'event') stream.emit('error', new Error('disk unavailable'));
    };
    const { controller, input, timers } = controllerHarness();
    controller.send({ type: 'start' });
    let failures = 0;
    const write = createReplayLogWriter(stream, reason => { failures++; controller.close(reason); });
    assert.equal(write('data'), false);
    stream.emit('error', new Error('late error'));
    assert.equal(write('ignored'), false);
    assert.equal(failures, 1);
    assert.equal(input.writableEnded, true);
    assert.equal(timers.size, 0);
    assert.equal(controller.send({ type: 'play' }), false);
  }
});

test('terminal display escapes recording and diagnostic control sequences', () => {
  assert.equal(terminalText('PMDG\x1b[2J\r\n\x9dclipboard'), 'PMDG\\x1b[2J\\x0d\\x0a\\x9dclipboard');
  assert.equal(terminalText('Fenix A320 — CFM'), 'Fenix A320 — CFM');
});

test('shared Cargo discovery preserves precedence and falls back from stale homes to PATH', () => {
  const env = { CARGO_HOME: 'C:\\custom', USERPROFILE: 'C:\\user', PATH: 'C:\\tools;C:\\TOOLS;C:\\fallback' };
  const seen = [];
  assert.equal(resolveCargo({ env, platform: 'win32', existsSync: candidate => {
    seen.push(candidate);
    return candidate === 'C:\\fallback\\cargo.exe';
  } }), 'C:\\fallback\\cargo.exe');
  assert.equal(seen[0], 'C:\\custom\\bin\\cargo.exe');
  assert.equal(seen.filter(value => value.toLowerCase() === 'c:\\tools\\cargo.exe').length, 1);
  assert.equal(resolveCargo({ env: { PATH: '/first:/second' }, platform: 'linux',
    existsSync: candidate => candidate === '/second/cargo' }), '/second/cargo');
});
