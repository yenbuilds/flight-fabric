// The embedded toolbar gets a separate, session-lifetime preset capability.
// Possession never grants raw aircraft control, settings or recording access.
const crypto = require('node:crypto') as typeof import('node:crypto');
const { readbackFields } = require('../../shared/aircraft-presets');

export function toolbarPresetToken(sessionToken: string): string {
  return sessionToken ? crypto.createHmac('sha256', sessionToken).update('FlightFabric toolbar presets v1').digest('hex') : '';
}

// Each subscribed socket receives at most two compact readbacks per second.
// Original sample timestamps survive projection; a replay cannot freshen data.
export function createToolbarPresetStream(now = Date.now) {
  let catalogue: Record<string, any> | null = null;
  let fields: string[] = [];
  let lastSent = -Infinity;
  return (payload: string): string => {
    const type = /^\{"type":"([^"\\]+)"/.exec(payload)?.[1];
    if (!['aircraftProfile', 'dataSources', 'aircraftChanged', 'aircraftSpecificState'].includes(type || '')) return payload;
    if (type === 'aircraftSpecificState' && now() - lastSent < 500) return payload;
    let message: Record<string, any>;
    try { message = JSON.parse(payload); } catch { return payload; }
    if (type === 'aircraftChanged' || type === 'aircraftProfile') {
      catalogue = null; fields = []; lastSent = -Infinity;
    }
    if (type === 'aircraftProfile' || type === 'dataSources') {
      const next = message.controlCapabilities?.aircraftCommands;
      if (next && Array.isArray(next.commands)) { catalogue = next; fields = readbackFields(next.commands); }
      return payload;
    }
    if (type !== 'aircraftSpecificState') return payload;
    if (!catalogue || message.profileKey !== catalogue.profileKey || message.profileRevision !== catalogue.profileRevision) return payload;
    const values: Record<string, unknown> = {}, valueUpdatedAt: Record<string, string> = {};
    for (const id of fields) {
      const value = message.values?.[id];
      if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
        || (typeof value === 'string' && value.length <= 80)) values[id] = value;
      const timestamp = message.valueUpdatedAt?.[id];
      if (typeof timestamp === 'string' && timestamp.length <= 40 && Number.isFinite(Date.parse(timestamp))) valueUpdatedAt[id] = timestamp;
    }
    lastSent = now();
    return JSON.stringify({ type: 'toolbarPresetState', profileKey: catalogue.profileKey,
      profileRevision: catalogue.profileRevision, templateId: message.templateId,
      available: message.available === true, sourceStatus: message.sourceStatus,
      values, valueUpdatedAt, updatedAt: message.updatedAt,
      unavailable: fields.filter(id => !Object.prototype.hasOwnProperty.call(values, id) || message.unavailable?.includes(id)),
    });
  };
}
