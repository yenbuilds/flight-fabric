// One replay-map facade over the 2D (Leaflet) and 3D (three.js) controllers.
// The rest of the timeline page keeps calling a single controller; the
// facade forwards to whichever view is showing and replays the current
// timeline and cursor onto a view when the user switches to it, so the
// aircraft appears at the scrubber position rather than at the start.

export function createTimelineMapViewSwitch({
  controllers = {},
  getMode = () => '2d',
} = {}) {
  let lastTimeline = null;
  let lastCursor = null;
  let appliedMode = null;

  function timelineIdentity(timeline) {
    if (!timeline) return '';
    return `${timeline.flightId || timeline.filePath || ''}|${timeline.generatedAt || ''}`;
  }

  function controllerFor(mode) {
    return controllers[mode] || controllers['2d'] || null;
  }

  function activeController() {
    return controllerFor(getMode());
  }

  function replayState(controller) {
    if (!controller) return;
    if (lastTimeline) controller.render(lastTimeline);
    if (lastCursor) controller.setCursorPosition(lastCursor.pos, lastCursor.attitude, false);
  }

  function applyMode(mode = getMode()) {
    const nextMode = controllers[mode] ? mode : '2d';
    if (nextMode === appliedMode) return;
    appliedMode = nextMode;
    for (const [key, controller] of Object.entries(controllers)) {
      controller?.setActive?.(key === nextMode);
    }
    const controller = controllerFor(nextMode);
    if (nextMode === '2d') {
      controller?.invalidateSizeStaggered?.();
    }
    replayState(controller);
    // Each view keeps its own follow state; the button reflects the one shown.
    controller?.syncFollowUiState?.();
  }

  function resumeFollow() {
    activeController()?.resumeFollow?.();
  }

  function resumeFollowAndCenter() {
    activeController()?.resumeFollowAndCenter?.();
  }

  function render(timeline) {
    // A re-render of the same recording (map filter change, tab
    // re-activation) keeps the scrubber cursor; only a different recording
    // resets it until the scrubber places the aircraft again.
    if (timelineIdentity(timeline) !== timelineIdentity(lastTimeline)) lastCursor = null;
    lastTimeline = timeline || null;
    const controller = activeController();
    if (!controller) return [];
    return controller.render(timeline);
  }

  function rememberCursor(pos, attitude) {
    if (!pos) return null;
    const timestampMs = Number(pos.timestampMs);
    return {
      // The moment matters as well as the place: the 3D view lights the
      // scene for the simulator clock at the cursor.
      pos: Number.isFinite(timestampMs) ? { lat: pos.lat, lon: pos.lon, timestampMs } : { lat: pos.lat, lon: pos.lon },
      attitude: { ...(attitude || {}) },
    };
  }

  function setCursorPosition(pos, attitude = {}, shouldPan = true) {
    lastCursor = rememberCursor(pos, attitude);
    activeController()?.setCursorPosition(pos, attitude, shouldPan);
  }

  function focusEvent(event) {
    const controller = activeController();
    if (!controller) return;
    controller.focusEvent(event);
    // Focusing moves the cursor inside the controller; remember it so the
    // other view starts from the same place when the user switches.
    const cursor = controller.getLastCursor?.();
    if (cursor?.pos) {
      lastCursor = rememberCursor({ ...cursor.pos, timestampMs: cursor.pos.timestampMs ?? cursor.timestampMs }, cursor.attitude);
    }
  }

  function reset() {
    lastTimeline = null;
    lastCursor = null;
    for (const controller of Object.values(controllers)) controller?.reset?.();
  }

  function destroy() {
    lastTimeline = null;
    lastCursor = null;
    for (const controller of Object.values(controllers)) controller?.destroy?.();
  }

  function invalidateSizeStaggered() {
    activeController()?.invalidateSizeStaggered?.();
  }

  function hasMap() {
    return activeController()?.hasMap?.() === true;
  }

  return {
    applyMode,
    destroy,
    focusEvent,
    resumeFollow,
    resumeFollowAndCenter,
    getActiveMode: () => appliedMode,
    hasMap,
    invalidateSizeStaggered,
    render,
    reset,
    setCursorPosition,
  };
}
