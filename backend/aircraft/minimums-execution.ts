import type { AircraftIntegrationActionRoute } from './integration-engine/types.js';
import { executeGuardedDisplayEntry } from './guarded-display-entry.js';

type ExecutionRequest = Omit<Parameters<typeof executeGuardedDisplayEntry>[0], 'recipe'>;

/** Public minimums result adapter for the registry-validated display-entry recipe. */
export function resolveMinimumsExecution(_adapterId: string, route: AircraftIntegrationActionRoute) {
  if (route.transport !== 'simbridge-mcdu' || !route.displayEntry) return null;
  return {
    execute: async (request: ExecutionRequest) => {
      const result = await executeGuardedDisplayEntry({ ...request, recipe: route.displayEntry });
      return result.code === 'entry_unconfirmed' ? { ...result, code: 'minimums_unconfirmed' } : result;
    },
  };
}
