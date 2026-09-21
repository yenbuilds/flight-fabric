'use strict';

const DEFAULT_PUSH_TO_TALK_SHORTCUT = '';
const MODIFIER_ALIASES = Object.freeze({
  alt: 'Alt', cmdorctrl: 'CommandOrControl', commandorcontrol: 'CommandOrControl',
  control: 'Control', ctrl: 'Control', shift: 'Shift', super: 'Super', win: 'Super', windows: 'Super',
});
const MODIFIER_ORDER = Object.freeze(['CommandOrControl', 'Control', 'Alt', 'Shift', 'Super']);
const KEY_ALIASES = Object.freeze({
  backspace: 'Backspace', del: 'Delete', delete: 'Delete', down: 'Down', end: 'End', enter: 'Enter',
  esc: 'Escape', escape: 'Escape', home: 'Home', insert: 'Insert', left: 'Left', pagedown: 'PageDown',
  pageup: 'PageUp', right: 'Right', space: 'Space', spacebar: 'Space', tab: 'Tab', up: 'Up',
});
// Mirrors the bounds the native helper enforces on its --joystick arguments.
const JOYSTICK_ID_RE = /^[0-9A-F]{4}$/u;
const MAX_JOYSTICK_BUTTON = 512;
const MAX_JOYSTICK_NAME_CHARS = 64;
const MAX_JOYSTICK_PATH_CHARS = 260;

function normalizePushToTalkShortcut(value) {
  if (typeof value !== 'string') throw new TypeError('Shortcut must be text.');
  const parts = value.trim().split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 5) throw new TypeError('Use one or more modifiers and one key.');
  const modifiers = new Set();
  let key = null;
  for (const part of parts) {
    const token = part.toLowerCase().replace(/[\s_-]+/g, '');
    const modifier = MODIFIER_ALIASES[token];
    if (modifier) {
      if (modifiers.has(modifier)) throw new TypeError('Shortcut repeats a modifier.');
      modifiers.add(modifier);
      continue;
    }
    if (key !== null) throw new TypeError('Shortcut must contain exactly one non-modifier key.');
    key = KEY_ALIASES[token]
      || (/^[a-z]$/i.test(part) ? part.toUpperCase() : null)
      || (/^[0-9]$/.test(part) ? part : null)
      || (/^f(?:[1-9]|1[0-2])$/i.test(part) ? part.toUpperCase() : null);
    if (!key) throw new TypeError('Shortcut key is not supported.');
  }
  if (modifiers.size === 0 || !key) throw new TypeError('Shortcut needs a modifier and one key.');
  if (modifiers.has('CommandOrControl') && modifiers.has('Control')) {
    throw new TypeError('Use either Control or CommandOrControl, not both.');
  }
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join('+');
}

function joystickText(value, maxChars) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new TypeError('Joystick binding text fields must be text.');
  // Product strings come from the USB device and paths from Windows: keep
  // them printable and bounded before they reach settings, arguments or UI.
  const cleaned = value.replace(/\p{Cc}/gu, '').trim();
  if (cleaned.length > maxChars) throw new TypeError('Joystick binding text is too long.');
  return cleaned;
}

// A joystick push-to-talk binding: null when unbound, otherwise the vendor and
// product ids the helper matches on, the HID button usage (1-based, as Windows
// shows it), the product name for display and the device path that picks one
// of two identical sticks.
function normalizePushToTalkJoystick(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Joystick binding must be an object.');
  const vendorId = String(value.vendorId || '').toUpperCase();
  const productId = String(value.productId || '').toUpperCase();
  if (!JOYSTICK_ID_RE.test(vendorId) || !JOYSTICK_ID_RE.test(productId)) {
    throw new TypeError('Joystick binding needs four-digit hex vendor and product ids.');
  }
  const button = Number(value.button);
  if (!Number.isSafeInteger(button) || button < 1 || button > MAX_JOYSTICK_BUTTON) {
    throw new TypeError(`Joystick button must be a number from 1 to ${MAX_JOYSTICK_BUTTON}.`);
  }
  const name = joystickText(value.name, MAX_JOYSTICK_NAME_CHARS);
  const path = joystickText(value.path, MAX_JOYSTICK_PATH_CHARS);
  if (/["']/u.test(path)) throw new TypeError('Joystick device path is not usable.');
  return Object.freeze({ vendorId, productId, button, name, path });
}

function pushToTalkHelperArguments({ accelerator = '', joystick = null } = {}) {
  const args = [];
  if (accelerator) args.push('--shortcut', accelerator);
  if (joystick) {
    args.push('--joystick', `${joystick.vendorId}:${joystick.productId}`, '--button', String(joystick.button));
    if (joystick.path) args.push('--device-path', joystick.path);
  }
  return args;
}

module.exports = {
  DEFAULT_PUSH_TO_TALK_SHORTCUT,
  normalizePushToTalkJoystick,
  normalizePushToTalkShortcut,
  pushToTalkHelperArguments,
};
