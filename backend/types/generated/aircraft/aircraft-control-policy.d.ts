/** Compatibility policy for already-validated profile key-event requests. */
export declare function resolveProfileKeyEventPolicy(profileKey: string, eventName: string): {
    groupId: any;
    cooldownMs: any;
    inFlightError: any;
    cooldownError: any;
};
/** Aircraft advice supplements a failed readback; it never authorizes a write. */
export declare function getAircraftReadbackFailureHint(adapterId: string, actionId: string): string;
