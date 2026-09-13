type AnyRecord = Record<string, any>;

export function createSimbridgeRuntimeState(params: {
  destinationTarget?: AnyRecord | null;
  originTarget?: AnyRecord | null;
} = {}) {
  return {
    sim: {
      lastState: null,
      latestTickFrame: null,
    },
    targets: {
      destination: params.destinationTarget || null,
      origin: params.originTarget || null,
    },
    broadcast: {
      lastFlapsNotch: undefined,
      lastGearState: undefined,
      lastGearParkingBrake: undefined,
      lastSpoilersState: undefined,
      pendingSpoilersState: undefined,
      pendingSpoilersStateTicks: 0,
    },
    replay: {
      latestMessages: {},
    },
  };
}

export function resetSimbridgeBroadcastState(runtimeState: AnyRecord) {
  runtimeState.broadcast.lastFlapsNotch = undefined;
  runtimeState.broadcast.lastGearState = undefined;
  runtimeState.broadcast.lastGearParkingBrake = undefined;
  runtimeState.broadcast.lastSpoilersState = undefined;
  runtimeState.broadcast.pendingSpoilersState = undefined;
  runtimeState.broadcast.pendingSpoilersStateTicks = 0;
}

const LIVE_REPLAY_TYPES = new Set([
  'ias',
  'vs',
  'gs',
  'altitude',
  'heading',
  'iast',
  'xwind',
  'throttle',
  'rates',
  'lights',
  'gear',
  'flaps',
  'spoilers',
  'engines',
  'attitude',
  'surface',
  'position',
  'controls',
  'flightTime',
  'assists',
  'vreSampling',
  'runwayContext',
  'fuel',
  'environment',
  'autopilot',
  'aircraftSpecificState',
]);

const REPLAY_MESSAGE_ORDER = [
  'simState',
  'aircraftProfile',
  'aircraftSpecificState',
  'signalReliability',
  'dataSources',
  'phase',
  'flightRecording',
  'assists',
  'flightTime',
  'lights',
  'vs',
  'ias',
  'gs',
  'altitude',
  'xwind',
  'heading',
  'attitude',
  'fuel',
  'environment',
  'autopilot',
  'gear',
  'flaps',
  'spoilers',
  'engines',
  'throttle',
  'surface',
  'position',
  'controls',
  'iast',
  'rates',
  'vreSampling',
  'runwayContext',
];

const REPLAY_TYPES = new Set(REPLAY_MESSAGE_ORDER);

function getReplayState(runtimeState: AnyRecord): AnyRecord {
  if (!runtimeState.replay || typeof runtimeState.replay !== 'object') {
    runtimeState.replay = {};
  }
  if (!runtimeState.replay.latestMessages || typeof runtimeState.replay.latestMessages !== 'object') {
    runtimeState.replay.latestMessages = {};
  }
  return runtimeState.replay.latestMessages;
}

function clearLiveReplayMessages(runtimeState: AnyRecord) {
  const latestMessages = getReplayState(runtimeState);
  for (const type of LIVE_REPLAY_TYPES) {
    delete latestMessages[type];
  }
}

export function rememberReplayMessage(runtimeState: AnyRecord, message: AnyRecord | null | undefined) {
  if (!message || typeof message !== 'object') return;
  const type = typeof message.type === 'string' ? message.type : '';
  if (!type) return;

  if (type === 'aircraftChanged') {
    clearLiveReplayMessages(runtimeState);
    return;
  }

  if (type === 'simState' && message.simconnectConnected !== true) {
    clearLiveReplayMessages(runtimeState);
  }

  if (!REPLAY_TYPES.has(type)) return;
  const latestMessages = getReplayState(runtimeState);
  latestMessages[type] = { ...message };

  if (type === 'dataSources' && message.controlCapabilities && typeof message.controlCapabilities === 'object') {
    const profileMessage = latestMessages.aircraftProfile;
    const profile = profileMessage?.profile;
    const profileKey = profile?._profileKey || profile?._qualifiedId
      || (profile?.namespace && profile?.simulator && profile?.id
        ? `${profile.namespace}/${profile.simulator}/${profile.id}` : profile?.id);
    if (
      profileKey && profileKey === message.profileKey
      && Number.isSafeInteger(message.profileRevision) && message.profileRevision >= 0
      && profile?.profileRevision === message.profileRevision
    ) {
      // SDK readiness updates arrive separately from the aircraft profile.
      // Later dataSources broadcasts omit unchanged capabilities, so requestState
      // must replay the updated profile instead of its startup command catalogue.
      latestMessages.aircraftProfile = {
        ...profileMessage,
        controlCapabilities: message.controlCapabilities,
      };
    }
  }
}

export function getReplayMessages(runtimeState: AnyRecord) {
  const lastSimState = runtimeState?.sim?.lastState;
  if (lastSimState?.type === 'simState' && lastSimState.simconnectConnected !== true) {
    clearLiveReplayMessages(runtimeState);
  }

  const latestMessages = getReplayState(runtimeState);
  return REPLAY_MESSAGE_ORDER
    .map((type) => latestMessages[type])
    .filter((message) => message && typeof message === 'object');
}

module.exports = {
  createSimbridgeRuntimeState,
  getReplayMessages,
  rememberReplayMessage,
  resetSimbridgeBroadcastState,
};

export {};
