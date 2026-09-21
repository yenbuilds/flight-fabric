export declare const VOICE_STATUS_VALUES: ReadonlyArray<string>;
export type VoiceStatusFields = {
    status: string;
    statusText: string;
    transcript: string;
    lastCommand: string;
    shortcut: string;
    joystick: string;
    enabled: boolean;
    available: boolean;
    profileKey: string;
};
/**
 * Bound a relayed voice status. Returns null when the payload has no
 * recognisable status value.
 */
export declare function sanitizeVoiceStatusFields(source: unknown): VoiceStatusFields | null;
