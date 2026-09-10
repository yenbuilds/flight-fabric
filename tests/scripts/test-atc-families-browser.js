const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..'), OUT = path.join(ROOT, '.tmp', 'atc-families-browser');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function browser() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(OUT, `user-data-${process.pid}`)); app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('force-prefers-reduced-motion');
  app.on('window-all-closed', () => {}); await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1180, height: 700, useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = []; win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  const evaluate = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
  try {
    await win.loadURL(`${process.env.FF_ATC_FAMILIES_URL}/fixture`);
    for (let i = 0; i < 100 && !await evaluate('return Boolean(window.familiesReady);'); i++) await wait(50);
    assert.equal(await evaluate('return Boolean(window.familiesReady);'), true);
    for (const width of [1180, 390, 320]) {
      win.setContentSize(width, width === 1180 ? 700 : 844); await wait(50);
      for (const profile of ['pmdg-737', 'pmdg-777', 'fenix-a320', 'inibuilds-a350-900']) {
        await evaluate(`await familiesTest.select('${profile}');`);
        assert.equal(await evaluate('return document.documentElement.scrollWidth <= innerWidth;'), true, `${profile} ${width}`);
        assert.equal(await evaluate("return Boolean(document.querySelector('[data-efis-controls]'));"), true);
        assert.equal(await evaluate("return Boolean(document.querySelector('[data-minimums-controls]'));"), false, 'never show A32NX MCDU instructions');
        assert.equal(await evaluate("return Boolean(document.querySelector('[data-transponder-controls]'));"), !profile.startsWith('inibuilds'));
        if (profile === 'pmdg-777') assert.equal(await evaluate("return document.querySelector('[aria-label=\"Captain current minimums\"]').textContent;"), 'BARO 420 ft');
        await evaluate('familiesTest.controls.setAvailability({ enabled: false }); await familiesTest.tick();');
        assert.equal(await evaluate("return document.querySelector('[aria-label=\"Captain ND range\"]').parentElement.textContent.includes('(80)');"), true, 'read-only clients retain fresh EFIS readbacks');
        if (!profile.startsWith('inibuilds')) assert.equal(await evaluate("return document.querySelector('[aria-label=\"Current squawk\"]').textContent;"), '0042', 'read-only clients retain squawk readback');
        assert.equal(await evaluate("return [...document.querySelectorAll('button')].every(b => b.disabled);"), true, 'read-only clients cannot write');
        await evaluate('familiesTest.controls.setAvailability({ enabled: true }); await familiesTest.publish();');
        await wait(100);
        fs.writeFileSync(path.join(OUT, `${profile}-${width}.png`), (await win.webContents.capturePage()).toPNG());
        await evaluate(`const select = document.querySelector('[aria-label="Captain ND range"]'); select.value = '160'; select.dispatchEvent(new Event('change', { bubbles: true })); await familiesTest.tick(); document.querySelector('[aria-label="Set captain range"]').click(); await familiesTest.tick();`);
        assert.deepEqual(await evaluate('return familiesTest.sent[0];'), { type: 'canonical', commandId: 'navigation.captain.range', input: { value: '160' } });
        assert.equal(await evaluate("return document.querySelector('[aria-label=\"Set captain range\"]').disabled;"), true);
        await evaluate(`familiesTest.controls.resetPendingCommands(); await familiesTest.publish();`);
        const selector = profile.startsWith('pmdg') ? 'First officer minimums radio' : 'First officer LS off';
        await evaluate(`document.querySelector('[aria-label="${selector}"]').click(); await familiesTest.tick();`);
        assert.deepEqual(await evaluate('return familiesTest.sent[1];'), { type: 'canonical', commandId: profile.startsWith('pmdg') ? 'approach.firstOfficer.minimumsMode' : 'navigation.firstOfficer.ls', input: { value: profile.startsWith('pmdg') ? 'radio' : false } });
        await evaluate('familiesTest.controls.resetPendingCommands(); await familiesTest.publish(true);');
        assert.equal(await evaluate("return [...document.querySelectorAll('[data-efis-controls] button')].every((b) => b.disabled);"), true);
        if (!profile.startsWith('inibuilds')) {
          await evaluate('await familiesTest.publish();');
          await evaluate(`const input = document.querySelector('[aria-label="Squawk code"]'); input.value = '0042'; input.dispatchEvent(new Event('input', { bubbles: true })); await familiesTest.tick(); document.querySelector('[data-transponder-controls] button[type="submit"]').click(); await familiesTest.tick();`);
          assert.deepEqual(await evaluate('return familiesTest.sent.at(-1);'), { type: 'canonical', commandId: 'surveillance.squawk.set', input: { value: 42 } });
        }
        await evaluate(`familiesTest.specific.applyProfile({ _profileKey: 'local/msfs/wrong', profileRevision: 99 }); await familiesTest.tick();`);
        assert.equal(await evaluate("return [...document.querySelectorAll('[data-efis-controls] button, [data-transponder-controls] button')].every((b) => b.disabled);"), true);
      }
    }
    // Exercise the complete page: isolated card fixtures cannot catch missing ribbon destinations.
    await win.loadURL(`${process.env.FF_ATC_FAMILIES_URL}/fixture?shell=1`);
    for (let i = 0; i < 100 && !await evaluate('return Boolean(window.familiesReady);'); i++) await wait(50);
    for (const width of [390, 320]) {
      win.setContentSize(width, 844);
      for (const profile of ['fbw-a32nx', 'pmdg-737', 'pmdg-777', 'fenix-a320', 'inibuilds-a350-900']) {
        await evaluate(`await familiesTest.select('${profile}');`);
        const directNavigation = profile.startsWith('inibuilds');
        const launcher = directNavigation ? 'nav[data-aircraft-section-ribbon]' : profile === 'pmdg-737' ? '.pmdg-mobile-section-ribbon__current' : '.aircraft-section-ribbon__current';
        const template = profile === 'fenix-a320' ? 'fenix-a32x' : profile.startsWith('inibuilds') ? 'inibuilds-a350' : profile;
        for (let i = 0; i < 100 && !await evaluate(`return Boolean(document.querySelector('[data-aircraft-template="${template}"] ${launcher}'));`); i++) await wait(50);
        assert.equal(await evaluate(`return Boolean(document.querySelector('[data-aircraft-template="${template}"] ${launcher}'));`), true, `${profile} template has finished mounting`);
        await wait(100);
        if (profile.startsWith('pmdg')) {
          const presetButton = '[data-takeoff-lights-preset] button';
          const presetButtons = [presetButton,
            '[data-aircraft-preset="configuration.lights.takeoff"] button',
            '[data-aircraft-preset="configuration.apu.start"] button'];
          assert.equal(await evaluate(`return document.querySelector('${presetButton}').disabled;`), false, `${profile} exposes Set takeoff lights in the lighting panel`);
          await evaluate(`familiesTest.specific.sourceStatuses = { sdk: 'stale', simvar: 'connected' }; await familiesTest.tick();`);
          for (const selector of presetButtons) {
            assert.equal(await evaluate(`return document.querySelector('${selector}').disabled;`), true, `${profile} stale SDK data disables ${selector}`);
            await evaluate(`document.querySelector('${selector}').click(); await familiesTest.tick();`);
          }
          assert.equal(await evaluate('return familiesTest.sent.length;'), 0, 'stale SDK data cannot dispatch any PMDG preset');
          await evaluate('await familiesTest.publish();');
          for (const selector of presetButtons) {
            assert.equal(await evaluate(`return document.querySelector('${selector}').disabled;`), false, `${profile} ${selector} recovers when SDK data returns`);
          }
          await evaluate(`familiesTest.controls.setAvailability({ enabled: false }); await familiesTest.tick(); document.querySelector('${presetButton}').click();`);
          assert.equal(await evaluate('return familiesTest.sent.length;'), 0, 'read-only clients cannot apply the preset');
          await evaluate(`familiesTest.controls.setAvailability({ enabled: true }); familiesTest.specific.clearSnapshot('stale'); await familiesTest.tick();`);
          assert.equal(await evaluate(`return document.querySelector('${presetButton}').disabled;`), true, 'stale aircraft data disables the preset');
          await evaluate(`await familiesTest.publish(); familiesTest.controls.setCommandPending({ type: 'canonical', commandId: 'configuration.lights.takeoff', input: {} }); await familiesTest.tick();`);
          assert.equal(await evaluate(`return document.querySelector('${presetButton}').disabled;`), true, 'voice requests also lock the lighting-panel preset');
          await evaluate(`familiesTest.controls.resetPendingCommands(); await familiesTest.tick(); document.querySelector('${presetButton}').click(); await familiesTest.tick(); document.querySelector('${presetButton}').click();`);
          assert.deepEqual(await evaluate('return familiesTest.sent;'), [{ type: 'canonical', commandId: 'configuration.lights.takeoff', input: {} }], 'one click dispatches the shared preset and repeat clicks cannot duplicate it');
          assert.equal(await evaluate(`return document.querySelector('[data-aircraft-preset="configuration.lights.takeoff"] button').disabled;`), true, 'the page shortcut shares the pending state');
          await evaluate('familiesTest.controls.resetPendingCommands(); await familiesTest.publish();');
        }
        const cards = await evaluate(`return [...document.querySelectorAll('.aircraft-page-tools [id^="aircraft-page-"]')].map(el => ({ id: el.id, title: el.getAttribute('aria-label') === 'EFIS controls' ? 'EFIS & approach' : el.getAttribute('aria-label') }));`);
        assert.ok(cards.length > 0, `${profile} has shared cards`);
        for (const card of cards) {
          if (!directNavigation) await evaluate(`document.querySelector('${launcher}').click(); await familiesTest.tick();`);
          const found = await evaluate(`const button = [...document.querySelectorAll('[data-aircraft-section-choice], [data-pmdg-section-choice], nav[data-aircraft-section-ribbon] button')].find(el => (el.querySelector('strong')?.textContent || el.getAttribute('aria-label')) === ${JSON.stringify(card.title)}); if (!button) return false; button.click(); await familiesTest.tick(); return true;`);
          assert.equal(found, true, `${profile} ${width}: ${card.title} is reachable from the ribbon`);
          await wait(650);
          assert.equal(await evaluate(`return document.activeElement?.id;`), card.id, 'navigation focuses the actual shared card');
          const position = await evaluate(`const rect = document.getElementById(${JSON.stringify(card.id)}).getBoundingClientRect(); return { top: rect.top, height: innerHeight, scroll: document.querySelector('#vue-main-root').scrollTop, expanded: document.querySelector('${launcher}').getAttribute('aria-expanded') };`);
          assert.ok(position.top >= 0 && position.top < position.height / 2, `${profile} ${card.id}: the shared card is scrolled into view: ${JSON.stringify(position)}`);
          if (!directNavigation) assert.equal(await evaluate(`return sessionStorage.getItem('flight-fabric:aircraft-section:v1:' + encodeURIComponent(familiesTest.specific.activeProfileKey));`), card.id.replace('aircraft-', ''), 'section memory preserves the shared destination');
        }
        assert.equal(await evaluate('return document.documentElement.scrollWidth <= innerWidth;'), true, `${profile} shell fits ${width}`);
      }
    }
    assert.deepEqual(errors, []); console.log('ATC family browser checks passed: card interactions and read-only readbacks; full-page mobile navigation to shared controls across five families.');
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
  for (const id of ['fbw-a32nx', 'pmdg-737', 'pmdg-777', 'fenix-a320', 'inibuilds-a350-900']) {
    loader.setActiveProfile(id); catalogues[id] = buildAircraftControlCapabilities(loader.getActiveProfile(), {
      profileRevision: loader.getAircraftSpecificConfig().profileRevision,
      capabilities: { actionTypes: ['aircraft-integration'], integrationTransports: ['sdk', 'simconnect-sequence', 'lvar', 'mobiflight-calculator', 'simbridge-mcdu'] },
    });
  }
  const { createServer } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/vite/dist/node/index.js')));
  const { default: vue } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs')));
  const server = await createServer({ configFile: false, root: ROOT, logLevel: 'error', cacheDir: path.join(OUT, 'vite-cache'),
    optimizeDeps: { noDiscovery: true }, plugins: [vue(), { name: 'atc-fixture', configureServer(vite) {
      vite.middlewares.use('/capabilities', (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(catalogues)); });
      vite.middlewares.use('/fixture', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/frontend-dist/tailwind.css"><style>body{margin:0;padding:16px;font-family:system-ui;background:rgb(var(--background));color:rgb(var(--foreground))}</style></head><body><div id="app"></div><script type="module" src="/tests/fixtures/atc-families-browser.js"></script></body></html>'); });
    } }], resolve: { alias: { vue: path.join(ROOT, 'frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'), pinia: path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs') } }, server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  try {
    const env = { ...process.env, FF_ATC_FAMILIES_URL: `http://127.0.0.1:${server.httpServer.address().port}` }; delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { cwd: ROOT, windowsHide: true, env, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill(), 90000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); clearTimeout(timer); assert.equal(code, 0);
  } finally { await server.close(); }
}
(process.versions.electron ? browser() : main()).catch((error) => { console.error(error); process.exit(1); });
