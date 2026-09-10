// Real Chromium and Vue, with a fixture backend. Never connects to a simulator.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = require('./repo-scratch').getRepoScratchPath('command-browser');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runBrowser() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(OUTPUT, 'chromium'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1200, height: 1000,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  const evaluate = code => window.webContents.executeJavaScript(`(async () => { ${code} })()`, true);
  try {
    await window.loadURL(process.env.FF_COMMAND_BROWSER_URL);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate('return Boolean(window.commandTest && document.querySelector("details"));')) break;
      await wait(50);
    }
    assert.equal(await evaluate('return document.querySelector("details").open;'), false);
    await evaluate('document.querySelector("summary").click(); await commandTest.settle();');
    for (const id of ['pmdg-737', 'fbw-a380x', 'inibuilds-a350-900']) {
      await evaluate(`await commandTest.profile(${JSON.stringify(id)});`);
      for (const width of [320, 390, 1200]) {
        window.setContentSize(width, 1000); await wait(100);
        const layout = await evaluate(`return { overflow: document.documentElement.scrollWidth > innerWidth,
          heights: [...document.querySelectorAll('input, select, button')].map(el => el.getBoundingClientRect().height),
          editors: document.querySelectorAll('[data-command-editor]').length };`);
        assert.equal(layout.overflow, false, `${id} at ${width}`);
        assert.ok(layout.editors >= 25); assert.ok(layout.heights.every(height => height >= 48));
        fs.writeFileSync(path.join(OUTPUT, `${id}-${width}.png`), (await window.webContents.capturePage()).toPNG());
      }
    }
    assert.deepEqual(await evaluate('return commandTest.sent;'), [], 'browsing controls never sends a command');
    await evaluate('await commandTest.profile("pmdg-737");');
    const type = (label, value) => evaluate(`const el = [...document.querySelectorAll('input, select')].find(el => el.getAttribute('aria-label') === ${JSON.stringify(label)});
      el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await commandTest.settle();`);
    await type('Search aircraft controls', 'seat belts');
    assert.equal(await evaluate('return document.querySelectorAll("[data-command-editor]").length;'), 1);
    await type('Seat belts target', 'auto');
    await evaluate('document.querySelector("button[type=submit]").click(); document.querySelector("button[type=submit]").click(); await commandTest.settle();');
    assert.deepEqual(await evaluate('return commandTest.sent;'), [{ type: 'canonical', commandId: 'cabin.seatBelts.set', input: { value: 'auto' } }]);
    await evaluate('commandTest.controls.resetPendingCommands(); await commandTest.settle();');
    await type('Search aircraft controls', 'selected speed');
    await type('Selected speed target', '400');
    assert.equal(await evaluate('return document.querySelector("button[type=submit]").disabled;'), true);
    await type('Selected speed target', '250');
    await evaluate('document.querySelector("button[type=submit]").click(); await commandTest.settle();');
    assert.deepEqual(await evaluate('return commandTest.sent.at(-1);'), { type: 'canonical', commandId: 'flightGuidance.speed.set', input: { value: 250 } });
    await evaluate('await commandTest.profile("pmdg-777");');
    assert.equal(await evaluate('return [...document.querySelectorAll("input")].find(el => el.getAttribute("aria-label") === "Selected speed target").value;'), '');
    await type('Aircraft control category', 'systems');
    assert.equal(await evaluate('return [...document.querySelectorAll("[data-command-editor]")].every(el => el.dataset.commandEditor.startsWith("systems."));'), true);
    await evaluate('commandTest.controls.setAvailability({ enabled: false }); await commandTest.settle();');
    assert.equal(await evaluate('return [...document.querySelectorAll("button")].every(el => el.disabled);'), true);
    await evaluate('await commandTest.profile("inibuilds-a330");');
    assert.equal(await evaluate('return document.querySelectorAll("[data-aircraft-command-browser]").length;'), 0);
    assert.deepEqual(errors, []);
    console.log('Command browser passed: 320/390/1200px layouts, search, categories, explicit inputs, canonical dispatch, duplicate taps, profile resets and unavailable controls.');
    app.exit(0);
  } catch (error) {
    console.error(error, errors);
    try { fs.writeFileSync(path.join(OUTPUT, 'failure.png'), (await window.webContents.capturePage()).toPNG()); } catch {}
    app.exit(1);
  }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const { resolveBackendRuntimeFile: runtime } = require('./backend-runtime-paths');
  const loader = require(runtime('aircraft/aircraft-profile-loader.js'));
  const { buildAircraftControlCapabilities } = require(runtime('aircraft/aircraft-control-service.js'));
  const profiles = Object.fromEntries(['pmdg-737', 'pmdg-777', 'fbw-a380x', 'inibuilds-a350-900', 'inibuilds-a330'].map(id =>
    [id, buildAircraftControlCapabilities(loader.loadProfile(`bundled/msfs/${id}`), { profileRevision: 1,
      capabilities: { actionTypes: ['aircraft-integration'], integrationTransports: ['sdk', 'simconnect-sequence', 'lvar', 'mobiflight-calculator'] } })]));
  const { createServer } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/vite/dist/node/index.js')).href);
  const { default: vue } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs')).href);
  const server = await createServer({ configFile: false, root: ROOT, logLevel: 'error', cacheDir: path.join(OUTPUT, 'vite-cache'),
    optimizeDeps: { entries: ['tests/fixtures/command-browser.js'] }, plugins: [vue(), {
      name: 'command-browser-fixture', configureServer(server) {
        server.middlewares.use('/command-capabilities', (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(profiles)); });
        server.middlewares.use('/command-test', (_req, res) => { res.setHeader('Content-Type', 'text/html');
          res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/frontend-dist/tailwind.css"><style>body{margin:0;padding:16px;background:rgb(var(--background));color:rgb(var(--foreground));font-family:system-ui}</style></head><body><div id="app"></div><script type="module" src="/tests/fixtures/command-browser.js"></script></body></html>'); });
      },
    }], resolve: { alias: { vue: path.join(ROOT, 'frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'), pinia: path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs') } },
    server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  try {
    const env = { ...process.env, FF_COMMAND_BROWSER_URL: `http://127.0.0.1:${server.httpServer.address().port}/command-test` };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { env, cwd: ROOT, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill(), 60000);
    try { assert.equal(await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }), 0, 'Command browser checks'); }
    finally { clearTimeout(timer); }
  } finally { await server.close(); }
}
(process.versions.electron ? runBrowser() : main()).catch(error => { console.error(error); process.exit(1); });
