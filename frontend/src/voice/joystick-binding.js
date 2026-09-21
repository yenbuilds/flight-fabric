const MAX_NAME_CHARS = 64;
const MAX_PATH_CHARS = 260;

// One joystick push-to-talk binding as the desktop runtime reports it, with
// every field bounded before it reaches a store. Returns null for anything
// that is not a usable binding.
export function joystickBindingFromRuntime(value) {
  if (!value || typeof value !== 'object') return null;
  const button = Number(value.button);
  const vendorId = String(value.vendorId || '').trim().toUpperCase().slice(0, 4);
  const productId = String(value.productId || '').trim().toUpperCase().slice(0, 4);
  if (!Number.isSafeInteger(button) || button < 1 || vendorId.length !== 4 || productId.length !== 4) return null;
  return {
    vendorId,
    productId,
    button,
    name: String(value.name || '').trim().slice(0, MAX_NAME_CHARS),
    path: String(value.path || '').trim().slice(0, MAX_PATH_CHARS),
  };
}

// "T.16000M button 5": the stick's product name and the button number as
// Windows shows it in its game controller settings.
export function describeJoystickBinding(binding) {
  const normalized = joystickBindingFromRuntime(binding);
  if (!normalized) return '';
  return `${normalized.name || 'Joystick'} button ${normalized.button}`;
}
