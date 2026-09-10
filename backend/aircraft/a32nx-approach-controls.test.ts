const test = require('node:test');
const assert = require('node:assert/strict');
const { SimConnectTelemetryProvider } = require('../telemetry-provider/simconnect-telemetry-provider');
const { LvarSidecarBridge } = require('../telemetry-provider/lvar-sidecar-bridge');
const { resolveAircraftCommand, buildAircraftControlCapabilities } = require('./aircraft-control-service');
const loader = require('./aircraft-profile-loader');

const PROFILE = { id: 'fbw-a32nx', simulator: 'msfs', _profileKey: 'bundled/msfs/fbw-a32nx',
  integration: { aircraftSpecific: { adapter: 'fbw-a32nx' }, controls: { genericFallback: false } } };
const capabilities = { actionTypes: ['aircraft-integration', 'key-event'], integrationTransports: ['simconnect-sequence', 'lvar'] };
const cases = [
  ['surfaces.flaps.set', 'up', 'controls.flaps.up', 'controls.flapsHandle', 0, 'FLAPS_UP', 0, 'up'],
  ['surfaces.flaps.set', '1', 'controls.flaps.one', 'controls.flapsHandle', 1, 'FLAPS_1', 0, '1'],
  ['surfaces.flaps.set', '2', 'controls.flaps.two', 'controls.flapsHandle', 2, 'FLAPS_2', 0, '2'],
  ['surfaces.flaps.set', '3', 'controls.flaps.three', 'controls.flapsHandle', 3, 'FLAPS_3', 0, '3'],
  ['surfaces.flaps.set', 'full', 'controls.flaps.full', 'controls.flapsHandle', 4, 'FLAPS_DOWN', 0, 'full'],
  ['surfaces.autobrake.set', 'off', 'systems.autobrake.disarm', 'systems.autobrakeMode', 0, 'L:A32NX_AUTOBRAKES_ARMED_MODE_SET', 0, 'disarmed'],
  ['surfaces.autobrake.set', 'low', 'systems.autobrake.low', 'systems.autobrakeMode', 1, 'L:A32NX_AUTOBRAKES_ARMED_MODE_SET', 1, 'low'],
  ['surfaces.autobrake.set', 'medium', 'systems.autobrake.medium', 'systems.autobrakeMode', 2, 'L:A32NX_AUTOBRAKES_ARMED_MODE_SET', 2, 'medium'],
  ['surfaces.autobrake.set', 'max', 'systems.autobrake.max', 'systems.autobrakeMode', 3, 'L:A32NX_AUTOBRAKES_ARMED_MODE_SET', 3, 'max'],
  ['surfaces.spoilers.set', 'retracted', 'controls.spoilers.retracted', 'controls.spoilersHandle', 0, 'SPOILERS_SET', 0, 0],
  ['surfaces.spoilers.set', 'half', 'controls.spoilers.half', 'controls.spoilersHandle', 0.5, 'SPOILERS_SET', 8192, 0.5],
  ['surfaces.spoilers.set', 'full', 'controls.spoilers.full', 'controls.spoilersHandle', 1, 'SPOILERS_SET', 16384, 1],
] as const;

function harness(fieldId = 'controls.flapsHandle', initial = 0) {
  loader.setActiveProfile('fbw-a32nx');
  const config = loader.getLvarConfig().aircraftSpecific;
  const field = config.confirmationFields.find((f) => f.id === fieldId);
  const key = field.source.key;
  const provider = new SimConnectTelemetryProvider();
  // Resolve bridge ownership before dating the synthetic telemetry.
  const bridge = new LvarSidecarBridge();
  provider._connected = true; provider._simRunning = true;
  let active = true;
  provider._getActiveAircraftIntegrationConfig = () => active ? config : null;
  provider._getAircraftIntegrationTransportCapabilities = () => ({ 'simconnect-sequence': true, lvar: true });
  const source = { profileId: PROFILE._profileKey, status: 'running', values: { [key]: initial },
    valueUpdatedAt: { [key]: new Date(Date.now() - 10).toISOString() },
    snapshotSequence: 1, updatedAt: new Date().toISOString() };
  const calls: any[] = [];
  bridge.getSnapshot = () => source;
  bridge._sendWithAck = async (message) => { calls.push(message); return { ok: true }; };
  // Keep the real provider confirmation loop, with only its deadline shortened.
  const wait = provider._waitForAircraftIntegrationReadback.bind(provider);
  provider._waitForAircraftIntegrationReadback = (b, r, c, base) => wait(b, { ...r, timeoutMs: 25 }, c, base);
  const publish = (raw, advanceField = true) => {
    source.values[key] = raw; source.snapshotSequence++;
    source.updatedAt = new Date().toISOString();
    if (advanceField) source.valueUpdatedAt[key] = source.updatedAt;
  };
  const run = (actionId) => provider._executeAircraftIntegrationAction(bridge, { name: 'fbw-a32nx' }, 'test', {
    profileKey: PROFILE._profileKey, profileRevision: 1, request: { actionId },
  });
  return { provider, bridge, source, key, calls, publish, run, retire: () => { active = false; } };
}

test('exact A32NX voice intents resolve to the same confirmed actions as the buttons', async () => {
  for (const [commandId, value, actionId, fieldId, raw, event, payload, confirmed] of cases) {
    const resolved = resolveAircraftCommand({ commandId, input: { value } }, { profile: PROFILE, capabilities });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    assert.equal(resolved.controlRequest.actionId, actionId);
    const h = harness(fieldId, raw === 0 ? 1 : 0);
    h.bridge._sendWithAck = async (message) => { h.calls.push(message); h.publish(raw); return { ok: true }; };
    const result = await h.run(actionId);
    assert.equal(result.ok, true, `${actionId}: ${JSON.stringify(result)}`);
    assert.equal(result.confirmedValue, confirmed);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].name, event); assert.equal(h.calls[0].value, payload);
    h.provider._aircraftIntegrationActionLastAttemptAt.clear();
    assert.equal((await h.run(actionId)).noOp, true);
    assert.equal(h.calls.length, 1, 'an already selected target must not dispatch again');
  }
});

test('invalid A32NX detents and another profile cannot use the fixed flap routes', () => {
  for (const [commandId, value] of [['surfaces.flaps.set', '5'], ['surfaces.flaps.set', '4'],
    ['surfaces.autobrake.set', 'rto'], ['surfaces.autobrake.set', '1'], ['surfaces.spoilers.set', 'off']]) {
    assert.equal(resolveAircraftCommand({ commandId, input: { value } }, { profile: PROFILE, capabilities }).ok, false);
  }
  for (const profile of [{ ...PROFILE, _profileKey: 'local/msfs/fbw-a32nx' },
    { id: 'generic', simulator: 'msfs', _profileKey: 'bundled/msfs/generic' }]) {
    const commands = buildAircraftControlCapabilities(profile, { capabilities }).aircraftCommands.commands;
    assert.equal(commands.some((c) => c.id === 'surfaces.flaps.set'), false);
  }
});

test('absent, invalid or stale individual flap samples block dispatch despite fresh unrelated telemetry', async () => {
  for (const change of [
    (h) => { delete h.source.valueUpdatedAt[h.key]; },
    (h) => { h.source.valueUpdatedAt[h.key] = new Date(Date.now() - 60_000).toISOString(); },
    (h) => { h.source.values[h.key] = 5; },
    (h) => { h.source.values[h.key] = 1.5; },
    (h) => { delete h.source.values[h.key]; },
    (h) => { h.source.status = 'disconnected'; },
  ]) {
    const h = harness(); change(h);
    assert.equal((await h.run('controls.flaps.two')).ok, false);
    assert.equal(h.calls.length, 0);
  }
});

test('each approach control requires its own newer matching sample and never retries a rejected or unconfirmed write', async () => {
  for (const [field, action, target] of [
    ['controls.flapsHandle', 'controls.flaps.two', 2],
    ['systems.autobrakeMode', 'systems.autobrake.medium', 2],
    ['controls.spoilersHandle', 'controls.spoilers.half', 0.5],
  ] as const) for (const failure of ['old-field', 'wrong-target', 'profile', 'disconnect', 'reject']) {
    const h = harness(field);
    h.bridge._sendWithAck = async (message) => {
      h.calls.push(message); h.publish(failure === 'wrong-target' ? 0 : target, failure !== 'old-field');
      if (failure === 'profile') h.retire();
      if (failure === 'disconnect') h.provider._connected = false;
      return { ok: failure !== 'reject' };
    };
    assert.equal((await h.run(action)).ok, false, `${action}: ${failure}`);
    assert.equal(h.calls.length, 1);
  }
});

test('different fixed flap targets share an in-flight lock and cooldown', async () => {
  const h = harness(); let release;
  h.bridge._sendWithAck = async (message) => {
    h.calls.push(message); await new Promise((resolve) => { release = resolve; }); h.publish(2); return { ok: true };
  };
  const pending = h.run('controls.flaps.two');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await h.run('controls.flaps.full')).code, 'action_in_progress');
  release(); assert.equal((await pending).ok, true);
  assert.equal((await h.run('controls.flaps.three')).code, 'action_cooldown');
  assert.equal(h.calls.length, 1);
});

test('joining an existing flight does not require a new SimStart event, while leaving the flight blocks confirmation', async () => {
  for (const leaveFlight of [false, true]) {
    const h = harness(); h.provider._simRunning = null;
    h.provider._systemState = { sim: 1 };
    h.bridge._sendWithAck = async (message) => {
      h.calls.push(message); h.publish(2);
      if (leaveFlight) h.provider._systemState.sim = 0;
      return { ok: true };
    };
    assert.equal((await h.run('controls.flaps.two')).ok, !leaveFlight);
    assert.equal(h.calls.length, 1);
  }
});

export {};
