// Real Chromium/Vue with in-memory flight data. No simulator connection.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = require('./repo-scratch').getRepoScratchPath('approach-alerts-browser');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runBrowser() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(OUTPUT, 'chromium'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1200, height: 1000,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  async function loadFixture() {
    await window.loadURL(process.env.FF_APPROACH_BROWSER_URL);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await window.webContents.executeJavaScript('Boolean(window.approachTestReady)')) return;
      await wait(50);
    }
    throw new Error('Timeline fixture did not become ready');
  }
  try {
    await window.webContents.session.clearStorageData({ storages: ['localstorage'] });
    await loadFixture();
    window.webContents.debugger.attach('1.3');
    const evaluate = code => window.webContents.executeJavaScript(`(async () => { ${code} })()`, true);
    assert.equal(await evaluate('return [...document.querySelectorAll("[data-timeline-event-filter]")].every(el => el.checked);'), true);
    await evaluate('document.querySelector("details").open = true;');
    for (const key of ['configuration_event', 'automation_event', 'flight_guidance_event']) {
      await evaluate(`document.querySelector('[data-timeline-event-filter="${key}"]').click(); await timelinePresentationTest.settle();`);
    }
    const filtered = await evaluate('return { text: document.body.innerText, rows: document.querySelectorAll(".timeline-event").length, total: timelinePresentationTest.timeline.inspectorAllRows.length };');
    assert.equal(filtered.rows, 6); assert.equal(filtered.total, 9);
    assert.match(filtered.text, /3 hidden/); assert.doesNotMatch(filtered.text, /Flaps extended to 30/);
    assert.match(filtered.text, /Cautions: 2/); assert.match(filtered.text, /Violations: 1/);
    await loadFixture();
    assert.equal(await evaluate('return [...document.querySelectorAll("[data-timeline-event-filter]")].every(el => !el.checked);'), true, 'filters survive a full page reload');
    assert.equal(await evaluate('return document.querySelectorAll(".timeline-event").length;'), 6);
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await evaluate('document.querySelector("details summary").focus();');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await wait(50);
    assert.equal(await evaluate('return document.querySelector("details").open;'), true, 'filters open with the keyboard');
    for (const key of ['configuration_event', 'automation_event', 'flight_guidance_event']) {
      await evaluate(`document.querySelector('[data-timeline-event-filter="${key}"]').click(); await timelinePresentationTest.settle();`);
    }
    assert.equal(await evaluate('return document.querySelectorAll(".timeline-event").length;'), 9);
    assert.equal(await evaluate('return document.querySelector("[data-artwork-case=unknown] [role=img]").getAttribute("aria-label");'), 'Unknown aircraft');
    assert.equal(await evaluate('return document.querySelector("[data-artwork-case=missing] [role=img]").getAttribute("aria-label");'), 'Aircraft image unavailable');
    await evaluate('const img = document.querySelector("[data-artwork-case=known] img"); await new Promise(resolve => { img.addEventListener("error", resolve, { once: true }); img.src = "/assets/aircraft/missing-regression-fixture.png"; }); await timelinePresentationTest.settle();');
    assert.equal(await evaluate('return document.querySelector("[data-artwork-case=known] [role=img]").getAttribute("aria-label");'), 'Aircraft image unavailable');
    await evaluate('await timelinePresentationTest.changeAircraft("pmdg-777");');
    assert.equal(await evaluate('return document.querySelector("[data-artwork-case=known] img").getAttribute("src");'), '/assets/aircraft/boeing-777-300er.png');
    const loadedImage = await evaluate('const img = document.querySelector("[data-artwork-case=known] img"); await img.decode(); const rect = img.getBoundingClientRect(); return { naturalWidth: img.naturalWidth, width: rect.width, height: rect.height };');
    assert.ok(loadedImage.naturalWidth > 0 && loadedImage.width > 0 && loadedImage.height > 0, JSON.stringify(loadedImage));
    for (const width of [320, 390, 1200]) {
      window.setContentSize(width, 1000); await wait(150);
      const state = await window.webContents.executeJavaScript(`({
        ready: window.approachTestReady,
        overflow: document.documentElement.scrollWidth > innerWidth,
        emptyHidden: getComputedStyle(document.querySelector('#timeline-empty')).display === 'none',
        firstRowVisible: document.querySelector('.timeline-event').getBoundingClientRect().top < document.querySelector('#timeline-events').getBoundingClientRect().bottom,
        text: document.body.innerText,
        colors: ['caution', 'violation', 'recovery'].map(type => getComputedStyle(document.querySelector('[data-type="' + type + '"] .timeline-event-dot')).backgroundColor)
      })`);
      assert.equal(state.ready, true); assert.equal(state.overflow, false, `overflow at ${width}`);
      assert.equal(state.emptyHidden, true); assert.equal(state.firstRowVisible, true);
      assert.match(state.text, /Cautions: 2/); assert.match(state.text, /Violations: 1/);
      assert.equal(new Set(state.colors).size, 3, `severity colors at ${width}`);
      fs.writeFileSync(path.join(OUTPUT, `${width}.png`), (await window.webContents.capturePage()).toPNG());
      const hero = await evaluate('const root = document.querySelector("[data-placeholder-hero]"); root.scrollIntoView({ block: "center" }); const art = root.querySelector(".aircraft-artwork").getBoundingClientRect(); const airport = root.querySelector(".landing-aircraft-hero__airport").getBoundingClientRect(); const icon = root.querySelector("svg").getBoundingClientRect(); return { artBottom: art.bottom, airportTop: airport.top, iconHeight: icon.height };');
      assert.ok(hero.artBottom <= hero.airportTop && hero.iconHeight >= 20, `placeholder layout at ${width}: ${JSON.stringify(hero)}`);
      await wait(100);
      fs.writeFileSync(path.join(OUTPUT, `${width}-hero.png`), (await window.webContents.capturePage()).toPNG());
      await evaluate('window.scrollTo(0, 0);');
    }
    await evaluate('document.querySelector("[data-thumbnail-button] svg").dispatchEvent(new MouseEvent("click", { bubbles: true })); await timelinePresentationTest.settle();');
    assert.equal(await evaluate('return timelinePresentationTest.thumbnailClicks.value;'), 1, 'placeholder clicks reach the containing flight button');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'forced-colors', value: 'active' }],
    });
    const contrast = await evaluate('const art = document.querySelector("[data-thumbnail-button] .aircraft-artwork"); const svg = art.querySelector("svg"); return { active: matchMedia("(forced-colors: active)").matches, width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height, label: art.getAttribute("aria-label"), display: getComputedStyle(art).display };');
    assert.equal(contrast.active, true);
    assert.equal(contrast.label, 'Aircraft image unavailable');
    assert.ok(contrast.display !== 'none' && contrast.width > 0 && contrast.height > 0, JSON.stringify(contrast));
    window.webContents.debugger.detach();
    console.log('Timeline UI: filters, restoration, aircraft placeholders, failed images and severity markers passed at 320, 390 and 1200 px.');
    window.destroy(); app.exit(0);
  } catch (error) { console.error(error); window.destroy(); app.exit(1); }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const { createServer } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/vite/dist/node/index.js')).href);
  const { default: vue } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs')).href);
  const server = await createServer({ configFile: false, root: ROOT, logLevel: 'error', cacheDir: path.join(OUTPUT, 'vite-cache'),
    optimizeDeps: { entries: ['tests/fixtures/approach-alerts-browser.js'] }, plugins: [vue(), {
      name: 'approach-fixture', configureServer(server) {
        server.middlewares.use('/assets/aircraft', (req, res, next) => {
          const name = (req.url || '').slice(1);
          if (!/^[a-z0-9-]+\.png$/.test(name)) return next();
          const file = path.join(ROOT, 'frontend/assets/aircraft', name);
          if (!fs.existsSync(file)) return next();
          res.setHeader('Content-Type', 'image/png'); res.end(fs.readFileSync(file));
        });
        server.middlewares.use('/approach-test', (_req, res) => { res.setHeader('Content-Type', 'text/html');
          res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/frontend-dist/tailwind.css"><style>body{margin:0;padding:16px;background:rgb(var(--background));color:rgb(var(--foreground));font-family:system-ui}</style></head><body><div id="app"></div><script type="module" src="/tests/fixtures/approach-alerts-browser.js"></script></body></html>'); });
      },
    }], resolve: { alias: { vue: path.join(ROOT, 'frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'), pinia: path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs') } },
    server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  try {
    const env = { ...process.env, FF_APPROACH_BROWSER_URL: `http://127.0.0.1:${server.httpServer.address().port}/approach-test` };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { env, cwd: ROOT, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill(), 60000);
    try { assert.equal(await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }), 0); }
    finally { clearTimeout(timer); }
  } finally { await server.close(); }
}
(process.versions.electron ? runBrowser() : main()).catch(error => { console.error(error); process.exit(1); });
