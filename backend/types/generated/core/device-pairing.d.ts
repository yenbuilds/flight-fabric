type PairingRequest = {
    confirmationCode: string;
    createdAt: number;
    expiresAt: number;
    id: string;
    remoteAddress: string;
    status: 'pending' | 'approved';
};
export declare function parseCookieHeader(value: string | string[] | undefined): Record<string, string>;
export declare function createDevicePairingManager({ now, requestTtlMs, sessionTtlMs, }?: {
    now?: () => number;
    requestTtlMs?: number;
    sessionTtlMs?: number;
}): {
    approveRequest: (id: unknown, confirmationCode: unknown) => boolean;
    claimApprovedRequest: (id: unknown, remoteAddress: string | null | undefined) => string | null;
    createRequest: (remoteAddress: string | null | undefined) => {
        ok: true;
        request: PairingRequest;
    } | {
        ok: false;
        error: "too_many_requests";
    };
    getRequestStatus: (id: unknown, remoteAddress: string | null | undefined) => {
        status: "pending";
        expiresAt: number;
    } | {
        status: "approved";
        expiresAt: number;
    } | {
        status: "expired";
    };
    hasApprovedSession: (sessionId: unknown, remoteAddress: string | null | undefined) => boolean;
    listPendingRequests: () => Array<Pick<PairingRequest, "confirmationCode" | "createdAt" | "expiresAt" | "id" | "remoteAddress">>;
};
export {};
