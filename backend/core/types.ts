// types.js
// JSDoc type definitions for Flight Fabric.
// These provide documentation and IDE autocomplete without requiring TypeScript.
//
// Usage in other files:
//   /** @type {import('./types').TelemetryFrame} */
//   const frame = provider.nextFrame();

/**
 * @typedef {Object} DisplayUnits
 * @property {number} iasKts - Indicated airspeed in knots
 * @property {number} vsFpm - Vertical speed in feet per minute
 * @property {number} raFt - Radio altitude in feet AGL
 * @property {number} gsKts - Ground speed in knots
 * @property {number} altMslFt - Altitude MSL in feet
 * @property {number} headingDeg - Heading in degrees (0-360)
 * @property {number} pitchDeg - Pitch angle in degrees (+ nose up)
 * @property {number} bankDeg - Bank angle in degrees (+ right wing down)
 */

/**
 * Raw telemetry frame from a provider.
 * @typedef {Object} TelemetryFrame
 * @property {number} ias - Indicated airspeed (raw units vary by source)
 * @property {number} vs - Vertical speed (raw units vary by source)
 * @property {number} ra - Radio altitude (raw units vary by source)
 * @property {number} gs - Ground speed (raw units vary by source)
 * @property {number} alt_msl - Altitude MSL (raw units vary by source)
 * @property {number} heading - Heading in degrees
 * @property {number} pitch - Pitch in radians
 * @property {number} bank - Bank in radians
 * @property {number|FlapState} flaps - Flap position (raw value or object)
 * @property {number|SpoilerState} spoilers - Spoiler position (raw value or object)
 * @property {GearState} gear - Gear positions
 * @property {LightState} lights - Light states
 * @property {boolean} onGround - Weight on wheels
 * @property {number} windSpeed - Wind speed in knots
 * @property {number} windDir - Wind direction in degrees
 * @property {number[]} engineLevels - Engine N1 or throttle percentages
 * @property {DisplayUnits} [display] - Pre-converted display units (if available)
 */

/**
 * @typedef {Object} FlapState
 * @property {number|null} notch - Flap display value, usually an aircraft profile detent; physical degrees on generic fallback
 * @property {string|null} label - Display label for the current flap value (e.g., 'UP', '5', '15', '5 deg')
 * @property {number|null} percent - Flap extension percentage (0-100); null on angle-generic path when SimConnect raw is unavailable
 * @property {number|null} fraction - Flap extension fraction (0-1); null on angle-generic path when SimConnect raw is unavailable
 * @property {boolean} inTransit - Reserved for future transit state; currently false for raw flap telemetry
 * @property {string|null} direction - Always null; reserved for future transit direction
 * @property {number} [currentNotch] - Present on profile, percent, and LVAR paths; absent on angle-generic path
 * @property {number} [targetNotch] - Present on profile, percent, and LVAR paths; absent on angle-generic path
 * @property {'profile'|'angle-generic'|'percent'|'lvar'} source - Data source used to derive this state
 */

/**
 * @typedef {Object} SpoilerState
 * @property {number|null} percent - Spoiler extension percentage (0-100); null when suppressed
 * @property {number|null} fraction - Spoiler extension fraction (0-1); null when suppressed
 * @property {'STOWED'|'ARMED'|'EXTENDED'|null} state - Spoiler state; null when suppressed
 * @property {boolean} [available] - False when the value is suppressed (unreliable SimVar, no authoritative source connected)
 * @property {'lvar'|'sdk'} [_source] - Override source when a higher-trust provider is connected
 */

/**
 * @typedef {Object} GearState
 * @property {number} left - Left gear position normalized 0.0–1.0 (0=fully up, 1=fully down; fractional during transit)
 * @property {number} right - Right gear position normalized 0.0–1.0
 * @property {number} nose - Nose gear position normalized 0.0–1.0
 * @property {boolean} locked - True if all gear fully down and locked
 * @property {boolean} parkingBrake - True if parking brake is set (SimConnect position > 0.5)
 * @property {'DOWN'|'UP'|'TRANSIT'} [gearState] - Derived summary state; present on broadcast payloads
 * @property {boolean} [changed] - True on the tick the gearState transitioned; present on broadcast payloads
 * @property {boolean} [parkingBrakeChanged] - True on the tick the parkingBrake state changed; present on broadcast payloads
 */

/**
 * @typedef {Object} LightState
 * @property {boolean} nav - Navigation lights
 * @property {boolean} beacon - Beacon light
 * @property {boolean} landing - Landing lights
 * @property {boolean} taxi - Taxi lights
 * @property {boolean} strobe - Strobe lights
 * @property {boolean} [logo] - Logo light (if available)
 * @property {boolean} [wing] - Wing inspection lights (if available)
 * @property {boolean|null} [turnoff] - Runway turnoff lights; present on SDK path, null when unavailable
 * @property {boolean|null} [panel] - Panel lights; present on SDK path, null when unavailable
 * @property {boolean|null} [recog] - Recognition lights; present on SDK path, null when unavailable
 * @property {boolean|null} [cabin] - Cabin lights; present on SDK path, null when unavailable
 * @property {boolean} [available] - False when the lights value is suppressed (unreliable SimVar, no authoritative source connected)
 */

/**
 * Stability scoring result returned by runStability().
 * Note: instantaneous and ultimateScore are always null at runtime;
 * the retrospective score is broadcast separately via MSG.ULTIMATE_STABILITY_SCORE
 * at landing time, not carried in this object.
 * @typedef {Object} StabilityResult
 * @property {null} instantaneous - Always null (continuous per-tick scoring is not implemented)
 * @property {null} ultimateScore - Always null; final score is emitted as a separate event
 * @property {boolean|null} [isImc] - IMC/VMC classification from visibility; null when unavailable
 * @property {boolean} [imcDataAvailable] - True when visibility was available for IMC/VMC classification
 * @property {number|null} [visibilityM] - Visibility in meters used for IMC/VMC classification
 */

/**
 * Retrospective approach stability breakdown. Scored values are percentages
 * 0-100; unavailable dynamic metrics are null and do not enter the average.
 * Produced by SimpleStabilityScorer.getScore() and broadcast in MSG.ULTIMATE_STABILITY_SCORE.
 * @typedef {Object} StabilityBreakdown
 * @property {number|null} speed_ok - Percentage of approach samples within the speed band
 * @property {number|null} speed_trend_ok - Percentage of eligible IAS windows with stable trend
 * @property {number|null} vs_ok - Percentage of samples with vs within limits
 * @property {number|null} glidepath_ok - Combined path-rate proxy score
 * @property {number|null} glidepath_below_ok - Directional steep path-rate proxy
 * @property {number|null} glidepath_above_ok - Directional shallow path-rate proxy
 * @property {number|null} pitch_ok - Percentage of samples within pitch limits
 * @property {number|null} bank_ok - Percentage of samples within bank limits
 * @property {number} [lateral_offset_ok] - Touchdown lateral-offset score when trusted runway geometry is available
 * @property {number|null} thrust_ok - Throttle/engine-percent movement score
 * @property {number} thrust_not_idle_ok - Legacy neutral idle-thrust proxy retained for CSV compatibility
 * @property {number|null} thrust_stable_ok - Percentage of eligible throttle/engine-percent sample pairs within rate limit
 * @property {number} config_ok - Configuration stability score (0 or 100)
 * @property {number} flaps_ok - Flaps configuration score (0 or 100)
 * @property {number} spoilers_ok - Neutral compatibility field (always 100)
 * @property {number} gear_ok - Gear down score (0 or 100)
 */

/**
 * Landing event data (partial — the full payload from buildLandingPayload() has 60+ fields).
 * @typedef {Object} LandingEvent
 * @property {number} vs_fpm - Touchdown vertical speed in fpm (negative = descent)
 * @property {'PERFECT'|'GOOD'|'FIRM'|'HARD'|'VERY HARD'} grade - Landing quality grade
 * @property {'lime'|'deepskyblue'|'gold'|'orange'|'red'} _ui_color - Grade colour for UI rendering
 * @property {number|null} gforce - Measured peak normal load factor at touchdown, or null when unavailable
 * @property {number|null} ias_kts - Indicated airspeed at touchdown in knots
 * @property {number|null} gs_kts - Ground speed at touchdown in knots
 * @property {string|null} icao - Destination airport ICAO
 * @property {string|null} runway - Landing runway identifier
 * @property {number|null} lat_deg - Touchdown latitude
 * @property {number|null} lon_deg - Touchdown longitude
 * @property {number|null} xwind_kts - Crosswind component in knots
 * @property {number|null} touchdown_distance_ft - Distance from runway threshold at touchdown
 * @property {number} bounce_count - Number of bounces detected
 * @property {Object|null} rollout_analysis - Separate high-speed ground-roll control assessment
 * @property {number|null} ultimate_stability_score - Retrospective approach stability score (0-100)
 * @property {'stable'|'marginal'|'unstable'|'no_verdict'|null} ultimate_stability_verdict - User-facing four-state approach verdict
 */

/**
 * Aircraft profile from JSON configuration.
 * @typedef {Object} AircraftProfile
 * @property {string} id - Unique profile identifier
 * @property {string} name - Display name
 * @property {string|null} extends - Parent profile ID to inherit from
 * @property {ProfileMatching} matching - Auto-detection rules
 * @property {ProfileFlaps} flaps - Aircraft-specific flap detents used to label discrete simulator handle indexes
 * @property {ProfileSlats} [slats] - Slat configuration (if independent from flaps)
 * @property {ProfileGear} [gear] - Gear speed limits
 * @property {ProfileStability} stability - Stability criteria
 * @property {ProfileAutomation} [automation] - Aircraft automation behavior
 * @property {ProfileThrottle} throttle - Throttle/autothrottle config
 * @property {ProfileEngines} engines - Engine configuration
 * @property {ProfilePerformance} [performance] - Weight-based performance data
 * @property {ProfileDataSource} dataSource - Data source preferences
 */

/**
 * @typedef {Object} ProfileMatching
 * @property {number} priority - Higher wins when multiple profiles match
 * @property {string[]} aliases - Short names for manual selection
 * @property {string[]} [titleContains] - Match if aircraft title contains any
 * @property {string} [titleRegex] - Regex pattern for aircraft title
 * @property {ProfileXPlaneMatching} [xplane] - X-Plane identity matching rules
 */

/**
 * @typedef {Object} ProfileXPlaneMatching
 * @property {string[]} [acfPaths] - Exact X-Plane .acf paths
 * @property {string[]} [acfFileNames] - Exact X-Plane aircraft filenames
 * @property {string[]} [aliases] - Normalized X-Plane identity aliases
 */

/**
 * @typedef {Object} ProfileFlaps
 * @property {FlapNotch[]} notches - Ordered flap positions used to map a simulator handle index to a cockpit detent
 * @property {number[]} [takeoffNotches] - Legacy takeoff flap values
 * @property {number[]} landingNotches - Legacy landing flap values
 * @property {number} [goAroundNotch] - Flap setting for go-around
 */

/**
 * @typedef {Object} FlapNotch
 * @property {number} value - Numeric notch value
 * @property {string} label - Display label
 * @property {number} [maxKts] - Maximum IAS for this flap setting (placard speed)
 */

/**
 * @typedef {Object} ProfileSlats
 * @property {boolean} coupled - True if slats move with flaps
 * @property {Array<{value: number, label: string, fraction: number}>} [notches] - Independent slat positions
 */

/**
 * @typedef {Object} ProfileGear
 * @property {number} [maxExtendKts] - VLO - max speed to extend gear
 * @property {number} [maxRetractKts] - Max speed to retract gear
 * @property {number} [maxExtendedKts] - VLE - max speed with gear down
 */

/**
 * @typedef {Object} ProfileStability
 * @property {{minKts: number, maxKts: number, source: string}} vref - Vref configuration
 * @property {{belowVrefKts: number, aboveVrefKts: number}} speedBand - Speed tolerances
 * @property {{minDeg: number, maxDeg: number}} pitch - Pitch limits
 * @property {number} glideslopeDeg - Expected glideslope angle
 */

/**
 * @typedef {Object} ProfileThrottle
 * @property {'servo'|'detent'|'manual'} type - Throttle behavior type
 */

/**
 * @typedef {Object} ProfileEngines
 * @property {number} count - Number of engines (1-4)
 * @property {'jet'|'turboprop'|'piston'|'unknown'} type - Engine type
 * @property {number} [idleN1Pct] - Idle N1 percentage (for "engine running" detection)
 * @property {number} [maxN1Pct] - Max continuous N1 percentage
 * @property {number} [togaN1Pct] - TOGA N1 percentage (time limited)
 */

/**
 * @typedef {Object} ProfilePerformance
 * @property {VrefTableEntry[]} [vrefTable] - Vref vs landing weight lookup table
 * @property {number} [mtowLbs] - Max takeoff weight
 * @property {number} [mlwLbs] - Max landing weight
 * @property {number} [mzfwLbs] - Max zero fuel weight
 */

/**
 * @typedef {Object} VrefTableEntry
 * @property {number} weightLbs - Landing weight in pounds
 * @property {number} vrefKts - Vref at this weight in knots
 */

/**
 * @typedef {Object} ProfileDataSource
 * @property {string} preferred - Preferred data source
 * @property {string} fallback - Fallback data source
 * @property {Object} [xplane] - X-Plane-specific dataref and command overlays
 */

/**
 * @typedef {Object} ProfileAutomation
 * @property {boolean} [autolandCapable] - Can perform CAT III autoland
 * @property {string[]} [autobrakeSettings] - Available autobrake settings
 */

/**
 * @typedef {Object} TickFrameMeta
 * @property {number} sequence - Monotonic core tick counter (0-based)
 * @property {number} timestampMs - Wall-clock epoch timestamp at capture
 * @property {string} timestampIso - ISO 8601 wall-clock timestamp
 * @property {number|null} actualDeltaMs - Measured time since the prior captured tick
 */

/**
 * @typedef {Object} TickFrame
 * @property {TickFrameMeta} meta - Authoritative core-owned frame metadata
 * @property {number} tickNumber - Compatibility alias for meta.sequence
 * @property {number} timestampMs - Compatibility alias for meta.timestampMs
 * @property {string} timestampIso - Compatibility alias for meta.timestampIso
 * @property {number} pollRateMs - Configured target cadence in milliseconds
 * @property {number} deltaSec - Configured target cadence in seconds
 * @property {number} [ias] - Indicated airspeed (raw provider units)
 * @property {number} [vs] - Vertical speed (raw provider units)
 * @property {number} [ra] - Radio altitude (raw provider units)
 * @property {boolean} [wow] - Weight on wheels
 * @property {boolean} [gearDownLocked] - Gear down and locked
 * @property {Object} [throttle] - Throttle state
 * @property {Object} [lights] - Aircraft lights state
 * @property {Object} [flaps] - Flaps state
 * @property {Object} [spoilers] - Spoilers state
 * @property {number} [lat] - Latitude in degrees
 * @property {number} [lon] - Longitude in degrees
 * @property {number} [heading] - Heading in degrees
 * @property {number} [pitch] - Pitch angle in radians
 * @property {number} [bank] - Bank angle in radians
 * @property {DisplayUnits} [display] - Pre-converted display units (IAS in kts, VS in fpm, etc.)
 */

/**
 * Autopilot state broadcast by sendAutopilot() in broadcasters.js.
 * @typedef {Object} AutopilotState
 * @property {boolean|null} master - AP master engaged
 * @property {boolean|null} fdActive - Flight director active
 * @property {boolean|null} athrArmed - Autothrottle armed
 * @property {boolean|null} athrActive - Autothrottle active
 * @property {boolean|null} hdgHold - Heading hold engaged
 * @property {boolean|null} navHold - VOR/NAV hold engaged
 * @property {boolean|null} lnavHold - LNAV engaged (LVAR-sourced; null when no profile)
 * @property {boolean|null} locHold - LOC hold engaged (LVAR-sourced; null when no profile)
 * @property {boolean|null} altHold - Altitude hold engaged
 * @property {boolean|null} vsHold - Vertical speed hold engaged
 * @property {boolean|null} vnavHold - VNAV engaged (LVAR-sourced; null when no profile)
 * @property {boolean|null} lvlChgHold - Level change engaged
 * @property {boolean|null} expedHold - Expedite climb/descent engaged
 * @property {boolean|null} apprHold - Approach mode engaged
 * @property {boolean|null} spdHold - Speed hold engaged
 * @property {number|null} hdgTarget - Selected heading in degrees; null when unavailable
 * @property {number|null} altTarget - Selected altitude in feet; null when unavailable
 * @property {number|null} vsTarget - Selected vertical speed in fpm; null when unavailable
 * @property {number|null} spdTarget - Selected speed in knots; null when unavailable
 * @property {number|null} machTarget - Selected Mach number; null when unavailable
 * @property {boolean} apReliable - False when AP state cannot be trusted (see assessAutopilotReliability)
 * @property {boolean} athrReliable - False when A/T state cannot be trusted
 * @property {string} reliabilityReason - Human-readable reason for the reliability assessment
 */

/**
 * Aircraft attitude broadcast by sendAttitude() in broadcasters.js.
 * @typedef {Object} AttitudeState
 * @property {boolean} valid - True when attitude data is valid and both angles are finite
 * @property {number|null} pitchDeg - Pitch angle in degrees (positive = nose up); null when invalid
 * @property {number|null} bankDeg - Bank angle in degrees (positive = right wing down); null when invalid
 * @property {number} [pitchRad] - Pitch angle in radians; present when valid and finite
 * @property {number} [bankRad] - Bank angle in radians; present when valid and finite
 * @property {string} [pitchSource] - Data source identifier for pitch
 * @property {string} [bankSource] - Data source identifier for bank
 * @property {number} [pitchRaw] - Raw pitch value before processing; present when finite
 * @property {number} [bankRaw] - Raw bank value before processing; present when finite
 * @property {number} [pitchDegPrimary] - Pitch from the primary source before fallback merging
 * @property {number} [bankDegPrimary] - Bank from the primary source before fallback merging
 * @property {string} [pitchModePrimary] - Primary-source attitude interpretation mode for pitch
 * @property {string} [bankModePrimary] - Primary-source attitude interpretation mode for bank
 */

/**
 * Altitude data broadcast as MSG.ALTITUDE by sendBasicStreams() in broadcasters.js.
 * @typedef {Object} AltitudeData
 * @property {number} msl - Legacy pilot-adjustable indicated altitude in feet (rounded)
 * @property {number|null} indicated - Pilot-adjustable indicated altitude in feet
 * @property {number|null} calibrated - Indicated altitude calibrated to current sea-level pressure in feet
 * @property {number|null} plane - MSFS geometric/world-position aircraft altitude in feet
 * @property {number} ra - Radio altitude (height above ground) in feet (rounded)
 * @property {number|null} aircraftAgl - Height above world terrain in feet
 * @property {number|null} aircraftAboveObstacles - Height above terrain including obstacles in feet
 * @property {number|null} planeAgl - MSFS PLANE ALT ABOVE GROUND in feet
 * @property {number|null} planeAglMinusCg - MSFS PLANE ALT ABOVE GROUND MINUS CG in feet
 * @property {number|null} pressureAlt - Pressure altitude in feet; null when unavailable
 * @property {number|null} kohlsmanSettingMb - Effective altimeter setting in hPa; standard pressure while STD is selected
 * @property {number|null} kohlsmanTunedMb - Tuned altimeter setting in hPa, including while STD is selected
 * @property {boolean|null} kohlsmanStd - Whether altimeter index 1 is in STD mode
 */

/**
 * Environment/pressurization data broadcast as MSG.ENVIRONMENT by sendEnvironment() in broadcasters.js.
 * @typedef {Object} EnvironmentData
 * @property {number|null} cabinAltFt - Cabin pressure altitude in feet (rounded); null when unavailable
 * @property {number|null} cabinAltRateFpm - Cabin altitude rate in fpm; null when unavailable
 * @property {number|null} cabinAltTargetFt - Target cabin altitude in feet; null when unavailable
 * @property {number|null} oatC - Outside air temperature in °C; null when unavailable
 */

/**
 * Sim state broadcast as MSG.SIM_STATE from publishSimState() in simbridge-core.js.
 * @typedef {Object} SimState
 * @property {boolean} inMenu - True when the simulator is connected but in a menu or non-flight state
 * @property {boolean} isGlobeView - True when the globe/world map view is active
 * @property {boolean} inFlightContext - True when SimConnect reports an in-flight context
 * @property {boolean} simconnectConnected - True when SimConnect is connected
 * @property {string} lifecycleState - Current flight lifecycle state (LifecycleState enum value)
 */

/**
 * Ultimate stability score broadcast as MSG.ULTIMATE_STABILITY_SCORE on touchdown.
 * Produced by SimpleStabilityScorer.getScore() and broadcast from simbridge-core.js.
 * @typedef {Object} UltimateStabilityScoreData
 * @property {number|null} score - Overall score 0–100; null if scorer had insufficient data
 * @property {'stable'|'marginal'|'unstable'|'no_verdict'} verdict - User-facing approach verdict; gateStable remains the strict audit flag
 * @property {StabilityBreakdown|null} breakdown - Per-criterion score breakdown; null if insufficient data
 * @property {number} samples - Number of approach samples used in scoring
 * @property {boolean|null} gateStable - True if the aircraft was stabilized at the stability gate
 * @property {string[]} gateFailures - List of criteria that failed the stability gate check
 * @property {Object|null} scoringContext - Recorded profile identity, effective limits, and gate reference used for this score
 * @property {unknown[]} approachProfile - Array of approach profile sample points for rendering
 * @property {number|null} runwayReferenceElevFt - Runway/airport elevation reference in feet; null if not resolved
 * @property {string|null} runwayReferenceElevationSource - Geometry provider that supplied the elevation reference
 * @property {'runway'|'airport'|string|null} runwayReferenceElevationKind - Precision class of the elevation reference
 * @property {number|null} thresholdElevFt - Backward-compatible alias for runwayReferenceElevFt
 * @property {number|null} runwayHdg - Runway heading in degrees; null if runway not identified
 * @property {number|null} runwayWidthFt - Runway width in feet; null if not available
 * @property {number|null} runwayLengthFt - Runway length in feet; null if not available
 * @property {Object|null} runwayThreshold - Runway threshold coordinates `{lat, lon}`; null if not identified
 * @property {string|null} runwayId - Runway identifier (e.g., '27L'); null if not identified
 * @property {Object|null} glidepathAngle - Resolved glidepath angle metadata `{angleDeg, source}` for stability scoring
 */

/**
 * Variable Rate Encoding diagnostics broadcast as MSG.VRE_SAMPLING.
 * This lets the UI show which CSV sampling band is active and why the logger is
 * currently writing or waiting for its next interval.
 * @typedef {Object} VreSamplingData
 * @property {boolean} active - True while a real flight recording session is active
 * @property {'BASELINE'|'ELEVATED'|'HIGH_FIDELITY'|'ULTRA_FIDELITY'} band - Active sampling band
 * @property {number} targetRateHz - Evaluator-requested rate before applying the telemetry poll ceiling
 * @property {number} effectiveRateHz - Fresh-sample rate after telemetry polling and the 10 Hz CSV safety ceiling
 * @property {number} rateHz - Backward-compatible alias for effectiveRateHz
 * @property {boolean} shouldSample - True when the current evaluator tick wrote a CSV row
 * @property {string} reason - Current escalation reason string
 * @property {number} escalationReasons - Bitmask of active escalation reasons
 * @property {string|null} phase - Current flight phase, if known
 * @property {number|null} raFt - Current radio altitude in feet
 * @property {number|null} vsFpm - Current vertical speed in feet per minute
 * @property {number} intervalMs - Effective minimum interval between fresh CSV samples
 * @property {number|null} timeSinceLastSampleMs - Elapsed milliseconds since the last CSV sample
 * @property {number|null} nextSampleInMs - Approximate milliseconds until the next CSV sample
 * @property {boolean} ultraFidelityDisabled - True when ultra-fidelity capture is locked out
 * @property {number} ultraFidelityTimeRemaining - Remaining ultra-fidelity time budget in milliseconds
 * @property {number} ultraFidelitySamplesRemaining - Remaining ultra-fidelity sample budget
 * @property {string|null} event - Significant transition event, if any
 * @property {number} timestamp_ms - Unix epoch milliseconds
 * @property {string} timestamp_utc - ISO 8601 UTC timestamp
 */

/**
 * Flight violation event broadcast as MSG.FLIGHT_VIOLATION from flight-violation-runner.js.
 * @typedef {Object} FlightViolationPayload
 * @property {'start'|'end'} event - Whether this is a violation onset or clearance
 * @property {string} rule_id - Identifier of the violated rule (e.g., 'bank_angle')
 * @property {string} label - Human-readable violation label
 * @property {'warning'|'critical'} severity - Severity of the violation
 * @property {boolean} counts_as_upset - Whether this event contributes to the live in-flight upset count
 * @property {Object} metrics - Live telemetry values at the time of the violation
 * @property {number} timestamp_ms - Unix epoch milliseconds
 * @property {string} timestamp_utc - ISO 8601 UTC timestamp
 */

/**
 * Simulator-assistance state captured with a logbook landing.
 * @typedef {Object} LogbookAssistSummary
 * @property {boolean|null} unlimitedFuel - Unlimited fuel flag
 * @property {boolean|null} landingAssist - Landing assistance flag
 * @property {boolean|null} takeoffAssist - Takeoff assistance flag
 * @property {boolean|null} aiControls - AI control system enabled
 * @property {boolean|null} aiAutotrim - AI auto-trim enabled
 * @property {boolean|null} aiDelegated - Controls delegated to AI
 * @property {number|null} aiAntistall - Raw AI anti-stall enum
 * @property {boolean|null} aiAntistallActive - AI anti-stall active/stabilizing flag
 * @property {number|null} realismPercent - SimConnect realism percentage
 * @property {boolean|null} fullRealism - Derived full-realism flag
 * @property {boolean|null} slewActive - Slew mode active
 * @property {boolean|null} anyAssistActive - Derived any-assist-active flag
 */

/**
 * Logbook entry returned by the CSV-backed logbook path.
 * @typedef {Object} LogbookEntry
 * @property {string} id - Stable entry identifier
 * @property {string|null} timestamp - ISO 8601 timestamp
 * @property {number|null} timestampMs - Unix epoch milliseconds
 * @property {string|null} aircraft - Aircraft display name
 * @property {string|null} aircraftProfileId - Aircraft profile identifier when known
 * @property {LogbookAssistSummary|null} assists - Simulator-assistance state captured at touchdown
 * @property {string|null} icao - Destination airport ICAO
 * @property {string|null} runway - Runway identifier
 * @property {string|null} approachType - Approach type when available
 * @property {number|null} vsFpm - Touchdown vertical speed in fpm
 * @property {'PERFECT'|'GOOD'|'FIRM'|'HARD'|'VERY HARD'|null} grade - Landing quality grade
 * @property {string|null} landingKey - Stable LANDING-row sample identity used by reversible rescoring
 * @property {'PERFECT'|'GOOD'|'FIRM'|'HARD'|'VERY HARD'|null} recordedGrade - Original recorded touchdown-rate grade
 * @property {'recorded'|'applied-rescore'} gradeSource - Whether grade is recorded or an explicitly applied rescore
 * @property {Object|null} analysisRescore - Provenance for an explicitly saved whole-flight analysis snapshot
 * @property {Object|null} landingRateContext - Recorded or applied landing-rate policy, profile, and exact thresholds
 * @property {number|null} gforce - Peak G-force at touchdown
 * @property {number|null} iasKts - Indicated airspeed in knots
 * @property {number|null} gsKts - Ground speed in knots
 * @property {number|null} xwindKts - Crosswind component in knots
 * @property {number|null} pitchDeg - Pitch angle in degrees
 * @property {number|null} bankDeg - Bank angle in degrees
 * @property {number|null} windSpeedKts - Wind speed in knots
 * @property {number|null} windDirDeg - Wind direction in degrees
 * @property {number|null} touchdownDistanceFt - Touchdown distance from threshold in feet
 * @property {string|null} touchdownDistanceGrade - Touchdown distance grade label
 * @property {number|null} touchdownDistanceScore - Touchdown distance score
 * @property {number|null} lateralOffsetFt - Lateral runway offset in feet
 * @property {string|null} lateralOffsetGrade - Lateral offset grade label
 * @property {number|null} lateralOffsetScore - Lateral offset score
 * @property {string|null} lateralOffsetSide - Lateral offset side label
 * @property {number|null} stabilityScore - Retrospective approach stability score
 * @property {'stable'|'marginal'|'unstable'|'no_verdict'} stabilityVerdict - User-facing approach verdict
 * @property {string[]} stabilityGateFailures - Stability gate failure reason identifiers
 * @property {StabilityBreakdown|null} [stabilityBreakdown] - Detailed stability breakdown when sourced from landing:final
 * @property {Object|null} stabilityContext - Recorded profile identity, effective limits, and gate reference used for stability scoring
 * @property {boolean|null} gateStable - Whether the aircraft was stabilized at the gate
 * @property {number|null} bounceCount - Number of bounce events
 * @property {string|null} bounceGrade - Bounce severity label
 * @property {boolean} runwayExcursion - True when a runway excursion was detected
 * @property {Object|null} rolloutAnalysis - Separate high-speed ground-roll control assessment
 * @property {boolean} shortLanding - True when touchdown occurred before the runway threshold
 * @property {string|null} runwayCondition - Runway surface condition used for scoring
 * @property {string|null} runwayConditionSource - Source for runway surface condition
 * @property {boolean|null} runwayConditionConfident - Whether runway condition inference was confident
 * @property {string|null} runwayGeometrySource - Geometry provider used for scoring
 * @property {string|null} runwayGeometryProviderChain - Geometry provider lookup trace
 * @property {string|null} runwayGeometryFallbackReason - Reason fallback geometry was used, when applicable
 * @property {Object|null} runwayGeometryDiagnostics - Provider diagnostics captured during geometry lookup
 * @property {number|null} runwayHeadingTrueDeg - Runway true heading used for geometry
 * @property {number|null} runwayLengthFt - Runway length in feet
 * @property {number|null} runwayPhysicalLengthFt - Physical runway length in feet before displaced-threshold adjustment
 * @property {number|null} runwayThresholdLat - Latitude of scoring threshold
 * @property {number|null} runwayThresholdLon - Longitude of scoring threshold
 * @property {number|null} runwayPhysicalThresholdLat - Latitude of physical pavement threshold
 * @property {number|null} runwayPhysicalThresholdLon - Longitude of physical pavement threshold
 * @property {number|null} runwayDisplacedThresholdFt - Displaced threshold length in feet
 * @property {number|null} runwayWidthFt - Runway width in feet
 * @property {string|null} surfaceName - Surface name at touchdown
 */

/**
 * Trend row returned inside LogbookStats.trends.
 * @typedef {Object} LogbookTrendRow
 * @property {string} key - Stable grouping key
 * @property {string} label - Human-readable grouping label
 * @property {number} count - Number of landings in the group
 * @property {number|null} avgVsFpm - Average touchdown vertical speed
 * @property {number|null} avgStabilityScore - Average stability score
 * @property {number|null} stableRatePct - Percentage of landings with stable gate result
 * @property {number|null} marginalRatePct - Percentage of landings with marginal verdict
 * @property {'improving'|'regressing'|'stable'|null} trendVs - Touchdown vertical-speed trend label
 * @property {'improving'|'regressing'|'stable'|null} trendStability - Stability-score trend label
 * @property {number|null} latestTimestampMs - Latest landing timestamp in the group
 */

/**
 * Grouped logbook trend summaries.
 * @typedef {Object} LogbookTrendGroups
 * @property {LogbookTrendRow[]} aircraft - Trends grouped by aircraft
 * @property {LogbookTrendRow[]} airports - Trends grouped by destination airport
 * @property {LogbookTrendRow[]} runways - Trends grouped by airport/runway pair
 */

/**
 * Aggregate stats returned with the logbook message.
 * @typedef {Object} LogbookStats
 * @property {number} total - Total number of logged landings
 * @property {Object<string, number>} grades - Count by landing grade
 * @property {Object<string, number>} outcomeGrades - Count by combined landing outcome grade
 * @property {number} longLandingCount - Count of landings with long touchdown-zone outcome
 * @property {number|null} avgVsFpm - Average touchdown vertical speed
 * @property {number|null} bestVsFpm - Softest touchdown vertical speed
 * @property {number} airports - Number of distinct destination airports
 * @property {number} aircraft - Number of distinct aircraft
 * @property {LogbookTrendGroups} trends - Grouped trend summaries by aircraft, airport, and runway
 */

/**
 * Logbook message sent over WebSocket in response to requestLogbook.
 * @typedef {Object} LogbookMessage
 * @property {LogbookEntry[]} entries - Newest-first logbook entries
 * @property {LogbookStats} stats - Aggregate stats for the returned entries
 * @property {Object} [index] - Derived history-index paging and progress metadata
 */

/**
 * Update notification broadcast by update-checker.js.
 * @typedef {Object} UpdateAvailableMessage
 * @property {string} currentVersion - Currently running backend/app version
 * @property {string} latestVersion - Latest available release version
 * @property {string|null} downloadUrl - Release download URL when provided
 * @property {string|null} message - Optional banner message
 * @property {boolean} urgent - True when the update should use urgent styling
 */

/**
 * Airport search result returned by airport-search.js for divert/nearest lookups.
 * @typedef {Object} AirportSearchResult
 * @property {string} icao - ICAO code or airport ident fallback
 * @property {string} ident - OurAirports airport ident
 * @property {string} name - Airport name
 * @property {string} type - OurAirports airport type
 * @property {number} lat - Latitude in degrees
 * @property {number} lon - Longitude in degrees
 * @property {number} elevation_ft - Airport elevation in feet
 * @property {number} maxRunwayLengthFt - Longest usable runway length in feet
 * @property {number} distanceNm - Great-circle distance in nautical miles
 * @property {number} bearingDeg - Initial bearing from the origin point
 */

/**
 * Airport-search loader stats.
 * @typedef {Object} AirportSearchStats
 * @property {boolean} loaded - Whether the airport data is loaded
 * @property {number} airportCount - Number of airports held in memory
 * @property {number} indexedCount - Number of airports in the spatial index
 * @property {string|null} error - Load error when present
 */

/**
 * Distance/bearing result for a specific destination airport query.
 * @typedef {Object} AirportDistanceResult
 * @property {string} icao - ICAO code or airport ident fallback
 * @property {string} name - Airport name
 * @property {number} lat - Latitude in degrees
 * @property {number} lon - Longitude in degrees
 * @property {number} distanceNm - Great-circle distance in nautical miles
 * @property {number} bearingDeg - Initial bearing from the origin point
 * @property {number} maxRunwayLengthFt - Longest usable runway length in feet
 * @property {number} elevation_ft - Airport elevation in feet
 */

/**
 * Flight-time estimate returned by airport-search.js.
 * @typedef {Object} FlightTimeEstimate
 * @property {number} cruiseSpeedKts - Assumed cruise speed in knots
 * @property {number} flightTimeHours - Estimated enroute time in decimal hours
 * @property {number} hours - Whole-hour component of the estimate
 * @property {number} minutes - Minute component of the estimate
 * @property {string} formatted - Human-readable estimate string
 */

/**
 * Storage-path summary included in app settings/state messages.
 * @typedef {Object} AppStorageSummary
 * @property {string} appDataDir - Root app-data directory
 * @property {string} settingsFile - User settings file path
 * @property {string} bundledAircraftProfilesDir - Built-in aircraft profiles directory
 * @property {string} cabinAnnouncementAudioDir - Cabin announcement audio directory
 * @property {string} themesDir - Themes directory
 * @property {string} logbookFile - Logbook JSON file path
 * @property {string} destinationTargetFile - Destination target file path
 * @property {string} originTargetFile - Origin target file path
 * @property {string|null} flightLogsDir - Flight logs directory
 * @property {boolean} flightLogsExists - Whether the flight logs directory exists
 * @property {number} flightLogsFileCount - Number of flight-log CSV files
 * @property {number} flightLogsTotalBytes - Total bytes used by flight logs
 */

/**
 * @typedef {Object} AppSettingsAircraft
 * @property {string} profile - Aircraft profile override id
 */

/**
 * @typedef {Object} AppSettingsSimulator
 * @property {string} protocol - Selected simulator/SimConnect protocol
 */

/**
 * @typedef {Object} AppSettingsNetwork
 * @property {number} wsPort - WebSocket port
 * @property {number} httpPort - HTTP port
 * @property {boolean} remoteAccess - Whether remote access is enabled
 * @property {boolean} remoteAircraftControl - Whether trusted-LAN browsers may send aircraft controls
 * @property {boolean} updateChecks - Whether packaged builds check for app updates
 * @property {boolean} onlineMapTiles - Whether map views may load online map tiles
 */

/**
 * @typedef {Object} AppSettingsRecording
 * @property {boolean} autoStart - Whether automatic flight-log recording is enabled
 */

/**
 * @typedef {Object} AppSettingsCabinAnnouncements
 * @property {boolean} enabled - Whether cabin announcements are enabled
 * @property {string} style - Cabin announcement style id
 * @property {number} startupGraceMs - Startup/reset grace period before phase announcements can play
 */

/**
 * @typedef {Object} AppSettingsStabilityCriteria
 * @property {number} gateRaFt - Stability gate radio altitude in feet
 * @property {number} speedMinusKts - Allowed speed drift below gate-captured IAS
 * @property {number} speedPlusKts - Allowed speed drift above gate-captured IAS
 * @property {number} vsMinFpm - Minimum vertical speed in fpm
 * @property {number} vsMaxClimbFpm - Maximum climb rate in fpm
 * @property {number} glidepathAngleDeg - Target glidepath angle in degrees
 * @property {number} glidepathVsDeltaMaxFpm - Allowed sink-rate delta from glidepath proxy
 * @property {number} speedTrendMaxKtsPerSec - Allowed absolute IAS trend in knots per second
 * @property {number} thrustIdleMinPct - Minimum thrust percentage considered above idle
 * @property {number} thrustStableMaxPctPerSec - Allowed thrust movement in percentage points per second
 * @property {number} pitchMinDeg - Minimum pitch angle in degrees
 * @property {number} pitchMaxDeg - Maximum pitch angle in degrees
 * @property {number} bankMaxDeg - Maximum absolute bank angle in degrees
 * @property {number} passPct - Percentage required for a sub-metric to pass
 */

/**
 * @typedef {Object} AppSettingsDebrief
 * @property {AppSettingsStabilityCriteria} stabilityCriteria - Personal simulator debrief stability criteria
 */

/**
 * @typedef {Object} AppSettings
 * @property {AppSettingsAircraft} aircraft - Aircraft settings
 * @property {AppSettingsSimulator} simulator - Simulator settings
 * @property {AppSettingsNetwork} network - Network settings
 * @property {AppSettingsRecording} recording - Flight recording settings
 * @property {AppSettingsCabinAnnouncements} cabinAnnouncements - Cabin announcement settings
 * @property {AppSettingsDebrief} debrief - Debrief and landing criteria settings
 */

/**
 * App settings message sent to connected clients.
 * @typedef {Object} AppSettingsMessage
 * @property {AppSettings} settings - Current sanitized app settings
 * @property {string} settingsFile - User settings file path
 * @property {AppStorageSummary} storage - Storage summary and important paths
 * @property {string|null} backendVersion - Current app/backend version string
 */

/**
 * Result message after attempting to save app settings.
 * @typedef {Object} AppSettingsSavedMessage
 * @property {boolean} ok - Whether the save succeeded
 * @property {AppSettings} [settings] - Saved settings when successful
 * @property {string} settingsFile - User settings file path
 * @property {AppStorageSummary} [storage] - Storage summary when successful
 * @property {boolean} [restartRequired] - Whether a restart is required
 * @property {string[]} [restartReasons] - Human-readable restart reasons
 * @property {string} [error] - Save error when unsuccessful
 */

/**
 * Named preview/debug item in the data-sources panel.
 * @typedef {Object} DataSourcePreviewItem
 * @property {string} key - Canonical variable key
 * @property {string|null} expression - Original source expression, if any
 * @property {number|string|null} value - Current preview value
 * @property {boolean} live - Whether a live value is currently present
 * @property {string|null} sourcePath - Source profile path for the subscription
 */

/**
 * Debug-watch summary for a secondary data source.
 * @typedef {Object} DataSourceDebugWatch
 * @property {number} count - Number of configured debug subscriptions
 * @property {DataSourcePreviewItem[]} items - Preview/debug watch items
 */

/**
 * Primary telemetry source descriptor.
 * @typedef {Object} DataSourcePrimary
 * @property {string} type - Source type id
 * @property {string} name - Display name
 * @property {boolean} connected - Whether the source is connected
 * @property {string} [status] - Current source status
 * @property {string|null} [error] - Current source error
 * @property {string|null} [librarySpec] - Loaded DLL/library description
 * @property {string} [description] - Human-readable status description
 * @property {string[]} [categories] - Capability categories
 * @property {string} [mode] - Source mode, when applicable
 * @property {number} [subscriptionCount] - Subscription count, when applicable
 * @property {number} [liveValueCount] - Live value count, when applicable
 */

/**
 * Secondary telemetry/enrichment source descriptor.
 * @typedef {Object} SecondaryDataSource
 * @property {string} type - Source type id
 * @property {string} name - Display name
 * @property {boolean} connected - Whether the source is connected
 * @property {string} status - Current source status
 * @property {string|null} error - Current source error
 * @property {string|null} librarySpec - Loaded DLL/library description
 * @property {string} description - Human-readable status description
 * @property {string[]} categories - Capability categories
 * @property {string} [adapterId] - SDK adapter id for adapter-backed sources
 * @property {DataSourcePreviewItem[]} preview - Preview items shown in the UI
 * @property {string} [mode] - Source mode, when applicable
 * @property {number} [subscriptionCount] - Subscription count, when applicable
 * @property {number} [liveValueCount] - Live value count, when applicable
 * @property {number} [profileSubscriptionCount] - Profile subscription count for LVAR sidecar
 * @property {DataSourceDebugWatch} [debugWatch] - Debug-watch summary for LVAR sidecar
 */

/**
 * Data-sources message sent to the UI.
 * @typedef {Object} DataSourcesMessage
 * @property {DataSourcePrimary} primary - Primary telemetry source
 * @property {SecondaryDataSource[]} secondary - Secondary/enrichment sources
 * @property {(DataSourcePrimary|SecondaryDataSource)[]} sources - Flat ordered source list for UI display
 */

/**
 * Per-signal reliability classification map.
 * @typedef {Object} SignalReliabilityMap
 * @property {string} ias - IAS signal reliability classification
 * @property {string} vs - Vertical speed signal reliability classification
 * @property {string} ra - Radio altitude signal reliability classification
 * @property {string} heading - Heading signal reliability classification
 * @property {string} flapsNotch - Flaps-notch reliability classification
 * @property {string} flapsFraction - Flaps-fraction reliability classification
 * @property {string} spoilersPercent - Spoilers-percent reliability classification
 * @property {string} spoilersArmed - Spoilers-armed reliability classification
 * @property {string} gearPosition - Gear-position reliability classification
 * @property {string} n1 - N1 reliability classification
 * @property {string} autobrake - Autobrake reliability classification
 * @property {string} vref - Vref reliability classification
 * @property {string} stabilityScore - Stability-score reliability classification
 */

/**
 * Signal reliability message sent to the UI.
 * @typedef {Object} SignalReliabilityMessage
 * @property {SignalReliabilityMap} signals - Signal reliability classifications
 * @property {string} profileId - Active aircraft profile id
 * @property {string} source - Provenance for the reliability map
 */

/**
 * Flight recording status message.
 * @typedef {Object} FlightRecordingMessage
 * @property {'recording'|'finalizing'|'stopped'|'failed'|'error'} status - Recording status
 * @property {string} [fileName] - Current or finalized flight-log file name
 * @property {string} [flightId] - Active or completed flight id
 * @property {string} [recordingSessionId] - Immutable recording-bundle session id
 * @property {number} [rowsWritten] - Number of rows written so far
 * @property {number} [rowCount] - Finalized row count
 * @property {string} [endReason] - Flight-end reason when stopped
 * @property {string} [error] - Error message for failed/error states
 */

/**
 * Shared navigation target (origin/destination).
 * @typedef {Object} TargetLocation
 * @property {string} icao - ICAO code
 * @property {string} name - Airport name
 * @property {number} lat - Latitude in degrees
 * @property {number} lon - Longitude in degrees
 * @property {number|null} initialDistanceNm - Initial distance at selection time
 */

/**
 * Destination-target message.
 * @typedef {Object} DestinationTargetMessage
 * @property {TargetLocation|null} target - Selected destination target
 * @property {string} [error] - Error string when the request fails
 */

/**
 * Origin-target message.
 * @typedef {Object} OriginTargetMessage
 * @property {TargetLocation|null} target - Selected origin target
 * @property {string} [error] - Error string when the request fails
 */

/**
 * Airport lookup result message.
 * @typedef {Object} AirportLookupResultMessage
 * @property {string|null} requestId - Caller-supplied request id
 * @property {string} icao - Queried ICAO code
 * @property {boolean} success - Whether lookup succeeded
 * @property {string} [error] - Error string when unsuccessful
 * @property {string} [name] - Airport name when successful
 * @property {number} [lat] - Airport latitude when successful
 * @property {number} [lon] - Airport longitude when successful
 * @property {number} [runwayCount] - Number of runway entries when successful
 */

/**
 * Fuel-unit preference relay message.
 * @typedef {Object} FuelUnitMessage
 * @property {'gal'|'lbs'|'kg'} unit - Selected fuel unit
 */

/**
 * Branding visibility relay message.
 * @typedef {Object} ShowBrandingMessage
 * @property {boolean} show - Whether branding should be shown
 */

/**
 * Fuel quantity message.
 * @typedef {Object} FuelMessage
 * @property {number|null} totalGal - Total fuel volume in gallons when the simulator provides it
 * @property {number|null} totalWeightLbs - Authoritative simulator-reported total fuel mass in pounds, when available
 * @property {number|null} totalPct - Total fuel remaining percentage from SimConnect when available
 */

/**
 * Position message for map display.
 * @typedef {Object} PositionMessage
 * @property {number} lat - Latitude in degrees
 * @property {number} lon - Longitude in degrees
 * @property {number|null} hdg - Heading in degrees
 */

/**
 * Normalized surface state.
 * @typedef {Object} SurfaceState
 * @property {number|null} raw - Raw simulator surface code
 * @property {string|null} name - Surface name
 * @property {string} class - Normalized surface class
 * @property {boolean} runwayLike - Whether the surface is runway-like
 * @property {boolean|null} onRunway - Explicit runway flag when available
 * @property {boolean} onGround - Whether the aircraft is on the ground
 * @property {boolean} valid - Whether the surface classification is usable
 */

/**
 * Surface message.
 * @typedef {Object} SurfaceMessage
 * @property {SurfaceState} value - Normalized surface state
 */

/**
 * Pilot control input message.
 * @typedef {Object} ControlsMessage
 * @property {number|null} yokeX - Normalized lateral input (-1..1)
 * @property {number|null} yokeY - Normalized longitudinal input (-1..1)
 * @property {number|null} rudderPedalPct - Rudder pedal input percentage
 */

/**
 * Engine-display payload.
 * @typedef {Object} EnginesData
 * @property {number} count - Number of active engines
 * @property {string} source - Engine data source id
 * @property {number|null} eng1 - Engine 1 display value
 * @property {number|null} eng2 - Engine 2 display value
 * @property {number|null} eng3 - Engine 3 display value
 * @property {number|null} eng4 - Engine 4 display value
 * @property {string} eng1Text - Engine 1 formatted display text
 * @property {string} eng2Text - Engine 2 formatted display text
 * @property {string} eng3Text - Engine 3 formatted display text
 * @property {string} eng4Text - Engine 4 formatted display text
 */

/**
 * Engines message.
 * @typedef {Object} EnginesMessage
 * @property {EnginesData} data - Engine display payload
 */

// Export empty object - this file is for JSDoc types only
const typeRegistryExports: Record<string, never> = {};
module.exports = typeRegistryExports;

export {};
