type RecorderProgress = { recordingSessionId?: string; writtenBytes: number };
type Recorder = { getProgress?: () => RecorderProgress | null };

// Read only in-memory writer counters. A partial/mismatched bundle has no
// trustworthy total; never substitute zero for an unavailable member.
export function getRecordingSizeBytes(sessionId: string, recorders: Recorder[]): number | null {
  if (!sessionId || recorders.length !== 3) return null;
  let total = 0;
  for (const recorder of recorders) {
    const progress = recorder.getProgress?.();
    if (!progress || progress.recordingSessionId !== sessionId
      || !Number.isSafeInteger(progress.writtenBytes) || progress.writtenBytes < 0) return null;
    total += progress.writtenBytes;
  }
  return Number.isSafeInteger(total) ? total : null;
}
