#!/usr/bin/env node
'use strict';

// Real Chromium interaction and layout checks; all simulator traffic is mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, '.tmp', 'nav-radios-browser');
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
  const input = (value) => evaluate(`const el = document.querySelector('#nav1-standby-input'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); await navTest.settle();`);
  try {
    await windowRef.loadURL(process.env.FF_NAV_RADIO_TEST_URL);
    // Apply after renderer startup; hidden windows otherwise suppress focus/blur events.
    windowRef.webContents.debugger.attach('1.3');
    await windowRef.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await windowRef.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    console.log('NAV browser: checking radio layout and interactions.');
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate('return Boolean(window.navTest && document.querySelectorAll("[data-nav-radio]").length === 2);')) break;
      await wait(50);
    }
    assert.equal(await evaluate('return document.querySelectorAll("[data-nav-radio]").length;'), 2);
    for (const width of [320, 390, 768]) {
      windowRef.setContentSize(width, 1000);
      await wait(100);
      await evaluate('await navTest.scenario();');
      const layout = await evaluate(`return {
        width: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        controls: [...document.querySelectorAll('input, button')].map(el => ({ height: el.getBoundingClientRect().height, fontSize: parseFloat(getComputedStyle(el).fontSize) })),
        cards: [...document.querySelectorAll('[data-nav-radio]')].map(el => ({ x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y })),
      };`);
      assert.ok(Math.abs(layout.width - width) <= 2, `actual viewport must match ${width}px (was ${layout.width})`);
      assert.equal(layout.overflow, false, `no horizontal scrolling at ${width}px`);
      assert.ok(layout.controls.every((control) => control.height >= 44), 'touch targets are at least 44px');
      assert.ok(layout.controls.filter((_control, index) => index % 3 === 0).every((control) => control.fontSize >= 16), 'inputs avoid mobile auto-zoom');
      assert.equal(layout.cards[0].x === layout.cards[1].x, width < 700, 'cards stack on phones');
      fs.writeFileSync(path.join(OUTPUT, `nav-${width}.png`), (await windowRef.webContents.capturePage()).toPNG());
    }
    await input('110.31');
    assert.equal(await evaluate('return document.querySelector("#nav1-standby-input").getAttribute("aria-invalid");'), 'true');
    assert.equal(await evaluate('return document.querySelector("[data-nav-radio=nav1] button[type=submit]").disabled;'), true);
    await evaluate(`const input = document.querySelector('#nav1-standby-input'); input.blur(); input.focus(); await navTest.settle();`);
    assert.deepEqual(await evaluate(`const input = document.querySelector('#nav1-standby-input'); return [input.selectionStart, input.selectionEnd];`), [0, 6], 'focus selects the whole frequency');
    assert.equal(await evaluate('return document.querySelector("[data-nav-radio=nav1] button[aria-label^=Swap]").disabled;'), true, 'an unsent edit cannot be discarded by swapping');
    await evaluate(`document.querySelector('[data-nav-radio=nav1] button[aria-label^=Swap]').click(); await navTest.settle();`);
    assert.equal(await evaluate('return navTest.sent.length;'), 0, 'editing never sends a swap');
    await evaluate(`document.querySelector('[data-nav-radio=nav1] .nav-radio__cancel').click(); await navTest.settle();`);
    assert.equal(await evaluate('return document.querySelector("#nav1-standby-input").value;'), '110.30', 'cancel restores the latest standby readback');
    await input('111.10');
    await evaluate(`document.querySelector('#nav1-standby-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await navTest.settle();`);
    assert.equal(await evaluate('return document.querySelector("#nav1-standby-input").value;'), '110.30', 'Escape also cancels an edit without sending');
    await input('110,50');
    await evaluate(`document.querySelector('[data-nav-radio=nav1]').requestSubmit(); document.querySelector('[data-nav-radio=nav1]').requestSubmit(); await navTest.settle();`);
    assert.deepEqual(await evaluate('return navTest.sent;'), [{ type: 'canonical', commandId: 'radios.nav1.setStandby', input: { value: 110.50 } }]);
    assert.equal(await evaluate('return [...document.querySelectorAll("[data-nav-radio=nav1] button")].every(el => el.disabled);'), true, 'both controls stay disabled while the command is pending');
    assert.equal(await evaluate('return document.querySelector("[data-nav-radio=nav1] output").textContent;'), '108.00', 'no optimistic active tuning');
    await evaluate(`navTest.controls.resetPendingCommands(); navTest.controls.navRadios = { ...navTest.controls.navRadios, nav1: { installed: true, activeMhz: 108, standbyMhz: 110.50 } }; await navTest.settle();`);
    await evaluate(`document.querySelector('[data-nav-radio=nav1] button[type=button]').click(); document.querySelector('[data-nav-radio=nav1] button[type=button]').click(); await navTest.settle();`);
    assert.deepEqual(await evaluate('return navTest.sent[1];'), { type: 'canonical', commandId: 'radios.nav1.swap', input: {} });
    assert.equal(await evaluate('return navTest.sent.length;'), 2, 'double tap sends only one swap');
    await evaluate('navTest.controls.resetPendingCommands(); await navTest.scenario(false, true);');
    assert.deepEqual(await evaluate('return [...document.querySelectorAll("[data-nav-radio]")].map(el => el.dataset.navRadio);'), ['nav2'], 'NAV 2 works independently when NAV 1 is absent');
    await evaluate('await navTest.scenario(false, false);');
    assert.equal(await evaluate('return document.querySelectorAll("[data-nav-radio]").length;'), 0);
    assert.match(await evaluate('return document.body.textContent;'), /No NAV radios reported/);
    await evaluate('await navTest.scenario(); navTest.controls.navRadiosReceivedAt = Date.now() - 3000; await navTest.settle();');
    await wait(300);
    assert.match(await evaluate('return document.body.textContent;'), /Waiting for NAV radio data/);
    await evaluate('await navTest.scenario(); navTest.controls.setAvailability({ enabled: false }); await navTest.settle();');
    assert.equal(await evaluate('return [...document.querySelectorAll("input, button")].every(el => el.disabled);'), true);
    assert.deepEqual(errors, [], 'browser has no runtime errors');
    console.log('NAV browser: checking the Wide-Body base generic Aircraft page with its actual command catalogue.');
    await windowRef.loadURL(`${process.env.FF_NAV_RADIO_TEST_URL}?page=generic&profile=widebody-base`);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate('return Boolean(document.querySelector("[data-aircraft-page-mode=generic]"));')) break;
      await wait(50);
    }
    assert.equal(await evaluate('return navTest.profileKey;'), 'bundled/msfs/widebody-base');
    assert.equal(await evaluate('return document.querySelectorAll("[data-nav-radio]").length;'), 2, 'Wide-Body base exposes both NAV receivers');
    assert.equal(await evaluate('return document.querySelector("#ctrl-light-nav-on-btn").disabled;'), false, 'Wide-Body base enables standard lights');
    assert.equal(await evaluate('return navTest.controls.isAircraftCommandSupported("flightGuidance.heading.set");'), true, 'Wide-Body base enables standard autopilot targets');
    for (const width of [320, 390, 768]) {
      windowRef.setContentSize(width, 844);
      await wait(100);
      const layout = await evaluate(`return {
        width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
        ribbonVisible: document.querySelector('[data-aircraft-section-ribbon]').getBoundingClientRect().height > 0,
        searchVisible: getComputedStyle(document.querySelector('.aircraft-find')).display !== 'none',
      };`);
      assert.ok(Math.abs(layout.width - width) <= 2);
      assert.equal(layout.overflow, false, `generic page has no horizontal scrolling at ${width}px`);
      assert.equal(layout.ribbonVisible, width <= 760, 'generic page has the established mobile section ribbon');
      assert.equal(layout.searchVisible, true, 'generic Aircraft search remains available alongside section navigation');
      if (width <= 760) {
        await evaluate(`document.querySelector('.aircraft-section-ribbon__current').click(); await navTest.settle();`);
        assert.equal(await evaluate('return document.querySelectorAll("[data-aircraft-section-choice]").length;'), 4);
        await evaluate(`document.querySelectorAll('[data-aircraft-section-choice]')[3].click(); await navTest.settle();`);
        assert.equal(await evaluate('return document.activeElement.id;'), 'generic-aircraft-section-radios', 'section navigation moves keyboard focus');
        await wait(350);
        assert.equal(await evaluate('return Boolean(document.querySelector("[data-aircraft-section-menu]"));'), false);
        const position = await evaluate('return document.querySelector("#generic-aircraft-section-radios").getBoundingClientRect().top;');
        assert.ok(position >= 44 && position < 200, `radio section lands below the sticky ribbon (top=${position})`);
      }
      await evaluate('window.scrollTo(0, 0);');
      await wait(100);
      fs.writeFileSync(path.join(OUTPUT, `generic-${width}.png`), (await windowRef.webContents.capturePage()).toPNG());
    }
    await evaluate(`navTest.controls.setFeedback({ actionText: 'Beacon on', status: 'sent' }); await navTest.settle();`);
    assert.match(await evaluate('return document.querySelector(".generic-feedback").textContent;'), /Command sent\. Check the aircraft response/);
    await evaluate(`document.querySelector('.generic-feedback button').click(); await navTest.settle();`);
    assert.equal(await evaluate('return document.querySelector("#controls-diagnostics").open;'), true);
    assert.equal(await evaluate('return document.activeElement.id;'), 'controls-diagnostics-toggle');
    await evaluate(`navTest.controls.setAvailability({ enabled: false, reason: 'Viewer mode. Controls are read-only.' }); await navTest.settle();`);
    assert.match(await evaluate('return document.querySelector(".generic-availability").textContent;'), /Viewer mode/);
    assert.equal(await evaluate('return document.querySelector("#ctrl-light-nav-on-btn").disabled;'), true);
    assert.equal(await evaluate('return navTest.sent.length;'), 0, 'section navigation and feedback details do not dispatch commands');
    await evaluate(`navTest.controls.setAvailability({ enabled: true }); await navTest.scenario(false, true);`);
    assert.deepEqual(await evaluate('return [...document.querySelectorAll("[data-nav-radio]")].map(el => el.dataset.navRadio);'), ['nav2'], 'Wide-Body base handles a single installed receiver');
    await evaluate(`document.querySelector('[data-nav-radio=nav2] button[aria-label^=Swap]').click(); await navTest.settle();`);
    assert.deepEqual(await evaluate('return navTest.sent;'), [{ type: 'canonical', commandId: 'radios.nav2.swap', input: {} }], 'Wide-Body NAV 2 dispatches independently');
    await evaluate('navTest.controls.resetPendingCommands(); await navTest.scenario(false, false);');
    assert.equal(await evaluate('return document.querySelectorAll("[data-nav-radio]").length;'), 0, 'Wide-Body base handles no installed radios');
    assert.match(await evaluate('return document.querySelector("[data-generic-nav-radios]").textContent;'), /No NAV radios reported/);
    windowRef.setContentSize(390, 844);
    await wait(100);
    await evaluate(`document.querySelector('.aircraft-section-ribbon__current').click(); await navTest.settle();`);
    await evaluate(`navTest.controls.applyControlCapabilities({ aircraftCommands: {
      profileKey: 'bundled/msfs/other', profileRevision: 2, commands: [],
    } }); await navTest.settle();`);
    assert.equal(await evaluate('return Boolean(document.querySelector("[data-aircraft-section-menu]"));'), false, 'an aircraft change closes the old section menu');
    assert.equal(await evaluate('return Boolean(document.querySelector("[data-generic-nav-radios]"));'), false, 'profiles without radio commands omit the radio section');
    await evaluate(`document.querySelector('.aircraft-section-ribbon__current').click(); await navTest.settle();`);
    assert.equal(await evaluate('return document.querySelectorAll("[data-aircraft-section-choice]").length;'), 3, 'the new menu has no dead radio destination');
    assert.deepEqual(errors, [], 'whole generic page has no browser runtime errors');
    console.log('NAV and generic page browser: 320/390/768px layouts, section jumps, focus, command feedback, edit cancellation, validation, standby/swap, double taps, receiver availability, stale data and read-only state passed.');
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
  const { buildAircraftControlCapabilities } = require(resolveBackendRuntimeFile('aircraft', 'aircraft-control-service.js'));
  const { normalizeProfileDocument, finalizeLoadedProfile } = require(resolveBackendRuntimeFile('aircraft', 'aircraft-profile-model.js'));
  const profileCapabilities = new Map(['generic', 'widebody-base'].map((id) => {
    const document = JSON.parse(fs.readFileSync(path.join(ROOT, 'backend/aircraft/profiles/bundled/msfs', `${id}.json`), 'utf8'));
    const profile = finalizeLoadedProfile(normalizeProfileDocument(document));
    profile._profileKey = `bundled/msfs/${id}`;
    return [id, buildAircraftControlCapabilities(profile, { profileRevision: 1 })];
  }));
  const { createServer } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/vite/dist/node/index.js')).href);
  const { default: vue } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs')).href);
  const server = await createServer({ configFile: false, root: ROOT, logLevel: 'error',
    cacheDir: path.join(OUTPUT, 'vite-cache'), optimizeDeps: { entries: ['tests/fixtures/nav-radios-browser.js'] }, plugins: [vue(), {
    name: 'nav-radio-fixture', configureServer(viteServer) {
      viteServer.middlewares.use('/nav-radio-capabilities', (req, res) => {
        const capabilities = profileCapabilities.get(new URL(req.url, 'http://localhost').searchParams.get('profile'));
        res.statusCode = capabilities ? 200 : 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(capabilities || { error: 'Unknown fixture profile' }));
      });
      viteServer.middlewares.use('/nav-radio-test', (_req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/frontend/tailwind.css"><style>body{margin:0;padding:16px;background:rgb(var(--background));color:rgb(var(--foreground));font-family:system-ui}</style></head><body><div id="app"></div><script type="module" src="/tests/fixtures/nav-radios-browser.js"></script></body></html>');
      });
    },
  }], resolve: { alias: {
    vue: path.join(ROOT, 'frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'),
    pinia: path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs'),
  } }, server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  try {
    const env = { ...process.env, FF_NAV_RADIO_TEST_URL: `http://127.0.0.1:${server.httpServer.address().port}/nav-radio-test` };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { env, cwd: ROOT, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill(), 90000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearTimeout(timer);
    assert.equal(code, 0, 'NAV browser checks');
  } finally { await server.close(); }
}

(process.versions.electron ? runBrowser() : main()).catch((error) => { console.error(error); process.exit(1); });
