type RecorderProgress = {
    recordingSessionId?: string;
    writtenBytes: number;
};
type Recorder = {
    getProgress?: () => RecorderProgress | null;
};
export declare function getRecordingSizeBytes(sessionId: string, recorders: Recorder[]): number | null;
export {};
