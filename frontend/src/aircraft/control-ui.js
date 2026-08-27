export const AIRCRAFT_CONTROL_BUTTON_SELECTOR = [
  '#ctrl-gear-up-btn',
  '#ctrl-gear-down-btn',
  '#ctrl-flaps-dec-btn',
  '#ctrl-flaps-inc-btn',
  '#ctrl-park-brake-release-btn',
  '#ctrl-park-brake-set-btn',
  '#ctrl-spoilers-retract-btn',
  '#ctrl-spoilers-extend-btn',
  '#ctrl-spoilers-disarm-btn',
  '#ctrl-spoilers-arm-btn',
  '#ap-master-btn',
  '#ap-athr-btn',
  '#ap-fd-btn',
  '#ap-flc-btn',
  '#ap-loc-btn',
  '#ap-app-btn',
  '.ap-engage-btn',
  '.ap-adj-btn',
].join(',');

const CONTROL_CANONICAL_COMMAND_IDS = Object.freeze({
  gearUp: 'surfaces.gear.set',
  gearDown: 'surfaces.gear.set',
  flapsDecrease: 'surfaces.flaps.adjust',
  flapsIncrease: 'surfaces.flaps.adjust',
  parkingBrakeRelease: 'surfaces.parkingBrake.set',
  parkingBrakeSet: 'surfaces.parkingBrake.set',
  spoilersRetract: 'surfaces.spoilers.set',
  spoilersExtend: 'surfaces.spoilers.set',
  spoilersDisarm: 'surfaces.spoilersArmed.set',
  spoilersArm: 'surfaces.spoilersArmed.set',
  autopilotMasterToggle: 'flightGuidance.autopilot.toggle',
  autothrottleToggle: 'flightGuidance.autothrottle.toggle',
  flightDirectorToggle: 'flightGuidance.flightDirector.toggle',
  flcToggle: 'flightGuidance.flightLevelChange.set',
  locToggle: 'flightGuidance.localizer.set',
  appToggle: 'flightGuidance.approach.set',
});

const SELECTOR_CANONICAL_COMMAND_IDS = Object.freeze({
  spd: 'flightGuidance.speed.set',
  hdg: 'flightGuidance.heading.set',
  alt: 'flightGuidance.altitude.set',
  vs: 'flightGuidance.verticalSpeed.set',
});

const SELECTOR_HOLD_CANONICAL_COMMAND_IDS = Object.freeze({
  spd: 'flightGuidance.speedHold.set',
  hdg: 'flightGuidance.headingHold.set',
  alt: 'flightGuidance.altitudeHold.set',
  vs: 'flightGuidance.verticalSpeedHold.set',
});

const AUTOPILOT_PULSE_CANONICAL_COMMAND_IDS = Object.freeze({
  autothrottle: 'flightGuidance.autothrottle.toggle',
  verticalSpeedHold: 'flightGuidance.verticalSpeedHold.toggle',
  altitudeHold: 'flightGuidance.altitudeHold.toggle',
  machHold: 'flightGuidance.machHold.toggle',
  headingHold: 'flightGuidance.headingHold.toggle',
  flightDirector: 'flightGuidance.flightDirector.toggle',
  apMaster: 'flightGuidance.autopilot.toggle',
  apDisconnect: 'flightGuidance.autopilot.set',
  app: 'flightGuidance.approach.toggle',
  loc: 'flightGuidance.localizer.toggle',
  nav1: 'flightGuidance.nav1.toggle',
  ins: 'flightGuidance.ins.toggle',
  backcourse: 'flightGuidance.backcourse.toggle',
});

const CANONICAL_COMMAND_ID_RE = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;

/**
 * Resolve the semantic Aircraft-page command to the canonical backend command
 * used for execution. This lets UI availability and voice availability use the
 * same active catalogue while retaining legacy capability snapshots as an
 * upgrade fallback for older backends.
 */
export function getAircraftControlCanonicalCommandId(commandOrKey) {
  if (!commandOrKey) return '';
  if (typeof commandOrKey === 'string') {
    const value = commandOrKey.trim();
    if (CANONICAL_COMMAND_ID_RE.test(value)) return value;
    if (value.startsWith('control:')) {
      return CONTROL_CANONICAL_COMMAND_IDS[value.slice('control:'.length)] || '';
    }
    if (value.startsWith('selector-hold:')) {
      return SELECTOR_HOLD_CANONICAL_COMMAND_IDS[value.slice('selector-hold:'.length)] || '';
    }
    if (value.startsWith('selector-adjust:') || value.startsWith('selector-set:')) {
      return SELECTOR_CANONICAL_COMMAND_IDS[value.split(':')[1]] || '';
    }
    if (value.startsWith('autopilot-pulse:')) {
      return AUTOPILOT_PULSE_CANONICAL_COMMAND_IDS[value.slice('autopilot-pulse:'.length)] || '';
    }
    if (value.startsWith('light-set:')) {
      const light = value.slice('light-set:'.length);
      return /^[a-z][A-Za-z0-9]*$/.test(light) ? `lights.${light}.set` : '';
    }
    return '';
  }

  if (commandOrKey.type === 'canonical') {
    const commandId = typeof commandOrKey.commandId === 'string' ? commandOrKey.commandId.trim() : '';
    return CANONICAL_COMMAND_ID_RE.test(commandId) ? commandId : '';
  }
  if (commandOrKey.type === 'control') {
    return CONTROL_CANONICAL_COMMAND_IDS[commandOrKey.id] || '';
  }
  if (commandOrKey.type === 'selector-hold') {
    return SELECTOR_HOLD_CANONICAL_COMMAND_IDS[commandOrKey.mode] || '';
  }
  if (commandOrKey.type === 'selector-adjust' || commandOrKey.type === 'selector-set') {
    return SELECTOR_CANONICAL_COMMAND_IDS[commandOrKey.mode] || '';
  }
  if (commandOrKey.type === 'autopilot-pulse') {
    return AUTOPILOT_PULSE_CANONICAL_COMMAND_IDS[commandOrKey.id] || '';
  }
  if (commandOrKey.type === 'light-set') {
    const light = typeof commandOrKey.light === 'string' ? commandOrKey.light.trim() : '';
    return /^[a-z][A-Za-z0-9]*$/.test(light) ? `lights.${light}.set` : '';
  }
  return '';
}

export function describeAircraftControlAction(action) {
  if (!action || typeof action !== 'object') return '';
  const name = typeof action.name === 'string' ? action.name.trim() : '';
  switch (action.type) {
    case 'key-event':
      return name ? `K:${name}` : 'K:event';
    case 'input-event':
      return name ? `B:${name}` : 'B:event';
    case 'html-event':
      return name ? `H:${name}` : 'H:event';
    case 'lvar':
      return name ? `L:${name}` : 'L:var';
    case 'simvar':
      return name ? `A:${name}` : 'A:var';
    default:
      return action.type || 'action';
  }
}

export function describeAircraftControlRequest(request) {
  if (!request || typeof request !== 'object') return 'Aircraft control request';

  if (request.control === 'gear') {
    return request.operation === 'down' ? 'Gear down'
      : request.operation === 'up' ? 'Gear up'
      : 'Gear toggle';
  }

  if (request.control === 'flaps') {
    return request.operation === 'increment' ? 'Flaps more'
      : request.operation === 'decrement' ? 'Flaps less'
      : `Set flaps ${request.value}`;
  }

  if (request.control === 'parkingBrake') {
    return request.value ? 'Parking brake set' : 'Parking brake release';
  }

  if (request.control === 'spoilers') {
    if (request.operation === 'arm') return 'Ground spoilers arm';
    if (request.operation === 'disarm') return 'Ground spoilers disarm';
    if (request.operation === 'set') return Number(request.value) > 0 ? 'Spoilers extend' : 'Spoilers retract';
  }

  if (request.control === 'lights') {
    const lightLabels = {
      nav: 'Navigation lights',
      beacon: 'Beacon',
      strobe: 'Strobe lights',
      landing: 'Landing lights',
      taxi: 'Taxi lights',
    };
    const label = lightLabels[request.target] || 'Exterior lights';
    return `${label} ${request.value ? 'on' : 'off'}`;
  }

  if (request.control === 'aircraft-specific') {
    const actionId = typeof request.actionId === 'string' && request.actionId.trim()
      ? request.actionId.trim()
      : String(request.target || 'action');
    return `Aircraft action ${actionId}`;
  }

  if (request.control !== 'autopilot') {
    return `${String(request.control || 'Aircraft control')} ${String(request.operation || '').trim()}`.trim();
  }

  const targetLabels = {
    master: 'AP master',
    autothrottle: 'A/T',
    flightDirector: 'Flight director',
    flightLevelChange: 'FLC',
    speedHold: 'Speed hold',
    headingHold: 'Heading hold',
    altitudeHold: 'Altitude hold',
    verticalSpeedHold: 'V/S hold',
    machHold: 'Mach hold',
    loc: 'LOC',
    app: 'APP',
    nav1: 'VOR/NAV 1',
    ins: 'INS',
    backcourse: 'Back course',
    speed: 'Selected speed',
    heading: 'Selected heading',
    altitude: 'Selected altitude',
    verticalSpeed: 'Selected V/S',
  };

  const label = targetLabels[request.target] || String(request.target || 'Autopilot');
  if (request.operation === 'toggle') return `${label} toggle`;
  if (request.operation === 'set' && request.value != null) {
    if (['speed', 'heading', 'altitude', 'verticalSpeed'].includes(request.target)) {
      return `${label} ${request.value}`;
    }
    return `${label} ${request.value ? 'on' : 'off'}`;
  }
  return label;
}

export function describeAircraftCommandRequest(request, descriptor = null) {
  if (!request || typeof request !== 'object') return 'Aircraft command';
  const label = typeof descriptor?.label === 'string' && descriptor.label.trim()
    ? descriptor.label.trim()
    : (typeof request.commandId === 'string' && request.commandId.trim()
        ? request.commandId.trim()
        : 'Aircraft command');
  if (!request.input || !Object.prototype.hasOwnProperty.call(request.input, 'value')) return label;
  const value = request.input.value;
  if (typeof value === 'boolean') return `${label} ${value ? 'on' : 'off'}`;
  return `${label} ${value}`;
}

export function getAircraftControlCommandPendingKey(command) {
  if (!command || typeof command !== 'object') return '';

  if (command.type === 'canonical') {
    const commandId = typeof command.commandId === 'string' ? command.commandId.trim() : '';
    return CANONICAL_COMMAND_ID_RE.test(commandId) ? `aircraft-command:${commandId}` : '';
  }

  if (command.type === 'control') {
    return typeof command.id === 'string' && command.id.trim()
      ? `control:${command.id.trim()}`
      : '';
  }

  if (command.type === 'selector-hold') {
    return typeof command.mode === 'string' && command.mode.trim()
      ? `selector-hold:${command.mode.trim()}`
      : '';
  }

  if (command.type === 'selector-adjust') {
    const mode = typeof command.mode === 'string' ? command.mode.trim() : '';
    const action = typeof command.action === 'string' ? command.action.trim() : '';
    if (!mode || !action) return '';
    return `selector-adjust:${mode}:${action}`;
  }

  if (command.type === 'selector-set') {
    const mode = typeof command.mode === 'string' ? command.mode.trim() : '';
    return mode ? `selector-set:${mode}` : '';
  }

  if (command.type === 'autopilot-pulse') {
    const commandId = typeof command.id === 'string' ? command.id.trim() : '';
    if (!commandId) return '';
    return commandId === 'apMaster' || commandId === 'apDisconnect'
      ? 'autopilot-pulse:ap-physical-control'
      : `autopilot-pulse:${commandId}`;
  }

  if (command.type === 'light-set') {
    const light = typeof command.light === 'string' ? command.light.trim() : '';
    return light ? `light-set:${light}` : '';
  }

  return '';
}

export function getAircraftControlRequestPendingKey(request) {
  if (!request || typeof request !== 'object') return '';

  const control = typeof request.control === 'string' ? request.control.trim() : '';
  const target = typeof request.actionId === 'string' && request.actionId.trim()
    ? request.actionId.trim()
    : (typeof request.target === 'string' ? request.target.trim() : '');
  const operation = typeof request.operation === 'string' ? request.operation.trim() : '';

  return [control || 'control', target || 'target', operation || 'operation']
    .join(':');
}
