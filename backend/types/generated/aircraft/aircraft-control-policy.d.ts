/** Compatibility policy for already-validated profile key-event requests. */
export declare function resolveProfileKeyEventPolicy(profileKey: string, eventName: string): {
    groupId: string;
    cooldownMs: number;
    inFlightError: string;
    cooldownError: string;
};
/** Aircraft advice supplements a failed readback; it never authorizes a write. */
export declare function getAircraftReadbackFailureHint(adapterId: string, actionId: string): string;
