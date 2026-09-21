type AnyRecord = Record<string, any>;
const { projectServerMessageForClient } = require('./server-message-projection') as typeof import('./server-message-projection');
const { sanitizeToolbarLanding, sanitizeToolbarCaution, sanitizeToolbarFlightHistory, TOOLBAR_HISTORY_MAX_CAUTIONS } = require('./toolbar-flight-history') as typeof import('./toolbar-flight-history');
const timeSource = require('./time-source') as typeof import('./time-source');

const TOOLBAR_HISTORY_TYPES = new Set(['aircraftChanged', 'aircraftProfile', 'flightTime', 'landing', 'ultimateStabilityScore', 'flightViolation']);

function getToolbarHistory(runtimeState: AnyRecord): AnyRecord {
  getReplayState(runtimeState);
  if (!runtimeState.replay.toolbarHistory) runtimeState.replay.toolbarHistory = sanitizeToolbarFlightHistory(null);
  return runtimeState.replay.toolbarHistory;
}

function rememberToolbarHistory(runtimeState: AnyRecord, message: AnyRecord) {
  if (!TOOLBAR_HISTORY_TYPES.has(message.type)) return;
  const history = getToolbarHistory(runtimeState);
  const clear = (invalidateLanding = false) => {
    history.landing = null; history.cautions = []; history.flightId = '';
    if (invalidateLanding) history.awaitingTouchdown = true;
  };
  if (message.type === 'aircraftChanged') {
    clear(true); history.aircraft = null;
  } else if (message.type === 'aircraftProfile') {
    // Use the same public identity that the unpaired toolbar actually receives.
    const projected = projectServerMessageForClient({}, message);
    const profile = projected?.profile || {};
    const profileKey = profile._profileKey || profile._qualifiedId
      || (profile.namespace && profile.simulator && profile.id ? `${profile.namespace}/${profile.simulator}/${profile.id}` : '')
      || projected?.controlCapabilities?.aircraftCommands?.profileKey || '';
    const title = typeof profile.aircraftTitle === 'string' ? profile.aircraftTitle.trim() : '';
    const aircraft = profileKey || title ? { profileKey, title } : null;
    if (history.aircraft?.profileKey !== aircraft?.profileKey || history.aircraft?.title !== aircraft?.title) clear(Boolean(history.aircraft));
    history.aircraft = aircraft;
  } else if (message.type === 'flightTime') {
    const flightId = message.active !== false ? String(message.startedAt || message.flightId || '').slice(0, 128) : '';
    if (flightId && flightId !== history.flightId) { clear(Boolean(history.flightId)); history.flightId = flightId; }
  } else if (history.aircraft) {
    if (message.type === 'landing') {
      // An accepted rollout can finish after aircraft identity has changed.
      // Its late final must not become the new aircraft's landing history.
      if (message.final === true && history.awaitingTouchdown) return;
      history.awaitingTouchdown = false;
      history.landing = sanitizeToolbarLanding(message);
    }
    else if (message.type === 'ultimateStabilityScore' && history.landing) {
      history.landing = sanitizeToolbarLanding({ ...history.landing, ultimateStability: { score: message.score, verdict: message.verdict } });
    } else if (message.type === 'flightViolation' && message.event === 'start') {
      const caution = sanitizeToolbarCaution({ label: message.label, severity: message.severity,
        at: Number.isFinite(message.timestamp_ms) ? message.timestamp_ms : timeSource.now() });
      if (caution) history.cautions = [caution, ...history.cautions].slice(0, TOOLBAR_HISTORY_MAX_CAUTIONS);
    }
  }
}

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
  'simTime',
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
  'simTime',
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

  rememberToolbarHistory(runtimeState, message);

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

export function getReplayMessages(runtimeState: AnyRecord, subscriptions?: ReadonlySet<string> | null) {
  const lastSimState = runtimeState?.sim?.lastState;
  if (lastSimState?.type === 'simState' && lastSimState.simconnectConnected !== true) {
    clearLiveReplayMessages(runtimeState);
  }

  const latestMessages = getReplayState(runtimeState);
  const messages = REPLAY_MESSAGE_ORDER
    .map((type) => latestMessages[type])
    .filter((message) => message && typeof message === 'object');
  // Send one authoritative replacement after the aircraft and flight replay.
  // Opt-in only: reconnecting desktop/overlay clients must not replay alerts.
  if (subscriptions?.has('toolbarFlightHistory')) messages.push(sanitizeToolbarFlightHistory(getToolbarHistory(runtimeState)));
  return messages;
}

module.exports = {
  createSimbridgeRuntimeState,
  getReplayMessages,
  rememberReplayMessage,
  resetSimbridgeBroadcastState,
};

export {};
