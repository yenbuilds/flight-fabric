import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  readStorageJson,
  readStorageValue,
  removeStorageValue,
  writeStorageJson,
  writeStorageValue,
} from '../../app/browser-environment.js';

const STORAGE_KEY_PLAN = 'ff_flightPlan';
const STORAGE_KEY_USERNAME = 'ff_simbriefUsername';

function fmtEte(sec) {
  if (!sec || !Number.isFinite(sec)) return '--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

function fmtFuel(value, units = 'lbs') {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return `${Math.round(value).toLocaleString()} ${units}`;
}

function fmtFetchedAt(ts) {
  if (!ts) return '';
  try {
    const date = new Date(ts);
    return `Fetched ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch {
    return '';
  }
}

function displayValue(value) {
  return value !== null && value !== undefined && value !== '' ? String(value) : '--';
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function textValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== ''
    ? String(value).trim()
    : null;
}

function weatherReportValue(value) {
  if (Array.isArray(value)) {
    const reports = value.map(weatherReportValue).filter(Boolean);
    return reports.length ? reports.join('\n') : null;
  }
  if (value && typeof value === 'object') {
    const reports = Object.values(value).map(weatherReportValue).filter(Boolean);
    return reports.length ? reports.join('\n') : null;
  }
  return textValue(value);
}

function normalizeCollection(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).filter((item) => item && typeof item === 'object');
}

function normalizeScalarFields(value) {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value)
    .filter(([, fieldValue]) => ['string', 'number'].includes(typeof fieldValue) && String(fieldValue) !== '')
    .map(([key, fieldValue]) => ({ key, value: String(fieldValue) }));
}

function normalizeNavlog(navlog) {
  const source = navlog?.fix || navlog?.waypoints || navlog;
  return normalizeCollection(source).map((fix) => ({
    ident: textValue(fix.ident || fix.name || fix.icao_code),
    type: textValue(fix.type),
    altitude: finiteNumber(fix.altitude_feet ?? fix.altitude),
    windDirection: finiteNumber(fix.wind_dir ?? fix.wind_direction),
    windSpeed: finiteNumber(fix.wind_spd ?? fix.wind_speed),
    temperature: finiteNumber(fix.oat ?? fix.temperature),
    distance: finiteNumber(fix.distance),
    legTime: finiteNumber(fix.time_leg ?? fix.leg_time),
    fuelRemaining: finiteNumber(fix.fuel_plan_onboard ?? fix.fuel_remaining),
  })).filter((fix) => fix.ident);
}

function normalizeTlrSection(section) {
  if (!section || typeof section !== 'object') return null;
  const conditions = section.conditions && typeof section.conditions === 'object' ? section.conditions : {};
  const runwaySource = section.runway || section.runways;
  const runways = normalizeCollection(runwaySource);
  if (!runways.length && runwaySource && typeof runwaySource === 'object') runways.push(runwaySource);
  return {
    conditions: normalizeScalarFields(conditions),
    runways: runways.map(normalizeScalarFields),
    distanceReports: [
      { condition: 'dry', fields: normalizeScalarFields(section.distance_dry) },
      { condition: 'wet', fields: normalizeScalarFields(section.distance_wet) },
    ].filter((report) => report.fields.length),
  };
}

function normalizeRunwayValue(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toUpperCase().replace(/^RWY\s+/i, '');
  if (!normalized || normalized === '0' || normalized === 'NONE' || normalized === 'N/A' || normalized === '--') {
    return null;
  }
  return /^[A-Z0-9-]{1,12}$/.test(normalized) ? normalized : null;
}

function firstRunwayValue(...values) {
  for (const value of values) {
    const runway = normalizeRunwayValue(value);
    if (runway) return runway;
  }
  return null;
}

function normalizeOfp(ofp, username) {
  if (!ofp) return null;

  const general = ofp.general || {};
  const origin = ofp.origin || {};
  const destination = ofp.destination || {};
  const alternate = ofp.alternate || {};
  const aircraft = ofp.aircraft || {};
  const times = ofp.times || {};
  const fuel = ofp.fuel || {};
  const weights = ofp.weights || {};
  const atc = ofp.atc || {};
  const weather = ofp.weather || {};
  const params = ofp.params || {};

  const eteSeconds = times.est_time_enroute ? parseInt(times.est_time_enroute, 10) : null;
  const fuelLbs = fuel.plan_ramp ? parseFloat(fuel.plan_ramp) : null;
  let cruiseAltFl = null;

  if (general.initial_altitude) {
    const feet = parseInt(general.initial_altitude, 10);
    cruiseAltFl = Number.isFinite(feet) ? `FL${Math.round(feet / 100)}` : String(general.initial_altitude);
  }

  const costIndex = general.costindex ? parseInt(general.costindex, 10) : null;

  return {
    username: String(username || ''),
    fetchedAt: Date.now(),
    origin: (origin.icao_code || '').toUpperCase() || null,
    originName: origin.name || null,
    departureRunway: firstRunwayValue(
      origin.plan_rwy,
      origin.runway,
      origin.rwy,
      general.origin_runway,
      general.departure_runway,
      general.dep_runway,
      general.dep_rwy,
      atc.dep_runway,
      atc.dep_rwy,
    ),
    destination: (destination.icao_code || '').toUpperCase() || null,
    destinationName: destination.name || null,
    arrivalRunway: firstRunwayValue(
      destination.plan_rwy,
      destination.runway,
      destination.rwy,
      general.destination_runway,
      general.arrival_runway,
      general.arr_runway,
      general.arr_rwy,
      atc.arr_runway,
      atc.arr_rwy,
    ),
    alternate: (alternate.icao_code || '').toUpperCase() || null,
    aircraft: (aircraft.icaocode || '').toUpperCase() || null,
    aircraftName: aircraft.name || null,
    callsign: (atc.callsign || '').toUpperCase() || null,
    flightNumber: (general.flight_number || '').toUpperCase() || null,
    route: general.route || null,
    cruiseAltFl,
    cruiseMach: general.cruise_mach ? String(general.cruise_mach) : null,
    eteSeconds: Number.isFinite(eteSeconds) ? eteSeconds : null,
    fuelLbs: Number.isFinite(fuelLbs) ? fuelLbs : null,
    costIndex: Number.isFinite(costIndex) ? costIndex : null,
    weightUnit: String(params.units || '').toLowerCase() === 'kgs' ? 'kg' : 'lbs',
    registration: textValue(aircraft.reg),
    airac: textValue(params.airac),
    generatedAt: finiteNumber(params.time_generated),
    scheduledOut: finiteNumber(times.sched_out),
    scheduledOff: finiteNumber(times.sched_off),
    scheduledOn: finiteNumber(times.sched_on),
    scheduledIn: finiteNumber(times.sched_in),
    estimatedOut: finiteNumber(times.est_out),
    estimatedOff: finiteNumber(times.est_off),
    estimatedOn: finiteNumber(times.est_on),
    estimatedIn: finiteNumber(times.est_in),
    blockSeconds: finiteNumber(times.est_block ?? times.sched_block),
    taxiOutSeconds: finiteNumber(times.taxi_out),
    taxiInSeconds: finiteNumber(times.taxi_in),
    enduranceSeconds: finiteNumber(times.endurance),
    fuel: {
      taxi: finiteNumber(fuel.taxi),
      trip: finiteNumber(fuel.enroute_burn),
      contingency: finiteNumber(fuel.contingency),
      alternate: finiteNumber(fuel.alternate_burn),
      reserve: finiteNumber(fuel.reserve),
      extra: finiteNumber(fuel.extra),
      takeoff: finiteNumber(fuel.plan_takeoff),
      landing: finiteNumber(fuel.plan_landing),
    },
    weights: {
      passengers: finiteNumber(weights.pax_count ?? general.passengers),
      cargo: finiteNumber(weights.cargo),
      payload: finiteNumber(weights.payload),
      zeroFuel: finiteNumber(weights.est_zfw),
      ramp: finiteNumber(weights.est_ramp),
      takeoff: finiteNumber(weights.est_tow),
      landing: finiteNumber(weights.est_ldw),
      maxTakeoff: finiteNumber(weights.max_tow),
      maxLanding: finiteNumber(weights.max_ldw),
    },
    performance: {
      averageWindComponent: finiteNumber(general.avg_wind_comp),
      averageWindDirection: finiteNumber(general.avg_wind_dir),
      averageWindSpeed: finiteNumber(general.avg_wind_spd),
      routeDistance: finiteNumber(general.route_distance),
      airDistance: finiteNumber(general.air_distance),
      greatCircleDistance: finiteNumber(general.gc_distance),
      cruiseTas: finiteNumber(general.cruise_tas),
      stepClimbs: textValue(general.stepclimb_string || general.step_climbs),
    },
    weather: {
      originMetar: textValue(weather.orig_metar),
      originTaf: textValue(weather.orig_taf),
      destinationMetar: textValue(weather.dest_metar),
      destinationTaf: textValue(weather.dest_taf),
      alternateMetar: textValue(weather.altn_metar),
      alternateTaf: textValue(weather.altn_taf),
      etopsMetar: weatherReportValue(weather.etops_metar),
      etopsTaf: weatherReportValue(weather.etops_taf),
    },
    navlog: normalizeNavlog(ofp.navlog),
    icaoFlightPlan: textValue(atc.flightplan_text),
    tlr: {
      takeoff: normalizeTlrSection(ofp.tlr?.takeoff),
      landing: normalizeTlrSection(ofp.tlr?.landing),
    },
  };
}

export const useSimbriefStore = defineStore('simbrief', () => {
  const username = ref('');
  const plan = ref(null);
  const status = ref('');
  const statusIsError = ref(false);
  const error = ref('');
  const fetchInProgress = ref(false);
  const copyLabel = ref('Copy');
  const relayActionBound = ref(false);
  const copyRouteActionBound = ref(false);
  const backendHttpBase = ref('');
  let relayPlanAction = null;
  let copyRouteAction = null;
  let getBackendHttpBaseAction = null;
  let fetchSimbriefAction = null;

  const statusTone = computed(() => (statusIsError.value ? 'danger' : 'muted'));
  const fetchedAtLabel = computed(() => fmtFetchedAt(plan.value?.fetchedAt));
  const alternateLabel = computed(() => displayValue(plan.value?.alternate || 'None'));
  const cruiseLabel = computed(() => displayValue([
    plan.value?.cruiseAltFl,
    plan.value?.cruiseMach ? `M${plan.value.cruiseMach}` : null,
  ].filter(Boolean).join(' / ')));
  const eteLabel = computed(() => fmtEte(plan.value?.eteSeconds));
  const fuelLabel = computed(() => fmtFuel(plan.value?.fuelLbs, plan.value?.weightUnit));

  function setStatus(message, isError = false) {
    status.value = message || '';
    statusIsError.value = isError === true;
  }

  function savePlan(nextPlan) {
    writeStorageJson(STORAGE_KEY_PLAN, nextPlan);
  }

  function loadSavedPlan() {
    return readStorageJson(STORAGE_KEY_PLAN);
  }

  function clearSavedPlan() {
    removeStorageValue(STORAGE_KEY_PLAN);
  }

  function normalizeBackendHttpBase(value) {
    return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  }

  function resolveBackendHttpBase() {
    let nextBase = '';
    if (typeof getBackendHttpBaseAction === 'function') {
      try {
        nextBase = normalizeBackendHttpBase(getBackendHttpBaseAction());
      } catch {
        nextBase = '';
      }
    }
    if (!nextBase) {
      nextBase = normalizeBackendHttpBase(backendHttpBase.value);
    }
    backendHttpBase.value = nextBase;
    return nextBase;
  }

  function relayPlan(nextPlan = plan.value) {
    if (!nextPlan || typeof relayPlanAction !== 'function') return false;
    try {
      return relayPlanAction({ type: 'flightPlan', ...nextPlan }) !== false;
    } catch {
      return false;
    }
  }

  async function fetchOfpJson(sanitizedUsername) {
    const httpBase = resolveBackendHttpBase();
    try {
      const response = await fetch(`${httpBase}/api/simbrief?username=${encodeURIComponent(sanitizedUsername)}`);
      const body = await response.json();
      return {
        ok: response.ok && body?.ok !== false,
        status: response.status,
        body,
      };
    } catch (fetchError) {
      if (typeof fetchSimbriefAction !== 'function') {
        throw new Error(`Could not reach Flight Fabric backend at ${httpBase || 'the configured HTTP server'}: ${fetchError.message}`);
      }
      const result = await fetchSimbriefAction(sanitizedUsername);
      const body = result?.body && typeof result.body === 'object'
        ? result.body
        : { ok: result?.ok === true, error: result?.error || 'Electron SimBrief fetch failed' };
      return {
        ok: result?.ok === true && body?.ok !== false,
        status: Number(result?.status) || 0,
        body,
      };
    }
  }

  function restore() {
    const savedUsername = readStorageValue(STORAGE_KEY_USERNAME, { fallback: '' });
    if (savedUsername) username.value = savedUsername;

    const savedPlan = loadSavedPlan();
    if (savedPlan) {
      plan.value = savedPlan;
      setStatus(fmtFetchedAt(savedPlan.fetchedAt), false);
    }
  }

  async function fetchOfp() {
    if (fetchInProgress.value) return;

    const sanitizedUsername = username.value.trim().replace(/[^A-Za-z0-9_-]/g, '');
    if (!sanitizedUsername) {
      setStatus('Please enter your SimBrief username or pilot ID.', true);
      return;
    }

    writeStorageValue(STORAGE_KEY_USERNAME, sanitizedUsername);

    fetchInProgress.value = true;
    setStatus('Contacting SimBrief...', false);
    error.value = '';

    try {
      const { ok, status: responseStatus, body } = await fetchOfpJson(sanitizedUsername);

      if (!ok || !body.ok) {
        error.value = body.error || `HTTP ${responseStatus}`;
        setStatus('', false);
        return;
      }

      const nextPlan = normalizeOfp(body.ofp, sanitizedUsername);
      if (!nextPlan) {
        error.value = 'OFP data could not be parsed.';
        setStatus('', false);
        return;
      }

      plan.value = nextPlan;
      savePlan(nextPlan);
      relayPlan(nextPlan);
      setStatus('OFP loaded successfully.', false);
    } catch (err) {
      error.value = `Network error: ${err.message}`;
      setStatus('', false);
    } finally {
      fetchInProgress.value = false;
    }
  }

  function clearOfp() {
    clearSavedPlan();
    plan.value = null;
    error.value = '';
    setStatus('Flight plan cleared.', false);
    try {
      return typeof relayPlanAction === 'function'
        ? relayPlanAction({ type: 'flightPlan', cleared: true, username: '' }) !== false
        : false;
    } catch {
      return false;
    }
  }

  async function copyRoute() {
    const route = plan.value?.route || '';
    if (!route || typeof copyRouteAction !== 'function') return false;
    try {
      const copied = await copyRouteAction(route);
      if (copied === false) return false;
      copyLabel.value = 'Copied!';
      globalThis.setTimeout(() => { copyLabel.value = 'Copy'; }, 2000);
      return true;
    } catch {
      return false;
    }
  }

  function bindRuntime({
    sendMessage = null,
    httpBase = '',
    getHttpBase = null,
    copyRouteText = null,
    fetchSimbrief = null,
  } = {}) {
    relayPlanAction = typeof sendMessage === 'function' ? sendMessage : null;
    copyRouteAction = typeof copyRouteText === 'function' ? copyRouteText : null;
    getBackendHttpBaseAction = typeof getHttpBase === 'function' ? getHttpBase : null;
    fetchSimbriefAction = typeof fetchSimbrief === 'function' ? fetchSimbrief : null;
    relayActionBound.value = relayPlanAction != null;
    copyRouteActionBound.value = copyRouteAction != null;
    backendHttpBase.value = normalizeBackendHttpBase(httpBase);
    if (getBackendHttpBaseAction) {
      resolveBackendHttpBase();
    }
  }

  return {
    alternateLabel,
    backendHttpBase,
    bindRuntime,
    clearOfp,
    copyLabel,
    copyRouteActionBound,
    copyRoute,
    cruiseLabel,
    displayValue,
    fmtEte,
    fmtFuel,
    error,
    eteLabel,
    fetchedAtLabel,
    fetchInProgress,
    fetchOfp,
    fuelLabel,
    plan,
    relayActionBound,
    relayPlan,
    restore,
    status,
    statusTone,
    username,
  };
});
