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

async function run() {
  await testWidgetClientFetchesBootstrapTokenAndRequestsState();
  testWidgetClassicInlineScriptsParse();
  testStatefulWidgetsRequestReconnectState();
  testHistoryWidgetDoesNotTreatMissingLightKeysAsOff();
  testHistoryWidgetDoesNotTreatMissingAutopilotKeysAsOff();
  testHistoryWidgetSquelchesStartupSourceSettling();
  testHistoryWidgetDoesNotClearBetweenPhaseTransitions();
  console.log('telemetry-ui widget tests: 7 passed, 0 failed');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
