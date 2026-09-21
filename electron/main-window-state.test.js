'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeWindowState, restoreMainWindowState } = require('./main-window-bounds');
const { trackMainWindowState, showMainWindow, setAutotaxiBackgroundActivity } = require('./main-window-state');
const { createDesktopWindowStateStore } = require('./settings-store');

test('Autotaxi background activity enables timers without changing focus and restores throttling', () => {
  const calls = [];
  const contents = { isDestroyed: () => false, setBackgroundThrottling: value => calls.push(value) };
  assert.deepEqual(setAutotaxiBackgroundActivity(contents, true), { ok: true });
  assert.deepEqual(setAutotaxiBackgroundActivity(contents, false), { ok: true });
  for (const invalid of [1, 'true', null, {}]) assert.throws(() => setAutotaxiBackgroundActivity(contents, invalid), /Invalid/);
  assert.deepEqual(calls, [false, true]);
  assert.deepEqual(setAutotaxiBackgroundActivity({ isDestroyed: () => true }, true), { ok: false });
});
const { createDesktopMenuTemplate } = require('./desktop-menu');

const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 };
const secondary = { id: 2, workArea: { x: -2560, y: -200, width: 2560, height: 1400 }, scaleFactor: 1.5 };
const normalBounds = { x: -2360, y: -100, width: 1100, height: 900 };
const saved = (bounds = normalBounds, display = secondary, maximized = false) => ({
  version: 1, bounds, maximized, display: { id: display.id, workArea: display.workArea },
});
const restore = (state, displays = [primary, secondary]) => restoreMainWindowState(state, displays, primary);
const assertContained = (bounds, area) => {
  assert.ok(bounds.x >= area.x && bounds.y >= area.y);
  assert.ok(bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y + bounds.height <= area.y + area.height);
};

test('first launch keeps the established centered defaults', () => {
  assert.deepEqual(restore(null).windowOptions, {
    x: 370, y: 40, width: 1180, height: 960, minWidth: 760, minHeight: 520,
  });
});

test('a temporary absence of displays does not abort startup', () => {
  const state = restoreMainWindowState(saved(), [], null);
  assertContained(state.bounds, state.display.workArea);
  assert.equal(state.display.id, -1);
});

test('restores normal bounds, monitor and maximized state without double-scaling DIPs', () => {
  const result = restore(saved(normalBounds, secondary, true));
  assert.deepEqual(result.bounds, normalBounds);
  assert.equal(result.display.id, secondary.id);
  assert.equal(result.maximized, true);
  assert.equal(result.windowOptions.width, 1100);
});

test('same monitor moved to the other side retains the relative window position', () => {
  const moved = { ...secondary, workArea: { ...secondary.workArea, x: 1920, y: 100 } };
  const result = restore(saved(), [primary, moved]);
  assert.deepEqual(result.bounds, { ...normalBounds, x: 2120, y: 200 });
});

test('changed scaling or rotated small display keeps the complete native frame reachable', () => {
  const scaled = { ...secondary, scaleFactor: 2, workArea: { x: -900, y: 0, width: 900, height: 700 } };
  const result = restore(saved(), [primary, scaled]);
  assertContained(result.bounds, scaled.workArea);
  assert.equal(result.bounds.width, 900);
  assert.equal(result.bounds.height, 700);
  assert.equal(result.windowOptions.minWidth, 760);
  assert.equal(result.windowOptions.minHeight, 520);
});

test('missing monitor recovers centered on primary and preserves maximized preference', () => {
  const result = restore(saved(normalBounds, secondary, true), [primary]);
  assert.deepEqual(result.bounds, { x: 410, y: 70, width: 1100, height: 900 });
  assert.equal(result.maximized, true);
  assert.equal(result.display.id, primary.id);
});

test('display ID changes retain visible placement and invalid monitor metadata is optional', () => {
  for (const display of [null, { id: '2', workArea: secondary.workArea }]) {
    assert.deepEqual(restore({ ...saved(), display }).bounds, normalBounds);
  }
  assert.deepEqual(restore(saved(), [primary, { ...secondary, id: 3 }]).bounds, normalBounds);
});

test('offscreen, oversized and undersized windows recover within taskbar-adjusted work areas', () => {
  for (const area of [
    { x: 64, y: 48, width: 1216, height: 672 },
    { x: -800, y: -400, width: 640, height: 400 },
    { x: 0, y: 0, width: 30, height: 30 },
  ]) {
    const display = { id: 3, workArea: area };
    for (const bounds of [
      { x: 30000, y: -20000, width: 8000, height: 6000 },
      { x: area.x - 20, y: area.y - 100, width: 100, height: 100 },
    ]) {
      const result = restore(saved(bounds), [display]);
      assertContained(result.bounds, area);
      assert.ok(result.windowOptions.minWidth <= result.bounds.width);
      assert.ok(result.windowOptions.minHeight <= result.bounds.height);
    }
  }
});

test('malformed or unknown saved state safely uses first-launch defaults', () => {
  for (const value of [null, [], {}, { ...saved(), version: 2 },
    ...[NaN, Infinity, '800', -1, 0, 1e30].map((width) => ({ ...saved(), bounds: { ...normalBounds, width } })),
  ]) {
    assert.equal(normalizeWindowState(value), null);
    assert.deepEqual(restore(value).bounds, restore(null).bounds);
  }
  assert.equal(restore({ ...saved(), maximized: 'yes' }).maximized, false);
});

function createFixture(initial = restore(saved())) {
  const pending = new Map();
  let timerId = 0;
  const timers = {
    setTimeout(callback) { const id = ++timerId; pending.set(id, callback); return id; },
    clearTimeout(id) { pending.delete(id); },
    flush() { for (const [id, callback] of [...pending]) { pending.delete(id); callback(); } },
  };
  const window = new EventEmitter();
  const calls = [];
  let bounds = { ...initial.bounds };
  let maximized = initial.maximized;
  let minimized = false;
  let fullscreen = false;
  let destroyed = false;
  Object.assign(window, {
    getNormalBounds: () => ({ ...bounds }),
    isDestroyed: () => destroyed,
    isMaximized: () => maximized,
    isMinimized: () => minimized,
    isFullScreen: () => fullscreen,
    setMinimumSize: (...dimensions) => calls.push(['minimum', ...dimensions]),
    setBounds(next) { calls.push(['bounds', next]); bounds = next; window.emit('resize'); },
    show: () => calls.push(['show']),
    focus: () => calls.push(['focus']),
    restore() { calls.push(['restore']); minimized = false; window.emit('restore'); },
    moveTo(next) { bounds = next; window.emit('move'); },
    maximize() { maximized = true; window.emit('maximize'); },
    unmaximize() { maximized = false; window.emit('unmaximize'); },
    minimize() { minimized = true; maximized = false; window.emit('minimize'); },
    fullscreen() { fullscreen = true; maximized = false; window.emit('enter-full-screen'); },
    setFullScreen(value) { calls.push(['fullscreen', value]); },
    leaveFullscreen() { fullscreen = false; window.emit('leave-full-screen'); },
    destroy() { destroyed = true; window.emit('closed'); },
  });
  const screen = new EventEmitter();
  let displays = [primary, secondary];
  Object.assign(screen, {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => primary,
    removeSecondary() { displays = [primary]; screen.emit('display-removed', {}, secondary); },
    removeAll() { displays = []; screen.emit('display-removed', {}, primary); },
    reconnect() { displays = [primary, secondary]; screen.emit('display-added', {}, secondary); },
  });
  const writes = [];
  const controller = trackMainWindowState({ window, screen, initialState: initial, timers,
    store: { save: (value) => writes.push(structuredClone(value)) } });
  return { window, screen, controller, timers, writes, calls, pending };
}

test('drag and resize events debounce persistence; close/hide and explicit shutdown save flush immediately', () => {
  const fixture = createFixture();
  const { window, controller, timers, writes, pending } = fixture;
  window.moveTo({ ...normalBounds, x: -2200 });
  window.moveTo({ ...normalBounds, x: -2100 });
  assert.equal(writes.length, 0);
  assert.equal(pending.size, 1);
  timers.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].bounds.x, -2100);
  window.moveTo({ ...normalBounds, x: -2000 });
  window.emit('hide');
  assert.equal(writes.at(-1).bounds.x, -2000);
  assert.equal(pending.size, 0);
  window.moveTo({ ...normalBounds, x: -1900 });
  window.emit('close');
  assert.equal(writes.at(-1).bounds.x, -1900);
  window.moveTo({ ...normalBounds, x: -1800 });
  controller.save();
  assert.equal(writes.at(-1).bounds.x, -1800);
  controller.dispose();
});

test('minimize, hide and fullscreen never overwrite the last maximized preference or normal bounds', () => {
  for (const transition of ['minimize', 'fullscreen']) {
    const { window, controller, timers, writes } = createFixture();
    window.maximize();
    timers.flush();
    window[transition]();
    if (transition === 'fullscreen') window.moveTo({ x: 0, y: 0, width: 2560, height: 1440 });
    window.emit('hide');
    assert.equal(writes.at(-1).maximized, true);
    assert.deepEqual(writes.at(-1).bounds, normalBounds);
    controller.dispose();
  }
});

test('live monitor removal recovers a hidden window without showing, focusing, or changing recording lifetime', () => {
  const { window, screen, controller, timers, calls, writes } = createFixture();
  window.emit('hide');
  screen.removeSecondary();
  timers.flush();
  assertContained(window.getNormalBounds(), primary.workArea);
  assert.equal(writes.at(-1).display.id, primary.id);
  assert.deepEqual(calls.map(([kind]) => kind), ['minimum', 'bounds']);
  controller.dispose();
});

test('monitor removal while maximized defers bounds until restoration without unmaximizing', () => {
  const { window, screen, controller, timers, calls, writes } = createFixture(restore(saved(normalBounds, secondary, true)));
  screen.removeSecondary();
  timers.flush();
  assert.equal(window.isMaximized(), true);
  assert.equal(calls.some(([kind]) => kind === 'bounds'), false);
  assertContained(writes.at(-1).bounds, primary.workArea);
  window.unmaximize();
  timers.flush();
  assertContained(window.getNormalBounds(), primary.workArea);
  assert.equal(writes.at(-1).maximized, false);
  controller.dispose();
});

test('temporary loss of every display preserves the last real placement until reconnection', () => {
  const { window, screen, controller, timers, calls, writes } = createFixture();
  screen.removeAll();
  timers.flush();
  window.moveTo({ x: 0, y: 0, width: 800, height: 600 });
  controller.save();
  assert.deepEqual(writes.at(-1).bounds, normalBounds);
  assert.equal(calls.length, 0);
  screen.reconnect();
  timers.flush();
  assert.deepEqual(window.getNormalBounds(), normalBounds);
  controller.dispose();
});

test('explicit reset waits for fullscreen exit then restores a centered normal window', () => {
  const { window, controller, timers, calls, writes } = createFixture();
  window.fullscreen();
  controller.resetPlacement();
  assert.deepEqual(calls, [['fullscreen', false]]);
  window.leaveFullscreen();
  timers.flush();
  assert.deepEqual(window.getNormalBounds(), restore(null).bounds);
  assert.equal(writes.at(-1).maximized, false);
  assert.equal(writes.at(-1).display.id, primary.id);
  assert.equal(calls.some(([kind]) => kind === 'focus' || kind === 'show'), false);
  controller.dispose();
});

test('explicit reset clears deferred monitor recovery without later restoring old bounds', () => {
  const { window, screen, controller, timers } = createFixture(restore(saved(normalBounds, secondary, true)));
  screen.removeSecondary();
  timers.flush();
  controller.resetPlacement();
  timers.flush();
  assert.equal(window.isMaximized(), false);
  assert.deepEqual(window.getNormalBounds(), restore(null).bounds);
  controller.dispose();
});

test('closing the window cleans up display listeners and pending timers', () => {
  const { window, screen, pending, writes } = createFixture();
  window.moveTo({ ...normalBounds, x: -2000 });
  screen.emit('display-added');
  window.destroy();
  assert.equal(writes.at(-1).bounds.x, -2000);
  assert.equal(pending.size, 0);
  assert.equal(screen.eventNames().length, 0);
  assert.equal(window.eventNames().length, 0);
});

test('tray and second-instance activation restores minimized windows before showing and focusing', () => {
  const { window, calls, controller } = createFixture();
  window.minimize();
  showMainWindow(window);
  assert.deepEqual(calls.map(([kind]) => kind), ['restore', 'show', 'focus']);
  controller.dispose();
  window.destroy();
  showMainWindow(window);
  showMainWindow(null);
  assert.equal(calls.length, 3);
});

test('desktop persistence roundtrips atomically and recovers from absent, oversized and corrupt files', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flightfabric-window-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'window-state.json');
  const settingsFile = path.join(directory, 'settings.json');
  fs.writeFileSync(settingsFile, '{"existingUserSetting":true}');
  const store = createDesktopWindowStateStore({ stateFile });
  assert.equal(store.read(), null);
  assert.equal(store.save(saved()), true);
  assert.deepEqual(store.read(), saved());
  assert.equal(store.save(saved(normalBounds, secondary, true)), true);
  assert.equal(store.read().maximized, true);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['settings.json', 'window-state.json']);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{"existingUserSetting":true}');
  fs.writeFileSync(stateFile, 'x'.repeat(17000));
  assert.equal(store.read(), null);
  fs.writeFileSync(stateFile, '{invalid json');
  assert.equal(store.read(), null);
  const failed = createDesktopWindowStateStore({ stateFile: directory });
  assert.equal(failed.save(saved()), false);
  assert.equal(failed.read(), null);
});

test('native menu separates hiding from quitting and uses local Electron editing/view roles', () => {
  const calls = [];
  const template = createDesktopMenuTemplate({
    hasTray: true, isDev: false,
    hideWindow: () => calls.push('hide'), quit: () => calls.push('quit'),
    showWindow: () => calls.push('show'), resetPlacement: () => calls.push('reset'),
    showAbout: () => calls.push('about'), openReleases: () => calls.push('releases'),
  });
  const items = template.flatMap(({ submenu }) => submenu);
  for (const item of items.filter((item) => item.click)) item.click();
  assert.deepEqual(calls, ['hide', 'quit', 'show', 'reset', 'releases', 'about']);
  assert.ok(items.some((item) => item.role === 'paste'));
  assert.ok(items.some((item) => item.role === 'zoomIn'));
  assert.equal(items.some((item) => item.role === 'toggleDevTools'), false);
  const withoutTray = createDesktopMenuTemplate({ hasTray: false, isDev: true });
  assert.equal(withoutTray[0].submenu[0].role, 'close');
});
