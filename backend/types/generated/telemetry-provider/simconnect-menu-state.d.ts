/** Shared lifecycle interpretation for MSFS frames and active control guards. */
export declare function computeMenuState({ systemSim, simRunningRaw, cameraState, crashFlag, crashSequence, userInput, paused }: {
    systemSim: any;
    simRunningRaw: any;
    cameraState: any;
    crashFlag: any;
    crashSequence: any;
    userInput: any;
    paused: any;
}): {
    effectiveInMenu: boolean;
    inFlightContext: boolean;
    simRunning: boolean;
    systemSim: any;
    hasSystemSimState: boolean;
    cameraState: any;
    cameraUserControl: boolean;
    crashFlagActive: boolean;
    crashSequenceValue: any;
    crashActive: boolean;
};
