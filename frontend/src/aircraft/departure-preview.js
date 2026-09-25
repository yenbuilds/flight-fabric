// Shared read-only preview lifecycle for the app and the Coherent toolbar.
// No control operation can be sent through this helper.
export function createDeparturePreview({ send, changed, now = Date.now, setTimeout, clearTimeout }) {
  const prefix = 'departure-' + now() + '-' + Math.random().toString(36).slice(2) + '-';
  let context = {}, key = '', revision = 0, sequence = 0, pending = null, timer = null;
  let data = null, error = '', lastReply = -Infinity, nextAt = 0, destroyed = false;
  const usable = () => context.connected && context.visible !== false && context.enabled !== false
    && context.profileKey && /^[A-Z0-9]{3,8}$/.test(context.icao) && /^(0?[1-9]|[12][0-9]|3[0-6])[LRC]?$/.test(context.runway);
  function publish() { changed({ data, error, loading: pending?.operation === 'preview', fresh: Boolean(data?.aircraft) && now() - lastReply < 2000 }); }
  function reset() { revision++; pending = null; data = null; error = ''; lastReply = -Infinity; nextAt = now() + 400; publish(); }
  function update(next) {
    context = { ...next, icao: String(next.icao || '').trim().toUpperCase(), runway: String(next.runway || '').trim().toUpperCase() };
    const nextKey = [context.profileKey, context.profileRevision, context.icao, context.runway, usable()].join(':');
    if (key !== nextKey) { key = nextKey; reset(); }
    if (!usable()) { if (timer !== null) clearTimeout(timer); timer = null; return; }
    if (timer === null && !destroyed) timer = setTimeout(tick, 50);
  }
  function request(operation) {
    const at = now(), requestId = prefix + (++sequence);
    pending = { requestId, operation, revision, at };
    const sent = send({ type: 'requestTaxiGuidance', operation, pushback: true, requestId,
      icao: context.icao, runway: context.runway, profileKey: context.profileKey, profileRevision: context.profileRevision,
      scene: !data?.scene });
    if (sent === false) { pending = null; lastReply = -Infinity; error = 'Taxi guidance connection lost.'; nextAt = at + 1000; }
    publish();
  }
  function tick() {
    timer = null;
    if (destroyed || !usable()) return;
    if (usable()) {
      if (pending && now() - pending.at > (pending.operation === 'preview' ? 12000 : 2000)) {
        error = 'Pushback preview unavailable. Retrying…'; pending = null; nextAt = now() + 3000;
      }
      if (!pending && now() >= nextAt) request(!data || (data.pushbackPreview.phase === 'preview' && !data.pushbackPreview.valid) ? 'preview' : 'status');
      publish();
    }
    timer = setTimeout(tick, 250);
  }
  function receive(message) {
    if (destroyed || !usable() || message?.type !== 'toolbarTaxiState' || !pending
      || pending.revision !== revision || pending.requestId !== message.requestId) return false;
    const requestedAt = pending.at; pending = null;
    if (message.ok !== true) { error = message.error || 'Pushback preview unavailable.'; lastReply = -Infinity; nextAt = now() + 5000; publish(); return true; }
    if (message.currentProfileKey !== context.profileKey || message.currentProfileRevision !== context.profileRevision) { reset(); return true; }
    const preview = message.pushbackPreview;
    if (preview && preview.icao === context.icao && preview.runway.replace(/^0(?=\d)/, '') === context.runway.replace(/^0(?=\d)/, '')) {
      const previous = preview.id === data?.pushbackPreview.id ? data : null;
      data = { pushbackPreview: { ...previous?.pushbackPreview, ...preview }, aircraft: message.aircraft,
        scene: message.scene || previous?.scene || null, route: message.preview || previous?.route || null };
      if (!data.pushbackPreview.points || !data.route) data = null;
    } else data = null;
    lastReply = requestedAt; error = ''; nextAt = now() + (['connecting', 'pushing', 'stopping'].includes(preview?.phase) ? 250 : 750); publish();
    return true;
  }
  return { update, receive, reset, destroy() { destroyed = true; if (timer !== null) clearTimeout(timer); timer = null; reset(); } };
}
