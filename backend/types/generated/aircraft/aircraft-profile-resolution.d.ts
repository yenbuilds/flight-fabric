type AnyRecord = Record<string, any>;
type ResolutionResult = {
    resolved: {
        filePath: string;
        profileKey: string;
    } & AnyRecord;
    finalized: AnyRecord;
};
export declare function resolveLoadedProfile(params: {
    locatorValue: unknown;
    visited?: Set<string>;
    ensureBundledProfilesAvailable: () => void;
    resolveProfilePath: (locatorValue: unknown) => AnyRecord | null;
    readProfileFile: (filePath: string) => AnyRecord | null;
    isProfileDefinition: (profile: unknown) => boolean;
    buildCanonicalProfile: (resolved: AnyRecord, rawProfile: AnyRecord) => AnyRecord;
    resolveInheritance: (profile: AnyRecord, visited: Set<string>) => AnyRecord;
    finalizeLoadedProfile: (profile: AnyRecord) => AnyRecord;
    log: (message: string, meta?: AnyRecord) => void;
}): ResolutionResult | null;
export {};
