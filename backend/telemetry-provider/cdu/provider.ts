import { createCduSession } from './session.js';
import { createFbwCdu } from './fbw-a32nx.js';
import { createPmdgCdu } from './pmdg-737.js';
import { createPmdg777Cdu } from './pmdg-777.js';
const { defaultAircraftIntegrationRegistry } = require('../../aircraft/aircraft-integrations/index.js');

/** The only boundary that sees provider internals and trusted aircraft profiles. */
export function createProviderCdu(provider: Record<string, any>, profiles: Record<string, any>) {
  let generation: unknown[] = [];
  return createCduSession({
    context() {
      const config = profiles.getAircraftSpecificConfig?.();
      if (!config || !defaultAircraftIntegrationRegistry.resolveIntegration(config.integrationId, { profileKey: config.profileKey })) return null;
      // Profile revisions alone do not change on a quick simulator reconnect,
      // and aircraft telemetry resets can precede profile detection. Retain a
      // stable identity until one of those boundaries or transports changes.
      // Bridges can restart in place, so the child processes also own keys.
      const scope = [provider._rustSimvarBridge, provider._rustSimvarBridge?._proc,
        provider._lvarBridge, provider._lvarBridge?._proc,
        provider._autotaxiConnectionEpoch, provider._rustControlReadbackNotBeforeMs];
      if (scope.length !== generation.length || scope.some((value, index) => value !== generation[index])) generation = scope;
      return { profileKey: config.profileKey, profileRevision: config.profileRevision, integrationId: config.integrationId,
        generation,
        connected: provider._connected === true && !provider._stopping && provider._simRunning !== false && provider._systemState?.sim !== 0 };
    },
    createAdapter(id) {
      if (id === 'fbw-a32nx') return createFbwCdu();
      const pmdgFactory = id === 'pmdg-737' ? createPmdgCdu : id === 'pmdg-777' ? createPmdg777Cdu : null;
      if (pmdgFactory) return pmdgFactory({
        async sendEvent(name, value) {
          const bridge = provider._lvarBridge;
          if (!bridge || !provider._bridgeMayBeLive(bridge)) return { ok: false, error: 'SimConnect event writer is unavailable.' };
          const send = bridge.sendSdkEvent || bridge.sendEvent;
          return send ? send.call(bridge, name, value) : { ok: false };
        },
      });
      return null;
    },
  });
}
