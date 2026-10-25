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
const A380 = 'inibuilds-a380-800-rr';
const INCLUDED_A32X = ['inibuilds-a320neo-v2', 'inibuilds-a321lr'];
const AUTOTAXI_AIRCRAFT = ['generic', 'pmdg-737', 'pmdg-777', 'fenix-a319', 'fenix-a320', 'fenix-a321'];
const AUTOTAXI_FIXTURE = process.env.FF_AUTOTAXI_LAYOUT_FIXTURE === '1';
const templateFor = id => INCLUDED_A32X.includes(id) ? 'microsoft-inibuilds-a32x' : id === A380 ? 'inibuilds-a380' : ['fenix-a319', 'fenix-a320', 'fenix-a321'].includes(id) ? 'fenix-a32x' : id.startsWith('inibuilds-a350') ? 'inibuilds-a350' : id;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function checkMountedNumericDrafts({ evaluate }) {
  const cases = [
    { panel: 'fbw-a380x', field: 'flightGuidance.altitudeFt', input: 'a380-target-altitude', route: 'command' },
    { panel: 'inibuilds-a330', field: 'flightGuidance.altitudeFt', input: 'a330-target-altitude', route: 'action' },
    { panel: 'microsoft-737-max-8', field: 'mcp.altitudeFt', input: 'microsoft-737-max-8-target-altitude', route: 'action' },
    { panel: 'microsoft-inibuilds-a32x', field: 'fcu.altitudeFtNative', input: 'microsoft-inibuilds-a32x-target-altitude', route: 'action' },
  ];
  for (const fixture of cases) {
    const result = await evaluate(`
      const fixture = ${JSON.stringify(fixture)};
      await layoutTest.mountNumericPanel(fixture.panel, fixture.field);
      const state = layoutTest.numericDraftState;
      const input = () => document.getElementById(fixture.input);
      const states = {};
      const record = name => {
        const element = input();
        states[name] = { value: element.value, disabled: element.disabled,
          invalid: element.getAttribute('aria-invalid'),
          error: element.form.querySelector('[role="alert"]')?.textContent || '' };
      };
      const type = async value => {
        input().value = value;
        input().dispatchEvent(new Event('input', { bubbles: true }));
        await layoutTest.settle();
      };
      const submit = async () => { input().form.requestSubmit(); await layoutTest.settle(); };
      record('initial');
      state.values[fixture.field] = 13000; await layoutTest.settle(); record('live');
      await type('15000');
      state.values[fixture.field] = 13500; await layoutTest.settle(); record('dirty');
      await type('15050'); await submit(); record('invalid');
      state.values[fixture.field] = 14000; await layoutTest.settle(); record('invalidAfterTelemetry');
      const invalidDispatchCount = state.commands.length;
      state.pending = true; state.unavailable = [fixture.field];
      await layoutTest.settle(); record('unavailablePending');
      state.unavailable = []; state.values[fixture.field] = 14500;
      await layoutTest.settle(); record('availablePending');
      state.pending = false; await layoutTest.settle(); record('available');
      await type('15000'); state.accepted = false; await submit(); record('rejected');
      state.values[fixture.field] = 14600; await layoutTest.settle(); record('rejectedAfterTelemetry');
      state.accepted = true; await submit(); record('acceptedPending');
      state.values[fixture.field] = 14700; await layoutTest.settle(); record('pendingReadback');
      state.values[fixture.field] = 15000; state.pending = false;
      await layoutTest.settle(); record('confirmed');
      await type('15550'); await submit();
      state.sourceStatus = 'disconnected'; await layoutTest.settle(); record('disconnected');
      state.values[fixture.field] = 16000; state.sourceStatus = 'connected';
      await layoutTest.settle(); record('reconnected');
      await type('17000'); state.sourceStatus = 'stale';
      await layoutTest.settle(); record('stale');
      state.values[fixture.field] = 16500; state.sourceStatus = 'connected';
      await layoutTest.settle(); record('fresh');
      await type('18000');
      // This is an isolated component-boundary context token, not a claim
      // that one aircraft's commands are supported by another aircraft.
      state.profileKey = 'test/replacement/' + fixture.panel;
      state.values[fixture.field] = 17500; await layoutTest.settle(); record('contextChanged');
      await type('19000');
      const commands = state.commands.map(command => ({ ...command }));
      const retiredInput = input();
      await layoutTest.mountNumericPanel(fixture.panel, fixture.field);
      const replacedInput = input() !== retiredInput;
      state.values[fixture.field] = 40000; state.sourceStatus = 'disconnected';
      await layoutTest.settle(); record('freshInstance');
      layoutTest.numericDraftState.values[fixture.field] = 12500;
      await layoutTest.settle(); record('freshInstanceLive');
      return { states, commands, invalidDispatchCount, replacedInput };
    `);
    for (const [name, value, disabled = false, invalid = false] of [
      ['initial', '12000'], ['live', '13000'], ['dirty', '15000'],
      ['invalid', '15050', false, true], ['invalidAfterTelemetry', '15050', false, true],
      ['unavailablePending', '', true], ['availablePending', '', true], ['available', '14500'],
      ['rejected', '15000', false, true], ['rejectedAfterTelemetry', '15000', false, true],
      ['acceptedPending', '15000', true], ['pendingReadback', '15000', true], ['confirmed', '15000'],
      ['disconnected', '', true], ['reconnected', '16000'], ['stale', '', true], ['fresh', '16500'],
      ['contextChanged', '17500'], ['freshInstance', '12000'], ['freshInstanceLive', '12500'],
    ]) {
      const actual = result.states[name];
      assert.deepEqual({ value: actual.value, disabled: actual.disabled, invalid: actual.invalid },
        { value, disabled, invalid: String(invalid) }, fixture.panel + ': ' + name);
      assert.equal(Boolean(actual.error), invalid, fixture.panel + ': inline error at ' + name);
    }
    assert.equal(result.invalidDispatchCount, 0, fixture.panel + ': invalid target never dispatches');
    assert.deepEqual(result.commands, [false, true].map(accepted => ({
      route: fixture.route, id: 'flightGuidance.altitude.set', groupId: 'flightGuidance.altitude', value: 15000, accepted,
    })), fixture.panel + ': form uses the exact target, command/action route and pending group');
    assert.equal(result.replacedInput, true, fixture.panel + ': fresh instance replaces the previous input');
  }
  console.log('PASS Mounted numeric drafts: four production panels, real input/form events, telemetry, rejection/pending, field loss, source/context reset and instance isolation.');
}

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
  // Media queries, focus restoration and the CDU's timer/ResizeObserver can
  // settle after a fixed wait on a loaded machine. Re-measure until the page
  // reaches the expected state, retaining the last measurement on timeout.
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
    async function checkAircraftDiscovery() {
      async function click(selector) {
        const point = await evaluate(`const element=document.querySelector(${JSON.stringify(selector)});
          element.scrollIntoView({block:'nearest',behavior:'instant'});const r=element.getBoundingClientRect();
          return {x:r.left+r.width/2,y:r.top+r.height/2};`);
        assert(await evaluate(`return document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${point.x},${point.y}));`), `native discovery hit target: ${selector}`);
        if (await evaluate('return innerWidth < 760;')) {
          for (const type of ['touchStart','touchEnd']) await Promise.all([
            win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchStart' ? [point] : [] }),
            win.webContents.capturePage(),
          ]);
        } else {
          for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({ type, x:Math.round(point.x), y:Math.round(point.y), button:'left', clickCount:1 });
        }
        await wait(70);
      }
      async function query(value) {
        await evaluate(`const input=document.getElementById('aircraft-find-input');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));await layoutTest.settle();`);
      }
      async function key(keyCode) {
        win.webContents.sendInputEvent({ type:'keyDown', keyCode });
        // Native Enter includes a character event. Keydown alone exercises our
        // query handler but does not activate a focused HTML button in Electron.
        if (keyCode === 'Enter') win.webContents.sendInputEvent({ type:'char', keyCode:'\r' });
        win.webContents.sendInputEvent({ type:'keyUp', keyCode });
        await wait(70);
      }
      const resultSelector = id => `[data-aircraft-search-result="${id}"] button`;
      await evaluate(`if(!document.getElementById('vue-main-root')) { const main=document.createElement('main');main.id='vue-main-root';main.style.cssText='height:calc(100vh - 32px);overflow:auto;position:relative';const app=document.getElementById('app');app.parentNode.insertBefore(main,app);main.appendChild(app); }`);
      for (const id of ['pmdg-737','pmdg-777','fenix-a320','fbw-a32nx','inibuilds-a350-900']) {
        for (const width of [1440,390,320]) {
          win.setContentSize(width,900);
          await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled:width<760,maxTouchPoints:5 });
          await evaluate(`await layoutTest.scenario(${JSON.stringify(id)});await layoutTest.remount();document.getElementById('vue-main-root').scrollTop=0;`);
          const before = await evaluate('return layoutTest.sent.length;');
          await click('[aria-label="Find controls"]');
          assert.equal(await evaluate("return document.querySelector('[data-aircraft-workspace]').dataset.aircraftWorkspace;"),'presets','catalogue discovery preserves the view');
          assert.equal(await evaluate("return document.activeElement.id;"),'aircraft-find-input','opening focuses the query');
          assert.equal(await evaluate("return document.querySelectorAll('[data-aircraft-search-result]').length;"),0,'empty query does not duplicate the catalogue');
          assert.equal(await evaluate("return document.querySelector('[data-aircraft-search-mode]').textContent;"),'Find cockpit values','empty search offers the secondary cockpit destination');
          const heading = await evaluate("return layoutTest.controls.getAircraftCommand('flightGuidance.heading.set');");
          assert(heading, `${id}: fixture advertises heading`);
          await query('HDG');
          assert(await evaluate(`return !!document.querySelector(${JSON.stringify(resultSelector(heading.id))});`),'abbreviation finds heading');
          await query(heading.speech.patterns[0]);
          assert(await evaluate(`return !!document.querySelector(${JSON.stringify(resultSelector(heading.id))});`),'declared voice wording finds heading');
          await query(heading.label);
          await evaluate("document.getElementById('aircraft-find-input').focus();");
          await key('Enter');
          assert.equal(await evaluate('return layoutTest.sent.length;'),before,'Enter in search cannot execute');
          await click(resultSelector(heading.id));
          assert.deepEqual(await evaluate("return {tag:document.activeElement.tagName,id:document.activeElement.closest('[data-command-editor]')?.dataset.commandEditor};"),{tag:'H3',id:heading.id},'library focuses the exact editor heading');
          assert.equal(await evaluate(`return document.querySelector('[data-command-editor="${heading.id}"] input').value;`),'','navigation never prefills a target');
          await key('Enter');
          assert.equal(await evaluate('return layoutTest.sent.length;'),before,'Enter on the heading cannot execute');
          const shortcut = await evaluate("const event=new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true});document.dispatchEvent(event);return {prevented:event.defaultPrevented,focus:document.activeElement.tagName};");
          assert.deepEqual(shortcut,{prevented:false,focus:'H3'},'page shortcut yields to the open library');
          await click('[aria-label="Close aircraft controls"]');
          assert.equal(await evaluate("return document.activeElement.closest('[data-aircraft-search-result]')?.dataset.aircraftSearchResult;"),heading.id,'close returns to the result');
          assert.equal(await evaluate("return document.getElementById('aircraft-find-input').value;"),heading.label,'library preserves search');
          if (id === 'pmdg-737' && width === 1440) {
            const types = await evaluate("return ['boolean','enum','none'].map(kind=>Object.values(layoutTest.controls.aircraftCommandCatalogue.commands).find(c=>c.kind!=='preset'&&c.input.kind===kind));");
            for (const command of types) {
              assert(command,'a realistic catalogue covers every editor input kind');
              await query(command.label); await click(resultSelector(command.id));
              assert.equal(await evaluate("return document.activeElement.closest('[data-command-editor]')?.dataset.commandEditor;"),command.id,'every input kind has exact navigation');
              await click('[aria-label="Close aircraft controls"]');
            }
          }
          await query('lights');
          const geometry = await evaluate(`const panel=document.querySelector('.aircraft-find__panel').getBoundingClientRect(), tools=document.querySelector('[data-aircraft-voice-control-trigger]').getBoundingClientRect(), main=document.getElementById('vue-main-root');return {fits:panel.left>=0&&panel.right<=innerWidth+1,below:panel.top>=tools.bottom,overflow:main.scrollWidth>main.clientWidth+1};`);
          assert.deepEqual(geometry,{fits:true,below:true,overflow:false},`${id}/${width}: search sits below the toolbar within the page`);
          await win.webContents.capturePage();
          fs.writeFileSync(path.join(OUTPUT,`discovery-${id}-${width}.png`),(await win.webContents.capturePage()).toPNG());
          const presets = await evaluate("return Object.values(layoutTest.controls.aircraftCommandCatalogue.commands).filter(c=>c.kind==='preset').map(c=>({id:c.id,label:c.label}));");
          for (const preset of presets) {
            await query(preset.label); await click(resultSelector(preset.id));
            assert.equal(await evaluate("return document.activeElement.dataset.aircraftPreset;"),preset.id,'preset destination is its existing card/row');
            assert.equal(await evaluate("return document.querySelector('[data-aircraft-workspace]').dataset.aircraftWorkspace;"),'presets');
            await click('[aria-label="Find controls"]');
          }
          await query('there is no such aircraft control');
          assert(await evaluate("return document.getElementById('aircraft-find-status').textContent.includes('No matching commands for this aircraft');"),'empty results are aircraft-scoped');
          await query('heading');
          await click('[data-aircraft-search-mode="page"]');
          assert.equal(await evaluate("return document.activeElement.id;"),'aircraft-find-input','cockpit link restores query focus');
          assert.equal(await evaluate("return document.querySelector('[data-aircraft-search-mode]').textContent;"),'Back to controls and presets','cockpit search offers a clear return destination');
          assert.equal(await evaluate("return document.querySelector('[data-aircraft-workspace]').dataset.aircraftWorkspace;"),'controls','page mode reveals cockpit');
          assert(await evaluate("return !!document.querySelector('[data-aircraft-find-current]')?.getClientRects().length;"),'existing page matching still reveals cockpit content');
          await click('[data-aircraft-search-mode="commands"]');
          assert.equal(await evaluate("return document.activeElement.id;"),'aircraft-find-input','return link restores query focus');
          assert.equal(await evaluate("return document.getElementById('aircraft-find-input').value;"),'heading','modes retain the query');
          assert.equal(await evaluate("return document.querySelectorAll('[data-aircraft-find-match]').length;"),0,'catalogue mode clears page markers');
          await evaluate("layoutTest.controls.setAvailability({enabled:false,reason:'Pair this device to enable aircraft controls.'});await layoutTest.settle();");
          assert(await evaluate("return document.querySelector('.aircraft-find__reason').textContent.includes('Pair this device');"),'existing permission reason is visible');
          await click(resultSelector(heading.id));
          assert.equal(await evaluate(`return document.querySelector('[data-command-editor="${heading.id}"] button[type=submit]').disabled;`),true,'read-only users may inspect but cannot execute');
          await key('Escape');
          await evaluate("layoutTest.controls.setAvailability({enabled:true});await layoutTest.settle();");
          assert.equal(await evaluate('return layoutTest.sent.length;'),before,'all discovery journeys send zero aircraft commands');
        }
      }
      // Same-profile removal retires a selected command and restores query focus.
      await evaluate("await layoutTest.scenario('pmdg-737');await layoutTest.remount();");
      await click('[aria-label="Find controls"]'); await query('heading');
      await evaluate(`document.querySelector('${resultSelector('flightGuidance.heading.set')}').focus();
        const catalogue=layoutTest.controls.aircraftCommandCatalogue;
        layoutTest.controls.applyControlCapabilities({aircraftCommands:{...catalogue,commands:Object.values(catalogue.commands).filter(c=>c.id!=='flightGuidance.heading.set')}});await layoutTest.settle();`);
      assert.equal(await evaluate("return document.activeElement.id;"),'aircraft-find-input','a removed focused result returns to the query');
      await evaluate("await layoutTest.scenario('pmdg-737');await layoutTest.remount();");
      await click('[aria-label="Find controls"]'); await query('heading');
      await click(resultSelector('flightGuidance.heading.set'));
      await evaluate(`const catalogue=layoutTest.controls.aircraftCommandCatalogue;
        layoutTest.controls.applyControlCapabilities({aircraftCommands:{...catalogue,commands:Object.values(catalogue.commands)}});await layoutTest.settle();
        if(!document.activeElement.closest('[data-command-editor]'))throw new Error('A benign catalogue refresh stole editor focus');
        layoutTest.controls.applyControlCapabilities({aircraftCommands:{...catalogue,commands:Object.values(catalogue.commands).filter(c=>c.id!=='flightGuidance.heading.set')}});await layoutTest.settle();`);
      assert.equal(await evaluate("return !!document.querySelector('[data-aircraft-controls-modal]');"),false,'removed selection closes its editor');
      assert.equal(await evaluate("return document.activeElement.id;"),'aircraft-find-input','removed result returns to the query');
      // After arrival the library is ordinary browsing: retiring the original
      // search result must not dismiss a different, still-supported editor.
      await evaluate("await layoutTest.scenario('pmdg-737');await layoutTest.remount();");
      await click('[aria-label="Find controls"]'); await query('heading');
      await click(resultSelector('flightGuidance.heading.set'));
      await click('[data-command-editor="flightGuidance.altitude.set"] input');
      const continuedEditing = await evaluate(`const input=document.activeElement;input.value='15000';input.dispatchEvent(new Event('input',{bubbles:true}));
        const catalogue=layoutTest.controls.aircraftCommandCatalogue;
        layoutTest.controls.applyControlCapabilities({aircraftCommands:{...catalogue,commands:Object.values(catalogue.commands).filter(c=>c.id!=='flightGuidance.heading.set')}});await layoutTest.settle();
        return {open:!!document.querySelector('[data-aircraft-controls-modal]'),editor:document.activeElement.closest('[data-command-editor]')?.dataset.commandEditor||'',value:document.querySelector('[data-command-editor="flightGuidance.altitude.set"] input')?.value||''};`);
      assert.deepEqual(continuedEditing,{open:true,editor:'flightGuidance.altitude.set',value:'15000'},'removing the original search result preserves a different editor and its draft');
      await evaluate("await layoutTest.scenario('pmdg-737');await layoutTest.remount();");
      await click('[aria-label="Find controls"]'); await query('heading');
      await evaluate(`document.querySelector('${resultSelector('flightGuidance.heading.set')}').click();await layoutTest.scenario('pmdg-777');`);
      assert.equal(await evaluate("return !!document.querySelector('[data-aircraft-controls-modal]');"),false,'aircraft replacement cancels a deferred reveal');
      assert.equal(await evaluate("return document.getElementById('aircraft-find-input').value;"),'','aircraft change clears old search');
      await click('[aria-label="Find controls"]'); await query('lights');
      await evaluate("document.querySelector('[data-aircraft-search-result] button').focus();");
      await key('Escape');
      const escapeResult = await evaluate("return {query:document.getElementById('aircraft-find-input').value,focus:document.activeElement.id};");
      await query('there is no such aircraft control');
      await click('[data-aircraft-search-mode="page"]');
      const fallbackFocus = await evaluate("return document.activeElement.id;");
      assert.deepEqual({escapeResult,fallbackFocus},{escapeResult:{query:'',focus:'aircraft-find-input'},fallbackFocus:'aircraft-find-input'},'Escape and fallback preserve usable search focus');
      await query('heading');
      const pageIndex = await evaluate("return document.getElementById('aircraft-find-status').textContent;");
      await key('Enter');
      assert.notEqual(await evaluate("return document.getElementById('aircraft-find-status').textContent;"),pageIndex,'Enter cycles page matches after fallback');
      await evaluate("document.querySelector('[data-aircraft-search-mode=\"commands\"]').focus();");
      await key('Enter');
      assert.equal(await evaluate("return document.activeElement.id;"),'aircraft-find-input','keyboard activation of the return link restores query focus');
      assert.equal(await evaluate("return document.getElementById('aircraft-find-input').value;"),'heading','keyboard return retains the query');
      await query('lights');
      await evaluate("document.getElementById('aircraft-find-input').focus();");
      await key('Escape');
      assert.equal(await evaluate("return document.getElementById('aircraft-find-input').value;"),'','first Escape clears');
      await key('Escape');
      assert.equal(await evaluate("return document.activeElement.getAttribute('aria-label');"),'Find controls','second Escape closes and restores launcher');
      assert.deepEqual(errors,[],'discovery has no browser errors');
      console.log('PASS Aircraft discovery: five families at desktop/390px/320px, all preset destinations, editor kinds, native mouse/touch/keyboard, page search, permission reasons, stale catalogue/aircraft handoffs and zero navigation dispatch.');
    }
    if (process.env.FF_AIRCRAFT_DISCOVERY_ONLY === '1') {
      await checkAircraftDiscovery();
      win.destroy();app.exit(0);return;
    }
    async function checkThrottleStyles() {
      for (const [family, count, climb] of [['fenix', 2, 3], ['fbw', 2, 25], ['fbw', 4, 25]]) {
        await evaluate(`localStorage.removeItem('ff-throttle-style'); await layoutTest.mountThrottlePanel('${family}', ${count});`);
        // A trusted, harmless header click enables the browser's haptic API.
        for (const type of ['mousePressed', 'mouseReleased']) {
          await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: 40, y: 40, button: 'left', clickCount: 1 });
        }
        assert.equal(await evaluate(`return document.querySelector('.airbus-throttle').dataset.throttleStyle;`), 'clean');
        for (const style of ['clean', 'cockpit', 'compact']) {
          for (const width of [1440, 390, 320]) {
            win.setContentSize(width, 1000);
            const layout = await settled(`
              const select = document.querySelector('[aria-label="Throttle style"]');
              select.value = '${style}'; select.dispatchEvent(new Event('change', { bubbles: true }));
              await layoutTest.settle();
              const buttons = [...document.querySelectorAll('.airbus-throttle-detent')];
              const idle = buttons.find(button => button.dataset.aircraftAction === 'propulsion.throttle.idle').getBoundingClientRect();
              return {
                overflow: document.documentElement.scrollWidth > innerWidth,
                minHeight: Math.min(...buttons.map(button => button.getBoundingClientRect().height)),
                text: buttons.map(button => button.textContent.trim()),
                current: buttons.filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.dataset.aircraftAction),
                commands: layoutTest.throttleState.commands.length,
                knobOffsets: '${style}' === 'compact' ? [] : [...document.querySelectorAll('.airbus-throttle-knob')].map(knob => {
                  const rect = knob.getBoundingClientRect();
                  return Math.abs(rect.y + rect.height / 2 - idle.y - idle.height / 2);
                }),
              };`, value => !value.overflow && value.minHeight >= 44);
            assert.equal(layout.overflow, false, `${family}/${count}/${style}/${width}: no horizontal overflow`);
            assert.ok(layout.minHeight >= 44, `${style}: useful touch targets`);
            assert.equal(layout.text.length, 4);
            assert.ok(layout.text.every(text => !/Set|Live|Sending|Requested/.test(text)), 'state motifs do not repeat confusing labels');
            assert.deepEqual(layout.current, ['propulsion.throttle.idle']);
            assert.equal(layout.commands, 0, 'appearance selection must not command a throttle');
            assert.ok(layout.knobOffsets.every(offset => offset <= 1), `${family}/${count}/${style}/${width}: levers stay aligned with the IDLE gate`);
            await win.webContents.capturePage();
            fs.writeFileSync(path.join(OUTPUT, `throttle-${family}-${count}-${style}-${width}.png`), (await win.webContents.capturePage()).toPNG());
          }
        }
        const journey = await evaluate(`
          const state = layoutTest.throttleState;
          const button = id => document.querySelector('[data-aircraft-action="propulsion.throttle.' + id + '"]');
          const select = document.querySelector('[aria-label="Throttle style"]');
          const selectStyle = async value => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); await layoutTest.settle(); };
          const snapshot = () => ({ current: [...document.querySelectorAll('.airbus-throttle-detent[aria-pressed="true"]')].map(el => el.dataset.aircraftAction),
            target: [...document.querySelectorAll('.airbus-throttle-detent.is-target')].map(el => el.dataset.aircraftAction),
            disabled: [...document.querySelectorAll('.airbus-throttle-detent')].every(el => el.disabled) });
          button('climb').click(); await layoutTest.settle();
          const pending = snapshot();
          select.focus(); await selectStyle('clean');
          const changedWhilePending = snapshot(), focusRetained = document.activeElement === select;
          state.positions = Array(${count}).fill(${climb}); state.pending = false; await layoutTest.settle();
          const confirmed = snapshot();
          state.sourceStatus = 'stale'; await layoutTest.settle();
          const stale = snapshot(), staleLabel = document.querySelector('.airbus-throttle-position-label').textContent;
          state.sourceStatus = 'connected'; state.positions[0] = null; await layoutTest.settle();
          const missing = snapshot();
          state.positions[0] = ${family === 'fenix' ? 2 : 0}; await layoutTest.settle();
          const split = snapshot();
          state.enabled = false; await layoutTest.settle(); const disabled = snapshot();
          state.enabled = true; state.accepted = false; await layoutTest.settle();
          button('idle').click(); await layoutTest.settle(); const rejected = snapshot();
          state.capabilities['propulsion.throttle.toga'] = false; await layoutTest.settle();
          const unsupported = button('toga').disabled;
          await selectStyle('cockpit'); const before = state.commands.length;
          await layoutTest.mountThrottlePanel('${family}', ${count});
          return { pending, changedWhilePending, focusRetained, confirmed, stale, staleLabel, missing, split, disabled, rejected, unsupported,
            commandCount: before, restored: document.querySelector('.airbus-throttle').dataset.throttleStyle };
        `);
        assert.deepEqual(journey.pending.current, ['propulsion.throttle.idle'], 'a request cannot move the observed position');
        assert.deepEqual(journey.pending.target, ['propulsion.throttle.climb']);
        assert.equal(journey.pending.disabled, true);
        assert.deepEqual(journey.changedWhilePending, journey.pending, 'changing appearance retains pending and observed state');
        assert.equal(journey.focusRetained, true);
        assert.deepEqual(journey.confirmed.current, ['propulsion.throttle.climb']);
        assert.deepEqual(journey.confirmed.target, []);
        for (const state of [journey.stale, journey.missing, journey.disabled]) assert.equal(state.disabled, true);
        assert.deepEqual(journey.stale.current, [], 'stale data is not marked as the current lever position');
        assert.equal(journey.staleLabel, 'Last known position');
        assert.deepEqual(journey.missing.current, []);
        assert.deepEqual(journey.split.current, []);
        assert.deepEqual(journey.rejected.target, []);
        assert.equal(journey.unsupported, true);
        assert.equal(journey.commandCount, 2, 'only deliberate detent actions dispatch');
        assert.equal(journey.restored, 'cockpit', 'style survives a component remount');
        const reverse = await evaluate(`
          layoutTest.throttleState.positions[1] = ${family === 'fenix' ? 1 : -6}; await layoutTest.settle();
          return {
            readout: document.querySelectorAll('.airbus-throttle-readout')[1].textContent,
            knobs: document.querySelectorAll('.airbus-throttle-knob').length,
            current: document.querySelectorAll('.airbus-throttle-detent[aria-pressed="true"]').length,
            commands: layoutTest.throttleState.commands.length,
          };
        `);
        assert.match(reverse.readout, /REV IDLE/, 'reverse lever position remains available in its readout');
        assert.equal(reverse.knobs, count - 1, 'a reverse lever must not be drawn at a forward detent');
        assert.equal(reverse.current, 0, 'mixed idle/reverse readback must not highlight a common forward detent');
        assert.equal(reverse.commands, 0, 'receiving reverse readback must not dispatch a throttle command');
        await win.webContents.capturePage();
        fs.writeFileSync(path.join(OUTPUT, `throttle-${family}-${count}-reverse-320.png`), (await win.webContents.capturePage()).toPNG());
      }
      await evaluate(`localStorage.setItem('ff-throttle-style', 'removed-style'); await layoutTest.mountThrottlePanel();`);
      assert.equal(await evaluate(`return document.querySelector('.airbus-throttle').dataset.throttleStyle;`), 'clean');
      await evaluate(`document.querySelector('[aria-label="Throttle style"]').focus();`);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
      assert.equal(await settled(`return document.querySelector('.airbus-throttle').dataset.throttleStyle;`, value => value === 'cockpit'), 'cockpit', 'native keyboard selection changes style');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await evaluate(`document.querySelector('[data-aircraft-action="propulsion.throttle.climb"]').focus();`);
      assert.equal(await evaluate(`return document.activeElement?.dataset.aircraftAction;`), 'propulsion.throttle.climb');
      for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
        ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}),
      });
      assert.deepEqual(await settled(`return [...layoutTest.throttleState.commands];`, commands => commands.length === 1), ['propulsion.throttle.climb'], 'native keyboard activation dispatches once');
      await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUTPUT, 'throttle-pending-320.png'), (await win.webContents.capturePage()).toPNG());
      const knob = await evaluate(`
        layoutTest.throttleState.positions = [3, 3]; layoutTest.throttleState.pending = false; await layoutTest.settle();
        const rect = document.querySelector('.airbus-throttle-knob').getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      `);
      for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type, ...knob, button: 'left', clickCount: 1,
      });
      assert.deepEqual(await settled(`return [...layoutTest.throttleState.commands];`, commands => commands.length === 2), ['propulsion.throttle.climb', 'propulsion.throttle.climb'], 'lever artwork passes native taps to its detent');
      await evaluate(`layoutTest.throttleState.pending = false; layoutTest.throttleState.sourceStatus = 'stale'; await layoutTest.settle();`);
      await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUTPUT, 'throttle-stale-320.png'), (await win.webContents.capturePage()).toPNG());
      const unavailableStorage = await evaluate(`
        const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
        try {
          Storage.prototype.getItem = () => { throw new Error('blocked'); };
          Storage.prototype.setItem = () => { throw new Error('blocked'); };
          await layoutTest.mountThrottlePanel();
          const select = document.querySelector('[aria-label="Throttle style"]');
          select.value = 'compact'; select.dispatchEvent(new Event('change', { bubbles: true })); await layoutTest.settle();
          return document.querySelector('.airbus-throttle').dataset.throttleStyle;
        } finally { Storage.prototype.getItem = get; Storage.prototype.setItem = set; }
      `);
      assert.equal(unavailableStorage, 'compact', 'style remains usable when local storage is blocked');
      await evaluate(`localStorage.removeItem('ff-throttle-style'); await layoutTest.remount();`);
      for (const id of ['fenix-a320', 'fbw-a380x']) {
        await evaluate(`await layoutTest.cockpitScenario('${id}');
          layoutTest.setAircraftValues(${JSON.stringify(Object.fromEntries(Array.from({ length: id === 'fenix-a320' ? 2 : 4 }, (_, i) => [
            `propulsion.throttleLever${i + 1}${id === 'fenix-a320' ? 'Position' : 'Angle'}`, id === 'fenix-a320' ? 2 : 0,
          ])))}); await layoutTest.settle();`);
        for (const width of [1440, 390, 320]) {
          win.setContentSize(width, 1000);
          await settled(`document.querySelector('.airbus-throttle').scrollIntoView({ behavior: 'instant', block: 'center' });
            await layoutTest.settle();
            const rect = document.querySelector('.airbus-throttle').getBoundingClientRect();
            return rect.left >= 0 && rect.right <= innerWidth;`, value => value);
          assert.equal(await evaluate(`return document.documentElement.scrollWidth <= innerWidth;`), true, `${id}/${width}: integrated throttle stays within the page`);
          await win.webContents.capturePage();
          fs.writeFileSync(path.join(OUTPUT, `throttle-page-${id}-${width}.png`), (await win.webContents.capturePage()).toPNG());
        }
      }
      console.log('PASS Throttle: three styles at desktop/390px/320px, two/four levers, saved style, native keyboard, pending/readback separation, stale/missing/split states and command guards.');
    }
    async function checkPresetFirstViews(allFamilies = true) {
      async function capture(name) {
        await win.webContents.capturePage(); await wait(100);
        fs.writeFileSync(path.join(OUTPUT,name),(await win.webContents.capturePage()).toPNG());
      }
      async function click(selector) {
        const point = await evaluate(`const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'nearest',behavior:'instant'});let r=element.getBoundingClientRect();if(!element.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))){element.scrollIntoView({block:'center',behavior:'instant'});r=element.getBoundingClientRect();}return {x:r.left+r.width/2,y:r.top+r.height/2};`);
        assert(await evaluate(`return document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${point.x},${point.y}));`), 'native pointer reaches ' + selector);
        for (const type of ['mousePressed','mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
        await wait(80);
      }
      const state = () => evaluate(`const controls=document.getElementById('aircraft-cockpit-view'),presets=document.getElementById('aircraft-presets-view');return {
        view:document.querySelector('[data-aircraft-workspace]').dataset.aircraftWorkspace,
        cockpitVisible:!!controls.getClientRects().length,presetsVisible:!!presets.getClientRects().length,
        inertControls:controls.inert,inertPresets:presets.inert,
        presetSections:document.querySelectorAll('[data-aircraft-presets-section]').length,
        overflow:document.documentElement.scrollWidth>innerWidth,
        selected:document.querySelector('[role=tab][aria-selected=true]')?.dataset.aircraftView};`);
      // Use the same independently scrolling main region as the real app.
      await evaluate(`const main=document.createElement('main');main.id='vue-main-root';main.style.cssText='height:calc(100vh - 32px);overflow:auto;position:relative';const app=document.getElementById('app');app.parentNode.insertBefore(main,app);main.appendChild(app);await layoutTest.remount();`);
      for (const id of allFamilies ? ['pmdg-737','pmdg-777','fenix-a320','fbw-a32nx','inibuilds-a350-900'] : ['pmdg-737']) {
        for (const width of [1440,390,320]) {
          win.setContentSize(width,900);
          await evaluate(`await layoutTest.scenario(${JSON.stringify(id)});await layoutTest.remount();document.getElementById('vue-main-root').scrollTop=0;`);
          await ready(`[data-aircraft-template="${templateFor(id)}"]`);
          await wait(150);
          assert.deepEqual(await state(),{view:'presets',cockpitVisible:false,presetsVisible:true,inertControls:true,inertPresets:false,presetSections:1,overflow:false,selected:'presets'}, id+'/'+width+': first arrival is preset-first');
          const before = await evaluate('return layoutTest.sent.length;');
          const memory = await evaluate("return JSON.stringify({...sessionStorage});");
          await evaluate('document.getElementById("vue-main-root").scrollTop=250;'); await wait(100);
          assert.equal(await evaluate("return JSON.stringify({...sessionStorage});"),memory,'scrolling presets never overwrites cockpit section memory');
          await evaluate('document.getElementById("vue-main-root").scrollTop=0;');
          await capture(`preset-first-${id}-${width}.png`);
          await click('[data-aircraft-view="controls"]');
          assert.equal((await state()).cockpitVisible,true,'explicit view opens existing cockpit controls');
          assert.equal((await state()).presetsVisible,false,'presets have one primary location');
          const overflow = await evaluate(`const main=document.getElementById('vue-main-root');return {width:main.clientWidth,scrollWidth:main.scrollWidth,wide:[...main.querySelectorAll('*')].filter(element=>element.getBoundingClientRect().right>main.getBoundingClientRect().right+1 && getComputedStyle(element).overflowX==='visible').slice(0,8).map(element=>({tag:element.tagName,id:element.id,class:element.className,width:element.getBoundingClientRect().width}))};`);
          assert(overflow.scrollWidth <= overflow.width + 1,id+'/'+width+': cockpit fits the scrolling main region: '+JSON.stringify(overflow));
          assert.equal(await evaluate("return [...document.querySelectorAll('.aircraft-desktop-section-choices button')].some(b=>b.textContent.trim()==='Presets');"),false,'cockpit navigation lists its own systems');
          await capture(`cockpit-view-${id}-${width}.png`);
          if (id === 'pmdg-737' && width === 1440) {
            await evaluate(`const input=document.querySelector('input[aria-label="Set HEADING"]');window.savedCockpitInput=input;input.value='275';input.dispatchEvent(new Event('input',{bubbles:true}));await layoutTest.settle();`);
            await click('[data-aircraft-view="presets"]'); await click('[data-aircraft-view="controls"]');
            assert(await evaluate("return savedCockpitInput===document.querySelector('input[aria-label=\"Set HEADING\"]') && savedCockpitInput.value==='275';"),'view changes retain cockpit input identity and draft');
          }
          await click('[data-aircraft-view="presets"]');
          await click('[aria-label="Find controls"]');
          assert.equal((await state()).view,'presets','catalogue discovery leaves the current view unchanged');
          await click('[data-aircraft-search-mode="page"]');
          assert.equal((await state()).view,'controls','Find controls reveals the cockpit surface');
          await evaluate(`const input=document.getElementById('aircraft-find-input');input.value='altitude';input.dispatchEvent(new Event('input',{bubbles:true}));await layoutTest.settle();`);
          assert(await evaluate("return !!document.querySelector('[data-aircraft-find-current]')?.getClientRects().length;"),'search selects a visible cockpit result');
          await click('[data-aircraft-view="presets"]');
          assert(await evaluate("return document.getElementById('aircraft-find-input').value==='' && !document.querySelector('[data-aircraft-find-current]') && document.querySelector('[aria-label=\"Find controls\"]').getAttribute('aria-expanded')==='false';"),'returning to presets closes search and clears its hidden result');
          await evaluate("document.getElementById('aircraft-presets-tab').focus();");
          win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});await wait(80);
          assert.equal((await state()).view,'controls','arrow key selects the next view');
          assert.equal(await evaluate('return document.activeElement.id;'),'aircraft-cockpit-tab','arrow key keeps focus on the selected tab');
          assert.equal(await evaluate(`return layoutTest.sent.slice(${before}).filter(message=>!String(message.type).startsWith('request')).length;`),0,'navigation and search send no aircraft commands');
        }
      }
      assert(await evaluate("const panel=document.getElementById('aircraft-cockpit-view');const control=[...panel.querySelectorAll('input:not(:disabled),button:not(:disabled)')].find(element=>element.getClientRects().length);control?.focus();return !!control && document.activeElement===control;"),'the old cockpit owns actual native focus before changing aircraft');
      await evaluate("await layoutTest.scenario('pmdg-777');await layoutTest.settle();");
      await ready('[data-aircraft-template="pmdg-777"]');
      assert.equal((await state()).view,'presets','changing aircraft returns to presets without remounting the page');
      assert.equal(await evaluate('return document.activeElement.id;'),'aircraft-presets-tab','aircraft changes restore focus when the old cockpit control disappears');
      // A quick view change can cancel the first section restoration before its
      // timer fires. Reopening controls must still restore the remembered system.
      await evaluate(`await layoutTest.scenario('pmdg-737');await layoutTest.remount();
        const {aircraftSectionStorageKey}=await import('/frontend/src/vue/components/aircraft-specific/aircraft-section-memory.js');
        sessionStorage.setItem(aircraftSectionStorageKey(layoutTest.specific.activeProfileKey),'radios');
        document.querySelector('[data-aircraft-view="controls"]').click();await layoutTest.settle();
        document.querySelector('[data-aircraft-view="presets"]').click();await layoutTest.settle();`);
      await click('[data-aircraft-view="controls"]');
      assert.equal(await settled("return document.querySelector('.aircraft-desktop-section-choices [aria-current=\"location\"]')?.textContent.trim();", label => label === 'NAV'),'NAV','cancelled section restoration remains retryable when reopening controls');
      assert.deepEqual(errors,[],'preset-first views have no browser errors');
      console.log(`Preset-first Aircraft passed: ${allFamilies ? 'five aircraft families' : 'PMDG 737'} at desktop/390px/320px; view selection, hidden controls, one preset section, untouched section memory, retained drafts, visible search, keyboard navigation, aircraft-change focus and no navigation dispatch.`);
    }
    if (process.env.FF_AIRCRAFT_PRESETS_ONLY === '1') {
      await checkPresetFirstViews();
      win.destroy();app.exit(0);return;
    }
    await evaluate("document.querySelector('[data-aircraft-view=controls]').click();await layoutTest.settle();");
    if (process.env.FF_THROTTLE_STYLES_ONLY === '1') {
      await checkThrottleStyles();
      assert.deepEqual(errors, [], 'Throttle styles have no browser errors');
      win.destroy(); app.exit(0); return;
    }
    if (process.env.FF_NUMERIC_DRAFTS_ONLY === '1') {
      await checkMountedNumericDrafts({ evaluate });
      assert.deepEqual(errors, [], 'Mounted numeric drafts have no browser errors');
      win.destroy(); app.exit(0); return;
    }
    if (process.env.FF_AIRCRAFT_SECTIONS_ONLY === '1') {
      await require('./aircraft-section-browser-checks')({ win, evaluate, settled, wait, output: OUTPUT });
      assert.deepEqual(errors, [], 'Aircraft section navigation has no browser errors');
      win.destroy(); app.exit(0); return;
    }
    if (process.env.FF_A32X_LAYOUT_ONLY === '1') {
      for (const id of INCLUDED_A32X) {
        await evaluate(`await layoutTest.cockpitScenario(${JSON.stringify(id)});`);
        await ready('[data-aircraft-template="microsoft-inibuilds-a32x"]');
        for (const width of [1440, 390]) {
          win.setContentSize(width, 1000); await wait(150);
          await evaluate(`document.querySelector('[data-aircraft-template="microsoft-inibuilds-a32x"]').scrollIntoView({ behavior: 'instant' });`);
          const layout = await evaluate(`return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            targets: [...document.querySelectorAll('[data-microsoft-inibuilds-a32x-selector] input')].map(input => ({ value: input.value, disabled: input.disabled, height: input.getBoundingClientRect().height })),
            vs: document.querySelector('[data-microsoft-inibuilds-a32x-selector="vertical-speed"]').textContent,
            fd: document.querySelector('[data-microsoft-inibuilds-a32x-mode="fd"]').textContent,
          };`);
          assert.equal(layout.overflow, false, `${id} ${width}: no horizontal overflow`);
          assert.deepEqual(layout.targets.map(target => target.value), ['151', '278', '11000', '0']);
          assert.ok(layout.targets.every(target => !target.disabled && target.height >= 44));
          assert.match(layout.fd, /FD CAPT/);
          assert.doesNotMatch(layout.vs, /-700/, 'generic VS disagreement cannot overwrite the native FCU display');
          fs.writeFileSync(path.join(OUTPUT, `${id}-${width}.png`), (await win.webContents.capturePage()).toPNG());
        }
      }
      assert.deepEqual(errors, [], 'Included Airbus panels have no browser runtime errors');
      win.destroy(); app.exit(0); return;
    }
    if (process.env.FF_PUSHBACK_E2E === '1') {
      await require('./pushback-e2e-browser')({ win, evaluate, ready, settled, wait, output: OUTPUT });
      assert.deepEqual(errors, [], 'Real-controller pushback journey has no browser errors');
      win.destroy(); app.exit(0); return;
    }
    if (process.env.FF_PUSHBACK_LAYOUT_ONLY === '1') {
      await require('./pushback-browser-checks')({ win, evaluate, ready, settled, wait, output: OUTPUT });
      assert.deepEqual(errors, [], 'Pushback has no browser runtime errors');
      win.destroy(); app.exit(0); return;
    }
    if (!process.env.FF_CDU_LAYOUT_ONLY && !process.env.FF_AIRCRAFT_TOOLS_ONLY
      && !process.env.FF_AUTOTAXI_LAYOUT_ONLY && !process.env.FF_A380_LAYOUT_ONLY) {
      await require('./pmdg-sdk-setup-browser-checks')({ win, evaluate, ready, settled, output: OUTPUT });
      if (process.env.FF_PMDG_SDK_LAYOUT_ONLY === '1') {
        assert.deepEqual(errors, [], 'PMDG setup has no runtime errors');
        win.destroy(); app.exit(0); return;
      }
    }
    if (!AUTOTAXI_FIXTURE && !process.env.FF_CDU_LAYOUT_ONLY && !process.env.FF_AIRCRAFT_TOOLS_ONLY && !process.env.FF_AUTOTAXI_LAYOUT_ONLY) {
      await evaluate(`await layoutTest.cockpitScenario(${JSON.stringify(A380)});`);
      await ready('[data-aircraft-template="inibuilds-a380"]');
      for (const width of [1440, 390, 320]) {
        win.setContentSize(width, 1000); await wait(150);
        await evaluate(`document.querySelector('[data-aircraft-template="inibuilds-a380"]').scrollIntoView({ behavior: 'instant' });`);
        const layout = await evaluate(`return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          groups: document.querySelectorAll('[data-aircraft-template="inibuilds-a380"] [data-aircraft-control-group]').length,
          presets: document.querySelectorAll('[data-aircraft-presets-section]').length,
          duplicateLights: document.querySelectorAll('[data-exterior-light-controls]').length,
          buttons: [...document.querySelectorAll('[data-aircraft-template="inibuilds-a380"] button')].map(button => ({ height: button.getBoundingClientRect().height, disabled: button.disabled, targetSubmit: button.matches('[data-a380-fcu-targets] button[type="submit"]') })),
        };`);
        assert.equal(layout.overflow, false, `A380 ${width}: no horizontal overflow`);
        assert.equal(layout.groups, 27); assert.equal(layout.presets, 1); assert.equal(layout.duplicateLights, 0);
        assert.ok(layout.buttons.every(button => button.height >= 44 && (button.targetSubmit ? button.disabled : !button.disabled)));
        fs.writeFileSync(path.join(OUTPUT, `inibuilds-a380-${width}.png`), (await win.webContents.capturePage()).toPNG());
        await evaluate(`document.querySelector('[data-com-radios]').scrollIntoView({ behavior: 'instant' });`);
        const radioLayout = await evaluate(`return {
          count: document.querySelectorAll('[data-com-radio]').length,
          overflow: document.documentElement.scrollWidth > innerWidth,
          controls: [...document.querySelectorAll('[data-com-radios] button, [data-com-radios] input')].map(item => ({ height: item.getBoundingClientRect().height, disabled: item.disabled })),
        };`);
        assert.equal(radioLayout.count, 2); assert.equal(radioLayout.overflow, false);
        assert.ok(radioLayout.controls.every(item => item.height >= 44 && !item.disabled));
        fs.writeFileSync(path.join(OUTPUT, `inibuilds-a380-radios-${width}.png`), (await win.webContents.capturePage()).toPNG());
        if (width === 1440 || width === 320) {
          await evaluate(`document.querySelector('#a380-air').scrollIntoView({ behavior: 'instant' });`);
          fs.writeFileSync(path.join(OUTPUT, `inibuilds-a380-systems-${width}.png`), (await win.webContents.capturePage()).toPNG());
        }
      }
      for (const [name, value] of [['speed', 250], ['heading', 90], ['altitude', 12300], ['verticalSpeed', -1000]]) {
        await evaluate(`const input = document.querySelector('#a380-${name}-target'); input.value = '${value}'; input.dispatchEvent(new Event('input', { bubbles: true })); await layoutTest.settle();
          document.querySelector('[data-a380-target="${name}"]').requestSubmit(); await layoutTest.settle();`);
        assert.deepEqual(await evaluate('return layoutTest.sent.at(-1);'), { type: 'canonical', commandId: `flightGuidance.${name}.set`, input: { value } });
      }
      await evaluate(`layoutTest.setAircraftValues({ 'flightGuidance.speedValue': 0.82, 'flightGuidance.trackFpa': true }); await layoutTest.settle();`);
      assert.equal(await evaluate(`return ['speed', 'heading', 'verticalSpeed'].every(id => document.querySelector('#a380-' + id + '-target').disabled);`), true, 'Mach/TRK/FPA cannot receive knots/heading/V/S targets');
      await evaluate(`layoutTest.setAircraftValues({ 'flightGuidance.speedValue': 200, 'flightGuidance.trackFpa': false, 'flightGuidance.verticalSpeedDashed': true }); await layoutTest.settle();`);
      assert.equal(await evaluate(`return document.querySelector('#a380-verticalSpeed-target').disabled;`), true, 'hidden V/S is not an active numeric target');
      await evaluate(`document.querySelector('[data-a380-target="verticalSpeed"] button[type="button"]').click(); await layoutTest.settle();`);
      assert.deepEqual(await evaluate('return layoutTest.sent.at(-1);'), { control: 'aircraft-specific', operation: 'execute', actionId: 'flightGuidance.verticalSpeed.reveal' });
      await evaluate(`layoutTest.setAircraftValues({ 'flightGuidance.verticalSpeedDashed': false }); await layoutTest.settle();`);
      await evaluate(`document.querySelector('[aria-label="Nose TAXI"]').click(); await layoutTest.settle();`);
      assert.deepEqual(await evaluate('return layoutTest.sent.at(-1);'), { type: 'canonical', commandId: 'lights.noseMode.set', input: { value: 'taxi' } });
      for (const [label, commandId, value] of [['Flap lever FULL', 'surfaces.flaps.set', 'full'], ['Speedbrake lever HALF', 'surfaces.spoilers.set', 'half'], ['Ground spoilers ARM', 'surfaces.spoilersArmed.set', true]]) {
        await evaluate(`document.querySelector('[aria-label="${label}"]').click(); await layoutTest.settle();`);
        assert.deepEqual(await evaluate('return layoutTest.sent.at(-1);'), { type: 'canonical', commandId, input: { value } });
      }
      await evaluate(`document.querySelector('[aria-label="Flight director OFF"]').click(); await layoutTest.settle();`);
      assert.deepEqual(await evaluate('return layoutTest.sent.at(-1);'), { type: 'canonical', commandId: 'flightGuidance.flightDirector.set', input: { value: false } });
      await evaluate(`document.querySelector('[aria-label="Seat belts AUTO"]').click(); await layoutTest.settle();`);
      assert.deepEqual(await evaluate('return layoutTest.sent.at(-1);'), { type: 'canonical', commandId: 'cabin.seatBelts.set', input: { value: 'auto' } });
      await evaluate(`document.querySelector('[aria-label="Engine 4 bleed ON"]').click(); await layoutTest.settle();`);
      assert.deepEqual(await evaluate('return layoutTest.sent.at(-1);'), { type: 'canonical', commandId: 'systems.engineBleed4.set', input: { value: 'on' } });
      await evaluate(`document.querySelector('[aria-label="APU master ON"]').click(); await layoutTest.settle();`);
      assert.deepEqual(await evaluate('return layoutTest.sent.at(-1);'), { control: 'aircraft-specific', operation: 'execute', actionId: 'systems.apuMaster.on' });
      for (const index of [1, 2]) {
        await evaluate(`const input = document.querySelector('#com-${index}-frequency'); input.value = '118.005'; input.dispatchEvent(new Event('input', { bubbles: true })); await layoutTest.settle();
          document.querySelector('[aria-label="Set COM ${index} standby frequency"]').click(); await layoutTest.settle();`);
        assert.deepEqual(await evaluate('return layoutTest.sent.at(-1);'), { type: 'canonical', commandId: `radios.com${index}.setStandby`, input: { value: 118.005 } });
      }
      await evaluate(`layoutTest.controls.setAvailability({ enabled: false, reason: 'Connection lost' }); await layoutTest.settle();`);
      assert.equal(await evaluate(`return [...document.querySelectorAll('[data-com-radios] button, [data-com-radios] input')].every(item => item.disabled);`), true, 'A380 disconnect disables radio writes');
      assert.equal(await evaluate(`return [...document.querySelectorAll('[data-aircraft-template="inibuilds-a380"] [data-aircraft-control-group] button')].every(button => button.disabled);`), true, 'A380 disconnect disables cockpit writes');
      if (process.env.FF_A380_LAYOUT_ONLY === '1') {
        assert.deepEqual(errors, []); console.log('A380 layout and command dispatch passed at 1440, 390 and 320px.'); app.exit(0); return;
      }
      await evaluate(`await layoutTest.cockpitScenario('pmdg-737');`);
      await ready('[data-aircraft-template="pmdg-737"]');
    }
    if (AUTOTAXI_FIXTURE) {
      assert.equal(LIVE_AUTOTAXI_ENABLED, true, 'the fixture exercises the enabled production setting');
      await evaluate(`await layoutTest.cockpitScenario('generic');
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
      await evaluate(`document.querySelector('[data-taxi-show-route]').click(); await layoutTest.settle();
        window.oldTaxiPreview = layoutTest.taxiReplies.findLast(message => message.preview);
        layoutTest.taxiDisconnect(); layoutTest.taxiReply(window.oldTaxiPreview); await layoutTest.settle();`);
      assert.equal(await evaluate(`return Boolean(document.querySelector('#aircraft-page-autotaxi figure'));`), false, 'disconnect discards cached and late route previews');
      assert.equal(await evaluate(`return document.querySelector('[data-taxi-start]').disabled;`), true, 'a late response cannot restore readiness while disconnected');
      await evaluate(`layoutTest.setTaxiState({ canStart: false, sceneKey: null, aircraft: null });
        layoutTest.taxiReconnect(); await layoutTest.settle();
        layoutTest.taxiReply(window.oldTaxiPreview); await layoutTest.settle();`);
      assert.equal(await evaluate(`return Boolean(document.querySelector('#aircraft-page-autotaxi figure'));`), false, 'reconnect rejects previous connection responses');
      assert.doesNotMatch(await evaluate(`return document.querySelector('#aircraft-page-autotaxi').textContent;`), /Connection lost/, 'fresh status replaces the disconnect notice');
      await evaluate(`await layoutTest.remountCockpit(); layoutTest.taxiReply(window.oldTaxiPreview); await layoutTest.settle();`);
      assert.equal(await evaluate(`return Boolean(document.querySelector('#aircraft-page-autotaxi figure'));`), false, 'a remounted panel rejects previous mount responses for the same profile');
      assert.equal(await evaluate(`return document.querySelector('[data-taxi-start]').disabled;`), true, 'a previous mount cannot restore readiness');
      for (const id of AUTOTAXI_AIRCRAFT) {
        await evaluate(`await layoutTest.cockpitScenario(${JSON.stringify(id)}); layoutTest.taxiReconnect(); await layoutTest.settle();`);
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
          assert.equal(await evaluate(`return [...document.querySelectorAll('#aircraft-page-autotaxi button')].filter(button => button.getClientRects().length).every(button => button.getBoundingClientRect().height >= 48);`), true, `${id} ${width}px: taxi touch targets`);
          const context = await evaluate(`const panel = document.querySelector('#aircraft-page-autotaxi'); return {
            copy: panel.textContent, disabled: panel.querySelector('[data-taxi-start]').disabled,
            support: panel.querySelector('[data-autotaxi-support]').textContent,
          };`);
          assert.match(context.support, /Automatic control is experimental/);
          assert.equal(context.disabled, true, `${id}: Autotaxi retains its readiness gate`);
          assert.match(context.copy, /Pushback & taxi/);
          if (id === 'generic' || id.startsWith('fenix-')) assert.doesNotMatch(context.copy, /PMDG|Tiller \+ Rudder/, `${id}: PMDG setup does not leak`);
          if (id.startsWith('pmdg-')) assert.match(context.copy, /Tiller \+ Rudder/);
          await evaluate(`document.querySelector('[data-taxi-automation]').open = true; const setup = document.querySelector('[data-autotaxi-setup]'); setup.open = true; await layoutTest.settle();`);
          assert.equal(await evaluate(`return document.querySelector('[aria-label="Aircraft taxi setup"]').getBoundingClientRect().height > 0;`), true, `${id}: setup expands in place`);
          await evaluate(`document.querySelector('[data-autotaxi-setup]').open = false; document.querySelector('[data-taxi-automation]').open = false; await layoutTest.settle();`);
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
          layoutTest.setTaxiState({ canGuide: true, canStart: false, unavailableReason: 'Release the parking brake before starting.', reason: 'Ready for manual taxi guidance.' }); await layoutTest.settle();
          panel.querySelector('button').click(); await layoutTest.settle();`);
        assert.equal(await evaluate(`return Boolean(document.querySelector('#aircraft-page-autotaxi figure svg'));`), true, `${id}: preview renders before commands`);
        assert.equal(await evaluate(`return document.querySelector('[data-taxi-start]').disabled;`), true, `${id}: the ribbon works while Autotaxi is unavailable`);
        assert.equal(await evaluate(`return document.querySelector('[data-taxi-automation]').open;`), false, `${id}: optional automation stays collapsed during manual guidance`);
        const manualBefore = await evaluate(`return document.querySelector('#aircraft-page-autotaxi figure svg').textContent;`);
        const controlCount = await evaluate(`return layoutTest.taxiSent.filter(message => ['start', 'stop', 'release'].includes(message.operation)).length;`);
        await evaluate(`layoutTest.moveAircraft({ x: 0.4, z: 60, headingDeg: 0 });`); await wait(800);
        assert.notEqual(await evaluate(`return document.querySelector('#aircraft-page-autotaxi figure svg').textContent;`), manualBefore, `${id}: distance updates during manual taxi`);
        assert.equal(await evaluate(`return layoutTest.taxiSent.filter(message => ['start', 'stop', 'release'].includes(message.operation)).length;`), controlCount, `${id}: guidance never dispatches automatic control`);
        await evaluate(`layoutTest.setTaxiState({ aircraft: null, canGuide: false, guidanceUnavailableReason: 'Waiting for fresh aircraft position.' }); await layoutTest.settle();`);
        assert.match(await evaluate(`return document.querySelector('#aircraft-page-autotaxi figure').textContent;`), /Live position unavailable/);
        assert.equal(await evaluate(`return document.querySelector('[data-taxi-show-route]').disabled;`), true);
        await evaluate(`layoutTest.moveAircraft({ x: 100, z: -100, headingDeg: 0, speedKts: 4 }); layoutTest.setTaxiState({ canGuide: true, guidanceUnavailableReason: null }); await layoutTest.settle();`);
        assert.match(await evaluate(`return document.querySelector('#aircraft-page-autotaxi figure').textContent;`), /away from the planned route/);
        await evaluate(`layoutTest.moveAircraft({ x: 0.4, z: 12, headingDeg: 3, speedKts: 2.4 }); layoutTest.setTaxiState({ canStart: true, unavailableReason: null }); await layoutTest.settle();`);
        if (id === 'generic') await require('./taxi-assistant-browser-checks')({ evaluate, wait });
        for (const width of [1440, 320]) {
          win.setContentSize(width, 1000); await wait(150);
          await evaluate(`document.querySelector('#aircraft-page-autotaxi').scrollIntoView({ behavior: 'instant' });`);
          await wait(150); await win.webContents.capturePage(); await wait(80);
          assert.equal(await evaluate(`return document.documentElement.scrollWidth > innerWidth;`), false, `${id} ${width}px: route preview fits`);
          fs.writeFileSync(path.join(OUTPUT, `${id}-autotaxi-preview-${width}.png`), (await win.webContents.capturePage()).toPNG());
        }
        await evaluate(`document.querySelector('[data-taxi-automation]').open = true; await layoutTest.settle(); document.querySelector('[data-taxi-start]').click(); await layoutTest.settle();`);
        assert.equal(await evaluate(`return layoutTest.taxiSent.findLast(message => message.operation === 'start').profileKey;`), `bundled/msfs/${id}`, `${id}: start carries the actual profile`);
        assert.equal(await evaluate(`return document.querySelector('#aircraft-page-autotaxi input').disabled;`), true, `${id}: active destination is locked`);
        await evaluate(`document.querySelector('[data-taxi-automation]').open = false; await layoutTest.settle();`);
        await wait(350);
        assert.equal(await evaluate(`return document.querySelector('[data-taxi-automation]').open;`), false, `${id}: status polling respects the optional disclosure`);
        assert.equal(await evaluate(`return ['stop', 'release'].every(action => document.querySelector('[data-taxi-' + action + ']').getBoundingClientRect().height >= 48);`), true, `${id}: active control exits stay visible outside the disclosure`);
        await evaluate(`document.querySelector('[data-taxi-stop]').click(); await layoutTest.settle();`);
        assert.equal(await evaluate(`return layoutTest.taxiSent.findLast(message => message.operation !== 'status').operation;`), 'stop', `${id}: Stop remains accessible`);
        await evaluate(`document.querySelector('[data-taxi-release]').click(); await layoutTest.settle();`);
        assert.equal(await evaluate(`return document.querySelector('#aircraft-page-autotaxi input').disabled;`), false, `${id}: release restores editing`);
        await evaluate(`layoutTest.taxiDisconnect(); await layoutTest.settle();`);
        assert.match(await evaluate(`return document.querySelector('#aircraft-page-autotaxi').textContent;`), /Connection lost/);
        assert.equal(await evaluate(`return document.querySelector('[data-taxi-start]').disabled;`), true, `${id}: lost connection disables Start`);
      }
      assert.deepEqual(errors, []);
      console.log('PASS Taxi assistant: six aircraft at 1440/390/320px; manual ribbon, live distance, stale/off-route guidance, navigation, optional Autotaxi, stop/release and reconnect.');
      app.exit(0); return;
    }
    if (!process.env.FF_CDU_LAYOUT_ONLY && !process.env.FF_AIRCRAFT_TOOLS_ONLY && !process.env.FF_AUTOTAXI_LAYOUT_ONLY) {
      await require('./aircraft-section-browser-checks')({ win, evaluate, settled, wait, output: OUTPUT });
    }
    for (const id of (process.env.FF_CDU_LAYOUT_ONLY === '1' || process.env.FF_AIRCRAFT_TOOLS_ONLY === '1' ? [] : process.env.FF_AUTOTAXI_LAYOUT_ONLY === '1' ? ['pmdg-737'] : AIRCRAFT)) {
      const priorTaxiRequests = await evaluate('return layoutTest.taxiSent.length;');
      await evaluate(`await layoutTest.cockpitScenario(${JSON.stringify(id)});`);
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
            navigation: [...document.querySelectorAll('[data-aircraft-template] nav button')].some(button => /^Pushback & taxi$/.test(button.textContent.trim())),
            sections: [...document.querySelectorAll('[data-pmdg-737-section]')].map(section => section.getAttribute('data-pmdg-737-section')),
            requests: layoutTest.taxiSent.length,
            motionRequests: layoutTest.taxiSent.slice(${priorTaxiRequests}).filter(message => message.operation !== 'status').length,
          };`);
          assert.equal(taxi.panel && taxi.navigation && taxi.experimental, true, `${width}px: Experimental Pushback & taxi panel and navigation are visible`);
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
              voice: visible(document.querySelector('[data-aircraft-voice-control-trigger]')),
              tools: visible(document.querySelector('.aircraft-tools-toggle')),
              library: visible(document.querySelector('[data-aircraft-controls-trigger]')),
              cdu: !document.querySelector('[data-cdu-trigger]') || visible(document.querySelector('[data-cdu-trigger]')),
              healthySummary: visible(document.querySelector('.aircraft-connection-summary--healthy')) };`);
          assert.ok(toolsLayout.height >= 44 && toolsLayout.height <= 112, `${id}: ${width}px actions fit in at most two compact rows: ${JSON.stringify(toolsLayout)}`);
          assert.equal(toolsLayout.find && toolsLayout.voice && toolsLayout.tools && toolsLayout.cdu, true, `${id}: Find, Voice commands, Tools and supported CDU stay directly accessible`);
          assert.equal(toolsLayout.library || toolsLayout.healthySummary, false, `${id}: secondary tools and duplicate healthy context do not consume the initial phone view`);
          // Reduced motion must not introduce a flex transition from zero width.
          // Measure in the same turn as expansion, before a paint can hide it.
          const searchLayout = await evaluate(`document.querySelector('.aircraft-find').getBoundingClientRect();
            document.querySelector('.aircraft-find__launcher').click(); await layoutTest.settle();
            document.querySelector('[data-aircraft-search-mode="page"]').click(); await layoutTest.settle();
            const input = document.getElementById('aircraft-find-input'); input.value = 'heading'; input.dispatchEvent(new Event('input', { bubbles: true })); await layoutTest.settle();
            input.focus({preventScroll:true});
            const panel = document.querySelector('.aircraft-find__panel').getBoundingClientRect();
            const current = document.querySelector('[data-aircraft-find-current]').getBoundingClientRect();
            const tools = document.querySelector('.aircraft-page-tools').getBoundingClientRect();
            return { left: panel.left, right: panel.right, width: panel.width, toolsWidth: tools.width,
              top: panel.top, bottom: panel.bottom, matchTop: current.top, viewport: innerWidth };`);
          assert.equal(await evaluate(`return document.activeElement.id;`), 'aircraft-find-input', `${id}: phone search focuses input`);
          assert.ok(await evaluate(`return document.querySelectorAll('[data-aircraft-find-match]').length;`), `${id}: phone search finds displayed cockpit information`);
          assert.ok(searchLayout.left >= 0 && searchLayout.right <= width && searchLayout.top >= 0, `${id}: search remains visible while finding results: ${JSON.stringify(searchLayout)}`);
          assert.ok(searchLayout.toolsWidth > width / 2 && searchLayout.width >= searchLayout.toolsWidth - 1,
            `${id}: expanded search fills its tools row immediately: ${JSON.stringify(searchLayout)}`);
          assert.ok(searchLayout.matchTop >= searchLayout.bottom, `${id}: sticky search does not cover the result: ${JSON.stringify(searchLayout)}`);
          if (width === 390) {
            // Request a fresh compositor frame: capturePage can return the
            // hidden window's previous, collapsed search image.
            const screenshot = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            fs.writeFileSync(path.join(OUTPUT, `${id}-phone-search.png`), Buffer.from(screenshot.data, 'base64'));
          }
          await evaluate(`document.querySelector('.aircraft-find__collapse').click(); await layoutTest.settle(); window.scrollTo({ top: 0, behavior: 'instant' });`);
          assert.equal(await evaluate(`return document.activeElement.classList.contains('aircraft-find__launcher');`), true, `${id}: close returns focus to visible search entry`);
          await wait(80);
        }
        if (id === 'inibuilds-a350-900') {
          assert.equal(await evaluate(`return document.querySelectorAll('[data-aircraft-control-group="flightGuidance.lsCaptain"], [data-aircraft-control-group="flightGuidance.lsFirstOfficer"]').length;`), 0, 'A350 LS controls appear only in shared EFIS');
          await evaluate("document.querySelector('[data-aircraft-view=presets]').click();await layoutTest.settle();");
          for (const [target, value] of [['cockpit', 50], ['displays', 75]]) {
            await evaluate(`const form = document.querySelector('[data-lighting-preset="${target}"]');
              form.scrollIntoView({ behavior: 'instant', block: 'center' });
              const input = form.querySelector('input[type="number"]'); input.value = '${value}';
              input.dispatchEvent(new Event('input', { bubbles: true })); await layoutTest.settle();
              form.querySelector('button[type="submit"]').click(); await layoutTest.settle();`);
            assert.deepEqual(await evaluate('return layoutTest.sent.at(-1);'), {
              type: 'canonical', commandId: `configuration.lighting.${target}`, input: { value },
            }, `A350 ${width}px: ${target} brightness dispatches its numeric command`);
          }
          await evaluate(`document.querySelector('[data-cockpit-lighting-presets]').scrollIntoView({ behavior: 'instant', block: 'start' });`);
          await win.webContents.capturePage(); await wait(120);
          const brightnessPosition = await evaluate(`const rect = document.querySelector('[data-cockpit-lighting-presets]').getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom };`);
          assert.ok(brightnessPosition.top >= -1 && brightnessPosition.top < height, `A350 ${width}px: brightness controls are reachable`);
          fs.writeFileSync(path.join(OUTPUT, `${id}-brightness-${width}.png`), (await win.webContents.capturePage()).toPNG());
          await evaluate("window.scrollTo({ top: 0, behavior: 'instant' });");
          await evaluate("document.querySelector('[data-aircraft-view=controls]').click();await layoutTest.settle();");
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
        assert.equal(await evaluate(`return document.querySelector('[data-taxi-show-route]').disabled;`), false, 'autotaxi requires ready state and a destination');
        await evaluate(`document.querySelector('[data-taxi-show-route]').click(); await layoutTest.settle();`);
        assert.equal(await evaluate(`return layoutTest.taxiSent.filter(message => message.operation !== 'status').at(-1).operation;`), 'preview');
        assert.equal(await evaluate(`return Boolean(document.querySelector('#aircraft-page-autotaxi figure svg'));`), true, 'dry run shows route before motion');
        await require('./taxi-assistant-browser-checks')({ evaluate, wait });
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
        assert.equal(await evaluate(`return document.querySelector('#aircraft-page-autotaxi .taxi-map').dataset.taxiView;`), '3d', 'guidance starts with the route ribbon');
        await evaluate(`document.querySelector('#aircraft-page-autotaxi input[name="autotaxi-view"][value="2d"]').click(); await layoutTest.settle(); document.querySelector('#aircraft-page-autotaxi input[name="autotaxi-view"][value="3d"]').click(); await layoutTest.settle();`);
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
        await evaluate(`document.querySelector('[data-taxi-automation]').open = true; await layoutTest.settle(); document.querySelector('[data-taxi-start]').click(); await layoutTest.settle();`);
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
          assert.equal(await evaluate(`return [...document.querySelectorAll('#aircraft-page-autotaxi button')].filter(button => button.getClientRects().length).every(button => button.getBoundingClientRect().height >= 48);`), true, `autotaxi ${width}: touch targets`);
          await win.webContents.capturePage(); await wait(100);
          fs.writeFileSync(path.join(OUTPUT, `pmdg-737-autotaxi-${width}.png`), (await win.webContents.capturePage()).toPNG());
        }
        // While taxiing in 3D the world follows each new sample and the aircraft holds still.
        await evaluate(`document.querySelector('#aircraft-page-autotaxi input[name="autotaxi-view"][value="2d"]').click(); await layoutTest.settle(); document.querySelector('#aircraft-page-autotaxi input[name="autotaxi-view"][value="3d"]').click(); await layoutTest.settle();`);
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
        await evaluate(`document.querySelector('[data-taxi-stop]').click(); await layoutTest.settle();`);
        assert.equal(await evaluate(`return layoutTest.taxiSent.filter(message => message.operation !== 'status').at(-1).operation;`), 'stop');
        await evaluate(`document.querySelector('[data-taxi-release]').click(); await layoutTest.settle();`);
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
        await evaluate(`document.querySelector('[data-taxi-show-route]').click(); await layoutTest.settle();`);
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
      await evaluate(`await layoutTest.cockpitScenario('pmdg-777');`);
      const toolActivations = [];
      for (const [width, touch] of [[1440, false], [900, false], [390, true], [320, true]]) {
        await resizeTools(width, 844);
        await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled:touch, maxTouchPoints:touch ? 5 : 1 });
        await evaluate(`window.scrollTo({ top:0, behavior:'instant' });`);
        for (const [trigger, modal] of [
          ['data-aircraft-voice-control-trigger', 'aircraft-voice-control-modal'],
          ['data-aircraft-integration-guide-trigger', 'aircraft-integration-cheatsheet-modal'],
          ['data-aircraft-controls-trigger', 'aircraft-controls-modal'],
        ]) {
          const directVoice = trigger === 'data-aircraft-voice-control-trigger';
          if (directVoice) {
            assert(await evaluate(`return document.querySelector('[${trigger}]').checkVisibility() && document.querySelector('.aircraft-tools-toggle').getAttribute('aria-expanded') === 'false';`), `${width}px: Voice commands is available with Tools closed`);
          } else {
            await activateTool('.aircraft-tools-toggle', touch);
            assert.equal(await evaluate(`return document.querySelector('.aircraft-tools-toggle').getAttribute('aria-expanded');`), 'true', `${width}px: native pointer opens Tools`);
          }
          await activateTool(`[${trigger}]`, touch);
          const opened = await evaluate(`return Boolean(document.getElementById('${modal}'));`);
          toolActivations.push({ width, input:touch ? 'touch' : 'mouse', trigger, opened });
          assert.equal(await evaluate(`return document.querySelector('.aircraft-tools-toggle').getAttribute('aria-expanded');`), 'false', 'opening a tool closes its disclosure');
          win.webContents.sendInputEvent({ type:'keyDown', keyCode:'Escape' });
          win.webContents.sendInputEvent({ type:'keyUp', keyCode:'Escape' });
          await wait(100);
          const returnSelector = directVoice ? `[${trigger}]` : '.aircraft-tools-toggle';
          if (opened) assert.equal(await evaluate(`return !document.getElementById('${modal}') && document.activeElement.matches('${returnSelector}');`), true, `${width}px: closing ${modal} restores its visible launcher`);
        }

      }
      assert.deepEqual(toolActivations.filter(result => !result.opened), [], 'every Aircraft action opens its dialog with native mouse/touch input');
      await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled:false, maxTouchPoints:1 });
      await resizeTools(390, 844);
      await evaluate(`window.scrollTo({ top: 0, behavior: 'instant' }); document.querySelector('.aircraft-tools-toggle').click(); await layoutTest.settle();`);
      const secondaryTools = await evaluate(`const panel = document.getElementById('aircraft-secondary-tools-panel'); const rect = panel.getBoundingClientRect();
        return { left: rect.left, right: rect.right, choices: [...panel.querySelectorAll('button')].map(button => button.getBoundingClientRect().height) };`);
      assert.ok(secondaryTools.left >= 0 && secondaryTools.right <= 390, `phone Tools disclosure fits the viewport: ${JSON.stringify(secondaryTools)}`);
      assert.equal(secondaryTools.choices.length, 2, 'Tools contains the guide and library once');
      assert.ok(secondaryTools.choices.every(height => height >= 44), 'secondary tools keep touch-sized targets');
      await evaluate(`document.querySelector('[data-aircraft-integration-guide-trigger]').focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await layoutTest.settle();`);
      assert.equal(await evaluate(`return document.querySelector('.aircraft-tools-toggle').getAttribute('aria-expanded') === 'false' && document.activeElement.classList.contains('aircraft-tools-toggle');`), true, 'Escape closes Tools and restores its visible launcher');
      await evaluate(`document.querySelector('.aircraft-tools-toggle').click(); await layoutTest.settle(); document.querySelector('.aircraft-find__launcher').focus(); await layoutTest.settle();`);
      assert.equal(await evaluate(`return document.querySelector('.aircraft-tools-toggle').getAttribute('aria-expanded');`), 'false', 'leaving Tools by keyboard closes it');
      await evaluate(`document.querySelector('.aircraft-tools-toggle').click(); await layoutTest.settle(); document.querySelector('.aircraft-find__launcher').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await layoutTest.settle();`);
      assert.equal(await evaluate(`return document.querySelector('.aircraft-tools-toggle').getAttribute('aria-expanded');`), 'false', 'pointer activation outside Tools closes it');
      for (const [trigger, modal] of [['data-aircraft-integration-guide-trigger', 'aircraft-integration-cheatsheet-modal']]) {
        await evaluate(`document.querySelector('.aircraft-tools-toggle').click(); await layoutTest.settle(); document.querySelector('[${trigger}]').click(); await layoutTest.settle();`);
        await ready(`#${modal}`);
        assert.equal(await evaluate(`return document.querySelector('.aircraft-tools-toggle').getAttribute('aria-expanded');`), 'false', 'opening a tool closes its disclosure');
        await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await layoutTest.settle();`);
        assert.equal(await evaluate(`return !document.getElementById('${modal}') && document.activeElement.classList.contains('aircraft-tools-toggle');`), true, `${modal}: close restores the visible Tools launcher`);
      }
      await evaluate(`document.querySelector('.aircraft-tools-toggle').focus();`);
      for (const width of [1440, 390]) {
        await resizeTools(width, 844);
        assert(await evaluate(`return document.activeElement.classList.contains('aircraft-tools-toggle')
          && document.activeElement.getBoundingClientRect().height > 0;`), 'Tools keeps focus across desktop and phone sizes');
      }
      await evaluate(`document.querySelector('.aircraft-find__launcher').click(); await layoutTest.settle(); document.querySelector('[data-aircraft-search-mode="page"]').click(); await layoutTest.settle(); const input = document.getElementById('aircraft-find-input'); input.focus(); input.value = 'heading'; input.dispatchEvent(new Event('input', { bubbles: true })); await layoutTest.settle();`);
      for (const [width, height] of [[1440, 1000], [700, 390], [320, 700]]) {
        await resizeTools(width, height);
        assert.equal(await evaluate(`return document.activeElement.id === 'aircraft-find-input' && document.getElementById('aircraft-find-input').value === 'heading' && Boolean(document.querySelector('[data-aircraft-find-current]'));`), true, 'resizing preserves the visible search input, query and matches');
      }
      await evaluate(`document.querySelector('.aircraft-find__collapse').click(); await layoutTest.settle(); layoutTest.setSourceStatus('stale'); await layoutTest.settle();`);
      // Exercise the fixture's 500 ms telemetry refresh before measuring the notice.
      await wait(600);
      assert.equal(await evaluate(`return layoutTest.specific.sourceStatus;`), 'stale', 'fixture telemetry preserves the requested stale source status');
      assert.equal(await evaluate(`return document.querySelector('.aircraft-connection-summary').getBoundingClientRect().height > 0;`), true, 'phone density does not hide stale-data context');
      await evaluate(`layoutTest.specific.dependencies = { mobiflightEventModule: { required: true, connected: false, status: 'missing' } }; await layoutTest.settle();`);
      assert.equal(await evaluate(`return document.querySelector('[data-aircraft-setup-required]')?.getBoundingClientRect().height > 0 && document.getElementById('aircraft-mobiflight-notice')?.getBoundingClientRect().height > 0;`), true, 'setup reasons and recovery remain visible on phone');
      await evaluate(`layoutTest.specific.dependencies = { mobiflightEventModule: { required: true, connected: false, status: 'missing', fallbackActive: true } }; await layoutTest.settle();`);
      assert.equal(await evaluate(`return document.querySelector('[data-aircraft-control-mode="direct-lvar-fallback"]')?.getBoundingClientRect().height > 0;`), true, 'fallback control routing remains explicit on phone');
      await win.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
    }
    for (const id of (process.env.FF_AUTOTAXI_LAYOUT_ONLY === '1' || process.env.FF_AIRCRAFT_TOOLS_ONLY === '1' ? [] : ['fenix-a320', 'fbw-a32nx', 'pmdg-737', 'pmdg-777'])) {
      await evaluate(`await layoutTest.cockpitScenario(${JSON.stringify(id)}); document.querySelector('[data-cdu-trigger]').click(); await layoutTest.settle();`);
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
          await win.webContents.capturePage();
          // One frame applies layout and delivers ResizeObserver; the next
          // commits Vue's resulting font update before geometry is inspected.
          await evaluate(`await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));`);
          // The viewport can resize before media queries and ResizeObserver
          // settle. Include compact scroll reachability in the readiness check:
          // viewport dimensions can arrive before scroll ranges finish resizing.
          // Retain every assertion below, including the last measurement on timeout.
          const measurements = await settled(`return {
            viewport: innerWidth,
            viewportHeight: innerHeight,
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
          };`, value => value.viewport === width && value.viewportHeight === height
            && !value.verticalOverflow && (compact || (!value.keypadScrolls && value.visibleKeys))
            && (!compact || (value.keysFitWidth && value.lastKeyReachable && (scrollPanel || value.screenVisible)))
            && (width !== 1440 || height !== 1000 || parseFloat(value.fontSize) >= 18));
          assert.equal(measurements.overflow, false, `${id} CDU fits ${width}px: ${JSON.stringify(measurements.pageOverflow)}`);
          assert.equal(measurements.verticalOverflow, false, `${id} CDU dialog needs no scrolling at ${width}x${height}: ${JSON.stringify(measurements)}`);
          assert.equal(measurements.viewport, width, 'CDU uses the requested viewport');
          assert.equal(measurements.viewportHeight, height, 'CDU uses the requested viewport height');
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
        // Periodic display reads share this transcript with key commands. Only
        // inspect commands sent after the action, even if a read finishes last.
        const lineKeyStart = await evaluate(`const start = layoutTest.cduSent.length;
          document.querySelector('[aria-label="Right line select 2"]').click(); await layoutTest.settle(); return start;`);
        assert.equal(await settled(`return layoutTest.cduSent.slice(${lineKeyStart}).at(-1)?.type === 'requestCduState';`, Boolean), true, 'display refresh continues after a key press');
        const lineCommand = await settled(`return layoutTest.cduSent.slice(${lineKeyStart}).find(message => message.type === 'sendCduKey');`, Boolean);
        assert.equal(lineCommand?.key, 'R2');
        await evaluate(`const select = document.querySelector('[aria-label="CDU unit"]'); select.value = 'right'; select.dispatchEvent(new Event('change', { bubbles: true })); await layoutTest.settle();`);
        assert.equal(await settled(`return !document.querySelector('.cdu-entry-keys [data-key="A"]').disabled;`, Boolean), true, 'right CDU is ready for input');
        const entryKeyStart = await evaluate(`const start = layoutTest.cduSent.length;
          document.querySelector('.cdu-entry-keys [data-key="A"]').click(); await layoutTest.settle(); return start;`);
        const entryCommand = await settled(`return layoutTest.cduSent.slice(${entryKeyStart}).find(message => message.type === 'sendCduKey');`, Boolean);
        assert.equal(entryCommand?.key, 'A');
        assert.equal(entryCommand?.side, 'right');
        const keyboardStart = await evaluate(`const start = layoutTest.cduSent.length;
          const button = document.querySelector('[data-cdu-modal] button[aria-pressed]'); button.click(); button.focus(); button.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true })); await layoutTest.settle(); return start;`);
        const keyboardCommand = await settled(`return layoutTest.cduSent.slice(${keyboardStart}).find(message => message.type === 'sendCduKey');`, Boolean);
        assert.equal(keyboardCommand?.key, 'B');
        const typeAheadStart = await evaluate(`const start = layoutTest.cduSent.length; for (const key of ['K', 'L', 'A', 'X']) {
          document.querySelector('.cdu-entry-keys [data-key="' + key + '"]').click(); await layoutTest.settle();
        } return start;`);
        assert.equal(await evaluate(`return [...document.querySelectorAll('.cdu-entry-keys button')].every(button => !button.disabled);`), true, 'type-ahead leaves the touch keypad enabled');
        assert.deepEqual(await settled(`return layoutTest.cduSent.slice(${typeAheadStart}).filter(message => message.type === 'sendCduKey').map(message => message.key);`, keys => keys.length >= 4), ['K', 'L', 'A', 'X'], 'fast taps arrive in order');
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
    if (!process.env.FF_CDU_LAYOUT_ONLY && !process.env.FF_AIRCRAFT_TOOLS_ONLY && !process.env.FF_AUTOTAXI_LAYOUT_ONLY) {
      await checkMountedNumericDrafts({ evaluate });
      await checkPresetFirstViews(false);
      await checkThrottleStyles();
      await checkAircraftDiscovery();
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
      fs.writeFileSync(path.join(OUTPUT, 'failure-layout.json'), JSON.stringify(await evaluate(`return {
        viewport: [innerWidth, innerHeight], scroll: [scrollX, scrollY], focused: document.activeElement.outerHTML.slice(0, 500),
        elements: [...document.querySelectorAll('.aircraft-page-tools, .aircraft-page-title, .aircraft-page-tool-actions, .aircraft-find, .aircraft-find__panel, .aircraft-secondary-tools, .aircraft-tools-toggle')].map(el => {
          const style = getComputedStyle(el); return { class: el.className, rect: el.getBoundingClientRect().toJSON(),
            display: style.display, position: style.position, width: style.width, flex: style.flex, minWidth: style.minWidth, maxWidth: style.maxWidth };
        }) };`), null, 2));
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
  const registry = require(runtime('aircraft/integration-engine/index.js')).defaultAircraftIntegrationRegistry;
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
  const fixtures = Object.fromEntries([...new Set([...AIRCRAFT, ...AUTOTAXI_AIRCRAFT, A380, ...INCLUDED_A32X])].map(id => {
    const templateId = templateFor(id);
    const profile = loader.loadProfile(`bundled/msfs/${id}`);
    const capabilities = buildAircraftControlCapabilities(profile, { profileRevision: 1,
      capabilities: { simulator: 'msfs', actionTypes: ['aircraft-integration', 'key-event', 'lvar'],
        integrationTransports: ['sdk', 'simconnect-sequence', 'lvar', 'mobiflight-calculator', 'input-event'] } });
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
    if (id === A380) for (const index of [1, 2]) Object.assign(values, {
      [`radios.com${index}.installed`]: true, [`radios.com${index}.status`]: 0,
      [`radios.com${index}.spacingMode`]: 1, [`radios.com${index}.activeMhz`]: index === 1 ? 122.8 : 121.5,
      [`radios.com${index}.standbyMhz`]: index === 1 ? 123.45 : 124.85,
    });
    if (id === A380) Object.assign(values, { 'flightGuidance.powered': true,
      'flightGuidance.speedValue': 200, 'flightGuidance.headingValue': 270,
      'flightGuidance.altitudeValue': 10000, 'flightGuidance.verticalSpeedValue': 0 });
    if (INCLUDED_A32X.includes(id)) Object.assign(values, {
      'fcu.speedKtsNative': 151, 'fcu.headingDegNative': 278,
      'fcu.altitudeFtNative': 11000, 'fcu.verticalSpeedFpmNative': 0,
      'fcu.verticalSpeedFpm': -700, 'systems.mainBusVoltage': 28,
    });
    const taxiSupport = { family: templateId, aircraftLabel: id === 'generic' ? 'Generic aircraft' : id.startsWith('fenix-') ? `Fenix ${id.slice(6).toUpperCase()}` : id.replace('pmdg-', 'PMDG '), qualificationStatus: 'candidate', reason: null,
      setupInstructions: id.startsWith('pmdg-') ? ['In PMDG setup, select Tiller + Rudder steering hardware.'] : id.startsWith('fenix-') ? ['Prepare the aircraft with automatic thrust control off.'] : ['Use standard simulator throttle, brake and steering controls.'] };
    return [id, { profile: { id, name: profile.name, aircraftTitle: id === 'generic' ? 'Cessna 172 Skyhawk' : profile.name }, templateId, capabilities, values, cdu: cduFixture(id), taxiSupport }];
  }));
  fixtures.__autotaxiFixture = AUTOTAXI_FIXTURE;
  fixtures.__pushbackE2E = process.env.FF_PUSHBACK_E2E === '1';
  const pushbackE2E = fixtures.__pushbackE2E
    ? require('../fixtures/pushback-e2e.cjs')(runtime, fixtures['pmdg-737'].capabilities.aircraftCommands) : null;
  const { createViteTestServer } = require('./vite-test-server');
  const { default: vue } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs')).href);
  const server = await createViteTestServer({ configFile: false, root: ROOT, logLevel: 'error',
    cacheDir: path.join(OUTPUT, 'vite-cache'), optimizeDeps: { entries: ['tests/fixtures/aircraft-layout-browser.js'] },
    plugins: [vue(), { name: 'aircraft-layout-fixture', configureServer(vite) {
      if (pushbackE2E) vite.middlewares.use('/pushback-e2e', pushbackE2E.middleware);
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
    // This covers the complete multi-aircraft/viewport suite, including native
    // screenshot capture. Individual rendering waits remain bounded above.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 180000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearTimeout(timer);
    assert.equal(timedOut, false, 'aircraft layout browser checks exceeded 180 seconds');
    assert.equal(code, 0, 'aircraft layout browser checks');
  } finally { await pushbackE2E?.dispose(); await server.close(); }
}
(process.versions.electron ? browser() : main()).catch(error => { console.error(error); process.exit(1); });
