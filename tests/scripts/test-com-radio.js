const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { buildAircraftControlCapabilities } = require(resolveBackendRuntimeFile('aircraft/aircraft-control-service.js'));
const { normalizeComFrequencyMhz } = require(resolveBackendRuntimeFile('utils/radio-frequency.js'));
const catalogue = buildAircraftControlCapabilities({ id: 'fbw-a32nx', simulator: 'msfs', _profileKey: 'bundled/msfs/fbw-a32nx',
  integration: { aircraftSpecific: { adapter: 'fbw-a32nx' }, controls: { genericFallback: false } } }, {
  profileRevision: 1, capabilities: { actionTypes: ['aircraft-integration'], integrationTransports: ['simconnect-sequence'] },
}).aircraftCommands;

test('real catalogue accepts precise COM/VHF phrases and rejects ambiguous or invalid radio commands', async () => {
  const { interpretAircraftVoiceCommand } = await import('../../frontend/src/voice/command-interpreter.js');
  for (const [text, id, value] of [
    ['com one standby one two three decimal four five zero', 'radios.com1.setStandby', 123.45],
    ['set COM 2 standby to 118.005 MHz', 'radios.com2.setStandby', 118.005],
    ['VHF two standby one three six decimal nine nine zero', 'radios.com2.setStandby', 136.99],
    ['switch com one to one two three decimal zero zero five', 'radios.com1.switchTo', 123.005],
    ['switch vhf 2 to 123.450', 'radios.com2.switchTo', 123.45],
    ['swap com one', 'radios.com1.swap', undefined], ['vhf two swap', 'radios.com2.swap', undefined],
  ]) {
    const result = interpretAircraftVoiceCommand(text, catalogue);
    assert.equal(result.ok, true, text); assert.equal(result.commandId, id, text);
    assert.deepEqual(result.input, value === undefined ? {} : { value });
  }
  for (const text of ['com standby 123.450', 'com one 123.450', 'tune 123.450', 'swap com', 'swap com three',
    'com one standby 123.020', 'com two standby 123.456', 'com one standby 137.000', 'com one standby 123450',
    'do not swap com one', 'com one standby 123.450 and swap com one', 'switch both com radios to 123.450']) {
    assert.equal(interpretAircraftVoiceCommand(text, catalogue).ok, false, text);
  }
  assert.equal(interpretAircraftVoiceCommand('swap com one', { commands: [] }).ok, false);
});

test('backend and UI agree on every COM channel designator in both spacing modes', async () => {
  const { parseComRadioFrequency } = await import('../../frontend/src/aircraft/com-radio.js');
  for (const mode of [0, 1]) for (let khz = 117990; khz <= 137005; khz++) {
    const value = khz / 1000;
    assert.equal(parseComRadioFrequency(value.toFixed(3), mode), normalizeComFrequencyMhz(value, mode), `${value}/${mode}`);
  }
  for (const text of ['', '123,450', '123.45e0', '123.4500', '123.450 MHz']) assert.equal(parseComRadioFrequency(text), null);
});

test('COM spoken readbacks name the actual bank and all three fractional digits', async () => {
  const { formatComRadioReadback } = await import('../../frontend/src/voice/local-readback.js');
  assert.equal(formatComRadioReadback({ ok: true, code: 'executed', radio: { index: 1, bank: 'active', frequencyMhz: 123.005 } }),
    'Com one active one two three decimal zero zero five confirmed.');
  assert.equal(formatComRadioReadback({ ok: true, code: 'executed', radio: { index: 2, bank: 'standby', frequencyMhz: 123.45 } }),
    'Com two standby one two three decimal four five zero confirmed.');
  assert.match(formatComRadioReadback({ ok: true, code: 'executed' }), /unconfirmed/);
  assert.match(formatComRadioReadback({ ok: true, code: 'executed', radio: { index: 1, bank: 'active', frequencyMhz: '123.450' } }), /unconfirmed/);
  assert.match(formatComRadioReadback({ ok: true, code: 'sent_unconfirmed', radio: { index: 1, bank: 'active', frequencyMhz: 123.45 } }), /unconfirmed/);
});

test('UI sends canonical COM input and shows actual radio result without retaining pending state', async () => {
  const { createPinia, setActivePinia } = await import('../../frontend/node_modules/pinia/dist/pinia.mjs');
  const { useAircraftControlsStore } = await import('../../frontend/src/vue/stores/aircraft-controls.js');
  const { createAircraftControlController } = await import('../../frontend/src/aircraft/control-controller.js');
  setActivePinia(createPinia());
  const controls = useAircraftControlsStore(), sent = [], toasts = [];
  const controller = createAircraftControlController({ WebSocketRef: { OPEN: 1 }, getWs: () => ({ readyState: 1 }),
    getWsSend: () => (msg) => sent.push(msg), getAuthorizationScope: () => 'full-control', getSimconnectConnected: () => true,
    aircraftControlsStore: controls, showToast: (...args) => toasts.push(args) });
  controller.setActiveProfileToken({ _profileKey: catalogue.profileKey, profileRevision: 1 });
  controller.applyControlCapabilities({ aircraftCommands: catalogue });
  assert.equal(controller.sendCommand('radios.com2.swap'), true);
  controller.handleResult({ requestId: sent[0].requestId, commandId: 'radios.com2.swap', ok: true, code: 'executed',
    radio: { index: 2, bank: 'active', frequencyMhz: 123.005 } });
  assert.match(controls.feedback.actionText, /COM 2 active 123.005 MHz confirmed/);
  assert.equal(controls.isCommandPending('aircraft-command:radios.com2.swap'), false);
  assert.equal(toasts.at(-1)[0], 'success');
});
