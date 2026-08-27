#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');

function resolveElectronExecutable() {
  try {
    return require(path.join(ROOT, 'electron', 'node_modules', 'electron'));
  } catch (err) {
    throw new Error(`Could not resolve Electron. Run npm install in electron/. ${err.message}`);
  }
}

async function runElectronProbe() {
  const { app, BrowserWindow, ipcMain, session } = require('electron');
  const { isTrustedIpcSender } = require(path.join(ROOT, 'electron', 'ipc-sender-policy'));
  const { installSessionPermissionPolicy } = require(path.join(ROOT, 'electron', 'session-permission-policy'));
  const resultPath = process.env.FF_IPC_RUNTIME_RESULT;
  const launcherHtmlPath = process.env.FF_IPC_RUNTIME_LAUNCHER;
  const windows = [];
  let server = null;

  const writeResult = (payload) => {
    fs.writeFileSync(resultPath, JSON.stringify(payload), 'utf8');
  };

  try {
    app.setPath('userData', path.join(path.dirname(resultPath), 'user-data'));
    await app.whenReady();

    server = http.createServer((request, response) => {
      const headers = {
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self' blob:",
      };
      if (request.url === '/frontend/assets/pcm-worklet.js') {
        response.writeHead(200, {
          ...headers,
          'Content-Type': 'application/javascript; charset=utf-8',
        });
        response.end(fs.readFileSync(path.join(ROOT, 'frontend-dist', 'assets', 'pcm-worklet.js')));
        return;
      }
      response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><title>${request.url === '/frontend/' ? 'Frontend' : 'Outside'} IPC probe</title>`);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const trustedUrl = `http://127.0.0.1:${port}/frontend/`;
    const outsideUrl = `http://127.0.0.1:${port}/outside-app`;
    const isFrontendAppUrl = (rawUrl) => rawUrl === trustedUrl;

    const windowOptions = {
      show: false,
      webPreferences: {
        preload: path.join(ROOT, 'electron', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    };
    const trustedWindow = new BrowserWindow(windowOptions);
    windows.push(trustedWindow);
    const decisions = [];
    const permissionDecisions = [];
    let audioCaptureAuthorized = false;

    installSessionPermissionPolicy({
      electronSession: session.defaultSession,
      getMainWebContents: () => trustedWindow.webContents,
      isFrontendAppUrl,
      launcherHtmlPath,
      isAudioCaptureAuthorized: (webContents) => (
        audioCaptureAuthorized && webContents === trustedWindow.webContents
      ),
      onDecision: (decision) => permissionDecisions.push(decision),
    });

    ipcMain.handle('settings-get', (event) => {
      const trusted = isTrustedIpcSender({
        event,
        mainWebContents: trustedWindow.webContents,
        isFrontendAppUrl,
        launcherHtmlPath,
      });
      decisions.push({
        trusted,
        url: event.senderFrame?.url || null,
        mainFrame: event.senderFrame === event.sender?.mainFrame,
      });
      if (!trusted) throw new Error('Untrusted Electron IPC sender');
      return { runtimeProbe: true };
    });
    ipcMain.handle('backend-logs', () => []);
    ipcMain.handle('backend-status', () => ({ status: 'stopped' }));
    ipcMain.handle('http-status', () => ({ status: 'running', port }));

    const invokeSettings = (frame) => frame.executeJavaScript('window.electronAPI.getSettings()');
    const expectRejectedDecision = async (frame) => {
      const before = decisions.length;
      await assert.rejects(() => invokeSettings(frame));
      assert.equal(decisions.length, before + 1, 'rejected invocation must reach the IPC policy');
      assert.equal(decisions.at(-1).trusted, false);
    };
    const queryPermission = (frame, name) => frame.executeJavaScript(
      `navigator.permissions.query({ name: ${JSON.stringify(name)} }).then((result) => result.state)`,
    );

    await trustedWindow.loadURL(trustedUrl);
    assert.equal(
      await trustedWindow.webContents.executeJavaScript(
        "typeof window.electronAPI?.getBackendWsPort === 'function'",
      ),
      true,
      'the sandboxed host renderer must expose the cabin-playback preload capability',
    );
    assert.deepEqual(await invokeSettings(trustedWindow.webContents), { runtimeProbe: true });
    assert.equal(decisions.at(-1).trusted, true);
    assert.equal(decisions.at(-1).mainFrame, true);
    assert.equal(await queryPermission(trustedWindow.webContents, 'clipboard-write'), 'granted');
    assert.equal(await queryPermission(trustedWindow.webContents, 'microphone'), 'denied');
    audioCaptureAuthorized = true;
    assert.equal(await queryPermission(trustedWindow.webContents, 'microphone'), 'granted');
    const microphoneProbe = await trustedWindow.webContents.executeJavaScript(`(async () => {
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const inputs = (await navigator.mediaDevices.enumerateDevices())
          .filter((device) => device.kind === 'audioinput')
          .map((device) => ({ deviceId: device.deviceId, label: device.label }));
        return { opened: true, inputs };
      } catch (error) {
        return { opened: false, error: error?.message || String(error) };
      } finally {
        for (const track of stream?.getTracks?.() || []) track.stop();
      }
    })()`);
    assert.equal(
      microphoneProbe.opened,
      true,
      `an authorized microphone probe must open: ${microphoneProbe.error || 'unknown error'}`,
    );
    assert.ok(
      microphoneProbe.inputs.some((device) => device.deviceId && device.label),
      'an authorized microphone probe must expose a named audio input',
    );
    audioCaptureAuthorized = false;
    assert.equal(await queryPermission(trustedWindow.webContents, 'microphone'), 'denied');
    assert.equal(await queryPermission(trustedWindow.webContents, 'geolocation'), 'denied');
    assert.equal(
      await trustedWindow.webContents.executeJavaScript(
        'navigator.mediaDevices.enumerateDevices().then((devices) => Array.isArray(devices))',
      ),
      true,
      'idle device enumeration should remain available without opening the microphone',
    );
    const workletProbe = await trustedWindow.webContents.executeJavaScript(`(async () => {
      const context = new AudioContext({ latencyHint: 'interactive' });
      try {
        await context.audioWorklet.addModule('/frontend/assets/pcm-worklet.js');
        const node = new AudioWorkletNode(context, 'flight-fabric-pcm-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { chunkFrames: 2048 },
        });
        node.port.postMessage({ type: 'cancel' });
        node.disconnect();
        return { loaded: true, sampleRate: context.sampleRate };
      } finally {
        await context.close();
      }
    })()`);
    assert.equal(workletProbe.loaded, true);
    assert.ok(workletProbe.sampleRate >= 8000 && workletProbe.sampleRate <= 192000);
    const geolocationRequest = await trustedWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        () => resolve({ granted: true }),
        (error) => resolve({ granted: false, code: error.code }),
        { timeout: 1000 },
      );
    })`);
    assert.deepEqual(geolocationRequest, { granted: false, code: 1 });

    const otherWindow = new BrowserWindow(windowOptions);
    windows.push(otherWindow);
    await otherWindow.loadURL(trustedUrl);
    await expectRejectedDecision(otherWindow.webContents);
    assert.equal(await queryPermission(otherWindow.webContents, 'clipboard-write'), 'denied');

    const browserLikeWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    windows.push(browserLikeWindow);
    await browserLikeWindow.loadURL(trustedUrl);
    assert.equal(
      await browserLikeWindow.webContents.executeJavaScript(
        "typeof window.electronAPI?.getBackendWsPort === 'function'",
      ),
      false,
      'a renderer without the Electron preload must not qualify for cabin playback',
    );

    await trustedWindow.loadURL(outsideUrl);
    await expectRejectedDecision(trustedWindow.webContents);
    assert.equal(await queryPermission(trustedWindow.webContents, 'clipboard-write'), 'denied');

    await trustedWindow.loadURL(pathToFileURL(launcherHtmlPath).href);
    assert.deepEqual(await invokeSettings(trustedWindow.webContents), { runtimeProbe: true });
    assert.equal(decisions.at(-1).trusted, true);
    assert.equal(await queryPermission(trustedWindow.webContents, 'clipboard-write'), 'granted');
    assert.equal(await queryPermission(trustedWindow.webContents, 'microphone'), 'denied');
    const launcherCopyResult = await trustedWindow.webContents.executeJavaScript(`(async () => {
      window.__launcherClipboardWrites = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => { window.__launcherClipboardWrites.push(text); },
        },
      });
      _remoteUrl = 'http://192.168.1.10:8100/';
      copyRemoteUrl();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        writes: window.__launcherClipboardWrites,
        label: document.getElementById('remote-copy-btn')?.textContent || '',
      };
    })()`);
    assert.deepEqual(launcherCopyResult.writes, ['http://192.168.1.10:8100/']);
    assert.match(launcherCopyResult.label, /Copied!/);

    await trustedWindow.loadURL(`${pathToFileURL(launcherHtmlPath).href}?unexpected=1`);
    await expectRejectedDecision(trustedWindow.webContents);
    assert.equal(await queryPermission(trustedWindow.webContents, 'clipboard-write'), 'denied');

    writeResult({
      ok: true,
      electron: process.versions.electron,
      decisions,
      permissionDecisions,
      launcherCopyResult,
      workletProbe,
      microphoneProbe,
    });
  } catch (err) {
    writeResult({
      ok: false,
      error: err?.stack || String(err),
    });
    process.exitCode = 1;
  } finally {
    for (const channel of ['settings-get', 'backend-logs', 'backend-status', 'http-status']) {
      ipcMain.removeHandler(channel);
    }
    for (const window of windows) {
      if (!window.isDestroyed()) window.destroy();
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    app.quit();
  }
}

function runParentProbe() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-electron-ipc-'));
  const resultPath = path.join(tmpDir, 'result.json');
  const launcherHtmlPath = path.join(ROOT, 'electron', 'launcher', 'index.html');

  try {
    const env = {
      ...process.env,
      FF_IPC_RUNTIME_RESULT: resultPath,
      FF_IPC_RUNTIME_LAUNCHER: launcherHtmlPath,
    };
    delete env.ELECTRON_RUN_AS_NODE;

    const electronExecutable = resolveElectronExecutable();
    // The probe exercises WebContents/WebFrameMain identity and URL routing. The
    // production sandbox setting is covered separately; disabling the OS sandbox
    // here lets this hidden renderer run inside sandboxed CI/agent environments.
    const result = childProcess.spawnSync(electronExecutable, [
      '--in-process-gpu',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-gpu-sandbox',
      '--no-sandbox',
      '--use-fake-device-for-media-stream',
      __filename,
    ], {
      cwd: path.dirname(electronExecutable),
      env,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });

    if (result.error) throw result.error;
    if (!fs.existsSync(resultPath)) {
      throw new Error(
        `Electron IPC probe did not write a result (exit ${result.status}).\n`
        + `STDOUT:\n${result.stdout || ''}\nSTDERR:\n${result.stderr || ''}`,
      );
    }

    const payload = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.equal(
      payload.ok,
      true,
      `${payload.error || 'Electron IPC runtime probe failed'}\nSTDOUT:\n${result.stdout || ''}\nSTDERR:\n${result.stderr || ''}`,
    );
    assert.ok(payload.decisions.length >= 5, 'runtime probe should record every explicit sender decision');
    assert.ok(
      payload.decisions.filter((decision) => decision.trusted).length >= 2,
      'runtime probe should accept the Vue app and launcher main frames',
    );
    assert.ok(
      payload.decisions.filter((decision) => !decision.trusted).length >= 3,
      'runtime probe should reject a foreign window, untrusted page, and altered launcher URL',
    );
    assert.equal(
      payload.permissionDecisions.every((decision) => (
        !decision.granted
        || decision.permission === 'clipboard-sanitized-write'
        || (
          decision.permission === 'media'
          && decision.isMainFrame === true
          && /\/frontend\/$/.test(decision.requestingUrl || '')
          && (decision.mediaType === 'audio'
            || (Array.isArray(decision.mediaTypes)
              && decision.mediaTypes.length === 1
              && decision.mediaTypes[0] === 'audio'))
        )
      )),
      true,
      'only trusted clipboard writes and trusted frontend audio may be granted',
    );
    assert.ok(
      payload.permissionDecisions.some((decision) => decision.granted && decision.permission === 'media'),
      'the trusted frontend microphone permission check should be granted while capture is authorized',
    );
    assert.ok(
      payload.permissionDecisions.some((decision) => (
        decision.granted
        && decision.permission === 'media'
        && decision.phase === 'request'
        && Array.isArray(decision.mediaTypes)
        && decision.mediaTypes.length === 1
        && decision.mediaTypes[0] === 'audio'
      )),
      'the authorized microphone probe should reach the trusted audio request handler',
    );
    assert.ok(
      payload.permissionDecisions.some((decision) => !decision.granted && decision.permission === 'media'),
      'the trusted frontend microphone permission check should be denied while capture is idle',
    );
    assert.ok(
      payload.permissionDecisions.some((decision) => (
        decision.phase === 'request' && decision.permission === 'geolocation' && !decision.granted
      )),
      'a real geolocation permission request should reach the request handler and be denied',
    );
    const clipboardDecisions = payload.permissionDecisions.filter(
      (decision) => decision.permission === 'clipboard-sanitized-write',
    );
    assert.ok(
      clipboardDecisions.filter((decision) => decision.granted).length >= 2,
      'trusted Vue and launcher clipboard checks should be granted',
    );
    assert.ok(
      clipboardDecisions.filter((decision) => !decision.granted).length >= 3,
      'foreign and untrusted clipboard checks should be denied',
    );
    assert.deepEqual(payload.launcherCopyResult.writes, ['http://192.168.1.10:8100/']);
    assert.equal(payload.workletProbe.loaded, true, 'the production PCM AudioWorklet should load under CSP');
    assert.equal(payload.microphoneProbe.opened, true, 'the authorized microphone probe should open');
    assert.ok(
      payload.microphoneProbe.inputs.some((device) => device.deviceId && device.label),
      'the authorized microphone probe should reveal a named input',
    );
    assert.ok(payload.electron, 'probe should report its Electron version');

    console.log('Electron IPC and session permission runtime probe passed');
    console.log(`Electron ${payload.electron}; sender routing, permission denial, and launcher copy verified`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (process.versions.electron) {
  void runElectronProbe();
} else {
  runParentProbe();
}
