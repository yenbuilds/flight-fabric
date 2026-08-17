#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const repoRoot = path.join(__dirname, '..', '..');
const sharedSettings = require(path.join(repoRoot, 'shared', 'app-settings-shared.js'));
const { PHASES } = require(path.join(repoRoot, 'shared', 'flight-phases.js'));

function toFrontendUrl(...segments) {
  return pathToFileURL(path.join(repoRoot, 'frontend', ...segments)).href;
}

function createStorage(seed = {}) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [key, String(value)]));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
    dump() {
      return Object.fromEntries(values.entries());
    },
  };
}

function installBrowserGlobals(options = {}) {
  const storage = options.storage || createStorage();
  const matchMedia = options.matchMedia || (() => ({ matches: false }));
  const windowRef = globalThis;

  windowRef.window = windowRef;
  windowRef.document = options.document || {};
  windowRef.localStorage = storage;
  windowRef.matchMedia = matchMedia;
  windowRef.WebSocket = { OPEN: 1 };
  windowRef.FlightFabricAppSettings = sharedSettings;
  windowRef.FlightPhases = { PHASES };

  return { storage, windowRef };
}

function clearBrowserGlobals() {
  delete globalThis.document;
  delete globalThis.electronAPI;
  delete globalThis.localStorage;
  delete globalThis.matchMedia;
  delete globalThis.WebSocket;
  delete globalThis.FlightFabricAppSettings;
  delete globalThis.FlightPhases;
  globalThis.window = globalThis;
}

async function main() {
  const { createPinia, setActivePinia } = await import(toFrontendUrl('node_modules', 'pinia', 'dist', 'pinia.mjs'));
  const { useTabsStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'tabs.js'));
  const { useSettingsEditorStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'settings-editor.js'));
  const { useSettingsFormStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'settings-form.js'));
  const { useSettingsUiStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'settings-ui.js'));
  const { useAppSettingsStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'app-settings.js'));
  const { useLiveMapStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'live-map.js'));
  const { useSimbriefStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'simbrief.js'));
  const { buildRunwayAnalysisSections } = await import(toFrontendUrl('src', 'vue', 'simbrief-runway-analysis.js'));
  const { useTimelineStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'timeline.js'));
  const { useProfilesStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'profiles.js'));
  const { useLogbookStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'logbook.js'));
  const { useFlightStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'flight.js'));
  const { useFeedbackStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'feedback.js'));
  const { useDebugStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'debug.js'));
  const { useLandingStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'landing.js'));
  const { useAircraftControlsStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'aircraft-controls.js'));
  const { useAircraftSpecificStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'aircraft-specific.js'));
  const { useLvarInspectorStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'lvar-inspector.js'));
  const { usePreferencesStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'preferences.js'));
  const { useStatusStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'status.js'));
  const { useThemeStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'theme.js'));
  const { useSystemHostStore } = await import(toFrontendUrl('src', 'vue', 'stores', 'system-host.js'));
  const {
    matchesMedia,
    readStorageJson,
    readStorageValue,
    removeStorageValue,
    writeStorageJson,
    writeStorageValue,
  } = await import(toFrontendUrl('src', 'app', 'browser-environment.js'));
  const {
    formatBytes,
    formatDistanceNm,
    formatDuration,
    formatFuelBurn,
    getFiniteDistanceNm,
    getFiniteFuelBurnGal,
  } = await import(toFrontendUrl('src', 'utils', 'formatting.js'));
  const {
    buildLandingPresentation,
    buildLandingVerdict,
    gradeSeverity,
    normalizeLandingData,
    resolveStabilityVerdict,
  } = await import(toFrontendUrl('src', 'landing', 'scoring.js'));
  const {
    getStabilityContextSummary,
    getStabilityMetricPresentation,
  } = await import(toFrontendUrl('src', 'landing', 'stability-context.js'));
  const { buildDebriefReasons } = await import(toFrontendUrl('src', 'landing', 'debrief-insights.js'));
  const { buildLandingWindPresentation } = await import(toFrontendUrl('src', 'landing', 'wind.js'));
  const { buildTimelineEventRows, buildTimelineEventRowState } = await import(toFrontendUrl('src', 'timeline', 'events.js'));
  const { buildTimelineEventDetailState } = await import(toFrontendUrl('src', 'timeline', 'detail-state.js'));
  const { buildLandingDetailSections } = await import(toFrontendUrl('src', 'timeline', 'landing-detail.js'));
  const {
    buildTimelineSummaryState,
    countViolationMoments,
  } = await import(toFrontendUrl('src', 'timeline', 'model.js'));
  const { setAppService } = await import(toFrontendUrl('app-shared.js'));

  let passed = 0;
  let failed = 0;

  function resetAppServices() {
    const keys = [
      'getWs',
      'getWsUrl',
      'getWsSend',
      'getAuthorizationScope',
      'sendWs',
      'getBackendHttpBase',
      'ui',
      'getAppSettings',
      'isValidCoord',
      'handleMessage',
      'showTimelineLanding',
      'cabinAnnouncements',
      'reconnect',
    ];
    for (const key of keys) {
      setAppService(key, null);
    }
  }

  function resetStoreTestContext(options = {}) {
    clearBrowserGlobals();
    const context = installBrowserGlobals(options);
    resetAppServices();
    setActivePinia(createPinia());
    return context;
  }

  async function test(name, fn) {
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`    ${error.message}`);
    }
  }

  console.log('\n=== Vue / Pinia Store Tests ===\n');

  console.log('--- shared frontend formatting ---\n');
  await test('shared frontend formatting helpers cover storage, duration, and fuel labels', () => {
    resetStoreTestContext();

    assert.equal(formatBytes(0), '0 B', 'zero bytes should use B fallback');
    assert.equal(formatBytes(12288), '12.0 KB', 'byte formatting should match timeline storage summaries');
    assert.equal(formatDuration(7200000), '2h 0m', 'duration formatting should render hour/minute labels');
    assert.equal(formatDuration(61000), '1m 1s', 'short durations should render minute/second labels');
    assert.equal(formatFuelBurn(120, 'kg', 804), '365 kg', 'fuel burn should use authoritative kg conversion');
    assert.equal(formatFuelBurn(120, 'lbs', 804), '804 lbs', 'fuel burn should use authoritative pounds');
    assert.equal(formatFuelBurn(120, 'kg'), '--', 'fuel burn must not invent mass from gallons');
    assert.equal(formatFuelBurn(12.25, 'gal'), '12.3 gal', 'fuel burn should preserve one decimal when needed');
    assert.equal(formatDistanceNm(8.25), '8.3 NM', 'short distances should keep one decimal place');
    assert.equal(formatDistanceNm(143.7), '144 NM', 'long distances should round to whole nautical miles');
    assert.equal(getFiniteDistanceNm(0), null, 'zero distance should be treated as unknown');
    assert.equal(getFiniteFuelBurnGal(-1), null, 'negative fuel burn should be rejected');
    assert.equal(getFiniteFuelBurnGal(0), null, 'zero fuel burn should be treated as unknown rather than displayed');
    assert.equal(formatFuelBurn(0, 'kg'), '--', 'zero fuel burn should not format as Burn 0 kg');
    assert.equal(getFiniteFuelBurnGal(''), null, 'empty fuel burn should be rejected');
    assert.equal(getFiniteFuelBurnGal('4.5'), 4.5, 'numeric fuel burn strings should be accepted');
  });

  console.log('\n--- system host store ---\n');
  await test('system host store stays safe outside Electron', async () => {
    resetStoreTestContext();

    const store = useSystemHostStore();
    assert.equal(store.isElectron, false, 'plain browser runs should not report Electron availability');

    const refreshed = await store.refresh();
    assert.equal(refreshed, false, 'refresh should report that Electron IPC is unavailable');
    assert.equal(store.backendStatusLabel, 'Unavailable', 'browser fallback should keep native controls unavailable');
    assert.equal(store.frontendStatusLabel, 'Browser-hosted', 'frontend status should describe browser mode');
    assert.equal(store.remoteBrowserUrl, '', 'phone URL should not fall back to localhost outside Electron');
    assert.equal(store.remoteViewerUrl, '', 'viewer URL should not fall back to localhost outside Electron');
    assert.equal(store.remoteControlPairingUrl, '', 'control pairing URL should not exist without a local session token');
  });

  await test('system host store builds a paired phone QR URL from loopback browser bootstrap', async () => {
    resetStoreTestContext();
    const originalFetch = globalThis.fetch;
    globalThis.location = {
      origin: 'http://localhost:8100',
      protocol: 'http:',
      host: 'localhost:8100',
      hostname: 'localhost',
      port: '8100',
      pathname: '/remote',
    };
    globalThis.fetch = async (url) => {
      assert.equal(String(url), 'http://localhost:8100/api/bootstrap');
      return {
        ok: true,
        json: async () => ({
          ok: true,
          wsAuthToken: 'desktop-privileged-token',
          aircraftControlToken: 'browser-aircraft-token',
          remoteAccessEnabled: true,
          networkInfo: { ips: ['192.168.50.49'], httpPort: 8100, wsPort: 9199 },
        }),
      };
    };

    try {
      const store = useSystemHostStore();
      assert.equal(await store.refresh(), true, 'loopback browser refresh should use backend bootstrap');
      assert.equal(
        store.remoteBrowserUrl,
        'http://192.168.50.49:8100/remote?wsPort=9199&aircraftControlToken=browser-aircraft-token',
        'loopback browser should render the LAN URL with only the scoped pairing token',
      );
      assert.equal(
        store.remoteViewerUrl,
        'http://192.168.50.49:8100/remote?wsPort=9199',
        'loopback browser should expose a reusable token-free viewer URL',
      );
      assert.equal(
        store.remoteControlPairingUrl,
        'http://192.168.50.49:8100/remote?wsPort=9199&aircraftControlToken=browser-aircraft-token',
        'loopback browser should expose the existing session-scoped control URL separately',
      );
      assert.equal(store.remoteBrowserUrl.includes('desktop-privileged-token'), false, 'phone URL must never contain the privileged desktop token');
    } finally {
      delete globalThis.location;
      globalThis.fetch = originalFetch;
    }
  });

  await test('system host store reports a paired phone without redistributing its received token', async () => {
    resetStoreTestContext();
    const originalFetch = globalThis.fetch;
    globalThis.location = {
      origin: 'http://192.168.50.49:8100',
      protocol: 'http:',
      host: '192.168.50.49:8100',
      hostname: '192.168.50.49',
      port: '8100',
      pathname: '/remote',
      search: '?wsPort=9199&aircraftControlToken=received-phone-token',
    };
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        wsAuthToken: '',
        aircraftControlToken: '',
        remoteAccessEnabled: true,
        networkInfo: { ips: [], httpPort: null, wsPort: null },
      }),
    });

    try {
      const store = useSystemHostStore();
      assert.equal(await store.refresh(), true, 'paired phone should still refresh from its same-origin backend');
      assert.equal(store.currentBrowserAircraftControlPaired, true, 'current phone session should retain its paired status from the page URL');
      assert.equal(store.shareAircraftControlPaired, false, 'remote bootstrap must not grant the phone a locally issued share token');
      assert.equal(store.remoteBrowserUrl, 'http://192.168.50.49:8100/remote?wsPort=9199', 'phone share URL should retain the working custom WebSocket port but remain read-only');
      assert.equal(store.remoteViewerUrl, 'http://192.168.50.49:8100/remote?wsPort=9199', 'phone should expose only its reusable read-only viewer URL');
      assert.equal(store.remoteControlPairingUrl, '', 'phone must not mint or redistribute a control-pairing URL');
      assert.equal(store.remoteBrowserUrl.includes('received-phone-token'), false, 'phone must not redistribute the token it received');
    } finally {
      delete globalThis.location;
      globalThis.fetch = originalFetch;
    }
  });

  await test('system host store refreshes status and actions through Electron IPC', async () => {
    resetStoreTestContext();

    const calls = [];
    globalThis.electronAPI = {
      getBackendStatus: async () => ({ status: 'running' }),
      getHttpStatus: async () => ({ status: 'running', port: 8123 }),
      getBackendWsPort: async () => 9199,
      getBackendHttpPort: async () => 8100,
      getStartupHealth: async () => ({ ok: true }),
      getNetworkInfo: async () => ({ ips: ['10.0.0.5', '127.0.0.1', '192.168.1.42'], httpPort: 8100, wsPort: 9199 }),
      getSettings: async () => ({ success: true, settings: { remoteAccess: true }, settingsFile: 'C:\\Users\\Pilot\\settings.json' }),
      getBackendBootstrap: async () => ({
        ok: true,
        body: { aircraftControlToken: 'fixture-aircraft-token', remoteAccessEnabled: true },
      }),
      startBackend: async () => {
        calls.push('start');
        return { status: 'starting' };
      },
      stopBackend: async () => {
        calls.push('stop');
        return { status: 'stopping' };
      },
      restartBackend: async () => {
        calls.push('restart');
        return { status: 'starting' };
      },
      revealInExplorer: async (targetPath) => {
        calls.push(`reveal:${targetPath}`);
        return { success: true };
      },
    };

    const store = useSystemHostStore();
    assert.equal(store.isElectron, true, 'fake preload bridge should enable Electron mode');

    assert.equal(await store.refresh(), true, 'refresh should use Electron IPC when available');
    assert.equal(store.backendStatus, 'running', 'backend status should populate from IPC');
    assert.equal(store.frontendPort, 8123, 'frontend port should populate from IPC');
    assert.equal(store.backendWsPort, 9199, 'backend WS port should populate from IPC');
    assert.equal(store.backendHttpPort, 8100, 'backend HTTP port should populate from IPC');
    assert.equal(store.remoteBrowserUrl, 'http://192.168.1.42:8100/remote?wsPort=9199&aircraftControlToken=fixture-aircraft-token', 'mobile URL should prefer a 192.168 LAN IP and carry the custom WebSocket port plus scoped pairing token');
    assert.equal(store.remoteViewerUrl, 'http://192.168.1.42:8100/remote?wsPort=9199', 'desktop host should expose a stable viewer URL without a control token');
    assert.equal(store.remoteControlPairingUrl, 'http://192.168.1.42:8100/remote?wsPort=9199&aircraftControlToken=fixture-aircraft-token', 'desktop host should expose the current backend-session pairing URL');
    assert.equal(store.remoteAircraftControlPaired, true, 'mobile URL should report its session pairing state');
    assert.equal(store.alternateIpsLabel, '10.0.0.5', 'alternate LAN IPs should be summarized');
    assert.equal(store.settingsFile, 'C:\\Users\\Pilot\\settings.json', 'settings path should populate from IPC');
    assert.equal(store.startupHealthLabel, 'Healthy', 'startup health should summarize IPC health');

    await store.startBackend();
    await store.stopBackend();
    await store.restartBackend();
    await store.revealSettingsFile();

    assert.deepEqual(calls, [
      'start',
      'stop',
      'restart',
      'reveal:C:\\Users\\Pilot\\settings.json',
    ], 'system host actions should route through the preload bridge');
  });

  await test('system host store withholds phone URLs while trusted-LAN access is inactive', async () => {
    resetStoreTestContext();

    globalThis.electronAPI = {
      getBackendStatus: async () => ({ status: 'running' }),
      getHttpStatus: async () => ({ status: 'running', port: 8123 }),
      getBackendWsPort: async () => 9199,
      getBackendHttpPort: async () => 8100,
      getStartupHealth: async () => ({ ok: true }),
      getNetworkInfo: async () => ({ ips: ['192.168.1.42'], httpPort: 8100, wsPort: 9199 }),
      getSettings: async () => ({ success: true, settings: { remoteAccess: true } }),
      getBackendBootstrap: async () => ({
        ok: true,
        body: { aircraftControlToken: 'fixture-aircraft-token', remoteAccessEnabled: false },
      }),
    };

    const store = useSystemHostStore();
    await store.refresh();

    assert.equal(store.remoteAccessEnabled, false, 'active backend binding should override restart-pending saved settings');
    assert.equal(store.remoteViewerUrl, '', 'inactive LAN access should withhold the viewer URL');
    assert.equal(store.remoteControlPairingUrl, '', 'inactive LAN access should withhold the pairing URL');
    assert.equal(store.remoteBrowserUrl, '', 'inactive LAN access should withhold the QR value');
  });

  await test('stability presentation prefers persisted verdicts and safely classifies legacy results', () => {
    assert.equal(
      resolveStabilityVerdict({ verdict: 'stable', score: 42, gateStable: false, gateFailures: ['gear_not_down_at_gate'] }),
      'stable',
      'a persisted verdict should remain authoritative even when legacy fields conflict',
    );
    assert.equal(
      resolveStabilityVerdict({ verdict: 'marginal', gateStable: true, gateFailures: [] }),
      'marginal',
      'all four persisted verdict values should be preserved',
    );
    assert.equal(
      resolveStabilityVerdict({ score: 96, gateStable: false, gateFailures: ['thrust_unstable_after_gate'], breakdown: { thrust_ok: 79 } }),
      'marginal',
      'a 79% throttle-only legacy miss should be marginal',
    );
    assert.equal(
      resolveStabilityVerdict({ score: 94, gateStable: false, gateFailures: ['glidepath_proxy_unstable_after_gate'], breakdown: { glidepath_ok: 56 } }),
      'marginal',
      'a path-rate-proxy-only legacy miss should be marginal',
    );
    assert.equal(
      resolveStabilityVerdict({ score: 84, gateStable: false, gateFailures: ['speed_proxy_unstable_after_gate'], breakdown: { speed_ok: 38 } }),
      'unstable',
      'a substantial direct speed deviation should remain unstable',
    );
    assert.equal(
      resolveStabilityVerdict({ score: 96, gateStable: false, gateFailures: ['gear_not_down_at_gate'] }),
      'unstable',
      'hard configuration failures should remain unstable',
    );
    assert.equal(resolveStabilityVerdict({ score: null, samples: 0, gateFailures: ['insufficient_data'] }), 'no_verdict');
    assert.equal(resolveStabilityVerdict({ score: 91 }), 'no_verdict', 'a score without a strict result should not invent a verdict');

    const explicitPresentation = buildLandingPresentation({
      ultimateStability: { verdict: 'marginal', score: 96, gateStable: false, gateFailures: ['thrust_unstable_after_gate'] },
    });
    assert.equal(explicitPresentation.approachText, 'MARGINAL');
    assert.equal(explicitPresentation.verdict.stability.color, '#f59e0b');
  });

  await test('landing debrief helpers avoid mutually exclusive praise and warning chips', () => {
    const unstableGatePayload = {
      vs: -210,
      touchdownDistance: { distanceFt: 600 },
      ultimateStability: { score: 91, samples: 82, gateStable: 'false' },
    };
    const unstableGateReasons = buildDebriefReasons(unstableGatePayload, {
      normalized: normalizeLandingData(unstableGatePayload),
      touchdownDistance: unstableGatePayload.touchdownDistance,
      ultimateStability: unstableGatePayload.ultimateStability,
      limit: 8,
    }).map((reason) => reason.text);
    const unstableGateVerdict = buildLandingVerdict(unstableGatePayload);
    assert.equal(unstableGateVerdict.stability.tone, 'warning', 'gate-flagged high stability should be a warning verdict');
    assert.equal(unstableGateVerdict.stability.color, '#f59e0b', 'gate-flagged high stability should use warning color');
    assert.equal(unstableGateReasons.includes('Marginal approach - soft/proxy miss'), true, 'a soft strict-gate miss should be surfaced as marginal');
    assert.equal(unstableGateReasons.includes('Stabilized approach'), false, 'gate instability should suppress stabilized approach praise');
    assert.equal(gradeSeverity('Firm'), 1, 'touchdown-grade severity should be case-normalized');

    const profileGradeReasons = buildDebriefReasons({
      vs: -210,
      grade: 'GOOD',
    }, { limit: 8 }).map((reason) => reason.text);
    assert.equal(profileGradeReasons.includes('Good touchdown rate'), true, 'debrief wording should use the resolved profile-aware touchdown-rate grade');
    assert.equal(profileGradeReasons.includes('Smooth touchdown rate'), false, 'a generic vertical-speed band must not rewrite a resolved GOOD grade as smooth');

    const missingGradeReasons = buildDebriefReasons({
      vs: -800,
    }, { limit: 8 }).map((reason) => reason.text);
    assert.equal(missingGradeReasons.some((reason) => /touchdown/i.test(reason)), false, 'the frontend must not invent a touchdown-rate factor when no grade was resolved');

    const legacyExcursionReasons = buildDebriefReasons({
      grade: 'RUNWAY EXCURSION',
      runwayExcursion: true,
    }, { limit: 8 }).map((reason) => reason.text);
    assert.equal(legacyExcursionReasons.includes('Runway excursion'), true, 'legacy excursions remain a separate safety fact');
    assert.equal(legacyExcursionReasons.includes('Runway Excursion touchdown rate'), false, 'an excursion sentinel must not become a touchdown-rate factor');

    const failureOnlyPayload = {
      vs: -210,
      touchdownDistance: { distanceFt: 600 },
      ultimateStability: { score: 91, gateFailures: ['speed_proxy_unstable_after_gate'] },
    };
    const failureOnlyReasons = buildDebriefReasons(failureOnlyPayload, {
      normalized: normalizeLandingData(failureOnlyPayload),
      touchdownDistance: failureOnlyPayload.touchdownDistance,
      ultimateStability: failureOnlyPayload.ultimateStability,
      limit: 8,
    }).map((reason) => reason.text);
    assert.equal(buildLandingPresentation(failureOnlyPayload).gateVerdict, 'MARGINAL', 'soft failed checks should infer a marginal legacy verdict when the explicit verdict is absent');
    assert.equal(failureOnlyReasons.includes('Marginal approach - soft/proxy miss'), true, 'soft failed checks should surface a marginal approach');
    assert.equal(failureOnlyReasons.includes('Stabilized approach'), false, 'failed checks must suppress stabilized approach praise');

    const cappedPerfect = buildLandingPresentation({
      grade: 'PERFECT',
      touchdownDistance: { distanceFt: 600, grade: 'Outstanding', bounceCount: 1, bounceGrade: 'Single Bounce' },
      ultimateStability: { verdict: 'unstable', score: 84, gateStable: false, gateFailures: ['speed_proxy_unstable_after_gate'] },
    });
    assert.equal(cappedPerfect.touchdownGrade, 'PERFECT', 'the raw touchdown-rate grade should remain factual and explicitly scoped');
    assert.equal(Object.prototype.hasOwnProperty.call(cappedPerfect, 'displayGrade'), false, 'presentation must not expose a hybrid overall grade');
    assert.equal(Object.prototype.hasOwnProperty.call(cappedPerfect, 'perfectCapped'), false, 'peer facts must not cap the touchdown-rate grade');
    assert.equal(cappedPerfect.approachText, 'UNSTABLE', 'the approach verdict should remain independent of the touchdown grade');
    assert.equal(cappedPerfect.approachScoreText, 'Approach score 84%', 'the percentage should be labelled as a secondary approach score');
    assert.equal(cappedPerfect.bounceText, '1x', 'the shared presentation should expose the recorded bounce count');
    assert.equal(cappedPerfect.touchdownColor, '#00e070', 'the touchdown grade should keep its own grade color');
    assert.equal(cappedPerfect.verdict.bounce.color, '#f59e0b', 'the recorded bounce should carry its own warning color');

    const verifiedPerfect = buildLandingPresentation({
      grade: 'PERFECT',
      touchdownDistance: { distanceFt: 600, grade: 'Outstanding', bounceCount: 0, bounceGrade: 'Clean' },
      ultimateStability: { score: 96, gateStable: true },
    });
    assert.equal(verifiedPerfect.touchdownGrade, 'PERFECT', 'the touchdown-rate grade should remain available for a verified clean landing');

    const topLevelBounce = buildLandingPresentation({ grade: 'PERFECT', bounceCount: 1, bounceGrade: 'Single Bounce' });
    assert.equal(topLevelBounce.touchdownGrade, 'PERFECT', 'top-level replay bounce facts should not rewrite the touchdown-rate grade');
    assert.equal(topLevelBounce.bounceText, '1x', 'top-level replay bounce facts should remain visible');

    const shortLandingPayload = {
      vs: -210,
      touchdownDistance: {
        distanceFt: 250,
        shortLanding: true,
        tdzAchieved: true,
      },
    };
    const shortLandingNormalized = normalizeLandingData(shortLandingPayload);
    const shortLandingReasons = buildDebriefReasons(shortLandingPayload, {
      normalized: shortLandingNormalized,
      touchdownDistance: shortLandingPayload.touchdownDistance,
      limit: 8,
    }).map((reason) => reason.text);
    assert.equal(shortLandingNormalized.tdzAchievedEffective, false, 'short landing should override explicit TDZ-achieved flags');
    assert.equal(shortLandingReasons.includes('Short of threshold'), true, 'nested short-landing flags should be surfaced');
    assert.equal(shortLandingReasons.includes('First 1,000 ft target'), false, 'short landing should suppress first-1,000-ft praise');
    assert.equal(shortLandingReasons.includes('Inside formal 3,000 ft TDZ'), false, 'short landing should suppress formal-TDZ praise');

    const replayedShortLandingPayload = {
      vs: -210,
      touchdownDistance: {
        distanceFt: -80,
        grade: 'Short Landing',
        tdzAchieved: true,
      },
    };
    const replayedShortLandingNormalized = normalizeLandingData(replayedShortLandingPayload);
    const replayedShortLandingReasons = buildDebriefReasons(replayedShortLandingPayload, {
      normalized: replayedShortLandingNormalized,
      touchdownDistance: replayedShortLandingPayload.touchdownDistance,
      limit: 8,
    }).map((reason) => reason.text);
    assert.equal(replayedShortLandingNormalized.tdzAchievedEffective, false, 'grade-only short landings should override stale TDZ flags');
    assert.equal(replayedShortLandingReasons.includes('Short of threshold'), true, 'grade-only short landings should be surfaced');
    assert.equal(replayedShortLandingReasons.includes('First 1,000 ft target'), false, 'grade-only short landings should suppress first-1,000-ft praise');
    assert.equal(replayedShortLandingReasons.includes('Inside formal 3,000 ft TDZ'), false, 'grade-only short landings should suppress formal-TDZ praise');

    const shortLandingVerdict = buildLandingVerdict({
      grade: 'GOOD',
      touchdownDistance: {
        distanceFt: -80,
        grade: 'Good',
        score: 100,
        tdzAchieved: true,
      },
    });
    assert.equal(Object.prototype.hasOwnProperty.call(shortLandingVerdict, 'headline'), false, 'the verdict must not synthesize an overall landing grade');
    assert.equal(shortLandingVerdict.touchdown.color, '#ef4444', 'short landing touchdown verdict should stay danger-colored even with a stale green TDZ score');
    assert.equal(shortLandingVerdict.flags.tdzAchieved, false, 'short landing verdict should suppress stale TDZ achieved flags');

    const longLandingVerdict = buildLandingVerdict({
      touchdownDistance: {
        distanceFt: 1300,
        grade: 'Long Landing',
      },
    });
    assert.equal(longLandingVerdict.touchdown.grade, 'Long Landing', 'the TDZ grade should remain on its own axis');
    assert.equal(longLandingVerdict.touchdown.severity, 2, 'the TDZ axis should retain long-landing severity');

    const nullStabilityVerdict = buildLandingVerdict({
      touchdownDistance: { distanceFt: 600 },
      ultimateStability: { score: null },
    });
    assert.equal(nullStabilityVerdict.stability.score, null, 'null stability score should remain missing, not coerce to zero');
    assert.equal(nullStabilityVerdict.stability.color, '#888888', 'missing stability should keep muted verdict color');

    const stringTdzPayload = {
      vs: -210,
      touchdownDistance: {
        distanceFt: 600,
        grade: 'Good',
        tdzAchieved: 'false',
      },
    };
    assert.equal(normalizeLandingData(stringTdzPayload).tdzAchievedEffective, false, 'string false TDZ flags should not become truthy');

    const legacyNormalTdzPayload = {
      touchdownDistance: { distanceFt: 2000, grade: 'Good' },
    };
    assert.equal(
      normalizeLandingData(legacyNormalTdzPayload).tdzAchievedEffective,
      true,
      'legacy landings inside the formal 3,000 ft TDZ should remain achieved',
    );
    assert.equal(
      normalizeLandingData({
        touchdownDistance: { distanceFt: 2000, grade: 'Good', tdzAchieved: false },
      }).tdzAchievedEffective,
      false,
      'an explicit backend TDZ result should override the legacy distance fallback',
    );

    const lateFormalTdzVerdict = buildLandingVerdict({
      touchdownDistance: { distanceFt: 2966, grade: 'Acceptable', tdzAchieved: true },
    });
    assert.equal(lateFormalTdzVerdict.flags.tdzAchieved, true, '2,966 ft should remain inside the formal 3,000-ft TDZ');
    assert.equal(lateFormalTdzVerdict.flags.touchdownTargetAchieved, false, '2,966 ft must not pass the first-1,000-ft target');
    const lateFormalTdzReasons = buildDebriefReasons({
      touchdownDistance: { distanceFt: 2966, grade: 'Acceptable', tdzAchieved: true },
    }, {
      touchdownDistance: { distanceFt: 2966, grade: 'Acceptable', tdzAchieved: true },
      limit: 8,
    }).map((reason) => reason.text);
    assert.equal(lateFormalTdzReasons.includes('First 1,000 ft target'), false, 'late formal-TDZ landings should not receive first-1,000-ft praise');
    assert.equal(lateFormalTdzReasons.includes('Inside formal 3,000 ft TDZ'), true, 'formal TDZ feedback should state its 3,000-ft boundary');

    const excursionVerdict = buildLandingVerdict({
      grade: 'GOOD',
      runwayExcursion: 1,
      touchdownDistance: { distanceFt: 600, grade: 'Good' },
    });
    assert.equal(excursionVerdict.flags.runwayExcursion, true, 'runway excursion should remain a separate safety fact');
    assert.equal(excursionVerdict.touchdown.color, '#ef4444', 'runway excursion should retain danger styling without becoming an overall grade');

    const rolloutReasons = buildDebriefReasons({
      vs: -210,
      rolloutAnalysis: { assessment: 'caution' },
      touchdownDistance: { distanceFt: 600, grade: 'Good' },
    }, {
      touchdownDistance: { distanceFt: 600, grade: 'Good' },
      limit: 8,
    }).map((reason) => reason.text);
    assert.equal(
      rolloutReasons.includes('Rollout-control caution'),
      true,
      'debrief factors should surface rollout control separately from approach stability',
    );

    const repeatedBouncePayload = {
      vs: -210,
      touchdownDistance: {
        distanceFt: 600,
        bounceCount: 3,
        bounceGrade: 'Repeated Bounces',
      },
    };
    const repeatedBounceReasons = buildDebriefReasons(repeatedBouncePayload, {
      normalized: normalizeLandingData(repeatedBouncePayload),
      touchdownDistance: repeatedBouncePayload.touchdownDistance,
      limit: 8,
    }).map((reason) => reason.text);
    assert.equal(repeatedBounceReasons.includes('Repeated bounces'), true, 'three bounces should use the backend repeated-bounces label');
    assert.equal(repeatedBounceReasons.some((reason) => reason.startsWith('Porpoise')), false, 'three bounces should not be labeled porpoise');

    const porpoiseReasons = buildDebriefReasons({
      vs: -210,
      touchdownDistance: {
        distanceFt: 600,
        bounceCount: 0,
        bounceGrade: 'Porpoise',
      },
    }, {
      normalized: normalizeLandingData({ touchdownDistance: { distanceFt: 600 } }),
      touchdownDistance: {
        distanceFt: 600,
        bounceCount: 0,
        bounceGrade: 'Porpoise',
      },
      limit: 8,
    }).map((reason) => reason.text);
    assert.equal(porpoiseReasons.includes('Porpoise (4x bounces)'), true, 'porpoise grade should imply a non-clean bounce count');
    assert.equal(
      buildLandingVerdict({ touchdownDistance: { distanceFt: 600, bounceCount: 0, bounceGrade: 'Porpoise' } }).bounce.severity,
      3,
      'porpoise verdict should be severe even when replay payloads have a zero bounce count',
    );
  });

  await test('timeline landing rows lead with gate verdicts and retain bounce-only facts', () => {
    const row = buildTimelineEventRowState({
      type: 'landing',
      timestampMs: 2000,
      grade: 'Good',
      runway: { airport_icao: 'YSSY', runway_id: '34L' },
      touchdownDistance: { distanceFt: 500, grade: 'Good' },
      ultimateStability: { verdict: 'unstable', score: 91, gateStable: 'false' },
    }, 0, 1000);
    const stabilityBadge = row.badges.find((badge) => badge.text === 'APP UNSTABLE');
    assert.ok(stabilityBadge, 'timeline row should expose the unstable approach verdict independently');
    assert.equal(stabilityBadge.toneClass, 'negative', 'an unstable verdict should retain a prominent danger tone');
    assert.match(row.subtitle, /Approach score 91%/, 'timeline row should retain the percentage as a labelled secondary score');

    const stableRow = buildTimelineEventRowState({
      type: 'landing',
      timestampMs: 2000,
      grade: 'Good',
      runway: { airport_icao: 'YSSY', runway_id: '34L' },
      touchdownDistance: { distanceFt: 500, grade: 'Good' },
      ultimateStability: { score: 91, gateStable: true },
    }, 0, 1000);
    const stableBadge = stableRow.badges.find((badge) => badge.text === 'APP STABLE');
    assert.equal(stableBadge?.toneClass, 'positive', 'stable high-score approaches should keep positive timeline tone');

    const marginalRow = buildTimelineEventRowState({
      type: 'landing',
      timestampMs: 2000,
      grade: 'Good',
      ultimateStability: {
        score: 96,
        gateStable: false,
        gateFailures: ['thrust_unstable_after_gate'],
        breakdown: { thrust_ok: 79 },
      },
    }, 0, 1000);
    assert.equal(
      marginalRow.badges.find((badge) => badge.text === 'APP MARGINAL')?.toneClass,
      'warning',
      'soft/proxy misses should render as an amber marginal Timeline badge',
    );

    const gateOnlyRow = buildTimelineEventRowState({
      type: 'landing',
      timestampMs: 2000,
      grade: 'GOOD',
      ultimateStability: { gateStable: false },
    }, 0, 1000);
    assert.equal(gateOnlyRow.badges.some((badge) => badge.text === 'APP MARGINAL'), true, 'a legacy strict-gate miss without hard evidence should render as marginal');

    const scoreOnlyRow = buildTimelineEventRowState({
      type: 'landing',
      timestampMs: 2000,
      grade: 'GOOD',
      ultimateStability: { score: 91 },
    }, 0, 1000);
    assert.match(scoreOnlyRow.subtitle, /Approach score 91%/, 'score-only events should label the percentage without inventing a verdict');
    const scoreOnlyApproachBadge = scoreOnlyRow.badges.find((badge) => badge.text === 'APP NO VERDICT');
    assert.ok(scoreOnlyApproachBadge, 'score-only events should explicitly state that no approach verdict is available');
    assert.equal(scoreOnlyApproachBadge.toneClass, '', 'a score-only no-verdict badge should remain neutral');

    const bounceOnlyRow = buildTimelineEventRowState({
      type: 'landing',
      timestampMs: 2000,
      grade: 'PERFECT',
      bounceCount: 1,
      bounceGrade: 'Single Bounce',
    }, 0, 1000);
    assert.equal(bounceOnlyRow.badges.some((badge) => badge.text === 'TD RATE PERFECT'), true, 'bounce-only events should keep the explicitly scoped touchdown-rate grade');
    assert.equal(bounceOnlyRow.badges.some((badge) => badge.text === 'BNC 1x'), true, 'bounce-only events should show the bounce as a peer fact');
    assert.match(bounceOnlyRow.subtitle, /Bounce 1x/, 'authoritative top-level bounce facts should remain visible without TDZ data');

    const excursionRow = buildTimelineEventRowState({
      type: 'landing',
      timestampMs: 2000,
      grade: 'GOOD',
      runwayExcursion: 1,
      runway: { airport_icao: 'YSSY', runway_id: '34L' },
      touchdownDistance: { distanceFt: 500, grade: 'Good' },
    }, 0, 1000);
    const excursionBadge = excursionRow.badges.find((badge) => badge.text === 'RUNWAY EXCURSION');
    assert.ok(excursionBadge, 'timeline row should promote runway excursion to the headline badge');
    assert.equal(excursionBadge.toneClass, 'negative', 'runway excursion timeline badge should be negative');

    const rolloutRow = buildTimelineEventRowState({
      type: 'landing',
      timestampMs: 2000,
      grade: 'GOOD',
      runway: { airport_icao: 'YSCB', runway_id: '35' },
      touchdownDistance: { distanceFt: 1768, grade: 'Good' },
      rolloutAnalysis: { assessment: 'caution' },
    }, 0, 1000);
    assert.match(rolloutRow.subtitle, /Rollout CAUTION/, 'timeline landing subtitle should expose rollout assessment');
    assert.ok(
      rolloutRow.badges.some((badge) => badge.text === 'ROLLOUT CAUTION'),
      'timeline landing row should badge a rollout caution separately',
    );
  });

  await test('timeline violation summary clusters overlapping rule triggers into physical moments', () => {
    const events = [
      {
        type: 'violation_start',
        ruleId: 'high_sink_rate',
        timestampMs: 1000,
        context: { duration_ms: 5000 },
      },
      {
        type: 'violation_start',
        ruleId: 'below_glidepath',
        timestampMs: 2000,
      },
      {
        type: 'violation_end',
        ruleId: 'below_glidepath',
        timestampMs: 5000,
      },
      {
        type: 'violation_end',
        ruleId: 'high_sink_rate',
        timestampMs: 6000,
      },
      {
        type: 'violation_start',
        ruleId: 'BANK_ANGLE',
        timestampMs: 10000,
      },
      {
        type: 'violation_end',
        ruleId: 'BANK_ANGLE',
        timestampMs: 12000,
      },
    ];
    assert.equal(countViolationMoments(events), 2, 'overlapping rule intervals should count as one physical moment');

    const timeline = {
      events,
      eventCount: events.length,
      durationMs: 12000,
    };
    const summary = buildTimelineSummaryState(timeline, events);
    assert.equal(
      summary.violationCountText,
      '2 moments (3 triggers)',
      'summary should distinguish physical moments from raw rule triggers',
    );
  });

  await test('high-sink timeline rows expose final peak and duration', () => {
    const row = buildTimelineEventRowState({
      type: 'violation_start',
      ruleId: 'high_sink_rate',
      severity: 'caution',
      timestampMs: 1000,
      context: {
        peak_sink_rate_fpm: -1356.9,
        duration_ms: 6567,
      },
    }, 0, 0);

    assert.match(row.subtitle, /peak -1357 fpm/, 'high-sink row should show the episode peak');
    assert.match(row.subtitle, /6\.6s/, 'high-sink row should show the episode duration');
  });

  await test('timeline rows show persisted simulator clocks only on the first and last dots', () => {
    const rows = buildTimelineEventRows([
      {
        type: 'phase_start',
        timestampMs: 1000,
        newPhase: 'TAXI',
        simDateTimeLocal: '2026-07-31T14:48:05',
        simDateTimeUtc: '2026-07-31T13:48:05Z',
      },
      {
        type: 'phase_start',
        timestampMs: 2000,
        newPhase: 'CRUISE',
        simDateTimeLocal: '2026-07-31T15:30:00',
        simDateTimeUtc: '2026-07-31T14:30:00Z',
      },
      {
        type: 'phase_start',
        timestampMs: 3000,
        newPhase: 'PARKED',
        simDateTimeLocal: '2026-07-31T16:13:29',
        simDateTimeUtc: '2026-07-31T15:13:29Z',
      },
    ], { startMs: 1000 });

    assert.equal(rows[0].showEndpointDateTime, true);
    assert.equal(rows[0].localDateTimeText, '2026-07-31 14:48');
    assert.equal(rows[0].utcDateTimeText, '2026-07-31 13:48');
    assert.equal(rows[1].showEndpointDateTime, false, 'middle dots should remain compact');
    assert.equal(rows[2].showEndpointDateTime, true);
    assert.equal(rows[2].localDateTimeText, '2026-07-31 16:13');
    assert.equal(rows[2].utcDateTimeText, '2026-07-31 15:13');
  });

  await test('path-rate proxy timeline labels avoid positional glidepath claims', () => {
    const startRow = buildTimelineEventRowState({
      type: 'violation_start',
      ruleId: 'below_glidepath',
      severity: 'caution',
      timestampMs: 1000,
    }, 0, 0);
    const endRow = buildTimelineEventRowState({
      type: 'violation_end',
      ruleId: 'below_glidepath',
      timestampMs: 2000,
    }, 1, 0);
    const detail = buildTimelineEventDetailState({
      type: 'violation_start',
      ruleId: 'below_glidepath',
      timestampMs: 1000,
    });

    assert.equal(startRow.title, 'PATH RATE TOO STEEP');
    assert.equal(endRow.title, 'Path rate recovered');
    assert.equal(detail.title, 'Path rate too steep');
  });

  await test('timeline automation rows expose labels, confidence, and no score detail', () => {
    const row = buildTimelineEventRowState({
      type: 'automation_event',
      timestampMs: 2500,
      eventType: 'ap_disengaged',
      label: 'AP disconnected',
      summary: 'On -> Off - RA 420 ft - phase APPROACH',
      confidence: 'simconnect',
      raFt: 420,
      context: {
        field: 'apMaster',
        previous: true,
        current: false,
        confidence: 'simconnect',
        ra_ft: 420,
      },
    }, 0, 1000);

    assert.equal(row.type, 'automation', 'automation events should use the automation timeline lane');
    assert.equal(row.title, 'AP disconnected', 'automation row should use the supplied label');
    assert.equal(row.subtitle, 'On -> Off - RA 420 ft - phase APPROACH', 'automation row should show the generated summary');
    assert.ok(row.badges.some((badge) => badge.text === 'Sim'), 'automation row should expose confidence');
    assert.ok(row.badges.some((badge) => badge.text === '420ft RA'), 'AP disconnect rows should badge radio altitude');

    const profileRow = buildTimelineEventRowState({
      type: 'automation_event',
      timestampMs: 3000,
      eventType: 'lateral_mode_changed',
      label: 'Lateral mode changed',
      summary: 'HDG -> LNAV - phase CLIMB',
      confidence: 'profile-confirmed',
      context: { confidence: 'profile-confirmed' },
    }, 0, 1000);
    assert.ok(profileRow.badges.some((badge) => badge.text === 'Profile data'), 'profile-backed automation rows should label telemetry provenance clearly');

    const detail = buildTimelineEventDetailState({
      type: 'automation_event',
      eventType: 'ap_disengaged',
      label: 'AP disconnected',
      context: { confidence: 'simconnect', ra_ft: 420 },
    });
    assert.equal(detail.type, 'Automation', 'automation detail should use the Automation type label');
    assert.equal(detail.title, 'AP disconnected', 'automation detail should use the supplied label');
    assert.equal(Object.prototype.hasOwnProperty.call(detail, 'scoreVisible'), false, 'timeline detail state should not carry unused score-impact display flags');
  });

  await test('timeline flap rows show direction, detents, and profile provenance', () => {
    const event = {
      type: 'configuration_event',
      timestampMs: 2500,
      eventType: 'flaps_changed',
      label: 'Flaps extended to 1+F',
      summary: 'UP -> 1+F',
      confidence: 'profile-confirmed',
      context: {
        previous_flaps: 'UP',
        current_flaps: '1+F',
        confidence: 'profile-confirmed',
      },
    };
    const row = buildTimelineEventRowState(event, 0, 1000);

    assert.equal(row.type, 'marker', 'flap changes should use the configuration marker lane');
    assert.equal(row.title, 'Flaps extended to 1+F', 'flap row should show its direction and new detent');
    assert.equal(row.subtitle, 'UP -> 1+F', 'flap row should show the detent transition');
    assert.ok(row.badges.some((badge) => badge.text === 'Profile data'), 'flap row should expose profile provenance');

    const detail = buildTimelineEventDetailState(event);
    assert.equal(detail.type, 'Configuration', 'flap detail should use the Configuration type label');
    assert.equal(detail.title, 'Flaps extended to 1+F', 'flap detail should keep the event label');
  });

  await test('timeline landing details keep severe touchdown geometry visually severe', () => {
    const shortSections = buildLandingDetailSections({
      type: 'landing',
      touchdownDistance: {
        distanceFt: -80,
        grade: 'Short Landing',
        score: 0,
      },
    });
    const shortTouchdownSection = shortSections.find((section) => section.key === 'touchdown-zone-analysis');
    const shortGradeRow = shortTouchdownSection?.rows.find((row) => row.key === 'grade');
    assert.ok(shortGradeRow, 'short landing detail should include a TDZ grade row');
    assert.match(shortGradeRow.valueClass, /text-red-400/, 'short landing detail grade should be red');

    const excursionSections = buildLandingDetailSections({
      type: 'landing',
      runwayExcursion: 'true',
      touchdownDistance: {
        distanceFt: 650,
        grade: 'Good',
        score: 95,
      },
    });
    const excursionTouchdownSection = excursionSections.find((section) => section.key === 'touchdown-zone-analysis');
    const excursionGradeRow = excursionTouchdownSection?.rows.find((row) => row.key === 'grade');
    const excursionRow = excursionTouchdownSection?.rows.find((row) => row.key === 'runway-excursion');
    assert.match(excursionGradeRow?.valueClass || '', /text-red-400/, 'runway excursion should override optimistic TDZ grade tone');
    assert.equal(excursionRow?.value, 'Yes', 'runway excursion should be visible in landing detail rows');
    assert.match(excursionRow?.valueClass || '', /text-red-400/, 'runway excursion detail row should be red');

    const bounceOnlySections = buildLandingDetailSections({
      type: 'landing',
      grade: 'PERFECT',
      bounceCount: 1,
      bounceGrade: 'Single Bounce',
    });
    const bounceOnlySnapshot = bounceOnlySections.find((section) => section.key === 'landing-snapshot');
    assert.equal(bounceOnlySnapshot?.rows.find((row) => row.key === 'touchdown-grade')?.value, 'PERFECT', 'bounce-only detail should keep the explicitly labelled touchdown grade');
    assert.match(bounceOnlySnapshot?.rows.find((row) => row.key === 'bounce')?.value || '', /^1x/, 'bounce-only detail should expose top-level bounce facts');

    const partialTouchdownSections = buildLandingDetailSections({
      type: 'landing',
      grade: 'GOOD',
      runway: { length_ft: 10000 },
      touchdownDistance: {
        distanceFt: null,
        grade: null,
        score: null,
        lateralOffsetFt: null,
        bounceCount: 1,
        bounceGrade: 'Single Bounce',
      },
    });
    const partialTouchdownSnapshot = partialTouchdownSections.find((section) => section.key === 'landing-snapshot');
    assert.match(partialTouchdownSnapshot?.rows.find((row) => row.key === 'bounce')?.value || '', /^1x/, 'partial TDZ data should retain a real bounce fact');
    assert.equal(partialTouchdownSections.some((section) => section.key === 'touchdown-zone-analysis'), false, 'bounce-only TDZ objects should not fabricate a geometry section');
    assert.doesNotMatch(JSON.stringify(partialTouchdownSections), /NaN|undefined|0% down runway/, 'missing TDZ geometry should not render coerced or invalid values');

    const excursionOnlySections = buildLandingDetailSections({
      type: 'landing',
      grade: 'GOOD',
      runwayExcursion: true,
      touchdownDistance: { bounceCount: 0, bounceGrade: 'Clean' },
    });
    const excursionOnlyTdz = excursionOnlySections.find((section) => section.key === 'touchdown-zone-analysis');
    assert.equal(excursionOnlyTdz?.rows.find((row) => row.key === 'runway-excursion')?.value, 'Yes', 'an excursion should remain visible even when TDZ geometry is unavailable');
    assert.doesNotMatch(JSON.stringify(excursionOnlySections), /NaN|undefined/, 'excursion-only data should not emit invalid geometry text');

    const scoreOnlySections = buildLandingDetailSections({
      type: 'landing',
      grade: 'GOOD',
      ultimateStability: { score: 91 },
    });
    const scoreOnlySnapshot = scoreOnlySections.find((section) => section.key === 'landing-snapshot');
    const scoreOnlyApproach = scoreOnlySnapshot?.rows.find((row) => row.key === 'approach-verdict');
    assert.equal(scoreOnlyApproach?.value, 'NO VERDICT', 'landing detail should not silently omit a missing approach verdict');
    assert.match(scoreOnlyApproach?.valueClass || '', /text-gray-400/, 'a missing approach verdict should remain visually neutral');

    const marginalSections = buildLandingDetailSections({
      type: 'landing',
      ultimateStability: {
        score: 96,
        gateStable: false,
        gateFailures: ['thrust_unstable_after_gate'],
        breakdown: { thrust_ok: 79, speed_ok: 87 },
        scoringContext: { criteria: { gateRaFt: 1200, passPct: 80 } },
      },
    });
    const marginalSnapshot = marginalSections.find((section) => section.key === 'landing-snapshot');
    const stabilitySection = marginalSections.find((section) => section.key === 'retrospective-stability');
    assert.equal(marginalSnapshot?.rows.find((row) => row.key === 'approach-verdict')?.value, 'MARGINAL');
    assert.match(marginalSnapshot?.rows.find((row) => row.key === 'approach-verdict')?.valueClass || '', /text-amber-400/);
    assert.match(stabilitySection?.rows.find((row) => row.key === 'thrust_ok')?.valueClass || '', /text-amber-400/, '60-79% metrics should be amber');
    assert.match(stabilitySection?.rows.find((row) => row.key === 'speed_ok')?.valueClass || '', /text-green-400/, '80% and higher metrics should pass visually');
    assert.match(stabilitySection?.noteText || '', /after the 1,200 ft gate[\s\S]*Marginal means only soft\/proxy checks/, 'Timeline detail should explain the recorded threshold and gate');

    const substantialSections = buildLandingDetailSections({
      type: 'landing',
      ultimateStability: {
        score: 84,
        gateStable: false,
        gateFailures: ['speed_proxy_unstable_after_gate'],
        breakdown: { speed_ok: 38 },
      },
    });
    const substantialSnapshot = substantialSections.find((section) => section.key === 'landing-snapshot');
    const substantialStability = substantialSections.find((section) => section.key === 'retrospective-stability');
    assert.equal(substantialSnapshot?.rows.find((row) => row.key === 'approach-verdict')?.value, 'UNSTABLE');
    assert.match(substantialSnapshot?.rows.find((row) => row.key === 'approach-verdict')?.valueClass || '', /text-red-400/);
    assert.match(substantialStability?.rows.find((row) => row.key === 'speed_ok')?.valueClass || '', /text-red-400/, 'below-60% direct metrics should be red');

    const rolloutSections = buildLandingDetailSections({
      type: 'landing',
      bank_deg: -0.3,
      rolloutAnalysis: {
        assessment: 'caution',
        sampleCount: 5,
        durationMs: 2000,
        maxBankDeg: 3.3,
        maxBankAtGsKts: 131,
        maxBankRateDegS: 4.6,
        maxHeadingDeviationDeg: 14.6,
        maxHeadingDeviationSide: 'right',
        minRunwayEdgeMarginFt: 45.3,
        conservativeRunwayEdgeMarginFt: 27,
        lateralDataQuality: 'low',
        lateralUncertaintyFt: 18.2,
        flags: [{ code: 'rollout_bank', label: 'Noticeable bank during rollout' }],
      },
    });
    const snapshotSection = rolloutSections.find((section) => section.key === 'landing-snapshot');
    assert.equal(
      snapshotSection?.rows.find((row) => row.key === 'bank')?.value,
      '-0.3 deg',
      'landing snapshot should show touchdown bank',
    );
    const rolloutSection = rolloutSections.find((section) => section.key === 'rollout-analysis');
    assert.ok(rolloutSection, 'landing detail should include a separate rollout analysis section');
    assert.equal(
      rolloutSection.rows.find((row) => row.key === 'max-bank')?.value,
      '3.3 deg at 131 kts',
      'rollout detail should show peak ground-roll bank and speed',
    );
    assert.equal(
      rolloutSection.rows.find((row) => row.key === 'edge-margin')?.value,
      '27 ft (aircraft reference point)',
      'rollout detail should show conservative edge margin when precision uncertainty is known',
    );
    assert.match(rolloutSection.noteText, /Separate from the approach stability score/, 'rollout detail should explain scoring separation');
    assert.match(rolloutSection.noteText, /low precision/, 'legacy coordinate uncertainty should be disclosed');
  });

  await test('shared browser environment helpers normalize storage and media-query access', () => {
    resetStoreTestContext();
    const storage = createStorage({ invalidJson: '{"broken":' });

    assert.equal(readStorageValue('missing', { storage, fallback: 'fallback' }), 'fallback', 'missing storage values should use the provided fallback');
    assert.equal(writeStorageValue('theme', 'web3-light', { storage }), true, 'writeStorageValue should report successful writes');
    assert.equal(storage.getItem('theme'), 'web3-light', 'writeStorageValue should persist plain string values');

    assert.equal(writeStorageJson('plan', { route: 'YSSY-KJFK' }, { storage }), true, 'writeStorageJson should report successful writes');
    assert.deepEqual(readStorageJson('plan', { storage }), { route: 'YSSY-KJFK' }, 'readStorageJson should parse previously persisted JSON');
    assert.equal(readStorageJson('invalidJson', { storage, fallback: null }), null, 'readStorageJson should tolerate invalid JSON content');

    assert.equal(removeStorageValue('plan', { storage }), true, 'removeStorageValue should report successful removals');
    assert.equal(storage.getItem('plan'), null, 'removeStorageValue should delete the persisted key');

    assert.equal(
      matchesMedia('(max-width: 640px)', {
        windowRef: { matchMedia(query) { return { matches: query === '(max-width: 640px)' }; } },
      }),
      true,
      'matchesMedia should delegate through the provided window reference',
    );
    assert.equal(matchesMedia('(prefers-reduced-motion: reduce)', { windowRef: {} }), false, 'matchesMedia should fall back safely when no browser API is available');
  });

  console.log('--- tabs store ---\n');
  await test('tabs store normalizes aliases, respects leave guards, and tracks transitions', () => {
    resetStoreTestContext();
    const tabs = useTabsStore();
    assert.equal(tabs.activeTabId, 'flight', 'Overview should be the safe first-render tab');

    tabs.openMoreSheet();
    assert.equal(tabs.moreSheetOpen, true, 'more sheet should open');

    const unregister = tabs.registerBeforeChangeGuard((from, to) => {
      assert.equal(from, 'flight', 'guard should see current tab');
      return to !== 'settings';
    });

    assert.equal(tabs.requestTabChange('settings', { direction: 'forward' }), false, 'guard should block settings transition');
    assert.equal(tabs.activeTabId, 'flight', 'blocked transition should keep the active tab');
    assert.equal(tabs.moreSheetOpen, true, 'blocked transition should not close the more sheet');

    unregister();
    assert.equal(tabs.requestTabChange('systems', { direction: 'forward' }), true, 'alias transition should pass');
    assert.equal(tabs.activeTabId, 'system', '"systems" should normalize to "system"');
    assert.equal(tabs.moreSheetOpen, false, 'successful transition should close the more sheet');
    assert.equal(tabs.takeLastTransitionDirection(), 'forward', 'transition direction should be captured once');
    assert.equal(tabs.takeLastTransitionDirection(), null, 'transition direction should clear after read');

    tabs.setActiveTab('profiles');
    assert.equal(tabs.activeTabId, 'settings', 'legacy Profiles deep links should migrate to advanced Settings');

    tabs.setActiveTab('flight');
    assert.equal(tabs.isMoreTabActive, true, 'mobile more-tab state should light up for hidden tabs');
    assert.equal(tabs.tabSectionClass('flight').active, true, 'tab section classes should mark the active tab');
    assert.equal(tabs.tabSectionClass('livemap').active, false, 'tab section classes should leave inactive tabs hidden');

    tabs.setActiveTab('unknown-tab');
    assert.equal(tabs.activeTabId, 'flight', 'invalid tab ids should fall back to Overview');
    assert.equal(tabs.tabSectionClass('flight').active, true, 'invalid tab fallback should keep Overview visible');

    tabs.beginSectionTransition('settings', 'left');
    assert.equal(tabs.tabSectionClass('settings')['swipe-enter-left'], true, 'transition classes should be state-driven');
    tabs.clearSectionTransition('settings');
    assert.equal(tabs.tabSectionClass('settings')['swipe-enter-left'], false, 'transition classes should clear by tab');

    tabs.showPullRefreshPrompt(false);
    assert.equal(tabs.pullRefreshVisible, true, 'pull-to-refresh prompt should become visible');
    assert.equal(tabs.pullRefreshLabel, 'Pull to reconnect', 'pull-to-refresh prompt should show drag copy');
    tabs.showPullRefreshPrompt(true);
    assert.equal(tabs.pullRefreshLabel, 'Release to reconnect', 'pull-to-refresh prompt should show release copy');
    tabs.startPullRefresh();
    assert.equal(tabs.pullRefreshRefreshing, true, 'pull-to-refresh refreshing state should be tracked');
    assert.equal(tabs.pullRefreshLabel, 'Reconnecting...', 'pull-to-refresh refreshing copy should render from state');
    tabs.clearPullRefresh();
    assert.equal(tabs.pullRefreshVisible, false, 'pull-to-refresh state should clear');
  });

  console.log('\n--- status store ---\n');
  await test('status store exposes state-driven sim and quick-glance visibility', () => {
    resetStoreTestContext();
    const status = useStatusStore();

    assert.equal(status.quickGlanceVisible, false, 'quick glance should start hidden');
    status.ingestMessage({ type: 'phase', value: 'APPROACH' });
    assert.equal(status.quickGlanceVisible, true, 'approach phase should show quick glance');
    status.ingestMessage({ type: 'phase', value: 'CRUISE' });
    assert.equal(status.quickGlanceVisible, false, 'non-approach phase should hide quick glance');

    status.ingestMessage({
      type: 'simState',
      simconnectConnected: true,
      inMenu: true,
      lifecycleState: 'MENU',
      inFlightContext: false,
    });
    assert.equal(status.simInMenu, true, 'sim menu state should come from simState messages');
    assert.match(status.simLabel, /IN MENU/, 'sim badge label should be derived from store state');
    assert.match(status.simToneClass, /amber/, 'sim menu state should use warning tone classes');

    status.setWebsocket('error');
    assert.equal(status.simConnected, false, 'websocket errors should clear stale sim connection state');
    assert.equal(status.simInMenu, false, 'websocket errors should clear stale menu overlay state');
    assert.equal(status.inFlightContext, false, 'websocket errors should clear stale flight context state');

    status.ingestMessage({
      type: 'simState',
      simconnectConnected: true,
      inMenu: false,
      lifecycleState: 'ACTIVE',
      inFlightContext: true,
    });
    assert.equal(status.simInMenu, false, 'authoritative simState false should clear stale menu overlay state');
    assert.match(status.simLabel, /IN FLIGHT/, 'sim badge label should update after leaving menus');

    status.resetTelemetry('simconnectDisconnected');
    assert.equal(status.simInMenu, false, 'reset should clear sim menu state');
    assert.equal(status.quickGlanceVisible, false, 'reset should clear quick glance visibility');
  });

  await test('status store normalizes flat data source messages', () => {
    resetStoreTestContext();
    const status = useStatusStore();

    status.ingestMessage({
      type: 'dataSources',
      primary: {
        type: 'rust-simvars',
        name: 'Rust SimVars',
        connected: true,
        description: 'primary - 138 live',
      },
      secondary: [{
        type: 'lvar-sidecar',
        name: 'LVAR Sidecar',
        connected: false,
      }],
      sources: [
        {
          type: 'rust-simvars',
          name: 'Rust SimVars',
          connected: true,
        },
        {
          type: 'lvar-sidecar',
          name: 'LVAR Sidecar',
          connected: false,
        },
      ],
    });

    assert.equal(status.primarySource.name, 'Rust SimVars', 'primary compatibility field should still be populated');
    assert.equal(status.secondarySources.length, 1, 'secondary compatibility field should still be populated');
    assert.deepEqual(
      status.dataSources.map((source) => source.name),
      ['Rust SimVars', 'LVAR Sidecar'],
      'flat data source list should render all reported sources in order',
    );

    status.ingestMessage({
      type: 'dataSources',
      primary: { type: 'simconnect', name: 'SimConnect', connected: true },
      secondary: [{ type: 'sdk', name: 'SDK Bridge', connected: true }],
    });
    assert.deepEqual(
      status.dataSources.map((source) => source.name),
      ['SimConnect', 'SDK Bridge'],
      'legacy primary/secondary messages should still populate the flat list',
    );

    status.setWebsocket('disconnected');
    assert.equal(status.dataSources.length, 0, 'websocket disconnect should clear stale data source rows');
  });

  await test('status store formats VRE sampling messages for Vue rendering', () => {
    resetStoreTestContext();
    const status = useStatusStore();

    status.ingestMessage({
      type: 'vreSampling',
      active: true,
      band: 'HIGH_FIDELITY',
      rateHz: 10,
      shouldSample: false,
      reason: 'ground_proximity,vs_magnitude',
      phase: 'APPROACH',
      raFt: 240,
      vsFpm: -720,
      intervalMs: 100,
      nextSampleInMs: 40,
      ultraFidelityDisabled: false,
      ultraFidelityTimeRemaining: 59000,
      ultraFidelitySamplesRemaining: 590,
    });

    assert.equal(status.vreSamplingVisible, true, 'active VRE sampling should be visible');
    assert.equal(status.vreSamplingSummaryLabel, 'VRE HIGH 10 Hz', 'summary should render the compact active band');
    assert.equal(status.vreSamplingRateDetail, 'HIGH at 10 Hz (100 ms)', 'legacy messages should keep their rate detail');
    assert.match(status.vreSamplingReasonLabel, /ground proximity/, 'reason should be human-readable');
    assert.match(status.vreSamplingDecisionLabel, /waiting 40 ms/, 'deferred writes should include the next sample wait');
    assert.equal(status.vreSamplingLastLabel, 'APPROACH RA 240 ft VS -720 fpm', 'last-frame context should be formatted');
    assert.equal(status.vreSamplingSafetyLabel, '59000 ms / 590 samples', 'ultra-fidelity budget should render');

    status.ingestMessage({
      type: 'vreSampling',
      active: true,
      band: 'ULTRA_FIDELITY',
      targetRateHz: 10,
      effectiveRateHz: 5,
      rateHz: 5,
      intervalMs: 200,
    });
    assert.equal(status.vreSamplingSummaryLabel, 'VRE ULTRA 5 Hz', 'summary should use the achievable rate');
    assert.equal(
      status.vreSamplingRateDetail,
      'ULTRA at 5 Hz (200 ms; 10 Hz target)',
      'poll-limited messages should distinguish the effective rate from the evaluator target',
    );

    status.ingestMessage({ type: 'vreSampling', active: false });
    assert.equal(status.vreSamplingVisible, false, 'inactive VRE sampling should hide the indicator');
  });

  await test('status store derives assist indicator categories from telemetry', () => {
    resetStoreTestContext();
    const status = useStatusStore();

    status.ingestMessage({
      type: 'assists',
      data: {
        landingAssist: true,
        takeoffAssist: false,
        aiAntistallActive: true,
        unlimitedFuel: true,
        slewActive: true,
      },
    });

    assert.equal(status.assistsVisible, true, 'assist indicator should show when assist settings are active');
    assert.equal(status.activeAssistCount, 3, 'active assist count should exclude informational anti-stall state');
    assert.deepEqual(
      status.activeAssistCategories.map((category) => category.label),
      ['Piloting', 'Simulator Options'],
      'active assists should be grouped into display categories',
    );
    assert.deepEqual(
      status.activeAssistCategories.flatMap((category) => category.items.map((item) => item.name)),
      ['Landing Assist', 'Unlimited Fuel', 'Slew Mode Active'],
      'active assists should expose display names for Vue',
    );

    status.ingestMessage({
      type: 'assists',
      data: {
        aiAntistallActive: true,
      },
    });
    assert.equal(status.assistsVisible, false, 'informational anti-stall state alone should not show the assist warning');
    assert.equal(status.activeAssistCount, 0, 'informational anti-stall state alone should not count as a display assist');

    status.resetTelemetry('aircraftChanged');
    assert.equal(status.assistsVisible, false, 'telemetry reset should clear active assists');
  });

  await test('status store derives recording indicator state from flight recording messages', () => {
    resetStoreTestContext();
    const status = useStatusStore();

    status.ingestMessage({
      type: 'flightRecording',
      status: 'recording',
      filePath: 'C:/Flights/active-flight.csv',
    });

    assert.equal(status.recordingVisible, true, 'recording status should show the indicator');
    assert.equal(status.recordingFailed, false, 'active recording should not be treated as failed');
    assert.equal(status.recordingBadgeLabel, 'REC', 'active recording should use the REC badge');
    assert.equal(status.recordingTitle, 'Recording Flight Log', 'active recording should use the saving title');
    assert.equal(status.recordingDetail, 'C:/Flights/active-flight.csv', 'active recording should show the provided path');

    status.ingestMessage({
      type: 'flightRecording',
      status: 'finalizing',
      fileName: 'active-flight.csv',
    });

    assert.equal(status.recordingVisible, true, 'finalizing status should keep the indicator visible');
    assert.equal(status.recordingFailed, false, 'finalizing should not be treated as failed');
    assert.equal(status.recordingFinalizing, true, 'finalizing status should expose a dedicated flag');
    assert.equal(status.recordingBadgeLabel, 'SAVE', 'finalizing should use the SAVE badge');
    assert.equal(status.recordingTitle, 'Finalizing Flight Log', 'finalizing should explain the save phase');
    assert.equal(status.recordingDetail, 'active-flight.csv', 'finalizing should show the file being saved');

    status.ingestMessage({
      type: 'flightRecording',
      status: 'error',
      error: 'Flight recording finalization failed',
    });

    assert.equal(status.recordingVisible, true, 'recording errors should remain visible');
    assert.equal(status.recordingFailed, true, 'recording errors should use failed state');
    assert.equal(status.recordingBadgeLabel, 'NO REC', 'recording errors should warn that recording is unavailable');
    assert.equal(status.recordingDetail, 'Flight recording finalization failed', 'recording error copy should render from state');

    status.ingestMessage({ type: 'flightRecording', status: 'stopped' });
    assert.equal(status.recordingVisible, false, 'stopped recording should hide the indicator');
    assert.equal(status.recordingStartAvailable, false, 'manual start should stay unavailable before simulator telemetry is live');

    status.ingestMessage({ type: 'simState', simconnectConnected: true, inMenu: false });
    assert.equal(status.recordingStartAvailable, true, 'manual start should be available when simulator telemetry is live and recording is stopped');

    status.ingestMessage({
      type: 'flightRecording',
      status: 'recording',
      filePath: 'C:/Flights/next-flight.csv',
    });
    assert.equal(status.recordingStartAvailable, false, 'manual start should hide while recording is active');
    status.ingestMessage({ type: 'flightTime', elapsedHms: '00:00:13' });
    status.ingestMessage({ type: 'endFlightResult', success: true });
    assert.equal(status.recordingVisible, false, 'successful manual end result should clear stale recording state');
    assert.equal(status.flightTimeLabel, '00:00:00', 'successful manual end result should reset stale flight time');
  });

  await test('status store derives surface badge state from surface messages', () => {
    resetStoreTestContext();
    const status = useStatusStore();

    status.ingestMessage({
      type: 'surface',
      value: {
        onGround: true,
        name: 'GRASS',
        class: 'UNPAVED',
        runwayLike: false,
      },
    });

    assert.equal(status.surfaceVisible, true, 'surface badge should show while on the ground');
    assert.equal(status.surfaceLabel, 'GRASS', 'surface badge should expose the normalized surface name');
    assert.match(status.surfaceToneClass, /amber/, 'unpaved surfaces should use warning tone classes');

    status.ingestMessage({ type: 'surface', value: { onGround: false } });
    assert.equal(status.surfaceVisible, false, 'surface badge should hide when airborne');
  });

  await test('status store derives runway context from runway messages', () => {
    resetStoreTestContext();
    const status = useStatusStore();

    status.ingestMessage({ type: 'runwayContext', icao: 'YSSY', runway: '34L' });
    assert.equal(status.runwayContextVisible, true, 'runway context should show when an airport is present');
    assert.equal(status.runwayContextLabel, 'YSSY 34L', 'runway context should combine airport and runway');

    status.ingestMessage({ type: 'runwayContext', icao: '' });
    assert.equal(status.runwayContextVisible, false, 'runway context should hide when airport context clears');

    status.ingestMessage({ type: 'runwayContext', icao: 'KBOS' });
    status.resetTelemetry('aircraftChanged');
    assert.equal(status.runwayContextVisible, false, 'telemetry reset should clear runway context');
  });

  await test('status store derives header flight time and aircraft profile readouts', () => {
    resetStoreTestContext();
    const status = useStatusStore();

    status.ingestMessage({ type: 'flightTime', elapsedHms: '01:23:45' });
    assert.equal(status.flightTimeLabel, '01:23:45', 'flight time should render from flightTime messages');

    status.ingestMessage({
      type: 'aircraftProfile',
      profile: {
        name: 'Fenix A320 Profile',
        id: 'fenix-a320',
        aircraftTitle: 'Fenix A320 CFM',
      },
      provenance: {
        verificationStatus: 'verified',
        sourceCount: 3,
        lastVerified: '2026-05-01',
      },
    });

    assert.equal(status.aircraftNameLabel, 'Fenix A320 CFM', 'aircraft name should prefer the live sim aircraft title');
    assert.equal(status.aircraftProfile.profileName, 'Fenix A320 Profile', 'profile name should remain available separately');
    assert.equal(status.aircraftProfileNameLabel, 'Fenix A320 Profile', 'profile name label should expose the matched profile');
    assert.equal(status.aircraftProfileNameVisible, true, 'profile name should be visible when it differs from the live sim title');
    assert.equal(status.profileBadgeLabel, '\u2713', 'verified profiles should expose the verified badge');
    assert.match(status.profileBadgeClass, /emerald/, 'verified profiles should use success tone classes');
    assert.match(status.profileBadgeTitle, /Sources: 3/, 'profile badge title should include source count');

    status.ingestMessage({
      type: 'aircraftProfile',
      profile: {
        name: 'PMDG 737 Profile',
        id: 'pmdg-737',
        aircraftTitle: 'PMDG 737-800',
      },
      provenance: {
        verificationStatus: 'partial',
        sourceCount: 2,
        lastVerified: '2026-07-31',
      },
    });
    assert.equal(status.profileBadgeLabel, '', 'partial profile verification should not render a header badge');
    assert.equal(status.profileBadgeTitle, '', 'partial profile verification should not render tooltip copy');

    status.ingestMessage({
      type: 'aircraftProfile',
      profile: {
        name: 'Fallback Profile Name',
        id: 'fallback-profile',
        aircraftTitle: 'SimObjects\\Airplanes\\fallback\\aircraft.cfg',
      },
    });
    assert.equal(status.aircraftNameLabel, 'Fallback Profile Name', 'path-like aircraft titles should fall back to profile name');
    assert.equal(status.aircraftProfileNameVisible, true, 'profile correction controls should remain visible when the profile name duplicates the aircraft label');

    status.resetTelemetry('aircraftChanged');
    assert.equal(status.flightTimeLabel, '00:00:00', 'telemetry reset should clear flight time');
    assert.equal(status.aircraftNameLabel, '--', 'telemetry reset should clear aircraft name');
    assert.equal(status.aircraftProfileNameVisible, false, 'telemetry reset should hide the profile name label');
    assert.equal(status.profileBadgeLabel, '', 'telemetry reset should clear profile badge');
  });

  await test('status store exposes footer connection info', () => {
    resetStoreTestContext();
    const status = useStatusStore();

    assert.equal(status.connectionInfoLabel, 'ws://localhost:8099', 'connection info should start with the default URL');
    status.setConnectionInfo('ws://127.0.0.1:8123');
    assert.equal(status.connectionInfoLabel, 'ws://127.0.0.1:8123', 'connection info should render from runtime updates');
  });

  await test('status store tracks cabin PA playback state internally', () => {
    resetStoreTestContext();
    const status = useStatusStore();

    status.setCabinAnnouncementsState({
      enabled: true,
      available: true,
      muted: false,
      playing: true,
    });

    assert.equal(status.cabinAnnouncements.playing, true, 'PA playback state should be tracked internally');

    status.setCabinAnnouncementsState({ muted: true, playing: false });
    assert.equal(status.cabinAnnouncements.playing, false, 'PA playback state should clear when playback stops');
    assert.equal(status.cabinAnnouncements.muted, true, 'PA muted state should still be tracked internally');
  });

  await test('status store delegates manual recording controls through bound runtime actions', () => {
    resetStoreTestContext();
    const status = useStatusStore();
    const requests = [];

    assert.equal(status.requestStartRecordingManual(), false, 'manual start-recording requests should report when no runtime action is bound');
    assert.equal(status.requestEndFlightManual(), false, 'manual end-flight requests should report when no runtime action is bound');

    status.bindHeaderActions({
      onStartRecordingManual() {
        requests.push('start-recording');
        return true;
      },
      onEndFlightManual() {
        requests.push('end-flight');
        return true;
      },
    });
    assert.equal(status.startRecordingActionBound, true, 'binding the manual start-recording action should expose runtime availability');
    assert.equal(status.endFlightActionBound, true, 'binding the manual end-flight action should expose runtime availability');
    assert.equal(status.requestStartRecordingManual(), false, 'manual start-recording requests should not delegate before simulator telemetry is live');
    assert.deepEqual(requests, [], 'unavailable manual start should not invoke the runtime action');

    status.ingestMessage({ type: 'simState', simconnectConnected: true, inMenu: false });
    status.ingestMessage({ type: 'flightRecording', status: 'stopped' });
    assert.equal(status.requestStartRecordingManual(), true, 'manual start-recording requests should delegate through the bound runtime action');
    assert.equal(status.requestEndFlightManual(), true, 'manual end-flight requests should delegate through the bound runtime action');
    assert.deepEqual(requests, ['start-recording', 'end-flight'], 'manual recording controls should invoke each bound runtime action once');

    status.bindHeaderActions();
    assert.equal(status.startRecordingActionBound, false, 'clearing the manual start-recording action should reset the bound flag');
    assert.equal(status.endFlightActionBound, false, 'clearing the manual end-flight action should reset the bound flag');
  });

  await test('status store exposes system banner state and dismissal', () => {
    const { storage } = resetStoreTestContext();
    const status = useStatusStore();

    assert.equal(status.diskWarningVisible, false, 'disk warning should start hidden');
    assert.equal(status.updateBannerVisible, false, 'update banner should start hidden');
    assert.equal(status.restartRequiredBannerVisible, false, 'restart-required banner should start hidden');

    status.ingestMessage({
      type: 'updateAvailable',
      currentVersion: '0.1.3',
      latestVersion: '0.1.4',
      message: 'Experimental release. Use with care.',
    });
    assert.equal(status.updateBannerVisible, true, 'updateAvailable messages should show the update banner through store ingestion');
    assert.equal(status.updateVersionLabel, 'v0.1.4 Alpha', 'ingested update messages should format the latest version');
    assert.equal(status.updateDownloadUrl, '', 'an update without an approved backend URL should not expose a fallback link');
    status.dismissUpdateBanner(storage);

    status.showDiskWarning({
      message: 'Only 512 MB free on the flight log volume',
      level: 'critical',
      rowsWritten: 42,
    });

    assert.equal(status.diskWarningVisible, true, 'disk warning should show after a disk warning message');
    assert.equal(status.diskWarningMessage, 'Only 512 MB free on the flight log volume', 'disk warning copy should render from state');
    assert.equal(status.systemBannerOffsetVisible, true, 'visible banners should request the body offset');
    assert.equal(status.systemBannerCount, 1, 'one visible banner should produce one banner row');
    assert.equal(status.systemBannerOffsetPx, '40px', 'one visible banner should offset the body by one row');

    status.dismissDiskWarning();
    assert.equal(status.diskWarningVisible, false, 'disk warning should hide when dismissed');

    status.showUpdateBanner({
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      downloadUrl: 'https://github.com/yenbuilds/flight-fabric/releases/latest',
      urgent: true,
    });

    assert.equal(status.updateBannerVisible, true, 'update banner should show after an update message');
    assert.equal(status.updateVersionLabel, 'v0.2.0 Alpha', 'update version should use the alpha display label');
    assert.equal(status.updateMessageLabel, 'Experimental release. Use with care.', 'missing update copy should use the concise alpha warning');
    assert.doesNotMatch(status.updateMessageLabel, /\u2014/, 'update warning should not include an em dash');
    assert.match(status.updateBannerToneClass, /red/, 'urgent updates should use danger tone classes');
    assert.equal(status.updateDownloadUrl, 'https://github.com/yenbuilds/flight-fabric/releases/latest', 'approved download link should render from state');
    assert.equal(status.systemBannerCount, 1, 'one update banner should produce one banner row');
    assert.equal(status.systemBannerOffsetPx, '40px', 'one update banner should offset the body by one row');

    status.showRestartRequiredBanner({ restartReasons: ['Aircraft profile override'] });
    assert.equal(status.restartRequiredBannerVisible, true, 'restart-required banner should show after a restart-required save');
    assert.equal(
      status.restartRequiredMessage,
      'App restart required to apply: Aircraft profile override.',
      'restart-required banner should summarize restart reasons',
    );
    assert.equal(status.systemBannerCount, 2, 'update plus restart-required banners should produce two banner rows');
    assert.equal(status.systemBannerOffsetPx, '80px', 'update plus restart-required banners should offset the body by two rows');

    status.showDiskWarning({ message: 'Only 256 MB free on the flight log volume' });
    assert.equal(status.systemBannerCount, 3, 'simultaneous disk, restart, and update banners should produce three banner rows');
    assert.equal(status.systemBannerOffsetPx, '120px', 'simultaneous disk, restart, and update banners should offset the body by three rows');
    status.dismissDiskWarning();
    status.dismissRestartRequiredBanner();
    assert.equal(status.restartRequiredBannerVisible, false, 'restart-required banner should hide when dismissed');

    status.dismissUpdateBanner(storage);
    assert.equal(status.updateBannerVisible, false, 'update banner should hide when dismissed');
    assert.equal(status.systemBannerCount, 0, 'no visible banners should produce no banner rows');
    assert.equal(status.systemBannerOffsetPx, '', 'no visible banners should clear the body offset');
    assert.equal(storage.getItem('ff-update-dismissed'), '0.2.0', 'dismissed update version should be persisted');

    status.showUpdateBanner({ latestVersion: '0.3.0' });
    assert.doesNotThrow(() => {
      status.dismissUpdateBanner({
        setItem() {
          throw new Error('storage disabled');
        },
      });
    }, 'dismissal should tolerate unavailable browser storage');
    assert.equal(status.updateBannerVisible, false, 'update banner should still hide when storage is unavailable');
  });

  console.log('\n--- app settings store ---\n');
  await test('app settings store applies backend snapshots and delegates saves through a runtime-bound action', () => {
    resetStoreTestContext();
    const appSettings = useAppSettingsStore();
    const savedSettings = [];

    assert.equal(appSettings.saveSettings({ recording: { autoStart: false } }), false, 'settings saves should report when no runtime action is bound');

    appSettings.apply({
      backendVersion: '0.1.3',
      settingsFile: 'C:/Flight Fabric/Settings/settings.json',
      settings: {
        recording: { autoStart: true },
      },
      storage: {
        settingsFile: 'C:/Flight Fabric/Settings/settings.json',
      },
    });
    assert.equal(appSettings.backendVersion, '0.1.3', 'backend version should hydrate from runtime snapshots');
    assert.equal(appSettings.settings.recording.autoStart, true, 'applied settings should hydrate runtime state');

    appSettings.bindRuntimeActions({
      onSaveSettings(nextSettings) {
        savedSettings.push(nextSettings);
        return true;
      },
    });
    assert.equal(appSettings.saveActionBound, true, 'runtime-bound save actions should report as bound');
    assert.equal(appSettings.saveSettings({ recording: { autoStart: false } }), true, 'settings saves should delegate through the runtime-bound action');
    assert.deepEqual(
      savedSettings,
      [{
        recording: { autoStart: false },
      }],
      'settings saves should preserve the submitted payload',
    );

    appSettings.bindRuntimeActions();
    assert.equal(appSettings.saveActionBound, false, 'clearing runtime-bound save actions should reset the bound flag');
  });

  console.log('\n--- simbrief store ---\n');
  await test('SimBrief runway analysis keeps only the planned runway and compact performance fields', () => {
    const sections = buildRunwayAnalysisSections({
      takeoff: {
        conditions: [
          { key: 'airport_icao', value: 'EGLL' },
          { key: 'planned_runway', value: '27L' },
          { key: 'planned_weight', value: '67732' },
          { key: 'surface_condition', value: 'dry' },
          { key: 'wind_direction', value: '339' },
          { key: 'wind_speed', value: '4' },
        ],
        runways: [
          [
            { key: 'identifier', value: '09L' },
            { key: 'length_tora', value: '12799' },
            { key: 'speeds_v1', value: 'WRONG RUNWAY' },
          ],
          [
            { key: 'identifier', value: '27L' },
            { key: 'length_tora', value: '11975' },
            { key: 'length_asda', value: '11975' },
            { key: 'flap_setting', value: '5' },
            { key: 'speeds_v1', value: '144' },
            { key: 'speeds_vr', value: '149' },
            { key: 'speeds_v2', value: '154' },
            { key: 'distance_continue', value: '7300' },
            { key: 'distance_reject', value: '7600' },
            { key: 'distance_margin', value: '4375' },
          ],
        ],
        distanceReports: [],
      },
      landing: {
        conditions: [
          { key: 'airport_icao', value: 'EDDM' },
          { key: 'planned_runway', value: '24' },
          { key: 'planned_weight', value: '63820' },
          { key: 'surface_condition', value: 'wet' },
        ],
        runways: [[
          { key: 'identifier', value: '24' },
          { key: 'length_lda', value: '10820' },
          { key: 'max_weight_wet', value: '70000' },
        ]],
        distanceReports: [
          {
            condition: 'dry',
            fields: [
              { key: 'speeds_vref', value: '130' },
              { key: 'actual_distance', value: '4100' },
            ],
          },
          {
            condition: 'wet',
            fields: [
              { key: 'flap_setting', value: 'FULL' },
              { key: 'speeds_vref', value: '135' },
              { key: 'actual_distance', value: '5300' },
              { key: 'factored_distance', value: '6100' },
            ],
          },
        ],
      },
    });

    assert.equal(sections.length, 2, 'takeoff and landing summaries should both render');
    assert.equal(sections[0].location, 'EGLL · RWY 27L', 'the summary heading should identify the planned runway');
    assert.ok(sections[0].rows.length <= 10, 'takeoff analysis should remain screenshot-friendly');
    assert.match(
      sections[0].rows.find((row) => row.key === 'speeds').value,
      /V1 144.*VR 149.*V2 154/,
      'takeoff speeds should come from the planned runway',
    );
    assert.doesNotMatch(JSON.stringify(sections[0]), /WRONG RUNWAY/, 'non-planned runway data should be omitted');
    assert.equal(
      sections[1].rows.find((row) => row.key === 'vref').value,
      '135',
      'wet landing conditions should select the wet distance report',
    );
    assert.match(
      sections[1].rows.find((row) => row.key === 'landing-distance').value,
      /Actual 5,300.*Factored 6,100/,
      'landing analysis should retain the selected report distances',
    );
  });

  await test('landing wind presentation is explicit, normalized, and honest about missing data', () => {
    const normal = buildLandingWindPresentation({
      windDirectionTrueDeg: 240,
      windSpeed: 14.2,
      crosswind: -8.1,
    });
    assert.equal(normal.directionText, '240°T', 'wind direction should be zero-padded and explicitly true');
    assert.equal(normal.speedText, '14 kt', 'touchdown wind speed should be rounded to knots');
    assert.equal(normal.cardinalText, 'WSW', 'wind direction should include a familiar compass point');
    assert.equal(normal.crosswindDetailText, 'XW 8 kt from left', 'crosswind should retain its runway-relative source side');
    assert.equal(normal.arrowRotationDeg, 240, 'north-up compass arrow should rotate to the wind-from bearing');
    assert.match(normal.ariaLabel, /from 240 degrees true.*14 knots.*from left/, 'wind context should have a complete accessible label');

    const reportedLanding = buildLandingWindPresentation({
      windDirectionTrueDeg: 40,
      windSpeed: 7.4,
      crosswind: -5.3,
    });
    assert.equal(reportedLanding.crosswindText, '5 kt L', 'reported LFPG landing should retain its left runway component');
    assert.equal(reportedLanding.totalText, 'FROM 040°T · 7 kt', 'reported LFPG landing detail should retain its recorded direction and speed');

    const halfKnotCrosswinds = [
      buildLandingWindPresentation({ crosswind: -8.5 }),
      buildLandingWindPresentation({ crosswind: 8.5 }),
    ];
    assert.equal(halfKnotCrosswinds[0].crosswindDetailText, 'XW 9 kt from left', 'left half-knots should round by magnitude');
    assert.equal(halfKnotCrosswinds[1].crosswindDetailText, 'XW 9 kt from right', 'right half-knots should round symmetrically');

    const north = buildLandingWindPresentation({ wind_dir_deg: 360, wind_speed_kts: 7 });
    assert.equal(north.directionText, '360°T', 'north wind should use the conventional aviation 360-degree display');
    assert.equal(north.arrowRotationDeg, 0, '360 degrees should normalize to north for the compass arrow');

    const wrapped = buildLandingWindPresentation({ windDirectionDeg: -10, windSpeed: 11 });
    assert.equal(wrapped.directionText, '350°T', 'negative source bearings should wrap into the compass range');

    const calm = buildLandingWindPresentation({ windDirectionTrueDeg: 120, windSpeed: 0.2, crosswind: 0 });
    assert.equal(calm.directionText, 'CALM', 'near-zero wind should be labelled calm');
    assert.equal(calm.arrowVisible, false, 'calm wind should not imply a meaningful source direction');
    assert.equal(calm.crosswindDetailText, 'No crosswind', 'calm wind should not be labelled as from the right');

    const speedOnly = buildLandingWindPresentation({ wind_speed_kts: 14 });
    assert.equal(speedOnly.available, true, 'legacy records with only speed should still show useful wind context');
    assert.equal(speedOnly.totalText, 'Direction unavailable · 14 kt');
    assert.equal(speedOnly.arrowVisible, false, 'missing direction should not manufacture an arrow');

    const crosswindOnly = buildLandingWindPresentation({ xwindKts: -8 });
    assert.equal(crosswindOnly.available, true, 'indexed records with only crosswind should retain their useful wind context');
    assert.equal(crosswindOnly.totalText, 'From left', 'crosswind-only records should retain the legacy source-side summary');
    assert.equal(crosswindOnly.crosswindDetailText, 'XW 8 kt from left');
    assert.match(crosswindOnly.ariaLabel, /crosswind 8 knots from left/, 'accessible copy should spell out crosswind and units');
    assert.equal(buildLandingWindPresentation().available, false, 'the wind band should hide when every wind fact is absent');

    const detailSections = buildLandingDetailSections({
      type: 'landing',
      wind_dir_deg: 240,
      wind_speed_kts: 14,
      xwind_kts: -8,
    });
    const windRow = detailSections
      .find((section) => section.key === 'landing-snapshot')
      ?.rows.find((row) => row.key === 'wind');
    assert.equal(windRow?.value, 'FROM 240°T · 14 kt · XW 8 kt from left', 'timeline detail should retain absolute and runway-relative wind context');
  });

  await test('simbrief store restores cached plans and delegates fetch and relay work through runtime-bound actions', async () => {
    const storage = createStorage({
      ff_simbriefUsername: 'captain-test',
      ff_flightPlan: JSON.stringify({
        username: 'captain-test',
        fetchedAt: Date.UTC(2026, 4, 27, 10, 30, 0),
        origin: 'YSSY',
        destination: 'WSSS',
        route: 'YSSY DCT WSSS',
      }),
    });
    resetStoreTestContext({ storage });
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const fetchCalls = [];
    let runtimeHttpBase = 'http://127.0.0.1:8100';
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            ofp: {
              general: {
                flight_number: 'QFA81',
                initial_altitude: '36000',
                cruise_mach: '0.84',
                route: 'YSSY DCT WSSS',
                costindex: '48',
                route_distance: '3390',
                avg_wind_comp: '-22',
              },
              params: { units: 'kgs', airac: '2607', time_generated: '1781500000' },
              origin: { icao_code: 'YSSY', name: 'Sydney', plan_rwy: '34L' },
              destination: { icao_code: 'WSSS', name: 'Singapore Changi', plan_rwy: '02C' },
              alternate: { icao_code: 'WMKK' },
              aircraft: { icaocode: 'A388', name: 'Airbus A380-800' },
              times: { est_time_enroute: '28800', est_in: '1781530000', taxi_out: '900' },
              fuel: { plan_ramp: '248000', enroute_burn: '180000', plan_landing: '57000' },
              weights: { pax_count: '420', payload: '51000', est_zfw: '360000' },
              weather: {
                dest_metar: 'WSSS 141100Z 18008KT 9999 FEW018 30/25 Q1009',
                dest_taf: 'TAF WSSS 141100Z 1412/1518 18008KT 9999 FEW018',
                etops_metar: {
                  BIKF: 'BIKF 141100Z 18008KT 9999 FEW018 12/08 Q1016',
                  EINN: 'EINN 141130Z 22012KT 9999 SCT020 14/09 Q1012',
                },
                etops_taf: {
                  BIKF: 'TAF BIKF 141100Z 1412/1518 18008KT 9999 FEW018',
                  EINN: 'TAF EINN 141100Z 1412/1518 22012KT 9999 SCT020',
                },
              },
              navlog: { fix: [{ ident: 'YSSY', type: 'apt', altitude_feet: '21', distance: '0' }, { ident: 'TESAT', type: 'wpt', altitude_feet: '36000', distance: '88' }] },
              tlr: {
                landing: {
                  conditions: { airport_icao: 'WSSS', planned_runway: '02C', surface_condition: 'wet' },
                  distance_dry: { speeds_vref: '136', actual_distance: '5200' },
                  distance_wet: { speeds_vref: '141', actual_distance: '6400', factored_distance: '7200' },
                  runway: { identifier: '02C', length_lda: '13123', max_weight_wet: '750000' },
                },
              },
              atc: { callsign: 'QFA81', flightplan_text: '(FPL-QFA81-IS-A388/H-YSSY-WSSS)' },
            },
          };
        },
      };
    };
    globalThis.setTimeout = (callback) => {
      callback();
      return 1;
    };
    globalThis.clearTimeout = () => {};
    try {
      const simbrief = useSimbriefStore();
      assert.equal(simbrief.relayPlan(), false, 'SimBrief relay should report when no runtime action is bound');

      simbrief.restore();
      assert.equal(simbrief.username, 'captain-test', 'restore should hydrate the saved SimBrief username');
      assert.equal(simbrief.plan.origin, 'YSSY', 'restore should hydrate the cached OFP plan');

      const relayedPayloads = [];
      simbrief.bindRuntime({
        sendMessage(payload) {
          relayedPayloads.push(payload);
          return true;
        },
        httpBase: runtimeHttpBase,
        getHttpBase() {
          return runtimeHttpBase;
        },
        async copyRouteText(route) {
          relayedPayloads.push({ type: 'copied-route', route });
          return true;
        },
      });
      assert.equal(simbrief.relayActionBound, true, 'runtime-bound SimBrief relay actions should report as bound');
      assert.equal(simbrief.copyRouteActionBound, true, 'runtime-bound SimBrief copy actions should report as bound');
      assert.equal(simbrief.backendHttpBase, 'http://127.0.0.1:8100', 'runtime HTTP base should be stored for SimBrief fetches');
      assert.equal(simbrief.relayPlan(), true, 'cached OFP relay should delegate through the runtime action');
      assert.equal(relayedPayloads.length, 1, 'cached OFP relay should send one websocket payload');

      assert.equal(await simbrief.copyRoute(), true, 'copyRoute should delegate through the runtime-bound clipboard action');
      assert.deepEqual(relayedPayloads[1], { type: 'copied-route', route: 'YSSY DCT WSSS' }, 'copyRoute should forward the active route text to the runtime');
      assert.equal(simbrief.copyLabel, 'Copy', 'copyRoute should reset its button label after the timer runs');

      simbrief.username = 'captain-test';
      runtimeHttpBase = 'http://127.0.0.1:9300';
      await simbrief.fetchOfp();
      assert.equal(simbrief.fetchInProgress, false, 'fetchOfp should clear the in-progress flag after completion');
      assert.deepEqual(fetchCalls, [
        'http://127.0.0.1:9300/api/simbrief?username=captain-test',
      ], 'fetchOfp should use the live backend HTTP base instead of the initially bound fallback');
      assert.equal(simbrief.backendHttpBase, 'http://127.0.0.1:9300', 'fetchOfp should refresh the stored backend HTTP base');
      assert.equal(simbrief.plan.callsign, 'QFA81', 'fetchOfp should normalize the returned OFP into store state');
      assert.equal(simbrief.plan.aircraft, 'A388', 'fetchOfp should normalize aircraft metadata');
      assert.equal(simbrief.plan.departureRunway, '34L', 'fetchOfp should normalize the SimBrief departure runway');
      assert.equal(simbrief.plan.arrivalRunway, '02C', 'fetchOfp should normalize the SimBrief arrival runway');
      assert.equal(simbrief.plan.weightUnit, 'kg', 'fetchOfp should preserve the OFP weight unit');
      assert.equal(simbrief.plan.weather.destinationMetar.startsWith('WSSS'), true, 'fetchOfp should retain destination planning weather');
      assert.equal(
        simbrief.plan.weather.etopsMetar,
        'BIKF 141100Z 18008KT 9999 FEW018 12/08 Q1016\nEINN 141130Z 22012KT 9999 SCT020 14/09 Q1012',
        'fetchOfp should flatten keyed ETOPS METAR reports into readable text',
      );
      assert.equal(
        simbrief.plan.weather.etopsTaf,
        'TAF BIKF 141100Z 1412/1518 18008KT 9999 FEW018\nTAF EINN 141100Z 1412/1518 22012KT 9999 SCT020',
        'fetchOfp should flatten keyed ETOPS TAF reports into readable text',
      );
      assert.equal(simbrief.plan.fuel.trip, 180000, 'fetchOfp should normalize the detailed fuel breakdown');
      assert.equal(simbrief.plan.weights.payload, 51000, 'fetchOfp should normalize payload and weight data');
      assert.equal(simbrief.plan.navlog.length, 2, 'fetchOfp should normalize the detailed waypoint navlog');
      assert.equal(simbrief.plan.tlr.landing.distanceReports.length, 2, 'fetchOfp should retain dry and wet landing distance reports');
      assert.match(simbrief.plan.icaoFlightPlan, /FPL-QFA81/, 'fetchOfp should retain the ICAO flight plan text');
      assert.equal(relayedPayloads.length, 3, 'fetchOfp should relay the normalized OFP through the bound runtime action');
      assert.equal(storage.getItem('ff_simbriefUsername'), 'captain-test', 'fetchOfp should persist the sanitized username');
      assert.match(simbrief.status, /OFP loaded successfully/, 'fetchOfp should publish success status through the store');

      assert.equal(simbrief.clearOfp(), true, 'clearOfp should delegate the cleared-flight-plan payload through the runtime action');
      assert.deepEqual(
        relayedPayloads[3],
        { type: 'flightPlan', cleared: true, username: '' },
        'clearOfp should send the cleared-flight-plan payload through the runtime action',
      );
    } finally {
      if (originalFetch) globalThis.fetch = originalFetch;
      else delete globalThis.fetch;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  await test('simbrief store falls back to Electron IPC when renderer fetch cannot reach backend', async () => {
    resetStoreTestContext();
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];
    const ipcCalls = [];
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      throw new Error('Failed to fetch');
    };

    try {
      const simbrief = useSimbriefStore();
      const relayedPayloads = [];
      simbrief.bindRuntime({
        sendMessage(payload) {
          relayedPayloads.push(payload);
          return true;
        },
        httpBase: 'http://127.0.0.1:8100',
        getHttpBase() {
          return 'http://127.0.0.1:8100';
        },
        async fetchSimbrief(username) {
          ipcCalls.push(username);
          return {
            ok: true,
            status: 200,
            body: {
              ok: true,
              ofp: {
                general: {
                  flight_number: 'VOZ900',
                  initial_altitude: '39000',
                  route: 'YBBN DCT YMML',
                },
                origin: { icao_code: 'YBBN', name: 'Brisbane', plan_rwy: '01L' },
                destination: { icao_code: 'YMML', name: 'Melbourne', plan_rwy: '16' },
                aircraft: { icaocode: 'B738', name: 'Boeing 737-800' },
                times: { est_time_enroute: '7200' },
                fuel: { plan_ramp: '42100' },
                atc: { callsign: 'VOZ900' },
              },
            },
          };
        },
      });

      simbrief.username = 'captain-test';
      await simbrief.fetchOfp();

      assert.deepEqual(fetchCalls, [
        'http://127.0.0.1:8100/api/simbrief?username=captain-test',
      ], 'renderer fetch should still try the backend proxy first');
      assert.deepEqual(ipcCalls, ['captain-test'], 'Electron IPC fallback should receive the sanitized username');
      assert.equal(simbrief.error, '', 'successful IPC fallback should clear the visible error');
      assert.equal(simbrief.plan.origin, 'YBBN', 'IPC fallback should normalize the returned OFP');
      assert.equal(simbrief.plan.destination, 'YMML', 'IPC fallback should populate destination');
      assert.equal(relayedPayloads.length, 1, 'IPC fallback should relay the normalized OFP');
      assert.match(simbrief.status, /OFP loaded successfully/, 'IPC fallback should publish success status');
    } finally {
      if (originalFetch) globalThis.fetch = originalFetch;
      else delete globalThis.fetch;
    }
  });

  console.log('\n--- flight telemetry store ---\n');
  await test('flight store formats live telemetry and resets without losing fuel unit', () => {
    resetStoreTestContext();
    const flight = useFlightStore();

    flight.updateFuelDisplay({ displayValue: '1,234', unit: 'kg', totalGal: 406, totalWeightLbs: 2720 });
    flight.updateSpeedDisplay({ ias: 142.4, gs: 151.8 });
    flight.updateVerticalSpeedDisplay(-780.4);
    flight.updateAltitudeDisplay({
      msl: 3450.2,
      indicated: 3450.2,
      calibrated: 3298.7,
      plane: 3295.1,
      pressureAlt: 3560.6,
      ra: 184.9,
      aircraftAgl: 176.2,
      aircraftAboveObstacles: 164.8,
      planeAgl: 164.7,
      planeAglMinusCg: 158.1,
      kohlsmanSettingMb: 1013.25,
      kohlsmanTunedMb: 1008.4,
      kohlsmanStd: true,
    });
    flight.updateHeadingDisplay({ mag: 87.2 });
    flight.updateCrosswindDisplay(-18.2);
    flight.updateGear({ nose: 1, left: 1, right: 0.2, parkingBrake: true });
    flight.updateFlaps({ value: { notch: 5, percent: 20, label: '5' } });
    flight.updateSpoilers({ state: 'ARMED' });
    flight.updateEngineDisplay({ count: 3, eng1Text: '44%', eng2Text: '45%', eng3Text: '46%' });
    flight.updateEnvironment({ cabinAltFt: 12050, cabinAltRateFpm: -650, oatC: -12 });
    flight.updateLights({ nav: true, beacon: false, strobe: true, landing: false, taxi: true });

    assert.equal(flight.telemetry.ias, '142', 'IAS should round to a display string');
    assert.equal(flight.telemetry.gs, '152', 'ground speed should round to a display string');
    assert.equal(flight.telemetry.vs, '-780', 'vertical speed should round to a display string');
    assert.equal(flight.telemetry.tones.vs, 'warning', 'moderate descent should tint warning');
    assert.equal(flight.telemetry.alt, '3,450', 'altitude should render with thousands separators');
    assert.equal(flight.telemetry.ra, '185', 'radio altitude should render below the display threshold');
    assert.equal(flight.telemetry.raVisible, true, 'radio altitude card should be visible below threshold');
    assert.deepEqual(flight.telemetry.altitudeDiagnostics, {
      indicated: '3,450',
      calibrated: '3,299',
      plane: '3,295',
      pressure: '3,561',
      radio: '185',
      aircraftAgl: '176',
      aircraftAboveObstacles: '165',
      planeAgl: '165',
      planeAglMinusCg: '158',
      kohlsmanSettingMb: '1013.25',
      kohlsmanTunedMb: '1008.40',
      kohlsmanStd: 'STD',
    }, 'altitude diagnostics should retain independent references and barometer state');

    flight.updateAltitudeDisplay({ msl: 3460.4, indicated: 3460.4, ra: 190.1 });
    assert.deepEqual(flight.telemetry.altitudeDiagnostics, {
      indicated: '3,460',
      calibrated: '-----',
      plane: '-----',
      pressure: '-----',
      radio: '190',
      aircraftAgl: '----',
      aircraftAboveObstacles: '----',
      planeAgl: '----',
      planeAglMinusCg: '----',
      kohlsmanSettingMb: '----.--',
      kohlsmanTunedMb: '----.--',
      kohlsmanStd: '--',
    }, 'altitude snapshots should clear optional values that are no longer available');
    assert.equal(flight.telemetry.hdg, '087', 'heading should be zero-padded');
    assert.equal(flight.telemetry.xwind, '18', 'crosswind should display absolute rounded speed');
    assert.equal(flight.telemetry.xwindArrow, '\u2192', 'negative crosswind should point right');
    assert.equal(flight.telemetry.tones.xwind, 'danger', 'strong crosswind should tint danger');
    assert.equal(flight.telemetry.fuel, '1,234', 'converted fuel display should be stored');
    assert.equal(flight.telemetry.fuelUnit, 'kg', 'fuel unit should be stored');
    assert.equal(flight.telemetry.tones.fuel, 'warning', 'low remaining gallons should tint warning');

    flight.updateFuelDisplay({ displayValue: '2,268', unit: 'kg', totalGal: null, totalWeightLbs: 5000 });
    assert.equal(flight.telemetry.fuel, '2,268', 'mass-only fuel should remain displayable');
    assert.equal(flight.telemetry.tones.fuel, null, 'unknown fuel volume must not be coerced to a zero-gallon warning');

    flight.updateCrosswindDisplay(null);
    assert.equal(flight.telemetry.xwind, '--', 'missing crosswind should remain unknown');
    assert.equal(flight.telemetry.tones.xwind, null, 'missing crosswind should not carry a warning tone');
    assert.equal(flight.telemetry.gearState, 'TRANSIT', 'mixed gear positions should show transit');
    assert.match(flight.gearDotClass('left'), /down/, 'down gear should expose the down class');
    assert.match(flight.gearDotClass('right'), /transit/, 'partial gear should expose the transit class');
    assert.match(flight.parkingBrakeClass, /set/, 'parking brake should expose set state');
    flight.updateGear({ gearState: 'DOWN', locked: true, nose: 0, left: 0, right: 0, parkingBrake: true });
    assert.equal(flight.telemetry.gearState, 'DOWN', 'backend DOWN gear state should override raw zero positions');
    assert.match(flight.gearDotClass('nose'), /down/, 'backend DOWN state should show nose gear down');
    assert.match(flight.gearDotClass('left'), /down/, 'backend DOWN state should show left gear down');
    assert.match(flight.gearDotClass('right'), /down/, 'backend DOWN state should show right gear down');
    assert.equal(flight.telemetry.flaps, '5', 'flaps notch label should render');
    assert.equal(flight.telemetry.spoilers, 'ARMED', 'spoiler state should render');
    assert.equal(flight.engineCards[2].visible, true, 'third engine should be visible when count is 3');
    assert.equal(flight.engineCards[3].visible, false, 'fourth engine should remain hidden when count is 3');
    assert.equal(flight.telemetry.cabinAlt, '12,050', 'cabin altitude should format');
    assert.equal(flight.telemetry.tones.cabinAlt, 'warning', 'high cabin altitude should tint warning');
    assert.equal(flight.telemetry.cabinVs, '-650', 'cabin vertical speed should format');
    assert.equal(flight.telemetry.tones.cabinVs, 'warning', 'cabin vertical speed should tint warning');
    assert.equal(flight.telemetry.oat, '-12', 'outside air temperature should render');
    assert.equal(flight.telemetry.lights.nav, true, 'light state should render');
    assert.equal(flight.telemetry.lights.strobe, true, 'strobe light state should render');

    flight.updateSpeedWarning({ type: 'overspeed', active: true, overspeedType: 'vfe' });
    assert.equal(flight.speedWarningVisible, true, 'active speed warnings should render');
    assert.equal(flight.speedWarningLabel, 'FLAP OVERSPEED', 'flap overspeed should use the specific warning label');

    flight.showFuelExhaustedWarning({ exhausted: true });
    assert.equal(flight.fuelExhaustedWarningVisible, true, 'fuel exhausted warning should render');
    flight.hideFuelExhaustedWarning();
    assert.equal(flight.fuelExhaustedWarningVisible, false, 'fuel exhausted warning should hide through the store');

    flight.updateCabinAltitudeWarning({ active: true, severity: 'critical', cabinAltFt: 14500 });
    assert.equal(flight.cabinAltitudeBannerVisible, true, 'critical cabin altitude should show the banner');
    assert.equal(flight.cabinAltitudeBannerLabel, 'CABIN ALT 14,500 FT', 'cabin altitude warning should format the altitude');
    assert.equal(flight.cabinAltCardToneClass, 'border-red-500', 'critical cabin altitude should tint the card red');
    flight.hideCabinAltitudeBanner();
    assert.equal(flight.cabinAltitudeBannerVisible, false, 'cabin altitude banner should be dismissible independently');

    flight.ingestMessage({ type: 'flaps', value: { notch: 4, label: 'FULL', percent: 100 } });
    flight.ingestMessage({ type: 'engines', data: { count: 4, eng1Text: '51%', eng2Text: '52%', eng3Text: '53%', eng4Text: '54%' } });
    flight.ingestMessage({ type: 'fuel', totalGal: 123.4, totalWeightLbs: 827 });
    assert.equal(flight.telemetry.flaps, 'FULL', 'raw websocket ingestion should update flaps directly');
    assert.deepEqual(flight.telemetry.engines.values, ['51%', '52%', '53%', '54%'], 'raw websocket ingestion should update engines directly');
    assert.equal(flight.telemetry.fuel, '375', 'raw websocket ingestion should use authoritative fuel mass for the current display unit');

    flight.updateLandingPreview({
      final: true,
      vs: -300,
      grade: 'Good',
      ultimateStability: { score: null },
    });
    assert.equal(flight.lastLanding.stability, 'NO VERDICT', 'landing preview should explicitly distinguish missing stability from a 0% score');

    flight.updateLandingPreview({
      final: true,
      vs: -280,
      grade: 'GOOD',
      ultimateStability: { score: 88 },
    });
    assert.equal(flight.lastLanding.stability, 'NO VERDICT', 'a score-only preview should not invent a stable approach verdict');
    assert.equal(flight.lastLanding.stabilityScore, 'Approach score 88%', 'a score-only preview should retain the explicitly scoped score');

    flight.updateLandingPreview({
      final: true,
      vs: -243,
      grade: 'PERFECT',
      runwayExcursion: true,
      touchdownDistance: { distanceFt: 600, grade: 'Outstanding', bounceCount: 1, bounceGrade: 'Single Bounce' },
      ultimateStability: { verdict: 'unstable', score: 84, gateStable: false },
    });
    assert.equal(flight.lastLanding.grade, 'PERFECT', 'last-landing preview should preserve the explicitly scoped touchdown grade');
    assert.equal(flight.lastLanding.stability, 'UNSTABLE', 'last-landing preview should expose the approach verdict independently');
    assert.equal(flight.lastLanding.stabilityScore, 'Approach score 84%', 'last-landing preview should keep the percentage subordinate and labelled');
    assert.equal(flight.lastLanding.bounce, '1x', 'last-landing preview should expose the bounce result independently');
    assert.equal(flight.lastLanding.stabilityTone, 'text-red-400', 'an unstable approach should carry a danger tone');
    assert.equal(flight.lastLanding.bounceTone, 'text-amber-400', 'a single bounce should carry a warning tone');
    assert.equal(flight.lastLanding.tdz, '600 ft', 'last-landing preview should expose TDZ distance independently');
    assert.equal(flight.lastLanding.tdzDetail, 'Outstanding · Runway excursion', 'last-landing preview should retain separate TDZ and excursion facts');
    assert.equal(flight.lastLanding.tdzTone, 'text-red-400', 'runway excursion should retain its critical TDZ tone');

    flight.resetLiveTelemetry();
    assert.equal(flight.telemetry.ias, '---', 'reset should restore default IAS');
    assert.equal(flight.telemetry.raVisible, false, 'reset should hide the radio altitude card');
    assert.equal(flight.telemetry.fuelUnit, 'kg', 'reset should preserve the selected fuel unit');
    assert.equal(flight.telemetry.lights.available, true, 'reset should restore lights availability');
    assert.equal(flight.speedWarningVisible, false, 'reset should clear speed warnings');
    assert.equal(flight.fuelExhaustedWarningVisible, false, 'reset should clear fuel warnings');
    assert.equal(flight.cabinAltCardToneClass, 'border-surface-200', 'reset should restore cabin card tone');
  });

  console.log('\n--- aircraft controls store ---\n');
  await test('aircraft-specific store scopes snapshots to the active profile revision and resets safely', () => {
    resetStoreTestContext();
    const aircraftSpecific = useAircraftSpecificStore();

    aircraftSpecific.applyProfile({
      id: 'pmdg-737',
      namespace: 'bundled',
      simulator: 'msfs',
      _profileKey: 'bundled/msfs/pmdg-737',
      profileRevision: 12,
      aircraftSpecificTemplateId: 'pmdg-737',
    });
    assert.equal(aircraftSpecific.hasTemplate, true, 'supported profiles should activate their trusted template');
    const requestedActions = [];
    aircraftSpecific.bindRuntimeActions({
      requestAction(actionId, options) {
        requestedActions.push({ actionId, options });
        return true;
      },
    });

    const staleRevisionAccepted = aircraftSpecific.ingestState({
      profileKey: 'bundled/msfs/pmdg-737',
      profileRevision: 11,
      templateId: 'pmdg-737',
      available: true,
      sourceStatus: { overall: 'connected', sources: { lvar: 'connected' } },
      values: { 'afds.cmdA': true },
    });
    assert.equal(staleRevisionAccepted, false, 'snapshots from a stale profile revision should be ignored');
    assert.deepEqual(aircraftSpecific.values, {}, 'rejected snapshots should not leak previous-aircraft values');

    const accepted = aircraftSpecific.ingestState({
      profileKey: 'bundled/msfs/pmdg-737',
      profileRevision: 12,
      templateId: 'pmdg-737',
      available: true,
      sourceStatus: {
        overall: 'connected',
        sources: { lvar: 'stale', sdk: 'connected' },
      },
      values: { 'afds.cmdA': true, 'afds.cmdB': false },
      unavailable: ['gear.noseSafe'],
      actionCapabilities: { 'apu.start': true, 'apu.stop': false, 'mcp.heading.set': true },
      dependencies: {
        mobiflightEventModule: {
          required: true,
          connected: false,
          status: 'missing',
          scope: 'all-controls',
          error: 'must be removed',
        },
        forgedDependency: { required: true },
      },
      updatedAt: '2026-07-13T02:00:00.000Z',
    });
    assert.equal(accepted, true, 'matching snapshots should be accepted');
    assert.equal(aircraftSpecific.values['afds.cmdB'], false, 'explicit false values should remain distinct from unavailable values');
    assert.deepEqual(aircraftSpecific.unavailable, ['gear.noseSafe'], 'field-level unavailable state should be retained');
    assert.equal(aircraftSpecific.sourceStatus, 'connected', 'templates should receive only the provider-neutral aggregate status');
    assert.deepEqual(aircraftSpecific.sourceStatuses, { lvar: 'stale', sdk: 'connected' }, 'provider health should remain available to the shell for diagnostics');
    assert.deepEqual(aircraftSpecific.dependencies, {
      mobiflightEventModule: {
        required: true,
        fallbackActive: false,
        connected: false,
        status: 'missing',
        scope: 'all-controls',
      },
    }, 'only the bounded MobiFlight dependency status should reach aircraft components');
    assert.equal(
      aircraftSpecific.controlsSetupRequired,
      true,
      'a missing required control dependency should drive the shared setup indicator',
    );
    assert.equal(aircraftSpecific.requestAction('apu.unknown'), false, 'undeclared aircraft actions should fail closed');
    assert.equal(aircraftSpecific.requestAction('apu.stop'), false, 'explicitly unsupported aircraft actions should fail closed');
    assert.equal(
      aircraftSpecific.requestAction('apu.start', { pendingKey: 'aircraft-specific-group:apu' }),
      true,
      'supported logical actions should delegate to the guarded runtime bridge',
    );
    assert.equal(
      aircraftSpecific.requestAction('mcp.heading.set', {
        pendingKey: 'aircraft-specific-group:mcp.headingDeg',
        value: 275,
      }),
      true,
      'bounded logical input metadata should delegate without exposing an SDK payload',
    );
    assert.deepEqual(
      requestedActions,
      [
        { actionId: 'apu.start', options: { pendingKey: 'aircraft-specific-group:apu' } },
        {
          actionId: 'mcp.heading.set',
          options: { pendingKey: 'aircraft-specific-group:mcp.headingDeg', value: 275 },
        },
      ],
      'the store action bridge should pass only logical action input and UI pending metadata',
    );

    aircraftSpecific.applySimState({ simconnectConnected: true, inMenu: true });
    assert.equal(aircraftSpecific.sourceStatus, 'paused', 'menu state should pause aircraft-specific data');
    assert.deepEqual(aircraftSpecific.values, {}, 'menu state should clear live values');
    assert.deepEqual(aircraftSpecific.actionCapabilities, {}, 'menu state should clear aircraft-specific write capabilities');
    assert.equal(aircraftSpecific.dependencies.mobiflightEventModule.status, 'missing', 'menu pauses should retain the detected optional dependency state');
    assert.equal(aircraftSpecific.controlsSetupRequired, true, 'menu pauses should retain the known setup requirement');
    assert.equal(aircraftSpecific.hasTemplate, true, 'menu pauses should preserve the selected template');

    aircraftSpecific.prepareForAircraftChange();
    assert.equal(aircraftSpecific.hasTemplate, false, 'aircraft changes should remove the previous template until the new profile arrives');
    assert.equal(aircraftSpecific.activeProfileKey, null, 'aircraft changes should clear the previous profile token');
  });

  await test('aircraft controls store centralizes availability, feedback, autopilot readouts, and runtime-bound commands', async () => {
    resetStoreTestContext();
    const controls = useAircraftControlsStore();
    const autopilotPulseIds = [
      'autothrottle',
      'verticalSpeedHold',
      'altitudeHold',
      'machHold',
      'headingHold',
      'flightDirector',
      'apMaster',
      'apDisconnect',
      'app',
      'loc',
      'nav1',
      'ins',
      'backcourse',
    ];

    assert.equal(controls.availability.enabled, false, 'availability should start disabled');
    assert.equal(controls.feedback.actionText, 'No command sent yet.', 'feedback should start with the default action copy');
    assert.equal(controls.autopilot.master, null, 'initial AP master should be unknown until telemetry arrives');
    assert.equal(controls.autopilot.athrActive, null, 'initial A/T state should be unknown until telemetry arrives');
    assert.equal(controls.autopilot.spdDisplay, '---', 'autopilot selectors should start reset');
    assert.equal(controls.isCommandPending({ type: 'preset', id: 'gearUp' }), false, 'control pending state should start cleared');
    assert.equal(await controls.requestControlCommand({ type: 'preset', id: 'gearUp' }), false, 'control requests should report when no runtime action is bound');
    for (const pulseId of autopilotPulseIds) {
      assert.equal(controls.controlCapabilities.autopilotPulse[pulseId], false, `${pulseId} pulse capability should default closed`);
      assert.equal(controls.isCommandSupported({ type: 'autopilot-pulse', id: pulseId }), false, `${pulseId} should require an explicit active-profile capability`);
    }
    assert.equal(controls.controlCapabilities.lights.landing, false, 'generic light writes should default closed until profile capabilities arrive');
    assert.equal(controls.isCommandSupported({ type: 'light-set', light: 'landing', value: true }), false, 'light commands should require an explicit active-profile capability');

    controls.setAvailability({
      enabled: true,
      reason: 'Ready. Commands are checked against the active profile and provider safety gate.',
    });
    controls.setFeedback({
      actionText: 'AP master toggle',
      routeText: 'Sending control request...',
      profileText: 'bundled/msfs/generic',
    });
    controls.updateAutopilot({
      master: true,
      athrArmed: true,
      fdActive: true,
      spdHold: true,
      hdgHold: true,
      altHold: false,
      vsHold: true,
      navHold: true,
      apprHold: false,
      lvlChgHold: true,
      spdTarget: 246.8,
      hdgTarget: 87.2,
      altTarget: 12450,
      vsTarget: -702,
    });

    assert.equal(controls.availability.enabled, true, 'availability should be store-backed');
    assert.equal(controls.availability.reason, 'Ready. Commands are checked against the active profile and provider safety gate.', 'availability reason should be store-backed');
    assert.equal(controls.feedback.profileText, 'bundled/msfs/generic', 'profile feedback should be store-backed');
    assert.equal(controls.autopilot.master, true, 'autopilot master should be store-backed');
    assert.equal(controls.autopilot.athrArmed, true, 'autothrottle armed state should be store-backed');
    assert.equal(controls.autopilot.locHold, true, 'LOC hold should honor the navHold fallback');
    assert.equal(controls.autopilot.flcHold, true, 'FLC hold should be store-backed');
    assert.equal(controls.autopilot.spdDisplay, '247', 'speed selector display should round the MCP target');
    assert.equal(controls.autopilot.hdgDisplay, '087', 'heading selector display should pad the MCP target');
    assert.equal(controls.autopilot.altDisplay, '12,450', 'altitude selector display should be formatted');
    assert.equal(controls.autopilot.vsDisplay, '-702', 'vertical speed selector display should be signed');

    controls.updateAutopilot({
      master: null,
      athrArmed: null,
      athrActive: null,
      fdActive: null,
      spdHold: null,
      hdgHold: null,
      altHold: null,
      vsHold: null,
      locHold: null,
      navHold: null,
      apprHold: null,
      lvlChgHold: null,
    });
    assert.equal(controls.autopilot.master, null, 'unknown AP master should stay unknown instead of becoming false');
    assert.equal(controls.autopilot.athrActive, null, 'unknown A/T active should stay unknown instead of becoming false');
    assert.equal(controls.autopilot.locHold, null, 'unknown LOC/NAV hold should stay unknown instead of becoming false');
    assert.equal(controls.autopilot.flcHold, null, 'unknown FLC hold should stay unknown instead of becoming false');

    controls.updateAutopilot({}, { ias: 140, hdg: 91, alt: 12200, vs: -20000 });
    assert.equal(controls.autopilot.spdDisplay, '140', 'missing speed target should fall back to live IAS');
    assert.equal(controls.autopilot.hdgDisplay, '091', 'missing heading target should fall back to live heading');
    assert.equal(controls.autopilot.altDisplay, '12,200', 'missing altitude target should fall back to live altitude');
    assert.equal(controls.autopilot.vsDisplay, '----', 'missing vertical speed target should not fall back to live aircraft V/S');

    controls.updateAutopilot({
      master: true,
      athrArmed: true,
      fdActive: true,
      spdHold: true,
      hdgHold: true,
      altHold: false,
      vsHold: true,
      navHold: true,
      apprHold: false,
      lvlChgHold: true,
      spdTarget: 246.8,
      hdgTarget: 87.2,
      altTarget: 12450,
      vsTarget: -702,
    });
    assert.equal(controls.isCommandDisabled({ type: 'preset', id: 'gearUp' }), false, 'available controls should not report disabled while idle');
    controls.applyControlCapabilities({
      surface: {
        gearUp: false,
        parkingBrake: true,
      },
      lights: {
        landing: true,
      },
      autopilot: {
        flightLevelChange: false,
        loc: false,
        heading: false,
      },
      autopilotPulse: {
        autothrottle: false,
        apMaster: true,
        ins: true,
      },
    });
    assert.equal(controls.isCommandSupported({ type: 'preset', id: 'gearUp' }), false, 'unsupported surface writes should be capability-gated');
    assert.equal(controls.isCommandDisabled({ type: 'preset', id: 'gearUp' }), true, 'unsupported surface writes should render disabled');
    assert.equal(controls.isCommandSupported({ type: 'preset', id: 'parkingBrakeSet' }), true, 'explicit parking-brake capability should enable both fixed directions');
    assert.equal(controls.isCommandSupported({ type: 'light-set', light: 'landing', value: true }), true, 'explicit light capability should enable the matching light command');
    assert.equal(controls.setCommandPending({ type: 'light-set', light: 'landing', value: true }), true, 'light writes should reserve one shared pending key per physical light');
    assert.equal(controls.isCommandDisabled({ type: 'light-set', light: 'landing', value: false }), true, 'a pending ON write should block a concurrent OFF write for the same light');
    assert.equal(controls.clearCommandPending('light-set:landing'), true, 'canonical light pending keys should clear cleanly');
    assert.equal(controls.isCommandSupported({ type: 'preset', id: 'flcToggle' }), false, 'unsupported AP mode writes should be capability-gated');
    assert.equal(controls.isCommandDisabled({ type: 'preset', id: 'flcToggle' }), true, 'unsupported AP mode writes should render disabled');
    assert.equal(controls.isCommandDisabled({ type: 'selector-adjust', mode: 'hdg', action: 'inc10' }), true, 'unsupported selector writes should render disabled');
    assert.equal(controls.isCommandDisabled({ type: 'selector-hold', mode: 'alt' }), false, 'omitted capabilities should keep legacy enabled behavior');
    assert.equal(controls.isCommandSupported({ type: 'autopilot-pulse', id: 'apMaster' }), true, 'explicit pulse capabilities should enable the matching command object');
    assert.equal(controls.isCommandSupported('autopilot-pulse:ins'), true, 'pulse capability lookup should support canonical pending keys');
    assert.equal(controls.isCommandSupported({ type: 'autopilot-pulse', id: 'autothrottle' }), false, 'an explicit false pulse capability should fail closed');
    assert.equal(controls.isCommandSupported({ type: 'autopilot-pulse', id: 'machHold' }), false, 'omitted pulse capabilities should retain their default-closed state');
    assert.equal(controls.setCommandPending({ type: 'autopilot-pulse', id: 'ins' }), true, 'a supported pulse should reserve its canonical pending key');
    assert.equal(controls.setCommandPending('autopilot-pulse:ins'), false, 'a duplicate pulse reservation should be rejected');
    assert.equal(controls.isCommandPending({ type: 'autopilot-pulse', id: 'ins' }), true, 'pulse pending state should resolve from command metadata');
    assert.equal(controls.isCommandDisabled({ type: 'autopilot-pulse', id: 'ins' }), true, 'a pending pulse should disable duplicate UI dispatch');
    assert.equal(controls.clearCommandPending('autopilot-pulse:ins'), true, 'canonical pulse pending keys should clear cleanly');
    assert.equal(controls.isCommandDisabled({ type: 'autopilot-pulse', id: 'ins' }), false, 'clearing pulse pending state should restore a supported command');
    controls.resetControlCapabilities();

    controls.setCommandPending({ type: 'selector-adjust', mode: 'hdg', action: 'inc10' });
    controls.prepareForAircraftChange('Switching aircraft.');
    assert.equal(controls.feedback.routeText, 'Switching aircraft.', 'aircraft change reset should explain profile capability refresh');
    assert.equal(controls.feedback.profileText, 'Detecting active profile...', 'aircraft change reset should clear stale profile feedback');
    assert.equal(controls.isCommandPending({ type: 'selector-adjust', mode: 'hdg', action: 'inc10' }), false, 'aircraft change reset should clear pending commands from the previous aircraft');
    assert.equal(controls.isCommandSupported({ type: 'preset', id: 'gearUp' }), false, 'surface controls should be gated while the replacement profile is unknown');
    assert.equal(controls.isCommandSupported({ type: 'preset', id: 'autopilotMasterToggle' }), false, 'AP controls should be gated while the replacement profile is unknown');
    assert.equal(controls.isCommandSupported({ type: 'light-set', light: 'landing', value: true }), false, 'light controls should be gated while the replacement profile is unknown');
    assert.equal(controls.isCommandSupported({ type: 'autopilot-pulse', id: 'apMaster' }), false, 'momentary AP keys should stay gated while the replacement profile is unknown');
    controls.resetControlCapabilities();

    controls.setCommandPending({ type: 'preset', id: 'gearUp' });
    assert.equal(controls.isCommandPending({ type: 'preset', id: 'gearUp' }), true, 'pending commands should be tracked by command metadata');
    assert.equal(controls.isCommandDisabled({ type: 'preset', id: 'gearUp' }), true, 'pending commands should report disabled through the store');
    controls.clearCommandPending({ type: 'preset', id: 'gearUp' });
    assert.equal(controls.isCommandPending({ type: 'preset', id: 'gearUp' }), false, 'clearing pending commands should restore idle state');

    const requestedCommands = [];
    controls.bindCommandAction(async (command, options) => {
      requestedCommands.push({ command, options });
      return true;
    });
    assert.equal(controls.commandActionBound, true, 'runtime-bound control actions should report as bound');
    assert.equal(
      await controls.requestControlCommand({ type: 'preset', id: 'autopilotMasterToggle' }, { source: 'component' }),
      true,
      'store-backed control requests should delegate to the runtime action',
    );
    assert.deepEqual(
      requestedCommands,
      [{ command: { type: 'preset', id: 'autopilotMasterToggle' }, options: { source: 'component' } }],
      'delegated control requests should preserve the command payload and options',
    );

    controls.bindCommandAction(null);
    assert.equal(controls.commandActionBound, false, 'clearing runtime-bound control actions should reset the bound flag');

    controls.resetAutopilot();
    assert.equal(controls.autopilot.master, null, 'resetAutopilot should clear AP master back to unknown');
    assert.equal(controls.autopilot.fdActive, null, 'resetAutopilot should clear FD state back to unknown');
    assert.equal(controls.autopilot.spdDisplay, '---', 'resetAutopilot should restore selector defaults');

    controls.resetFeedback();
    assert.equal(controls.feedback.routeText, 'Waiting for first write.', 'resetFeedback should restore default route copy');
    controls.setCommandPending('preset:autopilotMasterToggle');
    controls.resetPendingCommands();
    assert.equal(controls.isCommandPending('preset:autopilotMasterToggle'), false, 'resetPendingCommands should clear tracked command state');
  });

  console.log('\n--- lvar inspector store ---\n');
  await test('lvar inspector store normalizes watch lists and derives live preview state', () => {
    resetStoreTestContext();
    const store = useLvarInspectorStore();

    store.hydrateWatchList([' MY_CUSTOM_SWITCH ', 'MY_CUSTOM_SWITCH', '', '(L:MY_CUSTOM_SPEED, number)']);
    assert.deepEqual(
      store.debugWatchSubscriptions,
      ['MY_CUSTOM_SWITCH', '(L:MY_CUSTOM_SPEED, number)'],
      'watch hydration should trim, dedupe, and discard empty entries',
    );
    assert.equal(
      store.watchInputText,
      'MY_CUSTOM_SWITCH\n(L:MY_CUSTOM_SPEED, number)',
      'watch hydration should keep the textarea text in sync with saved subscriptions',
    );
    assert.equal(store.debugSummaryLabel, 'Watch list saved locally. Connect to the LVAR sidecar to monitor values.');

    store.ingestDataSourcesMessage({
      secondary: [{
        type: 'lvar-sidecar',
        connected: true,
        description: 'Running',
        preview: [{ key: 'L:MY_CUSTOM_TEST', value: 1.2345 }],
        debugWatch: {
          count: 3,
          items: [{ expression: '(L:MY_CUSTOM_TEST, number)', value: true, live: true }],
        },
      }],
    });

    assert.equal(store.statusLabel, 'Running', 'connected LVAR sidecar description should surface in the header');
    assert.equal(store.headerCountLabel, '1 profile / 3 debug', 'header counts should reflect preview and live debug totals');
    assert.equal(store.previewRows[0].valueText, '1.235', 'preview values should be formatted for display');
    assert.equal(store.debugRows[0].expression, 'L:MY_CUSTOM_TEST, number', 'debug expressions should drop wrapping parentheses');
    assert.equal(store.debugRows[0].liveText, 'LIVE', 'live debug rows should expose the live marker');
    assert.match(store.debugSummaryLabel, /monitoring live values/, 'connected sidecar state should update the monitoring summary');

    store.clearDataSourcesStatus();
    assert.equal(store.statusLabel, 'LVAR source not enabled.', 'clearing data sources should restore the disabled state');
  });

  console.log('\n--- feedback store ---\n');
  await test('feedback store exposes app-wide toast state', () => {
    resetStoreTestContext();
    const feedback = useFeedbackStore();

    assert.equal(feedback.toastTitle, 'Completed', 'toast title should start with fallback copy');
    assert.match(feedback.toastClass, /hidden/, 'toast should start hidden');

    feedback.showToast({
      kind: 'error',
      title: 'Action failed',
      message: 'Unable to save the profile.',
    });
    assert.equal(feedback.toastTitle, 'Action failed', 'toast title should render from state');
    assert.equal(feedback.toastMessage, 'Unable to save the profile.', 'toast message should render from state');
    assert.match(feedback.toastClass, /app-feedback-toast--error/, 'toast kind should drive the tone class');
    assert.doesNotMatch(feedback.toastClass, /hidden/, 'visible toast should not include hidden');

    feedback.setToastEntered(true);
    assert.match(feedback.toastClass, /is-visible/, 'entered toast should include animation class');

    feedback.hideToast();
    assert.match(feedback.toastClass, /hidden/, 'hidden toast should include hidden class');
    assert.doesNotMatch(feedback.toastClass, /is-visible/, 'hidden toast should clear visible class');
  });

  console.log('\n--- debug store ---\n');
  await test('debug store exposes modal and connection chrome state', () => {
    resetStoreTestContext();
    const debug = useDebugStore();

    assert.equal(debug.toggleVisible, false, 'debug toggle should start hidden until runtime support is confirmed');
    assert.equal(debug.modalOpen, false, 'debug modal should start closed');
    assert.equal(debug.modalClass.split(/\s+/).includes('hidden'), true, 'closed debug modal should include hidden class');
    assert.equal(debug.statusText, 'Disconnected', 'unknown connection should start disconnected');
    assert.match(debug.statusDotClass, /bg-red-500/, 'unknown connection should use red dot');

    debug.setToggleVisible(true);
    assert.equal(debug.toggleVisible, true, 'setToggleVisible should expose the footer debug toggle state');
    assert.equal(debug.toggleModal(), true, 'toggleModal should return the opened state');
    assert.equal(debug.modalOpen, true, 'toggleModal should open the modal');
    assert.equal(debug.modalClass.split(/\s+/).includes('hidden'), false, 'open debug modal should not include hidden class');

    debug.setConnectionStatus(false);
    assert.equal(debug.statusText, 'WS Only (No Sim)', 'known websocket-only state should render');
    assert.match(debug.statusDotClass, /bg-yellow-500/, 'known websocket-only state should use yellow dot');

    debug.setConnectionStatus(true);
    assert.equal(debug.statusText, 'SimConnect Active', 'connected sim state should render');
    assert.match(debug.statusDotClass, /bg-green-500/, 'connected sim state should use green dot');

    debug.setModalOpen(false);
    assert.equal(debug.modalClass.split(/\s+/).includes('hidden'), true, 'setModalOpen(false) should close the modal');
  });

  await test('debug store groups live variables, applies filters, and tracks shake-test state', () => {
    resetStoreTestContext();
    const debug = useDebugStore();
    const now = Date.now();

    debug.setShowNull(true);
    debug.ingestFrame({
      type: 'debug-frame',
      phase: 'APPROACH',
      ias: 141.8,
      crosswind: 16,
      'L:MY_CUSTOM_TEST': true,
      nested: { heading: 87 },
    }, now);
    debug.ingestFrame({
      type: 'debug-frame',
      phase: 'APPROACH',
      ias: 142.2,
      crosswind: 16,
      'L:MY_CUSTOM_TEST': true,
      nested: { heading: 88 },
    }, now + 100);

    assert.equal(debug.frameCount, 2, 'ingested frames should increment the frame counter');
    assert.equal(debug.phase, 'APPROACH', 'phase should update from ingested debug frames');
    assert.equal(debug.pollRateLabel, '10.0', 'poll rate should average the observed frame cadence');
    assert.equal(debug.totalVarCount, 5, 'flattened debug variables should be stored by key');
    assert.equal(debug.activeVarCount, 5, 'recently updated variables should count as active');

    debug.ingestFrame({ type: 'phase', value: 'LANDING' }, now + 100);
    assert.equal(debug.phase, 'LANDING', 'canonical phase messages should update the displayed phase');
    assert.equal(debug.pollRateLabel, '10.0', 'same-millisecond messages should not poison the rate average');

    debug.setModalOpen(true);
    assert.equal(debug.pollRateLabel, '--', 'opening the modal should start a fresh rate sample window');
    debug.ingestFrame({ type: 'ias', value: 143 }, now + 200);
    debug.ingestFrame({ type: 'ias', value: 144 }, now + 300);
    assert.equal(debug.pollRateLabel, '10.0', 'fresh messages should rebuild the rate after opening');
    debug.setPaused(true);
    assert.equal(debug.pollRateLabel, '--', 'pausing should clear the previous rate sample window');
    debug.setPaused(false);

    const sourceKeys = debug.sourceSections.map((section) => section.key);
    assert.deepEqual(sourceKeys, ['simconnect', 'lvar', 'derived'], 'debug sections should group variables by source');
    assert.equal(debug.sourceSections[0].rows[0].key, 'ias', 'simconnect variables should render in sorted order');
    assert.equal(debug.sourceSections[1].rows[0].valueText, 'TRUE', 'boolean LVAR values should format for display');
    assert.equal(debug.sourceSections[2].rows[0].key, 'crosswind', 'derived variables should render in their own section');

    debug.setFilterText('heading');
    assert.equal(debug.sourceSections[0].filteredCount, 1, 'filters should narrow visible rows inside each section');

    debug.toggleSourceCollapsed('simconnect');
    assert.equal(debug.sourceSections[0].collapsed, true, 'source sections should track collapsed state');

    debug.setPaused(true);
    assert.equal(debug.ingestFrame({ type: 'debug-frame', ias: 999 }, 1200), false, 'paused debug state should ignore incoming frames');

    debug.setTestShakeVs('-700');
    debug.requestTestShake();
    assert.equal(debug.testShakeVs, '-700', 'shake-test selector value should be store-backed');
    assert.equal(debug.testShakeRequestNonce, 1, 'shake-test requests should increment a nonce for runtime side effects');

    debug.setTestShakeStatus('Sent (-700 fpm)');
    assert.equal(debug.testShakeStatus, 'Sent (-700 fpm)', 'shake-test status text should be store-backed');
    debug.clearTestShakeStatus();
    assert.equal(debug.testShakeStatus, '', 'shake-test status should clear through the store');
  });

  await test('debug store bounds retained diagnostic data', () => {
    resetStoreTestContext();
    const debug = useDebugStore();
    const now = Date.now();

    debug.ingestFrame({ type: 'debug-frame', samples: Array.from({ length: 1000 }, (_, index) => index) }, now);
    const samples = debug.variables.samples;
    assert.equal(samples?.value?.__flightFabricDebugPreview, true, 'arrays should be retained as bounded previews');
    assert.ok(samples.value.text.length <= 503, 'retained array previews should have a fixed maximum size');

    const oversizedFrame = { type: 'debug-frame' };
    for (let index = 0; index < 1010; index += 1) oversizedFrame[`variable_${index}`] = index;

    debug.ingestFrame(oversizedFrame, now + 1);

    assert.equal(debug.totalVarCount, 1000, 'debug variables should be capped to a fixed upper bound');

    let deepValue = { leaf: 'bounded' };
    for (let depth = 0; depth < 20; depth += 1) deepValue = { nested: deepValue };
    debug.clearCapturedData();
    debug.ingestFrame({ type: 'debug-frame', deepValue }, now + 2);
    assert.equal(debug.totalVarCount, 1, 'deep objects should stop flattening at the configured depth');
    const retainedDeepValue = Object.values(debug.variables)[0]?.value;
    assert.equal(retainedDeepValue?.__flightFabricDebugPreview, true, 'depth-limited objects should use bounded previews');
    assert.ok(retainedDeepValue.text.length <= 503, 'depth-limited previews should have a fixed maximum size');
  });

  await test('debug store clears captured telemetry without resetting UI preferences', () => {
    resetStoreTestContext();
    const debug = useDebugStore();

    debug.setModalOpen(true);
    debug.setFilterText('heading');
    debug.setShowNull(true);
    debug.setShowStale(false);
    debug.ingestFrame({ type: 'heading', mag: 87, true: 89 }, Date.now());
    debug.clearCapturedData();

    assert.equal(debug.totalVarCount, 0, 'telemetry reset should clear captured variables');
    assert.equal(debug.frameCount, 0, 'telemetry reset should clear the captured message count');
    assert.equal(debug.phase, '--', 'telemetry reset should clear captured phase metadata');
    assert.equal(debug.pollRateLabel, '--', 'telemetry reset should clear rate history');
    assert.equal(debug.modalOpen, true, 'telemetry reset should preserve modal visibility');
    assert.equal(debug.filterText, 'heading', 'telemetry reset should preserve the filter');
    assert.equal(debug.showNull, true, 'telemetry reset should preserve null visibility');
    assert.equal(debug.showStale, false, 'telemetry reset should preserve stale visibility');
  });

  await test('debug store keeps generic fields from separate websocket message types distinct', () => {
    resetStoreTestContext();
    const debug = useDebugStore();
    const now = Date.now();

    debug.ingestFrame({ type: 'ias', value: 141 }, now);
    debug.ingestFrame({ type: 'gs', value: 136 }, now + 100);
    debug.ingestFrame({ type: 'engines', data: { count: 2, eng1Text: '31%' } }, now + 200);

    assert.equal(debug.variables['ias.value']?.value, 141, 'IAS should retain its type-qualified value');
    assert.equal(debug.variables['gs.value']?.value, 136, 'ground speed should not overwrite IAS');
    assert.equal(debug.variables['engines.data.count']?.value, 2, 'nested fields should include their message type');
    assert.equal(debug.variables.value, undefined, 'generic websocket value fields should not share a global row');
  });

  console.log('\n--- landing store ---\n');
  await test('landing store tracks landing card and waiting-state visibility', () => {
    resetStoreTestContext();
    const landing = useLandingStore();

    assert.equal(landing.cardVisible, false, 'landing card should start hidden');
    assert.equal(landing.waitingVisible, true, 'landing waiting state should start visible');

    landing.setLandingCardVisible(true);
    assert.equal(landing.cardVisible, true, 'landing card visibility should be store-backed');
    assert.equal(landing.waitingVisible, false, 'landing waiting state should invert with the card visibility');

    landing.setLandingCardVisible(false);
    assert.equal(landing.cardVisible, false, 'landing card visibility should be resettable through the store');
    assert.equal(landing.waitingVisible, true, 'landing waiting state should reappear when the card is hidden');
  });

  await test('landing store tracks landing debrief modal state', () => {
    resetStoreTestContext();
    const landing = useLandingStore();

    landing.openLandingModal({ loading: true });
    assert.equal(landing.landingModalOpen, true, 'landing modal should open through store state');
    assert.equal(landing.landingModalLoading, true, 'landing modal should expose loading state');
    assert.equal(landing.landingModalError, '', 'opening a loading modal should clear stale errors');

    landing.setLandingModalError('Could not load landing details');
    assert.equal(landing.landingModalOpen, true, 'landing modal should stay open when an error is published');
    assert.equal(landing.landingModalLoading, false, 'landing modal error should clear loading state');
    assert.equal(landing.landingModalError, 'Could not load landing details', 'landing modal should store the error copy');

    landing.closeLandingModal();
    assert.equal(landing.landingModalOpen, false, 'landing modal should close through store state');
    assert.equal(landing.landingModalError, '', 'closing the landing modal should clear modal errors');
  });

  await test('landing store formats landing-card summary, metrics, and in-flight rows', async () => {
    resetStoreTestContext();
    const landing = useLandingStore();

    landing.applyLandingCardMessage({
      final: true,
      vs: -467.3,
      color: '#00ff88',
      grade: 'Firm',
      gforce: 1.23,
      icao: 'YSSY',
      runway: '34L',
      iasKts: 136,
      gsKts: 142,
      crosswind: -8,
      windSpeed: 12,
      windDirectionTrueDeg: 240,
      approachType: 'ILS',
      pitchDeg: 3.1,
      bankDeg: -1.4,
      centerlineDev: 0.4,
      touchdownDistance: {
        distanceFt: 305,
        grade: 'Outstanding',
        lateralOffsetFt: 3,
        lateralOffsetGrade: 'Outstanding',
        lateralOffsetScore: 98,
        bounceGrade: 'Clean',
        bounceCount: 0,
        bounceScore: 100,
      },
      rolloutAnalysis: {
        assessment: 'caution',
        maxBankDeg: 3.3,
        maxBankRateDegS: 4.6,
        maxHeadingDeviationDeg: 14.6,
        maxHeadingDeviationSide: 'right',
        maxLateralOffsetFt: 22,
        maxLateralOffsetSide: 'left',
        minRunwayEdgeMarginFt: 53,
        conservativeRunwayEdgeMarginFt: 35,
        lateralDataQuality: 'low',
        lateralUncertaintyFt: 18.2,
        flags: [{ code: 'rollout_bank', label: 'Noticeable bank during rollout' }],
      },
      ultimateStability: { score: 91 },
      flightSummary: {
        max_alt_ft: 12000,
        max_ias_kts: 250,
        go_around_count: 1,
        overspeed_count: 2,
        holding: {
          detected: true,
          confidence: 'HIGH',
          loop_count: 2,
          duration_ms: 702000,
          episode_count: 1,
        },
        insights: {
          time: {
            recorded_time_ms: 7860000,
            airborne_time_ms: 6720000,
            taxi_time_ms: 1080000,
            paused_time_ms: 360000,
          },
          route: { distance_nm: 684, average_ground_speed_kts: 373, coverage_percent: 95 },
          fuel: { burn_gal: 903.3, burn_lbs: 5420, efficiency_gal_per_nm: 1.32, efficiency_lbs_per_nm: 7.9 },
          automation: {
            autopilot_time_ms: 5241600,
            hand_flown_time_ms: 1440000,
            hand_flown_below_1000_ft_ms: 180000,
            autopilot_percent: 78,
            coverage_percent: 99,
          },
          weather: {
            in_cloud_time_ms: 1320000,
            precipitation_time_ms: 480000,
            max_wind_kts: 47,
            coverage_percent: 92,
          },
          configuration: {
            gear_down_recorded: true,
            gear_down_ra_ft: 2140,
            landing_flaps: '30',
            landing_flaps_ra_ft: 1320,
          },
          comfort: { peak_g: 1.31, minimum_g: 0.82, max_bank_deg: 28, rough_air_time_ms: 240000 },
          approach: { duration_ms: 720000, attempt_count: 2, established_distance_nm: 7.4 },
        },
        dutch_roll: {
          detected: true,
          confidence: 'MEDIUM',
          max_duration_ms: 16400,
          max_bank_deg: 4.2,
          max_yaw_rate_deg_s: 1.4,
        },
        violations: [{ rule_id: 'bank_angle', severity: 'warning', label: 'Bank Angle', duration_ms: 4200 }],
      },
    }, {
      flightUpsetCount: 2,
    });

    assert.equal(landing.cardVisible, true, 'landing-card messages should reveal the landing card');
    assert.equal(landing.waitingVisible, false, 'landing-card messages should hide the waiting state');
    assert.equal(landing.landingCard.gradeText, 'FIRM', 'touchdown headline should use the raw touchdown-rate grade');
    assert.equal(landing.landingCard.gforceText, 'G: 1.23', 'gforce label should be formatted');
    assert.equal(landing.landingCard.airportText, 'YSSY', 'airport label should be stored');
    assert.equal(landing.landingCard.runwayText, 'RWY 34L', 'runway label should be stored');
    assert.equal(landing.landingCard.vsText, '-467', 'vertical-speed label should be rounded and stored');
    assert.equal(landing.landingCard.touchdown.distanceText, '305 ft', 'touchdown distance should be formatted');
    assert.equal(landing.landingCard.touchdown.achievedText, 'YES', 'first-1,000-ft target achievement should be stored');
    assert.equal(landing.landingCard.approach.stabilityText, 'NO VERDICT', 'an approach score should not invent a gate verdict');
    assert.equal(landing.landingCard.approach.stabilityNoteText, 'Approach score 91%', 'the approach score should remain labelled and secondary');
    assert.equal(landing.landingCard.approach.speedText, '136 kt', 'speed label should be stored');
    assert.equal(landing.landingCard.approach.gsText, 'GS: 142', 'ground-speed label should be stored');
    assert.equal(landing.landingCard.approach.crosswindText, '8 kt L', 'crosswind label should be direction-aware');
    assert.equal(landing.landingCard.approach.windTotalText, 'FROM 240°T · 12 kt', 'wind summary should include absolute direction and speed');
    assert.equal(landing.landingCard.wind.directionText, '240°T', 'landing summary should retain the true wind direction');
    assert.equal(landing.landingCard.wind.speedText, '12 kt', 'landing summary should retain touchdown wind speed');
    assert.equal(landing.landingCard.wind.crosswindDetailText, 'XW 8 kt from left', 'landing summary should explain crosswind direction in words');
    assert.equal(landing.landingCard.attitude.pitchText, '+3.1 deg', 'pitch label should be formatted');
    assert.equal(landing.landingCard.attitude.bankText, '1.4 deg L', 'bank label should be formatted');
    assert.equal(landing.landingCard.attitude.centerlineText, 'ALIGNED', 'tiny heading deviations should collapse to ALIGNED');
    assert.equal(landing.landingCard.attitude.upsetCountText, '2', 'upset count should be stored');
    assert.equal(landing.landingCard.rollout.visible, true, 'rollout analysis should reveal its separate landing-card section');
    assert.equal(landing.landingCard.rollout.assessmentText, 'CAUTION', 'rollout assessment should be normalized');
    assert.equal(landing.landingCard.rollout.metrics[0].value, '3.3 deg', 'rollout peak bank should be formatted');
    assert.equal(
      landing.landingCard.rollout.metrics.find((metric) => metric.key === 'edge-margin')?.value,
      '35 ft',
      'rollout card should use the uncertainty-adjusted runway-edge margin',
    );
    assert.match(landing.landingCard.rollout.noteText, /coordinate uncertainty/, 'low-precision lateral data should be disclosed');
    assert.equal(landing.landingCard.inflight.visible, true, 'flight summary should reveal the in-flight section');
    assert.equal(landing.landingCard.inflight.stats.length, 13, 'in-flight stats should be normalized into display rows');
    assert.equal(landing.landingCard.inflight.stats[2].value, 'Airborne 1h 52m · Taxi 18m 0s · Paused 6m 0s', 'flight time should include airborne, taxi, and paused time');
    assert.equal(landing.landingCard.inflight.stats[3].value, '684 NM · Avg GS 373 kt · Coverage 95%', 'route should disclose partial coverage');
    assert.equal(landing.landingCard.inflight.stats[4].value, '5,420 lb used · 7.9 lb/NM', 'fuel should include burn and efficiency');
    assert.equal(landing.landingCard.inflight.stats[5].value, 'AP 78% · Hand 24m 0s · Below 1,000 ft 3m 0s · Coverage 99%', 'automation should disclose partial coverage');
    assert.equal(landing.landingCard.inflight.stats[6].value, 'Cloud 22m 0s · Precip 8m 0s · Max wind 47 kt · Coverage 92%', 'weather should disclose partial coverage');
    assert.equal(landing.landingCard.inflight.stats[7].value, 'Gear 2,140 ft AGL · Flaps 30 at 1,320 ft AGL', 'configuration should include gear and landing-flap milestones');
    assert.equal(landing.landingCard.inflight.stats[8].value, 'Peak 1.31 G · Bank 28° · Rough-air indications 4m 0s', 'comfort should include G, bank, and rough-air time');
    assert.equal(landing.landingCard.inflight.stats[9].value, 'Final 12m 0s · 2 attempts · Started 7.4 NM out', 'approach should include duration, attempts, and distance');
    assert.equal(landing.landingCard.inflight.stats[11].label, 'Possible Holding', 'detected holding should render as an informational stat');
    assert.equal(landing.landingCard.inflight.stats[11].value, '2 loops · 11m 42s', 'holding stat should include loop count and duration');
    assert.equal(landing.landingCard.inflight.stats[12].label, 'Dutch Roll', 'detected Dutch roll should render as an informational stat');
    assert.equal(landing.landingCard.inflight.stats[12].value, 'Possible (Medium, 16s)', 'Dutch roll stat should include confidence and duration');
    assert.equal(landing.landingCard.inflight.violations.length, 2, 'overspeed and explicit violations should be normalized into display rows');

    landing.applyLandingCardMessage({
      final: true,
      vs: -210,
      touchdownDistance: {
        distanceFt: 2966,
        grade: 'Acceptable',
        tdzAchieved: true,
      },
    });
    assert.equal(landing.landingCard.touchdown.distanceText, '2,966 ft', 'late touchdown distance should remain visible');
    assert.equal(landing.landingCard.touchdown.achievedText, 'NO', 'formal TDZ status must not make a 2,966-ft touchdown pass the first-1,000-ft target');

    landing.applyLandingCardMessage({
      final: true,
      vs: -210,
      touchdownDistance: {
        distanceFt: 600,
        bounceGrade: 'Repeated Bounces',
        bounceCount: 3,
        bounceScore: 42,
      },
    });
    assert.equal(landing.landingCard.touchdown.bounceText, '3x', 'repeated-bounce landings should show the count');
    assert.equal(landing.landingCard.touchdown.bounceTone, 'text-red-400', 'repeated bounces should use danger tone');

    landing.applyLandingCardMessage({
      final: true,
      vs: -210,
      touchdownDistance: {
        distanceFt: 600,
        bounceGrade: 'Porpoise',
        bounceCount: 0,
        bounceScore: 20,
      },
    });
    assert.equal(landing.landingCard.touchdown.bounceText, '4x', 'porpoise grade should imply a non-clean count on the landing card');
    assert.equal(landing.landingCard.touchdown.bounceTone, 'text-red-400', 'porpoise grade should use danger tone');

    landing.applyLandingCardMessage({
      final: true,
      vs: -210,
      touchdownDistance: {
        distanceFt: 600,
        bounceCount: 2,
      },
    });
    assert.equal(landing.landingCard.touchdown.bounceText, '2x', 'count-only bounce data should still render on the landing card');
    assert.equal(landing.landingCard.touchdown.bounceGradeText, 'Multiple Bounces', 'count-only bounce data should infer the backend grade label');
    assert.equal(landing.landingCard.touchdown.bounceGradeTone, 'text-amber-500', 'missing bounce scores should tone inferred moderate bounces from the grade');

    landing.setStabilityBreakdown({
      metrics: [{
        key: 'speed_ok',
        label: 'Airspeed',
        valueText: '82%',
        valueClass: 'text-warning',
        backgroundClass: 'bg-warning/10',
        explanation: 'A little fast through the gate',
        tooltip: 'IAS within +/-5 kt of the gate-sample IAS - click for details',
        modal: {
          label: 'Airspeed',
          scoreText: 'Score: 82%',
          descriptionText: 'IAS should stay near the gate speed.',
          criteriaText: 'Within +/-5 kt.',
          detailText: 'Observed 8 kt above target.',
        },
      }],
      samplesText: '34',
    });
    assert.equal(landing.stabilityBreakdownVisible, true, 'stability breakdown should become visible when metric rows are provided');
    assert.equal(landing.stabilityMetrics.length, 1, 'stability metric rows should be stored');
    assert.equal(landing.stabilitySamplesText, '34', 'stability sample summary should be stored');

    landing.openStabilityMetricModal(landing.stabilityMetrics[0].modal);
    assert.equal(landing.stabilityMetricModal.open, true, 'stability metric modal should open from store state');
    assert.equal(landing.stabilityMetricModal.title, 'Airspeed', 'stability metric modal should store its title');
    assert.equal(landing.stabilityMetricModal.detailVisible, true, 'stability metric modal should expose observed detail when present');
    landing.closeStabilityMetricModal();
    assert.equal(landing.stabilityMetricModal.open, false, 'stability metric modal should close through the store');

    landing.setApproachProfile({
      svgHtml: '<svg viewBox="0 0 10 10"><path d="M0 10 L10 0" /></svg>',
      gateLabel: 'Gate: 1000 ft above thr',
    });
    landing.setTopdownProfile({
      svgHtml: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="2" /></svg>',
    });
    assert.equal(landing.approachProfile.visible, true, 'approach profile should become visible when SVG content exists');
    assert.equal(landing.approachProfile.gateLabel, 'Gate: 1000 ft above thr', 'approach profile gate label should be stored');
    assert.equal(landing.topdownProfile.visible, true, 'top-down profile should become visible when SVG content exists');

    landing.resetLandingCard();
    assert.equal(landing.cardVisible, false, 'resetLandingCard should hide the landing card');
    assert.equal(landing.landingCard.gradeText, '--', 'resetLandingCard should restore default card copy');
    assert.equal(landing.landingCard.inflight.visible, false, 'resetLandingCard should hide in-flight rows');
    assert.equal(landing.stabilityBreakdownVisible, false, 'resetLandingCard should hide stability breakdown rows');
    assert.equal(landing.approachProfile.visible, false, 'resetLandingCard should hide rendered approach profile content');
    assert.equal(landing.topdownProfile.visible, false, 'resetLandingCard should hide rendered top-down profile content');
  });

  await test('landing store keeps touchdown, approach, bounce, and TDZ facts independent', () => {
    resetStoreTestContext();
    const landing = useLandingStore();

    landing.applyLandingCardMessage({
      final: true,
      vs: -243,
      grade: 'PERFECT',
      touchdownDistance: {
        distanceFt: 600,
        grade: 'Outstanding',
        bounceGrade: 'Clean',
        bounceCount: 0,
      },
      ultimateStability: {
        verdict: 'unstable',
        score: 84,
        gateStable: false,
        gateFailures: ['speed_ok', 'vs_ok', 'glidepath_ok'],
      },
    });

    assert.equal(landing.landingCard.gradeText, 'PERFECT', 'an unstable approach must not rewrite the touchdown-rate grade');
    assert.equal(landing.landingCard.gradeColor, '#00e070', 'the touchdown-rate grade should keep its own tone');
    assert.equal(
      landing.landingCard.gradeBreakdownText,
      'TDZ: 600 ft · Outstanding',
      'the touchdown summary detail should keep the distinct TDZ distance and result visible',
    );
    assert.equal(landing.landingCard.approach.stabilityText, 'UNSTABLE', 'gate verdict should lead the approach tile');
    assert.equal(landing.landingCard.approach.stabilityTone, 'text-red-400', 'unstable should use a danger tone');
    assert.equal(
      landing.landingCard.approach.stabilityNoteText,
      '3 substantial/required findings · Approach score 84%',
      'aggregate score should be secondary to the gate verdict and failed checks',
    );
    assert.equal(landing.landingCard.touchdown.bounceText, 'Clean', 'the clean bounce result should remain a peer fact');

    landing.applyLandingCardMessage({
      final: true,
      vs: -177,
      grade: 'GOOD',
      ultimateStability: {
        score: 96,
        gateStable: false,
        gateFailures: ['thrust_unstable_after_gate'],
        breakdown: { thrust_ok: 79 },
        scoringContext: { criteria: { gateRaFt: 1000, passPct: 80 } },
      },
    });
    assert.equal(landing.landingCard.approach.stabilityText, 'MARGINAL', 'a soft/proxy-only miss should lead with marginal');
    assert.equal(landing.landingCard.approach.stabilityTone, 'text-amber-400', 'marginal should use an amber tone');
    assert.equal(landing.landingCard.approach.stabilityNoteText, '1 strict check below 80% · Approach score 96%');
    assert.match(landing.landingCard.approach.stabilityTooltip, /after the 1,000 ft gate/, 'landing detail should describe the full post-gate window');

    landing.applyLandingCardMessage({
      final: true,
      vs: -180,
      grade: 'PERFECT',
      touchdownDistance: {
        distanceFt: 500,
        grade: 'Outstanding',
        bounceGrade: 'Single Bounce',
        bounceCount: 1,
      },
      ultimateStability: { score: 94, gateStable: true, gateFailures: [] },
    });
    assert.equal(landing.landingCard.gradeText, 'PERFECT', 'a recorded bounce must not rewrite the touchdown-rate grade');
    assert.equal(landing.landingCard.approach.stabilityText, 'STABLE', 'the stable approach verdict should remain independently visible');
    assert.equal(landing.landingCard.touchdown.bounceText, '1x', 'the recorded bounce should remain independently visible');

    landing.applyLandingCardMessage({
      final: true,
      vs: -180,
      grade: 'PERFECT',
      touchdownDistance: {
        distanceFt: 1500,
        grade: 'Good',
        bounceGrade: 'Clean',
        bounceCount: 0,
      },
      ultimateStability: { score: 94, gateStable: true, gateFailures: [] },
    });
    assert.equal(landing.landingCard.gradeText, 'PERFECT', 'TDZ position must not rewrite the touchdown-rate grade');
    assert.equal(landing.landingCard.gradeBreakdownText, 'TDZ: 1,500 ft · Good', 'TDZ distance and quality should remain a separate visible fact');

    landing.applyLandingCardMessage({
      final: true,
      vs: -180,
      grade: 'PERFECT',
      touchdownDistance: {
        distanceFt: 500,
        grade: 'Outstanding',
        bounceGrade: 'Clean',
        bounceCount: 0,
      },
      ultimateStability: { score: 94, gateStable: true, gateFailures: [] },
    });
    assert.equal(landing.landingCard.gradeText, 'PERFECT', 'a clean touchdown should retain its raw touchdown-rate grade');
  });

  await test('stability explanations use the scoring profile snapshot and hide neutral compatibility metrics', () => {
    const scoringContext = {
      schemaVersion: 1,
      profile: { id: 'generic', name: 'Generic Aircraft', reliability: 'generic' },
      criteria: {
        gateRaFt: 1000,
        speedMinusKts: 50,
        speedPlusKts: 100,
        vsMinFpm: -3000,
        vsMaxClimbFpm: 1000,
        glidepathAngleDeg: 3,
        glidepathVsDeltaMaxFpm: 200,
        speedTrendMaxKtsPerSec: 2.5,
        thrustStableMaxPctPerSec: 10,
        pitchMinDeg: -30,
        pitchMaxDeg: 45,
        bankMaxDeg: 25,
        passPct: 80,
      },
      reference: { gateIasKts: 145, gateHeightFt: 998, altitudeSource: 'radio' },
    };
    const summary = getStabilityContextSummary(scoringContext);
    assert.equal(summary.label, 'Generic Aircraft - Generic estimate');
    assert.equal(summary.isGeneric, true);
    assert.match(
      getStabilityContextSummary({ ...scoringContext, criteriaSource: 'reconstructed' }).detail,
      /reconstructed with the current policy/,
    );
    const policySummary = getStabilityContextSummary({
      ...scoringContext,
      schemaVersion: 2,
      policy: { id: 'transport-v1', version: 1, name: 'Common transport rules' },
      coverage: { scoredMetrics: 7, totalMetrics: 8 },
    });
    assert.equal(policySummary.label, 'Generic Aircraft - Generic estimate · Common transport rules v1');
    assert.match(policySummary.detail, /7 of 8 available checks contributed/);

    const speedPresentation = getStabilityMetricPresentation('speed_ok', scoringContext, {});
    assert.match(speedPresentation.criteriaText, /95-245 kt/);
    assert.match(speedPresentation.criteriaText, /-50\/\+100/);
    assert.match(
      getStabilityMetricPresentation('thrust_ok', scoringContext, {}).descriptionText,
      /rolling one-second windows/,
      'throttle explanation should match the cadence-independent one-second measurement window',
    );

    const fractionalSpeedPresentation = getStabilityMetricPresentation('speed_ok', {
      ...scoringContext,
      criteria: {
        ...scoringContext.criteria,
        speedMinusKts: 5,
        speedPlusKts: 5,
      },
      reference: {
        ...scoringContext.reference,
        gateIasKts: 146.4246368408203,
      },
    }, {});
    assert.equal(
      fractionalSpeedPresentation.criteriaText,
      'IAS 141.4-151.4 kt (gate IAS 146.4 kt; -5/+5), from the gate to 50 ft AAL.',
      'stability criteria should not expose raw telemetry floating-point precision',
    );

    const sections = buildLandingDetailSections({
      type: 'landing',
      ultimateStability: {
        score: 94,
        samples: 1130,
        gateStable: false,
        scoringContext,
        breakdown: {
          speed_ok: 100,
          thrust_ok: 95,
          thrust_not_idle_ok: 100,
          thrust_stable_ok: 100,
        },
      },
    });
    const stabilitySection = sections.find((section) => section.key === 'retrospective-stability');
    const approachVerdictIndex = stabilitySection?.rows.findIndex((row) => row.key === 'gate-stable');
    const scoreIndex = stabilitySection?.rows.findIndex((row) => row.key === 'score');
    assert.equal(stabilitySection?.rows[approachVerdictIndex]?.value, 'MARGINAL', 'detail should soften a legacy strict-only gate miss without hard evidence');
    assert.equal(approachVerdictIndex < scoreIndex, true, 'approach verdict should appear before the approach score');
    assert.equal(stabilitySection?.rows[scoreIndex]?.label, 'Approach Score', 'the retrospective percentage should be explicitly scoped');
    assert.equal(stabilitySection?.rows.find((row) => row.key === 'profile')?.value, 'Generic Aircraft - Generic estimate');
    assert.match(stabilitySection?.rows.find((row) => row.key === 'speed_ok')?.label || '', /-50\/\+100 kt from gate IAS/);
    assert.equal(stabilitySection?.rows.some((row) => row.key === 'thrust_not_idle_ok'), false);
    assert.equal(stabilitySection?.rows.some((row) => row.key === 'thrust_stable_ok'), false);
  });

  await test('landing store labels configuration states without inventing transition altitudes', () => {
    resetStoreTestContext();
    const landing = useLandingStore();

    landing.applyLandingCardMessage({
      final: true,
      vs: -220,
      flightSummary: {
        insights: {
          configuration: {
            gear_down_recorded: true,
            gear_down_ra_ft: null,
            landing_flaps: '30',
            landing_flaps_ra_ft: null,
          },
        },
        violations: [],
      },
    });

    const configuration = landing.landingCard.inflight.stats.find((stat) => stat.key === 'configuration');
    assert.equal(configuration?.value, 'Gear down recorded · Flaps 30 recorded', 'unknown transitions should be described as recorded states');
  });

  await test('landing store derives in-flight upset count from summary violation rules', () => {
    resetStoreTestContext();
    const landing = useLandingStore();

    landing.applyLandingCardMessage({
      final: true,
      vs: -240,
      grade: 'Good',
      flightSummary: {
        max_alt_ft: 2415,
        max_ias_kts: 223,
        violations: [
          { rule_id: 'upset_pitch_nose_up', label: 'Pitch upset (nose-up > 25 deg)', severity: 'critical', duration_ms: 10000 },
          { rule_id: 'upset_pitch_nose_down', label: 'Pitch upset (nose-down > 10 deg)', severity: 'critical', duration_ms: 8000 },
          { rule_id: 'load_factor_advisory', label: 'Load factor advisory (> 1.8 g)', severity: 'warning', duration_ms: 1000 },
          { rule_id: 'upset_bank', label: 'Bank upset (> 45 deg)', severity: 'critical', duration_ms: 10000 },
        ],
      },
    });

    assert.equal(landing.landingCard.attitude.upsetCountText, '3', 'upset tile should count only true in-flight upset rules from the summary');
    assert.equal(landing.landingCard.attitude.upsetGradeText, '3 upset events', 'upset tile copy should match the derived count');
    assert.equal(landing.landingCard.inflight.violations.length, 4, 'lower in-flight list should still show advisory/non-upset violations');
  });

  await test('landing store derives debrief factors and confidence from landing card messages', () => {
    resetStoreTestContext();
    const landing = useLandingStore();

    landing.applyLandingCardMessage({
      final: true,
      vs: -467.3,
      grade: 'FIRM',
      pitchDeg: 3.1,
      bankDeg: -1.4,
      touchdownDistance: {
        distanceFt: 305,
        achieved: true,
        bounceGrade: 'Clean',
        bounceCount: 0,
      },
      ultimateStability: {
        score: 91,
        samples: 82,
        gateStable: true,
      },
    });

    const reasons = landing.landingCard.debrief.reasons.map((reason) => reason.text);
    assert.equal(landing.landingCard.debrief.visible, true, 'landing card debrief should become visible when reasons are derived');
    assert.equal(reasons.includes('Firm touchdown rate'), true, 'firm touchdown reason should use the resolved touchdown-rate grade');
    assert.equal(reasons.includes('Stabilized approach'), true, 'stabilized approach reason should be derived from ultimate stability');
    assert.equal(reasons.includes('First 1,000 ft target'), true, 'first-1,000-ft reason should be derived from touchdown distance');
    assert.equal(reasons.includes('Nose-down touchdown'), false, 'positive touchdown pitch should not be marked nose-down');
    assert.equal(landing.landingCard.debrief.confidenceText, 'High', 'complete data should keep high confidence');
    assert.equal(landing.landingCard.approach.stabilityText, 'STABLE', 'confirmed gate result should lead the stability tile');
    assert.equal(landing.landingCard.approach.stabilityNoteText, 'Approach score 91%', 'stable approach score should remain available as secondary context');

    landing.applyLandingCardMessage({
      final: true,
      vs: -210,
      touchdownDistance: { distanceFt: 600 },
      ultimateStability: {
        score: 91,
        samples: 82,
        gateStable: 'false',
      },
    });
    const unstableGateReasons = landing.landingCard.debrief.reasons.map((reason) => reason.text);
    assert.equal(unstableGateReasons.includes('Marginal approach - soft/proxy miss'), true, 'a legacy strict-gate-only miss should be called out as marginal');
    assert.equal(unstableGateReasons.includes('Stabilized approach'), false, 'a marginal approach should suppress stabilized approach praise');
    assert.equal(landing.landingCard.approach.stabilityTone, 'text-amber-400', 'marginal high scores should use an amber tone on the stability tile');
    assert.equal(landing.landingCard.approach.stabilityText, 'MARGINAL', 'the four-state verdict should be more prominent than its aggregate score');
    assert.equal(landing.landingCard.approach.stabilityNoteText, 'Approach score 91%', 'gate-flagged score should remain secondary context');

    landing.applyLandingCardMessage({
      final: true,
      vs: -210,
      pitchDeg: -0.4,
      touchdownDistance: { distanceFt: 600 },
      ultimateStability: { score: 80, samples: 40 },
    });
    assert.equal(
      landing.landingCard.debrief.reasons.some((reason) => reason.text === 'Nose-down touchdown'),
      false,
      'minor negative touchdown pitch should stay inside the nose-down deadband',
    );

    landing.applyLandingCardMessage({
      final: true,
      vs: -210,
      pitchDeg: -2.0,
      touchdownDistance: { distanceFt: 600 },
      ultimateStability: { score: 80, samples: 40 },
    });
    assert.equal(
      landing.landingCard.debrief.reasons.some((reason) => reason.text === 'Nose-down touchdown'),
      true,
      'clear negative touchdown pitch should still be marked nose-down',
    );

    landing.applyLandingCardMessage({
      final: true,
      vs: -210,
      touchdownDistance: null,
      ultimateStability: { score: null, samples: 3 },
    });
    assert.equal(landing.landingCard.debrief.confidenceText, 'Low', 'missing stability and touchdown position should lower confidence');
    assert.match(landing.landingCard.debrief.confidenceReason, /No stability data/, 'confidence reason should explain missing stability data');
  });

  console.log('\n--- logbook store ---\n');
  await test('logbook store hydrates backend entries and delegates refresh through a runtime-bound action', () => {
    resetStoreTestContext();
    const logbook = useLogbookStore();

    assert.equal(logbook.request(), false, 'logbook refresh should report when no runtime action is bound');

    logbook.ingestMessage({
      type: 'logbook',
      entries: [{ id: 'L1', grade: 'PERFECT', vsFpm: -92 }],
      stats: {
        total: 1,
        grades: { PERFECT: 1 },
        avgVsFpm: -92,
        airports: 1,
        aircraft: 1,
        trends: {
          aircraft: [{ key: 'pmdg-777', label: 'PMDG 777', count: 3, avgVsFpm: -310, stableRatePct: 67, trendVs: 'improving' }],
          airports: [{ key: 'YSSY', label: 'YSSY', count: 2, avgVsFpm: -280, stableRatePct: 100, trendVs: 'stable' }],
          runways: [{ key: 'YSSY:34L', label: 'YSSY 34L', count: 2, avgVsFpm: -280, stableRatePct: 100, trendVs: 'stable' }],
        },
      },
    });
    assert.equal(logbook.entries.length, 1, 'logbook entries should hydrate from backend messages');
    assert.equal(logbook.stats.total, 1, 'logbook stats should hydrate from backend messages');
    assert.equal(logbook.stats.trends.aircraft[0].label, 'PMDG 777', 'logbook trend groups should hydrate from backend messages');

    logbook.ingestMessage({
      type: 'historyIndexStatus',
      status: {
        phase: 'indexing',
        mode: 'incremental',
        generation: 4,
        totalFiles: 120,
        completedFiles: 30,
        totalBytes: 1000,
        completedBytes: 250,
        percent: 25,
      },
    });
    assert.equal(logbook.historyIndexBusy, true, 'history-index progress should be exposed as busy');
    assert.equal(logbook.historyIndexProgressLabel, 'Indexing 30 of 120 flights');
    assert.equal(logbook.historyIndexStatus.percent, 25);

    let refreshCalls = 0;
    logbook.bindRequestAction(() => {
      refreshCalls += 1;
      return true;
    });
    assert.equal(logbook.requestActionBound, true, 'runtime-bound logbook refresh actions should report as bound');
    assert.equal(logbook.request(), true, 'logbook refresh should delegate through the runtime action');
    assert.equal(refreshCalls, 1, 'logbook refresh should call the bound runtime action exactly once');

    logbook.bindRequestAction(null);
    assert.equal(logbook.requestActionBound, false, 'clearing the runtime-bound logbook refresh action should reset the bound flag');
  });

  console.log('\n--- settings ui stores ---\n');
  await test('settings form store tracks action busy state alongside status and pending copy', async () => {
    resetStoreTestContext();
    const store = useSettingsFormStore();

    assert.equal(store.saveEnabled, false, 'save should start disabled until the editor becomes dirty');
    assert.equal(await store.requestSave(), false, 'requestSave should report when no runtime action is bound');
    assert.equal(await store.requestReload(), false, 'requestReload should report when no runtime action is bound');

    let saveCalls = 0;
    let reloadCalls = 0;
    store.bindRuntimeActions({
      onSave() {
        saveCalls += 1;
      },
      onReload() {
        reloadCalls += 1;
      },
    });

    store.setSaveEnabled(true);
    store.setSaveBusy(true);
    store.setReloadBusy(true);
    store.startSaveFlash();
    store.setStatus('Unsaved changes.', 'pending');
    store.setPendingState(true, {
      title: 'Unsaved changes with restart-required updates',
      meta: 'Save now, then restart to apply: Aircraft profile override.',
    });

    assert.equal(store.saveActionBound, true, 'bindRuntimeActions should expose when the save action is bound');
    assert.equal(store.reloadActionBound, true, 'bindRuntimeActions should expose when the reload action is bound');
    assert.equal(await store.requestSave(), true, 'requestSave should delegate through the runtime-bound action');
    assert.equal(await store.requestReload(), true, 'requestReload should delegate through the runtime-bound action');
    assert.equal(saveCalls, 1, 'requestSave should call the runtime-bound save action once');
    assert.equal(reloadCalls, 1, 'requestReload should call the runtime-bound reload action once');
    assert.equal(store.saveEnabled, true, 'setSaveEnabled should expose the save button state');
    assert.equal(store.saveBusy, true, 'setSaveBusy should expose the save action busy state');
    assert.equal(store.reloadBusy, true, 'setReloadBusy should expose the reload action busy state');
    assert.equal(store.saveButtonDisabled, true, 'save button should disable while save is busy');
    assert.equal(store.reloadButtonDisabled, true, 'reload button should disable while reload is busy');
    assert.equal(store.saveButtonLabel, 'Saving...', 'save button label should reflect busy state');
    assert.equal(store.pendingSaveButtonLabel, 'Saving...', 'pending save button label should reflect busy state');
    assert.equal(store.reloadButtonLabel, 'Reloading...', 'reload button label should reflect busy state');
    assert.equal(store.pendingReloadButtonLabel, 'Reloading...', 'pending reload button label should reflect busy state');
    assert.equal(store.saveFlashActive, true, 'startSaveFlash should expose the save-button flash state');
    assert.equal(store.statusMessage, 'Unsaved changes.', 'setStatus should preserve the status message');
    assert.match(store.statusClass, /text-amber-400/, 'pending status should use the pending tone class');
    assert.equal(store.pendingVisible, true, 'setPendingState should reveal the pending bar');
    assert.equal(store.pendingTitle, 'Unsaved changes with restart-required updates', 'pending title should be stored verbatim');
    assert.equal(store.pendingMeta, 'Save now, then restart to apply: Aircraft profile override.', 'pending meta copy should be stored verbatim');

    store.clearSaveFlash();
    store.setSaveBusy(false);
    store.setReloadBusy(false);
    store.bindRuntimeActions({});
    assert.equal(store.saveFlashActive, false, 'clearSaveFlash should clear the save-button flash state');
    assert.equal(store.saveActionBound, false, 'bindRuntimeActions should clear the save action when it is removed');
    assert.equal(store.reloadActionBound, false, 'bindRuntimeActions should clear the reload action when it is removed');
    assert.equal(store.saveButtonLabel, 'Save Settings', 'save button label should reset when save is idle');
    assert.equal(store.pendingSaveButtonLabel, 'Save Now', 'pending save button label should reset when save is idle');
    assert.equal(store.reloadButtonLabel, 'Reload', 'reload button label should reset when reload is idle');
    assert.equal(store.pendingReloadButtonLabel, 'Discard Changes', 'pending reload button label should reset when reload is idle');
  });

  await test('settings ui store normalizes MSFS install scan state for Vue rendering', async () => {
    resetStoreTestContext();
    const store = useSettingsUiStore();
    let detectCalls = 0;
    let storageCalls = 0;
    let storageOpenCalls = 0;
    let storageCopyCalls = 0;
    let legalCalls = 0;
    let revealCalls = 0;
    store.bindDesktopActions({
      async detectMsfsInstalls() {
        detectCalls += 1;
        return [{
          id: 'steam',
          label: 'MSFS Steam',
          found: true,
          localCache: 'C:/Users/SimPilot/AppData/Roaming/Microsoft Flight Simulator',
          packagesFolder: 'D:/MSFS/Packages',
          communityFolder: 'D:/MSFS/Packages/Community',
          officialFolder: 'D:/MSFS/Packages/Official',
        }];
      },
      async getStorageLocations() {
        storageCalls += 1;
        return {
          success: true,
          locations: [{
            id: 'flightLogs',
            label: 'Flight Logs',
            path: 'C:/Users/SimPilot/Documents/Flight Fabric/Flight Logs',
            description: 'User-visible CSV flight recordings.',
          }],
        };
      },
      async openStorageLocation(targetPath) {
        storageOpenCalls += 1;
        return { success: targetPath.includes('Flight Logs') };
      },
      async copyStorageLocationPath(targetPath) {
        storageCopyCalls += 1;
        return targetPath.includes('Flight Logs');
      },
      async openLegalFile(filename) {
        legalCalls += 1;
        return { success: filename === 'LICENSE.md', error: 'missing' };
      },
      async revealLegalFolder() {
        revealCalls += 1;
        return { success: true };
      },
    });

    assert.equal(store.canDetectMsfsInstalls, true, 'Electron install detection should light up from the store getter');
    assert.equal(store.isElectron, true, 'Electron availability should follow the bound desktop actions');
    assert.equal(store.openMsfsInstallsModal(), true, 'openMsfsInstallsModal should open when the Electron bridge is available');
    assert.equal(store.msfsInstallsModalOpen, true, 'modal state should be store-backed');
    assert.equal(store.msfsDetectActionBound, true, 'desktop detection binding should be store-backed');
    assert.equal(store.storageLocationActionBound, true, 'storage-location loading binding should be store-backed');
    assert.equal(store.openStorageLocationActionBound, true, 'storage-location opening binding should be store-backed');
    assert.equal(store.copyStorageLocationActionBound, true, 'storage-location copy binding should be store-backed');
    assert.equal(store.openLegalFileActionBound, true, 'legal-file binding should be store-backed');
    assert.equal(store.revealLegalFolderActionBound, true, 'legal-folder binding should be store-backed');

    assert.equal(await store.requestStorageLocations(), true, 'requestStorageLocations should delegate through the runtime-bound action');
    assert.equal(storageCalls, 1, 'requestStorageLocations should call the runtime-bound loader exactly once');
    assert.equal(store.storageLocationRows.length, 1, 'storage locations should normalize into render rows through the store');
    assert.equal(store.storageLocationRows[0].copyLabel, 'Copy Path', 'storage rows should expose copy button copy');
    assert.equal(await store.requestOpenStorageLocation(store.storageLocationRows[0]), true, 'requestOpenStorageLocation should delegate through the runtime-bound opener');
    assert.equal(storageOpenCalls, 1, 'requestOpenStorageLocation should call the runtime-bound opener exactly once');
    assert.equal(await store.requestCopyStorageLocationPath(store.storageLocationRows[0]), true, 'requestCopyStorageLocationPath should delegate through the runtime-bound copy action');
    assert.equal(storageCopyCalls, 1, 'requestCopyStorageLocationPath should call the runtime-bound copy action exactly once');
    assert.equal(store.storageLocationRows[0].copyLabel, 'Copied', 'copying a storage path should temporarily update the row label');

    assert.equal(await store.requestMsfsInstallDetection(), true, 'requestMsfsInstallDetection should delegate through the runtime-bound detector');
    assert.equal(detectCalls, 1, 'requestMsfsInstallDetection should call the runtime-bound detector exactly once');
    assert.equal(store.msfsInstallRows.length, 1, 'detected installs should normalize into render rows through the store');
    assert.equal(store.msfsInstallRows[0].badgeText, 'Found', 'normalized rows should carry the found badge');
    assert.equal(store.msfsInstallRows[0].paths.length, 4, 'found installs should preserve the expected path rows');

    store.setMsfsDetecting(true);
    assert.equal(store.msfsDetecting, true, 'setMsfsDetecting should mark the detector busy');
    assert.equal(store.msfsDetectButtonLabel, 'Scanning...', 'busy detector should change the button label');
    assert.equal(store.msfsDetectEmptyMessage, 'Scanning local install metadata...', 'busy detector should change the empty-state copy');

    store.setMsfsDetectError('Detection failed: permissions denied');
    assert.equal(store.msfsDetectError, 'Detection failed: permissions denied', 'scan errors should be stored verbatim');
    assert.equal(store.msfsInstallRows.length, 0, 'scan errors should clear stale install rows');

    assert.equal(await store.requestOpenLegalFile('LICENSE.md'), true, 'requestOpenLegalFile should delegate through the runtime-bound action');
    assert.equal(await store.requestOpenLegalFile('THIRD_PARTY_NOTICES.md'), false, 'requestOpenLegalFile should surface store-backed errors when the runtime action fails');
    assert.equal(legalCalls, 2, 'requestOpenLegalFile should call the runtime action for each request');
    assert.match(store.legalError, /Could not open THIRD_PARTY_NOTICES\.md: missing/, 'failed legal-file requests should surface store-backed error copy');

    assert.equal(await store.requestRevealLegalFolder(), true, 'requestRevealLegalFolder should delegate through the runtime-bound action');
    assert.equal(revealCalls, 1, 'requestRevealLegalFolder should call the runtime action exactly once');

    store.setRestartActionState({
      available: true,
      busy: true,
      title: 'Restarts the desktop app',
    });
    let restartCalls = 0;
    store.bindRestartAction(() => {
      restartCalls += 1;
    });
    assert.equal(store.restartActionAvailable, true, 'restart action availability should be store-backed');
    assert.equal(store.restartActionBusy, true, 'restart action busy state should be store-backed');
    assert.equal(store.restartActionBound, true, 'restart action binding should be store-backed');
    assert.equal(store.restartActionDisabled, true, 'restart action disabled getter should combine busy and availability');
    assert.equal(store.restartActionLabel, 'Restarting...', 'restart action label should reflect the busy state');
    assert.equal(store.restartActionTitle, 'Restarts the desktop app', 'restart action title should be store-backed');
    assert.equal(await store.requestRestart(), true, 'requestRestart should delegate through the runtime-bound action');
    assert.equal(restartCalls, 1, 'requestRestart should call the runtime-bound action exactly once');

    store.resetMsfsDetectState();
    assert.equal(store.msfsDetectError, '', 'resetMsfsDetectState should clear the error copy');
    assert.equal(store.msfsDetecting, false, 'resetMsfsDetectState should clear the busy flag');
    assert.equal(store.msfsInstallRows.length, 0, 'resetMsfsDetectState should clear scan rows');

    store.closeMsfsInstallsModal();
    store.bindRestartAction(null);
    store.bindDesktopActions({});
    assert.equal(store.restartActionBound, false, 'bindRestartAction should clear the runtime-bound restart action');
    assert.equal(store.canDetectMsfsInstalls, false, 'clearing desktop bindings should reset store-backed detector availability');
    assert.equal(store.storageLocationActionBound, false, 'clearing desktop bindings should reset storage-location availability');
    assert.equal(store.copyStorageLocationActionBound, false, 'clearing desktop bindings should reset storage-location copy availability');
    assert.equal(store.msfsInstallsModalOpen, false, 'closeMsfsInstallsModal should hide the modal');
  });

  console.log('\n--- settings-editor store ---\n');
  await test('settings editor store sanitizes values', () => {
    resetStoreTestContext();
    const store = useSettingsEditorStore();

    store.applySettings({
      aircraft: { profile: '  custom-a320  ' },
      network: { wsPort: '99999', httpPort: 80, remoteAccess: false, remoteAircraftControl: true, updateChecks: true, onlineMapTiles: true },
      recording: { autoStart: false },
      cabinAnnouncements: { enabled: false, style: ' crew standard !! ', startupGraceMs: '7777' },
      debrief: {
        stabilityCriteria: {
          gateRaFt: '1500',
          speedPlusKts: '999',
          passPct: 101,
        },
      },
    });

    assert.equal(store.aircraftProfile, 'custom-a320', 'profile should be trimmed by shared normalization');
    assert.equal(store.wsPort, '65535', 'ws port should clamp to the supported max');
    assert.equal(store.httpPort, '1024', 'http port should clamp to the supported min');
    assert.equal(store.remoteAccess, false, 'explicit booleans should survive normalization');
    assert.equal(store.remoteAircraftControl, false, 'aircraft control should fail closed when remote access is disabled');
    assert.equal(store.updateChecks, true, 'update-check preference should hydrate into editor state');
    assert.equal(store.onlineMapTiles, true, 'online map tile preference should hydrate into editor state');
    assert.equal(store.recordingAutoStart, false, 'recording auto-start setting should hydrate into editor state');
    assert.equal(store.stabilityCriteria.gateRaFt, 1500, 'stability gate should normalize into editor state');
    assert.equal(store.stabilityCriteria.speedPlusKts, 50, 'stability speed plus should clamp into editor state');
    assert.equal(store.stabilityCriteria.passPct, 100, 'stability pass percentage should clamp into editor state');

    store.cabinAnnouncementsStyle = ' crew standard !! ';
    store.sanitizeCabinAnnouncementStyleValue();
    assert.equal(store.cabinAnnouncementsStyle, 'crewstandard', 'style sanitizer should remove unsupported characters');

    store.cabinAnnouncementsStartupGraceMs = '999999';
    store.sanitizeStartupGraceValue();
    assert.equal(store.cabinAnnouncementsStartupGraceMs, '60000', 'startup grace should clamp to the configured max');

    store.aircraftProfile = '   ';
    store.sanitizeAircraftProfile();
    assert.equal(store.aircraftProfile, 'auto', 'empty profile should fall back to auto');

    const serialized = store.serializeSettings();
    assert.equal(serialized.debrief.stabilityCriteria.gateRaFt, 1500, 'serialized settings should include stability gate criteria');
    assert.equal(serialized.debrief.stabilityCriteria.speedPlusKts, 50, 'serialized settings should include clamped stability speed criteria');
    assert.equal(serialized.network.wsPort, 65535, 'serialized settings should carry normalized numeric ports');
    assert.equal(serialized.network.remoteAircraftControl, false, 'serialized settings should keep remote aircraft control off without LAN access');
    assert.equal(serialized.network.updateChecks, true, 'serialized settings should carry update-check preference');
    assert.equal(serialized.network.onlineMapTiles, true, 'serialized settings should carry online map tile preference');
    assert.equal(serialized.recording.autoStart, false, 'serialized settings should keep recording auto-start disabled');
  });

  await test('settings editor store round-trips trusted-LAN aircraft control when remote access is enabled', () => {
    resetStoreTestContext();
    const store = useSettingsEditorStore();

    store.applySettings({
      network: { remoteAccess: true, remoteAircraftControl: true },
    });

    assert.equal(store.remoteAccess, true);
    assert.equal(store.remoteAircraftControl, true);
    assert.equal(store.serializeSettings().network.remoteAircraftControl, true);
  });

  await test('settings editor store replaces stale X-Plane selections with MSFS', () => {
    resetStoreTestContext();
    const store = useSettingsEditorStore();

    store.applySettings({
      simulator: { protocol: 'XPLANE_WEB' },
    });

    assert.equal(store.simconnectProtocol, 'KittyHawk', 'the unavailable protocol should not hydrate into editable state');
    assert.equal(
      store.serializeSettings().simulator.protocol,
      'KittyHawk',
      'saving any setting should replace a stale X-Plane protocol rather than preserve it',
    );
  });

  await test('settings editor store round-trips normalized settings without introducing a dirty diff', () => {
    resetStoreTestContext();
    const store = useSettingsEditorStore();

    const normalizedSettings = sharedSettings.normalizeAppSettings({
      aircraft: { profile: 'fenix-a320' },
    }, {
      defaults: sharedSettings.APP_SETTINGS_DEFAULTS,
    });

    store.applySettings(normalizedSettings);
    assert.deepEqual(store.serializeSettings(), normalizedSettings, 'serializeSettings should match the normalized settings that were applied');
  });

  console.log('\n--- preferences store ---\n');
  await test('preferences store hydrates frontend preferences and delegates runtime-backed actions', () => {
    resetStoreTestContext();
    const preferences = usePreferencesStore();

    preferences.hydrate({
      fuelUnit: 'kg',
      showBranding: false,
    });
    assert.equal(preferences.fuelUnit, 'kg', 'preferences store should hydrate the persisted fuel unit');
    assert.equal(preferences.showBranding, false, 'preferences store should hydrate the persisted branding preference');

    let cycleCalls = 0;
    const brandingCalls = [];
    preferences.registerRuntimeActions({
      cycleFuelUnit() {
        cycleCalls += 1;
      },
      applyShowBranding(show) {
        brandingCalls.push(show);
      },
    });

    assert.equal(preferences.requestFuelUnitCycle(), true, 'store should report when a runtime-backed fuel unit action exists');
    assert.equal(cycleCalls, 1, 'store should delegate fuel unit changes to the registered runtime action');
    assert.equal(preferences.requestShowBranding(true), true, 'store should report when a runtime-backed branding action exists');
    assert.deepEqual(brandingCalls, [true], 'store should delegate branding changes to the registered runtime action');

    preferences.registerRuntimeActions({});
    assert.equal(preferences.requestFuelUnitCycle(), false, 'store should return false when no runtime-backed fuel unit action is available');
    assert.equal(preferences.requestShowBranding(true), false, 'store should fall back when no runtime-backed branding action is available');
    assert.equal(preferences.showBranding, true, 'branding fallback should still update local store state');
  });

  console.log('\n--- theme store ---\n');
  await test('theme store forces the single dark theme through runtime bindings', () => {
    const storage = createStorage({ 'ff-theme-v2': 'web3-light' });
    resetStoreTestContext({ storage });
    const theme = useThemeStore();
    const appliedThemes = [];

    theme.bindRuntime({
      applyThemeAttributes(name) {
        appliedThemes.push(name);
        return name;
      },
    });
    assert.equal(theme.runtimeBound, true, 'theme store should report when runtime theme actions are bound');

    theme.initialize();
    assert.equal(theme.currentTheme, 'dark', 'theme initialization should force the dark theme');
    assert.deepEqual(appliedThemes, ['dark'], 'theme initialization should delegate dark DOM application through the runtime binding');

    assert.equal(theme.applyTheme('light'), 'dark', 'theme application should normalize removed light themes');
    assert.equal(theme.currentTheme, 'dark', 'theme application should store the normalized theme id');
    assert.equal(storage.getItem('ff-theme-v2'), 'dark', 'theme application should persist the normalized theme id');
    assert.deepEqual(appliedThemes, ['dark', 'dark'], 'theme application should keep delegating DOM updates through the runtime binding');

    theme.bindRuntime();
    assert.equal(theme.runtimeBound, false, 'clearing theme runtime bindings should reset the bound flag');
  });

  console.log('\n--- live-map store ---\n');
  await test('live-map store sanitizes ICAO inputs, clamps progress, and exposes follow state', () => {
    resetStoreTestContext();
    const store = useLiveMapStore();

    store.setTargetInput(' yssy!!! ');
    store.setOriginInput('kjfk-extra');
    assert.equal(store.targetInput, 'YSSY', 'target ICAO should be uppercased and stripped');
    assert.equal(store.originInput, 'KJFK', 'origin ICAO should clamp to four characters');

    store.setFollowStatus('paused');
    assert.equal(store.followStatusLabel, 'Paused', 'paused state should surface the correct label');
    assert.match(store.followStatusClass, /amber/i, 'paused state should use the amber badge style');
    assert.equal(store.centerButtonLabel, 'Resume Follow', 'paused state should change the center action label');

    store.setFollowStatus('unexpected-value');
    assert.equal(store.followStatusKind, 'following', 'invalid states should snap back to following');

    store.setMapEmptyState({ visible: true, message: 'Waiting for GPS lock' });
    assert.equal(store.mapEmptyVisible, true, 'live-map empty state should be visible when requested');
    assert.equal(store.mapEmptyMessage, 'Waiting for GPS lock', 'live-map empty-state copy should be store-backed');

    store.setDestinationProgress({ visible: true, label: 'Destination', text: '120 NM', percent: 145 });
    assert.equal(store.destinationProgressVisible, true, 'progress bar should become visible');
    assert.equal(store.destinationProgressPercent, 100, 'progress should clamp at 100%');
    assert.equal(store.destinationProgressWidthStyle.width, '100.0%', 'width style should reflect the clamped value');

    store.setOverlay({ visible: true, rotationDeg: 87, primary: '087°', secondary: '12 NM' });
    assert.equal(store.overlayVisible, true, 'overlay should become visible');
    assert.equal(store.overlayArrowStyle.transform, 'rotate(87deg)', 'overlay arrow should reflect the provided bearing');

    const runtimeActions = [];
    assert.equal(store.requestCenter(), false, 'center requests should report when no runtime action is bound');
    assert.equal(store.requestSetTarget(), false, 'target requests should report when no runtime action is bound');
    assert.equal(store.requestClearTarget(), false, 'target clear requests should report when no runtime action is bound');
    assert.equal(store.requestSetOrigin(), false, 'origin requests should report when no runtime action is bound');
    assert.equal(store.requestClearOrigin(), false, 'origin clear requests should report when no runtime action is bound');

    store.bindRuntimeActions({
      onCenter() {
        runtimeActions.push('center');
      },
      onSetTarget() {
        runtimeActions.push('set-target');
      },
      onClearTarget() {
        runtimeActions.push('clear-target');
      },
      onSetOrigin() {
        runtimeActions.push('set-origin');
      },
      onClearOrigin() {
        runtimeActions.push('clear-origin');
      },
    });

    assert.equal(store.requestCenter(), true, 'center requests should delegate through the bound runtime action');
    assert.equal(store.requestSetTarget(), true, 'target requests should delegate through the bound runtime action');
    assert.equal(store.requestClearTarget(), true, 'target clear requests should delegate through the bound runtime action');
    assert.equal(store.requestSetOrigin(), true, 'origin requests should delegate through the bound runtime action');
    assert.equal(store.requestClearOrigin(), true, 'origin clear requests should delegate through the bound runtime action');
    assert.deepEqual(
      runtimeActions,
      ['center', 'set-target', 'clear-target', 'set-origin', 'clear-origin'],
      'live-map runtime actions should preserve the requested route operations',
    );

    store.hideMapEmptyState();
    store.hideDestinationProgress();
    store.hideOverlay();
    assert.equal(store.mapEmptyVisible, false, 'hideMapEmptyState should collapse the live-map empty state');
    assert.equal(store.destinationProgressVisible, false, 'hideDestinationProgress should collapse the bar');
    assert.equal(store.overlayVisible, false, 'hideOverlay should collapse the overlay');

    store.resetMapEmptyState();
    assert.equal(store.mapEmptyVisible, true, 'resetMapEmptyState should restore the default empty-state visibility');
    assert.equal(store.mapEmptyMessage, 'No live GPS position yet', 'resetMapEmptyState should restore the default empty-state copy');
  });

  console.log('\n--- timeline store ---\n');
  await test('timeline store filters flights, persists UI state, and drives websocket actions', () => {
    const storage = createStorage({
      'flightFabric.timelineMapFilters.v1': JSON.stringify({ landing: true, markers: true }),
      'ff-pfd-overlay-collapsed': '1',
    });
    resetStoreTestContext({ storage });

    const sent = [];
    let selectedLanding = null;

    const store = useTimelineStore();
    store.bindRequestActions({
      onRequestList(payload) {
        sent.push(payload);
        return true;
      },
      onRequestTimeline(payload) {
        sent.push(payload);
        return true;
      },
      onDeleteFlight(payload) {
        sent.push(payload);
        return true;
      },
    });
    assert.equal(store.mapFilters.landing, true, 'stored map filters should hydrate into the store');
    assert.equal(store.mapFilters.markers, true, 'stored map filters should preserve explicit values');
    assert.equal(store.pfdCollapsed, true, 'stored PFD collapse state should hydrate into the store');
    assert.equal(store.requestListActionBound, true, 'runtime-bound timeline list requests should report as bound');
    assert.equal(store.requestTimelineActionBound, true, 'runtime-bound timeline detail requests should report as bound');
    assert.equal(store.deleteFlightActionBound, true, 'runtime-bound timeline delete requests should report as bound');

    store.ingestMessage({
      type: 'timelineList',
      flights: [
        { flightId: 'F2', route: 'YSSY-KJFK', aircraft: 'A320', timestamp: '2026-05-25T10:00:00Z', fuelBurnGal: 120 },
        { flightId: 'F1', route: 'EGLL-LFPG', aircraft: 'B738', timestamp: '2026-05-24T10:00:00Z', fuelBurnGal: 80 },
      ],
      storage: { dir: 'C:/Flights', exists: true, fileCount: 2, totalBytes: 4096 },
    });
    assert.equal(store.listStatus, 'loaded', 'timeline list ingestion should flip the list state to loaded');
    assert.equal(store.storagePath, 'C:/Flights', 'storage metadata should be exposed via getters');

    store.setRouteFilter('yssy');
    assert.equal(store.visibleFlights.length, 1, 'route filter should narrow visible flights');
    assert.equal(store.visibleFlights[0].flightId, 'F2', 'route filter should keep the matching flight');

    store.setRouteFilter('');
    store.setAircraftFilter('b738');
    assert.equal(store.visibleFlights.length, 1, 'aircraft filter should narrow visible flights');
    assert.equal(store.visibleFlights[0].flightId, 'F1', 'aircraft filter should keep the matching flight');

    store.setAircraftFilter('');
    store.setSort('fuel_burn_desc');
    assert.equal(store.visibleFlights[0].flightId, 'F2', 'fuel-burn sort should place the highest burn first');
    store.setSort('recent');

    assert.equal(store.requestList(), true, 'requestList should send when websocket is open');
    assert.equal(store.listStatus, 'loading', 'requestList should flip the list state to loading');
    assert.deepEqual(sent.shift(), {
      type: 'requestTimelineList',
      useHistoryIndex: true,
      limit: 300,
      offset: 0,
      requestId: 1,
    }, 'requestList should emit the indexed timeline list request');

    assert.equal(store.requestTimeline('flight.csv', 'F2'), true, 'requestTimeline should support file-path payloads');
    assert.deepEqual(sent.shift(), {
      type: 'requestTimeline',
      filePath: 'flight.csv',
      flightId: 'F2',
      requestId: 1,
    }, 'requestTimeline should send request-scoped file-path payloads when given a CSV path');
    assert.equal(store.timelineLoading, true, 'requestTimeline should mark timeline detail loading while the backend responds');
    assert.equal(store.timelineLoadingFlightKey, 'flight.csv', 'requestTimeline should default the loading key to the requested CSV path');
    assert.equal(store.timelineMobileViewerOpen, true, 'requestTimeline should open the fullscreen mobile timeline viewer when a request is sent');
    assert.equal(store.mapEmptyVisible, true, 'requestTimeline should show replay-map loading feedback while the backend responds');
    assert.equal(store.mapEmptyMessage, 'Loading timeline replay...', 'requestTimeline should replace stale replay-map empty copy while loading');
    store.closeTimelineMobileViewer();
    assert.equal(store.timelineMobileViewerOpen, false, 'closeTimelineMobileViewer should hide the fullscreen mobile timeline viewer without clearing the loaded timeline');
    store.clearTimelineLoading();
    assert.equal(store.timelineLoading, false, 'clearTimelineLoading should reset timeline detail loading state');

    assert.equal(store.requestTimeline('flight.csv', 'F2', { flightKey: 'F2-key', flightLabel: 'EGLL-LFPG' }), true, 'requestTimeline should accept loading display metadata');
    assert.deepEqual(sent.shift(), {
      type: 'requestTimeline',
      filePath: 'flight.csv',
      flightId: 'F2',
      requestId: 2,
    }, 'requestTimeline should keep loading metadata local while assigning a fresh request id');
    assert.equal(store.timelineLoadingFlightKey, 'F2-key', 'requestTimeline should store the supplied loading key');
    assert.equal(store.timelineLoadingFlightLabel, 'EGLL-LFPG', 'requestTimeline should store the supplied loading label');
    store.clearTimelineLoading();

    assert.equal(store.requestTimeline(undefined, 'F2', { flightKey: 'F2', flightLabel: 'Fallback ID' }), true, 'requestTimeline should fall back to the legacy flight id when no CSV path is available');
    assert.deepEqual(sent.shift(), {
      type: 'requestTimeline',
      flightId: 'F2',
      requestId: 3,
    }, 'requestTimeline should send a request-scoped flight-id payload when rows have no CSV path');
    assert.equal(store.timelineLoadingFlightKey, 'F2', 'requestTimeline should keep loading feedback tied to flight-id-only rows');
    assert.equal(store.timelineLoadingFlightLabel, 'Fallback ID', 'requestTimeline should keep loading copy for flight-id-only rows');
    store.clearTimelineLoading();

    const isoFlightId = '2026-08-08T01:02:03.000Z';
    assert.equal(store.requestTimeline(isoFlightId, isoFlightId), true, 'ISO recording identities should remain flight IDs');
    assert.deepEqual(sent.shift(), {
      type: 'requestTimeline',
      flightId: isoFlightId,
      requestId: 4,
    }, 'a timestamp dot in a flight ID must not be mistaken for a local file path');
    store.clearTimelineLoading();

    store.setLoadedTimelineIdentity({
      filePath: 'C:/Flights/F2.csv',
      flightId: 'F2',
      route: 'YSSY-KJFK',
      aircraft: 'Standard Cabin',
      aircraftProfileId: 'inibuilds-tristar',
      startTime: '2026-08-14T07:05:00.000Z',
      simDateTimeLocal: '2026-08-13T19:24:36',
      simDateTimeUtc: '2026-08-13T09:24:36Z',
    });
    assert.equal(store.loadedTimelineSimDateTimeLocal, '2026-08-13T19:24:36', 'loaded identity should retain simulator-local flight time');
    assert.equal(store.loadedTimelineSimDateTimeUtc, '2026-08-13T09:24:36Z', 'loaded identity should retain simulator UTC flight time');
    assert.equal(store.loadedTimelineRecordingStartTime, '2026-08-14T07:05:00.000Z', 'loaded identity should retain the recording start time');
    assert.equal(store.loadedTimelineAircraftProfileId, 'inibuilds-tristar', 'loaded identity should retain the recorded aircraft profile id');
    assert.equal(store.refreshTimelinePage(), true, 'page refresh should request the flight list and reload the open timeline');
    assert.deepEqual(sent.shift(), {
      type: 'requestTimelineList',
      useHistoryIndex: true,
      limit: 300,
      offset: 0,
      requestId: 2,
    }, 'page refresh should refresh the saved-flight list first');
    assert.deepEqual(sent.shift(), {
      type: 'requestTimeline',
      filePath: 'C:/Flights/F2.csv',
      flightId: 'F2',
      requestId: 5,
    }, 'page refresh should reload the currently open timeline with the shared request sequence');
    assert.equal(store.timelineLoadingFlightKey, 'C:/Flights/F2.csv', 'page refresh should show loading feedback for the open timeline');
    assert.equal(store.timelineLoadingFlightLabel, 'YSSY-KJFK', 'page refresh should preserve the open timeline label');
    assert.equal(store.timelineMobileViewerOpen, true, 'page refresh should preserve an already-open timeline viewer');
    store.clearTimelineLoading();

    store.closeTimelineMobileViewer();
    store.setLoadedTimelineIdentity({
      filePath: 'C:/Flights/F2.csv',
      flightId: 'F2',
      route: 'YSSY-KJFK',
    });
    assert.equal(store.refreshTimelinePage(), true, 'page refresh should still reload the last timeline after its viewer is closed');
    sent.shift();
    assert.deepEqual(sent.shift(), {
      type: 'requestTimeline',
      filePath: 'C:/Flights/F2.csv',
      flightId: 'F2',
      requestId: 6,
    }, 'closed-viewer refresh should still update the timeline data in the background');
    assert.equal(store.timelineMobileViewerOpen, false, 'page refresh should not reopen a closed timeline viewer');
    store.clearTimelineLoading();

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let finishTimerCallback = null;
    let finishTimerDelay = null;
    globalThis.setTimeout = (callback, delay) => {
      finishTimerCallback = callback;
      finishTimerDelay = delay;
      return 444;
    };
    globalThis.clearTimeout = () => {};
    try {
      assert.equal(store.requestTimeline('fast.csv', 'F3'), true, 'requestTimeline should start loading before fast backend responses');
      assert.deepEqual(sent.shift(), {
        type: 'requestTimeline',
        filePath: 'fast.csv',
        flightId: 'F3',
        requestId: 7,
      }, 'fast timeline requests should still send the request-scoped CSV payload');
      store.timelineLoadingStartedAtMs = typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
      store.finishTimelineLoading();
      assert.equal(store.timelineLoading, true, 'finishTimelineLoading should keep very fast responses visible for a paintable moment');
      assert.equal(typeof finishTimerCallback, 'function', 'finishTimelineLoading should schedule a delayed clear for fast responses');
      assert.ok(finishTimerDelay > 0 && finishTimerDelay <= 500, 'finishTimelineLoading should use a short delayed clear');
      finishTimerCallback();
      assert.equal(store.timelineLoading, false, 'the delayed finish callback should clear timeline loading');

      assert.equal(store.requestTimeline('first-fast.csv', 'F4'), true, 'a new fast timeline request should start loading');
      assert.deepEqual(sent.shift(), {
        type: 'requestTimeline',
        filePath: 'first-fast.csv',
        flightId: 'F4',
        requestId: 8,
      }, 'the first fast request should be sent');
      store.timelineLoadingStartedAtMs = typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
      store.finishTimelineLoading();
      const staleFinishTimerCallback = finishTimerCallback;
      assert.equal(store.requestTimeline('second-fast.csv', 'F5'), true, 'a newer timeline request should replace pending finish timers');
      assert.deepEqual(sent.shift(), {
        type: 'requestTimeline',
        filePath: 'second-fast.csv',
        flightId: 'F5',
        requestId: 9,
      }, 'the second fast request should be sent');
      staleFinishTimerCallback();
      assert.equal(store.timelineLoading, true, 'a stale finish timer should not clear a newer timeline request');
      assert.equal(store.timelineLoadingFlightKey, 'second-fast.csv', 'a newer timeline request should keep its loading key');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      store.clearTimelineLoading();
    }

    assert.equal(store.deleteFlight('flight.csv', { mtimeMs: 1779638400000, sizeBytes: 8192 }), true, 'deleteFlight should send when websocket is open');
    assert.deepEqual(sent.shift(), {
      type: 'deleteFlightCsv',
      filePath: 'flight.csv',
      mtimeMs: 1779638400000,
      sizeBytes: 8192,
    }, 'deleteFlight should send the delete request');

    const landingEvent = { type: 'landing', id: 42 };
    store.setDetail({ visible: true, selectedLandingEvent: landingEvent });
    assert.equal(store.openSelectedLanding(), false, 'openSelectedLanding should report when no runtime landing action is bound');
    store.bindDetailActions({
      onOpenSelectedLanding(event) {
        selectedLanding = event;
        return true;
      },
    });
    assert.equal(store.detailLandingActionBound, true, 'timeline detail actions should report when the landing handoff is bound');
    assert.equal(store.openSelectedLanding(), true, 'openSelectedLanding should dispatch through the bound landing handler');
    assert.deepEqual(selectedLanding, landingEvent, 'openSelectedLanding should pass the selected event through unchanged');
    store.openTimelineMobileViewer();
    let landingLoadStarted = false;
    let landingLoadError = '';
    store.bindDetailActions({
      onOpenSelectedLanding(event) {
        selectedLanding = event;
        return true;
      },
      onFlightLandingLoadStart() {
        landingLoadStarted = true;
      },
      onFlightLandingLoadError(error) {
        landingLoadError = String(error || '');
      },
    });
    assert.equal(store.openFlightLanding({
      filePath: 'full-flight.csv',
      flightId: 'F6',
      latestLandingEvent: { id: 'from-flight-row', grade: 'Good' },
    }), true, 'flight-row landing shortcut should request the full timeline before opening the landing card');
    assert.equal(landingLoadStarted, true, 'flight-row landing shortcut should publish loading state for the modal');
    assert.deepEqual(sent.shift(), {
      type: 'requestTimeline',
      filePath: 'full-flight.csv',
      flightId: 'F6',
      requestId: 10,
    }, 'flight-row landing shortcut should share the normal Timeline request sequence');
    assert.equal(store.timelineMobileViewerOpen, false, 'flight-row landing shortcut should close any open timeline modal without switching tabs');
    assert.equal(store.openPendingFlightLandingFromTimeline({
      events: [
        { id: 'taxi', type: 'phase' },
        { id: 'from-flight-row', type: 'landing', grade: 'Outstanding', touchdownDistance: { distanceFt: 305 } },
      ],
    }), true, 'full timeline response should open the matching landing event');
    assert.deepEqual(
      selectedLanding,
      { id: 'from-flight-row', type: 'landing', grade: 'Outstanding', touchdownDistance: { distanceFt: 305 } },
      'flight-row landing shortcut should open the full timeline landing event instead of the summary payload',
    );
    assert.equal(landingLoadError, '', 'successful landing timeline load should not publish an error');

    const selectedRows = [];
    store.bindInspectorActions({
      onSelectRow(row) {
        selectedRows.push(row.rowKey);
        store.setDetail({
          visible: true,
          type: 'Landing',
          title: 'Landing at YSSY 34L',
        });
      },
    });
    store.setInspectorState({
      flightIdText: 'YSSY-KJFK (2h 0m)',
      routeText: 'YSSY-KJFK',
      routeVisible: true,
      rows: [{
        rowKey: 'landing-row',
        title: 'Landing at YSSY 34L',
        subtitle: '136 kts - 305ft TDZ',
        timeOffsetText: '00:12',
        badges: [{ text: 'OUTSTANDING', toneClass: 'positive' }],
        countText: '',
        type: 'marker',
      }],
      selectedRowKey: '',
      emptyVisible: false,
    });
    assert.equal(store.inspectorEventListVisible, true, 'timeline inspector should expose visible rows through the store');
    assert.equal(store.inspectorRouteVisible, true, 'timeline inspector route visibility should be store-backed');
    store.setInspectorState({ emptyVisible: true, emptyMessage: 'Could not load timeline: CSV is too large' });
    assert.equal(store.inspectorEmptyVisible, true, 'setInspectorState should show empty state when no rows exist');
    assert.equal(store.inspectorEmptyMessage, 'Could not load timeline: CSV is too large', 'setInspectorState should store custom empty-state copy');
    store.setInspectorState({
      rows: [{
        rowKey: 'landing-row',
        title: 'Landing at YSSY 34L',
        subtitle: '136 kts - 305ft TDZ',
        timeOffsetText: '00:12',
        badges: [{ text: 'OUTSTANDING', toneClass: 'positive' }],
        countText: '',
        type: 'marker',
      }],
      selectedRowKey: '',
      emptyVisible: false,
    });
    assert.equal(store.selectEventRow('landing-row'), true, 'selectEventRow should route clicks through the bound store handler');
    assert.equal(store.inspectorSelectedRowKey, 'landing-row', 'selectEventRow should track the active row key');
    assert.deepEqual(selectedRows, ['landing-row'], 'selectEventRow should call the registered inspector selection handler');

    store.setInspectorState({
      rows: [
        { rowKey: 'phase-row', event: { type: 'phase_start' } },
        { rowKey: 'first-landing-row', event: { type: 'landing' } },
        { rowKey: 'taxi-row', event: { type: 'phase_start' } },
        { rowKey: 'latest-landing-row', event: { type: 'landing' } },
      ],
      emptyVisible: false,
    });
    assert.equal(store.latestLandingInspectorRow?.rowKey, 'latest-landing-row', 'landing shortcut should target the most recent landing in the full inspector list');
    assert.equal(store.selectLatestLandingRow(), true, 'landing shortcut should reuse normal inspector row selection');
    assert.equal(store.inspectorSelectedRowKey, 'latest-landing-row', 'landing shortcut should select the landing row');
    assert.deepEqual(selectedRows, ['landing-row', 'latest-landing-row'], 'landing shortcut should call the same inspector selection handler as a timeline row click');

    store.setDetail({
      visible: true,
      type: 'Landing',
      title: 'Landing at YSSY 34L',
      metricSections: [{
        key: 'landing-snapshot',
        title: 'Landing Snapshot',
        rows: [{ key: 'ias', label: 'IAS', value: '136 kts' }],
        noteText: '',
        emptyText: '',
      }],
      approachProfileHtml: '<svg viewBox=\"0 0 10 10\"></svg>',
      topdownProfileHtml: '<svg viewBox=\"0 0 10 10\"><circle cx=\"5\" cy=\"5\" r=\"2\" /></svg>',
      landingActionVisible: true,
      selectedLandingEvent: landingEvent,
    });
    assert.equal(store.detailMetricSections.length, 1, 'setDetail should store structured metric sections');
    assert.equal(store.detailMetricSections[0].rows[0].value, '136 kts', 'detail metric rows should preserve their value text');
    assert.match(store.detailTopdownProfileHtml, /<circle/, 'setDetail should preserve generated top-down profile markup');

    store.setMapFilter('scores', true);
    const persistedFilters = JSON.parse(storage.getItem('flightFabric.timelineMapFilters.v1'));
    assert.equal(persistedFilters.scores, true, 'setMapFilter should persist the new filter state');

    store.togglePfdCollapsed();
    assert.equal(storage.getItem('ff-pfd-overlay-collapsed'), '0', 'togglePfdCollapsed should persist the collapsed state');
    store.clearInspector();
    assert.equal(store.inspectorEventListVisible, false, 'clearInspector should remove timeline rows from the store');
    assert.equal(store.inspectorEmptyVisible, true, 'clearInspector should restore the empty inspector state');
    assert.equal(store.inspectorEmptyMessage, 'No timeline loaded', 'clearInspector should restore the default empty copy');
    assert.equal(store.selectLatestLandingRow(), false, 'landing shortcut should be unavailable without a landing row');
  });

  await test('timeline store shares one monotonic request sequence across replay entry points', () => {
    resetStoreTestContext();

    const timelineSent = [];
    const listSent = [];
    const store = useTimelineStore();
    store.bindRequestActions({
      onRequestTimeline(payload) {
        timelineSent.push(payload);
        return true;
      },
      onRequestList(payload) {
        listSent.push(payload);
        return true;
      },
    });
    store.bindDetailActions({ onOpenSelectedLanding: () => true });

    assert.equal(store.requestTimeline('first.csv', 'F-first'), true);
    assert.equal(store.requestFlightLanding({
      filePath: 'landing.csv',
      flightId: 'F-landing',
      latestLandingEvent: { id: 'landing-1', type: 'landing' },
    }), true);
    assert.ok(store.pendingFlightLandingRequest, 'landing shortcut should own the current replay handoff');

    store.setLoadedTimelineIdentity({
      filePath: 'rescored.csv',
      flightId: 'F-rescored',
    });
    store.analysisRescoreStatus = 'refreshing';
    store.analysisRescoreLastAction = 'apply';
    assert.equal(store.requestFlightAnalysisRescoreRefresh(), true);

    assert.deepEqual(timelineSent.slice(0, 3), [
      { type: 'requestTimeline', filePath: 'first.csv', flightId: 'F-first', requestId: 1 },
      { type: 'requestTimeline', filePath: 'landing.csv', flightId: 'F-landing', requestId: 2 },
      { type: 'requestTimeline', filePath: 'rescored.csv', flightId: 'F-rescored', requestId: 3 },
    ], 'row selection, landing handoff, and post-rescore reload should share one sequence');
    assert.deepEqual(timelineSent[3], { type: 'requestLogbook', limit: 500 });
    assert.equal(listSent.length, 1, 'post-rescore reload should still refresh the history list');
    assert.equal(store.pendingFlightLandingRequest, null, 'a newer replay request should retire an older landing handoff');
    assert.equal(store.analysisRescorePendingRefreshRequestId, 3);
    assert.equal(store.isCurrentTimelineRequestMessage({ requestId: 2 }), false);
    assert.equal(store.isCurrentTimelineRequestMessage({ requestId: 3 }), true);
    assert.equal(store.isCurrentTimelineRequestMessage({}), false, 'uncorrelated normal replies should fail closed');

    store.clearTimelineLoading();
  });

  await test('timeline flight-analysis rescore is request-scoped, atomic, and refreshes all history views', () => {
    resetStoreTestContext();
    const timelineSent = [];
    const listSent = [];
    const store = useTimelineStore();
    store.bindRequestActions({
      onRequestTimeline(payload) {
        timelineSent.push(payload);
        return true;
      },
      onRequestList(payload) {
        listSent.push(payload);
        return true;
      },
    });
    store.setLoadedTimelineIdentity({
      filePath: 'C:/Flights/F-preview.csv',
      flightId: 'F-preview',
      route: 'YSSY-KJFK',
      analysisRescore: { applied: false, revision: 0 },
    });

    assert.equal(store.openAnalysisRescoreModal(), true, 'a loaded flight should open the dedicated scoring-review modal');
    assert.equal(store.analysisRescoreModalOpen, true);
    store.closeAnalysisRescoreModal();
    assert.equal(store.analysisRescoreModalOpen, false, 'scoring review should close without changing the loaded flight');

    assert.equal(store.canRequestAnalysisRescorePreview, true, 'a loaded historic flight should enable flight-level preview without selecting a landing');
    assert.equal(store.requestAnalysisRescorePreview(), true, 'preview should use the bound timeline request channel');
    assert.deepEqual(timelineSent.shift(), {
      type: 'requestTimeline',
      filePath: 'C:/Flights/F-preview.csv',
      flightId: 'F-preview',
      requestId: 1,
      scoringMode: 'current-preview',
    });
    assert.equal(store.analysisRescorePreviewStatus, 'loading');
    assert.equal(store.applyAnalysisRescorePreviewMessage({
      type: 'timeline',
      scoringMode: 'current-preview',
      requestId: 0,
      timeline: { analysisRescorePreview: {} },
    }), false, 'stale preview responses should be ignored');
    assert.equal(store.analysisRescorePreviewStatus, 'loading');

    assert.equal(store.applyAnalysisRescorePreviewMessage({
      type: 'timeline',
      scoringMode: 'current-preview',
      requestId: 1,
      timeline: {
        analysisRescorePreview: {
          available: true,
          previewFingerprint: 'preview-fingerprint',
          baseRevision: 0,
          sourceFingerprint: 'source-fingerprint',
          analysisContractFingerprint: 'contract-fingerprint',
          changedMetricCount: 2,
          landingCount: 1,
          landings: [{
            landingKey: '42',
            label: 'Landing at KJFK 22L',
            metrics: [
              { key: 'touchdown-rate', label: 'Touchdown rate', recorded: 'GOOD', current: 'FIRM', changed: true },
              { key: 'stability', label: 'Approach stability', recorded: 'Stable 86%', current: 'Unstable 72%', changed: true },
              { key: 'bounce', label: 'Bounce', recorded: 'Clean', current: 'Clean', changed: false },
            ],
          }],
        },
      },
    }), true);
    assert.equal(store.analysisRescorePreviewStatus, 'ready');
    assert.equal(store.analysisRescorePreview.changedMetricCount, 2);
    assert.equal(store.analysisRescorePreview.groups[0].metrics[0].label, 'Touchdown rate');
    assert.equal(store.analysisRescorePreview.groups[0].metrics[2].changed, false);

    assert.equal(store.applyCurrentFlightAnalysisRescore(), true, 'a complete preview should be durably applicable as one snapshot');
    assert.deepEqual(timelineSent.shift(), {
      type: 'applyFlightAnalysisRescore',
      filePath: 'C:/Flights/F-preview.csv',
      flightId: 'F-preview',
      requestId: 1,
      previewFingerprint: 'preview-fingerprint',
      baseRevision: 0,
      sourceFingerprint: 'source-fingerprint',
      analysisContractFingerprint: 'contract-fingerprint',
    }, 'apply must send only immutable preview guards, never client-computed scores');
    assert.equal(store.applyFlightAnalysisRescoreResult({
      type: 'flightAnalysisRescoreResult',
      requestId: 0,
      action: 'apply',
      success: true,
      revision: 3,
    }), false, 'stale mutation results should be ignored');
    assert.equal(store.applyFlightAnalysisRescoreResult({
      type: 'flightAnalysisRescoreResult',
      requestId: 1,
      action: 'apply',
      success: true,
      revision: 3,
      appliedAt: '2026-08-08T00:00:00.000Z',
      snapshotFingerprint: 'saved-snapshot-3',
    }), true);
    assert.equal(store.analysisRescoreStatus, 'refreshing');
    assert.equal(store.analysisRescore.applied, true);
    assert.equal(store.analysisRescorePreview, null, 'saved previews should be discarded because their fingerprints are now stale');

    assert.equal(store.requestFlightAnalysisRescoreRefresh(), true);
    assert.deepEqual(timelineSent.shift(), {
      type: 'requestTimeline',
      filePath: 'C:/Flights/F-preview.csv',
      flightId: 'F-preview',
      requestId: 1,
    }, 'successful apply should reload the effective Timeline');
    assert.deepEqual(timelineSent.shift(), { type: 'requestLogbook', limit: 500 }, 'successful apply should refresh Logbook');
    assert.equal(listSent.length, 1, 'successful apply should refresh the flight list and history index');
    store.setLoadedTimelineIdentity({
      filePath: 'C:/Flights/F-preview.csv',
      flightId: 'F-preview',
      analysisRescore: {
        applied: true,
        revision: 3,
        appliedAt: '2026-08-08T00:00:00.000Z',
        snapshotFingerprint: 'saved-snapshot-3',
      },
    });
    assert.equal(store.finishFlightAnalysisRescoreRefresh({ requestId: 1 }), true);
    assert.equal(store.analysisRescoreStatus, 'applied');

    assert.equal(store.revertFlightAnalysisRescore(), true, 'the whole saved analysis should expose one reversible restore action');
    assert.deepEqual(timelineSent.shift(), {
      type: 'revertFlightAnalysisRescore',
      filePath: 'C:/Flights/F-preview.csv',
      flightId: 'F-preview',
      requestId: 2,
      expectedRevision: 3,
      expectedSnapshotFingerprint: 'saved-snapshot-3',
    });
    assert.equal(store.applyFlightAnalysisRescoreResult({
      type: 'flightAnalysisRescoreResult',
      requestId: 2,
      action: 'revert',
      success: true,
      revision: 4,
    }), true);
    assert.equal(store.analysisRescoreStatus, 'refreshing');
    assert.equal(store.analysisRescore.applied, false);

    store.clearAnalysisRescoreActionState();
    assert.equal(store.requestAnalysisRescorePreview(), true);
    assert.equal(store.applyAnalysisRescorePreviewMessage({
      type: 'timeline',
      scoringMode: 'current-preview',
      requestId: 2,
      timeline: {
        analysisRescorePreview: {
          available: true,
          complete: true,
          previewFingerprint: 'incomplete-preview',
          baseRevision: 4,
          sourceFingerprint: 'source-fingerprint',
          analysisContractFingerprint: 'contract-fingerprint',
          landings: [{
            landingKey: '42',
            available: false,
            reason: 'recorded_profile_unavailable',
            metrics: [],
          }],
        },
      },
    }), true);
    assert.equal(store.analysisRescorePreview.available, false, 'one unavailable landing must fail the flight-wide preview closed');
    assert.equal(store.canApplyFlightAnalysisRescore, false, 'partial flight analysis must never be saveable');

    assert.equal(store.requestAnalysisRescorePreview(), true);
    assert.equal(store.applyAnalysisRescorePreviewError({
      type: 'timelineError',
      scoringMode: 'current-preview',
      requestId: 3,
      error: 'Recorded profile is unavailable',
    }), true);
    assert.equal(store.analysisRescorePreviewStatus, 'error');
    assert.equal(store.analysisRescorePreviewError, 'Recorded profile is unavailable');
  });

  await test('timeline store surfaces timeline list failures instead of an empty-list state', () => {
    resetStoreTestContext();

    const sent = [];
    const store = useTimelineStore();
    store.bindRequestActions({
      onRequestList(payload) {
        sent.push(payload);
        return true;
      },
    });

    assert.equal(store.requestList(), true, 'timeline list refresh should send through the bound runtime action');
    assert.equal(store.listStatus, 'loading', 'requestList should mark the list as loading');
    assert.equal(store.emptyStateMessage, 'Loading saved timelines...', 'empty list loading state should not look like a legitimate empty log');

    store.ingestMessage({
      type: 'timelineListError',
      error: 'Privileged session required for this action.',
    });

    assert.equal(store.listStatus, 'error', 'timeline list errors should flip the list state to error');
    assert.equal(store.emptyStateMessage, 'Privileged session required for this action.', 'timeline list errors should be visible to the user');
    assert.deepEqual(sent, [{
      type: 'requestTimelineList',
      useHistoryIndex: true,
      limit: 300,
      offset: 0,
      requestId: 1,
    }], 'timeline list failure test should issue exactly one request');
  });

  await test('timeline store keeps the first-load placeholder while an active CSV read is retryable', () => {
    resetStoreTestContext();

    const store = useTimelineStore();
    store.bindRequestActions({ onRequestList: () => true });
    store.requestList();
    store.ingestMessage({
      type: 'timelineListError',
      requestId: 1,
      error: 'Active flight CSV is not ready yet',
      retryable: true,
      retryAfterMs: 500,
    });

    assert.equal(store.listStatus, 'loading', 'retryable first-load races should remain visibly in progress');
    assert.equal(store.listErrorMessage, '', 'transient storage details should not be exposed as the page error');
    assert.equal(store.emptyStateMessage, 'Loading saved timelines...', 'retryable first loads should keep loading copy visible');
  });

  await test('timeline store times out an unanswered list request and re-enables refresh', () => {
    resetStoreTestContext();

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let timeoutCallback = null;
    let timeoutDelay = null;
    const clearedTimers = [];
    globalThis.setTimeout = (callback, delay) => {
      timeoutCallback = callback;
      timeoutDelay = delay;
      return 4242;
    };
    globalThis.clearTimeout = (timerId) => {
      clearedTimers.push(timerId);
    };

    try {
      const store = useTimelineStore();
      store.bindRequestActions({ onRequestList: () => true });
      assert.equal(store.requestList(), true);
      assert.equal(store.listStatus, 'loading');
      assert.equal(timeoutDelay, 30_000, 'saved-flight requests should have a bounded response wait');

      timeoutCallback();

      assert.equal(store.listStatus, 'error', 'an unanswered request must leave the loading state');
      assert.equal(
        store.emptyStateMessage,
        'Saved flights did not respond. Select Refresh Page to try again.',
      );
      assert.equal(store._timelineListResponseTimer, null);

      store.markListDisconnected();
      assert.equal(store.listStatus, 'not-connected');
      assert.equal(store.emptyStateMessage, 'Not connected to backend');
      assert.deepEqual(clearedTimers, []);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  await test('timeline store clears stale viewer state when a new timeline starts loading', () => {
    resetStoreTestContext();

    const store = useTimelineStore();
    store.setLoadedTimelineIdentity({
      filePath: 'old-flight.csv',
      flightId: 'OLD',
      route: 'EGLL-LFPG',
      aircraft: 'Airbus A320',
      aircraftProfileId: 'fbw-a32nx',
      startTime: '2026-01-03T02:45:00.000Z',
      simDateTimeLocal: '2026-01-02T15:30:00',
      simDateTimeUtc: '2026-01-02T14:30:00Z',
    });
    store.setSummary({
      visible: true,
      eventCountText: '42',
      violationCountText: '3',
      durationText: '1h',
      distanceText: '144 NM',
      fuelBurnText: '365 kg',
      scoreImpactText: '-2',
    });
    store.setInspectorState({
      flightIdText: 'EGLL-LFPG (1h)',
      routeText: 'EGLL-LFPG',
      routeVisible: true,
      rows: [{ rowKey: 'old-row', title: 'Old landing', badges: [] }],
      selectedRowKey: 'old-row',
      emptyVisible: false,
    });
    store.setDetail({
      visible: true,
      type: 'Landing',
      title: 'Old landing detail',
      metricSections: [{ key: 'old', rows: [] }],
    });
    store.setScrubberState({
      visible: true,
      disabled: false,
      max: '120000',
      value: '45000',
    });
    store.setAltitudeProfileState({
      visible: true,
      pathD: 'M 22 70 L 624 12',
    });

    store.beginTimelineLoading({
      flightKey: 'new-flight.csv',
      flightLabel: 'YSSY-KJFK',
    });

    assert.equal(store.timelineLoading, true, 'beginTimelineLoading should put the viewer in loading mode');
    assert.equal(store.timelineLoadingFlightKey, 'new-flight.csv', 'loading state should track the requested flight');
    assert.equal(store.loadedTimelineFlightLabel, '', 'loading a new flight should clear the old loaded title');
    assert.equal(store.loadedTimelineAircraftLabel, '', 'loading a new flight should clear the old aircraft type');
    assert.equal(store.loadedTimelineAircraftProfileId, '', 'loading a new flight should clear the old aircraft profile id');
    assert.equal(store.loadedTimelineRecordingStartTime, '', 'loading a new flight should clear the old recording start time');
    assert.equal(store.loadedTimelineSimDateTimeLocal, '', 'loading a new flight should clear the old simulator-local datetime');
    assert.equal(store.loadedTimelineSimDateTimeUtc, '', 'loading a new flight should clear the old simulator UTC datetime');
    assert.equal(store.summaryVisible, false, 'loading a new flight should hide the previous summary');
    assert.equal(store.detailVisible, false, 'loading a new flight should hide the previous detail panel');
    assert.equal(store.inspectorEventListVisible, false, 'loading a new flight should clear stale inspector rows');
    assert.equal(store.inspectorEmptyVisible, true, 'loading a new flight should show an inspector placeholder');
    assert.equal(store.inspectorEmptyMessage, 'Loading timeline replay...', 'loading copy should be explicit in the inspector');
    assert.equal(store.inspectorFlightIdText, 'Opening timeline...', 'inspector header should not repeat the requested route');
    assert.equal(store.scrubberVisible, false, 'loading a new flight should hide the previous scrubber');
    assert.equal(store.altitudeProfileVisible, false, 'loading a new flight should hide the previous altitude profile');
    assert.equal(store.mapEmptyVisible, true, 'loading a new flight should show the replay placeholder');
    assert.equal(store.mapEmptyMessage, 'Loading timeline replay...', 'map placeholder should make loading clear');
  });

  await test('timeline store appends indexed Recent Flights pages without rebuilding the first page', () => {
    resetStoreTestContext();

    const sent = [];
    const store = useTimelineStore();
    store.bindRequestActions({
      onRequestList(payload) {
        sent.push(payload);
        return true;
      },
    });

    store.ingestMessage({
      type: 'timelineList',
      flights: [
        { flightId: 'F1', filePath: 'C:/Flights/F1.csv', route: 'EGLL-LFPG', timestamp: '2026-05-24T10:00:00Z' },
        { flightId: 'F2', filePath: 'C:/Flights/F2.csv', route: 'KSEA-KSFO', timestamp: '2026-05-23T10:00:00Z' },
      ],
      index: {
        used: true,
        limit: 2,
        offset: 0,
        totalMatching: 4,
      },
    });

    assert.equal(store.hasMoreVisibleFlights, true, 'indexed metadata should expose backend pages beyond the loaded rows');
    assert.equal(store.flightsMeta, 'Showing 2 of 4 saved flights', 'indexed metadata should show loaded rows against backend total');

    store.showMoreFlights();
    assert.deepEqual(sent, [{
      type: 'requestTimelineList',
      useHistoryIndex: true,
      limit: 300,
      offset: 2,
      requestId: 1,
    }], 'showMoreFlights should request the next indexed page when all loaded rows are visible');

    store.ingestMessage({
      type: 'timelineList',
      flights: [
        { flightId: 'F2-duplicate', filePath: 'C:/Flights/F2.csv', route: 'KSEA-KSFO', timestamp: '2026-05-23T10:00:00Z' },
        { flightId: 'F3', filePath: 'C:/Flights/F3.csv', route: 'YSSY-YMML', timestamp: '2026-05-22T10:00:00Z' },
        { flightId: 'F4', filePath: 'C:/Flights/F4.csv', route: 'KLAX-KLAS', timestamp: '2026-05-21T10:00:00Z' },
      ],
      index: {
        used: true,
        limit: 2,
        offset: 2,
        totalMatching: 4,
      },
    });

    assert.deepEqual(
      store.flights.map((flight) => flight.flightId),
      ['F1', 'F2', 'F3', 'F4'],
      'indexed append should merge new rows while ignoring duplicate file identities',
    );
    assert.equal(store.hasMoreVisibleFlights, false, 'all indexed rows should clear the show-more affordance');
  });

  await test('timeline store ignores stale indexed list pages and errors', () => {
    resetStoreTestContext();

    const sent = [];
    const store = useTimelineStore();
    store.bindRequestActions({
      onRequestList(payload) {
        sent.push(payload);
        return true;
      },
    });

    store.requestList({ offset: 300 });
    store.requestList({ offset: 0 });
    assert.equal(sent[0].requestId, 1, 'the older page should carry the first request id');
    assert.equal(sent[1].requestId, 2, 'the replacement page should carry a newer request id');

    store.ingestMessage({
      type: 'timelineList',
      requestId: 2,
      flights: [{ flightId: 'CURRENT', filePath: 'C:/Flights/current.csv', timestamp: '2026-05-25T10:00:00Z' }],
      index: { used: true, paged: true, limit: 300, offset: 0, totalMatching: 1 },
    });
    store.ingestMessage({
      type: 'timelineList',
      requestId: 1,
      flights: [{ flightId: 'STALE', filePath: 'C:/Flights/stale.csv', timestamp: '2026-05-24T10:00:00Z' }],
      index: { used: true, paged: true, limit: 300, offset: 300, totalMatching: 301 },
    });
    store.ingestMessage({ type: 'timelineListError', requestId: 1, error: 'stale failure' });

    assert.deepEqual(store.flights.map((flight) => flight.flightId), ['CURRENT']);
    assert.equal(store.listStatus, 'loaded', 'a stale error should not replace the current successful result');
  });

  await test('timeline store sends backend filters for paged Recent Flights requests', () => {
    resetStoreTestContext();

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers = new Map();
    let nextTimerId = 1;
    globalThis.setTimeout = (callback) => {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, callback);
      return timerId;
    };
    globalThis.clearTimeout = (timerId) => {
      timers.delete(timerId);
    };

    try {
      const sent = [];
      const store = useTimelineStore();
      store.bindRequestActions({
        onRequestList(payload) {
          sent.push(payload);
          return true;
        },
      });

      store.ingestMessage({
        type: 'timelineList',
        flights: [
          { flightId: 'F1', filePath: 'C:/Flights/F1.csv', route: 'EGLL-LFPG', aircraft: 'B738', timestamp: '2026-05-24T10:00:00Z' },
          { flightId: 'F2', filePath: 'C:/Flights/F2.csv', route: 'KSEA-KSFO', aircraft: 'A320', timestamp: '2026-05-23T10:00:00Z' },
        ],
        index: {
          used: true,
          paged: true,
          limit: 2,
          offset: 0,
          totalMatching: 4,
        },
      });

      store.setRouteFilter(' ksfo ');
      store.setAircraftFilter(' A320 ');
      store.setSort('aircraft');
      assert.equal(sent.length, 0, 'filter changes should debounce backend list refreshes');
      assert.equal(timers.size, 1, 'filter/sort changes should coalesce to one backend refresh timer');
      for (const callback of [...timers.values()]) callback();

      assert.deepEqual(sent, [{
        type: 'requestTimelineList',
        useHistoryIndex: true,
        limit: 300,
        offset: 0,
        requestId: 1,
        routeFilter: 'ksfo',
        aircraftFilter: 'A320',
        sort: 'aircraft',
      }], 'backend-paged refresh should carry active filters and sort');

      sent.length = 0;
      store.ingestMessage({
        type: 'timelineList',
        flights: [
          { flightId: 'F2', filePath: 'C:/Flights/F2.csv', route: 'KSEA-KSFO', aircraft: 'A320', timestamp: '2026-05-23T10:00:00Z' },
        ],
        index: {
          used: false,
          paged: true,
          fallback: 'open_failed',
          limit: 1,
          offset: 0,
          totalMatching: 2,
        },
      });

      store.showMoreFlights();
      assert.deepEqual(sent, [{
        type: 'requestTimelineList',
        useHistoryIndex: true,
        limit: 300,
        offset: 1,
        requestId: 2,
        routeFilter: 'ksfo',
        aircraftFilter: 'A320',
        sort: 'aircraft',
      }], 'paged fallback metadata should still allow show-more requests with active filters');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  await test('timeline store removes flights from successful delete results', () => {
    resetStoreTestContext();

    const store = useTimelineStore();
    store.ingestMessage({
      type: 'timelineList',
      flights: [
        {
          flightId: 'F2',
          filePath: 'C:/Flights/delete-me.csv',
          route: 'YSSY-KJFK',
          timestamp: '2026-05-25T10:00:00Z',
          sizeBytes: 8192,
        },
        {
          flightId: 'F1',
          filePath: 'C:/Flights/keep-me.csv',
          route: 'EGLL-LFPG',
          timestamp: '2026-05-24T10:00:00Z',
          sizeBytes: 4096,
        },
      ],
      storage: { dir: 'C:/Flights', exists: true, fileCount: 2, totalBytes: 12288 },
    });

    store.ingestMessage({
      type: 'deleteFlightCsvResult',
      success: true,
      filePath: 'c:\\flights\\DELETE-ME.csv',
      storage: { dir: 'C:/Flights', exists: true, fileCount: 1, totalBytes: 4096 },
    });

    assert.deepEqual(store.flights.map((flight) => flight.flightId), ['F1'], 'successful delete result should remove the matching flight row');
    assert.equal(store.storage.fileCount, 1, 'delete result storage metadata should replace the previous file count');
    assert.equal(store.storage.totalBytes, 4096, 'delete result storage metadata should replace the previous byte total');
  });

  await test('timeline store fallback deletion subtracts the complete bundle size', () => {
    resetStoreTestContext();

    const store = useTimelineStore();
    store.ingestMessage({
      type: 'timelineList',
      flights: [{
        flightId: 'bundle-delete',
        filePath: 'C:/Flights/bundle-delete.csv',
        timestamp: '2026-05-25T10:00:00Z',
        sizeBytes: 8192,
        recordingBundleSizeBytes: 10240,
      }],
      storage: { dir: 'C:/Flights', exists: true, fileCount: 1, totalBytes: 10240 },
    });

    store.ingestMessage({
      type: 'deleteFlightCsvResult',
      success: true,
      filePath: 'C:/Flights/bundle-delete.csv',
    });

    assert.equal(store.storage.fileCount, 0);
    assert.equal(store.storage.totalBytes, 0, 'fallback storage math must remove CSV, sidecars, and certificate bytes');
  });

  await test('timeline store routes flights-panel browser actions through runtime bindings', async () => {
    resetStoreTestContext();

    const sent = [];
    const confirmations = [];
    const alerts = [];
    const openedDirs = [];
    const copiedDirs = [];
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;

    globalThis.setTimeout = (callback) => {
      callback();
      return 1;
    };
    globalThis.clearTimeout = () => {};

    try {
      const store = useTimelineStore();
      store.ingestMessage({
        type: 'timelineList',
        flights: [{
          flightId: 'F2',
          filePath: 'flight.csv',
          route: 'YSSY-KJFK',
          timestamp: '2026-05-25T10:00:00Z',
          mtimeMs: 1779638400000,
          sizeBytes: 16384,
          recordingBundleSizeBytes: 16384,
          csvMtimeMs: 1779638399000,
          csvSizeBytes: 8192,
        }],
        storage: { dir: 'C:/Flights', exists: true, fileCount: 1, totalBytes: 16384 },
      });
      store.bindRequestActions({
        onDeleteFlight(payload) {
          sent.push(payload);
          return true;
        },
      });
      store.bindPanelActions({
        confirmDeleteFlight(message) {
          confirmations.push(message);
          return true;
        },
        notifyDeleteUnavailable(message) {
          alerts.push(message);
          return true;
        },
        async openStorageFolder(dir) {
          openedDirs.push(dir);
          return true;
        },
        async copyStoragePath(dir) {
          copiedDirs.push(dir);
          return { copied: true };
        },
      });

      assert.equal(store.deleteConfirmationBound, true, 'timeline store should report when delete confirmations are runtime-bound');
      assert.equal(store.storageFolderActionBound, true, 'timeline store should report when folder-open actions are runtime-bound');
      assert.equal(store.storagePathCopyActionBound, true, 'timeline store should report when copy-path actions are runtime-bound');

      assert.equal(await store.requestOpenStorageFolder(), true, 'requestOpenStorageFolder should delegate through the runtime-bound action');
      assert.deepEqual(openedDirs, ['C:/Flights'], 'requestOpenStorageFolder should pass the resolved storage path through unchanged');

      assert.equal(await store.requestCopyStoragePath(), true, 'requestCopyStoragePath should delegate through the runtime-bound action');
      assert.deepEqual(copiedDirs, ['C:/Flights'], 'requestCopyStoragePath should forward the storage path through unchanged');
      assert.equal(store.storagePathCopyLabel, 'Copy Path', 'successful copy-path requests should reset the button label after the timer elapses');

      const flight = store.flights[0];
      assert.equal(await store.requestDeleteFlight(flight), true, 'requestDeleteFlight should delegate through the runtime-bound confirmation and delete actions');
      assert.match(confirmations[0], /Delete the recording for YSSY-KJFK \(16\.0 KB\)\?/, 'delete confirmations should include the route and complete bundle size');
      assert.match(confirmations[0], /CSV, sidecars, and completion metadata/, 'delete confirmations should describe the complete recording bundle');
      assert.deepEqual(sent, [{
        type: 'deleteFlightCsv',
        filePath: 'flight.csv',
        mtimeMs: 1779638399000,
        sizeBytes: 8192,
      }], 'requestDeleteFlight should send CSV identity metadata rather than the bundle total');

      store.bindRequestActions({
        onDeleteFlight() {
          return false;
        },
      });
      assert.equal(await store.requestDeleteFlight(flight), false, 'requestDeleteFlight should report when the delete request could not be sent');
      assert.deepEqual(alerts, ['Not connected to backend - cannot delete.'], 'requestDeleteFlight should route delete-unavailable feedback through the runtime-bound alert action');

      store.bindPanelActions({
        confirmDeleteFlight() {
          return false;
        },
      });
      assert.equal(await store.requestDeleteFlight(flight), false, 'requestDeleteFlight should stop when the runtime-bound confirmation is declined');
      assert.equal(sent.length, 1, 'declined confirmations should not emit any additional delete payloads');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  await test('timeline store tracks replay empty-state, scrubber state, and runtime-bound replay actions for Vue rendering', () => {
    resetStoreTestContext();
    const store = useTimelineStore();

    assert.equal(store.mapEmptyVisible, true, 'timeline map empty state should start visible');
    assert.equal(store.mapEmptyMessage, 'No positional event data yet', 'timeline map empty state should start with the default copy');
    assert.equal(store.scrubberVisible, false, 'timeline scrubber should start hidden');
    assert.equal(store.scrubberDisabled, true, 'timeline scrubber should start disabled');
    assert.equal(store.requestScrubOffset(15000, { shouldPanMap: false }), false, 'scrub requests should report when no replay action is bound');

    store.setMapEmptyState({
      visible: false,
      message: 'Using CARTO fallback tiles',
    });
    assert.equal(store.mapEmptyVisible, false, 'setMapEmptyState should update visibility');
    assert.equal(store.mapEmptyMessage, 'Using CARTO fallback tiles', 'setMapEmptyState should update the visible copy');

    store.setScrubberState({
      visible: true,
      disabled: false,
      min: 0,
      max: 30000,
      step: 250,
      value: 15000,
      currentLabel: '0:15',
      startLabel: '0:00',
      endLabel: '0:30',
    });
    assert.equal(store.scrubberVisible, true, 'setScrubberState should expose the scrubber');
    assert.equal(store.scrubberDisabled, false, 'setScrubberState should enable the scrubber');
    assert.equal(store.scrubberMax, '30000', 'scrubber max should normalize to string attributes');
    assert.equal(store.scrubberStep, '250', 'scrubber step should normalize to string attributes');
    assert.equal(store.scrubberValue, '15000', 'scrubber value should normalize to string attributes');
    assert.equal(store.scrubberCurrentLabel, '0:15', 'current scrubber label should be store-backed');
    assert.equal(store.scrubberEndLabel, '0:30', 'end scrubber label should be store-backed');

    store.setAltitudeProfileState({
      visible: true,
      pathD: 'M 22 70 L 624 12',
      fillD: 'M 22 78 L 22 70 L 624 12 L 624 78 Z',
      cursorVisible: true,
      cursorX: 312.5,
      cursorY: 41.25,
      currentText: '2,400 ft',
      rangeText: '1,200 ft - 3,600 ft',
      minText: '1,200 ft',
      maxText: '3,600 ft',
    });
    assert.equal(store.altitudeProfileVisible, true, 'altitude profile should be store-backed');
    assert.equal(store.altitudeProfilePathD, 'M 22 70 L 624 12', 'altitude profile path should be store-backed');
    assert.equal(store.altitudeProfileCursorVisible, true, 'altitude profile cursor should be store-backed');
    assert.equal(store.altitudeProfileCursorX, '312.5', 'altitude profile cursor x should normalize to a string attribute');
    assert.equal(store.altitudeProfileCurrentText, '2,400 ft', 'altitude profile current altitude should be store-backed');
    assert.equal(store.altitudeProfileRangeText, '1,200 ft - 3,600 ft', 'altitude profile altitude range should be store-backed');

    store.setPfdState({
      scale: '0.625',
      overlayOpacity: '1',
      headingDisplay: '087',
      speedDisplay: '142',
      altitudeDisplay: '3,450',
      pitchDisplay: '3',
      rollDisplay: '-1',
      adiTransform: 'rotate(1deg) translateY(12px)',
      rollPointerTransform: 'translateX(-50%) rotate(-1deg)',
    });
    assert.equal(store.pfdScale, '0.625', 'PFD overlay scale should be store-backed');
    assert.equal(store.pfdOverlayOpacity, '1', 'PFD overlay opacity should be store-backed');
    assert.equal(store.pfdHeadingDisplay, '087', 'PFD heading display should be store-backed');
    assert.equal(store.pfdSpeedDisplay, '142', 'PFD speed display should be store-backed');
    assert.equal(store.pfdAltitudeDisplay, '3,450', 'PFD altitude display should be store-backed');
    assert.equal(store.pfdPitchDisplay, '3', 'PFD pitch display should be store-backed');
    assert.equal(store.pfdRollDisplay, '-1', 'PFD roll display should be store-backed');
    assert.equal(store.pfdAdiTransform, 'rotate(1deg) translateY(12px)', 'PFD ADI transform should be store-backed');
    assert.equal(store.pfdRollPointerTransform, 'translateX(-50%) rotate(-1deg)', 'PFD roll pointer transform should be store-backed');

    const scrubRequests = [];
    store.bindReplayActions({
      onScrubOffset(offsetMs, options = {}) {
        scrubRequests.push({ offsetMs, options });
        return { offsetMs };
      },
    });
    assert.equal(store.scrubActionBound, true, 'runtime-bound replay actions should report as bound');
    assert.equal(store.requestScrubOffset('18000', { shouldPanMap: false }), true, 'scrub requests should delegate through the runtime action');
    assert.deepEqual(
      scrubRequests,
      [{ offsetMs: 18000, options: { shouldPanMap: false } }],
      'delegated scrub requests should preserve the numeric offset and options',
    );

    store.resetMapEmptyState();
    store.resetScrubberState();
    store.resetAltitudeProfileState();
    store.resetPfdState();
    store.bindReplayActions({});
    store.bindRequestActions({});
    assert.equal(store.mapEmptyVisible, true, 'resetMapEmptyState should restore the default visibility');
    assert.equal(store.mapEmptyMessage, 'No positional event data yet', 'resetMapEmptyState should restore the default copy');
    assert.equal(store.scrubberVisible, false, 'resetScrubberState should hide the scrubber');
    assert.equal(store.scrubberValue, '0', 'resetScrubberState should restore the default value');
    assert.equal(store.altitudeProfileVisible, false, 'resetAltitudeProfileState should hide the profile');
    assert.equal(store.altitudeProfilePathD, '', 'resetAltitudeProfileState should clear the profile path');
    assert.equal(store.pfdScale, '1', 'resetPfdState should restore the default PFD overlay scale');
    assert.equal(store.pfdHeadingDisplay, '---', 'resetPfdState should restore the default PFD readouts');
    assert.equal(store.pfdOverlayOpacity, '0.4', 'resetPfdState should restore the default PFD overlay opacity');
    assert.equal(store.scrubActionBound, false, 'clearing runtime-bound replay actions should reset the bound flag');
    assert.equal(store.requestListActionBound, false, 'clearing runtime-bound timeline list requests should reset the bound flag');
    assert.equal(store.requestTimelineActionBound, false, 'clearing runtime-bound timeline detail requests should reset the bound flag');
    assert.equal(store.deleteFlightActionBound, false, 'clearing runtime-bound timeline delete requests should reset the bound flag');
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log('\n--- profiles store ---\n');
  await test('profiles store gates profile runtime actions on acknowledged full-control scope', async () => {
    resetStoreTestContext();

    const profiles = useProfilesStore();
    const payloads = [];
    const toasts = [];
    profiles.bindRuntime({
      sendMessage(payload) {
        payloads.push(payload);
        return true;
      },
      showToast(kind, title, message) {
        toasts.push({ kind, title, message });
      },
    });
    assert.equal(profiles.messageActionBound, true, 'bindRuntime should expose when profile websocket actions are bound');
    assert.equal(profiles.toastActionBound, true, 'bindRuntime should expose when profile toast actions are bound');
    assert.equal(profiles.requestProfiles(), false, 'read-only clients should not dispatch profile-list requests');
    assert.equal(profiles.setAuthorizationScope('aircraft-control'), 'aircraft-control');
    assert.equal(profiles.requestProfiles(), false, 'aircraft-control clients should not dispatch profile-list requests');
    assert.deepEqual(payloads, []);
    assert.equal(profiles.setAuthorizationScope('full-control'), 'full-control');
    assert.equal(profiles.profileSelectionAvailable, true);
    assert.equal(profiles.requestProfiles(), true, 'requestProfiles should use the runtime websocket action');
    assert.deepEqual(payloads, [{ type: 'listProfiles' }]);
    assert.equal(profiles.setAuthorizationScope('unexpected-scope'), 'read-only');
    assert.equal(profiles.profileSelectionAvailable, false, 'unknown scopes should fail closed');
    profiles.bindRuntime();
    assert.equal(profiles.messageActionBound, false, 'bindRuntime should clear bound websocket actions when removed');
    assert.equal(profiles.toastActionBound, false, 'bindRuntime should clear bound toast actions when removed');
  });

  await test('profiles store keeps only release-owned bundled profile summaries', () => {
    resetStoreTestContext();

    const profiles = useProfilesStore();
    profiles.setAuthorizationScope('full-control');
    profiles.handleMessage({
      type: 'profileList',
      profiles: [
        {
          id: 'fenix-a320',
          name: 'Fenix A320',
          namespace: 'local',
          simulator: 'msfs',
          qualifiedId: 'local/msfs/fenix-a320',
        },
        {
          id: 'fbw-a32nx',
          name: 'FlyByWire A32NX',
          namespace: 'bundled',
          simulator: 'msfs',
          qualifiedId: 'bundled/msfs/fbw-a32nx',
        },
      ],
    });

    assert.deepEqual(profiles.installedProfiles.map((profile) => profile.qualifiedId), [
      'bundled/msfs/fbw-a32nx',
    ]);
    assert.deepEqual(profiles.builtInProfiles.map((profile) => profile.id), ['fbw-a32nx']);
    assert.equal(profiles.importProfile, undefined);
    assert.equal(profiles.copyProfileToLocal, undefined);
    assert.equal(profiles.deleteUserProfile, undefined);
  });

  await test('profiles store saves aircraft profile override settings', () => {
    resetStoreTestContext();

    const savedSettings = [];
    const toasts = [];
    const appSettings = useAppSettingsStore();
    appSettings.apply({
      settings: {
        aircraft: { profile: 'auto' },
      },
    });
    appSettings.bindRuntimeActions({
      onSaveSettings(nextSettings) {
        savedSettings.push(nextSettings);
        return true;
      },
    });

    const profiles = useProfilesStore();
    profiles.bindRuntime({
      showToast(kind, title, message) {
        toasts.push({ kind, title, message });
      },
    });

    const profile = {
      id: 'fss-e175',
      namespace: 'bundled',
      simulator: 'msfs',
      qualifiedId: 'bundled/msfs/fss-e175',
    };

    assert.equal(profiles.aircraftProfileOverrideActive, false, 'auto should not count as an active profile override');
    assert.equal(profiles.saveAircraftProfileOverride(profile), false, 'read-only clients should not save profile overrides');
    assert.deepEqual(savedSettings, []);
    assert.deepEqual(toasts, []);

    profiles.setAuthorizationScope('full-control');
    assert.equal(profiles.saveAircraftProfileOverride(profile), true, 'saving an override should delegate to app settings');
    assert.deepEqual(savedSettings[0], {
      aircraft: { profile: 'bundled/msfs/fss-e175' },
    }, 'profile override saves should use the qualified profile key');
    assert.equal(toasts[0].kind, 'warning', 'saving an override should warn that restart is required');

    appSettings.apply({ settings: savedSettings[0] });
    assert.equal(profiles.aircraftProfileOverrideActive, true, 'saved profile keys should count as an active override');
    assert.equal(profiles.isProfileOverrideSelected(profile), true, 'the matching row should report current override state');

    assert.equal(profiles.clearAircraftProfileOverride(), true, 'clearing the override should save auto');
    assert.deepEqual(savedSettings[1], {
      aircraft: { profile: 'auto' },
    }, 'clearing an override should restore auto detection');
  });

  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
