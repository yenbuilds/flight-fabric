<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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
  triggerMode: { type: String, default: 'hover', validator: value => ['hover', 'click'].includes(value) },
  label: { type: String, default: '' },
});

const reference = ref(null);
const floating = ref(null);
const open = ref(false);
const mounted = ref(false);
const viewportAdjustedStyles = ref({});
const tooltipId = `app-tooltip-${Math.random().toString(36).slice(2)}`;
let hideTimer = null;
let showTimer = null;
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

// v-show preserves slotted content. Only an open tooltip needs positioning
// observers; aircraft pages can contain hundreds of otherwise hidden hints.
const positioningEnabled = computed(() => open.value && mounted.value && !props.disabled);
const { floatingStyles, update } = useFloating(
  computed(() => positioningEnabled.value ? reference.value : null),
  computed(() => positioningEnabled.value ? floating.value : null), {
  open: positioningEnabled,
  placement: computed(() => props.placement),
  strategy: 'fixed',
  transform: false,
  middleware: computed(() => floatingOptions.value.middleware),
  whileElementsMounted: floatingOptions.value.whileElementsMounted,
});
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
  if (typeof window === 'undefined' || !floating.value || !positioningEnabled.value) return;

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
  clearShowTimer();
  clearHideTimer();
  open.value = true;
  nextTick(updateFloatingPosition);
}

function clearShowTimer() {
  if (showTimer === null) return;
  clearTimeout(showTimer);
  showTimer = null;
}

function scheduleShow() {
  clearHideTimer();
  clearShowTimer();
  if (open.value) return;
  showTimer = setTimeout(show, 180);
}

function hide() {
  clearShowTimer();
  clearHideTimer();
  viewportAdjustedStyles.value = {};
  open.value = false;
}

function scheduleHide() {
  clearShowTimer();
  clearHideTimer();
  hideTimer = setTimeout(() => {
    open.value = false;
    hideTimer = null;
  }, props.interactive ? 300 : 120);
}

function handleFocusOut(event) {
  // Native pointer focus changes can run Vue's nextTick before the browser
  // focuses the new element. Keep internal moves open through that transition
  // so the clicked control is still present when mouseup/click arrives.
  const next = event.relatedTarget;
  // Disabling the focused action while saving must not dismiss its progress.
  // Outside pointers still close the popover separately.
  if (props.interactive && !next && event.target?.disabled === true) return;
  if (reference.value?.contains?.(next) || floating.value?.contains?.(next)) return;
  nextTick(() => {
    const active = document.activeElement;
    if (reference.value?.contains?.(active) || floating.value?.contains?.(active)) return;
    hide();
  });
}

function toggle() {
  if (props.disabled) return;
  clearShowTimer();
  clearHideTimer();
  open.value = !open.value;
  if (open.value) nextTick(() => {
    updateFloatingPosition();
    if (props.triggerMode === 'click' && props.interactive) floating.value?.focus({ preventScroll: true });
  });
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
  if (open.value && props.triggerMode === 'click' && event.key === 'Tab'
    && document.activeElement === floating.value) {
    const first = floating.value.querySelector('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled)');
    event.preventDefault();
    if (!event.shiftKey && first) first.focus({ preventScroll: true });
    else reference.value?.querySelector('button')?.focus({ preventScroll: true });
    return;
  }
  if (event.key === 'Escape' && open.value) {
    event.preventDefault();
    event.stopPropagation();
    hide();
    if (props.triggerMode === 'click') reference.value?.querySelector('button')?.focus({ preventScroll: true });
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

watch([open, mounted], ([isOpen, isMounted]) => {
  if (typeof document === 'undefined') return;
  if (isOpen && isMounted) document.addEventListener('keydown', handleKeydown, true);
  else document.removeEventListener('keydown', handleKeydown, true);
});

watch(() => props.disabled, disabled => {
  if (disabled) hide();
});

onBeforeUnmount(() => {
  clearHideTimer();
  clearShowTimer();
  clearClampFrame();
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
  document.removeEventListener('keydown', handleKeydown, true);
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
    @mouseenter="triggerMode === 'hover' && scheduleShow()"
    @mouseleave="triggerMode === 'hover' && scheduleHide()"
    @focusin="triggerMode === 'hover' && show()"
    @focusout="handleFocusOut"
    @click="handleClick"
    @keydown="handleKeydown"
  >
    <slot :tooltip-id="tooltipId" :open="open && !disabled" :toggle="toggle" />
  </component>

  <Teleport to="body" :disabled="!mounted">
    <div
      v-show="open && !disabled"
      :id="tooltipId"
      ref="floating"
      :role="interactive ? 'dialog' : 'tooltip'"
      :aria-label="interactive && label ? label : undefined"
      :tabindex="interactive && triggerMode === 'click' ? -1 : undefined"
      class="app-tooltip"
      :class="[tooltipClass, { 'app-tooltip-interactive': interactive }]"
      :style="clampedFloatingStyles"
      @mouseenter="triggerMode === 'hover' && show()"
      @mouseleave="triggerMode === 'hover' && scheduleHide()"
      @focusin="triggerMode === 'hover' && show()"
      @focusout="handleFocusOut"
      @keydown="handleKeydown"
    >
      <slot name="content">{{ content }}</slot>
    </div>
  </Teleport>
</template>
