<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { autoUpdate, flip, offset, shift, size, useFloating } from '@floating-ui/vue';

const props = defineProps({
  content: {
    type: String,
    default: '',
  },
  placement: {
    type: String,
    default: 'top',
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  tooltipClass: {
    type: [String, Array, Object],
    default: '',
  },
  anchorClass: {
    type: [String, Array, Object],
    default: '',
  },
  anchorStyle: {
    type: [String, Array, Object],
    default: '',
  },
  anchorTag: {
    type: String,
    default: 'span',
  },
  interactive: {
    type: Boolean,
    default: false,
  },
});

const reference = ref(null);
const floating = ref(null);
const open = ref(false);
const mounted = ref(false);
const viewportAdjustedStyles = ref({});
const tooltipId = `app-tooltip-${Math.random().toString(36).slice(2)}`;
let hideTimer = null;
let clampFrame = null;
const interactiveSelector = 'button,a,input,select,textarea,summary,[role="button"],[role="link"]';
const VIEWPORT_PADDING = 8;

const floatingOptions = computed(() => ({
  placement: props.placement,
  strategy: 'fixed',
  transform: false,
  middleware: [
    offset(8),
    flip({ padding: 8, rootBoundary: 'viewport' }),
    size({
      padding: 8,
      rootBoundary: 'viewport',
      apply({ availableWidth, availableHeight, elements }) {
        const viewportWidth = typeof window === 'undefined' ? availableWidth : window.innerWidth - 16;
        const clampedWidth = Math.max(120, Math.floor(Math.min(availableWidth, viewportWidth, 320)));
        const viewportHeight = typeof window === 'undefined' ? availableHeight : window.innerHeight - 16;
        const clampedHeight = Math.max(48, Math.floor(Math.min(availableHeight, viewportHeight)));
        elements.floating.style.maxWidth = `${clampedWidth}px`;
        elements.floating.style.maxHeight = `${clampedHeight}px`;
        elements.floating.style.setProperty('--app-tooltip-available-width', `${clampedWidth}px`);
        elements.floating.style.setProperty('--app-tooltip-available-height', `${clampedHeight}px`);
      },
    }),
    shift({ padding: 8, mainAxis: true, crossAxis: true, rootBoundary: 'viewport' }),
  ],
  whileElementsMounted(referenceElement, floatingElement, updatePosition) {
    return autoUpdate(referenceElement, floatingElement, () => {
      viewportAdjustedStyles.value = {};
      updatePosition();
      scheduleViewportClamp();
    });
  },
}));

const { floatingStyles, update } = useFloating(reference, floating, floatingOptions);
const clampedFloatingStyles = computed(() => ({
  ...floatingStyles.value,
  ...viewportAdjustedStyles.value,
}));

function clearHideTimer() {
  if (!hideTimer) return;
  clearTimeout(hideTimer);
  hideTimer = null;
}

function clearClampFrame() {
  if (clampFrame === null) return;
  cancelAnimationFrame(clampFrame);
  clampFrame = null;
}

function clampFloatingToViewport() {
  if (typeof window === 'undefined' || !floating.value) return;

  const element = floating.value;
  const rect = element.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  let left = Number.parseFloat(element.style.left);
  let top = Number.parseFloat(element.style.top);
  let adjusted = false;

  if (!Number.isFinite(left) || !Number.isFinite(top)) return;

  if (rect.right > viewportWidth - VIEWPORT_PADDING) {
    left -= rect.right - (viewportWidth - VIEWPORT_PADDING);
    adjusted = true;
  }
  if (rect.left < VIEWPORT_PADDING) {
    left += VIEWPORT_PADDING - rect.left;
    adjusted = true;
  }
  const availableHeight = Math.max(48, Math.floor(viewportHeight - (VIEWPORT_PADDING * 2)));
  element.style.maxHeight = `${availableHeight}px`;
  const effectiveHeight = Math.min(rect.height, availableHeight);
  const maxTop = viewportHeight - VIEWPORT_PADDING - effectiveHeight;
  const clampedTop = Math.max(VIEWPORT_PADDING, Math.min(top, maxTop));
  if (clampedTop !== top) {
    top = clampedTop;
    adjusted = true;
  }

  viewportAdjustedStyles.value = adjusted
    ? { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` }
    : {};
}

function scheduleViewportClamp() {
  if (typeof window === 'undefined') return;
  clearClampFrame();
  clampFrame = requestAnimationFrame(() => {
    clampFrame = null;
    clampFloatingToViewport();
  });
}

function updateFloatingPosition() {
  viewportAdjustedStyles.value = {};
  update?.();
  scheduleViewportClamp();
}

function show() {
  if (props.disabled) return;
  clearHideTimer();
  open.value = true;
  nextTick(updateFloatingPosition);
}

function hide() {
  clearHideTimer();
  viewportAdjustedStyles.value = {};
  open.value = false;
}

function scheduleHide() {
  clearHideTimer();
  hideTimer = setTimeout(() => {
    open.value = false;
    hideTimer = null;
  }, props.interactive ? 300 : 120);
}

function handleFocusOut() {
  nextTick(() => {
    const active = document.activeElement;
    if (reference.value?.contains?.(active) || floating.value?.contains?.(active)) return;
    hide();
  });
}

function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
  if (open.value) nextTick(updateFloatingPosition);
}

function isDisabledInteractiveElement(element) {
  return element.disabled === true || element.getAttribute?.('aria-disabled') === 'true';
}

function isEnabledInteractiveClick(event) {
  if (typeof Element === 'undefined') return false;

  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const item of path) {
    if (item instanceof Element && item.matches(interactiveSelector)) {
      return !isDisabledInteractiveElement(item);
    }
    if (item === document.body || item === document.documentElement) break;
  }

  const target = event.target;
  if (!(target instanceof Element)) return false;
  const interactive = target.closest(interactiveSelector);
  if (
    !interactive
    || (
      !reference.value?.contains?.(interactive)
      && !interactive.contains?.(reference.value)
    )
  ) {
    return false;
  }
  return !isDisabledInteractiveElement(interactive);
}

function handleClick(event) {
  if (isEnabledInteractiveClick(event)) return;
  toggle();
}

function handleKeydown(event) {
  if (event.key === 'Escape') {
    hide();
  }
}

function handleDocumentPointerDown(event) {
  if (!open.value) return;
  const target = event.target;
  if (reference.value?.contains?.(target) || floating.value?.contains?.(target)) return;
  hide();
}

onMounted(() => {
  mounted.value = true;
  document.addEventListener('pointerdown', handleDocumentPointerDown, true);
});

onBeforeUnmount(() => {
  clearHideTimer();
  clearClampFrame();
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
});
</script>

<template>
  <component
    :is="anchorTag"
    ref="reference"
    class="app-tooltip-anchor"
    :class="anchorClass"
    :style="anchorStyle"
    :aria-describedby="open && !disabled ? tooltipId : undefined"
    :aria-controls="open && !disabled && interactive ? tooltipId : undefined"
    :aria-expanded="interactive ? String(open && !disabled) : undefined"
    @mouseenter="show"
    @mouseleave="scheduleHide"
    @focusin="show"
    @focusout="handleFocusOut"
    @click="handleClick"
    @keydown="handleKeydown"
  >
    <slot />
  </component>

  <Teleport to="body" :disabled="!mounted">
    <div
      v-show="open && !disabled"
      :id="tooltipId"
      ref="floating"
      :role="interactive ? 'dialog' : 'tooltip'"
      class="app-tooltip"
      :class="[tooltipClass, { 'app-tooltip-interactive': interactive }]"
      :style="clampedFloatingStyles"
      @mouseenter="show"
      @mouseleave="scheduleHide"
      @focusin="show"
      @focusout="handleFocusOut"
      @keydown="handleKeydown"
    >
      <slot name="content">{{ content }}</slot>
    </div>
  </Teleport>
</template>
