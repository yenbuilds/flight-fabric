/**
 * Recording Session Manager
 *
 * Flight data is automatically written to the resolved Flight Fabric logs folder.
 *
 * This module now provides a minimal interface for UI compatibility.
 */

'use strict';

const { EventEmitter } = require('events') as typeof import('events');
const timeSource = require('../core/time-source.js') as {
  now: () => number;
};

type RecordingState = {
  isRecording: boolean;
  sessionId: string | null;
  startedAt: number | null;
  sampleCount: number;
  lastError: string | null;
};

class RecordingSession extends EventEmitter {
  state: RecordingState;

  constructor() {
    super();
    this.state = {
      isRecording: false,
      sessionId: null,
      startedAt: null,
      sampleCount: 0,
      lastError: null,
    };
  }

  getState(): RecordingState {
    return { ...this.state };
  }

  markStarted(flightId: string): void {
    this.state = {
      isRecording: true,
      sessionId: flightId,
      startedAt: timeSource.now(),
      sampleCount: 0,
      lastError: null,
    };
  }

  markStopped(): void {
    this.state.isRecording = false;
    this.state.sampleCount = 0;
  }

  incrementSampleCount(): void {
    if (this.state.isRecording) {
      this.state.sampleCount++;
    }
  }
}

const recordingSession = new RecordingSession();

module.exports = recordingSession;

export {};