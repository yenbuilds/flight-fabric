#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, '.tmp/system-recovery-browser');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function browser() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(OUTPUT, `profile-${process.pid}`));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1000, height: 760,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const evaluate = body => win.webContents.executeJavaScript(`(async () => { ${body} })()`);
  try {
    await win.loadURL(process.env.FF_RECOVERY_TEST_URL);
    for (let i = 0; i < 100 && !await evaluate('return Boolean(window.recoveryTest);'); i++) await wait(50);
    assert(await evaluate('return Boolean(window.recoveryTest);'), `fixture mounted: ${errors.join('\n')}`);
    await evaluate("document.getElementById('system-stop-backend-btn').click(); await recoveryTest.nextTick();");
    await wait(80);
    assert(await evaluate("return recoveryTest.host.backendStatus==='stopped' && !!document.getElementById('system-desktop-recovery-note') && !document.getElementById('system-pc-managed-note') && !document.getElementById('system-history-index');"), 'stop preserves native recovery without retaining websocket privileges');
    await evaluate("document.getElementById('system-restart-backend-btn').click(); await recoveryTest.nextTick();");
    await wait(80);
    assert.equal(await evaluate("return document.getElementById('system-host-error')?.textContent.trim();"), 'Backend could not start', 'failed startup stays visible');
    await evaluate("document.getElementById('system-start-backend-btn').click(); await recoveryTest.nextTick(); document.getElementById('system-start-backend-btn').click();");
    assert(await evaluate("return document.getElementById('system-start-backend-btn').disabled && recoveryTest.calls.filter(v=>v==='start').length===1;"), 'pending native start disables duplicate actions');
    await evaluate('recoveryTest.finishStart(); await recoveryTest.nextTick();');
    await wait(80);
    assert.equal(await evaluate('return recoveryTest.host.backendStatus;'), 'running');
    assert.deepEqual(await evaluate('return recoveryTest.calls;'), ['stop', 'restart', 'start']);
    assert.deepEqual(await evaluate('return recoveryTest.sent.map(message=>message.type);'), ['requestHistoryIndexStatus', 'requestDevicePairingRequests'], 'native recovery does not send privileged websocket requests while disconnected');
    await evaluate("recoveryTest.profiles.setAuthorizationScope('full-control'); recoveryTest.status.setWebsocket('ready'); await recoveryTest.nextTick();");
    assert(await evaluate("return !!document.getElementById('system-history-index') && !document.getElementById('system-desktop-recovery-note');"), 'acknowledged reconnect restores connected administration');
    assert.deepEqual(errors, [], 'source component should render every recovery transition without errors');
    console.log('System recovery browser checks passed (simulated trusted bridge; no real services started or stopped).');
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error, errors); win.destroy(); app.exit(1); }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const { createServer } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/vite/dist/node/index.js')).href);
  const { default: vue } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs')).href);
  const server = await createServer({ configFile: false, root: ROOT, logLevel: 'error', cacheDir: path.join(OUTPUT, 'vite-cache'),
    optimizeDeps: { entries: ['tests/fixtures/system-recovery-browser.js'] },
    plugins: [vue(), { name: 'system-recovery-fixture', configureServer(vite) {
      vite.middlewares.use('/recovery-test', (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><div id="app"></div><script type="module" src="/tests/fixtures/system-recovery-browser.js"></script></body></html>');
      });
    } }], resolve: { alias: { vue: path.join(ROOT, 'frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'), pinia: path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs') } },
    server: { host: '127.0.0.1', port: 0, watch: null } });
  await server.listen();
  try {
    const env = { ...process.env, FF_RECOVERY_TEST_URL: `http://127.0.0.1:${server.httpServer.address().port}/recovery-test` };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { env, cwd: ROOT, windowsHide: true, stdio: 'inherit' });
    const timeout = setTimeout(() => child.kill(), 45000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearTimeout(timeout); assert.equal(code, 0, 'system recovery browser checks');
  } finally { await server.close(); }
}
(process.versions.electron ? browser() : main()).catch(error => { console.error(error); process.exit(1); });
