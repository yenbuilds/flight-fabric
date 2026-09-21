#!/usr/bin/env node
'use strict';

// A native-window probe with its own Chromium profile. It never loads the app,
// starts the backend, changes real settings, or gives its test windows focus.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');

async function runElectronProbe() {
  const { app, BrowserWindow, Menu, screen } = require('electron');
  const { restoreMainWindowState } = require('../../electron/main-window-bounds');
  const { trackMainWindowState, setAutotaxiBackgroundActivity } = require('../../electron/main-window-state');
  const { createDesktopMenuTemplate } = require('../../electron/desktop-menu');
  const resultPath = process.env.FF_WINDOW_RUNTIME_RESULT;
  const windows = [];
  const transitions = [];
  let controller;
  app.setPath('userData', path.join(path.dirname(resultPath), 'profile'));
  app.disableHardwareAcceleration();
  // The probe intentionally destroys and recreates its only native window.
  app.on('window-all-closed', () => {});
  const waitFor = async (check, description) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out: ${description}`);
  };
  try {
    await app.whenReady();
    assert.ok(screen.getAllDisplays().length > 0, 'Native probe requires access to the desktop display');
    const { createDesktopWindowStateStore } = require('../../electron/settings-store');
    const store = createDesktopWindowStateStore({ stateFile: path.join(path.dirname(resultPath), 'window-state.json') });
    const restore = (state) => restoreMainWindowState(state, screen.getAllDisplays(), screen.getPrimaryDisplay());
    const initial = restore(null);
    const options = {
      ...initial.windowOptions,
      show: false, opacity: 0, focusable: false, skipTaskbar: true, autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    };
    let window = new BrowserWindow(options);
    windows.push(window);
    setAutotaxiBackgroundActivity(window.webContents, true);
    await window.loadURL('data:text/html,<title>Autotaxi background heartbeat probe</title>');
    await window.webContents.executeJavaScript(`window.taxiHeartbeats = []; window.taxiTimer = setInterval(() => taxiHeartbeats.push(performance.now()), 250);`);
    await new Promise(resolve => setTimeout(resolve, 3500));
    const heartbeats = await window.webContents.executeJavaScript('clearInterval(taxiTimer); taxiHeartbeats');
    assert.ok(heartbeats.length >= 10, `Hidden desktop heartbeat ran only ${heartbeats.length} times`);
    assert.ok(heartbeats.slice(1).every((time, i) => time - heartbeats[i] < 3000), 'hidden desktop must not lose its three-second owner lease');
    assert.equal(window.isFocused(), false, 'heartbeat does not require foreground focus');
    setAutotaxiBackgroundActivity(window.webContents, false);
    assert.equal(window.webContents.getBackgroundThrottling(), true, 'normal background power saving is restored');
    controller = trackMainWindowState({ window, screen, store, initialState: initial, delay: 20 });
    const moved = { ...initial.bounds, x: initial.bounds.x + 5, y: initial.bounds.y + 5 };
    window.setBounds(moved);
    await waitFor(() => window.getNormalBounds().x === moved.x, 'native move');
    controller.save();
    assert.deepEqual(store.read().bounds, window.getNormalBounds());
    assert.equal(store.read().maximized, false);

    window.maximize();
    await waitFor(() => window.isMaximized(), 'native maximize');
    window.hide();
    controller.save();
    assert.equal(store.read().maximized, true);
    const normal = store.read().bounds;
    const closeTo = (actual, expected) => {
      // Windows rounds native-frame edges to physical pixels at fractional DPI.
      for (const key of ['x', 'y', 'width', 'height']) {
        assert.ok(Math.abs(actual[key] - expected[key]) <= 2, `${key}: ${actual[key]} vs ${expected[key]}`);
      }
    };
    closeTo(normal, moved);
    controller.dispose();
    window.destroy();

    const restored = restore(store.read());
    window = new BrowserWindow({ ...options, ...restored.windowOptions });
    windows.push(window);
    window.setBounds(restored.bounds);
    if (restored.maximized) window.maximize();
    await waitFor(() => window.isMaximized(), 'restored maximize');
    window.hide();
    controller = trackMainWindowState({ window, screen, store, initialState: restored, delay: 20 });
    for (const event of ['enter-full-screen', 'leave-full-screen', 'maximize', 'unmaximize', 'resize', 'move']) {
      window.on(event, () => transitions.push({ event, maximized: window.isMaximized(), fullscreen: window.isFullScreen(), bounds: window.getNormalBounds() }));
    }
    closeTo(window.getNormalBounds(), normal);
    window.unmaximize();
    await waitFor(() => !window.isMaximized(), 'native unmaximize');
    controller.save();
    assert.equal(store.read().maximized, false);
    closeTo(store.read().bounds, normal);

    window.maximize();
    await waitFor(() => window.isMaximized(), 'maximize before fullscreen');
    controller.save();
    const enteredFullscreen = new Promise(resolve => window.once('enter-full-screen', resolve));
    window.setFullScreen(true);
    await enteredFullscreen;
    controller.save();
    assert.equal(store.read().maximized, true, 'transient fullscreen retains maximized preference');
    closeTo(store.read().bounds, normal);
    const leftFullscreen = new Promise(resolve => window.once('leave-full-screen', resolve));
    controller.resetPlacement();
    await leftFullscreen;
    await waitFor(() => !window.isFullScreen() && !window.isMaximized()
      && Math.abs(store.read().bounds.x - initial.bounds.x) <= 2,
    'reset exits fullscreen into centered normal placement');
    controller.save();
    assert.equal(store.read().maximized, false);
    closeTo(store.read().bounds, initial.bounds);

    const template = createDesktopMenuTemplate({ hasTray: true, isDev: false });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    assert.equal(Menu.getApplicationMenu().items.length, 5);
    assert.equal(window.isMenuBarAutoHide(), true);
    assert.equal(window.isFocused(), false);
    fs.writeFileSync(resultPath, JSON.stringify({ ok: true, electron: process.versions.electron, normal }));
  } catch (error) {
    fs.writeFileSync(resultPath, JSON.stringify({ ok: false, error: error.stack, displays: screen.getAllDisplays(), transitions }));
    process.exitCode = 1;
  } finally {
    controller?.dispose();
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    app.exit(process.exitCode || 0);
  }
}

function runParentProbe() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'flightfabric-window-runtime-'));
  const resultPath = path.join(temporary, 'result.json');
  const executable = require(path.join(ROOT, 'electron/node_modules/electron'));
  const environment = { ...process.env, FF_WINDOW_RUNTIME_RESULT: resultPath };
  delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(executable, [__filename], {
      cwd: path.dirname(executable), env: environment,
      windowsHide: true, encoding: 'utf8', timeout: 20000,
    });
    if (result.error) throw result.error;
    assert.ok(fs.existsSync(resultPath), `No native window probe result (exit ${result.status}): ${result.stderr}`);
    const payload = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.equal(payload.ok, true, `${payload.error}\nDisplays: ${JSON.stringify(payload.displays)}\nTransitions: ${JSON.stringify(payload.transitions)}`);
    assert.equal(result.status, 0, result.stderr);
    console.log(`Electron ${payload.electron}: hidden Autotaxi heartbeat, native bounds, maximize/reopen, unmaximize, fullscreen/reset, and hidden application menu passed.`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (process.versions.electron) void runElectronProbe();
else runParentProbe();
