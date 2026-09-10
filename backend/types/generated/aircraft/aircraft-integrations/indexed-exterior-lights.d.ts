/** Explicit indices from each installed aircraft's cockpit XML and systems.cfg. */
export declare function indexedExteriorLights(adapterId: 'fbw-a380x' | 'headwind-a330'): {
    fields: Record<string, Readonly<{
        id: string;
        sources: readonly import("./types").AircraftIntegrationFieldSource[];
    }>>;
    actions: Record<string, Readonly<{
        guard: Readonly<{
            cooldownMs: number;
            groupId: string;
            retry: "never";
            skipIfSatisfied?: boolean;
            skipWhen?: readonly import("./types").AircraftIntegrationActionPrecondition[];
        }>;
        id: string;
        input?: import("./types").AircraftIntegrationNumberInput;
        routes: readonly import("./types").AircraftIntegrationActionRoute[];
        verification: "untested" | "partial" | "verified";
    }>>;
};
