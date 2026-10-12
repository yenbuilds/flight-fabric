/**
 * Existing momentary AFCS button policy: mode-state readback is not reliable.
 * AP A and AP DISC share one physical group. The provider owns serialization
 * and timestamps so overlapping requests cannot double-fire a toggle.
 */
export declare function getTriStarKeyEventPolicy(profileKey: string, eventName: string): {
    groupId: string;
    cooldownMs: number;
    inFlightError: string;
    cooldownError: string;
};
