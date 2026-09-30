'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, '.tmp/packaged-replay-gate');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function browser() {
  const { app, BrowserWindow } = require('electron');
  fs.mkdirSync(OUTPUT, { recursive: true });
  app.setPath('userData', path.join(OUTPUT, `browser-${process.pid}`));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const make = width => new BrowserWindow({ show: false, width, height: 1000,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const client = make(1440), toolbar = make(320);
  const evaluate = (win, code) => win.webContents.executeJavaScript(`(async()=>{${code}})()`);
  async function until(win, expression) {
    for (let n = 0; n < 200; n++) {
      if (await evaluate(win, `return !!(${expression});`)) return;
      await wait(100);
    }
    throw new Error(`Timed out: ${expression}`);
  }
  const stores = "document.getElementById('vue-app-root')?.__vue_app__?.config.globalProperties.$pinia?._s";
  try {
    const url = process.env.FF_PACKAGED_REPLAY_URL;
    await client.loadURL(url + '/');
    await toolbar.loadURL(url + '/toolbar/');
    await until(client, `${stores}?.get('status')?.websocket === 'ready'`);
    await until(toolbar, "document.getElementById('tab-button-replay')");
    await evaluate(client, "document.querySelector('.desktop-tab[data-tab=\"timeline\"]').click();");
    await until(client, "document.getElementById('tab-timeline')?.classList.contains('active')");
    await evaluate(client, `
      const stores = ${stores};
      if (!stores.get('in-sim-replay') || stores.get('in-sim-replay').enabled !== false) throw new Error('Replay availability is not disabled');
      // Load a synthetic recording through the real packaged backend. Do not
      // alter the backend-owned replay availability or use a user's recording.
      if (!stores.get('timeline').requestTimeline(${JSON.stringify(process.env.FF_PACKAGED_REPLAY_FILE)})) throw new Error('Recording request failed');
    `);
    const loaded = `${stores}?.get('timeline')?.loadedTimelineFilePath === ${JSON.stringify(process.env.FF_PACKAGED_REPLAY_FILE)}
      && !${stores}.get('timeline').timelineLoading && !${stores}.get('timeline').timelineLoadError`;
    await until(client, loaded);
    assert.equal(await evaluate(client, "return [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Replay in MSFS');"), false);
    assert.equal(await evaluate(client, "return document.querySelector('.in-sim-replay-host').getBoundingClientRect().height;"), 0);
    await evaluate(toolbar, "localStorage.setItem('ff_toolbar_prefs_v1', JSON.stringify({defaultTab:'replay'}));");
    await toolbar.loadURL(url + '/toolbar/');
    await until(toolbar, "document.getElementById('tab-button-flight')?.getAttribute('aria-selected')==='true'");
    await until(toolbar, "['Connected', 'Simulator link down', 'In menu'].includes(document.getElementById('connection-pill')?.textContent)");
    assert.equal(await evaluate(toolbar, "return document.getElementById('tab-button-replay').hidden && document.getElementById('tab-replay').hidden;"), true);
    await evaluate(toolbar, "document.getElementById('settings-button').click();");
    assert.equal(await evaluate(toolbar, "return !!document.getElementById('setting-defaultTab-replay');"), false);
    await evaluate(toolbar, "document.querySelector('[data-close-settings]').click();");
    assert.equal(await evaluate(client, `return !!(${loaded});`), true, 'selected recording remains successfully loaded');
    for (const [name, win] of [['client', client], ['toolbar', toolbar]]) {
      await win.webContents.capturePage(); await wait(100);
      fs.writeFileSync(path.join(OUTPUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    }
    console.log('Packaged frontend: selected-flight replay button, replay panel, toolbar tab and saved opening preference remain disabled.');
    app.exit(0);
  } catch (error) {
    for (const [name, win] of [['client', client], ['toolbar', toolbar]]) {
      fs.writeFileSync(path.join(OUTPUT, `${name}-failure.png`), (await win.webContents.capturePage()).toPNG());
    }
    console.error(error); app.exit(1);
  }
}

async function verifyBackend({ wsPort, httpPort }) {
  const WebSocket = require('ws');
  const origin = `http://127.0.0.1:${httpPort}`;
  const desktop = await (await fetch(origin + '/api/bootstrap', { signal: AbortSignal.timeout(5000) })).json();
  const toolbar = await (await fetch(origin + '/api/toolbar/bootstrap', { signal: AbortSignal.timeout(5000) })).json();
  assert.ok(desktop.wsAuthToken && toolbar.toolbarPresetToken, 'both authorized client scopes are available');
  for (const [key, token, scope] of [['token', desktop.wsAuthToken, 'full-control'],
    ['toolbarPresetToken', toolbar.toolbarPresetToken, 'toolbar-presets']]) {
    const messages = [];
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/?${key}=${encodeURIComponent(token)}`, { origin, handshakeTimeout: 5000 });
    ws.on('message', data => messages.push(JSON.parse(data)));
    ws.on('error', () => {});
    async function next(predicate, from = 0) {
      for (let n = 0; n < 100; n++) {
        const value = messages.slice(from).find(predicate);
        if (value) return value;
        await wait(50);
      }
      throw new Error('Packaged replay response timed out');
    }
    try {
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      assert.equal((await next(m => m.type === 'authorizationScope')).scope, scope);
      ws.send(JSON.stringify({ type: 'inSimReplay', operation: 'status' }));
      const state = await next(m => m.type === 'inSimReplayState');
      assert.equal(state.enabled, false, 'packaged backend must refuse the development opt-in');
      assert.equal(state.blocked, false, 'clean isolated profile has no interrupted replay');
      for (const operation of ['prepare', 'connect', 'start', 'play', 'pause', 'seek']) {
        const cursor = messages.length;
        ws.send(JSON.stringify({ type: 'inSimReplay', operation, session: state.session,
          filePath: 'release-gate-fixture.csv', landingIndex: 0, positionMs: 0,
          recordedAt1x: true, acceptReload: true }));
        const denied = await next(m => m.type === 'inSimReplayState' && m.error, cursor);
        assert.equal(denied.enabled, false);
        assert.match(denied.error, /disabled in this build/);
      }
    } finally { ws.terminate(); }
  }
  console.log('Packaged backend: desktop and toolbar scopes rejected all six new-session/playback operations.');
}

async function verifyBrowser({ httpPort, profileRoot }) {
  const bundle = path.join(profileRoot, 'Documents/Flight Fabric/Flight Logs/2026-09-28_release-gate');
  fs.mkdirSync(bundle, { recursive: true });
  const recording = path.join(bundle, 'telemetry.csv');
  const start = Date.parse('2026-09-28T00:00:00Z');
  fs.writeFileSync(recording, [
    'record_type,timestamp_utc,ts,lat_deg,lon_deg,ias_kts,vs_fpm,ra_ft,on_ground,phase,aircraft,flight_id',
    ...Array.from({ length: 6 }, (_, i) => `SAMPLE,${new Date(start + i * 1000).toISOString()},${start + i * 1000},47.45,-122.31,140,-500,1000,0,APPROACH,Release gate test,release-gate`),
  ].join('\n') + '\n');
  const env = { ...process.env, FF_PACKAGED_REPLAY_URL: `http://127.0.0.1:${httpPort}`, FF_PACKAGED_REPLAY_FILE: recording };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('../../electron/node_modules/electron'), [__filename], {
    cwd: ROOT, env, windowsHide: true, stdio: 'inherit',
  });
  const timeout = setTimeout(() => child.kill(), 45000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, 'packaged frontend replay gate');
  } finally { clearTimeout(timeout); }
}

async function main() {
  const { runPackagedLifecycleScenario } = require('./test-electron-packaged-lifecycle');
  const backend = path.join(ROOT, 'dist/electron/win-unpacked/resources/backend');
  assert.equal(fs.realpathSync(backend).toLowerCase(), backend.toLowerCase(), 'test output must not be redirected');
  const envFile = path.join(backend, '.env.local');
  const environment = { FF_ENABLE_EXPERIMENTAL_REPLAY: '1', FLIGHT_ENV_MODE: 'dev', ELECTRON_PACKAGED: '0' };
  for (const localFile of [false, true]) {
    let created = false;
    try {
      if (localFile) {
        fs.writeFileSync(envFile, Object.entries(environment).map(([k, v]) => `${k}=${v}`).join('\n'), { flag: 'wx' });
        created = true;
      }
      await runPackagedLifecycleScenario('hard-death', { environment, verifyReady: async info => {
        await verifyBackend(info);
        if (localFile) await verifyBrowser(info);
      } });
      console.log(`Packaged replay release gate passed with ${localFile ? 'local-file and inherited' : 'inherited'} development overrides.`);
    } finally { if (created) fs.unlinkSync(envFile); }
  }
}

(process.versions.electron ? browser() : main()).catch(error => { console.error(error); process.exitCode = 1; });
