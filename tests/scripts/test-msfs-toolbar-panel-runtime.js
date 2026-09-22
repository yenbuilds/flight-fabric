'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

function fakeClock() {
  let now = 0, next = 0;
  const tasks = new Map();
  return {
    setTimeout(fn, delay = 0) { const id = ++next; tasks.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    get pending() { return tasks.size; },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...tasks].sort((a, b) => a[1].at - b[1].at).find(([, task]) => task.at <= end);
        if (!due) break;
        tasks.delete(due[0]); now = due[1].at; due[1].fn();
      }
      now = end;
    },
  };
}

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  fire(name, event = {}) { for (const fn of this.listeners.get(name) || []) fn(event); }
}

class Element extends Target {
  constructor(tag = 'div') {
    super(); this.tag = tag; this.children = []; this.textContent = ''; this.className = '';
    this.classList = {
      add: value => { if (!this.classList.contains(value)) this.className += ' ' + value; },
      remove: value => { this.className = this.className.split(/\s+/).filter(item => item !== value).join(' '); },
      contains: value => this.className.split(/\s+/).includes(value),
    };
  }
  setAttribute(key, value) { this[key] = value; }
  appendChild(node) { this.children.push(node); return node; }
  removeChild(node) { this.children.splice(this.children.indexOf(node), 1); }
  replaceChild(node, previous) { this.children[this.children.indexOf(previous)] = node; return previous; }
  get firstChild() { return this.children[0]; }
  querySelector(selector) {
    for (const child of this.children) {
      if (selector.startsWith('.') ? child.classList.contains(selector.slice(1)) : child.tag === selector) return child;
      const descendant = child.querySelector(selector);
      if (descendant) return descendant;
    }
    return null;
  }
  text() { return [this.textContent, ...this.children.map(child => child.text())].filter(Boolean).join(' | '); }
}

function fakeCoherent() {
  const triggers = [], handlers = new Map();
  return {
    triggers,
    trigger(name, ...args) { triggers.push([name, ...args]); },
    on(name, fn) { handlers.set(name, fn); },
    off(name, fn) { if (handlers.get(name) === fn) handlers.delete(name); },
    fire(name) { handlers.get(name)?.(); },
    get listening() { return [...handlers.keys()]; },
  };
}

function loader({ parsing = false, active = false, visible = active, coherent } = {}) {
  const timer = fakeClock(), document = new Target(), window = new Target(), nodes = new Map(), navigations = [];
  const ui = new Element('ingame-ui'); ui.active = active;
  if (!visible) ui.classList.add('panelInvisible');
  const messages = [];
  const iframe = new Element('iframe'); iframe.contentWindow = { postMessage(message) { messages.push(message); } };
  Object.defineProperty(iframe, 'src', { set(value) { navigations.push(value); } });
  const attachChildren = () => {
    nodes.set('ingame-ui', ui);
    nodes.set('#flightfabric-panel-content', iframe);
    for (const suffix of ['', '-title', '-text', '-detail']) nodes.set('#flightfabric-panel-fallback' + suffix, new Element());
  };
  if (!parsing) attachChildren();
  document.readyState = parsing ? 'loading' : 'complete';
  let Panel;
  window.FLIGHTFABRIC_TOOLBAR_CONFIG = { httpPort: 8101, wsPort: 8100, packageVersion: '0.9.9' };
  window.customElements = { define(_name, constructor) { Panel = constructor; } };
  class TemplateElement {
    constructor() { this.isConnected = true; }
    connectedCallback() {}
    disconnectedCallback() {}
    querySelector(selector) { return nodes.get(selector) || null; }
  }
  let observer;
  class MutationObserver {
    constructor(callback) { this.callback = callback; observer = this; }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.target = null; }
  }
  const mutateClass = (name, enabled) => {
    ui.classList[enabled ? 'add' : 'remove'](name);
    if (observer?.target === ui && observer.options.attributeFilter.includes('class')) observer.callback();
  };
  vm.runInNewContext(read('msfs-toolbar-panel/package/html_ui/InGamePanels/FlightFabric/FlightFabric.js'), {
    TemplateElement, MutationObserver, document, window, checkAutoload() {}, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout,
    Coherent: coherent,
  });
  const panel = new Panel(); panel.connectedCallback();
  return {
    panel, timer, navigations, messages,
    keyboard(focused) {
      window.fire('message', { source: iframe.contentWindow, origin: panel.origin, data: { source: 'flightfabric-toolbar', action: 'keyboard', focused } });
    },
    finishParsing() { attachChildren(); document.readyState = 'complete'; document.fire('DOMContentLoaded'); },
    show() { ui.active = true; mutateClass('panelInvisible', false); ui.fire('panelActive'); },
    hide() { ui.active = false; mutateClass('panelInvisible', true); ui.fire('panelInactive'); },
    setVisible(visible) { mutateClass('panelInvisible', !visible); },
    minimize(minimized) { mutateClass('minimized', minimized); },
    ready() { window.fire('message', { source: iframe.contentWindow, origin: panel.origin, data: { source: 'flightfabric-toolbar', action: 'ready' } }); },
    disconnect() { panel.isConnected = false; panel.disconnectedCallback(); },
  };
}

function page({ storage = new Map(), takeoffScoringEnabled } = {}) {
  const timer = fakeClock(), sockets = [], requests = [], messages = [], nodes = [], reloads = [];
  const element = tag => { const node = new Element(tag); nodes.push(node); return node; };
  const document = Object.assign(new Target(), {
    readyState: 'loading', documentElement: element('html'), createElement: element,
    createElementNS: (_ns, tag) => element(tag),
    createTextNode: text => Object.assign(element('#text'), { textContent: text }),
    getElementById: id => nodes.find(node => node.id === id) || Object.assign(element('div'), { id }),
    querySelectorAll: () => [],
  });
  const window = Object.assign(new Target(), {
    parent: { postMessage: message => messages.push(message) }, location: { search: '', reload() { reloads.push(true); } },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  });
  class WebSocket {
    constructor(url) { this.url = url; this.closed = false; sockets.push(this); }
    send() {}
    close() { this.closed = true; }
  }
  class XMLHttpRequest {
    constructor() { requests.push(this); }
    open(_method, url) { this.url = url; }
    send() {}
    abort() { this.aborted = true; }
    succeed() { this.status = 200; this.responseText = JSON.stringify({ ok: true, wsPort: 8100, appVersion: '0.9.9' }); this.onload?.(); }
  }
  const context = { document, window, WebSocket, XMLHttpRequest, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout };
  vm.runInNewContext(read('shared/app-settings-shared.js'), context);
  window.FlightFabricAppSettings = takeoffScoringEnabled === undefined
    ? context.FlightFabricAppSettings
    : { ...context.FlightFabricAppSettings, TAKEOFF_SCORING_ENABLED: takeoffScoringEnabled };
  // Expose the shipped functions without replacing their control flow/rendering.
  vm.runInNewContext(read('frontend/toolbar/toolbar.js').replace(/\}\)\(\);\s*$/, `
    globalThis.panel = { state: state, boot: boot, connect: connect, setVisible: setVisible, selectTab: selectTab,
      receive: handleMessage, landingCard: renderLandingCard, restoreLanding: restoreLanding,
      takeoffCard: renderTakeoffCard, restoreTakeoff: restoreTakeoff, subscription: SUBSCRIPTION };
  })();`), context);
  return { api: context.panel, timer, sockets, requests, messages, storage, window, document, nodes, reloads };
}

function aircraftProfile(key = 'bundled/msfs/pmdg-737', title = 'PMDG 737-800', revision = 1) {
  return { type: 'aircraftProfile', profile: { _profileKey: key, aircraftTitle: title, profileRevision: revision, name: title } };
}

test('toolbar loader waits for parsed children and starts when the panel opens', () => {
  const runtime = loader({ parsing: true });
  assert.equal(runtime.panel.iframe, null);
  runtime.finishParsing();
  assert.ok(runtime.panel.iframe);
  assert.equal(runtime.navigations.length, 0, 'initially closed panel does no network work');
  runtime.show();
  assert.equal(runtime.navigations.length, 1);
});

test('toolbar scripts parse as ES2017 and the loader is deferred until the document is parsed', () => {
  const { Linter } = require('eslint');
  const parser = new Linter();
  for (const file of ['shared/app-settings-shared.js', 'frontend/toolbar/toolbar.js', 'msfs-toolbar-panel/package/html_ui/InGamePanels/FlightFabric/FlightFabric.js']) {
    const errors = parser.verify(read(file), { parserOptions: { ecmaVersion: 2017, sourceType: 'script' } }).filter(message => message.fatal);
    assert.deepEqual(errors, [], file);
  }
  const html = read('msfs-toolbar-panel/package/html_ui/InGamePanels/FlightFabric/FlightFabric.html');
  assert.match(html, /<script\b[^>]*\bdefer\b[^>]*src="FlightFabric\.js"/);
  assert.match(read('frontend/toolbar/index.html'), /src="\/shared\/app-settings-shared\.js"[\s\S]*src="\/toolbar\/toolbar\.js"/, 'toolbar loads the shared gate before its consumer');
});

test('toolbar voice examples and alternatives use punctuation available in the simulator font', () => {
  const runtime = page();
  const profile = aircraftProfile();
  profile.controlCapabilities = { aircraftCommands: { commands: [
    { id: 'lights.strobe.set', label: 'Strobe lights', group: 'exterior_lights', input: { kind: 'boolean' }, speech: { patterns: ['strobe lights {value}', 'set strobe lights {value}'] } },
    { id: 'lights.position.set', label: 'Position lights', group: 'exterior_lights', input: { kind: 'enum', values: ['off', 'steady', 'strobe'] }, speech: { patterns: ['position lights {value}'] } },
  ] } };
  runtime.api.receive(profile);
  runtime.api.state.voiceReference = { flightPlanQueries: ['what is my destination'], aircraftQueries: {} };
  runtime.api.selectTab('voice');
  const text = runtime.document.getElementById('tab-voice').text();
  assert.ok(text.includes('Strobe lights on"'), text);
  assert.ok(text.includes('off / steady / strobe'), text);
  assert.ok(text.includes('What is my destination"'), text);
  assert.doesNotMatch(text, /[\u00b7\u2013-\u201f\ufffd]/);
  runtime.api.receive({ type: 'voiceStatus', status: 'sent', transcript: 'strobe lights on', statusText: 'Command sent' });
  assert.ok(runtime.document.getElementById('tab-voice').text().includes('"strobe lights on" - Command sent'));
  // These literals previously rendered as boxes in Coherent even though the
  // document was already UTF-8. Dynamic aircraft/airport names stay untouched.
  for (const file of ['frontend/toolbar/toolbar.js', 'frontend/toolbar/index.html']) {
    assert.doesNotMatch(read(file), /[^\x09\x0a\x0d\x20-\x7e]/, `${file}: static UI punctuation stays ASCII`);
  }
});

test('toolbar loader does not initialize after being detached during parsing', () => {
  const runtime = loader({ parsing: true });
  runtime.disconnect(); runtime.finishParsing();
  assert.equal(runtime.panel.iframe, null);
  assert.equal(runtime.timer.pending, 0);
});

test('toolbar loader follows visibility-only and minimize changes from the simulator', () => {
  // MSFS changePanelVisible and ToggleMinimized update classes without
  // dispatching panelActive/panelInactive. The panel can already be active.
  const runtime = loader({ active: true, visible: false });
  runtime.setVisible(true);
  assert.equal(runtime.navigations.length, 1, 'visibility-only opening starts the page');
  runtime.setVisible(false); runtime.timer.advance(60000);
  assert.equal(runtime.navigations.length, 1, 'visibility-only hiding cancels retries');
  runtime.setVisible(true);
  assert.equal(runtime.navigations.length, 2);
  runtime.ready();
  runtime.minimize(true);
  assert.equal(runtime.messages.at(-1).visible, false, 'collapsed content pauses its connection');
  runtime.minimize(false);
  assert.equal(runtime.messages.at(-1).visible, true);
  assert.equal(runtime.navigations.length, 2, 'expanding reuses the ready page');
  runtime.disconnect();
  runtime.setVisible(false); runtime.setVisible(true); runtime.timer.advance(60000);
  assert.equal(runtime.navigations.length, 3, 'detached observer cannot navigate after about:blank');
  assert.equal(runtime.timer.pending, 0);
});

test('toolbar loader pauses offline retries while hidden, resumes once, and resets after detach', () => {
  const runtime = loader({ active: true });
  assert.equal(runtime.navigations.length, 1, 'catches an active event preceding initialization');
  runtime.show();
  assert.equal(runtime.navigations.length, 1, 'duplicate active events do not navigate again');
  runtime.hide(); runtime.timer.advance(60 * 60 * 1000);
  assert.equal(runtime.navigations.length, 1);
  assert.equal(runtime.timer.pending, 0);
  runtime.show(); runtime.timer.advance(10000);
  assert.equal(runtime.navigations.length, 3);
  runtime.ready(); runtime.timer.advance(60000);
  assert.equal(runtime.navigations.length, 3);
  runtime.hide(); runtime.show();
  assert.equal(runtime.navigations.length, 3, 'ready page is reused');
  runtime.disconnect();
  runtime.panel.isConnected = true; runtime.panel.connectedCallback(); runtime.timer.advance(5000);
  assert.equal(runtime.panel.attempts, 2, 'new frame retries even if the previous frame was ready');
});

test('toolbar loader claims the simulator keyboard only for a visible ready page and always releases it', () => {
  const coherent = fakeCoherent();
  const runtime = loader({ active: true, coherent });
  runtime.keyboard(true);
  assert.equal(coherent.triggers.length, 0, 'an unready page cannot take the keyboard');
  runtime.ready();
  runtime.keyboard(true);
  assert.equal(coherent.triggers.length, 1);
  const [name, fieldId, ...rest] = coherent.triggers[0];
  assert.equal(name, 'FOCUS_INPUT_FIELD');
  assert.match(fieldId, /^FLIGHTFABRIC_TOOLBAR_[a-z0-9]+$/);
  assert.deepEqual(rest, ['', '', '', false], 'same argument shape as the shipped Navigraph panel');
  assert.deepEqual(coherent.listening, ['mousePressOutsideView']);
  runtime.keyboard(true);
  assert.equal(coherent.triggers.length, 1, 'repeated focus reports do not re-trigger');
  runtime.keyboard(false);
  assert.deepEqual(coherent.triggers.at(-1), ['UNFOCUS_INPUT_FIELD', fieldId]);
  assert.deepEqual(coherent.listening, [], 'outside-click listener is removed with the focus');

  runtime.keyboard(true);
  const before = runtime.messages.length;
  coherent.fire('mousePressOutsideView');
  assert.deepEqual(coherent.triggers.at(-1), ['UNFOCUS_INPUT_FIELD', fieldId], 'clicking the cockpit returns the keyboard');
  assert.equal(runtime.messages.at(-1).action, 'keyboardReleased', 'the page is told to drop its field focus');
  assert.equal(runtime.messages.length, before + 1);
  coherent.fire('mousePressOutsideView');
  assert.equal(runtime.messages.length, before + 1, 'a stale outside click does nothing');

  runtime.keyboard(true);
  runtime.hide();
  assert.deepEqual(coherent.triggers.at(-1), ['UNFOCUS_INPUT_FIELD', fieldId], 'hiding releases the keyboard');
  runtime.keyboard(true);
  assert.equal(coherent.triggers.at(-1)[0], 'UNFOCUS_INPUT_FIELD', 'a hidden page cannot take the keyboard');
  runtime.show();
  runtime.keyboard(true);
  assert.equal(coherent.triggers.at(-1)[0], 'FOCUS_INPUT_FIELD');
  runtime.ready();
  assert.equal(coherent.triggers.at(-1)[0], 'UNFOCUS_INPUT_FIELD', 'a reloaded page starts without the keyboard');
  runtime.keyboard(true);
  runtime.disconnect();
  assert.equal(coherent.triggers.at(-1)[0], 'UNFOCUS_INPUT_FIELD', 'a detached panel releases the keyboard');
  assert.deepEqual(coherent.listening, []);
  assert.equal(coherent.triggers.filter(([n]) => n === 'FOCUS_INPUT_FIELD').length,
    coherent.triggers.filter(([n]) => n === 'UNFOCUS_INPUT_FIELD').length, 'every claim is balanced by a release');
});

test('toolbar loader tolerates a missing or failing Coherent bridge', () => {
  const runtime = loader({ active: true });
  runtime.ready();
  assert.doesNotThrow(() => { runtime.keyboard(true); runtime.keyboard(false); runtime.hide(); runtime.disconnect(); });
  const failing = { trigger() { throw new Error('bridge down'); } };
  const failingRuntime = loader({ active: true, coherent: failing });
  failingRuntime.ready();
  assert.doesNotThrow(() => { failingRuntime.keyboard(true); failingRuntime.keyboard(false); });
  assert.equal(failingRuntime.messages.at(-1).action, 'visibility', 'no release message without an outside click');
});

test('toolbar page reports text-field focus and drops it when hidden, released or unloading', () => {
  const runtime = page(); runtime.api.boot();
  const keyboard = () => runtime.messages.filter(message => message.action === 'keyboard').map(message => message.focused);
  const search = { tagName: 'INPUT', type: 'search', blurred: 0, blur() { this.blurred += 1; runtime.document.fire('blur', { target: this }); } };
  const button = { tagName: 'BUTTON', type: 'button' };
  runtime.document.fire('focus', { target: button });
  assert.deepEqual(keyboard(), [], 'buttons leave the keyboard with the simulator');
  runtime.document.fire('focus', { target: search });
  assert.deepEqual(keyboard(), [true]);
  runtime.document.fire('blur', { target: search });
  assert.deepEqual(keyboard(), [true, false]);

  runtime.document.fire('focus', { target: search });
  runtime.document.activeElement = search;
  runtime.window.fire('message', { source: runtime.window.parent, data: { source: 'flightfabric-toolbar-loader', action: 'keyboardReleased' } });
  assert.equal(search.blurred, 1, 'an outside click drops the field focus so the next click reclaims the keyboard');
  assert.deepEqual(keyboard(), [true, false, true, false]);

  runtime.document.fire('focus', { target: search });
  runtime.api.setVisible(false);
  assert.equal(search.blurred, 2, 'hiding drops the field focus');
  assert.deepEqual(keyboard().at(-1), false);
  runtime.document.activeElement = button;
  runtime.api.setVisible(true);
  runtime.api.setVisible(false);
  assert.equal(search.blurred, 2, 'only text fields are blurred');

  runtime.api.setVisible(true);
  runtime.api.selectTab('voice');
  runtime.document.fire('focus', { target: search });
  runtime.document.activeElement = search;
  runtime.api.selectTab('flight');
  assert.equal(search.blurred, 3, 'switching tabs drops a field that would stay focused while hidden');
  assert.deepEqual(keyboard().at(-1), false);

  const count = keyboard().length;
  runtime.window.fire('beforeunload');
  assert.deepEqual(keyboard().slice(count), [false], 'unloading releases the keyboard');
});

test('toolbar page announces readiness before the WebSocket is available', () => {
  const runtime = page(); runtime.api.boot();
  assert.ok(runtime.messages.some(message => message.action === 'ready'));
  assert.equal(runtime.sockets.length, 0);
  assert.ok(runtime.requests.some(request => request.url.startsWith('/api/toolbar/bootstrap')));
});

test('toolbar bounds stalled WebSocket handshakes and ignores a late open after replacement', () => {
  const runtime = page(); runtime.api.connect(); runtime.requests[0].succeed();
  const stalled = runtime.sockets[0], lateOpen = stalled.onopen;
  runtime.timer.advance(10000);
  assert.equal(stalled.closed, true, 'a connection that never opens must be released');
  runtime.timer.advance(1000);
  assert.equal(runtime.requests.length, 2, 'retry uses the ordinary backoff');
  lateOpen();
  assert.notEqual(runtime.api.state.connection, 'connected');
  runtime.requests[1].succeed(); runtime.sockets[1].onopen();
  assert.equal(runtime.timer.pending, 0, 'a successful connection cancels its deadline');
});

test('toolbar cancels pending voice reference work on unload and ignores a late response', () => {
  const runtime = page(); runtime.api.boot();
  const reference = runtime.requests.find(request => request.url === '/toolbar/voice-reference.json');
  const lateLoad = reference.onload;
  runtime.window.fire('beforeunload');
  assert.equal(reference.aborted, true);
  const nodeCount = runtime.nodes.length;
  reference.status = 200; reference.responseText = '{"flightPlanQueries":["route"]}'; lateLoad();
  assert.equal(runtime.api.state.voiceReference, null);
  assert.equal(runtime.nodes.length, nodeCount);
});

test('toolbar resumes an interrupted reference request only when Voice is shown', () => {
  const runtime = page(); runtime.api.boot();
  const reference = runtime.requests.find(request => request.url === '/toolbar/voice-reference.json');
  const lateLoad = reference.onload;
  runtime.api.setVisible(false);
  assert.equal(reference.aborted, true);
  runtime.api.setVisible(true);
  assert.equal(runtime.requests.filter(request => request.url === reference.url).length, 1);
  runtime.api.selectTab('voice');
  const retry = runtime.requests.filter(request => request.url === reference.url).at(-1);
  assert.notEqual(retry, reference);
  reference.status = 200; reference.responseText = '{"stale":true}'; lateLoad();
  assert.equal(runtime.api.state.voiceReference, null);
  retry.status = 200; retry.responseText = '{"flightPlanQueries":[]}'; retry.onload();
  assert.ok(runtime.api.state.voiceReference);
  runtime.api.selectTab('flight'); runtime.api.selectTab('voice');
  assert.equal(runtime.requests.filter(request => request.url === reference.url).length, 2);
});

for (const interruption of ['hide', 'unload']) {
  test(`toolbar cancels an update reload on ${interruption}`, () => {
    const runtime = page(); runtime.api.boot(); runtime.api.state.appVersion = '0.9.8';
    runtime.requests.find(request => request.url.startsWith('/api/toolbar/bootstrap')).succeed();
    assert.ok(runtime.messages.some(message => message.action === 'reload'));
    if (interruption === 'hide') runtime.api.setVisible(false);
    else runtime.window.fire('beforeunload');
    runtime.timer.advance(1000);
    assert.equal(runtime.reloads.length, 0, 'a hidden or disposed page cannot navigate');
    if (interruption === 'hide') {
      runtime.api.setVisible(true); runtime.timer.advance(500);
      assert.equal(runtime.reloads.length, 1, 'the deferred update resumes once when shown');
    }
  });
}

test('toolbar loader backs off visible offline navigations during a long outage', () => {
  const runtime = loader({ active: true });
  runtime.timer.advance(60 * 60 * 1000);
  assert.ok(runtime.navigations.length < 130, 'do not keep destroying/recreating the frame every five seconds');
  assert.equal(runtime.timer.pending, 1);
  runtime.hide(); runtime.timer.advance(60 * 60 * 1000);
  assert.equal(runtime.timer.pending, 0);
});

test('toolbar reconnects when shown after a socket loss during the hidden grace period', () => {
  const runtime = page(); runtime.api.connect(); runtime.requests[0].succeed(); runtime.sockets[0].onopen();
  runtime.api.setVisible(false); runtime.timer.advance(5000); runtime.sockets[0].onclose();
  runtime.api.setVisible(true);
  assert.equal(runtime.requests.length, 2);
  runtime.requests[1].succeed(); runtime.sockets[1].onopen();
  assert.equal(runtime.api.state.connection, 'connected');
  assert.equal(runtime.timer.pending, 0);
});

test('toolbar cancels hidden bootstrap work and ignores its late completion', () => {
  const runtime = page(); runtime.api.connect();
  const request = runtime.requests[0], lateCompletion = request.onload;
  runtime.api.setVisible(false);
  assert.equal(request.aborted, true);
  runtime.timer.advance(30000);
  request.status = 200; request.responseText = JSON.stringify({ ok: true, wsPort: 8100 }); lateCompletion();
  assert.equal(runtime.sockets.length, 0);
  assert.equal(runtime.api.state.connection, 'paused');
  runtime.api.setVisible(true);
  assert.equal(runtime.requests.length, 2);
});

test('toolbar keeps a healthy socket on a brief hide but closes it on sustained hiding or unload', () => {
  const runtime = page(); runtime.api.boot();
  const bootstrap = runtime.requests.find(request => request.url.startsWith('/api/toolbar/bootstrap'));
  bootstrap.succeed(); runtime.sockets[0].onopen();
  runtime.api.setVisible(false); runtime.timer.advance(5000); runtime.api.setVisible(true);
  assert.equal(runtime.sockets.length, 1);
  assert.equal(runtime.sockets[0].closed, false);
  runtime.api.setVisible(false); runtime.timer.advance(20000);
  assert.equal(runtime.sockets[0].closed, true);
  runtime.api.setVisible(true);
  const pending = runtime.requests.at(-1);
  runtime.window.fire('beforeunload');
  assert.equal(pending.aborted, true);
  assert.equal(runtime.timer.pending, 0);
});

test('toolbar repeated visibility messages do not postpone pausing or duplicate reconnects', () => {
  const runtime = page(); runtime.api.boot();
  const bootstrap = runtime.requests.find(request => request.url.startsWith('/api/toolbar/bootstrap'));
  bootstrap.succeed(); runtime.sockets[0].onopen();
  const visibility = visible => runtime.window.fire('message', {
    source: runtime.window.parent, data: { source: 'flightfabric-toolbar-loader', action: 'visibility', visible },
  });
  visibility(false); runtime.timer.advance(15000); visibility(false); runtime.timer.advance(5000);
  assert.equal(runtime.sockets[0].closed, true, 'repeated hides retain the original pause deadline');
  const count = runtime.requests.length;
  visibility(true); visibility(true);
  assert.equal(runtime.requests.length, count + 1, 'repeated shows start one bootstrap');
  runtime.requests.at(-1).succeed(); runtime.sockets.at(-1).onopen();
  assert.equal(runtime.api.state.connection, 'connected');
  assert.equal(runtime.timer.pending, 0);
});

test('toolbar outage retries stay bounded and recover after repeated hide/show cycles', () => {
  const runtime = page(); runtime.api.connect();
  // Exercise timeout/error/status failures and the capped exponential backoff.
  for (const [index, delay] of [1000, 2000, 4000, 8000, 15000, 15000].entries()) {
    const request = runtime.requests.at(-1);
    if (index % 3 === 0) request.ontimeout();
    else if (index % 3 === 1) request.onerror();
    else { request.status = 503; request.responseText = '{}'; request.onload(); }
    const count = runtime.requests.length;
    assert.equal(runtime.timer.pending, 1);
    runtime.timer.advance(delay - 1); assert.equal(runtime.requests.length, count);
    runtime.timer.advance(1); assert.equal(runtime.requests.length, count + 1);
  }
  for (let index = 0; index < 100; index += 1) {
    runtime.api.setVisible(false);
    assert.equal(runtime.requests.at(-1).aborted, true);
    const count = runtime.requests.length;
    runtime.timer.advance(60000);
    assert.equal(runtime.requests.length, count, 'hidden page stops network work');
    assert.equal(runtime.timer.pending, 0);
    runtime.api.setVisible(true);
    assert.equal(runtime.requests.length, count + 1);
  }
  runtime.requests.at(-1).succeed(); runtime.sockets.at(-1).onopen();
  assert.equal(runtime.api.state.connection, 'connected');
  assert.equal(runtime.timer.pending, 0);
  runtime.sockets.at(-1).onclose(); runtime.timer.advance(1000);
  assert.equal(runtime.timer.pending, 0, 'successful connection resets backoff to one second');
  assert.ok(runtime.requests.at(-1).url.startsWith('/api/toolbar/bootstrap'));
});

test('toolbar defers hidden tab and hidden panel rendering while retaining the latest state', () => {
  const runtime = page(); runtime.api.boot();
  const count = runtime.nodes.length;
  runtime.api.receive({ type: 'voiceStatus', status: 'listening', statusText: 'Latest phrase' });
  runtime.api.receive({ type: 'flightPlan', origin: 'YSSY', destination: 'YMML' });
  assert.equal(runtime.document.getElementById('tab-voice').children.length, 0, 'hidden Voice tab stays unbuilt');
  assert.equal(runtime.document.getElementById('tab-plan').children.length, 0, 'hidden Plan tab stays unbuilt');
  assert.ok(runtime.nodes.length - count < 50, 'only the small tab navigation changes');
  runtime.api.setVisible(false);
  const hiddenCount = runtime.nodes.length;
  for (let index = 0; index < 100; index += 1) {
    runtime.api.receive({ type: 'simState', inMenu: false, simconnectConnected: true });
    runtime.api.receive({ type: 'voiceStatus', status: 'sent', statusText: 'Command ' + index });
  }
  assert.equal(runtime.nodes.length, hiddenCount, 'hidden panel performs no DOM construction');
  runtime.api.setVisible(true); runtime.api.selectTab('voice');
  assert.match(runtime.document.getElementById('tab-voice').text(), /Command 99/, 'opening displays the latest retained status');
});

test('toolbar voice status updates preserve the searchable command catalogue', () => {
  const runtime = page(); runtime.api.boot();
  runtime.api.receive({ type: 'aircraftProfile', profile: { name: 'Test aircraft' }, controlCapabilities: {
    aircraftCommands: { commands: [{ id: 'lights.taxi', label: 'Taxi light', speech: { patterns: ['taxi light on'] } }] },
  } });
  runtime.api.selectTab('voice');
  const voice = runtime.document.getElementById('tab-voice');
  const input = voice.querySelector('input');
  input.value = 'taxi'; input.fire('input');
  const count = runtime.nodes.length;
  runtime.api.receive({ type: 'voiceStatus', status: 'listening', statusText: 'Listening now' });
  assert.equal(voice.querySelector('input'), input, 'the focused input is not detached by push-to-talk');
  assert.equal(input.value, 'taxi');
  assert.match(voice.text(), /Listening now/);
  assert.ok(runtime.nodes.length - count < 20, 'a status update only rebuilds its small status card');
});

test('toolbar keeps every section available despite old hidden-tab preferences', () => {
  for (const tabs of [{ flight: false, plan: true, voice: false }, { flight: false, plan: false, voice: false }]) {
    const storage = new Map([['ff_toolbar_prefs_v1', JSON.stringify({ tabs, defaultTab: 'voice', theme: 'light', scale: 'l' })]]);
    const runtime = page({ storage }); runtime.api.boot();
    const tabIds = ['flight', 'plan', 'voice'];
    assert.deepEqual(runtime.document.getElementById('tabs').children.map(node => node.id), tabIds.map(id => 'tab-button-' + id));
    assert.equal(runtime.api.state.activeTab, 'voice', 'the chosen opening section remains available');
    assert.equal(runtime.document.documentElement['data-theme'], 'light');
    assert.equal(runtime.document.documentElement['data-scale'], 'l');
    runtime.api.receive({ type: 'flightPlan', origin: 'YSSY', destination: 'YMML' });
    for (const id of tabIds) {
      runtime.document.getElementById('tabs').children.find(node => node.id === 'tab-button-' + id).fire('click');
      assert.equal(runtime.api.state.activeTab, id);
      assert.equal(runtime.document.getElementById('tab-' + id).hidden, false);
    }
    assert.match(runtime.document.getElementById('tab-plan').text(), /YSSY/);
    runtime.document.getElementById('settings-button').fire('click');
    assert.equal(runtime.nodes.some(node => node.tag === 'input' && node.type === 'checkbox'), false);
    const opening = runtime.nodes.find(node => node['aria-label'] === 'Open on');
    assert.deepEqual(opening.children.map(node => node.textContent), ['Flight', 'Plan', 'Voice']);
    opening.children[1].fire('click');
    const saved = JSON.parse(storage.get('ff_toolbar_prefs_v1'));
    assert.equal(saved.defaultTab, 'plan');
    assert.equal(saved.tabs, undefined, 'saving preferences retires the old visibility flags');
    const reopened = page({ storage }); reopened.api.boot();
    assert.equal(reopened.api.state.activeTab, 'plan');
    assert.equal(reopened.document.getElementById('tabs').children.length, 3);
  }
});

test('toolbar renders the live landing packet, including finality, nested measurements and cautions', () => {
  const runtime = page();
  runtime.api.receive(aircraftProfile());
  runtime.api.receive({ type: 'landing', final: false, vs: -420, grade: 'FIRM', gforce: 1.5 });
  assert.match(runtime.api.landingCard().text(), /provisional/);
  assert.match(runtime.api.landingCard().text(), /-- \| Bounces/);
  runtime.api.receive({
    type: 'landing', final: true, vs: -420, grade: 'FIRM', gforce: 1.5, crosswind: 12,
    approachType: 'ILS', runwayExcursion: true, shortLanding: true,
    touchdownDistance: { distanceFt: 1650, bounceCount: 2, lateralOffsetFt: 45, lateralOffsetSide: 'right' },
    ultimateStability: { score: 85, verdict: 'unstable' },
  });
  const rendered = runtime.api.landingCard().text();
  for (const expected of ['final', '-420', '1,650 ft', '2 | Bounces', '12 kt', '85%', 'ILS', 'Runway excursion', 'Short landing', 'Centerline 45 ft right']) {
    assert.ok(rendered.includes(expected), `${expected}: ${rendered}`);
  }
  assert.ok(!rendered.includes('provisional'));
  runtime.api.receive({ type: 'ultimateStabilityScore', score: 78, verdict: 'unstable' });
  runtime.api.state.landing = null; runtime.api.restoreLanding();
  assert.match(runtime.api.landingCard().text(), /78%/);
  runtime.api.receive({ type: 'ultimateStabilityScore', score: null, verdict: 'no_verdict' });
  assert.match(runtime.api.landingCard().text(), /-- \| Stability/);
});

function scoredTakeoff(overrides = {}) {
  return {
    type: 'takeoff', final: true, grade: 'Late Liftoff', score: 55, zone: 'Little runway remaining', icao: 'YSSY', runway: '34L',
    runwayExcursion: false, hopCount: 1, crosswind: 9,
    runwayUse: { remainingFt: 300, liftoffDistanceFt: 5700, usedPct: 95, runwayLengthFt: 6000, beyondRunwayEnd: false },
    roll: { distanceFt: 5500, durationS: 38 },
    liftoff: { iasKts: 138, pitchDeg: 9.1 },
    screenHeight: { heightFt: 35, reached: true, remainingFt: -200 },
    rotation: { rateDegS: 2.4 },
    lateral: { liftoffOffsetFt: 22, liftoffOffsetSide: 'left', verified: true },
    ...overrides,
  };
}

test('the release gate hides toolbar takeoffs from live packets, history and saved cache without deleting records', () => {
  const cacheKey = 'ff_toolbar_last_takeoff_v1';
  const cached = JSON.stringify({ at: Date.now(), aircraft: { profileKey: 'bundled/msfs/pmdg-737', title: 'PMDG 737-800' }, takeoff: scoredTakeoff() });
  const storage = new Map([[cacheKey, cached]]);
  const runtime = page({ storage });
  assert.equal(runtime.window.FlightFabricAppSettings.TAKEOFF_SCORING_ENABLED, false);
  assert.equal(runtime.api.subscription.includes('takeoff'), false);
  assert.equal(runtime.api.subscription.includes('landing'), true);
  runtime.api.restoreTakeoff();
  runtime.api.receive(aircraftProfile());
  runtime.api.receive({ type: 'takeoff', final: false });
  runtime.api.receive(scoredTakeoff());
  assert.equal(runtime.api.state.takeoff, null);
  runtime.api.receive({ type: 'toolbarFlightHistory', aircraft: { profileKey: 'bundled/msfs/pmdg-737', title: 'PMDG 737-800' },
    flightId: 'flight-a', landing: { final: true, grade: 'GOOD', vs: -180 }, takeoff: scoredTakeoff(), cautions: [] });
  assert.equal(runtime.api.state.takeoff, null, 'history cannot restore a disabled takeoff card');
  assert.equal(runtime.api.takeoffCard(), null);
  assert.equal(runtime.api.state.landing.grade, 'GOOD', 'landing history still restores');
  const rendered = runtime.document.getElementById('tab-flight').text();
  assert.match(rendered, /Last landing/);
  assert.doesNotMatch(rendered, /Last takeoff|Late Liftoff/);
  runtime.api.receive(aircraftProfile('bundled/msfs/fenix-a320', 'Fenix A320'));
  assert.equal(storage.get(cacheKey), cached, 'the disabled release leaves existing saved takeoff data intact');
});

test('toolbar renders the scored takeoff packet and ignores liftoff, settle-back and cancel packets', () => {
  const runtime = page({ takeoffScoringEnabled: true });
  runtime.api.receive(aircraftProfile());
  assert.match(runtime.api.takeoffCard().text(), /after you lift off/);
  runtime.api.receive({ type: 'takeoff', final: false, iasKts: 140 });
  assert.match(runtime.api.takeoffCard().text(), /after you lift off/, 'a liftoff packet does not show a card');
  runtime.api.receive(scoredTakeoff());
  const rendered = runtime.api.takeoffCard().text();
  for (const expected of ['Late Liftoff', 'YSSY', 'RWY 34L', 'Little runway remaining', '300 ft', 'Runway left', '5,500 ft', '138 kt',
    '200 ft past', 'At 35 ft', '2.4 deg/s', '9 kt', 'Screen height reached beyond the runway end', 'Settled back once', 'Centerline 22 ft left']) {
    assert.ok(rendered.includes(expected), `${expected}: ${rendered}`);
  }
  assert.ok(!rendered.includes('Runway excursion'));
  runtime.api.receive({ type: 'takeoff', final: false, cancelled: true, reason: 'reset' });
  assert.match(runtime.api.takeoffCard().text(), /Late Liftoff/, 'a cancelled later attempt keeps the scored takeoff');
  runtime.api.receive(scoredTakeoff({ grade: 'Overrun', runwayUse: { remainingFt: -120, beyondRunwayEnd: true }, screenHeight: {}, lateral: {} }));
  const overrun = runtime.api.takeoffCard().text();
  assert.ok(overrun.includes('Past runway end') && overrun.includes('120 ft') && overrun.includes('Lifted off beyond the runway end'), overrun);
  assert.ok(overrun.includes('-- | Screen height'), overrun);
  assert.equal(runtime.api.state.landing, null, 'the takeoff never touches landing state');
  assert.equal(runtime.storage.has('ff_toolbar_last_takeoff_v1'), true);
  runtime.api.state.takeoff = null; runtime.api.restoreTakeoff();
  assert.equal(runtime.api.state.takeoff.grade, 'Overrun', 'the cached takeoff survives a page reload for the same aircraft');
});

test('toolbar history snapshots and aircraft changes handle the takeoff like the landing', () => {
  const runtime = page({ takeoffScoringEnabled: true });
  runtime.api.receive(aircraftProfile());
  runtime.api.receive(scoredTakeoff());
  runtime.api.receive({ type: 'landing', final: true, grade: 'GOOD', icao: 'YSSY' });
  runtime.api.receive({ type: 'toolbarFlightHistory', aircraft: { profileKey: 'bundled/msfs/pmdg-737', title: 'PMDG 737-800' },
    flightId: 'flight-a', landing: null, takeoff: scoredTakeoff({ grade: 'Good' }), cautions: [] });
  assert.equal(runtime.api.state.takeoff.grade, 'Good', 'the backend snapshot replaces the local takeoff');
  assert.equal(runtime.api.state.landing, null, 'an empty landing in the snapshot clears the landing');
  runtime.api.receive({ type: 'toolbarFlightHistory', aircraft: { profileKey: 'bundled/msfs/pmdg-737', title: 'PMDG 737-800' },
    flightId: 'flight-a', landing: null, takeoff: null, cautions: [] });
  assert.equal(runtime.api.state.takeoff, null, 'an empty snapshot supersedes localStorage');
  assert.equal(runtime.storage.has('ff_toolbar_last_takeoff_v1'), false);
  runtime.api.receive(scoredTakeoff());
  runtime.api.receive(aircraftProfile('bundled/msfs/fenix-a320', 'Fenix A320'));
  assert.equal(runtime.api.state.takeoff, null, 'another aircraft drops the takeoff');
  assert.equal(runtime.storage.has('ff_toolbar_last_takeoff_v1'), false);
});

test('toolbar clears old aircraft history after an aircraft change missed while hidden or disconnected', () => {
  for (const interruption of ['hidden', 'disconnected']) {
    for (const nextProfile of [aircraftProfile('bundled/msfs/fbw-a32nx', 'FlyByWire A320', 2), aircraftProfile('bundled/msfs/pmdg-737', 'PMDG 737-900', 2)]) {
      const runtime = page();
      runtime.api.connect(); runtime.requests[0].succeed(); runtime.sockets[0].onopen();
      runtime.api.receive(aircraftProfile());
      runtime.api.receive({ type: 'landing', final: true, grade: 'GOOD', icao: 'YSSY' });
      runtime.api.receive({ type: 'flightViolation', event: 'start', severity: 'critical', label: 'Old aircraft stall' });
      if (interruption === 'hidden') {
        runtime.api.setVisible(false); runtime.timer.advance(20001);
        assert.equal(runtime.sockets[0].closed, true);
        runtime.api.setVisible(true);
      } else {
        runtime.sockets[0].onclose(); runtime.timer.advance(1000);
      }
      runtime.requests.at(-1).succeed(); runtime.sockets[1].onopen();
      // requestState replays the current profile, not the aircraftChanged
      // event that occurred while this socket was absent.
      runtime.api.receive(nextProfile);
      assert.equal(runtime.api.state.landing, null, interruption);
      assert.equal(runtime.api.state.cautions.length, 0, interruption);
      assert.equal(runtime.storage.has('ff_toolbar_last_landing_v1'), false, interruption);
      const rendered = runtime.document.getElementById('tab-flight').text();
      assert.ok(!rendered.includes('YSSY') && !rendered.includes('Old aircraft stall'), rendered);
    }
  }
});

test('toolbar keeps same-aircraft history across reconnects, revision refreshes and capability updates', () => {
  const runtime = page();
  runtime.api.connect(); runtime.requests[0].succeed(); runtime.sockets[0].onopen();
  runtime.api.receive(aircraftProfile());
  const landing = { type: 'landing', final: true, grade: 'GOOD', icao: 'YSSY' };
  runtime.api.receive(landing);
  runtime.api.receive({ type: 'flightViolation', event: 'start', label: 'Earlier caution' });
  runtime.api.setVisible(false); runtime.timer.advance(20001); runtime.api.setVisible(true);
  runtime.requests.at(-1).succeed(); runtime.sockets[1].onopen();
  runtime.api.receive(aircraftProfile('bundled/msfs/pmdg-737', 'PMDG 737-800', 3));
  runtime.api.receive({ type: 'dataSources', profileKey: 'bundled/msfs/pmdg-737', profileRevision: 3, controlCapabilities: { aircraftCommands: { commands: [] } } });
  assert.equal(runtime.api.state.landing, landing);
  assert.equal(runtime.api.state.cautions[0].label, 'Earlier caution');
  assert.equal(runtime.storage.has('ff_toolbar_last_landing_v1'), true);
  runtime.api.receive({ type: 'aircraftChanged' });
  assert.equal(runtime.api.state.landing, null);
  assert.equal(runtime.api.state.cautions.length, 0);
  assert.equal(runtime.storage.has('ff_toolbar_last_landing_v1'), false);
});

test('toolbar defers cached landings until the replayed aircraft matches and discards another aircraft cache', () => {
  for (const nextProfile of [aircraftProfile('bundled/msfs/fbw-a32nx', 'FlyByWire A320', 2), aircraftProfile('bundled/msfs/pmdg-737', 'PMDG 737-900', 2)]) {
    const previous = page();
    previous.api.receive(aircraftProfile());
    previous.api.receive({ type: 'landing', final: true, grade: 'GOOD', icao: 'YSSY' });
    const runtime = page({ storage: previous.storage });
    runtime.api.boot();
    assert.equal(runtime.api.state.landing, null, 'cached history stays hidden until the aircraft is known');
    runtime.api.receive(nextProfile);
    assert.equal(runtime.api.state.landing, null);
    assert.equal(runtime.storage.has('ff_toolbar_last_landing_v1'), false);
    assert.ok(!runtime.document.getElementById('tab-flight').text().includes('YSSY'));
  }
});

test('toolbar restores same-aircraft landing history after a page reload despite a new profile revision', () => {
  const previous = page();
  previous.api.receive(aircraftProfile());
  previous.api.receive({ type: 'landing', final: true, grade: 'GOOD', icao: 'YSSY' });
  const runtime = page({ storage: previous.storage });
  runtime.api.boot();
  assert.equal(runtime.api.state.landing, null);
  runtime.api.receive(aircraftProfile('bundled/msfs/pmdg-737', 'PMDG 737-800', 4));
  assert.equal(runtime.api.state.landing.icao, 'YSSY');
  assert.ok(runtime.document.getElementById('tab-flight').text().includes('YSSY'));
  runtime.api.receive({ ...aircraftProfile(), controlCapabilities: { aircraftCommands: { commands: [] } } });
  assert.equal(runtime.api.state.landing.icao, 'YSSY');
});

test('toolbar discards legacy cached landings without an aircraft association', () => {
  const storage = new Map([['ff_toolbar_last_landing_v1', JSON.stringify({ at: Date.now(), landing: { type: 'landing', icao: 'YSSY' } })]]);
  const runtime = page({ storage });
  runtime.api.boot();
  runtime.api.receive(aircraftProfile());
  assert.equal(runtime.api.state.landing, null);
  assert.equal(storage.has('ff_toolbar_last_landing_v1'), false);
});

test('toolbar history snapshots replace cached results and cautions without duplication', () => {
  const runtime = page(); runtime.api.boot(); runtime.api.receive(aircraftProfile());
  runtime.api.receive({ type: 'landing', final: false, grade: 'GOOD' });
  const snapshot = { type: 'toolbarFlightHistory', aircraft: { profileKey: 'bundled/msfs/pmdg-737', title: 'PMDG 737-800' },
    flightId: 'flight-a', landing: { final: true, grade: 'HARD', runwayExcursion: true, ultimateStability: { score: 45, verdict: 'unstable' } },
    cautions: [{ label: 'Stall', severity: 'critical', at: 1234 }] };
  runtime.api.receive(snapshot); runtime.api.receive(snapshot);
  assert.equal(runtime.api.state.landing.final, true);
  assert.equal(runtime.api.state.cautions.length, 1);
  assert.match(runtime.document.getElementById('tab-flight').text(), /Runway excursion/);
  assert.match(runtime.document.getElementById('tab-flight').text(), /45%/);
  runtime.api.receive({ ...snapshot, landing: null, cautions: [] });
  assert.equal(runtime.api.state.landing, null, 'an empty backend snapshot supersedes localStorage');
  assert.equal(runtime.api.state.cautions.length, 0);
  assert.equal(runtime.storage.has('ff_toolbar_last_landing_v1'), false);
});

test('toolbar rejects history for another aircraft or flight and clears history on a new flight', () => {
  const runtime = page(); runtime.api.boot(); runtime.api.receive(aircraftProfile());
  const snapshot = { type: 'toolbarFlightHistory', aircraft: { profileKey: 'bundled/msfs/pmdg-737', title: 'PMDG 737-800' },
    flightId: 'flight-a', landing: { final: true, grade: 'GOOD' }, cautions: [] };
  runtime.api.receive({ type: 'flightTime', active: true, flightId: 'flight-a' });
  runtime.api.receive(snapshot);
  assert.ok(runtime.api.state.landing);
  runtime.api.receive({ type: 'flightTime', active: true, flightId: 'flight-b' });
  assert.equal(runtime.api.state.landing, null);
  runtime.api.receive(snapshot);
  assert.equal(runtime.api.state.landing, null, 'previous flight cannot reappear');
  runtime.api.receive({ ...snapshot, flightId: 'flight-b', aircraft: { ...snapshot.aircraft, title: 'Another 737' } });
  assert.equal(runtime.api.state.landing, null, 'same profile is not proof of the same aircraft');
});

test('toolbar ignores an old rollout final after aircraft change until a new touchdown', () => {
  const runtime = page(); runtime.api.boot(); runtime.api.receive(aircraftProfile());
  runtime.api.receive({ type: 'landing', final: false, grade: 'GOOD' });
  runtime.api.receive({ type: 'aircraftChanged' });
  runtime.api.receive(aircraftProfile('bundled/msfs/pmdg-737', 'Other 737'));
  runtime.api.receive({ type: 'landing', final: true, grade: 'HARD' });
  runtime.api.receive({ type: 'ultimateStabilityScore', score: 45, verdict: 'unstable' });
  assert.equal(runtime.api.state.landing, null);
  runtime.api.receive({ type: 'landing', final: false, grade: 'FIRM' });
  runtime.api.receive({ type: 'landing', final: true, grade: 'FIRM' });
  assert.equal(runtime.api.state.landing.final, true);
  assert.equal(runtime.api.state.landing.grade, 'FIRM');
});

module.exports = { page, aircraftProfile };
