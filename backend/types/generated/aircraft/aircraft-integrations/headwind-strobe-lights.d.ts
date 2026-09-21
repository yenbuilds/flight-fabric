export declare function headwindStrobeLights(): {
    fields: Record<string, Readonly<{
        id: string;
        sources: readonly import("./types.js").AircraftIntegrationFieldSource[];
    }>>;
    actions: Record<string, Readonly<{
        guard: Readonly<{
            cooldownMs: number;
            groupId: string;
            retry: "never";
            skipIfSatisfied?: boolean;
            skipWhen?: readonly import("./types.js").AircraftIntegrationActionPrecondition[];
        }>;
        id: string;
        input?: import("./types.js").AircraftIntegrationNumberInput;
        routes: readonly import("./types.js").AircraftIntegrationActionRoute[];
        verification: "untested" | "partial" | "verified";
    }>>;
};
