import type { AircraftIntegrationAction, AircraftIntegrationField, SimConnectSequenceOperation } from './types.js';

// Headwind 0.8.1-09203ddc: config/a339x/a330-941/aircraft_preset_procedures.xml
// explicitly resets strobes OFF for 50 ms before ON/AUTO. The selector is an
// observation, not a write target; AUTO can legitimately extinguish the lamps.
export function headwindStrobeLights() {
  const fields: Record<string, AircraftIntegrationField> = {
    'lights.strobeMode': { id: 'lights.strobeMode', sources: [{
      route: { type: 'lvar', name: 'L:LIGHTING_STROBE_0', unit: 'Number' },
      decode: { type: 'enum', values: { 0: 'on', 1: 'auto', 2: 'off' } },
    }] },
    'lights.strobeActive': { id: 'lights.strobeActive', sources: [{
      route: { type: 'lvar', name: 'A:LIGHT STROBE', unit: 'Bool' },
      decode: { type: 'boolean', trueValues: [1, true], falseValues: [0, false] },
    }] },
  };
  const actions: Record<string, AircraftIntegrationAction> = {};
  for (const mode of ['off', 'on', 'auto'] as const) {
    const id = `lights.strobe.${mode}`;
    const operations: SimConnectSequenceOperation[] = [
      { type: 'lvar', name: 'L:STROBE_0_AUTO', unit: 'Number', value: 0 },
      { type: 'event', name: 'STROBES_OFF', value: 0 },
    ];
    if (mode !== 'off') operations.push(
      { type: 'delay', milliseconds: 50 },
      { type: 'lvar', name: 'L:STROBE_0_AUTO', unit: 'Number', value: mode === 'auto' ? 1 : 0 },
      { type: 'event', name: 'STROBES_ON', value: 0 },
    );
    const modeReadback = { fieldId: 'lights.strobeMode', expectedValue: mode, timeoutMs: 3000, freshness: 'field' as const };
    actions[id] = { id, guard: { groupId: 'headwindA330.lights.strobe', cooldownMs: 300, retry: 'never' },
      routes: [{ id: `headwindA330.${id}`, transport: 'simconnect-sequence', operations,
        ...(mode === 'auto' ? { readback: modeReadback } : { readbacks: [modeReadback,
          { fieldId: 'lights.strobeActive', expectedValue: mode === 'on', timeoutMs: 3000, freshness: 'field' as const },
        ] }),
      }], verification: 'untested' };
  }
  return { fields, actions };
}
