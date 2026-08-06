// Centralized helpers for timestamp and event ID generation.

const timeSource = require('./time-source.js') as typeof import('./time-source');

/**
 * Convert an epoch timestamp to an ISO 8601 string.
 */
export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Build a stable event identifier from a prefix and timestamp.
 */
export function createEventId(prefix: string, timestampMs = timeSource.now()): string {
  return `${prefix}-${timestampMs}`;
}
