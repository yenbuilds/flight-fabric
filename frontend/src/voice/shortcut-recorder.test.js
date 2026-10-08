import test from 'node:test';
import assert from 'node:assert/strict';
import { createShortcutRecorder, shortcutFromKeyboardEvent } from './shortcut-recorder.js';

test('shortcut recorder emits the native push-to-talk accelerator format', () => {
  assert.deepEqual(shortcutFromKeyboardEvent({
    key: 'm', code: 'KeyM', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false,
  }), { accelerator: 'Control+Shift+M', reason: '' });
  assert.deepEqual(shortcutFromKeyboardEvent({
    key: ' ', code: 'Space', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false,
  }), { accelerator: 'Alt+Space', reason: '' });
  assert.deepEqual(shortcutFromKeyboardEvent({
    key: 'ArrowDown', code: 'ArrowDown', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false,
  }), { accelerator: 'Control+Alt+Down', reason: '' });
  assert.deepEqual(shortcutFromKeyboardEvent({
    key: '!', code: 'Digit1', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false,
  }), { accelerator: 'Control+Shift+1', reason: '' });
});

test('shortcut recorder accepts single keys and still waits on modifiers for combinations', () => {
  for (const key of ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph']) {
    assert.deepEqual(shortcutFromKeyboardEvent({ key }), { accelerator: '', reason: 'waiting-for-key' });
  }
  for (const [key, expected] of [['m', 'M'], [' ', 'Space'], ['CapsLock', 'CapsLock'], ['F8', 'F8'], ['5', '5']]) {
    assert.deepEqual(shortcutFromKeyboardEvent({ key }), { accelerator: expected, reason: '' });
  }
  assert.deepEqual(shortcutFromKeyboardEvent({ key: 'CapsLock', ctrlKey: true }),
    { accelerator: 'Control+CapsLock', reason: '' });
});

test('shortcut recorder rejects keys the native hook cannot register', () => {
  assert.deepEqual(shortcutFromKeyboardEvent({ key: '+' }), { accelerator: '', reason: 'unsupported-key' });
  assert.deepEqual(shortcutFromKeyboardEvent({
    key: '+', code: 'Equal', ctrlKey: true,
  }), { accelerator: '', reason: 'unsupported-key' });
  assert.deepEqual(shortcutFromKeyboardEvent({
    key: '1', code: 'Numpad1', location: 3, ctrlKey: true,
  }), { accelerator: '', reason: 'unsupported-key' });
});

const singleModifiers = [
  ['Control', 'ControlLeft', 'ctrlKey', 'LeftControl'],
  ['Control', 'ControlRight', 'ctrlKey', 'RightControl'],
  ['Alt', 'AltLeft', 'altKey', 'LeftAlt'],
  ['Alt', 'AltRight', 'altKey', 'RightAlt'],
  ['Shift', 'ShiftLeft', 'shiftKey', 'LeftShift'],
  ['Shift', 'ShiftRight', 'shiftKey', 'RightShift'],
  ['Meta', 'MetaLeft', 'metaKey', 'LeftSuper'],
  ['Meta', 'MetaRight', 'metaKey', 'RightSuper'],
];

test('modifier-only bindings wait for release and distinguish both sides', () => {
  const recorder = createShortcutRecorder();
  for (const [key, code, flag, accelerator] of singleModifiers) {
    const event = { key, code, [flag]: true };
    assert.equal(recorder.keyDown(event).reason, 'waiting-for-key');
    assert.equal(recorder.keyDown({ ...event, repeat: true }).reason, 'waiting-for-key');
    assert.deepEqual(recorder.keyUp({ key, code }), { accelerator, reason: '' });
    assert.equal(recorder.keyUp({ key, code }).reason, 'waiting-for-key', 'duplicate release cannot record again');
  }
  recorder.keyDown({ key: 'Alt', location: 1, altKey: true });
  assert.equal(recorder.keyUp({ key: 'Alt', location: 1 }).accelerator, 'LeftAlt');
  recorder.keyDown({ key: 'Alt', altKey: true });
  assert.equal(recorder.keyUp({ key: 'Alt' }).accelerator, '', 'unknown side must not guess');
});

test('modifier candidates become combinations and cannot survive invalid input or cancelled setup', () => {
  const recorder = createShortcutRecorder();
  const altDown = { key: 'Alt', code: 'AltLeft', altKey: true };
  const altUp = { key: 'Alt', code: 'AltLeft' };
  recorder.keyDown(altDown);
  assert.equal(recorder.keyDown({ key: ' ', code: 'Space', altKey: true }).accelerator, 'Alt+Space');
  assert.equal(recorder.keyUp(altUp).accelerator, '', 'release cannot replace an Alt combination');
  recorder.keyDown({ key: 'Control', code: 'ControlLeft', ctrlKey: true });
  recorder.keyDown({ key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true });
  assert.equal(recorder.keyDown({ key: 'F8', ctrlKey: true, shiftKey: true }).accelerator, 'Control+Shift+F8');
  assert.equal(recorder.keyUp({ key: 'Shift', code: 'ShiftLeft', ctrlKey: true }).accelerator, '');
  assert.equal(recorder.keyUp({ key: 'Control', code: 'ControlLeft' }).accelerator, '');
  for (const interrupt of [
    () => recorder.reset(),
    () => recorder.keyDown({ key: '+', code: 'Equal', altKey: true }),
    () => recorder.keyDown({ key: 'Process', isComposing: true }),
    () => recorder.keyDown({ key: 'Shift', code: 'ShiftLeft', altKey: true, shiftKey: true }),
    () => recorder.keyUp({ key: 'Alt', code: 'AltRight' }),
  ]) {
    recorder.keyDown(altDown); interrupt();
    recorder.keyDown({ ...altDown, repeat: true });
    assert.equal(recorder.keyUp(altUp).accelerator, '', 'a fresh press is required after interruption');
  }
  recorder.keyDown(altDown);
  assert.equal(recorder.keyUp({ ...altUp, altKey: true }).accelerator, '', 'another held Alt prevents a solo assignment');
  recorder.keyDown(altDown);
  assert.equal(recorder.keyUp({ ...altUp, isComposing: true }).accelerator, '');
});

test('AltGraph can select Right Alt without mistaking its synthetic Control for a chord', () => {
  const recorder = createShortcutRecorder();
  recorder.keyDown({ key: 'Control', code: 'ControlLeft', ctrlKey: true });
  recorder.keyDown({ key: 'AltGraph', code: 'AltRight', ctrlKey: true, altKey: true });
  assert.equal(recorder.keyUp({ key: 'AltGraph', code: 'AltRight', ctrlKey: true }).accelerator, 'RightAlt');
  assert.equal(recorder.keyUp({ key: 'Control', code: 'ControlLeft' }).accelerator, '');
  recorder.keyDown({ key: 'Alt', code: 'AltRight', ctrlKey: true, altKey: true });
  assert.equal(recorder.keyUp({ key: 'Alt', code: 'AltRight', ctrlKey: true }).accelerator, '', 'ordinary Ctrl+Alt without an AltGraph indication still waits for a trigger');
});
