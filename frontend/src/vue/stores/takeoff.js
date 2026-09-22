import { defineStore } from 'pinia';
import {
  buildTakeoffPresentation,
  buildTakeoffPreview,
  createDefaultTakeoffCardState,
} from '../../takeoff/presentation.js';

export const useTakeoffStore = defineStore('takeoff', {
  state: () => ({
    cardVisible: false,
    waitingVisible: true,
    // A liftoff has been seen and the climb-out is still being scored.
    pending: false,
    // The aircraft settled back onto the runway; the same takeoff continues
    // at the next liftoff.
    pendingSettled: false,
    lastMessage: null,
    takeoffCard: createDefaultTakeoffCardState(),
  }),

  getters: {
    takeoffGradeStyle: (state) => ({
      color: state.takeoffCard.gradeColor,
    }),

    waitingDescription: (state) => (
      state.pending
        ? (state.pendingSettled
          ? 'Settled back onto the runway. Waiting for the next liftoff…'
          : 'Liftoff detected. Scoring the climb-out…')
        : 'No scored takeoff in this session yet.'
    ),

    preview: (state) => buildTakeoffPreview(state.takeoffCard, {
      available: state.cardVisible,
      pending: state.pending,
      settled: state.pendingSettled,
    }),
  },

  actions: {
    setTakeoffCardVisible(visible) {
      this.cardVisible = visible === true;
      this.waitingVisible = this.cardVisible !== true;
    },

    resetTakeoffCard() {
      this.setTakeoffCardVisible(false);
      this.pending = false;
      this.pendingSettled = false;
      this.lastMessage = null;
      this.takeoffCard = createDefaultTakeoffCardState();
    },

    /**
     * Handle a `takeoff` WebSocket message. The liftoff packet (`final: false`)
     * only marks the pending state, a `settled` packet keeps it with different
     * copy, a `cancelled` packet clears it, and the scored packet replaces the
     * card.
     */
    handleTakeoffMessage(msg) {
      if (!msg || typeof msg !== 'object') return false;
      if (msg.final === false) {
        if (msg.cancelled === true) {
          this.pending = false;
          this.pendingSettled = false;
          return false;
        }
        this.pending = true;
        this.pendingSettled = msg.settled === true;
        return false;
      }
      if (msg.final !== true) return false;
      return this.applyTakeoffCardMessage(msg);
    },

    applyTakeoffCardMessage(msg, options = {}) {
      if (!msg || typeof msg !== 'object') return false;
      this.takeoffCard = buildTakeoffPresentation(msg, {
        previousNonce: this.takeoffCard.gradeAnimationNonce,
        capturedAtMs: options.capturedAtMs ?? null,
      });
      this.lastMessage = msg;
      this.pending = false;
      this.pendingSettled = false;
      this.setTakeoffCardVisible(true);
      return true;
    },
  },
});
