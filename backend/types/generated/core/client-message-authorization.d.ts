type ClientAuthorizationFlags = {
    __ffPrivilegedClient?: boolean;
    __ffAircraftControlClient?: boolean;
};
export declare const TRUSTED_LAN_SAFE_READ_MESSAGE_TYPES: readonly ["requestState", "requestAppSettings", "getRecordingState", "getFlightStatus", "requestAirportLookup", "requestDestinationTarget", "requestOriginTarget"];
export declare const AIRCRAFT_CONTROL_MESSAGE_TYPES: readonly ["executeAircraftControl"];
export declare const PRIVILEGED_CLIENT_MESSAGE_TYPES: readonly ["saveAppSettings", "fuelUnit", "showBranding", "flightPlan", "startRecording", "stopRecording", "endFlightManual", "requestTimeline", "applyFlightAnalysisRescore", "revertFlightAnalysisRescore", "requestTimelineList", "deleteFlightCsv", "setDestinationTarget", "clearDestinationTarget", "setOriginTarget", "clearOriginTarget", "exportProfile", "listProfiles", "requestLogbook", "requestHistoryIndexStatus", "checkHistoryIndex", "rebuildHistoryIndex", "lvarDebugWatch", "testShake"];
export declare function isClientMessageAuthorized(client: ClientAuthorizationFlags | null | undefined, messageType: unknown): boolean;
export {};
