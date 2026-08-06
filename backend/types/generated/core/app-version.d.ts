declare const APP_RELEASE_CHANNEL = "Alpha";
declare const APP_RELEASE_WARNING = "Experimental release. Use with care.";
declare function getAppVersion(): string | null;
declare function formatDisplayVersion(version: string | null | undefined): string | null;
declare function getDisplayAppVersion(): string | null;
export { APP_RELEASE_CHANNEL, APP_RELEASE_WARNING, formatDisplayVersion, getAppVersion, getDisplayAppVersion, };
