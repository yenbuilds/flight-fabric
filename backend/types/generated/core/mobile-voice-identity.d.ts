export declare function loadMobileVoiceIdentity(directory: string, ips: string[]): Promise<{
    key: string;
    cert: string;
    certificate: NonSharedBuffer;
    fingerprint: string;
}>;
