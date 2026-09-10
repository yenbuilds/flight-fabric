export declare function captureLightMaskSample({ source, raw, snapshot, sequence, profileMatches, nowMs, fieldKey, notBeforeMs, }: Record<string, any>): Record<string, any>;
export declare function captureGenericLightReadback({ eventName, profileKey, nativeMask, nativeSnapshot, nativeSequence, gaugeSnapshot, nowMs, notBeforeMs, }: Record<string, any>): Record<string, any> | null;
export declare function describeGenericLightReadback(before: Record<string, any> | null, after: Record<string, any> | null, requestedValue: number, dispatchedAtMs: number): Record<string, any>;
