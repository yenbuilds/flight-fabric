'use strict';

const { WebSocket } = require('ws');

const MAX_SAMPLES = 5000;
const FRESH_MS = 2500;

function validateEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Use a local WebSocket URL such as ws://127.0.0.1:8099.'); }
  if (!['ws:', 'wss:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Capture accepts only a loopback WebSocket URL without credentials, query parameters or a custom path.');
  }
  return url.href;
}

function createCapture({ report, fieldIds, aircraftVersion, simulatorVersion, condition, now = Date.now }) {
  if (!Array.isArray(fieldIds) || !fieldIds.length || fieldIds.length > 64
    || new Set(fieldIds).size !== fieldIds.length
    || fieldIds.some(id => !report.contract.fields.some(field => field.id === id))) {
    throw new Error('Choose 1–64 unique logical field IDs from this profile report.');
  }
  for (const [name, value] of Object.entries({ aircraftVersion, simulatorVersion, condition })) {
    if (typeof value !== 'string' || !value.trim() || value.length > 240) throw new Error(`${name} is required (1–240 characters).`);
  }
  const startedAt = now();
  const samples = [];
  const latestFieldSamples = new Map();
  let revision = null;
  let stoppedReason = null;
  let seenConnected = false;
  let lastReceivedAt = startedAt;

  function stop(reason) { stoppedReason ||= reason; }
  function acceptIdentity(key, nextRevision) {
    if (key !== report.contract.profileKey) { stop('profile-mismatch'); return; }
    if (!Number.isSafeInteger(nextRevision) || nextRevision < 0) { stop('missing-profile-revision'); return; }
    if (revision !== null && nextRevision !== revision) { stop('profile-revision-changed'); return; }
    revision = nextRevision;
  }
  function accept(message, receivedAt = now()) {
    if (stoppedReason || !message || typeof message !== 'object') return;
    if (!Number.isFinite(receivedAt) || receivedAt < lastReceivedAt) { stop('clock-regressed'); return; }
    lastReceivedAt = receivedAt;
    if (message.type === 'aircraftChanged') { stop('aircraft-changed'); return; }
    if (message.type === 'simState') {
      if (message.simconnectConnected !== true || message.inMenu === true || message.paused === true || message.isPaused === true) {
        stop('simulator-unavailable');
      } else seenConnected = true;
      return;
    }
    if (message.type === 'aircraftProfile') {
      acceptIdentity(message.profile?._profileKey || message.profile?._qualifiedId, message.profile?.profileRevision);
      return;
    }
    if (message.type === 'dataSources') {
      // Older backends may omit identity on capability refreshes entirely.
      if (message.profileKey !== undefined || message.profileRevision !== undefined) {
        acceptIdentity(message.profileKey, message.profileRevision);
      }
      return;
    }
    if (message.type !== 'aircraftSpecificState') return;
    acceptIdentity(message.profileKey, message.profileRevision);
    if (stoppedReason) return;
    if (samples.length >= MAX_SAMPLES) { stop('sample-limit'); return; }
    const overall = message.sourceStatus?.overall || message.sourceStatus;
    const publicationMs = Date.parse(message.updatedAt);
    const values = {};
    for (const id of fieldIds) {
      const value = message.values?.[id];
      const hasValue = ['boolean', 'string', 'number'].includes(typeof value)
        && (typeof value !== 'number' || Number.isFinite(value))
        && (typeof value !== 'string' || value.length <= 200)
        && !message.unavailable?.includes(id);
      const sampleMs = Date.parse(message.valueUpdatedAt?.[id]);
      const latest = latestFieldSamples.get(id);
      const ordered = !latest || sampleMs > latest.at
        || (sampleMs === latest.at && Object.is(value, latest.value));
      const fresh = seenConnected && message.available === true && overall === 'connected'
        && Number.isFinite(publicationMs) && receivedAt >= publicationMs && receivedAt - publicationMs <= FRESH_MS
        && Number.isFinite(sampleMs) && publicationMs >= sampleMs && receivedAt - sampleMs <= FRESH_MS && ordered;
      if (hasValue && fresh) latestFieldSamples.set(id, { at: sampleMs, value });
      values[id] = {
        value: hasValue ? value : null,
        quality: !hasValue ? 'missing' : fresh ? 'fresh' : 'stale-or-unavailable',
        sourceUpdatedAt: Number.isFinite(sampleMs) ? new Date(sampleMs).toISOString() : null,
      };
    }
    samples.push({ receivedAt: new Date(receivedAt).toISOString(),
      publishedAt: Number.isFinite(publicationMs) ? new Date(publicationMs).toISOString() : null,
      sourceStatus: ['connected', 'stale', 'disconnected', 'disabled', 'paused', 'error', 'unsupported', 'awaiting-values'].includes(overall)
        ? overall : 'unknown', values });
    if (overall === 'paused' || overall === 'disconnected') stop('simulator-unavailable');
  }

  function finish(reason = 'duration-elapsed') {
    const endedAt = now();
    if (endedAt < lastReceivedAt) stop('clock-regressed');
    const summary = Object.fromEntries(fieldIds.map(id => {
      const fresh = samples.filter(sample => sample.values[id].quality === 'fresh');
      let transitions = 0;
      // Only count adjacent fresh samples; a gap cannot establish a transition.
      for (let index = 1; index < samples.length; index++) {
        const previous = samples[index - 1].values[id], current = samples[index].values[id];
        if (previous.quality === 'fresh' && current.quality === 'fresh'
          && Date.parse(current.sourceUpdatedAt) > Date.parse(previous.sourceUpdatedAt)
          && !Object.is(previous.value, current.value)) transitions++;
      }
      const last = samples.at(-1)?.values[id];
      const lastQuality = last?.quality === 'fresh' && endedAt - Date.parse(last.sourceUpdatedAt) > FRESH_MS
        ? 'stale-or-unavailable' : last?.quality || 'missing';
      const distinctFreshSamples = new Set(fresh.map(sample => sample.values[id].sourceUpdatedAt)).size;
      return [id, { freshSamples: fresh.length, distinctFreshSamples, unavailableSamples: samples.length - fresh.length,
        transitions, firstFreshValue: fresh[0]?.values[id].value ?? null,
        lastFreshValue: fresh.at(-1)?.values[id].value ?? null,
        lastQuality }];
    }));
    const endReason = stoppedReason || reason;
    const lastSampleMs = samples.length ? Date.parse(samples.at(-1).receivedAt) : 0;
    return {
      schemaVersion: 1, kind: 'aircraft-logical-state-capture',
      profileKey: report.contract.profileKey, profileRevision: revision, referenceContractHash: report.contractHash,
      startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(), endReason,
      complete: endReason === 'duration-elapsed' && endedAt - lastSampleMs <= FRESH_MS
        && Object.values(summary).every(item => item.distinctFreshSamples >= 2 && item.lastQuality === 'fresh'),
      environment: { aircraftVersion, simulatorVersion, condition, provenance: 'operator-supplied; not independently verified' },
      scope: 'Read-only logical-state observations. No control writes, command results, raw-source replay, or automatic verification promotion. The reference contract hash identifies the supplied report, not the running app build.',
      fields: report.contract.fields.filter(field => fieldIds.includes(field.id)), summary, samples,
    };
  }

  return { accept, finish, stop, get stoppedReason() { return stoppedReason; }, get sampleCount() { return samples.length; } };
}

async function captureSession(options) {
  const url = validateEndpoint(options.url || 'ws://127.0.0.1:8099');
  const durationMs = options.durationMs;
  if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 120000) {
    throw new Error('Capture duration must be 1–120 seconds.');
  }
  const capture = createCapture(options);
  return new Promise(resolve => {
    let finished = false;
    const socket = new WebSocket(url, { origin: 'http://localhost:8100', maxPayload: 512 * 1024,
      handshakeTimeout: 5000, followRedirects: false });
    let durationTimer;
    const finish = reason => {
      if (finished) return;
      finished = true;
      clearTimeout(connectTimer); clearTimeout(durationTimer);
      socket.terminate();
      options.signal?.removeEventListener('abort', onAbort);
      resolve(capture.finish(reason));
    };
    const onAbort = () => finish('interrupted');
    const connectTimer = setTimeout(() => finish('connection-timeout'), 6000);
    socket.on('open', () => {
      if (finished) return;
      clearTimeout(connectTimer);
      socket.send(JSON.stringify({ type: 'requestState' }));
      durationTimer = setTimeout(() => finish('duration-elapsed'), durationMs);
    });
    socket.on('message', bytes => {
      if (finished) return;
      try { capture.accept(JSON.parse(bytes.toString())); }
      catch { finish('invalid-message'); return; }
      if (capture.stoppedReason) finish(capture.stoppedReason);
    });
    socket.on('error', () => finish('connection-error'));
    socket.on('close', () => finish('connection-closed'));
    if (options.signal?.aborted) finish('interrupted');
    else options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = { createCapture, captureSession, validateEndpoint };
