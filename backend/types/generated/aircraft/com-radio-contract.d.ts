export declare const COM_RADIO_INPUT: Readonly<{
    readonly type: "number";
    readonly min: 118;
    readonly max: 136.99;
    readonly step: 0.005;
}>;
export declare const COM_RADIO_PROPERTIES: readonly ["installed", "status", "spacingMode", "activeMhz", "standbyMhz"];
export declare function comRadioOperations(index: 1 | 2, operation: string): ({
    type: "event";
    name: string;
    inputValue: {
        source: "input";
        scale: number;
        round: "nearest";
    };
    value?: undefined;
} | {
    type: "event";
    name: string;
    value: number;
    inputValue?: undefined;
})[];
