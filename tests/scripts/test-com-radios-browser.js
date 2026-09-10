#!/usr/bin/env node
'use strict';

// Real Chromium, real Vue stores and backend catalogue; simulated radio samples.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, '.tmp', 'com-radios-browser');
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
  const input = (value) => evaluate(`const el = document.querySelector('#com-1-frequency'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); await comTest.settle();`);
  try {
    await windowRef.loadURL(process.env.FF_COM_RADIO_TEST_URL);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate('return Boolean(window.comTest && document.querySelectorAll("[data-com-radio]").length === 2);')) break;
      await wait(50);
    }
    assert.equal(await evaluate('return document.querySelectorAll("[data-com-radio]").length;'), 2);
    for (const width of [320, 390, 768]) {
      windowRef.setContentSize(width, 1000);
      await wait(100);
      await evaluate('await comTest.scenario();');
      const layout = await evaluate(`return { width: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        heights: [...document.querySelectorAll('input, button')].map(el => el.getBoundingClientRect().height),
        fonts: [...document.querySelectorAll('input')].map(el => parseFloat(getComputedStyle(el).fontSize)),
        cards: [...document.querySelectorAll('[data-com-radio]')].map(el => el.getBoundingClientRect().x) };`);
      assert.ok(Math.abs(layout.width - width) <= 2);
      assert.equal(layout.overflow, false, `no horizontal scrolling at ${width}px`);
      assert.ok(layout.heights.every((height) => height >= 48), '48px touch targets');
      assert.ok(layout.fonts.every((size) => size >= 16), 'readable inputs without mobile auto-zoom');
      assert.equal(layout.cards[0] === layout.cards[1], width < 768, 'phone cards stack');
      fs.writeFileSync(path.join(OUTPUT, `com-${width}.png`), (await windowRef.webContents.capturePage()).toPNG());
    }
    await input('123.020');
    assert.equal(await evaluate('return document.querySelector("#com-1-frequency").getAttribute("aria-invalid");'), 'true');
    assert.equal(await evaluate('return document.querySelector("[data-com-radio=\\"1\\"] button[type=submit]").disabled;'), true);
    await input('123.005');
    assert.equal(await evaluate('return document.querySelector("button[aria-label=\\"Swap COM 1 frequencies\\"]").disabled;'), true, 'swap cannot discard an unsent edit');
    await evaluate(`document.querySelector('[data-com-radio="1"]').requestSubmit(); document.querySelector('[data-com-radio="1"]').requestSubmit(); await comTest.settle();`);
    assert.deepEqual(await evaluate('return comTest.sent;'), [{ type: 'canonical', commandId: 'radios.com1.setStandby', input: { value: 123.005 } }]);
    assert.equal(await evaluate('return [...document.querySelectorAll("[data-com-radio=\\"1\\"] button")].every(el => el.disabled);'), true);
    assert.equal(await evaluate('return document.querySelector("[data-com-radio=\\"1\\"] output").textContent;'), '121.700', 'active value is never optimistic');
    await evaluate(`comTest.controls.resetPendingCommands(); await comTest.scenario({ 'radios.com1.standbyMhz': 123.005 });`);
    await evaluate(`const swap = document.querySelector('button[aria-label="Swap COM 1 frequencies"]'); swap.click(); swap.click(); await comTest.settle();`);
    assert.deepEqual(await evaluate('return comTest.sent[1];'), { type: 'canonical', commandId: 'radios.com1.swap', input: {} });
    assert.equal(await evaluate('return comTest.sent.length;'), 2, 'duplicate swap sends once');
    await evaluate('comTest.controls.resetPendingCommands(); await comTest.scenario();');
    await input('136.990');
    await evaluate(`document.querySelector('button[aria-label="Switch COM 1 to entered frequency"]').click(); await comTest.settle();`);
    assert.deepEqual(await evaluate('return comTest.sent[2];'), { type: 'canonical', commandId: 'radios.com1.switchTo', input: { value: 136.99 } });
    await evaluate(`comTest.controls.resetPendingCommands(); await comTest.scenario({ 'radios.com1.spacingMode': 0 });`);
    await input('123.005');
    assert.equal(await evaluate('return document.querySelector("#com-1-frequency").getAttribute("aria-invalid");'), 'true', '25kHz radio rejects an 8.33kHz channel');
    await evaluate(`await comTest.scenario({ 'radios.com1.status': 2 });`);
    assert.equal(await evaluate('return document.querySelector("#com-1-frequency").disabled;'), true, 'unpowered radio disabled');
    assert.equal(await evaluate('return document.querySelector("#com-2-frequency").disabled;'), false, 'other radio remains independent');
    await evaluate('await comTest.scenario();');
    await input('122.800');
    await evaluate(`comTest.specific.valueUpdatedAt['radios.com1.standbyMhz'] = new Date(Date.now() - 3000).toISOString(); await comTest.settle();`);
    assert.equal(await evaluate('return document.querySelector("#com-1-frequency").disabled;'), true, 'an old field cannot be refreshed by a recent publication');
    assert.equal(await evaluate('return document.querySelector("#com-1-frequency").value;'), '', 'losing a radio readback clears its unsent edit');
    assert.equal(await evaluate('return document.querySelector("#com-2-frequency").disabled;'), false, 'a stale COM1 field does not disable COM2');
    await evaluate('await comTest.scenario(); comTest.specific.receivedAt = Date.now() - 3000; await comTest.settle();');
    assert.equal(await evaluate('return [...document.querySelectorAll("input, button")].every(el => el.disabled);'), true, 'old delivery cannot authorize radio controls');
    await evaluate('await comTest.scenario(); comTest.specific.updatedAt = new Date(Date.now() - 3000).toISOString(); await comTest.settle();');
    assert.equal(await evaluate('return [...document.querySelectorAll("input, button")].every(el => el.disabled);'), true, 'stale snapshot disables controls');
    await evaluate('await comTest.scenario(); comTest.controls.setAvailability({ enabled: false }); await comTest.settle();');
    assert.equal(await evaluate('return [...document.querySelectorAll("input, button")].every(el => el.disabled);'), true, 'viewer controls disabled');
    await evaluate('comTest.controls.setAvailability({ enabled: true }); await comTest.scenario();');
    await input('122.800');
    await evaluate(`comTest.controls.applyControlCapabilities({ aircraftCommands: { profileKey: 'bundled/msfs/other', profileRevision: 2, commands: [] } }); await comTest.settle();`);
    assert.equal(await evaluate('return document.querySelectorAll("[data-com-radio]").length;'), 0, 'unsupported aircraft hides COM controls');
    assert.deepEqual(errors, [], 'no browser runtime errors');
    console.log('COM browser passed: 320/390/768px, channel validation, standby/swap/switch, duplicate taps, no optimistic values, power, spacing, stale data, viewer mode and profile changes.');
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
    capabilities: { actionTypes: ['aircraft-integration'], integrationTransports: ['simconnect-sequence'] } });
  const { createServer } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/vite/dist/node/index.js')).href);
  const { default: vue } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs')).href);
  const server = await createServer({ configFile: false, root: ROOT, logLevel: 'error',
    cacheDir: path.join(OUTPUT, 'vite-cache'), optimizeDeps: { entries: ['tests/fixtures/com-radios-browser.js'] }, plugins: [vue(), {
      name: 'com-radio-fixture', configureServer(viteServer) {
        viteServer.middlewares.use('/com-radio-capabilities', (_req, res) => {
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(capabilities));
        });
        viteServer.middlewares.use('/com-radio-test', (_req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/frontend-dist/tailwind.css"><style>body{margin:0;padding:16px;background:rgb(var(--background));color:rgb(var(--foreground));font-family:system-ui}</style></head><body><div id="app"></div><script type="module" src="/tests/fixtures/com-radios-browser.js"></script></body></html>');
        });
      },
    }], resolve: { alias: {
      vue: path.join(ROOT, 'frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'),
      pinia: path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs'),
    } }, server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  try {
    const env = { ...process.env, FF_COM_RADIO_TEST_URL: `http://127.0.0.1:${server.httpServer.address().port}/com-radio-test` };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { env, cwd: ROOT, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill(), 90000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearTimeout(timer);
    assert.equal(code, 0, 'COM browser checks');
  } finally { await server.close(); }
}

(process.versions.electron ? runBrowser() : main()).catch((error) => { console.error(error); process.exit(1); });
