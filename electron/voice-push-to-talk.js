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

module.exports = { DEFAULT_PUSH_TO_TALK_SHORTCUT, normalizePushToTalkShortcut };
