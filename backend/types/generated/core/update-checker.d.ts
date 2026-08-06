export type UpdateAvailableMessage = {
    type: string;
    currentVersion: string;
    latestVersion: string;
    downloadUrl: string | null;
    message: string | null;
    urgent: boolean;
};
type BroadcastFn = (payload: UpdateAvailableMessage) => void;
type UpdateCheckerHandle = {
    stop: () => void;
};
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
export {};
