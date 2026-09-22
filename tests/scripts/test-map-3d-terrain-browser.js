#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, '.tmp/map-3d-terrain-browser');
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
  const win = new BrowserWindow({ show: false, width: 800, height: 650,
    webPreferences: { contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false } });
  const evaluate = async body => {
    const result = await win.webContents.executeJavaScript(`(() => { try { return eval(${JSON.stringify(body)}); } catch (error) { return { __error: error.stack }; } })()`);
    if (result?.__error) throw new Error(result.__error);
    return result;
  };
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const expectColor = (sample, channel, message) => assert(sample.pixel[channel] > 2 * Math.max(...sample.pixel.slice(0, 3).filter((_value, index) => index !== channel)), `${message}: ${JSON.stringify(sample)}`);
  try {
    await win.loadURL(process.env.FF_TERRAIN_TEST_URL);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await evaluate('Boolean(window.terrainTest)')) break;
      await wait(50);
    }
    assert(await evaluate('Boolean(window.terrainTest)'), `fixture initialized: ${errors.join('\n')}`);
    for (const scale of [1, 5]) {
      await evaluate(`terrainTest.setup(${scale}); terrainTest.finish('horizon');`);
      const loading = await evaluate('terrainTest.sample()');
      expectColor(loading, 2, 'coarse imagery remains while finer images load');
      assert.equal(loading.ground, (300 * scale) - 4, 'readback uses the visible fallback while finer images load');
      await evaluate("terrainTest.finish('base'); terrainTest.finish('detail');");
      const detail = await evaluate('terrainTest.sample()');
      expectColor(detail, 1, `the airport surface is visible through higher coarse meshes at x${scale}`);
      assert.equal(detail.ground, 100 * scale, 'ground readback matches the rendered detail');
      expectColor(await evaluate(`terrainTest.sample(1000, 0, ${150 * scale})`), 1, 'the height transition is joined without a hole');
      expectColor(await evaluate('terrainTest.sample(2300, 0)'), 0, 'base terrain remains outside the detail footprint');
      fs.writeFileSync(path.join(OUTPUT, `terrain-x${scale}.png`), (await win.webContents.capturePage()).toPNG());
      await evaluate('terrainTest.setTiles(false);');
      const fallback = await evaluate('terrainTest.sample()');
      expectColor(fallback, 0, 'removing detail restores the base surface');
      assert.equal(fallback.ground, (200 * scale) - 2);
    }
    win.setContentSize(390, 700);
    await wait(100);
    await evaluate("terrainTest.resize(); terrainTest.setup(5); terrainTest.finish('horizon'); terrainTest.finish('base'); terrainTest.finish('detail');");
    expectColor(await evaluate('terrainTest.sample()'), 1, 'phone renderer retains the detail surface');
    fs.writeFileSync(path.join(OUTPUT, 'terrain-phone.png'), (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, [], 'terrain shaders compile without renderer errors');
    console.log('3D terrain rendering passed: delayed detail, raised coarse layers, x1/x5, geographic coverage, fallback and phone width.');
    app.exit(0);
  } catch (error) {
    console.error(error);
    fs.writeFileSync(path.join(OUTPUT, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    app.exit(1);
  }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const { createViteTestServer } = require('./vite-test-server');
  const server = await createViteTestServer({ configFile: false, root: ROOT, logLevel: 'error', cacheDir: path.join(OUTPUT, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, exclude: ['three'] },
    plugins: [{ name: 'terrain-fixture', configureServer(vite) {
      vite.middlewares.use('/terrain-test', (_req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html><body style="margin:0;background:#182331"><div id="map" style="width:100vw;height:100vh"></div><script type="module" src="/tests/fixtures/map-3d-terrain-browser.js"></script></body></html>');
      });
    } }], server: { host: '127.0.0.1', watch: null } });
  await server.listen();
  try {
    const env = { ...process.env, FF_TERRAIN_TEST_URL: `http://127.0.0.1:${server.httpServer.address().port}/terrain-test` };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { env, cwd: ROOT, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill(), 90000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearTimeout(timer);
    assert.equal(code, 0, 'terrain renderer checks');
  } finally { await server.close(); }
}
(process.versions.electron ? browser() : main()).catch(error => { console.error(error); process.exit(1); });
