<script setup>
import {
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  modalId: { type: String, required: true },
  eyebrow: { type: String, default: '' },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  closeLabel: { type: String, default: 'Close quick group' },
});

const emit = defineEmits(['close']);
const mounted = ref(false);
const dialog = ref(null);
const closeButton = ref(null);
let returnFocus = null;

const titleId = `${props.modalId}-title`;
const descriptionId = `${props.modalId}-description`;

function requestClose() {
  emit('close');
}

function focusableElements() {
  return Array.from(dialog.value?.querySelectorAll?.(
    'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  ) || []).filter((element) => element.getClientRects?.().length > 0);
}

function handleKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    requestClose();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = focusableElements();
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.value?.focus?.();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

watch(() => props.open, async (open) => {
  if (typeof document === 'undefined') return;
  if (open) {
    returnFocus = document.activeElement;
    await nextTick();
    closeButton.value?.focus?.({ preventScroll: true });
    return;
  }

  const target = returnFocus;
  returnFocus = null;
  await nextTick();
  target?.focus?.({ preventScroll: true });
}, { flush: 'post' });

onMounted(() => {
  mounted.value = true;
});

onBeforeUnmount(() => {
  returnFocus?.focus?.({ preventScroll: true });
  returnFocus = null;
});
</script>

<template>
  <Teleport to="body" :disabled="!mounted">
    <div
      v-show="open"
      :id="modalId"
      class="aircraft-hot-group-backdrop ff-keyboard-safe-overlay"
      data-aircraft-hot-group-modal
      data-no-swipe
      @click.self="requestClose"
      @keydown="handleKeydown"
    >
      <section
        ref="dialog"
        class="aircraft-hot-group-dialog"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="description ? descriptionId : undefined"
        tabindex="-1"
      >
        <header class="aircraft-hot-group-header">
          <div class="aircraft-hot-group-heading">
            <div v-if="eyebrow" class="aircraft-hot-group-eyebrow">{{ eyebrow }}</div>
            <h4 :id="titleId">{{ title }}</h4>
            <p v-if="description" :id="descriptionId">{{ description }}</p>
          </div>
          <div class="aircraft-hot-group-header-actions">
            <slot name="status" />
            <button
              ref="closeButton"
              type="button"
              class="aircraft-hot-group-close"
              :aria-label="closeLabel"
              @click="requestClose"
            >&times;</button>
          </div>
        </header>

        <div class="aircraft-hot-group-body">
          <slot />
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.aircraft-hot-group-backdrop {
  position: fixed;
  inset: 0;
  z-index: 150;
  display: grid;
  block-size: var(--ff-visual-viewport-height, 100dvh);
  place-items: center;
  padding: max(1rem, env(safe-area-inset-top, 0px)) max(1rem, env(safe-area-inset-right, 0px)) max(1rem, env(safe-area-inset-bottom, 0px)) max(1rem, env(safe-area-inset-left, 0px));
  background: rgb(2 6 12 / 0.82);
  backdrop-filter: blur(5px);
  overscroll-behavior: contain;
}

.aircraft-hot-group-dialog {
  display: flex;
  width: min(72rem, 100%);
  max-height: min(48rem, calc(var(--ff-visual-viewport-height, 100dvh) - 2rem));
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgb(var(--border-strong) / 0.92);
  border-radius: 14px;
  background: rgb(var(--panel) / 0.99);
  box-shadow: 0 28px 80px rgb(0 0 0 / 0.58);
  color: rgb(var(--foreground));
}

.aircraft-hot-group-header {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1rem 0.9rem;
  border-bottom: 1px solid rgb(var(--border) / 0.78);
  background: linear-gradient(135deg, rgb(var(--primary) / 0.1), transparent 52%);
}

.aircraft-hot-group-heading {
  min-width: 0;
}

.aircraft-hot-group-eyebrow {
  color: rgb(var(--primary));
  font-family: var(--ff-font-mono);
  font-size: 0.58rem;
  font-weight: 750;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.aircraft-hot-group-heading h4 {
  margin-top: 0.25rem;
  color: rgb(var(--foreground));
  font-size: 1.08rem;
  font-weight: 720;
  line-height: 1.25;
}

.aircraft-hot-group-heading p {
  max-width: 48rem;
  margin-top: 0.3rem;
  color: rgb(var(--muted-foreground));
  font-size: 0.68rem;
  line-height: 1.55;
}

.aircraft-hot-group-header-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.65rem;
}

.aircraft-hot-group-close {
  display: grid;
  width: 2.6rem;
  height: 2.6rem;
  place-items: center;
  border: 1px solid rgb(var(--border-strong) / 0.82);
  border-radius: 9px;
  background: rgb(var(--panel-elevated) / 0.72);
  color: rgb(var(--muted-foreground));
  font-size: 1.25rem;
  line-height: 1;
}

.aircraft-hot-group-close:hover,
.aircraft-hot-group-close:focus-visible {
  border-color: rgb(var(--primary) / 0.65);
  color: rgb(var(--foreground));
}

.aircraft-hot-group-body {
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
  padding: 1rem;
  overscroll-behavior: contain;
}

@media (max-width: 760px) {
  .aircraft-hot-group-backdrop {
    place-items: stretch;
    padding: 0;
    background: rgb(2 6 12 / 0.94);
    backdrop-filter: none;
  }

  .aircraft-hot-group-dialog {
    width: 100%;
    max-height: none;
    height: var(--ff-visual-viewport-height, 100dvh);
    border: 0;
    border-radius: 0;
  }

  .aircraft-hot-group-header {
    gap: 0.7rem;
    padding: max(0.8rem, env(safe-area-inset-top, 0px)) 0.8rem 0.75rem;
  }

  .aircraft-hot-group-heading h4 {
    font-size: 1rem;
  }

  .aircraft-hot-group-heading p {
    font-size: 0.64rem;
  }

  .aircraft-hot-group-header-actions {
    gap: 0.45rem;
  }

  .aircraft-hot-group-close {
    width: 2.75rem;
    height: 2.75rem;
  }

  .aircraft-hot-group-body {
    padding: 0.75rem max(0.75rem, env(safe-area-inset-right, 0px)) max(1rem, env(safe-area-inset-bottom, 0px)) max(0.75rem, env(safe-area-inset-left, 0px));
  }
}
</style>
