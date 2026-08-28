const ENUM_INPUT_BY_ACTION = Object.freeze({
  'controls.gear.up': 'up',
  'controls.gear.down': 'down',
});

const BOOLEAN_INPUT_BY_ACTION = Object.freeze({
  'controls.speedbrake.stowed': false,
  'controls.speedbrake.armed': true,
});

export function buildPmdg777CommandInput(control, action) {
  if (Object.prototype.hasOwnProperty.call(action || {}, 'commandInput')) {
    return { value: action.commandInput };
  }

  if (control?.groupId === 'controls.gear') {
    return { value: ENUM_INPUT_BY_ACTION[action?.id] };
  }
  if (control?.groupId === 'controls.flaps') {
    return { value: action?.value === 'UP' ? 'up' : String(action?.value) };
  }
  if (control?.groupId === 'controls.speedbrake') {
    return { value: BOOLEAN_INPUT_BY_ACTION[action?.id] };
  }
  return { value: action?.value };
}
