/** One JSONL file per autotaxi session, for offline debugging, controller replay and training data. */
import type { TaxiRecord } from './session.js';
export type TaxiRecorderOptions = {
    /** Directory for the session files; created on the first row of a session. */
    dir: () => string;
    log?: (message: string) => void;
    /** Per-file cap; the session stops logging once it is reached. */
    maxFileBytes?: number;
};
/** Rows arrive from the session in order; a session_start row opens a new file and every row is appended as it comes. */
export declare function createTaxiRecorder(options: TaxiRecorderOptions): {
    record(row: TaxiRecord): void;
    currentFile: () => string;
};
