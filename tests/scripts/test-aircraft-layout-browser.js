#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const { LIVE_AUTOTAXI_ENABLED } = require('../../shared/app-settings-shared.js');
const OUTPUT = process.env.FF_AIRCRAFT_LAYOUT_OUTPUT || path.join(ROOT, '.tmp', 'aircraft-layout-browser');
const AIRCRAFT = ['pmdg-737', 'pmdg-777', 'fenix-a320', 'fbw-a32nx', 'fbw-a380x', 'inibuilds-a350-900'];
const AUTOTAXI_AIRCRAFT = ['generic', 'pmdg-737', 'pmdg-777', 'fenix-a319', 'fenix-a320', 'fenix-a321'];
const AUTOTAXI_FIXTURE = process.env.FF_AUTOTAXI_LAYOUT_FIXTURE === '1';
const templateFor = id => ['fenix-a319', 'fenix-a320', 'fenix-a321'].includes(id) ? 'fenix-a32x' : id.startsWith('inibuilds-a350') ? 'inibuilds-a350' : id;
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
  const win = new BrowserWindow({ show: false, width: 1440, height: 1000,
    // Match the existing browser-smoke harness for this loopback-only fixture.
    // Production window preferences are not changed by the test runner.
    webPreferences: { contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const evaluate = body => win.webContents.executeJavaScript(`(async () => { ${body} })()`);
  async function ready(selector) {
    for (let n = 0; n < 100; n++) {
      if (await evaluate(`return Boolean(document.querySelector(${JSON.stringify(selector)}));`)) return;
      await wait(50);
    }
    throw new Error(`Not rendered: ${selector}`);
  }
  // The CDU modal refreshes its state on a 500 ms timer and re-fits the display
  // on the next frame, so a fixed wait races it on a loaded machine. Re-measure
  // until the page reaches the expected state, returning the last measurement
  // for the assertion either way.
  async function settled(body, isExpected, timeoutMs = 2500) {
    const startedAt = Date.now();
    for (;;) {
      await win.webContents.capturePage();
      const value = await evaluate(body);
      if (isExpected(value) || Date.now() - startedAt > timeoutMs) return value;
      await wait(50);
    }
  }
  try {
    await win.loadURL(process.env.FF_AIRCRAFT_LAYOUT_TEST_URL);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await ready('[data-aircraft-template="pmdg-737"]');
    if (AUTOTAXI_FIXTURE) {
      assert.equal(LIVE_AUTOTAXI_ENABLED, true, 'the fixture exercises the enabled production setting');
      await evaluate(`await layoutTest.scenario('generic');
        const panel = document.querySelector('#aircraft-page-autotaxi'); panel.open = true;
        for (const [placeholder, value] of [['YMML', 'YMML'], ['16', '16']]) {
          const input = panel.querySelector('input[placeholder="' + placeholder + '"]');
          input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        layoutTest.setTaxiState({ canStart: true }); await layoutTest.settle();
        panel.querySelector('button').click(); await layoutTest.settle();
        window.oldTaxiPreview = layoutTest.taxiReplies.findLast(message => message.preview);`);
      assert.equal(await evaluate(`return Boolean(document.querySelector('#aircraft-page-autotaxi figure'));`), true, 'lifecycle fixture starts with a preview');
      await evaluate(`layoutTest.setTaxiState({ sceneKey: null, aircraft: null }); await layoutTest.settle();`);
      assert.equal(await evaluate(`return Boolean(document.querySelector('#aircraft-page-autotaxi figure'));`), false, 'backend geometry invalidation clears a preview even when the profile is unchanged');
      await evaluate(`document.querySelector('#aircraft-page-autotaxi button').click(); await layoutTest.settle();
        window.oldTaxiPreview = layoutTest.taxiReplies.findLast(message => message.preview);
        layoutTest.taxiDisconnect(); layoutTest.taxiReply(window.oldTaxiPreview); await layoutTest.settle();`);
      assert.equal(await evaluate(`return Boolean(document.querySelector('#aircraft-page-autotaxi figure'));`), false, 'disconnect discards cached and late route previews');
      assert.equal(await evaluate(`return document.querySelectorAll('#aircraft-page-autotaxi button')[1].disabled;`), true, 'a late response cannot restore readiness while disconnected');
      await evaluate(`layoutTest.setTaxiState({ canStart: false, sceneKey: null, aircraft: null });
        layoutTest.taxiReconnect(); await layoutTest.settle();
        layoutTest.taxiReply(window.oldTaxiPreview); await layoutTest.settle();`);
      assert.equal(await evaluate(`return Boolean(document.querySelector('#aircraft-page-autotaxi figure'));`), false, 'reconnect rejects previous connection responses');
      assert.doesNotMatch(await evaluate(`return document.querySelector('#aircraft-page-autotaxi').textContent;`), /Connection lost/, 'fresh status replaces the disconnect notice');
      await evaluate(`await layoutTest.remount(); layoutTest.taxiReply(window.oldTaxiPreview); await layoutTest.settle();`);
      assert.equal(await evaluate(`return Boolean(document.querySelector('#aircraft-page-autotaxi figure'));`), false, 'a remounted panel rejects previous mount responses for the same profile');
      assert.equal(await evaluate(`return document.querySelectorAll('#aircraft-page-autotaxi button')[1].disabled;`), true, 'a previous mount cannot restore readiness');
      for (const id of AUTOTAXI_AIRCRAFT) {
        await evaluate(`await layoutTest.scenario(${JSON.stringify(id)}); layoutTest.taxiReconnect(); await layoutTest.settle();`);
        await ready(id === 'generic' ? '[data-aircraft-page-mode="generic"]' : `[data-aircraft-template="${templateFor(id)}"]`);
        await ready('#aircraft-page-autotaxi');
        await wait(300);
        assert.equal(await evaluate(`return document.querySelectorAll('[data-aircraft-autotaxi-section]').length;`), 1, `${id}: one shared Autotaxi panel`);
        assert.equal(await evaluate(`return Boolean(document.querySelector('#pmdg-737-section-autotaxi'));`), false, `${id}: no duplicate family panel`);
        for (const width of [1440, 390, 320]) {
          win.setContentSize(width, 1000); await wait(150);
          await evaluate(`const panel = document.querySelector('#aircraft-page-autotaxi'); panel.open = true; await layoutTest.settle(); panel.scrollIntoView({ behavior: 'instant' });`);
          await wait(150);
          assert.equal(await evaluate(`return document.documentElement.scrollWidth > innerWidth;`), false, `${id} ${width}px: no horizontal overflow`);
          assert.equal(await evaluate(`return [...document.querySelectorAll('#aircraft-page-autotaxi button')].every(button => button.getBoundingClientRect().height >= 48);`), true, `${id} ${width}px: taxi touch targets`);
          const context = await evaluate(`const panel = document.querySelector('#aircraft-page-autotaxi'); return {
            copy: panel.textContent, disabled: [...panel.querySelectorAll('button')].slice(0, 2).every(button => button.disabled),
            support: panel.querySelector('[data-autotaxi-support]').textContent,
          };`);
          assert.match(context.support, /simulator validation/);
          assert.equal(context.disabled, true, `${id}: pending live acceptance cannot start`);
          if (id === 'generic' || id.startsWith('fenix-')) assert.doesNotMatch(context.copy, /PMDG|Tiller \+ Rudder/, `${id}: PMDG setup does not leak`);
          if (id.startsWith('pmdg-')) assert.match(context.copy, /Tiller \+ Rudder/);
          await evaluate(`const setup = document.querySelector('[data-autotaxi-setup]'); setup.open = true; await layoutTest.settle();`);
          assert.equal(await evaluate(`return document.querySelector('[aria-label="Aircraft taxi setup"]').getBoundingClientRect().height > 0;`), true, `${id}: setup expands in place`);
          await evaluate(`document.querySelector('[data-autotaxi-setup]').open = false; await layoutTest.settle();`);
          await evaluate(`document.querySelector('#aircraft-page-autotaxi').scrollIntoView({ behavior: 'instant' });`);
          await wait(100);
          if (width < 761) assert.equal(await evaluate(`const nav = [...document.querySelectorAll('nav')].find(nav => nav.getAttribute('aria-label')?.endsWith('page sections')); const bounds = nav.getBoundingClientRect(); return bounds.top >= 0 && bounds.top < 100 && bounds.height > 0;`), true, `${id}: phone section navigation stays visible above Autotaxi`);
          if (width === 1440) {
            const navigation = await evaluate(`const nav = [...document.querySelectorAll('nav')].find(nav => nav.getAttribute('aria-label')?.endsWith('page sections'));
              const taxi = [...nav.querySelectorAll('button')].find(button => button.textContent.trim() === 'Taxi');
              taxi.click(); await layoutTest.settle();
              return { focused: document.activeElement.id, order: [...nav.querySelectorAll('button')].filter(button => button.getBoundingClientRect().height > 0).map(button => button.textContent.trim()) };`);
            assert.equal(navigation.focused, 'aircraft-page-autotaxi', `${id}: navigation reaches the shared panel`);
            assert.ok(navigation.order.indexOf('Taxi') >= 0, `${id}: taxi has a navigation destination`);
            if (navigation.order.includes('Presets')) assert.ok(navigation.order.indexOf('Presets') < navigation.order.indexOf('Taxi'), `${id}: navigation follows preset then taxi order`);
          }
          await win.webContents.capturePage(); await wait(80);
          fs.writeFileSync(path.join(OUTPUT, `${id}-autotaxi-candidate-${width}.png`), (await win.webContents.capturePage()).toPNG());
        }
        await evaluate(`const panel = document.querySelector('#aircraft-page-autotaxi');
          for (const [placeholder, value] of [['YMML', 'YMML'], ['16', '16']]) { const input = panel.querySelector('input[placeholder="' + placeholder + '"]'); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }
          layoutTest.setTaxiState({ canStart: true, reason: 'Ready to taxi in the simulated fixture.' }); await layoutTest.settle();
          panel.querySelector('button').click(); await layoutTest.settle();`);
        assert.equal(await evaluate(`return Boolean(document.querySelector('#aircraft-page-autotaxi figure svg'));`), true, `${id}: preview renders before commands`);
        for (const width of [1440, 320]) {
          win.setContentSize(width, 1000); await wait(150);
          await evaluate(`document.querySelector('#aircraft-page-autotaxi').scrollIntoView({ behavior: 'instant' });`);
          await wait(150); await win.webContents.capturePage(); await wait(80);
          assert.equal(await evaluate(`return document.documentElement.scrollWidth > innerWidth;`), false, `${id} ${width}px: route preview fits`);
          fs.writeFileSync(path.join(OUTPUT, `${id}-autotaxi-preview-${width}.png`), (await win.webContents.capturePage()).toPNG());
        }
        await evaluate(`document.querySelectorAll('#aircraft-page-autotaxi button')[1].click(); await layoutTest.settle();`);
        assert.equal(await evaluate(`return layoutTest.taxiSent.findLast(message => message.operation === 'start').profileKey;`), `bundled/msfs/${id}`, `${id}: start carries the actual profile`);
        assert.equal(await evaluate(`return document.querySelector('#aircraft-page-autotaxi input').disabled;`), true, `${id}: active destination is locked`);
        await evaluate(`document.querySelectorAll('#aircraft-page-autotaxi button')[2].click(); await layoutTest.settle();`);
        assert.equal(await evaluate(`return layoutTest.taxiSent.findLast(message => message.operation !== 'status').operation;`), 'stop', `${id}: Stop remains accessible`);
        await evaluate(`document.querySelectorAll('#aircraft-page-autotaxi button')[3].click(); await layoutTest.settle();`);
        assert.equal(await evaluate(`return document.querySelector('#aircraft-page-autotaxi input').disabled;`), false, `${id}: release restores editing`);
        await evaluate(`layoutTest.taxiDisconnect(); await layoutTest.settle();`);
        assert.match(await evaluate(`return document.querySelector('#aircraft-page-autotaxi').textContent;`), /Connection lost/);
        assert.equal(await evaluate(`return document.querySelectorAll('#aircraft-page-autotaxi button')[1].disabled;`), true, `${id}: lost connection disables Start`);
      }
      assert.deepEqual(errors, []);
      console.log('PASS Autotaxi shared UI: Generic, PMDG 737, PMDG 777 and Fenix A319/A320/A321; 1440/390/320px; candidate gate, navigation, setup, preview, start, stop, release and disconnect.');
      app.exit(0); return;
    }
    for (const id of (process.env.FF_CDU_LAYOUT_ONLY === '1' || process.env.FF_AIRCRAFT_TOOLS_ONLY === '1' ? [] : process.env.FF_AUTOTAXI_LAYOUT_ONLY === '1' ? ['pmdg-737'] : AIRCRAFT)) {
      const priorTaxiRequests = await evaluate('return layoutTest.taxiSent.length;');
      await evaluate(`await layoutTest.scenario(${JSON.stringify(id)});`);
      await ready(`[data-aircraft-template="${templateFor(id)}"]`);
      for (const [width, height] of [[1440, 1000], [390, 1000], [320, 1000], [700, 390]]) {
        win.setContentSize(width, height);
        await wait(120);
        await evaluate("window.scrollTo({ top: 0, behavior: 'instant' });");
        await wait(80);
        const result = await evaluate(`return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          overflowingElements: [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth && getComputedStyle(el.parentElement).overflowX !== 'auto').slice(0, 10).map(el => ({ tag: el.tagName, class: el.className, width: el.getBoundingClientRect().width })),
          presets: document.querySelectorAll('[data-aircraft-presets-section]').length,
          browsers: document.querySelectorAll('[data-aircraft-command-browser]').length,
          lights: document.querySelectorAll('[data-exterior-light-controls]').length,
          lighting: [...document.querySelectorAll('[data-cockpit-lighting-presets]')].every(el => el.closest('[data-aircraft-presets-section]')),
          takeoff: [...document.querySelectorAll('[data-aircraft-preset="configuration.lights.takeoff"]')].every(el => el.closest('[data-aircraft-presets-section]')),
          repeatedIds: [...document.querySelectorAll('[id]')].map(el => el.id).filter((id, index, ids) => ids.indexOf(id) !== index),
        };`);
        assert.equal(result.overflow, false, `${id}: ${width}px has no horizontal overflow: ${JSON.stringify(result.overflowingElements)}`);
        assert.equal(result.presets, 1, `${id}: one preset section`);
        assert.equal(result.browsers, 0, `${id}: catalogue is absent from the main page`);
        assert.equal(result.lights, 0, `${id}: exterior controls are not repeated above the template`);
        assert.equal(result.lighting && result.takeoff, true, `${id}: presets stay together`);
        assert.deepEqual(result.repeatedIds, [], `${id}: unique element IDs`);
        {
          assert.equal(LIVE_AUTOTAXI_ENABLED, true, 'Experimental Autotaxi is enabled for release');
          const taxi = await evaluate(`return {
            panel: Boolean(document.querySelector('[data-aircraft-autotaxi-section]')),
            experimental: /Experimental/.test(document.querySelector('[data-aircraft-autotaxi-section]')?.textContent || ''),
            navigation: [...document.querySelectorAll('[data-aircraft-template] nav button')].some(button => /Autotaxi|^Taxi$/.test(button.textContent.trim())),
            sections: [...document.querySelectorAll('[data-pmdg-737-section]')].map(section => section.getAttribute('data-pmdg-737-section')),
            requests: layoutTest.taxiSent.length,
            motionRequests: layoutTest.taxiSent.slice(${priorTaxiRequests}).filter(message => message.operation !== 'status').length,
          };`);
          assert.equal(taxi.panel && taxi.navigation && taxi.experimental, true, `${width}px: Experimental Autotaxi and Taxi navigation are visible`);
          assert.ok(taxi.requests > 0, `${width}px: visible Autotaxi requests readiness`);
          assert.equal(taxi.motionRequests, 0, `${width}px: opening the aircraft page never plans or starts a taxi`);
          if (id === 'pmdg-737') assert.deepEqual(taxi.sections, ['mcp', 'radios', 'exterior', 'cabin', 'flight-controls', 'gear-brakes', 'systems'], `${width}px: navigation follows the remaining sections`);
        }
        if (width === 1440) {
          const sectionNavigation = await evaluate(`const nav = document.querySelector('[data-aircraft-template] nav[aria-label$="page sections"]');
            const visible = element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
            const buttons = nav ? [...nav.querySelectorAll('button')].filter(visible) : [];
            const available = Boolean(nav && visible(nav) && buttons.length > 1);
            if (available) { buttons[1].click(); await layoutTest.settle(); }
            const focusedSection = document.activeElement?.id || '';
            if (available) { buttons[0].click(); await layoutTest.settle(); }
            window.scrollTo({ top: 0, behavior: 'instant' });
            return { available, focusedSection };`);
          assert.equal(sectionNavigation.available, true, `${id}: desktop section navigation is visible`);
          assert.ok(sectionNavigation.focusedSection, `${id}: desktop section navigation focuses its destination`);
          await wait(80);
        }
        if (width <= 760) {
          const toolsLayout = await evaluate(`const visible = element => element && element.getBoundingClientRect().height > 0;
            return { height: document.querySelector('.aircraft-page-tools').getBoundingClientRect().height,
              find: visible(document.querySelector('.aircraft-find__launcher')),
              tools: visible(document.querySelector('.aircraft-tools-toggle')),
              library: visible(document.querySelector('[data-aircraft-controls-trigger]')),
              cdu: !document.querySelector('[data-cdu-trigger]') || visible(document.querySelector('[data-cdu-trigger]')),
              healthySummary: visible(document.querySelector('.aircraft-connection-summary--healthy')) };`);
          assert.ok(toolsLayout.height <= 60, `${id}: ${width}px tools use one compact touch row: ${JSON.stringify(toolsLayout)}`);
          assert.equal(toolsLayout.find && toolsLayout.tools && toolsLayout.cdu, true, `${id}: Find, Tools and supported CDU stay accessible`);
          assert.equal(toolsLayout.library || toolsLayout.healthySummary, false, `${id}: secondary tools and duplicate healthy context do not consume the initial phone view`);
          await evaluate(`document.querySelector('.aircraft-find__launcher').click(); await layoutTest.settle();
            const input = document.getElementById('aircraft-find-input'); input.value = 'heading'; input.dispatchEvent(new Event('input', { bubbles: true })); await layoutTest.settle();`);
          await wait(120);
          await win.webContents.capturePage();
          await wait(80);
          assert.equal(await evaluate(`return document.activeElement.id;`), 'aircraft-find-input', `${id}: phone search focuses input`);
          assert.ok(await evaluate(`return document.querySelectorAll('[data-aircraft-find-match]').length;`), `${id}: phone search finds displayed cockpit information`);
          const searchLayout = await evaluate(`const panel = document.querySelector('.aircraft-find__panel').getBoundingClientRect();
            const current = document.querySelector('[data-aircraft-find-current]').getBoundingClientRect();
            return { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom, matchTop: current.top, viewport: innerWidth };`);
          assert.ok(searchLayout.left >= 0 && searchLayout.right <= width && searchLayout.top >= 0, `${id}: search remains visible while finding results: ${JSON.stringify(searchLayout)}`);
          assert.ok(searchLayout.matchTop >= searchLayout.bottom, `${id}: sticky search does not cover the result: ${JSON.stringify(searchLayout)}`);
          if (width === 390) fs.writeFileSync(path.join(OUTPUT, `${id}-phone-search.png`), (await win.webContents.capturePage()).toPNG());
          await evaluate(`document.querySelector('.aircraft-find__collapse').click(); await layoutTest.settle(); window.scrollTo({ top: 0, behavior: 'instant' });`);
          assert.equal(await evaluate(`return document.activeElement.classList.contains('aircraft-find__launcher');`), true, `${id}: close returns focus to visible search entry`);
          await wait(80);
        }
        if (id === 'inibuilds-a350-900') {
          assert.equal(await evaluate(`return document.querySelectorAll('[data-aircraft-control-group="flightGuidance.lsCaptain"], [data-aircraft-control-group="flightGuidance.lsFirstOfficer"]').length;`), 0, 'A350 LS controls appear only in shared EFIS');
        }
        if (width !== 320) {
          fs.writeFileSync(path.join(OUTPUT, `${id}-${width}.png`), (await win.webContents.capturePage()).toPNG());
          if (await evaluate(`return Boolean(document.querySelector('[data-aircraft-avionics-section]'));`)) {
            await evaluate(`document.querySelector('[data-aircraft-avionics-section]').scrollIntoView({ behavior: 'instant' });`);
            await wait(80);
            fs.writeFileSync(path.join(OUTPUT, `${id}-avionics-${width}.png`), (await win.webContents.capturePage()).toPNG());
          }
        }
      }
      // Exercise the enabled production entry point with fake transport.
      if (id === 'pmdg-737' && LIVE_AUTOTAXI_ENABLED) {
        assert.equal(await evaluate(`return document.querySelector('#aircraft-page-autotaxi').open;`), false, 'autotaxi is collapsed by default');
        await evaluate(`const panel = document.querySelector('#aircraft-page-autotaxi');
          panel.querySelector('summary').click(); await layoutTest.settle();
          const inputs = panel.querySelectorAll('input');
          inputs[0].value = 'YMML'; inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[1].value = '16'; inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
          await layoutTest.settle();`);
        assert.equal(await evaluate(`return document.querySelector('#aircraft-page-autotaxi button').disabled;`), false, 'autotaxi requires ready state and a destination');
        await evaluate(`document.querySelector('#aircraft-page-autotaxi button').click(); await layoutTest.settle();`);
        assert.equal(await evaluate(`return layoutTest.taxiSent.filter(message => message.operation !== 'status').at(-1).operation;`), 'preview');
        assert.equal(await evaluate(`return Boolean(document.querySelector('#aircraft-page-autotaxi figure svg'));`), true, 'dry run shows route before motion');
        for (const width of [1440, 320]) {
          win.setContentSize(width, 1000);
          await wait(200);
          await evaluate(`document.querySelector('#aircraft-page-autotaxi').scrollIntoView({ behavior: 'instant' });`);
          await wait(120);
          await evaluate(`document.querySelector('#aircraft-page-autotaxi').scrollIntoView({ behavior: 'instant' });`);
          await wait(80);
          const routePosition = await evaluate(`const target = document.querySelector('#aircraft-page-autotaxi'); const nav = document.querySelector('.aircraft-desktop-section-nav'); return { top: target.getBoundingClientRect().top, scroll: window.scrollY, width: innerWidth, navWidth: nav.getBoundingClientRect().width, overflow: getComputedStyle(document.getElementById('aircraft-specific-section')).overflow, margin: getComputedStyle(target).scrollMarginTop };`);
          assert.equal(routePosition.top >= 0 && routePosition.top < 150, true, `route preview is visible in its screenshot: ${JSON.stringify(routePosition)}`);
          assert.equal(await evaluate('return document.documentElement.scrollWidth > innerWidth;'), false, `preview ${width}: no overflow`);
          // The hidden window's first capture after a resize can be a stale frame; ask twice.
          await win.webContents.capturePage(); await wait(100);
          fs.writeFileSync(path.join(OUTPUT, `pmdg-737-autotaxi-preview-${width}.png`), (await win.webContents.capturePage()).toPNG());
        }
        // The 3D view: a chase camera behind the aircraft, remembered per browser, with the 2D map one tap away.
        assert.equal(await evaluate(`return document.querySelector('#aircraft-page-autotaxi .taxi-map').dataset.taxiView;`), '2d', 'the map starts in 2D');
        await evaluate(`document.querySelector('#aircraft-page-autotaxi input[name="autotaxi-view"][value="3d"]').click(); await layoutTest.settle();`);
        await wait(300);
        const chase = await evaluate(`const map = document.querySelector('#aircraft-page-autotaxi .taxi-map'); return {
          view: map.dataset.taxiView, stored: localStorage.getItem('ff-autotaxi-view'),
          label: map.querySelector('svg').getAttribute('aria-label'),
          paths: [...map.querySelectorAll('path')].filter(el => (el.getAttribute('d') || '').length > 0).length,
          labels: [...map.querySelectorAll('text')].map(el => el.textContent.trim()),
          compassButton: Boolean(map.querySelector('.compass[role="button"]')),
        };`);
        assert.equal(chase.view, '3d');
        assert.equal(chase.stored, '3d', 'the view choice is remembered');
        assert.match(chase.label, /from behind the aircraft/);
        assert.ok(chase.paths > 30, `pavement, route and aircraft faces are drawn: ${chase.paths}`);
        assert.ok(chase.labels.includes('16'), `the runway ahead is labelled: ${chase.labels}`);
        assert.equal(chase.compassButton, false, 'the compass is an indicator in 3D');
        for (const width of [1440, 320]) {
          win.setContentSize(width, 1000);
          await wait(200);
          await evaluate(`document.querySelector('#aircraft-page-autotaxi').scrollIntoView({ behavior: 'instant' });`);
          await wait(120);
          await evaluate(`document.querySelector('#aircraft-page-autotaxi').scrollIntoView({ behavior: 'instant' });`);
          await wait(80);
          assert.equal(await evaluate('return document.documentElement.scrollWidth > innerWidth;'), false, `3D preview ${width}: no overflow`);
          await win.webContents.capturePage(); await wait(100);
          fs.writeFileSync(path.join(OUTPUT, `pmdg-737-autotaxi-3d-${width}.png`), (await win.webContents.capturePage()).toPNG());
        }
        await evaluate(`document.querySelector('#aircraft-page-autotaxi input[name="autotaxi-view"][value="2d"]').click(); await layoutTest.settle();`);
        assert.equal(await evaluate(`return document.querySelector('#aircraft-page-autotaxi .taxi-map').dataset.taxiView;`), '2d', 'the 2D map returns');
        assert.equal(await evaluate(`return Boolean(document.querySelector('#aircraft-page-autotaxi .compass[role="button"]'));`), true, 'the compass toggles north up again');
        await evaluate(`document.querySelectorAll('#aircraft-page-autotaxi button')[1].click(); await layoutTest.settle();`);
        const start = await evaluate(`return layoutTest.taxiSent.find(message => message.operation === 'start');`);
        assert.equal(start.icao, 'YMML'); assert.equal(start.runway, '16');
        assert.equal(start.profileKey, 'bundled/msfs/pmdg-737'); assert.equal(start.profileRevision, 1);
        assert.equal(await evaluate(`return document.querySelector('#aircraft-page-autotaxi input').disabled;`), true, 'running destination is locked');
        for (const width of [1440, 390, 320]) {
          win.setContentSize(width, 1000);
          await wait(200);
          await evaluate(`document.querySelector('#aircraft-page-autotaxi').scrollIntoView({ behavior: 'instant' });`);
          await wait(120);
          await evaluate(`document.querySelector('#aircraft-page-autotaxi').scrollIntoView({ behavior: 'instant' });`);
          await wait(80);
          assert.equal(await evaluate(`const top = document.querySelector('#aircraft-page-autotaxi').getBoundingClientRect().top; return top >= 0 && top < 150;`), true, 'taxi controls are visible in their screenshot');
          assert.equal(await evaluate('return document.documentElement.scrollWidth > innerWidth;'), false, `autotaxi ${width}: no overflow`);
          assert.equal(await evaluate(`return [...document.querySelectorAll('#aircraft-page-autotaxi button')].every(button => button.getBoundingClientRect().height >= 48);`), true, `autotaxi ${width}: touch targets`);
          await win.webContents.capturePage(); await wait(100);
          fs.writeFileSync(path.join(OUTPUT, `pmdg-737-autotaxi-${width}.png`), (await win.webContents.capturePage()).toPNG());
        }
        // While taxiing in 3D the world follows each new sample and the aircraft holds still.
        await evaluate(`document.querySelector('#aircraft-page-autotaxi input[name="autotaxi-view"][value="3d"]').click(); await layoutTest.settle();`);
        await wait(300);
        const scenePaths = `[...document.querySelectorAll('#aircraft-page-autotaxi .taxi-map path')].map(el => el.getAttribute('d') || '')`;
        const before = await evaluate(`return ${scenePaths};`);
        await evaluate(`layoutTest.moveAircraft({ x: 0.9, z: 20, headingDeg: 1 });`);
        await wait(800);
        const after = await evaluate(`return ${scenePaths};`);
        assert.equal(after.length, before.length);
        const changed = before.filter((d, i) => d !== after[i]).length, kept = before.filter((d, i) => d && d === after[i]).length;
        assert.ok(changed >= 4, `pavement and route move with the aircraft: ${changed} of ${before.length} paths changed`);
        assert.ok(kept >= 20, `the aircraft sprite is rigid to the camera: ${kept} paths unchanged`);
        await evaluate(`document.querySelector('#aircraft-page-autotaxi input[name="autotaxi-view"][value="2d"]').click(); await layoutTest.settle();`);
        await evaluate(`document.querySelectorAll('#aircraft-page-autotaxi button')[2].click(); await layoutTest.settle();`);
        assert.equal(await evaluate(`return layoutTest.taxiSent.filter(message => message.operation !== 'status').at(-1).operation;`), 'stop');
        await evaluate(`document.querySelectorAll('#aircraft-page-autotaxi button')[3].click(); await layoutTest.settle();`);
        assert.equal(await evaluate(`return layoutTest.taxiSent.filter(message => message.operation !== 'status').at(-1).operation;`), 'release');
        assert.equal(await evaluate(`return document.querySelector('#aircraft-page-autotaxi input').disabled;`), false, 'release restores the destination inputs');
        await evaluate(`document.querySelector('#aircraft-page-autotaxi input[name="autotaxi-mode"][value="stand"]').click(); await layoutTest.settle();`);
        await ready('#autotaxi-stands option');
        assert.deepEqual(await evaluate(`return [...document.querySelectorAll('#autotaxi-stands option')].map(option => ({ value: option.value, label: option.label }));`), [
          { value: 'Gate D 12', label: 'Gate D 12 — Medium gate' }, { value: 'Gate D 14', label: 'Gate D 14 — Heavy gate' },
        ]);
        await evaluate(`const input = document.querySelector('input[list="autotaxi-stands"]');
          input.value = input.list.options[0].value; input.dispatchEvent(new Event('input', { bubbles: true })); await layoutTest.settle();`);
        assert.equal(await evaluate(`return document.querySelector('#autotaxi-stand-type').textContent;`), 'Medium gate');
        for (const width of [1440, 390, 320]) {
          win.setContentSize(width, 1000);
          await wait(150);
          await evaluate(`document.querySelector('input[list="autotaxi-stands"]').scrollIntoView({ block: 'center', behavior: 'instant' });`);
          assert.equal(await evaluate('return document.documentElement.scrollWidth > innerWidth;'), false, `stand picker ${width}: no overflow`);
          await win.webContents.capturePage(); await wait(100);
          fs.writeFileSync(path.join(OUTPUT, `pmdg-737-autotaxi-stand-${width}.png`), (await win.webContents.capturePage()).toPNG());
        }
        await evaluate(`document.querySelector('#aircraft-page-autotaxi button').click(); await layoutTest.settle();`);
        assert.equal(await evaluate(`return layoutTest.taxiSent.filter(message => message.operation === 'preview').at(-1).parking;`), 'Gate D 12', 'type annotation does not change the routing name');
      }
      assert.equal(await evaluate(`return document.querySelector('[data-aircraft-preset="configuration.lights.takeoff"] button').disabled;`), false, `${id}: grouped takeoff preset is ready`);
      await evaluate(`document.querySelector('[data-aircraft-preset="configuration.lights.takeoff"] button').click(); await layoutTest.settle();`);
      assert.deepEqual(await evaluate('return layoutTest.sent.at(-1);'), { type: 'canonical', commandId: 'configuration.lights.takeoff', input: {} }, `${id}: grouped preset dispatches its existing command`);
      await evaluate(`document.querySelector('.aircraft-tools-toggle').click(); await layoutTest.settle();`);
      assert.equal(await evaluate(`return document.querySelector('[data-aircraft-controls-trigger]').getBoundingClientRect().height >= 44;`), true, `${id}: library remains touch accessible in Tools`);
      await evaluate(`document.querySelector('[data-aircraft-controls-trigger]').click(); await layoutTest.settle();`);
      await ready('[data-aircraft-controls-modal] input[type="search"]');
      assert.equal(await evaluate('return document.activeElement.type;'), 'search', `${id}: dialog focuses search`);
      const count = await evaluate('return document.querySelectorAll("[data-command-editor]").length;');
      const expected = await evaluate('return Object.values(layoutTest.controls.aircraftCommandCatalogue.commands).filter(command => command.kind !== "preset").length;');
      assert.equal(count, expected, `${id}: every non-preset command remains accessible`);
      assert.equal(await evaluate('return document.documentElement.scrollWidth > innerWidth;'), false, `${id}: dialog fits phone`);
      await wait(80);
      fs.writeFileSync(path.join(OUTPUT, `${id}-library.png`), (await win.webContents.capturePage()).toPNG());
      const command = await evaluate(`return Object.values(layoutTest.controls.aircraftCommandCatalogue.commands).find(command => command.kind !== 'preset' && command.input.kind === 'boolean');`);
      await evaluate(`const search = document.querySelector('[data-aircraft-controls-modal] input[type="search"]'); search.value = ${JSON.stringify(command.label)}; search.dispatchEvent(new Event('input', { bubbles: true })); await layoutTest.settle();`);
      assert.ok(await evaluate(`return document.querySelectorAll('[data-command-editor]').length < ${count};`), `${id}: library search narrows the results`);
      await evaluate(`document.querySelector('[data-command-editor="${command.id}"] [data-command-value="true"]').click(); await layoutTest.settle();`);
      assert.deepEqual(await evaluate('return layoutTest.sent.at(-1);'), { type: 'canonical', commandId: command.id, input: { value: true } }, `${id}: library dispatches the selected command`);
      await evaluate(`document.querySelector('[aria-label="Close aircraft controls"]').focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));`);
      assert.equal(await evaluate('return document.activeElement.closest("[data-aircraft-controls-modal]") !== null;'), true, `${id}: dialog retains keyboard focus`);
      await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await layoutTest.settle();`);
      assert.equal(await evaluate('return Boolean(document.querySelector("[data-aircraft-controls-modal]"));'), false);
      assert.equal(await evaluate('return document.activeElement.classList.contains("aircraft-tools-toggle");'), true, 'closing restores focus to the visible Tools launcher');
    }
    if (process.env.FF_CDU_LAYOUT_ONLY !== '1' && process.env.FF_AUTOTAXI_LAYOUT_ONLY !== '1') {
      const resizeTools = async (width, height) => {
        win.setContentSize(width, height);
        await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await win.webContents.capturePage(); await wait(100);
      };
      const activateTool = async (selector, touch) => {
        const point = await evaluate(`const el=document.querySelector(${JSON.stringify(selector)}), r=el.getBoundingClientRect();
          return {x:r.left+r.width/2,y:r.top+r.height/2,visible:r.width>0&&r.height>0};`);
        assert(point.visible && await evaluate(`return document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${point.x},${point.y}));`), `${selector}: pointer can reach the tool`);
        if (touch) {
          await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{x:point.x,y:point.y}] });
          await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] });
        } else {
          const location = { x:Math.round(point.x), y:Math.round(point.y), button:'left', clickCount:1 };
          win.webContents.sendInputEvent({ type:'mouseDown', ...location });
          win.webContents.sendInputEvent({ type:'mouseUp', ...location });
        }
        await win.webContents.capturePage(); await wait(100);
      };
      await evaluate(`await layoutTest.scenario('pmdg-777');`);
      const toolActivations = [];
      for (const [width, touch] of [[900, false], [390, true], [320, true]]) {
        await resizeTools(width, 844);
        await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled:touch, maxTouchPoints:touch ? 5 : 1 });
        await evaluate(`window.scrollTo({ top:0, behavior:'instant' });`);
        for (const [trigger, modal] of [
          ['data-aircraft-integration-guide-trigger', 'aircraft-integration-cheatsheet-modal'],
          ['data-aircraft-voice-control-trigger', 'aircraft-voice-control-modal'],
          ['data-aircraft-controls-trigger', 'aircraft-controls-modal'],
        ]) {
          await activateTool('.aircraft-tools-toggle', touch);
          assert.equal(await evaluate(`return document.querySelector('.aircraft-tools-toggle').getAttribute('aria-expanded');`), 'true', `${width}px: native pointer opens Tools`);
          await activateTool(`[${trigger}]`, touch);
          const opened = await evaluate(`return Boolean(document.getElementById('${modal}'));`);
          toolActivations.push({ width, input:touch ? 'touch' : 'mouse', trigger, opened });
          assert.equal(await evaluate(`return document.querySelector('.aircraft-tools-toggle').getAttribute('aria-expanded');`), 'false', 'opening a tool closes its disclosure');
          win.webContents.sendInputEvent({ type:'keyDown', keyCode:'Escape' });
          win.webContents.sendInputEvent({ type:'keyUp', keyCode:'Escape' });
          await wait(100);
          if (opened) assert.equal(await evaluate(`return !document.getElementById('${modal}') && document.activeElement.classList.contains('aircraft-tools-toggle');`), true, `${width}px: closing ${modal} restores the Tools launcher`);
        }
      }
      assert.deepEqual(toolActivations.filter(result => !result.opened), [], 'every Tools action opens its dialog with native mouse/touch input');
      await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled:false, maxTouchPoints:1 });
      await resizeTools(390, 844);
      await evaluate(`window.scrollTo({ top: 0, behavior: 'instant' }); document.querySelector('.aircraft-tools-toggle').click(); await layoutTest.settle();`);
      const secondaryTools = await evaluate(`const panel = document.getElementById('aircraft-secondary-tools-panel'); const rect = panel.getBoundingClientRect();
        return { left: rect.left, right: rect.right, choices: [...panel.querySelectorAll('button')].map(button => button.getBoundingClientRect().height) };`);
      assert.ok(secondaryTools.left >= 0 && secondaryTools.right <= 390, `phone Tools disclosure fits the viewport: ${JSON.stringify(secondaryTools)}`);
      assert.equal(secondaryTools.choices.length, 3, 'Tools contains guide, voice and library once');
      assert.ok(secondaryTools.choices.every(height => height >= 44), 'secondary tools keep touch-sized targets');
      await evaluate(`document.querySelector('[data-aircraft-integration-guide-trigger]').focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await layoutTest.settle();`);
      assert.equal(await evaluate(`return document.querySelector('.aircraft-tools-toggle').getAttribute('aria-expanded') === 'false' && document.activeElement.classList.contains('aircraft-tools-toggle');`), true, 'Escape closes Tools and restores its visible launcher');
      await evaluate(`document.querySelector('.aircraft-tools-toggle').click(); await layoutTest.settle(); document.querySelector('.aircraft-find__launcher').focus(); await layoutTest.settle();`);
      assert.equal(await evaluate(`return document.querySelector('.aircraft-tools-toggle').getAttribute('aria-expanded');`), 'false', 'leaving Tools by keyboard closes it');
      await evaluate(`document.querySelector('.aircraft-tools-toggle').click(); await layoutTest.settle(); document.querySelector('.aircraft-find__launcher').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await layoutTest.settle();`);
      assert.equal(await evaluate(`return document.querySelector('.aircraft-tools-toggle').getAttribute('aria-expanded');`), 'false', 'pointer activation outside Tools closes it');
      for (const [trigger, modal] of [['data-aircraft-voice-control-trigger', 'aircraft-voice-control-modal'], ['data-aircraft-integration-guide-trigger', 'aircraft-integration-cheatsheet-modal']]) {
        await evaluate(`document.querySelector('.aircraft-tools-toggle').click(); await layoutTest.settle(); document.querySelector('[${trigger}]').click(); await layoutTest.settle();`);
        await ready(`#${modal}`);
        assert.equal(await evaluate(`return document.querySelector('.aircraft-tools-toggle').getAttribute('aria-expanded');`), 'false', 'opening a tool closes its disclosure');
        await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await layoutTest.settle();`);
        assert.equal(await evaluate(`return !document.getElementById('${modal}') && document.activeElement.classList.contains('aircraft-tools-toggle');`), true, `${modal}: close restores the visible Tools launcher`);
      }
      await evaluate(`document.querySelector('.aircraft-tools-toggle').focus();`);
      await resizeTools(1440, 1000);
      assert.equal(await evaluate(`return document.activeElement.hasAttribute('data-aircraft-integration-guide-trigger') && document.activeElement.getBoundingClientRect().height > 0;`), true, 'a disappearing Tools launcher transfers focus to its visible desktop tool');
      await resizeTools(390, 844);
      const compactFocus = await evaluate(`return { class: document.activeElement.className, width: innerWidth, tools: document.querySelector('.aircraft-tools-toggle').getBoundingClientRect().height, guide: document.querySelector('[data-aircraft-integration-guide-trigger]').getBoundingClientRect().height };`);
      assert.equal(compactFocus.class.includes('aircraft-tools-toggle'), true, `a disappearing desktop tool transfers focus to the phone disclosure: ${JSON.stringify(compactFocus)}`);
      await evaluate(`document.querySelector('.aircraft-find__launcher').click(); await layoutTest.settle(); const input = document.getElementById('aircraft-find-input'); input.value = 'heading'; input.dispatchEvent(new Event('input', { bubbles: true })); await layoutTest.settle();`);
      for (const [width, height] of [[1440, 1000], [700, 390], [320, 700]]) {
        await resizeTools(width, height);
        assert.equal(await evaluate(`return document.activeElement.id === 'aircraft-find-input' && document.getElementById('aircraft-find-input').value === 'heading' && Boolean(document.querySelector('[data-aircraft-find-current]'));`), true, 'resizing preserves the visible search input, query and matches');
      }
      await evaluate(`document.querySelector('.aircraft-find__collapse').click(); await layoutTest.settle(); layoutTest.specific.sourceStatus = 'stale'; await layoutTest.settle();`);
      assert.equal(await evaluate(`return document.querySelector('.aircraft-connection-summary').getBoundingClientRect().height > 0;`), true, 'phone density does not hide stale-data context');
      await evaluate(`layoutTest.specific.dependencies = { mobiflightEventModule: { required: true, connected: false, status: 'missing' } }; await layoutTest.settle();`);
      assert.equal(await evaluate(`return document.querySelector('[data-aircraft-setup-required]')?.getBoundingClientRect().height > 0 && document.getElementById('aircraft-mobiflight-notice')?.getBoundingClientRect().height > 0;`), true, 'setup reasons and recovery remain visible on phone');
      await evaluate(`layoutTest.specific.dependencies = { mobiflightEventModule: { required: true, connected: false, status: 'missing', fallbackActive: true } }; await layoutTest.settle();`);
      assert.equal(await evaluate(`return document.querySelector('[data-aircraft-control-mode="direct-lvar-fallback"]')?.getBoundingClientRect().height > 0;`), true, 'fallback control routing remains explicit on phone');
      await win.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
    }
    for (const id of (process.env.FF_AUTOTAXI_LAYOUT_ONLY === '1' || process.env.FF_AIRCRAFT_TOOLS_ONLY === '1' ? [] : ['fenix-a320', 'fbw-a32nx', 'pmdg-737', 'pmdg-777'])) {
      await evaluate(`await layoutTest.scenario(${JSON.stringify(id)}); document.querySelector('[data-cdu-trigger]').click(); await layoutTest.settle();`);
      await ready('[data-cdu-modal]');
      if (id === 'fenix-a320') {
        await ready('[data-cdu-modal] a');
        assert.match(await evaluate(`return document.querySelector('[data-cdu-modal] a').href;`), /^http:\/\/127\.0\.0\.1:8083\/$/);
      } else {
        await ready('[data-cdu-modal] .cdu-entry-keys');
        for (const [width, height] of [[1440, 1000], [1440, 700], [1440, 600], [430, 932], [390, 844], [390, 700], [360, 640], [320, 568], [320, 480], [568, 320], [667, 375], [844, 320], [844, 390]]) {
          // Short or landscape phones keep thumb-sized keys and a readable
          // display and let the keypad scroll instead; everything else fits.
          const landscape = width >= 700 && height <= 500;
          const scrollPanel = (width < 700 && height < 560) || (landscape && height < 360)
            || (!landscape && width > 600 && height < 650);
          const compact = landscape || height < 800;
          const minKeyHeight = landscape ? 32 : 40;
          win.setContentSize(width, height);
          // Hidden Electron windows can defer viewport-unit/media-query updates.
          await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
          // Drive a compositor frame before checking styles in the hidden window.
          await win.webContents.capturePage();
          await wait(100);
          const measurements = await evaluate(`return {
            viewport: innerWidth,
            fontSize: getComputedStyle(document.querySelector('.cdu-screen-row')).fontSize,
            smallFontSize: document.querySelector('.cdu-cell.small') ? getComputedStyle(document.querySelector('.cdu-cell.small')).fontSize : null,
            screenWidth: document.querySelector('.cdu-screen').getBoundingClientRect().width,
            dialogWidth: document.querySelector('.cdu-dialog').getBoundingClientRect().width,
            overflow: document.documentElement.scrollWidth > innerWidth,
            pageOverflow: [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(el.parentElement).overflowX !== 'auto').slice(0, 8).map(el => ({ tag: el.tagName, class: el.className, width: el.getBoundingClientRect().width })),
            verticalOverflow: ${JSON.stringify(['.cdu-dialog', ...(scrollPanel ? [] : ['.cdu-content']), '.cdu-function-keys', '.cdu-entry-keys'])}.some(selector => {
              const el = document.querySelector(selector); return el.scrollHeight > el.clientHeight + 1;
            }),
            overflowing: ['.cdu-dialog', '.cdu-content', '.cdu-keypad', '.cdu-function-keys', '.cdu-entry-keys'].map(selector => {
              const el = document.querySelector(selector); return [selector, el.clientHeight, el.scrollHeight];
            }).filter(([, client, scroll]) => scroll > client + 1),
            keypadScrolls: (() => { const el = document.querySelector('.cdu-keypad'); return el.scrollHeight > el.clientHeight + 1; })(),
            visibleKeys: [...document.querySelectorAll('.cdu-key')].every(el => {
              const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
            }),
            keysFitWidth: [...document.querySelectorAll('.cdu-key')].every(el => {
              const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth;
            }),
            lastKeyReachable: (() => {
              const keypad = document.querySelector('.cdu-keypad'), content = document.querySelector('.cdu-content');
              const keys = [...keypad.querySelectorAll('.cdu-key')];
              content.scrollTop = content.scrollHeight; keypad.scrollTop = keypad.scrollHeight;
              const r = keys.at(-1).getBoundingClientRect(); keypad.scrollTop = 0; content.scrollTop = 0;
              return r.top >= 0 && r.bottom <= innerHeight + .5;
            })(),
            screenVisible: (() => { const r = document.querySelector('.cdu-screen').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })(),
            cells: document.querySelectorAll('.cdu-screen-row').length,
            minKey: [...document.querySelectorAll('.cdu-keypad .cdu-key')].reduce((min, el) => { const r = el.getBoundingClientRect(); return [Math.min(min[0], r.width), Math.min(min[1], r.height)]; }, [Infinity, Infinity]),
            minLineKey: [...document.querySelectorAll('.cdu-line-key')].reduce((min, el) => { const r = el.getBoundingClientRect(); return [Math.min(min[0], r.width), Math.min(min[1], r.height)]; }, [Infinity, Infinity]),
            screen: document.querySelector('.cdu-screen').getAttribute('aria-label'),
          };`);
          assert.equal(measurements.overflow, false, `${id} CDU fits ${width}px: ${JSON.stringify(measurements.pageOverflow)}`);
          assert.equal(measurements.verticalOverflow, false, `${id} CDU dialog needs no scrolling at ${width}x${height}: ${JSON.stringify(measurements)}`);
          assert.equal(measurements.viewport, width, 'CDU uses the requested viewport');
          if (compact) {
            assert.equal(measurements.keysFitWidth, true, `${id} CDU keys fit the width at ${width}x${height}`);
            if (!scrollPanel) assert.equal(measurements.screenVisible, true, `${id} CDU display stays on screen at ${width}x${height}`);
            assert.equal(measurements.lastKeyReachable, true, `${id} CDU keypad scrolls to its last key at ${width}x${height}: ${JSON.stringify(measurements)}`);
          } else {
            assert.equal(measurements.keypadScrolls, false, `${id} CDU keypad needs no scrolling at ${width}x${height}: ${JSON.stringify(measurements)}`);
            assert.equal(measurements.visibleKeys, true, `${id} CDU keeps every key on screen at ${width}x${height}`);
          }
          if (width === 1440 && height === 1000) assert.ok(parseFloat(measurements.fontSize) >= 18, `CDU desktop text is readable: ${JSON.stringify(measurements)}`);
          if (measurements.smallFontSize) assert.ok(parseFloat(measurements.smallFontSize) >= parseFloat(measurements.fontSize) * .75, `CDU small text stays readable: ${JSON.stringify(measurements)}`);
          if (measurements.smallFontSize) assert.ok(parseFloat(measurements.smallFontSize) >= 10, `CDU small text never drops below 10px at ${width}x${height}: ${JSON.stringify(measurements)}`);
          assert.equal(measurements.cells, 14);
          assert.ok(measurements.minKey[0] >= 44 && measurements.minKey[1] >= minKeyHeight - .5, `${id} CDU ${width}x${height} keypad touch targets (min ${measurements.minKey}, need 44x${minKeyHeight})`);
          // Line-select keys follow the display's row pitch, so they are a little shorter than keypad keys on the smallest phones.
          assert.ok(measurements.minLineKey[0] >= 44 && measurements.minLineKey[1] >= (landscape ? 32 : 36) - .5, `${id} CDU ${width}x${height} line-select touch targets (min ${measurements.minLineKey})`);
          assert.match(measurements.screen, /IDENT|APPR/);
          fs.writeFileSync(path.join(OUTPUT, `${id}-cdu-${width}x${height}.png`), (await win.webContents.capturePage()).toPNG());
          if (width === 320) {
            await evaluate(`const first = document.querySelector('.cdu-help-toggle'); first.focus();
              first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
              await layoutTest.settle();`);
            assert.equal(await evaluate(`const last = [...document.querySelectorAll('.cdu-keypad button')].at(-1);
              const rect = last.getBoundingClientRect();
              return document.activeElement === last && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === last;`), true,
            `${id}: Shift+Tab reveals the focused last key at ${width}x${height}`);
            await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); await layoutTest.settle();`);
            assert.equal(await evaluate(`return document.activeElement === document.querySelector('.cdu-help-toggle');`), true, 'Tab wraps back to the visible header');
            await evaluate(`document.querySelector('.cdu-content').scrollTop = 0; document.querySelector('.cdu-keypad').scrollTop = 0;`);
          }
          if (scrollPanel) {
            await evaluate(`document.querySelector('.cdu-help-toggle').click(); await layoutTest.settle();`);
            const helpVisible = await evaluate(`const help = document.querySelector('#cdu-help h3').getBoundingClientRect();
              const content = document.querySelector('.cdu-content').getBoundingClientRect();
              return help.top >= content.top && help.bottom <= content.bottom;`);
            assert.equal(helpVisible, true, `${id}: help scrolls into view on ${width}x${height}`);
            await evaluate(`document.querySelector('.cdu-help-toggle').click(); await layoutTest.settle(); document.querySelector('.cdu-content').scrollTop = 0;`);
          }
        }
        await evaluate(`document.querySelector('.cdu-content').scrollTop = 9999;`);
        await win.webContents.capturePage(); await wait(50);
        assert.equal(await evaluate(`return document.querySelector('.cdu-content').scrollTop;`), 0, 'at 844x390 only the keypad scrolls; the display stays fixed');
        await evaluate(`document.querySelector('.cdu-help-toggle').click(); await layoutTest.settle();`);
        assert.equal(await evaluate(`return Boolean(document.querySelector('#cdu-help')) && getComputedStyle(document.querySelector('.cdu-keypad')).display === 'none';`), true, 'help replaces the keypad without expanding the dialog');
        await evaluate(`document.querySelector('.cdu-help-toggle').click(); await layoutTest.settle();`);
        await evaluate(`document.querySelector('[aria-label="Right line select 2"]').click(); await layoutTest.settle();`);
        assert.equal(await evaluate(`return layoutTest.cduSent.at(-1).key;`), 'R2');
        await evaluate(`const select = document.querySelector('[aria-label="CDU unit"]'); select.value = 'right'; select.dispatchEvent(new Event('change', { bubbles: true })); await layoutTest.settle();`);
        await wait(50);
        await evaluate(`const button = [...document.querySelectorAll('.cdu-entry-keys button')].find(el => el.textContent === 'A'); button.click(); await layoutTest.settle();`);
        assert.equal(await evaluate(`return layoutTest.cduSent.at(-1).side;`), 'right');
        await evaluate(`const button = document.querySelector('[data-cdu-modal] button[aria-pressed]'); button.click(); button.focus(); button.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true })); await layoutTest.settle();`);
        await wait(80);
        assert.equal(await evaluate(`return layoutTest.cduSent.filter(message => message.type === 'sendCduKey').at(-1).key;`), 'B');
        await evaluate(`for (const key of ['K', 'L', 'A', 'X']) {
          document.querySelector('.cdu-entry-keys [data-key="' + key + '"]').click(); await layoutTest.settle();
        }`);
        assert.equal(await evaluate(`return [...document.querySelectorAll('.cdu-entry-keys button')].every(button => !button.disabled);`), true, 'type-ahead leaves the touch keypad enabled');
        await wait(300);
        assert.deepEqual(await evaluate(`return layoutTest.cduSent.filter(message => message.type === 'sendCduKey').slice(-4).map(message => message.key);`), ['K', 'L', 'A', 'X'], 'fast taps arrive in order');
        win.setContentSize(320, 568);
        await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 1, mobile: false });
        await win.webContents.capturePage(); await wait(100);
        for (const skin of ['flight-deck', 'crt', 'orbit', 'neon', 'toon', 'pastel', 'blackout', 'brass']) {
          await evaluate(`const select = document.querySelector('[data-cdu-skin-select]'); select.value = ${JSON.stringify(skin)}; select.dispatchEvent(new Event('change', { bubbles: true })); await layoutTest.settle();`);
          await win.webContents.capturePage(); await wait(50);
          const skinLayout = await evaluate(`return {
            smallText: Math.min(...[...document.querySelectorAll('.cdu-cell.small')].map(cell => parseFloat(getComputedStyle(cell).fontSize))),
            clippedText: [...document.querySelectorAll('.cdu-cell')].some(cell => cell.scrollWidth > cell.clientWidth + 1),
            keyWidth: Math.min(...[...document.querySelectorAll('.cdu-keypad .cdu-key')].map(key => key.getBoundingClientRect().width)),
            overflow: document.querySelector('.cdu-content').scrollHeight > document.querySelector('.cdu-content').clientHeight + 1,
            horizontalOverflow: document.querySelector('.cdu-keypad').scrollWidth > document.querySelector('.cdu-keypad').clientWidth + 1,
          };`);
          assert.ok(skinLayout.smallText >= 10, `${id} ${skin}: small display labels stay readable: ${JSON.stringify(skinLayout)}`);
          assert.equal(skinLayout.clippedText, false, `${id} ${skin}: characters fit their display columns`);
          assert.ok(skinLayout.keyWidth >= 44, `${id} ${skin}: keys remain wide enough to tap`);
          assert.equal(skinLayout.overflow, false, `${id} ${skin}: content fits the phone`);
          assert.equal(skinLayout.horizontalOverflow, false, `${id} ${skin}: key labels fit without horizontal scrolling`);
          fs.writeFileSync(path.join(OUTPUT, `${id}-cdu-${skin}-320x568.png`), (await win.webContents.capturePage()).toPNG());
        }
        await evaluate(`const select = document.querySelector('[data-cdu-skin-select]'); select.value = 'flight-deck'; select.dispatchEvent(new Event('change', { bubbles: true })); await layoutTest.settle();`);
        // A browser toolbar or safe-area inset can reduce the actual dialog
        // height without crossing a CSS viewport-height breakpoint.
        await evaluate(`document.documentElement.style.setProperty('--ff-visual-viewport-height', '460px'); await layoutTest.settle();`);
        await win.webContents.capturePage(); await wait(50);
        assert.equal(await evaluate(`const content = document.querySelector('.cdu-content'), keypad = document.querySelector('.cdu-keypad');
          content.scrollTop = content.scrollHeight; keypad.scrollTop = keypad.scrollHeight;
          const key = [...keypad.querySelectorAll('button')].at(-1).getBoundingClientRect(), dialog = document.querySelector('.cdu-dialog').getBoundingClientRect();
          return key.top >= dialog.top && key.bottom <= dialog.bottom && dialog.height <= 461;`), true, 'reduced browser height leaves the last key reachable');
        await evaluate(`document.documentElement.style.removeProperty('--ff-visual-viewport-height'); document.querySelector('.cdu-content').scrollTop = 0; document.querySelector('.cdu-keypad').scrollTop = 0;`);
        await evaluate(`layoutTest.setCduError('CDU key delivery was not confirmed. Check the aircraft before trying again.');`);
        const errorLayout = await settled(`return {
          error: document.querySelector('.cdu-status').textContent,
          overflow: ['.cdu-content', '.cdu-display-area', '.cdu-function-keys', '.cdu-entry-keys'].filter(selector => {
            const el = document.querySelector(selector); return el.scrollHeight > el.clientHeight + 1;
          }),
          // The keypad scrolls on this phone size; the error line must leave its last key reachable, not clipped.
          visible: (() => {
            const keypad = document.querySelector('.cdu-keypad'); keypad.scrollTop = keypad.scrollHeight;
            const reachable = [...keypad.querySelectorAll('.cdu-key')].at(-1).getBoundingClientRect().bottom <= innerHeight + .5;
            keypad.scrollTop = 0; return reachable;
          })(),
        };`, layout => /Check the aircraft/.test(layout.error) && layout.overflow.length === 0 && layout.visible);
        assert.match(errorLayout.error, /Check the aircraft/);
        assert.deepEqual(errorLayout.overflow, [], `${id}: the error message must not clip the keypad`);
        assert.equal(errorLayout.visible, true, `${id}: the error message must leave the last key reachable`);
        await evaluate(`layoutTest.setCduError(null);`);
        await evaluate(`layoutTest.controls.setAvailability({ enabled: false, reason: 'Read-only connection' }); await layoutTest.settle();`);
        assert.equal(await evaluate(`return [...document.querySelectorAll('.cdu-key')].every(el => el.disabled);`), true);
        await evaluate(`layoutTest.cduDisconnect(); await layoutTest.settle();`);
        assert.equal(await settled(`return document.querySelector('.cdu-screen').getAttribute('data-powered');`, powered => powered === 'false'), 'false');
      }
      await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await layoutTest.settle();`);
      assert.equal(await evaluate(`return document.activeElement.hasAttribute('data-cdu-trigger');`), true);
    }
    assert.deepEqual(errors, [], 'no runtime errors');
    console.log(process.env.FF_CDU_LAYOUT_ONLY === '1'
      ? 'CDU layout passed: Fenix launcher and FBW/PMDG screens at desktop, phone and landscape sizes; readable skins, reachable scrolling keypads, type-ahead, help, units, disconnects and focus restoration.'
      : process.env.FF_AIRCRAFT_TOOLS_ONLY === '1'
      ? 'Aircraft phone tools passed: disclosure, guide, voice, resize focus, search continuity, and visible stale/setup/fallback context.'
      : process.env.FF_AUTOTAXI_LAYOUT_ONLY === '1'
      ? 'PMDG 737 Experimental Autotaxi passed at desktop, 390px, 320px and landscape: navigation, route preview, maps, Start, Stop and Release use fake transport.'
      : 'Aircraft layout passed: six families at desktop, 390px, 320px and landscape; phone search/tools, grouped presets, unique controls, command dialog and focus restoration.');
    app.exit(0);
  } catch (error) {
    console.error(error, errors);
    try {
      fs.writeFileSync(path.join(OUTPUT, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    } catch (captureError) {
      console.error('Could not capture the failed layout; the original failure is reported above:', captureError);
    }
    app.exit(1);
  }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  // Keep one complete stylesheet throughout the run, including when another
  // frontend build replaces frontend-dist while screenshots are being captured.
  const layoutCss = fs.readFileSync(path.join(ROOT, 'frontend-dist/tailwind.css'), 'utf8');
  assert(layoutCss.length > 10000, 'build the frontend stylesheet before layout checks');
  const { resolveBackendRuntimeFile: runtime } = require('./backend-runtime-paths');
  const loader = require(runtime('aircraft/aircraft-profile-loader.js'));
  const { buildAircraftControlCapabilities } = require(runtime('aircraft/aircraft-control-service.js'));
  const registry = require(runtime('aircraft/aircraft-integrations/index.js')).defaultAircraftIntegrationRegistry;
  const { createPmdgCdu, decodePmdgScreen } = require(runtime('telemetry-provider/cdu/pmdg-737.js'));
  const { createPmdg777Cdu } = require(runtime('telemetry-provider/cdu/pmdg-777.js'));
  const { createFbwCdu, decodeFbwScreen } = require(runtime('telemetry-provider/cdu/fbw-a32nx.js'));
  const pmdgCdu = createPmdgCdu({ sendEvent: async () => ({ ok: false }) });
  const pmdg777Cdu = createPmdg777Cdu({ sendEvent: async () => ({ ok: false }) });
  const fbwCdu = createFbwCdu();
  const cduFixture = id => {
    if (id === 'fenix-a320') return { mode: 'external', label: 'Fenix web MCDU', externalPort: 8083, setup: 'Open the Fenix web EFB and select MCDU.' };
    if (!['pmdg-737', 'pmdg-777', 'fbw-a32nx'].includes(id)) return null;
    const adapter = id === 'pmdg-737' ? pmdgCdu : id === 'pmdg-777' ? pmdg777Cdu : fbwCdu;
    const raw = Array(1009).fill(0); raw[1008] = 1;
    ['         IDENT', 'MODEL              ENG', '737-800       CFM56-7B', '', 'NAV DATA', 'ACTIVE         2401', '', 'OP PROGRAM', 'FLIGHTFABRIC', '', 'CO DATA', '', '<INDEX       POS INIT>', ''].forEach((line, row) => [...line].forEach((char, column) => {
      const offset = (column * 14 + row) * 3; raw[offset] = char.charCodeAt(0); raw[offset + 2] = row % 2;
    }));
    const lines = Array.from({ length: 12 }, () => ['', '', '']);
    lines[0] = ['QNH', 'TEMP']; lines[1] = ['{cyan}1013{end}', '{cyan}15°{end}'];
    lines[2] = ['MAG WIND', 'BARO']; lines[3] = ['{cyan}270/08{end}', '{cyan}320{end}'];
    lines[10] = ['TRANS ALT', 'LDG CONF']; lines[11] = ['{cyan}5000{end}', '{green}FULL{end}'];
    if (id === 'pmdg-777') ['777-300ER       GE90'].forEach(line => [...line.padEnd(24)].forEach((char, column) => { raw[(column * 14 + 2) * 3] = char.charCodeAt(0); }));
    const screen = id.startsWith('pmdg-') ? decodePmdgScreen(raw) : decodeFbwScreen({ title: '{green}APPR{end}', scratchpad: '{cyan}YSSY{end}', lines, displayBrightness: 1 });
    return { mode: 'integrated', label: adapter.label, setup: adapter.setup, functionKeys: adapter.functionKeys, entryKeys: adapter.entryKeys, screen, sessionId: 'fixture' };
  };
  const fixtures = Object.fromEntries([...new Set([...AIRCRAFT, ...AUTOTAXI_AIRCRAFT])].map(id => {
    const templateId = templateFor(id);
    const profile = loader.loadProfile(`bundled/msfs/${id}`);
    const capabilities = buildAircraftControlCapabilities(profile, { profileRevision: 1,
      capabilities: { simulator: 'msfs', actionTypes: ['aircraft-integration', 'key-event', 'lvar'],
        integrationTransports: ['sdk', 'simconnect-sequence', 'lvar', 'mobiflight-calculator'] } });
    const values = Object.fromEntries(Object.values(registry.getById(templateId)?.fields || {}).map(field => {
      const decode = field.sources[0]?.decode;
      return [field.id, decode?.type === 'boolean' ? false : decode?.type === 'enum' ? Object.values(decode.values)[0] : 0];
    }));
    for (const command of Object.values(capabilities.aircraftCommands.commands)) {
      for (const field of command.brightnessFields || []) values[field] = 50;
    }
    Object.assign(values, { 'mcp.headingDeg': 270, 'mcp.altitudeFt': 12000, 'mcp.speed': 250,
      'mcp.courseCaptainDeg': 270, 'mcp.courseFirstOfficerDeg': 270,
      'radios.nav1ActiveMhz': 109.5, 'radios.nav2ActiveMhz': 109.5, 'radios.nav1StandbyMhz': 110.3, 'radios.nav2StandbyMhz': 110.3 });
    const taxiSupport = { family: templateId, aircraftLabel: id === 'generic' ? 'Generic aircraft' : id.startsWith('fenix-') ? `Fenix ${id.slice(6).toUpperCase()}` : id.replace('pmdg-', 'PMDG '), qualificationStatus: 'candidate', reason: null,
      setupInstructions: id.startsWith('pmdg-') ? ['In PMDG setup, select Tiller + Rudder steering hardware.'] : id.startsWith('fenix-') ? ['Prepare the aircraft with automatic thrust control off.'] : ['Use standard simulator throttle, brake and steering controls.'] };
    return [id, { templateId, capabilities, values, cdu: cduFixture(id), taxiSupport }];
  }));
  fixtures.__autotaxiFixture = AUTOTAXI_FIXTURE;
  const { createServer } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/vite/dist/node/index.js')).href);
  const { default: vue } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs')).href);
  const server = await createServer({ configFile: false, root: ROOT, logLevel: 'error',
    cacheDir: path.join(OUTPUT, 'vite-cache'), optimizeDeps: { entries: ['tests/fixtures/aircraft-layout-browser.js'] },
    plugins: [vue(), { name: 'aircraft-layout-fixture', configureServer(vite) {
      vite.middlewares.use('/aircraft-layout.css', (_req, res) => { res.setHeader('Content-Type', 'text/css'); res.end(layoutCss); });
      vite.middlewares.use('/aircraft-layout-fixtures', (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(fixtures)); });
      vite.middlewares.use('/aircraft-layout-test', (_req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/aircraft-layout.css"><style>body{margin:0;padding:16px;background:#171b22;color:#d1d5db;font-family:system-ui}#app{max-width:1440px;margin:auto}</style></head><body><div id="app" class="tab-section active"></div><script type="module" src="/tests/fixtures/aircraft-layout-browser.js"></script></body></html>');
      });
    } }], resolve: { alias: { vue: path.join(ROOT, 'frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'),
      pinia: path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs') } },
    // Fixtures do not need hot reload; scanning the repository scratch tree delays page loads.
    server: { host: '127.0.0.1', port: 0, watch: null } });
  await server.listen();
  try {
    const env = { ...process.env, FF_AIRCRAFT_LAYOUT_TEST_URL: `http://127.0.0.1:${server.httpServer.address().port}/aircraft-layout-test` };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { env, cwd: ROOT, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill(), 90000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearTimeout(timer);
    assert.equal(code, 0, 'aircraft layout browser checks');
  } finally { await server.close(); }
}
(process.versions.electron ? browser() : main()).catch(error => { console.error(error); process.exit(1); });
