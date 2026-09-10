const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { buildAircraftControlCapabilities } = require(resolveBackendRuntimeFile('aircraft/aircraft-control-service.js'));
const { projectServerMessageForClient } = require(resolveBackendRuntimeFile('core/server-message-projection.js'));
const catalogue = buildAircraftControlCapabilities({ id: 'fbw-a32nx', simulator: 'msfs', _profileKey: 'bundled/msfs/fbw-a32nx',
  integration: { aircraftSpecific: { adapter: 'fbw-a32nx' }, controls: { genericFallback: false } } }, {
  profileRevision: 1, capabilities: { actionTypes: ['aircraft-integration'], integrationTransports: ['simconnect-sequence'] },
}).aircraftCommands;

test('real catalogue recognizes targeted QNH and STD, rejecting missing targets, invalid or mismatched units', async () => {
  const { interpretAircraftVoiceCommand } = await import('../../frontend/src/voice/command-interpreter.js');
  for (const [text, id, value] of [
    ['set both QNH to one zero one six', 'baro.both.qnhHpa', 1016],
    ['captain QNH 1016 hPa', 'baro.captain.qnhHpa', 1016],
    ['first officer QNH one thousand sixteen hectopascals', 'baro.firstOfficer.qnhHpa', 1016],
    ['both QNH two nine decimal nine two', 'baro.both.qnhInHg', 29.92],
    ['captain altimeter 30.12 inches of mercury', 'baro.captain.qnhInHg', 30.12],
    ['set both altimeters to 29.92 inHg', 'baro.both.qnhInHg', 29.92],
    ['both standard pressure', 'baro.both.std'], ['set captain altimeter standard', 'baro.captain.std'],
    ['first officer altimeter standard', 'baro.firstOfficer.std'],
    ['set baro standard', 'baro.both.std'], ['set baro to standard', 'baro.both.std'],
    ['baro standard', 'baro.both.std'], ['set standard pressure', 'baro.both.std'],
    ['set captain baro standard', 'baro.captain.std'],
    ['set first officer baro to standard', 'baro.firstOfficer.std'],
  ]) {
    const result = interpretAircraftVoiceCommand(text, catalogue);
    assert.equal(result.ok, true, `${text}: ${JSON.stringify(result)}`); assert.equal(result.commandId, id, text);
    assert.deepEqual(result.input, value === undefined ? {} : { value });
  }
  for (const text of ['QNH 1016', 'standard pressure', 'both QNH 1016 inHg', 'both QNH 29.92 hPa',
    'both QNH 1016.5', 'both QNH 947', 'both QNH 1085', 'both QNH 32.02', 'both QNH 29.921',
    'do not set both QNH to 1016', 'both QNH 1016 and captain standard pressure', 'first officer QFE 1016',
    'both QNH flight level ten', 'both QNH flight level 10.16']) {
    assert.equal(interpretAircraftVoiceCommand(text, catalogue).ok, false, text);
  }
  for (const text of ['do not set baro standard', 'set baro standard and heading 270',
    'set baro standard 1013', 'is baro standard', 'set baro', 'set captain and first officer baro standard']) {
    assert.equal(interpretAircraftVoiceCommand(text, catalogue).ok, false, text);
  }
});

test('pressure parsing and spoken confirmation preserve units and both independent outcomes', async () => {
  const { parseBaroPressure, baroResultText } = await import('../../frontend/src/aircraft/baro.js');
  const { formatBaroReadback } = await import('../../frontend/src/voice/local-readback.js');
  for (const [text, unit] of [['1e3', 'hPa'], ['1016.0', 'hPa'], ['29,92', 'inHg'], ['29.920', 'inHg'], ['1016', 'inHg']]) assert.equal(parseBaroPressure(text, unit), null);
  const result = { ok: true, code: 'executed', baro: { target: 'both', mode: 'qnh', value: 1016, unit: 'hPa', confirmedSides: ['captain', 'firstOfficer'] } };
  assert.equal(baroResultText(result).confirmed, true);
  assert.equal(formatBaroReadback(result), 'Both altimeters Q N H one zero one six hectopascals confirmed.');
  assert.match(formatBaroReadback({ ...result, baro: { ...result.baro, value: 29.92, unit: 'inHg' } }), /two nine decimal nine two inches of mercury confirmed/);
  for (const patch of [{ ok: false }, { baro: { ...result.baro, confirmedSides: ['captain'] } },
    { baro: { ...result.baro, confirmedSides: ['captain', 'captain'] } }, { baro: null }, { code: 'sent_unconfirmed' }]) {
    assert.equal(baroResultText({ ...result, ...patch }).confirmed, false);
    assert.doesNotMatch(formatBaroReadback({ ...result, ...patch }), /Both altimeters .* confirmed/);
  }
});

test('paired projection preserves bounded partial barometer observations without private errors', () => {
  const b = { target: 'both', mode: 'qnh', unit: 'hPa', value: 1016, confirmedSides: ['captain'] };
  const message = { type: 'aircraftCommandResult', commandId: 'baro.both.qnhHpa', requestId: 'baro-test', ok: false,
    code: 'baro_readback_timeout', baro: { ...b, privateField: 'secret' }, error: 'private backend path' };
  const projected = projectServerMessageForClient({ __ffAircraftControlClient: true }, message);
  assert.deepEqual(projected.baro, b); assert.doesNotMatch(JSON.stringify(projected), /secret|private backend/);
  for (const patch of [{ confirmedSides: ['both'] }, { value: 9999 }, { unit: 'psi' }, { confirmedSides: ['captain', 'captain'] }]) {
    assert.equal(projectServerMessageForClient({ __ffAircraftControlClient: true }, { ...message, baro: { ...b, ...patch } }).baro, undefined);
  }
});

test('UI completes both QNH pending state with truthful per-side failure feedback', async () => {
  const { createPinia, setActivePinia } = await import('../../frontend/node_modules/pinia/dist/pinia.mjs');
  const { useAircraftControlsStore } = await import('../../frontend/src/vue/stores/aircraft-controls.js');
  const { createAircraftControlController } = await import('../../frontend/src/aircraft/control-controller.js');
  setActivePinia(createPinia());
  const controls = useAircraftControlsStore(), sent = [], toasts = [], results = [];
  const controller = createAircraftControlController({ WebSocketRef: { OPEN: 1 }, getWs: () => ({ readyState: 1 }),
    getWsSend: () => (msg) => sent.push(msg), getAuthorizationScope: () => 'full-control', getSimconnectConnected: () => true,
    aircraftControlsStore: controls, showToast: (...args) => toasts.push(args) });
  controller.setActiveProfileToken({ _profileKey: catalogue.profileKey, profileRevision: 1 });
  controller.applyControlCapabilities({ aircraftCommands: catalogue });
  assert.equal(controller.sendCommand('baro.both.qnhHpa', { value: 1016 }, { onResult: (r) => results.push(r) }), true);
  controller.handleResult({ requestId: sent[0].requestId, commandId: 'baro.both.qnhHpa', ok: false, code: 'baro_readback_timeout',
    baro: { target: 'both', mode: 'qnh', value: 1016, unit: 'hPa', confirmedSides: ['captain'] } });
  assert.match(controls.feedback.actionText, /Captain QNH 1016 hPa observed.*First officer unconfirmed/);
  assert.equal(controls.isCommandPending('aircraft-command:baro.both.qnhHpa'), false);
  assert.equal(controls.feedback.status, 'failed');
  assert.equal(toasts.at(-1)[0], 'warning'); assert.equal(results.length, 1);
});
