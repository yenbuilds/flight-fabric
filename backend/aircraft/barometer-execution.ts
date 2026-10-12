import type { AircraftIntegrationActionRoute } from './aircraft-integrations/types.js';
import { captureBaroState, executeBaroTransaction } from './aircraft-integrations/fbw-a32nx/baro-control.js';
import { captureFenixBaroState, executeFenixBaroTransaction } from './aircraft-integrations/fenix-a32x/baro-control.js';
import { captureA380BaroState, executeA380BaroTransaction } from './aircraft-integrations/fbw-a380x/baro-control.js';

type ReadSources = {
  raw: (id: string) => { value: unknown; updatedAt: unknown };
  decoded: (id: string) => { observed: unknown; fresh: boolean; updatedAtMs: number };
};
type ExecutionRequest = {
  value?: number;
  isCurrent: () => boolean;
  /** A fresh, current-profile snapshot gate on every capture, never a cached observation. */
  capture: () => ReadSources | null;
  sendEvent: Parameters<typeof executeBaroTransaction>[0]['sendEvent'];
  setNamedVar: Parameters<typeof executeBaroTransaction>[0]['setNamedVar'];
  executeCode: Parameters<typeof executeFenixBaroTransaction>[0]['executeCode'];
  findException: Parameters<typeof executeBaroTransaction>[0]['findException'];
};

/**
 * Aircraft-owned compatibility dispatch for the existing, registry-validated
 * barometer contracts. It accepts no provider instance or executable profile
 * callbacks. The three procedures remain distinct pending later engine work.
 */
export function resolveBarometerExecution(adapterId: string, route: AircraftIntegrationActionRoute) {
  if (!('baro' in route) || !route.baro) return null;
  const baro = route.baro;
  if (adapterId === 'fenix-a32x' && route.transport === 'mobiflight-calculator' && route.mode === 'fenix-baro') {
    return {
      requiresCalculatorTransport: true,
      execute: (request: ExecutionRequest) => executeFenixBaroTransaction({
        ...request, ...baro,
        capture: () => {
          const sources = request.capture();
          return sources && captureFenixBaroState(baro.target, baro.operation, sources.decoded);
        },
        executeCode: (code: string) => {
          if (!route.codes.includes(code)) throw new Error('Unreviewed barometer input.');
          return request.executeCode(code);
        },
      }),
    };
  }
  if (route.transport !== 'simconnect-sequence') return null;
  if (adapterId === 'fbw-a380x') {
    return {
      requiresCalculatorTransport: false,
      execute: (request: ExecutionRequest) => executeA380BaroTransaction({
        ...request, ...baro,
        capture: () => {
          const sources = request.capture();
          return sources && captureA380BaroState(baro.target, sources.decoded);
        },
      }),
    };
  }
  if (adapterId === 'fbw-a32nx') {
    return {
      requiresCalculatorTransport: false,
      execute: (request: ExecutionRequest) => executeBaroTransaction({
        ...request, ...baro,
        capture: () => {
          const sources = request.capture();
          return sources && captureBaroState(baro.target, sources.raw);
        },
      }),
    };
  }
  return null;
}
