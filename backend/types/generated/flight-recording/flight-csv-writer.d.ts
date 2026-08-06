/**
 * Flight CSV Writer - authoritative append-only flight record.
 *
 * This module owns durable flight recording. It writes telemetry samples and
 * sparse event rows into the V1 CSV schema from `schema-field-map.ts`; downstream
 * features such as timeline replay, logbook summaries, sharing cards, analytics,
 * and debugging are all consumers of this file, not competing sources of truth.
 *
 * Data-integrity rules:
 * - Start failure means the flight cannot be treated as durably recorded.
 * - Rows are schema-built and CSV-escaped here before they touch disk.
 * - LANDING, GO_AROUND, warning, and violation rows are intentionally persisted
 *   beside SAMPLE rows because replay needs the live event context.
 * - Route-based filename updates must not drop rows; inline writes are buffered
 *   while a rename is in progress, and worker writes are serialized by request.
 * - Disk exhaustion fails closed and emits a storage warning so the UI can tell
 *   the user that only a partial authoritative record exists.
 *
 * This is not an export helper. Treat it as the flight recorder.
 */
export {};
