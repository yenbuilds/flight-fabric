export type UpdateAvailableMessage = {
    type: string;
    currentVersion: string;
    latestVersion: string;
    downloadUrl: string | null;
    message: string | null;
    urgent: boolean;
};
type SupportGoal = {
    period: string;
    supporters: number;
    goal: number;
};
export type SupportGoalMessage = {
    type: string;
} & (SupportGoal | {
    period: null;
    supporters: null;
    goal: null;
});
type BroadcastFn = (payload: UpdateAvailableMessage | SupportGoalMessage) => void;
type UpdateCheckerHandle = {
    stop: () => void;
};
/**
 * Accepts only a well-formed supporter goal: a YYYY-MM period, a non-negative
 * integer count and a positive integer goal, both within a sane bound.
 */
export declare function sanitizeSupportGoal(value: unknown): SupportGoal | null;
export declare function sanitizeUpdateDownloadUrl(value: unknown): string | null;
/**
 * Start the periodic update check.
 *
 * @param {object} options
 * @param {function} options.broadcast      - broadcast(obj) fan-out to all WS clients
 * @param {string}  options.currentVersion  - current app version string (e.g. "0.1.2")
 */
export declare function startUpdateChecker({ broadcast, currentVersion, }: {
    broadcast: BroadcastFn;
    currentVersion: string;
}): UpdateCheckerHandle;
/**
 * Returns the last detected update message (or null), for replay on requestState.
 */
export declare function getLastUpdateMsg(): UpdateAvailableMessage | null;
/**
 * Returns the last goal or withdrawal for requestState replay; null until a
 * manifest has been read successfully.
 */
export declare function getLastSupportGoalMsg(): SupportGoalMessage | null;
export {};
