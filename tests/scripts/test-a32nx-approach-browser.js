#!/usr/bin/env node
'use strict';

// Real Chromium, real Vue stores and backend catalogue; simulated flap, brake and spoiler samples.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, '.tmp', 'a32nx-approach-browser');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runBrowser() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(OUTPUT, `user-data-${process.pid}`));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  await app.whenReady();
  const windowRef = new BrowserWindow({ show: false, width: 390, height: 1000,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [];
  windowRef.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  const evaluate = async (body) => {
    const result = await windowRef.webContents.executeJavaScript(`(async () => { try { return { value: await (async () => { ${body} })() }; } catch (error) { return { error: error.stack }; } })()`);
    if (result.error) throw new Error(`${result.error}\nExpression: ${body}`);
    return result.value;
  };
  try {
    await windowRef.loadURL(process.env.FF_A32NX_APPROACH_TEST_URL);
    for (let i = 0; i < 100; i++) {
      if (await evaluate('return Boolean(window.approachTest);')) break;
      await wait(50);
    }
    await evaluate('await approachTest.settle();');
    await evaluate(`await atcTest.scenario(); document.querySelector('[data-transponder-controls]').scrollIntoView({ behavior: 'instant', block: 'start' });`);
    await wait(150);
    assert.equal(await evaluate(`const r = document.querySelector('[data-minimums-controls]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight;`), true, 'both new panels fit in the initial mobile viewport');
    fs.writeFileSync(path.join(OUTPUT, 'atc-mobile-initial.png'), (await windowRef.webContents.capturePage()).toPNG());
    const button = (suffix) => `[data-aircraft-action="controls.flaps.${suffix}"]`;
    for (const suffix of ['up', 'one', 'two', 'three', 'full']) {
      const state = await evaluate(`const el = document.querySelector('${button(suffix)}'); const r = el.getBoundingClientRect(); return { disabled: el.disabled, width: r.width, height: r.height };`);
      assert.equal(state.disabled, false, suffix);
      assert.ok(state.width >= 44 && state.height >= 40, JSON.stringify(state));
    }
    assert.equal(await evaluate('return document.documentElement.scrollWidth <= window.innerWidth;'), true);
    assert.equal(await evaluate(`return document.querySelector('${button('two')}').getAttribute('aria-pressed');`), 'true');
    await evaluate(`document.querySelector('#fbw-a32nx-section-ground-engines').scrollIntoView({ behavior: 'instant', block: 'start' });`);
    assert.equal(await evaluate(`const r = document.querySelector('${button('full')}').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight;`), true);
    fs.writeFileSync(path.join(OUTPUT, 'mobile.png'), (await windowRef.webContents.capturePage()).toPNG());
    await evaluate(`document.querySelector('${button('three')}').click(); document.querySelector('${button('full')}').click(); await approachTest.settle();`);
    assert.deepEqual(await evaluate('return approachTest.sent;'), [{ actionId: 'controls.flaps.three', groupId: 'controls.flaps' }]);
    assert.equal(await evaluate(`return [...document.querySelectorAll('[data-aircraft-action^="controls.flaps."]')].every(el => el.disabled);`), true);
    assert.equal(await evaluate(`return document.querySelector('${button('two')}').getAttribute('aria-pressed');`), 'true', 'pending command must not optimistically change selection');
    await evaluate(`approachTest.pending.clear(); approachTest.props.values['controls.flapsHandle'] = '3'; await approachTest.settle();`);
    assert.equal(await evaluate(`return document.querySelector('${button('three')}').getAttribute('aria-pressed');`), 'true');
    for (const [actionId, groupId] of [['systems.autobrake.low', 'systems.autobrake'], ['controls.spoilers.half', 'controls.spoilers'], ['controls.spoilersArmed.on', 'controls.spoilersArmed']]) {
      await evaluate(`document.querySelector('[data-aircraft-action="${actionId}"]').click(); await approachTest.settle();`);
      assert.deepEqual(await evaluate('return approachTest.sent.at(-1);'), { actionId, groupId });
    }
    await evaluate(`approachTest.props.values = { ...approachTest.props.values, 'baro.healthy': true, 'navigation.lsCaptain': false, 'navigation.lsFirstOfficer': true }; await approachTest.settle();`);
    for (const [actionId, groupId] of [['navigation.lsCaptain.on', 'navigation.lsCaptain'], ['navigation.lsFirstOfficer.off', 'navigation.lsFirstOfficer']]) {
      await evaluate(`document.querySelector('[data-aircraft-action="${actionId}"]').click(); await approachTest.settle();`);
      assert.deepEqual(await evaluate('return approachTest.sent.at(-1);'), { actionId, groupId });
    }
    await evaluate(`approachTest.pending.clear(); approachTest.props.values['baro.healthy'] = false; await approachTest.settle();`);
    assert.equal(await evaluate(`return document.querySelector('[data-aircraft-action="navigation.lsCaptain.on"]').disabled;`), true);
    for (const change of [
      `approachTest.props.unavailable = ['controls.flapsHandle'];`,
      `approachTest.props.unavailable = []; approachTest.props.values['controls.flapsHandle'] = null;`,
      `approachTest.props.values['controls.flapsHandle'] = '3'; approachTest.props.sourceStatus = 'disconnected';`,
      `approachTest.props.sourceStatus = 'connected'; approachTest.controls.setAvailability({ enabled: false });`,
      `approachTest.controls.setAvailability({ enabled: true }); approachTest.props.actionCapabilities = {};`,
    ]) {
      await evaluate(`${change} await approachTest.settle();`);
      assert.equal(await evaluate(`return document.querySelector('${button('full')}').disabled;`), true);
    }
    assert.equal(await evaluate('return approachTest.sent.length;'), 6);
    // Exercise the shared canonical ATC inputs with the real stores and mobile DOM.
    await evaluate(`approachTest.controls.setAvailability({ enabled: true }); await atcTest.scenario(); window.scrollTo(0, 0);`);
    assert.equal(await evaluate(`return document.querySelector('[aria-label="Current squawk"]').textContent;`), '0042');
    const enter = async (label, value) => evaluate(`const input = document.querySelector('[aria-label="${label}"]'); input.value = '${value}'; input.dispatchEvent(new Event('input', { bubbles: true })); await approachTest.settle();`);
    for (const invalid of ['42', '1289', '12345', '12.3']) {
      await enter('Squawk code', invalid);
      assert.equal(await evaluate(`return document.querySelector('[data-transponder-controls] button[type="submit"]').disabled;`), true);
    }
    await enter('Squawk code', '0042');
    await evaluate(`document.querySelector('[data-transponder-controls] button[type="submit"]').click(); await approachTest.settle();`);
    assert.deepEqual(await evaluate('return atcTest.sent[0];'), { type: 'canonical', commandId: 'surveillance.squawk.set', input: { value: 42 } });
    assert.equal(await evaluate(`return document.querySelector('[data-transponder-controls] button[type="submit"]').disabled;`), true);
    await evaluate(`await atcTest.scenario({}, true);`);
    assert.equal(await evaluate(`return document.querySelector('[aria-label="Current squawk"]').textContent;`), '----');
    await enter('Minimums feet', '420');
    await evaluate(`document.querySelector('[data-minimums-controls] button[type="submit"]').click(); await approachTest.settle();`);
    assert.deepEqual(await evaluate('return atcTest.sent[1];'), { type: 'canonical', commandId: 'approach.minimums.baro', input: { value: 420 } });
    assert.equal(await evaluate('return document.documentElement.scrollWidth <= window.innerWidth;'), true);
    await evaluate(`document.querySelector('[data-transponder-controls]').scrollIntoView({ behavior: 'instant', block: 'start' });`);
    await wait(100);
    fs.writeFileSync(path.join(OUTPUT, 'atc-mobile.png'), (await windowRef.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, []);
    console.log('A32NX approach browser passed: mobile layout, exact selection, dispatch groups, duplicate taps, independent arming, missing/stale data and authorization gates.');
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(OUTPUT, 'failure.png'), (await windowRef.webContents.capturePage()).toPNG());
    console.error(error, errors);
    app.exit(1);
  }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
  const { buildAircraftControlCapabilities } = require(resolveBackendRuntimeFile('aircraft/aircraft-control-service.js'));
  const { normalizeProfileDocument, finalizeLoadedProfile } = require(resolveBackendRuntimeFile('aircraft/aircraft-profile-model.js'));
  const profile = finalizeLoadedProfile(normalizeProfileDocument(JSON.parse(fs.readFileSync(path.join(ROOT, 'backend/aircraft/profiles/bundled/msfs/fbw-a32nx.json'), 'utf8'))));
  profile._profileKey = 'bundled/msfs/fbw-a32nx';
  const capabilities = buildAircraftControlCapabilities(profile, { profileRevision: 1,
    capabilities: { actionTypes: ['aircraft-integration'], integrationTransports: ['simconnect-sequence', 'lvar', 'simbridge-mcdu'] } });
  const { createServer } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/vite/dist/node/index.js')).href);
  const { default: vue } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs')).href);
  const server = await createServer({ configFile: false, root: ROOT, logLevel: 'error',
    cacheDir: path.join(OUTPUT, 'vite-cache'), optimizeDeps: { entries: ['tests/fixtures/a32nx-approach-browser.js'] }, plugins: [vue(), {
      name: 'a32nx-approach-fixture', configureServer(viteServer) {
        viteServer.middlewares.use('/a32nx-approach-capabilities', (_req, res) => {
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(capabilities));
        });
        viteServer.middlewares.use('/a32nx-approach-test', (_req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/frontend-dist/tailwind.css"><style>body{margin:0;padding:16px;background:rgb(var(--background));color:rgb(var(--foreground));font-family:system-ui}</style></head><body><div id="app"></div><script type="module" src="/tests/fixtures/a32nx-approach-browser.js"></script></body></html>');
        });
      },
    }], resolve: { alias: {
      vue: path.join(ROOT, 'frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'),
      pinia: path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs'),
    } }, server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  try {
    const env = { ...process.env, FF_A32NX_APPROACH_TEST_URL: `http://127.0.0.1:${server.httpServer.address().port}/a32nx-approach-test` };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { env, cwd: ROOT, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill(), 90000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearTimeout(timer);
    assert.equal(code, 0, 'A32NX approach browser checks');
  } finally { await server.close(); }
}

(process.versions.electron ? runBrowser() : main()).catch((error) => { console.error(error); process.exit(1); });
