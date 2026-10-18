const { defaultAircraftIntegrationRegistry } = require('./integration-engine');
import type { LightingOverlayRecipe } from './integration-behavior.js';

export function getLightingOverlayRecipe(adapterId: string): LightingOverlayRecipe | null {
  return defaultAircraftIntegrationRegistry.getById(adapterId)?.behavior?.lightingOverlay || null;
}

/** Stable selections from declared, independently timestamped snapshot inputs. */
export function resolveLightingOverlay(snapshot: any, adapterId: string, now = Date.now()): Record<string, boolean> | null {
  const definition = defaultAircraftIntegrationRegistry.getById(adapterId);
  const recipe: LightingOverlayRecipe = definition?.behavior?.lightingOverlay;
  if (!recipe || !definition.trustedProfileKeys.includes(snapshot?.profileId) || snapshot.status !== recipe.snapshotStatus) return null;
  const inputs: Record<string, number> = {};
  for (const [id, input] of Object.entries(recipe.inputs)) {
    const raw = snapshot.values?.[input.key], time = Date.parse(snapshot.valueUpdatedAt?.[input.key]);
    if (!Number.isFinite(time) || now - time < -recipe.futureToleranceMs || now - time > recipe.freshnessMs) return null;
    if ('allowed' in input) {
      if (!input.allowed.includes(raw)) return null;
      inputs[id] = raw;
    } else {
      const value = input.coerceNumber ? Number(raw) : raw;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < input.min || value > input.max) return null;
      inputs[id] = value;
    }
  }
  return Object.fromEntries(Object.entries(recipe.outputs).map(([id, output]) => [
    id, output.any.some(condition => inputs[condition.input] === condition.equals),
  ]));
}
