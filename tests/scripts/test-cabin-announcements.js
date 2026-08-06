#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const flightPhases = require(path.join(__dirname, '..', '..', 'shared', 'flight-phases.js'));

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'cabin-announcements', 'runtime.js'),
  'utf8'
);
const STANDARD_CABIN_AUDIO_DIR = path.join(
  __dirname,
  '..',
  '..',
  'frontend',
  'audio',
  'cabin',
  'standard',
);
const BUILT_STANDARD_CABIN_AUDIO_DIR = path.join(
  __dirname,
  '..',
  '..',
  'frontend-dist',
  'audio',
  'cabin',
  'standard',
);
const SUPPORTED_AUDIO_EXTENSIONS = ['mp3', 'ogg', 'wav'];
const STANDARD_CABIN_AUDIO_SLOTS = Object.freeze({
  [flightPhases.PHASES.TAXI]: 'pushback-start',
  [flightPhases.PHASES.CLIMB]: 'climb',
  [flightPhases.PHASES.CRUISE]: 'cruise',
  [flightPhases.PHASES.DESCENT]: 'descent-start',
  [flightPhases.PHASES.APPROACH]: 'approach',
  [flightPhases.PHASES.TAXI_IN]: 'shortly-after-landing-rollout',
  ABOVE_10K: 'transition-to-above-10k-feet',
  BELOW_10K: 'transition-to-below-10k-feet',
});

class FakeLockManager {
  constructor() {
    this.heldLocks = new Map();
  }

  request(name, options, callback) {
    const normalized = options && typeof options === 'object' ? options : {};
    const ifAvailable = normalized.ifAvailable === true;

    if (ifAvailable && this.heldLocks.has(name)) {
      return Promise.resolve(callback(null));
    }

    if (this.heldLocks.has(name)) {
      throw new Error(`Unexpected queued lock request for ${name}`);
    }

    const lock = { name, mode: normalized.mode || 'exclusive' };
    this.heldLocks.set(name, lock);

    let callbackResult;
    try {
      callbackResult = callback(lock);
    } catch (err) {
      this.heldLocks.delete(name);
      return Promise.reject(err);
    }

    return Promise.resolve(callbackResult).finally(() => {
      if (this.heldLocks.get(name) === lock) {
        this.heldLocks.delete(name);
      }
    });
  }
}

function createSharedState() {
  return {
    lockManager: new FakeLockManager(),
    broadcasts: [],
    audioInstances: [],
  };
}

function createWindow(shared, windowId, options = {}) {
  const listeners = new Map();
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    JSON,
    Math,
    Date,
  };

  context.window = context;
  context.global = context;
  context.FlightPhases = flightPhases;
  context.location = {
    protocol: 'http:',
    hostname: options.hostname || '127.0.0.1',
  };
  context.navigator = { locks: shared.lockManager };
  context.__services = Object.create(null);
  if (options.hostElectron !== false) {
    context.electronAPI = {
      getBackendWsPort: async () => 8099,
    };
  }

  context.document = {
    readyState: 'complete',
    head: { appendChild() {} },
    createElement() {
      return { textContent: '' };
    },
    getElementById() {
      return null;
    },
    addEventListener() {},
  };

  context.BroadcastChannel = class FakeBroadcastChannel {
    constructor(name) {
      this.name = name;
    }

    postMessage(message) {
      shared.broadcasts.push({
        windowId,
        channel: this.name,
        message,
      });
    }
  };

  context.Audio = class FakeAudio {
    constructor(src) {
      this.src = src;
      this.windowId = windowId;
      this.playCalls = 0;
      this.pauseCalls = 0;
      this.paused = false;
      this.onplaying = null;
      this.onended = null;
      this.onerror = null;
      shared.audioInstances.push(this);
    }

    play() {
      this.playCalls += 1;
      this.paused = false;
      return Promise.resolve().then(() => {
        if (!this.paused && typeof this.onplaying === 'function') {
          this.onplaying();
        }
      });
    }

    pause() {
      this.paused = true;
      this.pauseCalls += 1;
    }

    end() {
      if (typeof this.onended === 'function') {
        this.onended();
      }
    }
  };

  context.addEventListener = (name, handler) => {
    const list = listeners.get(name) || [];
    list.push(handler);
    listeners.set(name, list);
  };

  context.__fireEvent = (name, event = {}) => {
    for (const handler of listeners.get(name) || []) {
      handler(event);
    }
  };

  const transformedSource = SOURCE
    .replace(
      "import { getFlightPhases } from '../app/shared-globals.js';",
      `const getFlightPhases = ({ fallback = null } = {}) => window.FlightPhases?.PHASES || fallback;`,
    )
    .replace('export function initCabinAnnouncementsRuntime(', 'function initCabinAnnouncementsRuntime(')
    .replace('export const cabinAnnouncementsApi = Object.freeze({', 'const cabinAnnouncementsApi = Object.freeze({');

  vm.createContext(context);
  vm.runInContext(
    `${transformedSource}\nwindow.CabinAnnouncements = cabinAnnouncementsApi;\n`,
    context,
    { filename: 'frontend/src/cabin-announcements/runtime.js' },
  );
  if (options.enableCabinAnnouncements !== false) {
    context.CabinAnnouncements.applySettings({ enabled: true, style: 'standard' });
  }
  return context;
}

function countMessages(shared, type) {
  return shared.broadcasts.filter((entry) => entry.message && entry.message.type === type).length;
}

function playedForPhase(shared, phaseFileStem) {
  return shared.audioInstances.filter((audio) => audio.playCalls > 0 && audio.src.includes(`/${phaseFileStem}.`));
}

function findAudioAsset(audioDir, stem) {
  return SUPPORTED_AUDIO_EXTENSIONS
    .map((extension) => path.join(audioDir, `${stem}.${extension}`))
    .find((filePath) => fs.existsSync(filePath)) || null;
}

async function flushAsync(turns = 4) {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function runTest(name, fn, stats) {
  try {
    await fn();
    stats.passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    stats.failed += 1;
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
  }
}

async function testSingleOwnerSuppressesDuplicates() {
  const shared = createSharedState();
  const first = createWindow(shared, 'first');
  const second = createWindow(shared, 'second');

  assert.equal(first.CabinAnnouncements.enqueue({ phase: 'TAXI', style: 'standard' }), true);
  assert.equal(second.CabinAnnouncements.enqueue({ phase: 'TAXI', style: 'standard' }), true);
  await flushAsync();

  const taxiPlays = playedForPhase(shared, 'pushback-start');
  assert.equal(taxiPlays.length, 1, 'expected only one renderer to play the taxi announcement');
  assert.equal(countMessages(shared, 'pa-play'), 1, 'expected one pa-play broadcast');
}

async function testDefaultDisabledDropsAnnouncements() {
  const shared = createSharedState();
  const windowCtx = createWindow(shared, 'disabled', { enableCabinAnnouncements: false });

  assert.equal(windowCtx.CabinAnnouncements.enqueue({ phase: 'TAXI', style: 'standard' }), false);
  await flushAsync();

  assert.equal(playedForPhase(shared, 'pushback-start').length, 0, 'disabled PA runtime should not play announcements');
  assert.equal(countMessages(shared, 'pa-play'), 0, 'disabled PA runtime should not broadcast playback');
}

async function testHostElectronRendererPlaysAnnouncements() {
  const shared = createSharedState();
  const electron = createWindow(shared, 'electron-host');

  assert.equal(
    electron.CabinAnnouncements.enqueue({ phase: 'TAXI', style: 'standard' }),
    true,
    'host Electron renderer should accept cabin playback',
  );
  await flushAsync();

  assert.equal(playedForPhase(shared, 'pushback-start').length, 1);
  assert.equal(countMessages(shared, 'pa-play'), 1);
}

async function testBrowserRenderersDropAnnouncements() {
  const shared = createSharedState();
  const localBrowser = createWindow(shared, 'local-browser', {
    hostElectron: false,
    hostname: '127.0.0.1',
  });
  const lanBrowser = createWindow(shared, 'lan-browser', {
    hostElectron: false,
    hostname: '192.168.50.20',
  });

  for (const browser of [localBrowser, lanBrowser]) {
    assert.equal(
      browser.CabinAnnouncements.enqueue({ phase: 'TAXI', style: 'standard' }),
      false,
      'ordinary browser must reject cabin playback even when announcements are enabled',
    );
  }
  await flushAsync();

  assert.equal(shared.audioInstances.length, 0, 'browser renderers must not create audio elements');
  assert.equal(countMessages(shared, 'pa-play'), 0, 'browser renderers must not broadcast playback');
}

async function testSingleWindowDropsDuplicateQueuedPhase() {
  const shared = createSharedState();
  const windowCtx = createWindow(shared, 'solo');

  assert.equal(windowCtx.CabinAnnouncements.enqueue({ phase: 'TAXI', style: 'standard' }), true);
  assert.equal(windowCtx.CabinAnnouncements.enqueue({ phase: 'TAXI', style: 'standard' }), false);
  await flushAsync();

  const taxiPlays = playedForPhase(shared, 'pushback-start');
  assert.equal(taxiPlays.length, 1, 'expected one taxi playback after duplicate same-window enqueue');
  assert.equal(countMessages(shared, 'pa-play'), 1, 'expected one pa-play broadcast');
}

async function testMutedOwnerAllowsAnotherWindowToTakeNextAnnouncement() {
  const shared = createSharedState();
  const first = createWindow(shared, 'first');
  const second = createWindow(shared, 'second');

  first.CabinAnnouncements.enqueue({ phase: 'TAXI', style: 'standard' });
  second.CabinAnnouncements.enqueue({ phase: 'TAXI', style: 'standard' });
  await flushAsync();

  const firstPlay = playedForPhase(shared, 'pushback-start')[0];
  assert.ok(firstPlay, 'expected an initial owner to play taxi');

  const owner = firstPlay.windowId === 'first' ? first : second;
  const other = firstPlay.windowId === 'first' ? second : first;

  owner.CabinAnnouncements.setMuted(true);
  await flushAsync();

  assert.equal(owner.CabinAnnouncements.enqueue({ phase: 'CLIMB', style: 'standard' }), false);
  assert.equal(other.CabinAnnouncements.enqueue({ phase: 'CLIMB', style: 'standard' }), true);
  await flushAsync();

  const climbPlays = playedForPhase(shared, 'climb');
  assert.equal(climbPlays.length, 1, 'expected exactly one climb playback');
  assert.notEqual(climbPlays[0].windowId, firstPlay.windowId, 'expected the non-muted window to take over');
}

async function testNonOwnerUnloadDoesNotEmitFalseStop() {
  const shared = createSharedState();
  const first = createWindow(shared, 'first');
  const second = createWindow(shared, 'second');

  first.CabinAnnouncements.enqueue({ phase: 'TAXI', style: 'standard' });
  second.CabinAnnouncements.enqueue({ phase: 'TAXI', style: 'standard' });
  await flushAsync();

  const taxiPlay = playedForPhase(shared, 'pushback-start')[0];
  assert.ok(taxiPlay, 'expected one owner for taxi');

  const nonOwner = taxiPlay.windowId === 'first' ? second : first;
  const stopsBefore = countMessages(shared, 'pa-stop');

  nonOwner.__fireEvent('beforeunload');
  await flushAsync();

  const stopsAfter = countMessages(shared, 'pa-stop');
  assert.equal(stopsAfter, stopsBefore, 'non-owner unload should not emit pa-stop');
}

async function testMutedFormerOwnerUnloadDoesNotEmitFalseStopAfterHandoff() {
  const shared = createSharedState();
  const first = createWindow(shared, 'first');
  const second = createWindow(shared, 'second');

  first.CabinAnnouncements.enqueue({ phase: 'TAXI', style: 'standard' });
  second.CabinAnnouncements.enqueue({ phase: 'TAXI', style: 'standard' });
  await flushAsync();

  const taxiPlay = playedForPhase(shared, 'pushback-start')[0];
  assert.ok(taxiPlay, 'expected one owner for taxi');

  const formerOwner = taxiPlay.windowId === 'first' ? first : second;
  const nextOwner = taxiPlay.windowId === 'first' ? second : first;

  formerOwner.CabinAnnouncements.setMuted(true);
  await flushAsync();
  nextOwner.CabinAnnouncements.enqueue({ phase: 'CLIMB', style: 'standard' });
  await flushAsync();

  const stopsBefore = countMessages(shared, 'pa-stop');
  formerOwner.__fireEvent('beforeunload');
  await flushAsync();
  const stopsAfter = countMessages(shared, 'pa-stop');

  assert.equal(stopsAfter, stopsBefore, 'muted former owner unload should not emit pa-stop after another window takes over');
}

async function testSingleWindowMuteUnmuteResumesPlayback() {
  const shared = createSharedState();
  const windowCtx = createWindow(shared, 'solo');

  windowCtx.CabinAnnouncements.enqueue({ phase: 'TAXI', style: 'standard' });
  await flushAsync();

  const audio = playedForPhase(shared, 'pushback-start')[0];
  assert.ok(audio, 'expected taxi playback to start');
  assert.equal(audio.playCalls, 1, 'expected one initial play() call');

  windowCtx.CabinAnnouncements.setMuted(true);
  await flushAsync();
  assert.ok(audio.pauseCalls >= 1, 'expected mute to pause current playback');

  windowCtx.CabinAnnouncements.setMuted(false);
  await flushAsync();
  assert.equal(audio.playCalls, 2, 'expected unmute to resume the paused announcement');
}

async function testStandardPackHasAudioForEveryRecognizedSlot() {
  for (const [phase, stem] of Object.entries(STANDARD_CABIN_AUDIO_SLOTS)) {
    const sourceAsset = findAudioAsset(STANDARD_CABIN_AUDIO_DIR, stem);
    assert.ok(sourceAsset, `standard cabin pack missing audio for ${phase} (${stem})`);
  }
}

async function testBuiltFrontendContainsStandardPackAudio() {
  for (const [phase, stem] of Object.entries(STANDARD_CABIN_AUDIO_SLOTS)) {
    const sourceAsset = findAudioAsset(STANDARD_CABIN_AUDIO_DIR, stem);
    assert.ok(sourceAsset, `standard cabin pack missing source audio for ${phase} (${stem})`);

    const builtAsset = path.join(BUILT_STANDARD_CABIN_AUDIO_DIR, path.basename(sourceAsset));
    assert.equal(
      fs.existsSync(builtAsset),
      true,
      `built frontend missing standard cabin audio for ${phase} (${path.basename(sourceAsset)})`,
    );
    assert.equal(
      fs.statSync(builtAsset).size,
      fs.statSync(sourceAsset).size,
      `built frontend cabin audio differs from source for ${phase} (${path.basename(sourceAsset)})`,
    );
  }
}

async function main() {
  const stats = { passed: 0, failed: 0 };

  await runTest('standard pack has audio for every recognized slot', testStandardPackHasAudioForEveryRecognizedSlot, stats);
  await runTest('built frontend contains standard pack audio', testBuiltFrontendContainsStandardPackAudio, stats);
  await runTest('default disabled drops announcements until enabled', testDefaultDisabledDropsAnnouncements, stats);
  await runTest('host Electron renderer plays cabin announcements', testHostElectronRendererPlaysAnnouncements, stats);
  await runTest('host and LAN browsers drop Electron-only cabin announcements', testBrowserRenderersDropAnnouncements, stats);
  await runTest('single owner suppresses duplicate playback', testSingleOwnerSuppressesDuplicates, stats);
  await runTest('single window drops duplicate queued phase', testSingleWindowDropsDuplicateQueuedPhase, stats);
  await runTest('muted owner allows another window to take the next announcement', testMutedOwnerAllowsAnotherWindowToTakeNextAnnouncement, stats);
  await runTest('non-owner unload does not emit false pa-stop', testNonOwnerUnloadDoesNotEmitFalseStop, stats);
  await runTest('muted former owner unload does not emit false pa-stop after handoff', testMutedFormerOwnerUnloadDoesNotEmitFalseStopAfterHandoff, stats);
  await runTest('single-window mute/unmute resumes playback', testSingleWindowMuteUnmuteResumesPlayback, stats);

  console.log(`\nCabin announcements: ${stats.passed} passed, ${stats.failed} failed`);
  if (stats.failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
