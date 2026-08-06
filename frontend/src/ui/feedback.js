// App-wide toast helper.

export function createAppFeedback({ windowRef = window, feedbackStore = null } = {}) {
  let toastTimer = null;
  let toastHideTimer = null;

  function requestFrame(callback) {
    if (typeof windowRef.requestAnimationFrame === 'function') {
      windowRef.requestAnimationFrame(callback);
      return;
    }
    windowRef.setTimeout(callback, 0);
  }

  function showToast(kind, title, message, options = {}) {
    const resolvedKind = typeof kind === 'string' && kind.trim() ? kind.trim() : 'success';
    const durationMs = Number.isFinite(Number(options.durationMs)) ? Number(options.durationMs) : 4200;

    feedbackStore?.showToast?.({
      kind: resolvedKind,
      title,
      message,
    });
    requestFrame(() => feedbackStore?.setToastEntered?.(true));

    windowRef.clearTimeout(toastTimer);
    windowRef.clearTimeout(toastHideTimer);
    toastTimer = windowRef.setTimeout(() => {
      feedbackStore?.setToastEntered?.(false);
      toastHideTimer = windowRef.setTimeout(() => {
        feedbackStore?.hideToast?.();
      }, 180);
    }, Math.max(1200, durationMs));
  }
  return {
    showToast,
  };
}
