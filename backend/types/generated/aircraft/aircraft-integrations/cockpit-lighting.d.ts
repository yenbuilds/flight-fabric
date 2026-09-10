import type { AircraftIntegrationAction, AircraftIntegrationField } from './types.js';
export type LightingPresetGroup = Readonly<{
    actionId: string;
    label: string;
    fields: readonly string[];
    displays?: boolean;
}>;
export declare function cockpitLightingGroups(adapterId: string): readonly LightingPresetGroup[];
export declare function cockpitLightingIntegration(adapterId: string): {
    fields: Readonly<Record<string, AircraftIntegrationField>>;
    actions: Readonly<Record<string, AircraftIntegrationAction>>;
};
