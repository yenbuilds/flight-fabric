'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { once } = require('node:events');
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, '.tmp/mobile-voice-browser');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function browser() {
  const { app, BrowserWindow, session } = require('electron');
  app.setPath('userData', path.join(OUTPUT, `profile-${process.pid}`));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  for (const name of ['disable-gpu', 'disable-gpu-compositing', 'disable-gpu-sandbox', 'use-fake-device-for-media-stream', 'use-fake-ui-for-media-stream']) app.commandLine.appendSwitch(name);
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${path.join(OUTPUT, 'heading.wav')}%noloop`);
  await app.whenReady();
  // Trust exactly this ephemeral fixture leaf. Node transport tests separately
  // validate its CA chain. Never change the user's certificate store or accept
  // other invalid certificates.
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    const certificate = new (require('node:crypto').X509Certificate)(request.certificate.data);
    callback(request.hostname === '127.0.0.1' && certificate.fingerprint256 === process.env.FF_MOBILE_VOICE_FINGERPRINT ? 0 : -3);
  });
  const url = process.env.FF_MOBILE_VOICE_URL;
  await session.defaultSession.cookies.set({ url, name: '__Secure-ff_voice_pair', value: process.env.FF_MOBILE_VOICE_PAIR,
    path: '/', secure: true, httpOnly: true, sameSite: 'strict' });
  const win = new BrowserWindow({ show: false, width: 390, height: 844,
    webPreferences: { contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.message && !event.message.startsWith('[vite]')) console.log(event.message); });
  const evaluate = code => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
  async function until(code) {
    const limit = Date.now() + 12000;
    while (Date.now() < limit) { if (await evaluate(`return Boolean(${code});`)) return; await wait(50); }
    throw new Error(`Browser wait failed: ${code}; ${await evaluate('return document.body.innerText || document.body.outerHTML.slice(0,1000);')}`);
  }
  async function activate(selector, keyboard = false) {
    const selectorJson = JSON.stringify(selector);
    const position = await evaluate(`const el = document.querySelector(${selectorJson});
      el.scrollIntoView({ block: 'center' });
      ${keyboard ? 'el.focus();' : ''}
      const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };`);
    await win.webContents.capturePage();
    if (keyboard) {
      for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
        ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}),
      });
    } else {
      assert.equal(await evaluate(`return document.querySelector(${selectorJson}).contains(document.elementFromPoint(${position.x}, ${position.y}));`), true, 'native pointer reaches ' + selector);
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...position });
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...position });
    }
  }
  async function guideStep(number) {
    await until(`document.querySelector('[data-phone-voice-step="${number}"]')`);
    await until('!document.querySelector("[data-mobile-voice-setup] [role=status]")');
    assert.equal(await evaluate('return document.documentElement.scrollWidth > innerWidth + 1;'), false, 'guide fits the viewport');
    assert.equal(await evaluate('return document.querySelectorAll("[data-phone-voice-step]").length;'), 1, 'one task at a time');
    assert.equal(await evaluate('return document.querySelectorAll("[role=img]").length;'), 0, 'phone setup never asks the user to scan another QR');
    assert.equal(await evaluate('return !!document.querySelector("[data-phone-voice-download]");'), number === 1, 'certificate downloads directly on this phone');
    assert.equal(await evaluate('return document.querySelector("[aria-current=step]").textContent.trim().startsWith(' + number + ');'), true);
  }
  async function headingFocused() {
    await until('document.activeElement === document.querySelector("[data-phone-voice-step] h5")');
  }
  async function captureGuide(name, selector = '[data-phone-voice-step]') {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'start' });`);
    await win.webContents.capturePage(); await wait(150);
    fs.writeFileSync(path.join(OUTPUT, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  try {
    await win.loadURL(url); await until('window.phoneVoiceTest');
    assert.equal(await evaluate('return isSecureContext;'), true);
    for (const width of [390, 320, 1200]) {
      win.setContentSize(width, 844); await win.webContents.capturePage();
      assert.equal(await evaluate('return document.documentElement.scrollWidth > innerWidth + 1;'), false);
      assert.equal(await evaluate('return document.querySelector("[data-mobile-voice-control] button").getBoundingClientRect().height >= 60;'), true, 'hold button remains a generous touch target');
      fs.writeFileSync(path.join(OUTPUT, `phone-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    win.setContentSize(390, 844); await win.webContents.capturePage();
    const position = await evaluate('const r=document.querySelector("[data-mobile-voice-control] button").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};');
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...position });
    await until('document.querySelector("#mobile-voice-status").textContent.includes("Listening on this phone")');
    await wait(4100);
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...position });
    await until('document.querySelector("dl")?.textContent.includes("270")');
    assert.match(await evaluate('return document.querySelector("#mobile-voice-status").textContent;'), /^Sent .*270\./i);
    assert.equal(await evaluate('return document.querySelector("[data-mobile-voice-control] button").disabled;'), false, 'a new recording is available after the result');
    await win.webContents.capturePage(); await wait(150);
    fs.writeFileSync(path.join(OUTPUT, 'phone-result.png'), (await win.webContents.capturePage()).toPNG());
    assert.match(await evaluate('return document.body.innerText;'), /SET HEADING TWO SEVEN ZERO/i);
    // Hidden windows need focus emulation for native keyboard defaults, as in
    // the full-app browser check. Pointer input still hits the rendered target.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const phoneSetupUrl = `${process.env.FF_MOBILE_VOICE_SETUP_URL}?setup=phone`;
    const desktopSetupUrl = `${process.env.FF_MOBILE_VOICE_SETUP_URL}?setup=desktop`;
    for (const width of [1200, 390, 320]) {
      win.setContentSize(width, 1000); await win.loadURL(phoneSetupUrl);
      await until('document.querySelector("[data-phone-voice-start]")');
      assert.equal(await evaluate('return !!window.electronAPI;'), false, 'phone setup has no desktop IPC authority');
      assert.equal(await evaluate('return !!document.querySelector("[data-phone-voice-step]");'), false, 'ordinary phone use does not require microphone setup');
      await activate('[data-phone-voice-start]'); await guideStep(1); await headingFocused();
      assert.equal(await evaluate('return document.querySelector("input[value=iphone]").checked;'), true);
      const download = await evaluate(`const response = await fetch(document.querySelector('[data-phone-voice-download]').href);
        return { type: response.headers.get('content-type'), bytes: (await response.arrayBuffer()).byteLength };`);
      assert.equal(download.type, 'application/x-x509-ca-cert'); assert(download.bytes > 500, 'the phone can download the actual PC certificate');
      await captureGuide(`setup-download-${width}`, '[data-mobile-voice-setup]');
      await activate('[data-phone-voice-next]'); await guideStep(2); await headingFocused();
      assert.match(await evaluate('return document.querySelector("[data-phone-voice-step]").textContent;'), /Certificate Trust Settings/);
      await captureGuide(`setup-iphone-install-${width}`);
      await captureGuide(`setup-iphone-trust-${width}`, '.voice-guide-trust');
      await activate('[data-phone-voice-next]', true); await guideStep(3); await headingFocused();
      await captureGuide(`setup-connect-${width}`);
      await activate('[data-phone-voice-back]'); await guideStep(2); await headingFocused();
      await activate('[data-phone-voice-back]'); await guideStep(1); await headingFocused();
      await activate('[data-phone-voice-returning]'); await guideStep(3); await headingFocused();
      await activate('input[value=android]'); await guideStep(1);
      assert.match(await evaluate('return document.querySelector("[data-phone-voice-step]").textContent;'), /Chrome/);
      await activate('[data-phone-voice-next]'); await guideStep(2); await headingFocused();
      assert.match(await evaluate('return document.querySelector("[data-phone-voice-step]").textContent;'), /CA certificate/);
      assert.equal(await evaluate('return !!document.querySelector(".voice-guide-trust");'), false, 'Android does not show the iOS trust switch');
      await captureGuide(`setup-android-install-${width}`);
      await activate('[data-phone-voice-next]'); await guideStep(3); await headingFocused();
      await activate('input[value=iphone]'); await guideStep(1);
      assert.equal(await evaluate('return document.activeElement.value;'), 'iphone', 'changing platform keeps focus on its radio');
      await activate('[data-phone-voice-close]');
      await until('document.activeElement === document.querySelector("[data-phone-voice-start]")');
    }
    // First-time setup connects through a button on the same phone, with no
    // query credentials or external redirect. Subsequent scans retain the guide
    // acknowledgement, but still need fresh secure control authorization.
    await activate('[data-phone-voice-start]'); await guideStep(1);
    await activate('[data-phone-voice-next]'); await guideStep(2);
    await activate('[data-phone-voice-next]'); await guideStep(3);
    await activate('[data-phone-voice-connect]');
    await until('location.protocol === "https:" && document.querySelector("[data-phone-voice-open]")');
    assert.equal(await evaluate('return location.hostname;'), '127.0.0.1');
    await evaluate('phoneVoiceTest.profiles.authorizationScope = "read-only";');
    await until('!document.querySelector("[data-phone-voice-open]")');
    assert.match(await evaluate('return document.body.innerText;'), /approve the matching code/);
    await win.loadURL(phoneSetupUrl); await until('document.querySelector("[data-phone-voice-start]")');
    assert.match(await evaluate('return document.querySelector("[data-phone-voice-start]").textContent;'), /Use microphone/);
    await activate('[data-phone-voice-start]'); await guideStep(3);
    await activate('[data-phone-voice-back]'); await guideStep(2);
    await activate('[data-phone-voice-close]');
    // A changed PC identity must not inherit a previous guide acknowledgement.
    await evaluate(`window.realPhoneFetch = window.fetch;
      window.fetch = async (...args) => { const response = await realPhoneFetch(...args);
        if (String(args[0]).endsWith('/api/mobile-voice')) return new Response(JSON.stringify({ ...await response.json(), fingerprint: 'changed-PC-identity' }));
        return response; };`);
    await activate('[data-phone-voice-start]'); await guideStep(1);
    await activate('[data-phone-voice-close]');
    await evaluate('window.fetch = realPhoneFetch;');
    // Closing and immediately reopening owns the newer request even if an old
    // fetch ignores cancellation and later succeeds or fails.
    for (const staleOutcome of ['success', 'failure']) {
      await evaluate(`window.fetch = (...args) => { window.fetch = realPhoneFetch;
        return new Promise((resolve, reject) => { window.finishRetiredLookup = () => ${staleOutcome === 'success'
          ? "resolve(new Response(JSON.stringify({ enabled: false })))" : "reject(new Error('retired lookup failure'))"}; }); };`);
      await activate('[data-phone-voice-start]');
      await until('window.finishRetiredLookup');
      await activate('[data-phone-voice-close]');
      await activate('[data-phone-voice-start]'); await guideStep(3);
      await evaluate('finishRetiredLookup(); window.finishRetiredLookup = null;'); await wait(70);
      await guideStep(3);
      assert.equal(await evaluate('return !!document.querySelector("[role=alert]");'), false, 'retired replies do not disturb the new setup');
      await activate('[data-phone-voice-close]');
    }
    // A platform change while a refresh is pending owns the instruction step.
    await evaluate(`window.fetch = (...args) => { window.fetch = realPhoneFetch;
      return new Promise(resolve => { window.finishPlatformLookup = async () => resolve(await realPhoneFetch(...args)); }); };`);
    await activate('[data-phone-voice-start]');
    await until('window.finishPlatformLookup');
    await activate('input[value=android]');
    await evaluate('await finishPlatformLookup();'); await guideStep(1);
    assert.equal(await evaluate('return document.querySelector("input[value=android]").checked;'), true);
    await activate('[data-phone-voice-close]');
    // Retired component replies cannot update a newly mounted guide either.
    await evaluate(`window.fetch = (...args) => { window.fetch = realPhoneFetch;
      return new Promise(resolve => { window.finishUnmountedLookup = () => resolve(new Response(JSON.stringify({ enabled: false }))); }); };`);
    await activate('[data-phone-voice-start]'); await until('window.finishUnmountedLookup');
    await evaluate('phoneVoiceTest.mount(false);'); await until('!document.querySelector("[data-mobile-voice-setup]")');
    await evaluate('finishUnmountedLookup(); phoneVoiceTest.mount(true);');
    await until('document.querySelector("[data-phone-voice-start]")');
    await activate('[data-phone-voice-start]'); await guideStep(3);
    await activate('[data-phone-voice-close]');
    // Bound an unresponsive status request and recover without remounting.
    await evaluate(`window.realPhoneTimeout = window.setTimeout;
      window.setTimeout = (fn, ms, ...args) => realPhoneTimeout(fn, ms === 15000 ? 40 : ms, ...args);
      window.fetch = () => new Promise(() => {});`);
    await activate('[data-phone-voice-start]');
    await until('document.querySelector("[role=alert]")?.textContent.includes("did not respond")');
    await evaluate('window.setTimeout = realPhoneTimeout; window.fetch = realPhoneFetch;');
    await activate('[data-phone-voice-retry]'); await guideStep(3);
    await activate('[data-phone-voice-close]');
    // Desktop opt-in stays explicit and failure leaves the retry available.
    await win.loadURL(desktopSetupUrl); await until('document.querySelector("[data-phone-voice-access]")?.textContent.includes("Turn off")');
    assert.match(await evaluate('return document.body.innerText;'), /Stays enabled after restarting FlightFabric/);
    assert.doesNotMatch(await evaluate('return document.body.innerText;'), /Enable access again|for this FlightFabric session/);
    assert.equal(await evaluate('return document.querySelectorAll("[role=img]").length;'), 0, 'desktop microphone controls have no additional QR');
    await evaluate(`const originalFetch = window.fetch;
      window.fetch = (...args) => { if (args[1]?.body === 'disable') {
        window.fetch = originalFetch;
        return Promise.resolve(new Response('{}', { status: 503 }));
      } return originalFetch(...args); };`);
    await activate('[data-phone-voice-access]');
    await until('document.querySelector("[role=alert]")');
    assert.equal(await evaluate('return !!document.querySelector("[data-phone-voice-desktop-next]");'), false, 'a failed change does not claim access is confirmed');
    await activate('[data-phone-voice-access]');
    await until('document.querySelector("[data-phone-voice-access]")?.textContent.includes("Enable")');
    await win.loadURL(phoneSetupUrl); await until('document.querySelector("[data-phone-voice-start]")');
    await activate('[data-phone-voice-start]');
    await until('document.querySelector("[data-phone-voice-retry]")');
    assert.match(await evaluate('return document.body.innerText;'), /On your PC, open Connect phone/);
    assert.equal(await evaluate('return !!document.querySelector("[data-phone-voice-connect]");'), false, 'disabled access cannot offer a dead microphone connection');
    await win.loadURL(desktopSetupUrl); await until('document.querySelector("[data-phone-voice-access]")?.textContent.includes("Enable")');
    await evaluate(`const originalFetch = window.fetch;
      window.fetch = (...args) => { if (args[1]?.body === 'enable') {
        window.fetch = originalFetch;
        return Promise.resolve(new Response('{}', { status: 503 }));
      } return originalFetch(...args); };`);
    await activate('[data-phone-voice-access]');
    await until('document.querySelector("[role=alert]")');
    assert.equal(await evaluate('return !!document.querySelector("[data-phone-voice-desktop-next]");'), false, 'failed enable leaves the user on desktop with retry, not a dead phone handoff');
    await activate('[data-phone-voice-access]');
    await until('document.querySelector("[data-phone-voice-access]")?.textContent.includes("Turn off")');
    assert.match(await evaluate('return document.querySelector("[data-phone-voice-desktop-next]").textContent;'), /Access enabled\. Continue on your phone\./);
    await win.loadURL(phoneSetupUrl); await until('document.querySelector("[data-phone-voice-start]")');
    await activate('[data-phone-voice-start]'); await guideStep(3);
    console.log('Native browser: one-QR phone onboarding at 320/390/1200px; direct certificate download, iPhone/Android guides, native focus, HTTP-to-HTTPS navigation, returning/changed-PC setup, stale replies, timeout/retry, and desktop disable/re-enable passed. Real microphone worklet and heading recognition passed.');
  } finally { win.destroy(); app.quit(); }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const { createViteTestServer } = require('./vite-test-server');
  const { default: vue } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs')).href);
  const { createMobileVoiceService } = require('../../dist/backend/core/mobile-voice');
  const { loadMobileVoiceIdentity } = require('../../dist/backend/core/mobile-voice-identity');
  const { createDevicePairingManager } = require('../../dist/backend/core/device-pairing');
  const { createVoiceSpeechEngine } = require('../../electron/voice-speech-engine');
  const { readWave } = require('../../electron/node_modules/sherpa-onnx-node');
  const wav = readWave(path.join(ROOT, 'tests/fixtures/voice/heading-270-david.wav'));
  const frames = wav.sampleRate + wav.samples.length, audio = Buffer.alloc(44 + frames * 2);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(wav.sampleRate, 24); audio.writeUInt32LE(wav.sampleRate * 2, 28); audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < wav.samples.length; i++) audio.writeInt16LE(Math.round(Math.max(-1, Math.min(1, wav.samples[i])) * 32767), 44 + (wav.sampleRate + i) * 2);
  fs.writeFileSync(path.join(OUTPUT, 'heading.wav'), audio);
  let service, leaf, httpPort;
  const token = 'mobile-voice-browser-fixture';
  const vite = await createViteTestServer({ configFile: false, root: ROOT, logLevel: 'error', cacheDir: path.join(OUTPUT, 'vite-cache'),
    optimizeDeps: { entries: ['tests/fixtures/mobile-voice-browser.js'] }, plugins: [vue(), { name: 'mobile-voice-fixture', configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (service?.handleHttp(req, res)) return;
        if (req.url === '/phone') { res.writeHead(302, { Location: '/tests/fixtures/mobile-voice-browser.html?setup=phone' }); res.end(); return; }
        if (req.url === '/voice-tailwind.css') { res.setHeader('Content-Type', 'text/css'); res.end(fs.readFileSync(path.join(ROOT, 'frontend-dist/tailwind.css'))); return; }
        if (req.url === '/mobile-voice-fixture') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ token, httpPort })); return; }
        next();
      });
    } }], resolve: { alias: { vue: path.join(ROOT, 'frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'), pinia: path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs') } },
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } });
  await vite.listen(); httpPort = vite.httpServer.address().port;
  const pairing = createDevicePairingManager();
  const request = pairing.createRequest('127.0.0.1').request;
  pairing.approveRequest(request.id, request.confirmationCode);
  const paired = pairing.claimApprovedRequest(request.id, '127.0.0.1');
  service = createMobileVoiceService({ httpServer: vite.httpServer, port: 0, ips: ['127.0.0.1'], token, pairing,
    directory: path.join(OUTPUT, 'identity'), upgradeTelemetry: (_req, socket) => socket.destroy(),
    identityLoader: async (...args) => { leaf = await loadMobileVoiceIdentity(...args); return leaf; } });
  const speech = createVoiceSpeechEngine(); let controller, host;
  const commands = [];
  try {
    const response = await fetch(`http://127.0.0.1:${httpPort}/api/mobile-voice`, { method: 'POST', headers: { 'X-FlightFabric-Token': token }, body: 'enable' });
    assert.equal(response.status, 200); await speech.initialize();
    const { createPinia, setActivePinia } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs')).href);
    setActivePinia(createPinia());
    const { useVoiceControlStore } = await import(pathToFileURL(path.join(ROOT, 'frontend/src/vue/stores/voice-control.js')).href);
    const { createVoiceControlController } = await import(pathToFileURL(path.join(ROOT, 'frontend/src/voice/voice-controller.js')).href);
    const { createMobileVoiceHost } = await import(pathToFileURL(path.join(ROOT, 'frontend/src/voice/mobile-voice-host.js')).href);
    const voiceStore = useVoiceControlStore();
    const command = { id: 'flightGuidance.heading.set', label: 'Selected heading', input: { kind: 'number', min: 0, max: 359, step: 1 }, speech: { patterns: ['set heading {value}'] } };
    controller = createVoiceControlController({ voiceStore, globalRef: {}, readback: { cancel() {}, speak() {} }, pushToTalkTone: { async play() {} },
      aircraftControlsStore: { availability: { enabled: true }, aircraftCommandCatalogue: { configurationId: 'generic', profileKey: 'test/generic', profileRevision: 1, commands: { [command.id]: command } } },
      aircraftControl: { sendCommand(commandId, input, options) {
        assert.equal(service.authorizeDispatch(options.mobileVoiceSessionId), true);
        commands.push({ commandId, input }); options.onResult({ ok: true }); return true;
      } },
      api: { getRuntimeInfo: async () => ({ available: true, enabled: true, mode: 'offline' }),
        onRecognitionEvent: fn => speech.onEvent(fn), onPushToTalk: () => () => {}, onRuntimeState: () => () => {},
        startRecognition: async () => speech.start(), finishRecognition: async id => ({ finishing: speech.finish(id) }),
        cancelRecognition: async id => ({ cancelled: speech.cancel(id) }), sendAudio: payload => speech.pushAudio({ ...payload, samples: new Float32Array(payload.samples) }),
      } });
    await controller.initialize();
    host = createMobileVoiceHost({ controller, voiceStore, getHttpBase: () => `http://127.0.0.1:${httpPort}`,
      globalRef: { fetch, WebSocket: require('ws'), electronAPI: { getBackendBootstrap: async () => ({ body: { wsAuthToken: token } }) } } });
    await host.connect();
    for (let attempt = 0; attempt < 100 && !service.status().available; attempt++) await wait(20);
    assert.equal(service.status().available, true, 'desktop voice adapter connected');
    const env = { ...process.env, FF_MOBILE_VOICE_URL: `https://127.0.0.1:${service.status().port}/tests/fixtures/mobile-voice-browser.html`,
      FF_MOBILE_VOICE_SETUP_URL: `http://127.0.0.1:${httpPort}/tests/fixtures/mobile-voice-browser.html`,
      FF_MOBILE_VOICE_PAIR: paired, FF_MOBILE_VOICE_FINGERPRINT: new (require('node:crypto').X509Certificate)(leaf.cert).fingerprint256 };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { env, cwd: ROOT, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill(), 60000);
    const [code] = await once(child, 'exit'); clearTimeout(timer);
    assert.equal(code, 0);
    assert.deepEqual(commands, [{ commandId: 'flightGuidance.heading.set', input: { value: 270 } }]);
    console.log('Actual Zipformer worker and PC controller dispatched exactly one session-authorized heading command; no PC microphone was acquired.');
  } finally { host?.dispose(); await controller?.dispose(); await speech.shutdown(); await service.dispose(); await vite.close(); }
}
(process.versions.electron ? browser() : main()).catch(error => { console.error(error); process.exitCode = 1; if (process.versions.electron) require('electron').app.exit(1); });
