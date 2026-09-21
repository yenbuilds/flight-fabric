// Test double for the three.js scene wrapper: records every call so the
// controllers can be exercised in Node without WebGL.

export function createFakeScene(options = {}) {
  const calls = [];
  let active = false;
  let disposed = false;
  let contextLost = false;
  const state = {
    track: null,
    markers: [],
    pins: [],
    tiles: [],
    grid: null,
    aircraft: null,
    followMode: 'none',
    target: null,
    fitBounds: null,
    curtainVisible: true,
    routeLine: null,
    targetLine: null,
    snapCount: 0,
    terrain: null,
    groundHeights: new Map(),
    lighting: null,
    lightingSun: null,
  };

  function record(name, payload) {
    calls.push({ name, payload });
  }

  const scene = {
    calls,
    state,
    options,
    dispose() { disposed = true; active = false; record('dispose'); },
    isDisposed: () => disposed,
    fitToBounds(bounds) { state.fitBounds = bounds; record('fitToBounds', bounds); },
    getViewInfo() {
      return { targetX: 0, targetZ: 0, distance: 10000, sceneUnitsPerPixel: 20, width: 800, height: 600 };
    },
    isActive: () => active,
    moveTargetTo(x, y, z, opts) { state.target = { x, y, z, ...opts }; record('moveTargetTo', state.target); },
    requestRender() { record('requestRender'); },
    resize() { record('resize'); return true; },
    setAircraft(aircraft) { state.aircraft = aircraft; record('setAircraft', aircraft); },
    setCurtainVisible(visible) { state.curtainVisible = visible; record('setCurtainVisible', visible); },
    setFollowMode(mode) { state.followMode = mode; record('setFollowMode', mode); },
    setGroundGrid(grid) { state.grid = grid; record('setGroundGrid', grid); },
    setLighting(rig, opts = {}) { state.lighting = rig; state.lightingSun = opts; record('setLighting', { rig, opts }); },
    setGroundTiles(tiles, opts = {}) {
      state.tiles = tiles;
      state.terrain = opts.terrain || null;
      record('setGroundTiles', { tiles, terrain: state.terrain });
    },
    hasTerrain: () => Boolean(state.terrain),
    groundHeightAt(x, z) {
      const key = `${Math.round(x)}|${Math.round(z)}`;
      return state.groundHeights.has(key) ? state.groundHeights.get(key) : (state.terrain ? (state.defaultGroundHeight ?? null) : null);
    },
    setMarkers(markers) { state.markers = markers; record('setMarkers', markers); },
    setPins(pins) { state.pins = pins; record('setPins', pins); },
    setRouteLine(positions) { state.routeLine = positions; record('setRouteLine', positions); },
    setTargetLine(positions) { state.targetLine = positions; record('setTargetLine', positions); },
    setTrack(track) { state.track = track; record('setTrack', track); },
    snapToFollowTarget() { state.snapCount += 1; record('snapToFollowTarget'); },
    start() { if (!contextLost) active = true; record('start'); },
    stop() { active = false; record('stop'); },
    loseContext() {
      contextLost = true;
      scene.stop();
      options.onContextLost?.();
    },
    restoreContext() {
      contextLost = false;
      options.onContextRestored?.();
    },
    countCalls: (name) => calls.filter((call) => call.name === name).length,
  };
  return scene;
}

export function createFakeThreeLoader({ fail = false } = {}) {
  let loads = 0;
  return {
    loadThree: () => {
      loads += 1;
      return fail
        ? Promise.reject(new Error('WebGL is unavailable: no context'))
        : Promise.resolve({ THREE: {}, OrbitControls: class {}, LineSegments2: class {}, LineSegmentsGeometry: class {}, LineMaterial: class {} });
    },
    getLoadCount: () => loads,
  };
}

export function createFakeWindow() {
  const timers = [];
  return {
    timers,
    setTimeout(callback, delay) {
      const id = timers.length + 1;
      timers.push({ id, callback, delay, cleared: false });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.find((entry) => entry.id === id);
      if (timer) timer.cleared = true;
    },
    setInterval(callback, delay) {
      const id = timers.length + 1;
      timers.push({ id, callback, delay, cleared: false, interval: true });
      return id;
    },
    clearInterval(id) {
      const timer = timers.find((entry) => entry.id === id);
      if (timer) timer.cleared = true;
    },
    requestAnimationFrame(callback) { callback(); return 1; },
    cancelAnimationFrame() {},
    // Fires every pending timeout once; intervals fire on every call until
    // they are cleared.
    runTimers() {
      const pending = timers.filter((timer) => !timer.cleared && !timer.fired);
      for (const timer of pending) {
        if (!timer.interval) timer.fired = true;
        timer.callback();
      }
      return pending.length;
    },
    document: {
      hidden: false,
      createElement: () => createFakeCanvas(),
    },
  };
}

// Enough of a 2D canvas for the badge and label painters to run.
export function createFakeCanvas() {
  const noop = () => {};
  const ctx = {
    filter: '',
    scale: noop,
    save: noop,
    restore: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    arcTo: noop,
    closePath: noop,
    fill: noop,
    stroke: noop,
    fillText: noop,
    translate: noop,
    rotate: noop,
    drawImage: noop,
    measureText: (text) => ({ width: String(text).length * 7 }),
  };
  return { width: 0, height: 0, getContext: () => ctx };
}

export function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
