'use strict';
// Real browser + scoped WebSocket fixture. Aircraft writes are recorded by a
// fake transport; this does not establish cockpit acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, '.tmp/toolbar-presets/browser');
const AIRCRAFT = ['pmdg-737', 'pmdg-777', 'fenix-a320', 'fbw-a32nx', 'fbw-a380x', 'inibuilds-a350-900', 'inibuilds-a380-800-rr', 'tfdi-md-11', 'generic'];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function capture(win) {
  // Offscreen Chromium can acknowledge a resize before Viz has a copyable frame.
  for (let attempt = 0; ; attempt++) {
    try { return await win.webContents.capturePage(); }
    catch (error) {
      if (attempt >= 3 || !String(error).includes('UnknownVizError')) throw error;
      win.webContents.invalidate(); await wait(100);
    }
  }
}

// The real loader and iframe, with only the simulator services
// stubbed. This checks browser event routing and native bridge calls, not MSFS's
// own input hit testing or cockpit bindings.
function inputHost(httpPort, wsPort) {
  return `<!doctype html><html><head><link rel="stylesheet" href="/fixture/loader.css">
    <style>body{margin:0} #outside{height:48px;width:100%} ingame-ui{display:block;position:absolute;inset:48px 0 0}
    .panelInvisible,.minimized,.hide{display:none}</style></head><body id="flightfabric-panel">
    <button id="outside">Simulated cockpit / native header</button><flightfabric-panel><ingame-ui>
    <div class="ff-loader-body"><iframe id="flightfabric-panel-content" class="ff-loader-frame"></iframe>
    <div id="flightfabric-panel-fallback"><div id="flightfabric-panel-fallback-title"></div>
    <div id="flightfabric-panel-fallback-text"></div><div id="flightfabric-panel-fallback-detail"></div></div>
    </div></ingame-ui></flightfabric-panel>
    <script>
    var keyboardClaimed = false, nativeCalls = [], mouseBoundary = [], parentInputs = [], handlers = new Map();
    var Coherent = { trigger(name, ...args) { nativeCalls.push([name, ...args]);
      if (name === 'FOCUS_INPUT_FIELD') keyboardClaimed = true;
      if (name === 'UNFOCUS_INPUT_FIELD') keyboardClaimed = false;
    }, on(name, fn) { handlers.set(name, fn); }, off(name) { handlers.delete(name); }, fire(name) { if (handlers.has(name)) handlers.get(name)(); } };
    class TemplateElement extends HTMLElement { connectedCallback() {} disconnectedCallback() {} }
    function checkAutoload() {}
    var FLIGHTFABRIC_TOOLBAR_CONFIG = { httpPort: ${httpPort}, wsPort: ${wsPort}, packageVersion: '0.11.0-fixture' };
    var host = document.querySelector('ingame-ui'); host.active = true;
    // The installed ingameUi uses these same enter/leave events to report the
    // panel's mouse boundary through its toolbar listener.
    host.addEventListener('mouseenter', () => mouseBoundary.push('over'));
    host.addEventListener('mouseleave', () => mouseBoundary.push('out'));
    document.querySelector('#outside').addEventListener('mousedown', () => Coherent.fire('mousePressOutsideView'));
    ['mousedown', 'mouseup', 'click', 'wheel', 'keydown', 'keyup', 'keypress'].forEach(type => document.addEventListener(type, () => parentInputs.push(type)));
    </script><script src="/fixture/loader.js"></script></body></html>`;
}

async function checkNativeInputBridge(win) {
  win.setContentSize(1200, 1000);
  await win.loadURL(process.env.FF_TOOLBAR_PRESETS_TEST_URL.replace('/toolbar/', '/fixture/host'));
  const root = code => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
  let frame;
  for (let attempt = 0; attempt < 100; attempt++) {
    frame = win.webContents.mainFrame.frames.find(item => item.url.includes('/toolbar/'));
    if (frame && await root(`return document.querySelector('flightfabric-panel').ready;`)) break;
    await wait(50);
  }
  assert.ok(frame, 'loader created its local iframe');
  const page = code => win.webContents.mainFrame.frames.find(item => item.url.includes('/toolbar/')).executeJavaScript(`(async () => { ${code} })()`);
  const until = async (evaluate, code, expected = true) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(code) === expected) return;
      await wait(50);
    }
    fs.writeFileSync(path.join(OUTPUT, 'input-failure.png'), (await win.webContents.capturePage()).toPNG());
    console.error('Input diagnostics', await root(`return {nativeCalls, mouseBoundary, parentInputs, active:document.activeElement.tagName,
      ready:document.querySelector('flightfabric-panel').ready, html:document.querySelector('ingame-ui').outerHTML};`),
      await page(`return {active:document.activeElement.tagName, focus:document.hasFocus(), events:(window.fixtureEvents || []).slice(-30)};`));
    throw new Error('Input fixture did not settle: ' + code);
  };
  const mouse = (type, x, y, extra = {}) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), ...extra });
  const key = (type, keyCode, modifiers = []) => win.webContents.sendInputEvent({ type, keyCode, modifiers });
  const press = keyCode => { key('keyDown', keyCode); key('keyUp', keyCode); };
  const bounds = async selector => {
    const box = await page(`const node = document.querySelector(${JSON.stringify(selector)}); node.scrollIntoView({block:'center'});
      const rect = node.getBoundingClientRect(); return {x:rect.left, y:rect.top, width:rect.width, height:rect.height};`);
    const offset = await root(`const r = document.querySelector('iframe').getBoundingClientRect(); return {x:r.left, y:r.top};`);
    await wait(60); // Wait for scrolling/resizing to reach compositor hit testing.
    return { ...box, x: box.x + offset.x, y: box.y + offset.y };
  };
  const click = async selector => {
    const box = await bounds(selector), x = box.x + box.width / 2, y = box.y + box.height / 2;
    mouse('mouseMove', x, y); mouse('mouseDown', x, y, { button: 'left', clickCount: 1 });
    mouse('mouseUp', x, y, { button: 'left', clickCount: 1 }); await wait(40);
  };
  const count = () => page(`return (await (await fetch('/fixture/requests')).json()).length;`);
  await page(`await fetch('/fixture/aircraft?id=pmdg-737');`);
  const nav = '[data-preset="radios.nav.setBothActive"]', lighting = '[data-preset="configuration.lighting.cockpit"]';
  await until(page, `return Boolean(document.querySelector('${nav}'));`);
  const initialCount = await count();
  await page(`window.fixtureEvents = []; ['focus','blur','mousedown'].forEach(type => document.addEventListener(type, e=>window.fixtureEvents.push([type,e.target.tagName,e.target.id]), true));
    window.addEventListener('message', e=>window.fixtureEvents.push(['message',e.data])); window.addEventListener('blur',()=>window.fixtureEvents.push(['window blur']));`);
  await click(lighting + ' input[type=range]');
  await until(root, 'return keyboardClaimed;');
  const sliderValue = await page(`return Number(document.activeElement.value);`);
  press('Right');
  assert.equal(await page(`return Number(document.activeElement.value);`), sliderValue + 1, 'real arrow key edits the focused slider');
  const range = await bounds(lighting + ' input[type=range]');
  mouse('mouseDown', range.x + range.width / 2, range.y + range.height / 2, { button: 'left', clickCount: 1 });
  mouse('mouseMove', range.x + range.width * 0.8, range.y + range.height / 2, { modifiers: ['leftbuttondown'] });
  mouse('mouseUp', range.x + range.width * 0.8, range.y + range.height / 2, { button: 'left', clickCount: 1 });
  await wait(40);
  assert.ok(await page(`return Number(document.querySelector('${lighting} input[type=range]').value) > 70;`), 'real slider drag changes its target');
  assert.equal(await count(), initialCount, 'dragging and arrow keys never write a preset');
  await click(nav + ' input');
  for (const char of '110.30') { key('keyDown', char); key('char', char); key('keyUp', char); }
  await until(page, `return !document.querySelector('${nav} button').disabled;`);
  // Enter dispatch disables the focused input; capture must survive until the
  // user leaves the panel, including key repeat after a fast command result.
  key('keyDown', 'Enter'); key('char', '\r');
  await until(page, `return document.querySelector('${nav} input').disabled;`);
  assert.equal(await root('return keyboardClaimed;'), true, 'pending controls keep keyboard capture');
  await until(page, `return !document.querySelector('${nav} input').disabled;`);
  await click(nav + ' button');
  await until(page, `return !document.querySelector('${nav} button').disabled;`);
  key('keyDown', 'Enter', ['isautorepeat']); key('char', '\r', ['isautorepeat']); key('keyUp', 'Enter');
  await wait(400);
  assert.equal(await count(), initialCount + 2, 'Enter and click each send once; held Enter cannot reapply');
  // Focus + Space/Tab use actual browser input rather than element.click().
  await click(nav + ' input'); press('Tab');
  assert.equal(await page(`return document.activeElement === document.querySelector('${nav} button');`), true);
  assert.equal(await root('return keyboardClaimed;'), true, 'Tab retains native keyboard capture');
  key('keyDown', 'Space'); key('char', ' '); key('keyUp', 'Space');
  await until(page, `return document.querySelector('${nav} input').disabled;`);
  await until(page, `return !document.querySelector('${nav} input').disabled;`);
  assert.equal(await count(), initialCount + 3, 'Space applies exactly once');
  await page(`document.querySelector('#content').scrollTop = 0;`);
  await wait(80); // The scroll reset must paint before injecting the next wheel.
  mouse('mouseMove', 15, 300); mouse('mouseWheel', 15, 300, { deltaY: -300, deltaX: 0 });
  await until(page, `return document.querySelector('#content').scrollTop > 0;`);
  assert.deepEqual(await root('return mouseBoundary;'), ['over'], 'iframe controls and wheel stay inside native panel hover boundary');
  assert.deepEqual(await root('return parentInputs;'), [], 'iframe input events do not bubble to the host');
  mouse('mouseMove', 40, 20); mouse('mouseDown', 40, 20, { button: 'left', clickCount: 1 });
  mouse('mouseUp', 40, 20, { button: 'left', clickCount: 1 });
  await until(root, 'return keyboardClaimed;', false);
  assert.equal(await page(`return document.activeElement.tagName;`), 'BODY', 'outside click drops stale field focus');
  await require('./toolbar-sections-browser')({ win, page, root, click, bounds, mouse, key, press, until, count });
  for (const hiddenClass of ['minimized', 'panelInvisible', 'hide']) {
    await click(lighting + ' input[type=range]'); await until(root, 'return keyboardClaimed;');
    await root(`host.classList.add('${hiddenClass}');`);
    await until(root, 'return keyboardClaimed;', false);
    await wait(80); // Let the compositor remove the iframe and deliver window blur.
    await root(`host.classList.remove('${hiddenClass}');`);
    await until(root, `return document.querySelector('flightfabric-panel').panelActive;`);
    await wait(100); // Input starts after the reopened frame has been painted.
  }
  await click(lighting + ' input[type=range]'); await until(root, 'return keyboardClaimed;');
  await page(`await fetch('/fixture/aircraft?id=fbw-a32nx');`);
  await until(page, `return !document.querySelector('${nav}');`);
  assert.equal(await root('return keyboardClaimed;'), true, 'replacing a focused catalogue cannot release a held key');
  await root(`document.querySelector('flightfabric-panel').remove();`);
  await until(root, 'return keyboardClaimed;', false);
  assert.equal(await root('return handlers.size;'), 0, 'detach removes native listeners');
  console.log('Toolbar input bridge: real clicks, slider drag/arrows, typing, Enter/Space/Tab, held-key suppression, wheel, iframe mouse boundary, outside click, hide/minimize/reopen, aircraft change and detach passed.');
}

async function browser() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(OUTPUT, 'user-data-' + process.pid));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1200, height: 1000,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  win.webContents.on('render-process-gone', (_event, details) => errors.push('Renderer exited: ' + details.reason));
  win.webContents.on('unresponsive', () => errors.push('Renderer became unresponsive'));
  const evaluate = code => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
  async function until(code, expected = true) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(code) === expected) return;
      await wait(50);
    }
    throw new Error('Browser condition did not settle: ' + code);
  }
  try {
    await win.loadURL(process.env.FF_TOOLBAR_PRESETS_TEST_URL);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    for (const aircraft of AIRCRAFT) {
      const expected = await evaluate(`return (await (await fetch('/fixture/aircraft?id=${aircraft}')).json()).presets;`);
      await until(`return document.querySelectorAll('[data-preset]').length;`, expected.length);
      await until(`return [...document.querySelectorAll('[data-preset] button')].some(button => !button.disabled);`);
      assert.deepEqual(await evaluate(`return [...document.querySelectorAll('[data-preset]')].map(row => row.dataset.preset).sort();`), expected.sort(), aircraft + ': same supported app presets');
      for (const width of [1200, 375, 320]) {
        win.setContentSize(width, 1000); await wait(80);
        await evaluate(`document.querySelector('#toolbar-presets').scrollIntoView();`);
        const layout = await evaluate(`return { overflow: document.documentElement.scrollWidth > innerWidth || document.querySelector('#content').scrollWidth > innerWidth,
          buttons: [...document.querySelectorAll('[data-preset] button')].map(button => button.getBoundingClientRect().height),
          images: [...document.querySelectorAll('img')].every(image => image.complete && image.naturalWidth > 0) };`);
        assert.equal(layout.overflow, false, aircraft + ' ' + width + ': no overflow');
        fs.writeFileSync(path.join(OUTPUT, 'latest.png'), (await capture(win)).toPNG());
        assert.ok(layout.buttons.every(height => height >= 43.9), aircraft + ': touch targets ' + JSON.stringify(layout));
        assert.equal(layout.images, true, 'shared preset artwork loads');
        if (['pmdg-737', 'fbw-a32nx', 'tfdi-md-11'].includes(aircraft)) {
          fs.writeFileSync(path.join(OUTPUT, aircraft + '-' + width + '.png'), (await capture(win)).toPNG());
        }
      }
    }
    await evaluate(`await fetch('/fixture/aircraft?id=pmdg-737');`);
    await until(`return Boolean(document.querySelector('[data-preset="radios.nav.setBothActive"]'));`);
    await evaluate(`const input = document.querySelector('[data-preset="radios.nav.setBothActive"] input'); input.focus(); input.value = '110.30'; input.dispatchEvent(new Event('input', { bubbles: true }));`);
    await wait(1200);
    assert.equal(await evaluate(`return document.activeElement === document.querySelector('[data-preset="radios.nav.setBothActive"] input') && document.activeElement.value === '110.30';`), true, 'streamed data preserves typed value and focus');
    await until(`return !document.querySelector('[data-preset="radios.nav.setBothActive"] button').disabled;`);
    await evaluate(`document.querySelector('[data-preset="radios.nav.setBothActive"] button').click(); document.querySelector('[data-preset="radios.nav.setBothActive"] button').click();`);
    await until(`return document.querySelector('[data-preset="radios.nav.setBothActive"] .preset-result').textContent.includes('not confirmed');`);
    const requests = await evaluate(`return await (await fetch('/fixture/requests')).json();`);
    assert.equal(requests.length, 1); assert.equal(requests[0].input.value, 110.3);
    await evaluate(`document.documentElement.setAttribute('data-theme', 'light'); document.querySelector('[data-preset="configuration.lighting.cockpit"]').scrollIntoView();`);
    assert.equal(await evaluate(`return getComputedStyle(document.body).backgroundColor;`), 'rgb(243, 246, 251)', 'light palette applied');
    await wait(100);
    fs.writeFileSync(path.join(OUTPUT, 'brightness-light-320.png'), (await win.webContents.capturePage()).toPNG());
    await evaluate(`await fetch('/fixture/stale');`); await wait(2600);
    assert.equal(await evaluate(`return [...document.querySelectorAll('[data-preset] button')].every(button => button.disabled);`), true, 'missing readbacks disable all presets');
    await evaluate(`await fetch('/fixture/aircraft?id=tfdi-md-11');`);
    await until(`return document.querySelectorAll('[data-preset]').length;`, 4);
    await until(`return [...document.querySelectorAll('[data-preset] button')].every(button => !button.disabled);`);
    await evaluate(`document.querySelector('[data-preset="configuration.lights.takeoff"] button').click();`);
    await until(`return document.querySelector('[data-preset="configuration.lights.takeoff"] .preset-result').textContent.includes('not confirmed');`);
    const md11Requests = await evaluate(`return await (await fetch('/fixture/requests')).json();`);
    assert.equal(md11Requests.length, requests.length + 1);
    assert.equal(md11Requests.at(-1).commandId, 'configuration.lights.takeoff');
    await evaluate(`await fetch('/fixture/stale');`); await wait(2600);
    assert.equal(await evaluate(`return [...document.querySelectorAll('[data-preset] button')].every(button => button.disabled);`), true, 'stale MD-11 readbacks disable every phase preset');
    await checkNativeInputBridge(win);
    assert.deepEqual(errors, []);
    console.log(`Toolbar presets: ${AIRCRAFT.length} aircraft at desktop/375px/320px, focus, input, scoped dispatch and stale-data checks passed.`);
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const { createWsServer } = require('../../dist/backend/core/ws-bootstrap');
  const { toolbarPresetToken } = require('../../dist/backend/core/toolbar-presets');
  const { isClientMessageAuthorized } = require('../../dist/backend/core/client-message-authorization');
  const loader = require('../../dist/backend/aircraft/aircraft-profile-loader');
  const { buildAircraftControlCapabilities } = require('../../dist/backend/aircraft/aircraft-control-service');
  const presentation = require('../../shared/aircraft-presets');
  const requests = [];
  const taxiRequests = [], taxiScenes = new WeakMap(), pushbackRequests = [];
  let pushbackBrake = false;
  let taxiPosition = 'live';
  let departurePreviewEnabled = false, departurePhase = 'preview';
  let fixture, revision = 0, stale = false, plan = null, planRevision = 0, appVersion = '0.11.0-fixture';
  const sessionToken = 'isolated-toolbar-browser-fixture';
  function select(id) {
    assert.ok(AIRCRAFT.includes(id));
    stale = false;
    revision++;
    const profile = loader.loadProfile('bundled/msfs/' + id);
    const capabilities = buildAircraftControlCapabilities(profile, { profileRevision: revision, capabilities: {
      simulator: 'msfs', actionTypes: ['aircraft-integration', 'key-event', 'lvar'],
      integrationTransports: ['sdk', 'simconnect-sequence', 'lvar', 'mobiflight-calculator', 'input-event'],
    } });
    const commands = capabilities.aircraftCommands.commands;
    const grouped = presentation.groups(commands);
    fixture = { profile: { ...profile, profileRevision: revision, aircraftTitle: profile.name }, capabilities,
      fields: presentation.readbackFields(commands), presets: [...grouped.cards, ...grouped.lights, ...grouped.brightness].map(command => command.id) };
  }
  function snapshot(socket) {
    const catalogue = fixture.capabilities.aircraftCommands, at = new Date().toISOString();
    const values = Object.fromEntries(fixture.fields.map(id => [id, id.includes('apu') ? false : id.startsWith('lighting.') ? 50 : 0]));
    if (catalogue.configurationId === 'tfdi-md-11') Object.assign(values, {
      'systems.busVoltage': 115, 'lights.landingLeftPosition': 2, 'lights.landingRightPosition': 2,
      'lights.nosePosition': 2, 'lights.turnoffLeft': false, 'lights.turnoffRight': false, 'lights.strobe': true, 'lights.nav': true,
    });
    socket.send(JSON.stringify({ type: 'aircraftSpecificState', profileKey: catalogue.profileKey, profileRevision: catalogue.profileRevision,
      templateId: catalogue.configurationId, available: true, sourceStatus: { overall: 'connected', sources: { sdk: 'connected', lvar: 'connected' } },
      values, valueUpdatedAt: Object.fromEntries(fixture.fields.map(id => [id, at])), unavailable: [], updatedAt: at }));
  }
  function replay(socket) {
    socket.send(JSON.stringify({ type: 'aircraftProfile', profile: fixture.profile, controlCapabilities: fixture.capabilities }));
    socket.send(JSON.stringify({ type: 'simState', simconnectConnected: true, inMenu: false, lifecycleState: 'running' }));
    snapshot(socket);
    if (plan) socket.send(JSON.stringify(plan));
  }
  select('pmdg-737');
  const wss = createWsServer({ wsPort: 0, wsAuthToken: sessionToken, Debug: { log() {} }, tlog() {}, onClientConnected: replay,
    onClientMessage(socket, message) {
      if (message.type === 'requestState') replay(socket);
      if (message.type === 'pushback') {
        assert.equal(isClientMessageAuthorized(socket, 'pushback'), true);
        assert.equal(isClientMessageAuthorized(socket, 'autotaxi'), false);
        assert.ok(['status', 'start', 'stop'].includes(message.operation));
        pushbackRequests.push(message);
        const catalogue = fixture.capabilities.aircraftCommands;
        if (message.operation === 'start') {
          assert.equal(pushbackBrake, false); assert.equal(message.previewId, 'shown-' + message.runway);
          assert.equal(departurePhase, 'preview'); departurePhase = 'pushing';
        }
        if (message.operation === 'stop') departurePhase = 'preview';
        socket.send(JSON.stringify({ type: 'pushbackState', requestId: message.requestId, ok: true,
          currentProfileKey: catalogue.profileKey, currentProfileRevision: catalogue.profileRevision,
          icao: message.icao, runway: message.runway, active: departurePhase === 'pushing',
          status: departurePhase === 'preview' ? 'idle' : departurePhase, remainingM: 48,
          canStart: !pushbackBrake && departurePhase === 'preview',
          unavailableReason: pushbackBrake ? 'Release the parking brake to push back.' : null }));
        return;
      }
      if (message.type === 'requestTaxiGuidance') {
        assert.equal(isClientMessageAuthorized(socket, message.type), true);
        assert.equal(isClientMessageAuthorized(socket, 'autotaxi'), false);
        assert.ok(['status', 'preview', 'parkings'].includes(message.operation)); taxiRequests.push(message);
        const catalogue = fixture.capabilities.aircraftCommands;
        const reply = { type: 'toolbarTaxiState', requestId: message.requestId, ok: true, canGuide: taxiPosition !== 'stale',
          currentProfileKey: catalogue.profileKey, currentProfileRevision: catalogue.profileRevision };
        if (message.pushback) {
          const points = [{ x: 30, z: 60 }, { x: 30, z: 30 }, { x: 25, z: 10 }, { x: 0, z: 0 }];
          Object.assign(reply, { ok: departurePreviewEnabled, error: departurePreviewEnabled ? null : 'No simple pushback fixture.',
            pushbackPreview: { id: 'shown-' + message.runway, icao: message.icao, runway: message.runway, phase: departurePhase,
              valid: departurePhase === 'preview', points, headingDeg: 0, lengthM: 78, remainingM: departurePhase === 'pushing' ? 48 : 78 },
            aircraft: taxiPosition === 'stale' ? null : { ...points[departurePhase === 'pushing' ? 1 : 0], headingDeg: 0, speedKts: 0 },
            preview: { points: [{ x: 0, z: 0 }, { x: 0, z: 140 }], holdShort: { x: 0, z: 165 }, runway: message.runway, lengthM: 140 },
            scene: { key: 42, links: [{ a: { x: 0, z: -50 }, b: { x: 0, z: 200 }, widthM: 24 }], runways: [], stands: [] } });
          socket.send(JSON.stringify(reply)); return;
        }
        if (message.operation === 'parkings') reply.standOptions = [{ label: 'Gate A 12', typeLabel: 'Heavy gate' }, { label: 'Ramp 3', typeLabel: 'GA ramp' }];
        if (message.operation === 'preview') {
          const points = [{ x: 0, z: 0 }, { x: 0, z: 140 }, { x: 80, z: 220 }, { x: 80, z: 430 }];
          const route = { points, holdShort: { x: 80, z: 460 }, lengthM: 463, runway: message.runway || null,
            kind: message.parking ? 'stand' : 'runway', label: message.parking || message.runway, runwayTravelM: 40, joinM: 5,
            ...(message.parking ? { stand: { x: 80, z: 430, radiusM: 25 } } : {}) };
          const scene = { key: taxiRequests.length, links: points.slice(1).map((p, i) => ({ a: points[i], b: p, widthM: 24, runway: false })),
            runways: [], stands: [{ x: 80, z: 430, radiusM: 25, headingDeg: 0, label: 'Gate A 12' }] };
          taxiScenes.set(socket, scene); reply.preview = route; reply.scene = scene;
        }
        const scene = taxiScenes.get(socket); reply.sceneKey = scene ? scene.key : null;
        if (message.scene && scene) reply.scene = scene;
        reply.aircraft = taxiPosition === 'stale' || !scene ? null : { x: taxiPosition === 'off' ? 90 : 0, z: 10, headingDeg: 0, speedKts: 8 };
        if (message.operation === 'preview') setTimeout(() => { if (socket.readyState === 1) socket.send(JSON.stringify(reply)); }, 300);
        else socket.send(JSON.stringify(reply));
        return;
      }
      if (message.type !== 'executeAircraftCommand') return;
      assert.equal(isClientMessageAuthorized(socket, message.type), true);
      assert.equal(socket.__ffToolbarPresetClient, true); assert.equal(socket.__ffPrivilegedClient, false);
      assert.ok(fixture.presets.includes(message.commandId)); requests.push(message);
      setTimeout(() => { if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'aircraftCommandResult', requestId: message.requestId, commandId: message.commandId, ok: true, code: 'sent_unconfirmed' })); }, 300);
    } });
  await once(wss, 'listening');
  const interval = setInterval(() => { if (!stale) for (const socket of wss.clients) if (socket.readyState === 1) snapshot(socket); }, 500);
  const assets = { '/toolbar/': ['toolbar/index.html', 'text/html'], '/toolbar/toolbar.js': ['toolbar/toolbar.js', 'text/javascript'],
    '/toolbar/taxi.js': ['toolbar/taxi.js', 'text/javascript'],
    '/toolbar/presets.js': ['toolbar/presets.js', 'text/javascript'], '/toolbar/toolbar.css': ['toolbar/toolbar.css', 'text/css'],
    '/toolbar/voice-reference.json': ['toolbar/voice-reference.json', 'application/json'], '/assets/aircraft-presets.svg': ['assets/aircraft-presets.svg', 'image/svg+xml'] };
  const http = require('node:http').createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    if (url.pathname === '/fixture/host') { res.setHeader('Content-Type', 'text/html'); return res.end(inputHost(http.address().port, wss.address().port)); }
    if (url.pathname === '/fixture/loader.js' || url.pathname === '/fixture/loader.css') {
      const extension = url.pathname.endsWith('.js') ? 'js' : 'css';
      res.setHeader('Content-Type', extension === 'js' ? 'text/javascript' : 'text/css');
      return res.end(fs.readFileSync(path.join(ROOT, 'msfs-toolbar-panel/package/html_ui/InGamePanels/FlightFabric/FlightFabric.' + extension)));
    }
    if (url.pathname === '/api/toolbar/bootstrap') return json({ ok: true, wsPort: wss.address().port, appVersion, toolbarPresetToken: toolbarPresetToken(sessionToken) });
    if (url.pathname === '/fixture/exercise') {
      const broadcast = message => { for (const socket of wss.clients) if (socket.readyState === 1) socket.send(JSON.stringify(message)); };
      const event = url.searchParams.get('event');
      if (event === 'plan') {
        plan = { type: 'flightPlan', origin: 'YSSY', destination: 'YMML', callsign: 'REVIEW' + (++planRevision), aircraft: 'B738',
          route: 'DCT RAZZI Q29 ML DCT', cruiseAltFl: 'FL350', eteSeconds: 5400, fuelLbs: 17000,
          weather: { originMetar: 'YSSY 250400Z 05010KT 9999 SCT020 22/12 Q1015', destinationTaf: 'YMML 250400Z 2506/2606 03008KT 9999 SCT025' },
          fuel: { taxi: 200, trip: 12000, reserve: 2000 }, weights: { payload: 22000, takeoff: 145000 },
          navlog: [{ ident: 'LONG_WAYPOINT_NAME', altitude: 35000, windDirection: 270, windSpeed: 35, temperature: -40, distance: 120, legTime: 900, fuelRemaining: 15000 }],
          icaoFlightPlan: '(FPL-REVIEW-IS-B738/M-SDE2E3FGHIRWXY/LB1-YSSY0400-N0450F350 DCT RAZZI Q29 ML DCT-YMML0130)' };
        broadcast(plan); return json({ callsign: plan.callsign });
      }
      if (event === 'voice') broadcast({ type: 'voiceStatus', status: 'listening', statusText: 'Input review phrase' });
      if (event === 'capabilities') broadcast({ type: 'dataSources', profileKey: fixture.capabilities.aircraftCommands.profileKey,
        profileRevision: revision, controlCapabilities: fixture.capabilities });
      if (event === 'update') appVersion = '0.11.0-updated-fixture';
      if (event === 'disconnect' || event === 'update') for (const socket of wss.clients) socket.close(1012, 'Fixture restart');
      return json({ ok: true });
    }
    if (url.pathname === '/fixture/aircraft') { select(url.searchParams.get('id')); for (const socket of wss.clients) replay(socket); return json({ presets: fixture.presets }); }
    if (url.pathname === '/fixture/requests') return json(requests);
    if (url.pathname === '/fixture/pushback') {
      if (url.searchParams.has('brake')) pushbackBrake = url.searchParams.get('brake') === 'true';
      return json(pushbackRequests);
    }
    if (url.pathname === '/fixture/taxi') {
      if (url.searchParams.has('position')) taxiPosition = url.searchParams.get('position');
      if (url.searchParams.has('pushback')) departurePreviewEnabled = url.searchParams.get('pushback') === 'true';
      if (url.searchParams.has('phase')) departurePhase = url.searchParams.get('phase');
      return json(taxiRequests);
    }
    if (url.pathname === '/fixture/stale') { stale = true; return json({ ok: true }); }
    if (url.pathname === '/shared/app-settings-shared.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync(path.join(ROOT, 'shared/app-settings-shared.js'))); }
    const asset = assets[url.pathname];
    if (!asset) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', asset[1]); res.end(fs.readFileSync(path.join(ROOT, 'frontend-dist', asset[0])));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  try {
    const env = { ...process.env, FF_TOOLBAR_PRESETS_TEST_URL: 'http://127.0.0.1:' + http.address().port + '/toolbar/' };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { env, cwd: ROOT, windowsHide: true, stdio: 'inherit' });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
    const [code] = await once(child, 'exit'); clearTimeout(timer);
    assert.equal(timedOut, false); assert.equal(code, 0);
  } finally { clearInterval(interval); for (const socket of wss.clients) socket.terminate(); wss.close(); http.close(); }
}
(process.versions.electron ? browser() : main()).catch(error => { console.error(error); process.exit(1); });
