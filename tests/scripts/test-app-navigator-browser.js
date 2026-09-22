#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, '.tmp/app-navigator-browser');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function browser() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(OUTPUT, `profile-${process.pid}`));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1280, height: 800,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', details => { if (details.level === 'error') console.error(details.message); });
  const evaluate = code => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
  try {
    await win.loadURL(process.env.FF_NAVIGATOR_TEST_URL);
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await evaluate('return Boolean(window.navigatorTest);')) break;
      await delay(40);
    }
    assert.equal(await evaluate('return Boolean(window.navigatorTest);'), true, 'navigator fixture loaded');
    await evaluate("document.querySelector('#open-search').focus(); document.querySelector('#open-search').click(); await navigatorTest.settle();");
    assert.equal(await evaluate('return document.activeElement.id;'), 'app-navigator-query', 'opening focuses search');
    assert.equal(await evaluate("return document.querySelector('.app-workbench').inert;"), true, 'background is inert while modal is open');
    const semantics = await evaluate(`const field = document.querySelector('#app-navigator-query');
      const options = [...document.querySelectorAll('[role="option"]')];
      return { active: document.getElementById(field.getAttribute('aria-activedescendant'))?.getAttribute('aria-selected'),
        tabStops: options.filter(option => option.tabIndex >= 0).length };`);
    assert.deepEqual(semantics, { active: 'true', tabStops: 0 }, 'combobox owns one active result without duplicate Tab stops');

    await evaluate("navigatorTest.query('  VOICE  cockpit '); await navigatorTest.settle();");
    assert.deepEqual(await evaluate("return [...document.querySelectorAll('[role=option]')].map(element => element.id);"), ['navigator-result-autopilot'], 'search is case-insensitive and matches independent terms');
    await evaluate("navigatorTest.query('not-a-view'); await navigatorTest.settle();");
    assert.equal(await evaluate("return document.querySelector('#app-navigator-query').getAttribute('aria-activedescendant');"), null, 'empty search has no dangling active descendant');
    assert.equal(await evaluate("return document.querySelector('[role=status]').textContent.includes('No matching views');"), true);
    await evaluate("navigatorTest.key(document.activeElement, 'Enter'); await navigatorTest.settle();");
    assert.equal(await evaluate('return navigatorTest.shell.navigatorOpen;'), true, 'Enter on empty results never navigates');

    await evaluate("navigatorTest.query(''); await navigatorTest.settle(); navigatorTest.key(document.activeElement, 'ArrowUp'); await navigatorTest.settle();");
    assert.equal(await evaluate("return document.querySelector('#app-navigator-query').getAttribute('aria-activedescendant');"), 'navigator-result-lvars', 'up wraps from first to last');
    await evaluate("navigatorTest.key(document.activeElement, 'ArrowDown'); await navigatorTest.settle();");
    assert.equal(await evaluate("return document.querySelector('#app-navigator-query').getAttribute('aria-activedescendant');"), 'navigator-result-livemap', 'down wraps to first');
    await evaluate("navigatorTest.query('aircraft controls'); await navigatorTest.settle(); navigatorTest.guard(true); navigatorTest.key(document.activeElement, 'Enter'); await navigatorTest.settle();");
    assert.equal(await evaluate('return navigatorTest.tabs.activeTabId;'), 'flight', 'unsaved-change guard blocks search navigation');
    assert.equal(await evaluate('return document.activeElement.id;'), 'app-navigator-query', 'blocked navigation retains query focus');
    assert.equal(await evaluate('return navigatorTest.shell.navigatorOpen;'), true);
    await evaluate("navigatorTest.guard(false); navigatorTest.key(document.activeElement, 'Enter', { isComposing: true }); await navigatorTest.settle();");
    assert.equal(await evaluate('return navigatorTest.tabs.activeTabId;'), 'flight', 'IME confirmation does not activate a result');
    await evaluate("navigatorTest.key(document.activeElement, 'Enter'); await navigatorTest.settle();");
    assert.equal(await evaluate('return navigatorTest.tabs.activeTabId;'), 'autopilot', 'approved navigation uses the requested destination');
    assert.equal(await evaluate('return document.activeElement.id;'), 'vue-main-root', 'navigation moves focus into the working surface');
    assert.equal(await evaluate("return document.querySelector('.app-workbench').inert;"), false);

    const shortcutCases = [
      ['typing', '#typing', {}], ['textarea', '#text-area', {}], ['select', '#select', {}],
      ['contenteditable empty', '#editable-child', {}], ['plaintext-only', '#plaintext', {}], ['slider', '#slider', {}],
      ['composing', '#open-search', { isComposing: true }], ['repeated', '#open-search', { repeat: true }],
      ['modified', '#open-search', { shiftKey: true }],
    ];
    for (const [label, selector, options] of shortcutCases) {
      const handled = await evaluate(`const target = document.querySelector(${JSON.stringify(selector)}); target.focus();
        const prevented = navigatorTest.key(target, 'k', { ctrlKey: true, ...${JSON.stringify(options)} }); await navigatorTest.settle();
        return { prevented, open: navigatorTest.shell.navigatorOpen };`);
      assert.deepEqual(handled, { prevented: false, open: false }, `${label}: preserves existing keyboard behavior`);
    }
    await evaluate("document.querySelector('#other-dialog').hidden = false;");
    assert.equal(await evaluate("return navigatorTest.key(document.querySelector('#cdu-key'), 'k', { ctrlKey: true });"), false, 'CDU modal keeps physical keyboard input');
    assert.equal(await evaluate('return navigatorTest.shell.navigatorOpen;'), false);
    await evaluate("document.querySelector('#other-dialog').hidden = true; document.querySelector('#open-search').focus(); navigatorTest.key(document.activeElement, 'k', { metaKey: true }); await navigatorTest.settle();");
    assert.equal(await evaluate('return navigatorTest.shell.navigatorOpen;'), true, 'Cmd+K is supported on attached Mac keyboards');
    await evaluate("navigatorTest.key(document.activeElement, 'Tab'); await navigatorTest.settle();");
    assert.equal(await evaluate("return document.activeElement.hasAttribute('data-navigator-close');"), true, 'Tab wraps to close without traversing every result');
    await evaluate("navigatorTest.key(document.activeElement, 'Tab', { shiftKey: true }); await navigatorTest.settle();");
    assert.equal(await evaluate('return document.activeElement.id;'), 'app-navigator-query', 'Shift+Tab wraps back to input');
    await evaluate("navigatorTest.key(document.activeElement, 'Escape'); await navigatorTest.settle();");
    assert.equal(await evaluate('return document.activeElement.id;'), 'open-search', 'cancel restores the invoking control');
    await evaluate("document.activeElement.blur(); navigatorTest.shell.openNavigator(); await navigatorTest.settle(); navigatorTest.shell.closeNavigator(); await navigatorTest.settle();");
    assert.equal(await evaluate('return document.activeElement.id;'), 'open-search', 'touch/programmatic opening without focused button uses a visible return control');

    await evaluate("document.querySelector('#mobile-more-sheet').hidden = false; document.querySelector('#more-help').focus(); document.querySelector('#more-help').click(); document.querySelector('#mobile-more-sheet').hidden = true; await navigatorTest.settle();");
    assert.equal(await evaluate("return document.activeElement.hasAttribute('data-navigator-close');"), true, 'help gets a meaningful initial focus');
    const sourceLink = await evaluate("const link = document.getElementById('footer-source-link'); return { href: link?.href, label: link?.textContent, visible: Boolean(link?.getClientRects().length), restricted: Boolean(link?.closest('[inert]')) }; ");
    assert.equal(sourceLink.href, 'https://github.com/yenbuilds/flight-fabric/releases', 'Help links to the corresponding source for remote users');
    assert.match(sourceLink.label, /source/i);
    assert(sourceLink.visible && !sourceLink.restricted, 'the source link remains accessible through mobile Help');
    await evaluate("navigatorTest.shell.openNavigator(); await navigatorTest.settle();");
    assert.equal(await evaluate('return document.activeElement.id;'), 'app-navigator-query', 'switching help to search focuses the new content');
    await evaluate("navigatorTest.key(document.activeElement, 'Escape'); await navigatorTest.settle();");
    assert.equal(await evaluate('return document.activeElement.id;'), 'mobile-more-btn', 'closing help returns to More when its sheet was dismissed');

    await evaluate("document.querySelector('#open-search').focus(); navigatorTest.shell.openNavigator(); navigatorTest.shell.closeNavigator(); await navigatorTest.settle();");
    assert.equal(await evaluate('return document.activeElement.id;'), 'open-search', 'rapid open/close does not steal focus');
    await evaluate("navigatorTest.shell.openNavigator(); await navigatorTest.settle(); navigatorTest.shell.closeNavigator(); navigatorTest.shell.openNavigator('help'); await navigatorTest.settle();");
    assert.equal(await evaluate("return document.activeElement.hasAttribute('data-navigator-close');"), true, 'rapid close/reopen stays inside the latest dialog');
    await evaluate("navigatorTest.shell.closeNavigator(); await navigatorTest.settle(); navigatorTest.shell.sidebarCollapsed = false; navigatorTest.shell.toggleSidebar();");
    assert.equal(await evaluate("return localStorage.getItem('ff_sidebar_collapsed_v1');"), 'yes', 'sidebar choice persists synchronously');
    await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.reload(); });
    for (let attempt = 0; attempt < 150; attempt++) { if (await evaluate('return Boolean(window.navigatorTest);')) break; await delay(40); }
    assert.equal(await evaluate('return navigatorTest.shell.sidebarCollapsed;'), true, 'sidebar restores on this device');
    assert.equal(await evaluate('return navigatorTest.shell.navigatorOpen;'), false, 'dialogs never reopen on reload');
    await evaluate(`const original = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
      try { navigatorTest.shell.toggleSidebar(); } finally { Storage.prototype.setItem = original; }`);
    assert.equal(await evaluate('return navigatorTest.shell.sidebarCollapsed;'), false, 'sidebar works when storage is unavailable');
    console.log('App navigator passed: search/ARIA, guards/IME, shortcut isolation, focus trap/restoration, mobile More return, races and per-device persistence.');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const { createViteTestServer } = require('./vite-test-server');
  const { default: vue } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs')).href);
  const server = await createViteTestServer({ configFile: false, root: ROOT, logLevel: 'error', cacheDir: path.join(OUTPUT, 'vite-cache'),
    optimizeDeps: { entries: ['tests/fixtures/app-navigator-browser.js'] },
    plugins: [vue(), { name: 'navigator-fixture', configureServer(vite) {
      vite.middlewares.use('/navigator-test', (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*");
        response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
          <style>[hidden]{display:none!important}.app-navigator-backdrop{position:fixed;inset:0;background:#222}.app-navigator{padding:20px}svg{width:20px;height:20px}.app-navigator-results{max-height:350px;overflow:auto}button,input{min-height:32px}#editable-child{display:inline-block}#app{min-width:0}</style></head><body>
          <div class="app-workbench"><button id="open-search" aria-label="Search views and tools">Search</button><button id="open-help">Help</button>
          <button id="mobile-more-btn">More</button><main id="vue-main-root" tabindex="-1">Flight workspace</main>
          <input id="typing"><textarea id="text-area"></textarea><select id="select"><option>A</option></select>
          <div contenteditable=""><span id="editable-child" tabindex="0">Edit here</span></div><div id="plaintext" contenteditable="plaintext-only">Edit here</div>
          <div id="slider" role="slider" tabindex="0">Slider</div><div id="mobile-more-sheet" hidden><button id="more-help">Help</button></div></div>
          <section id="other-dialog" role="dialog" aria-modal="true" data-cdu-modal hidden><button id="cdu-key">CDU key</button></section>
          <div id="navigator-app"></div><script type="module" src="/tests/fixtures/app-navigator-browser.js"></script></body></html>`);
      });
    } }], resolve: { alias: { vue: path.join(ROOT, 'frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'), pinia: path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs') } },
    server: { host: '127.0.0.1', port: 0, watch: null } });
  await server.listen();
  try {
    const env = { ...process.env, FF_NAVIGATOR_TEST_URL: `http://127.0.0.1:${server.httpServer.address().port}/navigator-test` };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { env, cwd: ROOT, windowsHide: true, stdio: 'inherit' });
    const timeout = setTimeout(() => child.kill(), 45000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearTimeout(timeout);
    assert.equal(code, 0, 'navigator browser checks');
  } finally { await server.close(); }
}
(process.versions.electron ? browser() : main()).catch(error => { console.error(error); process.exit(1); });
