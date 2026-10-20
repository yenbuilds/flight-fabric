type ClientAuthorizationFlags = {
    __ffPrivilegedClient?: boolean;
    __ffAircraftControlClient?: boolean;
    __ffToolbarPresetClient?: boolean;
};
export declare const TRUSTED_LAN_SAFE_READ_MESSAGE_TYPES: readonly ["requestState", "requestCduState", "requestAppSettings", "getRecordingState", "getFlightStatus", "requestAirportLookup", "requestDestinationTarget", "requestOriginTarget"];
export declare const AIRCRAFT_CONTROL_MESSAGE_TYPES: readonly ["pushback", "autotaxi", "sendCduKey", "executeAircraftCommand", "executeAircraftControl"];
export declare const TAXI_GUIDANCE_READ_MESSAGE_TYPES: readonly ["requestTaxiGuidance"];
export declare const PRIVILEGED_CLIENT_MESSAGE_TYPES: readonly ["saveAppSettings", "fuelUnit", "showBranding", "flightPlan", "voiceStatus", "startRecording", "stopRecording", "endFlightManual", "requestTimeline", "applyFlightAnalysisRescore", "revertFlightAnalysisRescore", "requestTimelineList", "deleteFlightCsv", "setDestinationTarget", "clearDestinationTarget", "setOriginTarget", "clearOriginTarget", "exportProfile", "listProfiles", "requestLogbook", "requestHistoryIndexStatus", "checkHistoryIndex", "rebuildHistoryIndex", "lvarDebugWatch", "requestDevicePairingRequests", "approveDevicePairingRequest"];
export declare function isClientMessageAuthorized(client: ClientAuthorizationFlags | null | undefined, messageType: unknown): boolean;
export {};
