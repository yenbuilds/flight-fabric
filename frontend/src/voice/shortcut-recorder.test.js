import test from 'node:test';
import assert from 'node:assert/strict';
import { shortcutFromKeyboardEvent } from './shortcut-recorder.js';

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

test('shortcut recorder waits for a complete modified shortcut', () => {
  assert.deepEqual(shortcutFromKeyboardEvent({
    key: 'Control', code: 'ControlLeft', ctrlKey: true,
  }), { accelerator: '', reason: 'waiting-for-key' });
  assert.deepEqual(shortcutFromKeyboardEvent({
    key: 'm', code: 'KeyM', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
  }), { accelerator: '', reason: 'modifier-required' });
});

test('shortcut recorder rejects keys the native hook cannot register', () => {
  assert.deepEqual(shortcutFromKeyboardEvent({
    key: '+', code: 'Equal', ctrlKey: true,
  }), { accelerator: '', reason: 'unsupported-key' });
  assert.deepEqual(shortcutFromKeyboardEvent({
    key: '1', code: 'Numpad1', location: 3, ctrlKey: true,
  }), { accelerator: '', reason: 'unsupported-key' });
});
