type ProfileDocument = Record<string, any>;
export type BundledProfileSource = Readonly<{
    profileKey: string;
    filePath: string;
    namespace: 'bundled';
    simulator: 'msfs' | 'xplane';
    id: string;
    rawProfile: ProfileDocument;
}>;
export declare const BUNDLED_PROFILE_SOURCE_DIR: string;
export declare function listBundledProfileSources(directory?: string): readonly BundledProfileSource[];
export declare function getBundledProfileSource(profileKey: string, directory?: string): BundledProfileSource | null;
export declare function readBundledProfile(profileKey: string, directory?: string): ProfileDocument | null;
export declare function clearBundledProfileSourceCache(): void;
export {};
