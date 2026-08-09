#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend');
const source = fs.readFileSync(path.join(FRONTEND_DIR, 'telemetry-ui.js'), 'utf8');
const WIDGET_ENTRYPOINTS = [
  'widgets-compact/widget.html',
  'widgets-compact/widget-autopilot.html',
  'widgets-compact/widget-bottom.html',
  'widgets-compact/widget-environment.html',
  'widgets-compact/widget-history.html',
  'widgets-compact/widget-top.html',
];
const STATEFUL_WIDGET_ENTRYPOINTS = [
  'widgets-compact/widget.html',
  'widgets-compact/widget-autopilot.html',
  'widgets-compact/widget-bottom.html',
  'widgets-compact/widget-environment.html',
  'widgets-compact/widget-top.html',
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readWidget(filename) {
  return fs.readFileSync(path.join(FRONTEND_DIR, filename), 'utf8');
}

function getClassicInlineScripts(html) {
  const scripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const attrs = match[1] || '';
    const body = match[2] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (/\btype\s*=\s*["']module["']/i.test(attrs)) continue;
    if (/\btype\s*=\s*["']importmap["']/i.test(attrs)) continue;
    if (!body.trim()) continue;
    scripts.push(body);
  }
  return scripts;
}

function loadTelemetryUi() {
  const context = {
    clearTimeout,
    console,
    encodeURIComponent,
    globalThis: null,
    location: { hostname: 'localhost', port: '8100', protocol: 'http:', search: '' },
    Promise,
    setTimeout,
    URLSearchParams,
    WebSocket: { OPEN: 1 },
    window: null,
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'frontend/telemetry-ui.js' });
  return context.TelemetryUI;
}

async function testWidgetClientFetchesBootstrapTokenAndRequestsState() {
  let openedUrl = '';
  const sentMessages = [];
  const fetchCalls = [];

  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      openedUrl = url;
      this.readyState = FakeWebSocket.OPEN;
      setTimeout(() => {
        if (typeof this.onopen === 'function') this.onopen();
      }, 0);
    }

    send(payload) {
      sentMessages.push(JSON.parse(payload));
    }

    close() {}
  }

  const context = {
    console,
    clearTimeout,
    encodeURIComponent,
    globalThis: null,
    location: {
      hostname: 'localhost',
      port: '8100',
      protocol: 'http:',
      search: '',
    },
    Promise,
    setTimeout,
    URLSearchParams,
    WebSocket: FakeWebSocket,
    window: null,
  };
  context.window = context;
  context.globalThis = context;
  context.fetch = async (url) => {
    fetchCalls.push(url);
    if (url === 'http://localhost:8100/api/bootstrap') {
      return { ok: true, json: async () => ({ wsAuthToken: 'widget-token' }) };
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'frontend/telemetry-ui.js' });

  context.TelemetryUI.onConnectionChange(() => {
    context.TelemetryUI.send({ type: 'requestState' });
  });
  await context.TelemetryUI.connect();
  await wait(10);

  assert.deepEqual(fetchCalls, ['http://localhost:8100/api/bootstrap']);
  assert.equal(openedUrl, 'ws://localhost:8099?token=widget-token');
  assert.deepEqual(sentMessages, [{ type: 'requestState' }]);
}

function testWidgetClassicInlineScriptsParse() {
  for (const filename of WIDGET_ENTRYPOINTS) {
    const scripts = getClassicInlineScripts(readWidget(filename));
    for (const [index, script] of scripts.entries()) {
      assert.doesNotThrow(
        () => new Function(script),
        `${filename} classic inline script #${index + 1} should parse`,
      );
    }
  }
}

function testStatefulWidgetsRequestReconnectState() {
  const requestStateRe = /TelemetryUI\.send\(\s*\{\s*type:\s*['"]requestState['"]\s*\}\s*\)/;
  for (const filename of STATEFUL_WIDGET_ENTRYPOINTS) {
    assert.match(
      readWidget(filename),
      requestStateRe,
      `${filename} should request a backend state snapshot when its WebSocket connects`,
    );
  }
}

function testHistoryWidgetDoesNotTreatMissingLightKeysAsOff() {
  const historySource = readWidget('widgets-compact/widget-history.html');
  assert.match(
    historySource,
    /function normalizeLights\(data\)/,
    'widget-history should normalize partial light packets before diffing',
  );
  assert.doesNotMatch(
    historySource,
    /const now = !!data\[k\], was = !!prevLights\[k\];/,
    'widget-history should not coerce missing light keys to OFF events',
  );
}

function testHistoryWidgetDoesNotTreatMissingAutopilotKeysAsOff() {
  const historySource = readWidget('widgets-compact/widget-history.html');
  assert.match(
    historySource,
    /function booleanApFlag\(value\)/,
    'widget-history should normalize autopilot flags through an explicit tri-state helper',
  );
  assert.match(
    historySource,
    /if \(athr !== null\) \{/,
    'widget-history should ignore partial A\/THR packets instead of treating them as OFF',
  );
  assert.match(
    historySource,
    /if \(now === null\) continue;/,
    'widget-history should ignore missing autopilot mode keys instead of resetting previous state',
  );
  assert.doesNotMatch(
    historySource,
    /return msg\.athrActive \? 'ACTIVE' : msg\.athrArmed \? 'ARMED' : 'OFF';/,
    'widget-history should not coerce missing A/THR fields to OFF',
  );
}

function testHistoryWidgetSquelchesStartupSourceSettling() {
  const historySource = readWidget('widgets-compact/widget-history.html');
  assert.match(
    historySource,
    /const STARTUP_EVENT_SQUELCH_MS = 8000;/,
    'widget-history should define a startup squelch window for source-settling noise',
  );
  assert.match(
    historySource,
    /function isStartupWarmup\(\)/,
    'widget-history should expose a startup warmup guard',
  );
  assert.match(
    historySource,
    /if \(!prevLights \|\| isStartupWarmup\(\)\) \{/,
    'widget-history should seed light state silently during startup warmup',
  );
  assert.match(
    historySource,
    /function seedApState\(msg\)/,
    'widget-history should seed AP state silently during startup warmup',
  );
  assert.match(
    historySource,
    /if \(isStartupWarmup\(\)\) \{\s*seedApState\(msg\);\s*return;\s*\}/,
    'widget-history should suppress AP source-settling events during startup warmup',
  );
}

function testHistoryWidgetDoesNotClearBetweenPhaseTransitions() {
  const historySource = readWidget('widgets-compact/widget-history.html');
  assert.doesNotMatch(
    historySource,
    /shouldClearForNewDeparture|clearedForDeparture|hasPostDeparturePhase|POST_DEPARTURE_PHASES|notePhaseProgress/,
    'widget-history should not keep phase-transition clearing state',
  );

  const onPhase = /function onPhase\(val\) \{([\s\S]*?)\n  \}/.exec(historySource);
  assert(onPhase, 'widget-history should define an onPhase handler');
  assert.doesNotMatch(
    onPhase[1],
    /clearEntries\(/,
    'widget-history should append phase events without clearing existing entries',
  );
  assert.match(
    onPhase[1],
    /push\(PHASE_ICONS\[val\]/,
    'widget-history should still log phase transitions',
  );
}

function testSharedLandingPresentationKeepsVerdictsFactual() {
  const { landingPresentation } = loadTelemetryUi().utils;
  const capped = landingPresentation({
    grade: 'PERFECT',
    touchdownDistance: {
      distanceFt: 600,
      grade: 'Outstanding',
      bounceCount: 1,
      bounceGrade: 'Single Bounce',
    },
    ultimateStability: { verdict: 'unstable', score: 84, gateStable: false },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(capped, 'grade'), false, 'presentation must not expose a hybrid overall grade');
  assert.equal(Object.prototype.hasOwnProperty.call(capped, 'gradeClass'), false, 'presentation must not expose a hybrid overall grade class');
  assert.equal(Object.prototype.hasOwnProperty.call(capped, 'perfectCapped'), false, 'presentation must not cap the touchdown-rate grade from peer facts');
  assert.equal(capped.touchdownGrade, 'PERFECT');
  assert.equal(capped.touchdownGradeClass, 'PERFECT');
  assert.equal(capped.tdzGrade, 'OUTSTANDING');
  assert.equal(capped.runwayExcursion, false);
  assert.equal(capped.approachLabel, 'UNSTABLE');
  assert.equal(capped.approachScoreText, '84% score');
  assert.equal(capped.approachClass, 'low');
  assert.equal(capped.stabilityLabel, 'UNSTABLE');
  assert.equal(capped.stabilityDetail, '84%');
  assert.equal(capped.bounceLabel, '1x');
  assert.equal(capped.bounceText, '1x');

  const verified = landingPresentation({
    grade: 'PERFECT',
    touchdownDistance: { distanceFt: 600, grade: 'Outstanding', bounceCount: 0, bounceGrade: 'Clean' },
    ultimateStability: { score: 96, gateStable: true },
  });
  assert.equal(verified.touchdownGrade, 'PERFECT');
  assert.equal(verified.stabilityLabel, 'STABLE');

  const topLevelBounce = landingPresentation({ grade: 'PERFECT', bounceCount: 1, bounceGrade: 'Single Bounce' });
  assert.equal(topLevelBounce.touchdownGrade, 'PERFECT');
  assert.equal(topLevelBounce.bounceText, '1x');

  const scoreOnly = landingPresentation({ grade: 'GOOD', ultimateStability: { score: 91 } });
  assert.equal(scoreOnly.approachLabel, 'NO VERDICT');
  assert.equal(scoreOnly.approachScoreText, '91% score');
  assert.equal(scoreOnly.approachClass, 'neutral');

  const failedGateWithoutFlag = landingPresentation({
    grade: 'GOOD',
    ultimateStability: { score: 91, gateFailures: ['speed_proxy_unstable_after_gate'] },
  });
  assert.equal(failedGateWithoutFlag.approachLabel, 'MARGINAL');
  assert.equal(failedGateWithoutFlag.approachClass, 'medium');

  const retiredFailureOnly = landingPresentation({
    grade: 'GOOD',
    ultimateStability: { score: 91, gateFailures: ['spoilers_moved_after_gate'] },
  });
  assert.equal(retiredFailureOnly.approachLabel, 'STABLE');

  const excursion = landingPresentation({
    grade: 'GOOD',
    runwayExcursion: true,
    touchdownDistance: { distanceFt: 600, grade: 'Outstanding' },
  });
  assert.equal(excursion.touchdownGrade, 'GOOD');
  assert.equal(excursion.tdzGrade, 'OUTSTANDING');
  assert.equal(excursion.runwayExcursion, true);
}

function testLandingWidgetsUseSharedPresentationAndRetainLateFacts() {
  for (const filename of ['widgets-compact/widget.html', 'widgets-compact/widget-top.html']) {
    const widgetSource = readWidget(filename);
    assert.match(widgetSource, /TelemetryUI\.utils\.landingPresentation\(msg\)/, `${filename} should use the shared landing presentation`);
    assert.match(widgetSource, /let latestFinalLanding = null;/, `${filename} should retain the latest final landing for late stability updates`);
    assert.match(widgetSource, /\$\('landing-bounce'\)\.textContent = presentation\.bounceLabel;/, `${filename} should retain bounce facts after a late stability update`);
    assert.match(widgetSource, />TD RATE</, `${filename} should use a source-neutral touchdown-rate label`);
    assert.match(widgetSource, />TD RATE GRADE</, `${filename} should explicitly scope the grade to touchdown rate`);
    assert.match(widgetSource, />APPROACH</, `${filename} should show the approach verdict at summary level`);
    assert.match(widgetSource, />BOUNCE</, `${filename} should show bounce at summary level`);
    assert.match(widgetSource, /presentation\.touchdownGrade/, `${filename} should not use the capped aggregate as its touchdown grade`);
    assert.match(widgetSource, /id="landing-tdz-detail"/, `${filename} should show the touchdown-zone grade separately`);
    assert.match(widgetSource, /presentation\.runwayExcursion \? 'RUNWAY EXCURSION'/, `${filename} should show runway excursions explicitly`);
  }

  const historySource = readWidget('widgets-compact/widget-history.html');
  assert.match(historySource, /TelemetryUI\.utils\.landingPresentation\(msg\)/, 'history should use the shared gate and bounce normalization');
  assert.match(historySource, /const grade = `TD RATE \$\{presentation\.touchdownGrade\}`;/, 'history should explicitly label the raw touchdown-rate grade, not a provisional overall');
  assert.match(historySource, /TD rate /, 'history should use a source-neutral touchdown-rate label');
  assert.match(historySource, /`TDZ \$\{Math\.round\(tdzDistance\)\} ft\$\{tdzGrade/, 'history should retain touchdown-zone distance and grade as a separate fact');
  assert.match(historySource, /presentation\.runwayExcursion \? 'RUNWAY EXCURSION'/, 'history should show runway excursions explicitly');
}

async function run() {
  await testWidgetClientFetchesBootstrapTokenAndRequestsState();
  testWidgetClassicInlineScriptsParse();
  testStatefulWidgetsRequestReconnectState();
  testHistoryWidgetDoesNotTreatMissingLightKeysAsOff();
  testHistoryWidgetDoesNotTreatMissingAutopilotKeysAsOff();
  testHistoryWidgetSquelchesStartupSourceSettling();
  testHistoryWidgetDoesNotClearBetweenPhaseTransitions();
  testSharedLandingPresentationKeepsVerdictsFactual();
  testLandingWidgetsUseSharedPresentationAndRetainLateFacts();
  console.log('telemetry-ui widget tests: 9 passed, 0 failed');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
