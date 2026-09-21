import type { TaxiInput } from './controller.js';
import type { TaxiFamily } from './adapters.js';
type Ack = {
    ok?: boolean;
    error?: string;
};
export type TaxiAxisTransport = {
    sendEvent: (name: string, value: number) => Promise<Ack>;
    setNamedVar?: (input: {
        name: string;
        unit: string;
        value: number;
    }) => Promise<Ack>;
};
export type TaxiAxisConfig = Readonly<{
    family: TaxiFamily;
    engineCount: number;
    maxThrottle: number;
}>;
export declare function brakeAxis(fraction: number): number;
/** App-owned bounded recipes. Event/variable names cannot come from a client. */
export declare function writeGroundAxes(input: TaxiInput, transport: TaxiAxisTransport, valid: () => boolean, config: TaxiAxisConfig): Promise<void>;
/** Existing737 fixture API; production uses explicit per-aircraft configuration. */
export declare function writeTaxiAxes(input: TaxiInput, send: TaxiAxisTransport['sendEvent'], valid: () => boolean): Promise<void>;
export {};
