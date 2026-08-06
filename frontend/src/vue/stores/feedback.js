import { defineStore } from 'pinia';

function normalizeText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeKind(kind) {
  return typeof kind === 'string' && kind.trim() ? kind.trim() : 'success';
}

export const useFeedbackStore = defineStore('feedback', {
  state: () => ({
    toast: {
      visible: false,
      entered: false,
      kind: 'success',
      title: 'Completed',
      message: 'Action applied.',
    },
  }),

  getters: {
    toastClass: (state) => [
      'app-feedback-toast',
      `app-feedback-toast--${state.toast.kind || 'success'}`,
      state.toast.visible ? '' : 'hidden',
      state.toast.entered ? 'is-visible' : '',
    ].filter(Boolean).join(' '),
    toastTitle: (state) => state.toast.title || 'Completed',
    toastMessage: (state) => state.toast.message || 'Action applied.',
  },

  actions: {
    showToast({ kind = 'success', title = 'Completed', message = 'Action applied.' } = {}) {
      this.toast = {
        visible: true,
        entered: false,
        kind: normalizeKind(kind),
        title: normalizeText(title, 'Completed'),
        message: normalizeText(message, 'Action applied.'),
      };
    },
    setToastEntered(entered) {
      this.toast.entered = entered === true;
    },
    hideToast() {
      this.toast.visible = false;
      this.toast.entered = false;
    },
  },
});
