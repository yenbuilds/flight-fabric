#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, '.tmp/logbook-workspace-browser');
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
  const win = new BrowserWindow({ show: false, width: 1920, height: 1000,
    webPreferences: { contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false } });
  const evaluate = body => win.webContents.executeJavaScript(`(async () => { ${body} })()`);
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  try {
    await win.loadURL(process.env.FF_LOGBOOK_TEST_URL);
    for (let n = 0; n < 150; n++) { if (await evaluate('return Boolean(window.logbookTest);')) break; await wait(50); }
    assert(await evaluate('return Boolean(window.logbookTest);'), `fixture is ready: ${errors.join('\n')}`);
    for (const [width, fontSize] of [[1920,16], [1255,16], [1101,16], [800,16], [390,16], [320,16], [320,20]]) {
      win.setContentSize(width, 1000);
      await evaluate(`document.documentElement.style.fontSize='${fontSize}px';`);
      await wait(150);
      const list = await evaluate(`const search=document.querySelector('.logbook-flight-search input');
        const rows=[...document.querySelectorAll('.timeline-flight-row')];
        const clip=document.querySelector('.timeline-flight-list').getBoundingClientRect();
        const rect=search.getBoundingClientRect();
        return {overflow:document.documentElement.scrollWidth>innerWidth,
          searchVisible:rect.height>=40 && rect.top>=0 && rect.bottom<innerHeight,
          filtersClosed:document.querySelector('.logbook-filter-toggle').getAttribute('aria-expanded')==='false',
          heights:rows.map(el=>el.getBoundingClientRect().height),
          fullyVisible:rows.filter(el=>{const r=el.getBoundingClientRect();return r.top>=clip.top && r.bottom<=clip.bottom;}).length,
          optionsSize:document.querySelector('.timeline-flight-more summary').getBoundingClientRect().height,
          storageClosed:!document.querySelector('.logbook-storage').open};`);
      assert.equal(list.overflow, false, `${width}/${fontSize}: list has no horizontal overflow`);
      assert(list.searchVisible && list.filtersClosed, `${width}/${fontSize}: search is visible with secondary filters closed`);
      assert(list.heights.every(height=>height<=fontSize*7), `${width}/${fontSize}: long and missing flight labels keep compact rows: ${JSON.stringify(list.heights)}`);
      if (width>1100) assert(list.fullyVisible>=5, `${width}: at least five complete flights fit beside the review`);
      if (width<=760) assert(list.optionsSize>=44, `${width}: flight options retain a touch target`);
      assert(list.storageClosed, 'recording storage does not crowd the flight list by default');
      fs.writeFileSync(path.join(OUTPUT, `flights-${width}-${fontSize}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await evaluate("document.documentElement.style.fontSize='16px';");
    win.setContentSize(1255, 1000);
    await wait(150);
    await evaluate("const search=document.querySelector('.logbook-flight-search input'); search.value=' egll '; search.dispatchEvent(new Event('input',{bubbles:true})); await logbookTest.settle();");
    assert(await evaluate("return logbookTest.timeline.visibleFlights.length>0 && logbookTest.timeline.visibleFlights.every(f=>f.displayRouteLabel.includes('EGLL'));"), 'visible search filters flights by airport, ignoring case and surrounding spaces');
    await evaluate("document.querySelector('.logbook-filter-toggle').click(); const input=document.querySelector('#timeline-flight-filters input'); input.value='737'; input.dispatchEvent(new Event('input',{bubbles:true})); await logbookTest.settle();");
    assert(await evaluate("return document.querySelector('.ff-empty-state').textContent.includes('No matching flights');"), 'route and aircraft filters combine and explain empty results');
    await evaluate("document.querySelector('.timeline-clear-filters').click(); await logbookTest.settle();");
    assert.equal(await evaluate("return document.activeElement===document.querySelector('.logbook-flight-search input') && logbookTest.timeline.visibleFlights.length===18;"), true, 'Clear filters restores the list and search focus');
    await evaluate("const select=document.querySelector('#timeline-flight-filters select'); select.value='oldest'; select.dispatchEvent(new Event('change',{bubbles:true})); await logbookTest.settle();");
    assert.equal(await evaluate('return logbookTest.timeline.visibleFlights[0].flightId;'), 'RECORDED-17', 'sorting remains available');
    await evaluate("const select=document.querySelector('#timeline-flight-filters select'); select.value='recent'; select.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('.logbook-filter-toggle').click(); await logbookTest.settle();");
    assert.equal(await evaluate("return document.querySelector('.logbook-filter-toggle').getAttribute('aria-expanded');"), 'false', 'secondary filters collapse after use');
    await evaluate("document.querySelector('.timeline-flight-more summary').click(); await logbookTest.settle();");
    assert.equal(await evaluate('return logbookTest.requests();'), 0, 'opening flight options does not select or reload the flight');
    const flightOptions = await evaluate("const options=document.querySelector('.timeline-flight-options'); return { open:document.querySelector('.timeline-flight-more').open, height:options.getBoundingClientRect().height, text:options.textContent }; ");
    assert(flightOptions.open && flightOptions.height>0 && flightOptions.text.includes('1.0 MB'), `options reveal recording size and sample details: ${JSON.stringify(flightOptions)}`);
    await evaluate("document.querySelector('.timeline-flight-landing').click(); document.querySelector('.timeline-flight-delete').click(); await logbookTest.settle();");
    assert.deepEqual(await evaluate('return { landing:logbookTest.actions.landing, prompt:logbookTest.actions.deletePrompt, deleted:logbookTest.actions.deleted };'), { landing:'flight-0.csv', prompt:'flight-0.csv', deleted:'' }, 'secondary actions target the correct flight and deletion still requires confirmation');
    await win.webContents.capturePage(); await wait(80);
    fs.writeFileSync(path.join(OUTPUT, 'flight-options-1255.png'), (await win.webContents.capturePage()).toPNG());
    win.setContentSize(390, 1000);
    await wait(150);
    assert(await evaluate("const options=document.querySelector('.timeline-flight-options'); const buttons=[...options.querySelectorAll('button')]; return document.documentElement.scrollWidth<=innerWidth && buttons.every(el=>{const r=el.getBoundingClientRect();return r.height>=44 && r.left>=0 && r.right<=innerWidth;});"), 'expanded flight actions fit the phone and retain touch targets');
    await win.webContents.capturePage(); await wait(60);
    fs.writeFileSync(path.join(OUTPUT, 'flight-options-390.png'), (await win.webContents.capturePage()).toPNG());
    win.setContentSize(1255, 1000);
    await wait(150);
    await evaluate("document.querySelector('.timeline-flight-delete').focus();");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await wait(60);
    assert(await evaluate("return !document.querySelector('.timeline-flight-more').open && document.activeElement===document.querySelector('.timeline-flight-more summary');"), 'Escape collapses options and restores focus to their trigger');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await wait(60);
    assert(await evaluate("return document.querySelector('.timeline-flight-more').open;"), 'flight options are keyboard operable');
    await evaluate("document.querySelector('.timeline-flight-more summary').click(); document.querySelector('.logbook-storage summary').click(); await logbookTest.settle(); document.querySelector('.timeline-storage-btn').click(); await logbookTest.settle();");
    assert.equal(await evaluate('return logbookTest.actions.storage;'), 'C:/Users/Pilot/Documents/Flight Fabric/Flight Logs', 'storage tools remain available below the list');
    await evaluate("document.querySelector('.logbook-storage summary').click();");
    await evaluate("const search=document.querySelector('.logbook-flight-search input'); search.value='YSSY'; search.dispatchEvent(new Event('input',{bubbles:true})); await logbookTest.settle();");
    await evaluate("document.querySelector('.timeline-flight-open').click(); await logbookTest.settle();");
    for (const width of [1920, 1440, 1100, 800, 390, 320]) {
      win.setContentSize(width, 1000);
      await wait(180);
      const state = await evaluate(`const viewer = document.querySelector('.timeline-split'); const list = document.querySelector('#vue-timeline-flights-root');
        return { overflow: document.documentElement.scrollWidth > innerWidth, modal: viewer.getAttribute('aria-modal'),
          selected: logbookTest.timeline.loadedTimelineFlightId, listRight: list.getBoundingClientRect().right, reviewLeft: viewer.getBoundingClientRect().left,
          search: document.querySelector('.logbook-flight-search input').value,
          eventsVisible: document.querySelector('#timeline-events').getBoundingClientRect().height > 100,
          mapDisplay: getComputedStyle(document.querySelector('#vue-timeline-map-shell-root')).display,
          summaryWidth: document.querySelector('#vue-timeline-summary-root').getBoundingClientRect().width,
          contentWidth: document.querySelector('.logbook-review-content').clientWidth,
          viewerWidth: viewer.getBoundingClientRect().width,
          duplicates: [...document.querySelectorAll('[id]')].map(e => e.id).filter((id, i, all) => all.indexOf(id) !== i) };`);
      assert.equal(state.overflow, false, `${width}: no horizontal overflow`);
      assert.deepEqual(state.duplicates, [], `${width}: unique runtime IDs`);
      assert.equal(state.selected, 'RECORDED-0', `${width}: rotation retains selected flight`);
      assert.equal(state.search, 'YSSY', `${width}: review and resizing retain flight search`);
      assert(state.eventsVisible, `${width}: events have usable space`);
      assert(state.summaryWidth >= (width > 1100 ? state.viewerWidth : state.contentWidth) - 2, `${width}: summary fills the available review width without collapsing measurements`);
      if (width > 1100) {
        assert.equal(state.modal, null, `${width}: review is not a desktop modal`);
        assert(state.reviewLeft >= state.listRight - 1, `${width}: review stays beside list`);
      } else {
        assert.equal(state.modal, 'true', `${width}: compact review has modal semantics`);
        assert.equal(state.mapDisplay, 'none', `${width}: map does not crowd events`);
      }
      await evaluate("document.querySelector('.timeline-event').click(); await logbookTest.settle();");
      assert.equal(await evaluate("return document.querySelector('#timeline-detail').getAttribute('role');"), width > 1100 ? 'region' : 'dialog');
      assert.equal(await evaluate("return logbookTest.timeline.loadedTimelineFlightId;"), 'RECORDED-0');
      if (width === 1920) {
        for (const rotatedWidth of [390, 1920]) {
          win.setContentSize(rotatedWidth, 1000);
          await wait(150);
          assert.equal(await evaluate('return document.activeElement.id;'), 'timeline-detail-close', 'resizing an open event detail retains focus inside the detail');
          assert.equal(await evaluate('return logbookTest.timeline.inspectorSelectedRowKey;'), 'event-0', 'resizing does not discard the selected event');
        }
      }
      await evaluate("document.querySelector('#timeline-detail-close').click(); await logbookTest.settle();");
      await evaluate("[...document.querySelectorAll('.logbook-review-views button')].find(e => e.textContent === 'Replay map').click(); await logbookTest.settle();");
      assert.equal(await evaluate("return getComputedStyle(document.querySelector('#vue-timeline-map-shell-root')).display;"), 'flex');
      assert.equal(await evaluate("return localStorage.getItem('flightFabric.logbookReviewView.v1');"), 'map', 'preferred review surface is remembered on this device');
      await evaluate("document.querySelector('.logbook-review-views button').click(); await logbookTest.settle();");
      await win.webContents.capturePage(); await wait(80);
      fs.writeFileSync(path.join(OUTPUT, `review-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await evaluate("document.querySelector('#timeline-mobile-viewer-close').click(); await logbookTest.settle(); document.querySelector('.timeline-flight-open').click(); await logbookTest.settle();");
    assert.equal(await evaluate('return logbookTest.requests();'), 1, 'returning to the selected flight preserves review rather than requesting it again');
    for (const [width, height, fontSize] of [[700,390,16], [320,700,16], [700,390,20]]) {
      win.setContentSize(width, height);
      await evaluate(`document.documentElement.style.fontSize='${fontSize}px';`); await wait(150);
      for (const filtersOpen of [false, true]) {
        await evaluate(`document.querySelector('#vue-timeline-inspector-shell-root details').open=${filtersOpen}; document.querySelector('.logbook-review-content').scrollTop=0; await logbookTest.settle();`);
        const targets = filtersOpen ? ['[data-timeline-event-filter="configuration_event"]', '[data-timeline-event-filter="flight_guidance_event"]', '.timeline-event:last-child'] : ['.timeline-event', '.timeline-event:last-child'];
        for (const selector of targets) {
          const visible = await evaluate(`const target=document.querySelector(${JSON.stringify(selector)}); target.scrollIntoView({block:'center'}); await logbookTest.settle(); const r=target.getBoundingClientRect(), clip=document.querySelector('.logbook-review-content').getBoundingClientRect(); return {top:r.top,bottom:r.bottom,clipTop:clip.top,clipBottom:clip.bottom,scroll:document.querySelector('.logbook-review-content').scrollTop};`);
          assert(visible.top >= visible.clipTop-1 && visible.bottom <= visible.clipBottom+1, `${width}x${height}/${fontSize}px filters=${filtersOpen}: ${selector} is reachable without clipping: ${JSON.stringify(visible)}`);
          assert(await evaluate("const r=document.getElementById('timeline-mobile-viewer-close').getBoundingClientRect(); return r.top>=0 && r.bottom<=innerHeight;"), 'Back to flights stays visible while reviewing events and filters');
        }
        await win.webContents.capturePage(); await wait(60);
        fs.writeFileSync(path.join(OUTPUT, `short-review-${width}x${height}-${fontSize}-${filtersOpen ? 'filters' : 'events'}.png`), (await win.webContents.capturePage()).toPNG());
      }
      await evaluate("const button=[...document.querySelectorAll('.logbook-review-views button')].find(el=>el.textContent==='Replay map'); button.scrollIntoView({block:'center'}); button.click(); await logbookTest.settle();");
      assert(await evaluate("const map=document.querySelector('.timeline-map-wrap'); map.scrollIntoView({block:'center'}); const r=map.getBoundingClientRect(), clip=document.querySelector('.logbook-review-content').getBoundingClientRect(); return r.height>=128 && r.top<clip.bottom && r.bottom>clip.top;"), 'short landscape replay remains reachable in the same scroll region');
      await evaluate("document.querySelector('.logbook-review-views button').click(); document.querySelector('#vue-timeline-inspector-shell-root details').open=false; await logbookTest.settle();");
    }
    await evaluate("document.documentElement.style.fontSize='16px'; logbookTest.holdResponse(true); logbookTest.timeline.requestTimeline('flight-1.csv','RECORDED-1',{flightLabel:'EGLL-LFPG'}); await logbookTest.settle();");
    assert.equal(await evaluate('return logbookTest.timeline.timelineLoading;'), true, 'accepted recording request starts loading');
    await evaluate('logbookTest.disconnect(); await logbookTest.settle();');
    assert.equal(await evaluate('return logbookTest.timeline.timelineLoading;'), false, 'disconnect stops the stranded recording spinner');
    assert(await evaluate("return document.querySelector('.logbook-load-error').textContent.includes('interrupted');"), 'the failed load has an explicit recovery explanation');
    assert(await evaluate("return document.querySelector('.logbook-load-error button').disabled;"), 'retry waits for reconnection');
    await evaluate('logbookTest.restore(); logbookTest.holdResponse(false); await logbookTest.settle();');
    await evaluate("document.querySelector('.logbook-load-error button').click(); await logbookTest.settle();");
    assert.equal(await evaluate('return logbookTest.timeline.loadedTimelineFlightId;'), 'RECORDED-1', 'Retry loads the requested recording after reconnect');
    assert.equal(await evaluate("return document.querySelector('.logbook-load-error');"), null, 'successful retry removes the failure state');
    await evaluate('logbookTest.restricted(); await logbookTest.settle();');
    assert.equal(await evaluate("return getComputedStyle(document.querySelector('.timeline-split')).display;"), 'none', 'restricted clients cannot see retained history');
    assert.equal(await evaluate("return document.body.classList.contains('timeline-viewer-modal-open');"), false, 'revoked history access releases the hidden review focus/scroll lock');
    assert.equal(await evaluate("return document.querySelector('.timeline-flight-open');"), null, 'restricted clients are not offered recording actions');
    console.log('Logbook workspace passed: visible search, combined filters/sort/clear, compact rows, keyboard flight options, guarded delete/landing actions, storage access, desktop adjacency, 320–1920px layouts, short landscape and enlarged-text scrolling, expanded filters, event details, retained selection, disconnect/retry, unique IDs and restricted access.');
    app.exit(0);
  } catch (error) {
    console.error(error);
    fs.writeFileSync(path.join(OUTPUT, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    app.exit(1);
  }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const css = fs.readFileSync(path.join(ROOT, 'frontend-dist/tailwind.css'), 'utf8');
  const { createViteTestServer } = require('./vite-test-server');
  const { default: vue } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs')).href);
  const server = await createViteTestServer({ configFile: false, root: ROOT, logLevel: 'error', cacheDir: path.join(OUTPUT, 'vite-cache'),
    optimizeDeps: { entries: ['tests/fixtures/logbook-workspace-browser.js'] },
    plugins: [vue(), { name: 'logbook-fixture', configureServer(vite) {
      vite.middlewares.use('/assets/flags', (req, res, next) => {
        const country = /^\/([A-Z]{2})\.svg$/.exec(req.url || '')?.[1];
        const file = country && path.join(ROOT, 'frontend/assets/flags', `${country}.svg`);
        if (!file || !fs.existsSync(file)) return next();
        res.setHeader('Content-Type', 'image/svg+xml');
        res.end(fs.readFileSync(file));
      });
      vite.middlewares.use('/fixture.css', (_req, res) => { res.setHeader('Content-Type', 'text/css'); res.end(css); });
      vite.middlewares.use('/logbook-test', (_req, res) => { res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><script src="/shared/app-settings-shared.js"></script><style>body{margin:0;padding:16px;background:rgb(var(--background));color:rgb(var(--foreground));font-family:system-ui}#app{min-width:0}</style></head><body class="ff-app-shell"><div id="app"></div><script type="module" src="/tests/fixtures/logbook-workspace-browser.js"></script></body></html>'); });
    } }], resolve: { alias: { vue: path.join(ROOT, 'frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'), pinia: path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs') } },
    server: { host: '127.0.0.1', port: 0, watch: null } });
  await server.listen();
  try {
    const env = { ...process.env, FF_LOGBOOK_TEST_URL: `http://127.0.0.1:${server.httpServer.address().port}/logbook-test` };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { env, cwd: ROOT, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill(), 90000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearTimeout(timer);
    assert.equal(code, 0, 'logbook browser checks');
  } finally { await server.close(); }
}
(process.versions.electron ? browser() : main()).catch(error => { console.error(error); process.exit(1); });
