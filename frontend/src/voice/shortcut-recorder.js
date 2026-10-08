const NAMED_KEYS = Object.freeze({
  backspace: 'Backspace',
  capslock: 'CapsLock',
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

const MODIFIER_CODES = Object.freeze({
  ControlLeft: { accelerator: 'LeftControl', kind: 'ctrl' },
  ControlRight: { accelerator: 'RightControl', kind: 'ctrl' },
  AltLeft: { accelerator: 'LeftAlt', kind: 'alt' },
  AltRight: { accelerator: 'RightAlt', kind: 'alt' },
  ShiftLeft: { accelerator: 'LeftShift', kind: 'shift' },
  ShiftRight: { accelerator: 'RightShift', kind: 'shift' },
  MetaLeft: { accelerator: 'LeftSuper', kind: 'meta' },
  MetaRight: { accelerator: 'RightSuper', kind: 'meta' },
});

export const SINGLE_MODIFIER_SHORTCUTS = Object.freeze(Object.values(MODIFIER_CODES)
  .map(({ accelerator }) => accelerator));

function modifierFromKeyboardEvent(event) {
  const key = String(event?.key || '').toLowerCase();
  if (!MODIFIER_KEYS.has(key)) return null;
  const family = { control: 'Control', alt: 'Alt', altgraph: 'Alt', shift: 'Shift', meta: 'Meta', os: 'Meta' }[key];
  const code = event.code || (event.location === 1 ? `${family}Left` : event.location === 2 ? `${family}Right` : '');
  if (!code.startsWith(family)) return null;
  const modifier = MODIFIER_CODES[code];
  if (!modifier) return null;
  // Windows layouts may represent Right Alt (AltGr) with a synthetic Ctrl.
  const altGraph = code === 'AltRight' && (key === 'altgraph' || event.getModifierState?.('AltGraph') === true);
  return { ...modifier, altGraph };
}

function otherModifiersHeld(event, modifier, released = false) {
  return ['ctrl', 'alt', 'shift', 'meta'].some(kind => event?.[`${kind}Key`]
    && (released || kind !== modifier.kind)
    && !(modifier.altGraph && kind === 'ctrl'));
}

// Defer a modifier-only binding until release, so the same keydown can still
// become a combination. Each recording attempt owns just one pending candidate.
export function createShortcutRecorder() {
  let pendingModifier = null;
  const waiting = () => ({ accelerator: '', reason: 'waiting-for-key' });
  return {
    reset() { pendingModifier = null; },
    keyDown(event) {
      if (event?.isComposing) { pendingModifier = null; return waiting(); }
      if (event?.repeat) return waiting();
      const modifier = modifierFromKeyboardEvent(event);
      pendingModifier = modifier && !otherModifiersHeld(event, modifier) ? modifier : null;
      return shortcutFromKeyboardEvent(event);
    },
    keyUp(event) {
      const pending = pendingModifier;
      pendingModifier = null;
      const released = modifierFromKeyboardEvent(event);
      if (!event?.isComposing && pending && released?.accelerator === pending.accelerator
        && !otherModifiersHeld(event, pending, true)) {
        return { accelerator: pending.accelerator, reason: '' };
      }
      return waiting();
    },
  };
}

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

  if (key === null) return { accelerator: '', reason: 'unsupported-key' };
  return { accelerator: [...modifiers, key].join('+'), reason: '' };
}
