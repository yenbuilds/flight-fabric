'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, '.tmp', 'aircraft-workbench-browser');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runBrowser() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(OUTPUT, `browser-${process.pid}`));
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('disable-gpu-compositing'); app.commandLine.appendSwitch('disable-gpu-sandbox');
  await app.whenReady();
  const windowRef = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [];
  windowRef.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const evaluate = body => windowRef.webContents.executeJavaScript(`(async()=>{${body}})()`);
  async function until(expression) {
    for (let attempt = 0; attempt < 150; attempt++) { if (await evaluate(`return !!(${expression});`)) return; await delay(100); }
    throw new Error(`Timed out: ${expression}`);
  }
  const click = text => evaluate(`const button = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)}); if (!button || button.disabled) throw new Error('Missing or disabled button: ' + ${JSON.stringify(text)}); button.click();`);
  const fill = (label, value) => evaluate(`const label = [...document.querySelectorAll('label')].find(el => el.childNodes[0].textContent.trim() === ${JSON.stringify(label)}); if (!label) throw new Error('Missing label'); const el = label.querySelector('input,textarea,select'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', {bubbles:true})); await workbenchTest.settle();`);
  try {
    await windowRef.loadURL(process.env.FF_WORKBENCH_TEST_URL);
    await until('window.workbenchTest');
    await click('Open workbench');
    await until('workbenchTest.workbench.cases.length && !workbenchTest.workbench.busy');
    assert.equal(await evaluate('return workbenchTest.workbench.report.profileName.includes("737");'), true);
    assert.equal(await evaluate('return document.querySelector(".wb-caution").textContent.includes("Use a separate simulator test flight.");'), true);
    await click('New test session');
    await fill('Aircraft version / channel', 'Browser fixture aircraft');
    await fill('Simulator version / build', 'Browser fixture simulator');
    await click('Create session');
    await until('workbenchTest.workbench.session && !workbenchTest.workbench.busy');
    const sessionId = await evaluate('return workbenchTest.workbench.session.id;');
    await fill('Find a test', 'beacon');
    await until('document.querySelectorAll(".wb-case-list button").length');
    await evaluate('document.querySelector(".wb-case-list button").click(); await workbenchTest.settle();');
    await fill('Starting aircraft state', 'Synthetic powered aircraft, beacon off');
    await click('Start capture');
    await until('workbenchTest.workbench.captureStatus.active && !workbenchTest.workbench.busy');
    await click('Mark step');
    await until('workbenchTest.workbench.captureStatus.active.markerCount === 1 && !workbenchTest.workbench.busy');
    assert.equal(await evaluate('return [...document.querySelectorAll(".wb-case-list button")].every(button => button.disabled);'), true);
    await click('Open aircraft controls');
    assert.equal(await evaluate('return workbenchTest.tabs.activeTabId;'), 'autopilot');
    await delay(500);
    await click('Stop & save capture');
    await until('!workbenchTest.workbench.captureStatus.active && workbenchTest.workbench.session.captures.length');
    assert.equal(await evaluate('return workbenchTest.workbench.counts.pass;'), 0);
    await fill('Input or voice phrase used', 'beacon on');
    await fill('Cockpit observation', 'Browser fixture observation; not a live simulator test.');
    await fill('Observed result', 'pass');
    await evaluate('workbenchTest.workbench.draftFor(workbenchTest.workbench.selectedCaseId).captureId = workbenchTest.workbench.session.captures[0].id; await workbenchTest.settle();');
    await click('Save test result');
    await until('workbenchTest.workbench.counts.pass === 1 && !workbenchTest.workbench.busy');
    assert.equal(await evaluate('return workbenchTest.workbench.hasUnsaved;'), false);
    await evaluate('window.workbenchDownloads = []; const create = URL.createObjectURL; URL.createObjectURL = blob => { workbenchDownloads.push(blob); return create(blob); };');
    await click('Export saved session');
    await until('document.querySelector(".wb-export")');
    assert.equal(await evaluate('return workbenchDownloads.length;'), 0, 'export requires reviewing the reminder first');
    assert.equal(await evaluate('return document.querySelector(".wb-export").textContent.includes("AI service");'), true);
    await click('Cancel export');
    assert.equal(await evaluate('return workbenchDownloads.length;'), 0);
    await click('Export saved session');
    // Capture the generated Blob without writing a download outside the fixture.
    await evaluate('HTMLAnchorElement.prototype.click = function() {};');
    await click('Download JSON');
    assert.equal(await evaluate('return JSON.parse(await workbenchDownloads[0].text()).id;'), sessionId);
    await evaluate('document.querySelector(".wb-storage").open = true;');
    assert.equal(await evaluate('return document.querySelector(".wb-storage").textContent.includes("256.0 MB");'), true);
    await click('Delete file');
    await click('Keep file');
    assert.equal(await evaluate('return workbenchTest.workbench.sessions.length;'), 1, 'cancelled cleanup preserves the session');
    for (const width of [1280, 390]) {
      windowRef.setContentSize(width, 1000); await delay(250);
      assert.equal(await evaluate('return document.documentElement.scrollWidth > innerWidth;'), false, `no horizontal overflow at ${width}`);
      await evaluate('document.querySelector(".wb-toolbar").scrollIntoView();');
      await delay(100);
      fs.writeFileSync(path.join(OUTPUT, `workbench-${width}.png`), (await windowRef.webContents.capturePage()).toPNG());
    }
    windowRef.setContentSize(1280, 1000);
    await windowRef.loadURL(process.env.FF_WORKBENCH_TEST_URL);
    await until('window.workbenchTest'); await click('Open workbench');
    await until('workbenchTest.workbench.sessions.length && !workbenchTest.workbench.busy');
    await fill('Saved sessions', sessionId);
    await until('workbenchTest.workbench.session && workbenchTest.workbench.counts.pass === 1');
    assert.equal(await evaluate('return workbenchTest.workbench.session.captures.length;'), 1);
    await evaluate('document.querySelector(".wb-storage").open = true;');
    await click('Delete file');
    await click('Delete selected file');
    await until('!workbenchTest.workbench.session && !workbenchTest.workbench.busy');
    assert.equal(await evaluate('return workbenchTest.workbench.storage.usedBytes;'), 0);
    await windowRef.loadURL(process.env.FF_WORKBENCH_TEST_URL);
    await until('window.workbenchTest'); await click('Open workbench');
    await until('workbenchTest.workbench.report && !workbenchTest.workbench.busy');
    assert.equal(await evaluate('return workbenchTest.workbench.sessions.length;'), 0, 'confirmed deletion persists across reload');
    assert.deepEqual(errors, []);
    console.log('Workbench Chromium checks passed: create, capture, save, resume, export privacy reminder, confirmed cleanup, and desktop/mobile layout.');
    app.exit(0);
  } catch (error) {
    console.error(error, errors);
    try { fs.writeFileSync(path.join(OUTPUT, 'failure.png'), (await windowRef.webContents.capturePage()).toPNG()); }
    catch (captureError) { console.error('Failure screenshot unavailable:', captureError.message); }
    app.exit(1);
  }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const { loadReport } = require('../../scripts/aircraft-support');
  const { resolveBackendRuntimeFile: runtime } = require('../../scripts/backend-runtime-paths');
  const { createWorkbenchService } = require(runtime('aircraft/support/service.js'));
  const { handleWorkbenchRequest } = require(runtime('aircraft/support/http.js'));
  const report = loadReport('pmdg-737');
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(wss, 'listening');
  wss.on('connection', socket => {
    socket.on('message', bytes => {
      assert.deepEqual(JSON.parse(bytes), { type: 'requestState' });
      socket.send(JSON.stringify({ type: 'simState', simconnectConnected: true, inMenu: false }));
    });
    let value = false;
    const timer = setInterval(() => {
      value = !value; const at = new Date().toISOString();
      socket.send(JSON.stringify({ type: 'aircraftSpecificState', profileKey: report.contract.profileKey, profileRevision: 1,
        available: true, sourceStatus: { overall: 'connected' }, updatedAt: at,
        values: Object.fromEntries(report.contract.fields.map(field => [field.id, value])),
        valueUpdatedAt: Object.fromEntries(report.contract.fields.map(field => [field.id, at])) }));
    }, 100);
    socket.on('close', () => clearInterval(timer));
  });
  const service = createWorkbenchService({ root: fs.mkdtempSync(path.join(OUTPUT, 'sessions-')), wsPort: wss.address().port,
    build: { appVersion: 'browser-test', runtimeFingerprint: 'fixture', instanceId: 'fixture' }, reportLoader: () => report,
    profileList: () => [{ name: report.profileName, profileKey: report.contract.profileKey }],
    getLoadedAircraft: () => ({ profileKey: report.contract.profileKey, title: 'PMDG 737-800 (browser fixture)' }) });
  const { createServer } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/vite/dist/node/index.js')).href);
  const { default: vue } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs')).href);
  const server = await createServer({ configFile: false, root: ROOT, logLevel: 'error', cacheDir: path.join(OUTPUT, 'vite-cache'),
    optimizeDeps: { entries: ['tests/fixtures/aircraft-workbench-browser.js'] }, plugins: [vue(), {
      name: 'aircraft-workbench-test', configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (!req.url.startsWith('/api/aircraft-support/')) return next();
          void handleWorkbenchRequest(req, res, { token: 'browser-fixture', local: true, service: () => service });
        });
        vite.middlewares.use('/workbench-test', (_req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:16px;background:#0a0e14;color:#e2e8f0;font-family:system-ui}*{box-sizing:border-box}#app{max-width:1152px;margin:auto}</style></head><body><div id="app"></div><script type="module" src="/tests/fixtures/aircraft-workbench-browser.js"></script></body></html>');
        });
      },
    }], resolve: { alias: { vue: path.join(ROOT, 'frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'), pinia: path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs') } },
    server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  try {
    const env = { ...process.env, FF_WORKBENCH_TEST_URL: `http://127.0.0.1:${server.httpServer.address().port}/workbench-test` };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { env, cwd: ROOT, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill(), 90000);
    const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    clearTimeout(timer); assert.equal(code, 0, 'Workbench browser checks');
  } finally { await service.close(); for (const socket of wss.clients) socket.terminate(); await new Promise(resolve => wss.close(resolve)); await server.close(); }
}
(process.versions.electron ? runBrowser() : main()).catch(error => { console.error(error); process.exit(1); });
