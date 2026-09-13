'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBackendRuntimeFile: runtime } = require('./backend-runtime-paths');
const { listProfiles, loadProfile } = require(runtime('aircraft/aircraft-profile-loader.js'));
const { buildAircraftControlCapabilities } = require(runtime('aircraft/aircraft-control-service.js'));
const { createProviderBroadcastRelay } = require(runtime('core/simbridge-core.js'));
const { createSimbridgeRuntimeState, rememberReplayMessage, getReplayMessages } = require(runtime('core/simbridge-runtime-state.js'));
const { projectSerializedServerMessageForClient } = require(runtime('core/server-message-projection.js'));

const transports = ['sdk', 'simconnect-sequence', 'lvar', 'mobiflight-calculator', 'simbridge-mcdu'];
const frontend = Promise.all([
  import('../../frontend/node_modules/pinia/dist/pinia.mjs'),
  import('../../frontend/src/vue/stores/aircraft-controls.js'),
  import('../../frontend/src/aircraft/control-controller.js'),
  import('../../frontend/src/voice/command-interpreter.js'),
  import('../../frontend/src/vue/components/aircraft-specific/mcp-input.js'),
]);
const takeoff = { type: 'canonical', commandId: 'configuration.lights.takeoff', input: {} };
const autopilotTargets = [
  ['speed', 250, 'set speed two five zero'],
  ['mach', 0.78, 'set mach decimal seven eight'],
  ['heading', 270, 'set heading two seven zero'],
  ['altitude', 12000, 'set altitude twelve thousand feet'],
  ['verticalSpeed', -1800, 'set vertical speed minus one thousand eight hundred'],
  ['flightPathAngle', -3.1, 'set flight path angle minus three decimal one'],
];

for (const entry of listProfiles()) {
  const profileKey = `bundled/${entry.simulator}/${entry.id}`;
  test(`${profileKey}: refresh preserves current commands through transport loss and recovery`, async () => {
    const [{ createPinia }, { useAircraftControlsStore }, { createAircraftControlController },
      { interpretAircraftVoiceCommand }, { submitMcpDraft }] = await frontend;
    const profile = loadProfile(profileKey);
    const profileRevision = 7;
    const profileMessage = { type: 'aircraftProfile', profile: {
      id: profile.id, namespace: profile.namespace, simulator: profile.simulator,
      _profileKey: profileKey, profileRevision,
    } };
    const build = (available) => buildAircraftControlCapabilities(profile, {
      profileRevision,
      capabilities: {
        simulator: entry.simulator,
        actionTypes: entry.simulator === 'msfs' ? ['aircraft-integration', 'key-event', 'simvar', 'lvar'] : [],
        integrationTransports: Object.fromEntries(transports.map(id => [id, entry.simulator === 'msfs' && available.includes(id)])),
      },
    });
    const runtimeState = createSimbridgeRuntimeState();
    let currentCapabilities = build([]);
    const clients = [
      { __ffPrivilegedClient: true },
      { __ffAircraftControlClient: true },
    ].map(scope => {
      const store = useAircraftControlsStore(createPinia());
      store.setAvailability({ enabled: true });
      const controller = createAircraftControlController({ aircraftControlsStore: store, WebSocketRef: { OPEN: 1 } });
      return { scope, store, controller };
    });

    function deliver(message) {
      for (const { scope, controller } of clients) {
        const wire = projectSerializedServerMessageForClient(scope, JSON.stringify(message));
        assert.ok(wire, 'the replay message must reach both desktop and paired browser clients');
        const received = JSON.parse(wire);
        if (received.type === 'aircraftProfile') {
          controller.setActiveProfileToken(received.profile);
          controller.applyControlCapabilities(received.controlCapabilities);
        } else if (received.type === 'dataSources' && received.controlCapabilities) {
          assert.equal(controller.applyControlCapabilities(received.controlCapabilities, received), true);
        }
      }
    }

    function broadcast(message) {
      rememberReplayMessage(runtimeState, message);
      deliver(message);
    }
    const relay = createProviderBroadcastRelay({
      broadcast, getActiveProfile: () => profile, getActiveProfileRevision: () => profileRevision,
      buildControlCapabilities: () => currentCapabilities,
    });
    broadcast({ ...profileMessage, controlCapabilities: currentCapabilities });
    relay({ type: 'dataSources', sources: [] });

    const scenarios = [
      ['startup', []], ['ready', transports],
      ...transports.flatMap(id => [[`${id} unavailable`, transports.filter(other => other !== id)], [`${id} recovered`, transports]]),
      ['all integrations unavailable', []], ['all integrations recovered', transports],
    ];
    for (const [label, available] of scenarios) {
      currentCapabilities = build(available);
      relay({ type: 'dataSources', sources: [] });
      // This subsequent source-detail broadcast has no capability delta. It
      // used to erase the only up-to-date catalogue in the replay cache.
      relay({ type: 'dataSources', sources: [{ type: 'sdk', connected: available.includes('sdk') }] });
      const replay = getReplayMessages(runtimeState);
      assert.equal(Object.hasOwn(replay.find(message => message.type === 'dataSources'), 'controlCapabilities'), false);
      assert.deepEqual(replay.find(message => message.type === 'aircraftProfile').controlCapabilities,
        currentCapabilities, `${label}: replay must retain every capability, including unavailable actions`);

      // A new connection gets a freshly built profile, then the page sends
      // requestState. Replaying cached state must not undo the fresh catalogue.
      deliver({ ...profileMessage, controlCapabilities: currentCapabilities });
      for (const message of replay) deliver(message);
      const expectedIds = currentCapabilities.aircraftCommands.commands.map(command => command.id).sort();
      const supportsTakeoff = expectedIds.includes(takeoff.commandId);
      for (const { store } of clients) {
        assert.deepEqual(Object.keys(store.aircraftCommandCatalogue.commands).sort(), expectedIds, `${label}: UI command catalogue`);
        assert.deepEqual(store.controlCapabilities.autopilot, currentCapabilities.autopilot, `${label}: generic autopilot controls`);
        assert.deepEqual(store.controlCapabilities.autopilotPulse, currentCapabilities.autopilotPulse, `${label}: generic autopilot modes`);
        for (const command of currentCapabilities.aircraftCommands.inventory.filter(command => command.id.startsWith('flightGuidance.'))) {
          assert.equal(store.isCommandDisabled({ type: 'canonical', commandId: command.id }), !command.supported,
            `${label}: ${command.id} availability after refresh`);
        }
        for (const [target, value, phrase] of autopilotTargets) {
          const commandId = `flightGuidance.${target}.set`;
          const descriptor = currentCapabilities.aircraftCommands.commands.find(command => command.id === commandId);
          const supported = Boolean(descriptor);
          const calls = [];
          const sent = submitMcpDraft({
            config: { ...descriptor?.input, commandId }, rawValue: String(value), groupId: target,
            disabled: store.isCommandDisabled({ type: 'canonical', commandId }),
            requestCommand: (id, groupId, input) => { calls.push({ commandId: id, input }); return true; },
          });
          assert.equal(sent, supported, `${label}: typed ${target} target`);
          const voice = interpretAircraftVoiceCommand(phrase, store.aircraftCommandCatalogue);
          assert.equal(voice.ok, supported, `${label}: spoken ${target} target`);
          assert.deepEqual(calls, supported ? [{ commandId, input: { value } }] : [], `${label}: exact typed ${target} payload`);
          if (supported) {
            assert.equal(voice.commandId, commandId);
            assert.deepEqual(voice.input, { value });
          }
        }
        assert.equal(store.isCommandDisabled(takeoff), !supportsTakeoff, `${label}: takeoff button`);
        for (const phrase of ['set takeoff lights', 'set take off lights', 'set lights for takeoff']) {
          assert.equal(interpretAircraftVoiceCommand(phrase, store.aircraftCommandCatalogue).ok,
            supportsTakeoff, `${label}: ${phrase}`);
        }
      }
    }
  });
}
