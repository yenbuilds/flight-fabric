// Shared app/toolbar control lifecycle. Previewing never starts a manoeuvre.
export function createPushbackControls({ send, changed, complete = () => {}, now = Date.now, setTimeout, clearTimeout }) {
  const prefix = 'pushback-' + now() + '-' + Math.random().toString(36).slice(2) + '-';
  let context = {}, state = { active: false }, pending = '', pendingId = null, error = '', statusError = false;
  let sequence = 0, applied = 0, revision = 0, lastReply = -Infinity, nextStatus = 0, timer = null, destroyed = false, owned = false;
  const requests = new Map();
  const usable = () => context.connected && context.visible !== false && context.enabled && context.profileKey;
  const active = () => Boolean(state.active || pending === 'start');
  const fresh = () => now() - lastReply < 2000;
  function snapshot() {
    const preview = context.preview || {}, plan = preview.data?.pushbackPreview;
    const destination = /^[A-Z0-9]{3,8}$/.test(context.icao || '') && /^(0?[1-9]|[12][0-9]|3[0-6])[LRC]?$/.test(context.runway || '');
    const sameDestination = state.icao === context.icao && state.runway?.replace(/^0/, '') === context.runway?.replace(/^0/, '');
    const completed = !active() && (plan?.phase === 'complete' || (state.status === 'complete' && sameDestination));
    const canStart = Boolean(usable() && !context.disabled && !active() && !pending && !completed && fresh()
      && state.canStart && destination && preview.fresh && plan?.valid);
    const reason = error || (active() ? (!fresh() ? 'Waiting for pushback status…' : state.reason)
      : completed ? 'Pushback complete. Follow the taxi guidance.'
      : !context.enabled ? context.unavailableReason || 'Pushback is unavailable on this connection.'
      : !destination ? 'Choose your departure airport and runway.'
      : !fresh() ? 'Waiting for live pushback status.' : preview.loading ? 'Finding pushback path…'
      : preview.error || state.unavailableReason || (preview.data && !preview.fresh ? 'Waiting for live pushback preview.' : state.reason));
    return { state, active: active(), owned, pending, fresh: fresh(), completed, canStart, reason: reason || '' };
  }
  const publish = () => changed(snapshot());
  function reset() {
    revision++; requests.clear(); state = { active: false }; pending = ''; pendingId = null;
    lastReply = -Infinity; applied = 0; owned = false; nextStatus = 0;
  }
  function request(operation) {
    if (destroyed || !context.connected || (operation !== 'stop' && !usable())) return false;
    if (operation === 'start' && !snapshot().canStart) return false;
    if (operation === 'stop' && pending === 'stop') return false;
    if (operation === 'status' && [...requests.values()].some(r => r.operation === 'status')) return false;
    const requestId = prefix + revision + '-' + (++sequence), at = now();
    requests.set(requestId, { operation, at, sequence });
    if (operation !== 'status') { applied = sequence; pending = operation; pendingId = requestId; error = ''; statusError = false; }
    if (operation === 'start') owned = true;
    const sent = send({ type: 'pushback', operation, requestId, icao: context.icao, runway: context.runway,
      profileKey: context.profileKey, profileRevision: context.profileRevision,
      ...(operation === 'start' ? { previewId: context.preview?.data?.pushbackPreview.id } : {}) });
    if (sent === false) {
      requests.delete(requestId);
      if (pendingId === requestId) { pending = ''; pendingId = null; error = 'Pushback connection unavailable.'; }
      if (operation === 'start') owned = false;
    }
    publish(); return sent !== false;
  }
  function tick() {
    timer = null;
    if (destroyed || !usable()) return;
    if (owned && active() && !fresh() && pending !== 'stop') request('stop');
    requests.forEach((r, id) => {
      if (now() - r.at > (r.operation === 'status' ? 2000 : 15000)) {
        requests.delete(id);
        if (id === pendingId) { pending = ''; pendingId = null; error = 'Pushback request timed out. Check the aircraft.'; }
      }
    });
    if (now() >= nextStatus) { request('status'); nextStatus = now() + (active() ? 250 : 1000); }
    publish(); timer = setTimeout(tick, 250);
  }
  function update(next) {
    if (destroyed) return;
    const wasUsable = usable(), previous = context;
    const normalized = { ...next, icao: String(next.icao || '').trim().toUpperCase(), runway: String(next.runway || '').trim().toUpperCase() };
    const changedAircraft = previous.profileKey !== normalized.profileKey || previous.profileRevision !== normalized.profileRevision;
    const leaving = !normalized.connected || normalized.visible === false || !normalized.enabled;
    if (owned && active() && (leaving || changedAircraft)) request('stop');
    context = normalized;
    if (changedAircraft || leaving) {
      const lostActive = owned && active() && !normalized.connected;
      reset();
      if (lostActive) error = 'Connection lost. Pushback will stop; take control in the cockpit.';
    }
    if (!active() && (previous.icao !== context.icao || previous.runway !== context.runway || (!wasUsable && usable()))) error = '';
    if (!usable()) { if (timer !== null) clearTimeout(timer); timer = null; }
    else if (timer === null && !destroyed) { request('status'); nextStatus = now() + 1000; timer = setTimeout(tick, 250); }
    publish();
  }
  function receive(message) {
    if (destroyed || !usable() || message?.type !== 'pushbackState') return false;
    const r = requests.get(message.requestId);
    if (!r) return false;
    requests.delete(message.requestId);
    if (r.sequence < applied) {
      if (message.requestId === pendingId) { pending = ''; pendingId = null; publish(); }
      return true;
    }
    if (message.ok === false) {
      if (message.requestId === pendingId) { pending = ''; pendingId = null; }
      if (r.operation === 'start') owned = false;
      error = message.error || 'Pushback request failed.'; statusError = r.operation === 'status'; publish(); return true;
    }
    if (message.currentProfileKey !== context.profileKey || message.currentProfileRevision !== context.profileRevision) return true;
    const wasActive = state.active;
    applied = r.sequence; state = message; lastReply = r.at;
    if (message.requestId === pendingId) { pending = ''; pendingId = null; }
    if (!state.active) owned = false;
    // A late status reply must not postpone the next heartbeat after Start.
    if (state.active) nextStatus = Math.min(nextStatus, now() + 250);
    if (r.operation === 'status' && statusError) { error = ''; statusError = false; }
    publish();
    if (wasActive && message.status === 'complete') complete();
    return true;
  }
  return { update, receive, request, snapshot, destroy() {
    if (owned && active()) request('stop');
    destroyed = true; if (timer !== null) clearTimeout(timer); timer = null; reset();
  } };
}
