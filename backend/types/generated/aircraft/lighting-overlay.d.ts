import type { LightingOverlayRecipe } from './integration-behavior.js';
export declare function getLightingOverlayRecipe(adapterId: string): LightingOverlayRecipe | null;
/** Stable selections from declared, independently timestamped snapshot inputs. */
export declare function resolveLightingOverlay(snapshot: any, adapterId: string, now?: number): Record<string, boolean> | null;
