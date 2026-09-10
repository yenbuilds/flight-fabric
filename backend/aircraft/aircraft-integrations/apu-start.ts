import type { AircraftIntegrationAction, AircraftIntegrationActionPrecondition } from './types.js';

/** FBW's installed aircraft_preset_procedures.xml uses 3000 ms after master ON. */
export function fbwApuMasterOn(prefix: string): AircraftIntegrationAction {
  return {
    id: 'systems.apuMaster.on',
    guard: { groupId: `${prefix}.systems.apuMaster`, cooldownMs: 750, retry: 'never' },
    routes: [{
      id: `${prefix}.systems.apuMaster.on.simconnectSequence`,
      transport: 'simconnect-sequence',
      operations: [
        { type: 'lvar', name: 'L:A32NX_OVHD_APU_MASTER_SW_PB_IS_ON', unit: 'Number', value: 1 },
        { type: 'delay', milliseconds: 3000 },
      ],
      readback: { fieldId: 'systems.apuMaster', expectedValue: true, timeoutMs: 3000 },
    }],
    verification: 'untested',
  };
}

/** Only for vendor-documented fixed START=1 controls (not Fenix counters). */
export function lvarApuStartRequest(params: {
  prefix: string;
  lvar: string;
  skipWhen?: readonly AircraftIntegrationActionPrecondition[];
}): AircraftIntegrationAction {
  return {
    id: 'systems.apuStart.start',
    guard: {
      groupId: `${params.prefix}.systems.apuStart`,
      cooldownMs: 3000,
      retry: 'never',
      ...(params.skipWhen ? { skipWhen: params.skipWhen } : {}),
    },
    routes: [{
      id: `${params.prefix}.systems.apuStart.start.simconnectSequence`,
      transport: 'simconnect-sequence',
      confirmation: 'transport-acknowledged',
      operations: [{ type: 'lvar', name: `L:${params.lvar}`, unit: 'Number', value: 1 }],
    }],
    verification: 'untested',
  };
}
