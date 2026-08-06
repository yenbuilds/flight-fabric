export type IasTrendInput = {
    ias: number;
    previousIAS: number;
};
export type IasTrendResult = {
    trend: number;
    nextPreviousIAS: number;
};
export type PitchBankRatesInput = {
    previousPitch: number;
    previousBank: number;
    pitch: number;
    bank: number;
    dtSeconds: number;
};
export type PitchBankRatesResult = {
    pitchRateDeg: number;
    bankRateDeg: number;
    nextPreviousPitch: number;
    nextPreviousBank: number;
};
export declare function computeIasTrend({ ias, previousIAS }: IasTrendInput): IasTrendResult;
export declare function computePitchBankRates({ previousPitch, previousBank, pitch, bank, dtSeconds, }: PitchBankRatesInput): PitchBankRatesResult;
