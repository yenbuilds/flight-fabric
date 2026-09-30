/* Shared client/Coherent GT replay view. ES2017, textContent for all data. */
(function (root) {
  'use strict';
  function createReplayPanel(options) {
    var doc = options.document;
    var state = { state: 'idle', session: '', durationMs: 0, positionMs: 0 };
    var connected = false;
    var authorized = false;
    var selection = null;
    var pending = false;
    var timer = null;
    var element = node('section', 'ff-replay-panel');
    element.setAttribute('aria-label', 'In-simulator replay');
    var heading = node('h2', '', 'Replay in MSFS');
    var badge = node('span', 'ff-replay-badge', 'Experimental');
    heading.appendChild(badge); element.appendChild(heading);
    var description = node('p', 'ff-replay-muted'); element.appendChild(description);
    var selectBox = node('details', 'ff-replay-selection');
    selectBox.appendChild(node('summary', '', 'Choose another landing'));
    var selected = node('p'); selectBox.appendChild(selected);
    var landingLabel = node('label', 'ff-replay-field', 'Landing number in this recording');
    var landing = node('input'); landing.type = 'number'; landing.min = '1'; landing.step = '1'; landing.value = '1';
    landingLabel.appendChild(landing); selectBox.appendChild(landingLabel);
    var prepare = button('Prepare landing replay', function () {
      send('prepare', { filePath: selection && selection.filePath, landingIndex: Number(landing.value) - 1 });
    });
    selectBox.appendChild(prepare); element.appendChild(selectBox);
    var title = node('p', 'ff-replay-aircraft'); element.appendChild(title);
    var loaded = node('p', 'ff-replay-muted'); element.appendChild(loaded);
    var instructions = node('details', 'ff-replay-help'); instructions.open = false;
    instructions.appendChild(node('summary', '', 'How to set up your aircraft'));
    var steps = node('ol');
    [
      'Finish your flight. If FlightFabric is still recording, open the recording indicator at the top of the client, select End Flight Manually and wait for saving to finish. Select the saved flight in Logbook, then prepare its landing replay. Only PMDG 737 and Fenix A320 recordings are eligible for this first version.',
      'In MSFS 2024, select the exact recorded aircraft shown here: the same developer, model, engine and winglet variant. A different 737 or A320 may not match. Use the original livery if you know it; livery is not separately recorded. FlightFabric checks the aircraft title before allowing Start.',
      'Load a new Free Flight at a parking stand, preferably at the recorded arrival airport with the same scenery. Choose a parked, engines-off starting state, set the parking brake and wait for the aircraft to finish loading. You do not need to fly back to the approach; replay places the aircraft there.',
      'Set simulator speed to normal (1×). Turn off pause, Active Pause and slew, close simulator menus, and keep all engines off. Close other FlightFabric instances and companion apps that use its simulator helper.',
      'Confirm the two setup items, then select Check aircraft. FlightFabric suspends live recording and aircraft controls. When the aircraft check passes, select Start replay, then Play. Use the simulator’s External or Drone camera controls to frame your view.',
      'To finish, select Stop / Return. Return to the MSFS main menu and load a new flight with the same aircraft parked and engines off. Keep FlightFabric open until it confirms recovery is complete. Stop does not restore the previous flight, and you cannot continue flying from a replay frame.'
    ].forEach(function (text) { steps.appendChild(node('li', '', text)); });
    instructions.appendChild(steps);
    instructions.appendChild(node('p', 'ff-replay-muted', 'This first version replays position and attitude at 1×. It does not restore cockpit switches, FMS, fuel, engines, weather, or gear/flap/spoiler animations. Pause holds replay movement while allowing camera movement.'));
    element.appendChild(instructions);
    var confirmations = node('div', 'ff-replay-confirmations');
    var rate = checkbox('I know this recording was flown at normal 1× simulator speed.');
    var reload = checkbox('I understand that finishing replay requires reloading a parked flight.');
    confirmations.appendChild(rate.label); confirmations.appendChild(reload.label);
    element.appendChild(confirmations);
    var status = node('p', 'ff-replay-status'); status.setAttribute('role', 'status'); element.appendChild(status);
    var error = node('p', 'ff-replay-error'); error.setAttribute('role', 'alert'); element.appendChild(error);
    var actions = node('div', 'ff-replay-actions');
    var check = button('Check aircraft', function () { send('connect', { recordedAt1x: rate.input.checked, acceptReload: reload.input.checked }); });
    var start = button('Start replay', function () { send('start'); });
    var play = button('Play', function () { send(state.state === 'playing' ? 'pause' : 'play'); });
    var restart = button('Restart', function () { send('seek', { positionMs: 0 }); });
    var stop = button('Stop / Return', function () { send('stop'); });
    stop.className += ' ff-replay-stop';
    var recover = button('Reconnect recovery / Retry', function () { send('recover'); });
    var dismiss = button('Close replay', function () { send('dismiss'); });
    [check, start, play, restart, stop, recover, dismiss].forEach(function (item) { actions.appendChild(item); });
    element.appendChild(actions);
    var scrubLabel = node('label', 'ff-replay-field', 'Replay position');
    var scrub = node('input'); scrub.type = 'range'; scrub.min = '0'; scrub.step = '100'; scrub.value = '0';
    scrub.setAttribute('aria-label', 'In-simulator replay position');
    scrub.addEventListener('change', function () { send('seek', { positionMs: Number(scrub.value) }); });
    var time = node('span', 'ff-replay-time'); scrubLabel.appendChild(scrub); scrubLabel.appendChild(time); element.appendChild(scrubLabel);
    var recovery = node('p', 'ff-replay-recovery', 'Recovery: return to the MSFS main menu and reload the same aircraft at a parking stand with engines off, unpaused at 1×. Keep FlightFabric open and wait for confirmation. Do not take control of an airborne replay frame.');
    element.appendChild(recovery);
    element.appendChild(instructions);
    rate.input.addEventListener('change', render); reload.input.addEventListener('change', render);
    function node(tag, className, text) {
      var result = doc.createElement(tag);
      if (className) result.className = className;
      if (text) result.textContent = text;
      return result;
    }
    function button(text, action) {
      var result = node('button', 'ff-replay-button', text); result.type = 'button'; result.addEventListener('click', action); return result;
    }
    function checkbox(text) {
      var label = node('label', 'ff-replay-check'); var input = node('input'); input.type = 'checkbox';
      label.appendChild(input); label.appendChild(node('span', '', text)); return { label: label, input: input };
    }
    function format(ms) { var seconds = Math.floor((Number(ms) || 0) / 1000); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); }
    function send(operation, extra) {
      if (!connected || !authorized || (pending && operation !== 'stop' && operation !== 'status')) return;
      if (state.enabled !== true && ['status', 'recover', 'stop', 'dismiss'].indexOf(operation) < 0) return;
      var message = Object.assign({ type: 'inSimReplay', operation: operation, session: state.session }, extra || {});
      if (options.send(message) === false) { error.textContent = 'Connection unavailable. Reconnect to FlightFabric before using replay.'; return; }
      if (operation !== 'status') {
        pending = true; error.textContent = ''; render();
        clearTimeout(timer); timer = setTimeout(function () {
          pending = false; error.textContent = 'No reply from FlightFabric. Reconnect and check replay status before continuing.'; render();
        }, 10000);
      }
    }
    function render() {
      var stage = state.state;
      var enabled = state.enabled === true;
      var active = enabled && (stage === 'playing' || stage === 'paused');
      var recovering = stage === 'recovery' || stage === 'restoring' || stage === 'recoveryRequired';
      var unavailable = !connected || !authorized || pending || state.pending === true;
      description.textContent = enabled
        ? 'Watch your recorded landing using the actual aircraft and cameras in MSFS 2024. Live simulator validation is still in progress.'
        : 'Finish recovery from the previous replay before returning to normal FlightFabric operation.';
      badge.hidden = !enabled;
      instructions.hidden = !enabled;
      selectBox.hidden = !enabled || options.toolbar === true || state.blocked === true;
      selected.textContent = selection ? 'Selected flight: ' + selection.label : 'Select a saved flight in the client’s Logbook to prepare replay.';
      prepare.disabled = !enabled || unavailable || !selection;
      landing.disabled = prepare.disabled;
      title.textContent = state.title ? 'Aircraft to load: ' + state.title : 'No landing prepared yet.';
      loaded.textContent = state.loadedTitle ? 'Loaded in MSFS: ' + state.loadedTitle : '';
      confirmations.hidden = !enabled || options.toolbar === true || stage !== 'prepared';
      check.hidden = !enabled || options.toolbar === true || stage !== 'prepared';
      check.disabled = unavailable || !rate.input.checked || !reload.input.checked;
      start.hidden = !enabled || stage !== 'ready'; start.disabled = !enabled || unavailable || state.readyToStart !== true;
      play.hidden = !active; play.disabled = unavailable; play.textContent = stage === 'playing' ? 'Pause' : 'Play';
      restart.hidden = !active; restart.disabled = unavailable;
      stop.hidden = ['connecting', 'ready', 'arming', 'playing', 'paused', 'recovery', 'restoring'].indexOf(stage) < 0;
      stop.disabled = !connected || !authorized || stage === 'connecting' || recovering;
      recover.hidden = stage !== 'recoveryRequired'; recover.disabled = unavailable;
      dismiss.hidden = options.toolbar === true || state.blocked === true || ['idle', 'done', 'prepared'].indexOf(stage) < 0;
      dismiss.disabled = unavailable;
      scrubLabel.hidden = !state.durationMs || !state.blocked; scrub.max = String(state.durationMs || 0); scrub.disabled = unavailable || !active;
      if (doc.activeElement !== scrub) scrub.value = String(state.positionMs || 0);
      scrub.setAttribute('aria-valuetext', format(state.positionMs) + ' of ' + format(state.durationMs));
      time.textContent = format(state.positionMs) + ' / ' + format(state.durationMs) + ' · Touchdown ' + format(state.touchdownMs);
      recovery.hidden = !recovering;
      status.textContent = !connected ? 'Disconnected from FlightFabric. Replay status is unknown; reconnect to regain controls.'
        : !authorized ? 'Connect through the FlightFabric client or simulator toolbar to control replay.'
        : pending || state.pending ? 'Waiting for replay…'
        : state.detail || ({ playing: 'Playing in MSFS at 1×.', paused: 'Replay paused. Camera controls remain available.',
          arming: 'Holding the aircraft at the start of the clip. Wait for confirmation.',
          recovery: 'Replay stopped. Reload a parked flight to return to normal operation.',
          restoring: 'Checking the reloaded aircraft. Keep FlightFabric open and wait.',
          recoveryRequired: 'Recovery needs attention. Reconnect recovery, then follow the reload instructions.',
          ready: 'Checking the aircraft. Follow the setup instructions.', done: 'Replay ended. Live FlightFabric connection restored.' }[stage])
          || (options.toolbar && !state.title ? 'Prepare a saved landing in the FlightFabric client’s Logbook. Its controls will appear here.' : 'Prepare a saved landing to begin.');
    }
    var watchdog = null;
    render();
    return {
      element: element,
      update: function (value) {
        if (typeof value.connected === 'boolean') { connected = value.connected; if (!connected) { pending = false; state.readyToStart = false; } }
        if (typeof value.authorized === 'boolean') authorized = value.authorized;
        if (Object.prototype.hasOwnProperty.call(value, 'selection')) {
          if (!selection || !value.selection || selection.filePath !== value.selection.filePath) landing.value = '1';
          selection = value.selection;
        }
        render();
      },
      receive: function (message) {
        if (!message || message.type !== 'inSimReplayState') return;
        if (message.session !== state.session) { rate.input.checked = false; reload.input.checked = false; instructions.open = message.state === 'prepared'; }
        if (['paused', 'playing'].indexOf(message.state) >= 0 && ['paused', 'playing'].indexOf(state.state) < 0) instructions.open = false;
        state = message; pending = false; clearTimeout(timer);
        clearTimeout(watchdog);
        if (state.blocked) watchdog = setTimeout(function () {
          state.readyToStart = false; state.pending = true; render(); send('status');
        }, 6000);
        error.textContent = message.error || ''; render();
        if (options.onState) options.onState(state);
      },
      destroy: function () { clearTimeout(timer); clearTimeout(watchdog); }
    };
  }
  root.FlightFabricReplayPanel = { createReplayPanel: createReplayPanel };
})(typeof window !== 'undefined' ? window : globalThis);
