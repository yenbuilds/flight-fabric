import { createTaxiController, STOP_INPUT, type TaxiInput, type TaxiSample, type TaxiStatus, type TaxiTrace } from './controller.js';
import { listParkingOptions, localPosition, normalizeRunway, planTaxiRoute, planTaxiToStand, type TaxiGraph, type TaxiRoute } from './route.js';
import { buildTaxiScene, type TaxiRunwayRecord, type TaxiScene } from './scene.js';
import { DEFAULT_TAXI_HANDLING, taxiHandlingKey, validateTaxiHandling, type TaxiHandling } from './handling.js';

type Position = { lat: number; lon: number };
export type TaxiAirport = { origin: Position; graph: TaxiGraph; threshold: Position | null; reciprocal: string | null; runways?: TaxiRunwayRecord[] };
export type TaxiObservation = TaxiSample & Position & { profileKey: string; profileRevision: number; generation: unknown;
  /** Extra simulator readbacks for the session log only; the controller never reads them. */
  sim?: Record<string, number | boolean | null> };
/** One line of the session log, in the shape of the other JSONL sidecars: a prefixed `type` and epoch `timeMs` from `deps.now`. */
export type TaxiRecord = { timeMs: number } & (
  | { type: 'autotaxi_session_start'; icao: string; runway: string | null; parking: string | null; profileKey: string; profileRevision: number;
      steeringSign: 1 | -1 | null; handling: TaxiHandling; start: Position & { headingDeg: number; speedKts: number }; route: TaxiRoute; airport: { origin: Position; threshold: Position | null; reciprocal: string | null }; scene: TaxiScene }
  | { type: 'autotaxi_tick'; sample: Position & TaxiSample & { sim?: Record<string, number | boolean | null> }; trace: TaxiTrace | null; input: TaxiInput; status: TaxiStatus;
      writeMs: number; writeError: string | null; heartbeatAgeMs: number }
  | { type: 'autotaxi_transition'; from: TaxiStatus | null; to: TaxiStatus; reason: string }
  | { type: 'autotaxi_handover'; ok: boolean; error: string | null }
  | { type: 'autotaxi_session_end'; status: TaxiStatus | null; reason: string | null; error: string | null; ticks: number; steeringSign: 1 | -1 | null });
export type TaxiSessionDependencies = {
  now: () => number;
  capture: () => TaxiObservation;
  /** Resolve the actual loaded aircraft. Explicit null blocks preview/start;
   * omitted only preserves legacy standalone callers and test fixtures. */
  handling?: () => TaxiHandling | null;
  /** Airport geometry; runway is null for a stand destination. */
  airport: (icao: string, runway: string | null) => Promise<TaxiAirport>;
  write: (input: TaxiInput, sameAircraft: () => boolean) => Promise<void>;
  /** One bounded transport recovery after a failed stop. Never resumes motion. */
  recover?: (error: unknown, sameAircraft: () => boolean) => Promise<boolean>;
  /** Set the parking brake while the toe brakes are held. Without it a stopped session keeps holding the toe brakes. */
  park?: (sameAircraft: () => boolean) => Promise<void>;
  /** Current parking-brake lever state, or null when unknown. */
  parked?: () => boolean | null;
  /** Session log sink. Rows are best effort: a throwing sink is ignored and never affects control. */
  record?: (row: TaxiRecord) => void;
};
const RELEASE_INPUT: TaxiInput = Object.freeze({ throttle: 0, brake: 0, steering: 0 });
// How long after the pedals go to zero the lever is watched before writes end.
const HANDOVER_WATCH_MS = 1500;

/** One owner, one serial write loop, no auto-resume after any interruption. */
export function createTaxiSession(deps: TaxiSessionDependencies) {
  let controller: ReturnType<typeof createTaxiController> | null = null;
  let route: TaxiRoute | null = null;
  let airport: TaxiAirport | null = null;
  let owner: unknown = null;
  let ownerConnected: () => boolean = () => false;
  let baseline: TaxiObservation | null = null;
  let busy = false;
  let planning = false;
  let requestGeneration = 0;
  let heartbeat = 0;
  let error: string | null = null;
  let commanded: TaxiInput | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let operation: Promise<void> = Promise.resolve();
  // Once the aircraft has stopped, the parking brake is set and the axes are
  // handed back, so the pilot can release the brake and taxi on by hand.
  let handedOver = false;
  let handoverFailed = false;
  let handoverAt: number | null = null;
  // The steering direction learned by one session's probe carries into the
  // next; a contradiction forgets it so the next session probes again.
  let steeringSign: 1 | -1 | null = null;
  type AircraftIdentity = Pick<TaxiObservation, 'profileKey' | 'profileRevision' | 'generation'> & { handlingKey: string };
  let steeringIdentity: AircraftIdentity | null = null;
  let baselineHandlingKey: string | null = null;
  let sceneIdentity: AircraftIdentity | null = null;
  // Diagram context outlives a preview so the panel can keep showing the aircraft on it.
  let scene: TaxiScene | null = null;
  // Session log bookkeeping: one session_start per controller, transitions on status change, one session_end.
  let recorded: { status: TaxiStatus | null; ticks: number } | null = null;
  type Untimed<R> = R extends TaxiRecord ? Omit<R, 'timeMs'> : never;
  function emit(row: Untimed<TaxiRecord>) {
    if (!deps.record || !recorded) return;
    try { deps.record({ timeMs: deps.now(), ...row } as TaxiRecord); } catch {}
  }
  function noteTransition() {
    const current = controller?.getState();
    if (!current || !recorded || current.status === recorded.status) return;
    emit({ type: 'autotaxi_transition', from: recorded.status, to: current.status, reason: current.reason });
    recorded.status = current.status;
  }
  function endRecord() {
    if (!recorded) return;
    noteTransition();
    const current = controller?.getState();
    emit({ type: 'autotaxi_session_end', status: current?.status ?? null, reason: current?.reason ?? null, error, ticks: recorded.ticks, steeringSign: current?.steeringSign ?? steeringSign });
    recorded = null;
  }
  function resolveHandling(): { value: TaxiHandling | null; reason: string | null } {
    try {
      const value = deps.handling ? deps.handling() : DEFAULT_TAXI_HANDLING;
      return value ? { value: validateTaxiHandling(value), reason: null }
        : { value: null, reason: 'Autotaxi is not configured for this aircraft.' };
    } catch (err) { return { value: null, reason: err instanceof Error ? err.message : String(err) }; }
  }
  const identity = (sample: TaxiObservation, handling: TaxiHandling): AircraftIdentity => ({
    profileKey: sample.profileKey, profileRevision: sample.profileRevision, generation: sample.generation, handlingKey: taxiHandlingKey(handling),
  });
  const matches = (saved: AircraftIdentity | null, sample: TaxiObservation, handling: TaxiHandling | null): boolean => !!saved && !!handling
    && saved.profileKey === sample.profileKey && saved.profileRevision === sample.profileRevision
    && saved.generation === sample.generation && saved.handlingKey === taxiHandlingKey(handling);
  function forgetChangedAircraft(sample: TaxiObservation, handling: TaxiHandling | null) {
    if (!matches(steeringIdentity, sample, handling)) { steeringSign = null; steeringIdentity = null; }
    if (sceneIdentity && !matches(sceneIdentity, sample, handling)) { scene = null; sceneIdentity = null; }
  }
  const sameAircraft = () => {
    const sample = deps.capture();
    const { value: handling } = resolveHandling();
    forgetChangedAircraft(sample, handling);
    return !!baseline && !!handling && taxiHandlingKey(handling) === baselineHandlingKey
      && sample.profileKey === baseline.profileKey && sample.profileRevision === baseline.profileRevision && sample.generation === baseline.generation;
  };
  const controlling = () => !!controller && !handedOver;
  function aircraft(observed: TaxiObservation) {
    if (!scene || ![observed.lat, observed.lon, observed.headingDeg].every(Number.isFinite)) return null;
    return { ...localPosition(observed.lat, observed.lon, scene.origin), headingDeg: observed.headingDeg,
      speedKts: Number.isFinite(observed.speedKts) ? observed.speedKts : 0 };
  }
  function clearSession() {
    clearTimer();
    endRecord();
    controller = null; owner = null; baseline = null; baselineHandlingKey = null; route = null; airport = null; error = null; commanded = null; scene = null; sceneIdentity = null;
    ownerConnected = () => false;
    handedOver = false; handoverFailed = false; handoverAt = null;
  }
  function state(includeScene = false) {
    const observed = deps.capture();
    const resolved = resolveHandling();
    const handling = resolved.value;
    forgetChangedAircraft(observed, handling);
    const current = controller?.getState();
    const reason = !current ? 'Ready to plan a taxi route.'
      : current.status === 'taxiing' ? current.reason
      : handedOver ? `${current.reason} Parking brake set; the controls are yours.`
      : current.settled && !deps.park ? `${current.reason} Brakes held; release controls to take over.`
      : current.reason;
    const status: TaxiStatus | 'planning' | 'idle' = current?.status ?? (planning ? 'planning' : 'idle');
    return { type: 'autotaxiState', status, reason,
      ...(current ? { remainingM: current.remainingM, runway: current.runway } : {}),
      error, active: !!controller, handedOver, steeringReversed: (matches(steeringIdentity, observed, handling) ? current?.steeringSign ?? steeringSign : null) === -1, probing: current?.probing ?? false,
      runwayTravelM: route?.runwayTravelM ?? 0, joinM: route?.joinM ?? 0,
      observedSpeedKts: Number.isFinite(observed.speedKts) ? observed.speedKts : null, commanded,
      canStart: !!handling && observed.ready && observed.speedKts <= handling.maxStartKts && !controlling() && !planning,
      unavailableReason: observed.reason || resolved.reason || (handling && observed.speedKts > handling.maxStartKts ? `Slow below ${handling.maxStartKts} kt before starting.` : null),
      handling: handling ? { id: handling.id, label: handling.label } : null,
      currentProfileKey: observed.profileKey, currentProfileRevision: observed.profileRevision,
      profileKey: baseline?.profileKey ?? null, profileRevision: baseline?.profileRevision ?? null,
      route: controller && route && scene ? { points: route.points, holdShort: route.holdShort, lengthM: route.lengthM, runway: route.runway, kind: route.kind, label: route.label, ...(route.stand ? { stand: route.stand } : {}) } : null,
      aircraft: aircraft(observed), sceneKey: scene?.key ?? null, ...(includeScene && scene ? { scene } : {}) };
  }
  const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  async function handover() {
    // Toe brakes are already at 100 % from the stop input, which the PMDG
    // realistic parking-brake mode needs before the lever accepts SET. Only the
    // aircraft identity gates these writes: a stop or release arriving during
    // the lever action must not turn a set lever into a reported failure.
    try { await deps.park!(sameAircraft); }
    catch (err) { handoverFailed = true; error = `Could not set the parking brake: ${describe(err)} Brakes are held; release controls to take over.`; emit({ type: 'autotaxi_handover', ok: false, error }); return; }
    try { await deps.write(RELEASE_INPUT, sameAircraft); }
    catch (err) { handoverFailed = true; error = `Parking brake set, but the pedals could not be released: ${describe(err)} Brakes are held; release controls to take over.`; emit({ type: 'autotaxi_handover', ok: false, error }); return; }
    commanded = { ...RELEASE_INPUT };
    handedOver = true; handoverAt = deps.now();
    emit({ type: 'autotaxi_handover', ok: true, error: null });
    // The timer keeps running for HANDOVER_WATCH_MS so watchHandover can see
    // whether the lever survived the pedals going to zero.
  }
  async function watchHandover() {
    if (handoverAt == null) return;
    if (!sameAircraft()) {
      handedOver = false; handoverFailed = true; handoverAt = null;
      error = 'Aircraft, handling configuration or connection changed during handover. Writes stopped; release the session and take control.';
      controller?.fault(error); clearTimer(); noteTransition();
      emit({ type: 'autotaxi_handover', ok: false, error });
      return;
    }
    let parked: boolean | null = true;
    try { if (deps.parked) parked = deps.parked(); } catch { parked = null; }
    if (parked !== true) {
      // PMDG's realistic mode can drop the lever when pedal pressure goes.
      // Missing or stale readback cannot prove the lever stayed set either.
      handedOver = false; handoverFailed = true; handoverAt = null;
      error = parked === false
        ? 'The parking brake released when the pedals were let go. Brakes are held again; set the parking brake yourself, then release controls.'
        : 'Parking-brake readback is unavailable after pedal release. Brakes are held again; check the parking brake, then release controls.';
      try { await deps.write(STOP_INPUT, sameAircraft); commanded = { ...STOP_INPUT }; }
      catch (err) { error = `${error} (${describe(err)})`; }
      emit({ type: 'autotaxi_handover', ok: false, error });
      return;
    }
    if (deps.now() - handoverAt >= HANDOVER_WATCH_MS) { handoverAt = null; clearTimer(); }
  }
  async function tick() {
    if (busy || !controller || !airport) return;
    if (handedOver) {
      busy = true;
      operation = watchHandover().finally(() => { busy = false; });
      await operation;
      return;
    }
    busy = true;
    const generation = requestGeneration;
    operation = (async () => {
      try {
        if (!sameAircraft()) { controller!.fault('Aircraft, handling configuration or connection changed. Writes stopped; release the session and take control.'); clearTimer(); noteTransition(); return; }
        const raw = deps.capture();
        const sample = { ...raw, ...localPosition(raw.lat, raw.lon, airport!.origin) };
        const heartbeatAgeMs = deps.now() - heartbeat;
        if ((!ownerConnected() || heartbeatAgeMs > 3000) && controller!.getState().status === 'taxiing') controller!.stop('Control connection lost. Stopping; take control.');
        const input = controller!.update(sample, deps.now());
        // Read before the write: a contradiction fault must forget the sign
        // even if the stop write that follows it fails.
        const current = controller!.getState();
        steeringSign = current.steeringSign;
        noteTransition();
        const writeStarted = deps.now();
        let writeError: string | null = null;
        try {
          await deps.write(input, () => {
            if (!sameAircraft() || generation !== requestGeneration) return false;
            if (input.throttle === 0 && input.brake === 1) return true;
            if (!ownerConnected() || deps.now() - heartbeat > 3000) throw new Error('Control connection lost or heartbeat expired. Take control.');
            const currentSample = deps.capture();
            if (!currentSample.ready) throw new Error(currentSample.reason || 'Ground-control telemetry is no longer ready. Take control.');
            return true;
          });
        } catch (err) { writeError = describe(err); throw err; }
        finally {
          if (recorded) recorded.ticks++;
          const { timeMs, lat, lon, x, z, headingDeg, speedKts, ready, reason, sim } = sample;
          emit({ type: 'autotaxi_tick', sample: { timeMs, lat, lon, x, z, headingDeg, speedKts, ready, ...(reason ? { reason } : {}), ...(sim ? { sim } : {}) },
            trace: controller!.trace(), input, status: current.status, writeMs: deps.now() - writeStarted, writeError, heartbeatAgeMs });
        }
        commanded = { ...input };
        if (current.status !== 'taxiing' && current.settled && deps.park && !handoverFailed && generation === requestGeneration) await handover();
      } catch (err) {
        // A stop or release that superseded this tick cancelled its write on
        // purpose and sends its own stop input; that is not a control failure.
        if (generation !== requestGeneration && controller?.getState().status !== 'taxiing') return;
        error = describe(err);
        controller?.fault('Control write failed. Take control.');
        noteTransition();
        clearTimer();
        // Stop immediately if the transport still works. Recover only a known
        // disconnect, once, and only to send idle/brakes. Stop/release can cancel
        // the wait, and an aircraft or connection change invalidates it.
        const valid = () => sameAircraft() && generation === requestGeneration;
        if (valid()) {
          try { await deps.write(STOP_INPUT, valid); commanded = { ...STOP_INPUT }; }
          catch (stopError) {
            error += ` Stop command failed: ${describe(stopError)}`;
            if (deps.recover) {
              const failure = error;
              error = `${failure} Checking control connection; take control in the cockpit.`;
              try {
                if (await deps.recover(stopError, valid) && valid()) {
                  await deps.write(STOP_INPUT, valid);
                  commanded = { ...STOP_INPUT };
                  error = `${failure} Control connection recovered; idle and brake commands sent. Release this session before starting again.`;
                } else error = failure;
              } catch (recoveryError) { error = `${failure} Recovery failed: ${describe(recoveryError)}`; }
            }
          }
        }
      } finally { busy = false; }
    })();
    await operation;
  }
  function clearTimer() { if (timer) clearInterval(timer); timer = null; }
  async function request(message: Record<string, any>, client: unknown, connected: () => boolean = () => true) {
    if (message.operation === 'status') {
      if (client === owner && ownerConnected() && deps.now() - heartbeat <= 3000) heartbeat = deps.now();
      return state(message.scene === true);
    }
    if (message.operation === 'stop') {
      requestGeneration++;
      planning = false;
      if (controlling()) { controller!.stop(); noteTransition(); }
      await operation;
      await tick();
      return state();
    }
    if (message.operation === 'release') {
      requestGeneration++; clearTimer(); planning = false;
      controller?.stop('Releasing controls'); noteTransition();
      await operation;
      // Only release axes on the same aircraft/connection that we took over.
      // After a handover the axes are already released and the parking brake stays set.
      try { if (controlling() && sameAircraft()) await deps.write(RELEASE_INPUT, sameAircraft); }
      catch (err) { error = String(err); controller?.fault('Could not release controls. Take control in the cockpit.'); return state(); }
      clearSession();
      return state();
    }
    const icao = typeof message.icao === 'string' ? message.icao.trim().toUpperCase() : '';
    if (!/^[A-Z0-9]{3,8}$/.test(icao)) throw new Error('Enter an airport ICAO code.');
    if (message.operation === 'parkings') {
      // Stand names and types for the picker. Read-only; no session state changes.
      const data = await deps.airport(icao, null);
      const standOptions = listParkingOptions(data.graph);
      return { ...state(), stands: standOptions.map(option => option.label), standOptions };
    }
    if (message.operation !== 'start' && message.operation !== 'preview') throw new Error('Unknown autotaxi operation.');
    if (controlling() || planning) throw new Error('Release the current autotaxi session first.');
    if (!connected()) throw new Error('Control connection lost. Taxi request cancelled.');
    const parking = typeof message.parking === 'string' ? message.parking.trim() : '';
    const runway = parking ? null : normalizeRunway(message.runway);
    const initial = deps.capture();
    const resolved = resolveHandling();
    const handling = resolved.value;
    if (!handling) throw new Error(initial.reason || resolved.reason!);
    forgetChangedAircraft(initial, handling);
    if (message.profileKey !== initial.profileKey || message.profileRevision !== initial.profileRevision) throw new Error('Aircraft changed. Wait for current aircraft data.');
    if (!initial.ready || initial.speedKts > handling.maxStartKts) throw new Error(initial.reason || `Slow below ${handling.maxStartKts} kt before starting autotaxi.`);
    // A handed-over session has nothing left to release; a new plan replaces it.
    if (controller) clearSession();
    const generation = ++requestGeneration;
    planning = true; error = null;
    // Planning consumes the same owner lease as motion. Status polls can keep
    // a slow geometry load alive, but finishing it cannot renew a dead owner.
    owner = client; ownerConnected = connected; heartbeat = deps.now();
    try {
      const data = await deps.airport(icao, runway);
      if (generation !== requestGeneration) throw new Error('Taxi request cancelled.');
      if (!ownerConnected() || deps.now() - heartbeat > 3000) throw new Error('Control connection lost or heartbeat expired. Taxi request cancelled.');
      const current = deps.capture();
      if (!current.ready || current.speedKts > handling.maxStartKts || !matches(identity(initial, handling), current, resolveHandling().value)) {
        steeringSign = null; steeringIdentity = null;
        throw new Error('Aircraft or handling configuration changed while loading taxiways.');
      }
      const position = localPosition(current.lat, current.lon, data.origin);
      const planned = runway
        ? planTaxiRoute(data.graph, position, current.headingDeg, runway, data.reciprocal || '',
          data.threshold ? localPosition(data.threshold.lat, data.threshold.lon, data.origin) : { x: NaN, z: NaN }, handling)
        : planTaxiToStand(data.graph, position, current.headingDeg, parking, handling);
      scene = buildTaxiScene(data.graph, planned, data.origin, data.runways || []);
      sceneIdentity = identity(current, handling);
      if (message.operation === 'preview') {
        planning = false;
        const join = planned.joinM >= 1 ? ` The first ${Math.round(planned.joinM)} m cross open ground to the centreline.` : '';
        return { ...state(true), preview: planned, reason: `Route available: ${Math.round(planned.lengthM)} m to ${planned.label}.${join} No controls sent.` };
      }
      airport = data; route = planned; baseline = current; baselineHandlingKey = taxiHandlingKey(handling);
      steeringIdentity = identity(current, handling);
      controller = createTaxiController(planned, { steeringSign, handling });
      recorded = { status: null, ticks: 0 };
      emit({ type: 'autotaxi_session_start', icao, runway, parking: parking || null, profileKey: current.profileKey, profileRevision: current.profileRevision, steeringSign, handling,
        start: { lat: current.lat, lon: current.lon, headingDeg: current.headingDeg, speedKts: current.speedKts }, route: planned,
        airport: { origin: data.origin, threshold: data.threshold, reciprocal: data.reciprocal }, scene });
      timer = setInterval(() => { void tick(); }, 250); timer.unref?.();
      await tick();
      return state(true);
    } finally {
      if (generation === requestGeneration) {
        planning = false;
        if (!controller) { owner = null; ownerConnected = () => false; }
      }
    }
  }
  return { request, state, tick, isActive: () => controlling() || planning,
    async dispose() { await request({ operation: 'stop' }, owner); clearTimer(); endRecord(); },
  };
}
