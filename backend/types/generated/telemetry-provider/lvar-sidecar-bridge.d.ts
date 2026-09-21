export type CameraWriteStats = {
    ok: number;
    failed: number;
    lastAckType: string | null;
    lastError: string | null;
    lastAckAtMs: number | null;
};
export {};
