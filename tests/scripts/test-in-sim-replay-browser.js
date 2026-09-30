'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, '.tmp/in-sim-replay-browser');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function browser() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(OUTPUT, `user-${process.pid}`));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  await app.whenReady();
  const make = () => new BrowserWindow({ show: false, width: 1440, height: 1000,
    webPreferences: { contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false } });
  const client = make(), toolbar = make();
  const evaluate = (win, source) => win.webContents.executeJavaScript(`(async()=>{${source}})()`);
  const errors = [];
  for (const win of [client, toolbar]) win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  async function until(win, expression) {
    for (let n = 0; n < 100; n++) { if (await evaluate(win, `return !!(${expression});`)) return; await wait(50); }
    throw new Error(`Timed out: ${expression}\n${errors.join('\n')}`);
  }
  async function click(win, label) {
    await evaluate(win, `const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}); if(!b || b.disabled) throw new Error('Button unavailable: '+${JSON.stringify(label)}); b.click();`);
  }
  async function fixture(action) { return evaluate(client, `return (await fetch('/fixture/${action}')).json();`); }
  try {
    await client.loadURL(process.env.FF_REPLAY_TEST_URL + '/replay-test');
    await toolbar.loadURL(process.env.FF_REPLAY_TEST_URL + '/toolbar/');
    await until(client, 'window.replayTest && window.logbookTest');
    await until(toolbar, "document.getElementById('tab-button-replay')");
    for (const width of [1440, 390, 320]) {
      client.setContentSize(width, 1000); toolbar.setContentSize(width, 1000); await wait(100);
      assert(await evaluate(client, "return ![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Replay in MSFS') && document.querySelector('.in-sim-replay-host').getBoundingClientRect().height===0;"), 'disabled client has no replay entry or panel');
      assert(await evaluate(toolbar, "return document.getElementById('tab-button-replay').hidden && document.getElementById('tab-replay').hidden;"), 'disabled toolbar has no replay entry');
      for (const [name, win] of [['client', client], ['toolbar', toolbar]]) {
        assert(await evaluate(win, 'return document.documentElement.scrollWidth<=innerWidth;'), `${name} disabled ${width}: no overflow`);
        fs.writeFileSync(path.join(OUTPUT, `${name}-disabled-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
    await evaluate(toolbar, "localStorage.setItem('ff_toolbar_prefs_v1', JSON.stringify({defaultTab:'replay'}));");
    await toolbar.loadURL(process.env.FF_REPLAY_TEST_URL + '/toolbar/');
    await until(toolbar, "document.getElementById('tab-button-flight')?.getAttribute('aria-selected')==='true'");
    assert(await evaluate(toolbar, "return document.getElementById('tab-button-replay').hidden;"), 'saved Replay preference fails closed');
    await evaluate(toolbar, "document.getElementById('settings-button').click();");
    assert(await evaluate(toolbar, "return !document.getElementById('setting-defaultTab-replay');"), 'disabled replay is absent from opening-tab preferences');
    await evaluate(toolbar, "document.querySelector('[data-close-settings]').click();");
    const denied = await fixture('attempt-start');
    assert.match(denied.error, /disabled/); assert.deepEqual(denied.calls, []);
    await fixture('enable');
    await until(client, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Replay in MSFS')");
    await until(toolbar, "!document.getElementById('tab-button-replay').hidden");
    await click(toolbar, 'Replay');
    await click(client, 'Replay in MSFS');
    await until(client, "document.querySelector('.ff-replay-aircraft').textContent.includes('FenixA320 CFM SL')");
    await until(toolbar, "document.querySelector('.ff-replay-aircraft').textContent.includes('FenixA320 CFM SL')");
    assert.equal((await fixture('state')).calls.length, 0, 'selecting replay does not acquire the aircraft');
    assert(await evaluate(client, "return [...document.querySelectorAll('button')].find(b=>b.textContent==='Check aircraft').disabled;"), 'explicit confirmations required');
    for (const width of [1440, 390, 320]) {
      client.setContentSize(width, 1000); toolbar.setContentSize(width, 1000); await wait(150);
      for (const [name, win] of [['client', client], ['toolbar', toolbar]]) {
        assert(await evaluate(win, "return document.documentElement.scrollWidth<=innerWidth;"), `${name} ${width}: no horizontal overflow`);
        fs.writeFileSync(path.join(OUTPUT, `${name}-setup-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
    await evaluate(client, "document.querySelectorAll('.ff-replay-check input').forEach(c=>c.click());");
    await click(client, 'Check aircraft');
    await until(client, "document.querySelector('.ff-replay-status').textContent.includes('exact recorded')");
    assert(await evaluate(client, "return [...document.querySelectorAll('button')].find(b=>b.textContent==='Start replay').disabled;"), 'mismatched aircraft cannot start');
    await fixture('ready');
    await until(toolbar, "![...document.querySelectorAll('button')].find(b=>b.textContent==='Start replay').disabled");
    await click(toolbar, 'Start replay');
    await until(client, "[...document.querySelectorAll('button')].some(b=>b.textContent==='Play' && !b.hidden && !b.disabled)");
    await click(client, 'Play');
    await until(toolbar, "[...document.querySelectorAll('button')].some(b=>b.textContent==='Pause' && !b.disabled)");
    await click(toolbar, 'Pause');
    await until(client, "[...document.querySelectorAll('button')].some(b=>b.textContent==='Play' && !b.disabled)");
    await evaluate(toolbar, "const s=document.querySelector('.ff-replay-field input[type=range]'); s.value='45000'; s.dispatchEvent(new Event('change',{bubbles:true}));");
    await until(client, "document.querySelector('.ff-replay-time').textContent.startsWith('0:45')");
    await click(client, 'Restart');
    await until(toolbar, "document.querySelector('.ff-replay-time').textContent.startsWith('0:00')");
    await evaluate(client, 'window.replayTest.disconnect();');
    await until(client, "document.querySelector('.ff-replay-status').textContent.includes('Disconnected')");
    assert(await evaluate(client, "return [...document.querySelectorAll('button')].find(b=>b.textContent==='Stop / Return').disabled;"), 'disconnected client cannot send commands');
    await evaluate(client, 'window.replayTest.connect();');
    await until(client, "![...document.querySelectorAll('button')].find(b=>b.textContent==='Stop / Return').disabled");
    await click(toolbar, 'Stop / Return');
    await until(client, "!document.querySelector('.ff-replay-recovery').hidden");
    for (const [name, win] of [['client', client], ['toolbar', toolbar]]) {
      await until(win, "!document.querySelector('.ff-replay-recovery').hidden");
      await win.webContents.capturePage(); await wait(100);
      assert(await evaluate(win, "return document.querySelector('.ff-replay-recovery').textContent.includes('engines off');"));
      fs.writeFileSync(path.join(OUTPUT, `${name}-recovery-320.png`), (await win.webContents.capturePage()).toPNG());
    }
    assert.equal((await fixture('state')).blocked, true, 'Stop waits for reload recovery');
    await fixture('recovered');
    await until(toolbar, "document.querySelector('.ff-replay-status').textContent.includes('connection restored')");
    const result = await fixture('state');
    assert.deepEqual(result.calls, ['suspend', 'launch', 'resume']);
    assert.deepEqual(result.commands, ['start', 'play', 'pause', 'seek', 'seek', 'stop']);
    // Simulate restarting into a release build after an unfinished dev replay.
    await fixture('disable-recovery');
    await until(client, "[...document.querySelectorAll('button')].some(b=>b.textContent==='Reconnect recovery / Retry' && !b.hidden)");
    await until(toolbar, "!document.getElementById('tab-button-replay').hidden");
    for (const win of [client, toolbar]) {
      assert(await evaluate(win, "return [...document.querySelectorAll('.ff-replay-panel button')].filter(b=>!b.hidden && b.getBoundingClientRect().height>0).every(b=>b.textContent==='Reconnect recovery / Retry');"), 'disabled recovery exposes no preparation or playback controls');
      assert(await evaluate(win, "return !document.querySelector('.ff-replay-recovery').hidden;"));
    }
    assert(await evaluate(client, "return ![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Replay in MSFS');"), 'recovery does not re-enable the Logbook entry');
    await click(toolbar, 'Reconnect recovery / Retry');
    await until(toolbar, "document.querySelector('.ff-replay-status').textContent.includes('Reload a parked flight')");
    await toolbar.webContents.capturePage(); await wait(100);
    assert(await evaluate(toolbar, "return document.querySelector('.ff-replay-recovery').getBoundingClientRect().height>0;"), 'reload instructions stay visible while recovering');
    fs.writeFileSync(path.join(OUTPUT, 'toolbar-disabled-recovery-320.png'), (await toolbar.webContents.capturePage()).toPNG());
    await fixture('recovered');
    await until(toolbar, "document.getElementById('tab-button-replay').hidden && !document.getElementById('tab-flight').hidden");
    await until(client, "document.querySelector('.in-sim-replay-host').getBoundingClientRect().height===0");
    assert.deepEqual((await fixture('state')).commands, result.commands, 'recovery never issues playback commands');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('Replay browser checks passed: default-off client/toolbar and saved preferences, backend rejection, explicit opt-in playback, disabled-build recovery, 320/390/1440px. Simulator I/O mocked.');
    app.exit(0);
  } catch (error) {
    for (const [name, win] of [['client', client], ['toolbar', toolbar]]) fs.writeFileSync(path.join(OUTPUT, `${name}-failure.png`), (await win.webContents.capturePage()).toPNG());
    console.error(error); app.exit(1);
  }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const { WebSocketServer } = require('ws');
  const { createReplaySession } = require('../../dist/backend/replay/replay-session');
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => wss.once('listening', resolve));
  const directory = fs.mkdtempSync(path.join(OUTPUT, 'session-'));
  const calls = [], commands = [];
  let worker, service;
  function emit(value) { worker.stdout.write(JSON.stringify({ session: service.snapshot().session, ...value }) + '\n'); }
  function resetService(enabled) {
    if (service) service.stop();
    service = createReplaySession({ directory, enabled,
    prepareClip: async () => ({ success: true, clip: { title: 'FenixA320 CFM SL', profileId: 'fenix-a320', durationMs: 120000, touchdownMs: 90000, samples: [] } }),
    suspend: async () => { calls.push('suspend'); }, resume: async () => { calls.push('resume'); }, entryBlocker: () => '',
    publish: value => { for (const ws of wss.clients) if (ws.readyState === 1) ws.send(JSON.stringify(value)); },
    launch: async (_session, clipPath) => {
      calls.push('launch'); worker = new EventEmitter();
      worker.stdin = new PassThrough(); worker.stdout = new PassThrough(); worker.stderr = new PassThrough();
      worker.stdin.on('data', line => {
        const command = JSON.parse(line); commands.push(command.type);
        emit({ type: 'replayAck', requestId: command.requestId, ok: true });
        if (command.type === 'start') fs.writeFileSync(path.join(directory, 'recovery.json'), JSON.stringify({ title: 'FenixA320 CFM SL' }));
        emit({ type: 'replayStatus', state: command.type === 'stop' ? 'recovery' : command.type === 'play' ? 'playing' : 'paused', positionMs: command.positionMs || 0, detail: '' });
      });
      setTimeout(() => {
        if (clipPath === null) { emit({ type: 'replayStatus', state: 'recovery', positionMs: 0, detail: 'Reload a parked flight to finish recovery.' }); return; }
        emit({ type: 'replayStatus', state: 'ready', positionMs: 0 });
        emit({ type: 'replayEligibility', readyToStart: false, loadedTitle: 'Different aircraft', detail: 'Load the exact recorded aircraft shown above.' }); }, 20);
      return worker;
    } });
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(JSON.stringify(service.snapshot()));
  }
  resetService(false);
  wss.on('connection', (ws, request) => {
    const privileged = request.url.includes('client=desktop');
    ws.send(JSON.stringify({ type: 'authorizationScope', scope: privileged ? 'full-control' : 'toolbar-presets' }));
    ws.send(JSON.stringify(service.snapshot()));
    ws.on('message', async data => {
      const message = JSON.parse(data);
      if (message.type === 'inSimReplay') {
        try { await service.request(message, privileged); }
        catch (error) { ws.send(JSON.stringify({ ...service.snapshot(), error: error.message })); }
      }
      if (ws.readyState === 1) ws.send(JSON.stringify(service.snapshot()));
    });
  });
  const { createViteTestServer } = require('./vite-test-server');
  const { default: vue } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs')).href);
  const server = await createViteTestServer({ configFile: false, root: ROOT, logLevel: 'error', cacheDir: path.join(OUTPUT, 'vite-cache'),
    optimizeDeps: { entries: ['tests/fixtures/in-sim-replay-browser.js'] },
    plugins: [vue(), { name: 'replay-fixture', configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/api/toolbar/bootstrap') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, wsPort: wss.address().port, appVersion: 'fixture', toolbarPresetToken: 'fixture' })); return; }
        if (url.pathname.startsWith('/fixture/')) {
          if (url.pathname === '/fixture/enable') resetService(true);
          if (url.pathname === '/fixture/disable-recovery') {
            fs.writeFileSync(path.join(directory, 'recovery.json'), JSON.stringify({ title: 'FenixA320 CFM SL' }));
            resetService(false);
          }
          if (url.pathname === '/fixture/attempt-start') {
            service.request({ operation: 'prepare', filePath: 'flight.csv', landingIndex: 0 }, true)
              .then(() => { res.statusCode = 500; res.end('Unexpected replay preparation'); })
              .catch(error => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: error.message, calls })); });
            return;
          }
          if (url.pathname === '/fixture/ready') emit({ type: 'replayEligibility', readyToStart: true, loadedTitle: 'FenixA320 CFM SL', detail: 'Aircraft checked. Ready to start replay.' });
          if (url.pathname === '/fixture/recovered') { fs.unlinkSync(path.join(directory, 'recovery.json')); emit({ type: 'replayStatus', state: 'done' }); worker.emit('close', 0); }
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ calls, commands, blocked: service.isBlocking() })); return;
        }
        if (url.pathname === '/replay-test') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/frontend-dist/tailwind.css"><script src="/shared/app-settings-shared.js"></script><style>body{margin:0;padding:16px;font-family:system-ui;background:rgb(var(--background));color:rgb(var(--foreground))}</style></head><body><div id="app"></div><script type="module" src="/tests/fixtures/in-sim-replay-browser.js"></script></body></html>'); return; }
        if (url.pathname.startsWith('/toolbar/')) {
          const name = url.pathname.slice(9) || 'index.html';
          if (!/^[\w.-]+$/.test(name)) return next();
          const file = path.join(ROOT, 'frontend/toolbar', name); if (!fs.existsSync(file)) return next();
          res.setHeader('Content-Type', name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.json') ? 'application/json' : 'text/html'); res.end(fs.readFileSync(file)); return;
        }
        next();
      });
    } }], resolve: { alias: { vue: path.join(ROOT, 'frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'), pinia: path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs') } },
    server: { host: '127.0.0.1', port: 0, watch: null } });
  await server.listen();
  try {
    const env = { ...process.env, FF_REPLAY_TEST_URL: `http://127.0.0.1:${server.httpServer.address().port}` }; delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { env, cwd: ROOT, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill(), 90000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearTimeout(timer); assert.equal(code, 0, 'replay browser checks');
  } finally {
    service.stop(); for (const ws of wss.clients) ws.terminate(); wss.close(); await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
(process.versions.electron ? browser() : main()).catch(error => { console.error(error); process.exit(1); });
