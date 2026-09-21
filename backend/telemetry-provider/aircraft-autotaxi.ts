/** Shared MSFS ground-control ownership boundary. Candidates still require live acceptance. */
import { createTaxiSession, type TaxiObservation } from '../autotaxi/session.js';
import { taxiAdapterFor, handlingForAircraft } from '../autotaxi/adapters.js';
import { resolveTaxiAircraftConfig, type TaxiAircraftConfigResult } from '../autotaxi/aircraft-config.js';
import { writeGroundAxes } from '../autotaxi/axes.js';
import { recoverTaxiControlBridge } from '../autotaxi/control-recovery.js';
import type { TaxiHandling } from '../autotaxi/handling.js';
import { computeMenuState } from './simconnect-menu-state.js';

type RecordValue = Record<string, any>;
const isOn = (value: unknown) => value === true || value === 1;
const isOff = (value: unknown) => value === false || value === 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const validEngineCount = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 4;
// The SDK enum includes unsupported aircraft kinds. A real change to one of
// those kinds changes ownership; an out-of-range/malformed value is data loss.
const validEngineKind = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 6;
const ownershipError = () => new Error('Autotaxi control ownership changed.');
export type AutotaxiOptions = { resolveModel?: (aircraftCfgPath: string) => TaxiAircraftConfigResult };

export function createAutotaxi(provider: RecordValue, profiles: RecordValue, now: () => number, options: AutotaxiOptions = {}) {
  const resolveModel = options.resolveModel || resolveTaxiAircraftConfig;
  let identity: unknown[] = [];
  let sdkScope: unknown[] | null = null;
  let sdkAfterScopeMs: number | null = null;
  let sdkLastAcceptedAtMs: number | null = null;
  let aircraftScope: unknown[] = [];
  let detectedProfileKey: string | null = null;
  let detectionFailed = false;
  let retained: { model: Extract<TaxiAircraftConfigResult, { ok: true }>; handling: TaxiHandling; engineCount: number; engineType: number } | null = null;
  let writeModel: { scope: unknown[]; model: TaxiAircraftConfigResult } | null = null;
  const notBefore = () => Math.max(provider._autotaxiConnectionStartedAtMs || 0, provider._rustControlReadbackNotBeforeMs || 0);
  const freshAt = (value: unknown) => {
    const time = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(time) && time >= notBefore() && time <= now() && now() - time <= 1000;
  };
  function selection() {
    const profileKey = profiles.getActiveProfileId?.() || '';
    const profileRevision = profiles.getActiveProfileRevision?.() ?? -1;
    const adapter = taxiAdapterFor(profileKey);
    const scope = [provider._rustSimvarBridge, adapter?.sdkChannel ? provider._sdkBridge : null, provider._autotaxiConnectionEpoch,
      provider._rustControlReadbackNotBeforeMs, provider._lastDetectedAircraftTitle, provider._lastDetectedAircraftDisplayName,
      profileKey, profileRevision, adapter?.family === 'fenix-a32x' ? provider._lvarBridge : null];
    if (scope.length !== aircraftScope.length || scope.some((value, i) => value !== aircraftScope[i])) {
      aircraftScope = scope;
      retained = null; detectedProfileKey = null; detectionFailed = false;
      try {
        // Profile selection alone must not turn a known custom aircraft into a
        // standard-control aircraft. Cache this read-only detection per scope.
        const detected = profiles.detectProfile?.(provider._lastDetectedAircraftDisplayName || '', { hint: provider._lastDetectedAircraftTitle || '' });
        detectedProfileKey = detected?._profileKey || detected?.profileKey || null;
        detectionFailed = typeof profiles.detectProfile === 'function' && !detectedProfileKey;
      } catch { detectionFailed = true; }
    }
    const native = provider._rustSimvarBridge?.getSnapshot?.() || {};
    const d = native.values || {};
    let engineCount = d.engineCount, engineType = d.engineType;
    let reason = '', model: TaxiAircraftConfigResult | null = null, handling: TaxiHandling | null = null;
    if (!adapter) reason = 'This aircraft has no reviewed Autotaxi control adapter yet.';
    else if (detectionFailed || detectedProfileKey && taxiAdapterFor(detectedProfileKey)?.family !== adapter.family) {
      reason = 'Select the matching profile for the aircraft loaded in the simulator.';
    }
    else if (!validEngineCount(engineCount) || ![0, 1, 5].includes(engineType)
      || (adapter.family !== 'generic' && (engineCount !== 2 || engineType !== 1))) {
      reason = 'Waiting for a supported aircraft engine configuration.';
    } else {
      try {
        // AircraftLoaded supplies aircraft.cfg; TITLE is only a display string.
        // A batch checks live identity and telemetry between each command, but
        // must not discover/read packages halfway through writing the engines.
        model = writeModel?.scope === aircraftScope ? writeModel.model : resolveModel(provider._lastDetectedAircraftTitle || '');
        if (model.ok === false) reason = model.reason;
        else handling = handlingForAircraft(adapter, model, engineType);
      } catch (error) { reason = error instanceof Error ? error.message : String(error); }
    }
    if (model?.ok && handling && !reason) retained = { model, handling, engineCount, engineType };
    else if (retained && (!validEngineCount(engineCount) || engineCount === retained.engineCount)
      && (!validEngineKind(engineType) || engineType === retained.engineType)) {
      // Missing telemetry or a temporary file-read failure is a readiness
      // failure, not proof of a different aircraft. Retain only this scope's
      // validated controls so the session can still idle engines and brake.
      ({ model, handling, engineCount, engineType } = retained);
    }
    return { adapter, profileKey, profileRevision, native, d, engineCount, engineType, model, handling, reason };
  }
  function ownValue(fieldId: string, selected: ReturnType<typeof selection>) {
    const config = profiles.getAircraftSpecificConfig?.();
    const snapshot = provider._lvarBridge?.getSnapshot?.();
    if (config?.profileKey !== selected.profileKey || config?.profileRevision !== selected.profileRevision
      || config?.integrationId !== selected.adapter?.integrationId || snapshot?.profileId !== selected.profileKey
      || snapshot?.status !== 'running') return undefined;
    const field = [...(config.fields || []), ...(config.confirmationFields || [])].find(item => item.id === fieldId);
    const key = field?.source?.type === 'lvar' ? field.source.key : null;
    return key && freshAt(snapshot.valueUpdatedAt?.[key]) ? snapshot.values?.[key] : undefined;
  }
  function capture(): TaxiObservation {
    const s = selection(), { adapter, native, d, profileKey, profileRevision } = s;
    const currentIdentity = [provider._rustSimvarBridge, adapter?.sdkChannel ? provider._sdkBridge : null, provider._autotaxiConnectionEpoch,
      provider._rustControlReadbackNotBeforeMs, provider._lastDetectedAircraftTitle, provider._lastDetectedAircraftDisplayName,
      profileKey, profileRevision, s.model?.ok ? s.model.identity : null, s.model?.ok ? s.model.fingerprint : null,
      s.engineCount, s.engineType, adapter?.family === 'fenix-a32x' ? provider._lvarBridge : null];
    if (identity.length !== currentIdentity.length || currentIdentity.some((value, i) => value !== identity[i])) identity = currentIdentity;
    const required = ['lat', 'lon', 'heading', 'gs', 'wow', 'paused', 'slewActive', 'engineCount', 'engineType'];
    for (let index = 1; index <= Math.min(4, s.engineCount || 0); index++) {
      required.push(`eng${index}Combustion`);
      if (adapter?.family !== 'fenix-a32x') required.push(`thr${index}`);
    }
    if (adapter?.family !== 'fenix-a32x') required.push('athrArmed', 'athrActive');
    if ((!adapter?.sdkChannel && adapter?.family !== 'fenix-a32x') || adapter?.family === 'pmdg-737') required.push('parkingBrake');
    const fresh = required.every(key => freshAt(native.valueUpdatedAt?.[key]) && d[key] !== null && d[key] !== undefined);
    const sdk = provider._sdkBridge?.getSnapshot?.();
    const scope = [identity, profileKey, profileRevision];
    if (!sdkScope || scope.some((value, i) => value !== sdkScope![i])) {
      sdkAfterScopeMs = sdkScope ? sdkLastAcceptedAtMs : null;
      sdkScope = scope;
    }
    const sdkUpdatedAtMs = Date.parse(sdk?.updatedAt || '');
    // ClientData is onSet + CHANGED. Preserve real timestamps and scope
    // boundaries without imposing an invented heartbeat on an unchanged payload.
    const sdkReady = Boolean(adapter?.sdkChannel && provider._sdkBridge?.isDataConnected?.()
      && sdk?.adapterId === 'clientdata-manifest'
      && (sdk?.target?.connector || sdk?.target?.channel) === adapter.sdkChannel
      && Number.isFinite(sdkUpdatedAtMs) && sdkUpdatedAtMs >= notBefore() && sdkUpdatedAtMs <= now()
      && (sdkLastAcceptedAtMs === null || sdkUpdatedAtMs >= sdkLastAcceptedAtMs)
      && (sdkAfterScopeMs === null || sdkUpdatedAtMs > sdkAfterScopeMs));
    if (sdkReady) sdkLastAcceptedAtMs = sdkUpdatedAtMs;
    const flightState = computeMenuState({ systemSim: provider._systemState?.sim, simRunningRaw: provider._simRunning,
      cameraState: d.cameraState, crashFlag: d.crashFlag, crashSequence: d.crashSequence,
      userInput: isOff(d.userInput) ? false : d.userInput, paused: isOn(d.paused) });
    const athr = sdk?.normalized?.automation?.athr;
    const parking = adapter?.family === 'fenix-a32x' ? ownValue('systems.parkingBrake', s)
      : adapter?.family === 'pmdg-777' ? sdk?.normalized?.brakes?.parking : d.parkingBrake;
    const engines = Array.from({ length: Number.isInteger(s.engineCount) && s.engineCount > 0 && s.engineCount <= 4 ? s.engineCount : 0 }, (_, i) => i + 1);
    const throttles = adapter?.family === 'fenix-a32x'
      ? [ownValue('propulsion.throttleLever1Position', s), ownValue('propulsion.throttleLever2Position', s)]
      : engines.map(i => d[`thr${i}`]);
    const athrOff = adapter?.family === 'fenix-a32x' ? isOff(ownValue('flightGuidance.autothrust', s))
      : isOff(d.athrArmed) && isOff(d.athrActive) && (!adapter?.sdkChannel || isOff(athr?.armed) && isOff(athr?.active)
        && (adapter.family !== 'pmdg-777' || isOff(athr?.armedLeft) && isOff(athr?.armedRight)));
    let reason = s.reason;
    if (!reason && (!provider._connected || provider._stopping || !['running', 'connected'].includes(native.status))) reason = 'Simulator disconnected.';
    else if (!reason && !fresh) reason = 'Waiting for fresh ground-control telemetry.';
    else if (!reason && adapter?.family === 'fenix-a32x'
      && (typeof provider._lvarBridge?.setNamedVar !== 'function' || typeof provider._lvarBridge?.sendEvent !== 'function')) {
      reason = 'Fenix continuous throttle transport is unavailable.';
    }
    else if (!reason && adapter?.sdkChannel && !sdkReady) reason = `Waiting for ${adapter.label} SDK data for the current aircraft connection.`;
    else if (!reason && (!isOn(d.wow) || !isOff(d.paused) || !isOff(d.slewActive) || provider._systemState?.sim !== 1
      || !flightState.inFlightContext)) reason = 'Aircraft must be on the ground with the flight running and simulator controls available.';
    else if (!reason && !isOff(parking)) reason = isOn(parking) ? 'Release the parking brake before starting.' : 'Waiting for aircraft parking-brake readback.';
    else if (!reason && !engines.every(i => isOn(d[`eng${i}Combustion`]))) reason = 'All installed engines must be running.';
    else if (!reason && !athrOff) reason = 'Disarm autothrottle / autothrust and wait for confirmed aircraft readback.';
    else if (!reason && ![d.lat, d.lon, d.heading, d.gs, ...throttles].every(finite)) reason = 'Ground-control telemetry unavailable.';
    else if (!reason && throttles.some(value => adapter?.family === 'fenix-a32x' ? value < 2 || value > 2.25 : value < 0 || value > 25)) {
      reason = 'Throttle or reverser input outside taxi range. Take control.';
    }
    return { x: 0, z: 0, lat: d.lat, lon: d.lon, headingDeg: d.heading, speedKts: d.gs,
      timeMs: Math.min(...['lat', 'lon', 'heading', 'gs'].map(key => Date.parse(native.valueUpdatedAt?.[key] || ''))),
      ready: !reason, reason, profileKey, profileRevision, generation: identity };
  }
  function parked(): boolean | null {
    const s = selection();
    if (!provider._connected || !['running', 'connected'].includes(s.native.status)) return null;
    let value: unknown;
    if (s.adapter?.family === 'fenix-a32x') value = ownValue('systems.parkingBrake', s);
    else if (s.adapter?.family === 'pmdg-777') {
      // Validate the SDK even when readiness is false because the brake is set.
      capture();
      const sdk = provider._sdkBridge?.getSnapshot?.();
      const time = Date.parse(sdk?.updatedAt || '');
      if (!provider._sdkBridge?.isDataConnected?.() || sdk?.adapterId !== 'clientdata-manifest'
        || (sdk?.target?.connector || sdk?.target?.channel) !== s.adapter.sdkChannel
        || !Number.isFinite(time) || time < notBefore() || time > now()
        || sdkLastAcceptedAtMs !== time || (sdkAfterScopeMs !== null && time <= sdkAfterScopeMs)) return null;
      value = sdk?.normalized?.brakes?.parking;
    } else if (freshAt(s.native.valueUpdatedAt?.parkingBrake)) value = s.d.parkingBrake;
    return isOn(value) ? true : isOff(value) ? false : null;
  }
  // Unbounded diagnostic JSONL remains disconnected from live sessions.
  const session = createTaxiSession({ now, capture, handling: () => selection().handling, parked,
    recover: (error, valid) => recoverTaxiControlBridge(error, valid, {
      bridge: () => provider._lvarBridge || null,
      ensure: () => provider._ensureControlWriteBridge?.() || Promise.resolve(null),
      now: Date.now, wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
    }),
    async airport(icao, runway) {
      const geometry = provider._msfsFacilitiesGeometryProvider;
      const outcome = await geometry?.probeAirport?.(icao);
      if (outcome?.ok !== true) throw new Error('Could not load live simulator taxiways. ' + (outcome?.error || 'Facilities unavailable.'));
      const data = geometry.getTaxiAirport(icao, runway);
      if (!data) throw new Error(`Simulator taxiway data for ${icao}${runway ? ` runway ${runway}` : ''} are unavailable.`);
      return data;
    },
    async park(valid) {
      if (!valid()) throw ownershipError();
      const s = selection();
      const bridge = provider._lvarBridge || await provider._ensureControlWriteBridge?.();
      if (!valid()) throw ownershipError();
      if (!bridge || !s.adapter) throw new Error('Parking-brake command unavailable.');
      if (s.adapter.parkingAction) {
        const config = profiles.getAircraftSpecificConfig?.();
        if (config?.integrationId !== s.adapter.integrationId || typeof provider._executeAircraftIntegrationAction !== 'function') {
          throw new Error('Aircraft parking-brake command unavailable.');
        }
        // Trusted recipes keep their readback checks; guard delayed writes too.
        const writes = new Set(['sendEvent', 'sendSdkEvent', 'setNamedVar', 'executeMobiFlightCode']);
        const guardedBridge = new Proxy(bridge, { get(target, key) {
          const member = target[key];
          return typeof member !== 'function' ? member : writes.has(String(key))
            ? (...args: unknown[]) => { if (!valid()) throw ownershipError(); return member.apply(target, args); }
            : member.bind(target);
        } });
        const result = await provider._executeAircraftIntegrationAction(guardedBridge, { type: 'aircraft-integration', name: s.adapter.integrationId },
          bridge.getSnapshot?.()?.source || null, { profileKey: s.profileKey, profileRevision: s.profileRevision,
            resolvedBy: 'autotaxi', request: { control: 'aircraft-specific', actionId: s.adapter.parkingAction } });
        if (!valid()) throw ownershipError();
        if (result?.ok !== true) throw new Error(result?.error || 'The parking brake did not set.');
      } else {
        const before = Date.parse(s.native.valueUpdatedAt?.parkingBrake || '');
        const ack = await bridge.sendEvent?.('PARKING_BRAKE_SET', 1);
        if (ack?.ok !== true) throw new Error(ack?.error || 'The parking brake command was rejected.');
        const deadline = Date.now() + 3000;
        do {
          if (!valid()) throw ownershipError();
          const snapshot = provider._rustSimvarBridge?.getSnapshot?.();
          if (Date.parse(snapshot?.valueUpdatedAt?.parkingBrake || '') > before && parked() === true) return;
          await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        throw new Error('The aircraft did not confirm the parking brake. Brakes remain held.');
      }
    },
    async write(input, valid) {
      const s = selection();
      const bridge = provider._lvarBridge || await provider._ensureControlWriteBridge?.();
      if (!valid()) throw ownershipError();
      if (!bridge?.sendEvent || !s.adapter || !s.handling) throw new Error('Aircraft ground-control bridge unavailable.');
      writeModel = { scope: aircraftScope, model: s.model! };
      try {
        await writeGroundAxes(input, { sendEvent: (name, value) => bridge.sendEvent(name, value),
          ...(typeof bridge.setNamedVar === 'function' ? { setNamedVar: value => bridge.setNamedVar(value) } : {}) }, valid,
        { family: s.adapter.family, engineCount: s.engineCount, maxThrottle: s.handling.maxThrottle });
      } finally { writeModel = null; }
    },
  });
  function support() {
    const s = selection();
    return { family: s.adapter?.family || null, aircraftLabel: s.adapter?.label || 'Aircraft unavailable',
      qualificationStatus: s.adapter ? 'candidate' as const : 'unsupported' as const,
      setupInstructions: s.adapter?.setupInstructions || [], reason: s.reason || null };
  }
  return { ...session,
    state: (includeScene = false) => ({ ...session.state(includeScene), support: support() }),
    request: async (...args: Parameters<typeof session.request>) => ({ ...await session.request(...args), support: support() }),
  };
}
