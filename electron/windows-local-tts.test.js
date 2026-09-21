'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  MAX_READBACK_CHARS,
  READBACK_ENV_KEY,
  createWindowsLocalTts,
  normalizeReadbackText,
} = require('./windows-local-tts');

test('Windows local readback passes bounded text to SAPI as encoded data', () => {
  const launches = [];
  const children = [];
  const engine = createWindowsLocalTts({
    fileExists: () => true,
    platform: 'win32',
    spawnProcess(executable, args, options) {
      const child = new EventEmitter();
      child.exitCode = null;
      child.killed = false;
      child.kill = () => { child.killed = true; return true; };
      children.push(child);
      launches.push({ executable, args, options });
      return child;
    },
    systemRoot: 'C:\\Windows',
  });

  assert.deepEqual(engine.getInfo(), {
    available: true,
    engine: 'windows-sapi',
    lastError: '',
    local: true,
  });
  assert.equal(engine.speak('Heading two seven zero set.'), true);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].options.shell, false);
  assert.equal(launches[0].options.windowsHide, true);
  assert.deepEqual(launches[0].options.stdio, ['ignore', 'ignore', 'pipe'], 'stderr must be captured so SAPI errors are not lost');
  assert.equal(launches[0].args.includes('Heading two seven zero set.'), false);

  const commandIndex = launches[0].args.indexOf('-Command');
  const script = launches[0].args[commandIndex + 1];
  assert.match(script, /SAPI\.SpVoice/);
  const encodedUtterance = Buffer.from('Heading two seven zero set.', 'utf8').toString('base64');
  assert.equal(script.includes(encodedUtterance), false, 'utterance data must remain separate from code');
  assert.equal(launches[0].options.env[READBACK_ENV_KEY], encodedUtterance);

  assert.equal(engine.speak('Altitude one zero thousand set.'), true);
  assert.equal(children[0].killed, true, 'a new readback should stop the previous one');
  assert.equal(engine.cancel(), true);
  assert.equal(children[1].killed, true);
});

test('Windows local readback rejects malformed or oversized renderer text', () => {
  assert.equal(normalizeReadbackText('Heading set.'), 'Heading set.');
  assert.throws(() => normalizeReadbackText('Heading\nset.'), /Invalid local readback text/);
  assert.throws(() => normalizeReadbackText('x'.repeat(MAX_READBACK_CHARS + 1)), /Invalid local readback text/);
});

test('Windows local readback remains unavailable outside Windows', () => {
  const engine = createWindowsLocalTts({
    fileExists: () => true,
    platform: 'linux',
    spawnProcess: () => { throw new Error('must not launch'); },
  });
  assert.equal(engine.getInfo().available, false);
  assert.equal(engine.speak('Heading set.'), false);
});

test('Windows local readback reports why a spoken readback failed and clears it on success', () => {
  const children = [];
  const changes = [];
  const logs = [];
  let clock = 1000;
  const engine = createWindowsLocalTts({
    debugLog: (...args) => logs.push(args.join(' ')),
    fileExists: () => true,
    now: () => clock,
    onErrorChange: (message) => changes.push(message),
    platform: 'win32',
    spawnProcess() {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.killed = false;
      child.kill = () => { child.killed = true; return true; };
      children.push(child);
      return child;
    },
  });

  assert.equal(engine.speak('Heading two seven zero set.'), true);
  children[0].stderr.emit('data', 'Exception calling "Speak" with "1" argument(s): "Audio device unavailable"\r\n+ CategoryInfo : NotSpecified\r\n');
  children[0].emit('exit', 1);
  assert.equal(engine.getInfo().lastError, '', 'stderr may still be arriving at exit; report on close');
  children[0].stderr.emit('data', 'At line:1 char:5\r\n+ try{[void]$voice.Speak($text)}\r\n');
  children[0].emit('close', 1);
  assert.equal(engine.getInfo().lastError,
    'Readback exited with code 1: Exception calling "Speak" with "1" argument(s): "Audio device unavailable"');
  assert.deepEqual(changes, [engine.getInfo().lastError], 'a failure should be reported once, with the SAPI detail');

  assert.equal(engine.speak('Altitude one zero thousand set.'), true);
  assert.equal(engine.speak('Speed two five zero set.'), true);
  children[1].emit('close', null);
  assert.equal(changes.length, 1, 'a readback replaced by a newer one is not a failure');
  assert.equal(engine.getInfo().lastError.startsWith('Readback exited with code 1'), true, 'a cancellation must not clear a real failure');

  clock = 3500;
  children[2].emit('close', 0);
  assert.equal(engine.getInfo().lastError, '', 'a successful readback clears the last failure');
  assert.deepEqual(changes.at(-1), '', 'recovery must be reported so the renderer can clear its notice');
  assert.equal(logs.some((line) => /finished in 2500 ms/.test(line)), true, 'readback timing should be logged');

  assert.equal(engine.speak('Speed two five zero set.'), true);
  children[3].emit('close', 0);
  assert.equal(changes.length, 2, 'repeated successes are not re-reported');

  assert.equal(engine.speak('Flaps one selected.'), true);
  children[4].emit('error', new Error('spawn EPERM'));
  children[4].emit('close', -2);
  assert.equal(engine.getInfo().lastError, 'PowerShell could not start: spawn EPERM');
  assert.equal(changes.length, 3, 'a spawn failure is reported once even though close follows error');
});

test('Windows local readback keeps a console-wrapped SAPI error whole and drops the script context', () => {
  const children = [];
  const engine = createWindowsLocalTts({
    fileExists: () => true,
    platform: 'win32',
    spawnProcess() {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.killed = false;
      children.push(child);
      return child;
    },
  });
  assert.equal(engine.speak('Heading two seven zero set.'), true);
  children[0].stderr.emit('data', [
    'New-Object : Retrieving the COM class factory for component with CLSID {96749377-3391-11D2-9EE3-00C04F797396} failed due',
    'to the following error: 80040154 Class not registered (Exception from HRESULT: 0x80040154 (REGDB_E_CLASSNOTREG)).',
    'At line:1 char:200',
    '+ ... $voice=New-Object -ComObject SAPI.SpVoice;try{[void]$voice.Speak($text)}',
    '+                 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
    '    + CategoryInfo          : ResourceUnavailable: (:) [New-Object], COMException',
    '',
  ].join('\r\n'));
  children[0].emit('close', 1);
  assert.equal(engine.getInfo().lastError,
    'Readback exited with code 1: New-Object : Retrieving the COM class factory for component with CLSID '
    + '{96749377-3391-11D2-9EE3-00C04F797396} failed due to the following error: 80040154 Class not registered '
    + '(Exception from HRESULT: 0x80040154 (REGDB_E_CLASSNOTREG)).');
});
