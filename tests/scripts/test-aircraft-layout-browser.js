#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, '.tmp', 'aircraft-layout-browser');
const AIRCRAFT = ['pmdg-737', 'pmdg-777', 'fenix-a320', 'fbw-a32nx', 'fbw-a380x', 'inibuilds-a350-900'];
const templateFor = id => id === 'fenix-a320' ? 'fenix-a32x' : id.startsWith('inibuilds-a350') ? 'inibuilds-a350' : id;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function browser() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(OUTPUT, `user-data-${process.pid}`));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1440, height: 1000,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const evaluate = body => win.webContents.executeJavaScript(`(async () => { ${body} })()`);
  async function ready(selector) {
    for (let n = 0; n < 100; n++) {
      if (await evaluate(`return Boolean(document.querySelector(${JSON.stringify(selector)}));`)) return;
      await wait(50);
    }
    throw new Error(`Not rendered: ${selector}`);
  }
  try {
    await win.loadURL(process.env.FF_AIRCRAFT_LAYOUT_TEST_URL);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await ready('[data-aircraft-template="pmdg-737"]');
    for (const id of AIRCRAFT) {
      await evaluate(`await layoutTest.scenario(${JSON.stringify(id)});`);
      await ready(`[data-aircraft-template="${templateFor(id)}"]`);
      for (const width of [1440, 390, 320]) {
        win.setContentSize(width, 1000);
        await wait(120);
        await evaluate("window.scrollTo({ top: 0, behavior: 'instant' });");
        await wait(80);
        const result = await evaluate(`return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          overflowingElements: [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth && getComputedStyle(el.parentElement).overflowX !== 'auto').slice(0, 10).map(el => ({ tag: el.tagName, class: el.className, width: el.getBoundingClientRect().width })),
          presets: document.querySelectorAll('[data-aircraft-presets-section]').length,
          browsers: document.querySelectorAll('[data-aircraft-command-browser]').length,
          lights: document.querySelectorAll('[data-exterior-light-controls]').length,
          lighting: [...document.querySelectorAll('[data-cockpit-lighting-presets]')].every(el => el.closest('[data-aircraft-presets-section]')),
          takeoff: [...document.querySelectorAll('[data-aircraft-preset="configuration.lights.takeoff"]')].every(el => el.closest('[data-aircraft-presets-section]')),
          repeatedIds: [...document.querySelectorAll('[id]')].map(el => el.id).filter((id, index, ids) => ids.indexOf(id) !== index),
        };`);
        assert.equal(result.overflow, false, `${id}: ${width}px has no horizontal overflow: ${JSON.stringify(result.overflowingElements)}`);
        assert.equal(result.presets, 1, `${id}: one preset section`);
        assert.equal(result.browsers, 0, `${id}: catalogue is absent from the main page`);
        assert.equal(result.lights, 0, `${id}: exterior controls are not repeated above the template`);
        assert.equal(result.lighting && result.takeoff, true, `${id}: presets stay together`);
        assert.deepEqual(result.repeatedIds, [], `${id}: unique element IDs`);
        if (id === 'inibuilds-a350-900') {
          assert.equal(await evaluate(`return document.querySelectorAll('[data-aircraft-control-group="flightGuidance.lsCaptain"], [data-aircraft-control-group="flightGuidance.lsFirstOfficer"]').length;`), 0, 'A350 LS controls appear only in shared EFIS');
        }
        if (width !== 320) {
          fs.writeFileSync(path.join(OUTPUT, `${id}-${width}.png`), (await win.webContents.capturePage()).toPNG());
          if (await evaluate(`return Boolean(document.querySelector('[data-aircraft-avionics-section]'));`)) {
            await evaluate(`document.querySelector('[data-aircraft-avionics-section]').scrollIntoView({ behavior: 'instant' });`);
            await wait(80);
            fs.writeFileSync(path.join(OUTPUT, `${id}-avionics-${width}.png`), (await win.webContents.capturePage()).toPNG());
          }
        }
      }
      assert.equal(await evaluate(`return document.querySelector('[data-aircraft-preset="configuration.lights.takeoff"] button').disabled;`), false, `${id}: grouped takeoff preset is ready`);
      await evaluate(`document.querySelector('[data-aircraft-preset="configuration.lights.takeoff"] button').click(); await layoutTest.settle();`);
      assert.deepEqual(await evaluate('return layoutTest.sent.at(-1);'), { type: 'canonical', commandId: 'configuration.lights.takeoff', input: {} }, `${id}: grouped preset dispatches its existing command`);
      await evaluate(`document.querySelector('[data-aircraft-controls-trigger]').click(); await layoutTest.settle();`);
      await ready('[data-aircraft-controls-modal] input[type="search"]');
      assert.equal(await evaluate('return document.activeElement.type;'), 'search', `${id}: dialog focuses search`);
      const count = await evaluate('return document.querySelectorAll("[data-command-editor]").length;');
      const expected = await evaluate('return Object.values(layoutTest.controls.aircraftCommandCatalogue.commands).filter(command => command.kind !== "preset").length;');
      assert.equal(count, expected, `${id}: every non-preset command remains accessible`);
      assert.equal(await evaluate('return document.documentElement.scrollWidth > innerWidth;'), false, `${id}: dialog fits phone`);
      await wait(80);
      fs.writeFileSync(path.join(OUTPUT, `${id}-library.png`), (await win.webContents.capturePage()).toPNG());
      const command = await evaluate(`return Object.values(layoutTest.controls.aircraftCommandCatalogue.commands).find(command => command.kind !== 'preset' && command.input.kind === 'boolean');`);
      await evaluate(`const search = document.querySelector('[data-aircraft-controls-modal] input[type="search"]'); search.value = ${JSON.stringify(command.label)}; search.dispatchEvent(new Event('input', { bubbles: true })); await layoutTest.settle();`);
      assert.ok(await evaluate(`return document.querySelectorAll('[data-command-editor]').length < ${count};`), `${id}: library search narrows the results`);
      await evaluate(`document.querySelector('[data-command-editor="${command.id}"] [data-command-value="true"]').click(); await layoutTest.settle();`);
      assert.deepEqual(await evaluate('return layoutTest.sent.at(-1);'), { type: 'canonical', commandId: command.id, input: { value: true } }, `${id}: library dispatches the selected command`);
      await evaluate(`document.querySelector('[aria-label="Close aircraft controls"]').focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));`);
      assert.equal(await evaluate('return document.activeElement.closest("[data-aircraft-controls-modal]") !== null;'), true, `${id}: dialog retains keyboard focus`);
      await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await layoutTest.settle();`);
      assert.equal(await evaluate('return Boolean(document.querySelector("[data-aircraft-controls-modal]"));'), false);
      assert.equal(await evaluate('return document.activeElement.hasAttribute("data-aircraft-controls-trigger");'), true, 'closing restores focus');
    }
    assert.deepEqual(errors, [], 'no runtime errors');
    console.log('Aircraft layout passed: six families at desktop, 390px and 320px; grouped presets, unique controls, command dialog and focus restoration.');
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(OUTPUT, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    console.error(error, errors);
    app.exit(1);
  }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const { resolveBackendRuntimeFile: runtime } = require('./backend-runtime-paths');
  const loader = require(runtime('aircraft/aircraft-profile-loader.js'));
  const { buildAircraftControlCapabilities } = require(runtime('aircraft/aircraft-control-service.js'));
  const registry = require(runtime('aircraft/aircraft-integrations/index.js')).defaultAircraftIntegrationRegistry;
  const fixtures = Object.fromEntries(AIRCRAFT.map(id => {
    const templateId = templateFor(id);
    const profile = loader.loadProfile(`bundled/msfs/${id}`);
    const capabilities = buildAircraftControlCapabilities(profile, { profileRevision: 1,
      capabilities: { simulator: 'msfs', actionTypes: ['aircraft-integration', 'key-event', 'lvar'],
        integrationTransports: ['sdk', 'simconnect-sequence', 'lvar', 'mobiflight-calculator'] } });
    const values = Object.fromEntries(Object.values(registry.getById(templateId).fields).map(field => {
      const decode = field.sources[0]?.decode;
      return [field.id, decode?.type === 'boolean' ? false : decode?.type === 'enum' ? Object.values(decode.values)[0] : 0];
    }));
    for (const command of Object.values(capabilities.aircraftCommands.commands)) {
      for (const field of command.brightnessFields || []) values[field] = 50;
    }
    Object.assign(values, { 'mcp.headingDeg': 270, 'mcp.altitudeFt': 12000, 'mcp.speed': 250,
      'mcp.courseCaptainDeg': 270, 'mcp.courseFirstOfficerDeg': 270,
      'radios.nav1ActiveMhz': 109.5, 'radios.nav2ActiveMhz': 109.5, 'radios.nav1StandbyMhz': 110.3, 'radios.nav2StandbyMhz': 110.3 });
    return [id, { templateId, capabilities, values }];
  }));
  const { createServer } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/vite/dist/node/index.js')).href);
  const { default: vue } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs')).href);
  const server = await createServer({ configFile: false, root: ROOT, logLevel: 'error',
    cacheDir: path.join(OUTPUT, 'vite-cache'), optimizeDeps: { entries: ['tests/fixtures/aircraft-layout-browser.js'] },
    plugins: [vue(), { name: 'aircraft-layout-fixture', configureServer(vite) {
      vite.middlewares.use('/aircraft-layout-fixtures', (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(fixtures)); });
      vite.middlewares.use('/aircraft-layout-test', (_req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/frontend-dist/tailwind.css"><style>body{margin:0;padding:16px;background:#171b22;color:#d1d5db;font-family:system-ui}#app{max-width:1440px;margin:auto}</style></head><body><div id="app"></div><script type="module" src="/tests/fixtures/aircraft-layout-browser.js"></script></body></html>');
      });
    } }], resolve: { alias: { vue: path.join(ROOT, 'frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'),
      pinia: path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs') } }, server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  try {
    const env = { ...process.env, FF_AIRCRAFT_LAYOUT_TEST_URL: `http://127.0.0.1:${server.httpServer.address().port}/aircraft-layout-test` };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { env, cwd: ROOT, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill(), 90000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearTimeout(timer);
    assert.equal(code, 0, 'aircraft layout browser checks');
  } finally { await server.close(); }
}
(process.versions.electron ? browser() : main()).catch(error => { console.error(error); process.exit(1); });
