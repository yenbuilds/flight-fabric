'use strict';

type StopHandle = (
  handle: unknown,
  label: string,
  timeoutMs?: number,
) => Promise<unknown>;

type ShutdownSequenceOptions = {
  finalizationTask?: (() => Promise<unknown> | unknown) | null;
  provider?: unknown;
  historyIndexHandle?: unknown;
  cabinAnnouncementsHandle?: unknown;
  updateCheckerHandle?: unknown;
  stopHandle: StopHandle;
  closeServersTask?: (() => Promise<unknown> | unknown) | null;
};

type RecordingShutdownFinalizerOptions = {
  flightActive: boolean;
  endActiveFlight: () => Promise<unknown> | unknown;
  getPendingFinalization: () => Promise<unknown> | null;
  finalizeOpenRecorders: () => Promise<unknown> | unknown;
};

/**
 * Select and fully await recording cleanup during shutdown.
 *
 * A failed three-member startup leaves the flight lifecycle active while the
 * individual recorder modules have already moved into finalization. In that
 * state `endActiveFlight()` can have no new recorder to close, but the earlier
 * rollback promise still owns the files and must be awaited before exit.
 */
export async function finalizeRecordingForShutdown({
  flightActive,
  endActiveFlight,
  getPendingFinalization,
  finalizeOpenRecorders,
}: RecordingShutdownFinalizerOptions): Promise<void> {
  if (flightActive) {
    await endActiveFlight();
    const pendingAfterFlightEnd = getPendingFinalization();
    if (pendingAfterFlightEnd) await pendingAfterFlightEnd;
    return;
  }

  const pendingFinalization = getPendingFinalization();
  if (pendingFinalization) {
    await pendingFinalization;
    return;
  }
  await finalizeOpenRecorders();
}

/**
 * Start every runtime-handle stop before awaiting any one handle or flight
 * finalization. In particular, provider.stop() owns the telemetry sidecars and
 * must not be skipped because an unrelated component hangs earlier in cleanup.
 */
export async function runSimbridgeShutdownSequence({
  finalizationTask,
  provider,
  historyIndexHandle,
  cabinAnnouncementsHandle,
  updateCheckerHandle,
  stopHandle,
  closeServersTask,
}: ShutdownSequenceOptions): Promise<void> {
  let historyIndexStopPromise: Promise<unknown> | null = null;
  const stopHistoryIndex = (): Promise<unknown> => {
    if (!historyIndexStopPromise) {
      historyIndexStopPromise = stopHandle(historyIndexHandle, 'history index', 3000);
    }
    return historyIndexStopPromise;
  };
  const tasks = [
    { label: 'telemetry provider stop', run: () => stopHandle(provider, 'telemetry provider', 3000) },
    { label: 'history index stop', run: stopHistoryIndex },
    { label: 'cabin announcements stop', run: () => stopHandle(cabinAnnouncementsHandle, 'cabin announcements') },
    { label: 'update checker stop', run: () => stopHandle(updateCheckerHandle, 'update checker') },
    {
      label: 'flight finalization',
      run: async () => {
        // Finalization can rename/commit an active bundle. Let an in-flight
        // history scan release its single-bundle lease before that mutation.
        try { await stopHistoryIndex(); } catch {}
        return typeof finalizationTask === 'function' ? finalizationTask() : undefined;
      },
    },
  ];
  const failures: Error[] = [];
  const results = await Promise.allSettled(
    tasks.map(({ run }) => Promise.resolve().then(run)),
  );
  results.forEach((result, index) => {
    if (result.status !== 'rejected') return;
    const cause = result.reason instanceof Error
      ? result.reason
      : new Error(String(result.reason || 'unknown cleanup failure'));
    failures.push(new Error(`${tasks[index].label}: ${cause.message}`, { cause }));
  });

  // Listener closure is an independent ownership obligation. Attempt it even
  // when a component stop or flight finalization failed, then report every
  // failure only after all cleanup work has settled.
  if (typeof closeServersTask === 'function') {
    try {
      await closeServersTask();
    } catch (error) {
      const cause = error instanceof Error
        ? error
        : new Error(String(error || 'unknown server close failure'));
      failures.push(new Error(`server close: ${cause.message}`, { cause }));
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more Simbridge shutdown tasks failed');
  }
}
