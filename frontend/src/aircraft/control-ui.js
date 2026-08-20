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

export function getAircraftControlCommandPendingKey(command) {
  if (!command || typeof command !== 'object') return '';

  if (command.type === 'preset') {
    return typeof command.id === 'string' && command.id.trim()
      ? `preset:${command.id.trim()}`
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
