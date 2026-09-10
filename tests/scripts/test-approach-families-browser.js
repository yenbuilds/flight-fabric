const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..'), OUT = path.join(ROOT, '.tmp', 'approach-families-browser');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function browser() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(OUT, `user-data-${process.pid}`)); app.disableHardwareAcceleration(); app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.on('window-all-closed', () => {}); await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1180, height: 700, useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = []; win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  const evaluate = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
  try {
    await win.loadURL(`${process.env.FF_APPROACH_FAMILIES_URL}/fixture`);
    for (let i = 0; i < 100 && !await evaluate('return Boolean(window.familiesReady);'); i++) await wait(50);
    assert.equal(await evaluate('return Boolean(window.familiesReady);'), true);
    for (const width of [1180, 390, 320]) {
      win.setContentSize(width, width === 1180 ? 700 : 844); await wait(50);
      for (const profile of ['pmdg-737', 'pmdg-777', 'fenix-a320']) {
        await evaluate(`await familiesTest.select('${profile}');`);
        const fenix = profile === 'fenix-a320';
        const selectButton = fenix ? '[aria-label="Speedbrake HALF"]' : `[data-aircraft-action="${profile === 'pmdg-737' ? 'flightControls' : 'controls'}.speedbrake.half"]`;
        const group = fenix ? '[data-approach-command="surfaces.spoilers.set"]' : `[data-aircraft-control-group="${profile === 'pmdg-737' ? 'flightControls' : 'controls'}.speedbrake"]`;
        await evaluate(`for (let el = document.querySelector('${selectButton}'); el; el = el.parentElement) { if (el.tagName === 'DETAILS') el.open = true; } await familiesTest.tick(); document.querySelector('${selectButton}').scrollIntoView({ block: 'center' }); await familiesTest.tick();`);
        await win.webContents.capturePage(); await wait(100);
        assert.equal(await evaluate(`return document.querySelector('${selectButton}').getBoundingClientRect().height >= 36;`), true, `${profile} visible touch target`);
        assert.equal(await evaluate('return document.documentElement.scrollWidth <= innerWidth;'), true, `${profile} ${width}`);
        fs.writeFileSync(path.join(OUT, `${profile}-${width}.png`), (await win.webContents.capturePage()).toPNG());
        assert.equal(await evaluate(`return document.querySelector('${selectButton}').disabled;`), false, `${profile} enabled`);
        await evaluate(`document.querySelector('${selectButton}').click(); await familiesTest.tick();`);
        assert.deepEqual(await evaluate('return familiesTest.sent[0];'), { type: 'canonical', commandId: 'surfaces.spoilers.set', input: { value: 'half' } });
        assert.equal(await evaluate(`return [...document.querySelectorAll('${group} button')].every(b => b.disabled);`), true, `${profile} pending shared physical control`);
        await evaluate('familiesTest.clear(); await familiesTest.publish();');
        const brakeButton = fenix ? '[aria-label="Autobrake MEDIUM"]' : `[data-aircraft-action="${profile === 'pmdg-737' ? 'gear.autobrake.level3' : 'controls.autobrake.disarm'}"]`;
        await evaluate(`document.querySelector('${brakeButton}').click(); await familiesTest.tick();`);
        assert.deepEqual(await evaluate('return familiesTest.sent.at(-1);'), { type: 'canonical', commandId: 'surfaces.autobrake.set', input: { value: fenix ? 'medium' : profile === 'pmdg-737' ? '3' : 'disarm' } });
        await evaluate('familiesTest.clear(); await familiesTest.publish();');
        if (fenix) {
          await evaluate('familiesTest.controls.setAvailability({ enabled: false }); await familiesTest.tick();');
          assert.equal(await evaluate(`return document.querySelector('[data-approach-command="surfaces.flaps.set"] legend').textContent.includes('2');`), true, 'read-only clients retain flap selection');
          assert.equal(await evaluate(`return document.querySelector('[data-approach-command="surfaces.autobrake.set"] legend').textContent.includes('LOW');`), true, 'read-only clients retain autobrake selection');
          assert.equal(await evaluate(`return [...document.querySelectorAll('[data-fenix-approach-controls] button')].every(b => b.disabled);`), true, 'read-only clients cannot write approach controls');
          await evaluate('familiesTest.controls.setAvailability({ enabled: true }); await familiesTest.publish();');
          await evaluate(`document.querySelector('[aria-label="Flaps FULL"]').click(); await familiesTest.tick();`);
          assert.deepEqual(await evaluate('return familiesTest.sent.at(-1);'), { type: 'canonical', commandId: 'surfaces.flaps.set', input: { value: 'full' } });
          await evaluate('familiesTest.clear(); await familiesTest.publish();');
          await evaluate(`document.querySelector('[aria-label="Arm ground spoilers"]').click(); await familiesTest.tick();`);
          assert.deepEqual(await evaluate('return familiesTest.sent.at(-1);'), { type: 'canonical', commandId: 'surfaces.spoilersArmed.set', input: { value: true } });
          assert.equal(await evaluate(`return document.querySelector('${selectButton}').disabled;`), true);
          await evaluate('familiesTest.clear(); await familiesTest.publish(false, { "controls.autobrake.low": true, "controls.autobrake.max": true });');
          assert.equal(await evaluate(`return document.querySelector('${brakeButton}').disabled;`), true, 'contradictory lamps');
          await evaluate('familiesTest.clear(); await familiesTest.publish(false, { "baro.healthy": false, "controls.speedbrakePosition": 0, "controls.autobrake.low": false });');
          assert.equal(await evaluate(`return document.querySelector('[data-approach-command="surfaces.autobrake.set"] legend span').textContent;`), '\u2014', 'unpowered lamps cannot be shown as autobrake OFF');
          assert.equal(await evaluate(`return document.querySelector('[data-approach-command="surfaces.spoilers.set"] legend span').textContent;`), '\u2014', 'unpowered zero cannot be shown as spoilers ARMED');
        }
        await evaluate('familiesTest.clear(); await familiesTest.publish(true);');
        assert.equal(await evaluate(`return document.querySelector('${selectButton}').disabled;`), true, `${profile} stale`);
        await evaluate('await familiesTest.publish(); familiesTest.controls.aircraftCommandCatalogue.commands = {}; familiesTest.props.actionCapabilities = {}; await familiesTest.tick();');
        assert.equal(await evaluate(`return document.querySelector('${selectButton}')?.disabled ?? true;`), true, `${profile} unavailable`);

      }
    }
    assert.deepEqual(errors, []); console.log('Approach family browser checks passed: real Fenix and PMDG panels at desktop/390px/320px, aircraft-specific inputs, shared pending guards, stale and contradictory data.');
    win.destroy(); app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(OUT, 'failure.png'), (await win.webContents.capturePage()).toPNG()); console.error(error, errors); app.exit(1);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { resolveBackendRuntimeFile: runtime } = require('./backend-runtime-paths');
  const loader = require(runtime('aircraft/aircraft-profile-loader.js'));
  const { buildAircraftControlCapabilities } = require(runtime('aircraft/aircraft-control-service.js'));
  const catalogues = {};
  for (const id of ['pmdg-737', 'pmdg-777', 'fenix-a320']) {
    loader.setActiveProfile(id); catalogues[id] = buildAircraftControlCapabilities(loader.getActiveProfile(), {
      profileRevision: loader.getAircraftSpecificConfig().profileRevision,
      capabilities: { actionTypes: ['aircraft-integration'], integrationTransports: ['sdk', 'simconnect-sequence', 'lvar', 'mobiflight-calculator'] },
    });
  }
  const { createServer } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/vite/dist/node/index.js')));
  const { default: vue } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs')));
  const server = await createServer({ configFile: false, root: ROOT, logLevel: 'error', cacheDir: path.join(OUT, 'vite-cache'),
    optimizeDeps: { noDiscovery: true }, plugins: [vue(), { name: 'atc-fixture', configureServer(vite) {
      vite.middlewares.use('/capabilities', (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(catalogues)); });
      vite.middlewares.use('/fixture', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/frontend-dist/tailwind.css"><style>body{margin:0;padding:16px;font-family:system-ui;background:rgb(var(--background));color:rgb(var(--foreground))}</style></head><body><div id="app"></div><script type="module" src="/tests/fixtures/approach-families-browser.js"></script></body></html>'); });
    } }], resolve: { alias: { vue: path.join(ROOT, 'frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'), pinia: path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs') } }, server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  try {
    const env = { ...process.env, FF_APPROACH_FAMILIES_URL: `http://127.0.0.1:${server.httpServer.address().port}` }; delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { cwd: ROOT, windowsHide: true, env, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill(), 60000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); clearTimeout(timer); assert.equal(code, 0);
  } finally { await server.close(); }
}
(process.versions.electron ? browser() : main()).catch((error) => { console.error(error); process.exit(1); });
