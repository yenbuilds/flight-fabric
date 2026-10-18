import type { AircraftIntegrationActionRoute } from './integration-engine/types.js';
import { captureConditionalWriteState, executeConditionalWrites } from './conditional-write-execution.js';
import { captureStagedControlState, executeStagedControl, type ControlReadSources } from './staged-control-execution.js';

type ExecutionRequest = {
  value?: number;
  isCurrent: () => boolean;
  /** A fresh, current-profile snapshot gate on every capture, never a cached observation. */
  capture: () => ControlReadSources | null;
  sendEvent: (name: string, value: number) => Promise<any>;
  setNamedVar: (input: { name: string; unit: string; value: number }) => Promise<any>;
  executeCode: (code: string) => Promise<any>;
  findException?: (ids: number[], since: number) => unknown;
};

/**
 * Public barometer result adaptation for registry-validated neutral recipes.
 * Sampling contracts, writes and procedures belong to each YAML recipe.
 */
export function resolveBarometerExecution(_adapterId: string, route: AircraftIntegrationActionRoute) {
  if (!('baro' in route) || !route.baro) return null;
  const baro = route.baro;
  if ('stagedControl' in route && route.stagedControl) {
    const recipe = route.stagedControl;
    return {
      requiresCalculatorTransport: route.transport === 'mobiflight-calculator',
      execute: async (request: ExecutionRequest) => {
        const { confirmedTargets, ...result } = await executeStagedControl({
          ...request, recipe,
          capture: () => {
            const sources = request.capture();
            return sources && captureStagedControlState(recipe, sources);
          },
          write: (id, key) => {
            const index = recipe.targets.find(target => target.id === id).writes[key];
            if (route.transport === 'mobiflight-calculator') return request.executeCode(route.codes[index]);
            if (route.transport !== 'simconnect-sequence') throw new Error('Unreviewed barometer input.');
            const operation = route.operations[index];
            if (operation.type !== 'event' && operation.type !== 'lvar') throw new Error('Unreviewed barometer input.');
            let value = Number(operation.value);
            if (operation.inputValue) {
              const input = operation.inputValue;
              if ('encoding' in input) throw new Error('Unreviewed barometer input.');
              value = request.value * (input.scale ?? 1) + (input.offset ?? 0);
              if (input.round === 'nearest') value = Math.round(value);
            }
            return operation.type === 'event' ? request.sendEvent(operation.name, value)
              : request.setNamedVar({ name: operation.name, unit: operation.unit, value });
          },
        });
        const codes = { stale_context: 'stale_baro_context', transport_rejected: 'baro_write_rejected',
          write_rejected: 'baro_write_rejected', unavailable: 'baro_unavailable', changed: 'baro_changed',
          readback_timeout: 'baro_readback_timeout', invalid_value: 'invalid_baro_value', failed: 'baro_write_failed' };
        return { ...result, code: result.ok ? result.code : codes[result.code] || result.code,
          baro: { target: baro.target, mode: baro.operation === 'std' ? 'std' : 'qnh',
            ...(baro.operation === 'std' ? {} : { unit: baro.operation === 'qnhInHg' ? 'inHg' : 'hPa', value: request.value }),
            confirmedSides: confirmedTargets } };
      },
    };
  }
  if (route.transport !== 'simconnect-sequence') return null;
  if (route.conditionalWrites) {
    return {
      requiresCalculatorTransport: false,
      execute: async (request: ExecutionRequest) => {
        const { confirmedTargets, ...result } = await executeConditionalWrites({
          ...request, route,
          capture: () => {
            const sources = request.capture();
            return sources && captureConditionalWriteState(route, sources.decoded);
          },
        });
        // Keep the public barometer response stable while the engine stays neutral.
        const failures = {
          stale_context: ['stale_baro_context', 'Aircraft or simulator connection changed. No further barometer writes were sent.'],
          transport_rejected: ['baro_write_rejected', 'SimConnect rejected the barometer control.'],
          write_rejected: ['baro_write_rejected', 'The sidecar did not accept the barometer write.'],
          unavailable: ['baro_unavailable', 'Fresh, active EFIS panels are required.'],
          readback_timeout: ['baro_readback_timeout', 'STD was not confirmed. No automatic retry was sent.'],
        };
        const failure = failures[result.code];
        return {
          ...result,
          ...(result.ok ? {} : { code: failure?.[0] || (result.code === 'failed' ? 'baro_failed' : result.code), error: failure?.[1] || result.error }),
          baro: { target: baro.target, mode: 'std', confirmedSides: confirmedTargets },
        };
      },
    };
  }
  return null;
}
