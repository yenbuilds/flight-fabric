import { renderTaxiMap } from './taxi-map.js';
import { splitRoute } from './taxi-progress.js';
import { createDeparturePreview } from './departure-preview.js';
import { renderPushbackMap, pushbackCaption } from './pushback-map.js';
import { createPushbackControls } from './pushback-controls.js';
import { TAXI_COPY } from './taxi-presentation.js';

// Manual taxi guidance with explicit pushback Start/Stop. Inputs remain
// mounted while telemetry refreshes, preserving native keyboard capture/caret.
export function createTaxiPanel({ document, send, setTimeout, clearTimeout, now = Date.now }) {
  const element = node('section', 'card taxi-section');
  element.id = 'toolbar-taxi';
  element.appendChild(node('h2', 'card-title', TAXI_COPY.title));
  element.appendChild(node('p', 'muted', 'Experimental · MSFS 2024'));
  const intro = element.appendChild(node('p', 'muted', TAXI_COPY.departureIntro));
  intro.id = 'taxi-intro';
  const fields = element.appendChild(node('div', 'taxi-fields'));
  const airport = input('Airport ICAO', 'taxi-airport', 8);
  const mode = select('Journey', 'taxi-mode', [['runway', 'Depart: to runway'], ['stand', 'Arrive: to stand']]);
  const runway = input('Departure runway', 'taxi-runway', 3);
  const stand = select('Stand / gate', 'taxi-stand', [['', 'Load airport stands']]);
  const departureHelp = element.appendChild(node('p', 'muted', TAXI_COPY.departureHelp));
  const startHelp = element.appendChild(node('p', 'muted', TAXI_COPY.startHelp));
  startHelp.id = 'taxi-pushback-help';
  const actions = element.appendChild(node('div', 'taxi-actions'));
  const push = button(TAXI_COPY.start, 'taxi-pushback-action', () => pushbackControls.request(pushback.active ? 'stop' : 'start'));
  push.addEventListener('keydown', event => { if (event.repeat && ['Enter', ' '].includes(event.key)) event.preventDefault(); });
  const pushbackReason = element.appendChild(node('p', 'taxi-reason muted'));
  pushbackReason.id = 'taxi-pushback-reason'; pushbackReason.setAttribute('role', 'status');
  const load = button('Load stands', 'taxi-load-stands', () => request('parkings'));
  const show = button(TAXI_COPY.showRoute, 'taxi-show-route', () => request('preview'));
  const hide = button(TAXI_COPY.hideRoute, 'taxi-hide-route', () => { invalidate(); pushbackSelected = true; refresh(); });
  const guidanceHelp = element.appendChild(node('p', 'muted', TAXI_COPY.guidanceHelp));
  guidanceHelp.id = 'taxi-guidance-help';
  show.setAttribute('aria-describedby', guidanceHelp.id);
  const reason = element.appendChild(node('p', 'taxi-reason muted'));
  reason.setAttribute('role', 'status');
  const figure = element.appendChild(node('figure', 'taxi-figure'));
  const pushbackView = node('button', 'button button-quiet', 'Pushback');
  pushbackView.id = 'taxi-pushback-view'; pushbackView.type = 'button'; figure.appendChild(pushbackView);
  pushbackView.addEventListener('click', () => { pushbackSelected = true; refresh(); });
  const viewButton = node('button', 'button button-quiet', 'Taxi map');
  viewButton.id = 'taxi-view'; viewButton.type = 'button'; figure.appendChild(viewButton);
  viewButton.addEventListener('click', () => { pushbackSelected = false; refresh(); });
  const map = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  map.setAttribute('viewBox', '0 0 360 300'); map.setAttribute('role', 'img');
  map.setAttribute('aria-label', 'Taxi route'); map.setAttribute('focusable', 'false');
  figure.appendChild(map);
  const caption = figure.appendChild(node('figcaption', 'taxi-caption'));
  const cautions = element.appendChild(node('p', 'taxi-cautions'));
  element.appendChild(node('p', 'taxi-note muted', 'Routes use simulator scenery and may cross runways. Follow your ATC clearance and check traffic, obstacles and aircraft clearance.'));
  const prefix = 'taxi-' + now() + '-' + Math.random().toString(36).slice(2) + '-';
  let connection = {}, context = '', catalogue = {}, state = {}, route = null, scene = null;
  let timer = null, sequence = 0, revision = 0, lastReply = -Infinity, error = '', standsLoaded = false;
  const pending = new Map();
  let departure = { data: null, fresh: false }, pushbackSelected = true, planDefault = {};
  let pushback = { active: false, pending: '', canStart: false, state: {} };
  const pushbackControls = createPushbackControls({ send, now, setTimeout, clearTimeout, changed(snapshot) {
    if (snapshot.active && !pushback.active) { invalidate(); pushbackSelected = true; }
    pushback = snapshot; refresh();
  } });
  const departurePreview = createDeparturePreview({ send, now, setTimeout, clearTimeout, changed(snapshot) {
    const previous = departure.data?.pushbackPreview.phase, phase = snapshot.data?.pushbackPreview.phase;
    departure = snapshot;
    if (['connecting', 'pushing', 'stopping'].includes(phase) && !['connecting', 'pushing', 'stopping'].includes(previous)) { invalidate(); pushbackSelected = true; }
    if (phase === 'complete' && previous !== 'complete') { invalidate(); pushbackSelected = false; }
    updatePushback();
    refresh();
  } });
  function updateDeparture() {
    departurePreview.update({ connected: connection.connected, visible: connection.visible,
      enabled: enabled() && simReady() && mode.control.value === 'runway',
      profileKey: catalogue.profileKey, profileRevision: catalogue.profileRevision,
      icao: airport.control.value, runway: runway.control.value });
    updatePushback();
  }
  function updatePushback() {
    pushbackControls.update({ connected: connection.connected, visible: connection.visible,
      enabled: enabled(), disabled: !simReady() || mode.control.value !== 'runway' || has('preview') || has('parkings'),
      profileKey: catalogue.profileKey, profileRevision: catalogue.profileRevision,
      icao: airport.control.value, runway: runway.control.value, preview: departure });
  }

  function node(tag, className, text) {
    const n = document.createElement(tag); n.className = className || '';
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function field(label, control, id) {
    const wrapper = fields.appendChild(node('label', 'taxi-field', label));
    control.id = id; control.className = 'taxi-value'; wrapper.appendChild(control);
    return { control, wrapper };
  }
  function input(label, id, maxLength) {
    const n = document.createElement('input'); n.type = 'text'; n.maxLength = maxLength;
    n.autocomplete = 'off'; n.spellcheck = false;
    return field(label, n, id);
  }
  function select(label, id, choices) {
    const n = document.createElement('select');
    choices.forEach(([value, label]) => { const option = node('option', '', label); option.value = value; n.appendChild(option); });
    n.value = choices[0][0]; return field(label, n, id);
  }
  function button(label, id, action) {
    const n = node('button', 'button', label); n.type = 'button'; n.id = id;
    n.addEventListener('click', action); actions.appendChild(n); return n;
  }
  function clear(target) { while (target.firstChild) target.removeChild(target.firstChild); }
  function invalidate() { revision++; pending.clear(); route = null; scene = null; error = ''; }
  function reset() { invalidate(); state = {}; lastReply = -Infinity; clearStands();
    pushbackControls.update({ connected: connection.connected, visible: false }); departurePreview.reset(); }
  function clearStands() {
    if (!standsLoaded) return;
    standsLoaded = false;
    clear(stand.control); const empty = node('option', '', 'Load airport stands'); empty.value = '';
    stand.control.appendChild(empty); stand.control.value = '';
  }
  [airport, runway].forEach(({ control }) => control.addEventListener('input', () => {
    invalidate(); pushbackSelected = true; if (control === airport.control) clearStands(); updateDeparture(); refresh();
  }));
  [mode, stand].forEach(({ control }) => control.addEventListener('change', () => { invalidate(); pushbackSelected = true; updateDeparture(); refresh(); }));
  function enabled() { return connection.connected && connection.visible && ['toolbar-presets', 'full-control', 'aircraft-control'].includes(connection.scope); }
  function simReady() { const s = connection.simState; return s && s.simconnectConnected === true && s.inMenu !== true && s.paused !== true && s.isPaused !== true; }
  function fresh() { return now() - lastReply < 2000 && simReady(); }
  function has(operation) { return Array.from(pending.values()).some(p => p.operation === operation); }
  function validAirport() { return /^[A-Z0-9]{3,8}$/.test(airport.control.value.trim().toUpperCase()); }
  function validDestination() { return mode.control.value === 'stand' ? !!stand.control.value : /^(0?[1-9]|[12][0-9]|3[0-6])[LRC]?$/.test(runway.control.value.trim().toUpperCase()); }
  function request(operation) {
    if (!enabled() || has(operation)) return;
    if (operation !== 'status' && (!validAirport() || has('preview') || has('parkings') || pushback.active)) return;
    if (operation === 'preview' && (!fresh() || state.canGuide !== true || !validDestination())) return;
    if (operation === 'preview') { route = null; scene = null; pushbackSelected = false; }
    const requestId = prefix + (++sequence);
    const message = { type: 'requestTaxiGuidance', operation, requestId,
      profileKey: catalogue.profileKey, profileRevision: catalogue.profileRevision };
    if (operation !== 'status') message.icao = airport.control.value.trim().toUpperCase();
    if (operation === 'preview') {
      if (mode.control.value === 'stand') message.parking = stand.control.value;
      else message.runway = runway.control.value.trim().toUpperCase();
    }
    if (operation === 'status' && state.sceneKey != null && (!scene || scene.key !== state.sceneKey)) message.scene = true;
    if (operation !== 'status') error = '';
    if (send(message)) pending.set(requestId, { operation, revision, at: now() });
    else { state = {}; lastReply = -Infinity; error = 'Taxi guidance connection lost.'; }
    updatePushback(); refresh();
  }
  function poll() {
    timer = null;
    if (!enabled()) return;
    pending.forEach((p, id) => {
      if (now() - p.at >= (p.operation === 'status' ? 2000 : 12000)) {
        pending.delete(id);
        if (p.operation !== 'status') error = 'Taxi guidance request timed out. Try again.';
      }
    });
    request('status'); refresh();
    timer = setTimeout(poll, route || has('preview') ? 500 : 1000);
  }
  function update(next) {
    const c = next.profile && next.profile.controlCapabilities && next.profile.controlCapabilities.aircraftCommands || {};
    const key = c.profileKey + ':' + c.profileRevision;
    if (key !== context || !next.connected) { reset(); context = key; }
    const wasEnabled = enabled(); connection = next; catalogue = c;
    const plan = next.plan || {};
    if (!pushback.active && mode.control.value === 'runway' && (plan.origin !== planDefault.origin || plan.departureRunway !== planDefault.departureRunway)) {
      const previousAirport = airport.control.value, previousRunway = runway.control.value;
      if (!airport.control.value || airport.control.value === planDefault.origin) airport.control.value = plan.origin || '';
      if (airport.control.value === plan.origin && (!runway.control.value || runway.control.value === planDefault.departureRunway)) runway.control.value = plan.departureRunway || '';
      if (airport.control.value !== previousAirport || runway.control.value !== previousRunway) {
        if (airport.control.value !== previousAirport) clearStands();
        invalidate(); pushbackSelected = true;
      }
    }
    planDefault = plan;
    updateDeparture();
    if (!enabled()) {
      if (timer !== null) clearTimeout(timer); timer = null;
      pending.clear(); lastReply = -Infinity;
    } else if (!wasEnabled) poll();
    if (next.visible) refresh();
  }
  function receive(message) {
    if (pushbackControls.receive(message)) return;
    if (departurePreview.receive(message)) return;
    if (message.type !== 'toolbarTaxiState' || !enabled()) return;
    const p = pending.get(message.requestId);
    if (!p || p.revision !== revision) return;
    pending.delete(message.requestId);
    if (message.ok !== true) {
      error = message.error || 'Taxi guidance unavailable.';
      if (p.operation === 'status') { state = {}; lastReply = -Infinity; }
      refresh(); return;
    }
    if (message.currentProfileKey !== catalogue.profileKey || message.currentProfileRevision !== catalogue.profileRevision) { reset(); refresh(); return; }
    if (p.operation === 'parkings') {
      clearStands();
      const options = message.standOptions || (message.stands || []).map(label => ({ label }));
      standsLoaded = options.length > 0;
      options.forEach(item => { const n = node('option', '', item.label + (item.typeLabel ? ' · ' + item.typeLabel : '')); n.value = item.label; stand.control.appendChild(n); });
      if (!options.length) error = 'No stands found in this airport scenery.';
      refresh(); return;
    }
    if (p.operation === 'preview') {
      // Replies requested before this completed preview must not erase its scene.
      pending.forEach((value, id) => { if (value.operation === 'status') pending.delete(id); });
      route = message.preview || null;
    } else if (route && (!message.sceneKey || !scene || message.sceneKey !== scene.key)) route = null;
    if (message.scene) scene = message.scene;
    else if (scene && scene.key !== message.sceneKey) scene = null;
    // Include transport time in freshness; a delayed preview may be a useful
    // reference, but it cannot make an old aircraft pose look live again.
    state = message; lastReply = p.at; error = ''; updatePushback(); refresh();
  }
  function refresh() {
    const busy = has('preview') || has('parkings') || pushback.active;
    intro.textContent = pushback.active ? TAXI_COPY.departureIntro : mode.control.value === 'stand' ? TAXI_COPY.arrivalIntro : pushback.completed ? TAXI_COPY.complete : TAXI_COPY.departureIntro;
    departureHelp.hidden = startHelp.hidden = pushback.active || pushback.completed || mode.control.value !== 'runway';
    guidanceHelp.hidden = pushback.active;
    [airport, runway, mode, stand].forEach(({ control }) => { control.disabled = pushback.active; });
    push.hidden = !pushback.active && (mode.control.value !== 'runway' || pushback.completed);
    push.disabled = pushback.active ? pushback.pending === 'stop' : !pushback.canStart;
    push.setAttribute('aria-describedby', pushback.active ? 'taxi-pushback-reason' : 'taxi-pushback-help taxi-pushback-reason');
    push.textContent = pushback.active ? (pushback.pending === 'stop' ? 'Stopping…' : 'Stop pushback') : TAXI_COPY.start;
    push.className = 'button taxi-pushback-action' + (pushback.active ? ' taxi-pushback-stop' : '');
    pushbackReason.hidden = !pushback.active && mode.control.value !== 'runway';
    pushbackReason.className = 'taxi-reason ' + (pushback.completed ? 'taxi-complete' : 'muted');
    pushbackReason.textContent = (pushback.active && pushback.fresh && Number.isFinite(pushback.state.remainingM)
      ? Math.round(pushback.state.remainingM) + ' m remaining · Runway ' + pushback.state.runway + '. ' : '') + (pushback.reason || '');
    runway.wrapper.hidden = mode.control.value === 'stand'; stand.wrapper.hidden = mode.control.value !== 'stand';
    load.hidden = mode.control.value !== 'stand';
    load.disabled = !enabled() || !validAirport() || busy;
    show.disabled = !enabled() || !fresh() || !state.canGuide || !validAirport() || !validDestination() || busy;
    show.textContent = has('preview') ? 'Finding route…' : route || departure.data?.pushbackPreview.phase === 'complete' ? TAXI_COPY.refreshRoute : TAXI_COPY.showRoute;
    load.textContent = has('parkings') ? 'Loading stands…' : 'Load stands'; hide.hidden = !route && !has('preview');
    hide.textContent = departure.data ? 'Back to pushback' : TAXI_COPY.hideRoute;
    const unavailable = !connection.connected ? 'Connect FlightFabric to view taxi guidance.' : !enabled() ? 'Taxi guidance is unavailable on this connection.'
      : !fresh() ? 'Waiting for fresh aircraft position on the ground.' : state.guidanceUnavailableReason || '';
    const completed = departure.fresh && departure.data?.pushbackPreview.phase === 'complete';
    reason.textContent = (pushbackSelected && departure.data ? '' : error) || unavailable
      || (has('preview') || has('parkings') ? 'Loading airport guidance…' : completed && !pushback.completed ? TAXI_COPY.complete : '');
    reason.className = 'taxi-reason ' + (completed && !error && !unavailable && !busy ? 'taxi-complete' : 'muted');
    reason.hidden = !reason.textContent;
    const displayRoute = route || departure.data?.route;
    figure.hidden = !displayRoute; cautions.hidden = !displayRoute;
    pushbackView.hidden = !departure.data;
    viewButton.hidden = !departure.data;
    const pushing = !!(pushbackSelected && departure.data);
    pushbackView.setAttribute('aria-pressed', String(pushing));
    viewButton.setAttribute('aria-pressed', String(!pushing));
    if (!displayRoute || !connection.visible) return;
    if (pushing) {
      map.removeAttribute('data-taxi-map');
      renderPushbackMap(map, departure.data, departure.fresh);
      caption.textContent = pushbackCaption(departure.data, departure.fresh);
      cautions.hidden = true;
      return;
    }
    map.removeAttribute('data-pushback-map');
    const poseSource = route ? (fresh() ? state.aircraft : null) : (departure.fresh ? departure.data.aircraft : null);
    const a = poseSource && [poseSource.x, poseSource.z, poseSource.headingDeg].every(Number.isFinite) ? poseSource : null;
    renderRoute(displayRoute, a);
  }
  function renderRoute(route, a) {
    const progress = splitRoute(route.points, a), end = route.points[route.points.length - 1];
    const offRoute = progress.distanceM > 25;
    const arrived = a && Math.hypot(end.x - a.x, end.z - a.z) <= 5;
    const remaining = a && !offRoute ? progress.ahead.reduce((sum, p, i, points) => sum + (i ? Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z) : 0), progress.distanceM) : null;
    const destination = route.kind === 'stand' ? route.label : 'holding point before runway ' + route.runway;
    caption.textContent = !a ? 'Reference only · Live aircraft position unavailable.' : offRoute ? 'Off route · Check your position or show a new route.'
      : arrived ? (route.kind === 'stand' ? 'At ' + destination : 'At holding point · Hold short of runway ' + route.runway)
        : Math.round(remaining) + ' m to ' + destination;
    if (a && route === departure.data?.route && departure.data.pushbackPreview.phase !== 'complete') caption.textContent = 'Taxi route after pushback to runway ' + route.runway + '. You control the aircraft.';
    cautions.textContent = [(route.runwayTravelM > 1 ? 'Includes ' + Math.round(route.runwayTravelM) + ' m along an intervening runway.' : ''),
      (route.joinM >= 1 ? 'The first ' + Math.round(route.joinM) + ' m cross open ground to reach the centreline. Check for obstacles.' : '')].filter(Boolean).join(' ');
    cautions.hidden = !cautions.textContent;
    map.setAttribute('aria-label', 'North-up taxi route to ' + destination + '. ' + caption.textContent);
    renderTaxiMap(map, route, a);
  }
  refresh();
  return { element, update, receive, reset, destroy() { pushbackControls.destroy(); connection = {}; reset(); departurePreview.destroy(); if (timer !== null) clearTimeout(timer); timer = null; } };
}
