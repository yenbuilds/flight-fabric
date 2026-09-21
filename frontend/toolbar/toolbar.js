/*
 * FlightFabric MSFS toolbar panel page.
 *
 * Served by the FlightFabric backend at /toolbar/ and hosted inside the
 * simulator's Coherent GT browser by the Community package loader. It is a
 * read-only loopback WebSocket client with a narrowed subscription: no
 * per-tick telemetry, no session token, no aircraft control.
 *
 * Coherent GT is an older WebKit: keep this file to ES2017 syntax (no
 * optional chaining, no nullish coalescing, no class fields) and render with
 * textContent only, never innerHTML with data.
 */

(function () {
  'use strict';

  var PAGE_SOURCE = 'flightfabric-toolbar';
  var LOADER_SOURCE = 'flightfabric-toolbar-loader';
  var PREFS_KEY = 'ff_toolbar_prefs_v1';
  var LANDING_KEY = 'ff_toolbar_last_landing_v1';
  var LANDING_TTL_MS = 6 * 60 * 60 * 1000;
  var LOOPBACK_HOST = '127.0.0.1';
  var RECONNECT_MIN_MS = 1000;
  var RECONNECT_MAX_MS = 15000;
  var SOCKET_CONNECT_TIMEOUT_MS = 10000;
  var HIDDEN_DISCONNECT_MS = 20000;
  var MAX_CAUTIONS = 6;
  var SUBSCRIPTION = [
    'simState', 'phase', 'flightTime', 'simTime', 'flightPlan', 'voiceStatus',
    'aircraftProfile', 'aircraftChanged', 'dataSources', 'landing', 'ultimateStabilityScore', 'toolbarFlightHistory',
    'flightRecording', 'flightStatus', 'flightViolation', 'fuelUnit', 'updateAvailable',
  ];

  var DEFAULT_PREFS = {
    theme: 'dark',
    scale: 'l',
    density: 'comfortable',
    timeZone: 'utc',
    weightUnit: 'plan',
    defaultTab: 'flight',
    openSections: {},
  };

  var TABS = [
    { id: 'flight', label: 'Flight', icon: 'M4 14l3-1 4-6 6-3 2 2-3 6-6 4-1 3-2-2 1-3-3-1z' },
    { id: 'plan', label: 'Plan', icon: 'M6 3h9l4 4v14H6z M15 3v4h4 M9 12h6 M9 16h6' },
    { id: 'voice', label: 'Voice', icon: 'M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z M6 11a6 6 0 0 0 12 0 M12 17v4 M9 21h6' },
  ];

  var GROUP_LABELS = {
    flightGuidance: 'Flight guidance', mcp: 'Mode control panel', afds: 'Autoflight',
    radios: 'Radios', surveillance: 'Transponder', approach: 'Approach setup',
    surfaces: 'Flight controls', flightControls: 'Flight controls', gear: 'Landing gear and brakes',
    lights: 'Exterior lights', lighting: 'Cockpit lighting', configuration: 'Presets', presets: 'Presets',
    propulsion: 'Engines and thrust', engines: 'Engines', electrical: 'Electrical', fuel: 'Fuel',
    hydraulics: 'Hydraulics', pneumatics: 'Pneumatics and air', air: 'Air systems', doors: 'Doors',
    navigation: 'Navigation', efis: 'EFIS', displays: 'Displays', overhead: 'Overhead panel',
    pedestal: 'Pedestal', warnings: 'Warnings', misc: 'Other systems',
  };
  var UNIT_LABELS = { degrees: 'deg', feet: 'ft', 'feet-per-minute': 'ft/min', knots: 'kt', mach: 'Mach', megahertz: 'MHz', percent: '%' };

  var VOICE_TONES = {
    listening: { dot: 'listening', title: 'Listening' },
    starting: { dot: 'listening', title: 'Opening microphone' },
    finishing: { dot: 'listening', title: 'Recognizing' },
    sending: { dot: 'listening', title: 'Sending command' },
    transcribed: { dot: 'good', title: 'Heard' },
    sent: { dot: 'good', title: 'Command sent' },
    ready: { dot: 'good', title: 'Ready for push-to-talk' },
    failed: { dot: 'danger', title: 'Command failed' },
    error: { dot: 'danger', title: 'Voice error' },
    unmatched: { dot: 'warn', title: 'Not understood' },
    blocked: { dot: 'warn', title: 'Voice blocked' },
    disabled: { dot: '', title: 'Voice control is off' },
    unavailable: { dot: '', title: 'Voice unavailable' },
    initializing: { dot: '', title: 'Voice starting' },
    unknown: { dot: '', title: 'Voice status' },
  };

  // ------------------------------------------------------------------ state

  var state = {
    connection: 'connecting', // connecting | waiting | connected | paused
    visible: true,
    appVersion: '',
    wsPort: null,
    packageVersion: '',
    scope: '',
    simState: null,
    phase: '',
    flightTime: null,
    simTime: null,
    aircraftProfile: null,
    commands: [],
    landing: null,
    recording: null,
    flightStatus: null,
    cautions: [],
    plan: null,
    voice: null,
    fuelUnit: '',
    updateAvailable: null,
    voiceReference: null,
    activeTab: 'flight',
    voiceSearch: '',
    settingsOpen: false,
  };

  var prefs = loadPrefs();
  var socket = null;
  var bootstrapRequest = null;
  var voiceReferenceRequest = null;
  var socketConnectTimer = null;
  var reloadTimer = null;
  var reloadPending = false;
  var reconnectTimer = null;
  var reconnectDelay = RECONNECT_MIN_MS;
  var hiddenTimer = null;
  var unloading = false;
  var pendingLanding = null;
  var historyFlightId = '';
  var awaitingTouchdown = false;

  // ------------------------------------------------------------------ DOM helpers

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function svgIcon(pathData, className) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', pathData);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.7');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function kv(label, value, sub, wide) {
    var box = el('div', 'kv' + (wide ? ' kv-wide' : ''));
    box.appendChild(el('div', 'kv-label', label));
    box.appendChild(el('div', 'kv-value', value));
    if (sub) box.appendChild(el('div', 'kv-sub', sub));
    return box;
  }

  function card(title, hint) {
    var node = el('div', 'card');
    if (title) {
      var head = el('div', 'card-head');
      head.appendChild(el('div', 'card-title', title));
      if (hint) head.appendChild(el('div', 'card-hint', hint));
      node.appendChild(head);
    }
    return node;
  }

  function emptyState(title, text) {
    var node = el('div', 'empty');
    node.appendChild(el('div', 'empty-title', title));
    if (text) node.appendChild(el('div', 'empty-text', text));
    return node;
  }

  function section(id, title, hint, build) {
    var open = prefs.openSections[id] === true;
    var wrap = el('div', 'section');
    var toggle = el('button', 'section-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-controls', 'section-' + id);
    var labelWrap = el('span');
    labelWrap.appendChild(el('span', '', title));
    if (hint) labelWrap.appendChild(el('span', 'section-hint', hint));
    toggle.appendChild(labelWrap);
    toggle.appendChild(svgIcon('M9 6l6 6-6 6', 'caret'));
    var body = el('div', 'section-body');
    body.id = 'section-' + id;
    if (!open) body.hidden = true;
    else build(body);
    toggle.addEventListener('click', function () {
      var next = body.hidden;
      body.hidden = !next;
      toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
      prefs.openSections[id] = next;
      savePrefs();
      if (next && !body.firstChild) build(body);
    });
    wrap.appendChild(toggle);
    wrap.appendChild(body);
    return wrap;
  }

  // ------------------------------------------------------------------ formatting

  function isFiniteNumber(value) { return typeof value === 'number' && isFinite(value); }

  function dash(value) {
    return value === null || value === undefined || value === '' ? '--' : String(value);
  }

  function fmtInt(value, suffix) {
    if (!isFiniteNumber(value)) return '--';
    return Math.round(value).toLocaleString() + (suffix || '');
  }

  function fmtDuration(seconds) {
    if (!isFiniteNumber(seconds) || seconds <= 0) return '--';
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? h + ' h ' + pad2(m) + ' min' : m + ' min';
  }

  function pad2(value) { return value < 10 ? '0' + value : String(value); }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function fmtEpoch(epochSeconds) {
    if (!isFiniteNumber(epochSeconds) || epochSeconds <= 0) return '--';
    var date = new Date(epochSeconds * 1000);
    if (isNaN(date.getTime())) return '--';
    if (prefs.timeZone === 'local') {
      return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ' local | ' + date.getDate() + ' ' + MONTHS[date.getMonth()];
    }
    return pad2(date.getUTCHours()) + ':' + pad2(date.getUTCMinutes()) + 'Z | ' + date.getUTCDate() + ' ' + MONTHS[date.getUTCMonth()];
  }

  function fmtClock(iso, suffix) {
    if (typeof iso !== 'string' || iso.length < 16) return '--';
    return iso.slice(11, 16) + suffix;
  }

  function planUnit() {
    return state.plan && state.plan.weightUnit === 'kg' ? 'kg' : 'lbs';
  }

  function displayUnit() {
    return prefs.weightUnit === 'plan' ? planUnit() : prefs.weightUnit;
  }

  function fmtWeight(value) {
    if (!isFiniteNumber(value)) return '--';
    var from = planUnit();
    var to = displayUnit();
    var converted = value;
    if (from === 'kg' && to === 'lbs') converted = value * 2.20462262;
    if (from === 'lbs' && to === 'kg') converted = value / 2.20462262;
    return Math.round(converted).toLocaleString() + ' ' + to;
  }

  function fmtFetchedAt(ms) {
    if (!isFiniteNumber(ms)) return '';
    var date = new Date(ms);
    if (isNaN(date.getTime())) return '';
    return 'Fetched ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  function humanize(value) {
    var words = String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_.]+/g, ' ').trim().split(/\s+/);
    if (!words.length || !words[0]) return 'Other';
    var label = words.join(' ').toLowerCase();
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  function phaseLabel(phase) {
    return phase ? humanize(String(phase).toLowerCase()) : 'Unknown';
  }

  // ------------------------------------------------------------------ prefs

  function loadPrefs() {
    var merged = mergePrefs(DEFAULT_PREFS, null);
    try {
      var raw = window.localStorage ? window.localStorage.getItem(PREFS_KEY) : null;
      if (raw) merged = mergePrefs(DEFAULT_PREFS, JSON.parse(raw));
    } catch (error) { /* storage unavailable in this browser; defaults apply */ }
    return merged;
  }

  function mergePrefs(defaults, saved) {
    var source = saved && typeof saved === 'object' ? saved : {};
    var pick = function (key, allowed) {
      return allowed.indexOf(source[key]) >= 0 ? source[key] : defaults[key];
    };
    // Legacy tab-visibility preferences are ignored: all three sections remain available.
    var openSections = {};
    if (source.openSections && typeof source.openSections === 'object') {
      Object.keys(source.openSections).slice(0, 64).forEach(function (key) {
        if (/^[a-z0-9-]{1,40}$/i.test(key)) openSections[key] = source.openSections[key] === true;
      });
    }
    return {
      theme: pick('theme', ['dark', 'light']),
      scale: pick('scale', ['s', 'm', 'l']),
      density: pick('density', ['comfortable', 'compact']),
      timeZone: pick('timeZone', ['utc', 'local']),
      weightUnit: pick('weightUnit', ['plan', 'kg', 'lbs']),
      defaultTab: pick('defaultTab', ['flight', 'plan', 'voice']),
      openSections: openSections,
    };
  }

  function savePrefs() {
    try {
      if (window.localStorage) window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (error) { /* storage unavailable; the session still works */ }
  }

  function applyPrefs() {
    var root = document.documentElement;
    root.setAttribute('data-theme', prefs.theme);
    root.setAttribute('data-scale', prefs.scale);
    root.setAttribute('data-density', prefs.density);
  }

  // ------------------------------------------------------------------ parent frame

  function postToParent(message) {
    if (!window.parent || window.parent === window) return;
    try {
      window.parent.postMessage(Object.assign({ source: PAGE_SOURCE }, message), '*');
    } catch (error) { /* no parent frame */ }
  }

  function onParentMessage(event) {
    if (!window.parent || window.parent === window || event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== 'object' || data.source !== LOADER_SOURCE) return;
    if (data.action === 'visibility') setVisible(data.visible === true);
  }

  function setVisible(visible) {
    if (unloading) return;
    if (state.visible === visible) return;
    state.visible = visible;
    if (hiddenTimer !== null) { clearTimeout(hiddenTimer); hiddenTimer = null; }
    if (visible) {
      if (reloadPending) { requestPageReload(); return; }
      if (state.connection === 'paused' || (!socket && !bootstrapRequest)) {
        state.connection = 'connecting';
        connect();
      }
      renderAll();
      return;
    }
    cancelReconnect();
    cancelBootstrap();
    cancelVoiceReference();
    cancelPageReload();
    // A hidden panel keeps no live socket open; it reconnects when shown.
    hiddenTimer = setTimeout(function () {
      hiddenTimer = null;
      if (state.visible) return;
      cancelReconnect();
      closeSocket();
      state.connection = 'paused';
      renderConnection();
    }, HIDDEN_DISCONNECT_MS);
  }

  // ------------------------------------------------------------------ connection

  function cancelPageReload() {
    if (reloadTimer !== null) { clearTimeout(reloadTimer); reloadTimer = null; }
  }

  function requestPageReload() {
    reloadPending = true;
    if (unloading || !state.visible || reloadTimer !== null) return;
    postToParent({ action: 'reload' });
    // Fallback for a standalone page or a loader that did not handle the request.
    reloadTimer = setTimeout(function () {
      reloadTimer = null;
      if (!unloading && state.visible) window.location.reload();
    }, 500);
  }

  function queryParam(name) {
    try {
      var match = new RegExp('[?&]' + name + '=([^&#]*)').exec(window.location.search);
      return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : '';
    } catch (error) {
      return '';
    }
  }

  function bootstrap() {
    var request = new XMLHttpRequest();
    bootstrapRequest = request;
    request.open('GET', '/api/toolbar/bootstrap?t=' + Date.now(), true);
    request.timeout = 5000;
    request.onload = function () {
      if (bootstrapRequest !== request || unloading || !state.visible) return;
      bootstrapRequest = null;
      var payload = null;
      try { payload = JSON.parse(request.responseText); } catch (error) { payload = null; }
      if (request.status !== 200 || !payload || payload.ok !== true || !isFiniteNumber(payload.wsPort)) {
        scheduleReconnect();
        return;
      }
      var version = typeof payload.appVersion === 'string' ? payload.appVersion : '';
      if (state.appVersion && version && version !== state.appVersion) {
        // FlightFabric was updated underneath us: ask the loader for a fresh page.
        requestPageReload();
        return;
      }
      state.appVersion = version;
      state.wsPort = payload.wsPort;
      renderSettingsVersion();
      renderNotice();
      openSocket();
    };
    request.onerror = request.ontimeout = function () {
      if (bootstrapRequest !== request) return;
      bootstrapRequest = null;
      scheduleReconnect();
    };
    request.send();
  }

  function cancelBootstrap() {
    if (!bootstrapRequest) return;
    var request = bootstrapRequest;
    bootstrapRequest = null;
    request.onload = request.onerror = request.ontimeout = null;
    try { request.abort(); } catch (error) { /* already completed */ }
  }

  function connect() {
    if (unloading || !state.visible) return;
    cancelReconnect();
    cancelBootstrap();
    closeSocket();
    bootstrap();
  }

  function openSocket() {
    if (unloading || !state.visible) return;
    closeSocket();
    var url = 'ws://' + LOOPBACK_HOST + ':' + state.wsPort + '/?subscribe=' + encodeURIComponent(SUBSCRIPTION.join(','));
    var ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      scheduleReconnect();
      return;
    }
    socket = ws;
    socketConnectTimer = setTimeout(function () {
      socketConnectTimer = null;
      if (ws !== socket) return;
      closeSocket();
      scheduleReconnect();
    }, SOCKET_CONNECT_TIMEOUT_MS);
    ws.onopen = function () {
      if (ws !== socket) return;
      clearSocketConnectTimer();
      reconnectDelay = RECONNECT_MIN_MS;
      state.connection = 'connected';
      renderConnection();
      ws.send(JSON.stringify({ type: 'requestState' }));
    };
    ws.onmessage = function (event) {
      if (ws !== socket) return;
      var message = null;
      try { message = JSON.parse(event.data); } catch (error) { message = null; }
      if (message && typeof message === 'object' && typeof message.type === 'string') handleMessage(message);
    };
    ws.onclose = function () {
      if (ws !== socket) return;
      clearSocketConnectTimer();
      socket = null;
      if (state.connection !== 'paused') {
        state.connection = 'waiting';
        renderConnection();
        scheduleReconnect();
      }
    };
    ws.onerror = function () { /* onclose follows and schedules the retry */ };
  }

  function closeSocket() {
    clearSocketConnectTimer();
    if (!socket) return;
    var ws = socket;
    socket = null;
    try { ws.onopen = null; ws.onclose = null; ws.onmessage = null; ws.onerror = null; ws.close(); } catch (error) { /* already closed */ }
  }

  function clearSocketConnectTimer() {
    if (socketConnectTimer !== null) { clearTimeout(socketConnectTimer); socketConnectTimer = null; }
  }

  function scheduleReconnect() {
    if (unloading || !state.visible) return;
    cancelReconnect();
    if (state.connection === 'connected' || state.connection === 'connecting') {
      state.connection = 'waiting';
      renderConnection();
    }
    var delay = reconnectDelay;
    reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 2);
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function cancelReconnect() {
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  // ------------------------------------------------------------------ messages

  function handleMessage(message) {
    switch (message.type) {
      case 'authorizationScope':
        state.scope = typeof message.scope === 'string' ? message.scope : '';
        return;
      case 'simState':
        state.simState = message;
        renderConnection();
        renderFlight();
        return;
      case 'phase':
        state.phase = typeof message.value === 'string' ? message.value : '';
        renderFlight();
        return;
      case 'flightTime': {
        var nextFlightId = flightIdentity(message);
        var flightChanged = nextFlightId && nextFlightId !== historyFlightId;
        if (flightChanged) { clearFlightHistory(Boolean(historyFlightId)); historyFlightId = nextFlightId; }
        state.flightTime = message;
        if (flightChanged) renderFlight(); else renderFlightTime();
        return;
      }
      case 'simTime':
        state.simTime = message;
        renderFlightTime();
        return;
      case 'aircraftProfile': {
        var previousAircraft = aircraftIdentity(state.aircraftProfile);
        var nextAircraft = aircraftIdentity(message);
        // A hidden panel closes its socket and can miss aircraftChanged.
        // Reconcile the replayed identity before showing any flight history.
        if (previousAircraft && !sameAircraft(previousAircraft, nextAircraft)) clearFlightHistory(true);
        state.aircraftProfile = message;
        if (pendingLanding) {
          if (sameAircraft(pendingLanding.aircraft, nextAircraft)) state.landing = pendingLanding.landing;
          else rememberLanding(null);
          pendingLanding = null;
        }
        state.commands = extractCommands(message);
        renderFlight();
        renderVoice();
        renderTabs();
        return;
      }
      case 'dataSources': {
        var profile = state.aircraftProfile && state.aircraftProfile.profile;
        var revision = Number(message.profileRevision);
        if (!profile || !message.controlCapabilities || typeof message.profileKey !== 'string'
          || !message.profileKey.trim() || message.profileKey.trim() !== profileKey()
          || !Number.isSafeInteger(revision) || revision < 0 || revision !== Number(profile.profileRevision)) return;
        state.aircraftProfile = Object.assign({}, state.aircraftProfile, { controlCapabilities: message.controlCapabilities });
        state.commands = extractCommands(state.aircraftProfile);
        renderVoice();
        renderTabs();
        return;
      }
      case 'aircraftChanged':
        clearFlightHistory(true);
        renderFlight();
        return;
      case 'toolbarFlightHistory': {
        // A replacement snapshot, not live landing/caution events. Empty
        // snapshots also clear results left in localStorage by an older run.
        clearFlightHistory(true);
        var currentFlightId = flightIdentity(state.flightTime);
        if (sameAircraft(message.aircraft, aircraftIdentity(state.aircraftProfile))
          && (!currentFlightId || currentFlightId === message.flightId)) {
          historyFlightId = typeof message.flightId === 'string' ? message.flightId : '';
          state.landing = message.landing && typeof message.landing === 'object' ? message.landing : null;
          awaitingTouchdown = !state.landing;
          state.cautions = Array.isArray(message.cautions) ? message.cautions.slice(0, MAX_CAUTIONS).filter(function (caution) {
            return caution && typeof caution.label === 'string' && isFiniteNumber(caution.at);
          }) : [];
          rememberLanding(state.landing);
        }
        renderFlight();
        return;
      }
      case 'landing':
        if (message.final === true && awaitingTouchdown) return;
        awaitingTouchdown = false;
        pendingLanding = null;
        state.landing = message;
        rememberLanding(message);
        renderFlight();
        return;
      case 'ultimateStabilityScore':
        if (state.landing) {
          state.landing.ultimateStability = Object.assign({}, state.landing.ultimateStability || {}, {
            score: isFiniteNumber(message.score) ? message.score : null,
            verdict: typeof message.verdict === 'string' ? message.verdict : 'no_verdict',
          });
          rememberLanding(state.landing);
          renderFlight();
        }
        return;
      case 'flightRecording':
        state.recording = message;
        renderFlight();
        return;
      case 'flightStatus':
        state.flightStatus = message;
        renderFlight();
        return;
      case 'flightViolation':
        if (message.event === 'start' && typeof message.label === 'string') {
          state.cautions.unshift({
            label: message.label,
            severity: message.severity === 'critical' ? 'critical' : 'warning',
            at: isFiniteNumber(message.timestamp_ms) ? message.timestamp_ms : Date.now(),
          });
          state.cautions = state.cautions.slice(0, MAX_CAUTIONS);
          renderFlight();
        }
        return;
      case 'flightPlan':
        state.plan = message.cleared === true ? null : message;
        renderPlan();
        renderTabs();
        return;
      case 'voiceStatus':
        state.voice = message;
        renderVoiceStatus();
        return;
      case 'fuelUnit':
        state.fuelUnit = typeof message.unit === 'string' ? message.unit : '';
        return;
      case 'updateAvailable':
        state.updateAvailable = message;
        renderNotice();
        return;
      default:
        return;
    }
  }

  function extractCommands(message) {
    var capabilities = message && message.controlCapabilities;
    var catalogue = capabilities && capabilities.aircraftCommands;
    var list = catalogue && Array.isArray(catalogue.commands) ? catalogue.commands : [];
    var out = [];
    list.forEach(function (command) {
      if (!command || typeof command.id !== 'string') return;
      var patterns = command.speech && Array.isArray(command.speech.patterns)
        ? command.speech.patterns.filter(function (pattern) { return typeof pattern === 'string' && pattern.trim(); })
        : [];
      if (!patterns.length) return;
      out.push({
        id: command.id,
        label: typeof command.label === 'string' && command.label ? command.label : humanize(command.id.split('.').slice(1).join(' ')),
        group: typeof command.group === 'string' && command.group ? command.group : command.id.split('.')[0],
        kind: command.kind === 'preset' ? 'preset' : 'action',
        description: typeof command.description === 'string' ? command.description : '',
        input: command.input && typeof command.input === 'object' ? command.input : { kind: 'none' },
        patterns: patterns.map(function (pattern) { return pattern.trim().slice(0, 160); }).slice(0, 12),
      });
    });
    return out;
  }

  function profileKey(message) {
    var source = message || state.aircraftProfile;
    var profile = source && source.profile;
    if (profile && typeof profile._profileKey === 'string' && profile._profileKey.trim()) return profile._profileKey.trim();
    if (profile && typeof profile._qualifiedId === 'string' && profile._qualifiedId.trim()) return profile._qualifiedId.trim();
    if (profile && profile.namespace && profile.simulator && profile.id) return profile.namespace + '/' + profile.simulator + '/' + profile.id;
    var capabilities = source && source.controlCapabilities;
    var catalogue = capabilities && capabilities.aircraftCommands;
    return catalogue && typeof catalogue.profileKey === 'string' ? catalogue.profileKey : '';
  }

  function aircraftIdentity(message) {
    if (!message) return null;
    var profile = message.profile;
    var key = profileKey(message);
    // Different aircraft can share a profile, especially the generic one.
    // Revisions also change on same-aircraft refreshes, so use the title.
    var title = profile && typeof profile.aircraftTitle === 'string' ? profile.aircraftTitle.trim() : '';
    return key || title ? { profileKey: key, title: title } : null;
  }

  function sameAircraft(left, right) {
    return Boolean(left && right && left.profileKey === right.profileKey && left.title === right.title);
  }

  function clearFlightHistory(invalidateLanding) {
    pendingLanding = null;
    historyFlightId = '';
    if (invalidateLanding) awaitingTouchdown = true;
    state.landing = null;
    state.cautions = [];
    rememberLanding(null);
  }

  function flightIdentity(message) {
    if (!message || message.active === false) return '';
    var value = message.startedAt || message.flightId;
    return typeof value === 'string' ? value : '';
  }

  function aircraftTitle() {
    var profile = state.aircraftProfile && state.aircraftProfile.profile;
    if (!profile) return '';
    return typeof profile.aircraftTitle === 'string' && profile.aircraftTitle
      ? profile.aircraftTitle
      : (typeof profile.name === 'string' ? profile.name : '');
  }

  // ------------------------------------------------------------------ voice helpers

  function sampleSpeechValue(command) {
    var input = command.input || {};
    if (input.units === 'squawk') return '0042';
    var id = String(command.id || '').toLowerCase();
    if (id.indexOf('heading') >= 0) return '270';
    if (id.indexOf('altitude') >= 0) return '10,000';
    if (id.indexOf('verticalspeed') >= 0) return '1,000';
    if (id.indexOf('speed') >= 0) return '250';
    if (id.indexOf('mach') >= 0) return '0.78';
    if (input.kind === 'boolean') return 'on';
    if (input.kind === 'enum') return String(Array.isArray(input.values) && input.values.length ? input.values[0] : 'on');
    if (input.kind === 'number') return String(isFiniteNumber(input.min) ? input.min : 1);
    return '';
  }

  // Acronyms the catalogue spells in lower case for the recognizer; show them
  // the way a pilot writes them.
  var SPOKEN_ACRONYMS = /\b(apu|mcp|ils|vor|qnh|std|efis|fpa|trk|hdg|rto|pfd|tcas|atc|adf|dme|irs|rmp|fmc|fms|mfd|vhf|ecam|eicas|fcu|nd)\b/gi;

  function spokenCase(phrase) {
    var text = phrase.charAt(0).toUpperCase() + phrase.slice(1);
    return text
      .replace(SPOKEN_ACRONYMS, function (match) { return match.toUpperCase(); })
      .replace(/\bsimbrief\b/gi, 'SimBrief');
  }

  function speechExample(command) {
    var pattern = command.patterns[0];
    if (!pattern) return '';
    var phrase = pattern.split('{value}').join(sampleSpeechValue(command)).trim();
    return phrase ? spokenCase(phrase) : '';
  }

  function isNumberTarget(command, units, fragment) {
    return command.input && command.input.kind === 'number' && command.input.units === units
      && String(command.id).toLowerCase().indexOf(fragment) >= 0;
  }

  function voiceExamples(commands) {
    var ordered = commands.slice();
    var altitudeIndex = -1;
    for (var i = 0; i < ordered.length; i += 1) {
      if (isNumberTarget(ordered[i], 'feet', 'altitude')) { altitudeIndex = i; break; }
    }
    if (altitudeIndex > 0) ordered.unshift(ordered.splice(altitudeIndex, 1)[0]);
    return ordered.map(speechExample).filter(Boolean).slice(0, 3);
  }

  function inputHint(input, id) {
    if (!input || input.kind === 'none' || (!input.kind && !input.type)) return '';
    if (input.units === 'squawk') return 'four digits 0-7';
    if (input.kind === 'boolean') {
      if (id === 'surfaces.parkingBrake.set') return 'set / release';
      if (id === 'surfaces.spoilersArmed.set') return 'arm / disarm';
      return 'on / off';
    }
    if (input.kind === 'enum') {
      var values = Array.isArray(input.values) ? input.values.slice(0, 12) : [];
      return values.length ? values.join(' / ') : '';
    }
    if (input.kind === 'number' || input.type === 'number') {
      var min = Number(input.min);
      var max = Number(input.max);
      if (!isFinite(min) || !isFinite(max)) return 'number';
      var units = UNIT_LABELS[input.units] || String(input.units || '').replace(/-/g, ' ');
      return min.toLocaleString() + '-' + max.toLocaleString() + (units ? ' ' + units : '');
    }
    return '';
  }

  function phraseNode(pattern, className) {
    var node = el('span', className || 'phrase-text');
    var parts = pattern.split('{value}');
    parts.forEach(function (part, index) {
      if (index > 0) node.appendChild(el('span', 'slot', '<value>'));
      if (part) node.appendChild(document.createTextNode(part));
    });
    return node;
  }

  // ------------------------------------------------------------------ rendering: chrome

  function renderConnection() {
    if (!state.visible) return;
    var pill = $('connection-pill');
    var text = 'Connecting';
    var tone = 'pill-muted';
    if (state.connection === 'paused') {
      text = 'Paused';
    } else if (state.connection === 'waiting') {
      text = 'Waiting for FlightFabric';
      tone = 'pill-warn';
    } else if (state.connection === 'connected') {
      var sim = state.simState;
      if (sim && sim.simconnectConnected === false) {
        text = 'Simulator link down';
        tone = 'pill-warn';
      } else if (sim && sim.inMenu === true) {
        text = 'In menu';
        tone = 'pill-accent';
      } else {
        text = 'Connected';
        tone = 'pill-good';
      }
    }
    pill.textContent = text;
    pill.className = 'pill ' + tone;
  }

  function renderNotice() {
    if (!state.visible) return;
    var notice = $('notice');
    var messages = [];
    if (state.packageVersion && state.appVersion && state.packageVersion !== state.appVersion) {
      messages.push({ tone: '', text: 'Toolbar package ' + state.packageVersion + ' does not match FlightFabric ' + state.appVersion + '. Update it from FlightFabric Settings > MSFS toolbar panel.' });
    }
    if (state.updateAvailable && typeof state.updateAvailable.latestVersion === 'string') {
      messages.push({ tone: 'notice-accent', text: 'FlightFabric ' + state.updateAvailable.latestVersion + ' is available.' });
    }
    if (!messages.length) {
      notice.className = 'notice hidden';
      notice.textContent = '';
      return;
    }
    notice.className = 'notice ' + messages[0].tone;
    notice.textContent = messages[0].text;
  }

  function renderTabs() {
    if (!state.visible) return;
    var nav = clear($('tabs'));
    var tabs = TABS;
    if (tabs.length && !tabs.some(function (tab) { return tab.id === state.activeTab; })) {
      state.activeTab = tabs[0].id;
    }
    tabs.forEach(function (tab) {
      var button = el('button', 'tab-button' + (tab.id === state.activeTab ? ' active' : ''));
      button.type = 'button';
      button.id = 'tab-button-' + tab.id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', tab.id === state.activeTab ? 'true' : 'false');
      button.setAttribute('aria-controls', 'tab-' + tab.id);
      button.tabIndex = tab.id === state.activeTab ? 0 : -1;
      button.appendChild(svgIcon(tab.icon));
      button.appendChild(el('span', '', tab.label));
      var badge = tabBadge(tab.id);
      if (badge) button.appendChild(el('span', 'tab-badge', badge));
      button.addEventListener('click', function () { selectTab(tab.id); });
      button.addEventListener('keydown', function (event) {
        var index = tabs.indexOf(tab);
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          var next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
          selectTab(next.id);
          var nextButton = $('tab-button-' + next.id);
          if (nextButton) nextButton.focus();
        }
      });
      nav.appendChild(button);
    });
    TABS.forEach(function (tab) {
      var panel = $('tab-' + tab.id);
      panel.hidden = tab.id !== state.activeTab;
    });
  }

  function tabBadge(tabId) {
    if (tabId === 'plan' && state.plan && state.plan.origin && state.plan.destination) return state.plan.origin + '-' + state.plan.destination;
    if (tabId === 'voice' && state.commands.length) return String(state.commands.length);
    return '';
  }

  function selectTab(tabId) {
    if (state.activeTab === tabId) return;
    state.activeTab = tabId;
    renderTabs();
    renderActiveTab();
    $('content').scrollTop = 0;
  }

  // ------------------------------------------------------------------ rendering: flight

  function renderFlight() {
    if (!state.visible || state.activeTab !== 'flight') return;
    var panel = clear($('tab-flight'));

    var status = card('Flight', state.flightStatus && typeof state.flightStatus.status === 'string' ? humanize(state.flightStatus.status) : '');
    var list = el('div', 'kv-list');
    var title = aircraftTitle();
    list.appendChild(kv('Aircraft', title || 'Waiting for aircraft', profileName(), true));
    list.appendChild(kv('Phase', phaseLabel(state.phase)));
    list.appendChild(recordingKv());
    var timeBox = kv('Flight time', '--');
    timeBox.id = 'flight-time-box';
    list.appendChild(timeBox);
    var clockBox = kv('Sim clock', '--');
    clockBox.id = 'sim-clock-box';
    list.appendChild(clockBox);
    status.appendChild(list);
    panel.appendChild(status);
    renderFlightTime();

    panel.appendChild(renderLandingCard());

    if (state.cautions.length) {
      var cautions = card('Recent cautions', 'newest first');
      state.cautions.forEach(function (caution) {
        var row = el('div', 'caution');
        row.appendChild(el('span', 'caution-label ' + (caution.severity === 'critical' ? 'danger' : 'warn'), caution.label));
        var date = new Date(caution.at);
        row.appendChild(el('span', 'caution-time', isNaN(date.getTime()) ? '' : pad2(date.getUTCHours()) + ':' + pad2(date.getUTCMinutes()) + 'Z'));
        cautions.appendChild(row);
      });
      panel.appendChild(cautions);
    }

    if (state.connection !== 'connected') {
      panel.appendChild(emptyState(
        state.connection === 'paused' ? 'Panel paused' : 'Waiting for FlightFabric',
        state.connection === 'paused'
          ? 'Live data resumes when the panel is open.'
          : 'Start FlightFabric on this PC. The panel reconnects on its own.',
      ));
    }
  }

  function profileName() {
    var profile = state.aircraftProfile && state.aircraftProfile.profile;
    if (!profile || typeof profile.name !== 'string' || !profile.name) return '';
    return profile.name === aircraftTitle() ? 'FlightFabric profile' : 'Profile: ' + profile.name;
  }

  function recordingKv() {
    var recording = state.recording;
    var status = recording && typeof recording.status === 'string' ? recording.status : 'stopped';
    var labels = { recording: 'Recording', finalizing: 'Finalizing', stopped: 'Not recording', failed: 'Failed', error: 'Error' };
    var box = kv('Recording', labels[status] || humanize(status));
    var value = box.querySelector('.kv-value');
    if (status === 'recording') value.className += ' good';
    if (status === 'failed' || status === 'error') value.className += ' danger';
    return box;
  }

  function renderFlightTime() {
    if (!state.visible || state.activeTab !== 'flight') return;
    var timeBox = $('flight-time-box');
    var clockBox = $('sim-clock-box');
    if (timeBox) {
      var time = state.flightTime;
      timeBox.querySelector('.kv-value').textContent = time && typeof time.elapsedHms === 'string' ? time.elapsedHms : '--';
    }
    if (clockBox) {
      var clock = state.simTime;
      var value = clockBox.querySelector('.kv-value');
      if (!clock || clock.valid === false) value.textContent = '--';
      else value.textContent = prefs.timeZone === 'local' ? fmtClock(clock.localIso, ' local') : fmtClock(clock.zuluIso, 'Z');
    }
  }

  function renderLandingCard() {
    var landing = state.landing;
    if (!landing) {
      var placeholder = card('Last landing');
      placeholder.appendChild(el('div', 'muted', 'Your touchdown grade, rate and approach stability appear here after you land.'));
      return placeholder;
    }
    // This is the live WebSocket packet, not the event-bus/CSV schema.
    var distance = landing.touchdownDistance || {};
    var stability = landing.ultimateStability || {};
    var node = card('Last landing', landing.final === true ? 'final' : 'provisional');
    var grade = el('div', 'landing-grade');
    var gradeValue = el('div', 'landing-grade-value ' + gradeTone(landing.grade), dash(landing.grade));
    grade.appendChild(gradeValue);
    var where = [];
    if (landing.icao) where.push(String(landing.icao));
    if (landing.runway) where.push('RWY ' + landing.runway);
    if (landing.approachType) where.push(String(landing.approachType));
    grade.appendChild(el('div', 'landing-grade-tag', where.join(' | ')));
    node.appendChild(grade);

    var stats = el('div', 'stat-row');
    stats.appendChild(stat(fmtInt(landing.vs, ''), 'fpm'));
    stats.appendChild(stat(isFiniteNumber(landing.gforce) ? landing.gforce.toFixed(2) + ' g' : '--', 'G force'));
    stats.appendChild(stat(isFiniteNumber(stability.score) ? Math.round(stability.score) + '%' : '--', 'Stability'));
    stats.appendChild(stat(fmtInt(landing.crosswind, ' kt'), 'Crosswind'));
    stats.appendChild(stat(fmtInt(distance.distanceFt, ' ft'), distance.zone ? String(distance.zone) : 'Touchdown'));
    stats.appendChild(stat(isFiniteNumber(distance.bounceCount) ? String(distance.bounceCount) : '--', 'Bounces'));
    node.appendChild(stats);

    var notes = [];
    if (landing.shortLanding === true || distance.shortLanding === true) node.appendChild(el('div', 'kv-sub danger', 'Short landing'));
    if (landing.runwayExcursion === true) node.appendChild(el('div', 'kv-sub danger', 'Runway excursion'));
    if (isFiniteNumber(distance.lateralOffsetFt) && Math.abs(distance.lateralOffsetFt) >= 1) {
      notes.push('Centerline ' + Math.round(Math.abs(distance.lateralOffsetFt)) + ' ft ' + (distance.lateralOffsetSide ? String(distance.lateralOffsetSide) : ''));
    }
    if (typeof stability.verdict === 'string' && stability.verdict !== 'no_verdict') {
      notes.push('Approach ' + humanize(stability.verdict).toLowerCase());
    }
    if (notes.length) node.appendChild(el('div', 'kv-sub', notes.join(' | ')));
    return node;
  }

  function stat(value, label) {
    var node = el('div', 'stat');
    node.appendChild(el('div', 'stat-value', value));
    node.appendChild(el('div', 'stat-label', label));
    return node;
  }

  function gradeTone(grade) {
    var value = String(grade || '').toUpperCase();
    if (value === 'PERFECT' || value === 'GOOD') return 'good';
    if (value === 'FIRM') return 'warn';
    if (value === 'HARD' || value === 'VERY HARD') return 'danger';
    return '';
  }

  // ------------------------------------------------------------------ rendering: plan

  function renderPlan() {
    if (!state.visible || state.activeTab !== 'plan') return;
    var panel = clear($('tab-plan'));
    var plan = state.plan;
    if (!plan) {
      panel.appendChild(emptyState(
        'No SimBrief plan loaded',
        'Fetch your latest OFP on the FlightFabric SimBrief tab. It appears here automatically.',
      ));
      return;
    }

    var hero = card('Active OFP', fmtFetchedAt(plan.fetchedAt));
    var route = el('div', 'route-hero');
    // Coherent's font fallback can render Unicode arrows as missing-glyph boxes.
    var arrowPath = 'M4 12h16M14 6l6 6-6 6';
    var codes = el('div', 'route-codes');
    codes.appendChild(el('span', '', dash(plan.origin)));
    codes.appendChild(svgIcon(arrowPath, 'route-arrow'));
    codes.appendChild(el('span', '', dash(plan.destination)));
    route.appendChild(codes);
    var names = [plan.originName, plan.destinationName].filter(Boolean);
    if (names.length) {
      var namesNode = el('div', 'route-names');
      names.forEach(function (name, index) {
        if (index) {
          namesNode.appendChild(document.createTextNode(' '));
          namesNode.appendChild(svgIcon(arrowPath, 'route-name-arrow'));
          namesNode.appendChild(document.createTextNode(' '));
        }
        namesNode.appendChild(document.createTextNode(name));
      });
      route.appendChild(namesNode);
    }
    var chips = el('div', 'chips');
    if (plan.cruiseAltFl) chips.appendChild(chip('INITIAL CRUISE', plan.cruiseAltFl));
    chips.appendChild(chip('ALTN', plan.alternate || 'None'));
    if (plan.departureRunway) chips.appendChild(chip('DEP RWY', plan.departureRunway));
    if (plan.arrivalRunway) chips.appendChild(chip('ARR RWY', plan.arrivalRunway));
    var procedures = plan.procedures || {};
    if (procedures.sid) chips.appendChild(chip('SID', procedures.sid + (procedures.sidTransition ? ' / ' + procedures.sidTransition : '')));
    if (procedures.star) chips.appendChild(chip('STAR', procedures.star + (procedures.starTransition ? ' / ' + procedures.starTransition : '')));
    route.appendChild(chips);
    hero.appendChild(route);
    panel.appendChild(hero);

    var keys = card('Key figures');
    var list = el('div', 'kv-list');
    list.appendChild(kv('Callsign', dash(plan.callsign), plan.flightNumber ? 'Flight ' + plan.flightNumber : ''));
    list.appendChild(kv('Aircraft', dash(plan.aircraft), plan.aircraftName || plan.registration || ''));
    list.appendChild(kv('Initial cruise', [plan.cruiseAltFl, plan.cruiseMach ? 'M' + plan.cruiseMach : null].filter(Boolean).join(' / ') || '--'));
    list.appendChild(kv('ETE', fmtDuration(plan.eteSeconds), plan.blockSeconds ? 'Block ' + fmtDuration(plan.blockSeconds) : ''));
    list.appendChild(kv('Fuel (ramp)', fmtWeight(plan.fuelLbs), plan.fuel && isFiniteNumber(plan.fuel.trip) ? 'Trip ' + fmtWeight(plan.fuel.trip) : ''));
    list.appendChild(kv('Landing fuel', fmtWeight(plan.fuel ? plan.fuel.landing : null), plan.fuel && isFiniteNumber(plan.fuel.reserve) ? 'Reserve ' + fmtWeight(plan.fuel.reserve) : ''));
    list.appendChild(kv('Cost index', dash(plan.costIndex)));
    list.appendChild(kv('Est. arrival', fmtEpoch(plan.estimatedIn || plan.scheduledIn), plan.estimatedOff ? 'Off ' + fmtEpoch(plan.estimatedOff) : ''));
    list.appendChild(kv('Payload', fmtWeight(plan.weights ? plan.weights.payload : null), plan.weights && isFiniteNumber(plan.weights.passengers) ? fmtInt(plan.weights.passengers) + ' pax' : ''));
    list.appendChild(kv('Takeoff weight', fmtWeight(plan.weights ? plan.weights.takeoff : null), plan.weights && isFiniteNumber(plan.weights.landing) ? 'Landing ' + fmtWeight(plan.weights.landing) : ''));
    keys.appendChild(list);
    panel.appendChild(keys);

    var routeCard = card('Route', plan.performance && isFiniteNumber(plan.performance.routeDistance) ? fmtInt(plan.performance.routeDistance, ' nm') : '');
    routeCard.appendChild(el('div', 'route-text', dash(plan.route)));
    panel.appendChild(routeCard);

    var details = card('Details');
    var weather = plan.weather || {};
    if (Object.keys(weather).some(function (key) { return weather[key]; })) {
      details.appendChild(section('weather', 'Planning weather', 'OFP snapshot, not live', function (body) {
        body.appendChild(el('div', 'kv-sub', 'Captured when this OFP was generated' + (plan.generatedAt ? ' on ' + fmtEpoch(plan.generatedAt) : '') + '.'));
        [['Origin METAR', weather.originMetar], ['Origin TAF', weather.originTaf], ['Destination METAR', weather.destinationMetar],
          ['Destination TAF', weather.destinationTaf], ['Alternate METAR', weather.alternateMetar], ['Alternate TAF', weather.alternateTaf],
          ['ETOPS METAR', weather.etopsMetar], ['ETOPS TAF', weather.etopsTaf]].forEach(function (item) {
          if (!item[1]) return;
          var report = el('div', 'report');
          report.appendChild(el('div', 'report-label', item[0]));
          report.appendChild(el('div', 'report-text', item[1]));
          body.appendChild(report);
        });
      }));
    }

    details.appendChild(section('fuel', 'Fuel and weights', displayUnit(), function (body) {
      var fuel = plan.fuel || {};
      var weights = plan.weights || {};
      body.appendChild(el('div', 'group-title', 'Fuel'));
      body.appendChild(dl([['Taxi', fuel.taxi], ['Trip', fuel.trip], ['Contingency', fuel.contingency], ['Alternate', fuel.alternate],
        ['Final reserve', fuel.reserve], ['Extra', fuel.extra], ['Takeoff', fuel.takeoff], ['Landing', fuel.landing]], fmtWeight,
      [['Endurance', plan.enduranceSeconds, fmtDuration]]));
      body.appendChild(el('div', 'group-title', 'Weights and load'));
      body.appendChild(dl([['Cargo', weights.cargo], ['Payload', weights.payload], ['Zero fuel', weights.zeroFuel], ['Ramp', weights.ramp],
        ['Takeoff', weights.takeoff], ['Landing', weights.landing], ['Max takeoff', weights.maxTakeoff], ['Max landing', weights.maxLanding]], fmtWeight,
      [['Passengers', weights.passengers, function (value) { return fmtInt(value); }]]));
    }));

    details.appendChild(section('times', 'Times and performance', prefs.timeZone === 'local' ? 'local time' : 'UTC', function (body) {
      var performance = plan.performance || {};
      body.appendChild(el('div', 'group-title', 'Times'));
      body.appendChild(dl([['Scheduled out', plan.scheduledOut], ['Scheduled off', plan.scheduledOff], ['Scheduled on', plan.scheduledOn], ['Scheduled in', plan.scheduledIn],
        ['Estimated out', plan.estimatedOut], ['Estimated off', plan.estimatedOff], ['Estimated on', plan.estimatedOn], ['Estimated in', plan.estimatedIn]], fmtEpoch,
      [['Block time', plan.blockSeconds, fmtDuration], ['Taxi out', plan.taxiOutSeconds, fmtDuration], ['Taxi in', plan.taxiInSeconds, fmtDuration]]));
      body.appendChild(el('div', 'group-title', 'Planning'));
      body.appendChild(dl([], null, [
        ['AIRAC', plan.airac, dash], ['Registration', plan.registration, dash],
        ['Route distance', performance.routeDistance, function (value) { return fmtInt(value, ' nm'); }],
        ['Air distance', performance.airDistance, function (value) { return fmtInt(value, ' nm'); }],
        ['Great-circle', performance.greatCircleDistance, function (value) { return fmtInt(value, ' nm'); }],
        ['Cruise TAS', performance.cruiseTas, function (value) { return fmtInt(value, ' kt'); }],
        ['Average wind', isFiniteNumber(performance.averageWindDirection) || isFiniteNumber(performance.averageWindSpeed)
          ? fmtInt(performance.averageWindDirection, ' deg') + ' / ' + fmtInt(performance.averageWindSpeed, ' kt') : null, dash],
        ['Wind component', performance.averageWindComponent, function (value) { return fmtInt(value, ' kt'); }],
        ['Step climbs', performance.stepClimbs, dash],
      ]));
    }));

    if (Array.isArray(plan.navlog) && plan.navlog.length) {
      details.appendChild(section('navlog', 'Navlog', plan.navlog.length + ' waypoints', function (body) {
        var wrap = el('div', 'table-wrap');
        var table = el('table', 'data');
        var head = el('thead');
        var headRow = el('tr');
        ['Fix', 'Alt', 'Wind', 'OAT', 'Leg', 'Time', 'Fuel'].forEach(function (label) { headRow.appendChild(el('th', '', label)); });
        head.appendChild(headRow);
        table.appendChild(head);
        var tbody = el('tbody');
        plan.navlog.forEach(function (fix) {
          var row = el('tr');
          row.appendChild(el('td', '', dash(fix.ident)));
          row.appendChild(el('td', '', fmtInt(fix.altitude)));
          row.appendChild(el('td', '', fmtInt(fix.windDirection, ' deg') + '/' + fmtInt(fix.windSpeed)));
          row.appendChild(el('td', '', fmtInt(fix.temperature, ' deg')));
          row.appendChild(el('td', '', fmtInt(fix.distance)));
          row.appendChild(el('td', '', fmtDuration(fix.legTime)));
          row.appendChild(el('td', '', fmtWeight(fix.fuelRemaining)));
          tbody.appendChild(row);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        body.appendChild(wrap);
      }));
    }

    if (plan.icaoFlightPlan) {
      details.appendChild(section('icao', 'ICAO flight plan', 'filed format', function (body) {
        body.appendChild(el('div', 'report-text', plan.icaoFlightPlan));
      }));
    }
    panel.appendChild(details);
  }

  function chip(label, value) {
    var node = el('span', 'chip', label);
    node.appendChild(el('b', '', value));
    return node;
  }

  function dl(numericItems, format, extraItems) {
    var node = el('dl', 'dl');
    var count = 0;
    numericItems.forEach(function (item) {
      if (!isFiniteNumber(item[1])) return;
      node.appendChild(dlRow(item[0], format(item[1])));
      count += 1;
    });
    (extraItems || []).forEach(function (item) {
      if (item[1] === null || item[1] === undefined || item[1] === '') return;
      node.appendChild(dlRow(item[0], item[2](item[1])));
      count += 1;
    });
    if (!count) node.appendChild(dlRow('No data', '--'));
    return node;
  }

  function dlRow(term, value) {
    var row = el('div');
    row.appendChild(el('dt', '', term));
    row.appendChild(el('dd', '', value));
    return row;
  }

  // ------------------------------------------------------------------ rendering: voice

  function voiceStatusCard() {
    var voice = state.voice;

    var statusCard = card('Voice control', voice && voice.shortcut ? 'push-to-talk ' + voice.shortcut : '');
    var row = el('div', 'voice-status');
    var tone = VOICE_TONES[voice && voice.status ? voice.status : 'unknown'] || VOICE_TONES.unknown;
    row.appendChild(el('div', 'voice-dot ' + tone.dot));
    var text = el('div', 'voice-status-text');
    if (!voice) {
      text.appendChild(el('div', 'voice-status-title', 'Waiting for the FlightFabric desktop app'));
      text.appendChild(el('div', 'voice-status-detail', 'Voice control runs in the desktop app. Its status shows here while the app is open.'));
    } else {
      text.appendChild(el('div', 'voice-status-title', tone.title));
      var detail = voice.statusText || '';
      if (voice.status === 'transcribed' || voice.status === 'sent' || voice.status === 'unmatched' || voice.status === 'failed') {
        if (voice.transcript) detail = '"' + voice.transcript + '"' + (detail ? ' - ' + detail : '');
      }
      if (detail) text.appendChild(el('div', 'voice-status-detail', detail));
      if (voice.joystick) text.appendChild(el('div', 'voice-status-detail faint', 'Joystick: ' + voice.joystick));
    }
    row.appendChild(text);
    statusCard.appendChild(row);
    return statusCard;
  }

  function renderVoiceStatus() {
    if (!state.visible || state.activeTab !== 'voice') return;
    var panel = $('tab-voice');
    if (!panel.firstChild) { renderVoice(); return; }
    // Push-to-talk changes only this card. Keep the catalogue and focused
    // search input in place instead of rebuilding thousands of DOM nodes.
    panel.replaceChild(voiceStatusCard(), panel.firstChild);
  }

  function renderVoice() {
    if (!state.visible || state.activeTab !== 'voice') return;
    loadVoiceReference();
    var panel = clear($('tab-voice'));
    panel.appendChild(voiceStatusCard());

    var commands = state.commands;
    if (!commands.length) {
      panel.appendChild(emptyState(
        aircraftTitle() ? 'No voice commands for this aircraft' : 'Waiting for an aircraft',
        aircraftTitle() ? 'This FlightFabric profile has no voice-enabled commands yet.' : 'Voice commands are listed once FlightFabric detects your aircraft.',
      ));
    } else {
      var examples = voiceExamples(commands);
      if (examples.length) {
        var tryCard = card('Try saying', aircraftTitle());
        var list = el('ul', 'phrase-list');
        examples.forEach(function (phrase) {
          var item = el('li', 'phrase');
          item.appendChild(el('span', 'phrase-quote', '"'));
          item.appendChild(el('span', 'phrase-text', phrase + '"'));
          list.appendChild(item);
        });
        tryCard.appendChild(list);
        panel.appendChild(tryCard);
      }

      var reference = card('Commands', commands.length + ' voice-enabled');
      var search = el('input', 'search');
      search.type = 'search';
      search.placeholder = 'Filter commands';
      search.setAttribute('aria-label', 'Filter voice commands');
      search.value = state.voiceSearch;
      var results = el('div');
      search.addEventListener('input', function () {
        state.voiceSearch = search.value;
        renderCommandList(results, commands);
      });
      reference.appendChild(search);
      reference.appendChild(results);
      renderCommandList(results, commands);
      panel.appendChild(reference);
    }

    panel.appendChild(renderQuestions());
  }

  function renderCommandList(container, commands) {
    clear(container);
    var query = state.voiceSearch.trim().toLowerCase();
    var groups = {};
    var order = [];
    commands.forEach(function (command) {
      if (query) {
        var haystack = (command.label + ' ' + command.patterns.join(' ') + ' ' + command.description + ' ' + (GROUP_LABELS[command.group] || command.group)).toLowerCase();
        if (haystack.indexOf(query) < 0) return;
      }
      var groupId = command.kind === 'preset' ? 'presets' : command.group;
      if (!groups[groupId]) { groups[groupId] = []; order.push(groupId); }
      groups[groupId].push(command);
    });
    if (!order.length) {
      container.appendChild(el('div', 'muted', 'No commands match.'));
      return;
    }
    order.forEach(function (groupId) {
      container.appendChild(el('div', 'group-title', GROUP_LABELS[groupId] || humanize(groupId)));
      groups[groupId].forEach(function (command) {
        var node = el('div', 'command');
        var label = el('div', 'command-label');
        label.appendChild(el('span', '', command.label));
        var hint = inputHint(command.input, command.id);
        if (hint) label.appendChild(el('span', 'command-input', hint));
        node.appendChild(label);
        var phrases = el('div', 'command-phrases');
        command.patterns.slice(0, 4).forEach(function (pattern, index) {
          if (index > 0) phrases.appendChild(document.createTextNode(' | '));
          phrases.appendChild(phraseNode(pattern, ''));
        });
        node.appendChild(phrases);
        container.appendChild(node);
      });
    });
  }

  function renderQuestions() {
    var node = card('Questions you can ask', 'read-only, spoken back');
    var reference = state.voiceReference;
    var key = profileKey();
    var aircraftQuestions = reference && reference.aircraftQueries && key && Array.isArray(reference.aircraftQueries[key])
      ? reference.aircraftQueries[key]
      : [];
    var planQuestions = reference && Array.isArray(reference.flightPlanQueries) ? reference.flightPlanQueries : [];
    if (!reference) {
      node.appendChild(el('div', 'muted', 'Question reference unavailable.'));
      return node;
    }
    if (aircraftQuestions.length) {
      node.appendChild(el('div', 'group-title', 'About the aircraft'));
      node.appendChild(phraseList(aircraftQuestions));
    } else if (key) {
      node.appendChild(el('div', 'kv-sub', 'Aircraft state questions are not available for this profile.'));
    }
    if (planQuestions.length) {
      node.appendChild(el('div', 'group-title', 'About the flight plan'));
      node.appendChild(phraseList(planQuestions));
    }
    return node;
  }

  function phraseList(phrases) {
    var list = el('ul', 'phrase-list');
    phrases.forEach(function (phrase) {
      var item = el('li', 'phrase');
      item.appendChild(el('span', 'phrase-quote', '"'));
      item.appendChild(el('span', 'phrase-text', spokenCase(phrase) + '"'));
      list.appendChild(item);
    });
    return list;
  }

  // ------------------------------------------------------------------ rendering: settings

  function renderSettingsVersion() {
    var node = $('settings-version');
    var parts = [];
    if (state.appVersion) parts.push('FlightFabric ' + state.appVersion);
    if (state.packageVersion) parts.push('package ' + state.packageVersion);
    node.textContent = parts.join(' | ');
  }

  function renderSettings() {
    var body = clear($('settings-body'));
    body.appendChild(segmentedSetting('Theme', 'Dark suits the simulator; light suits a bright desk.', 'theme', [['dark', 'Dark'], ['light', 'Light']]));
    body.appendChild(segmentedSetting('Text size', '', 'scale', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']]));
    body.appendChild(segmentedSetting('Density', '', 'density', [['comfortable', 'Comfortable'], ['compact', 'Compact']]));
    body.appendChild(segmentedSetting('Times', 'Applies to SimBrief times and the sim clock.', 'timeZone', [['utc', 'UTC'], ['local', 'Local']]));
    body.appendChild(segmentedSetting('Weights', 'Plan uses the units your OFP was generated with.', 'weightUnit', [['plan', 'Plan'], ['kg', 'kg'], ['lbs', 'lbs']]));

    body.appendChild(segmentedSetting('Open on', 'The section shown when the panel opens.', 'defaultTab',
      TABS.map(function (tab) { return [tab.id, tab.label]; })));
  }

  function segmentedSetting(label, help, key, options) {
    var setting = el('div', 'setting');
    setting.appendChild(el('div', 'setting-label', label));
    if (help) setting.appendChild(el('div', 'setting-help', help));
    var group = el('div', 'segmented');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    options.forEach(function (option) {
      var button = el('button', 'segment', option[1]);
      button.type = 'button';
      button.setAttribute('aria-pressed', prefs[key] === option[0] ? 'true' : 'false');
      button.addEventListener('click', function () {
        if (prefs[key] === option[0]) return;
        prefs[key] = option[0];
        savePrefs();
        applyPrefs();
        renderSettings();
        renderAll();
      });
      group.appendChild(button);
    });
    setting.appendChild(group);
    return setting;
  }

  function openSettings() {
    state.settingsOpen = true;
    renderSettings();
    $('settings-sheet').classList.remove('hidden');
    $('settings-button').setAttribute('aria-expanded', 'true');
    var first = $('settings-body').querySelector('button, input');
    if (first) first.focus();
  }

  function closeSettings() {
    state.settingsOpen = false;
    $('settings-sheet').classList.add('hidden');
    $('settings-button').setAttribute('aria-expanded', 'false');
    $('settings-button').focus();
  }

  function renderActiveTab() {
    if (state.activeTab === 'flight') renderFlight();
    else if (state.activeTab === 'plan') renderPlan();
    else if (state.activeTab === 'voice') renderVoice();
  }

  function renderAll() {
    renderConnection();
    renderNotice();
    renderTabs();
    renderActiveTab();
    renderSettingsVersion();
  }

  // ------------------------------------------------------------------ voice reference

  function loadVoiceReference() {
    if (unloading || !state.visible || voiceReferenceRequest || state.voiceReference) return;
    var request = new XMLHttpRequest();
    voiceReferenceRequest = request;
    request.open('GET', '/toolbar/voice-reference.json', true);
    request.timeout = 5000;
    request.onload = function () {
      if (voiceReferenceRequest !== request || unloading || !state.visible) return;
      voiceReferenceRequest = null;
      if (request.status !== 200) return;
      try {
        var payload = JSON.parse(request.responseText);
        if (payload && typeof payload === 'object') {
          state.voiceReference = payload;
          renderVoice();
        }
      } catch (error) { /* reference stays unavailable */ }
    };
    request.onerror = request.ontimeout = function () {
      if (voiceReferenceRequest === request) voiceReferenceRequest = null;
    };
    request.send();
  }

  function cancelVoiceReference() {
    if (!voiceReferenceRequest) return;
    var request = voiceReferenceRequest;
    voiceReferenceRequest = null;
    request.onload = request.onerror = request.ontimeout = null;
    try { request.abort(); } catch (error) { /* already completed */ }
  }

  // ------------------------------------------------------------------ boot

  // Local cache bridges page reloads. The backend's authoritative history
  // snapshot replaces it on reconnect, including clearing it for a new run.
  function rememberLanding(landing) {
    try {
      if (!window.localStorage) return;
      var aircraft = aircraftIdentity(state.aircraftProfile);
      if (!landing || !aircraft) window.localStorage.removeItem(LANDING_KEY);
      else window.localStorage.setItem(LANDING_KEY, JSON.stringify({ at: Date.now(), aircraft: aircraft, landing: landing }));
    } catch (error) { /* storage unavailable */ }
  }

  function restoreLanding() {
    try {
      var raw = window.localStorage ? window.localStorage.getItem(LANDING_KEY) : null;
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (!saved || !saved.landing || typeof saved.landing !== 'object'
        || !saved.aircraft || typeof saved.aircraft.profileKey !== 'string' || typeof saved.aircraft.title !== 'string'
        || (!saved.aircraft.profileKey && !saved.aircraft.title)
        || !isFiniteNumber(saved.at) || saved.at > Date.now() || Date.now() - saved.at > LANDING_TTL_MS) {
        rememberLanding(null);
        return;
      }
      var aircraft = aircraftIdentity(state.aircraftProfile);
      if (aircraft) {
        if (sameAircraft(saved.aircraft, aircraft)) state.landing = saved.landing;
        else rememberLanding(null);
      } else {
        // Do not show a cached result until the first aircraft replay proves
        // it belongs to the aircraft that is currently loaded.
        pendingLanding = saved;
      }
    } catch (error) { /* ignore a corrupt entry */ }
  }

  function boot() {
    applyPrefs();
    restoreLanding();
    state.packageVersion = queryParam('packageVersion').slice(0, 24);
    state.activeTab = prefs.defaultTab;

    $('settings-button').addEventListener('click', function () {
      if (state.settingsOpen) closeSettings(); else openSettings();
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-close-settings]'), function (node) {
      node.addEventListener('click', closeSettings);
    });
    $('settings-reset').addEventListener('click', function () {
      prefs = mergePrefs(DEFAULT_PREFS, null);
      savePrefs();
      applyPrefs();
      renderSettings();
      renderAll();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state.settingsOpen) closeSettings();
    });
    window.addEventListener('message', onParentMessage);
    window.addEventListener('beforeunload', function () {
      unloading = true;
      cancelReconnect();
      cancelBootstrap();
      cancelVoiceReference();
      cancelPageReload();
      if (hiddenTimer !== null) clearTimeout(hiddenTimer);
      closeSocket();
    });

    renderAll();
    // The loader needs to know the page loaded even while the backend socket
    // is unavailable. Socket reconnects must not cause iframe navigations.
    postToParent({ action: 'ready' });
    loadVoiceReference();
    connect();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
