import { onBeforeUnmount, onMounted } from 'vue';

const CSS_VARIABLES = Object.freeze([
  '--ff-visual-viewport-height',
  '--ff-visual-viewport-offset-top',
  '--ff-keyboard-inset',
]);

function finiteNonNegative(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : fallback;
}

export function installVisualViewportCssVars({
  windowRef = typeof window === 'undefined' ? null : window,
  documentRef = typeof document === 'undefined' ? null : document,
} = {}) {
  const root = documentRef?.documentElement;
  if (!root?.style || !windowRef) return () => {};

  const visualViewport = windowRef.visualViewport || null;
  const update = () => {
    const layoutHeight = finiteNonNegative(windowRef.innerHeight);
    const height = finiteNonNegative(visualViewport?.height, layoutHeight);
    const offsetTop = finiteNonNegative(visualViewport?.offsetTop);
    const keyboardInset = Math.max(0, layoutHeight - height - offsetTop);

    root.style.setProperty('--ff-visual-viewport-height', `${height}px`);
    root.style.setProperty('--ff-visual-viewport-offset-top', `${offsetTop}px`);
    root.style.setProperty('--ff-keyboard-inset', `${keyboardInset}px`);
  };

  visualViewport?.addEventListener?.('resize', update);
  visualViewport?.addEventListener?.('scroll', update);
  windowRef.addEventListener?.('orientationchange', update);
  windowRef.addEventListener?.('resize', update);
  update();

  return () => {
    visualViewport?.removeEventListener?.('resize', update);
    visualViewport?.removeEventListener?.('scroll', update);
    windowRef.removeEventListener?.('orientationchange', update);
    windowRef.removeEventListener?.('resize', update);
    for (const variable of CSS_VARIABLES) root.style.removeProperty(variable);
  };
}

export function useVisualViewportCssVars() {
  let cleanup = () => {};

  onMounted(() => {
    cleanup = installVisualViewportCssVars();
  });

  onBeforeUnmount(() => {
    cleanup();
    cleanup = () => {};
  });
}
