const NAMED_KEYS = Object.freeze({
  backspace: 'Backspace',
  tab: 'Tab',
  enter: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  ' ': 'Space',
  spacebar: 'Space',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  end: 'End',
  home: 'Home',
  arrowleft: 'Left',
  arrowup: 'Up',
  arrowright: 'Right',
  arrowdown: 'Down',
  insert: 'Insert',
  delete: 'Delete',
  del: 'Delete',
});

const MODIFIER_KEYS = new Set([
  'alt',
  'altgraph',
  'control',
  'meta',
  'os',
  'shift',
]);

function triggerKey(event) {
  const rawKey = String(event?.key || '');
  const key = rawKey.toLowerCase();
  if (!key || MODIFIER_KEYS.has(key)) return '';
  if (event?.location === 3 && event?.code !== 'NumpadEnter') return null;
  const topRowDigit = /^Digit([0-9])$/u.exec(String(event?.code || ''));
  if (topRowDigit) return topRowDigit[1];
  if (NAMED_KEYS[key]) return NAMED_KEYS[key];
  if (/^[a-z]$/i.test(rawKey)) return rawKey.toUpperCase();
  if (/^[0-9]$/.test(rawKey)) return rawKey;
  if (/^f(?:[1-9]|1[0-2])$/i.test(rawKey)) return rawKey.toUpperCase();
  return null;
}

export function shortcutFromKeyboardEvent(event) {
  const key = triggerKey(event);
  if (key === '') return { accelerator: '', reason: 'waiting-for-key' };

  const modifiers = [];
  if (event?.ctrlKey) modifiers.push('Control');
  if (event?.altKey) modifiers.push('Alt');
  if (event?.shiftKey) modifiers.push('Shift');
  if (event?.metaKey) modifiers.push('Super');

  if (modifiers.length === 0) return { accelerator: '', reason: 'modifier-required' };
  if (key === null) return { accelerator: '', reason: 'unsupported-key' };
  return { accelerator: [...modifiers, key].join('+'), reason: '' };
}
