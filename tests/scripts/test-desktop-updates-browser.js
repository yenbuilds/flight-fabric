#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, '.tmp/desktop-updates-browser');
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
    await win.loadURL(process.env.FF_UPDATE_TEST_URL);
    for (let i = 0; i < 100 && !await evaluate('return Boolean(window.updateTest);'); i++) await wait(50);
    assert(await evaluate('return Boolean(window.updateTest);'), `fixture mounted: ${errors.join('\n')}`);
    assert.equal(await evaluate('return updateTest.updates.supported;'), true, 'late initial status cannot replace a newer event');
    const click = text => evaluate(`const button = [...document.querySelectorAll('section button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if (!button) throw new Error('Missing button '+${JSON.stringify(text)}+'; '+document.body.innerText); button.click(); await updateTest.nextTick();`);
    await click('Download update');
    assert.equal(await evaluate('return document.querySelector("progress").value;'), 25);
    await click('Cancel download');
    assert.deepEqual(await evaluate('return updateTest.calls;'), ['download', 'cancel']);
    await evaluate('updateTest.settleDownload(); await Promise.resolve(); await updateTest.nextTick();');
    assert.equal(await evaluate('return updateTest.updates.phase;'), 'error', 'late download reply cannot replace the newer cancellation event');
    await evaluate("updateTest.emit({phase:'ready',message:'Ready when you are.'}); updateTest.settings.restartActionSaveRequired=true; await updateTest.nextTick();");
    assert(await evaluate("return [...document.querySelectorAll('section button')].find(b=>b.textContent==='Restart and update').disabled;"), 'unsaved settings block restart');
    await evaluate('updateTest.settings.restartActionSaveRequired=false; await updateTest.nextTick();');
    await click('Restart and update');
    assert(!await evaluate("return updateTest.calls.includes('install');"), 'declining confirmation never installs');
    for (const width of [1000, 360]) {
      win.setContentSize(width, 760);
      await wait(100);
      assert(await evaluate('return document.documentElement.scrollWidth <= innerWidth;'), 'controls fit viewport '+width);
      assert(await evaluate('return document.querySelector("#update-banner").getBoundingClientRect().height <= parseFloat(document.body.style.paddingTop)+1;'), 'banner offset contains actions '+width);
      fs.writeFileSync(path.join(OUTPUT, 'updates-'+width+'.png'), (await win.webContents.capturePage()).toPNG());
    }
    assert.equal(await evaluate('return document.querySelector("section script");'), null, 'release notes render as text');
    await evaluate('updateTest.accept(true);');
    await click('Restart and update');
    assert.deepEqual(await evaluate('return updateTest.calls;'), ['download', 'cancel', 'install']);
    await evaluate('updateTest.cleanup(); updateTest.emit({phase:"current"}); await updateTest.nextTick();');
    assert.equal(await evaluate('return updateTest.updates.phase;'), 'preparing', 'retired subscriptions cannot change state');
    assert.deepEqual(errors, [], 'components render without errors');
    console.log('Desktop update browser checks passed at 1000px and 360px (simulated trusted bridge, no installer executed).');
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error, errors); win.destroy(); app.exit(1); }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  require('node:child_process').execFileSync(process.execPath, [path.join(ROOT, 'electron/node_modules/tailwindcss/lib/cli.js'), '-c', path.join(ROOT, 'tailwind.config.js'), '-i', path.join(ROOT, 'frontend/tailwind-input.css'), '-o', path.join(OUTPUT, 'tailwind.css'), '--minify'], { cwd: ROOT, windowsHide: true, stdio: 'pipe' });
  const { createViteTestServer } = require('./vite-test-server');
  const { default: vue } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs')).href);
  const server = await createViteTestServer({ configFile: false, root: ROOT, logLevel: 'error', cacheDir: path.join(OUTPUT, 'vite-cache'),
    optimizeDeps: { entries: ['tests/fixtures/desktop-updates-browser.js'] },
    plugins: [vue(), { name: 'desktop-update-fixture', configureServer(vite) {
      vite.middlewares.use('/update-fixture-style.css', (_request, response) => { response.setHeader('Content-Type', 'text/css'); response.end(fs.readFileSync(path.join(OUTPUT, 'tailwind.css'))); });
      vite.middlewares.use('/updates-test', (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><head><link rel="stylesheet" href="/update-fixture-style.css"><link rel="stylesheet" href="/frontend/index.css"><link rel="stylesheet" href="/frontend/ui-polish.css"></head><body><div id="app"></div><script type="module" src="/tests/fixtures/desktop-updates-browser.js"></script></body></html>');
      });
    } }], resolve: { alias: { vue: path.join(ROOT, 'frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'), pinia: path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs') } },
    server: { host: '127.0.0.1', port: 0, watch: null } });
  await server.listen();
  try {
    const env = { ...process.env, FF_UPDATE_TEST_URL: `http://127.0.0.1:${server.httpServer.address().port}/updates-test` };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { env, cwd: ROOT, windowsHide: true, stdio: 'inherit' });
    const timeout = setTimeout(() => child.kill(), 45000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearTimeout(timeout); assert.equal(code, 0, 'desktop update browser checks');
  } finally { await server.close(); }
}
(process.versions.electron ? browser() : main()).catch(error => { console.error(error); process.exit(1); });
