import { presetObservation, presetSourceUnavailableReason } from './preset-observation.js';
import { freshAircraftValue } from './fresh-aircraft-value.js';
import { presetGroups, presetNumberValue, brightnessLabel } from './preset-presentation.js';

// Coherent uses the app's catalogue and presentation rules without loading Vue
// or its per-tick stores. Keep controls mounted across telemetry updates.
export function createPresetPanel({ document, send, setTimeout, clearTimeout, now = Date.now }) {
  const element = node('section', 'card presets-section');
  element.setAttribute('aria-label', 'Presets');
  element.id = 'toolbar-presets';
  element.hidden = true;
  let context = '', catalogue = {}, snapshot = null, connection = {}, rows = [], pending = null;
  let tick = null, sequence = 0, signature = '', enabled = false;
  const drafts = Object.create(null), feedback = Object.create(null);
  function node(tag, className, text) {
    const result = document.createElement(tag);
    result.className = className || '';
    if (text !== undefined) result.textContent = text;
    return result;
  }
  function clear(target) { while (target.firstChild) target.removeChild(target.firstChild); }
  function contextKey(value) { return value.profileKey + ':' + value.profileRevision; }
  function currentSnapshot(message) {
    return message && message.profileKey === catalogue.profileKey && message.profileRevision === catalogue.profileRevision;
  }
  function reset() {
    snapshot = null; pending = null;
    Object.keys(drafts).forEach(key => delete drafts[key]);
    Object.keys(feedback).forEach(key => delete feedback[key]);
  }
  function loseConnection() {
    snapshot = null;
    if (pending) feedback[pending.id] = { text: 'Connection lost. Outcome unknown; check the cockpit before applying again.', tone: 'warn' };
    pending = null;
  }
  function statusReason(command) {
    if (!connection.connected) return 'Waiting for FlightFabric.';
    if (connection.scope !== 'toolbar-presets' && connection.scope !== 'full-control' && connection.scope !== 'aircraft-control') return 'Preset access is unavailable. Reopen the panel after updating FlightFabric.';
    const sim = connection.simState;
    if (!sim || sim.simconnectConnected !== true) return 'Waiting for the simulator connection.';
    if (sim.inMenu || ['crashed', 'loading', 'shutting_down', 'shutting-down'].includes(sim.lifecycleState)) return 'Presets are unavailable while the simulator is loading or in a menu.';
    if (catalogue.configurationId !== 'generic' && (!snapshot || !snapshot.available || snapshot.sourceStatus !== 'connected'
      || now() - snapshot.receivedAt > 2000 || now() - Date.parse(snapshot.updatedAt) > 2000
      || !Number.isFinite(Date.parse(snapshot.updatedAt)) || Date.parse(snapshot.updatedAt) > now() + 1000)) return 'Waiting for live aircraft data.';
    if (pending) return 'A preset is being applied.';
    const sourceReason = presetSourceUnavailableReason(command, snapshot, catalogue, now());
    if (sourceReason) return sourceReason;
    const observed = presetObservation(command, snapshot, now());
    if (observed && observed.inhibitsRequest) return observed.label;
    if (command.brightnessFields && !brightnessValues(command)) return 'Waiting for live dimmer readings.';
    if (command.input.kind === 'number' && presetNumberValue(command, drafts[command.id]) === null) {
      return 'Enter a value from ' + command.input.min + ' to ' + command.input.max + ' in steps of ' + command.input.step + '.';
    }
    return '';
  }
  function brightnessValues(command) {
    if (!snapshot || !command.brightnessFields || !command.brightnessFields.length) return null;
    const values = command.brightnessFields.map(id => freshAircraftValue(snapshot, id, now()));
    return values.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100) ? values : null;
  }
  function apply(command) {
    if (!enabled || statusReason(command)) return false;
    const requestId = 'toolbar-preset-' + now() + '-' + (++sequence);
    pending = { id: command.id, requestId, context, at: now() };
    delete feedback[command.id];
    refresh();
    const input = command.input.kind === 'number' ? { value: presetNumberValue(command, drafts[command.id]) } : {};
    if (!send({ type: 'executeAircraftCommand', commandId: command.id, input,
      profileKey: catalogue.profileKey, profileRevision: catalogue.profileRevision, requestId })) {
      loseConnection(); refresh(); return false;
    }
    return true;
  }
  function row(command, parent, brightness) {
    const item = node('form', 'preset-row' + (brightness ? ' preset-brightness' : ''));
    item.setAttribute('data-preset', command.id);
    item.appendChild(node('h4', 'preset-label', brightness ? brightnessLabel(command.id) : command.label));
    item.appendChild(node('p', 'preset-description', command.description));
    const observed = node('p', 'preset-observed muted');
    item.appendChild(observed);
    const phrase = command.speech && (command.speech.example || (command.speech.patterns || []).find(value => !value.includes('{value}')));
    if (phrase) item.appendChild(node('p', 'preset-voice muted', 'Say "' + phrase + '"'));
    const actions = node('div', 'preset-actions');
    let input = null, range = null, target = null;
    if (command.input.kind === 'number') {
      if (brightness && drafts[command.id] === undefined) drafts[command.id] = command.id.endsWith('.cockpit') ? '50' : '75';
      if (brightness) {
        target = node('label', 'preset-target');
        target.htmlFor = 'preset-range-' + command.id;
        item.appendChild(target);
        range = node('input', 'preset-range'); range.type = 'range'; range.id = target.htmlFor;
        range.min = command.input.min; range.max = command.input.max; range.step = command.input.step;
        range.value = drafts[command.id] || '0';
        range.setAttribute('aria-label', brightnessLabel(command.id) + ' target percentage');
        range.addEventListener('input', () => { drafts[command.id] = range.value; input.value = range.value; refresh(); });
        item.appendChild(range);
      }
      input = node('input', 'preset-value'); input.type = 'number'; input.inputMode = 'decimal';
      input.min = command.input.min; input.max = command.input.max; input.step = command.input.step;
      input.value = drafts[command.id] || ''; input.placeholder = command.id === 'flightGuidance.course.setBoth' ? '270' : command.id === 'radios.nav.setBothActive' ? '110.30' : String(command.input.min);
      input.setAttribute('aria-label', (brightness ? brightnessLabel(command.id) : command.label) + ' value');
      input.addEventListener('input', () => { drafts[command.id] = input.value; if (range) range.value = input.value; refresh(); });
      actions.appendChild(input);
      const units = { degrees: 'deg', megahertz: 'MHz', percent: '%', feet: 'ft', knots: 'kt' };
      if (units[command.input.units]) actions.appendChild(node('span', 'muted', units[command.input.units]));
    }
    const button = node('button', 'preset-apply'); button.type = 'submit';
    button.setAttribute('aria-label', (brightness ? 'Set ' : 'Apply ') + (brightness ? brightnessLabel(command.id) : command.label));
    actions.appendChild(button); item.appendChild(actions);
    const reason = node('p', 'preset-reason warn'); reason.id = 'preset-reason-' + command.id;
    button.setAttribute('aria-describedby', reason.id); item.appendChild(reason);
    const result = node('p', 'preset-result'); result.setAttribute('role', 'status'); result.setAttribute('aria-live', 'polite'); item.appendChild(result);
    item.addEventListener('submit', event => { event.preventDefault(); apply(command); });
    parent.appendChild(item); rows.push({ command, item, observed, button, input, range, target, reason, result });
  }
  function render() {
    const active = document.activeElement;
    if (active && typeof element.contains === 'function' && element.contains(active) && typeof active.blur === 'function') active.blur();
    clear(element); rows = [];
    const art = node('img', 'preset-watermark'); art.src = '/assets/aircraft-presets.svg'; art.alt = ''; art.setAttribute('aria-hidden', 'true'); element.appendChild(art);
    const heading = node('div', 'preset-heading');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'm12 3 9 5-9 5-9-5 9-5Z M3 12l9 5 9-5M3 16l9 5 9-5'); icon.appendChild(path); heading.appendChild(icon);
    const title = node('div'); title.appendChild(node('h3', '', 'Presets')); title.appendChild(node('p', 'muted', 'Apply a group of settings together.')); heading.appendChild(title); element.appendChild(heading);
    const groups = presetGroups(catalogue.commands);
    groups.cards.forEach(command => row(command, element, false));
    if (groups.lights.length) {
      const lights = node('div', 'preset-group'); lights.appendChild(node('h3', '', 'Exterior lights'));
      lights.appendChild(node('p', 'muted', 'Reviewed light configurations by flight phase.'));
      groups.lights.forEach(command => row(command, lights, false)); element.appendChild(lights);
    }
    groups.brightness.forEach(command => row(command, element, true));
    element.hidden = rows.length === 0;
    refresh();
  }
  function refresh() {
    if (pending && now() - pending.at > 120000) {
      feedback[pending.id] = { text: 'No result received. Check the cockpit before applying again.', tone: 'warn' }; pending = null;
    }
    rows.forEach(({ command, button, input, range, target, reason, result, observed }) => {
      const why = statusReason(command), busy = pending && pending.id === command.id;
      button.disabled = !enabled || Boolean(why);
      button.textContent = busy ? (command.id === 'configuration.apu.start' ? 'Requesting...' : 'Applying...')
        : command.id === 'configuration.apu.start' ? 'Start' : range ? 'Set' : input ? 'Set both' : 'Apply';
      if (input) input.disabled = Boolean(pending);
      if (range) range.disabled = Boolean(pending);
      if (target) target.textContent = 'Target brightness: ' + (presetNumberValue(command, drafts[command.id]) === null ? '--' : drafts[command.id]) + '%';
      reason.textContent = why;
      reason.hidden = !why || (input && !range && !String(drafts[command.id] || '').trim() && why.startsWith('Enter a value'));
      const entry = feedback[command.id];
      result.textContent = entry ? entry.text : ''; result.className = 'preset-result ' + (entry ? entry.tone : ''); result.hidden = !entry;
      let observation = '';
      if (range) {
        const values = brightnessValues(command);
        observation = 'Observed: ' + (!values ? 'Unavailable' : values.every(value => value === values[0]) ? values[0] + '%' : 'Mixed');
      } else if (command.id === 'configuration.apu.start') {
        const value = presetObservation(command, snapshot, now()); observation = value ? value.label : 'APU status unknown';
      }
      observed.textContent = observation; observed.hidden = !observation;
    });
  }
  function schedule() {
    if (tick !== null) clearTimeout(tick);
    tick = enabled && connection.connected && rows.length ? setTimeout(() => { tick = null; refresh(); schedule(); }, 500) : null;
  }
  function update(next) {
    connection = next;
    const nextCatalogue = next.profile && next.profile.controlCapabilities && next.profile.controlCapabilities.aircraftCommands || {};
    const nextContext = contextKey(nextCatalogue);
    if (context !== nextContext) { reset(); context = nextContext; }
    catalogue = nextCatalogue;
    const nextSignature = JSON.stringify(catalogue);
    enabled = next.visible === true;
    if (!next.connected) loseConnection();
    if (next.simState && (next.simState.simconnectConnected !== true || next.simState.inMenu === true)) snapshot = null;
    if (enabled) {
      if (signature !== nextSignature) { signature = nextSignature; render(); } else refresh();
    }
    schedule();
  }
  function receive(message) {
    if (message.type === 'toolbarPresetState' && currentSnapshot(message)) {
      snapshot = Object.assign({}, message, { receivedAt: now(), activeProfileKey: message.profileKey,
        activeProfileRevision: message.profileRevision, sourceStatus: message.sourceStatus && (message.sourceStatus.overall || message.sourceStatus.lvar),
        sourceStatuses: message.sourceStatus && (message.sourceStatus.sources || { lvar: message.sourceStatus.lvar }) });
      if (enabled) refresh();
    }
    if (message.type === 'aircraftCommandResult' && pending && message.requestId === pending.requestId && pending.context === context) {
      const partial = Number(message.completedStepCount) > 0 || message.executionStarted === true;
      const text = message.ok ? message.code === 'sent_unconfirmed' ? 'Request sent. Check the cockpit; the setting is not confirmed.' : 'Preset applied.'
        : partial ? 'Preset stopped after some changes' + (message.failedStepLabel ? ' at ' + message.failedStepLabel : '') + '. Check the cockpit before trying again.'
          : 'Preset could not be applied' + (message.failedStepLabel ? ' at ' + message.failedStepLabel : '') + '. Check aircraft readiness and try again.';
      feedback[pending.id] = { text, tone: message.ok && message.code !== 'sent_unconfirmed' ? 'good' : 'warn' }; pending = null;
      if (enabled) refresh();
    }
  }
  return { element, update, receive, reset: () => { reset(); signature = ''; },
    destroy: () => { enabled = false; loseConnection(); if (tick !== null) clearTimeout(tick); tick = null; } };
}
