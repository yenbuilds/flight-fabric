export declare const APPROACH_ASSESSMENT_RULES: Readonly<{
    version: 4;
    stepMs: 200;
    smoothingMs: 1000;
    maximumGapMs: 2000;
    minimumDurationMs: 10000;
    minimumCoverage: 0.8;
    flareHeightFt: 50;
    lowHeightFt: 500;
    lowHeightWeight: 1.5;
    cautionEntryMs: 3000;
    warningEntryMs: 1000;
    recoveryMs: 2000;
    sustainedWarningMs: 20000;
    lowSustainedWarningMs: 10000;
    sustainedSinkExcessFpm: 100;
    sustainedAttitudeExcessDeg: 2;
    sustainedNavigationExcessDots: 0.2;
    sinkWarningMarginFpm: 500;
    sinkRecoveryMarginFpm: 100;
    pathCautionMarginFpm: 200;
    pathWarningMarginFpm: 500;
    pathRecoveryMarginFpm: 50;
    speedWarningMarginKts: 10;
    bankWarningMarginDeg: 10;
    pitchWarningMarginDeg: 10;
    navigationCautionDots: 1;
    navigationWarningDots: 2;
    navigationRecoveryDots: 0.8;
    groupWeights: Readonly<{
        configuration: 20;
        speed: 25;
        vertical: 25;
        attitude: 15;
        thrust: 5;
        alignment: 10;
    }>;
}>;
type Values = Record<string, any>;
export type AssessmentSample = Values & {
    heightFt: number;
    dtMs?: number;
    timestampMs?: number;
};
export declare function assessApproach(input: {
    samples: AssessmentSample[];
    criteria: Values;
    configuration: {
        score: number | null;
        gear: boolean | null;
        flaps: boolean | null;
        failures: string[];
    };
    lateralScore: number | null;
}): Values;
export {};
