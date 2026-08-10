import type { ViolationRuleId, ViolationRuleMap } from '../../shared/violation-rules';

/**
 * Timeline Events - Immutable flight event stream for the timeline display
 * 
 * ════════════════════════════════════════════════════════════════════════════
 * This module emits immutable events only once during analysis.
 * The UI only consumes these events - it never recomputes.
 * ════════════════════════════════════════════════════════════════════════════
 * 
 * Event Categories:
 * A. Phase Events     - Flight phase transitions (TAXI → TAKEOFF, etc.)
 * B. Violation Events - Rule breaches (high sink rate, unstable approach, etc.)
 * C. Scoring Events   - Score changes and finalizations
 * D. Markers          - Informational anchors (1000ft, 500ft, touchdown)
 * 
 * @module timeline-events
 */

'use strict';

const fs = require('fs');
const { resolveFlightLogsDir } = require('../utils/flight-logs-dir');
const timeSource = require('../core/time-source') as TimeSourceModule;
const { VIOLATION_RULE } = require('../../shared/violation-rules.js') as { VIOLATION_RULE: ViolationRuleMap };

type TimeSourceModule = {
  now: () => number;
};

// ═══════════════════════════════════════════════════════════════════════════
// Event Type Constants
// ═══════════════════════════════════════════════════════════════════════════

const TIMELINE_EVENT_TYPE = Object.freeze({
  // Phase events
  PHASE_START: 'phase_start',
  PHASE_END: 'phase_end',
  
  // Violation events
  VIOLATION_START: 'violation_start',
  VIOLATION_END: 'violation_end',
  
  // Scoring events
  SCORE_CHANGE: 'score_change',
  SCORE_FINAL: 'score_final',
  
  // Informational markers
  MARKER: 'marker',
  
  // Special
  WORST_MOMENT: 'worst_moment',
});

const MARKER_TYPE = Object.freeze({
  ALTITUDE_1000: 'altitude_1000',
  ALTITUDE_500: 'altitude_500',
  ALTITUDE_200: 'altitude_200',
  ALTITUDE_100: 'altitude_100',
  ALTITUDE_50: 'altitude_50',
  TOUCHDOWN: 'touchdown',
  ROLLOUT_START: 'rollout_start',
  ROLLOUT_END: 'rollout_end',
  GO_AROUND: 'go_around',
  // Automation state changes (informational markers, not violations)
  AP_DISCONNECT: VIOLATION_RULE.AP_DISCONNECT,
  AT_DISCONNECT: VIOLATION_RULE.AT_DISCONNECT,
});

const SEVERITY = Object.freeze({
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
});

type TimelineEventType = typeof TIMELINE_EVENT_TYPE[keyof typeof TIMELINE_EVENT_TYPE];
type TimelineViolationRule = ViolationRuleId | string;
type TimelineMarkerType = typeof MARKER_TYPE[keyof typeof MARKER_TYPE];
type TimelineSeverity = typeof SEVERITY[keyof typeof SEVERITY] | string;
type TimelineContext = Record<string, unknown>;
type TimelineMetrics = Record<string, unknown>;
type TimelineBreakdown = Record<string, unknown>;

type TimelineEventSeed = {
  event_type: TimelineEventType;
  timestamp_ms?: number;
  timestamp_utc?: string;
  timestamp_start?: number;
  timestamp_end?: number;
  phase_name?: string;
  duration_ms?: number;
  context?: TimelineContext;
  rule_id?: TimelineViolationRule | null;
  severity?: TimelineSeverity;
  metrics?: TimelineMetrics;
  score_impact?: number | null;
  reason?: string;
  score_delta?: number;
  score_type?: string;
  final_score?: number;
  breakdown?: TimelineBreakdown;
  marker_type?: TimelineMarkerType;
  worst_event_id?: string;
};

type TimelineEvent = TimelineEventSeed & {
  id: string;
  flightId: string;
  timestamp_ms: number;
  timestamp_utc: string;
};

type TimelineSummary = {
  eventId: string;
  timestamp_ms: number;
  reason: string | null | undefined;
  scoreImpact: number;
};

type TimelineSnapshot = {
  flightId: string;
  events: TimelineEvent[];
  eventCount: number;
  worstMoment: TimelineSummary | null;
  finalizedAt: number;
};

type TimelineStoreOptions = {
  flightId?: string;
  timeNow?: () => number;
};

type TimelineStore = {
  recordPhaseChange: (newPhase: string, context?: TimelineContext) => void;
  startViolation: (ruleId: TimelineViolationRule, severity: TimelineSeverity, metrics?: TimelineMetrics) => void;
  endViolation: (ruleId: TimelineViolationRule, scoreImpact?: number | null) => TimelineEvent | undefined;
  recordScoreChange: (
    reason: string,
    scoreDelta: number,
    ruleId?: TimelineViolationRule | null,
    context?: TimelineContext,
  ) => TimelineEvent;
  recordScoreFinal: (scoreType: string, finalScore: number, breakdown?: TimelineBreakdown) => TimelineEvent;
  recordMarker: (markerType: TimelineMarkerType, context?: TimelineContext) => TimelineEvent | null;
  finalize: () => TimelineSnapshot;
  getTimeline: () => TimelineSnapshot;
  getEventsInWindow: (startMs: number, endMs: number) => TimelineEvent[];
  reset: () => void;
  readonly events: TimelineEvent[];
  readonly currentPhase: string | null;
  readonly worstMoment: TimelineEvent | null;
};

// ═══════════════════════════════════════════════════════════════════════════
// Timeline Event Store (per-flight, in-memory)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Factory to create an isolated timeline store for a single flight.
 * @param {Object} options
 * @param {string} options.flightId - Flight identifier
 * @param {() => number} [options.timeNow] - Injectable time source
 * @returns {TimelineStore}
 */
function createTimelineStore(options: TimelineStoreOptions = {}): TimelineStore {
  const flightId = options.flightId || 'unknown';
  const getNow = options.timeNow || (() => timeSource.now());
  
  // Cap events to prevent unbounded growth during long flights.
  // At 10 Hz with sparse event emission, 10 000 covers ~16+ hrs comfortably.
  const MAX_EVENTS = 10000;
  
  /** @type {Array<TimelineEvent>} */
  const events: TimelineEvent[] = [];

  /** @type {number} */
  let nextEventSequence = 0;
  
  /** @type {Map<string, TimelineEvent>} */
  const activeViolations = new Map<string, TimelineEvent>();
  
  /** @type {string|null} */
  let currentPhase: string | null = null;
  
  /** @type {number|null} */
  let phaseStartTs: number | null = null;
  
  /** @type {number} */
  let worstMomentScore = 0;
  
  /** @type {TimelineEvent|null} */
  let worstMomentEvent: TimelineEvent | null = null;
  
  // Debounce tracking for markers (prevent spam)
  const markerCooldowns = new Map<TimelineMarkerType, number>();
  const MARKER_COOLDOWN_MS = 2000;
  
  /**
   * Add a raw event to the store.
   * @private
   */
  function addEvent(event: TimelineEventSeed): TimelineEvent {
    const timestampMs = event.timestamp_ms ?? getNow();
    const fullEvent: TimelineEvent = {
      ...event,
      id: `${flightId}-${nextEventSequence}`,
      flightId,
      timestamp_ms: timestampMs,
      timestamp_utc: event.timestamp_utc || new Date(timestampMs).toISOString(),
    };
    nextEventSequence += 1;
    events.push(fullEvent);
    
    // Evict oldest events when cap is reached (keep recent history)
    if (events.length > MAX_EVENTS) {
      events.splice(0, events.length - MAX_EVENTS);
    }
    
    return fullEvent;
  }
  
  /**
   * Record a phase transition.
   */
  function recordPhaseChange(newPhase: string, context: TimelineContext = {}): void {
    const now = getNow();
    
    // End previous phase
    if (currentPhase && phaseStartTs !== null) {
      addEvent({
        event_type: TIMELINE_EVENT_TYPE.PHASE_END,
        phase_name: currentPhase,
        timestamp_ms: now,
        duration_ms: now - phaseStartTs,
        context,
      });
    }
    
    // Start new phase
    currentPhase = newPhase;
    phaseStartTs = now;
    
    addEvent({
      event_type: TIMELINE_EVENT_TYPE.PHASE_START,
      phase_name: newPhase,
      timestamp_ms: now,
      context,
    });
  }
  
  /**
   * Start a violation (rule breach began).
   */
  function startViolation(
    ruleId: TimelineViolationRule,
    severity: TimelineSeverity,
    metrics: TimelineMetrics = {},
  ): void {
    if (activeViolations.has(ruleId)) return; // Already active
    
    const now = getNow();
    const event = addEvent({
      event_type: TIMELINE_EVENT_TYPE.VIOLATION_START,
      rule_id: ruleId,
      severity,
      timestamp_ms: now,
      metrics, // Recorded values at violation start
    });
    
    activeViolations.set(ruleId, event);
  }
  
  /**
   * End a violation (rule breach ended).
   */
  function endViolation(
    ruleId: TimelineViolationRule,
    scoreImpact: number | null = null,
  ): TimelineEvent | undefined {
    const startEvent = activeViolations.get(ruleId);
    if (!startEvent) return; // Wasn't active
    
    const now = getNow();
    const duration_ms = now - startEvent.timestamp_ms;
    
    const endEvent = addEvent({
      event_type: TIMELINE_EVENT_TYPE.VIOLATION_END,
      rule_id: ruleId,
      severity: startEvent.severity,
      timestamp_start: startEvent.timestamp_ms,
      timestamp_end: now,
      duration_ms,
      score_impact: scoreImpact,
    });
    
    activeViolations.delete(ruleId);
    
    // Track worst moment (highest negative impact)
    if (scoreImpact != null && scoreImpact < worstMomentScore) {
      worstMomentScore = scoreImpact;
      worstMomentEvent = endEvent;
    }
    
    return endEvent;
  }
  
  /**
   * Record a scoring event (penalty or bonus applied).
   */
  function recordScoreChange(
    reason: string,
    scoreDelta: number,
    ruleId: TimelineViolationRule | null = null,
    context: TimelineContext = {},
  ): TimelineEvent {
    const event = addEvent({
      event_type: TIMELINE_EVENT_TYPE.SCORE_CHANGE,
      reason,
      score_delta: scoreDelta,
      rule_id: ruleId,
      timestamp_ms: getNow(),
      context,
    });
    
    // Track worst moment
    if (scoreDelta < worstMomentScore) {
      worstMomentScore = scoreDelta;
      worstMomentEvent = event;
    }
    
    return event;
  }
  
  /**
   * Record final score (landing, stability, etc.).
   */
  function recordScoreFinal(
    scoreType: string,
    finalScore: number,
    breakdown: TimelineBreakdown = {},
  ): TimelineEvent {
    return addEvent({
      event_type: TIMELINE_EVENT_TYPE.SCORE_FINAL,
      score_type: scoreType,
      final_score: finalScore,
      breakdown,
      timestamp_ms: getNow(),
    });
  }
  
  /**
   * Record an informational marker (sparse, intentional anchors).
   */
  function recordMarker(
    markerType: TimelineMarkerType,
    context: TimelineContext = {},
  ): TimelineEvent | null {
    const now = getNow();
    
    // Debounce to prevent spam
    const lastMarker = markerCooldowns.get(markerType);
    if (lastMarker && (now - lastMarker) < MARKER_COOLDOWN_MS) {
      return null;
    }
    markerCooldowns.set(markerType, now);
    
    return addEvent({
      event_type: TIMELINE_EVENT_TYPE.MARKER,
      marker_type: markerType,
      timestamp_ms: now,
      context,
    });
  }
  
  /**
   * Finalize the timeline and compute worst moment.
   * Call this when the flight ends.
   */
  function finalize(): TimelineSnapshot {
    // Close any remaining active violations
    for (const [ruleId] of activeViolations) {
      endViolation(ruleId, null);
    }
    
    // Emit worst moment event if we have one
    if (worstMomentEvent) {
      addEvent({
        event_type: TIMELINE_EVENT_TYPE.WORST_MOMENT,
        timestamp_ms: worstMomentEvent.timestamp_ms,
        worst_event_id: worstMomentEvent.id,
        reason: worstMomentEvent.reason || worstMomentEvent.rule_id || 'unknown',
        score_impact: worstMomentScore,
      });
    }
    
    return getTimeline();
  }
  
  /**
   * Get all events (immutable snapshot).
   */
  function getTimeline(): TimelineSnapshot {
    return {
      flightId,
      events: [...events],
      eventCount: events.length,
      worstMoment: worstMomentEvent ? {
        eventId: worstMomentEvent.id,
        timestamp_ms: worstMomentEvent.timestamp_ms,
        reason: worstMomentEvent.reason || worstMomentEvent.rule_id,
        scoreImpact: worstMomentScore,
      } : null,
      finalizedAt: getNow(),
    };
  }
  
  /**
   * Get events within a time window.
   */
  function getEventsInWindow(startMs: number, endMs: number): TimelineEvent[] {
    return events.filter(e => {
      const ts = e.timestamp_ms ?? e.timestamp_start;
      return typeof ts === 'number' && ts >= startMs && ts <= endMs;
    });
  }
  
  /**
   * Reset the store (for testing).
   */
  function reset(): void {
    events.length = 0;
    nextEventSequence = 0;
    activeViolations.clear();
    currentPhase = null;
    phaseStartTs = null;
    worstMomentScore = 0;
    worstMomentEvent = null;
    markerCooldowns.clear();
  }
  
  return {
    // Recording API
    recordPhaseChange,
    startViolation,
    endViolation,
    recordScoreChange,
    recordScoreFinal,
    recordMarker,
    finalize,
    
    // Query API
    getTimeline,
    getEventsInWindow,
    
    // Lifecycle
    reset,
    
    // Direct access (for advanced usage)
    get events() { return events; },
    get currentPhase() { return currentPhase; },
    get worstMoment() { return worstMomentEvent; },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Module-level singleton store (for current flight)
// ═══════════════════════════════════════════════════════════════════════════

let activeStore: TimelineStore | null = null;

/**
 * Start a new timeline for a flight.
 */
function startTimeline(flightId: string): TimelineStore {
  if (activeStore) {
    // Finalize previous timeline before starting new one
    activeStore.finalize();
  }
  activeStore = createTimelineStore({ flightId });
  return activeStore;
}

/**
 * Get the active timeline store (or null if none).
 */
function getActiveStore(): TimelineStore | null {
  return activeStore;
}

/**
 * Finalize and close the active timeline.
 */
function endTimeline(): TimelineSnapshot | null {
  if (!activeStore) return null;
  const result = activeStore.finalize();
  activeStore = null;
  return result;
}

/**
 * Check if timeline recording is active.
 */
function isRecording(): boolean {
  return activeStore !== null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Convenience functions that delegate to active store
// ═══════════════════════════════════════════════════════════════════════════

function recordPhaseChange(newPhase: string, context?: TimelineContext): void {
  if (activeStore) activeStore.recordPhaseChange(newPhase, context);
}

function startViolation(
  ruleId: TimelineViolationRule,
  severity: TimelineSeverity,
  metrics?: TimelineMetrics,
): void {
  if (activeStore) activeStore.startViolation(ruleId, severity, metrics);
}

function endViolation(ruleId: TimelineViolationRule, scoreImpact?: number | null): TimelineEvent | undefined {
  if (activeStore) return activeStore.endViolation(ruleId, scoreImpact);
}

function recordScoreChange(
  reason: string,
  scoreDelta: number,
  ruleId?: TimelineViolationRule | null,
  context?: TimelineContext,
): TimelineEvent | undefined {
  if (activeStore) return activeStore.recordScoreChange(reason, scoreDelta, ruleId, context);
}

function recordScoreFinal(
  scoreType: string,
  finalScore: number,
  breakdown?: TimelineBreakdown,
): TimelineEvent | undefined {
  if (activeStore) return activeStore.recordScoreFinal(scoreType, finalScore, breakdown);
}

function recordMarker(
  markerType: TimelineMarkerType,
  context?: TimelineContext,
): TimelineEvent | null | undefined {
  if (activeStore) return activeStore.recordMarker(markerType, context);
}

function getTimeline(): TimelineSnapshot | null {
  if (activeStore) return activeStore.getTimeline();
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Timeline Persistence
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the directory for timeline files (same as flight logs).
 */
function getTimelineDir(): string {
  const flightLogsDir = resolveFlightLogsDir();

  if (!fs.existsSync(flightLogsDir)) {
    fs.mkdirSync(flightLogsDir, { recursive: true });
  }

  return flightLogsDir;
}

/**
 * Save a timeline to a JSON file.
 * @param {Object} timeline - Timeline data from getTimeline() or finalize()
 * @param {string} csvFilePath - Path to the companion CSV file (uses same base name)
 * @returns {{ success: boolean, filePath?: string, error?: string }}
 */
// ═══════════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  // Constants
  TIMELINE_EVENT_TYPE,
  VIOLATION_RULE,
  MARKER_TYPE,
  SEVERITY,
  
  // Factory
  createTimelineStore,
  
  // Singleton management
  startTimeline,
  endTimeline,
  getActiveStore,
  isRecording,
  
  // Convenience recording functions
  recordPhaseChange,
  startViolation,
  endViolation,
  recordScoreChange,
  recordScoreFinal,
  recordMarker,
  getTimeline,
  
  // Directory utility
  getTimelineDir,
};

export {};
