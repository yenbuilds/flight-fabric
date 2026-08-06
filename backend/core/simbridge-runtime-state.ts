type AnyRecord = Record<string, any>;

type RuntimeSnapshotInput = {
  flightActive: boolean;
  flightId: string | null | undefined;
  flightStartIso: string | null | undefined;
  aircraftTitle: string | null | undefined;
  phase: string | null | undefined;
  timestampMs: number;
};

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

export function buildSimbridgeRuntimeSnapshot(runtimeState: AnyRecord, input: RuntimeSnapshotInput) {
  return {
    tickFrame: runtimeState.sim.latestTickFrame,
    phase: input.phase || null,
    simState: runtimeState.sim.lastState,
    flightActive: input.flightActive,
    flightId: input.flightId || null,
    flightStartIso: input.flightStartIso || null,
    aircraftTitle: input.aircraftTitle || null,
    timestampMs: input.timestampMs,
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

export function clearLiveReplayMessages(runtimeState: AnyRecord) {
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
  getReplayState(runtimeState)[type] = { ...message };
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
  buildSimbridgeRuntimeSnapshot,
  clearLiveReplayMessages,
  getReplayMessages,
  rememberReplayMessage,
  resetSimbridgeBroadcastState,
};

export {};
