import test from 'node:test';
import assert from 'node:assert/strict';
import { describeJoystickBinding, joystickBindingFromRuntime } from './joystick-binding.js';

test('joystick bindings from the runtime are bounded and normalized', () => {
  assert.deepEqual(joystickBindingFromRuntime({
    vendorId: '044f', productId: 'b10a', button: '5', name: '  T.16000M ', path: ' \\\\?\\hid#vid_044f&pid_b10a#9#{guid} ',
  }), {
    vendorId: '044F', productId: 'B10A', button: 5, name: 'T.16000M', path: '\\\\?\\hid#vid_044f&pid_b10a#9#{guid}',
  });
  assert.equal(joystickBindingFromRuntime({ vendorId: '044F', productId: 'B10A', button: 5, name: 'x'.repeat(200) }).name.length, 64);
  assert.equal(joystickBindingFromRuntime(null), null);
  assert.equal(joystickBindingFromRuntime('T.16000M button 5'), null);
  assert.equal(joystickBindingFromRuntime({ vendorId: '044F', productId: 'B10A', button: 0 }), null);
  assert.equal(joystickBindingFromRuntime({ vendorId: '44F', productId: 'B10A', button: 1 }), null);
});

test('joystick bindings read as the stick name and the Windows button number', () => {
  assert.equal(describeJoystickBinding({ vendorId: '044F', productId: 'B10A', button: 5, name: 'T.16000M' }), 'T.16000M button 5');
  assert.equal(describeJoystickBinding({ vendorId: '044F', productId: 'B10A', button: 12 }), 'Joystick button 12');
  assert.equal(describeJoystickBinding(null), '');
});
