import type { AircraftIntegrationActionRoute } from './aircraft-integrations/types.js';
import { executeA32nxMinimums } from './aircraft-integrations/fbw-a32nx/minimums-control.js';

type ExecutionRequest = Omit<Parameters<typeof executeA32nxMinimums>[0], 'target'>;

/** Aircraft-owned selection for the existing registry-validated minimums route. */
export function resolveMinimumsExecution(adapterId: string, route: AircraftIntegrationActionRoute) {
  if (adapterId !== 'fbw-a32nx' || route.transport !== 'simbridge-mcdu') return null;
  return {
    execute: (request: ExecutionRequest) => executeA32nxMinimums({ ...request, target: route.target }),
  };
}
