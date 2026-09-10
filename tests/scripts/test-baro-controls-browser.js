#!/usr/bin/env node
'use strict';

// Real Chromium, real Vue stores and backend catalogue; simulated altimeter samples.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, '.tmp', 'baro-controls-browser');
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
  const input = (value) => evaluate(`const el = document.querySelector('input'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); await baroTest.settle();`);
  const select = (label, value) => evaluate(`const el = document.querySelector('select[aria-label="${label}"]'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); await baroTest.settle();`);
  try {
    for (const profileId of ['fbw-a32nx', 'fbw-a380x', 'fenix-a319', 'fenix-a320', 'fenix-a321']) {
    await windowRef.loadURL(`${process.env.FF_BARO_CONTROLS_TEST_URL}?profile=${profileId}`);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate('return Boolean(window.baroTest && document.querySelector("[data-baro-controls]"));')) break;
      await wait(50);
    }
    assert.equal(await evaluate('return document.querySelector("select").value;'), 'both');
    if (profileId === 'fbw-a380x') {
      for (const width of [320, 390, 768]) {
        windowRef.setContentSize(width, 1000); await wait(100); await evaluate('await baroTest.scenario();');
        assert.equal(await evaluate('return document.documentElement.scrollWidth > innerWidth;'), false);
        assert.equal(await evaluate('return document.querySelectorAll("input").length;'), 0);
        assert.equal(await evaluate('return document.querySelector("button").disabled;'), false);
        fs.writeFileSync(path.join(OUTPUT, `baro-${profileId}-${width}.png`), (await windowRef.webContents.capturePage()).toPNG());
      }
      await evaluate('document.querySelector("button").click(); document.querySelector("button").click(); await baroTest.settle();');
      assert.deepEqual(await evaluate('return baroTest.sent;'), [{ type: 'canonical', commandId: 'baro.both.std', input: {} }]);
      assert.equal(await evaluate('return document.querySelector("button").disabled;'), true);
      await evaluate('baroTest.controls.resetPendingCommands(); await baroTest.scenario({ "baro.captain.std": true });');
      assert.deepEqual(await evaluate('return [...document.querySelectorAll("output")].map(el => el.textContent);'), ['STD', 'STD off']);
      await evaluate('await baroTest.scenario({ "baro.firstOfficer.active": false });');
      assert.equal(await evaluate('return document.querySelector("button").disabled;'), true);
      await select('Altimeter target', 'captain');
      assert.equal(await evaluate('return document.querySelector("button").disabled;'), false);
      await evaluate('document.querySelector("button").click(); await baroTest.settle();');
      assert.deepEqual(await evaluate('return baroTest.sent[1];'), { type: 'canonical', commandId: 'baro.captain.std', input: {} });
      await evaluate('baroTest.controls.resetPendingCommands(); await baroTest.scenario(); baroTest.specific.valueUpdatedAt["baro.captain.std"] = new Date(Date.now() - 3000).toISOString(); await baroTest.settle();');
      assert.equal(await evaluate('return document.querySelector("button").disabled;'), true);
      await evaluate('await baroTest.scenario(); baroTest.controls.setAvailability({ enabled: false }); await baroTest.settle();');
      assert.equal(await evaluate('return document.querySelector("button").disabled;'), true);
      await evaluate('baroTest.controls.applyControlCapabilities({ aircraftCommands: { profileKey: "bundled/msfs/other", profileRevision: 2, commands: [] } }); await baroTest.settle();');
      assert.equal(await evaluate('return document.querySelectorAll("[data-baro-controls]").length;'), 0);
      continue;
    }
    for (const width of [320, 390, 768]) {
      windowRef.setContentSize(width, 1000); await wait(100); await evaluate('await baroTest.scenario();');
      const layout = await evaluate(`return { overflow: document.documentElement.scrollWidth > innerWidth,
        heights: [...document.querySelectorAll('input, select, button')].map(el => el.getBoundingClientRect().height),
        font: parseFloat(getComputedStyle(document.querySelector('input')).fontSize) };`);
      assert.equal(layout.overflow, false, `no horizontal overflow at ${width}`);
      assert.ok(layout.heights.every((h) => h >= 48)); assert.ok(layout.font >= 16);
      await windowRef.webContents.capturePage(); await wait(100);
      fs.writeFileSync(path.join(OUTPUT, `baro-${profileId}-${width}.png`), (await windowRef.webContents.capturePage()).toPNG());
    }
    await input('1016.5');
    assert.equal(await evaluate('return document.querySelector("input").getAttribute("aria-invalid");'), 'true');
    assert.equal(await evaluate('return document.querySelector("button[type=submit]").disabled;'), true);
    await input('1016');
    await evaluate(`document.querySelector('form').requestSubmit(); document.querySelector('form').requestSubmit(); await baroTest.settle();`);
    assert.deepEqual(await evaluate('return baroTest.sent;'), [{ type: 'canonical', commandId: 'baro.both.qnhHpa', input: { value: 1016 } }]);
    assert.equal(await evaluate('return [...document.querySelectorAll("button, input, select")].every(el => el.disabled);'), true);
    assert.deepEqual(await evaluate('return [...document.querySelectorAll("output")].map(el => el.textContent);'), ['QNH 1013 hPa', 'QNH 1013 hPa']);
    await evaluate(`baroTest.controls.resetPendingCommands(); await baroTest.scenario({ 'baro.captain.value': 1016 });`);
    assert.deepEqual(await evaluate('return [...document.querySelectorAll("output")].map(el => el.textContent);'), ['QNH 1016 hPa', 'QNH 1013 hPa']);
    await select('Altimeter target', 'firstOfficer'); await select('Altimeter units', 'inHg'); await input('29.92');
    await evaluate(`document.querySelector('form').requestSubmit(); await baroTest.settle();`);
    assert.deepEqual(await evaluate('return baroTest.sent[1];'), { type: 'canonical', commandId: 'baro.firstOfficer.qnhInHg', input: { value: 29.92 } });
    await evaluate('baroTest.controls.resetPendingCommands(); await baroTest.scenario();');
    await select('Altimeter target', 'both');
    await evaluate(`document.querySelector('button[type=button]').click(); document.querySelector('button[type=button]').click(); await baroTest.settle();`);
    assert.deepEqual(await evaluate('return baroTest.sent[2];'), { type: 'canonical', commandId: 'baro.both.std', input: {} });
    assert.equal(await evaluate('return baroTest.sent.length;'), 3);
    await evaluate(`baroTest.controls.resetPendingCommands(); await baroTest.scenario({ 'baro.firstOfficer.mode': null });`);
    assert.equal(await evaluate('return document.querySelector("input").disabled;'), true);
    await select('Altimeter target', 'captain');
    assert.equal(await evaluate('return document.querySelector("input").disabled;'), false);
    await evaluate(`await baroTest.scenario({ 'baro.healthy': false });`);
    assert.equal(await evaluate('return [...document.querySelectorAll("input, button")].every(el => el.disabled);'), true);
    await evaluate('await baroTest.scenario(); baroTest.specific.updatedAt = new Date(Date.now() - 3000).toISOString(); await baroTest.settle();');
    assert.equal(await evaluate('return [...document.querySelectorAll("input, button")].every(el => el.disabled);'), true);
    await evaluate(`await baroTest.scenario(); baroTest.specific.valueUpdatedAt['${profileId.startsWith('fenix') ? 'baro.captain.qnh' : 'baro.captain.mode'}'] = new Date(Date.now() - 3000).toISOString(); await baroTest.settle();`);
    assert.equal(await evaluate('return document.querySelector("button[type=button]").disabled;'), true);
    await evaluate(`await baroTest.scenario({ 'baro.captain.mode': 0, 'baro.captain.valueMode': 0 });`);
    assert.equal(await evaluate('return document.querySelector("output").textContent;'), 'STD');
    await evaluate('await baroTest.scenario(); baroTest.controls.setAvailability({ enabled: false }); await baroTest.settle();');
    assert.equal(await evaluate('return [...document.querySelectorAll("input, button")].every(el => el.disabled);'), true);
    await evaluate(`baroTest.controls.applyControlCapabilities({ aircraftCommands: { profileKey: 'bundled/msfs/other', profileRevision: 2, commands: [] } }); await baroTest.settle();`);
    assert.equal(await evaluate('return document.querySelectorAll("[data-baro-controls]").length;'), 0);
    }
    for (const profileId of ['fbw-a32nx', 'fenix-a319', 'fenix-a320', 'fenix-a321']) {
      await windowRef.loadURL(`${process.env.FF_BARO_CONTROLS_TEST_URL}?profile=${profileId}&guide=1`);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate('return Boolean(document.querySelector("[data-more-state-queries]"));')) break;
        await wait(50);
      }
      assert.equal(await evaluate('return document.querySelector("[data-more-state-queries]").open;'), false);
      for (const width of [320, 768]) {
        windowRef.setContentSize(width, 1000); await wait(100);
        await evaluate('await baroTest.scenario(); document.querySelector("[data-more-state-queries]").open = true; await baroTest.settle();');
        const guide = await evaluate(`return { overflow: document.documentElement.scrollWidth > innerWidth,
          text: document.querySelector('[data-state-query-guide]').textContent };`);
        assert.equal(guide.overflow, false, `${profileId} expanded questions at ${width}`);
        assert.match(guide.text, /what is captain qnh/); assert.match(guide.text, /are both altimeters on std/);
        assert.match(guide.text, /what is the autobrake setting/);
        assert.deepEqual(await evaluate('return baroTest.sent;'), [], 'opening the question guide never dispatches a command');
        await windowRef.webContents.capturePage(); await wait(100);
        fs.writeFileSync(path.join(OUTPUT, `query-guide-${profileId}-${width}.png`), (await windowRef.webContents.capturePage()).toPNG());
      }
    }
    assert.deepEqual(errors, []);
    console.log('Altimeter browser passed: mobile layout, both default, independent readouts, validation, hPa/inHg/STD dispatch, duplicate taps, power, stale data, viewer and profile gates.');
    app.exit(0);
  } catch (error) {
    try { fs.writeFileSync(path.join(OUTPUT, 'failure.png'), (await windowRef.webContents.capturePage()).toPNG()); } catch {}
    console.error(error, errors);
    app.exit(1);
  }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
  const { buildAircraftControlCapabilities } = require(resolveBackendRuntimeFile('aircraft/aircraft-control-service.js'));
  const loader = require(resolveBackendRuntimeFile('aircraft/aircraft-profile-loader.js'));
  const capabilities = Object.fromEntries(['fbw-a32nx', 'fbw-a380x', 'fenix-a319', 'fenix-a320', 'fenix-a321'].map(id => {
    loader.setActiveProfile(id);
    return [id, buildAircraftControlCapabilities(loader.getActiveProfile(), { profileRevision: 1,
      capabilities: { actionTypes: ['aircraft-integration'], integrationTransports: ['simconnect-sequence', 'mobiflight-calculator', 'lvar'] } })];
  }));
  const { createServer } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/vite/dist/node/index.js')).href);
  const { default: vue } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs')).href);
  const server = await createServer({ configFile: false, root: ROOT, logLevel: 'error',
    cacheDir: path.join(OUTPUT, 'vite-cache'), optimizeDeps: { entries: ['tests/fixtures/baro-controls-browser.js'] }, plugins: [vue(), {
      name: 'baro-controls-fixture', configureServer(viteServer) {
        viteServer.middlewares.use('/baro-controls-capabilities', (_req, res) => {
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(capabilities));
        });
        viteServer.middlewares.use('/baro-controls-test', (_req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/frontend-dist/tailwind.css"><style>body{margin:0;padding:16px;background:rgb(var(--background));color:rgb(var(--foreground));font-family:system-ui}</style></head><body><div id="app"></div><script type="module" src="/tests/fixtures/baro-controls-browser.js"></script></body></html>');
        });
      },
    }], resolve: { alias: {
      vue: path.join(ROOT, 'frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'),
      pinia: path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs'),
    } }, server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  try {
    const env = { ...process.env, FF_BARO_CONTROLS_TEST_URL: `http://127.0.0.1:${server.httpServer.address().port}/baro-controls-test` };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { env, cwd: ROOT, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill(), 90000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearTimeout(timer);
    assert.equal(code, 0, 'Altimeter browser checks');
  } finally { await server.close(); }
}

(process.versions.electron ? runBrowser() : main()).catch((error) => { console.error(error); process.exit(1); });
