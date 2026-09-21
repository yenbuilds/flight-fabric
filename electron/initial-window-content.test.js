'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

const source = ts.createSourceFile('main.js', fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8'), ts.ScriptTarget.Latest, true);
const loader = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'loadInitialWindowContent');
assert.ok(loader, 'the shipped startup loader must exist');

function fixture({ desktop = async () => {}, launcher = async () => {}, emergency = async () => {} } = {}) {
  const calls = [], logs = [];
  const window = { isDestroyed: () => false, async loadURL(url) { calls.push(['emergency', window]); assert.match(url, /^data:text\/html/); return emergency(); } };
  const context = vm.createContext({
    mainWindow: window, isQuitting: false,
    loadDesktopApp: async target => { calls.push(['desktop', target]); return desktop(); },
    loadLegacyLauncher: async target => { calls.push(['launcher', target]); return launcher(); },
    buildEmergencyFallbackDocument: () => '<html>Recovery</html>',
    debugLog: (...args) => logs.push(args.join(' ')), encodeURIComponent,
  });
  const load = vm.runInContext(`${loader.getText(source)}\nloadInitialWindowContent`, context);
  return { window, context, calls, logs, load: () => load(window) };
}

const fail = async () => { throw new Error('navigation failed'); };

test('desktop success does not start fallback navigation', async () => {
  const f = fixture();
  await f.load();
  assert.deepEqual(f.calls.map(call => call[0]), ['desktop']);
});

test('recovery tries the launcher then emergency content on the original window', async () => {
  const f = fixture({ desktop: fail, launcher: fail });
  await f.load();
  assert.deepEqual(f.calls.map(call => call[0]), ['desktop', 'launcher', 'emergency']);
  assert.ok(f.calls.every(call => call[1] === f.window));
});

test('launcher success stops the fallback chain', async () => {
  const f = fixture({ desktop: fail });
  await f.load();
  assert.deepEqual(f.calls.map(call => call[0]), ['desktop', 'launcher']);
});

test('a failed emergency page is handled instead of leaving an unhandled rejection', async () => {
  const f = fixture({ desktop: fail, launcher: fail, emergency: fail });
  await assert.doesNotReject(f.load());
  assert.ok(f.logs.some(line => line.includes('Emergency fallback load error: navigation failed')));
  const primitiveFailure = async () => { throw null; };
  const nonError = fixture({ desktop: primitiveFailure, launcher: primitiveFailure, emergency: primitiveFailure });
  await assert.doesNotReject(nonError.load());
  assert.deepEqual(nonError.calls.map(call => call[0]), ['desktop', 'launcher', 'emergency']);
});

for (const pendingStage of ['desktop', 'launcher']) {
  for (const change of ['closed', 'destroyed', 'replacement', 'quit']) {
    test(`${change} during pending ${pendingStage} load cannot navigate recovery content`, async () => {
      let reject, entered;
      const waiting = new Promise((_, failLoad) => { reject = failLoad; });
      const loading = new Promise(resolve => { entered = resolve; });
      const f = fixture({ desktop: pendingStage === 'desktop' ? () => { entered(); return waiting; } : fail,
        launcher: () => { entered(); return waiting; } });
      const result = f.load();
      await loading;
      if (change === 'closed') f.context.mainWindow = null;
      if (change === 'destroyed') f.window.isDestroyed = () => true;
      if (change === 'replacement') f.context.mainWindow = { isDestroyed: () => false, loadURL: () => assert.fail('must not navigate a replacement window') };
      if (change === 'quit') f.context.isQuitting = true;
      reject(new Error('navigation cancelled'));
      await assert.doesNotReject(result);
      assert.deepEqual(f.calls.map(call => call[0]), pendingStage === 'desktop' ? ['desktop'] : ['desktop', 'launcher']);
    });
  }
}
