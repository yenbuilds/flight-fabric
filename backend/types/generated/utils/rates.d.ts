export type RatesResult = {
    pitchRateDeg: number;
    bankRateDeg: number;
};
/**
 * Compute pitch and bank rates in deg/sec.
 */
export declare function computeRates(prevPitchRad: number, prevBankRad: number, pitchRad: number, bankRad: number, dtSeconds: number): RatesResult;
