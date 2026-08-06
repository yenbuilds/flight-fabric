import { watch } from 'vue';

export function attachTimelinePfdOverlayFitter({
  pfdOverlay,
  timelineStore,
  windowRef = window,
  ResizeObserverRef = typeof ResizeObserver !== 'undefined' ? ResizeObserver : null,
} = {}) {
  if (!pfdOverlay) return null;

  const pfdMapWrap = pfdOverlay.closest('.timeline-map-wrap');
  const PFD_BOTTOM = 8;
  const PFD_TOP_GAP = 8;
  const PFD_MIN_SCALE = 0.55;

  let cachedNaturalHeight = 0;

  function isCollapsed() {
    return timelineStore.pfdCollapsed === true;
  }

  function setOverlayScale(scale) {
    timelineStore.setPfdState({ scale });
  }

  function measureNaturalHeight() {
    if (isCollapsed()) return cachedNaturalHeight;
    const height = pfdOverlay.offsetHeight;
    if (height > 0) cachedNaturalHeight = height;
    return cachedNaturalHeight;
  }

  function fitPfdOverlayToMap() {
    if (!pfdMapWrap) return;
    const wrapHeight = pfdMapWrap.clientHeight;
    if (!wrapHeight) return;

    if (isCollapsed()) {
      setOverlayScale('1');
      return;
    }

    const naturalHeight = measureNaturalHeight();
    if (!naturalHeight) return;

    const available = Math.max(0, wrapHeight - PFD_BOTTOM - PFD_TOP_GAP);
    let scale = 1;
    if (naturalHeight > available) {
      scale = Math.max(PFD_MIN_SCALE, available / naturalHeight);
    }
    setOverlayScale(scale.toFixed(3));
  }

  const stopCollapsedWatch = watch(
    () => timelineStore.pfdCollapsed,
    () => {
      windowRef.requestAnimationFrame(() => {
        cachedNaturalHeight = 0;
        fitPfdOverlayToMap();
      });
    },
  );

  const handleResize = () => {
    windowRef.requestAnimationFrame(fitPfdOverlayToMap);
  };
  windowRef.addEventListener('resize', handleResize);

  let resizeObserver = null;
  if (pfdMapWrap && typeof ResizeObserverRef === 'function') {
    resizeObserver = new ResizeObserverRef(() => {
      windowRef.requestAnimationFrame(fitPfdOverlayToMap);
    });
    resizeObserver.observe(pfdMapWrap);
  }

  windowRef.requestAnimationFrame(fitPfdOverlayToMap);
  return {
    fit: fitPfdOverlayToMap,
    destroy() {
      stopCollapsedWatch?.();
      windowRef.removeEventListener('resize', handleResize);
      resizeObserver?.disconnect?.();
      timelineStore.setPfdState({ scale: '1' });
    },
  };
}
