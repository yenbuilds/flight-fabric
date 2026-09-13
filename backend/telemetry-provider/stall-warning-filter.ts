export const STALL_WARNING_ENTRY_MS = 1000;

/** Confirm a continuous simulator warning, not a stall inferred from IAS.
 * Pauses, ground contact, missing data and sample gaps break confirmation. */
export class StallWarningFilter {
  private sinceMs: number | null = null;
  private lastMs: number | null = null;

  update(warning: unknown, valid: boolean, onGround: unknown, nowMs: number): boolean {
    const gap = this.lastMs == null ? null : nowMs - this.lastMs;
    this.lastMs = nowMs;
    if (!valid || !Number.isFinite(nowMs) || (onGround !== false && onGround !== 0)
        || (warning !== true && warning !== 1) || (gap != null && (gap < 0 || gap > 1000))) {
      this.sinceMs = null;
      return false;
    }
    if (this.sinceMs == null) this.sinceMs = nowMs;
    return nowMs - this.sinceMs >= STALL_WARNING_ENTRY_MS;
  }
}

/** Only discard historical pulses whose complete start/end pair is recorded.
 * An unclosed or malformed warning cannot be assumed to have been brief. */
export function transientStallRows<T extends Record<string, any>>(rows: T[]): Set<T> {
  const transient = new Set<T>();
  let start: T | null = null;
  const timestamp = (row: T): number => {
    if (row.ts != null && String(row.ts).trim() !== '' && Number.isFinite(Number(row.ts))) return Number(row.ts);
    return typeof row.timestamp_utc === 'string' ? Date.parse(row.timestamp_utc) : NaN;
  };
  for (const row of rows) {
    if (row.record_type === 'STALL') start = row;
    else if (row.record_type === 'STALL_END' && start) {
      const duration = timestamp(row) - timestamp(start);
      if (Number.isFinite(duration) && duration >= 0 && duration < STALL_WARNING_ENTRY_MS) {
        transient.add(start);
        transient.add(row);
      }
      start = null;
    }
  }
  return transient;
}
