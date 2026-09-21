type GenericRecord = Record<string, any>;
export type ControlEvidenceEntry = GenericRecord;
/** Pick the evidence fields out of a normalized control result and its resolution. */
export declare function buildControlEvidence(result: GenericRecord, resolved: GenericRecord, context?: {
    elapsedMs?: number;
    aircraftTitle?: string | null;
}): ControlEvidenceEntry;
export declare function isControlEvidenceEnabled(env?: NodeJS.ProcessEnv): boolean;
export declare function getControlEvidenceFilePath(env?: NodeJS.ProcessEnv): string;
/** Tests point the log at a temporary directory. */
export declare function setControlEvidenceDirectoryForTests(dir: string | null): void;
/** Queue one entry. Returns immediately; the append happens on its own. */
export declare function recordControlEvidence(entry: ControlEvidenceEntry, env?: NodeJS.ProcessEnv): void;
/** Wait for queued lines to land. Tests only; the app never needs to. */
export declare function flushControlEvidenceForTests(): Promise<void>;
export {};
