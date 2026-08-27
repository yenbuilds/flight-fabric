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
    local: true,
  });
  assert.equal(engine.speak('Heading two seven zero set.'), true);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].options.shell, false);
  assert.equal(launches[0].options.windowsHide, true);
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
